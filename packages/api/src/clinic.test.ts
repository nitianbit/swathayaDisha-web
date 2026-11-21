import { createApiClient } from './client.ts';
import {
  appointmentAt, appointmentDay, appointmentRangeProblem, canonicalMobile, clinicBranchesFor, deskActions, deskBookingProblems, doctorsAtBranch,
  familyMemberProblems, linkProblems, partnerClinicApi, type ClinicAppointment,
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

describe('Q14 doctor links (linkDoctorSchema, clinicBranch) and family members at the desk (deskPatientSchema)', () => {
  it('needs a chosen doctor and branches of this clinic, at most 50', () => {
    const offered = [{ _id: B1 }, { _id: B2 }];
    expect(linkProblems({ doctorId: D, branchIds: [] }, offered)).toEqual({});
    expect(linkProblems({ doctorId: D, branchIds: [B1, B2] }, offered)).toEqual({});
    expect(linkProblems({ doctorId: '', branchIds: [] }, offered).doctorId).toMatch(/Choose the doctor/);
    expect(linkProblems({ doctorId: D, branchIds: ['c9'.repeat(12)] }, offered).branchIds).toMatch(/branches of this clinic/);
    expect(linkProblems({ doctorId: D, branchIds: Array.from({ length: 51 }, () => B1) }, offered).branchIds).toMatch(/at most 50/);
  });

  it('a new family member needs a name and a known relation; gender and a past real birth date are optional', () => {
    const ok = { name: 'Meena', relation: 'Mother', gender: '', dateOfBirth: '' };
    expect(familyMemberProblems(ok, new Date('2026-11-17T12:00:00Z'))).toEqual({});
    expect(familyMemberProblems({ ...ok, gender: 'Female', dateOfBirth: '1960-02-29' }, new Date('2026-11-17T12:00:00Z'))).toEqual({});
    expect(familyMemberProblems({ ...ok, name: '  ' }, new Date('2026-11-17T12:00:00Z')).name).toMatch(/name/);
    expect(familyMemberProblems({ ...ok, relation: 'Me' }, new Date('2026-11-17T12:00:00Z')).relation).toMatch(/related/);
    expect(familyMemberProblems({ ...ok, gender: 'female' }, new Date('2026-11-17T12:00:00Z')).gender).toMatch(/gender/);
    expect(familyMemberProblems({ ...ok, dateOfBirth: '1961-02-29' }, new Date('2026-11-17T12:00:00Z')).dateOfBirth).toMatch(/real date/);
    expect(familyMemberProblems({ ...ok, dateOfBirth: '2026-11-18' }, new Date('2026-11-17T12:00:00Z')).dateOfBirth).toMatch(/not in the future/);
    // As the server reads it: 02:00 IST on 18 Nov is still 17 Nov in UTC, so "today" (18 Nov) is refused; at 06:00 IST it is not.
    expect(familyMemberProblems({ ...ok, dateOfBirth: '2026-11-18' }, new Date('2026-11-17T20:30:00Z')).dateOfBirth).toMatch(/not in the future/);
    expect(familyMemberProblems({ ...ok, dateOfBirth: '2026-11-18' }, new Date('2026-11-18T00:30:00Z'))).toEqual({});
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
  const late = new Date('2026-11-17T05:15:00Z'); // 10:45 IST
  const acts = (a: ClinicAppointment, now: Date, actor = owner) => deskActions(a, actor, now).map((o) => (o.blocked ? `${o.action}!` : o.action));

  it('offers check-in, seen, no-show after the time, move and cancel on a booked desk appointment', () => {
    // WQ11b: "seen" only once the appointment has started (Q16a 409 NOT_STARTED_YET), like the no-show.
    expect(acts(appt(), before)).toEqual(['arrived', 'complete!', 'no_show!', 'reschedule', 'cancel']);
    // Q16a: a no-show only 15 minutes after the time (10:30 → from 10:45).
    expect(acts(appt(), after)).toEqual(['arrived', 'complete', 'no_show!', 'reschedule', 'cancel']);
    expect(acts(appt(), late)).toEqual(['arrived', 'complete', 'no_show', 'reschedule', 'cancel']);
    expect(acts(appt({ arrivedAt: '2026-11-17T04:50:00Z' }), late)).toEqual(['complete', 'no_show', 'reschedule', 'cancel']);
    expect(acts(appt({ bookingTime: 'unreadable' }), after)).toEqual(['arrived', 'complete!', 'no_show!', 'reschedule', 'cancel']);
  });

  it('offers nothing on finished, online or view-only appointments', () => {
    for (const status of ['completed', 'cancelled'] as const) expect(acts(appt({ status }), after)).toEqual([]);
    expect(acts(appt({ status: 'pending' }), after)).toEqual(['reschedule', 'cancel']);
    expect(acts(appt({ source: 'online' }), after)).toEqual([]);
    expect(deskActions(appt(), viewer, after)).toEqual([]);
    expect(deskActions(appt(), ADMIN_ACTOR, after).length).toBe(5);
  });

  it('Q14: a desk no-show may be moved (the server decides whether its one move is used); online ones are the doctor’s', () => {
    expect(acts(appt({ status: 'no_show' }), after)).toEqual(['reschedule_no_show']);
    expect(acts(appt({ status: 'no_show', source: 'online' }), after)).toEqual([]);
    expect(deskActions(appt({ status: 'no_show' }), viewer, after)).toEqual([]);
  });
});

describe('partnerClinicApi paths (member and admin-as-owner)', () => {
  it('builds member paths and bodies', async () => {
    const { client, calls } = recorder();
    const api = partnerClinicApi(client, { kind: 'member' });
    await api.doctors();
    await api.invites('pending');
    await api.linkDoctor({ doctorId: D.toUpperCase(), branchIds: [B1], requestKey: 'l'.repeat(32) });
    await api.unlinkDoctor(D);
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
      'POST /partner-workspace/clinic/doctors',
      `DELETE /partner-workspace/clinic/doctors/${D}`,
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
    expect(calls[2]!.body).toEqual({ doctorId: D, branchIds: [B1], requestKey: 'l'.repeat(32) });
    expect(calls[3]!.body).toBeUndefined();
    // The request key is in the body (the route reads no header); the mobile goes out in its ten-digit form.
    expect(calls[7]!.body).toEqual({ slotId: S, customer: { phone: '9800000001', name: 'Asha' }, notes: 'Walk-in', requestKey: 'k'.repeat(32) });
    expect(calls[7]!.headers['Idempotency-Key']).toBeUndefined();
    expect(calls[11]!.body).toEqual({});
    expect(calls[12]!.body).toEqual({ reason: 'Doctor away' });
    expect(calls[13]!.body).toEqual({ slotId: S });
  });

  it('Q13: desk steps name the version they were decided on; a lost booking is looked up or given up by its key', async () => {
    const { client, calls } = recorder();
    const api = partnerClinicApi(client, { kind: 'member' });
    const v = '2026-11-17T04:00:00.000Z';
    await api.arrived(K, v);
    await api.complete(K, v);
    await api.noShow(K, v);
    await api.cancel(K, ' Doctor away ', v);
    await api.cancel(K, '', v);
    await api.reschedule(K, S, v);
    await api.appointmentByKey('k'.repeat(32));
    await api.abandonBookingKey('k'.repeat(32));
    await api.rescheduleNoShow(K, S, 'n'.repeat(32), v);
    expect(calls.map((c) => c.body)).toEqual([
      { expectedUpdatedAt: v }, { expectedUpdatedAt: v }, { expectedUpdatedAt: v }, { reason: 'Doctor away', expectedUpdatedAt: v },
      { expectedUpdatedAt: v }, { slotId: S, expectedUpdatedAt: v }, undefined, {}, { slotId: S, requestKey: 'n'.repeat(32), expectedUpdatedAt: v },
    ]);
    expect(calls.slice(6).map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET /partner-workspace/clinic/appointments/by-key/${'k'.repeat(32)}`,
      `POST /partner-workspace/clinic/appointments/by-key/${'k'.repeat(32)}/abandon`,
      `POST /partner-workspace/clinic/appointments/${K}/reschedule-no-show`,
    ]);
    expect(() => api.arrived(K, 'yesterday')).toThrow(/appointment version/);
    expect(() => api.appointmentByKey('../x')).toThrow(/request key/);
    expect(() => api.abandonBookingKey('short')).toThrow(/request key/);
    expect(() => api.rescheduleNoShow(K, S, 'short', v)).toThrow(/request key/);
    expect(calls).toHaveLength(9);
  });

  it('Q14: desk bookings name who is seen (an existing family member by id, or a new one by name and relation)', async () => {
    const { client, calls } = recorder();
    const api = partnerClinicApi(client, { kind: 'member' });
    await api.book({ slotId: S, customer: { phone: '9800000001' }, patient: { dependentId: I }, requestKey: 'k'.repeat(32) });
    await api.book({ slotId: S, customer: { phone: '9800000001' }, patient: { name: 'Meena', relation: 'Mother', gender: 'Female' }, requestKey: 'j'.repeat(32) });
    expect(calls[0]!.body).toMatchObject({ patient: { dependentId: I } });
    expect(calls[1]!.body).toMatchObject({ patient: { name: 'Meena', relation: 'Mother', gender: 'Female' } });
    expect(() => api.book({ slotId: S, customer: { phone: '9800000001' }, patient: { dependentId: '../x' }, requestKey: 'k'.repeat(32) })).toThrow(/family member id/);
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
    expect(() => api.linkDoctor({ doctorId: 'x', branchIds: [], requestKey: 'l'.repeat(32) })).toThrow(/doctor id/);
    expect(() => api.linkDoctor({ doctorId: D, branchIds: ['nope'], requestKey: 'l'.repeat(32) })).toThrow(/branch id/);
    expect(() => api.linkDoctor({ doctorId: D, branchIds: [], requestKey: 'short' })).toThrow(/request key/);
    expect(() => api.unlinkDoctor('../x')).toThrow(/doctor id/);
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
