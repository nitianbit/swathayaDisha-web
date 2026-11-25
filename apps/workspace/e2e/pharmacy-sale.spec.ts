import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * WQ50: Pharmacy › New sale (backend stage 43f46f57, mocked): a walk-in linked by name and phone (`POST /pharmacy-customers`,
 * found or made by phone) or a customer of the pharmacy, medicines from active stock, an optional prescription, the
 * in-store order (`POST /pharmacy-orders`: priced by the server with tax; a prescription medicine puts it under the
 * pharmacist's review, P9; no request key on the server, so a lost answer is found among the customer's in-store
 * orders), the bill and the counter payment (`/mark-paid`, refused until the pharmacist approved an Rx order).
 */
const PH = 'aa'.repeat(12);
const KNOWN = 'c1'.repeat(12);
const NEW_USER = 'c2'.repeat(12);
const PARA = 'a1'.repeat(12);
const AMOX = 'b2'.repeat(12);
const NOW = new Date('2026-11-26T05:30:00.000Z');

type Json = Record<string, unknown>;
interface Backend {
  calls: { method: string; path: string; body: Json | null }[];
  orders: Json[];
  stock: Record<string, number>;
  /** The next create is recorded, then its answer is lost. */
  loseNextCreate: boolean;
  /** WQ50b: the next create is lost before anything is recorded. */
  dropNextCreate: boolean;
  /** WQ50b: the server's prescription gate is down (503 PRESCRIPTION_CHECKOUT_UNAVAILABLE, nothing written). */
  rxGateDown: boolean;
  /** WQ50b: the prescription upload answers only once this is resolved. */
  holdUpload: Promise<void> | null;
  /** r36: request keys (order id each produced) and those given up; indexes not built yet. */
  keys: Record<string, string>;
  abandoned: string[];
  indexesOutdated: boolean;
  /** A replay of a recorded key is refused as another body (409 IDEMPOTENCY_KEY_REUSED). */
  reuseOnReplay: boolean;
}
const MEDICINES: Record<string, { name: string; price: number; rx: boolean; gst: number }> = {
  [PARA]: { name: 'Paracetamol 500mg', price: 20, rx: false, gst: 5 },
  [AMOX]: { name: 'Amoxicillin 250mg', price: 90, rx: true, gst: 12 },
};

