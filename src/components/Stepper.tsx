import { Pressable, Text, View } from 'react-native';

export interface StepperProps {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label: string;
  testID?: string;
}

export class StepperMath {
  /** Clamp to [min, max] and force an integer (stock is whole units). */
  static clamp(value: number, min: number, max: number): number {
    const rounded = Math.round(value);
    return Math.min(max, Math.max(min, rounded));
  }

  static next(value: number, delta: number, min: number, max: number): number {
    return StepperMath.clamp(value + delta, min, max);
  }
}

function StepButton(props: { glyph: string; label: string; disabled: boolean; onPress: () => void; testID?: string }) {
  return (
    <Pressable
      testID={props.testID}
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={`min-h-primary min-w-primary items-center justify-center rounded-xl bg-surface-muted${
        props.disabled ? ' opacity-40' : ''
      }`}
    >
      <Text className="text-2xl font-semibold text-text">{props.glyph}</Text>
    </Pressable>
  );
}

export function Stepper({
  value,
  onChange,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  step = 1,
  label,
  testID,
}: StepperProps) {
  return (
    <View
      testID={testID}
      className="flex-row items-center justify-between gap-3"
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ min, max, now: value }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === 'increment') onChange(StepperMath.next(value, step, min, max));
        if (e.nativeEvent.actionName === 'decrement') onChange(StepperMath.next(value, -step, min, max));
      }}
    >
      <StepButton
        testID={testID ? `${testID}-dec` : undefined}
        glyph="−"
        label={`Decrease ${label}`}
        disabled={value <= min}
        onPress={() => onChange(StepperMath.next(value, -step, min, max))}
      />
      <Text
        className="flex-1 text-center text-4xl font-bold text-text"
        style={{ fontVariant: ['tabular-nums'] }}
        testID={testID ? `${testID}-value` : undefined}
      >
        {value}
      </Text>
      <StepButton
        testID={testID ? `${testID}-inc` : undefined}
        glyph="+"
        label={`Increase ${label}`}
        disabled={value >= max}
        onPress={() => onChange(StepperMath.next(value, step, min, max))}
      />
    </View>
  );
}
