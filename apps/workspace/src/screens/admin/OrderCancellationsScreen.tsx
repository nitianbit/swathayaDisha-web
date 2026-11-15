import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { adminQueuesApi, pharmacyOrdersApi, refId, type PharmacyOrder } from '@jansetu/api';
import { Badge, Button, Empty, ErrorState, formatDateTime, formatRupees, Loading } from '@jansetu/ui';
import { CancelRequestPanel } from '../../components/CancelRequestPanel.tsx';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession } from '../../session.tsx';
import { ORDER_STATUS_LABEL, orderLabel, PAYMENT_STATUS_LABEL } from '../pharmacy/orderLabels.ts';

const PAGE_SIZE = 20;

/**
 * D3: paid pharmacy orders whose cancellation waits for a decision. An admin (or the selling pharmacy, in its own
 * workspace) approves - the order is cancelled, its stock returned and the customer refunded - or keeps the order.
 */
export function OrderCancellationsScreen() {
  const { api } = useSession();
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);
  const q = useQuery({
    queryKey: ['pharmacy-orders', 'admin-cancellations', page],
    queryFn: () => adminQueuesApi(api).orderCancellations({ page, limit: PAGE_SIZE }),
    refetchInterval: 60_000,
  });
  // Deciding the last request of the last page shrinks the queue: go back to the new last page instead of an empty one.
  const lastPage = Math.max(1, q.data?.totalPages ?? 1);
  useEffect(() => {
    if (q.data && page > lastPage) setParams(lastPage > 1 ? { page: String(lastPage) } : {}, { replace: true });
  }, [q.data, page, lastPage, setParams]);
  const pending = q.data?.items.filter((o) => o.status === 'pending_cancel' && o.cancelRequest?.state === 'pending') ?? [];

  return (
    <>
      <PageHeading title="Order cancellations">
        Paid pharmacy orders the customer or a pharmacy asked to cancel. Nothing moves until someone decides.
      </PageHeading>
      {q.isPending ? <Loading label="Loading cancellation requests…" />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : pending.length === 0 && page === 1 ? <Empty title="No cancellation requests waiting" />
        : (
          <>
            <p className="ws-count" aria-live="polite">{q.data.total} waiting for a decision</p>
            <ul className="stock-list">
              {pending.map((o) => <OrderCancellationCard key={`${o._id}:${o.cancelRequest!.requestId}`} order={o} />)}
            </ul>
            {(q.data.totalPages > 1 || page > 1) && (
              <nav className="ws-pager" aria-label="Pages">
                <Button variant="secondary" disabled={page <= 1}
                  onClick={() => setParams(page - 1 > 1 ? { page: String(page - 1) } : {})}>Previous</Button>
                <span>Page {page} of {lastPage}</span>
                <Button variant="secondary" disabled={page >= lastPage}
                  onClick={() => setParams({ page: String(page + 1) })}>Next</Button>
              </nav>
            )}
          </>
        )}
    </>
  );
}

function OrderCancellationCard({ order }: { order: PharmacyOrder }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const orders = pharmacyOrdersApi(api);
  const pharmacyId = refId(order.pharmacyId) ?? '';
  const populated = typeof order.pharmacyId === 'object' && order.pharmacyId?.name ? order.pharmacyId.name : undefined;
  const pharmacy = useQuery({
    queryKey: ['pharmacies', 'name', pharmacyId],
    queryFn: () => adminQueuesApi(api).pharmacyName(pharmacyId),
    enabled: !populated && pharmacyId !== '',
    staleTime: 10 * 60_000,
  });
  const customer = order.customerId && typeof order.customerId === 'object' ? order.customerId : null;
  const r = order.cancelRequest!;

  /** Every decision re-reads the queue afterwards; the server's record is the truth, also after a 409. */
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } finally {
      await queryClient.invalidateQueries({ queryKey: ['pharmacy-orders'] });
    }
  };

  return (
    <li className="ws-section">
      <div className="stock-head">
        <h2>Order {orderLabel(order)}</h2>
        <span>{formatRupees(order.grandTotal)} · {order.paymentMode ? order.paymentMode.replace(/_/g, ' ') : '—'}</span>
        <Badge tone={order.paymentStatus === 'paid' ? 'ok' : 'warn'}>
          {PAYMENT_STATUS_LABEL[order.paymentStatus ?? 'pending'] ?? order.paymentStatus}
        </Badge>
      </div>
      <dl className="ws-dl">
        <dt>Pharmacy</dt><dd>{populated ?? pharmacy.data ?? (pharmacy.isPending && !populated ? '…' : 'Unknown pharmacy')}</dd>
        <dt>Customer</dt><dd>{customer ? [customer.name, customer.phone].filter(Boolean).join(' · ') || '—' : '—'}</dd>
        <dt>Placed</dt><dd>{formatDateTime(order.createdAt)}</dd>
        <dt>Was</dt><dd>{ORDER_STATUS_LABEL[r.fromStatus] ?? r.fromStatus}</dd>
        <dt>Medicines</dt>
        <dd>{order.items.map((it) => `${it.medicineName ?? 'Medicine'} × ${it.orderedQty}`).join(', ') || '—'}</dd>
      </dl>
      <CancelRequestPanel order={order} viewer="admin" headingLevel={3}
        onApprove={(requestId, note) => act(() => orders.approveCancel(order._id, requestId, note || undefined))}
        onReject={(requestId, note) => act(() => orders.rejectCancel(order._id, requestId, note))} />
    </li>
  );
}
