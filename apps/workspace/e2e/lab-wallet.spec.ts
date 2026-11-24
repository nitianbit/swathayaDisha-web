import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * WQ20: the lab wallet (r13, design §24.13) against a mocked backend: a lab's own top-up by Razorpay, a lost answer found in
 * Top-ups and checked, the ₹50,000 limit, the switch, permissions and a clinic; the admin's credit (once per key, resent
 * after a lost answer) and the hold. Amounts in paise, as the server answers.
 */
const LAB = 'a1'.repeat(12);
const CLINIC = 'a2'.repeat(12);
const OWNER = 'b1'.repeat(12);
const STAFF = 'b2'.repeat(12);
const ADMIN = 'ad'.repeat(12);
const NOW = new Date('2026-11-25T04:30:00.000Z');
const ALL = ['staff.manage', 'branches.manage', 'catalogue.manage', 'slots.manage', 'bookings.view', 'bookings.manage', 'reports.upload',
  'reports.release', 'invoices.create', 'invoices.cancel', 'payments.record', 'finance.view', 'wallet.view', 'wallet.manage'];

type Rec = Record<string, unknown>;
interface Me { _id: string; partnerId: string; name: string; role: 'owner' | 'staff'; permissions: string[]; branchIds: string[] }
interface Backend {
  calls: { method: string; path: string; body: unknown; key?: string }[];
  me: Me;
  live: boolean;
  wallet: { balanceMinor: number; withdrawableMinor: number; receivableMinor: number; frozen: boolean; frozenReason: string | null; isActive: boolean };
  entries: Rec[];
  topups: Rec[];
  adminKeys: Record<string, { amountMinor: number; notes: string }>;
  off?: boolean;
  /** The next top-up order answers 409 WALLET_LIMIT_REACHED (the balance is near ₹50,000). */
  full?: boolean;
  /** Checkout's proof never reaches the server, and the server's first check is lost too (the payment was taken). */
  loseVerifyAndCheck?: boolean;
  /** The next admin credit is made, then its answer is lost. */
  loseAdminAfter?: boolean;
  /** WQ20c: the partner record (`GET /partner-workspace/me`) cannot be read. */
  meDown?: boolean;
  members?: Rec[];
  /** WQ20b: the next top-up order is made, then its answer is lost. */
  loseStartAfter?: boolean;
  /** WQ20b: verify answers paid but not credited (the server's check then adds it). */
  verifyNotCredited?: boolean;
}

const view = (b: Backend) => ({ ...b.wallet, updatedAt: NOW.toISOString() });

