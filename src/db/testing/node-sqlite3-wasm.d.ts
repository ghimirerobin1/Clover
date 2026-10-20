// Minimal typings for the test-only WASM SQLite driver (package ships none).
declare module 'node-sqlite3-wasm' {
  type Value = string | number | bigint | null | Uint8Array;
  export class Database {
    constructor(path?: string);
    exec(sql: string): void;
    run(sql: string, values?: Value[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    all(sql: string, values?: Value[]): Record<string, Value>[];
    get(sql: string, values?: Value[]): Record<string, Value> | null;
    close(): void;
  }
}
