import { ApiError } from './client.ts';
import type { NativeApp } from './auth.ts';

/**
 * N1: the phone shell's secure storage (iOS Keychain / Android Keystore), exposed to the web app as
 * `window.JansetuNative.secureStore` by the Capacitor shell before the app starts. The refresh token lives there and
 * nowhere else: never in localStorage, sessionStorage, IndexedDB, cookies, logs or URLs.
 */
export interface SecureStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

declare global { interface Window { JansetuNative?: { secureStore?: unknown } } }

const isStore = (v: unknown): v is SecureStore => !!v && typeof v === 'object'
  && ['get', 'set', 'remove'].every((k) => typeof (v as Record<string, unknown>)[k] === 'function');

/** The shell's secure store when running inside the phone app, else null (a browser: cookie or memory sessions). */
export function nativeSecureStore(): SecureStore | null {
  if (typeof window === 'undefined') return null;
  const s = window.JansetuNative?.secureStore;
  return isStore(s) ? s : null;
}

/** One refresh token per app (customer / workspace). */
export const refreshTokenKey = (app: NativeApp) => `jansetu.refresh.${app}`;

/**
 * Rotates the stored refresh token: the new one is written before the access token is used. A refused refresh (401)
 * removes the stored token (the session is over); a network failure keeps it (the server's retry window covers an
 * answer that was lost on the way).
 */
export async function rotateNative<T extends { refreshToken: string }>(store: SecureStore, app: NativeApp,
  refresh: (refreshToken: string) => Promise<T>): Promise<T> {
  const key = refreshTokenKey(app);
  const current = await store.get(key);
  if (!current) throw new ApiError(401, 'Please sign in again', 'SESSION_ENDED');
  try {
    const r = await refresh(current);
    await store.set(key, r.refreshToken);
    return r;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) await store.remove(key);
    throw err;
  }
}