async function mockBackend(page: Page, me: Me): Promise<Backend> {
  await page.clock.setFixedTime(NOW);
  const b: Backend = { calls: [], me, live: false, entries: [], topups: [], adminKeys: {},
    wallet: { balanceMinor: 0, withdrawableMinor: 0, receivableMinor: 0, frozen: false, frozenReason: null, isActive: true } };
  const partners: Rec[] = [
    { _id: LAB, kind: 'lab', name: 'City Lab', contact: { phone: '9000000000' }, verification: { state: 'verified' }, taxRegime: 'unregistered', invoiceSeries: { prefix: 'LB' }, activeOwnerCount: 1, isActive: true },
    { _id: CLINIC, kind: 'clinic', name: 'Sunrise Clinic', contact: { phone: '9000000008' }, verification: { state: 'verified' }, taxRegime: 'unregistered', invoiceSeries: { prefix: 'SC' }, activeOwnerCount: 1, isActive: true },
  ];
  let seq = 0;
  const credit = (amountMinor: number, o: Rec) => {
    b.wallet.balanceMinor += amountMinor;
    b.entries.unshift({ _id: `e${++seq}`.padEnd(24, '0'), kind: 'credit', amountMinor, balanceAfterMinor: b.wallet.balanceMinor, at: new Date(NOW.getTime() + seq * 1000).toISOString(), ...o });
  };
  const creditTopup = (t: Rec) => {
    if (t.state === 'credited') return;
    t.state = 'credited'; t.status = 'paid';
    b.wallet.withdrawableMinor += t.amountMinor as number;
    credit(t.amountMinor as number, { referenceType: 'wallet_recharge', referenceId: t.paymentTransactionId, description: 'Wallet top-up' });
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
      if (!b.live) return fail(route, 401, 'SESSION_ENDED', 'Please sign in again');
      return ok(route, { token: 't1', expiresIn: 900, principal: { userId: b.me._id, userType: 'partner', sid: 's1' } });
    }
    if (path.startsWith('/auth/session')) return ok(route, {});
    b.calls.push({ method, path: `${path}${url.search}`, body, key: req.headers()['idempotency-key'] });
    if (path === '/auth/partner/send' || path === '/auth/admin/send') return ok(route, undefined);
    if (path === '/auth/partner/verify') { b.live = true; return ok(route, { token: 't1', expiresIn: 900, user: {} }); }
    if (path === '/auth/admin/verify') return ok(route, { token: 'admin', expiresIn: 900, user: {} });
    const auth = req.headers().authorization;
    if (auth !== 'Bearer t1' && auth !== 'Bearer admin') return fail(route, 401, 'UNAUTHORIZED', 'Authentication is required');
    const admin = auth === 'Bearer admin';
    if (path === '/auth/profile') {
      return ok(route, admin ? { user: { _id: ADMIN, name: 'Ops Admin' }, userRole: 'admin' }
        : { user: { ...b.me, phone: '9000000001', isActive: true }, partner: partners.find((p) => p._id === b.me.partnerId), userRole: 'partner' });
    }

    // ── member: /partner-workspace/assisted ──
    const as = /^\/partner-workspace\/assisted(\/.*)$/.exec(path);
    if (as && !admin) {
      const sub = as[1]!;
      const can = (p: string) => b.me.role === 'owner' || b.me.permissions.includes(p);
      if (partners.find((p) => p._id === b.me.partnerId)!.kind !== 'lab') return fail(route, 404, 'WALLET_NOT_FOUND', 'Wallet not found');
      if (sub === '/wallet') return can('wallet.view') ? ok(route, view(b)) : fail(route, 403, 'INSUFFICIENT_PERMISSIONS', 'Insufficient permissions');
      if (sub === '/wallet/entries') return json(route, 200, { success: true, data: b.entries, pagination: { nextCursor: null } });
      if (sub === '/wallet/topups' && method === 'GET') return json(route, 200, { success: true, data: b.topups, pagination: { nextCursor: null } });
      if (sub === '/wallet/topups' && method === 'POST') {
        if (!can('wallet.manage')) return fail(route, 403, 'INSUFFICIENT_PERMISSIONS', 'Insufficient permissions');
        if (b.off) return fail(route, 503, 'ASSISTED_BOOKING_DISABLED', 'Lab wallet top-ups are not switched on');
        const x = body as { amountMinor: number; requestKey: string };
        if (b.full) return fail(route, 409, 'WALLET_LIMIT_REACHED', 'The wallet would hold more than its maximum',
          { details: { maxBalanceMinor: 5_000_000, balanceMinor: 4_800_000, pendingMinor: 0, allowedMinor: 200_000 } });
        const prior = b.topups.find((t) => t.requestKey === x.requestKey);
        const t = prior ?? { paymentTransactionId: `ab${String(++seq).padStart(22, '0')}`, amountMinor: x.amountMinor, state: 'awaiting_payment', status: 'created',
          memberId: b.me._id, razorpayOrderId: `order_${seq}`, createdAt: NOW.toISOString(), paidAt: null, requestKey: x.requestKey };
        if (!prior) b.topups.unshift(t);
        if (b.loseStartAfter) { b.loseStartAfter = false; return route.abort('failed'); }
        return ok(route, { paymentTransactionId: t.paymentTransactionId, razorpayOrderId: t.razorpayOrderId, razorpayKeyId: 'rzp_test_1', amountMinor: t.amountMinor,
          currency: 'INR', state: t.state, replayed: !!prior });
      }
      if (sub === '/payments/verify' && method === 'POST') {
        const t = b.topups.find((y) => y.paymentTransactionId === (body as Rec).paymentTransactionId);
        if (!t) return fail(route, 404, 'PAYMENT_RECORD_NOT_FOUND', 'Payment record not found');
        if (b.loseVerifyAndCheck) { t.state = 'paid_not_credited'; t.status = 'paid'; return route.abort('failed'); }
        if (b.verifyNotCredited) {
          b.verifyNotCredited = false; t.state = 'paid_not_credited'; t.status = 'paid';
          return ok(route, { context: 'wallet_recharge', paymentRecord: { _id: t.paymentTransactionId, status: 'paid', credited: false }, entity: view(b) });
        }
        creditTopup(t);
        return ok(route, { context: 'wallet_recharge', paymentRecord: { _id: t.paymentTransactionId, status: 'paid', credited: true }, entity: view(b) });
      }
      const check = /^\/wallet\/topups\/([0-9a-f]{24})\/check$/.exec(sub);
      if (check && method === 'POST') {
        const t = b.topups.find((y) => y.paymentTransactionId === check[1]);
        if (!t) return fail(route, 404, 'PAYMENT_RECORD_NOT_FOUND', 'Payment record not found');
        if (b.loseVerifyAndCheck) { b.loseVerifyAndCheck = false; return route.abort('failed'); }
        if (t.status !== 'paid') return ok(route, { state: 'unpaid', wallet: view(b) });
        creditTopup(t);
        return ok(route, { state: 'credited', wallet: view(b) });
      }
      return fail(route, 404, 'NOT_FOUND', 'Not found');
    }

    // ── admin: /admin/labs/:id/wallet ──
    const al = /^\/admin\/labs\/([0-9a-f]{24})\/wallet(\/.*)?$/.exec(path);
    if (al) {
      if (!admin) return fail(route, 403, 'FORBIDDEN', 'Admin access is required');
      if (al[1] !== LAB) return fail(route, 404, 'LAB_NOT_FOUND', 'Lab not found');
      const sub = al[2] ?? '';
      if (sub === '' && method === 'GET') return ok(route, { ...view(b), exists: true, frozenAt: null, version: 1, createdAt: NOW.toISOString() });
      if (sub === '/entries') return json(route, 200, { success: true, data: b.entries.map((e) => ({ ...e, notes: e.notes ?? null, actor: e.actor ?? null })), pagination: { nextCursor: null } });
      if (sub === '/lots') return ok(route, []);
      if (sub === '/topup' && method === 'POST') {
        const key = req.headers()['idempotency-key'];
        if (!key) return fail(route, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required');
        const x = body as { amountMinor: number; notes: string };
        if (x.amountMinor > 20_000_000) return fail(route, 400, 'VALIDATION_ERROR', 'amountMinor must be at most 20000000');
        const prior = b.adminKeys[key];
        if (prior && (prior.amountMinor !== x.amountMinor || prior.notes !== x.notes)) return fail(route, 409, 'IDEMPOTENCY_KEY_REUSED', 'This key was used for another top-up');
        if (!prior) {
          b.adminKeys[key] = x;
          credit(x.amountMinor, { referenceType: 'topup', referenceId: key, description: 'Admin top-up', notes: x.notes, actor: { kind: 'admin', id: ADMIN } });
          if (b.loseAdminAfter) { b.loseAdminAfter = false; return route.abort('failed'); }
        }
        return ok(route, { ...view(b), exists: true });
      }
      const byKey = /^\/topups\/by-key\/([A-Za-z0-9_-]+)$/.exec(sub);
      if (byKey) {
        const e = b.entries.find((y) => y.referenceType === 'topup' && y.referenceId === byKey[1]);
        return ok(route, e ? { state: 'credited', entry: e, wallet: view(b) } : { state: 'not_found' });
      }
      if (sub === '/freeze' && method === 'PUT') {
        const x = body as { frozen: boolean; reason: string };
        Object.assign(b.wallet, { frozen: x.frozen, frozenReason: x.frozen ? x.reason : null });
        return ok(route, { ...view(b), exists: true });
      }
    }
    if (path === '/admin/wallet-recharges/uncredited') return ok(route, []);
    if (/^\/partner-workspace\/admin\/[0-9a-f]{24}$/.test(path)) return ok(route, partners.find((p) => path.endsWith(p._id as string)));
    const ws = /^\/partner-workspace(\/.*)$/.exec(path);
    if (ws && ws[1] === '/me') return b.meDown ? fail(route, 500, 'INTERNAL', 'Something went wrong') : ok(route, partners.find((p) => p._id === b.me.partnerId));
    if (ws && ws[1] === '/members' && method === 'GET') return ok(route, b.members ?? []);
    const mem = ws && /^\/members\/([0-9a-f]{24})(\/permissions)?$/.exec(ws[1]!);
    if (mem) {
      const m = (b.members ?? []).find((x) => x._id === mem[1]);
      if (!m) return fail(route, 404, 'MEMBER_NOT_FOUND', 'Member not found');
      if (!mem[2]) return ok(route, m);
      if (method === 'PUT') { Object.assign(m, { permissions: (body as Rec).permissions, updatedAt: '2026-11-25T04:40:00.000Z' }); return ok(route, m); }
    }
    if (ws && ws[1] === '/branches') return ok(route, []);
    return fail(route, 404, 'NOT_FOUND', 'Not found');
  });
  return b;
}

