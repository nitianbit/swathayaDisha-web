import { ApiError, createApiClient } from './client.ts';
import {
  adminOwnerWalletApi, DOCTOR_WALLET_CLOSED_MESSAGE, DOCTOR_WALLET_SWITCHED_OFF_MESSAGE, doctorWalletApi,
  isDoctorWalletClosed, LAB_WALLET_SWITCHED_OFF_MESSAGE, ownerWalletRefusal,
} from './labWallet.ts';
import { adminTopupWarning, uncreditedOf } from './adminPharmacyWallet.ts';

const DOC = 'd1'.repeat(12);
const PAY = 'b1'.repeat(12);
const KEY = 'k'.repeat(32);

function recorder(answer: (url: string) => unknown = () => ({ success: true, data: {}, pagination: { nextCursor: null } })) {
  const calls: { method: string; url: string; body: unknown; key: string | null }[] = [];
  const client = createApiClient({ baseUrl: 'https://api.example.test', getToken: () => 'tok',
    fetchImpl: async (u, init) => {
      const url = String(u).replace('https://api.example.test/api/v1', '');
      calls.push({ method: String(init?.method), url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined, key: new Headers(init?.headers).get('Idempotency-Key') });
      return new Response(JSON.stringify(answer(url)), { status: 200 });
    } });
  return { client, calls };
}

describe('WQ23 doctor wallet (r20 /specialists/me/assisted, /admin/doctors)', () => {
  it('the doctor reads and tops up at /specialists/me/assisted; the proof goes to the existing /payments/verify', async () => {
    const { client, calls } = recorder((url) => (url.endsWith('/wallet/topups')
      ? { success: true, data: { paymentTransactionId: PAY, razorpayOrderId: 'order_1', razorpayKeyId: 'rzp', amountMinor: 30000, currency: 'INR', state: 'awaiting_payment', replayed: true } }
      : url.endsWith('/check') ? { success: true, data: { state: 'credited' } }
      : { success: true, data: { balanceMinor: 0, withdrawableMinor: 0, receivableMinor: 0, frozen: false, isActive: true, updatedAt: null }, pagination: { nextCursor: null } }));
    const w = doctorWalletApi(client);
    await w.wallet();
    await w.entries();
    expect(await w.startTopup(30000, KEY)).toMatchObject({ paymentTransactionId: PAY, amount: 300, replayed: true });
    // r20 E8: the check answers no wallet for a doctor who is no longer eligible.
    expect(await w.checkTopup(PAY)).toEqual({ state: 'credited', wallet: null });
    await w.verify({ paymentTransactionId: PAY, razorpayOrderId: 'order_1', razorpayPaymentId: 'pay_1', razorpaySignature: 's' });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /specialists/me/assisted/wallet', 'GET /specialists/me/assisted/wallet/entries?limit=20', 'POST /specialists/me/assisted/wallet/topups',
      `POST /specialists/me/assisted/wallet/topups/${PAY}/check`, 'POST /payments/verify',
    ]);
    expect(calls[2]!.body).toEqual({ amountMinor: 30000, requestKey: KEY });
    expect('topups' in w).toBe(false); // r20 E7: no top-up list for doctors
  });

  it('the admin tools are the lab routes under /admin/doctors; a non-doctor id is refused before any request', async () => {
    const { client, calls } = recorder();
    const a = adminOwnerWalletApi(client, 'doctor');
    await a.wallet(DOC);
    await a.lots(DOC);
    await a.topup(DOC, { amountMinor: 50000, notes: 'Support credit' }, KEY);
    await a.freeze(DOC, true, 'dispute');
    await adminOwnerWalletApi(client, 'lab').wallet(DOC);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET /admin/doctors/${DOC}/wallet`, `GET /admin/doctors/${DOC}/wallet/lots`, `POST /admin/doctors/${DOC}/wallet/topup`, `PUT /admin/doctors/${DOC}/wallet/freeze`,
      `GET /admin/labs/${DOC}/wallet`,
    ]);
    expect(calls[2]!.key).toBe(KEY);
    expect(() => a.wallet('nope')).toThrow('Invalid doctor id');
  });

  it('words: an ineligible doctor’s wallet is closed; the switch per owner; a doctor’s uncredited rows by specialistId', () => {
    const closed = new ApiError(403, 'x', 'SPECIALIST_NOT_VERIFIED');
    expect(isDoctorWalletClosed(closed)).toBe(true);
    expect(ownerWalletRefusal(closed, 'doctor').message).toBe(DOCTOR_WALLET_CLOSED_MESSAGE);
    expect(ownerWalletRefusal(new ApiError(503, 'x', 'ASSISTED_BOOKING_DISABLED'), 'doctor').message).toBe(DOCTOR_WALLET_SWITCHED_OFF_MESSAGE);
    expect(ownerWalletRefusal(new ApiError(503, 'x', 'ASSISTED_BOOKING_DISABLED'), 'lab').message).toBe(LAB_WALLET_SWITCHED_OFF_MESSAGE);
    expect(ownerWalletRefusal(new ApiError(404, 'x', 'SPECIALIST_NOT_FOUND'), 'doctor').message).toBe('This doctor was not found.');
    const rows = [{ paymentTransactionId: PAY, walletKind: 'doctor', specialistId: DOC, amountMinor: 700, createdAt: '', state: 'paid_not_credited' },
      { paymentTransactionId: 'b2'.repeat(12), walletKind: 'lab', partnerId: 'a1'.repeat(12), amountMinor: 900, createdAt: '', state: 'paid_not_credited' }];
    expect(uncreditedOf(rows, DOC).map((r) => r.amountMinor)).toEqual([700]);
    expect(adminTopupWarning('doctor')).toContain('or the doctor could be paid twice');
  });
});
