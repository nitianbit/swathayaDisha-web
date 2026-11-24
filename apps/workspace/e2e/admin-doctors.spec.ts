import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * WQ18: admin doctors (verify with the S5 fence, unverify) and the S5c "close and refund" of a consultation, against a
 * mocked backend mirroring `specialists/verification.ts` (fence: trimmed name / registration number, only when the doctor
 * is not verified yet) and `bookings/adminClose.ts` (once per (admin, requestKey), replayed; ALREADY_CANCELLED; the
 * booking version fence; the closes read).
 */
const ADMIN = 'ad'.repeat(12);
const PHARMACY = 'ab'.repeat(12);
const DOC1 = 'd1'.repeat(12);
const DOC2 = 'd2'.repeat(12);
const DOC3 = 'd3'.repeat(12);
const BK1 = 'e1'.repeat(12);
const BK2 = 'e2'.repeat(12);
const BK3 = 'e3'.repeat(12);
const BK4 = 'e4'.repeat(12);
const BK5 = 'e5'.repeat(12);
const NOW = new Date('2026-11-25T04:30:00.000Z'); // Wed 25 Nov 2026, 10:00 in India
const V0 = '2026-11-20T06:00:00.000Z';
const V1 = '2026-11-25T04:31:00.000Z';

type Rec = Record<string, unknown>;
interface Backend {
  calls: { method: string; path: string; body: unknown }[];
  doctors: Rec[];
  bookings: Rec[];
  closes: Rec[];
  /** The next PUT /specialists/:id first finds the doctor renamed (the doctor edited their profile meanwhile). */
  renameOnNextPut?: string;
  /** The next PUT /specialists/:id is made, then its answer is lost. */
  losePutAfter?: boolean;
  /** The next PUT /specialists/:id is lost before it reaches the server. */
  losePutBefore?: boolean;
  /** The next close is made, then its answer is lost. */
  loseCloseAfter?: boolean;
  /** The next close finds the booking cancelled by another admin just before. */
  cancelledElsewhere?: boolean;
}

const doctor = (id: string, o: Rec): Rec => ({
  _id: id, name: 'Dr Asha Mehta', specialization: 'Cardiology', degree: 'MD', medicalRegistrationNumber: 'MCI-123', phone: '9000000020',
  email: 'asha@example.test', city: 'Pune', experienceYears: 12, consultationFee: 800, isActive: true, isVerified: false,
  documents: [{ type: 'medical-registration-certificate', fileName: 'reg.pdf', status: 'uploaded' }],
  createdAt: '2026-11-18T05:00:00.000Z', updatedAt: V0, ...o,
});
const booking = (id: string, o: Rec): Rec => ({
  _id: id, bookingType: 'consultation', bookingKind: 'scheduled', userId: 'u1'.repeat(12), specialistId: DOC2, doctorName: 'Dr Kiran Rao',
  patientName: 'Ravi Kumar', consultationMode: 'video', bookingDate: '20261126', bookingTime: '10:00', status: 'confirmed', paymentStatus: 'paid',
  price: 800, createdAt: '2026-11-15T05:00:00.000Z', updatedAt: V0, ...o,
});
const norm = (v: unknown) => (v == null ? '' : String(v).trim());

