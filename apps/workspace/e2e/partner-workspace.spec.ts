import { expect, test, type Page, type Route } from '@playwright/test';

/** WQ1: lab/clinic partner workspace (members and admins acting as owner), against a mocked backend. */
const LAB = 'a1'.repeat(12);
const CLINIC = 'a2'.repeat(12);
const OWNER = 'b1'.repeat(12);
const STAFF = 'b2'.repeat(12);
const NEWBIE = 'b3'.repeat(12);
const BR1 = 'c1'.repeat(12);
const BR2 = 'c2'.repeat(12);
const ADMIN = 'ad'.repeat(12);
const ALL = ['staff.manage', 'branches.manage', 'catalogue.manage', 'slots.manage', 'bookings.view', 'bookings.manage', 'reports.upload',
  'reports.release', 'invoices.create', 'invoices.cancel', 'payments.record', 'finance.view'];

type Rec = Record<string, unknown>;
interface Me { _id: string; partnerId: string; name: string; role: 'owner' | 'staff'; permissions: string[]; branchIds: string[] }
interface Backend {
  calls: { method: string; path: string; body: unknown }[];
  me: Me;
  /** Verify answers a choice of workspaces instead of a session. */
  multi: boolean;
  /** The select answers 401 SELECTION_EXPIRED. */
  expired: boolean;
  members: Rec[];
  branches: Rec[];
  partners: Rec[];
  /** The next add-member answers 409. */
  conflictOnce: boolean;
  /** Add-member answers this many ms late. */
  slowAdd: number;
  /** WQ9: an add with an email is refused 403 OWNER_REQUIRED (the server no longer sees an owner). */
  ownerLost: boolean;
  /** WQ9: an email PUT answers this many ms late. */
  slowEmail: number;
  /** The next partner create commits but its answer is lost on the network. */
  dropCreate: boolean;
  /** requestKey → { hash, partner } (Q8 exactly-once creation). */
  creates: Map<string, { hash: string; partner: Rec }>;
  /** Q10: keys given up (they can never create). */
  abandoned: Set<string>;
  /** The next create is lost before it commits (nothing created, no answer). */
  loseCreate: boolean;
  /** Create answers this many ms late. */
  slowCreate: number;
  /** GET /members/:id answers this many ms late. */
  slowMemberRead: number;
  /** Q10: someone else edits the record right before the next workspace PUT is applied (so it answers 409). */
  raceOnce: ((rec: Rec) => void) | null;
  /** An admin cookie session exists (a reload restores it). */
  adminLive: boolean;
  /** WQ10b: the next registration PUT is saved but its answer is lost on the network. */
  dropProfessional?: boolean;
  /** Test-controlled: the abandon answer waits for this (its outcome is decided when it is released). */
  holdAbandon: Promise<void> | null;
  /** Test-controlled: a create commits at once but its answer waits for this. */
  holdCreate: Promise<void> | null;
  /** Abandon answers sent so far. */
  abandonAnswers: string[];
  /** WQ11b: the next branch create is lost before it is made ('before') or made and its answer lost ('after'). */
  dropBranch?: 'before' | 'after' | null;
  /** WQ11d: the next branch create is refused 403 (e.g. a permission just removed). */
  refuseNextBranch?: boolean;
}

let clock = 0;
/** Q10: every write moves the record's version. */
const touch = (rec: Rec) => { rec.updatedAt = new Date(Date.UTC(2026, 10, 15, 6, 0, ++clock)).toISOString(); };
const V0 = '2026-11-14T00:00:00.000Z';

function partner(id: string, name: string, kind: 'lab' | 'clinic', state = 'verified', owners = 1): Rec {
  return { _id: id, kind, name, contact: { phone: '9000000000' }, verification: { state }, taxRegime: 'unregistered',
    invoiceSeries: { prefix: 'CL' }, activeOwnerCount: owners, isActive: state !== 'suspended', createdAt: '2026-11-10T05:00:00.000Z' };
}

const ownerMe: Me = { _id: OWNER, partnerId: LAB, name: 'Ravi Owner', role: 'owner', permissions: ALL, branchIds: [] };
const sitaMe: Me = { _id: STAFF, partnerId: LAB, name: 'Sita Staff', role: 'staff', permissions: ['bookings.view'], branchIds: [BR1] };
const BR_OLD = 'c9'.repeat(12);
/** WQ9: an email another account already signs in with (409 EMAIL_IN_USE). */
const TAKEN = 'taken@lab.in';

