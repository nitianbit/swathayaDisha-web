import { expect, test, type Page, type Route } from '@playwright/test';

// WQ17: a pharmacy books a lab test for a walk-in patient (assisted booking phase 2a, backend r11 `m0/r11-phase2a` f5f171c9,
// design §24.11), lists what it booked, accepts a new time, cancels and opens the released report. Mocked API.
const ME = 'b'.repeat(24);
const LAB = 'a1'.repeat(12);
const BR = 'b1'.repeat(12);
const BR2 = 'b2'.repeat(12);
const SLOT = '51'.repeat(12);
const T1 = 'c1'.repeat(12);
const T2 = 'c2'.repeat(12);
const BK = 'e1'.repeat(12);
const OTHER = 'e9'.repeat(12);
const CARD_REC = 'c9'.repeat(12);
const PHONE = '9876543210';

type Json = Record<string, unknown>;
const istYmd = (ms: number) => new Date(ms + 330 * 60_000).toISOString().slice(0, 10);
const TOMORROW = istYmd(Date.now() + 86_400_000);
const STARTS = new Date(Date.parse(`${TOMORROW}T09:00:00+05:30`)).toISOString();

const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const refuse = (route: Route, status: number, code: string, message = 'refused', extra: Json = {}) => json(route, status, { error: status, code, message, ...extra });

interface Backend {
  calls: { method: string; path: string; body: Json | null }[];
  creates: Json[];
  cancels: Json[];
  accepts: Json[];
  keys: Record<string, { hash: string }>;
  bookings: Json[];
  walletPaise: number;
  /** The lab's price now (paise) for T1; T2 is 200.00. */
  t1Minor: number;
  loseNextCreateAnswer: boolean;
  labsOff: boolean;
  /** WQ17b: the next accept / cancel never reaches the server; the next accept is refused. */
  dropNextAccept: boolean;
  refuseNextAccept: boolean;
  dropNextCancel: boolean;
  /** WQ17c (r14): the card payment record of BK: created → captured at Razorpay → paid; reconcile's gateway statuses. */
  record: { status: 'none' | 'created' | 'paid' | 'refunded'; captured: boolean };
  gatewayStatuses: string[];
  verifies: Json[];
  reconciles: Json[];
}

const labView = (o: Json = {}): Json => ({
  _id: BK, source: 'pharmacy_assisted', partnerId: LAB, lab: { name: 'Sun Diagnostics' }, branchId: BR, branch: { name: 'Kothrud', address: '12 FC Road, Pune', phone: '0201234567' },
  visitMode: 'lab', slot: { slotId: SLOT, date: TOMORROW, startTime: '09:00', endTime: '09:30', startsAt: STARTS },
  items: [{ name: 'Complete blood count', kind: 'test', code: 'CBC' }], status: 'confirmed', statusVersion: 3, reschedule: null, collector: null, cancellation: null,
  lifecycle: {}, patientName: 'Rina Kumari', holder: { pharmacyCustomerId: null, name: 'Rina K.', typedName: null }, userId: 'f1'.repeat(12),
  assisted: { shortRef: 'L7QXM2PA', bookedBy: { name: 'Asha Medicals' }, preferredLanguage: 'hi' }, payment: { method: 'wallet', state: 'captured', payBy: null },
  report: { releases: [] }, createdAt: '2026-11-23T05:00:00.000Z', updatedAt: '2026-11-23T05:00:00.000Z', ...o,
});

