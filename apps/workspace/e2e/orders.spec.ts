import { expect, test, type Page, type Route } from '@playwright/test';

const ME = 'b'.repeat(24);
const OTHER = 'c'.repeat(24);
const ID = 'e'.repeat(24);
const MED = 'f'.repeat(24);
const BATCH = '1'.repeat(24);

type Order = Record<string, unknown> & { status: string; paymentStatus: string };

function order(over: Partial<Order> = {}): Order {
  return {
    _id: ID, orderNumber: 'PO-2001', pharmacyId: ME, orderType: 'online', status: 'placed',
    paymentMode: 'online_payment', paymentStatus: 'paid', prescriptionStatus: 'not_required', deliveryMode: 'delivery',
    deliveryAddress: '12 MG Road', grandTotal: 240, createdAt: '2026-11-14T05:30:00.000Z',
    items: [{
      medicineId: MED, medicineName: 'Paracetamol 650mg', orderedQty: 4, unitPrice: 60, lineTotal: 240, itemStatus: 'active',
      batchAllocations: [{ batchId: BATCH, batchNumber: 'PCM-24A', expiryDate: '2027-06-30', quantity: 4 }],
    }],
    customerId: { _id: 'd'.repeat(24), name: 'Meera Rao' },
    ...over,
  };
}

// The backend's rules (pharmacyOrders services), enough to drive the page like the real server would.
const TRANSITIONS: Record<string, string[]> = {
  placed: ['accepted', 'rejected', 'cancelled', 'abandoned'], accepted: ['packed', 'cancelled'],
  packed: ['ready_for_pickup', 'out_for_delivery', 'cancelled'], ready_for_pickup: ['completed'], out_for_delivery: ['completed'],
};
const EXCEPTIONS: Record<string, [string[], string]> = {
  delivery_failed: [['out_for_delivery'], 'delivery_failed'], retry_delivery: [['delivery_failed'], 'out_for_delivery'],
  switch_to_pickup: [['out_for_delivery', 'delivery_failed'], 'ready_for_pickup'], not_collected: [['ready_for_pickup'], 'cancelled'],
  refused_at_door: [['out_for_delivery', 'delivery_failed'], 'cancelled'],
};

interface Backend {
  order: Order; calls: { path: string; body: unknown }[]; returns: Map<string, Record<string, unknown>>;
  /** Record the next return, then drop the answer (committed, response lost). */ loseNextAnswer: boolean;
  refuseNextReturn: boolean;
  /** Drop the next return before recording it (nothing recorded, answer lost). */ dropNextRequest: boolean;
  /** D4: keys abandoned through POST /request-keys/abandon (never recorded afterwards). */ abandoned: Set<string>;
  /** Refuse returns at the access check, before the key is looked up (pharmacy temporarily not operational). */ notOperational: boolean;
  delayMs: number;
}

