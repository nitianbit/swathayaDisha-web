import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ApiError, authApi, createApiClient, markerStore, samePrincipal, sessionChannel, withSessionLock,
  type ApiClient, type PendingMarker, type Principal,
} from '@jansetu/api';

const APP = 'customer';

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

  const signOut = useCallback((notice?: string) => {
    endLocally(notice);
    channel?.post({ type: 'signed-out' });
    void withSessionLock(APP, async () => { await authRef.current?.logoutSession(); }).catch(() => undefined);
  }, [endLocally, channel]);

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
      const r = await authRef.current!.refreshSession();
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
    renew: (sent) => renewRef.current(sent),
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
    try {
      await withSessionLock(APP, async () => {
        const r = await auth.refreshSession();
        if (gen !== generation.current) return;
        await establish(gen, r.token, r.expiresIn);
      });
    } catch {
      if (gen === generation.current) { token.current = null; setState((s) => (s.status === 'restoring' ? { status: 'signed_out' } : s)); }
    }
  }, [auth, establish]);

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
      const signedIn = await auth.verifyOtpSession('user', { phone }, otp);
      if (gen !== generation.current) return;
      if (!signedIn?.token) throw new ApiError(502, 'Sign-in did not return a session. Please try again.');
      if (await establish(gen, signedIn.token, signedIn.expiresIn) && principal.current) {
        channel?.post({ type: 'signed-in', ...principal.current });
      }
    });
  }, [auth, establish, channel]);

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
