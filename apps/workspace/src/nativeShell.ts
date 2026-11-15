import { Capacitor } from '@capacitor/core';
import { KeychainAccess, SecureStorage } from '@aparajita/capacitor-secure-storage';

/**
 * N2: inside the phone app (Capacitor), hand the session code the OS secure store - iOS Keychain / Android Keystore -
 * as `window.JansetuNative.secureStore` (see packages/api nativeSession.ts). Only the refresh token is kept there:
 * never synced to iCloud, readable on this device only while it is unlocked, under this app's own key prefix. In a
 * browser nothing happens (cookie or memory sessions).
 */
export async function installNativeShell(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  await SecureStorage.setSynchronize(false);
  await SecureStorage.setDefaultKeychainAccess(KeychainAccess.whenUnlockedThisDeviceOnly);
  await SecureStorage.setKeyPrefix('swasthayadisha_');
  window.JansetuNative = {
    secureStore: {
      get: async (key: string) => {
        const value = await SecureStorage.get(key, false);
        return typeof value === 'string' ? value : null;
      },
      set: async (key: string, value: string) => { await SecureStorage.set(key, value, false); },
      remove: async (key: string) => { await SecureStorage.remove(key); },
    },
  };
}
