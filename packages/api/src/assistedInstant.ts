import { ApiError, type ApiClient, type Page } from './client.ts';
import {
  assistedRefusal, idOf, keyOf, MAX_CONCERN, rupees, SLOW_WRITE_TIMEOUT_MS, type AssistedPatient, type JoinOn, type Refusal,
} from './assisted.ts';
import { countdown, SPECIALITY_LIMITS, waitingState, type InstantQuote, type InstantSpeciality, type InstantTarget } from './instantConsult.ts';

/**
 * WQ22: a pharmacy's "Consult now" (assisted booking round 3e, backend r17 `m0/r17-phase3e` 02b4a0e0, design §25.12): an
 * instant consultation for a walk-in patient, paid from the pharmacy's Jansetu wallet (`/pharmacy-assisted/instant/*`,
 * pharmacy token). The request is offered to online doctors; the first to accept makes the booking (then shown in
 * Booked consultations with its Join call). A full refund before acceptance comes back to the wallet; the server also
 * refunds 30 minutes after the booker stops sending activity. The phone travels only in POST bodies.
 */

export type InstantDeskMode = 'video' | 'call';
export const INSTANT_DESK_MODES: readonly InstantDeskMode[] = ['video', 'call'];

/** `GET /doctors`: eligible, online and not busy; nearest first (`nearby`), then by fee. */
export interface InstantDoctor {
  doctorId: string; name: string; specialization?: string; modes: string[]; instantFeeMinor: number; nearby: 'pincode' | 'city' | null;
}

export interface InstantBookerRequest {
  requestKey: string;
  phone: string;
  patient: AssistedPatient;
  holderName?: string;
  consent: { agreed: true; statementVersion: string; statementLanguage: string };
  preferredLanguage: string;
  specialization: string;
  mode: InstantDeskMode;
  target: InstantTarget;
  join: { on: JoinOn; phone?: string };
  couponCode?: string;
  /** The quote shown and the quote minus the coupon (paise): 409 QUOTE_CHANGED on any difference. */
  acceptedQuoteMinor: number;
  acceptedPayableMinor: number;
  primaryConcern?: string;
  paymentMethod: 'wallet';
}

export type InstantBookerStatus = 'offered' | 'accepted' | 'refunded' | string;
/** `<view>` (§25.12): the booker's request, money in paise. */
export interface InstantBookerView {
  _id: string;
  status: InstantBookerStatus;
  statusVersion: number;
  mode: InstantDeskMode;
  specialization: string;
  target: { kind: 'any' | 'specific'; doctorId?: string };
  offerGeneration: number;
  offerExpiresAt?: string | null;
  inactivityRefundAt?: string | null;
  offeredCount?: number;
  acceptedDoctorName?: string | null;
  bookingId?: string | null;
  patientName?: string | null;
  assisted?: { shortRef?: string; join?: { on: JoinOn }; preferredLanguage?: string };
  money?: { quotedAmountMinor: number; discountMinor: number; paidMinor: number; returnedMinor: number; refundedMinor: number };
  createdAt?: string;
  updatedAt?: string;
}
export interface InstantBookerReceipt {
  request: InstantBookerView;
  funding: { method: string; amountMinor: number; state: string; walletEntryId: string | null };
  newAccount: boolean;
  replayed: boolean;
}
export type InstantBookerByKey = { state: 'used'; request: InstantBookerView } | { state: 'abandoned' } | { state: 'unknown' };

const speciality = (s: string) => {
  const v = s.trim();
  if (v.length < SPECIALITY_LIMITS.min || v.length > SPECIALITY_LIMITS.max) throw new Error('Invalid speciality');
  return v;
};
const modeOf = (m: string): InstantDeskMode => { if (m !== 'video' && m !== 'call') throw new Error('Invalid mode'); return m; };
const targetBody = (t: InstantTarget): InstantTarget => (t.kind === 'specific' ? { kind: 'specific', doctorId: idOf(t.doctorId, 'doctor') } : { kind: 'any' });
const versionOf = (v: number) => { if (!Number.isSafeInteger(v) || v < 0) throw new Error('Invalid version'); return v; };

/** The body checked before it is sent (speciality, mode, the doctor's id, the concern's length). */
export function bookerInstantBody(body: InstantBookerRequest): InstantBookerRequest {
  if (body.primaryConcern !== undefined && body.primaryConcern.length > MAX_CONCERN) throw new Error('Invalid concern');
  return { ...body, specialization: speciality(body.specialization), mode: modeOf(body.mode), target: targetBody(body.target) };
}

