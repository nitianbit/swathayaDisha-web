import type { CustomerLabBooking as LabBooking, CustomerLabBookingStatus as LabBookingStatus, CustomerVisitMode as VisitMode } from '@jansetu/api';
import { statusOf, type StatusWords } from '../../common.tsx';
import { t } from '../../i18n/index.ts';

export const LAB_STATUS: Readonly<Record<LabBookingStatus, StatusWords>> = {
  pending_payment: { key: 'status.awaitingPayment', tone: 'warn' },
  confirmed: { key: 'status.confirmed', tone: 'ok' },
  sample_collected: { key: 'status.sampleCollected', tone: 'ok' },
  visited: { key: 'status.visited', tone: 'ok' },
  processing: { key: 'status.beingTested' },
  report_ready: { key: 'status.reportReady', tone: 'ok' },
  completed: { key: 'status.completed' },
  cancelled: { key: 'status.cancelled', tone: 'danger' },
  no_show: { key: 'status.notPresent', tone: 'danger' },
};

export const labStatusOf = (b: Pick<LabBooking, 'status' | 'cancellation'>) =>
  b.status === 'cancelled' && b.cancellation?.reason === 'timeout' ? { label: t('status.expired'), tone: 'danger' as const }
    : statusOf(LAB_STATUS, b.status);

const VISIT_MODE = { home: 'visitMode.home', lab: 'visitMode.lab' } as const satisfies Record<VisitMode, string>;
/** "Home collection" / "Visit the lab". */
export const visitModeLabel = (mode: VisitMode) => t(VISIT_MODE[mode]);

export const labTitle = (b: Pick<LabBooking, 'items'>) => b.items.map((i) => i.name).join(', ') || t('lab.titleFallback');

/** "HH:mm" (IST wall clock from the backend) → "9:30 am". */
export function clock(hhmm: string): string {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? 'am' : 'pm'}`;
}
