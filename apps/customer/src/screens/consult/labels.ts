import { waitingState, type InstantRequest, type InstantStatus } from '@jansetu/api';
import { statusOf, type StatusWords } from '../../common.tsx';
import { t } from '../../i18n/index.ts';

export const INSTANT_STATUS: Readonly<Record<InstantStatus, StatusWords>> = {
  pending_payment: { key: 'status.awaitingPayment', tone: 'warn' },
  offered: { key: 'status.waitingForDoctor', tone: 'warn' },
  accepted: { key: 'status.doctorAccepted', tone: 'ok' },
  refunded: { key: 'status.refunded' },
  expired_unpaid: { key: 'status.expired', tone: 'danger' },
};

export function instantStatusOf(r: Pick<InstantRequest, 'status' | 'fundingState' | 'offerExpiresAt'>, now = Date.now()) {
  if (r.status === 'offered' && waitingState(r, now) === 'offer_expired') return { label: t('status.nobodyAccepted'), tone: 'warn' as const };
  return statusOf(INSTANT_STATUS, r.status);
}
