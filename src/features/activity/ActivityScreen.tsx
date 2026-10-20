import { FlashList } from '@shopify/flash-list';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';

import { ProxyClient } from '../../api/proxy';
import { Badge, Button, EmptyState, Skeleton } from '../../components';
import { AppDatabase } from '../../db/ExpoSqlDb';
import { IntentQueueRepo, type QueuedIntentRow } from '../../db/intentQueue';
import { ItemRepo } from '../../db/items';
import { StockChangesRepo, type StockChangeRow } from '../../db/stockChanges';
import { ApiError } from '../../lib/errors';
import { SyncController } from '../../sync/SyncController';
import { ACTION_LABEL, REASON_LABEL, StockMath } from '../stock';
import { AuditRow } from './AuditRow';
import { useAudit } from './useAudit';

type ActionFilter = 'all' | 'receive' | 'count' | 'adjust' | 'undo';
type RangeFilter = 'today' | '7d' | 'all';

export class ActivityFilters {
  static since(range: RangeFilter, now = new Date()): string | undefined {
    if (range === 'all') return undefined;
    if (range === 'today') {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return start.toISOString();
    }
    return new Date(now.getTime() - 7 * 86_400_000).toISOString();
  }
}

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

function UnconfirmedRow({ row, onChanged }: { row: StockChangeRow; onChanged: () => void }) {
  const recheck = async () => {
    const db = await AppDatabase.get();
    try {
      const live = (await ProxyClient.item(row.item_id)).stockQty;
      await StockChangesRepo.setLive(db, row.id, live);
      if (live != null) await ItemRepo.setLocalStock(db, row.item_id, live);
    } catch {
      // Still offline: keep showing the last known value.
    }
    onChanged();
  };
  const dismiss = async () => {
    await StockChangesRepo.resolve(await AppDatabase.get(), row.id, Date.now());
    onChanged();
  };
  const matched = row.live_qty != null && row.live_qty === row.after_qty;
  return (
    <View className="gap-2 border-b border-border bg-danger/10 px-4 py-3" accessibilityRole="alert">
      <View className="flex-row items-center justify-between">
        <Text className="flex-1 text-base font-medium text-text">{row.item_name ?? row.item_id}</Text>
        <Badge label="Unconfirmed" tone="danger" />
      </View>
      <Text className="text-base text-text" style={{ fontVariant: ['tabular-nums'] }}>
        Intended {ACTION_LABEL[row.action]} {row.before_qty} → {row.after_qty} · Live now {row.live_qty ?? 'unknown'}
      </Text>
      <Text className="text-sm text-text-muted">
        {matched
          ? 'Live stock matches the intended value — the write probably went through.'
          : 'Live stock does not confirm this change. Re-check, then apply again from the item if needed.'}
      </Text>
      <View className="flex-row gap-2">
        <View className="flex-1">
          <Button label="Re-check" variant="secondary" onPress={() => void recheck()} />
        </View>
        <View className="flex-1">
          <Button label="Dismiss" variant="ghost" onPress={() => void dismiss()} />
        </View>
      </View>
    </View>
  );
}

export function QueuedRow({ row, onDiscard }: { row: QueuedIntentRow; onDiscard: () => void }) {
  return (
    <View className="flex-row items-center gap-2 border-b border-border bg-warning/10 px-4 py-3">
      <View className="flex-1 gap-0.5">
        <Text className="text-base font-medium text-text" numberOfLines={1}>
          {row.item_name ?? row.item_id}
        </Text>
        <Text className="text-sm text-text-muted">
          {ACTION_LABEL[row.action]} {StockMath.signed(row.delta)}
          {row.reason ? ` · ${REASON_LABEL[row.reason]}` : ''} · queued {new Date(row.created_at).toLocaleString()}
        </Text>
      </View>
      <Badge label="Queued" tone="warning" />
      <Pressable accessibilityRole="button" accessibilityLabel={`Discard queued change for ${row.item_name ?? row.item_id}`} onPress={onDiscard} className="min-h-touch justify-center px-2">
        <Text className="text-base text-danger">Discard</Text>
      </Pressable>
    </View>
  );
}

