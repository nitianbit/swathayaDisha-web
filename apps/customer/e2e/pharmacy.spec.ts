import { expect, test, type Page, type Route } from '@playwright/test';

/** Customer medicine ordering against a mocked backend modelling the cart, checkout, payment and D3 cancellations. */
const ME = 'c1'.repeat(12);
const S1 = '5a'.repeat(12);
const S2 = '5b'.repeat(12);
const MED_A = 'a1'.repeat(12);
const MED_B = 'b1'.repeat(12);
const MED_RX = 'e1'.repeat(12);

const MEDS: Record<string, { name: string; price: number; rx: boolean }> = {
  [MED_A]: { name: 'Paracetamol 500', price: 20, rx: false },
  [MED_B]: { name: 'Cetirizine 10', price: 35, rx: false },
  [MED_RX]: { name: 'Amoxicillin 500', price: 90, rx: true },
};

interface Backend {
  calls: { method: string; path: string; query: string; body: unknown }[];
  cart: { pharmacyId: string | null; items: { medicineId: string; quantity: number }[] };
  orders: Map<string, Record<string, unknown>>;
  records: Map<string, { orderId: string; rzp: string; captured: boolean }>;
  priceChangeOnce: boolean;
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
  const b: Backend = { calls: [], cart: { pharmacyId: null, items: [] }, orders: new Map(), records: new Map(), priceChangeOnce: false };
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
    ]);
    if (path === `/pharmacies/${S1}`) return json(route, 200, { success: true, data: { _id: S1, name: 'Asha Medicals', city: 'Pune', pickupAvailable: true, deliveryAvailable: true } });
    if (path === `/pharmacies/${S2}`) return json(route, 200, { success: true, data: { _id: S2, name: 'City Pharmacy', city: 'Pune', pickupAvailable: true } });
    if (path === '/pharmacy-inventory') {
      const store = url.searchParams.get('pharmacyId');
      const row = (id: string, medicineId: string, qty: number, price: number) =>
        ({ _id: id, pharmacyId: store, medicineId, availableQty: qty, retailPrice: price, medicine: { _id: medicineId, name: MEDS[medicineId]!.name, strength: '500 mg', dosageForm: 'Tablet' } });
      const rows = store === S1 ? [row('i1', MED_A, 5, 20), row('i2', MED_A, 3, 20), row('i3', MED_B, 4, 35), row('i4', MED_RX, 2, 90)] : [row('j1', MED_B, 9, 36)];
      const q = (url.searchParams.get('search') ?? '').toLowerCase();
      return page1(route, rows.filter((r) => !q || r.medicine.name.toLowerCase().includes(q)));
    }
    if (path === '/pharmacy-cart' && req.method() === 'GET') return json(route, 200, { success: true, data: cartView(b) });
    if (path === '/pharmacy-cart' && req.method() === 'DELETE') { b.cart = { pharmacyId: null, items: [] }; return json(route, 200, { success: true }); }
    if (path === '/pharmacy-cart/items' && req.method() === 'POST') {
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
    if (path === '/pharmacy-cart/checkout') {
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
      b.cart = { pharmacyId: null, items: [] };
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
  expect(checkout?.body).toEqual({ paymentMode: 'online_payment', deliveryMode: 'pickup' });
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
    paymentMode: 'cash_on_delivery', deliveryMode: 'delivery', deliveryAddress: '12 MG Road, Camp, Pune 411001' });
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
