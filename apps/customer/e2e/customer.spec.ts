import { expect, test, type Page, type Route } from '@playwright/test';

const ME = 'c1'.repeat(12);
const B_PAID = 'b1'.repeat(12);
const B_SOON = 'b2'.repeat(12);
const X_LAB = 'e1'.repeat(12);
const X_HL = 'e2'.repeat(12);
const HOUR = 3600_000;

/** YYYYMMDD and "HH:MM" in IST for an instant `hours` from now (rounded to the minute). */
function istAt(hours: number) {
  const ist = new Date(Date.now() + hours * HOUR + (5 * 60 + 30) * 60_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return { bookingDate: `${ist.getUTCFullYear()}${p(ist.getUTCMonth() + 1)}${p(ist.getUTCDate())}`, bookingTime: `${p(ist.getUTCHours())}:${p(ist.getUTCMinutes())}` };
}

interface Backend { calls: { method: string; path: string; query: string; body: unknown }[]; profile: Record<string, unknown>; revoked: boolean }

async function mockBackend(page: Page): Promise<Backend> {
  // Avoid Monday appointments so the 24-hour rule is the one exercised.
  let far = istAt(24 * 5);
  if (new Date(Date.now() + 24 * 5 * HOUR + 5.5 * HOUR).getUTCDay() === 1) far = istAt(24 * 6);
  const state: Backend = { calls: [], revoked: false, profile: { _id: ME, phone: '9876543210', name: '', email: null } };
  const bookings: Record<string, Record<string, unknown>> = {
    [B_PAID]: { _id: B_PAID, bookingType: 'consultation', doctorName: 'Dr. Iyer', ...far, price: 500, status: 'confirmed', paymentStatus: 'paid' },
    [B_SOON]: { _id: B_SOON, bookingType: 'package', packageName: 'Full body check', ...istAt(5), price: 1200, status: 'confirmed', paymentStatus: 'paid' },
  };
  const ext: Record<string, Record<string, unknown>> = {
    [X_LAB]: { _id: X_LAB, integration: 'labstack', packageNames: ['Thyroid profile'], ...istAt(24 * 3), patientName: 'Asha', price: 400, paymentStatus: 'paid', status: 'confirmed' },
    [X_HL]: { _id: X_HL, integration: 'healthians', testNames: ['HbA1c'], ...istAt(24 * 4), patientName: 'Ravi', price: 300, paymentStatus: 'paid', status: 'confirmed' },
  };
  const deps: Record<string, unknown>[] = [];
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const page1 = (route: Route, items: unknown[]) => json(route, 200, { success: true, data: items, pagination: { page: 1, limit: 20, total: items.length, totalPages: 1 } });

  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1', '');
    const body = ['POST', 'PUT'].includes(req.method()) ? req.postDataJSON() : null;
    state.calls.push({ method: req.method(), path, query: url.search, body });
    if (path === '/auth/user/send') return json(route, 200, { success: true, message: 'OTP sent successfully' });
    if (path === '/auth/user/verify') {
      if ((body as { otp: string }).otp !== '123456') return json(route, 400, { error: 400, code: 'INVALID_OTP', message: 'Invalid OTP' });
      return json(route, 200, { success: true, data: { token: 't-cust', user: { _id: ME, userType: 'user' } } });
    }
    if (state.revoked || req.headers().authorization !== 'Bearer t-cust') return json(route, 401, { error: 401, code: 'UNAUTHORIZED', message: 'Please sign in again' });
    if (path === '/auth/profile') return json(route, 200, { success: true, data: { user: state.profile, userRole: 'user' } });
    if (path === '/auth/sessions/revoke') { state.revoked = true; return json(route, 200, { success: true, data: { signedOutEverywhere: true } }); }
    if (path === `/users/${ME}` && req.method() === 'PUT') {
      state.profile = { ...state.profile, ...(body as object) };
      return json(route, 200, { success: true, data: { user: state.profile } });
    }
    if (path === `/wallet/user/${ME}`) return json(route, 200, { success: true, data: { _id: 'w', userId: ME, balance: 250, isActive: true } });
    if (path === `/wallet/user/${ME}/transactions`) {
      return page1(route, [{ _id: 't1', transactionType: 'refund', amount: 250, balanceAfter: 250, status: 'completed', description: 'Refund for a cancelled booking', createdAt: '2026-11-10T06:00:00.000Z' }]);
    }
    if (path === '/dependents' && req.method() === 'GET') return page1(route, deps);
    if (path === '/dependents' && req.method() === 'POST') {
      const d = { _id: String(deps.length + 1).padStart(24, 'd'), isActive: true, ...(body as object) };
      deps.push(d);
      return json(route, 201, { success: true, data: d });
    }
    if (path === '/bookings') return page1(route, Object.values(bookings));
    const b = /^\/bookings\/(\w{24})(\/cancel)?$/.exec(path);
    if (b) {
      const bk = bookings[b[1]!]!;
      if (b[2]) { bk.status = 'cancelled'; bk.paymentStatus = 'refunded'; bk.cancellationReason = (body as { cancellationReason?: string }).cancellationReason ?? 'Cancelled by user'; }
      return json(route, 200, { success: true, data: bk });
    }
    if (path === '/external-bookings/bookings') {
      const integration = url.searchParams.get('integration');
      return page1(route, Object.values(ext).filter((e) => e.integration === integration));
    }
    const x = /^\/external-bookings\/bookings\/(\w{24})(\/cancel)?$/.exec(path);
    if (x) {
      const e = ext[x[1]!]!;
      if (x[2]) { e.status = 'cancellation_requested'; return json(route, 202, { success: true, data: e }); }
      return json(route, 200, { success: true, data: e });
    }
    return json(route, 404, { error: 404, message: 'Not found' });
  });
  return state;
}

