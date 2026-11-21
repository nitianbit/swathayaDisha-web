import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * WQ10b: admin consultation bookings and the one move of a no-show, against a mocked backend (Q14 rules mirrored). WQ10c
 * (Q15): `status=no_show` is a filter, admin rows carry `patientName`, and a move onto another doctor's slot is refused
 * 409 SLOT_NOT_THIS_DOCTOR.
 */
const ADMIN = 'ad'.repeat(12);
const DOC1 = 'd1'.repeat(12);
const DOC2 = 'd2'.repeat(12);
const BK1 = 'e1'.repeat(12);
const BK2 = 'e2'.repeat(12);
const BK3 = 'e3'.repeat(12);
const BK4 = 'e4'.repeat(12);
const BK5 = 'e5'.repeat(12);
const BK6 = 'e6'.repeat(12);
const OLD_SLOT = '50'.repeat(12);
const S_STARTED = '51'.repeat(12);
const S1 = '52'.repeat(12);
const S2 = '53'.repeat(12);
const S_CLINIC = '54'.repeat(12);
const S3 = '55'.repeat(12);
const NOW = new Date('2026-11-20T04:30:00.000Z'); // Fri 20 Nov 2026, 10:00 in India
const V0 = '2026-11-19T06:00:00.000Z';

type Rec = Record<string, unknown>;
interface Backend {
  calls: { method: string; path: string; body: unknown }[];
  bookings: Rec[];
  slots: Rec[];
  /** The next move is made, then its answer is lost. */
  loseAfter?: boolean;
  /** The next move is lost before it reaches the server. */
  loseBefore?: boolean;
  /** WQ11b (Q16a): the next admin cancel is made, then its answer is lost. */
  loseCancelAfter?: boolean;
  /** The next move finds its slot just taken. */
  takeNext?: boolean;
  /** Free-slot reads also list another doctor's slot without saying whose it is (as a misbehaving server might). */
  stray?: boolean;
}

/** Q15 `withPatientNames`: the family member's name when the booking has a dependentId, else the account holder's. */
const USERS: Record<string, string> = { ['u1'.repeat(12)]: 'Ravi Kumar' };
const DEPENDENTS: Record<string, string> = { ['f1'.repeat(12)]: 'Meena Kumar' };
const patientName = (x: Rec) => (x.dependentId ? DEPENDENTS[String(x.dependentId)] : USERS[String(x.userId)]) ?? null;
const S_OTHER = '57'.repeat(12);

function booking(id: string, o: Rec): Rec {
  return { _id: id, bookingType: 'consultation', bookingKind: 'scheduled', userId: 'u1'.repeat(12), specialistId: DOC1, doctorName: 'Dr Asha Mehta',
    consultationMode: 'video', bookingDate: '20261119', bookingTime: '10:00', slotId: OLD_SLOT, status: 'confirmed', paymentStatus: 'paid', price: 800,
    createdAt: '2026-11-15T05:00:00.000Z', updatedAt: V0, ...o };
}
const slot = (id: string, date: string, start: string, end: string, o: Rec = {}): Rec =>
  ({ _id: id, specialistId: DOC1, date, startTime: start, endTime: end, maxBookings: 1, currentBookings: 0, isAvailable: true, isActive: true, serviceModes: ['video', 'call'], ...o });

