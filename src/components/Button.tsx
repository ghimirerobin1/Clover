import { ActivityIndicator, Pressable, Text } from 'react-native';

export type ButtonVariant = 'primary' | 'secondary' | 'destructive' | 'ghost';
export type ButtonSize = 'md' | 'lg';

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  /** `lg` = 56pt primary action, `md` = 48pt minimum touch target (spec §5). */
  size?: ButtonSize;
  disabled?: boolean;
  loading?: boolean;
  accessibilityHint?: string;
  testID?: string;
}

export class ButtonStyles {
  static container(variant: ButtonVariant, size: ButtonSize, inactive: boolean): string {
    const base = 'flex-row items-center justify-center rounded-xl px-5';
    const height = size === 'lg' ? 'min-h-primary' : 'min-h-touch';
    const tone: Record<ButtonVariant, string> = {
      primary: 'bg-accent',
      secondary: 'bg-surface-muted border border-border',
      destructive: 'bg-danger',
      ghost: 'bg-transparent',
    };
    return `${base} ${height} ${tone[variant]}${inactive ? ' opacity-50' : ''}`;
  }

  static label(variant: ButtonVariant): string {
    const tone: Record<ButtonVariant, string> = {
      primary: 'text-accent-fg',
      secondary: 'text-text',
      destructive: 'text-white',
      ghost: 'text-accent',
    };
    return `text-base font-semibold ${tone[variant]}`;
  }
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  disabled = false,
  loading = false,
  accessibilityHint,
  testID,
}: ButtonProps) {
  const inactive = disabled || loading;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      onPress={onPress}
      className={ButtonStyles.container(variant, size, inactive)}
    >
      {loading ? <ActivityIndicator accessibilityLabel="Loading" /> : null}
      <Text className={`${ButtonStyles.label(variant)}${loading ? ' ml-2' : ''}`}>{label}</Text>
    </Pressable>
  );
}
