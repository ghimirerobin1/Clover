import { Text, View } from 'react-native';

import { Button } from './Button';

export interface EmptyStateProps {
  title: string;
  message?: string;
  /** Spec §5: every empty state offers a next action. */
  actionLabel?: string;
  onAction?: () => void;
  testID?: string;
}

export function EmptyState({ title, message, actionLabel, onAction, testID }: EmptyStateProps) {
  return (
    <View testID={testID} className="flex-1 items-center justify-center gap-3 px-8 py-12">
      <Text accessibilityRole="header" className="text-center text-xl font-semibold text-text">
        {title}
      </Text>
      {message ? <Text className="text-center text-base text-text-muted">{message}</Text> : null}
      {actionLabel && onAction ? (
        <View className="mt-2 self-stretch">
          <Button label={actionLabel} onPress={onAction} variant="secondary" />
        </View>
      ) : null}
    </View>
  );
}
