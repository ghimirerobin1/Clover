import type { SqlDb } from '../../db/driver';
import { IntentQueueRepo, type QueuedIntentRow } from '../../db/intentQueue';
import { StockMath, StockWriter, type StockApi, type StockIntent } from '../stock';
import type { TallyRow } from './Tally';

export type BatchStatus = 'pending' | 'applied' | 'conflict' | 'failed' | 'unconfirmed';

export interface BatchRow {
  key: string;
  itemId: string;
  itemName: string;
  intent: StockIntent;
  /** Live stock read for the confirmation screen (null = could not read; row can't be applied). */
  base: number | null;
  status: BatchStatus;
  message?: string;
  /** Final value when applied. */
  after?: number;
  /** Set when the row came from the offline intent queue. */
  queueId?: number;
}

export type TallyMode = 'count' | 'receive';

/**
 * Batch apply (spec §4.4): one confirmation screen, then strictly sequential writes, each through
 * the single confirmed write path (StockWriter.apply). Failed / conflicting rows stay for retry.
 */
export class BatchRunner {
  static fromTally(rows: readonly TallyRow[], mode: TallyMode): BatchRow[] {
    return rows.map((r) => ({
      key: `t:${r.itemId}`,
      itemId: r.itemId,
      itemName: r.itemName,
      intent: { action: mode, amount: r.count },
      base: null,
      status: 'pending',
    }));
  }

  static fromQueue(rows: readonly QueuedIntentRow[]): BatchRow[] {
    return rows.map((q) => ({
      key: `q:${q.id}`,
      itemId: q.item_id,
      itemName: q.item_name ?? q.item_id,
      intent: { action: q.action, amount: q.delta, ...(q.reason ? { reason: q.reason } : {}), ...(q.note ? { note: q.note } : {}) },
      base: null,
      status: 'pending',
      queueId: q.id,
    }));
  }

  /** Fresh live reads for every row, one at a time (no writes). */
  static async loadBases(api: Pick<StockApi, 'item'>, rows: readonly BatchRow[]): Promise<BatchRow[]> {
    const out: BatchRow[] = [];
    for (const r of rows) {
      if (r.status === 'applied' || r.status === 'unconfirmed') {
        out.push(r);
        continue;
      }
      try {
        const live = (await api.item(r.itemId)).stockQty;
        out.push(live == null ? { ...r, base: null, message: 'Stock is not tracked in Clover' } : { ...r, base: live, message: undefined });
      } catch {
        out.push({ ...r, base: null, message: 'Can’t read live stock (offline?)' });
      }
    }
    return out;
  }

  static invalid(r: BatchRow): string | null {
    return r.base == null ? (r.message ?? 'No live stock') : StockMath.validate(r.intent, r.base);
  }

  static runnable(r: BatchRow): boolean {
    return (r.status === 'pending' || r.status === 'conflict' || r.status === 'failed') && BatchRunner.invalid(r) == null;
  }

  /**
   * Runs every runnable row sequentially. Never retries a row inside a run. Stops at the first
   * unknown outcome (the connection is suspect; the rest stay pending for a new confirmation).
   */
  static async run(
    db: SqlDb,
    api: StockApi,
    rows: readonly BatchRow[],
    opts: { newId: () => string; onRow?: (rows: BatchRow[]) => void; now?: () => number },
  ): Promise<BatchRow[]> {
    const out = rows.slice();
    for (let i = 0; i < out.length; i++) {
      const r = out[i] as BatchRow;
      if (!BatchRunner.runnable(r) || r.base == null) continue;
      const outcome = await StockWriter.apply(db, api, {
        itemId: r.itemId,
        itemName: r.itemName,
        intent: r.intent,
        expected: r.base,
        clientMutationId: opts.newId(),
        now: opts.now?.(),
      });
      let next: BatchRow;
      if (outcome.kind === 'applied') next = { ...r, status: 'applied', base: outcome.before, after: outcome.after, message: undefined };
      else if (outcome.kind === 'conflict') next = { ...r, status: 'conflict', base: outcome.live, message: `Stock changed to ${outcome.live}` };
      else if (outcome.kind === 'failed') next = { ...r, status: 'failed', message: outcome.message };
      else next = { ...r, status: 'unconfirmed', base: outcome.live, message: outcome.message };
      out[i] = next;
      if (r.queueId != null && (next.status === 'applied' || next.status === 'unconfirmed')) {
        await IntentQueueRepo.close(db, r.queueId, next.status === 'applied' ? 'applied' : 'sent', opts.now?.());
      }
      opts.onRow?.(out.slice());
      if (next.status === 'unconfirmed') break;
    }
    return out;
  }

  static summary(rows: readonly BatchRow[]): Record<BatchStatus, number> {
    const s: Record<BatchStatus, number> = { pending: 0, applied: 0, conflict: 0, failed: 0, unconfirmed: 0 };
    for (const r of rows) s[r.status]++;
    return s;
  }
}
