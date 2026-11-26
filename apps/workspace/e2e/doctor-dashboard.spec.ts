import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * WQ56 (P2): the doctor's single dashboard against a mocked backend r39 (§26.23, stage fe9c21f2): Dr Arjun with his own
 * clinic (Dr Arjun Skin Clinic), Thursdays at Demo Care Clinic, and video on the app. One time-ordered list of today's
 * appointments from every source with chips; + New → a clinic appointment at Demo Care (it joins the list); an online
 * consultation waiting for the patient's payment in the app; billing his own clinic from the dashboard; a doctor who owns
 * no clinic has no Bills; his private to-dos. Desktop, tablet and a 390 px phone.
 */
const DOC = 'd0'.repeat(12);
const OWN = 'a1'.repeat(12);
const DEMO = 'a2'.repeat(12);
const OWNBR = 'c1'.repeat(12);
const DEMOBR = 'c2'.repeat(12);
const S_OWN = 'e1'.repeat(12);
const S_DEMO = 'e2'.repeat(12);
const S_ONLINE = 'e3'.repeat(12);
const PHONE = '9876543210';
const DAY = '2026-11-27';
const YMD = '20261127';
/** Friday 27 Nov 2026, 10:00 in India. */
const NOW = new Date('2026-11-27T04:30:00.000Z');
const bid = (n: number) => `b${String(n).padStart(3, '0')}`.padEnd(24, '9');

type Rec = Record<string, unknown>;
interface Backend {
  calls: { method: string; path: string; body: Rec | null }[];
  live: boolean;
  owner: boolean;
  rows: (Rec & { name: string })[];
  todos: Rec[];
  bills: Rec[];
}

const at = (time: string) => new Date(`${DAY}T${time}:00+05:30`).toISOString();
function row(n: number, time: string, name: string, o: Rec): Rec & { name: string } {
  return { _id: bid(n), name, bookingType: 'consultation', bookingKind: 'scheduled', bookingDate: YMD, bookingTime: time, consultationMode: 'video', status: 'confirmed',
    paymentStatus: 'paid', price: 700, settlementSystem: 'ledger', source: 'self', clinic: null, channel: 'online', createdAt: NOW.toISOString(), ...o };
}