async function mockBackend(page: Page, init: { bookings?: Json[]; walletPaise?: number } = {}): Promise<Backend> {
  const b: Backend = { calls: [], creates: [], cancels: [], accepts: [], keys: {}, bookings: init.bookings ?? [], walletPaise: init.walletPaise ?? 200_000,
    t1Minor: 30_000, loseNextCreateAnswer: false, labsOff: false,
    dropNextAccept: false, refuseNextAccept: false, dropNextCancel: false, record: { status: 'none', captured: false }, gatewayStatuses: [], verifies: [], reconciles: [] };
  const PAY_BY = new Date(Date.now() + 25 * 60_000).toISOString();
  const cardPayment = (): Json => ({ method: 'razorpay', state: 'pending', payBy: PAY_BY, paymentTransactionId: CARD_REC, razorpayOrderId: 'order_L1', razorpayKeyId: 'rzp_test' });
  const openOrder = (): Json | null => (b.record.status === 'created' && b.bookings.find((x) => x._id === BK)?.status === 'pending_payment'
    ? { paymentRequired: true, paymentTransactionId: CARD_REC, razorpayOrderId: 'order_L1', razorpayKeyId: 'rzp_test', amount: 300, amountMinor: 30_000, currency: 'INR', payBy: PAY_BY }
    : null);
  /** The assisted_lab_booking context handler: apply the capture once. */
  const applyCapture = (): Json => {
    const x = b.bookings.find((y) => y._id === BK)!;
    if (b.record.status === 'created') { b.record.status = 'paid'; Object.assign(x, { status: 'confirmed', payment: { method: 'razorpay', state: 'captured', payBy: null, paymentTransactionId: CARD_REC } }); }
    return { context: 'assisted_lab_booking', paymentRecord: { status: b.record.status, isProcessed: true }, entity: x };
  };
  await page.route('https://checkout.razorpay.com/v1/checkout.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: `window.Razorpay = function (o) {
      window.__rzOpened = (window.__rzOpened || 0) + 1;
      window.__rzLast = { key: o.key, order_id: o.order_id, amount: o.amount };
      this.on = function () {};
      this.open = function () { setTimeout(function () {
        if (window.__rzClose) o.modal.ondismiss();
        else o.handler({ razorpay_payment_id: 'pay_L1', razorpay_order_id: o.order_id, razorpay_signature: 'sig_L1' });
      }, 10); };
    };`,
  }));
  let live = false;
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = req.method();
    const body = method === 'POST' ? (req.postDataJSON() as Json | null) : null;
    b.calls.push({ method, path: `${path}${url.search}`, body });
    if (path === '/auth/pharmacy/send') return json(route, 200, { success: true });
    if (path === '/auth/pharmacy/verify') { live = true; return json(route, 200, { success: true, data: { token: 't1', expiresIn: 900, user: {} } }); }
    if (path === '/auth/session/refresh') {
      return live ? json(route, 200, { success: true, data: { token: 't1', expiresIn: 900, principal: { userId: ME, userType: 'pharmacy', sid: 's1' } } })
        : refuse(route, 401, 'SESSION_ENDED');
    }
    if (path.startsWith('/auth/session')) return json(route, 200, { success: true, data: {} });
    if (req.headers().authorization !== 'Bearer t1') return refuse(route, 401, 'UNAUTHORIZED');
    if (path === '/auth/profile') return json(route, 200, { success: true, data: { user: { _id: ME, name: 'Asha Medicals' }, userRole: 'pharmacy' } });

    if (path === '/pharmacy-assisted/patients/lookup') return json(route, 200, { success: true, data: { exists: true, holderNameMasked: 'Rina K.' } });
    if (path === '/pharmacy-bookings') return json(route, 200, { success: true, data: [], pagination: { total: 0, nextCursor: null } });
    if (path === '/pharmacy-assisted/labs') {
      if (b.labsOff) return refuse(route, 503, 'ASSISTED_BOOKING_DISABLED', 'Booking lab tests is not switched on yet');
      return json(route, 200, { success: true, data: [
        { partnerId: LAB, name: 'Sun Diagnostics', nearby: 'pincode', branches: [
          { branchId: BR, name: 'Kothrud', address: '12 FC Road, Pune', phone: '0201234567', homeCollection: true, inLab: true },
          { branchId: BR2, name: 'Baner', address: '4 Baner Road, Pune', phone: '0207654321', homeCollection: false, inLab: true }] },
      ] });
    }
    if (path === `/pharmacy-assisted/labs/${LAB}/catalogue`) {
      return json(route, 200, { success: true, data: [
        { itemId: T1, kind: 'test', name: 'Complete blood count', code: 'CBC', priceMinor: 30_000, price: 300, visitModes: ['lab', 'home'], preparation: 'No fasting' },
        { itemId: T2, kind: 'test', name: 'Thyroid profile', code: 'TFT', priceMinor: 20_000, price: 200, visitModes: ['lab', 'home'] },
      ] });
    }
    if (path === `/pharmacy-assisted/labs/branches/${BR}/slots`) {
      return json(route, 200, { success: true, data: [{ slotId: SLOT, date: TOMORROW, startTime: '09:00', endTime: '09:30', seatsLeft: 3 }] });
    }
    if (path === '/pharmacy-assisted/lab-bookings' && method === 'POST') {
      b.creates.push(body!);
      const key = String(body!.requestKey);
      const hash = JSON.stringify({ ...body, requestKey: undefined });
      const prior = b.keys[key];
      const card = body!.paymentMethod === 'razorpay';
      const receipt = (replayed: boolean) => ({ booking: b.bookings.find((x) => x._id === BK),
        funding: card ? { method: 'razorpay', amountMinor: body!.acceptedPriceMinor, state: 'pending', walletEntryId: null, paymentTransactionId: CARD_REC }
          : { method: 'wallet', amountMinor: body!.acceptedPriceMinor, state: 'captured', walletEntryId: 'w9' },
        split: { listMinor: body!.acceptedPriceMinor, discountMinor: 0, couponCode: null }, ...(card ? { payment: openOrder() } : {}), newAccount: false, replayed });
      if (prior) return prior.hash === hash ? json(route, 200, { success: true, data: receipt(true) }) : refuse(route, 409, 'IDEMPOTENCY_KEY_REUSED');
      const ids = body!.itemIds as string[];
      const price = (ids.includes(T1) ? b.t1Minor : 0) + (ids.includes(T2) ? 20_000 : 0);
      if (body!.acceptedPriceMinor !== price) return refuse(route, 409, 'PRICE_CHANGED', 'The price changed', { details: { priceMinor: price, listMinor: price, discountMinor: 0 } });
      if (card) {
        b.keys[key] = { hash };
        b.record = { status: 'created', captured: false };
        b.bookings.unshift(labView({ status: 'pending_payment', payment: cardPayment(), visitMode: body!.visitMode }));
        return json(route, 201, { success: true, data: receipt(false) });
      }
      if (b.walletPaise < price) return refuse(route, 409, 'INSUFFICIENT_BALANCE', 'Insufficient wallet balance');
      b.walletPaise -= price;
      b.keys[key] = { hash };
      b.bookings.unshift(labView({ visitMode: body!.visitMode, ...(body!.address ? { address: body!.address } : {}) }));
      if (b.loseNextCreateAnswer) { b.loseNextCreateAnswer = false; return route.abort('connectionreset'); }
      return json(route, 201, { success: true, data: receipt(false) });
    }
    const byKey = /^\/pharmacy-assisted\/lab-bookings\/by-key\/([A-Za-z0-9_-]+)(\/abandon)?$/.exec(path);
    if (byKey) {
      const x = b.bookings.find((y) => y._id === BK);
      const card = (x?.payment as Json | undefined)?.method === 'razorpay';
      return json(route, 200, { success: true, data: b.keys[byKey[1]!] ? { state: 'used', booking: x, ...(card ? { payment: openOrder() } : {}) } : { state: 'unknown' } });
    }
    if (path === '/payments/verify') {
      b.verifies.push(body!);
      b.record.captured = true;
      return json(route, 200, { success: true, data: applyCapture() });
    }
    if (path === '/payments/reconcile') {
      b.reconciles.push(body!);
      if (!b.record.captured) return json(route, 200, { success: true, data: { state: 'unpaid', gatewayStatuses: b.gatewayStatuses } });
      return json(route, 200, { success: true, data: { state: 'paid', ...applyCapture() } });
    }
    if (path === '/pharmacy-assisted/lab-bookings') return json(route, 200, { success: true, data: b.bookings, pagination: { total: b.bookings.length, nextCursor: null } });
    const one = /^\/pharmacy-assisted\/lab-bookings\/(\w{24})$/.exec(path);
    if (one) {
      const x = b.bookings.find((y) => y._id === one[1]);
      return x ? json(route, 200, { success: true, data: x }) : refuse(route, 404, 'LAB_BOOKING_NOT_FOUND', 'Lab booking not found');
    }
    const cancel = /^\/pharmacy-assisted\/lab-bookings\/(\w{24})\/cancel$/.exec(path);
    if (cancel) {
      b.cancels.push(body!);
      if (b.dropNextCancel) { b.dropNextCancel = false; return route.abort('connectionreset'); }
      const x = b.bookings.find((y) => y._id === cancel[1])!;
      const card = (x.payment as Json | undefined)?.method === 'razorpay';
      Object.assign(x, { status: 'cancelled', statusVersion: 4, cancellation: { reason: 'partner', byKind: 'booker', at: '2026-11-23T06:00:00.000Z' } });
      if (card) {
        const toWallet = body!.refundTo === 'wallet';
        Object.assign(x, { payment: { ...(x.payment as Json), state: 'refunded' } });
        const refund = { refundId: 'f1'.repeat(12), bookingId: x._id, paymentRecordId: CARD_REC, amountMinor: 30_000, cause: 'booker', method: toWallet ? 'wallet' : 'card',
          state: toWallet ? 'processed' : 'pending', lastError: null, attempts: toWallet ? 0 : 1, razorpayRefundId: null, processedAt: null, createdAt: STARTS, updatedAt: STARTS };
        return json(route, 200, { success: true, data: { booking: x, refundedMinor: toWallet ? 30_000 : 0, alreadyCancelled: false, refund } });
      }
      b.walletPaise += 30_000;
      return json(route, 200, { success: true, data: { booking: x, refundedMinor: 30_000, alreadyCancelled: false } });
    }
    const accept = /^\/pharmacy-assisted\/lab-bookings\/(\w{24})\/accept-reschedule$/.exec(path);
    if (accept) {
      b.accepts.push(body!);
      if (b.dropNextAccept) { b.dropNextAccept = false; return route.abort('connectionreset'); }
      if (b.refuseNextAccept) { b.refuseNextAccept = false; return refuse(route, 409, 'RESCHEDULE_CHANGED', 'The lab changed the time again'); }
      const x = b.bookings.find((y) => y._id === accept[1])!;
      Object.assign(x, { reschedule: { ...(x.reschedule as Json), pending: false }, statusVersion: 5 });
      return json(route, 200, { success: true, data: x });
    }
    if (path === '/file/fetch') return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: '%PDF-1.4\n%%EOF\n' });
    if (path === '/pharmacy-wallet') return json(route, 200, { success: true, data: { _id: 'w1', pharmacyId: ME, balance: b.walletPaise / 100, balancePaise: b.walletPaise, isActive: true, frozen: false, receivableMinor: 0 } });
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

async function patientReady(page: Page) {
  await page.getByLabel('Patient’s mobile number').fill(PHONE);
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(page.getByText('Account holder: Rina K.')).toBeVisible();
  await page.getByLabel('Patient’s full name').fill('Rina Kumari');
  await page.getByLabel('Patient agreed to this booking').check();
  await page.getByRole('button', { name: 'Next: choose the lab' }).click();
}

async function chooseLabTests(page: Page, opts: { home?: boolean; both?: boolean } = {}) {
  if (opts.home) await page.getByLabel('Home collection').check();
  await expect(page.getByText('Near you')).toBeVisible();
  await page.getByRole('button', { name: 'Choose Sun Diagnostics' }).click();
  if (!opts.home) await page.getByLabel(/^Kothrud/).check();
  await page.getByLabel(/^Complete blood count/).check();
  if (opts.both) await page.getByLabel(/^Thyroid profile/).check();
  await page.getByRole('button', { name: /09:00–09:30$/ }).click();
  await page.getByLabel('Language the patient speaks').selectOption('hi');
}

const nothingStored = async (page: Page, b: Backend, ...words: string[]) => {
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + location.href);
  for (const w of words) expect(stored).not.toContain(w);
  for (const c of b.calls) for (const w of words) expect(c.path).not.toContain(w);
};

test('book a lab test: the same patient step, a nearby lab, branch, tests, time, price and pay from the wallet', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page, 'Book lab test');
  await expect(page.getByRole('heading', { name: 'Book lab test' })).toBeVisible();
  await patientReady(page);
  await chooseLabTests(page, { both: true });
  await expect(page.getByLabel(/Note/)).toHaveCount(0); // r11 never stores a note: none is offered
  await page.getByRole('button', { name: 'Next: check the price' }).click();
  const pay = page.getByRole('group', { name: 'Check and pay' });
  await expect(pay.getByText('Complete blood count, Thyroid profile')).toBeVisible();
  await expect(pay.getByText('Money in your wallet: ₹2,000.00')).toBeVisible();
  await pay.getByRole('button', { name: 'Pay ₹500.00 from wallet' }).click();
  await expect(page.getByRole('heading', { name: 'Booked' })).toBeVisible();
  await expect(page.getByText('L7QXM2PA')).toBeVisible();
  await expect(page.getByText('Paid from your wallet: ₹500.00')).toBeVisible();
  expect(b.creates).toHaveLength(1);
  expect(b.creates[0]).toMatchObject({ phone: PHONE, patient: { relation: 'self', name: 'Rina Kumari' }, partnerId: LAB, branchId: BR, visitMode: 'lab', slotId: SLOT,
    itemIds: [T1, T2], acceptedPriceMinor: 50_000, preferredLanguage: 'hi', paymentMethod: 'wallet', consent: { agreed: true, statementLanguage: 'en' } });
  expect(b.creates[0]!.address).toBeUndefined();
  // r11 validates `notes` but never stores or shows it: no note is offered or sent.
  expect(b.creates[0]!.notes).toBeUndefined();
  expect(b.calls.some((c) => c.path === '/pharmacy-assisted/labs?visitMode=lab&limit=50')).toBe(true);
  await nothingStored(page, b, PHONE, 'Rina Kumari');
});

test('home collection: one branch is chosen at once, the address is required and sent', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page, 'Book lab test');
  await patientReady(page);
  await chooseLabTests(page, { home: true });
  await page.getByRole('button', { name: 'Next: check the price' }).click();
  await expect(page.getByText('Enter the house number and street (at least 3 characters).')).toBeVisible();
  await page.getByLabel('House and street').fill('Flat 4, Lane 7');
  await page.getByLabel('City').fill('Pune');
  await page.getByLabel('Pincode').fill('411038');
  await page.getByRole('button', { name: 'Next: check the price' }).click();
  await page.getByRole('button', { name: 'Pay ₹300.00 from wallet' }).click();
  await expect(page.getByRole('heading', { name: 'Booked' })).toBeVisible();
  expect(b.creates[0]).toMatchObject({ visitMode: 'home', branchId: BR, address: { line1: 'Flat 4, Lane 7', city: 'Pune', pincode: '411038' } });
  await nothingStored(page, b, 'Flat 4', '411038');
});

test('a lost answer and a reload: only the key is kept; Check finds the booking, never booked twice', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page, 'Book lab test');
  await patientReady(page);
  await chooseLabTests(page);
  await page.getByRole('button', { name: 'Next: check the price' }).click();
  b.loseNextCreateAnswer = true;
  await page.getByRole('button', { name: 'Pay ₹300.00 from wallet' }).click();
  await expect(page.getByText(/The outcome of this request is not known yet/)).toBeVisible();
  await page.reload();
  await expect(page.getByText(/A lab booking made earlier on this device .* was not confirmed/)).toBeVisible();
  await page.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(page.getByRole('heading', { name: 'Already booked' })).toBeVisible();
  await expect(page.getByText('L7QXM2PA')).toBeVisible();
  // WQ17b M1: the booker view carries no price, so none is shown (never "₹0.00").
  await expect(page.getByText(/^Price:/)).toHaveCount(0);
  await expect(page.getByText('₹0.00')).toHaveCount(0);
  expect(b.creates).toHaveLength(1);
  await nothingStored(page, b, PHONE, 'Rina Kumari');
});

test('price changed: the new price is said, then paid with a new request; not enough money says top up', async ({ page }) => {
  const b = await mockBackend(page);
  b.t1Minor = 35_000;
  await signIn(page, 'Book lab test');
  await patientReady(page);
  await chooseLabTests(page);
  await page.getByRole('button', { name: 'Next: check the price' }).click();
  await page.getByRole('button', { name: 'Pay ₹300.00 from wallet' }).click();
  await expect(page.getByText(/The price has changed\. It is now ₹350/)).toBeVisible();
  await page.getByRole('button', { name: 'Use the new price (₹350.00)' }).click();
  b.walletPaise = 10_000;
  await page.getByRole('button', { name: 'Pay ₹350.00 from wallet' }).click();
  await expect(page.getByText('Your Jansetu wallet does not have enough money for this booking. Top up the wallet, then pay again.')).toBeVisible();
  expect(b.creates).toHaveLength(2);
  expect(b.creates[1]!.acceptedPriceMinor).toBe(35_000);
  expect(b.creates[1]!.requestKey).not.toBe(b.creates[0]!.requestKey);
});

test('booked lab tests: list, open, cancel up to 1 hour before (refund to the wallet, with the version)', async ({ page }) => {
  const b = await mockBackend(page, { bookings: [labView()] });
  await signIn(page, 'Booked lab tests');
  const table = page.getByRole('table', { name: 'Booked lab tests, newest first' });
  await expect(table.getByRole('cell', { name: 'Complete blood count' })).toBeVisible();
  await expect(page.getByLabel('Status').locator('option', { hasText: 'Visited' })).toHaveCount(1); // WQ17b L4
  await table.getByRole('link', { name: /Open the lab test of Rina Kumari/ }).click();
  await expect(page.getByText('L7QXM2PA')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel this lab test' }).click();
  await page.getByRole('button', { name: 'Yes, cancel it' }).click();
  await expect(page.getByText('Cancelled. ₹300.00 is back in your Jansetu wallet. The patient is told.')).toBeVisible();
  expect(b.cancels).toEqual([{ expectedVersion: 3 }]);
});

test('a new time from the lab: accept it with the proposal version; cancel is offered too', async ({ page }) => {
  const b = await mockBackend(page, { bookings: [labView({ reschedule: { pending: true, version: 2, previousSlot: { date: TOMORROW, startTime: '08:00' }, reason: 'Collector unwell', at: '2026-11-23T06:00:00.000Z' } })] });
  await signIn(page, 'Booked lab tests');
  await page.getByRole('link', { name: /Open the lab test of Rina Kumari/ }).click();
  await expect(page.getByText(/The lab proposed a new time/)).toBeVisible();
  await expect(page.getByText('While the new time is not answered you can cancel at any time.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Accept new time' }).click();
  await expect(page.getByText(/^New time accepted: .* at 09:00\. The patient is told\.$/)).toBeVisible();
  expect(b.accepts).toEqual([{ version: 2 }]);
});

test('a released report opens from the booking (the file route), and the cancel is closed within the hour', async ({ page }) => {
  const soon = new Date(Date.now() + 30 * 60_000).toISOString();
  const b = await mockBackend(page, { bookings: [labView({ slot: { slotId: SLOT, date: TOMORROW, startTime: '09:00', endTime: '09:30', startsAt: soon },
    report: { releases: [{ file: `/api/static/partner-lab-reports/${BK}/report-1.pdf`, releasedAt: '2026-11-23T08:00:00.000Z', signer: { name: 'Dr A Rao' } }] } })] });
  await signIn(page, 'Booked lab tests');
  await page.getByRole('link', { name: /Open the lab test of Rina Kumari/ }).click();
  await expect(page.getByText('It is too late to cancel this one here.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel this lab test' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open the report' }).click();
  await expect(page.getByTitle('Lab report')).toBeVisible();
  const fetches = b.calls.filter((c) => c.path.startsWith('/file/fetch'));
  expect(fetches).toHaveLength(1);
  expect(decodeURIComponent(fetches[0]!.path)).toContain(`partner-lab-reports/${BK}/report-1.pdf`);
});

test('another pharmacy’s booking (or none) is "not found"; the switch off hides booking', async ({ page }) => {
  const b = await mockBackend(page, { bookings: [labView()] });
  await signIn(page, 'Booked lab tests');
  await page.goto(`/#/pharmacy/lab-tests/${OTHER}`);
  await expect(page.getByText('Lab test not found', { exact: true })).toBeVisible();
  expect(b.calls.some((c) => c.path === `/pharmacy-assisted/lab-bookings/${OTHER}`)).toBe(true);
  b.labsOff = true;
  await page.getByRole('link', { name: 'Book lab test', exact: true }).first().click();
  await patientReady(page);
  await expect(page.getByText(/Booking lab tests for patients is not switched on yet\./)).toBeVisible();
});

