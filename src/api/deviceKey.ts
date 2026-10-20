import * as SecureStore from 'expo-secure-store';

const KEY = 'stockroom.appKey';

/** The per-device proxy key lives only in the OS keychain/keystore (spec §1). */
export class DeviceKey {
  static get(): Promise<string | null> {
    return SecureStore.getItemAsync(KEY);
  }

  static set(value: string): Promise<void> {
    return SecureStore.setItemAsync(KEY, value);
  }

  static clear(): Promise<void> {
    return SecureStore.deleteItemAsync(KEY);
  }
}