async function mockBackend(page: Page, initial: Order): Promise<Backend> {
  const state: Backend = { order: initial, calls: [], returns: new Map(), loseNextAnswer: false, refuseNextReturn: false, dropNextRequest: false, abandoned: new Set(), notOperational: false, delayMs: 0 };
  const json = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const refuse = (route: Route, status: number, code: string, message: string) => json(route, status, { error: status, code, message });

  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1', '');
    const body = req.method() === 'POST' ? (req.postDataJSON() as Record<string, unknown> | null) : null;
    if (path === '/auth/pharmacy/send') return json(route, 200, { success: true });
    if (path === '/auth/pharmacy/verify') return json(route, 200, { success: true, data: { token: 't1', user: {} } });
    if (req.headers().authorization !== 'Bearer t1') return refuse(route, 401, 'UNAUTHORIZED', 'Authentication is required');
    if (path === '/auth/profile') return json(route, 200, { success: true, data: { user: { _id: ME, name: 'Asha Medicals' }, userRole: 'pharmacy' } });
    if (path === '/pharmacy-orders' && req.method() === 'GET') {
      return json(route, 200, { success: true, data: [state.order], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } });
    }
    if (path === `/pharmacy-orders/${ID}` && req.method() === 'GET') return json(route, 200, { success: true, data: state.order });
    const o = state.order;
    if (path.startsWith(`/pharmacy-orders/${ID}/`)) state.calls.push({ path: path.slice(`/pharmacy-orders/${ID}`.length), body });

    if (path === `/pharmacy-orders/${ID}/status`) {
      const to = String(body?.status);
      if (!(TRANSITIONS[o.status] ?? []).includes(to)) return refuse(route, 409, 'INVALID_ORDER_STATUS_TRANSITION', 'Not allowed');
      if (['packed', 'ready_for_pickup', 'out_for_delivery'].includes(to) && o.paymentMode !== 'cash_on_delivery' && o.paymentStatus !== 'paid') {
        return refuse(route, 409, 'ORDER_PAYMENT_REQUIRED', 'Payment must be completed before this order can progress');
      }
      if (to === 'completed' && o.paymentStatus !== 'paid') return refuse(route, 409, 'ORDER_PAYMENT_REQUIRED', 'Payment required');
      state.order = { ...o, status: to };
      return json(route, 200, { success: true, data: state.order });
    }
    if (path === `/pharmacy-orders/${ID}/delivery-exception`) {
      const [from, to] = EXCEPTIONS[String(body?.type)] ?? [[], ''];
      if (!from.includes(o.status)) return refuse(route, 409, 'INVALID_ORDER_STATUS_TRANSITION', 'Not allowed');
      if (body?.type !== 'retry_delivery' && !body?.reason) return refuse(route, 400, 'VALIDATION_ERROR', 'reason is required');
      const ex = { type: body?.type, reason: body?.reason, at: '2026-11-14T07:00:00.000Z', fromStatus: o.status, toStatus: to, refundRequired: false };
      state.order = { ...o, status: to, deliveryExceptions: [...((o.deliveryExceptions as unknown[]) ?? []), ex] };
      return json(route, 200, { success: true, data: state.order });
    }
    if (path === `/pharmacy-orders/${ID}/mark-paid`) {
      state.order = { ...o, paymentStatus: 'paid' };
      return json(route, 200, { success: true, data: state.order });
    }
    if (path === `/pharmacy-orders/${ID}/prescription-refund/retry`) {
      state.order = { ...o, prescriptionRefund: { ...(o.prescriptionRefund as object), status: 'wallet_credited', walletCreditedAt: '2026-11-14T07:05:00.000Z' } };
      return json(route, 200, { success: true, data: state.order });
    }
    if (path === '/request-keys/abandon') {
      const { kind, key } = req.postDataJSON() as { kind: string; key: string };
      if (kind !== 'customer_return') return refuse(route, 400, 'VALIDATION_ERROR', 'bad kind');
      if (state.returns.has(key)) return json(route, 200, { success: true, data: { state: 'used' } });
      state.abandoned.add(key);
      return json(route, 200, { success: true, data: { state: 'abandoned' } });
    }
    if (path === `/pharmacy-orders/${ID}/customer-returns`) {
      if (state.notOperational) return refuse(route, 403, 'PHARMACY_NOT_VERIFIED', 'Pharmacy is not verified');
      if (state.dropNextRequest) { state.dropNextRequest = false; return route.abort('connectionreset'); }
      if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
      if (state.refuseNextReturn) {
        state.refuseNextReturn = false;
        return refuse(route, 409, 'RETURN_EXCEEDS_DISPENSED', 'More units than were dispensed from this batch');
      }
      const key = String(body?.requestKey);
      const seen = state.returns.get(key);
      if (seen) return json(route, 200, { success: true, data: { ...seen, duplicate: true } });
      const rec = { _id: String(state.returns.size + 1).padStart(24, '9'), requestKey: key, reason: body?.reason,
        lines: (body?.lines as Record<string, unknown>[]).map((l) => ({ ...l, medicineName: 'Paracetamol 650mg', batchNumber: 'PCM-24A', valuePaise: 6000 })),
        returnValuePaise: 6000 * (body?.lines as unknown[]).length, refundPaise: Math.round(Number(body?.refundAmount ?? 0) * 100),
        createdAt: new Date().toISOString() };
      state.returns.set(key, rec);
      if (state.loseNextAnswer) { state.loseNextAnswer = false; return route.abort('connectionreset'); }
      return json(route, 201, { success: true, data: rec });
    }
    if (path === '/pharmacy-inventory/customer-returns') {
      const all = [...state.returns.values()].reverse();
      const page = Number(url.searchParams.get('page') ?? 1);
      const limit = Number(url.searchParams.get('limit') ?? 20);
      const items = all.slice((page - 1) * limit, page * limit);
      return json(route, 200, { success: true, data: items, pagination: { page, limit, total: all.length, totalPages: Math.max(1, Math.ceil(all.length / limit)) } });
    }
    return refuse(route, 404, 'NOT_FOUND', 'Not found');
  });
  return state;
}

