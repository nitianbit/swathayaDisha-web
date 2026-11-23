import { describe, expect, it } from 'vitest';
import { ApiError, createApiClient } from './client.ts';
import { assistedRefusal, pharmacyAssistedApi, refusedBeforeWriting, type CancelAnswer, type CardRefund } from './assisted.ts';
import {
  adminCardRefundsApi, agreementProblem, awaitingCardPayment, cancelWords, cardCheckProblem, cardRefundRowsOf, cardRefundWords, checkCardPayment, findMovedRefund,
  moveRefundFinal, moveRefundRefusal, moveRefusedBeforeWriting, outcomeOfAnswer, outcomeOfError, payByClock, payByWords, settleCardPayment,
} from './assistedCard.ts';

// WQ16 (backend r10 phase 1b, design §23.3): a walk-in consultation paid by card or UPI, its refund, the admin queue.

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const err = (status: number, code?: string, message = 'refused') => new ApiError(status, message, code);
const REC = 'c1'.repeat(12);
const BK = 'e1'.repeat(12);
const RF = 'f1'.repeat(12);
const PROOF = { razorpayOrderId: 'order_1', razorpayPaymentId: 'pay_1', razorpaySignature: 'sig_1' };

type Call = { url: string; method: string; body: unknown };
function client(answer: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const c = createApiClient({ baseUrl: '', getToken: () => 'tok', timeoutMs: 100, fetchImpl: async (u, init) => {
    const call = { url: String(u), method: String(init?.method), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return (await answer(call)).clone();
  } });
  return { c, calls };
}
const refund = (o: Partial<CardRefund> = {}): CardRefund => ({
  refundId: RF, bookingId: BK, paymentRecordId: REC, amountMinor: 50_000, cause: 'booker', method: 'card', state: 'pending', lastError: null, attempts: 1,
  razorpayRefundId: null, processedAt: null, createdAt: '2026-11-23T10:00:00.000Z', updatedAt: '2026-11-23T10:00:00.000Z', ...o,
});

describe('card payment answers: only the server says paid or refunded', () => {
  it('reads verify and reconcile answers', () => {
    expect(outcomeOfAnswer({ context: 'assisted_booking', paymentRecord: { status: 'paid' }, entity: { _id: BK, status: 'confirmed' } }))
      .toEqual({ kind: 'paid', booking: { _id: BK, status: 'confirmed' } });
    expect(outcomeOfAnswer({ state: 'paid', paymentRecord: { status: 'refunded' } })).toEqual({ kind: 'refunded' });
    expect(outcomeOfAnswer({ state: 'unpaid', gatewayStatuses: ['failed'] })).toEqual({ kind: 'unpaid' });
    // Anything else settles nothing.
    for (const a of [null, undefined, {}, { paymentRecord: { status: 'created' } }, { paymentRecord: {} }]) expect(outcomeOfAnswer(a as never)).toBeNull();
  });

  it('reads refusals: refunded and failed are final, 403 is blocked, anything else settles nothing', () => {
    expect(outcomeOfError(err(400, 'PAYMENT_REFUNDED'))).toEqual({ kind: 'refunded' });
    expect(outcomeOfError(err(400, 'PAYMENT_FAILED'))).toMatchObject({ kind: 'failed' });
    expect(outcomeOfError(err(403, 'PHARMACY_INACTIVE'))).toMatchObject({ kind: 'blocked', message: expect.stringMatching(/^Your pharmacy account is not active or not verified/) });
    expect(outcomeOfError(err(403, 'PHARMACY_NOT_VERIFIED'))).toMatchObject({ kind: 'blocked' });
    for (const e of [err(400, 'PAYMENT_SIGNATURE_INVALID'), err(400, 'PAYMENT_NOT_COMPLETED'), err(409, 'PAYMENT_CHANGED'), err(502, 'RAZORPAY_PAYMENT_FETCH_FAILED'), err(0, 'NETWORK'), new Error('x')]) {
      expect(outcomeOfError(e)).toBeNull();
    }
    expect(cardCheckProblem(err(409, 'PAYMENT_CHANGED'))).toBe('The payment changed while it was checked. Check again.');
    expect(cardCheckProblem(err(502, 'RAZORPAY_PAYMENT_FETCH_FAILED'))).toBe('Razorpay could not be asked just now. Check again in a minute.');
    expect(cardCheckProblem(err(0, 'NETWORK'))).toBe('Razorpay could not be asked just now. Check again in a minute.');
  });

  it('verify sends the proof with no `module`; a paid answer needs no reconcile', async () => {
    const { c, calls } = client(() => json(200, { success: true, data: { context: 'assisted_booking', paymentRecord: { status: 'paid' }, entity: { _id: BK, status: 'confirmed' } } }));
    await expect(settleCardPayment(c, REC, PROOF)).resolves.toMatchObject({ kind: 'paid' });
    expect(calls).toEqual([{ url: '/api/v1/payments/verify', method: 'POST', body: { paymentTransactionId: REC, ...PROOF } }]);
  });

  it('a lost verify answer falls back to reconcile (the record id only)', async () => {
    const { c, calls } = client((call) => (call.url.endsWith('/verify') ? json(502, { error: 502, message: 'Bad gateway' })
      : json(200, { success: true, data: { state: 'paid', context: 'assisted_booking', paymentRecord: { status: 'paid' }, entity: { _id: BK } } })));
    await expect(settleCardPayment(c, REC, PROOF)).resolves.toMatchObject({ kind: 'paid' });
    expect(calls.map((x) => x.url)).toEqual(['/api/v1/payments/verify', '/api/v1/payments/reconcile']);
    expect(calls[1]!.body).toEqual({ paymentTransactionId: REC });
  });

  it('a late capture is refunded (verify answer or a repeat refusal), and is never read as paid', async () => {
    let answer = json(200, { success: true, data: { context: 'assisted_booking', paymentRecord: { status: 'refunded' }, entity: { _id: BK, status: 'cancelled' } } });
    const { c, calls } = client(() => answer);
    await expect(settleCardPayment(c, REC, PROOF)).resolves.toEqual({ kind: 'refunded' });
    answer = json(400, { error: 400, code: 'PAYMENT_REFUNDED', message: 'Payment is already marked as refunded' });
    await expect(settleCardPayment(c, REC, PROOF)).resolves.toEqual({ kind: 'refunded' });
    expect(calls).toHaveLength(2); // settled by verify: no reconcile
  });

  it('a closed Checkout asks the server only; unpaid, 403 and errors in words', async () => {
    let answer = json(200, { success: true, data: { state: 'unpaid', gatewayStatuses: [] } });
    const { c, calls } = client(() => answer);
    await expect(settleCardPayment(c, REC, null)).resolves.toEqual({ kind: 'unpaid' });
    expect(calls.map((x) => x.url)).toEqual(['/api/v1/payments/reconcile']);
    answer = json(403, { error: 403, code: 'PHARMACY_INACTIVE', message: 'Pharmacy is inactive' });
    await expect(checkCardPayment(c, REC)).resolves.toMatchObject({ kind: 'blocked' });
    answer = json(503, { error: 503, message: 'down' });
    await expect(checkCardPayment(c, REC)).resolves.toEqual({ kind: 'unknown', message: 'Razorpay could not be asked just now. Check again in a minute.' });
    answer = json(200, { success: true, data: { state: 'odd' } });
    await expect(checkCardPayment(c, REC)).resolves.toMatchObject({ kind: 'unknown' });
    await expect(checkCardPayment(c, 'order_1')).resolves.toMatchObject({ kind: 'unknown' }); // not a record id: never sent
    expect(calls).toHaveLength(4);
  });

  it('pay-by words in India time; a booking waiting for its card payment', () => {
    expect(payByClock('2026-11-23T09:05:00.000Z')).toBe('14:35');
    expect(payByWords('2026-11-23T09:05:00.000Z')).toBe('Pay before 14:35 or the time is released.');
    expect(payByWords(undefined)).toBe('Pay within 30 minutes of booking or the time is released.');
    expect(payByWords('nonsense')).toBe('Pay within 30 minutes of booking or the time is released.');
    expect(awaitingCardPayment({ status: 'pending', paymentStatus: 'pending' })).toBe(true);
    expect(awaitingCardPayment({ status: 'confirmed', paymentStatus: 'paid' })).toBe(false);
    expect(awaitingCardPayment({ status: 'cancelled', paymentStatus: 'pending' })).toBe(false);
  });
});

describe('create refusals for card or UPI', () => {
  it('switch off, nothing to pay and no gateway keys are "pay from the wallet"; the 502 order failure is not', () => {
    expect(assistedRefusal(err(400, 'PAYMENT_METHOD_UNAVAILABLE'))).toEqual({ kind: 'card', message: 'Card payment is not switched on yet. Pay from your Jansetu wallet.' });
    expect(assistedRefusal(err(400, 'NOTHING_TO_PAY'))).toMatchObject({ kind: 'card', message: expect.stringMatching(/^There is nothing to pay for this consultation/) });
    expect(assistedRefusal(err(503, 'RAZORPAY_NOT_CONFIGURED'))).toEqual({ kind: 'card', message: 'Card and UPI payments are not set up on this server yet.' });
    expect(assistedRefusal(err(502, 'RAZORPAY_ORDER_CREATION_FAILED')).kind).toBe('other');
  });

  it('no gateway keys (503) is refused before any booking write; a 502 order failure is not (the booking is held)', () => {
    expect(refusedBeforeWriting(err(503, 'RAZORPAY_NOT_CONFIGURED'))).toBe(true);
    expect(refusedBeforeWriting(err(502, 'RAZORPAY_ORDER_CREATION_FAILED'))).toBe(false);
  });

  it('the create carries the method; by-key answers the open order; the cancel sends refundTo', async () => {
    const { c, calls } = client((call) => (call.url.includes('/by-key/')
      ? json(200, { success: true, data: { state: 'used', booking: { _id: BK, status: 'pending', paymentStatus: 'pending' }, payment: { paymentTransactionId: REC } } })
      : json(200, { success: true, data: {} })));
    const a = pharmacyAssistedApi(c);
    await expect(a.byKey('k'.repeat(32))).resolves.toMatchObject({ state: 'used', payment: { paymentTransactionId: REC } });
    await a.cancel(BK, { refundTo: 'wallet' });
    expect(calls.at(-1)).toEqual({ url: `/api/v1/pharmacy-assisted/bookings/${BK}/cancel`, method: 'POST', body: { refundTo: 'wallet' } });
  });
});

describe('refunds of card-paid bookings in plain words', () => {
  it('says the server’s state only', () => {
    expect(cardRefundWords(refund())).toBe('Refund of ₹500.00 to the card or UPI: in progress. It usually reaches the card in 5 to 7 working days.');
    expect(cardRefundWords(refund({ state: 'processed' }))).toBe('₹500.00 was refunded to the card or UPI it was paid with.');
    expect(cardRefundWords(refund({ state: 'failed' }))).toBe('The refund of ₹500.00 to the card or UPI did not go through. Jansetu will contact you to return it another way.');
    expect(cardRefundWords(refund({ state: 'manual_review' }))).toBe('The refund of ₹500.00 is held for a check by Jansetu. Jansetu will contact you.');
    expect(cardRefundWords(refund({ method: 'wallet', state: 'processed' }))).toBe('₹500.00 is back in your Jansetu wallet. This money pays for bookings; it cannot be withdrawn.');
    expect(cardRefundWords(refund({ method: 'wallet', state: 'pending' }))).toBe('₹500.00 is being returned to your Jansetu wallet.');
  });

  it('the cancel answer: a wallet booking (no `refund`), a card one, one cancelled unpaid, a repeat', () => {
    const base: CancelAnswer = { booking: { _id: BK, status: 'cancelled' }, refundedMinor: 50_000, alreadyCancelled: false };
    expect(cancelWords(base)).toBe('Cancelled. ₹500.00 is back in your Jansetu wallet. The patient and the doctor are told.');
    expect(cancelWords({ ...base, refundedMinor: 0, refund: refund() })).toMatch(/^Cancelled\. Refund of ₹500.00 to the card or UPI: in progress\./);
    expect(cancelWords({ ...base, refundedMinor: 0, refund: null })).toBe('Cancelled. It was not paid, so nothing is refunded.');
    expect(cancelWords({ ...base, alreadyCancelled: true, refund: refund() })).toBe('It was already cancelled. Nothing was refunded twice.');
  });
});

describe('admin: card refunds that need a person', () => {
  it('agreement rule, rows, refusals', () => {
    expect(agreementProblem('  ')).toMatch(/^Write what the pharmacy agreed to/);
    expect(agreementProblem('x'.repeat(501))).toBe('Use at most 500 characters.');
    expect(agreementProblem(' owner agreed on a call ')).toBeUndefined();
    expect(cardRefundRowsOf([refund(), { refundId: 'bad' }, null, refund({ refundId: 'f2'.repeat(12), amountMinor: 1.5 })]).map((r) => r.refundId)).toEqual([RF]);
    expect(cardRefundRowsOf({ not: 'a list' })).toEqual([]);
    expect(moveRefundRefusal(err(409, 'REFUND_NOT_FAILED'))).toMatch(/^Only a refund that failed or is held for a check can be moved/);
    expect(moveRefundRefusal(err(409, 'CHARGEBACK_RECORDED'))).toBe('A card dispute was recorded on this payment: the bank already took the money back. Nothing was moved.');
    expect(moveRefundRefusal(err(404, 'REFUND_NOT_FOUND'))).toBe('This refund was not found. Nothing was changed.');
    expect(moveRefundRefusal(err(503, 'ASSISTED_BOOKING_DISABLED'))).toMatch(/^The admin tools are switched off/);
    expect(moveRefundRefusal(err(404))).toMatch(/^The admin tools are switched off/);
    expect(moveRefundRefusal(err(403, 'FORBIDDEN'))).toBe('Only Jansetu admins can move a refund.');
    expect(moveRefusedBeforeWriting(err(503, 'ASSISTED_BOOKING_DISABLED'))).toBe(true);
    expect(moveRefusedBeforeWriting(err(503))).toBe(false);
    for (const [s, c] of [[409, 'REFUND_NOT_FAILED'], [409, 'CHARGEBACK_RECORDED'], [404, 'REFUND_NOT_FOUND']] as const) expect(moveRefundFinal(err(s, c))).toBe(true);
    for (const [s, c] of [[409, 'REFUND_CHANGED'], [503, 'ASSISTED_BOOKING_DISABLED'], [404, undefined]] as const) expect(moveRefundFinal(err(s, c))).toBe(false);
  });

  it('the queue read, the move (trimmed agreement; only a wallet credit counts) and the check among processed rows', async () => {
    let answer = json(200, { success: true, data: [refund({ state: 'failed' })] });
    const { c, calls } = client(() => answer);
    const a = adminCardRefundsApi(c);
    await expect(a.queue()).resolves.toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/v1/admin/assisted/card-refunds');
    answer = json(200, { success: true, data: { refund: refund({ method: 'wallet', state: 'processed' }), replayed: false } });
    await expect(a.toWallet(RF.toUpperCase(), '  owner   agreed ')).resolves.toMatchObject({ replayed: false, refund: { method: 'wallet' } });
    expect(calls.at(-1)).toEqual({ url: `/api/v1/admin/assisted/card-refunds/${RF}/to-wallet`, method: 'POST', body: { agreement: 'owner agreed' } });
    await expect(a.toWallet('nope', 'x')).rejects.toThrow('Invalid refund id');
    await expect(a.toWallet(RF, ' ')).rejects.toThrow('Invalid agreement');
    for (const data of [null, {}, { refund: refund({ state: 'failed' }) }, { refund: refund({ state: 'processed' }) }]) {
      answer = json(200, { success: true, data });
      await expect(a.toWallet(RF, 'ok')).rejects.toMatchObject({ status: 502 });
    }
    answer = json(200, { success: true, data: [refund({ method: 'wallet', state: 'processed' })] });
    await expect(findMovedRefund(c, RF)).resolves.toMatchObject({ refundId: RF });
    expect(calls.at(-1)!.url).toBe('/api/v1/admin/assisted/card-refunds?state=processed&limit=200');
    answer = json(200, { success: true, data: [refund({ state: 'processed' })] }); // processed to the card: not a move
    await expect(findMovedRefund(c, RF)).resolves.toBeNull();
  });
});
