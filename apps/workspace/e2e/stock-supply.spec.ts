import { expect, test, type Page, type Route } from '@playwright/test';

// WQ10a: add stock, import a stock file, suppliers, and return to a supplier — against a mock of the backend's rules
// (pharmacyInventory, pharmacyInventoryImports, pharmacySuppliers). WQ10c (Q15): stock saves and supplier adds are keyed
// (`requestKey`; a repeat answers 200 `replayed: true`; `by-key` lookups), and a keyed write can meet 503 INDEXES_OUTDATED.
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
  /** Q15 keys: what each stock save and supplier add made, bound to its content. */
  stockKeys: Record<string, { hash: string; ids: string[] }>;
  supplierKeys: Record<string, { hash: string; id: string }>;
  /** The next keyed write is refused 503 INDEXES_OUTDATED (the database's indexes are not synced yet). */
  indexesOutdated: boolean;
  /** Q15 abandoned keys (stock saves and supplier adds): a later send with one is 409 REQUEST_ABANDONED. */
  abandoned: Set<string>;
  /** The replay of a stock save answers this many ms late (a resend in flight). */
  slowReplayMs: number;
  /** The next file check / retry is lost before it reaches the server. */
  loseNextPreview: boolean;
  loseNextRetry: boolean;
  retries: number;
  /** The next supplier edit is refused 400 (a definite refusal that is not a version conflict). */
  refuseNextSupplierEdit: boolean;
}

const INDEXES_OUTDATED = 'The database needs an update (sync-indexes) before this can be used';

/** Q15 review: the server's row error for an expiry in no accepted form. */
const EXPIRY_ERROR = 'expiry date must be a valid date: YYYYMMDD, YYYY-MM-DD, DD-MM-YYYY, DD/MM/YYYY, or MM/YYYY / MM-YYYY (the last day of that month)';
const PREVIEW_ROWS = [
  { rowIndex: 2, medicineName: 'Paracetamol', status: 'valid', data: { name: 'Paracetamol', quantityToAdd: 50, batchNumber: 'PCM-77', expiryDate: '20280131', mrp: 25, retailPrice: 22, medicineId: MED, medicineMatchStatus: 'matched', matchedMedicineName: 'Paracetamol' } },
  { rowIndex: 3, medicineName: 'Zincovit', status: 'valid', data: { name: 'Zincovit', quantityToAdd: 20, batchNumber: 'ZV-1', expiryDate: '20271231', mrp: 110, retailPrice: 105, medicineMatchStatus: 'not_found' } },
  { rowIndex: 4, medicineName: 'Cetirizine', status: 'error', errors: [EXPIRY_ERROR] },
];

