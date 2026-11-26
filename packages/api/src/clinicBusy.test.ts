import { describe, expect, it } from 'vitest';
import { createApiClient } from './client.ts';
import { partnerClinicApi } from './clinic.ts';

// WQ57 (r40): the day's appointments with each doctor's busy blocks beside them (no patient or place); WQ57b (r40d) the lookup.
const DOC = 'd1'.repeat(12);
function client(answer: unknown) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const c = createApiClient({ baseUrl: '', getToken: () => 'tok', timeoutMs: 100, fetchImpl: async (u, init) => {
    calls.push({ url: String(u), method: String(init?.method), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } });
  return { c, calls };
}
describe('WQ57 clinic busy blocks and lookup', () => {
  it('reads `busy` beside `data` (malformed blocks dropped) with the same query as the appointments', async () => {
    const { c, calls } = client({ success: true, data: [{ bookingId: 'x' }],
      busy: [{ doctorId: DOC, from: '2026-11-26T05:00:00.000Z', to: '2026-11-26T05:30:00.000Z' }, { doctorId: 1 }, null] });
    const api = partnerClinicApi(c, { kind: 'member' });
    const r = await api.dayView({ from: '2026-11-26', to: '2026-11-26', doctorId: DOC });
    expect(r.appointments).toHaveLength(1);
    expect(r.busy).toEqual([{ doctorId: DOC, from: '2026-11-26T05:00:00.000Z', to: '2026-11-26T05:30:00.000Z' }]);
    await api.appointments({ from: '2026-11-26', to: '2026-11-26', doctorId: DOC });
    expect(calls[0]!.url).toBe(calls[1]!.url);
    await expect(api.dayView({ from: '2026-11-26', to: '2026-01-01' })).rejects.toThrow();
  });
  it('looks a number up by POST (the number in the body only)', async () => {
    const { c, calls } = client({ success: true, data: { exists: true, holderNameMasked: 'R*** K***' } });
    expect(await partnerClinicApi(c, { kind: 'member' }).lookup('98765 43210')).toEqual({ exists: true, holderNameMasked: 'R*** K***' });
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/v1/partner-workspace/clinic/patients/lookup', body: { phone: '9876543210' } });
    expect(() => partnerClinicApi(c, { kind: 'member' }).lookup('123')).toThrow();
  });
});