// ── WQ17b ──

const proposal = { reschedule: { pending: true, version: 2, previousSlot: { date: TOMORROW, startTime: '08:00' }, reason: 'Collector unwell', at: '2026-11-23T06:00:00.000Z' } };

test('WQ17b L1: a lost accept is not claimed when the booking was cancelled meanwhile', async ({ page }) => {
  const b = await mockBackend(page, { bookings: [labView(proposal)] });
  await signIn(page, 'Booked lab tests');
  await page.getByRole('link', { name: /Open the lab test of Rina Kumari/ }).click();
  b.dropNextAccept = true;
  await page.getByRole('button', { name: 'Accept new time' }).click();
  await expect(page.getByText(/The outcome of accepting the new time is not known yet/)).toBeVisible();
  Object.assign(b.bookings[0]!, { status: 'cancelled', reschedule: { ...proposal.reschedule, pending: false } });
  await page.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(page.getByText('Not accepted so far. It may still be on its way. Sending it again is safe.')).toBeVisible();
  await expect(page.getByText('The new time is accepted.')).toHaveCount(0);
});

test('WQ17b L2: a refused accept is said and the booking is read again', async ({ page }) => {
  const b = await mockBackend(page, { bookings: [labView(proposal)] });
  await signIn(page, 'Booked lab tests');
  await page.getByRole('link', { name: /Open the lab test of Rina Kumari/ }).click();
  const reads = () => b.calls.filter((c) => c.method === 'GET' && c.path === `/pharmacy-assisted/lab-bookings/${BK}`).length;
  await expect(page.getByRole('button', { name: 'Accept new time' })).toBeVisible();
  const before = reads();
  b.refuseNextAccept = true;
  await page.getByRole('button', { name: 'Accept new time' }).click();
  await expect(page.getByText('The lab changed the time again. Look at the new time, then accept it or cancel.')).toBeVisible();
  await expect.poll(reads).toBeGreaterThan(before);
});

