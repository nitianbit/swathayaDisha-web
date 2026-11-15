import { expect, test, type Page, type Route } from '@playwright/test';

const ME = 'c1'.repeat(12);
const LAB = 'a1'.repeat(12);
const BR = 'a2'.repeat(12);
const T1 = 'a3'.repeat(12);
const T2 = 'a4'.repeat(12);
const S1 = 'a5'.repeat(12);
const MOTHER = 'f1'.repeat(12);
const HOUR = 3_600_000;

const istDay = (offsetMs = 0) => new Date(Date.now() + offsetMs + 330 * 60_000).toISOString().slice(0, 10);

/** Fake Razorpay Checkout: `window.__rz` = 'pay' | 'close'. Paying marks the order captured at the fake gateway. */
const FAKE_CHECKOUT = `
window.Razorpay = function (o) {
  this.open = function () {
    var mode = window.__rz || 'pay';
    setTimeout(function () {
      if (mode === 'pay') {
        fetch('/__fake_gateway/capture?order=' + o.order_id).then(function () {
          o.handler({ razorpay_payment_id: 'pay_1', razorpay_order_id: o.order_id, razorpay_signature: 'sig_1' });
        });
      } else { o.modal.ondismiss(); }
    }, 10);
  };
  this.on = function () {};
};`;

type Rec = Record<string, unknown>;
interface Backend {
  calls: { method: string; path: string; body: unknown; auth?: string }[];
  bookings: Map<string, Rec>;
  records: Map<string, { bookingId: string; orderId: string; captured: boolean }>;
  byKey: Map<string, string>;
  createDrops: boolean;
  refuseCreate: boolean;
  windowPassed: boolean;
}

function labBooking(id: string, over: Rec = {}): Rec {
  const startsAt = new Date(Date.now() + 72 * HOUR).toISOString();
  return {
    _id: id, partnerId: LAB, branchId: BR, patient: { kind: 'self', name: 'Asha Rao' }, visitMode: 'home',
    address: { line1: '12 MG Road', city: 'Pune', pincode: '411001' },
    slot: { slotId: S1, date: istDay(72 * HOUR), startTime: '09:00', endTime: '09:30', startsAt },
    items: [{ catalogItemId: T1, kind: 'test', name: 'Complete blood count', priceMinor: 40000 }],
    pricing: { subtotalMinor: 40000, discountMinor: 0, payableMinor: 40000, currency: 'INR' },
    status: 'confirmed', paymentStatus: 'paid', paymentTransactionId: 'e'.repeat(24), paymentDeadline: new Date(Date.now() + 20 * 60_000).toISOString(),
    reschedule: { version: 0, pending: false }, report: { files: [], releases: [] },
    lifecycle: { paidAt: new Date().toISOString(), confirmedAt: new Date().toISOString() }, createdAt: new Date().toISOString(), ...over,
  };
}

