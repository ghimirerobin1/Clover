import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';

import { ProxyClient, type Health } from '../../api/proxy';
import { Badge, Button, Skeleton } from '../../components';
import { AppDatabase } from '../../db/ExpoSqlDb';
import { ItemRepo } from '../../db/items';
import { SettingsRepo, type SettingKey } from '../../db/settings';
import { ApiError } from '../../lib/errors';
import { DEFAULT_GLOBAL_THRESHOLD } from '../../lib/thresholds';
import { SyncController } from '../../sync/SyncController';
import { ThresholdSync } from '../../sync/ThresholdSync';
import { DevSeedCard, PairingCard, SyncCard } from '../inventory';
import { AppPrefs, THEMES, type ThemePref } from './AppPrefs';

type HealthState = { kind: 'loading' } | { kind: 'ok'; health: Health } | { kind: 'error'; message: string };

export class HealthCheck {
  static async run(): Promise<HealthState> {
    try {
      return { kind: 'ok', health: await ProxyClient.health() };
    } catch (e) {
      return { kind: 'error', message: e instanceof ApiError ? e.message : 'Could not reach the proxy.' };
    }
  }
}

const INPUT = 'min-h-touch rounded-xl border border-border bg-surface-muted px-4 text-base text-text';

export function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View className="gap-3 rounded-2xl border border-border bg-surface p-4">
      <Text accessibilityRole="header" className="text-lg font-semibold text-text">
        {title}
      </Text>
      {children}
    </View>
  );
}

function Toggle({ label, hint, value, disabled, onChange }: { label: string; hint?: string; value: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <View className="min-h-touch flex-row items-center justify-between gap-3">
      <View className="flex-1">
        <Text className="text-base text-text">{label}</Text>
        {hint ? <Text className="text-sm text-text-muted">{hint}</Text> : null}
      </View>
      <Switch accessibilityLabel={label} value={value} disabled={disabled} onValueChange={onChange} />
    </View>
  );
}

