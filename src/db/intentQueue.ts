import type { AdjustReason } from '../api/schemas';
import type { SqlDb } from './driver';

export type QueueableAction = 'receive' | 'adjust';
export type QueuedStatus = 'queued' | 'applied' | 'sent' | 'discarded';

/** A queued intent: a signed delta to apply to whatever the live stock is at confirmation time. */
export interface QueuedIntentRow {
  id: number;
  item_id: string;
  item_name: string | null;
  action: QueueableAction;
  delta: number;
  reason: AdjustReason | null;
  note: string | null;
  status: QueuedStatus;
  created_at: number;
  resolved_at: number | null;
}

export interface NewQueuedIntent {
  itemId: string;
  itemName: string;
  action: QueueableAction;
  delta: number;
  reason?: AdjustReason;
  note?: string;
  now?: number;
}

/**
 * Offline intent queue (spec §4.4). Intents are deltas only ("Receive +24"); there is no column for an
 * expected or new quantity, so an absolute value can never be queued. Nothing here sends anything:
 * each intent is applied only after a live before → after confirmation (batch screen).
 */
export class IntentQueueRepo {
  static check(i: Pick<NewQueuedIntent, 'action' | 'delta' | 'reason'>): string | null {
    if ((i.action as string) !== 'receive' && (i.action as string) !== 'adjust') return 'Only Receive and Adjust can be queued';
    if (!Number.isInteger(i.delta) || i.delta === 0) return 'Enter a whole, non-zero amount';
    if (i.action === 'receive' && i.delta < 0) return 'Receive must be positive';
    if (i.action === 'adjust' && !i.reason) return 'Pick a reason';
    return null;
  }

  static async enqueue(db: SqlDb, i: NewQueuedIntent): Promise<void> {
    const invalid = IntentQueueRepo.check(i);
    if (invalid) throw new RangeError(invalid);
    await db.run(
      `INSERT INTO queued_intents (item_id, item_name, action, delta, reason, note, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
      [i.itemId, i.itemName, i.action, i.delta, i.reason ?? null, i.note ?? null, i.now ?? Date.now()],
    );
  }

  static async pending(db: SqlDb): Promise<QueuedIntentRow[]> {
    return db.all<QueuedIntentRow>("SELECT * FROM queued_intents WHERE status = 'queued' ORDER BY created_at, id");
  }

  static async count(db: SqlDb): Promise<number> {
    return (await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM queued_intents WHERE status = 'queued'"))?.n ?? 0;
  }

  /** applied = confirmed by Clover; sent = outcome unknown (tracked as Unconfirmed instead); discarded = user removed it. */
  static async close(db: SqlDb, id: number, status: Exclude<QueuedStatus, 'queued'>, at = Date.now()): Promise<void> {
    await db.run("UPDATE queued_intents SET status = ?, resolved_at = ? WHERE id = ? AND status = 'queued'", [status, at, id]);
  }
}
