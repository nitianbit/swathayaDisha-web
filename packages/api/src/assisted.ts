import { ApiError, type ApiClient, type Page } from './client.ts';
import { appointmentInstant } from './cancellationWindow.ts';
import { fetchableFileUrl } from './pharmacyOrders.ts';
import { istToday } from './finance.ts';

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
export const ASSISTED_MODE_LABEL: Readonly<Record<AssistedMode, string>> = { video: 'Video call', call: 'Phone call', 'in-person': 'At the clinic' };
export type JoinOn = 'partner_device' | 'patient_phone';

/** `preferredLanguage` is a 2–3 letter code; these are the languages the patient may ask the doctor to speak. */
export const PATIENT_LANGUAGES: readonly { code: string; label: string }[] = [
  { code: 'hi', label: 'Hindi' }, { code: 'en', label: 'English' }, { code: 'bn', label: 'Bengali' }, { code: 'mr', label: 'Marathi' },
  { code: 'te', label: 'Telugu' }, { code: 'ta', label: 'Tamil' }, { code: 'gu', label: 'Gujarati' }, { code: 'kn', label: 'Kannada' },
  { code: 'ml', label: 'Malayalam' }, { code: 'or', label: 'Odia' }, { code: 'pa', label: 'Punjabi' },
  // The owner's list (design §11.1): codes of 2–3 letters, as `preferredLanguage` requires. Nagamese has no code yet.
  { code: 'as', label: 'Assamese' }, { code: 'lus', label: 'Mizo' }, { code: 'mni', label: 'Manipuri' }, { code: 'kha', label: 'Khasi' },
  { code: 'grt', label: 'Garo' }, { code: 'ne', label: 'Nepali' }, { code: 'brx', label: 'Bodo' }, { code: 'trp', label: 'Kokborok' },
];

/**
 * The consent the pharmacy attests (`consent: { agreed, statementVersion, statementLanguage }`). The version names the
 * exact sentence shown next to the tick, so a later change of words is a new version.
 */
export const CONSENT_STATEMENT_VERSION = 'web-pharmacy-v2';
export const CONSENT_STATEMENT_LANGUAGE = 'en';
export const CONSENT_STATEMENT =
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
export const idOf = (v: string, what: string) => { if (!hex.test(v)) throw new Error(`Invalid ${what} id`); return v; };
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

export const BOOKING_STATUS_LABEL: Readonly<Record<string, string>> = {
  pending: 'Waiting', confirmed: 'Booked', completed: 'Done', cancelled: 'Cancelled', no_show: 'Patient did not come',
};
export const bookingStatusLabel = (s: string | undefined) => (s ? BOOKING_STATUS_LABEL[s] ?? s : '—');

