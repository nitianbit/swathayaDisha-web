import { ApiError, type ApiClient, type Page } from './client.ts';
import { MAX_ADMIN_CANCEL_REASON, MIN_ADMIN_CANCEL_REASON, type AdminConsultation } from './adminConsultations.ts';
import { checkId, REQUEST_KEY_PATTERN } from './partners.ts';
import { noShowMovedOnce } from './noShows.ts';

/**
 * WQ18 admin: doctors (`/api/v1/specialists`, backend `src1/modules/specialists`) and their verification (S5), and the S5c
 * "close and refund" of a consultation (`POST /specialists/admin/bookings/:bookingId/close`, `bookings/adminClose.ts`).
 *
 * - List: `GET /specialists` as an admin answers every doctor (`applyUserFacingVisibility` applies to others only), with
 *   `specialistQuerySchema` filters (`name` part of the name, any case; `isVerified` / `isActive` 'true' | 'false';
 *   `page`, `limit` ≤ 100, `sortBy`, `sortOrder`). One: `GET /specialists/:id` (admins see every doctor, `seesDoctor`).
 * - Verify: `PUT /specialists/:id {isVerified: true, expectedName, expectedRegistrationNumber}`. `takeVerificationFence`
 *   takes the expected values out of the body (strings only); `fenceAndRecordVerification` compares them (trimmed, a
 *   missing value is '') with the stored doctor when the doctor is not verified yet, else 409
 *   SPECIALIST_CHANGED_SINCE_REVIEW, and writes the audit row first (503 INDEXES_OUTDATED before `sync-indexes`). A doctor
 *   already verified is not a verification: the update answers 200 and nothing is fenced.
 * - Unverify: `PUT /specialists/:id {isVerified: false}` (no fence on the server). Eligible = verified AND active
 *   (`isEligibleDoctor`); an ineligible doctor cannot be booked, open slots, prescribe or see patients' details.
 */