async function mockBackend(page: Page, me: Me = ownerMe, opts: Partial<Pick<Backend, 'multi' | 'expired'>> & { many?: boolean } = {}): Promise<Backend> {
  const b: Backend = {
    calls: [], me, multi: false, expired: false, conflictOnce: false, slowAdd: 0, ownerLost: false, slowEmail: 0, dropCreate: false, creates: new Map(),
    abandoned: new Set(), loseCreate: false, slowCreate: 0, slowMemberRead: 0, raceOnce: null, adminLive: false,
    holdAbandon: null, holdCreate: null, abandonAnswers: [], ...opts,
    members: [
      { _id: OWNER, partnerId: LAB, name: 'Ravi Owner', phone: '9000000001', role: 'owner', permissions: ALL, branchIds: [], isActive: true, updatedAt: V0 },
      { _id: STAFF, partnerId: LAB, name: 'Sita Staff', phone: '9000000002', role: 'staff', permissions: ['bookings.view'], branchIds: [BR1], isActive: true, updatedAt: V0 },
    ],
    branches: [
      { _id: BR1, partnerId: LAB, name: 'Indiranagar', address: { line1: '1 Main Rd', city: 'Bengaluru', state: 'Karnataka', stateCode: '29', pincode: '560038' },
        phone: '9000000010', hours: { mon: { open: '08:00', close: '20:00' } }, holidays: [], services: { homeCollection: true, inLab: true, inClinic: false }, isActive: true, updatedAt: V0 },
      { _id: BR_OLD, partnerId: LAB, name: 'Old Town', address: { line1: '9 Old Rd', city: 'Mysuru', state: 'Karnataka', stateCode: '29', pincode: '570001' },
        phone: '9000000011', holidays: [], services: { inLab: true }, isActive: false },
    ],
    partners: [partner(LAB, 'City Lab', 'lab', 'pending'), partner(CLINIC, 'Sunrise Clinic', 'clinic'),
      ...(opts.many ? Array.from({ length: 21 }, (_, i) => partner(`e${String(i).padStart(2, '0')}`.repeat(8), `Zeta Lab ${String(i + 1).padStart(2, '0')}`, 'lab')) : [])],
  };
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const ok = (route: Route, data: unknown, status = 200) => json(route, status, { success: true, data });
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = req.method();
    const body = ['POST', 'PUT'].includes(method) ? req.postDataJSON() : null;
    if (!path.startsWith('/auth/session')) b.calls.push({ method, path: `${path}${url.search}`, body });
    if (path === '/auth/partner/send' || path === '/auth/admin/send') return ok(route, undefined);
    if (path === '/auth/partner/verify') {
      if (b.multi) {
        return ok(route, { selectionRequired: true, ticket: 'ticket-1', choices: [
          { partnerId: LAB, name: 'City Lab', kind: 'lab', solo: false, role: 'owner' },
          { partnerId: CLINIC, name: 'Sunrise Clinic', kind: 'clinic', solo: true, role: 'staff' },
        ] });
      }
      return ok(route, { token: 't1', expiresIn: 900, user: {} });
    }
    if (path === '/auth/partner/select') {
      if (b.expired) return json(route, 401, { error: 401, code: 'SELECTION_EXPIRED', message: 'This sign-in expired; request a new code' });
      b.me = { ...b.me, partnerId: (body as Rec).partnerId as string };
      if ((body as Rec).session === 'native') return ok(route, { token: 't1', expiresIn: 900, refreshToken: 'rt-p', refreshExpiresIn: 43200, user: {} });
      return ok(route, { token: 't1', expiresIn: 900, user: {} });
    }
    if (path === '/auth/admin/verify') { b.adminLive = true; return ok(route, { token: 'admin', expiresIn: 900, user: {} }); }
    if (path === '/auth/session/refresh') {
      if (!b.adminLive) return json(route, 401, { error: 401, code: 'SESSION_ENDED', message: 'Please sign in again' });
      return ok(route, { token: 'admin', expiresIn: 900, principal: { userId: ADMIN, userType: 'admin', sid: 's1' } });
    }
    const auth = req.headers().authorization;
    if (auth !== 'Bearer t1' && auth !== 'Bearer admin') return json(route, 401, { error: 401, message: 'Authentication is required' });
    if (path === '/auth/profile') {
      if (auth === 'Bearer admin') return ok(route, { user: { _id: ADMIN, name: 'Ops Admin' }, userRole: 'admin' });
      const p = b.partners.find((x) => x._id === b.me.partnerId)!;
      return ok(route, { user: { ...b.me, phone: '9000000001', isActive: true }, partner: { ...p, verification: { state: 'verified' } }, userRole: 'partner' });
    }

    // Admin partner accounts (Q8: search, paging; exactly-once creation by request key)
    if (path === '/partner-workspace/admin' && method === 'GET') {
      const kind = url.searchParams.get('kind');
      const state = url.searchParams.get('verificationState');
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const pg = Number(url.searchParams.get('page') ?? 1);
      const all = b.partners.filter((p) => (!kind || p.kind === kind) && (!state || (p.verification as Rec).state === state)
        && (!q || String(p.name).toLowerCase().includes(q))).sort((x, y) => String(x.name).localeCompare(String(y.name)));
      return json(route, 200, { success: true, data: all.slice((pg - 1) * limit, pg * limit),
        pagination: { page: pg, limit, total: all.length, totalPages: Math.max(1, Math.ceil(all.length / limit)) } });
    }
    const byKey = /^\/partner-workspace\/admin\/by-key\/([A-Za-z0-9_-]+)(\/abandon)?$/.exec(path);
    if (byKey) {
      const made = b.creates.get(byKey[1]!);
      if (byKey[2]) {
        if (b.holdAbandon) await b.holdAbandon;
        const now = b.creates.get(byKey[1]!);
        b.abandonAnswers.push(now ? 'used' : 'abandoned');
        if (now) return ok(route, { state: 'used', partner: now.partner });
        b.abandoned.add(byKey[1]!);
        return ok(route, { state: 'abandoned' });
      }
      return made ? ok(route, { partner: made.partner, owner: { _id: NEWBIE } }) : json(route, 404, { error: 404, code: 'PARTNER_NOT_FOUND', message: 'No partner was created with this key' });
    }
    if (path === '/partner-workspace/admin' && method === 'POST') {
      if (b.slowCreate) await new Promise((r) => setTimeout(r, b.slowCreate));
      if (b.loseCreate) { b.loseCreate = false; return route.abort('failed'); }
      const { requestKey, ...x } = body as Rec;
      if (b.abandoned.has(String(requestKey))) return json(route, 409, { error: 409, code: 'REQUEST_KEY_ABANDONED', message: 'This request was given up' });
      const hash = JSON.stringify(x);
      const prior = b.creates.get(String(requestKey));
      if (prior) {
        if (prior.hash !== hash) return json(route, 409, { error: 409, code: 'REQUEST_KEY_REUSED', message: 'This request key was already used for a different partner' });
        return ok(route, { partner: prior.partner, owner: { _id: NEWBIE } }, 200);
      }
      if ((x.firstOwner as Rec).email === TAKEN) return json(route, 409, { error: 409, code: 'EMAIL_IN_USE', message: 'This email is already in use' });
      const created = { ...partner('a3'.repeat(12), x.name as string, x.kind as 'lab', 'pending'), contact: { phone: x.contactPhone } };
      b.partners.push(created);
      if (requestKey) b.creates.set(String(requestKey), { hash, partner: created });
      if (b.dropCreate) { b.dropCreate = false; return route.abort('failed'); }
      if (b.holdCreate) await b.holdCreate;
      return ok(route, { partner: created, owner: { _id: NEWBIE, name: (x.firstOwner as Rec).name } }, 201);
    }
    const adm = /^\/partner-workspace\/admin\/([0-9a-f]{24})(\/verify|\/suspend|\/reinstate)?$/.exec(path);
    if (adm) {
      const p = b.partners.find((x) => x._id === adm[1]);
      if (!p) return json(route, 404, { error: 404, code: 'PARTNER_NOT_FOUND', message: 'Partner not found' });
      if (adm[2] === '/verify') {
        if ((p.verification as Rec).state !== 'pending') return json(route, 409, { error: 409, code: 'VERIFICATION_STATE_CONFLICT', message: 'Partner is not in pending state' });
        p.verification = { state: 'verified', verifiedAt: '2026-11-15T05:00:00.000Z' };
      } else if (adm[2] === '/suspend') {
        p.verification = { state: 'suspended' }; p.isActive = false;
      } else if (adm[2] === '/reinstate') {
        if ((p.verification as Rec).state !== 'suspended') return json(route, 409, { error: 409, code: 'NOT_SUSPENDED', message: 'Only a suspended partner can be reinstated' });
        p.verification = { state: 'verified' }; p.isActive = true;
      }
      return ok(route, p);
    }

    // Workspace (members, or an admin under /admin/:id/workspace)
    const ws = /^\/partner-workspace(?:\/admin\/([0-9a-f]{24})\/workspace)?(\/.*)$/.exec(path);
    if (ws) {
      if (ws[1] && auth !== 'Bearer admin') return json(route, 403, { error: 403, message: 'Admin access is required' });
      const sub = ws[2]!;
      const pid = ws[1] ?? b.me.partnerId;
      if (sub === '/me' && method === 'GET') return ok(route, b.partners.find((p) => p._id === pid));
      /** Q10: a PUT made from an older version is refused. */
      const fenced = (rec: Rec) => {
        if (b.raceOnce) { b.raceOnce(rec); touch(rec); b.raceOnce = null; }
        const expected = (body as Rec).expectedUpdatedAt;
        return expected && expected !== rec.updatedAt;
      };
      const changed = (route2: Route) => json(route2, 409, { error: 409, code: 'RECORD_CHANGED', message: 'Someone else changed this meanwhile; reload and review' });
      if (sub === '/me' && method === 'PUT') {
        const p = b.partners.find((x) => x._id === pid)!;
        if (fenced(p)) return changed(route);
        if ((body as Rec).name) p.name = (body as Rec).name;
        touch(p);
        return ok(route, p);
      }
      if (sub === '/members' && method === 'GET') return ok(route, b.members);
      if (sub === '/members' && method === 'POST') {
        if (b.slowAdd) await new Promise((r) => setTimeout(r, b.slowAdd));
        if (b.conflictOnce) {
          b.conflictOnce = false;
          return json(route, 409, { error: 409, code: 'MEMBER_ALREADY_EXISTS', message: 'An active member with this phone already exists for this partner' });
        }
        if ((body as Rec).email === TAKEN) return json(route, 409, { error: 409, code: 'EMAIL_IN_USE', message: 'This email is already in use' });
        if ((body as Rec).email && (b.ownerLost || (!ws[1] && b.me.role !== 'owner'))) {
          return json(route, 403, { error: 403, code: 'OWNER_REQUIRED', message: 'Only an owner can give a member a sign-in email' });
        }
        const m = { _id: `${NEWBIE.slice(0, -2)}${String(b.members.length).padStart(2, '0')}`, partnerId: pid, isActive: true, ...(body as Rec), branchIds: (body as Rec).branchIds ?? [] };
        b.members.push(m);
        return ok(route, m, 201);
      }
      const mm = /^\/members\/([0-9a-f]{24})(\/permissions|\/branches|\/email|\/professional)?$/.exec(sub);
      if (mm && method === 'DELETE') { b.members = b.members.filter((m) => m._id !== mm[1]); return json(route, 200, { success: true, message: 'Member removed' }); }
      if (mm && method === 'GET') {
        if (b.slowMemberRead) await new Promise((r) => setTimeout(r, b.slowMemberRead));
        return ok(route, b.members.find((x) => x._id === mm[1]));
      }
      if (mm && mm[2]) {
        const m = b.members.find((x) => x._id === mm[1])!;
        if (fenced(m)) return changed(route);
        if (mm[2] === '/email' && b.slowEmail) await new Promise((r) => setTimeout(r, b.slowEmail));
        if (mm[2] === '/professional') {
          // Q11 setMemberProfessional: owners only (admins act as owner); null removes it.
          if (!ws[1] && b.me.role !== 'owner') return json(route, 403, { error: 403, code: 'OWNER_REQUIRED', message: 'Only an owner can record professional registrations' });
          const prof = (body as Rec).professional as Rec | null;
          if (prof) m.professional = { kind: prof.kind, registrationNumber: String(prof.registrationNumber).trim() }; else delete m.professional;
          touch(m);
          if (b.dropProfessional) { b.dropProfessional = false; return route.abort('failed'); }
          return ok(route, m);
        }
        if (mm[2] === '/email') {
          // WQ9 (assumed contract): null removes the email; one used by another account is refused.
          const email = (body as Rec).email;
          if (email === TAKEN) return json(route, 409, { error: 409, code: 'EMAIL_IN_USE', message: 'This email is already in use' });
          if (email === null) delete m.email; else m.email = email;
        } else if (mm[2] === '/permissions') m.permissions = (body as Rec).permissions; else m.branchIds = (body as Rec).branchIds;
        touch(m);
        return ok(route, m);
      }
      if (sub === '/branches' && method === 'GET') {
        const scoped = b.me.role === 'staff' && b.me.branchIds.length > 0 && !ws[1];
        const withClosed = url.searchParams.get('includeInactive') === 'true';
        return ok(route, b.branches.filter((x) => (withClosed || x.isActive) && (!scoped || b.me.branchIds.includes(x._id as string))));
      }
      if (sub === '/branches' && method === 'POST') {
        // Q16b `createBranch`: with a request key, exactly once per (partner, key); a resend answers the branch it made.
        const { requestKey, ...content } = body as Rec;
        const prior = requestKey ? b.branches.find((x) => x.createRequestKey === requestKey) : undefined;
        if (prior) return json(route, 200, { success: true, data: prior, replayed: true });
        if (b.dropBranch === 'before') { b.dropBranch = null; return route.abort('failed'); }
        if (b.refuseNextBranch) { b.refuseNextBranch = false; return json(route, 403, { error: 403, code: 'PERMISSION_DENIED', message: 'You may not add branches' }); }
        const id = b.branches.some((x) => x._id === BR2) ? `d${b.branches.length % 10}`.repeat(12) : BR2;
        const br = { _id: id, partnerId: pid, isActive: true, updatedAt: V0, ...content, ...(requestKey ? { createRequestKey: requestKey } : {}) };
        b.branches.push(br);
        if (b.dropBranch === 'after') { b.dropBranch = null; return route.abort('failed'); }
        return ok(route, br, 201);
      }
      const bm = /^\/branches\/([0-9a-f]{24})(\/reactivate)?$/.exec(sub);
      const br = bm ? b.branches.find((x) => x._id === bm[1]) : undefined;
      if (bm && br && method === 'GET') return ok(route, br);
      if (bm && br && method === 'PUT') {
        if (fenced(br)) return changed(route);
        const { expectedUpdatedAt: _v, ...rest } = body as Rec;
        Object.assign(br, rest); touch(br);
        return ok(route, br);
      }
      if (bm && br && method === 'DELETE') { br.isActive = false; return json(route, 200, { success: true, message: 'Branch deactivated' }); }
      if (bm && br && bm[2]) { br.isActive = true; return ok(route, br); }
      if (sub === '/audit') {
        return ok(route, [{ _id: 'e1', partnerId: pid, actorKind: 'member', actorId: OWNER, action: 'member.add', targetKind: 'member', targetId: STAFF,
          detail: { role: 'staff', permissions: ['bookings.view'] }, at: '2026-11-15T04:30:00.000Z' }]);
      }
    }
    return json(route, 404, { error: 404, message: 'Not found' });
  });
  return b;
}

async function signInPartner(page: Page) {
  await page.goto('/');
  await page.getByLabel('Lab or clinic staff').check();
  await page.getByLabel('Mobile number').fill('9000000001');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
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

test('a partner with one workspace signs in directly; an owner sees every organisation page', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await expect(page.getByRole('heading', { name: 'Welcome, Ravi Owner' })).toBeVisible();
  await expect(page.getByText('Lab · City Lab')).toBeVisible();
  for (const name of ['Profile', 'Staff', 'Branches', 'Activity log']) await expect(nav(page).getByRole('link', { name })).toBeVisible();
  await expect(nav(page).getByRole('link', { name: 'Orders' })).toHaveCount(0);
  expect(backend.calls.find((c) => c.path === '/auth/partner/verify')?.body).toMatchObject({ phone: '9000000001', otp: '123456', session: 'cookie' });
  expect(backend.calls.some((c) => c.path === '/auth/partner/select')).toBe(false);

  await nav(page).getByRole('link', { name: 'Activity log' }).click();
  const row = page.getByRole('row').filter({ hasText: 'Added a member' });
  await expect(row).toContainText('Ravi Owner');
  await expect(row).toContainText('Sita Staff');
  await expect(row).toContainText('View bookings');
});

test('several workspaces: the person chooses one and select is sent with that partner', async ({ page }) => {
  const backend = await mockBackend(page, ownerMe, { multi: true });
  await signInPartner(page);
  await expect(page.getByText('Which one do you want to open?')).toBeVisible();
  await expect(page.getByRole('radio')).toHaveCount(2);
  await expect(page.getByText('Clinic · single-doctor practice · Staff')).toBeVisible();
  await page.getByRole('button', { name: 'Open workspace' }).click();
  await expect(page.getByText('Choose the workspace to open.')).toBeVisible();
  await page.getByLabel(/Sunrise Clinic/).check();
  await page.getByRole('button', { name: 'Open workspace' }).click();
  await expect(page.getByText('Clinic · Sunrise Clinic')).toBeVisible();
  expect(backend.calls.find((c) => c.path === '/auth/partner/select')?.body).toEqual({ ticket: 'ticket-1', partnerId: CLINIC, session: 'cookie' });
});

test('in the phone app the choice is completed as a native session; only its refresh token is stored', async ({ page }) => {
  await page.addInitScript(`window.JansetuNative = { secureStore: {
    get: async (k) => sessionStorage.getItem('__kc__' + k), set: async (k, v) => { sessionStorage.setItem('__kc__' + k, v); },
    remove: async (k) => { sessionStorage.removeItem('__kc__' + k); } } };`);
  const backend = await mockBackend(page, ownerMe, { multi: true });
  await signInPartner(page);
  await expect(page.getByRole('radio')).toHaveCount(2);
  expect(backend.calls.find((c) => c.path === '/auth/partner/verify')?.body).toMatchObject({ session: 'native', app: 'workspace' });
  expect(await page.evaluate(() => sessionStorage.getItem('__kc__jansetu.refresh.workspace'))).toBeNull();
  await page.getByLabel(/City Lab/).check();
  await page.getByRole('button', { name: 'Open workspace' }).click();
  await expect(page.getByText('Lab · City Lab')).toBeVisible();
  expect(backend.calls.find((c) => c.path === '/auth/partner/select')?.body).toEqual({ ticket: 'ticket-1', partnerId: LAB, session: 'native', app: 'workspace' });
  expect(await page.evaluate(() => sessionStorage.getItem('__kc__jansetu.refresh.workspace'))).toBe('rt-p');
});

test('an expired choice asks for a new code', async ({ page }) => {
  await mockBackend(page, ownerMe, { multi: true, expired: true });
  await signInPartner(page);
  await page.getByLabel(/City Lab/).check();
  await page.getByRole('button', { name: 'Open workspace' }).click();
  await expect(page.getByText('This sign-in has expired. Request a new code to continue.')).toBeVisible();
  await expect(page.getByLabel('6-digit code')).toHaveValue('');
  await expect(page.getByRole('button', { name: /Resend code/ })).toBeVisible();
});

