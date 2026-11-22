import { expect, test, type Page, type Route } from '@playwright/test';

// WQ12: a pharmacy books a doctor consultation for a walk-in patient, lists what it booked (cancel, dispensing copy,
// order from the prescription) and keeps its wallet (top-ups by Razorpay) — against a mock of the backend's rules
// (assisted/pharmacyCommands, consultations, bookerView; pharmacyWallet; payment). Razorpay Checkout is a fake script.
const ME = 'b'.repeat(24);
const DOC = 'd1'.repeat(12);
const SLOT1 = '51'.repeat(12);
const SLOT2 = '52'.repeat(12);
const BOOKED = 'e1'.repeat(12);
const DEP = 'f1'.repeat(12);
const MED = '3'.repeat(24);
const TOPUP = 'c1'.repeat(12);
const PHONE = '9876543210';
const NEW_PHONE = '9123456780';

type Json = Record<string, unknown>;

const istYmd = (ms: number) => new Date(ms + 330 * 60_000).toISOString().slice(0, 10).replace(/-/g, '');
const TOMORROW = istYmd(Date.now() + 86_400_000);

interface Backend {
  calls: { method: string; url: string; body: Json | null }[];
  creates: Json[];
  keys: Record<string, Json>;
  walletPaise: number;
  frozen: boolean;
  receivableMinor: number;
  /** Book, then drop the answer (the outcome is unknown to the page). */
  loseNextCreateAnswer: boolean;
  /** Refuse the next create with this answer, before anything is recorded. */
  refuseNextCreate: { status: number; body: Json } | null;
  /** The lookup's answer is this refusal. */
  lookupRefusal: { status: number; body: Json } | null;
  bookings: Json[];
  cancels: Json[];
  orders: Json[];
  topups: Record<string, { status: 'created' | 'paid'; amount: number; credited: boolean }>;
  verifies: Json[];
  checks: string[];
}

