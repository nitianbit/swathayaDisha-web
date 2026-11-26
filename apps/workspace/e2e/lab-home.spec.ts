import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * WQ55 (P4): the simple lab front-desk home against a mocked API (backend r38 85c10c6e: the pharmacy's r37c shapes on
 * `/partner-workspace/today`, `…/today/search`, `…/todos`; a lab's rows, `bank`, its waiting work): big buttons by permission, + New (the
 * same patient step with "This person / Someone else", then the desk walk-in, a home collection, a doctor, a bill), the
 * day's register. A walk-in CBC paid in cash, a home collection, a family member, a branch-limited member and a member
 * without billing permission, on a desktop, a tablet and a 390 px phone.
 */
const LAB = 'a1'.repeat(12);
const OWNER = 'b1'.repeat(12);
const STAFF = 'b2'.repeat(12);
const BR1 = 'c1'.repeat(12);
const BR2 = 'c2'.repeat(12);
const T1 = 'd1'.repeat(12);
const SH = 'f3'.repeat(12);
const PHONE = '9876543210';
const DAY = '2026-11-25';
const ALL = ['staff.manage', 'branches.manage', 'catalogue.manage', 'slots.manage', 'bookings.view', 'bookings.manage', 'reports.upload',
  'reports.release', 'invoices.create', 'invoices.cancel', 'payments.record', 'finance.view', 'assisted.book'];
/** Wednesday 25 Nov 2026, 10:00 in India. */
const NOW = new Date('2026-11-25T04:30:00.000Z');

type Rec = Record<string, unknown>;
interface Me { _id: string; partnerId: string; name: string; role: 'owner' | 'staff'; permissions: string[]; branchIds: string[] }
interface Backend {
  calls: { method: string; path: string; body: Rec | null }[];
  me: Me;
  live: boolean;
  register: Rec[];
  bookings: Rec[];
  bills: Rec[];
  todos: Rec[];
  /** The day's register refuses this member (403). */
  todayForbidden?: boolean;
  /** More waiting work (r38 shapes). */
  pendingExtra: Rec;
  /** r38b: money returned today. */
  refundedMinor?: number;
}

const owner: Me = { _id: OWNER, partnerId: LAB, name: 'Ravi Owner', role: 'owner', permissions: ALL, branchIds: [] };
const staff = (branchIds: string[], ...permissions: string[]): Me => ({ _id: STAFF, partnerId: LAB, name: 'Sita Staff', role: 'staff', permissions, branchIds });

