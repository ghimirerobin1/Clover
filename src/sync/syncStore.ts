import { create } from 'zustand';

import type { SyncProgress } from './CatalogSync';

export interface SyncState {
  status: 'idle' | 'syncing' | 'error';
  progress: SyncProgress | null;
  lastSyncedAt: number | null;
  error: string | null;
  /** True when the last attempt failed with a network error. */
  offline: boolean;
  /** Bumped after each successful sync/seed/clear so SQLite-backed queries refetch. */
  dataVersion: number;
}

export const useSyncStore = create<SyncState>(() => ({
  status: 'idle',
  progress: null,
  lastSyncedAt: null,
  error: null,
  offline: false,
  dataVersion: 0,
}));