async function mockBackend(page: Page, init: Partial<Pick<Backend, 'walletPaise' | 'frozen' | 'receivableMinor' | 'bookings'>> = {}): Promise<Backend> {
  const state: Backend = {
    calls: [], creates: [], keys: {}, walletPaise: init.walletPaise ?? 200_000, frozen: init.frozen ?? false, receivableMinor: init.receivableMinor ?? 0,
    loseNextCreateAnswer: false, refuseNextCreate: null, lookupRefusal: null, bookings: init.bookings ?? [], cancels: [], orders: [], topups: {}, verifies: [], checks: [],
  };
  let live = false;
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const refuse = (route: Route, status: number, code: string, message: string, extra: Json = {}) => json(route, status, { error: status, code, message, ...extra });
  const wallet = () => ({ _id: 'w1', pharmacyId: ME, balance: state.walletPaise / 100, balancePaise: state.walletPaise, isActive: true,
    withdrawableMinor: 0, frozen: state.frozen, receivableMinor: state.receivableMinor });
  const movements: Json[] = [
    { _id: 'm3', transactionType: 'credit', movementType: 'refund_credit', signedAmountPaise: 50_000, amountPaise: 50_000, balanceAfterPaise: 200_000, createdAt: '2026-11-21T10:00:00.000Z', status: 'completed' },
    { _id: 'm2', transactionType: 'debit', movementType: 'booking_debit', signedAmountPaise: -50_000, amountPaise: 50_000, balanceAfterPaise: 150_000, createdAt: '2026-11-20T10:00:00.000Z', status: 'completed' },
    { _id: 'm1', transactionType: 'credit', movementType: 'credit', referenceType: 'wallet_recharge', signedAmountPaise: 200_000, amountPaise: 200_000, balanceAfterPaise: 200_000, createdAt: '2026-11-19T10:00:00.000Z', status: 'completed' },
  ];
  const doctor = (date: string | null) => ({
    doctorId: DOC, name: 'Dr Meera Rao', specialization: 'General Physician', languages: ['Hindi', 'English'], city: 'Pune', experienceYears: 8,
    feeMinor: 50_000, nearby: 'pincode',
    nextSlot: { slotId: SLOT1, date: date ?? TOMORROW, startTime: '10:30', endTime: '10:45', startsAt: '2026-11-23T05:00:00.000Z', modes: ['video', 'call'] },
    ...(date ? { slots: [
      { slotId: SLOT1, date, startTime: '10:30', endTime: '10:45', startsAt: '2026-11-23T05:00:00.000Z', modes: ['video', 'call'] },
      { slotId: SLOT2, date, startTime: '11:00', endTime: '11:15', startsAt: '2026-11-23T05:30:00.000Z', modes: ['in-person'] },
    ] } : {}),
  });
  const viewOf = (b: Json): Json => ({
    _id: BOOKED, status: 'confirmed', paymentStatus: 'paid', source: 'pharmacy_assisted', bookingDate: TOMORROW, bookingTime: (b.slotId === SLOT2 ? '11:00' : '10:30'),
    doctorName: 'Dr Meera Rao', specialistId: DOC, patientName: (b.patient as Json).name ?? 'Asha', dependentId: (b.patient as Json).relation === 'self' ? null : DEP,
    contactNo: b.phone, consultationMode: b.consultationMode, price: (b.acceptedPriceMinor as number) / 100, updatedAt: '2026-11-22T05:00:00.000Z',
    createdAt: '2026-11-22T05:00:00.000Z', assisted: { shortRef: 'K7QXM2PA', bookedBy: { name: 'Asha Medicals' }, ...(b.join ? { join: { on: (b.join as Json).on } } : {}), preferredLanguage: b.preferredLanguage },
  });

  await page.route('https://checkout.razorpay.com/v1/checkout.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: `window.Razorpay = function (o) {
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
    state.calls.push({ method, url: req.url(), body });
    if (path === '/auth/pharmacy/send') return json(route, 200, { success: true });
    if (path === '/auth/pharmacy/verify') { live = true; return json(route, 200, { success: true, data: { token: 't1', expiresIn: 900, user: {} } }); }
    if (path === '/auth/session/refresh') {
      return live ? json(route, 200, { success: true, data: { token: 't1', expiresIn: 900, principal: { userId: ME, userType: 'pharmacy', sid: 's1' } } })
        : refuse(route, 401, 'SESSION_ENDED', 'Please sign in again');
    }
    if (path.startsWith('/auth/session')) return json(route, 200, { success: true, data: {} });
    if (req.headers().authorization !== 'Bearer t1') return refuse(route, 401, 'UNAUTHORIZED', 'Authentication is required');
    if (path === '/auth/profile') return json(route, 200, { success: true, data: { user: { _id: ME, name: 'Asha Medicals' }, userRole: 'pharmacy' } });

    // ── Assisted booking (phase 1a) ──
    if (path === '/pharmacy-assisted/patients/lookup' && method === 'POST') {
      if (state.lookupRefusal) return json(route, state.lookupRefusal.status, state.lookupRefusal.body);
      const phone = String(body?.phone);
      return json(route, 200, { success: true, data: phone === PHONE ? { exists: true, holderNameMasked: 'Rina K.' } : { exists: false, holderNameMasked: null } });
    }
    const doctorSlots = /^\/pharmacy-assisted\/doctors\/(\w{24})\/slots$/.exec(path);
    if (doctorSlots) {
      if (doctorSlots[1] !== DOC) return refuse(route, 404, 'DOCTOR_NOT_FOUND', 'Doctor not found');
      expect(url.searchParams.get('days')).toBe('7');
      const { slots, nextSlot: _n, nearby: _x, ...d } = doctor(TOMORROW) as Json & { slots: Json[] };
      return json(route, 200, { success: true, data: { doctor: d, from: TOMORROW, to: TOMORROW, slots } });
    }
    if (path === '/pharmacy-assisted/doctors') {
      expect(url.searchParams.get('date')).toBeNull();
      const date = url.searchParams.get('date');
      return json(route, 200, { success: true, data: [doctor(date ? date.replace(/-/g, '') : null)] });
    }
    if (path === '/pharmacy-assisted/consultations' && method === 'POST') {
      state.creates.push(body!);
      const key = String(body!.requestKey);
      const hash = JSON.stringify({ ...body, requestKey: undefined });
      const prior = state.keys[key];
      if (prior) {
        if (prior.hash !== hash) return refuse(route, 409, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different booking');
        return json(route, 200, { success: true, data: { ...(prior.receipt as Json), replayed: true } });
      }
      if (state.refuseNextCreate) {
        const r = state.refuseNextCreate;
        state.refuseNextCreate = null;
        return json(route, r.status, r.body);
      }
      if (state.frozen) return refuse(route, 409, 'WALLET_FROZEN', 'This wallet is frozen');
      const price = body!.acceptedPriceMinor as number;
      if (price !== 50_000 && !body!.couponCode) return refuse(route, 409, 'PRICE_CHANGED', 'The price changed', { details: { priceMinor: 50_000, listMinor: 50_000, discountMinor: 0 } });
      if (body!.couponCode && price !== 45_000) return refuse(route, 409, 'PRICE_CHANGED', 'The price changed', { details: { priceMinor: 45_000, listMinor: 50_000, discountMinor: 5_000 } });
      if (state.walletPaise < price) return refuse(route, 409, 'INSUFFICIENT_BALANCE', 'Insufficient wallet balance');
      state.walletPaise -= price;
      const view = viewOf(body!);
      const receipt = { booking: view, funding: { method: 'wallet', amountMinor: price, state: 'captured', walletEntryId: 'm9' },
        split: { listMinor: 50_000, discountMinor: 50_000 - price, couponCode: body!.couponCode ?? null }, newAccount: body!.phone !== PHONE, replayed: false };
      state.keys[key] = { hash, receipt, view };
      state.bookings.unshift(view);
      if (state.loseNextCreateAnswer) { state.loseNextCreateAnswer = false; return route.abort('connectionreset'); }
      return json(route, 201, { success: true, data: receipt });
    }
    const byKey = /^\/pharmacy-assisted\/bookings\/by-key\/([A-Za-z0-9_-]+)(\/abandon)?$/.exec(path);
    if (byKey) {
      const k = state.keys[byKey[1]!];
      return json(route, 200, { success: true, data: k ? { state: 'used', booking: k.view } : byKey[2] ? { state: 'abandoned' } : { state: 'unknown' } });
    }
    const cancel = /^\/pharmacy-assisted\/bookings\/(\w{24})\/cancel$/.exec(path);
    if (cancel && method === 'POST') {
      state.cancels.push(body!);
      const b = state.bookings.find((x) => x._id === cancel[1]);
      if (!b) return refuse(route, 404, 'BOOKING_NOT_FOUND', 'Booking not found');
      if (b.status === 'cancelled') return json(route, 200, { success: true, data: { booking: b, refundedMinor: 0, alreadyCancelled: true } });
      Object.assign(b, { status: 'cancelled', cancellationCause: 'booker', cancellationReason: body!.reason ?? 'Cancelled by the booking partner' });
      state.walletPaise += Math.round(Number(b.price) * 100);
      return json(route, 200, { success: true, data: { booking: b, refundedMinor: Math.round(Number(b.price) * 100), alreadyCancelled: false } });
    }

    // ── Booked list (phase 0) ──
    if (path === '/pharmacy-bookings') {
      const status = url.searchParams.get('status');
      const rows = state.bookings.filter((b) => !status || b.status === status);
      return json(route, 200, { success: true, data: rows, pagination: { total: rows.length, nextCursor: null } });
    }
    const one = /^\/pharmacy-bookings\/(\w{24})$/.exec(path);
    if (one) {
      const b = state.bookings.find((x) => x._id === one[1]);
      return b ? json(route, 200, { success: true, data: b }) : refuse(route, 404, 'BOOKING_NOT_FOUND', 'Booking not found');
    }
    if (path === '/file/fetch') {
      expect(url.searchParams.get('url')).toBe(`/api/v1/file/static/bookings/${BOOKED}/rx-dispense-1.pdf`);
      return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: '%PDF-1.4\n%%EOF\n' });
    }
    if (path === '/pharmacy-medicines') return json(route, 200, { success: true, data: [{ _id: MED, name: 'Paracetamol', strength: '650mg' }], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } });
    if (path === '/pharmacy-orders' && method === 'POST') {
      state.orders.push(body!);
      return json(route, 201, { success: true, data: { order: { _id: 'a9'.repeat(12), orderNumber: 'ORD-1' }, paymentRequired: false } });
    }

    // ── Wallet ──
    if (path === '/pharmacy-wallet') return json(route, 200, { success: true, data: wallet() });
    if (path === '/pharmacy-wallet/transactions') return json(route, 200, { success: true, data: movements, pagination: { page: 1, limit: 20, total: movements.length, totalPages: 1 } });
    if (path === '/pharmacy-wallet/topup' && method === 'POST') {
      state.topups[TOPUP] = { status: 'created', amount: Number(body!.amount), credited: false };
      return json(route, 200, { success: true, data: { paymentRequired: true, paymentTransactionId: TOPUP, razorpayOrderId: 'order_T1', razorpayKeyId: 'rzp_test', amount: Number(body!.amount), currency: 'INR' } });
    }
    const credit = (id: string) => {
      const t = state.topups[id]!;
      if (!t.credited) { t.credited = true; t.status = 'paid'; state.walletPaise += Math.round(t.amount * 100); }
    };
    if (path === '/payments/verify' && method === 'POST') {
      state.verifies.push(body!);
      credit(String(body!.paymentTransactionId));
      return json(route, 200, { success: true, data: { context: 'wallet_recharge', paymentRecord: { status: 'paid', isProcessed: true } } });
    }
    const check = /^\/pharmacy-wallet\/topups\/(\w{24})\/check$/.exec(path);
    if (check && method === 'POST') {
      state.checks.push(check[1]!);
      const t = state.topups[check[1]!];
      if (!t) return refuse(route, 404, 'PAYMENT_RECORD_NOT_FOUND', 'Payment record not found');
      // The patient paid on the Razorpay page before closing it (the capture is found by the server).
      credit(check[1]!);
      return json(route, 200, { success: true, data: { state: 'credited', wallet: wallet() } });
    }
    return refuse(route, 404, 'NOT_MOCKED', `Not mocked: ${method} ${path}`);
  });
  return state;
}

