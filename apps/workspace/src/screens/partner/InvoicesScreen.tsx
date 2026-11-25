import { useState, type FormEvent } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router';
import {
  DOCUMENT_KIND_LABEL, dueOf, holdsAny, INVOICE_STATE_LABEL, INVOICE_STATES, ISO_DATE_PATTERN, OBJECT_ID_PATTERN, type Invoice, type InvoiceQuery, type InvoiceState,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, formatDateTime, Loading, shared, TextField } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { money } from './billing.tsx';
import { NoSuchPartner, PartnerPageHeading, scopeIdentity, useBranches, usePartnerScope, useWorkspacePartner, type ScopeContext } from './scope.tsx';
import { t } from '../../i18n/partner/index.ts';

const PAGE = 50;
const STATES = INVOICE_STATES;
const MAX_SEARCH = 100;

export const stateTone = (s: InvoiceState) => (s === 'paid' ? 'ok' : s === 'cancelled' ? 'danger' : 'warn');

/** Q14: the appointment whose bills are shown, when the list was opened from an appointment or a bill (an id in page state only). */
export function appointmentFilterOf(state: unknown): string | undefined {
  const id = (state as { appointmentId?: unknown } | null)?.appointmentId;
  return typeof id === 'string' && OBJECT_ID_PATTERN.test(id) ? id : undefined;
}

/** In-house bills of this lab or clinic (`invoices.create`, `invoices.cancel`, `payments.record` or `finance.view`). */
export function InvoicesScreen() {
  const ctx = usePartnerScope();
  if (!ctx) return <NoSuchPartner />;
  // One subtree per partner: filters and pages never carry over to another partner.
  return <Invoices key={scopeIdentity(ctx)} ctx={ctx} />;
}

/** The filters as the server takes them (Q10 `invoiceQuerySchema`), or the problem with the dates. */
export function billFilter(f: { state: string; branchId: string; from: string; to: string; q: string; appointmentId?: string }):
  { query: InvoiceQuery; error: string | null } {
  const from = f.from.trim();
  const to = f.to.trim();
  if ((from && !ISO_DATE_PATTERN.test(from)) || (to && !ISO_DATE_PATTERN.test(to))) return { query: {}, error: t('invoices.badDates') };
  if (from && to && from > to) return { query: {}, error: t('invoices.fromAfterTo') };
  const q = f.q.trim().slice(0, MAX_SEARCH);
  return {
    query: {
      state: (f.state || undefined) as InvoiceState | undefined, branchId: f.branchId || undefined,
      from: from || undefined, to: to || undefined, q: q || undefined, ...(f.appointmentId ? { appointmentId: f.appointmentId } : {}), limit: PAGE,
    },
    error: null,
  };
}

