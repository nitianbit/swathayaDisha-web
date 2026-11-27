import { expect, test, type Locator, type Page, type Route } from '@playwright/test';

/**
 * WQ57 (P3) / WQ57b: the simple clinic reception home against a mocked API (backend r40 21a4a92b, r40d's lookup: the lab's Today shapes on
 * `/partner-workspace/today` with appointments and their bills, `busy` beside the clinic's appointments): big buttons by
 * permission, the doctors today with their busy blocks, + New (the shared patient step, then an appointment now or later, or
 * a bill), the desk booked in one tap, its bill with the doctor's fee, and Today as one row per visit. On a desktop, a
 * tablet and a 390 px phone.
 */
const CLINIC = 'a1'.repeat(12);
const OWNER = 'b1'.repeat(12);
const STAFF = 'b2'.repeat(12);
const BR1 = 'c1'.repeat(12);
const BR2 = 'c2'.repeat(12);
const D1 = 'd1'.repeat(12);
const D2 = 'd2'.repeat(12);
const PHONE = '9876543210';
const DAY = '2026-11-26';
const NEXT = '2026-11-27';
const ALL = ['staff.manage', 'branches.manage', 'catalogue.manage', 'slots.manage', 'bookings.view', 'bookings.manage', 'invoices.create', 'invoices.cancel',
  'payments.record', 'finance.view'];
/** Thursday 26 Nov 2026, 10:00 in India. */
const NOW = new Date('2026-11-26T04:30:00.000Z');

type Rec = Record<string, unknown>;
interface Me { _id: string; partnerId: string; name: string; role: 'owner' | 'staff'; permissions: string[]; branchIds: string[] }
interface Backend { calls: { method: string; path: string; body: Rec | null }[]; me: Me; live: boolean; appts: Rec[]; register: Rec[]; bills: Rec[]; todayForbidden?: boolean;
  catalogue?: Rec[];
  hideBookedRows?: boolean;
  /** A server without r40d's lookup (404, no code). */
  noLookup?: boolean }

const owner: Me = { _id: OWNER, partnerId: CLINIC, name: 'Ravi Owner', role: 'owner', permissions: ALL, branchIds: [] };
const staff = (branchIds: string[], ...permissions: string[]): Me => ({ _id: STAFF, partnerId: CLINIC, name: 'Sita Staff', role: 'staff', permissions, branchIds });
const slotId = (d: string, b: string, date: string, time: string) => `5${d.slice(1, 2)}${b.slice(1, 2)}${date.replace(/-/g, '')}${time.replace(':', '')}`.padEnd(24, '0');
const at = (date: string, time: string) => new Date(Date.parse(`${date}T${time}:00+05:30`)).toISOString();

