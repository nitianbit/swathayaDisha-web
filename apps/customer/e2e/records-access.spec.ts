import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * WQ28: the account holder answers doctors asking to see past records (assisted booking round 3f, backend r30, design
 * §25.17): a waiting request on Home with Allow and Deny, the page under Profile with who can see the records (Stop
 * sharing) and the past requests; an ended request; nothing about anyone kept in the browser. Mocked API.
 */
const ME = 'c1'.repeat(12);
const DOC = 'd1'.repeat(12);
const DOC2 = 'd2'.repeat(12);
const R1 = 'a1'.repeat(12);
const R2 = 'a2'.repeat(12);
const DEP = 'e1'.repeat(12);
const NOW = new Date('2026-11-25T04:30:00.000Z');
const LATER = '2026-11-26T04:30:00.000Z';

type Json = Record<string, unknown>;
interface Backend { calls: { method: string; path: string }[]; requests: Json[]; grants: Json[]; expireOnAnswer: boolean; off: boolean }

const request = (o: Json = {}): Json => ({
  _id: R1, state: 'pending', treatingBookingId: 'b1'.repeat(12), createdAt: NOW.toISOString(), expiresAt: LATER, decidedAt: null,
  doctor: { id: DOC, name: 'Asha Mehta', specialization: 'Cardiology' }, patient: { personKey: 'self', name: null }, ...o,
});

async function mockBackend(page: Page, init: { requests?: Json[]; grants?: Json[] } = {}): Promise<Backend> {
  await page.clock.setFixedTime(NOW);
  const b: Backend = { calls: [], requests: init.requests ?? [request()], grants: init.grants ?? [], expireOnAnswer: false, off: false };
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const ok = (route: Route, data: unknown) => json(route, 200, { success: true, data });
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = req.method();
    b.calls.push({ method, path: `${path}${url.search}` });
    if (path === '/auth/user/send') return json(route, 200, { success: true });
    if (path === '/auth/user/verify') return ok(route, { token: 't', user: {} });
    if (path === '/auth/session/refresh') return json(route, 401, { error: 401, code: 'SESSION_ENDED', message: 'Please sign in again' });
    if (path === '/auth/profile') return ok(route, { user: { _id: ME, name: 'Asha Rao', phone: '9876543210', email: 'a@x.in', gender: 'Female', dateOfBirth: '19900101' }, userRole: 'user' });
    if (path === `/wallet/user/${ME}`) return ok(route, { _id: 'w', userId: ME, balance: 0, isActive: true });

    if (path === '/records-access/requests' && method === 'GET') {
      const state = url.searchParams.get('state');
      return ok(route, state ? b.requests.filter((r) => r.state === state) : b.requests);
    }
    const decide = /^\/records-access\/requests\/(\w{24})\/(approve|deny)$/.exec(path);
    if (decide) {
      const r = b.requests.find((x) => x._id === decide[1]);
      if (!r) return json(route, 404, { error: 404, code: 'RECORDS_REQUEST_NOT_FOUND', message: 'Request not found' });
      if (b.off) return json(route, 503, { error: 503, code: 'RECORDS_ACCESS_DISABLED', message: 'Records access is not switched on' });
      if (b.expireOnAnswer) { Object.assign(r, { state: 'expired', decidedAt: NOW.toISOString() }); return json(route, 409, { error: 409, code: 'RECORDS_REQUEST_EXPIRED', message: 'This request has expired' }); }
      if (r.state !== 'pending') return json(route, 409, { error: 409, code: 'RECORDS_REQUEST_NOT_PENDING', message: 'Not pending' });
      const approve = decide[2] === 'approve';
      Object.assign(r, { state: approve ? 'approved' : 'denied', decidedAt: NOW.toISOString() });
      const grant = approve ? { _id: 'f1'.repeat(12), state: 'active', via: 'app', at: NOW.toISOString(), expiresAt: '2027-11-25T04:30:00.000Z', revokedAt: null,
        doctor: r.doctor, patient: r.patient } : null;
      if (grant) b.grants.unshift(grant);
      return ok(route, { request: r, grant });
    }
    if (path === '/records-access/grants') return ok(route, b.grants);
    const revoke = /^\/records-access\/grants\/(\w{24})\/revoke$/.exec(path);
    if (revoke) {
      const g = b.grants.find((x) => x._id === revoke[1])!;
      Object.assign(g, { state: 'revoked', revokedAt: NOW.toISOString() });
      return ok(route, { grant: g, alreadyRevoked: false });
    }
    return json(route, 404, { error: 404, message: 'Not found' });
  });
  return b;
}

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Mobile number').fill('9876543210');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Hello, Asha' })).toBeVisible();
}
const card = (page: Page) => page.getByRole('region', { name: 'Requests to see your records' });
const nothingStored = async (page: Page, ...words: string[]) => {
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + location.href);
  for (const w of words) expect(stored).not.toContain(w);
};

