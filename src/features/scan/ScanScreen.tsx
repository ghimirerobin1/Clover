import { useQuery } from '@tanstack/react-query';
import { CameraView, useCameraPermissions, type BarcodeType } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { ProxyClient } from '../../api/proxy';
import { Button, EmptyState, Sheet } from '../../components';
import { AppDatabase } from '../../db/ExpoSqlDb';
import type { ItemRow } from '../../db/items';
import { SettingsRepo } from '../../db/settings';
import { Barcode } from '../../lib/barcode';
import { Keypad } from './Keypad';
import { LookupChain, ScanDebouncer, type LookupOutcome } from './LookupChain';
import { CandidateList, ItemSummary, NotFound } from './ScanSheets';

/** Spec §1: EAN-13, EAN-8, UPC-A, UPC-E, Code128, Code39, QR. */
export const BARCODE_TYPES: BarcodeType[] = ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'code39', 'qr'];
const ZOOM_STEP = 0.1;

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
        canCreate: (await SettingsRepo.get(db, 'create_items_enabled')) === '1',
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
  const debouncer = useRef(new ScanDebouncer());
  const prefs = useScanPrefs();

  const lookup = useCallback(
    async (raw: string, type?: string) => {
      if (!prefs.data) return;
      setSheet({ kind: 'busy', code: raw });
      const db = await AppDatabase.get();
      const outcome = await LookupChain.resolve(db, remote, raw, { type, ...prefs.data });
      void Haptics.notificationAsync(
        outcome.kind === 'not_found' ? Haptics.NotificationFeedbackType.Warning : Haptics.NotificationFeedbackType.Success,
      );
      setSheet(outcome.kind === 'found' ? { kind: 'item', item: outcome.item, outcome } : { kind: 'result', outcome });
    },
    [prefs.data],
  );

  const scanning = sheet.kind === 'closed';
  const onScanned = useCallback(
    ({ data, type }: { data: string; type: string }) => {
      if (!scanning || !debouncer.current.accept(data)) return;
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      void lookup(data, type);
    },
    [lookup, scanning],
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
      <View className="absolute bottom-6 left-4 right-4 gap-3">
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
          <CandidateList items={sheet.outcome.candidates} onPick={(item) => setSheet({ kind: 'item', item, outcome: sheet.outcome })} />
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
            onCreate={close /* Create item flow lands in Milestone 6 behind canCreateItems. */}
          />
        ) : null}
      </Sheet>
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
