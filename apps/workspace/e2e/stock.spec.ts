import { expect, test, type Page, type Route } from '@playwright/test';

const ME = 'b'.repeat(24);
const ITEM = '2'.repeat(24);
const MED = '3'.repeat(24);
const A = 'a1'.repeat(12); // active
const Q = 'a2'.repeat(12); // quarantined
const R = 'a3'.repeat(12); // recalled
const X = 'a4'.repeat(12); // active but expired by date
const SUPPLIER = '5'.repeat(24);
const HELD_ORDER = '6'.repeat(24);
const LATE_ORDER = '7'.repeat(24);

type Batch = Record<string, unknown> & { _id: string; status: string; availableQty: number };

const FROM: Record<string, string[]> = {
  quarantine: ['active', 'expired'], release: ['quarantined'],
  'supplier-return': ['active', 'expired', 'quarantined', 'recalled'], recall: ['active', 'expired', 'quarantined', 'depleted'],
};

interface Backend {
  batches: Batch[]; calls: { path: string; body: unknown }[]; heldOrders: Record<string, unknown>[];
  returnsByKey: Map<string, Record<string, unknown>>; loseNextAnswer: boolean;
}

async function mockBackend(page: Page): Promise<Backend> {
  const state: Backend = {
    calls: [], returnsByKey: new Map(), loseNextAnswer: false,
    batches: [
      { _id: A, batchNumber: 'PCM-A', expiryDate: '20990101', availableQty: 10, reservedQty: 2, status: 'active' },
      { _id: Q, batchNumber: 'PCM-Q', expiryDate: '20990101', availableQty: 6, reservedQty: 1, status: 'quarantined', holdReason: 'Seal broken' },
      { _id: R, batchNumber: 'PCM-R', expiryDate: '20990101', availableQty: 4, reservedQty: 0, status: 'recalled', recallReference: 'CDSCO-77' },
      { _id: X, batchNumber: 'PCM-X', expiryDate: '20200101', availableQty: 50, reservedQty: 0, status: 'active' },
    ],
    heldOrders: [
      { orderId: HELD_ORDER, orderNumber: 'PO-3001', status: 'accepted',
        heldUnits: [{ medicineId: MED, medicineName: 'Paracetamol 650mg', batchId: Q, batchNumber: 'PCM-Q', quantity: 1 }] },
      { orderId: LATE_ORDER, orderNumber: 'PO-3002', status: 'out_for_delivery',
        heldUnits: [{ medicineId: MED, medicineName: 'Paracetamol 650mg', batchId: R, batchNumber: 'PCM-R', quantity: 2 }] },
    ],
  };
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const item = () => ({
    _id: ITEM, medicineId: { _id: MED, name: 'Paracetamol', strength: '650mg' }, availableQty: 70, reservedQty: 3,
    reorderThreshold: 20, rackLocation: 'B2', batches: state.batches,
  });

  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1', '');
    const body = req.method() === 'POST' ? (req.postDataJSON() as Record<string, unknown> | null) : null;
    if (path === '/auth/pharmacy/send') return json(route, 200, { success: true });
    if (path === '/auth/pharmacy/verify') return json(route, 200, { success: true, data: { token: 't1', user: {} } });
    if (req.headers().authorization !== 'Bearer t1') return json(route, 401, { error: 401, message: 'Authentication is required' });
    if (path === '/auth/profile') return json(route, 200, { success: true, data: { user: { _id: ME, name: 'Asha Medicals' }, userRole: 'pharmacy' } });
    const page1 = (items: unknown[]) => json(route, 200, { success: true, data: items, pagination: { page: 1, limit: 20, total: items.length, totalPages: 1 } });

    if (path === '/pharmacy-inventory' && req.method() === 'GET') {
      expect(url.searchParams.get('includeBatches')).toBe('true');
      const s = (url.searchParams.get('search') ?? '').toLowerCase();
      return page1(!s || 'paracetamol'.includes(s) ? [item()] : []);
    }
    if (path === '/pharmacy-inventory/low-stock') return page1([{ ...item(), reorderThreshold: 30, upcomingRefills: 12 }]); // a count, as the backend sends it
    if (path === '/pharmacy-inventory/held-batch-orders') return json(route, 200, { success: true, data: state.heldOrders });
    if (path === '/pharmacy-inventory/quality-holds') {
      return page1(state.batches.filter((b) => ['quarantined', 'recalled'].includes(b.status)).map((b) => ({
        inventoryItemId: ITEM, medicineId: MED, medicineName: 'Paracetamol', batchId: b._id, batchNumberRaw: b.batchNumber,
        expiryDateRaw: b.expiryDate, storedQualityStatus: b.status, availableQty: b.availableQty, reservedQty: b.reservedQty,
      })));
    }
    if (path === '/pharmacy-inventory/supplier-returns') return page1([]);
    if (path === '/pharmacy-suppliers') return page1([{ supplierId: SUPPLIER, displayName: 'Sun Distributors', state: 'active', revision: 1, contactName: null }]); // SupplierDto

    const m = /^\/pharmacy-inventory\/(\w{24})\/batches\/(\w{24})\/([a-z-]+)$/.exec(path);
    if (m) {
      const [, , batchId, action] = m;
      const b = state.batches.find((x) => x._id === batchId)!;
      if (action === 'recall-trace') {
        return json(route, 200, { success: true, data: { batch: b, openOrders: [], dispensedTo: [{ orderId: '8'.repeat(24), orderNumber: 'PO-1', quantity: 3, completedAt: '2026-11-01T10:00:00.000Z' }], dispensedTruncated: false } });
      }
      state.calls.push({ path: `${batchId}/${action}`, body });
      if (action === 'supplier-return') {
        const seen = state.returnsByKey.get(String(body?.requestKey));
        if (seen) return json(route, 200, { success: true, data: { ...seen, duplicate: true } }); // replay before any check
      }
      if (!FROM[action!]!.includes(b.status)) return json(route, 409, { error: 409, code: 'BATCH_STATE', message: `A ${b.status} batch cannot do that` });
      if (action === 'quarantine') b.status = 'quarantined';
      if (action === 'release') { b.status = 'active'; b.availableQty -= Number(body?.writeOffQty); }
      if (action === 'supplier-return') {
        if (Number(body?.quantity) > b.availableQty) return json(route, 400, { error: 400, code: 'VALIDATION_ERROR', message: `Quantity must be between 1 and ${b.availableQty} (unreserved units)` });
        b.availableQty -= Number(body?.quantity);
        const rec = { _id: '9'.repeat(24), batchNumber: b.batchNumber, quantity: body?.quantity, reason: body?.reason, requestKey: body?.requestKey };
        state.returnsByKey.set(String(body?.requestKey), rec);
        if (state.loseNextAnswer) { state.loseNextAnswer = false; return route.abort('connectionreset'); }
        return json(route, 201, { success: true, data: rec });
      }
      if (action === 'recall') {
        b.status = 'recalled';
        return json(route, 200, { success: true, data: { batch: b, impactedOrders: [state.heldOrders[0]], dispensedTo: [], dispensedTruncated: false } });
      }
      return json(route, 200, { success: true, data: { batch: b } });
    }
    const o = /^\/pharmacy-orders\/(\w{24})\/(reallocate-held-stock|stock-hold-cancel)$/.exec(path);
    if (o) {
      state.calls.push({ path: `${o[1]}/${o[2]}`, body });
      state.heldOrders = state.heldOrders.filter((h) => h.orderId !== o[1]);
      return json(route, 200, { success: true, data: {} });
    }
    return json(route, 404, { error: 404, message: 'Not found' });
  });
  return state;
}

