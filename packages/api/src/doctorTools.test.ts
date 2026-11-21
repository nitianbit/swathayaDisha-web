import { ApiError, createApiClient } from './client.ts';
import {
  appointmentActions, appointmentRefusal, doctorAdminApi, noShowModeRefusal, noShowSlotFits, doctorClinicProblems, doctorNoShowMove, doctorStanding, meetingLinkState, doctorToolsApi, fromYmd, movableSlot, instantRefusal, offerSecondsLeft, payoutDetailsProblems, periodProblem,
  presenceProblems, scheduleProblems, schedulableBranches, scheduleSlotCount, soloPracticeProblems, statementCsvName, toYmd,
  type DoctorAppointment, type SoloPracticeInput,
} from './doctorTools.ts';

const ID = 'a1'.repeat(12);
const BR = 'c1'.repeat(12);

function recorder(answer: () => Response = () => new Response(JSON.stringify({ success: true, data: {} }), { status: 200 })) {
  const calls: { method: string; url: string; body: unknown; headers: Record<string, string> }[] = [];
  const client = createApiClient({ baseUrl: 'https://api.example.test', getToken: () => 'tok',
    fetchImpl: async (u, init) => {
      const raw = init?.body;
      calls.push({ method: String(init?.method), url: String(u).replace('https://api.example.test/api/v1', ''),
        body: typeof raw === 'string' ? JSON.parse(raw) : undefined, headers: (init?.headers ?? {}) as Record<string, string> });
      return answer();
    } });
  return { api: doctorToolsApi(client), calls };
}

const appt = (o: Partial<DoctorAppointment>): DoctorAppointment => ({
  _id: ID, bookingType: 'consultation', bookingDate: '20261117', bookingTime: '10:00', status: 'confirmed', paymentStatus: 'paid', ...o,
});

describe('dates', () => {
  it('turns date inputs into the backend’s YYYYMMDD and back, refusing unreal dates', () => {
    expect(toYmd('2026-11-20')).toBe('20261120');
    expect(() => toYmd('2027-02-31')).toThrow();
    expect(() => toYmd('20261120')).toThrow();
    expect(fromYmd('20261120')).toBe('2026-11-20');
    expect(fromYmd('20270231')).toBeNull();
    expect(fromYmd('2026-11-20')).toBeNull();
  });
});

