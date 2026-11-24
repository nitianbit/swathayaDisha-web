import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * WQ22: the pharmacy's "Consult now" (r17, design §25.12) against a mocked backend: a request paid from the wallet and
 * accepted (Join call), a changed quote, no doctor online, the refund before acceptance, asking again after the offer ran
 * out, a lost answer checked by key, and the switch. Money in paise.
 */
const ME = 'ph'.replace('ph', 'a5').repeat(12);
const DOC1 = 'd1'.repeat(12);
const DOC2 = 'd2'.repeat(12);
const REQ = 'e1'.repeat(12);
const BOOKED = 'b1'.repeat(12);
const PHONE = '9876543210';
const NOW = new Date('2026-11-25T04:30:00.000Z');
const LATER = new Date(NOW.getTime() + 4 * 60_000).toISOString();
const EARLIER = new Date(NOW.getTime() - 60_000).toISOString();

type Json = Record<string, unknown>;
interface Backend {
  calls: { method: string; path: string; body: unknown }[];
  live: boolean;
  balanceMinor: number;
  request: Json | null;
  keys: Record<string, string>;
  off?: boolean;
  nobodyOnline?: boolean;
  /** The next request is answered 409 QUOTE_CHANGED with this quote. */
  quoteChangedTo?: number;
  /** The next request is made, then its answer is lost. */
  loseAfter?: boolean;
  /** The request's offer has already run out when it is first read. */
  expired?: boolean;
  /** WQ22c: the refund answers this amount (what the server refunded). */
  refundMinor?: number;
  /** WQ22c: a server without the r17 routes (404 with no code). */
  noRoutes?: boolean;
}

