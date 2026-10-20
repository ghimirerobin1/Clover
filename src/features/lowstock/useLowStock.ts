import { useQuery } from '@tanstack/react-query';

import { AppDatabase } from '../../db/ExpoSqlDb';
import { ItemRepo } from '../../db/items';
import { SettingsRepo } from '../../db/settings';
import { useSyncStore } from '../../sync/syncStore';

export function useLowStock() {
  const dataVersion = useSyncStore((s) => s.dataVersion);
  return useQuery({
    queryKey: ['local', 'low-stock', dataVersion],
    queryFn: async () => {
      const db = await AppDatabase.get();
      return ItemRepo.lowStock(db, await SettingsRepo.globalThreshold(db));
    },
    placeholderData: (prev) => prev,
  });
}

export function useLowStockCount() {
  const dataVersion = useSyncStore((s) => s.dataVersion);
  return useQuery({
    queryKey: ['local', 'low-stock-count', dataVersion],
    queryFn: async () => {
      const db = await AppDatabase.get();
      return ItemRepo.lowStockCount(db, await SettingsRepo.globalThreshold(db));
    },
  });
}
