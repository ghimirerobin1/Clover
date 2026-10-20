import type { RemoteCategory, RemoteItem } from '../api/schemas';
import type { StockStatus } from '../lib/thresholds';
import type { SqlDb, SqlValue } from './driver';
import { FtsQuery } from './fts';

export const WRITE_CHUNK = 500;
const DAY_MS = 86_400_000;

export interface ItemRow {
  id: string;
  name: string;
  sku: string | null;
  code: string | null;
  price_cents: number;
  cost_cents: number | null;
  category_id: string | null;
  category_name: string | null;
  stock_qty: number | null;
  low_stock_threshold: number | null;
  category_threshold: number | null;
  /** Resolved threshold: item → category → global (computed in SQL). */
  threshold: number;
  modified_time: number;
  synced_at: number;
  last_counted_at: number | null;
}

export interface CategoryRow {
  id: string;
  name: string;
  sort_order: number | null;
  low_stock_threshold: number | null;
}

export type ItemSort = 'name' | 'stock_asc' | 'modified_desc';

export interface ItemQuery {
  search?: string;
  categoryIds?: string[];
  stockStatus?: Exclude<StockStatus, 'untracked'> | 'all';
  /** Only items never counted or not counted within this many days. */
  notCountedDays?: number;
  sort?: ItemSort;
  limit?: number;
  globalThreshold: number;
  now?: number;
}

const SELECT = `
  SELECT i.id, i.name, i.sku, i.code, i.price_cents, i.cost_cents, i.category_id, c.name AS category_name,
         i.stock_qty, i.low_stock_threshold, c.low_stock_threshold AS category_threshold,
         COALESCE(i.low_stock_threshold, c.low_stock_threshold, ?) AS threshold,
         i.modified_time, i.synced_at, i.last_counted_at
  FROM items i LEFT JOIN categories c ON c.id = i.category_id`;

const LOW_STOCK_WHERE = 'i.stock_qty IS NOT NULL AND i.stock_qty <= COALESCE(i.low_stock_threshold, c.low_stock_threshold, ?)';

const ORDER: Record<ItemSort, string> = {
  name: 'i.name COLLATE NOCASE ASC',
  stock_asc: 'i.stock_qty IS NULL, i.stock_qty ASC, i.name COLLATE NOCASE ASC',
  modified_desc: 'i.modified_time DESC',
};

/** All list/search/filter reads come from here — never from the network (spec §4.2). */
export class ItemRepo {
  static async upsertItems(db: SqlDb, items: readonly RemoteItem[], syncedAt: number): Promise<void> {
    for (let i = 0; i < items.length; i += WRITE_CHUNK) {
      const chunk = items.slice(i, i + WRITE_CHUNK);
      await db.transaction(async () => {
        for (const it of chunk) {
          if (it.deleted) {
            await db.run('DELETE FROM items WHERE id = ?', [it.id]);
            continue;
          }
          await db.run(
            `INSERT INTO items (id, name, sku, code, price_cents, cost_cents, category_id, stock_qty, modified_time, synced_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name, sku = excluded.sku, code = excluded.code,
               price_cents = excluded.price_cents, cost_cents = excluded.cost_cents,
               category_id = excluded.category_id, stock_qty = excluded.stock_qty,
               modified_time = excluded.modified_time, synced_at = excluded.synced_at`,
            [it.id, it.name, it.sku, it.code, it.priceCents, it.costCents, it.categoryId, it.stockQty, it.modifiedTime, syncedAt],
          );
        }
      });
    }
  }

  /** After a full sync: anything not touched by this sync no longer exists in Clover. */
  static async deleteSyncedBefore(db: SqlDb, syncedAt: number): Promise<number> {
    return (await db.run('DELETE FROM items WHERE synced_at < ?', [syncedAt])).changes;
  }

  static async upsertCategories(db: SqlDb, cats: readonly RemoteCategory[]): Promise<void> {
    await db.transaction(async () => {
      for (const c of cats) {
        await db.run(
          `INSERT INTO categories (id, name, sort_order) VALUES (?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, sort_order = excluded.sort_order`,
          [c.id, c.name, c.sortOrder],
        );
      }
      const ids = cats.map((c) => c.id);
      await db.run(
        `DELETE FROM categories WHERE id NOT IN (${ids.map(() => '?').join(',') || "''"})`,
        ids,
      );
    });
  }

  static async query(db: SqlDb, q: ItemQuery): Promise<ItemRow[]> {
    const where: string[] = [];
    const params: SqlValue[] = [q.globalThreshold];
    const match = q.search ? FtsQuery.build(q.search) : null;
    if (match) {
      where.push('i.rowid IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)');
      params.push(match);
    }
    if (q.categoryIds && q.categoryIds.length > 0) {
      where.push(`i.category_id IN (${q.categoryIds.map(() => '?').join(',')})`);
      params.push(...q.categoryIds);
    }
    const threshold = 'COALESCE(i.low_stock_threshold, c.low_stock_threshold, ?)';
    if (q.stockStatus === 'out') where.push('i.stock_qty IS NOT NULL AND i.stock_qty <= 0');
    if (q.stockStatus === 'low') {
      where.push(`i.stock_qty > 0 AND i.stock_qty <= ${threshold}`);
      params.push(q.globalThreshold);
    }
    if (q.stockStatus === 'ok') {
      where.push(`i.stock_qty > ${threshold}`);
      params.push(q.globalThreshold);
    }
    if (q.notCountedDays != null) {
      where.push('(i.last_counted_at IS NULL OR i.last_counted_at < ?)');
      params.push((q.now ?? Date.now()) - q.notCountedDays * DAY_MS);
    }
    const sql = `${SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ${ORDER[q.sort ?? 'name']} LIMIT ?`;
    params.push(q.limit ?? 50_000);
    return db.all<ItemRow>(sql, params);
  }

