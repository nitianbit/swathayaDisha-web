import { expect, test, type Page, type Route } from '@playwright/test';

/** D3 admin queue: paid pharmacy orders waiting for a cancellation decision. */
const ADMIN = 'ad'.repeat(12);
const PHARMACY = '7a'.repeat(12);
const O1 = '71'.repeat(12);
const O2 = '72'.repeat(12);
const R1 = 'c1'.repeat(12);
const R2 = 'c2'.repeat(12);

interface Backend { orders: Record<string, unknown>[]; calls: { path: string; body: unknown }[]; listQueries: string[]; changeNext: boolean }

function pendingOrder(id: string, requestId: string, over: Record<string, unknown> = {}) {
  return {
    _id: id, orderNumber: `PO-${id.slice(0, 4)}`, pharmacyId: PHARMACY, orderType: 'online', status: 'pending_cancel',
    customerId: { _id: 'cu'.repeat(12), name: 'Lata Iyer', phone: '9800000001' },
    items: [{ medicineId: 'm1', medicineName: 'Paracetamol 500', orderedQty: 2, lineTotal: 40 }],
    grandTotal: 240, paymentMode: 'online_payment', paymentStatus: 'paid', createdAt: '2026-11-15T04:00:00.000Z',
    cancelRequest: { requestId, state: 'pending', fromStatus: 'accepted', paymentStatusAtRequest: 'paid', requestedByType: 'user',
      requestedAt: '2026-11-15T05:00:00.000Z', reason: 'Ordered twice' },
    ...over,
  };
}

async function mockBackend(page: Page): Promise<Backend> {
  const b: Backend = {
    orders: [pendingOrder(O1, R1), pendingOrder(O2, R2, { paymentMode: 'cash_on_delivery', orderNumber: 'PO-COD' })],
    calls: [], listQueries: [], changeNext: false,
  };
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1', '');
    const body = req.method() === 'POST' ? req.postDataJSON() : null;
    if (path === '/auth/admin/send') return json(route, 200, { success: true });
    if (path === '/auth/admin/verify') return json(route, 200, { success: true, data: { token: 't1', user: {} } });
    if (req.headers().authorization !== 'Bearer t1') return json(route, 401, { error: 401, message: 'Authentication is required' });
    if (path === '/auth/profile') return json(route, 200, { success: true, data: { user: { _id: ADMIN, name: 'Ops Admin' }, userRole: 'admin' } });
    if (path === `/pharmacies/${PHARMACY}`) return json(route, 200, { success: true, data: { _id: PHARMACY, name: 'Asha Medicals' } });
    if (path === '/pharmacy-orders' && req.method() === 'GET') {
      b.listQueries.push(url.search);
      const all = b.orders.filter((o) => o.status === 'pending_cancel');
      const pg = Number(url.searchParams.get('page') ?? '1'); const limit = Number(url.searchParams.get('limit') ?? '20');
      const items = all.slice((pg - 1) * limit, pg * limit);
      return json(route, 200, { success: true, data: items, pagination: { page: pg, limit, total: all.length, totalPages: Math.ceil(all.length / limit) } });
    }
    const m = /^\/pharmacy-orders\/(\w+)\/cancel-request\/(approve|reject)$/.exec(path);
    if (m) {
      b.calls.push({ path: `${m[1]}/${m[2]}`, body });
      const o = b.orders.find((x) => x._id === m[1]) as { cancelRequest: { requestId: string; fromStatus: string } } | undefined;
      if (!o) return json(route, 404, { error: 404, message: 'Order not found' });
      if (b.changeNext || (body as { requestId?: string }).requestId !== o.cancelRequest.requestId) {
        b.changeNext = false;
        return json(route, 409, { error: 409, code: 'CANCEL_REQUEST_CHANGED', message: 'This cancellation request changed; reload the order and decide again' });
      }
      Object.assign(o, m[2] === 'approve'
        ? { status: 'cancelled', cancelRequest: { ...o.cancelRequest, state: 'approved' } }
        : { status: o.cancelRequest.fromStatus, cancelRequest: { ...o.cancelRequest, state: 'rejected' } });
      return json(route, 200, { success: true, data: o });
    }
    return json(route, 404, { error: 404, message: 'Not found' });
  });
  return b;
}

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Admin').check();
  await page.getByLabel('Mobile number').fill('9876543210');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await page.getByRole('link', { name: 'Order cancellations' }).first().click();
}

