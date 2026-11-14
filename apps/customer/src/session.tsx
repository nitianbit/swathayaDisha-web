import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, authApi, createApiClient, type ApiClient } from '@jansetu/api';

export interface Customer {
  /** The customer's account id (`/auth/profile`). */
  id: string;
}

type SessionState = { status: 'signed_out'; notice?: string } | { status: 'signed_in'; customer: Customer };

/** Lives exactly as long as the signed-in session; never browser storage. One map per session. */
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

/**
 * Customer session. In the browser the token lives in memory only (a reload signs out), as in the staff workspace;
 * the native shell will keep it in the device's secure storage (W3b). Requests of an ended session are cancelled, and
 * only a 401 for the token in use ends the session.
 */
export function SessionProvider({ baseUrl, children }: { baseUrl: string; children: ReactNode }) {
  const queryClient = useQueryClient();
  const token = useRef<string | null>(null);
  const generation = useRef(0);
  const sessionAbort = useRef(new AbortController());
  const [state, setState] = useState<SessionState>({ status: 'signed_out' });
  // A handler still running from an ended session holds that session's memory and writes only into its own map.
  const [store, setStore] = useState(() => new Map<string, unknown>());
  const memory = useMemo<SessionMemory>(() => ({
    get: <T,>(key: string) => store.get(key) as T | undefined,
    set: (key, value) => { store.set(key, value); },
    delete: (key) => { store.delete(key); },
  }), [store]);

  const signOut = useCallback((notice?: string) => {
    generation.current += 1;
    token.current = null;
    sessionAbort.current.abort();
    sessionAbort.current = new AbortController();
    setStore(new Map());
    queryClient.clear();
    setState({ status: 'signed_out', notice });
  }, [queryClient]);

  const api = useMemo(() => createApiClient({
    baseUrl,
    getToken: () => token.current,
    getSessionSignal: () => sessionAbort.current.signal,
    onUnauthorized: (sent) => { if (sent === token.current) signOut('Your session has ended. Please sign in again.'); },
  }), [baseUrl, signOut]);
  const auth = useMemo(() => authApi(api), [api]);

  const requestCode = useCallback(async (phone: string) => { await auth.sendOtp('user', { phone }); }, [auth]);

  const verifyCode = useCallback(async (phone: string, otp: string) => {
    const gen = generation.current;
    const signedIn = await auth.verifyOtp('user', { phone }, otp);
    if (gen !== generation.current) return;
    if (!signedIn?.token) throw new ApiError(502, 'Sign-in did not return a session. Please try again.');
    token.current = signedIn.token;
    try {
      const profile = await auth.profile();
      if (gen !== generation.current) return;
      const id = typeof profile?.user?._id === 'string' ? profile.user._id : '';
      if (profile?.userRole !== 'user' || !/^[0-9a-fA-F]{24}$/.test(id)) {
        throw new ApiError(403, 'This account cannot use the customer app.');
      }
      setState({ status: 'signed_in', customer: { id } });
    } catch (err) {
      if (gen === generation.current) token.current = null;
      throw err;
    }
  }, [auth]);

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
