import { expect, test, type Page, type Route } from '@playwright/test';

/** Customer medicine ordering against a mocked backend modelling the cart, checkout, payment and D3 cancellations. */
const ME = 'c1'.repeat(12);
const S1 = '5a'.repeat(12);
const S2 = '5b'.repeat(12);
const MED_A = 'a1'.repeat(12);
const MED_B = 'b1'.repeat(12);
const MED_RX = 'e1'.repeat(12);
const S3 = '5c'.repeat(12);
const S4 = '5d'.repeat(12);
const MED_LATE = 'f9'.repeat(12);
const MED_OFF = 'f8'.repeat(12);
const MED_FREE = 'f7'.repeat(12);
/** Fillers that push MED_LATE onto the second page of S2's stock. */
const FILLERS = Array.from({ length: 50 }, (_, i) => (0x10 + i).toString(16).padStart(2, '0').repeat(12));

const MEDS: Record<string, { name: string; price: number; rx: boolean }> = {
  [MED_A]: { name: 'Paracetamol 500', price: 20, rx: false },
  [MED_B]: { name: 'Cetirizine 10', price: 35, rx: false },
  [MED_RX]: { name: 'Amoxicillin 500', price: 90, rx: true },
  [MED_LATE]: { name: 'Zinc 50', price: 15, rx: false },
  [MED_OFF]: { name: 'Withdrawn Syrup', price: 40, rx: false },
  [MED_FREE]: { name: 'Free Sample', price: 0, rx: false },
  ...Object.fromEntries(FILLERS.map((id, i) => [id, { name: `Filler ${String(i).padStart(2, '0')}`, price: 10, rx: false }])),
};

interface Backend {
  calls: { method: string; path: string; query: string; body: unknown }[];
  cart: { pharmacyId: string | null; items: { medicineId: string; quantity: number }[] };
  orders: Map<string, Record<string, unknown>>;
  records: Map<string, { orderId: string; rzp: string; captured: boolean }>;
  priceChangeOnce: boolean;
  /** Milliseconds to hold the store details / the next cart change (to model a slow network). */
  slowStore: number;
  slowCart: number;
  /** Stock page requests that fail (500), counted. */
  failStockPage: number;
  stockPageCalls: Record<number, number>;
  /** Orders by checkout request key (P8). */
  byKey: Map<string, string>;
  /** The next checkout is recorded but its answer is lost (connection drops). */
  dropNextCheckoutAnswer: boolean;
  /** Pay-again answers 503 (an earlier attempt cannot be checked). */
  retryUnknown: boolean;
  /** Hold the next checkout's answer this long (its order is recorded at once, or refused if abandoned meanwhile). */
  slowNextCheckout: number;
  abandoned: Set<string>;
}

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

function cartView(b: Backend) {
  const items = b.cart.items.map((i) => {
    const m = MEDS[i.medicineId]!;
    return { medicineId: i.medicineId, medicineName: m.name, quantity: i.quantity, unitPrice: m.price, lineTotal: m.price * i.quantity, prescriptionRequired: m.rx };
  });
  return { pharmacyId: b.cart.pharmacyId, pharmacyName: b.cart.pharmacyId === S1 ? 'Asha Medicals' : b.cart.pharmacyId ? 'City Pharmacy' : null,
    items, subtotal: items.reduce((s, i) => s + i.lineTotal, 0), requiresPrescription: items.some((i) => i.prescriptionRequired) };
}