async function mockBackend(page: Page): Promise<Backend> {
  const state: Backend = { calls: [], bookings: new Map(), records: new Map(), byKey: new Map(), createDrops: false, refuseCreate: false, windowPassed: false };
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const ok = (route: Route, data: unknown, status = 200) => json(route, status, { success: true, data });
  const page1 = (route: Route, items: unknown[]) => json(route, 200, { success: true, data: items, pagination: { page: 1, limit: 20, total: items.length, totalPages: 1 } });
  let n = 0;
  const order = (bookingId: string, amount: number) => {
    n += 1;
    const record = String(n).padStart(24, '9');
    state.records.set(record, { bookingId, orderId: `order_${n}`, captured: false });
    return { paymentTransactionId: record, razorpayOrderId: `order_${n}`, razorpayKeyId: 'rzp_test_x', amount, currency: 'INR' };
  };
  const confirm = (bookingId: string) => { const b = state.bookings.get(bookingId)!; b.status = 'confirmed'; b.paymentStatus = 'paid'; };

  await page.route('https://checkout.razorpay.com/v1/checkout.js', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE_CHECKOUT }));
  await page.route('**/__fake_gateway/**', (route) => {
    const o = new URL(route.request().url()).searchParams.get('order');
    for (const r of state.records.values()) if (r.orderId === o) r.captured = true;
    return route.fulfill({ status: 200, body: 'ok' });
  });
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1', '');
    const body = req.method() === 'POST' ? req.postDataJSON() : null;
    state.calls.push({ method: req.method(), path: `${path}${url.search}`, body, auth: req.headers().authorization });
    if (path === '/auth/user/send') return json(route, 200, { success: true });
    if (path === '/auth/user/verify') return ok(route, { token: 't', user: {} });
    if (path === '/auth/session/refresh') return json(route, 401, { error: 401, code: 'SESSION_ENDED', message: 'Please sign in again' });
    if (path === '/auth/profile') return ok(route, { user: { _id: ME, name: 'Asha Rao', phone: '9876543210', email: 'a@x.in', gender: 'Female', dateOfBirth: '19900101' }, userRole: 'user' });
    if (path === `/wallet/user/${ME}`) return ok(route, { _id: 'w', userId: ME, balance: 50, isActive: true });
    if (path === '/dependents') return page1(route, [{ _id: MOTHER, userId: ME, name: 'Kamala Rao', relationship: 'Mother', isActive: true }]);
    if (path === '/partner-labs') {
      return ok(route, [{ partnerId: LAB, name: 'Sunrise Diagnostics', provider: 'partner', branches: [{ branchId: BR, name: 'Kothrud',
        address: { line1: '4 Paud Road', city: 'Pune', state: 'Maharashtra', pincode: '411038' }, phone: '9000000000', homeCollection: true, inLab: true }] }]);
    }
    if (path === `/partner-labs/${LAB}/catalogue`) {
      return ok(route, [
        { itemId: T1, kind: 'test', name: 'Complete blood count', price: 400, priceMinor: 40000, mrpMinor: 50000, visitModes: ['home', 'lab'], preparation: 'No fasting needed' },
        { itemId: T2, kind: 'package', name: 'Full body check', price: 1500, priceMinor: 150000, visitModes: ['home', 'lab'], includes: ['CBC', 'Lipid profile'] },
      ]);
    }
    if (path === `/partner-labs/branches/${BR}/slots`) {
      return ok(route, [{ slotId: S1, date: istDay(), startTime: '23:30', endTime: '23:59', seatsLeft: 3 }]);
    }
    if (path === '/coupons/validate') return ok(route, { isValid: true, discountAmount: 50, finalAmount: 350, coupon: { code: 'LAB50' } });
    if (path === '/bookings' || path.startsWith('/external-bookings') ) return page1(route, []);
    if (path === '/instant/requests') return ok(route, []);
    if (path === '/file/fetch') return route.fulfill({ status: 200, contentType: 'application/pdf', body: '%PDF-1.7\nreport' });
    if (path === '/lab-bookings' && req.method() === 'GET') return ok(route, [...state.bookings.values()]);
    if (path === '/lab-bookings' && req.method() === 'POST') {
      const b = body as Rec;
      const known = state.byKey.get(String(b.requestKey));
      if (known) {
        const booking = state.bookings.get(known)!;
        const open = state.records.get(String(booking.paymentTransactionId));
        return ok(route, { booking, paymentRequired: booking.paymentStatus !== 'paid', walletDeductedAmount: 50,
          ...(open && booking.paymentStatus !== 'paid' ? { payment: { paymentTransactionId: booking.paymentTransactionId, razorpayOrderId: open.orderId, razorpayKeyId: 'rzp_test_x', amount: 300, currency: 'INR' } } : {}) }, 201);
      }
      if (state.refuseCreate) { state.refuseCreate = false; return json(route, 409, { error: 409, code: 'SLOT_FULL', message: 'This time is no longer available' }); }
      const id = String(state.bookings.size + 1).padStart(24, 'b');
      state.byKey.set(String(b.requestKey), id);
      const booking = labBooking(id, { status: 'pending_payment', paymentStatus: 'pending', patient: { kind: 'dependent', name: 'Kamala Rao' }, lifecycle: {},
        pricing: { subtotalMinor: 40000, discountMinor: 5000, couponCode: 'LAB50', payableMinor: 35000, currency: 'INR' } });
      state.bookings.set(id, booking);
      const payment = order(id, 300);
      booking.paymentTransactionId = payment.paymentTransactionId;
      if (state.createDrops) { state.createDrops = false; return route.abort('connectionreset'); }
      return ok(route, { booking, paymentRequired: true, walletDeductedAmount: 50, payment }, 201);
    }
    const m = /^\/lab-bookings\/(\w{24})(\/pay|\/cancel|\/accept-reschedule)?$/.exec(path);
    if (m) {
      const b = state.bookings.get(m[1]!);
      if (!b) return json(route, 404, { error: 404, code: 'LAB_BOOKING_NOT_FOUND', message: 'Booking not found' });
      if (m[2] === '/pay') {
        for (const r of state.records.values()) if (r.bookingId === m[1] && r.captured) confirm(m[1]!);
        if (b.paymentStatus === 'paid') return ok(route, { booking: b, paymentRequired: false, walletDeductedAmount: 0 });
        if (state.windowPassed) return json(route, 409, { error: 409, code: 'LAB_BOOKING_PAYMENT_EXPIRED', message: 'The payment window has closed; book again' });
        const open = state.records.get(String(b.paymentTransactionId))!;
        return ok(route, { booking: b, paymentRequired: true, walletDeductedAmount: 50,
          payment: { paymentTransactionId: b.paymentTransactionId, razorpayOrderId: open.orderId, razorpayKeyId: 'rzp_test_x', amount: 300, currency: 'INR' } });
      }
      if (m[2] === '/cancel') {
        Object.assign(b, { status: 'cancelled', paymentStatus: 'refunded', cancellation: { reason: 'customer', note: (body as Rec).note, at: new Date().toISOString(), byKind: 'customer' } });
        return ok(route, { booking: b, refunded: 400 });
      }
      if (m[2] === '/accept-reschedule') {
        const r = b.reschedule as { version: number; pending: boolean };
        if (!r.pending || r.version !== (body as { version: number }).version) {
          return json(route, 409, { error: 409, code: 'RESCHEDULE_CHANGED', message: 'The lab changed the time again; review the latest proposal' });
        }
        r.pending = false;
        return ok(route, b);
      }
      return ok(route, b);
    }
    if (path === '/payments/verify') {
      const r = state.records.get((body as { paymentTransactionId: string }).paymentTransactionId)!;
      confirm(r.bookingId);
      return ok(route, { context: 'lab_booking', paymentRecord: { status: 'paid' }, entity: {} });
    }
    if (path === '/payments/reconcile') {
      const r = state.records.get((body as { paymentTransactionId: string }).paymentTransactionId);
      if (!r?.captured) return ok(route, { state: 'unpaid', gatewayStatuses: [] });
      confirm(r.bookingId);
      return ok(route, { state: 'paid', paymentRecord: { status: 'paid' } });
    }
    return json(route, 404, { error: 404, message: 'Not found' });
  });
  return state;
}