async function mockBackend(page: Page, o: { owner?: boolean } = {}): Promise<Backend> {
  await page.clock.setFixedTime(NOW);
  const b: Backend = { calls: [], live: false, owner: o.owner !== false, todos: [], bills: [], rows: [
    row(1, '10:30', 'Ravi Demo', { source: 'clinic_desk', consultationMode: 'in-person', clinicDesk: { partnerId: OWN, branchId: OWNBR }, clinic: { id: OWN, name: 'Dr Arjun Skin Clinic' },
      channel: 'clinic', paymentStatus: 'pending', settlementSystem: 'clinic' }),
    row(2, '11:30', 'Meera Demo', {}),
    row(3, '15:00', 'Lata Demo', { source: 'clinic_desk', consultationMode: 'in-person', clinicDesk: { partnerId: DEMO, branchId: DEMOBR }, clinic: { id: DEMO, name: 'Demo Care Clinic' },
      channel: 'clinic', paymentStatus: 'pending', settlementSystem: 'clinic' }),
    row(4, '16:00', 'Imran Demo', { source: 'pharmacy_assisted', paidBy: 'Demo Pharmacy' }),
  ] };
  const profile = { _id: DOC, name: 'Dr Arjun Demo', specialization: 'Dermatologist', consultationFee: 700, phone: '9000000004', isActive: true, isVerified: true };
  const clinics = () => ({ invites: [], clinics: [
    ...(b.owner ? [{ partnerId: OWN, name: 'Dr Arjun Skin Clinic', solo: true, verified: true, role: 'owner', branches: [{ branchId: OWNBR, name: 'Main' }] }] : []),
    { partnerId: DEMO, name: 'Demo Care Clinic', solo: false, verified: true, role: 'staff', branches: [{ branchId: DEMOBR, name: 'Baner' }] },
  ] });
  const practice = () => (b.owner ? { partner: { _id: OWN, kind: 'clinic', name: 'Dr Arjun Skin Clinic', taxRegime: 'unregistered', verification: { state: 'verified' },
    invoiceSeries: { prefix: 'DSKIN' }, isActive: true }, branches: [{ _id: OWNBR, partnerId: OWN, name: 'Main', isActive: true,
    address: { line1: '1 FC Rd', city: 'Pune', state: 'Maharashtra', stateCode: '27', pincode: '411004' }, services: { inClinic: true } }] } : null);
  const slots = [
    { _id: S_OWN, date: YMD, startTime: '12:00', endTime: '12:15', maxBookings: 1, currentBookings: 0, isAvailable: true, isActive: true, branchId: OWNBR, serviceModes: ['in-person'] },
    { _id: S_DEMO, date: YMD, startTime: '17:00', endTime: '17:15', maxBookings: 1, currentBookings: 0, isAvailable: true, isActive: true, branchId: DEMOBR, serviceModes: ['in-person'] },
    { _id: S_ONLINE, date: YMD, startTime: '13:00', endTime: '13:15', maxBookings: 1, currentBookings: 0, isAvailable: true, isActive: true, serviceModes: ['video', 'call'] },
  ];
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const ok = (route: Route, data: unknown, status = 200, extra: Rec = {}) => json(route, status, { success: true, data, ...extra });
  const fail = (route: Route, status: number, code: string, message: string) => json(route, status, { error: status, code, message });
  const listed = () => [...b.rows].sort((x, y) => String(x.bookingTime).localeCompare(String(y.bookingTime))).map(({ name: _n, ...r }) => r);
  const register = () => [...b.rows].sort((x, y) => String(x.bookingTime).localeCompare(String(y.bookingTime))).map((r) => ({
    kind: 'appointment', id: r._id, at: at(String(r.bookingTime)), shortRef: null, patientName: r.name, what: 'Dr Arjun Demo', whatParts: { code: 'consult.scheduled',
      values: { doctor: 'Dr Arjun Demo', time: r.bookingTime, mode: r.consultationMode } }, amountMinor: Number(r.price) * 100, paid: r.paymentStatus === 'paid', method: null,
    status: r.status, madeOn: DAY, paidToday: false, link: { kind: 'booking', id: r._id }, source: r.source, channel: r.channel, clinic: r.clinic }));
  let seq = 10;
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = req.method();
    const body = ['POST', 'PUT', 'PATCH'].includes(method) && req.postData() ? (req.postDataJSON() as Rec) : null;
    if (path === '/auth/session/refresh') {
      if (!b.live) return fail(route, 401, 'SESSION_ENDED', 'Please sign in again');
      return ok(route, { token: 't1', expiresIn: 900, principal: { userId: DOC, userType: 'specialist', sid: 's1' } });
    }
    if (path.startsWith('/auth/session')) return ok(route, {});
    b.calls.push({ method, path: `${path}${url.search}`, body });
    if (path === '/auth/specialist/send') return ok(route, undefined);
    if (path === '/auth/specialist/verify') { b.live = true; return ok(route, { token: 't1', expiresIn: 900, user: {} }); }
    if (req.headers().authorization !== 'Bearer t1') return fail(route, 401, 'UNAUTHORIZED', 'Authentication is required');
    if (path === '/auth/profile') return ok(route, { user: profile, userRole: 'specialist' });
    const me = /^\/specialists\/me(\/.*)?$/.exec(path);
    if (!me) return ok(route, []);
    const p = me[1] ?? '';
    if (p === '/profile') return ok(route, profile);
    if (p === '/presence') return ok(route, { doctorId: DOC, eligible: true, available: false, modes: [], instantFeeMinor: 70_000, presenceVersion: 0, feeConfigured: true,
      lastSeenAt: null, heartbeatExpired: true, busy: false, busyUntil: null, online: false });
    if (p === '/instant/offers') return ok(route, []);
    if (p === '/clinics') return ok(route, clinics());
    if (p === '/practice' || (p === '/clinic' && method === 'GET')) return ok(route, practice());
    if (p === '/slots') return ok(route, slots.filter((s) => !b.rows.some((r) => r.slotId === s._id)));
    if (p === '/appointments/list') return ok(route, listed(), 200, { meta: { total: b.rows.length, truncated: false } });
    if (p === '/appointments' && method === 'GET') return ok(route, listed());
    if (p === '/today' && method === 'GET') {
      const paid = b.bills.filter((x) => x.lifecycleState === 'paid');
      return ok(route, { date: DAY, items: register(), nextCursor: null,
        totals: { collectedMinor: paid.reduce((n, x) => n + Number(x.paidMinor), 0), byMethod: { cash: paid.reduce((n, x) => n + Number(x.paidMinor), 0) },
          unpaidMinor: b.bills.filter((x) => x.lifecycleState !== 'paid').reduce((n, x) => n + Number(x.dueMinor), 0), count: b.rows.length, earnedMinor: 50_000 },
        pending: { prescriptionsToWrite: { count: 1, ids: [bid(9)] }, appointmentsToConfirm: { count: 0, ids: [], awaitingPaymentCount: 0 }, reportsReady: { count: 0, ids: [] },
          ...(b.owner ? { unpaidBills: { count: 0, ids: [] } } : {}) } });
    }
    if (p === '/patients/lookup') return ok(route, { exists: true, holderNameMasked: 'A*** D***' });
    if (p === '/clinic-appointments' && method === 'POST') {
      const x = body as { clinicId: string; branchId?: string; slotId: string; customer: { phone: string; name?: string } };
      const s = slots.find((y) => y._id === x.slotId)!;
      const id = bid(++seq);
      const name = x.clinicId === DEMO ? 'Demo Care Clinic' : 'Dr Arjun Skin Clinic';
      b.rows.push(row(seq, s.startTime, x.customer.name ?? 'Patient', { _id: id, slotId: s._id, source: 'clinic_desk', consultationMode: 'in-person',
        clinicDesk: { partnerId: x.clinicId, branchId: s.branchId }, clinic: { id: x.clinicId, name }, channel: 'clinic', paymentStatus: 'pending', settlementSystem: 'clinic' }));
      return ok(route, { booking: { bookingId: id, bookingDate: YMD, bookingTime: s.startTime, status: 'confirmed', doctorId: DOC, branchId: s.branchId, fee: 700, payAtClinic: true },
        customer: { userId: 'u1'.repeat(12), phone: x.customer.phone, created: false }, patient: null, replayed: false }, 201);
    }
    if (p === '/consultations' && method === 'POST') {
      const x = body as { slotId: string; mode: string; customer: { phone: string; name?: string } };
      const s = slots.find((y) => y._id === x.slotId)!;
      const id = bid(++seq);
      b.rows.push(row(seq, s.startTime, x.customer.name ?? 'Patient', { _id: id, slotId: s._id, source: 'doctor_assisted', consultationMode: x.mode, status: 'pending', paymentStatus: 'pending' }));
      return ok(route, { booking: { bookingId: id, bookingDate: YMD, bookingTime: s.startTime, status: 'pending', paymentStatus: 'pending', consultationMode: x.mode, fee: 700,
        source: 'doctor_assisted', dependentId: null, followUpOf: null }, payment: { by: 'patient_app', required: true, payBy: new Date(NOW.getTime() + 30 * 60_000).toISOString() },
        replayed: false }, 201);
    }
    if (p === '/todos' && method === 'GET') return ok(route, [...b.todos].reverse(), 200, { pagination: { nextCursor: null } });
    if (p === '/todos' && method === 'POST') {
      const todo = { _id: `7${b.todos.length}`.padStart(24, '0'), text: body!.text, done: false, version: 1, createdBy: { kind: 'doctor', id: DOC, name: 'Dr Arjun Demo' } };
      b.todos.push(todo);
      return ok(route, { todo, replayed: false }, 201);
    }
    // ── r39: his own clinic's catalogue and bills (the workspace's routes) ──
    if (p.startsWith('/clinic/')) {
      if (!b.owner) return fail(route, 404, 'CLINIC_NOT_FOUND', 'Clinic not found');
      const sub = p.slice('/clinic'.length);
      if (sub === '/catalogue') return ok(route, []);
      if (sub === '/invoices' && method === 'GET') return ok(route, b.bills, 200, { pagination: { total: b.bills.length, nextCursor: null } });
      if (sub === '/invoices' && method === 'POST') {
        const x = body as { branchId: string; appointmentId?: string; customer: Rec; items: Rec[]; idempotencyKey: string; doctorId?: string };
        const total = x.items.reduce((n, l) => n + (l.unitPriceMinor as number) * (l.qty as number), 0);
        const inv = { _id: `bb${String(b.bills.length + 1).padStart(22, '0')}`, partnerId: OWN, branchId: x.branchId, number: b.bills.length + 1, financialYear: '2627',
          serial: `DSKIN/2627/000${b.bills.length + 1}`, documentKind: 'bill_of_supply', issuedAt: NOW.toISOString(), supplier: { name: 'Dr Arjun Skin Clinic', address: '1 FC Rd', placeOfSupply: '27' },
          customer: x.customer, ...(x.appointmentId ? { appointmentId: x.appointmentId } : {}), doctorId: x.doctorId,
          items: x.items.map((l) => ({ ...l, discountMinor: 0, amountMinor: (l.unitPriceMinor as number) * (l.qty as number) })),
          totals: { subtotalMinor: total, discountMinor: 0, taxableMinor: total, cgstMinor: 0, sgstMinor: 0, igstMinor: 0, totalMinor: total, currency: 'INR' },
          lifecycleState: 'issued', lifecycleVersion: 0, paidMinor: 0, dueMinor: total, createdBy: DOC, idempotencyKey: x.idempotencyKey };
        b.bills.push(inv);
        return ok(route, inv, 201);
      }
      const bill = /^\/invoices\/([0-9a-f]{24})(\/pay)?$/.exec(sub);
      if (bill) {
        const inv = b.bills.find((y) => y._id === bill[1])!;
        if (bill[2]) {
          const x = body as { splits: { mode: string; amountMinor: number }[]; requestKey: string };
          Object.assign(inv, { lifecycleState: 'paid', lifecycleVersion: 1, paidMinor: inv.dueMinor, dueMinor: 0 });
          const e = { _id: 'ev1', invoiceId: inv._id, version: 1, at: NOW.toISOString(), by: DOC, byKind: 'member', kind: 'payment', mode: x.splits[0]!.mode,
            amountMinor: x.splits[0]!.amountMinor, splits: x.splits, requestKey: x.requestKey };
          inv.events = [e];
          return ok(route, { invoice: { ...inv }, event: e });
        }
        const { events, ...rest } = inv;
        return ok(route, { invoice: rest, events: events ?? [] });
      }
    }
    return fail(route, 404, 'NOT_FOUND', 'Not found');
  });
  return b;
}

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Doctor', { exact: true }).check();
  await page.getByLabel('Mobile number').fill('9000000004');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Today’s appointments' })).toBeVisible();
}
const bigButtons = (page: Page) => page.getByRole('navigation', { name: 'What do you want to do?' });
const chips = (page: Page) => page.getByRole('group', { name: 'Which appointments' });
const list = (page: Page) => page.getByRole('list', { name: 'Today’s appointments' });
const stored = (page: Page) => page.evaluate(() => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }) + location.href);
const noSidewaysScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
const shot = (page: Page, name: string) => page.screenshot({ path: `/tmp/wq56-shots/${name}-${test.info().project.name}.png`, fullPage: true });

