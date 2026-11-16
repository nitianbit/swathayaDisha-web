import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import {
  isRealDate, MAX_FINANCE_REASON, OBJECT_ID_PATTERN, PAYOUT_STATE_LABEL, PAYOUTS_LIMIT_MAX, settlementsApi,
  type PayoutsQuery, type PayoutState, type SettlementPayout,
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

/**
 * Admin: recorded payouts across every account, newest paid first (`adminListPayouts`), filtered by state, paid-on
 * dates and (from an account page) one account; void a payout recorded by mistake. The server has no paging beyond a
 * limit (at most 500), so "Show more" asks for a longer list.
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
  const [limit, setLimit] = useState(STEP);
  const bad = (from && !isRealDate(from)) || (to && !isRealDate(to)) ? 'Enter real dates.' : from && to && from > to ? 'The period ends before it starts.' : null;
  const q: PayoutsQuery = { accountId, state: state || undefined, from: from || undefined, to: to || undefined, limit };
  const list = useQuery({ queryKey: ['settlements', 'payouts', q], queryFn: () => s.payoutQueue(q), enabled: !bad, placeholderData: keepPreviousData });
  // Payout rows carry only the account id: names come from the account list (largest balances first, up to 200).
  const accounts = useQuery({ queryKey: ['settlements', 'accounts', 'names'], queryFn: () => s.accounts({ limit: 200 }) });
  const names = useMemo(() => new Map((accounts.data?.rows ?? []).map((a) => [a._id, a.beneficiaryName])), [accounts.data]);
  const { perform, busy } = useOneAtATime('payout list');
  const [notice, setNotice] = useState<string | null>(null);
  const reset = () => setLimit(STEP);

  async function voidIt(p: SettlementPayout, reason: string) {
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

  const rows = list.data ?? [];
  return (
    <>
      <PageHeading title="Payouts">Transfers recorded for labs, clinics and doctors, newest first. Void one recorded by mistake.</PageHeading>
      {notice && <Alert tone="ok">{notice}</Alert>}
      <div className="ws-search" role="group" aria-label="Filters">
        <div className="j-field ws-filter">
          <label htmlFor="pq-state">Status</label>
          <select id="pq-state" value={state} onChange={(e) => { setState(e.target.value as '' | PayoutState); reset(); }}>
            <option value="">All</option>
            {STATES.map((x) => <option key={x} value={x}>{PAYOUT_STATE_LABEL[x]}</option>)}
          </select>
        </div>
        <TextField label="Paid from" type="date" value={from} error={bad} onChange={(e) => { setFrom(e.target.value); reset(); }} />
        <TextField label="Paid to" type="date" value={to} onChange={(e) => { setTo(e.target.value); reset(); }} />
      </div>
      {accountId && (
        <p className="ws-muted">
          Only {names.get(accountId) ?? `account …${accountId.slice(-6)}`}.{' '}
          <Button variant="ghost" onClick={() => { const n = new URLSearchParams(params); n.delete('account'); setParams(n, { replace: true }); reset(); }}>Show every account</Button>
        </p>
      )}
      {bad ? null
        : list.isPending ? <Loading label="Loading payouts…" />
        : list.isError && !list.data ? <ErrorState message={messageOf(list.error)} onRetry={() => void list.refetch()} />
        : rows.length === 0 ? <Empty title="No payouts">{state || from || to || accountId ? 'No payout matches these filters.' : 'Payouts recorded from an account appear here.'}</Empty>
        : (
          <>
            {list.isError && <ErrorState message={messageOf(list.error)} onRetry={() => void list.refetch()} />}
            <PayoutsTable payouts={rows} caption="Payouts, newest paid first"
              accountCell={(p) => <Link to={`/admin/settlements/${p.settlementAccountId}`}>{names.get(p.settlementAccountId) ?? `Account …${p.settlementAccountId.slice(-6)}`}</Link>}
              actions={(p) => (p.state !== 'recorded' ? null : (
                <ConfirmAction label="Void" danger disabled={busy} reason reasonLabel="Why is it voided?" maxReason={MAX_FINANCE_REASON} confirmLabel="Void the payout"
                  consequence={<>
                    Void the payout of {money(p.amountMinor)} paid on {formatDate(p.paidOn)} (reference {p.reference})? It stays listed as voided and
                    {' '}{money(p.amountMinor)} is credited back to {names.get(p.settlementAccountId) ?? 'the account'}’s balance. Do this only if the transfer did not
                    reach them or came back. It cannot be undone.
                  </>}
                  onConfirm={(reason) => voidIt(p, reason)} />
              ))} />
            {rows.length >= limit && limit < PAYOUTS_LIMIT_MAX && (
              <div><Button variant="secondary" busy={list.isFetching} onClick={() => setLimit(Math.min(PAYOUTS_LIMIT_MAX, limit + STEP))}>Show more</Button></div>
            )}
            {rows.length >= PAYOUTS_LIMIT_MAX && <p className="ws-muted">Only the latest {PAYOUTS_LIMIT_MAX} are listed: narrow the dates to see older ones.</p>}
          </>
        )}
    </>
  );
}
