import { ApiError, type ApiClient } from './client.ts';
import { appointmentInstant } from './cancellationWindow.ts';
import { isRealDate } from './partnerLabs.ts';
import {
  GSTIN_PATTERN, HHMM_PATTERN, INVOICE_PREFIX_PATTERN, OBJECT_ID_PATTERN, PAN_PATTERN, PARTNER_PHONE_PATTERN, type BranchAddress,
  type VerificationState, type Weekday,
} from './partners.ts';

/**
 * WQ4 doctor tools: everything a signed-in doctor (`userType: 'specialist'`) does in the staff workspace, under
 * `/api/v1/specialists/me/*` (`src1/modules/specialists/routes/index.ts`). Typed from the backend's own sources:
 * - weekly schedule and leave days (Q4a): `doctors/{validation,model/schedule,services/schedule}.ts`;
 * - "available now" and instant consultations (Q4b): `doctors/{model/instant,services/instant}.ts`;
 * - appointments and their status commands: `specialistPortal/{validation,services}`, `bookings/services`;
 * - clinics, invitations and the solo practice (Q6): `partners/{validation,services}/clinic.ts`;
 * - earnings, statement, payouts and the payout destination (Q5): `partners/{validation,services}/finance.ts`.
 * The server decides every rule; the mirrors here only say what to offer and why something is not offered. Every id,
 * date and cursor is checked before it can reach a path or a query.
 */

// ── Shared ──

const ME = '/specialists/me';

function checkId(id: string, what: string): string {
  if (!OBJECT_ID_PATTERN.test(id)) throw new Error(`Invalid ${what} id`);
  return id;
}

/** `YYYY-MM-DD` (what date inputs give) → the backend's `YYYYMMDD` (`ymd` in `doctors/validation`), checked real. */
export function toYmd(isoDate: string): string {
  if (!isRealDate(isoDate)) throw new Error('Invalid date');
  return isoDate.replace(/-/g, '');
}

/** `YYYYMMDD` → `YYYY-MM-DD`, or null when it is not a real date. */
export function fromYmd(ymd: string): string | null {
  if (!/^\d{8}$/.test(ymd)) return null;
  const iso = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
  return isRealDate(iso) ? iso : null;
}

/** The doctor's own profile (`GET /specialists/me/profile`, `ISpecialist`). `consultationFee` is in rupees. */
export interface DoctorProfile {
  _id: string;
  name: string;
  specialization?: string;
  consultationFee?: number;
  phone?: string;
  email?: string;
  isActive?: boolean;
  isVerified?: boolean;
}

/**
 * Where the doctor stands with Jansetu (`activeDoctor` in `services/instant.ts`: instant consultations, invitations and a
 * practice all need an active, verified account).
 */
export function doctorStanding(p: Pick<DoctorProfile, 'isActive' | 'isVerified'>): 'active' | 'unverified' | 'inactive' {
  if (p.isActive === false) return 'inactive';
  return p.isVerified === false ? 'unverified' : 'active';
}

// ── Weekly schedule and leave (Q4a) ──

export type ConsultMode = 'video' | 'call' | 'chat' | 'in-person';
export const CONSULT_MODES: readonly ConsultMode[] = ['video', 'call', 'chat', 'in-person'];
export const CONSULT_MODE_LABEL: Record<ConsultMode, string> = { video: 'Video', call: 'Phone call', chat: 'Chat', 'in-person': 'In person' };

/** A working window: whole slots of `slotMinutes` inside it, for these modes, optionally at a clinic branch. */
export interface ScheduleWindow { start: string; end: string; modes: ConsultMode[]; branchId?: string }
export type ScheduleDays = Partial<Record<Weekday, ScheduleWindow[]>>;
/** `scheduleTemplateSchema`: the whole weekly template, replaced on every save. */
export interface ScheduleInput { slotMinutes: number; days: ScheduleDays }
/** `IDoctorScheduleTemplate` as `GET /me/schedule` answers it (null until the first save or leave day). */
export interface DoctorSchedule extends ScheduleInput {
  _id: string;
  doctorId: string;
  /** India-time dates YYYYMMDD with no new slots (bookings already made keep theirs). */
  leaveDates: string[];
  isActive: boolean;
  updatedAt?: string;
}
/** `DoctorExpansion`: what one save or leave change did to the next 30 days of slots. */
export interface ScheduleExpansion { inserted: number; updated: number; closed: number; reopened: number }
export interface ScheduleSaved { template: DoctorSchedule; expansion: ScheduleExpansion }