async function openOrder(page: Page) {
  await page.goto('/');
  await page.getByLabel('Mobile number').fill('9876543210');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await page.getByRole('link', { name: 'Orders' }).first().click();
  await expect(page.getByRole('cell', { name: 'Meera Rao' })).toBeVisible();
  await page.getByRole('link', { name: 'PO-2001' }).click();
  await expect(page.getByRole('heading', { name: 'Order PO-2001' })).toBeVisible();
}

async function step(page: Page, label: string, confirm: string) {
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.getByRole('button', { name: confirm }).click();
}

test('a paid delivery order moves through every step, including a failed and retried delivery', async ({ page }) => {
  const backend = await mockBackend(page, order());
  await openOrder(page);
  await step(page, 'Accept order', 'Yes, accept order');
  await expect(page.getByText('Accepted', { exact: true })).toBeVisible();
  await step(page, 'Mark packed', 'Yes, mark packed');
  await step(page, 'Out for delivery', 'Yes, out for delivery');

  await page.getByRole('button', { name: 'Delivery failed', exact: true }).click();
  await page.getByRole('button', { name: 'Record: delivery failed' }).click();
  await expect(page.getByText('Give a reason (at least 3 characters).')).toBeVisible();
  await page.getByLabel('Reason').fill('Customer not reachable');
  await page.getByRole('button', { name: 'Record: delivery failed' }).click();
  await expect(page.getByRole('heading', { name: 'Delivery history' })).toBeVisible();

  await step(page, 'Retry delivery', 'Record: retry delivery');
  await step(page, 'Mark completed', 'Yes, mark completed');
  await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible();
  expect(backend.calls.map((c) => [c.path, (c.body as Record<string, unknown>)?.status ?? (c.body as Record<string, unknown>)?.type])).toEqual([
    ['/status', 'accepted'], ['/status', 'packed'], ['/status', 'out_for_delivery'],
    ['/delivery-exception', 'delivery_failed'], ['/delivery-exception', 'retry_delivery'], ['/status', 'completed'],
  ]);
});

test('an unpaid online order cannot be packed, and says why', async ({ page }) => {
  await mockBackend(page, order({ status: 'accepted', paymentStatus: 'pending' }));
  await openOrder(page);
  await expect(page.getByRole('button', { name: 'Mark packed' })).toBeDisabled();
  await expect(page.getByText('Waiting for payment.')).toBeVisible();
});

test('no order offers a generic cancel or reject: it could keep a payment that lands meanwhile', async ({ page }) => {
  for (const paymentStatus of ['paid', 'pending']) {
    const backend = await mockBackend(page, order({ paymentStatus }));
    await openOrder(page);
    await expect(page.getByText(/Cancelling or rejecting an order is not available here yet/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Cancel order|Reject order/ })).toHaveCount(0);
    expect(backend.calls).toHaveLength(0);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  }
});

test('cash on delivery: the order can go out unpaid, the payment is recorded, then it completes', async ({ page }) => {
  const backend = await mockBackend(page, order({ status: 'out_for_delivery', paymentMode: 'cash_on_delivery', paymentStatus: 'pending' }));
  await openOrder(page);
  await expect(page.getByRole('button', { name: 'Mark completed' })).toBeDisabled();
  await expect(page.getByText('Record the payment first.')).toBeVisible();
  await step(page, 'Record payment', 'Yes, payment received');
  await expect(page.getByRole('button', { name: 'Mark completed' })).toBeEnabled();
  await step(page, 'Mark completed', 'Yes, mark completed');
  expect(backend.calls.map((c) => c.path)).toEqual(['/mark-paid', '/status']);
});