async function signIn(page: Page, to: string) {
  await page.goto('/');
  await page.getByLabel('Mobile number').fill('9000000001');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await page.getByRole('link', { name: to, exact: true }).first().click();
}

async function findPatient(page: Page, phone = PHONE) {
  await page.getByLabel('Patient’s mobile number').fill(phone);
  await page.getByRole('button', { name: 'Find' }).click();
}

async function chooseDoctorAndTime(page: Page, opts: { join?: 'device' | 'phone' } = {}) {
  await expect(page.getByRole('heading', { name: 'Dr Meera Rao' })).toBeVisible();
  await expect(page.getByText('Near you')).toBeVisible();
  await page.getByRole('button', { name: 'Choose Dr Meera Rao' }).click();
  await page.getByRole('button', { name: '10:30–10:45' }).click();
  await page.getByLabel('Video call').check();
  if (opts.join === 'phone') await page.getByLabel('On the patient’s own phone').check();
  else await page.getByLabel('On this pharmacy’s device').check();
  await page.getByLabel('Language the patient speaks').selectOption('hi');
  await page.getByRole('button', { name: 'Next: check the price' }).click();
}

async function ownerAgreed(page: Page, name = 'Rina Kumari') {
  await page.getByLabel('Patient’s full name').fill(name);
  await page.getByLabel('Patient agreed to this booking').check();
  await page.getByRole('button', { name: 'Next: choose the doctor' }).click();
}

