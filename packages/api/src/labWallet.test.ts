import { ApiError, createApiClient } from './client.ts';
import { adminLabWalletApi, asMovement, asPharmacyWallet, LAB_WALLET_SWITCHED_OFF_MESSAGE, labTopupCheckable, labWalletApi, labWalletRefusal } from './labWallet.ts';
import { movementLabel, signedPaiseOf, walletBalancePaise, walletState } from './assisted.ts';
import { adminTopupWarning, ADMIN_TOPUP_WARNING, uncreditedOf } from './adminPharmacyWallet.ts';
import { ALL_PARTNER_PERMISSIONS, grantablePermissions, permissionsForKind } from './partners.ts';

const LAB = 'a1'.repeat(12);
const PAY = 'b1'.repeat(12);
const LOT = 'c1'.repeat(12);
const KEY = 'k'.repeat(32);

function recorder(answer: (url: string, method: string) => unknown = () => ({ success: true, data: {} })) {
  const calls: { method: string; url: string; body: unknown; key?: string | null }[] = [];
  const client = createApiClient({ baseUrl: 'https://api.example.test', getToken: () => 'tok',
    fetchImpl: async (u, init) => {
      const url = String(u).replace('https://api.example.test/api/v1', '');
      const method = String(init?.method);
      const headers = new Headers(init?.headers);
      calls.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined, key: headers.get('Idempotency-Key') });
      return new Response(JSON.stringify(answer(url, method)), { status: 200 });
    } });
  return { client, calls };
}