async function mockBackend(page: Page): Promise<Backend> {
  await page.clock.setSystemTime(NOW); // time moves on from here (a move is settled by a read made after it)
  const b: Backend = {
    calls: [],
    bookings: [
      booking(BK1, { status: 'no_show', dependentId: 'f1'.repeat(12), noShow: { at: '2026-11-19T05:15:00.000Z' } }),
      booking(BK2, { status: 'no_show', bookingKind: 'instant', bookingDate: '20261118', noShow: { at: '2026-11-18T05:15:00.000Z' } }),
      booking(BK3, { status: 'no_show', specialistId: DOC2, doctorName: 'Dr Kiran Rao', consultationMode: 'in-person', settlementSystem: 'clinic', paymentStatus: 'pending',
        clinicDesk: { partnerId: 'a2'.repeat(12), branchId: 'c1'.repeat(12) }, bookingDate: '20261117' }),
      booking(BK4, { bookingDate: '20261121', noShowReschedules: 1,
        noShows: [{ at: '2026-11-16T05:15:00.000Z', rescheduledAt: '2026-11-16T06:00:00.000Z', fromDate: '20261116', fromTime: '10:00', toSlotId: S3 }] }),
      booking(BK5, { status: 'completed', specialistId: DOC2, doctorName: 'Dr Kiran Rao', bookingDate: '20261110', userId: 'u9'.repeat(12) }),
      booking(BK6, { status: 'no_show', bookingDate: '20261114', noShow: { at: '2026-11-14T05:15:00.000Z' }, noShowReschedules: 1,
        noShows: [{ at: '2026-11-12T05:15:00.000Z', rescheduledAt: '2026-11-12T06:00:00.000Z', fromDate: '20261112', fromTime: '09:00', toSlotId: '56'.repeat(12) }] }),
    ],
    slots: [
      slot(S_STARTED, '20261120', '09:00', '09:30'),
      slot(S1, '20261120', '11:00', '11:30'),
      slot(S2, '20261120', '11:30', '12:00'),
      slot(S_CLINIC, '20261120', '12:00', '12:30', { branchId: 'c1'.repeat(12), serviceModes: [] }),
      slot(S3, '20261121', '10:00', '10:30'),
      slot(S_OTHER, '20261120', '13:00', '13:30', { specialistId: DOC2 }),
    ],
  };
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const ok = (route: Route, data: unknown, status = 200) => json(route, status, { success: true, data });
  const fail = (route: Route, status: number, code: string, message: string) => json(route, status, { error: status, code, message });
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = req.method();
    const body = ['POST', 'PUT'].includes(method) ? req.postDataJSON() : null;
    if (path.startsWith('/auth/session')) return fail(route, 401, 'SESSION_ENDED', 'Please sign in again');
    b.calls.push({ method, path: `${path}${url.search}`, body });
    if (path === '/auth/admin/send') return ok(route, undefined);
    if (path === '/auth/admin/verify') return ok(route, { token: 'admin', expiresIn: 900, user: {} });
    if (req.headers().authorization !== 'Bearer admin') return fail(route, 401, 'UNAUTHORIZED', 'Authentication is required');
    if (path === '/auth/profile') return ok(route, { user: { _id: ADMIN, name: 'Ops Admin' }, userRole: 'admin' });

    if (path === '/bookings' && method === 'GET') {
      const q = url.searchParams;
      const status = q.get('status');
      if (status && !['pending', 'confirmed', 'completed', 'cancelled', 'no_show'].includes(status)) return fail(route, 400, 'VALIDATION_ERROR', 'Status must be one of: pending, confirmed, completed, cancelled, no_show');
      const all = b.bookings.filter((x) => (!q.get('bookingType') || x.bookingType === q.get('bookingType')) && (!status || x.status === status)
        && (!q.get('specialistId') || x.specialistId === q.get('specialistId'))
        && (!q.get('bookingDateFrom') || String(x.bookingDate) >= q.get('bookingDateFrom')!) && (!q.get('bookingDateTo') || String(x.bookingDate) <= q.get('bookingDateTo')!))
        .sort((x, y) => String(y.bookingDate).localeCompare(String(x.bookingDate)));
      const limit = Number(q.get('limit') ?? 10);
      const pg = Number(q.get('page') ?? 1);
      return json(route, 200, { success: true, data: all.slice((pg - 1) * limit, pg * limit).map((x) => ({ ...x, patientName: patientName(x) })), pagination: { page: pg, limit, total: all.length, totalPages: Math.ceil(all.length / limit) } });
    }
    const one = /^\/bookings\/([0-9a-f]{24})$/.exec(path);
    if (one && method === 'GET') {
      const bk = b.bookings.find((x) => x._id === one[1]);
      return bk ? ok(route, { ...bk, patientName: patientName(bk) }) : fail(route, 404, 'BOOKING_NOT_FOUND', 'Booking not found'); // Q15: admin reads name the patient
    }
    if (path === '/specialists' && method === 'GET') {
      const name = (url.searchParams.get('name') ?? '').toLowerCase();
      const docs = [{ _id: DOC1, name: 'Dr Asha Mehta', specialization: 'Cardiology', isActive: true }, { _id: DOC2, name: 'Dr Kiran Rao', specialization: 'General', isActive: false }]
        .filter((d) => d.name.toLowerCase().includes(name));
      return json(route, 200, { success: true, data: docs, pagination: { page: 1, limit: 20, total: docs.length, totalPages: 1 } });
    }
    if (path === '/slots/available') {
      const q = url.searchParams;
      const mode = q.get('mode');
      const free = b.slots.filter((s) => s.date === q.get('date') && (s.currentBookings as number) < (s.maxBookings as number)
        && (!mode || !(s.serviceModes as string[]).length || (s.serviceModes as string[]).includes(mode)));
      return ok(route, [
        ...free.filter((s) => s.specialistId === q.get('specialistId')),
        ...(b.stray ? free.filter((s) => s.specialistId !== q.get('specialistId')).map(({ specialistId: _d, ...rest }) => rest) : []),
      ]);
    }
    // Q16a `adminCancelNoShow` → `adminCancelMovedNoShow` / `cancelBookingSettlement` with `movedNoShow`.
    const cn = /^\/specialists\/admin\/bookings\/([0-9a-f]{24})\/cancel-no-show$/.exec(path);
    if (cn && method === 'POST') {
      const bk = b.bookings.find((x) => x._id === cn[1]);
      if (!bk) return fail(route, 404, 'BOOKING_NOT_FOUND', 'Booking not found');
      const x = body as { reason?: unknown; refund?: unknown };
      if (typeof x.reason !== 'string' || x.reason.trim().length < 3 || x.reason.trim().length > 500 || typeof x.refund !== 'boolean') {
        return fail(route, 400, 'VALIDATION_ERROR', '"reason" and "refund" are required');
      }
      if (bk.bookingKind === 'instant') return fail(route, 409, 'INSTANT_CONSULT_COMMAND_REQUIRED', 'Use the instant consultation cancel command');
      // Q16a final: a repeat of the admin cancel is refused (never refunded twice).
      if (bk.status === 'cancelled') return fail(route, 409, 'ALREADY_CANCELLED', 'This booking is already cancelled');
      if (!['pending', 'confirmed'].includes(String(bk.status))) return fail(route, 409, 'BOOKING_NOT_CANCELLABLE', `A ${bk.status} booking cannot be cancelled`);
      if (!(bk.noShows as Rec[] | undefined)?.length) return fail(route, 409, 'BOOKING_NOT_MOVED_NO_SHOW', 'This booking was not moved after a no-show; use the ordinary cancellation');
      Object.assign(bk, { status: 'cancelled', cancellationReason: x.reason.trim(), noShowCancel: { at: NOW.toISOString(), refund: x.refund },
        ...(x.refund ? { paymentStatus: 'refunded' } : {}), updatedAt: '2026-11-20T04:40:00.000Z' });
      if (b.loseCancelAfter) { b.loseCancelAfter = false; return route.abort('failed'); }
      return ok(route, { ...bk, refunded: x.refund ? bk.price : 0 });
    }
    const mv = /^\/specialists\/admin\/bookings\/([0-9a-f]{24})\/reschedule-no-show$/.exec(path);
    if (mv && method === 'POST') {
      if (b.loseBefore) { b.loseBefore = false; return route.abort('failed'); }
      const bk = b.bookings.find((x) => x._id === mv[1]);
      if (!bk) return fail(route, 404, 'BOOKING_NOT_FOUND', 'Booking not found');
      const x = body as { slotId: string; requestKey: string; expectedUpdatedAt?: string };
      if (bk.bookingKind === 'instant') return fail(route, 409, 'INSTANT_CONSULT_COMMAND_REQUIRED', 'An instant consultation cannot be rescheduled');
      if (bk.clinicDesk) return fail(route, 409, 'CLINIC_APPOINTMENT', 'Ask the clinic to change this appointment');
      const prior = (bk.noShows as Rec[] | undefined)?.find((n) => n.requestKey === x.requestKey);
      if (prior) return prior.toSlotId === x.slotId ? ok(route, { ...bk, replayed: true }) : fail(route, 409, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different reschedule');
      if ((bk.noShowReschedules as number ?? 0) >= 1) return fail(route, 409, 'NO_SHOW_RESCHEDULE_USED', 'This booking was already rescheduled once after a no-show; a second no-show is final');
      if (bk.status !== 'no_show') return fail(route, 409, 'BOOKING_NOT_NO_SHOW', `A ${bk.status} booking is not a no-show`);
      if (x.expectedUpdatedAt && x.expectedUpdatedAt !== bk.updatedAt) return fail(route, 409, 'BOOKING_CHANGED', 'This booking changed; read it again');
      const s = b.slots.find((y) => y._id === x.slotId);
      // Q15 (`rescheduleWithHolds`): every move stays with the booking's doctor.
      if (s && s.specialistId !== bk.specialistId) return fail(route, 409, 'SLOT_NOT_THIS_DOCTOR', 'This slot belongs to another doctor; pick one of this doctor\'s slots');
      if (b.takeNext && s) { b.takeNext = false; s.currentBookings = 1; }
      if (!s || (s.currentBookings as number) >= (s.maxBookings as number)) return fail(route, 409, 'SLOT_NOT_AVAILABLE', 'Slot is not available for booking');
      s.currentBookings = 1;
      bk.noShows = [{ at: (bk.noShow as Rec).at, rescheduledAt: NOW.toISOString(), fromDate: bk.bookingDate, fromTime: bk.bookingTime, fromSlotId: bk.slotId, toSlotId: s._id, requestKey: x.requestKey }];
      Object.assign(bk, { status: 'confirmed', bookingDate: s.date, bookingTime: s.startTime, slotId: s._id, noShowReschedules: 1, updatedAt: '2026-11-20T04:31:00.000Z' });
      delete bk.noShow;
      if (b.loseAfter) { b.loseAfter = false; return route.abort('failed'); }
      return ok(route, { ...bk, replayed: false });
    }
    return fail(route, 404, 'NOT_FOUND', 'Not found');
  });
  return b;
}

