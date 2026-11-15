import { createApiClient } from './client.ts';
import { countdown, heldRefundMinor, instantConsultApi, instantPayableMinor, waitingState } from './instantConsult.ts';

const D = 'd1'.repeat(12);
const R = 'e1'.repeat(12);

function setup() {
  const calls: { url: string; body: unknown }[] = [];
  const client = createApiClient({ baseUrl: 'https://api.example.test', getToken: () => 'tok', timeoutMs: 50,
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input).replace('https://api.example.test/api/v1', ''), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ success: true, data: {} }));
    } });
  return { api: instantConsultApi(client), calls };
}

describe('instant consult api', () => {
  it('creates with the validated shape: target, trimmed speciality, patient, request key', async () => {
    const { api, calls } = setup();
    await api.create({ target: { kind: 'any' }, specialization: '  Dermatology ', mode: 'video', patient: { kind: 'dependent', dependentId: D }, useWalletBalance: false,
      acceptedQuoteMinor: 50000, acceptedPayableMinor: 45000 }, 'k_123456');
    expect(calls[0]).toEqual({ url: '/instant/requests', body: {
      target: { kind: 'any' }, specialization: 'Dermatology', mode: 'video', patient: { kind: 'dependent', dependentId: D }, useWalletBalance: false,
      acceptedQuoteMinor: 50000, acceptedPayableMinor: 45000, requestKey: 'k_123456',
    } });
  });
  it('reads specialities for a mode and pages the requests (Q9)', async () => {
    const { api, calls } = setup();
    await api.specialities('chat');
    await api.requests(2, 20);
    expect(calls.map((c) => c.url)).toEqual(['/instant/specialities?mode=chat', '/instant/requests?page=2&limit=20']);
  });
  it('quotes for a doctor or any available, and re-offers within the request', async () => {
    const { api, calls } = setup();
    await api.quote('General Physician', 'call', D);
    await api.quote('General Physician', 'call');
    await api.reoffer(R, { kind: 'specific', doctorId: D });
    await api.activity(R);
    await api.refund(R);
    expect(calls.map((c) => c.url)).toEqual([
      `/instant/quote?specialization=General+Physician&mode=call&doctorId=${D}`, '/instant/quote?specialization=General+Physician&mode=call',
      `/instant/requests/${R}/reoffer`, `/instant/requests/${R}/activity`, `/instant/requests/${R}/refund`,
    ]);
    expect(calls[2]!.body).toEqual({ target: { kind: 'specific', doctorId: D } });
  });
  it('refuses a too-short speciality or a malformed id before calling', () => {
    const { api, calls } = setup();
    expect(() => api.doctors(' a ', 'chat')).toThrow('Invalid speciality');
    expect(() => api.reoffer('nope', { kind: 'any' })).toThrow('Invalid request id');
    expect(calls).toHaveLength(0);
  });
});

describe('waiting rules', () => {
  const now = Date.parse('2026-11-20T10:00:00Z');
  it('an offer is open until it expires; only a held, offered request is waiting', () => {
    expect(waitingState({ status: 'offered', fundingState: 'held', offerExpiresAt: '2026-11-20T10:03:00Z' }, now)).toBe('offer_open');
    expect(waitingState({ status: 'offered', fundingState: 'held', offerExpiresAt: '2026-11-20T09:59:59Z' }, now)).toBe('offer_expired');
    expect(waitingState({ status: 'accepted', fundingState: 'allocated', offerExpiresAt: '2026-11-20T10:03:00Z' }, now)).toBe('not_waiting');
  });
  it('counts down in m:ss and never below zero', () => {
    expect(countdown('2026-11-20T10:04:05Z', now)).toBe('4:05');
    expect(countdown('2026-11-20T09:00:00Z', now)).toBe('0:00');
  });
  it('the payable is the quote minus the coupon, like the server', () => {
    expect(instantPayableMinor(50000, 50)).toBe(45000);
    expect(instantPayableMinor(50000, 900)).toBe(0);
  });
  it('a refund amount comes from the server record (Q9), else wallet + gateway held (the coupon part is not money)', () => {
    expect(heldRefundMinor({ refundReason: 'inactivity', refunded: { walletMinor: 5000, gatewayMinor: 40000, totalMinor: 45000 },
      funding: { couponMinor: 0, walletMinor: 1, gatewayMinor: 1, totalMinor: 2 } })).toBe(45000);
    expect(heldRefundMinor({ refundReason: 'customer', funding: { couponMinor: 5000, walletMinor: 10000, gatewayMinor: 35000, totalMinor: 50000 } })).toBe(45000);
    expect(heldRefundMinor({ refundReason: 'doctor_cancelled', refunded: { walletMinor: 0, gatewayMinor: 30000, totalMinor: 30000 } })).toBe(30000);
  });
});
