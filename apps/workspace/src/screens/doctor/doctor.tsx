import { useEffect, useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import {
  addDays, appointmentStart, CONSULT_MODE_LABEL, doctorToolsApi, fromYmd, istDateOf, type ConsultMode, type DoctorAppointment, type DoctorToolsApi,
} from '@jansetu/api';
import { Empty, formatRupees } from '@jansetu/ui';
import { useSession, useStaff, type StaffUser } from '../../session.tsx';
import { formatDay } from '../partner/labs.tsx';

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
  return <Empty title="Page not found">This page does not exist or is not available to your account.</Empty>;
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
    const t = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const byStart = (a: DoctorAppointment, b: DoctorAppointment) =>
  (appointmentStart(a)?.getTime() ?? 0) - (appointmentStart(b)?.getTime() ?? 0) || a._id.localeCompare(b._id);

/**
 * Appointments from today (India time) for `days` days, read by month (`view=month`: the whole month, no paging) and
 * kept to that range, oldest first. Shared by Home and Appointments (one cache entry per doctor and month).
 */
export function useUpcomingAppointments(d: DoctorContext, days: number) {
  const today = istDateOf(new Date());
  const last = addDays(today, days - 1);
  const months = [...new Set([today.slice(0, 7), last.slice(0, 7)])];
  const qs = useQueries({
    queries: months.map((m) => ({ queryKey: [...appointmentsKey(d), 'month', m], queryFn: () => d.api.appointmentsIn(m) })),
  });
  const error = qs.find((q) => q.isError)?.error ?? null;
  const pending = qs.some((q) => q.isPending);
  const from = today.replace(/-/g, '');
  const to = last.replace(/-/g, '');
  const items = pending || error ? [] : qs.flatMap((q) => q.data ?? []).filter((b) => b.bookingDate >= from && b.bookingDate <= to).sort(byStart);
  return { items, pending, error, today, refetch: () => Promise.all(qs.map((q) => q.refetch())) };
}

export const sortAppointments = (list: readonly DoctorAppointment[]) => [...list].sort(byStart);
