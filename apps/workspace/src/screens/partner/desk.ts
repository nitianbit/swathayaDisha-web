import { canonicalMobile, type ClinicAppointment, type DeskBookingInput } from '@jansetu/api';
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

/**
 * Appointments in a day list that look like this booking: made at the desk, same slot, same patient mobile, not
 * cancelled. A hint only (the list carries no request key); resending the same request is what proves it.
 */
export function lookalikes(rows: readonly ClinicAppointment[], req: Pick<DeskBookingInput, 'slotId' | 'customer'>): ClinicAppointment[] {
  const phone = canonicalMobile(req.customer.phone);
  return rows.filter((r) => r.source === 'desk' && r.slotId === req.slotId && r.status !== 'cancelled'
    && !!phone && canonicalMobile(r.patient?.phone ?? '') === phone);
}
