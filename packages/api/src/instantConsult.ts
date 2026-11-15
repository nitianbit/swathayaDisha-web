import type { ApiClient } from './client.ts';
import type { PaymentOrder } from './customer.ts';

/**
 * Q4b "Consult now" for customers (`/instant`). Mirrors src1/modules/doctors/services/instant.ts (`onlineDoctors`,
 * `quote`, `create`, `payAgain`, `reoffer`, `activity`, `requestRefund`, `requestView`), validation/index.ts and
 * model/instant.ts. Price contract: the quote is paid upfront; each offer lasts 5 minutes; when a doctor accepts, the
 * difference between the quote and that doctor's fee goes back to the wallet; no customer cancel after acceptance; held
 * money is refunded to the wallet on request, or after 30 minutes without activity. Amounts are integer paise.
 */

export type InstantMode = 'video' | 'call' | 'chat';
export const INSTANT_MODES: InstantMode[] = ['video', 'call', 'chat'];

/** GET /instant/doctors: online now (available, heartbeat within 2 minutes, not busy), cheapest first. */
export interface OnlineDoctor {
  doctorId: string;
  name: string;
  rating?: number;
  specialization?: string;
  modes: InstantMode[];
  instantFeeMinor: number;
  instantFee: number;
}

/** GET /instant/quote: a specific doctor's fee, or for "any available" the highest fee among online doctors now. */
export interface InstantQuote { quotedAmountMinor: number; doctors: number }

export type InstantTarget = { kind: 'any' } | { kind: 'specific'; doctorId: string };

export type InstantStatus = 'pending_payment' | 'offered' | 'accepted' | 'refunded' | 'expired_unpaid';

export interface MoneySplit { couponMinor: number; walletMinor: number; gatewayMinor: number; totalMinor: number }

/** `requestView`: the request without ledger internals or its request key. */
export interface InstantRequest {
  _id: string;
  patient: { kind: 'self' | 'dependent'; dependentId?: string; name: string };
  specialization: string;
  mode: InstantMode;
  target: { kind: 'specific' | 'any'; doctorId?: string };
  quotedAmountMinor: number;
  couponCode?: string;
  couponDoctorIds?: string[];
  discountMinor: number;
  funding?: MoneySplit;
  fundingState: 'awaiting' | 'held' | 'allocated' | 'refunded';
  allocated?: MoneySplit;
  /** The quote difference given back at acceptance (wallet + gateway parts went to the wallet; the coupon part is void). */
  returned?: { couponVoidedMinor: number; walletMinor: number; gatewayMinor: number; totalMinor: number };
  refunded?: { walletMinor: number; gatewayMinor: number; totalMinor: number };
  status: InstantStatus;
  statusVersion?: number;
  paymentStatus: 'pending' | 'paid' | 'refunded';
  paymentTransactionId?: string;
  /** ISO: an unpaid request expires after this (30 minutes). */
  paymentDeadline: string;
  offerGeneration: number;
  /** ISO: the current offer can be accepted until this (5 minutes per offer). */
  offerExpiresAt?: string;
  offeredTo?: string[];
  /** ISO: held money goes back to the wallet at this time unless the customer is still waiting (activity moves it). */
  inactivityRefundAt?: string;
  acceptedBy?: string;
  acceptedFeeMinor?: number;
  /** The consultation booking created at acceptance (bookingKind 'instant'). */
  bookingId?: string;
  refundReason?: 'customer' | 'inactivity' | 'doctor_cancelled';
  createdAt?: string;
}

export interface NewInstantRequest {
  target: InstantTarget;
  specialization: string;
  mode: InstantMode;
  patient: { kind: 'self' } | { kind: 'dependent'; dependentId: string };
  couponCode?: string;
  useWalletBalance?: boolean;
}

export interface InstantPayment { request: InstantRequest; paymentRequired: boolean; payment?: PaymentOrder }

/** Backend constants (OFFER_MS, INACTIVITY_MS, INSTANT_PAYMENT_WINDOW_MS). */
export const INSTANT_OFFER_MIN = 5;
export const INSTANT_INACTIVITY_MIN = 30;
export const INSTANT_PAYMENT_WINDOW_MIN = 30;
/** onlineDoctorsQuerySchema: speciality 2–80 characters. */
export const SPECIALITY_LIMITS = { min: 2, max: 80 } as const;

export const INSTANT_MODE_LABEL: Record<InstantMode, string> = { video: 'Video call', call: 'Phone call', chat: 'Chat' };

