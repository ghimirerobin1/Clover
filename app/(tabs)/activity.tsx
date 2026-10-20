import { View } from 'react-native';

import { EmptyState } from '../../src/components';

export default function ActivityScreen() {
  return (
    <View className="flex-1 bg-bg">
      <EmptyState title="No activity yet" message="Stock change history lands in Milestone 4." />
    </View>
  );
}
