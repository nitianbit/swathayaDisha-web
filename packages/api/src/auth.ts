import type { ApiClient } from './client.ts';

/** The backend's login kinds (`/auth/:userType/send|verify`). */
export type UserType = 'user' | 'admin' | 'specialist' | 'hr' | 'pharmacy';

/** OTP goes to a 10-digit phone or an email (backend Joi rules). */
export type OtpTarget = { phone: string } | { email: string };

export interface SignedIn {
  token: string;
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

export interface Profile {
  user: Record<string, unknown>;
  userRole: UserType;
}

export const PHONE_PATTERN = /^[0-9]{10}$/;
export const OTP_PATTERN = /^[0-9]{6}$/;

export function authApi(c: ApiClient) {
  return {
    sendOtp: (userType: UserType, target: OtpTarget) =>
      c.post<void>(`/auth/${userType}/send`, { body: target, auth: false }),
    verifyOtp: (userType: UserType, target: OtpTarget, otp: string) =>
      c.post<SignedIn>(`/auth/${userType}/verify`, { body: { ...target, otp }, auth: false }),
    /** D4: sign in with a first-party cookie session (web apps behind their own host's /api forward). */
    verifyOtpSession: (userType: UserType, target: OtpTarget, otp: string) =>
      c.post<SessionSignedIn>(`/auth/${userType}/verify`, { body: { ...target, otp, session: 'cookie' }, auth: false, session: true }),
    refreshSession: () => c.post<SessionRefreshed>('/auth/session/refresh', { body: {}, auth: false, session: true }),
    logoutSession: () => c.post<unknown>('/auth/session/logout', { body: {}, auth: false, session: true }),
    profile: () => c.get<Profile>('/auth/profile'),
    /** Customers only: every token issued so far stops working. */
    revokeSessions: () => c.post<unknown>('/auth/sessions/revoke'),
  };
}
