import type { RemoteItem, StockWriteRequest, StockWriteResult } from '../../../api/schemas';
import { ItemRepo } from '../../../db/items';
import { StockChangesRepo } from '../../../db/stockChanges';
import { WasmSqlDb } from '../../../db/testing/wasmDb';
import { ApiError } from '../../../lib/errors';
import { StockMath } from '../StockMath';
import { StockWriter, type StockApi } from '../StockWriter';

const remoteItem = (qty: number | null): RemoteItem => ({
  id: 'RICE', name: 'Jasmine Rice', sku: null, code: null, priceCents: 2899, costCents: null,
  categoryId: null, stockQty: qty, modifiedTime: 1, deleted: false,
});

/** Fake proxy implementing the server's read-verify-write contract over an in-memory quantity. */
class FakeProxy implements StockApi {
  qty = 14;
  writes: StockWriteRequest[] = [];
  failNext: (() => never) | null = null;
  liveFails = false;

  async writeStock(_id: string, body: StockWriteRequest): Promise<StockWriteResult> {
    this.writes.push(body);
    if (this.failNext) {
      const f = this.failNext;
      this.failNext = null;
      f();
    }
    if (body.expectedQuantity !== this.qty) {
      throw new ApiError('CONFLICT', `Stock changed to ${this.qty}`, false, 409, this.qty);
    }
    const prev = this.qty;
    this.qty = body.newQuantity;
    return { itemId: 'RICE', previousQuantity: prev, newQuantity: this.qty, auditId: this.writes.length, replayed: false };
  }

  async item(): Promise<RemoteItem> {
    if (this.liveFails) throw new ApiError('NETWORK', 'offline', true);
    return remoteItem(this.qty);
  }
}