const owner = (partnerId = LAB): Me => ({ _id: OWNER, partnerId, name: 'Ravi Owner', role: 'owner', permissions: ALL, branchIds: [] });
const staff = (...permissions: string[]): Me => ({ _id: STAFF, partnerId: LAB, name: 'Sita Staff', role: 'staff', permissions, branchIds: [] });

async function signIn(page: Page, as: 'Lab or clinic staff' | 'Admin' = 'Lab or clinic staff') {
  await page.goto('/');
  await page.getByLabel(as).check();
  await page.getByLabel('Mobile number').fill('9000000001');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}
const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' });
const stored = (page: Page) => page.evaluate(() => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }) + location.href);

test('a lab tops up its wallet by Razorpay: one keyed order, the proof verified, the money shown in the balance, top-ups and history', async ({ page }) => {
  const backend = await mockBackend(page, owner());
  await signIn(page);
  await nav(page).getByRole('link', { name: 'Wallet', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Wallet', level: 1 })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Balance' })).toContainText('₹0.00');
  await expect(page.getByRole('region', { name: 'Balance' })).toContainText('Card money (withdrawals coming later)');
  await page.getByLabel('Amount to add (₹)').fill('50001');
  await page.getByRole('button', { name: 'Top up' }).click();
  await expect(page.getByText('The largest top-up at one time is ₹50,000.00.')).toBeVisible();
  await page.getByLabel('Amount to add (₹)').fill('500');
  await page.getByRole('button', { name: 'Top up' }).click();
  await expect(page.getByText('₹500.00 was added to your wallet.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Balance' })).toContainText('₹500.00');
  await expect(page.getByRole('region', { name: 'Top-ups' }).getByRole('row').filter({ hasText: '₹500.00' })).toContainText('Added');
  await expect(page.getByRole('region', { name: 'Wallet history' })).toContainText('Top-up (card / UPI)');
  const order = backend.calls.find((c) => c.method === 'POST' && c.path === '/partner-workspace/assisted/wallet/topups')!;
  expect(order.body).toMatchObject({ amountMinor: 50000 });
  expect(String((order.body as Rec).requestKey)).toMatch(/^[A-Za-z0-9]{32}$/);
  expect(backend.calls.some((c) => c.path === '/partner-workspace/assisted/payments/verify')).toBe(true);
  // The pharmacy's routes are never used for a lab.
  expect(backend.calls.some((c) => c.path.startsWith('/pharmacy-wallet'))).toBe(false);
});

