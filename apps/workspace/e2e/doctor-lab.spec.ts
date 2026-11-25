import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * WQ25: a doctor books a lab test for a patient (assisted booking round 3b, backend r26, design §25.15) on the pharmacy's
 * Book lab test and Booked lab tests screens, paid from the doctor wallet: from one of its consultations or for a walk-in,
 * the treating window closed, low balance, a lost answer, cancel, a new time, the report, an unverified doctor and another
 * doctor's booking. Mocked API; amounts in paise.
 */
const DOC = 'd1'.repeat(12);
const LAB = 'a1'.repeat(12);
const BR = 'b1'.repeat(12);
const BR2 = 'b2'.repeat(12);
const SLOT = '51'.repeat(12);
const T1 = 'c1'.repeat(12);
const T2 = 'c2'.repeat(12);
const BK = 'e1'.repeat(12);
const OTHER = 'e9'.repeat(12);
const CONSULT = 'c7'.repeat(12);
const LATER = 'c8'.repeat(12);
const PHONE = '9876543210';
const NOW = new Date('2026-11-25T04:30:00.000Z'); // 10:00 in India
const TOMORROW = '2026-11-26';
const STARTS = '2026-11-26T03:30:00.000Z'; // 09:00 in India

type Json = Record<string, unknown>;
const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const ok = (route: Route, data: unknown, status = 200, extra: Json = {}) => json(route, status, { success: true, data, ...extra });
const refuse = (route: Route, status: number, code: string, message = 'refused', extra: Json = {}) => json(route, status, { error: status, code, message, ...extra });

interface Backend {
  calls: { method: string; path: string; body: Json | null }[];
  creates: Json[];
  cancels: Json[];
  accepts: Json[];
  keys: Record<string, string>;
  bookings: Json[];
  walletPaise: number;
  eligible: boolean;
  windowClosed: boolean;
  loseNextCreateAnswer: boolean;
}

const labView = (o: Json = {}): Json => ({
  _id: BK, source: 'doctor_assisted', partnerId: LAB, lab: { name: 'Sun Diagnostics' }, branchId: BR, branch: { name: 'Kothrud', address: '12 FC Road, Pune', phone: '0201234567' },
  visitMode: 'lab', slot: { slotId: SLOT, date: TOMORROW, startTime: '09:00', endTime: '09:30', startsAt: STARTS },
  items: [{ name: 'Complete blood count', kind: 'test', code: 'CBC' }], status: 'confirmed', statusVersion: 3, reschedule: null, collector: null, cancellation: null,
  lifecycle: {}, patientName: 'Rina Kumari', holder: { linkId: 'f2'.repeat(12), name: 'Rina Kumari', typedName: 'Rina Kumari' }, userId: 'f1'.repeat(12),
  assisted: { shortRef: 'L7QXM2PA', bookedBy: { name: 'Dr Asha Mehta' }, preferredLanguage: 'hi' },
  report: { releases: [] }, createdAt: '2026-11-25T04:00:00.000Z', updatedAt: '2026-11-25T04:00:00.000Z', ...o,
});
const appointment = (o: Json = {}): Json => ({
  _id: CONSULT, bookingType: 'consultation', bookingKind: 'scheduled', bookingDate: '20261125', bookingTime: '09:30', consultationMode: 'video',
  primaryConcern: 'Fever', status: 'confirmed', paymentStatus: 'paid', price: 500, settlementSystem: 'ledger', updatedAt: '2026-11-25T03:00:00.000Z', ...o,
});

