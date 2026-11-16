import { expect, test, type Page, type Route } from '@playwright/test';

/** WQ3: lab slots, online lab bookings and reports (members and admins acting as owner), against a mocked backend. */
const LAB = 'a1'.repeat(12);
const LAB2 = 'a3'.repeat(12);
const CLINIC = 'a2'.repeat(12);
const OWNER = 'b1'.repeat(12);
const STAFF = 'b2'.repeat(12);
const PATH = 'b3'.repeat(12);
const NOREG = 'b4'.repeat(12);
const ADMIN = 'ad'.repeat(12);
const BR1 = 'c1'.repeat(12);
const BR2 = 'c2'.repeat(12);
const BK1 = 'e1'.repeat(12);
const BK2 = 'e2'.repeat(12);
const BK3 = 'e3'.repeat(12);
const BK4 = 'e4'.repeat(12);
const BK5 = 'e5'.repeat(12);
const ALL = ['staff.manage', 'branches.manage', 'catalogue.manage', 'slots.manage', 'bookings.view', 'bookings.manage', 'reports.upload',
  'reports.release', 'invoices.create', 'invoices.cancel', 'payments.record', 'finance.view'];
/** Tuesday 17 Nov 2026, 10:00 in India. */
const NOW = new Date('2026-11-17T04:30:00.000Z');

type Rec = Record<string, unknown>;
type Mode = 'home' | 'lab';
interface Me { _id: string; partnerId: string; name: string; role: 'owner' | 'staff'; permissions: string[]; branchIds: string[] }
interface Call { method: string; path: string; body: unknown; auth?: string; files?: string[] }
interface Slot { _id: string; partnerId: string; branchId: string; visitMode: Mode; date: string; startTime: string; endTime: string;
  startsAt: string; endsAt: string; capacity: number; booked: number; closed: null | 'holiday' | 'template' | 'manual'; source: 'template' | 'manual' }
interface Backend {
  calls: Call[];
  me: Me;
  slots: Slot[];
  bookings: Rec[];
  /** A booking lands on this slot just before the next capacity change is decided. */
  bookBeforeCapacity?: string;
  /** This slot fills up just before the next reschedule is decided. */
  fillBeforeReschedule?: string;
  /** The answer to the next request whose path matches waits for `release()` (the server has already acted). */
  hold?: { match: RegExp; gate: Promise<void> };
  live: boolean;
}

const istInstant = (date: string, hhmm: string) => new Date(Date.parse(`${date}T${hhmm}:00+05:30`)).toISOString();
const plus = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const weekday = (date: string) => ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(`${date}T00:00:00Z`).getUTCDay()]!;
const slotId = (mode: Mode, date: string, time: string, partner = LAB) =>
  `${partner === LAB ? '' : '9'}${mode === 'home' ? '1' : '2'}${date.replace(/-/g, '')}${time.replace(':', '')}`.padStart(24, 'a');
const TIMES: readonly (readonly [string, string])[] = [['09:00', '09:30'], ['09:30', '10:00'], ['10:00', '10:30'], ['10:30', '11:00']];

function slot(mode: Mode, date: string, start: string, end: string, o: Partial<Slot> = {}, partner = LAB): Slot {
  return { _id: slotId(mode, date, start, partner), partnerId: partner, branchId: partner === LAB ? BR1 : BR2, visitMode: mode, date, startTime: start, endTime: end,
    startsAt: istInstant(date, start), endsAt: istInstant(date, end), capacity: 2, booked: 0, closed: null, source: 'template', ...o };
}

/** Template slots Mon–Sat 09:00–11:00 (30 min, 2 seats) for two weeks from Monday 16 Nov, both visit modes. */
function seedSlots(): Slot[] {
  const out: Slot[] = [];
  for (let i = 0; i < 14; i++) {
    const date = plus('2026-11-16', i);
    if (weekday(date) === 'sun') continue;
    for (const mode of ['home', 'lab'] as Mode[]) for (const [s, e] of TIMES) out.push(slot(mode, date, s, e));
  }
  const at = (mode: Mode, date: string, time: string) => out.find((x) => x._id === slotId(mode, date, time))!;
  at('home', '2026-11-17', '09:00').booked = 1; // BK1
  at('lab', '2026-11-18', '09:00').booked = 1; // BK2
  at('home', '2026-11-16', '09:00').booked = 1; // BK3
  at('home', '2026-11-19', '09:00').closed = 'holiday';
  at('home', '2026-11-18', '10:30').closed = 'manual';
  out.push(slot('lab', '2026-11-18', '09:00', '09:30', {}, LAB2));
  return out;
}

function booking(id: string, o: Rec): Rec {
  const s = (o.slotSnap as Rec | undefined) ?? { slotId: slotId('home', '2026-11-17', '09:00'), date: '2026-11-17', startTime: '09:00', endTime: '09:30', startsAt: istInstant('2026-11-17', '09:00') };
  const { slotSnap: _s, ...rest } = o;
  return {
    _id: id, partnerId: LAB, branchId: BR1, userId: '99'.repeat(12), patient: { kind: 'self', name: 'Asha Rao', age: 34, gender: 'female' },
    visitMode: 'home', address: { line1: '12 Lake View', city: 'Bengaluru', pincode: '560038' }, slot: s,
    items: [{ catalogItemId: 'd1'.repeat(12), kind: 'test', name: 'CBC', code: 'CBC01', priceMinor: 45000, gstRate: 0, reportTatHours: 12 }],
    pricing: { subtotalMinor: 45000, discountMinor: 0, payableMinor: 45000, commissionMinor: 0, currency: 'INR' },
    status: 'confirmed', statusVersion: 1, paymentStatus: 'paid', paymentDeadline: '2026-11-15T05:00:00.000Z',
    reschedule: { version: 0, pending: false }, report: { draftFiles: [], releasedFiles: [], releases: [] },
    lifecycle: { paidAt: '2026-11-15T04:40:00.000Z', confirmedAt: '2026-11-15T04:40:00.000Z' }, createdAt: '2026-11-15T04:35:00.000Z', ...rest,
  };
}
const file = (id: string, name: string) => `/api/static/partner-lab-reports/${id}/${name}`;