/** `scheduleTemplateSchema.slotMinutes`. */
export const SCHEDULE_MINUTES_MIN = 5;
export const SCHEDULE_MINUTES_MAX = 240;
/** `day = Joi.array().items(window).max(12)`. */
export const SCHEDULE_WINDOWS_MAX = 12;
/** `DOCTOR_ROLLING_DAYS`: slots exist this many days ahead (nightly, and on every change). */
export const DOCTOR_ROLLING_DAYS = 30;
export const SCHEDULE_WEEKDAYS: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** How many whole slots a template gives on one weekday (the server's expansion loop). */
export function scheduleSlotCount(t: ScheduleInput, day: Weekday): number {
  if (!Number.isInteger(t.slotMinutes) || t.slotMinutes < SCHEDULE_MINUTES_MIN) return 0;
  let n = 0;
  for (const w of t.days[day] ?? []) {
    if (!HHMM_PATTERN.test(w.start) || !HHMM_PATTERN.test(w.end)) continue;
    for (let m = toMin(w.start); m + t.slotMinutes <= toMin(w.end); m += t.slotMinutes) n += 1;
  }
  return n;
}

/**
 * Why the server would refuse this template, per field: `scheduleTemplateSchema` (minutes 5–240, at most 12 windows a
 * day, HH:mm, at least one known mode, a branch id) and `validateTemplate` (each window holds at least one slot, windows
 * of a day do not overlap, a clinic window is in-person only, and only at a clinic branch the doctor consults at:
 * `clinicBranches`, the branches of verified clinics from `GET /me/clinics`).
 */
export function scheduleProblems(t: ScheduleInput, clinicBranches: ReadonlySet<string>): Partial<Record<'slotMinutes' | Weekday, string>> {
  const out: Partial<Record<'slotMinutes' | Weekday, string>> = {};
  const minutesOk = Number.isInteger(t.slotMinutes) && t.slotMinutes >= SCHEDULE_MINUTES_MIN && t.slotMinutes <= SCHEDULE_MINUTES_MAX;
  if (!minutesOk) out.slotMinutes = `Enter whole minutes from ${SCHEDULE_MINUTES_MIN} to ${SCHEDULE_MINUTES_MAX}.`;
  for (const day of SCHEDULE_WEEKDAYS) {
    const windows = t.days[day] ?? [];
    const problem = (() => {
      if (windows.length > SCHEDULE_WINDOWS_MAX) return `At most ${SCHEDULE_WINDOWS_MAX} windows a day.`;
      for (const w of windows) {
        if (!HHMM_PATTERN.test(w.start) || !HHMM_PATTERN.test(w.end)) return 'Enter every start and end time (HH:MM).';
        if (!w.modes.length) return 'Choose at least one consultation type for every window.';
        if (new Set(w.modes).size !== w.modes.length || w.modes.some((m) => !CONSULT_MODES.includes(m))) return 'Choose each consultation type once.';
        if (w.branchId !== undefined) {
          if (w.modes.some((m) => m !== 'in-person')) return 'Clinic windows are for in-person consultations only.';
          if (!OBJECT_ID_PATTERN.test(w.branchId) || !clinicBranches.has(w.branchId)) {
            return 'One window is at a clinic branch you do not consult at (or whose clinic is not verified). Choose another place.';
          }
        }
        if (toMin(w.end) <= toMin(w.start)) return `${w.start}–${w.end}: a window must end after it starts.`;
        if (minutesOk && toMin(w.end) - toMin(w.start) < t.slotMinutes) return `${w.start}–${w.end} is shorter than one ${t.slotMinutes}-minute slot.`;
      }
      const sorted = [...windows].sort((a, b) => toMin(a.start) - toMin(b.start));
      for (let i = 1; i < sorted.length; i++) {
        if (toMin(sorted[i]!.start) < toMin(sorted[i - 1]!.end)) return `${sorted[i - 1]!.start}–${sorted[i - 1]!.end} and ${sorted[i]!.start}–${sorted[i]!.end} overlap.`;
      }
      return null;
    })();
    if (problem) out[day] = problem;
  }
  return out;
}

function scheduleBody(t: ScheduleInput): ScheduleInput {
  // Every weekday is sent (an empty list = no slots that day): the server replaces the whole template.
  return {
    slotMinutes: t.slotMinutes,
    days: Object.fromEntries(SCHEDULE_WEEKDAYS.map((d) => [d, (t.days[d] ?? []).map((w) => ({
      start: w.start, end: w.end, modes: [...w.modes], ...(w.branchId ? { branchId: checkId(w.branchId, 'branch') } : {}),
    }))])),
  };
}

// ── Instant consultations (Q4b) ──

export type InstantMode = 'video' | 'call' | 'chat';
export const INSTANT_MODES: readonly InstantMode[] = ['video', 'call', 'chat'];
/** `presenceSchema.instantFeeMinor` upper bound (₹10,00,000). */
export const INSTANT_FEE_MAX_MINOR = 100_000_000;
/** A doctor counts as online for 2 minutes after the last heartbeat (`PRESENCE_TTL_MS`). */
export const PRESENCE_TTL_MS = 2 * 60_000;
/** How often the workspace sends a heartbeat while "available now" is on and the page is visible. */
export const HEARTBEAT_MS = 60_000;
/** An offer is open for 5 minutes (`OFFER_MS`); an accepted consultation holds 30 minutes (`CONSULT_MS`). */
export const OFFER_MS = 5 * 60_000;
export const CONSULT_MINUTES = 30;
/** `extendSchema`: 1–60 minutes at a time. */
export const EXTEND_MINUTES_MAX = 60;

/** `IDoctorPresence` as `PUT /me/presence` answers it. There is no route that reads it back (see PLAN, WQ4 gaps). */
export interface Presence {
  doctorId: string;
  available: boolean;
  modes: InstantMode[];
  instantFeeMinor: number;
  specialization?: string;
  lastSeenAt?: string;
  updatedAt?: string;
}
export interface PresenceInput { available: boolean; modes: InstantMode[]; instantFeeMinor?: number }

/** `presenceSchema` + `setPresence`: at least one type when available; a whole-paise fee within bounds. */
export function presenceProblems(p: PresenceInput): { modes?: string; fee?: string } {
  const out: { modes?: string; fee?: string } = {};
  if (p.available && p.modes.length === 0) out.modes = 'Choose at least one consultation type.';
  if (new Set(p.modes).size !== p.modes.length || p.modes.some((m) => !INSTANT_MODES.includes(m))) out.modes = 'Choose each consultation type once.';
  if (p.instantFeeMinor !== undefined && (!Number.isSafeInteger(p.instantFeeMinor) || p.instantFeeMinor < 0 || p.instantFeeMinor > INSTANT_FEE_MAX_MINOR)) {
    out.fee = 'Enter a fee from ₹0 to ₹10,00,000 (up to two decimals).';
  }
  return out;
}

/** One open offer (`myOffers`): what the patient asked for and when the offer closes. */
export interface InstantOffer {
  requestId: string;
  mode: InstantMode;
  specialization: string;
  patient: { name: string; age?: number; gender?: string };
  generation: number;
  offerExpiresAt: string;
}

/** Seconds until an offer closes (0 once closed). */
export function offerSecondsLeft(o: Pick<InstantOffer, 'offerExpiresAt'>, now: Date): number {
  const t = Date.parse(o.offerExpiresAt);
  return Number.isFinite(t) ? Math.max(0, Math.ceil((t - now.getTime()) / 1000)) : 0;
}

/** `accept`'s refusals, in words a doctor can act on (the server's own message is the fallback). */
export const INSTANT_REFUSAL: Record<string, string> = {
  OFFER_EXPIRED: 'This offer has expired.',
  OFFER_NO_LONGER_AVAILABLE: 'Another doctor accepted it first, or the patient withdrew or was refunded.',
  INSTANT_REQUEST_NOT_FOUND: 'This offer is no longer open to you.',
  DOCTOR_NOT_AVAILABLE: 'You are not available now for this consultation type: switch “Available now” on with this type, then accept.',
  SPECIALIZATION_MISMATCH: 'This request is for another speciality than the one on your profile.',
  COUPON_NOT_FOR_DOCTOR: 'The patient used a coupon for other doctors, so you cannot take this request.',
  FEE_ABOVE_QUOTE: 'Your instant fee is above what this patient paid. Lower your fee to take requests like this one.',
  DOCTOR_BUSY: 'You already have a consultation at this time.',
  SPECIALIST_NOT_ACTIVE: 'Your doctor account is not active or not verified, so you cannot take instant consultations. Contact Jansetu.',
  BOOKING_NOT_FOUND: 'This consultation is not one of yours, or it is no longer running.',
  RESERVATION_NOT_ACTIVE: 'This consultation is no longer held (it was completed or cancelled).',
  INVALID_MINUTES: `Extend by 1 to ${EXTEND_MINUTES_MAX} minutes.`,
  MODES_REQUIRED: 'Choose at least one consultation type.',
  INVALID_FEE: 'Enter a valid fee.',
};

/**
 * The words for a definite refusal (the server answered and changed nothing), or null when the outcome is not known
 * (lost answer, timeout, server error) — then the caller must look before trying again.
 */
export function instantRefusal(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.status < 400 || err.status >= 500 || err.status === 408 || err.status === 429) return null;
  return (err.code && INSTANT_REFUSAL[err.code]) || err.message;
}

