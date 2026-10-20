import { memo } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Badge } from '../../components';
import type { ItemRow } from '../../db/items';
import { Money } from '../../lib/money';
import { Thresholds } from '../../lib/thresholds';

export class ItemFormat {
  static stockLabel(qty: number | null): string {
    if (qty == null) return 'Not tracked';
    return Number.isInteger(qty) ? String(qty) : qty.toFixed(2);
  }

  static identifiers(item: Pick<ItemRow, 'sku' | 'code'>): string {
    return [item.sku, item.code].filter(Boolean).join(' · ') || 'No SKU / UPC';
  }
}

export const ItemListRow = memo(function ItemListRow({ item, onPress }: { item: ItemRow; onPress: (id: string) => void }) {
  const status = Thresholds.status(item.stock_qty, item.threshold);
  const stock = ItemFormat.stockLabel(item.stock_qty);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${item.name}, ${Money.format(item.price_cents)}, stock ${stock}`}
      onPress={() => onPress(item.id)}
      className="min-h-primary flex-row items-center gap-3 border-b border-border bg-surface px-4 py-3"
    >
      <View className="flex-1 gap-0.5">
        <Text className="text-base font-medium text-text" numberOfLines={1}>
          {item.name}
        </Text>
        <Text className="text-sm text-text-muted" numberOfLines={1}>
          {ItemFormat.identifiers(item)} · {Money.format(item.price_cents)}
        </Text>
      </View>
      <Badge label={stock} tone={Thresholds.tone(status)} />
    </Pressable>
  );
});
