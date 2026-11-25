import { describe, expect, it } from 'vitest';
import { ApiError, createApiClient } from './client.ts';
import {
  assistedBookerApi, isAssistedBooking, joinWords, LAB_CONSENT_STATEMENT, LAB_CONSENT_STATEMENT_VERSION, labAssistedApi, labBookerRefusal, pharmacyAssistedApi,
  type ConsultationRequest,
} from './assisted.ts';
import { beforeCheckout, CARD_BLOCKED_WORDS, cardCheckProblem, checkCardPayment, LAB_PAYER, outcomeOfError, settleCardPayment } from './assistedCard.ts';
import { ALL_PARTNER_PERMISSIONS, grantablePermissions, permissionsForKind } from './partners.ts';

// WQ24 (backend r21, round 2e, design §24.17): a lab member books a doctor consultation; the pharmacy's helpers, by booker.

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const BR = 'c1'.repeat(12);
const DOC = 'd1'.repeat(12);
const SLOT = '51'.repeat(12);
const BK = 'e1'.repeat(12);
const REC = 'c9'.repeat(12);
const KEY = 'k'.repeat(32);
const PROOF = { razorpayOrderId: 'order_1', razorpayPaymentId: 'pay_1', razorpaySignature: 'sig_1' };

type Call = { url: string; method: string; body: unknown };
function client(answer: (c: Call) => Response = () => json(200, { success: true, data: {} })) {
  const calls: Call[] = [];
  const c = createApiClient({ baseUrl: '', getToken: () => 'tok', timeoutMs: 100, fetchImpl: async (u, init) => {
    const call = { url: String(u), method: String(init?.method), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return answer(call);
  } });
  return { c, calls };
}
const request = (o: Partial<ConsultationRequest> = {}): ConsultationRequest => ({
  requestKey: KEY, phone: '9876543210', patient: { relation: 'self', name: 'Rina Kumari' },
  consent: { agreed: true, statementVersion: LAB_CONSENT_STATEMENT_VERSION, statementLanguage: 'en' }, preferredLanguage: 'hi', slotId: SLOT,
  consultationMode: 'video', acceptedPriceMinor: 50_000, paymentMethod: 'wallet', ...o,
});

describe('the lab booker routes (r21 `registerLabBookerRoutes`)', () => {
  it('uses /partner-workspace/assisted/* for every command, with the branch on the doctor reads and the create', async () => {
    const { c, calls } = client(() => json(200, { success: true, data: [], pagination: { total: 0, nextCursor: null } }));
    const lab = labAssistedApi(c);
    await lab.lookup('9876543210');
    await lab.doctors({ branchId: BR, mode: 'video', limit: 50 });
    await lab.doctorSlots(DOC, { branchId: BR, from: '2026-11-25', days: 7 });
    await lab.book(request({ branchId: BR }));
    await lab.bookings({ limit: 20 });
    await lab.booking(BK);
    await lab.byKey(KEY);
    await lab.abandon(KEY);
    await lab.cancel(BK, { refundTo: 'wallet' });
    await lab.reschedule(BK, { slotId: SLOT, requestKey: KEY });
    expect(calls.map((x) => `${x.method} ${x.url.replace(/^.*\/api\/v1/, '')}`)).toEqual([
      'POST /partner-workspace/assisted/patients/lookup',
      `GET /partner-workspace/assisted/doctors?branchId=${BR}&mode=video&limit=50`,
      `GET /partner-workspace/assisted/doctors/${DOC}/slots?branchId=${BR}&from=2026-11-25&days=7`,
      'POST /partner-workspace/assisted/consultations',
      'GET /partner-workspace/assisted/bookings?limit=20',
      `GET /partner-workspace/assisted/bookings/${BK}`,
      `GET /partner-workspace/assisted/bookings/by-key/${KEY}`,
      `POST /partner-workspace/assisted/bookings/by-key/${KEY}/abandon`,
      `POST /partner-workspace/assisted/bookings/${BK}/cancel`,
      `POST /partner-workspace/assisted/bookings/${BK}/reschedule`,
    ]);
    // The phone travels in the body only; the create carries the branch.
    expect(calls[0]!.body).toEqual({ phone: '9876543210' });
    expect(calls[3]!.body).toMatchObject({ branchId: BR, consent: { statementVersion: 'web-lab-consult-v1' } });
  });

  it('refuses a lab doctor read or create without a branch before sending', () => {
    const { c, calls } = client();
    const lab = labAssistedApi(c);
    expect(() => lab.doctors({ mode: 'video' })).toThrow('Invalid branch id');
    expect(() => lab.doctorSlots(DOC, { from: '2026-11-25' })).toThrow('Invalid branch id');
    expect(() => lab.book(request())).toThrow('Invalid branch id');
    expect(() => lab.book(request({ branchId: 'not-an-id' }))).toThrow('Invalid branch id');
    expect(calls).toHaveLength(0);
  });

  it('leaves the pharmacy routes and bodies as they were (no branch, its own list)', async () => {
    const { c, calls } = client(() => json(200, { success: true, data: [], pagination: { total: 0, nextCursor: null } }));
    const ph = pharmacyAssistedApi(c);
    await ph.doctors({ mode: 'video' });
    await ph.book(request());
    await ph.bookings({ limit: 50 });
    expect(calls.map((x) => x.url.replace(/^.*\/api\/v1/, ''))).toEqual(['/pharmacy-assisted/doctors?mode=video', '/pharmacy-assisted/consultations', '/pharmacy-bookings?limit=50']);
    expect(calls[1]!.body).not.toHaveProperty('branchId');
    expect(Object.keys(assistedBookerApi(c, 'pharmacy')).sort()).toEqual(Object.keys(labAssistedApi(c)).sort());
    expect(ph).toHaveProperty('orderFromPrescription');
    expect(labAssistedApi(c)).not.toHaveProperty('orderFromPrescription');
  });
});

describe('the lab’s words', () => {
  it('names the lab in the consent, the join and a lab row', () => {
    expect(LAB_CONSENT_STATEMENT).toMatch(/^The patient .* this lab books this consultation .* this lab can see the prescription .* for 90 days\.$/);
    expect(LAB_CONSENT_STATEMENT_VERSION.length).toBeLessThanOrEqual(40);
    expect(joinWords('call', 'partner_device', 'lab')).toBe('The doctor phones this lab’s number at the booked time. Keep the patient with you.');
    expect(joinWords('call', 'partner_device')).toBe('The doctor phones this pharmacy’s number at the booked time. Keep the patient with you.');
    expect(isAssistedBooking({ _id: BK, status: 'confirmed', source: 'lab_assisted' })).toBe(true);
  });

  it('says the lab refusals in words, and the shared ones as for a pharmacy', () => {
    const e = (status: number, code: string) => new ApiError(status, 'refused', code);
    expect(labBookerRefusal(e(403, 'INSUFFICIENT_PERMISSIONS')).message).toBe('Your account cannot book consultations for patients. Ask your lab’s owner.');
    expect(labBookerRefusal(e(403, 'BRANCH_SCOPE_EXCEEDED')).message).toBe('This branch is not one of yours. Choose one of your branches.');
    expect(labBookerRefusal(e(404, 'BRANCH_NOT_AVAILABLE')).message).toBe('This branch is not available now. Choose another branch.');
    expect(labBookerRefusal(e(403, 'PARTNER_NOT_VERIFIED')).message).toBe('Your lab is not verified yet, so it cannot book for patients.');
    expect(labBookerRefusal(e(403, 'LAB_PARTNER_REQUIRED')).message).toBe('Only labs can book consultations for patients.');
    expect(labBookerRefusal(e(409, 'INSUFFICIENT_BALANCE'))).toMatchObject({ kind: 'topup' });
    expect(labBookerRefusal(new ApiError(409, 'Price changed', 'PRICE_CHANGED', undefined, { details: { priceMinor: 45_000 } }))).toMatchObject({ kind: 'price', priceMinor: 45_000 });
    expect(labBookerRefusal(e(503, 'ASSISTED_BOOKING_DISABLED'))).toMatchObject({ kind: 'off' });
  });
});

describe('a lab settles a card payment on its own routes (r21: 2d’s verify and reconcile)', () => {
  it('verifies, then reconciles, at /partner-workspace/assisted/payments/*', async () => {
    const { c, calls } = client((x) => (x.url.endsWith('/verify')
      ? json(502, { error: 502, message: 'Bad gateway' })
      : json(200, { success: true, data: { state: 'paid', context: 'assisted_booking', paymentRecord: { status: 'paid' }, entity: { _id: BK } } })));
    await expect(settleCardPayment(c, REC, PROOF, LAB_PAYER)).resolves.toEqual({ kind: 'paid', booking: { _id: BK } });
    expect(calls.map((x) => x.url.replace(/^.*\/api\/v1/, ''))).toEqual(['/partner-workspace/assisted/payments/verify', '/partner-workspace/assisted/payments/reconcile']);
    expect(calls[0]!.body).toEqual({ paymentTransactionId: REC, ...PROOF });
    expect(calls[0]!.body).not.toHaveProperty('module');
  });

  it('asks the lab route before Checkout opens again, and checks there', async () => {
    const { c, calls } = client(() => json(200, { success: true, data: { state: 'unpaid', gatewayStatuses: ['authorized'] } }));
    await expect(beforeCheckout(c, REC, LAB_PAYER)).resolves.toEqual({ kind: 'settled', outcome: { kind: 'unpaid', inFlight: true } });
    await expect(checkCardPayment(c, REC, LAB_PAYER)).resolves.toEqual({ kind: 'unpaid', inFlight: true });
    expect(calls.every((x) => x.url.endsWith('/partner-workspace/assisted/payments/reconcile'))).toBe(true);
  });

  it('names the lab when the payment cannot be checked; the pharmacy’s words are unchanged', async () => {
    const e = (status: number, code: string) => new ApiError(status, 'refused', code);
    expect(outcomeOfError(e(403, 'INSUFFICIENT_PERMISSIONS'), 'lab')).toMatchObject({ kind: 'blocked', message: expect.stringMatching(/^Your lab account is not active or not verified/) });
    expect(outcomeOfError(e(403, 'PHARMACY_INACTIVE'))).toEqual({ kind: 'blocked', message: CARD_BLOCKED_WORDS });
    expect(CARD_BLOCKED_WORDS).toMatch(/^Your pharmacy account is not active or not verified/);
    expect(cardCheckProblem(e(404, 'PAYMENT_RECORD_NOT_FOUND'), 'lab')).toBe('This payment was not found for your lab.');
    expect(cardCheckProblem(e(404, 'PAYMENT_RECORD_NOT_FOUND'))).toBe('This payment was not found for your pharmacy.');
    const { c, calls } = client(() => json(403, { error: 403, code: 'INSUFFICIENT_PERMISSIONS', message: 'Missing permissions: assisted.book' }));
    await expect(checkCardPayment(c, REC, LAB_PAYER)).resolves.toMatchObject({ kind: 'blocked', message: expect.stringMatching(/^Your lab account/) });
    expect(calls[0]!.url).toMatch(/\/partner-workspace\/assisted\/payments\/reconcile$/);
  });
});

describe('the assisted.book permission (r21 `ALL_PERMISSIONS`)', () => {
  it('is known, offered to labs only, and grantable by an owner', () => {
    expect(ALL_PARTNER_PERMISSIONS).toContain('assisted.book');
    expect(ALL_PARTNER_PERMISSIONS[ALL_PARTNER_PERMISSIONS.length - 1]).toBe('assisted.book');
    expect(permissionsForKind('lab')).toContain('assisted.book');
    expect(permissionsForKind('clinic')).not.toContain('assisted.book');
    expect(permissionsForKind(undefined)).not.toContain('assisted.book');
    expect(grantablePermissions({ role: 'owner', permissions: [] }, 'lab')).toContain('assisted.book');
    expect(grantablePermissions({ role: 'staff', permissions: ['staff.manage'] }, 'lab')).not.toContain('assisted.book');
  });
});