const noPatientDataStored = async (page: Page, b: Backend, ...words: string[]) => {
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + location.href);
  for (const w of words) expect(stored).not.toContain(w);
  for (const c of b.calls) for (const w of words) expect(c.url).not.toContain(w);
};

test('book for the phone’s owner: masked holder, tick, nearby doctor, pay from the wallet, confirmation', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page, 'Book consultation');
  await expect(page.getByRole('heading', { name: 'Book consultation' })).toBeVisible();
  await findPatient(page);
  await expect(page.getByText('Account holder: Rina K.')).toBeVisible();
  // The tick is required.
  await page.getByLabel('Patient’s full name').fill('Rina Kumari');
  await page.getByRole('button', { name: 'Next: choose the doctor' }).click();
  await expect(page.getByText('Ask the patient, then tick this box. Without it you cannot book.')).toBeVisible();
  await page.getByLabel('Patient agreed to this booking').check();
  await page.getByRole('button', { name: 'Next: choose the doctor' }).click();
  await chooseDoctorAndTime(page);
  const pay = page.getByRole('group', { name: 'Check and pay' });
  await expect(pay.getByText('Money in your wallet: ₹2,000.00')).toBeVisible();
  await expect(pay.getByText('After this booking: ₹1,500.00')).toBeVisible();
  await pay.getByRole('button', { name: 'Pay ₹500.00 from wallet' }).click();
  await expect(page.getByRole('heading', { name: 'Booked' })).toBeVisible();
  await expect(page.getByText('K7QXM2PA')).toBeVisible();
  await expect(page.getByText('A “Join call” button appears 10 minutes before the time.')).toBeVisible();
  await expect(page.getByText('Paid from your wallet: ₹500.00')).toBeVisible();

  expect(b.creates).toHaveLength(1);
  const sent = b.creates[0]!;
  expect(sent).toMatchObject({
    phone: PHONE, patient: { relation: 'self', name: 'Rina Kumari' }, slotId: SLOT1, consultationMode: 'video', join: { on: 'partner_device' },
    preferredLanguage: 'hi', acceptedPriceMinor: 50_000, paymentMethod: 'wallet', consent: { agreed: true, statementLanguage: 'en' },
  });
  expect(String(sent.requestKey)).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
  await noPatientDataStored(page, b, PHONE, 'Rina Kumari');
});

