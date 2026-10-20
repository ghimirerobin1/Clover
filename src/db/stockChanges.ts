import type { AdjustReason, StockAction } from '../api/schemas';
import type { SqlDb } from './driver';

export type LocalChangeStatus = 'applied' | 'unconfirmed';

export interface StockChangeRow {
  id: number;
  item_id: string;
  item_name: string | null;
  action: StockAction;
  before_qty: number | null;
  after_qty: number | null;
  reason: AdjustReason | null;
  note: string | null;
  status: LocalChangeStatus;
  client_mutation_id: string | null;
  live_qty: number | null;
  created_at: number;
  resolved_at: number | null;
}

/** Local log of this device's writes. Unconfirmed rows surface at the top of Activity until the user resolves them. */
export class StockChangesRepo {
  static async insert(
    db: SqlDb,
    row: Omit<StockChangeRow, 'id' | 'resolved_at'>,
  ): Promise<void> {
    await db.run(
      `INSERT INTO stock_changes (item_id, item_name, action, before_qty, after_qty, reason, note, status, client_mutation_id, live_qty, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.item_id, row.item_name, row.action, row.before_qty, row.after_qty, row.reason, row.note, row.status, row.client_mutation_id, row.live_qty, row.created_at],
    );
  }

  static async unconfirmed(db: SqlDb): Promise<StockChangeRow[]> {
    return db.all<StockChangeRow>(
      "SELECT * FROM stock_changes WHERE status = 'unconfirmed' AND resolved_at IS NULL ORDER BY created_at DESC, id DESC",
    );
  }

  static async setLive(db: SqlDb, id: number, liveQty: number | null): Promise<void> {
    await db.run('UPDATE stock_changes SET live_qty = ? WHERE id = ?', [liveQty, id]);
  }

  static async resolve(db: SqlDb, id: number, at: number): Promise<void> {
    await db.run('UPDATE stock_changes SET resolved_at = ? WHERE id = ?', [at, id]);
  }
}
