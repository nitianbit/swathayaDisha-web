import { formatPaise, formatYmd } from '@jansetu/i18n';
import { ApiError, type ApiClient, type Page } from './client.ts';
import { appointmentInstant } from './cancellationWindow.ts';
import { fetchableFileUrl } from './pharmacyOrders.ts';
import { istToday } from './finance.ts';
import { t as core } from './i18n/index.ts';
import { t, type AssistedKey } from './i18n/assisted/index.ts';
import { labelledList, onLanguage, wordMap } from './i18n/words.ts';

/**
 * WQ12: a pharmacy books a doctor consultation for a walk-in patient and pays from its Jansetu wallet (assisted booking
 * phase 0 + 1a, backend `src1/modules/assisted`, `pharmacyWallet`, `payment`; design ASSISTED_BOOKING_DESIGN.md §17–§19).
 * Money from these routes is in paise unless a field says rupees. Phone numbers only ever travel in POST bodies.
 */

// ── Backend rules mirrored (assisted/validation, common/utils/phone) ──

/** `canonicalMobile`: spaces and dashes dropped, +91 / 91 / 0 prefixes removed, then exactly ten digits. */
export function canonicalPhone(raw: string): string | null {
  let p = String(raw ?? '').replace(/[\s-]/g, '');
  if (p.startsWith('+91')) p = p.slice(3);
  else if (p.startsWith('91') && p.length === 12) p = p.slice(2);
  else if (p.startsWith('0') && p.length === 11) p = p.slice(1);
  return /^[0-9]{10}$/.test(p) ? p : null;
}

/** `requestKey` of the create (`[A-Za-z0-9_-]{8,100}`) and of an order from a prescription (`{8,64}`). */
export const ASSISTED_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
/** `personName`: 1–120 characters after trimming. */
export const MAX_PERSON_NAME = 120;
export const MAX_CONCERN = 500;
export const MAX_BOOKER_CANCEL_REASON = 500;
/** `relation` of a family member (the create's third patient form). */
export const ASSISTED_RELATIONS = ['Father', 'Mother', 'Spouse', 'Wife', 'Husband', 'Son', 'Daughter', 'Brother', 'Sister', 'Friend',
  'Grandfather', 'Grandmother', 'Other'] as const;
export type AssistedRelation = (typeof ASSISTED_RELATIONS)[number];
export const ASSISTED_GENDERS = ['Male', 'Female', 'Other'] as const;
export type AssistedGender = (typeof ASSISTED_GENDERS)[number];

export type AssistedMode = 'video' | 'call' | 'in-person';
export const ASSISTED_MODE_LABEL: Readonly<Record<AssistedMode, string>> = wordMap(t, { video: 'mode.video', call: 'mode.call', 'in-person': 'mode.in-person' });
export type JoinOn = 'partner_device' | 'patient_phone';

/** `preferredLanguage` is a 2–3 letter code; these are the languages the patient may ask the doctor to speak. */
export const PATIENT_LANGUAGES: readonly { code: string; label: string }[] = labelledList(t, [
  ['hi', 'language.hi'], ['en', 'language.en'], ['bn', 'language.bn'], ['mr', 'language.mr'],
  ['te', 'language.te'], ['ta', 'language.ta'], ['gu', 'language.gu'], ['kn', 'language.kn'],
  ['ml', 'language.ml'], ['or', 'language.or'], ['pa', 'language.pa'],
  // The owner's list (design §11.1): codes of 2–3 letters, as `preferredLanguage` requires. Nagamese has no code yet.
  ['as', 'language.as'], ['lus', 'language.lus'], ['mni', 'language.mni'], ['kha', 'language.kha'],
  ['grt', 'language.grt'], ['ne', 'language.ne'], ['brx', 'language.brx'], ['trp', 'language.trp'],
]);

/**
 * The consent the pharmacy attests (`consent: { agreed, statementVersion, statementLanguage }`). The version names the
 * exact sentence shown next to the tick, so a later change of words is a new version.
 */
export const CONSENT_STATEMENT_VERSION = 'web-pharmacy-v2';
export const CONSENT_STATEMENT_LANGUAGE = 'en';
export const CONSENT_STATEMENT =
  // i18n-ignore: the versioned consent text is recorded as English (round 6f, Q2)
  'The patient (or a family member with them) agreed that this pharmacy books this consultation for them on Jansetu; that an account is made for this number if it has none; that their name, phone number and the problem they describe are shared with Jansetu and the doctor; and that this pharmacy can see the prescription (medicines, advice and tests, not the diagnosis) for 90 days.';

// ── Shapes (assisted/pharmacyCommands, consultations, bookerView; pharmacyWallet/services) ──

export interface PatientLookup { exists: boolean; holderNameMasked: string | null }

export interface AssistedSlot { slotId: string; date: string; startTime: string; endTime: string; startsAt: string; modes: AssistedMode[] }
export interface AssistedDoctor {
  doctorId: string;
  name: string;
  specialization?: string;
  languages: string[];
  city: string | null;
  experienceYears: number | null;
  feeMinor: number;
  nearby: 'pincode' | 'city' | null;
  nextSlot: AssistedSlot | null;
  /** Only when `date` was asked: that day's free times. */
  slots?: AssistedSlot[];
}
export interface DoctorQuery { speciality?: string; mode?: AssistedMode; language?: string; date?: string; limit?: number }
/** `GET /pharmacy-assisted/doctors/:doctorId/slots` (stage build, `listDoctorSlots`): `from` YYYY-MM-DD, `days` 1–14. */
export interface DoctorSlotsQuery { from?: string; days?: number; mode?: AssistedMode }
export interface DoctorSlots {
  doctor: Omit<AssistedDoctor, 'nearby' | 'nextSlot' | 'slots'>;
  /** YYYYMMDD, inclusive. */
  from: string;
  to: string;
  /** Earliest first: bookable now, not full, in the mode, not on the doctor's leave day. */
  slots: AssistedSlot[];
}

export type AssistedPatient =
  | { relation: 'self'; name: string }
  | { dependentId: string }
  | { relation: AssistedRelation; name: string; gender?: AssistedGender; dateOfBirth?: string };