test('WQ17b L3: a lost cancel, when found, says what the server did with the money', async ({ page }) => {
  const b = await mockBackend(page, { bookings: [labView()] });
  await signIn(page, 'Booked lab tests');
  await page.getByRole('link', { name: /Open the lab test of Rina Kumari/ }).click();
  b.dropNextCancel = true;
  await page.getByRole('button', { name: 'Cancel this lab test' }).click();
  await page.getByRole('button', { name: 'Yes, cancel it' }).click();
  await expect(page.getByText(/The outcome of this request is not known yet/)).toBeVisible();
  Object.assign(b.bookings[0]!, { status: 'cancelled', payment: { method: 'wallet', state: 'forfeited', payBy: null } });
  await page.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(page.getByText('Cancelled. Nothing was refunded.')).toBeVisible();
});

// ── WQ17c: a lab test paid by card or UPI (r14 phase 2b, §24.14), on the consultation's card machinery ──

async function payLabByCard(page: Page) {
  const pay = page.getByRole('group', { name: 'Check and pay' });
  await pay.getByLabel('Pay by card or UPI').check();
  await pay.getByRole('button', { name: 'Pay ₹300.00 by card or UPI' }).click();
}
const opened = (page: Page) => page.evaluate(() => (window as unknown as { __rzOpened?: number }).__rzOpened ?? 0);