async function mockBackend(page: Page, init: { bookings?: Json[]; walletPaise?: number } = {}): Promise<Backend> {
  await page.clock.setFixedTime(NOW);
  const b: Backend = { calls: [], creates: [], cancels: [], accepts: [], keys: {}, bookings: init.bookings ?? [], walletPaise: init.walletPaise ?? 200_000,
    eligible: true, windowClosed: false, loseNextCreateAnswer: false };
  const profile = { _id: DOC, name: 'Dr Asha Mehta', specialization: 'Cardiology', phone: '9000000020', isActive: true, isVerified: true };
  let live = false;
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = req.method();
    const body = method === 'POST' ? (req.postDataJSON() as Json | null) : null;
    if (path === '/auth/session/refresh') {
      return live ? ok(route, { token: 't1', expiresIn: 900, principal: { userId: DOC, userType: 'specialist', sid: 's1' } }) : refuse(route, 401, 'SESSION_ENDED');
    }
    if (path.startsWith('/auth/session')) return ok(route, {});
    b.calls.push({ method, path: `${path}${url.search}`, body });
    if (path === '/auth/specialist/send') return ok(route, undefined);
    if (path === '/auth/specialist/verify') { live = true; return ok(route, { token: 't1', expiresIn: 900, user: {} }); }
    if (req.headers().authorization !== 'Bearer t1') return refuse(route, 401, 'UNAUTHORIZED');
    if (path === '/auth/profile') return ok(route, { user: profile, userRole: 'specialist' });

    // The doctor's own consultations (WQ4) and one of them (WQ25 reads its booking).
    if (path === '/specialists/me/appointments') {
      return ok(route, url.search === '?view=month&yearMonth=202611' ? [appointment(), appointment({ _id: LATER, bookingTime: '11:30', primaryConcern: 'Cough' })] : []);
    }
    if (path === `/specialists/me/appointments/${CONSULT}`) return ok(route, { booking: appointment(), patient: { name: 'Account Holder', phone: PHONE } });
    if (path === '/file/fetch') return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: '%PDF-1.4\n%%EOF\n' });

    const me = /^\/specialists\/me\/assisted(\/.*)$/.exec(path);
    if (!me) return refuse(route, 404, 'NOT_FOUND', `Not mocked: ${method} ${path}`);
    const sub = me[1]!;
    // r26: every route needs a verified, active doctor (reads included); r20: the wallet too.
    if (!b.eligible) return refuse(route, 403, 'SPECIALIST_NOT_VERIFIED', 'Your doctor account must be verified and active before you can do this');
    if (sub === '/wallet') return ok(route, { balanceMinor: b.walletPaise, withdrawableMinor: 0, receivableMinor: 0, frozen: false, isActive: true, updatedAt: NOW.toISOString() });
    if (sub === '/wallet/entries') return ok(route, [], 200, { pagination: { nextCursor: null } });
    if (sub === '/patients/lookup') return ok(route, { exists: true, holderNameMasked: 'Rina K.' });
    if (sub === '/labs') {
      return ok(route, [{ partnerId: LAB, name: 'Sun Diagnostics', nearby: 'pincode', branches: [
        { branchId: BR, name: 'Kothrud', address: '12 FC Road, Pune', phone: '0201234567', homeCollection: true, inLab: true },
        { branchId: BR2, name: 'Baner', address: '4 Baner Road, Pune', phone: '0207654321', homeCollection: false, inLab: true }] }]);
    }
    if (sub === `/labs/${LAB}/catalogue`) {
      return ok(route, [
        { itemId: T1, kind: 'test', name: 'Complete blood count', code: 'CBC', priceMinor: 30_000, price: 300, visitModes: ['lab', 'home'] },
        { itemId: T2, kind: 'test', name: 'Thyroid profile', code: 'TFT', priceMinor: 20_000, price: 200, visitModes: ['lab', 'home'] },
      ]);
    }
    if (sub === `/labs/branches/${BR}/slots`) return ok(route, [{ slotId: SLOT, date: TOMORROW, startTime: '09:00', endTime: '09:30', seatsLeft: 3 }]);
    if (sub === '/lab-bookings' && method === 'POST') {
      b.creates.push(body!);
      const key = String(body!.requestKey);
      const hash = JSON.stringify({ ...body, requestKey: undefined });
      const receipt = (replayed: boolean) => ({ booking: b.bookings.find((x) => x._id === BK),
        funding: { method: 'wallet', amountMinor: body!.acceptedPriceMinor, state: 'captured', walletEntryId: 'w9' },
        split: { listMinor: body!.acceptedPriceMinor, discountMinor: 0, couponCode: null }, newAccount: false, replayed });
      if (b.keys[key]) return b.keys[key] === hash ? ok(route, receipt(true)) : refuse(route, 409, 'IDEMPOTENCY_KEY_REUSED');
      if (body!.paymentMethod !== 'wallet') return refuse(route, 400, 'PAYMENT_METHOD_UNAVAILABLE', 'Lab tests you book are paid from your Jansetu wallet');
      if (body!.fromBookingId !== undefined) {
        if (body!.fromBookingId !== CONSULT) return refuse(route, 404, 'BOOKING_NOT_FOUND', 'Booking not found');
        if (b.windowClosed) return refuse(route, 409, 'TREATING_WINDOW_CLOSED', 'This consultation is no longer open for booking tests');
      }
      const ids = body!.itemIds as string[];
      const price = (ids.includes(T1) ? 30_000 : 0) + (ids.includes(T2) ? 20_000 : 0);
      if (body!.acceptedPriceMinor !== price) return refuse(route, 409, 'PRICE_CHANGED', 'The price changed', { details: { priceMinor: price } });
      if (b.walletPaise < price) return refuse(route, 409, 'INSUFFICIENT_BALANCE', 'Insufficient wallet balance');
      b.walletPaise -= price;
      b.keys[key] = hash;
      const typed = String(body!.typedName ?? (body!.patient as Json | undefined)?.name ?? '');
      b.bookings.unshift(labView({ patientName: typed, holder: { linkId: 'f2'.repeat(12), name: typed, typedName: typed } }));
      if (b.loseNextCreateAnswer) { b.loseNextCreateAnswer = false; return route.abort('connectionreset'); }
      return ok(route, receipt(false), 201);
    }
    const byKey = /^\/lab-bookings\/by-key\/([A-Za-z0-9_-]+)(\/abandon)?$/.exec(sub);
    if (byKey) return ok(route, b.keys[byKey[1]!] ? { state: 'used', booking: b.bookings.find((x) => x._id === BK) } : { state: 'unknown' });
    if (sub === '/lab-bookings') return ok(route, b.bookings, 200, { pagination: { total: b.bookings.length, nextCursor: null } });
    const one = /^\/lab-bookings\/(\w{24})$/.exec(sub);
    if (one) {
      const x = b.bookings.find((y) => y._id === one[1]);
      return x ? ok(route, x) : refuse(route, 404, 'LAB_BOOKING_NOT_FOUND', 'Lab booking not found');
    }
    const cancel = /^\/lab-bookings\/(\w{24})\/cancel$/.exec(sub);
    if (cancel) {
      b.cancels.push(body!);
      const x = b.bookings.find((y) => y._id === cancel[1])!;
      Object.assign(x, { status: 'cancelled', statusVersion: 4, cancellation: { byKind: 'booker', at: '2026-11-25T04:35:00.000Z' } });
      b.walletPaise += 30_000;
      return ok(route, { booking: x, refundedMinor: 30_000, alreadyCancelled: false });
    }
    const accept = /^\/lab-bookings\/(\w{24})\/accept-reschedule$/.exec(sub);
    if (accept) {
      b.accepts.push(body!);
      const x = b.bookings.find((y) => y._id === accept[1])!;
      Object.assign(x, { reschedule: { ...(x.reschedule as Json), pending: false }, statusVersion: 5 });
      return ok(route, x);
    }
    return refuse(route, 404, 'NOT_FOUND', `Not mocked: ${method} ${path}`);
  });
  return b;
}

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Doctor', { exact: true }).check();
  await page.getByLabel('Mobile number').fill('9000000020');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}