async function mockBackend(page: Page, me: Me = owner): Promise<Backend> {
  await page.clock.setFixedTime(NOW);
  const b: Backend = { calls: [], me, live: false, register: [], bookings: [], bills: [], todos: [], pendingExtra: {} };
  const partner = { _id: LAB, kind: 'lab', name: 'City Lab', contact: { phone: '9000000000' }, verification: { state: 'verified' }, taxRegime: 'unregistered',
    invoiceSeries: { prefix: 'LB' }, activeOwnerCount: 1, isActive: true };
  const branches = [
    { _id: BR1, partnerId: LAB, name: 'Indiranagar', address: { line1: '1 Main Rd', city: 'Bengaluru', state: 'Karnataka', stateCode: '29', pincode: '560038' },
      services: { homeCollection: true, inLab: true }, isActive: true },
    { _id: BR2, partnerId: LAB, name: 'Koramangala', address: { line1: '2 Ring Rd', city: 'Bengaluru', state: 'Karnataka', stateCode: '29', pincode: '560034' },
      services: { homeCollection: false, inLab: true }, isActive: true },
  ];
  const catalogue = [{ _id: T1, partnerId: LAB, kind: 'test', name: 'CBC', priceMinor: 30000, gstRate: 0, visitModes: ['lab', 'home'], isActive: true, adminDisabled: false }];
  const slots = [{ _id: SH, partnerId: LAB, branchId: BR1, visitMode: 'home', date: DAY, startTime: '12:00', endTime: '13:00',
    startsAt: '2026-11-25T06:30:00.000Z', endsAt: '2026-11-25T07:30:00.000Z', capacity: 2, booked: 0, closed: null, source: 'template' }];
  let seq = 0;
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const ok = (route: Route, data: unknown, status = 200, extra: Rec = {}) => json(route, status, { success: true, data, ...extra });
  const fail = (route: Route, status: number, code: string, message: string) => json(route, status, { error: status, code, message });
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = req.method();
    const body = ['POST', 'PUT', 'PATCH'].includes(method) ? (req.postDataJSON() as Rec | null) : null;
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
    const inScope = (branchId: unknown) => b.me.role === 'owner' || b.me.branchIds.length === 0 || b.me.branchIds.includes(String(branchId));
    if (sub === '/me') return ok(route, partner);
    if (sub === '/branches') return ok(route, branches);
    if (sub === '/catalogue' && method === 'GET') return ok(route, catalogue);
    if (sub === '/slots' && method === 'GET') {
      const q = url.searchParams;
      return ok(route, slots.filter((s) => s.branchId === q.get('branchId') && s.visitMode === q.get('visitMode')));
    }

    // ── r38: the day's register (the pharmacy's shapes) and the lab's to-dos ──
    const pageOf = (rows: Rec[], q: { order?: unknown; limit?: unknown }) => {
      const list = q.order === 'desc' ? [...rows].reverse() : rows;
      return { items: list.slice(0, Number(q.limit ?? 50)), nextCursor: null };
    };
    if (sub === '/today' && method === 'GET') {
      if (b.todayForbidden) return fail(route, 403, 'FORBIDDEN', 'You do not have permission');
      const q = Object.fromEntries(url.searchParams);
      // r38: a desk booking's money is on its bill (the booking row is not paid and owes nothing itself).
      const paid = b.register.filter((r) => r.paid);
      const byMethod: Record<string, number> = { cash: 0, upi: 0, card: 0, bank: 0, wallet: 0, online: 0, other: 0 };
      for (const r of paid) byMethod[String(r.method)] = (byMethod[String(r.method)] ?? 0) + Number(r.amountMinor);
      const unpaid = b.register.filter((r) => !r.paid && r.kind === 'bill');
      const home = b.bookings.filter((x) => x.visitMode === 'home');
      const open = b.bills.filter((x) => x.lifecycleState !== 'paid');
      return ok(route, { date: DAY, ...pageOf(b.register, q),
        totals: { collectedMinor: paid.reduce((n, r) => n + Number(r.amountMinor), 0), byMethod, unpaidMinor: unpaid.reduce((n, r) => n + Number(r.amountMinor), 0),
          count: b.register.length, ...(b.refundedMinor ? { refundedMinor: b.refundedMinor, refundsByMethod: { cash: b.refundedMinor } } : {}) },
        pending: { samplesToCollect: { count: home.length, visitCount: 0, homeCount: home.length, visitIds: [], homeIds: home.map((x) => x._id) },
          reportsDue: { count: 0, toUploadCount: 0, toReleaseCount: 0, toUploadIds: [], toReleaseIds: [] },
          // A queue this member may not read is absent.
          ...(b.me.permissions.includes('invoices.create') ? { unpaidBills: { count: open.length, ids: open.map((x) => x._id) } } : {}),
          bookingsAwaitingPayment: { count: 0, ids: [] }, ...b.pendingExtra } });
    }
    if (sub === '/today/search' && method === 'POST') {
      const needle = String(body!.q).toLowerCase();
      return ok(route, { date: DAY, ...pageOf(b.register.filter((r) => [r.patientName, r.shortRef, r.what, r.phone].join(' ').toLowerCase().includes(needle)), body!) });
    }
    if (sub === '/todos' && method === 'GET') return ok(route, [...b.todos].reverse(), 200, { pagination: { nextCursor: null } });
    if (sub === '/todos' && method === 'POST') {
      const todo = { _id: `7${b.todos.length}`.padStart(24, '0'), text: body!.text, done: false, version: 1, createdBy: { kind: 'member', id: b.me._id, name: b.me.name } };
      b.todos.push(todo);
      return ok(route, { todo, replayed: false }, 201);
    }

    // ── r12 lab desk (the walk-in and the home collection) ──
    if (sub === '/lab-desk/patients/lookup' && method === 'POST') return ok(route, { exists: true, holderNameMasked: 'R*** K***' });
    if (sub === '/assisted/patients/lookup' && method === 'POST') return ok(route, { exists: true, holderNameMasked: 'R*** K***' });
    if (sub === '/lab-desk/bookings' && method === 'POST') {
      const x = body as { visitMode: string; slotId?: string; itemIds: string[]; branchId: string; patient: Rec };
      if (!inScope(x.branchId)) return fail(route, 403, 'BRANCH_OUT_OF_SCOPE', 'Not your branch');
      const chosen = catalogue.filter((i) => x.itemIds.includes(i._id));
      const total = chosen.reduce((n, i) => n + i.priceMinor, 0);
      const id = `ab${String(++seq).padStart(22, '0')}`;
      const name = String(x.patient.name ?? 'Patient');
      const row = { _id: id, partnerId: LAB, branchId: x.branchId, userId: 'u1'.repeat(12), patient: { kind: x.patient.relation === 'self' ? 'self' : 'dependent', name },
        visitMode: x.visitMode, slot: x.slotId ? { slotId: x.slotId, date: DAY, startTime: '12:00', endTime: '13:00', startsAt: '2026-11-25T06:30:00.000Z' }
          : { walkIn: true, date: DAY, startTime: '10:00', startsAt: NOW.toISOString() },
        items: chosen.map((i) => ({ catalogItemId: i._id, kind: i.kind, name: i.name, priceMinor: i.priceMinor, gstRate: 0 })),
        pricing: { subtotalMinor: total, discountMinor: 0, payableMinor: total, commissionMinor: 0, currency: 'INR' }, status: 'confirmed', statusVersion: 0,
        paymentStatus: 'pending', reschedule: { version: 0, pending: false }, report: { draftFiles: [], releasedFiles: [], releases: [] }, lifecycle: {},
        source: 'lab_desk', payAtLab: true, desk: { memberId: b.me._id, branchId: x.branchId, arrivedAt: null, preferredLanguage: 'hi', payAtLab: true }, bill: null,
        createdAt: NOW.toISOString() };
      b.bookings.push(row);
      b.register.push({ kind: 'lab_booking', id, at: new Date(NOW.getTime() + b.register.length * 60_000).toISOString(), shortRef: `LD${seq}`, patientName: name, phone: PHONE,
        what: 'CBC', whatParts: { code: 'lab.tests', values: { first: 'CBC', more: 0, source: 'lab_desk', visit: x.visitMode } }, amountMinor: total, paid: false,
        method: null, status: 'confirmed', madeOn: DAY, paidToday: false, link: { kind: 'lab_booking', id } });
      return ok(route, { booking: row, patient: { name }, newAccount: false, replayed: false }, 201);
    }
    const one = /^\/lab-bookings\/([0-9a-f]{24})$/.exec(sub);
    if (one) return ok(route, b.bookings.find((y) => y._id === one[1]));

    // ── bills (issued from a desk booking, then paid) ──
    if (sub === '/invoices' && method === 'POST') {
      const x = body as { branchId: string; labBookingId?: string; customer: Rec; items: Rec[]; idempotencyKey: string };
      const total = x.items.reduce((n, l) => n + (l.unitPriceMinor as number) * (l.qty as number), 0);
      const inv = { _id: `bb${String(b.bills.length + 1).padStart(22, '0')}`, partnerId: LAB, branchId: x.branchId, number: b.bills.length + 1, financialYear: '2627',
        serial: `LB/2627/000${b.bills.length + 1}`, documentKind: 'bill_of_supply', issuedAt: NOW.toISOString(), supplier: { name: 'City Lab', address: '1 Main Rd', placeOfSupply: '29' },
        customer: x.customer, ...(x.labBookingId ? { labBookingId: x.labBookingId } : {}),
        items: x.items.map((l) => ({ ...l, discountMinor: 0, amountMinor: (l.unitPriceMinor as number) * (l.qty as number) })),
        totals: { subtotalMinor: total, discountMinor: 0, taxableMinor: total, cgstMinor: 0, sgstMinor: 0, igstMinor: 0, totalMinor: total, currency: 'INR' },
        lifecycleState: 'issued', lifecycleVersion: 0, paidMinor: 0, dueMinor: total, createdBy: b.me._id, idempotencyKey: x.idempotencyKey };
      b.bills.push(inv);
      const bk = b.bookings.find((y) => y._id === x.labBookingId);
      if (bk) bk.bill = { invoiceId: inv._id, serial: inv.serial, number: inv.number, state: 'issued' };
      b.register.push({ kind: 'bill', id: inv._id, at: new Date(NOW.getTime() + b.register.length * 60_000).toISOString(), shortRef: inv.serial,
        patientName: String(x.customer.name), phone: PHONE, what: 'CBC', whatParts: { code: 'bill.items', values: { first: 'CBC', more: 0 } }, amountMinor: total,
        paid: false, method: null, status: 'issued', madeOn: DAY, paidToday: false, link: { kind: 'invoice', id: inv._id } });
      return ok(route, inv, 201);
    }
    const bill = /^\/invoices\/([0-9a-f]{24})(\/pay)?$/.exec(sub);
    if (bill) {
      const inv = b.bills.find((y) => y._id === bill[1])!;
      if (bill[2]) {
        const x = body as { splits: { mode: string; amountMinor: number }[]; requestKey: string };
        Object.assign(inv, { lifecycleState: 'paid', lifecycleVersion: 1, paidMinor: inv.dueMinor, dueMinor: 0 });
        const e = { _id: 'ev1', invoiceId: inv._id, version: 1, at: NOW.toISOString(), by: b.me._id, byKind: 'member', kind: 'payment', mode: x.splits[0]!.mode,
          amountMinor: x.splits[0]!.amountMinor, splits: x.splits, requestKey: x.requestKey };
        // The register's row of that booking is paid now, by that method.
        Object.assign(b.register.find((r) => r.id === inv._id)!, { paid: true, method: x.splits[0]!.mode });
        inv.events = [e];
        return ok(route, { invoice: { ...inv }, event: e });
      }
      const { events, ...rest } = inv;
      return ok(route, { invoice: rest, events: events ?? [] });
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
  await expect(page.getByRole('heading', { name: 'Today’s register' })).toBeVisible();
}
const bigButtons = (page: Page) => page.getByRole('navigation', { name: 'What do you want to do?' });
const choices = (page: Page) => page.getByRole('navigation', { name: 'What does the patient need?' });
const whoIs = (page: Page) => page.getByRole('group', { name: 'Who is the patient?' });
const money = (page: Page) => page.getByRole('region', { name: 'Money of the day' });
const deskCreates = (b: Backend) => b.calls.filter((c) => c.method === 'POST' && c.path === '/partner-workspace/lab-desk/bookings').map((c) => c.body!);
const stored = (page: Page) => page.evaluate(() => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }) + location.href);
const noSidewaysScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