test('navigation follows the member’s permissions; a page without them does not exist', async ({ page }) => {
  await mockBackend(page, sitaMe);
  await signInPartner(page);
  await expect(nav(page).getByRole('link', { name: 'Profile' })).toBeVisible();
  await expect(nav(page).getByRole('link', { name: 'Staff' })).toHaveCount(0);
  await expect(nav(page).getByRole('link', { name: 'Branches' })).toHaveCount(0);
  await expect(nav(page).getByRole('link', { name: 'Activity log' })).toHaveCount(0);
  await page.goto('/#/partner/staff');
  await expect(page.getByText('Page not found')).toBeVisible();
});

test('branch-limited staff with staff.manage: no activity log; can grant only what they hold, within their branches', async ({ page }) => {
  await mockBackend(page, { _id: STAFF, partnerId: LAB, name: 'Sita Staff', role: 'staff', permissions: ['staff.manage', 'bookings.view'], branchIds: [BR1] });
  await signInPartner(page);
  await expect(nav(page).getByRole('link', { name: 'Activity log' })).toHaveCount(0);
  await nav(page).getByRole('link', { name: 'Staff' }).click();
  await page.getByRole('button', { name: 'Add a staff member' }).click();
  await expect(page.getByLabel('Owner', { exact: true })).toHaveCount(0);
  const perms = page.getByRole('group', { name: 'Permissions' });
  await expect(perms.getByRole('checkbox')).toHaveCount(2);
  await expect(page.getByLabel('All branches, including new ones')).toHaveCount(0);
  await page.getByLabel('Name', { exact: true }).fill('Kiran');
  await page.getByLabel('Mobile number').fill('9000000003');
  await page.getByRole('button', { name: 'Add staff member' }).click();
  await expect(page.getByText('Choose at least one branch, or all branches.')).toBeVisible();
});

test('owner: add (server refusal shown), edit permissions and remove staff with a confirm step', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.conflictOnce = true;
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Staff' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Ravi Owner' })).toContainText('You cannot remove yourself.');
  await expect(page.getByRole('row').filter({ hasText: 'Sita Staff' })).toContainText('Indiranagar');

  await page.getByRole('button', { name: 'Add a staff member' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Kiran');
  await page.getByLabel('Mobile number').fill('12345');
  await page.getByRole('button', { name: 'Add staff member' }).click();
  await expect(page.getByText('Enter the 10-digit mobile number.')).toBeVisible();
  await page.getByLabel('Mobile number').fill('9000000003');
  await page.getByLabel('View bookings').check();
  await page.getByLabel('Upload reports').check();
  await page.getByRole('button', { name: 'Add staff member' }).click();
  await expect(page.getByText('An active member with this phone already exists for this partner')).toBeVisible();
  await page.getByRole('button', { name: 'Add staff member' }).click();
  await expect(page.getByText('Kiran was added.')).toBeVisible();
  const adds = backend.calls.filter((c) => c.method === 'POST' && c.path === '/partner-workspace/members');
  expect(adds.at(-1)?.body).toEqual({ name: 'Kiran', phone: '9000000003', role: 'staff', permissions: ['bookings.view', 'reports.upload'], branchIds: [] });

  const sita = page.getByRole('row').filter({ hasText: 'Sita Staff' });
  await sita.getByRole('button', { name: 'Edit permissions' }).click();
  const editor = page.getByRole('region', { name: 'Permissions for Sita Staff' });
  await editor.getByLabel('Manage bookings').check();
  await editor.getByRole('button', { name: 'Save permissions' }).click();
  await expect(page.getByText('Permissions for Sita Staff were saved.')).toBeVisible();
  expect(backend.calls.find((c) => c.method === 'PUT')).toEqual({ method: 'PUT', path: `/partner-workspace/members/${STAFF}/permissions`, body: { permissions: ['bookings.view', 'bookings.manage'], expectedUpdatedAt: V0 } });

  await sita.getByRole('button', { name: 'Remove' }).click();
  await expect(sita.getByText('Sita Staff loses access to this workspace at once.', { exact: false })).toBeVisible();
  expect(backend.calls.some((c) => c.method === 'DELETE')).toBe(false);
  await sita.getByRole('button', { name: 'Remove Sita Staff' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Sita Staff' })).toHaveCount(0);
  expect(backend.calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([`/partner-workspace/members/${STAFF}`]);
});

test('branches: add with hours and holidays; deactivate only after confirming', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Branches' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Indiranagar' })).toContainText('Home sample collection');
  await page.getByRole('button', { name: 'Add a branch' }).click();
  await page.getByRole('button', { name: 'Add branch' }).click();
  await expect(page.getByText('Enter the branch name.')).toBeVisible();
  await page.getByLabel('Branch name').fill('Koramangala');
  await page.getByLabel('Phone', { exact: true }).fill('9000000020');
  await page.getByLabel('Address line 1').fill('5 Ring Rd');
  await page.getByLabel('City').fill('Bengaluru');
  await page.getByLabel('State', { exact: true }).fill('Karnataka');
  await page.getByLabel('State code').fill('29');
  await page.getByLabel('PIN code').fill('560034');
  await page.getByLabel('Walk-in at the lab').check();
  await page.getByLabel('Saturday', { exact: true }).uncheck();
  await page.getByLabel('Holiday date').fill('2026-12-25');
  await page.getByRole('button', { name: 'Add holiday' }).click();
  await page.getByRole('button', { name: 'Add branch' }).click();
  await expect(page.getByText('Koramangala was added.')).toBeVisible();
  const day = { open: '09:00', close: '18:00' };
  expect(backend.calls.find((c) => c.method === 'POST' && c.path === '/partner-workspace/branches')?.body).toEqual({
    name: 'Koramangala', phone: '9000000020',
    address: { line1: '5 Ring Rd', city: 'Bengaluru', state: 'Karnataka', stateCode: '29', pincode: '560034' },
    hours: { mon: day, tue: day, wed: day, thu: day, fri: day }, holidays: ['2026-12-25'],
    services: { homeCollection: false, inLab: true, inClinic: false },
    requestKey: expect.stringMatching(/^[A-Za-z0-9_-]{8,100}$/), // Q16b: exactly once per key
  });

  const row = page.getByRole('row').filter({ hasText: 'Indiranagar' });
  await row.getByRole('button', { name: 'Deactivate' }).click();
  await expect(row.getByText(/stops taking bookings/)).toBeVisible();
  await row.getByRole('button', { name: 'Back' }).click();
  expect(backend.calls.some((c) => c.method === 'DELETE')).toBe(false);
  await row.getByRole('button', { name: 'Deactivate' }).click();
  await row.getByRole('button', { name: 'Deactivate Indiranagar' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Indiranagar' })).toHaveCount(0);
  expect(backend.calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([`/partner-workspace/branches/${BR1}`]);
});

test('admin: partners list with filters, create, verify and suspend with confirmation', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await nav(page).getByRole('link', { name: 'Labs and clinics' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'City Lab' })).toContainText('Waiting for verification');
  await page.getByLabel('Type').selectOption('clinic');
  // The filtered request is awaited (an empty table can also be the list still loading).
  await expect.poll(() => backend.calls.some((c) => c.method === 'GET' && c.path.startsWith('/partner-workspace/admin?') && c.path.includes('kind=clinic'))).toBe(true);
  await expect(page.getByRole('row').filter({ hasText: 'Sunrise Clinic' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'City Lab' })).toHaveCount(0);
  await page.getByLabel('Type').selectOption('');

  const lab = page.getByRole('row').filter({ hasText: 'City Lab' });
  await lab.getByRole('button', { name: 'Verify' }).click();
  await lab.getByRole('button', { name: 'Verify City Lab' }).click();
  await expect(lab).toContainText('Verified');
  await expect(lab.getByRole('button', { name: 'Verify' })).toHaveCount(0);

  const clinic = page.getByRole('row').filter({ hasText: 'Sunrise Clinic' });
  await clinic.getByRole('button', { name: 'Suspend' }).click();
  await expect(clinic.getByText(/members are signed out/)).toBeVisible();
  await clinic.getByRole('button', { name: 'Suspend Sunrise Clinic' }).click();
  await expect(clinic).toContainText('Suspended');
  expect(backend.calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([
    '/auth/admin/send', '/auth/admin/verify', `/partner-workspace/admin/${LAB}/verify`, `/partner-workspace/admin/${CLINIC}/suspend`,
  ]);

  await page.getByRole('link', { name: 'Add a lab or clinic' }).click();
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText('Use 1 to 6 letters or digits.')).toBeVisible();
  await page.getByLabel('Display name').fill('Metro Diagnostics');
  await page.getByLabel('Contact phone').fill('9000000030');
  await page.getByLabel('Invoice prefix').fill('md1');
  await page.getByLabel('Owner name').fill('Meena');
  await page.getByLabel('Owner mobile number').fill('9000000031');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Metro Diagnostics' })).toBeVisible();
  expect(backend.calls.find((c) => c.method === 'POST' && c.path === '/partner-workspace/admin')?.body).toEqual({
    kind: 'lab', name: 'Metro Diagnostics', contactPhone: '9000000030', taxRegime: 'unregistered', invoiceSeriesPrefix: 'MD1',
    firstOwner: { name: 'Meena', phone: '9000000031' }, requestKey: expect.stringMatching(/^[A-Za-z0-9_-]{8,100}$/),
  });
});

