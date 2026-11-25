import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * WQ29: wallet withdrawals to the bank (backend r32 round 4d, design §26.16.4; switched off on the server until allowed):
 * the pharmacy's "Withdraw to bank" (the quote with the card fee line, ask, list, cancel, the minimum, the weekly limit,
 * the switch off, a lost answer checked by key, payout details added here), the doctor's, and the admin's queue (mark paid
 * with the bank's reference, reject, void, a lost answer) and Recover after a card dispute. Mocked API; paise.
 */
const PH = 'aa'.repeat(12);
const DOC = 'd1'.repeat(12);
const ADMIN = 'ad'.repeat(12);
const LOT = 'b1'.repeat(12);
const NOW = new Date('2026-11-25T04:30:00.000Z');
const LATER = '2026-12-01T04:30:00.000Z';
const NEXT_WEEK = '2026-12-02T04:30:00.000Z';

type Json = Record<string, unknown>;
interface Backend {
  calls: { method: string; path: string; body: Json | null }[];
  enabled: boolean;
  nowMinor: number;
  nextAllowedAt: string | null;
  destination: { state: string; masked: string | null; detailsVersion: number };
  withdrawals: Json[];
  keys: Record<string, string>;
  loseNextRequest: boolean;
  weeklyOnRequest: boolean;
  losePaidNext: boolean;
  lots: Json[];
}
const rupees = (minor: number) => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const feeOf = (amount: number) => (amount === 100_000 ? 2_000 : 0);
const feeLine = (gross: number) => {
  const fee = feeOf(gross);
  return fee ? `Card fee on unspent card money: ${rupees(fee)}. You receive ${rupees(gross - fee)} of ${rupees(gross)}.` : `No card fee. You receive ${rupees(gross)}.`;
};
const withdrawal = (i: number, o: Json = {}): Json => {
  const gross = Number(o.grossMinor ?? 100_000);
  return { _id: `a${i}`.padEnd(24, '0'), walletKind: 'pharmacy', state: 'requested', grossMinor: gross, feeMinor: feeOf(gross), transferMinor: gross - feeOf(gross),
    feeLine: feeLine(gross), lots: [], destination: { masked: 'Bank ••••6789', detailsVersion: 3 }, paid: null, reason: null, version: 0,
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), walletRef: { kind: 'pharmacy', id: PH }, ...o };
};

