import { ApiError, type ApiClient } from './client.ts';

/** The backend's login kinds (`/auth/:userType/send|verify`). */
export type UserType = 'user' | 'admin' | 'specialist' | 'hr' | 'pharmacy' | 'partner';

/** OTP goes to a 10-digit phone or an email (backend Joi rules). */
export type OtpTarget = { phone: string } | { email: string };

export interface SignedIn {
  token: string;
  /** Seconds the access token lasts (cookie sessions; absent for the legacy long-lived bearer). */
  expiresIn?: number;
  user: Record<string, unknown>;
}

/** D4: a web-session sign-in (the refresh cookie is set by the server; never readable here). */
export interface SessionSignedIn extends SignedIn { expiresIn?: number }
export interface SessionRefreshed {
  token: string;
  expiresIn: number;
  /** Who the renewed token belongs to (the client installs it only for the same person). */
  principal: { userId: string; userType: UserType; sid: string };
}

/** N1: which phone app a native session belongs to. */
export type NativeApp = 'customer' | 'workspace';
/** N1: a phone-app sign-in or refresh. The refresh token goes to the OS secure store and nowhere else. */
export interface NativeTokens {
  token: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresIn: number;
}
export interface NativeSignedIn extends NativeTokens { user: Record<string, unknown> }
export interface NativeRefreshed extends NativeTokens { principal: SessionRefreshed['principal'] }

export interface Profile {
  /** For a partner: the member record (role, permissions, branchIds, name). */
  user: Record<string, unknown>;
  /** Partners only: the partner the member belongs to (`getProfile` in `auth/controller`). */
  partner?: Record<string, unknown> | null;
  userRole: UserType;
}

/** Q7: one of the workspaces a person with several partner memberships may open. */
export interface PartnerChoice {
  partnerId: string;
  name: string;
  kind: 'lab' | 'clinic';
  solo: boolean;
  role: 'owner' | 'staff';
}
/**
 * Q7: a partner verify for a phone with several active memberships answers this instead of a session: no token, a
 * one-use ticket (5 minutes) to send with the chosen partner to `POST /auth/partner/select`.
 */
export interface PartnerSelection {
  selectionRequired: true;
  ticket: string;
  choices: PartnerChoice[];
}
/** Only partner sign-ins can answer with a choice. */
export type VerifyAnswer<U extends UserType, T> = U extends 'partner' ? T | PartnerSelection : T;

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

/** A well-formed selection answer (choices with a usable id), or null. */
export function partnerSelectionOf(answer: unknown): PartnerSelection | null {
  if (!answer || typeof answer !== 'object') return null;
  const a = answer as Record<string, unknown>;
  if (a.selectionRequired !== true) return null;
  if (typeof a.ticket !== 'string' || !a.ticket || !Array.isArray(a.choices)) return null;
  const choices = a.choices.filter((c): c is PartnerChoice => !!c && typeof c === 'object'
    && typeof (c as PartnerChoice).partnerId === 'string' && OBJECT_ID.test((c as PartnerChoice).partnerId)
    && typeof (c as PartnerChoice).name === 'string');
  return { selectionRequired: true, ticket: a.ticket, choices };
}

/** How a sign-in answer is delivered: the legacy bearer, a D4 cookie session, or an N1 phone session. */
export type SignInMode = { kind: 'bearer' } | { kind: 'cookie' } | { kind: 'native'; app: 'workspace'; previousRefreshToken?: string | null };

export const PHONE_PATTERN = /^[0-9]{10}$/;
export const OTP_PATTERN = /^[0-9]{6}$/;

/** RFC 5321 caps an address at 254 characters. */
export const MAX_EMAIL = 254;
/** A pragmatic check for Joi `string().email()` (the server's own answer still decides). */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** A 10-digit mobile, optionally written with spaces or dashes and a +91 / 91 / 0 prefix. */
const LOGIN_PHONE = /^(?:\+?91|0)?([0-9]{10})$/;

/**
 * WQ9: the one way an email is sent anywhere (sign-in, staff, owner, profile): trimmed and lower-cased, with the domain
 * in its ASCII (punycode) form. Browsers disagree: a `type="email"` input in Chromium already answers punycode for an
 * internationalised domain, a `type="text"` one answers Unicode; without this one form the same address would be
 * stored one way and looked up the other. Null when it is not a usable address.
 */