export interface ConsultationRequest {
  requestKey: string;
  phone: string;
  patient: AssistedPatient;
  holderName?: string;
  consent: { agreed: true; statementVersion: string; statementLanguage: string };
  preferredLanguage: string;
  slotId: string;
  consultationMode: AssistedMode;
  join?: { on: JoinOn; phone?: string };
  couponCode?: string;
  acceptedPriceMinor: number;
  primaryConcern?: string;
  /** WQ16 (r10 phase 1b, §23.3): `razorpay` = paid by card or UPI on a Razorpay order; the same body otherwise. */
  paymentMethod: AssistedPaymentMethod;
}

export type AssistedPaymentMethod = 'wallet' | 'razorpay';
export interface BookingPayment {
  method: AssistedPaymentMethod; state: 'pending' | 'captured' | 'refunded' | 'not_paid' | 'forfeited' | string; payBy: string | null; paymentTransactionId?: string | null;
  /** r10d: the open order while a card booking waits (null when none is open yet). */
  razorpayOrderId?: string | null; razorpayKeyId?: string | null;
}

/**
 * WQ16 (r10 `cardPayments.ts` `CardPaymentView`): the one open Razorpay order of a card booking. `amountMinor` is what
 * Checkout takes; `payBy` (ISO) is when the booking expires and its time is released if no payment arrived.
 */
export interface AssistedCardPayment {
  paymentRequired: true; paymentTransactionId: string; razorpayOrderId: string; razorpayKeyId: string;
  amount: number; amountMinor: number; currency: string; payBy: string;
}
/**
 * WQ17c: an open order as a screen may know it: the create's (with its amount), or the booker view's `payment` (r10d/r14:
 * the order without an amount when the view carries no price, as a lab booking's: Checkout then takes the order's own).
 */
export type OpenCardOrder = Omit<AssistedCardPayment, 'amount' | 'amountMinor'> & { amount?: number; amountMinor?: number };

export interface ConsultationReceipt {
  booking: {
    _id: string; status: string; paymentStatus?: string; bookingDate: string; bookingTime: string; slotId?: string; specialistId?: string;
    doctorName?: string; consultationMode: AssistedMode; dependentId?: string | null; price?: number; originalPrice?: number; updatedAt?: string;
    createdAt?: string; assisted?: { shortRef?: string; preferredLanguage?: string; join?: { on: JoinOn }; bookedBy?: { name?: string } };
  };
  funding: { method: string; amountMinor: number; state: string; walletEntryId: string | null; paymentTransactionId?: string | null };
  split: { listMinor: number; discountMinor: number; couponCode: string | null };
  /** WQ16: card bookings only: the open order while it waits for payment, else null (paid, cancelled or expired). */
  payment?: AssistedCardPayment | null;
  newAccount: boolean;
  replayed: boolean;
}

export interface RxMedicine { name: string; dosage?: string; frequency?: string; duration?: string; instructions?: string }
/** The dispensing copy in the booker view: never the diagnosis. Absent before the doctor saves one and after 90 days. */
export interface DispensingCopy {
  advice?: string;
  medicines?: RxMedicine[];
  testsAdvised?: string[];
  prescribedAt?: string;
  prescribedBySpecialistName?: string;
  /** WQ21 (r16 phase 3d, §25.12): the recommended-tests code on the prescription (stored without the hyphen), when made. */
  recommendationCode?: string;
  fileUrls: string[];
  /** The PDF is still being made: read again shortly. */
  copyPending?: boolean;
}

export type BookingStatus = 'pending' | 'confirmed' | 'completed' | 'cancelled' | 'no_show';
/** The booker view (`assisted/bookerView.ts`): raw field names, hidden fields never present. */
export interface BookedConsultation {
  _id: string;
  status: BookingStatus | string;
  paymentStatus?: string;
  source?: string;
  bookingDate?: string;
  bookingTime?: string;
  doctorName?: string;
  specialistId?: string;
  /** The account the booking is on (the phone's holder); `PUT /pharmacy-customers/:id/typed-name` takes it as `id`. */
  userId?: string;
  /** The slot the booking holds now (a reschedule moves it). */
  slotId?: string;
  /**
   * r6 (`m0/r6-small-fixes` 694bfaa9, design §21.2; not on q16 338733f8): the account holder (the phone's owner) as this
   * pharmacy sees it, and THIS pharmacy's own link to them (null: no link, so no typed-name edit). r8 B6 (dd8971b0):
   * `typedName`, the name THIS pharmacy typed on its own link as stored (null: none); absent on an older backend.
   */
  holder?: { pharmacyCustomerId: string | null; name: string | null; typedName?: string | null };
  patientName?: string | null;
  dependentId?: string | null;
  contactNo?: string;
  consultationMode?: AssistedMode | string;
  primaryConcern?: string;
  price?: number;
  originalPrice?: number;
  cancellationReason?: string;
  cancellationCause?: string;
  cancelledAt?: string;
  createdAt?: string;
  updatedAt?: string;
  noShow?: { at: string };
  assisted?: { shortRef?: string; bookedBy?: { name?: string }; join?: { on: JoinOn }; preferredLanguage?: string; disputed?: { state: string } };
  /** Only for `join.on = partner_device`, from 10 minutes before the start to the end. */
  virtualMeeting?: { joinUrl: string };
  /**
   * WQ16b (r10c `bookerView.ts`, §23.3): how the booking is paid, for its own pharmacy only (absent on an older server).
   * `payBy` only while a card booking waits for its payment; `paymentTransactionId` (card) is the record to check.
   */
  payment?: BookingPayment;
  prescription?: DispensingCopy;
}

/** `POST /pharmacy-assisted/bookings/:id/reschedule` (P9): the booker view after the move; `replayed` = this key moved it before. */
export interface RescheduleAnswer { booking: BookedConsultation; replayed: boolean }
export interface RescheduleRequest { slotId: string; requestKey: string; expectedUpdatedAt?: string }
/** `PUT /pharmacy-customers/:id/typed-name` (§17.4): the pharmacy's link to the account, with the name it typed. */
export interface TypedNameAnswer {
  _id: string; userId: string; typedName: string;
  /** r6: what this pharmacy's screens now show for the holder (the account name on a `customer_order` link, else the typed name). */
  shownName?: string | null;
}

