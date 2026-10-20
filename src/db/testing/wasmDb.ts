import { Database } from 'node-sqlite3-wasm';

import type { SqlDb, SqlValue } from '../driver';
import { Migrations } from '../migrations';

/** Test-only SqlDb backed by WASM SQLite (FTS5 enabled), mirroring expo-sqlite semantics. */
export class WasmSqlDb implements SqlDb {
  readonly raw = new Database();

  static async migrated(): Promise<WasmSqlDb> {
    const db = new WasmSqlDb();
    await Migrations.run(db);
    return db;
  }

  async exec(sql: string): Promise<void> {
    this.raw.exec(sql);
  }

  async run(sql: string, params: SqlValue[] = []): Promise<{ changes: number }> {
    const res = this.raw.run(sql, params);
    return { changes: Number(res.changes) };
  }

  async all<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    return this.raw.all(sql, params) as T[];
  }

  async first<T>(sql: string, params: SqlValue[] = []): Promise<T | null> {
    return (this.raw.get(sql, params) as T | null) ?? null;
  }

  async transaction(fn: () => Promise<void>): Promise<void> {
    this.raw.exec('BEGIN');
    try {
      await fn();
      this.raw.exec('COMMIT');
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    }
  }

  close(): void {
    this.raw.close();
  }
}
