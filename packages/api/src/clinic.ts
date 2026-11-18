import type { ApiClient } from './client.ts';
import { appointmentInstant } from './cancellationWindow.ts';
import type { ClinicDoctor, InvoiceState } from './partnerInvoices.ts';
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
 *
 * Q13 (`m0/q13-doctor-finance`): invitations name the doctor; started slots are left out of `/clinic/slots` and refused
 * (409 SLOT_STARTED); a lost desk booking is looked up or given up by its key (`/clinic/appointments/by-key/:key(/abandon)`,
 * the desk member's own keys); desk steps name the appointment's `updatedAt` (`expectedUpdatedAt`; 409 BOOKING_CHANGED).
 *
 * Q14 (`m0/q14-owner-decisions`, owner decisions of 18 Nov 2026): clinics no longer invite doctors — an admin links a
 * doctor directly (`POST /clinic/doctors`, admins only: 403 DOCTOR_LINK_ADMIN_ONLY) and the owner or an admin removes one
 * (`DELETE /clinic/doctors/:doctorId`); desk bookings may be for a family member (`patient`); appointment rows carry
 * their bill; a desk no-show may be moved once (`/reschedule-no-show`). Desk bookings, moves and cancellations notify the
 * patient and the doctor (the server sends them; nothing to do here).
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

/** `IClinicDoctorInvite` as stored; Q13: the list adds the doctor's current name and speciality (no contact details). */
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
  /** Q13 `listInvites` (the invite answer itself carries the doctor beside the invitation). */
  doctor?: { doctorId: string; name: string | null; specialization: string | null };
  /** Q14: how the link was made — a (retired) invitation the doctor accepted, or an admin's direct link. */
  via?: 'invite' | 'admin_link';
}

/** Q14 `linkDoctorSchema`: an admin links a verified doctor at some or all branches (empty = all), once per request key. */
export interface LinkDoctorInput { doctorId: string; branchIds: string[]; requestKey: string }
/**
 * Q14 `linkDoctor`: the accepted link row, the doctor, the membership. `replayed` = this key had already linked them (the
 * same answer). Refusals: 404 DOCTOR_NOT_FOUND, 409 DOCTOR_NOT_ELIGIBLE (not active and verified), DOCTOR_PHONE_REQUIRED,
 * DOCTOR_ALREADY_MEMBER, PHONE_USED_BY_ANOTHER_DOCTOR, IDEMPOTENCY_KEY_REUSED; 403 DOCTOR_LINK_ADMIN_ONLY for members.
 */
export interface DoctorLinkResult {
  link: DoctorInvite;
  doctor: { doctorId: string; name: string | null; specialization: string | null };
  memberId?: string;
  replayed: boolean;
}
/** Q14 `unlinkDoctor` (owners and admins): a consult-only membership ends; a staff record keeps its access but not the doctor link. */
export interface DoctorUnlinkResult { unlinked: true; membershipEnded: boolean }

/** `linkDoctorSchema.branchIds.max(50)`. */
export const MAX_LINK_BRANCHES = 50;

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
 * Why `linkDoctor` would refuse this before looking the doctor up (`linkDoctorSchema`, `clinicBranch`): a doctor chosen,
 * at most 50 branches, each an active in-clinic branch of this clinic (`offered`). Empty = every branch.
 */
export function linkProblems(input: { doctorId: string; branchIds: readonly string[] }, offered: readonly Pick<Branch, '_id'>[]):
  Partial<Record<'doctorId' | 'branchIds', string>> {
  const out: Partial<Record<'doctorId' | 'branchIds', string>> = {};
  if (!OBJECT_ID_PATTERN.test(input.doctorId)) out.doctorId = 'Choose the doctor.';
  if (input.branchIds.length > MAX_LINK_BRANCHES) out.branchIds = `Choose at most ${MAX_LINK_BRANCHES} branches.`;
  else if (input.branchIds.some((b) => !offered.some((o) => o._id === b))) out.branchIds = 'Choose branches of this clinic that take in-clinic consultations.';
  return out;
}