async function mockBackend(page: Page): Promise<Backend> {
  await page.clock.setSystemTime(NOW);
  const b: Backend = {
    calls: [],
    doctors: [
      doctor(DOC1, {}),
      doctor(DOC2, { name: 'Dr Kiran Rao', specialization: 'General', medicalRegistrationNumber: 'MCI-777', isVerified: false, createdAt: '2026-11-10T05:00:00.000Z' }),
      doctor(DOC3, { name: 'Dr Meera Iyer', specialization: 'Dermatology', medicalRegistrationNumber: 'MCI-555', isVerified: true, createdAt: '2026-11-01T05:00:00.000Z' }),
    ],
    bookings: [
      booking(BK1, {}),
      booking(BK2, { status: 'pending', paymentStatus: 'pending', bookingDate: '20261127', patientName: 'Meena Kumar' }),
      booking(BK3, { specialistId: DOC3, doctorName: 'Dr Meera Iyer' }),
      booking(BK4, { bookingDate: '20261128', bookingTime: '11:00' }),
      // Phase 1b: booked by a pharmacy and paid by card: an admin close queues the refund back to that card.
      booking(BK5, { bookingDate: '20261129', bookingTime: '12:00', price: 600, assisted: { funding: { method: 'razorpay', state: 'captured' } } }),
    ],
    closes: [],
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
    if (path === '/auth/admin/send' || path === '/auth/pharmacy/send') return ok(route, undefined);
    if (path === '/auth/admin/verify') return ok(route, { token: 'admin', expiresIn: 900, user: {} });
    if (path === '/auth/pharmacy/verify') return ok(route, { token: 'pharmacy', expiresIn: 900, user: {} });
    const auth = req.headers().authorization;
    if (auth !== 'Bearer admin' && auth !== 'Bearer pharmacy') return fail(route, 401, 'UNAUTHORIZED', 'Authentication is required');
    const isAdmin = auth === 'Bearer admin';
    if (path === '/auth/profile') {
      return ok(route, isAdmin ? { user: { _id: ADMIN, name: 'Ops Admin' }, userRole: 'admin' } : { user: { _id: PHARMACY, name: 'Asha Medicals' }, userRole: 'pharmacy' });
    }

    if (path === '/specialists' && method === 'GET') {
      const q = url.searchParams;
      const name = (q.get('name') ?? '').toLowerCase();
      // Admins see every doctor; anyone else only verified, active ones (applyUserFacingVisibility).
      const all = b.doctors.filter((d) => (isAdmin || (d.isVerified === true && d.isActive === true))
        && String(d.name).toLowerCase().includes(name)
        && (!q.get('isVerified') || d.isVerified === (q.get('isVerified') === 'true'))
        && (!q.get('isActive') || d.isActive === (q.get('isActive') === 'true')))
        .sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)));
      const limit = Number(q.get('limit') ?? 10);
      const pg = Number(q.get('page') ?? 1);
      return json(route, 200, { success: true, data: all.slice((pg - 1) * limit, pg * limit), pagination: { page: pg, limit, total: all.length, totalPages: Math.ceil(all.length / limit) } });
    }
    const sp = /^\/specialists\/([0-9a-f]{24})$/.exec(path);
    if (sp && method === 'GET') {
      const d = b.doctors.find((x) => x._id === sp[1]);
      return d && (isAdmin || d.isVerified) ? ok(route, d) : fail(route, 404, 'SPECIALIST_NOT_FOUND', 'Specialist not found');
    }
    if (sp && method === 'PUT') {
      if (!isAdmin) return fail(route, 403, 'FORBIDDEN', 'Admin access is required');
      if (b.losePutBefore) { b.losePutBefore = false; return route.abort('failed'); }
      const d = b.doctors.find((x) => x._id === sp[1]);
      if (!d) return fail(route, 404, 'SPECIALIST_NOT_FOUND', 'Specialist not found');
      if (b.renameOnNextPut) { d.name = b.renameOnNextPut; d.updatedAt = '2026-11-25T04:20:00.000Z'; b.renameOnNextPut = undefined; }
      const x = { ...(body as Rec) };
      const fence = { name: x.expectedName, reg: x.expectedRegistrationNumber };
      delete x.expectedName; delete x.expectedRegistrationNumber;
      if (x.isVerified === true && d.isVerified !== true) {
        if (fence.name !== undefined && norm(fence.name) !== norm(d.name)) return fail(route, 409, 'SPECIALIST_CHANGED_SINCE_REVIEW', "The doctor's profile changed since you reviewed it; reload it and review it again");
        if (fence.reg !== undefined && norm(fence.reg) !== norm(d.medicalRegistrationNumber)) return fail(route, 409, 'SPECIALIST_CHANGED_SINCE_REVIEW', "The doctor's profile changed since you reviewed it; reload it and review it again");
      }
      Object.assign(d, x, { updatedAt: V1 });
      if (b.losePutAfter) { b.losePutAfter = false; return route.abort('failed'); }
      return ok(route, d);
    }

    if (path === '/bookings' && method === 'GET') {
      const q = url.searchParams;
      const all = b.bookings.filter((x) => x.bookingType === q.get('bookingType') && (!q.get('status') || x.status === q.get('status'))
        && (!q.get('specialistId') || x.specialistId === q.get('specialistId')));
      return json(route, 200, { success: true, data: all, pagination: { page: 1, limit: 20, total: all.length, totalPages: 1 } });
    }
    const one = /^\/bookings\/([0-9a-f]{24})$/.exec(path);
    if (one && method === 'GET') {
      const bk = b.bookings.find((x) => x._id === one[1]);
      return bk ? ok(route, bk) : fail(route, 404, 'BOOKING_NOT_FOUND', 'Booking not found');
    }
    const cl = /^\/specialists\/admin\/bookings\/([0-9a-f]{24})\/close$/.exec(path);
    if (cl && !isAdmin) return fail(route, 403, 'FORBIDDEN', 'Admin access is required');
    if (cl && method === 'GET') return ok(route, b.closes.filter((c) => c.bookingId === cl[1]));
    if (cl && method === 'POST') {
      const x = body as { reason?: string; requestKey?: string; expectedUpdatedAt?: string };
      if (typeof x.reason !== 'string' || x.reason.trim().length < 3 || x.reason.trim().length > 500 || !/^[A-Za-z0-9_-]{8,100}$/.test(String(x.requestKey))) {
        return fail(route, 400, 'VALIDATION_ERROR', '"reason" and "requestKey" are required');
      }
      const prior = b.closes.find((c) => c.requestKey === x.requestKey);
      const bk = b.bookings.find((y) => y._id === cl[1]);
      if (prior) {
        if (prior.bookingId !== cl[1] || prior.reason !== x.reason.trim()) return fail(route, 409, 'REQUEST_KEY_REUSED', 'This request key was used for another close; send a new request key');
        return ok(route, { ...bk, replayed: true, refunded: prior.refunded, close: prior });
      }
      if (!bk) return fail(route, 404, 'BOOKING_NOT_FOUND', 'Booking not found');
      if (b.cancelledElsewhere) { b.cancelledElsewhere = false; Object.assign(bk, { status: 'cancelled', paymentStatus: 'refunded', cancellationReason: 'Cancelled by the patient', updatedAt: V1 }); }
      if (bk.bookingKind === 'instant') return fail(route, 409, 'USE_INSTANT_ADMIN_CANCEL', 'Cancel an instant consultation with its admin cancel');
      if (bk.status === 'cancelled') return fail(route, 409, 'ALREADY_CANCELLED', 'This booking is already cancelled');
      if (!['pending', 'confirmed'].includes(String(bk.status))) return fail(route, 409, 'BOOKING_NOT_CANCELLABLE', `A ${bk.status} booking cannot be cancelled`);
      if (x.expectedUpdatedAt && new Date(x.expectedUpdatedAt).getTime() !== new Date(String(bk.updatedAt)).getTime()) {
        return fail(route, 409, 'BOOKING_CHANGED', 'The appointment changed since it was loaded; reload and try again');
      }
      const refunded = bk.paymentStatus === 'paid' ? Number(bk.price) : 0;
      const row = { auditId: `${String(b.closes.length + 1).padStart(2, '0')}`.repeat(12), bookingId: bk._id, adminId: ADMIN, requestKey: x.requestKey, reason: x.reason.trim(),
        statusBefore: bk.status, paymentStatusBefore: bk.paymentStatus, refunded, closedAt: NOW.toISOString() };
      b.closes.push(row);
      Object.assign(bk, { status: 'cancelled', paymentStatus: 'refunded', cancellationReason: 'Cancelled by Jansetu', updatedAt: V1 });
      if (b.loseCloseAfter) { b.loseCloseAfter = false; return route.abort('failed'); }
      return ok(route, { ...bk, replayed: false, refunded, close: row });
    }
    return fail(route, 404, 'NOT_FOUND', 'Not found');
  });
  return b;
}

