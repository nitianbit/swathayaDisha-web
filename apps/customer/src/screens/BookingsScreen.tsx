import { Link } from 'react-router';
import { customerApi, customerLabsApi, fromPaise, INSTANT_MODE_LABEL, instantConsultApi, type ExternalBooking } from '@jansetu/api';
import { Badge, Button, Empty, ErrorState, formatDateTime, formatRupees, Loading, shared } from '@jansetu/ui';
import { instantStatusOf } from './consult/labels.ts';
import { labStatusOf, labTitle, visitModeLabel } from './labs/labels.ts';
import { BOOKING_STATUS, formatAppointment, messageOf, PageHeading, statusOf } from '../common.tsx';
import { t, type CustomerKey } from '../i18n/index.ts';
import { usePagedList } from '../paging.ts';
import { useSession } from '../session.tsx';

const PAGE = 20;

const BOOKING_TYPE: Readonly<Record<string, CustomerKey>> = {
  package: 'bookings.type.package', consultation: 'bookings.type.consultation', 'second-opinion': 'bookings.type.secondOpinion', surgery: 'bookings.type.surgery',
};
const bookingType = (type: string) => (Object.hasOwn(BOOKING_TYPE, type) ? t(BOOKING_TYPE[type]!) : undefined);

export function BookingsScreen() {
  return (
    <>
      <PageHeading title={t('common.myBookings')} />
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
      <h2 id="ord-h">{t('bookings.doctorsHeading')}</h2>
      {q.isPending ? <Loading /> : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : items.length === 0 ? <Empty title={t('bookings.empty')} />
        : (
          <>
            <ul className="list">
              {items.map((b) => (
                <li key={b._id}>
                  <Link to={`/bookings/${b._id}`} className="list-row link-row">
                    <strong>{b.doctorName ?? b.packageName ?? bookingType(b.bookingType) ?? t('common.booking')}</strong>
                    <span className="muted">{formatAppointment(b.bookingDate, b.bookingTime)}</span>
                    <span><StatusBadge status={b.status} cause={b.cancellationCause} /> {b.price != null && <span className="muted">{formatRupees(b.price)}</span>}</span>
                  </Link>
                </li>
              ))}
            </ul>
            <p className="muted">{t('common.showing', { shown: items.length, total })}</p>
            {q.hasNextPage && (
              <Button variant="secondary" busy={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{shared('action.showMore')}</Button>
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
      <h2 id="ext-h">{t('common.labTests')}</h2>
      {pending ? <Loading /> : failed ? <ErrorState message={messageOf(failed.error)} onRetry={() => void failed.refetch()} />
        : items.length === 0 ? <Empty title={t('bookings.noLabTests')} />
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
            <p className="muted">{t('common.showing', { shown: items.length, total })}</p>
            {more && (
              <Button variant="secondary" busy={lab.q.isFetchingNextPage || hl.q.isFetchingNextPage}
                onClick={() => { if (lab.q.hasNextPage) void lab.q.fetchNextPage(); if (hl.q.hasNextPage) void hl.q.fetchNextPage(); }}>
                {shared('action.showMore')}
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
  const { q, items, total } = usePagedList(['instant-requests', 'list'], (page) => instantConsultApi(api).requests(page, PAGE));
  return (
    <section aria-labelledby="instant-h" className="stack">
      <h2 id="instant-h">{t('bookings.instantHeading')}</h2>
      {q.isPending ? <Loading /> : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : items.length === 0 ? <Empty title={t('bookings.noInstant')}><Link to="/consult">{t('bookings.consultLink')}</Link></Empty>
        : (
          <>
          <ul className="list">
            {items.map((r) => {
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
          <p className="muted">{t('common.showing', { shown: items.length, total })}</p>
          {q.hasNextPage && <Button variant="secondary" busy={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{shared('action.showMore')}</Button>}
          </>
        )}
    </section>
  );
}

/** Q3 bookings at partner labs (home collection or lab visit). */
function PartnerLabBookings() {
  const { api } = useSession();
  const { q, items, total } = usePagedList(['lab-bookings', 'list'], (page) => customerLabsApi(api).bookings(page, PAGE));
  return (
    <section aria-labelledby="plab-h" className="stack">
      <h2 id="plab-h">{t('bookings.partnerLabs')}</h2>
      {q.isPending ? <Loading /> : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : items.length === 0 ? <Empty title={t('bookings.noPartnerLabs')}><Link to="/labs">{t('bookings.bookLabTest')}</Link></Empty>
        : (
          <>
          <ul className="list">
            {items.map((b) => {
              const s = labStatusOf(b);
              return (
                <li key={b._id}>
                  <Link to={`/partner-lab-bookings/${b._id}`} className="list-row link-row">
                    <strong>{labTitle(b)}</strong>
                    <span className="muted">{formatDateTime(b.slot?.startsAt)} · {visitModeLabel(b.visitMode)}{b.lab?.name ? ` · ${b.lab.name}` : ''}{b.patient?.name ? ` · ${b.patient.name}` : ''}</span>
                    <span><Badge tone={s.tone}>{s.label}</Badge>{b.report?.files?.length ? <> <Badge tone="ok">{t('bookings.report')}</Badge></> : null} <span className="muted">{formatRupees(fromPaise(b.pricing?.payableMinor))}</span></span>
                  </Link>
                </li>
              );
            })}
          </ul>
          <p className="muted">{t('common.showing', { shown: items.length, total })}</p>
          {q.hasNextPage && <Button variant="secondary" busy={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{shared('action.showMore')}</Button>}
          </>
        )}
    </section>
  );
}

export const titleOf = (b: ExternalBooking) =>
  [...(b.packageNames ?? []), ...(b.testNames ?? [])].join(', ') || b.labName || b.doctorName || t('lab.titleFallback');

const newestFirst = (a: ExternalBooking, b: ExternalBooking) =>
  `${b.bookingDate}${b.bookingTime}`.localeCompare(`${a.bookingDate}${a.bookingTime}`);

export function StatusBadge({ status, cause }: { status: string; cause?: string }) {
  const s = status === 'cancelled' && cause === 'payment_timeout' ? { label: t('status.expired'), tone: 'danger' as const }
    : statusOf(BOOKING_STATUS, status);
  return <Badge tone={s.tone}>{s.label}</Badge>;
}