test('admin manages a partner as owner through the admin workspace routes', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await page.goto(`/#/admin/partners/${LAB}`);
  await page.getByRole('link', { name: 'Staff' }).click();
  await expect(page.getByText('Managing City Lab with owner authority.')).toBeVisible();
  // An admin is never one of the members: even the only owner's row is not "you"; the last owner stays protected.
  await expect(page.getByRole('row').filter({ hasText: 'Ravi Owner' })).toContainText('The last owner cannot be removed.');
  const sita = page.getByRole('row').filter({ hasText: 'Sita Staff' });
  await sita.getByRole('button', { name: 'Remove' }).click();
  await sita.getByRole('button', { name: 'Remove Sita Staff' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Sita Staff' })).toHaveCount(0);
  const ws = backend.calls.filter((c) => c.path.includes('/workspace/')).map((c) => `${c.method} ${c.path}`);
  expect(ws).toContain(`GET /partner-workspace/admin/${LAB}/workspace/members`);
  expect(ws).toContain(`DELETE /partner-workspace/admin/${LAB}/workspace/members/${STAFF}`);
  expect(backend.calls.some((c) => /^\/partner-workspace\/members/.test(c.path))).toBe(false);
  await page.getByRole('link', { name: 'Back to City Lab' }).click();
  await expect(page.getByRole('heading', { name: 'City Lab' })).toBeVisible();
  await page.goto('/#/partner/staff');
  await expect(page.getByText('Page not found')).toBeVisible();
});

// ── Codex WQ1 review fixes and Q8 actions ──

test('switching partners as admin clears open drafts; a submission stays with the partner it was made for', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await page.goto(`/#/admin/partners/${LAB}/branches`);
  await page.getByRole('button', { name: 'Add a branch' }).click();
  await page.getByLabel('Branch name').fill('Typed for City Lab');
  await page.goto(`/#/admin/partners/${CLINIC}/branches`);
  await expect(page.getByText('Managing Sunrise Clinic with owner authority.')).toBeVisible();
  await expect(page.getByLabel('Branch name')).toHaveCount(0);

  await page.goto(`/#/admin/partners/${LAB}/staff`);
  await page.getByRole('button', { name: 'Add a staff member' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Typed for City Lab');
  await page.goto(`/#/admin/partners/${CLINIC}/staff`);
  await expect(page.getByText('Managing Sunrise Clinic with owner authority.')).toBeVisible();
  await expect(page.getByLabel('Name', { exact: true })).toHaveCount(0);

  // A submission still running when the admin switches belongs to the first partner and reports nothing on the second.
  await page.goto(`/#/admin/partners/${LAB}/staff`);
  await page.getByRole('button', { name: 'Add a staff member' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Kiran');
  await page.getByLabel('Mobile number').fill('9000000003');
  backend.slowAdd = 800;
  await page.getByRole('button', { name: 'Add staff member' }).click();
  await page.goto(`/#/admin/partners/${CLINIC}/staff`);
  await expect(page.getByText('Managing Sunrise Clinic with owner authority.')).toBeVisible();
  await expect.poll(() => backend.members.some((m) => m.name === 'Kiran')).toBe(true);
  await expect(page.getByText('Kiran was added.')).toHaveCount(0);
  expect(backend.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/members')).map((c) => c.path))
    .toEqual([`/partner-workspace/admin/${LAB}/workspace/members`]);

  // Starting fresh on the second partner submits there.
  backend.slowAdd = 0;
  await page.getByRole('button', { name: 'Add a staff member' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Asha');
  await page.getByLabel('Mobile number').fill('9000000004');
  await page.getByRole('button', { name: 'Add staff member' }).click();
  await expect(page.getByText('Asha was added.')).toBeVisible();
  expect(backend.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/members')).map((c) => c.path)).toEqual([
    `/partner-workspace/admin/${LAB}/workspace/members`, `/partner-workspace/admin/${CLINIC}/workspace/members`,
  ]);
});

test('a permission revoked by someone else while editing is detected: nothing is sent, the saved value is shown', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Staff' }).click();
  await page.getByRole('row').filter({ hasText: 'Sita Staff' }).getByRole('button', { name: 'Edit permissions' }).click();
  const editor = page.getByRole('region', { name: 'Permissions for Sita Staff' });
  await editor.getByLabel('Manage bookings').check();
  // Meanwhile another owner revokes "View bookings".
  (backend.members.find((m) => m._id === STAFF)!).permissions = [];
  await editor.getByRole('button', { name: 'Save permissions' }).click();
  await expect(editor.getByText(/Someone else changed the permissions while you were editing/)).toBeVisible();
  await expect(editor.getByLabel('View bookings')).not.toBeChecked();
  await expect(editor.getByLabel('Manage bookings')).not.toBeChecked();
  expect(backend.calls.some((c) => c.method === 'PUT')).toBe(false);
  await editor.getByLabel('Manage bookings').check();
  await editor.getByRole('button', { name: 'Save permissions' }).click();
  await expect(page.getByText('Permissions for Sita Staff were saved.')).toBeVisible();
  expect(backend.calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([{ permissions: ['bookings.manage'], expectedUpdatedAt: V0 }]);
});

test('editing a branch name never resends services or holidays someone else changed meanwhile', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Branches' }).click();
  await page.getByRole('row').filter({ hasText: 'Indiranagar' }).getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Branch name').fill('Indiranagar Main');
  const br = backend.branches.find((x) => x._id === BR1)!;
  br.services = { homeCollection: false, inLab: true, inClinic: false };
  br.holidays = ['2026-12-31'];
  await page.getByRole('button', { name: 'Save branch' }).click();
  await expect(page.getByText('Indiranagar Main was saved.')).toBeVisible();
  expect(backend.calls.filter((c) => c.method === 'PUT').map((c) => ({ path: c.path, body: c.body })))
    .toEqual([{ path: `/partner-workspace/branches/${BR1}`, body: { name: 'Indiranagar Main', expectedUpdatedAt: V0 } }]);
  expect(br.holidays).toEqual(['2026-12-31']);
});

test('a lost create answer locks the form; sending again reuses the key and content and creates one partner', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.dropCreate = true;
  await signInAdmin(page);
  await page.goto('/#/admin/partners/new');
  await page.getByLabel('Display name').fill('Metro Diagnostics');
  await page.getByLabel('Contact phone').fill('9000000030');
  await page.getByLabel('Invoice prefix').fill('MD');
  await page.getByLabel('Owner name').fill('Meena');
  await page.getByLabel('Owner mobile number').fill('9000000031');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText(/We could not confirm whether Metro Diagnostics was created/)).toBeVisible();
  await expect(page.getByLabel('Display name')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Create', exact: true })).toHaveCount(0);
  // Leaving and coming back keeps it unresolved (session memory), still locked.
  await page.goto('/#/admin/partners');
  await page.goto('/#/admin/partners/new');
  await expect(page.getByLabel('Display name')).toHaveValue('Metro Diagnostics');
  await page.getByRole('button', { name: 'Send again' }).click();
  await expect(page.getByRole('heading', { name: 'Metro Diagnostics' })).toBeVisible();
  const creates = backend.calls.filter((c) => c.method === 'POST' && c.path === '/partner-workspace/admin');
  expect(creates).toHaveLength(2);
  expect(creates[1]!.body).toEqual(creates[0]!.body);
  expect((creates[0]!.body as Rec).requestKey).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
  expect(backend.partners.filter((p) => p.name === 'Metro Diagnostics')).toHaveLength(1);
  // A new form after that starts with a new key.
  await page.goto('/#/admin/partners/new');
  await expect(page.getByLabel('Display name')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeVisible();
});

test('Q8: change a staff member’s branch access; reopen a closed branch', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Staff' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Ravi Owner' }).getByRole('button', { name: 'Change branch access' })).toHaveCount(0);
  await page.getByRole('row').filter({ hasText: 'Sita Staff' }).getByRole('button', { name: 'Change branch access' }).click();
  const editor = page.getByRole('region', { name: 'Branch access for Sita Staff' });
  await expect(editor.getByLabel('Indiranagar')).toBeChecked();
  await editor.getByLabel('All branches, including new ones').check();
  await editor.getByRole('button', { name: 'Save branch access' }).click();
  await expect(page.getByText('Branch access for Sita Staff was saved.')).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Sita Staff' })).toContainText('All branches');
  expect(backend.calls.find((c) => c.method === 'PUT')).toEqual({ method: 'PUT', path: `/partner-workspace/members/${STAFF}/branches`, body: { branchIds: [], expectedUpdatedAt: V0 } });

  await nav(page).getByRole('link', { name: 'Branches' }).click();
  const closed = page.getByRole('region', { name: 'Closed branches' });
  await closed.getByRole('button', { name: 'Reopen' }).click();
  await closed.getByRole('button', { name: 'Reopen Old Town' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Old Town' })).toBeVisible();
  expect(backend.calls.some((c) => c.method === 'POST' && c.path === `/partner-workspace/branches/${BR_OLD}/reactivate`)).toBe(true);
  expect(backend.calls.some((c) => c.path === '/partner-workspace/branches?includeInactive=true')).toBe(true);
});

test('Q8: only owners edit the profile; staff read it', async ({ page }) => {
  const backend = await mockBackend(page, sitaMe);
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Profile' }).click();
  await expect(page.getByText('Only an owner can change these details.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);
  expect(backend.calls.some((c) => c.path.includes('includeInactive'))).toBe(false);
});

test('Q8: admin searches and pages partners, and reinstates a suspended one', async ({ page }) => {
  const backend = await mockBackend(page, ownerMe, { many: true });
  await signInAdmin(page);
  await nav(page).getByRole('link', { name: 'Labs and clinics' }).click();
  await expect(page.getByText('23 partners')).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('Page 2 of 2')).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Zeta Lab 21' })).toBeVisible();
  expect(backend.calls.some((c) => c.path.includes('page=2') && c.path.includes('limit=20'))).toBe(true);
  await page.getByLabel('Search by name').fill('sunrise');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByText('1 partner', { exact: true })).toBeVisible();
  expect(backend.calls.some((c) => c.path.includes('q=sunrise') && !c.path.includes('page='))).toBe(true);

  const clinic = page.getByRole('row').filter({ hasText: 'Sunrise Clinic' });
  await clinic.getByRole('button', { name: 'Suspend' }).click();
  await clinic.getByRole('button', { name: 'Suspend Sunrise Clinic' }).click();
  await expect(clinic).toContainText('Suspended');
  await clinic.getByRole('button', { name: 'Reinstate' }).click();
  await clinic.getByRole('button', { name: 'Reinstate Sunrise Clinic' }).click();
  await expect(clinic).toContainText('Verified');
  expect(backend.calls.some((c) => c.method === 'POST' && c.path === `/partner-workspace/admin/${CLINIC}/reinstate`)).toBe(true);
});

// ── Codex re-review of 5236388 and Q10 ──

async function fillNewPartner(page: Page, name = 'Metro Diagnostics') {
  await page.goto('/#/admin/partners/new');
  await page.getByLabel('Display name').fill(name);
  await page.getByLabel('Contact phone').fill('9000000030');
  await page.getByLabel('Invoice prefix').fill('MD');
  await page.getByLabel('Owner name').fill('Meena');
  await page.getByLabel('Owner mobile number').fill('9000000031');
}
const createCalls = (b: Backend) => b.calls.filter((c) => c.method === 'POST' && c.path === '/partner-workspace/admin');

test('after a reload, a create that did go through is found by its key and opened', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.dropCreate = true; // commits, answer lost
  await signInAdmin(page);
  await fillNewPartner(page);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText(/We could not confirm whether Metro Diagnostics was created/)).toBeVisible();
  const key = (createCalls(backend)[0]!.body as Rec).requestKey as string;
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Metro Diagnostics was created' })).toBeVisible();
  expect(backend.calls.some((c) => c.method === 'GET' && c.path === `/partner-workspace/admin/by-key/${key}`)).toBe(true);
  await page.getByRole('link', { name: 'Open Metro Diagnostics' }).click();
  await expect(page.getByRole('heading', { name: 'Metro Diagnostics' })).toBeVisible();
  expect(backend.partners.filter((p) => p.name === 'Metro Diagnostics')).toHaveLength(1);
  expect(backend.calls.some((c) => c.path.endsWith('/abandon'))).toBe(false);
});

test('after a reload, a create not found is only cleared by giving it up on the server; then a new create is allowed', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.loseCreate = true; // lost before it commits
  await signInAdmin(page);
  await fillNewPartner(page);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText(/We could not confirm whether Metro Diagnostics was created/)).toBeVisible();
  const key = (createCalls(backend)[0]!.body as Rec).requestKey as string;
  await page.reload();
  await expect(page.getByText(/Nothing has been created with it so far, but the request could still arrive/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create', exact: true })).toHaveCount(0);
  // Looking at the list settles nothing: coming back still shows the unresolved create.
  await page.goto('/#/admin/partners');
  await page.goto('/#/admin/partners/new');
  await expect(page.getByRole('button', { name: 'Give up this create' })).toBeVisible();
  await page.getByRole('button', { name: 'Give up this create' }).click();
  await expect(page.getByText(/Given up: nothing was created/)).toBeVisible();
  expect(backend.calls.filter((c) => c.path.endsWith('/abandon')).map((c) => c.path)).toEqual([`/partner-workspace/admin/by-key/${key}/abandon`]);
  await page.getByLabel('Display name').fill('Metro Diagnostics');
  await page.getByLabel('Contact phone').fill('9000000030');
  await page.getByLabel('Invoice prefix').fill('MD');
  await page.getByLabel('Owner name').fill('Meena');
  await page.getByLabel('Owner mobile number').fill('9000000031');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Metro Diagnostics' })).toBeVisible();
  const keys = createCalls(backend).map((c) => (c.body as Rec).requestKey);
  expect(keys).toHaveLength(2);
  expect(keys[1]).not.toBe(key);
  expect(backend.partners.filter((p) => p.name === 'Metro Diagnostics')).toHaveLength(1);
});

test('after a reload, a create that lands after the lookup is reported as used by the give-up and opened, never made twice', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.loseCreate = true;
  await signInAdmin(page);
  await fillNewPartner(page);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText(/We could not confirm/)).toBeVisible();
  const key = (createCalls(backend)[0]!.body as Rec).requestKey as string;
  await page.reload();
  await expect(page.getByRole('button', { name: 'Give up this create' })).toBeVisible();
  // The original request arrives at the server now, after the lookup said "not found".
  const late = { ...partner('a4'.repeat(12), 'Metro Diagnostics', 'lab', 'pending') };
  backend.partners.push(late);
  backend.creates.set(key, { hash: 'h', partner: late });
  await page.getByRole('button', { name: 'Give up this create' }).click();
  await expect(page.getByRole('heading', { name: 'Metro Diagnostics' })).toBeVisible();
  expect(page.url()).toContain(`/admin/partners/${'a4'.repeat(12)}`);
  expect(createCalls(backend)).toHaveLength(1);
});

