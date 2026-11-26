import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * WQ54 (P1, SIMPLE_DESIGN_PLAN_2026-11-26 example 1): the simple pharmacy home against a mocked API (backend r37's draft
 * shapes: `GET /pharmacy-assisted/today`, `/pharmacy-assisted/todos`): four big buttons, the day's register with its money,
 * what is waiting, the pharmacy's to-dos; + New (the patient once, then what: the existing Consult now and New sale opened
 * with that patient); Today. On a desktop, a tablet and a phone (the phone's menu behind "More").
 */
const PH = 'aa'.repeat(12);
const ASHA = 'c2'.repeat(12);
const REQ = 'e1'.repeat(12);
const DOC = 'd1'.repeat(12);
const PARA = 'a1'.repeat(12);
const PHONE = '9876543210';
const NOW = new Date('2026-11-26T04:35:00.000Z'); // 10:05 in India
const LATER = new Date(NOW.getTime() + 4 * 60_000).toISOString();

type Json = Record<string, unknown>;
interface Backend {
  calls: { method: string; path: string; body: Json | null }[];
  register: Json[];
  todos: Json[];
  todoKeys: Record<string, string>;
  orders: Json[];
  request: Json | null;
  /** r37b: more pending queues (null = the server could not read it). */
  pendingExtra: Json;
  /** Today reads fail as if offline (no answer) while this is set. */
  offline: boolean;
  /** The next to-do add fails as if offline (nothing recorded). */
  todoOfflineOnce: boolean;
}

async function mockBackend(page: Page): Promise<Backend> {
  await page.clock.setFixedTime(NOW);
  const b: Backend = { calls: [], register: [], todos: [], todoKeys: {}, orders: [], offline: false, todoOfflineOnce: false, request: null, pendingExtra: {} };
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const ok = (route: Route, data: unknown, status = 200, extra: Json = {}) => json(route, status, { success: true, data, ...extra });
  const refuse = (route: Route, status: number, code: string) => json(route, status, { error: status, code, message: code });
  let live = false;
  const base = '/pharmacy-assisted/instant';
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = req.method();
    const body = ['POST', 'PATCH', 'PUT'].includes(method) ? (req.postDataJSON() as Json | null) : null;
    if (path === '/auth/session/refresh') return live ? ok(route, { token: 'tp', expiresIn: 900, principal: { userId: PH, userType: 'pharmacy', sid: 's1' } }) : refuse(route, 401, 'SESSION_ENDED');
    if (path.startsWith('/auth/session')) return ok(route, {});
    b.calls.push({ method, path: `${path}${url.search}`, body });
    if (path === '/auth/pharmacy/send') return ok(route, undefined);
    if (path === '/auth/pharmacy/verify') { live = true; return ok(route, { token: 'tp', expiresIn: 900, user: {} }); }
    if (req.headers().authorization !== 'Bearer tp') return refuse(route, 401, 'UNAUTHORIZED');
    if (path === '/auth/profile') return ok(route, { user: { _id: PH, name: 'Demo Pharmacy' }, userRole: 'pharmacy' });

    // ── r37 (draft): the day's register and the to-dos ──
    if (path === '/pharmacy-assisted/today') {
      if (b.offline) return route.abort('internetdisconnected');
      const byMethod: Record<string, number> = {};
      for (const r of b.register) if (r.paid) byMethod[String(r.method)] = (byMethod[String(r.method)] ?? 0) + Number(r.amountMinor);
      const collectedMinor = b.register.filter((r) => r.paid).reduce((a, r) => a + Number(r.amountMinor), 0);
      const unpaid = b.register.filter((r) => !r.paid);
      // r37: oldest first; the whole day's totals; pending on the first page.
      const sales = unpaid.filter((r) => r.kind === 'order');
      return ok(route, { date: url.searchParams.get('date'), items: b.register, nextCursor: null,
        totals: { collectedMinor, byMethod, unpaidMinor: unpaid.reduce((a, r) => a + Number(r.amountMinor), 0), count: b.register.length },
        pending: { prescriptionsToReview: { count: 0, ids: [] }, unpaidCounterSales: { count: sales.length, ids: sales.map((r) => r.id) },
          bookingsAwaiting: { count: 0, consultationIds: [], labBookingIds: [] }, labReportsReady: { count: 0, ids: [] }, lowStock: { count: 0, ids: [] }, ...b.pendingExtra } });
    }
    if (path === '/pharmacy-assisted/todos' && method === 'GET') return ok(route, [...b.todos].reverse(), 200, { pagination: { nextCursor: null } });
    if (path === '/pharmacy-assisted/todos' && method === 'POST') {
      if (b.todoOfflineOnce) { b.todoOfflineOnce = false; return route.abort('internetdisconnected'); }
      if (String(body!.text) === 'one too many') return refuse(route, 409, 'TODO_LIMIT');
      const key = String(body!.requestKey);
      const known = b.todos.find((x) => x._id === b.todoKeys[key]);
      if (known) return ok(route, { todo: known, replayed: true });
      const todo = { _id: `7${b.todos.length}`.padStart(24, '0'), text: body!.text, dueAt: null, done: false, doneAt: null, version: 1,
        createdBy: { kind: 'pharmacy', id: PH, name: 'Pooja' }, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() };
      b.todos.push(todo);
      b.todoKeys[key] = String(todo._id);
      return ok(route, { todo, replayed: false }, 201);
    }
    const todo = /^\/pharmacy-assisted\/todos\/(\w{24})$/.exec(path);
    if (todo && method === 'PATCH') {
      const x = b.todos.find((t) => t._id === todo[1])!;
      if (body!.expectedVersion !== x.version) return refuse(route, 409, 'TODO_CHANGED');
      Object.assign(x, { done: body!.done, version: Number(x.version) + 1 });
      return ok(route, x);
    }

    // ── + New: the patient ──
    if (path === '/pharmacy-customers/search') return ok(route, b.orders.length ? [{ _id: 'd9'.repeat(12), userId: { _id: ASHA, name: 'Asha Verma', phone: PHONE }, typedName: 'Asha Verma' }] : []);
    if (path === '/pharmacy-assisted/patients/lookup') return ok(route, { exists: false, holderNameMasked: null });
    if (path === '/pharmacy-bookings' && method === 'GET') return ok(route, [], 200, { pagination: { nextCursor: null } });
    if (path === '/pharmacy-wallet') return ok(route, { balancePaise: 200_000, isActive: true, receivableMinor: 0, frozen: false });

    // ── Doctor now (video): the existing Consult now ──
    if (path === `${base}/specialities`) return ok(route, [{ specialization: 'General Physician', onlineNow: 1 }]);
    if (path === `${base}/doctors`) return ok(route, [{ doctorId: DOC, name: 'Dr Kavya Rao', specialization: 'General Physician', modes: ['video'], instantFeeMinor: 50000, nearby: null }]);
    if (path === `${base}/quote`) return ok(route, { quotedAmountMinor: 50000, doctors: 1 });
    if (path === `${base}/requests` && method === 'GET') return ok(route, [], 200, { pagination: { total: 0, nextCursor: null } });
    if (path === `${base}/requests` && method === 'POST') {
      const x = body!;
      const request = { _id: REQ, status: 'offered', statusVersion: 1, mode: x.mode, specialization: x.specialization, target: x.target, offerGeneration: 1,
        offerExpiresAt: LATER, inactivityRefundAt: LATER, offeredCount: 1, acceptedDoctorName: null, bookingId: null, patientName: (x.patient as Json).name,
        assisted: { shortRef: 'K7QXM2PA', join: x.join, preferredLanguage: x.preferredLanguage },
        money: { quotedAmountMinor: x.acceptedQuoteMinor, discountMinor: 0, paidMinor: x.acceptedPayableMinor, returnedMinor: 0, refundedMinor: 0 } };
      b.request = request;
      b.register.push({ kind: 'consultation', id: REQ, at: NOW.toISOString(), shortRef: 'K7QXM2PA', patientName: (x.patient as Json).name, what: 'Dr Kavya · now · video',
        amountMinor: x.acceptedPayableMinor, paid: true, method: 'wallet', status: 'offered', link: { kind: 'booking', id: REQ } });
      return ok(route, { request, funding: { method: 'wallet', amountMinor: x.acceptedPayableMinor, state: 'held', walletEntryId: 'w1' }, newAccount: false, replayed: false }, 201);
    }
    if (new RegExp(`^${base}/requests/${REQ}(/activity)?$`).test(path) && b.request) return ok(route, b.request);

    // ── Medicines: the existing New sale ──
    if (path === '/pharmacy-customers' && method === 'POST') return ok(route, { customer: { _id: 'd9'.repeat(12) }, userId: ASHA, isNewUser: false }, 201);
    if (path === '/pharmacy-inventory') {
      return ok(route, [{ _id: 'e0'.padStart(24, '0'), medicineId: { _id: PARA, name: 'Dolo 650', rx: false }, availableQty: 40, reservedQty: 0, reorderThreshold: 5, isActive: true,
        retailPrice: 32, batches: [{ _id: 'f0'.padStart(24, '0'), batchNumber: 'B1', expiryDate: '20281231', availableQty: 40, reservedQty: 0, status: 'active' }] }],
      200, { pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } });
    }
    if (path === '/pharmacy-orders' && method === 'POST') {
      const lines = body!.items as { medicineId: string; orderedQty: number }[];
      const total = lines.reduce((a, l) => a + l.orderedQty * 32, 0);
      const order = { _id: '90'.padStart(24, '0'), orderNumber: 'PO-100', pharmacyId: PH, customerId: { _id: ASHA, name: 'Asha Verma', phone: PHONE }, orderType: 'in_store',
        status: 'placed', items: lines.map((l) => ({ medicineId: l.medicineId, medicineName: 'Dolo 650', orderedQty: l.orderedQty, unitPrice: 32, lineTotal: l.orderedQty * 32,
          prescriptionRequired: false, batchAllocations: [{ batchId: 'f0'.padStart(24, '0'), batchNumber: 'B1', expiryDate: '20281231', quantity: l.orderedQty }] })),
        subtotal: total, discountTotal: 0, taxTotal: 15.24, grandTotal: total, paymentMode: 'in_store_payment', paymentStatus: 'pending', deliveryMode: 'pickup', isWalkIn: true,
        prescriptionStatus: 'not_required', createdAt: NOW.toISOString(), bill: { pharmacy: { name: 'Demo Pharmacy', address: null, city: 'Pune', state: null, pincode: null,
          gstNumber: null, drugLicenseNumber: null }, paymentMethod: null, paidAt: null } };
      b.orders.push(order);
      b.register.push({ kind: 'order', id: order._id, at: new Date(NOW.getTime() + 35 * 60_000).toISOString(), shortRef: 'PO-100', patientName: 'Asha Verma', what: 'Dolo 650',
        amountMinor: total * 100, paid: false, method: null, status: 'placed', link: { kind: 'pharmacy_order', id: order._id } });
      return ok(route, { order, paymentRequired: false }, 201);
    }
    const one = /^\/pharmacy-orders\/(\w{24})(\/mark-paid)?$/.exec(path);
    if (one) {
      const o = b.orders.find((x) => x._id === one[1])!;
      if (one[2]) {
        Object.assign(o, { paymentStatus: 'paid', paymentSource: body!.paymentSource, bill: { ...(o.bill as Json), paymentMethod: body!.paymentSource, paidAt: NOW.toISOString() } });
        Object.assign(b.register.find((r) => r.id === o._id)!, { paid: true, method: body!.paymentSource });
      }
      return ok(route, o);
    }
    return refuse(route, 404, 'NOT_MOCKED');
  });
  return b;
}

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Mobile number').fill('9000000001');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'What do you want to do?' })).toBeVisible();
}
const stored = (page: Page) => page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + location.href);
const bigButtons = (page: Page) => page.getByRole('navigation', { name: 'What do you want to do?' });