async function mockBackend(page: Page, init: Partial<Backend> = {}): Promise<Backend> {
  await page.clock.setFixedTime(NOW);
  const b: Backend = { calls: [], enabled: true, nowMinor: 300_000, nextAllowedAt: null, destination: { state: 'verified', masked: 'Bank ••••6789', detailsVersion: 3 },
    withdrawals: [], keys: {}, loseNextRequest: false, weeklyOnRequest: false, losePaidNext: false,
    lots: [{ _id: LOT, paymentRecordId: 'c1'.repeat(12), amountMinor: 200_000, gatewayFeeMinor: 4_000, feeState: 'known', disputeState: 'none', closed: false,
      remainingMinor: 150_000, createdAt: '2026-11-10T05:00:00.000Z' }], ...init };
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const ok = (route: Route, data: unknown, status = 200, extra: Json = {}) => json(route, status, { success: true, data, ...extra });
  const refuse = (route: Route, status: number, code: string, details?: Json) => json(route, status, { error: status, code, message: code, ...(details ? { details } : {}) });
  let live: 'pharmacy' | 'specialist' | 'admin' | null = null;
  const token = { pharmacy: 'tp', specialist: 'td', admin: 'ta' };
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = req.method();
    const body = ['POST', 'PUT'].includes(method) ? (req.postDataJSON() as Json | null) : null;
    if (path === '/auth/session/refresh') {
      return live ? ok(route, { token: token[live], expiresIn: 900, principal: { userId: live === 'admin' ? ADMIN : live === 'specialist' ? DOC : PH, userType: live, sid: 's1' } })
        : refuse(route, 401, 'SESSION_ENDED');
    }
    if (path.startsWith('/auth/session')) return ok(route, {});
    b.calls.push({ method, path: `${path}${url.search}`, body });
    const signIn = /^\/auth\/(pharmacy|specialist|admin)\/(send|verify)$/.exec(path);
    if (signIn) {
      if (signIn[2] === 'send') return ok(route, undefined);
      live = signIn[1] as 'pharmacy' | 'specialist' | 'admin';
      return ok(route, { token: token[live], expiresIn: 900, user: {} });
    }
    const auth = req.headers().authorization;
    if (!live || auth !== `Bearer ${token[live]}`) return refuse(route, 401, 'UNAUTHORIZED');
    if (path === '/auth/profile') {
      return ok(route, live === 'admin' ? { user: { _id: ADMIN, name: 'Ops Admin' }, userRole: 'admin' }
        : live === 'specialist' ? { user: { _id: DOC, name: 'Dr Asha Mehta', isVerified: true, isActive: true }, userRole: 'specialist' }
        : { user: { _id: PH, name: 'Asha Medicals' }, userRole: 'pharmacy' });
    }
    // ── The owner's wallet and withdrawals (the pharmacy's base; the doctor's the same routes) ──
    if (path === '/pharmacy-wallet') return ok(route, { _id: 'w1', pharmacyId: PH, balance: b.nowMinor / 100, balancePaise: b.nowMinor, isActive: true, frozen: false, receivableMinor: 0 });
    if (path === '/pharmacy-wallet/transactions') return ok(route, [], 200, { pagination: { page: 1, limit: 20, total: 0, totalPages: 1 } });
    if (path === '/specialists/me/assisted/wallet') return ok(route, { balanceMinor: b.nowMinor, withdrawableMinor: 0, receivableMinor: 0, frozen: false, isActive: true, updatedAt: NOW.toISOString() });
    if (path === '/specialists/me/assisted/wallet/entries') return ok(route, [], 200, { pagination: { nextCursor: null } });
    const own = /^\/(?:pharmacy-assisted|specialists\/me\/assisted)\/wallet(\/.*)$/.exec(path);
    if (own) {
      const sub = own[1]!;
      if (sub === '/withdrawable') {
        const amount = Number(url.searchParams.get('amountMinor') ?? 0);
        return ok(route, { enabled: b.enabled, minimumMinor: 50_000, withdrawableNowMinor: b.nowMinor, availableLater: [{ amountMinor: 50_000, availableAt: LATER }],
          nextAllowedAt: b.nextAllowedAt, destination: b.destination,
          ...(amount ? { quote: { grossMinor: amount, feeMinor: feeOf(amount), transferMinor: amount - feeOf(amount), available: amount <= b.nowMinor } } : {}) });
      }
      if (sub === '/withdrawals' && method === 'POST') {
        if (!b.enabled) return refuse(route, 503, 'WITHDRAWALS_DISABLED');
        const key = String(body!.requestKey);
        const amount = Number(body!.amountMinor);
        if (b.keys[key]) return ok(route, { withdrawal: b.withdrawals.find((x) => x._id === b.keys[key]), wallet: {}, replayed: true });
        if (amount < 50_000) return refuse(route, 400, 'WITHDRAWAL_BELOW_MINIMUM', { minimumMinor: 50_000 });
        if (b.weeklyOnRequest) { b.nextAllowedAt = NEXT_WEEK; return refuse(route, 409, 'WITHDRAWAL_WEEKLY_LIMIT', { nextAllowedAt: NEXT_WEEK }); }
        const w = withdrawal(b.withdrawals.length + 1, { grossMinor: amount, destination: { masked: b.destination.masked, detailsVersion: body!.detailsVersion } });
        b.withdrawals.unshift(w);
        b.keys[key] = String(w._id);
        b.nowMinor -= amount;
        b.nextAllowedAt = NEXT_WEEK;
        if (b.loseNextRequest) { b.loseNextRequest = false; return route.abort('connectionreset'); }
        return ok(route, { withdrawal: w, wallet: { balanceMinor: b.nowMinor }, replayed: false }, 201);
      }
      if (sub === '/withdrawals') return ok(route, b.withdrawals, 200, { pagination: { nextCursor: null } });
      const byKey = /^\/withdrawals\/by-key\/([\w-]+)(\/abandon)?$/.exec(sub);
      if (byKey) {
        const id = b.keys[byKey[1]!];
        return ok(route, id ? { state: 'used', withdrawal: b.withdrawals.find((x) => x._id === id) } : byKey[2] ? { state: 'abandoned' } : { state: 'unknown' });
      }
      const cancel = /^\/withdrawals\/(\w{24})\/cancel$/.exec(sub);
      if (cancel) {
        const w = b.withdrawals.find((x) => x._id === cancel[1])!;
        Object.assign(w, { state: 'cancelled', version: Number(w.version) + 1 });
        b.nowMinor += Number(w.grossMinor);
        return ok(route, { withdrawal: w, wallet: {}, replayed: false });
      }
    }
    if (path === '/pharmacy-assisted/finance/payout-details' && method === 'PUT') {
      b.destination = { state: 'unverified', masked: 'UPI asha@okbank', detailsVersion: 1 };
      return ok(route, { _id: 'f1'.repeat(12), ownerKind: 'pharmacy_referral', ownerId: PH, payoutDetails: { method: 'upi', upiId: 'asha@okbank' }, payoutDetailsState: 'unverified',
        payoutDetailsVersion: 1 });
    }
    // ── Admin ──
    if (path === '/admin/wallet-withdrawals') {
      const state = url.searchParams.get('state');
      return ok(route, [...b.withdrawals].reverse().filter((x) => !state || x.state === state), 200, { pagination: { nextCursor: null } });
    }
    const adm = /^\/admin\/wallet-withdrawals\/(\w{24})(\/(reject|paid|void))?$/.exec(path);
    if (adm) {
      const w = b.withdrawals.find((x) => x._id === adm[1])!;
      if (!adm[2]) return ok(route, w);
      if (body!.expectedVersion !== w.version && !(adm[3] === 'paid' && w.state === 'paid')) return refuse(route, 409, 'WITHDRAWAL_CHANGED');
      if (adm[3] === 'paid') {
        if (w.state !== 'paid') Object.assign(w, { state: 'paid', version: Number(w.version) + 1, paid: { method: body!.method, reference: body!.reference, paidOn: body!.paidOn, at: NOW.toISOString() } });
        if (b.losePaidNext) { b.losePaidNext = false; return route.abort('connectionreset'); }
      } else Object.assign(w, { state: adm[3] === 'reject' ? 'rejected' : 'voided', version: Number(w.version) + 1, reason: body!.reason });
      return ok(route, { withdrawal: w });
    }
    if (path === `/pharmacies/${PH}`) return ok(route, { _id: PH, name: 'Asha Medicals', city: 'Pune', phone: '9000000001' });
    if (path === `/admin/pharmacies/${PH}/wallet/lots`) return ok(route, b.lots);
    const flag = /^\/admin\/wallet-lots\/(\w{24})\/(chargeback|recover)$/.exec(path);
    if (flag) {
      const lot = b.lots.find((x) => x._id === flag[1])!;
      if (flag[2] === 'chargeback') { lot.disputeState = 'lost'; return ok(route, { flagged: true, credited: true, replayed: false, lotId: LOT }); }
      if (lot.disputeState !== 'lost') return refuse(route, 409, 'DISPUTE_NOT_RECORDED');
      const replayed = !!lot.chargedBackAt;
      lot.chargedBackAt = NOW.toISOString();
      return ok(route, { recovered: true, replayed, lotId: LOT, paymentRecordId: lot.paymentRecordId, walletKind: 'pharmacy', withoutLot: false });
    }
    return refuse(route, 404, 'NOT_MOCKED');
  });
  return b;
}

