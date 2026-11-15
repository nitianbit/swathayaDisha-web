const native = { value: false };
const calls: string[] = [];
const store = new Map<string, unknown>();

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => native.value } }));
vi.mock('@aparajita/capacitor-secure-storage', () => ({
  KeychainAccess: { whenUnlockedThisDeviceOnly: 1 },
  SecureStorage: {
    setSynchronize: async (v: boolean) => { calls.push(`sync:${v}`); },
    setDefaultKeychainAccess: async (v: number) => { calls.push(`access:${v}`); },
    setKeyPrefix: async (v: string) => { calls.push(`prefix:${v}`); },
    get: async (k: string) => (store.has(k) ? store.get(k) : null),
    set: async (k: string, v: unknown) => { store.set(k, v); },
    remove: async (k: string) => store.delete(k),
  },
}));

import { nativeSecureStore } from '@jansetu/api';
import { installNativeShell } from './nativeShell.ts';

describe('installNativeShell (N2)', () => {
  beforeEach(() => { delete window.JansetuNative; calls.length = 0; store.clear(); });

  it('does nothing in a browser: the session keeps cookie or memory mode', async () => {
    native.value = false;
    await installNativeShell();
    expect(window.JansetuNative).toBeUndefined();
    expect(nativeSecureStore()).toBeNull();
  });

  it('in the phone app: the OS secure store, never synced, this device only, behind its own prefix', async () => {
    native.value = true;
    await installNativeShell();
    expect(calls).toEqual(['sync:false', 'access:1', 'prefix:swasthayadisha_']);
    const s = nativeSecureStore();
    expect(s).not.toBeNull();
    await s!.set('jansetu.refresh.customer', 'rt-1');
    await expect(s!.get('jansetu.refresh.customer')).resolves.toBe('rt-1');
    await s!.remove('jansetu.refresh.customer');
    await expect(s!.get('jansetu.refresh.customer')).resolves.toBeNull();
    store.set('odd', { not: 'a string' });
    await expect(s!.get('odd')).resolves.toBeNull(); // only strings are tokens
  });
});
