import type { PharmacyOrder } from '@jansetu/api';
import { blockedReason, holdsMoney } from './orderLabels.ts';

const o = (over: Partial<PharmacyOrder>): PharmacyOrder => ({
  _id: 'a'.repeat(24), pharmacyId: 'b'.repeat(24), orderType: 'online', status: 'accepted', items: [],
  paymentMode: 'online_payment', paymentStatus: 'paid', prescriptionStatus: 'not_required', ...over,
});

describe('blockedReason mirrors the backend status rules', () => {
  it('needs payment to progress, except cash on delivery', () => {
    expect(blockedReason(o({ paymentStatus: 'pending' }), 'packed')).toBe('Waiting for payment.');
    expect(blockedReason(o({ paymentStatus: 'pending', paymentMode: 'cash_on_delivery' }), 'packed')).toBeNull();
    expect(blockedReason(o({ paymentStatus: 'pending', paymentMode: 'cash_on_delivery', status: 'out_for_delivery' }), 'completed'))
      .toBe('Record the payment first.');
  });
  it('confirms a refill only after payment', () => {
    const refill = { subscriptionId: 's', cycleDate: '20261114', paymentDueBy: '2026-11-16T00:00:00Z' };
    expect(blockedReason(o({ status: 'placed', paymentStatus: 'pending', refill }), 'accepted')).toMatch(/refill/);
    expect(blockedReason(o({ status: 'placed', paymentStatus: 'pending' }), 'accepted')).toBeNull();
  });
  it('needs an approved prescription to pack', () => {
    expect(blockedReason(o({ prescriptionStatus: 'pending' }), 'packed')).toMatch(/prescription/);
    expect(blockedReason(o({ prescriptionStatus: 'approved' }), 'packed')).toBeNull();
    expect(blockedReason(o({ prescriptionStatus: 'pending', status: 'placed' }), 'accepted')).toBeNull();
  });
  it('treats authorised and partly paid as money held', () => {
    expect(holdsMoney(o({ paymentStatus: 'authorized' }))).toBe(true);
    expect(holdsMoney(o({ paymentStatus: 'partially_paid' }))).toBe(true);
    expect(holdsMoney(o({ paymentStatus: 'pending' }))).toBe(false);
  });
});