/** WQ16: `payment` only for a card booking: its open order (read only), null when none is open. */
export type ByKeyAnswer = { state: 'used'; booking: BookedConsultation; payment?: AssistedCardPayment | null } | { state: 'abandoned' } | { state: 'unknown' };
/**
 * WQ16 (r10 `cardRefunds.ts` `cardRefundView`): the refund of a card-paid booking: to the card, or to the pharmacy
 * wallet. `state` is the server's (only `processed` means done).
 */
export interface CardRefund {
  refundId: string; bookingId: string; paymentRecordId: string; amountMinor: number; cause: string;
  method: 'card' | 'wallet'; state: 'pending' | 'processed' | 'failed' | 'manual_review' | string;
  lastError: string | null; attempts: number; razorpayRefundId: string | null; processedAt: string | null; createdAt: string; updatedAt: string;
  resolution?: { by: string; at: string };
}
/** `refund` is present for card bookings only (null: cancelled before it was paid). */
export interface CancelAnswer { booking: BookedConsultation; refundedMinor: number; alreadyCancelled: boolean; refund?: CardRefund | null }
export type RefundTo = 'card' | 'wallet';

export interface RxOrderItem { medicineId: string; medicineName?: string; orderedQty: number }
export interface RxOrderRequest {
  prescriptionFromBookingId: string;
  requestKey: string;
  orderType: 'in_store';
  items: RxOrderItem[];
  paymentMode: 'in_store_payment';
  deliveryMode: 'pickup';
  isWalkIn: true;
  notes?: string;
}
export interface RxOrderAnswer { order: { _id: string; orderNumber?: string; status?: string }; paymentRequired?: boolean; replayed?: boolean }

export interface PharmacyWallet {
  _id?: string;
  balance?: number;
  balancePaise?: number;
  isActive?: boolean;
  withdrawableMinor?: number;
  receivableMinor?: number;
  frozen?: boolean;
  frozenReason?: string;
}
export interface WalletMovement {
  _id: string;
  transactionType: string;
  /** The stored kind (`booking_debit`, `refund_credit`, …); `transactionType` is answered as credit/debit by sign. */
  movementType?: string;
  amount?: number;
  amountPaise?: number;
  signedAmountPaise?: number;
  balanceAfter?: number;
  balanceAfterPaise?: number;
  description?: string;
  /** An admin credit's note (`notes` on the top-up). */
  notes?: string;
  referenceType?: string;
  /** For an admin credit (`referenceType: 'topup'`): the Idempotency-Key it was made with. */
  referenceId?: string;
  /** r6: who posted it (`{ kind: 'admin', id }` on an admin credit). */
  actor?: { kind: string; id: string };
  status?: string;
  createdAt?: string;
}
export interface TopupOrder { paymentRequired: boolean; paymentTransactionId: string; razorpayOrderId: string; razorpayKeyId: string; amount: number; currency: string }
export interface TopupCheck { state: 'credited' | 'unpaid'; wallet: PharmacyWallet | null }

/** Record ids and request keys checked before any request (shared by the assisted modules). */
export const hex = /^[0-9a-fA-F]{24}$/;
// i18n-ignore: a programming error, not shown
export const idOf = (v: string, what: string) => { if (!hex.test(v)) throw new Error(`Invalid ${what} id`); return v; };
// i18n-ignore: a programming error, not shown
export const keyOf = (v: string) => { if (!ASSISTED_KEY_PATTERN.test(v)) throw new Error('Invalid request key'); return v; };

/** `/pharmacy-assisted/*` (phase 1a) and `/pharmacy-bookings` (phase 0): pharmacy token, operational pharmacies only. */
export function pharmacyAssistedApi(c: ApiClient) {
  return {
    /** POST: the phone stays in the body. Answers the masked holder name only. */
    lookup: (phone: string) => c.post<PatientLookup>('/pharmacy-assisted/patients/lookup', { body: { phone } }),
    doctors: (q: DoctorQuery = {}) => c.get<AssistedDoctor[]>('/pharmacy-assisted/doctors', { query: { ...q } }),
    /** One doctor's bookable times over `days` days (default 7) from `from` (default today). 404 DOCTOR_NOT_FOUND when not bookable. */
    doctorSlots: (doctorId: string, q: DoctorSlotsQuery = {}) =>
      c.get<DoctorSlots>(`/pharmacy-assisted/doctors/${idOf(doctorId, 'doctor')}/slots`, { query: { ...q } }),
    book: (body: ConsultationRequest) => c.post<ConsultationReceipt>('/pharmacy-assisted/consultations', { body, timeoutMs: SLOW_WRITE_TIMEOUT_MS }),
    byKey: (key: string) => c.get<ByKeyAnswer>(`/pharmacy-assisted/bookings/by-key/${keyOf(key)}`),
    abandon: (key: string) => c.post<ByKeyAnswer>(`/pharmacy-assisted/bookings/by-key/${keyOf(key)}/abandon`),
    /** WQ16: `refundTo` (card-paid bookings; ignored by the server for wallet-paid ones), default `card`. */
    cancel: (id: string, body: { reason?: string; expectedUpdatedAt?: string; refundTo?: RefundTo }) =>
      c.post<CancelAnswer>(`/pharmacy-assisted/bookings/${idOf(id, 'booking')}/cancel`, { body }),
    /**
     * WQ13 (P9, `rescheduleByBooker`): the same doctor and price, before the start, once per request key. The same key and
     * slot again answer `replayed: true` (checked before the version fence, so a resend is safe); the same key with
     * another slot is 409 IDEMPOTENCY_KEY_REUSED.
     */
    reschedule: (id: string, body: RescheduleRequest) =>
      c.post<RescheduleAnswer>(`/pharmacy-assisted/bookings/${idOf(id, 'booking')}/reschedule`, {
        body: { slotId: idOf(body.slotId, 'slot'), requestKey: keyOf(body.requestKey), ...(body.expectedUpdatedAt ? { expectedUpdatedAt: body.expectedUpdatedAt } : {}) },
        timeoutMs: SLOW_WRITE_TIMEOUT_MS,
      }),
    /** Newest first, cursor-paged (`pagination.nextCursor`), 1–50 a page. */
    bookings: (q: { status?: BookingStatus; cursor?: string; limit?: number } = {}) =>
      c.page<BookedConsultation>('/pharmacy-bookings', { query: { ...q } }),
    booking: (id: string) => c.get<BookedConsultation>(`/pharmacy-bookings/${idOf(id, 'booking')}`),
    /** The dispensing copy PDF, fetched with the pharmacy token. */
    file: (storedUrl: string, signal?: AbortSignal) => c.blob('/file/fetch', { query: { url: fetchableFileUrl(storedUrl) }, signal }),
    /** Phase 0 (§18.3): a medicine order from the booking's prescription, exactly once per request key. */
    orderFromPrescription: (body: RxOrderRequest) => c.post<RxOrderAnswer>('/pharmacy-orders', { body, timeoutMs: SLOW_WRITE_TIMEOUT_MS }),
  };
}