describe('weekly schedule rules (scheduleTemplateSchema + validateTemplate)', () => {
  const branches = new Set([BR]);
  it('accepts a valid template and counts whole slots', () => {
    const t = { slotMinutes: 20, days: { mon: [{ start: '09:00', end: '10:10', modes: ['video', 'chat'] as const }, { start: '17:00', end: '18:00', modes: ['in-person'] as const, branchId: BR }] } };
    const input = { slotMinutes: t.slotMinutes, days: { mon: t.days.mon.map((w) => ({ ...w, modes: [...w.modes] })) } };
    expect(scheduleProblems(input, branches)).toEqual({});
    expect(scheduleSlotCount(input, 'mon')).toBe(3 + 3);
    expect(scheduleSlotCount(input, 'tue')).toBe(0);
  });

  it('refuses what the server refuses', () => {
    expect(scheduleProblems({ slotMinutes: 4, days: {} }, branches)).toEqual({ slotMinutes: 'Enter whole minutes from 5 to 240.' });
    expect(scheduleProblems({ slotMinutes: 241, days: {} }, branches).slotMinutes).toBeTruthy();
    const p = scheduleProblems({ slotMinutes: 30, days: {
      mon: [{ start: '09:00', end: '09:20', modes: ['video'] }],
      tue: [{ start: '09:00', end: '10:00', modes: [] }],
      wed: [{ start: '09:00', end: '11:00', modes: ['video'] }, { start: '10:30', end: '12:00', modes: ['call'] }],
      thu: [{ start: '09:00', end: '10:00', modes: ['video', 'in-person'], branchId: BR }],
      fri: [{ start: '09:00', end: '10:00', modes: ['in-person'], branchId: 'c2'.repeat(12) }],
      sat: [{ start: '10:00', end: '09:00', modes: ['chat'] }],
      sun: [{ start: '9:00', end: '10:00', modes: ['chat'] }],
    } }, branches);
    expect(p.mon).toMatch(/shorter than one 30-minute slot/);
    expect(p.tue).toMatch(/at least one consultation type/);
    expect(p.wed).toMatch(/overlap/);
    expect(p.thu).toMatch(/in-person consultations only/);
    expect(p.fri).toMatch(/do not consult at/);
    expect(p.sat).toMatch(/end after it starts/);
    expect(p.sun).toMatch(/HH:MM/);
    const many = Array.from({ length: 13 }, (_, i) => ({ start: `${String(i + 8).padStart(2, '0')}:00`, end: `${String(i + 8).padStart(2, '0')}:30`, modes: ['chat' as const] }));
    expect(scheduleProblems({ slotMinutes: 30, days: { mon: many } }, branches).mon).toMatch(/At most 12/);
    // In-person without a clinic branch is allowed (the doctor's own place).
    expect(scheduleProblems({ slotMinutes: 30, days: { mon: [{ start: '09:00', end: '10:00', modes: ['in-person'] }] } }, branches)).toEqual({});
  });

  it('offers only branches of verified clinics', () => {
    expect(schedulableBranches({ invites: [], clinics: [
      { partnerId: ID, name: 'Sunrise', solo: false, verified: true, role: 'staff', branches: [{ branchId: BR, name: 'MG Road' }] },
      { partnerId: 'a2'.repeat(12), name: 'My practice', solo: true, verified: false, role: 'owner', branches: [{ branchId: 'c2'.repeat(12), name: 'Home' }] },
    ] })).toEqual([{ branchId: BR, label: 'Sunrise · MG Road' }]);
  });
});

describe('instant consultations', () => {
  it('checks presence like presenceSchema/setPresence', () => {
    expect(presenceProblems({ available: true, modes: [] })).toEqual({ modes: 'Choose at least one consultation type.' });
    expect(presenceProblems({ available: false, modes: [] })).toEqual({});
    expect(presenceProblems({ available: true, modes: ['video'], instantFeeMinor: 50_000 })).toEqual({});
    expect(presenceProblems({ available: true, modes: ['video'], instantFeeMinor: 100_000_001 }).fee).toBeTruthy();
    expect(presenceProblems({ available: true, modes: ['video'], instantFeeMinor: 10.5 }).fee).toBeTruthy();
    expect(presenceProblems({ available: true, modes: ['video', 'video'] }).modes).toBeTruthy();
  });

  it('counts an offer down and words every refusal; an unknown outcome is not a refusal', () => {
    const now = new Date('2026-11-17T04:30:00.000Z');
    expect(offerSecondsLeft({ offerExpiresAt: '2026-11-17T04:34:00.500Z' }, now)).toBe(241);
    expect(offerSecondsLeft({ offerExpiresAt: '2026-11-17T04:29:00.000Z' }, now)).toBe(0);
    for (const code of ['OFFER_EXPIRED', 'OFFER_NO_LONGER_AVAILABLE', 'DOCTOR_NOT_AVAILABLE', 'SPECIALIZATION_MISMATCH', 'COUPON_NOT_FOR_DOCTOR', 'FEE_ABOVE_QUOTE', 'OFFER_NO_LONGER_AFFORDABLE', 'DOCTOR_BUSY']) {
      expect(instantRefusal(new ApiError(409, 'server words', code))).not.toBe('server words');
    }
    expect(instantRefusal(new ApiError(403, 'x', 'SPECIALIST_NOT_ACTIVE'))).toMatch(/not active/);
    expect(instantRefusal(new ApiError(409, 'Something new', 'NEW_CODE'))).toBe('Something new');
    expect(instantRefusal(new ApiError(0, 'Network', 'NETWORK'))).toBeNull();
    expect(instantRefusal(new ApiError(503, 'Busy'))).toBeNull();
    expect(instantRefusal(new ApiError(429, 'Slow down'))).toBeNull();
    expect(instantRefusal(new Error('x'))).toBeNull();
  });
});

