import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';

import { CatalogSync } from './CatalogSync';
import { useSyncStore } from './syncStore';

/** "Synced 3 min ago" line + amber banner when offline / >1h stale + progress while syncing. */
export function SyncStatus() {
  const { status, progress, lastSyncedAt, error, offline } = useSyncStore();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const stale = CatalogSync.isStale(lastSyncedAt, now);
  return (
    <View>
      {status === 'syncing' ? (
        <View className="gap-1 px-4 py-2" accessibilityRole="progressbar" accessibilityLabel="Syncing catalog">
          <Text className="text-sm text-text-muted" style={{ fontVariant: ['tabular-nums'] }}>
            {progress?.mode === 'full' ? 'Downloading catalog' : 'Checking for changes'} · {progress?.fetched ?? 0} items
          </Text>
          <View className="h-1 overflow-hidden rounded-full bg-surface-muted">
            <View className="h-1 w-1/3 rounded-full bg-accent" />
          </View>
        </View>
      ) : (
        <Text className="px-4 py-1 text-sm text-text-muted">{CatalogSync.describe(lastSyncedAt, now)}</Text>
      )}
      {(offline || stale || status === 'error') && status !== 'syncing' ? (
        <View className="mx-4 mb-2 rounded-xl bg-warning/15 px-3 py-2" accessibilityRole="alert">
          <Text className="text-sm font-semibold text-warning">
            {offline ? 'Offline — showing saved catalog' : status === 'error' ? `Sync failed: ${error ?? ''}` : 'Catalog is more than 1 hour old'}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
