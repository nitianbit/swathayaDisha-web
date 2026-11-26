import { describe, expect, it } from 'vitest';
import { createApiClient } from './client.ts';
import { bookableClinics, doctorDashboardApi, followUpLastDay, followUpOpen, freeSlots, ownedClinic } from './doctorDashboard.ts';
import type { DoctorSlot, MyClinics } from './doctorTools.ts';
import { partnerBillingApi, partnerWorkspaceApi } from './index.ts';
import { todayApi, todayLink, todayOf } from './pharmacyToday.ts';

// WQ56 (P2, backend r39 §26.23): the doctor's dashboard routes, the slots a new booking may take, and his own clinic.

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const CLINIC = 'a1'.repeat(12);
const OTHER = 'a2'.repeat(12);
const BR = 'b1'.repeat(12);
const SLOT = 'c1'.repeat(12);
const PARENT = 'd1'.repeat(12);
const KEY = 'k'.repeat(32);
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

describe('WQ56 doctor dashboard (r39)', () => {
  it('lists, looks up, books at a clinic, online and a follow-up, and reads the breakdown under /specialists/me', async () => {
    const { c, calls } = client((x) => (x.url.includes('/appointments/list')
      ? json(200, { success: true, data: [{ _id: PARENT, source: 'self', clinic: null, channel: 'online' }], meta: { total: 1, truncated: true } })
      : json(200, { success: true, data: {} })));
    const d = doctorDashboardApi(c);
    const list = await d.appointments({ from: '2026-11-27', to: '2026-11-27', clinicId: CLINIC });
    expect(list).toEqual({ items: [{ _id: PARENT, source: 'self', clinic: null, channel: 'online' }], truncated: true });
    await d.lookup('9876543210');
    await d.bookClinic({ clinicId: CLINIC, branchId: BR, slotId: SLOT, requestKey: KEY, customer: { phone: '9876543210', name: 'Ravi' } });
    await d.bookConsultation({ slotId: SLOT, mode: 'video', requestKey: KEY, customer: { phone: '9876543210' }, patient: { name: 'Meera', relation: 'Daughter' } });
    await d.bookConsultation({ slotId: SLOT, mode: 'in-person', followUpOf: PARENT, requestKey: KEY });
    await d.finance({ from: '2026-11-01', to: '2026-11-27' });
    expect(calls.map((x) => `${x.method} ${x.url.replace(/^.*\/api\/v1/, '')}`)).toEqual([
      `GET /specialists/me/appointments/list?from=2026-11-27&to=2026-11-27&clinicId=${CLINIC}`,
      'POST /specialists/me/patients/lookup',
      'POST /specialists/me/clinic-appointments',
      'POST /specialists/me/consultations',
      'POST /specialists/me/consultations',
      'GET /specialists/me/finance?from=2026-11-01&to=2026-11-27&breakdown=1',
    ]);
    expect(calls[2]!.body).toEqual({ clinicId: CLINIC, branchId: BR, slotId: SLOT, requestKey: KEY, customer: { phone: '9876543210', name: 'Ravi' } });
    expect(calls[4]!.body).toEqual({ slotId: SLOT, mode: 'in-person', followUpOf: PARENT, requestKey: KEY });
  });

  it('checks ids, keys and dates before any request', async () => {
    const { c, calls } = client();
    const d = doctorDashboardApi(c);
    expect(() => d.bookClinic({ clinicId: 'x', slotId: SLOT, requestKey: KEY, customer: { phone: '9876543210' } })).toThrow();
    expect(() => d.bookConsultation({ slotId: SLOT, mode: 'call', requestKey: 'short', customer: { phone: '9876543210' } })).toThrow();
    await expect(d.appointments({ from: '2026-02-30' })).rejects.toThrow();
    expect(() => d.checkVisitRequest('online', 'short')).toThrow();
    expect(calls).toEqual([]);
  });

  it('checks a restored booking by posting only its kind and request key', async () => {
    const { c, calls } = client(() => json(200, { success: true, data: { appointmentId: PARENT } }));
    await expect(doctorDashboardApi(c).checkVisitRequest('follow-up', KEY)).resolves.toEqual({ appointmentId: PARENT });
    expect(calls).toEqual([{ url: '/api/v1/specialists/me/visit-requests/check', method: 'POST', body: { kind: 'follow-up', requestKey: KEY } }]);
  });

  it('his Today and private to-dos are /specialists/me; a row opens his pages; earnedMinor is kept', async () => {
    const { c, calls } = client(() => json(200, { success: true, data: { items: [], totals: { collectedMinor: 0, byMethod: {}, unpaidMinor: 0, count: 0, earnedMinor: 50000 } } }));
    const day = await todayApi(c, 'doctor').today({ date: '2026-11-27' });
    expect(day.totals.earnedMinor).toBe(50000);
    expect(todayOf({ totals: {} }).totals.earnedMinor).toBeUndefined();
    await todayApi(c, 'doctor').todos();
    expect(calls.map((x) => x.url.replace(/^.*\/api\/v1/, '').split('?')[0])).toEqual(['/specialists/me/today', '/specialists/me/todos']);
    expect(todayLink({ link: { kind: 'invoice', id: PARENT } }, 'doctor')).toBe(`/doctor/clinic/invoices/${PARENT}`);
    expect(todayLink({ link: { kind: 'lab_booking', id: PARENT } }, 'doctor')).toBe(`/doctor/lab-tests/${PARENT}`);
  });

  it('bills his own clinic with the workspace bill routes under /specialists/me/clinic; its name and branches from his clinic read', async () => {
    const { c, calls } = client((x) => (x.url.endsWith('/specialists/me/clinic')
      ? json(200, { success: true, data: { partner: { _id: CLINIC, name: 'Dr Arjun Skin Clinic' }, branches: [{ _id: BR, name: 'Main', isActive: true }, { _id: OTHER, name: 'Old', isActive: false }] } })
      : json(200, { success: true, data: [] })));
    const scope = { kind: 'doctor' } as const;
    expect((await partnerWorkspaceApi(c, scope).me()).name).toBe('Dr Arjun Skin Clinic');
    expect((await partnerWorkspaceApi(c, scope).branches()).map((b) => b._id)).toEqual([BR]);
    await partnerBillingApi(c, scope).catalogue();
    await partnerBillingApi(c, scope).invoices({});
    expect(calls.map((x) => x.url.replace(/^.*\/api\/v1/, '').split('?')[0]).slice(2)).toEqual(['/specialists/me/clinic/catalogue', '/specialists/me/clinic/invoices']);
    const none = client(() => json(200, { success: true, data: null }));
    await expect(partnerWorkspaceApi(none.c, scope).me()).rejects.toMatchObject({ code: 'CLINIC_NOT_FOUND' });
  });
});

