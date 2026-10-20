/**
 * Minimal async SQL interface. The app uses expo-sqlite through `ExpoSqlDb`; tests use a
 * WASM SQLite with FTS5 (`src/db/__tests__/wasmDb.ts`) so the same queries run under Jest.
 */
export type SqlValue = string | number | null;

export interface SqlDb {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: SqlValue[]): Promise<{ changes: number }>;
  all<T>(sql: string, params?: SqlValue[]): Promise<T[]>;
  first<T>(sql: string, params?: SqlValue[]): Promise<T | null>;
  /** Runs fn atomically. Must not be nested. */
  transaction(fn: () => Promise<void>): Promise<void>;
}
