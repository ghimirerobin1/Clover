import { DEFAULT_GLOBAL_THRESHOLD } from '../lib/thresholds';
import type { SqlDb } from './driver';

export type SettingKey =
  | 'last_synced_at'
  | 'synced_through_modified'
  | 'global_low_stock_threshold'
  | 'variable_weight_prefixes'
  | 'create_items_enabled'
  /** Cached from GET /me: whether this device key carries canCreateItems. */
  | 'device_can_create'
  | 'scan_default_mode'
  | 'scan_beep'
  | 'scan_haptics'
  | 'theme';

export class SettingsRepo {
  static async get(db: SqlDb, key: SettingKey): Promise<string | null> {
    const row = await db.first<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
    return row?.value ?? null;
  }

  static async getNumber(db: SqlDb, key: SettingKey): Promise<number | null> {
    const v = await SettingsRepo.get(db, key);
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  static async set(db: SqlDb, key: SettingKey, value: string | number): Promise<void> {
    await db.run(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, String(value)],
    );
  }

  /** '1' / '0' flags; missing = fallback. */
  static async flag(db: SqlDb, key: SettingKey, fallback: boolean): Promise<boolean> {
    const v = await SettingsRepo.get(db, key);
    return v == null ? fallback : v === '1';
  }

  static async globalThreshold(db: SqlDb): Promise<number> {
    return (await SettingsRepo.getNumber(db, 'global_low_stock_threshold')) ?? DEFAULT_GLOBAL_THRESHOLD;
  }
}
