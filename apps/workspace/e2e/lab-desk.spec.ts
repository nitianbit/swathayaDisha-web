import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * WQ19: the lab front desk (r12 `/lab-desk/*`, design §24.12) against a mocked backend: walk-in, lab visit, home collection
 * with a collector, an unconfirmed booking checked by key after a reload, Make bill, the desk cancel, the switch, and a
 * booking at another branch (not found). Desk rows are paid at the lab: `payAtLab`, `bill`, `paymentStatus: 'pending'`.
 */
const LAB = 'a1'.repeat(12);
const OWNER = 'b1'.repeat(12);
const STAFF = 'b2'.repeat(12);
const BR1 = 'c1'.repeat(12);
const BR2 = 'c2'.repeat(12);
const T1 = 'd1'.repeat(12);
const T2 = 'd2'.repeat(12);
const T3 = 'd3'.repeat(12);
const T4 = 'd4'.repeat(12);
const S1 = 'f1'.repeat(12);
const S2 = 'f2'.repeat(12);
const SH = 'f3'.repeat(12);
const FAR = 'e9'.repeat(12);
const PHONE = '9876543210';
const NEW_PHONE = '9123456780';
const ALL = ['staff.manage', 'branches.manage', 'catalogue.manage', 'slots.manage', 'bookings.view', 'bookings.manage', 'reports.upload',
  'reports.release', 'invoices.create', 'invoices.cancel', 'payments.record', 'finance.view'];
/** Wednesday 25 Nov 2026, 10:00 in India. */
const NOW = new Date('2026-11-25T04:30:00.000Z');

type Rec = Record<string, unknown>;
interface Me { _id: string; partnerId: string; name: string; role: 'owner' | 'staff'; permissions: string[]; branchIds: string[] }
interface Backend {
  calls: { method: string; path: string; body: unknown }[];
  me: Me;
  live: boolean;
  catalogue: Rec[];
  bookings: Rec[];
  bills: Rec[];
  keys: Record<string, { bookingId?: string; hash?: string; abandoned?: boolean }>;
  /** The desk switch (LAB_DESK_ENABLED) is off. */
  off?: boolean;
  /** The next create is made, then its answer is lost. */
  loseAfter?: boolean;
  /** WQ19b: the next desk cancel is lost before it reaches the server (the booking stays confirmed). */
  loseCancelBefore?: boolean;
  /** The lab changes this test's price just before the next create is decided. */
  bumpPrice?: { itemId: string; priceMinor: number };
}

const item = (id: string, name: string, priceMinor: number, o: Rec = {}): Rec => ({ _id: id, partnerId: LAB, kind: 'test', name, priceMinor, gstRate: 0,
  visitModes: ['lab', 'home'], isActive: true, adminDisabled: false, ...o });
const slot = (id: string, branchId: string, visitMode: string, date: string, start: string, end: string): Rec => ({
  _id: id, partnerId: LAB, branchId, visitMode, date, startTime: start, endTime: end, startsAt: new Date(Date.parse(`${date}T${start}:00+05:30`)).toISOString(),
  endsAt: new Date(Date.parse(`${date}T${end}:00+05:30`)).toISOString(), capacity: 2, booked: 0, closed: null, source: 'template',
});
const owner: Me = { _id: OWNER, partnerId: LAB, name: 'Ravi Owner', role: 'owner', permissions: ALL, branchIds: [] };
const staff = (...permissions: string[]): Me => ({ _id: STAFF, partnerId: LAB, name: 'Sita Staff', role: 'staff', permissions, branchIds: [BR1] });

function deskRow(id: string, o: Rec): Rec {
  return { _id: id, partnerId: LAB, branchId: BR1, userId: 'u1'.repeat(12), patient: { kind: 'self', name: 'Meena Iyer' }, visitMode: 'lab',
    slot: { slotId: S2, date: '2026-11-26', startTime: '09:00', endTime: '09:30', startsAt: '2026-11-26T03:30:00.000Z' },
    items: [{ catalogItemId: T1, kind: 'test', name: 'CBC', priceMinor: 30000, gstRate: 0 }],
    pricing: { subtotalMinor: 30000, discountMinor: 0, payableMinor: 30000, commissionMinor: 0, currency: 'INR' },
    status: 'confirmed', statusVersion: 0, paymentStatus: 'pending', reschedule: { version: 0, pending: false },
    report: { draftFiles: [], releasedFiles: [], releases: [] }, lifecycle: { confirmedAt: '2026-11-24T05:00:00.000Z' },
    source: 'lab_desk', payAtLab: true, desk: { memberId: OWNER, branchId: BR1, arrivedAt: null, preferredLanguage: 'hi', payAtLab: true }, bill: null,
    createdAt: '2026-11-24T05:00:00.000Z', ...o };
}