test('a waiting request on Home: Allow (a second step that says what it means); then the page shows who can see the records and the past request', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await expect(card(page)).toContainText('Dr Asha Mehta asks to see your prescriptions from other doctors and your lab reports.');
  await card(page).getByRole('button', { name: 'Allow' }).click();
  await expect(card(page).getByText('Dr Asha Mehta can then see these records while treating, for up to 12 months.', { exact: false })).toBeVisible();
  await card(page).getByRole('button', { name: 'Yes, allow' }).click();
  await expect(card(page).getByText('You allowed Dr Asha Mehta to see these records.')).toBeVisible();
  expect(b.calls.filter((c) => c.method === 'POST' && c.path.startsWith('/records-access')).map((c) => c.path)).toEqual([`/records-access/requests/${R1}/approve`]);
  await card(page).getByRole('link', { name: 'All requests, and who can see your records' }).click();
  await expect(page.getByRole('heading', { name: 'Your health records', level: 1 })).toBeVisible();
  await expect(page.getByText('No requests are waiting for your answer.')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Doctors who can see your records' })).toContainText('Dr Asha Mehta can see your records until');
  const history = page.getByRole('list', { name: 'Past requests' });
  await expect(history).toContainText('Dr Asha Mehta: your records');
  await expect(history).toContainText('Allowed on');
  await nothingStored(page, 'Asha Mehta', 'Cardiology');
});

test('the page under Profile: a family member’s request is denied; the history says so and nobody can see the records', async ({ page }) => {
  const b = await mockBackend(page, { requests: [request({ _id: R2, doctor: { id: DOC2, name: 'Dr. Ravi Kumar', specialization: null }, patient: { personKey: DEP, name: 'Meera' } })] });
  await signIn(page);
  await page.getByRole('link', { name: 'Profile' }).click();
  await page.getByRole('link', { name: 'Requests to see your records' }).click();
  const waiting = page.getByRole('list', { name: 'Requests to see your records' });
  await expect(waiting).toContainText('Dr. Ravi Kumar asks to see Meera’s prescriptions from other doctors and lab reports.');
  await waiting.getByRole('button', { name: 'Deny' }).click();
  await waiting.getByRole('button', { name: 'Yes, deny' }).click();
  await expect(page.getByText('You did not allow Dr. Ravi Kumar to see these records.')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Past requests' })).toContainText('Denied on');
  await expect(page.getByText('No doctor can see your records from other doctors and labs.')).toBeVisible();
  expect(b.calls.filter((c) => c.method === 'POST' && c.path.startsWith('/records-access')).map((c) => c.path)).toEqual([`/records-access/requests/${R2}/deny`]);
  await nothingStored(page, 'Meera', 'Ravi');
});

test('an ended request cannot be answered: said plainly, and the list read again moves it to the past', async ({ page }) => {
  const b = await mockBackend(page);
  b.expireOnAnswer = true;
  await signIn(page);
  await page.goto('/#/profile/records');
  const waiting = page.getByRole('list', { name: 'Requests to see your records' });
  await waiting.getByRole('button', { name: 'Allow' }).click();
  await waiting.getByRole('button', { name: 'Yes, allow' }).click();
  await expect(page.getByText('This request has ended, so it can no longer be answered.')).toBeVisible();
  await expect(page.getByText('No requests are waiting for your answer.')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Past requests' })).toContainText('Ended without an answer');
  expect(b.grants).toHaveLength(0);
});

test('who can see the records: Stop sharing (a second step), then nobody; nothing waiting shows no card on Home', async ({ page }) => {
  const b = await mockBackend(page, { requests: [request({ state: 'approved', decidedAt: NOW.toISOString() })],
    grants: [{ _id: 'f1'.repeat(12), state: 'active', via: 'app', at: NOW.toISOString(), expiresAt: '2027-11-25T04:30:00.000Z', revokedAt: null,
      doctor: { id: DOC, name: 'Asha Mehta', specialization: 'Cardiology' }, patient: { personKey: 'self', name: null } }] });
  await signIn(page);
  await expect(card(page)).toHaveCount(0);
  await page.goto('/#/profile/records');
  const grants = page.getByRole('list', { name: 'Doctors who can see your records' });
  await grants.getByRole('button', { name: 'Stop sharing' }).click();
  await grants.getByRole('button', { name: 'Yes, stop sharing' }).click();
  await expect(page.getByText('Stopped. Dr Asha Mehta can no longer see these records.')).toBeVisible();
  await expect(page.getByText('No doctor can see your records from other doctors and labs.')).toBeVisible();
  expect(b.calls.filter((c) => c.method === 'POST' && c.path.startsWith('/records-access')).map((c) => c.path)).toEqual([`/records-access/grants/${'f1'.repeat(12)}/revoke`]);
});

test('WQ28b: switched off on the server (503): said in its own words, and the request still waits', async ({ page }) => {
  const b = await mockBackend(page);
  b.off = true;
  await signIn(page);
  await card(page).getByRole('button', { name: 'Allow' }).click();
  await card(page).getByRole('button', { name: 'Yes, allow' }).click();
  await expect(card(page).getByText('Sharing records with doctors is not switched on yet.')).toBeVisible();
  await expect(card(page).getByText('Your answer may not have arrived', { exact: false })).toHaveCount(0);
  await expect(card(page).getByRole('button', { name: 'Allow' })).toBeVisible();
  expect(b.requests[0]!.state).toBe('pending');
});
