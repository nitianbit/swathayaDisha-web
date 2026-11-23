import { describe, expect, it } from 'vitest';
import { ApiError, createApiClient } from './client.ts';
import { assistedRefusal, type BookedConsultation } from './assisted.ts';
import {
  adminCardRefundsApi, awaitingCardPayment, bookingPaidBy, bookingPayBy, findMarkedFailed, markFailedFinal, markFailedRefusedBeforeWriting, markFailedRefusal,
  moveRefundFinal, moveRefundRefusal, moveRefusedBeforeWriting, outcomeOfError, recheckWords, settleCardPayment,
} from './assistedCard.ts';

// WQ16b (backend r10b/r10c `m0/r10b-phase1b-fixes` 6b223644, design §23.3 and §23.6): the booker view's `payment`, the
// admin rows' pharmacy, recheck and mark-failed, and the new refusals.

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const err = (status: number, code?: string, message = 'refused', extra?: { limit?: string }) => new ApiError(status, message, code, undefined, extra);
const REC = 'c1'.repeat(12);
const RF = 'f1'.repeat(12);
const P1 = 'a1'.repeat(12);
type Call = { url: string; method: string; body: unknown };
function client(answer: (c: Call) => Response) {
  const calls: Call[] = [];
  const c = createApiClient({ baseUrl: '', getToken: () => 'tok', timeoutMs: 100, fetchImpl: async (u, init) => {
    const call = { url: String(u), method: String(init?.method), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return answer(call).clone();
  } });
  return { c, calls };
}
const row = (o: Record<string, unknown> = {}) => ({ refundId: RF, bookingId: 'e1'.repeat(12), paymentRecordId: REC, amountMinor: 50_000, cause: 'booker', method: 'card',
  state: 'pending', lastError: null, attempts: 0, razorpayRefundId: null, processedAt: null, createdAt: '2026-11-22T04:30:00.000Z', updatedAt: '2026-11-22T04:30:00.000Z',
  pharmacyId: P1, pharmacyName: 'Asha Medicals', ...o });

describe('the booker view’s payment (r10c)', () => {
  const b = (o: Partial<BookedConsultation>): BookedConsultation => ({ _id: 'e1'.repeat(12), status: 'confirmed', paymentStatus: 'paid', createdAt: '2026-11-23T09:00:00.000Z', ...o });

  it('says how it was paid; older servers (no field) are unknown', () => {
    expect(bookingPaidBy(b({ payment: { method: 'razorpay', state: 'captured', payBy: null, paymentTransactionId: REC } }))).toBe('card');
    expect(bookingPaidBy(b({ payment: { method: 'wallet', state: 'captured', payBy: null } }))).toBe('wallet');
    expect(bookingPaidBy(b({}))).toBe('unknown');
  });

  it('waits for a card payment only when the server says so; the pay-by time is the server’s', () => {
    const waiting = b({ status: 'pending', paymentStatus: 'pending', payment: { method: 'razorpay', state: 'pending', payBy: '2026-11-23T09:20:00.000Z', paymentTransactionId: REC } });
    expect(awaitingCardPayment(waiting)).toBe(true);
    expect(bookingPayBy(waiting)).toBe('2026-11-23T09:20:00.000Z');
    expect(awaitingCardPayment(b({ status: 'pending', paymentStatus: 'pending', payment: { method: 'razorpay', state: 'not_paid', payBy: null } }))).toBe(false);
    // An older server: the booking's own creation + 30 minutes (the server's rule).
    expect(bookingPayBy(b({ status: 'pending', paymentStatus: 'pending' }))).toBe('2026-11-23T09:30:00.000Z');
  });
});

describe('new refusals (r10b)', () => {
  it('too many card bookings waiting for payment', () => {
    expect(assistedRefusal(err(429, 'ASSISTED_LIMIT_REACHED', 'limit', { limit: 'pending_card_bookings' })))
      .toEqual({ kind: 'limit', message: 'Too many bookings are waiting for payment. Pay or cancel one of them first.' });
  });

  it('a disputed booking payment is said, never read as paid or as not booked', () => {
    expect(outcomeOfError(err(409, 'PAYMENT_DISPUTED'))).toEqual({ kind: 'blocked',
      message: 'A card dispute was recorded on this booking payment. Please contact Jansetu support.' });
  });

  it('a bad signature leaves the booking payable: the server’s check decides (unpaid here)', async () => {
    const { c, calls } = client((x) => (x.url.endsWith('/verify') ? json(400, { error: 400, code: 'PAYMENT_SIGNATURE_INVALID', message: 'bad' })
      : json(200, { success: true, data: { state: 'unpaid', gatewayStatuses: ['authorized'] } })));
    await expect(settleCardPayment(c, REC, { razorpayOrderId: 'order_1', razorpayPaymentId: 'pay_1', razorpaySignature: 'x' })).resolves.toEqual({ kind: 'unpaid' });
    expect(calls.map((x) => x.url)).toEqual(['/api/v1/payments/verify', '/api/v1/payments/reconcile']);
  });

  it('move to wallet: a live refund at Razorpay is final; Razorpay not answering refuses a sole attempt', () => {
    expect(moveRefundFinal(err(409, 'REFUND_AT_GATEWAY'))).toBe(true);
    expect(moveRefusedBeforeWriting(err(502, 'GATEWAY_LOOKUP_FAILED'))).toBe(true);
    expect(moveRefundRefusal(err(409, 'REFUND_AT_GATEWAY'))).toBe('Razorpay already has a refund of this payment, done or on its way, so nothing was moved. Tap “Recheck” to see it.');
    expect(moveRefundRefusal(err(502, 'GATEWAY_LOOKUP_FAILED'))).toBe('Razorpay could not be asked about this payment just now. Nothing was moved. Try again in a minute.');
  });
});

describe('admin: recheck and mark failed (r10b), the pharmacy on each row (r10c)', () => {
  it('rows keep the pharmacy; recheck asks Razorpay now and is said in words', async () => {
    let answer = json(200, { success: true, data: [row()] });
    const { c, calls } = client(() => answer);
    const a = adminCardRefundsApi(c);
    await expect(a.queue()).resolves.toMatchObject([{ pharmacyName: 'Asha Medicals', pharmacyId: P1 }]);
    answer = json(200, { success: true, data: { refund: row({ state: 'processed' }), gateway: [{ id: 'rfnd_1', status: 'processed', amountMinor: 50_000, ours: true }] } });
    const r = await a.recheck(RF);
    expect(calls.at(-1)).toEqual({ url: `/api/v1/admin/assisted/card-refunds/${RF}/recheck`, method: 'POST', body: undefined });
    expect(recheckWords(r)).toBe('Checked with Razorpay: Refunded. Razorpay holds 1 refund of this payment (processed).');
    answer = json(200, { success: true, data: { refund: row(), gateway: [] } });
    expect(recheckWords(await a.recheck(RF))).toBe('Checked with Razorpay: Refund to card in progress. Razorpay holds no refund of this payment yet.');
    answer = json(200, { success: true, data: {} });
    await expect(a.recheck(RF)).rejects.toMatchObject({ status: 502 });
  });

  it('mark failed: trimmed reason, only a failed row counts, refusals and the check', async () => {
    let answer = json(200, { success: true, data: { refund: row({ state: 'failed', lastError: 'MARKED_FAILED_BY_ADMIN' }) } });
    const { c, calls } = client(() => answer);
    const a = adminCardRefundsApi(c);
    await expect(a.markFailed(RF, '  no answer   from Razorpay ')).resolves.toMatchObject({ refund: { state: 'failed' } });
    expect(calls.at(-1)).toEqual({ url: `/api/v1/admin/assisted/card-refunds/${RF}/mark-failed`, method: 'POST', body: { reason: 'no answer from Razorpay' } });
    await expect(a.markFailed(RF, ' ')).rejects.toThrow('Invalid reason');
    answer = json(200, { success: true, data: { refund: row() } });
    await expect(a.markFailed(RF, 'x')).rejects.toMatchObject({ status: 502 });
    expect(markFailedFinal(err(409, 'REFUND_AT_GATEWAY'))).toBe(true);
    expect(markFailedFinal(err(409, 'REFUND_NOT_PENDING'))).toBe(false); // an earlier attempt may have marked it
    expect(markFailedRefusedBeforeWriting(err(502, 'GATEWAY_LOOKUP_FAILED'))).toBe(true);
    expect(markFailedRefusedBeforeWriting(err(503, 'ASSISTED_BOOKING_DISABLED'))).toBe(true);
    expect(markFailedRefusal(err(409, 'REFUND_AT_GATEWAY'))).toBe('Razorpay already has a refund of this payment, done or on its way, so it was not marked failed. Tap “Recheck” to see it.');
    expect(markFailedRefusal(err(409, 'REFUND_BUSY'))).toBe('This refund is being worked on right now. Nothing was changed. Try again in a few minutes.');
    expect(markFailedRefusal(err(409, 'REFUND_NOT_PENDING'))).toBe('Only a card refund still in progress can be marked failed. Read the list again.');
    answer = json(200, { success: true, data: [row({ state: 'failed', lastError: 'MARKED_FAILED_BY_ADMIN' })] });
    await expect(findMarkedFailed(c, RF)).resolves.toMatchObject({ refundId: RF });
    expect(calls.at(-1)!.url).toBe('/api/v1/admin/assisted/card-refunds?state=failed&limit=200');
    answer = json(200, { success: true, data: [row({ state: 'failed', lastError: 'BAD_REQUEST_ERROR' })] });
    await expect(findMarkedFailed(c, RF)).resolves.toBeNull();
  });
});