/** + New → the number → who → Next. */
async function newVisit(page: Page, who: { self: string } | { family: string; relation: string }) {
  await bigButtons(page).getByRole('link', { name: '+ New' }).click();
  // A lab finds a patient by phone.
  await page.getByLabel('Patient’s mobile number').fill(PHONE);
  await page.getByRole('button', { name: 'Find', exact: true }).click();
  await expect(page.getByText('This number is on Jansetu: R*** K***')).toBeVisible();
  if ('self' in who) {
    await whoIs(page).getByRole('button', { name: 'This person' }).click();
    await page.getByLabel('Patient’s full name').fill(who.self);
  } else {
    await whoIs(page).getByRole('button', { name: 'Someone else (family member)' }).click();
    await page.getByLabel('Family member’s full name').fill(who.family);
    await page.getByLabel('Relation to the phone’s owner').selectOption(who.relation);
  }
  await page.getByRole('button', { name: 'Next', exact: true }).click();
}

/** The desk in visit mode: the patient named once, the agreement, then the tests. */
async function deskPatient(page: Page, line: string) {
  await expect(page.getByRole('heading', { name: 'Front desk', level: 1 })).toBeVisible();
  await expect(page.getByText(`Patient: ${line}`)).toBeVisible();
  await expect(page.getByText('Who is the patient?')).toHaveCount(0);
  await page.getByLabel('Patient agreed to this booking').check();
  await page.getByRole('button', { name: 'Next: choose the tests' }).click();
}