async function signInAdmin(page: Page) {
  await page.goto('/');
  await page.getByLabel('Admin').check();
  await page.getByLabel('Mobile number').fill('9876543210');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

const lists = (b: Backend) => b.calls.filter((c) => c.method === 'GET' && c.path.startsWith('/bookings?')).map((c) => c.path);
const moves = (b: Backend) => b.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/reschedule-no-show'));

async function chooseTime(page: Page, time: string) {
  await page.getByRole('button', { name: 'Reschedule no-show' }).click();
  const form = page.getByRole('form', { name: 'Reschedule no-show' });
  await form.getByLabel('New time').selectOption({ label: time });
  await form.getByRole('button', { name: 'Continue' }).click();
  return form;
}

test('consultations: filtered by status (no-shows too), doctor and appointment dates as the server takes them; patients are named', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Consultations' }).click();
  await expect(page.getByText('6 consultations')).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Thu, 19 Nov' })).toContainText('No-show');
  await expect(page.getByRole('row').filter({ hasText: 'Sat, 21 Nov' })).toContainText('Moved after a no-show');
  await expect(page.getByRole('row').filter({ hasText: 'Tue, 17 Nov' })).toContainText('Clinic front desk');
  // Q15: each row names the patient (the family member for BK1); an unknown name is a dash.
  await expect(page.getByRole('columnheader', { name: 'Patient' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Thu, 19 Nov' })).toContainText('Meena Kumar');
  await expect(page.getByRole('row').filter({ hasText: 'Sat, 21 Nov' })).toContainText('Ravi Kumar');
  await expect(page.getByRole('row').filter({ hasText: 'Tue, 10 Nov' }).getByRole('cell').nth(1)).toHaveText('—');
  await expect(page.getByText('No-shows cannot be listed on their own', { exact: false })).toHaveCount(0);
  await expect(page.getByLabel('Status').locator('option')).toHaveText(['Any status', 'Waiting', 'Confirmed', 'Completed', 'Cancelled', 'No-show']);
  await page.getByLabel('Status').selectOption('no_show');
  await expect(page.getByText('4 consultations')).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Sat, 21 Nov' })).toHaveCount(0);
  await page.getByLabel('Status').selectOption('confirmed');
  await expect(page.getByText('1 consultation')).toBeVisible();
  await page.getByLabel('Status').selectOption('');
  await page.getByLabel('Doctor’s name').fill('rao');
  await page.getByRole('button', { name: 'Find doctor' }).click();
  await page.getByRole('list', { name: 'Doctors found' }).getByRole('button', { name: 'Dr Kiran Rao · General · inactive' }).click();
  await expect(page.getByText('2 consultations')).toBeVisible();
  await page.getByLabel('Appointments from').fill('2026-11-15');
  await expect(page.getByText('1 consultation')).toBeVisible();
  await page.getByLabel('Appointments to').fill('2026-11-01');
  await expect(page.getByText('The period ends before it starts.')).toBeVisible();
  await page.getByLabel('Appointments to').fill('2026-11-30');
  await page.getByRole('button', { name: 'All doctors' }).click();
  await expect(page.getByText('4 consultations')).toBeVisible();
  expect(lists(backend)).toEqual([
    '/bookings?bookingType=consultation&page=1&limit=20',
    '/bookings?bookingType=consultation&status=no_show&page=1&limit=20',
    '/bookings?bookingType=consultation&status=confirmed&page=1&limit=20',
    `/bookings?bookingType=consultation&specialistId=${DOC2}&page=1&limit=20`,
    `/bookings?bookingType=consultation&specialistId=${DOC2}&bookingDateFrom=20261115&page=1&limit=20`,
    `/bookings?bookingType=consultation&specialistId=${DOC2}&bookingDateFrom=20261115&bookingDateTo=20261130&page=1&limit=20`,
    '/bookings?bookingType=consultation&bookingDateFrom=20261115&bookingDateTo=20261130&page=1&limit=20',
  ]);
});

test('a no-show is moved once to a free time of its own doctor after a confirmation, with a key and the version; then never again', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await page.goto(`/#/admin/consultations/${BK1}`);
  await expect(page.getByRole('heading', { name: 'Consultation on Thu, 19 Nov, 2026, 10:00' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'No-show history' })).toContainText('Marked as a no-show (Thu, 19 Nov, 2026, 10:00)');
  await expect(page.getByText('A no-show is not refunded and the doctor earns nothing for it.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Reschedule no-show' }).click();
  const form = page.getByRole('form', { name: 'Reschedule no-show' });
  // Started, clinic and full times are not offered.
  await expect(form.getByLabel('New time').locator('option')).toHaveText(['Choose a time', '11:00–11:30 · online', '11:30–12:00 · online']);
  await form.getByRole('button', { name: 'Continue' }).click();
  await expect(form.getByText('Choose the new time.')).toBeVisible();
  await form.getByLabel('New time').selectOption({ label: '11:00–11:30 · online' });
  await form.getByRole('button', { name: 'Continue' }).click();
  await expect(form).toContainText('Move The patient’s missed time (Thu, 19 Nov, 2026, 10:00) to');
  await expect(form).toContainText('nothing is paid or refunded');
  await expect(form).toContainText('This can be done only once');
  await form.getByRole('button', { name: /^Move to/ }).click();
  await expect(page.getByText(/The patient’s no-show is moved to .*11:00 \(online\)\. It is booked again at the same price\./)).toBeVisible();
  await expect(page.getByRole('list', { name: 'No-show history' })).toContainText('Moved once to a new time (now Fri, 20 Nov, 2026, 11:00)');
  await expect(page.getByRole('button', { name: 'Reschedule no-show' })).toHaveCount(0);
  const sent = moves(backend);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.path).toBe(`/specialists/admin/bookings/${BK1}/reschedule-no-show`);
  expect(sent[0]!.body).toEqual({ slotId: S1, requestKey: expect.stringMatching(/^[A-Za-z0-9_-]{8,100}$/), expectedUpdatedAt: V0 });
  expect(backend.calls.some((c) => c.path === `/slots/available?specialistId=${DOC1}&date=20261120&mode=video`)).toBe(true);
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(stored).not.toContain(S1);
});

test('WQ11 (Q16a): a doctor session with several seats that has started is still offered until it ends; a started one-patient slot is not', async ({ page }) => {
  const backend = await mockBackend(page);
  const SESSION = '5a'.repeat(12);
  const ENDED = '5b'.repeat(12);
  backend.slots.unshift( // the server lists them by start time
    slot(ENDED, '20261120', '09:00', '10:00', { maxBookings: 4, currentBookings: 1 }), // ended at 10:00
    slot(SESSION, '20261120', '09:30', '10:30', { maxBookings: 4, currentBookings: 1 }), // 10:00 now: running, seats free
  );
  await signInAdmin(page);
  await page.goto(`/#/admin/consultations/${BK1}`);
  await page.getByRole('button', { name: 'Reschedule no-show' }).click();
  const form = page.getByRole('form', { name: 'Reschedule no-show' });
  await expect(form.getByLabel('New time').locator('option')).toHaveText(['Choose a time', '09:30–10:30 · online', '11:00–11:30 · online', '11:30–12:00 · online']);
  await form.getByLabel('New time').selectOption({ label: '09:30–10:30 · online' });
  await form.getByRole('button', { name: 'Continue' }).click();
  await form.getByRole('button', { name: /^Move to/ }).click();
  await expect(page.getByText(/The patient’s no-show is moved to .*09:30 \(online\)\. It is booked again at the same price\./)).toBeVisible();
  expect(moves(backend).map((c) => (c.body as Rec).slotId)).toEqual([SESSION]);
});

test('a lost move answer: the booking read again settles it; one lost before the server is sent again with the same key, once', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await page.goto(`/#/admin/consultations/${BK1}`);
  backend.loseBefore = true;
  const form = await chooseTime(page, '11:30–12:00 · online');
  await form.getByRole('button', { name: /^Move to/ }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed no-show move' });
  await expect(panel).toContainText('has not been confirmed');
  await panel.getByRole('button', { name: 'Send the same move again' }).click();
  await expect(page.getByText(/no-show is moved to .*11:30/)).toBeVisible();
  const sent = moves(backend);
  expect(sent).toHaveLength(2);
  expect((sent[1]!.body as Rec).requestKey).toBe((sent[0]!.body as Rec).requestKey);
  expect(sent[1]!.body).toEqual(sent[0]!.body);

  // Another booking: made on the server, answer lost; the read that follows shows it moved.
  backend.bookings.push(booking('e7'.repeat(12), { status: 'no_show', noShow: { at: '2026-11-19T05:15:00.000Z' }, bookingTime: '09:00' }));
  backend.loseAfter = true;
  await page.goto(`/#/admin/consultations/${'e7'.repeat(12)}`);
  const f2 = await chooseTime(page, '11:00–11:30 · online');
  await f2.getByRole('button', { name: /^Move to/ }).click();
  await expect(page.getByText('The patient’s no-show has been moved to a new time (it can be moved only once). Nothing more to do.')).toBeVisible();
  expect(moves(backend)).toHaveLength(3);
});

test('no move for an instant consultation or a front-desk appointment; a second no-show is final; a move used elsewhere is refused', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await page.goto(`/#/admin/consultations/${BK2}`);
  await expect(page.getByText('An instant consultation is never moved to a new time.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reschedule no-show' })).toHaveCount(0);
  await page.goto(`/#/admin/consultations/${BK3}`);
  await expect(page.getByText('The clinic moves this appointment: it was booked at its front desk.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reschedule no-show' })).toHaveCount(0);
  await page.goto(`/#/admin/consultations/${BK6}`);
  await expect(page.getByRole('button', { name: 'Reschedule no-show' })).toBeDisabled();
  await expect(page.getByText('Already moved once after a no-show: a second no-show is final.')).toBeVisible();
  await expect(page.getByRole('list', { name: 'No-show history' })).toContainText('final, it was already moved once');

  await page.goto(`/#/admin/consultations/${BK1}`);
  const form = await chooseTime(page, '11:00–11:30 · online');
  backend.bookings.find((x) => x._id === BK1)!.noShowReschedules = 1; // the doctor moved it meanwhile
  await form.getByRole('button', { name: /^Move to/ }).click();
  await expect(page.getByText('This booking was already moved once after a no-show. A second no-show is final, so it cannot be moved again.')).toBeVisible();
  expect(moves(backend)).toHaveLength(1);
});