/** Q14: the server's refusals of a link, in words an admin can act on (the server's message is the fallback). */
export const LINK_REFUSAL: Record<string, string> = {
  DOCTOR_NOT_FOUND: 'This doctor was not found.',
  DOCTOR_NOT_ELIGIBLE: 'Only active, verified doctors can be linked to a clinic.',
  DOCTOR_PHONE_REQUIRED: 'This doctor has no mobile number on their profile (it is their clinic sign-in). Add one first.',
  DOCTOR_ALREADY_MEMBER: 'This doctor already consults at this clinic.',
  PHONE_USED_BY_ANOTHER_DOCTOR: 'This doctor’s mobile number belongs to another doctor at this clinic.',
  DOCTOR_LINK_ADMIN_ONLY: 'Doctors are linked to clinics by the Jansetu team after checking. Ask them to add this doctor.',
};

/** Active doctors who consult at this branch (a doctor's empty branch list = every branch). */
export const doctorsAtBranch = <D extends Pick<ClinicDoctor, 'active' | 'branchIds'>>(doctors: readonly D[], branchId: string): D[] =>
  doctors.filter((d) => d.active && (d.branchIds.length === 0 || d.branchIds.includes(branchId)));

// ── Front desk (services/clinic.ts: deskSlots, createDeskAppointment, listClinicAppointments, desk steps) ──

/**
 * A bookable in-clinic slot of one doctor at one branch on one day (a seat is free and the doctor's time is not held).
 * Q13: slots that have already started are not listed (and refused at booking: 409 SLOT_STARTED).
 */
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
  /** Q13: the Booking's `updatedAt`; a desk step names it (`expectedUpdatedAt`) to refuse acting on a stale view. */
  updatedAt?: string;
  /** Q14 `deskView.dependentId`: the family member being seen (null = the account holder). */
  dependentId?: string | null;
}
/** Q13 `abandonDeskKey`: `abandoned` = the key can never book; `used` = it did (the appointment, or null when it is no longer in this desk's branches). */
export interface DeskKeyAbandon { state: 'abandoned' | 'used'; booking?: DeskAppointment | null }

/** Q14 `billsForAppointments`: an appointment's open bill, else its latest cancelled one. */
export interface AppointmentBill { invoiceId: string; serial: string; number: number; state: InvoiceState }

/** Q14 `IBookingNoShow`: a no-show that was moved once (the missed time, who moved it and when). */
export interface BookingNoShowMove {
  at?: string; by?: string; byKind?: string;
  rescheduledAt: string; rescheduledBy?: string; rescheduledByKind?: string;
  fromSlotId?: string; fromDate?: string; fromTime?: string; toSlotId?: string;
}

/** `listClinicAppointments`: desk and online consultations at the clinic's branches in scope. */
export interface ClinicAppointment extends DeskAppointment {
  source: 'desk' | 'online';
  paidOnline: boolean;
  /**
   * The person being seen (a family member when booked for one); the account holder's mobile is the contact. Q14:
   * `dependentId` names the family member (null = the account holder).
   */
  patient: { name?: string; relationship?: string; accountName?: string; phone?: string; dependentId?: string | null };
  /** Q14: the bill of this appointment (its open bill, else the latest cancelled one), or null when none was issued. */
  bill?: AppointmentBill | null;
}

/** `appointmentsQuerySchema` + `listClinicAppointments`: from ≤ to, at most 31 days, sorted by date and time, at most 1000. */
export interface AppointmentQuery { from: string; to: string; doctorId?: string; branchId?: string; status?: ClinicAppointmentStatus }
export const MAX_APPOINTMENT_DAYS = 31;
export const MAX_APPOINTMENTS = 1000;

/** Q14 `DESK_RELATIONS` (the dependents module's list; the account holder is "no patient"). */
export const DESK_RELATIONS = ['Father', 'Mother', 'Spouse', 'Wife', 'Husband', 'Son', 'Daughter', 'Brother', 'Sister', 'Friend', 'Grandfather', 'Grandmother', 'Other'] as const;
export type DeskRelation = (typeof DESK_RELATIONS)[number];
export const DESK_GENDERS = ['Male', 'Female', 'Other'] as const;
export type DeskGender = (typeof DESK_GENDERS)[number];
/** `deskPatientSchema.name.max(200)`. */
export const MAX_FAMILY_NAME = 200;

