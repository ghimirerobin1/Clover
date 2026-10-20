import { useQueryClient } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';

import { Badge, Button, EmptyState, Skeleton } from '../../components';
import { AppDatabase } from '../../db/ExpoSqlDb';
import { ItemRepo } from '../../db/items';
import { ApiError } from '../../lib/errors';
import { Money } from '../../lib/money';
import { Thresholds } from '../../lib/thresholds';
import { SyncController } from '../../sync/SyncController';
import { AuditRow, useAudit } from '../activity';
import { ACTION_LABEL, StockSheetController } from '../stock';
import { ItemFormat } from './ItemListRow';
import { useFreshItem, useLocalItem } from './useItems';

function Field({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row justify-between gap-4 py-2">
      <Text className="text-base text-text-muted">{label}</Text>
      <Text className="flex-1 text-right text-base text-text" selectable>
        {value}
      </Text>
    </View>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View className="gap-1 rounded-2xl border border-border bg-surface p-4">
      <Text accessibilityRole="header" className="mb-1 text-lg font-semibold text-text">
        {title}
      </Text>
      {children}
    </View>
  );
}

export class ThresholdInput {
  /** "" → null (clear override); otherwise a non-negative integer or undefined if invalid. */
  static parse(text: string): number | null | undefined {
    const t = text.trim();
    if (t === '') return null;
    return /^\d{1,6}$/.test(t) ? Number(t) : undefined;
  }
}

/** Stock history from the server audit log (all devices). */
function StockHistory({ itemId }: { itemId: string }) {
  const audit = useAudit({ itemId, limit: 20 });
  if (audit.isPending) return <Skeleton lines={3} height={40} />;
  if (audit.isError) {
    return (
      <View className="gap-2">
        <Text className="text-base text-text-muted">Couldn’t load history (offline?).</Text>
        <Button label="Retry" variant="secondary" onPress={() => void audit.refetch()} />
      </View>
    );
  }
  if (audit.data.entries.length === 0) return <Text className="text-base text-text-muted">No stock changes recorded yet.</Text>;
  return (
    <View className="-mx-4">
      {audit.data.entries.map((e) => (
        <AuditRow key={e.id} entry={e} showItem={false} />
      ))}
    </View>
  );
}

export function ItemDetailScreen({ id }: { id: string }) {
  const local = useLocalItem(id);
  const fresh = useFreshItem(id);
  const qc = useQueryClient();
  const [thresholdText, setThresholdText] = useState<string | null>(null);

  if (local.isPending) {
    return (
      <View className="flex-1 bg-bg p-4">
        <Skeleton lines={6} height={28} />
      </View>
    );
  }
  const item = local.data?.item;
  const aliases = local.data?.aliases ?? [];
  if (!item) {
    return <EmptyState title="Item not in local catalog" message="It may have been deleted in Clover." actionLabel="Sync now" onAction={() => void SyncController.sync()} />;
  }

  const liveQty = fresh.data ? fresh.data.stockQty : null;
  const qty = fresh.data ? liveQty : item.stock_qty;
  const status = Thresholds.status(qty, item.threshold);
  const parsed = ThresholdInput.parse(thresholdText ?? '');
  const saveThreshold = async () => {
    if (parsed === undefined) return;
    await ItemRepo.setThreshold(await AppDatabase.get(), id, parsed);
    setThresholdText(null);
    SyncController.bumpData();
    await qc.invalidateQueries({ queryKey: ['local'] });
  };
  const margin = item.cost_cents != null ? Money.marginBps(item.price_cents, item.cost_cents) : null;

  return (
    <ScrollView className="flex-1 bg-bg" contentContainerClassName="gap-4 p-4">
      <Stack.Screen options={{ title: item.name }} />
      <Card title="Stock">
        <View className="flex-row items-end justify-between">
          <Text className="text-5xl font-bold text-text" style={{ fontVariant: ['tabular-nums'] }} accessibilityLabel={`Stock ${ItemFormat.stockLabel(qty)}`}>
            {ItemFormat.stockLabel(qty)}
          </Text>
          <Badge tone={Thresholds.tone(status)} label={fresh.data ? 'Live from Clover' : fresh.isFetching ? 'Checking Clover…' : 'Cached, may be stale'} />
        </View>
        {fresh.isError ? (
          <Text className="text-sm text-warning">
            {fresh.error instanceof ApiError ? fresh.error.message : 'Could not reach Clover'} — showing cached value.
          </Text>
        ) : null}
        <Text className="text-sm text-text-muted">Low-stock threshold: {item.threshold}</Text>
        <View className="mt-2 flex-row gap-2">
          {(['receive', 'count', 'adjust'] as const).map((action) => (
            <View key={action} className="flex-1">
              <Button
                label={ACTION_LABEL[action]}
                variant={action === 'receive' ? 'primary' : 'secondary'}
                onPress={() => StockSheetController.open({ itemId: id, mode: 'edit', action })}
              />
            </View>
          ))}
        </View>
      </Card>

      <Card title="Details">
        <Field label="Price" value={Money.format(item.price_cents)} />
        <Field label="SKU" value={item.sku ?? '—'} />
        <Field label="UPC / code" value={item.code ?? '—'} />
        <Field label="Category" value={item.category_name ?? '—'} />
        <Field label="Modified in Clover" value={new Date(item.modified_time).toLocaleString()} />
        <Field label="Last synced" value={new Date(item.synced_at).toLocaleString()} />
        <Field label="Last counted" value={item.last_counted_at ? new Date(item.last_counted_at).toLocaleString() : 'Never'} />
      </Card>

      {item.cost_cents != null ? (
        <Card title="Cost & margin">
          <Field label="Cost" value={Money.format(item.cost_cents)} />
          <Field label="Margin" value={margin == null ? '—' : Money.formatBps(margin)} />
        </Card>
      ) : null}

      <Card title="Low-stock threshold">
        <Text className="text-sm text-text-muted">
          Stored on this device only (not written to Clover). Blank = use category/global default ({item.category_threshold ?? 'global'}).
        </Text>
        <TextInput
          accessibilityLabel="Per-item low-stock threshold"
          keyboardType="number-pad"
          value={thresholdText ?? (item.low_stock_threshold?.toString() ?? '')}
          onChangeText={setThresholdText}
          placeholder="Default"
          className="min-h-touch rounded-xl border border-border bg-surface-muted px-4 text-base text-text"
        />
        <Button label="Save threshold" variant="secondary" disabled={thresholdText == null || parsed === undefined} onPress={() => void saveThreshold()} />
      </Card>

      <Card title="Barcode aliases">
        {aliases.length === 0 ? (
          <Text className="text-base text-text-muted">None. Linking scanned barcodes arrives in Milestone 3.</Text>
        ) : (
          aliases.map((a) => <Field key={a} label="Alias" value={a} />)
        )}
      </Card>

      <Card title="Stock history">
        <StockHistory itemId={id} />
      </Card>
    </ScrollView>
  );
}