async function mockBackend(page: Page, init: { suppliers?: Supplier[]; imports?: Json[] } = {}): Promise<Backend> {
  const state: Backend = {
    stockPosts: [], adjustments: [], loseNextStockAnswer: false, refuseNextStock: false, previews: [], commits: 0, imports: [],
    loseNextCommitAnswer: false, suppliers: init.suppliers ?? [], supplierCalls: [], loseNextSupplierAnswer: false, returns: [],
    stockKeys: {}, supplierKeys: {}, indexesOutdated: false, abandoned: new Set(), slowReplayMs: 0, loseNextPreview: false, loseNextRetry: false,
    retries: 0, refuseNextSupplierEdit: false,
  };
  state.imports = init.imports ?? [];
  let live = false;
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
    if (path === '/auth/pharmacy/verify') { live = true; return json(route, 200, { success: true, data: { token: 't1', expiresIn: 900, user: {} } }); }
    // A reload renews the web session (D4), so a stored body-less marker comes back for the same pharmacy.
    if (path === '/auth/session/refresh') {
      return live ? json(route, 200, { success: true, data: { token: 't1', expiresIn: 900, principal: { userId: ME, userType: 'pharmacy', sid: 's1' } } })
        : refuse(route, 401, 'SESSION_ENDED', 'Please sign in again');
    }
    if (path.startsWith('/auth/session')) return json(route, 200, { success: true, data: {} });
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
    const stockByKey = /^\/pharmacy-inventory\/by-key\/([A-Za-z0-9_-]{8,100})$/.exec(path);
    const stockAbandon = /^\/pharmacy-inventory\/by-key\/([A-Za-z0-9_-]{8,100})\/abandon$/.exec(path);
    if (stockAbandon && method === 'POST') {
      const key = stockAbandon[1]!;
      if (state.stockKeys[key]) return json(route, 200, { success: true, data: { state: 'used', items: [{ _id: ITEM, medicineId: medicines[0], availableQty: 110, reservedQty: 0 }] } });
      state.abandoned.add(key);
      return json(route, 200, { success: true, data: { state: 'abandoned' } });
    }
    if (stockByKey && method === 'GET') {
      const k = state.stockKeys[stockByKey[1]!];
      return k ? json(route, 200, { success: true, data: [{ _id: ITEM, medicineId: medicines[0], availableQty: 110, reservedQty: 0 }] })
        : refuse(route, 404, 'REQUEST_KEY_NOT_FOUND', 'Nothing was saved with this key');
    }
    if (path === '/pharmacy-inventory' && method === 'POST') {
      state.stockPosts.push(body!);
      const key = body!.requestKey as string | undefined;
      const hash = JSON.stringify(body!.items);
      if (key && state.abandoned.has(key)) return refuse(route, 409, 'REQUEST_ABANDONED', 'This request was cancelled before it was recorded; make a new one');
      if (key && state.stockKeys[key]) {
        if (state.stockKeys[key]!.hash !== hash) return refuse(route, 409, 'REQUEST_KEY_REUSED', 'This request key was already used for different inventory items');
        if (state.slowReplayMs) await new Promise((r) => setTimeout(r, state.slowReplayMs));
        return json(route, 200, { success: true, message: 'Inventory items saved', data: [{ _id: ITEM, medicineId: medicines[0], availableQty: 110 }], replayed: true });
      }
      if (key && state.indexesOutdated) { state.indexesOutdated = false; return refuse(route, 503, 'INDEXES_OUTDATED', INDEXES_OUTDATED); }
      if (state.refuseNextStock) { state.refuseNextStock = false; return refuse(route, 404, 'MEDICINE_NOT_FOUND', 'Medicine not found'); }
      const it = (body!.items as Json[])[0]!;
      if (key) state.stockKeys[key] = { hash, ids: [ITEM] };
      state.adjustments.unshift({ _id: String(state.adjustments.length + 1).padStart(24, '7'), medicineId: { _id: it.medicineId, name: 'Paracetamol' },
        adjustmentType: 'add', quantity: it.quantity, batchNumber: String(it.batchNumber).toUpperCase(), expiryDate: it.expiryDate,
        sourceType: 'manual', reason: it.reason, notes: it.notes, createdAt: new Date().toISOString() });
      if (state.loseNextStockAnswer) { state.loseNextStockAnswer = false; return route.abort('connectionreset'); }
      return json(route, 201, { success: true, data: [{ _id: ITEM, medicineId: medicines[0], availableQty: 110 }] });
    }
    if (path === '/pharmacy-inventory/adjustments') return pageOf(route, state.adjustments, pg, lim);

    // ── Imports ──
    if (path === '/pharmacy-inventory-imports/preview') {
      if (state.loseNextPreview) { state.loseNextPreview = false; return route.abort('connectionreset'); }
      const raw = req.postDataBuffer()?.toString('latin1') ?? '';
      const mode = /name="importMode"\r\n\r\n([a-z_]+)/.exec(raw)?.[1] ?? '';
      const fileName = /name="file"; filename="([^"]+)"/.exec(raw)?.[1] ?? '';
      state.previews.push({ mode, fileName });
      const rec = { _id: IMP, fileName, importMode: mode, status: 'previewed', totalRows: 3, validRows: 2, errorRows: 1, previewRows: PREVIEW_ROWS,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      state.imports = [rec, ...state.imports.filter((r) => r._id !== IMP)];
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
    const retry = /^\/pharmacy-inventory-imports\/(\w{24})\/retry$/.exec(path);
    if (retry && method === 'POST') {
      if (state.loseNextRetry) { state.loseNextRetry = false; return route.abort('connectionreset'); }
      state.retries += 1;
      const rec = state.imports.find((r) => r._id === retry[1]);
      if (!rec) return refuse(route, 404, 'IMPORT_NOT_FOUND', 'Import record not found');
      // commit(…, true): failed / partly added, or (staleCommitting) stuck in committing for over 15 minutes.
      const stale = rec.status === 'committing' && Date.parse(String(rec.updatedAt)) < Date.now() - 15 * 60_000;
      if (!stale && !['failed', 'partially_committed'].includes(String(rec.status))) return refuse(route, 409, 'IMPORT_NOT_RETRYABLE', 'Only failed or partially committed imports can be retried');
      const rows = (rec.previewRows as Json[]).map((r) => (r.status === 'failed' || (stale && r.status === 'valid') ? { ...r, status: 'committed', errors: undefined } : r));
      const committedRows = rows.filter((r) => r.status === 'committed').length;
      const unresolved = rows.filter((r) => r.status === 'error' || r.status === 'failed').length;
      Object.assign(rec, { previewRows: rows, committedRows, failedRows: unresolved, status: unresolved ? 'partially_committed' : 'committed',
        committedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      return json(route, 200, { success: true, data: rec });
    }
    const oneImport = /^\/pharmacy-inventory-imports\/(\w{24})$/.exec(path);
    if (oneImport) {
      const rec = state.imports.find((r) => r._id === oneImport[1]);
      return rec ? json(route, 200, { success: true, data: rec }) : refuse(route, 404, 'IMPORT_NOT_FOUND', 'Import record not found');
    }

    // ── Suppliers (repository rules: revision fence, archived cannot change, lower-case ids) ──
    if (path.startsWith('/pharmacy-suppliers')) {
      if (method !== 'GET') state.supplierCalls.push({ method, path, body });
      if (path === '/pharmacy-suppliers' && method === 'GET') {
        const st = url.searchParams.get('state') ?? 'active';
        return pageOf(route, state.suppliers.filter((s) => st === 'all' || s.state === st), pg, lim);
      }
      const supAbandon = /^\/pharmacy-suppliers\/by-key\/([A-Za-z0-9_-]{8,100})\/abandon$/.exec(path);
      if (supAbandon && method === 'POST') {
        const k = state.supplierKeys[supAbandon[1]!];
        if (k) return json(route, 200, { success: true, data: { state: 'used', supplier: state.suppliers.find((x) => x.supplierId === k.id) } });
        state.abandoned.add(supAbandon[1]!);
        return json(route, 200, { success: true, data: { state: 'abandoned' } });
      }
      const supByKey = /^\/pharmacy-suppliers\/by-key\/([A-Za-z0-9_-]{8,100})$/.exec(path);
      if (supByKey && method === 'GET') {
        const k = state.supplierKeys[supByKey[1]!];
        const made = k && state.suppliers.find((x) => x.supplierId === k.id);
        return made ? json(route, 200, { success: true, data: made }) : refuse(route, 404, 'SUPPLIER_NOT_FOUND', 'No supplier was created with this key');
      }
      if (path === '/pharmacy-suppliers' && method === 'POST') {
        const { requestKey: key, ...fields } = body! as Json & { requestKey?: string };
        const hash = JSON.stringify(fields);
        if (key && state.abandoned.has(key)) return refuse(route, 409, 'REQUEST_ABANDONED', 'This request was cancelled before it was recorded; make a new one');
        if (key && state.supplierKeys[key]) {
          if (state.supplierKeys[key]!.hash !== hash) return refuse(route, 409, 'REQUEST_KEY_REUSED', 'This request key was already used for a different supplier');
          return json(route, 200, { success: true, data: state.suppliers.find((x) => x.supplierId === state.supplierKeys[key]!.id), replayed: true });
        }
        if (key && state.indexesOutdated) { state.indexesOutdated = false; return refuse(route, 503, 'INDEXES_OUTDATED', INDEXES_OUTDATED); }
        const s: Supplier = { supplierId: String(state.suppliers.length + 1).padStart(24, 'e'), displayName: String(body!.displayName),
          contactName: body!.contactName ?? null, phone: body!.phone ?? null, email: body!.email ?? null, address: body!.address ?? null,
          state: 'active', revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), archivedAt: null };
        state.suppliers.push(s);
        if (key) state.supplierKeys[key] = { hash, id: s.supplierId };
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
      if (state.refuseNextSupplierEdit) { state.refuseNextSupplierEdit = false; return refuse(route, 400, 'VALIDATION_ERROR', 'Invalid supplier request'); }
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

test('add stock: find the medicine, fill in the batch, check and confirm; one item is sent with its request key', async ({ page }) => {
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
  expect(item.notes).toBe('Bill 7781'); // Q15: the key travels beside the item, not in the note
  expect(backend.stockPosts[0]!.requestKey).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
  expect(Object.keys(backend.stockPosts[0]!).sort()).toEqual(['items', 'requestKey']); // no supplier on stock rows
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
  // The next try is a new request with a new key.
  await page.getByRole('button', { name: 'Check and add' }).click();
  await page.getByRole('button', { name: 'Yes, add to stock' }).click();
  await expect(page.getByText(/^Added 12 units/)).toBeVisible();
  expect(new Set(backend.stockPosts.map((p) => p.requestKey)).size).toBe(2);
});

test('WQ10c: add stock whose answer is lost is found by its key after leaving and coming back; nothing is added twice', async ({ page }) => {
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
  await expect(panel).toContainText('The units may already be in stock. Sending the same entry again is safe: it is never added twice.');
  await expect(panel).toContainText('100 units of Paracetamol 650mg, batch PCM-24B');
  // Leaving and coming back keeps it unresolved.
  await page.getByRole('link', { name: 'Stock', exact: true }).first().click();
  await page.getByRole('link', { name: 'Add stock' }).click();
  await panel.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(page.getByText('Recorded: 100 units of Paracetamol 650mg, batch PCM-24B (expires 30 Jun 2028) was added. Nothing was added twice.')).toBeVisible();
  await expect(panel).toHaveCount(0);
  // Review P1: the form is cleared as after a plain success, so the same batch is not added again under a new key.
  await expect(page.getByLabel('Batch number')).toHaveValue('');
  await expect(page.getByLabel('Units received')).toHaveValue('');
  expect(backend.stockPosts).toHaveLength(1);
  expect(backend.adjustments).toHaveLength(1);
  const key = String(backend.stockPosts[0]!.requestKey);
  expect(await page.evaluate(() => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }))).not.toContain('7781');
  expect(key).toMatch(/^[0-9a-f]{32}$/);
});

test('WQ10c: add stock whose answer is lost is sent again with the same key: answered replayed, the units added once', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page, 'Stock');
  await page.getByRole('link', { name: 'Add a batch of Paracetamol 650mg' }).click();
  await fillBatch(page);
  backend.loseNextStockAnswer = true;
  await page.getByRole('button', { name: 'Check and add' }).click();
  await page.getByRole('button', { name: 'Yes, add to stock' }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed stock entry' });
  await panel.getByRole('button', { name: 'Send the same entry again' }).click();
  await expect(page.getByText('Already added: 100 units of Paracetamol 650mg, batch PCM-24B (expires 30 Jun 2028). Nothing was added twice.')).toBeVisible();
  await expect(panel).toHaveCount(0);
  expect(backend.stockPosts).toHaveLength(2);
  expect(backend.stockPosts[1]).toEqual(backend.stockPosts[0]); // the same key and item
  expect(backend.adjustments).toHaveLength(1);
});

test('add stock lost before it reached the server: not recorded by its key; given up on the server, the form is free again and that key can never add', async ({ page }) => {
  const backend = await mockBackend(page);
  let abort = 2;
  await page.route('**/api/v1/pharmacy-inventory', (route) => (route.request().method() === 'POST' && abort-- > 0 ? route.abort('connectionreset') : route.fallback()));
  await signIn(page, 'Stock');
  await page.getByRole('link', { name: 'Add a batch of Paracetamol 650mg' }).click();
  await fillBatch(page);
  await page.getByRole('button', { name: 'Check and add' }).click();
  await page.getByRole('button', { name: 'Yes, add to stock' }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed stock entry' });
  await panel.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(panel).toContainText('Not recorded so far. It may still be on its way. Sending the same entry again is safe');
  await panel.getByRole('button', { name: 'Send the same entry again' }).click(); // lost again
  await expect(panel).toContainText('This stock entry was not confirmed');
  await expect(panel.getByRole('button', { name: /Forget/ })).toHaveCount(0); // no forgetting with a double-count risk any more
  await panel.getByRole('button', { name: 'Give this up' }).click();
  await expect(page.getByText('Given up: nothing was added with that entry, and it can never be added now.', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Batch number')).toHaveValue('pcm-24b'); // what was typed is kept
  expect(backend.abandoned.size).toBe(1);
  expect(backend.stockPosts).toHaveLength(0);
  expect(backend.adjustments).toHaveLength(0);
});

test('WQ10c: giving up an entry that was in fact added shows it as recorded and clears the form; nothing is added twice', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page, 'Stock');
  await page.getByRole('link', { name: 'Add a batch of Paracetamol 650mg' }).click();
  await fillBatch(page);
  backend.loseNextStockAnswer = true;
  await page.getByRole('button', { name: 'Check and add' }).click();
  await page.getByRole('button', { name: 'Yes, add to stock' }).click();
  await page.getByRole('group', { name: 'Unconfirmed stock entry' }).getByRole('button', { name: 'Give this up' }).click();
  await expect(page.getByText('Recorded: 100 units of Paracetamol 650mg, batch PCM-24B (expires 30 Jun 2028) was added. Nothing was added twice.')).toBeVisible();
  await expect(page.getByLabel('Batch number')).toHaveValue('');
  expect(backend.abandoned.size).toBe(0);
  expect(backend.adjustments).toHaveLength(1);
});

test('WQ10c (review P1): a lost entry found by its key clears the form, so the same batch is not added again under a new key', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page, 'Stock');
  await page.getByRole('link', { name: 'Add a batch of Paracetamol 650mg' }).click();
  await fillBatch(page);
  backend.loseNextStockAnswer = true;
  await page.getByRole('button', { name: 'Check and add' }).click();
  await page.getByRole('button', { name: 'Yes, add to stock' }).click();
  await page.getByRole('group', { name: 'Unconfirmed stock entry' }).getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(page.getByText(/^Recorded: 100 units/)).toBeVisible();
  await expect(page.getByLabel('Batch number')).toHaveValue('');
  await expect(page.getByLabel('Units received')).toHaveValue('');
  await expect(page.getByLabel('Note (optional)')).toHaveValue('');
  expect(backend.adjustments).toHaveLength(1);
});

