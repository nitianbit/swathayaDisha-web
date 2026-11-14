import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { customerApi, type ExternalBooking } from '@jansetu/api';
import { Badge, Button, Empty, ErrorState, formatRupees, Loading } from '@jansetu/ui';
import { BOOKING_STATUS, formatAppointment, messageOf, PageHeading } from '../common.tsx';
import { useSession } from '../session.tsx';

const STEP = 20;
const MAX = 100; // the backend's page-size limit

const BOOKING_TYPE: Record<string, string> = {
  package: 'Health package', consultation: 'Doctor consultation', 'second-opinion': 'Second opinion', surgery: 'Surgery',
};

export function BookingsScreen() {
  return (
    <>
      <PageHeading title="My bookings" />
      <OrdinaryBookings />
      <ProviderBookings />
    </>
  );
}

function OrdinaryBookings() {
  const { api } = useSession();
  const [limit, setLimit] = useState(STEP);
  const q = useQuery({ queryKey: ['bookings', limit], queryFn: () => customerApi(api).bookings(1, limit), placeholderData: (p) => p });
  return (
    <section aria-labelledby="ord-h" className="stack">
      <h2 id="ord-h">Doctors and health packages</h2>
      {q.isPending ? <Loading /> : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : q.data.items.length === 0 ? <Empty title="No bookings yet" />
        : (
          <>
            <ul className="list">
              {q.data.items.map((b) => (
                <li key={b._id}>
                  <Link to={`/bookings/${b._id}`} className="list-row link-row">
                    <strong>{b.doctorName ?? b.packageName ?? BOOKING_TYPE[b.bookingType] ?? 'Booking'}</strong>
                    <span className="muted">{formatAppointment(b.bookingDate, b.bookingTime)}</span>
                    <span><StatusBadge status={b.status} /> {b.price != null && <span className="muted">{formatRupees(b.price)}</span>}</span>
                  </Link>
                </li>
              ))}
            </ul>
            {q.data.total > q.data.items.length && limit < MAX && (
              <Button variant="secondary" busy={q.isFetching} onClick={() => setLimit((l) => Math.min(MAX, l + STEP))}>Show more</Button>
            )}
          </>
        )}
    </section>
  );
}

/** Lab tests and provider visits come from two providers; the backend lists one provider per request. */
function ProviderBookings() {
  const { api } = useSession();
  const [limit, setLimit] = useState(STEP);
  const q = useQuery({
    queryKey: ['external-bookings', limit],
    queryFn: async () => {
      const c = customerApi(api);
      const [lab, hl] = await Promise.all([c.externalBookings('labstack', 1, limit), c.externalBookings('healthians', 1, limit)]);
      const items = [...lab.items, ...hl.items].sort(newestFirst);
      return { items, more: lab.total > lab.items.length || hl.total > hl.items.length };
    },
    placeholderData: (p) => p,
  });
  return (
    <section aria-labelledby="ext-h" className="stack">
      <h2 id="ext-h">Lab tests</h2>
      {q.isPending ? <Loading /> : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : q.data.items.length === 0 ? <Empty title="No lab tests yet" />
        : (
          <>
            <ul className="list">
              {q.data.items.map((b) => (
                <li key={b._id}>
                  <Link to={`/lab-bookings/${b._id}`} className="list-row link-row">
                    <strong>{titleOf(b)}</strong>
                    <span className="muted">{formatAppointment(b.bookingDate, b.bookingTime)}{b.patientName ? ` · ${b.patientName}` : ''}</span>
                    <span><StatusBadge status={b.status ?? 'pending'} /> {b.price != null && <span className="muted">{formatRupees(b.price)}</span>}</span>
                  </Link>
                </li>
              ))}
            </ul>
            {q.data.more && limit < MAX && (
              <Button variant="secondary" busy={q.isFetching} onClick={() => setLimit((l) => Math.min(MAX, l + STEP))}>Show more</Button>
            )}
          </>
        )}
    </section>
  );
}

export const titleOf = (b: ExternalBooking) =>
  [...(b.packageNames ?? []), ...(b.testNames ?? [])].join(', ') || b.labName || b.doctorName || 'Lab test';

const newestFirst = (a: ExternalBooking, b: ExternalBooking) =>
  `${b.bookingDate}${b.bookingTime}`.localeCompare(`${a.bookingDate}${a.bookingTime}`);

export function StatusBadge({ status }: { status: string }) {
  const s = BOOKING_STATUS[status] ?? { label: status.replace(/_/g, ' ') };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}