test('a waiting refund can be retried', async ({ page }) => {
  await mockBackend(page, order({
    status: 'rejected', prescriptionStatus: 'rejected',
    prescriptionRefund: { status: 'wallet_pending', walletAmount: 240, gatewayAmountPaise: 0, lastError: 'WALLET_CREDIT_FAILED' },
  }));
  await openOrder(page);
  await expect(page.getByText('Waiting to credit the wallet')).toBeVisible();
  await step(page, 'Retry refund', 'Retry now');
  await expect(page.getByText('Credited to the customer’s wallet')).toBeVisible();
});

async function fillReturn(page: Page, qty: string, disposition: 'Back to stock' | 'Discard' = 'Back to stock') {
  await page.getByLabel('Returned quantity of Paracetamol 650mg, batch PCM-24A').fill(qty);
  await page.getByLabel('What happens to Paracetamol 650mg, batch PCM-24A').selectOption({ label: disposition });
  await page.getByLabel('Reason').fill('Doctor changed the prescription');
  await page.getByLabel('Refund to the customer’s wallet (₹, optional)').fill('10');
}

const returnCalls = (b: Backend) => b.calls.filter((c) => c.path === '/customer-returns').map((c) => c.body as Record<string, unknown>);

test('a return whose answer is lost is locked and resent unchanged; the receipt shows what was recorded', async ({ page }) => {
  const backend = await mockBackend(page, order({ status: 'completed' }));
  await openOrder(page);
  await expect(page.getByText('No return has been recorded for this order.')).toBeVisible();
  await page.getByRole('button', { name: 'Record a return…' }).click();
  await page.getByLabel('Returned quantity of Paracetamol 650mg, batch PCM-24A').fill('9');
  await page.getByLabel('Reason').fill('Doctor changed the prescription');
  await page.getByRole('button', { name: 'Record return' }).click();
  await expect(page.getByText('Enter a whole number from 1 to 4.')).toBeVisible();

  backend.loseNextAnswer = true; // recorded on the server, answer lost
  await fillReturn(page, '1');
  await page.getByRole('button', { name: 'Record return' }).click();
  const locked = page.getByRole('group', { name: 'Unconfirmed return' });
  await expect(locked).toContainText('It may already be recorded');
  await expect(locked).toContainText('Paracetamol 650mg (batch PCM-24A) × 1, back to stock');
  await expect(page.getByLabel('What happens to Paracetamol 650mg, batch PCM-24A')).toHaveCount(0); // nothing to edit

  await locked.getByRole('button', { name: 'Send the same request again' }).click();
  const receipt = page.getByRole('group', { name: 'Recorded return' });
  await expect(receipt).toContainText('This return had already been recorded');
  await expect(receipt).toContainText('Paracetamol 650mg (batch PCM-24A) × 1, back to stock');
  await expect(page.getByRole('heading', { name: 'Already recorded (1)' })).toBeVisible();

  const sent = returnCalls(backend);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]); // same key, same details
  expect(backend.returns.size).toBe(1);
});

test('an unconfirmed return survives leaving the order; nothing is recorded twice', async ({ page }) => {
  const backend = await mockBackend(page, order({ status: 'completed' }));
  await openOrder(page);
  backend.loseNextAnswer = true;
  await page.getByRole('button', { name: 'Record a return…' }).click();
  await fillReturn(page, '1');
  await page.getByRole('button', { name: 'Record return' }).click();
  await expect(page.getByRole('group', { name: 'Unconfirmed return' })).toBeVisible();

  await page.getByRole('link', { name: 'Orders', exact: true }).first().click();
  await page.getByRole('link', { name: 'PO-2001' }).click();
  const locked = page.getByRole('group', { name: 'Unconfirmed return' });
  await expect(locked).toBeVisible();
  await expect(page.getByRole('button', { name: 'Record a return…' })).toHaveCount(0);
  await locked.getByRole('button', { name: 'Send the same request again' }).click();
  await expect(page.getByRole('group', { name: 'Recorded return' })).toBeVisible();
  expect(backend.returns.size).toBe(1);
  expect(new Set(returnCalls(backend).map((b) => b.requestKey)).size).toBe(1);
});

