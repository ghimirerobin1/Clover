import type { RemoteItem, StockWriteRequest, StockWriteResult } from '../../api/schemas';
import type { SqlDb } from '../../db/driver';
import { ItemRepo } from '../../db/items';
import { StockChangesRepo } from '../../db/stockChanges';
import { ApiError } from '../../lib/errors';
import { StockMath, type StockIntent } from './StockMath';

export interface StockApi {
  writeStock(itemId: string, body: StockWriteRequest): Promise<StockWriteResult>;
  item(itemId: string): Promise<RemoteItem>;
}

export type WriteOutcome =
  | { kind: 'applied'; before: number; after: number; auditId: number }
  | { kind: 'conflict'; live: number }
  | { kind: 'unknown'; live: number | null; message: string }
  | { kind: 'failed'; message: string; retryable: boolean };

export interface ConfirmedWrite {
  itemId: string;
  itemName: string;
  intent: StockIntent;
  /** The base the user saw on the confirmation card. */
  expected: number;
  clientMutationId: string;
  now?: number;
}

/**
 * Executes ONE confirmed stock write (spec §4.4). Callers invoke this only from the
 * "Apply to Clover" tap on a card showing before → after. It never retries.
 */
export class StockWriter {
  static classify(e: unknown): WriteOutcome {
    if (e instanceof ApiError) {
      if (e.code === 'CONFLICT' && e.currentQuantity != null) return { kind: 'conflict', live: e.currentQuantity };
      // NETWORK / UPSTREAM (incl. "outcome unknown" from the proxy) / CONFLICT on a pending id:
      // the write may or may not have happened.
      if (e.code === 'NETWORK' || e.code === 'UPSTREAM' || e.code === 'CONFLICT') {
        return { kind: 'unknown', live: null, message: e.message };
      }
      return { kind: 'failed', message: e.message, retryable: e.code === 'RATE_LIMITED' };
    }
    // Unexpected client-side error (e.g. response failed validation) after sending: treat as unknown.
    return { kind: 'unknown', live: null, message: e instanceof Error ? e.message : 'Unknown error' };
  }

  static async apply(db: SqlDb, api: StockApi, w: ConfirmedWrite): Promise<WriteOutcome> {
    const now = w.now ?? Date.now();
    const target = StockMath.target(w.intent, w.expected);
    const invalid = StockMath.validate(w.intent, w.expected);
    if (invalid) return { kind: 'failed', message: invalid, retryable: false };

    let outcome: WriteOutcome;
    try {
      const res = await api.writeStock(w.itemId, {
        expectedQuantity: w.expected,
        newQuantity: target,
        action: w.intent.action,
        ...(w.intent.reason ? { reason: w.intent.reason } : {}),
        ...(w.intent.note ? { note: w.intent.note } : {}),
        clientMutationId: w.clientMutationId,
      });
      outcome = { kind: 'applied', before: res.previousQuantity, after: res.newQuantity, auditId: res.auditId };
    } catch (e) {
      outcome = StockWriter.classify(e);
    }

    if (outcome.kind === 'applied') {
      await ItemRepo.setLocalStock(db, w.itemId, outcome.after, w.intent.action === 'count' ? { countedAt: now } : {});
      await StockChangesRepo.insert(db, {
        item_id: w.itemId,
        item_name: w.itemName,
        action: w.intent.action,
        before_qty: outcome.before,
        after_qty: outcome.after,
        reason: w.intent.reason ?? null,
        note: w.intent.note ?? null,
        status: 'applied',
        client_mutation_id: w.clientMutationId,
        live_qty: outcome.after,
        created_at: now,
      });
    } else if (outcome.kind === 'conflict') {
      await ItemRepo.setLocalStock(db, w.itemId, outcome.live);
    } else if (outcome.kind === 'unknown') {
      // Do NOT retry. Record it, re-read the live value, and let the user decide.
      const live = await StockWriter.liveOrNull(api, w.itemId);
      if (live != null) await ItemRepo.setLocalStock(db, w.itemId, live);
      await StockChangesRepo.insert(db, {
        item_id: w.itemId,
        item_name: w.itemName,
        action: w.intent.action,
        before_qty: w.expected,
        after_qty: target,
        reason: w.intent.reason ?? null,
        note: w.intent.note ?? null,
        status: 'unconfirmed',
        client_mutation_id: w.clientMutationId,
        live_qty: live,
        created_at: now,
      });
      outcome = { ...outcome, live };
    }
    return outcome;
  }

  static async liveOrNull(api: StockApi, itemId: string): Promise<number | null> {
    try {
      return (await api.item(itemId)).stockQty;
    } catch {
      return null;
    }
  }
}
