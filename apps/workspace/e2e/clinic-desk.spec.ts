import { expect, test, type Page, type Route } from '@playwright/test';

/** WQ6: clinic doctors (invitations) and the clinic front desk (members and admins acting as owner), against a mocked backend. */
const CLINIC = 'a2'.repeat(12);
const CLINIC2 = 'a4'.repeat(12);
const LAB = 'a1'.repeat(12);
const OWNER = 'b1'.repeat(12);
const STAFF = 'b2'.repeat(12);
const ADMIN = 'ad'.repeat(12);
const BR1 = 'c1'.repeat(12);
const BR2 = 'c2'.repeat(12);
const BR3 = 'c3'.repeat(12);
const BR9 = 'c9'.repeat(12);
const D1 = 'd1'.repeat(12);
const D2 = 'd2'.repeat(12);
const D3 = 'd3'.repeat(12);
const D4 = 'd4'.repeat(12);
const D5 = 'd5'.repeat(12);
const D6 = 'd6'.repeat(12);
const AP1 = 'e1'.repeat(12);
const AP2 = 'e2'.repeat(12);
const AP3 = 'e3'.repeat(12);
const ALL = ['staff.manage', 'branches.manage', 'catalogue.manage', 'slots.manage', 'bookings.view', 'bookings.manage', 'reports.upload',
  'reports.release', 'invoices.create', 'invoices.cancel', 'payments.record', 'finance.view'];
/** Tuesday 17 Nov, 2026, 10:00 in India. */
const NOW = new Date('2026-11-17T04:30:00.000Z');

type Rec = Record<string, unknown>;
interface Me { _id: string; partnerId: string; name: string; role: 'owner' | 'staff'; permissions: string[]; branchIds: string[] }
interface Call { method: string; path: string; body: unknown; headers: Record<string, string> }
interface Slot { slotId: string; partnerId: string; doctorId: string; branchId: string; date: string; startTime: string; endTime: string; max: number; current: number }
interface Appt {
  bookingId: string; partnerId: string; bookingDate: string; bookingTime: string; status: string; doctorId: string; doctorName: string; branchId: string;
  slotId: string; consultationMode: string; fee: number; payAtClinic: boolean; arrivedAt: string | null; source: 'desk' | 'online'; paidOnline: boolean;
  patient: Rec; requestKey?: string; requestHash?: string; cancellationReason?: string;
}
interface Backend {
  calls: Call[];
  me: Me;
  appts: Appt[];
  slots: Slot[];
  invites: Rec[];
  /** The next desk booking is recorded, then its answer is lost on the network. */
  loseNextBook?: boolean;
  /** This slot is taken by someone else just before the next booking is decided. */
  takeBeforeBook?: string;
  /** This slot fills up just before the next reschedule is decided. */
  fillBeforeMove?: string;
  /** The answer to the next request whose path matches waits for `release()` (the server has already acted). */
  hold?: { match: RegExp; gate: Promise<void> };
  live: boolean;
}

const istInstant = (date: string, hhmm: string) => new Date(Date.parse(`${date}T${hhmm}:00+05:30`)).toISOString();
const slotIdOf = (doctor: string, branch: string, date: string, time: string) =>
  `5${doctor.slice(1, 2)}${branch.slice(1, 2)}${date.replace(/-/g, '')}${time.replace(':', '')}`.padEnd(24, '0');
const ymd = (d: string) => d.replace(/-/g, '');

function seedSlots(): Slot[] {
  const s = (doctorId: string, branchId: string, date: string, start: string, end: string, o: Partial<Slot> = {}, partnerId = CLINIC): Slot =>
    ({ slotId: slotIdOf(doctorId, branchId, date, start), partnerId, doctorId, branchId, date, startTime: start, endTime: end, max: 1, current: 0, ...o });
  return [
    s(D1, BR1, '2026-11-17', '09:30', '09:45', { current: 1 }), // AP1
    s(D1, BR1, '2026-11-17', '10:15', '10:30'),
    s(D1, BR1, '2026-11-17', '10:30', '10:45'),
    s(D1, BR1, '2026-11-17', '11:00', '11:15', { current: 1 }), // AP2 (online)
    s(D1, BR1, '2026-11-17', '12:00', '12:15', { current: 1 }), // AP3
    s(D1, BR1, '2026-11-18', '11:00', '11:15'),
    s(D1, BR1, '2026-11-18', '11:15', '11:30'),
    s(D2, BR2, '2026-11-17', '15:00', '15:30', { max: 2 }),
    s(D1, BR9, '2026-11-17', '10:15', '10:30', {}, CLINIC2),
  ];
}

function appt(id: string, o: Partial<Appt>): Appt {
  return {
    bookingId: id, partnerId: CLINIC, bookingDate: '20261117', bookingTime: '09:30', status: 'confirmed', doctorId: D1, doctorName: 'Dr Mehta', branchId: BR1,
    slotId: slotIdOf(D1, BR1, '2026-11-17', '09:30'), consultationMode: 'in-person', fee: 500, payAtClinic: true, arrivedAt: null, source: 'desk', paidOnline: false,
    patient: { name: 'Asha Rao', phone: '9800000001' }, ...o,
  };
}
function seedAppts(): Appt[] {
  return [
    appt(AP1, {}),
    appt(AP2, { bookingTime: '11:00', slotId: slotIdOf(D1, BR1, '2026-11-17', '11:00'), source: 'online', paidOnline: true, payAtClinic: false, consultationMode: 'in-person',
      patient: { name: 'Bala Shah', relationship: 'mother', accountName: 'Kiran Shah', phone: '9800000002' } }),
    appt(AP3, { bookingTime: '12:00', slotId: slotIdOf(D1, BR1, '2026-11-17', '12:00'), patient: { name: 'Chitra N', phone: '9800000003' } }),
  ];
}

const deskView = (a: Appt) => {
  const { source: _s, paidOnline: _p, patient: _pt, requestKey: _k, requestHash: _h, partnerId: _pid, cancellationReason: _c, ...rest } = a;
  return rest;
};

const owner = (partnerId = CLINIC): Me => ({ _id: OWNER, partnerId, name: 'Ravi Owner', role: 'owner', permissions: ALL, branchIds: [] });
const staff = (...permissions: string[]): Me => ({ _id: STAFF, partnerId: CLINIC, name: 'Sita Staff', role: 'staff', permissions, branchIds: [] });