test('after a reload, the recorded return is listed before another can be started', async ({ page }) => {
  const backend = await mockBackend(page, order({ status: 'completed' }));
  await openOrder(page);
  backend.loseNextAnswer = true;
  await page.getByRole('button', { name: 'Record a return…' }).click();
  await fillReturn(page, '1');
  await page.getByRole('button', { name: 'Record return' }).click();
  await expect(page.getByRole('group', { name: 'Unconfirmed return' })).toBeVisible();

  await page.reload(); // session memory is gone with the session; the server's record is not
  await page.getByLabel('Mobile number').fill('9876543210');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Already recorded (1)' })).toBeVisible();
  await expect(page.getByText(/Paracetamol 650mg × 1 back to stock · refund ₹10/)).toBeVisible();
  // D4: the unresolved request comes back from its reload marker (no details kept): no new return until it is resolved.
  const restored = page.getByRole('group', { name: 'Unconfirmed return' });
  await expect(restored).toContainText('made earlier on this device');
  await expect(page.getByRole('button', { name: 'Record return' })).toHaveCount(0);
  await expect(restored.getByRole('button', { name: 'Send the same request again' })).toHaveCount(0);
  await restored.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(page.getByRole('group', { name: 'Recorded return' })).toBeVisible();
});

test('a definite refusal records nothing: the form stays editable and the next try uses a new key', async ({ page }) => {
  const backend = await mockBackend(page, order({ status: 'completed' }));
  await openOrder(page);
  backend.refuseNextReturn = true;
  await page.getByRole('button', { name: 'Record a return…' }).click();
  await fillReturn(page, '4');
  await page.getByRole('button', { name: 'Record return' }).click();
  await expect(page.getByText('Not recorded: More units than were dispensed from this batch')).toBeVisible();
  await fillReturn(page, '2', 'Discard');
  await page.getByRole('button', { name: 'Record return' }).click();
  await expect(page.getByRole('group', { name: 'Recorded return' })).toContainText('× 2, discarded');
  const [first, second] = returnCalls(backend);
  expect(first!.requestKey).not.toBe(second!.requestKey);
  expect(second).toMatchObject({ refundAmount: 10, lines: [{ medicineId: MED, batchId: BATCH, quantity: 2, disposition: 'discard' }] });
});

test('a refused RETRY proves nothing: the return stays locked until the server shows its record', async ({ page }) => {
  const backend = await mockBackend(page, order({ status: 'completed' }));
  await openOrder(page);
  backend.loseNextAnswer = true; // recorded, answer lost
  await page.getByRole('button', { name: 'Record a return…' }).click();
  await fillReturn(page, '1');
  await page.getByRole('button', { name: 'Record return' }).click();
  const locked = page.getByRole('group', { name: 'Unconfirmed return' });
  await expect(locked).toBeVisible();

  backend.notOperational = true; // the access check now refuses before the key is looked up
  await locked.getByRole('button', { name: 'Send the same request again' }).click();
  await expect(locked).toContainText('Pharmacy is not verified');
  await expect(page.getByRole('button', { name: 'Record a return…' })).toHaveCount(0); // still locked
  await expect(page.getByText(/^Not recorded/)).toHaveCount(0);

  backend.notOperational = false;
  await locked.getByRole('button', { name: 'Send the same request again' }).click();
  await expect(page.getByRole('group', { name: 'Recorded return' })).toContainText('This return had already been recorded');
  expect(backend.returns.size).toBe(1);
});

test('checking the records finds a recorded return by its key', async ({ page }) => {
  const backend = await mockBackend(page, order({ status: 'completed' }));
  await openOrder(page);
  backend.loseNextAnswer = true;
  await page.getByRole('button', { name: 'Record a return…' }).click();
  await fillReturn(page, '1');
  await page.getByRole('button', { name: 'Record return' }).click();
  await page.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(page.getByRole('group', { name: 'Recorded return' })).toContainText('× 1, back to stock');
  expect(returnCalls(backend)).toHaveLength(1); // found, not resent
});

