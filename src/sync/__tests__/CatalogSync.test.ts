import type { ItemPage, RemoteCategory, RemoteItem } from '../../api/schemas';
import { ItemRepo } from '../../db/items';
import { SettingsRepo } from '../../db/settings';
import { WasmSqlDb } from '../../db/testing/wasmDb';
import { CatalogSync, STALE_AFTER_MS, type CatalogSource } from '../CatalogSync';

const mk = (i: number, modifiedTime = i): RemoteItem => ({
  id: `I${i}`,
  name: `Item ${i}`,
  sku: `SKU-${i}`,
  code: null,
  priceCents: 100 + i,
  costCents: null,
  categoryId: null,
  stockQty: i,
  modifiedTime,
  deleted: false,
});

/** In-memory Clover catalog behind the CatalogSource interface. */
class FakeSource {
  calls: { limit: number; offset: number; modifiedSince?: number }[] = [];
  failAtOffset: number | null = null;
  constructor(
    public items: RemoteItem[],
    public cats: RemoteCategory[] = [{ id: 'C1', name: 'Cat', sortOrder: 1 }],
  ) {}

  async page(p: { limit: number; offset: number; modifiedSince?: number }): Promise<ItemPage> {
    this.calls.push(p);
    if (this.failAtOffset === p.offset) throw new Error('network down');
    const filtered = p.modifiedSince == null ? this.items : this.items.filter((i) => i.modifiedTime >= (p.modifiedSince as number));
    const page = filtered.slice(p.offset, p.offset + p.limit);
    return { items: page, offset: p.offset, limit: p.limit, hasMore: page.length === p.limit };
  }
}

const sourceOf = (f: FakeSource): CatalogSource => ({
  items: (p) => f.page(p),
  categories: async () => f.cats,
});

describe('CatalogSync', () => {
  let db: WasmSqlDb;
  beforeEach(async () => {
    db = await WasmSqlDb.migrated();
  });
  afterEach(() => db.close());

  it('first run is a full sync paged at 1000 with progress', async () => {
    const fake = new FakeSource(Array.from({ length: 2500 }, (_, i) => mk(i)));
    const progress: number[] = [];
    const res = await CatalogSync.run(db, sourceOf(fake), { onProgress: (p) => progress.push(p.fetched), now: () => 10 });
    expect(res).toEqual({ mode: 'full', fetched: 2500, deleted: 0, syncedAt: 10 });
    expect(fake.calls.map((c) => [c.offset, c.limit, c.modifiedSince])).toEqual([
      [0, 1000, undefined],
      [1000, 1000, undefined],
      [2000, 1000, undefined],
    ]);
    expect(progress).toEqual([0, 1000, 2000, 2500]);
    expect(await ItemRepo.count(db)).toBe(2500);
    expect(await SettingsRepo.getNumber(db, 'synced_through_modified')).toBe(2499);
    expect(await SettingsRepo.getNumber(db, 'last_synced_at')).toBe(10);
    expect(await ItemRepo.categories(db)).toHaveLength(1);
  });

  it('exact multiple of page size stops on the empty page', async () => {
    const fake = new FakeSource(Array.from({ length: 1000 }, (_, i) => mk(i)));
    await CatalogSync.run(db, sourceOf(fake));
    expect(fake.calls).toHaveLength(2);
  });

  it('then delta syncs with modifiedSince = max modifiedTime seen (server clock)', async () => {
    const fake = new FakeSource([mk(1, 100), mk(2, 200)]);
    await CatalogSync.run(db, sourceOf(fake), { now: () => 1 });
    fake.items.push({ ...mk(3, 300) });
    fake.items[0] = { ...mk(1, 250), name: 'Renamed' };
    fake.calls = [];
    const res = await CatalogSync.run(db, sourceOf(fake), { now: () => 2 });
    expect(res.mode).toBe('delta');
    expect(fake.calls[0]?.modifiedSince).toBe(200);
    expect(res.fetched).toBe(3); // >= is inclusive; re-upserting item 2 is harmless
    expect((await ItemRepo.byId(db, 'I1', 5))?.name).toBe('Renamed');
    expect(await ItemRepo.count(db)).toBe(3);
    expect(await SettingsRepo.getNumber(db, 'synced_through_modified')).toBe(300);
  });

  it('delta applies Clover deletions', async () => {
    const fake = new FakeSource([mk(1, 100), mk(2, 200)]);
    await CatalogSync.run(db, sourceOf(fake));
    fake.items[1] = { ...mk(2, 400), deleted: true };
    await CatalogSync.run(db, sourceOf(fake));
    expect(await ItemRepo.byId(db, 'I2', 5)).toBeNull();
  });

  it('full re-sync removes items that vanished from Clover but keeps local thresholds', async () => {
    const fake = new FakeSource([mk(1), mk(2), mk(3)]);
    await CatalogSync.run(db, sourceOf(fake), { now: () => 1 });
    await ItemRepo.setThreshold(db, 'I1', 9);
    fake.items = [mk(1), mk(3)];
    const res = await CatalogSync.run(db, sourceOf(fake), { full: true, now: () => 2 });
    expect(res.deleted).toBe(1);
    expect(await ItemRepo.byId(db, 'I2', 5)).toBeNull();
    expect((await ItemRepo.byId(db, 'I1', 5))?.low_stock_threshold).toBe(9);
  });

  it('a failure mid-sync does not advance the cursor', async () => {
    const fake = new FakeSource(Array.from({ length: 1500 }, (_, i) => mk(i)));
    fake.failAtOffset = 1000;
    await expect(CatalogSync.run(db, sourceOf(fake))).rejects.toThrow('network down');
    expect(await SettingsRepo.getNumber(db, 'synced_through_modified')).toBeNull();
    fake.failAtOffset = null;
    const res = await CatalogSync.run(db, sourceOf(fake));
    expect(res.mode).toBe('full');
    expect(await ItemRepo.count(db)).toBe(1500);
  });

  it('is single-flight', async () => {
    const fake = new FakeSource([mk(1)]);
    const [a, b] = await Promise.all([CatalogSync.run(db, sourceOf(fake)), CatalogSync.run(db, sourceOf(fake))]);
    expect(a).toBe(b);
    expect(fake.calls).toHaveLength(1);
  });

  it('staleness and description', () => {
    const now = 10 * STALE_AFTER_MS;
    expect(CatalogSync.isStale(null, now)).toBe(true);
    expect(CatalogSync.isStale(now - STALE_AFTER_MS + 1, now)).toBe(false);
    expect(CatalogSync.isStale(now - STALE_AFTER_MS - 1, now)).toBe(true);
    expect(CatalogSync.describe(null, now)).toBe('Never synced');
    expect(CatalogSync.describe(now - 10_000, now)).toBe('Synced just now');
    expect(CatalogSync.describe(now - 3 * 60_000, now)).toBe('Synced 3 min ago');
    expect(CatalogSync.describe(now - 2 * STALE_AFTER_MS, now)).toBe('Synced 2 h ago');
    expect(CatalogSync.describe(now - 72 * STALE_AFTER_MS, now)).toBe('Synced 3 d ago');
  });
});
