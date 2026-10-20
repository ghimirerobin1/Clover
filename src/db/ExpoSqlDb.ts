import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

import type { SqlDb, SqlValue } from './driver';
import { Migrations } from './migrations';

export class ExpoSqlDb implements SqlDb {
  constructor(private readonly db: SQLiteDatabase) {}

  exec(sql: string): Promise<void> {
    return this.db.execAsync(sql);
  }

  async run(sql: string, params: SqlValue[] = []): Promise<{ changes: number }> {
    const res = await this.db.runAsync(sql, params);
    return { changes: res.changes };
  }

  all<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    return this.db.getAllAsync<T>(sql, params);
  }

  first<T>(sql: string, params: SqlValue[] = []): Promise<T | null> {
    return this.db.getFirstAsync<T>(sql, params);
  }

  /**
   * withTransactionAsync (not the exclusive variant) because our callbacks use this same connection.
   * Other queries can interleave; CatalogSync is single-flight so only reads interleave with sync writes.
   */
  transaction(fn: () => Promise<void>): Promise<void> {
    return this.db.withTransactionAsync(fn);
  }
}

/** App-wide database handle: opened and migrated once. */
export class AppDatabase {
  private static opening: Promise<SqlDb> | null = null;

  static get(): Promise<SqlDb> {
    AppDatabase.opening ??= (async () => {
      const raw = await openDatabaseAsync('stockroom.db');
      const db = new ExpoSqlDb(raw);
      await db.exec('PRAGMA journal_mode = WAL;');
      await Migrations.run(db);
      return db;
    })();
    return AppDatabase.opening;
  }
}
