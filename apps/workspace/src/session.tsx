import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ApiError, authApi, clearSignOutPending, createApiClient, markerStore, nativeSecureStore, nativeSignOut, refreshTokenKey, rotateNative,
  samePrincipal, sessionChannel, signOutPending,
  withSessionLock,
  type ApiClient, type OtpTarget, type PendingMarker, type Principal, type UserType,
} from '@jansetu/api';

/** Who may sign in to the workspace today. HR and doctors join when their modules exist. */
export type StaffRole = Extract<UserType, 'admin' | 'pharmacy'>;
export const STAFF_ROLES: readonly StaffRole[] = ['admin', 'pharmacy'];
const APP = 'workspace';
/** N1: inside the phone app the refresh token lives in the OS secure store (see nativeSession.ts). */
const NATIVE_APP = 'workspace' as const;

export interface StaffUser {
  role: StaffRole;
  /** The account id; for pharmacy staff this is the pharmacy's id (`/auth/profile` returns the pharmacy). */
  id: string;
  name: string;
  raw: Record<string, unknown>;
}

type SessionState =
  | { status: 'restoring' }
  | { status: 'signed_out'; notice?: string }
  | { status: 'signed_in'; user: StaffUser };

/**
 * Memory that lives exactly as long as the signed-in session, cleared on sign-out. For work that must survive leaving
 * a page (e.g. an unconfirmed customer return), not for caching server data. Pending once-only operations are also
 * remembered across a reload as body-less markers (D4); they come back with `restored: true`.
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

const isPending = (v: unknown): v is PendingMarker =>
  !!v && typeof v === 'object' && typeof (v as PendingMarker).requestKey === 'string' && typeof (v as PendingMarker).attempts === 'number';

/**
 * D4: the access token lives in memory only; the session itself is an HttpOnly first-party cookie that the server
 * rotates. A reload restores the session from the cookie. Sign-in, refresh and sign-out run under one lock shared by
 * all tabs; a renewed token is installed only for the person already signed in here, and a different person signing
 * in (or anyone signing out) in another tab ends this tab's session and everything held for it.
 */
export function SessionProvider({ baseUrl, children }: { baseUrl: string; children: ReactNode }) {
  const queryClient = useQueryClient();
  const token = useRef<string | null>(null);
  const principal = useRef<Principal | null>(null);
  const markers = useRef<ReturnType<typeof markerStore> | null>(null);
  const renewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Results of a request started before a sign-out must not sign anyone back in.
  const generation = useRef(0);
  // Aborted on sign-out: every request issued under the ended session is cancelled.
  const sessionAbort = useRef(new AbortController());
  const channel = useMemo(() => sessionChannel(APP), []);
  // One map per session. A handler still running from an ended session holds that session's memory object and
  // writes only into its discarded map, never into the next session's.
  const [store, setStore] = useState(() => new Map<string, unknown>());
  const memory = useMemo<SessionMemory>(() => ({
    get: <T,>(key: string) => store.get(key) as T | undefined,
    set: (key, value) => {
      store.set(key, value);
      if (isPending(value)) markers.current?.save(key, value);
    },
    delete: (key) => { store.delete(key); markers.current?.remove(key); },
  }), [store]);
  const [state, setState] = useState<SessionState>({ status: 'restoring' });
  const authRef = useRef<ReturnType<typeof authApi> | null>(null);

  /** Ends this tab's session locally: token, requests, queries and memory (reload markers stay, per person). */
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

  /** A renewed token for the same person, or null (then the session is over). Serialised across tabs. */
  const renewRef = useRef<(sent: string | null) => Promise<string | null>>(async () => null);
  renewRef.current = async (sent) => withSessionLock(APP, async () => {
    const gen = generation.current;
    if (!principal.current) return null;
    if (token.current && sent !== null && token.current !== sent) return token.current; // already renewed here
    try {
      const r = await rotate();
      if (gen !== generation.current) return null;
      if (!samePrincipal(r.principal, principal.current)) {
        endLocally('Someone else signed in to the workspace in this browser. Please sign in again.');
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
    // Only a 401 for the token in use now ends the session; a late answer for an older token changes nothing.
    onUnauthorized: (sent) => {
      if (sent === token.current) signOut('Your session has ended. Please sign in again.');
    },
  }), [baseUrl, signOut]);

  const auth = useMemo(() => authApi(api), [api]);
  authRef.current = auth;

  /** Admits the token for a staff role the server confirms, then restores this person's reload markers. */
  const establish = useCallback(async (gen: number, accessToken: string, expiresIn: number | undefined, expected?: StaffRole) => {
    token.current = accessToken;
    let profile;
    try {
      profile = await auth.profile();
    } catch (err) {
      if (gen === generation.current) token.current = null;
      throw err;
    }
    if (gen !== generation.current) return false;
    const role = profile?.userRole;
    // The server's view of the account decides, not the button the user pressed.
    if (!STAFF_ROLES.includes(role as StaffRole) || (expected && role !== expected)) {
      token.current = null;
      throw new ApiError(403, 'This account cannot use the staff workspace.');
    }
    const raw = profile.user ?? {};
    const id = typeof raw._id === 'string' ? raw._id : '';
    if (!/^[0-9a-fA-F]{24}$/.test(id)) {
      token.current = null;
      throw new ApiError(502, 'Sign-in returned an incomplete profile. Please try again.');
    }
    principal.current = { userId: id, userType: role as string };
    markers.current = markerStore(APP, id);
    const restored = new Map<string, unknown>();
    for (const [slot, m] of Object.entries(markers.current.all())) restored.set(slot, { ...m, uncertain: true, restored: true });
    setStore(restored);
    schedule(expiresIn, () => void renewRef.current(token.current));
    setState({ status: 'signed_in', user: { role: role as StaffRole, id, name: displayName(raw, role as StaffRole), raw } });
    return true;
  }, [auth, schedule]);

  /** After a reload (or another tab's sign-in): resume from the cookie session, if there is one. */
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
      endLocally('Someone else signed in to the workspace in this browser. Please sign in again.');
    } else if (!principal.current) {
      void restore();
    }
  }), [channel, endLocally, restore]);

  useEffect(() => () => { clearTimeout(renewTimer.current); }, []);

  const requestCode = useCallback(async (role: StaffRole, target: OtpTarget) => {
    await auth.sendOtp(role, target);
  }, [auth]);

  const verifyCode = useCallback(async (role: StaffRole, target: OtpTarget, otp: string) => {
    await withSessionLock(APP, async () => {
      const gen = generation.current;
      let signedIn;
      if (secure) {
        // The token the phone still holds is ended by this sign-in; the new one is stored before it is used.
        const previous = await secure.get(refreshTokenKey(NATIVE_APP)).catch(() => null);
        const n = await auth.verifyOtpNative(role, target, otp, NATIVE_APP, previous);
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
        signedIn = cookieMode ? await auth.verifyOtpSession(role, target, otp) : await auth.verifyOtp(role, target, otp);
      }
      if (gen !== generation.current) return;
      if (!signedIn?.token) throw new ApiError(502, 'Sign-in did not return a session. Please try again.');
      if (await establish(gen, signedIn.token, signedIn.expiresIn, role) && principal.current) {
        channel?.post({ type: 'signed-in', ...principal.current });
      }
    });
  }, [auth, establish, channel, cookieMode, secure]);

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
