import { expect, test, type Page, type Route } from '@playwright/test';

/** WQ10b: admin pharmacy accounts (only admins create pharmacies), against a mocked `/pharmacies` backend. */
const ADMIN = 'ad'.repeat(12);
const P1 = 'f1'.repeat(12);
const P2 = 'f2'.repeat(12);
const P3 = 'f3'.repeat(12);

type Rec = Record<string, unknown>;
interface Backend {
  calls: { method: string; path: string; body: unknown }[];
  pharmacies: Rec[];
  adminLive: boolean;
  /** The next create is made, then its answer is lost. */
  dropCreate: boolean;
  /** The next create is lost before it is made. */
  loseCreate: boolean;
  /** Create answers this many ms late. */
  slowCreate: number;
}

let seq = 0;
const at = (n: number) => new Date(Date.UTC(2026, 10, 10, 6, 0, n)).toISOString();

function pharmacy(id: string, name: string, phone: string, o: Rec = {}): Rec {
  return { _id: id, name, phone, city: 'Pune', ownerName: 'Ravi', isVerified: true, isActive: true, pickupAvailable: true, deliveryAvailable: false,
    createdAt: at(++seq), updatedAt: at(seq), ...o };
}

async function mockBackend(page: Page, opts: { many?: boolean } = {}): Promise<Backend> {
  const b: Backend = {
    calls: [], adminLive: false, dropCreate: false, loseCreate: false, slowCreate: 0,
    pharmacies: [
      pharmacy(P1, 'Apollo Pharmacy', '9000000001', { email: 'desk@apollo.in' }),
      pharmacy(P2, 'Care Chemist', '9000000002', { isVerified: false, city: 'Mumbai' }),
      pharmacy(P3, 'Old Meds', '9000000003', { isActive: false }),
      ...(opts.many ? Array.from({ length: 20 }, (_, i) => pharmacy(`e${String(i).padStart(2, '0')}`.repeat(8), `Zeta Store ${i + 1}`, `91000000${String(i).padStart(2, '0')}`)) : []),
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
    const body = ['POST', 'PUT'].includes(method) ? req.postDataJSON() : null;
    if (path === '/auth/session/refresh') {
      if (!b.adminLive) return fail(route, 401, 'SESSION_ENDED', 'Please sign in again');
      return ok(route, { token: 'admin', expiresIn: 900, principal: { userId: ADMIN, userType: 'admin', sid: 's1' } });
    }
    if (path.startsWith('/auth/session')) return ok(route, {});
    b.calls.push({ method, path: `${path}${url.search}`, body });
    if (path === '/auth/admin/send') return ok(route, undefined);
    if (path === '/auth/admin/verify') { b.adminLive = true; return ok(route, { token: 'admin', expiresIn: 900, user: {} }); }
    if (req.headers().authorization !== 'Bearer admin') return fail(route, 401, 'UNAUTHORIZED', 'Authentication is required');
    if (path === '/auth/profile') return ok(route, { user: { _id: ADMIN, name: 'Ops Admin' }, userRole: 'admin' });

    if (path === '/pharmacies' && method === 'GET') {
      const q = url.searchParams;
      const name = (q.get('name') ?? '').toLowerCase();
      const flag = (k: string) => q.get(k);
      const all = b.pharmacies.filter((p) => (!name || String(p.name).toLowerCase().includes(name))
        && (flag('isVerified') === null || String(p.isVerified === true) === flag('isVerified'))
        && (flag('isActive') === null || String(p.isActive !== false) === flag('isActive')))
        .sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)));
      const limit = Number(q.get('limit') ?? 10);
      const pg = Number(q.get('page') ?? 1);
      return json(route, 200, { success: true, data: all.slice((pg - 1) * limit, pg * limit),
        pagination: { page: pg, limit, total: all.length, totalPages: Math.ceil(all.length / limit) } });
    }
    if (path === '/pharmacies' && method === 'POST') {
      if (b.slowCreate) await new Promise((r) => setTimeout(r, b.slowCreate));
      if (b.loseCreate) { b.loseCreate = false; return route.abort('failed'); }
      const x = body as Rec;
      if (b.pharmacies.some((p) => p.phone === x.phone)) return fail(route, 400, 'PHONE_ALREADY_EXISTS', 'A pharmacy with this phone number already exists');
      if (x.email && b.pharmacies.some((p) => p.email === x.email)) return fail(route, 400, 'EMAIL_ALREADY_EXISTS', 'A pharmacy with this email already exists');
      const made = { _id: `a${String(b.pharmacies.length).padStart(2, '0')}`.repeat(8), isVerified: false, isActive: true, pickupAvailable: false, deliveryAvailable: false,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...x };
      b.pharmacies.push(made);
      if (b.dropCreate) { b.dropCreate = false; return route.abort('failed'); }
      return ok(route, made, 201);
    }
    const one = /^\/pharmacies\/([0-9a-f]{24})$/.exec(path);
    if (one) {
      const p = b.pharmacies.find((x) => x._id === one[1]);
      if (!p) return fail(route, 404, 'PHARMACY_NOT_FOUND', 'Pharmacy not found');
      if (method === 'GET') return ok(route, p);
      if (method === 'PUT') {
        const x = body as Rec;
        if (x.phone && x.phone !== p.phone && b.pharmacies.some((y) => y.phone === x.phone)) return fail(route, 400, 'PHONE_ALREADY_EXISTS', 'A pharmacy with this phone number already exists');
        if (x.email && x.email !== p.email && b.pharmacies.some((y) => y.email === x.email)) return fail(route, 400, 'EMAIL_ALREADY_EXISTS', 'A pharmacy with this email already exists');
        Object.assign(p, x, { updatedAt: new Date().toISOString() });
        return ok(route, p);
      }
    }
    return fail(route, 404, 'NOT_FOUND', 'Not found');
  });
  return b;
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
const lists = (b: Backend) => b.calls.filter((c) => c.method === 'GET' && c.path.startsWith('/pharmacies?')).map((c) => c.path);
const posts = (b: Backend) => b.calls.filter((c) => c.method === 'POST' && c.path === '/pharmacies');
const puts = (b: Backend) => b.calls.filter((c) => c.method === 'PUT').map((c) => [c.path, c.body]);

