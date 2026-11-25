import { describe, expect, it } from 'vitest';
import { ApiError, createApiClient } from './client.ts';
import { doctorRecordsApi, holderRecordsApi, pickTreating, recordsAccessState, recordsErrorCode, type RecordsAccess } from './recordsAccess.ts';

// WQ28 (backend r30 phase 3f, design §25.17): records access — the doctor's treating view and request, the holder's answers.

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const BK = 'c7'.repeat(12);
const HOLDER = 'f1'.repeat(12);
const REQ = 'a1'.repeat(12);
const GRANT = 'a2'.repeat(12);
type Call = { url: string; method: string; body: unknown };
function client(answer: (c: Call) => Response) {
  const calls: Call[] = [];
  const c = createApiClient({ baseUrl: '', getToken: () => 'tok', timeoutMs: 100, fetchImpl: async (u, init) => {
    const call = { url: String(u), method: String(init?.method), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return answer(call).clone();
  } });
  return { c, calls };
}
const access = (o: Partial<RecordsAccess> = {}): RecordsAccess => ({ window: { opensAt: null, closesAt: null }, grant: null, request: null, ...o });

describe('WQ28 records access (r30)', () => {
  it('the treating view reads the booking for its account, then the history with bookingId; only what the page shows is kept', async () => {
    const { c, calls } = client((x) => (x.url.includes('/appointments/')
      ? json(200, { success: true, data: { booking: { _id: BK, userId: HOLDER, bookingDate: '20261125' }, patient: { name: 'Asha Rao', phone: '9876543210' } } })
      : json(200, { success: true, data: {
        patient: { name: 'Asha Rao', phone: '9876543210', email: 'a@x.in' },
        consultations: [{ bookingId: BK, bookingDate: '20261125', bookingTime: '09:30', status: 'confirmed', consultationMode: 'video', prescription: { diagnosis: 'x' }, notes: 'n', price: 500 }],
        others: {
          consultations: [{ bookingId: 'b5'.repeat(12), date: '20261101', doctorName: 'Meena Iyer', specialization: 'Dermatology', diagnosis: 'Eczema', medicines: [{ name: 'M' }],
            prescriptionFile: '/api/static/bookings/x/p.pdf' }],
          labReports: [{ labBookingId: 'b6'.repeat(12), labName: 'Sun', date: '2026-11-10', tests: ['CBC'], releases: [{ file: '/api/static/r.pdf', releasedAt: '2026-11-11', signer: { name: 'S' } }] }],
        },
        access: { window: { opensAt: null, closesAt: null }, grant: null, request: null },
      } })));
    const r = await doctorRecordsApi(c).treating(BK);
    expect(calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      `GET /api/v1/specialists/me/appointments/${BK}`,
      `GET /api/v1/specialists/me/patients/${HOLDER}/history?bookingId=${BK}`,
    ]);
    expect(r.consultations).toEqual([{ bookingId: BK, bookingDate: '20261125', bookingTime: '09:30', consultationMode: 'video', status: 'confirmed' }]);
    expect(r.others).toEqual({
      consultations: [{ bookingId: 'b5'.repeat(12), date: '20261101', doctorName: 'Meena Iyer', specialization: 'Dermatology', prescriptionFile: '/api/static/bookings/x/p.pdf' }],
      labReports: [{ labBookingId: 'b6'.repeat(12), labName: 'Sun', date: '2026-11-10', tests: ['CBC'], releases: [{ file: '/api/static/r.pdf', releasedAt: '2026-11-11' }] }],
    });
    // No patient contacts and no other health details are kept.
    expect(JSON.stringify(r)).not.toMatch(/Asha|9876543210|a@x\.in|Eczema|diagnosis|notes|price/);
    expect(pickTreating({ access: access() }).others).toBeNull();
  });

  it('the request and the holder’s routes; ids are checked before any request', async () => {
    const { c, calls } = client(() => json(200, { success: true, data: [] }));
    await doctorRecordsApi(c).request(BK);
    const h = holderRecordsApi(c);
    await h.requests('pending');
    await h.requests();
    await h.approve(REQ);
    await h.deny(REQ);
    await h.grants();
    await h.revoke(GRANT);
    expect(calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      `POST /api/v1/specialists/me/bookings/${BK}/records-access/request`,
      'GET /api/v1/records-access/requests?state=pending', 'GET /api/v1/records-access/requests',
      `POST /api/v1/records-access/requests/${REQ}/approve`, `POST /api/v1/records-access/requests/${REQ}/deny`,
      'GET /api/v1/records-access/grants', `POST /api/v1/records-access/grants/${GRANT}/revoke`,
    ]);
    expect(() => h.approve('nope')).toThrow('Invalid request id');
    expect(() => doctorRecordsApi(c).request('nope')).toThrow('Invalid booking id');
    expect(calls).toHaveLength(7);
  });

  it('where the request stands: a grant in force, waiting (until its expiry), denied, ended or replaced, none', () => {
    const now = new Date('2026-11-25T04:30:00.000Z');
    const later = '2026-11-26T04:30:00.000Z';
    const earlier = '2026-11-25T03:00:00.000Z';
    expect(recordsAccessState(access(), now)).toBe('none');
    expect(recordsAccessState(access({ request: { state: 'pending', createdAt: earlier, expiresAt: later } }), now)).toBe('pending');
    expect(recordsAccessState(access({ request: { state: 'pending', createdAt: earlier, expiresAt: earlier } }), now)).toBe('expired');
    expect(recordsAccessState(access({ request: { state: 'denied', createdAt: earlier, expiresAt: later } }), now)).toBe('denied');
    expect(recordsAccessState(access({ request: { state: 'replaced', createdAt: earlier, expiresAt: later } }), now)).toBe('expired');
    expect(recordsAccessState(access({ grant: { at: earlier, expiresAt: later, via: 'app' } }), now)).toBe('approved');
    // A grant that ran out is not one; the request's own state then says it.
    expect(recordsAccessState(access({ grant: { at: earlier, expiresAt: earlier, via: 'app' }, request: { state: 'denied', createdAt: earlier, expiresAt: later } }), now)).toBe('denied');
    // Allowed once, but the holder stopped it (or the 12 months ran out): the doctor may ask again.
    expect(recordsAccessState(access({ request: { state: 'approved', createdAt: earlier, expiresAt: later } }), now)).toBe('none');
    expect(recordsErrorCode(new ApiError(409, 'x', 'TREATING_WINDOW_CLOSED'))).toBe('TREATING_WINDOW_CLOSED');
    expect(recordsErrorCode(new Error('x'))).toBeNull();
  });
});