async function signIn(page: Page, to: string) {
  await page.goto('/');
  await page.getByLabel('Mobile number').fill('9876543210');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await page.getByRole('link', { name: to, exact: true }).first().click();
}

const row = (page: Page, batch: string) => page.getByRole('row').filter({ hasText: batch });

test('stock shows sellable units by the backend rule and offers only the actions each batch state allows', async ({ page }) => {
  await mockBackend(page);
  await signIn(page, 'Stock');
  await page.getByLabel('Medicine').fill('para');
  await page.getByRole('button', { name: 'Search' }).click();
  // Only PCM-A counts: Q is quarantined, R recalled, X past its date.
  await expect(page.getByText('10 sellable · 3 reserved · rack B2')).toBeVisible();
  await expect(page.getByText('Low: reorder at 20')).toBeVisible();
  await expect(row(page, 'PCM-A').getByRole('button', { name: 'Quarantine' })).toBeVisible();
  await expect(row(page, 'PCM-A').getByRole('button', { name: 'Release…' })).toHaveCount(0);
  await expect(row(page, 'PCM-Q').getByRole('button', { name: 'Release…' })).toBeVisible();
  await expect(row(page, 'PCM-Q').getByRole('button', { name: 'Quarantine' })).toHaveCount(0);
  await expect(row(page, 'PCM-R').getByRole('button', { name: 'Recall…' })).toHaveCount(0);
  await expect(row(page, 'PCM-R').getByRole('button', { name: 'Recall trace' })).toBeVisible();
  await expect(row(page, 'PCM-Q')).toContainText('Seal broken');
});