test('a new number is typed twice; a family member is added by name and relation', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page, 'Book consultation');
  await findPatient(page, NEW_PHONE);
  await expect(page.getByText('This number is new to Jansetu.')).toBeVisible();
  await page.getByLabel('A family member of the phone’s owner').check();
  await page.getByLabel('Family member’s full name').fill('Asha Devi');
  await page.getByLabel('Patient agreed to this booking').check();
  await page.getByRole('button', { name: 'Next: choose the doctor' }).click();
  await expect(page.getByText('Type the same number again.')).toBeVisible();
  await expect(page.getByText('Choose how they are related to the phone’s owner.')).toBeVisible();
  await page.getByLabel('Type the number again').fill(NEW_PHONE);
  await page.getByLabel('Relation to the phone’s owner').selectOption('Mother');
  await page.getByLabel('Gender (optional)').selectOption('Female');
  await page.getByLabel('Phone owner’s name (optional)').fill('Ravi Devi');
  await page.getByRole('button', { name: 'Next: choose the doctor' }).click();
  await chooseDoctorAndTime(page, { join: 'phone' });
  await page.getByRole('button', { name: 'Pay ₹500.00 from wallet' }).click();
  await expect(page.getByRole('heading', { name: 'Booked' })).toBeVisible();
  await expect(page.getByText('The patient signs in to the Jansetu app on their phone with this number and taps Join.')).toBeVisible();
  await expect(page.getByText('This number was new to Jansetu.')).toBeVisible();
  expect(b.creates[0]).toMatchObject({ phone: NEW_PHONE, patient: { relation: 'Mother', name: 'Asha Devi', gender: 'Female' }, holderName: 'Ravi Devi', join: { on: 'patient_phone' } });
  await noPatientDataStored(page, b, NEW_PHONE, 'Asha Devi', 'Ravi Devi');
});

test('a family member booked here before is offered by name and sent by id', async ({ page }) => {
  const earlier = { _id: 'e2'.repeat(12), status: 'completed', source: 'pharmacy_assisted', bookingDate: '20261101', bookingTime: '09:00', doctorName: 'Dr Meera Rao',
    patientName: 'Asha Devi', dependentId: DEP, contactNo: PHONE, consultationMode: 'video' };
  const b = await mockBackend(page, { bookings: [earlier] });
  await signIn(page, 'Book consultation');
  await findPatient(page);
  await page.getByLabel('Asha Devi (family member, booked here before)').check();
  await page.getByLabel('Patient agreed to this booking').check();
  await page.getByRole('button', { name: 'Next: choose the doctor' }).click();
  await chooseDoctorAndTime(page);
  await page.getByRole('button', { name: 'Pay ₹500.00 from wallet' }).click();
  await expect(page.getByRole('heading', { name: 'Booked' })).toBeVisible();
  expect(b.creates[0]!.patient).toEqual({ dependentId: DEP });
});

test('not enough money: top up by Razorpay inside the booking (verify without module), then pay', async ({ page }) => {
  const b = await mockBackend(page, { walletPaise: 10_000 });
  await signIn(page, 'Book consultation');
  await findPatient(page);
  await ownerAgreed(page);
  await chooseDoctorAndTime(page);
  await expect(page.getByText('Your wallet needs ₹400.00 more for this booking.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pay ₹500.00 from wallet' })).toBeDisabled();
  await expect(page.getByRole('link', { name: 'Wallet' }).last()).toBeVisible();
  await page.getByRole('button', { name: 'Top up now' }).click();
  await expect(page.getByLabel('Amount to add (₹)')).toHaveValue('400');
  await page.getByRole('button', { name: 'Top up', exact: true }).click();
  await expect(page.getByText('₹400.00 was added to your wallet.')).toBeVisible();
  expect(b.verifies).toHaveLength(1);
  expect(b.verifies[0]).toEqual({ paymentTransactionId: TOPUP, razorpayOrderId: 'order_T1', razorpayPaymentId: 'pay_TEST1', razorpaySignature: 'sig_TEST' });
  await page.getByRole('button', { name: 'Pay ₹500.00 from wallet' }).click();
  await expect(page.getByRole('heading', { name: 'Booked' })).toBeVisible();
});

