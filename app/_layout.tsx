import '../global.css';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ToastHost } from '../src/components';
import { AppDatabase } from '../src/db/ExpoSqlDb';
import { AppPrefs } from '../src/features/settings/AppPrefs';
import { StockSheetHost } from '../src/features/stock/StockSheet';
import { useCatalogSync } from '../src/sync/useCatalogSync';

function SyncHost() {
  useCatalogSync();
  useEffect(() => {
    // Apply the saved theme override (system / light / dark) before the user reaches Settings.
    void AppDatabase.get()
      .then((db) => AppPrefs.theme(db))
      .then(AppPrefs.applyTheme)
      .catch(() => undefined);
  }, []);
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
          <Stack.Screen name="create-item" options={{ title: 'New item', headerBackTitle: 'Back' }} />
          <Stack.Screen name="batch" options={{ title: 'Review & apply', headerBackTitle: 'Back' }} />
        </Stack>
        <StockSheetHost />
        <ToastHost />
      </SafeAreaProvider>
    </QueryClientProvider>
  );
}
