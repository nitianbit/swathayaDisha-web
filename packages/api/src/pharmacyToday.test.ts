import { describe, expect, it } from 'vitest';
import { createApiClient } from './client.ts';
import { bookingsWaiting, moneyParts, pendingCount, pharmacyTodayApi, todayApi, todayLink, todayOf, todoText } from './pharmacyToday.ts';

// WQ54 (P1): the day's register and the pharmacy's to-dos (backend r37, draft shapes).

const TODO = 'a7'.repeat(12);
const KEY = 'k'.repeat(32);
type Call = { url: string; method: string; body: unknown };
function client() {
  const calls: Call[] = [];
  const c = createApiClient({ baseUrl: '', getToken: () => 'tok', timeoutMs: 100, fetchImpl: async (u, init) => {
    calls.push({ url: String(u), method: String(init?.method), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ success: true, data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } });
  return { c, calls };
}

describe('WQ54 pharmacy today and to-dos', () => {
  it('the routes and bodies; bad dates, ids, keys and texts are refused before any request', async () => {
    const { c, calls } = client();
    const a = pharmacyTodayApi(c);
    await a.today();
    await a.today({ date: '2026-11-26', cursor: 'c1', limit: 200 });
    await a.todos();
    await a.addTodo('  Call   supplier ', KEY);
    await a.setDone(TODO, true, 3);
    await a.remove(TODO);
    await a.today({ order: 'desc', limit: 10 });
    await a.search({ date: '2026-11-26', q: '  Asha ', order: 'desc' });
    expect(calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      'GET /api/v1/pharmacy-assisted/today',
      'GET /api/v1/pharmacy-assisted/today?date=2026-11-26&cursor=c1&limit=200',
      'GET /api/v1/pharmacy-assisted/todos',
      'POST /api/v1/pharmacy-assisted/todos',
      `PATCH /api/v1/pharmacy-assisted/todos/${TODO}`,
      `DELETE /api/v1/pharmacy-assisted/todos/${TODO}`,
      'GET /api/v1/pharmacy-assisted/today?limit=10&order=desc',
      'POST /api/v1/pharmacy-assisted/today/search',
    ]);
    expect(calls[3]!.body).toEqual({ text: 'Call supplier', requestKey: KEY });
    expect(calls[4]!.body).toEqual({ done: true, expectedVersion: 3 });
    // r37c: the search is in the body (never in an address).
    expect(calls[7]!.body).toEqual({ date: '2026-11-26', q: 'Asha', order: 'desc' });
    expect(() => a.search({ q: ' a ' })).toThrow();
    expect(() => a.today({ date: '2026-02-31' })).toThrow();
    expect(() => a.today({ limit: 201 })).toThrow();
    expect(() => a.setDone('nope', true, 1)).toThrow();
    expect(() => a.addTodo('x', 'bad key')).toThrow();
    expect(() => a.addTodo('   ', KEY)).toThrow();
    expect(calls).toHaveLength(8);
    expect(todoText('x'.repeat(201))).toBeNull();
  });

  it('the money line: only the methods that received money', () => {
    expect(moneyParts({ collectedMinor: 82000, byMethod: { cash: 32000, wallet: 50000, card: 0, bank: 0 }, unpaidMinor: 0, count: 2 }))
      .toEqual([{ key: 'cash', minor: 32000 }, { key: 'wallet', minor: 50000 }]);
    expect(moneyParts({ collectedMinor: 100, byMethod: { card: 100 }, unpaidMinor: 0, count: 1 }).map((p) => p.key)).toEqual(['card']);
    expect(moneyParts({ collectedMinor: 0, byMethod: {}, unpaidMinor: 0, count: 0 })).toEqual([]);
  });

  it('truncated is a list (only a non-empty one is kept); bookings waiting by kind', () => {
    expect(todayOf({ items: [], totals: {}, truncated: [] }).truncated).toBeUndefined();
    expect(todayOf({ items: [], totals: {}, truncated: true }).truncated).toBeUndefined();
    expect(todayOf({ items: [], totals: {}, truncated: ['items'] }).truncated).toEqual(['items']);
    // r38b: refunds that day, kept only when there were any.
    expect(todayOf({ items: [], totals: { refundedMinor: 5000 } }).totals.refundedMinor).toBe(5000);
    expect(todayOf({ items: [], totals: { refundedMinor: 0 } }).totals).not.toHaveProperty('refundedMinor');
    expect(bookingsWaiting({ bookingsAwaiting: { count: 3, consultationCount: 2, labCount: 1 } })).toEqual({ consultations: 2, labBookings: 1 });
    expect(bookingsWaiting({ bookingsAwaiting: { count: 2, consultationIds: ['a'], labBookingIds: ['b'] } })).toEqual({ consultations: 1, labBookings: 1 });
    expect(bookingsWaiting({ bookingsAwaiting: null })).toBeNull();
  });

  it('an answer of another shape (an older server, a broken one) is empty, never a crash', () => {
    expect(todayOf([])).toEqual({ items: [], totals: { collectedMinor: 0, byMethod: {}, unpaidMinor: 0, count: 0 }, nextCursor: null });
    expect(todayOf({ items: [null, { id: 'x' }], totals: { collectedMinor: 'a' } }).items).toEqual([{ id: 'x' }]);
  });

  it('a row opens its record; pending counts are read safely', () => {
    const id = 'b1'.repeat(12);
    expect(todayLink({ link: { kind: 'pharmacy_order', id } })).toBe(`/pharmacy/orders/${id}`);
    expect(todayLink({ link: { kind: 'booking', id } })).toBe(`/pharmacy/consultations/${id}`);
    expect(todayLink({ link: { kind: 'lab_booking', id } })).toBe(`/pharmacy/lab-tests/${id}`);
    expect(todayLink({ link: { kind: 'wallet_transaction', id } })).toBe('/pharmacy/wallet');
    expect(todayLink({ link: { kind: 'other', id } })).toBeNull();
    expect(todayLink({ link: null })).toBeNull();
    expect(pendingCount({ prescriptionsToReview: { count: 3 } }, 'prescriptionsToReview')).toBe(3);
    expect(pendingCount(undefined, 'lowStock')).toBe(0);
    expect(pendingCount({ labReportsReady: null }, 'labReportsReady')).toBeNull();
  });

  it('WQ55: a lab desk reads the same shapes on its own routes; its rows open its own pages', async () => {
    const { c, calls } = client();
    const a = todayApi(c, 'lab');
    await a.today({ order: 'desc', limit: 10 });
    await a.search({ q: 'CBC' });
    await a.todos();
    await a.addTodo('Call courier', KEY);
    await a.setDone(TODO, true, 1);
    expect(calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      'GET /api/v1/partner-workspace/today?limit=10&order=desc',
      'POST /api/v1/partner-workspace/today/search',
      'GET /api/v1/partner-workspace/todos',
      'POST /api/v1/partner-workspace/todos',
      `PATCH /api/v1/partner-workspace/todos/${TODO}`,
    ]);
    const id = 'b1'.repeat(12);
    expect(todayLink({ link: { kind: 'lab_booking', id } }, 'lab')).toBe(`/partner/lab-bookings/${id}`);
    expect(todayLink({ link: { kind: 'invoice', id } }, 'lab')).toBe(`/partner/invoices/${id}`);
    expect(todayLink({ link: { kind: 'booking', id } }, 'lab')).toBe(`/partner/consultations/${id}`);
    expect(todayLink({ link: { kind: 'pharmacy_order', id } }, 'lab')).toBeNull();
    expect(todayLink({ link: { kind: 'invoice', id } })).toBeNull();
    expect(todayLink({ link: { kind: 'wallet_entry', id } }, 'lab')).toBe('/partner/wallet');
    expect(pendingCount({ samplesToCollect: { count: 2, visitCount: 1, homeCount: 1 } }, 'samplesToCollect')).toBe(2);
    // A queue this member may not read is absent (no line); a failing one is null.
    expect(pendingCount({}, 'consultationsWaiting')).toBe(0);
    expect(pendingCount({ unpaidBills: null }, 'unpaidBills')).toBeNull();
  });

  it('WQ57: a clinic reception reads the lab routes; its appointments open the day, its bills their page', () => {
    const id = 'b1'.repeat(12);
    expect(todayLink({ link: { kind: 'booking', id } }, 'clinic')).toBe('/partner/desk');
    expect(todayLink({ link: { kind: 'invoice', id } }, 'clinic')).toBe(`/partner/invoices/${id}`);
    expect(todayLink({ link: { kind: 'lab_booking', id } }, 'clinic')).toBeNull();
    expect(pendingCount({ appointmentsToday: { count: 4, toCheckInCount: 3, toConfirmCount: 1 } }, 'appointmentsToday')).toBe(4);
  });
});
