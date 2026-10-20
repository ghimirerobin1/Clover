import type { RemoteItem } from '../../api/schemas';
import { ItemRepo } from '../items';
import { Migrations } from '../migrations';
import { Seeder } from '../seed';
import { WasmSqlDb } from '../testing/wasmDb';

const item = (over: Partial<RemoteItem> & { id: string }): RemoteItem => ({
  name: over.id,
  sku: null,
  code: null,
  priceCents: 100,
  costCents: null,
  categoryId: null,
  stockQty: 10,
  modifiedTime: 1,
  deleted: false,
  ...over,
});

describe('ItemRepo', () => {
  let db: WasmSqlDb;
  beforeEach(async () => {
    db = await WasmSqlDb.migrated();
    await ItemRepo.upsertCategories(db, [
      { id: 'RICE', name: 'Rice', sortOrder: 1 },
      { id: 'SNACK', name: 'Snacks', sortOrder: 2 },
    ]);
    await ItemRepo.upsertItems(
      db,
      [
        item({ id: 'A', name: 'Jasmine Rice 20lb', sku: 'RICE-JAS-20', code: '074410000123', categoryId: 'RICE', stockQty: 14 }),
        item({ id: 'B', name: 'Basmati Rice 10lb', sku: 'RICE-BAS-10', categoryId: 'RICE', stockQty: 3 }),
        item({ id: 'C', name: 'Pocky Chocolate', sku: 'SNCK-POCKY', code: '073141150019', categoryId: 'SNACK', stockQty: 0 }),
        item({ id: 'D', name: 'Crème Wafers', categoryId: 'SNACK', stockQty: null, modifiedTime: 9 }),
      ],
      1000,
    );
  });
  afterEach(() => db.close());

  const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

  it('migrations are idempotent', async () => {
    await expect(Migrations.run(db)).resolves.toBe(Migrations.latest);
    expect(await db.first<{ user_version: number }>('PRAGMA user_version')).toEqual({ user_version: Migrations.latest });
  });

  it('FTS prefix search on name, sku and code', async () => {
    const q = (search: string) => ItemRepo.query(db, { search, globalThreshold: 5 }).then(ids);
    expect(await q('ric')).toEqual(['B', 'A']);
    expect(await q('jas ri')).toEqual(['A']);
    expect(await q('rice-bas')).toEqual(['B']);
    expect(await q('0731')).toEqual(['C']);
    expect(await q('creme')).toEqual(['D']); // diacritics folded
    expect(await q('zzz')).toEqual([]);
    expect(await q('"); --')).toHaveLength(4); // unsearchable input = no filter, no crash
  });

  it('FTS stays in sync on update and delete', async () => {
    await ItemRepo.upsertItems(db, [item({ id: 'A', name: 'Sticky Rice', modifiedTime: 2 })], 2000);
    expect(ids(await ItemRepo.query(db, { search: 'jasmine', globalThreshold: 5 }))).toEqual([]);
    expect(ids(await ItemRepo.query(db, { search: 'sticky', globalThreshold: 5 }))).toEqual(['A']);
    await ItemRepo.upsertItems(db, [item({ id: 'A', deleted: true })], 3000);
    expect(ids(await ItemRepo.query(db, { search: 'sticky', globalThreshold: 5 }))).toEqual([]);
  });

  it('filters by category and stock status with resolved thresholds', async () => {
    expect(ids(await ItemRepo.query(db, { categoryIds: ['SNACK'], globalThreshold: 5 }))).toEqual(['D', 'C']);
    expect(ids(await ItemRepo.query(db, { stockStatus: 'out', globalThreshold: 5 }))).toEqual(['C']);
    expect(ids(await ItemRepo.query(db, { stockStatus: 'low', globalThreshold: 5 }))).toEqual(['B']);
    // Category default overrides global; item override beats category.
    await db.run('UPDATE categories SET low_stock_threshold = 20 WHERE id = ?', ['RICE']);
    expect(ids(await ItemRepo.query(db, { stockStatus: 'low', globalThreshold: 5 }))).toEqual(['B', 'A']);
    await ItemRepo.setThreshold(db, 'A', 2);
    expect(ids(await ItemRepo.query(db, { stockStatus: 'low', globalThreshold: 5 }))).toEqual(['B']);
    const a = await ItemRepo.byId(db, 'A', 5);
    expect(a).toMatchObject({ threshold: 2, category_threshold: 20, low_stock_threshold: 2, category_name: 'Rice' });
    expect(ids(await ItemRepo.query(db, { stockStatus: 'ok', globalThreshold: 5 }))).toEqual(['A']);
  });

  it('threshold override survives a sync upsert', async () => {
    await ItemRepo.setThreshold(db, 'A', 7);
    await ItemRepo.upsertItems(db, [item({ id: 'A', name: 'Jasmine Rice 20lb', stockQty: 1, modifiedTime: 5 })], 5000);
    expect((await ItemRepo.byId(db, 'A', 5))?.low_stock_threshold).toBe(7);
    await expect(ItemRepo.setThreshold(db, 'A', -1)).rejects.toThrow(RangeError);
  });

  it('not counted in 30 days', async () => {
    const now = 100 * 86_400_000;
    await db.run('UPDATE items SET last_counted_at = ? WHERE id = ?', [now - 86_400_000, 'A']);
    await db.run('UPDATE items SET last_counted_at = ? WHERE id = ?', [now - 40 * 86_400_000, 'B']);
    expect(ids(await ItemRepo.query(db, { notCountedDays: 30, now, globalThreshold: 5 }))).toEqual(['B', 'D', 'C']);
  });

  it('sorts', async () => {
    expect(ids(await ItemRepo.query(db, { sort: 'stock_asc', globalThreshold: 5 }))).toEqual(['C', 'B', 'A', 'D']);
    expect(ids(await ItemRepo.query(db, { sort: 'modified_desc', globalThreshold: 5 }))[0]).toBe('D');
  });

  it('removes categories no longer in Clover', async () => {
    await ItemRepo.upsertCategories(db, [{ id: 'RICE', name: 'Rice & Grains', sortOrder: 1 }]);
    expect(await ItemRepo.categories(db)).toEqual([{ id: 'RICE', name: 'Rice & Grains', sort_order: 1, low_stock_threshold: null }]);
  });

  it('stores money as integer cents', async () => {
    const row = await ItemRepo.byId(db, 'A', 5);
    expect(Number.isInteger(row?.price_cents)).toBe(true);
  });

  it('clear() empties catalog and FTS', async () => {
    await ItemRepo.clear(db);
    expect(await ItemRepo.count(db)).toBe(0);
    expect(await ItemRepo.query(db, { search: 'rice', globalThreshold: 5 })).toEqual([]);
  });
});

describe('search performance (spec §6: < 50 ms on 10k items)', () => {
  it('FTS prefix search over 15,000 seeded items', async () => {
    const db = await WasmSqlDb.migrated();
    await Seeder.seed(db, 15_000, 1);
    expect(await ItemRepo.count(db)).toBe(15_000);
    const queries = ['j', 'jas', 'jasmine ri', 'udon 500', '9000000012', 'seed-149', 'matcha tea'];
    const timings: number[] = [];
    for (let round = 0; round < 3; round++) {
      for (const search of queries) {
        const t0 = performance.now();
        const rows = await ItemRepo.query(db, { search, globalThreshold: 5, limit: 500 });
        timings.push(performance.now() - t0);
        expect(rows.length).toBeGreaterThan(0);
      }
    }
    timings.sort((a, b) => a - b);
    const median = timings[Math.floor(timings.length / 2)] as number;
    const p95 = timings[Math.floor(timings.length * 0.95)] as number;
    console.log(`FTS search on 15k items (WASM SQLite under Jest): median ${median.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms`);
    expect(median).toBeLessThan(50);
    db.close();
  });
});
