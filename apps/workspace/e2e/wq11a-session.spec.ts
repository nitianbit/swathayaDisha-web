import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * WQ11a: the review's workspace proof as journeys (mocked backend modelled on session.spec.ts: cookie session = `live`).
 * A sign-out that never reached the server, a renewal without an answer, a sign-in whose profile check failed, and the
 * sign-in screen's announcements and focus.
 */
const ME = 'a1'.repeat(12);

interface Backend {
  live: boolean; calls: string[]; logoutAttempts: number; logoutFails: boolean; refreshes: number; refreshFails: boolean;
  profileFailsOnce: boolean; expireNext: boolean; logoutHtml: boolean;
}

async function mockBackend(page: Page): Promise<Backend> {
  const b: Backend = { live: false, calls: [], logoutAttempts: 0, logoutFails: false, refreshes: 0, refreshFails: false, profileFailsOnce: false, expireNext: false, logoutHtml: false };
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.context().route('**/api/v1/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace('/api/v1', '');
    b.calls.push(path);
    if (path === '/auth/pharmacy/send') return json(route, 200, { success: true });
    if (path === '/auth/pharmacy/verify') {
      if ((req.postDataJSON() as { session?: string }).session === 'cookie') b.live = true;
      return json(route, 200, { success: true, data: { token: 'access-1', expiresIn: 900, user: {} } });
    }
    if (path === '/auth/session/refresh') {
      b.refreshes++;
      if (b.refreshFails) return route.abort('internetdisconnected');
      if (!b.live) return json(route, 401, { error: 401, code: 'SESSION_ENDED', message: 'Please sign in again' });
      return json(route, 200, { success: true, data: { token: `access-r${b.refreshes}`, expiresIn: 900, principal: { userId: ME, userType: 'pharmacy', sid: 's1' } } });
    }
    if (path === '/auth/session/logout') {
      b.logoutAttempts++;
      if (b.logoutFails) return route.abort('internetdisconnected');
      if (b.logoutHtml) return route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>Jansetu</body></html>' });
      b.live = false;
      return json(route, 200, { success: true, data: { signedOut: true } });
    }
    if (path === '/auth/profile') {
      if (b.profileFailsOnce) { b.profileFailsOnce = false; return json(route, 503, { error: 503, message: 'Service unavailable' }); }
      return json(route, 200, { success: true, data: { user: { _id: ME, name: 'Asha Medicals' }, userRole: 'pharmacy' } });
    }
    if (req.method() === 'GET' && path === '/pharmacy-orders' && b.expireNext) {
      b.expireNext = false;
      return json(route, 401, { error: 401, code: 'TOKEN_EXPIRED', message: 'Token has expired' });
    }
    return json(route, 200, { success: true, data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 1 } });
  });
  return b;
}

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Mobile number or email').fill('9876543210');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
}
const SIGNED_OUT_HERE = 'You are signed out on this device.';

test('a sign-out whose logout never reaches the server is said and retried; a reload does not sign the previous person back in', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await expect(page.locator('.ws-user-name')).toHaveText('Asha Medicals');
  b.logoutFails = true;
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByLabel('Mobile number or email')).toBeVisible();
  await expect(page.getByText(SIGNED_OUT_HERE)).toBeVisible();
  await expect.poll(() => b.logoutAttempts, { timeout: 8000 }).toBeGreaterThanOrEqual(3);
  const refreshesBefore = b.refreshes;
  await page.reload();
  await expect(page.getByLabel('Mobile number or email')).toBeVisible();
  await expect(page.getByText(SIGNED_OUT_HERE)).toBeVisible();
  await expect(page.locator('.ws-user-name')).toHaveCount(0);
  expect(b.refreshes).toBe(refreshesBefore);
  b.logoutFails = false;
  await expect.poll(() => b.live, { timeout: 15_000 }).toBe(false);
  await expect(page.getByText(SIGNED_OUT_HERE)).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel('Mobile number or email')).toBeVisible();
  await expect(page.locator('.ws-user-name')).toHaveCount(0);
});

