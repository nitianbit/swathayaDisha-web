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
interface Slot {
  slotId: string; partnerId: string; doctorId: string; branchId: string; date: string; startTime: string; endTime: string; max: number; current: number;
  /** Q13: treated as already started (as if the clock had passed its start). */
  started?: boolean;
}
interface Appt {
  bookingId: string; partnerId: string; bookingDate: string; bookingTime: string; status: string; doctorId: string; doctorName: string; branchId: string;
  slotId: string; consultationMode: string; fee: number; payAtClinic: boolean; arrivedAt: string | null; source: 'desk' | 'online'; paidOnline: boolean;
  patient: Rec; requestKey?: string; requestHash?: string; cancellationReason?: string;
  /** Q14: the appointment's bill (open, else the latest cancelled one). */
  bill?: Rec | null;
  /** Q14: the one no-show move (not on desk rows: deskView carries no history). */
  noShowMoves?: Rec[];
  /** Q13: the Booking's updatedAt (changed by every write). */
  updatedAt: string;
}
interface Backend {
  calls: Call[];
  me: Me;
  appts: Appt[];
  slots: Slot[];
  invites: Rec[];
  /** Q14: admin links made (by request key). */
  links: Rec[];
  /** Q14: bills issued from the desk's appointments. */
  bills: Rec[];
  /** Q14: the next no-show move is made, then its answer is lost. */
  loseNextNoShowMove?: boolean;
  /** WQ11b (Q16a): the next "seen" is refused 409 NOT_STARTED_YET (the server's clock says it has not started). */
  notStartedOnce?: boolean;
  /** Q14: the next admin link is recorded, then its answer is lost. */
  loseNextLink?: boolean;
  /** The next desk booking is recorded, then its answer is lost on the network. */
  loseNextBook?: boolean;
  /** This slot is taken by someone else just before the next booking is decided. */
  takeBeforeBook?: string;
  /** This slot fills up just before the next reschedule is decided. */
  fillBeforeMove?: string;
  /** The day list cannot be read (503). */
  failAppointments?: boolean;
  /** Q13: the next desk booking never reaches the server. */
  dropNextBook?: boolean;
  /** Q13: this slot starts just before the next booking or move is decided (409 SLOT_STARTED). */
  startBeforeBook?: string;
  /** Q13: desk keys given up (`desk:<member>:<key>`): they can never book. */
  abandoned: Set<string>;
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
    s(D1, BR1, '2026-11-17', '09:45', '10:00'), // free, but it has already started: Q13 leaves it out of the list
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
    patient: { name: 'Asha Rao', phone: '9800000001' }, updatedAt: '2026-11-16T05:00:00.000Z', ...o,
  };
}
let version = 0;
/** Every write moves the Booking's updatedAt (Q13 `expectedUpdatedAt` compares it). */
const touch = (a: Appt) => { a.updatedAt = new Date(Date.parse('2026-11-17T04:00:00.000Z') + ++version * 1000).toISOString(); };
function seedAppts(): Appt[] {
  return [
    appt(AP1, {}),
    appt(AP2, { bookingTime: '11:00', slotId: slotIdOf(D1, BR1, '2026-11-17', '11:00'), source: 'online', paidOnline: true, payAtClinic: false, consultationMode: 'in-person',
      patient: { name: 'Bala Shah', relationship: 'mother', accountName: 'Kiran Shah', phone: '9800000002' } }),
    appt(AP3, { bookingTime: '12:00', slotId: slotIdOf(D1, BR1, '2026-11-17', '12:00'), patient: { name: 'Chitra N', phone: '9800000003' } }),
  ];
}

const deskView = (a: Appt) => {
  const { source: _s, paidOnline: _p, patient: _pt, requestKey: _k, requestHash: _h, partnerId: _pid, cancellationReason: _c, bill: _b, noShowMoves: _n, ...rest } = a;
  return rest;
};

const owner = (partnerId = CLINIC): Me => ({ _id: OWNER, partnerId, name: 'Ravi Owner', role: 'owner', permissions: ALL, branchIds: [] });
const staff = (...permissions: string[]): Me => ({ _id: STAFF, partnerId: CLINIC, name: 'Sita Staff', role: 'staff', permissions, branchIds: [] });

