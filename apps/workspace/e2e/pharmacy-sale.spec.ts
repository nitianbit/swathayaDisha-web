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
}
const MEDICINES: Record<string, { name: string; price: number; rx: boolean; gst: number }> = {
  [PARA]: { name: 'Paracetamol 500mg', price: 20, rx: false, gst: 5 },
  [AMOX]: { name: 'Amoxicillin 250mg', price: 90, rx: true, gst: 12 },
};

async function mockBackend(page: Page, init: Partial<Backend> = {}): Promise<Backend> {
  await page.clock.setFixedTime(NOW);
  const b: Backend = { calls: [], orders: [], stock: { [PARA]: 30, [AMOX]: 5 }, loseNextCreate: false, ...init };
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

    if (path === '/pharmacy-customers' && method === 'GET') {
      const s = (url.searchParams.get('search') ?? '').toLowerCase();
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
        _id: `e${i}`.padStart(24, '0'), medicineId: { _id: id, name: m.name }, availableQty: b.stock[id], reservedQty: 0, reorderThreshold: 5, isActive: true,
        retailPrice: m.price, batches: [{ _id: `f${i}`.padStart(24, '0'), batchNumber: `B${i}`, expiryDate: '20281231', availableQty: b.stock[id], reservedQty: 0, status: 'active' }] }));
      return ok(route, items, 200, { pagination: { page: 1, limit: 20, total: items.length, totalPages: 1 } });
    }
    if (path === '/file/upload/pharmacy-order-prescription') return ok(route, { files: [{ url: '/api/static/pharmacy-order-prescription/rx-1.pdf' }] });

    if (path === '/pharmacy-orders' && method === 'POST') {
      const x = body!;
      if (x.orderType !== 'in_store' || x.paymentMode !== 'in_store_payment' || x.deliveryMode !== 'pickup' || 'requestKey' in x || 'unitPrice' in (x.items as Json[])[0]!) {
        return refuse(route, 400, 'VALIDATION_ERROR');
      }
      const lines = (x.items as { medicineId: string; orderedQty: number }[]);
      if (lines.some((l) => l.orderedQty > b.stock[l.medicineId]!)) return refuse(route, 409, 'INSUFFICIENT_BATCH_STOCK');
      const items = lines.map((l) => {
        const m = MEDICINES[l.medicineId]!;
        return { medicineId: l.medicineId, medicineName: m.name, orderedQty: l.orderedQty, unitPrice: m.price, lineTotal: m.price * l.orderedQty * (1 + m.gst / 100),
          prescriptionRequired: m.rx, gstPercent: m.gst, itemStatus: 'active' };
      });
      for (const l of lines) b.stock[l.medicineId]! -= l.orderedQty;
      const subtotal = lines.reduce((a, l) => a + MEDICINES[l.medicineId]!.price * l.orderedQty, 0);
      const grandTotal = items.reduce((a, l) => a + l.lineTotal, 0);
      const order = { _id: `9${b.orders.length}`.padStart(24, '0'), orderNumber: `PO-${100 + b.orders.length}`, pharmacyId: PH, customerId: x.customerId, orderType: 'in_store',
        status: 'placed', items, subtotal, discountTotal: 0, taxTotal: grandTotal - subtotal, grandTotal, paymentMode: 'in_store_payment', paymentStatus: 'pending',
        deliveryMode: 'pickup', isWalkIn: x.isWalkIn, prescriptionUrls: x.prescriptionUrls ?? [], prescriptionStatus: items.some((i) => i.prescriptionRequired) ? 'pending' : 'not_required',
        createdAt: NOW.toISOString() };
      b.orders.unshift(order);
      if (b.loseNextCreate) { b.loseNextCreate = false; return route.abort('connectionreset'); }
      return ok(route, { order, paymentRequired: false }, 201);
    }
    if (path === '/pharmacy-orders' && method === 'GET') {
      const cid = url.searchParams.get('customerId');
      const rows = b.orders.filter((o) => (!cid || o.customerId === cid) && (!url.searchParams.get('orderType') || o.orderType === url.searchParams.get('orderType')));
      return ok(route, rows, 200, { pagination: { page: 1, limit: 20, total: rows.length, totalPages: 1 } });
    }
    const one = /^\/pharmacy-orders\/(\w{24})(\/mark-paid)?$/.exec(path);
    if (one) {
      const o = b.orders.find((x) => x._id === one[1]);
      if (!o) return refuse(route, 404, 'ORDER_NOT_FOUND');
      if (!one[2]) return ok(route, o);
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

test('a walk-in cash sale: linked by name and phone, priced with tax by the server, marked paid, its bill printed', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'New sale' }).click();
  await expect(page.getByRole('heading', { name: 'New sale', level: 1 })).toBeVisible();
  const customer = page.getByRole('region', { name: 'Customer' });
  await customer.getByLabel('Walk-in customer').check();
  await customer.getByLabel('Customer’s name').fill('Meena Shah');
  await customer.getByLabel('Mobile number (10 digits)').fill('9123456780');
  await customer.getByLabel('The customer agreed to be added to your pharmacy’s customers').check();
  await addMedicine(page, 'para', 'Paracetamol 500mg', '2');
  await expect(page.getByText('About ₹40.00')).toBeVisible();
  await page.getByRole('button', { name: 'Next: check the sale' }).click();
  const check = page.getByRole('group', { name: 'Check the sale' });
  await expect(check).toContainText('Sell 1 medicine to Meena Shah · 9123456780, about ₹40.00?');
  await check.getByRole('button', { name: 'Create sale' }).click();

  await expect(page.getByText('Sale PO-100 created.')).toBeVisible();
  const bill = page.getByRole('region', { name: 'Bill PO-100' });
  await expect(bill).toContainText('Paracetamol 500mg2₹20.00₹42.00');
  await expect(bill).toContainText('Tax₹2.00');
  await expect(bill).toContainText('Total₹42.00');
  await expect(bill).toContainText('Not paid yet');
  const pay = page.getByRole('region', { name: 'Payment at the counter' });
  await pay.getByLabel('Cash').check();
  await pay.getByRole('button', { name: 'Mark paid' }).click();
  await expect(pay).toContainText('Record ₹42.00 received at the counter by Cash?');
  await pay.getByRole('button', { name: 'Yes, it is paid' }).click();
  await expect(bill).toContainText('PaymentPaid');
  await expect(page.getByRole('region', { name: 'Payment at the counter' })).toHaveCount(0);
  await page.evaluate(() => { (window as unknown as { printed: number }).printed = 0; window.print = () => { (window as unknown as { printed: number }).printed += 1; }; });
  await page.getByRole('button', { name: 'Print the bill' }).click();
  expect(await page.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(1);

  expect(writes(b).map((c) => c.path)).toEqual(['/pharmacy-customers', '/pharmacy-orders', `/pharmacy-orders/${'90'.padStart(24, '0')}/mark-paid`]);
  expect(writes(b)[0]!.body).toEqual({ name: 'Meena Shah', phone: '9123456780', consent: true });
  expect(writes(b)[1]!.body).toEqual({ orderType: 'in_store', customerId: NEW_USER, items: [{ medicineId: PARA, orderedQty: 2 }], paymentMode: 'in_store_payment',
    deliveryMode: 'pickup', isWalkIn: true });
  expect(writes(b)[2]!.body).toEqual({ paymentSource: 'cash' });
  // No customer details are kept on this device or put in the address.
  expect(await stored(page)).not.toMatch(/Meena|9123456780/);
  await page.getByRole('button', { name: 'Start a new sale' }).click();
  await expect(page.getByRole('region', { name: 'Customer' }).getByLabel('Walk-in customer')).not.toBeChecked();
});

