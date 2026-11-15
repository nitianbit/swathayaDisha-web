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

/*
 * Sign-out on the phone must hold even when the secure store fails for a moment. A durable "signed out" flag (a plain
 * '1', no token or personal data) is set FIRST; while it is set the app never resumes a session, and every start
 * finishes the clean-up. The server is told independently of the store (with the access token in use even if the
 * stored refresh token cannot be read).
 */
const signedOutKey = (app: NativeApp) => `jansetu.native.signedOut.${app}`;

/** A sign-out on this phone has not finished clearing the stored token yet. */
export function signOutPending(app: NativeApp): boolean {
  try { return localStorage.getItem(signedOutKey(app)) === '1'; } catch { return false; }
}
/** A new sign-in stored its token: no sign-out is pending any more. */
export function clearSignOutPending(app: NativeApp): void {
  try { localStorage.removeItem(signedOutKey(app)); } catch { /* nothing to clear */ }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ends the phone's session: marks sign-out pending, tells the server (with the stored refresh token if it can be read,
 * and whatever access token the caller passes to `logout`), and removes the stored token (retried). Resolves true when
 * the store is clean (the pending mark is then cleared); false when the token could not be removed yet (the mark stays,
 * so the next start retries and never resumes the session).
 */
export async function nativeSignOut(store: SecureStore, app: NativeApp,
  logout: (refreshToken: string | null) => Promise<unknown>): Promise<boolean> {
  try { localStorage.setItem(signedOutKey(app), '1'); } catch { /* the store clean-up below still runs */ }
  const key = refreshTokenKey(app);
  let stored: string | null = null;
  try { stored = await store.get(key); } catch { stored = null; }
  const told = logout(stored).then(() => true, () => false);
  let removed = false;
  for (let attempt = 0; attempt < 3 && !removed; attempt++) {
    try { await store.remove(key); removed = true; } catch { await pause(150 * (attempt + 1)); }
  }
  await told;
  if (removed) clearSignOutPending(app);
  return removed;
}
