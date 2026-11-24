import { ApiError, type ApiClient, type Page } from './client.ts';
import {
  assistedRefusal, idOf, keyOf, SLOW_WRITE_TIMEOUT_MS, type AssistedCardPayment, type AssistedPatient, type AssistedPaymentMethod, type BookingPayment,
  type CardRefund, type Refusal, type RefundTo,
} from './assisted.ts';
import { LAB_BOOKING_STATUS_LABEL, type LabBookingStatus } from './partnerLabs.ts';
import type { VisitMode } from './partnerInvoices.ts';

/**
 * WQ17: assisted booking phase 2a, a pharmacy books a lab test for a walk-in patient, paid from its Jansetu wallet
 * (backend r11 `m0/r11-phase2a` f5f171c9, design ASSISTED_BOOKING_DESIGN.md §24.11; routes `/pharmacy-assisted/labs*`,
 * `/pharmacy-assisted/lab-bookings*`). Money in paise. The phone travels only in POST bodies.
 */

export interface AssistedLabBranch { branchId: string; name: string; address?: string; phone?: string; homeCollection: boolean; inLab: boolean }
export interface AssistedLab { partnerId: string; name: string; nearby: 'pincode' | 'city' | null; branches: AssistedLabBranch[] }
export interface AssistedLabItem {
  itemId: string; kind: 'test' | 'package' | string; name: string; code?: string; description?: string; preparation?: string; sampleType?: string;
  includes?: string[]; price?: number; priceMinor: number; mrpMinor?: number; visitModes?: VisitMode[]; reportTatHours?: number;
}
export interface AssistedLabSlot { slotId: string; date: string; startTime: string; endTime: string; seatsLeft: number }
export interface LabAddress { line1: string; line2?: string; city: string; state?: string; pincode: string; landmark?: string }

export interface LabBookingRequest {
  requestKey: string;
  phone: string;
  patient: AssistedPatient;
  holderName?: string;
  consent: { agreed: true; statementVersion: string; statementLanguage: string };
  preferredLanguage: string;
  partnerId: string;
  branchId: string;
  visitMode: VisitMode;
  slotId: string;
  itemIds: string[];
  address?: LabAddress;
  couponCode?: string;
  acceptedPriceMinor: number;
  /** Not sent: r11 validates `notes` but never stores or shows it (API gap), so the screen offers no note. */
  notes?: string;
  /** WQ17c (r14 phase 2b, §24.14): `razorpay` = paid by card or UPI on one Razorpay order. */
  paymentMethod: AssistedPaymentMethod;
}

/** The booker lab view (`assisted/labBookings.ts` `bookerLabViews`): an allowlist; never prices, keys or funding internals. */
export interface LabBookingView {
  _id: string;
  source?: string;
  partnerId?: string;
  lab?: { name: string | null };
  branchId?: string;
  branch?: { name?: string; address?: string; phone?: string } | null;
  visitMode?: VisitMode | string;
  address?: LabAddress;
  slot?: { slotId?: string; date?: string; startTime?: string; endTime?: string; startsAt?: string };
  items?: { name: string; kind?: string; code?: string }[];
  status: LabBookingStatus | string;
  statusVersion?: number;
  reschedule?: { pending: boolean; version: number; previousSlot?: { date?: string; startTime?: string; endTime?: string; startsAt?: string }; reason?: string; at?: string } | null;
  collector?: { name: string } | null;
  cancellation?: { reason?: string; byKind?: string; at?: string } | null;
  lifecycle?: Record<string, unknown>;
  /** The family member's name, else the holder as this pharmacy may see them (typed, else masked). */
  patientName?: string | null;
  holder?: { pharmacyCustomerId: string | null; name: string | null; typedName?: string | null };
  userId?: string;
  assisted?: { shortRef?: string; bookedBy?: { name?: string }; preferredLanguage?: string; disputed?: { state: string } };
  payment?: BookingPayment;
  /** Released files only, while the 90 days run (empty before a release and after them). */
  report?: { releases: { file: string; releasedAt?: string; signer?: { name?: string; kind?: string; registrationNumber?: string } }[] };
  createdAt?: string;
  updatedAt?: string;
}
export interface LabReceipt {
  booking: LabBookingView;
  funding: { method: string; amountMinor: number; state: string; walletEntryId: string | null; paymentTransactionId?: string | null };
  split: { listMinor: number; discountMinor: number; couponCode: string | null };
  /** WQ17c: card bookings only: the open order while it waits for payment, else null. */
  payment?: AssistedCardPayment | null;
  newAccount: boolean;
  replayed: boolean;
}
/** WQ17c: `payment` only for a card booking: its open order (read only), null when none is open. */
export type LabByKeyAnswer = { state: 'used'; booking: LabBookingView; payment?: AssistedCardPayment | null } | { state: 'abandoned' } | { state: 'unknown' };
/** `refund` for card bookings only (null: cancelled before it was paid). */
export interface LabCancelAnswer { booking: LabBookingView; refundedMinor: number; alreadyCancelled: boolean; refund?: CardRefund | null }
export type LabBookingListStatus = LabBookingStatus;


