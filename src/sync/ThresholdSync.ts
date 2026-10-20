import type { ThresholdMap, ThresholdScope } from '../api/schemas';
import type { SqlDb } from '../db/driver';
import { ItemRepo } from '../db/items';

export interface ThresholdApi {
  thresholds(): Promise<ThresholdMap>;
  putThreshold(scope: ThresholdScope, id: string, threshold: number | null): Promise<ThresholdMap>;
}

interface OutboxRow {
  scope: ThresholdScope;
  ref_id: string;
  threshold: number | null;
}

/**
 * Per-item / per-category low-stock thresholds, shared through the proxy (spec §4.5: "stored locally + on proxy,
 * not written to Clover"). Edits apply locally at once and go to an outbox; the outbox is pushed immediately when
 * online and again on every sync. Pending local edits win over the server copy until they are pushed.
 */
export class ThresholdSync {
  static async set(db: SqlDb, api: ThresholdApi, scope: ThresholdScope, id: string, value: number | null, now = Date.now()): Promise<'synced' | 'pending'> {
    if (scope === 'item') await ItemRepo.setThreshold(db, id, value);
    else await ItemRepo.setCategoryThreshold(db, id, value);
    await db.run(
      `INSERT INTO threshold_outbox (scope, ref_id, threshold, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(scope, ref_id) DO UPDATE SET threshold = excluded.threshold, updated_at = excluded.updated_at`,
      [scope, id, value, now],
    );
    return (await ThresholdSync.flush(db, api)) === 0 ? 'synced' : 'pending';
  }

  static async pending(db: SqlDb): Promise<OutboxRow[]> {
    return db.all<OutboxRow>('SELECT scope, ref_id, threshold FROM threshold_outbox ORDER BY updated_at');
  }

  /** Pushes queued edits in order; stops at the first failure (kept for next time). Returns rows left. */
  static async flush(db: SqlDb, api: ThresholdApi): Promise<number> {
    const rows = await ThresholdSync.pending(db);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] as OutboxRow;
      try {
        await api.putThreshold(r.scope, r.ref_id, r.threshold);
      } catch {
        return rows.length - i;
      }
      // Only drop it if it wasn't edited again meanwhile.
      await db.run('DELETE FROM threshold_outbox WHERE scope = ? AND ref_id = ? AND threshold IS ?', [r.scope, r.ref_id, r.threshold]);
    }
    return 0;
  }

  /** Flush, then make local thresholds match the proxy (except edits still pending). */
  static async pull(db: SqlDb, api: ThresholdApi): Promise<{ items: number; categories: number; pending: number }> {
    const pending = await ThresholdSync.flush(db, api);
    const map = await api.thresholds();
    const keep = await ThresholdSync.pending(db);
    const kept = (scope: ThresholdScope) => keep.filter((k) => k.scope === scope).map((k) => k.ref_id);
    await db.transaction(async () => {
      for (const [scope, table, values] of [
        ['item', 'items', map.items],
        ['category', 'categories', map.categories],
      ] as const) {
        const skip = kept(scope);
        await db.run(
          `UPDATE ${table} SET low_stock_threshold = NULL WHERE low_stock_threshold IS NOT NULL
           AND id NOT IN (${skip.map(() => '?').join(',') || "''"})`,
          skip,
        );
        for (const [id, value] of Object.entries(values)) {
          if (!skip.includes(id)) await db.run(`UPDATE ${table} SET low_stock_threshold = ? WHERE id = ?`, [value, id]);
        }
      }
    });
    return { items: Object.keys(map.items).length, categories: Object.keys(map.categories).length, pending };
  }
}