/** + New → the number → This person (a name) → Next. */
async function newVisit(page: Page, name: string) {
  await bigButtons(page).getByRole('link', { name: '+ New' }).click();
  await page.getByLabel('Patient’s mobile number').fill(PHONE);
  await page.getByRole('button', { name: 'Find', exact: true }).click();
  await expect(page.getByText('This number is on Jansetu: A*** D***')).toBeVisible();
  await page.getByRole('group', { name: 'Who is the patient?' }).getByRole('button', { name: 'This person' }).click();
  await page.getByLabel('Patient’s full name').fill(name);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
}

test('one list of today from every source, in time order, with chips: All, each clinic, Online, Booked by partners', async ({ page }) => {
  await mockBackend(page);
  await signIn(page);
  await expect(bigButtons(page).getByRole('link')).toHaveText(['+ New', 'Find patient', 'Today', 'Bills']);
  await expect(page.getByText('Earned today ₹500.00')).toBeVisible();
  await expect(page.getByRole('link', { name: '1 prescription to write' })).toBeVisible();
  await expect(chips(page).getByRole('button')).toHaveText(['All', 'Dr Arjun Skin Clinic', 'Demo Care Clinic', 'Online', 'Booked by partners']);
  await expect(list(page).getByRole('listitem')).toHaveCount(4);
  await expect(list(page).getByRole('listitem').nth(0)).toContainText('10:30Ravi DemoIn personDr Arjun Skin Clinic desk');
  await expect(list(page).getByRole('listitem').nth(1)).toContainText('Meera DemoVideoBooked in the app');
  await expect(list(page).getByRole('listitem').nth(2)).toContainText('Lata DemoIn personDemo Care Clinic desk');
  await expect(list(page).getByRole('listitem').nth(3)).toContainText('Imran DemoVideoBooked by Demo Pharmacy');
  await shot(page, 'home');
  await chips(page).getByRole('button', { name: 'Demo Care Clinic' }).click();
  await expect(list(page).getByRole('listitem')).toHaveText([/Lata Demo/]);
  await chips(page).getByRole('button', { name: 'Online' }).click();
  await expect(list(page).getByRole('listitem')).toHaveText([/Meera Demo/, /Imran Demo/]);
  await chips(page).getByRole('button', { name: 'Booked by partners' }).click();
  await expect(list(page).getByRole('listitem')).toHaveText([/Imran Demo/]);
  await expect(chips(page).getByRole('button', { name: 'Booked by partners' })).toHaveAttribute('aria-pressed', 'true');
  // 17 px text and 48 px targets.
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.simple')!).fontSize)).toBe('17px');
  for (const box of await Promise.all((await chips(page).getByRole('button').all()).map((x) => x.boundingBox()))) expect(box!.height).toBeGreaterThanOrEqual(48);
});