async function mockBackend(page: Page, me: Me = owner()): Promise<Backend> {
  await page.clock.setFixedTime(NOW);
  const b: Backend = { calls: [], me, appts: seedAppts(), slots: seedSlots(), live: false,
    invites: [{ _id: 'f0'.repeat(12), partnerId: CLINIC, doctorId: D6, branchIds: [BR2], invitedBy: OWNER, state: 'pending', createdAt: '2026-11-10T05:00:00.000Z' }] };
  const partners: Rec[] = [
    { _id: CLINIC, kind: 'clinic', name: 'Sunrise Clinic', contact: { phone: '9000000008' }, verification: { state: 'verified' }, taxRegime: 'unregistered', invoiceSeries: { prefix: 'SC' }, activeOwnerCount: 1, isActive: true },
    { _id: CLINIC2, kind: 'clinic', name: 'Hill Clinic', contact: { phone: '9000000007' }, verification: { state: 'verified' }, taxRegime: 'unregistered', invoiceSeries: { prefix: 'HC' }, activeOwnerCount: 1, isActive: true },
    { _id: LAB, kind: 'lab', name: 'City Lab', contact: { phone: '9000000006' }, verification: { state: 'verified' }, taxRegime: 'unregistered', invoiceSeries: { prefix: 'LB' }, activeOwnerCount: 1, isActive: true },
  ];
  const addr = { line1: '1 Main Rd', city: 'Bengaluru', state: 'Karnataka', stateCode: '29', pincode: '560038' };
  const branches: Record<string, Rec[]> = {
    [CLINIC]: [
      { _id: BR1, partnerId: CLINIC, name: 'Indiranagar', address: addr, phone: '9000000010', services: { inClinic: true }, isActive: true },
      { _id: BR2, partnerId: CLINIC, name: 'Koramangala', address: addr, phone: '9000000011', services: { inClinic: true }, isActive: true },
      { _id: BR3, partnerId: CLINIC, name: 'Store room', address: addr, phone: '9000000012', services: {}, isActive: true },
    ],
    [CLINIC2]: [{ _id: BR9, partnerId: CLINIC2, name: 'Hilltop', address: addr, phone: '9000000013', services: { inClinic: true }, isActive: true }],
    [LAB]: [],
  };
  const doctors: Record<string, Rec[]> = {
    [CLINIC]: [
      { memberId: '71'.repeat(12), doctorId: D1, role: 'staff', branchIds: [], name: 'Dr Mehta', specialization: 'General physician', consultationFee: 500, active: true },
      { memberId: '72'.repeat(12), doctorId: D2, role: 'staff', branchIds: [BR2], name: 'Dr Rao', specialization: 'Dermatologist', consultationFee: 800, active: true },
      { memberId: '73'.repeat(12), doctorId: D3, role: 'staff', branchIds: [], name: 'Dr Absent', specialization: 'ENT', consultationFee: 400, active: false },
    ],
    [CLINIC2]: [{ memberId: '74'.repeat(12), doctorId: D1, role: 'staff', branchIds: [], name: 'Dr Mehta', specialization: 'General physician', consultationFee: 600, active: true }],
  };
  const specialists: Rec[] = [
    { _id: D1, name: 'Dr Mehta', specialization: 'General physician', phone: '9833333333' },
    { _id: D4, name: 'Dr Iyer', specialization: 'Cardiologist', phone: '9811111111' },
    { _id: D5, name: 'Dr Khan', specialization: 'Paediatrician', phone: '9822222222' },
  ];
  const customers = new Set(['9800000001', '9800000002', '9800000003']);
  let seq = 0;
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const ok = (route: Route, data: unknown, status = 200) => json(route, status, { success: true, data });
  const fail = (route: Route, status: number, code: string, message: string) => json(route, status, { error: status, code, message });
  const held = async (path: string) => {
    if (b.hold && b.hold.match.test(path)) { const g = b.hold.gate; b.hold = undefined; await g; }
  };

  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = req.method();
    const body = ['POST', 'PUT'].includes(method) ? req.postDataJSON() : null;
    if (path === '/auth/session/refresh') {
      if (!b.live) return fail(route, 401, 'SESSION_ENDED', 'Please sign in again');
      return ok(route, { token: 't1', expiresIn: 900, principal: { userId: b.me._id, userType: 'partner', sid: 's1' } });
    }
    if (path === '/auth/session/logout') { b.live = false; return ok(route, {}); }
    if (path.startsWith('/auth/session')) return ok(route, {});
    b.calls.push({ method, path: `${path}${url.search}`, body, headers: req.headers() });
    if (path === '/auth/partner/send' || path === '/auth/admin/send') return ok(route, undefined);
    if (path === '/auth/partner/verify') { b.live = true; return ok(route, { token: 't1', expiresIn: 900, user: {} }); }
    if (path === '/auth/admin/verify') return ok(route, { token: 'admin', expiresIn: 900, user: {} });
    const auth = req.headers().authorization;
    if (auth !== 'Bearer t1' && auth !== 'Bearer admin') return fail(route, 401, 'UNAUTHORIZED', 'Authentication is required');
    const admin = auth === 'Bearer admin';
    if (path === '/auth/profile') {
      if (admin) return ok(route, { user: { _id: ADMIN, name: 'Ops Admin' }, userRole: 'admin' });
      return ok(route, { user: { ...b.me, phone: '9000000001', isActive: true }, partner: partners.find((x) => x._id === b.me.partnerId), userRole: 'partner' });
    }
    if (/^\/partner-workspace\/admin\/[0-9a-f]{24}$/.test(path)) return ok(route, partners.find((p) => path.endsWith(p._id as string)));
    const ws = /^\/partner-workspace(?:\/admin\/([0-9a-f]{24})\/workspace)?(\/.*)$/.exec(path);
    if (!ws) return fail(route, 404, 'NOT_FOUND', 'Not found');
    if (ws[1] && !admin) return fail(route, 403, 'FORBIDDEN', 'Admin access is required');
    const sub = ws[2]!;
    const pid = ws[1] ?? b.me.partnerId;
    const p = partners.find((x) => x._id === pid)!;
    const actor = ws[1] ? { _id: `admin:${ADMIN}`, role: 'owner', permissions: ALL, branchIds: [] as string[] } : b.me;
    const can = (...perms: string[]) => actor.role === 'owner' || perms.some((x) => actor.permissions.includes(x));
    const deny = () => fail(route, 403, 'PARTNER_PERMISSION_REQUIRED', 'You do not have permission to do this');

    if (sub === '/me') return ok(route, p);
    if (sub === '/branches') return ok(route, branches[pid] ?? []);
    if (!sub.startsWith('/clinic/')) return fail(route, 404, 'NOT_FOUND', 'Not found');
    if (p.kind !== 'clinic') return fail(route, 409, 'NOT_A_CLINIC', 'Only clinics work with doctors');

    // ── doctors and invitations ──
    if (sub === '/clinic/doctors') return can('staff.manage', 'bookings.view', 'bookings.manage', 'invoices.create') ? ok(route, doctors[pid] ?? []) : deny();
    if (sub === '/clinic/doctor-invites' && method === 'GET') {
      if (!can('staff.manage')) return deny();
      const st = url.searchParams.get('state');
      return ok(route, b.invites.filter((i) => i.partnerId === pid && (!st || i.state === st)).reverse());
    }
    if (sub === '/clinic/doctor-invites' && method === 'POST') {
      if (!can('staff.manage')) return deny();
      const x = body as { doctorId?: string; phone?: string; branchIds: string[] };
      const sp = x.doctorId ? specialists.find((s) => s._id === x.doctorId) : specialists.find((s) => s.phone === x.phone);
      if (!sp) return fail(route, 404, 'DOCTOR_NOT_FOUND', 'No active, verified doctor with these details');
      if ((doctors[pid] ?? []).some((d) => d.doctorId === sp._id)) return fail(route, 409, 'DOCTOR_ALREADY_MEMBER', 'This doctor already consults here');
      const doctor = { doctorId: sp._id, name: sp.name, specialization: sp.specialization };
      const pending = b.invites.find((i) => i.partnerId === pid && i.doctorId === sp._id && i.state === 'pending');
      if (pending) return ok(route, { invite: pending, doctor, created: false });
      const invite = { _id: `f${++seq}`.padEnd(24, '0'), partnerId: pid, doctorId: sp._id, branchIds: x.branchIds, invitedBy: actor._id, state: 'pending', createdAt: NOW.toISOString() };
      b.invites.push(invite);
      return ok(route, { invite, doctor, created: true }, 201);
    }
    const inv = /^\/clinic\/doctor-invites\/([0-9a-f]{24})$/.exec(sub);
    if (inv && method === 'DELETE') {
      if (!can('staff.manage')) return deny();
      const i = b.invites.find((y) => y._id === inv[1] && y.partnerId === pid);
      if (!i) return fail(route, 404, 'INVITE_NOT_FOUND', 'Invitation not found');
      if (i.state !== 'pending') return fail(route, 409, 'INVITE_NOT_PENDING', 'This invitation is no longer pending');
      Object.assign(i, { state: 'revoked', respondedAt: NOW.toISOString() });
      return ok(route, i);
    }

    // ── front desk ──
    if (!can('bookings.view', 'bookings.manage')) return deny();
    if (sub === '/clinic/slots') {
      const q = Object.fromEntries(url.searchParams);
      if (!(branches[pid] ?? []).some((x) => x._id === q.branchId && (x.services as Rec).inClinic)) return fail(route, 409, 'BRANCH_NOT_IN_CLINIC', 'This branch does not take in-clinic consultations');
      return ok(route, b.slots.filter((s) => s.partnerId === pid && s.doctorId === q.doctorId && s.branchId === q.branchId && s.date === q.date && s.current < s.max)
        .map((s) => ({ slotId: s.slotId, date: s.date, startTime: s.startTime, endTime: s.endTime, startsAt: istInstant(s.date, s.startTime), seatsLeft: s.max - s.current })));
    }
    if (sub === '/clinic/appointments' && method === 'GET') {
      const q = Object.fromEntries(url.searchParams);
      return ok(route, b.appts.filter((a) => a.partnerId === pid && a.bookingDate >= ymd(q.from!) && a.bookingDate <= ymd(q.to!)
        && (!q.branchId || a.branchId === q.branchId) && (!q.doctorId || a.doctorId === q.doctorId))
        .sort((x, y) => x.bookingTime.localeCompare(y.bookingTime))
        .map(({ requestKey: _k, requestHash: _h, partnerId: _p, cancellationReason: _c, ...a }) => a));
    }
    if (!can('bookings.manage')) return deny();
    if (sub === '/clinic/appointments' && method === 'POST') {
      const x = body as { slotId: string; customer: { phone: string; name?: string }; notes?: string; requestKey: string };
      const key = `desk:${actor._id}:${x.requestKey}`;
      const hash = JSON.stringify([x.slotId, x.customer.phone, x.notes ?? null]);
      const prior = b.appts.find((a) => a.requestKey === key);
      if (prior) {
        if (prior.requestHash !== hash) return fail(route, 409, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different appointment');
        return ok(route, { booking: deskView(prior), customer: { userId: '99'.repeat(12), phone: x.customer.phone, created: false }, replayed: true });
      }
      const s = b.slots.find((y) => y.slotId === x.slotId && y.partnerId === pid);
      if (s && b.takeBeforeBook === s.slotId) { s.current = s.max; b.takeBeforeBook = undefined; }
      if (!s || s.current >= s.max) return fail(route, 409, 'SLOT_NOT_AVAILABLE', 'Slot is not available for booking');
      s.current++;
      const created = !customers.has(x.customer.phone);
      customers.add(x.customer.phone);
      const doc = (doctors[pid] ?? []).find((d) => d.doctorId === s.doctorId)!;
      const a = appt(`9${++seq}`.padEnd(24, '0'), { partnerId: pid, bookingDate: ymd(s.date), bookingTime: s.startTime, doctorId: s.doctorId, doctorName: doc.name as string,
        branchId: s.branchId, slotId: s.slotId, fee: doc.consultationFee as number, patient: { name: x.customer.name, phone: x.customer.phone }, requestKey: key, requestHash: hash });
      b.appts.push(a);
      if (b.loseNextBook) { b.loseNextBook = false; return route.abort('failed'); }
      await held(sub);
      return ok(route, { booking: deskView(a), customer: { userId: '98'.repeat(12), phone: x.customer.phone, created }, replayed: false }, 201);
    }
    const one = /^\/clinic\/appointments\/([0-9a-f]{24})\/(arrived|complete|no-show|cancel|reschedule)$/.exec(sub);
    if (one) {
      const a = b.appts.find((y) => y.bookingId === one[1] && y.partnerId === pid && y.source === 'desk');
      if (!a) return fail(route, 404, 'BOOKING_NOT_FOUND', 'Appointment not found');
      const cmd = one[2];
      const free = (slotId: string) => { const s = b.slots.find((y) => y.slotId === slotId); if (s) s.current--; };
      if (cmd === 'arrived') {
        if (a.status !== 'confirmed' || a.arrivedAt) return fail(route, 409, 'BOOKING_STATE_CONFLICT', a.arrivedAt ? 'Already marked as arrived' : `A ${a.status} appointment cannot be checked in`);
        a.arrivedAt = NOW.toISOString();
      } else if (cmd === 'complete' || cmd === 'no-show') {
        if (a.status !== 'confirmed') return fail(route, 409, 'BOOKING_STATE_CONFLICT', `A ${a.status} appointment cannot be closed`);
        if (cmd === 'no-show' && Date.parse(istInstant(`${a.bookingDate.slice(0, 4)}-${a.bookingDate.slice(4, 6)}-${a.bookingDate.slice(6)}`, a.bookingTime)) > NOW.getTime()) {
          return fail(route, 409, 'APPOINTMENT_NOT_STARTED', 'A no-show can be marked only after the appointment time');
        }
        a.status = cmd === 'complete' ? 'completed' : 'no_show';
      } else if (cmd === 'cancel') {
        if (!['pending', 'confirmed'].includes(a.status)) return fail(route, 409, 'BOOKING_NOT_CANCELLABLE', `A ${a.status} booking cannot be cancelled`);
        a.status = 'cancelled';
        a.cancellationReason = (body as { reason?: string }).reason || 'Cancelled by the clinic';
        free(a.slotId);
      } else {
        const t = b.slots.find((y) => y.slotId === (body as { slotId: string }).slotId && y.partnerId === pid);
        if (t && b.fillBeforeMove === t.slotId) { t.current = t.max; b.fillBeforeMove = undefined; }
        if (!t || t.current >= t.max || t.doctorId !== a.doctorId) return fail(route, 409, 'SLOT_NOT_AVAILABLE', 'Slot is not available for booking');
        t.current++;
        free(a.slotId);
        Object.assign(a, { slotId: t.slotId, bookingDate: ymd(t.date), bookingTime: t.startTime, branchId: t.branchId, arrivedAt: null });
      }
      await held(sub);
      return ok(route, deskView(a));
    }
    return fail(route, 404, 'NOT_FOUND', 'Not found');
  });
  return b;
}