/** A doctor as an admin reads it (`ISpecialist`, the fields shown). */
export interface AdminDoctor {
  _id: string;
  name: string;
  specialization?: string;
  degree?: string;
  medicalRegistrationNumber?: string;
  phone?: string;
  email?: string;
  city?: string;
  isActive?: boolean;
  isVerified?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** The list's filters as the screen holds them (`specialistQuerySchema`). */
export interface AdminDoctorQuery {
  name?: string;
  isVerified?: 'true' | 'false';
  isActive?: 'true' | 'false';
  page?: number;
}
export const DOCTORS_PAGE_SIZE = 20;
export const MAX_DOCTOR_NAME_SEARCH = 100;

/** Where a doctor stands (S5 `isEligibleDoctor`: both stored flags must be true; a missing flag is not). */
export function doctorEligibility(d: Pick<AdminDoctor, 'isActive' | 'isVerified'>): { verified: boolean; active: boolean; eligible: boolean } {
  const verified = d.isVerified === true;
  const active = d.isActive === true;
  return { verified, active, eligible: verified && active };
}

/** S5 fence: what the admin reviewed, as the server compares it (trimmed; a missing value is the empty string). */
export interface VerifyFence { expectedName: string; expectedRegistrationNumber: string }
export const verifyFenceOf = (d: Pick<AdminDoctor, 'name' | 'medicalRegistrationNumber'>): VerifyFence => ({
  expectedName: (d.name ?? '').trim(),
  expectedRegistrationNumber: (d.medicalRegistrationNumber ?? '').trim(),
});
/** Whether the doctor as read now still carries the reviewed values (the server's own comparison). */
export const fenceHolds = (d: Pick<AdminDoctor, 'name' | 'medicalRegistrationNumber'>, f: VerifyFence) => {
  const now = verifyFenceOf(d);
  return now.expectedName === f.expectedName.trim() && now.expectedRegistrationNumber === f.expectedRegistrationNumber.trim();
};

/** 409 SPECIALIST_CHANGED_SINCE_REVIEW: the name or registration number changed since the admin read them; nothing was changed. */
export const isFenceMismatch = (err: unknown) => err instanceof ApiError && err.status === 409 && err.code === 'SPECIALIST_CHANGED_SINCE_REVIEW';

/** The refusals of a verify or unverify, in words (the server's message is the fallback). */
export function doctorStateRefusal(err: unknown): string {
  if (!(err instanceof ApiError)) return err instanceof Error ? err.message : 'Something went wrong. Please try again.';
  switch (err.code) {
    case 'SPECIALIST_CHANGED_SINCE_REVIEW': return 'The doctor’s name or registration number changed since you read them, so nothing was changed.';
    case 'SPECIALIST_NOT_FOUND': return 'This doctor no longer exists.';
    case 'INDEXES_OUTDATED': return 'The database needs an update (sync-indexes) before doctors can be verified: ask the Jansetu team.';
    default: return err.message;
  }
}

/** The verification audit's collection check (503 INDEXES_OUTDATED) runs before anything is written: it settles a sole first attempt. */
export const doctorStateRefusedBeforeWriting = (err: unknown) => err instanceof ApiError && err.status === 503 && err.code === 'INDEXES_OUTDATED';

export interface DoctorStateBody { isVerified: boolean; expectedName?: string; expectedRegistrationNumber?: string }

export function doctorAdminListApi(c: ApiClient) {
  return {
    /** Doctors, newest first, 20 a page; every doctor for an admin (verified or not, active or not). */
    list: (q: AdminDoctorQuery = {}): Promise<Page<AdminDoctor>> => {
      const name = q.name?.trim();
      if (name !== undefined && name.length > MAX_DOCTOR_NAME_SEARCH) throw new Error('Invalid search');
      return c.page<AdminDoctor>('/specialists', { query: {
        name: name || undefined,
        isVerified: q.isVerified,
        isActive: q.isActive,
        sortBy: 'createdAt',
        sortOrder: 'desc',
        page: q.page ?? 1,
        limit: DOCTORS_PAGE_SIZE,
      } });
    },
    get: (id: string) => c.get<AdminDoctor>(`/specialists/${checkId(id, 'doctor')}`),
    /** Verify with the reviewed name and registration number as the fence (409 SPECIALIST_CHANGED_SINCE_REVIEW otherwise). */
    verify: (id: string, fence: VerifyFence) => {
      if (typeof fence.expectedName !== 'string' || !fence.expectedName.trim()) throw new Error('The reviewed name is missing');
      if (typeof fence.expectedRegistrationNumber !== 'string') throw new Error('The reviewed registration number is missing');
      const body: DoctorStateBody = { isVerified: true, expectedName: fence.expectedName, expectedRegistrationNumber: fence.expectedRegistrationNumber };
      return c.put<AdminDoctor>(`/specialists/${checkId(id, 'doctor')}`, { body });
    },
    /** Take the verification away (no fence on the server: it only reduces what the doctor can do). */
    unverify: (id: string) => c.put<AdminDoctor>(`/specialists/${checkId(id, 'doctor')}`, { body: { isVerified: false } satisfies DoctorStateBody }),
  };
}

// ── S5c admin close and refund ──

export interface BookingCloseBody { reason: string; requestKey: string; expectedUpdatedAt?: string }

/** S5e `closeView`: one admin close of a booking as admins see it (the reason included). `refunded` is in rupees. */
export interface BookingClose {
  auditId: string;
  bookingId: string;
  adminId: string;
  requestKey: string;
  reason: string;
  statusBefore: string;
  paymentStatusBefore: string;
  refunded: number;
  closedAt: string;
}

/** The close's answer: the booking as it is now, plus `replayed`, `refunded` (rupees) and the close's audit row. */
export type BookingCloseAnswer = AdminConsultation & { replayed: boolean; refunded: number; close: BookingClose; assisted?: unknown };

/**
 * Offered for a consultation an admin may close with a full refund: pending or confirmed, a scheduled consultation (an
 * instant one has its own admin cancel: 409 USE_INSTANT_ADMIN_CANCEL), not moved after a no-show (the settlement refuses
 * NO_SHOW_NOT_REFUNDABLE; the moved no-show has its own admin cancel), and only when its doctor is not verified and
 * active (or no longer exists): S5c is for bookings stuck with such a doctor.
 */
export function canCloseAndRefund(
  b: Pick<AdminConsultation, 'status' | 'bookingKind' | 'bookingType' | 'settlementSystem' | 'noShows' | 'noShowReschedules'>,
  doctor: 'eligible' | 'ineligible' | 'missing' | 'unknown',
): boolean {
  if (b.status !== 'pending' && b.status !== 'confirmed') return false;
  if (b.bookingKind === 'instant') return false;
  if (String(b.bookingType) !== 'consultation' && String(b.bookingType) !== 'second-opinion') return false;
  if (noShowMovedOnce(b) && b.settlementSystem !== 'clinic') return false;
  return doctor === 'ineligible' || doctor === 'missing';
}

/** The refusals of a close, in words (the server's message is the fallback). */
export const BOOKING_CLOSE_REFUSAL: Record<string, string> = {
  BOOKING_NOT_FOUND: 'This booking no longer exists.',
  NOT_A_CONSULTATION: 'Only a consultation or a second opinion is closed here.',
  USE_INSTANT_ADMIN_CANCEL: 'An instant consultation is cancelled with its own admin cancel, not here.',
  INSTANT_CONSULT_COMMAND_REQUIRED: 'An instant consultation is cancelled with its own admin cancel, not here.',
  ALREADY_CANCELLED: 'This booking is already cancelled, so nothing more was done.',
  BOOKING_NOT_CANCELLABLE: 'This booking can no longer be closed: it was completed or marked a no-show meanwhile.',
  NO_SHOW_NOT_REFUNDABLE: 'This booking was moved after a no-show: use “Cancel (admin)” in its no-show section instead.',
  BOOKING_CHANGED: 'The booking changed since you read it, so nothing was done. It is shown as it is now: review it and close it again if it is still needed.',
  REQUEST_KEY_REUSED: 'This request was already used for another close. Start again.',
  INDEXES_OUTDATED: 'The database needs an update (sync-indexes) before bookings can be closed here: ask the Jansetu team.',
  FORBIDDEN: 'Only the Jansetu team can close a booking.',
};
export function bookingCloseRefusal(err: unknown): string {
  if (err instanceof ApiError) return (err.code && BOOKING_CLOSE_REFUSAL[err.code]) || err.message;
  return err instanceof Error ? err.message : 'Something went wrong. Please try again.';
}

/**
 * Answers that settle a close on ANY attempt. The server answers a key it already recorded with that close (`replayed`)
 * before any check, so these mean this key closed nothing so far; and each is a state the booking never leaves (gone, not
 * a consultation, instant, cancelled, completed or no-show, moved after a no-show), so no attempt still on its way can
 * close it later either. ALREADY_CANCELLED is the one exception the screen checks first: a resend racing its own first
 * attempt may read the booking just cancelled by that attempt, so the closes are read for this key before saying who did it.
 */
export const bookingCloseFinal = (err: unknown) => err instanceof ApiError && (err.status === 409 || err.status === 404)
  && ['BOOKING_NOT_FOUND', 'NOT_A_CONSULTATION', 'USE_INSTANT_ADMIN_CANCEL', 'INSTANT_CONSULT_COMMAND_REQUIRED', 'ALREADY_CANCELLED',
    'BOOKING_NOT_CANCELLABLE', 'NO_SHOW_NOT_REFUNDABLE'].includes(err.code ?? '');
export const isAlreadyCancelled = (err: unknown) => err instanceof ApiError && err.status === 409 && err.code === 'ALREADY_CANCELLED';
/** The unique-index check (503 INDEXES_OUTDATED) runs before anything is written: it settles a sole first attempt. */
export const bookingCloseRefusedBeforeWriting = (err: unknown) => err instanceof ApiError && err.status === 503 && err.code === 'INDEXES_OUTDATED';

/**
 * Where a close's refund goes (`adminCloseHandler`; `settleAssistedFundingIn`): the patient's wallet; for an assisted
 * (pharmacy-booked) booking, back to the pharmacy that paid: to its wallet in the cancel transaction, or, for one paid by
 * card or UPI (`assisted.funding.method: 'razorpay'`), queued back to that card (it is being refunded, not done yet).
 */
export type CloseRefundTarget = 'patient' | 'pharmacy_wallet' | 'pharmacy_card';
export function closeRefundTarget(b: { assisted?: unknown } | null | undefined): CloseRefundTarget {
  const a = b?.assisted as { funding?: { method?: unknown } } | null | undefined;
  if (!a) return 'patient';
  return a.funding?.method === 'razorpay' ? 'pharmacy_card' : 'pharmacy_wallet';
}

/** The refund of a close as the server answered it (`refunded` in rupees). `money` formats rupees (the screen's `formatRupees`). */
export function closeRefundWords(refunded: number, to: CloseRefundTarget, money: (rupees: number) => string): string {
  if (!(refunded > 0)) return 'Nothing was refunded: no money was held for it through Jansetu.';
  if (to === 'pharmacy_card') return `${money(refunded)} is being refunded to the card or UPI the pharmacy paid with.`;
  return to === 'pharmacy_wallet' ? `${money(refunded)} was refunded to the pharmacy that booked it.` : `${money(refunded)} was refunded to the patient’s Jansetu wallet.`;
}

export function bookingCloseApi(c: ApiClient) {
  return {
    /** S5c: close a consultation with a full refund; once per (admin, requestKey); `expectedUpdatedAt` = the version reviewed. */
    close: async (bookingId: string, body: BookingCloseBody): Promise<BookingCloseAnswer> => {
      // `adminCloseSchema.reason`: trimmed, 3 to 500 characters (the same rule as the admin cancel of a moved no-show).
      const reason = body.reason.trim();
      if (reason.length < MIN_ADMIN_CANCEL_REASON || reason.length > MAX_ADMIN_CANCEL_REASON) throw new Error('Invalid reason');
      if (!REQUEST_KEY_PATTERN.test(body.requestKey)) throw new Error('Invalid request key');
      if (body.expectedUpdatedAt !== undefined && Number.isNaN(Date.parse(body.expectedUpdatedAt))) throw new Error('Invalid version');
      const answer = await c.post<BookingCloseAnswer>(`/specialists/admin/bookings/${checkId(bookingId, 'booking')}/close`, {
        body: { reason, requestKey: body.requestKey, ...(body.expectedUpdatedAt !== undefined ? { expectedUpdatedAt: body.expectedUpdatedAt } : {}) },
      });
      // A 200 that is not a recorded close is not proof of one: the request stays unknown (check or resend).
      if (!answer || typeof answer !== 'object' || !answer.close || answer.close.requestKey !== body.requestKey || typeof answer.refunded !== 'number') {
        throw new ApiError(502, 'The server’s answer did not confirm the close.', 'UNEXPECTED_ANSWER');
      }
      return answer;
    },
    /** S5e: the admin closes of a booking, oldest first (reasons included; admins only). */
    closes: (bookingId: string) => c.get<BookingClose[]>(`/specialists/admin/bookings/${checkId(bookingId, 'booking')}/close`),
  };
}

/** The close made with this key, from the booking's closes (exact key; not finding it proves nothing on its own). */
export const closeByKey = (rows: readonly BookingClose[] | null | undefined, requestKey: string) =>
  (Array.isArray(rows) ? rows.find((r) => r && r.requestKey === requestKey) : undefined) ?? null;
