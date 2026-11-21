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
  /** Q14: the next no-show move is made, then its answer is lost. */
  loseNextNoShowMove?: boolean;
  live: boolean;
  /** WQ10b: every partner's members (a test may change them). */
  members?: Record<string, Rec[]>;
  /** Q11: saved weekly templates by `<branchId>:<mode>` (GET answers null when there is none). */
  templates: Record<string, Rec>;
  /** WQ11b: the next no-show move never reaches the server (the connection drops before anything is done). */
  dropNextMove?: boolean;
  /** WQ11b: someone else saves the template right before the next template save is decided. */
  templateSavedElsewhere?: Rec;
  /** WQ11d: the next report upload is attached, then its answer is lost. */
  loseNextUpload?: boolean;
  /** WQ11b: someone else acts on this booking right before the next step on it is decided (its status version moves). */
  bumpBeforeStep?: string;
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
  // The saved weekly templates the seeded slots came from (Mon–Sat 09:00–11:00, 30 minutes, 2 seats).
  const week = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, [{ start: '09:00', end: '11:00' }]]));
  const template = (partnerId: string, branchId: string, visitMode: Mode): Rec => ({ _id: `f${visitMode === 'home' ? 1 : 2}`.repeat(12), partnerId, branchId, visitMode,
    isActive: true, slotMinutes: 30, capacity: 2, days: week, updatedAt: '2026-11-10T05:00:00.000Z' });
  const b: Backend = { calls: [], me, slots: seedSlots(), bookings: seedBookings(), live: false, templates: {
    [`${BR1}:home`]: template(LAB, BR1, 'home'), [`${BR1}:lab`]: template(LAB, BR1, 'lab'), [`${BR2}:lab`]: template(LAB2, BR2, 'lab'),
  } };
  let stamp = 0;
  const nextStamp = () => new Date(Date.UTC(2026, 10, 17, 4, 0, ++stamp)).toISOString();
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
  b.members = members;
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
    const raw = multipart ? (req.postDataBuffer()?.toString('latin1') ?? '') : '';
    const files = multipart ? [...raw.matchAll(/name="files"; filename="([^"]+)"/g)].map((m) => m[1]!) : undefined;
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

    // Q11 `adminList` (services/labBookings.ts): newest booked first, limit = min(max(limit || 50, 1), 200), page || 1,
    // answered with { page, limit, total, totalPages } (controller adminListLabBookings).
    if (path === '/partner-workspace/admin/lab-bookings') {
      if (!admin) return fail(route, 403, 'FORBIDDEN', 'Admin access is required');
      const pid = url.searchParams.get('partnerId');
      const st = url.searchParams.get('status');
      const all = b.bookings.filter((x) => (!pid || x.partnerId === pid) && (!st || x.status === st))
        .sort((x, y) => Date.parse(y.createdAt as string) - Date.parse(x.createdAt as string) || String(y._id).localeCompare(String(x._id)));
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
      const pg = Math.max(Number(url.searchParams.get('page')) || 1, 1);
      return json(route, 200, { success: true, data: all.slice((pg - 1) * limit, pg * limit),
        pagination: { page: pg, limit, total: all.length, totalPages: Math.max(1, Math.ceil(all.length / limit)) } });
    }
    // Q16a `adminCancelMovedNoShow`: a confirmed booking moved after a no-show, refund chosen by the admin.
    const cancelNoShow = /^\/partner-workspace\/admin\/lab-bookings\/([0-9a-f]{24})\/cancel-no-show$/.exec(path);
    if (cancelNoShow && method === 'POST') {
      if (!admin) return fail(route, 403, 'FORBIDDEN', 'Admin access is required');
      const bk = b.bookings.find((x) => x._id === cancelNoShow[1]);
      if (!bk) return fail(route, 404, 'LAB_BOOKING_NOT_FOUND', 'Booking not found');
      const x = body as { reason: string; refund: boolean };
      if (bk.status === 'cancelled') return fail(route, 409, 'ALREADY_CANCELLED', 'This booking is already cancelled');
      if (bk.status !== 'confirmed') return fail(route, 409, 'LAB_BOOKING_STATE_CONFLICT', `A ${bk.status} booking cannot be cancelled`);
      if (!((bk.noShows as Rec[] | undefined)?.length)) return fail(route, 409, 'BOOKING_NOT_MOVED_NO_SHOW', 'This booking was not moved after a no-show; use the ordinary cancellation');
      Object.assign(bk, { status: 'cancelled', statusVersion: (bk.statusVersion as number) + 1, ...(x.refund ? { paymentStatus: 'refunded' } : {}),
        cancellation: { reason: 'admin_no_show', note: x.reason, by: `admin:${ADMIN}`, byKind: 'admin', at: NOW.toISOString(), refund: x.refund } });
      return ok(route, { booking: bk, refunded: x.refund ? 450 : 0 });
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
    // WQ10b (Q11): one member, and the registration owners record on it.
    const mm = /^\/members\/([0-9a-f]{24})(\/professional)?$/.exec(sub);
    if (mm) {
      if (!can('staff.manage')) return deny();
      const m = (members[pid] ?? []).find((y) => y._id === mm[1]);
      if (!m) return fail(route, 404, 'MEMBER_NOT_FOUND', 'Member not found');
      if (!mm[2] && method === 'GET') return ok(route, m);
      if (mm[2] && method === 'PUT') {
        if (actor.role !== 'owner') return fail(route, 403, 'OWNER_REQUIRED', 'Only an owner can record professional registrations');
        const prof = (body as Rec).professional as Rec | null;
        if (prof) m.professional = { kind: prof.kind, registrationNumber: prof.registrationNumber }; else delete m.professional;
        return ok(route, m);
      }
    }

    // ── slots ──
    if (sub === '/slots' && method === 'GET') {
      if (!can('slots.manage', 'bookings.view', 'bookings.manage')) return deny();
      const q = Object.fromEntries(url.searchParams);
      return ok(route, b.slots.filter((s) => s.partnerId === pid && s.branchId === q.branchId && s.visitMode === q.visitMode && s.date >= q.from! && s.date <= q.to!)
        .sort((x, y) => Date.parse(x.startsAt) - Date.parse(y.startsAt)));
    }
    const tpl = /^\/branches\/([0-9a-f]{24})\/slot-templates\/(home|lab)$/.exec(sub);
    // Q11 `getSlotTemplate`: the saved template, or null.
    if (tpl && method === 'GET') {
      if (!can('slots.manage', 'bookings.view', 'bookings.manage')) return deny();
      return ok(route, b.templates[`${tpl[1]}:${tpl[2]}`] ?? null);
    }
    if (tpl && method === 'PUT') {
      if (!can('slots.manage')) return deny();
      const tkey = `${tpl[1]}:${tpl[2]}`;
      if (b.templateSavedElsewhere) { b.templates[tkey] = { ...b.templateSavedElsewhere, updatedAt: nextStamp() }; b.templateSavedElsewhere = undefined; }
      // Q11 `saveSlotTemplate`: `expectedUpdatedAt` (null = started from no template) must be the saved one's.
      const { expectedUpdatedAt, ...t } = body as { slotMinutes: number; capacity: number; days: Record<string, { start: string; end: string }[]>; expectedUpdatedAt?: string | null };
      if (expectedUpdatedAt !== undefined && (b.templates[tkey]?.updatedAt ?? null) !== expectedUpdatedAt) {
        return fail(route, 409, 'TEMPLATE_CHANGED', 'The weekly template changed since you opened it; review it again');
      }
      b.templates[tkey] = { _id: 'f0'.repeat(12), partnerId: pid, branchId: tpl[1], visitMode: tpl[2], isActive: true, ...t, updatedAt: nextStamp() };
      const x = { inserted: 0, updated: 0, closed: 0, reopened: 0 };
      for (let i = 0; i < 30; i++) {
        const date = plus('2026-11-17', i);
        const starts = new Set((t.days[weekday(date)] ?? []).flatMap((w) => TIMES.filter(([s]) => s >= w.start && s < w.end).map(([s]) => s)));
        for (const s of b.slots.filter((y) => y.branchId === tpl[1] && y.visitMode === tpl[2] && y.date === date && y.source === 'template')) {
          if (!starts.has(s.startTime) && s.closed === null) { s.closed = 'template'; x.closed++; } else if (starts.has(s.startTime) && s.booked === 0 && s.capacity !== t.capacity) { s.capacity = t.capacity; x.updated++; }
        }
      }
      await held();
      return ok(route, { template: b.templates[tkey], expansion: x });
    }
    if (sub === '/slots' && method === 'POST') {
      if (!can('slots.manage')) return deny();
      const x = body as Slot;
      if (b.slots.some((s) => s.branchId === x.branchId && s.visitMode === x.visitMode && s.date === x.date && s.startTime === x.startTime)) {
        return fail(route, 409, 'SLOT_EXISTS', 'A slot already starts at that time');
      }
      const s = slot(x.visitMode, x.date, x.startTime, x.endTime, { capacity: x.capacity, source: 'manual', branchId: x.branchId });
      b.slots.push(s);
      await held();
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
    // Q11 `listForPartnerPage`: soonest slot first (then id), limit = min(max(limit || 50, 1), 200), an exact cursor
    // `<ms>_<id>`, answered with { total, nextCursor } (controller listLabBookings).
    if (sub === '/lab-bookings' && method === 'GET') {
      if (!can(...readers)) return deny();
      const q = Object.fromEntries(url.searchParams);
      const slotOf = (x: Rec) => x.slot as { date: string; startsAt: string };
      const all = b.bookings.filter((x) => x.partnerId === pid && (!q.status || x.status === q.status) && (!q.branchId || x.branchId === q.branchId)
        && (!q.from || slotOf(x).date >= q.from) && (!q.to || slotOf(x).date <= q.to))
        .sort((x, y) => Date.parse(slotOf(x).startsAt) - Date.parse(slotOf(y).startsAt) || String(x._id).localeCompare(String(y._id)));
      let rest = all;
      if (q.cursor) {
        const [ms, cid] = q.cursor.split('_');
        rest = all.filter((x) => Date.parse(slotOf(x).startsAt) > Number(ms) || (Date.parse(slotOf(x).startsAt) === Number(ms) && String(x._id) > cid!));
      }
      const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
      const items = rest.slice(0, limit);
      const last = items[items.length - 1];
      return json(route, 200, { success: true, data: items,
        pagination: { total: all.length, nextCursor: rest.length > limit && last ? `${Date.parse(slotOf(last).startsAt)}_${String(last._id)}` : null } });
    }
    const one = /^\/lab-bookings\/([0-9a-f]{24})(?:\/(.+))?$/.exec(sub);
    if (one) {
      const bk = b.bookings.find((x) => x._id === one[1] && x.partnerId === pid);
      if (!bk) return fail(route, 404, 'LAB_BOOKING_NOT_FOUND', 'Booking not found');
      const cmd = one[2];
      if (!cmd) return can(...readers) ? ok(route, bk) : deny();
      if (b.bumpBeforeStep === bk._id && cmd !== 'reports') { b.bumpBeforeStep = undefined; bk.statusVersion = (bk.statusVersion as number) + 1; }
      // Q11 `assertVersion`: a step naming another status version than the booking's is refused.
      const ev = (body as { expectedVersion?: number } | null)?.expectedVersion;
      if (cmd !== 'reschedule-no-show' && ev !== undefined && ev !== bk.statusVersion) return fail(route, 409, 'LAB_BOOKING_CHANGED', 'The booking changed since you opened it; review it again');
      const step = (from: string[], to: string, set: Rec = {}) => {
        if (!from.includes(bk.status as string)) return `Not allowed while the booking is ${bk.status}`;
        Object.assign(bk, { status: to, statusVersion: (bk.statusVersion as number) + 1, ...set });
        return null;
      };
      const rep = bk.report as { draftFiles: string[]; releasedFiles: string[]; releases: Rec[] };
      let refused: string | null = null;
      if (cmd === 'reports') {
        if (!can('reports.upload')) return deny();
        // Q11 `?requestKey=`: a key already attached answers the booking (replayed), never a second copy.
        const key = url.searchParams.get('requestKey');
        const keys = ((rep as Rec).uploadKeys as string[] | undefined) ?? [];
        if (key && keys.includes(key)) return ok(route, { ...bk, replayed: true });
        if (!['processing', 'report_ready'].includes(bk.status as string)) return fail(route, 409, 'LAB_BOOKING_STATE_CONFLICT', 'Reports can be uploaded while the sample is being processed');
        // FileService/formidable: 10 MB for the whole request (`maxTotalFileSize` defaults to `maxFileSize`); the error is
        // not an AppError, so it is answered 500 UPLOAD_FAILED with formidable's message, nothing attached.
        if (raw.length > 10 * 1024 * 1024) {
          return fail(route, 500, 'UPLOAD_FAILED', `options.maxTotalFileSize (10485760 bytes) exceeded, received ${raw.length} bytes of file data`);
        }
        rep.draftFiles.push(...(files ?? []).map((f) => file(bk._id as string, f)));
        if (key) (rep as Rec).uploadKeys = [...keys, key];
        if (b.loseNextUpload) { b.loseNextUpload = false; return route.abort('failed'); } // attached, the answer lost
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
      // Q14: a no-show moved once (same price, no refund), keyed, fenced by the status version.
      if (cmd === 'reschedule-no-show') {
        if (b.dropNextMove) { b.dropNextMove = false; return route.abort('failed'); }
        const x = body as { slotId: string; requestKey: string; expectedVersion?: number };
        const moves = (bk.noShows as Rec[] | undefined) ?? [];
        const prior = moves.find((n) => n.requestKey === x.requestKey);
        if (prior) return ok(route, { ...bk, replayed: true });
        if (moves.length || (bk.noShowReschedules as number | undefined)) return fail(route, 409, 'NO_SHOW_RESCHEDULE_USED', 'This booking was already rescheduled once after a no-show; a second no-show is final');
        if (bk.status !== 'no_show') return fail(route, 409, 'BOOKING_NOT_NO_SHOW', `A ${bk.status} booking is not a no-show`);
        if (x.expectedVersion !== undefined && x.expectedVersion !== bk.statusVersion) return fail(route, 409, 'LAB_BOOKING_CHANGED', 'The booking changed meanwhile; reload and try again');
        const target = b.slots.find((y) => y._id === x.slotId);
        // services/slots.ts `takeSeat`: a closed, full, started or holiday slot is 409 SLOT_UNAVAILABLE.
        if (!target || target.closed || target.booked >= target.capacity) return fail(route, 409, 'SLOT_UNAVAILABLE', 'That slot is no longer available; pick another');
        target.booked++;
        const from = bk.slot as Rec;
        const to = { slotId: target._id, date: target.date, startTime: target.startTime, endTime: target.endTime, startsAt: target.startsAt };
        const { noShowAt: _n, ...lifecycle } = bk.lifecycle as Rec;
        Object.assign(bk, { status: 'confirmed', slot: to, statusVersion: (bk.statusVersion as number) + 1, noShowReschedules: 1, lifecycle,
          noShows: [{ at: (bk.lifecycle as Rec).noShowAt, rescheduledAt: now, by: actor._id, byKind: 'member', fromSlot: from, toSlot: to, requestKey: x.requestKey, requestHash: 'h' }] });
        if (b.loseNextNoShowMove) { b.loseNextNoShowMove = false; return route.abort('failed'); }
        return ok(route, { ...bk, replayed: false });
      }
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
/** Writes as `METHOD path` (a report upload's request key left out: each upload has its own). */
const writes = (b: Backend) => b.calls.filter((c) => c.method !== 'GET' && !c.path.startsWith('/auth/'))
  .map((c) => `${c.method} ${c.path.replace(/\?requestKey=[A-Za-z0-9_-]+$/, '')}`);
const isUpload = (c: Call) => /\/reports(\?|$)/.test(c.path);

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
  // WQ11b: named by the saved template's version the editor started from.
  expect(put.body).toEqual({ slotMinutes: 30, capacity: 3, days: { mon: w, tue: w, wed: w, thu: w, fri: w, sat: [], sun: [] }, expectedUpdatedAt: '2026-11-10T05:00:00.000Z' });
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
  const input = page.getByLabel(/^Report files/);
  await input.setInputFiles([{ name: 'notes.docx', mimeType: 'application/msword', buffer: Buffer.from('x') }]);
  await expect(page.getByText('notes.docx: only PDF, JPEG, PNG or WebP files can be uploaded.')).toBeVisible();
  await page.getByRole('button', { name: 'Upload as drafts' }).click();
  expect(backend.calls.some(isUpload)).toBe(false);
  await input.setInputFiles([{ name: 'cbc.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 cbc') }]);
  await page.getByRole('button', { name: 'Upload as drafts' }).click();
  await expect(page.getByText('1 file was added as drafts. Release each one when it is checked.')).toBeVisible();
  expect(backend.calls.find(isUpload)!.files).toEqual(['cbc.pdf']);
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
  // WQ11b: every step names the status version it was reviewed on (Q11 expectedVersion); the upload keeps the version.
  expect(backend.calls.find((c) => c.path.endsWith('/assign'))!.body).toEqual({ name: 'Kiran', phone: '9000000002', expectedVersion: 1 });
  expect(backend.calls.filter((c) => /\/(collect|process|complete)$/.test(c.path)).map((c) => c.body))
    .toEqual([{ expectedVersion: 1 }, { expectedVersion: 2 }, { expectedVersion: 4 }]);
  expect(backend.calls.find((c) => c.path.endsWith('/release'))!.body).toEqual({ file: file(BK1, 'cbc.pdf'), expectedVersion: 3 });
  expect(backend.calls.find(isUpload)!.path).toMatch(/\?requestKey=[A-Za-z0-9_-]{8,100}$/);
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
  await expect(page.getByText('A no-show can be marked only after the slot has ended (09:30).')).toBeVisible();

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
  // WQ11b: each proposal names the status version it was reviewed on.
  expect(proposals.map((c) => c.body)).toEqual([{ slotId: thu, reason: 'Analyser maintenance', expectedVersion: 1 }, { slotId: fri, reason: 'Analyser maintenance', expectedVersion: 1 }]);

  await page.getByRole('button', { name: 'Reject booking' }).click();
  await expect(page.getByText(/customer’s full payment of ₹450.00 goes back to their Jansetu wallet\. This cannot be undone\./)).toBeVisible();
  await page.getByRole('button', { name: 'Reject and refund' }).click();
  await expect(page.getByText('Give a reason (at least 3 characters).')).toBeVisible();
  await page.getByLabel('Why can the lab not take this booking? (the customer sees this)').fill('No phlebotomist available');
  await page.getByRole('button', { name: 'Reject and refund' }).click();
  await expect(page.getByText('Booking rejected; the customer’s payment is back in their wallet.')).toBeVisible();
  await expect(page.getByText('Rejected by the lab: “No phlebotomist available”', { exact: false })).toBeVisible();
  await expect(page.getByText('Refunded', { exact: true }).first()).toBeVisible();
  expect(backend.calls.find((c) => c.path.endsWith('/reject'))!.body).toEqual({ reason: 'No phlebotomist available', expectedVersion: 2 });
});

test('admin: every lab’s bookings; a release under a chosen signer; report files open from in-memory blobs', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await nav(page).getByRole('link', { name: 'Lab bookings' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Esha K' })).toContainText('Lake Lab');
  await expect(page.getByRole('row').filter({ hasText: 'Asha Rao' })).toContainText('City Lab');
  await page.getByLabel('Lab').selectOption(LAB2);
  await expect(page.getByRole('row').filter({ hasText: 'Asha Rao' })).toHaveCount(0);
  expect(backend.calls.some((c) => c.path === `/partner-workspace/admin/lab-bookings?partnerId=${LAB2}&page=1&limit=100`)).toBe(true);
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

test('one step at a time: an open release waits for an upload; the page then shows every draft the server holds', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await page.goto(`/#/partner/lab-bookings/${BK3}`);
  await expect(page.getByRole('heading', { name: 'Lab booking: Chitra N' })).toBeVisible();
  const input = page.getByLabel(/^Report files/);
  await input.setInputFiles([{ name: 'a.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 a') }]);
  await page.getByRole('button', { name: 'Upload as drafts' }).click();
  const drafts = page.getByRole('list', { name: 'Draft reports' });
  await expect(drafts).toContainText('a.pdf');

  // The release confirmation is open; an upload starts and is still running: the release cannot be confirmed now.
  await drafts.getByRole('button', { name: 'Release a.pdf' }).click();
  const group = page.getByRole('group', { name: 'Release a.pdf' });
  await expect(group.getByRole('button', { name: 'Release a.pdf' })).toBeEnabled();
  const upload = hold(backend, /\/reports$/);
  await input.setInputFiles([{ name: 'b.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 b') }]);
  await page.getByRole('button', { name: 'Upload as drafts' }).click();
  await expect(group.getByRole('button', { name: 'Release a.pdf' })).toBeDisabled();
  upload();
  await expect(drafts).toContainText('b.pdf');
  await group.getByRole('button', { name: 'Release a.pdf' }).click();
  await expect(page.getByText('a.pdf was released to the customer.')).toBeVisible();
  await expect(drafts).toContainText('b.pdf'); // the newer upload is not lost from the page
  await expect(page.getByRole('list', { name: 'Released reports' })).toContainText('a.pdf · released');
  expect(writes(backend)).toEqual([
    `POST /partner-workspace/lab-bookings/${BK3}/reports`,
    `POST /partner-workspace/lab-bookings/${BK3}/reports`,
    `POST /partner-workspace/lab-bookings/${BK3}/reports/release`,
  ]);
});

test('a template save answered after another editor was opened leaves that editor and the week as they are', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Slots' }).click();
  await page.getByRole('button', { name: 'Next week' }).click();
  await expect(page.getByRole('heading', { name: /Week of .*23 Nov/ })).toBeVisible();
  await page.getByRole('button', { name: 'Edit the weekly template' }).click();
  await page.getByLabel('Seats per slot').fill('3');
  await page.getByRole('button', { name: 'Review the template' }).click();
  const save = hold(backend, /\/slot-templates\//);
  await page.getByRole('group', { name: 'Save the weekly template' }).getByRole('button', { name: 'Save the template' }).click();
  await page.getByRole('button', { name: 'Add a one-off slot' }).click();
  await page.getByLabel('Starts').fill('18:00');
  save();
  await expect(page.getByText(/Weekly template saved for home collection at Indiranagar/)).toBeVisible();
  await expect(page.getByLabel('Starts')).toHaveValue('18:00'); // the new draft is still open
  await expect(page.getByRole('heading', { name: /Week of .*23 Nov/ })).toBeVisible();

  // The reverse: a one-off slot answered after the template editor was opened leaves the editor and the week alone.
  await page.getByLabel('Date').fill('2026-11-20');
  await page.getByLabel('Ends').fill('18:30');
  await page.getByLabel('Seats', { exact: true }).fill('1');
  const add = hold(backend, /^\/partner-workspace\/slots$/);
  await page.getByRole('button', { name: 'Add slot' }).click();
  await page.getByRole('button', { name: 'Edit the weekly template' }).click();
  await page.getByLabel('Seats per slot').fill('4');
  add();
  await expect(page.getByText(/Slot .*20 Nov.*18:00–18:30 added with 1 seat\./)).toBeVisible();
  await expect(page.getByLabel('Seats per slot')).toHaveValue('4');
  await expect(page.getByRole('heading', { name: /Week of .*23 Nov/ })).toBeVisible();
});

test('WQ11d: reopening the template editor after a save shows the template as saved, read again (never an older cached copy), and a late read never resets typing', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Slots' }).click();
  await page.getByRole('button', { name: 'Edit the weekly template' }).click();
  await page.getByLabel('Seats per slot').fill('3');
  await page.getByRole('button', { name: 'Review the template' }).click();
  const save = hold(backend, /\/slot-templates\//);
  await page.getByRole('group', { name: 'Save the weekly template' }).getByRole('button', { name: 'Save the template' }).click();
  await page.getByRole('button', { name: 'Add a one-off slot' }).click(); // the editor closes while the save is held
  save();
  await expect(page.getByText(/Weekly template saved for home collection at Indiranagar/)).toBeVisible();
  // From now on the template read answers slowly (a weak connection).
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => { release = r; });
  await page.route(/\/api\/v1\/partner-workspace\/branches\/[0-9a-f]{24}\/slot-templates\/home$/, async (route) => {
    if (route.request().method() === 'GET') await gate;
    await route.fallback();
  });
  await page.getByRole('button', { name: 'Edit the weekly template' }).click();
  await expect(page.getByText('Reading the saved template…')).toBeVisible();
  await expect(page.getByLabel('Seats per slot')).toHaveCount(0); // nothing older than the save is shown
  release();
  const seats = page.getByLabel('Seats per slot');
  await expect(seats).toHaveValue('3');
  await expect(page.getByText('This is the saved weekly template.')).toBeVisible();
  await seats.fill('4');
  await page.waitForTimeout(300);
  await expect(seats).toHaveValue('4');
  await expect(page.getByText(/Someone else (changed|saved)/)).toHaveCount(0);
});