function Invoices({ ctx }: { ctx: ScopeContext }) {
  const partner = useWorkspacePartner(ctx);
  const branches = useBranches(ctx);
  const location = useLocation();
  const [appointmentId, setAppointmentId] = useState(() => appointmentFilterOf(location.state));
  const [f, setF] = useState({ state: '', branchId: '', from: '', to: '', q: '' });
  const [search, setSearch] = useState('');
  const { query, error } = billFilter({ ...f, appointmentId });
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
  const filtered = !!(query.state || query.branchId || query.from || query.to || query.q || query.appointmentId);

  function applySearch(e: FormEvent) {
    e.preventDefault();
    setF((x) => ({ ...x, q: search }));
  }

  return (
    <>
      <PartnerPageHeading ctx={ctx} title={t('invoices.title')} partnerName={partner.data?.name}>
        {readOnly ? t('invoices.introReadOnly') : t('invoices.intro')}
      </PartnerPageHeading>
      {canCreate && <div><Link className="j-btn j-btn--primary" to={`${ctx.link('invoices')}/new`}>{t('invoices.new')}</Link></div>}
      {appointmentId && (
        <div className="ws-actions" role="status">
          <span>{t('invoices.forAppointment', { tail: appointmentId.slice(-6) })}</span>
          <Button variant="secondary" onClick={() => setAppointmentId(undefined)}>{t('invoices.showAll')}</Button>
        </div>
      )}
      <form className="ws-search" role="search" aria-label={t('invoices.find')} onSubmit={applySearch}>
        <TextField label={t('invoices.searchLabel')} type="search" maxLength={MAX_SEARCH} value={search} onChange={(e) => setSearch(e.target.value)} />
        <Button type="submit" variant="secondary">{shared('action.search')}</Button>
      </form>
      <div className="ws-search">
        <div className="j-field ws-filter">
          <label htmlFor="inv-state">{t('invoices.status')}</label>
          <select id="inv-state" value={f.state} onChange={(e) => setF((x) => ({ ...x, state: e.target.value }))}>
            <option value="">{t('invoices.allStates')}</option>
            {STATES.map((s) => <option key={s} value={s}>{INVOICE_STATE_LABEL[s]}</option>)}
          </select>
        </div>
        <div className="j-field ws-filter">
          <label htmlFor="inv-branch">{t('invoices.branch')}</label>
          <select id="inv-branch" value={f.branchId} onChange={(e) => setF((x) => ({ ...x, branchId: e.target.value }))}>
            <option value="">{t('invoices.allBranches')}</option>
            {(branches.data ?? []).map((b) => <option key={b._id} value={b._id}>{b.name}</option>)}
          </select>
        </div>
        <TextField label={t('invoices.issuedFrom')} type="date" value={f.from} onChange={(e) => setF((x) => ({ ...x, from: e.target.value }))} />
        <TextField label={t('invoices.issuedTo')} type="date" value={f.to} onChange={(e) => setF((x) => ({ ...x, to: e.target.value }))} />
      </div>
      {error ? <Alert>{error}</Alert>
        : list.isPending ? <Loading label={t('invoices.loading')} />
        : list.isError && !list.data ? <ErrorState message={messageOf(list.error)} onRetry={() => void list.refetch()} />
        : rows.length === 0 ? <Empty title={t('invoices.none.title')}>{filtered ? t('invoices.none.filtered') : canCreate ? t('invoices.none.canCreate') : null}</Empty>
        : (
          <>
            {total !== undefined && <p className="ws-count">{t(filtered ? 'invoices.countMatch' : 'invoices.count', { count: total, shown: rows.length })}</p>}
            <div className="ws-table-wrap">
              <table className="j-table">
                <caption className="j-sr-only">{t('invoices.caption')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('invoices.col.bill')}</th><th scope="col">{t('invoices.col.issued')}</th><th scope="col">{t('invoices.col.customer')}</th>
                    <th scope="col">{t('invoices.col.branch')}</th><th scope="col">{t('invoices.col.type')}</th><th scope="col">{t('invoices.col.total')}</th>
                    <th scope="col">{t('invoices.col.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((inv) => (
                    <tr key={inv._id}>
                      <td><Link to={`${ctx.link('invoices')}/${inv._id}`}>{inv.serial}</Link></td>
                      <td>{formatDateTime(inv.issuedAt)}</td>
                      <td>{inv.customer?.name}</td>
                      <td>{names.get(inv.branchId) ?? t('common.branchById', { tail: inv.branchId.slice(-6) })}</td>
                      <td>{DOCUMENT_KIND_LABEL[inv.documentKind] ?? inv.documentKind}</td>
                      <td>{money(inv.totals?.totalMinor)}</td>
                      <td>
                        <Badge tone={stateTone(inv.lifecycleState)}>{INVOICE_STATE_LABEL[inv.lifecycleState] ?? inv.lifecycleState}</Badge>
                        {inv.lifecycleState === 'partly_paid' && <div className="ws-muted">{t('invoices.due', { amount: money(dueOf(inv)) })}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {list.isFetchNextPageError && <ErrorState message={t('invoices.olderFailed', { reason: messageOf(list.error) })} onRetry={() => void list.fetchNextPage()} />}
            {list.hasNextPage && <div><Button variant="secondary" busy={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>{t('invoices.showOlder')}</Button></div>}
          </>
        )}
    </>
  );
}