  /** Low Stock (spec §4.5): tracked items with stock_qty <= resolved threshold, grouped-ready (category, then lowest stock). */
  static async lowStock(db: SqlDb, globalThreshold: number): Promise<ItemRow[]> {
    return db.all<ItemRow>(
      `${SELECT} WHERE ${LOW_STOCK_WHERE}
       ORDER BY c.name IS NULL, c.name COLLATE NOCASE, i.stock_qty ASC, i.name COLLATE NOCASE`,
      [globalThreshold, globalThreshold],
    );
  }

  static async lowStockCount(db: SqlDb, globalThreshold: number): Promise<number> {
    const row = await db.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM items i LEFT JOIN categories c ON c.id = i.category_id WHERE ${LOW_STOCK_WHERE}`,
      [globalThreshold],
    );
    return row?.n ?? 0;
  }

  static async byId(db: SqlDb, id: string, globalThreshold: number): Promise<ItemRow | null> {
    return db.first<ItemRow>(`${SELECT} WHERE i.id = ?`, [globalThreshold, id]);
  }

  static async count(db: SqlDb): Promise<number> {
    return (await db.first<{ n: number }>('SELECT COUNT(*) AS n FROM items'))?.n ?? 0;
  }

  static async categories(db: SqlDb): Promise<CategoryRow[]> {
    return db.all<CategoryRow>('SELECT * FROM categories ORDER BY sort_order IS NULL, sort_order, name');
  }

  static async aliases(db: SqlDb, itemId: string): Promise<string[]> {
    const rows = await db.all<{ barcode: string }>('SELECT barcode FROM barcode_aliases WHERE item_id = ? ORDER BY barcode', [itemId]);
    return rows.map((r) => r.barcode);
  }

  /** Exact match on Clover `code` for any of the candidate forms. */
  static async findByCodes(db: SqlDb, codes: readonly string[], globalThreshold: number): Promise<ItemRow[]> {
    if (codes.length === 0) return [];
    return db.all<ItemRow>(`${SELECT} WHERE i.code IN (${codes.map(() => '?').join(',')}) ORDER BY i.name`, [
      globalThreshold,
      ...codes,
    ]);
  }

  static async findBySku(db: SqlDb, sku: string, globalThreshold: number): Promise<ItemRow[]> {
    if (!sku) return [];
    return db.all<ItemRow>(`${SELECT} WHERE i.sku = ? COLLATE NOCASE ORDER BY i.name`, [globalThreshold, sku]);
  }

  static async findByAliases(db: SqlDb, codes: readonly string[], globalThreshold: number): Promise<ItemRow[]> {
    if (codes.length === 0) return [];
    return db.all<ItemRow>(
      `${SELECT} WHERE i.id IN (SELECT item_id FROM barcode_aliases WHERE barcode IN (${codes.map(() => '?').join(',')}))
       ORDER BY i.name`,
      [globalThreshold, ...codes],
    );
  }

  /** Local-only alias (spec §4.3 "Link to existing item"). Re-linking a barcode moves it. */
  static async addAlias(db: SqlDb, barcode: string, itemId: string): Promise<void> {
    if (!barcode) throw new RangeError('barcode is required');
    await db.run(
      'INSERT INTO barcode_aliases (barcode, item_id) VALUES (?, ?) ON CONFLICT(barcode) DO UPDATE SET item_id = excluded.item_id',
      [barcode, itemId],
    );
  }

  /** Optimistic local update after a confirmed write (or a fresher live read). */
  static async setLocalStock(db: SqlDb, itemId: string, qty: number, opts: { countedAt?: number } = {}): Promise<void> {
    if (opts.countedAt != null) {
      await db.run('UPDATE items SET stock_qty = ?, last_counted_at = ? WHERE id = ?', [qty, opts.countedAt, itemId]);
    } else {
      await db.run('UPDATE items SET stock_qty = ? WHERE id = ?', [qty, itemId]);
    }
  }

  /** Per-item threshold override; local only (not written to Clover). null clears it. */
  static async setThreshold(db: SqlDb, itemId: string, threshold: number | null): Promise<void> {
    if (threshold != null && (!Number.isInteger(threshold) || threshold < 0)) {
      throw new RangeError('threshold must be a non-negative integer');
    }
    await db.run('UPDATE items SET low_stock_threshold = ? WHERE id = ?', [threshold, itemId]);
  }

  static async setCategoryThreshold(db: SqlDb, categoryId: string, threshold: number | null): Promise<void> {
    if (threshold != null && (!Number.isInteger(threshold) || threshold < 0)) {
      throw new RangeError('threshold must be a non-negative integer');
    }
    await db.run('UPDATE categories SET low_stock_threshold = ? WHERE id = ?', [threshold, categoryId]);
  }

  static async clear(db: SqlDb): Promise<void> {
    await db.exec("DELETE FROM items; DELETE FROM categories; DELETE FROM barcode_aliases; INSERT INTO items_fts(items_fts) VALUES ('rebuild');");
  }
}