async function mockBackend(page: Page, me: Me = owner): Promise<Backend> {
  await page.clock.setFixedTime(NOW);
  const b: Backend = {
    calls: [], me, live: false, bills: [], keys: {},
    catalogue: [item(T1, 'CBC', 30000), item(T2, 'Lipid profile', 45000, { visitModes: ['lab'] }), item(T3, 'Thyroid package', 70000, { kind: 'package' }),
      item(T4, 'Old test', 10000, { isActive: false })],
    bookings: [deskRow('e1'.repeat(12), {}), deskRow(FAR, { branchId: BR2, patient: { kind: 'self', name: 'Far Away' } })],
  };
  const slots = [slot(S1, BR1, 'lab', '2026-11-25', '11:00', '11:30'), slot(S2, BR1, 'lab', '2026-11-26', '09:00', '09:30'),
    slot(SH, BR1, 'home', '2026-11-25', '12:00', '13:00')];
  const partner = { _id: LAB, kind: 'lab', name: 'City Lab', contact: { phone: '9000000000' }, verification: { state: 'verified' }, taxRegime: 'unregistered',
    invoiceSeries: { prefix: 'LB' }, activeOwnerCount: 1, isActive: true };
  const branches = [
    { _id: BR1, partnerId: LAB, name: 'Indiranagar', address: { line1: '1 Main Rd', city: 'Bengaluru', state: 'Karnataka', stateCode: '29', pincode: '560038' },
      services: { homeCollection: true, inLab: true }, isActive: true },
    { _id: BR2, partnerId: LAB, name: 'Koramangala', address: { line1: '2 Ring Rd', city: 'Bengaluru', state: 'Karnataka', stateCode: '29', pincode: '560034' },
      services: { homeCollection: false, inLab: true }, isActive: true },
  ];
  let seq = 0;
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const ok = (route: Route, data: unknown, status = 200) => json(route, status, { success: true, data });
  const fail = (route: Route, status: number, code: string, message: string, extra: Rec = {}) => json(route, status, { error: status, code, message, ...extra });
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = req.method();
    const body = ['POST', 'PUT'].includes(method) ? (req.postDataJSON() as Rec | null) : null;
    if (path === '/auth/session/refresh') {
      if (!b.live) return fail(route, 401, 'SESSION_ENDED', 'Please sign in again');
      return ok(route, { token: 't1', expiresIn: 900, principal: { userId: b.me._id, userType: 'partner', sid: 's1' } });
    }
    if (path.startsWith('/auth/session')) return ok(route, {});
    b.calls.push({ method, path: `${path}${url.search}`, body });
    if (path === '/auth/partner/send') return ok(route, undefined);
    if (path === '/auth/partner/verify') { b.live = true; return ok(route, { token: 't1', expiresIn: 900, user: {} }); }
    if (req.headers().authorization !== 'Bearer t1') return fail(route, 401, 'UNAUTHORIZED', 'Authentication is required');
    if (path === '/auth/profile') return ok(route, { user: { ...b.me, phone: '9000000001', isActive: true }, partner, userRole: 'partner' });
    const ws = /^\/partner-workspace(\/.*)$/.exec(path);
    if (!ws) return fail(route, 404, 'NOT_FOUND', 'Not found');
    const sub = ws[1]!;
    const inScope = (branchId: unknown) => b.me.role === 'owner' || b.me.branchIds.includes(String(branchId));
    if (sub === '/me') return ok(route, partner);
    if (sub === '/branches') return ok(route, branches);
    if (sub === '/members') return ok(route, []);
    if (sub === '/catalogue' && method === 'GET') return ok(route, b.catalogue.filter((i) => i.isActive));
    if (sub === '/slots' && method === 'GET') {
      const q = url.searchParams;
      return ok(route, slots.filter((s) => s.branchId === q.get('branchId') && s.visitMode === q.get('visitMode') && String(s.date) >= q.get('from')! && String(s.date) <= q.get('to')!));
    }

    // ── WQ21b: r16b recommended tests at the desk (code and number in the body) ──
    if (sub === '/lab-desk/recommendations/lookup' && method === 'POST') {
      if (body?.code !== 'ABCDEFGH' || body?.phone !== PHONE) return fail(route, 404, 'RECOMMENDATION_NOT_FOUND', 'Not found');
      return ok(route, { code: 'ABCDEFGH', status: 'open', items: [{ index: 0, name: 'cbc' }, { index: 1, name: 'Lipid  Profile' }, { index: 2, name: 'Vitamin D' }] });
    }

    // ── r12 lab desk ──
    if (sub === '/lab-desk/patients/lookup' && method === 'POST') {
      if (b.off) return fail(route, 503, 'ASSISTED_BOOKING_DISABLED', 'Booking for patients is not switched on');
      return ok(route, body?.phone === PHONE ? { exists: true, holderNameMasked: 'R*** K***' } : { exists: false, holderNameMasked: null });
    }
    if (sub === '/lab-desk/bookings' && method === 'POST') {
      if (b.off) return fail(route, 503, 'ASSISTED_BOOKING_DISABLED', 'Booking for patients is not switched on');
      const x = body as { requestKey: string; visitMode: string; slotId?: string; itemIds: string[]; branchId: string; acceptedTotalMinor: number; address?: Rec; collector?: Rec; patient: Rec };
      const hash = JSON.stringify({ ...x, requestKey: undefined });
      const prior = b.keys[x.requestKey];
      if (prior?.abandoned) return fail(route, 409, 'REQUEST_ABANDONED', 'This request was cancelled before it was recorded; make a new one');
      if (prior?.bookingId) {
        if (prior.hash !== hash) return fail(route, 409, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different booking');
        return ok(route, { booking: b.bookings.find((y) => y._id === prior.bookingId), patient: { name: 'x' }, newAccount: false, replayed: true });
      }
      if (x.visitMode === 'home' && !x.slotId) return fail(route, 400, 'SLOT_REQUIRED', 'A home collection needs a home-collection slot');
      if (b.bumpPrice) { const it = b.catalogue.find((i) => i._id === b.bumpPrice!.itemId)!; it.priceMinor = b.bumpPrice.priceMinor; b.bumpPrice = undefined; }
      const chosen = b.catalogue.filter((i) => x.itemIds.includes(i._id as string));
      const total = chosen.reduce((n, i) => n + (i.priceMinor as number), 0);
      if (total !== x.acceptedTotalMinor) {
        return fail(route, 409, 'PRICE_CHANGED', 'The price changed; check it with the patient and book again', { details: { priceMinor: total, listMinor: total, discountMinor: 0 } });
      }
      const seat = x.slotId ? slots.find((s) => s._id === x.slotId)! : null;
      const id = `ab${String(++seq).padStart(22, '0')}`;
      const p = x.patient as { name?: string };
      const row = deskRow(id, {
        branchId: x.branchId, visitMode: x.visitMode, patient: { kind: 'self', name: p.name ?? 'Patient' },
        slot: seat ? { slotId: seat._id, date: seat.date, startTime: seat.startTime, endTime: seat.endTime, startsAt: seat.startsAt }
          : { walkIn: true, date: '2026-11-25', startTime: '10:00', startsAt: NOW.toISOString() },
        items: chosen.map((i) => ({ catalogItemId: i._id, kind: i.kind, name: i.name, priceMinor: i.priceMinor, gstRate: 0 })),
        pricing: { subtotalMinor: total, discountMinor: 0, payableMinor: total, commissionMinor: 0, currency: 'INR' },
        ...(x.address ? { address: x.address } : {}), ...(x.collector ? { collector: x.collector } : {}), createdAt: NOW.toISOString(),
      });
      b.bookings.push(row);
      b.keys[x.requestKey] = { bookingId: id, hash };
      if (b.loseAfter) { b.loseAfter = false; return route.abort('failed'); }
      return ok(route, { booking: row, patient: { name: p.name ?? 'Patient' }, newAccount: x.patient && body?.phone === NEW_PHONE, replayed: false }, 201);
    }
    const byKey = /^\/lab-desk\/bookings\/by-key\/([A-Za-z0-9_-]{8,100})(\/abandon)?$/.exec(sub);
    if (byKey) {
      const k = b.keys[byKey[1]!];
      if (byKey[2] && !k?.bookingId) { b.keys[byKey[1]!] = { abandoned: true }; return ok(route, { state: 'abandoned' }); }
      if (k?.bookingId) { const bk = b.bookings.find((y) => y._id === k.bookingId)!; return ok(route, { state: 'used', booking: inScope(bk.branchId) ? bk : null }); }
      return ok(route, { state: k?.abandoned ? 'abandoned' : 'unknown' });
    }
    const cancel = /^\/lab-desk\/bookings\/([0-9a-f]{24})\/cancel$/.exec(sub);
    if (cancel && method === 'POST') {
      if (b.loseCancelBefore) { b.loseCancelBefore = false; return route.abort('failed'); }
      const bk = b.bookings.find((y) => y._id === cancel[1]);
      if (!bk || bk.source !== 'lab_desk' || !inScope(bk.branchId)) return fail(route, 404, 'LAB_BOOKING_NOT_FOUND', 'Booking not found');
      if (bk.status === 'cancelled') return ok(route, { booking: bk, alreadyCancelled: true });
      const v = (body as { expectedVersion?: number }).expectedVersion;
      if (v !== undefined && v !== bk.statusVersion) return fail(route, 409, 'LAB_BOOKING_CHANGED', 'Booking changed');
      Object.assign(bk, { status: 'cancelled', statusVersion: (bk.statusVersion as number) + 1,
        cancellation: { reason: 'desk', note: (body as Rec).reason ?? 'Cancelled at the lab desk', by: b.me._id, byKind: 'member', at: NOW.toISOString() } });
      return ok(route, { booking: bk, alreadyCancelled: false });
    }

    // ── existing lab bookings (r12 view: source, payAtLab, desk, bill) ──
    if (sub === '/lab-bookings' && method === 'GET') {
      const src = url.searchParams.get('source');
      const rows = b.bookings.filter((y) => inScope(y.branchId) && (!src || y.source === src));
      return json(route, 200, { success: true, data: rows, pagination: { total: rows.length, nextCursor: null } });
    }
    const one = /^\/lab-bookings\/([0-9a-f]{24})$/.exec(sub);
    if (one && method === 'GET') {
      const bk = b.bookings.find((y) => y._id === one[1]);
      return bk && inScope(bk.branchId) ? ok(route, bk) : fail(route, 404, 'LAB_BOOKING_NOT_FOUND', 'Booking not found');
    }

    // ── bills (just enough for a bill made from a desk booking) ──
    if (sub === '/invoices' && method === 'POST') {
      const x = body as { branchId: string; labBookingId?: string; customer: Rec; items: Rec[]; idempotencyKey: string };
      const bk = x.labBookingId ? b.bookings.find((y) => y._id === x.labBookingId) : undefined;
      if (x.labBookingId && !bk) return fail(route, 404, 'LAB_BOOKING_NOT_FOUND', 'Booking not found');
      if (bk && x.customer.phone !== PHONE && x.customer.phone !== NEW_PHONE) return fail(route, 409, 'LAB_BOOKING_CUSTOMER_MISMATCH', 'Bill the lab booking to its patient\'s account');
      const total = x.items.reduce((n, l) => n + (l.unitPriceMinor as number) * (l.qty as number), 0);
      const inv = { _id: `bb${String(b.bills.length + 1).padStart(22, '0')}`, partnerId: LAB, branchId: x.branchId, number: b.bills.length + 1, financialYear: '2627',
        serial: `LB/2627/000${b.bills.length + 1}`, documentKind: 'bill_of_supply', issuedAt: NOW.toISOString(), supplier: { name: 'City Lab', address: '1 Main Rd', placeOfSupply: '29' },
        customer: x.customer, ...(x.labBookingId ? { labBookingId: x.labBookingId } : {}),
        items: x.items.map((l) => ({ ...l, discountMinor: 0, amountMinor: (l.unitPriceMinor as number) * (l.qty as number) })),
        totals: { subtotalMinor: total, discountMinor: 0, taxableMinor: total, cgstMinor: 0, sgstMinor: 0, igstMinor: 0, totalMinor: total, currency: 'INR' },
        lifecycleState: 'issued', lifecycleVersion: 0, paidMinor: 0, dueMinor: total, createdBy: b.me._id, idempotencyKey: x.idempotencyKey };
      b.bills.push(inv);
      if (bk) bk.bill = { invoiceId: inv._id, serial: inv.serial, number: inv.number, state: 'issued' };
      return ok(route, inv, 201);
    }
    const bill = /^\/invoices\/([0-9a-f]{24})$/.exec(sub);
    if (bill) {
      const inv = b.bills.find((y) => y._id === bill[1]);
      return inv ? ok(route, { invoice: inv, events: [] }) : fail(route, 404, 'INVOICE_NOT_FOUND', 'Invoice not found');
    }
    return fail(route, 404, 'NOT_FOUND', 'Not found');
  });
  return b;
}

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Lab or clinic staff').check();
  await page.getByLabel('Mobile number').fill('9000000001');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' });
