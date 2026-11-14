import { customerApi, type ApiClient, type PaymentOrder } from '@jansetu/api';

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
    s.onload = () => (window.Razorpay ? resolve(window.Razorpay) : reject(new Error('Payment page did not load')));
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
      name: 'Jansetu',
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

/** Asks the server to check a payment with Razorpay. Never throws. */
export async function checkPayment(api: ApiClient, paymentTransactionId: string): Promise<PaymentOutcome> {
  try {
    const r = await customerApi(api).reconcilePayment(paymentTransactionId);
    return r.state === 'paid' ? 'paid' : 'unpaid';
  } catch {
    return 'unknown';
  }
}