/** Holds the next matching answer until `release()` is called (the server acts at once). */
function hold(b: Backend, match: RegExp) {
  let release!: () => void;
  b.hold = { match, gate: new Promise<void>((r) => { release = r; }) };
  return () => release();
}

async function signInPartner(page: Page) {
  await page.goto('/');
  await page.getByLabel('Lab or clinic staff').check();
  await page.getByLabel('Mobile number').fill('9000000001');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

async function signInAdmin(page: Page) {
  await page.goto('/');
  await page.getByLabel('Admin').check();
  await page.getByLabel('Mobile number').fill('9876543210');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' });
const writes = (b: Backend) => b.calls.filter((c) => c.method !== 'GET' && !c.path.startsWith('/auth/')).map((c) => `${c.method} ${c.path}`);
const books = (b: Backend) => b.calls.filter((c) => c.method === 'POST' && /\/clinic\/appointments$/.test(c.path));
const appointments = (page: Page) => page.getByRole('table', { name: /Appointments on/ });
const freeSlots = (page: Page) => page.getByRole('table', { name: /Free slots of/ });
const storage = (page: Page) => page.evaluate(() => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }));

async function openDesk(page: Page, doctor?: string) {
  await nav(page).getByRole('link', { name: 'Front desk' }).click();
  await expect(page.getByRole('heading', { name: 'Front desk', level: 1 })).toBeVisible();
  await expect(appointments(page)).toBeVisible();
  if (doctor) await page.getByLabel('Doctor', { exact: true }).selectOption({ label: doctor });
}

