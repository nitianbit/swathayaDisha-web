import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * WQ29: wallet withdrawals to the bank (backend r32 round 4d, design §26.16.4; switched off on the server until allowed):
 * the pharmacy's "Withdraw to bank" (the quote with the card fee line, ask, list, cancel, the minimum, the weekly limit,
 * the switch off, a lost answer checked by key; WQ48: on the Finance page, with its payout details section), the doctor's, and the admin's queue (mark paid
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
  /** WQ29b (r32b): `WALLET_CHARGEBACK_FLAG_ONLY` on (a pharmacy's dispute is then flagged only; off, the default, it is taken). */
  flagOnly: boolean;
  /** The paid step finds a recorded dispute on the money the withdrawal holds (409 WITHDRAWAL_LOT_DISPUTED). */
  lotDisputed: boolean;
  /** The server works the fee out differently from the quote (the card money changed meanwhile). */
  feeShift: number;
  /** WQ48 (r35): the wallet is on hold (a quote's `reason` is WALLET_FROZEN). */
  frozen: boolean;
}
const rupees = (minor: number) => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const feeOf = (amount: number) => (amount === 100_000 ? 2_000 : 0);
const feeLine = (gross: number) => {
  const fee = feeOf(gross);
  return fee ? `Card fee on unspent card money: ${rupees(fee)}. You receive ${rupees(gross - fee)} of ${rupees(gross)}.` : `No card fee. You receive ${rupees(gross)}.`;
};
const withdrawal = (i: number, o: Json = {}): Json => {
  const gross = Number(o.grossMinor ?? 100_000);
  return { _id: `a${i}`.padStart(24, '0'), walletKind: 'pharmacy', state: 'requested', grossMinor: gross, feeMinor: feeOf(gross), transferMinor: gross - feeOf(gross),
    feeLine: feeLine(gross), lots: [], destination: { masked: 'Bank ••••6789', detailsVersion: 3 }, paid: null, reason: null, version: 0,
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), walletRef: { kind: 'pharmacy', id: PH }, ...o };
};