async function signIn(page: Page, path = '/') {
  await page.goto(`/#${path}`);
  await page.getByLabel('Mobile number').fill('9876543210');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
}

async function chooseTestAndTime(page: Page) {
  await page.getByRole('link', { name: 'Lab tests' }).click();
  await page.getByRole('link', { name: /Sunrise Diagnostics/ }).click();
  await expect(page.getByRole('button', { name: 'Home collection' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('checkbox', { name: /Complete blood count/ }).check();
  await page.getByRole('button', { name: '11:30 pm' }).click();
}

async function fillHomeForm(page: Page) {
  await page.getByLabel('For').selectOption({ label: 'Kamala Rao (Mother)' });
  await page.getByLabel('House and street').fill('12 MG Road');
  await page.getByLabel('City', { exact: true }).fill('Pune');
  await page.getByLabel('Pincode', { exact: true }).fill('411001');
}

const posts = (b: Backend, path: string) => b.calls.filter((c) => c.method === 'POST' && c.path === path);

test('book a home collection for a family member with a coupon and the wallet, and pay', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await chooseTestAndTime(page);
  await fillHomeForm(page);
  await page.getByLabel('Coupon (optional)').fill('lab50');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText('Coupon LAB50: ₹50.00 off.')).toBeVisible();
  await expect(page.getByLabel('Price')).toContainText('₹300.00'); // 400 − 50 coupon − 50 wallet
  await page.getByRole('button', { name: 'Book and pay' }).click();
  await expect(page.getByText('Confirmed', { exact: true })).toBeVisible();
  expect(posts(backend, '/lab-bookings')[0]!.body).toEqual({
    partnerId: LAB, branchId: BR, visitMode: 'home', slotId: S1, itemIds: [T1], patient: { kind: 'dependent', dependentId: MOTHER },
    address: { line1: '12 MG Road', city: 'Pune', pincode: '411001' }, couponCode: 'LAB50', useWalletBalance: true,
    requestKey: expect.stringMatching(/^[A-Za-z0-9_-]{8,64}$/),
  });
  expect(posts(backend, '/payments/verify')).toHaveLength(1);
  await expect(page.getByRole('region', { name: 'Progress' })).toContainText('Paid and confirmed');
  // Listed with the other bookings.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Bookings', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Partner lab bookings' }).getByRole('link', { name: /Complete blood count/ })).toBeVisible();
});

test('a home collection address is checked by the backend’s rules before anything is sent', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await chooseTestAndTime(page);
  await page.getByLabel('Pincode', { exact: true }).fill('0110');
  await page.getByRole('button', { name: 'Book and pay' }).click();
  await expect(page.getByText('Enter a 6-digit pincode.')).toBeVisible();
  await expect(page.getByText(/Enter the house number and street/)).toBeVisible();
  expect(posts(backend, '/lab-bookings')).toHaveLength(0);
});

