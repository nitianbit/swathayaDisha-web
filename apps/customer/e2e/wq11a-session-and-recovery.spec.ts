import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * WQ11a: the pre-production review's proofs, as journeys that hold only with their fixes (cookie session = `live`).
 * Sign-out that never reached the server, renewal without an answer, a sign-in whose profile check failed, the lab
 * coupon and family member, a lost lab booking refused on resend, pay again after a refused check, sign-in focus and
 * announcements, and the two-step confirmation's focus.
 */
const ME = 'c1'.repeat(12);
const LAB = 'a1'.repeat(12);
const BR = 'a2'.repeat(12);
const T1 = 'a3'.repeat(12);
const S1 = 'a5'.repeat(12);
const MOTHER = 'f1'.repeat(12);
const BOOKING = 'b1'.repeat(12);
const RECORD = '9'.repeat(24);
const istDay = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

/** Fake Razorpay Checkout that the customer always closes. */
const FAKE_CHECKOUT = `
window.Razorpay = function (o) {
  this.open = function () { setTimeout(function () { o.modal.ondismiss(); }, 10); };
  this.on = function () {};
};`;

interface Backend {
  live: boolean; calls: string[]; logoutAttempts: number; logoutFails: boolean; refreshes: number; refreshFails: boolean;
  profileFailsOnce: boolean; expireNextGet: boolean; creates: unknown[]; createMode: 'ok' | 'drop' | 'refuse' | 'unprocessable';
  reconcileRefused: boolean; coupons: unknown[]; abandons: { kind: string; key: string }[]; pays: number;
}