/**
 * WQ13: `/pharmacy-customers` (§17.4). `setTypedName` changes only the name THIS pharmacy typed for the account holder
 * (its own link row, audited); the patient's account is never changed. `id` is the link id or the holder's user id.
 * Another pharmacy's link, or none, is 404 CUSTOMER_NOT_LINKED. A PUT of the same name is idempotent.
 */
export function pharmacyCustomersApi(c: ApiClient) {
  return {
    setTypedName: (id: string, typedName: string) =>
      c.put<TypedNameAnswer>(`/pharmacy-customers/${idOf(id, 'customer')}/typed-name`, { body: { typedName: cleanName(typedName) } }),
  };
}

/** `/pharmacy-wallet` and the payment proof routes for the pharmacy's own Razorpay top-ups. */
export function pharmacyWalletApi(c: ApiClient) {
  return {
    wallet: () => c.get<PharmacyWallet>('/pharmacy-wallet'),
    movements: (page = 1, limit = 20) => c.page<WalletMovement>('/pharmacy-wallet/transactions', { query: { page, limit } }),
    /** `amount` in rupees (at least 1). Opens a Razorpay order; no money moves until the pharmacy pays it. */
    startTopup: (amountRupees: number) => c.post<TopupOrder>('/pharmacy-wallet/topup', { body: { amount: amountRupees } }),
    /** Reconciles one of this pharmacy's top-ups with Razorpay and credits it once if it was paid. */
    checkTopup: (paymentTransactionId: string) =>
      c.post<TopupCheck>(`/pharmacy-wallet/topups/${idOf(paymentTransactionId, 'payment')}/check`),
    /** The browser's proof of payment. S6: no `module` is sent (optional; what is paid for comes from the stored record). */
    verify: (p: { paymentTransactionId: string; razorpayOrderId: string; razorpayPaymentId: string; razorpaySignature: string }) =>
      c.post<{ context: string; paymentRecord: { status: string; isProcessed?: boolean } }>('/payments/verify', {
        body: { paymentTransactionId: idOf(p.paymentTransactionId, 'payment'), razorpayOrderId: p.razorpayOrderId,
          razorpayPaymentId: p.razorpayPaymentId, razorpaySignature: p.razorpaySignature },
      }),
  };
}

export type { Page };

// ── Words and rules for the screens ──

export const BOOKING_STATUS_LABEL: Readonly<Record<string, string>> = wordMap(t, {
  pending: 'status.pending', confirmed: 'status.confirmed', completed: 'status.completed', cancelled: 'status.cancelled', no_show: 'status.no_show',
});
export const bookingStatusLabel = (s: string | undefined) => (s ? BOOKING_STATUS_LABEL[s] ?? s : '—');

/** YYYYMMDD → "22 Nov 2026" (the slot's own India date). */
export function formatSlotDate(yyyymmdd: string | undefined): string {
  if (!yyyymmdd || !/^\d{8}$/.test(yyyymmdd)) return yyyymmdd ?? '—';
  return formatYmd(yyyymmdd);
}


/** The wallet balance in paise (`balancePaise` is authoritative; older wallets only have rupees). */
export function walletBalancePaise(w: PharmacyWallet | null | undefined): number {
  if (!w) return 0;
  if (typeof w.balancePaise === 'number' && Number.isFinite(w.balancePaise)) return w.balancePaise;
  return Math.round(Number(w.balance ?? 0) * 100);
}

/** 'owing' (a lost card dispute: the wallet owes Jansetu), 'frozen' (on hold), 'off' (switched off), or 'ok'. */
export function walletState(w: PharmacyWallet | null | undefined): 'ok' | 'frozen' | 'owing' | 'off' {
  if (!w) return 'ok';
  if (Number(w.receivableMinor ?? 0) > 0) return 'owing';
  if (w.frozen === true) return 'frozen';
  if (w.isActive === false) return 'off';
  return 'ok';
}

/** A movement's signed amount in paise: `signedAmountPaise` when present, else by its (answered) type. */
export function signedPaiseOf(m: WalletMovement): number {
  if (typeof m.signedAmountPaise === 'number' && Number.isFinite(m.signedAmountPaise)) return m.signedAmountPaise;
  const abs = typeof m.amountPaise === 'number' && Number.isFinite(m.amountPaise) ? Math.abs(m.amountPaise) : Math.round(Math.abs(Number(m.amount ?? 0)) * 100);
  return m.transactionType === 'credit' || m.transactionType === 'refund' ? abs : -abs;
}

const MOVEMENT_LABEL: Readonly<Record<string, string>> = wordMap(t, {
  booking_debit: 'movement.booking_debit',
  refund_credit: 'movement.refund_credit',
  chargeback: 'movement.chargeback',
  receivable_setoff: 'movement.receivable_setoff',
  opening_balance: 'movement.opening_balance',
  adjustment: 'movement.adjustment',
  withdrawal_hold: 'movement.withdrawal_hold',
  withdrawal_release: 'movement.withdrawal_release',
  withdrawal_void: 'movement.withdrawal_void',
  consultation_payment: 'movement.consultation_payment',
  refund: 'movement.refund',
  debit: 'movement.debit',
});

