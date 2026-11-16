import { createApiClient } from './client.ts';
import {
  appointmentAt, appointmentDay, appointmentRangeProblem, canonicalMobile, clinicBranchesFor, deskActions, deskBookingProblems, doctorsAtBranch,
  inviteProblems, partnerClinicApi, type ClinicAppointment,
} from './clinic.ts';
import { ADMIN_ACTOR, type Branch } from './partners.ts';

const P = 'a2'.repeat(12);
const B1 = 'c1'.repeat(12);
const B2 = 'c2'.repeat(12);
const D = 'd1'.repeat(12);
const S = 'e5'.repeat(12);
const K = 'f6'.repeat(12);
const I = 'f7'.repeat(12);

function recorder() {
  const calls: { method: string; url: string; body: unknown; headers: Record<string, string> }[] = [];
  const client = createApiClient({ baseUrl: 'https://api.example.test', getToken: () => 'tok',
    fetchImpl: async (u, init) => {
      const raw = init?.body;
      calls.push({ method: String(init?.method), url: String(u).replace('https://api.example.test/api/v1', ''),
        body: typeof raw === 'string' ? JSON.parse(raw) : undefined, headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response(JSON.stringify({ success: true, data: {} }), { status: 200 });
    } });
  return { client, calls };
}

const owner = { role: 'owner' as const, permissions: [], branchIds: [] };
const restricted = { role: 'staff' as const, permissions: ['bookings.manage' as const, 'staff.manage' as const], branchIds: [B1] };
const viewer = { role: 'staff' as const, permissions: ['bookings.view' as const], branchIds: [] };

const appt = (o: Partial<ClinicAppointment> = {}): ClinicAppointment => ({
  bookingId: K, bookingDate: '20261117', bookingTime: '10:30', status: 'confirmed', doctorId: D, doctorName: 'Dr Mehta', branchId: B1, slotId: S,
  consultationMode: 'in-person', fee: 500, payAtClinic: true, arrivedAt: null, source: 'desk', paidOnline: false, patient: { name: 'Asha', phone: '9800000001' }, ...o,
});

describe('mobile numbers (canonicalMobile, common/utils/phone.ts)', () => {
  it('reads the forms the server reads as ten digits', () => {
    for (const raw of ['9876543210', '+91 98765 43210', '919876543210', '09876543210', '98765-43210']) expect(canonicalMobile(raw)).toBe('9876543210');
    for (const bad of ['', '98765', '+1 9876543210', '9876543210x', '0098765432100']) expect(canonicalMobile(bad)).toBeNull();
  });
});

describe('invitations (inviteDoctorSchema, assertScopeWithin, clinicBranch)', () => {
  it('needs a mobile or a doctor id, and keeps a restricted manager inside their branches', () => {
    expect(inviteProblems({ by: 'phone', value: '98765 43210', branchIds: [] }, owner)).toEqual({});
    expect(inviteProblems({ by: 'phone', value: '12345', branchIds: [] }, owner).value).toMatch(/ten-digit/);
    expect(inviteProblems({ by: 'doctorId', value: D, branchIds: [B1, B2] }, owner)).toEqual({});
    expect(inviteProblems({ by: 'doctorId', value: 'abc', branchIds: [] }, owner).value).toMatch(/24 characters/);
    expect(inviteProblems({ by: 'doctorId', value: D, branchIds: [] }, restricted).branchIds).toMatch(/your own branches/);
    expect(inviteProblems({ by: 'doctorId', value: D, branchIds: [B2] }, restricted).branchIds).toMatch(/your own branches/);
    expect(inviteProblems({ by: 'doctorId', value: D, branchIds: [B1] }, restricted)).toEqual({});
    expect(inviteProblems({ by: 'doctorId', value: D, branchIds: Array.from({ length: 51 }, () => B1) }, owner).branchIds).toMatch(/at most 50/);
  });

  it('offers only active in-clinic branches in scope, and doctors who consult there', () => {
    const br = (id: string, o: Partial<Branch> = {}) => ({ _id: id, services: { inClinic: true }, isActive: true, ...o }) as Branch;
    const all = [br(B1), br(B2), br('c3'.repeat(12), { services: { inLab: true } }), br('c4'.repeat(12), { isActive: false })];
    expect(clinicBranchesFor(all, owner).map((b) => b._id)).toEqual([B1, B2]);
    expect(clinicBranchesFor(all, restricted).map((b) => b._id)).toEqual([B1]);
    const docs = [{ id: 1, active: true, branchIds: [] }, { id: 2, active: true, branchIds: [B2] }, { id: 3, active: false, branchIds: [B1] }];
    expect(doctorsAtBranch(docs, B1).map((d) => d.id)).toEqual([1]);
    expect(doctorsAtBranch(docs, B2).map((d) => d.id)).toEqual([1, 2]);
  });
});

describe('desk booking and list rules (deskBookingSchema, listClinicAppointments, parseAppointment)', () => {
  it('checks the patient details as the server does', () => {
    expect(deskBookingProblems({ phone: '+91 98000 00001', name: '', notes: '' })).toEqual({});
    expect(deskBookingProblems({ phone: '', name: '', notes: '' }).phone).toMatch(/Enter the patient/);
    expect(deskBookingProblems({ phone: '98000', name: 'x'.repeat(121), notes: 'y'.repeat(1001) })).toEqual({
      phone: expect.stringMatching(/ten-digit/), name: expect.stringMatching(/120/), notes: expect.stringMatching(/1000/),
    });
  });

  it('allows real dates, from ≤ to, at most 31 days', () => {
    expect(appointmentRangeProblem('2026-11-17', '2026-11-17')).toBeNull();
    expect(appointmentRangeProblem('2026-11-01', '2026-12-01')).toBeNull();
    expect(appointmentRangeProblem('2026-11-01', '2026-12-02')).toMatch(/31 days/);
    expect(appointmentRangeProblem('2026-11-17', '2026-11-16')).toMatch(/before/);
    expect(appointmentRangeProblem('2026-02-30', '2026-03-01')).toMatch(/real dates/);
  });

  it('reads appointment dates and times in India time, in both stored formats', () => {
    expect(appointmentDay('20261117')).toBe('2026-11-17');
    expect(appointmentDay('20260230')).toBeNull();
    expect(appointmentAt({ bookingDate: '20261117', bookingTime: '10:30' })?.toISOString()).toBe('2026-11-17T05:00:00.000Z');
    expect(appointmentAt({ bookingDate: '20261117', bookingTime: '2:15 PM' })?.toISOString()).toBe('2026-11-17T08:45:00.000Z');
    expect(appointmentAt({ bookingDate: '20261117', bookingTime: 'soon' })).toBeNull();
  });
});

describe('desk steps (markArrived, closeDeskAppointment, cancel/reschedule)', () => {
  const before = new Date('2026-11-17T04:30:00Z'); // 10:00 IST
  const after = new Date('2026-11-17T05:10:00Z'); // 10:40 IST
  const acts = (a: ClinicAppointment, now: Date, actor = owner) => deskActions(a, actor, now).map((o) => (o.blocked ? `${o.action}!` : o.action));

  it('offers check-in, seen, no-show after the time, move and cancel on a booked desk appointment', () => {
    expect(acts(appt(), before)).toEqual(['arrived', 'complete', 'no_show!', 'reschedule', 'cancel']);
    expect(acts(appt(), after)).toEqual(['arrived', 'complete', 'no_show', 'reschedule', 'cancel']);
    expect(acts(appt({ arrivedAt: '2026-11-17T04:50:00Z' }), after)).toEqual(['complete', 'no_show', 'reschedule', 'cancel']);
    expect(acts(appt({ bookingTime: 'unreadable' }), after)).toEqual(['arrived', 'complete', 'no_show!', 'reschedule', 'cancel']);
  });

  it('offers nothing on finished, online or view-only appointments', () => {
    for (const status of ['completed', 'cancelled', 'no_show'] as const) expect(acts(appt({ status }), after)).toEqual([]);
    expect(acts(appt({ status: 'pending' }), after)).toEqual(['reschedule', 'cancel']);
    expect(acts(appt({ source: 'online' }), after)).toEqual([]);
    expect(deskActions(appt(), viewer, after)).toEqual([]);
    expect(deskActions(appt(), ADMIN_ACTOR, after).length).toBe(5);
  });
});

describe('partnerClinicApi paths (member and admin-as-owner)', () => {
  it('builds member paths and bodies', async () => {
    const { client, calls } = recorder();
    const api = partnerClinicApi(client, { kind: 'member' });
    await api.doctors();
    await api.invites('pending');
    await api.invite({ phone: '+91 98765 43210', branchIds: [B1] });
    await api.invite({ doctorId: D, branchIds: [] });
    await api.revokeInvite(I);
    await api.deskSlots({ doctorId: D, branchId: B1, date: '2026-11-17' });
    await api.appointments({ from: '2026-11-17', to: '2026-11-17', branchId: B1 });
    await api.book({ slotId: S, customer: { phone: '098000 00001', name: 'Asha' }, notes: 'Walk-in', requestKey: 'k'.repeat(32) });
    await api.arrived(K);
    await api.complete(K);
    await api.noShow(K);
    await api.cancel(K, '  ');
    await api.cancel(K, ' Doctor away ');
    await api.reschedule(K, S);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /partner-workspace/clinic/doctors',
      'GET /partner-workspace/clinic/doctor-invites?state=pending',
      'POST /partner-workspace/clinic/doctor-invites',
      'POST /partner-workspace/clinic/doctor-invites',
      `DELETE /partner-workspace/clinic/doctor-invites/${I}`,
      `GET /partner-workspace/clinic/slots?doctorId=${D}&branchId=${B1}&date=2026-11-17`,
      `GET /partner-workspace/clinic/appointments?from=2026-11-17&to=2026-11-17&branchId=${B1}`,
      'POST /partner-workspace/clinic/appointments',
      `POST /partner-workspace/clinic/appointments/${K}/arrived`,
      `POST /partner-workspace/clinic/appointments/${K}/complete`,
      `POST /partner-workspace/clinic/appointments/${K}/no-show`,
      `POST /partner-workspace/clinic/appointments/${K}/cancel`,
      `POST /partner-workspace/clinic/appointments/${K}/cancel`,
      `POST /partner-workspace/clinic/appointments/${K}/reschedule`,
    ]);
    expect(calls[2]!.body).toEqual({ phone: '9876543210', branchIds: [B1] });
    expect(calls[3]!.body).toEqual({ doctorId: D, branchIds: [] });
    // The request key is in the body (the route reads no header); the mobile goes out in its ten-digit form.
    expect(calls[7]!.body).toEqual({ slotId: S, customer: { phone: '9800000001', name: 'Asha' }, notes: 'Walk-in', requestKey: 'k'.repeat(32) });
    expect(calls[7]!.headers['Idempotency-Key']).toBeUndefined();
    expect(calls[11]!.body).toEqual({});
    expect(calls[12]!.body).toEqual({ reason: 'Doctor away' });
    expect(calls[13]!.body).toEqual({ slotId: S });
  });

  it('builds admin-as-owner paths', async () => {
    const { client, calls } = recorder();
    const api = partnerClinicApi(client, { kind: 'admin', partnerId: P });
    await api.doctors();
    await api.arrived(K);
    expect(calls.map((c) => c.url)).toEqual([
      `/partner-workspace/admin/${P}/workspace/clinic/doctors`,
      `/partner-workspace/admin/${P}/workspace/clinic/appointments/${K}/arrived`,
    ]);
  });

  it('checks ids, phones, dates and keys before building any path', () => {
    const { client, calls } = recorder();
    const api = partnerClinicApi(client, { kind: 'member' });
    expect(() => api.revokeInvite('../x')).toThrow(/invitation id/);
    expect(() => api.invites('all' as never)).toThrow(/state/);
    expect(() => api.invite({ phone: '123', branchIds: [] })).toThrow(/mobile/);
    expect(() => api.invite({ doctorId: D, branchIds: ['nope'] })).toThrow(/branch id/);
    expect(() => api.deskSlots({ doctorId: D, branchId: B1, date: '2026-02-30' })).toThrow(/date/);
    expect(() => api.appointments({ from: '2026-11-01', to: '2026-12-15' })).toThrow(/31 days/);
    expect(() => api.appointments({ from: '2026-11-01', to: '2026-11-02', status: 'gone' as never })).toThrow(/status/);
    expect(() => api.book({ slotId: S, customer: { phone: '1' }, requestKey: 'k'.repeat(32) })).toThrow(/mobile/);
    expect(() => api.book({ slotId: S, customer: { phone: '9800000001' }, requestKey: 'short' })).toThrow(/request key/);
    expect(() => api.book({ slotId: 'x', customer: { phone: '9800000001' }, requestKey: 'k'.repeat(32) })).toThrow(/slot id/);
    expect(() => api.reschedule(K, 'x')).toThrow(/slot id/);
    expect(() => api.cancel('x')).toThrow(/appointment id/);
    expect(() => partnerClinicApi(client, { kind: 'admin', partnerId: 'x' }).doctors()).toThrow(/partner id/);
    expect(calls).toEqual([]);
  });
});
