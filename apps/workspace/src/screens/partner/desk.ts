import type { DeskBookingInput } from '@jansetu/api';
import type { PendingOp } from '../../requests.ts';

/**
 * A desk booking whose outcome may be unknown: the exact request (with its key) plus what the page shows about it. Kept
 * in session memory only (the reload marker holds just the key and attempt times, never the patient's details).
 */
export interface DeskPendingBody {
  request: DeskBookingInput;
  /** For the screen: the doctor, branch and time chosen (no lookup needed to describe it). */
  shown: { doctorName: string; branchName: string; branchId: string; doctorId: string; day: string; time: string };
}
export type DeskPending = PendingOp<DeskPendingBody>;

/** Session-memory slot of the unconfirmed desk booking of one workspace (one at a time per partner). */
export const deskBookingSlot = (identity: string) => `clinic-desk:book:${identity}`;