async function fillNew(page: Page, name: string, phone: string) {
  await page.getByLabel('Pharmacy name').fill(name);
  await page.getByLabel('Mobile number').fill(phone);
}

/** Nothing about the pharmacy (number, email, name) is written to browser storage. */
async function storageHolds(page: Page, ...texts: string[]) {
  const all = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  return texts.filter((t) => all.includes(t));
}

test('pharmacies: listed newest first, searched by name, filtered by status and paged', async ({ page }) => {
  const backend = await mockBackend(page, { many: true });
  await signInAdmin(page);
  await nav(page).getByRole('link', { name: 'Pharmacies' }).click();
  await expect(page.getByRole('heading', { name: 'Pharmacies' })).toBeVisible();
  await expect(page.getByText('23 pharmacies')).toBeVisible();
  await expect(page.getByText('Page 1 of 2')).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Care Chemist' })).toContainText('Not verified');
  await expect(page.getByRole('row').filter({ hasText: 'Old Meds' })).toContainText('Inactive');
  await page.getByLabel('Search by name').fill('care');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByText('1 pharmacy')).toBeVisible();
  await page.getByLabel('Verification').selectOption('true');
  await expect(page.getByText('No pharmacies match')).toBeVisible();
  await page.getByLabel('Search by name').fill('');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByLabel('Active').selectOption('false');
  await expect(page.getByRole('row').filter({ hasText: 'Old Meds' })).toContainText('9000000003');
  expect(lists(backend).slice(0, 4)).toEqual([
    '/pharmacies?page=1&limit=20',
    '/pharmacies?page=2&limit=20',
    '/pharmacies?name=care&page=1&limit=20',
    '/pharmacies?name=care&isVerified=true&page=1&limit=20',
  ]);
  // A search cleared and a filter changed straight after: both count (the second starts from the first).
  expect(lists(backend).at(-1)).toBe('/pharmacies?isVerified=true&isActive=false&page=1&limit=20');
  await expect(page).not.toHaveURL(/9000000/);
});