test('refusals in plain words: insufficient balance, price changed, slot taken, frozen, owing', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page, 'Book consultation');
  await findPatient(page);
  await ownerAgreed(page);
  await chooseDoctorAndTime(page);

  // The balance read was stale: the server refuses; the top-up is offered and paying again is a new request.
  b.refuseNextCreate = { status: 409, body: { error: 409, code: 'INSUFFICIENT_BALANCE', message: 'Insufficient wallet balance' } };
  await page.getByRole('button', { name: 'Pay ₹500.00 from wallet' }).click();
  await expect(page.getByText('Your Jansetu wallet does not have enough money for this booking. Top up the wallet, then pay again.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Top up now' })).toBeVisible();

  // The fee changed: the new price is shown and accepted with a new request key.
  b.refuseNextCreate = { status: 409, body: { error: 409, code: 'PRICE_CHANGED', message: 'The price changed', details: { priceMinor: 55_000, listMinor: 55_000, discountMinor: 0 } } };
  await page.getByRole('button', { name: 'Pay ₹500.00 from wallet' }).click();
  await expect(page.getByText('The price has changed. It is now ₹550.00.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pay ₹500.00 from wallet' })).toBeDisabled();
  await page.getByRole('button', { name: 'Use the new price (₹550.00)' }).click();
  await expect(page.getByRole('button', { name: 'Pay ₹550.00 from wallet' })).toBeEnabled();
  expect(b.creates[0]!.requestKey).not.toBe(b.creates[1]!.requestKey);

  // The time was taken meanwhile: back to the doctor's times.
  b.refuseNextCreate = { status: 409, body: { error: 409, code: 'SLOT_NOT_AVAILABLE', message: 'Slot is not available' } };
  await page.getByRole('button', { name: 'Pay ₹550.00 from wallet' }).click();
  await expect(page.getByText('This time was just taken. Choose another time.')).toBeVisible();
  await expect(page.getByRole('heading', { name: '3. Check and pay' })).toHaveCount(0);
  await page.getByRole('button', { name: '10:30–10:45' }).click();
  await page.getByLabel('Video call').check();
  await page.getByLabel('On this pharmacy’s device').check();
  await page.getByRole('button', { name: 'Next: check the price' }).click();

  for (const [code, words] of [
    ['WALLET_FROZEN', 'Your Jansetu wallet is on hold, so it cannot pay for bookings.'],
    ['WALLET_RECEIVABLE', 'Your wallet owes money to Jansetu after a disputed card payment'],
    ['SPECIALIST_NOT_VERIFIED', 'This doctor is not verified yet. Choose another doctor.'],
  ] as const) {
    b.refuseNextCreate = { status: 409, body: { error: 409, code, message: 'refused' } };
    await page.getByRole('button', { name: /^Pay ₹/ }).click();
    await expect(page.getByText(words)).toBeVisible();
    if (code === 'SPECIALIST_NOT_VERIFIED') break;
  }
  expect(b.keys).toEqual({});
});

test('a wallet on hold or owing cannot pay, and says so before paying', async ({ page }) => {
  await mockBackend(page, { frozen: true, receivableMinor: 30_000 });
  await signIn(page, 'Book consultation');
  await findPatient(page);
  await ownerAgreed(page);
  await chooseDoctorAndTime(page);
  await expect(page.getByText('Your wallet owes ₹300.00 to Jansetu after a disputed card payment.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pay ₹500.00 from wallet' })).toBeDisabled();
});

test('a coupon: the server names the price with the coupon, and the booking goes through at that price', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page, 'Book consultation');
  await findPatient(page);
  await ownerAgreed(page);
  await page.getByRole('button', { name: 'Choose Dr Meera Rao' }).click();
  await page.getByRole('button', { name: '10:30–10:45' }).click();
  await page.getByLabel('Video call').check();
  await page.getByLabel('On this pharmacy’s device').check();
  await page.getByLabel('Language the patient speaks').selectOption('hi');
  await page.getByLabel('Coupon code (optional)').fill('save10');
  await page.getByRole('button', { name: 'Next: check the price' }).click();
  await page.getByRole('button', { name: 'Pay ₹500.00 from wallet' }).click();
  await expect(page.getByText('With the coupon SAVE10, the price is ₹450.00.')).toBeVisible();
  await page.getByRole('button', { name: 'Use the new price (₹450.00)' }).click();
  await page.getByRole('button', { name: 'Pay ₹450.00 from wallet' }).click();
  await expect(page.getByRole('heading', { name: 'Booked' })).toBeVisible();
  expect(b.creates[1]).toMatchObject({ couponCode: 'SAVE10', acceptedPriceMinor: 45_000 });
});

