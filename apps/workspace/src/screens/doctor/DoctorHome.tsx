import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { appointmentStart, CONSULT_MODE_LABEL, doctorStanding } from '@jansetu/api';
import { Alert, Badge, ErrorState, Loading } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { appointmentLabel } from './AppointmentsScreen.tsx';
import { offersKey, rupeesOf, useDoctor, useDoctorProfile, useUpcomingAppointments, useTicker, type DoctorContext } from './doctor.tsx';
import { useDoctorPresence } from './presence.tsx';

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
      <h2 id="status-h">Your status</h2>
      {profile.isError && <ErrorState message={messageOf(profile.error)} onRetry={() => void profile.refetch()} />}
      {standing === 'inactive' && <Alert>Your doctor account is not active. Patients cannot book you. Contact Jansetu.</Alert>}
      {standing === 'unverified' && <Alert tone="warn">Your profile is waiting for verification by Jansetu. Until then patients cannot book you and you cannot take instant consultations.</Alert>}
      <dl className="ws-dl">
        <dt>Verification</dt>
        <dd>{profile.isPending ? '…' : standing === 'active' ? <Badge tone="ok">Verified</Badge> : standing === 'inactive' ? <Badge tone="danger">Not active</Badge> : <Badge tone="warn">Waiting for verification</Badge>}</dd>
        <dt>Available now</dt>
        <dd>
          {presence.presence?.available
            ? <>{presence.live ? <Badge tone="ok">On</Badge> : <Badge tone="warn">On, not checked in</Badge>} {presence.presence.modes.map((m) => CONSULT_MODE_LABEL[m]).join(', ')} · {rupeesOf(presence.presence.instantFeeMinor)}</>
            : presence.presence ? <Badge>Off</Badge> : presence.unconfirmed ? <Badge tone="warn">Not confirmed</Badge>
            : presence.loading ? '…' : <Badge tone="warn">Could not be read</Badge>}
          {' '}<Link to="/doctor/consult-now">Consult now</Link>
        </dd>
        <dt>Offers waiting</dt>
        <dd>{offers.isPending ? '…' : offers.isError ? messageOf(offers.error) : offers.data.length === 0 ? 'None' : <Link to="/doctor/consult-now">{offers.data.length} open {offers.data.length === 1 ? 'offer' : 'offers'}</Link>}</dd>
      </dl>
      <h3>Next appointments</h3>
      {next.pending ? <Loading label="Loading appointments…" />
        : next.error ? <ErrorState message={messageOf(next.error)} onRetry={() => void next.refetch()} />
        : coming.length === 0 ? <p className="ws-muted">No appointments in the next two weeks.</p>
        : (
          <ul className="ws-list" aria-label="Next appointments">
            {coming.map((b) => (
              <li key={b._id}>{appointmentLabel(b)} · {b.consultationMode ? CONSULT_MODE_LABEL[b.consultationMode] : 'Consultation'}{b.bookingKind === 'instant' ? ' (instant)' : ''}{b.status === 'pending' ? ' · waiting' : ''}</li>
            ))}
          </ul>
        )}
      <p><Link to="/doctor/appointments">All appointments</Link></p>
    </section>
  );
}
