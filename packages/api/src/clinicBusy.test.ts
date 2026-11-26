import { describe, expect, it } from 'vitest';
import { createApiClient } from './client.ts';
import { freeOfBusy, partnerClinicApi } from './clinic.ts';

// WQ57 (r40): the day's appointments with each doctor's busy blocks beside them (no patient or place).
const DOC = 'd1'.repeat(12);
describe('WQ57 clinic busy blocks', () => {
  it('reads `busy` beside `data` (malformed blocks dropped) and says which times are free', async () => {
    const c = createApiClient({ baseUrl: '', getToken: () => 'tok', timeoutMs: 100, fetchImpl: async () => new Response(JSON.stringify({
      success: true, data: [{ bookingId: 'x' }],
      busy: [{ doctorId: DOC, from: '2026-11-26T05:00:00.000Z', to: '2026-11-26T05:30:00.000Z' }, { doctorId: 1 }, null],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }) });
    const r = await partnerClinicApi(c, { kind: 'member' }).dayView({ from: '2026-11-26', to: '2026-11-26' });
    expect(r.appointments).toHaveLength(1);
    expect(r.busy).toEqual([{ doctorId: DOC, from: '2026-11-26T05:00:00.000Z', to: '2026-11-26T05:30:00.000Z' }]);
    const at = (iso: string) => Date.parse(iso);
    expect(freeOfBusy(DOC, at('2026-11-26T05:15:00.000Z'), at('2026-11-26T05:45:00.000Z'), r.busy)).toBe(false);
    expect(freeOfBusy(DOC, at('2026-11-26T05:30:00.000Z'), at('2026-11-26T06:00:00.000Z'), r.busy)).toBe(true);
    expect(freeOfBusy('d2'.repeat(12), at('2026-11-26T05:15:00.000Z'), at('2026-11-26T05:45:00.000Z'), r.busy)).toBe(true);
  });
});