async function mockBackend(page: Page, init: Partial<Backend> = {}): Promise<Backend> {
  await page.clock.setFixedTime(NOW);
  const b: Backend = { calls: [], orders: [], stock: { [PARA]: 30, [AMOX]: 5 }, loseNextCreate: false, dropNextCreate: false, rxGateDown: false, holdUpload: null, keys: {}, abandoned: [], indexesOutdated: false, reuseOnReplay: false, ...init };
  /** r36 `pharmacyView`: the customer by the pharmacy-facing name rule, and the cash memo's `bill`. */
  const view = (o: Json) => ({ ...o, customerId: o.customerId === KNOWN ? { _id: KNOWN, name: 'Ravi Kumar', phone: '9876500001' } : { _id: o.customerId, name: 'Meena S.', phone: '9123456780' },
    bill: { pharmacy: { name: 'Asha Medicals', address: '12 MG Road', city: 'Pune', state: 'Maharashtra', pincode: '411001', gstNumber: '27ABCDE1234F1Z5',
      drugLicenseNumber: 'MH-PUNE-20B-1234' }, paymentMethod: o.paymentStatus === 'paid' ? o.paymentSource ?? 'in_store_payment' : null,
    paidAt: o.paymentStatus === 'paid' ? NOW.toISOString() : null } });
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const ok = (route: Route, data: unknown, status = 200, extra: Json = {}) => json(route, status, { success: true, data, ...extra });
  const refuse = (route: Route, status: number, code: string) => json(route, status, { error: status, code, message: code });
  let live = false;
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = req.method();
    const body = method === 'POST' && !path.startsWith('/file/') ? (req.postDataJSON() as Json | null) : null;
    if (path === '/auth/session/refresh') return live ? ok(route, { token: 'tp', expiresIn: 900, principal: { userId: PH, userType: 'pharmacy', sid: 's1' } }) : refuse(route, 401, 'SESSION_ENDED');
    if (path.startsWith('/auth/session')) return ok(route, {});
    b.calls.push({ method, path: `${path}${url.search}`, body });
    if (path === '/auth/pharmacy/send') return ok(route, undefined);
    if (path === '/auth/pharmacy/verify') { live = true; return ok(route, { token: 'tp', expiresIn: 900, user: {} }); }
    if (req.headers().authorization !== 'Bearer tp') return refuse(route, 401, 'UNAUTHORIZED');
    if (path === '/auth/profile') return ok(route, { user: { _id: PH, name: 'Asha Medicals' }, userRole: 'pharmacy' });

    // r36: the search is a POST (nothing in the address).
    if (path === '/pharmacy-customers/search' && method === 'POST') {
      const s = String(body!.search ?? '').toLowerCase();
      const rows = [{ _id: 'd1'.repeat(12), userId: { _id: KNOWN, name: 'Ravi Kumar', phone: '9876500001', email: null }, typedName: 'Ravi Kumar' }]
        .filter((r) => !s || r.userId.name.toLowerCase().includes(s) || r.userId.phone.includes(s));
      return ok(route, rows, 200, { pagination: { page: 1, limit: 20, total: rows.length, totalPages: 1 } });
    }
    if (path === '/pharmacy-customers' && method === 'POST') {
      if (body!.consent !== true) return refuse(route, 400, 'CONSENT_REQUIRED');
      return ok(route, { customer: { _id: 'd2'.repeat(12) }, userId: NEW_USER, isNewUser: true }, 201);
    }
    if (path === '/pharmacy-inventory') {
      if (url.searchParams.get('isActive') !== 'true') return refuse(route, 400, 'EXPECTED_ACTIVE_ONLY');
      const s = (url.searchParams.get('search') ?? '').toLowerCase();
      const items = Object.entries(MEDICINES).filter(([, m]) => m.name.toLowerCase().includes(s)).map(([id, m], i) => ({
        _id: `e${i}`.padStart(24, '0'), medicineId: { _id: id, name: m.name, prescriptionRequired: m.rx }, availableQty: b.stock[id], reservedQty: 0, reorderThreshold: 5, isActive: true,
        retailPrice: m.price, batches: [{ _id: `f${i}`.padStart(24, '0'), batchNumber: `B${i}`, expiryDate: '20281231', availableQty: b.stock[id], reservedQty: 0, status: 'active' }] }));
      return ok(route, items, 200, { pagination: { page: 1, limit: 20, total: items.length, totalPages: 1 } });
    }
    if (path === '/file/upload/pharmacy-order-prescription') {
      if (b.holdUpload) await b.holdUpload;
      return ok(route, { files: [{ url: '/api/static/pharmacy-order-prescription/rx-1.pdf' }] });
    }
    if (path === '/pharmacies/me/profile') {
      return ok(route, { _id: PH, name: 'Asha Medicals', address: '12 MG Road', city: 'Pune', state: 'Maharashtra', pincode: '411001', gstNumber: '27ABCDE1234F1Z5', pharmacist: null });
    }

    if (path === '/pharmacy-orders' && method === 'POST') {
      const x = body!;
      if (x.orderType !== 'in_store' || x.paymentMode !== 'in_store_payment' || x.deliveryMode !== 'pickup' || 'unitPrice' in (x.items as Json[])[0]!) {
        return refuse(route, 400, 'VALIDATION_ERROR');
      }
      const lines = (x.items as { medicineId: string; orderedQty: number }[]);
      const key = String(x.requestKey ?? '');
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) return refuse(route, 400, 'VALIDATION_ERROR');
      if (b.indexesOutdated) return refuse(route, 503, 'INDEXES_OUTDATED');
      if (b.abandoned.includes(key)) return refuse(route, 409, 'REQUEST_ABANDONED');
      if (b.keys[key] && b.reuseOnReplay) return refuse(route, 409, 'IDEMPOTENCY_KEY_REUSED');
      if (b.keys[key]) return ok(route, { order: view(b.orders.find((o) => o._id === b.keys[key])!), paymentRequired: false, replayed: true });
      if (b.rxGateDown) return refuse(route, 503, 'PRESCRIPTION_CHECKOUT_UNAVAILABLE');
      if (b.dropNextCreate) { b.dropNextCreate = false; return route.abort('connectionreset'); }
      if (lines.some((l) => l.orderedQty > b.stock[l.medicineId]!)) return refuse(route, 409, 'INSUFFICIENT_BATCH_STOCK');
      const items = lines.map((l) => {
        const m = MEDICINES[l.medicineId]!;
        // Prices include GST (computeTotals): the line total is price × quantity; the tax is the part of it that is GST.
        const lineTotal = m.price * l.orderedQty;
        return { medicineId: l.medicineId, medicineName: m.name, orderedQty: l.orderedQty, unitPrice: m.price, lineTotal, taxAmount: Math.round(lineTotal * m.gst / (100 + m.gst) * 100) / 100,
          prescriptionRequired: m.rx, gstPercent: m.gst, itemStatus: 'active', batchAllocations: [{ batchId: 'f'.repeat(24), batchNumber: 'B7', expiryDate: '20281231', quantity: l.orderedQty }] };
      });
      for (const l of lines) b.stock[l.medicineId]! -= l.orderedQty;
      const subtotal = items.reduce((a, l) => a + l.lineTotal, 0);
      const grandTotal = subtotal;
      const order = { _id: `9${b.orders.length}`.padStart(24, '0'), orderNumber: `PO-${100 + b.orders.length}`, pharmacyId: PH, customerId: x.customerId, orderType: 'in_store',
        status: 'placed', items, subtotal, discountTotal: 0, taxTotal: items.reduce((a, l) => a + l.taxAmount, 0), grandTotal, paymentMode: 'in_store_payment', paymentStatus: 'pending',
        deliveryMode: 'pickup', isWalkIn: x.isWalkIn, prescriptionUrls: x.prescriptionUrls ?? [], prescriptionStatus: items.some((i) => i.prescriptionRequired) ? 'pending' : 'not_required',
        createdAt: NOW.toISOString() };
      b.orders.unshift(order);
      b.keys[key] = String(order._id);
      if (b.loseNextCreate) { b.loseNextCreate = false; return route.abort('connectionreset'); }
      return ok(route, { order: view(order), paymentRequired: false }, 201);
    }
    if (path === '/pharmacy-orders' && method === 'GET') {
      const cid = url.searchParams.get('customerId');
      const rows = b.orders.filter((o) => (!cid || o.customerId === cid) && (!url.searchParams.get('orderType') || o.orderType === url.searchParams.get('orderType')));
      return ok(route, rows, 200, { pagination: { page: 1, limit: 20, total: rows.length, totalPages: 1 } });
    }
    const byKey = /^\/pharmacy-orders\/by-key\/([\w-]+)(\/abandon)?$/.exec(path);
    if (byKey) {
      const id = b.keys[byKey[1]!];
      if (id) return ok(route, { state: 'used', order: view(b.orders.find((o) => o._id === id)!) });
      if (byKey[2]) b.abandoned.push(byKey[1]!);
      return ok(route, { state: b.abandoned.includes(byKey[1]!) ? 'abandoned' : 'unknown' });
    }
    const one = /^\/pharmacy-orders\/(\w{24})(\/mark-paid)?$/.exec(path);
    if (one) {
      const o = b.orders.find((x) => x._id === one[1]);
      if (!o) return refuse(route, 404, 'ORDER_NOT_FOUND');
      if (!one[2]) return ok(route, view(o));
      if (o.paymentStatus === 'paid') return refuse(route, 400, 'ORDER_ALREADY_PAID');
      if (o.prescriptionStatus !== 'not_required') return refuse(route, 409, 'PRESCRIPTION_REVIEW_REQUIRED');
      Object.assign(o, { paymentStatus: 'paid', paymentSource: body!.paymentSource });
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
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}
const writes = (b: Backend) => b.calls.filter((c) => c.method === 'POST' && !c.path.startsWith('/auth/'));
const stored = (page: Page) => page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + location.href);

