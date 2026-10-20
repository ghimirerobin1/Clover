import { useQuery } from '@tanstack/react-query';

import { ProxyClient } from '../../api/proxy';
import { AppDatabase } from '../../db/ExpoSqlDb';
import { ItemRepo, type ItemQuery } from '../../db/items';
import { SettingsRepo } from '../../db/settings';
import { useSyncStore } from '../../sync/syncStore';

export type InventoryFilters = Omit<ItemQuery, 'globalThreshold' | 'now' | 'limit'>;

/** SQLite-backed list (never the network). Refetches when sync bumps dataVersion. */
export function useItems(filters: InventoryFilters) {
  const dataVersion = useSyncStore((s) => s.dataVersion);
  return useQuery({
    queryKey: ['local', 'items', filters, dataVersion],
    queryFn: async () => {
      const db = await AppDatabase.get();
      return ItemRepo.query(db, { ...filters, globalThreshold: await SettingsRepo.globalThreshold(db) });
    },
    placeholderData: (prev) => prev,
  });
}

export function useCategories() {
  const dataVersion = useSyncStore((s) => s.dataVersion);
  return useQuery({
    queryKey: ['local', 'categories', dataVersion],
    queryFn: async () => ItemRepo.categories(await AppDatabase.get()),
  });
}

export function useLocalItem(id: string) {
  const dataVersion = useSyncStore((s) => s.dataVersion);
  return useQuery({
    queryKey: ['local', 'item', id, dataVersion],
    queryFn: async () => {
      const db = await AppDatabase.get();
      const [item, aliases] = await Promise.all([
        ItemRepo.byId(db, id, await SettingsRepo.globalThreshold(db)),
        ItemRepo.aliases(db, id),
      ]);
      return { item, aliases };
    },
  });
}

/** Fresh read through the proxy (always hits Clover). */
export function useFreshItem(id: string) {
  return useQuery({
    queryKey: ['remote', 'item', id],
    queryFn: () => ProxyClient.item(id),
    staleTime: 0,
    gcTime: 0,
    retry: 1,
  });
}