test('quarantine needs a reason; release checks the write-off against unreserved units', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page, 'Stock');
  await row(page, 'PCM-A').getByRole('button', { name: 'Quarantine' }).click();
  await row(page, 'PCM-A').getByRole('button', { name: 'Quarantine batch' }).click();
  await expect(row(page, 'PCM-A').getByText('Give a reason (at least 3 characters).')).toBeVisible();
  await row(page, 'PCM-A').getByLabel('Why is it held?').fill('Supplier alert');
  await row(page, 'PCM-A').getByRole('button', { name: 'Quarantine batch' }).click();
  await expect(row(page, 'PCM-A').getByText('Quarantined')).toBeVisible();

  await row(page, 'PCM-Q').getByRole('button', { name: 'Release…' }).click();
  await row(page, 'PCM-Q').getByLabel('Units to write off').fill('7');
  await row(page, 'PCM-Q').getByLabel('Reason').fill('Checked, seal fine');
  await row(page, 'PCM-Q').getByRole('button', { name: 'Release batch' }).click();
  await expect(row(page, 'PCM-Q').getByText('Enter a whole number from 0 to 6.')).toBeVisible();
  await row(page, 'PCM-Q').getByLabel('Units to write off').fill('1');
  await row(page, 'PCM-Q').getByRole('button', { name: 'Release batch' }).click();
  await expect(row(page, 'PCM-Q').getByText('On sale')).toBeVisible();
  expect(backend.calls).toEqual([
    { path: `${A}/quarantine`, body: { reason: 'Supplier alert' } },
    { path: `${Q}/release`, body: { writeOffQty: 1, reason: 'Checked, seal fine' } },
  ]);
});

test('a supplier return needs a supplier and a quantity within the unreserved units', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page, 'Stock');
  await row(page, 'PCM-R').getByRole('button', { name: 'Return to supplier…' }).click();
  await row(page, 'PCM-R').getByLabel('Units', { exact: true }).fill('5');
  await row(page, 'PCM-R').getByRole('button', { name: 'Record supplier return' }).click();
  await expect(row(page, 'PCM-R').getByText('Choose the supplier.')).toBeVisible();
  await expect(row(page, 'PCM-R').getByText('Enter a whole number from 1 to 4.')).toBeVisible();
  await row(page, 'PCM-R').getByLabel('Supplier', { exact: true }).selectOption('Sun Distributors');
  await row(page, 'PCM-R').getByLabel('Units', { exact: true }).fill('4');
  await row(page, 'PCM-R').getByRole('button', { name: 'Record supplier return' }).click();
  await expect(row(page, 'PCM-R').getByRole('button', { name: 'Return to supplier…' })).toHaveCount(0); // nothing unreserved left
  await expect(page.getByText('Recorded: 4 units of batch PCM-R returned (recalled).')).toBeVisible();
  expect(backend.calls).toEqual([{ path: `${R}/supplier-return`, body: { supplierId: SUPPLIER, quantity: 4, reason: 'recalled', requestKey: expect.stringMatching(/^[A-Za-z0-9_-]{8,64}$/) } }]);
});

test('a supplier return whose answer is lost is locked, survives leaving the page, and is resent unchanged', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.loseNextAnswer = true; // recorded, answer lost
  await signIn(page, 'Stock');
  await row(page, 'PCM-A').getByRole('button', { name: 'Return to supplier…' }).click();
  await row(page, 'PCM-A').getByLabel('Supplier', { exact: true }).selectOption('Sun Distributors');
  await row(page, 'PCM-A').getByLabel('Units', { exact: true }).fill('3');
  await row(page, 'PCM-A').getByRole('button', { name: 'Record supplier return' }).click();
  const locked = page.getByRole('group', { name: 'Unconfirmed return of batch PCM-A' });
  await expect(locked).toContainText('3 units to Sun Distributors · damaged');
  await expect(row(page, 'PCM-A').getByLabel('Units', { exact: true })).toHaveCount(0);

  await page.getByRole('link', { name: 'Low stock' }).click();
  await page.getByRole('link', { name: 'Stock', exact: true }).click();
  await expect(locked).toBeVisible(); // reopened on its own
  await locked.getByRole('button', { name: 'Send the same return again' }).click();
  await expect(page.getByText('Already recorded: 3 units of batch PCM-A returned (damaged).')).toBeVisible();
  const sent = backend.calls.filter((c) => c.path === `${A}/supplier-return`).map((c) => c.body);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
  expect(backend.batches.find((b) => b._id === A)!.availableQty).toBe(7); // 10 - 3, once
});