async function addMedicine(page: Page, search: string, name: string, qty: string) {
  const lines = page.getByRole('region', { name: 'Medicines' });
  await lines.getByLabel('Find a medicine in your stock').fill(search);
  await lines.getByRole('button', { name: 'Search' }).click();
  await lines.getByRole('button', { name: `Add ${name}` }).click();
  await lines.getByLabel(`Quantity of ${name}`).fill(qty);
}

const ORDER0 = '90'.padStart(24, '0');
async function chooseKnown(page: Page) {
  const customer = page.getByRole('region', { name: 'Customer' });
  await customer.getByLabel('Search by name or phone').fill('ravi');
  await customer.getByRole('button', { name: 'Search' }).click();
  await customer.getByRole('button', { name: 'Choose Ravi Kumar · 9876500001' }).click();
}
async function createSale(page: Page) {
  await page.getByRole('button', { name: 'Next: check the sale' }).click();
  await page.getByRole('group', { name: 'Check the sale' }).getByRole('button', { name: 'Create sale' }).click();
}

test('a walk-in cash sale: linked by name and phone, prices with GST inside, marked paid, its bill (pharmacy, batches, GST) printed', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'New sale' }).click();
  await expect(page.getByRole('heading', { name: 'New sale', level: 1 })).toBeVisible();
  const customer = page.getByRole('region', { name: 'Customer' });
  await customer.getByLabel('Walk-in customer').check();
  await customer.getByLabel('Customer’s name').fill('Meena Shah');
  await customer.getByLabel('Mobile number (10 digits)').fill('9123456780');
  await expect(customer.getByRole('checkbox')).toHaveAccessibleName(/The customer agreed to be added to your pharmacy’s customers, and to a Jansetu account being made/);
  await customer.getByRole('checkbox').check();
  await addMedicine(page, 'para', 'Paracetamol 500mg', '2');
  await expect(page.getByText('About ₹40.00')).toBeVisible();
  await expect(page.getByText('Prices include tax.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Next: check the sale' }).click();
  const check = page.getByRole('group', { name: 'Check the sale' });
  await expect(check).toContainText('Sell 1 medicine to Meena Shah · 9123456780, about ₹40.00?');
  await check.getByRole('button', { name: 'Create sale' }).click();

  // WQ50b: the sale's own page (a reload shows it again).
  await expect(page).toHaveURL(new RegExp(`/pharmacy/sale/${ORDER0}$`));
  const bill = page.getByRole('region', { name: 'Bill PO-100' });
  await expect(bill).toContainText('Asha Medicals');
  await expect(bill).toContainText('Drug licence MH-PUNE-20B-1234');
  // r36: the customer as this pharmacy may name them (the order read applies the list's rule).
  await expect(bill).toContainText('Meena S. · 9123456780');
  await expect(bill).toContainText('12 MG Road, Pune, Maharashtra, 411001');
  await expect(bill).toContainText('GSTIN 27ABCDE1234F1Z5');
  await expect(bill).toContainText('Walk-in customer');
  await expect(bill).toContainText('Paracetamol 500mgB7, expires 31 Dec 20282₹20.00₹40.00');
  await expect(bill).toContainText('Total₹40.00');
  await expect(bill).toContainText('of which GST ₹1.90');
  await expect(bill).toContainText('Not paid yet');
  await page.reload();
  await expect(bill).toContainText('Total₹40.00');
  const pay = page.getByRole('region', { name: 'Payment at the counter' });
  await pay.getByLabel('Cash').check();
  await pay.getByRole('button', { name: 'Mark paid' }).click();
  await expect(pay).toContainText('Record ₹40.00 received at the counter by Cash?');
  await pay.getByRole('button', { name: 'Yes, it is paid' }).click();
  await expect(bill).toContainText(/PaymentPaid by Cash · /);
  await expect(page.getByRole('region', { name: 'Payment at the counter' })).toHaveCount(0);
  await page.evaluate(() => { (window as unknown as { printed: number }).printed = 0; window.print = () => { (window as unknown as { printed: number }).printed += 1; }; });
  await page.getByRole('button', { name: 'Print the bill' }).click();
  expect(await page.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(1);

  expect(writes(b).map((c) => c.path)).toEqual(['/pharmacy-customers', '/pharmacy-orders', `/pharmacy-orders/${ORDER0}/mark-paid`]);
  expect(writes(b)[0]!.body).toEqual({ name: 'Meena Shah', phone: '9123456780', consent: true });
  expect(writes(b)[1]!.body).toEqual({ orderType: 'in_store', customerId: NEW_USER, items: [{ medicineId: PARA, orderedQty: 2 }], paymentMode: 'in_store_payment',
    deliveryMode: 'pickup', isWalkIn: true, requestKey: expect.stringMatching(/^[A-Za-z0-9_-]{8,64}$/) });
  expect(writes(b)[2]!.body).toEqual({ paymentSource: 'cash' });
  // No customer details are kept on this device or put in the address.
  expect(await stored(page)).not.toMatch(/Meena|9123456780/);
  await page.getByRole('link', { name: 'Start a new sale' }).click();
  await expect(page.getByRole('region', { name: 'Customer' }).getByLabel('Walk-in customer')).not.toBeChecked();
});

