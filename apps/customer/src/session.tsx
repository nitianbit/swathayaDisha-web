import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ApiError, authApi, clearSignOutPending, clearWebSignOutPending, createApiClient, isTransientSessionError, markSignOutPending, markWebSignOutPending,
  markerStore, nativeSecureStore, nativeSignOut, refreshTokenKey, rotateNative, isSignedOutAnswer, samePrincipal, sessionChannel, signOutState, webSignOutState,
  withSessionLock,
  type ApiClient, type OtpTarget, type PendingMarker, type Principal,
} from '@jansetu/api';
import { Reconnecting, ReconnectingStart } from '@jansetu/ui';
import { t, type CustomerKey } from './i18n/index.ts';

const APP = 'customer';
/** N1: inside the phone app the refresh token lives in the OS secure store (see nativeSession.ts). */
const NATIVE_APP = 'customer' as const;

export interface Customer {
  /** The customer's account id (`/auth/profile`). */
  id: string;
}

/** Why the sign-in screen shows: catalogue keys, worded at render (docs/I18N_PLAN.md §3.4), in the order they happened. */
export type SessionNotice = Extract<CustomerKey, `session.notice.${string}`>;
export type SessionNotices = readonly SessionNotice[];

type SessionState = { status: 'restoring' } | { status: 'signed_out'; notice?: SessionNotices } | { status: 'signed_in'; customer: Customer };

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
  /** WQ11a: a session renewal failed without a definite answer and is being retried (the customer stays signed in). */
  reconnecting: boolean;
  /** WQ9: exactly one of a phone or an email (backend `selectCustomerLoginContact`). */
  requestCode: (target: OtpTarget) => Promise<void>;
  verifyCode: (target: OtpTarget, otp: string) => Promise<void>;
  signOut: (notice?: SessionNotice) => void;
  /** Ends every session of this account on every device (POST /auth/sessions/revoke), then this one. */
  signOutEverywhere: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