test('a known customer with a prescription medicine and its prescription: paid only after the pharmacist approves', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await page.goto('/#/pharmacy/sale');
  const customer = page.getByRole('region', { name: 'Customer' });
  await customer.getByLabel('Search by name or phone').fill('ravi');
  await customer.getByRole('button', { name: 'Search' }).click();
  await customer.getByRole('button', { name: 'Choose Ravi Kumar · 9876500001' }).click();
  await expect(customer).toContainText('Customer: Ravi Kumar · 9876500001.');
  await addMedicine(page, 'amox', 'Amoxicillin 250mg', '1');
  const rx = page.getByRole('region', { name: 'Prescription (optional)' });
  await rx.getByLabel('Attach a prescription (photo or PDF)').setInputFiles({ name: 'rx.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') });
  await expect(rx).toContainText('Prescription 1 attached.');
  await page.getByRole('button', { name: 'Next: check the sale' }).click();
  await page.getByRole('button', { name: 'Create sale' }).click();
  const bill = page.getByRole('region', { name: 'Bill PO-100' });
  await expect(bill).toContainText('Amoxicillin 250mg Prescription');
  const pay = page.getByRole('region', { name: 'Payment at the counter' });
  await expect(pay).toContainText('your pharmacist approves the prescription before it is paid');
  await expect(pay.getByRole('button', { name: 'Mark paid' })).toHaveCount(0);
  await expect(pay.getByRole('link', { name: 'Review the prescription' })).toHaveAttribute('href', `#/pharmacy/prescriptions/${'90'.padStart(24, '0')}`);
  const create = writes(b).find((c) => c.path === '/pharmacy-orders')!;
  expect(create.body).toMatchObject({ customerId: KNOWN, isWalkIn: false, items: [{ medicineId: AMOX, orderedQty: 1 }],
    prescriptionUrls: ['/api/static/pharmacy-order-prescription/rx-1.pdf'] });
  expect(writes(b).some((c) => c.path === '/pharmacy-customers')).toBe(false);
});

