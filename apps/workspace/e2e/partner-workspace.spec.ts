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
}

function partner(id: string, name: string, kind: 'lab' | 'clinic', state = 'verified', owners = 1): Rec {
  return { _id: id, kind, name, contact: { phone: '9000000000' }, verification: { state }, taxRegime: 'unregistered',
    invoiceSeries: { prefix: 'CL' }, activeOwnerCount: owners, isActive: state !== 'suspended', createdAt: '2026-11-10T05:00:00.000Z' };
}

const ownerMe: Me = { _id: OWNER, partnerId: LAB, name: 'Ravi Owner', role: 'owner', permissions: ALL, branchIds: [] };

async function mockBackend(page: Page, me: Me = ownerMe, opts: Partial<Pick<Backend, 'multi' | 'expired'>> = {}): Promise<Backend> {
  const b: Backend = {
    calls: [], me, multi: false, expired: false, conflictOnce: false, ...opts,
    members: [
      { _id: OWNER, partnerId: LAB, name: 'Ravi Owner', phone: '9000000001', role: 'owner', permissions: ALL, branchIds: [], isActive: true },
      { _id: STAFF, partnerId: LAB, name: 'Sita Staff', phone: '9000000002', role: 'staff', permissions: ['bookings.view'], branchIds: [BR1], isActive: true },
    ],
    branches: [
      { _id: BR1, partnerId: LAB, name: 'Indiranagar', address: { line1: '1 Main Rd', city: 'Bengaluru', state: 'Karnataka', stateCode: '29', pincode: '560038' },
        phone: '9000000010', hours: { mon: { open: '08:00', close: '20:00' } }, holidays: [], services: { homeCollection: true, inLab: true, inClinic: false }, isActive: true },
    ],
    partners: [partner(LAB, 'City Lab', 'lab', 'pending'), partner(CLINIC, 'Sunrise Clinic', 'clinic')],
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
    if (path === '/auth/admin/verify') return ok(route, { token: 'admin', expiresIn: 900, user: {} });
    const auth = req.headers().authorization;
    if (auth !== 'Bearer t1' && auth !== 'Bearer admin') return json(route, 401, { error: 401, message: 'Authentication is required' });
    if (path === '/auth/profile') {
      if (auth === 'Bearer admin') return ok(route, { user: { _id: ADMIN, name: 'Ops Admin' }, userRole: 'admin' });
      const p = b.partners.find((x) => x._id === b.me.partnerId)!;
      return ok(route, { user: { ...b.me, phone: '9000000001', isActive: true }, partner: { ...p, verification: { state: 'verified' } }, userRole: 'partner' });
    }

    // Admin partner accounts
    if (path === '/partner-workspace/admin' && method === 'GET') {
      const kind = url.searchParams.get('kind');
      const state = url.searchParams.get('verificationState');
      return ok(route, b.partners.filter((p) => (!kind || p.kind === kind) && (!state || (p.verification as Rec).state === state)));
    }
    if (path === '/partner-workspace/admin' && method === 'POST') {
      const x = body as Rec;
      const created = { ...partner('a3'.repeat(12), x.name as string, x.kind as 'lab'), contact: { phone: x.contactPhone } };
      b.partners.push(created);
      return ok(route, { partner: created, owner: { _id: NEWBIE, name: (x.firstOwner as Rec).name } }, 201);
    }
    const adm = /^\/partner-workspace\/admin\/([0-9a-f]{24})(\/verify|\/suspend)?$/.exec(path);
    if (adm) {
      const p = b.partners.find((x) => x._id === adm[1]);
      if (!p) return json(route, 404, { error: 404, code: 'PARTNER_NOT_FOUND', message: 'Partner not found' });
      if (adm[2] === '/verify') {
        if ((p.verification as Rec).state !== 'pending') return json(route, 409, { error: 409, code: 'VERIFICATION_STATE_CONFLICT', message: 'Partner is not in pending state' });
        p.verification = { state: 'verified', verifiedAt: '2026-11-15T05:00:00.000Z' };
      } else if (adm[2] === '/suspend') {
        p.verification = { state: 'suspended' }; p.isActive = false;
      }
      return ok(route, p);
    }

    // Workspace (members, or an admin under /admin/:id/workspace)
    const ws = /^\/partner-workspace(?:\/admin\/([0-9a-f]{24})\/workspace)?(\/.*)$/.exec(path);
    if (ws) {
      if (ws[1] && auth !== 'Bearer admin') return json(route, 403, { error: 403, message: 'Admin access is required' });
      const sub = ws[2]!;
      const pid = ws[1] ?? b.me.partnerId;
      if (sub === '/me') return ok(route, b.partners.find((p) => p._id === pid));
      if (sub === '/members' && method === 'GET') return ok(route, b.members);
      if (sub === '/members' && method === 'POST') {
        if (b.conflictOnce) {
          b.conflictOnce = false;
          return json(route, 409, { error: 409, code: 'MEMBER_ALREADY_EXISTS', message: 'An active member with this phone already exists for this partner' });
        }
        const m = { _id: NEWBIE, partnerId: pid, isActive: true, ...(body as Rec), branchIds: (body as Rec).branchIds ?? [] };
        b.members.push(m);
        return ok(route, m, 201);
      }
      const mm = /^\/members\/([0-9a-f]{24})(\/permissions)?$/.exec(sub);
      if (mm && method === 'DELETE') { b.members = b.members.filter((m) => m._id !== mm[1]); return json(route, 200, { success: true, message: 'Member removed' }); }
      if (mm && mm[2]) {
        const m = b.members.find((x) => x._id === mm[1])!;
        m.permissions = (body as Rec).permissions;
        return ok(route, m);
      }
      if (sub === '/branches' && method === 'GET') return ok(route, b.branches);
      if (sub === '/branches' && method === 'POST') {
        const br = { _id: BR2, partnerId: pid, isActive: true, ...(body as Rec) };
        b.branches.push(br);
        return ok(route, br, 201);
      }
      const bm = /^\/branches\/([0-9a-f]{24})$/.exec(sub);
      if (bm && method === 'DELETE') { b.branches = b.branches.filter((x) => x._id !== bm[1]); return json(route, 200, { success: true, message: 'Branch deactivated' }); }
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
  await mockBackend(page, { _id: STAFF, partnerId: LAB, name: 'Sita Staff', role: 'staff', permissions: ['bookings.view'], branchIds: [BR1] });
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
  expect(backend.calls.find((c) => c.method === 'PUT')).toEqual({ method: 'PUT', path: `/partner-workspace/members/${STAFF}/permissions`, body: { permissions: ['bookings.view', 'bookings.manage'] } });

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
  await expect(page.getByRole('row').filter({ hasText: 'City Lab' })).toHaveCount(0);
  expect(backend.calls.some((c) => c.path === '/partner-workspace/admin?kind=clinic')).toBe(true);
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
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText('Use 1 to 6 letters or digits.')).toBeVisible();
  await page.getByLabel('Display name').fill('Metro Diagnostics');
  await page.getByLabel('Contact phone').fill('9000000030');
  await page.getByLabel('Invoice prefix').fill('md1');
  await page.getByLabel('Owner name').fill('Meena');
  await page.getByLabel('Owner mobile number').fill('9000000031');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: 'Metro Diagnostics' })).toBeVisible();
  expect(backend.calls.find((c) => c.method === 'POST' && c.path === '/partner-workspace/admin')?.body).toEqual({
    kind: 'lab', name: 'Metro Diagnostics', contactPhone: '9000000030', taxRegime: 'unregistered', invoiceSeriesPrefix: 'MD1',
    firstOwner: { name: 'Meena', phone: '9000000031' },
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