async function mockBackend(page: Page): Promise<Backend> {
  const b: Backend = { calls: [], cart: { pharmacyId: null, items: [] }, orders: new Map(), records: new Map(), priceChangeOnce: false, slowStore: 0, slowCart: 0, failStockPage: 0, stockPageCalls: {}, byKey: new Map(), dropNextCheckoutAnswer: false, retryUnknown: false, slowNextCheckout: 0, abandoned: new Set() };
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const page1 = (route: Route, items: unknown[]) => json(route, 200, { success: true, data: items, pagination: { page: 1, limit: 20, total: items.length, totalPages: 1 } });
  let n = 0;
  await page.route('https://checkout.razorpay.com/v1/checkout.js', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE_CHECKOUT }));
  await page.route('**/__fake_gateway/**', (route) => {
    const o = new URL(route.request().url()).searchParams.get('order');
    for (const r of b.records.values()) if (r.rzp === o) r.captured = true;
    return route.fulfill({ status: 200, body: 'ok' });
  });
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1', '');
    const body = ['POST', 'PUT'].includes(req.method()) ? req.postDataJSON() : null;
    b.calls.push({ method: req.method(), path, query: url.search, body });
    if (path === '/auth/user/send') return json(route, 200, { success: true });
    if (path === '/auth/user/verify') return json(route, 200, { success: true, data: { token: 't', expiresIn: 900, user: {} } });
    if (path === '/auth/session/refresh') return json(route, 401, { error: 401, code: 'SESSION_ENDED', message: 'Please sign in again' });
    if (path === '/auth/profile') return json(route, 200, { success: true, data: { user: { _id: ME, name: 'Asha Rao', phone: '9876543210', email: 'a@x.in', gender: 'Female', dateOfBirth: '19900101' }, userRole: 'user' } });
    if (path === `/wallet/user/${ME}`) return json(route, 200, { success: true, data: { _id: 'w', userId: ME, balance: 0, isActive: true } });
    if (path === '/pharmacies') return page1(route, [
      { _id: S1, name: 'Asha Medicals', address: 'MG Road', city: 'Pune', pincode: '411001', pickupAvailable: true, deliveryAvailable: true },
      { _id: S2, name: 'City Pharmacy', city: 'Pune', pickupAvailable: true },
      { _id: S3, name: 'Door Meds', city: 'Pune', pickupAvailable: false, deliveryAvailable: true },
      { _id: S4, name: 'Sold Out First', city: 'Pune', pickupAvailable: true },
    ]);
    if (path === `/pharmacies/${S4}`) return json(route, 200, { success: true, data: { _id: S4, name: 'Sold Out First', city: 'Pune', pickupAvailable: true } });
    if (path === `/pharmacies/${S3}`) {
      if (b.slowStore) await new Promise((r) => setTimeout(r, b.slowStore));
      return json(route, 200, { success: true, data: { _id: S3, name: 'Door Meds', city: 'Pune', pickupAvailable: false, deliveryAvailable: true } });
    }
    if (path === `/pharmacies/${S1}`) return json(route, 200, { success: true, data: { _id: S1, name: 'Asha Medicals', city: 'Pune', pickupAvailable: true, deliveryAvailable: true } });
    if (path === `/pharmacies/${S2}`) return json(route, 200, { success: true, data: { _id: S2, name: 'City Pharmacy', city: 'Pune', pickupAvailable: true } });
    if (path === '/pharmacy-inventory') {
      const store = url.searchParams.get('pharmacyId');
      const row = (id: string, medicineId: string, qty: number, price: number) =>
        ({ _id: id, pharmacyId: store, medicineId, availableQty: qty, retailPrice: price, medicine: { _id: medicineId, name: MEDS[medicineId]!.name, strength: '500 mg', dosageForm: 'Tablet' } });
      const rows = store === S1 ? [row('i1', MED_A, 5, 20), row('i2', MED_A, 3, 20), row('i3', MED_B, 4, 35), row('i4', MED_RX, 2, 90),
        { ...row('i5', MED_OFF, 6, 40), isActive: false }, row('i6', MED_FREE, 6, 0)]
        : store === S3 ? [row('k1', MED_A, 9, 20)]
        : store === S4 ? [...FILLERS.map((id, i) => row(`z${i}`, id, 0, 10)), row('z50', MED_LATE, 4, 15)]
        : [row('j1', MED_B, 9, 36), ...FILLERS.map((id, i) => row(`f${i}`, id, 5, 10)), row('j2', MED_LATE, 4, 15)];
      const q = (url.searchParams.get('search') ?? '').toLowerCase();
      const all = rows.filter((r) => !q || r.medicine.name.toLowerCase().includes(q));
      const pg = Number(url.searchParams.get('page') ?? '1'); const limit = Number(url.searchParams.get('limit') ?? '50');
      b.stockPageCalls[pg] = (b.stockPageCalls[pg] ?? 0) + 1;
      if (pg === b.failStockPage) return json(route, 500, { error: 500, message: 'Stock could not be read' });
      return json(route, 200, { success: true, data: all.slice((pg - 1) * limit, pg * limit),
        pagination: { page: pg, limit, total: all.length, totalPages: Math.max(1, Math.ceil(all.length / limit)) } });
    }
    if (path === '/request-keys/abandon') {
      const { key } = body as { key: string };
      if (b.byKey.has(key)) return json(route, 200, { success: true, data: { state: 'used', record: { _id: b.byKey.get(key) } } });
      b.abandoned.add(key);
      return json(route, 200, { success: true, data: { state: 'abandoned' } });
    }
    if (path === '/pharmacy-cart' && req.method() === 'GET') return json(route, 200, { success: true, data: cartView(b) });
    if (path === '/pharmacy-cart' && req.method() === 'DELETE') { b.cart = { pharmacyId: null, items: [] }; return json(route, 200, { success: true }); }
    if (path === '/pharmacy-cart/items' && req.method() === 'POST') {
      if (b.slowCart) { const wait = b.slowCart; b.slowCart = 0; await new Promise((r) => setTimeout(r, wait)); }
      const { pharmacyId, medicineId, quantity } = body as { pharmacyId: string; medicineId: string; quantity: number };
      if (b.cart.pharmacyId && b.cart.pharmacyId !== pharmacyId && b.cart.items.length) {
        return json(route, 409, { error: 409, code: 'CART_PHARMACY_MISMATCH', message: 'Your cart has items from another pharmacy' });
      }
      b.cart.pharmacyId = pharmacyId;
      const it = b.cart.items.find((i) => i.medicineId === medicineId);
      if (it) it.quantity += quantity; else b.cart.items.push({ medicineId, quantity });
      b.cart.items = b.cart.items.filter((i) => i.quantity > 0);
      return json(route, 200, { success: true, data: cartView(b) });
    }
    const rm = /^\/pharmacy-cart\/items\/(\w+)$/.exec(path);
    if (rm && req.method() === 'DELETE') {
      b.cart.items = b.cart.items.filter((i) => i.medicineId !== rm[1]);
      return json(route, 200, { success: true, data: cartView(b) });
    }
    const paymentOf = (o: Record<string, unknown>) => {
      const rec = [...b.records.entries()].find(([, r]) => r.orderId === o._id);
      return rec ? { paymentTransactionId: rec[0], razorpayOrderId: rec[1].rzp, razorpayKeyId: 'rzp_test', amount: o.grandTotal, currency: 'INR' } : undefined;
    };
    if (path === '/pharmacy-cart/checkout') {
      const key = (body as { requestKey?: string }).requestKey;
      if (b.slowNextCheckout) {
        const wait = b.slowNextCheckout; b.slowNextCheckout = 0;
        await new Promise((r) => setTimeout(r, wait));
        if (key && b.abandoned.has(key)) return json(route, 409, { error: 409, code: 'REQUEST_ABANDONED', message: 'This request was cancelled before it was recorded; make a new one' });
      }
      if (key && b.byKey.has(key)) {
        const o = b.orders.get(b.byKey.get(key)!)!;
        const unpaid = o.status === 'placed' && o.paymentStatus === 'pending' && o.paymentMode === 'online_payment';
        return json(route, 201, { success: true, data: { order: o, paymentRequired: unpaid, ...(unpaid ? { payment: paymentOf(o) } : {}), replayed: true } });
      }
      if (b.priceChangeOnce) {
        b.priceChangeOnce = false; MEDS[MED_A]!.price = 22;
        return json(route, 409, { error: 409, code: 'CART_PRICE_CHANGED', message: 'Prices changed' });
      }
      const c = body as { paymentMode: string; deliveryMode: string; deliveryAddress?: string };
      const view = cartView(b);
      n += 1;
      const id = String(n).padStart(24, '7');
      const online = c.paymentMode === 'online_payment';
      const record = String(n).padStart(24, '9');
      const order = { _id: id, orderNumber: `PH-${n}`, pharmacyId: b.cart.pharmacyId, orderType: 'online', status: 'placed',
        items: view.items.map((i) => ({ medicineId: i.medicineId, medicineName: i.medicineName, orderedQty: i.quantity, lineTotal: i.lineTotal })),
        grandTotal: view.subtotal, paymentMode: c.paymentMode, paymentStatus: 'pending', deliveryMode: c.deliveryMode, deliveryAddress: c.deliveryAddress,
        createdAt: new Date().toISOString(), ...(online ? { paymentTransactionId: record } : {}) };
      b.orders.set(id, order);
      if (key) b.byKey.set(key, id);
      b.cart = { pharmacyId: null, items: [] };
      if (b.dropNextCheckoutAnswer) { b.dropNextCheckoutAnswer = false; if (online) b.records.set(record, { orderId: id, rzp: `order_rzp_${n}`, captured: false }); return route.abort('connectionreset'); }
      if (!online) return json(route, 201, { success: true, data: { order, paymentRequired: false } });
      b.records.set(record, { orderId: id, rzp: `order_rzp_${n}`, captured: false });
      return json(route, 201, { success: true, data: { order, paymentRequired: true,
        payment: { paymentTransactionId: record, razorpayOrderId: `order_rzp_${n}`, razorpayKeyId: 'rzp_test', amount: view.subtotal, currency: 'INR' } } });
    }
    if (path === '/payments/verify' || path === '/payments/reconcile') {
      const r = b.records.get((body as { paymentTransactionId: string }).paymentTransactionId);
      if (!r) return json(route, 404, { error: 404, message: 'Payment not found' });
      if (r.captured) { const o = b.orders.get(r.orderId)!; o.paymentStatus = 'paid'; }
      if (path === '/payments/verify') return json(route, 200, { success: true, data: { context: 'pharmacy_order', paymentRecord: { status: r.captured ? 'paid' : 'pending' } } });
      return json(route, 200, { success: true, data: { state: r.captured ? 'paid' : 'unpaid' } });
    }
    if (path === '/pharmacy-orders' && req.method() === 'GET') return page1(route, [...b.orders.values()].reverse());
    const om = /^\/pharmacy-orders\/(\w+)(\/.*)?$/.exec(path);
    if (om) {
      const o = b.orders.get(om[1]!);
      if (!o) return json(route, 404, { error: 404, message: 'Order not found' });
      if (!om[2] && req.method() === 'GET') return json(route, 200, { success: true, data: o });
      if (om[2] === '/retry-payment') {
        if (b.retryUnknown) return json(route, 503, { error: 503, code: 'PAYMENT_STATE_UNKNOWN', message: 'We could not check your earlier payment just now. Please try again in a few minutes.' });
        for (const r of b.records.values()) if (r.orderId === o._id && r.captured) o.paymentStatus = 'paid';
        if (o.paymentStatus === 'paid') return json(route, 200, { success: true, data: { order: o, paymentRequired: false } });
        if (o.status !== 'placed') return json(route, 409, { error: 409, code: 'ORDER_NOT_PAYABLE', message: 'This order can no longer be paid' });
        return json(route, 200, { success: true, data: { order: o, paymentRequired: true, payment: paymentOf(o) } });
      }
      if (om[2] === '/cancel-request') {
        const paid = o.paymentStatus === 'paid';
        Object.assign(o, paid
          ? { status: 'pending_cancel', cancelRequest: { requestId: 'r'.repeat(24), state: 'pending', fromStatus: o.status, paymentStatusAtRequest: 'paid', requestedByType: 'user', requestedAt: new Date().toISOString() } }
          : { status: 'cancelled' });
        return json(route, 200, { success: true, data: o });
      }
      if (om[2] === '/prescription-refund/to-source') {
        o.prescriptionRefund = { ...(o.prescriptionRefund as object), status: 'source_processing' };
        return json(route, 202, { success: true, data: { orderId: o._id, prescriptionRefund: o.prescriptionRefund } });
      }
    }
    return json(route, 404, { error: 404, message: 'Not found' });
  });
  return b;
}

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Mobile number').fill('9876543210');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: /^Hello/ })).toBeVisible();
}

