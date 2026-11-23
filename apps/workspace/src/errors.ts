import { ApiError, CLINIC_DOCTOR_NOT_VERIFIED_MESSAGE, isClinicDoctorNotVerified } from '@jansetu/api';

/** One sentence a staff member can act on. Server messages are shown as given: they are written for people. */
export function messageOf(err: unknown): string {
  if (err instanceof ApiError) {
    // WQ15 (r9): partner verify, select or any partner call for a member whose doctor is not verified and active.
    if (isClinicDoctorNotVerified(err)) return CLINIC_DOCTOR_NOT_VERIFIED_MESSAGE;
    if (err.status === 403) return err.message || 'Your account is not allowed to do this.';
    // Q15 review: a keyed create or save before the database update has run (503). Kept unconfirmed: send it again later.
    if (err.code === 'INDEXES_OUTDATED') return `${err.message.replace(/\.$/, '')}: ask the Jansetu team`;
    return err.message;
  }
  return 'Something went wrong. Please try again.';
}
