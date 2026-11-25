import { ApiError, type ApiClient, type Page } from './client.ts';
import { appointmentInstant } from './cancellationWindow.ts';
import type { BookingNoShowMove } from './clinic.ts';
import { noShowMovedOnce } from './noShows.ts';
import { isRealDate } from './partnerLabs.ts';
import {
  EMAIL_PATTERN, GSTIN_PATTERN, HHMM_PATTERN, INVOICE_PREFIX_PATTERN, OBJECT_ID_PATTERN, PAN_PATTERN, PARTNER_PHONE_PATTERN, type BranchAddress,
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
 *
 * Backend reference: Q13 as approved (`m0/q13-doctor-finance` 4d877b6): presence read and ordered writes
 * (`presenceVersion` / `expectedPresenceVersion` → 409 PRESENCE_CHANGED), offers with the patient's quote, idempotent
 * accept (`replayed`), keyed extensions and the instant booking read, `expectedUpdatedAt` on the schedule,
 * `expectedDetailsVersion` on payout details, and cursor-paged payouts and events.
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
 * Where the doctor stands with Jansetu: `isEligibleDoctor` in `services/instant.ts` (Q13 final) — both stored flags must be
 * true; a legacy record missing one is not eligible for instant consultations.
 */
export function doctorStanding(p: Pick<DoctorProfile, 'isActive' | 'isVerified'>): 'active' | 'unverified' | 'inactive' {
  if (p.isActive !== true) return 'inactive';
  return p.isVerified !== true ? 'unverified' : 'active';
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
/**
 * The doctor's presence. `GET /me/presence` and the heartbeat answer the full view (`presence()` in
 * `services/instant.ts`); `PUT /me/presence` answers the stored record (terms and `presenceVersion`, no derived fields).
 * `presenceVersion` changes with every change of terms and every forced offline, never with a heartbeat.
 */
export interface Presence {
  doctorId: string;
  available: boolean;
  modes: InstantMode[];
  instantFeeMinor: number;
  presenceVersion: number;
  specialization?: string;
  lastSeenAt?: string | null;
  updatedAt?: string;
  /** Read view only. */
  eligible?: boolean;
  feeConfigured?: boolean;
  heartbeatExpiresAt?: string | null;
  heartbeatExpired?: boolean;
  busy?: boolean;
  busyUntil?: string | null;
  online?: boolean;
}
export interface PresenceInput { available: boolean; modes: InstantMode[]; instantFeeMinor?: number }
/** `presenceSchema` (Q13): the terms, and the version they were decided on (0 = never set). */
export interface PresenceWrite extends PresenceInput { expectedPresenceVersion: number }

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
  /** Q13: what the patient paid (the ceiling of the fee), this doctor's current fee, and whether it fits. */
  quotedAmountMinor?: number;
  yourFeeMinor?: number | null;
  feeWithinQuote?: boolean;
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
  // Q16a re-review (C, `feeAffordable`): with this fee the patient's coupon is worked out again and no longer covers it.
  OFFER_NO_LONGER_AFFORDABLE: 'What this patient paid no longer covers your fee once their coupon is worked out again, so you cannot take this request. It stays open for other doctors.',
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

/** `DoctorReservation` moved by an extension (`moveInterval`); Q13 adds the extension and whether it was a replay. */
export interface Reservation {
  doctorId: string; kind: 'instant' | 'scheduled'; refId: string; startTime: string; endTime: string; isActive: boolean;
  extension?: { requestKey?: string; minutes: number; endTime: string; at: string };
  replayed?: boolean;
}
/** Q13 `doctorInstantBooking`: one instant consultation with the interval it holds now and every extension. */
export interface InstantBookingView {
  bookingId: string; instantRequestId?: string; status: AppointmentStatus; consultationMode?: ConsultMode; bookingDate: string; bookingTime: string;
  feeMinor: number; patient: { name: string; age?: number; gender?: string } | null;
  held: { startTime: string; endTime: string; isActive: boolean; current: boolean } | null;
  extensions: { requestKey?: string; minutes: number; endTime: string; at: string }[];
}
const REQUEST_KEY = /^[A-Za-z0-9_-]{8,100}$/;

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
  /** Q14: the current no-show (who marked it, when), and the no-show it was moved after (at most one) with the count. */
  noShow?: { at: string; by: string; byKind: string };
  noShows?: BookingNoShowMove[];
  noShowReschedules?: number;
  createdAt?: string;
  /** The version a no-show move names (`expectedUpdatedAt`, 409 BOOKING_CHANGED when it moved). */
  updatedAt?: string;
  /** The slot it holds (Q16d: a session with several seats has its no-show only after the session ends). */
  slotId?: string;
}

export type AppointmentAction = 'confirm' | 'complete' | 'cancel' | 'no_show';

/**
 * Q14 `rescheduleNoShow` (`bookings/services`): the doctor may move their own no-show once to a later slot (same price,
 * no payment, no refund). Instant consultations are never moved. 'offer' = it can be moved now; 'used' = it was moved
 * once already (a second no-show is final); 'clinic' = a desk appointment, which its clinic moves; null = nothing to move.
 */
export function doctorNoShowMove(b: Pick<DoctorAppointment, 'status' | 'bookingKind' | 'noShows' | 'noShowReschedules' | 'clinicDesk'>): 'offer' | 'used' | 'clinic' | null {
  if (b.status !== 'no_show' || b.bookingKind === 'instant') return null;
  // Q14 review: a desk appointment is moved by its clinic only (409 CLINIC_APPOINTMENT for the doctor).
  if (b.clinicDesk) return 'clinic';
  return noShowMovedOnce(b) ? 'used' : 'offer';
}

/** `GET /specialists/me/slots?date=` (`findManagedBySpecialistId`): every slot of the doctor that day, as stored. */
export interface DoctorSlot {
  _id: string;
  /** YYYYMMDD. */
  date: string;
  /** "HH:mm" (template slots) or "h:mm AM" (older slots). */
  startTime: string;
  endTime: string;
  /** Minutes; the slot's length when its end time is missing (`slotIntervalOf`). */
  duration?: number;
  maxBookings?: number;
  currentBookings?: number;
  isAvailable?: boolean;
  isActive?: boolean;
  /** A clinic branch for in-person slots. */
  branchId?: string;
  /** The consultation types the slot takes (template slots; empty or missing = any type, `assertSlotMode`). */
  serviceModes?: ConsultMode[];
  closedReason?: string;
}

/**
 * WQ11c: whether a no-show can move onto this slot — the slot takes the booking's consultation type (`assertSlotMode`:
 * a slot with types takes only those) and is at the booking's place: an in-person visit stays at its clinic branch (or,
 * without one, at a slot with no branch: the doctor's own place); an online consultation moves to a slot with no branch.
 * The server decides finally.
 */
export function noShowSlotFits(s: Pick<DoctorSlot, 'serviceModes' | 'branchId'>, b: Pick<DoctorAppointment, 'consultationMode' | 'clinicVisit'>): boolean {
  const modes = s.serviceModes ?? [];
  if (modes.length > 0 && b.consultationMode && !modes.includes(b.consultationMode)) return false;
  const branch = s.branchId ? String(s.branchId).toLowerCase() : null;
  if (b.consultationMode === 'in-person') {
    const at = b.clinicVisit?.branchId ? String(b.clinicVisit.branchId).toLowerCase() : null;
    return branch === at;
  }
  return branch === null;
}

/**
 * A move refused because the slot does not take this consultation type (`assertSlotMode` answers 409 SLOT_NOT_AVAILABLE
 * "not offered for that consultation type"; Q16a may give it its own code): named `SLOT_MODE_NOT_OFFERED` here so the page
 * says so instead of "no longer free". Any other error is returned unchanged.
 */
export function noShowModeRefusal(err: unknown): unknown {
  if (err instanceof ApiError && err.status === 409 && err.code === 'SLOT_NOT_AVAILABLE' && /consultation type|mode/i.test(err.message)) {
    return new ApiError(err.status, err.message, 'SLOT_MODE_NOT_OFFERED', err.retryAfter);
  }
  return err;
}

/**
 * A slot a no-show could move onto: open, a seat free, and still admitted (`reserveSlot`, `startedClock`): a one-patient
 * slot until it starts; Q16a re-review N1 (owner): a multi-seat window (`maxBookings` > 1, a doctor session) until it
 * ENDS (`slotIntervalOf`: its end time, or the start plus `duration` or 30 minutes when the end is missing or not later).
 */
export function movableSlot(s: DoctorSlot, now: Date): boolean {
  if (s.isActive === false || s.isAvailable === false || s.closedReason) return false;
  const max = s.maxBookings ?? 1;
  if ((s.currentBookings ?? 0) >= max) return false;
  const at = appointmentInstant(s.date, s.startTime)?.at;
  if (!at) return false;
  if (max <= 1) return at.getTime() > now.getTime();
  const endAt = s.endTime ? appointmentInstant(s.date, s.endTime)?.at : undefined;
  const end = endAt && endAt.getTime() > at.getTime() ? endAt.getTime() : at.getTime() + (Number(s.duration) > 0 ? Number(s.duration) : 30) * 60_000;
  return end > now.getTime();
}

/**
 * The status commands the server would accept now (`updateAppointmentStatus`): confirm a paid waiting booking; complete
 * a confirmed one whose start time has passed (ledger bookings only once paid: `BOOKING_NOT_PAID`); cancel a waiting or confirmed one (full refund,
 * `cancelByDoctor` / `cancelAccepted` for instant ones, which must be confirmed); no-show only for a paid, confirmed
 * booking whose time has come (`markNoShow`). Terminal states offer nothing.
 */
/**
 * Q16d `noShowAllowedFromSlot`: whether a no-show must wait for the booking's slot to END (a session with several seats)
 * and until when; null when it is a one-patient slot (or its slot is not known: the start rule, the server decides).
 */
export function sessionEndOf(b: Pick<DoctorAppointment, 'bookingKind' | 'slotId'>, slots: readonly DoctorSlot[] | undefined): Date | null {
  if (b.bookingKind === 'instant' || !b.slotId || !slots) return null;
  const s = slots.find((x) => x._id.toLowerCase() === b.slotId!.toLowerCase());
  if (!s || (s.maxBookings ?? 1) <= 1) return null;
  const at = appointmentInstant(s.date, s.startTime)?.at;
  if (!at) return null;
  const endAt = s.endTime ? appointmentInstant(s.date, s.endTime)?.at : undefined;
  return endAt && endAt.getTime() > at.getTime() ? endAt : new Date(at.getTime() + (Number(s.duration) > 0 ? Number(s.duration) : 30) * 60_000);
}

/**
 * WQ25 (r26, the treating window §25.9.1): whether "Book lab test for this patient" is offered on a consultation. The server
 * decides (409 TREATING_WINDOW_CLOSED); this only leaves the link off where the window cannot be open: cancelled, a no-show,
 * an unpaid booking still pending, or a scheduled one more than 10 minutes before its start.
 */
export function labBookableFrom(b: Pick<DoctorAppointment, 'status' | 'paymentStatus' | 'bookingKind' | 'bookingDate' | 'bookingTime'>, now: Date): boolean {
  if (b.status === 'cancelled' || b.status === 'no_show') return false;
  if (b.status === 'pending' && b.paymentStatus !== 'paid') return false;
  if (b.bookingKind === 'instant') return true;
  const at = appointmentInstant(b.bookingDate, b.bookingTime)?.at;
  return !at || at.getTime() - 10 * 60_000 <= now.getTime();
}

/** `sessionEnd`: the end of the booking's session when it is in one (`sessionEndOf`); its no-show waits for it. */
export function appointmentActions(b: DoctorAppointment, now: Date, sessionEnd: Date | null = null): AppointmentAction[] {
  const paid = b.paymentStatus === 'paid';
  if (b.status === 'pending') return b.bookingKind === 'instant' ? [] : paid ? ['confirm', 'cancel'] : ['cancel'];
  if (b.status !== 'confirmed') return [];
  const out: AppointmentAction[] = [];
  const at = appointmentInstant(b.bookingDate, b.bookingTime);
  // WQ11c (Q16a 409 NOT_STARTED_YET): completed only once its start time has passed. A time that cannot be read does not
  // hide it: the server decides.
  const started = !at || at.at.getTime() <= now.getTime();
  if ((paid || b.settlementSystem !== 'ledger') && started) out.push('complete');
  // Q14: a booking moved after a no-show is never refunded, so it is not cancelled (409 NO_SHOW_NOT_REFUNDABLE; desk rows
  // paid at the clinic excepted: nothing was taken through Jansetu).
  if (!noShowMovedOnce(b) || b.settlementSystem === 'clinic') out.push('cancel');
  // Q16a: a no-show is marked only 15 minutes after the start (409 APPOINTMENT_NOT_STARTED before; an instant
  // consultation's time is its acceptance). Q16d: in a session with several seats, 15 minutes after the session ENDS.
  const from = sessionEnd && at && sessionEnd.getTime() > at.at.getTime() ? sessionEnd.getTime() : at?.at.getTime();
  if (paid && from !== undefined && from + NO_SHOW_GRACE_MS <= now.getTime()) out.push('no_show');
  return out;
}

/** Q16a `NO_SHOW_GRACE_MS`: a no-show can be marked 15 minutes after the appointment time. */
export const NO_SHOW_GRACE_MS = 15 * 60_000;

/** The words for refusals of an appointment status change (the server's own message is the fallback). */
export const APPOINTMENT_REFUSAL: Readonly<Record<string, string>> = {
  NOT_STARTED_YET: 'This appointment has not started yet. Mark it completed once its time has come.',
  // Q16a/Q16d: a no-show is marked 15 minutes after the start; in a session with several seats, after the session ends.
  APPOINTMENT_NOT_STARTED: 'It is too early to mark this appointment a no-show: wait until 15 minutes after its time (in a session with several patients, 15 minutes after the session ends).',
  BOOKING_NOT_PAID: 'This appointment is not paid yet, so it cannot be completed.',
};
export const appointmentRefusal = (err: unknown): string | null =>
  (err instanceof ApiError && err.code ? APPOINTMENT_REFUSAL[err.code] ?? null : null);

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

/**
 * Q14 `doctorClinicSchema` (`POST /specialists/me/clinic`): the doctor's own clinic — the practice fields, an optional
 * contact email, and a request key. The doctor becomes its owner and consults at its first branch; Jansetu verifies it.
 * A second clinic is 409 DOCTOR_CLINIC_EXISTS; the same key and content answer the clinic already made (`replayed`).
 */
export interface DoctorClinicInput extends SoloPracticeInput { contactEmail?: string }
export interface DoctorClinicCreated extends SoloPracticeCreated { replayed?: boolean }
/** Q14 `findDoctorClinicByKey`: the clinic a lost create made (404 CLINIC_NOT_FOUND when none). */
export interface DoctorClinicFound { partner: SoloPractice['partner']; branches: SoloPractice['branches'] }

/** `doctorClinicSchema`: the practice rules plus a valid email when one is given. */
export function doctorClinicProblems(p: DoctorClinicInput): Partial<Record<PracticeField | 'contactEmail', string>> {
  const out: Partial<Record<PracticeField | 'contactEmail', string>> = soloPracticeProblems(p);
  if (p.contactEmail?.trim() && !EMAIL_PATTERN.test(p.contactEmail.trim())) out.contactEmail = 'Enter a valid email address, or leave it empty.';
  return out;
}

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

function clinicBody(p: DoctorClinicInput): DoctorClinicInput {
  const email = p.contactEmail?.trim();
  return { ...practiceBody(p), ...(email ? { contactEmail: email } : {}) };
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
  /** Q13: bumped by every payout, void, adjustment and destination change. */
  financeVersion?: number;
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

/** Payouts and events per page (`pageQuerySchema`: 1–500). */
export const FINANCE_PAGE = 50;
function pageCursor(cursor?: string): string | undefined {
  if (cursor !== undefined && !CURSOR_PATTERN.test(cursor)) throw new Error('Invalid cursor');
  return cursor;
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
    /**
     * Replaces the weekly template. `expectedUpdatedAt` is the saved template's `updatedAt` the edit is based on (null =
     * there was none): a template changed since is refused with 409 SCHEDULE_CHANGED (Q13).
     */
    saveSchedule: (t: ScheduleInput, expectedUpdatedAt: string | null) => {
      if (expectedUpdatedAt !== null && Number.isNaN(Date.parse(expectedUpdatedAt))) throw new Error('Invalid expectedUpdatedAt');
      return c.put<ScheduleSaved>(`${ME}/schedule`, { body: { ...scheduleBody(t), expectedUpdatedAt } });
    },
    /** A leave day (`YYYY-MM-DD`): no new bookings that day; booked slots keep their bookings. Repeating it changes nothing. */
    addLeave: (date: string) => c.post<ScheduleSaved>(`${ME}/leave`, { body: { date: toYmd(date) } }),
    removeLeave: (date: string) => c.delete<ScheduleSaved>(`${ME}/leave/${toYmd(date)}`),

    // Instant consultations (Q4b)
    /** The presence as the platform sees it now (Q13). */
    presence: () => c.get<Presence>(`${ME}/presence`),
    /** An ordered write: refused with 409 PRESENCE_CHANGED unless the stored version is still `expectedPresenceVersion`. */
    setPresence: (p: PresenceWrite) => {
      if (Object.keys(presenceProblems(p)).length) throw new Error('Invalid presence');
      if (!Number.isSafeInteger(p.expectedPresenceVersion) || p.expectedPresenceVersion < 0) throw new Error('Invalid presence version');
      return c.put<Presence>(`${ME}/presence`, { body: { available: p.available, modes: [...p.modes],
        ...(p.instantFeeMinor !== undefined ? { instantFeeMinor: p.instantFeeMinor } : {}), expectedPresenceVersion: p.expectedPresenceVersion } });
    },
    /** Keeps "available now" alive (online = available, a heartbeat within 2 minutes, not in a consultation now). */
    heartbeat: () => c.post<Presence>(`${ME}/presence/heartbeat`),
    offers: () => c.get<InstantOffer[]>(`${ME}/instant/offers`),
    /** First accept wins; accepting again as the same doctor answers the own booking with `replayed: true` (Q13). */
    accept: (requestId: string) =>
      c.post<{ request: Record<string, unknown>; booking: DoctorAppointment; replayed?: boolean }>(`${ME}/instant/${checkId(requestId, 'request')}/accept`),
    /** Adds time to a running instant consultation. The same `requestKey` with the same minutes extends once (Q13). */
    extend: (bookingId: string, minutes: number, requestKey: string) => {
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > EXTEND_MINUTES_MAX) throw new Error('Invalid minutes');
      if (!REQUEST_KEY.test(requestKey)) throw new Error('Invalid request key');
      return c.post<Reservation>(`${ME}/instant/bookings/${checkId(bookingId, 'booking')}/extend`, { body: { minutes, requestKey } });
    },
    /** One instant consultation with its held interval and extensions (Q13): where a lost extension is looked for. */
    instantBooking: (bookingId: string) => c.get<InstantBookingView>(`${ME}/instant/bookings/${checkId(bookingId, 'booking')}`),

    // Appointments
    /** Every consultation on one India-time day (`view=day`). */
    appointmentsOn: (date: string) => c.get<DoctorAppointment[]>(`${ME}/appointments`, { query: { view: 'day', date: toYmd(date) } }),
    /** Every consultation in one month (`view=month`, `YYYY-MM`). */
    appointmentsIn: (yearMonth: string) => {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(yearMonth)) throw new Error('Invalid month');
      return c.get<DoctorAppointment[]>(`${ME}/appointments`, { query: { view: 'month', yearMonth: yearMonth.replace('-', '') } });
    },
    /** Q14: the doctor's slots of one India-time day (`YYYY-MM-DD`), to pick a new time for a no-show. */
    slotsOn: (date: string) => c.get<DoctorSlot[]>(`${ME}/slots`, { query: { date: toYmd(date) } }),
    /**
     * Q14: moves the doctor's own no-show once to a later slot (same price, no payment, no refund). `expectedUpdatedAt` is
     * the booking version the move was decided on (409 BOOKING_CHANGED). The same key and slot answer it again (`replayed`).
     */
    rescheduleNoShow: (bookingId: string, slotId: string, requestKey: string, expectedUpdatedAt?: string) => {
      if (!REQUEST_KEY.test(requestKey)) throw new Error('Invalid request key');
      if (expectedUpdatedAt !== undefined && Number.isNaN(Date.parse(expectedUpdatedAt))) throw new Error('Invalid booking version');
      return c.post<DoctorAppointment & { replayed?: boolean }>(`${ME}/bookings/${checkId(bookingId, 'booking')}/reschedule-no-show`, {
        body: { slotId: checkId(slotId, 'slot'), requestKey, ...(expectedUpdatedAt !== undefined ? { expectedUpdatedAt } : {}) },
      }).catch((err: unknown) => { throw noShowModeRefusal(err); });
    },
    /** WQ25: one of the doctor's consultations (`{ booking, patient }`); only the booking is kept (no patient details in the cache). */
    appointment: async (id: string): Promise<DoctorAppointment> =>
      (await c.get<{ booking: DoctorAppointment }>(`${ME}/appointments/${checkId(id, 'appointment')}`)).booking,
    setAppointmentStatus: (id: string, status: 'confirmed' | 'completed' | 'cancelled' | 'no_show', reason?: string) =>
      c.patch<DoctorAppointment>(`${ME}/appointments/${checkId(id, 'appointment')}/status`, {
        body: { status, ...(reason && reason.trim() ? { reason: reason.trim().slice(0, 500) } : {}) },
      }),

    // Clinics (Q6)
    clinics: () => c.get<MyClinics>(`${ME}/clinics`),
    acceptInvite: (inviteId: string) => c.post<{ accepted: true; partnerId: string; memberId: string }>(`${ME}/clinic-invites/${checkId(inviteId, 'invitation')}/accept`),
    declineInvite: (inviteId: string) => c.post<{ accepted: false; partnerId: string }>(`${ME}/clinic-invites/${checkId(inviteId, 'invitation')}/decline`),
    leaveClinic: (partnerId: string) => c.post<{ left: true }>(`${ME}/clinics/${checkId(partnerId, 'clinic')}/leave`),
    /** The doctor's own clinic (solo practice), or null. Q14 `GET /me/clinic` answers the same. */
    practice: () => c.get<SoloPractice | null>(`${ME}/practice`),
    /** Q14: creates the doctor's own clinic exactly once per request key (see `DoctorClinicInput`). */
    createMyClinic: (p: DoctorClinicInput, requestKey: string) => {
      if (Object.keys(doctorClinicProblems(p)).length) throw new Error('Invalid clinic');
      if (!REQUEST_KEY.test(requestKey)) throw new Error('Invalid request key');
      return c.post<DoctorClinicCreated>(`${ME}/clinic`, { body: { ...clinicBody(p), requestKey } });
    },
    /** Q14: the clinic a lost create made, by its key (404 CLINIC_NOT_FOUND: nothing made with it, so far). */
    myClinicByKey: (key: string) => {
      if (!REQUEST_KEY.test(key)) throw new Error('Invalid request key');
      return c.get<DoctorClinicFound>(`${ME}/clinic/by-key/${key}`);
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
    /** Newest first, paged by the exact cursor from `nextCursor` (Q13). */
    payouts: (cursor?: string) => c.page<Payout>(`${ME}/finance/payouts`, { query: { cursor: pageCursor(cursor), limit: FINANCE_PAGE } }),
    history: () => c.get<HistoryRef[]>(`${ME}/finance/history`),
    events: (cursor?: string) => c.page<FinanceEvent>(`${ME}/finance/events`, { query: { cursor: pageCursor(cursor), limit: FINANCE_PAGE } }),
    /**
     * Any change (even to the same values) needs Jansetu's verification again before the next payout.
     * `expectedDetailsVersion` is the destination version the form was opened on: 409 PAYOUT_DETAILS_CHANGED otherwise (Q13).
     */
    setPayoutDetails: (i: PayoutDetailsInput, expectedDetailsVersion: number) => {
      if (Object.keys(payoutDetailsProblems(i)).length) throw new Error('Invalid payout details');
      if (!Number.isSafeInteger(expectedDetailsVersion) || expectedDetailsVersion < 0) throw new Error('Invalid details version');
      return c.put<SettlementAccountView>(`${ME}/finance/payout-details`, { body: { ...payoutBody(i), expectedDetailsVersion } });
    },
  };
}

