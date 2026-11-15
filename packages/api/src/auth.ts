import type { ApiClient } from './client.ts';

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

/** D4: once-only operations whose outcome a reloaded page never saw. */
export type OnceOnlyKind = 'customer_return' | 'supplier_return' | 'booking_create' | 'pharmacy_checkout';

/**
 * Abandons an unresolved request key on the server: afterwards the old request can never be performed, so a new one
 * is safe. 'used' means the old request WAS performed (look for its record instead).
 */
export function requestKeysApi(c: ApiClient) {
  return {
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

function partnerSelector(c: ApiClient): PartnerSelector {
  return ((ticket: string, partnerId: string, mode: SignInMode) => {
    if (!OBJECT_ID.test(partnerId)) throw new Error('Invalid partner id');
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
    verifyOtp: <U extends UserType>(userType: U, target: OtpTarget, otp: string) =>
      c.post<VerifyAnswer<U, SignedIn>>(`/auth/${userType}/verify`, { body: { ...target, otp }, auth: false }),
    /** D4: sign in with a first-party cookie session (web apps behind their own host's /api forward). */
    verifyOtpSession: <U extends UserType>(userType: U, target: OtpTarget, otp: string) =>
      c.post<VerifyAnswer<U, SessionSignedIn>>(`/auth/${userType}/verify`, { body: { ...target, otp, session: 'cookie' }, auth: false, session: true }),
    /**
     * Q7: opens the chosen partner workspace with the ticket from a selection answer. Answered exactly like a verify in
     * the same mode (bearer, cookie or native). A used or expired ticket: 401 `SELECTION_EXPIRED` (request a new code).
     */
    selectPartner: partnerSelector(c),
    refreshSession: () => c.post<SessionRefreshed>('/auth/session/refresh', { body: {}, auth: false, session: true }),
    /** Ends the cookie's family and the family of `token` (the access token this tab was using). */
    logoutSession: (token?: string | null) =>
      c.post<unknown>('/auth/session/logout', { body: {}, auth: !!token, ...(token ? { token } : {}), session: true }),
    /** N1: phone-app sign-in; `previousRefreshToken` (the one still in the secure store) is ended by the server. */
    verifyOtpNative: <U extends UserType>(userType: U, target: OtpTarget, otp: string, app: NativeApp, previousRefreshToken?: string | null) =>
      c.post<VerifyAnswer<U, NativeSignedIn>>(`/auth/${userType}/verify`, { body: { ...target, otp, session: 'native', app,
        ...(previousRefreshToken ? { previousRefreshToken } : {}) }, auth: false, native: true }),
    refreshNative: (app: NativeApp, refreshToken: string) =>
      c.post<NativeRefreshed>('/auth/session/native/refresh', { body: { app, refreshToken }, auth: false, native: true }),
    /** Ends the stored family and the family of `token` (the access token in use). */
    logoutNative: (app: NativeApp, refreshToken: string | null, token?: string | null) =>
      c.post<unknown>('/auth/session/native/logout', { body: { app, ...(refreshToken ? { refreshToken } : {}) },
        auth: !!token, ...(token ? { token } : {}), native: true }),
    /** Checked while the session lock is held: a 401 fails it (no renewal, which would wait for the same lock). */
    profile: () => c.get<Profile>('/auth/profile', { noRenew: true }),
    /** Customers only: every token issued so far stops working. */
    revokeSessions: () => c.post<unknown>('/auth/sessions/revoke'),
  };
}
