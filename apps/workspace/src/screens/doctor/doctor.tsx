import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import {
  addDays, appointmentStart, CONSULT_MODE_LABEL, doctorToolsApi, fromYmd, istDateOf, meetingLinkState, type ConsultMode, type DoctorAppointment, type DoctorToolsApi,
} from '@jansetu/api';
import { formatClock } from '@jansetu/i18n';
import { Button, Empty, formatRupees, shared } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { useSession, useStaff, type StaffUser } from '../../session.tsx';
import { formatDay } from '../partner/labs.tsx';
import { t } from '../../i18n/doctor/index.ts';

/**
 * Everything a doctor page needs: the API, a query-key prefix and a subtree identity bound to the signed-in doctor.
 * Pages render their content under `key={identity}`, so nothing typed or confirmed for one doctor can survive into
 * another doctor's session, and every cached answer is stored under the doctor it was read for.
 */
export interface DoctorContext {
  api: DoctorToolsApi;
  key: readonly string[];
  identity: string;
  user: StaffUser;
}

export function useDoctor(): DoctorContext | null {
  const { api } = useSession();
  const user = useStaff();
  const doctor = useMemo(() => doctorToolsApi(api), [api]);
  if (user.role !== 'specialist') return null;
  return { api: doctor, key: ['doctor', user.id], identity: `doctor:${user.id}`, user };
}

export function NotADoctor() {
  return <Empty title={t('doctor.pageNotFound')}>{t('doctor.thisPageDoesNotExist')}</Empty>;
}

export const useDoctorProfile = (d: DoctorContext) => useQuery({ queryKey: [...d.key, 'profile'], queryFn: () => d.api.profile() });
export const useClinics = (d: DoctorContext) => useQuery({ queryKey: [...d.key, 'clinics'], queryFn: () => d.api.clinics() });
export const offersKey = (d: DoctorContext) => [...d.key, 'offers'];
export const appointmentsKey = (d: DoctorContext) => [...d.key, 'appointments'];

/** Integer paise as rupees in Indian grouping (₹1,234.50). */
export const rupeesOf = (minor: number | null | undefined) => formatRupees(typeof minor === 'number' ? minor / 100 : null);

/** A `YYYYMMDD` India date as "Tue, 17 Nov 2026". */
export const formatYmd = (ymd: string) => { const iso = fromYmd(ymd); return iso ? formatDay(iso) : ymd; };

export const modesLabel = (modes: readonly ConsultMode[]) => modes.map((m) => CONSULT_MODE_LABEL[m] ?? m).join(', ');

