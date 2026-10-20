import { useEffect } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { create } from 'zustand';

export interface ToastSpec {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  durationMs?: number;
}

interface ToastState {
  current: (ToastSpec & { id: number }) | null;
}

const useToastStore = create<ToastState>(() => ({ current: null }));
let nextId = 1;

export class Toast {
  static show(spec: ToastSpec): number {
    const id = nextId++;
    useToastStore.setState({ current: { ...spec, id } });
    return id;
  }

  static hide(id?: number): void {
    const cur = useToastStore.getState().current;
    if (cur && (id == null || cur.id === id)) useToastStore.setState({ current: null });
  }
}

/** Mount once at the root. Bottom toast with an optional action (e.g. Undo for 10 s). */
export function ToastHost() {
  const current = useToastStore((s) => s.current);
  const insets = useSafeAreaInsets();
  useEffect(() => {
    if (!current) return;
    const t = setTimeout(() => Toast.hide(current.id), current.durationMs ?? 4000);
    return () => clearTimeout(t);
  }, [current]);
  if (!current) return null;
  return (
    <View
      pointerEvents="box-none"
      className="absolute left-4 right-4"
      style={{ bottom: Math.max(insets.bottom, 16) + 56 }}
    >
      <View accessibilityRole="alert" className="flex-row items-center gap-3 rounded-2xl bg-text px-4 py-3">
        <Text className="flex-1 text-base text-bg">{current.message}</Text>
        {current.actionLabel && current.onAction ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={current.actionLabel}
            onPress={() => {
              Toast.hide(current.id);
              current.onAction?.();
            }}
            className="min-h-touch justify-center px-3"
          >
            <Text className="text-base font-bold text-accent">{current.actionLabel}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