/** A walk-in CBC paid in cash: + New → the desk → Make bill → the bill paid in cash → Today with its totals. */
async function walkInPaidInCash(page: Page, b: Backend) {
  await signIn(page);
  await expect(bigButtons(page).getByRole('link')).toHaveText(['+ New', 'Find patient', 'New bill', 'Today']);
  await expect(page.getByText('Nothing yet today')).toBeVisible();
  await newVisit(page, { self: 'Meena Iyer' });
  await expect(choices(page).getByRole('link')).toHaveText(['Lab test at the desk', 'Home collection', 'Book a doctor', 'Bill']);
  await choices(page).getByRole('link', { name: 'Lab test at the desk' }).click();
  await deskPatient(page, `Meena Iyer · ${PHONE}`);
  const form = page.getByRole('form', { name: 'Tests and time' });
  await expect(form.getByLabel('Walk-in now')).toBeChecked();
  await form.getByLabel('Branch').selectOption({ label: 'Indiranagar' });
  await form.getByLabel(/^CBC/).check();
  await form.getByLabel('Language the patient speaks').selectOption('hi');
  await form.getByRole('button', { name: 'Book' }).click();
  await page.getByRole('button', { name: 'Yes, book for ₹300.00' }).click();
  await expect(page.getByRole('heading', { name: 'Booked' })).toBeVisible();
  expect(deskCreates(b)[0]).toMatchObject({ phone: PHONE, patient: { relation: 'self', name: 'Meena Iyer' }, visitMode: 'lab', itemIds: [T1] });
  // The number was looked up once, on + New.
  expect(b.calls.filter((c) => c.path.endsWith('/patients/lookup'))).toHaveLength(1);

  await page.getByRole('link', { name: 'Make bill' }).click();
  await page.getByLabel('From the catalogue').selectOption({ label: 'CBC · ₹300.00' });
  await page.getByRole('button', { name: 'Add item' }).click();
  await page.getByRole('button', { name: 'Review the bill' }).click();
  await page.getByRole('button', { name: 'Issue bill' }).click();
  await expect(page.getByText(/^Bill LB\/2627\/0001 issued\./)).toBeVisible();
  // Mark paid needs a chosen method: none at first.
  await page.getByRole('button', { name: 'Record payment' }).click();
  await expect(page.getByLabel('Paid by')).toHaveValue('');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Choose how it was paid: cash, UPI, card, bank or other.')).toBeVisible();
  await page.getByLabel('Paid by').selectOption('cash');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Record ₹300.00 paid' }).click();
  await expect(page.getByText('Paid by Cash')).toBeVisible();
  expect(b.calls.find((c) => c.path.endsWith('/pay'))!.body).toMatchObject({ splits: [{ mode: 'cash', amountMinor: 30000 }] });

  await bigButtonsVia(page);
  await bigButtons(page).getByRole('link', { name: 'Today' }).click();
  await expect(page.getByRole('heading', { name: 'Today', level: 1 })).toBeVisible();
  await expect(money(page).getByRole('paragraph')).toHaveText(['Collected today ₹300.00', 'Cash ₹300.00', 'To collect ₹0.00']);
  const rows = page.getByRole('list', { name: 'The day’s visits, sales and tests' }).getByRole('listitem');
  await expect(rows).toHaveCount(2);
  // r38: newest first: the bill (paid in cash), then its desk booking (its money is on the bill).
  await expect(rows.nth(0)).toContainText('Meena Iyer: CBC');
  await expect(rows.nth(0)).toContainText('Paid (cash)');
  await expect(rows.nth(0).getByRole('link')).toHaveAttribute('href', `#/partner/invoices/${String(b.bills[0]!._id)}`);
  await expect(rows.nth(1)).toContainText('Paid on its bill');
  await expect(rows.nth(1).getByRole('link')).toHaveAttribute('href', `#/partner/lab-bookings/${String(b.bookings[0]!._id)}`);
  expect(await stored(page)).not.toMatch(new RegExp(`${PHONE}|Meena`));
  expect(b.calls.some((c) => c.path.includes(PHONE) || c.path.includes('Meena'))).toBe(false);
}
/** Back to the home (Home on the page, or in a phone's header). */
async function bigButtonsVia(page: Page) {
  await page.getByRole('link', { name: 'Home', exact: true }).first().click();
  await expect(bigButtons(page)).toBeVisible();
}

