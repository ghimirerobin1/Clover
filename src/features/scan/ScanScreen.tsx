import { useQuery } from '@tanstack/react-query';
import { CameraView, useCameraPermissions, type BarcodeType } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { ProxyClient } from '../../api/proxy';
import { Button, EmptyState, Sheet } from '../../components';
import { AppDatabase } from '../../db/ExpoSqlDb';
import type { ItemRow } from '../../db/items';
import { SettingsRepo } from '../../db/settings';
import { Barcode } from '../../lib/barcode';
import { Beep } from '../../lib/beep';
import { CreateGate } from '../create';
import { Tally, TallyController, useTallyStore, type TallyRow } from '../batch';
import { StockSheetController } from '../stock';
import { Keypad } from './Keypad';
import { LookupChain, ScanDebouncer, type LookupOutcome } from './LookupChain';
import { CandidateList, ItemSummary, NotFound } from './ScanSheets';

/** Spec §1: EAN-13, EAN-8, UPC-A, UPC-E, Code128, Code39, QR. */
export const BARCODE_TYPES: BarcodeType[] = ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'code39', 'qr'];
const ZOOM_STEP = 0.1;
const MODAL_HANDOFF_MS = 350;
export type ScanMode = 'single' | 'continuous';

type SheetState =
  | { kind: 'closed' }
  | { kind: 'busy'; code: string }
  | { kind: 'manual' }
  | { kind: 'result'; outcome: LookupOutcome }
  | { kind: 'item'; item: ItemRow; outcome: LookupOutcome };

const remote = { lookup: (code: string) => ProxyClient.lookup(code) };

function useScanPrefs() {
  return useQuery({
    queryKey: ['local', 'scan-prefs'],
    queryFn: async () => {
      const db = await AppDatabase.get();
      return {
        rule: Barcode.parseRule(await SettingsRepo.get(db, 'variable_weight_prefixes')),
        canCreate: (await CreateGate.load(db)).allowed,
        defaultMode: ((await SettingsRepo.get(db, 'scan_default_mode')) === 'continuous' ? 'continuous' : 'single') as ScanMode,
        beep: await SettingsRepo.flag(db, 'scan_beep', true),
        haptics: await SettingsRepo.flag(db, 'scan_haptics', true),
        globalThreshold: await SettingsRepo.globalThreshold(db),
      };
    },
  });
}