/**
 * Q14 `deskPatientSchema`: who is seen. Omitted = the account holder; an existing family member of the account of this
 * mobile (`dependentId`, else 404 DEPENDENT_NOT_FOUND); or a new family member created with the booking (an active one
 * with the same name and relation is used as it is).
 */
export type DeskPatientInput =
  | { dependentId: string }
  | { name: string; relation: DeskRelation; gender?: DeskGender; dateOfBirth?: string };

/** `deskPatientSchema` (new family member): a name, a known relation, an optional gender, a real date of birth not in the future. */
export function familyMemberProblems(p: { name: string; relation: string; gender: string; dateOfBirth: string }, today: string):
  Partial<Record<'name' | 'relation' | 'gender' | 'dateOfBirth', string>> {
  const out: Partial<Record<'name' | 'relation' | 'gender' | 'dateOfBirth', string>> = {};
  const name = p.name.trim();
  if (!name) out.name = 'Enter the family member’s name.';
  else if (name.length > MAX_FAMILY_NAME) out.name = `Use at most ${MAX_FAMILY_NAME} characters.`;
  if (!(DESK_RELATIONS as readonly string[]).includes(p.relation)) out.relation = 'Choose how they are related to the account holder.';
  if (p.gender && !(DESK_GENDERS as readonly string[]).includes(p.gender)) out.gender = 'Choose a gender, or leave it empty.';
  if (p.dateOfBirth && (!isRealDate(p.dateOfBirth) || p.dateOfBirth > today)) out.dateOfBirth = 'Enter a real date that is not in the future.';
  return out;
}

/*
 * Q14: the desk cannot browse an account's family list (any mobile number would reveal it). It books the account holder
 * or names a family member (name + relation): the server reuses an active family member with the same name and relation.
 */

