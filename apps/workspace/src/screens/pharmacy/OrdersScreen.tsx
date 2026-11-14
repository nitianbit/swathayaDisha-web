import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { pharmacyOrdersApi, refId, type OrderStatus, type PharmacyOrder } from '@jansetu/api';
import { Badge, Button, Empty, ErrorState, formatDateTime, formatRupees, Loading } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession, useStaff } from '../../session.tsx';
import { ORDER_STATUS_LABEL, orderLabel, PAYMENT_STATUS_LABEL } from './orderLabels.ts';

const PAGE_SIZE = 20;
const STATUSES = Object.keys(ORDER_STATUS_LABEL) as OrderStatus[];

const customerName = (o: PharmacyOrder) =>
  o.customerId && typeof o.customerId === 'object' && o.customerId.name ? o.customerId.name : '—';

/** Every order this pharmacy sells or buys (the backend scopes the list); newest first. */
export function OrdersScreen() {
  const { api } = useSession();
  const staff = useStaff();
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);
  const raw = params.get('status');
  const status = raw && (STATUSES as string[]).includes(raw) ? (raw as OrderStatus) : undefined;

  const q = useQuery({
    queryKey: ['pharmacy-orders', 'list', status ?? 'all', page],
    queryFn: () => pharmacyOrdersApi(api).list({ status, page, limit: PAGE_SIZE }),
    refetchInterval: 60_000,
  });

  const go = (next: { status?: string; page?: number }) => {
    const p: Record<string, string> = {};
    const s = next.status ?? status;
    if (s) p.status = s;
    if (next.page && next.page > 1) p.page = String(next.page);
    setParams(p);
  };

  return (
    <>
      <PageHeading title="Orders">Move orders along, record payments and handle delivery problems.</PageHeading>
      <div className="j-field ws-filter">
        <label htmlFor="status-filter">Status</label>
        <select id="status-filter" value={status ?? ''} onChange={(e) => go({ status: e.target.value || '', page: 1 })}>
          <option value="">All orders</option>
          {STATUSES.map((s) => <option key={s} value={s}>{ORDER_STATUS_LABEL[s]}</option>)}
        </select>
      </div>
      {q.isPending ? <Loading label="Loading orders…" />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : q.data.items.length === 0 ? (
          <Empty title={status ? `No ${ORDER_STATUS_LABEL[status].toLowerCase()} orders` : 'No orders yet'} />
        ) : (
          <>
            <p className="ws-count" aria-live="polite">{q.data.total} orders</p>
            <div className="ws-table-wrap">
              <table className="j-table">
                <thead>
                  <tr>
                    <th scope="col">Order</th>
                    <th scope="col">Placed</th>
                    <th scope="col">Customer</th>
                    <th scope="col">Status</th>
                    <th scope="col">Payment</th>
                    <th scope="col">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.items.map((o) => (
                    <tr key={o._id}>
                      <td>
                        <Link to={`/pharmacy/orders/${o._id}`}>{orderLabel(o)}</Link>
                        {refId(o.pharmacyId) !== staff.id && <> <Badge tone="warn">Buying</Badge></>}
                      </td>
                      <td>{formatDateTime(o.createdAt)}</td>
                      <td>{customerName(o)}</td>
                      <td><Badge>{ORDER_STATUS_LABEL[o.status] ?? o.status}</Badge></td>
                      <td>
                        <Badge tone={o.paymentStatus === 'paid' ? 'ok' : undefined}>
                          {PAYMENT_STATUS_LABEL[o.paymentStatus ?? 'pending'] ?? o.paymentStatus}
                        </Badge>
                      </td>
                      <td>{formatRupees(o.grandTotal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {q.data.totalPages > 1 && (
              <nav className="ws-pager" aria-label="Pages">
                <Button variant="secondary" disabled={page <= 1} onClick={() => go({ page: page - 1 })}>Previous</Button>
                <span>Page {page} of {q.data.totalPages}</span>
                <Button variant="secondary" disabled={page >= q.data.totalPages} onClick={() => go({ page: page + 1 })}>Next</Button>
              </nav>
            )}
          </>
        )}
    </>
  );
}