async function signIn(page: Page, as: 'Pharmacy' | 'Doctor' | 'Admin' = 'Pharmacy') {
  await page.goto('/');
  if (as !== 'Pharmacy') await page.getByLabel(as, { exact: true }).check();
  await page.getByLabel('Mobile number').fill('9000000001');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}
const section = (page: Page) => page.getByRole('region', { name: 'Withdraw to bank' });
const posts = (b: Backend, end: string) => b.calls.filter((c) => c.method === 'POST' && c.path.endsWith(end));

test('the quote shows the card fee line before asking; asked for, listed, then cancelled back to the wallet', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await page.goto('/#/pharmacy/wallet');
  await expect(section(page)).toContainText('Withdrawable now');
  await expect(section(page)).toContainText('₹3,000.00');
  await expect(section(page)).toContainText('₹500.00 on'); // card money that becomes withdrawable later
  await expect(section(page)).toContainText('To: Bank ••••6789');
  await section(page).getByLabel('Amount to withdraw (₹)').fill('1000');
  await section(page).getByRole('button', { name: 'Next: see the fee' }).click();
  const review = page.getByRole('group', { name: 'Check and withdraw' });
  await expect(review).toContainText('Card fee on unspent card money: ₹20.00. You receive ₹980.00 of ₹1,000.00.');
  await review.getByRole('button', { name: 'Withdraw ₹1,000.00' }).click();
  await expect(section(page).getByText('Asked for: ₹980.00 goes to Bank ••••6789 once Jansetu pays it out.', { exact: false })).toBeVisible();
  const table = page.getByRole('table', { name: 'Withdrawals, newest first' });
  await expect(table).toContainText('Asked for');
  await expect(table).toContainText('Card fee on unspent card money: ₹20.00.');
  expect(posts(b, '/wallet/withdrawals')[0]!.body).toMatchObject({ amountMinor: 100_000, detailsVersion: 3 });
  expect(b.calls.some((c) => c.path === '/pharmacy-assisted/wallet/withdrawable?amountMinor=100000')).toBe(true);
  // One a week: the form is gone until then.
  await expect(section(page)).toContainText('You can ask for one withdrawal a week. The next one from');
  await table.getByRole('button', { name: 'Cancel' }).click();
  await table.getByRole('button', { name: 'Yes, cancel it' }).click();
  await expect(section(page).getByText('Cancelled. ₹1,000.00 is back in your wallet.')).toBeVisible();
  await expect(table).toContainText('Cancelled');
  expect(posts(b, '/cancel')[0]!.body).toEqual({ expectedVersion: 0 });
});

