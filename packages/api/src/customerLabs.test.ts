import { createApiClient } from './client.ts';
import { addressErrors, customerLabsApi, labCancelCheck, labPayableMinor, labTimeline, normalizeLab, type LabBooking } from './customerLabs.ts';

function setup(body: unknown = { success: true, data: [] }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = createApiClient({
    baseUrl: 'https://api.example.test', getToken: () => 'tok', timeoutMs: 50,
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return body instanceof Response ? body : new Response(JSON.stringify(body), { status: 200 });
    },
  });
  return { api: customerLabsApi(client), calls };
}

const P = 'a1'.repeat(12);
const B = 'b1'.repeat(12);
const slot = (startsAt: string) => ({ slotId: 's', date: '2026-11-20', startTime: '09:00', endTime: '09:30', startsAt });

describe('partner lab api', () => {
  it('sends a keyed create with exactly the backend fields, including the accepted price (Q9)', async () => {
    const { api, calls } = setup({ success: true, data: { booking: { _id: B }, paymentRequired: false, walletDeductedAmount: 0 } });
    await api.book({ partnerId: P, branchId: B, visitMode: 'lab', slotId: B, itemIds: [P], patient: { kind: 'self' }, useWalletBalance: true,
      acceptedPayableMinor: 35000, acceptedSubtotalMinor: 40000 }, 'key12345');
    expect(calls[0]!.url).toBe('https://api.example.test/api/v1/lab-bookings');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      partnerId: P, branchId: B, visitMode: 'lab', slotId: B, itemIds: [P], patient: { kind: 'self' }, useWalletBalance: true,
      acceptedPayableMinor: 35000, acceptedSubtotalMinor: 40000, requestKey: 'key12345',
    });
  });

  it('pages bookings and reads one lab, giving its branches the list shape (Q9)', async () => {
    const { api, calls } = setup({ success: true, data: { partnerId: P, name: 'Lab', branches: [
      { _id: B, name: 'Main', services: { homeCollection: true, inLab: false }, address: { line1: 'x', city: 'Pune', pincode: '411001' } }, { _id: 'bad', name: 'x' }] } });
    await expect(api.lab(P)).resolves.toEqual({ partnerId: P, name: 'Lab', logo: undefined, provider: 'partner', branches: [
      { branchId: B, name: 'Main', address: { line1: 'x', city: 'Pune', pincode: '411001' }, phone: undefined, homeCollection: true, inLab: false, hours: undefined }] });
    await api.bookings(3, 20);
    expect(calls.map((c) => c.url.replace('https://api.example.test/api/v1', ''))).toEqual([`/partner-labs/${P}`, '/lab-bookings?page=3&limit=20']);
    expect(normalizeLab(null)).toMatchObject({ branches: [] });
  });

  it('works out the payable like the server: subtotal minus the coupon, never below zero', () => {
    expect(labPayableMinor(40000, 50)).toBe(35000);
    expect(labPayableMinor(40000)).toBe(40000);
    expect(labPayableMinor(4000, 99.999)).toBe(0);
  });

  it('reads slots with the branch, mode and window; refuses malformed ids before calling', async () => {
    const { api, calls } = setup();
    await api.slots(B, 'home', '2026-11-20', 45);
    expect(calls[0]!.url).toBe(`https://api.example.test/api/v1/partner-labs/branches/${B}/slots?visitMode=home&from=2026-11-20&days=30`);
    expect(() => api.booking('../admins')).toThrow('Invalid booking id');
    expect(() => api.labs({ pincode: '012345' })).toThrow('Invalid pincode');
    expect(calls).toHaveLength(1);
  });

  it('accepts a proposal by its version, cancels with a note, and pays again without wallet by default', async () => {
    const { api, calls } = setup({ success: true, data: {} });
    await api.acceptReschedule(B, 3);
    await api.cancel(B, 'Travelling');
    await api.payAgain(B);
    expect(calls.map((c) => [c.url.replace('https://api.example.test/api/v1', ''), JSON.parse(String(c.init.body))])).toEqual([
      [`/lab-bookings/${B}/accept-reschedule`, { version: 3 }],
      [`/lab-bookings/${B}/cancel`, { note: 'Travelling' }],
      [`/lab-bookings/${B}/pay`, {}],
    ]);
  });

  it('reads a released report through the authenticated file route (no token in the URL)', async () => {
    const { api, calls } = setup(new Response('%PDF-1.7', { status: 200 }));
    const blob = await api.reportFile(`/api/static/partner-lab-reports/${B}/r.pdf`);
    expect(await blob.text()).toBe('%PDF-1.7');
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/api/v1/file/fetch');
    expect(url.searchParams.get('url')).toBe(`/api/v1/file/static/partner-lab-reports/${B}/r.pdf`);
    expect(calls[0]!.url).not.toContain('tok');
  });
});

describe('lab cancellation rule (customerCancel)', () => {
  const now = new Date('2026-11-20T00:00:00Z');
  const at = (h: number) => new Date(now.getTime() + h * 3_600_000).toISOString();
  it('unpaid bookings can be cancelled any time; paid ones until 2 hours before the slot', () => {
    expect(labCancelCheck({ status: 'pending_payment', paymentStatus: 'pending', slot: slot(at(0.5)) }, now)).toEqual({ ok: true, deadline: null, refund: false });
    expect(labCancelCheck({ status: 'confirmed', paymentStatus: 'paid', slot: slot(at(3)) }, now)).toEqual({ ok: true, deadline: new Date(at(1)), refund: true });
    expect(labCancelCheck({ status: 'confirmed', paymentStatus: 'paid', slot: slot(at(1.5)) }, now)).toEqual({ ok: false, reason: 'window_closed' });
  });
  it('an unanswered lab reschedule lifts the cutoff; later states cannot be cancelled', () => {
    expect(labCancelCheck({ status: 'confirmed', paymentStatus: 'paid', slot: slot(at(1)), reschedule: { version: 1, pending: true } }, now))
      .toEqual({ ok: true, deadline: null, refund: true });
    expect(labCancelCheck({ status: 'sample_collected', paymentStatus: 'paid', slot: slot(at(5)) }, now)).toEqual({ ok: false, reason: 'state' });
  });
});

describe('lab timeline', () => {
  const base = { visitMode: 'home' as const, createdAt: '2026-11-19T10:00:00Z' };
  it('follows the home path with the recorded times', () => {
    const steps = labTimeline({ ...base, status: 'processing', lifecycle: { paidAt: 'p', confirmedAt: 'c', collectedAt: 'x', processingAt: 'y' } });
    expect(steps.map((s) => [s.key, s.done, s.at])).toEqual([
      ['booked', true, base.createdAt], ['confirmed', true, 'c'], ['collected', true, 'x'], ['processing', true, 'y'],
      ['report_ready', false, undefined], ['completed', false, undefined],
    ]);
  });
  it('ends at the cancellation', () => {
    const steps = labTimeline({ visitMode: 'lab', status: 'cancelled', lifecycle: { cancelledAt: 'z' } } as Pick<LabBooking, 'status' | 'visitMode' | 'lifecycle'>);
    expect(steps.map((s) => s.key)).toEqual(['booked', 'cancelled']);
  });
});

describe('home collection address', () => {
  it('mirrors the backend limits', () => {
    expect(addressErrors({ line1: '12 MG Road', city: 'Pune', pincode: '411001' })).toEqual({});
    expect(Object.keys(addressErrors({ line1: 'ab', city: 'P', pincode: '011001' })).sort()).toEqual(['city', 'line1', 'pincode']);
  });
});
