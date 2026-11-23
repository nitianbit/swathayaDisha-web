import { ApiError, createApiClient } from './client.ts';
import {
  adminPharmacyWalletApi, CLOSE_COMPENSATED_EXPLAIN, closeCompensatedFinal, closeCompensatedRefusal, closeReasonProblem, closeRefusedBeforeWriting, uncreditedOf,
} from './adminPharmacyWallet.ts';
import { CLINIC_DOCTOR_NOT_VERIFIED_MESSAGE, isClinicDoctorNotVerified } from './auth.ts';

// WQ15 (backend r9, design §22): an uncredited card top-up closed as already paid by hand; the clinic sign-in refusal.

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const P1 = 'a1'.repeat(12);
const REC = 'e1'.repeat(12);
const KEY = 'k'.repeat(32);
const err = (status: number, code?: string, message = 'refused') => new ApiError(status, message, code);

describe('close as already paid by hand: refusals in plain words', () => {
  it('maps every answer of the close', () => {
    expect(closeCompensatedRefusal(err(409, 'TOPUP_ALREADY_CREDITED'))).toBe('This top-up was already credited, nothing to close.');
    expect(closeCompensatedRefusal(err(409, 'TOPUP_REFUNDED'))).toBe('This top-up was already refunded to the card, nothing to close.');
    expect(closeCompensatedRefusal(err(409, 'TOPUP_BLOCKED'))).toBe('This top-up was already blocked after a lost card dispute. It is never credited, so there is nothing to close.');
    expect(closeCompensatedRefusal(err(409, 'IDEMPOTENCY_KEY_REUSED'))).toMatch(/^This request was already used for another top-up or another reason, so nothing was changed\./);
    expect(closeCompensatedRefusal(err(409, 'PAYMENT_AMBIGUOUS'))).toBe('More than one top-up carries this payment id, so nothing was changed. Ask the tech team.');
    expect(closeCompensatedRefusal(err(404, 'TOPUP_NOT_FOUND'))).toBe('This top-up was not found (it is not a pharmacy card top-up). Nothing was changed.');
    expect(closeCompensatedRefusal(err(503, 'INDEXES_OUTDATED'))).toBe('The server needs an update before top-ups can be closed. Nothing was changed. Please ask the Jansetu team.');
    const off = 'The admin tools are switched off on this server, so top-ups cannot be closed here. Nothing was changed.';
    expect(closeCompensatedRefusal(err(503, 'ASSISTED_BOOKING_DISABLED'))).toBe(off);
    expect(closeCompensatedRefusal(err(404))).toBe(off); // a server without the r9 route (catch-all 404, no code)
    expect(closeCompensatedRefusal(err(403, 'FORBIDDEN'))).toBe('Only Jansetu admins can close a top-up.');
    expect(closeCompensatedRefusal(err(400, 'VALIDATION_ERROR'))).toBe('Write a reason of 1 to 500 characters. Nothing was changed.');
  });

  it('only the switch and the indexes (503 with their code) are refused before writing; any other 503 stays unknown', () => {
    expect(closeRefusedBeforeWriting(err(503, 'INDEXES_OUTDATED'))).toBe(true);
    expect(closeRefusedBeforeWriting(err(503, 'ASSISTED_BOOKING_DISABLED'))).toBe(true);
    expect(closeRefusedBeforeWriting(err(503))).toBe(false);
    expect(closeRefusedBeforeWriting(err(502, 'INDEXES_OUTDATED'))).toBe(false);
  });

  it('credited, blocked and not-a-top-up settle any attempt; a reused key or a changed top-up does not', () => {
    for (const [s, c] of [[409, 'TOPUP_ALREADY_CREDITED'], [409, 'TOPUP_REFUNDED'], [409, 'TOPUP_BLOCKED'], [404, 'TOPUP_NOT_FOUND']] as const) expect(closeCompensatedFinal(err(s, c))).toBe(true);
    for (const [s, c] of [[409, 'IDEMPOTENCY_KEY_REUSED'], [409, 'WALLET_CHANGED'], [409, 'PAYMENT_AMBIGUOUS'], [503, 'INDEXES_OUTDATED']] as const) {
      expect(closeCompensatedFinal(err(s, c))).toBe(false);
    }
  });

  it('the reason is required (1–500 after trimming); the owner wording', () => {
    expect(closeReasonProblem('   ')).toMatch(/^Write why this top-up is closed/);
    expect(closeReasonProblem('x'.repeat(501))).toBe('Use at most 500 characters.');
    expect(closeReasonProblem(' paid by UPI ')).toBeUndefined();
    expect(CLOSE_COMPENSATED_EXPLAIN).toBe('Use this only when Jansetu support already paid this amount to the pharmacy another way. The top-up can then never be credited.');
  });
});