/** `deskBookingSchema`. */
export interface DeskBookingInput {
  slotId: string;
  customer: { phone: string; name?: string };
  /** Q14: who is seen (omitted = the account holder). Part of the request identity. */
  patient?: DeskPatientInput;
  notes?: string;
  /** Exactly once per (desk member, key); the server keeps a hash of slot, mobile and notes with it. */
  requestKey: string;
}
export interface DeskBookingResult {
  booking: DeskAppointment;
  customer: { userId: string; phone: string | null; created: boolean };
  /** Q14 `patientView`: the family member being seen (`created` = added with this booking); null = the account holder. */
  patient?: { dependentId: string; name: string | null; relationship: string | null; created: boolean } | null;
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

export type DeskAction = 'arrived' | 'complete' | 'no_show' | 'cancel' | 'reschedule' | 'reschedule_no_show';
export interface DeskActionOffer { action: DeskAction; blocked?: string }

/** `CANCELLABLE_BOOKING_STATUSES` (bookings/holds.ts): cancel and reschedule accept these. */
const MOVABLE: readonly ClinicAppointmentStatus[] = ['pending', 'confirmed'];

/**
 * The desk steps of `services/clinic.ts` for this actor (`bookings.manage`), on the clinic's own DESK appointments only
 * (online bookings at the clinic are view-only for it, Q6 §11):
 * - `markArrived`: confirmed and not yet arrived;
 * - `closeDeskAppointment`: confirmed → completed (any time) or no_show (only once the appointment time has passed);
 * - `cancelDeskAppointment` / `rescheduleDeskAppointment`: while pending or confirmed (`CANCELLABLE_BOOKING_STATUSES`);
 * - Q14 `rescheduleDeskNoShow`: a no-show, once. Desk rows do not say whether the one move was used (`deskView` carries
 *   no history), so the step is offered and the server decides (409 NO_SHOW_RESCHEDULE_USED: a second no-show is final).
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
  if (a.status === 'no_show') out.push({ action: 'reschedule_no_show' });
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
function checkKey(key: string): string {
  if (!REQUEST_KEY_PATTERN.test(key)) throw new Error('Invalid request key');
  return key;
}
/** Q13 `deskStepSchema.expectedUpdatedAt` (an ISO date): the version the step was decided on, when known. */
function expected(updatedAt: string | undefined): { expectedUpdatedAt?: string } {
  if (updatedAt === undefined) return {};
  if (Number.isNaN(Date.parse(updatedAt))) throw new Error('Invalid appointment version');
  return { expectedUpdatedAt: updatedAt };
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
    /**
     * Q14: an admin (acting as owner) links a verified doctor at these branches (empty = all), exactly once per (clinic,
     * request key): the same key and content answer the same link (`replayed`). Members are refused (403).
     */
    linkDoctor: (input: LinkDoctorInput) => {
      for (const b of input.branchIds) checkId(b, 'branch');
      checkKey(input.requestKey);
      if (input.branchIds.length > MAX_LINK_BRANCHES) throw new Error('Too many branches');
      return c.post<DoctorLinkResult>(`${base()}/doctors`, { body: { doctorId: checkId(input.doctorId, 'doctor').toLowerCase(), branchIds: input.branchIds, requestKey: input.requestKey } });
    },
    /** Q14: the owner (or an admin) removes a doctor from the clinic (404 DOCTOR_NOT_AT_CLINIC, 409 DOCTOR_IS_OWNER). */
    unlinkDoctor: (doctorId: string) => c.delete<DoctorUnlinkResult>(`${base()}/doctors/${checkId(doctorId, 'doctor')}`),
    /** Pending only (409 INVITE_NOT_PENDING otherwise). Q14: invitations can no longer be accepted; revoking tidies them up. */
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
      checkKey(body.requestKey);
      if (body.patient && 'dependentId' in body.patient) checkId(body.patient.dependentId, 'family member');
      const phone = canonicalMobile(body.customer.phone);
      if (!phone) throw new Error('Invalid mobile number');
      return c.post<DeskBookingResult>(`${base()}/appointments`, { body: { ...body, customer: { ...body.customer, phone } } });
    },
    /** Q13: the appointment this desk member's `key` booked, within their clinic and branches (404 BOOKING_NOT_FOUND otherwise). */
    appointmentByKey: (key: string) => c.get<DeskAppointment>(`${base()}/appointments/by-key/${checkKey(key)}`),
    /** Q13: gives up a lost desk booking, decided by the server (the key is claimed in the booking transaction). */
    abandonBookingKey: (key: string) => c.post<DeskKeyAbandon>(`${base()}/appointments/by-key/${checkKey(key)}/abandon`, { body: {} }),
    /**
     * The desk steps. Q13: each names the `updatedAt` of the appointment as the person saw it; the server refuses a step on
     * an appointment that changed since (409 BOOKING_CHANGED).
     */
    arrived: (id: string, updatedAt?: string) => c.post<DeskAppointment>(appt(id, 'arrived'), { body: expected(updatedAt) }),
    complete: (id: string, updatedAt?: string) => c.post<DeskAppointment>(appt(id, 'complete'), { body: expected(updatedAt) }),
    noShow: (id: string, updatedAt?: string) => c.post<DeskAppointment>(appt(id, 'no-show'), { body: expected(updatedAt) }),
    /** No money moves: desk appointments are paid at the clinic. An empty reason is stored as "Cancelled by the clinic". */
    cancel: (id: string, reason?: string, updatedAt?: string) =>
      c.post<DeskAppointment>(appt(id, 'cancel'), { body: { ...(reason?.trim() ? { reason: reason.trim() } : {}), ...expected(updatedAt) } }),
    /** Another slot of the same doctor at one of this clinic's branches in the actor's scope; clears the check-in. */
    reschedule: (id: string, slotId: string, updatedAt?: string) =>
      c.post<DeskAppointment>(appt(id, 'reschedule'), { body: { slotId: checkId(slotId, 'slot'), ...expected(updatedAt) } }),
    /**
     * Q14: moves a desk no-show once to a later slot of the same doctor at this clinic (nothing is paid or refunded
     * through Jansetu); exactly once per (appointment, request key): the same key and slot answer it again (`replayed`).
     */
    rescheduleNoShow: (id: string, slotId: string, requestKey: string, updatedAt?: string) =>
      c.post<DeskAppointment & { replayed?: boolean }>(appt(id, 'reschedule-no-show'),
        { body: { slotId: checkId(slotId, 'slot'), requestKey: checkKey(requestKey), ...expected(updatedAt) } }),
  };
}