async function mockBackend(page: Page, opts: { runningClock?: boolean } = {}): Promise<Backend> {
  // WQ22c: a running fake clock (moved on with fastForward) where timers matter; else a fixed time.
  if (opts.runningClock) await page.clock.install({ time: NOW }); else await page.clock.setFixedTime(NOW);
  const b: Backend = { calls: [], live: false, balanceMinor: 200_000, request: null, keys: {} };
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const ok = (route: Route, data: unknown, status = 200) => json(route, status, { success: true, data });
  const fail = (route: Route, status: number, code: string, message: string, extra: Json = {}) => json(route, status, { error: status, code, message, ...extra });
  const doctors = [
    { doctorId: DOC1, name: 'Dr Asha Mehta', specialization: 'General Physician', modes: ['video', 'call'], instantFeeMinor: 40000, nearby: 'pincode' },
    { doctorId: DOC2, name: 'Dr Kiran Rao', specialization: 'General Physician', modes: ['video'], instantFeeMinor: 50000, nearby: null },
  ];
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = req.method();
    const body = method === 'POST' || method === 'PUT' ? (req.postDataJSON() as Json | null) : null;
    if (path === '/auth/session/refresh') {
      return b.live ? ok(route, { token: 't1', expiresIn: 900, principal: { userId: ME, userType: 'pharmacy', sid: 's1' } }) : fail(route, 401, 'SESSION_ENDED', 'Please sign in again');
    }
    if (path.startsWith('/auth/session')) return ok(route, {});
    b.calls.push({ method, path: `${path}${url.search}`, body });
    if (path === '/auth/pharmacy/send') return ok(route, undefined);
    if (path === '/auth/pharmacy/verify') { b.live = true; return ok(route, { token: 't1', expiresIn: 900, user: {} }); }
    if (req.headers().authorization !== 'Bearer t1') return fail(route, 401, 'UNAUTHORIZED', 'Authentication is required');
    if (path === '/auth/profile') return ok(route, { user: { _id: ME, name: 'Asha Medicals' }, userRole: 'pharmacy' });
    if (path === '/pharmacy-wallet') return ok(route, { balancePaise: b.balanceMinor, isActive: true, receivableMinor: 0, frozen: false });
    if (path === '/pharmacy-assisted/patients/lookup') return ok(route, { exists: true, holderNameMasked: 'R*** K***' });
    if (path === '/pharmacy-bookings' && method === 'GET') return json(route, 200, { success: true, data: [], pagination: { nextCursor: null } });
    if (path === `/pharmacy-bookings/${BOOKED}`) {
      return ok(route, { _id: BOOKED, status: 'confirmed', paymentStatus: 'paid', source: 'pharmacy_assisted', bookingKind: 'instant', doctorName: 'Dr Asha Mehta',
        consultationMode: 'video', instantRequestId: REQ, virtualMeeting: { joinUrl: 'https://meet.example.test/abc' }, assisted: { shortRef: 'K7QXM2PA', join: { on: 'partner_device' } } });
    }
    const base = '/pharmacy-assisted/instant';
    if (b.noRoutes && path.startsWith(base)) return json(route, 404, { success: false, message: 'Route not found' });
    if (path === `${base}/specialities`) {
      if (b.off) return fail(route, 503, 'ASSISTED_BOOKING_DISABLED', 'Consult now is not switched on');
      return ok(route, [{ specialization: 'General Physician', onlineNow: b.nobodyOnline ? 0 : 2 }, { specialization: 'Dermatology', onlineNow: 0 }]);
    }
    if (path === `${base}/doctors`) return ok(route, doctors);
    if (path === `${base}/quote`) {
      const d = doctors.find((x) => x.doctorId === url.searchParams.get('doctorId'));
      return ok(route, { quotedAmountMinor: d ? d.instantFeeMinor : 50000, doctors: d ? 1 : 2 });
    }
    if (path === `${base}/requests` && method === 'GET') {
      const st = url.searchParams.get('status');
      const rows = b.request && (!st || b.request.status === st) ? [b.request] : [];
      return json(route, 200, { success: true, data: rows, pagination: { total: rows.length, nextCursor: null } });
    }
    if (path === `${base}/requests` && method === 'POST') {
      const x = body as Json;
      const key = String(x.requestKey);
      if (b.keys[key]) return ok(route, { request: b.request, funding: { method: 'wallet', amountMinor: x.acceptedPayableMinor, state: 'held', walletEntryId: 'w1' }, newAccount: false, replayed: true });
      if (b.quoteChangedTo !== undefined && x.acceptedQuoteMinor !== b.quoteChangedTo) {
        return fail(route, 409, 'QUOTE_CHANGED', 'The price changed', { details: { quotedAmountMinor: b.quoteChangedTo, discountMinor: 0 } });
      }
      b.balanceMinor -= x.acceptedPayableMinor as number;
      b.request = { _id: REQ, status: 'offered', statusVersion: 1, mode: x.mode, specialization: x.specialization, target: x.target, offerGeneration: 1,
        offerExpiresAt: b.expired ? EARLIER : LATER, inactivityRefundAt: LATER, offeredCount: 2, acceptedDoctorName: null, bookingId: null,
        patientName: (x.patient as Json).name, assisted: { shortRef: 'K7QXM2PA', join: x.join, preferredLanguage: x.preferredLanguage },
        money: { quotedAmountMinor: x.acceptedQuoteMinor, discountMinor: 0, paidMinor: x.acceptedPayableMinor, returnedMinor: 0, refundedMinor: 0 } };
      b.keys[key] = REQ;
      if (b.loseAfter) { b.loseAfter = false; return route.abort('failed'); }
      return ok(route, { request: b.request, funding: { method: 'wallet', amountMinor: x.acceptedPayableMinor, state: 'held', walletEntryId: 'w1' }, newAccount: false, replayed: false }, 201);
    }
    const byKey = new RegExp(`^${base}/requests/by-key/([A-Za-z0-9_-]+)(/abandon)?$`).exec(path);
    if (byKey) return ok(route, b.keys[byKey[1]!] ? { state: 'used', request: b.request } : { state: 'unknown' });
    const one = new RegExp(`^${base}/requests/([0-9a-f]{24})(/[a-z]+)?$`).exec(path);
    if (one && b.request) {
      const r = b.request;
      const cmd = one[2];
      if (!cmd) return ok(route, r);
      if (cmd === '/activity') return ok(route, r);
      const v = (body as Json).expectedStatusVersion;
      if (v !== r.statusVersion) return fail(route, 409, 'INSTANT_REQUEST_CHANGED', 'The request changed');
      if (cmd === '/refund') {
        if (r.status !== 'offered') return fail(route, 409, 'REQUEST_NOT_REFUNDABLE', 'Not refundable');
        const paid = b.refundMinor ?? (r.money as Json).paidMinor as number;
        b.balanceMinor += paid;
        Object.assign(r, { status: 'refunded', statusVersion: (r.statusVersion as number) + 1, money: { ...(r.money as Json), refundedMinor: paid } });
        return ok(route, { refundedMinor: paid, request: r });
      }
      if (cmd === '/reoffer') {
        Object.assign(r, { target: (body as Json).target, offerGeneration: (r.offerGeneration as number) + 1, offerExpiresAt: LATER, statusVersion: (r.statusVersion as number) + 1 });
        return ok(route, r);
      }
    }
    return fail(route, 404, 'NOT_FOUND', 'Not found');
  });
  return b;
}

