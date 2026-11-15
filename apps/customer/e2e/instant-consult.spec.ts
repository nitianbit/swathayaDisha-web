import { expect, test, type Page, type Route } from '@playwright/test';

const ME = 'c1'.repeat(12);
const D1 = 'd1'.repeat(12);
const D2 = 'd2'.repeat(12);
const BK = 'b9'.repeat(12);

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
  calls: { method: string; path: string; body: unknown }[];
  requests: Map<string, Rec>;
  records: Map<string, { requestId: string; orderId: string; captured: boolean }>;
  byKey: Map<string, string>;
  nobodyOnline: boolean;
  windowPassed: boolean;
  booking: Rec;
}

const inMin = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

function request(id: string, over: Rec = {}): Rec {
  return {
    _id: id, patient: { kind: 'self', name: 'Asha Rao' }, specialization: 'Dermatology', mode: 'video', target: { kind: 'any' },
    quotedAmountMinor: 50000, discountMinor: 0, fundingState: 'held', status: 'offered', paymentStatus: 'paid',
    funding: { couponMinor: 0, walletMinor: 5000, gatewayMinor: 45000, totalMinor: 50000 }, paymentDeadline: inMin(20),
    offerGeneration: 1, offerExpiresAt: inMin(5), inactivityRefundAt: inMin(30), createdAt: new Date().toISOString(), ...over,
  };
}