test('a known customer with a prescription medicine and its prescription: paid only after the pharmacist approves; Create waits for the upload', async ({ page }) => {
  let release = () => {};
  const b = await mockBackend(page, { holdUpload: new Promise<void>((r) => { release = r; }) });
  await signIn(page);
  await page.goto('/#/pharmacy/sale');
  await chooseKnown(page);
  await expect(page.getByRole('region', { name: 'Customer' })).toContainText('Customer: Ravi Kumar · 9876500001.');
  await addMedicine(page, 'amox', 'Amoxicillin 250mg', '1');
  // r36: the stock list names it a prescription medicine: said before the sale is made.
  await expect(page.getByText('Needs a prescription: Amoxicillin 250mg. Your pharmacist approves the prescription before the sale is paid.')).toBeVisible();
  const rx = page.getByRole('region', { name: 'Prescription (optional)' });
  await rx.getByLabel('Attach a prescription (photo or PDF)').setInputFiles({ name: 'rx.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') });
  // WQ50b: while the file is on its way, the sale cannot be checked or created (it would go without it).
  await expect(page.getByRole('button', { name: 'Next: check the sale' })).toBeDisabled();
  release();
  await expect(rx).toContainText('Prescription 1 attached.');
  await createSale(page);
  const bill = page.getByRole('region', { name: 'Bill PO-100' });
  await expect(bill).toContainText('Amoxicillin 250mg Prescription');
  const pay = page.getByRole('region', { name: 'Payment at the counter' });
  await expect(pay).toContainText('your pharmacist approves the prescription before it is paid');
  await expect(pay.getByRole('button', { name: 'Mark paid' })).toHaveCount(0);
  await expect(pay.getByRole('link', { name: 'Review the prescription' })).toHaveAttribute('href', `#/pharmacy/prescriptions/${ORDER0}?from=sale`);
  await pay.getByRole('link', { name: 'Review the prescription' }).click();
  await page.getByRole('link', { name: 'Back to the sale' }).click();
  await expect(page).toHaveURL(new RegExp(`/pharmacy/sale/${ORDER0}$`));
  const create = writes(b).find((c) => c.path === '/pharmacy-orders')!;
  expect(create.body).toMatchObject({ customerId: KNOWN, isWalkIn: false, items: [{ medicineId: AMOX, orderedQty: 1 }],
    prescriptionUrls: ['/api/static/pharmacy-order-prescription/rx-1.pdf'] });
  expect(writes(b).some((c) => c.path === '/pharmacy-customers')).toBe(false);
});