/** A doctor accepts (as the server would after the doctor's accept): the booking exists; part of the quote comes back. */
function accept(b: Backend) {
  Object.assign(b.request!, { status: 'accepted', statusVersion: 2, acceptedDoctorName: 'Dr Asha Mehta', bookingId: BOOKED,
    money: { ...(b.request!.money as Json), returnedMinor: 10000 } });
}

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Mobile number').fill('9000000001');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Consult now', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Consult now', level: 1 })).toBeVisible();
}

async function patientAndDoctor(page: Page, doctor?: RegExp) {
  await page.getByLabel('Patient’s mobile number').fill(PHONE);
  await page.getByRole('button', { name: 'Find' }).click();
  await page.getByRole('radio', { name: /^The phone’s owner/ }).check();
  await page.getByLabel('Patient’s full name').fill('Ravi Kumar');
  await page.getByLabel('Patient agreed to this booking').check();
  await page.getByRole('button', { name: 'Next: choose the doctor' }).click();
  const form = page.getByRole('form', { name: 'Doctor' });
  await form.getByLabel('What does the patient need?').selectOption('General Physician');
  if (doctor) await form.getByRole('radio', { name: doctor }).check();
  await form.getByLabel('On this pharmacy’s device').check();
  await form.getByLabel('Language the patient speaks').selectOption('hi');
  await form.getByRole('button', { name: 'Next: check the price' }).click();
}
const requests = (b: Backend) => b.calls.filter((c) => c.method === 'POST' && c.path === '/pharmacy-assisted/instant/requests');
const stored = (page: Page) => page.evaluate(() => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }) + location.href);

test('request and accept: paid from the wallet, waiting with activity, then the doctor’s Join call and the booking', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await patientAndDoctor(page);
  const pay = page.getByRole('group', { name: 'Check and pay' });
  await expect(pay).toContainText('Doctor: Any available doctor, General Physician');
  await pay.getByRole('button', { name: 'Pay ₹500.00 from wallet and request' }).click();
  await expect(page.getByRole('heading', { name: 'Waiting for a doctor' })).toBeVisible();
  await expect(page.getByText('Offered to 2 doctors online.', { exact: false })).toBeVisible();
  await expect(page.getByText('4:00', { exact: false })).toBeVisible();
  const sent = requests(backend)[0]!.body as Json;
  expect(sent).toMatchObject({ phone: PHONE, specialization: 'General Physician', mode: 'video', target: { kind: 'any' }, join: { on: 'partner_device' },
    acceptedQuoteMinor: 50000, acceptedPayableMinor: 50000, paymentMethod: 'wallet', preferredLanguage: 'hi' });
  await expect.poll(() => backend.calls.some((c) => c.path === `/pharmacy-assisted/instant/requests/${REQ}/activity`)).toBe(true);
  expect(await stored(page)).not.toMatch(new RegExp(`${PHONE}|Ravi`));
  accept(backend);
  await expect(page.getByRole('heading', { name: 'A doctor accepted' })).toBeVisible({ timeout: 12_000 });
  await expect(page.getByText('Dr Asha Mehta accepted. ₹100.00 of the price came back to your wallet', { exact: false })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Join call' })).toHaveAttribute('href', 'https://meet.example.test/abc');
  await expect(page.getByRole('link', { name: 'Open the booking' })).toHaveAttribute('href', `#/pharmacy/consultations/${BOOKED}`);
});

