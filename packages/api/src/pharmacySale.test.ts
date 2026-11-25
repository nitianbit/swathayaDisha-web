import { describe, expect, it } from 'vitest';
import { createApiClient } from './client.ts';
import { pharmacySaleApi, sameSale, walkInProblems, type SaleBody } from './pharmacySale.ts';
import type { PharmacyOrder } from './pharmacyOrders.ts';

// WQ50: the pharmacy's counter sale (backend stage 43f46f57).

const CUST = 'c1'.repeat(12);
const MED = 'a1'.repeat(12);
const ORDER = 'b1'.repeat(12);
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
  it('the routes and the bodies: an in-store pickup paid at the counter, no price and no request key sent', async () => {
    const { c, calls } = client();
    const s = pharmacySaleApi(c);
    await s.customers('');
    await s.customers(' ravi ');
    await s.linkWalkIn({ name: '  Meena   Shah ', phone: '9123456780' });
    await s.create({ customerId: CUST, items: [{ medicineId: MED, orderedQty: 2 }], isWalkIn: true, prescriptionUrls: [] });
    await s.create({ customerId: CUST, items: [{ medicineId: MED, orderedQty: 1 }], isWalkIn: false, prescriptionUrls: ['/api/static/x.pdf'] });
    await s.recentFor(CUST);
    await s.order(ORDER);
    await s.markPaid(ORDER, 'upi');
    await s.uploadPrescription(new File(['%PDF'], 'rx.pdf'));
    expect(calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      'GET /api/v1/pharmacy-customers?page=1&limit=20',
      'GET /api/v1/pharmacy-customers?search=ravi&page=1&limit=20',
      'POST /api/v1/pharmacy-customers',
      'POST /api/v1/pharmacy-orders',
      'POST /api/v1/pharmacy-orders',
      `GET /api/v1/pharmacy-orders?customerId=${CUST}&orderType=in_store&limit=20`,
      `GET /api/v1/pharmacy-orders/${ORDER}`,
      `POST /api/v1/pharmacy-orders/${ORDER}/mark-paid`,
      'POST /api/v1/file/upload/pharmacy-order-prescription',
    ]);
    expect(calls[2]!.body).toEqual({ name: 'Meena Shah', phone: '9123456780', consent: true });
    expect(calls[3]!.body).toEqual({ orderType: 'in_store', customerId: CUST, items: [{ medicineId: MED, orderedQty: 2 }], paymentMode: 'in_store_payment',
      deliveryMode: 'pickup', isWalkIn: true });
    expect(calls[4]!.body).toMatchObject({ prescriptionUrls: ['/api/static/x.pdf'] });
    expect(calls[7]!.body).toEqual({ paymentSource: 'upi' });
    expect(() => s.create({ customerId: 'nope', items: [], isWalkIn: false, prescriptionUrls: [] })).toThrow();
  });

  it('a walk-in is checked as the server checks it', () => {
    expect(walkInProblems({ name: 'Meena', phone: '9123456780', consent: true })).toEqual({});
    expect(walkInProblems({ name: ' ', phone: '12345', consent: false })).toEqual({ name: true, phone: true, consent: true });
    expect(walkInProblems({ name: 'x'.repeat(201), phone: '9123456780', consent: true })).toEqual({ name: true });
  });

  it('a lost sale is this customer’s in-store order with the same lines, made since the attempt', () => {
    const body: SaleBody = { customerId: CUST, items: [{ medicineId: MED, orderedQty: 2 }], isWalkIn: false, prescriptionUrls: [] };
    const at = Date.parse('2026-11-26T05:30:00.000Z');
    const order = (o: Partial<PharmacyOrder>) => ({ _id: ORDER, pharmacyId: 'p', customerId: CUST.toUpperCase(), orderType: 'in_store', status: 'placed',
      items: [{ medicineId: MED, orderedQty: 2, unitPrice: 20, lineTotal: 40 }], createdAt: '2026-11-26T05:29:30.000Z', ...o }) as PharmacyOrder;
    expect(sameSale(order({}), body, at)).toBe(true);
    expect(sameSale(order({ customerId: { _id: CUST, name: 'R' } }), body, at)).toBe(true);
    expect(sameSale(order({ orderType: 'online' }), body, at)).toBe(false);
    expect(sameSale(order({ createdAt: '2026-11-26T05:20:00.000Z' }), body, at)).toBe(false);
    expect(sameSale(order({ items: [{ medicineId: MED, orderedQty: 3, unitPrice: 20, lineTotal: 60 }] }), body, at)).toBe(false);
  });
});