test('a time taken meanwhile is refused: the doctor’s free times are read again and another is chosen', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await page.goto(`/#/admin/consultations/${BK1}`);
  backend.takeNext = true;
  const form = await chooseTime(page, '11:00–11:30 · online');
  await form.getByRole('button', { name: /^Move to/ }).click();
  await expect(page.getByText('Not moved: That time is no longer free. Pick another time.')).toBeVisible();
  const again = page.getByRole('form', { name: 'Reschedule no-show' });
  await expect(again.getByLabel('New time').locator('option')).toHaveText(['Choose a time', '11:30–12:00 · online']);
  await again.getByLabel('New time').selectOption({ label: '11:30–12:00 · online' });
  await again.getByRole('button', { name: 'Continue' }).click();
  await again.getByRole('button', { name: /^Move to/ }).click();
  await expect(page.getByText(/no-show is moved to .*11:30/)).toBeVisible();
  const sent = moves(backend);
  expect(sent.map((c) => (c.body as Rec).slotId)).toEqual([S1, S2]);
  expect((sent[1]!.body as Rec).requestKey).not.toBe((sent[0]!.body as Rec).requestKey); // a refused first attempt: a new request
});

test('WQ10c: the booking page names the patient from the booking itself (no list walk); nothing about them in storage or the address', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await page.goto(`/#/admin/consultations/${BK1}`);
  await expect(page.getByRole('heading', { name: 'Consultation on Thu, 19 Nov, 2026, 10:00' })).toBeVisible();
  await expect(page.getByText('Meena Kumar (a family member of the account holder)')).toBeVisible();
  expect(lists(backend)).toEqual([]); // one read of the booking, no list pages
  await page.goto(`/#/admin/consultations/${BK5}`);
  await expect(page.getByRole('heading', { name: /Consultation on Tue, 10 Nov/ })).toBeVisible();
  await expect(page.getByText('The account holder', { exact: true })).toBeVisible(); // name unknown: the old words
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + location.href);
  expect(stored).not.toContain('Meena');
});