test('add a pharmacy: fields checked as the server does, a taken number on its field, one request however often it is clicked, then opened', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await page.goto('/#/admin/pharmacies');
  await page.getByRole('link', { name: 'Add a pharmacy' }).click();
  await page.getByRole('button', { name: 'Add pharmacy' }).click();
  await expect(page.getByText('Enter the pharmacy’s name.')).toBeVisible();
  await expect(page.getByText('Enter the 10-digit mobile number.')).toBeVisible();
  await fillNew(page, 'New Life Pharmacy', '9000000001');
  await page.getByLabel('Email (optional)').fill('new@');
  await page.getByLabel('PIN code (optional)').fill('4110');
  await page.getByRole('button', { name: 'Add pharmacy' }).click();
  await expect(page.getByText('Enter a valid email address.')).toBeVisible();
  await expect(page.getByText('Enter the 6-digit PIN code.')).toBeVisible();
  expect(posts(backend)).toHaveLength(0);
  await page.getByLabel('Email (optional)').fill(' Desk@NewLife.IN ');
  await page.getByLabel('PIN code (optional)').fill('411001');
  await page.getByRole('button', { name: 'Add pharmacy' }).click();
  await expect(page.getByText('Another pharmacy already signs in with this mobile number.', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Pharmacy name')).toBeEnabled(); // a refused first attempt unlocks the form

  backend.slowCreate = 400;
  await page.getByLabel('Mobile number').fill('9000000005');
  await page.getByLabel('Owner’s name (optional)').fill(' Meena ');
  await page.getByLabel('Get a delivery').check();
  const add = page.getByRole('button', { name: 'Add pharmacy' });
  await add.click();
  await add.click({ force: true }).catch(() => undefined);
  await page.getByLabel('Pharmacy name').press('Enter').catch(() => undefined);
  await expect(page.getByRole('heading', { name: 'New Life Pharmacy' })).toBeVisible();
  expect(posts(backend)).toHaveLength(2); // the refused one, then exactly one more
  expect(posts(backend)[1]!.body).toEqual({ name: 'New Life Pharmacy', phone: '9000000005', email: 'desk@newlife.in', ownerName: 'Meena', pincode: '411001',
    pickupAvailable: false, deliveryAvailable: true });
  await expect(page.getByText('Not verified')).toBeVisible();
  expect(await storageHolds(page, '9000000005', 'desk@newlife.in', 'New Life')).toEqual([]);
});

test('a lost create answer locks the form; the check by mobile number finds it, so nothing is sent twice', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await page.goto('/#/admin/pharmacies/new');
  await fillNew(page, 'Lost Answer Pharmacy', '9000000006');
  backend.dropCreate = true;
  await page.getByRole('button', { name: 'Add pharmacy' }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed pharmacy' });
  await expect(panel).toContainText('We could not confirm whether Lost Answer Pharmacy was created');
  await expect(page.getByLabel('Pharmacy name')).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Send again' })).toBeDisabled(); // check first
  // Leaving and coming back keeps it locked.
  await page.goto('/#/admin/pharmacies');
  await page.getByRole('link', { name: 'Add a pharmacy' }).click();
  await expect(page.getByRole('group', { name: 'Unconfirmed pharmacy' })).toBeVisible();
  await page.getByRole('button', { name: 'Check by mobile number' }).click();
  await expect(page.getByRole('heading', { name: 'Lost Answer Pharmacy was created' })).toBeVisible();
  await page.getByRole('link', { name: 'Open Lost Answer Pharmacy' }).click();
  await expect(page.getByRole('heading', { name: 'Lost Answer Pharmacy' })).toBeVisible();
  expect(posts(backend)).toHaveLength(1);
  expect(backend.pharmacies.filter((p) => p.phone === '9000000006')).toHaveLength(1);
  expect(lists(backend)).toContain('/pharmacies?page=1&limit=100&sortBy=createdAt&sortOrder=desc');
  expect(await storageHolds(page, '9000000006', 'Lost Answer')).toEqual([]);
});

test('lost before it was made: the check finds nothing, then the same request is sent once more and makes one pharmacy', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await page.goto('/#/admin/pharmacies/new');
  await fillNew(page, 'Second Try Pharmacy', '9000000007');
  backend.loseCreate = true;
  await page.getByRole('button', { name: 'Add pharmacy' }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed pharmacy' });
  await panel.getByRole('button', { name: 'Check by mobile number' }).click();
  await expect(page.getByText('No pharmacy has this mobile number yet.', { exact: false })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Start again' })).toBeVisible();
  await panel.getByRole('button', { name: 'Send again' }).click();
  await expect(page.getByRole('heading', { name: 'Second Try Pharmacy' })).toBeVisible();
  const sent = posts(backend);
  expect(sent).toHaveLength(2);
  expect(sent[1]!.body).toEqual(sent[0]!.body); // the same request
  expect(backend.pharmacies.filter((p) => p.phone === '9000000007')).toHaveLength(1);
});

test('a resend refused because the number now exists is checked by number: the earlier attempt made it', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await page.goto('/#/admin/pharmacies/new');
  await fillNew(page, 'Late Pharmacy', '9000000008');
  backend.loseCreate = true;
  await page.getByRole('button', { name: 'Add pharmacy' }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed pharmacy' });
  await panel.getByRole('button', { name: 'Check by mobile number' }).click();
  await expect(panel.getByRole('button', { name: 'Send again' })).toBeEnabled();
  // The first request arrives late, after the check.
  backend.pharmacies.push(pharmacy('a9'.repeat(12), 'Late Pharmacy', '9000000008', { isVerified: false, createdAt: new Date().toISOString() }));
  await panel.getByRole('button', { name: 'Send again' }).click();
  await expect(page.getByRole('heading', { name: 'Late Pharmacy was created' })).toBeVisible();
  expect(backend.pharmacies.filter((p) => p.phone === '9000000008')).toHaveLength(1);
});

test('after a reload an unconfirmed create cannot be checked here: the admin is sent to the list; only a marker without details was kept', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await page.goto('/#/admin/pharmacies/new');
  await fillNew(page, 'Reload Pharmacy', '9000000009');
  backend.loseCreate = true;
  await page.getByRole('button', { name: 'Add pharmacy' }).click();
  await expect(page.getByRole('group', { name: 'Unconfirmed pharmacy' })).toBeVisible();
  expect(await storageHolds(page, '9000000009', 'Reload Pharmacy')).toEqual([]);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'An unconfirmed pharmacy' })).toBeVisible();
  await expect(page.getByText('Its details are not kept on this device', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Start again' }).click();
  await expect(page.getByLabel('Pharmacy name')).toBeEnabled();
  await expect(page.getByLabel('Pharmacy name')).toHaveValue('');
});

