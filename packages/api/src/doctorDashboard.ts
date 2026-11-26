import type { ApiClient } from './client.ts';
import type { DeskBookingResult, DeskPatientInput } from './clinic.ts';
import { appointmentInstant } from './cancellationWindow.ts';
import { movableSlot, type DoctorAppointment, type DoctorSlot, type MyClinics } from './doctorTools.ts';
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

export type EarningChannel = 'clinic' | 'online' | 'partner' | 'referral' | 'other';
export interface EarningSum { earnedMinor: number; reversedMinor: number; netMinor: number; count: number }
export interface EarningsBreakdown {
  from: string | null; to: string | null; totals: EarningSum; online: EarningSum; partner: EarningSum; referral: EarningSum; other: EarningSum;
  clinics: (EarningSum & { clinicId: string; name: string | null })[];
}
export interface BreakdownQuery { from?: string; to?: string; channel?: EarningChannel; clinicId?: string }

const check = (ok: boolean, what: string) => {
  if (!ok) throw new Error(`Invalid ${what}`); // i18n-ignore: a programming error, the screens check first
};
const id = (v: string, what: string) => { check(OBJECT_ID_PATTERN.test(v), what); return v; };
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
    /** The earnings summary with r39's `breakdown` for the period and filter. */
    finance: (q: BreakdownQuery = {}) => {
      date(q.from); date(q.to);
      if (q.clinicId !== undefined) id(q.clinicId, 'clinic');
      return c.get<FinanceSummary & { breakdown?: EarningsBreakdown }>(`${ME}/finance`, { query: { ...q } });
    },
  };
}
export type DoctorDashboardApi = ReturnType<typeof doctorDashboardApi>;

/** The verified clinics he consults at (his own included), each with its branches: where a clinic appointment can be. */
export const bookableClinics = (c: MyClinics | undefined) => (c?.clinics ?? []).filter((m) => m.verified && m.branches.length > 0);
/** The clinic he owns and can bill (one, verified); null otherwise (none, several, or not verified yet). */
export function ownedClinic(c: MyClinics | undefined) {
  const owned = (c?.clinics ?? []).filter((m) => m.role === 'owner');
  return owned.length === 1 && owned[0]!.verified ? owned[0]! : null;
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
