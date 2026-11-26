import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * WQ24: a lab member books a doctor consultation for a walk-in patient (backend r21, round 2e, design §24.17) against a
 * mocked backend: the pharmacy's screens on the lab's routes (`/partner-workspace/assisted/*` with the member's branch),
 * paid from the lab wallet or by card (verified on the lab's own payment routes), a lost answer checked by key or given up
 * after a reload, a changed price, cancels with the refund to the wallet and to the card, the dispensing copy, branch
 * scope, the permission and the switch. Amounts in paise, as the server answers.
 */
const LAB = 'a1'.repeat(12);
const OTHER_LAB = 'a2'.repeat(12);
const OWNER = 'b1'.repeat(12);
const STAFF = 'b2'.repeat(12);
const BR1 = 'c1'.repeat(12);
const BR2 = 'c2'.repeat(12);
const DOC = 'd1'.repeat(12);
const SLOT1 = '51'.repeat(12);
const SLOT2 = '52'.repeat(12);
const P1 = 'e6'.repeat(12);
const REC = 'c9'.repeat(12);
const RF = 'f1'.repeat(12);
const W1 = 'e1'.repeat(12);
const C1 = 'e2'.repeat(12);
const C2 = 'e3'.repeat(12);
const FAR = 'e4'.repeat(12);
const ELSEWHERE = 'e5'.repeat(12);
const PHONE = '9876543210';
/** Wednesday 25 Nov 2026, 10:00 in India; the consultations are tomorrow at 10:30. */
const NOW = new Date('2026-11-25T04:30:00.000Z');
const CREATED = new Date(NOW.getTime() - 5 * 60_000).toISOString();
const PAY_BY = new Date(Date.parse(CREATED) + 30 * 60_000).toISOString();
const ALL = ['staff.manage', 'branches.manage', 'catalogue.manage', 'slots.manage', 'bookings.view', 'bookings.manage', 'reports.upload',
  'reports.release', 'invoices.create', 'invoices.cancel', 'payments.record', 'finance.view', 'wallet.view', 'wallet.manage', 'assisted.book'];

type Rec = Record<string, unknown>;
interface Me { _id: string; partnerId: string; name: string; role: 'owner' | 'staff'; permissions: string[]; branchIds: string[] }
interface Backend {
  calls: { method: string; path: string; body: Rec | null; auth?: string }[];
  me: Me;
  live: boolean;
  /** The doctor's fee now (a create accepting another price is 409 PRICE_CHANGED). */
  feeMinor: number;
  walletMinor: number;
  /** Booker views, with the branch (`_branch`) and lab (`_lab`) the mock keeps beside them. */
  bookings: Rec[];
  keys: Record<string, { bookingId?: string; hash?: string; abandoned?: boolean }>;
  record: { status: 'none' | 'created' | 'paid'; bookingId?: string };
  /** `ASSISTED_BOOKING_ENABLED_LAB` is off. */
  off?: boolean;
  /** The next create is made, then its answer is lost. */
  loseAfter?: boolean;
  /** The next create is lost before it reaches the server. */
  dropNext?: boolean;
  /** WQ24b: the lab's verification was revoked (r21b `admitLabBooker`: 403 PARTNER_NOT_VERIFIED before counting). */
  unverified?: boolean;
  /** WQ24b: background reads (the lab, its branches, one booking) are lost on the network. */
  failReads?: boolean;
  /** WQ24b re-check: the doctor reads answer 503 with no code (a proxy during a deploy). */
  doctorsDown?: boolean;
}

const doctor = { doctorId: DOC, name: 'Dr Meera Rao', specialization: 'General Physician', languages: ['Hindi'], city: 'Bengaluru', experienceYears: 8, feeMinor: 50_000, nearby: 'pincode' };
const slot = { slotId: SLOT1, date: '20261126', startTime: '10:30', endTime: '10:45', startsAt: '2026-11-26T05:00:00.000Z', modes: ['video'] };
const slot2 = { slotId: SLOT2, date: '20261126', startTime: '11:00', endTime: '11:15', startsAt: '2026-11-26T05:30:00.000Z', modes: ['video'] };
const order = { paymentRequired: true, paymentTransactionId: REC, razorpayOrderId: 'order_L1', razorpayKeyId: 'rzp_test', amount: 500, amountMinor: 50_000, currency: 'INR', payBy: PAY_BY };

function row(id: string, o: Rec = {}): Rec {
  return {
    _id: id, status: 'confirmed', paymentStatus: 'paid', source: 'lab_assisted', bookingDate: '20261126', bookingTime: '10:30', doctorName: 'Dr Meera Rao',
    specialistId: DOC, slotId: SLOT1, userId: 'u1'.repeat(12), patientName: 'Rina Kumari', contactNo: PHONE, consultationMode: 'video', price: 500,
    holder: { name: 'Rina Kumari', typedName: 'Rina Kumari' }, updatedAt: CREATED, createdAt: CREATED,
    assisted: { shortRef: 'K7QXM2PA', bookedBy: { name: 'City Lab' }, join: { on: 'partner_device' }, preferredLanguage: 'hi' },
    payment: { method: 'wallet', state: 'captured', payBy: null }, _branch: BR1, _lab: LAB, ...o,
  };
}
const cardPaid = (id: string): Rec => row(id, { payment: { method: 'razorpay', state: 'captured', payBy: null, paymentTransactionId: REC } });
const strip = (r: Rec | undefined): Rec | undefined => { if (!r) return r; const { _branch, _lab, ...v } = r; void _branch; void _lab; return v; };

async function mockBackend(page: Page, me: Me, init: { bookings?: Rec[]; record?: Backend['record'] } = {}): Promise<Backend> {
  await page.clock.setFixedTime(NOW);
  const b: Backend = { calls: [], me, live: false, feeMinor: 50_000, walletMinor: 200_000, bookings: init.bookings ?? [], keys: {}, record: init.record ?? { status: 'none' } };
  const partner = { _id: LAB, kind: 'lab', name: 'City Lab', contact: { phone: '9000000000' }, verification: { state: 'verified' }, taxRegime: 'unregistered',
    invoiceSeries: { prefix: 'LB' }, activeOwnerCount: 1, isActive: true };
  const branches = [
    { _id: BR1, partnerId: LAB, name: 'Indiranagar', address: { line1: '1 Main Rd', city: 'Bengaluru', state: 'Karnataka', stateCode: '29', pincode: '560038' },
      services: { homeCollection: true, inLab: true }, isActive: true },
    { _id: BR2, partnerId: LAB, name: 'Koramangala', address: { line1: '2 Ring Rd', city: 'Bengaluru', state: 'Karnataka', stateCode: '29', pincode: '560034' },
      services: { homeCollection: false, inLab: true }, isActive: true },
  ];
  let seq = 0;
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const ok = (route: Route, data: unknown, status = 200, extra: Rec = {}) => json(route, status, { success: true, data, ...extra });
  const fail = (route: Route, status: number, code: string, message: string, extra: Rec = {}) => json(route, status, { error: status, code, message, ...extra });
  const can = (p: string) => b.me.role === 'owner' || b.me.permissions.includes(p);
  const inScope = (branchId: unknown) => b.me.role === 'owner' || b.me.branchIds.includes(String(branchId));
  const mine = (r: Rec | undefined) => !!r && r._lab === LAB && inScope(r._branch);
  const find = (id: string) => b.bookings.find((r) => r._id === id);
  const isCard = (r: Rec) => (r.payment as Rec).method === 'razorpay';
  const openOrder = (r: Rec) => (isCard(r) && r.status === 'pending' ? order : null);
  const receipt = (r: Rec, replayed: boolean) => ({
    booking: strip(r), funding: { method: isCard(r) ? 'razorpay' : 'wallet', amountMinor: b.feeMinor, state: r.status === 'confirmed' ? 'captured' : 'pending',
      walletEntryId: isCard(r) ? null : 'm1', ...(isCard(r) ? { paymentTransactionId: REC } : {}) },
    split: { listMinor: b.feeMinor, discountMinor: 0, couponCode: null }, ...(isCard(r) ? { payment: openOrder(r) } : {}), newAccount: false, replayed,
  });
  const captured = () => {
    const r = find(b.record.bookingId!)!;
    b.record.status = 'paid';
    Object.assign(r, { status: 'confirmed', paymentStatus: 'paid', payment: { method: 'razorpay', state: 'captured', payBy: null, paymentTransactionId: REC } });
    return { context: 'assisted_booking', paymentRecord: { status: 'paid', isProcessed: true }, entity: strip(r) };
  };

  await page.route('https://checkout.razorpay.com/v1/checkout.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: `window.Razorpay = function (o) {
      window.__rzLast = { key: o.key, order_id: o.order_id, amount: o.amount, currency: o.currency };
      this.on = function () {};
      window.__rzOpened = (window.__rzOpened || 0) + 1;
      this.open = function () { setTimeout(function () {
        if (window.__rzClose) o.modal.ondismiss();
        else o.handler({ razorpay_payment_id: 'pay_L1', razorpay_order_id: o.order_id, razorpay_signature: 'sig_L1' });
      }, 10); };
    };`,
  }));
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = req.method();
    const body = ['POST', 'PUT'].includes(method) ? (req.postDataJSON() as Rec | null) : null;
    if (path === '/auth/session/refresh') {
      if (!b.live) return fail(route, 401, 'SESSION_ENDED', 'Please sign in again');
      return ok(route, { token: 't1', expiresIn: 900, principal: { userId: b.me._id, userType: 'partner', sid: 's1' } });
    }
    if (path.startsWith('/auth/session')) return ok(route, {});
    b.calls.push({ method, path: `${path}${url.search}`, body, auth: req.headers().authorization });
    if (path === '/auth/partner/send') return ok(route, undefined);
    if (path === '/auth/partner/verify') { b.live = true; return ok(route, { token: 't1', expiresIn: 900, user: {} }); }
    if (req.headers().authorization !== 'Bearer t1') return fail(route, 401, 'UNAUTHORIZED', 'Authentication is required');
    if (path === '/auth/profile') return ok(route, { user: { ...b.me, phone: '9000000001', isActive: true }, partner, userRole: 'partner' });
    if (path === '/file/fetch') {
      const id = /bookings\/([0-9a-f]{24})\/rx-dispense-1\.pdf$/.exec(url.searchParams.get('url') ?? '')?.[1];
      if (!id || !mine(find(id))) return fail(route, 404, 'FILE_NOT_FOUND', 'File not found');
      return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: '%PDF-1.4\n%%EOF\n' });
    }
    const ws = /^\/partner-workspace(\/.*)$/.exec(path);
    if (!ws) return fail(route, 404, 'NOT_FOUND', 'Not found');
    const sub = ws[1]!;
    if ((sub === '/me' || sub === '/branches') && b.failReads) return route.abort('failed');
    if (sub === '/me') return ok(route, partner);
    if (sub === '/branches') return ok(route, branches);
    const as = /^\/assisted(\/.*)$/.exec(sub)?.[1];
    if (!as) return fail(route, 404, 'NOT_FOUND', 'Not found');

    // 2d: the lab wallet (`wallet.view`) and the payment routes (`wallet.manage` or, r21, `assisted.book`).
    if (as === '/wallet') {
      return can('wallet.view') ? ok(route, { balanceMinor: b.walletMinor, withdrawableMinor: 0, receivableMinor: 0, frozen: false, isActive: true, updatedAt: NOW.toISOString() })
        : fail(route, 403, 'INSUFFICIENT_PERMISSIONS', 'Missing permissions: wallet.view');
    }
    if (as === '/payments/verify' && method === 'POST') {
      if (body?.paymentTransactionId !== REC || b.record.status === 'none') return fail(route, 404, 'PAYMENT_RECORD_NOT_FOUND', 'Payment record not found');
      return ok(route, captured());
    }
    if (as === '/payments/reconcile' && method === 'POST') {
      if (body?.paymentTransactionId !== REC) return fail(route, 404, 'PAYMENT_RECORD_NOT_FOUND', 'Payment record not found');
      return b.record.status === 'paid' ? ok(route, { state: 'paid', ...captured() }) : ok(route, { state: 'unpaid', gatewayStatuses: [] });
    }

    // r21: the lab books doctors (`assisted.book`, its branch scope).
    if (!can('assisted.book')) return fail(route, 403, 'INSUFFICIENT_PERMISSIONS', 'Missing permissions: assisted.book');
    /** r21: the doctor reads and the create name a branch in the member's scope. */
    const branchProblem = (id: unknown): [number, string, string] | null => (!id ? [400, 'VALIDATION_ERROR', '"branchId" is required']
      : !inScope(id) ? [403, 'BRANCH_SCOPE_EXCEEDED', 'Operation not allowed for this branch'] : null);
    if (as === '/patients/lookup' && method === 'POST') {
      if (b.unverified) return fail(route, 403, 'PARTNER_NOT_VERIFIED', 'Partner verification is required for this operation');
      if (b.off) return fail(route, 503, 'ASSISTED_BOOKING_DISABLED', 'Booking for patients is not switched on');
      return ok(route, body?.phone === PHONE ? { exists: true, holderNameMasked: 'R*** K***' } : { exists: false, holderNameMasked: null });
    }
    if ((as === '/doctors' || as === `/doctors/${DOC}/slots`) && b.doctorsDown) return json(route, 503, { message: 'Service Unavailable' });
    if (as === '/doctors' || as === `/doctors/${DOC}/slots`) {
      const problem = branchProblem(url.searchParams.get('branchId'));
      if (problem) return fail(route, ...problem);
      return as === '/doctors' ? ok(route, [{ ...doctor, nextSlot: slot }]) : ok(route, { doctor, from: '20261125', to: '20261201', slots: [slot, slot2] });
    }
    if (as === '/consultations' && method === 'POST') {
      if (b.dropNext) { b.dropNext = false; return route.abort('failed'); }
      if (b.off) return fail(route, 503, 'ASSISTED_BOOKING_DISABLED', 'Booking for patients is not switched on');
      const x = body as Rec & { requestKey: string; branchId?: string; acceptedPriceMinor: number; paymentMethod: string };
      const problem = branchProblem(x.branchId);
      if (problem) return fail(route, ...problem);
      const hash = JSON.stringify({ ...x, requestKey: undefined, paymentMethod: undefined });
      const prior = b.keys[x.requestKey];
      if (prior?.abandoned) return fail(route, 409, 'REQUEST_ABANDONED', 'This request was given up');
      if (prior?.bookingId) {
        if (prior.hash !== hash) return fail(route, 409, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different booking');
        return ok(route, receipt(find(prior.bookingId)!, true));
      }
      if (x.acceptedPriceMinor !== b.feeMinor) {
        return fail(route, 409, 'PRICE_CHANGED', 'The price changed', { details: { priceMinor: b.feeMinor, listMinor: b.feeMinor, discountMinor: 0 } });
      }
      const id = `ab${String(++seq).padStart(22, '0')}`;
      const card = x.paymentMethod === 'razorpay';
      if (!card) {
        if (b.walletMinor < b.feeMinor) return fail(route, 409, 'INSUFFICIENT_BALANCE', 'Not enough money in the wallet');
        b.walletMinor -= b.feeMinor;
      }
      const r = row(id, {
        _branch: x.branchId, price: b.feeMinor / 100, patientName: (x.patient as Rec).name ?? 'Patient', createdAt: CREATED,
        ...(card ? { status: 'pending', paymentStatus: 'pending', payment: { method: 'razorpay', state: 'pending', payBy: PAY_BY, paymentTransactionId: REC,
          razorpayOrderId: order.razorpayOrderId, razorpayKeyId: order.razorpayKeyId } } : {}),
      });
      b.bookings.unshift(r);
      b.keys[x.requestKey] = { bookingId: id, hash };
      if (card) b.record = { status: 'created', bookingId: id };
      if (b.loseAfter) { b.loseAfter = false; return route.abort('failed'); }
      return ok(route, receipt(r, false), 201);
    }
    if (as === '/bookings' && method === 'GET') {
      const items = b.bookings.filter(mine).map(strip);
      return ok(route, items, 200, { pagination: { total: items.length, nextCursor: null } });
    }
    const key = /^\/bookings\/by-key\/([A-Za-z0-9_-]+)(\/abandon)?$/.exec(as);
    if (key) {
      const k = b.keys[key[1]!];
      const r = k?.bookingId ? find(k.bookingId) : undefined;
      if (r) return ok(route, { state: 'used', booking: strip(r), ...(isCard(r) ? { payment: openOrder(r) } : {}) });
      if (key[2]) { b.keys[key[1]!] = { abandoned: true }; return ok(route, { state: 'abandoned' }); }
      return ok(route, k?.abandoned ? { state: 'abandoned' } : { state: 'unknown' });
    }
    const one = /^\/bookings\/([0-9a-f]{24})(\/cancel|\/reschedule)?$/.exec(as);
    if (one) {
      const r = find(one[1]!);
      if (!mine(r)) return fail(route, 404, 'BOOKING_NOT_FOUND', 'Booking not found');
      if (!one[2]) return b.failReads ? route.abort('failed') : ok(route, strip(r));
      if (one[2] === '/reschedule') {
        const to = [slot, slot2].find((x) => x.slotId === body?.slotId);
        if (!to) return fail(route, 409, 'SLOT_NOT_AVAILABLE', 'This slot is not available');
        Object.assign(r!, { slotId: to.slotId, bookingDate: to.date, bookingTime: to.startTime, updatedAt: NOW.toISOString() });
        return ok(route, { booking: strip(r), replayed: false });
      }
      const wasCard = isCard(r!);
      Object.assign(r!, { status: 'cancelled', cancellationCause: 'booker', updatedAt: NOW.toISOString() });
      if (!wasCard) {
        b.walletMinor += 50_000;
        return ok(route, { booking: strip(r), refundedMinor: 50_000, alreadyCancelled: false });
      }
      const toWallet = body?.refundTo === 'wallet';
      if (toWallet) b.walletMinor += 50_000;
      const refund = { refundId: RF, bookingId: r!._id, paymentRecordId: REC, amountMinor: 50_000, cause: 'booker', method: toWallet ? 'wallet' : 'card',
        state: toWallet ? 'processed' : 'pending', lastError: null, attempts: toWallet ? 0 : 1, razorpayRefundId: null, processedAt: null, createdAt: CREATED, updatedAt: CREATED };
      return ok(route, { booking: strip(r), refundedMinor: toWallet ? 50_000 : 0, alreadyCancelled: false, refund });
    }
    return fail(route, 404, 'NOT_FOUND', 'Not found');
  });
  return b;
}

const owner: Me = { _id: OWNER, partnerId: LAB, name: 'Ravi Owner', role: 'owner', permissions: ALL, branchIds: [] };
const staff = (permissions: string[], branchIds = [BR1]): Me => ({ _id: STAFF, partnerId: LAB, name: 'Sita Staff', role: 'staff', permissions, branchIds });

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Lab or clinic staff').check();
  await page.getByLabel('Mobile number').fill('9000000001');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}
const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' });
const creates = (b: Backend) => b.calls.filter((c) => c.method === 'POST' && c.path === '/partner-workspace/assisted/consultations').map((c) => c.body!);

/** The patient (the phone's owner, by name) and the agreement, with the lab's consent words. */
async function patient(page: Page) {
  await page.getByLabel('Patient’s mobile number').fill(PHONE);
  await page.getByRole('button', { name: 'Find' }).click();
  await page.getByLabel('Patient’s full name').fill('Rina Kumari');
  // WQ54c: the full statement behind Read more.
  await page.getByText('Read more').click();
  await expect(page.getByText(/this lab books this consultation for them on Jansetu/)).toBeVisible();
  await page.getByLabel('Patient agreed to this booking').check();
  await page.getByRole('button', { name: 'Next: choose the doctor' }).click();
}
/** The doctor, the time, where the patient joins and the language, up to "Check and pay". */
async function doctorAndTime(page: Page) {
  await page.getByRole('button', { name: 'Choose Dr Meera Rao' }).click();
  await page.getByRole('button', { name: '10:30–10:45' }).click();
  await page.getByLabel('On this lab’s device').check();
  await page.getByLabel('Language the patient speaks').selectOption('hi');
  await page.getByRole('button', { name: 'Next: check the price' }).click();
  await expect(page.getByRole('group', { name: 'Check and pay' })).toBeVisible();
}
const nothingStored = async (page: Page, b: Backend, ...words: string[]) => {
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + location.href);
  for (const w of words) expect(stored).not.toContain(w);
  for (const c of b.calls) for (const w of words) expect(c.path).not.toContain(w);
};

test('book with the lab wallet: the branch chosen, the doctors near it, the lab consent, one keyed create paid from the lab wallet', async ({ page }) => {
  const b = await mockBackend(page, owner);
  await signIn(page);
  await nav(page).getByRole('link', { name: 'Book consultation' }).click();
  await expect(page.getByRole('heading', { name: 'Book consultation', level: 1 })).toBeVisible();
  await patient(page);
  // An owner works at both branches: the branch is chosen before the doctors are read.
  await expect(page.getByText('Choose the branch first: doctors near it are shown first.')).toBeVisible();
  await page.getByLabel('Branch the patient is at').selectOption({ label: 'Koramangala' });
  await doctorAndTime(page);
  const pay = page.getByRole('group', { name: 'Check and pay' });
  await expect(pay.getByText('Booked at: Koramangala')).toBeVisible();
  await expect(pay.getByText('Money in your wallet: ₹2,000.00')).toBeVisible();
  await expect(pay.getByLabel('Pay from wallet')).toBeChecked();
  await pay.getByRole('button', { name: 'Pay ₹500.00 from wallet' }).click();
  await expect(page.getByRole('heading', { name: 'Booked', exact: true })).toBeVisible();
  await expect(page.getByText('The consultation is booked and paid from your wallet.')).toBeVisible();
  await expect(page.getByText('Paid from your wallet: ₹500.00. Collect this from the patient.')).toBeVisible();
  expect(creates(b)).toHaveLength(1);
  expect(creates(b)[0]).toMatchObject({ phone: PHONE, branchId: BR2, slotId: SLOT1, acceptedPriceMinor: 50_000, paymentMethod: 'wallet',
    consent: { agreed: true, statementVersion: 'web-lab-consult-v1', statementLanguage: 'en' }, patient: { relation: 'self', name: 'Rina Kumari' } });
  expect(String(creates(b)[0]!.requestKey)).toMatch(/^[A-Za-z0-9]{32}$/);
  expect(b.calls.some((c) => c.path.startsWith(`/partner-workspace/assisted/doctors?branchId=${BR2}`))).toBe(true);
  expect(b.calls.some((c) => c.path === '/partner-workspace/assisted/wallet')).toBe(true);
  expect(b.walletMinor).toBe(150_000);
  // The pharmacy's routes are never used for a lab.
  expect(b.calls.some((c) => /^\/(pharmacy-|payments\/)/.test(c.path))).toBe(false);
  await page.getByRole('link', { name: 'See booked consultations' }).click();
  await expect(page.getByRole('table', { name: 'Booked consultations, newest first' }).getByRole('cell', { name: 'Rina Kumari', exact: true })).toBeVisible();
  await nothingStored(page, b, PHONE, 'Rina Kumari');
});

test('book by card: one branch chosen at once, the balance hidden without wallet.view, Checkout on the server’s order, verified on the lab’s route', async ({ page }) => {
  const b = await mockBackend(page, staff(['assisted.book']));
  await signIn(page);
  await expect(nav(page).getByRole('link', { name: 'Wallet', exact: true })).toHaveCount(0);
  await nav(page).getByRole('link', { name: 'Book consultation' }).click();
  await patient(page);
  await expect(page.getByLabel('Branch the patient is at')).toHaveCount(0);
  await doctorAndTime(page);
  const pay = page.getByRole('group', { name: 'Check and pay' });
  await expect(pay.getByText('Your lab’s Jansetu wallet pays for this booking. Your account cannot see its balance.')).toBeVisible();
  await pay.getByLabel('Pay by card or UPI').check();
  await pay.getByRole('button', { name: 'Pay ₹500.00 by card or UPI' }).click();
  await expect(page.getByRole('heading', { name: 'Booked', exact: true })).toBeVisible();
  await expect(page.getByText('The consultation is booked and paid by card or UPI.')).toBeVisible();
  expect(creates(b)[0]).toMatchObject({ branchId: BR1, paymentMethod: 'razorpay', acceptedPriceMinor: 50_000 });
  expect(await page.evaluate(() => (window as unknown as { __rzLast: unknown }).__rzLast)).toEqual({ key: 'rzp_test', order_id: 'order_L1', amount: 50_000, currency: 'INR' });
  const verify = b.calls.filter((c) => c.path === '/partner-workspace/assisted/payments/verify');
  expect(verify.map((c) => c.body)).toEqual([{ paymentTransactionId: REC, razorpayOrderId: 'order_L1', razorpayPaymentId: 'pay_L1', razorpaySignature: 'sig_L1' }]);
  expect(b.calls.some((c) => c.path === '/payments/verify' || c.path === '/partner-workspace/assisted/wallet')).toBe(false);
  await nothingStored(page, b, PHONE, 'Rina Kumari', 'order_L1', 'pay_L1');
});

test('a lost answer: the outcome is not known; the check by key finds it booked; nothing is booked or paid twice', async ({ page }) => {
  const b = await mockBackend(page, staff(['assisted.book', 'wallet.view']));
  await signIn(page);
  await page.goto('/#/partner/book-consultation');
  await patient(page);
  await doctorAndTime(page);
  b.loseAfter = true;
  await page.getByRole('button', { name: 'Pay ₹500.00 from wallet' }).click();
  await expect(page.getByText(/The outcome of this request is not known yet/)).toBeVisible();
  await page.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(page.getByRole('heading', { name: 'Already booked' })).toBeVisible();
  await expect(page.getByText('K7QXM2PA')).toBeVisible();
  expect(creates(b)).toHaveLength(1);
  expect(b.walletMinor).toBe(150_000);
  const key = String(creates(b)[0]!.requestKey);
  expect(b.calls.some((c) => c.path === `/partner-workspace/assisted/bookings/by-key/${key}`)).toBe(true);
  await nothingStored(page, b, PHONE, 'Rina Kumari');
});

test('a lost answer and a reload: only the key is kept; giving it up makes sure it is never booked', async ({ page }) => {
  const b = await mockBackend(page, owner);
  await signIn(page);
  await page.goto('/#/partner/book-consultation');
  await patient(page);
  await page.getByLabel('Branch the patient is at').selectOption({ label: 'Indiranagar' });
  await doctorAndTime(page);
  b.dropNext = true;
  await page.getByRole('button', { name: 'Pay ₹500.00 from wallet' }).click();
  await expect(page.getByText(/The outcome of this request is not known yet/)).toBeVisible();
  await page.reload();
  await expect(page.getByText(/A booking made earlier on this device .* was not confirmed/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send the same request again' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Give this up' }).click();
  await expect(page.getByText('Given up: nothing was booked or charged with that request')).toBeVisible();
  const abandon = b.calls.filter((c) => /^\/partner-workspace\/assisted\/bookings\/by-key\/[A-Za-z0-9]{32}\/abandon$/.test(c.path));
  expect(abandon).toHaveLength(1);
  expect(b.bookings).toHaveLength(0);
  expect(b.walletMinor).toBe(200_000);
  await nothingStored(page, b, PHONE, 'Rina Kumari');
});

test('the price changed: said with the new price; paying at it is a new request', async ({ page }) => {
  const b = await mockBackend(page, staff(['assisted.book', 'wallet.view']));
  await signIn(page);
  await page.goto('/#/partner/book-consultation');
  await patient(page);
  await doctorAndTime(page);
  b.feeMinor = 45_000;
  await page.getByRole('button', { name: 'Pay ₹500.00 from wallet' }).click();
  await expect(page.getByText('The price has changed. It is now ₹450.00. Check it with the patient, then pay again.')).toBeVisible();
  await page.getByRole('button', { name: 'Use the new price (₹450.00)' }).click();
  await page.getByRole('button', { name: 'Pay ₹450.00 from wallet' }).click();
  await expect(page.getByRole('heading', { name: 'Booked', exact: true })).toBeVisible();
  const [first, second] = creates(b);
  expect(first).toMatchObject({ acceptedPriceMinor: 50_000 });
  expect(second).toMatchObject({ acceptedPriceMinor: 45_000, branchId: BR1 });
  expect(second!.requestKey).not.toBe(first!.requestKey);
  expect(b.walletMinor).toBe(155_000);
});

test('cancel: a wallet-paid booking goes back to the lab wallet; a card-paid one to the card (default) or to the wallet', async ({ page }) => {
  const b = await mockBackend(page, owner, { bookings: [row(W1), cardPaid(C1), cardPaid(C2)] });
  await signIn(page);
  await nav(page).getByRole('link', { name: 'Booked consultations' }).click();
  await expect(page.getByRole('heading', { name: 'Booked consultations', level: 1 })).toBeVisible();
  const table = page.getByRole('table', { name: 'Booked consultations, newest first' });
  await expect(table.getByRole('row')).toHaveCount(4);

  await page.goto(`/#/partner/consultations/${W1}`);
  await expect(page.getByText('Paid from your wallet')).toBeVisible();
  await expect(page.getByText('The full amount goes back to your Jansetu wallet.')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel this consultation' }).click();
  await page.getByRole('button', { name: 'Yes, cancel it' }).click();
  await expect(page.getByText('Cancelled. ₹500.00 is back in your Jansetu wallet. The patient and the doctor are told.')).toBeVisible();
  await expect(page.getByText('By your lab')).toBeVisible();

  await page.goto(`/#/partner/consultations/${C1}`);
  await expect(page.getByText('Paid by card or UPI')).toBeVisible();
  await expect(page.getByLabel(/^Refund to card \(default\)/)).toBeChecked();
  await page.getByRole('button', { name: 'Cancel this consultation' }).click();
  await page.getByRole('button', { name: 'Yes, cancel it' }).click();
  await expect(page.getByText('Refund of ₹500.00 to the card or UPI: in progress.', { exact: false })).toBeVisible();

  await page.goto(`/#/partner/consultations/${C2}`);
  await page.getByLabel(/^Refund to wallet/).check();
  await page.getByRole('button', { name: 'Cancel this consultation' }).click();
  await page.getByRole('button', { name: 'Yes, cancel it' }).click();
  await expect(page.getByText('₹500.00 is back in your Jansetu wallet. This money pays for bookings; it cannot be withdrawn.', { exact: false })).toBeVisible();

  const cancels = b.calls.filter((c) => /\/cancel$/.test(c.path));
  expect(cancels.map((c) => c.path)).toEqual([W1, C1, C2].map((id) => `/partner-workspace/assisted/bookings/${id}/cancel`));
  expect(cancels[0]!.body).not.toHaveProperty('refundTo');
  expect(cancels[1]!.body).toMatchObject({ refundTo: 'card', expectedUpdatedAt: CREATED });
  expect(cancels[2]!.body).toMatchObject({ refundTo: 'wallet' });
  expect(b.walletMinor).toBe(300_000);
});

test('the prescription’s dispensing copy opens with the member’s token; no diagnosis, no medicine order, no name edit', async ({ page }) => {
  const b = await mockBackend(page, staff(['assisted.book']), { bookings: [row(W1, { status: 'completed', prescription: {
    medicines: [{ name: 'Paracetamol 650', dosage: '1 tablet', frequency: 'Twice a day', duration: '3 days' }], advice: 'Drink water', testsAdvised: ['CBC'],
    prescribedAt: '2026-11-22T06:00:00.000Z', prescribedBySpecialistName: 'Dr Meera Rao', fileUrls: [`/api/static/bookings/${W1}/rx-dispense-1.pdf`] } })] });
  await signIn(page);
  await nav(page).getByRole('link', { name: 'Booked consultations' }).click();
  await page.getByRole('link', { name: /Open the consultation of Rina Kumari/ }).click();
  await expect(page.getByText('the diagnosis is not shown to labs')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Twice a day' })).toBeVisible();
  await page.getByRole('button', { name: 'Open the prescription copy' }).click();
  await expect(page.locator('iframe[title="Prescription copy"]')).toBeVisible();
  const fetches = b.calls.filter((c) => c.path.startsWith('/file/fetch'));
  expect(fetches).toHaveLength(1);
  expect(new URLSearchParams(fetches[0]!.path.split('?')[1]).get('url')).toBe(`/api/v1/file/static/bookings/${W1}/rx-dispense-1.pdf`);
  expect(fetches[0]!.auth).toBe('Bearer t1');
  await expect(page.getByRole('button', { name: 'Make a medicine order from this prescription' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Correct the name/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel this consultation' })).toHaveCount(0);
});

test('branch scope: another branch’s booking and another lab’s are “not found”; the list shows only this member’s branches', async ({ page }) => {
  const b = await mockBackend(page, staff(['assisted.book']), { bookings: [row(W1), row(FAR, { _branch: BR2, patientName: 'Far Away' }),
    row(ELSEWHERE, { _lab: OTHER_LAB, patientName: 'Other Lab Patient' })] });
  await signIn(page);
  await nav(page).getByRole('link', { name: 'Booked consultations' }).click();
  const table = page.getByRole('table', { name: 'Booked consultations, newest first' });
  await expect(table.getByRole('cell', { name: 'Rina Kumari', exact: true })).toBeVisible();
  await expect(table.getByText('Far Away')).toHaveCount(0);
  await page.goto(`/#/partner/consultations/${FAR}`);
  await expect(page.getByText('Consultation not found')).toBeVisible();
  await page.goto(`/#/partner/consultations/${ELSEWHERE}`);
  await expect(page.getByText('Consultation not found')).toBeVisible();
  expect(b.calls.some((c) => c.path === `/partner-workspace/assisted/bookings/${FAR}`)).toBe(true);
  expect(b.calls.some((c) => c.path === `/partner-workspace/assisted/bookings/${ELSEWHERE}`)).toBe(true);
});

test('a member without assisted.book sees no menu and no page', async ({ page }) => {
  const b = await mockBackend(page, staff(['bookings.view', 'bookings.manage', 'wallet.view']));
  await signIn(page);
  await expect(nav(page).getByRole('link', { name: 'Front desk' })).toBeVisible();
  await expect(nav(page).getByRole('link', { name: 'Book consultation' })).toHaveCount(0);
  await expect(nav(page).getByRole('link', { name: 'Booked consultations' })).toHaveCount(0);
  await page.goto('/#/partner/book-consultation');
  await expect(page.getByText('Page not found')).toBeVisible();
  await page.goto(`/#/partner/consultations/${W1}`);
  await expect(page.getByText('Page not found')).toBeVisible();
  expect(b.calls.some((c) => c.path.startsWith('/partner-workspace/assisted/') && c.path !== '/partner-workspace/assisted/wallet')).toBe(false);
});

test('switched off: the lookup says booking for patients is not switched on; nothing is sent', async ({ page }) => {
  const b = await mockBackend(page, owner);
  b.off = true;
  await signIn(page);
  await page.goto('/#/partner/book-consultation');
  await page.getByLabel('Patient’s mobile number').fill(PHONE);
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(page.getByText('Booking for patients is not switched on yet. Jansetu turns it on for your lab when it is ready.')).toBeVisible();
  await expect(page.getByLabel('Patient’s mobile number')).toHaveCount(0);
  expect(creates(b)).toHaveLength(0);
});

test('WQ24b: a lab refused at the lookup (not verified) is told in the lab’s words, not the server’s', async ({ page }) => {
  const b = await mockBackend(page, owner);
  b.unverified = true;
  await signIn(page);
  await page.goto('/#/partner/book-consultation');
  await page.getByLabel('Patient’s mobile number').fill(PHONE);
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(page.getByText('Your lab is not verified yet, so it cannot book for patients.')).toBeVisible();
  await expect(page.getByText('Partner verification is required for this operation')).toHaveCount(0);
  expect(creates(b)).toHaveLength(0);
});

/** WQ24b: a background read again (focus, past the 15 s stale time) that is lost on the network, with its two retries. */
async function failedRefetch(page: Page, b: Backend, path: string) {
  const before = b.calls.filter((c) => c.path === path).length;
  b.failReads = true;
  await page.clock.setFixedTime(new Date(NOW.getTime() + 20_000));
  await page.evaluate(() => { window.dispatchEvent(new Event('visibilitychange')); document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => b.calls.filter((c) => c.path === path).length, { timeout: 10_000 }).toBeGreaterThanOrEqual(before + 2);
  await page.waitForTimeout(3_500); // the last retry (after 1 s and 2 s) has failed: the query is in error, with its old data
}

test('WQ24b: a failed background read of the lab and its branches leaves a held card booking on screen; Pay now asks the lab route first', async ({ page }) => {
  test.setTimeout(45_000);
  const b = await mockBackend(page, owner);
  await signIn(page);
  await nav(page).getByRole('link', { name: 'Book consultation' }).click();
  await patient(page);
  await page.getByLabel('Branch the patient is at').selectOption({ label: 'Indiranagar' });
  await doctorAndTime(page);
  await page.evaluate(() => { (window as unknown as { __rzClose: boolean }).__rzClose = true; });
  await page.getByLabel('Pay by card or UPI').check();
  await page.getByRole('button', { name: 'Pay ₹500.00 by card or UPI' }).click();
  await expect(page.getByRole('heading', { name: 'Booking held: waiting for payment' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Waiting for payment' }).getByText(/^Not paid yet\./)).toBeVisible();
  // The member comes back from the UPI app on a weak network: the lab and its branches cannot be read again.
  await failedRefetch(page, b, '/partner-workspace/me');
  expect(b.calls.filter((c) => c.path === '/partner-workspace/branches').length).toBeGreaterThan(1);
  await expect(page.getByRole('heading', { name: 'Booking held: waiting for payment' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  b.failReads = false;
  await page.evaluate(() => { (window as unknown as { __rzClose: boolean }).__rzClose = false; });
  await page.getByRole('button', { name: 'Pay now ₹500.00' }).click();
  await expect(page.getByRole('heading', { name: 'Booked', exact: true })).toBeVisible();
  const pay = b.calls.filter((c) => c.path.startsWith('/partner-workspace/assisted/payments/') || c.path.startsWith('/payments/')).map((c) => c.path);
  // Checkout closed (reconcile), then Pay now asks before opening it again (reconcile), then the proof (verify): one booking.
  expect(pay).toEqual(['/partner-workspace/assisted/payments/reconcile', '/partner-workspace/assisted/payments/reconcile', '/partner-workspace/assisted/payments/verify']);
  expect(creates(b)).toHaveLength(1);
  expect(await page.evaluate(() => (window as unknown as { __rzOpened: number }).__rzOpened)).toBe(2);
});

test('WQ24b: from the booking page, Check payment and Pay now use the lab routes; a failed read again keeps the payment panel', async ({ page }) => {
  test.setTimeout(45_000);
  const b = await mockBackend(page, staff(['assisted.book']), { record: { status: 'created', bookingId: P1 }, bookings: [row(P1, {
    status: 'pending', paymentStatus: 'pending', payment: { method: 'razorpay', state: 'pending', payBy: PAY_BY, paymentTransactionId: REC,
      razorpayOrderId: 'order_L1', razorpayKeyId: 'rzp_test' } })] });
  await signIn(page);
  await nav(page).getByRole('link', { name: 'Booked consultations' }).click();
  await page.getByRole('link', { name: /^Pay now for the consultation of Rina Kumari/ }).click();
  await expect(page.getByText('₹500.00 (not paid yet)')).toBeVisible();
  const panel = page.getByRole('group', { name: 'Waiting for payment' });
  await panel.getByRole('button', { name: 'Check payment' }).click();
  await expect(panel.getByText(/^Not paid yet\./)).toBeVisible();
  await failedRefetch(page, b, `/partner-workspace/assisted/bookings/${P1}`);
  await expect(panel).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: /^Could not refresh just now/ })).toBeVisible();
  b.failReads = false;
  await panel.getByRole('button', { name: 'Pay now ₹500.00' }).click();
  await expect(page.getByText('Paid. The consultation is booked. The patient and the doctor are told.')).toBeVisible();
  const pay = b.calls.filter((c) => /payments\/(verify|reconcile)$/.test(c.path)).map((c) => c.path);
  expect(pay).toEqual(['/partner-workspace/assisted/payments/reconcile', '/partner-workspace/assisted/payments/reconcile', '/partner-workspace/assisted/payments/verify']);
});

test('WQ24b: change time from the booking page: the doctor’s other times read with a branch in scope, one keyed move', async ({ page }) => {
  const b = await mockBackend(page, staff(['assisted.book']), { bookings: [row(W1)] });
  await signIn(page);
  await page.goto(`/#/partner/consultations/${W1}`);
  await page.getByRole('button', { name: 'Change time' }).click();
  await expect(page.getByRole('button', { name: /10:30–10:45/ })).toHaveCount(0);
  await page.getByRole('button', { name: /11:00–11:15/ }).click();
  await page.getByRole('button', { name: 'Next: check the new time' }).click();
  await page.getByRole('button', { name: 'Yes, move it' }).click();
  await expect(page.getByText('Moved to 26 Nov 2026 at 11:00. The patient and the doctor are told the new time.')).toBeVisible();
  expect(b.calls.some((c) => c.path.startsWith(`/partner-workspace/assisted/doctors/${DOC}/slots?branchId=${BR1}&`))).toBe(true);
  const moves = b.calls.filter((c) => c.path === `/partner-workspace/assisted/bookings/${W1}/reschedule`);
  expect(moves).toHaveLength(1);
  expect(moves[0]!.body).toMatchObject({ slotId: SLOT2, expectedUpdatedAt: CREATED });
  expect(String(moves[0]!.body!.requestKey)).toMatch(/^[A-Za-z0-9]{32}$/);
});

test('WQ24b re-check: a held card booking stays on screen when a background doctor read answers 503 with no code', async ({ page }) => {
  test.setTimeout(45_000);
  const b = await mockBackend(page, owner);
  await signIn(page);
  await nav(page).getByRole('link', { name: 'Book consultation' }).click();
  await patient(page);
  await page.getByLabel('Branch the patient is at').selectOption({ label: 'Indiranagar' });
  await doctorAndTime(page);
  await page.evaluate(() => { (window as unknown as { __rzClose: boolean }).__rzClose = true; });
  await page.getByLabel('Pay by card or UPI').check();
  await page.getByRole('button', { name: 'Pay ₹500.00 by card or UPI' }).click();
  await expect(page.getByRole('heading', { name: 'Booking held: waiting for payment' })).toBeVisible();
  // A deploy: the doctors are read again on focus and the proxy answers 503 with no code (as "switched off").
  b.doctorsDown = true;
  const before = b.calls.filter((c) => c.path.startsWith('/partner-workspace/assisted/doctors')).length;
  await page.clock.setFixedTime(new Date(NOW.getTime() + 20_000));
  await page.evaluate(() => { window.dispatchEvent(new Event('visibilitychange')); document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => b.calls.filter((c) => c.path.startsWith('/partner-workspace/assisted/doctors')).length, { timeout: 10_000 }).toBeGreaterThan(before + 1);
  await page.waitForTimeout(3_500);
  await expect(page.getByRole('heading', { name: 'Booking held: waiting for payment' })).toBeVisible();
  await expect(page.getByText(/not switched on yet/)).toHaveCount(0);
  await page.evaluate(() => { (window as unknown as { __rzClose: boolean }).__rzClose = false; });
  await page.getByRole('button', { name: 'Pay now ₹500.00' }).click();
  await expect(page.getByRole('heading', { name: 'Booked', exact: true })).toBeVisible();
  // The next booking starts afresh: the 503 of the last one is not kept as "switched off".
  b.doctorsDown = false;
  await page.getByRole('button', { name: 'Book another consultation' }).click();
  await expect(page.getByLabel('Patient’s mobile number')).toBeVisible();
  await expect(page.getByText(/not switched on yet/)).toHaveCount(0);
});