test('a create answer arriving after the admin left the page does not move them', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.slowCreate = 800;
  await signInAdmin(page);
  await fillNewPartner(page);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.goto('/#/admin/partners');
  await expect(page.getByRole('heading', { name: 'Labs and clinics' })).toBeVisible();
  await expect.poll(() => backend.partners.some((p) => p.name === 'Metro Diagnostics')).toBe(true);
  await page.waitForTimeout(400);
  expect(new URL(page.url()).hash).toBe('#/admin/partners');
  await expect(page.getByRole('heading', { name: 'Labs and clinics' })).toBeVisible();
  // The answer was a success, so it is settled: a new form starts empty.
  await page.goto('/#/admin/partners/new');
  await expect(page.getByLabel('Display name')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeVisible();
});

test('the branch picker is frozen while saving; the validated choice is what is sent', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Staff' }).click();
  await page.getByRole('row').filter({ hasText: 'Sita Staff' }).getByRole('button', { name: 'Change branch access' }).click();
  const editor = page.getByRole('region', { name: 'Branch access for Sita Staff' });
  await editor.getByLabel('All branches, including new ones').check();
  await editor.getByLabel('All branches, including new ones').uncheck();
  await editor.getByLabel('Indiranagar').uncheck();
  await editor.getByLabel('Indiranagar').check();
  await editor.getByLabel('All branches, including new ones').check();
  backend.slowMemberRead = 800;
  await editor.getByRole('button', { name: 'Save branch access' }).click();
  await expect(editor.getByLabel('All branches, including new ones')).toBeDisabled();
  await expect(page.getByText('Branch access for Sita Staff was saved.')).toBeVisible();
  expect(backend.calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([{ branchIds: [], expectedUpdatedAt: V0 }]);
});

test('Q10: a save refused as RECORD_CHANGED shows what is saved and sends nothing more until saved again', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Branches' }).click();
  await page.getByRole('row').filter({ hasText: 'Indiranagar' }).getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Branch name').fill('Indiranagar Main');
  backend.raceOnce = (rec) => { rec.phone = '9000000099'; }; // someone changes the phone between the re-read and the save
  await page.getByRole('button', { name: 'Save branch' }).click();
  await expect(page.getByText(/Someone else changed this while you were saving, so nothing was saved/)).toBeVisible();
  await expect(page.getByLabel('Phone', { exact: true })).toHaveValue('9000000099');
  await expect(page.getByLabel('Branch name')).toHaveValue('Indiranagar Main');
  await page.getByRole('button', { name: 'Save branch' }).click();
  await expect(page.getByText('Indiranagar Main was saved.')).toBeVisible();
  const puts = backend.calls.filter((c) => c.method === 'PUT').map((c) => c.body as Rec);
  expect(puts).toHaveLength(2);
  expect(puts[0]).toEqual({ name: 'Indiranagar Main', expectedUpdatedAt: V0 });
  expect(puts[1]!.name).toBe('Indiranagar Main');
  expect(puts[1]!.expectedUpdatedAt).not.toBe(V0);
  expect(puts[1]!.phone).toBeUndefined();

  // Permissions: the other change touched the same field: the form shows it for review.
  await nav(page).getByRole('link', { name: 'Staff' }).click();
  await page.getByRole('row').filter({ hasText: 'Sita Staff' }).getByRole('button', { name: 'Edit permissions' }).click();
  const editor = page.getByRole('region', { name: 'Permissions for Sita Staff' });
  await editor.getByLabel('Manage bookings').check();
  backend.raceOnce = (rec) => { rec.permissions = []; };
  await editor.getByRole('button', { name: 'Save permissions' }).click();
  await expect(editor.getByText(/Someone else changed the permissions while you were editing/)).toBeVisible();
  await expect(editor.getByLabel('View bookings')).not.toBeChecked();
  await expect(editor.getByLabel('Manage bookings')).not.toBeChecked();
  expect((backend.members.find((m) => m._id === STAFF)!).permissions).toEqual([]);
});

test('an obsolete give-up answer from a page that was left never settles a newer retry of the same key', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.loseCreate = true;
  await signInAdmin(page);
  await fillNewPartner(page);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText(/We could not confirm whether Metro Diagnostics was created/)).toBeVisible();

  // Page A starts giving up K1; its answer is held.
  let releaseAbandon!: () => void;
  backend.holdAbandon = new Promise<void>((r) => { releaseAbandon = r; });
  await page.getByRole('button', { name: 'Give up this create' }).click();
  await expect.poll(() => backend.calls.filter((c) => c.path.endsWith('/abandon')).length).toBe(1);

  // A is left; returned page B resends K1 (attempt 2): it commits, its answer is held.
  await page.goto('/#/admin/partners');
  await page.goto('/#/admin/partners/new');
  let releaseCreate!: () => void;
  backend.holdCreate = new Promise<void>((r) => { releaseCreate = r; });
  await page.getByRole('button', { name: 'Send again' }).click();
  await expect.poll(() => backend.partners.filter((p) => p.name === 'Metro Diagnostics').length).toBe(1);

  // A's delayed answer arrives first: 'used'. It must change nothing for B.
  releaseAbandon();
  await expect.poll(() => backend.abandonAnswers).toEqual(['used']);
  await page.waitForTimeout(300);
  await expect(page.getByRole('button', { name: 'Send again' })).toBeVisible(); // B still waiting on its own attempt
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.endsWith(':admin-partner-create')).length)).toBe(1);

  // B's own success then settles it and opens the partner.
  releaseCreate();
  await expect(page.getByRole('heading', { name: 'Metro Diagnostics' })).toBeVisible();
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.endsWith(':admin-partner-create')).length)).toBe(0);
  const creates = createCalls(backend);
  expect(creates).toHaveLength(2);
  expect(creates[1]!.body).toEqual(creates[0]!.body);
  expect(backend.partners.filter((p) => p.name === 'Metro Diagnostics')).toHaveLength(1);
});

/** WQ9: nothing that identifies the person is left in browser storage or the address bar. */
async function expectNothingStored(page: Page, ...secrets: string[]) {
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  for (const s of secrets) {
    expect(stored).not.toContain(s);
    expect(page.url()).not.toContain(s);
  }
}

test('WQ9: a lab member signs in by email and chooses among several workspaces; the email goes only to send and verify', async ({ page }) => {
  const backend = await mockBackend(page, ownerMe, { multi: true });
  await page.goto('/');
  await page.getByLabel('Lab or clinic staff').check();
  await page.getByLabel('Mobile number or email').fill('ravi@citylab');
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByText('Enter a 10-digit mobile number or an email address.')).toBeVisible();
  expect(backend.calls.some((c) => c.path === '/auth/partner/send')).toBe(false);
  await page.getByLabel('Mobile number or email').fill('  Ravi.Owner@CityLab.IN ');
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByText('We sent a 6-digit code to your email r•••@citylab.in.')).toBeVisible();
  await expect(page.getByText('ravi.owner@citylab.in')).toHaveCount(0);
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByText('Your email belongs to several workspaces. Which one do you want to open?')).toBeVisible();
  await page.getByLabel(/Sunrise Clinic/).check();
  await page.getByRole('button', { name: 'Open workspace' }).click();
  await expect(page.getByText('Clinic · Sunrise Clinic')).toBeVisible();
  const auth = backend.calls.filter((c) => c.path.startsWith('/auth/partner/'));
  expect(auth.map((c) => [c.path, c.body])).toEqual([
    ['/auth/partner/send', { email: 'ravi.owner@citylab.in' }],
    ['/auth/partner/verify', { email: 'ravi.owner@citylab.in', otp: '123456', session: 'cookie' }],
    ['/auth/partner/select', { ticket: 'ticket-1', partnerId: CLINIC, session: 'cookie' }],
  ]);
  await expectNothingStored(page, 'ravi.owner@citylab.in', '123456', 'ticket-1');
});

test('WQ9: a +91 number with spaces is sent as 10 digits; a refused email send waits on that email only; resend reuses the destination', async ({ page }) => {
  const backend = await mockBackend(page);
  // Registered after the mock, so it is asked first; anything else falls through to the mock.
  await page.route('**/api/v1/auth/partner/send', async (route) => {
    if ((route.request().postDataJSON() as Rec).email === 'busy@lab.in') {
      return route.fulfill({ status: 429, contentType: 'application/json', headers: { 'Retry-After': '3000' },
        body: JSON.stringify({ error: 429, code: 'OTP_SEND_LIMIT', message: 'Too many codes requested. Please try again in 50 minutes.', retryAfter: 3000 }) });
    }
    return route.fallback();
  });
  await page.clock.install();
  await page.goto('/');
  await page.getByLabel('Lab or clinic staff').check();
  await page.getByLabel('Mobile number or email').fill('busy@lab.in');
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByRole('alert')).toHaveText('Too many codes requested. Please try again in 50 minutes.');
  await expect(page.getByRole('button', { name: /Send code in \d+s/ })).toBeDisabled();
  await page.getByLabel('Mobile number or email').fill('+91 90000 00001');
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByText('We sent a 6-digit code to your phone ••••••0001.')).toBeVisible();
  for (let i = 0; i < 31; i++) await page.clock.runFor(1000);
  await page.getByRole('button', { name: 'Resend code' }).click();
  await expect(page.getByRole('button', { name: /Resend code in \d+s/ })).toBeDisabled();
  expect(backend.calls.filter((c) => c.path === '/auth/partner/send').map((c) => c.body)).toEqual([{ phone: '9000000001' }, { phone: '9000000001' }]);
  await page.getByRole('button', { name: 'Change number or email' }).click();
  await expect(page.getByLabel('Mobile number or email')).toHaveValue('+91 90000 00001');
});

