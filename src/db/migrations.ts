import type { SqlDb } from './driver';

/**
 * Versioned migrations tracked with PRAGMA user_version. Append only — never edit a shipped step.
 */
const STEPS: readonly string[] = [
  // v1 — catalog schema (spec §4.2)
  `
  CREATE TABLE items (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    sku TEXT,
    code TEXT,
    price_cents INTEGER NOT NULL,
    cost_cents INTEGER,
    category_id TEXT,
    stock_qty REAL,
    low_stock_threshold INTEGER,
    modified_time INTEGER NOT NULL,
    synced_at INTEGER NOT NULL,
    last_counted_at INTEGER
  );
  CREATE INDEX items_code ON items (code);
  CREATE INDEX items_sku ON items (sku);
  CREATE INDEX items_category ON items (category_id);
  CREATE INDEX items_stock ON items (stock_qty);
  CREATE INDEX items_modified ON items (modified_time);

  CREATE VIRTUAL TABLE items_fts USING fts5(
    name, sku, code,
    content = 'items', content_rowid = 'rowid',
    tokenize = 'unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN
    INSERT INTO items_fts (rowid, name, sku, code) VALUES (new.rowid, new.name, new.sku, new.code);
  END;
  CREATE TRIGGER items_ad AFTER DELETE ON items BEGIN
    INSERT INTO items_fts (items_fts, rowid, name, sku, code) VALUES ('delete', old.rowid, old.name, old.sku, old.code);
  END;
  CREATE TRIGGER items_au AFTER UPDATE OF name, sku, code ON items BEGIN
    INSERT INTO items_fts (items_fts, rowid, name, sku, code) VALUES ('delete', old.rowid, old.name, old.sku, old.code);
    INSERT INTO items_fts (rowid, name, sku, code) VALUES (new.rowid, new.name, new.sku, new.code);
  END;

  CREATE TABLE categories (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    sort_order INTEGER,
    low_stock_threshold INTEGER
  );

  CREATE TABLE barcode_aliases (
    barcode TEXT PRIMARY KEY NOT NULL,
    item_id TEXT NOT NULL
  );
  CREATE INDEX barcode_aliases_item ON barcode_aliases (item_id);

  CREATE TABLE stock_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id TEXT NOT NULL,
    action TEXT NOT NULL,
    before_qty REAL,
    after_qty REAL,
    reason TEXT,
    status TEXT NOT NULL,
    client_mutation_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX stock_changes_item ON stock_changes (item_id);

  CREATE TABLE settings (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  );
  `,
];

export class Migrations {
  static readonly latest = STEPS.length;

  static async run(db: SqlDb): Promise<number> {
    const row = await db.first<{ user_version: number }>('PRAGMA user_version');
    const current = row?.user_version ?? 0;
    for (let v = current; v < STEPS.length; v++) {
      await db.transaction(async () => {
        await db.exec(STEPS[v] as string);
        await db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
    return STEPS.length;
  }
}