describe('WQ56 where a new booking can be', () => {
  const now = new Date('2026-11-27T04:30:00.000Z'); // 10:00 in India
  const slot = (id: string, startTime: string, more: Partial<DoctorSlot> = {}): DoctorSlot =>
    ({ _id: id, date: '20261127', startTime, endTime: '', maxBookings: 1, currentBookings: 0, isAvailable: true, isActive: true, ...more });
  const slots = [
    slot('s5', '15:00', { branchId: BR }), slot('s1', '11:30'), slot('s2', '09:00'), slot('s3', '12:00', { serviceModes: ['chat'] }),
    slot('s4', '11:00', { branchId: BR, currentBookings: 1 }), slot('s6', '16:00', { branchId: OTHER }), slot('s7', '10:30 AM'),
  ];
  it('online: free, later today, no branch, taking the mode; in time order', () => {
    expect(freeSlots(slots, now, { mode: 'video' }).map((s) => s._id)).toEqual(['s7', 's1']);
  });
  it('at a clinic: its branches only, a seat free', () => {
    expect(freeSlots(slots, now, { branchIds: [BR.toUpperCase()] }).map((s) => s._id)).toEqual(['s5']);
  });
  it('his clinics: verified with branches are bookable; he bills only the one verified clinic he owns', () => {
    const mine: MyClinics = { invites: [], clinics: [
      { partnerId: CLINIC, name: 'Own', solo: true, verified: true, role: 'owner', branches: [{ branchId: BR, name: 'Main' }] },
      { partnerId: OTHER, name: 'Demo Care', solo: false, verified: true, role: 'staff', branches: [{ branchId: OTHER, name: 'Baner' }] },
    ] };
    expect(bookableClinics(mine).map((c) => c.partnerId)).toEqual([CLINIC, OTHER]);
    // WQ56b: the clinic /me/clinic answers, when he owns it and it is verified (r39c: a non-solo clinic he owns too).
    const own = { partner: { _id: CLINIC.toUpperCase() } };
    expect(ownedClinic(mine, own)?.partnerId).toBe(CLINIC);
    expect(ownedClinic(mine, null)).toBeNull();
    expect(ownedClinic(mine, undefined)).toBeNull();
    expect(ownedClinic(mine, { partner: { _id: OTHER } })).toBeNull();
    expect(ownedClinic({ ...mine, clinics: [mine.clinics[0]!, { ...mine.clinics[1]!, role: 'owner' }] }, { partner: { _id: OTHER } })?.partnerId).toBe(OTHER);
    expect(ownedClinic({ ...mine, clinics: [{ ...mine.clinics[0]!, verified: false }] }, own)).toBeNull();
  });
  it('a follow-up is offered for a completed, paid consultation that is not one, until its window ends', () => {
    const c = { status: 'completed' as const, paymentStatus: 'paid' as const, bookingDate: '20261120', bookingKind: 'scheduled' as const,
      followUp: { eligibilityExpiresAt: '20261204' } };
    expect(followUpOpen(c, '2026-11-27')).toBe(true);
    expect(followUpLastDay(c)).toBe('2026-12-04');
    expect(followUpOpen(c, '2026-12-05')).toBe(false);
    expect(followUpOpen({ ...c, followUp: undefined }, '2026-11-27')).toBe(false);
    expect(followUpLastDay({ followUp: { eligibilityExpiresAt: '20261131' } })).toBeNull();
    expect(followUpLastDay({ ...c, followUp: { eligibilityExpiresAt: '20261201' } })).toBe('2026-12-01');
    expect(followUpOpen({ ...c, paymentStatus: 'pending' }, '2026-11-27')).toBe(false);
    expect(followUpOpen({ ...c, followUp: { isFollowUp: true } }, '2026-11-27')).toBe(false);
    expect(followUpOpen({ ...c, followUp: { benefitUsed: true } }, '2026-11-27')).toBe(false);
    expect(followUpOpen({ ...c, status: 'confirmed' }, '2026-11-27')).toBe(false);
  });
});
