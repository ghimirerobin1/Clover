import type { RemoteItem, StockWriteRequest, StockWriteResult } from '../../../api/schemas';
import { IntentQueueRepo } from '../../../db/intentQueue';
import { ItemRepo } from '../../../db/items';
import { StockChangesRepo } from '../../../db/stockChanges';
import { WasmSqlDb } from '../../../db/testing/wasmDb';
import { ApiError } from '../../../lib/errors';
import type { StockApi } from '../../stock';
import { BatchRunner, type BatchRow } from '../BatchRunner';

const remote = (id: string, qty: number | null): RemoteItem => ({
  id, name: id, sku: null, code: null, priceCents: 100, costCents: null, categoryId: null, stockQty: qty, modifiedTime: 1, deleted: false,
});

/** Proxy fake with the server's expected-quantity check; records call order and concurrency. */
class FakeProxy implements StockApi {
  stock = new Map<string, number | null>();
  log: string[] = [];
  inFlight = 0;
  maxInFlight = 0;
  failWith = new Map<string, () => ApiError>();
  /** Simulates a sale between the batch screen's read and the write. */
  saleBeforeWrite = new Map<string, number>();
  readFails = new Set<string>();

  async writeStock(id: string, body: StockWriteRequest): Promise<StockWriteResult> {
    this.log.push(`write:${id}`);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await new Promise((r) => setTimeout(r, 1));
    this.inFlight--;
    const sold = this.saleBeforeWrite.get(id);
    if (sold != null) {
      this.stock.set(id, (this.stock.get(id) ?? 0) - sold);
      this.saleBeforeWrite.delete(id);
    }
    const fail = this.failWith.get(id);
    if (fail) {
      this.failWith.delete(id);
      throw fail();
    }
    const cur = this.stock.get(id) ?? 0;
    if (cur !== body.expectedQuantity) throw new ApiError('CONFLICT', 'changed', false, 409, cur);
    this.stock.set(id, body.newQuantity);
    return { itemId: id, previousQuantity: cur, newQuantity: body.newQuantity, auditId: this.log.length, replayed: false };
  }

  async item(id: string): Promise<RemoteItem> {
    this.log.push(`read:${id}`);
    if (this.readFails.has(id)) throw new ApiError('NETWORK', 'offline', true);
    return remote(id, this.stock.get(id) ?? null);
  }
}

let n = 0;
const newId = () => `batch-mutation-${++n}`;

