import { createApiClient } from './client.ts';
import {
  addDays, capacityProblem, eligibleSigners, isBookable, isLabBookingChanged, isRealDate, isReportTooLarge, istDateOf, isTemplateChanged, isUploadFailed,
  labActions, labBookingsAdminApi, labNoShowMove, manualSlotProblems, mondayOf, partnerLabsApi, reopenable, reportFileBooking, reportFileName,
  reportFileProblem, slotTimesFor, templateInput, templateProblems, weekdayOf, type LabBooking, type LabSlot,
} from './partnerLabs.ts';
import { ApiError } from './client.ts';
import { ADMIN_ACTOR, type PartnerMember } from './partners.ts';

const P = 'a1'.repeat(12);
const B = 'c1'.repeat(12);
const S = 'e5'.repeat(12);
const K = 'f6'.repeat(12);
const M = 'b2'.repeat(12);

function recorder(answer: () => Response = () => new Response(JSON.stringify({ success: true, data: {} }), { status: 200 })) {
  const calls: { method: string; url: string; body: unknown; raw: unknown; headers: Record<string, string> }[] = [];
  const client = createApiClient({ baseUrl: 'https://api.example.test', getToken: () => 'tok',
    fetchImpl: async (u, init) => {
      const raw = init?.body;
      calls.push({ method: String(init?.method), url: String(u).replace('https://api.example.test/api/v1', ''), raw,
        body: typeof raw === 'string' ? JSON.parse(raw) : undefined, headers: (init?.headers ?? {}) as Record<string, string> });
      return answer();
    } });
  return { client, calls };
}

const slot = (o: Partial<LabSlot>): LabSlot => ({
  _id: S, partnerId: P, branchId: B, visitMode: 'lab', date: '2026-11-16', startTime: '09:00', endTime: '09:30',
  startsAt: '2026-11-16T03:30:00.000Z', endsAt: '2026-11-16T04:00:00.000Z', capacity: 2, booked: 0, closed: null, source: 'template', ...o,
});

describe('calendar dates in India time (services/slots.ts)', () => {
  it('reads real dates, IST days, weekdays and the Monday of a week', () => {
    expect(isRealDate('2026-11-16')).toBe(true);
    for (const bad of ['2027-02-31', '2026-13-01', '16-11-2026', '', undefined]) expect(isRealDate(bad)).toBe(false);
    expect(istDateOf(new Date('2026-11-15T18:29:59Z'))).toBe('2026-11-15');
    expect(istDateOf(new Date('2026-11-15T18:30:00Z'))).toBe('2026-11-16'); // midnight in India
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(weekdayOf('2026-11-16')).toBe('mon');
    expect(weekdayOf('2026-11-22')).toBe('sun');
    expect(mondayOf('2026-11-22')).toBe('2026-11-16');
    expect(mondayOf('2026-11-16')).toBe('2026-11-16');
  });
});

describe('weekly template rules (slotTemplateSchema, validateWindows, slotTimesFor)', () => {
  it('gives whole slots only, per window', () => {
    const t = { slotMinutes: 30, days: { mon: [{ start: '09:00', end: '10:15' }, { start: '14:00', end: '14:30' }] } };
    expect(slotTimesFor(t, 'mon')).toEqual([
      { start: '09:00', end: '09:30' }, { start: '09:30', end: '10:00' }, { start: '14:00', end: '14:30' },
    ]);
    expect(slotTimesFor(t, 'tue')).toEqual([]);
  });

  it('refuses what the server refuses', () => {
    expect(templateProblems({ slotMinutes: 30, capacity: 2, days: { mon: [{ start: '09:00', end: '12:00' }] } })).toEqual({});
    expect(templateProblems({ slotMinutes: 4, capacity: 0, days: {} })).toEqual({
      slotMinutes: 'Enter whole minutes from 5 to 480.', capacity: 'Enter a number of seats from 1 to 500.',
    });
    expect(templateProblems({ slotMinutes: 481, capacity: 501, days: {} })).toMatchObject({ slotMinutes: expect.any(String), capacity: expect.any(String) });
    const p = templateProblems({ slotMinutes: 30, capacity: 1, days: {
      mon: [{ start: '10:00', end: '10:00' }],
      tue: [{ start: '09:00', end: '11:00' }, { start: '10:30', end: '12:00' }],
      wed: [{ start: '9:00', end: '10:00' }],
      thu: Array.from({ length: 13 }, (_, i) => ({ start: `${String(i + 8).padStart(2, '0')}:00`, end: `${String(i + 8).padStart(2, '0')}:30` })),
      fri: [{ start: '12:00', end: '13:00' }, { start: '09:00', end: '12:00' }], // touching windows in any order are fine
    } });
    expect(p).toEqual({
      mon: 'A window must end after it starts.', tue: 'These windows overlap.', wed: 'Enter each time as HH:MM.',
      thu: 'At most 12 time windows a day.',
    });
  });

  it('edits the SAVED template as it is (WQ11b: no guessing from the generated slots)', () => {
    const saved = { _id: 't', partnerId: P, branchId: B, visitMode: 'lab' as const, isActive: true, updatedAt: '2026-11-20T05:00:00.000Z',
      slotMinutes: 30, capacity: 2, days: { wed: [{ start: '09:00', end: '10:00' }], thu: [] } };
    expect(templateInput(saved)).toEqual({ slotMinutes: 30, capacity: 2, days: { wed: [{ start: '09:00', end: '10:00' }] } });
    expect(isTemplateChanged(new ApiError(409, 'changed', 'TEMPLATE_CHANGED'))).toBe(true);
    expect(isTemplateChanged(new ApiError(409, 'x', 'RECORD_CHANGED'))).toBe(false);
  });
});

