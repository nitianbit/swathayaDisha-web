import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ALL_PARTNER_PERMISSIONS, ApiError, authApi, clearSignOutPending, createApiClient, markSignOutPending, markerStore, nativeSecureStore, nativeSignOut,
  OBJECT_ID_PATTERN, PARTNER_KIND_LABEL, partnerSelectionOf, refreshTokenKey, rotateNative, samePrincipal, sessionChannel, signOutState,
  withSessionLock,
  type ApiClient, type NativeSignedIn, type OtpTarget, type PartnerKind, type PartnerPermission, type PartnerSelection, type PendingMarker,
  type Principal, type SignedIn, type UserType, type VerificationState,
} from '@jansetu/api';

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
  roleLabel: string;
  raw: Record<string, unknown>;
  /** Partners only. */
  partner?: PartnerSession;
  /** Doctors only: from the specialist profile at sign-in (the doctor pages read the profile again). */
  doctor?: { specialization?: string; isVerified: boolean; isActive: boolean };
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
  /** Signs in, or (Q7, partners with several workspaces) answers the workspaces to choose from: nothing is signed in yet. */
  verifyCode: (role: StaffRole, target: OtpTarget, otp: string) => Promise<PartnerSelection | null>;
  /** Q7: opens the chosen workspace with the one-use ticket from `verifyCode` (in the same session mode). */
  choosePartner: (ticket: string, partnerId: string) => Promise<void>;
  signOut: (notice?: string) => void;
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