/** `DoctorReservation` moved by an extension (`moveInterval`). */
export interface Reservation { doctorId: string; kind: 'instant' | 'scheduled'; refId: string; startTime: string; endTime: string; isActive: boolean }

// ── Appointments (specialist portal) ──

export type AppointmentStatus = 'pending' | 'confirmed' | 'completed' | 'cancelled' | 'no_show';
export const APPOINTMENT_STATUS_LABEL: Record<AppointmentStatus, string> = {
  pending: 'Waiting', confirmed: 'Confirmed', completed: 'Completed', cancelled: 'Cancelled', no_show: 'No-show',
};

/** A consultation booking as the specialist portal returns it (`IBooking`, the fields the workspace shows). */
export interface DoctorAppointment {
  _id: string;
  bookingType: 'consultation';
  bookingKind?: 'scheduled' | 'instant';
  instantRequestId?: string;
  /** YYYYMMDD, India time. */
  bookingDate: string;
  /** "HH:mm" or "h:mm AM". */
  bookingTime: string;
  consultationMode?: ConsultMode;
  serviceMode?: string;
  primaryConcern?: string;
  dependentId?: string;
  status: AppointmentStatus;
  paymentStatus: 'pending' | 'paid' | 'failed' | 'refunded';
  /** Rupees. */
  price?: number;
  settlementSystem?: 'legacy' | 'ledger' | 'clinic';
  clinicVisit?: { partnerId: string; branchId: string };
  clinicDesk?: { partnerId: string; branchId: string };
  /** The call link (`syncBookingMeet`), made AFTER a booking commits: it may be missing for a while, or have failed. */
  virtualMeeting?: { status?: 'active' | 'cancelled' | 'failed'; joinUrl?: string; error?: string };
  cancellationReason?: string;
  createdAt?: string;
}