test('below the minimum or above what is withdrawable now: said before asking; nothing is sent', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await page.goto('/#/pharmacy/wallet');
  const amount = section(page).getByLabel('Amount to withdraw (₹)');
  await amount.fill('400');
  await section(page).getByRole('button', { name: 'Next: see the fee' }).click();
  await expect(section(page).getByText('The smallest withdrawal is ₹500.00.', { exact: true })).toBeVisible();
  await amount.fill('5000');
  await section(page).getByRole('button', { name: 'Next: see the fee' }).click();
  await expect(section(page).getByText('You can withdraw up to ₹3,000.00 now.')).toBeVisible();
  expect(posts(b, '/wallet/withdrawals')).toHaveLength(0);
});

test('the weekly limit: the server’s refusal is said with the next date, and then no form is offered', async ({ page }) => {
  const b = await mockBackend(page, { weeklyOnRequest: true });
  await signIn(page);
  await page.goto('/#/pharmacy/wallet');
  await section(page).getByLabel('Amount to withdraw (₹)').fill('600');
  await section(page).getByRole('button', { name: 'Next: see the fee' }).click();
  await expect(page.getByRole('group', { name: 'Check and withdraw' })).toContainText('No card fee. You receive ₹600.00.');
  await page.getByRole('button', { name: 'Withdraw ₹600.00' }).click();
  await expect(section(page).getByText(/^You can ask for one withdrawal a week\. The next one from /).first()).toBeVisible();
  await expect(section(page).getByLabel('Amount to withdraw (₹)')).toHaveCount(0);
  expect(b.withdrawals).toHaveLength(0);
});

test('switched off on the server: said plainly, and nothing to ask for', async ({ page }) => {
  await mockBackend(page, { enabled: false });
  await signIn(page);
  await page.goto('/#/pharmacy/wallet');
  await expect(section(page)).toContainText('Withdrawals to your bank are not open yet.');
  await expect(section(page).getByLabel('Amount to withdraw (₹)')).toHaveCount(0);
  await expect(section(page)).not.toContainText('Withdrawable now');
});

