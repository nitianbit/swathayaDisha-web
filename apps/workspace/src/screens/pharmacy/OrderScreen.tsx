import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import {
  DELIVERY_EXCEPTION_FROM, ORDER_TRANSITIONS, pharmacyOrdersApi, refId,
  type DeliveryExceptionType, type OrderStatus, type PharmacyOrder,
} from '@jansetu/api';
import { Alert, Badge, Empty, ErrorState, formatDateTime, formatRupees, Loading } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession, useStaff } from '../../session.tsx';
import { CustomerReturnForm } from './CustomerReturnForm.tsx';
import {
  blockedReason, DELIVERY_EXCEPTION_LABEL, FORWARD_LABEL, holdsMoney, ORDER_STATUS_LABEL, orderLabel,
  PAYMENT_STATUS_LABEL, REFUND_STATUS_LABEL, TERMINAL,
} from './orderLabels.ts';

export function OrderScreen() {
  const { orderId = '' } = useParams();
  if (!/^[0-9a-fA-F]{24}$/.test(orderId)) {
    return <Empty title="Order not found"><Link to="/pharmacy/orders">Back to orders</Link></Empty>;
  }
  return <OrderLoader key={orderId} orderId={orderId} />;
}

function OrderLoader({ orderId }: { orderId: string }) {
  const { api } = useSession();
  const q = useQuery({ queryKey: ['pharmacy-orders', 'detail', orderId], queryFn: () => pharmacyOrdersApi(api).get(orderId) });
  return (
    <>
      <Link to="/pharmacy/orders" className="ws-back"><ArrowLeft size={16} aria-hidden="true" /> Orders</Link>
      {q.isPending ? <Loading label="Loading order…" />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : <OrderView order={q.data} />}
    </>
  );
}