export type AppointmentAction = 'confirm' | 'complete' | 'cancel' | 'no_show';

/**
 * The status commands the server would accept now (`updateAppointmentStatus`): confirm a paid waiting booking; complete
 * a confirmed one (ledger bookings only once paid: `BOOKING_NOT_PAID`); cancel a waiting or confirmed one (full refund,
 * `cancelByDoctor` / `cancelAccepted` for instant ones, which must be confirmed); no-show only for a paid, confirmed
 * booking whose time has come (`markNoShow`). Terminal states offer nothing.
 */
export function appointmentActions(b: DoctorAppointment, now: Date): AppointmentAction[] {
  const paid = b.paymentStatus === 'paid';
  if (b.status === 'pending') return b.bookingKind === 'instant' ? [] : paid ? ['confirm', 'cancel'] : ['cancel'];
  if (b.status !== 'confirmed') return [];
  const out: AppointmentAction[] = [];
  if (paid || b.settlementSystem !== 'ledger') out.push('complete');
  out.push('cancel');
  const at = appointmentInstant(b.bookingDate, b.bookingTime);
  if (paid && at && at.at.getTime() <= now.getTime()) out.push('no_show');
  return out;
}

/**
 * The call link of an appointment (`isInternalMeetApplicable` + `syncBookingMeet`): only paid, confirmed call and video
 * consultations get one; it is made after the booking commits (for an instant one, after the accept), so it can be
 * 'preparing' for a while; 'failed' carries the server's reason. 'none' = no link is expected.
 */
