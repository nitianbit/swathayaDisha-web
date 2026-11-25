import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * WQ48: the 4f finance screens (backend r35 rounds 4e/4f, design §26.10 and §26.18.3; r35b shapes), against a mocked API:
 * the pharmacy's Finance page (three tiles, Withdraw, payout details, one statement with Wallet / Referral earnings and its
 * CSV, its rates; the old Referral earnings page folded in), a lab's and a doctor's referral and withdrawals tiles, the
 * admin's card disputes, older card top-ups without a lot, the owed amount paid from referral earnings (one owned
 * request), referral accounts paused until tax advice and paid to their home account, and a branch-limited lab manager.
 */
const PH = 'aa'.repeat(12);
const LAB = 'c1'.repeat(12);
const CLINIC = 'c2'.repeat(12);
const OWNER = 'c9'.repeat(12);
const DOC = 'd1'.repeat(12);
const ADMIN = 'ad'.repeat(12);
const LOT = 'b1'.repeat(12);
const PAY = 'e1'.repeat(12);
const PAY2 = 'e2'.repeat(12);
const REF_ACC = 'f1'.repeat(12);
const HOME_ACC = 'f2'.repeat(12);
const NOW = new Date('2026-11-25T04:30:00.000Z');
const LATER = '2026-12-01T04:30:00.000Z';
const CSV_HEADER = '"Date (IST)","Type","Description","Reference","Note","Amount (INR)","Balance (INR)"';
const ALL = ['staff.manage', 'branches.manage', 'catalogue.manage', 'slots.manage', 'bookings.view', 'bookings.manage', 'reports.upload',
  'finance.view', 'wallet.view', 'wallet.manage', 'assisted.book'];

type Json = Record<string, unknown>;
type Who = 'pharmacy' | 'partner' | 'specialist' | 'admin';
interface Me { _id: string; partnerId: string; name: string; role: 'owner' | 'staff'; permissions: string[]; branchIds: string[] }
interface Backend {
  calls: { method: string; path: string; body: Json | null }[];
  me: Me;
  /** REFERRAL_PAYOUTS_ENABLED. */
  payoutsOn: boolean;
  /** What the admin pharmacy wallet owes (paise). */
  receivableMinor: number;
  referralDueMinor: number;
  setOffKeys: Record<string, number>;
  loseNextSetOff: boolean;
  disputes: Json[];
  noLot: Json[];
  recovered: string[];
  labWithdrawals: Json[];
}

const walletRows = (): Json[] => [
  { _id: 'a3'.padStart(24, '0'), transactionType: 'debit', movementType: 'booking_debit', amountPaise: 50_000, signedAmountPaise: -50_000, balanceAfterPaise: 300_000,
    createdAt: '2026-11-24T06:00:00.000Z', status: 'completed' },
  // r35b: an owed amount paid from referral earnings moves no wallet money.
  { _id: 'a2'.padStart(24, '0'), transactionType: 'adjustment', movementType: 'receivable_setoff', referenceType: 'referral_setoff', amountPaise: 5_000, signedAmountPaise: 0,
    balanceAfterPaise: 350_000, createdAt: '2026-11-23T06:00:00.000Z', status: 'completed' },
  { _id: 'a1'.padStart(24, '0'), transactionType: 'credit', movementType: 'credit', referenceType: 'wallet_recharge', amountPaise: 350_000, signedAmountPaise: 350_000,
    balanceAfterPaise: 350_000, createdAt: '2026-11-20T06:00:00.000Z', status: 'completed' },
];
const olderWalletRow = { _id: 'a0'.padStart(24, '0'), transactionType: 'credit', movementType: 'credit', amountPaise: 10_000, signedAmountPaise: 10_000, balanceAfterPaise: 10_000,
  createdAt: '2026-11-01T06:00:00.000Z', status: 'completed' };
const referralRows = (): Json[] => [
  { _id: 'r1'.padStart(24, '0'), at: '2026-11-24T06:00:00.000Z', kind: 'earning', source: 'referral_consultation', sourceId: 'x'.repeat(24),
    description: 'Referral · consultation · Ref ABCD2345', amountMinor: 5_000, balanceAfterMinor: 160_500, grossMinor: 50_000, commissionMinor: 0, shortRef: 'ABCD2345', category: 'consultation' },
];

