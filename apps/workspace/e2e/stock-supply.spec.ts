import { expect, test, type Page, type Route } from '@playwright/test';

// WQ10a: add stock, import a stock file, suppliers, and return to a supplier — against a mock of the backend's rules
// (pharmacyInventory, pharmacyInventoryImports, pharmacySuppliers).
const ME = 'b'.repeat(24);
const ITEM = '2'.repeat(24);
const MED = '3'.repeat(24);
const MED2 = '4'.repeat(24);
const BATCH = 'a1'.repeat(12);
const IMP = 'd1'.repeat(12);

type Json = Record<string, unknown>;
interface Supplier extends Json { supplierId: string; displayName: string; state: 'active' | 'archived'; revision: number; createdAt: string }

interface Backend {
  stockPosts: Json[];
  adjustments: Json[];
  /** Add the units, then drop the answer. */ loseNextStockAnswer: boolean;
  /** Refuse the next stock entry before recording anything. */ refuseNextStock: boolean;
  previews: { mode: string; fileName: string }[];
  commits: number;
  imports: Json[];
  /** Commit, then drop the answer. */ loseNextCommitAnswer: boolean;
  suppliers: Supplier[];
  supplierCalls: { method: string; path: string; body: Json | null }[];
  /** Create the supplier, then drop the answer. */ loseNextSupplierAnswer: boolean;
  returns: Json[];
}

const PREVIEW_ROWS = [
  { rowIndex: 2, medicineName: 'Paracetamol', status: 'valid', data: { name: 'Paracetamol', quantityToAdd: 50, batchNumber: 'PCM-77', expiryDate: '20280131', mrp: 25, retailPrice: 22, medicineId: MED, medicineMatchStatus: 'matched', matchedMedicineName: 'Paracetamol' } },
  { rowIndex: 3, medicineName: 'Zincovit', status: 'valid', data: { name: 'Zincovit', quantityToAdd: 20, batchNumber: 'ZV-1', expiryDate: '20271231', mrp: 110, retailPrice: 105, medicineMatchStatus: 'not_found' } },
  { rowIndex: 4, medicineName: 'Cetirizine', status: 'error', errors: ['expiry date must be a valid YYYYMMDD date'] },
];