async function mockBackend(page: Page, init: Partial<Backend> = {}): Promise<Backend> {
  await page.clock.setFixedTime(NOW);
  const b: Backend = { calls: [], enabled: true, nowMinor: 300_000, nextAllowedAt: null, destination: { state: 'verified', masked: 'Bank ••••6789', detailsVersion: 3 },
    withdrawals: [], keys: {}, loseNextRequest: false, weeklyOnRequest: false, losePaidNext: false, flagOnly: false, lotDisputed: false, feeShift: 0, frozen: false,
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
        // r35/r35b: `reason` is the first refusal a request of this amount would meet now; `available` = it would go through.
        const reason = !b.enabled ? 'WITHDRAWALS_DISABLED' : amount < 50_000 ? 'BELOW_MINIMUM' : b.destination.state !== 'verified' ? 'DESTINATION_NOT_VERIFIED'
          : b.frozen ? 'WALLET_FROZEN' : b.nextAllowedAt ? 'WEEKLY_LIMIT' : amount > b.nowMinor ? 'ABOVE_WITHDRAWABLE' : null;
        return ok(route, { enabled: b.enabled, minimumMinor: 50_000, withdrawableNowMinor: b.nowMinor, availableLater: [{ amountMinor: 50_000, availableAt: LATER }],
          nextAllowedAt: b.nextAllowedAt, destination: { ...b.destination, details: null },
          ...(amount ? { quote: { grossMinor: amount, feeMinor: feeOf(amount), transferMinor: amount - feeOf(amount), available: reason === null, reason } } : {}) });
      }
      if (sub === '/withdrawals' && method === 'POST') {
        if (!b.enabled) return refuse(route, 503, 'WITHDRAWALS_DISABLED');
        const key = String(body!.requestKey);
        const amount = Number(body!.amountMinor);
        if (b.keys[key]) return ok(route, { withdrawal: b.withdrawals.find((x) => x._id === b.keys[key]), wallet: {}, replayed: true });
        if (amount < 50_000) return refuse(route, 400, 'WITHDRAWAL_BELOW_MINIMUM', { minimumMinor: 50_000 });
        if (b.weeklyOnRequest) { b.nextAllowedAt = NEXT_WEEK; return refuse(route, 409, 'WITHDRAWAL_WEEKLY_LIMIT', { nextAllowedAt: NEXT_WEEK }); }
        // r35: the fee on the card money held now; a transfer other than the one the person was shown is refused with the new quote.
        const fee = feeOf(amount) + b.feeShift;
        if (body!.expectedTransferMinor !== undefined && body!.expectedTransferMinor !== amount - fee) {
          return refuse(route, 409, 'WITHDRAWAL_QUOTE_CHANGED', { grossMinor: amount, feeMinor: fee, transferMinor: amount - fee });
        }
        const w = withdrawal(b.withdrawals.length + 1, { grossMinor: amount, destination: { masked: b.destination.masked, detailsVersion: body!.detailsVersion },
          ...(b.feeShift ? { feeMinor: fee, transferMinor: amount - fee } : {}) });
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
      // r35: refused while a withdrawal to the current details waits.
      if (b.withdrawals.some((x) => x.state === 'requested')) return refuse(route, 409, 'WITHDRAWAL_OPEN');
      b.destination = { state: 'unverified', masked: 'UPI asha@okbank', detailsVersion: b.destination.detailsVersion + 1 };
      return ok(route, { _id: 'f1'.repeat(12), ownerKind: 'pharmacy_referral', ownerId: PH, payoutDetails: { method: 'upi', upiId: 'asha@okbank' }, payoutDetailsState: 'unverified',
        payoutDetailsVersion: 1 });
    }
    // WQ48 (r35): the pharmacy's Finance page around the section (its blocks, an empty statement, its rates).
    if (path === '/pharmacy-assisted/finance') {
      return ok(route, { wallet: { balanceMinor: b.nowMinor, withdrawableNowMinor: b.nowMinor, availableLater: [{ amountMinor: 50_000, availableAt: LATER }], receivableMinor: 0, frozen: b.frozen },
        referral: { earnedMinor: 0, paidMinor: 0, dueMinor: 0, cutsEnabled: true, payoutsEnabled: false },
        withdrawals: { openCount: b.withdrawals.filter((x) => x.state === 'requested').length, lastPaidAt: null, enabled: b.enabled },
        payoutDetails: { ...b.destination, details: b.destination.masked?.startsWith('UPI') ? { method: 'upi', upiId: 'asha@okbank' }
          : b.destination.masked ? { method: 'bank', accountName: 'Asha Medicals', ifsc: 'HDFC0001234', accountNumberLast4: '6789', accountNumberMasked: 'XXXX6789' } : null } });
    }
    if (path === '/pharmacy-assisted/finance/statement') return ok(route, [], 200, { pagination: { nextCursor: null } });
    if (path === '/pharmacy-assisted/referral-rules') return ok(route, [], 200, { switches: { cutsEnabled: true, payoutsEnabled: false } });
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
      if (adm[3] === 'paid' && b.lotDisputed && body!.disputeAcknowledged !== true) return refuse(route, 409, 'WITHDRAWAL_LOT_DISPUTED');
      if (adm[3] === 'paid') {
        if (w.state !== 'paid') {
          Object.assign(w, { state: 'paid', version: Number(w.version) + 1, paid: { method: body!.method, reference: body!.reference, paidOn: body!.paidOn, at: NOW.toISOString(),
            ...(b.lotDisputed ? { disputeAcknowledged: true, disputedMinor: Number(w.grossMinor) } : {}) } });
        }
        if (b.losePaidNext) { b.losePaidNext = false; return route.abort('connectionreset'); }
      } else Object.assign(w, { state: adm[3] === 'reject' ? 'rejected' : 'voided', version: Number(w.version) + 1, reason: body!.reason });
      return ok(route, { withdrawal: w });
    }
    if (path === `/pharmacies/${PH}`) return ok(route, { _id: PH, name: 'Asha Medicals', city: 'Pune', phone: '9000000001' });
    if (path === `/admin/pharmacies/${PH}/wallet/lots`) return ok(route, b.lots);
    const flag = /^\/admin\/wallet-lots\/(\w{24})\/(chargeback|recover)$/.exec(path);
    if (flag) {
      const lot = b.lots.find((x) => x._id === flag[1])!;
      if (flag[2] === 'chargeback') {
        lot.disputeState = 'lost';
        if (b.flagOnly) return ok(route, { flagged: true, credited: true, replayed: false, lotId: LOT });
        // r32b: with the flag-only switch off (the default) a pharmacy's lost dispute is taken at once (the production answer).
        lot.chargedBackAt = NOW.toISOString();
        return ok(route, { entry: { _id: 'e9'.repeat(12), kind: 'chargeback', amountMinor: 150_000 }, wallet: { balancePaise: 0, receivableMinor: 50_000, frozen: true }, replayed: false });
      }
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
  await page.goto('/#/pharmacy/finance');
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
  await page.goto('/#/pharmacy/finance');
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
  await page.goto('/#/pharmacy/finance');
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
  await page.goto('/#/pharmacy/finance');
  await expect(section(page)).toContainText('Withdrawals to your bank are not open yet.');
  await expect(section(page).getByLabel('Amount to withdraw (₹)')).toHaveCount(0);
  await expect(section(page)).not.toContainText('Withdrawable now');
});

