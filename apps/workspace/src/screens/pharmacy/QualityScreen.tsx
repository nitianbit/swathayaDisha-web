import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  formatExpiry, inventoryApi, pharmacyOrdersApi, REALLOCATABLE_ORDER_STATUSES, type ImpactedOrder,
} from '@jansetu/api';
import { Badge, Empty, ErrorState, formatDateTime, Loading } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession } from '../../session.tsx';
import { ORDER_STATUS_LABEL } from './orderLabels.ts';
import { BATCH_STATUS_LABEL } from './StockScreen.tsx';

/** Quality worklist (P3/P3b): open orders holding units of held batches, the held batches, and supplier returns. */
export function QualityScreen() {
  return (
    <>
      <PageHeading title="Quality">Orders that hold quarantined or recalled stock, the batches on hold, and returns to suppliers.</PageHeading>
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
      <h2 id="held-orders-h">Orders holding held stock</h2>
      {q.isPending ? <Loading />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : q.data.length === 0 ? <Empty title="No open order holds quarantined or recalled stock" />
        : (
          <ul className="ws-list held-orders">
            {q.data.map((o) => <HeldOrder key={o.orderId} order={o} onChanged={after} />)}
          </ul>
        )}
      {q.data && q.data.length >= 200 && <span className="ws-muted">Showing the first 200 orders.</span>}
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
        <Link to={`/pharmacy/orders/${order.orderId}`}>Order {order.orderNumber ?? order.orderId.slice(-8)}</Link>{' '}
        <Badge>{ORDER_STATUS_LABEL[order.status] ?? order.status}</Badge>
      </div>
      <div className="ws-muted">
        {order.heldUnits.map((u) => `${u.medicineName ?? u.medicineId} × ${u.quantity} from batch ${u.batchNumber}`).join('; ')}
      </div>
      <div className="ws-actions">
        {swappable ? (
          <ConfirmAction label="Swap to good stock" confirmLabel="Swap batches"
            consequence="The held units are replaced with units from sellable batches of the same medicines. The order keeps its status."
            onConfirm={() => run(() => orders.reallocateHeldStock(order.orderId))} />
        ) : <span className="ws-muted">This order is {ORDER_STATUS_LABEL[order.status]?.toLowerCase()}; its stock can no longer be swapped.</span>}
        <ConfirmAction label="Cancel order" confirmLabel="Cancel order" danger reason reasonLabel="Reason (the customer sees it)"
          consequence="The order is cancelled and its stock is released. If it was paid, the customer is refunded."
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
      <h2 id="held-batches-h">Batches on hold</h2>
      {q.isPending ? <Loading />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : q.data.items.length === 0 ? <Empty title="No batch is quarantined, recalled or expired" />
        : (
          <div className="ws-table-wrap">
            <table className="j-table">
              <thead><tr><th scope="col">Medicine</th><th scope="col">Batch</th><th scope="col">Expiry</th><th scope="col">Status</th><th scope="col">Unreserved</th><th scope="col">Reserved</th></tr></thead>
              <tbody>
                {q.data.items.map((r) => (
                  <tr key={r.batchId}>
                    <td>{r.medicineName
                      ? <Link to={`/pharmacy/stock?q=${encodeURIComponent(r.medicineName)}`}>{r.medicineName}</Link> : r.medicineId}</td>
                    <td>{r.batchNumberRaw ?? '—'}</td>
                    <td>{formatExpiry(r.expiryDateRaw)}</td>
                    <td><Badge tone="danger">{BATCH_STATUS_LABEL[r.storedQualityStatus] ?? r.storedQualityStatus}</Badge></td>
                    <td>{r.availableQty}</td>
                    <td>{r.reservedQty}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      {q.data && q.data.total > q.data.items.length && <span className="ws-muted">Showing {q.data.items.length} of {q.data.total}.</span>}
    </section>
  );
}

function SupplierReturns() {
  const { api } = useSession();
  const q = useQuery({ queryKey: ['pharmacy-inventory', 'supplier-returns'], queryFn: () => inventoryApi(api).supplierReturns({ limit: 20 }) });
  return (
    <section className="ws-section" aria-labelledby="returns-h">
      <h2 id="returns-h">Recent returns to suppliers</h2>
      {q.isPending ? <Loading />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : q.data.items.length === 0 ? <Empty title="No returns to suppliers yet" />
        : (
          <ul className="ws-list">
            {q.data.items.map((r) => (
              <li key={r._id}>{formatDateTime(r.createdAt)} · batch {r.batchNumber} · {r.quantity} units · {r.reason.replace(/_/g, ' ')}
                {r.notes && <> · “{r.notes}”</>}</li>
            ))}
          </ul>
        )}
    </section>
  );
}
