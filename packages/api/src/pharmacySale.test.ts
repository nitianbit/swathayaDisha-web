import { describe, expect, it } from 'vitest';
import { createApiClient } from './client.ts';
import { pharmacySaleApi, saleRequestBody, usableCustomers, walkInProblems } from './pharmacySale.ts';
import { isRxMedicine } from './inventory.ts';
import { pharmacyOrdersApi } from './pharmacyOrders.ts';

// WQ50 / WQ50b: the pharmacy's counter sale (backend r36, stage 135b5639).

const CUST = 'c1'.repeat(12);
const MED = 'a1'.repeat(12);
const ORDER = 'b1'.repeat(12);
const KEY = 'k'.repeat(32);
type Call = { url: string; method: string; body: unknown };
function client() {
  const calls: Call[] = [];
  const c = createApiClient({ baseUrl: '', getToken: () => 'tok', timeoutMs: 100, fetchImpl: async (u, init) => {
    calls.push({ url: String(u), method: String(init?.method), body: init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : init?.body ? 'form' : undefined });
    return new Response(JSON.stringify({ success: true, data: [], pagination: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } });
  return { c, calls };
}

describe('WQ50 counter sale', () => {
  it('the routes and the bodies: a POST search (nothing in the address), an in-store pickup paid at the counter with its key, no price sent', async () => {
    const { c, calls } = client();
    const s = pharmacySaleApi(c);
    await s.customers('');
    await s.customers(' ravi ');
    await s.linkWalkIn({ name: '  Meena   Shah ', phone: '9123456780' });
    await s.create(saleRequestBody({ customerId: CUST, items: [{ medicineId: MED, orderedQty: 2 }], isWalkIn: true, prescriptionUrls: [] }), KEY);
    await s.create(saleRequestBody({ customerId: CUST, items: [{ medicineId: MED, orderedQty: 1 }], isWalkIn: false, prescriptionUrls: ['/api/static/x.pdf'] }), KEY);
    await s.byKey(KEY);
    await s.abandon(KEY);
    await pharmacyOrdersApi(c).get(ORDER);
    await pharmacyOrdersApi(c).markPaid(ORDER, { paymentSource: 'upi' });
    await s.uploadPrescription(new File(['%PDF'], 'rx.pdf'));
    expect(calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      'POST /api/v1/pharmacy-customers/search',
      'POST /api/v1/pharmacy-customers/search',
      'POST /api/v1/pharmacy-customers',
      'POST /api/v1/pharmacy-orders',
      'POST /api/v1/pharmacy-orders',
      `GET /api/v1/pharmacy-orders/by-key/${KEY}`,
      `POST /api/v1/pharmacy-orders/by-key/${KEY}/abandon`,
      `GET /api/v1/pharmacy-orders/${ORDER}`,
      `POST /api/v1/pharmacy-orders/${ORDER}/mark-paid`,
      'POST /api/v1/file/upload/pharmacy-order-prescription',
    ]);
    expect(calls[0]!.body).toEqual({ page: 1, limit: 20 });
    expect(calls[1]!.body).toEqual({ search: 'ravi', page: 1, limit: 20 });
    expect(calls[2]!.body).toEqual({ name: 'Meena Shah', phone: '9123456780', consent: true });
    expect(calls[3]!.body).toEqual({ orderType: 'in_store', customerId: CUST, items: [{ medicineId: MED, orderedQty: 2 }], paymentMode: 'in_store_payment',
      deliveryMode: 'pickup', isWalkIn: true, requestKey: KEY });
    expect(calls[4]!.body).toMatchObject({ prescriptionUrls: ['/api/static/x.pdf'], requestKey: KEY });
    expect(calls[8]!.body).toEqual({ paymentSource: 'upi' });
    // A bad id or key is a throw before anything is sent.
    expect(() => saleRequestBody({ customerId: 'nope', items: [], isWalkIn: false, prescriptionUrls: [] })).toThrow();
    expect(() => s.byKey('bad key')).toThrow();
    // r36b: a keyed sale is never online and never without a customer (400 REQUEST_KEY_UNSUPPORTED otherwise).
    expect(saleRequestBody({ customerId: CUST, items: [], isWalkIn: true, prescriptionUrls: [] })).toMatchObject({ paymentMode: 'in_store_payment', customerId: CUST });
    expect(() => saleRequestBody({ customerId: '', items: [], isWalkIn: true, prescriptionUrls: [] })).toThrow();
    expect(calls).toHaveLength(10);
    expect(usableCustomers([{ _id: 'x', userId: null }, { _id: 'y', userId: { name: 'A' } }, { _id: 'z', userId: { _id: CUST } }]).map((r) => r._id)).toEqual(['z']);
  });

  it('r36b: a stock row\'s prescription flag is `rx`', () => {
    expect(isRxMedicine({ _id: MED, rx: true })).toBe(true);
    expect(isRxMedicine({ _id: MED, rx: false })).toBe(false);
    expect(isRxMedicine({ _id: MED, prescriptionRequired: true } as never)).toBe(false);
    expect(isRxMedicine(MED)).toBe(false);
  });

  it('a walk-in is checked as the server checks it', () => {
    expect(walkInProblems({ name: 'Meena', phone: '9123456780', consent: true })).toEqual({});
    expect(walkInProblems({ name: ' ', phone: '12345', consent: false })).toEqual({ name: true, phone: true, consent: true });
    expect(walkInProblems({ name: 'x'.repeat(201), phone: '9123456780', consent: true })).toEqual({ name: true });
  });
});
