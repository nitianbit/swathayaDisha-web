import { expect, test, type Page, type Route } from '@playwright/test';

// WQ16: assisted booking phase 1b — a pharmacy pays a walk-in consultation by card or UPI (backend r10 `m0/r10-phase1b`
// 9f2a1807, design §23.3), cancels a card-paid booking with a refund to the card or the wallet, and an admin moves a
// failed card refund to the pharmacy's wallet. Against a mock of the backend's rules; Razorpay Checkout is a fake script.
const ME = 'b'.repeat(24);
const ADMIN = 'ad'.repeat(12);
const DOC = 'd1'.repeat(12);
const SLOT1 = '51'.repeat(12);
const BK = 'e1'.repeat(12);
const OTHER = 'e3'.repeat(12);
const REC = 'c1'.repeat(12);
const RF = 'f1'.repeat(12);
const PHONE = '9876543210';

type Json = Record<string, unknown>;
const istYmd = (ms: number) => new Date(ms + 330 * 60_000).toISOString().slice(0, 10).replace(/-/g, '');
const TOMORROW = istYmd(Date.now() + 86_400_000);
const CREATED = new Date(Date.now() - 5 * 60_000).toISOString();
const PAY_BY = new Date(Date.parse(CREATED) + 30 * 60_000).toISOString();
const hhmm = (iso: string) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Kolkata' }).format(new Date(iso));

const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const refuse = (route: Route, status: number, code: string | undefined, message = 'refused') => json(route, status, { error: status, ...(code ? { code } : {}), message });

interface Backend {
  calls: { method: string; path: string; body: Json | null }[];
  creates: Json[];
  verifies: Json[];
  reconciles: Json[];
  cancels: Json[];
  bookings: Json[];
  keys: Record<string, { hash: string; bookingId: string }>;
  record: { status: 'none' | 'created' | 'paid' | 'refunded'; captured: boolean };
  cardOn: boolean;
  /** The next card create holds the booking but its Razorpay order fails (502). */
  orderFailsOnce: boolean;
  /** The next verify answer is lost (the capture is recorded at Razorpay). */
  loseNextVerify: boolean;
  /** The booking expired before the capture: verify returns it to the card. */
  late: boolean;
  /** r10b: the next card create is refused: too many card bookings waiting for payment. */
  pendingLimit: boolean;
}

const view = (o: Json = {}): Json => ({
  _id: BK, status: 'pending', paymentStatus: 'pending', source: 'pharmacy_assisted', bookingDate: TOMORROW, bookingTime: '10:30', doctorName: 'Dr Meera Rao',
  specialistId: DOC, patientName: 'Rina Kumari', contactNo: PHONE, consultationMode: 'video', price: 500, updatedAt: CREATED, createdAt: CREATED,
  assisted: { shortRef: 'K7QXM2PA', bookedBy: { name: 'Asha Medicals' }, join: { on: 'partner_device' }, preferredLanguage: 'hi' }, ...o,
});