async function mockBackend(page: Page, init: Partial<Backend> = {}): Promise<Backend> {
  await page.clock.setFixedTime(NOW);
  const b: Backend = { calls: [], me: { _id: OWNER, partnerId: LAB, name: 'Ravi Owner', role: 'owner', permissions: ALL, branchIds: [] }, payoutsOn: false,
    receivableMinor: 20_000, referralDueMinor: 155_500, setOffKeys: {}, loseNextSetOff: false, recovered: [], labWithdrawals: [],
    disputes: [
      { paymentRecordId: PAY, walletKind: 'pharmacy', ownerId: PH, lotId: LOT, amountMinor: 200_000, remainingMinor: 150_000, state: 'flagged', chargebackAt: '2026-11-24T05:00:00.000Z', recoveredAt: null, at: '2026-11-24T05:00:00.000Z' },
      { paymentRecordId: PAY2, walletKind: 'lab', ownerId: LAB, lotId: null, amountMinor: 80_000, remainingMinor: null, state: 'flagged', chargebackAt: '2026-11-23T05:00:00.000Z', recoveredAt: null, at: '2026-11-23T05:00:00.000Z' },
      { paymentRecordId: 'e3'.repeat(12), walletKind: 'doctor', ownerId: DOC, lotId: 'b3'.repeat(12), amountMinor: 40_000, remainingMinor: 0, state: 'recovered', chargebackAt: '2026-11-20T05:00:00.000Z', recoveredAt: '2026-11-21T05:00:00.000Z', at: '2026-11-21T05:00:00.000Z' },
      { paymentRecordId: 'e4'.repeat(12), walletKind: 'pharmacy', ownerId: PH, lotId: null, amountMinor: 30_000, remainingMinor: null, state: 'blocked', chargebackAt: '2026-11-19T05:00:00.000Z', recoveredAt: null, at: '2026-11-19T05:00:00.000Z' },
    ],
    noLot: [
      { paymentRecordId: PAY2, walletKind: 'pharmacy', ownerId: PH, razorpayPaymentId: 'pay_X', amountMinor: 80_000, paidAt: '2026-10-01T05:00:00.000Z', creditedAt: '2026-10-01T05:01:00.000Z', chargebackAt: '2026-11-23T05:00:00.000Z' },
      { paymentRecordId: 'e5'.repeat(12), walletKind: 'pharmacy', ownerId: PH, razorpayPaymentId: 'pay_Y', amountMinor: 60_000, paidAt: '2026-09-01T05:00:00.000Z', creditedAt: '2026-09-01T05:01:00.000Z', chargebackAt: null },
    ],
    ...init };
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const ok = (route: Route, data: unknown, status = 200, extra: Json = {}) => json(route, status, { success: true, data, ...extra });
  const refuse = (route: Route, status: number, code: string, details?: Json) => json(route, status, { error: status, code, message: code, ...(details ? { details } : {}) });
  const csv = (route: Route) => route.fulfill({ status: 200, contentType: 'text/csv; charset=utf-8', body: `${CSV_HEADER}\n"","Opening balance","","","","","0.00"\n` });
  const empty = (route: Route) => ok(route, [], 200, { pagination: { nextCursor: null } });
  const referral = () => ({ earnedMinor: 160_500, paidMinor: 0, setOffMinor: 5_000, dueMinor: b.referralDueMinor, cutsEnabled: true, payoutsEnabled: b.payoutsOn });
  const labPartner = { _id: LAB, kind: 'lab', name: 'City Lab', contact: { phone: '9000000000' }, verification: { state: 'verified' }, activeOwnerCount: 1, isActive: true };
  const clinicPartner = { ...labPartner, _id: CLINIC, kind: 'clinic', name: 'Sunrise Clinic' };
  const account = (o: Json = {}) => ({ _id: 'f9'.repeat(12), ownerKind: 'partner', ownerId: LAB, beneficiaryName: 'City Lab', isActive: true, payoutDetails: null,
    payoutDetailsState: 'none', payoutDetailsVersion: 0, financeVersion: 0, ...o });
  const totals = { earnedMinor: 0, reversedMinor: 0, paidOutMinor: 0, adjustedMinor: 0 };
  let live: Who | null = null;
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = req.method();
    const body = ['POST', 'PUT'].includes(method) ? (req.postDataJSON() as Json | null) : null;
    if (path === '/auth/session/refresh') {
      return live ? ok(route, { token: `t-${live}`, expiresIn: 900, principal: { userId: live === 'admin' ? ADMIN : live === 'specialist' ? DOC : live === 'partner' ? b.me._id : PH, userType: live, sid: 's1' } })
        : refuse(route, 401, 'SESSION_ENDED');
    }
    if (path.startsWith('/auth/session')) return ok(route, {});
    b.calls.push({ method, path: `${path}${url.search}`, body });
    const signIn = /^\/auth\/(pharmacy|specialist|admin|partner)\/(send|verify)$/.exec(path);
    if (signIn) {
      if (signIn[2] === 'send') return ok(route, undefined);
      live = signIn[1] as Who;
      return ok(route, { token: `t-${live}`, expiresIn: 900, user: {} });
    }
    if (!live || req.headers().authorization !== `Bearer t-${live}`) return refuse(route, 401, 'UNAUTHORIZED');
    if (path === '/auth/profile') {
      return ok(route, live === 'admin' ? { user: { _id: ADMIN, name: 'Ops Admin' }, userRole: 'admin' }
        : live === 'specialist' ? { user: { _id: DOC, name: 'Dr Asha Mehta', isVerified: true, isActive: true }, userRole: 'specialist' }
        : live === 'partner' ? { user: { ...b.me, phone: '9000000001', isActive: true }, partner: b.me.partnerId === LAB ? labPartner : clinicPartner, userRole: 'partner' }
        : { user: { _id: PH, name: 'Asha Medicals' }, userRole: 'pharmacy' });
    }

    // ── Pharmacy ──
    if (live === 'pharmacy') {
      if (path === '/pharmacy-assisted/finance') {
        return ok(route, { wallet: { balanceMinor: 300_000, withdrawableNowMinor: 250_000, availableLater: [{ amountMinor: 50_000, availableAt: LATER }], receivableMinor: 0, frozen: false },
          referral: referral(), withdrawals: { openCount: 0, lastPaidAt: null, enabled: false },
          payoutDetails: { state: 'verified', masked: 'HDFC0001234 XXXX6789', detailsVersion: 2,
            details: { method: 'bank', accountName: 'Asha Medicals', ifsc: 'HDFC0001234', accountNumberLast4: '6789', accountNumberMasked: 'XXXX6789' } } });
      }
      if (path === '/pharmacy-assisted/finance/statement') {
        const kind = url.searchParams.get('kind');
        if (kind === 'referral') return ok(route, referralRows(), 200, { pagination: { nextCursor: null } });
        const before = url.searchParams.get('before');
        return before ? ok(route, [olderWalletRow], 200, { pagination: { nextCursor: null } })
          : ok(route, walletRows(), 200, { pagination: { nextCursor: `${Date.parse('2026-11-20T06:00:00.000Z')}_${'a1'.padStart(24, '0')}` } });
      }
      if (path === '/pharmacy-assisted/finance/statement.csv') return csv(route);
      if (path === '/pharmacy-assisted/referral-rules') {
        return ok(route, [{ _id: 'r9'.padStart(24, '0'), category: 'consultation', basis: 'percent', percentBasisPoints: 1000, fixedMinor: null, capMinor: null, isActive: true,
          version: 1, updatedAt: '2026-11-20T05:00:00.000Z', effective: true }], 200, { switches: { cutsEnabled: true, payoutsEnabled: b.payoutsOn } });
      }
      if (path === '/pharmacy-assisted/wallet/withdrawable') {
        return ok(route, { enabled: false, minimumMinor: 50_000, withdrawableNowMinor: 250_000, availableLater: [], nextAllowedAt: null,
          destination: { state: 'verified', masked: 'HDFC0001234 XXXX6789', detailsVersion: 2, details: null } });
      }
      if (path === '/pharmacy-wallet') return ok(route, { _id: 'w1', pharmacyId: PH, balance: 3000, balancePaise: 300_000, isActive: true, frozen: false, receivableMinor: 0 });
      if (path === '/pharmacy-wallet/transactions') return ok(route, [], 200, { pagination: { page: 1, limit: 20, total: 0, totalPages: 1 } });
    }

    // ── Lab or clinic member ──
    if (live === 'partner') {
      if (path === '/partner-workspace/me') return ok(route, b.me.partnerId === LAB ? labPartner : clinicPartner);
      if (path === '/partner-workspace/finance') {
        const lab = b.me.partnerId === LAB;
        return ok(route, { account: account({ ownerId: b.me.partnerId }), balanceMinor: 0, totals, lastPayout: null,
          referral: lab ? referral() : null, withdrawals: lab ? { openCount: 1, lastPaidAt: '2026-11-18T06:00:00.000Z', enabled: true } : null });
      }
      if (path === '/partner-workspace/finance/statement') return ok(route, { lines: [], nextCursor: null });
      if (/^\/partner-workspace\/finance\/(payouts|events)$/.test(path)) return empty(route);
      const as = /^\/partner-workspace\/assisted\/wallet(\/.*)?$/.exec(path);
      if (as) {
        const sub = as[1] ?? '';
        if (sub === '') return ok(route, { balanceMinor: 300_000, withdrawableMinor: 300_000, receivableMinor: 0, frozen: false, isActive: true, updatedAt: NOW.toISOString() });
        if (sub === '/entries' || sub === '/topups') return empty(route);
        if (sub === '/withdrawable') {
          return ok(route, { enabled: true, minimumMinor: 50_000, withdrawableNowMinor: 300_000, availableLater: [], nextAllowedAt: null,
            destination: { state: 'verified', masked: 'HDFC0001234 XXXX4321', detailsVersion: 1, details: null } });
        }
        if (sub === '/withdrawals' && method === 'GET') return ok(route, b.labWithdrawals, 200, { pagination: { nextCursor: null } });
        const cancel = /^\/withdrawals\/(\w{24})\/cancel$/.exec(sub);
        if (cancel) {
          const w = b.labWithdrawals.find((x) => x._id === cancel[1])!;
          Object.assign(w, { state: 'cancelled', version: Number(w.version) + 1 });
          return ok(route, { withdrawal: w, wallet: {}, replayed: false });
        }
      }
    }

    // ── Doctor ──
    if (live === 'specialist' && path === '/specialists/me/finance') {
      return ok(route, { account: null, balanceMinor: 0, totals, lastPayout: null, referral: { ...referral(), earnedMinor: 0, setOffMinor: 0, dueMinor: 0 },
        withdrawals: { openCount: 0, lastPaidAt: null, enabled: false } });
    }

    // ── Admin ──
    if (live === 'admin') {
      if (path === '/admin/wallet-disputes') {
        const state = url.searchParams.get('state');
        return ok(route, b.disputes.filter((d) => !state || d.state === state));
      }
      const rec = /^\/admin\/(wallet-lots|wallet-payments)\/(\w{24})\/recover$/.exec(path);
      if (rec) {
        const d = b.disputes.find((x) => (rec[1] === 'wallet-lots' ? x.lotId : x.paymentRecordId) === rec[2]);
        const nl = b.noLot.find((x) => x.paymentRecordId === rec[2]);
        if (rec[1] === 'wallet-payments' && nl && !nl.chargebackAt) return refuse(route, 409, 'DISPUTE_NOT_RECORDED');
        const replayed = b.recovered.includes(rec[2]!);
        b.recovered.push(rec[2]!);
        if (d) Object.assign(d, { state: 'recovered', recoveredAt: NOW.toISOString() });
        return ok(route, { recovered: true, replayed, lotId: rec[1] === 'wallet-lots' ? rec[2] : null, paymentRecordId: rec[2], walletKind: 'pharmacy', withoutLot: rec[1] === 'wallet-payments' });
      }
      if (path === `/pharmacies/${PH}`) return ok(route, { _id: PH, name: 'Asha Medicals', city: 'Pune', phone: '9000000001' });
      if (path === '/pharmacy-wallet') return ok(route, { _id: 'w1', pharmacyId: PH, balance: 0, balancePaise: 0, isActive: true, frozen: b.receivableMinor > 0, receivableMinor: b.receivableMinor });
      if (path === '/pharmacy-wallet/transactions') return ok(route, [], 200, { pagination: { page: 1, limit: 20, total: 0, totalPages: 1 } });
      if (path === `/admin/pharmacies/${PH}/wallet/lots`) return ok(route, []);
      if (path === '/admin/wallet-recharges/uncredited') return ok(route, []);
      if (path === `/admin/wallets/pharmacy/${PH}/topups-without-lot`) return ok(route, b.noLot);
      const so = /^\/admin\/wallets\/pharmacy\/(\w{24})\/receivable\/setoff-from-referral(?:\/by-key\/(\w+)(\/abandon)?)?$/.exec(path);
      if (so) {
        if (so[2]) {
          const amount = b.setOffKeys[so[2]];
          if (amount !== undefined) return ok(route, { state: 'used', setoff: { amountMinor: amount, referralAccountId: REF_ACC, ledgerEntryId: 'l1'.padStart(24, '0'), walletEntryId: null, at: NOW.toISOString() } });
          return ok(route, so[3] ? { state: 'abandoned' } : { state: 'unknown' });
        }
        if (!b.payoutsOn) return refuse(route, 409, 'REFERRAL_PAYOUTS_DISABLED');
        const amount = Number(body!.amountMinor);
        const key = String(body!.requestKey);
        if (b.setOffKeys[key] !== undefined) return ok(route, { setoff: { amountMinor: amount }, wallet: { receivableMinor: b.receivableMinor, frozen: true }, replayed: true });
        if (amount > Math.min(b.receivableMinor, b.referralDueMinor)) return refuse(route, 409, 'SETOFF_ABOVE_AVAILABLE', { receivableMinor: b.receivableMinor, referralDueMinor: b.referralDueMinor });
        b.setOffKeys[key] = amount;
        b.receivableMinor -= amount;
        b.referralDueMinor -= amount;
        if (b.loseNextSetOff) { b.loseNextSetOff = false; return route.abort('connectionreset'); }
        return ok(route, { setoff: { amountMinor: amount, referralAccountId: REF_ACC, ledgerEntryId: 'l1'.padStart(24, '0'), walletEntryId: 'l2'.padStart(24, '0'), at: NOW.toISOString() },
          wallet: { receivableMinor: b.receivableMinor, frozen: true }, replayed: false }, 201);
      }
      if (path === '/settlements/accounts') {
        const kind = url.searchParams.get('ownerKind');
        const refRow = { ...account({ _id: REF_ACC, ownerKind: 'lab_referral', ownerId: LAB, beneficiaryName: 'City Lab' }), balanceMinor: 155_500, payoutsPaused: !b.payoutsOn,
          home: { accountId: HOME_ACC, masked: 'HDFC0001234 XXXX4321', detailsVersion: 3, state: 'verified' } };
        const partnerRow = { ...account({ _id: HOME_ACC, payoutDetailsState: 'verified', payoutDetailsVersion: 3 }), balanceMinor: 0 };
        const rows = kind === 'referral' || kind === 'lab_referral' ? [refRow] : kind ? [] : [refRow, partnerRow];
        return ok(route, { total: rows.length, totalDueMinor: 155_500, rows });
      }
      if (path === `/settlements/accounts/${REF_ACC}`) {
        return ok(route, { account: account({ _id: REF_ACC, ownerKind: 'lab_referral', ownerId: LAB, beneficiaryName: 'City Lab',
          home: { accountId: HOME_ACC, masked: 'HDFC0001234 XXXX4321', detailsVersion: 3, state: 'verified' } }), balanceMinor: 155_500,
          totals: { ...totals, earnedMinor: 155_500 }, lastPayout: null });
      }
      if (path === `/settlements/accounts/${REF_ACC}/history`) return ok(route, []);
      if (/^\/settlements\/accounts\/\w{24}\/statement$/.test(path)) return ok(route, { lines: [], nextCursor: null });
      if (/^\/settlements\/accounts\/\w{24}\/(payouts|events)$/.test(path)) return empty(route);
    }
    return refuse(route, 404, 'NOT_MOCKED');
  });
  return b;
}

