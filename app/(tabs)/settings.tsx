import { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { ProxyClient, type Health } from '../../src/api/proxy';
import { Badge, Button, Skeleton } from '../../src/components';
import { ApiError } from '../../src/lib/errors';

type HealthState = { kind: 'loading' } | { kind: 'ok'; health: Health } | { kind: 'error'; message: string };

class HealthCheck {
  static async run(): Promise<HealthState> {
    try {
      return { kind: 'ok', health: await ProxyClient.health() };
    } catch (e) {
      return { kind: 'error', message: e instanceof ApiError ? e.message : 'Could not reach the proxy.' };
    }
  }
}

export default function SettingsScreen() {
  const [state, setState] = useState<HealthState>({ kind: 'loading' });

  useEffect(() => {
    let active = true;
    void HealthCheck.run().then((next) => {
      if (active) setState(next);
    });
    return () => {
      active = false;
    };
  }, []);

  const retry = () => {
    setState({ kind: 'loading' });
    void HealthCheck.run().then(setState);
  };

  return (
    <ScrollView className="flex-1 bg-bg" contentContainerClassName="gap-4 p-4">
      <View className="gap-3 rounded-2xl border border-border bg-surface p-4">
        <Text accessibilityRole="header" className="text-lg font-semibold text-text">
          Proxy connection
        </Text>
        <Text className="text-base text-text-muted">{ProxyClient.baseUrl()}</Text>
        {state.kind === 'loading' ? <Skeleton width={120} height={24} /> : null}
        {state.kind === 'ok' ? (
          <Badge
            tone="success"
            label={state.health.mock ? `Connected · mock mode · v${state.health.version}` : `Connected · v${state.health.version}`}
          />
        ) : null}
        {state.kind === 'error' ? (
          <>
            <Badge tone="danger" label="Unreachable" />
            <Text className="text-base text-text-muted">{state.message}</Text>
          </>
        ) : null}
        <Button label="Check again" variant="secondary" onPress={retry} />
      </View>
      <Text className="text-base text-text-muted">
        Device pairing, sync and preferences arrive in later milestones.
      </Text>
    </ScrollView>
  );
}