async function mockPharmacy(page: Page, init: { bookings?: Json[]; cardOn?: boolean } = {}): Promise<Backend> {
  const b: Backend = {
    calls: [], creates: [], verifies: [], reconciles: [], cancels: [], bookings: init.bookings ?? [], keys: {}, record: { status: 'none', captured: false },
    cardOn: init.cardOn ?? true, orderFailsOnce: false, loseNextVerify: false, late: false, pendingLimit: false,
  };
  let live = false;
  const booking = (id: string) => b.bookings.find((x) => x._id === id);
  const order = () => (b.record.status === 'created' && booking(BK)?.status === 'pending'
    ? { paymentRequired: true, paymentTransactionId: REC, razorpayOrderId: 'order_B1', razorpayKeyId: 'rzp_test', amount: 500, amountMinor: 50_000, currency: 'INR', payBy: PAY_BY }
    : null);
  /** The assisted_booking context handler: apply a capture once, or return it to the card. */
  const apply = (): Json => {
    const bk = booking(BK)!;
    if (b.record.status === 'created') {
      if (b.late || bk.status !== 'pending') { b.record.status = 'refunded'; Object.assign(bk, { status: 'cancelled', cancellationCause: 'payment_timeout' }); }
      else { b.record.status = 'paid'; Object.assign(bk, { status: 'confirmed', paymentStatus: 'paid' }); }
    }
    return { context: 'assisted_booking', paymentRecord: { status: b.record.status, isProcessed: true }, entity: bk };
  };

  await page.route('https://checkout.razorpay.com/v1/checkout.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: `window.Razorpay = function (o) {
      window.__rzOpened = (window.__rzOpened || 0) + 1;
      window.__rzLast = { key: o.key, order_id: o.order_id, amount: o.amount, currency: o.currency };
      this.on = function () {};
      this.open = function () { setTimeout(function () {
        if (window.__rzClose) o.modal.ondismiss();
        else o.handler({ razorpay_payment_id: 'pay_TEST1', razorpay_order_id: o.order_id, razorpay_signature: 'sig_TEST' });
      }, 10); };
    };`,
  }));

  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = req.method();
    const body = method === 'POST' || method === 'PUT' ? (req.postDataJSON() as Json | null) : null;
    b.calls.push({ method, path: `${path}${url.search}`, body });
    if (path === '/auth/pharmacy/send') return json(route, 200, { success: true });
    if (path === '/auth/pharmacy/verify') { live = true; return json(route, 200, { success: true, data: { token: 't1', expiresIn: 900, user: {} } }); }
    if (path === '/auth/session/refresh') {
      return live ? json(route, 200, { success: true, data: { token: 't1', expiresIn: 900, principal: { userId: ME, userType: 'pharmacy', sid: 's1' } } })
        : refuse(route, 401, 'SESSION_ENDED', 'Please sign in again');
    }
    if (path.startsWith('/auth/session')) return json(route, 200, { success: true, data: {} });
    if (req.headers().authorization !== 'Bearer t1') return refuse(route, 401, 'UNAUTHORIZED');
    if (path === '/auth/profile') return json(route, 200, { success: true, data: { user: { _id: ME, name: 'Asha Medicals' }, userRole: 'pharmacy' } });

    if (path === '/pharmacy-assisted/patients/lookup') return json(route, 200, { success: true, data: { exists: true, holderNameMasked: 'Rina K.' } });
    const slot = { slotId: SLOT1, date: TOMORROW, startTime: '10:30', endTime: '10:45', startsAt: '2026-11-24T05:00:00.000Z', modes: ['video'] };
    const doctor = { doctorId: DOC, name: 'Dr Meera Rao', specialization: 'General Physician', languages: ['Hindi'], city: 'Pune', experienceYears: 8, feeMinor: 50_000, nearby: 'pincode' };
    if (path === `/pharmacy-assisted/doctors/${DOC}/slots`) return json(route, 200, { success: true, data: { doctor, from: TOMORROW, to: TOMORROW, slots: [slot] } });
    if (path === '/pharmacy-assisted/doctors') return json(route, 200, { success: true, data: [{ ...doctor, nextSlot: slot }] });
    if (path === '/pharmacy-assisted/consultations' && method === 'POST') {
      b.creates.push(body!);
      const key = String(body!.requestKey);
      // r10: the method is not part of the request hash.
      const hash = JSON.stringify({ ...body, requestKey: undefined, paymentMethod: undefined });
      const prior = b.keys[key];
      const receipt = (replayed: boolean) => {
        const bk = booking(BK)!;
        return { booking: bk, funding: { method: 'razorpay', amountMinor: 50_000, state: bk.status === 'confirmed' ? 'captured' : 'pending', walletEntryId: null, paymentTransactionId: REC },
          split: { listMinor: 50_000, discountMinor: 0, couponCode: null }, payment: order(), newAccount: false, replayed };
      };
      if (prior) {
        if (prior.hash !== hash) return refuse(route, 409, 'IDEMPOTENCY_KEY_REUSED');
        if (b.record.status === 'none') b.record.status = 'created'; // the replay makes the order that failed before
        return json(route, 200, { success: true, data: receipt(true) });
      }
      if (body!.paymentMethod === 'wallet') {
        b.bookings.unshift(view({ _id: OTHER, status: 'confirmed', paymentStatus: 'paid' }));
        return json(route, 201, { success: true, data: { booking: booking(OTHER), funding: { method: 'wallet', amountMinor: 50_000, state: 'captured', walletEntryId: 'm9' },
          split: { listMinor: 50_000, discountMinor: 0, couponCode: null }, newAccount: false, replayed: false } });
      }
      if (!b.cardOn) return refuse(route, 400, 'PAYMENT_METHOD_UNAVAILABLE', 'Card and UPI payment of assisted bookings is not switched on; pay from the wallet');
      if (b.pendingLimit) return json(route, 429, { error: 429, code: 'ASSISTED_LIMIT_REACHED', message: 'Too many', limit: 'pending_card_bookings' });
      b.keys[key] = { hash, bookingId: BK };
      b.bookings.unshift(view());
      if (b.orderFailsOnce) {
        b.orderFailsOnce = false;
        return refuse(route, 502, 'RAZORPAY_ORDER_CREATION_FAILED', 'The card payment could not be started. The booking is held for 30 minutes: send the same request again (same requestKey) to retry');
      }
      b.record.status = 'created';
      return json(route, 201, { success: true, data: receipt(false) });
    }
    const byKey = /^\/pharmacy-assisted\/bookings\/by-key\/([A-Za-z0-9_-]+)$/.exec(path);
    if (byKey) {
      const k = b.keys[byKey[1]!];
      return json(route, 200, { success: true, data: k ? { state: 'used', booking: booking(k.bookingId), payment: order() } : { state: 'unknown' } });
    }
    const cancel = /^\/pharmacy-assisted\/bookings\/(\w{24})\/cancel$/.exec(path);
    if (cancel) {
      b.cancels.push(body!);
      const bk = booking(cancel[1]!)!;
      Object.assign(bk, { status: 'cancelled', cancellationCause: 'booker' });
      const toWallet = body!.refundTo === 'wallet';
      const refund = { refundId: RF, bookingId: bk._id, paymentRecordId: REC, amountMinor: 50_000, cause: 'booker', method: toWallet ? 'wallet' : 'card',
        state: toWallet ? 'processed' : 'pending', lastError: null, attempts: toWallet ? 0 : 1, razorpayRefundId: null, processedAt: null, createdAt: CREATED, updatedAt: CREATED };
      return json(route, 200, { success: true, data: { booking: bk, refundedMinor: toWallet ? 50_000 : 0, alreadyCancelled: false, refund } });
    }
    if (path === '/pharmacy-bookings') return json(route, 200, { success: true, data: b.bookings, pagination: { total: b.bookings.length, nextCursor: null } });
    const one = /^\/pharmacy-bookings\/(\w{24})$/.exec(path);
    if (one) return booking(one[1]!) ? json(route, 200, { success: true, data: booking(one[1]!) }) : refuse(route, 404, 'BOOKING_NOT_FOUND');

    if (path === '/payments/verify') {
      b.verifies.push(body!);
      b.record.captured = true;
      if (b.loseNextVerify) { b.loseNextVerify = false; return route.abort('connectionreset'); }
      return json(route, 200, { success: true, message: 'Payment verified successfully', data: apply() });
    }
    if (path === '/payments/reconcile') {
      b.reconciles.push(body!);
      if (b.record.status === 'refunded') return refuse(route, 400, 'PAYMENT_REFUNDED', 'Payment is already marked as refunded');
      if (!b.record.captured) return json(route, 200, { success: true, data: { state: 'unpaid', gatewayStatuses: [] } });
      return json(route, 200, { success: true, data: { state: 'paid', ...apply() } });
    }
    if (path === '/pharmacy-wallet') return json(route, 200, { success: true, data: { _id: 'w1', pharmacyId: ME, balance: 2000, balancePaise: 200_000, isActive: true, frozen: false, receivableMinor: 0 } });
    return refuse(route, 404, 'NOT_MOCKED', `Not mocked: ${method} ${path}`);
  });
  return b;
}

async function signIn(page: Page, to: string) {
  await page.goto('/');
  await page.getByLabel('Mobile number').fill('9000000001');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await page.getByRole('link', { name: to, exact: true }).first().click();
}

/** Patient, doctor and time, up to "Check and pay". */
async function toCheckAndPay(page: Page) {
  await page.getByLabel('Patient’s mobile number').fill(PHONE);
  await page.getByRole('button', { name: 'Find' }).click();
  await page.getByLabel('Patient’s full name').fill('Rina Kumari');
  await page.getByLabel('Patient agreed to this booking').check();
  await page.getByRole('button', { name: 'Next: choose the doctor' }).click();
  await page.getByRole('button', { name: 'Choose Dr Meera Rao' }).click();
  await page.getByRole('button', { name: '10:30–10:45' }).click();
  await page.getByLabel('On this pharmacy’s device').check();
  await page.getByLabel('Language the patient speaks').selectOption('hi');
  await page.getByRole('button', { name: 'Next: check the price' }).click();
  await expect(page.getByRole('group', { name: 'Check and pay' })).toBeVisible();
}

async function payByCard(page: Page) {
  const pay = page.getByRole('group', { name: 'Check and pay' });
  await pay.getByLabel('Pay by card or UPI').check();
  await pay.getByRole('button', { name: 'Pay ₹500.00 by card or UPI' }).click();
}

const nothingStored = async (page: Page, b: Backend, ...words: string[]) => {
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + location.href);
  for (const w of words) expect(stored).not.toContain(w);
  for (const c of b.calls) for (const w of words) expect(c.path).not.toContain(w);
};

test('card pay: the same body with paymentMethod razorpay, Checkout on the server’s order, verify without module, booked and paid', async ({ page }) => {
  const b = await mockPharmacy(page);
  await signIn(page, 'Book consultation');
  await toCheckAndPay(page);
  // The wallet stays the default way to pay.
  await expect(page.getByLabel('Pay from wallet')).toBeChecked();
  await payByCard(page);
  await expect(page.getByRole('heading', { name: 'Booked' })).toBeVisible();
  await expect(page.getByText('The consultation is booked and paid by card or UPI.')).toBeVisible();
  await expect(page.getByText('Paid by card or UPI: ₹500.00. Collect this from the patient.')).toBeVisible();
  expect(b.creates).toHaveLength(1);
  expect(b.creates[0]).toMatchObject({ phone: PHONE, slotId: SLOT1, acceptedPriceMinor: 50_000, paymentMethod: 'razorpay' });
  expect(await page.evaluate(() => (window as unknown as { __rzLast: unknown }).__rzLast)).toEqual({ key: 'rzp_test', order_id: 'order_B1', amount: 50_000, currency: 'INR' });
  expect(b.verifies).toEqual([{ paymentTransactionId: REC, razorpayOrderId: 'order_B1', razorpayPaymentId: 'pay_TEST1', razorpaySignature: 'sig_TEST' }]);
  expect(b.reconciles).toHaveLength(0);
  await nothingStored(page, b, PHONE, 'Rina Kumari', 'order_B1', 'pay_TEST1');
});

test('Checkout closed: the booking waits with its pay-by time; Booked consultations shows “Waiting for payment” and “Pay now” reopens the same order', async ({ page }) => {
  const b = await mockPharmacy(page);
  await signIn(page, 'Book consultation');
  await page.evaluate(() => { (window as unknown as { __rzClose: boolean }).__rzClose = true; });
  await toCheckAndPay(page);
  await payByCard(page);
  await expect(page.getByRole('heading', { name: 'Booking held: waiting for payment' })).toBeVisible();
  const panel = page.getByRole('group', { name: 'Waiting for payment' });
  await expect(panel.getByText(`Pay before ${hhmm(PAY_BY)} or the time is released.`).first()).toBeVisible();
  await expect(panel.getByText(/^Not paid yet\./)).toBeVisible();
  expect(b.reconciles).toEqual([{ paymentTransactionId: REC }]);
  expect(b.verifies).toHaveLength(0);

  // From the list: the booking waits for payment; Pay now opens it and pays the same order.
  await page.getByRole('link', { name: 'See booked consultations' }).click();
  const table = page.getByRole('table', { name: 'Booked consultations, newest first' });
  await expect(table.getByRole('cell', { name: 'Waiting for payment' })).toBeVisible();
  await table.getByRole('link', { name: /Pay now for the consultation of Rina Kumari/ }).click();
  await expect(page.getByText('Price', { exact: true })).toBeVisible();
  await expect(page.getByText('₹500.00 (not paid yet)')).toBeVisible();
  await page.evaluate(() => { (window as unknown as { __rzClose: boolean }).__rzClose = false; });
  await page.getByRole('button', { name: 'Pay now ₹500.00' }).click();
  await expect(page.getByText('Paid. The consultation is booked. The patient and the doctor are told.')).toBeVisible();
  await expect(page.getByText('Booked', { exact: true })).toBeVisible();
  expect(b.creates).toHaveLength(1);
  expect(await page.evaluate(() => (window as unknown as { __rzLast: { order_id: string } }).__rzLast.order_id)).toBe('order_B1');
  expect(b.verifies).toHaveLength(1);
});

test('a lost verify answer: the server’s check (reconcile) finds the payment; never claimed paid before', async ({ page }) => {
  const b = await mockPharmacy(page);
  await signIn(page, 'Book consultation');
  await toCheckAndPay(page);
  b.loseNextVerify = true;
  await payByCard(page);
  await expect(page.getByText('The consultation is booked and paid by card or UPI.')).toBeVisible();
  expect(b.verifies).toHaveLength(1);
  expect(b.reconciles).toEqual([{ paymentTransactionId: REC }]);
});

test('a late capture: the payment is refunded to the card and nothing is booked', async ({ page }) => {
  const b = await mockPharmacy(page);
  await signIn(page, 'Book consultation');
  await toCheckAndPay(page);
  b.late = true;
  await payByCard(page);
  await expect(page.getByRole('heading', { name: 'Not booked' })).toBeVisible();
  await expect(page.getByText(/The amount is being refunded to the card or UPI it was paid with\. Nothing is booked/)).toBeVisible();
  await expect(page.getByText('paid by card or UPI')).toHaveCount(0);
});

test('the order could not be made (502): the booking is held; the same request again gets the order and pays', async ({ page }) => {
  const b = await mockPharmacy(page);
  await signIn(page, 'Book consultation');
  await toCheckAndPay(page);
  b.orderFailsOnce = true;
  await payByCard(page);
  await expect(page.getByText(/The booking is held, but the card payment could not be started\. Send the same request again/)).toBeVisible();
  await page.getByRole('button', { name: 'Send the same request again' }).click();
  await expect(page.getByText('The consultation is booked and paid by card or UPI.')).toBeVisible();
  expect(b.creates).toHaveLength(2);
  expect(b.creates[1]).toEqual(b.creates[0]);
});

test('switch off: card is refused before anything; the card option says so and the wallet pays with a new request', async ({ page }) => {
  const b = await mockPharmacy(page, { cardOn: false });
  await signIn(page, 'Book consultation');
  await toCheckAndPay(page);
  await payByCard(page);
  const pay = page.getByRole('group', { name: 'Check and pay' });
  await expect(pay.getByText('Card payment is not switched on yet.', { exact: true })).toBeVisible();
  await expect(pay.getByLabel('Pay by card or UPI')).toBeDisabled();
  await expect(pay.getByLabel('Pay from wallet')).toBeChecked();
  await pay.getByRole('button', { name: 'Pay ₹500.00 from wallet' }).click();
  await expect(page.getByText('The consultation is booked and paid from your wallet.')).toBeVisible();
  expect(b.creates).toHaveLength(2);
  expect(b.creates[0]!.paymentMethod).toBe('razorpay');
  expect(b.creates[1]!.paymentMethod).toBe('wallet');
  expect(b.creates[1]!.requestKey).not.toBe(b.creates[0]!.requestKey);
});

async function bookPaidByCard(page: Page) {
  await signIn(page, 'Book consultation');
  await toCheckAndPay(page);
  await payByCard(page);
  await expect(page.getByText('The consultation is booked and paid by card or UPI.')).toBeVisible();
  await page.getByRole('link', { name: 'See booked consultations' }).click();
  await page.getByRole('link', { name: /Open the consultation of Rina Kumari/ }).click();
  await expect(page.getByText('Paid by card or UPI', { exact: true })).toBeVisible();
}

test('cancel a card-paid booking: refund to card (default), and the refund state in words', async ({ page }) => {
  const b = await mockPharmacy(page);
  await bookPaidByCard(page);
  await expect(page.getByLabel(/^Refund to card \(default\)/)).toBeChecked();
  await page.getByRole('button', { name: 'Cancel this consultation' }).click();
  await expect(page.getByText(/₹500\.00 goes back to the card or UPI it was paid with/)).toBeVisible();
  await page.getByRole('button', { name: 'Yes, cancel it' }).click();
  await expect(page.getByText('Cancelled. Refund of ₹500.00 to the card or UPI: in progress. It usually reaches the card in 5 to 7 working days. The patient and the doctor are told.')).toBeVisible();
  expect(b.cancels).toEqual([{ expectedUpdatedAt: CREATED, refundTo: 'card' }]);
});

test('cancel a card-paid booking: refund to wallet', async ({ page }) => {
  const b = await mockPharmacy(page);
  await bookPaidByCard(page);
  await page.getByLabel(/^Refund to wallet/).check();
  await page.getByRole('button', { name: 'Cancel this consultation' }).click();
  await expect(page.getByText(/₹500\.00 goes back to your Jansetu wallet/)).toBeVisible();
  await page.getByRole('button', { name: 'Yes, cancel it' }).click();
  await expect(page.getByText('Cancelled. ₹500.00 is back in your Jansetu wallet. This money pays for bookings; it cannot be withdrawn. The patient and the doctor are told.')).toBeVisible();
  expect(b.cancels).toEqual([{ expectedUpdatedAt: CREATED, refundTo: 'wallet' }]);
});

test('a booking not made on this device: no refund choice, neutral words; the answer’s refund is said', async ({ page }) => {
  const b = await mockPharmacy(page, { bookings: [view({ status: 'confirmed', paymentStatus: 'paid' })] });
  await signIn(page, 'Booked consultations');
  await page.getByRole('link', { name: /Open the consultation of Rina Kumari/ }).click();
  await expect(page.getByText('Amount paid', { exact: true })).toBeVisible();
  await expect(page.getByText(/The full amount goes back the way it was paid/)).toBeVisible();
  await expect(page.getByLabel(/^Refund to wallet/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel this consultation' }).click();
  await page.getByRole('button', { name: 'Yes, cancel it' }).click();
  await expect(page.getByText(/^Cancelled\. Refund of ₹500\.00 to the card or UPI: in progress\./)).toBeVisible();
  expect(b.cancels).toEqual([{ expectedUpdatedAt: CREATED }]);
});

// ── Admin: card refunds that need a person ──

async function mockAdmin(page: Page, init: { pending?: boolean } = {}) {
  const b = { calls: [] as { method: string; path: string; body: Json | null }[], loseNextMove: false, moved: false, pending: false, marked: false, loseNextMark: false };
  b.pending = !!init.pending;
  let live = false;
  const row = (): Json => ({ refundId: RF, bookingId: BK, paymentRecordId: REC, amountMinor: 50_000, cause: 'booker', method: b.moved ? 'wallet' : 'card',
    state: b.moved ? 'processed' : b.pending && !b.marked ? 'pending' : 'failed',
    lastError: b.moved ? null : b.marked ? 'MARKED_FAILED_BY_ADMIN' : b.pending ? 'GATEWAY_UNREACHABLE' : 'BAD_REQUEST_ERROR', attempts: 3, razorpayRefundId: null, processedAt: null,
    createdAt: '2026-11-22T04:30:00.000Z', updatedAt: '2026-11-22T05:30:00.000Z', pharmacyId: 'a1'.repeat(12), pharmacyName: 'Asha Medicals' });
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = req.method();
    const body = method === 'POST' ? (req.postDataJSON() as Json | null) : null;
    if (path === '/auth/session/refresh') {
      return live ? json(route, 200, { success: true, data: { token: 'admin', expiresIn: 900, principal: { userId: ADMIN, userType: 'admin', sid: 's1' } } })
        : refuse(route, 401, 'SESSION_ENDED');
    }
    if (path.startsWith('/auth/session')) return json(route, 200, { success: true, data: {} });
    b.calls.push({ method, path: `${path}${url.search}`, body });
    if (path === '/auth/admin/send') return json(route, 200, { success: true });
    if (path === '/auth/admin/verify') { live = true; return json(route, 200, { success: true, data: { token: 'admin', expiresIn: 900, user: {} } }); }
    if (req.headers().authorization !== 'Bearer admin') return refuse(route, 401, 'UNAUTHORIZED');
    if (path === '/auth/profile') return json(route, 200, { success: true, data: { user: { _id: ADMIN, name: 'Ops Admin' }, userRole: 'admin' } });
    if (path === '/pharmacies') return json(route, 200, { success: true, data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 1 } });
    if (path === '/admin/assisted/card-refunds') {
      const state = url.searchParams.get('state');
      const r = row();
      return json(route, 200, { success: true, data: (state ? r.state === state : ['failed', 'manual_review', 'pending'].includes(String(r.state))) ? [r] : [] });
    }
    if (path === `/admin/assisted/card-refunds/${RF}/recheck`) return json(route, 200, { success: true, data: { refund: row(), gateway: [] } });
    if (path === `/admin/assisted/card-refunds/${RF}/mark-failed`) {
      if (b.marked) return refuse(route, 409, 'REFUND_NOT_PENDING', 'Only a pending card refund can be marked failed');
      b.marked = true;
      if (b.loseNextMark) { b.loseNextMark = false; return route.abort('connectionreset'); }
      return json(route, 200, { success: true, data: { refund: row() } });
    }
    if (path === `/admin/assisted/card-refunds/${RF}/to-wallet`) {
      const replayed = b.moved;
      b.moved = true;
      if (b.loseNextMove) { b.loseNextMove = false; return route.abort('connectionreset'); }
      return json(route, 200, { success: true, data: { refund: row(), replayed } });
    }
    return refuse(route, 404, 'NOT_MOCKED', `Not mocked: ${method} ${path}`);
  });
  return b;
}

async function openAdminQueue(page: Page) {
  await page.goto('/');
  await page.getByLabel('Admin').check();
  await page.getByLabel('Mobile number').fill('9876543210');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Pharmacy wallets' }).click();
  return page.getByRole('region', { name: 'Card refunds of bookings that need a person' });
}

test('admin: a failed card refund is moved to the wallet with the pharmacy’s agreement; a lost answer is checked', async ({ page }) => {
  const b = await mockAdmin(page);
  await page.goto('/');
  await page.getByLabel('Admin').check();
  await page.getByLabel('Mobile number').fill('9876543210');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Pharmacy wallets' }).click();
  const section = page.getByRole('region', { name: 'Card refunds of bookings that need a person' });
  const table = section.getByRole('table', { name: 'Card refunds that need a person, oldest change first' });
  await expect(table.getByText('Refund to card failed')).toBeVisible();
  await expect(table.getByText('Cancelled by the pharmacy')).toBeVisible();
  await expect(table.getByRole('link', { name: 'Open the booking' })).toHaveAttribute('href', `#/admin/consultations/${BK}`);
  await table.getByRole('button', { name: /^Move the ₹500\.00 card refund of .* to the pharmacy’s wallet$/ }).click();
  await section.getByRole('button', { name: 'Next: check before moving' }).click();
  await expect(section.getByText(/^Write what the pharmacy agreed to/)).toBeVisible();
  await section.getByLabel('The pharmacy’s agreement').fill('  Owner agreed   on a call, 23 Nov ');
  await section.getByRole('button', { name: 'Next: check before moving' }).click();
  await expect(section.getByText('Agreement: Owner agreed on a call, 23 Nov')).toBeVisible();
  b.loseNextMove = true;
  await section.getByRole('button', { name: 'Yes, move to wallet' }).click();
  await expect(section.getByText(/The outcome of this request is not known yet/)).toBeVisible();
  await section.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(section.getByText(/^It was moved: the ₹500\.00 card refund of .* is in the pharmacy’s Jansetu wallet\.$/)).toBeVisible();
  const moves = b.calls.filter((c) => c.method === 'POST' && c.path.startsWith('/admin/'));
  expect(moves).toEqual([{ method: 'POST', path: `/admin/assisted/card-refunds/${RF}/to-wallet`, body: { agreement: 'Owner agreed on a call, 23 Nov' } }]);
  expect(b.calls.some((c) => c.path === '/admin/assisted/card-refunds?state=processed&limit=200')).toBe(true);
});