async function mockBackend(page: Page, init: { suppliers?: Supplier[] } = {}): Promise<Backend> {
  const state: Backend = {
    stockPosts: [], adjustments: [], loseNextStockAnswer: false, refuseNextStock: false, previews: [], commits: 0, imports: [],
    loseNextCommitAnswer: false, suppliers: init.suppliers ?? [], supplierCalls: [], loseNextSupplierAnswer: false, returns: [],
  };
  const batches: Json[] = [{ _id: BATCH, batchNumber: 'PCM-A', expiryDate: '20990101', availableQty: 10, reservedQty: 0, status: 'active' }];
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const refuse = (route: Route, status: number, code: string, message: string) => json(route, status, { error: status, code, message });
  const pageOf = (route: Route, items: unknown[], page = 1, limit = 20) =>
    json(route, 200, { success: true, data: items.slice((page - 1) * limit, page * limit), pagination: { page, limit, total: items.length, totalPages: Math.max(1, Math.ceil(items.length / limit)) } });
  const medicines = [{ _id: MED, name: 'Paracetamol', strength: '650mg', dosageForm: 'tablet', manufacturer: 'Cipla' }, { _id: MED2, name: 'Pantoprazole', strength: '40mg' }];

  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = req.method();
    const body = (method === 'POST' || method === 'PATCH') && !path.endsWith('/preview') ? (req.postDataJSON() as Json | null) : null;
    if (path === '/auth/pharmacy/send') return json(route, 200, { success: true });
    if (path === '/auth/pharmacy/verify') return json(route, 200, { success: true, data: { token: 't1', user: {} } });
    if (req.headers().authorization !== 'Bearer t1') return refuse(route, 401, 'UNAUTHORIZED', 'Authentication is required');
    if (path === '/auth/profile') return json(route, 200, { success: true, data: { user: { _id: ME, name: 'Asha Medicals' }, userRole: 'pharmacy' } });
    const pg = Number(url.searchParams.get('page') ?? 1);
    const lim = Number(url.searchParams.get('limit') ?? 20);

    // ── Stock ──
    if (path === '/pharmacy-inventory' && method === 'GET') {
      return pageOf(route, [{ _id: ITEM, medicineId: medicines[0], availableQty: 10, reservedQty: 0, reorderThreshold: 5, batches }]);
    }
    if (path === '/pharmacy-medicines') {
      expect(url.searchParams.get('isActive')).toBe('true');
      const s = (url.searchParams.get('search') ?? '').toLowerCase();
      return pageOf(route, medicines.filter((m) => m.name.toLowerCase().includes(s)), pg, lim);
    }
    const med = /^\/pharmacy-medicines\/(\w{24})$/.exec(path);
    if (med) return json(route, 200, { success: true, data: medicines.find((m) => m._id === med[1]) });
    if (path === '/pharmacy-inventory' && method === 'POST') {
      state.stockPosts.push(body!);
      if (state.refuseNextStock) { state.refuseNextStock = false; return refuse(route, 404, 'MEDICINE_NOT_FOUND', 'Medicine not found'); }
      const it = (body!.items as Json[])[0]!;
      state.adjustments.unshift({ _id: String(state.adjustments.length + 1).padStart(24, '7'), medicineId: { _id: it.medicineId, name: 'Paracetamol' },
        adjustmentType: 'add', quantity: it.quantity, batchNumber: String(it.batchNumber).toUpperCase(), expiryDate: it.expiryDate,
        sourceType: 'manual', reason: it.reason, notes: it.notes, createdAt: new Date().toISOString() });
      if (state.loseNextStockAnswer) { state.loseNextStockAnswer = false; return route.abort('connectionreset'); }
      return json(route, 201, { success: true, data: [{ _id: ITEM }] });
    }
    if (path === '/pharmacy-inventory/adjustments') return pageOf(route, state.adjustments, pg, lim);

    // ── Imports ──
    if (path === '/pharmacy-inventory-imports/preview') {
      const raw = req.postDataBuffer()?.toString('latin1') ?? '';
      const mode = /name="importMode"\r\n\r\n([a-z_]+)/.exec(raw)?.[1] ?? '';
      const fileName = /name="file"; filename="([^"]+)"/.exec(raw)?.[1] ?? '';
      state.previews.push({ mode, fileName });
      const rec = { _id: IMP, fileName, importMode: mode, status: 'previewed', totalRows: 3, validRows: 2, errorRows: 1, previewRows: PREVIEW_ROWS,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      state.imports = [rec];
      return json(route, 200, { success: true, data: rec });
    }
    if (path === '/pharmacy-inventory-imports/commit') {
      state.commits += 1;
      const rec = state.imports.find((r) => r._id === body?.importId);
      if (!rec) return refuse(route, 404, 'IMPORT_NOT_FOUND', 'Import record not found');
      if (rec.status !== 'previewed') return refuse(route, 409, 'IMPORT_NOT_RETRYABLE', 'Import is already committed or currently being processed');
      Object.assign(rec, {
        status: 'partially_committed', committedRows: 2, failedRows: 1, committedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        previewRows: PREVIEW_ROWS.map((r) => (r.status === 'valid' ? { ...r, status: 'committed' } : r)),
      });
      if (state.loseNextCommitAnswer) { state.loseNextCommitAnswer = false; return route.abort('connectionreset'); }
      return json(route, 200, { success: true, data: rec });
    }
    if (path === '/pharmacy-inventory-imports') return pageOf(route, state.imports, pg, lim);
    if (path === `/pharmacy-inventory-imports/${IMP}/failed-rows/download`) {
      return route.fulfill({ status: 200, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: Buffer.from('PK\u0003\u0004fake') });
    }
    if (path === `/pharmacy-inventory-imports/${IMP}`) {
      const rec = state.imports.find((r) => r._id === IMP);
      return rec ? json(route, 200, { success: true, data: rec }) : refuse(route, 404, 'IMPORT_NOT_FOUND', 'Import record not found');
    }

    // ── Suppliers (repository rules: revision fence, archived cannot change, lower-case ids) ──
    if (path.startsWith('/pharmacy-suppliers')) {
      if (method !== 'GET') state.supplierCalls.push({ method, path, body });
      if (path === '/pharmacy-suppliers' && method === 'GET') {
        const st = url.searchParams.get('state') ?? 'active';
        return pageOf(route, state.suppliers.filter((s) => st === 'all' || s.state === st), pg, lim);
      }
      if (path === '/pharmacy-suppliers' && method === 'POST') {
        const s: Supplier = { supplierId: String(state.suppliers.length + 1).padStart(24, 'e'), displayName: String(body!.displayName),
          contactName: body!.contactName ?? null, phone: body!.phone ?? null, email: body!.email ?? null, address: body!.address ?? null,
          state: 'active', revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), archivedAt: null };
        state.suppliers.push(s);
        if (state.loseNextSupplierAnswer) { state.loseNextSupplierAnswer = false; return route.abort('connectionreset'); }
        return json(route, 201, { success: true, data: s });
      }
      const m = /^\/pharmacy-suppliers\/([0-9a-f]{24})(\/archive)?$/.exec(path);
      const s = m && state.suppliers.find((x) => x.supplierId === m[1]);
      if (!s) return refuse(route, 404, 'SUPPLIER_NOT_FOUND', 'Supplier not found');
      if (m![2]) {
        if (s.state === 'archived') return json(route, 200, { success: true, data: s });
        if (s.revision !== body!.expectedRevision) return refuse(route, 409, 'SUPPLIER_CONFLICT', 'Supplier changed');
        Object.assign(s, { state: 'archived', archivedAt: new Date().toISOString(), revision: s.revision + 1 });
        return json(route, 200, { success: true, data: s });
      }
      if (s.state === 'archived' || s.revision !== body!.expectedRevision) return refuse(route, 409, 'SUPPLIER_CONFLICT', 'Supplier changed');
      const { expectedRevision: _r, ...fields } = body!;
      Object.assign(s, fields, { revision: s.revision + 1 });
      return json(route, 200, { success: true, data: s });
    }
    if (path === `/pharmacy-inventory/${ITEM}/batches/${BATCH}/supplier-return`) {
      if (!state.suppliers.some((s) => s.supplierId === body!.supplierId && s.state === 'active')) return refuse(route, 404, 'SUPPLIER_NOT_FOUND', 'Supplier not found');
      const rec = { _id: '9'.repeat(24), supplierId: body!.supplierId, batchNumber: 'PCM-A', quantity: body!.quantity, reason: body!.reason, requestKey: body!.requestKey, createdAt: new Date().toISOString() };
      state.returns.push(rec);
      (batches[0] as { availableQty: number }).availableQty -= Number(body!.quantity);
      return json(route, 201, { success: true, data: rec });
    }
    if (path === '/pharmacy-inventory/supplier-returns') return pageOf(route, state.returns);
    return refuse(route, 404, 'NOT_FOUND', 'Not found');
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