test('a changed quote: said with the new price; paying again is a new request at that price', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.quoteChangedTo = 60000;
  await signIn(page);
  await patientAndDoctor(page);
  await page.getByRole('button', { name: 'Pay ₹500.00 from wallet and request' }).click();
  await expect(page.getByText('The price has changed. It is now ₹600.00.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Use the new price (₹600.00)' }).click();
  await page.getByRole('button', { name: 'Pay ₹600.00 from wallet and request' }).click();
  await expect(page.getByRole('heading', { name: 'Waiting for a doctor' })).toBeVisible();
  const sent = requests(backend);
  expect(sent).toHaveLength(2);
  expect(sent[1]!.body).toMatchObject({ acceptedQuoteMinor: 60000, acceptedPayableMinor: 60000 });
  expect((sent[1]!.body as Json).requestKey).not.toBe((sent[0]!.body as Json).requestKey);
});

test('no doctor online: said, with a way to book a time instead; nothing is requested', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.nobodyOnline = true;
  await signIn(page);
  await page.getByLabel('Patient’s mobile number').fill(PHONE);
  await page.getByRole('button', { name: 'Find' }).click();
  await page.getByRole('radio', { name: /^The phone’s owner/ }).check();
  await page.getByLabel('Patient’s full name').fill('Ravi Kumar');
  await page.getByLabel('Patient agreed to this booking').check();
  await page.getByRole('button', { name: 'Next: choose the doctor' }).click();
  await expect(page.getByText('No doctor is online for video calls now.', { exact: false })).toBeVisible();
  await expect(page.getByRole('link', { name: 'book a time' })).toHaveAttribute('href', '#/pharmacy/book');
  expect(requests(backend)).toHaveLength(0);
});

test('cancel and refund before a doctor accepts: on the version shown; the money is back in the wallet', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await patientAndDoctor(page, /^Dr Asha Mehta/);
  await page.getByRole('button', { name: 'Pay ₹400.00 from wallet and request' }).click();
  await page.getByRole('button', { name: 'Cancel and refund' }).click();
  await expect(page.getByRole('group', { name: 'Cancel and refund' })).toContainText('₹400.00 goes back to your wallet');
  // WQ22c L2: the words name what the server refunded (here not the whole amount).
  backend.refundMinor = 39_900;
  await page.getByRole('button', { name: 'Yes, cancel and refund' }).click();
  await expect(page.getByText('Cancelled. ₹399.00 is back in your wallet; give the patient their money back.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Cancelled and refunded' })).toBeVisible();
  const refund = backend.calls.find((c) => c.path === `/pharmacy-assisted/instant/requests/${REQ}/refund`)!;
  expect(refund.body).toEqual({ expectedStatusVersion: 1 });
  expect((requests(backend)[0]!.body as Json).target).toEqual({ kind: 'specific', doctorId: DOC1 });
  expect(backend.balanceMinor).toBe(199_900);
});

test('the offer ran out: no activity is sent any more (the money is refunded unless asked again); ask any available doctor on the version shown', async ({ page }) => {
  const backend = await mockBackend(page, { runningClock: true });
  backend.expired = true;
  await signIn(page);
  await patientAndDoctor(page, /^Dr Asha Mehta/);
  await page.getByRole('button', { name: 'Pay ₹400.00 from wallet and request' }).click();
  await expect(page.getByText('No doctor accepted this time.', { exact: false })).toBeVisible();
  // WQ22c L1: an open tab no longer keeps the money held once the offer ran out: three minutes pass, no activity is sent.
  const activity = () => backend.calls.filter((c) => c.path === `/pharmacy-assisted/instant/requests/${REQ}/activity`).length;
  await page.clock.fastForward('03:00');
  await expect(page.getByText('No doctor accepted this time.', { exact: false })).toBeVisible();
  expect(activity()).toBe(0);
  await page.getByRole('button', { name: 'Ask any available doctor' }).click();
  await expect(page.getByText('Asked any available doctor. Waiting for a doctor.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Waiting for a doctor' })).toBeVisible();
  const reoffer = backend.calls.find((c) => c.path === `/pharmacy-assisted/instant/requests/${REQ}/reoffer`)!;
  expect(reoffer.body).toEqual({ target: { kind: 'any' }, expectedStatusVersion: 1 });
  // A new offer is open: activity again.
  await expect.poll(activity).toBeGreaterThan(0);
});

