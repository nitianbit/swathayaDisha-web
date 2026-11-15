import { useEffect, useRef, useState } from 'react';
import { ApiError, type PaymentOrder } from '@jansetu/api';
import { Alert, Button, formatDateTime, Loading } from '@jansetu/ui';
import { messageOf } from './common.tsx';
import { checkPayment, payOrder, type PaymentOutcome } from './payments.ts';
import { useSession } from './session.tsx';

/**
 * An unpaid lab booking or Consult now request inside its 30-minute payment window. On opening, the latest payment
 * attempt is checked with Razorpay once (a payment whose confirmation was lost is applied then). "Pay now" asks the
 * server (POST .../pay): it settles every earlier attempt first and hands back the open order, so a second order is
 * never started beside a capture it could not check. After the window the server refuses (409): that is not the final
 * answer (an earlier payment may still be captured), so the parent keeps reading the record until it settles.
 */
export function PayAgainPanel({ what, deadline, paymentTransactionId, expiredCode, description, pay, onSettled }: {
  /** "booking", "request" */
  what: string;
  deadline?: string;
  paymentTransactionId?: string;
  /** The 409 code the server answers once the window has passed. */
  expiredCode: string;
  description: string;
  pay: () => Promise<{ paymentRequired: boolean; payment?: PaymentOrder }>;
  onSettled: () => Promise<void>;
}) {
  const { api } = useSession();
  const [state, setState] = useState<'checking' | PaymentOutcome | 'paying' | 'closed'>(paymentTransactionId ? 'checking' : 'unpaid');
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  async function check() {
    if (!paymentTransactionId) return;
    setState((s) => (s === 'closed' ? s : 'checking'));
    const outcome = await checkPayment(api, paymentTransactionId);
    setState((s) => (s === 'closed' && outcome !== 'paid' ? s : outcome));
    await onSettled();
  }
  useEffect(() => { if (!started.current) { started.current = true; void check(); } }, []);

  async function payNow() {
    setError(null);
    setState('paying');
    try {
      const r = await pay();
      setState(r.paymentRequired && r.payment ? await payOrder(api, r.payment, {}, description) : 'paid');
    } catch (err) {
      if (err instanceof ApiError && err.code === expiredCode) { setState('closed'); return; }
      setError(messageOf(err));
      // The server refuses a new order while an earlier payment cannot be checked: it might already be paid.
      setState(err instanceof ApiError && err.code === 'PAYMENT_STATE_UNKNOWN' ? 'unknown' : 'unpaid');
    } finally {
      await onSettled();
    }
  }

  return (
    <section className="card stack" aria-labelledby="pay-h">
      <h2 id="pay-h">Payment</h2>
      {state === 'checking' ? <Loading label="Checking your payment…" />
        : state === 'paid' ? <Alert tone="ok">Payment received.</Alert>
        : state === 'closed' ? (
          <>
            <Alert tone="warn">
              The time to pay for this {what} has passed, so a new payment cannot be started. If you already paid, it will
              be confirmed; otherwise it will be released and any wallet money used goes back to your wallet.
            </Alert>
            {paymentTransactionId && <div className="row"><Button variant="secondary" onClick={() => void check()}>Check now</Button></div>}
          </>
        ) : (
          <>
            <Alert tone="warn">
              {state === 'unknown'
                ? 'We could not check your payment just now. If you have paid, it will show here once we can.'
                : `This ${what} is not paid yet. Pay ${deadline ? `by ${formatDateTime(deadline)}` : 'within 30 minutes'}, or it is released.`}
            </Alert>
            {error && <Alert>{error}</Alert>}
            <div className="row">
              <Button busy={state === 'paying'} disabled={state === 'unknown'} onClick={() => void payNow()}>Pay now</Button>
              {paymentTransactionId && (
                <Button variant="secondary" disabled={state === 'paying'} onClick={() => void check()}>I have paid, check again</Button>
              )}
            </div>
          </>
        )}
    </section>
  );
}
