import { View } from 'react-native';

import { EmptyState } from '../../src/components';

export default function LowStockScreen() {
  return (
    <View className="flex-1 bg-bg">
      <EmptyState title="Nothing low on stock" message="Low-stock tracking lands in Milestone 5." />
    </View>
  );
}