async function mockBackend(page: Page): Promise<Backend> {
  const b: Backend = { live: false, calls: [], logoutAttempts: 0, logoutFails: false, refreshes: 0, refreshFails: false, profileFailsOnce: false,
    expireNextGet: false, creates: [], createMode: 'ok', reconcileRefused: false, coupons: [], abandons: [], pays: 0 };
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const ok = (route: Route, data: unknown) => json(route, 200, { success: true, data });
  const page1 = (route: Route, items: unknown[]) => json(route, 200, { success: true, data: items, pagination: { page: 1, limit: 20, total: items.length, totalPages: 1 } });
  await page.context().route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1', '');
    const body = req.method() === 'POST' ? req.postDataJSON() : null;
    b.calls.push(path);
    if (path === '/auth/user/send') return json(route, 200, { success: true });
    if (path === '/auth/user/verify') {
      if ((body as { session?: string }).session === 'cookie') b.live = true; // the server set the HttpOnly cookie
      return ok(route, { token: 'access-1', expiresIn: 900, user: {} });
    }
    if (path === '/auth/session/refresh') {
      b.refreshes++;
      if (b.refreshFails) return route.abort('internetdisconnected');
      if (!b.live) return json(route, 401, { error: 401, code: 'SESSION_ENDED', message: 'Please sign in again' });
      return ok(route, { token: `access-r${b.refreshes}`, expiresIn: 900, principal: { userId: ME, userType: 'user', sid: 's1' } });
    }
    if (path === '/auth/session/logout') {
      b.logoutAttempts++;
      if (b.logoutFails) return route.abort('internetdisconnected'); // never reaches the server: the cookie stays valid
      b.live = false;
      return ok(route, { signedOut: true });
    }
    if (path === '/auth/profile') {
      if (b.profileFailsOnce) { b.profileFailsOnce = false; return route.abort('internetdisconnected'); }
      return ok(route, { user: { _id: ME, name: 'Asha Rao', phone: '9876543210', email: 'a@x.in', gender: 'Female', dateOfBirth: '19900101' }, userRole: 'user' });
    }
    if (req.method() === 'GET' && b.expireNextGet) { b.expireNextGet = false; return json(route, 401, { error: 401, code: 'TOKEN_EXPIRED', message: 'Token has expired' }); }
    if (path === `/users/${ME}`) return ok(route, { _id: ME, name: 'Asha Rao', phone: '9876543210', email: 'a@x.in', gender: 'Female', dateOfBirth: '19900101' });
    if (path === `/wallet/user/${ME}`) return ok(route, { _id: 'w', userId: ME, balance: 50, isActive: true });
    if (path === `/wallet/user/${ME}/transactions`) return page1(route, []);
    if (path === '/dependents') return page1(route, [{ _id: MOTHER, userId: ME, name: 'Kamala Rao', relationship: 'Mother', isActive: true }]);
    if (path === '/partner-labs') {
      return ok(route, [{ partnerId: LAB, name: 'Sunrise Diagnostics', provider: 'partner', branches: [{ branchId: BR, name: 'Kothrud',
        address: { line1: '4 Paud Road', city: 'Pune', pincode: '411038' }, homeCollection: false, inLab: true }] }]);
    }
    if (path === `/partner-labs/${LAB}`) {
      return ok(route, { partnerId: LAB, name: 'Sunrise Diagnostics', provider: 'partner', branches: [{ _id: BR, name: 'Kothrud',
        address: { line1: '4 Paud Road', city: 'Pune', pincode: '411038' }, services: { homeCollection: false, inLab: true } }] });
    }
    if (path === `/partner-labs/${LAB}/catalogue`) {
      return ok(route, [{ itemId: T1, kind: 'test', name: 'Complete blood count', price: 400, priceMinor: 40000, visitModes: ['lab'] }]);
    }
    if (path === `/partner-labs/branches/${BR}/slots`) return ok(route, [{ slotId: S1, date: istDay(), startTime: '23:30', endTime: '23:59', seatsLeft: 3 }]);
    if (path === '/coupons/validate') {
      b.coupons.push(body);
      return ok(route, { isValid: true, discountAmount: 50, finalAmount: 350, coupon: { code: 'LAB50' } });
    }
    if (path === '/request-keys/abandon') {
      b.abandons.push(body as { kind: string; key: string });
      return ok(route, { state: 'abandoned' });
    }
    if (path === '/lab-bookings' && req.method() === 'POST') {
      b.creates.push(body);
      if (b.createMode === 'drop') return route.abort('connectionreset'); // lost before it reached the server
      if (b.createMode === 'refuse') return json(route, 409, { error: 409, code: 'SLOT_FULL', message: 'This time is no longer available' });
      if (b.createMode === 'unprocessable') return json(route, 422, { error: 422, code: 'UNPROCESSABLE', message: 'These tests cannot be booked together' });
      return json(route, 500, { error: 500, message: 'not used' });
    }
    if (path === '/lab-bookings' && req.method() === 'GET') return page1(route, []);
    if (path === `/lab-bookings/${BOOKING}/pay`) {
      b.pays++;
      return ok(route, { booking: {}, paymentRequired: true, walletDeductedAmount: 100,
        payment: { paymentTransactionId: RECORD, razorpayOrderId: 'order_2', razorpayKeyId: 'rzp_test', amount: 300, currency: 'INR' } });
    }
    if (path === `/lab-bookings/${BOOKING}`) {
      return ok(route, {
        _id: BOOKING, partnerId: LAB, branchId: BR, patient: { kind: 'self', name: 'Asha Rao' }, visitMode: 'lab',
        slot: { slotId: S1, date: istDay(), startTime: '23:30', endTime: '23:59', startsAt: new Date(Date.now() + 72 * 3_600_000).toISOString() },
        items: [{ catalogItemId: T1, kind: 'test', name: 'Complete blood count', priceMinor: 40000 }],
        pricing: { subtotalMinor: 40000, discountMinor: 0, payableMinor: 40000, currency: 'INR' },
        status: 'pending_payment', paymentStatus: 'pending', paymentTransactionId: RECORD, paymentDeadline: new Date(Date.now() + 20 * 60_000).toISOString(),
        reschedule: { version: 0, pending: false }, report: { files: [], releases: [] }, lifecycle: {}, createdAt: new Date().toISOString(),
      });
    }
    if (path === '/payments/reconcile') {
      // The backend's answer for an attempt already marked failed (payment/services handleExistingRecordStatus): a definite 400.
      if (b.reconcileRefused) return json(route, 400, { error: 400, code: 'PAYMENT_FAILED', message: 'Payment is already marked as failed' });
      return ok(route, { state: 'unpaid', gatewayStatuses: [] });
    }
    if (path === '/bookings' || path.startsWith('/external-bookings') || path === '/instant/requests' || path === '/bills') return page1(route, []);
    return json(route, 404, { error: 404, message: 'Not found' });
  });
  return b;
}

async function signIn(page: Page, path = '/') {
  await page.goto(`/#${path}`);
  await page.getByLabel('Mobile number or email').fill('9876543210');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
}
const tab = (page: Page, name: string) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true });
const SIGNED_OUT_HERE = 'You are signed out on this device.';