/** Plain words for one wallet movement (the stored kind first; a credit is a top-up when it came from Razorpay). */
export function movementLabel(m: WalletMovement): string {
  const kind = m.movementType ?? m.transactionType;
  if (kind === 'credit') return t(m.referenceType === 'wallet_recharge' ? 'movement.topup' : 'movement.adminCredit');
  return MOVEMENT_LABEL[kind] ?? t(signedPaiseOf(m) >= 0 ? 'movement.credit' : 'movement.debit');
}

/** Whether the booking pharmacy may cancel it now: an assisted booking that is booked and has not started (§8.7). */
/** An assisted booking (phase 1a): the booker view marks it with `source: 'pharmacy_assisted'` and its `assisted` block. */
export const isAssistedBooking = (b: BookedConsultation) => b.source === 'pharmacy_assisted' || !!b.assisted?.shortRef;

/** The modes the create accepts (`consultationMode`); a slot may also list others (e.g. chat), which are left out. */
export function supportedModes(modes: readonly string[] | undefined, only?: AssistedMode | ''): AssistedMode[] {
  // Own keys only: `m in …` would also accept inherited names such as "toString" or "constructor".
  return (modes ?? []).filter((m): m is AssistedMode => Object.hasOwn(ASSISTED_MODE_LABEL, m) && (!only || m === only));
}

/**
 * The doctor card's "Next free time", only when the slot list would show that time: a next slot offered only in modes
 * the booking cannot use (e.g. chat), or not in the chosen mode, is not shown (the list hides it too).
 */
export function nextFreeSlot(d: Pick<AssistedDoctor, 'nextSlot'>, only?: AssistedMode | ''): AssistedSlot | null {
  return d.nextSlot && supportedModes(d.nextSlot.modes, only).length ? d.nextSlot : null;
}

export function canBookerCancel(b: BookedConsultation, now = new Date()): boolean {
  if (!isAssistedBooking(b)) return false;
  if (b.status !== 'confirmed' && b.status !== 'pending') return false;
  const at = appointmentInstant(String(b.bookingDate ?? ''), String(b.bookingTime ?? ''));
  return !!at && at.at.getTime() > now.getTime();
}

/**
 * Whether the booking pharmacy may move it now (P9, `rescheduleWithHolds`): the same rule as its cancel (an assisted
 * booking, waiting or booked, before the start), and the doctor is known (the new time must be one of theirs).
 */
export function canBookerReschedule(b: BookedConsultation, now = new Date()): boolean {
  return canBookerCancel(b, now) && hex.test(String(b.specialistId ?? ''));
}

/** The rule the reschedule enforces, in plain words (shown next to "Change time"), with `{mode}` left in. */
export let RESCHEDULE_RULE = '';
onLanguage(() => { RESCHEDULE_RULE = t('reschedule.rule', { mode: '{mode}' }); });
export const rescheduleRuleText = (mode: string | undefined) =>
  t('reschedule.rule', { mode: t(mode === 'in-person' ? 'reschedule.mode.in-person' : mode === 'call' ? 'reschedule.mode.call' : 'reschedule.mode.video') });

/** The times a booking may move to: the doctor's free times in the booking's own mode, without the time it holds now. */
export function rescheduleSlots(slots: readonly AssistedSlot[], b: Pick<BookedConsultation, 'slotId' | 'consultationMode' | 'bookingDate' | 'bookingTime'>): AssistedSlot[] {
  const mode = supportedModes([String(b.consultationMode ?? '')])[0];
  if (!mode) return [];
  return slots.filter((s) => supportedModes(s.modes, mode).length
    && String(s.slotId).toLowerCase() !== String(b.slotId ?? '').toLowerCase()
    && !(s.date === b.bookingDate && s.startTime === b.bookingTime));
}

/** The holder's name as this pharmacy typed it (`typedNameSchema`: 1–200 characters after trimming). */
export const MAX_TYPED_NAME = 200;
export function typedNameProblem(text: string): string | null {
  const name = cleanName(text);
  if (!name) return t('patient.nameEmpty');
  if (name.length > MAX_TYPED_NAME) return t('field.tooLong', { max: MAX_TYPED_NAME });
  return null;
}
/** What the typed-name edit changes on this booking: the holder's link `id`, the name shown for the holder now, and whether the patient is a family member. */
export interface TypedNameTarget {
  id: string; name: string | null; family: boolean;
  /** The id the unconfirmed edit is remembered under on this device: the link id (r6) or the booking id, never the patient's account id. */
  markerId: string;
}
/**
 * The edit renames the ACCOUNT HOLDER (the phone's owner) for this pharmacy, never a family member (their name is on the
 * patient's own account). r6: `holder.pharmacyCustomerId` (null = no link: no edit), also on a family member's booking.
 * Before r6 (q16): the booking's `userId`, only on the holder's own booking, where `patientName` is the holder's name.
 */
export function typedNameTarget(b: Pick<BookedConsultation, '_id' | 'userId' | 'dependentId' | 'patientName' | 'holder'>): TypedNameTarget | null {
  if (b.holder) {
    const id = String(b.holder.pharmacyCustomerId ?? '');
    return hex.test(id) ? { id: id.toLowerCase(), name: b.holder.name ?? null, family: !!b.dependentId, markerId: id.toLowerCase() } : null;
  }
  if (b.dependentId) return null;
  const id = String(b.userId ?? '');
  return hex.test(id) ? { id: id.toLowerCase(), name: b.patientName ?? null, family: false, markerId: String(b._id).toLowerCase() } : null;
}

/** How the patient joins, in plain words, for the confirmation and the list. */
export function joinWords(mode: string | undefined, on: JoinOn | undefined): string {
  if (mode === 'in-person') return t('join.inPerson');
  if (mode === 'call') return t(on === 'partner_device' ? 'join.callHere' : 'join.callPatient');
  return t(on === 'partner_device' ? 'join.videoHere' : 'join.videoPatient');
}

// ── Refusals in plain words ──