export function meetingLinkState(b: Pick<DoctorAppointment, 'consultationMode' | 'status' | 'paymentStatus' | 'virtualMeeting'>): 'none' | 'ready' | 'preparing' | 'failed' {
  if ((b.consultationMode !== 'call' && b.consultationMode !== 'video') || b.status !== 'confirmed' || b.paymentStatus !== 'paid') return 'none';
  if (b.virtualMeeting?.joinUrl && b.virtualMeeting.status !== 'cancelled') return 'ready';
  return b.virtualMeeting?.status === 'failed' ? 'failed' : 'preparing';
}

/** When an appointment starts, or null when its time cannot be read. */
export const appointmentStart = (b: Pick<DoctorAppointment, 'bookingDate' | 'bookingTime'>): Date | null =>
  appointmentInstant(b.bookingDate, b.bookingTime)?.at ?? null;

// ── Clinics and the solo practice (Q6) ──

export interface ClinicBranchRef { branchId: string; name: string; address?: Partial<BranchAddress> }
/** `myClinics`: active memberships (with the branches the doctor consults at) and pending invitations. */
export interface MyClinics {
  clinics: { partnerId: string; name?: string; solo: boolean; verified: boolean; role: 'owner' | 'staff'; branches: ClinicBranchRef[] }[];
  invites: { inviteId: string; partnerId: string; clinic?: string; branches: ClinicBranchRef[]; createdAt?: string }[];
}

/** Branches an in-person window may name: those of verified clinics the doctor consults at (`clinicBranchContext`). */
export function schedulableBranches(c: MyClinics): { branchId: string; label: string }[] {
  return c.clinics.filter((m) => m.verified).flatMap((m) => m.branches.map((b) => ({ branchId: b.branchId, label: `${m.name ?? 'Clinic'} · ${b.name}` })));
}

/** `soloPracticeSchema`. */
export interface SoloPracticeInput {
  name: string;
  legalName?: string;
  invoiceSeriesPrefix: string;
  gstin?: string;
  pan?: string;
  branch: { name: string; phone: string; address: BranchAddress };
}
export interface SoloPractice {
  partner: { _id: string; name: string; legalName?: string; solo?: boolean; verification?: { state: VerificationState }; invoiceSeries?: { prefix?: string } };
  branches: { _id: string; name: string; phone?: string; address?: Partial<BranchAddress>; isActive?: boolean }[];
}
export interface SoloPracticeCreated { partner: SoloPractice['partner']; branch?: SoloPractice['branches'][number]; created: boolean }

type PracticeField = 'name' | 'legalName' | 'invoiceSeriesPrefix' | 'gstin' | 'pan' | 'branchName' | 'branchPhone' | 'line1' | 'city' | 'state' | 'stateCode' | 'pincode';
/** `soloPracticeSchema` (and `addressSchema`), per field. */
export function soloPracticeProblems(p: SoloPracticeInput): Partial<Record<PracticeField, string>> {
  const out: Partial<Record<PracticeField, string>> = {};
  const len = (s: string | undefined) => (s ?? '').trim().length;
  if (len(p.name) < 2 || len(p.name) > 120) out.name = 'Enter 2 to 120 characters.';
  if (len(p.legalName) > 160) out.legalName = 'At most 160 characters.';
  if (!INVOICE_PREFIX_PATTERN.test(p.invoiceSeriesPrefix.trim().toUpperCase())) out.invoiceSeriesPrefix = '1 to 6 letters or digits, e.g. DRK.';
  if (p.gstin && !GSTIN_PATTERN.test(p.gstin.trim().toUpperCase())) out.gstin = 'A GSTIN looks like 29ABCDE1234F1Z5.';
  if (p.pan && !PAN_PATTERN.test(p.pan.trim().toUpperCase())) out.pan = 'A PAN looks like ABCDE1234F.';
  if (len(p.branch.name) < 2 || len(p.branch.name) > 120) out.branchName = 'Enter 2 to 120 characters.';
  if (!PARTNER_PHONE_PATTERN.test(p.branch.phone.trim())) out.branchPhone = 'Enter the 10-digit number.';
  for (const k of ['line1', 'city', 'state', 'stateCode', 'pincode'] as const) if (!len(p.branch.address[k])) out[k] = 'Required.';
  return out;
}

