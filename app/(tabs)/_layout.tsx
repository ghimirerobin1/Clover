import { Tabs } from 'expo-router';
import { useColorScheme } from 'react-native';

import { LowStock, useLowStockCount } from '../../src/features/lowstock';
import { Tokens } from '../../src/theme/tokens';

/** Scan is the default tab (spec §4.1). */
export const unstable_settings = { initialRouteName: 'scan' };

export default function TabsLayout() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const lowCount = useLowStockCount();
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: Tokens.rgb(scheme, 'accent'),
        tabBarInactiveTintColor: Tokens.rgb(scheme, 'text-muted'),
        tabBarStyle: { backgroundColor: Tokens.rgb(scheme, 'surface'), borderTopColor: Tokens.rgb(scheme, 'border') },
        tabBarLabelStyle: { fontSize: 13, fontWeight: '600' },
        tabBarIconStyle: { display: 'none' },
        headerStyle: { backgroundColor: Tokens.rgb(scheme, 'surface') },
        headerTintColor: Tokens.rgb(scheme, 'text'),
      }}
    >
      <Tabs.Screen name="scan" options={{ title: 'Scan' }} />
      <Tabs.Screen name="inventory" options={{ title: 'Inventory' }} />
      <Tabs.Screen name="low-stock" options={{ title: 'Low Stock', tabBarBadge: LowStock.badge(lowCount.data ?? 0) }} />
      <Tabs.Screen name="activity" options={{ title: 'Activity' }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
    </Tabs>
  );
}