describe('slot rules (manualSlotSchema, setSlotCapacity, setSlotClosed)', () => {
  it('checks manual slots and capacity changes as the server does', () => {
    expect(manualSlotProblems({ date: '2026-11-20', startTime: '09:00', endTime: '09:30', capacity: 3 })).toEqual({});
    expect(manualSlotProblems({ date: '2026-02-30', startTime: '', endTime: '09:00', capacity: 0 })).toEqual({
      date: 'Enter a real date.', startTime: 'Enter the start time.', capacity: 'Enter a number of seats from 1 to 500.',
    });
    expect(manualSlotProblems({ date: '2026-11-20', startTime: '10:00', endTime: '09:30', capacity: 1 }).endTime).toBe('A slot must end after it starts.');
    expect(capacityProblem({ booked: 0 }, 0)).toBeNull(); // capacity 0 is allowed when nothing is booked
    expect(capacityProblem({ booked: 3 }, 2)).toBe('3 seats are already booked: the capacity cannot be lower.');
    expect(capacityProblem({ booked: 1 }, 0)).toBe('1 seat is already booked: the capacity cannot be lower.');
    expect(capacityProblem({ booked: 0 }, 501)).toBe('Enter a number from 0 to 500.');
    expect(capacityProblem({ booked: 0 }, 1.5)).toBe('Enter a number from 0 to 500.');
  });

  it('offers reopening only for staff closures; bookable means open, a seat left and still ahead', () => {
    expect(reopenable({ closed: 'manual' })).toBe(true);
    for (const c of [null, 'holiday', 'template'] as const) expect(reopenable({ closed: c })).toBe(false);
    const now = new Date('2026-11-16T03:00:00Z');
    expect(isBookable(slot({}), now)).toBe(true);
    expect(isBookable(slot({ booked: 2 }), now)).toBe(false);
    expect(isBookable(slot({ closed: 'holiday' }), now)).toBe(false);
    expect(isBookable(slot({}), new Date('2026-11-16T03:30:00Z'))).toBe(false);
  });
});