test('refusals: checked before asking, the server’s stock refusal and its prescription gate in words, nothing sold', async ({ page }) => {
  const b = await mockBackend(page, { stock: { [PARA]: 3, [AMOX]: 5 } });
  await signIn(page);
  await page.goto('/#/pharmacy/sale');
  await page.getByRole('button', { name: 'Next: check the sale' }).click();
  await expect(page.getByText('Choose the customer, or enter the walk-in customer’s name and phone.')).toBeVisible();
  await expect(page.getByText('Add at least one medicine.')).toBeVisible();
  const customer = page.getByRole('region', { name: 'Customer' });
  await customer.getByLabel('Walk-in customer').check();
  await customer.getByLabel('Mobile number (10 digits)').fill('12345');
  await addMedicine(page, 'para', 'Paracetamol 500mg', '9');
  await page.getByRole('button', { name: 'Next: check the sale' }).click();
  await expect(page.getByText('Enter the customer’s name (at most 200 characters).')).toBeVisible();
  await expect(page.getByText('Enter a 10-digit mobile number.')).toBeVisible();
  await expect(page.getByText('Ask the customer first; tick this only when they agree.')).toBeVisible();
  await expect(page.getByText('Each quantity must be a whole number from 1 to what is in stock.')).toBeVisible();
  expect(writes(b)).toHaveLength(0);

  // Someone else sold some meanwhile: the server refuses, in words; nothing was sold.
  await customer.getByLabel('Customer’s name').fill('Meena Shah');
  await customer.getByLabel('Mobile number (10 digits)').fill('9123456780');
  await customer.getByRole('checkbox').check();
  await page.getByLabel('Quantity of Paracetamol 500mg').fill('3');
  b.stock[PARA] = 1;
  await createSale(page);
  await expect(page.getByText('Not enough of a medicine is in stock now. Search it again and lower the quantity.')).toBeVisible();
  // WQ50b: the prescription gate down (503, decided before anything is written) is a refusal in words, not an unknown outcome.
  b.stock[PARA] = 3;
  b.rxGateDown = true;
  await createSale(page);
  await expect(page.getByText('Sales with prescriptions are not available right now. Try again later.')).toBeVisible();
  // r36: the server's indexes not built yet (503, nothing written): said, not an unknown outcome.
  b.rxGateDown = false;
  b.indexesOutdated = true;
  await createSale(page);
  await expect(page.getByText('Sales cannot be made until the server is updated. Please ask the Jansetu team.')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Unconfirmed sale' })).toHaveCount(0);
  expect(b.orders).toHaveLength(0);
  await expect(page.getByRole('button', { name: 'Next: check the sale' })).toBeVisible();
});

test('a lost answer: the same sale sent again under its key answers the first one (never two sales)', async ({ page }) => {
  const b = await mockBackend(page, { loseNextCreate: true });
  await signIn(page);
  await page.goto('/#/pharmacy/sale');
  await chooseKnown(page);
  await addMedicine(page, 'para', 'Paracetamol 500mg', '2');
  await createSale(page);
  const panel = page.getByRole('group', { name: 'Unconfirmed sale' });
  await expect(panel).toContainText('Sending the same sale again is safe: it is never made twice.');
  await panel.getByRole('button', { name: 'Send the same sale again' }).click();
  await expect(page).toHaveURL(new RegExp(`/pharmacy/sale/${ORDER0}$`));
  await expect(page.getByRole('region', { name: 'Bill PO-100' })).toBeVisible();
  const sent = writes(b).filter((c) => c.path === '/pharmacy-orders');
  expect(sent).toHaveLength(2);
  expect(sent[1]!.body).toEqual(sent[0]!.body);
  expect(b.orders).toHaveLength(1);
});

test('a lost answer that recorded nothing: checked by its key, then given up (it can never be made)', async ({ page }) => {
  const b = await mockBackend(page, { dropNextCreate: true });
  await signIn(page);
  await page.goto('/#/pharmacy/sale');
  await chooseKnown(page);
  await addMedicine(page, 'para', 'Paracetamol 500mg', '2');
  await createSale(page);
  const panel = page.getByRole('group', { name: 'Unconfirmed sale' });
  await expect(panel).toContainText(/The outcome of this sale is not known yet \(.+\)/);
  await panel.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(panel).toContainText('Not recorded so far. It may still be on its way. Sending the same sale again is safe.');
  await panel.getByRole('button', { name: 'Give this up' }).click();
  await expect(page.getByText('Given up: nothing was sold with that request, and it can never be made now.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next: check the sale' })).toBeVisible();
  expect(b.orders).toHaveLength(0);
  const key = String(writes(b).find((c) => c.path === '/pharmacy-orders')!.body!.requestKey);
  expect(b.calls.filter((c) => c.path.startsWith('/pharmacy-orders/by-key/')).map((c) => c.path)).toEqual([
    `/pharmacy-orders/by-key/${key}`, `/pharmacy-orders/by-key/${key}/abandon`]);
  // Nothing about the sale is kept on this device or put in the address.
  expect(await stored(page)).not.toMatch(/Ravi|9876500001/);
});

