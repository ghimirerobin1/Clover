import { View } from 'react-native';

import { EmptyState } from '../../src/components';

export default function InventoryScreen() {
  return (
    <View className="flex-1 bg-bg">
      <EmptyState title="No items yet" message="Catalog sync and search land in Milestone 2." />
    </View>
  );
}