test('+ New → a clinic appointment at Demo Care: chosen clinic, his free time there, booked as its desk appointment, and in his list', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await newVisit(page, 'Asha Demo');
  await page.getByRole('navigation', { name: 'What does the patient need?' }).getByRole('link', { name: 'Clinic appointment' }).click();
  await expect(page.getByText('Patient: Asha Demo · 9876543210')).toBeVisible();
  await page.getByRole('group', { name: 'Which clinic?' }).getByRole('button', { name: 'Demo Care Clinic' }).click();
  // Only his time at Demo Care is offered (not his own clinic's or the online one).
  await expect(page.getByRole('group', { name: 'Free times' }).getByRole('button')).toHaveText(['17:00']);
  await page.getByRole('group', { name: 'Free times' }).getByRole('button', { name: '17:00' }).click();
  await shot(page, 'clinic-appointment');
  await page.getByRole('button', { name: 'Book 17:00 on Fri, 27 Nov, 2026 at Demo Care Clinic' }).click();
  await expect(page.getByText('Booked: Asha Demo · 9876543210 at Demo Care Clinic on Fri, 27 Nov, 2026 at 17:00')).toBeVisible();
  await expect(page.getByText('It is in Demo Care Clinic’s reception list. The patient pays at the clinic.')).toBeVisible();
  // Another clinic's appointment is billed by its reception, not here.
  await expect(page.getByRole('button', { name: 'Make the bill' })).toHaveCount(0);
  const sent = b.calls.find((c) => c.method === 'POST' && c.path === '/specialists/me/clinic-appointments')!.body!;
  expect(sent).toMatchObject({ clinicId: DEMO, branchId: DEMOBR, slotId: S_DEMO, customer: { phone: PHONE, name: 'Asha Demo' } });
  expect(String(sent.requestKey)).toMatch(/^[A-Za-z0-9_-]{8,}$/);
  await page.getByRole('link', { name: 'Home', exact: true }).first().click();
  await expect(list(page).getByRole('listitem').last()).toContainText('17:00Asha DemoIn personDemo Care Clinic desk');
  expect(await stored(page)).not.toContain(PHONE);
  expect(await stored(page)).not.toContain('Asha');
});

