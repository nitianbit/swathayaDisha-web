import type { ApiClient, Page } from './client.ts';
import type { BookingNoShowMove } from './clinic.ts';
import type { ConsultMode, DoctorSlot } from './doctorTools.ts';
import { toYmd } from './doctorTools.ts';
import { isRealDate } from './partnerLabs.ts';
import { noShowMovedOnce } from './noShows.ts';

/**
 * WQ10b admin: doctor consultation bookings (`GET /api/v1/bookings` as an admin, `bookingType=consultation`; one by
 * `GET /bookings/:id`) and the one move of a no-show (`POST /specialists/admin/bookings/:id/reschedule-no-show`, in
 * `doctorAdminApi`). The generic booking routes answer the scrubbed no-show view (`publicNoShowView`): when it was
 * missed and moved, never who marked or moved it.
 *
 * Q15: `bookingQuerySchema.status` also takes `no_show`, and each row an admin reads carries `patientName` (the family
 * member's name when the booking is for one, else the account holder's; null when unknown). Every move stays with the
 * booking's doctor: another doctor's slot is refused 409 `SLOT_NOT_THIS_DOCTOR`.
 */

export type ConsultationStatus = 'pending' | 'confirmed' | 'completed' | 'cancelled' | 'no_show';
/** `bookingQuerySchema.status`: the statuses the list can be filtered by (Q15: `no_show` too). */
export const CONSULTATION_STATUS_FILTERS: readonly ConsultationStatus[] = ['pending', 'confirmed', 'completed', 'cancelled', 'no_show'];
export const CONSULTATION_STATUS_LABEL: Record<ConsultationStatus, string> = {
  pending: 'Waiting', confirmed: 'Confirmed', completed: 'Completed', cancelled: 'Cancelled', no_show: 'No-show',
};
export const CONSULTATIONS_PAGE_SIZE = 20;

/** A consultation booking as the admin reads it (`IBooking`, the fields shown). */
export interface AdminConsultation {
  _id: string;
  bookingType: 'consultation';
  bookingKind?: 'scheduled' | 'instant';
  userId?: string;
  dependentId?: string;
  specialistId?: string;
  doctorName?: string;
  /** Q15, admin reads of the list: the family member's or the account holder's name; null when unknown. */
  patientName?: string | null;
  primaryConcern?: string;
  consultationMode?: ConsultMode;
  /** YYYYMMDD, India time. */
  bookingDate: string;
  bookingTime: string;
  slotId?: string;
  status: ConsultationStatus;
  paymentStatus: 'pending' | 'paid' | 'failed' | 'refunded';
  price?: number;
  settlementSystem?: 'legacy' | 'ledger' | 'clinic';
  clinicDesk?: { partnerId: string; branchId: string };
  clinicVisit?: { partnerId: string; branchId: string };
  cancellationReason?: string;
  /** The current no-show (scrubbed: when only). */
  noShow?: { at?: string };
  noShows?: BookingNoShowMove[];
  noShowReschedules?: number;
  createdAt?: string;
  updatedAt?: string;
}

/** The list's filters as the screen holds them (dates YYYY-MM-DD). */
export interface ConsultationQuery {
  status?: ConsultationStatus;
  specialistId?: string;
  from?: string;
  to?: string;
  page?: number;
}

/** A doctor for the filter (`GET /specialists?name=`: part of the name, any case). */
export interface DoctorRef { _id: string; name: string; specialization?: string; phone?: string; isActive?: boolean; isVerified?: boolean }

/**
 * Q14 for an admin (`rescheduleWithHolds` with `noShow`): 'offer' = it can be moved once; 'used' = it was moved once
 * already (a second no-show is final); 'clinic' = a front-desk appointment, which its clinic moves (409
 * CLINIC_APPOINTMENT); 'instant' = an instant consultation, never moved (INSTANT_CONSULT_COMMAND_REQUIRED); null = not a
 * no-show.
 */