test('a replay answers the sale as it is now: cancelled meanwhile, it says so and prints no bill', async ({ page }) => {
  const b = await mockBackend(page, { loseNextCreate: true });
  await signIn(page);
  await page.goto('/#/pharmacy/sale');
  await chooseKnown(page);
  await addMedicine(page, 'para', 'Paracetamol 500mg', '2');
  await createSale(page);
  b.orders[0]!.status = 'cancelled';
  await page.getByRole('group', { name: 'Unconfirmed sale' }).getByRole('button', { name: 'Send the same sale again' }).click();
  await expect(page.getByText('Sale PO-100: Cancelled. It has no bill to print.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Print the bill' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Bill PO-100' })).toHaveCount(0);
});

test('a resend refused as another body: what the key holds is read by the key', async ({ page }) => {
  const b = await mockBackend(page, { loseNextCreate: true, reuseOnReplay: true });
  await signIn(page);
  await page.goto('/#/pharmacy/sale');
  await chooseKnown(page);
  await addMedicine(page, 'para', 'Paracetamol 500mg', '2');
  await createSale(page);
  await page.getByRole('group', { name: 'Unconfirmed sale' }).getByRole('button', { name: 'Send the same sale again' }).click();
  await expect(page).toHaveURL(new RegExp(`/pharmacy/sale/${ORDER0}$`));
  await expect(page.getByRole('region', { name: 'Bill PO-100' })).toBeVisible();
  expect(b.calls.some((c) => c.path.startsWith('/pharmacy-orders/by-key/'))).toBe(true);
});
