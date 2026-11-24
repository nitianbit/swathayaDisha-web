import { ApiError, createApiClient } from './client.ts';
import { changedQuote, INSTANT_SWITCHED_OFF_MESSAGE, instantBookerRefusal, instantStage, pharmacyInstantApi, type InstantBookerRequest } from './assistedInstant.ts';

const DOC = 'd1'.repeat(12);
const REQ = 'r1'.replace('r', 'e').repeat(12);
const KEY = 'k'.repeat(32);

function recorder() {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const client = createApiClient({ baseUrl: 'https://api.example.test', getToken: () => 'tok',
    fetchImpl: async (u, init) => {
      calls.push({ method: String(init?.method), url: String(u).replace('https://api.example.test/api/v1', ''), body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      return new Response(JSON.stringify({ success: true, data: {}, pagination: { nextCursor: null } }), { status: 200 });
    } });
  return { client, calls };
}

const request = (o: Partial<InstantBookerRequest> = {}): InstantBookerRequest => ({
  requestKey: KEY, phone: '9876543210', patient: { relation: 'self', name: 'Ravi Kumar' },
  consent: { agreed: true, statementVersion: 'web-pharmacy-v2', statementLanguage: 'en' }, preferredLanguage: 'hi', specialization: ' General Physician ',
  mode: 'video', target: { kind: 'any' }, join: { on: 'partner_device' }, acceptedQuoteMinor: 50000, acceptedPayableMinor: 50000, paymentMethod: 'wallet', ...o,
});

describe('WQ22 pharmacy Consult now (r17 /pharmacy-assisted/instant)', () => {
  it('reads, requests and follows at /pharmacy-assisted/instant; the phone only in a body; the speciality trimmed', async () => {
    const { client, calls } = recorder();
    const api = pharmacyInstantApi(client);
    await api.specialities('call');
    await api.doctors({ speciality: 'Dermatology', mode: 'video' });
    await api.quote({ speciality: 'Dermatology', mode: 'video', doctorId: DOC });
    await api.quote({ speciality: 'Dermatology', mode: 'call' });
    await api.request(request());
    await api.one(REQ);
    await api.byKey(KEY);
    await api.abandon(KEY);
    await api.reoffer(REQ, { kind: 'specific', doctorId: DOC }, 3);
    await api.activity(REQ);
    await api.refund(REQ, 3);
    await api.requests({ status: 'offered', limit: 5 });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /pharmacy-assisted/instant/specialities?mode=call',
      'GET /pharmacy-assisted/instant/doctors?speciality=Dermatology&mode=video',
      `GET /pharmacy-assisted/instant/quote?speciality=Dermatology&mode=video&doctorId=${DOC}`,
      'GET /pharmacy-assisted/instant/quote?speciality=Dermatology&mode=call',
      'POST /pharmacy-assisted/instant/requests',
      `GET /pharmacy-assisted/instant/requests/${REQ}`,
      `GET /pharmacy-assisted/instant/requests/by-key/${KEY}`,
      `POST /pharmacy-assisted/instant/requests/by-key/${KEY}/abandon`,
      `POST /pharmacy-assisted/instant/requests/${REQ}/reoffer`,
      `POST /pharmacy-assisted/instant/requests/${REQ}/activity`,
      `POST /pharmacy-assisted/instant/requests/${REQ}/refund`,
      'GET /pharmacy-assisted/instant/requests?status=offered&limit=5',
    ]);
    expect(calls[4]!.body).toMatchObject({ specialization: 'General Physician', mode: 'video', target: { kind: 'any' }, join: { on: 'partner_device' },
      acceptedQuoteMinor: 50000, acceptedPayableMinor: 50000, paymentMethod: 'wallet' });
    expect(calls[8]!.body).toEqual({ target: { kind: 'specific', doctorId: DOC }, expectedStatusVersion: 3 });
    expect(calls[10]!.body).toEqual({ expectedStatusVersion: 3 });
    expect(calls.every((c) => !c.url.includes('9876543210'))).toBe(true);
  });

  it('refuses before any request: chat, a bad speciality, a bad doctor id or key, a negative version', () => {
    const { client, calls } = recorder();
    const api = pharmacyInstantApi(client);
    expect(() => api.specialities('chat' as 'video')).toThrow('Invalid mode');
    expect(() => api.doctors({ speciality: 'x', mode: 'video' })).toThrow('Invalid speciality');
    expect(() => api.request(request({ target: { kind: 'specific', doctorId: 'nope' } }))).toThrow('Invalid doctor id');
    expect(() => api.request(request({ requestKey: 'x' }))).toThrow('Invalid request key');
    expect(() => api.refund(REQ, -1)).toThrow('Invalid version');
    expect(calls).toHaveLength(0);
  });

  it('where a request stands: waiting on an open offer, the offer ran out, accepted, refunded', () => {
    const now = Date.parse('2026-11-25T05:00:00.000Z');
    expect(instantStage({ status: 'offered', offerExpiresAt: '2026-11-25T05:03:00.000Z' }, now)).toBe('waiting');
    expect(instantStage({ status: 'offered', offerExpiresAt: '2026-11-25T04:59:00.000Z' }, now)).toBe('expired');
    expect(instantStage({ status: 'offered', offerExpiresAt: null }, now)).toBe('expired');
    expect(instantStage({ status: 'accepted' }, now)).toBe('accepted');
    expect(instantStage({ status: 'refunded' }, now)).toBe('refunded');
  });

  it('refusals: a changed quote with the payable the server names; no doctor online; the switch; the wallet as the shared words', () => {
    const changed = Object.assign(new ApiError(409, 'x', 'QUOTE_CHANGED', undefined, { details: { quotedAmountMinor: 60000, discountMinor: 10000 } }));
    expect(instantBookerRefusal(changed)).toMatchObject({ kind: 'price', priceMinor: 50000 });
    expect(instantBookerRefusal(changed).message).toContain('₹500.00');
    expect(changedQuote(changed)).toEqual({ quotedAmountMinor: 60000, discountMinor: 10000 });
    expect(changedQuote(new ApiError(409, 'x', 'NO_DOCTOR_ONLINE'))).toBeNull();
    expect(instantBookerRefusal(new ApiError(409, 'x', 'NO_DOCTOR_ONLINE')).kind).toBe('doctor');
    expect(instantBookerRefusal(new ApiError(503, 'x', 'ASSISTED_BOOKING_DISABLED'))).toEqual({ kind: 'off', message: INSTANT_SWITCHED_OFF_MESSAGE });
    expect(instantBookerRefusal(new ApiError(409, 'x', 'INSUFFICIENT_BALANCE')).kind).toBe('topup');
    expect(instantBookerRefusal(new ApiError(409, 'x', 'INSTANT_REQUEST_CHANGED')).message).toContain('changed meanwhile');
    // WQ22c L3: a server without these routes (404, no code) is "not switched on"; a coded 404 keeps its own words.
    expect(instantBookerRefusal(new ApiError(404, 'Route not found'))).toEqual({ kind: 'off', message: INSTANT_SWITCHED_OFF_MESSAGE });
    expect(instantBookerRefusal(new ApiError(404, 'x', 'INSTANT_REQUEST_NOT_FOUND')).message).toBe('This request was not found.');
    // WQ22c L4: one parser: a QUOTE_CHANGED without readable details names no price.
    expect(instantBookerRefusal(new ApiError(409, 'x', 'QUOTE_CHANGED')).priceMinor).toBeUndefined();
  });
});