describe('appointment commands offered (updateAppointmentStatus, markNoShow, cancelByDoctor)', () => {
  const before = new Date('2026-11-17T04:00:00.000Z'); // 09:30 IST
  const after = new Date('2026-11-17T05:00:00.000Z'); // 10:30 IST
  it('offers what the server accepts', () => {
    // WQ11c: completed (like a no-show) only once the start time has passed (Q16a 409 NOT_STARTED_YET).
    expect(appointmentActions(appt({}), before)).toEqual(['cancel']);
    expect(appointmentActions(appt({}), after)).toEqual(['complete', 'cancel', 'no_show']);
    expect(appointmentActions(appt({ bookingTime: '10:00 AM' }), after)).toContain('no_show');
    // Q16a: a no-show 15 minutes after the start, not before; an unreadable time still offers completing (the server decides).
    expect(appointmentActions(appt({}), new Date('2026-11-17T04:44:00.000Z'))).toEqual(['complete', 'cancel']);
    expect(appointmentActions(appt({}), new Date('2026-11-17T04:45:00.000Z'))).toContain('no_show');
    expect(appointmentActions(appt({ bookingTime: 'soon' }), before)).toEqual(['complete', 'cancel']);
    expect(appointmentActions(appt({ status: 'pending', paymentStatus: 'pending' }), after)).toEqual(['cancel']);
    expect(appointmentActions(appt({ status: 'pending' }), after)).toEqual(['confirm', 'cancel']);
    expect(appointmentActions(appt({ paymentStatus: 'pending', settlementSystem: 'ledger' }), after)).toEqual(['cancel']);
    expect(appointmentActions(appt({ paymentStatus: 'pending', settlementSystem: 'clinic' }), after)).toEqual(['complete', 'cancel']);
    for (const status of ['completed', 'cancelled', 'no_show'] as const) expect(appointmentActions(appt({ status }), after)).toEqual([]);
    expect(appointmentActions(appt({ status: 'pending', bookingKind: 'instant' }), after)).toEqual([]);
    // Q14: moved after a no-show: never cancelled for a refund (desk rows paid at the clinic still may be).
    expect(appointmentActions(appt({ noShowReschedules: 1 }), after)).toEqual(['complete', 'no_show']);
    expect(appointmentActions(appt({ noShowReschedules: 1, settlementSystem: 'clinic' }), after)).toContain('cancel');
  });
});