async function signIn(page: Page, as: 'Admin' | 'Pharmacy' = 'Admin') {
  await page.goto('/');
  if (as === 'Admin') await page.getByLabel('Admin').check();
  await page.getByLabel('Mobile number').fill('9876543210');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

const puts = (b: Backend) => b.calls.filter((c) => c.method === 'PUT').map((c) => ({ path: c.path, body: c.body }));
const closesSent = (b: Backend) => b.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/close'));
const stored = (page: Page) => page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + location.href);

test('doctors: every doctor for an admin, filtered as the server takes them; verify sends the reviewed name and number as the fence', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Doctors' }).click();
  await expect(page.getByRole('heading', { name: 'Doctors', level: 1 })).toBeVisible();
  await expect(page.getByText('3 doctors')).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Dr Asha Mehta' })).toContainText('Not verified');
  await expect(page.getByRole('row').filter({ hasText: 'Dr Meera Iyer' })).toContainText('Verified');
  await page.getByLabel('Verification').selectOption('false');
  await expect(page.getByText('2 doctors')).toBeVisible();
  await page.getByLabel('Search by name').fill('asha');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByText('1 doctor', { exact: true })).toBeVisible();
  expect(backend.calls.filter((c) => c.path.startsWith('/specialists?')).map((c) => c.path)).toEqual([
    '/specialists?sortBy=createdAt&sortOrder=desc&page=1&limit=20',
    '/specialists?isVerified=false&sortBy=createdAt&sortOrder=desc&page=1&limit=20',
    '/specialists?name=asha&isVerified=false&sortBy=createdAt&sortOrder=desc&page=1&limit=20',
  ]);
  // The name searched is never put in the address.
  expect(page.url()).not.toContain('asha');

  await page.getByRole('link', { name: 'Dr Asha Mehta' }).click();
  await expect(page.getByRole('heading', { name: 'Dr Asha Mehta', level: 1 })).toBeVisible();
  const section = page.getByRole('region', { name: 'Verification' });
  await expect(section).toContainText('MCI-123');
  await section.getByRole('button', { name: 'Verify', exact: true }).click();
  const confirm = section.getByRole('group', { name: 'Verify' });
  await expect(confirm).toContainText('Name: Dr Asha Mehta');
  await expect(confirm).toContainText('Registration number: MCI-123');
  await confirm.getByRole('button', { name: 'Verify Dr Asha Mehta' }).click();
  await expect(section.getByText('Dr Asha Mehta is verified. Patients can now find and book them.')).toBeVisible();
  await expect(section.getByRole('button', { name: 'Unverify' })).toBeVisible();
  expect(puts(backend)).toEqual([{ path: `/specialists/${DOC1}`, body: { isVerified: true, expectedName: 'Dr Asha Mehta', expectedRegistrationNumber: 'MCI-123' } }]);
  expect(await stored(page)).not.toContain('MCI-123');
});