test('Q14: a lab no-show is not refunded and earns nothing; it is moved once to a new slot after a confirmation, with a key and the version; then never again', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.loseNextNoShowMove = true;
  await signInPartner(page);
  await page.goto(`/#/partner/lab-bookings/${BK1}`);
  await page.getByRole('button', { name: 'Mark no-show' }).click();
  await expect(page.getByText('The customer is not refunded and the lab earns nothing for it. Afterwards the lab may move it once to a new time')).toBeVisible();
  await page.getByRole('group', { name: 'Mark no-show' }).getByRole('button', { name: 'Mark no-show' }).click();
  await expect(page.getByText('Not refunded: the customer missed the slot. The lab earns nothing for a no-show')).toBeVisible();

  await page.getByRole('button', { name: 'Reschedule no-show' }).click();
  const form = page.getByRole('form', { name: 'Reschedule no-show' });
  await form.getByRole('button', { name: 'Continue' }).click();
  await expect(form.getByText('Choose the new time.')).toBeVisible();
  // Open slots of this branch and visit mode only (the missed one, a closed one and started ones are not offered).
  await expect(form.getByLabel('New time').locator('option', { hasText: 'Tue, 17 Nov, 2026, 09:00' })).toHaveCount(0);
  await form.getByLabel('New time').selectOption({ label: 'Wed, 18 Nov, 2026, 10:00–10:30 (2 free)' });
  await form.getByRole('button', { name: 'Continue' }).click();
  await expect(form).toContainText('Move Asha Rao’s missed time (Tue, 17 Nov, 2026, 09:00–09:30) to Wed, 18 Nov, 2026, 10:00–10:30? It is booked again at the same price: nothing is paid or refunded.');
  await expect(form).toContainText('This can be done only once');
  expect(writes(backend).filter((w) => w.endsWith('/reschedule-no-show'))).toEqual([]);
  await form.getByRole('button', { name: 'Move to Wed, 18 Nov, 2026, 10:00–10:30' }).click();

  // The move happened but its answer was lost: the same move may be sent again, or the booking checked. A read made
  // after the attempt settles it (no longer a no-show). The page clock moves on so that read is later than the attempt.
  const unsure = page.getByRole('group', { name: 'Unconfirmed no-show move' });
  await expect(unsure).toContainText('The move of Asha Rao’s no-show to Wed, 18 Nov, 2026, 10:00–10:30 has not been confirmed');
  await page.clock.setFixedTime(new Date(NOW.getTime() + 60_000));
  await unsure.getByRole('button', { name: 'Check the booking' }).click();
  await expect(page.getByText('Asha Rao’s no-show has been moved to a new time (it can be moved only once). Nothing more to do.')).toBeVisible();
  await expect(page.getByRole('list', { name: 'No-show history' })).toContainText('Missed Tue, 17 Nov, 2026, 09:00–09:30');
  await expect(page.getByRole('list', { name: 'No-show history' })).toContainText('moved to Wed, 18 Nov, 2026, 10:00–10:30');
  // Moved after a no-show: no ordinary new time and no rejection (never refunded).
  await expect(page.getByRole('button', { name: 'Propose a new time' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reject booking' })).toHaveCount(0);
  const moves = backend.calls.filter((c) => c.path.endsWith('/reschedule-no-show'));
  expect(moves).toHaveLength(1);
  expect(moves[0]!.body).toEqual({ slotId: slotId('home', '2026-11-18', '10:00'), requestKey: expect.stringMatching(/^[0-9a-f]{32}$/), expectedVersion: 2 });

  // A second no-show is final: the step stays visible, disabled.
  const bk = backend.bookings.find((x) => x._id === BK1)!;
  Object.assign(bk, { status: 'no_show', statusVersion: (bk.statusVersion as number) + 1 });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Reschedule no-show' })).toBeDisabled();
  await expect(page.getByText('Already moved once after a no-show: a second no-show is final.')).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))).not.toMatch(/Asha/);
});

