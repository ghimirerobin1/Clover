import { useLocalSearchParams } from 'expo-router';

import { BatchScreen } from '../src/features/batch';

export default function BatchRoute() {
  const { source } = useLocalSearchParams<{ source?: string }>();
  return <BatchScreen source={source === 'queue' ? 'queue' : 'tally'} />;
}