test('pharmacy page: verify, deactivate and activate after confirming; details save only what changed and cannot clear a field', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await page.goto('/#/admin/pharmacies');
  await page.getByRole('link', { name: 'Care Chemist' }).click();
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByText('Care Chemist is marked verified: customers can find it and order from it.')).toBeVisible();
  await page.getByRole('button', { name: 'Verify Care Chemist' }).click();
  await expect(page.getByRole('button', { name: 'Verify' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Deactivate' }).click();
  await expect(page.getByText('Care Chemist can no longer sign in, and customers no longer see it.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Deactivate Care Chemist' }).click();
  await expect(page.getByRole('region', { name: 'Status' })).toContainText('Inactive');
  await page.getByRole('button', { name: 'Activate' }).click();
  await page.getByRole('button', { name: 'Activate Care Chemist' }).click();
  await expect(page.getByRole('button', { name: 'Deactivate' })).toBeVisible();

  const details = page.getByRole('region', { name: 'Details' });
  await details.getByLabel('City (optional)').fill('');
  await details.getByRole('button', { name: 'Save details' }).click();
  await expect(details.getByText('This cannot be removed here.', { exact: false })).toBeVisible();
  await details.getByLabel('City (optional)').fill('Thane');
  await details.getByLabel('Owner’s name (optional)').fill('Meena');
  await details.getByLabel('Get a delivery').check();
  await details.getByRole('button', { name: 'Save details' }).click();
  await expect(details.getByText('Saved.')).toBeVisible();
  await details.getByRole('button', { name: 'Save details' }).click();
  await expect(details.getByText('Nothing has changed.')).toBeVisible();
  expect(puts(backend)).toEqual([
    [`/pharmacies/${P2}`, { isVerified: true }],
    [`/pharmacies/${P2}`, { isActive: false }],
    [`/pharmacies/${P2}`, { isActive: true }],
    [`/pharmacies/${P2}`, { ownerName: 'Meena', city: 'Thane', deliveryAvailable: true }],
  ]);
});

test('a details field someone else changed meanwhile is shown for review and not overwritten', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await page.goto(`/#/admin/pharmacies/${P1}`);
  const details = page.getByRole('region', { name: 'Details' });
  await details.getByLabel('City (optional)').fill('Nashik');
  backend.pharmacies[0]!.city = 'Satara'; // changed by someone else before the save reads it again
  await details.getByRole('button', { name: 'Save details' }).click();
  await expect(details.getByText(/Someone else changed the city while you were editing/)).toBeVisible();
  await expect(details.getByLabel('City (optional)')).toHaveValue('Satara');
  expect(puts(backend)).toEqual([]);
});

