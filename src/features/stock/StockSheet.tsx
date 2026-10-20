import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { ProxyClient } from '../../api/proxy';
import { ADJUST_REASONS, type AdjustReason, type StockAction } from '../../api/schemas';
import { Badge, Button, Sheet, Skeleton, Stepper, Toast } from '../../components';
import { AppDatabase } from '../../db/ExpoSqlDb';
import { IntentQueueRepo } from '../../db/intentQueue';
import { ItemRepo } from '../../db/items';
import { SettingsRepo } from '../../db/settings';
import { ApiError } from '../../lib/errors';
import { SyncController } from '../../sync/SyncController';
import { ACTION_LABEL, REASON_LABEL, StockMath, type StockIntent } from './StockMath';
import { StockSheetController, useStockSheetStore, type StockSheetRequest } from './stockSheetStore';
import { StockWriter, type StockApi, type WriteOutcome } from './StockWriter';

/** Resolved lazily so the static class is read at call time. */
const api = (): StockApi => ProxyClient;
const UNDO_WINDOW_MS = 10_000;

type Phase =
  | { kind: 'edit' }
  | { kind: 'sending' }
  | { kind: 'conflict'; live: number }
  | { kind: 'unknown'; live: number | null; message: string }
  | { kind: 'failed'; message: string };

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

export class IntentBuilder {
  static build(
    req: StockSheetRequest,
    action: Exclude<StockAction, 'undo'>,
    qty: number,
    sign: 1 | -1,
    reason: AdjustReason | undefined,
    note: string,
  ): StockIntent {
    if (req.mode === 'undo') return StockMath.undoIntent(req.change);
    const trimmed = note.trim() || undefined;
    if (action === 'adjust') return { action, amount: sign * qty, reason, note: trimmed };
    return { action, amount: qty, note: trimmed };
  }
}

/** The confirmation card: before → after, delta, action. */
export function ConfirmCard({ intent, before }: { intent: StockIntent; before: number }) {
  const after = StockMath.target(intent, before);
  const destructive = StockMath.isDestructive(before, after);
  return (
    <View
      testID="confirm-card"
      accessibilityLabel={StockMath.summary(intent, before)}
      className={`flex-row items-center justify-between rounded-2xl border p-4 ${destructive ? 'border-danger bg-danger/10' : 'border-border bg-surface-muted'}`}
    >
      <View>
        <Text className="text-sm text-text-muted">Current</Text>
        <Text className="text-3xl font-bold text-text" style={{ fontVariant: ['tabular-nums'] }}>
          {before}
        </Text>
      </View>
      <Text className="text-2xl text-text-muted">→</Text>
      <View className="items-end">
        <Text className="text-sm text-text-muted">New</Text>
        <Text className={`text-3xl font-bold ${destructive ? 'text-danger' : 'text-text'}`} style={{ fontVariant: ['tabular-nums'] }}>
          {after}
        </Text>
        <Text className="text-sm text-text-muted">
          {StockMath.signed(after - before)}, {ACTION_LABEL[intent.action]}
        </Text>
      </View>
    </View>
  );
}

