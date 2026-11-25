import { describe, expect, it } from 'vitest';
import { ApiError, createApiClient } from './client.ts';
import {
  adminWithdrawalsApi, doctorWithdrawalsApi, isPaidReference, labWithdrawalsApi, pharmacyWithdrawalsApi, walletRecoverApi, weeklyWait, withdrawalAmountProblem,
  withdrawalErrorCode, withdrawalErrorDetails,
} from './walletWithdrawals.ts';
import { pharmacyPayoutApi } from './finance.ts';
import { adminPharmacyWalletApi } from './adminPharmacyWallet.ts';
import { chargebackLot } from './labWallet.ts';

// WQ29 (backend r32 round 4d, design §26.16.4): wallet withdrawals to the bank, the admin's queue and Recover.

const W = 'a1'.repeat(12);
const LOT = 'b1'.repeat(12);
const PAY = 'c1'.repeat(12);
const PH = 'd1'.repeat(12);
const KEY = 'k'.repeat(32);
type Call = { url: string; method: string; body: unknown };
function client() {
  const calls: Call[] = [];
  const c = createApiClient({ baseUrl: '', getToken: () => 'tok', timeoutMs: 100, fetchImpl: async (u, init) => {
    calls.push({ url: String(u), method: String(init?.method), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ success: true, data: {}, pagination: { nextCursor: null } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } });
  return { c, calls };
}

describe('WQ29 wallet withdrawals (r32)', () => {
  it('one set of owner routes under the pharmacy’s, a lab’s and a doctor’s base', async () => {
    const { c, calls } = client();
    const p = pharmacyWithdrawalsApi(c);
    await p.withdrawable();
    await p.withdrawable(100_000);
    await p.request({ amountMinor: 100_000, requestKey: KEY, detailsVersion: 2 });
    await p.list({ state: 'requested' });
    await p.get(W);
    await p.byKey(KEY);
    await p.abandon(KEY);
    await p.cancel(W, 3);
    await labWithdrawalsApi(c, { kind: 'member' }).withdrawable();
    await doctorWithdrawalsApi(c).withdrawable();
    expect(calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      'GET /api/v1/pharmacy-assisted/wallet/withdrawable',
      'GET /api/v1/pharmacy-assisted/wallet/withdrawable?amountMinor=100000',
      'POST /api/v1/pharmacy-assisted/wallet/withdrawals',
      'GET /api/v1/pharmacy-assisted/wallet/withdrawals?state=requested&limit=20',
      `GET /api/v1/pharmacy-assisted/wallet/withdrawals/${W}`,
      `GET /api/v1/pharmacy-assisted/wallet/withdrawals/by-key/${KEY}`,
      `POST /api/v1/pharmacy-assisted/wallet/withdrawals/by-key/${KEY}/abandon`,
      `POST /api/v1/pharmacy-assisted/wallet/withdrawals/${W}/cancel`,
      'GET /api/v1/partner-workspace/assisted/wallet/withdrawable',
      'GET /api/v1/specialists/me/assisted/wallet/withdrawable',
    ]);
    expect(calls[2]!.body).toEqual({ amountMinor: 100_000, requestKey: KEY, detailsVersion: 2 });
    expect(calls[7]!.body).toEqual({ expectedVersion: 3 });
  });

  it('bad amounts, keys, ids, versions and cursors are refused before any request', () => {
    const { c, calls } = client();
    const p = pharmacyWithdrawalsApi(c);
    expect(() => p.request({ amountMinor: 10.5, requestKey: KEY, detailsVersion: 1 })).toThrow('Invalid amount');
    expect(() => p.request({ amountMinor: 1000, requestKey: 'x', detailsVersion: 1 })).toThrow('Invalid request key');
    expect(() => p.request({ amountMinor: 1000, requestKey: KEY, detailsVersion: -1 })).toThrow('Invalid version');
    expect(() => p.get('nope')).toThrow('Invalid withdrawal id');
    expect(() => p.list({ cursor: 'nope' })).toThrow('Invalid cursor');
    expect(() => adminWithdrawalsApi(c).paid(W, { method: 'upi', reference: 'UTR1', paidOn: '2026-11-25', detailsVersion: 1, expectedVersion: 0, requestKey: 'x' }))
      .toThrow('Invalid request key');
    expect(() => walletRecoverApi(c).lot('nope', { reason: 'r', requestKey: KEY })).toThrow('Invalid lot id');
    expect(calls).toHaveLength(0);
  });

  it('the admin queue: list, one, reject and void fenced by the version, paid with the bank’s reference and its key; Recover by lot or payment', async () => {
    const { c, calls } = client();
    const a = adminWithdrawalsApi(c);
    await a.list({ state: 'requested' });
    await a.get(W);
    await a.reject(W, { reason: '  Wrong account ', expectedVersion: 1 });
    await a.paid(W, { method: 'bank_transfer', reference: ' UTR123456 ', paidOn: '2026-11-25', note: ' ', detailsVersion: 2, expectedVersion: 1, requestKey: KEY });
    await a.void(W, { reason: 'Returned by the bank', expectedVersion: 2 });
    await walletRecoverApi(c).lot(LOT, { reason: ' Bank lost ', requestKey: KEY });
    await walletRecoverApi(c).payment(PAY, { reason: 'Bank lost', requestKey: KEY });
    await chargebackLot(c, LOT, ' Disputed ');
    await adminPharmacyWalletApi(c).lots(PH);
    await pharmacyPayoutApi(c).setPayoutDetails({ method: 'upi', upiId: 'asha@okbank' }, 0);
    expect(calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      'GET /api/v1/admin/wallet-withdrawals?state=requested',
      `GET /api/v1/admin/wallet-withdrawals/${W}`,
      `POST /api/v1/admin/wallet-withdrawals/${W}/reject`,
      `POST /api/v1/admin/wallet-withdrawals/${W}/paid`,
      `POST /api/v1/admin/wallet-withdrawals/${W}/void`,
      `POST /api/v1/admin/wallet-lots/${LOT}/recover`,
      `POST /api/v1/admin/wallet-payments/${PAY}/recover`,
      `POST /api/v1/admin/wallet-lots/${LOT}/chargeback`,
      `GET /api/v1/admin/pharmacies/${PH}/wallet/lots`,
      'PUT /api/v1/pharmacy-assisted/finance/payout-details',
    ]);
    expect(calls[2]!.body).toEqual({ reason: 'Wrong account', expectedVersion: 1 });
    // No empty note; the reference trimmed; the destination version and the request key sent.
    expect(calls[3]!.body).toEqual({ method: 'bank_transfer', reference: 'UTR123456', paidOn: '2026-11-25', detailsVersion: 2, expectedVersion: 1, requestKey: KEY });
    expect(calls[5]!.body).toEqual({ reason: 'Bank lost', requestKey: KEY });
    expect(calls[7]!.body).toEqual({ reason: 'Disputed' });
    expect(calls[9]!.body).toEqual({ method: 'upi', upiId: 'asha@okbank', expectedDetailsVersion: 0 });
  });

  it('rules: the minimum, what is withdrawable now, the weekly limit, the bank reference and a refusal’s safe details', () => {
    const w = { minimumMinor: 50_000, withdrawableNowMinor: 300_000 };
    expect(withdrawalAmountProblem(NaN, w)).toBe('invalid');
    expect(withdrawalAmountProblem(40_000, w)).toBe('below_minimum');
    expect(withdrawalAmountProblem(300_001, w)).toBe('above_available');
    expect(withdrawalAmountProblem(100_000, w)).toBeNull();
    const now = new Date('2026-11-25T04:30:00.000Z');
    expect(weeklyWait({ nextAllowedAt: '2026-11-28T04:30:00.000Z' }, now)).toBe('2026-11-28T04:30:00.000Z');
    expect(weeklyWait({ nextAllowedAt: '2026-11-20T04:30:00.000Z' }, now)).toBeNull();
    expect(weeklyWait({ nextAllowedAt: null }, now)).toBeNull();
    expect(isPaidReference('UTR')).toBe(false);
    expect(isPaidReference(' UTR1 ')).toBe(true);
    const err = new ApiError(409, 'weekly', 'WITHDRAWAL_WEEKLY_LIMIT', undefined, { details: { nextAllowedAt: '2026-11-28T04:30:00.000Z' } });
    expect(withdrawalErrorCode(err)).toBe('WITHDRAWAL_WEEKLY_LIMIT');
    expect(withdrawalErrorDetails(err)).toEqual({ nextAllowedAt: '2026-11-28T04:30:00.000Z' });
    expect(withdrawalErrorDetails(new Error('x'))).toEqual({});
  });
});