async function mockBackend(page: Page, me: Me = owner()): Promise<Backend> {
  await page.clock.setFixedTime(NOW);
  const b: Backend = { calls: [], me, appts: seedAppts(), slots: seedSlots(), live: false, abandoned: new Set(), links: [], bills: [],
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
    { _id: D6, name: 'Dr Pillai', specialization: 'Orthopaedic surgeon', phone: '9844444444' },
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
    // Q14: admins search verified doctors (GET /specialists?search=).
    if (path === '/specialists') {
      if (!admin) return fail(route, 403, 'FORBIDDEN', 'Admin access is required');
      const q = (url.searchParams.get('search') ?? '').toLowerCase();
      const items = specialists.filter((x) => String(x.name).toLowerCase().includes(q) || String(x.phone).includes(q) || String(x.specialization).toLowerCase().includes(q));
      return json(route, 200, { success: true, data: items, pagination: { page: 1, limit: 20, total: items.length, totalPages: 1 } });
    }
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
    // Q14: just enough of the bills routes for a bill made from an appointment.
    if (sub === '/catalogue') return ok(route, [{ _id: 'ca'.repeat(12), partnerId: pid, kind: 'consultation', name: 'Consultation', priceMinor: 50000, gstRate: 0, isActive: true, adminDisabled: false }]);
    if (sub === '/invoices' && method === 'POST') {
      const x = body as { branchId: string; doctorId?: string; appointmentId?: string; customer: Rec; items: Rec[]; idempotencyKey: string };
      const a = x.appointmentId ? b.appts.find((y) => y.bookingId === x.appointmentId && y.partnerId === pid) : undefined;
      if (x.appointmentId && !a) return fail(route, 404, 'APPOINTMENT_NOT_FOUND', 'Appointment not found');
      if (a && a.branchId !== x.branchId) return fail(route, 400, 'APPOINTMENT_BRANCH_MISMATCH', 'Bill the appointment from the branch where it takes place');
      if (a && x.doctorId && a.doctorId !== x.doctorId) return fail(route, 400, 'APPOINTMENT_DOCTOR_MISMATCH', 'The bill names a different doctor than the appointment');
      if (a && a.bill && a.bill.state !== 'cancelled') return fail(route, 409, 'APPOINTMENT_ALREADY_BILLED', 'This appointment already has a bill; cancel it first to issue a new one');
      const total = x.items.reduce((n, l) => n + (l.unitPriceMinor as number) * (l.qty as number), 0);
      const inv = { _id: `b${++seq}`.padEnd(24, '0'), partnerId: pid, branchId: x.branchId, number: seq, financialYear: '2627', serial: `SC/2627/000${seq}`,
        documentKind: 'commercial_invoice', issuedAt: NOW.toISOString(), supplier: { name: 'Sunrise Clinic', address: '1 Main Rd', placeOfSupply: '29' },
        customer: x.customer, ...(x.doctorId ? { doctorId: x.doctorId } : {}), ...(x.appointmentId ? { appointmentId: x.appointmentId } : {}),
        items: x.items.map((l) => ({ ...l, discountMinor: 0, amountMinor: (l.unitPriceMinor as number) * (l.qty as number) })),
        totals: { subtotalMinor: total, discountMinor: 0, taxableMinor: total, cgstMinor: 0, sgstMinor: 0, igstMinor: 0, totalMinor: total, currency: 'INR' },
        lifecycleState: 'issued', lifecycleVersion: 0, paidMinor: 0, dueMinor: total, createdBy: actor._id, idempotencyKey: x.idempotencyKey };
      b.bills.push(inv);
      if (a) a.bill = { invoiceId: inv._id, serial: inv.serial, number: inv.number, state: 'issued' };
      return ok(route, inv, 201);
    }
    // WQ11b: a payment of a whole bill, so the desk's Bill column can be checked after it.
    const pay = /^\/invoices\/([0-9a-f]{24})\/pay$/.exec(sub);
    if (pay && method === 'POST') {
      const inv = b.bills.find((y) => y._id === pay[1]);
      if (!inv) return fail(route, 404, 'INVOICE_NOT_FOUND', 'Invoice not found');
      const total = (inv.totals as Rec).totalMinor as number;
      Object.assign(inv, { lifecycleState: 'paid', lifecycleVersion: (inv.lifecycleVersion as number) + 1, paidMinor: total, dueMinor: 0 });
      const a = b.appts.find((y) => y.bill?.invoiceId === inv._id);
      if (a) a.bill = { ...a.bill, state: 'paid' };
      const event = { _id: `ev${inv.lifecycleVersion}`, invoiceId: inv._id, kind: 'payment', version: inv.lifecycleVersion, at: NOW.toISOString(), mode: 'cash',
        amountMinor: total, requestKey: (body as Rec).requestKey, by: actor._id, byKind: 'member' };
      return ok(route, { invoice: inv, event });
    }
    const bill = /^\/invoices\/([0-9a-f]{24})$/.exec(sub);
    if (bill) {
      const inv = b.bills.find((y) => y._id === bill[1]);
      return inv ? ok(route, { invoice: inv, events: [] }) : fail(route, 404, 'INVOICE_NOT_FOUND', 'Invoice not found');
    }
    if (sub === '/invoices') {
      const appointmentId = url.searchParams.get('appointmentId');
      const items = b.bills.filter((y) => !appointmentId || y.appointmentId === appointmentId);
      return json(route, 200, { success: true, data: items, pagination: { total: items.length, nextCursor: null } });
    }
    if (!sub.startsWith('/clinic/')) return fail(route, 404, 'NOT_FOUND', 'Not found');
    if (p.kind !== 'clinic') return fail(route, 409, 'NOT_A_CLINIC', 'Only clinics work with doctors');

    // ── doctors and invitations ──
    if (sub === '/clinic/doctors' && method === 'GET') return can('staff.manage', 'bookings.view', 'bookings.manage', 'invoices.create') ? ok(route, doctors[pid] ?? []) : deny();
    if (sub === '/clinic/doctor-invites' && method === 'GET') {
      if (!can('staff.manage')) return deny();
      const st = url.searchParams.get('state');
      // Q13: each invitation names its doctor (current name and speciality only).
      return ok(route, b.invites.filter((i) => i.partnerId === pid && (!st || i.state === st)).reverse().map((i) => {
        const sp = specialists.find((x) => x._id === i.doctorId);
        return { ...i, doctor: { doctorId: i.doctorId, name: sp?.name ?? null, specialization: sp?.specialization ?? null } };
      }));
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
    // Q14: an admin links a doctor directly (members 403); the owner or an admin removes one.
    if (sub === '/clinic/doctors' && method === 'POST') {
      if (!ws[1]) return fail(route, 403, 'DOCTOR_LINK_ADMIN_ONLY', 'Doctors are linked to clinics by the platform team after checking');
      const x = body as { doctorId: string; branchIds: string[]; requestKey: string };
      const prior = b.links.find((l) => l.partnerId === pid && l.requestKey === x.requestKey);
      const sp = specialists.find((s) => s._id === x.doctorId);
      const view = (l: Rec, replayed: boolean) => ({ link: l, doctor: { doctorId: x.doctorId, name: sp?.name ?? null, specialization: sp?.specialization ?? null }, memberId: l.memberId, replayed });
      if (prior) return ok(route, view(prior, true));
      if (!sp) return fail(route, 404, 'DOCTOR_NOT_FOUND', 'Doctor not found');
      if ((doctors[pid] ?? []).some((d) => d.doctorId === sp._id)) return fail(route, 409, 'DOCTOR_ALREADY_MEMBER', 'This doctor already consults here');
      const link = { _id: `f${++seq}`.padEnd(24, '0'), partnerId: pid, doctorId: sp._id, branchIds: x.branchIds, state: 'accepted', via: 'admin_link', requestKey: x.requestKey, memberId: `7${seq}`.padEnd(24, '0') };
      b.links.push(link);
      (doctors[pid] ??= []).push({ memberId: link.memberId, doctorId: sp._id, role: 'staff', branchIds: x.branchIds, name: sp.name, specialization: sp.specialization, consultationFee: 700, active: true });
      if (b.loseNextLink) { b.loseNextLink = false; return route.abort('failed'); }
      return ok(route, view(link, false), 201);
    }
    const unlink = /^\/clinic\/doctors\/([0-9a-f]{24})$/.exec(sub);
    if (unlink && method === 'DELETE') {
      if (actor.role !== 'owner') return fail(route, 403, 'OWNER_REQUIRED', 'Only an owner can remove a doctor from the clinic');
      const list = doctors[pid] ?? [];
      const i = list.findIndex((d) => d.doctorId === unlink[1]);
      if (i < 0) return fail(route, 404, 'DOCTOR_NOT_AT_CLINIC', 'This doctor does not consult here');
      list.splice(i, 1);
      return ok(route, { unlinked: true, membershipEnded: true });
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
      const notStarted = (s: Slot) => !s.started && Date.parse(istInstant(s.date, s.startTime)) > NOW.getTime();
      return ok(route, b.slots.filter((s) => s.partnerId === pid && s.doctorId === q.doctorId && s.branchId === q.branchId && s.date === q.date && s.current < s.max && notStarted(s))
        .map((s) => ({ slotId: s.slotId, date: s.date, startTime: s.startTime, endTime: s.endTime, startsAt: istInstant(s.date, s.startTime), seatsLeft: s.max - s.current })));
    }
    if (sub === '/clinic/appointments' && method === 'GET') {
      if (b.failAppointments) return fail(route, 503, 'UNAVAILABLE', 'The appointments could not be read right now');
      const q = Object.fromEntries(url.searchParams);
      return ok(route, b.appts.filter((a) => a.partnerId === pid && a.bookingDate >= ymd(q.from!) && a.bookingDate <= ymd(q.to!)
        && (!q.branchId || a.branchId === q.branchId) && (!q.doctorId || a.doctorId === q.doctorId))
        .sort((x, y) => x.bookingTime.localeCompare(y.bookingTime))
        .map(({ requestKey: _k, requestHash: _h, partnerId: _p, cancellationReason: _c, noShowMoves: _n, ...a }) => ({ ...a, bill: a.bill ?? null })));
    }
    if (!can('bookings.manage')) return deny();
    const started = (s: Slot) => !!s.started || Date.parse(istInstant(s.date, s.startTime)) <= NOW.getTime();
    // Q13: the desk member's own key: look it up, or give it up (used = the appointment it made).
    const byKey = /^\/clinic\/appointments\/by-key\/([A-Za-z0-9_-]{8,100})(\/abandon)?$/.exec(sub);
    if (byKey) {
      const key = `desk:${actor._id}:${byKey[1]}`;
      const made = b.appts.find((a) => a.requestKey === key && a.partnerId === pid);
      if (byKey[2]) {
        if (made) return ok(route, { state: 'used', booking: deskView(made) });
        b.abandoned.add(key);
        return ok(route, { state: 'abandoned' });
      }
      return made ? ok(route, deskView(made)) : fail(route, 404, 'BOOKING_NOT_FOUND', 'No appointment was made with this key');
    }
    if (sub === '/clinic/appointments' && method === 'POST') {
      const x = body as { slotId: string; customer: { phone: string; name?: string }; patient?: { name: string; relation: string }; notes?: string; requestKey: string };
      const key = `desk:${actor._id}:${x.requestKey}`;
      if (b.dropNextBook) { b.dropNextBook = false; return route.abort('failed'); }
      const hash = JSON.stringify([x.slotId, x.customer.phone, x.notes ?? null, ...(x.patient ? [x.patient] : [])]);
      const prior = b.appts.find((a) => a.requestKey === key);
      if (prior) {
        if (prior.requestHash !== hash) return fail(route, 409, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different appointment');
        return ok(route, { booking: deskView(prior), customer: { userId: '99'.repeat(12), phone: x.customer.phone, created: false }, replayed: true });
      }
      if (b.abandoned.has(key)) return fail(route, 409, 'REQUEST_ABANDONED', 'This request was cancelled before it was recorded; make a new one');
      const s = b.slots.find((y) => y.slotId === x.slotId && y.partnerId === pid);
      if (s && b.takeBeforeBook === s.slotId) { s.current = s.max; b.takeBeforeBook = undefined; }
      if (s && b.startBeforeBook === s.slotId) { s.started = true; b.startBeforeBook = undefined; }
      if (s && started(s)) return fail(route, 409, 'SLOT_STARTED', 'This slot has already started; choose a later one');
      if (!s || s.current >= s.max) return fail(route, 409, 'SLOT_NOT_AVAILABLE', 'Slot is not available for booking');
      s.current++;
      const created = !customers.has(x.customer.phone);
      customers.add(x.customer.phone);
      const doc = (doctors[pid] ?? []).find((d) => d.doctorId === s.doctorId)!;
      const a = appt(`9${++seq}`.padEnd(24, '0'), { partnerId: pid, bookingDate: ymd(s.date), bookingTime: s.startTime, doctorId: s.doctorId, doctorName: doc.name as string,
        branchId: s.branchId, slotId: s.slotId, fee: doc.consultationFee as number, requestKey: key, requestHash: hash,
        // Q14: the person seen may be a family member (created under the account with the booking).
        patient: x.patient ? { name: x.patient.name, relationship: x.patient.relation, accountName: x.customer.name, phone: x.customer.phone, dependentId: '5d'.repeat(12) }
          : { name: x.customer.name, phone: x.customer.phone, dependentId: null } });
      touch(a);
      b.appts.push(a);
      if (b.loseNextBook) { b.loseNextBook = false; return route.abort('failed'); }
      await held(sub);
      return ok(route, { booking: { ...deskView(a), dependentId: x.patient ? '5d'.repeat(12) : null }, customer: { userId: '98'.repeat(12), phone: x.customer.phone, created },
        patient: x.patient ? { dependentId: '5d'.repeat(12), name: x.patient.name, relationship: x.patient.relation } : null, replayed: false }, 201);
    }
    // Q14: a desk no-show moved once (keyed, fenced by updatedAt).
    const nsm = /^\/clinic\/appointments\/([0-9a-f]{24})\/reschedule-no-show$/.exec(sub);
    if (nsm) {
      const a = b.appts.find((y) => y.bookingId === nsm[1] && y.partnerId === pid && y.source === 'desk');
      if (!a) return fail(route, 404, 'BOOKING_NOT_FOUND', 'Appointment not found');
      const x = body as { slotId: string; requestKey: string; expectedUpdatedAt?: string };
      const moves = a.noShowMoves ?? [];
      if (moves.some((m) => m.requestKey === x.requestKey)) return ok(route, { ...deskView(a), replayed: true });
      if (moves.length) return fail(route, 409, 'NO_SHOW_RESCHEDULE_USED', 'This booking was already rescheduled once after a no-show; a second no-show is final');
      if (a.status !== 'no_show') return fail(route, 409, 'BOOKING_NOT_NO_SHOW', `A ${a.status} booking is not a no-show`);
      if (x.expectedUpdatedAt !== undefined && x.expectedUpdatedAt !== a.updatedAt) return fail(route, 409, 'BOOKING_CHANGED', 'The appointment changed since it was loaded; reload and try again');
      if (x.slotId === a.slotId) return fail(route, 409, 'SAME_SLOT', 'Pick a later slot');
      const t = b.slots.find((y) => y.slotId === x.slotId && y.partnerId === pid);
      if (!t || t.current >= t.max || t.doctorId !== a.doctorId) return fail(route, 409, 'SLOT_NOT_AVAILABLE', 'Slot is not available for booking');
      t.current++;
      moves.push({ requestKey: x.requestKey, fromDate: a.bookingDate, fromTime: a.bookingTime });
      Object.assign(a, { noShowMoves: moves, status: 'confirmed', slotId: t.slotId, bookingDate: ymd(t.date), bookingTime: t.startTime, branchId: t.branchId, arrivedAt: null });
      touch(a);
      if (b.loseNextNoShowMove) { b.loseNextNoShowMove = false; return route.abort('failed'); }
      return ok(route, { ...deskView(a), replayed: false });
    }
    const one = /^\/clinic\/appointments\/([0-9a-f]{24})\/(arrived|complete|no-show|cancel|reschedule)$/.exec(sub);
    if (one) {
      const a = b.appts.find((y) => y.bookingId === one[1] && y.partnerId === pid && y.source === 'desk');
      if (!a) return fail(route, 404, 'BOOKING_NOT_FOUND', 'Appointment not found');
      const cmd = one[2];
      // Q13: a step names the version it was decided on; any other current version refuses it.
      const expected = (body as { expectedUpdatedAt?: string } | null)?.expectedUpdatedAt;
      if (expected !== undefined && expected !== a.updatedAt) return fail(route, 409, 'BOOKING_CHANGED', 'The appointment changed since it was loaded; reload and try again');
      const free = (slotId: string) => { const s = b.slots.find((y) => y.slotId === slotId); if (s) s.current--; };
      if (cmd === 'arrived') {
        if (a.status !== 'confirmed' || a.arrivedAt) return fail(route, 409, 'BOOKING_STATE_CONFLICT', a.arrivedAt ? 'Already marked as arrived' : `A ${a.status} appointment cannot be checked in`);
        a.arrivedAt = NOW.toISOString();
      } else if (cmd === 'complete' || cmd === 'no-show') {
        if (cmd === 'complete' && b.notStartedOnce) {
          b.notStartedOnce = false;
          return fail(route, 409, 'NOT_STARTED_YET', 'An appointment can be completed only after it has started');
        }
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
        if (t && b.startBeforeBook === t.slotId) { t.started = true; b.startBeforeBook = undefined; }
        if (t && started(t)) return fail(route, 409, 'SLOT_STARTED', 'This slot has already started; choose a later one');
        if (!t || t.current >= t.max || t.doctorId !== a.doctorId) return fail(route, 409, 'SLOT_NOT_AVAILABLE', 'Slot is not available for booking');
        t.current++;
        free(a.slotId);
        Object.assign(a, { slotId: t.slotId, bookingDate: ymd(t.date), bookingTime: t.startTime, branchId: t.branchId, arrivedAt: null });
      }
      touch(a);
      // The answer is the record as this command left it (a held answer may arrive after later changes).
      const answer = deskView(a);
      await held(sub);
      return ok(route, answer);
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

test('Q14 doctors: the list; clinics no longer invite; the owner removes a doctor after a confirmation; earlier invitations can be revoked', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Doctors' }).click();
  await expect(page.getByRole('heading', { name: 'Doctors', level: 1 })).toBeVisible();
  await expect(page.getByText('Doctors are linked to this clinic by the Jansetu team after checking.')).toBeVisible();
  const list = page.getByRole('table', { name: 'Doctors consulting at this clinic' });
  await expect(list.getByRole('row').filter({ hasText: 'Dr Mehta' })).toContainText('All branches');
  await expect(list.getByRole('row').filter({ hasText: 'Dr Mehta' })).toContainText('₹500.00');
  await expect(list.getByRole('row').filter({ hasText: 'Dr Rao' })).toContainText('Koramangala');
  await expect(list.getByRole('row').filter({ hasText: 'Dr Absent' })).toContainText('Not bookable');
  // No invitation can be sent from the clinic any more, and only admins add doctors.
  await expect(page.getByRole('form', { name: 'Invite a doctor' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Add doctor' })).toHaveCount(0);

  // Remove: a confirmation first; Back sends nothing.
  await list.getByRole('button', { name: 'Remove Dr Rao' }).click();
  await expect(page.getByText('Remove Dr Rao from this clinic? New bookings with them here stop at once')).toBeVisible();
  await page.getByRole('group', { name: 'Remove Dr Rao' }).getByRole('button', { name: 'Back' }).click();
  expect(backend.calls.some((c) => c.method === 'DELETE')).toBe(false);
  await list.getByRole('button', { name: 'Remove Dr Rao' }).click();
  await page.getByRole('button', { name: 'Remove from this clinic' }).click();
  await expect(page.getByText('Dr Rao no longer consults here.')).toBeVisible();
  await expect(list.getByRole('row').filter({ hasText: 'Dr Rao' })).toHaveCount(0);
  expect(backend.calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([`/partner-workspace/clinic/doctors/${D2}`]);

  const invites = page.getByRole('table', { name: 'Invitations to doctors' });
  // Q13: the server names the invited doctor (name and speciality).
  await expect(invites.getByRole('row').filter({ hasText: 'Dr Pillai' })).toContainText('Orthopaedic surgeon');
  await expect(page.getByText('Clinics no longer invite doctors, and doctors can no longer accept these.')).toBeVisible();
  await invites.getByRole('button', { name: 'Revoke invitation to Dr Pillai' }).click();
  await expect(page.getByText('Revoke the invitation to Dr Pillai? They can no longer accept it.')).toBeVisible();
  await page.getByRole('button', { name: 'Revoke invitation', exact: true }).click();
  await expect(page.getByText('The invitation to Dr Pillai was revoked. They can no longer accept it.')).toBeVisible();
  await expect(invites).toHaveCount(0);
  expect(backend.calls.filter((c) => c.method === 'POST' && c.path.includes('doctor')).length).toBe(0);
});

test('Q14 admin as owner: find a verified doctor, choose branches, confirm the link; a lost answer is resent with the same key and linked once', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.loseNextLink = true;
  await signInAdmin(page);
  await page.goto(`/#/admin/partners/${CLINIC}/clinic-doctors`);
  const add = page.getByRole('region', { name: 'Add doctor' });
  await expect(page.getByText('Search by the doctor’s full name or speciality (whole words).', { exact: false })).toBeVisible();
  await page.getByLabel('Doctor’s full name or speciality').fill('Dr Iyer');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const found = page.getByRole('table', { name: /Verified doctors matching/ });
  await expect(found.getByRole('row').filter({ hasText: 'Dr Iyer' })).toContainText('9811111111');
  expect(backend.calls.some((c) => c.path === '/specialists?search=Dr+Iyer&isVerified=true&isActive=true&page=1&limit=20')).toBe(true);
  await found.getByRole('button', { name: 'Choose Dr Iyer' }).click();
  const form = page.getByRole('form', { name: 'Add doctor' });
  await form.getByLabel('Every branch, including ones added later').uncheck();
  await expect(form.getByLabel('Store room')).toHaveCount(0);
  await form.getByRole('button', { name: 'Continue' }).click();
  await expect(form.getByText('Choose at least one branch, or every branch.')).toBeVisible();
  await form.getByLabel('Indiranagar').check();
  await form.getByRole('button', { name: 'Continue' }).click();
  await expect(form).toContainText('Link Dr Iyer to this clinic at Indiranagar? They consult here at once (there is no acceptance step)');
  expect(backend.calls.some((c) => c.method === 'POST' && c.path.endsWith('/clinic/doctors'))).toBe(false);
  await form.getByRole('button', { name: 'Link Dr Iyer' }).click();
  // The answer is lost: the same link (same key) is sent again; the server answers the link it made.
  const unsure = page.getByRole('group', { name: 'Unconfirmed doctor link' });
  await expect(unsure).toContainText('Dr Iyer at Indiranagar.');
  await unsure.getByRole('button', { name: 'Send the same request again' }).click();
  await expect(add.getByText('Dr Iyer had already been linked: nothing was done twice.')).toBeVisible();
  const posts = backend.calls.filter((c) => c.method === 'POST' && c.path === `/partner-workspace/admin/${CLINIC}/workspace/clinic/doctors`).map((c) => c.body as Rec);
  expect(posts).toHaveLength(2);
  expect(posts[0]).toEqual({ doctorId: D4, branchIds: [BR1], requestKey: expect.stringMatching(/^[0-9a-f]{32}$/) });
  expect(posts[1]).toEqual(posts[0]);
  expect(backend.links).toHaveLength(1);
  await expect(page.getByRole('table', { name: 'Doctors consulting at this clinic' }).getByRole('row').filter({ hasText: 'Dr Iyer' })).toContainText('Indiranagar');

  // A doctor who already consults here is caught before sending.
  await page.getByLabel('Doctor’s full name or speciality').fill('Mehta');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await found.getByRole('button', { name: 'Choose Dr Mehta' }).click();
  await form.getByRole('button', { name: 'Continue' }).click();
  await expect(form.getByText('Dr Mehta already consults here.')).toBeVisible();
  expect(await storage(page)).not.toMatch(/Iyer|9811111111/);
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
  await expect(review).toContainText('Book Kiran Shah (9800000009) with Dr Mehta on Tue, 17 Nov, 2026, 10:15 at Indiranagar? The fee of ₹500.00 is paid at the clinic. The patient and the doctor will be notified.');
  expect(books(backend)).toHaveLength(0);
  await review.getByRole('button', { name: 'Book appointment' }).click();
  await expect(page.getByText('Booked. Kiran Shah with Dr Mehta on Tue, 17 Nov, 2026, 10:15 at Indiranagar. Fee ₹500.00, paid at the clinic. A Jansetu account was created for this mobile number. The patient and the doctor are notified.')).toBeVisible();
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
  await expect(appointments(page).getByRole('row').filter({ hasText: '9800000009' })).toContainText('Arrived 10:00');
  await expect(page.getByRole('button', { name: 'Mark arrived' })).toHaveCount(0);
  // WQ11b: "seen" waits for the appointment time (10:15; it is 10:00).
  await expect(page.getByRole('button', { name: 'Mark as seen' })).toBeDisabled();
  await expect(page.getByText('A visit can be marked as seen only once the appointment has started.')).toBeVisible();
  await page.clock.setFixedTime(new Date('2026-11-17T04:46:00.000Z')); // 10:16 India time
  await nav(page).getByRole('link', { name: 'Doctors' }).click();
  await openDesk(page);
  await page.getByRole('button', { name: 'Open Kiran Shah at 10:15' }).click();
  await page.getByRole('button', { name: 'Mark as seen' }).click();
  await expect(page.getByText('The fee of ₹500.00 is paid at the clinic: make a bill for it under Bills.', { exact: false })).toBeVisible();
  await page.getByRole('group', { name: 'Mark as seen' }).getByRole('button', { name: 'Mark as seen' }).click();
  await expect(page.getByText('Kiran Shah’s visit is marked as seen.')).toBeVisible();
  await expect(appointments(page).getByRole('row').filter({ hasText: '9800000009' })).toContainText('Seen');
  const id = backend.appts.at(-1)!.bookingId;
  expect(writes(backend)).toEqual([
    'POST /partner-workspace/clinic/appointments',
    `POST /partner-workspace/clinic/appointments/${id}/arrived`,
    `POST /partner-workspace/clinic/appointments/${id}/complete`,
  ]);
  expect(await storage(page)).not.toMatch(/Kiran|9800000009|fever/);
  expect(page.url()).not.toMatch(/9800000009|Kiran/);
});

test('a lost booking answer locks the form; the key finds it (also after a reload) and resending the same request books once', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.loseNextBook = true;
  await signInPartner(page);
  await openDesk(page, 'Dr Mehta (General physician)');
  await freeSlots(page).getByRole('button', { name: 'Book 10:15' }).click();
  await fillPatient(page, '9800000009', 'Kiran Shah');
  await page.getByRole('button', { name: 'Book appointment' }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed booking' });
  await expect(panel).toContainText('The outcome of this request is not known yet');
  await expect(panel).toContainText('Kiran Shah (9800000009) with Dr Mehta on Tue, 17 Nov, 2026, 10:15 at Indiranagar.');
  await expect(page.getByLabel(/Patient.s mobile number/)).toHaveCount(0);
  await expect(freeSlots(page).getByRole('button', { name: 'Book 10:30' })).toBeDisabled();
  await expect(page.getByText('Settle the unconfirmed booking above before booking another.')).toBeVisible();
  // The marker kept for a reload has the key only.
  expect(await storage(page)).not.toMatch(/Kiran|9800000009/);

  // Q13: the check is an exact lookup by the key (no look-alike guess from the day list).
  await panel.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(page.getByText('This booking had already been made; nothing was booked twice. Kiran Shah with Dr Mehta on Tue, 17 Nov, 2026, 10:15 at Indiranagar.')).toBeVisible();
  await expect(panel).toHaveCount(0);
  const [first] = books(backend);
  const key1 = (first!.body as { requestKey: string }).requestKey;
  expect(backend.calls.some((c) => c.path === `/partner-workspace/clinic/appointments/by-key/${key1}`)).toBe(true);
  expect(books(backend)).toHaveLength(1);
  expect(backend.appts.filter((a) => a.patient.phone === '9800000009')).toHaveLength(1);
  await expect(page.getByRole('heading', { name: 'Appointment: Kiran Shah, Tue, 17 Nov, 2026, 10:15' })).toBeVisible();
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.includes('clinic-desk')))).toEqual([]);

  // Lost again; a resend answers with the appointment it made.
  backend.loseNextBook = true;
  await freeSlots(page).getByRole('button', { name: 'Book 10:30' }).click();
  await fillPatient(page, '9800000010', 'Meena');
  await page.getByRole('button', { name: 'Book appointment' }).click();
  await expect(panel).toContainText('The outcome of this request is not known yet');
  await page.reload();
  // After a reload the details are gone, but the key still finds it.
  await expect(panel).toContainText('A request made earlier on this device');
  await expect(panel).not.toContainText('Meena');
  await panel.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(page.getByText('This booking had already been made; nothing was booked twice. The patient with Dr Mehta on Tue, 17 Nov, 2026, 10:30 at Indiranagar.', { exact: false })).toBeVisible();
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Appointment: Meena, Tue, 17 Nov, 2026, 10:30' })).toBeVisible();
  expect(books(backend)).toHaveLength(2);
  expect(await storage(page)).not.toMatch(/Meena|9800000010/);
  // WQ8 review: the receipt's bill is prefilled from the appointment as the server lists it (the details on this device
  // are gone after the reload): the account holder's mobile is there, so issuing is not refused for the customer.
  await page.getByText('This booking had already been made', { exact: false }).getByRole('link', { name: 'Make a bill for this visit' }).click();
  await expect(page.getByLabel('Mobile number (optional)')).toHaveValue('9800000010');
  await expect(page.getByLabel('Customer name')).toHaveValue('Meena');
});

test('WQ8 review: a modified click on "Create bill" (a new tab) hands nothing over; the next "New bill" here starts empty', async ({ page, context }) => {
  await mockBackend(page);
  await signInPartner(page);
  await openDesk(page);
  const row = appointments(page).getByRole('row').filter({ hasText: 'Asha Rao' });
  const popup = context.waitForEvent('page');
  await row.getByRole('link', { name: 'Create bill' }).click({ modifiers: ['ControlOrMeta'] });
  await (await popup).close();
  await expect(page.getByRole('heading', { name: 'Front desk', level: 1 })).toBeVisible();
  await page.goto('/#/partner/invoices/new');
  await expect(page.getByRole('heading', { name: 'New bill' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Appointment' })).toHaveCount(0);
  await expect(page.getByLabel('Customer name')).toHaveValue('');
});

test('Q13: a booking that never arrived is given up on the server after a check, even after a reload; a resend of a given-up key is refused', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.dropNextBook = true;
  await signInPartner(page);
  await openDesk(page, 'Dr Mehta (General physician)');
  await freeSlots(page).getByRole('button', { name: 'Book 10:15' }).click();
  await fillPatient(page, '9800000009', 'Kiran Shah');
  await page.getByRole('button', { name: 'Book appointment' }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed booking' });
  await expect(panel).toContainText('The outcome of this request is not known yet');
  const key1 = (books(backend)[0]!.body as { requestKey: string }).requestKey;
  await page.reload();
  await expect(panel).toContainText('A request made earlier on this device');
  await panel.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(panel).toContainText('Not found in the records. It may still be on its way.');
  await panel.getByRole('button', { name: 'Give up this booking' }).click();
  await expect(page.getByText('The unconfirmed booking was given up: it can never be made. You can book the patient again now.')).toBeVisible();
  expect(backend.abandoned.has(`desk:${OWNER}:${key1}`)).toBe(true);
  expect(writes(backend).at(-1)).toBe(`POST /partner-workspace/clinic/appointments/by-key/${key1}/abandon`);

  // Booking again (a new key): its answer is lost, and its key is given up elsewhere meanwhile. The resend is refused for good.
  await page.getByLabel('Doctor', { exact: true }).selectOption({ label: 'Dr Mehta (General physician)' });
  await freeSlots(page).getByRole('button', { name: 'Book 10:15' }).click();
  await fillPatient(page, '9800000009', 'Kiran Shah');
  backend.dropNextBook = true;
  await page.getByRole('button', { name: 'Book appointment' }).click();
  await expect(panel).toContainText('The outcome of this request is not known yet');
  const key2 = (books(backend).at(-1)!.body as { requestKey: string }).requestKey;
  expect(key2).not.toBe(key1);
  backend.abandoned.add(`desk:${OWNER}:${key2}`);
  await panel.getByRole('button', { name: 'Send the same request again' }).click();
  await expect(page.getByText('This booking was given up earlier, so it was not made and never will be.', { exact: false })).toBeVisible();
  await expect(panel).toHaveCount(0);
  await expect(freeSlots(page).getByRole('button', { name: 'Book 10:15' })).toBeEnabled();
  expect(backend.appts.filter((a) => a.patient.phone === '9800000009')).toHaveLength(0);
  expect(await storage(page)).not.toMatch(/Kiran|9800000009/);
});

test('Q13: started slots are not offered; a slot that starts meanwhile is refused (SLOT_STARTED) with the details kept, as is a move onto one', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await openDesk(page, 'Dr Mehta (General physician)');
  // 09:45 is free but has started (it is 10:00): the server leaves it out, and nothing is marked "(started)".
  await expect(freeSlots(page).getByRole('row')).toHaveText([/Time/, /10:15–10:30/, /10:30–10:45/]);
  await expect(page.getByText('(started)')).toHaveCount(0);
  backend.startBeforeBook = slotIdOf(D1, BR1, '2026-11-17', '10:15');
  await freeSlots(page).getByRole('button', { name: 'Book 10:15' }).click();
  await fillPatient(page, '9800000009', 'Kiran Shah');
  await page.getByRole('button', { name: 'Book appointment' }).click();
  await expect(page.getByText('Not booked: This slot has already started; choose a later one. Choose another time; the patient’s details are kept.')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Unconfirmed booking' })).toHaveCount(0);
  await expect(freeSlots(page).getByRole('row')).toHaveText([/Time/, /10:30–10:45/]);
  await freeSlots(page).getByRole('button', { name: 'Book 10:30' }).click();
  await expect(page.getByLabel(/Patient.s mobile number/)).toHaveValue('9800000009');

  // Moving Chitra onto a slot that starts just before the move is decided: refused, the free slots are read again.
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: 'Open Chitra N at 12:00' }).click();
  await page.getByRole('button', { name: 'Move to another time' }).click();
  const move = page.getByRole('form', { name: 'Move to another time' });
  backend.startBeforeBook = slotIdOf(D1, BR1, '2026-11-17', '10:30');
  await move.getByLabel('New time').selectOption({ label: '10:30–10:45 (1 free)' });
  await move.getByRole('button', { name: 'Continue' }).click();
  await move.getByRole('button', { name: 'Move the appointment' }).click();
  await expect(move).toContainText('Not moved: This slot has already started; choose a later one');
  await expect(move.getByLabel('New time')).toHaveCount(0);
  expect(backend.appts.find((a) => a.bookingId === AP3)!.bookingTime).toBe('12:00');
});

test('Q13: a step names the version it was decided on; a change made elsewhere is refused (BOOKING_CHANGED) and the day is read again', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await openDesk(page);
  await page.getByRole('button', { name: 'Open Chitra N at 12:00' }).click();
  const seen = backend.appts.find((a) => a.bookingId === AP3)!.updatedAt;
  // Someone at another desk checks Chitra in; this page still shows the version it read.
  const other = backend.appts.find((a) => a.bookingId === AP3)!;
  other.arrivedAt = '2026-11-17T04:25:00.000Z';
  other.updatedAt = '2026-11-17T04:25:00.000Z';
  await page.getByRole('button', { name: 'Cancel appointment' }).click();
  await page.getByRole('group', { name: 'Cancel appointment' }).getByRole('button', { name: 'Cancel appointment' }).click();
  await expect(page.getByText('The appointment changed since you opened it (someone else updated it), so nothing was done.', { exact: false })).toBeVisible();
  await expect(appointments(page).getByRole('row').filter({ hasText: 'Chitra N' })).toContainText('Arrived 09:55');
  await expect(page.getByRole('group', { name: 'Cancel appointment' })).toHaveCount(0);
  expect(backend.appts.find((a) => a.bookingId === AP3)!.status).toBe('confirmed');
  const cancels = backend.calls.filter((c) => c.path.endsWith('/cancel'));
  expect(cancels.map((c) => c.body)).toEqual([{ expectedUpdatedAt: seen }]);

  // Decided again on what is shown now: it goes through with the new version (once its time has come: 12:01).
  await page.clock.setFixedTime(new Date('2026-11-17T06:31:00.000Z'));
  await nav(page).getByRole('link', { name: 'Doctors' }).click();
  await openDesk(page);
  await page.getByRole('button', { name: 'Open Chitra N at 12:00' }).click();
  await page.getByRole('button', { name: 'Mark as seen' }).click();
  await page.getByRole('group', { name: 'Mark as seen' }).getByRole('button', { name: 'Mark as seen' }).click();
  await expect(page.getByText('Chitra N’s visit is marked as seen.')).toBeVisible();
  expect(backend.calls.find((c) => c.path.endsWith('/complete'))!.body).toEqual({ expectedUpdatedAt: '2026-11-17T04:25:00.000Z' });
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
  await expect(page.getByText('A no-show can be marked 15 minutes after the appointment time.')).toBeVisible();

  // 09:30 has passed.
  await page.getByRole('button', { name: 'Open Asha Rao at 09:30' }).click();
  await page.getByRole('button', { name: 'Mark did not come' }).click();
  const noShow = page.getByRole('group', { name: 'Mark did not come' });
  await expect(noShow).toContainText('Mark Asha Rao as not come for Tue, 17 Nov, 2026, 09:30? The appointment ends and the doctor’s time is freed. Nothing is charged or refunded through Jansetu: desk appointments are paid at the clinic.');
  // WQ11b: the desk list does not say whether it was moved once already, so no move is promised outright.
  await expect(noShow).toContainText('Afterwards the desk may move it once to a new time, unless it was already moved after an earlier no-show: then this second no-show is final. This cannot be undone.');
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
  expect(backend.calls.find((c) => c.path.endsWith('/cancel'))!.body).toEqual({ reason: 'Doctor away', expectedUpdatedAt: '2026-11-16T05:00:00.000Z' });
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
  await expect(page.getByText('Moved to Wed, 18 Nov, 2026, 11:15 at Indiranagar. The patient and the doctor are notified.')).toBeVisible();
  await expect(appointments(page).getByRole('row').filter({ hasText: 'Chitra N' })).toHaveCount(0);
  const moves = backend.calls.filter((c) => c.path.endsWith('/reschedule'));
  expect(moves.map((c) => c.body)).toEqual([
    { slotId: slotIdOf(D1, BR1, '2026-11-18', '11:00'), expectedUpdatedAt: '2026-11-16T05:00:00.000Z' },
    { slotId: slotIdOf(D1, BR1, '2026-11-18', '11:15'), expectedUpdatedAt: '2026-11-16T05:00:00.000Z' },
  ]);
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
  // Q13: the appointment changed (it is checked in now), so the confirmation opened on the older version closes.
  await expect(cancel).toHaveCount(0);

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

test('a held step answer from a page that was left never overwrites a newer change; a failed re-read offers no stale appointment', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await openDesk(page);
  await page.getByRole('button', { name: 'Open Chitra N at 12:00' }).click();
  const release = hold(backend, /\/arrived$/);
  await page.getByRole('button', { name: 'Mark arrived' }).click();
  await expect.poll(() => backend.calls.some((c) => c.path.endsWith('/arrived'))).toBe(true);

  // Leave and come back; meanwhile the appointment is moved to 10:30 (which clears its check-in).
  await nav(page).getByRole('link', { name: 'Doctors' }).click();
  await expect(page.getByRole('heading', { name: 'Doctors', level: 1 })).toBeVisible();
  await openDesk(page);
  await page.getByRole('button', { name: 'Open Chitra N at 12:00' }).click();
  await page.getByRole('button', { name: 'Move to another time' }).click();
  const move = page.getByRole('form', { name: 'Move to another time' });
  await move.getByLabel('New time').selectOption({ label: '10:30–10:45 (1 free)' });
  await move.getByRole('button', { name: 'Continue' }).click();
  await move.getByRole('button', { name: 'Move the appointment' }).click();
  // Q13: the day shown was the cached copy from before the check-in (the server already acted; only its answer is held),
  // so the move named an older version and is refused; the day is read again and shows the check-in.
  await expect(page.getByText('The appointment changed since you opened it', { exact: false }).first()).toBeVisible();
  await expect(appointments(page).getByRole('row').filter({ hasText: 'Chitra N' })).toContainText('Arrived');
  expect(backend.appts.find((a) => a.bookingId === AP3)!.bookingTime).toBe('12:00');
  // Decided again on the version shown now: the move goes through.
  await page.getByRole('button', { name: 'Move to another time' }).click();
  await move.getByLabel('New time').selectOption({ label: '10:30–10:45 (1 free)' });
  await move.getByRole('button', { name: 'Continue' }).click();
  await move.getByRole('button', { name: 'Move the appointment' }).click();
  await expect(page.getByText('Moved to Tue, 17 Nov, 2026, 10:30 at Indiranagar.', { exact: false })).toBeVisible();
  await expect(appointments(page).getByRole('row').filter({ hasText: 'Chitra N' })).toContainText('10:30');
  await expect(page.getByRole('heading', { name: 'Appointment: Chitra N, Tue, 17 Nov, 2026, 10:30' })).toBeVisible();

  // The old "arrived" answer (12:00, checked in) lands now, and the day cannot be read again.
  backend.failAppointments = true;
  release();
  await expect(page.getByText('The appointments could not be read right now')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('heading', { name: /Appointment: Chitra N/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Mark|Move to another time|Cancel appointment/ })).toHaveCount(0);
  await expect(page.getByText(/12:00/)).toHaveCount(0);
  await expect(page.getByText('Chitra N is marked as arrived.')).toHaveCount(0);

  // Once the day can be read again: the newer time, not checked in.
  backend.failAppointments = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(appointments(page).getByRole('row').filter({ hasText: 'Chitra N' })).toContainText('10:30');
  await expect(appointments(page).getByRole('row').filter({ hasText: 'Chitra N' })).not.toContainText('Arrived');
  await expect(page.getByRole('heading', { name: 'Appointment: Chitra N, Tue, 17 Nov, 2026, 10:30' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark arrived' })).toBeEnabled();
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
  await expect(page.getByRole('button', { name: /^Remove/ })).toHaveCount(0);
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

test('Q14 family members: the desk books a family member by name and relation (never browsing the account’s family); the list shows who is seen', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await openDesk(page, 'Dr Mehta (General physician)');
  await freeSlots(page).getByRole('button', { name: 'Book 10:15' }).click();
  await page.getByLabel(/Patient.s mobile number/).fill('9800000002');
  await page.getByLabel('A family member of the account holder').check();
  await page.getByLabel(/Account holder.s name/).fill('Kiran Shah');
  await page.getByRole('button', { name: 'Review the booking' }).click();
  await expect(page.getByText('Enter the family member’s name.')).toBeVisible();
  await expect(page.getByText('Choose how they are related to the account holder.')).toBeVisible();
  await page.getByLabel('Family member’s name').fill('  Meena   Shah ');
  await page.getByLabel('Relation to the account holder').selectOption('Mother');
  await page.getByLabel('Gender (optional)').selectOption('Female');
  await page.getByLabel('Date of birth (optional)').fill('2026-12-01');
  await page.getByRole('button', { name: 'Review the booking' }).click();
  await expect(page.getByText('Enter a real date that is not in the future.')).toBeVisible();
  await page.getByLabel('Date of birth (optional)').fill('1958-03-04');
  await page.getByRole('button', { name: 'Review the booking' }).click();
  const review = page.getByRole('group', { name: 'Book the appointment' });
  await expect(review).toContainText('Book Meena Shah (Mother of the account holder of 9800000002) with Dr Mehta on Tue, 17 Nov, 2026, 10:15 at Indiranagar?');
  await expect(review).toContainText('The patient and the doctor will be notified.');
  await review.getByRole('button', { name: 'Book appointment' }).click();
  await expect(page.getByText('Booked. Meena Shah (Mother) with Dr Mehta on Tue, 17 Nov, 2026, 10:15 at Indiranagar.', { exact: false })).toBeVisible();
  // Q14 review: the answer does not say whether the family member is new, so the receipt does not either.
  await expect(page.getByText(/added to the account/)).toHaveCount(0);
  const [post] = books(backend);
  expect(post!.body).toEqual({ slotId: slotIdOf(D1, BR1, '2026-11-17', '10:15'), customer: { phone: '9800000002', name: 'Kiran Shah' },
    patient: { name: 'Meena Shah', relation: 'Mother', gender: 'Female', dateOfBirth: '1958-03-04' }, requestKey: expect.stringMatching(/^[0-9a-f]{32}$/) });
  await expect(appointments(page).getByRole('row').filter({ hasText: 'Meena Shah' })).toContainText('Mother of Kiran Shah');
  // No family list is ever read from the desk.
  expect(backend.calls.some((c) => /dependents|family|customers/.test(c.path))).toBe(false);
  expect(await storage(page)).not.toMatch(/Meena|9800000002/);
});

test('Q14 desk no-show: moved once to a later slot after a confirmation (key and version); a lost answer is settled by the day read again; a second move is refused', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.appts.find((a) => a.bookingId === AP1)!.status = 'no_show';
  backend.loseNextNoShowMove = true;
  await signInPartner(page);
  await openDesk(page);
  await page.getByRole('button', { name: 'Open Asha Rao at 09:30' }).click();
  await expect(page.getByText('Did not come. Nothing is charged or refunded through Jansetu, and the doctor earns nothing for it.')).toBeVisible();
  await page.getByRole('button', { name: 'Reschedule no-show' }).click();
  const form = page.getByRole('form', { name: 'Reschedule no-show' });
  await form.getByLabel('New day').fill('2026-11-18');
  await form.getByLabel('New time').selectOption({ label: '11:00–11:15 (1 free)' });
  await form.getByRole('button', { name: 'Continue' }).click();
  await expect(form).toContainText('Move Asha Rao’s missed time (Tue, 17 Nov, 2026, 09:30) to Wed, 18 Nov, 2026, 11:00 at Indiranagar? It is booked again at the same price: nothing is paid or refunded.');
  await expect(form).toContainText('the patient and the doctor are notified of the new time');
  await form.getByRole('button', { name: 'Move to Wed, 18 Nov, 2026, 11:00 at Indiranagar' }).click();
  // The move was made but its answer was lost: the day read again no longer has the appointment (a no-show leaves its
  // day only by its one move). A read made after the attempt settles it; the page clock moves on so the read is later.
  await expect(appointments(page).getByRole('row').filter({ hasText: 'Asha Rao' })).toHaveCount(0);
  await page.clock.setFixedTime(new Date(NOW.getTime() + 60_000));
  await page.getByRole('button', { name: 'Next day' }).click();
  await page.getByRole('button', { name: 'Previous day' }).click();
  await expect(page.getByText(/no-show has been moved to a new time \(it can be moved only once\)/)).toBeVisible();
  const moves = backend.calls.filter((c) => c.path.endsWith('/reschedule-no-show'));
  expect(moves).toHaveLength(1);
  expect(moves[0]!.body).toEqual({ slotId: slotIdOf(D1, BR1, '2026-11-18', '11:00'), requestKey: expect.stringMatching(/^[0-9a-f]{32}$/), expectedUpdatedAt: '2026-11-16T05:00:00.000Z' });
  await page.getByRole('button', { name: 'Next day' }).click();
  await expect(appointments(page).getByRole('row').filter({ hasText: 'Asha Rao' })).toContainText('Booked');

  // Marked a no-show again: the server refuses a second move; the page says it is final.
  const a = backend.appts.find((x) => x.bookingId === AP1)!;
  a.status = 'no_show';
  touch(a);
  await page.reload();
  await openDesk(page);
  await page.getByLabel('Day').fill('2026-11-18');
  await page.getByRole('button', { name: 'Open Asha Rao at 11:00' }).click();
  const form2 = page.getByRole('form', { name: 'Reschedule no-show' });
  await page.getByRole('button', { name: 'Reschedule no-show' }).click();
  await form2.getByLabel('New time').selectOption({ index: 1 });
  await form2.getByRole('button', { name: 'Continue' }).click();
  await form2.getByRole('button', { name: /^Move to/ }).click();
  await expect(page.getByText('This booking was already moved once after a no-show. A second no-show is final, so it cannot be moved again.')).toBeVisible();
});

test('Q14 bill for an appointment: "Create bill" opens the form with the patient, doctor and appointment; the row then shows the bill; a second bill is refused', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await openDesk(page);
  const row = appointments(page).getByRole('row').filter({ hasText: 'Asha Rao' });
  await row.getByRole('link', { name: 'Create bill' }).click();
  await expect(page.getByRole('heading', { name: 'New bill' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Appointment' })).toContainText('For the clinic appointment with Dr Mehta, Tue, 17 Nov, 2026, 09:30.');
  await expect(page.getByLabel('Customer name')).toHaveValue('Asha Rao');
  await expect(page.getByLabel('Mobile number (optional)')).toHaveValue('9800000001');
  await expect(page.getByLabel('Branch', { exact: true })).toHaveValue(BR1);
  await expect(page.getByLabel('Branch', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Doctor (optional)')).toHaveValue(D1);
  // The bill's customer is the appointment's account holder: fixed while linked.
  await expect(page.getByLabel('Customer name')).not.toBeEditable();
  await expect(page.getByLabel('Mobile number (optional)')).not.toBeEditable();
  // Nothing about the patient travels in the URL or browser storage.
  expect(page.url()).not.toMatch(/Asha|9800000001|e1e1/);
  expect(await storage(page)).not.toMatch(/Asha|9800000001/);
  await page.getByLabel('From the catalogue').selectOption({ label: 'Consultation · ₹500.00' });
  await page.getByRole('button', { name: 'Add item' }).click();
  await page.getByRole('button', { name: 'Review the bill' }).click();
  await expect(page.getByRole('group', { name: 'Issue the bill' })).toContainText('for the appointment with Dr Mehta, Tue, 17 Nov, 2026, 09:30?');
  await page.getByRole('button', { name: 'Issue bill' }).click();
  await expect(page.getByText(/^Bill SC\/2627\/000\d+ issued\./)).toBeVisible();
  const create = backend.calls.find((c) => c.method === 'POST' && c.path === '/partner-workspace/invoices')!;
  expect(create.body).toMatchObject({ branchId: BR1, doctorId: D1, appointmentId: AP1, customer: { name: 'Asha Rao', phone: '9800000001' } });
  // The bill shows its appointment, with the bills of that appointment one click away.
  await expect(page.getByRole('definition').filter({ hasText: `Clinic appointment …${AP1.slice(-6)}` })).toBeVisible();

  // Back at the desk the row shows the bill's number and status instead of "Create bill".
  await page.goto('/#/partner/desk');
  await expect(row.getByRole('link', { name: /^Bill SC\/2627\/000\d+, Unpaid$/ })).toBeVisible();
  await expect(row.getByRole('link', { name: 'Create bill' })).toHaveCount(0);

  // A second bill from a form opened before (another tab): refused, and said in plain words.
  backend.appts.find((a) => a.bookingId === AP3)!.bill = { invoiceId: 'bb'.repeat(12), serial: 'SC/2627/0099', number: 99, state: 'issued' };
  await appointments(page).getByRole('row').filter({ hasText: 'Chitra N' }).getByRole('link', { name: 'Create bill' }).click();
  await page.getByLabel('From the catalogue').selectOption({ label: 'Consultation · ₹500.00' });
  await page.getByRole('button', { name: 'Add item' }).click();
  await page.getByRole('button', { name: 'Review the bill' }).click();
  await page.getByRole('button', { name: 'Issue bill' }).click();
  await expect(page.getByText('Not issued: This appointment already has a bill. Open it from the front desk; cancel it first to issue a new one.')).toBeVisible();
});

test('WQ11b: after a bill is paid, the desk row shows it paid (the Bill column is read again, not the cached day)', async ({ page }) => {
  await mockBackend(page);
  await signInPartner(page);
  await openDesk(page);
  const row = appointments(page).getByRole('row').filter({ hasText: 'Asha Rao' });
  await row.getByRole('link', { name: 'Create bill' }).click();
  await page.getByLabel('From the catalogue').selectOption({ label: 'Consultation · ₹500.00' });
  await page.getByRole('button', { name: 'Add item' }).click();
  await page.getByRole('button', { name: 'Review the bill' }).click();
  await page.getByRole('button', { name: 'Issue bill' }).click();
  await expect(page.getByText(/^Bill SC\/2627\/000\d+ issued\./)).toBeVisible();
  await page.goto('/#/partner/desk');
  await expect(row.getByRole('link', { name: /^Bill SC\/2627\/000\d+, Unpaid$/ })).toBeVisible();
  await row.getByRole('link', { name: /^Bill SC\/2627\/000\d+, Unpaid$/ }).click();
  await page.getByRole('button', { name: 'Record payment' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Record ₹500.00 paid' }).click();
  await expect(page.getByText('Payment recorded.')).toBeVisible();
  await page.goto('/#/partner/desk');
  await expect(row.getByRole('link', { name: /^Bill SC\/2627\/000\d+, Paid$/ })).toBeVisible();
});

test('WQ11b: "seen" refused NOT_STARTED_YET is said in plain words; a no-show of an appointment moved once already says it is final', async ({ page }) => {
  const backend = await mockBackend(page);
  // When the server lists the no-show history, the desk knows this appointment was moved once after a no-show.
  Object.assign(backend.appts.find((a) => a.bookingId === AP1)!, { noShowReschedules: 1 });
  await signInPartner(page);
  await openDesk(page);
  await page.getByRole('button', { name: 'Open Asha Rao at 09:30' }).click();
  backend.notStartedOnce = true;
  await page.getByRole('button', { name: 'Mark as seen' }).click();
  const seen = page.getByRole('group', { name: 'Mark as seen' });
  await seen.getByRole('button', { name: 'Mark as seen' }).click();
  await expect(seen).toContainText('The appointment has not started yet, so it was not marked as seen. Mark it once the appointment time has come.');
  await seen.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: 'Mark did not come' }).click();
  const noShow = page.getByRole('group', { name: 'Mark did not come' });
  await expect(noShow).toContainText('It was already moved once after an earlier no-show, so this second no-show is final: it cannot be moved to a new time.');
  await expect(noShow).not.toContainText('may move it once');
});

test('WQ11b: a desk no-show move lost, then refused on the resend (time taken): Back resets the choice; a new time is chosen as a new move without a reload', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.appts.find((a) => a.bookingId === AP1)!.status = 'no_show';
  let dropped = false;
  await page.route('**/api/v1/**/reschedule-no-show', async (route) => {
    if (!dropped) { dropped = true; return route.abort('failed'); }
    return route.fallback();
  });
  await signInPartner(page);
  await openDesk(page);
  await page.getByRole('button', { name: 'Open Asha Rao at 09:30' }).click();
  await page.getByRole('button', { name: 'Reschedule no-show' }).click();
  const form = page.getByRole('form', { name: 'Reschedule no-show' });
  await form.getByLabel('New day').fill('2026-11-18');
  await form.getByLabel('New time').selectOption({ label: '11:00–11:15 (1 free)' });
  await form.getByRole('button', { name: 'Continue' }).click();
  // Back shows the picker again with nothing chosen, and the choice starts again too.
  await form.getByRole('button', { name: 'Back' }).click();
  await expect(form.getByLabel('New day')).toBeVisible();
  await form.getByRole('button', { name: 'Continue' }).click();
  await expect(form.getByText('Choose the new time.')).toBeVisible();
  await form.getByLabel('New day').fill('2026-11-18');
  await form.getByLabel('New time').selectOption({ label: '11:00–11:15 (1 free)' });
  await form.getByRole('button', { name: 'Continue' }).click();
  await form.getByRole('button', { name: /^Move to/ }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed no-show move' });
  await expect(panel).toContainText('has not been confirmed');
  const target = backend.slots.find((s) => s.slotId === slotIdOf(D1, BR1, '2026-11-18', '11:00'))!;
  target.current = target.max; // someone else takes that time
  await page.clock.setFixedTime(new Date(NOW.getTime() + 60_000));
  await panel.getByRole('button', { name: 'Send the same move again' }).click();
  await expect(panel).toContainText('That time is no longer free. Pick another time.');
  await page.clock.setFixedTime(new Date(NOW.getTime() + 120_000));
  await panel.getByRole('button', { name: 'Check the booking' }).click();
  await panel.getByRole('button', { name: 'Choose a new time again' }).click();
  await panel.getByRole('button', { name: 'Forget it and choose again' }).click();
  const again = page.getByRole('form', { name: 'Reschedule no-show' });
  await again.getByLabel('New day').fill('2026-11-18');
  await again.getByLabel('New time').selectOption({ label: '11:15–11:30 (1 free)' });
  await again.getByRole('button', { name: 'Continue' }).click();
  await again.getByRole('button', { name: /^Move to/ }).click();
  await expect(page.getByText(/Asha Rao’s no-show is moved to Wed, 18 Nov, 2026, 11:15/)).toBeVisible();
  const moves = backend.calls.filter((c) => c.path.endsWith('/reschedule-no-show'));
  // The dropped first attempt never reached the mock: the refused resend (same key) and the new move (a new key).
  expect(moves.map((c) => (c.body as Rec).slotId)).toEqual([slotIdOf(D1, BR1, '2026-11-18', '11:00'), slotIdOf(D1, BR1, '2026-11-18', '11:15')]);
  expect((moves[1]!.body as Rec).requestKey).not.toBe((moves[0]!.body as Rec).requestKey);
});

test('WQ11b: keyboard focus moves into a confirmation when it opens and back to its button on Back', async ({ page }) => {
  await mockBackend(page);
  await signInPartner(page);
  await openDesk(page);
  await page.getByRole('button', { name: 'Open Asha Rao at 09:30' }).click();
  await page.getByRole('button', { name: 'Cancel appointment' }).focus();
  await page.keyboard.press('Enter');
  const group = page.getByRole('group', { name: 'Cancel appointment' });
  await expect(group.getByLabel('Reason (optional)')).toBeFocused();
  await group.getByRole('button', { name: 'Back' }).focus();
  await page.keyboard.press('Enter');
  await expect(group).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel appointment' })).toBeFocused();
});
