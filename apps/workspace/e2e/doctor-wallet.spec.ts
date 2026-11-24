import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * WQ23: the doctor wallet (r20, design §25.12) against a mocked backend: the doctor's top-up by Razorpay, a lost order
 * answer asked again with the same key, an ineligible doctor, the switch, and the admin's credit and hold on the doctor's
 * wallet page. Amounts in paise. WQ23b: a failed read keeps the form; a closed wallet still checks this device's top-ups.
 */
const DOC = 'd1'.repeat(12);
const ADMIN = 'ad'.repeat(12);
const NOW = new Date('2026-11-25T04:30:00.000Z');

type Rec = Record<string, unknown>;
interface Backend {
  calls: { method: string; path: string; body: unknown; key?: string }[];
  live: boolean;
  eligible: boolean;
  off?: boolean;
  loseStartAfter?: boolean;
  loseAdminAfter?: boolean;
  /** WQ23b: the wallet read fails (500); the proof's answer is lost. */
  walletDown?: boolean;
  loseVerify?: boolean;
  wallet: { balanceMinor: number; withdrawableMinor: number; receivableMinor: number; frozen: boolean; frozenReason: string | null; isActive: boolean };
  entries: Rec[];
  topups: Rec[];
  adminKeys: Record<string, Rec>;
}

