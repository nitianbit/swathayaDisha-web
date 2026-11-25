import { useEffect, useRef, useState } from 'react';
import { ApiError, type PaymentOrder } from '@jansetu/api';
import { Alert, Button, formatDateTime, formatRupees, Loading } from '@jansetu/ui';
import { messageOf } from './common.tsx';
import { t } from './i18n/index.ts';
import { useAlive } from './onceOnly.tsx';
import { paymentCheck, payOrder, type PaymentOutcome } from './payments.ts';
import { useSession } from './session.tsx';

/**
 * An unpaid lab booking or Consult now request inside its 30-minute payment window. On opening, the latest payment
 * attempt is checked with Razorpay once (a payment whose confirmation was lost is applied then). "Pay now" asks the
 * server (POST .../pay): it settles every earlier attempt first and hands back the open order, so a second order is
 * never started beside a capture it could not check. After the window the server refuses (409): that is not the final
 * answer (an earlier payment may still be captured), so the parent keeps reading the record until it settles.
 * Parents key the panel by the record and its payment attempt, so a changed record starts a fresh panel; answers that
 * arrive after the page was left, or after a newer run started, are ignored (no Checkout is opened for them).
 * WQ11a: a definite refusal of the check (that attempt failed or was refunded) still lets a new payment start; the
 * amount due is shown, and once the server answered "Pay now", the part already held from the wallet.
 */
/** The panel's sentences for a lab booking ("booking") and a Consult now request ("request"). */
const WORDS = {
  booking: { closed: 'pay.booking.closed', unpaidBy: 'pay.booking.unpaidBy', unpaidSoon: 'pay.booking.unpaidSoon', returned: 'pay.booking.returned' },
  request: { closed: 'pay.request.closed', unpaidBy: 'pay.request.unpaidBy', unpaidSoon: 'pay.request.unpaidSoon', returned: 'pay.request.returned' },
} as const;

export function PayAgainPanel({ kind, amountDue, deadline, paymentTransactionId, expiredCode, description, pay, onSettled }: {
  /** A lab booking or a Consult now request. */
  kind: keyof typeof WORDS;
  /** Rupees: the whole amount due for the booking or request (coupon applied). */
  amountDue?: number;
  deadline?: string;
  paymentTransactionId?: string;
  /** The 409 code the server answers once the window has passed. */
  expiredCode: string;
  description: string;
  pay: () => Promise<{ paymentRequired: boolean; payment?: PaymentOrder; walletDeductedAmount?: number }>;
  onSettled: () => Promise<void>;
}) {
  const { api } = useSession();
  const [state, setState] = useState<'checking' | PaymentOutcome | 'paying' | 'closed'>(paymentTransactionId ? 'checking' : 'unpaid');
  const [error, setError] = useState<string | null>(null);
  /** An earlier attempt's money went back to the wallet (said once the check answered so). */
  const [returned, setReturned] = useState(false);
  /** From the server's last "Pay now" answer: held from the wallet, and what the payment page asks for. */
  const [split, setSplit] = useState<{ held: number; gateway: number } | null>(null);
  const started = useRef(false);
  const alive = useAlive();
  // Each check or payment run owns the panel until a newer one starts; an older answer changes nothing.
  const run = useRef(0);

  async function check() {
    if (!paymentTransactionId) return;
    const mine = ++run.current;
    setState((s) => (s === 'closed' ? s : 'checking'));
    const { outcome, returned: back } = await paymentCheck(api, paymentTransactionId);
    if (!alive.current || run.current !== mine) return;
    if (back) setReturned(true);
    setState((s) => (s === 'closed' && outcome !== 'paid' ? s : outcome));
    await onSettled();
  }
  useEffect(() => { if (!started.current) { started.current = true; void check(); } }, []);

  async function payNow() {
    const mine = ++run.current;
    const current = () => alive.current && run.current === mine;
    setError(null);
    setState('paying');
    try {
      const r = await pay();
      // The customer left, or another run took over: never open Checkout for an answer nobody is waiting for.
      if (!current()) return;
      if (r.paymentRequired && r.payment) {
        const gateway = Number(r.payment.amount) || 0;
        const held = typeof r.walletDeductedAmount === 'number' ? r.walletDeductedAmount
          : amountDue !== undefined ? Math.max(0, Math.round((amountDue - gateway) * 100) / 100) : 0;
        setSplit({ held, gateway });
      }
      const outcome = r.paymentRequired && r.payment ? await payOrder(api, r.payment, {}, description) : 'paid';
      if (current()) setState(outcome);
    } catch (err) {
      if (!current()) return;
      if (err instanceof ApiError && err.code === expiredCode) { setState('closed'); return; }
      setError(messageOf(err));
      // The server refuses a new order while an earlier payment cannot be checked: it might already be paid.
      setState(err instanceof ApiError && err.code === 'PAYMENT_STATE_UNKNOWN' ? 'unknown' : 'unpaid');
    } finally {
      await onSettled();
    }
  }

  const words = WORDS[kind];
  return (
    <section className="card stack" aria-labelledby="pay-h">
      <h2 id="pay-h">{t('common.payment')}</h2>
      {state === 'checking' ? <Loading label={t('common.checkingPayment')} />
        : state === 'paid' ? <Alert tone="ok">{t('pay.received')}</Alert>
        : state === 'closed' ? (
          <>
            <Alert tone="warn">{t(words.closed)}</Alert>
            {paymentTransactionId && <div className="row"><Button variant="secondary" onClick={() => void check()}>{t('common.checkNow')}</Button></div>}
          </>
        ) : (
          <>
            <Alert tone="warn">
              {state === 'unknown'
                ? t('pay.unknown')
                : deadline ? t(words.unpaidBy, { deadline: formatDateTime(deadline) }) : t(words.unpaidSoon)}
            </Alert>
            {returned && <Alert tone="warn">{t(words.returned)}</Alert>}
            {(amountDue !== undefined || split) && (
              <dl className="details" aria-label={t('pay.amount')}>
                {amountDue !== undefined && <><dt>{t('pay.amountDue')}</dt><dd>{formatRupees(amountDue)}</dd></>}
                {split && split.held > 0 && <><dt>{t('pay.heldFromWallet')}</dt><dd>{formatRupees(split.held)}</dd></>}
                {split && <><dt>{t('pay.onPaymentPage')}</dt><dd><strong>{formatRupees(split.gateway)}</strong></dd></>}
              </dl>
            )}
            {error && <Alert>{error}</Alert>}
            <div className="row">
              <Button busy={state === 'paying'} disabled={state === 'unknown'} onClick={() => void payNow()}>{t('common.payNow')}</Button>
              {paymentTransactionId && (
                <Button variant="secondary" disabled={state === 'paying'} onClick={() => void check()}>{t('common.paidCheckAgain')}</Button>
              )}
            </div>
          </>
        )}
    </section>
  );
}
