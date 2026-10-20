import type { ReactNode } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from './Button';

export interface SheetProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  testID?: string;
}

/**
 * Minimal bottom sheet built on RN `Modal` (no extra native deps).
 * Stock actions (Milestone 4) open in this so the scan context stays underneath (spec §4.1).
 */
export function Sheet({ visible, onClose, title, children, testID }: SheetProps) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View className="flex-1 justify-end">
        <Pressable
          testID={testID ? `${testID}-backdrop` : undefined}
          accessibilityLabel="Close sheet"
          onPress={onClose}
          className="absolute inset-0 bg-black/40"
        />
        <View
          testID={testID}
          accessibilityViewIsModal
          className="rounded-t-3xl border-t border-border bg-surface px-5 pt-3"
          style={{ paddingBottom: Math.max(insets.bottom, 16) }}
        >
          <View className="mb-3 h-1.5 w-10 self-center rounded-full bg-border" />
          <View className="mb-2 flex-row items-center justify-between">
            <Text accessibilityRole="header" className="flex-1 text-lg font-semibold text-text">
              {title ?? ''}
            </Text>
            {/* Explicit close: the backdrop is hidden from screen readers by accessibilityViewIsModal. */}
            <Button label="Close" variant="ghost" onPress={onClose} />
          </View>
          {children}
        </View>
      </View>
    </Modal>
  );
}
