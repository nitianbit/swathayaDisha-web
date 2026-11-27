import type { ApiClient } from './client.ts';
import type { ClinicAppointment, DeskBookingResult, DeskPatientInput } from './clinic.ts';
import { appointmentInstant } from './cancellationWindow.ts';
import { movableSlot, type DoctorAppointment, type DoctorSlot, type MyClinics, type SoloPractice } from './doctorTools.ts';
import type { FinanceSummary } from './finance.ts';
import { isRealDate } from './partnerLabs.ts';
import type { PatientLookup } from './assisted.ts';
import { OBJECT_ID_PATTERN, REQUEST_KEY_PATTERN } from './partners.ts';

/**
 * WQ56 (P2): the doctor's single dashboard on backend r39 (§26.23, stage fe9c21f2), all under `/api/v1/specialists/me`
 * and no-store: one appointment list of every source, the counted phone lookup, an appointment at a clinic he consults
 * at (that clinic's desk booking), an online consultation or a follow-up for his patient (the patient pays in the app),
 * and the earnings breakdown. His Today register and private to-dos are `todayApi(c, 'doctor')`; billing the clinic he
 * owns is the workspace's bill API with the `{ kind: 'doctor' }` scope.
 */
const ME = '/specialists/me';

export const APPOINTMENT_SOURCES = ['self', 'clinic_desk', 'pharmacy_assisted', 'lab_assisted', 'doctor_assisted', 'instant'] as const;
export type AppointmentSource = (typeof APPOINTMENT_SOURCES)[number];
/** A pharmacy or a lab booked it for the patient ("Booked by partners"). */
export const byPartner = (s: string | undefined) => s === 'pharmacy_assisted' || s === 'lab_assisted';

/** r39: the list's row: the existing row plus where it came from, its clinic and its channel. */
export interface ListedAppointment extends DoctorAppointment {
  source: AppointmentSource | string;
  clinic: { id: string; name: string | null } | null;
  channel: 'clinic' | 'online';
  /** r10b view: the partner that booked it (its name), when a partner did. */
  paidBy?: string | null;
  /** r39c: the account holder (the mobile it was booked with) on rows of the clinic he owns. */
  customer?: { phone?: string | null; name?: string | null } | null;
  /** The linked invoice at the clinic admitted for billing, regardless of its issue date. */
  bill?: ClinicAppointment['bill'];
  /** r39c: he booked it himself (a clinic appointment or an online consultation). */
  bookedByMe?: boolean;
}
export interface AppointmentListQuery {
  from?: string; to?: string; source?: AppointmentSource; clinicId?: string; channel?: 'clinic' | 'online';
  mode?: 'video' | 'call' | 'chat' | 'in-person'; status?: 'pending' | 'confirmed' | 'completed' | 'cancelled' | 'no_show';
}
/** At most 31 days a read. */
export const MAX_LIST_DAYS = 31;

/** The desk's request shape for both creates: the number's owner, or a family member of theirs. */
export interface DoctorPatientRequest { customer: { phone: string; name?: string }; patient?: DeskPatientInput }

export interface DoctorClinicBooking extends DoctorPatientRequest { clinicId: string; branchId?: string; slotId: string; notes?: string; requestKey: string }
export interface DoctorConsultationNew extends DoctorPatientRequest { slotId: string; mode: 'video' | 'call'; notes?: string; requestKey: string }
export interface DoctorFollowUp { slotId: string; mode: 'video' | 'call' | 'in-person'; followUpOf: string; notes?: string; requestKey: string }
export interface DoctorConsultationAnswer {
  booking: { bookingId: string; bookingDate: string; bookingTime: string; status: string; paymentStatus: string; consultationMode?: string; fee: number;
    source: 'doctor_assisted'; dependentId: string | null; followUpOf: string | null };
  /** The patient pays in the Jansetu app by `payBy` (30 minutes from the create); unpaid by then, it expires. */
  payment: { by: 'patient_app'; required: boolean; payBy: string | null };
  replayed: boolean;
}
/** The clinic desk's own answer (`deskView`): the appointment is that clinic's. */
export type DoctorClinicAnswer = DeskBookingResult;
export type DoctorVisitRequestKind = 'clinic' | 'online' | 'follow-up';
/** r41 `…/by-key/:key[/abandon]`: the booking the key made (a desk view, or the consultation's), given up, or not known yet. */
export type DoctorKeyedBooking =
  | { state: 'used'; booking: { bookingId?: string; _id?: string; bookingDate?: string; bookingTime?: string; status?: string };
      /** r41: a consultation's answer also says how the patient pays (as its create did); a clinic appointment's does not. */
      payment?: DoctorConsultationAnswer['payment'] }
  | { state: 'abandoned' }
  | { state: 'unknown' };