async function fillPatient(page: Page, phone: string, name = '', notes = '') {
  await page.getByLabel(/Patient.s mobile number/).fill(phone);
  if (name) await page.getByLabel(/Patient.s name/).fill(name);
  if (notes) await page.getByLabel(/Notes for the clinic/).fill(notes);
  await page.getByRole('button', { name: 'Review the booking' }).click();
}

test('doctors: the list, inviting by mobile or doctor id with branches, a repeat answers the pending one, revoke after a confirmation', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Doctors' }).click();
  await expect(page.getByRole('heading', { name: 'Doctors', level: 1 })).toBeVisible();
  await expect(page.getByText('A doctor consults here only after accepting your invitation in their own Jansetu doctor app.')).toBeVisible();
  const list = page.getByRole('table', { name: 'Doctors consulting at this clinic' });
  await expect(list.getByRole('row').filter({ hasText: 'Dr Mehta' })).toContainText('All branches');
  await expect(list.getByRole('row').filter({ hasText: 'Dr Mehta' })).toContainText('₹500.00');
  await expect(list.getByRole('row').filter({ hasText: 'Dr Rao' })).toContainText('Koramangala');
  await expect(list.getByRole('row').filter({ hasText: 'Dr Absent' })).toContainText('Not bookable');

  const invites = page.getByRole('table', { name: 'Invitations to doctors' });
  await expect(invites.getByRole('row').filter({ hasText: 'Doctor …d6d6d6' })).toContainText('The name shows here once they accept.');

  // Checked before sending: nothing goes out for a bad number.
  const form = page.getByRole('form', { name: 'Invite a doctor' });
  await form.getByLabel('Doctor’s mobile number').fill('12345');
  await form.getByRole('button', { name: 'Send invitation' }).click();
  await expect(form.getByText('Enter the doctor’s ten-digit mobile number.')).toBeVisible();
  // Only branches taking in-clinic consultations are offered.
  await form.getByLabel('Every branch, including ones added later').uncheck();
  await expect(form.getByLabel('Store room')).toHaveCount(0);
  await form.getByLabel('Doctor’s mobile number').fill('+91 98111 11111');
  await form.getByRole('button', { name: 'Send invitation' }).click();
  await expect(form.getByText('Choose at least one branch, or every branch.')).toBeVisible();
  expect(writes(backend)).toEqual([]);
  await form.getByLabel('Indiranagar').check();
  await form.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByText('Invitation sent to Dr Iyer (Cardiologist). They accept it in their Jansetu doctor app')).toBeVisible();
  await expect(invites.getByRole('row').filter({ hasText: 'Dr Iyer' })).toContainText('Indiranagar');
  await expect(invites.getByRole('row').filter({ hasText: 'Dr Iyer' })).toContainText('Waiting for the doctor');

  // The same doctor again: the server answers the pending invitation; nothing new is sent.
  await form.getByLabel('Doctor’s mobile number').fill('9811111111');
  await form.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByText('Dr Iyer already had a pending invitation from this clinic (consults at: Indiranagar). Nothing new was sent')).toBeVisible();

  // By doctor id, every branch; an unknown number is refused as the server says; a member already consults here.
  await form.getByLabel('Jansetu doctor id').check();
  await form.getByLabel('Doctor id', { exact: true }).fill(D5);
  await form.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByText('Invitation sent to Dr Khan (Paediatrician).', { exact: false })).toBeVisible();
  await expect(invites.getByRole('row').filter({ hasText: 'Dr Khan' })).toContainText('All branches');
  await form.getByLabel('Doctor id', { exact: true }).fill(D1);
  await form.getByRole('button', { name: 'Send invitation' }).click();
  await expect(form.getByText('Not sent: This doctor already consults here')).toBeVisible();
  await form.getByLabel('Mobile number registered with Jansetu').check();
  await form.getByLabel('Doctor’s mobile number').fill('9899999999');
  await form.getByRole('button', { name: 'Send invitation' }).click();
  await expect(form.getByText('Not sent: No active, verified doctor with these details')).toBeVisible();
  const posts = backend.calls.filter((c) => c.method === 'POST' && c.path === '/partner-workspace/clinic/doctor-invites').map((c) => c.body);
  expect(posts).toEqual([
    { phone: '9811111111', branchIds: [BR1] }, { phone: '9811111111', branchIds: [] }, { doctorId: D5, branchIds: [] },
    { doctorId: D1, branchIds: [] }, { phone: '9899999999', branchIds: [] },
  ]);

  // Revoke: a confirmation first; Back sends nothing.
  await invites.getByRole('button', { name: 'Revoke invitation to Dr Iyer' }).click();
  await expect(page.getByText('Revoke the invitation to Dr Iyer? They can no longer accept it.')).toBeVisible();
  await page.getByRole('button', { name: 'Back' }).click();
  expect(backend.calls.some((c) => c.method === 'DELETE')).toBe(false);
  await invites.getByRole('button', { name: 'Revoke invitation to Dr Iyer' }).click();
  await page.getByRole('button', { name: 'Revoke invitation', exact: true }).click();
  await expect(page.getByText('The invitation to Dr Iyer was revoked. They can no longer accept it.')).toBeVisible();
  await expect(invites.getByRole('row').filter({ hasText: 'Dr Iyer' })).toHaveCount(0);
  await page.getByLabel('Show').selectOption('revoked');
  await expect(invites.getByRole('row').filter({ hasText: 'Dr Iyer' })).toContainText('Revoked');
  expect(backend.calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([`/partner-workspace/clinic/doctor-invites/${backend.invites[1]!._id}`]);
});

