import { useMemo, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  addDays, isRealDate, istDateOf, LAB_BOOKING_STATUS_LABEL, LAB_BOOKING_STATUSES, LAB_VISIT_MODE_LABEL,
  type LabBooking, type LabBookingQuery, type LabBookingStatus,
} from '@jansetu/api';
import { Badge, Button, Empty, ErrorState, Loading, TextField } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { LabOnly, LabPayment, labStatusTone, slotLabel, useScopedBranches } from './labs.tsx';
import { NoSuchPartner, PartnerPageHeading, scopeIdentity, usePartnerScope, useWorkspacePartner, type ScopeContext } from './scope.tsx';
import { t } from '../../i18n/partner/index.ts';

/** Online bookings at this lab's branches (`bookings.view`, `bookings.manage`, `reports.upload` or `reports.release`). */
export function LabBookingsScreen() {
  const ctx = usePartnerScope();
  if (!ctx) return <NoSuchPartner />;
  // One subtree per partner: filters never carry over to another partner.
  return <LabBookings key={scopeIdentity(ctx)} ctx={ctx} />;
}

function LabBookings({ ctx }: { ctx: ScopeContext }) {
  const partner = useWorkspacePartner(ctx);
  return (
    <>
      <PartnerPageHeading ctx={ctx} title={t('labBookings.title')} partnerName={partner.data?.name}>
        {t('labBookings.intro')}
      </PartnerPageHeading>
      {ctx.adminHome && <div><Link to={ctx.link('slots')}>{t('labBookings.slotsLink')}</Link></div>}
      <LabOnly ctx={ctx}><BookingList ctx={ctx} /></LabOnly>
    </>
  );
}

/** One page of the list (the server gives at most 200 a page; this many keeps the page quick to read). */
export const LAB_BOOKINGS_PAGE = 100;

/**
 * Which bookings the list asks for. WQ11b: the server pages the list (soonest slot first, an exact cursor), so the
 * default view starts today and shows the soonest first: nothing upcoming can fall behind older bookings. Past bookings
 * are a separate view over chosen dates (before today).
 */
export type LabListView = 'upcoming' | 'past';
export function labListFilter(f: { view: LabListView; status: string; branchId: string; from: string; to: string }, today: string):
  { query: LabBookingQuery; error: string | null } {
  const yesterday = addDays(today, -1);
  const from = isRealDate(f.from) ? f.from : undefined;
  const to = isRealDate(f.to) ? f.to : undefined;
  const base = { status: (f.status || undefined) as LabBookingStatus | undefined, branchId: f.branchId || undefined, limit: LAB_BOOKINGS_PAGE };
  if (f.view === 'upcoming') {
    if (to && to < today) return { query: {}, error: t('labBookings.error.upcomingPast') };
    return { query: { ...base, from: today, to }, error: null };
  }
  const until = to && to < today ? to : yesterday;
  if (to && to >= today) return { query: {}, error: t('labBookings.error.pastFuture') };
  if (from && from > until) return { query: {}, error: t('labBookings.error.startAfterEnd') };
  return { query: { ...base, from, to: until }, error: null };
}