function seedBookings(): Rec[] {
  return [
    booking(BK1, {}),
    booking(BK2, { patient: { kind: 'dependent', name: 'Bala Rao', age: 61 }, visitMode: 'lab', address: undefined,
      slotSnap: { slotId: slotId('lab', '2026-11-18', '09:00'), date: '2026-11-18', startTime: '09:00', endTime: '09:30', startsAt: istInstant('2026-11-18', '09:00') } }),
    booking(BK3, { patient: { kind: 'self', name: 'Chitra N' }, status: 'processing', statusVersion: 3,
      slotSnap: { slotId: slotId('home', '2026-11-16', '09:00'), date: '2026-11-16', startTime: '09:00', endTime: '09:30', startsAt: istInstant('2026-11-16', '09:00') } }),
    booking(BK4, { patient: { kind: 'self', name: 'Dev Unpaid' }, status: 'pending_payment', paymentStatus: 'pending', statusVersion: 0,
      paymentDeadline: '2026-11-17T05:00:00.000Z', lifecycle: {} }),
    booking(BK5, { partnerId: LAB2, branchId: BR2, patient: { kind: 'self', name: 'Esha K' }, status: 'report_ready', statusVersion: 5, visitMode: 'lab',
      report: {
        draftFiles: [file(BK5, 'lipid.pdf')], releasedFiles: [file(BK5, 'cbc.pdf'), file(BK5, 'page2.png')],
        releases: [
          { path: `partner-lab-reports/${BK5}/cbc.pdf`, releasedAt: '2026-11-16T10:00:00.000Z', releasedBy: PATH, signer: { memberId: PATH, name: 'Dr Path', kind: 'pathologist', registrationNumber: 'KMC-77' } },
          { path: `partner-lab-reports/${BK5}/page2.png`, releasedAt: '2026-11-16T10:05:00.000Z', releasedBy: PATH, signer: { memberId: PATH, name: 'Dr Path', kind: 'pathologist', registrationNumber: 'KMC-77' } },
        ],
      } }),
  ];
}

const owner = (partnerId = LAB): Me => ({ _id: OWNER, partnerId, name: 'Ravi Owner', role: 'owner', permissions: ALL, branchIds: [] });
const staff = (...permissions: string[]): Me => ({ _id: STAFF, partnerId: LAB, name: 'Sita Staff', role: 'staff', permissions, branchIds: [BR1] });