test('Q14: a no-show move refused because it was already used elsewhere (NO_SHOW_RESCHEDULE_USED) says so and sends nothing more', async ({ page }) => {
  const backend = await mockBackend(page);
  const bk = backend.bookings.find((x) => x._id === BK1)!;
  Object.assign(bk, { status: 'no_show', statusVersion: 2 });
  await signInPartner(page);
  await page.goto(`/#/partner/lab-bookings/${BK1}`);
  await page.getByRole('button', { name: 'Reschedule no-show' }).click();
  const form = page.getByRole('form', { name: 'Reschedule no-show' });
  await form.getByLabel('New time').selectOption({ label: 'Wed, 18 Nov, 2026, 10:00–10:30 (2 free)' });
  await form.getByRole('button', { name: 'Continue' }).click();
  // Someone else used the one move meanwhile (another tab), and the booking was marked a no-show again.
  Object.assign(bk, { noShowReschedules: 1, noShows: [{ rescheduledAt: NOW.toISOString(), fromSlot: bk.slot, toSlot: bk.slot, requestKey: 'x'.repeat(32) }] });
  await form.getByRole('button', { name: /^Move to/ }).click();
  await expect(page.getByText('This booking was already moved once after a no-show. A second no-show is final, so it cannot be moved again.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reschedule no-show' })).toBeDisabled();
  expect(backend.calls.filter((c) => c.path.endsWith('/reschedule-no-show'))).toHaveLength(1);
});