test('a refused supplier return records nothing and can be corrected', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page, 'Stock');
  await expect(page.getByText('10 sellable')).toBeVisible();
  backend.batches.find((b) => b._id === A)!.availableQty = 2; // someone else took units meanwhile; the page still says 10
  await row(page, 'PCM-A').getByRole('button', { name: 'Return to supplier…' }).click();
  await row(page, 'PCM-A').getByLabel('Supplier', { exact: true }).selectOption('Sun Distributors');
  await row(page, 'PCM-A').getByLabel('Units', { exact: true }).fill('5');
  await row(page, 'PCM-A').getByRole('button', { name: 'Record supplier return' }).click();
  await expect(row(page, 'PCM-A').getByText('Not recorded: Quantity must be between 1 and 2 (unreserved units)')).toBeVisible();
  await row(page, 'PCM-A').getByLabel('Units', { exact: true }).fill('2');
  await row(page, 'PCM-A').getByRole('button', { name: 'Record supplier return' }).click();
  await expect(page.getByText('Recorded: 2 units of batch PCM-A returned (damaged).')).toBeVisible();
  const keys = backend.calls.filter((c) => c.path === `${A}/supplier-return`).map((c) => (c.body as { requestKey: string }).requestKey);
  expect(new Set(keys).size).toBe(2);
});

test('a recall is confirmed and immediately shows who is affected; a recalled batch keeps its trace', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page, 'Stock');
  await row(page, 'PCM-A').getByRole('button', { name: 'Recall…' }).click();
  await expect(row(page, 'PCM-A').getByText(/This cannot be undone/)).toBeVisible();
  await row(page, 'PCM-A').getByLabel('Reason').fill('Manufacturer recall');
  await row(page, 'PCM-A').getByLabel('Notice reference (optional)').fill('CDSCO-88');
  await row(page, 'PCM-A').getByRole('button', { name: 'Recall batch' }).click();
  await expect(page.getByText('Batch PCM-A is recalled.')).toBeVisible();
  await expect(page.getByText(/PO-3001 · accepted · 1 units/)).toBeVisible();
  expect(backend.calls).toEqual([{ path: `${A}/recall`, body: { reason: 'Manufacturer recall', reference: 'CDSCO-88' } }]);

  await row(page, 'PCM-R').getByRole('button', { name: 'Recall trace' }).click();
  await expect(page.getByText(/Order PO-1 · 3 units/)).toBeVisible();
});

test('low stock lists medicines below their level with refills due', async ({ page }) => {
  await mockBackend(page);
  await signIn(page, 'Low stock');
  const r = page.getByRole('row').filter({ hasText: 'Paracetamol 650mg' });
  await expect(r).toContainText('10');
  await expect(r).toContainText('30');
  await expect(r.getByRole('cell').nth(3)).toHaveText('12');
  await r.getByRole('link').click();
  await expect(page.getByRole('heading', { name: 'Stock' })).toBeVisible();
  await expect(page.getByLabel('Medicine')).toHaveValue('Paracetamol');
  await expect(page.getByText('10 sellable')).toBeVisible();
});

test('quality: an order holding held stock can be swapped or cancelled; one on the road cannot be swapped', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page, 'Quality');
  const first = page.getByRole('listitem').filter({ hasText: 'PO-3001' });
  const late = page.getByRole('listitem').filter({ hasText: 'PO-3002' });
  await expect(late.getByText('its stock can no longer be swapped')).toBeVisible();
  await expect(late.getByRole('button', { name: 'Swap to good stock' })).toHaveCount(0);
  await expect(page.getByRole('row').filter({ hasText: 'PCM-Q' })).toContainText('Quarantined');

  await first.getByRole('button', { name: 'Swap to good stock' }).click();
  await first.getByRole('button', { name: 'Swap batches' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'PO-3001' })).toHaveCount(0);

  await late.getByRole('button', { name: 'Cancel order' }).click();
  await expect(late.getByText(/If it was paid, the customer is refunded/)).toBeVisible();
  await late.getByLabel('Reason (the customer sees it)').fill('Batch recalled by the manufacturer');
  await late.getByRole('button', { name: 'Cancel order' }).click();
  await expect(page.getByText('No open order holds quarantined or recalled stock')).toBeVisible();
  expect(backend.calls).toEqual([
    { path: `${HELD_ORDER}/reallocate-held-stock`, body: null },
    { path: `${LATE_ORDER}/stock-hold-cancel`, body: { reason: 'Batch recalled by the manufacturer' } },
  ]);
});
