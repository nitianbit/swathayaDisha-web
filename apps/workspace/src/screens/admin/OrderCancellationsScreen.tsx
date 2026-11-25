import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { adminQueuesApi, pharmacyOrdersApi, refId, type PharmacyOrder } from '@jansetu/api';
import { Badge, Button, Empty, ErrorState, formatDateTime, formatRupees, Loading } from '@jansetu/ui';
import { CancelRequestPanel } from '../../components/CancelRequestPanel.tsx';
import { messageOf } from '../../errors.ts';
import { t } from '../../i18n/admin/index.ts';
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
  // Only on this page's own settled answer: a cached total from an earlier visit must not bounce a fresh "Next".
  const settled = q.isSuccess && !q.isFetching;
  useEffect(() => {
    if (settled && page > lastPage) setParams(lastPage > 1 ? { page: String(lastPage) } : {}, { replace: true });
  }, [settled, page, lastPage, setParams]);
  const pending = q.data?.items.filter((o) => o.status === 'pending_cancel' && o.cancelRequest?.state === 'pending') ?? [];

  return (
    <>
      <PageHeading title={t('orderCancellations.title')}>{t('orderCancellations.intro')}</PageHeading>
      {q.isPending ? <Loading label={t('orderCancellations.loading')} />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : pending.length === 0 && page === 1 ? <Empty title={t('orderCancellations.none')} />
        : (
          <>
            <p className="ws-count" aria-live="polite">{t('orderCancellations.count', { count: q.data.total })}</p>
            <ul className="stock-list">
              {pending.map((o) => <OrderCancellationCard key={`${o._id}:${o.cancelRequest!.requestId}`} order={o} />)}
            </ul>
            {(q.data.totalPages > 1 || page > 1) && (
              <nav className="ws-pager" aria-label={t('common.pages')}>
                <Button variant="secondary" disabled={page <= 1}
                  onClick={() => setParams(page - 1 > 1 ? { page: String(page - 1) } : {})}>{t('common.previous')}</Button>
                <span>{t('common.pageOf', { page, lastPage })}</span>
                <Button variant="secondary" disabled={page >= lastPage}
                  onClick={() => setParams({ page: String(page + 1) })}>{t('common.next')}</Button>
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
        <h2>{t('orderCancellations.order', { order: orderLabel(order) })}</h2>
        <span>{formatRupees(order.grandTotal)} · {order.paymentMode ? order.paymentMode.replace(/_/g, ' ') : '—'}</span>
        <Badge tone={order.paymentStatus === 'paid' ? 'ok' : 'warn'}>
          {PAYMENT_STATUS_LABEL[order.paymentStatus ?? 'pending'] ?? order.paymentStatus}
        </Badge>
      </div>
      <dl className="ws-dl">
        <dt>{t('orderCancellations.pharmacy')}</dt><dd>{populated ?? pharmacy.data ?? (pharmacy.isPending && !populated ? '…' : t('orderCancellations.unknownPharmacy'))}</dd>
        <dt>{t('orderCancellations.customer')}</dt><dd>{customer ? [customer.name, customer.phone].filter(Boolean).join(' · ') || '—' : '—'}</dd>
        <dt>{t('orderCancellations.placed')}</dt><dd>{formatDateTime(order.createdAt)}</dd>
        <dt>{t('orderCancellations.was')}</dt><dd>{ORDER_STATUS_LABEL[r.fromStatus] ?? r.fromStatus}</dd>
        <dt>{t('orderCancellations.medicines')}</dt>
        <dd>{order.items.map((it) => `${it.medicineName ?? t('orderCancellations.medicine')} × ${it.orderedQty}`).join(', ') || '—'}</dd>
      </dl>
      {/* i18n-ignore: `viewer` is a role code, not words. */}
      <CancelRequestPanel order={order} viewer="admin" headingLevel={3}
        onApprove={(requestId, note) => act(() => orders.approveCancel(order._id, requestId, note || undefined))}
        onReject={(requestId, note) => act(() => orders.rejectCancel(order._id, requestId, note))} />
    </li>
  );
}
