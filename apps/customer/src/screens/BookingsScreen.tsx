import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { customerApi, customerLabsApi, fromPaise, INSTANT_MODE_LABEL, instantConsultApi, type ExternalBooking } from '@jansetu/api';
import { Badge, Button, Empty, ErrorState, formatDateTime, formatRupees, Loading } from '@jansetu/ui';
import { instantStatusOf } from './consult/labels.ts';
import { labStatusOf, labTitle, VISIT_MODE_LABEL } from './labs/labels.ts';
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
      <InstantRequests />
      <PartnerLabBookings />
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
                    <span><StatusBadge status={b.status} cause={b.cancellationCause} /> {b.price != null && <span className="muted">{formatRupees(b.price)}</span>}</span>
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

/** Q4b "Consult now" requests (the consultation itself, once a doctor accepts, is also listed with the doctors). */
function InstantRequests() {
  const { api } = useSession();
  // The backend returns the newest 50 requests and does not page this list.
  const q = useQuery({ queryKey: ['instant-requests', 'list'], queryFn: () => instantConsultApi(api).requests() });
  return (
    <section aria-labelledby="instant-h" className="stack">
      <h2 id="instant-h">Consult now requests</h2>
      {q.isPending ? <Loading /> : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : q.data.length === 0 ? <Empty title="No consult now requests"><Link to="/consult">Consult a doctor now</Link></Empty>
        : (
          <ul className="list">
            {q.data.map((r) => {
              const s = instantStatusOf(r);
              return (
                <li key={r._id}>
                  <Link to={`/consult/requests/${r._id}`} className="list-row link-row">
                    <strong>{INSTANT_MODE_LABEL[r.mode]} · {r.specialization}</strong>
                    <span className="muted">{r.createdAt ? formatDateTime(r.createdAt) : ''}{r.patient?.name ? ` · ${r.patient.name}` : ''}</span>
                    <span><Badge tone={s.tone}>{s.label}</Badge> <span className="muted">{formatRupees(fromPaise(r.quotedAmountMinor - r.discountMinor))}</span></span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
    </section>
  );
}

/** Q3 bookings at partner labs (home collection or lab visit). */
function PartnerLabBookings() {
  const { api } = useSession();
  // The backend returns the newest 100 bookings and does not page this list.
  const q = useQuery({ queryKey: ['lab-bookings', 'list'], queryFn: () => customerLabsApi(api).bookings() });
  return (
    <section aria-labelledby="plab-h" className="stack">
      <h2 id="plab-h">Partner lab bookings</h2>
      {q.isPending ? <Loading /> : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : q.data.length === 0 ? <Empty title="No partner lab bookings"><Link to="/labs">Book a lab test</Link></Empty>
        : (
          <ul className="list">
            {q.data.map((b) => {
              const s = labStatusOf(b);
              return (
                <li key={b._id}>
                  <Link to={`/partner-lab-bookings/${b._id}`} className="list-row link-row">
                    <strong>{labTitle(b)}</strong>
                    <span className="muted">{formatDateTime(b.slot?.startsAt)} · {VISIT_MODE_LABEL[b.visitMode]}{b.patient?.name ? ` · ${b.patient.name}` : ''}</span>
                    <span><Badge tone={s.tone}>{s.label}</Badge>{b.report?.files?.length ? <> <Badge tone="ok">Report</Badge></> : null} <span className="muted">{formatRupees(fromPaise(b.pricing?.payableMinor))}</span></span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
    </section>
  );
}

export const titleOf = (b: ExternalBooking) =>
  [...(b.packageNames ?? []), ...(b.testNames ?? [])].join(', ') || b.labName || b.doctorName || 'Lab test';

const newestFirst = (a: ExternalBooking, b: ExternalBooking) =>
  `${b.bookingDate}${b.bookingTime}`.localeCompare(`${a.bookingDate}${a.bookingTime}`);

export function StatusBadge({ status, cause }: { status: string; cause?: string }) {
  const s = status === 'cancelled' && cause === 'payment_timeout' ? { label: 'Expired', tone: 'danger' as const }
    : BOOKING_STATUS[status] ?? { label: status.replace(/_/g, ' ') };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}