async function fillBatch(page: Page, units = '100') {
  await page.getByLabel('Batch number').fill('pcm-24b');
  await page.getByLabel('Expiry date').fill('2028-06-30');
  await page.getByLabel('Units received').fill(units);
  await page.getByLabel('MRP per unit (₹, optional)').fill('25.50');
  await page.getByLabel('Note (optional)').fill('Bill 7781');
}

const supplier = (o: Partial<Supplier>): Supplier => ({
  supplierId: '5'.repeat(24), displayName: 'Sun Distributors', contactName: 'Ravi', phone: null, email: null, address: null, state: 'active',
  revision: 1, createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z', archivedAt: null, ...o,
});

test('add stock: find the medicine, fill in the batch, check and confirm; one item is sent with its reference', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page, 'Stock');
  await page.getByRole('link', { name: 'Add stock' }).click();
  await expect(page.getByRole('heading', { name: 'Add stock' })).toBeVisible();
  await page.getByRole('button', { name: 'Check and add' }).click();
  await expect(page.getByText('Choose the medicine.')).toBeVisible();
  await expect(page.getByText('Enter the batch number printed on the pack.')).toBeVisible();
  await page.getByLabel('Find the medicine').fill('para');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('button', { name: 'Choose Paracetamol 650mg' }).click();
  await fillBatch(page);
  await page.getByLabel('Expiry date').fill('2020-01-01');
  await page.getByRole('button', { name: 'Check and add' }).click();
  await expect(page.getByText('This batch has expired. Expired stock cannot be added.')).toBeVisible();
  await page.getByLabel('Expiry date').fill('2028-06-30');
  await page.getByRole('button', { name: 'Check and add' }).click();
  const review = page.getByRole('group', { name: 'Add this stock' });
  await expect(review).toContainText('Add 100 units of Paracetamol 650mg, batch PCM-24B (expires 30 Jun 2028)?');
  await expect(review).toContainText('MRP ₹25.50');
  expect(backend.stockPosts).toHaveLength(0); // nothing is sent before the second step
  await review.getByRole('button', { name: 'Yes, add to stock' }).click();
  await expect(page.getByText('Added 100 units of Paracetamol 650mg, batch PCM-24B (expires 30 Jun 2028).')).toBeVisible();
  expect(backend.stockPosts).toHaveLength(1);
  const item = (backend.stockPosts[0]!.items as Json[])[0]!;
  expect(item).toMatchObject({ medicineId: MED, quantity: 100, batchNumber: 'pcm-24b', expiryDate: '20280630', reason: 'purchase', mrp: 25.5 });
  expect(String(item.notes)).toMatch(/^Bill 7781 · Ref [0-9a-f]{32}$/);
  await expect(page.getByLabel('Batch number')).toHaveValue(''); // ready for the next batch
  // Nothing about the entry is left in browser storage.
  expect(await page.evaluate(() => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }))).not.toContain('7781');
});