const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' });

/** From Appointments › "Book lab test for this patient": the name typed and the patient's agreement. */
async function fromConsultation(page: Page) {
  await nav(page).getByRole('link', { name: 'Appointments', exact: true }).click();
  const links = page.getByRole('link', { name: /^Book lab test for this patient/ });
  await expect(links).toHaveCount(1); // the 11:30 consultation has not started yet
  await links.click();
  await expect(page.getByRole('heading', { name: 'Book lab test', level: 1 })).toBeVisible();
  await expect(page.getByText(/From your consultation on .*, 09:30 \(Video\)\./)).toBeVisible();
  await page.getByLabel('Patient’s full name').fill('Rina Kumari');
  await page.getByLabel('Patient agreed to this booking').check();
  await page.getByRole('button', { name: 'Next: choose the lab' }).click();
}

async function walkIn(page: Page) {
  await nav(page).getByRole('link', { name: 'Book lab test', exact: true }).click();
  await page.getByLabel('Patient’s mobile number').fill(PHONE);
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(page.getByText('Account holder: Rina K.')).toBeVisible();
  await page.getByLabel('Patient’s full name').fill('Rina Kumari');
  await page.getByLabel('Patient agreed to this booking').check();
  await page.getByRole('button', { name: 'Next: choose the lab' }).click();
}