test('switched off (503 or the route not there yet), and the lookup limit', async ({ page }) => {
  const b = await mockBackend(page);
  b.lookupRefusal = { status: 429, body: { error: 429, code: 'ASSISTED_LIMIT_REACHED', message: 'Too many patient lookups this hour', limit: 'lookups', retryAfter: 600 } };
  await signIn(page, 'Book consultation');
  await findPatient(page);
  await expect(page.getByText('You have looked up many patients this hour. Try again in about 10 minutes.')).toBeVisible();
  b.lookupRefusal = { status: 503, body: { error: 503, code: 'ASSISTED_BOOKING_DISABLED', message: 'Assisted booking is not switched on yet' } };
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(page.getByText('Booking for patients is not switched on yet.')).toBeVisible();
  await expect(page.getByLabel('Patient’s mobile number')).toHaveCount(0);

  await page.reload();
  b.lookupRefusal = { status: 404, body: { success: false, message: 'Route not found' } };
  await page.getByRole('link', { name: 'Book consultation', exact: true }).first().click();
  await findPatient(page);
  await expect(page.getByText('Booking for patients is not switched on yet.')).toBeVisible();
});

test('an answer lost on the way: the outcome is not known; the same request is sent again and is never booked twice', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page, 'Book consultation');
  await findPatient(page);
  await ownerAgreed(page);
  await chooseDoctorAndTime(page);
  b.loseNextCreateAnswer = true;
  await page.getByRole('button', { name: 'Pay ₹500.00 from wallet' }).click();
  await expect(page.getByText(/The outcome of this request is not known yet/)).toBeVisible();
  await page.getByRole('button', { name: 'Send the same request again' }).click();
  await expect(page.getByRole('heading', { name: 'Already booked' })).toBeVisible();
  await expect(page.getByText('This booking was already made. Nothing was booked or charged twice.')).toBeVisible();
  expect(b.creates).toHaveLength(2);
  expect(b.creates[0]).toEqual(b.creates[1]);
  expect(b.walletPaise).toBe(150_000);
  await noPatientDataStored(page, b, PHONE, 'Rina Kumari');
});

test('a lost answer can also be checked by its key', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page, 'Book consultation');
  await findPatient(page);
  await ownerAgreed(page);
  await chooseDoctorAndTime(page);
  b.loseNextCreateAnswer = true;
  await page.getByRole('button', { name: 'Pay ₹500.00 from wallet' }).click();
  await page.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(page.getByRole('heading', { name: 'Already booked' })).toBeVisible();
  await expect(page.getByText('K7QXM2PA')).toBeVisible();
  expect(b.creates).toHaveLength(1);
});

const bookedRow = (o: Json = {}): Json => ({
  _id: BOOKED, status: 'confirmed', paymentStatus: 'paid', source: 'pharmacy_assisted', bookingDate: TOMORROW, bookingTime: '10:30', doctorName: 'Dr Meera Rao',
  patientName: 'Rina Kumari', contactNo: PHONE, consultationMode: 'video', price: 500, updatedAt: '2026-11-22T05:00:00.000Z', createdAt: '2026-11-22T05:00:00.000Z',
  assisted: { shortRef: 'K7QXM2PA', join: { on: 'partner_device' }, preferredLanguage: 'hi', bookedBy: { name: 'Asha Medicals' } }, ...o,
});

