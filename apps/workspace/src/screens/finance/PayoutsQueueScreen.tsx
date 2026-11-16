import { useMemo, useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import {
  isRealDate, MAX_FINANCE_REASON, OBJECT_ID_PATTERN, PAYOUT_STATE_LABEL, settlementsApi,
  type PayoutsQuery, type PayoutState, type QueuePayout,
} from '@jansetu/api';
import { Alert, Button, Empty, ErrorState, Loading, TextField } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession } from '../../session.tsx';
import { money } from '../partner/billing.tsx';
import { formatDate, PayoutsTable, useOneAtATime } from './finance.tsx';

const STATES: PayoutState[] = ['recorded', 'voided'];
const STEP = 100;

/** The account a queue row belongs to, as the row names it (Q13: the owner's current name, else the beneficiary). */
const accountName = (p: QueuePayout) => p.account?.ownerName || p.account?.beneficiaryName || `Account …${p.settlementAccountId.slice(-6)}`;

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
  const bad = (from && !isRealDate(from)) || (to && !isRealDate(to)) ? 'Enter real dates.' : from && to && from > to ? 'The period ends before it starts.' : null;
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
  const { perform, busy } = useOneAtATime('payout list');
  const [notice, setNotice] = useState<string | null>(null);

  async function voidIt(p: QueuePayout, reason: string) {
    await perform(async () => {
      try {
        const v = await s.voidPayout(p._id, reason);
        setNotice(`Payout ${v.reference} (${money(v.amountMinor)}) is voided; ${money(v.amountMinor)} is back in the account’s balance.`);
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
      <PageHeading title="Payouts">Transfers recorded for labs, clinics and doctors, newest recorded first. Void one recorded by mistake.</PageHeading>
      {notice && <Alert tone="ok">{notice}</Alert>}
      <div className="ws-search" role="group" aria-label="Filters">
        <div className="j-field ws-filter">
          <label htmlFor="pq-state">Status</label>
          <select id="pq-state" value={state} onChange={(e) => { setState(e.target.value as '' | PayoutState); }}>
            <option value="">All</option>
            {STATES.map((x) => <option key={x} value={x}>{PAYOUT_STATE_LABEL[x]}</option>)}
          </select>
        </div>
        <TextField label="Paid from" type="date" value={from} error={bad} onChange={(e) => { setFrom(e.target.value); }} />
        <TextField label="Paid to" type="date" value={to} onChange={(e) => { setTo(e.target.value); }} />
      </div>
      {accountId && (
        <p className="ws-muted">
          Only {singleName ?? `account …${accountId.slice(-6)}`}.{' '}
          <Button variant="ghost" onClick={() => { const n = new URLSearchParams(params); n.delete('account'); setParams(n, { replace: true }); }}>Show every account</Button>
        </p>
      )}
      {bad ? null
        : list.isPending ? <Loading label="Loading payouts…" />
        : list.isError && !list.data ? <ErrorState message={messageOf(list.error)} onRetry={() => void list.refetch()} />
        : rows.length === 0 ? <Empty title="No payouts">{state || from || to || accountId ? 'No payout matches these filters.' : 'Payouts recorded from an account appear here.'}</Empty>
        : (
          <>
            {list.isError && !list.isFetchNextPageError && <ErrorState message={messageOf(list.error)} onRetry={() => void list.refetch()} />}
            <p className="ws-count">{total} {total === 1 ? 'payout' : 'payouts'} · showing {rows.length}</p>
            <PayoutsTable payouts={rows} caption="Payouts, newest recorded first"
              accountCell={(p) => <Link to={`/admin/settlements/${p.settlementAccountId}`}>{accountName(p)}</Link>}
              actions={(p) => (p.state !== 'recorded' ? null : (
                <ConfirmAction label="Void" danger disabled={busy} reason reasonLabel="Why is it voided?" maxReason={MAX_FINANCE_REASON} confirmLabel="Void the payout"
                  consequence={<>
                    Void the payout of {money(p.amountMinor)} paid on {formatDate(p.paidOn)} (reference {p.reference})? It stays listed as voided and
                    {' '}{money(p.amountMinor)} is credited back to {p.account ? accountName(p) : 'the account'}’s balance. Do this only if the transfer did not
                    reach them or came back. It cannot be undone.
                  </>}
                  onConfirm={(reason) => voidIt(p, reason)} />
              ))} />
            {list.isFetchNextPageError && <ErrorState message={`Could not load more: ${messageOf(list.error)}`} onRetry={() => void list.fetchNextPage()} />}
            {list.hasNextPage && (
              <div><Button variant="secondary" busy={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>Show older payouts</Button></div>
            )}
          </>
        )}
    </>
  );
}