test('WQ10b: nobody can sign a report: the release points to Staff, where an admin adds a registration, then releases under it', async ({ page }) => {
  const backend = await mockBackend(page);
  delete (backend.members![LAB2]!.find((m) => m._id === PATH) as Rec).professional;
  await signInAdmin(page);
  await page.goto(`/#/admin/partners/${LAB2}/lab-bookings/${BK5}`);
  await page.getByRole('list', { name: 'Draft reports' }).getByRole('button', { name: 'Release lipid.pdf' }).click();
  const group = page.getByRole('group', { name: 'Release lipid.pdf' });
  await expect(group).toContainText('Nobody can sign this report.');
  await expect(group).not.toContainText('cannot be added');
  await group.getByRole('link', { name: 'Staff' }).click();
  await expect(page.getByRole('heading', { name: 'Staff' })).toBeVisible();
  await page.getByRole('row').filter({ hasText: 'Dr Path' }).getByRole('button', { name: 'Add registration' }).click();
  const editor = page.getByRole('region', { name: 'Professional registration of Dr Path' });
  await editor.getByLabel('Registered as').selectOption('pathologist');
  await editor.getByLabel('Registration number').fill('KMC-88');
  await editor.getByRole('button', { name: 'Save registration' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Dr Path' })).toContainText('Pathologist · KMC-88');
  expect(backend.calls.filter((c) => c.method === 'PUT').map((c) => [c.path, c.body])).toEqual([
    [`/partner-workspace/admin/${LAB2}/workspace/members/${PATH}/professional`, { professional: { kind: 'pathologist', registrationNumber: 'KMC-88' } }],
  ]);

  await page.goto(`/#/admin/partners/${LAB2}/lab-bookings/${BK5}`);
  await page.getByRole('list', { name: 'Draft reports' }).getByRole('button', { name: 'Release lipid.pdf' }).click();
  const again = page.getByRole('group', { name: 'Release lipid.pdf' });
  await expect(again.getByLabel('Signed by').locator('option')).toHaveText(['Choose the professional', 'Dr Path · KMC-88']);
  await again.getByLabel('Signed by').selectOption(PATH);
  await again.getByRole('button', { name: 'Release lipid.pdf' }).click();
  await expect(page.getByText('lipid.pdf was released to the customer.')).toBeVisible();
});

// ───────────────────────── WQ11b (pre-production review) ─────────────────────────

const hex = (n: number) => n.toString(16).padStart(24, '0');
/** Many bookings on given days (each its own slot time, so the order is plain), for the paged lists. */
function bulk(b: Backend, from: number, count: number, days: readonly string[], o: (i: number) => Rec = () => ({})) {
  for (let i = 0; i < count; i++) {
    const date = days[i % days.length]!;
    const minute = Math.floor(i / days.length);
    const start = `${String(8 + Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
    b.bookings.push(booking(hex(from + i), { patient: { kind: 'self', name: `Patient ${from + i}` },
      slotSnap: { slotId: hex(9_000_000 + from + i), date, startTime: start, endTime: start, startsAt: istInstant(date, start) }, ...o(i) }));
  }
}

test('WQ11b: the lab list starts today, soonest first, pages on with the server’s cursor and says how many there are; Past is its own view', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.bookings = [];
  // 200 bookings of the past week and 260 from today on: the server gives at most 200 a page.
  bulk(backend, 1000, 200, ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16'], () => ({ status: 'completed' }));
  bulk(backend, 5000, 260, ['2026-11-17', '2026-11-18']);
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Lab bookings' }).click();
  const table = page.getByRole('table', { name: 'Lab bookings' });
  await expect(page.locator('.ws-count')).toHaveText('260 bookings · showing the soonest 100');
  await expect(table.locator('tbody tr')).toHaveCount(100);
  await expect(table.locator('tbody tr').first()).toContainText('Patient 5000'); // today, earliest first
  await expect(page.getByText(/Patient 1\d{3}\b/)).toHaveCount(0); // nothing from the past in this view
  const lists = () => backend.calls.filter((c) => c.method === 'GET' && c.path.startsWith('/partner-workspace/lab-bookings?'));
  expect(lists()[0]!.path).toBe('/partner-workspace/lab-bookings?from=2026-11-17&limit=100');

  await page.getByRole('button', { name: 'Show more (160 more)' }).click();
  await expect(table.locator('tbody tr')).toHaveCount(200);
  await page.getByRole('button', { name: 'Show more (60 more)' }).click();
  await expect(table.locator('tbody tr')).toHaveCount(260);
  await expect(page.locator('.ws-count')).toHaveText('260 bookings');
  await expect(page.getByRole('button', { name: /Show more/ })).toHaveCount(0);
  // Each next page names the last row of the one before (exact cursor): nothing skipped or shown twice.
  expect(lists().slice(1).map((c) => new URL(`http://x${c.path}`).searchParams.get('cursor'))).toEqual([
    expect.stringMatching(/^\d+_[0-9a-f]{24}$/), expect.stringMatching(/^\d+_[0-9a-f]{24}$/),
  ]);
  const ids = await table.locator('tbody tr td:nth-child(2)').allInnerTexts();
  expect(new Set(ids).size).toBe(260);

  // Past: before today, over chosen dates (a week back by default).
  await page.getByLabel('Past (before today)').check();
  await expect(page.locator('.ws-count')).toHaveText('200 bookings · showing the earliest 100');
  expect(lists().at(-1)!.path).toBe('/partner-workspace/lab-bookings?from=2026-11-10&to=2026-11-16&limit=100');
  await expect(table).not.toContainText('Patient 5000');
  await page.getByLabel('Slot until').fill('2026-11-18');
  await expect(page.getByText('Choose a date before today (today and later are under Upcoming).')).toBeVisible();
});