test('WQ10c: a time that belongs to another doctor is refused SLOT_NOT_THIS_DOCTOR in words; the free times are read again', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  backend.stray = true;
  await page.goto(`/#/admin/consultations/${BK1}`);
  // The stray slot carries no doctor, so the picker cannot tell it apart: the server decides.
  const form = await chooseTime(page, '13:00–13:30 · online');
  backend.stray = false; // the free times read after the refusal are the doctor's own
  await form.getByRole('button', { name: /^Move to/ }).click();
  await expect(page.getByText('Not moved: That time belongs to another doctor. Pick one of this doctor’s times.')).toBeVisible();
  const again = page.getByRole('form', { name: 'Reschedule no-show' });
  await expect(again.getByLabel('New time').locator('option')).toHaveText(['Choose a time', '11:00–11:30 · online', '11:30–12:00 · online']);
  await again.getByLabel('New time').selectOption({ label: '11:00–11:30 · online' });
  await again.getByRole('button', { name: 'Continue' }).click();
  await again.getByRole('button', { name: /^Move to/ }).click();
  await expect(page.getByText(/no-show is moved to .*11:00/)).toBeVisible();
  expect(moves(backend).map((c) => (c.body as Rec).slotId)).toEqual([S_OTHER, S1]);
  expect(backend.bookings.find((x) => x._id === BK1)!.specialistId).toBe(DOC1);
});

