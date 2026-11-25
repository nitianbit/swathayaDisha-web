import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ALL_PARTNER_PERMISSIONS, ApiError, authApi, clearSignOutPending, CLINIC_DOCTOR_NOT_VERIFIED_MESSAGE, clearWebSignOutPending, createApiClient, isClinicDoctorNotVerified, isTransientSessionError, markSignOutPending, networkWords,
  isIdListSlot, markWebSignOutPending, markerStore, nativeSecureStore, nativeSignOut, OBJECT_ID_PATTERN, PARTNER_KIND_LABEL, partnerSelectionOf, refreshTokenKey,
  rotateNative, isSignedOutAnswer, samePrincipal, sessionChannel, signOutState, webSignOutState, withSessionLock,
  type ApiClient, type NativeSignedIn, type OtpTarget, type PartnerKind, type PartnerPermission, type PartnerSelection, type PendingMarker,
  type Principal, type SignedIn, type UserType, type VerificationState,
} from '@jansetu/api';
import { Reconnecting, ReconnectingStart } from '@jansetu/ui';
import { subscribeLanguage } from '@jansetu/i18n';
import { t } from './i18n/shell/index.ts';

/** Who may sign in to the workspace today (WQ4: doctors as `specialist`). HR joins when its module exists. */
export type StaffRole = Extract<UserType, 'admin' | 'pharmacy' | 'partner' | 'specialist'>;
export const STAFF_ROLES: readonly StaffRole[] = ['admin', 'pharmacy', 'partner', 'specialist'];
const APP = 'workspace';
/** N1: inside the phone app the refresh token lives in the OS secure store (see nativeSession.ts). */
const NATIVE_APP = 'workspace' as const;

/**
 * A signed-in lab or clinic member (Q1/Q7): the membership and its partner as `/auth/profile` returned them at sign-in.
 * Shapes the UI only; the backend re-reads role, permissions and branch scope on every request.
 */
export interface PartnerSession {
  member: { id: string; name: string; role: 'owner' | 'staff'; permissions: PartnerPermission[]; branchIds: string[] };
  partner: { id: string; name: string; kind: PartnerKind; solo: boolean; verification: VerificationState | 'unknown' };
}

export interface StaffUser {
  role: StaffRole;
  /** The account id; for pharmacy staff this is the pharmacy's id; for partners the member's id. */
  id: string;
  name: string;
  /** "Admin", "Pharmacy", "Doctor", or the partner's kind ("Lab" / "Clinic"). */
  /** Read at render, in the current language (docs/I18N_PLAN.md §3.4 rule 2). */
  readonly roleLabel: string;
  raw: Record<string, unknown>;
  /** Partners only. */
  partner?: PartnerSession;
  /** Doctors only: from the specialist profile at sign-in (the doctor pages read the profile again). */
  doctor?: { specialization?: string; isVerified: boolean; isActive: boolean };
}

type SessionState =
  | { status: 'restoring' }
  | { status: 'signed_out'; notice?: SessionNotices }
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
  /** WQ11a: a session renewal failed without a definite answer and is being retried (the person stays signed in). */
  reconnecting: boolean;
  requestCode: (role: StaffRole, target: OtpTarget) => Promise<void>;
  /** Signs in, or (Q7, partners with several workspaces) answers the workspaces to choose from: nothing is signed in yet. */
  verifyCode: (role: StaffRole, target: OtpTarget, otp: string) => Promise<PartnerSelection | null>;
  /** Q7: opens the chosen workspace with the one-use ticket from `verifyCode` (in the same session mode). */
  choosePartner: (ticket: string, partnerId: string) => Promise<void>;
  signOut: (notice?: SessionNotice) => void;
}

const SessionContext = createContext<SessionValue | null>(null);

