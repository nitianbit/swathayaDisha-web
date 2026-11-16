import { useState, type FormEvent } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  DETAILS_STATE_LABEL, MAX_ACCOUNT_SEARCH, OWNER_KIND_LABEL, settlementsApi,
  type AccountsQuery, type PayoutDetailsState, type SettlementOwnerKind,
} from '@jansetu/api';
import { Badge, Button, Empty, ErrorState, Loading, TextField } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession } from '../../session.tsx';
import { money } from '../partner/billing.tsx';
import { detailsLabel, detailsTone, Signed } from './finance.tsx';

const PAGE = 50;
const KINDS: SettlementOwnerKind[] = ['partner', 'doctor'];
const STATES: PayoutDetailsState[] = ['none', 'unverified', 'verified'];

/**
 * Admin: every settlement account (labs, clinics and doctors) with its balance, largest first (`adminListAccounts`):
 * filters by owner kind, balance due, payout-details state and name; paged; totals over every matching account.
 * Filters live in the page only (names are never put in the URL).
 */
export function SettlementsScreen() {
  const { api } = useSession();
  const [filter, setFilter] = useState<Omit<AccountsQuery, 'limit' | 'skip'>>({ due: true });
  const [skip, setSkip] = useState(0);
  const [search, setSearch] = useState('');
  const q: AccountsQuery = { ...filter, limit: PAGE, skip };
  const list = useQuery({ queryKey: ['settlements', 'accounts', q], queryFn: () => settlementsApi(api).accounts(q), placeholderData: keepPreviousData });
  const change = (patch: Partial<AccountsQuery>) => { setFilter((f) => ({ ...f, ...patch })); setSkip(0); };
  const submit = (e: FormEvent) => { e.preventDefault(); change({ search: search.trim() || undefined }); };
  const total = list.data?.total ?? 0;
  const page = Math.floor(skip / PAGE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <>
      <PageHeading title="Settlements">Balances Jansetu owes labs, clinics and doctors from online payments. Record a payout from an account.</PageHeading>
      <form className="ws-search" role="search" onSubmit={submit}>
        <TextField label="Search by account name" value={search} maxLength={MAX_ACCOUNT_SEARCH} onChange={(e) => setSearch(e.target.value)} />
        <Button type="submit" variant="secondary">Search</Button>
      </form>
      <div className="ws-search" role="group" aria-label="Filters">
        <div className="j-field ws-filter">
          <label htmlFor="sa-kind">Account of</label>
          <select id="sa-kind" value={filter.ownerKind ?? ''} onChange={(e) => change({ ownerKind: (e.target.value || undefined) as SettlementOwnerKind | undefined })}>
            <option value="">Everyone</option>
            {KINDS.map((k) => <option key={k} value={k}>{OWNER_KIND_LABEL[k]}</option>)}
          </select>
        </div>
        <div className="j-field ws-filter">
          <label htmlFor="sa-state">Payout details</label>
          <select id="sa-state" value={filter.detailsState ?? ''} onChange={(e) => change({ detailsState: (e.target.value || undefined) as PayoutDetailsState | undefined })}>
            <option value="">Any</option>
            {STATES.map((s) => <option key={s} value={s}>{DETAILS_STATE_LABEL[s]}</option>)}
          </select>
        </div>
        <label className="ws-check">
          <input type="checkbox" checked={!!filter.due} onChange={(e) => change({ due: e.target.checked || undefined })} /> Only with a balance due
        </label>
      </div>
      {list.isPending ? <Loading label="Loading accounts…" />
        : list.isError && !list.data ? <ErrorState message={messageOf(list.error)} onRetry={() => void list.refetch()} />
        : list.data.rows.length === 0 && skip === 0 ? <Empty title="No accounts match">{filter.due ? 'No account has a balance due with these filters.' : 'Change the search or filters.'}</Empty>
        : (
          <>
            <p className="ws-count" aria-live="polite">
              {list.data.total} {list.data.total === 1 ? 'account' : 'accounts'} · due in total {money(list.data.totalDueMinor)}
            </p>
            {list.isError && <ErrorState message={messageOf(list.error)} onRetry={() => void list.refetch()} />}
            <div className="ws-table-wrap">
              <table className="j-table">
                <caption className="j-sr-only">Settlement accounts, largest balance first</caption>
                <thead>
                  <tr><th scope="col">Account</th><th scope="col">Of</th><th scope="col" className="fin-amount">Balance</th><th scope="col">Payout details</th></tr>
                </thead>
                <tbody>
                  {list.data.rows.map((a) => (
                    <tr key={a._id}>
                      <td><Link to={`/admin/settlements/${a._id}`}>{a.beneficiaryName}</Link>{!a.isActive && <> <Badge tone="danger">Inactive</Badge></>}</td>
                      <td>{OWNER_KIND_LABEL[a.ownerKind] ?? a.ownerKind}</td>
                      <td className="fin-amount"><Signed minor={a.balanceMinor} /></td>
                      <td>
                        <Badge tone={detailsTone(a.payoutDetailsState)}>{DETAILS_STATE_LABEL[a.payoutDetailsState] ?? a.payoutDetailsState}</Badge>
                        {a.payoutDetails && <div className="ws-muted">{detailsLabel(a.payoutDetails)}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {(pages > 1 || skip > 0) && (
              <nav className="ws-pager" aria-label="Pages">
                <Button variant="secondary" disabled={skip <= 0} onClick={() => setSkip(Math.max(0, skip - PAGE))}>Previous</Button>
                <span>Page {page} of {pages}</span>
                <Button variant="secondary" disabled={skip + PAGE >= total} onClick={() => setSkip(skip + PAGE)}>Next</Button>
              </nav>
            )}
          </>
        )}
    </>
  );
}
