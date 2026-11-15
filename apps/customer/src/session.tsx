import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ApiError, authApi, clearSignOutPending, createApiClient, markerStore, nativeSecureStore, nativeSignOut, refreshTokenKey, rotateNative,
  samePrincipal, sessionChannel, signOutPending,
  withSessionLock,
  type ApiClient, type PendingMarker, type Principal,
} from '@jansetu/api';

const APP = 'customer';
/** N1: inside the phone app the refresh token lives in the OS secure store (see nativeSession.ts). */
const NATIVE_APP = 'customer' as const;

export interface Customer {
  /** The customer's account id (`/auth/profile`). */
  id: string;
}

type SessionState = { status: 'restoring' } | { status: 'signed_out'; notice?: string } | { status: 'signed_in'; customer: Customer };

/**
 * Lives exactly as long as the signed-in session; one map per session. Pending once-only requests (booking create) are
 * also remembered across a reload as body-less markers (D4) and come back with `restored: true`.
 */
export interface SessionMemory {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  delete(key: string): void;
}

interface SessionValue {
  state: SessionState;
  api: ApiClient;
  memory: SessionMemory;
  requestCode: (phone: string) => Promise<void>;
  verifyCode: (phone: string, otp: string) => Promise<void>;
  signOut: (notice?: string) => void;
  /** Ends every session of this account on every device (POST /auth/sessions/revoke), then this one. */
  signOutEverywhere: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

const isPending = (v: unknown): v is PendingMarker =>
  !!v && typeof v === 'object' && typeof (v as PendingMarker).requestKey === 'string' && typeof (v as PendingMarker).attempts === 'number';

/**
 * Customer session (D4). In the browser the access token lives in memory and the session is an HttpOnly first-party
 * cookie the server rotates, so a reload keeps the customer signed in. Sign-in, refresh and sign-out run under one
 * lock shared by all tabs; a renewed token is installed only for the same customer; a different customer signing in,
 * or a sign-out, in another tab ends this tab's session. The native shell will use the device's secure storage.
 */
export function SessionProvider({ baseUrl, children }: { baseUrl: string; children: ReactNode }) {
  const queryClient = useQueryClient();
  const token = useRef<string | null>(null);
  const principal = useRef<Principal | null>(null);
  const markers = useRef<ReturnType<typeof markerStore> | null>(null);
  const renewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const generation = useRef(0);
  const sessionAbort = useRef(new AbortController());
  const channel = useMemo(() => sessionChannel(APP), []);
  const [state, setState] = useState<SessionState>({ status: 'restoring' });
  // A handler still running from an ended session holds that session's memory and writes only into its own map.
  const [store, setStore] = useState(() => new Map<string, unknown>());
  const memory = useMemo<SessionMemory>(() => ({
    get: <T,>(key: string) => store.get(key) as T | undefined,
    set: (key, value) => { store.set(key, value); if (isPending(value)) markers.current?.save(key, value); },
    delete: (key) => { store.delete(key); markers.current?.remove(key); },
  }), [store]);
  const authRef = useRef<ReturnType<typeof authApi> | null>(null);

  const endLocally = useCallback((notice?: string) => {
    generation.current += 1;
    token.current = null;
    principal.current = null;
    markers.current = null;
    clearTimeout(renewTimer.current);
    sessionAbort.current.abort();
    sessionAbort.current = new AbortController();
    setStore(new Map());
    queryClient.clear();
    setState({ status: 'signed_out', notice });
  }, [queryClient]);

  // D4: cookie sessions only when the API is on this app's own host (it forwards /api). A build that talks to a
  // separate API origin keeps the memory-only bearer session: a reload signs out (documented in README).
  const cookieMode = baseUrl === '';
  // N1: inside the phone app (the shell provides a secure store) sessions are native, whatever the base URL.
  const secure = useMemo(() => nativeSecureStore(), []);
  const mode: 'native' | 'cookie' | 'memory' = secure ? 'native' : cookieMode ? 'cookie' : 'memory';
  /** Renews the session: rotates the stored refresh token (native) or the cookie (web). */
  const rotate = () => (secure
    ? rotateNative(secure, NATIVE_APP, (rt) => authRef.current!.refreshNative(NATIVE_APP, rt))
    : authRef.current!.refreshSession());

  const signOut = useCallback((notice?: string) => {
    const tabToken = token.current; // the family this tab was using ends too, not only the cookie's
    endLocally(notice);
    channel?.post({ type: 'signed-out' });
    if (secure) {
      // Holds even if the secure store fails for a moment: marked pending first, the server told with whatever token
      // is at hand, the stored token removed (retried); an unfinished clean-up is finished at the next start.
      void withSessionLock(APP, async () => {
        const clean = await nativeSignOut(secure, NATIVE_APP, (rt) => authRef.current!.logoutNative(NATIVE_APP, rt, tabToken));
        if (!clean && !principal.current) {
          setState((s) => (s.status === 'signed_out'
            ? { status: 'signed_out', notice: `${s.notice ? `${s.notice} ` : ''}This phone could not clear its saved sign-in yet; it will be cleared when the app next opens.` }
            : s));
        }
      }).catch(() => undefined);
    } else if (cookieMode) {
      void withSessionLock(APP, async () => { await authRef.current?.logoutSession(tabToken); }).catch(() => undefined);
    }
  }, [endLocally, channel, cookieMode, secure]);

  const schedule = useCallback((expiresIn: number | undefined, renewFn: () => void) => {
    clearTimeout(renewTimer.current);
    if (!expiresIn || expiresIn <= 0) return;
    renewTimer.current = setTimeout(renewFn, Math.max(5, expiresIn - 60) * 1000);
  }, []);

  const renewRef = useRef<(sent: string | null) => Promise<string | null>>(async () => null);
  renewRef.current = async (sent) => withSessionLock(APP, async () => {
    const gen = generation.current;
    if (!principal.current) return null;
    if (token.current && sent !== null && token.current !== sent) return token.current;
    try {
      const r = await rotate();
      if (gen !== generation.current) return null;
      if (!samePrincipal(r.principal, principal.current)) {
        endLocally('Someone else signed in on this browser. Please sign in again.');
        return null;
      }
      token.current = r.token;
      schedule(r.expiresIn, () => void renewRef.current(token.current));
      return r.token;
    } catch {
      if (gen === generation.current) endLocally('Your session has ended. Please sign in again.');
      return null;
    }
  });

  const api = useMemo(() => createApiClient({
    baseUrl,
    getToken: () => token.current,
    getSessionSignal: () => sessionAbort.current.signal,
    ...(mode !== 'memory' ? { renew: (sent: string) => renewRef.current(sent) } : {}),
    onUnauthorized: (sent) => { if (sent === token.current) signOut('Your session has ended. Please sign in again.'); },
  }), [baseUrl, signOut]);
  const auth = useMemo(() => authApi(api), [api]);
  authRef.current = auth;

  const establish = useCallback(async (gen: number, accessToken: string, expiresIn: number | undefined) => {
    token.current = accessToken;
    try {
      const profile = await auth.profile();
      if (gen !== generation.current) return false;
      const id = typeof profile?.user?._id === 'string' ? profile.user._id : '';
      if (profile?.userRole !== 'user' || !/^[0-9a-fA-F]{24}$/.test(id)) {
        throw new ApiError(403, 'This account cannot use the customer app.');
      }
      principal.current = { userId: id, userType: 'user' };
      markers.current = markerStore(APP, id);
      const restored = new Map<string, unknown>();
      for (const [slot, m] of Object.entries(markers.current.all())) restored.set(slot, { ...m, uncertain: true, restored: true });
      setStore(restored);
      schedule(expiresIn, () => void renewRef.current(token.current));
      setState({ status: 'signed_in', customer: { id } });
      return true;
    } catch (err) {
      if (gen === generation.current) token.current = null;
      throw err;
    }
  }, [auth, schedule]);

  const restore = useCallback(async () => {
    const gen = generation.current;
    if (mode === 'memory') { setState((s) => (s.status === 'restoring' ? { status: 'signed_out' } : s)); return; }
    try {
      await withSessionLock(APP, async () => {
        // Another restore (or a sign-in) finished while this one waited for the lock: nothing to resume.
        if (principal.current || gen !== generation.current) return;
        // N1: a sign-out on this phone did not finish clearing the stored token: finish it, never resume.
        if (secure && signOutPending(NATIVE_APP)) {
          await nativeSignOut(secure, NATIVE_APP, (rt) => auth.logoutNative(NATIVE_APP, rt, null));
          throw new ApiError(401, 'Signed out', 'SESSION_ENDED');
        }
        const r = await rotate();
        if (gen !== generation.current) return;
        await establish(gen, r.token, r.expiresIn);
      });
    } catch {
      if (gen === generation.current) { token.current = null; setState((s) => (s.status === 'restoring' ? { status: 'signed_out' } : s)); }
    }
  }, [auth, establish, mode]);

  useEffect(() => { void restore(); }, [restore]);

  useEffect(() => channel?.listen((m) => {
    if (m.type === 'signed-out') {
      if (principal.current) endLocally('You signed out in another tab.');
    } else if (principal.current && !samePrincipal(principal.current, m)) {
      endLocally('Someone else signed in on this browser. Please sign in again.');
    } else if (!principal.current) {
      void restore();
    }
  }), [channel, endLocally, restore]);

  useEffect(() => () => { clearTimeout(renewTimer.current); }, []);

  const requestCode = useCallback(async (phone: string) => { await auth.sendOtp('user', { phone }); }, [auth]);

  const verifyCode = useCallback(async (phone: string, otp: string) => {
    await withSessionLock(APP, async () => {
      const gen = generation.current;
      let signedIn;
      if (secure) {
        // The token the phone still holds is ended by this sign-in; the new one is stored before it is used.
        const previous = await secure.get(refreshTokenKey(NATIVE_APP)).catch(() => null);
        const n = await auth.verifyOtpNative('user', { phone }, otp, NATIVE_APP, previous);
        try {
          await secure.set(refreshTokenKey(NATIVE_APP), n.refreshToken);
        } catch {
          // Not stored, so not usable: end the new session on the server rather than leave it behind.
          await auth.logoutNative(NATIVE_APP, n.refreshToken, n.token).catch(() => undefined);
          throw new ApiError(0, 'This phone could not save your sign-in. Please try again.', 'SECURE_STORE');
        }
        clearSignOutPending(NATIVE_APP); // the new token replaced whatever an unfinished sign-out left behind
        signedIn = n;
      } else {
        signedIn = cookieMode ? await auth.verifyOtpSession('user', { phone }, otp) : await auth.verifyOtp('user', { phone }, otp);
      }
      if (gen !== generation.current) return;
      if (!signedIn?.token) throw new ApiError(502, 'Sign-in did not return a session. Please try again.');
      if (await establish(gen, signedIn.token, signedIn.expiresIn) && principal.current) {
        channel?.post({ type: 'signed-in', ...principal.current });
      }
    });
  }, [auth, establish, channel, cookieMode, secure]);

  const signOutEverywhere = useCallback(async () => {
    await auth.revokeSessions();
    signOut('You have been signed out on all your devices.');
  }, [auth, signOut]);

  const value = useMemo(() => ({ state, api, memory, requestCode, verifyCode, signOut, signOutEverywhere }),
    [state, api, memory, requestCode, verifyCode, signOut, signOutEverywhere]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}

export function useCustomer(): Customer {
  const { state } = useSession();
  if (state.status !== 'signed_in') throw new Error('useCustomer while signed out');
  return state.customer;
}