test('WQ10c (review P2): while the same entry is sent again, the unconfirmed panel stays (busy); no second review can open', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page, 'Stock');
  await page.getByRole('link', { name: 'Add a batch of Paracetamol 650mg' }).click();
  await fillBatch(page);
  backend.loseNextStockAnswer = true;
  backend.slowReplayMs = 1500;
  await page.getByRole('button', { name: 'Check and add' }).click();
  await page.getByRole('button', { name: 'Yes, add to stock' }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed stock entry' });
  await panel.getByRole('button', { name: 'Send the same entry again' }).click();
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Check whether it was recorded' })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Give this up' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Check and add' })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Add this stock' })).toHaveCount(0);
  await expect(page.getByText(/^Already added: 100 units/)).toBeVisible({ timeout: 8000 });
  expect(backend.adjustments).toHaveLength(1);
});

test('WQ10c: a stock entry refused 503 INDEXES_OUTDATED keeps the entry, says so in the server’s words, and is sent again later with the same key', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page, 'Stock');
  await page.getByRole('link', { name: 'Add a batch of Paracetamol 650mg' }).click();
  await fillBatch(page, '7');
  backend.indexesOutdated = true;
  await page.getByRole('button', { name: 'Check and add' }).click();
  await page.getByRole('button', { name: 'Yes, add to stock' }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed stock entry' });
  await expect(panel).toContainText(`This stock entry was not confirmed (${INDEXES_OUTDATED}: ask the Jansetu team).`);
  await panel.getByRole('button', { name: 'Send the same entry again' }).click();
  await expect(page.getByText('Added 7 units of Paracetamol 650mg, batch PCM-24B (expires 30 Jun 2028).')).toBeVisible();
  expect(backend.stockPosts).toHaveLength(2);
  expect(backend.stockPosts[1]).toEqual(backend.stockPosts[0]);
  expect(backend.adjustments).toHaveLength(1);
});