test('closing the tab right after a failed sign-out: the next start ends the session before any refresh', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await expect(page.locator('.ws-user-name')).toHaveText('Asha Medicals');
  b.logoutFails = true;
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect.poll(() => b.logoutAttempts).toBeGreaterThanOrEqual(1);
  b.logoutFails = false;
  const from = b.calls.length;
  await page.reload();
  await expect(page.getByLabel('Mobile number or email')).toBeVisible();
  expect(b.calls.slice(from).filter((p) => p.startsWith('/auth/session/'))[0]).toBe('/auth/session/logout');
  expect(b.live).toBe(false);
});

test('a renewal that fails on the network keeps the staff member signed in and says "Reconnecting…"', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await expect(page.locator('.ws-user-name')).toHaveText('Asha Medicals');
  b.expireNext = true;
  b.refreshFails = true;
  await page.goto('/#/pharmacy/orders');
  await expect(page.getByText('Reconnecting…')).toBeVisible();
  await expect(page.getByText('Your session has ended. Please sign in again.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  b.refreshFails = false;
  await expect(page.getByText('Reconnecting…')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  expect(b.logoutAttempts).toBe(0);
});

test('a sign-in whose profile check fails after the code was accepted ends the new session', async ({ page }) => {
  const b = await mockBackend(page);
  b.profileFailsOnce = true;
  await signIn(page);
  await expect(page.getByRole('alert').filter({ hasText: 'Service unavailable' })).toBeVisible();
  await expect.poll(() => b.logoutAttempts).toBeGreaterThanOrEqual(1);
  expect(b.live).toBe(false);
  await page.reload();
  await expect(page.getByLabel('Mobile number or email')).toBeVisible();
});

test('sign-in: errors are announced, focus moves to the field, and the code field names where the code went', async ({ page }) => {
  await mockBackend(page);
  await page.goto('/');
  const id = page.getByLabel('Mobile number or email');
  await expect(id).toHaveAttribute('autocomplete', 'off');
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByRole('alert')).toHaveText('Enter a 10-digit mobile number or an email address.');
  await expect(id).toBeFocused();
  await id.fill('9876543210');
  await page.getByRole('button', { name: 'Send code' }).click();
  const code = page.getByLabel('6-digit code');
  await expect(code).toBeFocused();
  const ids = (await code.getAttribute('aria-describedby'))!.split(' ');
  expect(await page.evaluate((x) => x.map((i) => document.getElementById(i)?.textContent ?? '').join(' '), ids))
    .toContain('We sent a 6-digit code to your phone ••••••3210.');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('Enter the 6-digit code.');
  await expect(code).toBeFocused();
  await page.getByRole('button', { name: 'Change number or email' }).click();
  await expect(id).toBeFocused();
});

test('opening the workspace while the first refresh gets no answer says "Reconnecting…" and resumes; "Sign in again" leaves it', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await expect(page.locator('.ws-user-name')).toHaveText('Asha Medicals');
  b.refreshFails = true;
  await page.reload();
  await expect(page.getByText(/^Reconnecting…/)).toBeVisible();
  await expect(page.getByLabel('Mobile number or email')).toHaveCount(0);
  b.refreshFails = false;
  await expect(page.locator('.ws-user-name')).toHaveText('Asha Medicals', { timeout: 15_000 });
  b.refreshFails = true;
  await page.reload();
  await page.getByRole('button', { name: 'Sign in again' }).click();
  await expect(page.getByLabel('Mobile number or email')).toBeVisible();
});

test('a logout answered 200 by something that is not the backend keeps the sign-out record: no reload resumes it', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await expect(page.locator('.ws-user-name')).toHaveText('Asha Medicals');
  b.logoutHtml = true;
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText(SIGNED_OUT_HERE)).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Mobile number or email')).toBeVisible();
  await expect(page.locator('.ws-user-name')).toHaveCount(0);
  expect(b.live).toBe(true);
  b.logoutHtml = false;
  await expect.poll(() => b.live, { timeout: 15_000 }).toBe(false);
});