test('WQ11b: the admin list of every lab’s bookings pages on (newest first) and says how many there are', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.bookings = [];
  bulk(backend, 7000, 120, ['2026-11-18'], (i) => ({ partnerId: i % 2 ? LAB : LAB2, createdAt: new Date(Date.parse('2026-11-16T00:00:00Z') - i * 60_000).toISOString() }));
  await signInAdmin(page);
  await nav(page).getByRole('link', { name: 'Lab bookings' }).click();
  const table = page.getByRole('table', { name: 'Lab bookings of every lab' });
  await expect(page.locator('.ws-count')).toHaveText('120 bookings · showing the newest 100');
  await expect(table.locator('tbody tr')).toHaveCount(100);
  await expect(table.getByText('Patient 7100', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Show more (20 more)' }).click();
  await expect(table.locator('tbody tr')).toHaveCount(120);
  await expect(table.getByText('Patient 7119', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Show more/ })).toHaveCount(0);
  expect(backend.calls.filter((c) => c.path.startsWith('/partner-workspace/admin/lab-bookings')).map((c) => c.path)).toEqual([
    '/partner-workspace/admin/lab-bookings?page=1&limit=100', '/partner-workspace/admin/lab-bookings?page=2&limit=100',
  ]);
});

test('WQ11b: a lab step names the version it was reviewed on; when the booking changed meanwhile nothing is done and it is read again', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await page.goto(`/#/partner/lab-bookings/${BK1}`);
  await expect(page.getByRole('heading', { name: 'Lab booking: Asha Rao' })).toBeVisible();
  const reads = () => backend.calls.filter((c) => c.method === 'GET' && c.path === `/partner-workspace/lab-bookings/${BK1}`).length;
  const before = reads();
  backend.bumpBeforeStep = BK1; // someone else acts on it (version 1 → 2) right before our step arrives
  await page.getByRole('button', { name: 'Mark sample collected' }).click();
  await expect(page.getByText('Not marked collected: The booking changed since you looked at it (someone else acted on it), so nothing was done.', { exact: false })).toBeVisible();
  await expect.poll(reads).toBeGreaterThan(before);
  expect(backend.bookings.find((x) => x._id === BK1)!.status).toBe('confirmed');
  // The step is offered again on the booking as read now, and names that version.
  await page.getByRole('button', { name: 'Mark sample collected' }).click();
  await expect(page.getByText('Marked as sample collected.')).toBeVisible();
  expect(backend.calls.filter((c) => c.path.endsWith('/collect')).map((c) => c.body)).toEqual([{ expectedVersion: 1 }, { expectedVersion: 2 }]);

  // A confirmation names the version it was opened on: refused the same way, it closes and says why.
  backend.bumpBeforeStep = BK1;
  await page.getByRole('button', { name: 'Start processing' }).click();
  await expect(page.getByText(/Not moved to processing: The booking changed since you looked at it/)).toBeVisible();
});

