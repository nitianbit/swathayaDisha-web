import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * WQ10b: admin pharmacy accounts (only admins create pharmacies), against a mocked `/pharmacies` backend. WQ10c (Q15):
 * the create is keyed (`requestKey`; a repeat answers 200 `replayed: true`; `by-key` and `abandon`), the list filters by
 * exact `phone`, and the edit is fenced by `expectedUpdatedAt` (409 RECORD_CHANGED), clears optional fields sent as
 * null, refuses an empty name or number, and signs the pharmacy out when its number or a held email changes.
 */
const ADMIN = 'ad'.repeat(12);
const P1 = 'f1'.repeat(12);
const P2 = 'f2'.repeat(12);
const P3 = 'f3'.repeat(12);

type Rec = Record<string, unknown>;
interface Backend {
  calls: { method: string; path: string; body: unknown }[];
  pharmacies: Rec[];
  adminLive: boolean;
  /** Q15 create keys of this admin: used (with the pharmacy and the content it was bound to) or abandoned. */
  keys: Record<string, { state: 'used' | 'abandoned'; id?: string; hash?: string }>;
  /** Pharmacies whose sessions an edit ended (Q15 revokeAllSessions). */
  signedOut: string[];
  /** The next create is made, then its answer is lost. */
  dropCreate: boolean;
  /** The next create is lost before it is made. */
  loseCreate: boolean;
  /** Create answers this many ms late. */
  slowCreate: number;
  /** Someone else saves the pharmacy (its city) just before the next edit lands. */
  bumpBeforePut: boolean;
  /** Q15 review: the next keyed create is refused 503 INDEXES_OUTDATED (sync-indexes has not run). */
  indexesOutdated: boolean;
}

let seq = 0;
const at = (n: number) => new Date(Date.UTC(2026, 10, 10, 6, 0, n)).toISOString();
/** A fresh, distinct `updatedAt` for every write. */
const stamp = () => new Date(Date.UTC(2026, 10, 20, 6, 0, 0, ++seq)).toISOString();

function pharmacy(id: string, name: string, phone: string, o: Rec = {}): Rec {
  return { _id: id, name, phone, city: 'Pune', ownerName: 'Ravi', isVerified: true, isActive: true, pickupAvailable: true, deliveryAvailable: false,
    createdAt: at(++seq), updatedAt: at(seq), ...o };
}

const CLEARABLE = ['nickname', 'ownerName', 'email', 'address', 'city', 'state', 'pincode', 'gstNumber', 'drugLicenseNumber'];

