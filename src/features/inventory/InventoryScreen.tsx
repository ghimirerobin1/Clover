import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { useCallback, useDeferredValue, useState } from 'react';
import { RefreshControl, View } from 'react-native';

import { EmptyState, Skeleton } from '../../components';
import type { ItemRow } from '../../db/items';
import { SyncController } from '../../sync/SyncController';
import { SyncStatus } from '../../sync/SyncStatus';
import { useSyncStore } from '../../sync/syncStore';
import { FilterBar } from './FilterBar';
import { ItemListRow } from './ItemListRow';
import { useCategories, useItems, type InventoryFilters } from './useItems';

export function InventoryScreen({ initialSearch }: { initialSearch?: string } = {}) {
  const router = useRouter();
  const [filters, setFilters] = useState<InventoryFilters>({ sort: 'name', stockStatus: 'all', search: initialSearch });
  const deferred = useDeferredValue(filters);
  const items = useItems(deferred);
  const categories = useCategories();
  const syncing = useSyncStore((s) => s.status === 'syncing');
  const onPress = useCallback((id: string) => router.push({ pathname: '/item/[id]', params: { id } }), [router]);
  const renderItem = useCallback(({ item }: { item: ItemRow }) => <ItemListRow item={item} onPress={onPress} />, [onPress]);
  const filtering = Boolean(filters.search) || (filters.categoryIds?.length ?? 0) > 0 || filters.stockStatus !== 'all' || filters.notCountedDays != null;

  return (
    <View className="flex-1 bg-bg">
      <SyncStatus />
      <FilterBar filters={filters} categories={categories.data ?? []} onChange={setFilters} />
      {items.isPending ? (
        <View className="p-4">
          <Skeleton lines={8} height={48} />
        </View>
      ) : items.isError ? (
        <View className="flex-1">
          <EmptyState title="Couldn't read the local catalog" message={String(items.error)} actionLabel="Retry" onAction={() => void items.refetch()} />
        </View>
      ) : (
        <FlashList
          data={items.data}
          keyExtractor={(i) => i.id}
          renderItem={renderItem}
          refreshControl={<RefreshControl refreshing={syncing} onRefresh={() => void SyncController.sync()} />}
          ListEmptyComponent={
            filtering ? (
              <EmptyState title="No matching items" message="Try a different search or clear filters." actionLabel="Clear filters" onAction={() => setFilters({ sort: 'name', stockStatus: 'all' })} />
            ) : (
              <EmptyState title="No items yet" message="Pair this device in Settings, then sync the catalog." actionLabel="Sync now" onAction={() => void SyncController.sync()} />
            )
          }
        />
      )}
    </View>
  );
}