describe('lab booking transitions (services/labBookings.ts §4)', () => {
  const booking = (o: Partial<LabBooking>): LabBooking => ({
    _id: K, partnerId: P, branchId: B, userId: 'u'.repeat(24), patient: { kind: 'self', name: 'Asha' }, visitMode: 'home',
    slot: { slotId: S, date: '2026-11-16', startTime: '09:00', endTime: '09:30', startsAt: '2026-11-16T03:30:00.000Z' },
    items: [], pricing: { subtotalMinor: 0, discountMinor: 0, payableMinor: 0, commissionMinor: 0, currency: 'INR' },
    status: 'confirmed', statusVersion: 1, paymentStatus: 'paid', paymentDeadline: '2026-11-15T00:00:00.000Z',
    reschedule: { version: 0, pending: false }, report: { draftFiles: [], releasedFiles: [], releases: [] }, lifecycle: {}, ...o,
  });
  const before = new Date('2026-11-16T03:00:00Z');
  const after = new Date('2026-11-16T04:00:00Z');
  const staff = (...permissions: string[]) => ({ role: 'staff' as const, permissions: permissions as never[] });
  const names = (o: ReturnType<typeof labActions>) => o.map((x) => (x.blocked ? `${x.action}!` : x.action));

  it('offers each command only in the states, visit modes and permissions the server accepts', () => {
    expect(names(labActions(booking({}), ADMIN_ACTOR, after))).toEqual(['assign', 'collect', 'no_show', 'reschedule', 'reject']);
    expect(names(labActions(booking({ visitMode: 'lab' }), ADMIN_ACTOR, after))).toEqual(['visit', 'no_show', 'reschedule', 'reject']);
    expect(names(labActions(booking({}), ADMIN_ACTOR, before))).toEqual(['assign', 'collect', 'no_show!', 'reschedule', 'reject']);
    // A new time waiting for the customer blocks collected/visited/no-show, not another proposal or a rejection.
    expect(names(labActions(booking({ reschedule: { version: 1, pending: true } }), ADMIN_ACTOR, after)))
      .toEqual(['assign', 'collect!', 'no_show!', 'reschedule', 'reject']);
    expect(names(labActions(booking({ status: 'sample_collected' }), ADMIN_ACTOR, after))).toEqual(['process']);
    expect(names(labActions(booking({ status: 'processing' }), ADMIN_ACTOR, after))).toEqual(['upload', 'release!']);
    expect(names(labActions(booking({ status: 'report_ready', report: { draftFiles: ['/api/static/x/y'], releasedFiles: [], releases: [] } }), ADMIN_ACTOR, after)))
      .toEqual(['upload', 'release', 'complete']);
    for (const s of ['completed', 'cancelled', 'no_show'] as const) expect(labActions(booking({ status: s }), ADMIN_ACTOR, after)).toEqual([]);
    // Only paid bookings are operated on.
    expect(labActions(booking({ status: 'pending_payment', paymentStatus: 'pending' }), ADMIN_ACTOR, after)).toEqual([]);
    // Permissions: viewers get nothing; report staff only their own steps.
    expect(labActions(booking({}), staff('bookings.view'), after)).toEqual([]);
    expect(names(labActions(booking({ status: 'processing' }), staff('reports.upload'), after))).toEqual(['upload']);
    expect(names(labActions(booking({ status: 'report_ready' }), staff('reports.release'), after))).toEqual(['release!']);
    expect(names(labActions(booking({ status: 'processing' }), staff('bookings.manage'), after))).toEqual([]);
  });

  it('lists as signers only members the server would accept for this branch', () => {
    const m = (o: Partial<PartnerMember>): PartnerMember => ({
      _id: M, partnerId: P, phone: '9000000000', name: 'X', role: 'staff', permissions: ['reports.release'], branchIds: [],
      professional: { kind: 'pathologist', registrationNumber: 'KMC-1' }, isActive: true, ...o,
    });
    const ok = [m({ name: 'Path' }), m({ name: 'Owner', role: 'owner', permissions: [], branchIds: ['x'.repeat(24)] }), m({ name: 'Here', branchIds: [B] })];
    const no = [
      m({ name: 'No registration', professional: undefined }), m({ name: 'Blank', professional: { kind: 'doctor', registrationNumber: ' ' } }),
      m({ name: 'Uploader', permissions: ['reports.upload'] }), m({ name: 'Elsewhere', branchIds: ['d'.repeat(24)] }), m({ name: 'Gone', isActive: false }),
    ];
    expect(eligibleSigners([...ok, ...no], B).map((x) => x.name)).toEqual(['Path', 'Owner', 'Here']);
  });

  it('accepts only PDF and image reports up to 10 MB', () => {
    expect(reportFileProblem({ name: 'cbc.PDF', size: 1000 })).toBeNull();
    expect(reportFileProblem({ name: 'scan.jpeg', size: 10 * 1024 * 1024 })).toBeNull();
    expect(reportFileProblem({ name: 'r.docx', size: 10 })).toBe('r.docx: only PDF, JPEG, PNG or WebP files can be uploaded.');
    expect(reportFileProblem({ name: 'big.pdf', size: 10 * 1024 * 1024 + 1 })).toBe('big.pdf is larger than 10 MB.');
    expect(reportFileProblem({ name: 'empty.png', size: 0 })).toBe('empty.png is empty.');
  });
});

