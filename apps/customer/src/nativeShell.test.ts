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
import { installNativeShell, startApp } from './nativeShell.ts';

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

describe('startApp (N2)', () => {
  it('a failed secure-store start never renders the app (no fallback session); retry renders it once ready', async () => {
    let fail = true;
    const install = vi.fn(async () => { if (fail) throw new Error('keystore unavailable'); });
    const renderApp = vi.fn();
    let retry: (() => void) | undefined;
    const renderError = vi.fn((r: () => void) => { retry = r; });
    await startApp(renderApp, renderError, install);
    expect(renderApp).not.toHaveBeenCalled();
    expect(renderError).toHaveBeenCalledOnce();
    fail = false;
    retry!();
    await vi.waitFor(() => expect(renderApp).toHaveBeenCalledOnce());
    expect(install).toHaveBeenCalledTimes(2);
  });
  it('in a browser the app renders at once', async () => {
    native.value = false;
    const renderApp = vi.fn();
    await startApp(renderApp, vi.fn());
    expect(renderApp).toHaveBeenCalledOnce();
  });
});

describe('startApp retries (N2)', () => {
  it('an older retry that fails after a newer one succeeded does not cover the app with the error screen', async () => {
    const renders: string[] = [];
    let release!: (fail: boolean) => void;
    const slow = () => new Promise<void>((resolve, reject) => { release = (fail) => (fail ? reject(new Error('x')) : resolve()); });
    const first = startApp(() => renders.push('app'), () => renders.push('error'), slow); // attempt 1 pending
    const second = startApp(() => renders.push('app'), () => renders.push('error'), async () => undefined); // attempt 2 ok
    await second;
    release(true); // attempt 1 fails late
    await first;
    expect(renders).toEqual(['app']);
  });
});
