import { ApiError } from './client.ts';

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
 * `SLOT_STARTED`, `SLOT_NOT_AVAILABLE` and `SLOT_NOT_THIS_DOCTOR` mean: choose another time.
 */
export const NO_SHOW_MOVE_REFUSAL: Record<string, string> = {
  NO_SHOW_RESCHEDULE_USED: 'This booking was already moved once after a no-show. A second no-show is final, so it cannot be moved again.',
  BOOKING_NOT_NO_SHOW: 'This booking is no longer a no-show, so there is nothing to move.',
  SAME_SLOT: 'That is the time that was missed. Pick a later time.',
  SLOT_STARTED: 'That time has already started. Pick a later time.',
  SLOT_NOT_AVAILABLE: 'That time is no longer free. Pick another time.',
  // Q15 (`rescheduleWithHolds`): every move stays with the booking's doctor.
  SLOT_NOT_THIS_DOCTOR: 'That time belongs to another doctor. Pick one of this doctor’s times.',
  IDEMPOTENCY_KEY_REUSED: 'This request was already used for a different time. Reload the page and start again.',
  // Q14 review (`rescheduleWithHolds`): a desk appointment is moved by its clinic only.
  CLINIC_APPOINTMENT: 'The clinic can move this appointment: it was booked at its front desk.',
  // WQ11c: a slot that does not take the booking's consultation type (`assertSlotMode`, named so by `noShowModeRefusal`).
  SLOT_MODE_NOT_OFFERED: 'That time is not offered for this consultation type. Pick another time.',
};

/** A move refused because of the chosen time (the person picks another; the booking itself is unchanged). */
export const isSlotRefusal = (err: unknown) =>
  err instanceof ApiError && !!err.code && ['SAME_SLOT', 'SLOT_STARTED', 'SLOT_NOT_AVAILABLE', 'SLOT_NOT_THIS_DOCTOR', 'SLOT_MODE_NOT_OFFERED'].includes(err.code);
