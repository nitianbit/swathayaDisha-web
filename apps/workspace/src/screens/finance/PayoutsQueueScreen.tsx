import { useMemo, useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import {
  isRealDate, MAX_FINANCE_REASON, OBJECT_ID_PATTERN, PAYOUT_STATE_LABEL, settlementsApi,
  type PayoutsQuery, type PayoutState, type QueuePayout,
} from '@jansetu/api';
import { Alert, Button, Empty, ErrorState, Loading, shared, TextField } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { messageOf } from '../../errors.ts';
import { t } from '../../i18n/finance/index.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession } from '../../session.tsx';
import { money } from '../partner/billing.tsx';
import { formatDate, PayoutsTable, useOneAtATime } from './finance.tsx';

const STATES: PayoutState[] = ['recorded', 'voided'];
const STEP = 100;

/** The account a queue row belongs to, as the row names it (Q13: the owner's current name, else the beneficiary). */
const accountName = (p: QueuePayout) => p.account?.ownerName || p.account?.beneficiaryName || t('queue.accountShort', { id: p.settlementAccountId.slice(-6) });

/**
 * Admin: payouts across every account, newest RECORDED first (Q13 `adminPayoutsPage`), filtered by state, paid-on dates
 * and (from an account page) one account; void a payout recorded by mistake. Paged by the server's exact cursor with
 * the total; each row names its account, so no separate account list is read for names.
 */
export function PayoutsQueueScreen() {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const s = useMemo(() => settlementsApi(api), [api]);
  const [params, setParams] = useSearchParams();
  const fromUrl = params.get('account') ?? '';
  const accountId = OBJECT_ID_PATTERN.test(fromUrl) ? fromUrl.toLowerCase() : undefined;
  const [state, setState] = useState<'' | PayoutState>('recorded');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const bad = (from && !isRealDate(from)) || (to && !isRealDate(to)) ? t('period.badDates') : from && to && from > to ? t('period.endsBeforeStart') : null;
  const q: PayoutsQuery = { accountId, state: state || undefined, from: from || undefined, to: to || undefined, limit: STEP };
  const list = useInfiniteQuery({
    queryKey: ['settlements', 'payouts', q], enabled: !bad, placeholderData: keepPreviousData,
    queryFn: ({ pageParam }) => s.payoutQueue({ ...q, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = useMemo(() => {
    const seen = new Set<string>();
    const out: QueuePayout[] = [];
    for (const p of list.data?.pages ?? []) for (const r of p.items) if (!seen.has(r._id)) { seen.add(r._id); out.push(r); }
    return out;
  }, [list.data]);
  const total = list.data?.pages.at(-1)?.total ?? rows.length;
  const { perform, busy } = useOneAtATime('payoutList');
  const [notice, setNotice] = useState<string | null>(null);

  async function voidIt(p: QueuePayout, reason: string) {
    await perform(async () => {
      try {
        const v = await s.voidPayout(p._id, reason);
        setNotice(t('queue.voided', { reference: v.reference, amount: money(v.amountMinor) }));
      } finally {
        // Success or not (a lost answer, voided meanwhile), show the payouts and balances as they are now.
        void queryClient.invalidateQueries({ queryKey: ['settlements'] });
      }
    });
  }

  const only = rows.find((r) => r.settlementAccountId.toLowerCase() === accountId);
  // With no row of that account listed (e.g. none recorded), its name comes from the account itself (same cache as its page).
  const single = useQuery({
    queryKey: ['settlements', 'account', accountId ?? '', 'summary'], queryFn: () => s.account(accountId!), enabled: !!accountId && !only && !list.isPending,
  });
  const singleName = only ? accountName(only) : single.data?.account?.beneficiaryName;
  return (
    <>
      <PageHeading title={t('payouts.title')}>{t('queue.intro')}</PageHeading>
      {notice && <Alert tone="ok">{notice}</Alert>}
      <div className="ws-search" role="group" aria-label={t('filters.label')}>
        <div className="j-field ws-filter">
          <label htmlFor="pq-state">{shared('field.status')}</label>
          <select id="pq-state" value={state} onChange={(e) => { setState(e.target.value as '' | PayoutState); }}>
            <option value="">{t('queue.all')}</option>
            {STATES.map((x) => <option key={x} value={x}>{PAYOUT_STATE_LABEL[x]}</option>)}
          </select>
        </div>
        <TextField label={t('queue.paidFrom')} type="date" value={from} error={bad} onChange={(e) => { setFrom(e.target.value); }} />
        <TextField label={t('queue.paidTo')} type="date" value={to} onChange={(e) => { setTo(e.target.value); }} />
      </div>
      {accountId && (
        <p className="ws-muted">
          {singleName != null ? t('queue.only', { account: singleName }) : t('queue.onlyUnnamed', { id: accountId.slice(-6) })}{' '}
          <Button variant="ghost" onClick={() => { const n = new URLSearchParams(params); n.delete('account'); setParams(n, { replace: true }); }}>{t('queue.everyAccount')}</Button>
        </p>
      )}
      {bad ? null
        : list.isPending ? <Loading label={t('payouts.loading')} />
        : list.isError && !list.data ? <ErrorState message={messageOf(list.error)} onRetry={() => void list.refetch()} />
        : rows.length === 0 ? <Empty title={t('payouts.empty')}>{state || from || to || accountId ? t('queue.noMatch') : t('queue.emptyText')}</Empty>
        : (
          <>
            {list.isError && !list.isFetchNextPageError && <ErrorState message={messageOf(list.error)} onRetry={() => void list.refetch()} />}
            <p className="ws-count">{t('queue.count', { count: total, shown: rows.length })}</p>
            <PayoutsTable payouts={rows} caption={t('queue.caption')}
              accountCell={(p) => <Link to={`/admin/settlements/${p.settlementAccountId}`}>{accountName(p)}</Link>}
              actions={(p) => (p.state !== 'recorded' ? null : (
                <ConfirmAction label={t('queue.void')} danger disabled={busy} reason reasonLabel={t('queue.voidReason')} maxReason={MAX_FINANCE_REASON}
                  confirmLabel={t('queue.voidConfirm')}
                  consequence={p.account
                    ? t('queue.voidConsequence', { amount: money(p.amountMinor), date: formatDate(p.paidOn), reference: p.reference, account: accountName(p) })
                    : t('queue.voidConsequenceUnnamed', { amount: money(p.amountMinor), date: formatDate(p.paidOn), reference: p.reference })}
                  onConfirm={(reason) => voidIt(p, reason)} />
              ))} />
            {list.isFetchNextPageError && <ErrorState message={t('list.moreFailed', { error: messageOf(list.error) })} onRetry={() => void list.fetchNextPage()} />}
            {list.hasNextPage && (
              <div><Button variant="secondary" busy={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>{t('payouts.older')}</Button></div>
            )}
          </>
        )}
    </>
  );
}
