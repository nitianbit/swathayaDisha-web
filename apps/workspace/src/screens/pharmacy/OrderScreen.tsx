import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import {
  cancelRefusal, DELIVERY_EXCEPTION_FROM, ORDER_TRANSITIONS, pharmacyOrdersApi, refId,
  type DeliveryExceptionType, type PharmacyOrder,
} from '@jansetu/api';
import { Alert, Badge, Empty, ErrorState, formatDateTime, formatRupees, Loading , Parts } from '@jansetu/ui';
import { CancelRequestPanel } from '../../components/CancelRequestPanel.tsx';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession, useStaff } from '../../session.tsx';
import { CustomerReturnForm } from './CustomerReturnForm.tsx';
import {
  blockedReason, canMarkPaid, DELIVERY_EXCEPTION_LABEL, FORWARD_LABEL, ORDER_STATUS_LABEL, orderLabel,
  PAYMENT_STATUS_LABEL, REFUND_STATUS_LABEL, TERMINAL,
} from './orderLabels.ts';
import { t } from '../../i18n/pharmacy/index.ts';

export function OrderScreen() {
  const { orderId = '' } = useParams();
  if (!/^[0-9a-fA-F]{24}$/.test(orderId)) {
    return <Empty title={t('common.orderNotFound')}><Link to="/pharmacy/orders">{t('order.backToOrders')}</Link></Empty>;
  }
  return <OrderLoader key={orderId} orderId={orderId} />;
}