describe('Q14 lab no-shows (rescheduleNoShow)', () => {
  it('a booking moved after a no-show offers no ordinary new time and no rejection', () => {
    const now = new Date('2026-11-17T05:00:00.000Z');
    const b = { status: 'confirmed', paymentStatus: 'paid', visitMode: 'lab', reschedule: { version: 0, pending: false },
      slot: { slotId: S, date: '2026-11-17', startTime: '09:00', endTime: '09:30', startsAt: '2026-11-17T03:30:00.000Z' },
      report: { draftFiles: [], releasedFiles: [], releases: [] } } as unknown as LabBooking;
    expect(labActions(b, ADMIN_ACTOR, now).map((o) => o.action)).toEqual(['visit', 'no_show', 'reschedule', 'reject']);
    expect(labActions({ ...b, noShowReschedules: 1 }, ADMIN_ACTOR, now).map((o) => o.action)).toEqual(['visit', 'no_show']);
  });

  it('a no-show can be moved once by bookings.manage; a moved one shows as used', () => {
    const viewer = { role: 'staff' as const, permissions: ['bookings.view' as const] };
    const manager = { role: 'staff' as const, permissions: ['bookings.manage' as const] };
    expect(labNoShowMove({ status: 'no_show' }, manager)).toBe('offer');
    expect(labNoShowMove({ status: 'no_show', noShowReschedules: 1 }, manager)).toBe('used');
    expect(labNoShowMove({ status: 'no_show' }, viewer)).toBeNull();
    expect(labNoShowMove({ status: 'confirmed' }, ADMIN_ACTOR)).toBeNull();
  });

  it('sends the slot, the key and the status version; checks them first', async () => {
    const { client, calls } = recorder();
    const api = partnerLabsApi(client, { kind: 'admin', partnerId: P });
    await api.rescheduleNoShow(K, S, 'n'.repeat(32), 3);
    expect(calls[0]).toMatchObject({ method: 'POST', url: `/partner-workspace/admin/${P}/workspace/lab-bookings/${K}/reschedule-no-show`,
      body: { slotId: S, requestKey: 'n'.repeat(32), expectedVersion: 3 } });
    expect(() => api.rescheduleNoShow(K, S, 'short')).toThrow(/request key/);
    expect(() => api.rescheduleNoShow(K, S, 'n'.repeat(32), -1)).toThrow(/version/);
    expect(() => api.rescheduleNoShow(K, 'x', 'n'.repeat(32))).toThrow(/slot id/);
    expect(calls).toHaveLength(1);
  });
});