async function fillCart(page: Page) {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Medicines', exact: true }).click();
  await page.getByRole('link', { name: /Asha Medicals/ }).click();
  await page.getByRole('button', { name: 'Add Paracetamol 500 to cart' }).click();
  await page.getByRole('button', { name: 'One more Paracetamol 500' }).click();
  await expect(page.getByRole('group', { name: 'Paracetamol 500 quantity' })).toContainText('2');
  await page.getByRole('link', { name: /View cart/ }).click();
}

test.beforeEach(() => { MEDS[MED_A]!.price = 20; });

test('browse a pharmacy, build a cart and pay online; the order is confirmed as paid', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await fillCart(page);
  await expect(page.getByText('Paracetamol 500')).toBeVisible();
  await expect(page.getByText('Total ₹40')).toBeVisible();
  await page.getByRole('button', { name: /Place order and pay/ }).click();
  await expect(page.getByText('Payment received. The pharmacy will prepare your order.')).toBeVisible();
  const checkout = b.calls.find((c) => c.path === '/pharmacy-cart/checkout');
  expect(checkout?.body).toEqual({ paymentMode: 'online_payment', deliveryMode: 'pickup', requestKey: expect.stringMatching(/^[A-Za-z0-9]{32}$/) });
  await page.getByRole('link', { name: 'My medicine orders' }).click();
  await expect(page.getByRole('link', { name: /Order PH-1/ })).toBeVisible();
  // The order list is scoped by the server: the app never names a customer.
  for (const c of b.calls.filter((x) => x.path === '/pharmacy-orders')) expect(c.query).not.toMatch(/userId|customerId/);
});

