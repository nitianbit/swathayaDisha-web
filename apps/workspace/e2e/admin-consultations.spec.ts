import { expect, test, type Page, type Route } from '@playwright/test';

/** WQ10b: admin consultation bookings and the one move of a no-show, against a mocked backend (Q14 rules mirrored). */
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
  /** The next move finds its slot just taken. */
  takeNext?: boolean;
}

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
      booking(BK1, { status: 'no_show', noShow: { at: '2026-11-19T05:15:00.000Z' } }),
      booking(BK2, { status: 'no_show', bookingKind: 'instant', bookingDate: '20261118', noShow: { at: '2026-11-18T05:15:00.000Z' } }),
      booking(BK3, { status: 'no_show', specialistId: DOC2, doctorName: 'Dr Kiran Rao', consultationMode: 'in-person', settlementSystem: 'clinic', paymentStatus: 'pending',
        clinicDesk: { partnerId: 'a2'.repeat(12), branchId: 'c1'.repeat(12) }, bookingDate: '20261117' }),
      booking(BK4, { bookingDate: '20261121', noShowReschedules: 1,
        noShows: [{ at: '2026-11-16T05:15:00.000Z', rescheduledAt: '2026-11-16T06:00:00.000Z', fromDate: '20261116', fromTime: '10:00', toSlotId: S3 }] }),
      booking(BK5, { status: 'completed', specialistId: DOC2, doctorName: 'Dr Kiran Rao', bookingDate: '20261110' }),
      booking(BK6, { status: 'no_show', bookingDate: '20261114', noShow: { at: '2026-11-14T05:15:00.000Z' }, noShowReschedules: 1,
        noShows: [{ at: '2026-11-12T05:15:00.000Z', rescheduledAt: '2026-11-12T06:00:00.000Z', fromDate: '20261112', fromTime: '09:00', toSlotId: '56'.repeat(12) }] }),
    ],
    slots: [
      slot(S_STARTED, '20261120', '09:00', '09:30'),
      slot(S1, '20261120', '11:00', '11:30'),
      slot(S2, '20261120', '11:30', '12:00'),
      slot(S_CLINIC, '20261120', '12:00', '12:30', { branchId: 'c1'.repeat(12), serviceModes: [] }),
      slot(S3, '20261121', '10:00', '10:30'),
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
      if (status && !['pending', 'confirmed', 'completed', 'cancelled'].includes(status)) return fail(route, 400, 'VALIDATION_ERROR', 'Status must be one of: pending, confirmed, completed, cancelled');
      const all = b.bookings.filter((x) => (!q.get('bookingType') || x.bookingType === q.get('bookingType')) && (!status || x.status === status)
        && (!q.get('specialistId') || x.specialistId === q.get('specialistId'))
        && (!q.get('bookingDateFrom') || String(x.bookingDate) >= q.get('bookingDateFrom')!) && (!q.get('bookingDateTo') || String(x.bookingDate) <= q.get('bookingDateTo')!))
        .sort((x, y) => String(y.bookingDate).localeCompare(String(x.bookingDate)));
      const limit = Number(q.get('limit') ?? 10);
      const pg = Number(q.get('page') ?? 1);
      return json(route, 200, { success: true, data: all.slice((pg - 1) * limit, pg * limit), pagination: { page: pg, limit, total: all.length, totalPages: Math.ceil(all.length / limit) } });
    }
    const one = /^\/bookings\/([0-9a-f]{24})$/.exec(path);
    if (one && method === 'GET') {
      const bk = b.bookings.find((x) => x._id === one[1]);
      return bk ? ok(route, bk) : fail(route, 404, 'BOOKING_NOT_FOUND', 'Booking not found');
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
      return ok(route, b.slots.filter((s) => s.specialistId === q.get('specialistId') && s.date === q.get('date') && (s.currentBookings as number) < (s.maxBookings as number)
        && (!mode || !(s.serviceModes as string[]).length || (s.serviceModes as string[]).includes(mode))));
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

test('consultations: filtered by status, doctor and appointment dates as the server takes them; no-shows are marked', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Consultations' }).click();
  await expect(page.getByText('6 consultations')).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Thu, 19 Nov' })).toContainText('No-show');
  await expect(page.getByRole('row').filter({ hasText: 'Sat, 21 Nov' })).toContainText('Moved after a no-show');
  await expect(page.getByRole('row').filter({ hasText: 'Tue, 17 Nov' })).toContainText('Clinic front desk');
  // The server's status filter does not take no-shows: none is offered.
  await expect(page.getByLabel('Status').locator('option')).toHaveText(['Any status (no-shows included)', 'Waiting', 'Confirmed', 'Completed', 'Cancelled']);
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
  await expect(form.getByLabel('New time').locator('option')).toHaveText(['Choose a time', '11:00–11:30', '11:30–12:00']);
  await form.getByRole('button', { name: 'Continue' }).click();
  await expect(form.getByText('Choose the new time.')).toBeVisible();
  await form.getByLabel('New time').selectOption({ label: '11:00–11:30' });
  await form.getByRole('button', { name: 'Continue' }).click();
  await expect(form).toContainText('Move The patient’s missed time (Thu, 19 Nov, 2026, 10:00) to');
  await expect(form).toContainText('nothing is paid or refunded');
  await expect(form).toContainText('This can be done only once');
  await form.getByRole('button', { name: /^Move to/ }).click();
  await expect(page.getByText(/The patient’s no-show is moved to .*11:00\. It is booked again at the same price\./)).toBeVisible();
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

test('a lost move answer: the booking read again settles it; one lost before the server is sent again with the same key, once', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await page.goto(`/#/admin/consultations/${BK1}`);
  backend.loseBefore = true;
  const form = await chooseTime(page, '11:30–12:00');
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
  const f2 = await chooseTime(page, '11:00–11:30');
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
  const form = await chooseTime(page, '11:00–11:30');
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
  const form = await chooseTime(page, '11:00–11:30');
  await form.getByRole('button', { name: /^Move to/ }).click();
  await expect(page.getByText('Not moved: That time is no longer free. Pick another time.')).toBeVisible();
  const again = page.getByRole('form', { name: 'Reschedule no-show' });
  await expect(again.getByLabel('New time').locator('option')).toHaveText(['Choose a time', '11:30–12:00']);
  await again.getByLabel('New time').selectOption({ label: '11:30–12:00' });
  await again.getByRole('button', { name: 'Continue' }).click();
  await again.getByRole('button', { name: /^Move to/ }).click();
  await expect(page.getByText(/no-show is moved to .*11:30/)).toBeVisible();
  const sent = moves(backend);
  expect(sent.map((c) => (c.body as Rec).slotId)).toEqual([S1, S2]);
  expect((sent[1]!.body as Rec).requestKey).not.toBe((sent[0]!.body as Rec).requestKey); // a refused first attempt: a new request
});