function practiceBody(p: SoloPracticeInput): SoloPracticeInput {
  const opt = (s: string | undefined) => (s && s.trim() ? s.trim() : undefined);
  const a = p.branch.address;
  return {
    name: p.name.trim(),
    ...(opt(p.legalName) ? { legalName: opt(p.legalName) } : {}),
    invoiceSeriesPrefix: p.invoiceSeriesPrefix.trim().toUpperCase(),
    ...(opt(p.gstin) ? { gstin: opt(p.gstin)!.toUpperCase() } : {}),
    ...(opt(p.pan) ? { pan: opt(p.pan)!.toUpperCase() } : {}),
    branch: {
      name: p.branch.name.trim(), phone: p.branch.phone.trim(),
      address: { line1: a.line1.trim(), ...(opt(a.line2) ? { line2: opt(a.line2) } : {}), city: a.city.trim(), state: a.state.trim(), stateCode: a.stateCode.trim(), pincode: a.pincode.trim() },
    },
  };
}

// ── Earnings (Q5) ──

/** The payout destination as the doctor sees it (`detailsView(…, false)`): the account number masked. */
export interface PayoutDetailsView {
  method: 'bank' | 'upi';
  accountName?: string;
  ifsc?: string;
  bankName?: string;
  accountNumberLast4?: string;
  accountNumberMasked?: string;
  upiId?: string;
}
export type PayoutDetailsState = 'none' | 'unverified' | 'verified';
/** `accountView` for the account owner. */
export interface SettlementAccountView {
  _id: string;
  ownerKind: 'doctor' | 'partner';
  ownerId: string;
  beneficiaryName: string;
  isActive?: boolean;
  payoutDetails: PayoutDetailsView | null;
  payoutDetailsState: PayoutDetailsState;
  payoutDetailsVersion: number;
  payoutDetailsChangedAt?: string;
  payoutDetailsVerifiedAt?: string;
}
export interface Payout {
  _id: string;
  amountMinor: number;
  method: 'bank_transfer' | 'upi' | 'other';
  reference: string;
  /** India date YYYY-MM-DD. */
  paidOn: string;
  note?: string;
  destination: { method: 'bank' | 'upi'; label: string; detailsVersion: number };
  state: 'recorded' | 'voided';
  voidReason?: string;
  voidedAt?: string;
  createdAt?: string;
}
/** `financeSummary` (all amounts integer paise; balances may be negative after reversals). */
export interface FinanceSummary {
  account: SettlementAccountView | null;
  balanceMinor: number;
  totals: { earnedMinor: number; reversedMinor: number; paidOutMinor: number; adjustedMinor: number };
  lastPayout: Payout | null;
}
export type LedgerKind = 'earning' | 'reversal' | 'payout' | 'adjustment';
export const LEDGER_KIND_LABEL: Record<LedgerKind, string> = { earning: 'Earning', reversal: 'Reversal', payout: 'Payout', adjustment: 'Adjustment' };
export interface StatementLine {
  _id: string; at: string; kind: LedgerKind; source: string; sourceId: string; description: string;
  reference?: string; note?: string; amountMinor: number; balanceAfterMinor: number;
}
export interface StatementPage { lines: StatementLine[]; nextCursor: string | null }
export interface StatementQuery { before?: string; limit?: number; from?: string; to?: string }
/** Legacy payouts history (§7a step 4): context only, never part of the balance. */
export interface HistoryRef { _id: string; source: 'legacy_import'; legacyKind: 'billing' | 'disbursal'; legacyId: string; periodLabel?: string; amountMinor: number; at: string }
export interface FinanceEvent { _id: string; action: string; byKind: 'admin' | 'member' | 'doctor'; by: string; detail?: Record<string, unknown>; at: string }

/** `statementQuerySchema`: limit 1–200 (default 50 on the server). */
export const STATEMENT_LIMIT_MAX = 200;
const CURSOR_PATTERN = /^\d{1,15}_[0-9a-fA-F]{24}$/;

/** Problems with a period (`range`: real dates, India time; the workspace also asks for from ≤ to). */
export function periodProblem(from?: string, to?: string): string | null {
  if (from && !isRealDate(from)) return 'Enter a real “from” date.';
  if (to && !isRealDate(to)) return 'Enter a real “to” date.';
  if (from && to && from > to) return 'The “from” date must not be after the “to” date.';
  return null;
}