async function chooseAndReview(page: Page) {
  await expect(page.getByText('Near you')).toBeVisible();
  await page.getByRole('button', { name: 'Choose Sun Diagnostics' }).click();
  await page.getByLabel(/^Kothrud/).check();
  await page.getByLabel(/^Complete blood count/).check();
  await page.getByRole('button', { name: /09:00–09:30$/ }).click();
  await page.getByLabel('Language the patient speaks').selectOption('hi');
  await page.getByRole('button', { name: 'Next: check the price' }).click();
}

const nothingStored = async (page: Page, b: Backend, ...words: string[]) => {
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + location.href);
  for (const w of words) expect(stored).not.toContain(w);
  for (const c of b.calls) for (const w of words) expect(c.path).not.toContain(w);
};

test('from a consultation: Appointments › Book lab test for this patient, the typed name, paid from the doctor wallet; no phone sent', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await fromConsultation(page);
  await chooseAndReview(page);
  const pay = page.getByRole('group', { name: 'Check and pay' });
  await expect(pay.getByText('Money in your wallet: ₹2,000.00')).toBeVisible();
  await expect(pay.getByText('How do you pay?')).toHaveCount(0); // the wallet only (card is round 3c)
  await pay.getByRole('button', { name: 'Pay ₹300.00 from wallet' }).click();
  await expect(page.getByRole('heading', { name: 'Booked' })).toBeVisible();
  await expect(page.getByText('The lab test is booked and paid from your wallet.')).toBeVisible();
  await expect(page.getByText('Patient: Rina Kumari')).toBeVisible();
  expect(b.creates).toHaveLength(1);
  expect(b.creates[0]).toMatchObject({ fromBookingId: CONSULT, typedName: 'Rina Kumari', partnerId: LAB, branchId: BR, visitMode: 'lab', slotId: SLOT, itemIds: [T1],
    acceptedPriceMinor: 30_000, paymentMethod: 'wallet', consent: { agreed: true, statementVersion: 'web-doctor-lab-v1', statementLanguage: 'en' } });
  expect(b.creates[0]).not.toHaveProperty('phone');
  expect(b.creates[0]).not.toHaveProperty('patient');
  expect(b.calls.some((c) => c.path.endsWith('/patients/lookup'))).toBe(false); // nothing counted
  expect(b.calls.some((c) => c.path === '/specialists/me/assisted/labs?visitMode=lab&limit=50')).toBe(true);
  // The account name the appointment read carries is never shown.
  await expect(page.getByText('Account Holder')).toHaveCount(0);
  await nothingStored(page, b, 'Rina Kumari', PHONE, 'Account Holder');
});

