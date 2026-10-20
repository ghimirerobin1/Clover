import { Redirect } from 'expo-router';

/** Scan is the default landing tab (spec §4.1). */
export default function Index() {
  return <Redirect href="/scan" />;
}