describe('Q14 no-shows (rescheduleNoShow: once, never instant, no earning)', () => {
  it('offers the one move on a scheduled no-show, shows it used afterwards, never for instant consultations', () => {
    expect(doctorNoShowMove(appt({ status: 'no_show' }))).toBe('offer');
    expect(doctorNoShowMove(appt({ status: 'no_show', noShowReschedules: 1 }))).toBe('used');
    expect(doctorNoShowMove(appt({ status: 'no_show', noShows: [{ rescheduledAt: '2026-11-16T05:00:00Z' }] }))).toBe('used');
    expect(doctorNoShowMove(appt({ status: 'no_show', bookingKind: 'instant' }))).toBeNull();
    // Q14 review: desk appointments are the clinic's to move.
    expect(doctorNoShowMove(appt({ status: 'no_show', clinicDesk: { partnerId: ID, branchId: BR } }))).toBe('clinic');
    expect(doctorNoShowMove(appt({ status: 'confirmed', noShowReschedules: 1 }))).toBeNull();
  });

  it('a slot to move onto is open, has a free seat and has not started', () => {
    const now = new Date('2026-11-17T04:30:00.000Z'); // 10:00 IST
    const slot = { _id: ID, date: '20261117', startTime: '11:00', endTime: '11:15', maxBookings: 1, currentBookings: 0 };
    expect(movableSlot(slot, now)).toBe(true);
    expect(movableSlot({ ...slot, startTime: '09:45' }, now)).toBe(false);
    expect(movableSlot({ ...slot, currentBookings: 1 }, now)).toBe(false);
    expect(movableSlot({ ...slot, isAvailable: false }, now)).toBe(false);
    expect(movableSlot({ ...slot, closedReason: 'leave' }, now)).toBe(false);
    expect(movableSlot({ ...slot, startTime: '9:30 PM' }, now)).toBe(true);
    // Q16a: a started multi-seat session stays open until it ends; a full one does not.
    const session = { ...slot, startTime: '09:30', endTime: '10:30', maxBookings: 4, currentBookings: 2 };
    expect(movableSlot(session, now)).toBe(true);
    expect(movableSlot({ ...session, endTime: '10:00' }, now)).toBe(false);
    expect(movableSlot({ ...session, currentBookings: 4 }, now)).toBe(false);
    expect(movableSlot({ ...session, endTime: '09:30', duration: 45 }, now)).toBe(true); // no later end: start + duration
    expect(movableSlot({ ...session, maxBookings: 1, currentBookings: 0 }, now)).toBe(false);
  });

  it('moves with a key and the version decided on; admins search verified doctors and move any booking', async () => {
    const { api, calls } = recorder();
    await api.slotsOn('2026-11-18');
    await api.rescheduleNoShow(ID, BR, 'n'.repeat(32), '2026-11-17T04:00:00.000Z');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /specialists/me/slots?date=20261118', `POST /specialists/me/bookings/${ID}/reschedule-no-show`]);
    expect(calls[1]!.body).toEqual({ slotId: BR, requestKey: 'n'.repeat(32), expectedUpdatedAt: '2026-11-17T04:00:00.000Z' });
    expect(() => api.rescheduleNoShow(ID, BR, 'short')).toThrow(/request key/);
    expect(() => api.rescheduleNoShow(ID, 'x', 'n'.repeat(32))).toThrow(/slot id/);
    expect(() => api.myClinicByKey('../x')).toThrow(/request key/);
    const urls: string[] = [];
    const admin = doctorAdminApi(createApiClient({ baseUrl: 'https://api.example.test', getToken: () => 'tok',
      fetchImpl: async (u) => { urls.push(String(u).replace('https://api.example.test/api/v1', ''));
        return new Response(JSON.stringify({ success: true, data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 1 } }), { status: 200 }); } }));
    await admin.search(' Mehta ');
    expect(urls).toEqual(['/specialists?search=Mehta&isVerified=true&isActive=true&page=1&limit=20']);
    expect(() => admin.search('  ')).toThrow(/search/);
  });

  it('checks the own clinic like doctorClinicSchema (practice rules and an optional email)', () => {
    const base = { name: 'Dr Rao Clinic', invoiceSeriesPrefix: 'DRK', branch: { name: 'Main', phone: '9000000001',
      address: { line1: '1 Main Rd', city: 'Bengaluru', state: 'Karnataka', stateCode: '29', pincode: '560001' } } };
    expect(doctorClinicProblems(base)).toEqual({});
    expect(doctorClinicProblems({ ...base, contactEmail: 'rao@clinic.in' })).toEqual({});
    expect(doctorClinicProblems({ ...base, contactEmail: 'rao@' }).contactEmail).toMatch(/valid email/);
  });
});

