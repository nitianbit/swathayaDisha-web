import { ApiError, type ApiClient, type Page } from './client.ts';
import {
  assistedRefusal, idOf, keyOf, MAX_PERSON_NAME, refusalOf, SLOW_WRITE_TIMEOUT_MS, type AssistedCardPayment, type AssistedPatient, type AssistedPaymentMethod, type BookingPayment,
  type CardRefund, type PatientLookup, type Refusal, type RefusalWords, type RefundTo,
} from './assisted.ts';
import { t, type AssistedKey } from './i18n/assisted/index.ts';
import { onLanguage } from './i18n/words.ts';
import { LAB_BOOKING_STATUS_LABEL, type LabBookingStatus } from './partnerLabs.ts';
import type { VisitMode } from './partnerInvoices.ts';

/**
 * WQ17: assisted booking phase 2a, a pharmacy books a lab test for a walk-in patient, paid from its Jansetu wallet
 * (backend r11 `m0/r11-phase2a` f5f171c9, design ASSISTED_BOOKING_DESIGN.md §24.11; routes `/pharmacy-assisted/labs*`,
 * `/pharmacy-assisted/lab-bookings*`). Money in paise. The phone travels only in POST bodies.
 * WQ25: a verified doctor books the same way (backend r26 phase 3b, design §25.15; routes under `/specialists/me/assisted`):
 * the same routes and shapes, by booker. WQ27 (r29 phase 3c, §25.16): a doctor pays by card or UPI too.
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
  /** The family member's name, else the holder as this booker may see them (typed, else masked). */
  patientName?: string | null;
  /** A pharmacy's link is `pharmacyCustomerId`; a doctor's (r26) `linkId`. */
  holder?: { pharmacyCustomerId?: string | null; linkId?: string | null; name: string | null; typedName?: string | null };
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


/** WQ25: who books a lab test for a patient: a pharmacy (2a) or a verified, active doctor (r26 3b). */
export type LabBookerKind = 'pharmacy' | 'doctor';
const LAB_BASE: Readonly<Record<LabBookerKind, string>> = { pharmacy: '/pharmacy-assisted', doctor: '/specialists/me/assisted' };

/** WQ25 (r26 §25.5.3): the doctor's patient from its own consultation inside its treating window (no phone, no lookup counted). */
export interface ConsultationSource { fromBookingId: string; typedName: string }
/** The patient of a create: a walk-in by phone (both bookers), or (a doctor only) its own consultation. Exactly one. */
export type LabPatientSource = { phone: string; patient: AssistedPatient; holderName?: string } | ConsultationSource;
export type LabCreateRequest = Omit<LabBookingRequest, 'phone' | 'patient' | 'holderName'> & LabPatientSource;

/** The reads, by-key, cancel and accept of either booker: the same routes under its own base. */
function labRoutes(c: ApiClient, kind: LabBookerKind) {
  const base = LAB_BASE[kind];
  return {
    /** Labs near the booker first (`nearby`: its pincode, then its city), each with its active branches. */
    labs: (q: { visitMode?: VisitMode; limit?: number } = {}) => c.get<AssistedLab[]>(`${base}/labs`, { query: { ...q } }),
    catalogue: (partnerId: string, visitMode?: VisitMode) =>
      c.get<AssistedLabItem[]>(`${base}/labs/${idOf(partnerId, 'lab')}/catalogue`, { query: visitMode ? { visitMode } : {} }),
    /** Bookable times (at least 60 minutes ahead) for one branch and visit mode, `days` (1–14) from `from` (YYYY-MM-DD). */
    slots: (branchId: string, q: { visitMode: VisitMode; from?: string; days?: number }) =>
      c.get<AssistedLabSlot[]>(`${base}/labs/branches/${idOf(branchId, 'branch')}/slots`, { query: { ...q } }),
    /** Newest first, cursor-paged (`pagination.nextCursor`), 1–50 a page; `from`/`to` filter the slot date. */
    bookings: (q: { status?: LabBookingListStatus; from?: string; to?: string; cursor?: string; limit?: number } = {}): Promise<Page<LabBookingView>> =>
      c.page<LabBookingView>(`${base}/lab-bookings`, { query: { ...q } }),
    booking: (id: string) => c.get<LabBookingView>(`${base}/lab-bookings/${idOf(id, 'booking')}`),
    byKey: (key: string) => c.get<LabByKeyAnswer>(`${base}/lab-bookings/by-key/${keyOf(key)}`),
    abandon: (key: string) => c.post<LabByKeyAnswer>(`${base}/lab-bookings/by-key/${keyOf(key)}/abandon`),
    /** Before 1 hour to the slot, or any time while a new time from the lab is unanswered; the refund goes to the wallet. */
    cancel: (id: string, body: { reason?: string; expectedVersion?: number; refundTo?: RefundTo }) =>
      c.post<LabCancelAnswer>(`${base}/lab-bookings/${idOf(id, 'booking')}/cancel`, { body }),
    /** `version`: the `reschedule.version` shown. */
    acceptReschedule: (id: string, version: number) =>
      c.post<LabBookingView>(`${base}/lab-bookings/${idOf(id, 'booking')}/accept-reschedule`, { body: { version } }),
  };
}
export type LabRoutes = ReturnType<typeof labRoutes>;