describe('close as already paid by hand: requests', () => {
  it('the list keeps this pharmacy’s well-formed rows only', () => {
    const rows = [
      { paymentTransactionId: REC, pharmacyId: P1.toUpperCase(), amountMinor: 50_000, createdAt: '2026-11-20T10:00:00.000Z', state: 'paid_not_credited' },
      { paymentTransactionId: 'e2'.repeat(12), pharmacyId: 'a2'.repeat(12), amountMinor: 100, createdAt: '2026-11-20T10:00:00.000Z', state: 'paid_not_credited' },
      { paymentTransactionId: 'bad', pharmacyId: P1, amountMinor: 100 },
      null,
    ];
    expect(uncreditedOf(rows, P1).map((r) => r.paymentTransactionId)).toEqual([REC]);
    expect(uncreditedOf({ not: 'a list' }, P1)).toEqual([]);
  });

  it('sends the record id, the trimmed reason and the key; the by-key read answers closed / not_found, anything else is thrown', async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    let answer: Response = json(200, { success: true, data: { closed: true, credited: false, replayed: false, paymentRecordId: REC, pharmacyId: P1, amountPaise: 50_000, compensatedAt: '2026-11-23T10:00:00.000Z', status: 'failed' } });
    const c = createApiClient({ baseUrl: '', getToken: () => 'tok', timeoutMs: 100, fetchImpl: async (u, init) => {
      calls.push({ url: String(u), method: String(init?.method), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return answer.clone();
    } });
    const w = adminPharmacyWalletApi(c);
    await expect(w.closeCompensated(REC.toUpperCase(), { reason: '  paid   by UPI ', requestKey: KEY })).resolves.toMatchObject({ closed: true, replayed: false });
    expect(calls[0]).toEqual({ url: `/api/v1/admin/wallet-payments/${REC}/close-compensated`, method: 'POST', body: { reason: 'paid by UPI', requestKey: KEY } });
    await expect(w.closeCompensated(REC, { reason: 'x', requestKey: 'short' })).rejects.toThrow('Invalid request key');
    await expect(w.closeCompensated('order_123', { reason: 'x', requestKey: KEY })).rejects.toThrow('Invalid payment id');
    // WQ15b L1: a 200 that is not a closure is never read as closed (the request stays unknown).
    for (const data of [null, {}, { closed: false }, { state: 'not_found' }]) {
      answer = json(200, { success: true, data });
      await expect(w.closeCompensated(REC, { reason: 'x', requestKey: KEY })).rejects.toMatchObject({ status: 502 });
    }

    answer = json(200, { success: true, data: { state: 'closed', closed: true, credited: false, replayed: true, paymentRecordId: REC, pharmacyId: P1, amountPaise: 50_000, compensatedAt: '2026-11-23T10:00:00.000Z', status: 'failed' } });
    await expect(w.closeCompensatedByKey(KEY)).resolves.toMatchObject({ state: 'closed', close: { paymentRecordId: REC } });
    expect(calls.at(-1)!.url).toBe(`/api/v1/admin/wallet-payments/close-compensated/by-key/${KEY}`);
    answer = json(200, { success: true, data: { state: 'not_found' } });
    await expect(w.closeCompensatedByKey(KEY)).resolves.toEqual({ state: 'not_found' });
    answer = json(200, { success: true, data: { state: 'odd' } });
    await expect(w.closeCompensatedByKey(KEY)).rejects.toMatchObject({ status: 502 });
    answer = json(503, { error: 503, code: 'INDEXES_OUTDATED', message: 'sync-indexes' });
    await expect(w.closeCompensatedByKey(KEY)).rejects.toMatchObject({ status: 503, code: 'INDEXES_OUTDATED' });
  });
});

describe('clinic sign-in refused for a doctor who is not verified or not active', () => {
  it('recognises the 403 code (both names) only', () => {
    expect(isClinicDoctorNotVerified(err(403, 'CLINIC_OWNER_DOCTOR_NOT_VERIFIED'))).toBe(true);
    expect(isClinicDoctorNotVerified(err(403, 'CLINIC_DOCTOR_NOT_VERIFIED'))).toBe(true); // the backend follow-up's name
    expect(isClinicDoctorNotVerified(err(401, 'CLINIC_OWNER_DOCTOR_NOT_VERIFIED'))).toBe(false);
    expect(isClinicDoctorNotVerified(err(403, 'FORBIDDEN'))).toBe(false);
    expect(CLINIC_DOCTOR_NOT_VERIFIED_MESSAGE).toBe('Your doctor account is not verified or not active, so this clinic workspace is closed for you. Contact the Jansetu team.');
  });

  it('a 403 on a request with a token is reported with its code; without a token (sign-in) it is not', async () => {
    const seen: { token: string; code?: string }[] = [];
    const c = createApiClient({ baseUrl: '', getToken: () => 'tok', timeoutMs: 100, onForbidden: (token, e) => seen.push({ token, code: e.code }),
      fetchImpl: async () => json(403, { error: 403, code: 'CLINIC_OWNER_DOCTOR_NOT_VERIFIED', message: 'closed to you' }) });
    await expect(c.get('/partner-workspace/me')).rejects.toMatchObject({ status: 403, code: 'CLINIC_OWNER_DOCTOR_NOT_VERIFIED' });
    expect(seen).toEqual([{ token: 'tok', code: 'CLINIC_OWNER_DOCTOR_NOT_VERIFIED' }]);
    await expect(c.post('/auth/partner/verify', { auth: false })).rejects.toMatchObject({ status: 403 });
    expect(seen).toHaveLength(1);
  });
});