test('a lost answer and a reload: only the key is kept; Check finds it by key, never asked for twice', async ({ page }) => {
  const b = await mockBackend(page, { loseNextRequest: true });
  await signIn(page);
  await page.goto('/#/pharmacy/wallet');
  await section(page).getByLabel('Amount to withdraw (₹)').fill('1000');
  await section(page).getByRole('button', { name: 'Next: see the fee' }).click();
  await page.getByRole('button', { name: 'Withdraw ₹1,000.00' }).click();
  await expect(section(page).getByText(/The outcome of this withdrawal is not known yet/)).toBeVisible();
  await page.reload();
  await expect(section(page).getByText(/A withdrawal asked for earlier on this device was not confirmed/)).toBeVisible();
  await section(page).getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(section(page).getByText('It was recorded: ₹980.00 goes to Bank ••••6789 once Jansetu pays it out.')).toBeVisible();
  expect(posts(b, '/wallet/withdrawals')).toHaveLength(1);
  expect(b.calls.some((c) => c.path.startsWith('/pharmacy-assisted/wallet/withdrawals/by-key/'))).toBe(true);
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(stored).not.toContain('6789');
});

test('no payout details yet: the pharmacy adds them here; then they wait for Jansetu’s check', async ({ page }) => {
  const b = await mockBackend(page, { destination: { state: 'none', masked: null, detailsVersion: 0 } });
  await signIn(page);
  await page.goto('/#/pharmacy/wallet');
  await expect(section(page)).toContainText('Add the bank account or UPI ID to send the money to.');
  await expect(section(page).getByLabel('Amount to withdraw (₹)')).toHaveCount(0);
  await section(page).getByRole('button', { name: 'Add bank account or UPI ID' }).click();
  await section(page).getByLabel('UPI', { exact: true }).check();
  await section(page).getByLabel('UPI ID').fill('asha@okbank');
  await section(page).getByRole('button', { name: 'Review the change' }).click();
  await section(page).getByRole('button', { name: 'Save payout details' }).click();
  await expect(section(page).getByText('Saved. Jansetu checks these details before your first withdrawal.')).toBeVisible();
  await expect(section(page)).toContainText('Jansetu is checking your payout details (UPI asha@okbank).');
  const put = b.calls.find((c) => c.method === 'PUT' && c.path === '/pharmacy-assisted/finance/payout-details');
  expect(put?.body).toMatchObject({ method: 'upi', upiId: 'asha@okbank', expectedDetailsVersion: 0 });
});

test('a doctor’s wallet has the same section on its own routes', async ({ page }) => {
  const b = await mockBackend(page, { enabled: false });
  await signIn(page, 'Doctor');
  await page.goto('/#/doctor/wallet');
  await expect(section(page)).toContainText('Withdrawals to your bank are not open yet.');
  expect(b.calls.some((c) => c.path === '/specialists/me/assisted/wallet/withdrawable')).toBe(true);
});