/** The file name the server gives the CSV (`csvName('doctor', …)`); the blob read cannot see the header. */
export const statementCsvName = (from?: string, to?: string) => `doctor-statement${from ? `-${from}` : ''}${to ? `-to-${to}` : ''}.csv`;

export interface PayoutDetailsInput { method: 'bank' | 'upi'; accountName?: string; accountNumber?: string; ifsc?: string; bankName?: string; upiId?: string }
type PayoutField = 'accountName' | 'accountNumber' | 'ifsc' | 'bankName' | 'upiId';

/** `payoutDetailsSchema` + `normalizeDetails`, per field. */
export function payoutDetailsProblems(i: PayoutDetailsInput): Partial<Record<PayoutField, string>> {
  const out: Partial<Record<PayoutField, string>> = {};
  const name = (i.accountName ?? '').trim();
  if (name.length > 120) out.accountName = 'At most 120 characters.';
  if (i.method === 'bank') {
    if (!name) out.accountName = 'Enter the account holder’s name.';
    if (!/^\d{9,18}$/.test((i.accountNumber ?? '').replace(/\s+/g, ''))) out.accountNumber = 'Enter 9 to 18 digits.';
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test((i.ifsc ?? '').trim().toUpperCase())) out.ifsc = 'An IFSC looks like ABCD0123456.';
    if ((i.bankName ?? '').trim().length > 120) out.bankName = 'At most 120 characters.';
  } else {
    const upi = (i.upiId ?? '').trim().toLowerCase();
    if (upi.length > 320 || !/^[a-z0-9._-]{2,256}@[a-z][a-z0-9]{1,63}$/.test(upi)) out.upiId = 'A UPI ID looks like name@bank.';
  }
  return out;
}

function payoutBody(i: PayoutDetailsInput): PayoutDetailsInput {
  if (i.method === 'bank') {
    return {
      method: 'bank', accountName: (i.accountName ?? '').trim(), accountNumber: (i.accountNumber ?? '').replace(/\s+/g, ''),
      ifsc: (i.ifsc ?? '').trim().toUpperCase(), ...((i.bankName ?? '').trim() ? { bankName: i.bankName!.trim() } : {}),
    };
  }
  return { method: 'upi', upiId: (i.upiId ?? '').trim().toLowerCase(), ...((i.accountName ?? '').trim() ? { accountName: i.accountName!.trim() } : {}) };
}

function statementQuery(q: StatementQuery) {
  if (q.before !== undefined && !CURSOR_PATTERN.test(q.before)) throw new Error('Invalid statement cursor');
  if (q.limit !== undefined && (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > STATEMENT_LIMIT_MAX)) throw new Error('Invalid limit');
  if (periodProblem(q.from, q.to)) throw new Error('Invalid period');
  return { before: q.before, limit: q.limit, from: q.from, to: q.to };
}

// ── The API ──