test('add stock from a medicine on the Stock page; a refusal records nothing and keeps the form', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page, 'Stock');
  await page.getByRole('link', { name: 'Add a batch of Paracetamol 650mg' }).click();
  await expect(page.getByText('Paracetamol 650mg', { exact: true })).toBeVisible();
  await fillBatch(page, '12');
  backend.refuseNextStock = true;
  await page.getByRole('button', { name: 'Check and add' }).click();
  await page.getByRole('button', { name: 'Yes, add to stock' }).click();
  await expect(page.getByText('Not added: Medicine not found')).toBeVisible();
  await expect(page.getByLabel('Units received')).toHaveValue('12');
  await expect(page.getByRole('group', { name: 'Unconfirmed stock entry' })).toHaveCount(0);
  // The next try is a new request with a new reference.
  await page.getByRole('button', { name: 'Check and add' }).click();
  await page.getByRole('button', { name: 'Yes, add to stock' }).click();
  await expect(page.getByText(/^Added 12 units/)).toBeVisible();
  const refs = backend.stockPosts.map((p) => String((p.items as Json[])[0]!.notes));
  expect(new Set(refs).size).toBe(2);
});

test('add stock whose answer is lost is never resent: it is found in the stock history by its reference', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page, 'Stock');
  await page.getByRole('link', { name: 'Add stock' }).click();
  await page.getByLabel('Find the medicine').fill('para');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('button', { name: 'Choose Paracetamol 650mg' }).click();
  await fillBatch(page);
  backend.loseNextStockAnswer = true;
  await page.getByRole('button', { name: 'Check and add' }).click();
  await page.getByRole('button', { name: 'Yes, add to stock' }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed stock entry' });
  await expect(panel).toContainText('The units may already be in stock. Sending it again could count them twice, so check first.');
  await expect(panel).toContainText('100 units of Paracetamol 650mg, batch PCM-24B');
  await expect(panel.getByRole('button', { name: /again/i })).toHaveCount(0); // no resend
  // Leaving and coming back keeps it unresolved.
  await page.getByRole('link', { name: 'Stock', exact: true }).first().click();
  await page.getByRole('link', { name: 'Add stock' }).click();
  await panel.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(page.getByText(/^Recorded: 100 units of batch PCM-24B were added/)).toBeVisible();
  expect(backend.stockPosts).toHaveLength(1);
});

