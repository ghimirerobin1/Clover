/**
 * Performance pass (spec §6) on the box: `PERF=1 npx jest src/perf`. Skipped in the normal suite.
 * Runs the app's real SQL/FTS/sync/lookup code against SQLite compiled to WASM under Node — NOT the
 * device's native SQLite, so treat numbers as a relative baseline; device numbers are listed separately.
 */
import { writeFileSync } from 'fs';

import type { ItemPage, RemoteItem } from '../../api/schemas';
import { ItemRepo } from '../../db/items';
import { Seeder } from '../../db/seed';
import { WasmSqlDb } from '../../db/testing/wasmDb';
import { LookupChain } from '../../features/scan/LookupChain';
import { LowStock } from '../../features/lowstock/LowStock';
import { Barcode } from '../../lib/barcode';
import { CatalogSync } from '../../sync/CatalogSync';

const run = process.env.PERF === '1' ? describe : describe.skip;
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return +(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0).toFixed(2);
};
const time = async <T,>(fn: () => Promise<T>): Promise<[number, T]> => {
  const t0 = performance.now();
  const r = await fn();
  return [performance.now() - t0, r];
};
const results: Record<string, unknown> = {};

run('performance (spec §6)', () => {
  jest.setTimeout(600_000);
  let db: WasmSqlDb;
  beforeAll(async () => {
    db = await WasmSqlDb.migrated();
  });
  afterAll(() => {
    db.close();
    console.log(JSON.stringify(results, null, 2));
    if (process.env.PERF_OUT) writeFileSync(process.env.PERF_OUT, JSON.stringify(results, null, 2));
  });

  it('seed 15,000 items (dev button path)', async () => {
    const [ms] = await time(() => Seeder.seed(db, 15_000, 1));
    results.seed15kMs = Math.round(ms);
    expect(await ItemRepo.count(db)).toBe(15_000);
  });

  it('search keystrokes on 15k (target < 50 ms)', async () => {
    const keystrokes = ['j', 'ja', 'jas', 'jasm', 'jas r', 'jas ri', 'jas ric', 'u', 'ud', 'udon', 'udon 5', '900000001', 'seed-14', 'matcha t'];
    const timings: number[] = [];
    for (let round = 0; round < 5; round++) {
      for (const search of keystrokes) timings.push((await time(() => ItemRepo.query(db, { search, globalThreshold: 5, limit: 200 })))[0]);
    }
    results.search15k = { n: timings.length, p50Ms: pct(timings, 50), p95Ms: pct(timings, 95), maxMs: pct(timings, 100) };
    expect(pct(timings, 50)).toBeLessThan(50);
  });

  it('inventory list queries on 15k', async () => {
    const t: Record<string, number> = {};
    for (const [name, q] of [
      ['allByName', { sort: 'name' as const }],
      ['stockAsc', { sort: 'stock_asc' as const }],
      ['lowFilter', { stockStatus: 'low' as const }],
      ['notCounted30d', { notCountedDays: 30, now: 2 }],
    ] as const) {
      const [ms, rows] = await time(() => ItemRepo.query(db, { ...q, globalThreshold: 5 }));
      t[`${name}Ms`] = Math.round(ms);
      t[`${name}Rows`] = rows.length;
    }
    const [lowMs, low] = await time(() => ItemRepo.lowStock(db, 5));
    const [countMs] = await time(() => ItemRepo.lowStockCount(db, 5));
    const g0 = performance.now();
    LowStock.group(low);
    t.lowStockMs = Math.round(lowMs);
    t.lowStockRows = low.length;
    t.lowStockCountMs = +countMs.toFixed(2);
    t.lowStockGroupMs = +(performance.now() - g0).toFixed(2);
    results.list15k = t;
  });

  it('scan → item resolved from cache (target sheet < 300 ms)', async () => {
    const remote = { lookup: async () => ({ match: null, candidates: [] }) };
    const rule = Barcode.parseRule('2');
    const timings: number[] = [];
    for (let i = 0; i < 200; i++) {
      const code = (900000000000 + ((i * 73) % 15_000)).toString();
      const [ms, out] = await time(() => LookupChain.resolve(db, remote, code, { rule, globalThreshold: 5 }));
      expect(out.kind).toBe('found');
      timings.push(ms);
    }
    results.scanLookup15k = { n: timings.length, p50Ms: pct(timings, 50), p95Ms: pct(timings, 95) };
  });

  it('initial full sync of 10k (client side, pages of 1000, no network)', async () => {
    const fresh = await WasmSqlDb.migrated();
    const all: RemoteItem[] = Seeder.fakeItems(10_000, 7);
    const source = {
      categories: async () => [],
      items: async (p: { limit: number; offset: number }): Promise<ItemPage> => ({
        items: all.slice(p.offset, p.offset + p.limit),
        offset: p.offset,
        limit: p.limit,
        hasMore: p.offset + p.limit < all.length,
      }),
    };
    const [ms, res] = await time(() => CatalogSync.run(fresh, source, { full: true }));
    results.fullSync10kClientMs = Math.round(ms);
    expect(res.fetched).toBe(10_000);
    fresh.close();
  });
});