test('a walk-in: the masked lookup by phone (in the body only), then the same steps; the nav lists both pages after Wallet', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  const labels = await nav(page).getByRole('link').allTextContents();
  expect(labels.slice(labels.indexOf('Wallet'))).toEqual(['Wallet', 'Book lab test', 'Lab tests booked']);
  await walkIn(page);
  await chooseAndReview(page);
  await page.getByRole('button', { name: 'Pay ₹300.00 from wallet' }).click();
  await expect(page.getByRole('heading', { name: 'Booked' })).toBeVisible();
  expect(b.calls.find((c) => c.path === '/specialists/me/assisted/patients/lookup')?.body).toEqual({ phone: PHONE });
  expect(b.creates[0]).toMatchObject({ phone: PHONE, patient: { relation: 'self', name: 'Rina Kumari' }, paymentMethod: 'wallet',
    consent: { statementVersion: 'web-doctor-lab-v1' } });
  expect(b.creates[0]).not.toHaveProperty('fromBookingId');
  await nothingStored(page, b, PHONE, 'Rina Kumari');
});

test('the treating window closed (409): said plainly, nothing booked; booking by mobile number is offered', async ({ page }) => {
  const b = await mockBackend(page);
  b.windowClosed = true;
  await signIn(page);
  await fromConsultation(page);
  await chooseAndReview(page);
  await page.getByRole('button', { name: 'Pay ₹300.00 from wallet' }).click();
  await expect(page.getByText('This consultation is not open for booking tests now (it is open while you treat the patient). Book for the patient by their mobile number instead.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Booked' })).toHaveCount(0);
  expect(b.creates).toHaveLength(1);
  expect(b.walletPaise).toBe(200_000);
  await page.getByRole('link', { name: 'Book for a patient by mobile number instead' }).click();
  await expect(page.getByLabel('Patient’s mobile number')).toBeVisible();
});

test('low balance: the shortfall is said, Pay is off, and "Add money" opens the doctor wallet', async ({ page }) => {
  const b = await mockBackend(page, { walletPaise: 10_000 });
  await signIn(page);
  await walkIn(page);
  await chooseAndReview(page);
  await expect(page.getByText('Your wallet needs ₹200.00 more for this booking.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pay ₹300.00 from wallet' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Top up now' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Add money' }).click();
  await expect(page.getByRole('heading', { name: 'Wallet', level: 1 })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Add money' })).toBeVisible();
  expect(b.creates).toHaveLength(0);
});

test('a lost answer and a reload: only the key is kept; Check finds the booking by key, never booked twice', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await fromConsultation(page);
  await chooseAndReview(page);
  b.loseNextCreateAnswer = true;
  await page.getByRole('button', { name: 'Pay ₹300.00 from wallet' }).click();
  await expect(page.getByText(/The outcome of this request is not known yet/)).toBeVisible();
  await page.reload();
  await expect(page.getByText(/A lab booking made earlier on this device .* was not confirmed/)).toBeVisible();
  await page.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(page.getByRole('heading', { name: 'Already booked' })).toBeVisible();
  await expect(page.getByText('L7QXM2PA')).toBeVisible();
  await expect(page.getByText('Patient: Rina Kumari')).toBeVisible();
  expect(b.creates).toHaveLength(1);
  const key = String(b.creates[0]!.requestKey);
  expect(b.calls.some((c) => c.path === `/specialists/me/assisted/lab-bookings/by-key/${key}`)).toBe(true);
  await nothingStored(page, b, 'Rina Kumari');
});