function OrderView({ order }: { order: PharmacyOrder }) {
  const { api } = useSession();
  const staff = useStaff();
  const queryClient = useQueryClient();
  const orders = pharmacyOrdersApi(api);
  const seller = refId(order.pharmacyId) === staff.id;
  const terminal = TERMINAL.includes(order.status);

  /** Every action re-reads the order (and lists) afterwards; the server's record is the truth, also after a 409. */
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } finally {
      await queryClient.invalidateQueries({ queryKey: ['pharmacy-orders'] });
    }
  };

  const forward = ORDER_TRANSITIONS[order.status].filter((s) => FORWARD_LABEL[s]);
  const canEnd = (s: OrderStatus) => ORDER_TRANSITIONS[order.status].includes(s);
  const exceptions = (Object.keys(DELIVERY_EXCEPTION_FROM) as DeliveryExceptionType[])
    .filter((t) => DELIVERY_EXCEPTION_FROM[t].includes(order.status));
  const canMarkPaid = (order.paymentMode === 'in_store_payment' || order.paymentMode === 'cash_on_delivery')
    && order.paymentStatus !== 'paid' && !terminal;

  return (
    <>
      <PageHeading title={`Order ${orderLabel(order)}`}>
        Placed {formatDateTime(order.createdAt)} · {formatRupees(order.grandTotal)} ·{' '}
        <Badge>{ORDER_STATUS_LABEL[order.status] ?? order.status}</Badge>{' '}
        <Badge tone={order.paymentStatus === 'paid' ? 'ok' : undefined}>
          {PAYMENT_STATUS_LABEL[order.paymentStatus ?? 'pending'] ?? order.paymentStatus}
        </Badge>
        {order.refill && <> <Badge tone="warn">Refill</Badge></>}
      </PageHeading>

      {!seller && <Alert tone="warn">Your pharmacy is the buyer on this order; the selling pharmacy manages it.</Alert>}

      {order.prescriptionStatus === 'pending' && seller && (
        <Alert tone="warn">
          The prescription has not been reviewed yet.{' '}
          <Link to={`/pharmacy/prescriptions/${order._id}`}>Review the prescription</Link>
        </Alert>
      )}

      <section className="ws-section" aria-labelledby="items-h">
        <h2 id="items-h">Medicines</h2>
        <div className="ws-table-wrap">
          <table className="j-table">
            <thead><tr><th scope="col">Medicine</th><th scope="col">Quantity</th><th scope="col">Batches</th><th scope="col">Amount</th></tr></thead>
            <tbody>
              {order.items.map((it, i) => (
                <tr key={`${it.medicineId}-${i}`}>
                  <td>{it.medicineName ?? it.medicineId}{it.itemStatus && it.itemStatus !== 'active' && <> <Badge>{it.itemStatus}</Badge></>}</td>
                  <td>{it.orderedQty}</td>
                  <td>{it.batchAllocations?.length
                    ? it.batchAllocations.map((b) => `${b.batchNumber} × ${b.quantity}`).join(', ') : '—'}</td>
                  <td>{formatRupees(it.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="ws-dl">
          <dt>Delivery</dt><dd>{order.deliveryMode === 'delivery' ? `Delivery${order.deliveryAddress ? ` to ${order.deliveryAddress}` : ''}` : 'Pickup at the pharmacy'}</dd>
          <dt>Payment method</dt><dd>{order.paymentMode ? order.paymentMode.replace(/_/g, ' ') : '—'}</dd>
          {order.refill && <><dt>Refill payment due</dt><dd>{formatDateTime(order.refill.paymentDueBy)}</dd></>}
        </dl>
      </section>

      {order.prescriptionRefund && <RefundPanel order={order} seller={seller} onRetry={() => act(() => orders.retryRefund(order._id))} />}

      {seller && !terminal && (
        <section className="ws-section" aria-labelledby="next-h">
          <h2 id="next-h">Next step</h2>
          <div className="ws-actions">
            {forward.map((target) => {
              const blocked = blockedReason(order, target);
              return (
                <div key={target} className="ws-action">
                  <ConfirmAction label={FORWARD_LABEL[target]!} confirmLabel={`Yes, ${FORWARD_LABEL[target]!.toLowerCase()}`}
                    disabled={blocked !== null} reason="optional" reasonLabel="Note"
                    consequence={target === 'completed' ? 'The order is closed and the stock is taken out of inventory.'
                      : `The order moves to “${ORDER_STATUS_LABEL[target]}”. The customer is notified.`}
                    onConfirm={(note) => act(() => orders.updateStatus(order._id, target, note || undefined))} />
                  {blocked && <span className="ws-muted">{blocked}</span>}
                </div>
              );
            })}
            {canMarkPaid && (
              <ConfirmAction label="Record payment" confirmLabel="Yes, payment received"
                consequence={`Record that ${formatRupees(order.grandTotal)} was received ${order.paymentMode === 'cash_on_delivery' ? 'on delivery' : 'at the counter'}.`}
                reason="optional" reasonLabel="Note"
                onConfirm={(note) => act(() => orders.markPaid(order._id, note ? { notes: note } : {}))} />
            )}
            {forward.length === 0 && exceptions.length === 0 && !canMarkPaid && (
              <span className="ws-muted">Nothing to do from “{ORDER_STATUS_LABEL[order.status]}” here.</span>
            )}
          </div>

          {exceptions.length > 0 && (
            <>
              <h3>Delivery problem</h3>
              <div className="ws-actions">
                {exceptions.map((t) => (
                  <ConfirmAction key={t} label={DELIVERY_EXCEPTION_LABEL[t]} confirmLabel={`Record: ${DELIVERY_EXCEPTION_LABEL[t].toLowerCase()}`}
                    danger={t === 'not_collected' || t === 'refused_at_door'} reason={t !== 'retry_delivery'}
                    consequence={EXCEPTION_CONSEQUENCE[t]}
                    onConfirm={(reason) => act(() => orders.deliveryException(order._id, t, reason || undefined))} />
                ))}
              </div>
            </>
          )}

          {(canEnd('rejected') || canEnd('cancelled')) && (
            <>
              <h3>End the order</h3>
              {holdsMoney(order) ? (
                <Alert tone="warn">
                  This order is {PAYMENT_STATUS_LABEL[order.paymentStatus ?? 'pending'].toLowerCase()}. Cancelling it here
                  would not refund the customer, so it is not offered. Use a delivery exception, or ask an admin.
                </Alert>
              ) : (
                <div className="ws-actions">
                  {canEnd('rejected') && (
                    <ConfirmAction label="Reject order" confirmLabel="Reject order" danger reason="optional" reasonLabel="Note"
                      consequence="The order is rejected and its stock is released. The customer is notified."
                      onConfirm={(note) => act(() => orders.updateStatus(order._id, 'rejected', note || undefined))} />
                  )}
                  {canEnd('cancelled') && (
                    <ConfirmAction label="Cancel order" confirmLabel="Cancel order" danger reason="optional" reasonLabel="Note"
                      consequence="The order is cancelled and its stock is released. The customer is notified."
                      onConfirm={(note) => act(() => orders.updateStatus(order._id, 'cancelled', note || undefined))} />
                  )}
                </div>
              )}
            </>
          )}
        </section>
      )}

      {order.deliveryExceptions && order.deliveryExceptions.length > 0 && (
        <section className="ws-section" aria-labelledby="history-h">
          <h2 id="history-h">Delivery history</h2>
          <ul className="ws-list">
            {order.deliveryExceptions.map((e, i) => (
              <li key={i}>
                <strong>{DELIVERY_EXCEPTION_LABEL[e.type]}</strong> · {formatDateTime(e.at)} ·{' '}
                {ORDER_STATUS_LABEL[e.fromStatus]} → {ORDER_STATUS_LABEL[e.toStatus]}
                {e.reason && <> · “{e.reason}”</>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {seller && order.status === 'completed' && (
        <CustomerReturnForm order={order} onDone={() => queryClient.invalidateQueries({ queryKey: ['pharmacy-orders'] })} />
      )}
    </>
  );
}

const EXCEPTION_CONSEQUENCE: Record<DeliveryExceptionType, string> = {
  delivery_failed: 'The order is marked “Delivery failed”. You can then retry, switch to pickup or record a refusal.',
  retry_delivery: 'The order goes out for delivery again.',
  switch_to_pickup: 'The customer will collect the order at the pharmacy instead.',
  not_collected: 'The order is cancelled, its stock is released and, if it was paid, the customer is refunded.',
  refused_at_door: 'The order is cancelled, its stock is released and, if it was paid, the customer is refunded.',
};

function RefundPanel({ order, seller, onRetry }: { order: PharmacyOrder; seller: boolean; onRetry: () => Promise<unknown> }) {
  const r = order.prescriptionRefund!;
  const tone = r.status === 'wallet_credited' || r.status === 'source_refunded' ? 'ok' : r.status === 'manual_review' ? 'error' : 'warn';
  return (
    <section className="ws-section" aria-labelledby="refund-h">
      <h2 id="refund-h">Refund</h2>
      <Alert tone={tone}>{REFUND_STATUS_LABEL[r.status] ?? r.status}</Alert>
      <dl className="ws-dl">
        <dt>Amount</dt><dd>{formatRupees(r.walletAmount)}</dd>
        {r.walletCreditedAt && <><dt>Credited</dt><dd>{formatDateTime(r.walletCreditedAt)}</dd></>}
        {r.lastError && <><dt>Last problem</dt><dd>{r.lastError}</dd></>}
      </dl>
      {seller && r.status === 'wallet_pending' && (
        <ConfirmAction label="Retry refund" confirmLabel="Retry now"
          consequence="Try again to credit the refund to the customer’s wallet." onConfirm={onRetry} />
      )}
    </section>
  );
}
