import { waitingState, type InstantRequest, type InstantStatus } from '@jansetu/api';

export const INSTANT_STATUS: Record<InstantStatus, { label: string; tone?: 'ok' | 'warn' | 'danger' }> = {
  pending_payment: { label: 'Awaiting payment', tone: 'warn' },
  offered: { label: 'Waiting for a doctor', tone: 'warn' },
  accepted: { label: 'Doctor accepted', tone: 'ok' },
  refunded: { label: 'Refunded' },
  expired_unpaid: { label: 'Expired', tone: 'danger' },
};

export function instantStatusOf(r: Pick<InstantRequest, 'status' | 'fundingState' | 'offerExpiresAt'>, now = Date.now()) {
  if (r.status === 'offered' && waitingState(r, now) === 'offer_expired') return { label: 'Nobody accepted yet', tone: 'warn' as const };
  return INSTANT_STATUS[r.status] ?? { label: String(r.status).replace(/_/g, ' ') };
}