/** The appointment a keyed booking made (its id, whichever view answered). */
export const keyedBookingId = (a: DoctorKeyedBooking): string | null =>
  (a.state === 'used' ? a.booking.bookingId ?? a.booking._id ?? null : null);

export type EarningChannel = 'clinic' | 'online' | 'partner' | 'referral' | 'other';
export interface EarningSum { earnedMinor: number; reversedMinor: number; netMinor: number; count: number }
export interface EarningsBreakdown {
  from: string | null; to: string | null; totals: EarningSum; online: EarningSum; partner: EarningSum; referral: EarningSum; other: EarningSum;
  /** r39b: `clinicId` null = in-person visits with no clinic (older ones). */
  clinics: (EarningSum & { clinicId: string | null; name: string | null })[];
}
export interface BreakdownQuery { from?: string; to?: string; channel?: EarningChannel; clinicId?: string }

const check = (ok: boolean, what: string) => {
  if (!ok) throw new Error(`Invalid ${what}`); // i18n-ignore: a programming error, the screens check first
};
const id = (v: string, what: string) => { check(OBJECT_ID_PATTERN.test(v), what); return v; };
/** A clinic appointment's key is the desk create's; an online consultation's or a follow-up's is the consultation create's. */
const keyedPath = (kind: DoctorVisitRequestKind, requestKey: string) => {
  check(REQUEST_KEY_PATTERN.test(requestKey), 'request key');
  return `${ME}/${kind === 'clinic' ? 'clinic-appointments' : 'consultations'}/by-key/${requestKey}`;
};
const date = (v: string | undefined) => { check(v === undefined || isRealDate(v), 'date'); return v; };

export function doctorDashboardApi(c: ApiClient) {
  return {
    /** One list of his appointments of every source, appointment-time order (≤ 31 days; `meta.truncated` past 1000). */
    appointments: async (q: AppointmentListQuery = {}): Promise<{ items: ListedAppointment[]; truncated: boolean }> => {
      date(q.from); date(q.to);
      if (q.clinicId !== undefined) id(q.clinicId, 'clinic');
      const answer = await c.getWith<ListedAppointment[], { meta: { truncated?: boolean } }>(`${ME}/appointments/list`, { query: { ...q } });
      return { items: Array.isArray(answer.data) ? answer.data : [], truncated: answer.meta.meta?.truncated === true };
    },
    /** The clinic he bills (r39 his own clinic, r39c the clinic he owns) with its branches, or null. */
    billedClinic: () => c.get<SoloPractice | null>(`${ME}/clinic`),
    /** The counted lookup: whether the number is on Jansetu, and its owner's masked name. */
    lookup: (phone: string) => c.post<PatientLookup>(`${ME}/patients/lookup`, { body: { phone } }),
    /** An appointment at a clinic he consults at (his own included): that clinic's desk booking, paid at the clinic. */
    bookClinic: (b: DoctorClinicBooking) => {
      id(b.clinicId, 'clinic'); id(b.slotId, 'slot'); check(REQUEST_KEY_PATTERN.test(b.requestKey), 'request key');
      if (b.branchId !== undefined) id(b.branchId, 'branch');
      return c.post<DoctorClinicAnswer>(`${ME}/clinic-appointments`, { body: b });
    },
    /** An online consultation (the patient pays in the app within 30 minutes) or a free follow-up, exactly once per key. */
    bookConsultation: (b: DoctorConsultationNew | DoctorFollowUp) => {
      id(b.slotId, 'slot'); check(REQUEST_KEY_PATTERN.test(b.requestKey), 'request key');
      if ('followUpOf' in b) id(b.followUpOf, 'consultation');
      return c.post<DoctorConsultationAnswer>(`${ME}/consultations`, { body: b });
    },
    /** Exact confirmation for a request restored after reload. A null record leaves the outcome unknown. */
    /**
     * r41: what a booking's request key made (`used`, with the booking), whether it was given up (`abandoned`, it can never
     * book), or `unknown` (nothing with it yet): a clinic appointment's key, or an online consultation's or follow-up's.
     */
    bookingByKey: (kind: DoctorVisitRequestKind, requestKey: string) => c.get<DoctorKeyedBooking>(keyedPath(kind, requestKey)),
    /** r41: gives a booking's key up on the server (answers `abandoned`), unless it already booked (answers `used`). */
    abandonBooking: (kind: DoctorVisitRequestKind, requestKey: string) => c.post<DoctorKeyedBooking>(`${keyedPath(kind, requestKey)}/abandon`, { body: {} }),
    /** The earnings summary with its `breakdown` for the period and filter (r39b: only when asked, `breakdown=1`). */
    finance: (q: BreakdownQuery = {}) => {
      date(q.from); date(q.to);
      if (q.clinicId !== undefined) id(q.clinicId, 'clinic');
      return c.get<FinanceSummary & { breakdown?: EarningsBreakdown }>(`${ME}/finance`, { query: { ...q, breakdown: 1 } });
    },
  };
}
export type DoctorDashboardApi = ReturnType<typeof doctorDashboardApi>;