export function ActivityScreen() {
  const qc = useQueryClient();
  const router = useRouter();
  const queued = useQuery({
    queryKey: ['local', 'queued'],
    queryFn: async () => IntentQueueRepo.pending(await AppDatabase.get()),
  });
  const [action, setAction] = useState<ActionFilter>('all');
  const [range, setRange] = useState<RangeFilter>('7d');
  const audit = useAudit({ action: action === 'all' ? undefined : action, since: ActivityFilters.since(range) });
  const unconfirmed = useQuery({
    queryKey: ['local', 'unconfirmed'],
    queryFn: async () => StockChangesRepo.unconfirmed(await AppDatabase.get()),
  });
  const refresh = () => {
    SyncController.bumpData();
    void qc.invalidateQueries({ queryKey: ['local', 'unconfirmed'] });
    void qc.invalidateQueries({ queryKey: ['local', 'queued'] });
    void audit.refetch();
  };

  const header = (
    <View className="gap-2 bg-bg pb-2 pt-2">
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2 px-4">
        {(['all', 'receive', 'count', 'adjust', 'undo'] as const).map((a) => (
          <Chip key={a} label={a === 'all' ? 'All actions' : ACTION_LABEL[a]} active={action === a} onPress={() => setAction(a)} />
        ))}
      </ScrollView>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2 px-4">
        <Chip label="Today" active={range === 'today'} onPress={() => setRange('today')} />
        <Chip label="7 days" active={range === '7d'} onPress={() => setRange('7d')} />
        <Chip label="All time" active={range === 'all'} onPress={() => setRange('all')} />
      </ScrollView>
      {(queued.data ?? []).length > 0 ? (
        <View className="gap-0">
          <View className="flex-row items-center justify-between px-4 py-2">
            <Text className="text-base font-semibold text-text">Queued offline ({queued.data?.length})</Text>
          </View>
          {(queued.data ?? []).map((row) => (
            <QueuedRow
              key={row.id}
              row={row}
              onDiscard={() =>
                void (async () => {
                  await IntentQueueRepo.close(await AppDatabase.get(), row.id, 'discarded');
                  refresh();
                })()
              }
            />
          ))}
          <View className="px-4 pt-2">
            {/* Never auto-flushed: this opens a confirmation with live before → after for each change. */}
            <Button label="Review & apply queued" onPress={() => router.push({ pathname: '/batch', params: { source: 'queue' } })} testID="review-queued" />
          </View>
        </View>
      ) : null}
      {(unconfirmed.data ?? []).map((row) => (
        <UnconfirmedRow key={row.id} row={row} onChanged={refresh} />
      ))}
      {audit.isError ? (
        <View className="mx-4 rounded-xl bg-warning/15 p-3">
          <Text className="text-base text-warning">
            Couldn’t load the shared activity log: {audit.error instanceof ApiError ? audit.error.message : 'error'}
          </Text>
          <Button label="Retry" variant="secondary" onPress={() => void audit.refetch()} />
        </View>
      ) : null}
    </View>
  );

  return (
    <View className="flex-1 bg-bg">
      {audit.isPending ? (
        <>
          {header}
          <View className="p-4">
            <Skeleton lines={6} height={56} />
          </View>
        </>
      ) : (
        <FlashList
          data={audit.data?.entries ?? []}
          keyExtractor={(e) => String(e.id)}
          renderItem={({ item }) => <AuditRow entry={item} />}
          ListHeaderComponent={header}
          refreshControl={<RefreshControl refreshing={audit.isRefetching} onRefresh={refresh} />}
          ListEmptyComponent={
            audit.isError ? null : (
              <EmptyState title="No stock changes yet" message="Receive, count or adjust an item to see it here." actionLabel="Refresh" onAction={refresh} />
            )
          }
        />
      )}
    </View>
  );
}
