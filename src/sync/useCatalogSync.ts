import { useEffect } from 'react';
import { AppState } from 'react-native';

import { DELTA_INTERVAL_MS } from './CatalogSync';
import { SyncController } from './SyncController';

/** Sync on launch, on foreground, and every 10 min while active (spec §4.2). Mount once at the root. */
export function useCatalogSync(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      timer ??= setInterval(() => void SyncController.sync(), DELTA_INTERVAL_MS);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    void SyncController.hydrate().then(() => SyncController.sync());
    start();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void SyncController.sync();
        start();
      } else {
        stop();
      }
    });
    return () => {
      stop();
      sub.remove();
    };
  }, []);
}