/** Whether the customer can still act on a waiting request, and how. */
export function waitingState(r: Pick<InstantRequest, 'status' | 'fundingState' | 'offerExpiresAt'>, now = Date.now()):
  'not_waiting' | 'offer_open' | 'offer_expired' {
  if (r.status !== 'offered' || r.fundingState !== 'held') return 'not_waiting';
  const ends = r.offerExpiresAt ? Date.parse(r.offerExpiresAt) : NaN;
  return Number.isFinite(ends) && ends > now ? 'offer_open' : 'offer_expired';
}

/** What went back to the wallet when held money was refunded (before acceptance): everything but the coupon part. */
export function heldRefundMinor(r: Pick<InstantRequest, 'funding' | 'refunded' | 'refundReason'>): number {
  if (r.refundReason === 'doctor_cancelled') return r.refunded?.totalMinor ?? 0;
  return (r.funding?.walletMinor ?? 0) + (r.funding?.gatewayMinor ?? 0);
}

/** "m:ss" left until `until` (never negative). */
export function countdown(until: string | undefined, now = Date.now()): string {
  const ms = Math.max(0, (until ? Date.parse(until) : now) - now);
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const hex = /^[0-9a-fA-F]{24}$/;
const id = (v: string, what: string) => { if (!hex.test(v)) throw new Error(`Invalid ${what} id`); return v; };
const speciality = (s: string) => {
  const v = s.trim();
  if (v.length < SPECIALITY_LIMITS.min || v.length > SPECIALITY_LIMITS.max) throw new Error('Invalid speciality');
  return v;
};
const targetBody = (t: InstantTarget) => (t.kind === 'specific' ? { kind: 'specific', doctorId: id(t.doctorId, 'doctor') } : { kind: 'any' });

export function instantConsultApi(c: ApiClient) {
  return {
    doctors: (specialization: string, mode: InstantMode) =>
      c.get<OnlineDoctor[]>('/instant/doctors', { query: { specialization: speciality(specialization), mode } }).then((d) => (Array.isArray(d) ? d : [])),
    /** 409 NO_DOCTOR_ONLINE / DOCTOR_NOT_ONLINE when nobody (or not that doctor) is online now. */
    quote: (specialization: string, mode: InstantMode, doctorId?: string) =>
      c.get<InstantQuote>('/instant/quote', { query: { specialization: speciality(specialization), mode, doctorId: doctorId ? id(doctorId, 'doctor') : undefined } }),
    /** Keyed create: the same key and details again return the first request (and its open payment), never a second. */
    create: (body: NewInstantRequest, requestKey: string) =>
      c.post<InstantPayment>('/instant/requests', { body: { ...body, target: targetBody(body.target), specialization: speciality(body.specialization), requestKey } }),
    /** The newest 50 requests (the backend does not page this list). */
    requests: () => c.get<InstantRequest[]>('/instant/requests').then((d) => (Array.isArray(d) ? d : [])),
    request: (requestId: string) => c.get<InstantRequest>(`/instant/requests/${id(requestId, 'request')}`),
    /** Pay again within the payment window: earlier attempts are checked first; the open order is reused. */
    pay: (requestId: string, useWalletBalance = false) =>
      c.post<InstantPayment>(`/instant/requests/${id(requestId, 'request')}/pay`, { body: useWalletBalance ? { useWalletBalance: true } : {} }),
    /** Offers the waiting request again (a new 5-minute offer) to one online doctor or any available, within the paid quote. */
    reoffer: (requestId: string, target: InstantTarget) =>
      c.post<InstantRequest>(`/instant/requests/${id(requestId, 'request')}/reoffer`, { body: { target: targetBody(target) } }),
    /** "Still here": moves the inactivity refund 30 minutes out. 409 REQUEST_NOT_OPEN once nobody can accept any more. */
    activity: (requestId: string) => c.post<InstantRequest>(`/instant/requests/${id(requestId, 'request')}/activity`),
    /** Refunds the held money to the wallet; refused once a doctor accepted (409 REQUEST_NOT_REFUNDABLE). */
    refund: (requestId: string) => c.post<{ refunded: number; skipped: boolean }>(`/instant/requests/${id(requestId, 'request')}/refund`),
    /** Coupon check with the context the create uses (`consultation`, the chosen doctor, the patient). */
    checkCoupon: (b: { code: string; purchaseAmount: number; doctorId?: string; dependentId?: string }) =>
      c.post<{ isValid: boolean; discountAmount?: number; finalAmount?: number; coupon?: { code: string } }>('/coupons/validate', {
        body: { code: b.code, bookingType: 'consultation', purchaseAmount: b.purchaseAmount,
          ...(b.doctorId ? { bookingId: id(b.doctorId, 'doctor') } : {}), ...(b.dependentId ? { dependentId: id(b.dependentId, 'family member') } : {}) },
      }),
  };
}