function StockSheetBody({ req }: { req: StockSheetRequest & { key: number } }) {
  const qc = useQueryClient();
  const [action, setAction] = useState<Exclude<StockAction, 'undo'>>(req.mode === 'edit' ? req.action : 'receive');
  const [qty, setQty] = useState(0);
  const [sign, setSign] = useState<1 | -1>(-1);
  const [reason, setReason] = useState<AdjustReason | undefined>(undefined);
  const [note, setNote] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'edit' });
  const [liveBase, setLiveBase] = useState<number | null>(null);

  // Step 1: always fetch fresh stock through the proxy when the sheet opens.
  const fresh = useQuery({
    queryKey: ['remote', 'stock-sheet', req.itemId, req.key],
    queryFn: () => ProxyClient.item(req.itemId),
    staleTime: 0,
    gcTime: 0,
    retry: 0,
  });
  const local = useQuery({
    queryKey: ['local', 'stock-sheet-item', req.itemId, req.key],
    queryFn: async () => {
      const db = await AppDatabase.get();
      return ItemRepo.byId(db, req.itemId, await SettingsRepo.globalThreshold(db));
    },
  });

  const name = fresh.data?.name ?? local.data?.name ?? 'Item';
  const freshQty = fresh.data?.stockQty;
  const base = liveBase ?? (freshQty ?? null);
  const offline = fresh.isError;
  const untracked = fresh.isSuccess && freshQty == null;
  const intent = IntentBuilder.build(req, action, qty, sign, reason, note);
  const invalid = base != null ? StockMath.validate(intent, base) : null;
  const canApply = base != null && !offline && !invalid && (phase.kind === 'edit' || phase.kind === 'conflict' || phase.kind === 'failed');

  const afterWrite = (outcome: WriteOutcome) => {
    SyncController.bumpData();
    void qc.invalidateQueries({ queryKey: ['remote', 'audit'] });
    void qc.invalidateQueries({ queryKey: ['local'] });
    if (outcome.kind === 'applied') {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      StockSheetController.close();
      const change = { before: outcome.before, after: outcome.after, action: intent.action };
      const message = `${ACTION_LABEL[intent.action]} ${StockMath.signed(outcome.after - outcome.before)} · ${name} now ${outcome.after}`;
      Toast.show(
        intent.action === 'undo'
          ? { message, durationMs: 4000 }
          : {
              message,
              actionLabel: 'Undo',
              durationMs: UNDO_WINDOW_MS,
              // Undo opens a NEW confirmation (same protocol); it never writes directly.
              onAction: () => StockSheetController.open({ itemId: req.itemId, mode: 'undo', change }),
            },
      );
    } else if (outcome.kind === 'conflict') {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      setLiveBase(outcome.live);
      setPhase({ kind: 'conflict', live: outcome.live });
    } else if (outcome.kind === 'unknown') {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setPhase({ kind: 'unknown', live: outcome.live, message: outcome.message });
    } else {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setPhase({ kind: 'failed', message: outcome.message });
    }
  };

  const apply = async () => {
    if (base == null || !canApply) return;
    setPhase({ kind: 'sending' });
    const outcome = await StockWriter.apply(await AppDatabase.get(), api(), {
      itemId: req.itemId,
      itemName: name,
      intent,
      expected: base,
      // A fresh id per confirmation tap; nothing ever re-sends an id automatically.
      clientMutationId: Crypto.randomUUID(),
    });
    afterWrite(outcome);
  };

  // Offline (spec §4.4): queue the intent as a delta. Nothing is sent; it needs a live confirmation later.
  const queueable = offline && req.mode === 'edit' && action !== 'count';
  const queueInvalid = queueable ? IntentQueueRepo.check({ action: action as 'receive' | 'adjust', delta: intent.amount, reason: intent.reason }) : null;
  const queue = async () => {
    if (!queueable || queueInvalid) return;
    await IntentQueueRepo.enqueue(await AppDatabase.get(), {
      itemId: req.itemId,
      itemName: name,
      action: action as 'receive' | 'adjust',
      delta: intent.amount,
      ...(intent.reason ? { reason: intent.reason } : {}),
      ...(intent.note ? { note: intent.note } : {}),
    });
    void qc.invalidateQueries({ queryKey: ['local'] });
    StockSheetController.close();
    Toast.show({ message: `Queued ${ACTION_LABEL[action]} ${StockMath.signed(intent.amount)} · ${name}. Review it in Activity when online.`, durationMs: 4000 });
  };

  const recheck = async () => {
    setPhase({ kind: 'edit' });
    setLiveBase(null);
    await fresh.refetch();
  };

  if (fresh.isPending) {
    return (
      <View className="gap-3">
        <Text className="text-lg font-semibold text-text">{name}</Text>
        <Text className="text-base text-text-muted">Checking live stock in Clover…</Text>
        <Skeleton height={72} />
      </View>
    );
  }

  const target = base != null ? StockMath.target(intent, base) : null;
  const destructive = base != null && target != null && StockMath.isDestructive(base, target);

  return (
    <ScrollView style={{ maxHeight: 640 }} keyboardShouldPersistTaps="handled" contentContainerClassName="gap-3 pb-2">
      <View className="flex-row items-center justify-between">
        <Text className="flex-1 text-lg font-semibold text-text" numberOfLines={2}>
          {name}
        </Text>
        <Badge
          tone={offline ? 'warning' : 'success'}
          label={offline ? 'Cached, may be stale' : liveBase != null ? 'Live (updated)' : 'Live from Clover'}
        />
      </View>

      {offline ? (
        <View className="rounded-xl bg-warning/15 p-3" accessibilityRole="alert">
          <Text className="text-base text-warning">
            Can’t reach Clover ({fresh.error instanceof ApiError ? fresh.error.message : 'offline'}). Cached stock:{' '}
            {local.data?.stock_qty ?? '—'}. Apply is disabled until live stock can be read.
          </Text>
          <Button label="Try again" variant="secondary" onPress={() => void recheck()} />
        </View>
      ) : null}
      {untracked ? <Text className="text-base text-warning">Stock is not tracked for this item in Clover.</Text> : null}

      {req.mode === 'edit' ? (
        <View className="flex-row gap-2">
          {(['receive', 'count', 'adjust'] as const).map((a) => (
            <Chip key={a} label={ACTION_LABEL[a]} active={action === a} onPress={() => setAction(a)} />
          ))}
        </View>
      ) : (
        <Text className="text-base text-text-muted">
          Undo the last {ACTION_LABEL[req.change.action].toLowerCase()} ({StockMath.signed(req.change.after - req.change.before)}).
        </Text>
      )}

      {req.mode === 'edit' ? (
        <>
          {action === 'adjust' ? (
            <View className="flex-row gap-2">
              <Chip label="Remove (−)" active={sign === -1} onPress={() => setSign(-1)} />
              <Chip label="Add (+)" active={sign === 1} onPress={() => setSign(1)} />
            </View>
          ) : null}
          <Stepper
            label={action === 'count' ? 'Counted quantity' : 'Quantity'}
            value={qty}
            min={0}
            max={1_000_000}
            onChange={setQty}
            testID="qty"
          />
          <TextInput
            accessibilityLabel="Type quantity"
            keyboardType="number-pad"
            value={String(qty)}
            onChangeText={(t) => setQty(Math.min(1_000_000, Number(t.replace(/\D/g, '') || '0')))}
            className="min-h-touch rounded-xl border border-border bg-surface-muted px-4 text-center text-lg text-text"
          />
          {action === 'adjust' ? (
            <View className="flex-row flex-wrap gap-2">
              {ADJUST_REASONS.map((r) => (
                <Chip key={r} label={REASON_LABEL[r]} active={reason === r} onPress={() => setReason(r)} />
              ))}
            </View>
          ) : null}
          <TextInput
            accessibilityLabel="Note"
            placeholder={action === 'receive' ? 'Note (supplier / invoice #)' : 'Note (optional)'}
            value={note}
            maxLength={200}
            onChangeText={setNote}
            className="min-h-touch rounded-xl border border-border bg-surface-muted px-4 text-base text-text"
          />
        </>
      ) : null}

      {base != null ? <ConfirmCard intent={intent} before={base} /> : null}
      {invalid && base != null && phase.kind !== 'unknown' ? <Text className="text-base text-text-muted">{invalid}</Text> : null}

      {phase.kind === 'conflict' && target != null ? (
        <View className="rounded-xl bg-warning/15 p-3" accessibilityRole="alert">
          <Text className="text-base text-warning">
            Stock changed to {phase.live} since you opened this (a sale probably happened).{' '}
            {intent.action === 'count'
              ? `Set to ${target}?`
              : `Apply ${StockMath.signed(target - phase.live)} → ${target}?`}
          </Text>
        </View>
      ) : null}
      {phase.kind === 'unknown' ? (
        <View className="gap-2 rounded-xl bg-danger/10 p-3" accessibilityRole="alert">
          <Text className="text-base font-semibold text-danger">Unconfirmed — the result is unknown</Text>
          <Text className="text-base text-text">
            The connection dropped after sending. Nothing will be retried automatically. Live stock now:{' '}
            {phase.live ?? 'unavailable'}. Check it and decide; it’s also listed in Activity.
          </Text>
          <Button label="Re-check live stock" variant="secondary" onPress={() => void recheck()} />
        </View>
      ) : null}
      {phase.kind === 'failed' ? (
        <Text className="text-base text-danger" accessibilityRole="alert">
          Not applied: {phase.message}
        </Text>
      ) : null}

      <Button
        label={phase.kind === 'conflict' ? 'Re-confirm and apply' : 'Apply to Clover'}
        size="lg"
        variant={destructive ? 'destructive' : 'primary'}
        disabled={!canApply}
        loading={phase.kind === 'sending'}
        accessibilityHint={base != null ? StockMath.summary(intent, base) : undefined}
        onPress={() => void apply()}
        testID="apply"
      />
      {queueable ? (
        <>
          <Button label={`Queue for later (${StockMath.signed(intent.amount)})`} variant="secondary" disabled={queueInvalid != null} onPress={() => void queue()} testID="queue" />
          <Text className="text-sm text-text-muted">{queueInvalid ?? 'Saved as a change, not a number. You’ll confirm it against live stock when back online.'}</Text>
        </>
      ) : null}
      {offline && req.mode === 'edit' && action === 'count' ? (
        <Text className="text-sm text-text-muted">Counts can’t be queued offline (they need live stock to be meaningful).</Text>
      ) : null}
      <Button label="Cancel" variant="ghost" onPress={StockSheetController.close} />
    </ScrollView>
  );
}

/** Mount once at the root so any screen (scan, item detail, toast Undo) can open the stock sheet. */
export function StockSheetHost() {
  const request = useStockSheetStore((s) => s.request);
  return (
    <Sheet visible={request != null} onClose={StockSheetController.close} title={request?.mode === 'undo' ? 'Undo change' : 'Update stock'}>
      {request ? <StockSheetBody key={request.key} req={request} /> : null}
    </Sheet>
  );
}