describe('BatchRunner', () => {
  let db: WasmSqlDb;
  let api: FakeProxy;
  beforeEach(async () => {
    db = await WasmSqlDb.migrated();
    api = new FakeProxy();
    for (const [id, q] of [['A', 10], ['B', 5], ['C', 7], ['D', 2], ['E', 3]] as const) api.stock.set(id, q);
    await ItemRepo.upsertItems(db, ['A', 'B', 'C', 'D', 'E'].map((id) => remote(id, api.stock.get(id) ?? 0)), 1);
  });
  afterEach(() => db.close());

  const tally = (counts: Record<string, number>) => Object.entries(counts).map(([itemId, count]) => ({ itemId, itemName: itemId, count }));

  it('loads live bases with reads only, in order', async () => {
    api.readFails.add('C');
    const rows = await BatchRunner.loadBases(api, BatchRunner.fromTally(tally({ A: 3, C: 1 }), 'count'));
    expect(rows.map((r) => r.base)).toEqual([10, null]);
    expect(rows[1]?.message).toMatch(/Can’t read live stock/);
    expect(BatchRunner.runnable(rows[1] as BatchRow)).toBe(false);
    expect(api.log).toEqual(['read:A', 'read:C']);
  });

  it('mixed batch: sequential writes, per-row result, failures/conflicts stay for retry', async () => {
    api.saleBeforeWrite.set('B', 1); // live 5 → 4 between read and write → 409
    api.failWith.set('C', () => new ApiError('VALIDATION', 'Clover rejected it', false, 422));
    const rows = await BatchRunner.loadBases(api, BatchRunner.fromTally(tally({ A: 12, B: 6, C: 9, D: 4 }), 'receive'));
    api.log = [];
    const progress: string[][] = [];
    const out = await BatchRunner.run(db, api, rows, { newId, onRow: (r) => progress.push(r.map((x) => x.status)) });

    expect(out.map((r) => [r.itemId, r.status, r.base, r.after ?? null])).toEqual([
      ['A', 'applied', 10, 22],
      ['B', 'conflict', 4, null],
      ['C', 'failed', 7, null],
      ['D', 'applied', 2, 6],
    ]);
    expect(api.log).toEqual(['write:A', 'write:B', 'write:C', 'write:D']); // no reads, no retries
    expect(api.maxInFlight).toBe(1); // strictly sequential
    expect(progress).toHaveLength(4);
    expect((await ItemRepo.byId(db, 'A', 5))?.stock_qty).toBe(22);
    expect((await ItemRepo.byId(db, 'B', 5))?.stock_qty).toBe(4); // live value cached on conflict

    // Second confirmation tap: only conflict + failed rows go; Receive recomputes from the new base.
    api.log = [];
    const again = await BatchRunner.run(db, api, out, { newId });
    expect(api.log).toEqual(['write:B', 'write:C']);
    expect(again.map((r) => [r.itemId, r.status, r.after ?? null])).toEqual([
      ['A', 'applied', 22],
      ['B', 'applied', 10],
      ['C', 'applied', 16],
      ['D', 'applied', 6],
    ]);
  });

  it('Count keeps the absolute number after a conflict', async () => {
    api.saleBeforeWrite.set('A', 2);
    const rows = await BatchRunner.loadBases(api, BatchRunner.fromTally(tally({ A: 9 }), 'count'));
    const out = await BatchRunner.run(db, api, rows, { newId });
    expect(out[0]).toMatchObject({ status: 'conflict', base: 8 });
    const again = await BatchRunner.run(db, api, out, { newId });
    expect(again[0]).toMatchObject({ status: 'applied', base: 8, after: 9 });
  });

  it('unknown outcome marks the row Unconfirmed, stops the batch, never retries', async () => {
    api.failWith.set('B', () => new ApiError('NETWORK', 'Network request failed', true));
    const rows = await BatchRunner.loadBases(api, BatchRunner.fromTally(tally({ A: 1, B: 1, C: 1 }), 'receive'));
    api.log = [];
    const out = await BatchRunner.run(db, api, rows, { newId });
    expect(out.map((r) => r.status)).toEqual(['applied', 'unconfirmed', 'pending']);
    expect(api.log).toEqual(['write:A', 'write:B', 'read:B']); // single re-read for the unknown row, then stop
    expect(await StockChangesRepo.unconfirmed(db)).toHaveLength(1);
    // A later run never re-sends the unconfirmed row.
    api.log = [];
    await BatchRunner.run(db, api, out, { newId });
    expect(api.log).toEqual(['write:C']);
  });

  it('invalid rows (below zero, offline) are skipped without a request', async () => {
    const rows: BatchRow[] = [
      { key: 'x', itemId: 'E', itemName: 'E', intent: { action: 'adjust', amount: -9, reason: 'damaged' }, base: 3, status: 'pending' },
      { key: 'y', itemId: 'D', itemName: 'D', intent: { action: 'receive', amount: 1 }, base: null, status: 'pending' },
    ];
    const out = await BatchRunner.run(db, api, rows, { newId });
    expect(out.map((r) => r.status)).toEqual(['pending', 'pending']);
    expect(api.log).toEqual([]);
  });

  it('every write uses a fresh mutation id', async () => {
    const ids: string[] = [];
    const spy = jest.spyOn(api, 'writeStock').mockImplementation(async (id, body) => {
      ids.push(body.clientMutationId);
      return { itemId: id, previousQuantity: body.expectedQuantity, newQuantity: body.newQuantity, auditId: 1, replayed: false };
    });
    const rows = await BatchRunner.loadBases(api, BatchRunner.fromTally(tally({ A: 1, B: 1 }), 'receive'));
    await BatchRunner.run(db, api, rows, { newId });
    expect(new Set(ids).size).toBe(2);
    spy.mockRestore();
  });

  it('queued intents: applied rows close the queue entry; conflicts stay queued', async () => {
    await IntentQueueRepo.enqueue(db, { itemId: 'A', itemName: 'A', action: 'receive', delta: 24, now: 1 });
    await IntentQueueRepo.enqueue(db, { itemId: 'B', itemName: 'B', action: 'adjust', delta: -2, reason: 'expired', now: 2 });
    const rows = await BatchRunner.loadBases(api, BatchRunner.fromQueue(await IntentQueueRepo.pending(db)));
    expect(rows.map((r) => [r.base, r.intent])).toEqual([
      [10, { action: 'receive', amount: 24 }],
      [5, { action: 'adjust', amount: -2, reason: 'expired' }],
    ]);
    api.saleBeforeWrite.set('B', 1);
    const out = await BatchRunner.run(db, api, rows, { newId });
    expect(out.map((r) => r.status)).toEqual(['applied', 'conflict']);
    expect((await IntentQueueRepo.pending(db)).map((q) => q.item_id)).toEqual(['B']);
    // The delta is applied to the *live* base at confirmation time: 4 − 2 = 2 (not the 5 seen when queued).
    const again = await BatchRunner.run(db, api, out, { newId });
    expect(again[1]).toMatchObject({ status: 'applied', base: 4, after: 2 });
    expect(await IntentQueueRepo.pending(db)).toEqual([]);
  });

  it('summary counts', () => {
    const row = (status: BatchRow['status']): BatchRow => ({ key: status, itemId: 'A', itemName: 'A', intent: { action: 'receive', amount: 1 }, base: 1, status });
    expect(BatchRunner.summary([row('applied'), row('failed'), row('failed'), row('conflict')])).toEqual({
      pending: 0, applied: 1, conflict: 1, failed: 2, unconfirmed: 0,
    });
  });
});
