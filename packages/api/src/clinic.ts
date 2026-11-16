import type { ApiClient } from './client.ts';
import { appointmentInstant } from './cancellationWindow.ts';
import type { ClinicDoctor } from './partnerInvoices.ts';
import { addDays, isRealDate } from './partnerLabs.ts';
import {
  hasGlobalScope, holdsAny, OBJECT_ID_PATTERN, partnerWorkspaceBase, REQUEST_KEY_PATTERN, type Branch, type PartnerActorView, type PartnerScope,
} from './partners.ts';

/**
 * Q6 clinics: the doctors who consult at a clinic (by invitation the doctor accepts in their own app) and the clinic's
 * front desk (in-clinic appointments on those doctors' slots, for walk-in and phone patients). Typed from the backend's
 * `src1/modules/partners/{validation,controller,services}/clinic.ts` and `model/clinicDoctor.ts`; the rules mirrored here
 * are cited per function. The server decides; these mirrors only say what to offer and why something is not offered.
 *
 * Routes: `registerWorkspaceRoutes` in `partners/routes/index.ts`, for members (`/partner-workspace/clinic/...`) and admins
 * acting as owner (`/partner-workspace/admin/:partnerId/workspace/clinic/...`).
 */

// ── Doctors and invitations (model/clinicDoctor.ts, services/clinic.ts) ──

/** `GET /clinic/doctors` also gives the doctor's consultation fee (rupees, the specialist's own record). */
export interface ClinicDoctorRow extends ClinicDoctor {
  consultationFee?: number;
}

export type DoctorInviteState = 'pending' | 'accepted' | 'declined' | 'revoked';
export const DOCTOR_INVITE_STATES: readonly DoctorInviteState[] = ['pending', 'accepted', 'declined', 'revoked'];
export const DOCTOR_INVITE_STATE_LABEL: Record<DoctorInviteState, string> = {
  pending: 'Waiting for the doctor', accepted: 'Accepted', declined: 'Declined by the doctor', revoked: 'Revoked',
};

