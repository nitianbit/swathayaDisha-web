import { describe, expect, it } from 'vitest';
import { createApiClient } from './client.ts';
import { cancelWords, cardBookingState, orderFromBooking } from './assistedCard.ts';
import { canCancelLab, pharmacyLabApi } from './assistedLab.ts';

// WQ17c (backend r14 phase 2b, design §24.14): a lab booking paid by card or UPI on the consultation's card machinery.

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const BK = 'e1'.repeat(12);
const REC = 'c1'.repeat(12);

describe('one card machinery, by booking kind', () => {
  it('where a card booking stands: a consultation and a lab test', () => {
    expect(cardBookingState('consultation', { status: 'pending', paymentStatus: 'pending' })).toBe('waiting');
    expect(cardBookingState('consultation', { status: 'confirmed', paymentStatus: 'paid' })).toBe('paid');
    expect(cardBookingState('consultation', { status: 'cancelled', paymentStatus: 'pending' })).toBe('ended');
    expect(cardBookingState('lab', { status: 'pending_payment' })).toBe('waiting');
    expect(cardBookingState('lab', { status: 'confirmed' })).toBe('paid');
    expect(cardBookingState('lab', { status: 'sample_collected' })).toBe('paid');
    expect(cardBookingState('lab', { status: 'cancelled' })).toBe('ended');
  });

  it('the open order from a lab view (no price there: no amount, Checkout takes the order’s own)', () => {
    const payment = { method: 'razorpay' as const, state: 'pending', payBy: '2026-11-25T10:00:00.000Z', paymentTransactionId: REC, razorpayOrderId: 'order_L1', razorpayKeyId: 'rzp_test' };
    expect(orderFromBooking({ payment })).toEqual({ paymentRequired: true, paymentTransactionId: REC, razorpayOrderId: 'order_L1', razorpayKeyId: 'rzp_test',
      currency: 'INR', payBy: '2026-11-25T10:00:00.000Z' });
    expect(orderFromBooking({ payment, price: 300 })).toMatchObject({ amount: 300, amountMinor: 30_000 });
  });

  it('cancel words say who is told; a lab card booking waiting for payment may be cancelled at any time', () => {
    const a = { refundedMinor: 30_000, alreadyCancelled: false };
    expect(cancelWords(a, 'The patient is told.')).toBe('Cancelled. ₹300.00 is back in your Jansetu wallet. The patient is told.');
    expect(cancelWords(a)).toBe('Cancelled. ₹300.00 is back in your Jansetu wallet. The patient and the doctor are told.');
    expect(canCancelLab({ status: 'pending_payment', slot: { startsAt: new Date(Date.now() + 10 * 60_000).toISOString() }, reschedule: null })).toBe(true);
  });

  it('the lab cancel sends refundTo; the list asks for the bookings waiting for payment', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const c = createApiClient({ baseUrl: '', getToken: () => 'tok', timeoutMs: 100, fetchImpl: async (u, init) => {
      calls.push({ url: String(u), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return json(200, { success: true, data: [], pagination: { total: 0, nextCursor: null } });
    } });
    const labs = pharmacyLabApi(c);
    await labs.cancel(BK, { expectedVersion: 2, refundTo: 'wallet' });
    await labs.bookings({ status: 'pending_payment' });
    expect(calls).toEqual([
      { url: `/api/v1/pharmacy-assisted/lab-bookings/${BK}/cancel`, body: { expectedVersion: 2, refundTo: 'wallet' } },
      { url: '/api/v1/pharmacy-assisted/lab-bookings?status=pending_payment', body: undefined },
    ]);
  });
});