const ROLE_LABEL: Record<Exclude<StaffRole, 'partner'>, string> = { admin: 'Admin', pharmacy: 'Pharmacy', specialist: 'Doctor' };

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

  /** N1: a sign-out clean-up still retrying in this app (null when none, or once a new sign-in replaced it). */
  const cleanup = useRef<object | null>(null);

  const signOut = useCallback((notice?: string) => {
    const tabToken = token.current; // the family this tab was using ends too, not only the cookie's
    // N1: the intent is recorded first, synchronously, before anything else (a refresh may hold the lock right now and
    // the app may close before the clean-up runs): until it is cleaned up, no start resumes the session.
    const marked = secure ? markSignOutPending(NATIVE_APP) : true;
    endLocally(notice);
    channel?.post({ type: 'signed-out' });
    if (secure) {
      const mine = {};
      cleanup.current = mine;
      const attempt = async (): Promise<boolean> => withSessionLock(APP, async () => {
        if (cleanup.current !== mine) return true; // a new sign-in replaced the stored token: nothing to clean
        return nativeSignOut(secure, NATIVE_APP, (rt) => authRef.current!.logoutNative(NATIVE_APP, rt, tabToken));
      }).catch(() => false);
      void (async () => {
        let clean = await attempt();
        if (clean || cleanup.current !== mine) { if (cleanup.current === mine) cleanup.current = null; return; }
        setState((s) => (s.status === 'signed_out' ? { status: 'signed_out', notice: `${s.notice ? `${s.notice} ` : ''}${marked
          ? 'This phone could not clear its saved sign-in yet; it will be cleared when the app next opens.'
          : 'This phone could not finish signing out yet. Keep the app open for a moment while it tries again.'}` } : s));
        // Not recorded durably either: keep trying while the app is open (stops when a new sign-in replaces it).
        while (!clean && !marked && cleanup.current === mine) {
          await new Promise((r) => setTimeout(r, 5000));
          clean = await attempt();
        }
        if (cleanup.current === mine) cleanup.current = null;
        if (clean && !marked) setState((s) => (s.status === 'signed_out' ? { status: 'signed_out' } : s));
      })();
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
    const partner = role === 'partner' ? partnerSessionOf(raw, profile.partner) : undefined;
    if (!/^[0-9a-fA-F]{24}$/.test(id) || partner === null) {
      token.current = null;
      throw new ApiError(502, 'Sign-in returned an incomplete profile. Please try again.');
    }
    principal.current = { userId: id, userType: role as string };
    markers.current = markerStore(APP, id);
    const restored = new Map<string, unknown>();
    for (const [slot, m] of Object.entries(markers.current.all())) restored.set(slot, { ...m, uncertain: true, restored: true });
    setStore(restored);
    schedule(expiresIn, () => void renewRef.current(token.current));
    const staffRole = role as StaffRole;
    setState({ status: 'signed_in', user: {
      role: staffRole, id, raw,
      name: partner ? partner.member.name : displayName(raw, staffRole),
      roleLabel: partner ? PARTNER_KIND_LABEL[partner.partner.kind] : ROLE_LABEL[staffRole as Exclude<StaffRole, 'partner'>],
      ...(partner ? { partner } : {}),
      ...(staffRole === 'specialist' ? { doctor: {
        ...(typeof raw.specialization === 'string' && raw.specialization.trim() ? { specialization: raw.specialization.trim() } : {}),
        isVerified: raw.isVerified === true, isActive: raw.isActive === true,
      } } : {}),
    } });
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
        // An unreadable record counts as pending: resuming is only allowed when it is known that nobody signed out.
        if (secure && signOutState(NATIVE_APP) !== 'none') {
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

  /** N1: the new refresh token is stored before its session is used; not stored = not usable (ended on the server). */
  const keepNative = useCallback(async (n: NativeSignedIn) => {
    try {
      await secure!.set(refreshTokenKey(NATIVE_APP), n.refreshToken);
    } catch {
      await auth.logoutNative(NATIVE_APP, n.refreshToken, n.token).catch(() => undefined);
      throw new ApiError(0, 'This phone could not save your sign-in. Please try again.', 'SECURE_STORE');
    }
    cleanup.current = null; // a retrying clean-up must not remove the new token
    clearSignOutPending(NATIVE_APP); // the new token replaced whatever an unfinished sign-out left behind
  }, [auth, secure]);

  /** Admits a fresh sign-in (verify or partner select) and tells the other tabs. */
  const admit = useCallback(async (gen: number, signedIn: SignedIn | undefined, role: StaffRole) => {
    if (gen !== generation.current) return;
    if (!signedIn?.token) throw new ApiError(502, 'Sign-in did not return a session. Please try again.');
    if (await establish(gen, signedIn.token, signedIn.expiresIn, role) && principal.current) {
      channel?.post({ type: 'signed-in', ...principal.current });
    }
  }, [establish, channel]);

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
      answer = cookieMode ? await auth.verifyOtpSession(role, target, otp) : await auth.verifyOtp(role, target, otp);
    }
    const selection = role === 'partner' ? partnerSelectionOf(answer) : null;
    if (selection) {
      if (gen !== generation.current) return null;
      if (selection.choices.length === 0) throw new ApiError(403, 'None of your lab or clinic workspaces is available.');
      return selection;
    }
    await admit(gen, answer as SignedIn, role);
    return null;
  }), [auth, admit, keepNative, cookieMode, secure]);

  const choosePartner = useCallback(async (ticket: string, partnerId: string) => withSessionLock(APP, async () => {
    const gen = generation.current;
    let signedIn: SignedIn;
    if (secure) {
      const previous = await secure.get(refreshTokenKey(NATIVE_APP)).catch(() => null);
      const n = await auth.selectPartner(ticket, partnerId, { kind: 'native', app: NATIVE_APP, previousRefreshToken: previous });
      await keepNative(n);
      signedIn = n;
    } else {
      signedIn = cookieMode
        ? await auth.selectPartner(ticket, partnerId, { kind: 'cookie' })
        : await auth.selectPartner(ticket, partnerId, { kind: 'bearer' });
    }
    await admit(gen, signedIn, 'partner');
  }), [auth, admit, keepNative, cookieMode, secure]);

  const value = useMemo(() => ({ state, api, memory, requestCode, verifyCode, choosePartner, signOut }),
    [state, api, memory, requestCode, verifyCode, choosePartner, signOut]);
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
