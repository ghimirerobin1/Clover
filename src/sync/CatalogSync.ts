import type { ItemPage, RemoteCategory } from '../api/schemas';
import type { SqlDb } from '../db/driver';
import { ItemRepo } from '../db/items';
import { SettingsRepo } from '../db/settings';

/** What the sync engine needs from the network; ProxyClient satisfies it, tests pass fakes. */
export interface CatalogSource {
  items(params: { limit: number; offset: number; modifiedSince?: number }): Promise<ItemPage>;
  categories(): Promise<RemoteCategory[]>;
}

export interface SyncProgress {
  mode: 'full' | 'delta';
  fetched: number;
}

export interface SyncResult {
  mode: 'full' | 'delta';
  fetched: number;
  deleted: number;
  syncedAt: number;
}

export const STALE_AFTER_MS = 60 * 60 * 1000;
export const DELTA_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Catalog sync (spec §4.2). Full sync on first run, then delta via `modifiedSince`.
 * The cursor is the max Clover `modifiedTime` seen (server clock), never the device clock,
 * so device clock skew cannot cause missed updates.
 */
export class CatalogSync {
  // VERIFY: Clover max page size (assumed 1000).
  static readonly PAGE_SIZE = 1000;
  private static inFlight: Promise<SyncResult> | null = null;

  /** Single-flight: concurrent callers share the running sync. */
  static run(
    db: SqlDb,
    source: CatalogSource,
    opts: { full?: boolean; onProgress?: (p: SyncProgress) => void; now?: () => number } = {},
  ): Promise<SyncResult> {
    CatalogSync.inFlight ??= CatalogSync.execute(db, source, opts).finally(() => {
      CatalogSync.inFlight = null;
    });
    return CatalogSync.inFlight;
  }

  private static async execute(
    db: SqlDb,
    source: CatalogSource,
    opts: { full?: boolean; onProgress?: (p: SyncProgress) => void; now?: () => number },
  ): Promise<SyncResult> {
    const now = opts.now ?? Date.now;
    const cursor = await SettingsRepo.getNumber(db, 'synced_through_modified');
    const mode: 'full' | 'delta' = opts.full || cursor == null ? 'full' : 'delta';
    const syncedAt = now();

    await ItemRepo.upsertCategories(db, await source.categories());

    let offset = 0;
    let fetched = 0;
    let maxModified = cursor ?? 0;
    opts.onProgress?.({ mode, fetched });
    for (;;) {
      const page = await source.items({
        limit: CatalogSync.PAGE_SIZE,
        offset,
        ...(mode === 'delta' ? { modifiedSince: cursor ?? 0 } : {}),
      });
      await ItemRepo.upsertItems(db, page.items, syncedAt);
      for (const it of page.items) maxModified = Math.max(maxModified, it.modifiedTime);
      fetched += page.items.length;
      offset += page.items.length;
      opts.onProgress?.({ mode, fetched });
      if (!page.hasMore || page.items.length === 0) break;
    }

    const deleted = mode === 'full' ? await ItemRepo.deleteSyncedBefore(db, syncedAt) : 0;
    // Cursor only advances after every page succeeded; a failure mid-way re-fetches next time.
    await SettingsRepo.set(db, 'synced_through_modified', maxModified);
    await SettingsRepo.set(db, 'last_synced_at', syncedAt);
    return { mode, fetched, deleted, syncedAt };
  }

  static isStale(lastSyncedAt: number | null, now = Date.now()): boolean {
    return lastSyncedAt == null || now - lastSyncedAt > STALE_AFTER_MS;
  }

  /** "Synced just now" / "Synced 3 min ago" / "Synced 2 h ago" / "Never synced". */
  static describe(lastSyncedAt: number | null, now = Date.now()): string {
    if (lastSyncedAt == null) return 'Never synced';
    const mins = Math.floor(Math.max(0, now - lastSyncedAt) / 60_000);
    if (mins < 1) return 'Synced just now';
    if (mins < 60) return `Synced ${mins} min ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 48) return `Synced ${hours} h ago`;
    return `Synced ${Math.floor(hours / 24)} d ago`;
  }
}