function OrderLoader({ orderId }: { orderId: string }) {
  const { api } = useSession();
  const q = useQuery({ queryKey: ['pharmacy-orders', 'detail', orderId], queryFn: () => pharmacyOrdersApi(api).get(orderId) });
  return (
    <>
      <Link to="/pharmacy/orders" className="ws-back"><ArrowLeft size={16} aria-hidden="true" />{` ${t('order.orders')}`}</Link>
      {q.isPending ? <Loading label={t('common.loadingOrder')} />
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

  const forward = ORDER_TRANSITIONS[order.status].filter((s) => FORWARD_LABEL()[s]);
  const exceptions = (Object.keys(DELIVERY_EXCEPTION_FROM) as DeliveryExceptionType[])
    .filter((ex) => DELIVERY_EXCEPTION_FROM[ex].includes(order.status));
  const markable = canMarkPaid(order);
  const unpaid = !order.paymentStatus || order.paymentStatus === 'pending' || order.paymentStatus === 'failed';
  // D3 (`requestCancel`): Placed, Accepted or Packed; unpaid → cancelled at once, money held → waits for a decision.
  // The generic status update refuses to close a paid order (ORDER_PAID_USE_CANCEL_REQUEST), so this is the only way.
  const cancelBlock = cancelRefusal(order);
  const canRequestCancel = cancelBlock === null;

  return (
    <>
      <PageHeading title={t('common.order2', { value: orderLabel(order) })}><Parts of={t.rich('common.placedFull', { time: formatDateTime(order.createdAt), amount: formatRupees(order.grandTotal), value: <Badge>{ORDER_STATUS_LABEL[order.status] ?? order.status}</Badge>, value2: <Badge tone={order.paymentStatus === 'paid' ? 'ok' : undefined}>
          {PAYMENT_STATUS_LABEL[order.paymentStatus ?? 'pending'] ?? order.paymentStatus}
        </Badge>, refill: order.refill && <> <Badge tone="warn">{t('order.refill')}</Badge></> })} />
      </PageHeading>

      {!seller && <Alert tone="warn">{t('order.yourPharmacyIsTheBuyer')}</Alert>}

      {order.prescriptionStatus === 'pending' && seller && (
        <Alert tone="warn">{t('order.thePrescriptionHasNotBeen')}{' '}
          <Link to={`/pharmacy/prescriptions/${order._id}`}>{t('order.reviewThePrescription')}</Link>
        </Alert>
      )}

      <section className="ws-section" aria-labelledby="items-h">
        <h2 id="items-h">{t('common.medicines')}</h2>
        <div className="ws-table-wrap">
          <table className="j-table">
            <thead><tr><th scope={'col'}>{t('common.medicine')}</th><th scope={'col'}>{t('common.quantity')}</th><th scope={'col'}>{t('order.batches')}</th><th scope={'col'}>{t('order.amount')}</th></tr></thead>
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
          <dt>{t('order.delivery')}</dt><dd>{order.deliveryMode === 'delivery' ? t('order.delivery2', { value: order.deliveryAddress ? ` to ${order.deliveryAddress}` : '' }) : t('order.pickupAtThePharmacy')}</dd>
          <dt>{t('order.paymentMethod')}</dt><dd>{order.paymentMode ? order.paymentMode.replace(/_/g, ' ') : '—'}</dd>
          {order.refill && <><dt>{t('order.refillPaymentDue')}</dt><dd>{formatDateTime(order.refill.paymentDueBy)}</dd></>}
        </dl>
      </section>

      {order.status === 'pending_cancel' && order.cancelRequest?.state === 'pending' && (
        // Keyed by the request: a newer request (after a refresh) replaces the panel and closes any open confirmation,
        // and each decision sends the id of the request that was on screen.
        <CancelRequestPanel key={order.cancelRequest.requestId} order={order} viewer={seller ? 'seller' : 'buyer'}
          onApprove={(requestId, note) => act(() => orders.approveCancel(order._id, requestId, note || undefined))}
          onReject={(requestId, note) => act(() => orders.rejectCancel(order._id, requestId, note))} />
      )}

      {order.prescriptionRefund && <RefundPanel order={order} seller={seller} onRetry={() => act(() => orders.retryRefund(order._id))} />}

      {seller && !terminal && (
        <section className="ws-section" aria-labelledby="next-h">
          <h2 id="next-h">{t('order.nextStep')}</h2>
          <div className="ws-actions">
            {forward.map((target) => {
              const blocked = blockedReason(order, target);
              return (
                <div key={target} className="ws-action">
                  <ConfirmAction label={FORWARD_LABEL()[target]!} confirmLabel={t('order.yes', { value: FORWARD_LABEL()[target]!.toLowerCase() })}
                    disabled={blocked !== null} reason={'optional'} reasonLabel={t('common.note')}
                    consequence={target === 'completed' ? t('order.theOrderIsClosedAnd')
                      : t('order.theOrderMovesToThe', { value: ORDER_STATUS_LABEL[target] })}
                    onConfirm={(note) => act(() => orders.updateStatus(order._id, target, note || undefined))} />
                  {blocked && <span className="ws-muted">{blocked}</span>}
                </div>
              );
            })}
            {markable && (
              <ConfirmAction label={t('order.recordPayment')} confirmLabel={t('order.yesPaymentReceived')}
                consequence={t(order.paymentMode === 'cash_on_delivery' ? 'order.receivedOnDelivery' : 'order.receivedAtCounter', { amount: formatRupees(order.grandTotal) })}
                reason={'optional'} reasonLabel={t('common.note')}
                onConfirm={(note) => act(() => orders.markPaid(order._id, note ? { notes: note } : {}))} />
            )}
            {canRequestCancel && (
              <ConfirmAction label={t('common.cancelOrder')} confirmLabel={unpaid ? t('common.yesCancelIt') : t('order.yesRequestCancellation')} danger reason
                consequence={unpaid
                  ? t('order.theOrderIsCancelledNow')
                  : t('order.theOrderHoldsAPayment')}
                onConfirm={(reason) => act(() => orders.requestCancel(order._id, reason))} />
            )}
            {forward.length === 0 && exceptions.length === 0 && !markable && !canRequestCancel && cancelBlock !== 'payment' && (
              <span className="ws-muted">{t('order.nothingToDoFrom')}{ORDER_STATUS_LABEL[order.status]}{t('order.here')}</span>
            )}
          </div>

          {exceptions.length > 0 && (
            <>
              <h3>{t('order.deliveryProblem')}</h3>
              <div className="ws-actions">
                {exceptions.map((ex) => (
                  <ConfirmAction key={ex} label={DELIVERY_EXCEPTION_LABEL()[ex]} confirmLabel={t('order.record', { value: DELIVERY_EXCEPTION_LABEL()[ex].toLowerCase() })}
                    danger={ex === 'not_collected' || ex === 'refused_at_door'} reason={ex !== 'retry_delivery'}
                    consequence={EXCEPTION_CONSEQUENCE()[ex]}
                    onConfirm={(reason) => act(() => orders.deliveryException(order._id, ex, reason || undefined))} />
                ))}
              </div>
            </>
          )}

          {cancelBlock === 'payment' && (
            <Alert tone="warn">{t('order.thisOrderCannotBeCancelledFull', { value: PAYMENT_STATUS_LABEL[order.paymentStatus ?? 'pending']?.toLowerCase() })}</Alert>
          )}
        </section>
      )}

      {order.deliveryExceptions && order.deliveryExceptions.length > 0 && (
        <section className="ws-section" aria-labelledby="history-h">
          <h2 id="history-h">{t('order.deliveryHistory')}</h2>
          <ul className="ws-list">
            {order.deliveryExceptions.map((e, i) => (
              <li key={i}>
                <strong>{DELIVERY_EXCEPTION_LABEL()[e.type]}</strong> · {formatDateTime(e.at)} ·{' '}
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

const EXCEPTION_CONSEQUENCE = (): Record<DeliveryExceptionType, string> => ({
  delivery_failed: t('order.theOrderIsMarkedDelivery'),
  retry_delivery: t('order.theOrderGoesOutFor'),
  switch_to_pickup: t('order.theCustomerWillCollectThe'),
  not_collected: t('order.theOrderIsCancelledIts'),
  refused_at_door: t('order.theOrderIsCancelledIts'),
});

function RefundPanel({ order, seller, onRetry }: { order: PharmacyOrder; seller: boolean; onRetry: () => Promise<unknown> }) {
  const r = order.prescriptionRefund!;
  const tone = r.status === 'wallet_credited' || r.status === 'source_refunded' ? 'ok' : r.status === 'manual_review' ? 'error' : 'warn';
  return (
    <section className="ws-section" aria-labelledby="refund-h">
      <h2 id="refund-h">{t('order.refund')}</h2>
      <Alert tone={tone}>{REFUND_STATUS_LABEL()[r.status] ?? r.status}</Alert>
      <dl className="ws-dl">
        <dt>{t('order.amount')}</dt><dd>{formatRupees(r.walletAmount)}</dd>
        {r.walletCreditedAt && <><dt>{t('order.credited')}</dt><dd>{formatDateTime(r.walletCreditedAt)}</dd></>}
        {r.lastError && <><dt>{t('order.lastProblem')}</dt><dd>{r.lastError}</dd></>}
      </dl>
      {seller && r.status === 'wallet_pending' && (
        <ConfirmAction label={t('order.retryRefund')} confirmLabel={t('order.retryNow')}
          consequence={t('order.tryAgainToCreditThe')} onConfirm={onRetry} />
      )}
    </section>
  );
}
