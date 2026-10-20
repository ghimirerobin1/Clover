import { useLocalSearchParams } from 'expo-router';

import { ItemDetailScreen } from '../../src/features/inventory/ItemDetailScreen';

export default function ItemRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ItemDetailScreen id={String(id)} />;
}