test('a lost answer and a reload: only the key is kept; Check finds it by key, never asked for twice', async ({ page }) => {
  const b = await mockBackend(page, { loseNextRequest: true });
  await signIn(page);
  await page.goto('/#/pharmacy/finance');
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

test('no payout details yet: the pharmacy adds them under Payout details on the Finance page; then they wait for Jansetu’s check', async ({ page }) => {
  const b = await mockBackend(page, { destination: { state: 'none', masked: null, detailsVersion: 0 } });
  await signIn(page);
  await page.goto('/#/pharmacy/finance');
  await expect(section(page)).toContainText('Add your bank account or UPI ID under “Payout details” on this page first.');
  await expect(section(page).getByLabel('Amount to withdraw (₹)')).toHaveCount(0);
  const details = page.getByRole('region', { name: 'Payout details' });
  await expect(details).toContainText('No payout details yet.');
  await details.getByRole('button', { name: 'Add payout details' }).click();
  await details.getByLabel('UPI', { exact: true }).check();
  await details.getByLabel('UPI ID').fill('asha@okbank');
  await details.getByRole('button', { name: 'Review the change' }).click();
  await details.getByRole('button', { name: 'Save payout details' }).click();
  await expect(details.getByText('Saved. Jansetu checks these details before your next withdrawal.')).toBeVisible();
  await expect(details).toContainText('UPI asha@okbank Waiting for verification');
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
  // WQ29c: what was done is said above the list (by a short ref, no one's details) once its row has gone.
  await expect(page.getByText('Marked paid: ref 0000A1, ₹980.00.')).toBeVisible();
  const rest = table.getByRole('row').nth(1);
  await rest.getByRole('button', { name: 'Reject' }).click();
  await rest.getByLabel('Why is it rejected? (the owner sees it)').fill('Wrong account');
  await rest.getByRole('button', { name: 'Yes, reject it' }).click();
  await expect(page.getByText('No withdrawals here.')).toBeVisible();
  await expect(page.getByText('Rejected: ref 0000A2, ₹600.00 back in the wallet.')).toBeVisible();
  await page.getByLabel('Show').selectOption({ label: 'Paid' });
  const paid = table.getByRole('row').nth(1);
  await expect(paid).toContainText('Paid on 2026-11-25, reference UTR12345678');
  await paid.getByRole('button', { name: 'Void' }).click();
  await paid.getByLabel('Why is it voided? (the owner sees it)').fill('Returned by the bank');
  await paid.getByRole('button', { name: 'Yes, void it' }).click();
  await expect(page.getByText('No withdrawals here.')).toBeVisible();
  await expect(page.getByText('Voided: ref 0000A1, ₹1,000.00 back in the wallet.')).toBeVisible();
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

test('admin Recover on a pharmacy’s card top-up (the flag-only switch on): the dispute is flagged first, then the money is taken back once', async ({ page }) => {
  const b = await mockBackend(page, { flagOnly: true });
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

// ── WQ29b (review of 313979a; backend r32b §26.17.7) ──

test('WQ29b: a pharmacy’s card dispute (flag-only switch off, the default) says the money is taken now, and says it was taken', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page, 'Admin');
  await page.goto(`/#/admin/pharmacy-wallets/${PH}`);
  const lots = page.getByRole('region', { name: 'Card top-ups' });
  await lots.getByRole('button', { name: 'Record a card dispute' }).click();
  await expect(lots.getByText('The money is taken back from the wallet now', { exact: false })).toBeVisible();
  await expect(lots.getByText('Nothing is taken from the wallet', { exact: false })).toHaveCount(0);
  await lots.getByLabel('What did the bank say?').fill('Chargeback lost');
  await lots.getByRole('button', { name: 'Yes, record it' }).click();
  await expect(lots.getByText('Card dispute recorded on the ₹2,000.00 top-up, and the money was taken back from the wallet', { exact: false })).toBeVisible();
  await expect(lots.getByText('Money taken back')).toBeVisible();
  await expect(lots.getByRole('button', { name: 'Recover the money' })).toHaveCount(0);
  expect(b.calls.filter((c) => c.path.endsWith('/recover'))).toHaveLength(0);
});

test('WQ48: Mark paid refused on disputed money: reject it, or (the transfer went out) mark it paid acknowledging the dispute', async ({ page }) => {
  const b = await mockBackend(page, { withdrawals: [withdrawal(1)], lotDisputed: true });
  await signIn(page, 'Admin');
  await page.goto('/#/admin/withdrawals');
  const row = page.getByRole('table', { name: 'Withdrawals, oldest first' }).getByRole('row').nth(1);
  await row.getByRole('button', { name: 'Mark paid' }).click();
  await row.getByLabel('Bank reference (UTR)').fill('UTR12345678');
  await row.getByRole('button', { name: 'Next: check' }).click();
  await row.getByRole('button', { name: 'Yes, mark it paid' }).click();
  await expect(row.getByText('A card dispute was recorded on money this withdrawal holds. Reject it, unless the bank transfer already went out.')).toBeVisible();
  await expect(row.getByRole('button', { name: 'Reject' })).toBeVisible();
  // Offered only after the server's refusal, behind a second step that says what it means.
  await row.getByRole('button', { name: 'The bank transfer already went out' }).click();
  await expect(row.getByText('Then recover the disputed card top-up on the wallet page', { exact: false })).toBeVisible();
  await row.getByRole('button', { name: 'Yes, mark it paid' }).click();
  await expect(page.getByText('Marked paid: ref 0000A1, ₹980.00.')).toBeVisible();
  const paid = b.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/paid'));
  expect(paid).toHaveLength(2);
  expect(paid[0]!.body).not.toHaveProperty('disputeAcknowledged');
  expect(paid[1]!.body).toMatchObject({ reference: 'UTR12345678', disputeAcknowledged: true });
  expect(paid[1]!.body!.requestKey).not.toBe(paid[0]!.body!.requestKey);
  await page.getByLabel('Show').selectOption({ label: 'Paid' });
  await expect(page.getByRole('table', { name: 'Withdrawals, oldest first' })).toContainText('Paid after a card dispute: ₹1,000.00 is owed back.');
});

test('WQ48: without a refusal, Mark paid never offers to acknowledge a dispute', async ({ page }) => {
  await mockBackend(page, { withdrawals: [withdrawal(1)] });
  await signIn(page, 'Admin');
  await page.goto('/#/admin/withdrawals');
  const row = page.getByRole('table', { name: 'Withdrawals, oldest first' }).getByRole('row').nth(1);
  await row.getByRole('button', { name: 'Mark paid' }).click();
  await expect(row.getByRole('button', { name: 'The bank transfer already went out' })).toHaveCount(0);
});

test('WQ48: the fee moved since the check: nothing is withdrawn, the new quote is shown and confirmed again; a resent request no longer waiting says its state', async ({ page }) => {
  const b = await mockBackend(page, { feeShift: 1_000 });
  await signIn(page);
  await page.goto('/#/pharmacy/finance');
  await section(page).getByLabel('Amount to withdraw (₹)').fill('1000');
  await section(page).getByRole('button', { name: 'Next: see the fee' }).click();
  const review = page.getByRole('group', { name: 'Check and withdraw' });
  await expect(review).toContainText('Card fee on unspent card money: ₹20.00.');
  await page.getByRole('button', { name: 'Withdraw ₹1,000.00' }).click();
  await expect(section(page).getByText('The card fee changed since you checked. Nothing was withdrawn.', { exact: false })).toBeVisible();
  await expect(review).toContainText('Card fee on unspent card money: ₹30.00. You receive ₹970.00 of ₹1,000.00.');
  expect(b.withdrawals).toHaveLength(0);
  await page.getByRole('button', { name: 'Withdraw ₹1,000.00' }).click();
  await expect(section(page).getByText('Asked for: ₹970.00 goes to Bank ••••6789 once Jansetu pays it out.', { exact: false })).toBeVisible();
  const asked = posts(b, '/wallet/withdrawals');
  expect(asked.map((c) => c.body!.expectedTransferMinor)).toEqual([98_000, 97_000]);
  expect(asked[1]!.body!.requestKey).not.toBe(asked[0]!.body!.requestKey);

  // A lost answer, then the same request sent again after that withdrawal was cancelled elsewhere.
  b.feeShift = 0;
  b.nextAllowedAt = null;
  b.loseNextRequest = true;
  await page.reload();
  await section(page).getByLabel('Amount to withdraw (₹)').fill('600');
  await section(page).getByRole('button', { name: 'Next: see the fee' }).click();
  await page.getByRole('button', { name: 'Withdraw ₹600.00' }).click();
  await expect(section(page).getByText(/The outcome of this withdrawal is not known yet/)).toBeVisible();
  Object.assign(b.withdrawals[0]!, { state: 'cancelled', version: 1 });
  await section(page).getByRole('button', { name: 'Send the same request again' }).click();
  await expect(section(page).getByText('This request was already recorded earlier. It is now: Cancelled.')).toBeVisible();
  expect(posts(b, '/wallet/withdrawals')).toHaveLength(4);
});

test('WQ48: a quoted amount the server would refuse is said with its reason (the wallet on hold)', async ({ page }) => {
  const b = await mockBackend(page, { frozen: true });
  await signIn(page);
  await page.goto('/#/pharmacy/finance');
  await section(page).getByLabel('Amount to withdraw (₹)').fill('1000');
  await section(page).getByRole('button', { name: 'Next: see the fee' }).click();
  await expect(section(page).getByText('The wallet is on hold, so nothing can be withdrawn. Please contact Jansetu support.')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Check and withdraw' })).toHaveCount(0);
  expect(posts(b, '/wallet/withdrawals')).toHaveLength(0);
});

test('WQ48: payout details cannot change while a withdrawal to them waits: cancel it first', async ({ page }) => {
  const b = await mockBackend(page, { withdrawals: [withdrawal(1)] });
  await signIn(page);
  await page.goto('/#/pharmacy/finance');
  const details = page.getByRole('region', { name: 'Payout details' });
  await expect(details).toContainText('Bank ••••6789 Verified');
  await details.getByRole('button', { name: 'Change payout details' }).click();
  // Prefilled from the masked details: the name and IFSC; the account number is typed again.
  await expect(details.getByLabel('Account holder name')).toHaveValue('Asha Medicals');
  await expect(details.getByLabel('IFSC')).toHaveValue('HDFC0001234');
  await expect(details.getByLabel('Account number', { exact: true })).toHaveValue('');
  await details.getByLabel('Account number', { exact: true }).fill('123456789012');
  await details.getByLabel('Account number again').fill('123456789012');
  await details.getByRole('button', { name: 'Review the change' }).click();
  await details.getByRole('button', { name: 'Save payout details' }).click();
  await expect(details.getByText('A withdrawal to these details is waiting. Cancel the waiting withdrawal first, then change them.')).toBeVisible();
  expect(b.destination.state).toBe('verified');
  expect(b.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
});