test('closing the payment page leaves the booking unpaid; pay again reuses the open order', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await page.evaluate(() => { (window as unknown as { __rz: string }).__rz = 'close'; });
  await chooseTestAndTime(page);
  await fillHomeForm(page);
  await page.getByRole('button', { name: 'Book and pay' }).click();
  await expect(page.getByText(/This booking is not paid yet\. Pay by/)).toBeVisible();
  await page.evaluate(() => { (window as unknown as { __rz: string }).__rz = 'pay'; });
  await page.getByRole('button', { name: 'Pay now' }).click();
  await expect(page.getByText('Confirmed', { exact: true })).toBeVisible();
  expect(posts(backend, `/lab-bookings/${'b'.repeat(23)}1/pay`)).toHaveLength(1);
  expect(backend.records.size).toBe(1);
});

test('after the payment window, pay again is refused and the app says what happens next', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await page.evaluate(() => { (window as unknown as { __rz: string }).__rz = 'close'; });
  await chooseTestAndTime(page);
  await fillHomeForm(page);
  await page.getByRole('button', { name: 'Book and pay' }).click();
  await expect(page.getByRole('button', { name: 'Pay now' })).toBeVisible();
  backend.windowPassed = true;
  await page.getByRole('button', { name: 'Pay now' }).click();
  await expect(page.getByText(/The time to pay for this booking has passed/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pay now' })).toHaveCount(0);
});

test('a lost create answer locks the form; sending it again uses the same key and books once', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await chooseTestAndTime(page);
  await fillHomeForm(page);
  backend.createDrops = true;
  await page.getByRole('button', { name: 'Book and pay' }).click();
  const locked = page.getByRole('group', { name: 'Unconfirmed lab booking request' });
  await expect(locked).toContainText('It may already have been made');
  await expect(page.getByRole('button', { name: 'Book and pay' })).toHaveCount(0);
  await locked.getByRole('button', { name: 'Send it again' }).click();
  await expect(page.getByText('Confirmed', { exact: true })).toBeVisible();
  const creates = posts(backend, '/lab-bookings').map((c) => c.body);
  expect(creates).toHaveLength(2);
  expect(creates[1]).toEqual(creates[0]);
  expect(backend.bookings.size).toBe(1);
});

test('a refused create shows the server’s message and leaves the form usable', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.refuseCreate = true;
  await signIn(page);
  await chooseTestAndTime(page);
  await fillHomeForm(page);
  await page.getByRole('button', { name: 'Book and pay' }).click();
  await expect(page.getByText('This time is no longer available')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Book and pay' })).toBeEnabled();
});