test('an online consultation: the patient pays in the Jansetu app within 30 minutes; the list says it waits for that payment', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await newVisit(page, 'Meena Demo');
  await page.getByRole('navigation', { name: 'What does the patient need?' }).getByRole('link', { name: 'Online consultation (video or call)' }).click();
  await expect(page.getByText('The patient pays in the Jansetu app within 30 minutes.')).toBeVisible();
  // No consultation type is chosen for him.
  await expect(page.getByRole('group', { name: 'Video or phone call?' }).getByRole('button', { pressed: true })).toHaveCount(0);
  await page.getByRole('group', { name: 'Video or phone call?' }).getByRole('button', { name: 'Video' }).click();
  await expect(page.getByRole('group', { name: 'Free times' }).getByRole('button')).toHaveText(['13:00']);
  await page.getByRole('group', { name: 'Free times' }).getByRole('button', { name: '13:00' }).click();
  await page.getByRole('button', { name: 'Book Video at 13:00 on Fri, 27 Nov, 2026' }).click();
  await expect(page.getByText('Booked: Meena Demo · 9876543210, Video, on Fri, 27 Nov, 2026 at 13:00')).toBeVisible();
  await expect(page.getByText(/The patient pays in the Jansetu app by .*If not paid by then, the booking ends and the time is free again\./)).toBeVisible();
  await shot(page, 'online-consultation');
  expect(b.calls.find((c) => c.method === 'POST' && c.path === '/specialists/me/consultations')!.body).toMatchObject({ slotId: S_ONLINE, mode: 'video', customer: { phone: PHONE, name: 'Meena Demo' } });
  await page.getByRole('link', { name: 'Home', exact: true }).first().click();
  const r = list(page).getByRole('listitem').filter({ hasText: 'Meena Demo' });
  await expect(r).toContainText('Booked by you');
  await expect(r).toContainText('Waiting for the patient to pay in the app');
});