test('changing how a pharmacy signs in: confirmed with what changes; a taken number on its field; a change made elsewhere stops it', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await page.goto(`/#/admin/pharmacies/${P1}`);
  const signIn = page.getByRole('region', { name: 'Sign-in' });
  await signIn.getByRole('button', { name: 'Change mobile number or email' }).click();
  await signIn.getByLabel('Email (optional)').fill('');
  await signIn.getByRole('button', { name: 'Continue' }).click();
  await expect(signIn.getByText('An email cannot be removed.', { exact: false })).toBeVisible();
  await signIn.getByLabel('Email (optional)').fill('desk@apollo.in');
  await signIn.getByLabel('Mobile number').fill('9000000002');
  await signIn.getByRole('button', { name: 'Continue' }).click();
  const confirm = signIn.getByRole('group', { name: 'Change how the pharmacy signs in' });
  await expect(confirm).toContainText('From now on Apollo Pharmacy signs in with mobile number 9000000002; 9000000001 no longer works for signing in.');
  await confirm.getByRole('button', { name: 'Change sign-in' }).click();
  await expect(signIn.getByText('Another pharmacy already signs in with this mobile number.', { exact: false })).toBeVisible();

  await signIn.getByLabel('Mobile number').fill('9000000077');
  await signIn.getByRole('button', { name: 'Continue' }).click();
  backend.pharmacies[0]!.email = 'owner@apollo.in'; // support changed it elsewhere meanwhile
  await signIn.getByRole('button', { name: 'Change sign-in' }).click();
  await expect(signIn.getByText('Someone else changed how Apollo Pharmacy signs in while you were editing', { exact: false })).toBeVisible();
  await expect(signIn.getByLabel('Email (optional)')).toHaveValue('owner@apollo.in');
  await expect(signIn.getByLabel('Mobile number')).toHaveValue('9000000001');

  await signIn.getByLabel('Mobile number').fill('9000000077');
  await signIn.getByLabel('Email (optional)').fill('Shop@Apollo.in');
  await signIn.getByRole('button', { name: 'Continue' }).click();
  await expect(signIn.getByRole('group', { name: 'Change how the pharmacy signs in' }))
    .toContainText('Its sign-in email changes from owner@apollo.in to shop@apollo.in; the old one no longer works.');
  await signIn.getByRole('button', { name: 'Change sign-in' }).click();
  await expect(signIn.getByText('Apollo Pharmacy now signs in with 9000000077 or shop@apollo.in.')).toBeVisible();
  expect(puts(backend)).toEqual([
    [`/pharmacies/${P1}`, { phone: '9000000002' }],
    [`/pharmacies/${P1}`, { phone: '9000000077', email: 'shop@apollo.in' }],
  ]);
  await expect(page).not.toHaveURL(/9000000077|apollo\.in/);
});
