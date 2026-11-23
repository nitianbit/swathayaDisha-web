import { describe, expect, it } from 'vitest';
import * as api from './index.ts';
import { ApiError, createApiClient } from './client.ts';

// WQ16d (backend r10e d1ed6d24, design §23.3/§23.6): the admin refund read by id, the duplicate-payment answer, extra captures.

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const RF = 'f1'.repeat(12);
const REC = 'c1'.repeat(12);
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
const row = { refundId: RF, bookingId: 'e1'.repeat(12), paymentRecordId: REC, amountMinor: 50_000, cause: 'booker', method: 'wallet', state: 'processed',
  lastError: null, attempts: 0, createdAt: '2026-11-23T10:00:00.000Z', updatedAt: '2026-11-23T10:00:00.000Z', pharmacyId: 'a1'.repeat(12), pharmacyName: 'Asha Medicals' };

describe('the admin refund read by id (r10e: the row itself as `data`)', () => {
  it('reads one row; an older server is "not available" and never falls back to recheck', async () => {
    let answer = json(200, { success: true, data: row });
    const { c, calls } = client(() => answer);
    await expect(api.readCardRefund(c, RF)).resolves.toMatchObject({ refundId: RF, pharmacyName: 'Asha Medicals' });
    await expect(api.findMovedRefund(c, RF)).resolves.toMatchObject({ refundId: RF });
    answer = json(404, { error: 404, message: 'Route not found' });
    await expect(api.readCardRefund(c, RF)).rejects.toMatchObject({ message: 'Not available on this server yet. The outcome is not known.' });
    answer = json(404, { error: 404, code: 'REFUND_NOT_FOUND', message: 'Refund not found' });
    await expect(api.findMarkedFailed(c, RF)).rejects.toMatchObject({ code: 'REFUND_NOT_FOUND' });
    expect(calls.every((x) => x.method === 'GET' && x.url === `/api/v1/admin/assisted/card-refunds/${RF}`)).toBe(true);
  });
});

describe('verify: another payment of a booking already paid (409 DUPLICATE_PAYMENT_REFUNDED)', () => {
  it('is final for the attempt, never paid; no reconcile', async () => {
    const words = 'This booking was already paid with another payment. This payment is being refunded to the card or UPI.';
    expect(api.outcomeOfError(new ApiError(409, 'x', 'DUPLICATE_PAYMENT_REFUNDED'))).toEqual({ kind: 'duplicate', message: words });
    const { c, calls } = client(() => json(409, { error: 409, code: 'DUPLICATE_PAYMENT_REFUNDED', message: 'refunded' }));
    await expect(api.settleCardPayment(c, REC, { razorpayOrderId: 'order_1', razorpayPaymentId: 'pay_2', razorpaySignature: 's' })).resolves.toEqual({ kind: 'duplicate', message: words });
    expect(calls).toHaveLength(1);
  });

  it('labels the extra capture refund in the admin queue', () => {
    expect(api.CARD_REFUND_CAUSE_LABEL.extra_capture).toBe('Second payment, refunded');
  });
});