// ── WQ16b: the booker view's `payment` (r10c), the new refusals and admin actions (r10b) ──

const SERVER_PAY_BY = new Date(Date.parse(CREATED) + 17 * 60_000).toISOString(); // not createdAt + 30: the server's own time

test('another device: the server’s payment says it waits, with its pay-by time; Check payment finds it paid', async ({ page }) => {
  const b = await mockPharmacy(page, { bookings: [view({ payment: { method: 'razorpay', state: 'pending', payBy: SERVER_PAY_BY, paymentTransactionId: REC } })] });
  b.record = { status: 'created', captured: true }; // paid on the device that booked it; not applied yet
  await signIn(page, 'Booked consultations');
  await page.getByRole('link', { name: /Pay now for the consultation of Rina Kumari/ }).click();
  await expect(page.getByText(`Pay before ${hhmm(SERVER_PAY_BY)} or the time is released.`)).toBeVisible();
  await expect(page.getByText(/The payment page opens only in the browser tab where this booking was made/)).toBeVisible();
  await page.getByRole('button', { name: 'Check payment' }).click();
  await expect(page.getByText('Paid. The consultation is booked. The patient and the doctor are told.')).toBeVisible();
  expect(b.reconciles).toEqual([{ paymentTransactionId: REC }]);
});

