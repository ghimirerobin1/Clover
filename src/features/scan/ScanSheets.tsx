import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { Badge, Button } from '../../components';
import { AppDatabase } from '../../db/ExpoSqlDb';
import { ItemRepo, type ItemRow } from '../../db/items';
import { SettingsRepo } from '../../db/settings';
import type { NormalizedBarcode } from '../../lib/barcode';
import { Money } from '../../lib/money';
import { Thresholds } from '../../lib/thresholds';

class StockText {
  static label(qty: number | null): string {
    if (qty == null) return 'Not tracked';
    return Number.isInteger(qty) ? String(qty) : qty.toFixed(2);
  }
}

export function WeightedNote({ barcode }: { barcode: NormalizedBarcode }) {
  if (!barcode.variableWeight) return null;
  return (
    <View className="rounded-xl bg-accent/10 px-3 py-2" accessibilityRole="text">
      <Text className="text-sm font-semibold text-accent">Weighted item — stock tracked by unit</Text>
      <Text className="text-sm text-text-muted">
        Item code {barcode.variableWeight.itemCode} · embedded {barcode.variableWeight.embedded}
      </Text>
    </View>
  );
}

/** Found: item summary. Read-only — stock actions arrive in Milestone 4. */
export function ItemSummary({
  item,
  barcode,
  onDetails,
  onScanNext,
}: {
  item: ItemRow;
  barcode: NormalizedBarcode;
  onDetails: () => void;
  onScanNext: () => void;
}) {
  const status = Thresholds.status(item.stock_qty, item.threshold);
  return (
    <View className="gap-3" testID="item-summary">
      <Text className="text-xl font-semibold text-text">{item.name}</Text>
      <Text className="text-base text-text-muted">
        {[item.sku, item.code].filter(Boolean).join(' · ') || 'No SKU / UPC'} · {Money.format(item.price_cents)}
      </Text>
      <View className="flex-row items-center justify-between">
        <Text className="text-4xl font-bold text-text" style={{ fontVariant: ['tabular-nums'] }}>
          {StockText.label(item.stock_qty)}
        </Text>
        <Badge tone={Thresholds.tone(status)} label="Cached stock" />
      </View>
      <WeightedNote barcode={barcode} />
      <Button label="View details" size="lg" onPress={onDetails} />
      <Button label="Scan next" variant="secondary" onPress={onScanNext} />
    </View>
  );
}

export function CandidateList({ items, onPick }: { items: ItemRow[]; onPick: (item: ItemRow) => void }) {
  return (
    <View className="gap-2">
      {items.map((it) => (
        <Pressable
          key={it.id}
          accessibilityRole="button"
          accessibilityLabel={`${it.name}, ${Money.format(it.price_cents)}`}
          onPress={() => onPick(it)}
          className="min-h-touch justify-center rounded-xl border border-border bg-surface-muted px-4 py-2"
        >
          <Text className="text-base font-medium text-text">{it.name}</Text>
          <Text className="text-sm text-text-muted">
            {[it.sku, it.code].filter(Boolean).join(' · ') || 'No SKU / UPC'} · {Money.format(it.price_cents)}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

/** Inline item picker over the local catalog, used to link an unknown barcode. */
function LinkPicker({ barcode, onLinked, onCancel }: { barcode: string; onLinked: (item: ItemRow) => void; onCancel: () => void }) {
  const [search, setSearch] = useState('');
  const results = useQuery({
    queryKey: ['local', 'link-search', search],
    queryFn: async () => {
      const db = await AppDatabase.get();
      return ItemRepo.query(db, { search, limit: 20, globalThreshold: await SettingsRepo.globalThreshold(db) });
    },
    enabled: search.trim().length > 0,
  });
  const link = async (item: ItemRow) => {
    await ItemRepo.addAlias(await AppDatabase.get(), barcode, item.id);
    onLinked(item);
  };
  return (
    <View className="gap-3">
      <Text className="text-base text-text-muted">Pick the item that barcode {barcode} belongs to. Saved on this device only.</Text>
      <TextInput
        autoFocus
        accessibilityLabel="Search item to link"
        placeholder="Search name, SKU or UPC"
        value={search}
        onChangeText={setSearch}
        autoCorrect={false}
        className="min-h-touch rounded-xl border border-border bg-surface-muted px-4 text-base text-text"
      />
      <ScrollView style={{ maxHeight: 280 }}>
        <CandidateList items={results.data ?? []} onPick={(it) => void link(it)} />
      </ScrollView>
      <Button label="Back" variant="ghost" onPress={onCancel} />
    </View>
  );
}

export function NotFound({
  barcode,
  remoteError,
  canCreate,
  onSearch,
  onLinked,
  onCreate,
  onScanNext,
}: {
  barcode: NormalizedBarcode;
  remoteError: string | null;
  canCreate: boolean;
  onSearch: () => void;
  onLinked: (item: ItemRow) => void;
  onCreate: () => void;
  onScanNext: () => void;
}) {
  const [linking, setLinking] = useState(false);
  const code = barcode.gtin ?? barcode.cleaned;
  if (linking) return <LinkPicker barcode={code} onLinked={onLinked} onCancel={() => setLinking(false)} />;
  return (
    <View className="gap-3" testID="not-found">
      <Text className="text-xl font-semibold text-text">No item for {code}</Text>
      {barcode.checkDigitValid === false ? (
        <Text className="text-base text-warning">Check digit is invalid — the barcode may be misread or damaged.</Text>
      ) : null}
      {remoteError ? <Text className="text-base text-warning">Couldn’t check Clover: {remoteError}</Text> : null}
      <WeightedNote barcode={barcode} />
      <Button label="Search manually" onPress={onSearch} />
      <Button label="Link to existing item" variant="secondary" onPress={() => setLinking(true)} />
      {canCreate ? <Button label="Create in Clover" variant="secondary" onPress={onCreate} /> : null}
      <Button label="Scan next" variant="ghost" onPress={onScanNext} />
    </View>
  );
}