test('a sign-out whose logout never reaches the server is said, retried, and no reload resumes it until the server ends it', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Hello, Asha' })).toBeVisible();
  b.logoutFails = true; // weak signal at the moment of signing out
  await tab(page, 'Profile').click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByLabel('Mobile number or email')).toBeVisible();
  await expect(page.getByText(SIGNED_OUT_HERE)).toBeVisible();
  await expect.poll(() => b.logoutAttempts, { timeout: 8000 }).toBeGreaterThanOrEqual(3); // retried with backoff
  // Only a flag and a time are kept (no token, no person).
  const kept = await page.evaluate(() => localStorage.getItem('sd:signout:customer'));
  expect(Object.keys(JSON.parse(kept!)).sort()).toEqual(['at', 'pending']);
  // Someone else opens the app while the server still holds the session: it is not resumed, the logout is tried first.
  const refreshesBefore = b.refreshes;
  await page.reload();
  await expect(page.getByLabel('Mobile number or email')).toBeVisible();
  await expect(page.getByText(SIGNED_OUT_HERE)).toBeVisible();
  await expect(page.getByLabel('Full name')).toHaveCount(0);
  expect(b.refreshes).toBe(refreshesBefore);
  expect(b.live).toBe(true);
  // The connection comes back: the retry ends the session on the server and the note goes away.
  b.logoutFails = false;
  await expect.poll(() => b.live, { timeout: 15_000 }).toBe(false);
  await expect(page.getByText(SIGNED_OUT_HERE)).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('sd:signout:customer'))).toBeNull();
  await page.reload();
  await expect(page.getByLabel('Mobile number or email')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Profile' })).toHaveCount(0);
});

test('a tab closed right after a failed sign-out: the next start finishes the logout before any refresh', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page, '/profile');
  await expect(page.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible();
  b.logoutFails = true;
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect.poll(() => b.logoutAttempts).toBeGreaterThanOrEqual(1);
  b.logoutFails = false;
  const from = b.calls.length;
  await page.reload();
  await expect(page.getByLabel('Mobile number or email')).toBeVisible();
  const after = b.calls.slice(from).filter((p) => p.startsWith('/auth/session/'));
  expect(after[0]).toBe('/auth/session/logout');
  expect(b.live).toBe(false);
  await expect(page.getByText(SIGNED_OUT_HERE)).toHaveCount(0);
  // Signing in again works as usual (and clears nothing it should not).
  await page.getByLabel('Mobile number or email').fill('9876543210');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible();
});

test('a renewal that fails on the network keeps the session, says "Reconnecting…" and recovers on its own', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Hello, Asha' })).toBeVisible();
  b.expireNextGet = true; // the 15-minute access token ran out
  b.refreshFails = true; // and the phone is offline for a moment
  await tab(page, 'Wallet').click();
  await expect(page.getByText('Reconnecting…')).toBeVisible();
  await expect(page.getByText('Your session has ended. Please sign in again.')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  expect(b.logoutAttempts).toBe(0);
  b.refreshFails = false;
  await expect(page.getByText('Reconnecting…')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expect(page.getByLabel('Mobile number or email')).toHaveCount(0);
});

test('a definite refusal of the renewal still ends the session', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Hello, Asha' })).toBeVisible();
  b.expireNextGet = true;
  b.live = false; // the session was ended elsewhere: 401 SESSION_ENDED
  await tab(page, 'Wallet').click();
  await expect(page.getByText('Your session has ended. Please sign in again.')).toBeVisible();
});

test('a sign-in whose profile check fails after the code was accepted ends the new session', async ({ page }) => {
  const b = await mockBackend(page);
  b.profileFailsOnce = true;
  await signIn(page);
  await expect(page.getByRole('alert').filter({ hasText: 'Could not reach the server' })).toBeVisible();
  await expect(page.getByLabel('6-digit code')).toBeVisible();
  await expect.poll(() => b.logoutAttempts).toBeGreaterThanOrEqual(1);
  expect(b.live).toBe(false);
  await page.reload();
  await expect(page.getByLabel('Mobile number or email')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Hello, Asha' })).toHaveCount(0);
});

async function openLabForm(page: Page) {
  await signIn(page, `/labs/${LAB}`);
  await page.getByRole('checkbox', { name: /Complete blood count/ }).check();
  await page.getByRole('button', { name: '11:30 pm' }).click();
}

test('lab booking: choosing a family member after applying a coupon checks the coupon again and keeps Book usable', async ({ page }) => {
  const b = await mockBackend(page);
  await openLabForm(page);
  await page.getByLabel('Coupon (optional)').fill('LAB50');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText('Coupon LAB50: ₹50.00 off.')).toBeVisible();
  const book = page.getByRole('button', { name: /^Book/ });
  await expect(book).toBeEnabled();
  await page.getByLabel('For').selectOption({ label: 'Kamala Rao (Mother)' });
  await expect.poll(() => b.coupons.length).toBe(2);
  await expect(page.getByText('Coupon LAB50: ₹50.00 off.')).toBeVisible();
  await expect(book).toBeEnabled();
});