async function mockBackend(page: Page, me: Me = owner, opts: { regular?: boolean } = {}): Promise<Backend> {
  await page.clock.setFixedTime(NOW);
  const b: Backend = { calls: [], me, live: false, appts: [], register: [], bills: [] };
  const partner = { _id: CLINIC, kind: 'clinic', name: 'Sunrise Clinic', contact: { phone: '9000000008' }, verification: { state: 'verified' },
    // WQ58b: a GST-registered clinic (regular, Maharashtra) where a test asks for one.
    ...(opts.regular ? { taxRegime: 'regular', gstin: '27ABCDE1234F1Z5' } : { taxRegime: 'unregistered' }),
    invoiceSeries: { prefix: 'SC' }, activeOwnerCount: 1, isActive: true };
  const branches = [
    { _id: BR1, partnerId: CLINIC, name: 'MG Road', address: { line1: '1 MG Rd', city: 'Pune', state: 'Maharashtra', stateCode: '27', pincode: '411001' }, services: { inClinic: true }, isActive: true },
    { _id: BR2, partnerId: CLINIC, name: 'Aundh', address: { line1: '2 Aundh Rd', city: 'Pune', state: 'Maharashtra', stateCode: '27', pincode: '411007' }, services: { inClinic: true }, isActive: true },
  ];
  const doctors = [
    { memberId: '71'.repeat(12), doctorId: D1, role: 'staff', branchIds: [], name: 'Dr Kavya', specialization: 'General physician', consultationFee: 500, active: true },
    { memberId: '72'.repeat(12), doctorId: D2, role: 'staff', branchIds: [BR2], name: 'Dr Rao', specialization: 'Dermatologist', consultationFee: 800, active: true },
  ];
  const slots = [
    { doctorId: D1, branchId: BR1, date: DAY, start: '10:15', end: '10:30' }, { doctorId: D1, branchId: BR1, date: DAY, start: '10:30', end: '10:45' },
    { doctorId: D1, branchId: BR2, date: DAY, start: '10:15', end: '10:30' }, { doctorId: D2, branchId: BR2, date: DAY, start: '10:45', end: '11:00' },
    { doctorId: D1, branchId: BR1, date: NEXT, start: '11:00', end: '11:15' }, { doctorId: D1, branchId: BR1, date: NEXT, start: '12:00', end: '12:15' },
    // A shared session: 5 seats over 11:30–13:00.
    { doctorId: D1, branchId: BR1, date: NEXT, start: '11:30', end: '13:00', seats: 5 },
  ].map((s) => ({ seats: 1, ...s, taken: false }));
  // r40: Dr Kavya is busy elsewhere today and tomorrow 12:00–12:30 (the time only).
  const busy = [{ doctorId: D1, from: at(DAY, '12:00'), to: at(DAY, '12:30') }, { doctorId: D1, from: at(NEXT, '12:00'), to: at(NEXT, '12:30') }];
  // r40: the server leaves out a one-patient slot inside the doctor's busy time (a shared session stays).
  const busyAt = (s: { doctorId: string; date: string; start: string; end: string }) =>
    busy.some((x) => x.doctorId === s.doctorId && x.from < at(s.date, s.end) && x.to > at(s.date, s.start));
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
    const q = url.searchParams;
    if (sub === '/me') return ok(route, partner);
    if (sub === '/branches') return ok(route, branches);
    if (sub === '/catalogue') return ok(route, b.catalogue ?? []);
    if (sub === '/clinic/doctors') return ok(route, doctors);
    if (sub === '/clinic/slots') {
      return ok(route, slots.filter((s) => !s.taken && s.doctorId === q.get('doctorId') && s.branchId === q.get('branchId') && s.date === q.get('date')
        && !(s.seats === 1 && busyAt(s)))
        .map((s) => ({ slotId: slotId(s.doctorId, s.branchId, s.date, s.start), date: s.date, startTime: s.start, endTime: s.end, startsAt: at(s.date, s.start), seatsLeft: s.seats })));
    }
    // r40d: the clinic's lookup (the lab's shape).
    if (sub === '/clinic/patients/lookup' && method === 'POST') {
      if (b.noLookup) return json(route, 404, { error: 404, message: 'Not found' });
      if (!b.me.permissions.includes('bookings.manage') && b.me.role !== 'owner') return fail(route, 403, 'FORBIDDEN', 'You do not have permission');
      return ok(route, { exists: true, holderNameMasked: 'R*** K***' });
    }
    if (sub === '/clinic/appointments' && method === 'GET') {
      const from = q.get('from')!; const to = q.get('to')!; const doc = q.get('doctorId');
      const inDay = (iso: string) => iso >= at(from, '00:00') && iso < at(to, '23:59');
      return json(route, 200, { success: true, data: b.hideBookedRows ? [] : b.appts.filter((a) => !doc || a.doctorId === doc),
        busy: busy.filter((x) => (!doc || x.doctorId === doc) && inDay(x.from)) });
    }
    if (sub === '/clinic/appointments' && method === 'POST') {
      const x = body as { slotId: string; customer: { phone: string; name?: string }; patient?: { name: string; relation: string } };
      const s = slots.find((y) => slotId(y.doctorId, y.branchId, y.date, y.start) === x.slotId)!;
      if (s.seats === 1) s.taken = true;
      const doc = doctors.find((d) => d.doctorId === s.doctorId)!;
      const id = `9${++seq}`.padEnd(24, '0');
      const seen = x.patient ? x.patient.name : x.customer.name ?? '';
      const a = { bookingId: id, bookingDate: s.date.replace(/-/g, ''), bookingTime: s.start, status: 'confirmed', doctorId: s.doctorId, doctorName: doc.name,
        branchId: s.branchId, slotId: x.slotId, fee: doc.consultationFee, payAtClinic: true, source: 'desk', paidOnline: false, updatedAt: NOW.toISOString(),
        patient: x.patient ? { name: x.patient.name, relationship: x.patient.relation, accountName: x.customer.name, phone: x.customer.phone, dependentId: '5d'.repeat(12) }
          : { name: x.customer.name, phone: x.customer.phone, dependentId: null }, bill: null };
      b.appts.push(a);
      b.register.push({ kind: 'appointment', id, at: at(s.date, s.start), shortRef: null, patientName: seen, what: `${doc.name} · ${s.start}`,
        whatParts: { code: 'clinic.appointment', values: { doctor: doc.name, date: s.date, time: s.start, mode: 'in-person', source: 'desk' } }, amountMinor: doc.consultationFee * 100,
        paid: false, method: null, status: 'confirmed', madeOn: DAY, link: { kind: 'booking', id } });
      const { source: _s, paidOnline: _p, patient: _pt, bill: _b, ...view } = a;
      return ok(route, { booking: { ...view, dependentId: x.patient ? '5d'.repeat(12) : null }, customer: { userId: '98'.repeat(12), phone: x.customer.phone, created: false },
        patient: x.patient ? { dependentId: '5d'.repeat(12), name: x.patient.name, relationship: x.patient.relation } : null, replayed: false }, 201);
    }

    // ── r40: Today (the lab's shapes; a desk appointment's money is on its bill) ──
    if (sub === '/today' && method === 'GET') {
      if (b.todayForbidden) return fail(route, 403, 'FORBIDDEN', 'You do not have permission');
      const money = b.register.filter((r) => r.kind === 'bill');
      const paid = money.filter((r) => r.paid);
      const byMethod: Record<string, number> = { cash: 0, upi: 0, card: 0, bank: 0, wallet: 0, online: 0, other: 0 };
      for (const r of paid) byMethod[String(r.method)] = (byMethod[String(r.method)] ?? 0) + Number(r.amountMinor);
      const unbilled = b.appts.filter((a) => !a.bill).map((a) => String(a.bookingId));
      const list = [...b.register].sort((x, y) => String(y.at).localeCompare(String(x.at)));
      return ok(route, { date: DAY, items: list.slice(0, Number(q.get('limit') ?? 50)), nextCursor: null,
        totals: { collectedMinor: paid.reduce((n, r) => n + Number(r.amountMinor), 0), byMethod, unpaidMinor: money.filter((r) => !r.paid).reduce((n, r) => n + Number(r.amountMinor), 0),
          count: b.register.length },
        pending: { appointmentsToday: { count: b.appts.length, toCheckInCount: b.appts.filter((a) => a.bookingDate === '20261126').length, toConfirmCount: 0, toCheckInIds: [], toConfirmIds: [] },
          deskUnbilled: { count: unbilled.length, ids: unbilled }, unpaidBills: { count: b.bills.filter((x) => x.lifecycleState !== 'paid').length, ids: [] } } });
    }
    if (sub === '/todos' && method === 'GET') return ok(route, [], 200, { pagination: { nextCursor: null } });

    // ── bills (an appointment's, with the doctor's fee) ──
    if (sub === '/invoices' && method === 'POST') {
      const x = body as { branchId: string; appointmentId?: string; doctorId?: string; customer: Rec; items: Rec[]; idempotencyKey: string };
      const total = x.items.reduce((n, l) => n + (l.unitPriceMinor as number) * (l.qty as number), 0);
      const inv: Rec = { _id: `bb${String(b.bills.length + 1).padStart(22, '0')}`, partnerId: CLINIC, branchId: x.branchId, number: b.bills.length + 1, financialYear: '2627',
        serial: `SC/2627/000${b.bills.length + 1}`, documentKind: 'bill_of_supply', issuedAt: NOW.toISOString(), supplier: { name: 'Sunrise Clinic', address: '1 MG Rd', placeOfSupply: '27' },
        customer: x.customer, ...(x.appointmentId ? { appointmentId: x.appointmentId } : {}),
        items: x.items.map((l) => ({ ...l, discountMinor: 0, amountMinor: (l.unitPriceMinor as number) * (l.qty as number) })),
        totals: { subtotalMinor: total, discountMinor: 0, taxableMinor: total, cgstMinor: 0, sgstMinor: 0, igstMinor: 0, totalMinor: total, currency: 'INR' },
        lifecycleState: 'issued', lifecycleVersion: 0, paidMinor: 0, dueMinor: total, createdBy: b.me._id, idempotencyKey: x.idempotencyKey };
      b.bills.push(inv);
      const a = b.appts.find((y) => y.bookingId === x.appointmentId);
      if (a) a.bill = { invoiceId: inv._id, serial: inv.serial, number: inv.number, state: 'issued' };
      b.register.push({ kind: 'bill', id: inv._id, at: NOW.toISOString(), shortRef: inv.serial, patientName: String(x.customer.name), what: 'Consultation',
        whatParts: { code: 'bill.items', values: { first: String(x.items[0]?.description ?? ''), more: x.items.length - 1 } }, amountMinor: total, paid: false, method: null,
        status: 'issued', madeOn: DAY, link: { kind: 'invoice', id: inv._id }, appointmentId: x.appointmentId ?? null });
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
        Object.assign(b.register.find((r) => r.id === inv._id)!, { paid: true, method: x.splits[0]!.mode });
        // A desk appointment is paid when its bill is.
        Object.assign(b.register.find((r) => r.id === inv.appointmentId) ?? {}, { paid: true, method: x.splits[0]!.mode });
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
  await expect(page.getByRole('navigation', { name: 'What do you want to do?' })).toBeVisible();
}
const bigButtons = (page: Page) => page.getByRole('navigation', { name: 'What do you want to do?' });
const choices = (page: Page) => page.getByRole('navigation', { name: 'What does the patient need?' });
const whoIs = (page: Page) => page.getByRole('group', { name: 'Who is the patient?' });
const money = (page: Page) => page.getByRole('region', { name: 'Money of the day' });
const books = (b: Backend) => b.calls.filter((c) => c.method === 'POST' && c.path === '/partner-workspace/clinic/appointments').map((c) => c.body!);
const stored = (page: Page) => page.evaluate(() => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }) + location.href);
const noSidewaysScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
const taps = { n: 0 };
const tap = async (l: Locator) => { taps.n += 1; await l.click(); };