function displayName(user: Record<string, unknown>, role: StaffRole): string {
  for (const key of ['name', 'fullName', 'pharmacyName', 'shopName', 'firstName']) {
    const v = user[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return role === 'admin' ? 'Admin' : role === 'partner' ? 'Member' : role === 'specialist' ? 'Doctor' : 'Pharmacy';
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** The member and partner from a partner's `/auth/profile`, or null when either is missing or malformed. */
function partnerSessionOf(member: Record<string, unknown>, partner: Record<string, unknown> | null | undefined): PartnerSession | null {
  if (!partner) return null;
  const memberId = typeof member._id === 'string' ? member._id : '';
  const partnerId = typeof partner._id === 'string' ? partner._id : '';
  const role = member.role;
  const kind = partner.kind;
  if (!OBJECT_ID_PATTERN.test(memberId) || !OBJECT_ID_PATTERN.test(partnerId) || String(member.partnerId) !== partnerId) return null;
  if ((role !== 'owner' && role !== 'staff') || (kind !== 'lab' && kind !== 'clinic')) return null;
  const v = (partner.verification as { state?: unknown } | undefined)?.state;
  return {
    member: {
      id: memberId,
      name: typeof member.name === 'string' && member.name.trim() ? member.name.trim() : 'Member',
      role,
      permissions: strings(member.permissions).filter((p): p is PartnerPermission => (ALL_PARTNER_PERMISSIONS as readonly string[]).includes(p)),
      branchIds: strings(member.branchIds),
    },
    partner: {
      id: partnerId,
      name: typeof partner.name === 'string' ? partner.name : '',
      kind,
      solo: partner.solo === true,
      verification: v === 'pending' || v === 'verified' || v === 'suspended' ? v : 'unknown',
    },
  };
}


/** Q16b: a lab or clinic sign-in in a build whose API is on another origin (no first-party cookie session there). */
export let PARTNER_NEEDS_SAME_ORIGIN = '';

/**
 * Why the sign-in screen shows: codes, worded at render (docs/I18N_PLAN.md §3.4), in the order they happened. WQ11a:
 * `signedOutHere` is said while a sign-out has not reached the server yet (this browser never resumes that session
 * meanwhile); WQ15: `clinicRefused` is the refusal of a clinic member whose doctor is not verified.
 */
export type SessionNotice = 'ended' | 'someoneElse' | 'otherTab' | 'signedOutHere' | 'phoneNotCleared' | 'phoneNotSignedOut' | 'clinicRefused'
  // WQ51: a doctor going to their own clinic's workspace (the sign-in opens on "Lab or clinic staff").
  | 'toClinicWorkspace';
export type SessionNotices = readonly SessionNotice[];
/** The notices in words, one sentence after another. */
export const noticeWords = (notice: SessionNotices): string =>
  notice.map((n) => (n === 'clinicRefused' ? CLINIC_DOCTOR_NOT_VERIFIED_MESSAGE : t(`session.${n}`))).join(' ');
// Imported as strings (ES live bindings): read again in the new language on every switch.
const readWords = () => {
  PARTNER_NEEDS_SAME_ORIGIN = t('session.partnerSameOrigin');
};
readWords();
subscribeLanguage(readWords);
/** A notice added after the ones already shown. */
const withNote = (notice: SessionNotices | undefined, note: SessionNotice): SessionNotices => [...(notice ?? []), note];
/** The same notices in the same order (the sign-in screen shows the same words). */
const sameNotice = (a: SessionNotices | undefined, b: SessionNotices | undefined) => (a ?? []).join(' ') === (b ?? []).join(' ');
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
      else if (Array.isArray(value) && isIdListSlot(key)) markers.current?.saveIds(key, value);
    },
    delete: (key) => { store.delete(key); markers.current?.remove(key); },
  }), [store]);
  const [state, setState] = useState<SessionState>({ status: 'restoring' });
  const authRef = useRef<ReturnType<typeof authApi> | null>(null);
  // WQ11a: renewal retries after a failure without a definite answer (network, timeout, 5xx): backoff 2 s … 60 s.
  const [reconnecting, setReconnecting] = useState(false);
  const retry = useRef<{ n: number; timer?: ReturnType<typeof setTimeout> }>({ n: 0 });
  const stopRetry = useCallback(() => { clearTimeout(retry.current.timer); retry.current = { n: 0 }; setReconnecting(false); }, []);
  // N3: the start-up refresh is retried the same way while the app is still restoring.
  const [startReconnecting, setStartReconnecting] = useState(false);
  const startRetry = useRef<{ n: number; timer?: ReturnType<typeof setTimeout> }>({ n: 0 });
  const starting = useRef(true);

  /** Ends this tab's session locally: token, requests, queries and memory (reload markers stay, per person). */
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
      setState((s) => (s.status === 'signed_out' ? { status: 'signed_out', notice: withNote(s.notice, marked ? 'phoneNotCleared' : 'phoneNotSignedOut') } : s));
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
    const noted = withNote(notice, 'signedOutHere');
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
   * start resumes the session.
   */
  const signOut = useCallback((said?: SessionNotice) => {
    const notice: SessionNotices | undefined = said ? [said] : undefined;
    const tabToken = token.current; // the family this tab was using ends too, not only the cookie's
    const marked = secure ? markSignOutPending(NATIVE_APP) : cookieMode ? markWebSignOutPending(APP) : true;
    endLocally(notice);
    channel?.post({ type: 'signed-out' });
    if (secure) finishNativeSignOut(tabToken, marked);
    else if (cookieMode) finishWebSignOut(tabToken, marked, notice);
  }, [endLocally, channel, cookieMode, secure, finishNativeSignOut, finishWebSignOut]);

  /** WQ11a: a session made by a sign-in that then failed (profile or role check): ended on the server, never left behind. */
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
   * A renewed token for the same person, or null (then the session is over). Serialised across tabs. WQ11a: only a
   * definite answer ends the session; a failure without one (network, timeout, 5xx) keeps it, shows "Reconnecting…" and
   * retries with backoff, and the request that needed the renewal fails with that error (it can be tried again).
   */
  const renewRef = useRef<(sent: string | null) => Promise<string | null>>(async () => null);
  const renewLater = () => void renewRef.current(token.current).catch(() => undefined);
  renewRef.current = async (sent) => withSessionLock(APP, async () => {
    const gen = generation.current;
    if (!principal.current) return null;
    if (token.current && sent !== null && token.current !== sent) return token.current; // already renewed here
    let r;
    try {
      r = await rotate();
    } catch (err) {
      if (gen !== generation.current) return null;
      if (!isTransientSessionError(err)) { endLocally(['ended']); return null; }
      setReconnecting(true);
      clearTimeout(retry.current.timer);
      const n = retry.current.n + 1;
      retry.current = { n, timer: setTimeout(() => { if (gen === generation.current) void renewRef.current(null).catch(() => undefined); }, Math.min(60, 2 ** n) * 1000) };
      throw err instanceof ApiError ? err : new ApiError(0, networkWords(), 'NETWORK');
    }
    if (gen !== generation.current) return null;
    if (!samePrincipal(r.principal, principal.current)) {
      endLocally(['someoneElse']);
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
    // Only a 401 for the token in use now ends the session; a late answer for an older token changes nothing.
    onUnauthorized: (sent) => {
      if (sent === token.current) signOut('ended');
    },
    // WQ15 (r9): a clinic member whose doctor account is not verified or not active is refused on every partner call.
    // The session ends like a 401 (signed out on the server too, so a reload does not resume it), with the reason.
    onForbidden: (sent, err) => {
      if (sent === token.current && isClinicDoctorNotVerified(err)) signOut('clinicRefused');
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
      throw new ApiError(403, t('session.notStaff'));
    }
    const raw = profile.user ?? {};
    const id = typeof raw._id === 'string' ? raw._id : '';
    const partner = role === 'partner' ? partnerSessionOf(raw, profile.partner) : undefined;
    if (!/^[0-9a-fA-F]{24}$/.test(id) || partner === null) {
      token.current = null;
      throw new ApiError(502, t('session.incompleteProfile'));
    }
    principal.current = { userId: id, userType: role as string };
    markers.current = markerStore(APP, id);
    const restored = new Map<string, unknown>();
    for (const [slot, m] of Object.entries(markers.current.all())) restored.set(slot, { ...m, uncertain: true, restored: true });
    // WQ11d: id lists (e.g. previews discarded on this device) come back as they were.
    for (const [slot, ids] of Object.entries(markers.current.allIds())) restored.set(slot, ids);
    setStore(restored);
    // WQ11a: nothing cached before this sign-in (another tab's person, a request that slipped through) is shown.
    queryClient.clear();
    schedule(expiresIn, renewLater);
    const staffRole = role as StaffRole;
    setState({ status: 'signed_in', user: {
      role: staffRole, id, raw,
      name: partner ? partner.member.name : displayName(raw, staffRole),
      get roleLabel() { return partner ? PARTNER_KIND_LABEL[partner.partner.kind] : t(`shell.role.${staffRole as Exclude<StaffRole, 'partner'>}`); },
      ...(partner ? { partner } : {}),
      ...(staffRole === 'specialist' ? { doctor: {
        ...(typeof raw.specialization === 'string' && raw.specialization.trim() ? { specialization: raw.specialization.trim() } : {}),
        isVerified: raw.isVerified === true, isActive: raw.isActive === true,
      } } : {}),
    } });
    return true;
  }, [auth, schedule, queryClient]);

  /** After a reload (or another tab's sign-in): resume from the cookie session, if there is one. */
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
          throw new ApiError(401, 'Signed out', 'SESSION_ENDED'); // i18n-ignore: rejects a renewal after sign-out, never shown
        }
        // WQ11a: a sign-out in this browser has not reached the server yet: finish it BEFORE any refresh, never resume.
        // An unreadable record counts as pending, as on the phone.
        if (!secure && webSignOutState(APP) !== 'none') {
          if (isSignedOutAnswer(await auth.logoutSession(null).catch(() => null))) clearWebSignOutPending(APP);
          else unfinished = true;
          throw new ApiError(401, 'Signed out', 'SESSION_ENDED'); // i18n-ignore: rejects a renewal after sign-out, never shown
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
        // WQ15: the clinic refusal is never a silent sign-out (the forbidden hook normally ends the session first, with it).
        const why: SessionNotice | undefined = unfinished ? 'signedOutHere' : isClinicDoctorNotVerified(err) ? 'clinicRefused' : undefined;
        setState((s) => (s.status === 'restoring' ? { status: 'signed_out', ...(why ? { notice: [why] } : {}) } : s));
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
      if (principal.current) endLocally(['otherTab']);
      return;
    }
    // WQ11a: another tab signed in, so the browser's session is new: a clean-up still retrying here must not end it.
    if (!secure) cleanup.current = null;
    if (principal.current && !samePrincipal(principal.current, m)) {
      endLocally(['someoneElse']);
    } else if (!principal.current) {
      void restore();
    }
  }), [channel, endLocally, restore, secure]);

  useEffect(() => () => { clearTimeout(renewTimer.current); clearTimeout(retry.current.timer); clearTimeout(startRetry.current.timer); }, []);

  /**
   * Q16b: partner sign-ins (verify and select) must open a server session (`session: 'cookie'` or `'native'`; a bearer
   * sign-in is refused 400 SESSION_REQUIRED). A build whose API is on another origin has no first-party cookie, so a
   * lab or clinic sign-in is refused here, before any code is sent. Stage and production use the same-origin build.
   */
  const partnerRefused = useCallback((role: StaffRole) => {
    if (role === 'partner' && !secure && !cookieMode) throw new ApiError(0, PARTNER_NEEDS_SAME_ORIGIN, 'PARTNER_NEEDS_SAME_ORIGIN');
  }, [secure, cookieMode]);

  const requestCode = useCallback(async (role: StaffRole, target: OtpTarget) => {
    partnerRefused(role);
    await auth.sendOtp(role, target);
  }, [auth, partnerRefused]);

  /** N1: the new refresh token is stored before its session is used; not stored = not usable (ended on the server). */
  const keepNative = useCallback(async (n: NativeSignedIn) => {
    try {
      await secure!.set(refreshTokenKey(NATIVE_APP), n.refreshToken);
    } catch {
      await auth.logoutNative(NATIVE_APP, n.refreshToken, n.token).catch(() => undefined);
      throw new ApiError(0, t('session.secureStore'), 'SECURE_STORE');
    }
    cleanup.current = null; // a retrying clean-up must not remove the new token
    clearSignOutPending(NATIVE_APP); // the new token replaced whatever an unfinished sign-out left behind
  }, [auth, secure]);

  /** Admits a fresh sign-in (verify or partner select) and tells the other tabs. */
  const admit = useCallback(async (gen: number, signedIn: SignedIn | undefined, role: StaffRole) => {
    if (gen !== generation.current) return;
    if (!signedIn?.token) throw new ApiError(502, t('session.noSession'));
    let admitted;
    try {
      admitted = await establish(gen, signedIn.token, signedIn.expiresIn, role);
    } catch (err) {
      // WQ11a: the code was accepted but the account could not be confirmed: the new session is ended, not left live.
      if (gen === generation.current) discardNew(signedIn.token);
      throw err;
    }
    if (admitted && principal.current) channel?.post({ type: 'signed-in', ...principal.current });
  }, [establish, channel, discardNew]);

  /** WQ11a: the browser's new cookie session replaced the previous one on the server: an unfinished sign-out is moot. */
  const replacedWebSession = useCallback(() => {
    if (secure || !cookieMode) return;
    cleanup.current = null;
    clearWebSignOutPending(APP);
  }, [cookieMode, secure]);


  const verifyCode = useCallback(async (role: StaffRole, target: OtpTarget, otp: string) => withSessionLock(APP, async () => {
    const gen = generation.current;
    let answer: SignedIn | PartnerSelection;
    if (secure) {
      // The token the phone still holds is ended by this sign-in; the new one is stored before it is used.
      const previous = await secure.get(refreshTokenKey(NATIVE_APP)).catch(() => null);
      const n = await auth.verifyOtpNative(role, target, otp, NATIVE_APP, previous);
      // Q7: a choice comes with no session (and no refresh token): nothing to store yet.
      if (!partnerSelectionOf(n)) await keepNative(n as NativeSignedIn);
      answer = n;
    } else {
      partnerRefused(role);
      answer = cookieMode ? await auth.verifyOtpSession(role, target, otp) : await auth.verifyOtp(role, target, otp);
    }
    const selection = role === 'partner' ? partnerSelectionOf(answer) : null;
    if (selection) {
      if (gen !== generation.current) return null;
      if (selection.choices.length === 0) throw new ApiError(403, t('session.noWorkspace'));
      return selection;
    }
    replacedWebSession();
    await admit(gen, answer as SignedIn, role);
    return null;
  }), [auth, admit, keepNative, cookieMode, secure, replacedWebSession, partnerRefused]);

  const choosePartner = useCallback(async (ticket: string, partnerId: string) => withSessionLock(APP, async () => {
    const gen = generation.current;
    let signedIn: SignedIn;
    if (secure) {
      const previous = await secure.get(refreshTokenKey(NATIVE_APP)).catch(() => null);
      const n = await auth.selectPartner(ticket, partnerId, { kind: 'native', app: NATIVE_APP, previousRefreshToken: previous });
      await keepNative(n);
      signedIn = n;
    } else {
      // Q16b: always a web session (the server refuses a partner select without one: 400 SESSION_REQUIRED).
      partnerRefused('partner');
      signedIn = await auth.selectPartner(ticket, partnerId, { kind: 'cookie' });
      replacedWebSession();
    }
    await admit(gen, signedIn, 'partner');
  }), [auth, admit, keepNative, secure, replacedWebSession, partnerRefused]);

  const value = useMemo(() => ({ state, api, memory, reconnecting, requestCode, verifyCode, choosePartner, signOut }),
    [state, api, memory, reconnecting, requestCode, verifyCode, choosePartner, signOut]);
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

/** For screens that render only when signed in. */
export function useStaff(): StaffUser {
  const { state } = useSession();
  if (state.status !== 'signed_in') throw new Error('useStaff while signed out');
  return state.user;
}