test('a walk-in CBC paid in cash appears in Today with its totals', async ({ page }) => {
  const b = await mockBackend(page);
  await walkInPaidInCash(page, b);
});

test('a home collection: + New opens the desk on a home collection; the address and the time are sent', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await newVisit(page, { self: 'Meena Iyer' });
  await choices(page).getByRole('link', { name: 'Home collection' }).click();
  await deskPatient(page, `Meena Iyer · ${PHONE}`);
  const form = page.getByRole('form', { name: 'Tests and time' });
  await expect(form.getByLabel('Home collection')).toBeChecked();
  await form.getByLabel(/^CBC/).check();
  await form.getByRole('button', { name: /12:00–13:00/ }).click();
  await form.getByLabel('House and street').fill('12 MG Road');
  await form.getByLabel('City').fill('Bengaluru');
  await form.getByLabel('Pincode').fill('560001');
  await form.getByLabel('Language the patient speaks').selectOption('kn');
  await form.getByRole('button', { name: 'Book' }).click();
  await page.getByRole('button', { name: 'Yes, book for ₹300.00' }).click();
  await expect(page.getByRole('heading', { name: 'Booked' })).toBeVisible();
  expect(deskCreates(b)[0]).toMatchObject({ visitMode: 'home', slotId: SH, branchId: BR1, address: { line1: '12 MG Road', city: 'Bengaluru', pincode: '560001' } });
  // The waiting work (r38): a sample to collect today (one: its page); reports due by step; a queue that failed says so.
  b.pendingExtra = { reportsDue: { count: 3, toUploadCount: 2, toReleaseCount: 1, toUploadIds: [], toReleaseIds: [] }, consultationsWaiting: null,
    deskUnbilled: { count: 2, ids: [] } };
  b.refundedMinor = 5000;
  await bigButtonsVia(page);
  // r38b: walk-ins without a bill; a refund that day on its own line (collected unchanged).
  await expect(page.getByRole('link', { name: '2 walk-ins without a bill' })).toHaveAttribute('href', '#/partner/lab-bookings');
  await expect(money(page).getByRole('paragraph')).toHaveText(['Collected today ₹0.00', 'To collect ₹0.00', 'Refunded today ₹50.00']);
  await expect(page.getByRole('link', { name: '1 sample to collect today' })).toHaveAttribute('href', `#/partner/lab-bookings/${String(b.bookings[0]!._id)}`);
  await expect(page.getByRole('link', { name: '2 reports to upload' })).toHaveAttribute('href', '#/partner/lab-bookings');
  await expect(page.getByRole('link', { name: '1 report to release' })).toBeVisible();
  await expect(page.getByText('Consultations waiting: couldn’t load')).toBeVisible();
  await expect(page.getByText('Lab tests · home collection').or(page.getByText(/CBC · home collection/))).toBeVisible();
});