async function mockBackend(page: Page): Promise<Backend> {
  await page.clock.setFixedTime(NOW);
  const b: Backend = { calls: [], live: false, eligible: true, entries: [], topups: [], adminKeys: {},
    wallet: { balanceMinor: 0, withdrawableMinor: 0, receivableMinor: 0, frozen: false, frozenReason: null, isActive: true } };
  const profile = { _id: DOC, name: 'Dr Asha Mehta', specialization: 'Cardiology', medicalRegistrationNumber: 'MCI-123', phone: '9000000020', isActive: true, isVerified: true,
    createdAt: '2026-11-01T05:00:00.000Z', updatedAt: '2026-11-20T05:00:00.000Z' };
  let seq = 0;
  const view = () => ({ ...b.wallet, updatedAt: NOW.toISOString() });
  const credit = (amountMinor: number, o: Rec) => {
    b.wallet.balanceMinor += amountMinor;
    b.entries.unshift({ _id: `e${++seq}`.padEnd(24, '0'), kind: 'credit', amountMinor, balanceAfterMinor: b.wallet.balanceMinor, at: new Date(NOW.getTime() + seq * 1000).toISOString(), ...o });
  };
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const ok = (route: Route, data: unknown, status = 200) => json(route, status, { success: true, data });
  const fail = (route: Route, status: number, code: string, message: string, extra: Rec = {}) => json(route, status, { error: status, code, message, ...extra });
  await page.route('https://checkout.razorpay.com/v1/checkout.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: `window.Razorpay = function (o) {
      this.on = function () {};
      this.open = function () { setTimeout(function () { o.handler({ razorpay_payment_id: 'pay_TEST1', razorpay_order_id: o.order_id, razorpay_signature: 'sig_TEST' }); }, 10); };
    };`,
  }));
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = req.method();
    const body = ['POST', 'PUT'].includes(method) ? (req.postDataJSON() as Rec | null) : null;
    if (path === '/auth/session/refresh') {
      return b.live ? ok(route, { token: 't1', expiresIn: 900, principal: { userId: DOC, userType: 'specialist', sid: 's1' } }) : fail(route, 401, 'SESSION_ENDED', 'Please sign in again');
    }
    if (path.startsWith('/auth/session')) return ok(route, {});
    b.calls.push({ method, path: `${path}${url.search}`, body, key: req.headers()['idempotency-key'] });
    if (path === '/auth/specialist/send' || path === '/auth/admin/send') return ok(route, undefined);
    if (path === '/auth/specialist/verify') { b.live = true; return ok(route, { token: 't1', expiresIn: 900, user: {} }); }
    if (path === '/auth/admin/verify') return ok(route, { token: 'admin', expiresIn: 900, user: {} });
    const auth = req.headers().authorization;
    if (auth !== 'Bearer t1' && auth !== 'Bearer admin') return fail(route, 401, 'UNAUTHORIZED', 'Authentication is required');
    const admin = auth === 'Bearer admin';
    if (path === '/auth/profile') return ok(route, admin ? { user: { _id: ADMIN, name: 'Ops Admin' }, userRole: 'admin' } : { user: profile, userRole: 'specialist' });

    // ── the doctor's own wallet ──
    const me = /^\/specialists\/me\/assisted(\/.*)$/.exec(path);
    if (me && !admin) {
      const sub = me[1]!;
      if ((sub === '/wallet' || sub === '/wallet/entries' || (sub === '/wallet/topups' && method === 'POST')) && !b.eligible) {
        return fail(route, 403, 'SPECIALIST_NOT_VERIFIED', 'Your doctor account must be verified and active before you can do this');
      }
      if (sub === '/wallet') return b.walletDown ? fail(route, 500, 'INTERNAL_ERROR', 'Something went wrong') : ok(route, view());
      if (sub === '/wallet/entries') return json(route, 200, { success: true, data: b.entries, pagination: { nextCursor: null } });
      if (sub === '/wallet/topups' && method === 'POST') {
        if (b.off) return fail(route, 503, 'ASSISTED_BOOKING_DISABLED', 'Doctor wallet top-ups are not switched on');
        const x = body as { amountMinor: number; requestKey: string };
        const prior = b.topups.find((t) => t.requestKey === x.requestKey);
        const t = prior ?? { _id: `ab${String(++seq).padStart(22, '0')}`, amountMinor: x.amountMinor, requestKey: x.requestKey, status: 'created', orderId: `order_${seq}` };
        if (!prior) b.topups.push(t);
        if (b.loseStartAfter) { b.loseStartAfter = false; return route.abort('failed'); }
        return ok(route, { paymentTransactionId: t._id, razorpayOrderId: t.orderId, razorpayKeyId: 'rzp_test_1', amountMinor: t.amountMinor, currency: 'INR', state: 'awaiting_payment', replayed: !!prior });
      }
      const check = /^\/wallet\/topups\/([0-9a-f]{24})\/check$/.exec(sub);
      if (check) {
        const t = b.topups.find((y) => y._id === check[1]);
        if (!t) return fail(route, 404, 'PAYMENT_RECORD_NOT_FOUND', 'Payment record not found');
        if (t.status === 'paid') { t.status = 'credited'; credit(t.amountMinor as number, { referenceType: 'wallet_recharge', referenceId: t._id }); }
        // E8: an ineligible doctor's check answers the state only.
        return ok(route, { state: t.status === 'credited' ? 'credited' : 'unpaid', ...(b.eligible ? { wallet: view() } : {}) });
      }
    }
    if (path === '/payments/verify' && method === 'POST' && !admin) {
      const t = b.topups.find((y) => y._id === (body as Rec).paymentTransactionId);
      if (!t) return fail(route, 404, 'PAYMENT_RECORD_NOT_FOUND', 'Payment record not found');
      if (b.loseVerify) { b.loseVerify = false; return route.abort('failed'); }
      if (t.status !== 'credited') { t.status = 'credited'; b.wallet.withdrawableMinor += t.amountMinor as number; credit(t.amountMinor as number, { referenceType: 'wallet_recharge', referenceId: t._id }); }
      return ok(route, { context: 'wallet_recharge', paymentRecord: { _id: t._id, status: 'paid', credited: true }, entity: view() });
    }

    // ── admin ──
    if (admin && path === `/specialists/${DOC}`) return ok(route, profile);
    const ad = /^\/admin\/doctors\/([0-9a-f]{24})\/wallet(\/.*)?$/.exec(path);
    if (ad && admin) {
      if (ad[1] !== DOC) return fail(route, 404, 'SPECIALIST_NOT_FOUND', 'Specialist not found');
      const sub = ad[2] ?? '';
      if (sub === '' && method === 'GET') return ok(route, { ...view(), exists: true, version: 1 });
      if (sub === '/entries') return json(route, 200, { success: true, data: b.entries.map((e) => ({ ...e, notes: e.notes ?? null, actor: e.actor ?? null })), pagination: { nextCursor: null } });
      if (sub === '/lots') return ok(route, []);
      if (sub === '/topup' && method === 'POST') {
        const key = req.headers()['idempotency-key']!;
        const x = body as { amountMinor: number; notes: string };
        if (!b.adminKeys[key]) {
          b.adminKeys[key] = x;
          credit(x.amountMinor, { referenceType: 'topup', referenceId: key, notes: x.notes, actor: { kind: 'admin', id: ADMIN } });
          if (b.loseAdminAfter) { b.loseAdminAfter = false; return route.abort('failed'); }
        }
        return ok(route, { ...view(), exists: true });
      }
      const byKey = /^\/topups\/by-key\/([A-Za-z0-9_-]+)$/.exec(sub);
      if (byKey) {
        const e = b.entries.find((y) => y.referenceType === 'topup' && y.referenceId === byKey[1]);
        return ok(route, e ? { state: 'credited', entry: e, wallet: view() } : { state: 'not_found' });
      }
      if (sub === '/freeze' && method === 'PUT') {
        const x = body as { frozen: boolean; reason: string };
        Object.assign(b.wallet, { frozen: x.frozen, frozenReason: x.frozen ? x.reason : null });
        return ok(route, { ...view(), exists: true });
      }
    }
    if (path === '/admin/wallet-recharges/uncredited') return ok(route, []);
    return fail(route, 404, 'NOT_FOUND', 'Not found');
  });
  return b;
}

async function signIn(page: Page, as: 'Doctor' | 'Admin' = 'Doctor') {
  await page.goto('/');
  await page.getByLabel(as, { exact: true }).check();
  await page.getByLabel('Mobile number').fill('9000000020');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}
const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' });
const orders = (b: Backend) => b.calls.filter((c) => c.method === 'POST' && c.path === '/specialists/me/assisted/wallet/topups');

test('a doctor tops up the wallet by Razorpay: one keyed order, the proof to /payments/verify, the money shown', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await nav(page).getByRole('link', { name: 'Wallet', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Wallet', level: 1 })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Balance' })).toContainText('Card money (withdrawals coming later)');
  await page.getByLabel('Amount to add (₹)').fill('300');
  await page.getByRole('button', { name: 'Top up' }).click();
  await expect(page.getByText('₹300.00 was added to your wallet.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Balance' })).toContainText('₹300.00');
  await expect(page.getByRole('region', { name: 'Wallet history' })).toContainText('Top-up (card / UPI)');
  expect(orders(backend)[0]!.body).toMatchObject({ amountMinor: 30000 });
  expect(backend.calls.some((c) => c.path === '/payments/verify')).toBe(true);
});

test('a lost order answer: "Top up" asks again with the same key and amount; one order, added once', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.loseStartAfter = true;
  await signIn(page);
  await page.goto('/#/doctor/wallet');
  await page.getByLabel('Amount to add (₹)').fill('450');
  await page.getByRole('button', { name: 'Top up' }).click();
  await expect(page.getByText('“Top up” asks for the same ₹450.00 again (never a second order).', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Top up' }).click();
  await expect(page.getByText('₹450.00 was added to your wallet.')).toBeVisible();
  expect(orders(backend)).toHaveLength(2);
  expect(orders(backend)[1]!.body).toEqual(orders(backend)[0]!.body);
  expect(backend.topups).toHaveLength(1);
  expect(backend.entries).toHaveLength(1);
});

test('an ineligible doctor sees only that the wallet opens after verification; the switch is said in words', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.eligible = false;
  await signIn(page);
  await page.goto('/#/doctor/wallet');
  await expect(page.getByText('Your wallet opens once Jansetu has verified your account and it is active.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Add money' })).toHaveCount(0);
  expect(orders(backend)).toHaveLength(0);

  backend.eligible = true;
  backend.off = true;
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await page.getByLabel('Amount to add (₹)').fill('300');
  await page.getByRole('button', { name: 'Top up' }).click();
  await expect(page.getByText('Could not start the top-up: Adding money to your wallet is not switched on yet. No money was taken.')).toBeVisible();
});

test('WQ23b: a failed read after the wallet was shown keeps Add money, its answer and the history', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await page.goto('/#/doctor/wallet');
  await expect(page.getByRole('region', { name: 'Wallet history' })).toBeVisible();
  backend.walletDown = true;
  await page.getByLabel('Amount to add (₹)').fill('300');
  await page.getByRole('button', { name: 'Top up' }).click();
  await expect(page.getByText('₹300.00 was added to your wallet.')).toBeVisible();
  // The wallet read again after the top-up fails (after its retries): the balance says so; nothing else goes away.
  await expect(page.getByRole('region', { name: 'Balance' }).getByRole('button', { name: 'Try again' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('₹300.00 was added to your wallet.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Add money' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Wallet history' })).toContainText('Top-up (card / UPI)');
});

test('WQ23b: a doctor whose wallet is closed can still check a top-up started on this device (r20 E8)', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.loseVerify = true;
  await signIn(page);
  await page.goto('/#/doctor/wallet');
  await page.getByLabel('Amount to add (₹)').fill('250');
  await page.getByRole('button', { name: 'Top up' }).click();
  await expect(page.getByText('The payment was not completed, so no money was added.', { exact: false })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Top-ups not confirmed yet' })).toBeVisible();

  backend.eligible = false;
  backend.topups[0]!.status = 'paid';
  await page.reload();
  await expect(page.getByText('Your wallet opens once Jansetu has verified your account and it is active.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Add money' })).toHaveCount(0);
  const pending = page.getByRole('region', { name: 'Top-ups not confirmed yet' });
  await pending.getByRole('button', { name: 'Check my top-up' }).click();
  await expect(pending).toContainText('was added to your wallet.');
  expect(backend.calls.filter((c) => c.path === `/specialists/me/assisted/wallet/topups/${backend.topups[0]!._id as string}/check`)).toHaveLength(2);
  expect(orders(backend)).toHaveLength(1);
});

test('admin: the doctor’s wallet from the doctor page; money added once after a lost answer; the hold and its release', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page, 'Admin');
  await page.goto(`/#/admin/doctors/${DOC}`);
  await page.getByRole('link', { name: 'Wallet', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Wallet: Dr Asha Mehta' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Balance' })).toContainText('Card money (withdrawals coming later)');
  const add = page.getByRole('form', { name: 'Add money to the wallet' });
  await expect(add).toContainText('or the doctor could be paid twice');
  await add.getByLabel('Amount to add (₹)').fill('1000');
  await add.getByLabel('Why is the money added?').fill('Support credit');
  await add.getByRole('button', { name: 'Next: check before adding' }).click();
  backend.loseAdminAfter = true;
  await add.getByRole('button', { name: 'Yes, add ₹1,000.00' }).click();
  await page.getByRole('group', { name: 'Unconfirmed money added' }).getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(page.getByText('It was added: ₹1,000.00', { exact: false })).toBeVisible();
  const credits = backend.calls.filter((c) => c.method === 'POST' && c.path === `/admin/doctors/${DOC}/wallet/topup`);
  expect(credits).toHaveLength(1);
  expect(credits[0]!.body).toEqual({ amountMinor: 100000, notes: 'Support credit' });
  expect(backend.calls.some((c) => c.path === `/admin/doctors/${DOC}/wallet/topups/by-key/${credits[0]!.key}`)).toBe(true);

  await page.getByRole('button', { name: 'Put on hold' }).click();
  await page.getByLabel('Why is the wallet put on hold?').fill('Card dispute under review');
  await page.getByRole('button', { name: 'Yes, put it on hold' }).click();
  await expect(page.getByRole('region', { name: 'Balance' })).toContainText('The wallet is on hold (Card dispute under review)');
  await page.getByRole('button', { name: 'Release the hold' }).click();
  await page.getByLabel('Why is the hold released?').fill('Resolved');
  await page.getByRole('button', { name: 'Yes, release it' }).click();
  await expect(page.getByText('The wallet of Dr Asha Mehta is released.')).toBeVisible();
  expect(backend.calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([
    { frozen: true, reason: 'Card dispute under review' }, { frozen: false, reason: 'Resolved' },
  ]);
});
