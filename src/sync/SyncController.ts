import { ProxyClient } from '../api/proxy';
import { AppDatabase } from '../db/ExpoSqlDb';
import { SettingsRepo } from '../db/settings';
import { ApiError } from '../lib/errors';
import { CatalogSync, type CatalogSource } from './CatalogSync';
import { useSyncStore } from './syncStore';

const proxySource: CatalogSource = {
  items: (p) => ProxyClient.items(p),
  categories: () => ProxyClient.categories(),
};

/** Glue between CatalogSync, the app database, and the zustand sync store. */
export class SyncController {
  static async hydrate(): Promise<void> {
    const db = await AppDatabase.get();
    useSyncStore.setState({ lastSyncedAt: await SettingsRepo.getNumber(db, 'last_synced_at') });
  }

  static async sync(opts: { full?: boolean } = {}): Promise<void> {
    const db = await AppDatabase.get();
    useSyncStore.setState({ status: 'syncing', error: null });
    try {
      const res = await CatalogSync.run(db, proxySource, {
        full: opts.full,
        onProgress: (progress) => useSyncStore.setState({ progress }),
      });
      useSyncStore.setState((s) => ({
        status: 'idle',
        progress: null,
        offline: false,
        lastSyncedAt: res.syncedAt,
        dataVersion: s.dataVersion + 1,
      }));
    } catch (e) {
      const offline = e instanceof ApiError && e.code === 'NETWORK';
      const message = e instanceof ApiError ? e.message : 'Sync failed';
      useSyncStore.setState({ status: 'error', progress: null, error: message, offline });
    }
  }

  static bumpData(): void {
    useSyncStore.setState((s) => ({ dataVersion: s.dataVersion + 1 }));
  }
}