test('a family member: Ravi on his mother’s number is booked as her son; the bill is in the owner’s name', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await newVisit(page, { family: 'Ravi', relation: 'Son' });
  await expect(page.getByText('Ravi (son of R*** K***)')).toBeVisible();
  await choices(page).getByRole('link', { name: 'Lab test at the desk' }).click();
  await deskPatient(page, 'Ravi (son of R*** K***)');
  const form = page.getByRole('form', { name: 'Tests and time' });
  await form.getByLabel('Branch').selectOption({ label: 'Indiranagar' });
  await form.getByLabel(/^CBC/).check();
  await form.getByLabel('Language the patient speaks').selectOption('hi');
  await form.getByRole('button', { name: 'Book' }).click();
  await page.getByRole('button', { name: 'Yes, book for ₹300.00' }).click();
  expect(deskCreates(b)[0]).toMatchObject({ phone: PHONE, patient: { relation: 'Son', name: 'Ravi' } });
  // Bill from + New for the same family member: the bill names the phone's owner (typed there), not Ravi.
  await bigButtonsVia(page);
  await newVisit(page, { family: 'Ravi', relation: 'Son' });
  await choices(page).getByRole('link', { name: 'Bill' }).click();
  await expect(page.getByRole('heading', { name: 'New bill' })).toBeVisible();
  await expect(page.getByText('Patient: Ravi (son of R*** K***)')).toBeVisible();
  await expect(page.getByText('The bill is in the phone owner’s name (a bill has no separate patient).')).toBeVisible();
  await expect(page.getByLabel('Customer name')).toHaveValue('');
  await expect(page.getByLabel(/^Mobile number/)).toHaveValue(PHONE);
});