async function mockBackend(page: Page): Promise<Backend> {
  const state: Backend = { calls: [], requests: new Map(), records: new Map(), byKey: new Map(), nobodyOnline: false, windowPassed: false,
    booking: { _id: BK, bookingType: 'consultation', bookingKind: 'instant', doctorName: 'Dr. Ravi Kumar', consultationMode: 'video', bookingDate: '20261115',
      bookingTime: '21:00', price: 300, status: 'confirmed', paymentStatus: 'paid',
      virtualMeeting: { provider: 'google_meet', status: 'active', joinUrl: 'https://meet.google.com/abc-defg-hij' } } };
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const ok = (route: Route, data: unknown, status = 200) => json(route, status, { success: true, data });
  const page1 = (route: Route, items: unknown[]) => json(route, 200, { success: true, data: items, pagination: { page: 1, limit: 20, total: items.length, totalPages: 1 } });
  let n = 0;
  const order = (requestId: string, amount: number) => {
    n += 1;
    const record = String(n).padStart(24, '9');
    state.records.set(record, { requestId, orderId: `order_${n}`, captured: false });
    return { paymentTransactionId: record, razorpayOrderId: `order_${n}`, razorpayKeyId: 'rzp_test_x', amount, currency: 'INR' };
  };
  const hold = (id: string) => Object.assign(state.requests.get(id)!, { status: 'offered', fundingState: 'held', paymentStatus: 'paid', offerGeneration: 1,
    offerExpiresAt: inMin(5), funding: { couponMinor: 0, walletMinor: 5000, gatewayMinor: 45000, totalMinor: 50000 } });

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
    state.calls.push({ method: req.method(), path: `${path}${url.search}`, body });
    if (path === '/auth/user/send') return json(route, 200, { success: true });
    if (path === '/auth/user/verify') return ok(route, { token: 't', user: {} });
    if (path === '/auth/session/refresh') return json(route, 401, { error: 401, code: 'SESSION_ENDED', message: 'Please sign in again' });
    if (path === '/auth/profile') return ok(route, { user: { _id: ME, name: 'Asha Rao', phone: '9876543210', email: 'a@x.in', gender: 'Female', dateOfBirth: '19900101' }, userRole: 'user' });
    if (path === `/wallet/user/${ME}`) return ok(route, { _id: 'w', userId: ME, balance: 50, isActive: true });
    if (path === '/dependents') return page1(route, []);
    if (path === '/instant/doctors') {
      if (state.nobodyOnline) return ok(route, []);
      return ok(route, [
        { doctorId: D1, name: 'Dr. Ravi Kumar', rating: 4.6, specialization: 'Dermatology', modes: ['video', 'call'], instantFeeMinor: 30000, instantFee: 300 },
        { doctorId: D2, name: 'Dr. Sita Rao', specialization: 'Dermatology', modes: ['video'], instantFeeMinor: 50000, instantFee: 500 },
      ]);
    }
    if (path === '/instant/quote') {
      if (state.nobodyOnline) return json(route, 409, { error: 409, code: 'NO_DOCTOR_ONLINE', message: 'No doctor of this speciality is online right now' });
      return ok(route, url.searchParams.get('doctorId') === D1 ? { quotedAmountMinor: 30000, doctors: 1 } : { quotedAmountMinor: 50000, doctors: 2 });
    }
    if (path === '/coupons/validate') return json(route, 400, { error: 400, code: 'INVALID_COUPON', message: 'This coupon has expired' });
    if (path === '/instant/requests' && req.method() === 'GET') return ok(route, [...state.requests.values()]);
    if (path === '/instant/requests' && req.method() === 'POST') {
      const b = body as Rec;
      const known = state.byKey.get(String(b.requestKey));
      if (known) return ok(route, { request: state.requests.get(known), paymentRequired: false }, 201);
      const id = String(state.requests.size + 1).padStart(24, 'e');
      state.byKey.set(String(b.requestKey), id);
      const r = request(id, { status: 'pending_payment', fundingState: 'awaiting', paymentStatus: 'pending', offerGeneration: 0, offerExpiresAt: undefined, funding: undefined,
        target: b.target, specialization: b.specialization, mode: b.mode });
      state.requests.set(id, r);
      const payment = order(id, 450);
      r.paymentTransactionId = payment.paymentTransactionId;
      return ok(route, { request: r, paymentRequired: true, payment }, 201);
    }
    const m = /^\/instant\/requests\/(\w{24})(\/pay|\/reoffer|\/activity|\/refund)?$/.exec(path);
    if (m) {
      const r = state.requests.get(m[1]!);
      if (!r) return json(route, 404, { error: 404, code: 'INSTANT_REQUEST_NOT_FOUND', message: 'Request not found' });
      if (m[2] === '/pay') {
        for (const x of state.records.values()) if (x.requestId === m[1] && x.captured) hold(m[1]!);
        if (r.paymentStatus === 'paid') return ok(route, { request: r, paymentRequired: false });
        if (state.windowPassed) return json(route, 409, { error: 409, code: 'INSTANT_PAYMENT_EXPIRED', message: 'The payment window has closed; start again' });
        const open = state.records.get(String(r.paymentTransactionId))!;
        return ok(route, { request: r, paymentRequired: true, payment: { paymentTransactionId: r.paymentTransactionId, razorpayOrderId: open.orderId, razorpayKeyId: 'rzp_test_x', amount: 450, currency: 'INR' } });
      }
      if (m[2] === '/activity') {
        if (r.status !== 'offered') return json(route, 409, { error: 409, code: 'REQUEST_NOT_OPEN', message: 'This request is no longer waiting for a doctor' });
        return ok(route, r);
      }
      if (m[2] === '/reoffer') {
        Object.assign(r, { target: (body as Rec).target, offerGeneration: Number(r.offerGeneration) + 1, offerExpiresAt: inMin(5) });
        return ok(route, r);
      }
      if (m[2] === '/refund') {
        if (r.status !== 'offered') return json(route, 409, { error: 409, code: 'REQUEST_NOT_REFUNDABLE', message: 'A doctor already accepted, or it was refunded' });
        Object.assign(r, { status: 'refunded', fundingState: 'refunded', paymentStatus: 'refunded', refundReason: 'customer' });
        return ok(route, { refunded: 450, skipped: false });
      }
      return ok(route, r);
    }
    if (path === `/bookings/${BK}`) return ok(route, state.booking);
    if (path === '/bookings' || path.startsWith('/external-bookings')) return page1(route, []);
    if (path === '/lab-bookings') return ok(route, []);
    if (path === '/payments/verify') {
      const x = state.records.get((body as { paymentTransactionId: string }).paymentTransactionId)!;
      hold(x.requestId);
      return ok(route, { context: 'instant_request', paymentRecord: { status: 'paid' }, entity: {} });
    }
    if (path === '/payments/reconcile') {
      const x = state.records.get((body as { paymentTransactionId: string }).paymentTransactionId);
      if (!x?.captured) return ok(route, { state: 'unpaid', gatewayStatuses: [] });
      hold(x.requestId);
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

async function chooseAny(page: Page) {
  await page.getByRole('link', { name: 'Consult now' }).click();
  await page.getByLabel('Speciality').fill('Dermatology');
  await page.getByLabel('Video call').check();
  await page.getByRole('button', { name: 'See who is online' }).click();
  await page.getByLabel(/Any available doctor/).check();
  await expect(page.getByText(/You pay ₹500\.00 now \(the highest fee among the 2 doctors online\)/)).toBeVisible();
}

const posts = (b: Backend, path: string) => b.calls.filter((c) => c.method === 'POST' && c.path === path);

test('consult now: any available doctor, pay upfront, wait (presence reported, offer countdown), then join the accepted consultation', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await chooseAny(page);
  await expect(page.getByLabel('Price')).toContainText('₹450.00'); // 500 − 50 wallet
  await page.getByRole('button', { name: 'Pay and request a doctor' }).click();
  await expect(page.getByRole('heading', { name: 'Waiting for a doctor to accept' })).toBeVisible();
  await expect(page.getByRole('timer', { name: 'Time left for this offer' })).toContainText(/[45]:\d\d/);
  expect(posts(backend, '/instant/requests')[0]!.body).toEqual({
    target: { kind: 'any' }, specialization: 'Dermatology', mode: 'video', patient: { kind: 'self' }, useWalletBalance: true,
    requestKey: expect.stringMatching(/^[A-Za-z0-9_-]{8,64}$/),
  });
  const id = [...backend.requests.keys()][0]!;
  await expect.poll(() => posts(backend, `/instant/requests/${id}/activity`).length).toBeGreaterThanOrEqual(1);
  // A doctor (fee ₹300) accepts: ₹200 of the quote goes back to the wallet.
  Object.assign(backend.requests.get(id)!, { status: 'accepted', fundingState: 'allocated', acceptedBy: D1, acceptedFeeMinor: 30000, bookingId: BK,
    returned: { couponVoidedMinor: 0, walletMinor: 0, gatewayMinor: 20000, totalMinor: 20000 } });
  await expect(page.getByRole('heading', { name: 'A doctor accepted' })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/Dr\. Ravi Kumar is joining your video call\. ₹200\.00 \(the difference from your quote\) is back in your wallet\./)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Join the call' })).toHaveAttribute('href', 'https://meet.google.com/abc-defg-hij');
  await page.getByRole('link', { name: 'Open your consultation' }).click();
  await expect(page.getByRole('heading', { name: 'Consult now' })).toBeVisible();
  await expect(page.getByText(/cannot be cancelled/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel this booking' })).toHaveCount(0);
});

test('nobody accepted in time: offer it again to an online doctor within the paid amount', async ({ page }) => {
  const backend = await mockBackend(page);
  const id = 'e7'.repeat(12);
  backend.requests.set(id, request(id, { offerExpiresAt: inMin(-1) }));
  await signIn(page, `/consult/requests/${id}`);
  await expect(page.getByRole('heading', { name: 'Nobody accepted in time' })).toBeVisible();
  await expect(page.getByText(/get your ₹500\.00 back in your wallet/)).toBeVisible();
  await page.getByLabel(/Dr\. Ravi Kumar/).check();
  await page.getByRole('button', { name: 'Offer again' }).click();
  await expect(page.getByRole('heading', { name: 'Waiting for a doctor to accept' })).toBeVisible();
  expect(posts(backend, `/instant/requests/${id}/reoffer`)[0]!.body).toEqual({ target: { kind: 'specific', doctorId: D1 } });
});

test('ask for a refund to the wallet: the second step says what happens', async ({ page }) => {
  const backend = await mockBackend(page);
  const id = 'e8'.repeat(12);
  backend.requests.set(id, request(id, { offerExpiresAt: inMin(-1) }));
  await signIn(page, `/consult/requests/${id}`);
  await page.getByRole('button', { name: 'Cancel and refund to my wallet' }).click();
  await expect(page.getByText(/The request is closed and everything you paid \(₹500\.00\) goes back to your Jansetu wallet\. A doctor can no longer accept it\./)).toBeVisible();
  expect(posts(backend, `/instant/requests/${id}/refund`)).toHaveLength(0);
  await page.getByRole('button', { name: 'Yes, refund to my wallet' }).click();
  await expect(page.getByText('Refunded', { exact: true })).toBeVisible();
  await expect(page.getByText(/You asked for a refund, so the request was closed\. ₹500\.00 went back to your Jansetu wallet\./)).toBeVisible();
});

test('a refund refused because a doctor just accepted is explained', async ({ page }) => {
  const backend = await mockBackend(page);
  const id = 'e9'.repeat(12);
  backend.requests.set(id, request(id));
  await signIn(page, `/consult/requests/${id}`);
  await page.getByRole('button', { name: 'Cancel and refund to my wallet' }).click();
  Object.assign(backend.requests.get(id)!, { status: 'accepted', fundingState: 'allocated', bookingId: BK });
  await page.getByRole('button', { name: 'Yes, refund to my wallet' }).click();
  await expect(page.getByRole('heading', { name: 'A doctor accepted' })).toBeVisible();
});

test('closing the payment page leaves the request unpaid; pay again reuses the open order and starts the wait', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await page.evaluate(() => { (window as unknown as { __rz: string }).__rz = 'close'; });
  await chooseAny(page);
  await page.getByRole('button', { name: 'Pay and request a doctor' }).click();
  await expect(page.getByText(/This request is not paid yet\. Pay by/)).toBeVisible();
  await page.evaluate(() => { (window as unknown as { __rz: string }).__rz = 'pay'; });
  await page.getByRole('button', { name: 'Pay now' }).click();
  await expect(page.getByRole('heading', { name: 'Waiting for a doctor to accept' })).toBeVisible();
  expect(backend.records.size).toBe(1);
});

test('after the payment window, pay again is refused with what happens next', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await page.evaluate(() => { (window as unknown as { __rz: string }).__rz = 'close'; });
  await chooseAny(page);
  await page.getByRole('button', { name: 'Pay and request a doctor' }).click();
  await expect(page.getByRole('button', { name: 'Pay now' })).toBeVisible();
  backend.windowPassed = true;
  await page.getByRole('button', { name: 'Pay now' }).click();
  await expect(page.getByText(/The time to pay for this request has passed/)).toBeVisible();
});

test('errors: nobody online, a refused coupon, and a too-short speciality are shown where they happen', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await page.getByRole('link', { name: 'Consult now' }).click();
  await page.getByLabel('Speciality').fill('D');
  await page.getByRole('button', { name: 'See who is online' }).click();
  await expect(page.getByText('Enter a speciality, for example General Physician.')).toBeVisible();
  await page.getByLabel('Speciality').fill('Dermatology');
  await page.getByRole('button', { name: 'See who is online' }).click();
  await page.getByLabel(/Any available doctor/).check();
  await page.getByLabel('Coupon (optional)').fill('OLD10');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText('This coupon has expired')).toBeVisible();
  backend.nobodyOnline = true;
  await page.getByLabel('Speciality').fill('Dermatology ');
  await page.getByRole('button', { name: 'See who is online' }).click();
  await expect(page.getByText(/No Dermatology doctor is online for a video call right now/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Book a doctor for later' })).toBeVisible();
  expect(posts(backend, '/instant/requests')).toHaveLength(0);
});

test('consult now requests are listed with the bookings', async ({ page }) => {
  const backend = await mockBackend(page);
  const id = 'ea'.repeat(12);
  backend.requests.set(id, request(id, { offerExpiresAt: inMin(-1) }));
  await signIn(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Bookings', exact: true }).click();
  const list = page.getByRole('region', { name: 'Consult now requests' });
  await expect(list.getByRole('link', { name: /Video call · Dermatology/ })).toContainText('Nobody accepted yet');
});