test('desk day view: appointments by branch and doctor, free slots, other days, online bookings view-only', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await openDesk(page);
  // Only branches taking in-clinic consultations.
  await expect(page.getByLabel('Branch').locator('option')).toHaveText(['Indiranagar', 'Koramangala']);
  await expect(page.getByLabel('Day')).toHaveValue('2026-11-17');
  await expect(page.getByRole('heading', { name: 'Appointments on Tue, 17 Nov, 2026' })).toBeVisible();
  const rows = appointments(page).getByRole('row');
  await expect(rows.filter({ hasText: 'Asha Rao' })).toContainText('09:30');
  await expect(rows.filter({ hasText: 'Asha Rao' })).toContainText('At the desk');
  await expect(rows.filter({ hasText: 'Bala Shah' })).toContainText('Online, paid');
  await expect(rows.filter({ hasText: 'Chitra N' })).toContainText('Booked');
  // Doctors offered at this branch: active ones consulting here.
  await expect(page.getByLabel('Doctor', { exact: true }).locator('option')).toHaveText(['All doctors', 'Dr Mehta (General physician)']);
  await expect(page.getByText('Choose a doctor to see their free in-clinic slots and book one.')).toBeVisible();

  // An online booking is view-only for the clinic.
  await page.getByRole('button', { name: 'Open Bala Shah at 11:00' }).click();
  await expect(page.getByRole('heading', { name: 'Appointment: Bala Shah, Tue, 17 Nov, 2026, 11:00' })).toBeVisible();
  await expect(page.getByText('Bala Shah (mother of Kiran Shah)')).toBeVisible();
  await expect(page.getByText('Booked online in the Jansetu app. The clinic can view it; the doctor or the patient makes any change.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Mark|Cancel appointment|Move/ })).toHaveCount(0);

  await page.getByLabel('Doctor', { exact: true }).selectOption({ label: 'Dr Mehta (General physician)' });
  await expect(freeSlots(page).getByRole('row')).toHaveText([/Time/, /10:15–10:30/, /10:30–10:45/]);
  await page.getByRole('button', { name: 'Next day' }).click();
  await expect(page.getByRole('heading', { name: 'Appointments on Wed, 18 Nov, 2026' })).toBeVisible();
  await expect(page.getByText('No appointment with Dr Mehta at Indiranagar on this day.')).toBeVisible();
  await expect(freeSlots(page).getByRole('row')).toHaveText([/Time/, /11:00–11:15/, /11:15–11:30/]);

  // Another branch: its own doctors and slots.
  await page.getByLabel('Branch').selectOption({ label: 'Koramangala' });
  await page.getByRole('button', { name: 'Today' }).click();
  await page.getByLabel('Doctor', { exact: true }).selectOption({ label: 'Dr Rao (Dermatologist)' });
  await expect(freeSlots(page).getByRole('row').filter({ hasText: '15:00–15:30' })).toContainText('2');
  const paths = backend.calls.filter((c) => c.method === 'GET').map((c) => c.path);
  expect(paths).toContain(`/partner-workspace/clinic/appointments?from=2026-11-17&to=2026-11-17&branchId=${BR1}`);
  expect(paths).toContain(`/partner-workspace/clinic/slots?doctorId=${D1}&branchId=${BR1}&date=2026-11-18`);
  expect(paths).toContain(`/partner-workspace/clinic/slots?doctorId=${D2}&branchId=${BR2}&date=2026-11-17`);
  expect(writes(backend)).toEqual([]);
});

test('desk booking: details checked, reviewed, booked once with a key; then arrived and seen; nothing about the patient in storage or the URL', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await openDesk(page, 'Dr Mehta (General physician)');
  await freeSlots(page).getByRole('button', { name: 'Book 10:15' }).click();
  await expect(page.getByRole('heading', { name: 'Book Dr Mehta at Tue, 17 Nov, 2026, 10:15' })).toBeVisible();
  await expect(page.getByText('In person at Indiranagar (desk appointments are always in person).', { exact: false })).toBeVisible();
  await fillPatient(page, '98000');
  await expect(page.getByText('Enter a ten-digit mobile number.')).toBeVisible();
  await fillPatient(page, '+91 98000 00009', 'Kiran Shah', 'Walk-in, fever');
  const review = page.getByRole('group', { name: 'Book the appointment' });
  await expect(review).toContainText('Book Kiran Shah (9800000009) with Dr Mehta on Tue, 17 Nov, 2026, 10:15 at Indiranagar? The fee of ₹500.00 is paid at the clinic.');
  expect(books(backend)).toHaveLength(0);
  await review.getByRole('button', { name: 'Book appointment' }).click();
  await expect(page.getByText('Booked. Kiran Shah with Dr Mehta on Tue, 17 Nov, 2026, 10:15 at Indiranagar. Fee ₹500.00, paid at the clinic. A Jansetu account was created for this mobile number.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Make a bill for this visit' }).first()).toHaveAttribute('href', '#/partner/invoices/new');
  const [post] = books(backend);
  const sent = post!.body as { requestKey: string };
  expect(sent).toEqual({ slotId: slotIdOf(D1, BR1, '2026-11-17', '10:15'), customer: { phone: '9800000009', name: 'Kiran Shah' }, notes: 'Walk-in, fever', requestKey: expect.stringMatching(/^[0-9a-f]{32}$/) });
  expect(post!.headers['idempotency-key']).toBeUndefined();
  await expect(freeSlots(page).getByRole('button', { name: 'Book 10:15' })).toHaveCount(0);

  // The new appointment is open: arrived, then seen (after a confirmation).
  await expect(page.getByRole('heading', { name: 'Appointment: Kiran Shah, Tue, 17 Nov, 2026, 10:15' })).toBeVisible();
  await page.getByRole('button', { name: 'Mark arrived' }).click();
  await expect(page.getByText('Kiran Shah is marked as arrived.')).toBeVisible();
  await expect(appointments(page).getByRole('row').filter({ hasText: 'Kiran Shah' })).toContainText('Arrived 10:00');
  await expect(page.getByRole('button', { name: 'Mark arrived' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Mark as seen' }).click();
  await expect(page.getByText('The fee of ₹500.00 is paid at the clinic: make a bill for it under Bills.', { exact: false })).toBeVisible();
  await page.getByRole('group', { name: 'Mark as seen' }).getByRole('button', { name: 'Mark as seen' }).click();
  await expect(page.getByText('Kiran Shah’s visit is marked as seen.')).toBeVisible();
  await expect(appointments(page).getByRole('row').filter({ hasText: 'Kiran Shah' })).toContainText('Seen');
  const id = backend.appts.at(-1)!.bookingId;
  expect(writes(backend)).toEqual([
    'POST /partner-workspace/clinic/appointments',
    `POST /partner-workspace/clinic/appointments/${id}/arrived`,
    `POST /partner-workspace/clinic/appointments/${id}/complete`,
  ]);
  expect(await storage(page)).not.toMatch(/Kiran|9800000009|fever/);
  expect(page.url()).not.toMatch(/9800000009|Kiran/);
});

test('a lost booking answer locks the form; resending the same request books once; after a reload the person checks the day list first', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.loseNextBook = true;
  await signInPartner(page);
  await openDesk(page, 'Dr Mehta (General physician)');
  await freeSlots(page).getByRole('button', { name: 'Book 10:15' }).click();
  await fillPatient(page, '9800000009', 'Kiran Shah');
  await page.getByRole('button', { name: 'Book appointment' }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed booking' });
  await expect(panel).toContainText('The answer to this booking was lost');
  await expect(panel).toContainText('Kiran Shah (9800000009) with Dr Mehta on Tue, 17 Nov, 2026, 10:15 at Indiranagar.');
  await expect(page.getByLabel(/Patient.s mobile number/)).toHaveCount(0);
  await expect(freeSlots(page).getByRole('button', { name: 'Book 10:30' })).toBeDisabled();
  await expect(page.getByText('Settle the unconfirmed booking above before booking another.')).toBeVisible();
  // The marker kept for a reload has the key only.
  expect(await storage(page)).not.toMatch(/Kiran|9800000009/);

  await panel.getByRole('button', { name: 'Check the day list' }).click();
  await expect(panel).toContainText('The day list has a desk appointment for this mobile number at this time (Tue, 17 Nov, 2026, 10:15)');
  await panel.getByRole('button', { name: 'Send the same booking again' }).click();
  await expect(page.getByText('This booking had already been made; nothing was booked twice. Kiran Shah with Dr Mehta on Tue, 17 Nov, 2026, 10:15 at Indiranagar.')).toBeVisible();
  await expect(panel).toHaveCount(0);
  const [first, second] = books(backend);
  expect(second!.body).toEqual(first!.body);
  expect(backend.appts.filter((a) => a.patient.phone === '9800000009')).toHaveLength(1);
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.includes('clinic-desk')))).toEqual([]);

  // Lost again, then the page is reloaded: the details are gone, so the day list is checked before setting it aside.
  backend.loseNextBook = true;
  await freeSlots(page).getByRole('button', { name: 'Book 10:30' }).click();
  await fillPatient(page, '9800000010', 'Meena');
  await page.getByRole('button', { name: 'Book appointment' }).click();
  await expect(panel).toContainText('The answer to this booking was lost');
  await page.reload();
  await expect(panel).toContainText('was not confirmed before the page was reloaded or you signed out');
  await expect(panel).not.toContainText('Meena');
  await expect(appointments(page).getByRole('row').filter({ hasText: 'Meena' })).toContainText('10:30');
  await page.getByLabel('Doctor', { exact: true }).selectOption({ label: 'Dr Mehta (General physician)' });
  await expect(page.getByText('Settle the unconfirmed booking above before booking another.')).toBeVisible();
  await panel.getByRole('button', { name: 'I have checked the day list' }).click();
  await expect(panel).toContainText('booking again could then make a second appointment for the same patient');
  await panel.getByRole('button', { name: 'Set it aside' }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByText('The unconfirmed booking was set aside.', { exact: false })).toBeVisible();
  expect(books(backend)).toHaveLength(3);
});