function BookingList({ ctx }: { ctx: ScopeContext }) {
  const branches = useScopedBranches(ctx);
  const today = istDateOf(new Date());
  const [view, setView] = useState<LabListView>('upcoming');
  const [status, setStatus] = useState<'' | LabBookingStatus>('');
  const [branchId, setBranchId] = useState('');
  // Past: by default the last week before today; Upcoming: from today, with an optional last day.
  const [pastFrom, setPastFrom] = useState(() => addDays(today, -7));
  const [pastTo, setPastTo] = useState('');
  const [until, setUntil] = useState('');
  const { query, error: dateError } = labListFilter(
    view === 'upcoming' ? { view, status, branchId, from: '', to: until } : { view, status, branchId, from: pastFrom, to: pastTo }, today);
  const list = useInfiniteQuery({
    queryKey: [...ctx.key, 'lab-bookings', query],
    queryFn: ({ pageParam }) => ctx.labs.bookings({ ...query, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    // Q11: the server's exact cursor (`<slot start ms>_<id>`): nothing is skipped or shown twice.
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !dateError,
  });
  const names = useMemo(() => new Map((branches.data ?? []).map((b) => [b._id, b.name])), [branches.data]);
  const rows: LabBooking[] = (list.data?.pages ?? []).flatMap((p) => p.items);
  const total = list.data?.pages[0]?.total;
  const filtered = !!(status || branchId || (view === 'upcoming' && until));

  return (
    <>
      <fieldset className="ws-checks" aria-describedby="lb-view-hint">
        <legend>{t('labBookings.show')}</legend>
        <label className="ws-check">
          <input type="radio" name="lb-view" checked={view === 'upcoming'} onChange={() => setView('upcoming')} /> {t('labBookings.upcoming')}
        </label>
        <label className="ws-check">
          <input type="radio" name="lb-view" checked={view === 'past'} onChange={() => setView('past')} /> {t('labBookings.past')}
        </label>
        <span id="lb-view-hint" className="j-field__hint">
          {view === 'upcoming' ? t('labBookings.hint.upcoming') : t('labBookings.hint.past')}
        </span>
      </fieldset>
      <div className="ws-search">
        <div className="j-field ws-filter">
          <label htmlFor="lb-branch">{t('labBookings.branch')}</label>
          <select id="lb-branch" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            <option value="">{t('labBookings.allBranches')}</option>
            {branches.inScope.map((b) => <option key={b._id} value={b._id}>{b.name}</option>)}
          </select>
        </div>
        <div className="j-field ws-filter">
          <label htmlFor="lb-status">{t('labBookings.status')}</label>
          <select id="lb-status" value={status} onChange={(e) => setStatus(e.target.value as '' | LabBookingStatus)}>
            <option value="">{t('labBookings.allStatuses')}</option>
            {LAB_BOOKING_STATUSES.map((s) => <option key={s} value={s}>{LAB_BOOKING_STATUS_LABEL[s]}</option>)}
          </select>
        </div>
        {view === 'upcoming' ? (
          <TextField label={t('labBookings.until')} type="date" min={today} value={until} error={dateError} onChange={(e) => setUntil(e.target.value)} />
        ) : (
          <>
            <TextField label={t('labBookings.from')} type="date" max={addDays(today, -1)} value={pastFrom} onChange={(e) => setPastFrom(e.target.value)} />
            <TextField label={t('labBookings.untilPast')} type="date" max={addDays(today, -1)} value={pastTo} error={dateError}
              hint={pastTo ? undefined : t('labBookings.untilYesterday')} onChange={(e) => setPastTo(e.target.value)} />
          </>
        )}
      </div>
      {dateError ? null
        : list.isPending ? <Loading label={t('labBookings.loading')} />
        : list.isError && !list.data ? <ErrorState message={messageOf(list.error)} onRetry={() => void list.refetch()} />
        : rows.length === 0 ? <Empty title={t('labBookings.none.title')}>
          {filtered ? t('labBookings.none.filtered') : view === 'upcoming' ? t('labBookings.none.upcoming') : t('labBookings.none.past')}
        </Empty>
        : (
          <>
            <p className="ws-count" aria-live="polite">
              {total === undefined ? t('labBookings.count', { count: rows.length })
                : !list.hasNextPage ? t('labBookings.count', { count: total })
                : t(view === 'upcoming' ? 'labBookings.countSoonest' : 'labBookings.countEarliest', { count: total, shown: rows.length })}
            </p>
            <div className="ws-table-wrap">
              <table className="j-table">
                <caption className="j-sr-only">{t('labBookings.caption')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('labBookings.col.slot')}</th><th scope="col">{t('labBookings.col.patient')}</th><th scope="col">{t('labBookings.col.tests')}</th>
                    <th scope="col">{t('labBookings.col.visit')}</th><th scope="col">{t('labBookings.col.branch')}</th><th scope="col">{t('labBookings.col.status')}</th>
                    <th scope="col">{t('labBookings.col.payment')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((b) => (
                    <tr key={b._id}>
                      <td><Link to={`${ctx.link('lab-bookings')}/${b._id}`}>{slotLabel(b.slot)}</Link></td>
                      <td>{b.patient?.name}</td>
                      <td>{b.items.map((i) => i.name).join(', ')}</td>
                      <td>{LAB_VISIT_MODE_LABEL[b.visitMode] ?? b.visitMode}</td>
                      <td>{names.get(b.branchId) ?? t('common.branchById', { tail: b.branchId.slice(-6) })}</td>
                      <td>
                        <Badge tone={labStatusTone(b.status)}>{LAB_BOOKING_STATUS_LABEL[b.status] ?? b.status}</Badge>
                        {b.reschedule?.pending && <> <Badge tone="warn">{t('labBookings.newTimeProposed')}</Badge></>}
                      </td>
                      <td><LabPayment b={b} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {list.isFetchNextPageError && <ErrorState message={t('labBookings.moreFailed', { reason: messageOf(list.error) })} onRetry={() => void list.fetchNextPage()} />}
            {list.hasNextPage && (
              <div>
                <Button variant="secondary" busy={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                  {total !== undefined ? t('labBookings.showMoreCount', { n: total - rows.length }) : t('labBookings.showMoreLater')}
                </Button>
              </div>
            )}
          </>
        )}
    </>
  );
}