test('WQ9: owner adds staff with an email (EMAIL_IN_USE on the field), sees it listed, and changes or removes it with the version fence', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Staff' }).click();
  await expect(page.getByRole('columnheader', { name: 'Email' })).toBeVisible();
  await page.getByRole('button', { name: 'Add a staff member' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Kiran');
  await page.getByLabel('Mobile number').fill('9000000003');
  await page.getByLabel('Email (optional)').fill('kiran@lab');
  await page.getByLabel('View bookings').check();
  await page.getByRole('button', { name: 'Add staff member' }).click();
  await expect(page.getByText('Enter a valid email address, or leave it empty.')).toBeVisible();
  await page.getByLabel('Email (optional)').fill(TAKEN);
  await page.getByRole('button', { name: 'Add staff member' }).click();
  await expect(page.getByText('Another member of this workspace already signs in with this email. Use a different email.')).toBeVisible();
  await page.getByLabel('Email (optional)').fill(' Kiran@Lab.IN ');
  await page.getByRole('button', { name: 'Add staff member' }).click();
  await expect(page.getByText('Kiran was added.')).toBeVisible();
  const adds = backend.calls.filter((c) => c.method === 'POST' && c.path === '/partner-workspace/members');
  expect(adds.map((c) => (c.body as Rec).email)).toEqual([TAKEN, 'kiran@lab.in']);
  await expect(page.getByRole('row').filter({ hasText: 'Kiran' })).toContainText('kiran@lab.in');

  const sita = page.getByRole('row').filter({ hasText: 'Sita Staff' });
  await expect(sita).toContainText('None');
  await sita.getByRole('button', { name: 'Add email' }).click();
  const editor = page.getByRole('region', { name: 'Email for Sita Staff' });
  // A first email signs nobody out: no warning yet.
  await expect(editor.getByText(/signs them out/)).toHaveCount(0);
  await editor.getByLabel('Email').fill(TAKEN);
  await editor.getByRole('button', { name: 'Save email' }).click();
  await expect(editor.getByText('Another member of this workspace already signs in with this email. Use a different email.')).toBeVisible();
  await editor.getByLabel('Email').fill('Sita@Lab.in');
  await editor.getByRole('button', { name: 'Save email' }).click();
  await expect(page.getByText('The email for Sita Staff was saved.')).toBeVisible();
  await expect(sita).toContainText('sita@lab.in');

  await sita.getByRole('button', { name: 'Change email' }).click();
  await expect(page.getByRole('region', { name: 'Email for Sita Staff' }).getByText(/Changing or removing it signs them out/)).toBeVisible();
  await page.getByRole('region', { name: 'Email for Sita Staff' }).getByLabel('Email').fill('');
  await page.getByRole('region', { name: 'Email for Sita Staff' }).getByRole('button', { name: 'Save email' }).click();
  await expect(page.getByText('The email for Sita Staff was saved.')).toBeVisible();
  await expect(sita).toContainText('None');
  const puts = backend.calls.filter((c) => c.method === 'PUT').map((c) => [c.path, c.body as Rec] as const);
  expect(puts.map(([p]) => p)).toEqual(Array(3).fill(`/partner-workspace/members/${STAFF}/email`));
  expect(puts.map(([, b]) => b.email)).toEqual([TAKEN, 'sita@lab.in', null]);
  expect(puts[0]![1].expectedUpdatedAt).toBe(V0);
  expect(puts[1]![1].expectedUpdatedAt).toBe(V0);
  expect(puts[2]![1].expectedUpdatedAt).not.toBe(V0); // fenced on the version the first save made
});

test('WQ9: an email edit refused as RECORD_CHANGED shows what is saved and is not sent again unchanged', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Staff' }).click();
  await page.getByRole('row').filter({ hasText: 'Sita Staff' }).getByRole('button', { name: 'Add email' }).click();
  const editor = page.getByRole('region', { name: 'Email for Sita Staff' });
  await editor.getByLabel('Email').fill('sita@lab.in');
  backend.raceOnce = (rec) => { rec.email = 'sita.other@lab.in'; };
  await editor.getByRole('button', { name: 'Save email' }).click();
  await expect(editor.getByText(/Someone else changed the email while you were editing/)).toBeVisible();
  await expect(editor.getByLabel('Email')).toHaveValue('sita.other@lab.in');
  expect(backend.members.find((m) => m._id === STAFF)!.email).toBe('sita.other@lab.in');
  await editor.getByRole('button', { name: 'Save email' }).click();
  await expect(editor.getByText('Nothing has changed.')).toBeVisible();
  expect(backend.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
});

test('WQ9: staff with staff.manage add members without an email and change nobody’s email (owners only)', async ({ page }) => {
  const backend = await mockBackend(page, { _id: STAFF, partnerId: LAB, name: 'Sita Staff', role: 'staff', permissions: ['staff.manage', 'bookings.view'], branchIds: [] });
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Staff' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Sita Staff' })).toBeVisible();
  await expect(page.getByRole('button', { name: /email/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Add a staff member' }).click();
  await expect(page.getByLabel('Email (optional)')).toHaveCount(0);
  await expect(page.getByText('They sign in with this mobile number (a code by SMS).')).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Kiran');
  await page.getByLabel('Mobile number').fill('9000000003');
  await page.getByLabel('View bookings').check();
  await page.getByRole('button', { name: 'Add staff member' }).click();
  await expect(page.getByText('Kiran was added.')).toBeVisible();
  expect(backend.calls.find((c) => c.method === 'POST' && c.path === '/partner-workspace/members')?.body).not.toHaveProperty('email');
});

test('WQ9: an add with an email refused as OWNER_REQUIRED says so on the field; without the email it is added', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.ownerLost = true;
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Staff' }).click();
  await page.getByRole('button', { name: 'Add a staff member' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Kiran');
  await page.getByLabel('Mobile number').fill('9000000003');
  await page.getByLabel('Email (optional)').fill('kiran@lab.in');
  await page.getByLabel('View bookings').check();
  await page.getByRole('button', { name: 'Add staff member' }).click();
  await expect(page.getByText('Only an owner can give a member a sign-in email. Leave it empty to add them without one.')).toBeVisible();
  await expect(page.getByLabel('Email (optional)')).toHaveAttribute('aria-invalid', 'true');
  await page.getByLabel('Email (optional)').fill('');
  await page.getByRole('button', { name: 'Add staff member' }).click();
  await expect(page.getByText('Kiran was added.')).toBeVisible();
  expect(backend.calls.filter((c) => c.method === 'POST' && c.path === '/partner-workspace/members').map((c) => (c.body as Rec).email)).toEqual(['kiran@lab.in', undefined]);
});

test('WQ9: an email save landing after its editor was replaced still shows in the list, and leaves the new editor alone', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Staff' }).click();
  const sita = page.getByRole('row').filter({ hasText: 'Sita Staff' });
  await sita.getByRole('button', { name: 'Add email' }).click();
  await page.getByRole('region', { name: 'Email for Sita Staff' }).getByLabel('Email').fill('sita@lab.in');
  backend.slowEmail = 800;
  await page.getByRole('region', { name: 'Email for Sita Staff' }).getByRole('button', { name: 'Save email' }).click();
  await expect.poll(() => backend.calls.some((c) => c.method === 'PUT')).toBe(true);
  // Q16b: an owner's own sign-in email is the Jansetu team's; another editor is opened instead.
  await page.getByRole('row').filter({ hasText: 'Ravi Owner' }).getByRole('button', { name: 'Add registration' }).click();
  const ravi = page.getByRole('region', { name: 'Professional registration of Ravi Owner' });
  await expect(ravi).toBeVisible();
  await expect(sita).toContainText('sita@lab.in');
  await expect(ravi).toBeVisible();
  await expect(page.getByText('The email for Sita Staff was saved.')).toHaveCount(0);
});

test('WQ9: the role choice is frozen while a code is being sent; verify uses the role the code was sent for', async ({ page }) => {
  const backend = await mockBackend(page);
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  await page.route('**/api/v1/auth/partner/send', async (route) => { await held; return route.fallback(); });
  await page.goto('/');
  await page.getByLabel('Lab or clinic staff').check();
  await page.getByLabel('Mobile number or email').fill('9000000001');
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByLabel('Admin')).toBeDisabled();
  await expect(page.getByLabel('Lab or clinic staff')).toBeChecked();
  release();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByText('Lab · City Lab')).toBeVisible();
  expect(backend.calls.filter((c) => c.path.startsWith('/auth/')).map((c) => c.path)).toEqual(['/auth/partner/send', '/auth/partner/verify', '/auth/profile']);
});

test('WQ9: a doctor email no account uses is refused on the field with the way on; each destination keeps its own wait', async ({ page }) => {
  const sends: unknown[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
    if (path === '/auth/specialist/send' || path === '/auth/pharmacy/send') {
      const body = route.request().postDataJSON() as Rec;
      sends.push(body);
      if (body.email === 'new.doctor@clinic.in') {
        return route.fulfill({ status: 404, contentType: 'application/json',
          body: JSON.stringify({ error: 404, code: 'EMAIL_NOT_REGISTERED', message: 'No account uses this email. Sign in with your mobile number, then add this email to your profile.' }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
    }
    return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 401, message: 'Please sign in again' }) });
  });
  await page.clock.install();
  await page.goto('/');
  await page.getByLabel('Doctor').check();
  await page.getByLabel('Mobile number or email').fill('New.Doctor@Clinic.in');
  await page.getByRole('button', { name: 'Send code' }).click();
  // Doctors and pharmacies have no profile email screen: the team adds it.
  const staffCopy = 'No account uses this email. Sign in with your mobile number. To use email sign-in, ask the Jansetu team to add it to your account.';
  await expect(page.getByText(staffCopy)).toBeVisible();
  await expect(page.getByText('then add this email to your profile')).toHaveCount(0);
  await expect(page.getByLabel('Mobile number or email')).toHaveAttribute('aria-invalid', 'true');
  await page.getByLabel('Pharmacy staff').check();
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByText(staffCopy)).toBeVisible();
  await page.getByLabel('Doctor').check();
  // A → B → A: the first destination's wait is kept while another is used.
  await page.getByLabel('Mobile number or email').fill('dr@clinic.in');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByRole('button', { name: 'Change number or email' }).click();
  await page.getByLabel('Mobile number or email').fill('09876543210');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByRole('button', { name: 'Change number or email' }).click();
  await page.getByLabel('Mobile number or email').fill('dr@clinic.in');
  await expect(page.getByRole('button', { name: /Send code in \d+s/ })).toBeDisabled();
  expect(sends).toEqual([{ email: 'new.doctor@clinic.in' }, { email: 'new.doctor@clinic.in' }, { email: 'dr@clinic.in' }, { phone: '9876543210' }]);
});

test('WQ9: admin creates a partner with an optional owner email; EMAIL_IN_USE unlocks the form with the field marked', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await fillNewPartner(page);
  await page.getByLabel('Owner email (optional)').fill('meena@');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText('Enter a valid email address, or leave it empty.')).toBeVisible();
  expect(createCalls(backend)).toHaveLength(0);
  await page.getByLabel('Owner email (optional)').fill(TAKEN);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText('Another member of this workspace already signs in with this email. Use a different email.')).toBeVisible();
  await expect(page.getByLabel('Owner email (optional)')).toBeEnabled();
  await page.getByLabel('Owner email (optional)').fill(' Meena@Metro.IN ');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Metro Diagnostics' })).toBeVisible();
  const creates = createCalls(backend).map((c) => c.body as Rec);
  expect(creates.map((b) => b.firstOwner)).toEqual([
    { name: 'Meena', phone: '9000000031', email: TAKEN },
    { name: 'Meena', phone: '9000000031', email: 'meena@metro.in' },
  ]);
  expect(creates[0]!.requestKey).not.toBe(creates[1]!.requestKey); // a refused create's key is not reused for new content
});

test('WQ9: an admin acting as owner edits a member’s email through the admin workspace route', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await page.goto(`/#/admin/partners/${LAB}`);
  await page.getByRole('link', { name: 'Staff' }).click();
  await page.getByRole('row').filter({ hasText: 'Ravi Owner' }).getByRole('button', { name: 'Add email' }).click();
  const editor = page.getByRole('region', { name: 'Email for Ravi Owner' });
  await editor.getByLabel('Email').fill('ravi@citylab.in');
  await editor.getByRole('button', { name: 'Save email' }).click();
  await expect(page.getByText('The email for Ravi Owner was saved.')).toBeVisible();
  expect(backend.calls.filter((c) => c.method === 'PUT').map((c) => [c.path, c.body])).toEqual([
    [`/partner-workspace/admin/${LAB}/workspace/members/${OWNER}/email`, { email: 'ravi@citylab.in', expectedUpdatedAt: V0 }],
  ]);
});

test('WQ10b: an owner adds, changes and removes a staff member’s registration with the version fence; the list shows it', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Staff' }).click();
  await expect(page.getByRole('columnheader', { name: 'Registration' })).toBeVisible();
  const sita = page.getByRole('row').filter({ hasText: 'Sita Staff' });
  await expect(sita).toContainText('Not added');
  await sita.getByRole('button', { name: 'Add registration' }).click();
  const editor = page.getByRole('region', { name: 'Professional registration of Sita Staff' });
  await editor.getByRole('button', { name: 'Save registration' }).click();
  await expect(editor.getByText('Choose what they are registered as.')).toBeVisible();
  await expect(editor.getByText('Enter the registration number (3 to 60 characters).')).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Remove registration' })).toHaveCount(0);
  await editor.getByLabel('Registered as').selectOption('pathologist');
  await editor.getByLabel('Registration number').fill('  KMC-55 ');
  await editor.getByRole('button', { name: 'Save registration' }).click();
  await expect(page.getByText('The registration of Sita Staff was saved.')).toBeVisible();
  await expect(sita).toContainText('Pathologist · KMC-55');

  await sita.getByRole('button', { name: 'Change registration' }).click();
  await expect(editor.getByLabel('Registration number')).toHaveValue('KMC-55');
  await editor.getByLabel('Registered as').selectOption('doctor');
  await editor.getByLabel('Registration number').fill('KMC-56');
  await editor.getByRole('button', { name: 'Save registration' }).click();
  await expect(sita).toContainText('Doctor · KMC-56');

  await sita.getByRole('button', { name: 'Change registration' }).click();
  await editor.getByRole('button', { name: 'Remove registration' }).click();
  await expect(editor.getByText('Sita Staff can no longer release reports until a registration is added again.', { exact: false })).toBeVisible();
  await editor.getByRole('button', { name: 'Remove the registration of Sita Staff' }).click();
  await expect(page.getByText('The registration of Sita Staff was removed.')).toBeVisible();
  await expect(sita).toContainText('Not added');

  const puts = backend.calls.filter((c) => c.method === 'PUT').map((c) => [c.path, c.body as Rec] as const);
  expect(puts.map(([p]) => p)).toEqual(Array(3).fill(`/partner-workspace/members/${STAFF}/professional`));
  expect(puts[0]![1]).toEqual({ professional: { kind: 'pathologist', registrationNumber: 'KMC-55' }, expectedUpdatedAt: V0 });
  expect(puts[1]![1].professional).toEqual({ kind: 'doctor', registrationNumber: 'KMC-56' });
  expect(puts[1]![1].expectedUpdatedAt).not.toBe(V0); // fenced on the version the first save made
  expect(puts[2]![1].professional).toBeNull();
  expect(puts[2]![1].expectedUpdatedAt).not.toBe(puts[1]![1].expectedUpdatedAt);
  // Each save read the member again right before sending.
  expect(backend.calls.filter((c) => c.method === 'GET' && c.path === `/partner-workspace/members/${STAFF}`).length).toBeGreaterThanOrEqual(3);
});