test('lab booking: a lost request refused on resend can be given up, and the form comes back', async ({ page }) => {
  const b = await mockBackend(page);
  await openLabForm(page);
  b.createMode = 'drop';
  await page.getByRole('button', { name: /^Book/ }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed lab booking request' });
  await expect(panel).toBeVisible();
  b.createMode = 'refuse'; // the slot filled up meanwhile: it may race the first attempt, so it stays unconfirmed
  await panel.getByRole('button', { name: 'Send it again' }).click();
  await expect(panel).toContainText('This time is no longer available');
  await panel.getByRole('button', { name: 'Give it up and start again' }).click();
  await expect(panel.getByRole('button', { name: 'Yes, give it up' })).toBeFocused();
  await panel.getByRole('button', { name: 'Yes, give it up' }).click();
  await expect(panel).toHaveCount(0);
  expect(b.abandons).toHaveLength(1);
  expect(b.abandons[0]).toMatchObject({ kind: 'lab_booking_create', key: (b.creates[0] as { requestKey: string }).requestKey });
  await expect(page.getByRole('checkbox', { name: /Complete blood count/ })).toBeVisible();
});

test('lab booking: a lost request whose resend is refused for its content is settled as not made', async ({ page }) => {
  const b = await mockBackend(page);
  await openLabForm(page);
  b.createMode = 'drop';
  await page.getByRole('button', { name: /^Book/ }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed lab booking request' });
  await expect(panel).toBeVisible();
  b.createMode = 'unprocessable';
  await panel.getByRole('button', { name: 'Send it again' }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: /Complete blood count/ })).toBeVisible();
  await page.getByRole('button', { name: '11:30 pm' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'These tests cannot be booked together' })).toBeVisible();
  expect(b.abandons).toHaveLength(0);
});

test('pay again: a refused payment check (400 PAYMENT_FAILED) allows a new payment; the amount due and the wallet part are shown', async ({ page }) => {
  await page.addInitScript(FAKE_CHECKOUT);
  const b = await mockBackend(page);
  b.reconcileRefused = true;
  await signIn(page, `/partner-lab-bookings/${BOOKING}`);
  await expect(page.getByText(/This booking is not paid yet\. Pay by/)).toBeVisible();
  await expect(page.getByText('We could not check your payment just now.')).toHaveCount(0);
  const amount = page.getByRole('definition').filter({ hasText: '₹400.00' });
  await expect(page.getByLabel('Amount')).toContainText('Amount due');
  await expect(amount.first()).toBeVisible();
  await page.getByRole('button', { name: 'Pay now' }).click();
  await expect.poll(() => b.pays).toBe(1);
  await expect(page.getByLabel('Amount')).toContainText('Already held from your wallet');
  await expect(page.getByLabel('Amount')).toContainText('₹100.00');
  await expect(page.getByLabel('Amount')).toContainText('₹300.00');
  await expect(page.getByRole('button', { name: 'Pay now' })).toBeEnabled();
});

test('sign-in: errors are announced, focus moves to the field, and the code field names where the code went', async ({ page }) => {
  await mockBackend(page);
  await page.goto('/');
  const id = page.getByLabel('Mobile number or email');
  await expect(id).toHaveAttribute('autocomplete', 'off'); // a shared phone never offers the previous person's number
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByRole('alert')).toHaveText('Enter your 10-digit mobile number or your email address.');
  await expect(id).toBeFocused();
  await id.fill('9876543210');
  await page.getByRole('button', { name: 'Send code' }).click();
  const code = page.getByLabel('6-digit code');
  await expect(code).toBeFocused();
  const describedBy = (await code.getAttribute('aria-describedby'))!.split(' ');
  const sentence = await page.evaluate((ids) => ids.map((i) => document.getElementById(i)?.textContent ?? '').join(' '), describedBy);
  expect(sentence).toContain('We sent a 6-digit code to your phone ••••••3210.');
  await code.fill('12');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('Enter the 6-digit code.');
  await expect(code).toBeFocused();
  await page.getByRole('button', { name: 'Change number or email' }).click();
  await expect(id).toBeFocused();
});

test('a two-step confirmation takes the focus to its first button and gives it back on Back', async ({ page }) => {
  await mockBackend(page);
  await signIn(page, '/profile');
  const opener = page.getByRole('button', { name: 'Sign out on all devices' });
  await opener.click();
  const group = page.getByRole('group', { name: 'Sign out on all devices' });
  await expect(group.getByRole('button', { name: 'Sign out everywhere' })).toBeFocused();
  await expect(group).toHaveAccessibleDescription(/Every phone or browser signed in to your account will be signed out/);
  await group.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('button', { name: 'Sign out on all devices' })).toBeFocused();
});

test('an explicit sign-out forgets the customer\'s unconfirmed-request markers on this device', async ({ page }) => {
  const b = await mockBackend(page);
  await openLabForm(page);
  b.createMode = 'drop';
  await page.getByRole('button', { name: /^Book/ }).click();
  await expect(page.getByRole('group', { name: 'Unconfirmed lab booking request' })).toBeVisible();
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('sd:pend:customer:')).length)).toBe(1);
  await tab(page, 'Profile').click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByLabel('Mobile number or email')).toBeVisible();
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('sd:pend:')).length)).toBe(0);
});