/** Every call a signed-in doctor makes. The backend checks the session is a specialist's (`requireSpecialist`). */
export function doctorToolsApi(c: ApiClient) {
  return {
    profile: () => c.get<DoctorProfile>(`${ME}/profile`),

    // Schedule (Q4a)
    schedule: () => c.get<DoctorSchedule | null>(`${ME}/schedule`),
    /** Replaces the weekly template; the next 30 days are brought in line at once (the answer says how). */
    saveSchedule: (t: ScheduleInput) => c.put<ScheduleSaved>(`${ME}/schedule`, { body: scheduleBody(t) }),
    /** A leave day (`YYYY-MM-DD`): no new bookings that day; booked slots keep their bookings. Repeating it changes nothing. */
    addLeave: (date: string) => c.post<ScheduleSaved>(`${ME}/leave`, { body: { date: toYmd(date) } }),
    removeLeave: (date: string) => c.delete<ScheduleSaved>(`${ME}/leave/${toYmd(date)}`),

    // Instant consultations (Q4b)
    setPresence: (p: PresenceInput) => {
      if (Object.keys(presenceProblems(p)).length) throw new Error('Invalid presence');
      return c.put<Presence>(`${ME}/presence`, { body: { available: p.available, modes: [...p.modes],
        ...(p.instantFeeMinor !== undefined ? { instantFeeMinor: p.instantFeeMinor } : {}) } });
    },
    /** Keeps "available now" alive (online = available, a heartbeat within 2 minutes, not in a consultation now). */
    heartbeat: () => c.post<{ online: boolean }>(`${ME}/presence/heartbeat`),
    offers: () => c.get<InstantOffer[]>(`${ME}/instant/offers`),
    /** First accept wins; no request key (a repeat after success is refused as taken: look in the appointments). */
    accept: (requestId: string) =>
      c.post<{ request: Record<string, unknown>; booking: DoctorAppointment }>(`${ME}/instant/${checkId(requestId, 'request')}/accept`),
    /** Adds time to a running instant consultation. Not keyed: each successful call adds again. */
    extend: (bookingId: string, minutes: number) => {
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > EXTEND_MINUTES_MAX) throw new Error('Invalid minutes');
      return c.post<Reservation>(`${ME}/instant/bookings/${checkId(bookingId, 'booking')}/extend`, { body: { minutes } });
    },

    // Appointments
    /** Every consultation on one India-time day (`view=day`). */
    appointmentsOn: (date: string) => c.get<DoctorAppointment[]>(`${ME}/appointments`, { query: { view: 'day', date: toYmd(date) } }),
    /** Every consultation in one month (`view=month`, `YYYY-MM`). */
    appointmentsIn: (yearMonth: string) => {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(yearMonth)) throw new Error('Invalid month');
      return c.get<DoctorAppointment[]>(`${ME}/appointments`, { query: { view: 'month', yearMonth: yearMonth.replace('-', '') } });
    },
    setAppointmentStatus: (id: string, status: 'confirmed' | 'completed' | 'cancelled' | 'no_show', reason?: string) =>
      c.patch<DoctorAppointment>(`${ME}/appointments/${checkId(id, 'appointment')}/status`, {
        body: { status, ...(reason && reason.trim() ? { reason: reason.trim().slice(0, 500) } : {}) },
      }),

    // Clinics (Q6)
    clinics: () => c.get<MyClinics>(`${ME}/clinics`),
    acceptInvite: (inviteId: string) => c.post<{ accepted: true; partnerId: string; memberId: string }>(`${ME}/clinic-invites/${checkId(inviteId, 'invitation')}/accept`),
    declineInvite: (inviteId: string) => c.post<{ accepted: false; partnerId: string }>(`${ME}/clinic-invites/${checkId(inviteId, 'invitation')}/decline`),
    leaveClinic: (partnerId: string) => c.post<{ left: true }>(`${ME}/clinics/${checkId(partnerId, 'clinic')}/leave`),
    practice: () => c.get<SoloPractice | null>(`${ME}/practice`),
    /** One practice per doctor: a repeat (any content) answers the existing one with `created: false`. */
    createPractice: (p: SoloPracticeInput) => {
      if (Object.keys(soloPracticeProblems(p)).length) throw new Error('Invalid practice');
      return c.post<SoloPracticeCreated>(`${ME}/practice`, { body: practiceBody(p) });
    },

    // Earnings (Q5)
    finance: () => c.get<FinanceSummary>(`${ME}/finance`),
    /** Newest first, with the balance after each line; `nextCursor` pages further back. */
    statement: (q: StatementQuery = {}) => c.get<StatementPage>(`${ME}/finance/statement`, { query: { ...statementQuery(q) } }),
    /** The period's statement as CSV (oldest first, opening and closing balance), read into a blob. */
    statementCsv: (q: { from?: string; to?: string } = {}, signal?: AbortSignal) => {
      if (periodProblem(q.from, q.to)) throw new Error('Invalid period');
      return c.blob(`${ME}/finance/statement.csv`, { query: { from: q.from, to: q.to }, signal });
    },
    payouts: () => c.get<Payout[]>(`${ME}/finance/payouts`),
    history: () => c.get<HistoryRef[]>(`${ME}/finance/history`),
    events: () => c.get<FinanceEvent[]>(`${ME}/finance/events`),
    /** Any change (even to the same values) needs Jansetu's verification again before the next payout. */
    setPayoutDetails: (i: PayoutDetailsInput) => {
      if (Object.keys(payoutDetailsProblems(i)).length) throw new Error('Invalid payout details');
      return c.put<SettlementAccountView>(`${ME}/finance/payout-details`, { body: payoutBody(i) });
    },
  };
}

export type DoctorToolsApi = ReturnType<typeof doctorToolsApi>;