test('a slot taken meanwhile (409) is refused, the patient details stay, and another time books with a new key', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.takeBeforeBook = slotIdOf(D1, BR1, '2026-11-17', '10:15');
  await signInPartner(page);
  await openDesk(page, 'Dr Mehta (General physician)');
  await freeSlots(page).getByRole('button', { name: 'Book 10:15' }).click();
  await fillPatient(page, '9800000009', 'Kiran Shah');
  await page.getByRole('button', { name: 'Book appointment' }).click();
  await expect(page.getByText('Not booked: Slot is not available for booking. Choose another time; the patient’s details are kept.')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Unconfirmed booking' })).toHaveCount(0);
  await expect(freeSlots(page).getByRole('row')).toHaveText([/Time/, /10:30–10:45/]);
  await freeSlots(page).getByRole('button', { name: 'Book 10:30' }).click();
  await expect(page.getByLabel(/Patient.s mobile number/)).toHaveValue('9800000009');
  await expect(page.getByLabel(/Patient.s name/)).toHaveValue('Kiran Shah');
  await page.getByRole('button', { name: 'Review the booking' }).click();
  await page.getByRole('button', { name: 'Book appointment' }).click();
  await expect(page.getByText('Booked. Kiran Shah with Dr Mehta on Tue, 17 Nov, 2026, 10:30 at Indiranagar.', { exact: false })).toBeVisible();
  const [a, b] = books(backend).map((c) => c.body as { requestKey: string; slotId: string });
  expect(a!.requestKey).not.toBe(b!.requestKey);
  expect(b!.slotId).toBe(slotIdOf(D1, BR1, '2026-11-17', '10:30'));
  expect(backend.appts.filter((x) => x.patient.phone === '9800000009')).toHaveLength(1);
});