test('add stock lost before it reached the server: not found, and forgetting needs a second step', async ({ page }) => {
  const backend = await mockBackend(page);
  await page.route('**/api/v1/pharmacy-inventory', (route) => (route.request().method() === 'POST' ? route.abort('connectionreset') : route.fallback()));
  await signIn(page, 'Stock');
  await page.getByRole('link', { name: 'Add a batch of Paracetamol 650mg' }).click();
  await fillBatch(page);
  await page.getByRole('button', { name: 'Check and add' }).click();
  await page.getByRole('button', { name: 'Yes, add to stock' }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed stock entry' });
  await expect(panel.getByRole('button', { name: 'Forget it and add again' })).toHaveCount(0); // look first
  await panel.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(panel).toContainText('Not in the stock history yet.');
  await panel.getByRole('button', { name: 'Forget it and add again' }).click();
  await expect(panel).toContainText('the units are counted twice');
  await panel.getByRole('button', { name: 'Forget it', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check and add' })).toBeVisible();
  expect(backend.stockPosts).toHaveLength(0);
});

test('import: the columns and a template, the file is checked, problems first, confirm adds the ready rows; history lists it', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page, 'Stock');
  await page.getByRole('link', { name: 'Import stock from a file' }).click();
  await expect(page.getByRole('heading', { name: 'Import stock from a file' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'medicine name', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'expiry date', exact: true })).toBeVisible();
  await expect(page.getByText('No imports yet')).toBeVisible();
  const template = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download a blank template (CSV)' }).click();
  expect((await template).suggestedFilename()).toBe('stock-import-template.csv');

  await page.getByRole('button', { name: 'Check the file' }).click();
  await expect(page.getByText('Choose the file to import.')).toBeVisible();
  await page.getByLabel('Stock file').setInputFiles({ name: 'notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF') });
  await page.getByRole('button', { name: 'Check the file' }).click();
  await expect(page.getByText('Use an Excel (.xlsx, .xls) or CSV (.csv) file.')).toBeVisible();
  expect(backend.previews).toHaveLength(0);

  await page.getByLabel('Only medicines already in my stock').check();
  await page.getByLabel('Stock file').setInputFiles({ name: 'nov-stock.csv', mimeType: 'text/csv', buffer: Buffer.from('medicine name,quantity to add\nParacetamol,50\n') });
  await page.getByRole('button', { name: 'Check the file' }).click();
  await expect(page.getByRole('heading', { name: 'Import of nov-stock.csv' })).toBeVisible();
  expect(backend.previews).toEqual([{ mode: 'update_only', fileName: 'nov-stock.csv' }]);
  await expect(page.getByText('Checked, not added yet')).toBeVisible();
  // Problems first.
  const rows = page.getByRole('table', { name: 'Rows of the file, problems first' }).getByRole('row');
  await expect(rows.nth(1)).toContainText('Cetirizine');
  await expect(rows.nth(1)).toContainText('expiry date must be a valid YYYYMMDD date');
  await expect(page.getByRole('row').filter({ hasText: 'Zincovit' })).toContainText('New: will be added to the list');
  const problems = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download the rows with problems' }).click();
  expect((await problems).suggestedFilename()).toBe('problems-nov-stock.xlsx');

  await page.getByRole('button', { name: 'Add 2 ready rows to stock…' }).click();
  await expect(page.getByText('70 units in 2 rows go on sale at once.', { exact: false })).toBeVisible();
  await expect(page.getByText('1 medicine is not in the medicine list yet and will be added to it.', { exact: false })).toBeVisible();
  expect(backend.commits).toBe(0);
  await page.getByRole('button', { name: 'Yes, add them' }).click();
  await expect(page.getByText('Partly done: 2 rows were added; 1 were not. See the rows below.')).toBeVisible();
  await expect(page.getByText('Partly added').first()).toBeVisible();
  expect(backend.commits).toBe(1);
  await page.getByRole('link', { name: 'Import stock' }).click();
  const listed = page.getByRole('row').filter({ hasText: 'nov-stock.csv' });
  await expect(listed).toContainText('Partly added');
  await expect(listed).toContainText('3 (2 ready, 1 with problems)');
  // The file's contents never reach browser storage.
  expect(await page.evaluate(() => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }))).not.toMatch(/Paracetamol,50|nov-stock/);
});

