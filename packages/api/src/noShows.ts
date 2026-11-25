import { ApiError } from './client.ts';
import { t } from './i18n/doctor/index.ts';
import { wordMap } from './i18n/words.ts';

/**
 * Q14 (owner, 18 Nov 2026): a no-show is not refunded and earns nobody anything. It may be moved ONCE to a later slot
 * (same price, no payment, no refund) by the lab (`bookings.manage`), the doctor, the clinic desk or an admin — never by
 * the customer; instant consultations are never moved. A second no-show is final. Mirrored from the Q14 backend
 * (`m0/q14-owner-decisions` 0a458a7): `bookings/holds.ts rescheduleWithHolds` (`noShow`), `services/labBookings.ts
 * rescheduleNoShow`, `services/clinic.ts rescheduleDeskNoShow`, `bookings/services rescheduleNoShow`.
 *
 * Every route takes `{ slotId, requestKey, <version fence> }`: the same key with the same slot answers the move already
 * made (`replayed`), another slot under it is 409 IDEMPOTENCY_KEY_REUSED; a booking already moved once is 409
 * NO_SHOW_RESCHEDULE_USED (whatever key), so a lost answer can never move a booking twice.
 */

/** `NO_SHOW_RESCHEDULE_USED`: this booking was already moved once after a no-show (by anyone); a second no-show is final. */
export const isNoShowMoveUsed = (err: unknown) => err instanceof ApiError && err.status === 409 && err.code === 'NO_SHOW_RESCHEDULE_USED';

/** The fields every moved booking carries (`noShows[]`, at most one entry, and the count). */
export interface NoShowHistory { noShows?: readonly unknown[] | null; noShowReschedules?: number | null }

/** Whether the one move after a no-show has been used (the server counts both; either one is enough). */
export const noShowMovedOnce = (b: NoShowHistory) => (b.noShowReschedules ?? 0) >= 1 || (b.noShows?.length ?? 0) >= 1;

/**
 * The words for the server's refusals of a no-show move (the server's own message is the fallback). `SAME_SLOT`,
 * `SLOT_STARTED`, `SLOT_NOT_AVAILABLE`, `SLOT_UNAVAILABLE` and `SLOT_NOT_THIS_DOCTOR` mean: choose another time.
 */
export const NO_SHOW_MOVE_REFUSAL: Record<string, string> = wordMap(t, {
  NO_SHOW_RESCHEDULE_USED: 'noShow.refusal.NO_SHOW_RESCHEDULE_USED',
  BOOKING_NOT_NO_SHOW: 'noShow.refusal.BOOKING_NOT_NO_SHOW',
  SAME_SLOT: 'noShow.refusal.SAME_SLOT',
  SLOT_STARTED: 'noShow.refusal.SLOT_STARTED',
  SLOT_NOT_AVAILABLE: 'noShow.refusal.SLOT_NOT_AVAILABLE',
  // WQ11b: the lab move's code (`partners/services/slots.ts takeSeat`: closed, full, started or a holiday).
  SLOT_UNAVAILABLE: 'noShow.refusal.SLOT_NOT_AVAILABLE',
  // Q15 (`rescheduleWithHolds`): every move stays with the booking's doctor.
  SLOT_NOT_THIS_DOCTOR: 'noShow.refusal.SLOT_NOT_THIS_DOCTOR',
  IDEMPOTENCY_KEY_REUSED: 'noShow.refusal.IDEMPOTENCY_KEY_REUSED',
  // Q14 review (`rescheduleWithHolds`): a desk appointment is moved by its clinic only.
  CLINIC_APPOINTMENT: 'noShow.refusal.CLINIC_APPOINTMENT',
  // WQ11c: a slot that does not take the booking's consultation type (`assertSlotMode`, named so by `noShowModeRefusal`).
  SLOT_MODE_NOT_OFFERED: 'noShow.refusal.SLOT_MODE_NOT_OFFERED',
});

/**
 * A move refused because of the chosen time (the person picks another; the booking itself is unchanged). The doctor,
 * desk and admin moves answer `SLOT_NOT_AVAILABLE` (`bookings/holds.ts`); the lab move answers `SLOT_UNAVAILABLE`
 * (`partners/services/slots.ts takeSeat`), so both are accepted.
 */
export const SLOT_REFUSAL_CODES = [
  'SAME_SLOT',
  'SLOT_STARTED',
  'SLOT_NOT_AVAILABLE',
  'SLOT_UNAVAILABLE',
  'SLOT_NOT_THIS_DOCTOR',
  'SLOT_MODE_NOT_OFFERED',
] as const;
export const isSlotRefusal = (err: unknown) =>
  err instanceof ApiError && !!err.code && (SLOT_REFUSAL_CODES as readonly string[]).includes(err.code);
