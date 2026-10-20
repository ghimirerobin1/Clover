import type { RemoteItem } from '../../../api/schemas';
import { ItemRepo } from '../../../db/items';
import { WasmSqlDb } from '../../../db/testing/wasmDb';
import { LowStock } from '../LowStock';

const it_ = (id: string, qty: number | null, categoryId: string | null): RemoteItem => ({
  id, name: id, sku: null, code: null, priceCents: 100, costCents: null, categoryId, stockQty: qty, modifiedTime: 1, deleted: false,
});

describe('Low Stock (spec §4.5)', () => {
  let db: WasmSqlDb;
  beforeEach(async () => {
    db = await WasmSqlDb.migrated();
    await ItemRepo.upsertCategories(db, [
      { id: 'RICE', name: 'Rice', sortOrder: 1 },
      { id: 'BEV', name: 'Beverages', sortOrder: 2 },
    ]);
    await db.run('UPDATE categories SET low_stock_threshold = 10 WHERE id = ?', ['RICE']);
    await ItemRepo.upsertItems(
      db,
      [
        it_('rice-8', 8, 'RICE'), // category threshold 10 → low
        it_('rice-12', 12, 'RICE'), // above category 10
        it_('rice-override', 12, 'RICE'), // item override 15 → low
        it_('bev-5', 5, 'BEV'), // global 5 → low (<= is inclusive)
        it_('bev-6', 6, 'BEV'), // above global
        it_('bev-neg', -2, 'BEV'), // negative stock counts as low
        it_('loose-0', 0, null), // uncategorized, out
        it_('untracked', null, null), // not tracked → never low
        it_('bev-override-0', 3, 'BEV'), // item override 0 beats global 5 → not low
      ],
      1,
    );
    await ItemRepo.setThreshold(db, 'rice-override', 15);
    await ItemRepo.setThreshold(db, 'bev-override-0', 0);
  });
  afterEach(() => db.close());

  it('resolves item → category → global and keeps stock_qty <= threshold', async () => {
    const rows = await ItemRepo.lowStock(db, 5);
    expect(rows.map((r) => r.id).sort()).toEqual(['bev-5', 'bev-neg', 'loose-0', 'rice-8', 'rice-override']);
    expect(rows.find((r) => r.id === 'rice-8')?.threshold).toBe(10);
    expect(rows.find((r) => r.id === 'rice-override')?.threshold).toBe(15);
    expect(await ItemRepo.lowStockCount(db, 5)).toBe(5);
  });

  it('global default change moves items in and out', async () => {
    expect((await ItemRepo.lowStock(db, 6)).map((r) => r.id)).toContain('bev-6');
    expect((await ItemRepo.lowStock(db, 4)).map((r) => r.id)).not.toContain('bev-5');
    expect(await ItemRepo.lowStockCount(db, 4)).toBe(4);
  });

  it('groups by category (alphabetical, Uncategorized last), lowest stock first', async () => {
    const entries = LowStock.group(await ItemRepo.lowStock(db, 5));
    expect(entries.map((e) => (e.kind === 'header' ? `# ${e.title} (${e.count})` : e.item.id))).toEqual([
      '# Beverages (2)', 'bev-neg', 'bev-5',
      '# Rice (2)', 'rice-8', 'rice-override',
      '# Uncategorized (1)', 'loose-0',
    ]);
    expect(LowStock.stickyIndices(entries)).toEqual([0, 3, 6]);
  });

  it('tab badge text', () => {
    expect(LowStock.badge(0)).toBeUndefined();
    expect(LowStock.badge(7)).toBe('7');
    expect(LowStock.badge(250)).toBe('99+');
  });
});