test('cancel a paid booking: the second step says the money goes back to the wallet', async ({ page }) => {
  const backend = await mockBackend(page);
  const id = 'c2'.repeat(12);
  backend.bookings.set(id, labBooking(id));
  await signIn(page, `/partner-lab-bookings/${id}`);
  await expect(page.getByText(/You can cancel until .* \(2 hours before the time\)/)).toBeVisible();
  await page.getByRole('button', { name: 'Cancel this booking' }).click();
  await expect(page.getByText('The booking is cancelled and everything you paid goes back to your Jansetu wallet.')).toBeVisible();
  expect(posts(backend, `/lab-bookings/${id}/cancel`)).toHaveLength(0);
  await page.getByLabel('Reason (optional)').fill('Travelling');
  await page.getByRole('button', { name: 'Yes, cancel it' }).click();
  await expect(page.getByText('Cancelled', { exact: true })).toBeVisible();
  expect(posts(backend, `/lab-bookings/${id}/cancel`)[0]!.body).toEqual({ note: 'Travelling' });
});

test('inside 2 hours a paid booking cannot be cancelled, and the app says why', async ({ page }) => {
  const backend = await mockBackend(page);
  const id = 'c3'.repeat(12);
  backend.bookings.set(id, labBooking(id, { slot: { slotId: S1, date: istDay(), startTime: '09:00', endTime: '09:30', startsAt: new Date(Date.now() + HOUR).toISOString() } }));
  await signIn(page, `/partner-lab-bookings/${id}`);
  await expect(page.getByText(/Paid bookings can be cancelled until 2 hours before the time\. That time has passed\./)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel this booking' })).toHaveCount(0);
});

test('accept a new time proposed by the lab (exactly the version shown); a newer proposal is reported', async ({ page }) => {
  const backend = await mockBackend(page);
  const id = 'c4'.repeat(12);
  const previous = { slotId: 'x'.repeat(24), date: istDay(48 * HOUR), startTime: '08:00', endTime: '08:30', startsAt: new Date(Date.now() + 48 * HOUR).toISOString() };
  backend.bookings.set(id, labBooking(id, { reschedule: { version: 2, pending: true, previousSlot: previous, reason: 'Collector unavailable' } }));
  await signIn(page, `/partner-lab-bookings/${id}`);
  const panel = page.getByRole('region', { name: 'The lab proposed a new time' });
  await expect(panel).toContainText('Collector unavailable');
  await expect(page.getByText(/you can cancel at any time, with a full refund/)).toBeVisible();
  // The lab moves it again before the customer answers.
  (backend.bookings.get(id)!.reschedule as { version: number }).version = 3;
  await panel.getByRole('button', { name: 'Accept the new time' }).click();
  await expect(page.getByText('The lab changed the time again. Check the new time below before accepting.')).toBeVisible();
  await page.getByRole('button', { name: 'Accept the new time' }).click();
  await expect(page.getByRole('region', { name: 'The lab proposed a new time' })).toHaveCount(0);
  expect(posts(backend, `/lab-bookings/${id}/accept-reschedule`).map((c) => c.body)).toEqual([{ version: 2 }, { version: 3 }]);
});

test('a released report is read through the file route with the token and opened from memory', async ({ page }) => {
  const backend = await mockBackend(page);
  const id = 'c5'.repeat(12);
  backend.bookings.set(id, labBooking(id, { status: 'report_ready', report: { files: [`/api/static/partner-lab-reports/${id}/cbc.pdf`],
    releases: [{ releasedAt: new Date().toISOString(), signer: { name: 'Dr. Lata Shah', registrationNumber: 'MMC-123' } }] } }));
  await signIn(page, `/partner-lab-bookings/${id}`);
  await expect(page.getByText(/Released .* by Dr\. Lata Shah \(Reg\. MMC-123\)/)).toBeVisible();
  await page.getByRole('button', { name: 'Get report' }).click();
  await expect(page.getByRole('link', { name: 'Open report' })).toHaveAttribute('href', /^blob:/);
  await expect(page.getByRole('link', { name: 'Save report' })).toHaveAttribute('download', 'lab-report-1.pdf');
  const fetches = backend.calls.filter((c) => c.path.startsWith('/file/fetch'));
  expect(fetches).toHaveLength(1);
  expect(new URLSearchParams(fetches[0]!.path.split('?')[1]).get('url')).toBe(`/api/v1/file/static/partner-lab-reports/${id}/cbc.pdf`);
  expect(fetches[0]!.auth).toBe('Bearer t');
  expect(fetches[0]!.path).not.toContain('t=');
});
