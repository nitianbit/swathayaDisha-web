import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import {
  ApiError, CANCELLABLE_STATUSES, customerPharmacyApi, PHARMACY_PAYMENT_WINDOW_MIN, refId, type PaymentOrder, type PharmacyOrder,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, formatDateTime, formatRupees, Loading } from '@jansetu/ui';
import { Confirm, messageOf, PageHeading } from '../../common.tsx';
import { t } from '../../i18n/index.ts';
import { checkPayment, payOrder, type PaymentOutcome } from '../../payments.ts';
import { useSession } from '../../session.tsx';
import { paymentKey } from './CartScreen.tsx';
import { isUnpaid, orderStatusOf, orderTitle, paymentModeLabel, refundStatusText } from './labels.ts';

export function PharmacyOrderScreen() {
  const { orderId = '' } = useParams();
  const { api } = useSession();
  const valid = /^[0-9a-fA-F]{24}$/.test(orderId);
  const q = useQuery({
    queryKey: ['pharmacy-orders', 'one', orderId], queryFn: () => customerPharmacyApi(api).order(orderId), enabled: valid,
    // While an online order waits for payment, the server may close it (not paid in time, or the pharmacy declines):
    // keep it current so payment is never offered for a closed order.
    refetchInterval: (query) => {
      const o = query.state.data;
      return o && o.paymentMode === 'online_payment' && o.status === 'placed' && isUnpaid(o) ? 30_000 : false;
    },
  });
  return (
    <>
      <Link to="/pharmacy/orders" className="back"><ArrowLeft size={16} aria-hidden="true" /> {t('orders.title')}</Link>
      {!valid ? <Empty title={t('order.notFound')} />
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
  const s = orderStatusOf(o.status);
  const unpaid = isUnpaid(o);
  const online = o.paymentMode === 'online_payment';
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['pharmacy-orders'] });
    await queryClient.invalidateQueries({ queryKey: ['wallet'] });
  };
  const request = o.cancelRequest;
  const replayed = (useLocation().state as { replayed?: boolean } | null)?.replayed === true;

  return (
    <>
      <PageHeading title={orderTitle(o)}>{store.data?.name ?? ''}{store.data?.name ? ' · ' : ''}{formatDateTime(o.createdAt)}</PageHeading>
      <section className="card stack">
        <dl className="details">
          <dt>{t('common.status')}</dt><dd><Badge tone={s.tone}>{s.label}</Badge></dd>
          <dt>{t('common.total')}</dt><dd>{formatRupees(o.grandTotal)}</dd>
          <dt>{t('common.payment')}</dt>
          <dd>{o.paymentMode ? paymentModeLabel(o.paymentMode) : '—'} · {o.paymentStatus === 'paid' ? t('common.paid') : o.paymentStatus === 'refunded' ? t('common.refunded') : t('common.notPaidYet')}</dd>
          <dt>{o.deliveryMode === 'delivery' ? t('pharmacy.delivery') : t('pharmacy.pickup')}</dt>
          <dd>{o.deliveryMode === 'delivery' ? (o.deliveryAddress ?? t('order.toYourAddress')) : t('cart.collect')}</dd>
        </dl>
        <ul className="plain">
          {o.items.map((it, i) => <li key={`${it.medicineId}-${i}`}>{it.medicineName ?? t('common.medicine')} × {it.orderedQty} · {formatRupees(it.lineTotal)}</li>)}
        </ul>
      </section>

      {replayed && <Alert tone="ok">{t('order.replayed')}</Alert>}
      {o.prescriptionStatus === 'pending' && (
        <Alert tone="warn">{o.prescriptionUrls?.length ? t('order.rx.pendingWithFile') : t('order.rx.pending')}</Alert>
      )}
      {o.prescriptionStatus === 'approved' && <Alert tone="ok">{t('order.rx.approved')}</Alert>}
      {o.prescriptionStatus === 'rejected' && (
        <Alert tone="warn">
          {o.prescriptionReview?.reason ? t('order.rx.rejectedWhy', { reason: o.prescriptionReview.reason }) : t('order.rx.rejected')}
        </Alert>
      )}
      {o.status === 'abandoned' && (
        <Alert tone="warn">{t('order.abandoned')}</Alert>
      )}

      {online && unpaid && o.status === 'placed' && <PaymentPanel order={o} onSettled={refresh} />}
      {online && o.paymentStatus === 'paid' && o.status === 'placed' && (
        <Alert tone="ok">{t('order.paid')}</Alert>
      )}

      {o.status === 'pending_cancel' && (
        <Alert tone="warn">
          {request?.requestedAt
            ? t(online ? 'order.cancelAsked.onlineOn' : 'order.cancelAsked.offlineOn', { date: formatDateTime(request.requestedAt) })
            : t(online ? 'order.cancelAsked.online' : 'order.cancelAsked.offline')}
        </Alert>
      )}
      {request?.state === 'rejected' && o.status !== 'cancelled' && o.status !== 'pending_cancel' && (
        <Alert tone="warn">{request.decisionNote ? t('order.cancelRefusedWhy', { note: request.decisionNote }) : t('order.cancelRefused')}</Alert>
      )}

      {o.prescriptionRefund && <RefundPanel order={o} onChanged={refresh} />}

      {CANCELLABLE_STATUSES.includes(o.status) && (
        <section className="card stack" aria-labelledby="cancel-h">
          <h2 id="cancel-h">{t('common.cancel')}</h2>
          <Confirm label={t('order.cancel')} confirmLabel={unpaid ? t('common.yesCancel') : t('order.askCancel')} withReason
            consequence={unpaid ? t('order.cancelNow') : online ? t('order.cancelPaidOnline') : t('order.cancelPaidOffline')}
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
  // Starts in the state the first effect is about to enter, so no stale "Pay" button flashes before it.
  const [state, setState] = useState<PaymentOutcome | 'idle' | 'paying' | 'checking'>(
    startPayment && payment ? 'paying' : o.paymentTransactionId ? 'checking' : 'idle');
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const deadline = o.createdAt ? new Date(new Date(o.createdAt).getTime() + PHARMACY_PAYMENT_WINDOW_MIN * 60_000) : null;

  /**
   * Pays the order. Right after placing it, the Checkout details from that answer are used once; any other time the
   * server is asked (P8 retry-payment): it checks earlier attempts first and hands back the order's own open payment.
   */
  async function payNow(fromPlacing = false) {
    setError(null); setState('paying');
    try {
      let details: PaymentOrder | undefined;
      if (fromPlacing && payment) {
        // The server's current order decides, not this page's copy or a browser timer.
        const fresh = await customerPharmacyApi(api).order(o._id);
        if (fresh.status !== 'placed' || !isUnpaid(fresh)) { memory.delete(paymentKey(o._id)); setState('idle'); return; }
        details = payment;
      } else {
        const r = await customerPharmacyApi(api).retryPayment(o._id);
        if (!r.paymentRequired || !r.payment) {
          memory.delete(paymentKey(o._id));
          setState(r.order.paymentStatus === 'paid' ? 'paid' : 'idle');
          return;
        }
        details = r.payment;
      }
      const outcome = await payOrder(api, details, {}, o.orderNumber ? t('order.payDescription', { number: o.orderNumber }) : t('nav.medicines'));
      setState(outcome);
      if (outcome === 'paid') memory.delete(paymentKey(o._id));
    } catch (err) {
      setError(messageOf(err));
      setState(err instanceof ApiError && err.code === 'PAYMENT_STATE_UNKNOWN' ? 'unknown' : 'idle');
    } finally {
      await onSettled();
    }
  }
  async function check() {
    if (!o.paymentTransactionId) return;
    setState('checking');
    const outcome = await checkPayment(api, o.paymentTransactionId);
    setState(outcome);
    if (outcome === 'paid') memory.delete(paymentKey(o._id));
    await onSettled(); // whatever the payment says, the order is read again (it may have been closed meanwhile)
  }
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (startPayment && payment) void payNow(true);
    else if (o.paymentTransactionId) void check();
  }, []);

  return (
    <section className="card stack" aria-labelledby="pay-h">
      <h2 id="pay-h">{t('common.payment')}</h2>
      {state === 'checking' ? <Loading label={t('common.checkingPayment')} />
        : state === 'paid' ? <Alert tone="ok">{t('order.paid')}</Alert>
        : (
          <>
            <Alert tone="warn">
              {state === 'unknown' ? t('pay.unknown')
                : deadline ? t('order.unpaidBy', { deadline: formatDateTime(deadline.toISOString()) }) : t('order.unpaidWithin', { minutes: PHARMACY_PAYMENT_WINDOW_MIN })}
            </Alert>
            {error && <Alert>{error}</Alert>}
            <div className="row">
              <Button busy={state === 'paying'} onClick={() => void payNow()}>{t('order.pay', { amount: formatRupees(payment?.amount ?? o.grandTotal) })}</Button>
              {o.paymentTransactionId && (
                <Button variant="secondary" disabled={state === 'paying'} onClick={() => void check()}>{t('common.paidCheckAgain')}</Button>
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
      <h2 id="refund-h">{t('order.refund.title')}</h2>
      <Alert tone={r.status === 'manual_review' || r.status === 'wallet_pending' ? 'warn' : 'ok'}>
        {formatRupees(r.walletAmount)}: {refundStatusText(r.status)}
      </Alert>
      {canMove && (
        <Confirm label={t('order.refund.toSource')} confirmLabel={t('order.refund.toSourceYes')}
          consequence={t('order.refund.toSourceConsequence')}
          onConfirm={async () => {
            try { await customerPharmacyApi(api).refundToSource(o._id); }
            catch (err) {
              if (err instanceof ApiError && err.code === 'WALLET_BALANCE_INSUFFICIENT') {
                throw new ApiError(409, t('order.refund.used'), err.code);
              }
              throw err;
            } finally { await onChanged(); }
          }} />
      )}
    </section>
  );
}
