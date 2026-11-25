import { Link } from 'react-router';
import { customerBillsApi, fromPaise, type BillState } from '@jansetu/api';
import { Badge, Button, Empty, ErrorState, formatDateTime, formatRupees, Loading, shared } from '@jansetu/ui';
import { messageOf, PageHeading, type StatusWords } from '../../common.tsx';
import { t } from '../../i18n/index.ts';
import { usePagedList } from '../../paging.ts';
import { useSession } from '../../session.tsx';

const BILL_STATE: Readonly<Record<BillState, StatusWords>> = {
  issued: { key: 'bills.state.unpaid', tone: 'warn' },
  partly_paid: { key: 'bills.state.partlyPaid', tone: 'warn' },
  paid: { key: 'bills.state.paid', tone: 'ok' },
  cancelled: { key: 'status.cancelled', tone: 'danger' },
};
/** A bill's state badge; an unknown state shows as the server sent it. */
export function billStateOf(state: BillState) {
  const s = Object.hasOwn(BILL_STATE, state) ? BILL_STATE[state] : undefined;
  return s ? { label: t(s.key), tone: s.tone } : { label: state as string };
}

/** Bills from partner labs and clinics, issued to this account's phone number. */
export function BillsScreen() {
  const { api } = useSession();
  const { q, items, total } = usePagedList(['bills', 'list'], (page) => customerBillsApi(api).bills(page, 20));
  return (
    <>
      <PageHeading title={t('home.bills')}>{t('bills.sub')}</PageHeading>
      {q.isPending ? <Loading /> : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : items.length === 0 ? <Empty title={t('bills.empty')}>{t('bills.emptyBody')}</Empty>
        : (
          <>
          <ul className="list">
            {items.map((b) => {
              const s = billStateOf(b.lifecycleState);
              return (
                <li key={b._id}>
                  <Link to={`/bills/${b._id}`} className="list-row link-row">
                    <strong>{b.supplier?.name ?? t('bills.bill')}</strong>
                    <span className="muted">{b.serial} · {formatDateTime(b.issuedAt)}</span>
                    <span><Badge tone={s.tone}>{s.label}</Badge> <span className="muted">{formatRupees(fromPaise(b.totals?.totalMinor))}</span></span>
                  </Link>
                </li>
              );
            })}
          </ul>
          <p className="muted">{t('common.showing', { shown: items.length, total })}</p>
          {q.hasNextPage && <Button variant="secondary" busy={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{shared('action.showMore')}</Button>}
          </>
        )}
    </>
  );
}