test('a fence mismatch: nothing is verified, the doctor is read again and what was reviewed is shown next to what is saved now', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await page.goto(`/#/admin/doctors/${DOC1}`);
  const section = page.getByRole('region', { name: 'Verification' });
  await expect(section).toContainText('Dr Asha Mehta');
  backend.renameOnNextPut = 'Dr A. Mehta';
  await section.getByRole('button', { name: 'Verify', exact: true }).click();
  await section.getByRole('button', { name: 'Verify Dr Asha Mehta' }).click();
  await expect(section.getByText('Dr Asha Mehta was not verified', { exact: false })).toBeVisible();
  const changed = section.getByRole('group', { name: 'What changed' });
  await expect(changed).toContainText('You reviewed: name Dr Asha Mehta, registration number MCI-123.');
  await expect(changed).toContainText('Saved now: name Dr A. Mehta, registration number MCI-123.');
  await expect(page.getByRole('heading', { name: 'Dr A. Mehta', level: 1 })).toBeVisible();
  await expect(section.getByText('Not verified', { exact: true })).toBeVisible();
  // Reviewed again: the new name is what is sent now.
  await section.getByRole('button', { name: 'Verify', exact: true }).click();
  await expect(section.getByRole('group', { name: 'Verify' })).toContainText('Name: Dr A. Mehta');
  await section.getByRole('button', { name: 'Verify Dr A. Mehta' }).click();
  await expect(section.getByText('Dr A. Mehta is verified.', { exact: false })).toBeVisible();
  expect(puts(backend).map((p) => p.body)).toEqual([
    { isVerified: true, expectedName: 'Dr Asha Mehta', expectedRegistrationNumber: 'MCI-123' },
    { isVerified: true, expectedName: 'Dr A. Mehta', expectedRegistrationNumber: 'MCI-123' },
  ]);
});