test('WQ17c card: the same body with paymentMethod razorpay, Checkout on the server’s order, verify, booked and paid', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page, 'Book lab test');
  await patientReady(page);
  await chooseLabTests(page);
  await page.getByRole('button', { name: 'Next: check the price' }).click();
  await payLabByCard(page);
  await expect(page.getByText('The lab test is booked and paid by card or UPI.')).toBeVisible();
  await expect(page.getByText('Paid by card or UPI: ₹300.00. Collect this from the patient.')).toBeVisible();
  expect(b.creates).toHaveLength(1);
  expect(b.creates[0]).toMatchObject({ paymentMethod: 'razorpay', acceptedPriceMinor: 30_000, itemIds: [T1] });
  expect(await page.evaluate(() => (window as unknown as { __rzLast: unknown }).__rzLast)).toEqual({ key: 'rzp_test', order_id: 'order_L1', amount: 30_000 });
  expect(b.verifies).toEqual([{ paymentTransactionId: CARD_REC, razorpayOrderId: 'order_L1', razorpayPaymentId: 'pay_L1', razorpaySignature: 'sig_L1' }]);
  await nothingStored(page, b, PHONE, 'Rina Kumari');
});

test('WQ17c card: Checkout closed, the booking waits; Pay now reopens the same order after asking the server', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page, 'Book lab test');
  await page.evaluate(() => { (window as unknown as { __rzClose: boolean }).__rzClose = true; });
  await patientReady(page);
  await chooseLabTests(page);
  await page.getByRole('button', { name: 'Next: check the price' }).click();
  await payLabByCard(page);
  await expect(page.getByRole('heading', { name: 'Booking held: waiting for payment' })).toBeVisible();
  await expect(page.getByText(/^Not paid yet\./)).toBeVisible();
  await page.evaluate(() => { (window as unknown as { __rzClose: boolean }).__rzClose = false; });
  await page.getByRole('button', { name: 'Pay now ₹300.00' }).click();
  await expect(page.getByText('The lab test is booked and paid by card or UPI.')).toBeVisible();
  expect(b.creates).toHaveLength(1);
  expect(await opened(page)).toBe(2);
  expect(b.reconciles.length).toBeGreaterThanOrEqual(2); // after the close, and before reopening
});