/** The current time, moving every `ms` (countdowns, "has it started"). */
export function useTicker(ms: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

const byStart = (a: DoctorAppointment, b: DoctorAppointment) =>
  (appointmentStart(a)?.getTime() ?? 0) - (appointmentStart(b)?.getTime() ?? 0) || a._id.localeCompare(b._id);

// ── Call links ──

/** While an instant consultation's call link is being prepared, its list is read again this often… */
export const MEET_POLL_MS = 5_000;
/** …for at most this long per consultation (then a Refresh button starts another round). */
export const MEET_POLL_FOR_MS = 2 * 60_000;

/**
 * Bounded reading-again while instant consultations wait for their call link (it is made after the accept commits, so
 * a just-accepted or recovered booking often has none yet). Use `interval` as a query's `refetchInterval` (react-query
 * pauses it while the page is hidden); `restart` gives one consultation another round after a manual refresh.
 */
export function useMeetPoll() {
  const since = useRef(new Map<string, number>());
  const interval = useCallback((list: readonly DoctorAppointment[] | undefined): number | false => {
    const now = Date.now();
    let poll = false;
    for (const b of list ?? []) {
      if (b.bookingKind !== 'instant' || meetingLinkState(b) !== 'preparing') continue;
      if (!since.current.has(b._id)) since.current.set(b._id, now);
      if (now - since.current.get(b._id)! < MEET_POLL_FOR_MS) poll = true;
    }
    return poll ? MEET_POLL_MS : false;
  }, []);
  const gaveUp = useCallback((id: string, now: Date) => {
    const at = since.current.get(id);
    return at !== undefined && now.getTime() - at >= MEET_POLL_FOR_MS;
  }, []);
  const restart = useCallback((id: string) => { since.current.delete(id); }, []);
  return { interval, gaveUp, restart };
}

/** The call link of a consultation, or why there is none yet, with a Refresh button while it is missing. */
export function MeetLink({ b, onRefresh, gaveUp = false }: { b: DoctorAppointment; onRefresh?: () => Promise<unknown>; gaveUp?: boolean }) {
  const [busy, setBusy] = useState(false);
  const state = meetingLinkState(b);
  if (state === 'none') return null;
  if (state === 'ready') return <a href={b.virtualMeeting!.joinUrl} target="_blank" rel="noreferrer noopener">{t('doctor.joinTheCall')}</a>;
  const refresh = onRefresh && (
    <Button variant="secondary" busy={busy} onClick={() => { setBusy(true); void onRefresh().finally(() => setBusy(false)); }}>{shared('action.refresh')}</Button>
  );
  return (
    <div className="doc-meet">
      <span role="status">
        {state === 'failed'
          ? t('doctor.theCallLinkCouldNot', { value: b.virtualMeeting?.error ? ` (${b.virtualMeeting.error})` : '' })
          : gaveUp ? t('doctor.theCallLinkHasNot')
          : t('doctor.theCallLinkIsBeing')}
      </span>
      {refresh}
    </div>
  );
}

/**
 * Appointments from today (India time) for `days` days, read by month (`view=month`: the whole month, no paging) and
 * kept to that range, oldest first. Shared by Home and Appointments (one cache entry per doctor and month).
 */
export function useUpcomingAppointments(d: DoctorContext, days: number, refetchInterval?: (list: DoctorAppointment[] | undefined) => number | false) {
  const today = istDateOf(new Date());
  const last = addDays(today, days - 1);
  const months = [...new Set([today.slice(0, 7), last.slice(0, 7)])];
  const qs = useQueries({
    queries: months.map((m) => ({
      queryKey: [...appointmentsKey(d), 'month', m], queryFn: () => d.api.appointmentsIn(m),
      ...(refetchInterval ? { refetchInterval: (q: { state: { data?: DoctorAppointment[] } }) => refetchInterval(q.state.data) } : {}),
    })),
  });
  // WQ11c: a failed read again keeps the list already read (shown with a quiet note); only a first read that failed is an error.
  const error = qs.find((q) => q.isError && q.data === undefined)?.error ?? null;
  const refreshError = qs.find((q) => q.isError && q.data !== undefined)?.error ?? null;
  const pending = qs.some((q) => q.isPending);
  const from = today.replace(/-/g, '');
  const to = last.replace(/-/g, '');
  const items = pending || error ? [] : qs.flatMap((q) => q.data ?? []).filter((b) => b.bookingDate >= from && b.bookingDate <= to).sort(byStart);
  // When every month was last read, and whether one is being read again (Q14: decides a stored no-show move).
  const readAt = Math.min(...qs.map((q) => q.dataUpdatedAt));
  const fetching = qs.some((q) => q.isFetching);
  return { items, pending, error, refreshError, today, readAt, fetching, refetch: () => Promise.all(qs.map((q) => q.refetch())) };
}

/** HH:MM, India time. */
const clock = formatClock;

/**
 * WQ11c: a list read again in the background failed, but an earlier read is on screen: the list stays, with this quiet
 * note (when it was read, and a way to try again) instead of an error page.
 */
export function RefreshFailed({ error, readAt, onRetry }: { error: unknown; readAt: number; onRetry: () => unknown }) {
  return (
    <p className="ws-muted" role="status">{t('doctor.couldNotRefreshJustNow')}{messageOf(error)}).{readAt > 0 ? ` ${t('doctor.showingWhatWasReadAt', { when: clock(readAt) })}` : ''}{' '}
      <Button variant="ghost" onClick={() => void onRetry()}>{shared('action.tryAgain')}</Button>
    </p>
  );
}

export const sortAppointments = (list: readonly DoctorAppointment[]) => [...list].sort(byStart);