test('he bills his own clinic from the dashboard: the short bill with his fee, paid in cash; Bills opens its bills', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  // Only his own clinic's appointment has Bill (Demo Care's reception bills its own).
  await expect(list(page).getByRole('button', { name: 'Bill' })).toHaveCount(1);
  await list(page).getByRole('listitem').filter({ hasText: 'Ravi Demo' }).getByRole('button', { name: 'Bill' }).click();
  await expect(page.getByRole('heading', { name: 'New bill' })).toBeVisible();
  await page.getByRole('button', { name: 'Issue bill for ₹700.00' }).click();
  await expect(page.getByText(/^Bill DSKIN\/2627\/0001 issued\./)).toBeVisible();
  expect(b.calls.find((c) => c.method === 'POST' && c.path === '/specialists/me/clinic/invoices')!.body).toMatchObject({
    appointmentId: bid(1), branchId: OWNBR, customer: { name: 'Ravi Demo' }, items: [{ description: 'Consultation · Dr Arjun Demo', unitPriceMinor: 70000, qty: 1 }] });
  const pay = page.getByRole('group', { name: 'Record payment' });
  await pay.getByRole('button', { name: 'Cash', exact: true }).click();
  await pay.getByRole('button', { name: 'Record ₹700.00 paid' }).click();
  await expect(page.getByText('Paid by Cash')).toBeVisible();
  await shot(page, 'own-clinic-bill');
  expect(b.calls.find((c) => c.path.endsWith('/pay'))!.path).toBe('/specialists/me/clinic/invoices/bb0000000000000000000001/pay');
  // No partner workspace route, no sign-out.
  expect(b.calls.some((c) => c.path.startsWith('/partner-workspace') || c.path.startsWith('/auth/partner'))).toBe(false);
  await page.goto('/#/');
  await bigButtons(page).getByRole('link', { name: 'Bills' }).click();
  await expect(page.getByRole('heading', { name: 'Bills', level: 1 })).toBeVisible();
  await expect(page.getByText('DSKIN/2627/0001')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out and open my clinic’s workspace' })).toHaveCount(0);
});