/** Example 1: Asha (new) gets a video consult from the wallet, then medicines in cash; Today shows both with totals. */
async function exampleOne(page: Page, b: Backend, signedIn = false) {
  if (!signedIn) await signIn(page);
  const big = bigButtons(page);
  await expect(big.getByRole('link')).toHaveText(['+ New', 'Find patient', 'Sell medicines', 'Today']);
  await expect(page.getByText('Nothing yet today')).toBeVisible();
  await expect(page.getByLabel('Money of the day')).toHaveText('Collected ₹0.00: cash ₹0.00 · UPI ₹0.00 · wallet ₹0.00 · to collect ₹0.00');

  // A to-do: added once, then ticked.
  await page.getByLabel('New to-do').fill('Call supplier for Dolo 650');
  await page.getByRole('button', { name: 'Add' }).click();
  const todo = page.getByRole('checkbox', { name: 'Call supplier for Dolo 650' });
  await expect(todo).not.toBeChecked();
  await todo.check();
  await expect(todo).toBeChecked();
  expect(b.calls.find((c) => c.method === 'PATCH')!.body).toEqual({ done: true, expectedVersion: 1 });

  // + New → phone → not found → added in two fields → Doctor now (video).
  await big.getByRole('link', { name: '+ New' }).click();
  await page.getByLabel('Phone number or name').fill(PHONE);
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(page.getByText('Not found. Add the patient below.')).toBeVisible();
  await expect(page.getByLabel('Mobile number (10 digits)')).toHaveValue(PHONE);
  await page.getByLabel('Name', { exact: true }).fill('Asha Verma');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText(`Asha Verma · ${PHONE}`)).toBeVisible();
  await page.getByRole('link', { name: /^Doctor now \(video\)/ }).click();

  // The existing Consult now, with Asha filled in: typed once.
  await expect(page.getByRole('heading', { name: 'Consult now', level: 1 })).toBeVisible();
  await expect(page.getByLabel('Patient’s full name')).toHaveValue('Asha Verma');
  await expect(page.getByLabel('Type the number again')).toHaveValue(PHONE);
  await page.getByLabel('Patient agreed to this booking').check();
  await page.getByRole('button', { name: 'Next: choose the doctor' }).click();
  const form = page.getByRole('form', { name: 'Doctor' });
  await form.getByLabel('What does the patient need?').selectOption('General Physician');
  await form.getByLabel('On this pharmacy’s device').check();
  await form.getByLabel('Language the patient speaks').selectOption('hi');
  await form.getByRole('button', { name: 'Next: check the price' }).click();
  await page.getByRole('group', { name: 'Check and pay' }).getByRole('button', { name: 'Pay ₹500.00 from wallet and request' }).click();
  await expect(page.getByRole('heading', { name: 'Waiting for a doctor' })).toBeVisible();
  const asked = b.calls.find((c) => c.method === 'POST' && c.path === '/pharmacy-assisted/instant/requests')!.body!;
  expect(asked).toMatchObject({ phone: PHONE, patient: { name: 'Asha Verma' }, paymentMethod: 'wallet' });

  // + New → the same Asha → Medicines in cash, with the bill.
  await page.goto('/#/');
  await bigButtons(page).getByRole('link', { name: '+ New' }).click();
  await page.getByRole('button', { name: 'Continue with Asha Verma' }).click();
  await page.getByRole('link', { name: /^Medicines/ }).click();
  const customer = page.getByRole('region', { name: 'Customer' });
  await expect(customer.getByLabel('Customer’s name')).toHaveValue('Asha Verma');
  await expect(customer.getByLabel('Mobile number (10 digits)')).toHaveValue(PHONE);
  await customer.getByRole('checkbox').check();
  const lines = page.getByRole('region', { name: 'Medicines' });
  await lines.getByLabel('Find a medicine in your stock').fill('dolo');
  await lines.getByRole('button', { name: 'Search' }).click();
  await lines.getByRole('button', { name: 'Add Dolo 650' }).click();
  await lines.getByLabel('Quantity of Dolo 650').fill('10');
  await page.getByRole('button', { name: 'Next: check the sale' }).click();
  await page.getByRole('group', { name: 'Check the sale' }).getByRole('button', { name: 'Create sale' }).click();
  const pay = page.getByRole('region', { name: 'Payment at the counter' });
  await pay.getByLabel('Cash').check();
  await pay.getByRole('button', { name: 'Mark paid' }).click();
  await pay.getByRole('button', { name: 'Yes, it is paid' }).click();
  await expect(page.getByRole('region', { name: 'Bill PO-100' })).toContainText('Paid by Cash');

  // Today shows both, with the money split.
  await page.goto('/#/pharmacy/today');
  await expect(page.getByRole('heading', { name: 'Today', level: 1 })).toBeVisible();
  await expect(page.getByLabel('Money of the day')).toHaveText('Collected ₹820.00: cash ₹320.00 · UPI ₹0.00 · wallet ₹500.00 · to collect ₹0.00');
  const rows = page.getByRole('list', { name: 'The day’s visits, sales and tests, in the order they were made' }).getByRole('listitem');
  await expect(rows).toHaveCount(2);
  // In the order they were made, as in a register.
  await expect(rows.nth(0)).toContainText('Asha Verma: Dr Kavya · now · video');
  await expect(rows.nth(0)).toContainText('Paid (wallet)');
  await expect(rows.nth(1)).toContainText('Asha Verma: Dolo 650');
  await expect(rows.nth(1)).toContainText('₹320.00');
  await expect(rows.nth(1)).toContainText('Paid (cash)');
  await page.getByLabel('Search by name or ref').fill('K7Q');
  await expect(rows).toHaveCount(1);
  await rows.nth(0).getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`/pharmacy/consultations/${REQ}$`));
  // No patient's name or phone is kept on this device or put in an address.
  expect(await stored(page)).not.toMatch(new RegExp(`${PHONE}|Asha`));
  expect(b.calls.some((c) => c.path.includes(PHONE) || c.path.includes('Asha'))).toBe(false);
}