test('admin: mark paid with the bank’s reference (a second step), reject with a reason, void a paid one', async ({ page }) => {
  const b = await mockBackend(page, { withdrawals: [withdrawal(2, { grossMinor: 60_000 }), withdrawal(1)] });
  await signIn(page, 'Admin');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Withdrawals', exact: true }).click();
  const table = page.getByRole('table', { name: 'Withdrawals, oldest first' });
  const first = table.getByRole('row').nth(1);
  await expect(first).toContainText('₹980.00');
  await first.getByRole('button', { name: 'Mark paid' }).click();
  const form = first.getByRole('group', { name: 'Mark the withdrawal paid' });
  await form.getByLabel('Bank reference (UTR)').fill('UTR');
  await form.getByRole('button', { name: 'Next: check' }).click();
  await expect(form.getByText('Enter the bank’s reference: 4 to 64 characters.')).toBeVisible();
  await form.getByLabel('Bank reference (UTR)').fill('UTR12345678');
  await form.getByRole('button', { name: 'Next: check' }).click();
  await expect(form).toContainText('Mark ₹980.00 to Bank ••••6789 as paid on 2026-11-25 with reference UTR12345678?');
  await form.getByRole('button', { name: 'Yes, mark it paid' }).click();
  await expect(table.getByRole('row')).toHaveCount(2); // the paid one leaves the waiting list
  const rest = table.getByRole('row').nth(1);
  await rest.getByRole('button', { name: 'Reject' }).click();
  await rest.getByLabel('Why is it rejected? (the owner sees it)').fill('Wrong account');
  await rest.getByRole('button', { name: 'Yes, reject it' }).click();
  await expect(page.getByText('No withdrawals here.')).toBeVisible();
  await page.getByLabel('Show').selectOption({ label: 'Paid' });
  const paid = table.getByRole('row').nth(1);
  await expect(paid).toContainText('Paid on 2026-11-25, reference UTR12345678');
  await paid.getByRole('button', { name: 'Void' }).click();
  await paid.getByLabel('Why is it voided? (the owner sees it)').fill('Returned by the bank');
  await paid.getByRole('button', { name: 'Yes, void it' }).click();
  await expect(page.getByText('No withdrawals here.')).toBeVisible();
  const admin = b.calls.filter((c) => c.method === 'POST' && c.path.startsWith('/admin/wallet-withdrawals/'));
  expect(admin.map((c) => c.path.split('/').pop())).toEqual(['paid', 'reject', 'void']);
  expect(admin[0]!.body).toMatchObject({ method: 'bank_transfer', reference: 'UTR12345678', paidOn: '2026-11-25', detailsVersion: 3, expectedVersion: 0 });
  expect(admin[1]!.body).toEqual({ reason: 'Wrong account', expectedVersion: 0 });
  expect(admin[2]!.body).toEqual({ reason: 'Returned by the bank', expectedVersion: 1 });
});

test('admin: a lost "mark paid" answer is checked by reading the withdrawal; sent once', async ({ page }) => {
  const b = await mockBackend(page, { withdrawals: [withdrawal(1)], losePaidNext: true });
  await signIn(page, 'Admin');
  await page.goto('/#/admin/withdrawals');
  const row = page.getByRole('table', { name: 'Withdrawals, oldest first' }).getByRole('row').nth(1);
  await row.getByRole('button', { name: 'Mark paid' }).click();
  await row.getByLabel('Bank reference (UTR)').fill('UTR12345678');
  await row.getByRole('button', { name: 'Next: check' }).click();
  await row.getByRole('button', { name: 'Yes, mark it paid' }).click();
  await expect(row.getByText(/The outcome of marking it paid is not known yet/)).toBeVisible();
  await row.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(page.getByText('No withdrawals here.')).toBeVisible();
  expect(b.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/paid'))).toHaveLength(1);
  expect(b.withdrawals[0]!.state).toBe('paid');
});

test('admin Recover on a pharmacy’s card top-up: the dispute is recorded first (flag only), then the money is taken back once', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page, 'Admin');
  await page.goto(`/#/admin/pharmacy-wallets/${PH}`);
  const lots = page.getByRole('region', { name: 'Card top-ups' });
  await expect(lots.getByRole('button', { name: 'Recover the money' })).toHaveCount(0);
  await lots.getByRole('button', { name: 'Record a card dispute' }).click();
  await lots.getByLabel('What did the bank say?').fill('Chargeback lost');
  await lots.getByRole('button', { name: 'Yes, record it' }).click();
  await expect(lots.getByText('Card dispute recorded on the ₹2,000.00 top-up. No money was taken from the wallet', { exact: false })).toBeVisible();
  await lots.getByRole('button', { name: 'Recover the money' }).click();
  await expect(lots.getByText('what is missing is owed to Jansetu, and the wallet is put on hold', { exact: false })).toBeVisible();
  await lots.getByLabel('Why? (kept with the record)').fill('Bank took it back');
  await lots.getByRole('button', { name: 'Yes, recover it' }).click();
  await expect(lots.getByText('Recovered: the ₹2,000.00 top-up was taken back from the wallet.')).toBeVisible();
  await expect(lots.getByText('Money taken back')).toBeVisible();
  await expect(lots.getByRole('button', { name: 'Recover the money' })).toHaveCount(0);
  const recover = b.calls.filter((c) => c.method === 'POST' && c.path === `/admin/wallet-lots/${LOT}/recover`);
  expect(recover).toHaveLength(1);
  expect(recover[0]!.body).toMatchObject({ reason: 'Bank took it back' });
});