export function normalizeEmail(raw: string): string | null {
  const s = raw.trim().normalize('NFC').toLowerCase();
  const at = s.lastIndexOf('@');
  if (at <= 0 || at === s.length - 1) return null;
  // One form for the same characters (composed vs decomposed accents): Unicode NFC.
  const local = s.slice(0, at).normalize('NFC');
  const domain = s.slice(at + 1);
  // Only a bare host name: anything URL parsing would silently drop or reinterpret (port, path, IP literal) is refused.
  if (/[\s:/?#[\]@\\%]/.test(domain)) return null;
  let ascii: string;
  try { ascii = new URL(`http://${domain}`).hostname; } catch { return null; }
  // The last label must hold a letter (an IPv4-looking domain is not an email domain).
  if (!/[a-z]/.test(ascii.slice(ascii.lastIndexOf('.') + 1))) return null;
  const email = `${local}@${ascii}`;
  return email.length <= MAX_EMAIL && EMAIL_SHAPE.test(email) ? email : null;
}

/**
 * WQ9: one sign-in field takes a mobile number or an email (backend `sendOTPSchema`/`verifyOTPSchema`: `phone` or
 * `email`; customers exactly one of them, `selectCustomerLoginContact`). Anything with an `@` is an email
 * (`normalizeEmail`); otherwise spaces and dashes are dropped and a +91, 91 or 0 prefix is allowed before the 10
 * digits. Null when it is neither. Sends exactly one of the two keys.
 */
export function parseLoginIdentifier(raw: string): OtpTarget | null {
  const s = raw.trim();
  if (!s) return null;
  if (s.includes('@')) {
    const email = normalizeEmail(s);
    return email ? { email } : null;
  }
  const m = LOGIN_PHONE.exec(s.replace(/[\s-]/g, ''));
  return m ? { phone: m[1]! } : null;
}

/** A stable in-memory key for one destination (the O1 resend limits are per destination). */
export const targetKey = (t: OtpTarget): string => ('phone' in t ? `phone:${t.phone}` : `email:${t.email}`);

/** Which kind of destination, for copy ("your phone" / "your email"). */
export const targetKind = (t: OtpTarget): 'phone' | 'email' => ('phone' in t ? 'phone' : 'email');

/**
 * The destination as shown on the code step: a phone keeps its last 4 digits, an email its domain and (when the part
 * before the @ is longer than 2 characters) its first character. Never the full identifier (it may be read over a
 * shoulder or captured in a screenshot).
 */
export function maskTarget(t: OtpTarget): string {
  if ('phone' in t) return `••••••${t.phone.slice(-4)}`;
  const at = t.email.lastIndexOf('@');
  return `${at > 2 ? t.email.slice(0, 1) : ''}•••${t.email.slice(at)}`;
}

/**
 * WQ9 owner decision: no new account starts from an email. A customer, doctor or pharmacy sign-in with an email no
 * account uses answers 404 `EMAIL_NOT_REGISTERED`.
 */
export const isEmailNotRegistered = (err: unknown) => err instanceof ApiError && err.code === 'EMAIL_NOT_REGISTERED';
export const EMAIL_NOT_REGISTERED_MESSAGE = 'No account uses this email. Sign in with your mobile number, then add this email to your profile.';
/** Doctors and pharmacies have no profile email screen: the team adds it. */
export const EMAIL_NOT_REGISTERED_STAFF_MESSAGE =
  'No account uses this email. Sign in with your mobile number. To use email sign-in, ask the Jansetu team to add it to your account.';

/** D4: once-only operations whose outcome a reloaded page never saw. */
export type OnceOnlyKind = 'customer_return' | 'supplier_return' | 'booking_create' | 'pharmacy_checkout' | 'lab_booking_create' | 'instant_request_create';

/**
 * Abandons an unresolved request key on the server: afterwards the old request can never be performed, so a new one
 * is safe. 'used' means the old request WAS performed (look for its record instead).
 */
export function requestKeysApi(c: ApiClient) {
  return {
    /**
     * Q9 read-only: 'used' (with the record it made), 'abandoned', or 'unknown' (not made and not abandoned: it may still
     * be on its way). Never changes anything.
     */
    lookup: (kind: OnceOnlyKind, key: string) =>
      c.get<{ state: 'used' | 'abandoned' | 'unknown'; record?: Record<string, unknown> & { _id: string } }>('/request-keys/lookup', { query: { kind, key } }),
    /** 'used' comes with the exact record the key produced (return receipt, or the booking's id). */
    abandon: (kind: OnceOnlyKind, key: string) =>
      c.post<{ state: 'abandoned' | 'used'; record?: Record<string, unknown> & { _id: string } }>('/request-keys/abandon', { body: { kind, key } }),
  };
}

interface PartnerSelector {
  (ticket: string, partnerId: string, mode: { kind: 'bearer' }): Promise<SignedIn>;
  (ticket: string, partnerId: string, mode: { kind: 'cookie' }): Promise<SessionSignedIn>;
  (ticket: string, partnerId: string, mode: { kind: 'native'; app: 'workspace'; previousRefreshToken?: string | null }): Promise<NativeSignedIn>;
}

/** Q16b: partner members get no bearer token; their verify and select must open a cookie or native session. */
const partnerNeedsSession = () => new ApiError(400, "Partner sign-in needs session 'cookie' (web) or 'native' (phone app)", 'SESSION_REQUIRED');

function partnerSelector(c: ApiClient): PartnerSelector {
  return ((ticket: string, partnerId: string, mode: SignInMode) => {
    if (!OBJECT_ID.test(partnerId)) throw new Error('Invalid partner id');
    if (mode.kind === 'bearer') return Promise.reject(partnerNeedsSession());
    const body = { ticket, partnerId };
    if (mode.kind === 'cookie') {
      return c.post<SessionSignedIn>('/auth/partner/select', { body: { ...body, session: 'cookie' }, auth: false, session: true });
    }
    if (mode.kind === 'native') {
      return c.post<NativeSignedIn>('/auth/partner/select', { body: { ...body, session: 'native', app: mode.app,
        ...(mode.previousRefreshToken ? { previousRefreshToken: mode.previousRefreshToken } : {}) }, auth: false, native: true });
    }
    return c.post<SignedIn>('/auth/partner/select', { body, auth: false });
  }) as PartnerSelector;
}

export function authApi(c: ApiClient) {
  return {
    sendOtp: (userType: UserType, target: OtpTarget) =>
      c.post<void>(`/auth/${userType}/send`, { body: target, auth: false }),
    /** Legacy bearer sign-in. Q16b: never for partners (refused here, as the server would: 400 SESSION_REQUIRED). */
    verifyOtp: <U extends UserType>(userType: U, target: OtpTarget, otp: string) => (userType === 'partner'
      ? Promise.reject(partnerNeedsSession())
      : c.post<VerifyAnswer<U, SignedIn>>(`/auth/${userType}/verify`, { body: { ...target, otp }, auth: false })),
    /** D4: sign in with a first-party cookie session (web apps behind their own host's /api forward). */
    verifyOtpSession: <U extends UserType>(userType: U, target: OtpTarget, otp: string) =>
      c.post<VerifyAnswer<U, SessionSignedIn>>(`/auth/${userType}/verify`, { body: { ...target, otp, session: 'cookie' }, auth: false, session: true }),
    /**
     * Q7: opens the chosen partner workspace with the ticket from a selection answer. Answered exactly like a verify in
     * the same mode (bearer, cookie or native). A used or expired ticket: 401 `SELECTION_EXPIRED` (request a new code).
     */
    selectPartner: partnerSelector(c),
    refreshSession: () => c.post<SessionRefreshed>('/auth/session/refresh', { body: {}, auth: false, session: true }),
    /**
     * Ends the cookie's family and the family of `token` (the access token this tab was using). Sent under the session
     * lock, so it never renews on a 401 (that would wait for the same lock); `keepalive` lets it finish after the page
     * closes (WQ11a).
     */
    logoutSession: (token?: string | null) =>
      c.post<unknown>('/auth/session/logout', { body: {}, auth: !!token, ...(token ? { token } : {}), session: true, noRenew: true, keepalive: true }),
    /** N1: phone-app sign-in; `previousRefreshToken` (the one still in the secure store) is ended by the server. */
    verifyOtpNative: <U extends UserType>(userType: U, target: OtpTarget, otp: string, app: NativeApp, previousRefreshToken?: string | null) =>
      c.post<VerifyAnswer<U, NativeSignedIn>>(`/auth/${userType}/verify`, { body: { ...target, otp, session: 'native', app,
        ...(previousRefreshToken ? { previousRefreshToken } : {}) }, auth: false, native: true }),
    refreshNative: (app: NativeApp, refreshToken: string) =>
      c.post<NativeRefreshed>('/auth/session/native/refresh', { body: { app, refreshToken }, auth: false, native: true }),
    /** Ends the stored family and the family of `token` (the access token in use). Under the session lock: never renews. */
    logoutNative: (app: NativeApp, refreshToken: string | null, token?: string | null) =>
      c.post<unknown>('/auth/session/native/logout', { body: { app, ...(refreshToken ? { refreshToken } : {}) },
        auth: !!token, ...(token ? { token } : {}), native: true, noRenew: true }),
    /** Checked while the session lock is held: a 401 fails it (no renewal, which would wait for the same lock). */
    profile: () => c.get<Profile>('/auth/profile', { noRenew: true }),
    /** Customers only: every token issued so far stops working. */
    revokeSessions: () => c.post<unknown>('/auth/sessions/revoke'),
  };
}
