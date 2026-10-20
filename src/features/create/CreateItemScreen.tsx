import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { ProxyClient } from '../../api/proxy';
import { Button, EmptyState, Skeleton, Toast } from '../../components';
import { AppDatabase } from '../../db/ExpoSqlDb';
import { ItemRepo } from '../../db/items';
import { Money } from '../../lib/money';
import { SyncController } from '../../sync/SyncController';
import { CreateGate, CreateItemForm, CreateItemWriter, type CreateApi, type CreateDraft } from './CreateItem';

const api = (): CreateApi => ProxyClient;
type Phase = { kind: 'edit' } | { kind: 'confirm' } | { kind: 'sending' } | { kind: 'unknown'; message: string } | { kind: 'failed'; message: string };

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <View className="gap-1">
      <Text className="text-sm font-medium text-text-muted">{label}</Text>
      {children}
      {error ? <Text className="text-sm text-danger">{error}</Text> : null}
    </View>
  );
}

const INPUT = 'min-h-touch rounded-xl border border-border bg-surface-muted px-4 text-base text-text';

export function CreateItemScreen({ code }: { code: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<CreateDraft>(() => CreateItemForm.empty(code));
  const [phase, setPhase] = useState<Phase>({ kind: 'edit' });
  const [touched, setTouched] = useState(false);
  const ctx = useQuery({
    queryKey: ['local', 'create-ctx'],
    queryFn: async () => {
      const db = await AppDatabase.get();
      return { gate: await CreateGate.load(db), categories: await ItemRepo.categories(db) };
    },
  });
  if (ctx.isPending) return <View className="flex-1 bg-bg p-4"><Skeleton lines={6} height={48} /></View>;
  if (!ctx.data?.gate.allowed) {
    return (
      <View className="flex-1 bg-bg">
        <EmptyState
          title="Creating items is off"
          message={
            ctx.data?.gate.deviceCanCreate
              ? 'Turn on “Create items in Clover” in Settings first.'
              : 'This device key is not allowed to create items. Pair it with a code from `python -m app.pair --allow-create-items`.'
          }
          actionLabel="Back"
          onAction={() => router.back()}
        />
      </View>
    );
  }
  const errors = CreateItemForm.validate(draft);
  const shown = touched ? errors : {};
  const set = (patch: Partial<CreateDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const categoryName = ctx.data.categories.find((c) => c.id === draft.categoryId)?.name ?? null;

  const create = async () => {
    setPhase({ kind: 'sending' });
    const db = await AppDatabase.get();
    // One id per confirmation tap. If the outcome is unknown we do NOT resend it automatically.
    const out = await CreateItemWriter.submit(db, api(), CreateItemForm.toRequest(draft, Crypto.randomUUID()));
    if (out.kind === 'created') {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      SyncController.bumpData();
      void qc.invalidateQueries({ queryKey: ['local'] });
      if (out.warnings.length) Toast.show({ message: out.warnings.join('\n'), durationMs: 8000 });
      router.replace({ pathname: '/item/[id]', params: { id: out.itemId } });
      return;
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    setPhase(out.kind === 'unknown' ? { kind: 'unknown', message: out.message } : { kind: 'failed', message: out.message });
  };

  if (phase.kind !== 'edit') {
    return (
      <ScrollView className="flex-1 bg-bg" contentContainerClassName="gap-3 p-4">
        <View testID="create-summary" className="gap-1 rounded-2xl border border-border bg-surface p-4">
          <Text accessibilityRole="header" className="text-lg font-semibold text-text">Create this item in Clover?</Text>
          {CreateItemForm.summary(draft, categoryName).map((line) => (
            <Text key={line} className="text-base text-text">{line}</Text>
          ))}
        </View>
        {phase.kind === 'unknown' ? (
          <View className="gap-2 rounded-xl bg-danger/10 p-3" accessibilityRole="alert">
            <Text className="text-base font-semibold text-danger">Unconfirmed — the item may or may not exist</Text>
            <Text className="text-base text-text">
              {phase.message} Nothing will be retried. Sync the catalog or scan the barcode to check before creating it again.
            </Text>
            <Button label="Sync now" variant="secondary" onPress={() => void SyncController.sync()} />
          </View>
        ) : null}
        {phase.kind === 'failed' ? <Text className="text-base text-danger" accessibilityRole="alert">Not created: {phase.message}</Text> : null}
        <Button
          testID="create-confirm"
          label="Create in Clover"
          size="lg"
          loading={phase.kind === 'sending'}
          disabled={phase.kind !== 'confirm' && phase.kind !== 'failed'}
          onPress={() => void create()}
        />
        <Button label="Edit" variant="ghost" disabled={phase.kind === 'sending'} onPress={() => setPhase({ kind: 'edit' })} />
      </ScrollView>
    );
  }

  return (
    <ScrollView className="flex-1 bg-bg" keyboardShouldPersistTaps="handled" contentContainerClassName="gap-3 p-4">
      <Field label="Name *" error={shown.name}>
        <TextInput accessibilityLabel="Name" value={draft.name} onChangeText={(name) => set({ name })} maxLength={127} className={INPUT} />
      </Field>
      <Field label="Price *" error={shown.priceCents}>
        <TextInput
          accessibilityLabel="Price"
          keyboardType="number-pad"
          value={Money.format(draft.priceCents)}
          onChangeText={(t) => set({ priceCents: Money.fromDigits(t) })}
          className={`${INPUT} text-right`}
          style={{ fontVariant: ['tabular-nums'] }}
        />
      </Field>
      <Field label="UPC / barcode" error={shown.code}>
        <TextInput accessibilityLabel="UPC" value={draft.code} onChangeText={(c) => set({ code: c })} autoCapitalize="none" className={INPUT} />
      </Field>
      <Field label="SKU" error={shown.sku}>
        <TextInput accessibilityLabel="SKU" value={draft.sku} onChangeText={(sku) => set({ sku })} autoCapitalize="characters" className={INPUT} />
      </Field>
      <Field label="Category">
        <View className="flex-row flex-wrap gap-2">
          {[{ id: null, name: 'None' }, ...ctx.data.categories].map((c) => (
            <Pressable
              key={c.id ?? 'none'}
              accessibilityRole="button"
              accessibilityState={{ selected: draft.categoryId === c.id }}
              accessibilityLabel={`Category ${c.name}`}
              onPress={() => set({ categoryId: c.id })}
              className={`min-h-touch justify-center rounded-full border px-4 ${draft.categoryId === c.id ? 'border-accent bg-accent/15' : 'border-border bg-surface'}`}
            >
              <Text className="text-base text-text">{c.name}</Text>
            </Pressable>
          ))}
        </View>
      </Field>
      <Field label="Initial stock (optional)" error={shown.initialStock}>
        <TextInput accessibilityLabel="Initial stock" keyboardType="number-pad" value={draft.initialStock} onChangeText={(initialStock) => set({ initialStock })} className={INPUT} />
      </Field>
      <Button
        testID="create-review"
        label="Review"
        size="lg"
        onPress={() => {
          setTouched(true);
          if (CreateItemForm.isValid(draft)) setPhase({ kind: 'confirm' });
        }}
      />
    </ScrollView>
  );
}