export function adminNoShowMove(b: Pick<AdminConsultation, 'status' | 'bookingKind' | 'clinicDesk' | 'noShows' | 'noShowReschedules'>): 'offer' | 'used' | 'clinic' | 'instant' | null {
  if (b.status !== 'no_show') return null;
  if (b.bookingKind === 'instant') return 'instant';
  if (b.clinicDesk) return 'clinic';
  return noShowMovedOnce(b) ? 'used' : 'offer';
}

/** Why the filters cannot be sent (as `bookingQuerySchema` would refuse them), or null. */
export function consultationQueryProblem(q: ConsultationQuery): string | null {
  const real = (d?: string) => !d || isRealDate(d);
  if (!real(q.from) || !real(q.to)) return 'Enter real dates.';
  if (q.from && q.to && q.from > q.to) return 'The period ends before it starts.';
  return null;
}

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
function checkId(id: string, what: string): string {
  if (!OBJECT_ID.test(id)) throw new Error(`Invalid ${what} id`);
  return id;
}

export function consultationAdminApi(c: ApiClient) {
  return {
    /** Consultation bookings, latest appointment first (`bookingDate` then `createdAt`, descending), 20 a page. */
    list: (q: ConsultationQuery = {}): Promise<Page<AdminConsultation>> => {
      const problem = consultationQueryProblem(q);
      if (problem) throw new Error(problem);
      return c.page<AdminConsultation>('/bookings', { query: {
        bookingType: 'consultation',
        status: q.status,
        specialistId: q.specialistId ? checkId(q.specialistId, 'doctor') : undefined,
        bookingDateFrom: q.from ? toYmd(q.from) : undefined,
        bookingDateTo: q.to ? toYmd(q.to) : undefined,
        page: q.page ?? 1,
        limit: CONSULTATIONS_PAGE_SIZE,
      } });
    },
    get: (id: string) => c.get<AdminConsultation>(`/bookings/${checkId(id, 'booking')}`),
    /**
     * Q15: the patient's name for one booking. `GET /bookings/:id` does not carry it (only the admin list rows do), so the
     * list is read for the booking's doctor and day (at most 3 pages of 100) and the row with its id is taken. null =
     * the server does not know the name, or the row was not found.
     */
    patientName: async (b: Pick<AdminConsultation, '_id' | 'specialistId' | 'bookingDate'>): Promise<string | null> => {
      checkId(b._id, 'booking');
      if (!/^\d{8}$/.test(b.bookingDate)) return null;
      for (let page = 1; page <= 3; page++) {
        const p = await c.page<AdminConsultation>('/bookings', { query: {
          bookingType: 'consultation',
          specialistId: b.specialistId && OBJECT_ID.test(b.specialistId) ? b.specialistId : undefined,
          bookingDateFrom: b.bookingDate, bookingDateTo: b.bookingDate, page, limit: 100,
        } });
        const hit = p.items.find((x) => x._id === b._id);
        if (hit) return hit.patientName?.trim() || null;
        if (page >= p.totalPages || p.items.length === 0) break;
      }
      return null;
    },
    /** Doctors whose name contains the text (any status), 20 at most. */
    doctors: (name: string) => {
      const t = name.trim();
      if (!t || t.length > 100) throw new Error('Invalid search');
      return c.page<DoctorRef>('/specialists', { query: { name: t, page: 1, limit: 20 } });
    },
    /**
     * `GET /slots/available?specialistId&date&mode`: the doctor's open slots with a seat free on one day (YYYY-MM-DD),
     * offered for the booking's consultation type, without those overlapping time the doctor already holds.
     */
    freeSlots: (specialistId: string, day: string, mode?: ConsultMode) =>
      c.get<(DoctorSlot & { specialistId?: string; serviceModes?: string[] })[]>('/slots/available', { query: {
        specialistId: checkId(specialistId, 'doctor'), date: toYmd(day), ...(mode ? { mode } : {}),
      } }),
  };
}