test('no-show only after the time, and no-show and cancel each need a confirmation that says no money moves', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await openDesk(page);
  // 12:00 has not come yet (it is 10:00).
  await page.getByRole('button', { name: 'Open Chitra N at 12:00' }).click();
  await expect(page.getByRole('button', { name: 'Mark did not come' })).toBeDisabled();
  await expect(page.getByText('A no-show can be marked only after the appointment time.')).toBeVisible();

  // 09:30 has passed.
  await page.getByRole('button', { name: 'Open Asha Rao at 09:30' }).click();
  await page.getByRole('button', { name: 'Mark did not come' }).click();
  const noShow = page.getByRole('group', { name: 'Mark did not come' });
  await expect(noShow).toContainText('Mark Asha Rao as not come for Tue, 17 Nov, 2026, 09:30? The appointment ends and the doctor’s time is freed. Nothing is charged or refunded through Jansetu: desk appointments are paid at the clinic. This cannot be undone.');
  await noShow.getByRole('button', { name: 'Back' }).click();
  expect(writes(backend)).toEqual([]);
  await page.getByRole('button', { name: 'Mark did not come' }).click();
  await noShow.getByRole('button', { name: 'Mark did not come' }).click();
  await expect(page.getByText('Asha Rao is marked as not come.')).toBeVisible();
  await expect(appointments(page).getByRole('row').filter({ hasText: 'Asha Rao' })).toContainText('Did not come');
  await expect(page.getByRole('button', { name: 'Cancel appointment' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Open Chitra N at 12:00' }).click();
  await page.getByRole('button', { name: 'Cancel appointment' }).click();
  const cancel = page.getByRole('group', { name: 'Cancel appointment' });
  await expect(cancel).toContainText('The seat and the doctor’s time are freed at once. No money moves: desk appointments are paid at the clinic, so nothing was taken online');
  await expect(cancel).toContainText('Without a reason, “Cancelled by the clinic” is recorded.');
  await cancel.getByLabel('Reason (optional)').fill('Doctor away');
  await cancel.getByRole('button', { name: 'Cancel appointment' }).click();
  await expect(page.getByText('Chitra N’s appointment is cancelled.')).toBeVisible();
  await expect(appointments(page).getByRole('row').filter({ hasText: 'Chitra N' })).toContainText('Cancelled');
  expect(writes(backend)).toEqual([`POST /partner-workspace/clinic/appointments/${AP1}/no-show`, `POST /partner-workspace/clinic/appointments/${AP3}/cancel`]);
  expect(backend.calls.find((c) => c.path.endsWith('/cancel'))!.body).toEqual({ reason: 'Doctor away' });
  expect(backend.appts.find((a) => a.bookingId === AP3)!.cancellationReason).toBe('Doctor away');
});

test('reschedule: another day’s free slot after a confirmation; a slot taken meanwhile is refused and the slots reload', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.fillBeforeMove = slotIdOf(D1, BR1, '2026-11-18', '11:00');
  backend.appts.find((a) => a.bookingId === AP3)!.arrivedAt = '2026-11-17T04:20:00.000Z';
  await signInPartner(page);
  await openDesk(page);
  await page.getByRole('button', { name: 'Open Chitra N at 12:00' }).click();
  await page.getByRole('button', { name: 'Move to another time' }).click();
  const move = page.getByRole('form', { name: 'Move to another time' });
  await expect(move.getByLabel('New time').locator('option')).toHaveText(['Choose a time', '10:15–10:30 (1 free)', '10:30–10:45 (1 free)']);
  await move.getByRole('button', { name: 'Continue' }).click();
  await expect(move.getByText('Choose the new time.')).toBeVisible();
  await move.getByLabel('New day').fill('2026-11-18');
  await move.getByLabel('New time').selectOption({ label: '11:00–11:15 (1 free)' });
  await move.getByRole('button', { name: 'Continue' }).click();
  await expect(move).toContainText('Move Chitra N from Tue, 17 Nov, 2026, 12:00 to Wed, 18 Nov, 2026, 11:00 at Indiranagar? The new seat is taken and the old one freed at once. The check-in is cleared');
  await move.getByRole('button', { name: 'Move the appointment' }).click();
  await expect(move).toContainText('Not moved: Slot is not available for booking');
  await expect(move.getByLabel('New time').locator('option')).toHaveText(['Choose a time', '11:15–11:30 (1 free)']);
  await move.getByLabel('New time').selectOption({ label: '11:15–11:30 (1 free)' });
  await move.getByRole('button', { name: 'Continue' }).click();
  await move.getByRole('button', { name: 'Move the appointment' }).click();
  await expect(page.getByText('Moved to Wed, 18 Nov, 2026, 11:15 at Indiranagar. Tell the patient: Jansetu does not notify them of desk appointment changes.')).toBeVisible();
  await expect(appointments(page).getByRole('row').filter({ hasText: 'Chitra N' })).toHaveCount(0);
  const moves = backend.calls.filter((c) => c.path.endsWith('/reschedule'));
  expect(moves.map((c) => c.body)).toEqual([{ slotId: slotIdOf(D1, BR1, '2026-11-18', '11:00') }, { slotId: slotIdOf(D1, BR1, '2026-11-18', '11:15') }]);
  await page.getByRole('button', { name: 'Next day' }).click();
  await expect(appointments(page).getByRole('row').filter({ hasText: 'Chitra N' })).toContainText('11:15');
});

test('one step at a time per appointment (an open confirmation included); a late answer shows nothing on another appointment', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await openDesk(page);
  await page.getByRole('button', { name: 'Open Asha Rao at 09:30' }).click();
  await page.getByRole('button', { name: 'Cancel appointment' }).click();
  const release = hold(backend, /\/arrived$/);
  await page.getByRole('button', { name: 'Mark arrived' }).click();
  const cancel = page.getByRole('group', { name: 'Cancel appointment' });
  await expect(cancel.getByRole('button', { name: 'Cancel appointment' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Mark as seen' })).toBeDisabled();
  release();
  await expect(page.getByText('Asha Rao is marked as arrived.')).toBeVisible();
  await expect(cancel.getByRole('button', { name: 'Cancel appointment' })).toBeEnabled();
  await cancel.getByRole('button', { name: 'Back' }).click();

  // A held answer for Asha arrives while Chitra is open: Chitra's page shows nothing of it.
  const release2 = hold(backend, /\/complete$/);
  await page.getByRole('button', { name: 'Mark as seen' }).click();
  await page.getByRole('group', { name: 'Mark as seen' }).getByRole('button', { name: 'Mark as seen' }).click();
  await page.getByRole('button', { name: 'Open Chitra N at 12:00' }).click();
  await expect(page.getByRole('heading', { name: /Appointment: Chitra N/ })).toBeVisible();
  release2();
  await expect(appointments(page).getByRole('row').filter({ hasText: 'Asha Rao' })).toContainText('Seen');
  await expect(page.getByText('Asha Rao’s visit is marked as seen.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Mark arrived' })).toBeEnabled();
  expect(writes(backend)).toEqual([`POST /partner-workspace/clinic/appointments/${AP1}/arrived`, `POST /partner-workspace/clinic/appointments/${AP1}/complete`]);
});

test('permissions: view-only desk staff, a biller sees doctors only, a lab has no clinic pages', async ({ page }) => {
  const backend = await mockBackend(page, staff('bookings.view'));
  await signInPartner(page);
  await expect(nav(page).getByRole('link', { name: 'Doctors' })).toBeVisible();
  await openDesk(page, 'Dr Mehta (General physician)');
  await expect(page.getByText('Booking needs the “Manage bookings” permission.')).toBeVisible();
  await expect(freeSlots(page).getByRole('button')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open Asha Rao at 09:30' }).click();
  await expect(page.getByText('You can view this appointment; the steps need the “Manage bookings” permission.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Mark|Cancel appointment|Move/ })).toHaveCount(0);
  await nav(page).getByRole('link', { name: 'Doctors' }).click();
  await expect(page.getByRole('table', { name: 'Doctors consulting at this clinic' })).toBeVisible();
  await expect(page.getByText('Invitations are sent and revoked by staff with the “Manage staff” permission.')).toBeVisible();
  await expect(page.getByRole('form', { name: 'Invite a doctor' })).toHaveCount(0);
  expect(backend.calls.some((c) => c.path.includes('doctor-invites'))).toBe(false);
  expect(writes(backend)).toEqual([]);

  backend.me = staff('invoices.create');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect.poll(() => backend.live).toBe(false);
  await signInPartner(page);
  await expect(nav(page).getByRole('link', { name: 'Doctors' })).toBeVisible();
  await expect(nav(page).getByRole('link', { name: 'Front desk' })).toHaveCount(0);
  await page.goto('/#/partner/desk');
  await expect(page.getByText('This page does not exist or is not available to your account.')).toBeVisible();

  backend.me = owner(LAB);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect.poll(() => backend.live).toBe(false);
  const before = backend.calls.length;
  await signInPartner(page);
  await expect(nav(page).getByRole('link', { name: 'Front desk' })).toHaveCount(0);
  await expect(nav(page).getByRole('link', { name: 'Doctors' })).toHaveCount(0);
  await page.goto('/#/partner/clinic-doctors');
  await expect(page.getByText('This page does not exist or is not available to your account.')).toBeVisible();
  expect(backend.calls.slice(before).some((c) => c.path.includes('/clinic/'))).toBe(false);
});

test('admin as owner: clinic pages under the partner, switching partners discards the booking form, a lab is only told these are for clinics', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await page.goto(`/#/admin/partners/${CLINIC}`);
  await page.getByRole('link', { name: 'Front desk' }).click();
  await expect(page.getByText('Managing Sunrise Clinic with owner authority.', { exact: false })).toBeVisible();
  await page.getByLabel('Doctor', { exact: true }).selectOption({ label: 'Dr Mehta (General physician)' });
  await freeSlots(page).getByRole('button', { name: 'Book 10:15' }).click();
  await page.getByLabel(/Patient.s mobile number/).fill('9800000009');

  await page.goto(`/#/admin/partners/${CLINIC2}/desk`);
  await expect(page.getByText('Managing Hill Clinic with owner authority.', { exact: false })).toBeVisible();
  await expect(page.getByLabel(/Patient.s mobile number/)).toHaveCount(0);
  await expect(page.getByLabel('Branch').locator('option')).toHaveText(['Hilltop']);
  await page.getByLabel('Doctor', { exact: true }).selectOption({ label: 'Dr Mehta (General physician)' });
  await freeSlots(page).getByRole('button', { name: 'Book 10:15' }).click();
  await fillPatient(page, '9800000011', 'Ravi');
  await expect(page.getByRole('group', { name: 'Book the appointment' })).toContainText('The fee of ₹600.00 is paid at the clinic.');
  await page.getByRole('button', { name: 'Book appointment' }).click();
  await expect(page.getByText('Booked. Ravi with Dr Mehta on Tue, 17 Nov, 2026, 10:15 at Hilltop.', { exact: false })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Make a bill for this visit' }).first()).toHaveAttribute('href', `#/admin/partners/${CLINIC2}/invoices/new`);
  expect(writes(backend)).toEqual([`POST /partner-workspace/admin/${CLINIC2}/workspace/clinic/appointments`]);
  expect(backend.appts.at(-1)!.requestKey).toMatch(new RegExp(`^desk:admin:${ADMIN}:`));

  await page.goto(`/#/admin/partners/${CLINIC}/clinic-doctors`);
  await expect(page.getByRole('heading', { name: 'Doctors', level: 1 })).toBeVisible();
  await page.getByRole('table', { name: 'Invitations to doctors' }).getByRole('button', { name: /Revoke invitation to/ }).click();
  await page.getByRole('button', { name: 'Revoke invitation', exact: true }).click();
  await expect(page.getByText('was revoked', { exact: false })).toBeVisible();
  expect(writes(backend).at(-1)).toBe(`DELETE /partner-workspace/admin/${CLINIC}/workspace/clinic/doctor-invites/${'f0'.repeat(12)}`);

  await page.goto(`/#/admin/partners/${LAB}/desk`);
  await expect(page.getByText('Only for clinics')).toBeVisible();
  await expect(page.getByText('City Lab is a lab.', { exact: false })).toBeVisible();
  await page.goto(`/#/admin/partners/${LAB}`);
  await expect(page.getByRole('link', { name: 'Front desk' })).toHaveCount(0);
  expect(backend.calls.some((c) => c.path.includes(`/admin/${LAB}/workspace/clinic`))).toBe(false);
});