export function pharmacyInstantApi(c: ApiClient) {
  const base = '/pharmacy-assisted/instant';
  const req = (id: string) => `${base}/requests/${idOf(id, 'request')}`;
  return {
    specialities: (mode: InstantDeskMode) => c.get<InstantSpeciality[]>(`${base}/specialities`, { query: { mode: modeOf(mode) } }),
    doctors: (q: { speciality: string; mode: InstantDeskMode }) =>
      c.get<InstantDoctor[]>(`${base}/doctors`, { query: { speciality: speciality(q.speciality), mode: modeOf(q.mode) } }),
    quote: (q: { speciality: string; mode: InstantDeskMode; doctorId?: string }) =>
      c.get<InstantQuote>(`${base}/quote`, { query: { speciality: speciality(q.speciality), mode: modeOf(q.mode), doctorId: q.doctorId ? idOf(q.doctorId, 'doctor') : undefined } }),
    /** Exactly once per request key; the same key and content answer the request again (`replayed`). */
    request: (body: InstantBookerRequest) => {
      keyOf(body.requestKey);
      return c.post<InstantBookerReceipt>(`${base}/requests`, { body: bookerInstantBody(body), timeoutMs: SLOW_WRITE_TIMEOUT_MS });
    },
    requests: (q: { status?: 'offered' | 'accepted' | 'refunded'; cursor?: string; limit?: number } = {}): Promise<Page<InstantBookerView>> =>
      c.page<InstantBookerView>(`${base}/requests`, { query: { ...q } }),
    one: (id: string) => c.get<InstantBookerView>(req(id)),
    byKey: (key: string) => c.get<InstantBookerByKey>(`${base}/requests/by-key/${keyOf(key)}`),
    abandon: (key: string) => c.post<InstantBookerByKey>(`${base}/requests/by-key/${keyOf(key)}/abandon`),
    /** A new offer (to any doctor, or a chosen one) on the version shown (409 INSTANT_REQUEST_CHANGED). */
    reoffer: (id: string, target: InstantTarget, expectedStatusVersion: number) =>
      c.post<InstantBookerView>(`${req(id)}/reoffer`, { body: { target: targetBody(target), expectedStatusVersion: versionOf(expectedStatusVersion) } }),
    /** The booker is still here: the inactivity refund moves 30 minutes out. */
    activity: (id: string) => c.post<InstantBookerView>(`${req(id)}/activity`),
    /** Before a doctor accepts: the full amount back to the wallet. */
    refund: (id: string, expectedStatusVersion: number) =>
      c.post<{ refundedMinor: number; request: InstantBookerView }>(`${req(id)}/refund`, { body: { expectedStatusVersion: versionOf(expectedStatusVersion) } }),
  };
}

// ── Rules and words for the screen ──

/** Where a request stands for the booker: waiting on an open offer, the offer ran out, a doctor accepted, refunded. */
export function instantStage(v: Pick<InstantBookerView, 'status' | 'offerExpiresAt'>, now = Date.now()): 'waiting' | 'expired' | 'accepted' | 'refunded' | 'other' {
  if (v.status === 'accepted') return 'accepted';
  if (v.status === 'refunded') return 'refunded';
  if (v.status !== 'offered') return 'other';
  return waitingState({ status: 'offered', fundingState: 'held', offerExpiresAt: v.offerExpiresAt ?? undefined }, now) === 'offer_open' ? 'waiting' : 'expired';
}
export { countdown as offerCountdown };
/** How often the open screen tells the server the booker is still here (the refund comes 30 minutes after the last). */
export const INSTANT_ACTIVITY_MS = 60_000;
/** How often the open screen reads the request while it waits. */
export const INSTANT_POLL_MS = 5_000;

export const INSTANT_SWITCHED_OFF_MESSAGE = 'Consult now for patients is not switched on yet.';
const INSTANT_WORDS: Readonly<Record<string, Refusal>> = {
  NO_DOCTOR_ONLINE: { kind: 'doctor', message: 'No doctor of this speciality is online now. Try again in a few minutes, or book a time instead.' },
  DOCTOR_NOT_ONLINE: { kind: 'doctor', message: 'This doctor is not online any more. Choose “Any available doctor” or another doctor.' },
  DOCTOR_REQUIRED: { kind: 'doctor', message: 'Choose a doctor, or “Any available doctor”.' },
  INSTANT_REQUEST_NOT_FOUND: { kind: 'other', message: 'This request was not found.' },
  REQUEST_NOT_OPEN: { kind: 'other', message: 'This request is no longer waiting for a doctor. It is shown as it is now.' },
  REQUEST_NOT_REFUNDABLE: { kind: 'other', message: 'A doctor has already accepted, so it can no longer be refunded here. Cancel the booking instead.' },
  INSTANT_REQUEST_CHANGED: { kind: 'other', message: 'The request changed meanwhile (a doctor may have accepted). It is shown as it is now.' },
  PAYMENT_METHOD_UNAVAILABLE: { kind: 'other', message: 'Consult now can only be paid from the Jansetu wallet.' },
};

/** QUOTE_CHANGED's `details` (the quote and discount the server names, paise), or null for any other answer: the one parser. */
export function changedQuote(err: unknown): { quotedAmountMinor: number; discountMinor: number } | null {
  if (!(err instanceof ApiError) || err.code !== 'QUOTE_CHANGED') return null;
  const d = (err.details ?? {}) as { quotedAmountMinor?: unknown; discountMinor?: unknown };
  const q = Number(d.quotedAmountMinor);
  const disc = Number(d.discountMinor ?? 0);
  return Number.isSafeInteger(q) && q >= 0 && Number.isSafeInteger(disc) && disc >= 0 ? { quotedAmountMinor: q, discountMinor: disc } : null;
}

/** One plain sentence for a refusal (the shared assisted words for wallet, patient, coupon, limits; the quote as the server names it). */
export function instantBookerRefusal(err: unknown): Refusal {
  if (err instanceof ApiError && err.code === 'QUOTE_CHANGED') {
    const q = changedQuote(err);
    if (!q) return { kind: 'price', message: 'The price has changed. Choose the doctor again to see the new price.' };
    const pay = Math.max(0, q.quotedAmountMinor - q.discountMinor);
    return { kind: 'price', priceMinor: pay, message: `The price has changed. It is now ${rupees(pay)}. Check it with the patient, then pay again.` };
  }
  // WQ22c L3: a server without r17 has no such routes (a 404 with no code): said as not switched on, never "Route not found".
  if (err instanceof ApiError && err.status === 404 && !err.code) return { kind: 'off', message: INSTANT_SWITCHED_OFF_MESSAGE };
  const shared = assistedRefusal(err);
  if (shared.kind === 'off') return { kind: 'off', message: INSTANT_SWITCHED_OFF_MESSAGE };
  const known = err instanceof ApiError && err.code ? INSTANT_WORDS[err.code] : undefined;
  return known ?? shared;
}
