import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import type { CategoryRow, ItemSort } from '../../db/items';
import type { InventoryFilters } from './useItems';

const SORT_LABEL: Record<ItemSort, string> = { name: 'Name', stock_asc: 'Stock ↑', modified_desc: 'Recent' };
const SORT_NEXT: Record<ItemSort, ItemSort> = { name: 'stock_asc', stock_asc: 'modified_desc', modified_desc: 'name' };
type StockFilter = NonNullable<InventoryFilters['stockStatus']>;
const STOCK_NEXT: Record<StockFilter, StockFilter> = { all: 'low', low: 'out', out: 'ok', ok: 'all' };
const STOCK_LABEL: Record<StockFilter, string> = { all: 'All stock', low: 'Low', out: 'Out', ok: 'In stock' };

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
      onPress={onPress}
      className={`min-h-touch justify-center rounded-full border px-4 ${active ? 'border-accent bg-accent/15' : 'border-border bg-surface'}`}
    >
      <Text className={`text-base ${active ? 'font-semibold text-accent' : 'text-text'}`}>{label}</Text>
    </Pressable>
  );
}

export class FilterState {
  static toggleCategory(selected: readonly string[], id: string): string[] {
    return selected.includes(id) ? selected.filter((c) => c !== id) : [...selected, id];
  }
}

export function FilterBar({
  filters,
  categories,
  onChange,
}: {
  filters: InventoryFilters;
  categories: CategoryRow[];
  onChange: (next: InventoryFilters) => void;
}) {
  const sort = filters.sort ?? 'name';
  const stock = filters.stockStatus ?? 'all';
  const cats = filters.categoryIds ?? [];
  return (
    <View className="gap-2 border-b border-border bg-bg pb-2">
      <TextInput
        accessibilityLabel="Search items"
        placeholder="Search name, SKU or UPC"
        value={filters.search ?? ''}
        onChangeText={(search) => onChange({ ...filters, search })}
        autoCorrect={false}
        autoCapitalize="none"
        clearButtonMode="while-editing"
        className="mx-4 min-h-touch rounded-xl border border-border bg-surface px-4 text-base text-text"
      />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2 px-4">
        <Chip label={`Sort: ${SORT_LABEL[sort]}`} active={sort !== 'name'} onPress={() => onChange({ ...filters, sort: SORT_NEXT[sort] })} />
        <Chip label={STOCK_LABEL[stock]} active={stock !== 'all'} onPress={() => onChange({ ...filters, stockStatus: STOCK_NEXT[stock] })} />
        <Chip
          label="Not counted 30d"
          active={filters.notCountedDays != null}
          onPress={() => onChange({ ...filters, notCountedDays: filters.notCountedDays == null ? 30 : undefined })}
        />
        {categories.map((c) => (
          <Chip
            key={c.id}
            label={c.name}
            active={cats.includes(c.id)}
            onPress={() => onChange({ ...filters, categoryIds: FilterState.toggleCategory(cats, c.id) })}
          />
        ))}
      </ScrollView>
    </View>
  );
}
