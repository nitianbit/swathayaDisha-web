import { describe, expect, it } from 'vitest';
import * as api from './index.ts';
import { ApiError, createApiClient } from './client.ts';
import type { BookedConsultation } from './assisted.ts';

// WQ16c (review of 398accb; backend r10d a7ae19bb): paid only when the money was taken, Pay now only before the cut-off and
// never after Razorpay reported a payment, the refund read by id, wording.

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const REC = 'c1'.repeat(12);
const RF = 'f1'.repeat(12);
const PROOF = { razorpayOrderId: 'order_1', razorpayPaymentId: 'pay_1', razorpaySignature: 'sig_1' };
type Call = { url: string; method: string };
function client(answer: (c: Call) => Response) {
  const calls: Call[] = [];
  const c = createApiClient({ baseUrl: '', getToken: () => 'tok', timeoutMs: 100, fetchImpl: async (u, init) => {
    const call = { url: String(u), method: String(init?.method) };
    calls.push(call);
    return answer(call).clone();
  } });
  return { c, calls };
}
const b = (o: Partial<BookedConsultation>): BookedConsultation => ({ _id: 'e1'.repeat(12), status: 'cancelled', paymentStatus: 'pending', price: 500, ...o });
// Looked up at run time, so a missing helper fails its own test only.
const fn = <T>(name: string) => (api as Record<string, unknown>)[name] as T;

describe('fix 1: paid only when the server says the money was taken', () => {
  it('captured, refunded and forfeited are paid; not_paid and pending are not', () => {
    const wasPaid = fn<(x: BookedConsultation) => boolean>('bookingWasPaid');
    for (const state of ['captured', 'refunded', 'forfeited']) expect(wasPaid(b({ payment: { method: 'razorpay', state, payBy: null } }))).toBe(true);
    for (const state of ['not_paid', 'pending']) expect(wasPaid(b({ payment: { method: 'razorpay', state, payBy: null } }))).toBe(false);
    expect(wasPaid(b({ status: 'confirmed', paymentStatus: 'paid' }))).toBe(true); // an older server
  });
});

describe('fix 2: Pay now before the cut-off only; the order from the booker view (r10d)', () => {
  it('stops 2 minutes before payBy; Checkout closes itself before then', () => {
    const open = fn<(p: string, now: number) => boolean>('payNowOpen');
    const secs = fn<(p: string, now: number) => number>('checkoutSeconds');
    const payBy = '2026-11-23T10:00:00.000Z';
    expect(open(payBy, Date.parse('2026-11-23T09:57:59.000Z'))).toBe(true);
    expect(open(payBy, Date.parse('2026-11-23T09:58:00.000Z'))).toBe(false);
    expect(secs(payBy, Date.parse('2026-11-23T09:50:00.000Z'))).toBe(480);
    expect(secs(payBy, Date.parse('2026-11-23T09:59:00.000Z'))).toBe(60); // card-last: at least about a minute
  });

  it('the open order from `payment` while it waits; none without the order fields', () => {
    const orderOf = fn<(x: BookedConsultation) => unknown>('orderFromBooking');
    const payment = { method: 'razorpay' as const, state: 'pending', payBy: '2026-11-23T10:00:00.000Z', paymentTransactionId: REC, razorpayOrderId: 'order_1', razorpayKeyId: 'rzp_test' };
    expect(orderOf(b({ status: 'pending', payment }))).toEqual({ paymentRequired: true, paymentTransactionId: REC, razorpayOrderId: 'order_1', razorpayKeyId: 'rzp_test',
      amount: 500, amountMinor: 50_000, currency: 'INR', payBy: '2026-11-23T10:00:00.000Z' });
    expect(orderOf(b({ status: 'pending', payment: { ...payment, razorpayOrderId: null } }))).toBeNull();
    expect(orderOf(b({ status: 'pending', payment: { ...payment, state: 'captured' } }))).toBeNull();
  });
});

describe('fix 3: Razorpay reported a payment: never an invitation to pay again', () => {
  it('Checkout said paid but the server has no capture yet (verify not completed, reconcile unpaid)', async () => {
    const { c } = client((x) => (x.url.endsWith('/verify') ? json(400, { error: 400, code: 'PAYMENT_NOT_COMPLETED', message: 'authorized' })
      : json(200, { success: true, data: { state: 'unpaid', gatewayStatuses: [] } })));
    await expect(api.settleCardPayment(c, REC, PROOF)).resolves.toEqual({ kind: 'unpaid', inFlight: true });
  });

  it('reconcile alone: an authorized or created payment is on its way; a failed one is plainly unpaid', () => {
    expect(api.outcomeOfAnswer({ state: 'unpaid', gatewayStatuses: ['failed', 'authorized'] })).toEqual({ kind: 'unpaid', inFlight: true });
    expect(api.outcomeOfAnswer({ state: 'unpaid', gatewayStatuses: ['created'] })).toEqual({ kind: 'unpaid', inFlight: true });
    expect(api.outcomeOfAnswer({ state: 'unpaid', gatewayStatuses: ['failed'] })).toEqual({ kind: 'unpaid' });
  });
});

describe('fix 4: the admin check reads the refund by id, not the list', () => {
  it('GET …/card-refunds/:id (r10e: the row as `data`); an older server is not known, with no recheck', async () => {
    const row = { refundId: RF, method: 'wallet', state: 'processed', amountMinor: 50_000 };
    let older = false;
    const { c, calls } = client(() => (older ? json(404, { error: 404, message: 'Route not found' }) : json(200, { success: true, data: row })));
    await expect(api.readCardRefund(c, RF)).resolves.toMatchObject({ state: 'processed' });
    await expect(api.findMovedRefund(c, RF)).resolves.toMatchObject({ refundId: RF });
    older = true;
    await expect(api.findMarkedFailed(c, RF)).rejects.toMatchObject({ message: 'Not available on this server yet. The outcome is not known.' });
    expect(calls.every((x) => x.method === 'GET' && x.url === `/api/v1/admin/assisted/card-refunds/${RF}`)).toBe(true);
  });
});

describe('fixes 6 and 8: wording', () => {
  it('a card booking cancelled unpaid says a later payment goes back to the card', () => {
    expect(api.cancelWords({ booking: { _id: 'x', status: 'cancelled' }, refundedMinor: 0, alreadyCancelled: false, refund: null }))
      .toBe('Cancelled. It was not paid, so nothing is refunded. If a payment arrives later, it goes back to the card.');
  });

  it('a recheck 5xx is not known; a code-less 404 is "not available on this server yet"', () => {
    const recheckRefusal = fn<(e: unknown) => string>('recheckRefusal');
    expect(recheckRefusal(new ApiError(502, 'x', 'GATEWAY_LOOKUP_FAILED'))).toBe('Razorpay could not be asked just now. The outcome is not known: tap “Recheck” again in a minute.');
    expect(api.moveRefundRefusal(new ApiError(404, 'Route not found'))).toBe('Not available on this server yet. Nothing was changed.');
    expect(api.moveRefundRefusal(new ApiError(503, 'off', 'ASSISTED_BOOKING_DISABLED'))).toMatch(/^The admin tools are switched off/);
  });
});
