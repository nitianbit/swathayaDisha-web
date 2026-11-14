import { Link } from 'react-router';
import { customerApi, type ExternalBooking } from '@jansetu/api';
import { Badge, Button, Empty, ErrorState, formatRupees, Loading } from '@jansetu/ui';
import { BOOKING_STATUS, formatAppointment, messageOf, PageHeading } from '../common.tsx';
import { usePagedList } from '../paging.ts';
import { useSession } from '../session.tsx';

const PAGE = 20;

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
  const { q, items, total } = usePagedList(['bookings'], (page) => customerApi(api).bookings(page, PAGE));
  return (
    <section aria-labelledby="ord-h" className="stack">
      <h2 id="ord-h">Doctors and health packages</h2>
      {q.isPending ? <Loading /> : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : items.length === 0 ? <Empty title="No bookings yet" />
        : (
          <>
            <ul className="list">
              {items.map((b) => (
                <li key={b._id}>
                  <Link to={`/bookings/${b._id}`} className="list-row link-row">
                    <strong>{b.doctorName ?? b.packageName ?? BOOKING_TYPE[b.bookingType] ?? 'Booking'}</strong>
                    <span className="muted">{formatAppointment(b.bookingDate, b.bookingTime)}</span>
                    <span><StatusBadge status={b.status} /> {b.price != null && <span className="muted">{formatRupees(b.price)}</span>}</span>
                  </Link>
                </li>
              ))}
            </ul>
            <p className="muted">Showing {items.length} of {total}.</p>
            {q.hasNextPage && (
              <Button variant="secondary" busy={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Show more</Button>
            )}
          </>
        )}
    </section>
  );
}

/** Lab tests and provider visits come from two providers; the backend lists one provider per request. */
function ProviderBookings() {
  const { api } = useSession();
  const c = customerApi(api);
  // One list per provider, each paged to its own end, merged for display.
  const lab = usePagedList(['external-bookings', 'labstack'], (page) => c.externalBookings('labstack', page, PAGE));
  const hl = usePagedList(['external-bookings', 'healthians'], (page) => c.externalBookings('healthians', page, PAGE));
  const pending = lab.q.isPending || hl.q.isPending;
  const failed = lab.q.isError ? lab.q : hl.q.isError ? hl.q : null;
  const items = [...lab.items, ...hl.items].sort(newestFirst);
  const total = lab.total + hl.total;
  const more = lab.q.hasNextPage || hl.q.hasNextPage;
  return (
    <section aria-labelledby="ext-h" className="stack">
      <h2 id="ext-h">Lab tests</h2>
      {pending ? <Loading /> : failed ? <ErrorState message={messageOf(failed.error)} onRetry={() => void failed.refetch()} />
        : items.length === 0 ? <Empty title="No lab tests yet" />
        : (
          <>
            <ul className="list">
              {items.map((b) => (
                <li key={b._id}>
                  <Link to={`/lab-bookings/${b._id}`} className="list-row link-row">
                    <strong>{titleOf(b)}</strong>
                    <span className="muted">{formatAppointment(b.bookingDate, b.bookingTime)}{b.patientName ? ` · ${b.patientName}` : ''}</span>
                    <span><StatusBadge status={b.status ?? 'pending'} /> {b.price != null && <span className="muted">{formatRupees(b.price)}</span>}</span>
                  </Link>
                </li>
              ))}
            </ul>
            <p className="muted">Showing {items.length} of {total}.</p>
            {more && (
              <Button variant="secondary" busy={lab.q.isFetchingNextPage || hl.q.isFetchingNextPage}
                onClick={() => { if (lab.q.hasNextPage) void lab.q.fetchNextPage(); if (hl.q.hasNextPage) void hl.q.fetchNextPage(); }}>
                Show more
              </Button>
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