test('a branch-limited member: the desk offers only their branch; the partner-wide pages stay hidden', async ({ page }) => {
  const b = await mockBackend(page, staff([BR2], 'bookings.view', 'bookings.manage', 'invoices.create', 'payments.record'));
  await signIn(page);
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Finance' })).toHaveCount(0);
  await newVisit(page, { self: 'Meena Iyer' });
  // Without `assisted.book`, no doctor.
  await expect(choices(page).getByRole('link')).toHaveText(['Lab test at the desk', 'Home collection', 'Bill']);
  await choices(page).getByRole('link', { name: 'Lab test at the desk' }).click();
  await deskPatient(page, `Meena Iyer · ${PHONE}`);
  const form = page.getByRole('form', { name: 'Tests and time' });
  // Only Koramangala is theirs: chosen at once, Indiranagar never offered.
  await expect(form.getByText('Indiranagar')).toHaveCount(0);
  await form.getByLabel(/^CBC/).check();
  await form.getByLabel('Language the patient speaks').selectOption('hi');
  await form.getByRole('button', { name: 'Book' }).click();
  await page.getByRole('button', { name: 'Yes, book for ₹300.00' }).click();
  expect(deskCreates(b)[0]).toMatchObject({ branchId: BR2 });
});

test('a member without billing permission: no New bill, no Bill; a member allowed none of it is told to ask the owner', async ({ page }) => {
  const b = await mockBackend(page, staff([], 'bookings.view', 'bookings.manage'));
  await signIn(page);
  await expect(bigButtons(page).getByRole('link')).toHaveText(['+ New', 'Find patient', 'Today']);
  await newVisit(page, { self: 'Meena Iyer' });
  await expect(choices(page).getByRole('link')).toHaveText(['Lab test at the desk', 'Home collection']);
  // r38: a queue this member may not read (unpaid bills) is absent: no line at all.
  await page.goto('/#/');
  await expect(page.getByText(/unpaid bill/)).toHaveCount(0);
  // Allowed none of the visits (and not the register): said plainly, never a blank screen.
  b.me = staff([], 'reports.upload');
  b.todayForbidden = true;
  await page.goto('/#/');
  await page.reload();
  await expect(bigButtons(page).getByRole('link')).toHaveText(['Today']);
  await expect(page.getByText('To start visits or bills here, ask the lab owner to allow them.')).toBeVisible();
  await expect(page.getByText('Ask the lab owner to allow this.').first()).toBeVisible();
  await page.goto('/#/partner/new');
  await expect(page.getByText('To start visits or bills here, ask the lab owner to allow them.')).toBeVisible();
});

test.describe('on a 390 px phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop', 'the phone size runs once'));

  test('a walk-in CBC paid in cash on a phone: Home and Menu in the header, 17 px text, nothing wider than the screen', async ({ page }) => {
    const b = await mockBackend(page);
    await walkInPaidInCash(page, b);
    await noSidewaysScroll(page);
    await expect(page.getByRole('button', { name: 'Menu' })).toBeVisible();
  });

  test('a family member on a phone', async ({ page }) => {
    const b = await mockBackend(page);
    await signIn(page);
    await newVisit(page, { family: 'Ravi', relation: 'Son' });
    await choices(page).getByRole('link', { name: 'Lab test at the desk' }).click();
    await deskPatient(page, 'Ravi (son of R*** K***)');
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.ws-main')!).fontSize)).toBe('17px');
    await noSidewaysScroll(page);
    expect(b.calls.some((c) => c.path.includes(PHONE))).toBe(false);
  });
});
