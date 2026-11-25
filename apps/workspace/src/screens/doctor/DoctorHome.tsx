import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { appointmentStart, CONSULT_MODE_LABEL, doctorStanding } from '@jansetu/api';
import { Alert, Badge, ErrorState, Loading } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { appointmentLabel } from './AppointmentsScreen.tsx';
import { offersKey, RefreshFailed, rupeesOf, useDoctor, useDoctorProfile, useUpcomingAppointments, useTicker, type DoctorContext } from './doctor.tsx';
import { useDoctorPresence } from './presence.tsx';
import { t } from '../../i18n/doctor/index.ts';

/** Home for a doctor: standing with Jansetu, "available now", open offers and the next appointments. */
export function DoctorHome() {
  const d = useDoctor();
  if (!d) return null;
  return <Status key={d.identity} d={d} />;
}

function Status({ d }: { d: DoctorContext }) {
  const profile = useDoctorProfile(d);
  const presence = useDoctorPresence();
  const offers = useQuery({ queryKey: offersKey(d), queryFn: () => d.api.offers(), refetchInterval: 30_000 });
  const next = useUpcomingAppointments(d, 14);
  const now = useTicker(60_000);
  const standing = profile.data ? doctorStanding(profile.data) : null;
  const coming = next.items.filter((b) => (b.status === 'confirmed' || b.status === 'pending') && (appointmentStart(b)?.getTime() ?? 0) >= now.getTime() - 30 * 60_000).slice(0, 3);
  return (
    <section className="ws-section" aria-labelledby="status-h">
      <h2 id="status-h">{t('doctorHome.yourStatus')}</h2>
      {profile.isError && <ErrorState message={messageOf(profile.error)} onRetry={() => void profile.refetch()} />}
      {standing === 'inactive' && <Alert>{t('doctorHome.yourDoctorAccountIsNot')}</Alert>}
      {standing === 'unverified' && <Alert tone="warn">{t('doctorHome.yourProfileIsWaitingFor')}</Alert>}
      <dl className="ws-dl">
        <dt>{t('common.verification')}</dt>
        <dd>{profile.isPending ? '…' : standing === 'active' ? <Badge tone="ok">{t('common.verified')}</Badge> : standing === 'inactive' ? <Badge tone="danger">{t('doctorHome.notActive')}</Badge> : <Badge tone="warn">{t('common.waitingForVerification')}</Badge>}</dd>
        <dt>{t('common.availableNow')}</dt>
        <dd>
          {presence.presence?.available
            ? <>{presence.live ? <Badge tone="ok">{t('common.on')}</Badge> : <Badge tone="warn">{t('common.onNotCheckedIn')}</Badge>} {presence.presence.modes.map((m) => CONSULT_MODE_LABEL[m]).join(', ')} · {rupeesOf(presence.presence.instantFeeMinor)}</>
            : presence.presence ? <Badge>{t('common.off')}</Badge> : presence.unconfirmed ? <Badge tone="warn">{t('common.notConfirmed')}</Badge>
            : presence.loading ? '…' : <Badge tone="warn">{t('doctorHome.couldNotBeRead')}</Badge>}
          {' '}<Link to="/doctor/consult-now">{t('common.consultNow')}</Link>
        </dd>
        <dt>{t('doctorHome.offersWaiting')}</dt>
        <dd>{offers.isPending ? '…' : offers.isError ? messageOf(offers.error) : offers.data.length === 0 ? t('doctorHome.none') : <Link to="/doctor/consult-now">{t('doctorHome.openOffers', { count: offers.data.length })}</Link>}</dd>
      </dl>
      <h3>{t('doctorHome.nextAppointments')}</h3>
      {next.refreshError && <RefreshFailed error={next.refreshError} readAt={next.readAt} onRetry={next.refetch} />}
      {next.pending ? <Loading label={t('common.loadingAppointments')} />
        : next.error ? <ErrorState message={messageOf(next.error)} onRetry={() => void next.refetch()} />
        : coming.length === 0 ? <p className="ws-muted">{t('doctorHome.noAppointmentsInTheNext')}</p>
        : (
          <ul className="ws-list" aria-label={t('doctorHome.nextAppointments')}>
            {coming.map((b) => (
              <li key={b._id}>{appointmentLabel(b)} · {b.consultationMode ? CONSULT_MODE_LABEL[b.consultationMode] : t('doctorHome.consultation')}{b.bookingKind === 'instant' ? ` ${t('doctorHome.instantTag')}` : ''}{b.status === 'pending' ? ` · ${t('doctorHome.waiting')}` : ''}</li>
            ))}
          </ul>
        )}
      <p><Link to="/doctor/appointments">{t('doctorHome.allAppointments')}</Link></p>
    </section>
  );
}