/** `IClinicDoctorInvite` as stored (the list returns the stored rows: no doctor name). */
export interface DoctorInvite {
  _id: string;
  partnerId: string;
  doctorId: string;
  /** The branches the doctor will consult at (empty = every branch). */
  branchIds: string[];
  invitedBy: string;
  state: DoctorInviteState;
  respondedAt?: string;
  memberId?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** `inviteDoctorSchema`: exactly one of `doctorId` or `phone` (xor), and up to 50 branches (empty = all). */
export type InviteDoctorInput = ({ doctorId: string; phone?: never } | { phone: string; doctorId?: never }) & { branchIds: string[] };

/** `inviteDoctor`: `created` false = this doctor already had a pending invitation (the same one is answered). */
export interface InviteResult {
  invite: DoctorInvite;
  doctor: { doctorId: string; name?: string; specialization?: string };
  created: boolean;
}

/** `inviteDoctorSchema.branchIds.max(50)`. */
export const MAX_INVITE_BRANCHES = 50;

/**
 * `canonicalMobile` (common/utils/phone.ts): "+91 98765 43210", "919876543210" and "09876543210" are all "9876543210";
 * anything else is not a mobile number (null).
 */
export function canonicalMobile(raw: string): string | null {
  let p = raw.replace(/[\s-]/g, '');
  if (p.startsWith('+91')) p = p.slice(3);
  else if (p.startsWith('91') && p.length === 12) p = p.slice(2);
  else if (p.startsWith('0') && p.length === 11) p = p.slice(1);
  return /^[0-9]{10}$/.test(p) ? p : null;
}

/** Branches a doctor can be invited to or booked at (`clinicBranch`): active, taking in-clinic consultations, in the actor's scope. */
export function clinicBranchesFor(branches: readonly Branch[], actor: Pick<PartnerActorView, 'role' | 'branchIds'>): Branch[] {
  return branches.filter((b) => b.isActive !== false && !!b.services?.inClinic && (hasGlobalScope(actor) || actor.branchIds.includes(b._id)));
}

/**
 * Why `inviteDoctor` would refuse this before looking the doctor up: a doctor id or a ten-digit mobile (one of them), and
 * the branch ceiling (`assertScopeWithin`: a branch-restricted member must name branches, all inside their own).
 */
export function inviteProblems(input: { by: 'phone' | 'doctorId'; value: string; branchIds: readonly string[] },
  actor: Pick<PartnerActorView, 'role' | 'branchIds'>): Partial<Record<'value' | 'branchIds', string>> {
  const out: Partial<Record<'value' | 'branchIds', string>> = {};
  const v = input.value.trim();
  if (input.by === 'phone') {
    if (!canonicalMobile(v)) out.value = 'Enter the doctor’s ten-digit mobile number.';
  } else if (!OBJECT_ID_PATTERN.test(v)) out.value = 'A doctor id is 24 characters (0–9, a–f).';
  if (input.branchIds.length > MAX_INVITE_BRANCHES) out.branchIds = `Choose at most ${MAX_INVITE_BRANCHES} branches.`;
  else if (!hasGlobalScope(actor)) {
    if (input.branchIds.length === 0) out.branchIds = 'Choose the branches (you can only invite to your own branches).';
    else if (input.branchIds.some((b) => !actor.branchIds.includes(b))) out.branchIds = 'You can only invite to your own branches.';
  }
  return out;
}

/** Active doctors who consult at this branch (a doctor's empty branch list = every branch). */
export const doctorsAtBranch = <D extends Pick<ClinicDoctor, 'active' | 'branchIds'>>(doctors: readonly D[], branchId: string): D[] =>
  doctors.filter((d) => d.active && (d.branchIds.length === 0 || d.branchIds.includes(branchId)));

// ── Front desk (services/clinic.ts: deskSlots, createDeskAppointment, listClinicAppointments, desk steps) ──

/** A bookable in-clinic slot of one doctor at one branch on one day (a seat is free and the doctor's time is not held). */
export interface DeskSlot {
  slotId: string;
  /** India-time date YYYY-MM-DD. */
  date: string;
  /** As stored on the slot: "HH:mm" (template slots) or "h:mm AM" (older slots). */
  startTime: string;
  endTime: string;
  /** The instant it starts. */
  startsAt: string;
  seatsLeft: number;
}

export type ClinicAppointmentStatus = 'pending' | 'confirmed' | 'completed' | 'cancelled' | 'no_show';
export const CLINIC_APPOINTMENT_STATUSES: readonly ClinicAppointmentStatus[] = ['pending', 'confirmed', 'completed', 'cancelled', 'no_show'];
export const CLINIC_APPOINTMENT_STATUS_LABEL: Record<ClinicAppointmentStatus, string> = {
  pending: 'Waiting for payment', confirmed: 'Booked', completed: 'Seen', cancelled: 'Cancelled', no_show: 'Did not come',
};

/** `deskView`: what every desk command answers. */
export interface DeskAppointment {
  bookingId: string;
  /** YYYYMMDD (India time). */
  bookingDate: string;
  /** As stored ("HH:mm" or "h:mm AM"). */
  bookingTime: string;
  status: ClinicAppointmentStatus;
  doctorId: string;
  doctorName?: string;
  branchId?: string;
  slotId?: string;
  consultationMode?: string;
  /** The booking's price in RUPEES (the doctor's consultation fee; desk appointments are paid at the clinic). */
  fee?: number;
  /** `settlementSystem === 'clinic'`: a desk appointment, paid at the clinic, never through Jansetu. */
  payAtClinic: boolean;
  arrivedAt?: string | null;
}

/** `listClinicAppointments`: desk and online consultations at the clinic's branches in scope. */
export interface ClinicAppointment extends DeskAppointment {
  source: 'desk' | 'online';
  paidOnline: boolean;
  /** The person being seen (a family member when booked for one); the account holder's mobile is the contact. */
  patient: { name?: string; relationship?: string; accountName?: string; phone?: string };
}

/** `appointmentsQuerySchema` + `listClinicAppointments`: from ≤ to, at most 31 days, sorted by date and time, at most 1000. */
export interface AppointmentQuery { from: string; to: string; doctorId?: string; branchId?: string; status?: ClinicAppointmentStatus }
export const MAX_APPOINTMENT_DAYS = 31;
export const MAX_APPOINTMENTS = 1000;

/** `deskBookingSchema`. */
export interface DeskBookingInput {
  slotId: string;
  customer: { phone: string; name?: string };
  notes?: string;
  /** Exactly once per (desk member, key); the server keeps a hash of slot, mobile and notes with it. */
  requestKey: string;
}
export interface DeskBookingResult {
  booking: DeskAppointment;
  customer: { userId: string; phone: string | null; created: boolean };
  /** The key had already booked this exact appointment: this is its receipt (nothing new was booked). */
  replayed: boolean;
}
/** `deskBookingSchema`: name ≤ 120, notes ≤ 1000, phone ≤ 20 (then a ten-digit mobile, `normalizePhone`). */
export const MAX_DESK_NAME = 120;
export const MAX_DESK_NOTES = 1000;
/** `deskCancelSchema.reason` (optional; empty = "Cancelled by the clinic"). */
export const MAX_DESK_CANCEL_REASON = 500;

/** Why the server would refuse this desk booking's details (`deskBookingSchema`, `normalizePhone`), per field. */
export function deskBookingProblems(d: { phone: string; name: string; notes: string }): Partial<Record<'phone' | 'name' | 'notes', string>> {
  const out: Partial<Record<'phone' | 'name' | 'notes', string>> = {};
  if (!d.phone.trim()) out.phone = 'Enter the patient’s mobile number.';
  else if (!canonicalMobile(d.phone)) out.phone = 'Enter a ten-digit mobile number.';
  if (d.name.trim().length > MAX_DESK_NAME) out.name = `Use at most ${MAX_DESK_NAME} characters.`;
  if (d.notes.trim().length > MAX_DESK_NOTES) out.notes = `Use at most ${MAX_DESK_NOTES} characters.`;
  return out;
}

/** `listClinicAppointments`: real dates, from ≤ to, at most 31 days; null when fine. */
export function appointmentRangeProblem(from: string, to: string): string | null {
  if (!isRealDate(from) || !isRealDate(to)) return 'Enter real dates.';
  if (to < from) return 'The end date is before the start date.';
  if (to > addDays(from, MAX_APPOINTMENT_DAYS - 1)) return `At most ${MAX_APPOINTMENT_DAYS} days at a time.`;
  return null;
}

/** "20261117" → "2026-11-17" (null if it is not a real date). */
export function appointmentDay(bookingDate: string): string | null {
  if (!/^\d{8}$/.test(bookingDate)) return null;
  const d = `${bookingDate.slice(0, 4)}-${bookingDate.slice(4, 6)}-${bookingDate.slice(6, 8)}`;
  return isRealDate(d) ? d : null;
}

/** The appointment's instant, read as the backend does (`parseAppointment`: IST, "HH:mm" or "h:mm AM"). */
export const appointmentAt = (a: Pick<DeskAppointment, 'bookingDate' | 'bookingTime'>): Date | null =>
  appointmentInstant(a.bookingDate, a.bookingTime)?.at ?? null;

export type DeskAction = 'arrived' | 'complete' | 'no_show' | 'cancel' | 'reschedule';
export interface DeskActionOffer { action: DeskAction; blocked?: string }

/** `CANCELLABLE_BOOKING_STATUSES` (bookings/holds.ts): cancel and reschedule accept these. */
const MOVABLE: readonly ClinicAppointmentStatus[] = ['pending', 'confirmed'];

/**
 * The desk steps of `services/clinic.ts` for this actor (`bookings.manage`), on the clinic's own DESK appointments only
 * (online bookings at the clinic are view-only for it, Q6 §11):
 * - `markArrived`: confirmed and not yet arrived;
 * - `closeDeskAppointment`: confirmed → completed (any time) or no_show (only once the appointment time has passed);
 * - `cancelDeskAppointment` / `rescheduleDeskAppointment`: while pending or confirmed (`CANCELLABLE_BOOKING_STATUSES`).
 */
export function deskActions(a: Pick<ClinicAppointment, 'source' | 'status' | 'arrivedAt' | 'bookingDate' | 'bookingTime'>,
  actor: Pick<PartnerActorView, 'role' | 'permissions'>, now: Date): DeskActionOffer[] {
  if (a.source !== 'desk' || !holdsAny(actor, ['bookings.manage'])) return [];
  const out: DeskActionOffer[] = [];
  if (a.status === 'confirmed') {
    if (!a.arrivedAt) out.push({ action: 'arrived' });
    out.push({ action: 'complete' });
    const at = appointmentAt(a);
    out.push({ action: 'no_show', blocked: at && at.getTime() <= now.getTime() ? undefined : 'A no-show can be marked only after the appointment time.' });
  }
  if (MOVABLE.includes(a.status)) out.push({ action: 'reschedule' }, { action: 'cancel' });
  return out;
}

// ── Paths ──

function checkId(id: string, what: string): string {
  if (!OBJECT_ID_PATTERN.test(id)) throw new Error(`Invalid ${what} id`);
  return id;
}
function checkDate(date: string, what: string): string {
  if (!isRealDate(date)) throw new Error(`Invalid ${what} date`);
  return date;
}
const STATES = new Set<string>(DOCTOR_INVITE_STATES);
const STATUSES = new Set<string>(CLINIC_APPOINTMENT_STATUSES);

/** The clinic routes of one partner workspace (member, or admin acting as owner). Ids, phones and dates are checked before any path. */
export function partnerClinicApi(c: ApiClient, scope: PartnerScope) {
  const base = () => `${partnerWorkspaceBase(scope)}/clinic`;
  const appt = (id: string, command: string) => `${base()}/appointments/${checkId(id, 'appointment')}/${command}`;
  return {
    /** Active doctor members visible to the caller (readers: staff.manage, bookings.view, bookings.manage, invoices.create). */
    doctors: () => c.get<ClinicDoctorRow[]>(`${base()}/doctors`),
    /** Newest first, at most 200, only invitations wholly inside a restricted manager's branches (staff.manage). */
    invites: (state?: DoctorInviteState) => {
      if (state !== undefined && !STATES.has(state)) throw new Error('Invalid invitation state');
      return c.get<DoctorInvite[]>(`${base()}/doctor-invites`, { query: { state } });
    },
    /** Idempotent while pending: a repeat answers the pending invitation (`created: false`). */
    invite: (input: InviteDoctorInput) => {
      for (const b of input.branchIds) checkId(b, 'branch');
      if (input.doctorId !== undefined) {
        return c.post<InviteResult>(`${base()}/doctor-invites`, { body: { doctorId: checkId(input.doctorId, 'doctor'), branchIds: input.branchIds } });
      }
      const phone = canonicalMobile(input.phone ?? '');
      if (!phone) throw new Error('Invalid mobile number');
      return c.post<InviteResult>(`${base()}/doctor-invites`, { body: { phone, branchIds: input.branchIds } });
    },
    /** Pending only (409 INVITE_NOT_PENDING otherwise). */
    revokeInvite: (inviteId: string) => c.delete<DoctorInvite>(`${base()}/doctor-invites/${checkId(inviteId, 'invitation')}`),

    /** Bookable slots of one doctor at one branch on one India-time day. */
    deskSlots: (q: { doctorId: string; branchId: string; date: string }) => c.get<DeskSlot[]>(`${base()}/slots`, {
      query: { doctorId: checkId(q.doctorId, 'doctor'), branchId: checkId(q.branchId, 'branch'), date: checkDate(q.date, 'slot') },
    }),
    appointments: (q: AppointmentQuery) => {
      const problem = appointmentRangeProblem(q.from, q.to);
      if (problem) throw new Error(`Invalid appointment dates: ${problem}`);
      if (q.status !== undefined && !STATUSES.has(q.status)) throw new Error('Invalid appointment status');
      return c.get<ClinicAppointment[]>(`${base()}/appointments`, {
        query: {
          from: q.from, to: q.to, status: q.status,
          doctorId: q.doctorId === undefined ? undefined : checkId(q.doctorId, 'doctor'),
          branchId: q.branchId === undefined ? undefined : checkId(q.branchId, 'branch'),
        },
      });
    },
    /**
     * Books a desk appointment exactly once per (desk member, `requestKey`): resending the same request answers the
     * appointment it made (`replayed`); another request under the same key is refused (409 IDEMPOTENCY_KEY_REUSED).
     * The key travels in the body (the route reads no header).
     */
    book: (body: DeskBookingInput) => {
      checkId(body.slotId, 'slot');
      if (!REQUEST_KEY_PATTERN.test(body.requestKey)) throw new Error('Invalid request key');
      const phone = canonicalMobile(body.customer.phone);
      if (!phone) throw new Error('Invalid mobile number');
      return c.post<DeskBookingResult>(`${base()}/appointments`, { body: { ...body, customer: { ...body.customer, phone } } });
    },
    arrived: (id: string) => c.post<DeskAppointment>(appt(id, 'arrived'), { body: {} }),
    complete: (id: string) => c.post<DeskAppointment>(appt(id, 'complete'), { body: {} }),
    noShow: (id: string) => c.post<DeskAppointment>(appt(id, 'no-show'), { body: {} }),
    /** No money moves: desk appointments are paid at the clinic. An empty reason is stored as "Cancelled by the clinic". */
    cancel: (id: string, reason?: string) =>
      c.post<DeskAppointment>(appt(id, 'cancel'), { body: reason?.trim() ? { reason: reason.trim() } : {} }),
    /** Another slot of the same doctor at one of this clinic's branches in the actor's scope; clears the check-in. */
    reschedule: (id: string, slotId: string) => c.post<DeskAppointment>(appt(id, 'reschedule'), { body: { slotId: checkId(slotId, 'slot') } }),
  };
}
