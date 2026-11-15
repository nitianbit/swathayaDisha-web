import { useMemo, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  DOCUMENT_KIND_LABEL, holdsAny, INVOICE_STATE_LABEL, type Invoice, type InvoiceQuery, type InvoiceState,
} from '@jansetu/api';
import { Badge, Button, Empty, ErrorState, formatDateTime, Loading, TextField } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { endOfIstDay, money } from './billing.tsx';
import { NoSuchPartner, PartnerPageHeading, usePartnerScope, useWorkspacePartner, type ScopeContext } from './scope.tsx';
import { useBranches } from './StaffScreen.tsx';

const PAGE = 50;
const STATES: InvoiceState[] = ['issued', 'paid', 'cancelled'];

export const stateTone = (s: InvoiceState) => (s === 'paid' ? 'ok' : s === 'cancelled' ? 'danger' : 'warn');

/**
 * The next `before` for "older bills". The server drops the milliseconds of `before` and compares strictly, so the
 * cursor is the start of the NEXT whole second after the last row: nothing is skipped, and rows already shown come back
 * and are dropped by id.
 */
export function nextCursor(page: readonly Pick<Invoice, 'issuedAt'>[]): string | undefined {
  if (page.length < PAGE) return undefined;
  const last = Date.parse(page[page.length - 1]!.issuedAt);
  if (Number.isNaN(last)) return undefined;
  return new Date(Math.floor(last / 1000) * 1000 + 1000).toISOString();
}

/** In-house bills of this lab or clinic (`invoices.create`, `invoices.cancel`, `payments.record` or `finance.view`). */
export function InvoicesScreen() {
  const ctx = usePartnerScope();
  if (!ctx) return <NoSuchPartner />;
  return <Invoices ctx={ctx} />;
}

/** All bills of a newest-first, cursor-paged list, without the repeats of a shared second; and whether paging is stuck. */
export function mergePages(pages: readonly Invoice[][]): { rows: Invoice[]; stuck: boolean } {
  const seen = new Set<string>();
  const rows: Invoice[] = [];
  let stuck = false;
  pages.forEach((p, i) => {
    let added = 0;
    for (const r of p) if (!seen.has(r._id)) { seen.add(r._id); rows.push(r); added++; }
    if (i > 0 && added === 0 && p.length >= PAGE) stuck = true;
  });
  return { rows, stuck };
}

function Invoices({ ctx }: { ctx: ScopeContext }) {
  const partner = useWorkspacePartner(ctx);
  const branches = useBranches(ctx);
  const [state, setState] = useState<'' | InvoiceState>('');
  const [branchId, setBranchId] = useState('');
  const [onOrBefore, setOnOrBefore] = useState('');
  const before = onOrBefore ? endOfIstDay(onOrBefore) ?? undefined : undefined;
  const filter: InvoiceQuery = { state: state || undefined, branchId: branchId || undefined, before, limit: PAGE };
  const list = useInfiniteQuery({
    queryKey: [...ctx.key, 'invoices', filter],
    queryFn: ({ pageParam }) => ctx.billing.invoices({ ...filter, before: pageParam ?? filter.before }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => nextCursor(last),
  });
  const names = useMemo(() => new Map((branches.data ?? []).map((b) => [b._id, b.name])), [branches.data]);
  const merged = useMemo(() => mergePages(list.data?.pages ?? []), [list.data]);
  const canCreate = holdsAny(ctx.actor, ['invoices.create']);
  const readOnly = !holdsAny(ctx.actor, ['invoices.create', 'invoices.cancel', 'payments.record']);

  return (
    <>
      <PartnerPageHeading ctx={ctx} title="Bills" partnerName={partner.data?.name}>
        Bills issued at the counter, newest first.{readOnly ? ' You can view bills and their PDFs.' : ''}
      </PartnerPageHeading>
      {canCreate && <div><Link className="j-btn j-btn--primary" to={`${ctx.link('invoices')}/new`}>New bill</Link></div>}
      <div className="ws-search">
        <div className="j-field ws-filter">
          <label htmlFor="inv-state">Status</label>
          <select id="inv-state" value={state} onChange={(e) => setState(e.target.value as '' | InvoiceState)}>
            <option value="">All</option>
            {STATES.map((s) => <option key={s} value={s}>{INVOICE_STATE_LABEL[s]}</option>)}
          </select>
        </div>
        <div className="j-field ws-filter">
          <label htmlFor="inv-branch">Branch</label>
          <select id="inv-branch" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            <option value="">All your branches</option>
            {(branches.data ?? []).map((b) => <option key={b._id} value={b._id}>{b.name}</option>)}
          </select>
        </div>
        <TextField label="Issued on or before" type="date" value={onOrBefore} onChange={(e) => setOnOrBefore(e.target.value)} />
      </div>
      {list.isPending ? <Loading label="Loading bills…" />
        : list.isError && !list.data ? <ErrorState message={messageOf(list.error)} onRetry={() => void list.refetch()} />
        : merged.rows.length === 0 ? <Empty title="No bills">{state || branchId || before ? 'No bill matches these filters.' : canCreate ? 'Bills you issue appear here.' : null}</Empty>
        : (
          <>
            <div className="ws-table-wrap">
              <table className="j-table">
                <caption className="j-sr-only">Bills</caption>
                <thead>
                  <tr><th scope="col">Bill</th><th scope="col">Issued</th><th scope="col">Customer</th><th scope="col">Branch</th><th scope="col">Type</th><th scope="col">Total</th><th scope="col">Status</th></tr>
                </thead>
                <tbody>
                  {merged.rows.map((inv) => (
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
            {merged.stuck ? <p className="ws-muted">More bills share one second than can be listed; use the date filter to see older ones.</p>
              : list.hasNextPage && <div><Button variant="secondary" busy={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>Show older bills</Button></div>}
          </>
        )}
    </>
  );
}