/** WQ16: `card` = card or UPI cannot pay for this booking (switch off, nothing to pay, no gateway keys): pay from the wallet. */
export type RefusalKind = 'off' | 'topup' | 'wallet' | 'price' | 'slot' | 'doctor' | 'limit' | 'patient' | 'coupon' | 'card' | 'other';
export interface Refusal { kind: RefusalKind; message: string; priceMinor?: number }

/** Paise as money ("₹1,234.50"); kept as `rupees` for the screens that import it by that name. */
export const rupees = formatPaise;
const waitWords = (seconds: number | undefined) =>
  !seconds ? t('wait.later') : seconds < 90 ? t('wait.minute') : seconds < 3600 ? t('wait.minutes', { n: Math.ceil(seconds / 60) }) : t('wait.hours', { n: Math.ceil(seconds / 3600) });

/**
 * The switch is off: 503 `ASSISTED_BOOKING_DISABLED`, or the route does not exist on this server yet (a 404 with no
 * code: the backend's catch-all "Route not found"). A 404 WITH a code (`BOOKING_NOT_FOUND` …) is a real answer.
 */
export function isSwitchedOff(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  if (err.code === 'ASSISTED_BOOKING_DISABLED') return true;
  return (err.status === 404 || err.status === 503) && !err.code;
}
export let SWITCHED_OFF_MESSAGE = '';
onLanguage(() => { SWITCHED_OFF_MESSAGE = t('switchedOff'); });

/** `ASSISTED_LIMIT_REACHED`'s `limit` → its words (`{wait}`: when to try again). */
const LIMIT_WORDS: Readonly<Record<string, AssistedKey>> = {
  lookups: 'limit.lookups',
  new_accounts: 'limit.new_accounts',
  bookings_per_phone: 'limit.bookings_per_phone',
  booker_cancellations: 'limit.booker_cancellations',
  // WQ16b (r10b): card bookings of one pharmacy waiting for payment at once (ASSISTED_LIMIT_PENDING_CARD_BOOKINGS).
  pending_card_bookings: 'limit.pending_card_bookings',
};

/** A refusal's kind and the key of its words (read when it is answered). */
export type RefusalWords = Readonly<Record<string, { kind: RefusalKind; key: AssistedKey }>>;
export const refusalOf = (w: { kind: RefusalKind; key: AssistedKey }): Refusal => ({ kind: w.kind, message: t(w.key) });

const CODE_WORDS: RefusalWords = {
  INSUFFICIENT_BALANCE: { kind: 'topup', key: 'refusal.INSUFFICIENT_BALANCE' },
  WALLET_FROZEN: { kind: 'wallet', key: 'refusal.WALLET_FROZEN' },
  WALLET_RECEIVABLE: { kind: 'wallet', key: 'refusal.WALLET_RECEIVABLE' },
  WALLET_INACTIVE: { kind: 'wallet', key: 'refusal.WALLET_INACTIVE' },
  SLOT_NOT_AVAILABLE: { kind: 'slot', key: 'refusal.SLOT_NOT_AVAILABLE' },
  SLOT_STARTED: { kind: 'slot', key: 'refusal.SLOT_STARTED' },
  DOCTOR_NOT_AVAILABLE: { kind: 'doctor', key: 'refusal.DOCTOR_NOT_AVAILABLE' },
  DOCTOR_NOT_FOUND: { kind: 'doctor', key: 'refusal.DOCTOR_NOT_AVAILABLE' },
  SPECIALIST_NOT_VERIFIED: { kind: 'doctor', key: 'refusal.SPECIALIST_NOT_VERIFIED' },
  CONSENT_REQUIRED: { kind: 'patient', key: 'refusal.CONSENT_REQUIRED' },
  INVALID_PHONE: { kind: 'patient', key: 'patient.phoneInvalid' },
  DEPENDENT_NOT_FOUND: { kind: 'patient', key: 'refusal.DEPENDENT_NOT_FOUND' },
  INVALID_COUPON: { kind: 'coupon', key: 'refusal.INVALID_COUPON' },
  COUPON_NOT_FOR_ASSISTED: { kind: 'coupon', key: 'refusal.COUPON_NOT_FOR_ASSISTED' },
  COUPON_EXHAUSTED: { kind: 'coupon', key: 'refusal.COUPON_EXHAUSTED' },
  // WQ16 (r10 §23.3): the card switch is off; a free consultation (nothing to pay) is booked with the wallet method.
  PAYMENT_METHOD_UNAVAILABLE: { kind: 'card', key: 'refusal.PAYMENT_METHOD_UNAVAILABLE' },
  NOTHING_TO_PAY: { kind: 'card', key: 'refusal.NOTHING_TO_PAY' },
  IDEMPOTENCY_KEY_REUSED: { kind: 'other', key: 'refusal.IDEMPOTENCY_KEY_REUSED' },
  REQUEST_ABANDONED: { kind: 'other', key: 'refusal.REQUEST_ABANDONED' },
  CUSTOMER_LINKING_UNAVAILABLE: { kind: 'other', key: 'refusal.CUSTOMER_LINKING_UNAVAILABLE' },
  INDEXES_OUTDATED: { kind: 'other', key: 'refusal.INDEXES_OUTDATED' },
  PHARMACY_INACTIVE: { kind: 'other', key: 'refusal.PHARMACY_INACTIVE' },
  PHARMACY_NOT_VERIFIED: { kind: 'other', key: 'refusal.PHARMACY_NOT_VERIFIED' },
  PHARMACY_PROFILE_REQUIRED: { kind: 'other', key: 'refusal.PHARMACY_PROFILE_REQUIRED' },
  BOOKING_ALREADY_STARTED: { kind: 'other', key: 'refusal.BOOKING_ALREADY_STARTED' },
  BOOKING_NOT_CANCELLABLE: { kind: 'other', key: 'refusal.BOOKING_NOT_CANCELLABLE' },
  NO_SHOW_NOT_REFUNDABLE: { kind: 'other', key: 'refusal.NO_SHOW_NOT_REFUNDABLE' },
  BOOKING_CHANGED: { kind: 'other', key: 'refusal.BOOKING_CHANGED' },
  BOOKING_NOT_FOUND: { kind: 'other', key: 'refusal.BOOKING_NOT_FOUND' },
  // Medicine order from the prescription (phase 0, §18.3).
  PRESCRIPTION_NOT_READY: { kind: 'other', key: 'refusal.PRESCRIPTION_NOT_READY' },
  PRESCRIPTION_ACCESS_EXPIRED: { kind: 'other', key: 'refusal.PRESCRIPTION_ACCESS_EXPIRED' },
  CUSTOMER_CONSENT_REQUIRED: { kind: 'other', key: 'refusal.CUSTOMER_CONSENT_REQUIRED' },
  CUSTOMER_NOT_LINKED: { kind: 'other', key: 'refusal.CUSTOMER_NOT_LINKED' },
  DISPENSING_COPY_UNAVAILABLE: { kind: 'other', key: 'refusal.DISPENSING_COPY_UNAVAILABLE' },
  // Wallet top-ups (payment/services, pharmacyWallet/services).
  TOPUP_BLOCKED: { kind: 'wallet', key: 'refusal.TOPUP_BLOCKED' },
  PAYMENT_FAILED: { kind: 'other', key: 'refusal.PAYMENT_FAILED' },
  PAYMENT_REFUNDED: { kind: 'other', key: 'refusal.PAYMENT_REFUNDED' },
  PAYMENT_RECORD_NOT_FOUND: { kind: 'other', key: 'refusal.PAYMENT_RECORD_NOT_FOUND' },
  PAYMENT_SERVICE_UNAVAILABLE: { kind: 'other', key: 'refusal.PAYMENT_SERVICE_UNAVAILABLE' },
  RAZORPAY_NOT_CONFIGURED: { kind: 'card', key: 'refusal.RAZORPAY_NOT_CONFIGURED' },
};