test('the shelf shows one line per medicine; a second pharmacy asks before replacing the cart', async ({ page }) => {
  await mockBackend(page);
  await signIn(page);
  await page.getByRole('link', { name: 'Order medicines' }).click();
  await page.getByRole('link', { name: /Asha Medicals/ }).click();
  await expect(page.getByRole('button', { name: 'Add Paracetamol 500 to cart' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Add Paracetamol 500 to cart' }).click();
  await page.getByRole('link', { name: 'Pharmacies' }).click();
  await page.getByRole('link', { name: /City Pharmacy/ }).click();
  await page.getByRole('button', { name: 'Add Cetirizine 10 to cart' }).click();
  await expect(page.getByText('Your cart has medicines from Asha Medicals.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Empty the cart and add this' }).click();
  await expect(page.getByRole('group', { name: 'Cetirizine 10 quantity' })).toContainText('1');
});

test('a medicine that needs a prescription blocks checkout with an explanation', async ({ page }) => {
  await mockBackend(page);
  await signIn(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Medicines', exact: true }).click();
  await page.getByRole('link', { name: /Asha Medicals/ }).click();
  await page.getByRole('button', { name: 'Add Amoxicillin 500 to cart' }).click();
  await page.getByRole('link', { name: /View cart/ }).click();
  await expect(page.getByText('Amoxicillin 500 needs a prescription.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: /Place order/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'One less Amoxicillin 500' }).click();
  await expect(page.getByText('Your cart is empty')).toBeVisible();
});

test('a changed price stops the order: the new total is shown and nothing is placed', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await fillCart(page);
  b.priceChangeOnce = true;
  await page.getByRole('button', { name: /Place order and pay/ }).click();
  await expect(page.getByText('Some prices changed', { exact: false })).toBeVisible();
  await expect(page.getByText('Total ₹44')).toBeVisible();
  expect(b.orders.size).toBe(0);
});

test('closing the payment page leaves the order unpaid with a deadline; paying from the order works', async ({ page }) => {
  await mockBackend(page);
  await signIn(page);
  await page.evaluate(() => { (window as unknown as { __rz: string }).__rz = 'close'; });
  await fillCart(page);
  await page.getByRole('button', { name: /Place order and pay/ }).click();
  await expect(page.getByText('This order is not paid yet. Pay by', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pay ₹40' })).toBeEnabled();
  await page.evaluate(() => { (window as unknown as { __rz: string }).__rz = 'pay'; });
  await page.getByRole('button', { name: 'Pay ₹40' }).click();
  await expect(page.getByText('Payment received.', { exact: false })).toBeVisible();
});

test('delivery with cash on delivery; an unpaid order is cancelled at once', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await fillCart(page);
  await page.getByLabel('Deliver to me').check();
  await page.getByLabel('Cash on delivery').check();
  await page.getByRole('button', { name: /Place order ·/ }).click();
  await expect(page.getByText('Enter the full delivery address.')).toBeVisible();
  await page.getByLabel('Delivery address').fill('12 MG Road, Camp, Pune 411001');
  await page.getByRole('button', { name: /Place order ·/ }).click();
  await expect(page.getByRole('heading', { name: 'Order PH-1' })).toBeVisible();
  expect(b.calls.find((c) => c.path === '/pharmacy-cart/checkout')?.body).toEqual({
    paymentMode: 'cash_on_delivery', deliveryMode: 'delivery', deliveryAddress: '12 MG Road, Camp, Pune 411001', requestKey: expect.any(String) });
  await expect(page.getByRole('heading', { name: 'Payment' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel this order' }).click();
  await expect(page.getByText('The order is cancelled now.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Yes, cancel it' }).click();
  await expect(page.getByText('Cancelled', { exact: true })).toBeVisible();
});

test('a paid order waits for the pharmacy to confirm cancelling; a wallet refund can be moved to the card', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await fillCart(page);
  await page.getByRole('button', { name: /Place order and pay/ }).click();
  await expect(page.getByText('Payment received.', { exact: false })).toBeVisible();
  await page.reload();
  await signIn(page);
  await page.goto('/#/pharmacy/orders');
  await page.getByRole('link', { name: /Order PH-1/ }).click();
  await page.getByRole('button', { name: 'Cancel this order' }).click();
  await expect(page.getByText('the pharmacy or Jansetu confirms the cancellation first', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Yes, ask to cancel' }).click();
  await expect(page.getByText('You asked to cancel this order', { exact: false })).toBeVisible();
  // The pharmacy approves: cancelled and refunded to the wallet.
  const o = [...b.orders.values()][0]!;
  Object.assign(o, { status: 'cancelled', cancelRequest: { ...(o.cancelRequest as object), state: 'approved' },
    prescriptionRefund: { cause: 'order_cancelled', status: 'wallet_credited', walletAmount: 40, gatewayAmountPaise: 4000 } });
  await page.reload();
  await signIn(page);
  await page.goto(`/#/pharmacy/orders/${String(o._id)}`);
  await expect(page.getByText('₹40.00: Refunded to your Jansetu wallet.')).toBeVisible();
  await page.getByRole('button', { name: 'Send it to my card/UPI instead' }).click();
  await page.getByRole('button', { name: 'Yes, send it to my card/UPI' }).click();
  await expect(page.getByText('on its way to your card/UPI', { exact: false })).toBeVisible();
});

test('a delivery-only pharmacy: nothing is offered until its options are known, then only delivery', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Medicines', exact: true }).click();
  await page.getByRole('link', { name: /Door Meds/ }).click();
  await page.getByRole('button', { name: 'Add Paracetamol 500 to cart' }).click();
  b.slowStore = 1500;
  await page.reload();
  await signIn(page);
  await page.goto('/#/pharmacy/cart');
  await expect(page.getByText('Loading the pharmacy…')).toBeVisible();
  await expect(page.getByRole('button', { name: /Place order/ })).toHaveCount(0);
  await expect(page.getByLabel('Deliver to me')).toBeChecked();
  await expect(page.getByLabel('Collect at the pharmacy')).toHaveCount(0);
  await page.getByLabel('Cash on delivery').check();
  await page.getByLabel('Delivery address').fill('5 Lane, Kothrud, Pune 411038');
  await page.getByRole('button', { name: /Place order ·/ }).click();
  await expect(page.getByRole('heading', { name: /Order PH-/ })).toBeVisible();
  expect(b.calls.find((c) => c.path === '/pharmacy-cart/checkout')?.body).toMatchObject({ deliveryMode: 'delivery', paymentMode: 'cash_on_delivery' });
});

test('one cart change at a time: while one is on its way the others wait, and taking one off never removes all', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Medicines', exact: true }).click();
  await page.getByRole('link', { name: /Asha Medicals/ }).click();
  await page.getByRole('button', { name: 'Add Paracetamol 500 to cart' }).click();
  await expect(page.getByRole('group', { name: 'Paracetamol 500 quantity' })).toContainText('1');
  b.slowCart = 1500;
  await page.getByRole('button', { name: 'One more Paracetamol 500' }).click();
  await expect(page.getByRole('button', { name: 'One less Paracetamol 500' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Add Cetirizine 10 to cart' })).toBeDisabled();
  await expect(page.getByRole('group', { name: 'Paracetamol 500 quantity' })).toContainText('2');
  await page.getByRole('button', { name: 'One less Paracetamol 500' }).click();
  await expect(page.getByRole('group', { name: 'Paracetamol 500 quantity' })).toContainText('1');
  expect(b.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  expect(b.calls.filter((c) => c.path === '/pharmacy-cart/items').map((c) => (c.body as { quantity: number }).quantity)).toEqual([1, 1, -1]);
});

test('every page of a pharmacy\'s stock can be reached; inactive or unpriced stock cannot be added', async ({ page }) => {
  await mockBackend(page);
  await signIn(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Medicines', exact: true }).click();
  await page.getByRole('link', { name: /City Pharmacy/ }).click();
  await expect(page.getByRole('button', { name: 'Add Filler 00 to cart' })).toBeVisible();
  await expect(page.getByText('Zinc 50')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show more medicines' }).click();
  await expect(page.getByRole('button', { name: 'Add Zinc 50 to cart' })).toBeEnabled();
  await page.getByRole('link', { name: 'Pharmacies' }).click();
  await page.getByRole('link', { name: /Asha Medicals/ }).click();
  await expect(page.getByText('Withdrawn Syrup')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add Free Sample to cart' })).toBeDisabled();
});

test('checking the payment re-reads the order: a closed order no longer offers payment', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await page.evaluate(() => { (window as unknown as { __rz: string }).__rz = 'close'; });
  await fillCart(page);
  await page.getByRole('button', { name: /Place order and pay/ }).click();
  await expect(page.getByRole('button', { name: 'Pay ₹40' })).toBeEnabled();
  const o = [...b.orders.values()][0]!;
  o.status = 'abandoned'; // not paid in time: the server closed it
  await page.getByRole('button', { name: 'I have paid, check again' }).click();
  await expect(page.getByText('This order was cancelled because it was not paid', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pay ₹40' })).toHaveCount(0);
});

test('paying re-reads the order first: an order closed meanwhile does not open the payment page', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await page.evaluate(() => { (window as unknown as { __rz: string }).__rz = 'close'; });
  await fillCart(page);
  await page.getByRole('button', { name: /Place order and pay/ }).click();
  await expect(page.getByRole('button', { name: 'Pay ₹40' })).toBeEnabled();
  [...b.orders.values()][0]!.status = 'rejected';
  const opened = b.calls.length;
  await page.evaluate(() => { (window as unknown as { __rz: string }).__rz = 'pay'; });
  await page.getByRole('button', { name: 'Pay ₹40' }).click();
  await expect(page.getByText('Not accepted', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pay ₹40' })).toHaveCount(0);
  expect(b.calls.slice(opened).some((c) => c.path === '/payments/verify')).toBe(false);
  expect([...b.records.values()].every((r) => !r.captured)).toBe(true);
});

test('a first page with nothing orderable does not hide the medicines on the next page', async ({ page }) => {
  await mockBackend(page);
  await signIn(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Medicines', exact: true }).click();
  await page.getByRole('link', { name: /Sold Out First/ }).click();
  await expect(page.getByRole('button', { name: 'Add Zinc 50 to cart' })).toBeEnabled();
  await expect(page.getByText('No medicines in stock right now')).toHaveCount(0);
});

test('a next page that fails stops the reading with Retry; it is not requested again on its own', async ({ page }) => {
  const b = await mockBackend(page);
  b.failStockPage = 2;
  await signIn(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Medicines', exact: true }).click();
  await page.getByRole('link', { name: /Sold Out First/ }).click();
  await expect(page.getByText('Stock could not be read')).toBeVisible({ timeout: 15_000 });
  const calls = b.stockPageCalls[2] ?? 0;
  await page.waitForTimeout(3000);
  expect(b.stockPageCalls[2]).toBe(calls);
  b.failStockPage = 0;
  await page.getByRole('button', { name: /Try again|Retry/ }).click();
  await expect(page.getByRole('button', { name: 'Add Zinc 50 to cart' })).toBeEnabled();
});

test('a checkout whose answer was lost: "Check my last order" finds the one order (never two)', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await page.evaluate(() => { (window as unknown as { __rz: string }).__rz = 'close'; });
  await fillCart(page);
  b.dropNextCheckoutAnswer = true;
  await page.getByRole('button', { name: /Place order and pay/ }).click();
  await expect(page.getByText('Your last attempt to place an order may have gone through.')).toBeVisible();
  await page.getByRole('button', { name: 'Check my last order' }).click();
  await expect(page.getByText('already been placed by your earlier attempt', { exact: false })).toBeVisible();
  expect(b.orders.size).toBe(1);
  const key = (b.calls.find((c) => c.path === '/pharmacy-cart/checkout')!.body as { requestKey: string }).requestKey;
  expect((b.calls.find((c) => c.path === '/request-keys/abandon')!.body)).toEqual({ kind: 'pharmacy_checkout', key });
});

test('an attempt that never reached the server: "Check my last order" cancels it and the order can be placed', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await fillCart(page);
  await page.route('**/api/v1/pharmacy-cart/checkout', (route) => route.abort('connectionreset'));
  await page.getByRole('button', { name: /Place order and pay/ }).click();
  await page.unroute('**/api/v1/pharmacy-cart/checkout');
  await page.reload(); // the app is reopened before the answer is known
  await signIn(page);
  await page.goto('/#/pharmacy/cart');
  await page.getByRole('button', { name: 'Check my last order' }).click();
  await expect(page.getByText('Your earlier attempt did not place an order.', { exact: false })).toBeVisible();
  expect(b.orders.size).toBe(0);
  await page.getByRole('button', { name: /Place order and pay/ }).click();
  await expect(page.getByText('Payment received.', { exact: false })).toBeVisible();
  const keys = b.calls.filter((c) => c.path === '/pharmacy-cart/checkout').map((c) => (c.body as { requestKey: string }).requestKey);
  const abandoned = (b.calls.find((c) => c.path === '/request-keys/abandon')!.body as { key: string }).key;
  expect(keys.at(-1)).not.toBe(abandoned); // a fresh key after the old one was cancelled
});

test('after leaving the app an unpaid order can still be paid: the server hands back its payment', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await page.evaluate(() => { (window as unknown as { __rz: string }).__rz = 'close'; });
  await fillCart(page);
  await page.getByRole('button', { name: /Place order and pay/ }).click();
  await expect(page.getByRole('button', { name: 'Pay ₹40' })).toBeEnabled();
  const id = String([...b.orders.values()][0]!._id);
  await page.reload();
  await signIn(page);
  await page.goto(`/#/pharmacy/orders/${id}`);
  await page.evaluate(() => { (window as unknown as { __rz: string }).__rz = 'pay'; });
  await page.getByRole('button', { name: /Pay ₹40/ }).click();
  await expect(page.getByText('Payment received.', { exact: false })).toBeVisible();
  expect(b.calls.some((c) => c.path === `/pharmacy-orders/${id}/retry-payment`)).toBe(true);
});

test('pay again while an earlier payment cannot be checked: the app says so and offers no payment page', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await page.evaluate(() => { (window as unknown as { __rz: string }).__rz = 'close'; });
  await fillCart(page);
  await page.getByRole('button', { name: /Place order and pay/ }).click();
  await expect(page.getByRole('button', { name: 'Pay ₹40' })).toBeEnabled();
  b.retryUnknown = true;
  const verifies = b.calls.filter((c) => c.path === '/payments/verify').length;
  await page.getByRole('button', { name: 'Pay ₹40' }).click();
  await expect(page.getByText('We could not check your earlier payment just now', { exact: false }).first()).toBeVisible();
  expect(b.calls.filter((c) => c.path === '/payments/verify').length).toBe(verifies);
});

test('a late refusal of an old attempt does not end the newer attempt\'s protection', async ({ page }) => {
  test.setTimeout(60_000);
  const b = await mockBackend(page);
  await signIn(page);
  await fillCart(page);
  b.slowNextCheckout = 5000; // K1's answer is slow
  await page.getByRole('button', { name: /Place order and pay/ }).click();
  // The customer leaves and comes back while K1 is still on its way; K1 is checked: never recorded, so cancelled.
  await page.getByRole('link', { name: 'Continue shopping' }).click();
  await page.getByRole('link', { name: /View cart/ }).click();
  await page.getByRole('button', { name: 'Check my last order' }).click();
  await expect(page.getByText('Your earlier attempt did not place an order.', { exact: false })).toBeVisible();
  // K2 is placed; its answer is lost.
  b.dropNextCheckoutAnswer = true;
  await page.getByRole('button', { name: /Place order and pay/ }).click();
  await expect(page.getByRole('button', { name: 'Check my last order' })).toBeVisible();
  // K1's late refusal arrives now (the first view is still waiting for it): K2's protection must survive it.
  await page.waitForTimeout(5500);
  await page.reload();
  await signIn(page);
  await page.goto('/#/pharmacy/cart');
  await page.getByRole('button', { name: 'Check my last order' }).click();
  await expect(page.getByText('already been placed by your earlier attempt', { exact: false })).toBeVisible();
  expect(b.orders.size).toBe(1);
});

test('after one attempt was cancelled, a newer uncertain attempt shows its own "Check my last order"', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await fillCart(page);
  await page.route('**/api/v1/pharmacy-cart/checkout', (route) => route.abort('connectionreset'), { times: 1 });
  await page.getByRole('button', { name: /Place order and pay/ }).click();
  await page.getByRole('button', { name: 'Check my last order' }).click();
  await expect(page.getByText('Your earlier attempt did not place an order.', { exact: false })).toBeVisible();
  b.dropNextCheckoutAnswer = true;
  await page.getByRole('button', { name: /Place order and pay/ }).click();
  await expect(page.getByRole('button', { name: 'Check my last order' })).toBeVisible();
  await expect(page.getByText('Your earlier attempt did not place an order.', { exact: false })).toHaveCount(0);
  await page.getByRole('button', { name: 'Check my last order' }).click();
  await expect(page.getByText('already been placed by your earlier attempt', { exact: false })).toBeVisible();
});
