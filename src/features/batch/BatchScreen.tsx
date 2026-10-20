import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { ProxyClient } from '../../api/proxy';
import { Badge, Button, EmptyState, Skeleton } from '../../components';
import type { BadgeTone } from '../../components/Badge';
import { AppDatabase } from '../../db/ExpoSqlDb';
import { IntentQueueRepo } from '../../db/intentQueue';
import { SyncController } from '../../sync/SyncController';
import { StockMath, type StockApi } from '../stock';
import { BatchRunner, type BatchRow, type BatchStatus, type TallyMode } from './BatchRunner';
import { TallyController, useTallyStore } from './Tally';

export type BatchSource = 'tally' | 'queue';
const api = (): StockApi => ProxyClient;

const STATUS: Record<BatchStatus, { label: string; tone: BadgeTone }> = {
  pending: { label: 'Ready', tone: 'neutral' },
  applied: { label: '✓ Applied', tone: 'success' },
  conflict: { label: 'Conflict', tone: 'warning' },
  failed: { label: 'Failed', tone: 'danger' },
  unconfirmed: { label: 'Unconfirmed', tone: 'danger' },
};

export function BatchRowView({ row, onRemove }: { row: BatchRow; onRemove?: () => void }) {
  const after = row.after ?? (row.base != null ? StockMath.target(row.intent, row.base) : null);
  const destructive = row.base != null && after != null && row.status !== 'applied' && StockMath.isDestructive(row.base, after);
  const invalid = row.status === 'applied' || row.status === 'unconfirmed' ? null : BatchRunner.invalid(row);
  const s = STATUS[row.status];
  return (
    <View
      testID={`batch-row-${row.key}`}
      accessibilityLabel={`${row.itemName}: ${row.base ?? '?'} → ${after ?? '?'}, ${s.label}`}
      className={`gap-1 border-b border-border px-4 py-3 ${destructive ? 'bg-danger/10' : 'bg-surface'}`}
    >
      <View className="flex-row items-center justify-between gap-2">
        <Text className="flex-1 text-base font-medium text-text" numberOfLines={1}>
          {row.itemName}
        </Text>
        <Badge label={s.label} tone={s.tone} />
      </View>
      <View className="flex-row items-center justify-between">
        <Text className={`text-lg ${destructive ? 'text-danger' : 'text-text'}`} style={{ fontVariant: ['tabular-nums'] }}>
          {row.base ?? '—'} → {after ?? '—'}
          {'  '}
          <Text className="text-sm text-text-muted">
            ({row.intent.action === 'count' ? `Count ${row.intent.amount}` : StockMath.signed(row.intent.amount)})
          </Text>
        </Text>
        {onRemove && row.status !== 'applied' ? (
          <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${row.itemName}`} onPress={onRemove} className="min-h-touch justify-center px-3">
            <Text className="text-base text-danger">Remove</Text>
          </Pressable>
        ) : null}
      </View>
      {row.message || invalid ? <Text className="text-sm text-text-muted">{row.message ?? invalid}</Text> : null}
    </View>
  );
}

/** Batch confirmation (spec §4.4): every row's live before → after on one screen; one tap applies sequentially. */
export function BatchScreen({ source }: { source: BatchSource }) {
  const router = useRouter();
  const qc = useQueryClient();
  const tally = useTallyStore((s) => s.rows);
  const [mode, setMode] = useState<TallyMode>('count');
  const [edited, setEdited] = useState<BatchRow[] | null>(null);
  const [busy, setBusy] = useState<'loading' | 'applying' | null>(null);
  const [initialTally] = useState(tally);

  // Fresh live reads on open (and when the tally mode changes). Reads only; nothing is written here.
  const initial = useQuery({
    queryKey: ['remote', 'batch', source, mode],
    queryFn: async () =>
      BatchRunner.loadBases(
        api(),
        source === 'tally'
          ? BatchRunner.fromTally(initialTally, mode)
          : BatchRunner.fromQueue(await IntentQueueRepo.pending(await AppDatabase.get())),
      ),
    staleTime: Infinity,
    gcTime: 0,
    retry: 0,
  });
  const rows = edited ?? initial.data ?? null;
  const setRows = (r: BatchRow[]) => setEdited(r);
  const changeMode = (m: TallyMode) => {
    setEdited(null);
    setMode(m);
  };
  const refresh = async () => {
    if (!rows) return;
    setBusy('loading');
    setEdited(await BatchRunner.loadBases(api(), rows));
    setBusy(null);
  };

  const apply = async () => {
    if (!rows) return;
    setBusy('applying');
    const db = await AppDatabase.get();
    const out = await BatchRunner.run(db, api(), rows, { newId: () => Crypto.randomUUID(), onRow: setRows });
    setRows(out);
    setBusy(null);
    if (source === 'tally') for (const r of out) if (r.status === 'applied' || r.status === 'unconfirmed') TallyController.remove(r.itemId);
    const sum = BatchRunner.summary(out);
    void Haptics.notificationAsync(
      sum.failed + sum.conflict + sum.unconfirmed === 0 ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning,
    );
    SyncController.bumpData();
    void qc.invalidateQueries({ queryKey: ['remote', 'audit'] });
    void qc.invalidateQueries({ queryKey: ['local'] });
  };

  if (rows == null) {
    return (
      <View className="flex-1 bg-bg p-4">
        <Text className="mb-3 text-base text-text-muted">Reading live stock from Clover…</Text>
        <Skeleton lines={5} height={56} />
      </View>
    );
  }
  if (rows.length === 0) {
    return (
      <View className="flex-1 bg-bg">
        <EmptyState title="Nothing to apply" message={source === 'tally' ? 'Scan items in continuous mode first.' : 'No queued changes.'} actionLabel="Back" onAction={() => router.back()} />
      </View>
    );
  }

  const runnable = rows.filter(BatchRunner.runnable);
  const sum = BatchRunner.summary(rows);
  const destructive = runnable.some((r) => r.base != null && StockMath.isDestructive(r.base, StockMath.target(r.intent, r.base)));
  const anyConflict = runnable.some((r) => r.status === 'conflict');
  return (
    <View className="flex-1 bg-bg">
      {source === 'tally' ? (
        <View className="flex-row gap-2 px-4 pt-3">
          {(['count', 'receive'] as const).map((m) => (
            <Pressable
              key={m}
              accessibilityRole="button"
              accessibilityState={{ selected: mode === m, disabled: busy != null || sum.applied > 0 }}
              accessibilityLabel={m === 'count' ? 'Set stock to tally (Count)' : 'Add tally to stock (Receive)'}
              disabled={busy != null || sum.applied > 0}
              onPress={() => changeMode(m)}
              className={`min-h-touch flex-1 items-center justify-center rounded-full border ${mode === m ? 'border-accent bg-accent/15' : 'border-border bg-surface'}`}
            >
              <Text className={`text-base ${mode === m ? 'font-semibold text-accent' : 'text-text'}`}>{m === 'count' ? 'Count (set to)' : 'Receive (+)'}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <Text className="px-4 py-2 text-sm text-text-muted">
        {sum.applied} applied · {sum.conflict} conflict · {sum.failed} failed · {sum.unconfirmed} unconfirmed · {runnable.length} ready
      </Text>
      <ScrollView className="flex-1">
        {rows.map((r) => (
          <BatchRowView key={r.key} row={r} onRemove={busy ? undefined : () => setRows(rows.filter((x) => x.key !== r.key))} />
        ))}
      </ScrollView>
      <View className="gap-2 border-t border-border bg-surface p-4">
        {sum.unconfirmed > 0 ? (
          <Text className="text-sm text-danger" accessibilityRole="alert">
            A write had an unknown outcome; the batch stopped. Check Activity before applying anything else for that item.
          </Text>
        ) : null}
        <Button
          testID="batch-apply"
          label={anyConflict ? `Re-confirm and apply ${runnable.length}` : `Apply ${runnable.length} to Clover`}
          size="lg"
          variant={destructive ? 'destructive' : 'primary'}
          disabled={runnable.length === 0 || busy != null}
          loading={busy === 'applying'}
          onPress={() => void apply()}
        />
        <View className="flex-row gap-2">
          <View className="flex-1">
            <Button label="Refresh live stock" variant="secondary" disabled={busy != null} onPress={() => void refresh()} />
          </View>
          <View className="flex-1">
            <Button label="Done" variant="ghost" onPress={() => router.back()} />
          </View>
        </View>
      </View>
    </View>
  );
}
