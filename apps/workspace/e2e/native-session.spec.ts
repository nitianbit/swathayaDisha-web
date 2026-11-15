import { expect, test, type Page, type Route } from '@playwright/test';

/** N1 in the staff workspace inside the phone shell (fake secure store backed by test-only sessionStorage). */
const ME = 'a1'.repeat(12);

const FAKE_SECURE_STORE = `
(() => {
  const fail = () => JSON.parse(sessionStorage.getItem('__fake_fail__') || '{}');
  window.JansetuNative = { secureStore: {
    get: async (k) => { if (fail().get) throw new Error('keychain locked'); return sessionStorage.getItem('__fake_keychain__' + k); },
    set: async (k, v) => { sessionStorage.setItem('__fake_keychain__' + k, v); },
    remove: async (k) => { if (fail().remove) throw new Error('keychain busy'); sessionStorage.removeItem('__fake_keychain__' + k); },
  } };
})();`;

interface Backend { calls: { path: string; body: Record<string, unknown>; auth: string | null }[]; current: string | null; gen: number }

async function mockBackend(page: Page): Promise<Backend> {
  const b: Backend = { calls: [], current: null, gen: 0 };
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.addInitScript(FAKE_SECURE_STORE);
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace('/api/v1', '');
    const body = (req.method() === 'POST' ? req.postDataJSON() : {}) as Record<string, unknown>;
    b.calls.push({ path, body, auth: req.headers()['authorization'] ?? null });
    if (path === '/auth/pharmacy/send') return json(route, 200, { success: true });
    if (path === '/auth/pharmacy/verify') {
      b.gen = 1; b.current = 'rt-1';
      return json(route, 200, { success: true, data: { token: 'access-1', expiresIn: 900, refreshToken: 'rt-1', refreshExpiresIn: 43200, user: {} } });
    }
    if (path === '/auth/session/native/refresh') {
      if (body.refreshToken !== b.current) return json(route, 401, { error: 401, code: 'SESSION_ENDED', message: 'Please sign in again' });
      b.gen += 1; b.current = `rt-${b.gen}`;
      return json(route, 200, { success: true, data: { token: `access-${b.gen}`, expiresIn: 900, refreshToken: b.current, refreshExpiresIn: 43200,
        principal: { userId: ME, userType: 'pharmacy', sid: 's1' } } });
    }
    if (path === '/auth/session/native/logout') { b.current = null; return json(route, 200, { success: true, data: { signedOut: true } }); }
    if (path === '/auth/profile') return json(route, 200, { success: true, data: { user: { _id: ME, name: 'Asha Medicals' }, userRole: 'pharmacy' } });
    return json(route, 200, { success: true, data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 1 } });
  });
  return b;
}

const stored = (page: Page) => page.evaluate(() => sessionStorage.getItem('__fake_keychain__jansetu.refresh.workspace'));
const failStore = (page: Page, f: { get?: boolean; remove?: boolean }) =>
  page.evaluate((x) => sessionStorage.setItem('__fake_fail__', JSON.stringify(x)), f);

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Mobile number').fill('9876543210');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

test('staff on the phone: native sign-in for the workspace app; reopening resumes from the stored token', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  expect(b.calls.find((c) => c.path === '/auth/pharmacy/verify')!.body).toMatchObject({ session: 'native', app: 'workspace' });
  expect(await stored(page)).toBe('rt-1');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  expect(await stored(page)).toBe('rt-2');
});

test('sign-out with an unreadable store still ends the server session with the access token', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await failStore(page, { get: true });
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByLabel('Mobile number')).toBeVisible();
  await expect.poll(() => b.calls.filter((c) => c.path === '/auth/session/native/logout').length).toBe(1);
  expect(b.calls.find((c) => c.path === '/auth/session/native/logout')!.auth).toBe('Bearer access-1');
  await failStore(page, {});
  await page.reload();
  await expect(page.getByLabel('Mobile number')).toBeVisible();
  expect(await stored(page)).toBeNull();
});

test('a token that could not be removed is never resumed; the next start clears it', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await failStore(page, { remove: true });
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText('could not clear its saved sign-in yet', { exact: false })).toBeVisible();
  b.current = 'rt-1'; // as if the server had not been reached
  await page.reload();
  await expect(page.getByLabel('Mobile number')).toBeVisible();
  expect(b.calls.some((c) => c.path === '/auth/session/native/refresh')).toBe(false);
  await failStore(page, {});
  await page.reload();
  await expect(page.getByLabel('Mobile number')).toBeVisible();
  await expect.poll(() => stored(page)).toBeNull();
});
