import { expect, test, type Page, type Route } from '@playwright/test';

const ME = 'c1'.repeat(12);
const DOC = 'd0'.repeat(12);
const FREE_DOC = 'd1'.repeat(12);
const SLOT = '51'.repeat(12);
const MOTHER = 'f1'.repeat(12);

function todayIst() {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10).replace(/-/g, '');
}

interface Backend {
  calls: { method: string; path: string; body: unknown }[];
  bookings: Map<string, Record<string, unknown>>;
  /** Payment records: their order and whether Razorpay captured them. */
  records: Map<string, { bookingId: string; orderId: string; captured: boolean }>;
  verifyFails: boolean;
  createDrops: boolean;
}

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

async function mockBackend(page: Page): Promise<Backend> {
  const state: Backend = { calls: [], bookings: new Map(), records: new Map(), verifyFails: false, createDrops: false };
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const page1 = (route: Route, items: unknown[]) => json(route, 200, { success: true, data: items, pagination: { page: 1, limit: 20, total: items.length, totalPages: 1 } });
  let n = 0;
  const order = (bookingId: string) => {
    n += 1;
    const record = String(n).padStart(24, 'a');
    state.records.set(record, { bookingId, orderId: `order_${n}`, captured: false });
    return { paymentTransactionId: record, razorpayOrderId: `order_${n}`, razorpayKeyId: 'rzp_test_x', amount: 450, currency: 'INR' };
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
    state.calls.push({ method: req.method(), path, body });
    if (path === '/auth/user/send') return json(route, 200, { success: true });
    if (path === '/auth/user/verify') return json(route, 200, { success: true, data: { token: 't', user: {} } });
    if (path === '/auth/profile') return json(route, 200, { success: true, data: { user: { _id: ME, name: 'Asha Rao', phone: '9876543210', email: 'a@x.in', gender: 'Female', dateOfBirth: '19900101' }, userRole: 'user' } });
    if (path === `/wallet/user/${ME}`) return json(route, 200, { success: true, data: { _id: 'w', userId: ME, balance: 50, isActive: true } });
    if (path === '/dependents') return page1(route, [{ _id: MOTHER, userId: ME, name: 'Kamala Rao', relationship: 'Mother', isActive: true }]);
    if (path === '/specialists') return page1(route, [
      { _id: DOC, name: 'Dr. Meena Iyer', specialization: 'Cardiology', experienceYears: 12, consultationFee: 500, availability: { acceptVideoConsultations: true } },
      { _id: FREE_DOC, name: 'Dr. Free Clinic', specialization: 'General', isConsultationFree: true },
    ]);
    if (path === `/specialists/${DOC}`) return json(route, 200, { success: true, data: { _id: DOC, name: 'Dr. Meena Iyer', specialization: 'Cardiology', consultationFee: 500, availability: { acceptVideoConsultations: true } } });
    if (path === `/specialists/${FREE_DOC}`) return json(route, 200, { success: true, data: { _id: FREE_DOC, name: 'Dr. Free Clinic', isConsultationFree: true } });
    if (path.startsWith('/slots/specialist/')) {
      return json(route, 200, { success: true, data: [{ _id: SLOT, specialistId: DOC, date: url.searchParams.get('date'), startTime: '11:30 PM', endTime: '11:45 PM', maxBookings: 1, currentBookings: 0 }] });
    }
    if (path === '/coupons/validate') return json(route, 200, { success: true, data: { isValid: true, discountAmount: 50, finalAmount: 450, coupon: { code: 'WELCOME50' } } });
    if (path === '/bookings' && req.method() === 'POST') {
      if (state.createDrops) return route.abort('connectionreset');
      const id = String(state.bookings.size + 1).padStart(24, 'b');
      const b = body as Record<string, unknown>;
      const free = b.specialistId === FREE_DOC;
      const booking = { _id: id, bookingType: 'consultation', doctorName: free ? 'Dr. Free Clinic' : 'Dr. Meena Iyer', bookingDate: b.bookingDate,
        bookingTime: b.bookingTime, price: free ? 0 : 450, status: free ? 'confirmed' : 'pending', paymentStatus: free ? 'paid' : 'pending' } as Record<string, unknown>;
      state.bookings.set(id, booking);
      if (free) return json(route, 201, { success: true, data: { booking, paymentRequired: false } });
      const payment = order(id);
      booking.paymentTransactionId = payment.paymentTransactionId;
      return json(route, 201, { success: true, data: { booking, paymentRequired: true, payment } });
    }
    const m = /^\/bookings\/(\w{24})(\/retry-payment)?$/.exec(path);
    if (m) {
      const b = state.bookings.get(m[1]!)!;
      if (m[2]) { const payment = order(m[1]!); b.paymentTransactionId = payment.paymentTransactionId; return json(route, 200, { success: true, data: { booking: b, paymentRequired: true, payment } }); }
      return json(route, 200, { success: true, data: b });
    }
    if (path === '/payments/verify') {
      if (state.verifyFails) return json(route, 502, { error: 502, code: 'RAZORPAY_PAYMENT_FETCH_FAILED', message: 'Gateway busy' });
      const r = state.records.get((body as { paymentTransactionId: string }).paymentTransactionId)!;
      confirm(r.bookingId);
      return json(route, 200, { success: true, data: { context: 'booking', paymentRecord: { status: 'paid' }, entity: {} } });
    }
    if (path === '/payments/reconcile') {
      const r = state.records.get((body as { paymentTransactionId: string }).paymentTransactionId)!;
      if (!r.captured) return json(route, 200, { success: true, data: { state: 'unpaid', gatewayStatuses: [] } });
      confirm(r.bookingId);
      return json(route, 200, { success: true, data: { state: 'paid', paymentRecord: { status: 'paid' } } });
    }
    return json(route, 404, { error: 404, message: 'Not found' });
  });
  return state;
}

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Mobile number').fill('9876543210');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await page.getByRole('link', { name: 'Book a doctor' }).click();
}