test('a verify whose answer is lost is checked by reading the doctor; unverify is confirmed and sends no fence', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await page.goto(`/#/admin/doctors/${DOC1}`);
  const section = page.getByRole('region', { name: 'Verification' });
  backend.losePutAfter = true;
  await section.getByRole('button', { name: 'Verify', exact: true }).click();
  await section.getByRole('button', { name: 'Verify Dr Asha Mehta' }).click();
  const panel = section.getByRole('group', { name: 'Unconfirmed change' });
  await expect(panel).toContainText('The outcome of this request is not known yet');
  await expect(panel.getByRole('button', { name: 'Send the same request again' })).toBeVisible();
  // Only a body-less marker is kept across a reload: no name or registration number in storage or the address.
  expect(await stored(page)).not.toContain('Mehta');
  await panel.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(section.getByText('Dr Asha Mehta is verified.', { exact: false })).toBeVisible();
  await expect(section.getByRole('group', { name: 'Unconfirmed change' })).toHaveCount(0);

  await section.getByRole('button', { name: 'Unverify' }).click();
  await expect(section.getByRole('group', { name: 'Unverify' })).toContainText('Their bookings stay as they are');
  await section.getByRole('button', { name: 'Unverify Dr Asha Mehta' }).click();
  await expect(section.getByText('Dr Asha Mehta is no longer verified', { exact: false })).toBeVisible();
  await expect(section.getByRole('button', { name: 'Verify', exact: true })).toBeVisible();
  expect(puts(backend).map((p) => p.body)).toEqual([
    { isVerified: true, expectedName: 'Dr Asha Mehta', expectedRegistrationNumber: 'MCI-123' },
    { isVerified: false },
  ]);
});

