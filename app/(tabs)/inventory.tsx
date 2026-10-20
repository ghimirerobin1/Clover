import { useLocalSearchParams } from 'expo-router';

import { InventoryScreen } from '../../src/features/inventory/InventoryScreen';

export default function InventoryRoute() {
  const { q } = useLocalSearchParams<{ q?: string }>();
  // Keyed so "Search manually" from the scanner starts a fresh search with the scanned code.
  return <InventoryScreen key={q ?? ''} initialSearch={q} />;
}
