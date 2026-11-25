import { useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  LAB_BOOKING_STATUS_LABEL, LAB_BOOKING_STATUSES, LAB_PAYMENT_STATUS_LABEL, LAB_VISIT_MODE_LABEL, labBookingsAdminApi,
  partnerAdminApi, type AdminLabBookingQuery, type AdminLabBookingRow, type LabBookingStatus,
} from '@jansetu/api';
import { Badge, Button, Empty, ErrorState, formatDateTime, Loading, shared } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { t } from '../../i18n/admin/index.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession } from '../../session.tsx';
import { labStatusTone, slotLabel } from '../partner/labs.tsx';

/** One page of the admin list (the server gives at most 200 a page, 50 when not asked). */
export const ADMIN_LAB_BOOKINGS_PAGE = 100;

/**
 * The pages read so far as one list. The list is paged by number, newest booked first, so a booking made while the
 * admin reads moves the later pages along by one: a row already shown is not shown twice.
 */
export function mergeAdminPages(pages: readonly { items: readonly AdminLabBookingRow[] }[]): AdminLabBookingRow[] {
  const seen = new Set<string>();
  const out: AdminLabBookingRow[] = [];
  for (const p of pages) for (const b of p.items) if (!seen.has(b._id)) { seen.add(b._id); out.push(b); }
  return out;
}

/** Admin: online lab bookings of every partner lab, newest booked first, paged by the server (Q11 `adminList`). */
export function AdminLabBookingsScreen() {
  const { api } = useSession();
  const [partnerId, setPartnerId] = useState('');
  const [status, setStatus] = useState<'' | LabBookingStatus>('');
  const filter: AdminLabBookingQuery = { partnerId: partnerId || undefined, status: status || undefined, limit: ADMIN_LAB_BOOKINGS_PAGE };
  const list = useInfiniteQuery({
    queryKey: ['admin-lab-bookings', filter],
    queryFn: ({ pageParam }) => labBookingsAdminApi(api).list({ ...filter, page: pageParam }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page < last.totalPages && last.items.length > 0 ? last.page + 1 : undefined),
  });
  // Names for the lab column and filter (labs only; the list's page size is 200, the largest the server gives).
  const labs = useQuery({ queryKey: ['admin-partners', 'labs'], queryFn: () => partnerAdminApi(api).list({ kind: 'lab', limit: 200 }) });
  const names = useMemo(() => new Map((labs.data?.items ?? []).map((p) => [p._id, p.name])), [labs.data]);
  const rows = mergeAdminPages(list.data?.pages ?? []);
  const total = list.data?.pages[0]?.total;

  return (
    <>
      <PageHeading title={t('labBookings.title')}>{t('labBookings.intro')}</PageHeading>
      <div className="ws-search">
        <div className="j-field ws-filter">
          <label htmlFor="alb-lab">{t('labBookings.lab')}</label>
          <select id="alb-lab" value={partnerId} onChange={(e) => setPartnerId(e.target.value)}>
            <option value="">{t('labBookings.allLabs')}</option>
            {(labs.data?.items ?? []).map((p) => <option key={p._id} value={p._id}>{p.name}</option>)}
          </select>
          {labs.isError && <span className="j-field__hint">{t('labBookings.labsFailed', { error: messageOf(labs.error) })}</span>}
        </div>
        <div className="j-field ws-filter">
          <label htmlFor="alb-status">{t('common.status')}</label>
          <select id="alb-status" value={status} onChange={(e) => setStatus(e.target.value as '' | LabBookingStatus)}>
            <option value="">{t('labBookings.allStatuses')}</option>
            {LAB_BOOKING_STATUSES.map((s) => <option key={s} value={s}>{LAB_BOOKING_STATUS_LABEL[s]}</option>)}
          </select>
        </div>
      </div>
      {list.isPending ? <Loading label={t('labBookings.loading')} />
        : list.isError && !list.data ? <ErrorState message={messageOf(list.error)} onRetry={() => void list.refetch()} />
        : rows.length === 0 ? <Empty title={t('labBookings.none')}>{partnerId || status ? t('labBookings.noneMatch') : t('labBookings.noneYet')}</Empty>
        : (
          <>
            <p className="ws-count" aria-live="polite">
              {total === undefined ? t('labBookings.count', { count: rows.length })
                : list.hasNextPage ? t('labBookings.countShowing', { count: total, shown: rows.length })
                : t('labBookings.count', { count: total })}
            </p>
            <div className="ws-table-wrap">
              <table className="j-table">
                <caption className="j-sr-only">{t('labBookings.caption')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('labBookings.booked')}</th><th scope="col">{t('labBookings.lab')}</th><th scope="col">{t('labBookings.slot')}</th>
                    <th scope="col">{t('labBookings.patient')}</th><th scope="col">{t('labBookings.visit')}</th><th scope="col">{t('common.status')}</th>
                    <th scope="col">{t('labBookings.payment')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((b) => (
                    <tr key={b._id}>
                      <td><Link to={`/admin/partners/${b.partnerId}/lab-bookings/${b._id}`}>{formatDateTime(b.createdAt)}</Link></td>
                      <td>{names.get(b.partnerId) ?? t('labBookings.unknownLab', { id: b.partnerId.slice(-6) })}</td>
                      <td>{b.slot ? slotLabel(b.slot) : '—'}</td>
                      <td>{b.patient?.name}</td>
                      <td>{LAB_VISIT_MODE_LABEL[b.visitMode] ?? b.visitMode}</td>
                      <td>
                        <Badge tone={labStatusTone(b.status)}>{LAB_BOOKING_STATUS_LABEL[b.status] ?? b.status}</Badge>
                        {b.reschedule?.pending && <> <Badge tone="warn">{t('labBookings.newTimeProposed')}</Badge></>}
                      </td>
                      <td>{LAB_PAYMENT_STATUS_LABEL[b.paymentStatus] ?? b.paymentStatus}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {list.isFetchNextPageError && <ErrorState message={t('labBookings.moreFailed', { error: messageOf(list.error) })} onRetry={() => void list.fetchNextPage()} />}
            {list.hasNextPage && (
              <div>
                <Button variant="secondary" busy={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                  {total !== undefined ? t('labBookings.showMoreLeft', { left: Math.max(0, total - rows.length) }) : shared('action.showMore')}
                </Button>
              </div>
            )}
          </>
        )}
    </>
  );
}