async function bookPaid(page: Page) {
  await page.getByRole('link', { name: /Dr\. Meena Iyer/ }).click();
  await page.getByRole('button', { name: '11:30 PM' }).click();
  await page.getByLabel('For').selectOption({ label: 'Kamala Rao (Mother)' });
  await page.getByLabel('Video call').check();
  await page.getByLabel('What is it about?').fill('Chest pain on climbing stairs');
}

const posts = (b: Backend, path: string) => b.calls.filter((c) => c.method === 'POST' && c.path === path);

test('book a paid consultation for a family member, with a coupon and the wallet, and pay', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await bookPaid(page);
  await page.getByLabel('Coupon (optional)').fill('welcome50');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText('Coupon WELCOME50: ₹50.00 off.')).toBeVisible();
  await expect(page.getByLabel('Price')).toContainText('₹400.00'); // 500 − 50 coupon − 50 wallet
  await page.getByRole('button', { name: 'Book and pay' }).click();
  await expect(page.getByText('Confirmed', { exact: true })).toBeVisible();
  expect(posts(backend, '/bookings')[0]!.body).toEqual({
    bookingType: 'consultation', specialistId: DOC, slotId: SLOT, bookingDate: todayIst(), bookingTime: '11:30 PM',
    consultationMode: 'video', primaryConcern: 'Chest pain on climbing stairs', dependentId: MOTHER, couponCode: 'WELCOME50', useWalletBalance: true,
  });
  expect(posts(backend, '/payments/verify')[0]!.body).toEqual({
    paymentTransactionId: 'a'.repeat(23) + '1', razorpayOrderId: 'order_1', razorpayPaymentId: 'pay_1', razorpaySignature: 'sig_1',
  });
});

test('if the confirmation fails after paying, the server checks with Razorpay and the booking is confirmed', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.verifyFails = true;
  await signIn(page);
  await bookPaid(page);
  await page.getByRole('button', { name: 'Book and pay' }).click();
  await expect(page.getByText('Confirmed', { exact: true })).toBeVisible();
  expect(posts(backend, '/payments/reconcile').length).toBeGreaterThanOrEqual(1);
});

test('closing the payment page leaves the booking unpaid; the customer pays later from the booking', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await page.evaluate(() => { (window as unknown as { __rz: string }).__rz = 'close'; });
  await bookPaid(page);
  await page.getByRole('button', { name: 'Book and pay' }).click();
  await expect(page.getByText('This booking is not paid yet.', { exact: false })).toBeVisible();
  await page.evaluate(() => { (window as unknown as { __rz: string }).__rz = 'pay'; });
  await page.getByRole('button', { name: 'Pay now' }).click();
  await expect(page.getByText('Confirmed', { exact: true })).toBeVisible();
  expect(posts(backend, `/bookings/${'b'.repeat(23)}1/retry-payment`)).toHaveLength(1);
});

test('opening an unpaid booking whose payment was taken applies it (the lost-confirmation case)', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await page.evaluate(() => { (window as unknown as { __rz: string }).__rz = 'close'; });
  await bookPaid(page);
  await page.getByRole('button', { name: 'Book and pay' }).click();
  await expect(page.getByText('This booking is not paid yet.', { exact: false })).toBeVisible();
  // The money was taken by Razorpay, but no confirmation ever reached the server (e.g. the tab was closed).
  for (const r of backend.records.values()) r.captured = true;
  await page.reload();
  await page.getByLabel('Mobile number').fill('9876543210');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click(); // the deep link to the booking is kept
  await expect(page.getByText('Confirmed', { exact: true })).toBeVisible();
});

test('if the booking request gets no answer, it is not sent again', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.createDrops = true;
  await signIn(page);
  await bookPaid(page);
  await page.getByRole('button', { name: 'Book and pay' }).click();
  await expect(page.getByText(/could not confirm whether your booking was made/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Book and pay' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Go to My bookings' })).toBeVisible();
  expect(posts(backend, '/bookings')).toHaveLength(1);
});

test('a free consultation is booked without the payment page', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await page.getByRole('link', { name: /Dr\. Free Clinic/ }).click();
  await page.getByRole('button', { name: '11:30 PM' }).click();
  await page.getByLabel('What is it about?').fill('Routine check');
  await page.getByRole('button', { name: 'Book', exact: true }).click();
  await expect(page.getByText('Confirmed', { exact: true })).toBeVisible();
  expect(posts(backend, '/payments/verify')).toHaveLength(0);
});
