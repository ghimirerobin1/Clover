import Constants from 'expo-constants';
import { Appearance } from 'react-native';

import type { SqlDb } from '../../db/driver';
import { SettingsRepo } from '../../db/settings';
import { Barcode } from '../../lib/barcode';

export type ThemePref = 'system' | 'light' | 'dark';
export const THEMES: readonly ThemePref[] = ['system', 'light', 'dark'];

/** Settings that are plain local preferences (spec §4.8). */
export class AppPrefs {
  static async theme(db: SqlDb): Promise<ThemePref> {
    const v = await SettingsRepo.get(db, 'theme');
    return v === 'light' || v === 'dark' ? v : 'system';
  }

  /** NativeWind's `dark:` variants and our tokens follow the RN appearance, so overriding it themes everything. */
  static applyTheme(t: ThemePref): void {
    Appearance.setColorScheme(t === 'system' ? 'unspecified' : t);
  }

  static async setTheme(db: SqlDb, t: ThemePref): Promise<void> {
    await SettingsRepo.set(db, 'theme', t);
    AppPrefs.applyTheme(t);
  }

  /** Global default threshold: whole number 0–9999, or null if the text isn't one. */
  static parseThreshold(text: string): number | null {
    const t = text.trim();
    if (!/^\d{1,4}$/.test(t)) return null;
    return Number(t);
  }

  /** Normalizes the variable-weight prefix text; null if it contains no valid prefix. */
  static parsePrefixes(text: string): string | null {
    const tokens = text.split(/[\s,]+/).filter(Boolean);
    if (tokens.length === 0 || tokens.some((p) => !/^\d{1,3}$/.test(p))) return null;
    return Barcode.parseRule(tokens.join(',')).prefixes.join(', ');
  }

  static version(): { version: string; build: string } {
    const cfg = Constants.expoConfig;
    const build = cfg?.ios?.buildNumber ?? (cfg?.android?.versionCode != null ? String(cfg.android.versionCode) : null);
    return { version: cfg?.version ?? '0.0.0', build: build ?? 'dev' };
  }
}