export type DoctorToolsApi = ReturnType<typeof doctorToolsApi>;

/** A doctor as the admin directory lists them (`GET /specialists`, admins see every field the record has). */
export interface DirectoryDoctor {
  _id: string; name: string; specialization?: string; phone?: string; city?: string; isActive?: boolean; isVerified?: boolean;
}
export const MAX_DIRECTORY_SEARCH = 100;

/** Platform admins: finding doctors to link to a clinic, and moving a doctor's no-show (any doctor's booking). */
export function doctorAdminApi(c: ApiClient) {
  return {
    /**
     * Verified, active doctors matching the text, 20 a page. The server's text index covers whole words of the name,
     * speciality and bio only: no mobile numbers, no partial names (the rows show each doctor's mobile to check).
     */
    search: (text: string, page = 1) => {
      const t = text.trim();
      if (!t || t.length > MAX_DIRECTORY_SEARCH) throw new Error('Invalid search');
      return c.page<DirectoryDoctor>('/specialists', { query: { search: t, isVerified: 'true', isActive: 'true', page, limit: 20 } });
    },
    /** Q14 `POST /specialists/admin/bookings/:id/reschedule-no-show`: as the doctor's own move, for any booking. */
    rescheduleNoShow: (bookingId: string, slotId: string, requestKey: string, expectedUpdatedAt?: string) => {
      if (!REQUEST_KEY.test(requestKey)) throw new Error('Invalid request key');
      return c.post<DoctorAppointment & { replayed?: boolean }>(`/specialists/admin/bookings/${checkId(bookingId, 'booking')}/reschedule-no-show`, {
        body: { slotId: checkId(slotId, 'slot'), requestKey, ...(expectedUpdatedAt !== undefined ? { expectedUpdatedAt } : {}) },
      }).catch((err: unknown) => { throw noShowModeRefusal(err); });
    },
  };
}

