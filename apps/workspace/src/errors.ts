import { ApiError } from '@jansetu/api';

/** One sentence a staff member can act on. Server messages are shown as given: they are written for people. */
export function messageOf(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return err.message || 'Your account is not allowed to do this.';
    // Q15 review: a keyed create or save before the database update has run (503). Kept unconfirmed: send it again later.
    if (err.code === 'INDEXES_OUTDATED') return `${err.message.replace(/\.$/, '')}: ask the Jansetu team`;
    return err.message;
  }
  return 'Something went wrong. Please try again.';
}
