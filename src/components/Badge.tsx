import { Text, View } from 'react-native';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export interface BadgeProps {
  label: string;
  tone?: BadgeTone;
  accessibilityLabel?: string;
  testID?: string;
}

export class BadgeStyles {
  static container(tone: BadgeTone): string {
    const map: Record<BadgeTone, string> = {
      neutral: 'bg-surface-muted',
      accent: 'bg-accent/15',
      success: 'bg-success/15',
      warning: 'bg-warning/15',
      danger: 'bg-danger/15',
    };
    return `self-start rounded-full px-2.5 py-1 ${map[tone]}`;
  }

  static text(tone: BadgeTone): string {
    const map: Record<BadgeTone, string> = {
      neutral: 'text-text-muted',
      accent: 'text-accent',
      success: 'text-success',
      warning: 'text-warning',
      danger: 'text-danger',
    };
    return `text-sm font-semibold ${map[tone]}`;
  }

  /**
   * Stock badge tone (spec §4.5): red ≤ 0, amber ≤ threshold, else green.
   * `threshold` is the already-resolved threshold (resolution lands in Milestone 5).
   */
  static toneForStock(quantity: number, threshold: number): BadgeTone {
    if (quantity <= 0) return 'danger';
    if (quantity <= threshold) return 'warning';
    return 'success';
  }
}

export function Badge({ label, tone = 'neutral', accessibilityLabel, testID }: BadgeProps) {
  return (
    <View testID={testID} className={BadgeStyles.container(tone)} accessibilityLabel={accessibilityLabel ?? label}>
      <Text className={BadgeStyles.text(tone)} style={{ fontVariant: ['tabular-nums'] }}>
        {label}
      </Text>
    </View>
  );
}
