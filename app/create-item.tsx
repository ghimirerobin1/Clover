import { useLocalSearchParams } from 'expo-router';

import { CreateItemScreen } from '../src/features/create';

export default function CreateItemRoute() {
  const { code } = useLocalSearchParams<{ code?: string }>();
  return <CreateItemScreen code={typeof code === 'string' ? code : ''} />;
}
