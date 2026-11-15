import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * N1: the customer app inside the phone shell. The shell's secure store (Keychain/Keystore) is faked here; the fake
 * keeps its data in the test browser's sessionStorage only so that it survives a reload, like the real store does.
 * The app itself never touches web storage for tokens.
 */
const ME = 'c1'.repeat(12);

const FAKE_SECURE_STORE = `
window.JansetuNative = { secureStore: {
  get: async (k) => sessionStorage.getItem('__fake_keychain__' + k),
  set: async (k, v) => { sessionStorage.setItem('__fake_keychain__' + k, v); },
  remove: async (k) => { sessionStorage.removeItem('__fake_keychain__' + k); },
} };`;

interface Backend {
  calls: { path: string; body: Record<string, unknown>; native: string | null; auth: string | null; cookie: string | null }[];
  current: string | null;
  gen: number;
  revoked: boolean;
}

async function mockBackend(page: Page): Promise<Backend> {
  const b: Backend = { calls: [], current: null, gen: 0, revoked: false };
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.addInitScript(FAKE_SECURE_STORE);
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace('/api/v1', '');
    const body = (req.method() === 'POST' ? req.postDataJSON() : {}) as Record<string, unknown>;
    const h = req.headers();
    b.calls.push({ path, body, native: h['x-jansetu-native'] ?? null, auth: h['authorization'] ?? null, cookie: h['cookie'] ?? null });
    if (path === '/auth/user/send') return json(route, 200, { success: true });
    if (path === '/auth/user/verify') {
      b.gen = 1; b.current = `rt-${b.gen}`; b.revoked = false;
      return json(route, 200, { success: true, data: { token: 'access-1', expiresIn: 900, refreshToken: b.current, refreshExpiresIn: 2592000, user: {} } });
    }
    if (path === '/auth/session/native/refresh') {
      if (b.revoked || body.refreshToken !== b.current) return json(route, 401, { error: 401, code: 'SESSION_ENDED', message: 'Please sign in again' });
      b.gen += 1; b.current = `rt-${b.gen}`;
      return json(route, 200, { success: true, data: { token: `access-${b.gen}`, expiresIn: 900, refreshToken: b.current, refreshExpiresIn: 2592000,
        principal: { userId: ME, userType: 'user', sid: 's1' } } });
    }
    if (path === '/auth/session/native/logout') { b.revoked = true; return json(route, 200, { success: true, data: { signedOut: true } }); }
    if (path === '/auth/session/refresh') return json(route, 500, { error: 500, message: 'the phone app must not use cookie sessions' });
    if (!h['authorization']?.startsWith('Bearer access-')) return json(route, 401, { error: 401, message: 'Please sign in again' });
    if (path === '/auth/profile') return json(route, 200, { success: true, data: { user: { _id: ME, name: 'Asha Rao', email: 'a@x.in', gender: 'Female', dateOfBirth: '19900101' }, userRole: 'user' } });
    if (path === `/wallet/user/${ME}`) return json(route, 200, { success: true, data: { _id: 'w', userId: ME, balance: 0, isActive: true } });
    return json(route, 200, { success: true, data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 1 } });
  });
  return b;
}

const stored = (page: Page) => page.evaluate(() => sessionStorage.getItem('__fake_keychain__jansetu.refresh.customer'));

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Mobile number').fill('9876543210');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: /^Hello/ })).toBeVisible();
}

test('in the phone app, sign-in asks for a native session and keeps the refresh token in the secure store only', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  const verify = b.calls.find((c) => c.path === '/auth/user/verify')!;
  expect(verify.body).toMatchObject({ session: 'native', app: 'customer', otp: '123456' });
  expect(verify.body.previousRefreshToken).toBeUndefined();
  expect(verify.native).toBe('1');
  expect(await stored(page)).toBe('rt-1');
  // Nothing else in web storage carries it.
  const leaked = await page.evaluate(() => {
    const all: string[] = [];
    for (let i = 0; i < localStorage.length; i++) all.push(localStorage.getItem(localStorage.key(i)!) ?? '');
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i)!;
      if (!k.startsWith('__fake_keychain__')) all.push(sessionStorage.getItem(k) ?? '');
    }
    return all.join('|');
  });
  expect(leaked).not.toContain('rt-');
  expect(b.calls.every((c) => c.cookie === null || !c.cookie.includes('rt-'))).toBe(true);
});

test('reopening the app resumes from the stored token and stores the rotated one', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: /^Hello/ })).toBeVisible();
  const refresh = b.calls.find((c) => c.path === '/auth/session/native/refresh')!;
  expect(refresh.body).toEqual({ app: 'customer', refreshToken: 'rt-1' });
  expect(refresh.native).toBe('1');
  expect(await stored(page)).toBe('rt-2');
  expect(b.calls.some((c) => c.path === '/auth/session/refresh')).toBe(false);
});

test('a refused refresh clears the stored token and shows the sign-in screen', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  b.revoked = true; // e.g. signed out everywhere from another device
  await page.reload();
  await expect(page.getByLabel('Mobile number')).toBeVisible();
  expect(await stored(page)).toBeNull();
});

test('signing out removes the stored token and ends the session on the server', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Profile', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByLabel('Mobile number')).toBeVisible();
  await expect.poll(() => b.calls.filter((c) => c.path === '/auth/session/native/logout').length).toBe(1);
  const logout = b.calls.find((c) => c.path === '/auth/session/native/logout')!;
  expect(logout.body).toEqual({ app: 'customer', refreshToken: 'rt-1' });
  expect(logout.auth).toBe('Bearer access-1');
  expect(await stored(page)).toBeNull();
});

test('signing in again while a token is stored names it, so the server ends that session', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  b.revoked = true; // the stored token no longer refreshes, but it is still in the store
  await page.evaluate(() => sessionStorage.setItem('__fake_keychain__jansetu.refresh.customer', 'rt-old'));
  await page.reload();
  await expect(page.getByLabel('Mobile number')).toBeVisible();
  await page.evaluate(() => sessionStorage.setItem('__fake_keychain__jansetu.refresh.customer', 'rt-stale'));
  await page.getByLabel('Mobile number').fill('9876543210');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: /^Hello/ })).toBeVisible();
  const last = b.calls.filter((c) => c.path === '/auth/user/verify').at(-1)!;
  expect(last.body.previousRefreshToken).toBe('rt-stale');
  expect(await stored(page)).toBe('rt-1');
});
