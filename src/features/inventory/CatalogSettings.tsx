import { useState } from 'react';
import { Alert, Text, TextInput, View } from 'react-native';

import { DeviceKey } from '../../api/deviceKey';
import { ProxyClient } from '../../api/proxy';
import { Button } from '../../components';
import { AppDatabase } from '../../db/ExpoSqlDb';
import { ItemRepo } from '../../db/items';
import { Seeder } from '../../db/seed';
import { SettingsRepo } from '../../db/settings';
import { ApiError } from '../../lib/errors';
import { CatalogSync } from '../../sync/CatalogSync';
import { SyncController } from '../../sync/SyncController';
import { useSyncStore } from '../../sync/syncStore';

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View className="gap-3 rounded-2xl border border-border bg-surface p-4">
      <Text accessibilityRole="header" className="text-lg font-semibold text-text">
        {title}
      </Text>
      {children}
    </View>
  );
}

/** Minimal pairing: enter the code from `python -m app.pair`. Key goes straight to SecureStore. */
export function PairingCard() {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const pair = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await ProxyClient.pair(code, name);
      await DeviceKey.set(res.appKey);
      const db = await AppDatabase.get();
      await SettingsRepo.set(db, 'device_can_create', res.device.canCreateItems ? '1' : '0');
      if (!res.device.canCreateItems) await SettingsRepo.set(db, 'create_items_enabled', '0');
      setCode('');
      setMessage(`Paired as “${res.device.name}”.`);
      void SyncController.sync({ full: true });
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : 'Pairing failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Pair this device">
      <TextInput
        accessibilityLabel="Pairing code"
        placeholder="Pairing code (8 digits)"
        keyboardType="number-pad"
        value={code}
        onChangeText={setCode}
        className="min-h-touch rounded-xl border border-border bg-surface-muted px-4 text-base text-text"
      />
      <TextInput
        accessibilityLabel="Device name"
        placeholder="Device name (e.g. Front counter)"
        value={name}
        onChangeText={setName}
        className="min-h-touch rounded-xl border border-border bg-surface-muted px-4 text-base text-text"
      />
      <Button label="Pair" loading={busy} disabled={code.trim().length < 8 || !name.trim()} onPress={() => void pair()} />
      {message ? <Text className="text-base text-text-muted">{message}</Text> : null}
    </Card>
  );
}

export function SyncCard() {
  const { status, lastSyncedAt, error } = useSyncStore();
  return (
    <Card title="Catalog sync">
      <Text className="text-base text-text-muted">{CatalogSync.describe(lastSyncedAt)}</Text>
      {status === 'error' && error ? <Text className="text-base text-warning">{error}</Text> : null}
      <Button label="Sync now" loading={status === 'syncing'} onPress={() => void SyncController.sync()} />
      <Button label="Full re-sync" variant="secondary" disabled={status === 'syncing'} onPress={() => void SyncController.sync({ full: true })} />
      <Button
        label="Clear local cache"
        variant="destructive"
        onPress={() =>
          Alert.alert('Clear local cache?', 'Removes the downloaded catalog from this device. Clover is not affected.', [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Clear',
              style: 'destructive',
              onPress: () =>
                void (async () => {
                  const db = await AppDatabase.get();
                  await ItemRepo.clear(db);
                  await db.run("DELETE FROM settings WHERE key IN ('last_synced_at', 'synced_through_modified')");
                  useSyncStore.setState({ lastSyncedAt: null });
                  SyncController.bumpData();
                })(),
            },
          ])
        }
      />
    </Card>
  );
}

/** Dev-only perf tooling (spec §6). Rendered only when __DEV__. */
export function DevSeedCard() {
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!__DEV__) return null;
  const seed = async () => {
    setBusy(true);
    const db = await AppDatabase.get();
    const t0 = Date.now();
    await Seeder.seed(db, 15_000);
    const seedMs = Date.now() - t0;
    const t1 = Date.now();
    await ItemRepo.query(db, { search: 'jas ric', globalThreshold: await SettingsRepo.globalThreshold(db), limit: 200 });
    setResult(`Seeded 15,000 in ${seedMs} ms · search "jas ric" ${Date.now() - t1} ms · total ${await ItemRepo.count(db)}`);
    SyncController.bumpData();
    setBusy(false);
  };
  return (
    <Card title="Developer">
      <Text className="text-base text-text-muted">Local only; a full re-sync removes seeded items.</Text>
      <Button label="Seed 15,000 fake items" variant="secondary" loading={busy} onPress={() => void seed()} />
      {result ? <Text className="text-base text-text-muted">{result}</Text> : null}
    </Card>
  );
}