/** YYYYMMDD → "22 Nov 2026" (the slot's own India date). */
export function formatSlotDate(yyyymmdd: string | undefined): string {
  if (!yyyymmdd || !/^\d{8}$/.test(yyyymmdd)) return yyyymmdd ?? '—';
  const d = new Date(Date.UTC(Number(yyyymmdd.slice(0, 4)), Number(yyyymmdd.slice(4, 6)) - 1, Number(yyyymmdd.slice(6, 8))));
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(d);
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

const MOVEMENT_LABEL: Readonly<Record<string, string>> = {
  booking_debit: 'Paid for a consultation booking',
  refund_credit: 'Refund of a cancelled booking',
  chargeback: 'Taken back after a card dispute',
  receivable_setoff: 'Used to clear money owed to Jansetu',
  opening_balance: 'Opening balance',
  adjustment: 'Correction by Jansetu',
  withdrawal_hold: 'Withdrawal requested',
  withdrawal_release: 'Withdrawal cancelled: money back',
  withdrawal_void: 'Withdrawal bounced: money back',
  consultation_payment: 'Paid for a consultation',
  refund: 'Refund',
  debit: 'Money taken out',
};

/** Plain words for one wallet movement (the stored kind first; a credit is a top-up when it came from Razorpay). */
export function movementLabel(m: WalletMovement): string {
  const kind = m.movementType ?? m.transactionType;
  if (kind === 'credit') return m.referenceType === 'wallet_recharge' ? 'Top-up (card / UPI)' : 'Money added by Jansetu';
  return MOVEMENT_LABEL[kind] ?? (signedPaiseOf(m) >= 0 ? 'Money added' : 'Money taken out');
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

/** The rule the reschedule enforces, in plain words (shown next to "Change time"). */
export const RESCHEDULE_RULE =
  'You can move this consultation to another free time of the same doctor, any time before it starts. The price stays the same: nothing more is taken from your wallet and nothing is refunded. It stays a {mode}. The patient and the doctor are told the new time.';
export const rescheduleRuleText = (mode: string | undefined) =>
  RESCHEDULE_RULE.replace('{mode}', mode === 'in-person' ? 'visit at the clinic' : mode === 'call' ? 'phone call' : 'video call');

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
  if (!name) return 'Type the patient’s name.';
  if (name.length > MAX_TYPED_NAME) return `Use at most ${MAX_TYPED_NAME} characters.`;
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
  if (mode === 'in-person') return 'The patient goes to the doctor’s clinic at the booked time.';
  if (mode === 'call') {
    return on === 'partner_device'
      ? 'The doctor phones this pharmacy’s number at the booked time. Keep the patient with you.'
      : 'The doctor phones the patient’s number at the booked time.';
  }
  return on === 'partner_device'
    ? 'Open “Booked consultations” on this device. A “Join call” button appears 10 minutes before the time.'
    : 'The patient signs in to the Jansetu app on their phone with this number and taps Join.';
}

// ── Refusals in plain words ──

/** WQ16: `card` = card or UPI cannot pay for this booking (switch off, nothing to pay, no gateway keys): pay from the wallet. */
export type RefusalKind = 'off' | 'topup' | 'wallet' | 'price' | 'slot' | 'doctor' | 'limit' | 'patient' | 'coupon' | 'card' | 'other';
export interface Refusal { kind: RefusalKind; message: string; priceMinor?: number }

const rupees = (paise: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(paise / 100);
const waitWords = (seconds: number | undefined) =>
  !seconds ? 'later' : seconds < 90 ? 'in a minute' : seconds < 3600 ? `in about ${Math.ceil(seconds / 60)} minutes` : `in about ${Math.ceil(seconds / 3600)} hours`;

/**
 * The switch is off: 503 `ASSISTED_BOOKING_DISABLED`, or the route does not exist on this server yet (a 404 with no
 * code: the backend's catch-all "Route not found"). A 404 WITH a code (`BOOKING_NOT_FOUND` …) is a real answer.
 */
export function isSwitchedOff(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  if (err.code === 'ASSISTED_BOOKING_DISABLED') return true;
  return (err.status === 404 || err.status === 503) && !err.code;
}
export const SWITCHED_OFF_MESSAGE = 'Booking for patients is not switched on yet.';

const LIMIT_WORDS: Readonly<Record<string, (wait: string) => string>> = {
  lookups: (wait) => `You have looked up many patients this hour. Try again ${wait}.`,
  new_accounts: () => 'Your pharmacy has added the most new patients allowed today. Try again tomorrow, or book for a patient already on Jansetu.',
  bookings_per_phone: () => 'This phone number already has the most bookings allowed today. Try again tomorrow.',
  booker_cancellations: () => 'Your pharmacy cancelled many bookings today, so new bookings are paused until tomorrow. You can still cancel.',
  // WQ16b (r10b): card bookings of one pharmacy waiting for payment at once (ASSISTED_LIMIT_PENDING_CARD_BOOKINGS).
  pending_card_bookings: () => 'Too many bookings are waiting for payment. Pay or cancel one of them first.',
};

const CODE_WORDS: Readonly<Record<string, Refusal>> = {
  INSUFFICIENT_BALANCE: { kind: 'topup', message: 'Your Jansetu wallet does not have enough money for this booking. Top up the wallet, then pay again.' },
  WALLET_FROZEN: { kind: 'wallet', message: 'Your Jansetu wallet is on hold, so it cannot pay for bookings. Please contact Jansetu support.' },
  WALLET_RECEIVABLE: { kind: 'wallet', message: 'Your wallet owes money to Jansetu after a disputed card payment, so it cannot pay for bookings. Please contact Jansetu support.' },
  WALLET_INACTIVE: { kind: 'wallet', message: 'Your Jansetu wallet is switched off. Please contact Jansetu support.' },
  SLOT_NOT_AVAILABLE: { kind: 'slot', message: 'This time was just taken. Choose another time.' },
  SLOT_STARTED: { kind: 'slot', message: 'This time has already started. Choose a later time.' },
  DOCTOR_NOT_AVAILABLE: { kind: 'doctor', message: 'This doctor is not taking bookings now. Choose another doctor.' },
  DOCTOR_NOT_FOUND: { kind: 'doctor', message: 'This doctor is not taking bookings now. Choose another doctor.' },
  SPECIALIST_NOT_VERIFIED: { kind: 'doctor', message: 'This doctor is not verified yet. Choose another doctor.' },
  CONSENT_REQUIRED: { kind: 'patient', message: 'Tick “Patient agreed to this booking” first.' },
  INVALID_PHONE: { kind: 'patient', message: 'Enter a valid 10-digit mobile number.' },
  DEPENDENT_NOT_FOUND: { kind: 'patient', message: 'This family member was not found on this phone number. Add them by name instead.' },
  INVALID_COUPON: { kind: 'coupon', message: 'This coupon code does not work for this booking. Remove it or check the code.' },
  COUPON_NOT_FOR_ASSISTED: { kind: 'coupon', message: 'This coupon cannot be used on a booking made for a patient. Remove it.' },
  COUPON_EXHAUSTED: { kind: 'coupon', message: 'This coupon has been fully used. Remove it.' },
  // WQ16 (r10 §23.3): the card switch is off; a free consultation (nothing to pay) is booked with the wallet method.
  PAYMENT_METHOD_UNAVAILABLE: { kind: 'card', message: 'Card payment is not switched on yet. Pay from your Jansetu wallet.' },
  NOTHING_TO_PAY: { kind: 'card', message: 'There is nothing to pay for this consultation, so it cannot be paid by card. Book it with the wallet: nothing is taken from it.' },
  IDEMPOTENCY_KEY_REUSED: { kind: 'other', message: 'This booking request was already used with other details. Start the booking again.' },
  REQUEST_ABANDONED: { kind: 'other', message: 'This booking was given up earlier, so it was not made. Start the booking again.' },
  CUSTOMER_LINKING_UNAVAILABLE: { kind: 'other', message: 'Booking for patients is not ready on the server yet. Try again later.' },
  INDEXES_OUTDATED: { kind: 'other', message: 'The server needs an update before this can be used. Please ask the Jansetu team.' },
  PHARMACY_INACTIVE: { kind: 'other', message: 'Your pharmacy account is not active. Please contact Jansetu support.' },
  PHARMACY_NOT_VERIFIED: { kind: 'other', message: 'Your pharmacy is not verified yet, so it cannot book for patients.' },
  PHARMACY_PROFILE_REQUIRED: { kind: 'other', message: 'Your pharmacy profile is not complete. Please contact Jansetu support.' },
  BOOKING_ALREADY_STARTED: { kind: 'other', message: 'The consultation has already started, so it can no longer be cancelled.' },
  BOOKING_NOT_CANCELLABLE: { kind: 'other', message: 'This consultation is finished, so it cannot be cancelled.' },
  NO_SHOW_NOT_REFUNDABLE: { kind: 'other', message: 'This consultation was moved after the patient did not come, so it cannot be cancelled for a refund.' },
  BOOKING_CHANGED: { kind: 'other', message: 'This booking changed since you opened it. Look at it again, then try again.' },
  BOOKING_NOT_FOUND: { kind: 'other', message: 'This booking was not found.' },
  // Medicine order from the prescription (phase 0, §18.3).
  PRESCRIPTION_NOT_READY: { kind: 'other', message: 'The doctor has not written the prescription yet.' },
  PRESCRIPTION_ACCESS_EXPIRED: { kind: 'other', message: 'This prescription is more than 90 days old, so it can no longer be used here.' },
  CUSTOMER_CONSENT_REQUIRED: { kind: 'other', message: 'The patient’s agreement is not recorded for your pharmacy, so an order cannot be made from it.' },
  CUSTOMER_NOT_LINKED: { kind: 'other', message: 'This patient is not linked to your pharmacy, so an order cannot be made from it.' },
  DISPENSING_COPY_UNAVAILABLE: { kind: 'other', message: 'The prescription copy could not be made just now. Try again in a minute.' },
  // Wallet top-ups (payment/services, pharmacyWallet/services).
  TOPUP_BLOCKED: { kind: 'wallet', message: 'This top-up was blocked after a card dispute and will not be added. Please contact Jansetu support.' },
  PAYMENT_FAILED: { kind: 'other', message: 'This payment failed. No money was added. You can start a new top-up.' },
  PAYMENT_REFUNDED: { kind: 'other', message: 'This payment was refunded to your card or UPI. No money was added.' },
  PAYMENT_RECORD_NOT_FOUND: { kind: 'other', message: 'This top-up was not found.' },
  PAYMENT_SERVICE_UNAVAILABLE: { kind: 'other', message: 'Card and UPI payments are not available right now. Try again later.' },
  RAZORPAY_NOT_CONFIGURED: { kind: 'card', message: 'Card and UPI payments are not set up on this server yet.' },
};

/** One plain sentence for a refusal of the booking, cancel, order or wallet routes, and what the screen should offer. */
export function assistedRefusal(err: unknown): Refusal {
  if (isSwitchedOff(err)) return { kind: 'off', message: SWITCHED_OFF_MESSAGE };
  if (!(err instanceof ApiError)) return { kind: 'other', message: 'Something went wrong. Please try again.' };
  if (err.code === 'PRICE_CHANGED') {
    const p = Number(err.details?.priceMinor);
    return Number.isSafeInteger(p) && p >= 0
      ? { kind: 'price', priceMinor: p, message: `The price has changed. It is now ${rupees(p)}. Check it with the patient, then pay again.` }
      : { kind: 'price', message: 'The price has changed. Choose the doctor again to see the new price.' };
  }
  if (err.code === 'ASSISTED_LIMIT_REACHED') {
    const words = err.limit ? LIMIT_WORDS[err.limit] : undefined;
    return { kind: 'limit', message: words ? words(waitWords(err.retryAfter)) : `Too many requests. Try again ${waitWords(err.retryAfter)}.` };
  }
  if (err.status === 429) return { kind: 'limit', message: `Too many requests. Try again ${waitWords(err.retryAfter)}.` };
  const known = err.code ? CODE_WORDS[err.code] : undefined;
  if (known) return known;
  if (err.status === 403) return { kind: 'other', message: err.message || 'Your account is not allowed to do this.' };
  return { kind: 'other', message: err.message || 'Something went wrong. Please try again.' };
}

export type RescheduleRefusalKind = 'slot' | 'doctor' | 'changed' | 'late' | 'other';
const RESCHEDULE_WORDS: Readonly<Record<string, { kind: RescheduleRefusalKind; message: string }>> = {
  SLOT_NOT_AVAILABLE: { kind: 'slot', message: 'This time was just taken, or is no longer free. Choose another time.' },
  SAME_SLOT: { kind: 'slot', message: 'The consultation is already at this time. Choose another time.' },
  SLOT_STARTED: { kind: 'slot', message: 'This time has already started. Choose a later time.' },
  SLOT_NOT_THIS_DOCTOR: { kind: 'slot', message: 'This time belongs to another doctor. Choose one of this doctor’s times.' },
  DOCTOR_BUSY: { kind: 'slot', message: 'The doctor is not free at that time. Choose another time.' },
  DOCTOR_NOT_AVAILABLE: { kind: 'doctor', message: 'This doctor is not taking bookings now, so the time cannot be changed. You can cancel instead.' },
  DOCTOR_NOT_FOUND: { kind: 'doctor', message: 'This doctor is not taking bookings now, so the time cannot be changed. You can cancel instead.' },
  BOOKING_CHANGED: { kind: 'changed', message: 'This booking changed since you opened it (perhaps on another device). Look at it again, then choose the time again.' },
  BOOKING_ALREADY_STARTED: { kind: 'late', message: 'Too late: the consultation has already started, so its time can no longer be changed.' },
  BOOKING_NOT_RESCHEDULABLE: { kind: 'late', message: 'This consultation is cancelled or finished, so its time can no longer be changed.' },
  BOOKING_NOT_FOUND: { kind: 'late', message: 'This booking was not found.' },
  INSTANT_CONSULT_COMMAND_REQUIRED: { kind: 'late', message: 'A “Consult now” consultation has no booked time, so it cannot be moved.' },
  CLINIC_APPOINTMENT: { kind: 'late', message: 'This is a clinic appointment. Ask the clinic to change it.' },
  IDEMPOTENCY_KEY_REUSED: { kind: 'changed', message: 'This change was already sent with another time. Look at the booking again, then choose the time again.' },
};

/** One plain sentence for a refusal of the reschedule (or of the slot read behind it), and what the screen should do. */
export function rescheduleRefusal(err: unknown): { kind: RescheduleRefusalKind; message: string } {
  if (isSwitchedOff(err)) return { kind: 'other', message: SWITCHED_OFF_MESSAGE };
  const known = err instanceof ApiError && err.code ? RESCHEDULE_WORDS[err.code] : undefined;
  return known ?? { kind: 'other', message: assistedRefusal(err).message };
}

/** One plain sentence for a refusal of the typed-name edit. */
export function typedNameRefusal(err: unknown): string {
  if (err instanceof ApiError && err.code === 'CUSTOMER_NOT_LINKED') return 'This patient is not linked to your pharmacy, so the name cannot be changed here.';
  if (err instanceof ApiError && err.code === 'VALIDATION_ERROR') return `Type a name of 1 to ${MAX_TYPED_NAME} characters.`;
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
  if (!phone) e.phone = 'Enter a valid 10-digit mobile number.';
  else if (!exists && canonicalPhone(d.phoneAgain) !== phone) e.phoneAgain = 'Type the same number again. This number is new to Jansetu, so it is checked twice.';
  if (d.who === 'known') {
    if (!hex.test(d.dependentId)) e.dependentId = 'Choose the family member.';
    return e;
  }
  const name = cleanName(d.name);
  if (!name) e.name = d.who === 'self' ? 'Type the patient’s name.' : 'Type the family member’s name.';
  else if (name.length > MAX_PERSON_NAME) e.name = `Use at most ${MAX_PERSON_NAME} characters.`;
  if (d.who === 'family') {
    if (!d.relation) e.relation = 'Choose how they are related to the phone’s owner.';
    if (d.dateOfBirth && (!isRealDay(d.dateOfBirth) || d.dateOfBirth > today)) e.dateOfBirth = 'Enter a real date of birth (not in the future), or leave it empty.';
    if (cleanName(d.holderName).length > MAX_PERSON_NAME) e.holderName = `Use at most ${MAX_PERSON_NAME} characters.`;
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
  if (!chosen.length) return 'Choose at least one medicine from your stock.';
  if (chosen.some((l) => !/^[1-9]\d{0,4}$/.test(l.qty))) return 'Enter how many units of each chosen medicine (a whole number).';
  return null;
}