test('nothing concludes "not recorded": a lookup that misses says so, is cleared by the next send, and no discard exists', async ({ page }) => {
  const backend = await mockBackend(page, order({ status: 'completed' }));
  await openOrder(page);
  backend.dropNextRequest = true; // nothing recorded, answer lost
  await page.getByRole('button', { name: 'Record a return…' }).click();
  await fillReturn(page, '1');
  await page.getByRole('button', { name: 'Record return' }).click();
  const locked = page.getByRole('group', { name: 'Unconfirmed return' });
  await locked.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(locked).toContainText('That does not prove it was not recorded');
  await expect(locked.getByRole('button', { name: /Discard/ })).toHaveCount(0);

  backend.dropNextRequest = true; // the resend is lost too
  await locked.getByRole('button', { name: 'Send the same request again' }).click();
  await expect(locked).toContainText('Could not reach the server');
  await expect(locked).not.toContainText('That does not prove'); // the old lookup result is gone

  await locked.getByRole('button', { name: 'Send the same request again' }).click(); // goes through now
  await expect(page.getByRole('group', { name: 'Recorded return' })).toContainText('Return recorded:');
  expect(backend.returns.size).toBe(1);
  expect(new Set(returnCalls(backend).map((b) => b.requestKey)).size).toBe(1);
});

test('a first attempt still running when the page is reopened is not treated as refused by a later 403', async ({ page }) => {
  const backend = await mockBackend(page, order({ status: 'completed' }));
  await openOrder(page);
  backend.delayMs = 2500; // the first attempt is slow and will commit
  await page.getByRole('button', { name: 'Record a return…' }).click();
  await fillReturn(page, '1');
  await page.getByRole('button', { name: 'Record return' }).click();
  await page.getByRole('link', { name: 'Orders', exact: true }).first().click();
  await page.getByRole('link', { name: 'PO-2001' }).click();
  const locked = page.getByRole('group', { name: 'Unconfirmed return' });
  await expect(locked).toBeVisible(); // restored while attempt 1 runs

  backend.delayMs = 0;
  backend.notOperational = true;
  await locked.getByRole('button', { name: 'Send the same request again' }).click();
  await expect(locked).toContainText('Pharmacy is not verified');
  await page.waitForTimeout(3000); // attempt 1 commits now; its answer arrives at the unmounted page
  await expect(locked).toBeVisible();
  await expect(page.getByRole('button', { name: 'Record a return…' })).toHaveCount(0);

  backend.notOperational = false;
  await locked.getByRole('button', { name: 'Send the same request again' }).click();
  await expect(page.getByRole('group', { name: 'Recorded return' })).toContainText('This return had already been recorded');
  expect(backend.returns.size).toBe(1);
});

test('a late answer for an older return does not clear a newer unconfirmed return', async ({ page }) => {
  const backend = await mockBackend(page, order({ status: 'completed' }));
  await openOrder(page);
  backend.delayMs = 3000; // K1: slow first answer
  await page.getByRole('button', { name: 'Record a return…' }).click();
  await fillReturn(page, '1');
  await page.getByRole('button', { name: 'Record return' }).click();
  backend.delayMs = 0;
  await page.getByRole('link', { name: 'Orders', exact: true }).first().click();
  await page.getByRole('link', { name: 'PO-2001' }).click();
  await page.getByRole('group', { name: 'Unconfirmed return' }).getByRole('button', { name: 'Send the same request again' }).click();
  await expect(page.getByRole('group', { name: 'Recorded return' })).toBeVisible(); // K1 settled in this mount

  backend.loseNextAnswer = true; // K2: recorded, answer lost
  await page.getByRole('button', { name: 'Record another return…' }).click();
  await fillReturn(page, '2', 'Discard');
  await page.getByRole('button', { name: 'Record return' }).click();
  await expect(page.getByRole('group', { name: 'Unconfirmed return' })).toContainText('× 2, discarded');

  await page.waitForTimeout(3500); // K1's first answer now reaches the old, unmounted page
  await page.getByRole('link', { name: 'Orders', exact: true }).first().click();
  await page.getByRole('link', { name: 'PO-2001' }).click();
  const k2 = page.getByRole('group', { name: 'Unconfirmed return' });
  await expect(k2).toContainText('× 2, discarded'); // still locked: K2 was not cleared
  await k2.getByRole('button', { name: 'Send the same request again' }).click();
  await expect(page.getByRole('group', { name: 'Recorded return' })).toContainText('This return had already been recorded');
  expect(backend.returns.size).toBe(2);
});