export function ScanScreen() {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [torch, setTorch] = useState(false);
  const [zoom, setZoom] = useState(0);
  const [sheet, setSheet] = useState<SheetState>({ kind: 'closed' });
  const [manual, setManual] = useState('');
  const [modeOverride, setMode] = useState<ScanMode | null>(null);
  const tally = useTallyStore((s) => s.rows);
  const debouncer = useRef(new ScanDebouncer());
  const prefs = useScanPrefs();
  const mode: ScanMode = modeOverride ?? prefs.data?.defaultMode ?? 'single';
  const haptics = prefs.data?.haptics ?? true;
  const beep = prefs.data?.beep ?? true;

  const addToTally = useCallback((item: ItemRow) => {
    TallyController.add(item);
    if (haptics) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    if (beep) void Beep.play();
  }, [haptics, beep]);

  const lookup = useCallback(
    async (raw: string, type?: string) => {
      if (!prefs.data) return;
      // Continuous mode keeps the camera live: no "Looking up…" sheet for the (local, fast) lookup.
      if (mode === 'single') setSheet({ kind: 'busy', code: raw });
      const db = await AppDatabase.get();
      const outcome = await LookupChain.resolve(db, remote, raw, { type, ...prefs.data });
      if (mode === 'continuous' && outcome.kind === 'found') {
        addToTally(outcome.item);
        setSheet({ kind: 'closed' });
        return;
      }
      if (haptics) void Haptics.notificationAsync(
        outcome.kind === 'not_found' ? Haptics.NotificationFeedbackType.Warning : Haptics.NotificationFeedbackType.Success,
      );
      setSheet(outcome.kind === 'found' ? { kind: 'item', item: outcome.item, outcome } : { kind: 'result', outcome });
    },
    [prefs.data, mode, addToTally, haptics],
  );

  const scanning = sheet.kind === 'closed';
  const onScanned = useCallback(
    ({ data, type }: { data: string; type: string }) => {
      if (!scanning || !debouncer.current.accept(data)) return;
      if (haptics) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      void lookup(data, type);
    },
    [lookup, scanning, haptics],
  );
  const close = () => setSheet({ kind: 'closed' });

  if (!permission) return <View className="flex-1 bg-black" />;
  if (!permission.granted) {
    return (
      <View className="flex-1 bg-bg">
        <EmptyState
          title="Camera access needed"
          message="Stockroom uses the camera only to read barcodes. You can also type a code."
          actionLabel={permission.canAskAgain ? 'Allow camera' : 'Enter code manually'}
          onAction={() => (permission.canAskAgain ? void requestPermission() : setSheet({ kind: 'manual' }))}
        />
        <ManualSheet sheet={sheet} manual={manual} setManual={setManual} close={close} lookup={lookup} />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-black">
      <CameraView
        style={{ flex: 1 }}
        facing="back"
        enableTorch={torch}
        zoom={zoom}
        barcodeScannerSettings={{ barcodeTypes: BARCODE_TYPES }}
        onBarcodeScanned={scanning ? onScanned : undefined}
      />
      <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
        <View className="h-44 w-72 rounded-2xl border-4 border-white/80" accessibilityLabel="Viewfinder" />
        <Text className="mt-4 text-base text-white">Point at a barcode</Text>
      </View>
      <View className="absolute left-4 right-4 top-4">
        <ModeToggle mode={mode} onChange={setMode} />
      </View>
      <View className="absolute bottom-6 left-4 right-4 gap-3">
        {mode === 'continuous' ? (
          <TallyPanel rows={tally} onReview={() => router.push({ pathname: '/batch', params: { source: 'tally' } })} />
        ) : null}
        <View className="flex-row items-center justify-between gap-3">
          <OverlayButton label={torch ? 'Torch on' : 'Torch off'} onPress={() => setTorch((t) => !t)} />
          <View className="flex-row gap-2">
            <OverlayButton label="−" a11y="Zoom out" onPress={() => setZoom((z) => Math.max(0, +(z - ZOOM_STEP).toFixed(2)))} />
            <OverlayButton label={`${Math.round(zoom * 100)}%`} a11y="Reset zoom" onPress={() => setZoom(0)} />
            <OverlayButton label="+" a11y="Zoom in" onPress={() => setZoom((z) => Math.min(1, +(z + ZOOM_STEP).toFixed(2)))} />
          </View>
        </View>
        <Button label="Enter code manually" size="lg" variant="secondary" onPress={() => setSheet({ kind: 'manual' })} />
      </View>

      <ManualSheet sheet={sheet} manual={manual} setManual={setManual} close={close} lookup={lookup} />
      <Sheet visible={sheet.kind === 'busy'} onClose={close} title="Looking up…">
        <Text className="text-base text-text-muted">{sheet.kind === 'busy' ? sheet.code : ''}</Text>
      </Sheet>
      <Sheet visible={sheet.kind === 'item'} onClose={close} title="Item">
        {sheet.kind === 'item' && sheet.outcome.kind !== 'not_found' ? (
          <ItemSummary
            item={sheet.item}
            barcode={sheet.outcome.barcode}
            onScanNext={close}
            onAction={(action) => {
              const id = sheet.item.id;
              close();
              // Let the scan sheet's modal dismiss before presenting the stock sheet (iOS can't stack modals).
              setTimeout(() => StockSheetController.open({ itemId: id, mode: 'edit', action }), MODAL_HANDOFF_MS);
            }}
            onDetails={() => {
              const id = sheet.item.id;
              close();
              router.push({ pathname: '/item/[id]', params: { id } });
            }}
          />
        ) : null}
      </Sheet>
      <Sheet visible={sheet.kind === 'result'} onClose={close} title={sheet.kind === 'result' && sheet.outcome.kind === 'ambiguous' ? 'Several items match' : 'Not found'}>
        {sheet.kind === 'result' && sheet.outcome.kind === 'ambiguous' ? (
          <CandidateList
            items={sheet.outcome.candidates}
            onPick={(item) => {
              if (mode === 'continuous') {
                addToTally(item);
                close();
              } else setSheet({ kind: 'item', item, outcome: sheet.outcome });
            }}
          />
        ) : null}
        {sheet.kind === 'result' && sheet.outcome.kind === 'not_found' ? (
          <NotFound
            barcode={sheet.outcome.barcode}
            remoteError={sheet.outcome.remoteError?.message ?? null}
            canCreate={prefs.data?.canCreate ?? false}
            onScanNext={close}
            onSearch={() => {
              const q = sheet.outcome.barcode.cleaned;
              close();
              router.push({ pathname: '/inventory', params: { q } });
            }}
            onLinked={(item) => setSheet({ kind: 'item', item, outcome: sheet.outcome })}
            onCreate={() => {
              const c = sheet.outcome.barcode.gtin ?? sheet.outcome.barcode.cleaned;
              close();
              router.push({ pathname: '/create-item', params: { code: c } });
            }}
          />
        ) : null}
      </Sheet>
    </View>
  );
}

export function ModeToggle({ mode, onChange }: { mode: ScanMode; onChange: (m: ScanMode) => void }) {
  return (
    <View accessibilityRole="tablist" className="flex-row self-center rounded-full bg-black/60 p-1">
      {(['single', 'continuous'] as const).map((m) => (
        <Pressable
          key={m}
          accessibilityRole="tab"
          accessibilityState={{ selected: mode === m }}
          accessibilityLabel={m === 'single' ? 'Single scan' : 'Continuous counting'}
          onPress={() => onChange(m)}
          className={`min-h-touch justify-center rounded-full px-5 ${mode === m ? 'bg-white' : ''}`}
        >
          <Text className={`text-base font-semibold ${mode === m ? 'text-black' : 'text-white'}`}>{m === 'single' ? 'Single' : 'Counting'}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/** Running tally at the bottom of the camera (spec §4.3): "Jasmine Rice 20lb ×3". */
export function TallyPanel({ rows, onReview }: { rows: readonly TallyRow[]; onReview: () => void }) {
  return (
    <View className="max-h-64 gap-2 rounded-2xl bg-surface/95 p-3">
      {rows.length === 0 ? (
        <Text className="text-base text-text-muted">Scan items to count them. Same barcode again adds one.</Text>
      ) : (
        <ScrollView className="max-h-40">
          {rows.map((r) => (
            <View key={r.itemId} className="min-h-touch flex-row items-center justify-between gap-2">
              <Text className="flex-1 text-base text-text" numberOfLines={1}>
                {Tally.label(r)}
              </Text>
              <Pressable accessibilityRole="button" accessibilityLabel={`One less ${r.itemName}`} onPress={() => TallyController.decrement(r.itemId)} className="min-h-touch min-w-touch items-center justify-center">
                <Text className="text-xl text-text">−</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${r.itemName}`} onPress={() => TallyController.remove(r.itemId)} className="min-h-touch justify-center px-2">
                <Text className="text-base text-danger">Remove</Text>
              </Pressable>
            </View>
          ))}
        </ScrollView>
      )}
      <Button
        label={`Review & apply (${Tally.total(rows)})`}
        size="lg"
        disabled={rows.length === 0}
        onPress={onReview}
        testID="review-apply"
      />
    </View>
  );
}

function OverlayButton({ label, a11y, onPress }: { label: string; a11y?: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11y ?? label}
      onPress={onPress}
      className="min-h-touch min-w-touch items-center justify-center rounded-full bg-black/60 px-4"
    >
      <Text className="text-base font-semibold text-white">{label}</Text>
    </Pressable>
  );
}

function ManualSheet({
  sheet,
  manual,
  setManual,
  close,
  lookup,
}: {
  sheet: SheetState;
  manual: string;
  setManual: (v: string) => void;
  close: () => void;
  lookup: (raw: string) => Promise<void>;
}) {
  return (
    <Sheet visible={sheet.kind === 'manual'} onClose={close} title="Enter barcode">
      <View className="gap-3">
        <Keypad value={manual} onChange={setManual} />
        <Button
          label="Look up"
          size="lg"
          disabled={manual.length === 0}
          onPress={() => {
            const code = manual;
            setManual('');
            void lookup(code);
          }}
        />
      </View>
    </Sheet>
  );
}
