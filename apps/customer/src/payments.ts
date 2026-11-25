import { ApiError, customerApi, type ApiClient, type PaymentOrder } from '@jansetu/api';
import { t } from './i18n/index.ts';

/** Razorpay Checkout (https://checkout.razorpay.com/v1/checkout.js), loaded only when a payment starts. */
interface RazorpayInstance { open(): void; on(event: 'payment.failed', cb: (r: { error?: { description?: string } }) => void): void }
type RazorpayCtor = new (options: Record<string, unknown>) => RazorpayInstance;
declare global { interface Window { Razorpay?: RazorpayCtor } }

const CHECKOUT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';
let loading: Promise<RazorpayCtor> | null = null;

export function loadCheckout(): Promise<RazorpayCtor> {
  if (window.Razorpay) return Promise.resolve(window.Razorpay);
  loading ??= new Promise<RazorpayCtor>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = CHECKOUT_SRC;
    s.async = true;
    // i18n-ignore: never shown (messageOf words any error that is not the server's)
    s.onload = () => (window.Razorpay ? resolve(window.Razorpay) : reject(new Error('Payment page did not load')));
    // i18n-ignore: never shown (messageOf words any error that is not the server's)
    s.onerror = () => { loading = null; reject(new Error('Could not open the payment page. Check your connection and try again.')); };
    document.head.appendChild(s);
  });
  return loading;
}

type CheckoutResult =
  | { kind: 'paid'; razorpayPaymentId: string; razorpayOrderId: string; razorpaySignature: string }
  | { kind: 'closed' };

/** Opens Checkout for the server-created order; resolves when the customer pays or closes it. */
async function checkout(order: PaymentOrder, prefill: { name?: string; contact?: string; email?: string }, description: string): Promise<CheckoutResult> {
  const Razorpay = await loadCheckout();
  return new Promise<CheckoutResult>((resolve) => {
    const rz = new Razorpay({
      key: order.razorpayKeyId,
      order_id: order.razorpayOrderId,
      amount: Math.round(order.amount * 100),
      currency: order.currency,
      name: t('common.brand'),
      description,
      prefill,
      theme: { color: '#0b6e70' },
      handler: (r: { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }) =>
        resolve({ kind: 'paid', razorpayPaymentId: r.razorpay_payment_id, razorpayOrderId: r.razorpay_order_id, razorpaySignature: r.razorpay_signature }),
      modal: { ondismiss: () => resolve({ kind: 'closed' }) },
    });
    // A failed attempt keeps Checkout open for another try; the outcome arrives through handler or ondismiss.
    rz.on('payment.failed', () => undefined);
    rz.open();
  });
}

export type PaymentOutcome = 'paid' | 'unpaid' | 'unknown';

/**
 * Pays an order and settles it with the server. The browser's proof goes to /payments/verify; if that fails for any
 * reason, or Checkout was closed, the server is asked to check the order with Razorpay itself (/payments/reconcile),
 * so a captured payment is never left unapplied. 'unknown' = the server could not be reached; the booking page checks
 * again when opened.
 */
export async function payOrder(api: ApiClient, order: PaymentOrder, prefill: { name?: string; contact?: string; email?: string },
  description: string): Promise<PaymentOutcome> {
  const c = customerApi(api);
  const result = await checkout(order, prefill, description);
  if (result.kind === 'paid') {
    try {
      const v = await c.verifyPayment({
        paymentTransactionId: order.paymentTransactionId, razorpayOrderId: result.razorpayOrderId,
        razorpayPaymentId: result.razorpayPaymentId, razorpaySignature: result.razorpaySignature,
      });
      if (v.paymentRecord?.status === 'paid') return 'paid';
    } catch { /* fall through to the server-side check */ }
  }
  return checkPayment(api, order.paymentTransactionId);
}

/**
 * WQ11a: what the server's payment check said. `returned`: the attempt's money went back to the wallet (a capture that
 * arrived after the booking was released or paid otherwise; the record is then 'refunded'). A definite refusal of the
 * check (400 PAYMENT_FAILED / PAYMENT_REFUNDED: that attempt is over) is not "could not check": a new payment may start
 * (the server's /pay settles every earlier attempt first and decides).
 */
export async function paymentCheck(api: ApiClient, paymentTransactionId: string): Promise<{ outcome: PaymentOutcome; returned: boolean }> {
  try {
    const r = await customerApi(api).reconcilePayment(paymentTransactionId);
    if (r.state === 'paid' && r.paymentRecord?.status === 'refunded') return { outcome: 'unpaid', returned: true };
    return { outcome: r.state === 'paid' ? 'paid' : 'unpaid', returned: false };
  } catch (err) {
    if (err instanceof ApiError && err.status === 400 && (err.code === 'PAYMENT_FAILED' || err.code === 'PAYMENT_REFUNDED')) {
      return { outcome: 'unpaid', returned: err.code === 'PAYMENT_REFUNDED' };
    }
    return { outcome: 'unknown', returned: false };
  }
}

/** Asks the server to check a payment with Razorpay. Never throws. */
export async function checkPayment(api: ApiClient, paymentTransactionId: string): Promise<PaymentOutcome> {
  return (await paymentCheck(api, paymentTransactionId)).outcome;
}