test('close and refund: an unverified doctor’s consultations open from the doctor page; one is closed with a reason, a key and the version read', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await page.goto(`/#/admin/doctors/${DOC2}`);
  await expect(page.getByText('this doctor cannot attend them', { exact: false })).toBeVisible();
  // The doctor's open consultations are the Consultations list, filtered by doctor and status.
  await page.getByRole('link', { name: 'Confirmed', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Consultations', level: 1 })).toBeVisible();
  await expect(page.getByLabel('Status')).toHaveValue('confirmed');
  await page.getByRole('link', { name: 'Thu, 26 Nov, 2026, 10:00' }).click();
  await expect(page.getByRole('heading', { name: 'Consultation on Thu, 26 Nov, 2026, 10:00' })).toBeVisible();
  const section = page.getByRole('region', { name: 'Close and refund' });
  await expect(section).toContainText('Not verified');
  await section.getByRole('button', { name: 'Close and refund' }).click();
  const confirm = section.getByRole('group', { name: 'Close and refund' });
  await expect(confirm).toContainText('Close the appointment on Thu, 26 Nov, 2026, 10:00 with Dr Kiran Rao and refund it in full?');
  await expect(confirm).toContainText('Your reason is not shown to them.');
  await confirm.getByLabel('Reason (only the Jansetu team sees it)').fill('ab');
  await confirm.getByRole('button', { name: 'Yes, close and refund' }).click();
  await expect(confirm.getByText('Give a reason (at least 3 characters).')).toBeVisible();
  await confirm.getByLabel('Reason (only the Jansetu team sees it)').fill('  Doctor left Jansetu ');
  await confirm.getByRole('button', { name: 'Yes, close and refund' }).click();
  await expect(section.getByText('Closed: the appointment on Thu, 26 Nov, 2026, 10:00 is cancelled. ₹800.00 was refunded to the patient’s Jansetu wallet.', { exact: false })).toBeVisible();
  await expect(section.getByRole('list', { name: 'Closes by the Jansetu team' })).toContainText('Reason (internal): Doctor left Jansetu');
  await expect(page.getByRole('region', { name: 'Booking' })).toContainText('Cancelled');
  const sent = closesSent(backend);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.path).toBe(`/specialists/admin/bookings/${BK1}/close`);
  expect(sent[0]!.body).toMatchObject({ reason: 'Doctor left Jansetu', expectedUpdatedAt: V0 });
  expect(String((sent[0]!.body as Rec).requestKey)).toMatch(/^[A-Za-z0-9]{32}$/);
  // Nothing about the patient in storage or the address.
  expect(await stored(page)).not.toContain('Ravi');
});

test('a lost close answer: the check finds this key’s close; another lost one is sent again with the same key and answered once', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await page.goto(`/#/admin/consultations/${BK1}`);
  let section = page.getByRole('region', { name: 'Close and refund' });
  backend.loseCloseAfter = true;
  await section.getByRole('button', { name: 'Close and refund' }).click();
  await section.getByLabel('Reason (only the Jansetu team sees it)').fill('Doctor left');
  await section.getByRole('button', { name: 'Yes, close and refund' }).click();
  await expect(section.getByRole('group', { name: 'Unconfirmed close' })).toContainText('may already be closed and refunded');
  await section.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(section.getByText('It was closed: the appointment on Thu, 26 Nov, 2026, 10:00 is cancelled. ₹800.00 was refunded', { exact: false })).toBeVisible();

  await page.goto(`/#/admin/consultations/${BK4}`);
  section = page.getByRole('region', { name: 'Close and refund' });
  backend.loseCloseAfter = true;
  await section.getByRole('button', { name: 'Close and refund' }).click();
  await section.getByLabel('Reason (only the Jansetu team sees it)').fill('Doctor left');
  await section.getByRole('button', { name: 'Yes, close and refund' }).click();
  await section.getByRole('button', { name: 'Send the same request again' }).click();
  await expect(section.getByText('This close was already recorded: the appointment on Sat, 28 Nov, 2026, 11:00 is cancelled. ₹800.00 was refunded', { exact: false })).toBeVisible();
  await expect(section.getByText('Nothing more was changed.', { exact: false })).toBeVisible();
  const sent = closesSent(backend).filter((c) => c.path.includes(BK4));
  expect(sent).toHaveLength(2);
  expect(sent[1]!.body).toEqual(sent[0]!.body);
  expect(backend.closes.filter((c) => c.bookingId === BK4)).toHaveLength(1);
});

