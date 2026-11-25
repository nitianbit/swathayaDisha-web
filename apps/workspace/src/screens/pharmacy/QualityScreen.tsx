import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  formatExpiry, inventoryApi, pharmacyOrdersApi, REALLOCATABLE_ORDER_STATUSES, type ImpactedOrder,
} from '@jansetu/api';
import { Badge, Empty, ErrorState, formatDateTime, Loading , Parts } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession } from '../../session.tsx';
import { ORDER_STATUS_LABEL } from './orderLabels.ts';
import { BATCH_STATUS_LABEL } from './StockScreen.tsx';
import { t } from '../../i18n/pharmacy/index.ts';

/** Quality worklist (P3/P3b): open orders holding units of held batches, the held batches, and supplier returns. */
export function QualityScreen() {
  return (
    <>
      <PageHeading title={t('quality.quality')}>{t('quality.ordersThatHoldQuarantinedOr')}</PageHeading>
      <HeldOrders />
      <HeldBatches />
      <SupplierReturns />
    </>
  );
}

function HeldOrders() {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['pharmacy-inventory', 'held-batch-orders'], queryFn: () => inventoryApi(api).heldBatchOrders() });
  const after = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['pharmacy-inventory'] }),
    queryClient.invalidateQueries({ queryKey: ['pharmacy-orders'] }),
  ]);
  return (
    <section className="ws-section" aria-labelledby="held-orders-h">
      <h2 id="held-orders-h">{t('quality.ordersHoldingHeldStock')}</h2>
      {q.isPending ? <Loading />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : q.data.length === 0 ? <Empty title={t('quality.noOpenOrderHoldsQuarantined')} />
        : (
          <ul className="ws-list held-orders">
            {q.data.map((o) => <HeldOrder key={o.orderId} order={o} onChanged={after} />)}
          </ul>
        )}
      {q.data && q.data.length >= 200 && <span className="ws-muted">{t('quality.showingTheFirst200Orders')}</span>}
    </section>
  );
}

function HeldOrder({ order, onChanged }: { order: ImpactedOrder; onChanged: () => Promise<unknown> }) {
  const { api } = useSession();
  const orders = pharmacyOrdersApi(api);
  const swappable = REALLOCATABLE_ORDER_STATUSES.includes(order.status);
  const run = async (fn: () => Promise<unknown>) => { try { await fn(); } finally { await onChanged(); } };
  return (
    <li>
      <div>
        <Link to={`/pharmacy/orders/${order.orderId}`}>{t('common.orderFull2', { orderNumber: order.orderNumber ?? order.orderId.slice(-8) })}</Link>{' '}
        <Badge>{ORDER_STATUS_LABEL[order.status] ?? order.status}</Badge>
      </div>
      <div className="ws-muted">
        {order.heldUnits.map((u) => t('quality.heldUnits', { name: u.medicineName ?? u.medicineId, quantity: u.quantity, batch: u.batchNumber })).join('; ')}
      </div>
      <div className="ws-actions">
        {swappable ? (
          <ConfirmAction label={t('quality.swapToGoodStock')} confirmLabel={t('quality.swapBatches')}
            consequence={t('quality.theHeldUnitsAreReplaced')}
            onConfirm={() => run(() => orders.reallocateHeldStock(order.orderId))} />
        ) : <span className="ws-muted">{t('common.thisOrderIsFull', { value: ORDER_STATUS_LABEL[order.status]?.toLowerCase() })}</span>}
        <ConfirmAction label={t('common.cancelOrder')} confirmLabel={t('common.cancelOrder')} danger reason reasonLabel={t('quality.reasonTheCustomerSeesIt')}
          consequence={t('quality.theOrderIsCancelledAnd')}
          onConfirm={(reason) => run(() => orders.stockHoldCancel(order.orderId, reason))} />
      </div>
    </li>
  );
}

function HeldBatches() {
  const { api } = useSession();
  const q = useQuery({ queryKey: ['pharmacy-inventory', 'quality-holds'], queryFn: () => inventoryApi(api).qualityHolds({ limit: 50 }) });
  return (
    <section className="ws-section" aria-labelledby="held-batches-h">
      <h2 id="held-batches-h">{t('quality.batchesOnHold')}</h2>
      {q.isPending ? <Loading />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : q.data.items.length === 0 ? <Empty title={t('quality.noBatchIsQuarantinedRecalled')} />
        : (
          <div className="ws-table-wrap">
            <table className="j-table">
              <thead><tr><th scope={'col'}>{t('common.medicine')}</th><th scope={'col'}>{t('common.batch')}</th><th scope={'col'}>{t('common.expiry')}</th><th scope={'col'}>{t('common.status')}</th><th scope={'col'}>{t('common.unreserved')}</th><th scope={'col'}>{t('common.reserved')}</th></tr></thead>
              <tbody>
                {q.data.items.map((r) => (
                  <tr key={r.batchId}>
                    <td>{r.medicineName
                      ? <Link to={`/pharmacy/stock?q=${encodeURIComponent(r.medicineName)}`}>{r.medicineName}</Link> : r.medicineId}</td>
                    <td>{r.batchNumberRaw ?? '—'}</td>
                    <td>{formatExpiry(r.expiryDateRaw)}</td>
                    <td><Badge tone="danger">{BATCH_STATUS_LABEL()[r.storedQualityStatus] ?? r.storedQualityStatus}</Badge></td>
                    <td>{r.availableQty}</td>
                    <td>{r.reservedQty}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      {q.data && q.data.total > q.data.items.length && <span className="ws-muted">{t('common.showingFull3', { length: q.data.items.length, total: q.data.total })}</span>}
    </section>
  );
}

function SupplierReturns() {
  const { api } = useSession();
  const q = useQuery({ queryKey: ['pharmacy-inventory', 'supplier-returns'], queryFn: () => inventoryApi(api).supplierReturns({ limit: 20 }) });
  return (
    <section className="ws-section" aria-labelledby="returns-h">
      <h2 id="returns-h">{t('quality.recentReturnsToSuppliers')}</h2>
      {q.isPending ? <Loading />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : q.data.items.length === 0 ? <Empty title={t('quality.noReturnsToSuppliersYet')} />
        : (
          <ul className="ws-list">
            {q.data.items.map((r) => (
              <li key={r._id}><Parts of={t.rich('quality.batchFull', { time: formatDateTime(r.createdAt), batchNumber: r.batchNumber, quantity: r.quantity, reason: r.reason.replace(/_/g, ' '), value: r.notes && <> · “{r.notes}”</> })} /></li>
            ))}
          </ul>
        )}
    </section>
  );
}