test('import: the columns and a template, the file is checked, problems first, confirm adds the ready rows; history lists it', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page, 'Stock');
  await page.getByRole('link', { name: 'Import stock from a file' }).click();
  await expect(page.getByRole('heading', { name: 'Import stock from a file' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'medicine name', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'expiry date', exact: true })).toBeVisible();
  // Q15: headers in any case; the expiry forms the import reads, and no "type it as text" advice.
  await expect(page.getByText('in capitals or small letters', { exact: false })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Expiry date' }).getByRole('listitem')).toHaveCount(5);
  await expect(page.getByRole('list', { name: 'Expiry date' })).toContainText('MM/YYYY or MM-YYYY, as printed on packs');
  await expect(page.getByRole('list', { name: 'Expiry date' })).toContainText('a date cell in Excel');
  await expect(page.getByText(/expiry date as text|format to Text|exactly as below in small letters/)).toHaveCount(0);
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
  await expect(rows.nth(1)).toContainText(EXPIRY_ERROR);
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
  expect(backend.supplierCalls[0]!.body).toEqual({ displayName: 'Sun Distributors', phone: '+91 98765 43210', email: 'orders@sun.in', requestKey: expect.stringMatching(/^[0-9a-f]{32}$/) });
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

test('WQ10c: suppliers: an add whose answer is lost is found by its key, never added twice', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page, 'Suppliers');
  backend.loseNextSupplierAnswer = true;
  await page.getByRole('button', { name: 'Add a supplier' }).click();
  await page.getByLabel('Supplier name').fill('Moon Pharma');
  await page.getByRole('button', { name: 'Add supplier' }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed supplier change' });
  await expect(panel).toContainText('Add Moon Pharma: not confirmed');
  await expect(page.getByRole('button', { name: 'Add a supplier' })).toBeDisabled();
  await panel.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(page.getByText('Moon Pharma was added. Nothing was added twice.')).toBeVisible();
  await expect(panel).toHaveCount(0);
  const key = (backend.supplierCalls[0]!.body as Json).requestKey;
  expect(backend.supplierCalls.filter((c) => c.method === 'POST')).toHaveLength(1);
  expect(await page.evaluate(() => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }))).not.toContain('Moon');
  expect(key).toMatch(/^[0-9a-f]{32}$/);
});