const card = (page: Page, label: string) => page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: `Order ${label}` }) });

test('admin sees paid orders waiting for a cancellation decision, with the pharmacy, customer and refund route', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'Order cancellations' })).toBeVisible();
  expect(b.listQueries.some((q) => q.includes('status=pending_cancel'))).toBe(true);
  await expect(page.getByText('2 waiting for a decision')).toBeVisible();
  const online = card(page, 'PO-7171');
  await expect(online).toContainText('Asha Medicals');
  await expect(online).toContainText('Lata Iyer');
  await expect(online).toContainText('Paracetamol 500 × 2');
  await expect(online).toContainText('Ordered twice');
  await expect(online).toContainText('goes back to their Jansetu wallet first');
  await expect(card(page, 'PO-COD')).toContainText('not automatic for a cash or counter payment');
});

test('approving names the request on screen; the order leaves the queue', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  const online = card(page, 'PO-7171');
  await online.getByRole('button', { name: 'Approve cancellation' }).click();
  await online.getByRole('button', { name: 'Yes, cancel the order' }).click();
  await expect(card(page, 'PO-7171')).toHaveCount(0);
  await expect(page.getByText('1 waiting for a decision')).toBeVisible();
  expect(b.calls[0]).toMatchObject({ path: `${O1}/approve`, body: { requestId: R1 } });
});

test('keeping an order needs a reason; a request that changed meanwhile is not decided', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  const cod = card(page, 'PO-COD');
  await cod.getByRole('button', { name: 'Keep the order' }).click();
  await cod.getByRole('button', { name: 'Yes, keep it' }).click();
  await expect(cod.getByText('Give a reason', { exact: false })).toBeVisible();
  expect(b.calls).toHaveLength(0);
  await cod.getByLabel('Why it is kept (shown to the customer)').fill('Already delivered to the customer');
  b.changeNext = true;
  await cod.getByRole('button', { name: 'Yes, keep it' }).click();
  await expect(cod.getByText('This cancellation request changed', { exact: false })).toBeVisible();
  await cod.getByRole('button', { name: 'Yes, keep it' }).click();
  await expect(card(page, 'PO-COD')).toHaveCount(0);
  expect(b.calls.at(-1)).toMatchObject({ path: `${O2}/reject`, body: { requestId: R2, note: 'Already delivered to the customer' } });
});

test('an empty queue says so', async ({ page }) => {
  const b = await mockBackend(page);
  b.orders = [];
  await signIn(page);
  await expect(page.getByText('No cancellation requests waiting')).toBeVisible();
});

test('deciding the only request on the last page goes back to the previous page, not an empty one', async ({ page }) => {
  const b = await mockBackend(page);
  b.orders = Array.from({ length: 21 }, (_, i) => pendingOrder((80 + i).toString(16).padStart(2, '0').repeat(12), 'd'.repeat(23) + (i % 10),
    { orderNumber: `PO-${1000 + i}` }));
  await signIn(page);
  await expect(page.getByText('21 waiting for a decision')).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('Page 2 of 2')).toBeVisible();
  const last = card(page, 'PO-1020');
  await last.getByRole('button', { name: 'Approve cancellation' }).click();
  await last.getByRole('button', { name: 'Yes, cancel the order' }).click();
  await expect(page.getByText('20 waiting for a decision')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Order PO-1000' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Pages' })).toHaveCount(0);
});
