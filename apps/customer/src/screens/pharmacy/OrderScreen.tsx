import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import {
  ApiError, CANCELLABLE_STATUSES, customerPharmacyApi, PHARMACY_PAYMENT_WINDOW_MIN, refId, type PaymentOrder, type PharmacyOrder,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, formatDateTime, formatRupees, Loading } from '@jansetu/ui';
import { Confirm, messageOf, PageHeading } from '../../common.tsx';
import { checkPayment, payOrder, type PaymentOutcome } from '../../payments.ts';
import { useSession } from '../../session.tsx';
import { paymentKey } from './CartScreen.tsx';
import { isUnpaid, ORDER_STATUS, orderTitle, PAYMENT_MODE, REFUND_STATUS } from './labels.ts';

export function PharmacyOrderScreen() {
  const { orderId = '' } = useParams();
  const { api } = useSession();
  const valid = /^[0-9a-fA-F]{24}$/.test(orderId);
  const q = useQuery({ queryKey: ['pharmacy-orders', 'one', orderId], queryFn: () => customerPharmacyApi(api).order(orderId), enabled: valid });
  return (
    <>
      <Link to="/pharmacy/orders" className="back"><ArrowLeft size={16} aria-hidden="true" /> My medicine orders</Link>
      {!valid ? <Empty title="Order not found" />
        : q.isPending ? <Loading /> : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : <OrderView order={q.data} />}
    </>
  );
}

function OrderView({ order: o }: { order: PharmacyOrder }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const pharmacy = customerPharmacyApi(api);
  const storeId = refId(o.pharmacyId) ?? '';
  const store = useQuery({ queryKey: ['pharmacy-store', storeId], queryFn: () => pharmacy.store(storeId), enabled: /^[0-9a-fA-F]{24}$/.test(storeId) });
  const s = ORDER_STATUS[o.status] ?? { label: o.status };
  const unpaid = isUnpaid(o);
  const online = o.paymentMode === 'online_payment';
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['pharmacy-orders'] });
    await queryClient.invalidateQueries({ queryKey: ['wallet'] });
  };
  const request = o.cancelRequest;

  return (
    <>
      <PageHeading title={orderTitle(o)}>{store.data?.name ?? ''}{store.data?.name ? ' · ' : ''}{formatDateTime(o.createdAt)}</PageHeading>
      <section className="card stack">
        <dl className="details">
          <dt>Status</dt><dd><Badge tone={s.tone}>{s.label}</Badge></dd>
          <dt>Total</dt><dd>{formatRupees(o.grandTotal)}</dd>
          <dt>Payment</dt>
          <dd>{o.paymentMode ? (PAYMENT_MODE[o.paymentMode] ?? o.paymentMode) : '—'} · {o.paymentStatus === 'paid' ? 'paid' : o.paymentStatus === 'refunded' ? 'refunded' : 'not paid yet'}</dd>
          <dt>{o.deliveryMode === 'delivery' ? 'Delivery' : 'Pickup'}</dt>
          <dd>{o.deliveryMode === 'delivery' ? (o.deliveryAddress ?? 'To your address') : 'Collect at the pharmacy'}</dd>
        </dl>
        <ul className="plain">
          {o.items.map((it, i) => <li key={`${it.medicineId}-${i}`}>{it.medicineName ?? 'Medicine'} × {it.orderedQty} · {formatRupees(it.lineTotal)}</li>)}
        </ul>
      </section>

      {o.status === 'abandoned' && (
        <Alert tone="warn">
          This order was cancelled because it was not paid within {PHARMACY_PAYMENT_WINDOW_MIN} minutes. If money was taken from
          you, it goes back to your Jansetu wallet. You can order again.
        </Alert>
      )}

      {online && unpaid && o.status === 'placed' && <PaymentPanel order={o} onSettled={refresh} />}
      {online && o.paymentStatus === 'paid' && o.status === 'placed' && (
        <Alert tone="ok">Payment received. The pharmacy will prepare your order.</Alert>
      )}

      {o.status === 'pending_cancel' && (
        <Alert tone="warn">
          You asked to cancel this order{request?.requestedAt ? ` on ${formatDateTime(request.requestedAt)}` : ''}. The pharmacy or
          Jansetu will confirm it; once cancelled, {online ? 'what you paid goes back to your Jansetu wallet' : 'Jansetu will arrange your refund'}.
        </Alert>
      )}
      {request?.state === 'rejected' && o.status !== 'cancelled' && o.status !== 'pending_cancel' && (
        <Alert tone="warn">The pharmacy could not cancel this order{request.decisionNote ? `: “${request.decisionNote}”` : '.'}</Alert>
      )}

      {o.prescriptionRefund && <RefundPanel order={o} onChanged={refresh} />}

      {CANCELLABLE_STATUSES.includes(o.status) && (
        <section className="card stack" aria-labelledby="cancel-h">
          <h2 id="cancel-h">Cancel</h2>
          <Confirm label="Cancel this order" confirmLabel={unpaid ? 'Yes, cancel it' : 'Yes, ask to cancel'} withReason
            consequence={unpaid
              ? 'The order is cancelled now. If a payment was still going through, it goes back to your Jansetu wallet.'
              : online
                ? 'This order is paid, so the pharmacy or Jansetu confirms the cancellation first. Then what you paid goes back to your Jansetu wallet (you can move it to your card/UPI).'
                : 'This order is paid, so the pharmacy or Jansetu confirms the cancellation first, and Jansetu arranges your refund.'}
            onConfirm={async (reason) => {
              try { await pharmacy.requestCancel(o._id, reason || undefined); } finally { await refresh(); }
            }} />
        </section>
      )}
    </>
  );
}

