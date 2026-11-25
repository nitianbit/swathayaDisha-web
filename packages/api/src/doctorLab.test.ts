import { describe, expect, it } from 'vitest';
import { ApiError, createApiClient } from './client.ts';
import {
  DOCTOR_LAB_CLOSED_MESSAGE, doctorLabApi, doctorLabRefusal, doctorRecommendationsApi, LAB_SWITCHED_OFF_MESSAGE, labRefusal, pharmacyLabApi, recommendationsOff,
  type LabCreateRequest,
} from './assistedLab.ts';
import { doctorToolsApi, labBookableFrom } from './doctorTools.ts';
import { CARD_BLOCKED_WORDS, DOCTOR_CARD_BLOCKED_WORDS, outcomeOfError } from './assistedCard.ts';

// WQ25 (backend r26 phase 3b, design §25.15): a verified doctor books a lab test for a patient, paid from the doctor wallet.

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const LAB = 'a1'.repeat(12);
const BR = 'b1'.repeat(12);
const BK = 'e1'.repeat(12);
const CONSULT = 'c7'.repeat(12);
const KEY = 'k'.repeat(32);
const PHONE = '9876543210';
type Call = { url: string; method: string; body: unknown };
function client(answer: (c: Call) => Response = () => json(200, { success: true, data: {} })) {
  const calls: Call[] = [];
  const c = createApiClient({ baseUrl: '', getToken: () => 'tok', timeoutMs: 100, fetchImpl: async (u, init) => {
    const call = { url: String(u), method: String(init?.method), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return answer(call).clone();
  } });
  return { c, calls };
}
const base = {
  requestKey: KEY, consent: { agreed: true as const, statementVersion: 'web-doctor-lab-v1', statementLanguage: 'en' }, preferredLanguage: 'hi',
  partnerId: LAB, branchId: BR, visitMode: 'lab' as const, slotId: 'd1'.repeat(12), itemIds: ['f1'.repeat(12)], acceptedPriceMinor: 30_000, paymentMethod: 'wallet' as const,
};
const err = (status: number, code: string) => new ApiError(status, 'refused', code);

describe('WQ25 doctor lab booking (r26 /specialists/me/assisted)', () => {
  it('the reads, list, by-key, abandon, cancel and accept are the pharmacy routes under /specialists/me/assisted; the pharmacy’s are unchanged', async () => {
    const { c, calls } = client((x) => (x.url.includes('lab-bookings?')
      ? json(200, { success: true, data: [], pagination: { total: 0, nextCursor: null } }) : json(200, { success: true, data: { state: 'unknown' } })));
    const d = doctorLabApi(c);
    await d.labs({ visitMode: 'home', limit: 50 });
    await d.catalogue(LAB, 'home');
    await d.slots(BR, { visitMode: 'lab', from: '2026-11-26', days: 7 });
    await d.bookings({ status: 'confirmed', limit: 20 });
    await d.booking(BK);
    await d.byKey(KEY);
    await d.abandon(KEY);
    await d.cancel(BK, { expectedVersion: 3 });
    await d.acceptReschedule(BK, 2);
    await pharmacyLabApi(c).labs({ visitMode: 'lab' });
    expect(calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      'GET /api/v1/specialists/me/assisted/labs?visitMode=home&limit=50',
      `GET /api/v1/specialists/me/assisted/labs/${LAB}/catalogue?visitMode=home`,
      `GET /api/v1/specialists/me/assisted/labs/branches/${BR}/slots?visitMode=lab&from=2026-11-26&days=7`,
      'GET /api/v1/specialists/me/assisted/lab-bookings?status=confirmed&limit=20',
      `GET /api/v1/specialists/me/assisted/lab-bookings/${BK}`,
      `GET /api/v1/specialists/me/assisted/lab-bookings/by-key/${KEY}`,
      `POST /api/v1/specialists/me/assisted/lab-bookings/by-key/${KEY}/abandon`,
      `POST /api/v1/specialists/me/assisted/lab-bookings/${BK}/cancel`,
      `POST /api/v1/specialists/me/assisted/lab-bookings/${BK}/accept-reschedule`,
      'GET /api/v1/pharmacy-assisted/labs?visitMode=lab',
    ]);
    expect(calls[7]!.body).toEqual({ expectedVersion: 3 });
    expect(calls[8]!.body).toEqual({ version: 2 });
  });

  it('the lookup and the recommended-tests code keep the phone in the body; a create names one patient source', async () => {
    const { c, calls } = client(() => json(200, { success: true, data: {} }));
    const d = doctorLabApi(c);
    await d.lookup(PHONE);
    await doctorRecommendationsApi(c).load('abcd-efgh', PHONE);
    await d.book({ ...base, fromBookingId: CONSULT, typedName: 'Rina Kumari' });
    await d.book({ ...base, phone: PHONE, patient: { relation: 'self', name: 'Rina Kumari' } });
    expect(calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      'POST /api/v1/specialists/me/assisted/patients/lookup',
      'POST /api/v1/specialists/me/assisted/recommendations/lookup',
      'POST /api/v1/specialists/me/assisted/lab-bookings',
      'POST /api/v1/specialists/me/assisted/lab-bookings',
    ]);
    expect(calls[0]!.body).toEqual({ phone: PHONE });
    expect(calls[1]!.body).toEqual({ code: 'ABCDEFGH', phone: PHONE });
    // From the doctor's own consultation: no phone is named (nothing is counted, r26).
    expect(calls[2]!.body).toEqual({ ...base, fromBookingId: CONSULT, typedName: 'Rina Kumari' });
    expect(calls[2]!.body).not.toHaveProperty('phone');
    expect(calls[3]!.body).toMatchObject({ phone: PHONE, patient: { relation: 'self', name: 'Rina Kumari' } });
    for (const x of calls) expect(x.url).not.toContain(PHONE);
  });

  it('a bad consultation id, two sources, a missing name or a bad key are refused before any request', () => {
    const { c, calls } = client();
    const d = doctorLabApi(c);
    expect(() => d.book({ ...base, fromBookingId: 'nope', typedName: 'Rina' })).toThrow('Invalid consultation id');
    expect(() => d.book({ ...base, fromBookingId: CONSULT, typedName: '  ' })).toThrow('Invalid patient name');
    expect(() => d.book({ ...base, fromBookingId: CONSULT, typedName: 'Rina', phone: PHONE } as unknown as LabCreateRequest)).toThrow('One patient source only');
    expect(() => d.book({ ...base, requestKey: 'x', fromBookingId: CONSULT, typedName: 'Rina' })).toThrow('Invalid request key');
    expect(() => d.booking('nope')).toThrow('Invalid booking id');
    expect(calls).toHaveLength(0);
  });

  it('words: an unverified doctor, a consultation not found or no longer open, the wallet only; the lab and shared words otherwise', () => {
    expect(doctorLabRefusal(err(403, 'SPECIALIST_NOT_VERIFIED'))).toEqual({ kind: 'other', message: DOCTOR_LAB_CLOSED_MESSAGE });
    expect(doctorLabRefusal(err(404, 'BOOKING_NOT_FOUND'))).toMatchObject({ kind: 'patient', message: expect.stringContaining('not found among yours') });
    expect(doctorLabRefusal(err(409, 'TREATING_WINDOW_CLOSED'))).toMatchObject({ kind: 'patient', message: expect.stringContaining('by their mobile number instead') });
    // WQ27 (r29): the card is offered; its switch off is the shared card words (the way to pay falls back to the wallet).
    expect(doctorLabRefusal(err(400, 'PAYMENT_METHOD_UNAVAILABLE'))).toEqual({ kind: 'card', message: 'Card payment is not switched on yet. Pay from your Jansetu wallet.' });
    expect(doctorLabRefusal(err(409, 'INSUFFICIENT_BALANCE')).kind).toBe('topup');
    expect(doctorLabRefusal(err(404, 'LAB_BOOKING_NOT_FOUND'))).toEqual(labRefusal(err(404, 'LAB_BOOKING_NOT_FOUND')));
    expect(doctorLabRefusal(err(503, 'ASSISTED_BOOKING_DISABLED'))).toEqual({ kind: 'off', message: LAB_SWITCHED_OFF_MESSAGE });
    // The pharmacy's words are unchanged (a pharmacy never sees the doctor's).
    expect(labRefusal(err(403, 'SPECIALIST_NOT_VERIFIED')).message).toBe('This doctor is not verified yet. Choose another doctor.');
    // The recommended-tests field hides for a doctor not verified and active, as for a lab desk that may not load codes.
    expect(recommendationsOff(err(403, 'SPECIALIST_NOT_VERIFIED'))).toBe(true);
    expect(recommendationsOff(err(404, 'RECOMMENDATION_NOT_FOUND'))).toBe(false);
  });

  it('the consultation is read for its booking only; "Book lab test for this patient" is offered where the treating window can be open', async () => {
    const { c, calls } = client(() => json(200, { success: true, data: { booking: { _id: CONSULT, bookingDate: '20261125' }, patient: { name: 'Account Holder', phone: PHONE } } }));
    const b = await doctorToolsApi(c).appointment(CONSULT);
    expect(b).toEqual({ _id: CONSULT, bookingDate: '20261125' });
    expect(calls[0]!.url).toBe(`/api/v1/specialists/me/appointments/${CONSULT}`);
    await expect(doctorToolsApi(c).appointment('nope')).rejects.toThrow('Invalid appointment id');
    expect(calls).toHaveLength(1);

    const now = new Date('2026-11-25T04:30:00.000Z'); // 10:00 in India
    const at = (bookingTime: string, o: Record<string, unknown> = {}) =>
      labBookableFrom({ status: 'confirmed', paymentStatus: 'paid', bookingKind: 'scheduled', bookingDate: '20261125', bookingTime, ...o }, now);
    expect(at('10:05')).toBe(true); // within 10 minutes of the start
    expect(at('10:30')).toBe(false);
    expect(at('09:00', { status: 'completed' })).toBe(true);
    expect(at('09:00', { status: 'cancelled' })).toBe(false);
    expect(at('09:00', { status: 'no_show' })).toBe(false);
    expect(at('09:00', { status: 'pending', paymentStatus: 'pending' })).toBe(false);
    expect(at('09:00', { status: 'pending', paymentStatus: 'paid' })).toBe(true);
    expect(at('23:00', { bookingKind: 'instant' })).toBe(true);
  });

  it('WQ27 (r29 §25.16.4): a card create is the same body with razorpay; a doctor refused at verify or reconcile is told in its own words', async () => {
    const { c, calls } = client(() => json(201, { success: true, data: {} }));
    await doctorLabApi(c).book({ ...base, paymentMethod: 'razorpay', fromBookingId: CONSULT, typedName: 'Rina Kumari' });
    expect(calls.map((x) => `${x.method} ${x.url}`)).toEqual(['POST /api/v1/specialists/me/assisted/lab-bookings']);
    expect(calls[0]!.body).toEqual({ ...base, paymentMethod: 'razorpay', fromBookingId: CONSULT, typedName: 'Rina Kumari' });
    // DR9: the server returns the capture of a doctor no longer verified and active; never "paid", never the pharmacy's words.
    expect(outcomeOfError(err(403, 'SPECIALIST_NOT_VERIFIED'))).toEqual({ kind: 'blocked', message: DOCTOR_CARD_BLOCKED_WORDS });
    expect(outcomeOfError(err(403, 'PHARMACY_NOT_VERIFIED'))).toEqual({ kind: 'blocked', message: CARD_BLOCKED_WORDS });
  });
});