test('import: a confirmation whose answer is lost is settled from the import as saved; sending again is safe', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page, 'Stock');
  await page.getByRole('link', { name: 'Import stock from a file' }).click();
  await page.getByLabel('Stock file').setInputFiles({ name: 'stock.xlsx', mimeType: 'application/octet-stream', buffer: Buffer.from('PK') });
  await page.getByRole('button', { name: 'Check the file' }).click();
  backend.loseNextCommitAnswer = true;
  await page.getByRole('button', { name: 'Add 2 ready rows to stock…' }).click();
  await page.getByRole('button', { name: 'Yes, add them' }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed import step' });
  await expect(panel).toContainText('The rows may already be added.');
  // Sending again meets the first commit (409): the import as saved settles it.
  await panel.getByRole('button', { name: 'Send it again' }).click();
  await expect(page.getByText('Partly done: 2 rows were added; 1 were not.', { exact: false })).toBeVisible();
  await expect(panel).toHaveCount(0);
  expect(backend.commits).toBe(2);
});

test('suppliers: add, edit naming the revision, an edit that met another change keeps what was typed, archive with a second step', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page, 'Suppliers');
  await expect(page.getByText('No suppliers yet')).toBeVisible();
  await page.getByRole('button', { name: 'Add a supplier' }).click();
  await page.getByLabel('Phone (optional)').fill('98765#43210');
  await page.getByRole('button', { name: 'Add supplier' }).click();
  await expect(page.getByText('Enter the supplier’s name.')).toBeVisible();
  await expect(page.getByText('Use digits, spaces and + ( ) . - only.')).toBeVisible();
  await page.getByLabel('Supplier name').fill('Sun Distributors');
  await page.getByLabel('Phone (optional)').fill('+91 98765 43210');
  await page.getByLabel('Email (optional)').fill('orders@sun.in');
  await page.getByRole('button', { name: 'Add supplier' }).click();
  await expect(page.getByText('Sun Distributors was added.')).toBeVisible();
  expect(backend.supplierCalls[0]!.body).toEqual({ displayName: 'Sun Distributors', phone: '+91 98765 43210', email: 'orders@sun.in' });
  const row = page.getByRole('row').filter({ hasText: 'Sun Distributors' });
  await expect(row).toContainText('orders@sun.in');

  await row.getByRole('button', { name: 'Edit Sun Distributors' }).click();
  await page.getByLabel('Contact person (optional)').fill('Ravi');
  await page.getByLabel('Email (optional)').fill('');
  // Someone else saves first (revision 1 → 2): a new address, and a different contact person.
  Object.assign(backend.suppliers[0]!, { address: 'Patna', contactName: 'Mohan', revision: 2 });
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Someone changed this supplier meanwhile (Contact person: now “Mohan”). Your value is kept below', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Contact person (optional)')).toHaveValue('Ravi');
  await expect(page.getByLabel('Address (optional)')).toHaveValue('Patna'); // untouched here: their value is taken
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Sun Distributors was saved.')).toBeVisible();
  const edits = backend.supplierCalls.filter((c) => c.method === 'PATCH').map((c) => c.body);
  expect(edits).toEqual([
    { contactName: 'Ravi', email: null, expectedRevision: 1 },
    { contactName: 'Ravi', email: null, expectedRevision: 2 },
  ]);

  await row.getByRole('button', { name: 'Archive Sun Distributors' }).click();
  await expect(page.getByText('is no longer offered for returns', { exact: false })).toBeVisible();
  Object.assign(backend.suppliers[0]!, { phone: '0612 222', revision: 4 }); // changed elsewhere while the confirmation is open
  await page.getByRole('button', { name: 'Yes, archive' }).click();
  await expect(page.getByText('Sun Distributors was changed meanwhile. Check it and archive it again.')).toBeVisible();
  await expect(row).toContainText('0612 222');
  await page.getByRole('button', { name: 'Yes, archive' }).click();
  await expect(page.getByText('Sun Distributors is archived.')).toBeVisible();
  expect(backend.supplierCalls.filter((c) => c.path.endsWith('/archive')).map((c) => c.body)).toEqual([{ expectedRevision: 3 }, { expectedRevision: 4 }]);
  await expect(page.getByText('No suppliers yet')).toBeVisible();
  await page.getByLabel('Show').selectOption('archived');
  await expect(page.getByRole('row').filter({ hasText: 'Sun Distributors' })).toContainText('Archived');
});

