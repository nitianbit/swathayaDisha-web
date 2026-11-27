import { useQuery } from '@tanstack/react-query';
import { Ban, Clock, Stethoscope } from 'lucide-react';
import { appointmentAt, holdsAny, istToday, type ClinicAppointment, type DoctorBusy } from '@jansetu/api';
import { Loading } from '@jansetu/ui';
import { t } from '../../i18n/home/index.ts';
import { istTime, useClinicApi, useDoctorList } from '../partner/clinic.tsx';
import { usePartnerScope, type ScopeContext } from '../partner/scope.tsx';
import { Failed } from './home.tsx';

/**
 * WQ57 (P3): a clinic reception's doctors today: each doctor with their next appointments and, in grey, when they are busy
 * elsewhere (r40 `busy`: the time only, never the patient or the place). For members who read the clinic's day.
 */
export function DoctorsToday({ forbidden }: { forbidden: string | null }) {
  const ctx = usePartnerScope();
  if (!ctx || !holdsAny(ctx.actor, ['bookings.view', 'bookings.manage'])) return null;
  return <Strip ctx={ctx} forbidden={forbidden} />;
}

type Entry = { at: number; key: string; text: string; busy: boolean };
const UPCOMING = 3;

function Strip({ ctx, forbidden }: { ctx: ScopeContext; forbidden: string | null }) {
  const clinic = useClinicApi(ctx);
  const doctors = useDoctorList(ctx, clinic);
  const day = istToday();
  const q = useQuery({ queryKey: [...ctx.key, 'clinic-day', day], queryFn: () => clinic.dayView({ from: day, to: day }), staleTime: 0, refetchOnMount: 'always' });
  const now = Date.now();
  // WQ57b: the next appointments by time (sorted first, then the first few), each time read from its date and time.
  const entriesOf = (doctorId: string, appts: readonly ClinicAppointment[], busy: readonly DoctorBusy[]): Entry[] => [
    ...appts.filter((a) => a.doctorId === doctorId && (a.status === 'confirmed' || a.status === 'pending')).flatMap((a) => {
      const at = appointmentAt(a)?.getTime();
      return at !== undefined && at >= now - 30 * 60_000 ? [{ at, key: a.bookingId, text: `${istTime(new Date(at))} ${a.patient?.name ?? t('doctors.patient')}`, busy: false }] : [];
    }).sort((x, y) => x.at - y.at).slice(0, UPCOMING),
    ...busy.filter((b) => b.doctorId === doctorId && Date.parse(b.to) > now)
      .map((b) => ({ at: Date.parse(b.from), key: `busy:${b.from}`, text: t('doctors.busy', { from: istTime(b.from), to: istTime(b.to) }), busy: true })),
  ].sort((x, y) => x.at - y.at);
  return (
    <section className="ws-section" aria-labelledby="dt-h">
      <h2 id="dt-h">{t('doctors.title')}</h2>
      {!doctors.data || !q.data ? ((doctors.isError || q.isError)
        ? <Failed error={doctors.error ?? q.error} forbidden={forbidden} onRetry={() => { void doctors.refetch(); void q.refetch(); }} /> : <Loading />)
        : doctors.data.length === 0 ? <p className="ws-muted">{t('doctors.none')}</p>
        : (
          <ul className="doctors-today">
            {doctors.data.map((d) => {
              const entries = entriesOf(d.doctorId, q.data.appointments, q.data.busy);
              return (
                <li key={d.doctorId}>
                  <strong className="doctor-name"><Stethoscope size={20} aria-hidden="true" />{d.name}</strong>
                  {entries.length === 0 ? <span className="ws-muted">{t('doctors.free')}</span> : (
                    <ul aria-label={t('doctors.of', { doctor: d.name })}>
                      {/* WQ60: an appointment (a clock) and a busy time (a no-entry sign, grey) differ by icon, not by colour alone. */}
                      {entries.map((e) => <li key={e.key} className={e.busy ? 'doctor-busy' : undefined}>{e.busy ? <Ban size={16} aria-hidden="true" /> : <Clock size={16} aria-hidden="true" />}{e.text}</li>)}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
    </section>
  );
}
