import { ApiError, createApiClient } from './client.ts';
import { canBillDesk, canDeskCancel, deskItems, deskRefusal, deskTotalMinor, isDeskBooking, labDeskApi, LAB_DESK_SWITCHED_OFF_MESSAGE, type DeskBookingRequest } from './labDesk.ts';
import { labActions, partnerLabsApi, type LabBooking } from './partnerLabs.ts';
import { partnerBillingApi, type CatalogueItem } from './partnerInvoices.ts';
import { ADMIN_ACTOR } from './partners.ts';

const LAB = 'a1'.repeat(12);
const BR = 'b1'.repeat(12);
const BK = 'c1'.repeat(12);
const SL = 'd1'.repeat(12);
const T1 = 'e1'.repeat(12);
const T2 = 'e2'.repeat(12);
const KEY = 'k'.repeat(32);

function recorder() {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const client = createApiClient({ baseUrl: 'https://api.example.test', getToken: () => 'tok',
    fetchImpl: async (u, init) => {
      calls.push({ method: String(init?.method), url: String(u).replace('https://api.example.test/api/v1', ''), body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      return new Response(JSON.stringify({ success: true, data: {}, pagination: { page: 1, limit: 20, total: 0, totalPages: 1, nextCursor: null } }), { status: 200 });
    } });
  return { client, calls };
}

const request = (o: Partial<DeskBookingRequest> = {}): DeskBookingRequest => ({
  requestKey: KEY, phone: '9876543210', patient: { relation: 'self', name: 'Ravi Kumar' },
  consent: { agreed: true, statementVersion: 'web-lab-desk-v1', statementLanguage: 'en' }, preferredLanguage: 'hi', branchId: BR, visitMode: 'lab',
  itemIds: [T1], acceptedTotalMinor: 50000, ...o,
});
const item = (id: string, o: Partial<CatalogueItem> = {}): CatalogueItem => ({
  _id: id, partnerId: LAB, kind: 'test', name: 'CBC', priceMinor: 30000, gstRate: 0, visitModes: ['lab', 'home'], isActive: true, adminDisabled: false, ...o,
} as CatalogueItem);
const booking = (o: Partial<LabBooking> = {}): LabBooking => ({
  _id: BK, partnerId: LAB, branchId: BR, userId: 'u'.repeat(24), patient: { kind: 'self', name: 'Ravi' }, visitMode: 'lab',
  slot: { slotId: SL, date: '2026-11-26', startTime: '10:00', endTime: '10:30', startsAt: '2026-11-26T04:30:00.000Z' }, items: [],
  pricing: { subtotalMinor: 0, discountMinor: 0, payableMinor: 0, commissionMinor: 0, currency: 'INR' }, status: 'confirmed', statusVersion: 0,
  paymentStatus: 'pending', paymentDeadline: '', reschedule: { version: 0, pending: false }, report: { draftFiles: [], releasedFiles: [], releases: [] },
  lifecycle: {}, source: 'lab_desk', payAtLab: true, bill: null, ...o,
} as LabBooking);

describe('WQ19 lab front desk (r12 /lab-desk routes)', () => {
  it('members use /partner-workspace/lab-desk, admins the /admin/:partnerId/workspace mirror; the phone only in a body', async () => {
    const { client, calls } = recorder();
    const member = labDeskApi(client, { kind: 'member' });
    const admin = labDeskApi(client, { kind: 'admin', partnerId: LAB });
    await member.lookup('9876543210');
    await member.book(request());
    await member.byKey(KEY);
    await member.abandon(KEY);
    await member.cancel(BK, { reason: 'Patient left', expectedVersion: 2 });
    await admin.book(request({ visitMode: 'home', slotId: SL, address: { line1: '12 MG Road', city: 'Pune', pincode: '411001' }, collector: { name: 'Anil' } }));
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /partner-workspace/lab-desk/patients/lookup',
      'POST /partner-workspace/lab-desk/bookings',
      `GET /partner-workspace/lab-desk/bookings/by-key/${KEY}`,
      `POST /partner-workspace/lab-desk/bookings/by-key/${KEY}/abandon`,
      `POST /partner-workspace/lab-desk/bookings/${BK}/cancel`,
      `POST /partner-workspace/admin/${LAB}/workspace/lab-desk/bookings`,
    ]);
    expect(calls[0]!.body).toEqual({ phone: '9876543210' });
    expect(calls[4]!.body).toEqual({ reason: 'Patient left', expectedVersion: 2 });
    // A walk-in sends no slot; nothing in the body is a note.
    expect(calls[1]!.body).not.toHaveProperty('slotId');
    expect(calls[1]!.body).not.toHaveProperty('notes');
    expect(calls.every((c) => !c.url.includes('9876543210'))).toBe(true);
  });

  it('refuses before any request: a home collection without a time, an address or collector on a lab visit, 0 or 21 tests, a bad key', () => {
    const { client, calls } = recorder();
    const desk = labDeskApi(client, { kind: 'member' });
    expect(() => desk.book(request({ visitMode: 'home' }))).toThrow('A home collection needs a time');
    expect(() => desk.book(request({ collector: { name: 'Anil' } }))).toThrow('for home collections only');
    expect(() => desk.book(request({ itemIds: [] }))).toThrow('Choose 1 to 20 tests');
    expect(() => desk.book(request({ itemIds: Array.from({ length: 21 }, () => T1) }))).toThrow('Choose 1 to 20 tests');
    expect(() => desk.book(request({ requestKey: 'x' }))).toThrow('Invalid request key');
    expect(() => desk.byKey('../x')).toThrow('Invalid request key');
    expect(calls).toHaveLength(0);
  });

  it('the tests a visit can book (active, offered for it, tests and packages) and their total', () => {
    const items = [item(T1), item(T2, { kind: 'package', priceMinor: 20000, visitModes: ['lab'] }), item('e3'.repeat(12), { isActive: false }),
      item('e4'.repeat(12), { adminDisabled: true }), item('e5'.repeat(12), { kind: 'consultation' })];
    expect(deskItems(items, 'lab').map((i) => i._id)).toEqual([T1, T2]);
    expect(deskItems(items, 'home').map((i) => i._id)).toEqual([T1]);
    expect(deskTotalMinor(items, [T1, T2])).toBe(50000);
  });

  it('refusals in words: switched off, a changed price with the new total, a home collection without a time', () => {
    expect(deskRefusal(new ApiError(503, 'x', 'ASSISTED_BOOKING_DISABLED'))).toEqual({ kind: 'off', message: LAB_DESK_SWITCHED_OFF_MESSAGE });
    const price = deskRefusal(Object.assign(new ApiError(409, 'x', 'PRICE_CHANGED'), { details: { priceMinor: 65000, listMinor: 65000, discountMinor: 0 } }));
    expect(price.kind).toBe('price');
    expect(price.priceMinor).toBe(65000);
    expect(price.message).toContain('₹650');
    expect(deskRefusal(new ApiError(400, 'x', 'SLOT_REQUIRED')).kind).toBe('slot');
    expect(deskRefusal(new ApiError(404, 'x', 'BRANCH_NOT_AVAILABLE')).kind).toBe('doctor');
  });

  it('desk rows: cancelled by the desk while confirmed; billed once while not cancelled and without an open bill', () => {
    expect(isDeskBooking(booking())).toBe(true);
    expect(isDeskBooking(booking({ source: 'self', payAtLab: undefined }))).toBe(false);
    expect(canDeskCancel(booking())).toBe(true);
    expect(canDeskCancel(booking({ status: 'sample_collected' }))).toBe(false);
    expect(canBillDesk(booking())).toBe(true);
    expect(canBillDesk(booking({ bill: { invoiceId: 'i'.repeat(24), serial: 'LAB/2627/0001', number: 1, state: 'issued' } }))).toBe(false);
    expect(canBillDesk(booking({ bill: { invoiceId: 'i'.repeat(24), serial: 'LAB/2627/0001', number: 1, state: 'cancelled' } }))).toBe(true);
    expect(canBillDesk(booking({ status: 'cancelled' }))).toBe(false);
  });

  it('steps on desk rows (paid at the lab): a walk-in is visited, never a no-show or moved; a desk row is never rejected for a refund', () => {
    const now = new Date('2026-11-26T06:00:00.000Z');
    const walkIn = booking({ slot: { date: '2026-11-26', startTime: '11:00', startsAt: '2026-11-26T05:30:00.000Z', walkIn: true } as LabBooking['slot'] });
    expect(labActions(walkIn, ADMIN_ACTOR, now).map((a) => a.action)).toEqual(['visit']);
    expect(labActions(booking(), ADMIN_ACTOR, now).map((a) => a.action)).toEqual(['visit', 'no_show', 'reschedule']);
    // An online booking not yet paid still offers nothing; paid, it is rejected for a refund as before.
    expect(labActions(booking({ source: 'self', payAtLab: undefined }), ADMIN_ACTOR, now)).toEqual([]);
    expect(labActions(booking({ source: 'self', payAtLab: undefined, paymentStatus: 'paid' }), ADMIN_ACTOR, now).map((a) => a.action)).toContain('reject');
  });

  it('the lab list filters by source; a bill names the lab booking it is for (never with an appointment)', async () => {
    const { client, calls } = recorder();
    await partnerLabsApi(client, { kind: 'member' }).bookings({ source: 'lab_desk', limit: 10 });
    const billing = partnerBillingApi(client, { kind: 'member' });
    const bill = { branchId: BR, customer: { name: 'Ravi', phone: '9876543210' }, items: [], idempotencyKey: KEY };
    await billing.createInvoice({ ...bill, labBookingId: BK });
    expect(() => billing.createInvoice({ ...bill, labBookingId: BK, appointmentId: BK })).toThrow('one appointment or one lab booking');
    expect(() => billing.createInvoice({ ...bill, labBookingId: 'nope' })).toThrow('Invalid lab booking id');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /partner-workspace/lab-bookings?limit=10&source=lab_desk', 'POST /partner-workspace/invoices']);
    expect(calls[1]!.body).toMatchObject({ labBookingId: BK });
  });
});