test('close refusals: a changed booking and one cancelled another way are said in words; a verified doctor’s booking offers no close', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await page.goto(`/#/admin/consultations/${BK1}`);
  const section = page.getByRole('region', { name: 'Close and refund' });
  await section.getByRole('button', { name: 'Close and refund' }).click();
  await section.getByLabel('Reason (only the Jansetu team sees it)').fill('Doctor left');
  // The booking changes on the server while the confirmation is open.
  backend.bookings.find((x) => x._id === BK1)!.updatedAt = '2026-11-25T04:25:00.000Z';
  await section.getByRole('button', { name: 'Yes, close and refund' }).click();
  await expect(section.getByText('Not closed: The booking changed since you read it, so nothing was done.', { exact: false })).toBeVisible();
  await expect(section.getByRole('button', { name: 'Close and refund' })).toBeVisible();

  backend.cancelledElsewhere = true;
  await section.getByRole('button', { name: 'Close and refund' }).click();
  await section.getByLabel('Reason (only the Jansetu team sees it)').fill('Doctor left');
  await section.getByRole('button', { name: 'Yes, close and refund' }).click();
  await expect(section.getByText('Not closed by this request: This booking is already cancelled, so nothing more was done.', { exact: false })).toBeVisible();
  await expect(section.getByText('Cancelled, but not with Close and refund.')).toBeVisible();
  expect(backend.closes).toHaveLength(0);

  await page.goto(`/#/admin/consultations/${BK3}`);
  const verified = page.getByRole('region', { name: 'Close and refund' });
  await expect(verified).toContainText('Its doctor is verified and active, so it is not closed here.');
  await expect(verified.getByRole('button', { name: 'Close and refund' })).toHaveCount(0);
});

test('a non-admin cannot reach the doctor pages or close a booking', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page, 'Pharmacy');
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Doctors' })).toHaveCount(0);
  await page.goto('/#/admin/doctors');
  await expect(page.getByText('Page not found')).toBeVisible();
  await page.goto(`/#/admin/doctors/${DOC1}`);
  await expect(page.getByText('Page not found')).toBeVisible();
  await page.goto(`/#/admin/consultations/${BK1}`);
  await expect(page.getByText('Page not found')).toBeVisible();
  expect(backend.calls.filter((c) => c.path.startsWith('/specialists') || c.path.startsWith('/bookings'))).toEqual([]);
});

test('WQ18b: a resend refused for a fence mismatch is final (settled, read again); a doctor with no name is not offered Verify', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await page.goto(`/#/admin/doctors/${DOC1}`);
  const section = page.getByRole('region', { name: 'Verification' });
  backend.losePutBefore = true;
  await section.getByRole('button', { name: 'Verify', exact: true }).click();
  await section.getByRole('button', { name: 'Verify Dr Asha Mehta' }).click();
  await expect(section.getByRole('group', { name: 'Unconfirmed change' })).toBeVisible();
  backend.renameOnNextPut = 'Dr A. Mehta';
  await section.getByRole('button', { name: 'Send the same request again' }).click();
  await expect(section.getByText('Dr Asha Mehta was not verified', { exact: false })).toBeVisible();
  await expect(section.getByRole('group', { name: 'What changed' })).toContainText('Saved now: name Dr A. Mehta');
  await expect(section.getByRole('group', { name: 'Unconfirmed change' })).toHaveCount(0);
  expect(puts(backend)).toHaveLength(2);

  backend.doctors.find((d) => d._id === DOC2)!.name = '  ';
  await page.goto(`/#/admin/doctors/${DOC2}`);
  const unnamed = page.getByRole('region', { name: 'Verification' });
  await expect(unnamed.getByText('No name is on record, so this doctor cannot be verified until they add one.')).toBeVisible();
  await expect(unnamed.getByRole('button', { name: 'Verify', exact: true })).toHaveCount(0);
  expect(puts(backend)).toHaveLength(2);
});

test('WQ18b: closing a pharmacy booking paid by card says the refund is on its way to that card', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await page.goto(`/#/admin/consultations/${BK5}`);
  const section = page.getByRole('region', { name: 'Close and refund' });
  await section.getByRole('button', { name: 'Close and refund' }).click();
  await section.getByLabel('Reason (only the Jansetu team sees it)').fill('Doctor left');
  await section.getByRole('button', { name: 'Yes, close and refund' }).click();
  await expect(section.getByText('₹600.00 is being refunded to the card or UPI the pharmacy paid with.', { exact: false }).first()).toBeVisible();
  await expect(section.getByRole('list', { name: 'Closes by the Jansetu team' })).toContainText('is being refunded to the card or UPI the pharmacy paid with.');
  expect(closesSent(backend)).toHaveLength(1);
});