test('suppliers: an add whose answer is lost is found in the list by its name, never added twice', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page, 'Suppliers');
  backend.loseNextSupplierAnswer = true;
  await page.getByRole('button', { name: 'Add a supplier' }).click();
  await page.getByLabel('Supplier name').fill('Moon Pharma');
  await page.getByRole('button', { name: 'Add supplier' }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed supplier change' });
  await expect(panel).toContainText('Add Moon Pharma: the answer did not arrive');
  await expect(page.getByRole('button', { name: 'Add a supplier' })).toBeDisabled();
  await panel.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(page.getByText('Moon Pharma was added.')).toBeVisible();
  await expect(panel).toHaveCount(0);
  expect(backend.supplierCalls.filter((c) => c.method === 'POST')).toHaveLength(1);
});

test('return to supplier: with no supplier it links to Suppliers; once one is added it is offered and used', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page, 'Stock');
  await page.getByRole('button', { name: 'Return to supplier…' }).click();
  await expect(page.getByText('Returns go to one of your active suppliers, and you have none yet.')).toBeVisible();
  await page.getByRole('link', { name: 'Add a supplier' }).click();
  await expect(page.getByRole('heading', { name: 'Suppliers', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add a supplier' }).click();
  await page.getByLabel('Supplier name').fill('Sun Distributors');
  await page.getByRole('button', { name: 'Add supplier' }).click();
  await expect(page.getByText('Sun Distributors was added.')).toBeVisible();

  await page.getByRole('link', { name: 'Stock', exact: true }).first().click();
  await page.getByRole('button', { name: 'Return to supplier…' }).click();
  await page.getByLabel('Supplier', { exact: true }).selectOption({ label: 'Sun Distributors' });
  await page.getByLabel('Units').fill('3');
  await page.getByRole('button', { name: 'Record supplier return' }).click();
  await expect(page.getByText('Recorded: 3 units of batch PCM-A returned', { exact: false })).toBeVisible();
  expect(backend.returns[0]).toMatchObject({ supplierId: backend.suppliers[0]!.supplierId, quantity: 3 });
});
