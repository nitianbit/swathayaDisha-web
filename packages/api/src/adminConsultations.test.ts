import { createApiClient } from './client.ts';
import { adminNoShowMove, consultationAdminApi, consultationQueryProblem, type AdminConsultation } from './adminConsultations.ts';
import { professionalInput, canEditProfessional, partnerWorkspaceApi } from './partners.ts';

const ID = 'a1'.repeat(12);
const DOC = 'd1'.repeat(12);
const M = 'b2'.repeat(12);
const P = 'c3'.repeat(12);

function recorder() {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const client = createApiClient({ baseUrl: 'https://api.example.test', getToken: () => 'tok',
    fetchImpl: async (u, init) => {
      calls.push({ method: String(init?.method), url: String(u).replace('https://api.example.test/api/v1', ''), body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      return new Response(JSON.stringify({ success: true, data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 1 } }), { status: 200 });
    } });
  return { client, calls };
}

const booking = (o: Partial<AdminConsultation>): AdminConsultation => ({
  _id: ID, bookingType: 'consultation', bookingDate: '20261117', bookingTime: '10:00', status: 'no_show', paymentStatus: 'paid', ...o,
});

describe('admin consultations (bookings getAll as admin, slots/available)', () => {
  it('lists consultation bookings with status, doctor and India dates as the backend’s YYYYMMDD, 20 a page', async () => {
    const { client, calls } = recorder();
    const api = consultationAdminApi(client);
    await api.list({ status: 'confirmed', specialistId: DOC, from: '2026-11-01', to: '2026-11-30', page: 3 });
    await api.list();
    await api.get(ID);
    await api.doctors(' Mehta ');
    await api.freeSlots(DOC, '2026-11-21', 'video');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET /bookings?bookingType=consultation&status=confirmed&specialistId=${DOC}&bookingDateFrom=20261101&bookingDateTo=20261130&page=3&limit=20`,
      'GET /bookings?bookingType=consultation&page=1&limit=20',
      `GET /bookings/${ID}`,
      'GET /specialists?name=Mehta&page=1&limit=20',
      `GET /slots/available?specialistId=${DOC}&date=20261121&mode=video`,
    ]);
  });

  it('refuses ids, dates and periods the server would refuse, before any request', () => {
    const { client, calls } = recorder();
    const api = consultationAdminApi(client);
    expect(() => api.get('x')).toThrow('Invalid booking id');
    expect(() => api.list({ specialistId: '../x' })).toThrow('Invalid doctor id');
    expect(() => api.list({ from: '2026-02-30' })).toThrow('Enter real dates.');
    expect(() => api.list({ from: '2026-11-30', to: '2026-11-01' })).toThrow('The period ends before it starts.');
    expect(() => api.freeSlots(DOC, '2026-13-01')).toThrow();
    expect(() => api.doctors('  ')).toThrow('Invalid search');
    expect(consultationQueryProblem({ from: '2026-11-01', to: '2026-11-01' })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('a no-show moves once; never an instant one; a front-desk one is the clinic’s', () => {
    expect(adminNoShowMove(booking({}))).toBe('offer');
    expect(adminNoShowMove(booking({ noShowReschedules: 1 }))).toBe('used');
    expect(adminNoShowMove(booking({ noShows: [{ rescheduledAt: '2026-11-18T05:00:00Z' }] }))).toBe('used');
    expect(adminNoShowMove(booking({ bookingKind: 'instant' }))).toBe('instant');
    expect(adminNoShowMove(booking({ clinicDesk: { partnerId: P, branchId: P } }))).toBe('clinic');
    expect(adminNoShowMove(booking({ status: 'confirmed', noShows: [{ rescheduledAt: '2026-11-18T05:00:00Z' }] }))).toBeNull();
  });
});

describe('professional registration (Q11 memberProfessionalSchema, setMemberProfessional)', () => {
  it('sends kind and trimmed number, or null to remove, with the version fence, on both scopes', async () => {
    const { client, calls } = recorder();
    await partnerWorkspaceApi(client, { kind: 'member' }).setProfessional(M, { kind: 'pathologist', registrationNumber: 'KMC-11' }, '2026-11-20T00:00:00.000Z');
    await partnerWorkspaceApi(client, { kind: 'admin', partnerId: P }).setProfessional(M, null);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `PUT /partner-workspace/members/${M}/professional`,
      `PUT /partner-workspace/admin/${P}/workspace/members/${M}/professional`,
    ]);
    expect(calls[0]!.body).toEqual({ professional: { kind: 'pathologist', registrationNumber: 'KMC-11' }, expectedUpdatedAt: '2026-11-20T00:00:00.000Z' });
    expect(calls[1]!.body).toEqual({ professional: null });
  });

  it('checks the kind and a 3 to 60 character number; only owners (and admins as owner) edit it', () => {
    expect(professionalInput('pathologist', '  KMC-11 ')).toEqual({ value: { kind: 'pathologist', registrationNumber: 'KMC-11' } });
    expect(professionalInput('', 'K1')).toEqual({ problem: { kind: 'Choose what they are registered as.', registrationNumber: 'Enter the registration number (3 to 60 characters).' } });
    expect('problem' in professionalInput('doctor', 'x'.repeat(61))).toBe(true);
    expect('value' in professionalInput('pharmacist', 'x'.repeat(60))).toBe(true);
    expect(canEditProfessional({ role: 'owner' }, { isActive: true })).toBe(true);
    expect(canEditProfessional({ role: 'staff' }, { isActive: true })).toBe(false);
    expect(canEditProfessional({ role: 'owner' }, { isActive: false })).toBe(false);
  });
});