test('a doctor who owns no clinic: no Bills button, no Bill on rows, and Doctor › Bills says so', async ({ page }) => {
  await mockBackend(page, { owner: false });
  await signIn(page);
  await expect(bigButtons(page).getByRole('link')).toHaveText(['+ New', 'Find patient', 'Today']);
  await expect(list(page).getByRole('button', { name: 'Bill' })).toHaveCount(0);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Bills', exact: true }).click();
  await expect(page.getByText('You have no clinic of your own yet')).toBeVisible();
});

test('his to-dos are his own: added once, no "added by"', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await expect(page.getByText('Only you see these. For example: Call Ravi about his report')).toBeVisible();
  await page.getByLabel('New to-do').fill('Call Ravi about his report');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Call Ravi about his report', { exact: true })).toBeVisible();
  await expect(page.getByText(/Added by/)).toHaveCount(0);
  expect(b.calls.filter((c) => c.method === 'POST' && c.path === '/specialists/me/todos')).toHaveLength(1);
});

test.describe('on a 390 px phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop', 'the phone size runs once'));

  test('the dashboard and a clinic appointment at his own clinic (one clinic choice skipped) on a phone', async ({ page }) => {
    const b = await mockBackend(page);
    b.rows = b.rows.filter((r) => r.clinic === null || (r.clinic as Rec).id === OWN);
    await signIn(page);
    await noSidewaysScroll(page);
    await expect(page.getByRole('button', { name: 'Menu' })).toBeVisible();
    await page.screenshot({ path: '/tmp/wq56-shots/home-phone.png', fullPage: true });
    await newVisit(page, 'Lata Demo');
    await page.getByRole('navigation', { name: 'What does the patient need?' }).getByRole('link', { name: 'Clinic appointment' }).click();
    await page.getByRole('group', { name: 'Which clinic?' }).getByRole('button', { name: 'Dr Arjun Skin Clinic' }).click();
    await page.getByRole('group', { name: 'Free times' }).getByRole('button', { name: '12:00' }).click();
    await noSidewaysScroll(page);
    await page.getByRole('button', { name: 'Book 12:00 on Fri, 27 Nov, 2026 at Dr Arjun Skin Clinic' }).click();
    await expect(page.getByText('It is in your clinic’s list. Make the bill when the patient pays.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Make the bill' })).toBeVisible();
    await page.screenshot({ path: '/tmp/wq56-shots/booked-phone.png', fullPage: true });
  });
});
