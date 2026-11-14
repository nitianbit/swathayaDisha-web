import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, authApi, createApiClient, type ApiClient, type OtpTarget, type UserType } from '@jansetu/api';

/** Who may sign in to the workspace today. HR and doctors join when their modules exist. */
export type StaffRole = Extract<UserType, 'admin' | 'pharmacy'>;
export const STAFF_ROLES: readonly StaffRole[] = ['admin', 'pharmacy'];

export interface StaffUser {
  role: StaffRole;
  /** The account id; for pharmacy staff this is the pharmacy's id (`/auth/profile` returns the pharmacy). */
  id: string;
  name: string;
  raw: Record<string, unknown>;
}

type SessionState =
  | { status: 'signed_out'; notice?: string }
  | { status: 'signed_in'; user: StaffUser };

/**
 * Memory that lives exactly as long as the signed-in session: never written to browser storage, cleared on sign-out.
 * For work that must survive leaving a page (e.g. an unconfirmed customer return), not for caching server data.
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
  requestCode: (role: StaffRole, target: OtpTarget) => Promise<void>;
  verifyCode: (role: StaffRole, target: OtpTarget, otp: string) => Promise<void>;
  signOut: (notice?: string) => void;
}

const SessionContext = createContext<SessionValue | null>(null);

function displayName(user: Record<string, unknown>, role: StaffRole): string {
  for (const key of ['name', 'fullName', 'pharmacyName', 'shopName', 'firstName']) {
    const v = user[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return role === 'admin' ? 'Admin' : 'Pharmacy';
}

/**
 * The staff token lives in memory only: a page reload signs the user out. This is deliberate until the backend
 * offers HttpOnly-cookie sessions (docs/PLAN.md, W-auth). Nothing about the session is written to storage.
 */
export function SessionProvider({ baseUrl, children }: { baseUrl: string; children: ReactNode }) {
  const queryClient = useQueryClient();
  const token = useRef<string | null>(null);
  // Results of a request started before a sign-out must not sign anyone back in.
  const generation = useRef(0);
  // Aborted on sign-out: every request issued under the ended session is cancelled.
  const sessionAbort = useRef(new AbortController());
  // One map per session. A handler still running from an ended session holds that session's memory object and
  // writes only into its discarded map, never into the next session's.
  const [store, setStore] = useState(() => new Map<string, unknown>());
  const memory = useMemo<SessionMemory>(() => ({
    get: <T,>(key: string) => store.get(key) as T | undefined,
    set: (key, value) => { store.set(key, value); },
    delete: (key) => { store.delete(key); },
  }), [store]);
  const [state, setState] = useState<SessionState>({ status: 'signed_out' });

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
    // Only a 401 for the token in use now ends the session; a late answer for an older token changes nothing.
    onUnauthorized: (sent) => {
      if (sent === token.current) signOut('Your session has ended. Please sign in again.');
    },
  }), [baseUrl, signOut]);

  const auth = useMemo(() => authApi(api), [api]);

  const requestCode = useCallback(async (role: StaffRole, target: OtpTarget) => {
    await auth.sendOtp(role, target);
  }, [auth]);

  const verifyCode = useCallback(async (role: StaffRole, target: OtpTarget, otp: string) => {
    const gen = generation.current;
    const signedIn = await auth.verifyOtp(role, target, otp);
    if (gen !== generation.current) return;
    if (!signedIn?.token) throw new ApiError(502, 'Sign-in did not return a session. Please try again.');
    token.current = signedIn.token;
    let profile;
    try {
      profile = await auth.profile();
    } catch (err) {
      if (gen === generation.current) token.current = null;
      throw err;
    }
    if (gen !== generation.current) return;
    // The server's view of the account decides, not the button the user pressed.
    if (profile?.userRole !== role) {
      token.current = null;
      throw new ApiError(403, 'This account cannot use the staff workspace.');
    }
    const raw = profile.user ?? {};
    const id = typeof raw._id === 'string' ? raw._id : '';
    if (!/^[0-9a-fA-F]{24}$/.test(id)) {
      token.current = null;
      throw new ApiError(502, 'Sign-in returned an incomplete profile. Please try again.');
    }
    setState({ status: 'signed_in', user: { role, id, name: displayName(raw, role), raw } });
  }, [auth]);

  const value = useMemo(() => ({ state, api, memory, requestCode, verifyCode, signOut }),
    [state, api, memory, requestCode, verifyCode, signOut]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}

/** For screens that render only when signed in. */
export function useStaff(): StaffUser {
  const { state } = useSession();
  if (state.status !== 'signed_in') throw new Error('useStaff while signed out');
  return state.user;
}