export function pharmacyLabApi(c: ApiClient) {
  return {
    /** Labs near the pharmacy first (`nearby`: its pincode, then its city), each with its active branches. */
    labs: (q: { visitMode?: VisitMode; limit?: number } = {}) => c.get<AssistedLab[]>('/pharmacy-assisted/labs', { query: { ...q } }),
    catalogue: (partnerId: string, visitMode?: VisitMode) =>
      c.get<AssistedLabItem[]>(`/pharmacy-assisted/labs/${idOf(partnerId, 'lab')}/catalogue`, { query: visitMode ? { visitMode } : {} }),
    /** Bookable times (at least 60 minutes ahead) for one branch and visit mode, `days` (1–14) from `from` (YYYY-MM-DD). */
    slots: (branchId: string, q: { visitMode: VisitMode; from?: string; days?: number }) =>
      c.get<AssistedLabSlot[]>(`/pharmacy-assisted/labs/branches/${idOf(branchId, 'branch')}/slots`, { query: { ...q } }),
    book: (body: LabBookingRequest) => c.post<LabReceipt>('/pharmacy-assisted/lab-bookings', { body, timeoutMs: SLOW_WRITE_TIMEOUT_MS }),
    /** Newest first, cursor-paged (`pagination.nextCursor`), 1–50 a page; `from`/`to` filter the slot date. */
    bookings: (q: { status?: LabBookingListStatus; from?: string; to?: string; cursor?: string; limit?: number } = {}): Promise<Page<LabBookingView>> =>
      c.page<LabBookingView>('/pharmacy-assisted/lab-bookings', { query: { ...q } }),
    booking: (id: string) => c.get<LabBookingView>(`/pharmacy-assisted/lab-bookings/${idOf(id, 'booking')}`),
    byKey: (key: string) => c.get<LabByKeyAnswer>(`/pharmacy-assisted/lab-bookings/by-key/${keyOf(key)}`),
    abandon: (key: string) => c.post<LabByKeyAnswer>(`/pharmacy-assisted/lab-bookings/by-key/${keyOf(key)}/abandon`),
    /** Before 1 hour to the slot, or any time while a new time from the lab is unanswered; the refund goes to the wallet. */
    cancel: (id: string, body: { reason?: string; expectedVersion?: number; refundTo?: RefundTo }) =>
      c.post<LabCancelAnswer>(`/pharmacy-assisted/lab-bookings/${idOf(id, 'booking')}/cancel`, { body }),
    /** `version`: the `reschedule.version` shown. */
    acceptReschedule: (id: string, version: number) =>
      c.post<LabBookingView>(`/pharmacy-assisted/lab-bookings/${idOf(id, 'booking')}/accept-reschedule`, { body: { version } }),
  };
}