describe('WQ20 lab wallet (r13 /partner-workspace/assisted, /admin/labs)', () => {
  it('members read and top up at /partner-workspace/assisted; the order comes back in the pharmacy’s shape', async () => {
    const { client, calls } = recorder((url, method) => {
      if (url.endsWith('/wallet')) return { success: true, data: { balanceMinor: 125050, withdrawableMinor: 50000, receivableMinor: 0, frozen: false, isActive: true, updatedAt: null } };
      if (url.includes('/wallet/entries') || url.includes('/wallet/topups?') || url.endsWith('/wallet/topups') && method === 'GET') {
        return { success: true, data: [{ _id: 'e1', kind: 'credit', amountMinor: 50000, balanceAfterMinor: 125050, referenceType: 'wallet_recharge', at: '2026-11-25T05:00:00.000Z' }], pagination: { nextCursor: '1795000000000_' + 'f'.repeat(24) } };
      }
      if (url.endsWith('/wallet/topups')) return { success: true, data: { paymentTransactionId: PAY, razorpayOrderId: 'order_1', razorpayKeyId: 'rzp_test', amountMinor: 50000, currency: 'INR', state: 'awaiting_payment', replayed: false } };
      if (url.endsWith('/check')) return { success: true, data: { state: 'credited', wallet: { balanceMinor: 175050, withdrawableMinor: 100000, receivableMinor: 0, frozen: false, isActive: true, updatedAt: null } } };
      return { success: true, data: { context: 'wallet_recharge', paymentRecord: { status: 'paid' } } };
    });
    const w = labWalletApi(client, { kind: 'member' });
    expect(walletBalancePaise(await w.wallet())).toBe(125050);
    const page = await w.entries();
    expect(page.nextCursor).toMatch(/^\d+_/);
    expect(movementLabel(page.items[0]!)).toBe('Top-up (card / UPI)');
    await w.entries(page.nextCursor!);
    const order = await w.startTopup(50000, KEY);
    expect(order).toMatchObject({ paymentTransactionId: PAY, razorpayOrderId: 'order_1', amount: 500, currency: 'INR', replayed: false });
    expect((await w.checkTopup(PAY)).state).toBe('credited');
    await w.verify({ paymentTransactionId: PAY, razorpayOrderId: 'order_1', razorpayPaymentId: 'pay_1', razorpaySignature: 'sig' });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /partner-workspace/assisted/wallet',
      'GET /partner-workspace/assisted/wallet/entries?limit=20',
      `GET /partner-workspace/assisted/wallet/entries?cursor=${page.nextCursor}&limit=20`,
      'POST /partner-workspace/assisted/wallet/topups',
      `POST /partner-workspace/assisted/wallet/topups/${PAY}/check`,
      'POST /partner-workspace/assisted/payments/verify',
    ]);
    expect(calls[3]!.body).toEqual({ amountMinor: 50000, requestKey: KEY });
  });

  it('refuses before any request: an amount outside ₹1–₹50,000, a bad key, a bad cursor or id', async () => {
    const { client, calls } = recorder();
    const w = labWalletApi(client, { kind: 'member' });
    await expect(w.startTopup(99, KEY)).rejects.toThrow('Invalid amount');
    await expect(w.startTopup(5_000_001, KEY)).rejects.toThrow('Invalid amount');
    await expect(w.startTopup(10.5, KEY)).rejects.toThrow('Invalid amount');
    await expect(w.startTopup(50000, 'short')).rejects.toThrow('Invalid request key');
    await expect(w.entries('nope')).rejects.toThrow('Invalid cursor');
    await expect(w.checkTopup('nope')).rejects.toThrow('Invalid payment id');
    expect(calls).toHaveLength(0);
  });

  it('admins: wallet, entries, lots, the credit with an Idempotency-Key, the exact by-key read, freeze, the lot chargeback', async () => {
    const { client, calls } = recorder((url) => (url.includes('/by-key/')
      ? { success: true, data: { state: 'credited', entry: { _id: 'e9', kind: 'credit', amountMinor: 20000, balanceAfterMinor: 20000, referenceType: 'topup', referenceId: KEY, at: '2026-11-25T05:00:00.000Z', notes: 'support' } } }
      : { success: true, data: [], pagination: { nextCursor: null } }));
    const a = adminLabWalletApi(client);
    await a.wallet(LAB);
    await a.entries(LAB);
    await a.lots(LAB);
    await a.topup(LAB, { amountMinor: 20000, notes: '  support   credit ' }, KEY);
    const found = await a.topupByKey(LAB, KEY);
    expect(found.state === 'used' && found.row.notes).toBe('support');
    await a.freeze(LAB, true, ' dispute ');
    await a.chargebackLot(LOT, 'bank said lost');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET /admin/labs/${LAB}/wallet`, `GET /admin/labs/${LAB}/wallet/entries?limit=20`, `GET /admin/labs/${LAB}/wallet/lots`,
      `POST /admin/labs/${LAB}/wallet/topup`, `GET /admin/labs/${LAB}/wallet/topups/by-key/${KEY}`, `PUT /admin/labs/${LAB}/wallet/freeze`,
      `POST /admin/wallet-lots/${LOT}/chargeback`,
    ]);
    expect(calls[3]).toMatchObject({ body: { amountMinor: 20000, notes: 'support credit' }, key: KEY });
    expect(calls[5]!.body).toEqual({ frozen: true, reason: 'dispute' });
    expect(() => a.topup(LAB, { amountMinor: 20_000_001, notes: 'x' }, KEY)).toThrow('Invalid amount');
    expect(() => a.wallet('nope')).toThrow('Invalid lab id');
  });

  it('reads the lab’s paise into the wallet screens’ shapes (balance, hold, owing; signed history rows)', () => {
    const w = asPharmacyWallet({ balanceMinor: 1000, withdrawableMinor: 0, receivableMinor: 300, frozen: true, isActive: true, updatedAt: null, frozenReason: 'dispute' })!;
    expect(walletBalancePaise(w)).toBe(1000);
    expect(walletState(w)).toBe('owing');
    expect(w.frozenReason).toBe('dispute');
    expect(asPharmacyWallet(null)).toBeNull();
    const debit = asMovement({ _id: 'e2', kind: 'booking_debit', amountMinor: -40000, balanceAfterMinor: 60000, at: '2026-11-25T05:00:00.000Z' });
    expect(signedPaiseOf(debit)).toBe(-40000);
    expect(movementLabel(debit)).toBe('Paid for a consultation booking');
    expect(movementLabel(asMovement({ _id: 'e3', kind: 'credit', amountMinor: 100, balanceAfterMinor: 100, referenceType: 'topup', at: '' }))).toBe('Money added by Jansetu');
  });

  it('the wallet limit in words from its paise details; the switch; other refusals as the shared words', () => {
    const limit = labWalletRefusal(new ApiError(409, 'x', 'WALLET_LIMIT_REACHED', undefined,
      { details: { maxBalanceMinor: 5_000_000, balanceMinor: 4_800_000, pendingMinor: 0, allowedMinor: 200_000 } }));
    expect(limit).toEqual({ kind: 'limit', message: 'The wallet can hold at most ₹50,000.00. You can add up to ₹2,000.00 now.' });
    expect(labWalletRefusal(new ApiError(409, 'x', 'WALLET_LIMIT_REACHED', undefined, { details: { maxBalanceMinor: 5_000_000, allowedMinor: 0 } })).message)
      .toBe('The wallet can hold at most ₹50,000.00, so no more money can be added now.');
    expect(labWalletRefusal(new ApiError(503, 'x', 'ASSISTED_BOOKING_DISABLED'))).toEqual({ kind: 'off', message: LAB_WALLET_SWITCHED_OFF_MESSAGE });
    expect(labWalletRefusal(new ApiError(404, 'x', 'WALLET_NOT_FOUND')).message).toBe('The wallet is for labs only.');
  });

  it('a top-up is checkable while not paid or not added; uncredited rows of a lab; wallet permissions; the warning names the owner', () => {
    expect(labTopupCheckable('awaiting_payment')).toBe(true);
    expect(labTopupCheckable('paid_not_credited')).toBe(true);
    expect(labTopupCheckable('credited')).toBe(false);
    const rows = [
      { paymentTransactionId: PAY, walletKind: 'lab', partnerId: LAB, amountMinor: 500, createdAt: '', state: 'paid_not_credited' },
      { paymentTransactionId: 'b2'.repeat(12), pharmacyId: LAB, amountMinor: 700, createdAt: '', state: 'paid_not_credited' },
      { paymentTransactionId: 'b3'.repeat(12), walletKind: 'lab', partnerId: 'a2'.repeat(12), amountMinor: 900, createdAt: '', state: 'paid_not_credited' },
    ];
    // A pharmacy and a lab never share an id; a lab's rows are matched by `partnerId` only.
    expect(uncreditedOf(rows, LAB).map((r) => r.amountMinor)).toEqual([500, 700]);
    expect(ALL_PARTNER_PERMISSIONS).toEqual(expect.arrayContaining(['wallet.view', 'wallet.manage']));
    // WQ20b: offered to labs only (a clinic, or a kind not read yet, is never offered them).
    expect(permissionsForKind('lab')).toEqual(expect.arrayContaining(['wallet.view', 'wallet.manage']));
    expect(permissionsForKind('clinic')).not.toContain('wallet.view');
    expect(permissionsForKind(undefined)).not.toContain('wallet.manage');
    expect(grantablePermissions({ role: 'owner', permissions: [] }, 'clinic')).not.toContain('wallet.view');
    expect(grantablePermissions({ role: 'staff', permissions: ['wallet.view', 'bookings.view'] }, 'lab')).toEqual(['bookings.view', 'wallet.view']);
    expect(adminTopupWarning('lab')).toContain('or the lab could be paid twice');
    expect(ADMIN_TOPUP_WARNING).toContain('or the pharmacy could be paid twice');
  });
});
