import { describe, expect, it } from 'vitest';
import { ApiError, createApiClient } from './client.ts';
import { branchesFor, canCancelLab, labRefusal, labStatusLabel, labTotalMinor, pharmacyLabApi, type AssistedLab } from './assistedLab.ts';

// WQ17 (backend r11 phase 2a, design §24.11): a pharmacy books a lab test for a walk-in patient.

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const LAB = 'a1'.repeat(12);
const BR = 'b1'.repeat(12);
const BK = 'e1'.repeat(12);
const KEY = 'k'.repeat(32);
type Call = { url: string; method: string; body: unknown };
function client(answer: (c: Call) => Response = () => json(200, { success: true, data: {} })) {
  const calls: Call[] = [];
  const c = createApiClient({ baseUrl: '', getToken: () => 'tok', timeoutMs: 100, fetchImpl: async (u, init) => {
    const call = { url: String(u), method: String(init?.method), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return answer(call).clone();
  } });
  return { c, calls };
}

describe('lab booking requests', () => {
  it('reads labs, catalogue and slots with their queries; ids and keys are checked before sending', async () => {
    const { c, calls } = client(() => json(200, { success: true, data: [] }));
    const a = pharmacyLabApi(c);
    await a.labs({ visitMode: 'home', limit: 50 });
    await a.catalogue(LAB, 'home');
    await a.slots(BR, { visitMode: 'lab', from: '2026-11-24', days: 7 });
    expect(calls.map((x) => x.url)).toEqual([
      '/api/v1/pharmacy-assisted/labs?visitMode=home&limit=50',
      `/api/v1/pharmacy-assisted/labs/${LAB}/catalogue?visitMode=home`,
      `/api/v1/pharmacy-assisted/labs/branches/${BR}/slots?visitMode=lab&from=2026-11-24&days=7`,
    ]);
    expect(() => a.catalogue('nope')).toThrow('Invalid lab id');
    expect(() => a.byKey('x')).toThrow('Invalid request key');
    expect(calls).toHaveLength(3);
  });

  it('the list is cursor-paged; by-key, abandon, cancel (with the version) and accept (with the proposal version)', async () => {
    const { c, calls } = client((x) => (x.url.includes('lab-bookings?')
      ? json(200, { success: true, data: [{ _id: BK, status: 'confirmed' }], pagination: { total: 1, nextCursor: '123_abc' } })
      : json(200, { success: true, data: { state: 'unknown' } })));
    const a = pharmacyLabApi(c);
    await expect(a.bookings({ status: 'confirmed', limit: 20 })).resolves.toMatchObject({ items: [{ _id: BK }], nextCursor: '123_abc' });
    await a.byKey(KEY);
    await a.abandon(KEY);
    await a.cancel(BK, { reason: 'Patient left', expectedVersion: 3 });
    await a.acceptReschedule(BK, 2);
    expect(calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      'GET /api/v1/pharmacy-assisted/lab-bookings?status=confirmed&limit=20',
      `GET /api/v1/pharmacy-assisted/lab-bookings/by-key/${KEY}`,
      `POST /api/v1/pharmacy-assisted/lab-bookings/by-key/${KEY}/abandon`,
      `POST /api/v1/pharmacy-assisted/lab-bookings/${BK}/cancel`,
      `POST /api/v1/pharmacy-assisted/lab-bookings/${BK}/accept-reschedule`,
    ]);
    expect(calls[3]!.body).toEqual({ reason: 'Patient left', expectedVersion: 3 });
    expect(calls[4]!.body).toEqual({ version: 2 });
  });
});

describe('lab booking rules and words', () => {
  it('cancel up to 1 hour before the time, or any time while a new time is unanswered; only confirmed bookings', () => {
    const now = new Date('2026-11-24T04:00:00.000Z');
    const b = (startsAt: string, o: Record<string, unknown> = {}) => ({ status: 'confirmed', slot: { startsAt }, reschedule: null, ...o });
    expect(canCancelLab(b('2026-11-24T05:00:00.000Z'), now)).toBe(true);
    expect(canCancelLab(b('2026-11-24T04:59:00.000Z'), now)).toBe(false);
    expect(canCancelLab(b('2026-11-24T04:30:00.000Z', { reschedule: { pending: true, version: 1 } }), now)).toBe(true);
    expect(canCancelLab(b('2026-11-25T05:00:00.000Z', { status: 'sample_collected' }), now)).toBe(false);
  });

  it('prices the chosen tests; branches by visit; status words', () => {
    expect(labTotalMinor([{ itemId: 'a', priceMinor: 30_000 }, { itemId: 'b', priceMinor: 12_000 }, { itemId: 'c', priceMinor: 1 }], ['a', 'b'])).toBe(42_000);
    const lab: AssistedLab = { partnerId: LAB, name: 'L', nearby: null, branches: [
      { branchId: '1', name: 'Home only', homeCollection: true, inLab: false }, { branchId: '2', name: 'Lab only', homeCollection: false, inLab: true }] };
    expect(branchesFor(lab, 'home').map((x) => x.name)).toEqual(['Home only']);
    expect(branchesFor(lab, 'lab').map((x) => x.name)).toEqual(['Lab only']);
    expect(labStatusLabel('report_ready')).toBe('Report released');
  });

  it('refusals: the shared wallet, price and switch words, and the lab codes', () => {
    const e = (status: number, code?: string, details?: Record<string, unknown>) => new ApiError(status, 'x', code, undefined, details ? { details } : undefined);
    expect(labRefusal(e(409, 'PRICE_CHANGED', { priceMinor: 45_000 }))).toMatchObject({ kind: 'price', priceMinor: 45_000 });
    expect(labRefusal(e(409, 'INSUFFICIENT_BALANCE')).kind).toBe('topup');
    expect(labRefusal(e(503, 'ASSISTED_BOOKING_DISABLED'))).toEqual({ kind: 'off', message: 'Booking lab tests for patients is not switched on yet.' });
    expect(labRefusal(e(503, 'INDEXES_OUTDATED')).message).toBe('The server needs an update before this can be used. Please ask the Jansetu team.');
    expect(labRefusal(e(409, 'SLOT_UNAVAILABLE'))).toEqual({ kind: 'slot', message: 'This time was just taken. Choose another time.' });
    expect(labRefusal(e(409, 'CANCELLATION_WINDOW_CLOSED')).message).toBe('Too late to cancel: lab bookings can be cancelled up to 1 hour before the time.');
    expect(labRefusal(e(409, 'RESCHEDULE_CHANGED')).message).toBe('The lab changed the time again. Look at the new time, then accept it or cancel.');
    // WQ17c (r14 phase 2b): card or UPI exists for lab tests too: the card switch off reads as for consultations.
    expect(labRefusal(e(400, 'PAYMENT_METHOD_UNAVAILABLE'))).toEqual({ kind: 'card', message: 'Card payment is not switched on yet. Pay from your Jansetu wallet.' });
  });
});