test('refusals: checked before asking, the server’s stock refusal in words, nothing sold', async ({ page }) => {
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
  await customer.getByLabel('The customer agreed to be added to your pharmacy’s customers').check();
  await page.getByLabel('Quantity of Paracetamol 500mg').fill('3');
  b.stock[PARA] = 1;
  await page.getByRole('button', { name: 'Next: check the sale' }).click();
  await page.getByRole('button', { name: 'Create sale' }).click();
  await expect(page.getByText('Not enough of a medicine is in stock now. Search it again and lower the quantity.')).toBeVisible();
  expect(b.orders).toHaveLength(0);
  await expect(page.getByRole('button', { name: 'Next: check the sale' })).toBeVisible();
});

test('a lost answer: the sale is never sent again; Check finds it among the customer’s in-store orders', async ({ page }) => {
  const b = await mockBackend(page, { loseNextCreate: true });
  await signIn(page);
  await page.goto('/#/pharmacy/sale');
  const customer = page.getByRole('region', { name: 'Customer' });
  await customer.getByRole('button', { name: 'Search' }).click();
  await customer.getByRole('button', { name: 'Choose Ravi Kumar · 9876500001' }).click();
  await addMedicine(page, 'para', 'Paracetamol 500mg', '2');
  await page.getByRole('button', { name: 'Next: check the sale' }).click();
  await page.getByRole('button', { name: 'Create sale' }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed sale' });
  await expect(panel).toContainText('It may already be recorded, so it is not sent again.');
  await expect(panel.getByRole('button', { name: /Send/ })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(page.getByText('Sale PO-100 created.')).toBeVisible();
  expect(writes(b).filter((c) => c.path === '/pharmacy-orders')).toHaveLength(1);
  expect(b.calls.some((c) => c.path === `/pharmacy-orders?customerId=${KNOWN}&orderType=in_store&limit=20`)).toBe(true);
});
