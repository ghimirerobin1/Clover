import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { Text, View } from 'react-native';

import { Button, EmptyState, Skeleton } from '../../components';
import { ItemListRow } from '../inventory';
import { StockSheetController } from '../stock';
import { LowStock, type LowStockEntry } from './LowStock';
import { useLowStock } from './useLowStock';

export function LowStockScreen() {
  const router = useRouter();
  const q = useLowStock();
  if (q.isPending) {
    return (
      <View className="flex-1 bg-bg p-4">
        <Skeleton lines={6} height={56} />
      </View>
    );
  }
  const entries = LowStock.group(q.data ?? []);
  if (entries.length === 0) {
    return (
      <View className="flex-1 bg-bg">
        <EmptyState title="Nothing low on stock" message="Items at or below their threshold show up here, grouped by category." />
      </View>
    );
  }
  const open = (id: string) => router.push({ pathname: '/item/[id]', params: { id } });
  return (
    <View className="flex-1 bg-bg">
      <FlashList<LowStockEntry>
        data={entries}
        keyExtractor={(e) => e.key}
        getItemType={(e) => e.kind}
        stickyHeaderIndices={LowStock.stickyIndices(entries)}
        renderItem={({ item: e }) =>
          e.kind === 'header' ? (
            <View className="border-b border-border bg-surface-muted px-4 py-2" accessibilityRole="header">
              <Text className="text-sm font-semibold uppercase text-text-muted">
                {e.title} · {e.count}
              </Text>
            </View>
          ) : (
            <View className="flex-row items-center bg-surface">
              <View className="flex-1">
                <ItemListRow item={e.item} onPress={open} />
              </View>
              <View className="border-b border-border py-3 pr-3">
                <Button
                  label="Receive"
                  variant="secondary"
                  accessibilityHint={`Receive stock for ${e.item.name}`}
                  onPress={() => StockSheetController.open({ itemId: e.item.id, mode: 'edit', action: 'receive' })}
                />
              </View>
            </View>
          )
        }
      />
    </View>
  );
}