test('another device: a card-paid booking (server’s payment) offers the refund choice and sends refundTo', async ({ page }) => {
  const b = await mockPharmacy(page, { bookings: [view({ status: 'confirmed', paymentStatus: 'paid', payment: { method: 'razorpay', state: 'captured', payBy: null, paymentTransactionId: REC } })] });
  await signIn(page, 'Booked consultations');
  await page.getByRole('link', { name: /Open the consultation of Rina Kumari/ }).click();
  await expect(page.getByText('Paid by card or UPI', { exact: true })).toBeVisible();
  await page.getByLabel(/^Refund to wallet/).check();
  await page.getByRole('button', { name: 'Cancel this consultation' }).click();
  await page.getByRole('button', { name: 'Yes, cancel it' }).click();
  await expect(page.getByText(/^Cancelled\. ₹500\.00 is back in your Jansetu wallet\./)).toBeVisible();
  expect(b.cancels).toEqual([{ expectedUpdatedAt: CREATED, refundTo: 'wallet' }]);
});

test('a wallet-paid booking (server’s payment): wallet words, no refund choice, no refundTo', async ({ page }) => {
  const b = await mockPharmacy(page, { bookings: [view({ status: 'confirmed', paymentStatus: 'paid', payment: { method: 'wallet', state: 'captured', payBy: null } })] });
  await signIn(page, 'Booked consultations');
  await page.getByRole('link', { name: /Open the consultation of Rina Kumari/ }).click();
  await expect(page.getByText('Paid from your wallet', { exact: true })).toBeVisible();
  await expect(page.getByText('The full amount goes back to your Jansetu wallet.')).toBeVisible();
  await expect(page.getByLabel(/^Refund to wallet/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel this consultation' }).click();
  await page.getByRole('button', { name: 'Yes, cancel it' }).click();
  expect(b.cancels).toEqual([{ expectedUpdatedAt: CREATED }]);
});

test('too many card bookings waiting for payment: said in words; the review stays', async ({ page }) => {
  const b = await mockPharmacy(page);
  await signIn(page, 'Book consultation');
  await toCheckAndPay(page);
  b.pendingLimit = true;
  await payByCard(page);
  await expect(page.getByText('Too many bookings are waiting for payment. Pay or cancel one of them first.')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Check and pay' })).toBeVisible();
  await expect(page.getByText(/The outcome of this request is not known yet/)).toHaveCount(0);
});

test('admin: the pharmacy is named; Recheck asks Razorpay; Mark failed with a reason (lost answer checked), then Move to wallet', async ({ page }) => {
  const b = await mockAdmin(page, { pending: true });
  const section = await openAdminQueue(page);
  const table = section.getByRole('table', { name: 'Card refunds that need a person, oldest change first' });
  await expect(table.getByRole('cell', { name: 'Asha Medicals' })).toBeVisible();
  await table.getByRole('button', { name: /^Recheck the ₹500\.00 card refund/ }).click();
  await expect(section.getByText(/Checked with Razorpay: Refund to card in progress\. Razorpay holds no refund of this payment yet\./)).toBeVisible();
  await expect(table.getByRole('button', { name: /^Move the / })).toHaveCount(0);
  await table.getByRole('button', { name: /^Mark the ₹500\.00 card refund of .* failed$/ }).click();
  await section.getByRole('button', { name: 'Next: check before marking' }).click();
  await expect(section.getByText('Write why it is marked failed.')).toBeVisible();
  await section.getByLabel('Why is it marked failed?').fill(' Razorpay support:  refund cannot be sent ');
  await section.getByRole('button', { name: 'Next: check before marking' }).click();
  await expect(section.getByText('Reason: Razorpay support: refund cannot be sent')).toBeVisible();
  b.loseNextMark = true;
  await section.getByRole('button', { name: 'Yes, mark failed' }).click();
  await section.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(section.getByText(/^It was marked failed: the ₹500\.00 card refund of .* of Asha Medicals\./)).toBeVisible();
  await expect(table.getByRole('button', { name: /^Move the ₹500\.00 card refund/ })).toBeVisible();
  expect(b.calls.filter((c) => c.path.endsWith('/mark-failed'))).toEqual([{ method: 'POST', path: `/admin/assisted/card-refunds/${RF}/mark-failed`, body: { reason: 'Razorpay support: refund cannot be sent' } }]);
  expect(b.calls.some((c) => c.path === '/admin/assisted/card-refunds?state=failed&limit=200')).toBe(true);
});
