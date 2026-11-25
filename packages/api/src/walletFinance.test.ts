import { describe, expect, it } from 'vitest';
import { ApiError, createApiClient } from './client.ts';
import { adminWalletFinanceApi, pharmacyFinanceApi } from './walletFinance.ts';
import { adminWithdrawalsApi, pharmacyWithdrawalsApi, quoteChangedOf } from './walletWithdrawals.ts';
import { isReferralOwnerKind, OWNER_KIND_LABEL, settlementsApi } from './finance.ts';
import { isReferralSetOff, movementLabel } from './assisted.ts';
import { asMovement } from './labWallet.ts';

// WQ48 (backend r35 rounds 4e/4f, design §26.10 and §26.18.3): the pharmacy's Finance reads and the admin's wallet tools.

const W = 'a1'.repeat(12);
const OWNER = 'd1'.repeat(12);
const KEY = 'k'.repeat(32);
const CURSOR = `1763353800000_${W}`;
type Call = { url: string; method: string; body: unknown };
function client() {
  const calls: Call[] = [];
  const c = createApiClient({ baseUrl: '', getToken: () => 'tok', timeoutMs: 100, fetchImpl: async (u, init) => {
    calls.push({ url: String(u), method: String(init?.method), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const csv = String(u).includes('.csv');
    return csv ? new Response('"Date (IST)","Type"\n', { status: 200, headers: { 'Content-Type': 'text/csv' } })
      : new Response(JSON.stringify({ success: true, data: [], pagination: { nextCursor: null } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } });
  return { c, calls };
}

describe('WQ48 finance (r35)', () => {
  it('the pharmacy’s finance, one statement for either kind (cursor and period), and its CSV', async () => {
    const { c, calls } = client();
    const f = pharmacyFinanceApi(c);
    await f.summary();
    await f.walletStatement();
    await f.walletStatement(CURSOR, 50, { from: '2026-11-01', to: '2026-11-30' });
    await f.referralStatement(undefined, 50, { from: '2026-11-01' });
    await f.statementCsv('referral', { to: '2026-11-30' });
    await f.statementCsv('wallet');
    expect(calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      'GET /api/v1/pharmacy-assisted/finance',
      'GET /api/v1/pharmacy-assisted/finance/statement?kind=wallet&limit=50',
      `GET /api/v1/pharmacy-assisted/finance/statement?kind=wallet&from=2026-11-01&to=2026-11-30&before=${CURSOR}&limit=50`,
      'GET /api/v1/pharmacy-assisted/finance/statement?kind=referral&from=2026-11-01&limit=50',
      'GET /api/v1/pharmacy-assisted/finance/statement.csv?kind=referral&to=2026-11-30',
      'GET /api/v1/pharmacy-assisted/finance/statement.csv?kind=wallet',
    ]);
    expect(() => f.walletStatement('bad')).toThrow('Invalid statement cursor');
    expect(() => f.referralStatement(undefined, 201)).toThrow('Invalid limit');
    expect(() => f.walletStatement(undefined, 50, { from: '2026-11-30', to: '2026-11-01' })).toThrow();
  });

  it('a withdrawal names the transfer it was shown; a changed quote is read from the refusal', async () => {
    const { c, calls } = client();
    await pharmacyWithdrawalsApi(c).request({ amountMinor: 100_000, requestKey: KEY, detailsVersion: 2, expectedTransferMinor: 98_000 });
    await pharmacyWithdrawalsApi(c).request({ amountMinor: 100_000, requestKey: KEY, detailsVersion: 2 });
    expect(calls[0]!.body).toEqual({ amountMinor: 100_000, requestKey: KEY, detailsVersion: 2, expectedTransferMinor: 98_000 });
    expect(calls[1]!.body).toEqual({ amountMinor: 100_000, requestKey: KEY, detailsVersion: 2 });
    const changed = new ApiError(409, 'The card fee changed', 'WITHDRAWAL_QUOTE_CHANGED', undefined, { details: { grossMinor: 100_000, feeMinor: 2_500, transferMinor: 97_500 } });
    expect(quoteChangedOf(changed)).toEqual({ grossMinor: 100_000, feeMinor: 2_500, transferMinor: 97_500 });
    expect(quoteChangedOf(new ApiError(409, 'x', 'WITHDRAWAL_QUOTE_CHANGED', undefined, { details: { grossMinor: 1 } }))).toBeNull();
    expect(quoteChangedOf(new ApiError(409, 'x', 'WITHDRAWAL_CHANGED'))).toBeNull();
  });

  it('mark paid acknowledges a card dispute only when asked', async () => {
    const { c, calls } = client();
    const body = { method: 'bank_transfer' as const, reference: 'UTR12345', paidOn: '2026-11-25', detailsVersion: 1, expectedVersion: 2, requestKey: KEY };
    await adminWithdrawalsApi(c).paid(W, body);
    await adminWithdrawalsApi(c).paid(W, { ...body, disputeAcknowledged: true });
    expect(calls[0]!.body).not.toHaveProperty('disputeAcknowledged');
    expect(calls[1]!.body).toMatchObject({ disputeAcknowledged: true });
  });

  it('the admin’s disputes, top-ups without a lot, and the set-off from referral earnings with its key', async () => {
    const { c, calls } = client();
    const a = adminWalletFinanceApi(c);
    await a.disputes();
    await a.disputes({ state: 'flagged', walletKind: 'lab', limit: 200 });
    await a.topupsWithoutLot('doctor', OWNER);
    await a.setOff('pharmacy', OWNER, { amountMinor: 5_000, requestKey: KEY });
    await a.setOffByKey('lab', OWNER, KEY);
    await a.abandonSetOff('lab', OWNER, KEY);
    await settlementsApi(c).accounts({ ownerKind: 'referral', limit: 1 });
    expect(calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      'GET /api/v1/admin/wallet-disputes',
      'GET /api/v1/admin/wallet-disputes?state=flagged&walletKind=lab&limit=200',
      `GET /api/v1/admin/wallets/doctor/${OWNER}/topups-without-lot`,
      `POST /api/v1/admin/wallets/pharmacy/${OWNER}/receivable/setoff-from-referral`,
      `GET /api/v1/admin/wallets/lab/${OWNER}/receivable/setoff-from-referral/by-key/${KEY}`,
      `POST /api/v1/admin/wallets/lab/${OWNER}/receivable/setoff-from-referral/by-key/${KEY}/abandon`,
      'GET /api/v1/settlements/accounts?ownerKind=referral&limit=1',
    ]);
    expect(calls[3]!.body).toEqual({ amountMinor: 5_000, requestKey: KEY });
    expect(() => a.setOff('pharmacy', OWNER, { amountMinor: 0, requestKey: KEY })).toThrow('Invalid amount');
    expect(() => a.setOff('pharmacy', 'nope', { amountMinor: 1, requestKey: KEY })).toThrow();
    expect(() => a.disputes({ limit: 201 })).toThrow('Invalid limit');
    expect(() => a.topupsWithoutLot('clinic' as never, OWNER)).toThrow('Invalid wallet kind');
    expect(calls).toHaveLength(7);
  });

  it('referral accounts and a set-off row’s words', () => {
    expect(isReferralOwnerKind('lab_referral')).toBe(true);
    expect(isReferralOwnerKind('partner')).toBe(false);
    expect(OWNER_KIND_LABEL.pharmacy_referral).toBe('Pharmacy referral');
    const row = { _id: W, transactionType: 'adjustment', movementType: 'receivable_setoff', referenceType: 'referral_setoff', amountPaise: 5_000, signedAmountPaise: 0 };
    expect(isReferralSetOff(row)).toBe(true);
    expect(movementLabel(row)).toBe('Paid from referral earnings');
    // WQ48b: an owed amount cleared from a credit is a real debit, whatever its transaction type says.
    const cleared = { _id: W, transactionType: 'adjustment', movementType: 'receivable_setoff', referenceType: 'wallet_recharge', amountPaise: 5_000, signedAmountPaise: -5_000 };
    expect(isReferralSetOff(cleared)).toBe(false);
    expect(movementLabel(cleared)).toBe('Used to clear money owed to Jansetu');
    // A lab's or doctor's set-off entry moves no balance: its amount is what it cleared (r35b's `receivableDeltaMinor`), else none.
    const entry = { _id: W, kind: 'receivable_setoff', amountMinor: 0, balanceAfterMinor: 0, referenceType: 'referral_setoff', at: '2026-11-25T04:30:00.000Z' };
    expect(asMovement({ ...entry, receivableDeltaMinor: -5_000 }).amountPaise).toBe(5_000);
    expect(asMovement(entry).amountPaise).toBeUndefined();
    expect(isReferralSetOff(asMovement(entry))).toBe(true);
  });
});