export function pharmacyLabApi(c: ApiClient) {
  return {
    ...labRoutes(c, 'pharmacy'),
    book: (body: LabBookingRequest) => c.post<LabReceipt>(`${LAB_BASE.pharmacy}/lab-bookings`, { body, timeoutMs: SLOW_WRITE_TIMEOUT_MS }),
  };
}

/**
 * WQ25 (r26, §25.15): a verified, active doctor's lab bookings (403 `SPECIALIST_NOT_VERIFIED` otherwise, reads included).
 * The create takes exactly one patient source, checked before sending; WQ27 (r29): the wallet or card / UPI.
 */
export function doctorLabApi(c: ApiClient) {
  const base = LAB_BASE.doctor;
  return {
    ...labRoutes(c, 'doctor'),
    /** POST: the phone stays in the body. Answers the masked holder name only (counted, 120 an hour). */
    lookup: (phone: string) => c.post<PatientLookup>(`${base}/patients/lookup`, { body: { phone } }),
    book: (body: LabCreateRequest) => c.post<LabReceipt>(`${base}/lab-bookings`, { body: doctorLabBody(body), timeoutMs: SLOW_WRITE_TIMEOUT_MS }),
  };
}

/** The doctor's create body: one patient source (`fromBookingId` + `typedName`, or a phone). */
export function doctorLabBody(body: LabCreateRequest): LabCreateRequest {
  keyOf(body.requestKey);
  const b = body as Partial<ConsultationSource> & { phone?: string; patient?: unknown };
  if (b.fromBookingId !== undefined) {
    idOf(b.fromBookingId, 'consultation');
    const name = String(b.typedName ?? '').trim();
    if (!name || name.length > MAX_PERSON_NAME) throw new Error('Invalid patient name'); // i18n-ignore: a programming error, not shown
    if (b.phone !== undefined || b.patient !== undefined) throw new Error('One patient source only'); // i18n-ignore: a programming error, not shown
  } else if (!b.phone || !b.patient) throw new Error('A patient is needed'); // i18n-ignore: a programming error, not shown
  return body;
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

export let LAB_SWITCHED_OFF_MESSAGE = '';
onLanguage(() => { LAB_SWITCHED_OFF_MESSAGE = t('lab.switchedOff'); });

const LAB_WORDS: RefusalWords = {
  LAB_NOT_FOUND: { kind: 'doctor', key: 'lab.LAB_NOT_FOUND' },
  BRANCH_NOT_AVAILABLE: { kind: 'doctor', key: 'lab.BRANCH_NOT_AVAILABLE' },
  VISIT_MODE_NOT_SUPPORTED: { kind: 'doctor', key: 'lab.VISIT_MODE_NOT_SUPPORTED' },
  SLOT_UNAVAILABLE: { kind: 'slot', key: 'refusal.SLOT_NOT_AVAILABLE' },
  CATALOGUE_ITEM_NOT_AVAILABLE: { kind: 'other', key: 'lab.CATALOGUE_ITEM_NOT_AVAILABLE' },
  ADDRESS_REQUIRED: { kind: 'patient', key: 'lab.ADDRESS_REQUIRED' },
  LAB_BOOKING_NOT_FOUND: { kind: 'other', key: 'lab.LAB_BOOKING_NOT_FOUND' },
  LAB_BOOKING_CHANGED: { kind: 'other', key: 'refusal.BOOKING_CHANGED' },
  LAB_BOOKING_NOT_CANCELLABLE: { kind: 'other', key: 'lab.LAB_BOOKING_NOT_CANCELLABLE' },
  CANCELLATION_WINDOW_CLOSED: { kind: 'other', key: 'lab.CANCELLATION_WINDOW_CLOSED' },
  NO_SHOW_NOT_REFUNDABLE: { kind: 'other', key: 'lab.NO_SHOW_NOT_REFUNDABLE' },
  NO_PENDING_RESCHEDULE: { kind: 'other', key: 'lab.NO_PENDING_RESCHEDULE' },
  RESCHEDULE_CHANGED: { kind: 'other', key: 'lab.RESCHEDULE_CHANGED' },
};
const knownIn = (words: RefusalWords, err: unknown) =>
  err instanceof ApiError && err.code && Object.hasOwn(words, err.code) ? refusalOf(words[err.code]!) : undefined;

/** One plain sentence for a refusal of the lab routes (the shared assisted words first for wallet, price, limits, switch). */
export function labRefusal(err: unknown): Refusal {
  const shared = assistedRefusal(err);
  if (shared.kind === 'off') return { kind: 'off', message: LAB_SWITCHED_OFF_MESSAGE };
  return knownIn(LAB_WORDS, err) ?? shared;
}

// ── WQ25: a doctor books (backend r26 phase 3b, design §25.15) ──

/** Every doctor route needs a verified, active doctor (403 `SPECIALIST_NOT_VERIFIED`): said plainly, nothing else shown. */
export let DOCTOR_LAB_CLOSED_MESSAGE = '';
onLanguage(() => { DOCTOR_LAB_CLOSED_MESSAGE = t('lab.doctorClosed'); });
/**
 * r37d (WQ54e): the consent a pharmacy or a doctor attests when booking LAB TESTS ("we": the booker). The version names
 * this exact text (a change of words is a new version); a consultation keeps its own statement (the server answers 400
 * `CONSENT_STATEMENT_MISMATCH` for this one on a consultation).
 */
export const LAB_TEST_CONSENT_VERSION = 'web-lab-test-v1';
export const LAB_TEST_CONSENT_STATEMENT =
  // i18n-ignore: the versioned consent text is recorded as English (round 6f, Q2)
  'The patient (or a family member with them) agreed that we book these lab tests for them on Jansetu; that Jansetu keeps their details, and makes a Jansetu account for this mobile number if it has none; that the lab sees their name, mobile number and the tests booked, to do these tests; that the report reaches the patient in their Jansetu app; and that we can see the report for 90 days after the lab first releases it.';

const DOCTOR_LAB_WORDS: RefusalWords = {
  SPECIALIST_NOT_VERIFIED: { kind: 'other', key: 'lab.doctorClosed' },
  // `fromBookingId`: another doctor's consultation, a missing one, an unpaid card booking or one reported "not mine".
  BOOKING_NOT_FOUND: { kind: 'patient', key: 'lab.doctor.BOOKING_NOT_FOUND' },
  TREATING_WINDOW_CLOSED: { kind: 'patient', key: 'lab.doctor.TREATING_WINDOW_CLOSED' },
};
/** The doctor's words first (its account, its consultation), then the lab and shared words (WQ27: the card's too). */
export function doctorLabRefusal(err: unknown): Refusal {
  return knownIn(DOCTOR_LAB_WORDS, err) ?? labRefusal(err);
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
    if (!clean) throw new Error('Invalid recommendation code'); // i18n-ignore: a programming error, not shown
    return c.post<TestRecommendation>(path, { body: { code: clean, phone } });
  };
}
export function pharmacyRecommendationsApi(c: ApiClient) {
  return { load: recommendationLookup(c, '/pharmacy-assisted/recommendations/lookup') };
}
/** WQ25: the doctor's own route (r16b, a verified, active doctor). */
export function doctorRecommendationsApi(c: ApiClient) {
  return { load: recommendationLookup(c, `${LAB_BASE.doctor}/recommendations/lookup`) };
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

const REC_WORDS: Readonly<Record<string, AssistedKey>> = {
  INVALID_CODE: 'recommendation.invalid',
  VALIDATION_ERROR: 'recommendation.invalid',
  RECOMMENDATION_NOT_FOUND: 'recommendation.notFound',
  INVALID_PHONE: 'patient.phoneInvalid',
};
/**
 * The field is hidden: the switch is off (503 `RECOMMENDATIONS_DISABLED`, or a server without the route), or (WQ21b, the lab
 * desk) this workspace may not load them (403 `LAB_PARTNER_REQUIRED`, `PARTNER_NOT_VERIFIED`; WQ25 a doctor not verified
 * and active, `SPECIALIST_NOT_VERIFIED`).
 */
export const recommendationsOff = (err: unknown) => err instanceof ApiError
  && (err.code === 'RECOMMENDATIONS_DISABLED' || ((err.status === 404 || err.status === 503) && !err.code)
    || (err.status === 403 && (err.code === 'LAB_PARTNER_REQUIRED' || err.code === 'PARTNER_NOT_VERIFIED' || err.code === 'SPECIALIST_NOT_VERIFIED')));
export function recommendationRefusal(err: unknown): string {
  if (err instanceof ApiError && err.code && Object.hasOwn(REC_WORDS, err.code)) return t(REC_WORDS[err.code]!);
  return assistedRefusal(err).message;
}