/** WQ11a: said while a sign-out has not reached the server yet (the device never resumes that session meanwhile). */
export const SIGNED_OUT_HERE: SessionNotice = 'session.notice.signedOutHere';
/** A notice added after the ones already shown. */
const withNote = (notice: SessionNotices | undefined, note: SessionNotice): SessionNotices => [...(notice ?? []), note];
/** The same notices in the same order (the sign-in screen shows the same words). */
const sameNotice = (a: SessionNotices | undefined, b: SessionNotices | undefined) => (a ?? []).join(' ') === (b ?? []).join(' ');
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  // WQ11a: renewal retries after a failure without a definite answer (network, timeout, 5xx): backoff 2 s … 60 s.
  const [reconnecting, setReconnecting] = useState(false);
  const retry = useRef<{ n: number; timer?: ReturnType<typeof setTimeout> }>({ n: 0 });
  const stopRetry = useCallback(() => { clearTimeout(retry.current.timer); retry.current = { n: 0 }; setReconnecting(false); }, []);
  // N3: the start-up refresh is retried the same way while the app is still restoring.
  const [startReconnecting, setStartReconnecting] = useState(false);
  const startRetry = useRef<{ n: number; timer?: ReturnType<typeof setTimeout> }>({ n: 0 });
  const starting = useRef(true);

  const endLocally = useCallback((notice?: SessionNotices) => {
    generation.current += 1;
    token.current = null;
    principal.current = null;
    markers.current = null;
    clearTimeout(renewTimer.current);
    stopRetry();
    sessionAbort.current.abort();
    sessionAbort.current = new AbortController();
    setStore(new Map());
    queryClient.clear();
    setState({ status: 'signed_out', notice });
  }, [queryClient, stopRetry]);

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

  /** N1/WQ11a: a sign-out clean-up still retrying in this app (null when none, or once a new sign-in replaced it). */
  const cleanup = useRef<object | null>(null);

  /** N1: clears the phone's stored token and tells the server (the intent must already be recorded). */
  const finishNativeSignOut = useCallback((tabToken: string | null, marked: boolean) => {
    if (!secure) return;
    const mine = {};
    cleanup.current = mine;
    const attempt = async (): Promise<boolean> => withSessionLock(APP, async () => {
      if (cleanup.current !== mine) return true; // a new sign-in replaced the stored token: nothing to clean
      return nativeSignOut(secure, NATIVE_APP, (rt) => authRef.current!.logoutNative(NATIVE_APP, rt, tabToken));
    }).catch(() => false);
    void (async () => {
      let clean = await attempt();
      if (clean || cleanup.current !== mine) { if (cleanup.current === mine) cleanup.current = null; return; }
      setState((s) => (s.status === 'signed_out' ? { status: 'signed_out', notice: withNote(s.notice, marked
        ? 'session.notice.phoneNotCleared'
        : 'session.notice.phoneStillSigningOut') } : s));
      // Not recorded durably either: keep trying while the app is open (stops when a new sign-in replaces it).
      while (!clean && !marked && cleanup.current === mine) {
        await pause(5000);
        clean = await attempt();
      }
      if (cleanup.current === mine) cleanup.current = null;
      if (clean && !marked) setState((s) => (s.status === 'signed_out' ? { status: 'signed_out' } : s));
    })();
  }, [secure]);

  /**
   * WQ11a: ends the browser's cookie session on the server (the intent must already be recorded). The logout is sent
   * with `keepalive` (it survives the tab closing) and retried with backoff while the page is open; until the server
   * answers, the sign-in screen says so and no start resumes the session (`restore` finishes the logout first). Stops
   * when the server answered, another tab finished it, or a new sign-in replaced the session.
   */
  const finishWebSignOut = useCallback((tabToken: string | null, marked: boolean, notice?: SessionNotices) => {
    const mine = {};
    cleanup.current = mine;
    const attempt = async (): Promise<boolean> => withSessionLock(APP, async () => {
      if (cleanup.current !== mine) return true; // a sign-in in this tab replaced the session
      if (marked && webSignOutState(APP) === 'none') return true; // finished in another tab, or replaced by a sign-in there
      // N4: only the backend's own answer (`data.signedOut: true`) proves the session ended; anything else (no answer, a
      // refusal, a 200 page from something in front of the backend) is tried again.
      const answer = await authRef.current!.logoutSession(tabToken).catch(() => null);
      if (!isSignedOutAnswer(answer)) return false;
      clearWebSignOutPending(APP);
      return true;
    }).catch(() => false);
    const noted = withNote(notice, SIGNED_OUT_HERE);
    void (async () => {
      let clean = await attempt();
      if (!clean && cleanup.current === mine) {
        setState((s) => (s.status === 'signed_out' && sameNotice(s.notice, notice) ? { status: 'signed_out', notice: noted } : s));
      }
      for (let wait = 1000; !clean && cleanup.current === mine; wait = Math.min(wait * 2, 30_000)) {
        await pause(wait);
        clean = await attempt();
      }
      if (cleanup.current === mine) cleanup.current = null;
      if (clean) setState((s) => (s.status === 'signed_out' && sameNotice(s.notice, noted) ? { status: 'signed_out', ...(notice ? { notice } : {}) } : s));
    })();
  }, []);

  /**
   * Ends the session here and on the server. The intent is recorded first, synchronously, before anything else (a
   * refresh may hold the lock right now and the app may close before the clean-up runs): until it is cleaned up, no
   * start resumes the session. Reload markers of unconfirmed creates stay (D4): they hold ids and times only, and a
   * request whose answer was lost must still be resolved after signing in again, never made a second time.
   */
  const endSession = useCallback((said: SessionNotice | undefined) => {
    const notice: SessionNotices | undefined = said ? [said] : undefined;
    const tabToken = token.current; // the family this tab was using ends too, not only the cookie's
    const marked = secure ? markSignOutPending(NATIVE_APP) : cookieMode ? markWebSignOutPending(APP) : true;
    endLocally(notice);
    channel?.post({ type: 'signed-out' });
    if (secure) finishNativeSignOut(tabToken, marked);
    else if (cookieMode) finishWebSignOut(tabToken, marked, notice);
  }, [endLocally, channel, cookieMode, secure, finishNativeSignOut, finishWebSignOut]);

  const signOut = useCallback((notice?: SessionNotice) => endSession(notice), [endSession]);

  /** WQ11a: a session made by a sign-in that then failed (profile check): ended on the server, never left behind. */
  const discardNew = useCallback((newToken: string) => {
    if (secure) finishNativeSignOut(newToken, markSignOutPending(NATIVE_APP));
    else if (cookieMode) finishWebSignOut(newToken, markWebSignOutPending(APP));
  }, [cookieMode, secure, finishNativeSignOut, finishWebSignOut]);

  const schedule = useCallback((expiresIn: number | undefined, renewFn: () => void) => {
    clearTimeout(renewTimer.current);
    if (!expiresIn || expiresIn <= 0) return;
    renewTimer.current = setTimeout(renewFn, Math.max(5, expiresIn - 60) * 1000);
  }, []);

  /**
   * A renewed token for the same customer, or null (then the session is over). WQ11a: only a definite answer ends the
   * session; a failure without one (network, timeout, 5xx) keeps it, shows "Reconnecting…" and retries with backoff,
   * and the request that needed the renewal fails with that error (it can be tried again).
   */
  const renewRef = useRef<(sent: string | null) => Promise<string | null>>(async () => null);
  const renewLater = () => void renewRef.current(token.current).catch(() => undefined);
  renewRef.current = async (sent) => withSessionLock(APP, async () => {
    const gen = generation.current;
    if (!principal.current) return null;
    if (token.current && sent !== null && token.current !== sent) return token.current;
    let r;
    try {
      r = await rotate();
    } catch (err) {
      if (gen !== generation.current) return null;
      if (!isTransientSessionError(err)) { endLocally(['session.notice.ended']); return null; }
      setReconnecting(true);
      clearTimeout(retry.current.timer);
      const n = retry.current.n + 1;
      retry.current = { n, timer: setTimeout(() => { if (gen === generation.current) void renewRef.current(null).catch(() => undefined); }, Math.min(60, 2 ** n) * 1000) };
      throw err instanceof ApiError ? err : new ApiError(0, t('session.error.network'), 'NETWORK');
    }
    if (gen !== generation.current) return null;
    if (!samePrincipal(r.principal, principal.current)) {
      endLocally(['session.notice.someoneElse']);
      return null;
    }
    token.current = r.token;
    stopRetry();
    schedule(r.expiresIn, renewLater);
    return r.token;
  });
  // Back online while reconnecting: try at once instead of waiting for the next retry.
  useEffect(() => {
    const online = () => { if (retry.current.n > 0) void renewRef.current(null).catch(() => undefined); };
    window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
  }, []);

  const api = useMemo(() => createApiClient({
    baseUrl,
    getToken: () => token.current,
    getSessionSignal: () => sessionAbort.current.signal,
    ...(mode !== 'memory' ? { renew: (sent: string) => renewRef.current(sent) } : {}),
    onUnauthorized: (sent) => { if (sent === token.current) endSession('session.notice.ended'); },
  }), [baseUrl, endSession]);
  const auth = useMemo(() => authApi(api), [api]);
  authRef.current = auth;

  const establish = useCallback(async (gen: number, accessToken: string, expiresIn: number | undefined) => {
    token.current = accessToken;
    try {
      const profile = await auth.profile();
      if (gen !== generation.current) return false;
      const id = typeof profile?.user?._id === 'string' ? profile.user._id : '';
      if (profile?.userRole !== 'user' || !/^[0-9a-fA-F]{24}$/.test(id)) {
        throw new ApiError(403, t('session.error.notCustomer'));
      }
      principal.current = { userId: id, userType: 'user' };
      markers.current = markerStore(APP, id);
      const restored = new Map<string, unknown>();
      for (const [slot, m] of Object.entries(markers.current.all())) restored.set(slot, { ...m, uncertain: true, restored: true });
      setStore(restored);
      // WQ11a: nothing cached before this sign-in (another tab's person, a request that slipped through) is shown.
      queryClient.clear();
      schedule(expiresIn, renewLater);
      setState({ status: 'signed_in', customer: { id } });
      return true;
    } catch (err) {
      if (gen === generation.current) token.current = null;
      throw err;
    }
  }, [auth, schedule, queryClient]);

  const restore = useCallback(async () => {
    const gen = generation.current;
    if (mode === 'memory') { setState((s) => (s.status === 'restoring' ? { status: 'signed_out' } : s)); return; }
    let unfinished = false;
    try {
      await withSessionLock(APP, async () => {
        // Another restore (or a sign-in) finished while this one waited for the lock: nothing to resume.
        if (principal.current || gen !== generation.current) return;
        // N1: a sign-out on this phone did not finish clearing the stored token: finish it, never resume.
        // An unreadable record counts as pending: resuming is only allowed when it is known that nobody signed out.
        if (secure && signOutState(NATIVE_APP) !== 'none') {
          await nativeSignOut(secure, NATIVE_APP, (rt) => auth.logoutNative(NATIVE_APP, rt, null));
          // i18n-ignore: never shown (caught below: the sign-in screen opens)
          throw new ApiError(401, 'Signed out', 'SESSION_ENDED');
        }
        // WQ11a: a sign-out in this browser has not reached the server yet: finish it BEFORE any refresh, never resume.
        // An unreadable record counts as pending, as on the phone.
        if (!secure && webSignOutState(APP) !== 'none') {
          if (isSignedOutAnswer(await auth.logoutSession(null).catch(() => null))) clearWebSignOutPending(APP);
          else unfinished = true;
          // i18n-ignore: never shown (caught below: the sign-in screen opens)
          throw new ApiError(401, 'Signed out', 'SESSION_ENDED');
        }
        const r = await rotate();
        if (gen !== generation.current) return;
        await establish(gen, r.token, r.expiresIn);
      });
      startRetry.current.n = 0;
    } catch (err) {
      if (gen === generation.current) {
        token.current = null;
        // N3: the first refresh got no definite answer (network, timeout, 5xx): the session may well be there. Keep
        // trying with backoff and say so; only a definite answer (401 / session ended) shows the sign-in screen.
        if (!unfinished && starting.current && isTransientSessionError(err)) {
          const n = startRetry.current.n + 1;
          clearTimeout(startRetry.current.timer);
          startRetry.current = { n, timer: setTimeout(() => { if (gen === generation.current) void restoreRef.current(); }, Math.min(60, 2 ** n) * 1000) };
          setStartReconnecting(true);
          return;
        }
        setState((s) => (s.status === 'restoring' ? { status: 'signed_out', ...(unfinished ? { notice: [SIGNED_OUT_HERE] } : {}) } : s));
      }
      if (unfinished) finishWebSignOut(null, true);
    }
  }, [auth, establish, mode, finishWebSignOut]);
  const restoreRef = useRef(restore);
  restoreRef.current = restore;
  /** N3: the manual way out of a start-up that cannot reach the server: stop retrying and show the sign-in screen. */
  const signInAgain = useCallback(() => {
    generation.current += 1;
    clearTimeout(startRetry.current.timer);
    startRetry.current = { n: 0 };
    setState((s) => (s.status === 'restoring' ? { status: 'signed_out' } : s));
  }, []);
  useEffect(() => {
    starting.current = state.status === 'restoring';
    if (state.status !== 'restoring') { clearTimeout(startRetry.current.timer); setStartReconnecting(false); }
  }, [state.status]);
  // Back online while the start-up is reconnecting: try at once.
  useEffect(() => {
    const online = () => { if (starting.current && startRetry.current.n > 0) { clearTimeout(startRetry.current.timer); void restoreRef.current(); } };
    window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
  }, []);

  useEffect(() => { void restore(); }, [restore]);

  useEffect(() => channel?.listen((m) => {
    if (m.type === 'signed-out') {
      if (principal.current) endLocally(['session.notice.otherTab']);
      return;
    }
    // WQ11a: another tab signed in, so the browser's session is new: a clean-up still retrying here must not end it.
    if (!secure) cleanup.current = null;
    if (principal.current && !samePrincipal(principal.current, m)) {
      endLocally(['session.notice.someoneElse']);
    } else if (!principal.current) {
      void restore();
    }
  }), [channel, endLocally, restore, secure]);

  useEffect(() => () => { clearTimeout(renewTimer.current); clearTimeout(retry.current.timer); clearTimeout(startRetry.current.timer); }, []);

  const requestCode = useCallback(async (target: OtpTarget) => { await auth.sendOtp('user', target); }, [auth]);

  const verifyCode = useCallback(async (target: OtpTarget, otp: string) => {
    await withSessionLock(APP, async () => {
      const gen = generation.current;
      let signedIn;
      if (secure) {
        // The token the phone still holds is ended by this sign-in; the new one is stored before it is used.
        const previous = await secure.get(refreshTokenKey(NATIVE_APP)).catch(() => null);
        const n = await auth.verifyOtpNative('user', target, otp, NATIVE_APP, previous);
        try {
          await secure.set(refreshTokenKey(NATIVE_APP), n.refreshToken);
        } catch {
          // Not stored, so not usable: end the new session on the server rather than leave it behind.
          await auth.logoutNative(NATIVE_APP, n.refreshToken, n.token).catch(() => undefined);
          throw new ApiError(0, t('session.error.secureStore'), 'SECURE_STORE');
        }
        cleanup.current = null; // a retrying clean-up must not remove the new token
        clearSignOutPending(NATIVE_APP); // the new token replaced whatever an unfinished sign-out left behind
        signedIn = n;
      } else {
        signedIn = cookieMode ? await auth.verifyOtpSession('user', target, otp) : await auth.verifyOtp('user', target, otp);
        if (cookieMode) {
          // WQ11a: the new session replaced the browser's previous one on the server: an unfinished sign-out is moot.
          cleanup.current = null;
          clearWebSignOutPending(APP);
        }
      }
      if (gen !== generation.current) return;
      if (!signedIn?.token) throw new ApiError(502, t('session.error.noSession'));
      let admitted;
      try {
        admitted = await establish(gen, signedIn.token, signedIn.expiresIn);
      } catch (err) {
        // WQ11a: the code was accepted but the account could not be confirmed: the new session is ended, not left live.
        if (gen === generation.current) discardNew(signedIn.token);
        throw err;
      }
      if (admitted && principal.current) channel?.post({ type: 'signed-in', ...principal.current });
    });
  }, [auth, establish, channel, cookieMode, secure, discardNew]);

  const signOutEverywhere = useCallback(async () => {
    await auth.revokeSessions();
    signOut('session.notice.everywhere');
  }, [auth, signOut]);

  const value = useMemo(() => ({ state, api, memory, reconnecting, requestCode, verifyCode, signOut, signOutEverywhere }),
    [state, api, memory, reconnecting, requestCode, verifyCode, signOut, signOutEverywhere]);
  return (
    <SessionContext.Provider value={value}>
      {reconnecting && state.status === 'signed_in' && <Reconnecting />}
      {startReconnecting && state.status === 'restoring' ? <ReconnectingStart onSignIn={signInAgain} /> : children}
    </SessionContext.Provider>
  );
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
