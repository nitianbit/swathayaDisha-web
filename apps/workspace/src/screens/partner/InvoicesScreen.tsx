import { useState, type FormEvent } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  DOCUMENT_KIND_LABEL, holdsAny, INVOICE_STATE_LABEL, ISO_DATE_PATTERN, type Invoice, type InvoiceQuery, type InvoiceState,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, formatDateTime, Loading, TextField } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { money } from './billing.tsx';
import { NoSuchPartner, PartnerPageHeading, scopeIdentity, useBranches, usePartnerScope, useWorkspacePartner, type ScopeContext } from './scope.tsx';

const PAGE = 50;
const STATES: InvoiceState[] = ['issued', 'paid', 'cancelled'];
const MAX_SEARCH = 100;

export const stateTone = (s: InvoiceState) => (s === 'paid' ? 'ok' : s === 'cancelled' ? 'danger' : 'warn');

/** In-house bills of this lab or clinic (`invoices.create`, `invoices.cancel`, `payments.record` or `finance.view`). */
export function InvoicesScreen() {
  const ctx = usePartnerScope();
  if (!ctx) return <NoSuchPartner />;
  // One subtree per partner: filters and pages never carry over to another partner.
  return <Invoices key={scopeIdentity(ctx)} ctx={ctx} />;
}

/** The filters as the server takes them (Q10 `invoiceQuerySchema`), or the problem with the dates. */
export function billFilter(f: { state: string; branchId: string; from: string; to: string; q: string }):
  { query: InvoiceQuery; error: string | null } {
  const from = f.from.trim();
  const to = f.to.trim();
  if ((from && !ISO_DATE_PATTERN.test(from)) || (to && !ISO_DATE_PATTERN.test(to))) return { query: {}, error: 'Choose valid dates.' };
  if (from && to && from > to) return { query: {}, error: 'The “from” date is after the “to” date.' };
  const q = f.q.trim().slice(0, MAX_SEARCH);
  return {
    query: {
      state: (f.state || undefined) as InvoiceState | undefined, branchId: f.branchId || undefined,
      from: from || undefined, to: to || undefined, q: q || undefined, limit: PAGE,
    },
    error: null,
  };
}

function Invoices({ ctx }: { ctx: ScopeContext }) {
  const partner = useWorkspacePartner(ctx);
  const branches = useBranches(ctx);
  const [f, setF] = useState({ state: '', branchId: '', from: '', to: '', q: '' });
  const [search, setSearch] = useState('');
  const { query, error } = billFilter(f);
  const list = useInfiniteQuery({
    queryKey: [...ctx.key, 'invoices', query],
    queryFn: ({ pageParam }) => ctx.billing.invoices({ ...query, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    // Q10: the server's exact cursor (`<ms>_<id>`): nothing is skipped or repeated.
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !error,
  });
  const names = new Map((branches.data ?? []).map((b) => [b._id, b.name]));
  const rows: Invoice[] = (list.data?.pages ?? []).flatMap((p) => p.items);
  const total = list.data?.pages[0]?.total;
  const canCreate = holdsAny(ctx.actor, ['invoices.create']);
  const readOnly = !holdsAny(ctx.actor, ['invoices.create', 'invoices.cancel', 'payments.record']);
  const filtered = !!(query.state || query.branchId || query.from || query.to || query.q);

  function applySearch(e: FormEvent) {
    e.preventDefault();
    setF((x) => ({ ...x, q: search }));
  }

  return (
    <>
      <PartnerPageHeading ctx={ctx} title="Bills" partnerName={partner.data?.name}>
        Bills issued at the counter, newest first.{readOnly ? ' You can view bills and their PDFs.' : ''}
      </PartnerPageHeading>
      {canCreate && <div><Link className="j-btn j-btn--primary" to={`${ctx.link('invoices')}/new`}>New bill</Link></div>}
      <form className="ws-search" role="search" aria-label="Find bills" onSubmit={applySearch}>
        <TextField label="Bill number, customer name or phone" type="search" maxLength={MAX_SEARCH} value={search} onChange={(e) => setSearch(e.target.value)} />
        <Button type="submit" variant="secondary">Search</Button>
      </form>
      <div className="ws-search">
        <div className="j-field ws-filter">
          <label htmlFor="inv-state">Status</label>
          <select id="inv-state" value={f.state} onChange={(e) => setF((x) => ({ ...x, state: e.target.value }))}>
            <option value="">All</option>
            {STATES.map((s) => <option key={s} value={s}>{INVOICE_STATE_LABEL[s]}</option>)}
          </select>
        </div>
        <div className="j-field ws-filter">
          <label htmlFor="inv-branch">Branch</label>
          <select id="inv-branch" value={f.branchId} onChange={(e) => setF((x) => ({ ...x, branchId: e.target.value }))}>
            <option value="">All your branches</option>
            {(branches.data ?? []).map((b) => <option key={b._id} value={b._id}>{b.name}</option>)}
          </select>
        </div>
        <TextField label="Issued from" type="date" value={f.from} onChange={(e) => setF((x) => ({ ...x, from: e.target.value }))} />
        <TextField label="Issued to" type="date" value={f.to} onChange={(e) => setF((x) => ({ ...x, to: e.target.value }))} />
      </div>
      {error ? <Alert>{error}</Alert>
        : list.isPending ? <Loading label="Loading bills…" />
        : list.isError && !list.data ? <ErrorState message={messageOf(list.error)} onRetry={() => void list.refetch()} />
        : rows.length === 0 ? <Empty title="No bills">{filtered ? 'No bill matches these filters.' : canCreate ? 'Bills you issue appear here.' : null}</Empty>
        : (
          <>
            {total !== undefined && <p className="ws-count">{total === 1 ? '1 bill' : `${total} bills`}{filtered ? ' match' : ''} · showing {rows.length}</p>}
            <div className="ws-table-wrap">
              <table className="j-table">
                <caption className="j-sr-only">Bills</caption>
                <thead>
                  <tr><th scope="col">Bill</th><th scope="col">Issued</th><th scope="col">Customer</th><th scope="col">Branch</th><th scope="col">Type</th><th scope="col">Total</th><th scope="col">Status</th></tr>
                </thead>
                <tbody>
                  {rows.map((inv) => (
                    <tr key={inv._id}>
                      <td><Link to={`${ctx.link('invoices')}/${inv._id}`}>{inv.serial}</Link></td>
                      <td>{formatDateTime(inv.issuedAt)}</td>
                      <td>{inv.customer?.name}</td>
                      <td>{names.get(inv.branchId) ?? `Branch …${inv.branchId.slice(-6)}`}</td>
                      <td>{DOCUMENT_KIND_LABEL[inv.documentKind] ?? inv.documentKind}</td>
                      <td>{money(inv.totals?.totalMinor)}</td>
                      <td><Badge tone={stateTone(inv.lifecycleState)}>{INVOICE_STATE_LABEL[inv.lifecycleState] ?? inv.lifecycleState}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {list.isFetchNextPageError && <ErrorState message={`Could not load older bills: ${messageOf(list.error)}`} onRetry={() => void list.fetchNextPage()} />}
            {list.hasNextPage && <div><Button variant="secondary" busy={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>Show older bills</Button></div>}
          </>
        )}
    </>
  );
}