/** + New → the number → who → Next (the clinic desk has no lookup: the number is typed twice). */
async function newVisit(page: Page, who: { self: string } | { family: string; relation: string }) {
  await tap(bigButtons(page).getByRole('link', { name: '+ New' }));
  await page.getByLabel('Phone number or name').fill(PHONE);
  await tap(page.getByRole('button', { name: 'Find', exact: true }));
  // WQ57b (r40d): the clinic's lookup says whose number it is.
  await expect(page.getByText('This number is on Jansetu: R*** K***')).toBeVisible();
  if ('self' in who) {
    await tap(whoIs(page).getByRole('button', { name: 'This person' }));
    await page.getByLabel('Patient’s full name').fill(who.self);
  } else {
    await tap(whoIs(page).getByRole('button', { name: 'Someone else (family member)' }));
    await page.getByLabel('Family member’s full name').fill(who.family);
    await page.getByLabel('Relation to the phone’s owner').selectOption(who.relation);
    taps.n += 1;
  }
  await tap(page.getByRole('button', { name: 'Next', exact: true }));
}

/**
 * A walk-in with Dr Kavya paid in cash, then Today as one row. Returns the taps from + New to the recorded payment.
 * `branches`: how many in-clinic branches the member has (two: one is tapped).
 */
async function walkInWithKavya(page: Page, b: Backend, branches: 1 | 2) {
  await signIn(page);
  await expect(bigButtons(page).getByRole('link')).toHaveText(['+ New', 'Find patient', 'New bill', 'Today']);
  // The doctors today: Dr Kavya busy elsewhere at 12:00 (the time only).
  const doctorsToday = page.getByRole('region', { name: 'Doctors today' });
  await expect(doctorsToday.getByRole('list', { name: 'Today with Dr Kavya' })).toContainText('12:00–12:30 Busy');
  taps.n = 0;
  await newVisit(page, { self: 'Meena Iyer' });
  await expect(choices(page).getByRole('link')).toHaveText(['Appointment now (walk-in)', 'Appointment for later', 'Bill']);
  await tap(choices(page).getByRole('link', { name: 'Appointment now (walk-in)' }));
  // WQ57b: the page starts with the task (no desk heading).
  await expect(page.getByRole('heading', { name: 'Appointment now', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Front desk' })).toHaveCount(0);
  await expect(page.getByText(`Patient: Meena Iyer · ${PHONE}`)).toBeVisible();
  if (branches === 2) {
    // None is chosen for the clerk.
    const which = page.getByRole('group', { name: 'Which branch?' });
    await expect(which.getByRole('button', { pressed: true })).toHaveCount(0);
    await tap(which.getByRole('button', { name: /MG Road/ }));
  }
  // MG Road has one doctor today: chosen at once; the next free time is said plainly.
  await expect(page.getByRole('group', { name: 'Which doctor?' }).getByRole('button', { name: /Dr Kavya/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Next free: 10:15')).toBeVisible();
  await tap(page.getByRole('button', { name: 'Book Dr Kavya at 10:15, MG Road' }));
  // Straight to the short bill, with the doctor's fee on it.
  await expect(page.getByRole('heading', { name: 'New bill' })).toBeVisible();
  expect(books(b)[0]).toMatchObject({ slotId: slotId(D1, BR1, DAY, '10:15'), customer: { phone: PHONE, name: 'Meena Iyer' } });
  await expect(page.getByRole('list', { name: 'Items' })).toContainText('Consultation · Dr Kavya · ₹500.00');
  // The only line is not offered for removal; another one is "item" at a clinic.
  await expect(page.getByRole('list', { name: 'Items' }).getByRole('button', { name: /Remove/ })).toHaveCount(0);
  await expect(page.getByText('Add another item')).toBeVisible();
  await expect(page.getByRole('button', { name: /Not for this appointment/ })).toHaveCount(0);
  await tap(page.getByRole('button', { name: 'Issue bill for ₹500.00' }));
  await expect(page.getByText(/^Bill SC\/2627\/0001 issued\./)).toBeVisible();
  expect(b.calls.find((c) => c.method === 'POST' && c.path === '/partner-workspace/invoices')!.body).toMatchObject({
    appointmentId: b.appts[0]!.bookingId, customer: { name: 'Meena Iyer', phone: PHONE }, items: [{ description: 'Consultation · Dr Kavya', qty: 1, unitPriceMinor: 50000 , gstRate: 0, taxTreatment: 'exempt', sac: '9993' }] });
  const pay = page.getByRole('group', { name: 'Record payment' });
  await tap(pay.getByRole('button', { name: 'Cash', exact: true }));
  await tap(pay.getByRole('button', { name: 'Record ₹500.00 paid' }));
  await expect(page.getByText('Paid by Cash')).toBeVisible();
  const counted = taps.n;
  await page.getByRole('link', { name: 'Done', exact: true }).click();
  await bigButtons(page).getByRole('link', { name: 'Today' }).click();
  await expect(money(page).getByRole('paragraph')).toHaveText(['Collected today ₹500.00', 'Cash ₹500.00', 'To collect ₹0.00']);
  const rows = page.getByRole('list', { name: 'The day’s visits, sales and tests' }).getByRole('listitem');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Meena Iyer: Dr Kavya · 10:15');
  await expect(rows.first()).toContainText('Paid (cash)');
  await expect(page.getByText('1 item', { exact: true })).toBeVisible();
  expect(await stored(page)).not.toMatch(new RegExp(`${PHONE}|Meena`));
  expect(b.calls.some((c) => c.path.includes(PHONE) || c.path.includes('Meena'))).toBe(false);
  return counted;
}

test('a walk-in with Dr Kavya paid in cash: one Today row', async ({ page }) => {
  const b = await mockBackend(page);
  // Two in-clinic branches: one more tap to choose.
  expect(await walkInWithKavya(page, b, 2)).toBe(10);
});

test('an appointment for later never offers a time when the doctor is busy elsewhere', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await newVisit(page, { self: 'Meena Iyer' });
  await choices(page).getByRole('link', { name: 'Appointment for later' }).click();
  await page.getByRole('group', { name: 'Which branch?' }).getByRole('button', { name: /MG Road/ }).click();
  await page.getByRole('group', { name: 'Day' }).getByRole('button', { name: 'Tomorrow' }).click();
  const times = page.getByRole('group', { name: 'Free times' });
  // 12:00 (one patient) falls in Dr Kavya's busy time 12:00–12:30 and the server leaves it out; the shared 11:30–13:00 session
  // (5 seats) is still offered.
  await expect(times.getByRole('button')).toHaveText(['11:00', '11:30']);
  await expect(page.getByText('Times when the doctor is busy elsewhere are not shown.')).toBeVisible();
  await times.getByRole('button', { name: '11:30' }).click();
  b.hideBookedRows = true;
  await page.getByRole('button', { name: 'Book Dr Kavya at 11:30, MG Road' }).click();
  await expect(page.getByText('The appointment is booked. Its details could not be read yet.')).toBeVisible();
  await expect(page.getByText(/Make its bill with.*in the day list/)).toHaveCount(0);
  b.hideBookedRows = false;
  await page.getByRole('button', { name: 'Make the bill', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New bill' })).toBeVisible();
  expect(books(b)[0]).toMatchObject({ slotId: slotId(D1, BR1, NEXT, '11:30') });
  // Today names the appointment's day (it is not today's).
  await page.goto('/#/partner/today');
  await expect(page.getByRole('listitem').filter({ hasText: 'Meena Iyer' })).toContainText('Dr Kavya · Fri, 27 Nov · 11:30');
});

test('Find patient by name: today’s appointments (also one booked on an earlier day)', async ({ page }) => {
  const b = await mockBackend(page);
  b.catalogue = [
    { _id: 'ab'.repeat(12), kind: 'consultation', name: 'Consultation · Dr Kavyan', priceMinor: 50000, gstRate: 0, isActive: true },
    { _id: 'ac'.repeat(12), kind: 'consultation', name: 'Follow-up · Dr Kavya', priceMinor: 50000, gstRate: 0, isActive: true },
  ];
  b.appts.push({ bookingId: '81'.padEnd(24, '0'), bookingDate: '20261126', bookingTime: '10:30', status: 'confirmed', doctorId: D1, doctorName: 'Dr Kavya', branchId: BR1,
    fee: 500, payAtClinic: true, source: 'desk', paidOnline: false, patient: { name: 'Asha Rao', phone: '9800000001', dependentId: null }, bill: null });
  await signIn(page);
  await bigButtons(page).getByRole('link', { name: 'Find patient' }).click();
  await page.getByLabel('Phone number or name').fill('asha');
  await page.getByRole('button', { name: 'Find', exact: true }).click();
  await page.getByRole('button', { name: 'Asha Rao · 9800000001 · today 10:30, Dr Kavya' }).click();
  await expect(page.getByText('This number is on Jansetu: R*** K***')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Appointments today' })).toContainText('10:30 · Dr Kavya · Asha Rao');
  expect(b.calls.some((c) => c.path.includes('asha') || c.path.includes('9800000001'))).toBe(false);
  // WQ57c: an appointment not billed yet is billed from here: the short bill, linked to it, the fee on it.
  await page.getByRole('region', { name: 'Appointments today' }).getByRole('button', { name: 'Bill this appointment' }).click();
  await expect(page.getByRole('heading', { name: 'New bill' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Items' })).toContainText('Consultation · Dr Kavya · ₹500.00');
  await expect(page.getByRole('list', { name: 'Items' })).not.toContainText('Dr Kavyan');
  await expect(page.getByRole('list', { name: 'Items' })).not.toContainText('Follow-up');
  await page.getByRole('button', { name: 'Issue bill for ₹500.00' }).click();
  expect(b.calls.find((c) => c.method === 'POST' && c.path === '/partner-workspace/invoices')!.body).toMatchObject({
    appointmentId: '81'.padEnd(24, '0'), customer: { name: 'Asha Rao', phone: '9800000001' } });
});

test('the fee stays hand-written when no consultation item names this doctor (a follow-up, another doctor’s)', async ({ page }) => {
  const b = await mockBackend(page);
  const item = (id: string, name: string): Rec => ({ _id: id.repeat(12), partnerId: CLINIC, kind: 'consultation', name, priceMinor: 50000, gstRate: 0, isActive: true, adminDisabled: false });
  b.catalogue = [item('e1', 'Follow-up consultation'), item('e2', 'Consultation · Dr Rao')];
  await signIn(page);
  await newVisit(page, { self: 'Meena Iyer' });
  await choices(page).getByRole('link', { name: 'Appointment now (walk-in)' }).click();
  await page.getByRole('group', { name: 'Which branch?' }).getByRole('button', { name: /MG Road/ }).click();
  await page.getByRole('button', { name: 'Book Dr Kavya at 10:15, MG Road' }).click();
  await expect(page.getByRole('list', { name: 'Items' })).toHaveText(/^Consultation · Dr Kavya · ₹500\.00$/);
  // In a visit the receipt points to no list row: the buttons are the way.
  await expect(page.getByText('Create bill', { exact: false })).toHaveCount(0);
});

/** WQ58b: a walk-in with Dr Kavya at MG Road, straight to the short bill. */
async function walkInBill(page: Page) {
  await signIn(page);
  await newVisit(page, { self: 'Meena Iyer' });
  await choices(page).getByRole('link', { name: 'Appointment now (walk-in)' }).click();
  await page.getByRole('group', { name: 'Which branch?' }).getByRole('button', { name: /MG Road/ }).click();
  await page.getByRole('button', { name: 'Book Dr Kavya at 10:15, MG Road' }).click();
  await expect(page.getByRole('heading', { name: 'New bill' })).toBeVisible();
}
const billLine = (b: Backend) => ((b.calls.find((c) => c.method === 'POST' && c.path === '/partner-workspace/invoices')!.body as Rec).items as Rec[])[0]!;

test('WQ58b: at a GST-registered clinic the fee is exempt (SAC 9993) unless the clerk chooses Charge GST', async ({ page }) => {
  const b = await mockBackend(page, owner, { regular: true });
  await walkInBill(page);
  const items = page.getByRole('list', { name: 'Items' });
  await expect(items).toContainText('Consultation · Dr Kavya · ₹500.00');
  await items.getByRole('button', { name: 'Charge GST' }).click();
  await expect(items.getByLabel('GST rate')).toHaveValue('18');
  await expect(page.getByRole('button', { name: 'Issue bill for ₹590.00' })).toBeVisible();
  await items.getByRole('button', { name: 'Exempt from GST' }).click();
  await expect(items.getByLabel('GST rate')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Issue bill for ₹500.00' })).toBeVisible();
  await items.getByRole('button', { name: 'Charge GST' }).click();
  await page.getByRole('button', { name: 'Issue bill for ₹590.00' }).click();
  await expect(page.getByText(/^Bill SC\/2627\/0001 issued\./)).toBeVisible();
  expect(billLine(b)).toMatchObject({ description: 'Consultation · Dr Kavya', unitPriceMinor: 50000, gstRate: 18, sac: '9993' });
  expect(billLine(b)).not.toHaveProperty('taxTreatment');
});

test('WQ58b: a consultation item naming the doctor with no treatment (before r42) keeps the fee exempt', async ({ page }) => {
  const b = await mockBackend(page, owner, { regular: true });
  b.catalogue = [{ _id: 'e3'.repeat(12), partnerId: CLINIC, kind: 'consultation', name: 'Consultation · Dr Kavya', priceMinor: 50000, gstRate: 0, isActive: true, adminDisabled: false }];
  await walkInBill(page);
  await page.getByRole('button', { name: 'Issue bill for ₹500.00' }).click();
  await expect(page.getByText(/^Bill SC\/2627\/0001 issued\./)).toBeVisible();
  expect(billLine(b)).toEqual({ catalogItemId: 'e3'.repeat(12), description: 'Consultation · Dr Kavya', sac: '9993', qty: 1, unitPriceMinor: 50000, gstRate: 0, taxTreatment: 'exempt' });
});

test('a server without the clinic lookup yet (404): + New goes on, the number typed twice', async ({ page }) => {
  const b = await mockBackend(page);
  b.noLookup = true;
  await signIn(page);
  await bigButtons(page).getByRole('link', { name: '+ New' }).click();
  await page.getByLabel('Phone number or name').fill(PHONE);
  await page.getByRole('button', { name: 'Find', exact: true }).click();
  await whoIs(page).getByRole('button', { name: 'This person' }).click();
  await expect(page.getByText(/This number is (on|new to) Jansetu/)).toHaveCount(0);
  await page.getByLabel('Patient’s full name').fill('Meena Iyer');
  await page.getByLabel('Type the number again').fill(PHONE);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(choices(page).getByRole('link', { name: 'Appointment now (walk-in)' })).toBeVisible();
  expect(b.calls.filter((c) => c.path.endsWith('/clinic/patients/lookup'))).toHaveLength(1);
});

test('a family member: Ravi on his mother’s number; the bill names the phone’s owner, asked once', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await newVisit(page, { family: 'Ravi', relation: 'Son' });
  await choices(page).getByRole('link', { name: 'Appointment now (walk-in)' }).click();
  await page.getByRole('group', { name: 'Which branch?' }).getByRole('button', { name: /MG Road/ }).click();
  await page.getByRole('button', { name: 'Book Dr Kavya at 10:15, MG Road' }).click();
  expect(books(b)[0]).toMatchObject({ customer: { phone: PHONE }, patient: { name: 'Ravi', relation: 'Son' } });
  const name = page.getByLabel('Name on the bill');
  await expect(name).toHaveValue('');
  await page.getByRole('button', { name: 'Issue bill for ₹500.00' }).click();
  await expect(page.getByText('Enter the customer’s name.').first()).toBeVisible();
  await name.fill('Rekha Iyer');
  await page.getByRole('button', { name: 'Issue bill for ₹500.00' }).click();
  await expect(page.getByText(/^Bill SC\/2627\/0001 issued\./)).toBeVisible();
  expect(b.calls.find((c) => c.method === 'POST' && c.path === '/partner-workspace/invoices')!.body).toMatchObject({ customer: { name: 'Rekha Iyer', phone: PHONE } });
});

test('a branch-limited member: only their branch and its doctors; the partner-wide pages stay hidden', async ({ page }) => {
  const b = await mockBackend(page, staff([BR2], 'bookings.view', 'bookings.manage', 'invoices.create', 'payments.record'));
  await signIn(page);
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Finance' })).toHaveCount(0);
  await newVisit(page, { self: 'Meena Iyer' });
  await choices(page).getByRole('link', { name: 'Appointment now (walk-in)' }).click();
  // Aundh only (no branch to choose); both doctors see patients there.
  await expect(page.getByLabel('Branch')).toHaveCount(0);
  await page.getByRole('group', { name: 'Which doctor?' }).getByRole('button', { name: /Dr Rao/ }).click();
  await page.getByRole('button', { name: 'Book Dr Rao at 10:45, Aundh' }).click();
  await expect(page.getByRole('heading', { name: 'New bill' })).toBeVisible();
  expect(books(b)[0]).toMatchObject({ slotId: slotId(D2, BR2, DAY, '10:45') });
});

test('a member without billing permission: no New bill, no Bill, the booking ends with Done; one allowed none of it is told to ask the owner', async ({ page }) => {
  const b = await mockBackend(page, staff([], 'bookings.view', 'bookings.manage'));
  await signIn(page);
  await expect(bigButtons(page).getByRole('link')).toHaveText(['+ New', 'Find patient', 'Today']);
  await newVisit(page, { self: 'Meena Iyer' });
  await expect(choices(page).getByRole('link')).toHaveText(['Appointment now (walk-in)', 'Appointment for later']);
  await choices(page).getByRole('link', { name: 'Appointment now (walk-in)' }).click();
  await page.getByRole('group', { name: 'Which branch?' }).getByRole('button', { name: /MG Road/ }).click();
  await page.getByRole('button', { name: 'Book Dr Kavya at 10:15, MG Road' }).click();
  // The receipt names the server's patient (the booked row read back).
  await expect(page.getByText(/Booked/).first()).toContainText('Meena Iyer');
  await expect(page.getByRole('heading', { name: 'New bill' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Done', exact: true }).click();
  // The waiting work: one to check in, one walk-in without a bill.
  await expect(page.getByText('1 to check in')).toBeVisible();
  await expect(page.getByText('1 walk-in without a bill')).toBeVisible();
  // Allowed none of it: said plainly, with nothing to try again.
  b.me = staff([], 'staff.manage');
  b.todayForbidden = true;
  await page.reload();
  await expect(page.getByText('To book appointments or make bills here, ask the clinic owner to allow them.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
});

test.describe('on a short 390 × 667 phone', () => {
  test.use({ viewport: { width: 390, height: 667 }, hasTouch: true });
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop', 'the phone size runs once'));

  test('the visit’s one action is in sight without scrolling', async ({ page }) => {
    await mockBackend(page);
    await signIn(page);
    await newVisit(page, { self: 'Meena Iyer' });
    await choices(page).getByRole('link', { name: 'Appointment now (walk-in)' }).click();
    await page.getByRole('group', { name: 'Which branch?' }).getByRole('button', { name: /MG Road/ }).click();
    await expect(page.getByRole('button', { name: 'Book Dr Kavya at 10:15, MG Road' })).toBeInViewport();
    await noSidewaysScroll(page);
  });
});

test.describe('on a 390 px phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop', 'the phone size runs once'));

  test('a walk-in with Dr Kavya paid in cash on a phone in 9 taps (a clerk at one branch)', async ({ page }) => {
    const b = await mockBackend(page, staff([BR1], ...ALL));
    expect(await walkInWithKavya(page, b, 1)).toBe(9);
    await noSidewaysScroll(page);
  });

  test('a family member on a phone', async ({ page }) => {
    const b = await mockBackend(page);
    await signIn(page);
    await newVisit(page, { family: 'Ravi', relation: 'Son' });
    await choices(page).getByRole('link', { name: 'Appointment now (walk-in)' }).click();
    await expect(page.getByText('Patient: Ravi (son of R*** K***)')).toBeVisible();
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.ws-main')!).fontSize)).toBe('17px');
    await noSidewaysScroll(page);
    expect(b.calls.some((c) => c.path.includes(PHONE))).toBe(false);
  });
});