/** One plain sentence for a refusal of the booking, cancel, order or wallet routes, and what the screen should offer. */
export function assistedRefusal(err: unknown): Refusal {
  if (isSwitchedOff(err)) return { kind: 'off', message: SWITCHED_OFF_MESSAGE };
  if (!(err instanceof ApiError)) return { kind: 'other', message: core('errors.unknown') };
  if (err.code === 'PRICE_CHANGED') {
    const p = Number(err.details?.priceMinor);
    return Number.isSafeInteger(p) && p >= 0
      ? { kind: 'price', priceMinor: p, message: t('refusal.priceChangedTo', { price: rupees(p) }) }
      : { kind: 'price', message: t('refusal.priceChanged') };
  }
  if (err.code === 'ASSISTED_LIMIT_REACHED') {
    const words = err.limit && Object.hasOwn(LIMIT_WORDS, err.limit) ? LIMIT_WORDS[err.limit] : undefined;
    return { kind: 'limit', message: t(words ?? 'limit.tooMany', { wait: waitWords(err.retryAfter) }) };
  }
  if (err.status === 429) return { kind: 'limit', message: t('limit.tooMany', { wait: waitWords(err.retryAfter) }) };
  const known = err.code && Object.hasOwn(CODE_WORDS, err.code) ? CODE_WORDS[err.code] : undefined;
  if (known) return refusalOf(known);
  if (err.status === 403) return { kind: 'other', message: err.message || t('refusal.forbidden') };
  return { kind: 'other', message: err.message || core('errors.unknown') };
}

export type RescheduleRefusalKind = 'slot' | 'doctor' | 'changed' | 'late' | 'other';
const RESCHEDULE_WORDS: Readonly<Record<string, { kind: RescheduleRefusalKind; key: AssistedKey }>> = {
  SLOT_NOT_AVAILABLE: { kind: 'slot', key: 'reschedule.SLOT_NOT_AVAILABLE' },
  SAME_SLOT: { kind: 'slot', key: 'reschedule.SAME_SLOT' },
  SLOT_STARTED: { kind: 'slot', key: 'refusal.SLOT_STARTED' },
  SLOT_NOT_THIS_DOCTOR: { kind: 'slot', key: 'reschedule.SLOT_NOT_THIS_DOCTOR' },
  DOCTOR_BUSY: { kind: 'slot', key: 'reschedule.DOCTOR_BUSY' },
  DOCTOR_NOT_AVAILABLE: { kind: 'doctor', key: 'reschedule.DOCTOR_NOT_AVAILABLE' },
  DOCTOR_NOT_FOUND: { kind: 'doctor', key: 'reschedule.DOCTOR_NOT_AVAILABLE' },
  BOOKING_CHANGED: { kind: 'changed', key: 'reschedule.BOOKING_CHANGED' },
  BOOKING_ALREADY_STARTED: { kind: 'late', key: 'reschedule.BOOKING_ALREADY_STARTED' },
  BOOKING_NOT_RESCHEDULABLE: { kind: 'late', key: 'reschedule.BOOKING_NOT_RESCHEDULABLE' },
  BOOKING_NOT_FOUND: { kind: 'late', key: 'refusal.BOOKING_NOT_FOUND' },
  INSTANT_CONSULT_COMMAND_REQUIRED: { kind: 'late', key: 'reschedule.INSTANT_CONSULT_COMMAND_REQUIRED' },
  CLINIC_APPOINTMENT: { kind: 'late', key: 'reschedule.CLINIC_APPOINTMENT' },
  IDEMPOTENCY_KEY_REUSED: { kind: 'changed', key: 'reschedule.IDEMPOTENCY_KEY_REUSED' },
};

/** One plain sentence for a refusal of the reschedule (or of the slot read behind it), and what the screen should do. */
export function rescheduleRefusal(err: unknown): { kind: RescheduleRefusalKind; message: string } {
  if (isSwitchedOff(err)) return { kind: 'other', message: SWITCHED_OFF_MESSAGE };
  const known = err instanceof ApiError && err.code && Object.hasOwn(RESCHEDULE_WORDS, err.code) ? RESCHEDULE_WORDS[err.code] : undefined;
  return known ? { kind: known.kind, message: t(known.key) } : { kind: 'other', message: assistedRefusal(err).message };
}

/** One plain sentence for a refusal of the typed-name edit. */
export function typedNameRefusal(err: unknown): string {
  if (err instanceof ApiError && err.code === 'CUSTOMER_NOT_LINKED') return t('typedName.notLinked');
  if (err instanceof ApiError && err.code === 'VALIDATION_ERROR') return t('typedName.length', { max: MAX_TYPED_NAME });
  return assistedRefusal(err).message;
}