describe('partnerLabsApi paths', () => {
  it('builds member and admin paths, with bodies as the schemas expect', async () => {
    const { client, calls } = recorder();
    const member = partnerLabsApi(client, { kind: 'member' });
    const admin = partnerLabsApi(client, { kind: 'admin', partnerId: P });
    await member.slots({ branchId: B, visitMode: 'home', from: '2026-11-16', to: '2026-11-22' });
    await admin.saveTemplate(B, 'lab', { slotMinutes: 30, capacity: 2, days: { mon: [{ start: '09:00', end: '12:00' }] } }, '2026-11-20T05:00:00.000Z');
    await member.addSlot({ branchId: B, visitMode: 'lab', date: '2026-11-20', startTime: '18:00', endTime: '18:30', capacity: 1 });
    await admin.setCapacity(S, 4);
    await member.closeSlot(S);
    await member.reopenSlot(S);
    await member.bookings({ status: 'confirmed', branchId: B, from: '2026-11-09', limit: 100, cursor: `1763270000000_${K}` });
    await admin.booking(K);
    await member.assignCollector(K, { memberId: M, name: 'Kiran', phone: '9000000002' }, 3);
    await member.markCollected(K, 3);
    await member.markVisited(K, 3);
    await member.markNoShow(K, 3);
    await member.startProcessing(K, 4);
    await member.complete(K, 7);
    await admin.reject(K, 'Analyser down', 3);
    await member.reschedule(K, S, 'Phlebotomist unavailable', 3);
    await admin.releaseReport(K, `/api/static/partner-lab-reports/${K}/cbc.pdf`, M, 5);
    await member.releaseReport(K, `/api/static/partner-lab-reports/${K}/cbc.pdf`);
    await labBookingsAdminApi(client).list({ partnerId: P, status: 'processing', page: 2, limit: 100 });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET /partner-workspace/slots?branchId=${B}&visitMode=home&from=2026-11-16&to=2026-11-22`,
      `PUT /partner-workspace/admin/${P}/workspace/branches/${B}/slot-templates/lab`,
      'POST /partner-workspace/slots',
      `PUT /partner-workspace/admin/${P}/workspace/slots/${S}/capacity`,
      `POST /partner-workspace/slots/${S}/close`,
      `POST /partner-workspace/slots/${S}/reopen`,
      `GET /partner-workspace/lab-bookings?status=confirmed&branchId=${B}&from=2026-11-09&limit=100&cursor=1763270000000_${K}`,
      `GET /partner-workspace/admin/${P}/workspace/lab-bookings/${K}`,
      `POST /partner-workspace/lab-bookings/${K}/assign`,
      `POST /partner-workspace/lab-bookings/${K}/collect`,
      `POST /partner-workspace/lab-bookings/${K}/visit`,
      `POST /partner-workspace/lab-bookings/${K}/no-show`,
      `POST /partner-workspace/lab-bookings/${K}/process`,
      `POST /partner-workspace/lab-bookings/${K}/complete`,
      `POST /partner-workspace/admin/${P}/workspace/lab-bookings/${K}/reject`,
      `POST /partner-workspace/lab-bookings/${K}/reschedule`,
      `POST /partner-workspace/admin/${P}/workspace/lab-bookings/${K}/reports/release`,
      `POST /partner-workspace/lab-bookings/${K}/reports/release`,
      `GET /partner-workspace/admin/lab-bookings?partnerId=${P}&status=processing&page=2&limit=100`,
    ]);
    // Q11: the template save names the version the editor started from; every booking step names the status version.
    expect(calls[1]!.body).toEqual({ slotMinutes: 30, capacity: 2, days: { mon: [{ start: '09:00', end: '12:00' }] }, expectedUpdatedAt: '2026-11-20T05:00:00.000Z' });
    expect(calls[2]!.body).toEqual({ branchId: B, visitMode: 'lab', date: '2026-11-20', startTime: '18:00', endTime: '18:30', capacity: 1 });
    expect(calls[3]!.body).toEqual({ capacity: 4 });
    expect(calls[8]!.body).toEqual({ memberId: M, name: 'Kiran', phone: '9000000002', expectedVersion: 3 });
    expect(calls.slice(9, 14).map((c) => c.body)).toEqual([{ expectedVersion: 3 }, { expectedVersion: 3 }, { expectedVersion: 3 }, { expectedVersion: 4 }, { expectedVersion: 7 }]);
    expect(calls[14]!.body).toEqual({ reason: 'Analyser down', expectedVersion: 3 });
    expect(calls[15]!.body).toEqual({ slotId: S, reason: 'Phlebotomist unavailable', expectedVersion: 3 });
    expect(calls[16]!.body).toEqual({ file: `/api/static/partner-lab-reports/${K}/cbc.pdf`, signerMemberId: M, expectedVersion: 5 });
    expect(calls[17]!.body).toEqual({ file: `/api/static/partner-lab-reports/${K}/cbc.pdf` }); // members sign as themselves
  });

  it('uploads ONE report per multipart request, under its request key (the browser sets the boundary)', async () => {
    const { client, calls } = recorder(() => new Response(JSON.stringify({ success: true, data: { _id: K } }), { status: 201 }));
    const a = new File(['%PDF-1.4'], 'cbc.pdf', { type: 'application/pdf' });
    await partnerLabsApi(client, { kind: 'member' }).uploadReport(K, a, 'u'.repeat(32));
    expect(calls[0]!.url).toBe(`/partner-workspace/lab-bookings/${K}/reports?requestKey=${'u'.repeat(32)}`);
    const form = calls[0]!.raw as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.getAll('files').map((f) => (f as File).name)).toEqual(['cbc.pdf']);
    expect(calls[0]!.headers['Content-Type']).toBeUndefined();
    expect(() => partnerLabsApi(client, { kind: 'member' }).uploadReport(K, a, 'bad key')).toThrow('Invalid request key');
  });

  it('Q16a: an admin cancels a moved no-show with a reason and an explicit refund choice', async () => {
    const { client, calls } = recorder();
    const admin = labBookingsAdminApi(client);
    await admin.cancelMovedNoShow(K, { reason: '  The lab cannot attend  ', refund: true });
    expect(calls[0]).toMatchObject({ method: 'POST', url: `/partner-workspace/admin/lab-bookings/${K}/cancel-no-show`, body: { reason: 'The lab cannot attend', refund: true } });
    expect(() => admin.cancelMovedNoShow(K, { reason: 'no', refund: false })).toThrow('Invalid reason');
    expect(() => admin.cancelMovedNoShow(K, { reason: 'Because', refund: undefined as never })).toThrow(/refunded/);
    expect(() => admin.cancelMovedNoShow('x', { reason: 'Because', refund: false })).toThrow('Invalid booking id');
    expect(calls).toHaveLength(1);
  });

  it('tells a report refused for its size (any of the server’s ways) from other failures', () => {
    // FileService: one file over 10 MB; formidable's own limits (the whole request counts) surface as UPLOAD_FAILED; a proxy says 413.
    expect(isReportTooLarge(new ApiError(400, 'File a.pdf exceeds maximum size of 10MB', 'FILE_TOO_LARGE'))).toBe(true);
    expect(isReportTooLarge(new ApiError(500, 'options.maxTotalFileSize (10485760 bytes) exceeded, received 10551296 bytes of file data', 'UPLOAD_FAILED'))).toBe(true);
    expect(isReportTooLarge(new ApiError(413, 'Payload Too Large'))).toBe(true);
    expect(isReportTooLarge(new ApiError(500, 'disk full', 'UPLOAD_FAILED'))).toBe(false);
    expect(isUploadFailed(new ApiError(500, 'disk full', 'UPLOAD_FAILED'))).toBe(true);
    expect(isReportTooLarge(new ApiError(0, 'Could not reach the server', 'NETWORK'))).toBe(false);
    expect(isLabBookingChanged(new ApiError(409, 'changed', 'LAB_BOOKING_CHANGED'))).toBe(true);
  });

  it('reads a report file of this booking as a blob through the authenticated file route, the token in the header', async () => {
    const { client, calls } = recorder(() => new Response('%PDF-1.4', { status: 200 }));
    const stored = `/api/static/partner-lab-reports/${K}/cbc%20v2.pdf`;
    const blob = await partnerLabsApi(client, { kind: 'member' }).reportFile(K, stored);
    expect(await blob.text()).toBe('%PDF-1.4');
    expect(calls[0]!.url).toBe(`/file/fetch?url=%2Fapi%2Fstatic%2Fpartner-lab-reports%2F${K}%2Fcbc%2520v2.pdf`);
    expect(calls[0]!.headers.Authorization).toBe('Bearer tok');
    expect(reportFileBooking(stored)).toBe(K);
    expect(reportFileName(stored)).toBe('cbc v2.pdf');
  });

  it('refuses malformed ids, modes, dates and files of another booking before any request', () => {
    const { client, calls } = recorder();
    const m = partnerLabsApi(client, { kind: 'member' });
    expect(() => m.booking('../me')).toThrow('Invalid booking id');
    expect(() => m.setCapacity(`${S}/x`, 1)).toThrow('Invalid slot id');
    expect(() => m.slots({ branchId: B, visitMode: 'clinic' as never, from: '2026-11-16', to: '2026-11-22' })).toThrow('Invalid visit mode');
    expect(() => m.slots({ branchId: B, visitMode: 'lab', from: '2026-02-30', to: '2026-11-22' })).toThrow('Invalid from date');
    expect(() => m.saveTemplate('x', 'lab', { slotMinutes: 30, capacity: 1, days: {} }, null)).toThrow('Invalid branch id');
    expect(() => m.bookings({ cursor: '../x' })).toThrow('Invalid cursor');
    expect(() => m.bookings({ limit: 500 })).toThrow('Invalid page size');
    expect(() => m.markNoShow(K, -1)).toThrow('Invalid booking version');
    expect(() => labBookingsAdminApi(client).list({ page: 0 })).toThrow('Invalid page');
    expect(() => m.reschedule(K, 'nope', 'reason')).toThrow('Invalid slot id');
    expect(() => m.assignCollector(K, { memberId: '1', name: 'A' })).toThrow('Invalid member id');
    expect(() => m.reportFile(K, `/api/static/partner-lab-reports/${S}/cbc.pdf`)).toThrow('Not a report file of this booking');
    expect(() => m.reportFile(K, 'https://evil.example/x.pdf')).toThrow('Not a report file of this booking');
    expect(() => m.releaseReport(K, `/api/static/partner-lab-reports/${K}/../x.pdf`)).toThrow('Not a report file of this booking');
    expect(() => partnerLabsApi(client, { kind: 'admin', partnerId: 'x' }).bookings()).toThrow('Invalid partner id');
    expect(() => labBookingsAdminApi(client).list({ partnerId: '1' })).toThrow('Invalid partner id');
    expect(calls).toHaveLength(0);
  });
});