test('WQ11b: a move lost before the server whose time is then taken: after the refused resend a new time is chosen as a new move, without a reload', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await page.goto(`/#/admin/consultations/${BK1}`);
  const form = await chooseTime(page, '11:00–11:30 · online');
  backend.loseBefore = true; // the request never reaches the server
  await form.getByRole('button', { name: /^Move to/ }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed no-show move' });
  await expect(panel).toBeVisible();
  // Someone books 11:00 meanwhile: the resend (same key, same time) is refused for good.
  backend.slots.find((s) => s._id === S1)!.currentBookings = 1;
  await panel.getByRole('button', { name: 'Send the same move again' }).click();
  await expect(panel.getByText(/That time is no longer free\. Pick another time\./)).toBeVisible();
  // The booking, read again after that attempt, is still a no-show: a new time can be chosen (after a second step).
  await panel.getByRole('button', { name: 'Check the booking' }).click();
  await panel.getByRole('button', { name: 'Choose a new time again' }).click();
  await expect(panel).toContainText('A new time is sent as a new move.');
  await panel.getByRole('button', { name: 'Forget it and choose again' }).click();
  const again = page.getByRole('form', { name: 'Reschedule no-show' });
  await again.getByLabel('New time').selectOption({ label: '11:30–12:00 · online' });
  await again.getByRole('button', { name: 'Continue' }).click();
  await again.getByRole('button', { name: /^Move to/ }).click();
  await expect(page.getByText(/no-show is moved to .*11:30/)).toBeVisible();
  await expect(panel).toHaveCount(0);
  const sent = moves(backend);
  expect(sent.map((c) => (c.body as Rec).slotId)).toEqual([S1, S1, S2]);
  expect((sent[1]!.body as Rec).requestKey).toBe((sent[0]!.body as Rec).requestKey);
  expect((sent[2]!.body as Rec).requestKey).not.toBe((sent[0]!.body as Rec).requestKey); // a new move, a new key
  expect(backend.bookings[0]!.status).toBe('confirmed');
});

