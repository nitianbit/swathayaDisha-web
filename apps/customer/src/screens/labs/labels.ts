import type { LabBooking, LabBookingStatus, VisitMode } from '@jansetu/api';

export const LAB_STATUS: Record<LabBookingStatus, { label: string; tone?: 'ok' | 'warn' | 'danger' }> = {
  pending_payment: { label: 'Awaiting payment', tone: 'warn' },
  confirmed: { label: 'Confirmed', tone: 'ok' },
  sample_collected: { label: 'Sample collected', tone: 'ok' },
  visited: { label: 'Visited', tone: 'ok' },
  processing: { label: 'Being tested' },
  report_ready: { label: 'Report ready', tone: 'ok' },
  completed: { label: 'Completed' },
  cancelled: { label: 'Cancelled', tone: 'danger' },
  no_show: { label: 'Not present', tone: 'danger' },
};

export const labStatusOf = (b: Pick<LabBooking, 'status' | 'cancellation'>) =>
  b.status === 'cancelled' && b.cancellation?.reason === 'timeout' ? { label: 'Expired', tone: 'danger' as const }
    : LAB_STATUS[b.status] ?? { label: String(b.status).replace(/_/g, ' ') };

export const VISIT_MODE_LABEL: Record<VisitMode, string> = { home: 'Home collection', lab: 'Visit the lab' };

export const labTitle = (b: Pick<LabBooking, 'items'>) => b.items.map((i) => i.name).join(', ') || 'Lab test';

/** "HH:mm" (IST wall clock from the backend) → "9:30 am". */
export function clock(hhmm: string): string {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? 'am' : 'pm'}`;
}