function Segmented<T extends string>({ options, value, label, onChange }: { options: readonly T[]; value: T; label: (v: T) => string; onChange: (v: T) => void }) {
  return (
    <View className="flex-row gap-2">
      {options.map((o) => (
        <Pressable
          key={o}
          accessibilityRole="button"
          accessibilityState={{ selected: value === o }}
          accessibilityLabel={label(o)}
          onPress={() => onChange(o)}
          className={`min-h-touch flex-1 items-center justify-center rounded-full border ${value === o ? 'border-accent bg-accent/15' : 'border-border bg-surface'}`}
        >
          <Text className={`text-base ${value === o ? 'font-semibold text-accent' : 'text-text'}`}>{label(o)}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function usePrefs() {
  return useQuery({
    queryKey: ['local', 'settings'],
    queryFn: async () => {
      const db = await AppDatabase.get();
      return {
        globalThreshold: await SettingsRepo.globalThreshold(db),
        prefixes: (await SettingsRepo.get(db, 'variable_weight_prefixes')) ?? '2',
        scanMode: (await SettingsRepo.get(db, 'scan_default_mode')) === 'continuous' ? ('continuous' as const) : ('single' as const),
        beep: await SettingsRepo.flag(db, 'scan_beep', true),
        haptics: await SettingsRepo.flag(db, 'scan_haptics', true),
        theme: await AppPrefs.theme(db),
        createEnabled: await SettingsRepo.flag(db, 'create_items_enabled', false),
        deviceCanCreate: await SettingsRepo.flag(db, 'device_can_create', false),
        categories: await ItemRepo.categories(db),
      };
    },
  });
}

export function SettingsScreen() {
  const qc = useQueryClient();
  const prefs = usePrefs();
  const [health, setHealth] = useState<HealthState>({ kind: 'loading' });
  const [threshold, setThreshold] = useState<string | null>(null);
  const [prefixes, setPrefixes] = useState<string | null>(null);
  const [catEdits, setCatEdits] = useState<Record<string, string>>({});

  // GET /me caches canCreateItems locally; losing the flag also turns the local toggle off.
  const me = useQuery({
    queryKey: ['remote', 'me'],
    retry: 0,
    queryFn: async () => {
      const dev = await ProxyClient.me();
      const db = await AppDatabase.get();
      await SettingsRepo.set(db, 'device_can_create', dev.canCreateItems ? '1' : '0');
      if (!dev.canCreateItems) await SettingsRepo.set(db, 'create_items_enabled', '0');
      void qc.invalidateQueries({ queryKey: ['local'] });
      return dev;
    },
  });
  const device = me.data ?? null;

  useEffect(() => {
    let active = true;
    void HealthCheck.run().then((next) => {
      if (active) setHealth(next);
    });
    return () => {
      active = false;
    };
  }, []);

  const save = async (key: SettingKey, value: string) => {
    await SettingsRepo.set(await AppDatabase.get(), key, value);
    SyncController.bumpData();
    void qc.invalidateQueries({ queryKey: ['local'] });
  };

  const p = prefs.data;
  const parsedThreshold = AppPrefs.parseThreshold(threshold ?? '');
  const parsedPrefixes = AppPrefs.parsePrefixes(prefixes ?? '');
  const { version, build } = AppPrefs.version();

  return (
    <ScrollView className="flex-1 bg-bg" contentContainerClassName="gap-4 p-4" keyboardShouldPersistTaps="handled">
      <Card title="Proxy connection">
        <Text className="text-base text-text-muted">{ProxyClient.baseUrl()}</Text>
        {health.kind === 'loading' ? <Skeleton width={120} height={24} /> : null}
        {health.kind === 'ok' ? (
          <Badge tone="success" label={health.health.mock ? `Connected · mock mode · v${health.health.version}` : `Connected · v${health.health.version}`} />
        ) : null}
        {health.kind === 'error' ? (
          <>
            <Badge tone="danger" label="Unreachable" />
            <Text className="text-base text-text-muted">{health.message}</Text>
          </>
        ) : null}
        <Text className="text-base text-text-muted">
          {device ? `Paired as “${device.name}” · create items ${device.canCreateItems ? 'allowed' : 'not allowed'}` : 'Device not paired (or proxy unreachable).'}
        </Text>
        <Button
          label="Check again"
          variant="secondary"
          onPress={() => {
            setHealth({ kind: 'loading' });
            void HealthCheck.run().then(setHealth);
                  }}
        />
      </Card>
      <PairingCard />
      <SyncCard />

      {!p ? (
        <Skeleton lines={4} height={48} />
      ) : (
        <>
          <Card title="Low stock thresholds">
            <Text className="text-base text-text-muted">Used when neither the item nor its category has its own threshold. Default {DEFAULT_GLOBAL_THRESHOLD}.</Text>
            <View className="flex-row gap-2">
              <TextInput
                accessibilityLabel="Global low-stock threshold"
                keyboardType="number-pad"
                value={threshold ?? String(p.globalThreshold)}
                onChangeText={setThreshold}
                className={`${INPUT} flex-1`}
              />
              <Button
                label="Save"
                disabled={threshold == null || parsedThreshold == null}
                onPress={() =>
                  void (async () => {
                    if (parsedThreshold == null) return;
                    await save('global_low_stock_threshold', String(parsedThreshold));
                    setThreshold(null);
                  })()
                }
              />
            </View>
            <Text className="text-sm font-medium text-text-muted">Category defaults (shared with other devices)</Text>
            {p.categories.length === 0 ? <Text className="text-base text-text-muted">Sync the catalog to edit category thresholds.</Text> : null}
            {p.categories.map((c) => {
              const text = catEdits[c.id] ?? (c.low_stock_threshold == null ? '' : String(c.low_stock_threshold));
              const parsed = text.trim() === '' ? null : AppPrefs.parseThreshold(text);
              const dirty = catEdits[c.id] != null;
              const valid = text.trim() === '' || parsed != null;
              return (
                <View key={c.id} className="flex-row items-center gap-2">
                  <Text className="flex-1 text-base text-text" numberOfLines={1}>
                    {c.name}
                  </Text>
                  <TextInput
                    accessibilityLabel={`Threshold for ${c.name}`}
                    placeholder="global"
                    keyboardType="number-pad"
                    value={text}
                    onChangeText={(t) => setCatEdits((e) => ({ ...e, [c.id]: t }))}
                    className={`${INPUT} w-24 text-center`}
                  />
                  <Button
                    label="Save"
                    variant="secondary"
                    disabled={!dirty || !valid}
                    onPress={() =>
                      void (async () => {
                        await ThresholdSync.set(await AppDatabase.get(), ProxyClient, 'category', c.id, parsed);
                        setCatEdits(({ [c.id]: _, ...rest }) => rest);
                        SyncController.bumpData();
                        void qc.invalidateQueries({ queryKey: ['local'] });
                      })()
                    }
                  />
                </View>
              );
            })}
          </Card>

          <Card title="Scanning">
            <Text className="text-sm font-medium text-text-muted">Default mode</Text>
            <Segmented options={['single', 'continuous'] as const} value={p.scanMode} label={(m) => (m === 'single' ? 'Single' : 'Counting')} onChange={(m) => void save('scan_default_mode', m)} />
            <Toggle label="Beep on scan" hint="Counting mode" value={p.beep} onChange={(v) => void save('scan_beep', v ? '1' : '0')} />
            <Toggle label="Haptics on scan" value={p.haptics} onChange={(v) => void save('scan_haptics', v ? '1' : '0')} />
            <Text className="text-sm font-medium text-text-muted">Variable-weight barcode prefixes</Text>
            <Text className="text-sm text-text-muted">UPC-A codes starting with these digits are price/weight-embedded (deli, produce). Comma separated, e.g. “2, 02”.</Text>
            <View className="flex-row gap-2">
              <TextInput accessibilityLabel="Variable-weight prefixes" value={prefixes ?? p.prefixes} onChangeText={setPrefixes} className={`${INPUT} flex-1`} />
              <Button
                label="Save"
                disabled={prefixes == null || parsedPrefixes == null}
                onPress={() =>
                  void (async () => {
                    if (parsedPrefixes == null) return;
                    await save('variable_weight_prefixes', parsedPrefixes);
                    setPrefixes(null);
                  })()
                }
              />
            </View>
          </Card>

          <Card title="Appearance">
            <Segmented
              options={THEMES}
              value={p.theme}
              label={(t: ThemePref) => (t === 'system' ? 'System' : t === 'light' ? 'Light' : 'Dark')}
              onChange={(t) =>
                void (async () => {
                  await AppPrefs.setTheme(await AppDatabase.get(), t);
                  void qc.invalidateQueries({ queryKey: ['local', 'settings'] });
                })()
              }
            />
          </Card>

          <Card title="Create items in Clover">
            <Toggle
              label="Allow creating items"
              hint={p.deviceCanCreate ? 'Shows “Create in Clover” when a scan is not found.' : 'This device key does not have canCreateItems.'}
              value={p.createEnabled && p.deviceCanCreate}
              disabled={!p.deviceCanCreate}
              onChange={(on) => {
                if (!on) return void save('create_items_enabled', '0');
                Alert.alert('Allow creating items?', 'New items are written to Clover and appear on the POS. Each one is confirmed before it is created.', [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Allow', onPress: () => void save('create_items_enabled', '1') },
                ]);
              }}
            />
          </Card>
        </>
      )}

      <Card title="About">
        <Text className="text-base text-text">Stockroom {version} (build {build})</Text>
        <Text className="text-sm text-text-muted">Proxy {health.kind === 'ok' ? health.health.version : 'unknown'}</Text>
      </Card>
      <DevSeedCard />
    </ScrollView>
  );
}