test('WQ11b: a lab no-show move refused because the time was taken (SLOT_UNAVAILABLE) opens the picker again with the slots read again', async ({ page }) => {
  const backend = await mockBackend(page);
  const bk = backend.bookings.find((x) => x._id === BK1)!;
  Object.assign(bk, { status: 'no_show', statusVersion: 2 });
  await signInPartner(page);
  await page.goto(`/#/partner/lab-bookings/${BK1}`);
  await page.getByRole('button', { name: 'Reschedule no-show' }).click();
  const form = page.getByRole('form', { name: 'Reschedule no-show' });
  const target = backend.slots.find((s) => s._id === slotId('home', '2026-11-18', '10:00'))!;
  await form.getByLabel('New time').selectOption(target._id);
  await form.getByRole('button', { name: 'Continue' }).click();
  target.booked = target.capacity; // a customer takes the last seat while the move is being confirmed
  const slotReads = () => backend.calls.filter((c) => c.method === 'GET' && c.path.startsWith('/partner-workspace/slots?')).length;
  const before = slotReads();
  await form.getByRole('button', { name: /^Move to / }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Not moved:' })).toHaveText('Not moved: That time is no longer free. Pick another time.');
  await expect(page.getByRole('form', { name: 'Reschedule no-show' }).getByLabel('New time')).toBeVisible();
  await expect.poll(slotReads).toBeGreaterThan(before);
  await expect(page.getByRole('form', { name: 'Reschedule no-show' }).getByLabel('New time').locator('option', { hasText: 'Wed, 18 Nov, 2026, 10:00–10:30' })).toHaveCount(0);
});

test('WQ11b: a move lost before the server and then refused on the resend can be given a new time (a new move), without a reload', async ({ page }) => {
  const backend = await mockBackend(page);
  const bk = backend.bookings.find((x) => x._id === BK1)!;
  Object.assign(bk, { status: 'no_show', statusVersion: 2 });
  await signInPartner(page);
  await page.goto(`/#/partner/lab-bookings/${BK1}`);
  await page.getByRole('button', { name: 'Reschedule no-show' }).click();
  const form = page.getByRole('form', { name: 'Reschedule no-show' });
  const target = backend.slots.find((s) => s._id === slotId('home', '2026-11-18', '10:00'))!;
  await form.getByLabel('New time').selectOption(target._id);
  await form.getByRole('button', { name: 'Continue' }).click();
  backend.dropNextMove = true;
  await form.getByRole('button', { name: /^Move to / }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed no-show move' });
  await expect(panel).toBeVisible();
  target.booked = target.capacity; // somebody else takes the seat
  await page.clock.setFixedTime(new Date(NOW.getTime() + 60_000));
  await panel.getByRole('button', { name: 'Send the same move again' }).click();
  await expect(panel).toContainText('That time is no longer free. Pick another time.');
  // Still a no-show as read after that attempt, and the resend was refused for certain: a new time may be chosen.
  await page.clock.setFixedTime(new Date(NOW.getTime() + 120_000));
  await panel.getByRole('button', { name: 'Check the booking' }).click();
  await panel.getByRole('button', { name: 'Choose a new time again' }).click();
  await panel.getByRole('button', { name: 'Forget it and choose again' }).click();
  const again = page.getByRole('form', { name: 'Reschedule no-show' });
  await again.getByLabel('New time').selectOption({ label: 'Fri, 20 Nov, 2026, 09:30–10:00 (2 free)' });
  await again.getByRole('button', { name: 'Continue' }).click();
  await again.getByRole('button', { name: /^Move to / }).click();
  await expect(page.getByText('Asha Rao’s no-show is moved to Fri, 20 Nov, 2026, 09:30–10:00. It is booked again at the same price.')).toBeVisible();
  const moves = backend.calls.filter((c) => c.path.endsWith('/reschedule-no-show')).map((c) => c.body as Rec);
  expect(moves).toHaveLength(3);
  expect(moves[1]!.requestKey).toBe(moves[0]!.requestKey); // the resend: the same request
  expect(moves[2]!.requestKey).not.toBe(moves[0]!.requestKey); // the new time: a new move
});

test('WQ11b: reports go one file per request (each up to 10 MB), under a key; a size refusal says “File too large”', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await page.goto(`/#/partner/lab-bookings/${BK3}`);
  const six = Buffer.alloc(6 * 1024 * 1024, 0x41);
  const input = page.getByLabel(/^Report files/);
  await input.setInputFiles([{ name: 'page1.pdf', mimeType: 'application/pdf', buffer: six }, { name: 'page2.pdf', mimeType: 'application/pdf', buffer: six }]);
  await page.getByRole('button', { name: 'Upload as drafts' }).click();
  await expect(page.getByText('2 files were added as drafts. Release each one when it is checked.')).toBeVisible();
  const posts = backend.calls.filter(isUpload);
  expect(posts.map((c) => c.files)).toEqual([['page1.pdf'], ['page2.pdf']]);
  expect(new Set(posts.map((c) => c.path)).size).toBe(2); // a key of its own each
  await expect(page.getByRole('list', { name: 'Draft reports' })).toContainText('page2.pdf');

  // Over 10 MB on its own: said before anything is sent.
  await input.setInputFiles([{ name: 'scan.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(10 * 1024 * 1024 + 1, 0x41) }]);
  await expect(page.getByText('scan.pdf is larger than 10 MB.').first()).toBeVisible();
  await page.getByRole('button', { name: 'Upload as drafts' }).click();
  expect(backend.calls.filter(isUpload)).toHaveLength(2);
  // Just under 10 MB, but the server counts the request as larger (formidable, 500 UPLOAD_FAILED): “File too large”.
  await input.setInputFiles([{ name: 'big.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(10 * 1024 * 1024 - 10, 0x41) }]);
  await page.getByRole('button', { name: 'Upload as drafts' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'File too large: big.pdf is over the 10 MB limit, so it was not uploaded.' })).toBeVisible();
  await expect(page.getByText(/may have been uploaded/)).toHaveCount(0);
});

test('WQ11d: after an unanswered upload the same files and keys are kept: no other files until it is settled, and never a second copy', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await page.goto(`/#/partner/lab-bookings/${BK3}`);
  const input = page.getByLabel(/^Report files/);
  await input.setInputFiles([{ name: 'cbc.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 cbc') }]);
  backend.loseNextUpload = true;
  await page.getByRole('button', { name: 'Upload as drafts' }).click();
  await expect(page.getByText(/cbc\.pdf: .*It may have been uploaded/)).toBeVisible();
  // Choosing again is blocked (it would be a new key, so a second copy): only "Upload the rest" or a check.
  await expect(input).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Upload the rest' })).toBeVisible();
  await page.getByRole('button', { name: 'Check the reports' }).click();
  await expect(input).toBeEnabled(); // found among the drafts: settled
  await expect(page.getByRole('list', { name: 'Draft reports' })).toContainText('cbc.pdf');
  // The same again, settled by sending the rest with the same key: answered, not copied.
  await input.setInputFiles([{ name: 'lipid.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 lipid') }]);
  backend.loseNextUpload = true;
  await page.getByRole('button', { name: 'Upload as drafts' }).click();
  await expect(input).toBeDisabled();
  await page.getByRole('button', { name: 'Upload the rest' }).click();
  await expect(page.getByText('1 file was added as drafts. Release each one when it is checked.')).toBeVisible();
  await expect(input).toBeEnabled();
  const bk = backend.bookings.find((x) => x._id === BK3)!;
  expect((bk.report as { draftFiles: string[] }).draftFiles.filter((f) => f.endsWith('/lipid.pdf'))).toHaveLength(1);
  const sent = backend.calls.filter(isUpload).map((c) => c.path);
  expect(sent).toHaveLength(3);
  expect(sent[2]).toBe(sent[1]); // the resend used the same key
});

test('WQ11b: keyboard focus moves into a confirmation or panel when it opens and back to its button on Back', async ({ page }) => {
  await mockBackend(page);
  await signInPartner(page);
  await page.goto(`/#/partner/lab-bookings/${BK1}`);
  const active = () => page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    return `${a?.tagName}:${a?.getAttribute('aria-label') ?? a?.id ?? ''}:${(a?.textContent ?? '').trim().slice(0, 30)}`;
  });
  // ConfirmAction (Reject): into the reason field, then back to the trigger.
  await page.getByRole('button', { name: 'Reject booking' }).focus();
  await page.keyboard.press('Enter');
  const reject = page.getByRole('group', { name: 'Reject booking' });
  await expect(reject).toBeVisible();
  await expect(reject.getByRole('textbox')).toBeFocused();
  await reject.getByRole('button', { name: 'Back' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Reject booking' })).toBeFocused();
  // The collector panel, the new-time panel and the release panel do the same.
  await page.getByRole('button', { name: 'Assign collector' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Who collects')).toBeFocused();
  await page.getByRole('form', { name: 'Assign collector' }).getByRole('button', { name: 'Back' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Assign collector' })).toBeFocused();
  await page.getByRole('button', { name: 'Propose a new time' }).focus();
  await page.keyboard.press('Enter');
  const propose = page.getByRole('form', { name: 'Propose a new time' });
  await expect(propose.getByLabel('New time')).toBeFocused();
  await propose.getByRole('button', { name: 'Back' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Propose a new time' })).toBeFocused();
  expect(await active()).toMatch(/^BUTTON:/);
});

test('WQ11d: Enter twice on "Mark no-show" does nothing: the confirmation opens on Back, never on the irreversible step', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await page.goto(`/#/partner/lab-bookings/${BK1}`);
  const trigger = page.getByRole('button', { name: 'Mark no-show' });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const group = page.getByRole('group', { name: 'Mark no-show' });
  await expect(group.getByRole('button', { name: 'Back' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(trigger).toBeFocused();
  expect(writes(backend)).toEqual([]);
  // The time picker of a new time keeps its field focus; its confirmation step opens on Back.
  await page.getByRole('button', { name: 'Propose a new time' }).click();
  const propose = page.getByRole('form', { name: 'Propose a new time' });
  await expect(propose.getByLabel('New time')).toBeFocused();
});

test('WQ11b: marking a booking moved once after a no-show as a no-show again says it is final (no move is promised)', async ({ page }) => {
  const backend = await mockBackend(page);
  const bk = backend.bookings.find((x) => x._id === BK1)!;
  Object.assign(bk, { noShowReschedules: 1, noShows: [{ at: '2026-11-16T05:00:00.000Z', rescheduledAt: '2026-11-16T06:00:00.000Z', fromSlot: bk.slot, toSlot: bk.slot, requestKey: 'x'.repeat(32) }] });
  await signInPartner(page);
  await page.goto(`/#/partner/lab-bookings/${BK1}`);
  await page.getByRole('button', { name: 'Mark no-show' }).click();
  const confirm = page.getByRole('group', { name: 'Mark no-show' });
  await expect(confirm).toContainText('This booking was already moved once after a no-show, so this second no-show is final: it cannot be moved again');
  await expect(confirm).not.toContainText('Afterwards the lab may move it once');
});

test('WQ11 (Q16a): a no-show is offered only once the arrival window has ended, not when it starts', async ({ page }) => {
  const backend = await mockBackend(page);
  const bk = backend.bookings.find((x) => x._id === BK1)!;
  // 09:45–10:15 India time; the page clock is 10:00: the slot has started but the patient may still come.
  bk.slot = { slotId: slotId('home', '2026-11-17', '09:30'), date: '2026-11-17', startTime: '09:45', endTime: '10:15', startsAt: istInstant('2026-11-17', '09:45') };
  await signInPartner(page);
  await page.goto(`/#/partner/lab-bookings/${BK1}`);
  await expect(page.getByRole('heading', { name: 'Lab booking: Asha Rao' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark no-show' })).toBeDisabled();
  await expect(page.getByText('A no-show can be marked only after the slot has ended (10:15).')).toBeVisible();
  // At the window's end it is offered.
  await page.clock.setFixedTime(new Date(Date.parse(istInstant('2026-11-17', '10:15'))));
  await page.goto('/#/partner/lab-bookings'); // the booking page reads the clock again when it is opened again
  await page.goto(`/#/partner/lab-bookings/${BK1}`);
  await expect(page.getByRole('button', { name: 'Mark no-show' })).toBeEnabled();
  await expect(page.getByText(/A no-show can be marked only after/)).toHaveCount(0);
});

test('WQ11b: the weekly template editor edits the saved template and saves on its version; a save in between is shown, not overwritten', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Slots' }).click();
  await page.getByRole('button', { name: 'Edit the weekly template' }).click();
  await expect(page.getByText('This is the saved weekly template.')).toBeVisible();
  await expect(page.getByText(/does not return the saved template/)).toHaveCount(0);
  expect(backend.calls.some((c) => c.method === 'GET' && c.path === `/partner-workspace/branches/${BR1}/slot-templates/home`)).toBe(true);
  await page.getByLabel('Seats per slot').fill('3');
  await page.getByRole('button', { name: 'Review the template' }).click();
  // Someone else saves the template (4 seats) right before ours arrives.
  backend.templateSavedElsewhere = { ...backend.templates[`${BR1}:home`], capacity: 4 };
  await page.getByRole('group', { name: 'Save the weekly template' }).getByRole('button', { name: 'Save the template' }).click();
  await expect(page.getByText('Someone else changed the seats per slot while you were editing.', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Seats per slot')).toHaveValue('4');
  expect(backend.templates[`${BR1}:home`]!.capacity).toBe(4); // ours was refused (409 TEMPLATE_CHANGED), nothing overwritten
  const puts = () => backend.calls.filter((c) => c.method === 'PUT' && c.path.includes('/slot-templates/'));
  expect((puts()[0]!.body as Rec).expectedUpdatedAt).toBe('2026-11-10T05:00:00.000Z');
  // Saving again goes on the version now shown.
  await page.getByLabel('Seats per slot').fill('3');
  await page.getByRole('button', { name: 'Review the template' }).click();
  await page.getByRole('group', { name: 'Save the weekly template' }).getByRole('button', { name: 'Save the template' }).click();
  await expect(page.getByText(/Weekly template saved for home collection at Indiranagar/)).toBeVisible();
  expect(backend.templates[`${BR1}:home`]!.capacity).toBe(3);
  expect((puts()[1]!.body as Rec).expectedUpdatedAt).toEqual(expect.stringMatching(/^2026-11-17T04:00:0\d\.000Z$/)); // the other save's version

  // A branch and mode with no template yet starts from the opening hours, and its save names “no template” (null).
  delete backend.templates[`${BR1}:lab`];
  await page.getByLabel('Visit type').selectOption('lab');
  await page.getByRole('button', { name: 'Edit the weekly template' }).click();
  await expect(page.getByText('There is no weekly template yet, so this starts from the branch’s opening hours.')).toBeVisible();
  await page.getByRole('button', { name: 'Review the template' }).click();
  await page.getByRole('group', { name: 'Save the weekly template' }).getByRole('button', { name: 'Save the template' }).click();
  await expect(page.getByText(/Weekly template saved for lab visits at Indiranagar|Weekly template saved for/)).toBeVisible();
  expect((puts()[2]!.body as Rec).expectedUpdatedAt).toBeNull();
});

test('WQ11b (Q16a): an admin cancels a booking moved after a no-show, choosing whether the patient is refunded; nothing is chosen for them', async ({ page }) => {
  const backend = await mockBackend(page);
  const bk = backend.bookings.find((x) => x._id === BK1)!;
  Object.assign(bk, { noShowReschedules: 1, noShows: [{ at: '2026-11-16T05:00:00.000Z', rescheduledAt: '2026-11-16T06:00:00.000Z', fromSlot: bk.slot, toSlot: bk.slot, requestKey: 'x'.repeat(32) }] });
  await signInAdmin(page);
  await page.goto(`/#/admin/partners/${LAB}/lab-bookings/${BK1}`);
  await page.getByRole('button', { name: 'Cancel (admin)' }).click();
  const form = page.getByRole('form', { name: 'Cancel (admin)' });
  await expect(form.getByLabel('Reason (the patient sees this)')).toBeFocused();
  await form.getByRole('button', { name: 'Continue' }).click();
  await expect(form.getByText('Give a reason (at least 3 characters).')).toBeVisible();
  await expect(form.getByText('Choose whether the patient is refunded.')).toBeVisible();
  await form.getByLabel('Reason (the patient sees this)').fill('The lab cannot attend the new time');
  await form.getByRole('radio', { name: 'No: the payment is kept' }).check();
  await form.getByRole('button', { name: 'Continue' }).click();
  await expect(form).toContainText('The patient is not refunded: the payment is kept, as for a no-show, and nobody earns it.');
  await form.getByRole('button', { name: 'Cancel without a refund' }).click();
  await expect(page.getByText('Cancelled by the Jansetu team; the patient was not refunded.')).toBeVisible();
  await expect(page.getByText('Cancelled by the Jansetu team after a no-show move', { exact: false })).toBeVisible();
  // WQ11d: the booking itself says whether the patient was refunded.
  await expect(page.getByText('The patient was not refunded: the payment is kept, as for a no-show, and nobody earns it.', { exact: false })).toBeVisible();
  expect(backend.calls.filter((c) => c.path.endsWith('/cancel-no-show')).map((c) => [c.path, c.body])).toEqual([
    [`/partner-workspace/admin/lab-bookings/${BK1}/cancel-no-show`, { reason: 'The lab cannot attend the new time', refund: false }],
  ]);
  await expect(page.getByRole('button', { name: 'Cancel (admin)' })).toHaveCount(0);
  // Members never see it (only admins cancel a moved no-show).
  await page.goto(`/#/admin/partners/${LAB}/lab-bookings/${BK2}`);
  await expect(page.getByRole('heading', { name: 'Lab booking: Bala Rao' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel (admin)' })).toHaveCount(0); // not moved after a no-show
});

test('WQ11 (Q16a final): an admin cancel of a moved no-show that another admin already cancelled is refused 409 ALREADY_CANCELLED and said as already done', async ({ page }) => {
  const backend = await mockBackend(page);
  const bk = backend.bookings.find((x) => x._id === BK1)!;
  Object.assign(bk, { noShowReschedules: 1, noShows: [{ at: '2026-11-16T05:00:00.000Z', rescheduledAt: '2026-11-16T06:00:00.000Z', fromSlot: bk.slot, toSlot: bk.slot, requestKey: 'x'.repeat(32) }] });
  await signInAdmin(page);
  await page.goto(`/#/admin/partners/${LAB}/lab-bookings/${BK1}`);
  await page.getByRole('button', { name: 'Cancel (admin)' }).click();
  const form = page.getByRole('form', { name: 'Cancel (admin)' });
  await form.getByLabel('Reason (the patient sees this)').fill('The lab cannot attend the new time');
  await form.getByRole('radio', { name: 'No: the payment is kept' }).check();
  await form.getByRole('button', { name: 'Continue' }).click();
  // Meanwhile another admin cancelled it with a refund.
  Object.assign(bk, { status: 'cancelled', statusVersion: (bk.statusVersion as number) + 1, paymentStatus: 'refunded',
    cancellation: { reason: 'admin_no_show', note: 'Another admin', by: `admin:${ADMIN}`, byKind: 'admin', at: NOW.toISOString(), refund: true } });
  await form.getByRole('button', { name: 'Cancel without a refund' }).click();
  await expect(page.getByText('This booking was already cancelled (by another admin, or by an earlier try whose answer was lost): nothing more was done. It is shown as it is now.')).toBeVisible();
  await expect(page.getByText(/^Not cancelled/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel (admin)' })).toHaveCount(0);
  await expect(page.getByText('The patient’s payment of ₹450.00 went back to their Jansetu wallet.', { exact: false })).toBeVisible();
  expect(backend.calls.filter((c) => c.path.endsWith('/cancel-no-show'))).toHaveLength(1);
  expect((bk.cancellation as Rec).refund).toBe(true); // the refused repeat changed nothing
});