async function mockBackend(page: Page, opts: { many?: boolean } = {}): Promise<Backend> {
  const b: Backend = {
    calls: [], adminLive: false, keys: {}, signedOut: [], dropCreate: false, loseCreate: false, slowCreate: 0, bumpBeforePut: false, indexesOutdated: false,
    pharmacies: [
      pharmacy(P1, 'Apollo Pharmacy', '9000000001', { email: 'desk@apollo.in' }),
      pharmacy(P2, 'Care Chemist', '9000000002', { isVerified: false, city: 'Mumbai' }),
      pharmacy(P3, 'Old Meds', '9000000003', { isActive: false, email: 'old@meds.in' }),
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
      if (q.get('phone') !== null && !/^[0-9]{10}$/.test(q.get('phone')!)) return fail(route, 400, 'VALIDATION_ERROR', 'phone must be exactly 10 digits');
      const all = b.pharmacies.filter((p) => (!name || String(p.name).toLowerCase().includes(name))
        && (q.get('phone') === null || p.phone === q.get('phone'))
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
      const { requestKey, ...x } = body as Rec;
      const key = requestKey as string | undefined;
      if (key !== undefined && !/^[A-Za-z0-9_-]{8,100}$/.test(key)) return fail(route, 400, 'VALIDATION_ERROR', 'Invalid request key');
      if (key && b.indexesOutdated) { b.indexesOutdated = false; return fail(route, 503, 'INDEXES_OUTDATED', 'The database needs an update (sync-indexes) before this can be used'); }
      const hash = JSON.stringify(x);
      const k = key ? b.keys[key] : undefined;
      if (k?.state === 'used') {
        if (k.hash !== hash) return fail(route, 409, 'REQUEST_KEY_REUSED', 'This request key was already used for a different pharmacy');
        return json(route, 200, { success: true, data: b.pharmacies.find((p) => p._id === k.id), replayed: true });
      }
      if (k?.state === 'abandoned') return fail(route, 409, 'REQUEST_ABANDONED', 'This request was cancelled before it was recorded; make a new one');
      if (b.pharmacies.some((p) => p.phone === x.phone)) return fail(route, 400, 'PHONE_ALREADY_EXISTS', 'A pharmacy with this phone number already exists');
      if (x.email && b.pharmacies.some((p) => p.email === x.email)) return fail(route, 400, 'EMAIL_ALREADY_EXISTS', 'A pharmacy with this email already exists');
      const made = { _id: `a${String(b.pharmacies.length).padStart(2, '0')}`.repeat(8), isVerified: false, isActive: true, pickupAvailable: false, deliveryAvailable: false,
        createdAt: new Date().toISOString(), updatedAt: stamp(), ...x };
      b.pharmacies.push(made);
      if (key) b.keys[key] = { state: 'used', id: made._id, hash };
      if (b.dropCreate) { b.dropCreate = false; return route.abort('failed'); }
      return ok(route, made, 201);
    }
    const byKey = /^\/pharmacies\/by-key\/([A-Za-z0-9_-]{8,100})(\/abandon)?$/.exec(path);
    if (byKey) {
      const k = b.keys[byKey[1]!];
      const made = k?.state === 'used' ? b.pharmacies.find((p) => p._id === k.id) : undefined;
      if (method === 'GET' && !byKey[2]) return made ? ok(route, made) : fail(route, 404, 'PHARMACY_NOT_FOUND', 'No pharmacy was created with this key');
      if (method === 'POST' && byKey[2]) {
        if (made) return ok(route, { state: 'used', pharmacy: made });
        b.keys[byKey[1]!] = { state: 'abandoned' };
        return ok(route, { state: 'abandoned' });
      }
    }
    const one = /^\/pharmacies\/([0-9a-f]{24})$/.exec(path);
    if (one) {
      const p = b.pharmacies.find((x) => x._id === one[1]);
      if (!p) return fail(route, 404, 'PHARMACY_NOT_FOUND', 'Pharmacy not found');
      if (method === 'GET') return ok(route, p);
      if (method === 'PUT') {
        const { expectedUpdatedAt, ...x } = body as Rec;
        if (b.bumpBeforePut) { b.bumpBeforePut = false; Object.assign(p, { city: 'Satara', updatedAt: stamp() }); }
        if (expectedUpdatedAt && expectedUpdatedAt !== p.updatedAt) return fail(route, 409, 'RECORD_CHANGED', 'Someone else changed this pharmacy meanwhile; reload and review');
        if (('name' in x && !x.name) || ('phone' in x && !x.phone)) return fail(route, 400, 'VALIDATION_ERROR', 'name and phone cannot be cleared');
        if (x.phone && x.phone !== p.phone && b.pharmacies.some((y) => y.phone === x.phone)) return fail(route, 400, 'PHONE_ALREADY_EXISTS', 'A pharmacy with this phone number already exists');
        if (x.email && x.email !== p.email && b.pharmacies.some((y) => y.email === x.email)) return fail(route, 409, 'EMAIL_ALREADY_EXISTS', 'A pharmacy with this email already exists');
        const phoneChanged = x.phone !== undefined && x.phone !== p.phone;
        const emailChanged = !!p.email && x.email !== undefined && (x.email || undefined) !== p.email;
        for (const [k, v] of Object.entries(x)) {
          if ((v === null || v === '') && CLEARABLE.includes(k)) delete p[k]; else p[k] = v;
        }
        p.updatedAt = stamp();
        if (phoneChanged || emailChanged) b.signedOut.push(String(p._id));
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

test('pharmacies: listed newest first, searched by name, filtered by status and paged; found by exact mobile number (never in the address)', async ({ page }) => {
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
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByText('1 pharmacy')).toBeVisible();
  await page.getByLabel('Verification').selectOption('true');
  await expect(page.getByText('No pharmacies match')).toBeVisible();
  await page.getByLabel('Search by name').fill('');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
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

  // Q15: the exact mobile number lookup.
  const lookup = page.getByRole('region', { name: 'Find by mobile number' });
  await lookup.getByLabel('Find by mobile number').fill('90000');
  await lookup.getByRole('button', { name: 'Find' }).click();
  await expect(lookup.getByText('Enter the 10-digit mobile number.')).toBeVisible();
  await lookup.getByLabel('Find by mobile number').fill('9000000003');
  await lookup.getByRole('button', { name: 'Find' }).click();
  await expect(lookup.getByText('signs in with 9000000003', { exact: false })).toBeVisible();
  await expect(lookup.getByRole('link', { name: 'Old Meds' })).toBeVisible();
  await lookup.getByLabel('Find by mobile number').fill('9000000099');
  await lookup.getByRole('button', { name: 'Find' }).click();
  await expect(lookup.getByText('No pharmacy signs in with 9000000099.')).toBeVisible();
  expect(lists(backend).slice(-2)).toEqual(['/pharmacies?phone=9000000003&page=1&limit=1', '/pharmacies?phone=9000000099&page=1&limit=1']);
  await expect(page).not.toHaveURL(/9000000/);
  expect(await storageHolds(page, '9000000003', '9000000099')).toEqual([]);
});

test('add a pharmacy: fields checked as the server does, a taken number names its holder, one keyed request however often it is clicked, then opened', async ({ page }) => {
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
  // Q15: the holder of the number is found with the exact phone filter and named.
  await expect(page.getByText('Apollo Pharmacy already signs in with this mobile number. Use a different number.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open Apollo Pharmacy' })).toBeVisible();
  expect(lists(backend)).toContain('/pharmacies?phone=9000000001&page=1&limit=1');
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
  const sent = posts(backend)[1]!.body as Rec;
  expect(sent).toEqual({ name: 'New Life Pharmacy', phone: '9000000005', email: 'desk@newlife.in', ownerName: 'Meena', pincode: '411001',
    pickupAvailable: false, deliveryAvailable: true, requestKey: expect.stringMatching(/^[A-Za-z0-9_-]{8,100}$/) });
  expect(sent.requestKey).not.toBe((posts(backend)[0]!.body as Rec).requestKey); // a refused request is over: a new key
  await expect(page.getByText('Not verified')).toBeVisible();
  expect(await storageHolds(page, '9000000005', 'desk@newlife.in', 'New Life')).toEqual([]);
});

test('WQ10c: a lost create answer locks the form; sending again with the same key is answered replayed, so one pharmacy is made', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await page.goto('/#/admin/pharmacies/new');
  await fillNew(page, 'Lost Answer Pharmacy', '9000000006');
  backend.dropCreate = true;
  await page.getByRole('button', { name: 'Add pharmacy' }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed pharmacy' });
  await expect(panel).toContainText('We could not confirm whether Lost Answer Pharmacy was created');
  await expect(page.getByLabel('Pharmacy name')).toBeDisabled();
  // Leaving and coming back keeps it locked.
  await page.goto('/#/admin/pharmacies');
  await page.getByRole('link', { name: 'Add a pharmacy' }).click();
  await page.getByRole('group', { name: 'Unconfirmed pharmacy' }).getByRole('button', { name: 'Send again' }).click();
  await expect(page.getByRole('heading', { name: 'Lost Answer Pharmacy' })).toBeVisible();
  const sent = posts(backend);
  expect(sent).toHaveLength(2);
  expect(sent[1]!.body).toEqual(sent[0]!.body); // the same key and details
  expect(backend.pharmacies.filter((p) => p.phone === '9000000006')).toHaveLength(1);
  expect(lists(backend).some((l) => l.includes('limit=100'))).toBe(false); // no list scanning any more
  expect(await storageHolds(page, '9000000006', 'Lost Answer')).toEqual([]);
});

test('WQ10c: lost before it was made: sent again once with the same key, one pharmacy', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await page.goto('/#/admin/pharmacies/new');
  await fillNew(page, 'Second Try Pharmacy', '9000000007');
  backend.loseCreate = true;
  await page.getByRole('button', { name: 'Add pharmacy' }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed pharmacy' });
  await panel.getByRole('button', { name: 'Send again' }).click();
  await expect(page.getByRole('heading', { name: 'Second Try Pharmacy' })).toBeVisible();
  const sent = posts(backend);
  expect(sent).toHaveLength(2);
  expect(sent[1]!.body).toEqual(sent[0]!.body);
  expect(backend.pharmacies.filter((p) => p.phone === '9000000007')).toHaveLength(1);
});

test('WQ10c: giving up a lost create: abandoned when it was never made (the form unlocks); opened when it was', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await page.goto('/#/admin/pharmacies/new');
  await fillNew(page, 'Given Up Pharmacy', '9000000008');
  backend.loseCreate = true;
  await page.getByRole('button', { name: 'Add pharmacy' }).click();
  await page.getByRole('group', { name: 'Unconfirmed pharmacy' }).getByRole('button', { name: 'Give up this create' }).click();
  await expect(page.getByText('Given up: nothing was created, and that request can never create a pharmacy.', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Pharmacy name')).toBeEnabled();
  await expect(page.getByLabel('Pharmacy name')).toHaveValue('Given Up Pharmacy');
  const key = (posts(backend)[0]!.body as Rec).requestKey as string;
  expect(backend.keys[key]).toEqual({ state: 'abandoned' });
  expect(backend.calls.some((c) => c.method === 'POST' && c.path === `/pharmacies/by-key/${key}/abandon`)).toBe(true);

  // Made, answer lost, then given up: the server says it was used and the pharmacy opens.
  backend.dropCreate = true;
  await page.getByRole('button', { name: 'Add pharmacy' }).click();
  await page.getByRole('group', { name: 'Unconfirmed pharmacy' }).getByRole('button', { name: 'Give up this create' }).click();
  await expect(page.getByRole('heading', { name: 'Given Up Pharmacy' })).toBeVisible();
  expect(backend.pharmacies.filter((p) => p.phone === '9000000008')).toHaveLength(1);
});

test('WQ10c: after a reload only a body-less marker is kept: looked up by key (found = created), else given up before starting again', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await page.goto('/#/admin/pharmacies/new');
  await fillNew(page, 'Reload Pharmacy', '9000000009');
  backend.dropCreate = true;
  await page.getByRole('button', { name: 'Add pharmacy' }).click();
  await expect(page.getByRole('group', { name: 'Unconfirmed pharmacy' })).toBeVisible();
  expect(await storageHolds(page, '9000000009', 'Reload Pharmacy')).toEqual([]);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Reload Pharmacy was created' })).toBeVisible();
  const key = (posts(backend)[0]!.body as Rec).requestKey as string;
  expect(backend.calls.some((c) => c.method === 'GET' && c.path === `/pharmacies/by-key/${key}`)).toBe(true);
  await page.getByRole('button', { name: 'Add another' }).click();

  await fillNew(page, 'Never Made Pharmacy', '9000000010');
  backend.loseCreate = true;
  await page.getByRole('button', { name: 'Add pharmacy' }).click();
  await expect(page.getByRole('group', { name: 'Unconfirmed pharmacy' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'An unconfirmed pharmacy' })).toBeVisible();
  await expect(page.getByText('Its details are not kept on this device', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Give up this create' }).click();
  await expect(page.getByText('Given up: nothing was created', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Pharmacy name')).toBeEnabled();
  await expect(page.getByLabel('Pharmacy name')).toHaveValue('');
});

test('pharmacy page: verify, deactivate and activate after confirming, each with its version; details save only what changed and clear an emptied field', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await page.goto('/#/admin/pharmacies');
  const v0 = backend.pharmacies[1]!.updatedAt;
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
  await expect(details.getByText('To remove an optional detail, empty its field and save. The name cannot be removed.')).toBeVisible();
  await details.getByLabel('Pharmacy name').fill('');
  await details.getByRole('button', { name: 'Save details' }).click();
  await expect(details.getByText('The name cannot be removed. Enter the new name.')).toBeVisible();
  await details.getByLabel('Pharmacy name').fill('Care Chemist');
  await details.getByLabel('City (optional)').fill('');
  await details.getByLabel('Owner’s name (optional)').fill('Meena');
  await details.getByLabel('Get a delivery').check();
  await details.getByRole('button', { name: 'Save details' }).click();
  await expect(details.getByText('Saved.')).toBeVisible();
  await expect(details.getByLabel('City (optional)')).toHaveValue('');
  expect('city' in backend.pharmacies[1]!).toBe(false); // cleared on the server
  await details.getByRole('button', { name: 'Save details' }).click();
  await expect(details.getByText('Nothing has changed.')).toBeVisible();
  const sent = puts(backend);
  expect(sent.map(([, body]) => { const { expectedUpdatedAt: _v, ...rest } = body as Rec; return rest; })).toEqual([
    { isVerified: true }, { isActive: false }, { isActive: true }, { ownerName: 'Meena', city: null, deliveryAvailable: true },
  ]);
  expect((sent[0]![1] as Rec).expectedUpdatedAt).toBe(v0);
  // Each change names the version it was decided on: the one the previous change left.
  expect(new Set(sent.map(([, body]) => (body as Rec).expectedUpdatedAt)).size).toBe(4);
  expect(backend.signedOut).toEqual([]);
});

test('a details field someone else changed meanwhile is shown for review and not overwritten', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await page.goto(`/#/admin/pharmacies/${P1}`);
  const details = page.getByRole('region', { name: 'Details' });
  await details.getByLabel('City (optional)').fill('Nashik');
  backend.pharmacies[0]!.city = 'Satara'; // changed by someone else before the save reads it again
  backend.pharmacies[0]!.updatedAt = stamp();
  await details.getByRole('button', { name: 'Save details' }).click();
  await expect(details.getByText(/Someone else changed the city while you were editing/)).toBeVisible();
  await expect(details.getByLabel('City (optional)')).toHaveValue('Satara');
  expect(puts(backend)).toEqual([]);
});

test('WQ10c: a change landing between the re-read and the save is refused RECORD_CHANGED: nothing saved, the saved value shown for review', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await page.goto(`/#/admin/pharmacies/${P1}`);
  const details = page.getByRole('region', { name: 'Details' });
  await details.getByLabel('City (optional)').fill('Nashik');
  backend.bumpBeforePut = true; // someone saves the city just before this save lands
  await details.getByRole('button', { name: 'Save details' }).click();
  await expect(details.getByText(/Someone else changed the city while you were editing/)).toBeVisible();
  await expect(details.getByLabel('City (optional)')).toHaveValue('Satara');
  expect(backend.pharmacies[0]!.city).toBe('Satara');
  await details.getByLabel('City (optional)').fill('Nashik');
  await details.getByRole('button', { name: 'Save details' }).click();
  await expect(details.getByText('Saved.')).toBeVisible();
  expect(backend.pharmacies[0]!.city).toBe('Nashik');
  const sent = puts(backend);
  expect(sent).toHaveLength(2);
  expect((sent[1]![1] as Rec).expectedUpdatedAt).not.toBe((sent[0]![1] as Rec).expectedUpdatedAt);
});

test('changing how a pharmacy signs in: confirmed with what changes and that it signs the pharmacy out; taken number and email on their fields', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await page.goto(`/#/admin/pharmacies/${P1}`);
  const signIn = page.getByRole('region', { name: 'Sign-in' });
  await signIn.getByRole('button', { name: 'Change mobile number or email' }).click();
  await signIn.getByLabel('Mobile number').fill('');
  await signIn.getByRole('button', { name: 'Continue' }).click();
  await expect(signIn.getByText('The mobile number cannot be removed', { exact: false })).toBeVisible();
  await signIn.getByLabel('Mobile number').fill('9000000001');
  // Q15: an email can be removed; that signs the pharmacy out.
  await signIn.getByLabel('Email (optional)').fill('');
  await signIn.getByRole('button', { name: 'Continue' }).click();
  let confirm = signIn.getByRole('group', { name: 'Change how the pharmacy signs in' });
  await expect(confirm).toContainText('Its sign-in email desk@apollo.in is removed: it signs in with its mobile number only.');
  await expect(confirm).toContainText('This signs Apollo Pharmacy out on every computer and phone where it is signed in now.');
  await confirm.getByRole('button', { name: 'Back' }).click();

  await signIn.getByLabel('Email (optional)').fill('old@meds.in');
  await signIn.getByRole('button', { name: 'Continue' }).click();
  await signIn.getByRole('button', { name: 'Change sign-in' }).click();
  await expect(signIn.getByText('Another pharmacy already uses this email. Use a different email.')).toBeVisible(); // 409 on the edit
  await signIn.getByLabel('Email (optional)').fill('desk@apollo.in');
  await signIn.getByLabel('Mobile number').fill('9000000002');
  await signIn.getByRole('button', { name: 'Continue' }).click();
  confirm = signIn.getByRole('group', { name: 'Change how the pharmacy signs in' });
  await expect(confirm).toContainText('From now on Apollo Pharmacy signs in with mobile number 9000000002; 9000000001 no longer works for signing in.');
  await expect(confirm).toContainText('This signs Apollo Pharmacy out');
  await confirm.getByRole('button', { name: 'Change sign-in' }).click();
  await expect(signIn.getByText('Another pharmacy already signs in with this mobile number.', { exact: false })).toBeVisible();

  await signIn.getByLabel('Mobile number').fill('9000000077');
  await signIn.getByRole('button', { name: 'Continue' }).click();
  backend.pharmacies[0]!.email = 'owner@apollo.in'; // support changed it elsewhere meanwhile
  backend.pharmacies[0]!.updatedAt = stamp();
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
  await expect(signIn.getByText('Apollo Pharmacy now signs in with 9000000077 or shop@apollo.in. It was signed out and signs in again with these.')).toBeVisible();
  const sent = puts(backend);
  expect(sent.map(([path, body]) => [path, { ...(body as Rec), expectedUpdatedAt: undefined }])).toEqual([
    [`/pharmacies/${P1}`, { email: 'old@meds.in', expectedUpdatedAt: undefined }],
    [`/pharmacies/${P1}`, { phone: '9000000002', expectedUpdatedAt: undefined }],
    [`/pharmacies/${P1}`, { phone: '9000000077', email: 'shop@apollo.in', expectedUpdatedAt: undefined }],
  ]);
  expect(sent.every(([, body]) => typeof (body as Rec).expectedUpdatedAt === 'string')).toBe(true);
  expect(backend.signedOut).toEqual([P1]);
  await expect(page).not.toHaveURL(/9000000077|apollo\.in/);
});

test('WQ10c: adding a first email does not sign the pharmacy out, and says so', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await page.goto(`/#/admin/pharmacies/${P2}`);
  const signIn = page.getByRole('region', { name: 'Sign-in' });
  await signIn.getByRole('button', { name: 'Change mobile number or email' }).click();
  await signIn.getByLabel('Email (optional)').fill('desk@care.in');
  await signIn.getByRole('button', { name: 'Continue' }).click();
  const confirm = signIn.getByRole('group', { name: 'Change how the pharmacy signs in' });
  await expect(confirm).toContainText('It can also sign in with desk@care.in.');
  await expect(confirm).toContainText('Anyone already signed in stays signed in.');
  await confirm.getByRole('button', { name: 'Change sign-in' }).click();
  await expect(signIn.getByText('Care Chemist now signs in with 9000000002 or desk@care.in.')).toBeVisible();
  expect(backend.signedOut).toEqual([]);
});

test('WQ10c: a create refused 503 INDEXES_OUTDATED stays unconfirmed with the server’s words; sent again later with the same key, one pharmacy', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await page.goto('/#/admin/pharmacies/new');
  await fillNew(page, 'Index Pharmacy', '9000000011');
  backend.indexesOutdated = true;
  await page.getByRole('button', { name: 'Add pharmacy' }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed pharmacy' });
  await expect(panel).toContainText('We could not confirm whether Index Pharmacy was created (The database needs an update (sync-indexes) before this can be used: ask the Jansetu team).');
  await expect(page.getByLabel('Pharmacy name')).toBeDisabled();
  await panel.getByRole('button', { name: 'Send again' }).click();
  await expect(page.getByRole('heading', { name: 'Index Pharmacy' })).toBeVisible();
  const sent = posts(backend);
  expect(sent).toHaveLength(2);
  expect(sent[1]!.body).toEqual(sent[0]!.body);
  expect(backend.pharmacies.filter((p) => p.phone === '9000000011')).toHaveLength(1);
});
