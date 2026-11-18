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

interface Backend {
  calls: { method: string; path: string; query: string; body: unknown }[]; profile: Record<string, unknown>; revoked: boolean;
  bookings: Record<string, Record<string, unknown>>; ext: Record<string, Record<string, unknown>>;
  deps: Record<string, unknown>[]; tx: Record<string, unknown>[];
}

async function mockBackend(page: Page): Promise<Backend> {
  // Avoid Monday appointments so the 24-hour rule is the one exercised.
  let far = istAt(24 * 5);
  if (new Date(Date.now() + 24 * 5 * HOUR + 5.5 * HOUR).getUTCDay() === 1) far = istAt(24 * 6);
  const bookings: Record<string, Record<string, unknown>> = {
    [B_PAID]: { _id: B_PAID, bookingType: 'consultation', doctorName: 'Dr. Iyer', ...far, price: 500, status: 'confirmed', paymentStatus: 'paid' },
    [B_SOON]: { _id: B_SOON, bookingType: 'package', packageName: 'Full body check', ...istAt(5), price: 1200, status: 'confirmed', paymentStatus: 'paid' },
  };
  const ext: Record<string, Record<string, unknown>> = {
    [X_LAB]: { _id: X_LAB, integration: 'labstack', packageNames: ['Thyroid profile'], ...istAt(24 * 3), patientName: 'Asha', price: 400, paymentStatus: 'paid', status: 'confirmed' },
    [X_HL]: { _id: X_HL, integration: 'healthians', testNames: ['HbA1c'], ...istAt(24 * 4), patientName: 'Ravi', price: 300, paymentStatus: 'paid', status: 'confirmed' },
  };
  const state: Backend = { calls: [], revoked: false, profile: { _id: ME, phone: '9876543210', name: '', email: null }, bookings, ext,
    deps: [], tx: [{ _id: 't1', transactionType: 'refund', amount: 250, balanceAfter: 250, status: 'completed', description: 'Refund for a cancelled booking', createdAt: '2026-11-10T06:00:00.000Z' }] };
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  /** Pages like the backend: by page and limit from the query. */
  const paged = (route: Route, url: URL, all: unknown[]) => {
    const page = Number(url.searchParams.get('page') ?? 1);
    const limit = Number(url.searchParams.get('limit') ?? 20);
    return json(route, 200, { success: true, data: all.slice((page - 1) * limit, page * limit),
      pagination: { page, limit, total: all.length, totalPages: Math.max(1, Math.ceil(all.length / limit)) } });
  };

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
    if (path === `/wallet/user/${ME}/transactions`) return paged(route, url, state.tx);
    if (path === '/dependents' && req.method() === 'GET') {
      const active = url.searchParams.get('isActive');
      return paged(route, url, state.deps.filter((d) => active === null || String((d as { isActive: boolean }).isActive) === active));
    }
    if (path === '/dependents' && req.method() === 'POST') {
      const d = { _id: String(state.deps.length + 1).padStart(24, 'd'), isActive: true, ...(body as object) };
      state.deps.push(d);
      return json(route, 201, { success: true, data: d });
    }
    if (path === '/bookings') return paged(route, url, Object.values(bookings));
    const b = /^\/bookings\/(\w{24})(\/cancel)?$/.exec(path);
    if (b) {
      const bk = bookings[b[1]!]!;
      if (b[2]) { bk.status = 'cancelled'; bk.paymentStatus = 'refunded'; bk.cancellationReason = (body as { cancellationReason?: string }).cancellationReason ?? 'Cancelled by user'; }
      return json(route, 200, { success: true, data: bk });
    }
    if (path === '/external-bookings/bookings') {
      const integration = url.searchParams.get('integration');
      return paged(route, url, Object.values(ext).filter((e) => e.integration === integration));
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
  // 5 hours from now may fall on a Monday (48-hour rule): either way the window has closed.
  await expect(page.getByText(/Paid bookings can be cancelled until (24|48) hours before the appointment/)).toBeVisible();
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

test('wallet history pages to the end, past 100 transactions', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.tx = Array.from({ length: 130 }, (_, i) => ({ _id: `tx${i}`, transactionType: 'debit', amount: i + 1, balanceAfter: 0,
    status: 'completed', description: `Payment ${i + 1}`, createdAt: new Date(Date.UTC(2026, 10, 1, 0, 130 - i)).toISOString() }));
  await signIn(page);
  await tab(page, 'Wallet').click();
  await expect(page.getByText('Showing 20 of 130.')).toBeVisible();
  for (let shown = 40; shown <= 120; shown += 20) {
    await page.getByRole('button', { name: 'Show older' }).click();
    await expect(page.getByText(`Showing ${shown} of 130.`)).toBeVisible();
  }
  await page.getByRole('button', { name: 'Show older' }).click();
  await expect(page.getByText('Showing 130 of 130.')).toBeVisible();
  await expect(page.getByText('Payment 130', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show older' })).toHaveCount(0);
});

test('bookings page to the end per list and per provider', async ({ page }) => {
  const backend = await mockBackend(page);
  for (let i = 0; i < 105; i++) {
    backend.bookings['f' + String(i).padStart(23, '0')] = { _id: 'f' + String(i).padStart(23, '0'), bookingType: 'consultation', doctorName: `Dr. ${i}`,
      bookingDate: '20250101', bookingTime: '10:00', price: 100, status: 'completed', paymentStatus: 'paid' };
  }
  for (let i = 0; i < 25; i++) {
    backend.ext['e' + String(i).padStart(23, '0')] = { _id: 'e' + String(i).padStart(23, '0'), integration: 'healthians', testNames: [`Test H${i}`],
      bookingDate: '20250101', bookingTime: '08:00', price: 50, paymentStatus: 'paid', status: 'completed' };
  }
  await signIn(page);
  await tab(page, 'Bookings').click();
  const ord = page.getByRole('region', { name: 'Doctors and health packages' });
  const lab = page.getByRole('region', { name: 'Lab tests' });
  for (const shown of [40, 60, 80, 100, 107]) {
    await ord.getByRole('button', { name: 'Show more' }).click();
    await expect(ord.getByText(`Showing ${shown} of 107.`)).toBeVisible();
  }
  await expect(ord.getByRole('button', { name: 'Show more' })).toHaveCount(0);
  await expect(lab.getByText('Showing 21 of 27.')).toBeVisible(); // 20 Healthians + 1 LabStack loaded; 6 more Healthians
  await lab.getByRole('button', { name: 'Show more' }).click();
  await expect(lab.getByText('Showing 27 of 27.')).toBeVisible();
  await expect(lab.getByRole('button', { name: 'Show more' })).toHaveCount(0);
});

test('family shows active members even when many archived ones exist', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.deps = Array.from({ length: 120 }, (_, i) => ({ _id: 'd' + String(i).padStart(23, '0'), name: `Archived ${i}`, relationship: 'Other', isActive: false }));
  await signIn(page);
  await page.getByRole('link', { name: 'Family members' }).click();
  await expect(page.getByText('No family members yet')).toBeVisible();
  await page.getByRole('button', { name: 'Add a family member' }).click();
  await page.getByLabel('Name').fill('Kamala Rao');
  await page.getByLabel('Relationship').selectOption('Mother');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Kamala Rao')).toBeVisible();
  await expect(page.getByText(/Archived/)).toHaveCount(0);
  const q = new URLSearchParams(backend.calls.filter((c) => c.path === '/dependents' && c.method === 'GET').at(-1)!.query);
  expect(q.get('isActive')).toBe('true');
});

test('an unpaid booking that has already started can still be cancelled (no time rule without payment)', async ({ page }) => {
  const backend = await mockBackend(page);
  const id = 'a5'.repeat(12);
  backend.bookings[id] = { _id: id, bookingType: 'consultation', doctorName: 'Dr. Unpaid', ...istAt(-2), price: 300, status: 'pending', paymentStatus: 'pending' };
  await signIn(page);
  await tab(page, 'Bookings').click();
  await page.getByRole('link', { name: /Dr\. Unpaid/ }).click();
  await page.getByRole('button', { name: 'Cancel this booking' }).click();
  await expect(page.getByText('The booking is cancelled.')).toBeVisible();
  await page.getByRole('button', { name: 'Yes, cancel it' }).click();
  await expect(page.getByText('Cancelled', { exact: true })).toBeVisible();
  expect(backend.calls.some((c) => c.path === `/bookings/${id}/cancel`)).toBe(true);
});

test('Q14: a missed appointment says it is not refunded; one moved after a no-show shows the new time and offers no cancel or reschedule', async ({ page }) => {
  const backend = await mockBackend(page);
  const missed = 'b3'.repeat(12);
  const moved = 'b4'.repeat(12);
  backend.bookings[missed] = { _id: missed, bookingType: 'consultation', doctorName: 'Dr. Missed', ...istAt(-30), price: 500, status: 'no_show', paymentStatus: 'paid',
    noShow: { at: new Date().toISOString() } };
  backend.bookings[moved] = { _id: moved, bookingType: 'consultation', doctorName: 'Dr. Moved', bookingDate: '20261125', bookingTime: '16:00', price: 500, status: 'confirmed',
    paymentStatus: 'paid', noShowReschedules: 1,
    noShows: [{ at: '2026-11-17T05:00:00.000Z', rescheduledAt: '2026-11-17T06:00:00.000Z', fromDate: '20261117', fromTime: '10:00', toSlotId: 'a9'.repeat(12) }] };
  await signIn(page);
  await tab(page, 'Bookings').click();
  await expect(page.getByRole('link', { name: /Dr\. Missed/ })).toContainText('Missed (no refund)');
  await page.getByRole('link', { name: /Dr\. Missed/ }).click();
  await expect(page.getByText('You were marked as not present for this appointment. A missed appointment is not refunded.')).toBeVisible();
  await expect(page.getByText('The doctor or clinic may offer you one new time; you will be told if they do.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Cancel|Reschedule/ })).toHaveCount(0);

  await page.goto(`/#/bookings/${moved}`);
  await expect(page.getByText('You missed the earlier time (Tue, 17 Nov, 2026 · 10:00 am), so the appointment was moved to the new time: Wed, 25 Nov, 2026 · 4:00 pm.', { exact: false })).toBeVisible();
  await expect(page.getByText('It is not refunded and cannot be cancelled for a refund. If this time is missed too, it is final.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel this booking' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Reschedule/ })).toHaveCount(0);
  expect(backend.calls.filter((c) => c.method !== 'GET' && c.path.startsWith('/bookings'))).toHaveLength(0);
});
