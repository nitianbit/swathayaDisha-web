import { ApiError, CLINIC_DOCTOR_NOT_VERIFIED_MESSAGE, isClinicDoctorNotVerified, messageOf as wordsOf } from '@jansetu/api';
import { t } from './i18n/shell/index.ts';

/**
 * One sentence a staff member can act on: the workspace's own cases first, then the shared `messageOf` of
 * `@jansetu/api` (the code's words, else the server's message as given: it is written for people).
 */
export function messageOf(err: unknown): string {
  if (err instanceof ApiError) {
    // WQ15 (r9): partner verify, select or any partner call for a member whose doctor is not verified and active.
    if (isClinicDoctorNotVerified(err)) return CLINIC_DOCTOR_NOT_VERIFIED_MESSAGE;
    // Q15 review: a keyed create or save before the database update has run (503). Kept unconfirmed: send it again later.
    if (err.code === 'INDEXES_OUTDATED') return t('errors.indexesOutdated', { message: err.message.replace(/\.$/, '') });
  }
  return wordsOf(err);
}