test('WQ10b: a registration edit refused as RECORD_CHANGED shows the saved one; a lost answer is settled by reading the member', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Staff' }).click();
  const sita = page.getByRole('row').filter({ hasText: 'Sita Staff' });
  await sita.getByRole('button', { name: 'Add registration' }).click();
  const editor = page.getByRole('region', { name: 'Professional registration of Sita Staff' });
  await editor.getByLabel('Registered as').selectOption('pathologist');
  await editor.getByLabel('Registration number').fill('KMC-55');
  backend.raceOnce = (rec) => { rec.professional = { kind: 'pathologist', registrationNumber: 'OTHER-1' }; };
  await editor.getByRole('button', { name: 'Save registration' }).click();
  await expect(editor.getByText(/Someone else changed the registration while you were editing/)).toBeVisible();
  await expect(editor.getByLabel('Registration number')).toHaveValue('OTHER-1');
  expect(backend.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);

  // Saved on the server, answer lost: the member read again shows it went through.
  backend.dropProfessional = true;
  await editor.getByLabel('Registration number').fill('KMC-77');
  await editor.getByRole('button', { name: 'Save registration' }).click();
  await expect(page.getByText('The registration of Sita Staff was saved.')).toBeVisible();
  await expect(sita).toContainText('Pathologist · KMC-77');
  expect(backend.calls.filter((c) => c.method === 'PUT')).toHaveLength(2);
});

test('WQ10b: staff with staff.manage see registrations; only an owner changes them', async ({ page }) => {
  const backend = await mockBackend(page, { _id: STAFF, partnerId: LAB, name: 'Sita Staff', role: 'staff', permissions: ['staff.manage', 'bookings.view'], branchIds: [] });
  backend.members[0]!.professional = { kind: 'pathologist', registrationNumber: 'KMC-11' };
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Staff' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Ravi Owner' })).toContainText('Pathologist · KMC-11');
  await expect(page.getByRole('button', { name: /registration/ })).toHaveCount(0);
  await expect(page.getByText('Only an owner adds or changes a professional registration', { exact: false })).toBeVisible();
});

test('WQ10b: an admin acting as owner adds a registration through the admin workspace route', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await page.goto(`/#/admin/partners/${LAB}`);
  await page.getByRole('link', { name: 'Staff' }).click();
  await page.getByRole('row').filter({ hasText: 'Ravi Owner' }).getByRole('button', { name: 'Add registration' }).click();
  const editor = page.getByRole('region', { name: 'Professional registration of Ravi Owner' });
  await editor.getByLabel('Registered as').selectOption('pathologist');
  await editor.getByLabel('Registration number').fill('KMC-11');
  await editor.getByRole('button', { name: 'Save registration' }).click();
  await expect(page.getByText('The registration of Ravi Owner was saved.')).toBeVisible();
  expect(backend.calls.filter((c) => c.method === 'PUT').map((c) => [c.path, c.body])).toEqual([
    [`/partner-workspace/admin/${LAB}/workspace/members/${OWNER}/professional`, { professional: { kind: 'pathologist', registrationNumber: 'KMC-11' }, expectedUpdatedAt: V0 }],
  ]);
});

// ── WQ11b: review findings of the pre-production review (org slice). Each journey failed before its fix. ──

const BR3 = 'c3'.repeat(12);
const DOC = 'd9'.repeat(12);
const fulfil = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const koramangala = (): Rec => ({ _id: BR3, partnerId: LAB, name: 'Koramangala', address: { line1: '5 Ring Rd', city: 'Bengaluru', state: 'Karnataka', stateCode: '29', pincode: '560034' },
  phone: '9000000012', holidays: [], services: { inLab: true }, isActive: true, updatedAt: V0 });

test('WQ11b: a closed branch a member holds is shown “(closed)”, can be unticked, and is never sent unless still ticked', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.members.find((m) => m._id === STAFF)!.branchIds = [BR1, BR_OLD];
  backend.branches.push(koramangala());
  // As `validateBranchIds`: every id must be an ACTIVE branch of the partner.
  await page.route(`**/api/v1/partner-workspace/members/${STAFF}/branches`, async (route) => {
    const body = route.request().postDataJSON() as { branchIds: string[] };
    const active = new Set(backend.branches.filter((x) => x.isActive).map((x) => x._id));
    const invalid = body.branchIds.filter((id) => !active.has(id));
    if (invalid.length) {
      backend.calls.push({ method: 'PUT', path: `/partner-workspace/members/${STAFF}/branches`, body });
      return fulfil(route, 400, { error: 400, code: 'INVALID_BRANCH_IDS', message: `Branch IDs not found in this partner: ${invalid.join(', ')}` });
    }
    return route.fallback();
  });
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Staff' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Sita Staff' })).toContainText('Old Town (closed)');
  await page.getByRole('row').filter({ hasText: 'Sita Staff' }).getByRole('button', { name: 'Change branch access' }).click();
  const editor = page.getByRole('region', { name: 'Branch access for Sita Staff' });
  await expect(editor.getByLabel('Old Town (closed)')).toBeChecked();
  // Move her from Indiranagar to Koramangala, leaving the closed branch ticked: refused here, nothing sent.
  await editor.getByLabel('Koramangala').check();
  await editor.getByLabel('Indiranagar').uncheck();
  await editor.getByRole('button', { name: 'Save branch access' }).click();
  await expect(editor.getByText(/A closed branch cannot be given/)).toBeVisible();
  expect(backend.calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
  // Untick it: only the open choice is sent.
  await editor.getByLabel('Old Town (closed)').uncheck();
  await editor.getByRole('button', { name: 'Save branch access' }).click();
  await expect(page.getByText('Branch access for Sita Staff was saved.')).toBeVisible();
  expect(backend.calls.filter((c) => c.method === 'PUT').map((c) => (c.body as Rec).branchIds)).toEqual([[BR3]]);
  expect(backend.members.find((m) => m._id === STAFF)!.branchIds).toEqual([BR3]);

  // A branch closed by someone else after the list was read: the server's refusal is said in words.
  backend.branches.find((x) => x._id === BR3)!.isActive = false;
  await page.getByRole('row').filter({ hasText: 'Sita Staff' }).getByRole('button', { name: 'Change branch access' }).click();
  const again = page.getByRole('region', { name: 'Branch access for Sita Staff' });
  await again.getByLabel('Indiranagar').check();
  await again.getByRole('button', { name: 'Save branch access' }).click();
  await expect(again.getByText('One of the chosen branches is closed or no longer exists, so nothing was saved. Untick it and save again.')).toBeVisible();
  await expect(again.getByText(/Branch IDs not found/)).toHaveCount(0);
});

test('WQ11b: a permissions save answered after another editor was opened leaves that editor and what was typed in it', async ({ page }) => {
  const backend = await mockBackend(page);
  let release!: () => void;
  const hold = new Promise<void>((r) => { release = r; });
  await page.route(`**/api/v1/partner-workspace/members/${STAFF}/permissions`, async (route) => { await hold; return route.fallback(); });
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Staff' }).click();
  await page.getByRole('row').filter({ hasText: 'Sita Staff' }).getByRole('button', { name: 'Edit permissions' }).click();
  const perms = page.getByRole('region', { name: 'Permissions for Sita Staff' });
  await perms.getByLabel('Manage bookings').check();
  const sent = page.waitForRequest((r) => r.method() === 'PUT' && r.url().endsWith(`/members/${STAFF}/permissions`));
  await perms.getByRole('button', { name: 'Save permissions' }).click();
  await sent;
  // While that save is on its way the owner opens another editor and types in it.
  await page.getByRole('row').filter({ hasText: 'Sita Staff' }).getByRole('button', { name: 'Add email' }).click();
  const email = page.getByRole('region', { name: 'Email for Sita Staff' });
  await email.getByLabel('Email').fill('sita@lab.in');
  release();
  await expect(page.getByText('Permissions for Sita Staff were saved.')).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Sita Staff' })).toContainText('Manage bookings');
  await expect(email).toBeVisible();
  await expect(email.getByLabel('Email')).toHaveValue('sita@lab.in');
  expect(backend.members.find((m) => m._id === STAFF)!.permissions).toEqual(['bookings.view', 'bookings.manage']);
});

test('WQ11b: a branch save answered after another branch’s form was opened leaves that form alone', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.branches.push(koramangala());
  let release!: () => void;
  const hold = new Promise<void>((r) => { release = r; });
  await page.route(`**/api/v1/partner-workspace/branches/${BR1}`, async (route) => {
    if (route.request().method() === 'PUT') await hold;
    return route.fallback();
  });
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Branches' }).click();
  await page.getByRole('row').filter({ hasText: 'Indiranagar' }).getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Branch name').fill('Indiranagar Main');
  const sent = page.waitForRequest((r) => r.method() === 'PUT' && r.url().endsWith(`/branches/${BR1}`));
  await page.getByRole('button', { name: 'Save branch' }).click();
  await sent;
  await page.getByRole('row').filter({ hasText: 'Koramangala' }).getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByRole('heading', { name: 'Edit Koramangala' })).toBeVisible();
  await page.getByLabel('Branch name').fill('Koramangala East');
  release();
  await expect(page.getByText('Indiranagar Main was saved.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Edit Koramangala' })).toBeVisible();
  await expect(page.getByLabel('Branch name')).toHaveValue('Koramangala East');
  expect(backend.branches.find((x) => x._id === BR1)!.name).toBe('Indiranagar Main');
});

test('WQ11b: a field reset because someone else changed it is not reported as saved', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.branches.push(koramangala());
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Branches' }).click();
  await page.getByRole('row').filter({ hasText: 'Indiranagar' }).getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Branch name').fill('Indiranagar Main');
  await page.getByLabel('Phone', { exact: true }).fill('9000000044');
  // Someone else renames it meanwhile; the list is read again (here: after another branch is deactivated).
  Object.assign(backend.branches.find((x) => x._id === BR1)!, { name: 'Indiranagar 100ft Rd', updatedAt: '2026-11-14T01:00:00.000Z' });
  const kor = page.getByRole('row').filter({ hasText: 'Koramangala' });
  await kor.getByRole('button', { name: 'Deactivate' }).click();
  await kor.getByRole('button', { name: 'Deactivate Koramangala' }).click();
  await expect(page.getByText(/Someone else changed the name while you were editing/)).toBeVisible();
  await expect(page.getByLabel('Branch name')).toHaveValue('Indiranagar 100ft Rd');
  await page.getByRole('button', { name: 'Save branch' }).click();
  await expect(page.getByText('Indiranagar 100ft Rd was saved, except the name: someone else changed it while you were editing, so the saved value is kept. Change it again if still needed.')).toBeVisible();
  await expect(page.getByText('Indiranagar 100ft Rd was saved.', { exact: true })).toHaveCount(0);
  expect(backend.calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([{ phone: '9000000044', expectedUpdatedAt: '2026-11-14T01:00:00.000Z' }]);
});