/** The free follow-up's window, in days (the server's follow-up rule). */
export const FOLLOW_UP_DAYS = 14;

/**
 * A consultation whose free follow-up can still be offered (the server's rule decides): completed, paid, not itself a
 * follow-up, its benefit not used, and its server-issued window open on `today`.
 */
export function followUpOpen(b: Pick<DoctorAppointment, 'status' | 'paymentStatus' | 'followUp' | 'bookingDate' | 'bookingKind'>, today: string): boolean {
  if (b.status !== 'completed' || b.paymentStatus !== 'paid' || b.followUp?.isFollowUp || b.followUp?.benefitUsed) return false;
  const last = followUpLastDay(b);
  return last !== null && last >= today;
}
/** The last day (YYYY-MM-DD) a follow-up of this consultation can be on. */
export function followUpLastDay(b: Pick<DoctorAppointment, 'followUp'>): string | null {
  const expiry = b.followUp?.eligibilityExpiresAt;
  if (!expiry || !/^\d{8}$/.test(expiry)) return null;
  const day = `${expiry.slice(0, 4)}-${expiry.slice(4, 6)}-${expiry.slice(6, 8)}`;
  return isRealDate(day) ? day : null;
}

/** The verified clinics he consults at (his own included), each with its branches: where a clinic appointment can be. */
export const bookableClinics = (c: MyClinics | undefined) => (c?.clinics ?? []).filter((m) => m.verified && m.branches.length > 0);
/**
 * The clinic he bills from his dashboard: the one `GET /me/clinic` answers (r39: his own clinic; r39c: the clinic he
 * owns), when he is its owner and it is verified; null otherwise (none, not verified, or still loading).
 */
export function ownedClinic(c: MyClinics | undefined, billed: { partner?: { _id?: string } } | null | undefined) {
  const id = billed?.partner?._id?.toLowerCase();
  const m = id ? (c?.clinics ?? []).find((x) => x.partnerId.toLowerCase() === id) : undefined;
  return m && m.role === 'owner' && m.verified ? m : null;
}

/**
 * The slots a new booking can take on that day: still bookable (`movableSlot`), at the place asked — a clinic's
 * branches (in person) or no branch (online, taking `mode` when the slot names its types).
 */
export function freeSlots(slots: readonly DoctorSlot[], now: Date, where: { branchIds: readonly string[] } | { mode: 'video' | 'call' }): DoctorSlot[] {
  return slots.filter((s) => {
    if (!movableSlot(s, now)) return false;
    const branch = s.branchId ? String(s.branchId).toLowerCase() : null;
    const modes = s.serviceModes ?? [];
    if ('branchIds' in where) return !!branch && where.branchIds.some((b) => b.toLowerCase() === branch) && (modes.length === 0 || modes.includes('in-person'));
    return branch === null && (modes.length === 0 || modes.includes(where.mode));
  }).sort((a, b) => (appointmentInstant(a.date, a.startTime)?.at.getTime() ?? 0) - (appointmentInstant(b.date, b.startTime)?.at.getTime() ?? 0));
}
