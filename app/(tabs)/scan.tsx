import { View } from 'react-native';

import { EmptyState } from '../../src/components';

export default function ScanScreen() {
  return (
    <View className="flex-1 bg-bg">
      <EmptyState title="Scanner coming soon" message="Camera scanning lands in Milestone 3." />
    </View>
  );
}