test('WQ11b: a create answered after the admin left and came back: “Give up this create” opens the partner it made', async ({ page }) => {
  const backend = await mockBackend(page);
  let releaseCreate!: () => void;
  backend.holdCreate = new Promise<void>((r) => { releaseCreate = r; });
  await signInAdmin(page);
  await fillNewPartner(page);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect.poll(() => backend.partners.some((p) => p.name === 'Metro Diagnostics')).toBe(true); // committed; answer held
  await page.goto('/#/admin/partners');
  await expect(page.getByRole('heading', { name: 'Labs and clinics' })).toBeVisible();
  await page.goto('/#/admin/partners/new');
  await expect(page.getByText(/We could not confirm whether Metro Diagnostics was created/)).toBeVisible();
  releaseCreate(); // the first page's answer arrives now and settles the stored create
  await expect.poll(() => page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.endsWith(':admin-partner-create')).length)).toBe(0);
  await page.getByRole('button', { name: 'Give up this create' }).click();
  await expect.poll(() => backend.abandonAnswers).toEqual(['used']);
  await expect(page.getByRole('heading', { name: 'Metro Diagnostics' })).toBeVisible();
  expect(backend.partners.filter((p) => p.name === 'Metro Diagnostics')).toHaveLength(1);
});

test('WQ11b: the person’s own profile save coming back trimmed is only “Saved.”', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Profile' }).click();
  await page.getByLabel('Display name').fill('City Lab Plus ');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
  expect(backend.calls.filter((c) => c.method === 'PUT').map((c) => (c.body as Rec).name)).toEqual(['City Lab Plus']);
  await expect(page.getByText(/Someone else changed/)).toHaveCount(0);
  await expect(page.getByLabel('Display name')).toHaveValue('City Lab Plus');
});

test('WQ11b: an admin’s GSTIN typed in small letters is saved upper-cased and not reported as someone else’s change', async ({ page }) => {
  const backend = await mockBackend(page);
  const bodies: Rec[] = [];
  await page.route(`**/api/v1/partner-workspace/admin/${LAB}`, async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    const body = route.request().postDataJSON() as Rec;
    bodies.push(body);
    const p = backend.partners.find((x) => x._id === LAB)!;
    if (body.gstin) p.gstin = String(body.gstin).toUpperCase();
    if (body.taxRegime) p.taxRegime = body.taxRegime;
    touch(p);
    return fulfil(route, 200, { success: true, data: p });
  });
  await signInAdmin(page);
  await page.goto(`/#/admin/partners/${LAB}`);
  await page.getByLabel('GSTIN').fill('29abcde1234f1z5');
  await page.getByRole('button', { name: 'Save tax details' }).click();
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
  expect(bodies.map((b) => b.gstin)).toEqual(['29ABCDE1234F1Z5']);
  await expect(page.getByLabel('GSTIN')).toHaveValue('29ABCDE1234F1Z5');
  await expect(page.getByText(/Someone else changed/)).toHaveCount(0);
});

test('WQ11b: a branch add whose answer is lost is found in the list (made once); one lost before the server is sent again with the same key', async ({ page }) => {
  const backend = await mockBackend(page);
  const fill = async (name: string) => {
    await page.getByRole('button', { name: 'Add a branch' }).click();
    await page.getByLabel('Branch name').fill(name);
    await page.getByLabel('Phone', { exact: true }).fill('9000000020');
    await page.getByLabel('Address line 1').fill('4th Block');
    await page.getByLabel('City').fill('Bengaluru');
    await page.getByLabel('State', { exact: true }).fill('Karnataka');
    await page.getByLabel('State code').fill('KA');
    await page.getByLabel('PIN code').fill('560011');
  };
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Branches' }).click();
  await fill('Jayanagar');
  // The state code must be the GST one (bills compare it with the GSTIN).
  await page.getByRole('button', { name: 'Add branch', exact: true }).click();
  await expect(page.getByText('Enter the 2-digit GST state code, e.g. 29 for Karnataka.')).toBeVisible();
  expect(backend.calls.some((c) => c.method === 'POST' && c.path === '/partner-workspace/branches')).toBe(false);
  await page.getByLabel('State code').fill('29');
  // Made, but the answer never arrives: the list is read again and the new branch of that name is taken as this one.
  backend.dropBranch = 'after';
  await page.getByRole('button', { name: 'Add branch', exact: true }).click();
  await expect(page.getByText('Jayanagar was added (its answer was lost; it is in the list now).')).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Jayanagar' })).toHaveCount(1);
  expect(backend.branches.filter((x) => x.name === 'Jayanagar')).toHaveLength(1);

  // Lost before the server: the form is locked; "Send again" sends the same key and details, so one branch is made.
  await fill('Basavanagudi');
  await page.getByLabel('State code').fill('29');
  backend.dropBranch = 'before';
  await page.getByRole('button', { name: 'Add branch', exact: true }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed branch' });
  await expect(panel).toBeVisible();
  await expect(page.getByText(/Not confirmed: .*Basavanagudi is not in the branch list yet/)).toBeVisible();
  await expect(page.getByLabel('Branch name')).toBeDisabled();
  await panel.getByRole('button', { name: 'Send again' }).click();
  await expect(page.getByText('Basavanagudi was added.')).toBeVisible();
  const posts = backend.calls.filter((c) => c.method === 'POST' && c.path === '/partner-workspace/branches' && (c.body as Rec).name === 'Basavanagudi');
  expect(posts).toHaveLength(2);
  expect(posts[1]!.body).toEqual(posts[0]!.body);
  expect(backend.branches.filter((x) => x.name === 'Basavanagudi')).toHaveLength(1);
});

test('WQ11d: a resend of a lost branch create that is refused keeps the form locked: the first request may still arrive', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Branches' }).click();
  await page.getByRole('button', { name: 'Add a branch' }).click();
  await page.getByLabel('Branch name').fill('Basavanagudi');
  await page.getByLabel('Phone', { exact: true }).fill('9000000020');
  await page.getByLabel('Address line 1').fill('4th Block');
  await page.getByLabel('City').fill('Bengaluru');
  await page.getByLabel('State', { exact: true }).fill('Karnataka');
  await page.getByLabel('State code').fill('29');
  await page.getByLabel('PIN code').fill('560011');
  backend.dropBranch = 'before';
  await page.getByRole('button', { name: 'Add branch', exact: true }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed branch' });
  await expect(panel).toBeVisible();
  backend.refuseNextBranch = true;
  await panel.getByRole('button', { name: 'Send again' }).click();
  await expect(page.getByText(/Not sent again: .*the first request may still arrive, so the form stays as it was sent\./)).toBeVisible();
  await expect(panel).toBeVisible();
  await expect(page.getByLabel('Branch name')).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Send again' })).toBeVisible();
});

test('WQ11b: the partner name an admin searches for stays out of the address', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await nav(page).getByRole('link', { name: 'Labs and clinics' }).click();
  await page.getByLabel('Search by name').fill('Sunrise');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByText('1 partner', { exact: true })).toBeVisible();
  expect(backend.calls.some((c) => c.path.includes('q=Sunrise'))).toBe(true);
  expect(page.url()).not.toContain('Sunrise');
  // An old link with a name in it: searched, and the name taken out of the address.
  await page.goto('/#/admin/partners?q=City&kind=lab');
  await expect(page.getByLabel('Search by name')).toHaveValue('City');
  await expect.poll(() => page.url()).not.toContain('City');
  expect(page.url()).toContain('kind=lab');
});

test('WQ11b: the activity log names every action and record in words, never by its code', async ({ page }) => {
  await mockBackend(page);
  await page.route('**/api/v1/partner-workspace/audit', (route) => fulfil(route, 200, { success: true, data: [
    { _id: 'e1', partnerId: LAB, actorKind: 'member', actorId: OWNER, action: 'invoice.pay', targetKind: 'invoice', targetId: 'f1'.repeat(12), at: '2026-11-15T04:30:00.000Z' },
    { _id: 'e2', partnerId: LAB, actorKind: 'member', actorId: OWNER, action: 'member.email', targetKind: 'member', targetId: STAFF, detail: { email: 'set' }, at: '2026-11-15T04:20:00.000Z' },
    { _id: 'e3', partnerId: LAB, actorKind: 'member', actorId: OWNER, action: 'member.professional', targetKind: 'member', targetId: STAFF, at: '2026-11-15T04:10:00.000Z' },
    { _id: 'e4', partnerId: LAB, actorKind: 'admin', actorId: 'ad'.repeat(12), action: 'finance.refund_reversed', targetKind: 'settlement_account', targetId: 'f2'.repeat(12), at: '2026-11-15T04:00:00.000Z' },
  ] }));
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Activity log' }).click();
  await expect(page.getByRole('cell', { name: 'Recorded a payment', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Changed a sign-in email', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Changed a professional registration', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Earnings: refund reversed', exact: true })).toBeVisible(); // an action added later
  await expect(page.getByRole('cell', { name: 'A bill', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Payout account', exact: true })).toBeVisible();
  for (const code of ['invoice.pay', 'member.email', 'member.professional', 'invoice', 'settlement_account']) {
    await expect(page.getByRole('cell', { name: code, exact: true })).toHaveCount(0);
  }
});

test('WQ11b: a clinic doctor’s membership is not removed on Staff: it points to Doctors; a 409 USE_DOCTOR_UNLINK is said in words', async ({ page }) => {
  const manager: Me = { _id: STAFF, partnerId: LAB, name: 'Sita Staff', role: 'staff', permissions: ['staff.manage'], branchIds: [] };
  const backend = await mockBackend(page, manager);
  backend.members.find((m) => m._id === STAFF)!.permissions = ['staff.manage'];
  backend.members.find((m) => m._id === STAFF)!.branchIds = [];
  // A consult-only doctor membership as attachDoctorMember makes it, and a staff member who becomes one meanwhile.
  backend.members.push({ _id: 'b7'.repeat(12), partnerId: LAB, name: 'Dr Meera Rao', phone: '9000000077', role: 'staff', permissions: [], branchIds: [], doctorId: DOC, isActive: true, updatedAt: V0 });
  backend.members.push({ _id: 'b8'.repeat(12), partnerId: LAB, name: 'Dr Arun Shah', phone: '9000000078', role: 'staff', permissions: [], branchIds: [], isActive: true, updatedAt: V0 });
  await page.route(`**/api/v1/partner-workspace/members/${'b8'.repeat(12)}`, (route) => (route.request().method() === 'DELETE'
    ? fulfil(route, 409, { error: 409, code: 'USE_DOCTOR_UNLINK', message: 'This member is a doctor of the clinic: remove the doctor from the clinic instead (owner or admin)' })
    : route.fallback()));
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Staff' }).click();
  const meera = page.getByRole('row').filter({ hasText: 'Dr Meera Rao' });
  await expect(meera).toContainText('Clinic doctor');
  await expect(meera.getByRole('button', { name: 'Remove' })).toHaveCount(0);
  await expect(meera).toContainText('A doctor of this clinic: removed on Doctors (owner only).');
  await expect(meera.getByRole('link', { name: 'Doctors' })).toHaveAttribute('href', '#/partner/clinic-doctors');

  const arun = page.getByRole('row').filter({ hasText: 'Dr Arun Shah' });
  await arun.getByRole('button', { name: 'Remove' }).click();
  await arun.getByRole('button', { name: 'Remove Dr Arun Shah' }).click();
  await expect(arun.getByText('Dr Arun Shah is a doctor of this clinic, so nothing was changed. The owner removes them from the clinic on the Doctors page.')).toBeVisible();
  await expect(page.getByText('Dr Arun Shah was removed.')).toHaveCount(0);
  expect(backend.calls.some((c) => c.method === 'DELETE' && c.path === `/partner-workspace/members/${'b7'.repeat(12)}`)).toBe(false);
});

test('WQ11b/Q16b: an owner’s sign-in email is changed by an admin only; owners change staff emails, and add owners without one', async ({ page }) => {
  await mockBackend(page);
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Staff' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Sita Staff' }).getByRole('button', { name: 'Add email' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Ravi Owner' }).getByRole('button', { name: /email/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Add a staff member' }).click();
  await expect(page.getByLabel('Email (optional)')).toBeVisible();
  await page.getByLabel('Owner', { exact: true }).check();
  await expect(page.getByLabel('Email (optional)')).toHaveCount(0);
  await expect(page.getByText(/An owner’s sign-in email is added by the Jansetu team/)).toBeVisible();
});