test('booked consultations: list, open, cancel before the start (refund to the wallet)', async ({ page }) => {
  const b = await mockBackend(page, { bookings: [bookedRow({ virtualMeeting: { joinUrl: 'https://meet.google.com/abc-defg-hij' } }),
    bookedRow({ _id: 'e3'.repeat(12), status: 'cancelled', cancellationCause: 'patient', patientName: 'Asha Devi' })] });
  await signIn(page, 'Booked consultations');
  const table = page.getByRole('table', { name: 'Booked consultations, newest first' });
  await expect(table.getByRole('cell', { name: 'Rina Kumari', exact: true })).toBeVisible();
  await expect(table.getByText('Cancelled by patient')).toBeVisible();
  await table.getByRole('link', { name: /Open the consultation of Rina Kumari/ }).click();
  await expect(page.getByRole('link', { name: 'Join call' })).toHaveAttribute('href', 'https://meet.google.com/abc-defg-hij');
  await expect(page.getByText('You can cancel any time before the consultation starts.')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel this consultation' }).click();
  await page.getByLabel('Why? (optional)').fill('Patient feels better');
  await page.getByRole('button', { name: 'Yes, cancel it' }).click();
  await expect(page.getByText('Cancelled. ₹500.00 is back in your Jansetu wallet.')).toBeVisible();
  expect(b.cancels).toEqual([{ reason: 'Patient feels better', expectedUpdatedAt: '2026-11-22T05:00:00.000Z' }]);
});

test('the dispensing copy (no diagnosis) and a medicine order from it', async ({ page }) => {
  const b = await mockBackend(page, { bookings: [bookedRow({ status: 'completed', prescription: {
    medicines: [{ name: 'Paracetamol 650', dosage: '1 tablet', frequency: 'Twice a day', duration: '3 days', instructions: 'After food' }],
    advice: 'Drink water', testsAdvised: ['CBC'], prescribedAt: '2026-11-22T06:00:00.000Z', prescribedBySpecialistName: 'Dr Meera Rao',
    fileUrls: [`/api/static/bookings/${BOOKED}/rx-dispense-1.pdf`] } })] });
  await signIn(page, 'Booked consultations');
  await page.getByRole('link', { name: /Open the consultation of Rina Kumari/ }).click();
  await expect(page.getByText('the diagnosis is not shown to pharmacies')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Twice a day' })).toBeVisible();
  await expect(page.getByText('Drink water')).toBeVisible();
  await page.getByRole('button', { name: 'Open the prescription copy' }).click();
  await expect(page.locator('iframe[title="Prescription copy"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel this consultation' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Make a medicine order from this prescription' }).click();
  await page.getByRole('button', { name: 'Check the order' }).click();
  await expect(page.getByText('Choose at least one medicine from your stock.')).toBeVisible();
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('button', { name: 'Choose Paracetamol 650mg' }).click();
  await page.getByLabel('Units').fill('6');
  await page.getByRole('button', { name: 'Check the order' }).click();
  await page.getByRole('button', { name: 'Make the order' }).click();
  await expect(page.getByText('Order made.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open the order' })).toHaveAttribute('href', /\/pharmacy\/orders\/a9a9/);
  expect(b.orders).toHaveLength(1);
  expect(b.orders[0]).toMatchObject({ prescriptionFromBookingId: BOOKED, orderType: 'in_store', paymentMode: 'in_store_payment', deliveryMode: 'pickup', isWalkIn: true,
    items: [{ medicineId: MED, orderedQty: 6 }] });
  expect(String(b.orders[0]!.requestKey)).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
});

test('wallet: balance, history by sign with plain labels, a closed payment page is checked with “Check my top-up”', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page, 'Wallet');
  await expect(page.getByText('₹2,000.00').first()).toBeVisible();
  const history = page.getByRole('table', { name: 'Wallet history, newest first' });
  await expect(history.getByText('Refund of a cancelled booking')).toBeVisible();
  await expect(history.getByText('Paid for a consultation booking')).toBeVisible();
  await expect(history.getByText('Top-up (card / UPI)')).toBeVisible();
  await expect(history.getByText('−₹500.00')).toBeVisible();
  await expect(history.getByText('+₹2,000.00')).toBeVisible();

  await page.evaluate(() => { (window as unknown as { __rzClose: boolean }).__rzClose = true; });
  await page.getByLabel('Amount to add (₹)').fill('300');
  await page.getByRole('button', { name: 'Top up', exact: true }).click();
  // Checkout was closed: the server is asked once (it found the capture) — and the button still works later.
  await expect(page.getByText('₹300.00 was added to your wallet.')).toBeVisible();
  expect(b.verifies).toHaveLength(0);
  expect(b.checks).toEqual([TOPUP]);
});

test('wallet: a top-up whose check got no answer stays listed, and “Check my top-up” settles it', async ({ page }) => {
  const b = await mockBackend(page);
  let failChecks = 1;
  await page.route('**/api/v1/pharmacy-wallet/topups/*/check', async (route) => {
    if (failChecks-- > 0) return route.abort('connectionreset');
    return route.fallback();
  });
  await signIn(page, 'Wallet');
  await page.evaluate(() => { (window as unknown as { __rzClose: boolean }).__rzClose = true; });
  await page.getByLabel('Amount to add (₹)').fill('250');
  await page.getByRole('button', { name: 'Top up', exact: true }).click();
  await expect(page.getByText(/We could not confirm the top-up yet/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Top-ups not confirmed yet' })).toBeVisible();
  await page.getByRole('button', { name: 'Check my top-up' }).click();
  await expect(page.getByText('₹250.00 was added to your wallet.')).toBeVisible();
  expect(b.checks).toEqual([TOPUP]);
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(stored).not.toContain('t1');
});