/**
 * A sole first attempt refused by an assisted limit (429 `ASSISTED_LIMIT_REACHED`) recorded nothing: the server counts
 * the limit before any write, and a limit inside the booking transaction aborts it (§19.2 item 9). The shared rule
 * (`definitelyNotRecorded`) leaves every 429 unknown, so the booking screen settles this one case itself.
 */
export const isAssistedLimit = (err: unknown) => err instanceof ApiError && err.status === 429 && err.code === 'ASSISTED_LIMIT_REACHED';

/**
 * Refusals the create answers before any booking write (r4 `createPharmacyConsultation`): the switch
 * (`assertPharmacyAssistedOn`, first line), the indexes (`assertAssistedIndexes`, before the replay read), customer
 * linking (`customerPhoneIndexReady`, before the transaction), and the limits. For a sole first attempt each one means
 * "not booked". A 503 without one of these codes (a proxy, a timeout) stays unknown.
 */
// WQ16: r10 `assertCardGatewayReady` (no Razorpay keys) runs before the transaction too (card bookings only).
const REFUSED_BEFORE_WRITING_503 = ['ASSISTED_BOOKING_DISABLED', 'INDEXES_OUTDATED', 'CUSTOMER_LINKING_UNAVAILABLE', 'RAZORPAY_NOT_CONFIGURED'];
export const refusedBeforeWriting = (err: unknown) =>
  isAssistedLimit(err) || (err instanceof ApiError && err.status === 503 && REFUSED_BEFORE_WRITING_503.includes(err.code ?? ''));

/** The create and the order from a prescription do more work than a read: a longer client time limit. */
export const SLOW_WRITE_TIMEOUT_MS = 60_000;

// ── The booking form ──

export interface PatientDraft {
  phone: string;
  /** A number with no account yet is typed twice (§6.2 step 4). */
  phoneAgain: string;
  /** 'self' = the phone's own holder; 'known' = a family member booked here before; 'family' = a family member by name. */
  who: 'self' | 'known' | 'family';
  name: string;
  relation: AssistedRelation | '';
  gender: AssistedGender | '';
  dateOfBirth: string;
  dependentId: string;
  /** The holder's name, typed once for the link when booking for a family member (optional). */
  holderName: string;
}

export const EMPTY_PATIENT: PatientDraft = {
  phone: '', phoneAgain: '', who: 'self', name: '', relation: '', gender: '', dateOfBirth: '', dependentId: '', holderName: '',
};

const cleanName = (s: string) => s.trim().replace(/\s+/g, ' ');
const isRealDay = (v: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

/** Field problems of the patient step (`exists` = the lookup's answer for this phone). */
export function patientProblems(d: PatientDraft, exists: boolean, today = istToday()): Partial<Record<keyof PatientDraft, string>> {
  const e: Partial<Record<keyof PatientDraft, string>> = {};
  const phone = canonicalPhone(d.phone);
  if (!phone) e.phone = t('patient.phoneInvalid');
  else if (!exists && canonicalPhone(d.phoneAgain) !== phone) e.phoneAgain = t('patient.phoneAgain');
  if (d.who === 'known') {
    if (!hex.test(d.dependentId)) e.dependentId = t('patient.chooseFamily');
    return e;
  }
  const name = cleanName(d.name);
  if (!name) e.name = t(d.who === 'self' ? 'patient.nameEmpty' : 'patient.familyNameEmpty');
  else if (name.length > MAX_PERSON_NAME) e.name = t('field.tooLong', { max: MAX_PERSON_NAME });
  if (d.who === 'family') {
    if (!d.relation) e.relation = t('patient.relation');
    if (d.dateOfBirth && (!isRealDay(d.dateOfBirth) || d.dateOfBirth > today)) e.dateOfBirth = t('patient.dateOfBirth');
    if (cleanName(d.holderName).length > MAX_PERSON_NAME) e.holderName = t('field.tooLong', { max: MAX_PERSON_NAME });
  }
  return e;
}

/** The create's `patient` and `holderName` from a checked draft (§17.4: the booker always types the name). */
export function patientBody(d: PatientDraft): { patient: AssistedPatient; holderName?: string } {
  if (d.who === 'known') {
    const holderName = cleanName(d.holderName);
    return { patient: { dependentId: d.dependentId.toLowerCase() }, ...(holderName ? { holderName } : {}) };
  }
  if (d.who === 'self') return { patient: { relation: 'self', name: cleanName(d.name) } };
  const holderName = cleanName(d.holderName);
  return {
    patient: { relation: d.relation as AssistedRelation, name: cleanName(d.name), ...(d.gender ? { gender: d.gender } : {}), ...(d.dateOfBirth ? { dateOfBirth: d.dateOfBirth } : {}) },
    ...(holderName ? { holderName } : {}),
  };
}

/**
 * Family members this pharmacy booked for before on this phone (its own list: `contactNo` is the booking's phone and
 * `patientName` the family member's name). The lookup never lists the family (privacy), so these are the only ones the
 * screen can offer by name; anyone else is added by name and relation (the server reuses a same-name, same-relation one).
 */
export function familyBookedBefore(rows: readonly BookedConsultation[], phone: string): { dependentId: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const r of rows) {
    if (!r.dependentId || !r.patientName || canonicalPhone(String(r.contactNo ?? '')) !== phone) continue;
    const id = String(r.dependentId).toLowerCase();
    if (!hex.test(id) || seen.has(id)) continue;
    seen.set(id, r.patientName);
  }
  return [...seen].map(([dependentId, name]) => ({ dependentId, name }));
}

/** The order lines a prescription suggests, matched to stock by the person (one line per prescribed medicine). */
export function rxOrderProblems(lines: readonly { medicineId: string; qty: string }[]): string | null {
  const chosen = lines.filter((l) => l.medicineId);
  if (!chosen.length) return t('rxOrder.none');
  if (chosen.some((l) => !/^[1-9]\d{0,4}$/.test(l.qty))) return t('rxOrder.qty');
  return null;
}