test('example 1: a new patient, a video consult from the wallet, then medicines in cash; Today shows both with totals; a to-do', async ({ page }) => {
  const b = await mockBackend(page);
  await exampleOne(page, b);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 412, height: 915 }, hasTouch: true });
  test('example 1 on a phone: the big buttons first, the menu behind More', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'the phone size runs once');
    const b = await mockBackend(page);
    await signIn(page);
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden();
    await page.getByRole('button', { name: 'More' }).click();
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Stock', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close the menu' }).click();
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden();
    // Every big button is at least 48 px tall.
    for (const box of await Promise.all((await bigButtons(page).getByRole('link').all()).map((l) => l.boundingBox()))) expect(box!.height).toBeGreaterThanOrEqual(48);
    b.calls.length = 0;
    await exampleOne(page, b, true);
  });
});

test('no internet: the register says so with Try again; a to-do that did not go keeps its text and is sent again', async ({ page }) => {
  const b = await mockBackend(page);
  b.offline = true;
  await signIn(page);
  await expect(page.getByText('No internet connection. Check it, then tap Try again. Nothing you typed is lost.').first()).toBeVisible({ timeout: 15_000 });
  b.offline = false;
  await page.getByRole('button', { name: 'Try again' }).first().click();
  await expect(page.getByText('Nothing yet today')).toBeVisible();
  b.todoOfflineOnce = true;
  await page.getByLabel('New to-do').fill('Order more ORS');
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByLabel('New to-do')).toHaveValue('Order more ORS');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('checkbox', { name: 'Order more ORS' })).toBeVisible();
  const adds = b.calls.filter((c) => c.method === 'POST' && c.path === '/pharmacy-assisted/todos');
  expect(adds).toHaveLength(2);
  expect(adds[1]!.body!.requestKey).toBe(adds[0]!.body!.requestKey);
  expect(b.todos).toHaveLength(1);
  // r37b: 500 open to-dos at most: said in words, the text kept.
  await page.getByLabel('New to-do').fill('one too many');
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByText('There are 500 open to-dos. Tick the done ones, then add this one.')).toBeVisible();
  await expect(page.getByLabel('New to-do')).toHaveValue('one too many');
});