test('a lost answer: the unconfirmed request is checked by its key and then followed', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.loseAfter = true;
  await signIn(page);
  await patientAndDoctor(page);
  await page.getByRole('button', { name: 'Pay ₹500.00 from wallet and request' }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed request' });
  await expect(panel).toContainText('Sending the same request again is safe');
  await panel.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(page.getByRole('heading', { name: 'Waiting for a doctor' })).toBeVisible();
  const key = (requests(backend)[0]!.body as Json).requestKey as string;
  expect(backend.calls.some((c) => c.path === `/pharmacy-assisted/instant/requests/by-key/${key}`)).toBe(true);
  expect(requests(backend)).toHaveLength(1);
});

test('switched off: said once; nothing is requested', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.off = true;
  await signIn(page);
  await page.getByLabel('Patient’s mobile number').fill(PHONE);
  await page.getByRole('button', { name: 'Find' }).click();
  await page.getByRole('radio', { name: /^The phone’s owner/ }).check();
  await page.getByLabel('Patient’s full name').fill('Ravi Kumar');
  await page.getByLabel('Patient agreed to this booking').check();
  await page.getByRole('button', { name: 'Next: choose the doctor' }).click();
  await expect(page.getByText('Consult now for patients is not switched on yet.', { exact: false })).toBeVisible();
  expect(requests(backend)).toHaveLength(0);
});

test('WQ22c: a server without Consult now (404 with no code) says it is not switched on, never "Route not found"', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.noRoutes = true;
  await signIn(page);
  await page.getByLabel('Patient’s mobile number').fill(PHONE);
  await page.getByRole('button', { name: 'Find' }).click();
  await page.getByRole('radio', { name: /^The phone’s owner/ }).check();
  await page.getByLabel('Patient’s full name').fill('Ravi Kumar');
  await page.getByLabel('Patient agreed to this booking').check();
  await page.getByRole('button', { name: 'Next: choose the doctor' }).click();
  await expect(page.getByText('Consult now for patients is not switched on yet.', { exact: false })).toBeVisible();
  await expect(page.getByText('Route not found')).toHaveCount(0);
  expect(requests(backend)).toHaveLength(0);
});

test('WQ22b: after a reload a waiting request is listed; it opens the waiting view and is cancelled and refunded there', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await expect(page.getByRole('region', { name: 'Waiting for a doctor' })).toHaveCount(0);
  await patientAndDoctor(page);
  await page.getByRole('button', { name: 'Pay ₹500.00 from wallet and request' }).click();
  await expect(page.getByRole('heading', { name: 'Waiting for a doctor' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await page.goto('/#/pharmacy/consult-now');
  const open = page.getByRole('region', { name: 'Waiting for a doctor' });
  await expect(open).toContainText('Ravi Kumar · General Physician · Video call · ₹500.00');
  await open.getByRole('button', { name: 'Open the request for Ravi Kumar' }).click();
  await expect(page.getByText('Offered to 2 doctors online.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel and refund' }).click();
  await page.getByRole('button', { name: 'Yes, cancel and refund' }).click();
  await expect(page.getByText('Cancelled. ₹500.00 is back in your wallet; give the patient their money back.')).toBeVisible();
  expect(backend.balanceMinor).toBe(200_000);
  expect(requests(backend)).toHaveLength(1);
  // Nothing about the patient was kept in the browser to find it: the server's list did.
  expect(await stored(page)).not.toMatch(new RegExp(`${PHONE}|Ravi`));
  await page.getByRole('button', { name: 'Start another' }).click();
  await expect(page.getByRole('region', { name: 'Waiting for a doctor' })).toHaveCount(0);
});