/** The bottom tab bar (the home tiles have similar names). */
const tab = (page: Page, name: string) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true });

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Mobile number').fill('9876543210');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('000000');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('Invalid OTP');
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: /^Hello/ })).toBeVisible();
}

test('sign in, see the wallet and finish the profile; an email can only be added', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await expect(page.getByText('Complete your profile so we can book for you.')).toBeVisible();
  await expect(page.getByRole('link', { name: /Wallet ₹250/ })).toBeVisible();
  await page.getByRole('link', { name: 'Complete profile' }).click();
  await page.getByLabel('Full name').fill('Asha Rao');
  await page.getByLabel('Email').fill('asha@example.com');
  await page.getByLabel('Female').check();
  await page.getByLabel('Date of birth').fill('1990-05-17');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  const put = backend.calls.find((c) => c.method === 'PUT')!;
  expect(put.body).toEqual({ name: 'Asha Rao', email: 'asha@example.com', gender: 'Female', dateOfBirth: '19900517' });
  // Now set: shown read-only, never sent again.
  await expect(page.getByLabel('Email')).toHaveCount(0);
  await expect(page.getByText('To change it, contact support.')).toBeVisible();
  await page.getByLabel('Full name').fill('Asha R. Rao');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  expect(backend.calls.filter((c) => c.method === 'PUT').at(-1)!.body).toEqual({ name: 'Asha R. Rao' });
  await tab(page, 'Home').click();
  await expect(page.getByRole('heading', { name: 'Hello, Asha' })).toBeVisible();
});

test('add a family member', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await page.getByRole('link', { name: 'Family members' }).click();
  await expect(page.getByText('No family members yet')).toBeVisible();
  await page.getByRole('button', { name: 'Add a family member' }).click();
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Enter their name.')).toBeVisible();
  await page.getByLabel('Name').fill('Kamala Rao');
  await page.getByLabel('Relationship').selectOption('Mother');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Kamala Rao')).toBeVisible();
  expect(backend.calls.find((c) => c.method === 'POST' && c.path === '/dependents')!.body).toEqual({ name: 'Kamala Rao', relationship: 'Mother', userId: ME });
});

test('bookings list both providers and always paginates', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await tab(page, 'Bookings').click();
  await expect(page.getByText('Dr. Iyer')).toBeVisible();
  await expect(page.getByText('Thyroid profile')).toBeVisible();
  await expect(page.getByText('HbA1c')).toBeVisible();
  const ext = backend.calls.filter((c) => c.path === '/external-bookings/bookings').map((c) => new URLSearchParams(c.query));
  expect(ext.map((q) => q.get('integration')).sort()).toEqual(['healthians', 'labstack']);
  for (const q of [...ext, new URLSearchParams(backend.calls.find((c) => c.path === '/bookings')!.query)]) {
    expect(q.get('page')).toBe('1');
    expect(q.get('limit')).toBe('20');
  }
});

test('a paid booking can be cancelled before the window closes; the refund goes to the wallet', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await tab(page, 'Bookings').click();
  await page.getByRole('link', { name: /Dr\. Iyer/ }).click();
  await expect(page.getByText(/You can cancel until/)).toBeVisible();
  await page.getByRole('button', { name: 'Cancel this booking' }).click();
  await expect(page.getByText(/goes back to your Jansetu wallet/)).toBeVisible();
  await page.getByLabel('Reason (optional)').fill('Feeling better');
  await page.getByRole('button', { name: 'Yes, cancel it' }).click();
  await expect(page.getByText('Cancelled', { exact: true })).toBeVisible();
  expect(backend.calls.find((c) => c.path === `/bookings/${B_PAID}/cancel`)!.body).toEqual({ cancellationReason: 'Feeling better' });
});

test('inside 24 hours a paid booking cannot be cancelled, and the app says why', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await tab(page, 'Bookings').click();
  await page.getByRole('link', { name: /Full body check/ }).click();
  await expect(page.getByText(/Paid bookings can be cancelled until 24 hours before the appointment/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel this booking' })).toHaveCount(0);
  expect(backend.calls.filter((c) => c.path.endsWith('/cancel'))).toHaveLength(0);
});

test('a lab test cancellation waits for the lab; the app explains the refund comes after', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await tab(page, 'Bookings').click();
  await page.getByRole('link', { name: /HbA1c/ }).click();
  await page.getByRole('button', { name: 'Cancel this test' }).click();
  await page.getByRole('button', { name: 'Yes, cancel it' }).click();
  await expect(page.getByText(/Your cancellation is with the lab/)).toBeVisible();
  await expect(page.getByText('Cancelling', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel this test' })).toHaveCount(0);
  expect(backend.calls.filter((c) => c.path === `/external-bookings/bookings/${X_HL}/cancel`)).toHaveLength(1);
});

test('wallet history', async ({ page }) => {
  await mockBackend(page);
  await signIn(page);
  await tab(page, 'Wallet').click();
  await expect(page.getByText('₹250.00').first()).toBeVisible();
  await expect(page.getByText('Refund for a cancelled booking')).toBeVisible();
});

test('sign out on all devices ends the session; a reload also signs out (memory-only token)', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  backend.revoked = false;
  await page.getByLabel('Mobile number').fill('9876543210');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await tab(page, 'Profile').click();
  await page.getByRole('button', { name: 'Sign out on all devices' }).click();
  await page.getByRole('button', { name: 'Sign out everywhere' }).click();
  await expect(page.getByText('You have been signed out on all your devices.')).toBeVisible();
  expect(backend.calls.some((c) => c.path === '/auth/sessions/revoke')).toBe(true);
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(stored).not.toContain('t-cust');
});