// ── Rules and words for the screens ──

export const labStatusLabel = (s: string | undefined) => (s ? (LAB_BOOKING_STATUS_LABEL as Record<string, string>)[s] ?? s : '—');
/** The booker may cancel up to 1 hour before the slot (`BOOKER_CANCEL_CUTOFF_MS`), or any time while a new time is unanswered. */
export const LAB_BOOKER_CANCEL_CUTOFF_MS = 60 * 60_000;
export function canCancelLab(b: Pick<LabBookingView, 'status' | 'slot' | 'reschedule'>, now = new Date()): boolean {
  // WQ17c (r14 E3): a card booking still waiting for its payment may be cancelled at any time (nothing was paid).
  if (b.status === 'pending_payment') return true;
  if (b.status !== 'confirmed') return false;
  if (b.reschedule?.pending) return true;
  const at = b.slot?.startsAt ? Date.parse(b.slot.startsAt) : NaN;
  return Number.isFinite(at) && now.getTime() <= at - LAB_BOOKER_CANCEL_CUTOFF_MS;
}
/** The tests chosen, priced from the catalogue (the server fences it: 409 PRICE_CHANGED). */
export function labTotalMinor(items: readonly Pick<AssistedLabItem, 'itemId' | 'priceMinor'>[], chosen: readonly string[]): number {
  return items.filter((i) => chosen.includes(i.itemId)).reduce((sum, i) => sum + (Number.isSafeInteger(i.priceMinor) ? i.priceMinor : 0), 0);
}
/** Branches that take this visit mode. */
export const branchesFor = (lab: AssistedLab, mode: VisitMode) => lab.branches.filter((b) => (mode === 'home' ? b.homeCollection : b.inLab));

export const LAB_SWITCHED_OFF_MESSAGE = 'Booking lab tests for patients is not switched on yet.';

const LAB_WORDS: Readonly<Record<string, Refusal>> = {
  LAB_NOT_FOUND: { kind: 'doctor', message: 'This lab is not taking bookings now. Choose another lab.' },
  BRANCH_NOT_AVAILABLE: { kind: 'doctor', message: 'This branch is not taking bookings now. Choose another branch or lab.' },
  VISIT_MODE_NOT_SUPPORTED: { kind: 'doctor', message: 'This branch does not offer this kind of visit. Choose another branch or visit.' },
  SLOT_UNAVAILABLE: { kind: 'slot', message: 'This time was just taken. Choose another time.' },
  CATALOGUE_ITEM_NOT_AVAILABLE: { kind: 'other', message: 'One of the chosen tests is no longer offered here. Choose the tests again.' },
  ADDRESS_REQUIRED: { kind: 'patient', message: 'Enter the address for the home collection.' },
  LAB_BOOKING_NOT_FOUND: { kind: 'other', message: 'This lab booking was not found.' },
  LAB_BOOKING_CHANGED: { kind: 'other', message: 'This booking changed since you opened it. Look at it again, then try again.' },
  LAB_BOOKING_NOT_CANCELLABLE: { kind: 'other', message: 'This lab booking can no longer be cancelled (the sample is taken or the test is done).' },
  CANCELLATION_WINDOW_CLOSED: { kind: 'other', message: 'Too late to cancel: lab bookings can be cancelled up to 1 hour before the time.' },
  NO_SHOW_NOT_REFUNDABLE: { kind: 'other', message: 'This booking was moved after the patient did not come, so it cannot be cancelled for a refund.' },
  NO_PENDING_RESCHEDULE: { kind: 'other', message: 'There is no new time to accept any more. Look at the booking again.' },
  RESCHEDULE_CHANGED: { kind: 'other', message: 'The lab changed the time again. Look at the new time, then accept it or cancel.' },
};