describe('StockWriter', () => {
  let db: WasmSqlDb;
  let api: FakeProxy;
  beforeEach(async () => {
    db = await WasmSqlDb.migrated();
    api = new FakeProxy();
    await ItemRepo.upsertItems(db, [remoteItem(14)], 1);
  });
  afterEach(() => db.close());

  const write = (intent: Parameters<typeof StockWriter.apply>[2]['intent'], expected: number, cmid = 'cmid-0001') =>
    StockWriter.apply(db, api, { itemId: 'RICE', itemName: 'Jasmine Rice', intent, expected, clientMutationId: cmid, now: 1000 });

  it('applied: sends expected/new, updates SQLite optimistically, logs locally', async () => {
    const out = await write({ action: 'receive', amount: 24, note: 'INV-9' }, 14);
    expect(out).toEqual({ kind: 'applied', before: 14, after: 38, auditId: 1 });
    expect(api.writes).toEqual([
      { expectedQuantity: 14, newQuantity: 38, action: 'receive', note: 'INV-9', clientMutationId: 'cmid-0001' },
    ]);
    expect((await ItemRepo.byId(db, 'RICE', 5))?.stock_qty).toBe(38);
    expect(await StockChangesRepo.unconfirmed(db)).toEqual([]);
  });

  it('count also stamps last_counted_at', async () => {
    await write({ action: 'count', amount: 10 }, 14);
    expect((await ItemRepo.byId(db, 'RICE', 5))?.last_counted_at).toBe(1000);
  });

  it('409: returns the live value, writes nothing, caches live locally; re-confirm uses the new base', async () => {
    api.qty = 12; // a sale happened
    const out = await write({ action: 'receive', amount: 24 }, 14);
    expect(out).toEqual({ kind: 'conflict', live: 12 });
    expect(api.qty).toBe(12);
    expect((await ItemRepo.byId(db, 'RICE', 5))?.stock_qty).toBe(12);

    // The user taps "Re-confirm": Receive recomputes from 12 → 36 with a NEW mutation id.
    const { expected } = StockMath.rebase({ action: 'receive', amount: 24 }, 12);
    const again = await write({ action: 'receive', amount: 24 }, expected, 'cmid-0002');
    expect(again).toMatchObject({ kind: 'applied', before: 12, after: 36 });
    expect(api.writes.map((w) => w.clientMutationId)).toEqual(['cmid-0001', 'cmid-0002']);
  });

  it('409 on Count keeps the absolute number', async () => {
    api.qty = 12;
    await write({ action: 'count', amount: 20 }, 14);
    const out = await write({ action: 'count', amount: 20 }, 12, 'cmid-0002');
    expect(out).toMatchObject({ kind: 'applied', after: 20 });
  });

  it('network failure after send → unconfirmed, re-fetched, NOT retried', async () => {
    api.failNext = () => {
      api.qty = 38; // it actually went through upstream…
      throw new ApiError('NETWORK', 'Network request failed', true);
    };
    const out = await write({ action: 'receive', amount: 24 }, 14);
    expect(out).toEqual({ kind: 'unknown', live: 38, message: 'Network request failed' });
    expect(api.writes).toHaveLength(1); // no automatic retry
    const [row] = await StockChangesRepo.unconfirmed(db);
    expect(row).toMatchObject({ status: 'unconfirmed', before_qty: 14, after_qty: 38, live_qty: 38, item_name: 'Jasmine Rice' });
    expect((await ItemRepo.byId(db, 'RICE', 5))?.stock_qty).toBe(38);
  });

  it('unknown outcome while still offline keeps live = null and the cached stock untouched', async () => {
    api.liveFails = true;
    api.failNext = () => {
      throw new ApiError('UPSTREAM', 'Lost connection to Clover during a write; the outcome is unknown.', false, 502);
    };
    const out = await write({ action: 'adjust', amount: -2, reason: 'damaged' }, 14);
    expect(out).toMatchObject({ kind: 'unknown', live: null });
    expect((await ItemRepo.byId(db, 'RICE', 5))?.stock_qty).toBe(14);
    expect(await StockChangesRepo.unconfirmed(db)).toHaveLength(1);
  });

  it('pending-id CONFLICT without a live value is treated as unknown', () => {
    expect(StockWriter.classify(new ApiError('CONFLICT', 'in progress', false, 409))).toMatchObject({ kind: 'unknown' });
  });

  it.each([
    [new ApiError('VALIDATION', 'bad', false, 422), { kind: 'failed', retryable: false }],
    [new ApiError('AUTH', 'bad key', false, 401), { kind: 'failed', retryable: false }],
    [new ApiError('RATE_LIMITED', 'slow down', false, 429), { kind: 'failed', retryable: true }],
    [new ApiError('NOT_FOUND', 'gone', false, 404), { kind: 'failed' }],
    [new Error('zod parse'), { kind: 'unknown' }],
  ])('classifies %p', (err, expected) => {
    expect(StockWriter.classify(err)).toMatchObject(expected);
  });

  it('refuses invalid intents without calling the proxy', async () => {
    const out = await write({ action: 'adjust', amount: -20, reason: 'damaged' }, 14);
    expect(out).toMatchObject({ kind: 'failed' });
    expect(api.writes).toEqual([]);
  });

  it('undo is a confirmed write of the inverse delta, with its own conflict handling', async () => {
    const applied = await write({ action: 'receive', amount: 24 }, 14);
    if (applied.kind !== 'applied') throw new Error('expected applied');
    const undo = StockMath.undoIntent({ before: applied.before, after: applied.after });
    // A sale happens before the user taps Undo → 409 with live 37.
    api.qty = 37;
    expect(await write(undo, applied.after, 'cmid-undo-1')).toEqual({ kind: 'conflict', live: 37 });
    // Re-confirmed undo removes the 24 from the new base.
    const out = await write(undo, 37, 'cmid-undo-2');
    expect(out).toMatchObject({ kind: 'applied', before: 37, after: 13 });
    expect(api.writes.at(-1)).toMatchObject({ action: 'undo', expectedQuantity: 37, newQuantity: 13 });
  });

  it('resolving an unconfirmed row hides it', async () => {
    api.failNext = () => {
      throw new ApiError('NETWORK', 'x', true);
    };
    await write({ action: 'receive', amount: 1 }, 14);
    const [row] = await StockChangesRepo.unconfirmed(db);
    await StockChangesRepo.resolve(db, row!.id, 5);
    expect(await StockChangesRepo.unconfirmed(db)).toEqual([]);
  });
});