const creates = (b: Backend) => b.calls.filter((c) => c.method === 'POST' && c.path === '/partner-workspace/lab-desk/bookings');
const stored = (page: Page) => page.evaluate(() => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }) + location.href);

/** The patient step: the number, the owner as the patient (by name), the agreement. */
async function patient(page: Page, phone = PHONE, name = 'Ravi Kumar') {
  await page.getByLabel('Patient’s mobile number').fill(phone);
  await page.getByRole('button', { name: 'Find' }).click();
  if (phone !== PHONE) await page.getByLabel('Type the number again').fill(phone);
  await page.getByRole('radio', { name: /^The phone’s owner/ }).check();
  await page.getByLabel('Patient’s full name').fill(name);
  await page.getByLabel('Patient agreed to this booking').check();
  await page.getByRole('button', { name: 'Next: choose the tests' }).click();
}

test('walk-in now: the patient, the tests and the total; booked with no time, then opened in Lab bookings with only "Mark visited"', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await nav(page).getByRole('link', { name: 'Front desk' }).click();
  await expect(page.getByRole('heading', { name: 'Front desk', level: 1 })).toBeVisible();
  await page.getByLabel('Patient’s mobile number').fill(PHONE);
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(page.getByText('Account holder: R*** K***', { exact: false })).toBeVisible();
  // WQ54c/WQ54d: one plain line naming what it allows; the full statement behind Read more.
  await expect(page.getByText('The patient agrees: Jansetu keeps their details (an account for this number) and the report goes to their Jansetu app.')).toBeVisible();
  await page.getByText('Read more').click();
  await expect(page.getByText('this lab books these tests for them on Jansetu', { exact: false })).toBeVisible();
  await page.getByRole('radio', { name: /^The phone’s owner/ }).check();
  await page.getByLabel('Patient’s full name').fill('Ravi Kumar');
  await page.getByLabel('Patient agreed to this booking').check();
  await page.getByRole('button', { name: 'Next: choose the tests' }).click();

  const form = page.getByRole('form', { name: 'Tests and time' });
  await expect(form.getByLabel('Walk-in now')).toBeChecked();
  // Inactive tests are not offered; two branches offer lab visits, so one is chosen.
  await expect(form.getByText('Old test')).toHaveCount(0);
  await form.getByRole('button', { name: 'Book' }).click();
  await expect(form.getByText('Choose a branch.')).toBeVisible();
  await expect(form.getByText('Choose at least one test.')).toBeVisible();
  await form.getByLabel('Branch').selectOption({ label: 'Indiranagar' });
  await form.getByLabel(/^CBC/).check();
  await form.getByLabel(/^Lipid profile/).check();
  await expect(form.getByText('Total: ₹750.00, paid at the lab')).toBeVisible();
  await form.getByLabel('Language the patient speaks').selectOption('hi');
  await form.getByRole('button', { name: 'Book' }).click();
  const check = page.getByRole('group', { name: 'Check the total' });
  await expect(check).toContainText('Walk-in now: now, Indiranagar');
  await check.getByRole('button', { name: 'Yes, book for ₹750.00' }).click();
  await expect(page.getByRole('heading', { name: 'Booked' })).toBeVisible();
  await expect(page.getByText('The tests are booked. The patient pays at the lab.')).toBeVisible();

  const sent = creates(backend);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.body).toMatchObject({ phone: PHONE, patient: { relation: 'self', name: 'Ravi Kumar' }, branchId: BR1, visitMode: 'lab', itemIds: [T1, T2],
    acceptedTotalMinor: 75000, preferredLanguage: 'hi', consent: { agreed: true, statementVersion: 'web-lab-desk-v1', statementLanguage: 'en' } });
  expect(sent[0]!.body).not.toHaveProperty('slotId');
  expect(sent[0]!.body).not.toHaveProperty('notes');
  expect(await stored(page)).not.toMatch(new RegExp(`${PHONE}|Ravi`));

  await page.getByRole('link', { name: 'Open the booking' }).click();
  await expect(page.getByRole('heading', { name: 'Lab booking: Ravi Kumar' })).toBeVisible();
  await expect(page.getByText('Pay at lab').first()).toBeVisible();
  await expect(page.getByText(/\(walk-in\)/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark visited' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark no-show' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reject booking' })).toHaveCount(0);
  // The list shows desk rows with "Pay at lab".
  await nav(page).getByRole('link', { name: 'Lab bookings' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Ravi Kumar' })).toContainText('Pay at lab');
});

test('lab visit at a time for a new number: the time is sent; a changed price is said and booked again at the new total', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await page.goto('/#/partner/lab-desk');
  await patient(page, NEW_PHONE, 'Asha Nair');
  const form = page.getByRole('form', { name: 'Tests and time' });
  await form.getByLabel('Lab visit at a time').check();
  await form.getByLabel('Branch').selectOption({ label: 'Indiranagar' });
  await form.getByLabel(/^CBC/).check();
  await form.getByRole('button', { name: /11:00–11:30/ }).click();
  await form.getByLabel('Language the patient speaks').selectOption('en');
  backend.bumpPrice = { itemId: T1, priceMinor: 35000 };
  await form.getByRole('button', { name: 'Book' }).click();
  await page.getByRole('button', { name: 'Yes, book for ₹300.00' }).click();
  await expect(page.getByText('The lab’s prices changed: the total is now ₹350.00.', { exact: false })).toBeVisible();
  await expect(form.getByText('Total: ₹350.00, paid at the lab')).toBeVisible();
  await form.getByRole('button', { name: 'Book' }).click();
  await page.getByRole('button', { name: 'Yes, book for ₹350.00' }).click();
  await expect(page.getByRole('heading', { name: 'Booked' })).toBeVisible();
  const sent = creates(backend);
  expect(sent).toHaveLength(2);
  expect(sent[1]!.body).toMatchObject({ phone: NEW_PHONE, visitMode: 'lab', slotId: S1, acceptedTotalMinor: 35000 });
  // A new request after a refusal: a new key.
  expect((sent[1]!.body as Rec).requestKey).not.toBe((sent[0]!.body as Rec).requestKey);
  await expect(page.getByText('This number was new to Jansetu.', { exact: false })).toBeVisible();
});

test('home collection with a collector: the only home branch is chosen, the address and the collector are sent with the time', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await page.goto('/#/partner/lab-desk');
  await patient(page);
  const form = page.getByRole('form', { name: 'Tests and time' });
  await form.getByLabel('Home collection').check();
  // Lipid profile is offered at the lab only.
  await expect(form.getByLabel(/^Lipid profile/)).toHaveCount(0);
  await form.getByLabel(/^Thyroid package/).check();
  await form.getByRole('button', { name: /12:00–13:00/ }).click();
  await form.getByLabel('House and street').fill('12 MG Road');
  await form.getByLabel('City').fill('Bengaluru');
  await form.getByLabel('Pincode').fill('560001');
  await form.getByLabel('Collector’s mobile (optional)').fill('98765');
  await form.getByLabel('Language the patient speaks').selectOption('kn');
  await form.getByRole('button', { name: 'Book' }).click();
  await expect(form.getByText('Enter a 10-digit mobile number.')).toBeVisible();
  await expect(form.getByText('Enter the collector’s name.')).toBeVisible();
  await form.getByLabel('Collector’s name (optional)').fill('Anil Collector');
  await form.getByLabel('Collector’s mobile (optional)').fill('9811111111');
  await form.getByRole('button', { name: 'Book' }).click();
  await expect(page.getByRole('group', { name: 'Check the total' })).toContainText('at 12 MG Road, Bengaluru, 560001 · collector Anil Collector');
  await page.getByRole('button', { name: 'Yes, book for ₹700.00' }).click();
  await expect(page.getByRole('heading', { name: 'Booked' })).toBeVisible();
  expect(creates(backend)[0]!.body).toMatchObject({ visitMode: 'home', branchId: BR1, slotId: SH, itemIds: [T3], acceptedTotalMinor: 70000,
    address: { line1: '12 MG Road', city: 'Bengaluru', pincode: '560001' }, collector: { name: 'Anil Collector', phone: '9811111111' } });
  expect(await stored(page)).not.toMatch(/MG Road|9811111111/);
});

