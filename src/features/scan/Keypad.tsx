import { Pressable, Text, View } from 'react-native';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'] as const;
export const MAX_MANUAL_LENGTH = 32;

export class KeypadInput {
  static press(value: string, key: (typeof KEYS)[number]): string {
    if (key === 'clear') return '';
    if (key === 'back') return value.slice(0, -1);
    return value.length >= MAX_MANUAL_LENGTH ? value : value + key;
  }
}

/** Large numeric keypad for damaged barcodes (spec §4.3 manual entry). */
export function Keypad({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  return (
    <View className="gap-3">
      <Text
        accessibilityLabel={`Entered code ${value || 'empty'}`}
        className="min-h-primary rounded-xl bg-surface-muted px-4 py-3 text-center text-3xl font-semibold text-text"
        style={{ fontVariant: ['tabular-nums'] }}
      >
        {value || ' '}
      </Text>
      <View className="flex-row flex-wrap justify-between gap-y-2">
        {KEYS.map((k) => (
          <Pressable
            key={k}
            accessibilityRole="button"
            accessibilityLabel={k === 'back' ? 'Delete digit' : k === 'clear' ? 'Clear' : k}
            onPress={() => onChange(KeypadInput.press(value, k))}
            className="min-h-primary w-[31%] items-center justify-center rounded-xl bg-surface-muted"
          >
            <Text className="text-2xl font-semibold text-text">{k === 'back' ? '⌫' : k === 'clear' ? 'C' : k}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
