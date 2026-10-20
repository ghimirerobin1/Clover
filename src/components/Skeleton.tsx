import { useEffect, useState } from 'react';
import { Animated, type DimensionValue, View } from 'react-native';

import { Tokens } from '../theme/tokens';

export interface SkeletonProps {
  width?: DimensionValue;
  height?: number;
  /** Render N stacked bars (e.g. a list placeholder). */
  lines?: number;
  testID?: string;
}

export function Skeleton({ width = '100%', height = 16, lines = 1, testID }: SkeletonProps) {
  const [opacity] = useState(() => new Animated.Value(0.5));

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: Tokens.motion.slow * 3, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.5, duration: Tokens.motion.slow * 3, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);

  return (
    <View testID={testID} accessibilityLabel="Loading" accessibilityRole="progressbar" className="gap-2">
      {Array.from({ length: lines }, (_, i) => (
        <Animated.View
          key={i}
          className="rounded-md bg-surface-muted"
          style={{ width, height, opacity }}
        />
      ))}
    </View>
  );
}
