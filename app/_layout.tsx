import '../global.css';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ToastHost } from '../src/components';
import { StockSheetHost } from '../src/features/stock/StockSheet';
import { useCatalogSync } from '../src/sync/useCatalogSync';

function SyncHost() {
  useCatalogSync();
  return null;
}

export default function RootLayout() {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <SafeAreaProvider>
        <StatusBar style="auto" />
        <SyncHost />
        <Stack>
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="item/[id]" options={{ title: 'Item', headerBackTitle: 'Back' }} />
        </Stack>
        <StockSheetHost />
        <ToastHost />
      </SafeAreaProvider>
    </QueryClientProvider>
  );
}
