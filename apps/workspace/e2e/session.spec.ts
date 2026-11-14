import { expect, test, type Page, type Route } from '@playwright/test';

/** D4 web sessions in the staff workspace, against a mocked backend that models the cookie session. */
const ME = 'a1'.repeat(12);
const OTHER = 'b2'.repeat(12);

interface Backend {
  /** Whether the browser holds a live session cookie (set by a cookie sign-in, cleared by logout). */
  live: boolean;
  principal: string;
  refreshes: number;
  logouts: number;
  verifyBodies: Record<string, unknown>[];
  sessionHeaders: (string | null)[];
  /** The next list request answers 401 once (the access token expired). */
  expireNext: boolean;
  listCalls: number;
}

async function mockBackend(page: Page): Promise<Backend> {
  const b: Backend = { live: false, principal: ME, refreshes: 0, logouts: 0, verifyBodies: [], sessionHeaders: [], expireNext: false, listCalls: 0 };
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.context().route('**/api/v1/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace('/api/v1', '');
    if (path === '/auth/pharmacy/send') return json(route, 200, { success: true });
    if (path === '/auth/pharmacy/verify') {
      const body = req.postDataJSON() as Record<string, unknown>;
      b.verifyBodies.push(body);
      b.sessionHeaders.push(req.headers()['x-jansetu-session'] ?? null);
      if (body.session === 'cookie') b.live = true;
      return json(route, 200, { success: true, data: { token: 'access-1', expiresIn: 900, user: {} } });
    }
    if (path === '/auth/session/refresh') {
      b.refreshes++;
      b.sessionHeaders.push(req.headers()['x-jansetu-session'] ?? null);
      if (!b.live) return json(route, 401, { error: 401, code: 'SESSION_ENDED', message: 'Please sign in again' });
      return json(route, 200, { success: true, data: { token: `access-r${b.refreshes}`, expiresIn: 900, principal: { userId: b.principal, userType: 'pharmacy', sid: 's1' } } });
    }
    if (path === '/auth/session/logout') { b.logouts++; b.live = false; return json(route, 200, { success: true, data: { signedOut: true } }); }
    if (path === '/auth/profile') return json(route, 200, { success: true, data: { user: { _id: ME, name: 'Asha Medicals' }, userRole: 'pharmacy' } });
    if (req.method() === 'GET' && path === '/pharmacy-orders') {
      b.listCalls++;
      if (b.expireNext) { b.expireNext = false; return json(route, 401, { error: 401, code: 'TOKEN_EXPIRED', message: 'Token has expired' }); }
    }
    return json(route, 200, { success: true, data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 1 } });
  });
  return b;
}

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Mobile number').fill('9876543210');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

test('signing in asks for a cookie session; a reload keeps the staff member signed in', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  expect(backend.verifyBodies[0]).toMatchObject({ session: 'cookie', otp: '123456' });
  expect(backend.sessionHeaders[0]).toBe('1');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect(page.getByLabel('Mobile number')).toHaveCount(0);
  expect(backend.refreshes).toBeGreaterThanOrEqual(1);
});

test('signing out ends the server session; a reload then shows the sign-in screen', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByLabel('Mobile number')).toBeVisible();
  await expect.poll(() => backend.logouts).toBe(1);
  await page.reload();
  await expect(page.getByLabel('Mobile number')).toBeVisible();
});

test('signing out in one tab signs out the other tabs', async ({ page }) => {
  await mockBackend(page);
  await signIn(page);
  const second = await page.context().newPage();
  await second.goto('/');
  await expect(second.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await second.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText('You signed out in another tab.')).toBeVisible();
});

test('an expired access token is renewed once and the same request is sent again', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  backend.expireNext = true;
  const before = backend.listCalls;
  await page.goto('/#/pharmacy/orders');
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect.poll(() => backend.listCalls - before).toBeGreaterThanOrEqual(2);
  await expect(page.getByLabel('Mobile number')).toHaveCount(0);
});

test('a renewed session that belongs to someone else is not used: this tab signs out', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  backend.principal = OTHER; // another person signed in on this browser; the shared cookie is theirs now
  backend.expireNext = true;
  await page.goto('/#/pharmacy/orders');
  await expect(page.getByText('Someone else signed in to the workspace in this browser. Please sign in again.')).toBeVisible();
});