test('a lost answer: the proof and the first check do not arrive; the top-up is found under Top-ups and checked once', async ({ page }) => {
  const backend = await mockBackend(page, owner());
  backend.loseVerifyAndCheck = true;
  await signIn(page);
  await page.goto('/#/partner/wallet');
  await page.getByLabel('Amount to add (₹)').fill('750');
  await page.getByRole('button', { name: 'Top up' }).click();
  await expect(page.getByText('We could not confirm the top-up yet', { exact: false })).toBeVisible();
  await expect(page.getByText('next to it under Top-ups', { exact: false })).toBeVisible();
  const row = page.getByRole('region', { name: 'Top-ups' }).getByRole('row').filter({ hasText: '₹750.00' });
  await expect(row).toContainText('Paid, not added yet');
  await row.getByRole('button', { name: /^Check my top-up/ }).click();
  await expect(row.getByText('₹750.00 was added to your wallet.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Balance' })).toContainText('₹750.00');
  expect(backend.entries).toHaveLength(1);
  expect(await stored(page)).not.toContain('750');
});

test('the wallet limit and the switch: refused in words before any payment page opens', async ({ page }) => {
  const backend = await mockBackend(page, owner());
  backend.full = true;
  await signIn(page);
  await page.goto('/#/partner/wallet');
  await page.getByLabel('Amount to add (₹)').fill('5000');
  await page.getByRole('button', { name: 'Top up' }).click();
  await expect(page.getByText('Could not start the top-up: The wallet can hold at most ₹50,000.00. You can add up to ₹2,000.00 now. No money was taken.')).toBeVisible();
  backend.full = false;
  backend.off = true;
  await page.getByRole('button', { name: 'Top up' }).click();
  await expect(page.getByText('Could not start the top-up: Adding money to the lab wallet is not switched on yet. No money was taken.')).toBeVisible();
  expect(backend.calls.some((c) => c.path.endsWith('/payments/verify'))).toBe(false);
});