describe('call links (isInternalMeetApplicable + syncBookingMeet)', () => {
  it('expects a link only for paid, confirmed call and video consultations, and tells preparing from failed', () => {
    expect(meetingLinkState(appt({ consultationMode: 'video' }))).toBe('preparing');
    expect(meetingLinkState(appt({ consultationMode: 'call', virtualMeeting: { status: 'active', joinUrl: 'https://meet.google.com/x' } }))).toBe('ready');
    expect(meetingLinkState(appt({ consultationMode: 'video', virtualMeeting: { status: 'failed', error: 'no email' } }))).toBe('failed');
    expect(meetingLinkState(appt({ consultationMode: 'video', virtualMeeting: { status: 'failed', joinUrl: 'https://meet.google.com/x' } }))).toBe('ready');
    expect(meetingLinkState(appt({ consultationMode: 'chat' }))).toBe('none');
    expect(meetingLinkState(appt({ consultationMode: 'in-person' }))).toBe('none');
    expect(meetingLinkState(appt({ consultationMode: 'video', status: 'completed' }))).toBe('none');
    expect(meetingLinkState(appt({ consultationMode: 'video', paymentStatus: 'pending' }))).toBe('none');
  });
});

describe('clinics, practice and payout details', () => {
  const practice = (o: Partial<SoloPracticeInput> = {}): SoloPracticeInput => ({
    name: 'Dr Rao Clinic', invoiceSeriesPrefix: 'drk', branch: { name: 'Main', phone: '9000000001',
      address: { line1: '1 Main Rd', city: 'Bengaluru', state: 'Karnataka', stateCode: '29', pincode: '560001' } }, ...o,
  });
  it('checks a solo practice like soloPracticeSchema', () => {
    expect(soloPracticeProblems(practice())).toEqual({});
    expect(soloPracticeProblems(practice({ name: 'A', invoiceSeriesPrefix: 'TOOLONG', gstin: 'nope', pan: '123' }))).toEqual({
      name: expect.any(String), invoiceSeriesPrefix: expect.any(String), gstin: expect.any(String), pan: expect.any(String),
    });
    expect(soloPracticeProblems(practice({ branch: { name: 'M', phone: '12', address: { line1: '', city: '', state: '', stateCode: '', pincode: '' } } })))
      .toEqual({ branchName: expect.any(String), branchPhone: expect.any(String), line1: 'Required.', city: 'Required.', state: 'Required.', stateCode: 'Required.', pincode: 'Required.' });
  });

  it('checks payout details like normalizeDetails', () => {
    expect(payoutDetailsProblems({ method: 'bank', accountName: 'Dr Rao', accountNumber: '1234 5678 9012', ifsc: 'hdfc0001234' })).toEqual({});
    expect(payoutDetailsProblems({ method: 'bank', accountNumber: '12', ifsc: 'HDFC1001234' })).toEqual({
      accountName: expect.any(String), accountNumber: expect.any(String), ifsc: expect.any(String),
    });
    expect(payoutDetailsProblems({ method: 'upi', upiId: 'dr.rao@okhdfc' })).toEqual({});
    expect(payoutDetailsProblems({ method: 'upi', upiId: 'dr rao' })).toEqual({ upiId: expect.any(String) });
  });

  it('checks a statement period and names the CSV like the server', () => {
    expect(periodProblem('2026-11-01', '2026-11-30')).toBeNull();
    expect(periodProblem('2026-11-30', '2026-11-01')).toMatch(/after/);
    expect(periodProblem('2026-02-30')).toBeTruthy();
    expect(statementCsvName()).toBe('doctor-statement.csv');
    expect(statementCsvName('2026-11-01', '2026-11-30')).toBe('doctor-statement-2026-11-01-to-2026-11-30.csv');
  });

  it('reads standing from the profile', () => {
    expect(doctorStanding({ isActive: true, isVerified: true })).toBe('active');
    expect(doctorStanding({ isActive: true, isVerified: false })).toBe('unverified');
    expect(doctorStanding({ isActive: true })).toBe('unverified'); // a missing flag is not eligible (isEligibleDoctor)
    expect(doctorStanding({ isVerified: true })).toBe('inactive');
    expect(doctorStanding({ isActive: false, isVerified: true })).toBe('inactive');
  });
});