test('WQ10c: suppliers: a lost add sent again with the same key is answered replayed (one supplier); 503 INDEXES_OUTDATED keeps it for later', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page, 'Suppliers');
  backend.indexesOutdated = true;
  await page.getByRole('button', { name: 'Add a supplier' }).click();
  await page.getByLabel('Supplier name').fill('Star Pharma');
  await page.getByRole('button', { name: 'Add supplier' }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed supplier change' });
  await expect(panel).toContainText(`Add Star Pharma: not confirmed (${INDEXES_OUTDATED}: ask the Jansetu team).`);
  backend.loseNextSupplierAnswer = true; // the resend is made, but its answer is lost too
  await panel.getByRole('button', { name: 'Send the same change again' }).click();
  await expect(panel).toContainText('Add Star Pharma: not confirmed');
  await panel.getByRole('button', { name: 'Send the same change again' }).click();
  await expect(page.getByText('Star Pharma was added.')).toBeVisible();
  await expect(panel).toHaveCount(0);
  const posts = backend.supplierCalls.filter((c) => c.method === 'POST');
  expect(posts).toHaveLength(3);
  expect(new Set(posts.map((c) => JSON.stringify(c.body))).size).toBe(1); // the same key and fields every time
  expect(backend.suppliers.filter((x) => x.displayName === 'Star Pharma')).toHaveLength(1);
  await expect(page.getByRole('row').filter({ hasText: 'Star Pharma' })).toHaveCount(1);
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

test('WQ10c: suppliers: a lost add is given up on the server (abandoned: a late copy is refused); one that was made is shown instead', async ({ page }) => {
  const backend = await mockBackend(page);
  await page.route('**/api/v1/pharmacy-suppliers', (route) => (route.request().method() === 'POST' && !backend.abandoned.size ? route.abort('connectionreset') : route.fallback()));
  await signIn(page, 'Suppliers');
  await page.getByRole('button', { name: 'Add a supplier' }).click();
  await page.getByLabel('Supplier name').fill('Lost Pharma');
  await page.getByRole('button', { name: 'Add supplier' }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed supplier change' });
  await expect(panel.getByRole('button', { name: /Forget/ })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Give this up' }).click();
  await expect(page.getByText('Given up: nothing was added with it, and it can never be added now.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add a supplier' })).toBeEnabled();
  expect(backend.abandoned.size).toBe(1);
  expect(backend.suppliers).toHaveLength(0);

  // Made, answer lost, then given up: the server says it was used.
  backend.loseNextSupplierAnswer = true;
  await page.getByRole('button', { name: 'Add a supplier' }).click();
  await page.getByLabel('Supplier name').fill('Made Pharma');
  await page.getByRole('button', { name: 'Add supplier' }).click();
  await page.getByRole('group', { name: 'Unconfirmed supplier change' }).getByRole('button', { name: 'Give this up' }).click();
  await expect(page.getByText('Made Pharma was added. Nothing was added twice.')).toBeVisible();
  expect(backend.suppliers.map((x) => x.displayName)).toEqual(['Made Pharma']);
});

test('WQ10c: suppliers: a lost edit whose resend is refused outright is settled as not saved; another lost edit can be forgotten after a second step', async ({ page }) => {
  const backend = await mockBackend(page, { suppliers: [supplier({})] });
  let abort = 1;
  await page.route('**/api/v1/pharmacy-suppliers/*', (route) => (route.request().method() === 'PATCH' && abort-- > 0 ? route.abort('connectionreset') : route.fallback()));
  await signIn(page, 'Suppliers');
  const row = page.getByRole('row').filter({ hasText: 'Sun Distributors' });
  await row.getByRole('button', { name: 'Edit Sun Distributors' }).click();
  await page.getByLabel('Contact person (optional)').fill('Asha');
  await page.getByRole('button', { name: 'Save changes' }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed supplier change' });
  await expect(panel).toContainText('Save changes to Sun Distributors: not confirmed');
  backend.refuseNextSupplierEdit = true;
  await panel.getByRole('button', { name: 'Send the same change again' }).click();
  await expect(page.getByText('Not saved: Invalid supplier request')).toBeVisible();
  await expect(panel).toHaveCount(0); // the list is free again
  await expect(row.getByRole('button', { name: 'Edit Sun Distributors' })).toBeEnabled();

  abort = 1;
  await row.getByRole('button', { name: 'Edit Sun Distributors' }).click();
  await page.getByLabel('Contact person (optional)').fill('Meena');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await panel.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(panel).toContainText('Not saved yet.');
  await panel.getByRole('button', { name: 'Forget it' }).click();
  await expect(panel).toContainText('it takes effect only if nobody changed Sun Distributors since');
  await panel.getByRole('button', { name: 'Forget it' }).last().click();
  await expect(panel).toHaveCount(0);
  expect(backend.suppliers[0]!.contactName).toBe('Ravi');
});

test('WQ10c (review P3): a lost file check never opens an older import of the same name; a new one is offered as a question', async ({ page }) => {
  const old: Json = { _id: 'e1'.repeat(12), fileName: 'stock.csv', importMode: 'upsert', status: 'previewed', totalRows: 1, validRows: 1, errorRows: 0,
    previewRows: [{ rowIndex: 2, medicineName: 'Old row', status: 'valid', data: { quantityToAdd: 5 } }],
    createdAt: new Date(Date.now() - 3 * 60_000).toISOString(), updatedAt: new Date(Date.now() - 3 * 60_000).toISOString() };
  const backend = await mockBackend(page, { imports: [old] });
  await signIn(page, 'Stock');
  await page.getByRole('link', { name: 'Import stock from a file' }).click();
  await page.getByLabel('Stock file').setInputFiles({ name: 'stock.csv', mimeType: 'text/csv', buffer: Buffer.from('medicine name,quantity to add\r\nNew row,9\r\n') });
  backend.loseNextPreview = true;
  await page.getByRole('button', { name: 'Check the file' }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed file check' });
  await panel.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(panel).toContainText('It is not in your imports yet.');
  await expect(page).not.toHaveURL(/imports\/e1e1/);
  // An import of this name made after the check was sent: asked, never opened on its own.
  backend.imports.unshift({ ...old, _id: IMP, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), previewRows: PREVIEW_ROWS });
  await panel.getByRole('button', { name: 'Check whether it was recorded' }).click();
  const ask = page.getByRole('group', { name: 'Is this the import?' });
  await expect(ask).toContainText(/An import of stock\.csv started at \d{2}:\d{2}\. Is this it\?/);
  await expect(page).not.toHaveURL(new RegExp(`imports/${IMP}`));
  await ask.getByRole('button', { name: 'Open it' }).click();
  await expect(page).toHaveURL(new RegExp(`imports/${IMP}`));
});

test('WQ10c (review P3): after a reload the body-less file check is never matched to an import', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page, 'Stock');
  await page.getByRole('link', { name: 'Import stock from a file' }).click();
  await page.getByLabel('Stock file').setInputFiles({ name: 'stock.csv', mimeType: 'text/csv', buffer: Buffer.from('medicine name\r\nX\r\n') });
  backend.loseNextPreview = true;
  await page.getByRole('button', { name: 'Check the file' }).click();
  await expect(page.getByRole('group', { name: 'Unconfirmed file check' })).toBeVisible();
  backend.imports.unshift({ _id: IMP, fileName: 'stock.csv', importMode: 'upsert', status: 'previewed', totalRows: 3, validRows: 2, errorRows: 1, previewRows: PREVIEW_ROWS,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  await page.reload();
  const panel = page.getByRole('group', { name: 'Unconfirmed file check' });
  await panel.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(panel).toContainText('Its file name is not kept on this device.');
  await expect(page.getByRole('group', { name: 'Is this the import?' })).toHaveCount(0);
  await expect(page).not.toHaveURL(new RegExp(`imports/${IMP}`));
});

test('WQ10c (review P4): an import stuck while being added for over 15 minutes offers Try again, which resumes it once', async ({ page }) => {
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const stuck: Json = { _id: IMP, fileName: 'stock.csv', importMode: 'upsert', status: 'committing', totalRows: 2, validRows: 2, errorRows: 0,
    previewRows: [{ rowIndex: 2, medicineName: 'A', status: 'valid', data: { quantityToAdd: 5 } }, { rowIndex: 3, medicineName: 'B', status: 'valid', data: { quantityToAdd: 5 } }],
    createdAt: hourAgo, updatedAt: hourAgo };
  const backend = await mockBackend(page, { imports: [stuck] });
  await signIn(page, 'Stock');
  await page.goto(`/#/pharmacy/stock/imports/${IMP}`);
  await expect(page.getByRole('heading', { name: 'Adding stopped' })).toBeVisible();
  await expect(page.getByText('The rows are being added. This page updates on its own.')).toHaveCount(0);
  await page.getByRole('button', { name: 'Try again…' }).click();
  await expect(page.getByText('rows not added yet are added now', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Yes, try again' }).click();
  await expect(page.getByText('Done: 2 rows were added to stock.')).toBeVisible();
  expect(backend.retries).toBe(1);

  // A fresh "being added" import (under 15 minutes) offers nothing.
  Object.assign(stuck, { status: 'committing', updatedAt: new Date().toISOString() });
  await page.reload();
  await expect(page.getByText('The rows are being added. This page updates on its own.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again…' })).toHaveCount(0);
});

test('WQ10c: a lost retry is not settled by an outcome written before it was sent', async ({ page }) => {
  const twoMinAgo = new Date(Date.now() - 2 * 60_000).toISOString();
  const partly: Json = { _id: IMP, fileName: 'stock.csv', importMode: 'upsert', status: 'partially_committed', totalRows: 2, validRows: 2, errorRows: 0,
    committedRows: 1, failedRows: 1, committedAt: twoMinAgo,
    previewRows: [{ rowIndex: 2, medicineName: 'A', status: 'committed', data: { quantityToAdd: 5 } }, { rowIndex: 3, medicineName: 'B', status: 'failed', errors: ['timeout'], data: { quantityToAdd: 5 } }],
    createdAt: twoMinAgo, updatedAt: twoMinAgo };
  const backend = await mockBackend(page, { imports: [partly] });
  await signIn(page, 'Stock');
  await page.goto(`/#/pharmacy/stock/imports/${IMP}`);
  backend.loseNextRetry = true;
  await page.getByRole('button', { name: 'Try the failed rows again…' }).click();
  await page.getByRole('button', { name: 'Yes, try again' }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed import step' });
  await panel.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(panel).toContainText('It has not started yet.');
  await panel.getByRole('button', { name: 'Send it again' }).click();
  await expect(page.getByText('Done: 2 rows were added to stock.')).toBeVisible();
  expect(backend.retries).toBe(1);
});