test('D4: a return still running at sign-out stays unresolved for the same person after signing back in, until found', async ({ page }) => {
  const backend = await mockBackend(page, order({ status: 'completed' }));
  await openOrder(page);
  backend.delayMs = 1500;
  await page.getByRole('button', { name: 'Record a return…' }).click();
  await fillReturn(page, '1');
  await page.getByRole('button', { name: 'Record return' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForTimeout(1800);
  await page.getByLabel('Mobile number').fill('9876543210');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await page.getByRole('link', { name: 'Orders' }).first().click();
  await page.getByRole('link', { name: 'PO-2001' }).click();
  await expect(page.getByRole('heading', { name: /Already recorded|Customer return/ }).first()).toBeVisible();
  // The earlier session's request may have been recorded after it ended: no new return until that is settled.
  const restored = page.getByRole('group', { name: 'Unconfirmed return' });
  await expect(restored).toContainText('made earlier on this device');
  await restored.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(page.getByRole('group', { name: 'Recorded return' })).toBeVisible();
});

test('the recorded-return history pages past the newest 50', async ({ page }) => {
  const backend = await mockBackend(page, order({ status: 'completed' }));
  for (let i = 0; i < 60; i++) {
    backend.returns.set(`seed-${i}`, { _id: String(i).padStart(24, '8'), requestKey: `seed-${i}`, reason: `Seeded ${i}`,
      lines: [{ medicineId: MED, batchId: BATCH, quantity: 1, disposition: 'discard', medicineName: 'Paracetamol 650mg' }],
      returnValuePaise: 6000, refundPaise: 0, createdAt: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString() });
  }
  await openOrder(page);
  await expect(page.getByRole('heading', { name: 'Already recorded (60)' })).toBeVisible();
  await expect(page.getByText('Showing 1–50 of 60, newest first.')).toBeVisible();
  await expect(page.getByText('“Seeded 0”')).toHaveCount(0);
  await page.getByRole('button', { name: 'Older' }).click();
  await expect(page.getByText('Showing 51–60 of 60, newest first.')).toBeVisible();
  await expect(page.getByText(/“Seeded 0”/)).toBeVisible();
});

test('an order this pharmacy is buying shows no actions', async ({ page }) => {
  await mockBackend(page, order({ pharmacyId: OTHER, buyerPharmacyId: ME, paymentStatus: 'pending' }));
  await openOrder(page);
  await expect(page.getByText('Your pharmacy is the buyer on this order')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Next step' })).toHaveCount(0);
});

test('D4: a return lost before reaching the server, then a reload: check, cancel it on the server, start again', async ({ page }) => {
  const backend = await mockBackend(page, order({ status: 'completed' }));
  await openOrder(page);
  backend.dropNextRequest = true;
  await page.getByRole('button', { name: 'Record a return…' }).click();
  await fillReturn(page, '1');
  await page.getByRole('button', { name: 'Record return' }).click();
  await expect(page.getByRole('group', { name: 'Unconfirmed return' })).toBeVisible();
  const lostKey = (returnCalls(backend)[0] as { requestKey: string }).requestKey;
  await page.reload();
  await page.getByLabel('Mobile number').fill('9876543210');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  const restored = page.getByRole('group', { name: 'Unconfirmed return' });
  await expect(restored).toContainText('made earlier on this device');
  await expect(restored.getByRole('button', { name: 'Cancel it and start again' })).toHaveCount(0); // look first
  await restored.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await restored.getByRole('button', { name: 'Cancel it and start again' }).click();
  await expect(page.getByRole('button', { name: 'Record a return…' })).toBeVisible();
  expect(backend.abandoned.has(lostKey)).toBe(true);
});