async function mockBackend(page: Page, me: Me = owner()): Promise<Backend> {
  await page.clock.setFixedTime(NOW);
  const b: Backend = { calls: [], me, slots: seedSlots(), bookings: seedBookings(), live: false };
  const partners: Rec[] = [
    { _id: LAB, kind: 'lab', name: 'City Lab', contact: { phone: '9000000000' }, verification: { state: 'verified' }, taxRegime: 'unregistered', invoiceSeries: { prefix: 'LB' }, activeOwnerCount: 1, isActive: true },
    { _id: LAB2, kind: 'lab', name: 'Lake Lab', contact: { phone: '9000000009' }, verification: { state: 'verified' }, taxRegime: 'unregistered', invoiceSeries: { prefix: 'LK' }, activeOwnerCount: 1, isActive: true },
    { _id: CLINIC, kind: 'clinic', name: 'Sunrise Clinic', contact: { phone: '9000000008' }, verification: { state: 'verified' }, taxRegime: 'unregistered', invoiceSeries: { prefix: 'CL' }, activeOwnerCount: 1, isActive: true },
  ];
  const branches: Record<string, Rec[]> = {
    [LAB]: [
      { _id: BR1, partnerId: LAB, name: 'Indiranagar', address: { line1: '1 Main Rd', city: 'Bengaluru', state: 'Karnataka', stateCode: '29', pincode: '560038' }, phone: '9000000010',
        services: { homeCollection: true, inLab: true }, hours: { mon: { open: '08:00', close: '12:00' } }, isActive: true },
    ],
    [LAB2]: [
      { _id: BR2, partnerId: LAB2, name: 'Lakeside', address: { line1: '2 Lake Rd', city: 'Bengaluru', state: 'Karnataka', stateCode: '29', pincode: '560001' }, phone: '9000000011',
        services: { homeCollection: false, inLab: true }, isActive: true },
    ],
    [CLINIC]: [],
  };
  const members: Record<string, Rec[]> = {
    [LAB]: [
      { _id: OWNER, partnerId: LAB, name: 'Ravi Owner', phone: '9000000001', role: 'owner', permissions: ALL, branchIds: [], isActive: true, professional: { kind: 'pathologist', registrationNumber: 'KMC-11' } },
      { _id: STAFF, partnerId: LAB, name: 'Sita Staff', phone: '9000000002', role: 'staff', permissions: ['bookings.manage'], branchIds: [BR1], isActive: true },
    ],
    [LAB2]: [
      { _id: PATH, partnerId: LAB2, name: 'Dr Path', phone: '9000000003', role: 'staff', permissions: ['reports.release'], branchIds: [], isActive: true, professional: { kind: 'pathologist', registrationNumber: 'KMC-77' } },
      { _id: NOREG, partnerId: LAB2, name: 'No Registration', phone: '9000000004', role: 'staff', permissions: ['reports.release'], branchIds: [], isActive: true },
      { _id: 'b5'.repeat(12), partnerId: LAB2, name: 'Lake Owner', phone: '9000000005', role: 'owner', permissions: ALL, branchIds: [], isActive: true },
    ],
  };
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const ok = (route: Route, data: unknown, status = 200) => json(route, status, { success: true, data });
  const fail = (route: Route, status: number, code: string, message: string) => json(route, status, { error: status, code, message });

  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = req.method();
    const multipart = (req.headers()['content-type'] ?? '').startsWith('multipart/');
    const body = ['POST', 'PUT'].includes(method) && !multipart ? req.postDataJSON() : null;
    if (path === '/auth/session/refresh') {
      if (!b.live) return fail(route, 401, 'SESSION_ENDED', 'Please sign in again');
      return ok(route, { token: 't1', expiresIn: 900, principal: { userId: b.me._id, userType: 'partner', sid: 's1' } });
    }
    if (path === '/auth/session/logout') { b.live = false; return ok(route, {}); }
    if (path.startsWith('/auth/session')) return ok(route, {});
    const files = multipart ? [...(req.postDataBuffer()?.toString('latin1') ?? '').matchAll(/name="files"; filename="([^"]+)"/g)].map((m) => m[1]!) : undefined;
    b.calls.push({ method, path: `${path}${url.search}`, body, auth: req.headers().authorization, ...(files ? { files } : {}) });
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
    const held = async () => {
      if (b.hold && b.hold.match.test(path)) { const g = b.hold.gate; b.hold = undefined; await g; }
    };

    if (path === '/file/fetch') {
      const stored = url.searchParams.get('url') ?? '';
      const m = /^\/api\/static\/partner-lab-reports\/([0-9a-f]{24})\/([^/]+)$/.exec(stored);
      const bk = m && b.bookings.find((x) => x._id === m[1]);
      const rep = bk?.report as { draftFiles: string[]; releasedFiles: string[] } | undefined;
      const isDraft = !!rep?.draftFiles.includes(stored);
      const allowed = admin || b.me.role === 'owner' || (isDraft ? ['reports.upload', 'reports.release'] : ['reports.upload', 'reports.release', 'bookings.view', 'bookings.manage'])
        .some((p) => b.me.permissions.includes(p));
      if (!m || !rep || (!isDraft && !rep.releasedFiles.includes(stored)) || !allowed) return json(route, 404, { success: false, message: 'File not found' });
      if (m[2]!.endsWith('.png')) return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]) });
      return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: '%PDF-1.4\n%mock report\n' });
    }

    if (path === '/partner-workspace/admin/lab-bookings') {
      if (!admin) return fail(route, 403, 'FORBIDDEN', 'Admin access is required');
      const pid = url.searchParams.get('partnerId');
      const st = url.searchParams.get('status');
      return ok(route, b.bookings.filter((x) => (!pid || x.partnerId === pid) && (!st || x.status === st)));
    }
    if (path === '/partner-workspace/admin' && admin) {
      const kind = url.searchParams.get('kind');
      const items = partners.filter((p) => !kind || p.kind === kind);
      return json(route, 200, { success: true, data: items, pagination: { page: 1, limit: 200, total: items.length, totalPages: 1 } });
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
    if (sub === '/members') return can('staff.manage') ? ok(route, members[pid] ?? []) : deny();

    // ── slots ──
    if (sub === '/slots' && method === 'GET') {
      if (!can('slots.manage', 'bookings.view', 'bookings.manage')) return deny();
      const q = Object.fromEntries(url.searchParams);
      return ok(route, b.slots.filter((s) => s.partnerId === pid && s.branchId === q.branchId && s.visitMode === q.visitMode && s.date >= q.from! && s.date <= q.to!)
        .sort((x, y) => Date.parse(x.startsAt) - Date.parse(y.startsAt)));
    }
    const tpl = /^\/branches\/([0-9a-f]{24})\/slot-templates\/(home|lab)$/.exec(sub);
    if (tpl && method === 'PUT') {
      if (!can('slots.manage')) return deny();
      const t = body as { slotMinutes: number; capacity: number; days: Record<string, { start: string; end: string }[]> };
      const x = { inserted: 0, updated: 0, closed: 0, reopened: 0 };
      for (let i = 0; i < 30; i++) {
        const date = plus('2026-11-17', i);
        const starts = new Set((t.days[weekday(date)] ?? []).flatMap((w) => TIMES.filter(([s]) => s >= w.start && s < w.end).map(([s]) => s)));
        for (const s of b.slots.filter((y) => y.branchId === tpl[1] && y.visitMode === tpl[2] && y.date === date && y.source === 'template')) {
          if (!starts.has(s.startTime) && s.closed === null) { s.closed = 'template'; x.closed++; } else if (starts.has(s.startTime) && s.booked === 0 && s.capacity !== t.capacity) { s.capacity = t.capacity; x.updated++; }
        }
      }
      return ok(route, { template: { _id: 'f0'.repeat(12), partnerId: pid, branchId: tpl[1], visitMode: tpl[2], isActive: true, ...t }, expansion: x });
    }
    if (sub === '/slots' && method === 'POST') {
      if (!can('slots.manage')) return deny();
      const x = body as Slot;
      if (b.slots.some((s) => s.branchId === x.branchId && s.visitMode === x.visitMode && s.date === x.date && s.startTime === x.startTime)) {
        return fail(route, 409, 'SLOT_EXISTS', 'A slot already starts at that time');
      }
      const s = slot(x.visitMode, x.date, x.startTime, x.endTime, { capacity: x.capacity, source: 'manual', branchId: x.branchId });
      b.slots.push(s);
      return ok(route, s, 201);
    }
    const so = /^\/slots\/([0-9a-f]{24})\/(capacity|close|reopen)$/.exec(sub);
    if (so) {
      if (!can('slots.manage')) return deny();
      const s = b.slots.find((y) => y._id === so[1] && y.partnerId === pid);
      if (!s) return fail(route, 404, 'SLOT_NOT_FOUND', 'Slot not found');
      if (so[2] === 'capacity') {
        if (b.bookBeforeCapacity === s._id) { s.booked = 2; b.bookBeforeCapacity = undefined; }
        const c = (body as { capacity: number }).capacity;
        if (s.booked > c) return fail(route, 409, 'SLOT_CAPACITY_BELOW_BOOKED', 'Capacity cannot be lower than the seats already booked');
        s.capacity = c;
      } else s.closed = so[2] === 'close' ? 'manual' : null;
      await held();
      return ok(route, s);
    }

    // ── lab bookings ──
    const readers = ['bookings.view', 'bookings.manage', 'reports.upload', 'reports.release'];
    if (sub === '/lab-bookings' && method === 'GET') {
      if (!can(...readers)) return deny();
      const q = Object.fromEntries(url.searchParams);
      const slotDate = (x: Rec) => (x.slot as Rec).date as string;
      return ok(route, b.bookings.filter((x) => x.partnerId === pid && (!q.status || x.status === q.status) && (!q.branchId || x.branchId === q.branchId)
        && (!q.from || slotDate(x) >= q.from) && (!q.to || slotDate(x) <= q.to)));
    }
    const one = /^\/lab-bookings\/([0-9a-f]{24})(?:\/(.+))?$/.exec(sub);
    if (one) {
      const bk = b.bookings.find((x) => x._id === one[1] && x.partnerId === pid);
      if (!bk) return fail(route, 404, 'LAB_BOOKING_NOT_FOUND', 'Booking not found');
      const cmd = one[2];
      if (!cmd) return can(...readers) ? ok(route, bk) : deny();
      const step = (from: string[], to: string, set: Rec = {}) => {
        if (!from.includes(bk.status as string)) return `Not allowed while the booking is ${bk.status}`;
        Object.assign(bk, { status: to, statusVersion: (bk.statusVersion as number) + 1, ...set });
        return null;
      };
      const rep = bk.report as { draftFiles: string[]; releasedFiles: string[]; releases: Rec[] };
      let refused: string | null = null;
      if (cmd === 'reports') {
        if (!can('reports.upload')) return deny();
        if (!['processing', 'report_ready'].includes(bk.status as string)) return fail(route, 409, 'LAB_BOOKING_STATE_CONFLICT', 'Reports can be uploaded while the sample is being processed');
        rep.draftFiles.push(...(files ?? []).map((f) => file(bk._id as string, f)));
        await held();
        return ok(route, bk, 201);
      }
      if (cmd === 'reports/release') {
        if (!can('reports.release')) return deny();
        const x = body as { file: string; signerMemberId?: string };
        const signerId = ws[1] ? x.signerMemberId : b.me._id;
        const m = (members[pid] ?? []).find((y) => y._id === signerId) as Rec | undefined;
        if (!m) return fail(route, 400, 'SIGNER_REQUIRED', 'Name the professional releasing this report');
        const reg = (m.professional as Rec | undefined)?.registrationNumber;
        if (!reg) return fail(route, 409, 'SIGNER_REGISTRATION_MISSING', 'Add the professional registration number to this member before releasing');
        if (!rep.draftFiles.includes(x.file)) return fail(route, 404, 'REPORT_NOT_FOUND', 'That draft report is not on this booking');
        rep.draftFiles = rep.draftFiles.filter((f) => f !== x.file);
        rep.releasedFiles.push(x.file);
        rep.releases.push({ path: x.file.replace('/api/static/', ''), releasedAt: NOW.toISOString(), releasedBy: actor._id,
          signer: { memberId: signerId, name: m.name, kind: 'pathologist', registrationNumber: reg } });
        Object.assign(bk, { status: 'report_ready', statusVersion: (bk.statusVersion as number) + 1 });
        (bk.lifecycle as Rec).reportReadyAt ??= NOW.toISOString();
        return ok(route, bk);
      }
      if (!can('bookings.manage')) return deny();
      const now = NOW.toISOString();
      if (cmd === 'assign') { refused = bk.status === 'confirmed' ? null : 'Not allowed'; if (!refused) Object.assign(bk, { collector: body }); }
      else if (cmd === 'collect') refused = (bk.reschedule as Rec).pending ? 'The customer has not answered the new time yet' : step(['confirmed'], 'sample_collected', { lifecycle: { ...(bk.lifecycle as Rec), collectedAt: now } });
      else if (cmd === 'visit') refused = (bk.reschedule as Rec).pending ? 'The customer has not answered the new time yet' : step(['confirmed'], 'visited', { lifecycle: { ...(bk.lifecycle as Rec), visitedAt: now } });
      else if (cmd === 'no-show') refused = step(['confirmed'], 'no_show', { lifecycle: { ...(bk.lifecycle as Rec), noShowAt: now } });
      else if (cmd === 'process') refused = step(['sample_collected', 'visited'], 'processing', { lifecycle: { ...(bk.lifecycle as Rec), processingAt: now } });
      else if (cmd === 'complete') refused = step(['report_ready'], 'completed', { lifecycle: { ...(bk.lifecycle as Rec), completedAt: now } });
      else if (cmd === 'reject') {
        refused = step(['confirmed'], 'cancelled', { paymentStatus: 'refunded', cancellation: { reason: 'lab_reject', note: (body as Rec).reason, by: actor._id, byKind: 'member', at: now },
          lifecycle: { ...(bk.lifecycle as Rec), cancelledAt: now } });
        if (!refused) { await held(); return ok(route, { booking: bk, refunded: 450 }); }
      } else if (cmd === 'reschedule') {
        const x = body as { slotId: string; reason: string };
        const target = b.slots.find((s) => s._id === x.slotId);
        if (target && b.fillBeforeReschedule === target._id) { target.booked = target.capacity; b.fillBeforeReschedule = undefined; }
        if (!target || target.closed || target.booked >= target.capacity) return fail(route, 409, 'SLOT_UNAVAILABLE', 'That slot is no longer available; pick another');
        target.booked++;
        const old = bk.slot as Rec;
        const prev = b.slots.find((s) => s._id === old.slotId);
        if (prev) prev.booked--;
        Object.assign(bk, { slot: { slotId: target._id, date: target.date, startTime: target.startTime, endTime: target.endTime, startsAt: target.startsAt },
          statusVersion: (bk.statusVersion as number) + 1,
          reschedule: { version: ((bk.reschedule as Rec).version as number) + 1, pending: true, previousSlot: old, reason: x.reason, at: now, by: actor._id } });
      }
      if (refused) return fail(route, 409, 'LAB_BOOKING_STATE_CONFLICT', refused);
      await held();
      return ok(route, bk);
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
const day = (page: Page, date: RegExp) => page.getByRole('table', { name: date });
const writes = (b: Backend) => b.calls.filter((c) => c.method !== 'GET' && !c.path.startsWith('/auth/')).map((c) => `${c.method} ${c.path}`);

test('slots: week view, template saved after review, one-off slot, a capacity refusal from the server, close and reopen', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Slots' }).click();
  await expect(page.getByRole('heading', { name: 'Slots', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Week of .*16 Nov/ })).toBeVisible();
  await expect(page.getByLabel('Visit type')).toHaveValue('home');
  const tue = day(page, /17 Nov/);
  await expect(tue.getByRole('row').filter({ hasText: '09:00–09:30' })).toContainText('Started'); // 10:00 now
  await expect(day(page, /19 Nov/).getByRole('row').filter({ hasText: '09:00–09:30' })).toContainText('Closed: branch holiday');
  await expect(day(page, /19 Nov/).getByRole('row').filter({ hasText: '09:00–09:30' })).toContainText('Change the branch holidays to open it.');

  // The weekly template: filled in from the generated slots, reviewed, then saved whole.
  await page.getByRole('button', { name: 'Edit the weekly template' }).click();
  await expect(page.getByLabel('Slot length (minutes)')).toHaveValue('30');
  await expect(page.getByLabel('Seats per slot')).toHaveValue('2');
  await expect(page.getByLabel('Monday window 1 from')).toHaveValue('09:00');
  await expect(page.getByLabel('Monday window 1 to')).toHaveValue('11:00');
  await page.getByLabel('Seats per slot').fill('3');
  await page.getByRole('button', { name: 'Remove Saturday window 1' }).click();
  await page.getByRole('button', { name: 'Add a window on Sunday' }).click();
  await page.getByLabel('Sunday window 1 from').fill('10:00');
  await page.getByLabel('Sunday window 1 to').fill('09:00');
  await page.getByRole('button', { name: 'Review the template' }).click();
  await expect(page.getByText('A window must end after it starts.')).toBeVisible();
  await page.getByRole('button', { name: 'Remove Sunday window 1' }).click();
  await page.getByRole('button', { name: 'Review the template' }).click();
  const review = page.getByRole('group', { name: 'Save the weekly template' });
  await expect(review).toContainText('30-minute slots, 3 seats each');
  await expect(review).toContainText('Monday: 09:00–11:00 (4 slots)');
  await expect(review).toContainText('Saturday: no slots');
  expect(backend.calls.some((c) => c.method === 'PUT')).toBe(false);
  await review.getByRole('button', { name: 'Save the template' }).click();
  await expect(page.getByText(/Weekly template saved for home collection at Indiranagar\. Next 30 days: 0 slots added, \d+ changed, \d+ closed, 0 reopened\./)).toBeVisible();
  const put = backend.calls.find((c) => c.method === 'PUT')!;
  expect(put.path).toBe(`/partner-workspace/branches/${BR1}/slot-templates/home`);
  const w = [{ start: '09:00', end: '11:00' }];
  expect(put.body).toEqual({ slotMinutes: 30, capacity: 3, days: { mon: w, tue: w, wed: w, thu: w, fri: w, sat: [], sun: [] } });
  await expect(day(page, /21 Nov/).getByRole('row').filter({ hasText: '09:30–10:00' })).toContainText('Closed: no longer in the weekly template');

  // A one-off slot; the same again is refused by the server (no second slot at one time).
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: 'Add a one-off slot' }).click();
    await page.getByLabel('Date').fill('2026-11-20');
    await page.getByLabel('Starts').fill('18:00');
    await page.getByLabel('Ends').fill('18:30');
    await page.getByLabel('Seats', { exact: true }).fill('1');
    await page.getByRole('button', { name: 'Add slot' }).click();
  }
  await expect(page.getByText('A slot already starts at that time')).toBeVisible();
  const posts = backend.calls.filter((c) => c.method === 'POST' && c.path === '/partner-workspace/slots');
  expect(posts).toHaveLength(2);
  expect(posts[0]!.body).toEqual({ branchId: BR1, visitMode: 'home', date: '2026-11-20', startTime: '18:00', endTime: '18:30', capacity: 1 });
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(day(page, /20 Nov/).getByRole('row').filter({ hasText: '18:00–18:30' })).toContainText('One-off');

  // Capacity: a booking lands while staff lower it, so the server refuses; the client then refuses below the bookings.
  const wed = day(page, /18 Nov/);
  const nine = wed.getByRole('row').filter({ hasText: '09:00–09:30' });
  backend.bookBeforeCapacity = backend.slots.find((s) => s.visitMode === 'home' && s.date === '2026-11-18' && s.startTime === '09:00')!._id;
  await nine.getByRole('button', { name: /^Change seats of/ }).click();
  await nine.getByLabel('Seats', { exact: true }).fill('1');
  await nine.getByRole('button', { name: 'Save seats' }).click();
  await expect(nine.getByText('Capacity cannot be lower than the seats already booked')).toBeVisible();
  await expect(nine.getByRole('cell').nth(1)).toHaveText('2'); // reloaded: 2 booked now
  await nine.getByRole('button', { name: 'Save seats' }).click();
  await expect(nine.getByText('2 seats are already booked: the capacity cannot be lower.')).toBeVisible();
  expect(backend.calls.filter((c) => c.path.endsWith('/capacity'))).toHaveLength(1);
  await nine.getByLabel('Seats', { exact: true }).fill('4');
  await nine.getByRole('button', { name: 'Save seats' }).click();
  await expect(page.getByText(/09:00–09:30 now has 4 seats\./)).toBeVisible();

  // Close after confirming (Back first sends nothing), then reopen a staff closure.
  const ten = wed.getByRole('row').filter({ hasText: '10:00–10:30' });
  await ten.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(ten.getByText(/Customers can no longer book it/)).toBeVisible();
  await ten.getByRole('button', { name: 'Back' }).click();
  expect(backend.calls.some((c) => c.path.endsWith('/close'))).toBe(false);
  await ten.getByRole('button', { name: 'Close', exact: true }).click();
  await ten.getByRole('button', { name: /^Close .*10:00–10:30$/ }).click();
  await expect(ten).toContainText('Closed by staff');
  await ten.getByRole('button', { name: 'Reopen', exact: true }).click();
  await ten.getByRole('button', { name: /^Reopen .*10:00–10:30$/ }).click();
  await expect(ten).toContainText('Open');
  expect(writes(backend).filter((x) => /close|reopen/.test(x))).toEqual([
    `POST /partner-workspace/slots/${backend.slots.find((s) => s.visitMode === 'home' && s.date === '2026-11-18' && s.startTime === '10:00')!._id}/close`,
    `POST /partner-workspace/slots/${backend.slots.find((s) => s.visitMode === 'home' && s.date === '2026-11-18' && s.startTime === '10:00')!._id}/reopen`,
  ]);
});