async function signIn(page: Page, as: 'Pharmacy' | 'Doctor' | 'Admin' | 'Lab or clinic staff' = 'Pharmacy') {
  await page.goto('/');
  if (as !== 'Pharmacy') await page.getByLabel(as, { exact: true }).check();
  await page.getByLabel('Mobile number').fill('9000000001');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}
const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' });
/** Writes made after signing in (the sign-in POSTs are left out). */
const writes = (b: Backend) => b.calls.filter((c) => c.method === 'POST' && !c.path.startsWith('/auth/')).map((c) => c.path);
const stored = (page: Page) => page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + location.href);

test('pharmacy Finance: three tiles, one statement (wallet and referral earnings) with its CSV, the rates; one nav item', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await expect(nav(page).getByRole('link', { name: 'Referral earnings' })).toHaveCount(0);
  await nav(page).getByRole('link', { name: 'Finance', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Finance', level: 1 })).toBeVisible();
  const tiles = page.getByLabel('Money at a glance');
  await expect(tiles).toContainText('Wallet balance₹3,000.00');
  await expect(tiles).toContainText('Withdrawable now: ₹2,500.00');
  await expect(tiles).toContainText('Withdrawable later: ₹500.00');
  await expect(tiles).toContainText('Card money₹3,000.00');
  await expect(tiles).toContainText('Referral earned₹1,605.00');
  await expect(tiles).toContainText('Paid out: ₹0.00');
  await expect(tiles).toContainText('Paid what the wallet owed: ₹50.00');
  await expect(tiles).toContainText('Due to you: ₹1,555.00');
  await expect(tiles).toContainText('Payouts are paused for now.');
  // The one action: Withdraw (switched off here), and where the money goes, masked only.
  await expect(page.getByRole('region', { name: 'Withdraw to bank' })).toContainText('Withdrawals to your bank are not open yet.');
  await expect(page.getByRole('region', { name: 'Payout details' })).toContainText('HDFC0001234 XXXX6789 Verified');

  const statement = page.getByRole('region', { name: 'Statement' });
  const rows = statement.getByRole('row');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(1)).toContainText('Paid for a consultation booking');
  await expect(rows.nth(1)).toContainText('−₹500.00');
  // r35b: paid from referral earnings: its amount, without a sign (not a debit).
  await expect(rows.nth(2)).toContainText('Paid from referral earnings₹50.00₹3,500.00');
  await expect(rows.nth(3)).toContainText('Top-up (card / UPI)+₹3,500.00');
  await statement.getByRole('button', { name: 'Older' }).click();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText('+₹100.00');
  let download = page.waitForEvent('download');
  await statement.getByRole('button', { name: 'Download CSV (all entries)' }).click();
  expect((await download).suggestedFilename()).toBe('pharmacy-wallet-statement.csv');

  await statement.getByLabel('Show').selectOption({ label: 'Referral earnings' });
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText('ABCD2345');
  await expect(rows.nth(1)).toContainText('Consultation₹500.00₹50.00');
  download = page.waitForEvent('download');
  await statement.getByRole('button', { name: 'Download CSV (all entries)' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('pharmacy-referral-statement.csv');
  expect((await readFile((await file.path())!, 'utf8')).split('\n')[0]).toBe(CSV_HEADER);
  await statement.getByLabel('From (India date)').fill('2026-11-01');
  await expect.poll(() => b.calls.filter((c) => c.path.startsWith('/pharmacy-assisted/finance/statement')).map((c) => c.path)).toEqual([
    '/pharmacy-assisted/finance/statement?kind=wallet&limit=50',
    `/pharmacy-assisted/finance/statement?kind=wallet&before=${Date.parse('2026-11-20T06:00:00.000Z')}_${'a1'.padStart(24, '0')}&limit=50`,
    '/pharmacy-assisted/finance/statement.csv?kind=wallet',
    '/pharmacy-assisted/finance/statement?kind=referral&limit=50',
    '/pharmacy-assisted/finance/statement.csv?kind=referral',
    '/pharmacy-assisted/finance/statement?kind=referral&from=2026-11-01&limit=50',
  ]);
  // The rates (from the former Referral earnings page).
  await expect(page.getByRole('region', { name: 'Referral earnings' })).toContainText('Consultation10% of each line');
  expect(await stored(page)).not.toMatch(/ABCD2345|6789/);

  // The old page's address lands on Finance; the Wallet page points here for withdrawals.
  await page.goto('/#/pharmacy/referral');
  await expect(page.getByRole('heading', { name: 'Finance', level: 1 })).toBeVisible();
  await page.goto('/#/pharmacy/wallet');
  await page.getByRole('main').getByRole('link', { name: 'Finance', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Finance', level: 1 })).toBeVisible();
  expect(b.calls.some((c) => c.path.startsWith('/pharmacy-assisted/referral/'))).toBe(false);
});

test('a lab’s Finance gains the referral and withdrawals tiles (its referral page stays, linked); a clinic’s shows none', async ({ page }) => {
  await mockBackend(page);
  await signIn(page, 'Lab or clinic staff');
  await nav(page).getByRole('link', { name: 'Finance', exact: true }).click();
  const tiles = page.getByLabel('Money at a glance');
  await expect(tiles).toContainText('Referral earned₹1,605.00');
  await expect(tiles).toContainText('Due to you: ₹1,555.00');
  await expect(tiles).toContainText('Withdrawals to the bankWaiting: 1');
  await expect(tiles).toContainText('Last paid:');
  await tiles.getByRole('link', { name: 'See referral earnings' }).click();
  await expect(page.getByRole('heading', { name: 'Referral earnings', level: 1 })).toBeVisible();
});

test('a clinic’s Finance has no referral or withdrawals tiles (the server sends null)', async ({ page }) => {
  await mockBackend(page, { me: { _id: OWNER, partnerId: CLINIC, name: 'Ravi Owner', role: 'owner', permissions: ALL, branchIds: [] } });
  await signIn(page, 'Lab or clinic staff');
  await nav(page).getByRole('link', { name: 'Finance', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Finance', level: 1 })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Balance' })).toBeVisible();
  await expect(page.getByLabel('Money at a glance')).toHaveCount(0);
});

test('a doctor’s Earnings gains the same tiles', async ({ page }) => {
  await mockBackend(page);
  await signIn(page, 'Doctor');
  await page.goto('/#/doctor/earnings');
  const tiles = page.getByLabel('Money at a glance');
  await expect(tiles).toContainText('Referral earned₹0.00');
  await expect(tiles).toContainText('Withdrawals to the bankNot open yet');
});

test('a branch-limited lab manager cannot ask for a withdrawal (it covers the whole lab) but can cancel the one it asked for', async ({ page }) => {
  const b = await mockBackend(page, {
    me: { _id: OWNER, partnerId: LAB, name: 'Sita Staff', role: 'staff', permissions: ['wallet.view', 'wallet.manage'], branchIds: ['b7'.repeat(12)] },
    labWithdrawals: [{ _id: 'a9'.padStart(24, '0'), walletKind: 'lab', state: 'requested', grossMinor: 60_000, feeMinor: 0, transferMinor: 60_000, feeLine: 'No card fee. You receive ₹600.00.',
      lots: [], destination: { masked: 'HDFC0001234 XXXX4321', detailsVersion: 1 }, paid: null, reason: null, version: 0, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() }],
  });
  await signIn(page, 'Lab or clinic staff');
  await page.goto('/#/partner/wallet');
  const section = page.getByRole('region', { name: 'Withdraw to bank' });
  await expect(section).toContainText('Withdrawals cover the whole lab, so only members who can see every branch can ask for one.');
  await expect(section.getByLabel('Amount to withdraw (₹)')).toHaveCount(0);
  const table = page.getByRole('table', { name: 'Withdrawals, newest first' });
  await table.getByRole('button', { name: 'Cancel' }).click();
  await table.getByRole('button', { name: 'Yes, cancel it' }).click();
  await expect(section.getByText('Cancelled. ₹600.00 is back in your wallet.')).toBeVisible();
  expect(writes(b)).toEqual([`/partner-workspace/assisted/wallet/withdrawals/${'a9'.padStart(24, '0')}/cancel`]);
});

test('admin Card disputes: the ones to recover first, Recover by the lot or by the payment id, each opens its wallet; all states', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page, 'Admin');
  await nav(page).getByRole('link', { name: 'Card disputes' }).click();
  await expect(page.getByRole('heading', { name: 'Card disputes', level: 1 })).toBeVisible();
  const table = page.getByRole('table', { name: 'Card disputes, newest first' });
  const rows = table.getByRole('row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(1)).toContainText('Pharmacy');
  await expect(rows.nth(1)).toContainText('₹2,000.00₹1,500.00');
  await expect(rows.nth(1)).toContainText('To recover');
  await rows.nth(1).getByRole('button', { name: 'Recover the money' }).click();
  await rows.nth(1).getByLabel('Why? (kept with the record)').fill('Chargeback lost');
  await rows.nth(1).getByRole('button', { name: 'Yes, recover it' }).click();
  await expect(page.getByText('Recovered: the ₹2,000.00 top-up was taken back from the wallet.')).toBeVisible();
  await expect(rows).toHaveCount(2);
  await rows.nth(1).getByRole('button', { name: 'Recover the money' }).click();
  await rows.nth(1).getByLabel('Why? (kept with the record)').fill('Chargeback lost');
  await rows.nth(1).getByRole('button', { name: 'Yes, recover it' }).click();
  await expect(page.getByText('No card disputes here.')).toBeVisible();
  expect(writes(b)).toEqual([`/admin/wallet-lots/${LOT}/recover`, `/admin/wallet-payments/${PAY2}/recover`]);
  await page.getByLabel('Show').selectOption({ label: 'All' });
  await expect(rows).toHaveCount(5);
  await expect(table.getByRole('button', { name: 'Recover the money' })).toHaveCount(0);
  await expect(rows.nth(4)).toContainText('Never credited');
  await rows.nth(1).getByRole('link', { name: 'Open wallet' }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/pharmacy-wallets/${PH}$`));
});

test('admin pharmacy wallet: older card top-ups recovered by payment id; paying what is owed from referral earnings is paused until tax advice', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page, 'Admin');
  await page.goto(`/#/admin/pharmacy-wallets/${PH}`);
  const setoff = page.getByRole('region', { name: 'Pay what is owed from referral earnings' });
  await expect(setoff).toContainText('Paused until tax advice: referral earnings cannot pay what is owed yet.');
  await expect(setoff.getByRole('textbox')).toHaveCount(0);
  const older = page.getByRole('region', { name: 'Older card top-ups' });
  const rows = older.getByRole('row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(2)).toContainText('None recorded');
  await expect(rows.nth(2).getByRole('button', { name: 'Recover the money' })).toHaveCount(0);
  await rows.nth(1).getByRole('button', { name: 'Recover the money' }).click();
  await rows.nth(1).getByLabel('Why? (kept with the record)').fill('Old chargeback');
  await rows.nth(1).getByRole('button', { name: 'Yes, recover it' }).click();
  await expect(older.getByText('Recovered: the ₹800.00 top-up was taken back from the wallet.')).toBeVisible();
  expect(writes(b)).toEqual([`/admin/wallet-payments/${PAY2}/recover`]);
  expect(b.calls.some((c) => c.path === '/settlements/accounts?ownerKind=referral&limit=1')).toBe(true);
});

test('admin pays what a wallet owes from referral earnings: one owned request; a lost answer is found by its key; never twice', async ({ page }) => {
  const b = await mockBackend(page, { payoutsOn: true, loseNextSetOff: true });
  await signIn(page, 'Admin');
  await page.goto(`/#/admin/pharmacy-wallets/${PH}`);
  const setoff = page.getByRole('region', { name: 'Pay what is owed from referral earnings' });
  await expect(setoff).toContainText('The wallet owes ₹200.00.');
  await setoff.getByLabel('Amount (₹)').fill('300');
  await setoff.getByRole('button', { name: 'Next: check' }).click();
  await expect(setoff.getByText('Enter an amount in rupees above zero, up to ₹200.00.')).toBeVisible();
  await setoff.getByLabel('Amount (₹)').fill('150');
  await setoff.getByRole('button', { name: 'Next: check' }).click();
  await expect(setoff).toContainText('Pay ₹150.00 of the ₹200.00 the wallet owes from the owner’s referral earnings?');
  await setoff.getByRole('button', { name: 'Yes, pay it' }).click();
  await expect(setoff.getByText(/The outcome is not known yet/)).toBeVisible();
  await setoff.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(setoff.getByText('It was recorded: ₹150.00 paid from referral earnings.')).toBeVisible();
  await expect(setoff).toContainText('The wallet owes ₹50.00.');
  const sent = b.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/setoff-from-referral'));
  expect(sent).toHaveLength(1);
  expect(sent[0]!.body).toMatchObject({ amountMinor: 15_000 });
  expect(b.calls.some((c) => c.path.startsWith(`/admin/wallets/pharmacy/${PH}/receivable/setoff-from-referral/by-key/${String(sent[0]!.body!.requestKey)}`))).toBe(true);
  // Above what the referral earnings can pay: the server's refusal in words with the most it can take now.
  b.referralDueMinor = 2_000;
  await setoff.getByLabel('Amount (₹)').fill('50');
  await setoff.getByRole('button', { name: 'Next: check' }).click();
  await setoff.getByRole('button', { name: 'Yes, pay it' }).click();
  await expect(setoff.getByText('At most ₹20.00 can be paid from referral earnings now.')).toBeVisible();
  expect(await stored(page)).not.toContain('15000');
});

test('admin referral accounts: filtered by kind, paused until tax advice, paid to the lab’s own account details', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page, 'Admin');
  await page.goto('/#/admin/settlements');
  await page.getByLabel('Account of').selectOption({ label: 'Referral (all)' });
  const table = page.getByRole('table', { name: 'Settlement accounts, largest balance first' });
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(table.getByRole('row').nth(1)).toContainText('Lab referral');
  await expect(table.getByRole('row').nth(1)).toContainText('Paused until tax advice');
  await expect(table.getByRole('row').nth(1)).toContainText('HDFC0001234 XXXX4321');
  expect(b.calls.some((c) => c.path.startsWith('/settlements/accounts?ownerKind=referral'))).toBe(true);
  await table.getByRole('link', { name: 'City Lab' }).click();
  await expect(page.getByRole('region', { name: 'Payout details' })).toContainText('Payouts go to the payout details of the lab’s or doctor’s own account: HDFC0001234 XXXX4321 (Verified).');
  await expect(page.getByRole('region', { name: 'Payout details' }).getByRole('button', { name: 'Change payout details' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Record a payout' })).toContainText('Paused until tax advice: referral earnings cannot be paid out yet.');
  await page.getByRole('link', { name: 'Open that account' }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/settlements/${HOME_ACC}$`));
});