/**
 * An unpaid online order. Checkout opens with the payment details kept in this session's memory (right after placing
 * the order); after a reload only the server-side check is possible. Unpaid orders are cancelled after the window.
 */
function PaymentPanel({ order: o, onSettled }: { order: PharmacyOrder; onSettled: () => Promise<void> }) {
  const { api, memory } = useSession();
  const startPayment = (useLocation().state as { startPayment?: boolean } | null)?.startPayment === true;
  const payment = memory.get<PaymentOrder>(paymentKey(o._id));
  const [state, setState] = useState<PaymentOutcome | 'idle' | 'paying' | 'checking'>('idle');
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const deadline = o.createdAt ? new Date(new Date(o.createdAt).getTime() + PHARMACY_PAYMENT_WINDOW_MIN * 60_000) : null;

  async function payNow() {
    if (!payment) return;
    setError(null); setState('paying');
    try {
      const outcome = await payOrder(api, payment, {}, o.orderNumber ? `Medicines, order ${o.orderNumber}` : 'Medicines');
      setState(outcome);
      if (outcome === 'paid') memory.delete(paymentKey(o._id));
    } catch (err) {
      setError(messageOf(err));
      setState('idle');
    } finally {
      await onSettled();
    }
  }
  async function check() {
    if (!o.paymentTransactionId) return;
    setState('checking');
    const outcome = await checkPayment(api, o.paymentTransactionId);
    setState(outcome);
    if (outcome === 'paid') { memory.delete(paymentKey(o._id)); await onSettled(); }
  }
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (startPayment && payment) void payNow();
    else if (o.paymentTransactionId) void check();
  }, []);

  return (
    <section className="card stack" aria-labelledby="pay-h">
      <h2 id="pay-h">Payment</h2>
      {state === 'checking' ? <Loading label="Checking your payment…" />
        : state === 'paid' ? <Alert tone="ok">Payment received. The pharmacy will prepare your order.</Alert>
        : (
          <>
            <Alert tone="warn">
              {state === 'unknown' ? 'We could not check your payment just now. If you have paid, it will show here once we can.'
                : `This order is not paid yet. Pay ${deadline ? `by ${formatDateTime(deadline.toISOString())}` : `within ${PHARMACY_PAYMENT_WINDOW_MIN} minutes`}, or it is cancelled.`}
              {!payment && ' Paying again is not possible after leaving the app; if you did not pay, cancel this order and place a new one.'}
            </Alert>
            {error && <Alert>{error}</Alert>}
            <div className="row">
              {payment && <Button busy={state === 'paying'} onClick={() => void payNow()}>Pay {formatRupees(payment.amount)}</Button>}
              {o.paymentTransactionId && (
                <Button variant="secondary" disabled={state === 'paying'} onClick={() => void check()}>I have paid, check again</Button>
              )}
            </div>
          </>
        )}
    </section>
  );
}

function RefundPanel({ order: o, onChanged }: { order: PharmacyOrder; onChanged: () => Promise<void> }) {
  const { api } = useSession();
  const r = o.prescriptionRefund!;
  const canMove = r.status === 'wallet_credited' && o.paymentMode === 'online_payment' && r.gatewayAmountPaise > 0;
  return (
    <section className="card stack" aria-labelledby="refund-h">
      <h2 id="refund-h">Refund</h2>
      <Alert tone={r.status === 'manual_review' || r.status === 'wallet_pending' ? 'warn' : 'ok'}>
        {formatRupees(r.walletAmount)}: {REFUND_STATUS[r.status] ?? r.status}
      </Alert>
      {canMove && (
        <Confirm label="Send it to my card/UPI instead" confirmLabel="Yes, send it to my card/UPI"
          consequence="The refund leaves your Jansetu wallet and goes back to the card or UPI you paid with. Banks can take 5–7 working days."
          onConfirm={async () => {
            try { await customerPharmacyApi(api).refundToSource(o._id); }
            catch (err) {
              if (err instanceof ApiError && err.code === 'WALLET_BALANCE_INSUFFICIENT') {
                throw new ApiError(409, 'Your wallet no longer holds this refund (it was used), so it can’t be sent to your card/UPI.', err.code);
              }
              throw err;
            } finally { await onChanged(); }
          }} />
      )}
    </section>
  );
}