/** One plain sentence for a refusal of the lab routes (the shared assisted words first for wallet, price, limits, switch). */
export function labRefusal(err: unknown): Refusal {
  const shared = assistedRefusal(err);
  if (shared.kind === 'off') return { kind: 'off', message: LAB_SWITCHED_OFF_MESSAGE };
  const known = err instanceof ApiError && err.code ? LAB_WORDS[err.code] : undefined;
  return known ?? shared;
}

// ── WQ21: the recommended-tests code (backend r16 phase 3d, design §25.12.4) ──

/** `POST /pharmacy-assisted/recommendations/lookup {code, phone}` (r16b): the test names the doctor advised, and nothing else. */
export interface TestRecommendation { code: string; status: string; items: { index: number; name: string }[] }

/** The code as typed, made ready to send: spaces and hyphens dropped, upper case (the server reads I/L as 1, O as 0 itself). */
export function cleanRecommendationCode(text: string): string | null {
  const c = text.replace(/[\s-]/g, '').toUpperCase();
  return /^[0-9A-Z]{4,20}$/.test(c) ? c : null;
}
/** "ABCD-EFGH", as printed on the prescription. */
export const formatRecommendationCode = (code: string) => (code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code);

/**
 * By the code AND the patient's mobile number (the server's one answer for a wrong code or a wrong number). r16b: both
 * travel in the POST body, never in the URL. `path`: the pharmacy's or the lab desk's lookup route.
 */
export function recommendationLookup(c: ApiClient, path: string) {
  return (code: string, phone: string) => {
    const clean = cleanRecommendationCode(code);
    if (!clean) throw new Error('Invalid recommendation code');
    return c.post<TestRecommendation>(path, { body: { code: clean, phone } });
  };
}
export function pharmacyRecommendationsApi(c: ApiClient) {
  return { load: recommendationLookup(c, '/pharmacy-assisted/recommendations/lookup') };
}

const sameName = (n: string) => n.trim().replace(/\s+/g, ' ').toLowerCase();
/** The catalogue items named exactly as a recommended test (case and spaces aside), and the names this lab does not list. */
export function matchRecommended(items: readonly { itemId: string; name: string }[], names: readonly string[]): { itemIds: string[]; unmatched: string[] } {
  const itemIds: string[] = [];
  const unmatched: string[] = [];
  for (const name of names) {
    const hit = items.find((i) => sameName(i.name) === sameName(name));
    if (hit) { if (!itemIds.includes(hit.itemId)) itemIds.push(hit.itemId); } else unmatched.push(name);
  }
  return { itemIds, unmatched };
}

const REC_WORDS: Readonly<Record<string, string>> = {
  INVALID_CODE: 'This code is not valid. Check it on the prescription.',
  VALIDATION_ERROR: 'This code is not valid. Check it on the prescription.',
  RECOMMENDATION_NOT_FOUND: 'No recommended tests were found for this code and this mobile number. Check both with the patient.',
  INVALID_PHONE: 'Enter a valid 10-digit mobile number.',
};
/**
 * The field is hidden: the switch is off (503 `RECOMMENDATIONS_DISABLED`, or a server without the route), or (WQ21b, the lab
 * desk) this workspace may not load them (403 `LAB_PARTNER_REQUIRED`, `PARTNER_NOT_VERIFIED`).
 */
export const recommendationsOff = (err: unknown) => err instanceof ApiError
  && (err.code === 'RECOMMENDATIONS_DISABLED' || ((err.status === 404 || err.status === 503) && !err.code)
    || (err.status === 403 && (err.code === 'LAB_PARTNER_REQUIRED' || err.code === 'PARTNER_NOT_VERIFIED')));
export function recommendationRefusal(err: unknown): string {
  if (err instanceof ApiError && err.code && REC_WORDS[err.code]) return REC_WORDS[err.code]!;
  return assistedRefusal(err).message;
}