describe('paths and bodies', () => {
  it('builds every route under /specialists/me with checked ids and dates', async () => {
    const { api, calls } = recorder();
    await api.schedule();
    await api.saveSchedule({ slotMinutes: 15, days: { mon: [{ start: '09:00', end: '10:00', modes: ['in-person'], branchId: BR }] } }, null);
    await api.addLeave('2026-11-20');
    await api.removeLeave('2026-11-20');
    await api.presence();
    await api.setPresence({ available: true, modes: ['video', 'chat'], instantFeeMinor: 50_000, expectedPresenceVersion: 4 });
    await api.heartbeat();
    await api.offers();
    await api.accept(ID);
    await api.extend(ID, 15, 'extend-key-1');
    await api.instantBooking(ID);
    await api.appointmentsOn('2026-11-17');
    await api.appointmentsIn('2026-11');
    await api.setAppointmentStatus(ID, 'cancelled', '  Unwell  ');
    await api.setAppointmentStatus(ID, 'completed');
    await api.clinics();
    await api.acceptInvite(ID);
    await api.declineInvite(ID);
    await api.leaveClinic(ID);
    await api.practice();
    await api.finance();
    await api.statement({ before: `1763353800000_${ID}`, limit: 50, from: '2026-11-01' });
    await api.payouts();
    await api.history();
    await api.events(`1763353800000_${ID}`);
    await api.setPayoutDetails({ method: 'upi', upiId: ' Dr.Rao@OKHDFC ', accountName: '' }, 2);
    await api.saveSchedule({ slotMinutes: 15, days: {} }, '2026-11-10T04:30:00.000Z');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /specialists/me/schedule',
      'PUT /specialists/me/schedule',
      'POST /specialists/me/leave',
      'DELETE /specialists/me/leave/20261120',
      'GET /specialists/me/presence',
      'PUT /specialists/me/presence',
      'POST /specialists/me/presence/heartbeat',
      'GET /specialists/me/instant/offers',
      `POST /specialists/me/instant/${ID}/accept`,
      `POST /specialists/me/instant/bookings/${ID}/extend`,
      `GET /specialists/me/instant/bookings/${ID}`,
      'GET /specialists/me/appointments?view=day&date=20261117',
      'GET /specialists/me/appointments?view=month&yearMonth=202611',
      `PATCH /specialists/me/appointments/${ID}/status`,
      `PATCH /specialists/me/appointments/${ID}/status`,
      'GET /specialists/me/clinics',
      `POST /specialists/me/clinic-invites/${ID}/accept`,
      `POST /specialists/me/clinic-invites/${ID}/decline`,
      `POST /specialists/me/clinics/${ID}/leave`,
      'GET /specialists/me/practice',
      'GET /specialists/me/finance',
      `GET /specialists/me/finance/statement?before=1763353800000_${ID}&limit=50&from=2026-11-01`,
      'GET /specialists/me/finance/payouts?limit=50',
      'GET /specialists/me/finance/history',
      `GET /specialists/me/finance/events?cursor=1763353800000_${ID}&limit=50`,
      'PUT /specialists/me/finance/payout-details',
      'PUT /specialists/me/schedule',
    ]);
    expect(calls[1]!.body).toEqual({ slotMinutes: 15, days: { mon: [{ start: '09:00', end: '10:00', modes: ['in-person'], branchId: BR }], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] }, expectedUpdatedAt: null });
    expect(calls[2]!.body).toEqual({ date: '20261120' });
    expect(calls[5]!.body).toEqual({ available: true, modes: ['video', 'chat'], instantFeeMinor: 50_000, expectedPresenceVersion: 4 });
    expect(calls[9]!.body).toEqual({ minutes: 15, requestKey: 'extend-key-1' });
    expect(calls[13]!.body).toEqual({ status: 'cancelled', reason: 'Unwell' });
    expect(calls[14]!.body).toEqual({ status: 'completed' });
    expect(calls[25]!.body).toEqual({ method: 'upi', upiId: 'dr.rao@okhdfc', expectedDetailsVersion: 2 });
    expect((calls[26]!.body as { expectedUpdatedAt: string }).expectedUpdatedAt).toBe('2026-11-10T04:30:00.000Z');
    expect(calls.every((c) => c.headers.Authorization === 'Bearer tok')).toBe(true);
  });

  it('sends a practice and bank details normalised', async () => {
    const { api, calls } = recorder();
    await api.createMyClinic({ name: ' Dr Rao Clinic ', invoiceSeriesPrefix: 'drk', gstin: '', pan: 'abcde1234f', legalName: '  ', contactEmail: ' ',
      branch: { name: 'Main', phone: '9000000001', address: { line1: '1 Main Rd', line2: '', city: 'Bengaluru', state: 'Karnataka', stateCode: '29', pincode: '560001' } } }, 'c'.repeat(32));
    await api.setPayoutDetails({ method: 'bank', accountName: ' Dr Rao ', accountNumber: '1234 5678 9012', ifsc: 'hdfc0001234', bankName: ' ', upiId: 'x@y' }, 0);
    // Q14: the doctor's own clinic is keyed (POST /me/clinic); an empty email is left out.
    expect(calls[0]!.url).toBe('/specialists/me/clinic');
    expect(calls[0]!.body).toEqual({ name: 'Dr Rao Clinic', invoiceSeriesPrefix: 'DRK', pan: 'ABCDE1234F', requestKey: 'c'.repeat(32),
      branch: { name: 'Main', phone: '9000000001', address: { line1: '1 Main Rd', city: 'Bengaluru', state: 'Karnataka', stateCode: '29', pincode: '560001' } } });
    expect(calls[1]!.body).toEqual({ method: 'bank', accountName: 'Dr Rao', accountNumber: '123456789012', ifsc: 'HDFC0001234', expectedDetailsVersion: 0 });
  });

  it('refuses bad ids, dates, cursors and values before any request', async () => {
    const { api, calls } = recorder();
    expect(() => api.accept('../x')).toThrow();
    expect(() => api.extend(ID, 0, 'extend-key-1')).toThrow();
    expect(() => api.extend(ID, 61, 'extend-key-1')).toThrow();
    expect(() => api.extend('nope', 10, 'extend-key-1')).toThrow();
    expect(() => api.extend(ID, 10, 'short')).toThrow();
    expect(() => api.instantBooking('x')).toThrow();
    expect(() => api.payouts('abc')).toThrow();
    expect(() => api.events('1_2')).toThrow();
    expect(() => api.saveSchedule({ slotMinutes: 30, days: {} }, 'yesterday')).toThrow();
    expect(() => api.setPresence({ available: false, modes: [], expectedPresenceVersion: -1 })).toThrow();
    expect(() => api.setPayoutDetails({ method: 'upi', upiId: 'a@okhdfc' }, 1.5)).toThrow();
    expect(() => api.addLeave('2026-02-30')).toThrow();
    expect(() => api.removeLeave('20261120')).toThrow();
    expect(() => api.appointmentsOn('2026-13-01')).toThrow();
    expect(() => api.appointmentsIn('2026-13')).toThrow();
    expect(() => api.setAppointmentStatus('x', 'completed')).toThrow();
    expect(() => api.acceptInvite('x/../y')).toThrow();
    expect(() => api.leaveClinic('')).toThrow();
    expect(() => api.statement({ before: 'abc' })).toThrow();
    expect(() => api.statement({ limit: 500 })).toThrow();
    expect(() => api.statementCsv({ from: '2026-11-30', to: '2026-11-01' })).toThrow();
    expect(() => api.setPresence({ available: true, modes: [], expectedPresenceVersion: 1 })).toThrow();
    expect(() => api.setPayoutDetails({ method: 'upi', upiId: 'bad' }, 1)).toThrow();
    expect(() => api.saveSchedule({ slotMinutes: 30, days: { mon: [{ start: '09:00', end: '10:00', modes: ['in-person'], branchId: 'bad' }] } }, null)).toThrow();
    expect(calls).toEqual([]);
  });

  it('reads the CSV into a blob with the token in the header only', async () => {
    const { api, calls } = recorder(() => new Response('"Date (IST)"\n', { status: 200, headers: { 'Content-Type': 'text/csv' } }));
    const blob = await api.statementCsv({ from: '2026-11-01', to: '2026-11-30' });
    expect(await blob.text()).toContain('Date (IST)');
    expect(calls[0]!.url).toBe('/specialists/me/finance/statement.csv?from=2026-11-01&to=2026-11-30');
    expect(calls[0]!.url).not.toMatch(/tok/);
    expect(calls[0]!.headers.Authorization).toBe('Bearer tok');
  });
});