test('lab tests booked: list, open, cancel up to 1 hour before; the refund goes back to the doctor wallet', async ({ page }) => {
  const b = await mockBackend(page, { bookings: [labView()] });
  await signIn(page);
  await nav(page).getByRole('link', { name: 'Lab tests booked', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Lab tests booked', level: 1 })).toBeVisible();
  await expect(page.getByLabel('Status').locator('option', { hasText: 'Waiting for payment' })).toHaveCount(0); // never card-paid
  const table = page.getByRole('table', { name: 'Booked lab tests, newest first' });
  await table.getByRole('link', { name: /Open the lab test of Rina Kumari/ }).click();
  await expect(page.getByText('L7QXM2PA')).toBeVisible();
  await expect(page.getByText('The full amount goes back to your Jansetu wallet.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel this lab test' }).click();
  await page.getByRole('button', { name: 'Yes, cancel it' }).click();
  await expect(page.getByText('Cancelled. ₹300.00 is back in your Jansetu wallet. The patient is told.')).toBeVisible();
  await expect(page.getByText('By you', { exact: false })).toBeVisible();
  expect(b.cancels).toEqual([{ expectedVersion: 3 }]);
  expect(b.calls.some((c) => c.path === `/specialists/me/assisted/lab-bookings/${BK}/cancel`)).toBe(true);
});

test('a new time from the lab: accepted with the proposal version', async ({ page }) => {
  const b = await mockBackend(page, { bookings: [labView({ reschedule: { pending: true, version: 2, previousSlot: { date: TOMORROW, startTime: '08:00' }, reason: 'Collector unwell',
    at: '2026-11-25T04:00:00.000Z' } })] });
  await signIn(page);
  await page.goto(`/#/doctor/lab-tests/${BK}`);
  await expect(page.getByText(/The lab proposed a new time/)).toBeVisible();
  await page.getByRole('button', { name: 'Accept new time' }).click();
  await expect(page.getByText(/^New time accepted: .* at 09:00\. The patient is told\.$/)).toBeVisible();
  expect(b.accepts).toEqual([{ version: 2 }]);
});

test('a released report opens in the page through the file route', async ({ page }) => {
  const b = await mockBackend(page, { bookings: [labView({ status: 'report_ready',
    report: { releases: [{ file: `/api/static/partner-lab-reports/${BK}/report-1.pdf`, releasedAt: '2026-11-25T03:00:00.000Z', signer: { name: 'Dr A Rao' } }] } })] });
  await signIn(page);
  await page.goto(`/#/doctor/lab-tests/${BK}`);
  await expect(page.getByText('signed by Dr A Rao', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Open the report' }).click();
  await expect(page.getByTitle('Lab report')).toBeVisible();
  const fetches = b.calls.filter((c) => c.path.startsWith('/file/fetch'));
  expect(fetches).toHaveLength(1);
  expect(decodeURIComponent(fetches[0]!.path)).toContain(`partner-lab-reports/${BK}/report-1.pdf`);
});

test('an unverified doctor sees only the plain words on both pages; nothing is looked up or booked', async ({ page }) => {
  const b = await mockBackend(page, { bookings: [labView()] });
  b.eligible = false;
  await signIn(page);
  const words = 'Booking lab tests for your patients opens once Jansetu has verified your account and it is active.';
  await nav(page).getByRole('link', { name: 'Book lab test', exact: true }).click();
  await expect(page.getByText(words)).toBeVisible();
  await expect(page.getByLabel('Patient’s mobile number')).toHaveCount(0);
  await page.goto(`/#/doctor/lab-book/from/${CONSULT}`);
  await expect(page.getByText(words)).toBeVisible();
  await expect(page.getByLabel('Patient’s full name')).toHaveCount(0);
  await nav(page).getByRole('link', { name: 'Lab tests booked', exact: true }).click();
  await expect(page.getByText(words)).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
  expect(b.creates).toHaveLength(0);
  expect(b.calls.some((c) => c.path.endsWith('/patients/lookup'))).toBe(false);
});

test('another doctor’s booking (or none) is "not found"', async ({ page }) => {
  const b = await mockBackend(page, { bookings: [labView()] });
  await signIn(page);
  await page.goto(`/#/doctor/lab-tests/${OTHER}`);
  await expect(page.getByText('Lab test not found', { exact: true })).toBeVisible();
  expect(b.calls.some((c) => c.path === `/specialists/me/assisted/lab-bookings/${OTHER}`)).toBe(true);
  await page.getByRole('link', { name: 'See all booked lab tests' }).click();
  await expect(page.getByRole('heading', { name: 'Lab tests booked', level: 1 })).toBeVisible();
});
