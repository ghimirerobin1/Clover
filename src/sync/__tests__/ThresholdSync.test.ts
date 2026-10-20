import type { RemoteItem, ThresholdMap, ThresholdScope } from '../../api/schemas';
import { ItemRepo } from '../../db/items';
import { WasmSqlDb } from '../../db/testing/wasmDb';
import { ApiError } from '../../lib/errors';
import { ThresholdSync, type ThresholdApi } from '../ThresholdSync';

const item = (id: string, categoryId: string | null = null): RemoteItem => ({
  id, name: id, sku: null, code: null, priceCents: 1, costCents: null, categoryId, stockQty: 3, modifiedTime: 1, deleted: false,
});

class FakeProxy implements ThresholdApi {
  map: ThresholdMap = { items: {}, categories: {} };
  online = true;
  puts: string[] = [];
  async thresholds(): Promise<ThresholdMap> {
    if (!this.online) throw new ApiError('NETWORK', 'offline', true);
    return structuredClone(this.map);
  }
  async putThreshold(scope: ThresholdScope, id: string, v: number | null): Promise<ThresholdMap> {
    if (!this.online) throw new ApiError('NETWORK', 'offline', true);
    this.puts.push(`${scope}:${id}=${v}`);
    const t = scope === 'item' ? this.map.items : this.map.categories;
    if (v == null) delete t[id];
    else t[id] = v;
    return structuredClone(this.map);
  }
}

describe('ThresholdSync (per-item thresholds on the proxy)', () => {
  let db: WasmSqlDb;
  let api: FakeProxy;
  beforeEach(async () => {
    db = await WasmSqlDb.migrated();
    api = new FakeProxy();
    await ItemRepo.upsertCategories(db, [{ id: 'C1', name: 'Rice', sortOrder: 1 }]);
    await ItemRepo.upsertItems(db, [item('A', 'C1'), item('B')], 1);
  });
  afterEach(() => db.close());

  it('online edit: local at once and pushed', async () => {
    expect(await ThresholdSync.set(db, api, 'item', 'A', 10)).toBe('synced');
    expect((await ItemRepo.byId(db, 'A', 5))?.threshold).toBe(10);
    expect(api.map.items).toEqual({ A: 10 });
    expect(await ThresholdSync.pending(db)).toEqual([]);
  });

  it('offline edit stays in the outbox, wins over the server until pushed, then syncs', async () => {
    api.map.items = { A: 2 };
    api.online = false;
    expect(await ThresholdSync.set(db, api, 'item', 'A', 7)).toBe('pending');
    expect(await ThresholdSync.set(db, api, 'category', 'C1', 4)).toBe('pending');
    expect((await ItemRepo.byId(db, 'A', 5))?.threshold).toBe(7);
    api.online = true;
    const res = await ThresholdSync.pull(db, api);
    expect(res).toEqual({ items: 1, categories: 1, pending: 0 });
    expect(api.map).toEqual({ items: { A: 7 }, categories: { C1: 4 } });
    expect(api.puts).toEqual(['item:A=7', 'category:C1=4']);
    expect((await ItemRepo.byId(db, 'B', 5))?.threshold).toBe(5); // B has no category → global default
  });

  it('pull applies other devices’ changes and clears removed ones', async () => {
    await ThresholdSync.set(db, api, 'item', 'B', 9);
    api.map = { items: { A: 1 }, categories: { C1: 8 } }; // another device changed things
    await ThresholdSync.pull(db, api);
    expect((await ItemRepo.byId(db, 'A', 5))?.low_stock_threshold).toBe(1);
    expect((await ItemRepo.byId(db, 'B', 5))?.low_stock_threshold).toBeNull();
    expect((await ItemRepo.categories(db))[0]?.low_stock_threshold).toBe(8);
  });

  it('clearing (null) is synced too', async () => {
    await ThresholdSync.set(db, api, 'item', 'A', 3);
    await ThresholdSync.set(db, api, 'item', 'A', null);
    expect(api.map.items).toEqual({});
    expect((await ItemRepo.byId(db, 'A', 5))?.low_stock_threshold).toBeNull();
  });

  it('rejects invalid thresholds before touching anything', async () => {
    await expect(ThresholdSync.set(db, api, 'item', 'A', -1)).rejects.toThrow(RangeError);
    await expect(ThresholdSync.set(db, api, 'category', 'C1', 1.5)).rejects.toThrow(RangeError);
    expect(api.puts).toEqual([]);
  });

  it('a catalog clear + pull restores shared thresholds', async () => {
    await ThresholdSync.set(db, api, 'item', 'A', 6);
    await ItemRepo.clear(db);
    await ItemRepo.upsertItems(db, [item('A', 'C1')], 2);
    await ThresholdSync.pull(db, api);
    expect((await ItemRepo.byId(db, 'A', 5))?.low_stock_threshold).toBe(6);
  });
});