test('WQ17c card, another device: an authorized payment at Razorpay means no second Checkout', async ({ page }) => {
  const b = await mockBackend(page, { bookings: [labView({ status: 'pending_payment',
    payment: { method: 'razorpay', state: 'pending', payBy: new Date(Date.now() + 20 * 60_000).toISOString(), paymentTransactionId: CARD_REC, razorpayOrderId: 'order_L1', razorpayKeyId: 'rzp_test' } })] });
  b.record = { status: 'created', captured: false };
  b.gatewayStatuses = ['authorized'];
  await signIn(page, 'Booked lab tests');
  const table = page.getByRole('table', { name: 'Booked lab tests, newest first' });
  await expect(table.getByText('Waiting for payment')).toBeVisible();
  await table.getByRole('link', { name: /Open the lab test of Rina Kumari/ }).click();
  await page.getByRole('button', { name: 'Pay now' }).click();
  await expect(page.getByText('Razorpay reported the payment; it is being confirmed. Do not pay again. Tap “Check payment” in a minute.')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Pay now/ })).toHaveCount(0);
  expect(await opened(page)).toBe(0);
});

const cardPaid = () => labView({ payment: { method: 'razorpay', state: 'captured', payBy: null, paymentTransactionId: CARD_REC } });

test('WQ17c card: cancel a card-paid lab test with the refund to the card (default)', async ({ page }) => {
  const b = await mockBackend(page, { bookings: [cardPaid()] });
  await signIn(page, 'Booked lab tests');
  await page.getByRole('link', { name: /Open the lab test of Rina Kumari/ }).click();
  await expect(page.getByLabel(/^Refund to card \(default\)/)).toBeChecked();
  await page.getByRole('button', { name: 'Cancel this lab test' }).click();
  await page.getByRole('button', { name: 'Yes, cancel it' }).click();
  await expect(page.getByText('Cancelled. Refund of ₹300.00 to the card or UPI: in progress. It usually reaches the card in 5 to 7 working days. The patient is told.')).toBeVisible();
  expect(b.cancels).toEqual([{ expectedVersion: 3, refundTo: 'card' }]);
});

test('WQ17c card: cancel a card-paid lab test with the refund to the wallet', async ({ page }) => {
  const b = await mockBackend(page, { bookings: [cardPaid()] });
  await signIn(page, 'Booked lab tests');
  await page.getByRole('link', { name: /Open the lab test of Rina Kumari/ }).click();
  await page.getByLabel(/^Refund to wallet/).check();
  await page.getByRole('button', { name: 'Cancel this lab test' }).click();
  await page.getByRole('button', { name: 'Yes, cancel it' }).click();
  await expect(page.getByText('Cancelled. ₹300.00 is back in your Jansetu wallet. This money pays for bookings; it cannot be withdrawn. The patient is told.')).toBeVisible();
  expect(b.cancels).toEqual([{ expectedVersion: 3, refundTo: 'wallet' }]);
});