test('a lost answer: after a reload only the key is kept; the check by key finds the booking', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await page.goto('/#/partner/lab-desk');
  await patient(page);
  const form = page.getByRole('form', { name: 'Tests and time' });
  await form.getByLabel('Branch').selectOption({ label: 'Indiranagar' });
  await form.getByLabel(/^CBC/).check();
  await form.getByLabel('Language the patient speaks').selectOption('hi');
  await form.getByRole('button', { name: 'Book' }).click();
  backend.loseAfter = true;
  await page.getByRole('button', { name: 'Yes, book for ₹300.00' }).click();
  await expect(page.getByRole('group', { name: 'Unconfirmed booking' })).toContainText('The booking may already be made. Sending the same request again is safe: it is never booked twice.');
  expect(await stored(page)).not.toMatch(new RegExp(`${PHONE}|Ravi`));
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await page.goto('/#/partner/lab-desk');
  const panel = page.getByRole('group', { name: 'Unconfirmed booking' });
  await expect(panel).toContainText('Its details are not kept here');
  await expect(panel.getByRole('button', { name: 'Send the same request again' })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(page.getByRole('heading', { name: 'Already booked' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open the booking' })).toBeVisible();
  const key = (creates(backend)[0]!.body as Rec).requestKey as string;
  expect(backend.calls.some((c) => c.path === `/partner-workspace/lab-desk/bookings/by-key/${key}`)).toBe(true);
  expect(creates(backend)).toHaveLength(1);
});

test('Make bill: the existing bill form opens with the lab booking and the account holder’s mobile; the booking then shows its bill', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await page.goto('/#/partner/lab-desk');
  await patient(page);
  const form = page.getByRole('form', { name: 'Tests and time' });
  await form.getByLabel('Branch').selectOption({ label: 'Indiranagar' });
  await form.getByLabel(/^CBC/).check();
  await form.getByLabel('Language the patient speaks').selectOption('hi');
  await form.getByRole('button', { name: 'Book' }).click();
  await page.getByRole('button', { name: 'Yes, book for ₹300.00' }).click();
  await page.getByRole('link', { name: 'Make bill' }).click();
  await expect(page.getByRole('heading', { name: 'New bill' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Lab booking' })).toContainText('For the lab booking of Ravi Kumar');
  await expect(page.getByLabel('Mobile number', { exact: true })).toHaveValue(PHONE);
  await expect(page.getByLabel('Mobile number', { exact: true })).not.toBeEditable();
  await expect(page.getByLabel('Branch', { exact: true })).toHaveValue(BR1);
  expect(page.url()).not.toContain(PHONE);
  await page.getByLabel('From the catalogue').selectOption({ label: 'CBC · ₹300.00' });
  await page.getByRole('button', { name: 'Add item' }).click();
  await page.getByRole('button', { name: 'Review the bill' }).click();
  await expect(page.getByRole('group', { name: 'Issue the bill' })).toContainText('for the lab booking of Ravi Kumar');
  await page.getByRole('button', { name: 'Issue bill' }).click();
  await expect(page.getByText(/^Bill LB\/2627\/0001 issued\./)).toBeVisible();
  const made = backend.bookings[backend.bookings.length - 1]!;
  const create = backend.calls.find((c) => c.method === 'POST' && c.path === '/partner-workspace/invoices')!;
  expect(create.body).toMatchObject({ branchId: BR1, labBookingId: made._id, customer: { name: 'Ravi Kumar', phone: PHONE } });
  expect(create.body).not.toHaveProperty('appointmentId');
  await page.goto(`/#/partner/lab-bookings/${made._id}`);
  await expect(page.getByRole('region', { name: 'Bill' })).toContainText('Bill: LB/2627/0001');
  await expect(page.getByRole('link', { name: 'Make bill' })).toHaveCount(0);
  await nav(page).getByRole('link', { name: 'Lab bookings' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Ravi Kumar' })).toContainText('Pay at lab · Bill LB/2627/0001');
});

test('cancel a desk booking: confirmed with the version it was opened on; no money moves; then it is cancelled', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await page.goto(`/#/partner/lab-bookings/${'e1'.repeat(12)}`);
  await expect(page.getByRole('heading', { name: 'Lab booking: Meena Iyer' })).toBeVisible();
  // From the booking page later, Make bill asks for the account holder's mobile (the lab view carries no phone).
  await expect(page.getByRole('region', { name: 'Bill' })).toContainText('No bill yet.');
  const cancel = page.getByRole('region', { name: 'Cancel' });
  await cancel.getByRole('button', { name: 'Cancel this booking' }).click();
  await expect(cancel).toContainText('Its seat is freed.');
  await cancel.getByLabel('Why? (optional)').fill('Patient left');
  await cancel.getByRole('button', { name: 'Yes, cancel it' }).click();
  await expect(page.getByText('Cancelled. The patient is told; nothing was paid through Jansetu, so nothing is refunded.')).toBeVisible();
  await expect(page.getByText('Cancelled at the front desk', { exact: false })).toBeVisible();
  const sent = backend.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/cancel'));
  expect(sent.map((c) => c.path)).toEqual([`/partner-workspace/lab-desk/bookings/${'e1'.repeat(12)}/cancel`]);
  expect(sent[0]!.body).toEqual({ reason: 'Patient left', expectedVersion: 0 });
  await expect(page.getByRole('button', { name: 'Cancel this booking' })).toHaveCount(0);
});

test('WQ19b: a desk cancel lost before the server is checked while the booking is still confirmed: never said to be cancelled', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await page.goto(`/#/partner/lab-bookings/${'e1'.repeat(12)}`);
  const cancel = page.getByRole('region', { name: 'Cancel' });
  backend.loseCancelBefore = true;
  await cancel.getByRole('button', { name: 'Cancel this booking' }).click();
  await cancel.getByRole('button', { name: 'Yes, cancel it' }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed cancellation' });
  await expect(panel).toContainText('The booking may already be cancelled.');
  await panel.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(panel.getByText('Not cancelled so far.', { exact: false })).toBeVisible();
  await expect(page.getByText('The booking is cancelled.')).toHaveCount(0);
  await expect(page.getByText('Cancelled at the front desk', { exact: false })).toHaveCount(0);
  expect(backend.bookings.find((x) => x._id === 'e1'.repeat(12))!.status).toBe('confirmed');
  // Sending the same request again cancels it once.
  await panel.getByRole('button', { name: 'Send the same request again' }).click();
  await expect(page.getByText('Cancelled. The patient is told; nothing was paid through Jansetu, so nothing is refunded.')).toBeVisible();
});

test('switched off: the lookup says the front desk is not switched on yet', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.off = true;
  await signIn(page);
  await page.goto('/#/partner/lab-desk');
  await page.getByLabel('Patient’s mobile number').fill(PHONE);
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(page.getByText('The lab front desk is not switched on yet.', { exact: false })).toBeVisible();
  expect(creates(backend)).toHaveLength(0);
});

test('branch scope: staff see only their branches; another branch’s booking is not found; without bookings.manage there is no front desk', async ({ page }) => {
  const backend = await mockBackend(page, staff('bookings.manage'));
  await signIn(page);
  await expect(nav(page).getByRole('link', { name: 'Front desk' })).toBeVisible();
  await page.goto('/#/partner/lab-desk');
  await patient(page);
  // Only one branch of theirs offers lab visits: chosen at once.
  const form = page.getByRole('form', { name: 'Tests and time' });
  await expect(form.getByLabel('Branch')).toHaveCount(0);
  await page.goto(`/#/partner/lab-bookings/${FAR}`);
  await expect(page.getByText('Booking not found')).toBeVisible();
  expect(backend.calls.some((c) => c.path === `/partner-workspace/lab-bookings/${FAR}`)).toBe(true);

  backend.me = staff('bookings.view');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect(nav(page).getByRole('link', { name: 'Front desk' })).toHaveCount(0);
  await page.goto('/#/partner/lab-desk');
  await expect(page.getByText('Page not found')).toBeVisible();
});

// ── WQ21b: the recommended-tests code at the front desk (the pharmacy's step, r16b route) ──

test('WQ21b: a code from the doctor ticks this lab’s matching tests; the rest are said; nothing new is sent or stored', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await nav(page).getByRole('link', { name: 'Front desk' }).click();
  await patient(page);
  await page.getByLabel('Have a test code from the doctor? (optional)').fill('abcd efgh');
  await page.getByRole('button', { name: 'Load tests' }).click();
  await expect(page.getByText('Recommended tests: cbc, Lipid  Profile, Vitamin D.')).toBeVisible();
  const form = page.getByRole('form', { name: 'Tests and time' });
  await expect(form.getByLabel(/^CBC/)).toBeChecked();
  await expect(form.getByLabel(/^Lipid profile/)).toBeChecked();
  await expect(page.getByText("Vitamin D: not in this lab's list.")).toBeVisible();
  await form.getByLabel('Branch').selectOption({ label: 'Indiranagar' });
  await expect(form.getByText('Total: ₹750.00, paid at the lab')).toBeVisible();
  await form.getByLabel('Language the patient speaks').selectOption('hi');
  await form.getByRole('button', { name: 'Book' }).click();
  await page.getByRole('button', { name: 'Yes, book for ₹750.00' }).click();
  await expect(page.getByRole('heading', { name: 'Booked' })).toBeVisible();
  const loads = backend.calls.filter((c) => c.path.includes('/recommendations'));
  expect(loads).toEqual([{ method: 'POST', path: '/partner-workspace/lab-desk/recommendations/lookup', body: { code: 'ABCDEFGH', phone: PHONE } }]);
  expect(Object.keys(creates(backend)[0]!.body as Rec).filter((k) => /recommend/i.test(k))).toEqual([]);
  const all = await stored(page) + backend.calls.map((c) => c.path).join(' ');
  for (const w of ['ABCDEFGH', PHONE]) expect(all).not.toContain(w);
});

test('WQ21b: an unknown code (or another number) is said plainly at the desk', async ({ page }) => {
  await mockBackend(page);
  await signIn(page);
  await nav(page).getByRole('link', { name: 'Front desk' }).click();
  await patient(page);
  await page.getByLabel('Have a test code from the doctor? (optional)').fill('WXYZ-2345');
  await page.getByRole('button', { name: 'Load tests' }).click();
  await expect(page.getByText('No recommended tests were found for this code and this mobile number. Check both with the patient.')).toBeVisible();
  await expect(page.getByRole('form', { name: 'Tests and time' }).getByLabel(/^CBC/)).not.toBeChecked();
});