test('permissions: wallet.view reads without adding money; a clinic has no wallet page', async ({ page }) => {
  const backend = await mockBackend(page, staff('wallet.view'));
  await signIn(page);
  await nav(page).getByRole('link', { name: 'Wallet', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Balance' })).toContainText('₹0.00');
  await expect(page.getByRole('region', { name: 'Add money' })).toHaveCount(0);

  backend.me = staff('bookings.view');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect(nav(page).getByRole('link', { name: 'Wallet', exact: true })).toHaveCount(0);

  backend.me = owner(CLINIC);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect(nav(page).getByRole('link', { name: 'Wallet', exact: true })).toHaveCount(0);
  const before = backend.calls.length;
  await page.goto('/#/partner/wallet');
  await expect(page.getByText('Page not found')).toBeVisible();
  expect(backend.calls.slice(before).some((c) => c.path.startsWith('/partner-workspace/assisted'))).toBe(false);
});

test('admin: the credit is once per key, a lost answer is resent with the same key and added once; the hold and its release', async ({ page }) => {
  const backend = await mockBackend(page, owner());
  await signIn(page, 'Admin');
  await page.goto(`/#/admin/partners/${LAB}`);
  await page.getByRole('link', { name: 'Wallet', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Wallet: City Lab' })).toBeVisible();
  const add = page.getByRole('form', { name: 'Add money to the wallet' });
  await expect(add).toContainText('or the lab could be paid twice');
  await add.getByLabel('Amount to add (₹)').fill('1000');
  await add.getByLabel('Why is the money added?').fill('Support credit');
  await add.getByRole('button', { name: 'Next: check before adding' }).click();
  backend.loseAdminAfter = true;
  await add.getByRole('button', { name: 'Yes, add ₹1,000.00' }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed money added' });
  await expect(panel).toContainText('₹1,000.00 may already be added to the wallet of City Lab');
  await panel.getByRole('button', { name: 'Send the same request again' }).click();
  await expect(page.getByText('₹1,000.00 was added to the wallet of City Lab', { exact: false })).toBeVisible();
  await expect(page.getByText('It was added once, even though it was sent more than once.', { exact: false })).toBeVisible();
  const credits = backend.calls.filter((c) => c.method === 'POST' && c.path === `/admin/labs/${LAB}/wallet/topup`);
  expect(credits).toHaveLength(2);
  expect(credits[0]!.key).toMatch(/^[A-Za-z0-9]{32}$/);
  expect(credits[1]!.key).toBe(credits[0]!.key);
  expect(credits[1]!.body).toEqual({ amountMinor: 100000, notes: 'Support credit' });
  expect(backend.entries.filter((e) => e.referenceType === 'topup')).toHaveLength(1);
  await expect(page.getByRole('region', { name: 'Balance' })).toContainText('₹1,000.00');
  await expect(page.getByRole('region', { name: 'Wallet history' })).toContainText('Support credit');

  await page.getByRole('button', { name: 'Put on hold' }).click();
  await page.getByLabel('Why is the wallet put on hold?').fill('Card dispute under review');
  await page.getByRole('button', { name: 'Yes, put it on hold' }).click();
  await expect(page.getByText('The wallet of City Lab is on hold', { exact: false })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Balance' })).toContainText('The wallet is on hold (Card dispute under review)');
  await page.getByRole('button', { name: 'Release the hold' }).click();
  await page.getByLabel('Why is the hold released?').fill('Resolved with the bank');
  await page.getByRole('button', { name: 'Yes, release it' }).click();
  await expect(page.getByText('The wallet of City Lab is released.')).toBeVisible();
  expect(backend.calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([
    { frozen: true, reason: 'Card dispute under review' }, { frozen: false, reason: 'Resolved with the bank' },
  ]);
});

test('WQ20b: a lost order answer: "Top up" asks again with the same key and amount (one order); paid but not credited is checked first', async ({ page }) => {
  const backend = await mockBackend(page, owner());
  backend.loseStartAfter = true;
  await signIn(page);
  await page.goto('/#/partner/wallet');
  await page.getByLabel('Amount to add (₹)').fill('600');
  await page.getByRole('button', { name: 'Top up' }).click();
  await expect(page.getByText('“Top up” asks for the same ₹600.00 again (never a second order).', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Amount to add (₹)')).toBeDisabled();
  backend.verifyNotCredited = true;
  await page.getByRole('button', { name: 'Top up' }).click();
  await expect(page.getByText('₹600.00 was added to your wallet.')).toBeVisible();
  const orders = backend.calls.filter((c) => c.method === 'POST' && c.path === '/partner-workspace/assisted/wallet/topups');
  expect(orders).toHaveLength(2);
  expect(orders[1]!.body).toEqual(orders[0]!.body);
  expect(backend.topups).toHaveLength(1);
  // Verify said paid but not credited: the server's check ran and added it once.
  const after = backend.calls.findIndex((c) => c.path.endsWith('/payments/verify'));
  expect(backend.calls.slice(after).some((c) => c.path.endsWith('/check'))).toBe(true);
  expect(backend.entries).toHaveLength(1);
  await expect(page.getByLabel('Amount to add (₹)')).toBeEnabled();
});

test('WQ20c: a lab member’s permissions cannot be saved until the lab is read, so the wallet access is never dropped', async ({ page }) => {
  const backend = await mockBackend(page, owner());
  backend.members = [
    { _id: OWNER, partnerId: LAB, name: 'Ravi Owner', phone: '9000000001', role: 'owner', permissions: ALL, branchIds: [], isActive: true, updatedAt: NOW.toISOString() },
    { _id: STAFF, partnerId: LAB, name: 'Sita Staff', phone: '9000000002', role: 'staff', permissions: ['bookings.view', 'wallet.view'], branchIds: [], isActive: true,
      updatedAt: NOW.toISOString() },
  ];
  backend.meDown = true;
  await signIn(page);
  await page.goto('/#/partner/staff');
  await page.getByRole('row').filter({ hasText: 'Sita Staff' }).getByRole('button', { name: 'Edit permissions' }).click();
  const editor = page.getByRole('region', { name: 'Permissions for Sita Staff' });
  await expect(editor.getByRole('button', { name: 'Save permissions' })).toBeDisabled();
  await expect(editor.getByRole('checkbox')).toHaveCount(0);
  backend.meDown = false;
  // The read is retried on its own (or by "Try again" once it has failed for good).
  const retry = editor.getByRole('button', { name: 'Try again' });
  if (await retry.isVisible()) await retry.click();
  await expect(editor.getByLabel('View the wallet')).toBeChecked({ timeout: 15_000 });
  await editor.getByLabel('Manage bookings').check();
  await editor.getByRole('button', { name: 'Save permissions' }).click();
  await expect.poll(() => backend.calls.find((c) => c.method === 'PUT' && c.path === `/partner-workspace/members/${STAFF}/permissions`)?.body)
    .toMatchObject({ permissions: expect.arrayContaining(['bookings.view', 'bookings.manage', 'wallet.view']) });
});