test('a home collection moves through its states; each step offered only when the server allows it', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Lab bookings' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Dev Unpaid' })).toContainText('Waiting for payment');
  await expect(page.getByRole('row').filter({ hasText: 'Bala Rao' })).toContainText('At the lab');
  await page.getByRole('row').filter({ hasText: 'Asha Rao' }).getByRole('link').click();
  await expect(page.getByRole('heading', { name: 'Lab booking: Asha Rao' })).toBeVisible();
  await expect(page.getByText('12 Lake View, Bengaluru, 560038')).toBeVisible();
  // Home collection: collect, not visit; the slot has started so a no-show can be marked.
  await expect(page.getByRole('button', { name: 'Mark visited' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Mark no-show' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Start processing' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Assign collector' }).click();
  await expect(page.getByLabel('Who collects').locator('option')).toHaveText(['Someone else (type the name)', 'Ravi Owner', 'Sita Staff']);
  await page.getByLabel('Collector’s mobile (optional)').fill('12345');
  await page.getByRole('button', { name: 'Save collector' }).click();
  await expect(page.getByText('Enter the collector’s name.')).toBeVisible();
  await expect(page.getByText('Enter 10 digits.')).toBeVisible();
  await page.getByLabel('Collector’s name').fill('Kiran');
  await page.getByLabel('Collector’s mobile (optional)').fill('9000000002');
  await page.getByRole('button', { name: 'Save collector' }).click();
  await expect(page.getByText('Kiran will collect the sample.')).toBeVisible();
  await expect(page.getByText('Kiran · 9000000002')).toBeVisible();

  await page.getByRole('button', { name: 'Mark sample collected' }).click();
  await expect(page.getByText('Marked as sample collected.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark no-show' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Start processing' }).click();
  await expect(page.getByText('Processing started. Reports can be uploaded now.')).toBeVisible();

  // Upload: only PDF/images; the drafts are not visible to the customer.
  const input = page.getByLabel('Report files (PDF, JPEG, PNG or WebP; up to 10 MB each)');
  await input.setInputFiles([{ name: 'notes.docx', mimeType: 'application/msword', buffer: Buffer.from('x') }]);
  await expect(page.getByText('notes.docx: only PDF, JPEG, PNG or WebP files can be uploaded.')).toBeVisible();
  await page.getByRole('button', { name: 'Upload as drafts' }).click();
  expect(backend.calls.some((c) => c.path.endsWith('/reports'))).toBe(false);
  await input.setInputFiles([{ name: 'cbc.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 cbc') }]);
  await page.getByRole('button', { name: 'Upload as drafts' }).click();
  await expect(page.getByText('1 file was added as drafts. Release each one when it is checked.')).toBeVisible();
  expect(backend.calls.find((c) => c.path.endsWith('/reports'))!.files).toEqual(['cbc.pdf']);
  const drafts = page.getByRole('list', { name: 'Draft reports' });
  await expect(drafts).toContainText('cbc.pdf');

  // Release under the member's own registration, after confirming.
  await drafts.getByRole('button', { name: 'Release cbc.pdf' }).click();
  const release = page.getByRole('group', { name: 'Release cbc.pdf' });
  await expect(release).toContainText('under your own name (Ravi Owner) and your professional registration');
  await release.getByRole('button', { name: 'Release cbc.pdf' }).click();
  await expect(page.getByText('cbc.pdf was released to the customer.')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Released reports' })).toContainText('cbc.pdf · released');
  await expect(page.getByRole('list', { name: 'Released reports' })).toContainText('under Ravi Owner (pathologist), registration KMC-11');
  await expect(page.getByText('Report released', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Complete booking' }).click();
  await expect(page.getByText(/no more reports can be uploaded or released, and the lab’s earning of ₹450.00 is recorded/)).toBeVisible();
  await page.getByRole('group', { name: 'Complete booking' }).getByRole('button', { name: 'Complete booking' }).click();
  await expect(page.getByText('Booking completed.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Upload as drafts' })).toHaveCount(0);
  await expect(page.getByRole('list').filter({ hasText: 'Sample collected' }).last()).toBeVisible();

  expect(writes(backend)).toEqual([
    `POST /partner-workspace/lab-bookings/${BK1}/assign`,
    `POST /partner-workspace/lab-bookings/${BK1}/collect`,
    `POST /partner-workspace/lab-bookings/${BK1}/process`,
    `POST /partner-workspace/lab-bookings/${BK1}/reports`,
    `POST /partner-workspace/lab-bookings/${BK1}/reports/release`,
    `POST /partner-workspace/lab-bookings/${BK1}/complete`,
  ]);
  expect(backend.calls.find((c) => c.path.endsWith('/assign'))!.body).toEqual({ name: 'Kiran', phone: '9000000002' });
  expect(backend.calls.find((c) => c.path.endsWith('/release'))!.body).toEqual({ file: file(BK1, 'cbc.pdf') });
  // Nothing about the patient was written to browser storage.
  expect(await page.evaluate(() => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }))).not.toMatch(/Asha|Kiran|cbc/);
});

test('permissions: viewers see bookings and slots without actions; report staff only upload; clinics have no lab pages', async ({ page }) => {
  const backend = await mockBackend(page, staff('bookings.view'));
  await signInPartner(page);
  await expect(nav(page).getByRole('link', { name: 'Lab bookings' })).toBeVisible();
  await nav(page).getByRole('link', { name: 'Slots' }).click();
  await expect(page.getByRole('heading', { name: /Week of/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit the weekly template' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Change seats/ })).toHaveCount(0);
  await page.goto(`/#/partner/lab-bookings/${BK1}`);
  await expect(page.getByRole('heading', { name: 'Lab booking: Asha Rao' })).toBeVisible();
  await expect(page.getByText('You can view this booking; the next step needs another permission.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Mark|Reject|Assign|Propose/ })).toHaveCount(0);
  await page.goto(`/#/partner/lab-bookings/${BK4}`);
  await expect(page.getByText(/The customer has not paid yet/)).toBeVisible();
  expect(writes(backend)).toEqual([]);

  backend.me = staff('reports.upload');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByLabel('Lab or clinic staff')).toBeVisible();
  await expect.poll(() => backend.live).toBe(false); // the server session has ended
  await signInPartner(page);
  await expect(nav(page).getByRole('link', { name: 'Slots' })).toHaveCount(0);
  await page.goto(`/#/partner/lab-bookings/${BK3}`);
  await expect(page.getByRole('heading', { name: 'Lab booking: Chitra N' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Upload as drafts' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Release/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Complete booking' })).toHaveCount(0);

  backend.me = { ...staff('bookings.manage', 'invoices.create'), partnerId: CLINIC };
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByLabel('Lab or clinic staff')).toBeVisible();
  await expect.poll(() => backend.live).toBe(false); // the server session has ended
  await signInPartner(page);
  await expect(nav(page).getByRole('link', { name: 'Bills' })).toBeVisible();
  await expect(nav(page).getByRole('link', { name: 'Lab bookings' })).toHaveCount(0);
  await page.goto('/#/partner/slots');
  await expect(page.getByText('Page not found')).toBeVisible();
});

test('a new time is proposed from open slots with a reason; a taken slot is refused; then a rejection refunds after confirming', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await page.goto(`/#/partner/lab-bookings/${BK2}`);
  await expect(page.getByRole('heading', { name: 'Lab booking: Bala Rao' })).toBeVisible();
  await expect(page.getByText('Bala Rao (family member of the account holder)')).toBeVisible();
  // A lab visit before its slot: visited is offered, a no-show not yet.
  await expect(page.getByRole('button', { name: 'Mark visited' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Mark no-show' })).toBeDisabled();
  await expect(page.getByText('A no-show can be marked only after the slot time.')).toBeVisible();

  await page.getByRole('button', { name: 'Propose a new time' }).click();
  const thu = slotId('lab', '2026-11-19', '09:30');
  const fri = slotId('lab', '2026-11-20', '10:00');
  // Only open slots with a free seat, still ahead, and not the booking's own.
  await expect(page.getByLabel('New time', { exact: true }).locator(`option[value="${slotId('lab', '2026-11-17', '09:00')}"]`)).toHaveCount(0);
  await expect(page.getByLabel('New time', { exact: true }).locator(`option[value="${slotId('lab', '2026-11-18', '09:00')}"]`)).toHaveCount(0);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Choose the new time.')).toBeVisible();
  await expect(page.getByText('Give a reason (at least 3 characters).')).toBeVisible();
  await page.getByLabel('New time', { exact: true }).selectOption(thu);
  await page.getByLabel('Reason (the customer sees this)').fill('Analyser maintenance');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText(/Propose .*19 Nov.*09:30–10:00 instead of .*18 Nov.*09:00–09:30\?/)).toBeVisible();
  backend.fillBeforeReschedule = thu;
  await page.getByRole('button', { name: 'Propose the new time' }).click();
  await expect(page.getByText('Not proposed: That slot is no longer available; pick another')).toBeVisible();
  await expect(page.getByLabel('New time', { exact: true }).locator(`option[value="${thu}"]`)).toHaveCount(0);
  await page.getByLabel('New time', { exact: true }).selectOption(fri);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Propose the new time' }).click();
  await expect(page.getByText(/New time proposed: .*20 Nov.*10:00–10:30\. The customer has been told/)).toBeVisible();
  await expect(page.getByText(/You proposed .*20 Nov.*10:00–10:30 instead of .*18 Nov.*09:00–09:30 \(“Analyser maintenance”\)/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark visited' })).toBeDisabled();
  await expect(page.getByText('The customer has not answered the new time yet.').first()).toBeVisible();
  const proposals = backend.calls.filter((c) => c.path.endsWith('/reschedule'));
  expect(proposals.map((c) => c.body)).toEqual([{ slotId: thu, reason: 'Analyser maintenance' }, { slotId: fri, reason: 'Analyser maintenance' }]);

  await page.getByRole('button', { name: 'Reject booking' }).click();
  await expect(page.getByText(/customer’s full payment of ₹450.00 goes back to their Jansetu wallet\. This cannot be undone\./)).toBeVisible();
  await page.getByRole('button', { name: 'Reject and refund' }).click();
  await expect(page.getByText('Give a reason (at least 3 characters).')).toBeVisible();
  await page.getByLabel('Why can the lab not take this booking? (the customer sees this)').fill('No phlebotomist available');
  await page.getByRole('button', { name: 'Reject and refund' }).click();
  await expect(page.getByText('Booking rejected; the customer’s payment is back in their wallet.')).toBeVisible();
  await expect(page.getByText('Rejected by the lab: “No phlebotomist available”', { exact: false })).toBeVisible();
  await expect(page.getByText('Refunded', { exact: true }).first()).toBeVisible();
  expect(backend.calls.find((c) => c.path.endsWith('/reject'))!.body).toEqual({ reason: 'No phlebotomist available' });
});

test('admin: every lab’s bookings; a release under a chosen signer; report files open from in-memory blobs', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await nav(page).getByRole('link', { name: 'Lab bookings' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Esha K' })).toContainText('Lake Lab');
  await expect(page.getByRole('row').filter({ hasText: 'Asha Rao' })).toContainText('City Lab');
  await page.getByLabel('Lab').selectOption(LAB2);
  await expect(page.getByRole('row').filter({ hasText: 'Asha Rao' })).toHaveCount(0);
  expect(backend.calls.some((c) => c.path === `/partner-workspace/admin/lab-bookings?partnerId=${LAB2}`)).toBe(true);
  await page.getByRole('row').filter({ hasText: 'Esha K' }).getByRole('link').click();
  await expect(page.getByRole('heading', { name: 'Lab booking: Esha K' })).toBeVisible();
  await expect(page.getByText('Managing Lake Lab with owner authority.', { exact: false })).toBeVisible();

  const released = page.getByRole('list', { name: 'Released reports' });
  await expect(released).toContainText('cbc.pdf · released');
  await expect(released).toContainText('under Dr Path (pathologist), registration KMC-77');
  await released.getByRole('button', { name: 'View cbc.pdf' }).click();
  await expect(page.locator('iframe[title="Report cbc.pdf"]')).toHaveAttribute('src', /^blob:/);
  await released.getByRole('button', { name: 'View page2.png' }).click();
  await expect(page.getByRole('img', { name: 'Report page2.png' })).toHaveAttribute('src', /^blob:/);
  await expect(page.locator('iframe[title="Report cbc.pdf"]')).toHaveCount(0);
  const fetches = backend.calls.filter((c) => c.path.startsWith('/file/fetch'));
  expect(fetches.map((c) => c.path)).toEqual([
    `/file/fetch?url=${encodeURIComponent(file(BK5, 'cbc.pdf'))}`, `/file/fetch?url=${encodeURIComponent(file(BK5, 'page2.png'))}`,
  ]);
  expect(fetches.every((c) => c.auth === 'Bearer admin')).toBe(true);
  expect(backend.calls.some((c) => /Bearer|token|[=/]t1\b|=admin\b/i.test(c.path))).toBe(false); // the token never travels in a URL

  // Admins name the signer: only members the server accepts (registration on record) are offered.
  const drafts = page.getByRole('list', { name: 'Draft reports' });
  await drafts.getByRole('button', { name: 'Release lipid.pdf' }).click();
  const group = page.getByRole('group', { name: 'Release lipid.pdf' });
  await expect(group.getByLabel('Signed by').locator('option')).toHaveText(['Choose the professional', 'Dr Path · KMC-77']);
  await expect(group.getByRole('button', { name: 'Release lipid.pdf' })).toBeDisabled();
  await group.getByLabel('Signed by').selectOption(PATH);
  await expect(group).toContainText('Release lipid.pdf to the customer under Dr Path (pathologist, registration KMC-77)?');
  await group.getByRole('button', { name: 'Release lipid.pdf' }).click();
  await expect(page.getByText('lipid.pdf was released to the customer.')).toBeVisible();
  expect(backend.calls.find((c) => c.path.endsWith('/reports/release'))).toMatchObject({
    path: `/partner-workspace/admin/${LAB2}/workspace/lab-bookings/${BK5}/reports/release`, body: { file: file(BK5, 'lipid.pdf'), signerMemberId: PATH },
  });
  await expect(released).toContainText('lipid.pdf · released');
});

test('admin switching partners discards open forms; a clinic has no lab pages', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await page.goto(`/#/admin/partners/${LAB}`);
  await page.getByRole('link', { name: 'Slots' }).click();
  await expect(page.getByText('Managing City Lab with owner authority.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Edit the weekly template' }).click();
  await page.getByLabel('Seats per slot').fill('9');
  await expect(page.getByRole('heading', { name: /Weekly template: home collection at Indiranagar/ })).toBeVisible();

  await page.goto(`/#/admin/partners/${LAB2}/slots`);
  await expect(page.getByText('Managing Lake Lab with owner authority.', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Seats per slot')).toHaveCount(0);
  await expect(page.getByLabel('Visit type')).toHaveValue('lab'); // Lakeside offers lab visits only
  await page.getByRole('button', { name: 'Edit the weekly template' }).click();
  await expect(page.getByLabel('Seats per slot')).toHaveValue('2'); // Lake Lab's own slots, not the other draft
  expect(backend.calls.filter((c) => c.path.includes('/slots?')).map((c) => c.path.split('?')[0]))
    .toContain(`/partner-workspace/admin/${LAB2}/workspace/slots`);

  // A booking page with a rejection open, then another partner's booking: nothing carries over.
  await page.goto(`/#/admin/partners/${LAB}/lab-bookings/${BK2}`);
  await page.getByRole('button', { name: 'Reject booking' }).click();
  await page.getByLabel('Why can the lab not take this booking? (the customer sees this)').fill('Draft reason');
  await page.goto(`/#/admin/partners/${LAB2}/lab-bookings/${BK5}`);
  await expect(page.getByRole('heading', { name: 'Lab booking: Esha K' })).toBeVisible();
  await expect(page.getByLabel('Why can the lab not take this booking? (the customer sees this)')).toHaveCount(0);
  await page.goto(`/#/admin/partners/${LAB}/lab-bookings/${BK2}`);
  await expect(page.getByRole('button', { name: 'Reject booking' })).toBeVisible();
  await expect(page.getByLabel('Why can the lab not take this booking? (the customer sees this)')).toHaveCount(0);

  await page.goto(`/#/admin/partners/${CLINIC}/slots`);
  await expect(page.getByText('Only for labs')).toBeVisible();
  await expect(page.getByText('Sunrise Clinic is a clinic.', { exact: false })).toBeVisible();
  expect(writes(backend)).toEqual([]);
});

test('a late answer after leaving changes nothing on the page now shown', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await page.goto(`/#/partner/lab-bookings/${BK1}`);
  await expect(page.getByRole('heading', { name: 'Lab booking: Asha Rao' })).toBeVisible();
  const release = hold(backend, /\/collect$/);
  await page.getByRole('button', { name: 'Mark sample collected' }).click();
  await expect(page.getByRole('button', { name: 'Mark sample collected' })).toHaveAttribute('aria-busy', 'true');
  await page.goto(`/#/partner/lab-bookings/${BK2}`);
  await expect(page.getByRole('heading', { name: 'Lab booking: Bala Rao' })).toBeVisible();
  release();
  await page.waitForTimeout(300);
  await expect(page.getByText('Marked as sample collected.')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Lab booking: Bala Rao' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark visited' })).toBeEnabled();
  await expect(page.getByText('Confirmed', { exact: true }).first()).toBeVisible();
  // Back on the first booking, the page shows the server's state.
  await page.goto(`/#/partner/lab-bookings/${BK1}`);
  await expect(page.getByText('Sample collected', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Marked as sample collected.')).toHaveCount(0);

  // Slots: a capacity answer that arrives after moving to another week is not shown there.
  await nav(page).getByRole('link', { name: 'Slots' }).click();
  const row = day(page, /20 Nov/).getByRole('row').filter({ hasText: '09:00–09:30' });
  await row.getByRole('button', { name: /^Change seats of/ }).click();
  await row.getByLabel('Seats', { exact: true }).fill('5');
  const late = hold(backend, /\/capacity$/);
  await row.getByRole('button', { name: 'Save seats' }).click();
  await page.getByRole('button', { name: 'Next week' }).click();
  await expect(page.getByRole('heading', { name: /Week of .*23 Nov/ })).toBeVisible();
  late();
  await page.waitForTimeout(300);
  await expect(page.getByText(/now has 5 seats/)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /Week of .*23 Nov/ })).toBeVisible();
});