test('WQ11b (Q16a): "Cancel (admin)" of a booking moved after a no-show needs a reason and an explicit refund choice; refunded, the patient is told', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  // Not offered on a no-show that was never moved, nor on a finished booking.
  await page.goto(`/#/admin/consultations/${BK1}`);
  await expect(page.getByRole('heading', { name: /^Consultation on/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel (admin)' })).toHaveCount(0);
  await page.goto(`/#/admin/consultations/${BK4}`);
  await page.getByRole('button', { name: 'Cancel (admin)' }).click();
  const panel = page.getByRole('group', { name: 'Cancel (admin)' });
  await expect(panel).toContainText('the patient and the doctor are told');
  await expect(panel.getByLabel(/Yes: ₹800\.00 goes back to the patient’s Jansetu wallet/)).not.toBeChecked();
  await expect(panel.getByLabel(/No: the payment stays with Jansetu/)).not.toBeChecked();
  // Nothing is sent without a reason and a choice (there is no default).
  await panel.getByRole('button', { name: 'Cancel the appointment' }).click();
  await expect(panel.getByText('Give a reason (at least 3 characters).')).toBeVisible();
  await expect(panel.getByText('Choose whether the patient is refunded.')).toBeVisible();
  expect(backend.calls.filter((c) => c.path.endsWith('/cancel-no-show'))).toHaveLength(0);
  await panel.getByLabel('Reason (the patient sees this)').fill('  The doctor is on leave  ');
  await panel.getByLabel(/Yes: ₹800\.00/).check();
  await panel.getByRole('button', { name: 'Cancel the appointment' }).click();
  await expect(page.getByText('The appointment was cancelled; ₹800.00 is back in the patient’s Jansetu wallet. The patient and the doctor are told.')).toBeVisible();
  const sent = backend.calls.filter((c) => c.path.endsWith('/cancel-no-show'));
  expect(sent.map((c) => [c.path, c.body])).toEqual([[`/specialists/admin/bookings/${BK4}/cancel-no-show`, { reason: 'The doctor is on leave', refund: true }]]);
  // Read again: cancelled, the button is gone, and the page says how.
  await expect(page.getByText('Cancelled', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel (admin)' })).toHaveCount(0);
  await expect(page.getByText(/the patient was refunded to their Jansetu wallet/)).toBeVisible();
});

test('WQ11b (Q16a): a refused "Cancel (admin)" is said in words and the booking read again', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await page.goto(`/#/admin/consultations/${BK4}`);
  // Refused: the booking was completed meanwhile.
  await page.getByRole('button', { name: 'Cancel (admin)' }).click();
  const panel = page.getByRole('group', { name: 'Cancel (admin)' });
  await panel.getByLabel('Reason (the patient sees this)').fill('The doctor is on leave');
  await panel.getByLabel(/No: the payment stays with Jansetu/).check();
  const bk = backend.bookings.find((x) => x._id === BK4)!;
  bk.status = 'completed';
  await panel.getByRole('button', { name: 'Cancel the appointment' }).click();
  await expect(page.getByText('Not cancelled: This booking can no longer be cancelled (it was completed, cancelled or marked a no-show again meanwhile).')).toBeVisible();
  await expect(page.getByText('Completed', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel (admin)' })).toHaveCount(0);
});

test('WQ11b (Q16a): a "Cancel (admin)" whose answer is lost is settled by reading the booking (cancelled = done)', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await page.goto(`/#/admin/consultations/${BK4}`);
  const bk = backend.bookings.find((x) => x._id === BK4)!;
  await page.getByRole('button', { name: 'Cancel (admin)' }).click();
  const panel = page.getByRole('group', { name: 'Cancel (admin)' });
  await panel.getByLabel('Reason (the patient sees this)').fill('The doctor is on leave');
  await panel.getByLabel(/No: the payment stays with Jansetu/).check();
  backend.loseCancelAfter = true;
  await panel.getByRole('button', { name: 'Cancel the appointment' }).click();
  await expect(page.getByText('The appointment was cancelled without a refund: the payment stays with Jansetu and nobody earns it. The patient and the doctor are told.')).toBeVisible();
  expect(bk.status).toBe('cancelled');
  expect(bk.noShowCancel).toEqual({ at: NOW.toISOString(), refund: false });
  expect(backend.calls.filter((c) => c.path.endsWith('/cancel-no-show'))).toHaveLength(1);
});

test('WQ11 (Q16a final): a "Cancel (admin)" of a booking another admin already cancelled is refused 409 ALREADY_CANCELLED and said as already done', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await page.goto(`/#/admin/consultations/${BK4}`);
  const bk = backend.bookings.find((x) => x._id === BK4)!;
  await page.getByRole('button', { name: 'Cancel (admin)' }).click();
  const panel = page.getByRole('group', { name: 'Cancel (admin)' });
  await panel.getByLabel('Reason (the patient sees this)').fill('The doctor is on leave');
  await panel.getByLabel(/No: the payment stays with Jansetu/).check();
  // Meanwhile another admin cancelled it with a refund.
  Object.assign(bk, { status: 'cancelled', noShowCancel: { at: NOW.toISOString(), refund: true }, paymentStatus: 'refunded', updatedAt: '2026-11-20T04:41:00.000Z' });
  await panel.getByRole('button', { name: 'Cancel the appointment' }).click();
  await expect(page.getByText('This appointment was already cancelled, with a refund to the patient’s Jansetu wallet: nothing more was done.')).toBeVisible();
  await expect(page.getByText(/^Not cancelled/)).toHaveCount(0);
  await expect(page.getByText('Cancelled', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel (admin)' })).toHaveCount(0);
  expect(backend.calls.filter((c) => c.path.endsWith('/cancel-no-show'))).toHaveLength(1);
  expect(bk.noShowCancel).toEqual({ at: NOW.toISOString(), refund: true }); // not changed by the refused repeat
});