describe('WQ11c: completing, and the no-show slot picker', () => {
  it('names the refusal of a completion before the start time (NOT_STARTED_YET); other codes fall back', () => {
    expect(appointmentRefusal(new ApiError(409, 'x', 'NOT_STARTED_YET'))).toMatch(/not started yet/);
    expect(appointmentRefusal(new ApiError(409, 'x', 'SOMETHING_ELSE'))).toBeNull();
    expect(appointmentRefusal(new Error('x'))).toBeNull();
  });

  it('a no-show moves only to a slot that takes its consultation type, at its place', () => {
    const video = appt({ consultationMode: 'video' });
    const ownPlace = appt({ consultationMode: 'in-person' });
    const atClinic = appt({ consultationMode: 'in-person', clinicVisit: { partnerId: ID, branchId: BR } });
    expect(noShowSlotFits({ serviceModes: ['video', 'call'] }, video)).toBe(true);
    expect(noShowSlotFits({}, video)).toBe(true); // no types: any type
    expect(noShowSlotFits({ serviceModes: ['chat'] }, video)).toBe(false);
    expect(noShowSlotFits({ serviceModes: ['in-person'] }, video)).toBe(false);
    expect(noShowSlotFits({ serviceModes: ['video'], branchId: BR }, video)).toBe(false); // online moves stay off clinics
    expect(noShowSlotFits({ serviceModes: ['in-person'] }, ownPlace)).toBe(true);
    expect(noShowSlotFits({ serviceModes: ['in-person'], branchId: BR }, ownPlace)).toBe(false); // another place
    expect(noShowSlotFits({ serviceModes: ['in-person'], branchId: BR.toUpperCase() }, atClinic)).toBe(true);
    expect(noShowSlotFits({ serviceModes: ['in-person'] }, atClinic)).toBe(false);
    expect(noShowSlotFits({ serviceModes: ['in-person'], branchId: 'd1'.repeat(12) }, atClinic)).toBe(false);
  });

  it('names a refusal for the consultation type (assertSlotMode) so it is not read as "no longer free"', async () => {
    const typed = noShowModeRefusal(new ApiError(409, 'This slot is not offered for that consultation type', 'SLOT_NOT_AVAILABLE'));
    expect(typed).toBeInstanceOf(ApiError);
    expect((typed as ApiError).code).toBe('SLOT_MODE_NOT_OFFERED');
    const taken = new ApiError(409, 'Slot is not available', 'SLOT_NOT_AVAILABLE');
    expect(noShowModeRefusal(taken)).toBe(taken);
    const { api } = recorder(() => new Response(JSON.stringify({ error: 409, code: 'SLOT_NOT_AVAILABLE', message: 'This slot is not offered for that consultation type' }), { status: 409 }));
    await expect(api.rescheduleNoShow(ID, BR, 'k'.repeat(32))).rejects.toMatchObject({ code: 'SLOT_MODE_NOT_OFFERED' });
  });
});