test('Find patient: found by phone through a POST search, then what they need', async ({ page }) => {
  const b = await mockBackend(page);
  b.orders.push({ _id: 'x' });
  await signIn(page);
  await bigButtons(page).getByRole('link', { name: 'Find patient' }).click();
  await expect(page.getByRole('heading', { name: 'Find patient', level: 1 })).toBeVisible();
  await page.getByLabel('Phone number or name').fill(PHONE);
  await page.getByRole('button', { name: 'Find' }).click();
  await page.getByRole('button', { name: `Choose Asha Verma · ${PHONE}` }).click();
  await expect(page.getByRole('link', { name: /^Lab test/ })).toHaveAttribute('href', '#/pharmacy/lab-book?visit=1');
  expect(b.calls.find((c) => c.path === '/pharmacy-customers/search')!.body).toMatchObject({ search: PHONE });
});

test('what waits: an unpaid counter sale is one tap from its page; each row opens its record', async ({ page }) => {
  const b = await mockBackend(page);
  const SALE = '91'.padStart(24, '0');
  b.register.push({ kind: 'wallet_topup', id: 'f1'.padStart(24, '0'), at: NOW.toISOString(), shortRef: null, patientName: null, what: 'Wallet top-up', amountMinor: 100000,
    paid: false, method: 'upi', status: 'credited', link: { kind: 'wallet_transaction', id: 'f1'.padStart(24, '0') } });
  b.register.push({ kind: 'order', id: SALE, at: NOW.toISOString(), shortRef: 'PO-7', patientName: 'Ravi K.', what: 'Dolo 650 +1 more', amountMinor: 12000, paid: false,
    method: null, status: 'placed', link: { kind: 'pharmacy_order', id: SALE } });
  b.register.push({ kind: 'order', id: '92'.padStart(24, '0'), at: NOW.toISOString(), shortRef: 'PO-6', patientName: 'Meena S.', what: 'ORS', amountMinor: 5000, paid: true,
    method: 'cash', status: 'completed', paidToday: true, madeOn: '2026-11-24', link: { kind: 'pharmacy_order', id: '92'.padStart(24, '0') } });
  b.pendingExtra = { labReportsReady: null, cardPaymentsWaiting: { count: 2, amountMinor: 90000, items: [{ kind: 'booking', id: 'b1'.repeat(12) }, { kind: 'lab_booking', id: 'b2'.repeat(12) }] } };
  await signIn(page);
  await expect(page.getByRole('link', { name: '1 unpaid sale' })).toHaveAttribute('href', `#/pharmacy/sale/${SALE}`);
  await expect(page.getByRole('link', { name: /Ravi K\.\s?: Dolo 650 \+1 more/ })).toHaveAttribute('href', `#/pharmacy/orders/${SALE}`);
  await expect(page.getByRole('link', { name: /Wallet top-up/ })).toHaveAttribute('href', '#/pharmacy/wallet');
  // r37b: an earlier day's sale paid today says so; a queue the server could not read says so on its own line.
  await expect(page.getByText('paid today · made 24 Nov 2026')).toBeVisible();
  await expect(page.getByText('Lab reports ready: couldn’t load')).toBeVisible();
  await expect(page.getByRole('link', { name: '2 card payments waiting' })).toHaveAttribute('href', '#/pharmacy/consultations');
});
