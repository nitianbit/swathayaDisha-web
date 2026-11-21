import { readFile } from 'node:fs/promises';
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
  previews: { mode: string; fileName: string; supplierId?: string }[];
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
  /** The first stock save is held this long before the server decides it (still in flight). */
  holdFirstStockMs: number;
  /** Abandon answers this many ms late. */
  slowAbandonMs: number;
  /** The next supplier add is refused 403 (says nothing about an earlier copy). */
  forbidNextSupplierAdd: boolean;
  /** WQ11c: the server has its template route (Q16c `GET /pharmacy-inventory-imports/template`). */
  serverTemplate: boolean;
  /** WQ11c: the next file check is refused with this answer (Q16c upload codes). */
  previewRefusal: { status: number; code: string; message: string } | null;
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
    retries: 0, refuseNextSupplierEdit: false, holdFirstStockMs: 0, slowAbandonMs: 0, forbidNextSupplierAdd: false, serverTemplate: false,
    previewRefusal: null,
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
    if (med) {
      const m = medicines.find((x) => x._id === med[1]);
      return m ? json(route, 200, { success: true, data: m }) : refuse(route, 404, 'MEDICINE_NOT_FOUND', 'Medicine not found');
    }
    const stockByKey = /^\/pharmacy-inventory\/by-key\/([A-Za-z0-9_-]{8,100})$/.exec(path);
    const stockAbandon = /^\/pharmacy-inventory\/by-key\/([A-Za-z0-9_-]{8,100})\/abandon$/.exec(path);
    if (stockAbandon && method === 'POST') {
      if (state.slowAbandonMs) await new Promise((r) => setTimeout(r, state.slowAbandonMs));
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
      // Q16c: a delivery's supplier must be one of the pharmacy's own, active (checked before anything is saved).
      const supplierId = ((body!.items as Json[])[0] as Json).supplierId as string | undefined;
      const sup = supplierId ? state.suppliers.find((x) => x.supplierId === supplierId) : undefined;
      if (supplierId && !sup) return refuse(route, 404, 'SUPPLIER_NOT_FOUND', 'Supplier not found');
      if (sup && sup.state !== 'active') return refuse(route, 409, 'SUPPLIER_ARCHIVED', 'This supplier is archived');
      if (state.stockPosts.length === 1 && state.holdFirstStockMs) await new Promise((r) => setTimeout(r, state.holdFirstStockMs));
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
        sourceType: 'manual', reason: it.reason, notes: it.notes, createdAt: new Date().toISOString(),
        ...(sup ? { supplierId: sup.supplierId, supplier: { supplierId: sup.supplierId, displayName: sup.displayName, state: sup.state } } : { supplier: null }) });
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
      const supplierId = /name="supplierId"\r\n\r\n([0-9a-f]{24})/.exec(raw)?.[1];
      state.previews.push({ mode, fileName, ...(supplierId ? { supplierId } : {}) });
      if (state.previewRefusal) { const r = state.previewRefusal; state.previewRefusal = null; return refuse(route, r.status, r.code, r.message); }
      const sup = supplierId ? state.suppliers.find((x) => x.supplierId === supplierId) : undefined;
      if (supplierId && !sup) return refuse(route, 404, 'SUPPLIER_NOT_FOUND', 'Supplier not found');
      const rec = { _id: IMP, fileName, importMode: mode, status: 'previewed', totalRows: 3, validRows: 2, errorRows: 1, previewRows: PREVIEW_ROWS,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        ...(sup ? { supplierId: sup.supplierId } : {}) };
      state.imports = [rec, ...state.imports.filter((r) => r._id !== IMP)];
      return json(route, 200, { success: true, data: rec });
    }
    if (path === '/pharmacy-inventory-imports/commit') {
      state.commits += 1;
      const rec = state.imports.find((r) => r._id === body?.importId);
      if (!rec) return refuse(route, 404, 'IMPORT_NOT_FOUND', 'Import record not found');
      if (rec.status !== 'previewed') return refuse(route, 409, 'IMPORT_NOT_RETRYABLE', 'Import is already committed or currently being processed');
      // applyRowToInventory: "only medicines already in my stock" skips a medicine not in the list (it cannot be in stock).
      const rows = (rec.previewRows as Json[]).map((r) => (r.status !== 'valid' ? r
        : { ...r, status: rec.importMode === 'update_only' && (r.data as Json).medicineMatchStatus === 'not_found' ? 'skipped' : 'committed' }));
      const committedRows = rows.filter((r) => r.status === 'committed').length;
      const unresolved = rows.filter((r) => r.status === 'error' || r.status === 'failed').length;
      Object.assign(rec, {
        status: unresolved ? 'partially_committed' : 'committed', committedRows, failedRows: unresolved, committedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(), previewRows: rows,
      });
      if (state.loseNextCommitAnswer) { state.loseNextCommitAnswer = false; return route.abort('connectionreset'); }
      return json(route, 200, { success: true, data: rec });
    }
    if (path === '/pharmacy-inventory-imports') return pageOf(route, state.imports, pg, lim);
    if (path === '/pharmacy-inventory-imports/template' && state.serverTemplate) {
      return route.fulfill({ status: 200, contentType: 'text/csv', body: 'medicine name,expiry date\r\nServer example,31-12-2027\r\n' });
    }
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
        if (state.forbidNextSupplierAdd) { state.forbidNextSupplierAdd = false; return refuse(route, 403, 'PHARMACY_NOT_OPERATIONAL', 'This pharmacy is not active'); }
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
  // WQ11c (owner, 22 Nov): dates day first, said plainly; the template has one example row (until the server's route is
  // there it is made on this device).
  await expect(page.getByText('Dates are read day first. Write expiry dates as DD-MM-YYYY (day first), for example 31-12-2027.')).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'retail price' })).toContainText('Optional — blank keeps the current price');
  await expect(page.getByRole('row').filter({ hasText: 'prescription required' })).toContainText('Left blank, a new medicine needs a prescription.');
  const template = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download the template (with an example row)' }).click();
  const file = await template;
  expect(file.suggestedFilename()).toBe('stock-import-template.csv');
  const lines = (await readFile((await file.path())!, 'utf8')).trim().split('\r\n');
  expect(lines[0]!.split(',').slice(0, 4)).toEqual(['medicine name', 'quantity to add', 'batch number', 'expiry date']);
  expect(lines[1]!.split(',')[3]).toBe('31-12-2027');
  expect(lines).toHaveLength(2);
  // Once the server has its template, that one is downloaded.
  backend.serverTemplate = true;
  const serverFile = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download the template (with an example row)' }).click();
  expect(await readFile((await (await serverFile).path())!, 'utf8')).toContain('Server example');

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
  // WQ11c: the count follows "Only medicines already in my stock": the new medicine's row is skipped and not counted.
  const confirm = page.getByRole('group', { name: 'Add 2 ready rows to stock…' });
  await expect(confirm).toContainText('1 row (50 units) is added if the medicine is in your stock (others are skipped).');
  await expect(confirm).toContainText('1 row for medicines not in your stock is skipped and not counted.');
  await expect(confirm).not.toContainText('70 units');
  await expect(confirm).not.toContainText('will be added to it');
  await expect(confirm).toContainText('Prices change in 1 row: row 2 (Paracetamol). Blank price cells keep the current price.');
  expect(backend.commits).toBe(0);
  await page.getByRole('button', { name: 'Yes, add them' }).click();
  await expect(page.getByText('Partly done: 1 rows were added; 1 were not. 1 row was skipped by the rows you chose to add. See the rows below.')).toBeVisible();
  await expect(page.getByText('Partly added').first()).toBeVisible();
  expect(backend.commits).toBe(1);
  await page.getByRole('link', { name: 'Import stock' }).click();
  const listed = page.getByRole('row').filter({ hasText: 'nov-stock.csv' });
  await expect(listed).toContainText('Partly added');
  await expect(listed).toContainText('3 (2 ready, 1 with problems)');
  await expect(listed.getByRole('cell').last()).toHaveText('1');
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

test('WQ11d: a tab holding an unconfirmed step for an import that then got stuck can still try again', async ({ page }) => {
  const now = new Date().toISOString();
  const rec: Json = { _id: IMP, fileName: 'stock.csv', importMode: 'upsert', status: 'previewed', totalRows: 2, validRows: 2, errorRows: 0,
    previewRows: [{ rowIndex: 2, medicineName: 'A', status: 'valid', data: { quantityToAdd: 5 } }, { rowIndex: 3, medicineName: 'B', status: 'valid', data: { quantityToAdd: 5 } }],
    createdAt: now, updatedAt: now };
  const backend = await mockBackend(page, { imports: [rec] });
  let drop = true;
  await page.route('**/api/v1/pharmacy-inventory-imports/commit', (route) => {
    if (!drop) return route.fallback();
    drop = false;
    // The server took the commit and stopped half way (committing since an hour), and the answer was lost.
    Object.assign(rec, { status: 'committing', updatedAt: new Date(Date.now() - 3600_000).toISOString() });
    return route.abort('connectionreset');
  });
  await signIn(page, 'Stock');
  await page.goto(`/#/pharmacy/stock/imports/${IMP}`);
  await page.getByRole('button', { name: /Add 2 ready rows to stock/ }).click();
  await page.getByRole('button', { name: 'Yes, add them' }).click();
  await expect(page.getByRole('group', { name: 'Unconfirmed import step' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Adding stopped' })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Try again…' }).click();
  await page.getByRole('button', { name: 'Yes, try again' }).click();
  await expect(page.getByText('Done: 2 rows were added to stock.')).toBeVisible();
  expect(backend.retries).toBe(1);
  await expect(page.getByRole('group', { name: 'Unconfirmed import step' })).toHaveCount(0);
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

test('WQ10c (review N1): giving up an entry whose first send is still in flight keeps the panel (busy) on screen; the late send is refused', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.holdFirstStockMs = 4000;
  backend.slowAbandonMs = 1500;
  await signIn(page, 'Stock');
  await page.getByRole('link', { name: 'Add a batch of Paracetamol 650mg' }).click();
  await fillBatch(page);
  await page.getByRole('button', { name: 'Check and add' }).click();
  await page.getByRole('button', { name: 'Yes, add to stock' }).click(); // held at the server
  await page.getByRole('link', { name: 'Stock', exact: true }).first().click();
  await page.getByRole('link', { name: 'Add a batch of Paracetamol 650mg' }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed stock entry' });
  await panel.getByRole('button', { name: 'Give this up' }).click();
  await expect(panel).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check and add' })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Check whether it was recorded' })).toBeDisabled();
  await expect(page.getByText('Given up: nothing was added with that entry, and it can never be added now.', { exact: false })).toBeVisible();
  await expect.poll(() => backend.stockPosts.length).toBe(1);
  await page.waitForTimeout(3000); // the held send is now decided: refused, the key was given up
  expect(backend.adjustments).toHaveLength(0);
  expect(backend.abandoned.size).toBe(1);
});

test('WQ10c (review N2): a supplier add resent into a 403 stays unconfirmed (it may have been added); the check then finds it', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page, 'Suppliers');
  backend.loseNextSupplierAnswer = true;
  await page.getByRole('button', { name: 'Add a supplier' }).click();
  await page.getByLabel('Supplier name').fill('Sun Distributors');
  await page.getByRole('button', { name: 'Add supplier' }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed supplier change' });
  backend.forbidNextSupplierAdd = true;
  await panel.getByRole('button', { name: 'Send the same change again' }).click();
  await expect(panel).toContainText('Add Sun Distributors: not confirmed (This pharmacy is not active)');
  await expect(page.getByText(/Not added: /)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add a supplier' })).toBeDisabled();
  await panel.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(page.getByText('Sun Distributors was added. Nothing was added twice.')).toBeVisible();
  expect(backend.suppliers).toHaveLength(1);
});


// ───────────── WQ11c (pre-production review): pharmacy screens ─────────────

const manySuppliers = (n: number) => Array.from({ length: n }, (_, i) =>
  supplier({ supplierId: 'e'.repeat(20) + String(i + 1).padStart(4, '0'), displayName: `Supplier ${String(i + 1).padStart(2, '0')}` }));

test('WQ11c (review S1): after a reload, a lost retry is never settled by the outcome written before it was sent', async ({ page }) => {
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
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(panel).toContainText('It has not started yet.');
  // After a reload only a body-less marker is left: the two-minute-old outcome still does not settle it.
  await page.reload();
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(page.getByText('The earlier try of the failed rows has not started. Try them again below if you still want; a row already added is never added twice.')).toBeVisible();
  await expect(page.getByText('Partly done: 1 rows were added; 1 were not.', { exact: false })).toHaveCount(0);
  await expect(panel).toHaveCount(0);
  expect(backend.retries).toBe(0);
  // Trying again now runs once and settles from its own outcome.
  await page.getByRole('button', { name: 'Try the failed rows again…' }).click();
  await page.getByRole('button', { name: 'Yes, try again' }).click();
  await expect(page.getByText('Done: 2 rows were added to stock.')).toBeVisible();
  expect(backend.retries).toBe(1);
});

test('WQ11c (review S2): the preview shows the prices that will apply (₹0 named and warned, blank cells keep the price), prescriptions for new medicines, and the confirmation names it all', async ({ page }) => {
  const rows = [
    // The server (Q16c) leaves a blank price cell out; 0 is a price of ₹0.
    { rowIndex: 2, medicineName: 'Paracetamol', status: 'valid', data: { name: 'Paracetamol', quantityToAdd: 50, batchNumber: 'PCM-77', expiryDate: '20280131', mrp: 0, retailPrice: 0, medicineId: MED, medicineMatchStatus: 'matched', matchedMedicineName: 'Paracetamol' } },
    { rowIndex: 3, medicineName: 'Pantoprazole', status: 'valid', data: { name: 'Pantoprazole', quantityToAdd: 10, batchNumber: 'PZ-1', expiryDate: '20280131', medicineId: MED2, medicineMatchStatus: 'matched', matchedMedicineName: 'Pantoprazole' } },
    { rowIndex: 4, medicineName: 'Zincovit', status: 'valid', data: { name: 'Zincovit', quantityToAdd: 20, batchNumber: 'ZV-1', expiryDate: '20271231', medicineMatchStatus: 'not_found', prescriptionRequired: true } },
    { rowIndex: 5, medicineName: 'Gelusil', status: 'valid', data: { name: 'Gelusil', quantityToAdd: 5, batchNumber: 'GL-1', expiryDate: '20271231', mrp: 40, retailPrice: 38, medicineMatchStatus: 'not_found', prescriptionRequired: false } },
  ];
  const now = new Date().toISOString();
  const backend = await mockBackend(page, { imports: [{ _id: IMP, fileName: 'restock.csv', importMode: 'upsert', status: 'previewed', totalRows: 4, validRows: 4, errorRows: 0, previewRows: rows, createdAt: now, updatedAt: now }] });
  await signIn(page, 'Stock');
  await page.goto(`/#/pharmacy/stock/imports/${IMP}`);
  const table = page.getByRole('table', { name: 'Rows of the file, problems first' });
  const para = table.getByRole('row').filter({ hasText: 'Paracetamol' });
  await expect(para.getByRole('cell').nth(7)).toHaveText('₹0.00');
  // Re-review N4: a selling price of ₹0 leaves the medicine unpriced too.
  await expect(para.getByRole('cell').nth(8)).toHaveText('₹0.00Not on sale until priced');
  await expect(para).toContainText('Sets the MRP, selling price to ₹0');
  const panto = table.getByRole('row').filter({ hasText: 'Pantoprazole' });
  await expect(panto.getByRole('cell').nth(7)).toHaveText('Current price kept');
  await expect(panto).toContainText('As in the list');
  const zinc = table.getByRole('row').filter({ hasText: 'Zincovit' });
  await expect(zinc).toContainText('Needs a prescription');
  await expect(zinc).toContainText('Not on sale until priced');
  await expect(table.getByRole('row').filter({ hasText: 'Gelusil' })).toContainText('Not needed');
  await expect(page.getByText('1 row would set a price to ₹0: row 2 (Paracetamol).', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Add 4 ready rows to stock…' }).click();
  const confirm = page.getByRole('group', { name: 'Add 4 ready rows to stock…' });
  await expect(confirm).toContainText('4 rows (85 units) are added.');
  await expect(confirm).toContainText('2 medicines are not in the medicine list yet and will be added to it (1 needing a prescription).');
  await expect(confirm).toContainText('2 rows leave their medicines without a selling price: not on sale until priced (row 2 (Paracetamol), row 4 (Zincovit)).');
  await expect(confirm).toContainText('Prices change in 2 rows: row 2 (Paracetamol), row 5 (Gelusil), 1 row to ₹0. Blank price cells keep the current price.');
  await expect(confirm).not.toContainText('go on sale at once.');
  expect(backend.commits).toBe(0);
  // The column guide says the same.
  await page.goto('/#/pharmacy/stock/import');
  const cols = page.getByRole('table', { name: 'Columns of a stock file' });
  for (const h of ['mrp', 'retail price', 'purchase price', 'wholesale price']) {
    await expect(cols.getByRole('row').filter({ has: page.getByRole('cell', { name: h, exact: true }) })).toContainText('Optional — blank keeps the current price');
  }
});

test('WQ11c (review S3): a preview can be discarded (on this device: no server route), and a commit warns about the same file added in the last 24 hours', async ({ page }) => {
  const earlier = new Date(Date.now() - 2 * 3_600_000).toISOString();
  const now = new Date().toISOString();
  const OTHER = 'd2'.repeat(12);
  const backend = await mockBackend(page, { imports: [
    { _id: IMP, fileName: 'restock.csv', importMode: 'upsert', status: 'previewed', totalRows: 3, validRows: 2, errorRows: 1, previewRows: PREVIEW_ROWS, createdAt: now, updatedAt: now },
    { _id: OTHER, fileName: 'restock.csv', importMode: 'upsert', status: 'committed', totalRows: 3, validRows: 2, errorRows: 1, committedRows: 2, previewRows: PREVIEW_ROWS, createdAt: earlier, updatedAt: earlier, committedAt: earlier },
  ] });
  await signIn(page, 'Stock');
  await page.goto(`/#/pharmacy/stock/imports/${IMP}`);
  await expect(page.getByText('Another import of restock.csv was added', { exact: false })).toBeVisible();
  await expect(page.getByRole('link', { name: 'open it' })).toHaveAttribute('href', `#/pharmacy/stock/imports/${OTHER}`);
  await page.getByRole('button', { name: 'Discard this preview…' }).click();
  await expect(page.getByText('there is no way to delete it on the server yet', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Discard it' }).click();
  await expect(page.getByText('You discarded this preview on this device: nothing from it was added.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: /ready rows? to stock/ })).toHaveCount(0);
  await page.getByRole('link', { name: 'Import stock' }).click();
  const listed = page.getByRole('row').filter({ hasText: 'restock.csv' });
  await expect(listed.filter({ hasText: 'Discarded on this device' })).toHaveCount(1);
  // WQ11d: it survives a reload (only the import's id is kept on the device).
  await page.reload();
  await expect(listed.filter({ hasText: 'Discarded on this device' })).toHaveCount(1);
  const kept = await page.evaluate(() => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }));
  expect(kept).toContain(IMP);
  expect(kept).not.toContain('restock.csv');
  await listed.filter({ hasText: 'Discarded on this device' }).getByRole('link').click();
  await page.getByRole('button', { name: 'Use this preview after all' }).click();
  await expect(page.getByRole('button', { name: 'Add 2 ready rows to stock…' })).toBeVisible();
  expect(backend.commits).toBe(0);
});

test('WQ11c: the file check sends the delivery’s supplier, shows it, and says the server’s upload refusals in words', async ({ page }) => {
  const backend = await mockBackend(page, { suppliers: [supplier({}), supplier({ supplierId: '6'.repeat(24), displayName: 'Old Traders', state: 'archived' })] });
  await signIn(page, 'Stock');
  await page.getByRole('link', { name: 'Import stock from a file' }).click();
  const picker = page.getByLabel('Supplier of this delivery (optional)');
  await expect(picker.locator('option')).toHaveText(['Not said', 'Sun Distributors']); // active suppliers only
  // Q16c upload refusals (400 with codes; the server removes the file).
  await page.getByLabel('Stock file').setInputFiles({ name: 'us.csv', mimeType: 'text/csv', buffer: Buffer.from('medicine name\nA\n') });
  backend.previewRefusal = { status: 400, code: 'IMPORT_COLUMNS_MISSING', message: 'The first row must name the columns' };
  await page.getByRole('button', { name: 'Check the file' }).click();
  await expect(page.getByText('The file was not checked: The first row has no “medicine name” column. Keep the column names of the template in the first row.')).toBeVisible();
  backend.previewRefusal = { status: 400, code: 'IMPORT_FILE_EMPTY', message: 'empty' };
  await page.getByRole('button', { name: 'Check the file' }).click();
  await expect(page.getByText('The file was not checked: The first sheet of the file has no rows. Fill in the template and upload it again.')).toBeVisible();
  backend.previewRefusal = { status: 400, code: 'IMPORT_FILE_TOO_BIG', message: 'The file is too big to import at once (250000 cells); split it' };
  await page.getByRole('button', { name: 'Check the file' }).click();
  await expect(page.getByText('The file was not checked: The file is too big to import at once (at most 200,000 cells). Split it into smaller files and import them one after another.')).toBeVisible();
  backend.previewRefusal = { status: 400, code: 'SOMETHING_NEW', message: 'A refusal this page does not know yet' };
  await page.getByRole('button', { name: 'Check the file' }).click();
  await expect(page.getByText('The file was not checked: A refusal this page does not know yet')).toBeVisible();
  await picker.selectOption({ label: 'Sun Distributors' });
  await page.getByRole('button', { name: 'Check the file' }).click();
  await expect(page.getByRole('heading', { name: 'Import of us.csv' })).toBeVisible();
  expect(backend.previews.at(-1)).toEqual({ mode: 'upsert', fileName: 'us.csv', supplierId: '5'.repeat(24) });
  // Q16c keeps the file's supplier as an id: its name is read from the supplier list.
  await expect(page.locator('.ws-dl')).toContainText('SupplierSun Distributors');
});

test('WQ11c: a file that writes dates month first: its refused rows are explained (dates are read day first)', async ({ page }) => {
  const now = new Date().toISOString();
  const rows = [
    { rowIndex: 2, medicineName: 'A', status: 'error', errors: ['expiry date 12/31/2027 is written month first; dates are read day first: write it as DD/MM/YYYY, DD-MM-YYYY or YYYY-MM-DD'] },
    { rowIndex: 3, medicineName: 'B', status: 'error', errors: ['this file writes dates month first (row 2: 12/31/2027), so 05/06/2027 cannot be read safely; write it as DD-MM-YYYY or YYYY-MM-DD'] },
    { rowIndex: 4, medicineName: 'C', status: 'valid', data: { name: 'C', quantityToAdd: 1, batchNumber: 'C1', expiryDate: '20271231', medicineMatchStatus: 'matched', medicineId: MED, supplierId: '5'.repeat(24), supplierName: 'Sun Distributors' } },
  ];
  await mockBackend(page, { imports: [{ _id: IMP, fileName: 'us.csv', importMode: 'upsert', status: 'previewed', totalRows: 3, validRows: 1, errorRows: 2, previewRows: rows, createdAt: now, updatedAt: now }] });
  await signIn(page, 'Stock');
  await page.goto(`/#/pharmacy/stock/imports/${IMP}`);
  await expect(page.getByText('This file writes dates month first, so 2 rows were refused. Dates are read day first: write them as DD-MM-YYYY (day first), for example 31-12-2027 and upload the file again.')).toBeVisible();
  // A row's supplier (Q16c `supplier` column, resolved to the pharmacy's supplier) is shown.
  await expect(page.getByRole('table', { name: 'Rows of the file, problems first' }).getByRole('row').filter({ hasText: 'C1' })).toContainText('Sun Distributors');
});

test('WQ11c: add stock names the delivery’s supplier (any of more than 50, found by name); the stock history shows it; an archived one is refused in words', async ({ page }) => {
  const backend = await mockBackend(page, { suppliers: manySuppliers(60) });
  await signIn(page, 'Stock');
  await page.getByRole('link', { name: 'Add stock' }).click();
  await page.getByLabel('Find the medicine').fill('para');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('button', { name: 'Choose Paracetamol 650mg' }).click();
  await fillBatch(page);
  const picker = page.getByLabel('Supplier (optional)');
  await expect(picker.locator('option')).toHaveCount(61); // "Not said" and all 60 (two pages of 50)
  await page.getByLabel('Find the supplier (60)').fill('58');
  await expect(picker.locator('option')).toHaveText(['Not said', 'Supplier 58']);
  await picker.selectOption({ label: 'Supplier 58' });
  // Archived meanwhile: refused before anything is saved; the list is read again.
  backend.suppliers[57]!.state = 'archived';
  await page.getByRole('button', { name: 'Check and add' }).click();
  await expect(page.getByRole('group', { name: 'Add this stock' })).toContainText('Supplier: Supplier 58');
  await page.getByRole('button', { name: 'Yes, add to stock' }).click();
  await expect(page.getByText('Not added: That supplier has been archived. Choose an active supplier, or none.')).toBeVisible();
  // The suppliers were read again: the archived one is no longer offered.
  await page.getByLabel('Find the supplier (59)').fill('57');
  await picker.selectOption({ label: 'Supplier 57' });
  await page.getByRole('button', { name: 'Check and add' }).click();
  await page.getByRole('button', { name: 'Yes, add to stock' }).click();
  await expect(page.getByText('Added 100 units of Paracetamol 650mg, batch PCM-24B (expires 30 Jun 2028) from Supplier 57.')).toBeVisible();
  expect(((backend.stockPosts.at(-1)!.items as Json[])[0]!).supplierId).toBe(backend.suppliers[56]!.supplierId);
  const history = page.getByRole('table', { name: 'Stock changes, newest first' });
  await expect(history.getByRole('row').nth(1)).toContainText('Supplier 57');
  await expect(history.getByRole('row').nth(1)).toContainText('+100');
});

test('WQ11c: return to supplier offers every active supplier, beyond the first 50', async ({ page }) => {
  const backend = await mockBackend(page, { suppliers: manySuppliers(55) });
  await signIn(page, 'Stock');
  await page.getByRole('button', { name: 'Return to supplier…' }).click();
  await page.getByLabel('Find the supplier (55)').fill('Supplier 55');
  await page.getByLabel('Supplier', { exact: true }).selectOption({ label: 'Supplier 55' });
  await page.getByLabel('Units').fill('2');
  await page.getByRole('button', { name: 'Record supplier return' }).click();
  await expect(page.getByText('Recorded: 2 units of batch PCM-A returned', { exact: false })).toBeVisible();
  expect(backend.returns[0]).toMatchObject({ supplierId: backend.suppliers[54]!.supplierId, quantity: 2 });
});

test('WQ11c: add stock for an unknown or malformed medicine in the address says so and offers the picker', async ({ page }) => {
  await mockBackend(page);
  await signIn(page, 'Stock');
  for (const id of ['not-an-id', '9'.repeat(24)]) {
    await page.goto(`/#/pharmacy/stock/add?medicine=${id}`);
    await expect(page.getByText('Medicine not found — pick another.')).toBeVisible();
    await expect(page.getByText('Loading medicine…')).toHaveCount(0);
  }
  await page.getByLabel('Find the medicine').fill('panto');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('button', { name: 'Choose Pantoprazole 40mg' }).click();
  await expect(page.getByText('Medicine not found — pick another.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Change medicine' })).toBeVisible();
});

test('WQ11c: an unconfirmed import step settles itself while the page reads the import again', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page, 'Stock');
  await page.getByRole('link', { name: 'Import stock from a file' }).click();
  await page.getByLabel('Stock file').setInputFiles({ name: 'stock.xlsx', mimeType: 'application/octet-stream', buffer: Buffer.from('PK') });
  await page.getByRole('button', { name: 'Check the file' }).click();
  backend.loseNextCommitAnswer = true;
  await page.getByRole('button', { name: 'Add 2 ready rows to stock…' }).click();
  await page.getByRole('button', { name: 'Yes, add them' }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed import step' });
  await expect(panel).toContainText('This page checks again on its own every few seconds.');
  // No click: the next read of the import shows it added, and that settles the step.
  await expect(page.getByText('Partly done: 2 rows were added; 1 were not.', { exact: false })).toBeVisible({ timeout: 12_000 });
  await expect(panel).toHaveCount(0);
  expect(backend.commits).toBe(1);
});

// ───────────── WQ11c re-review (N1–N7): pharmacy screens ─────────────

test('WQ11c (re-review N1): the template’s example row still in the file blocks adding, whatever the backend', async ({ page }) => {
  // An importer that knows no example mark reads the row as a valid new medicine.
  const example = { rowIndex: 2, medicineName: 'Paracetamol 500 mg tablet (example - delete this row)', status: 'valid',
    data: { name: 'Paracetamol 500 mg tablet (example - delete this row)', quantityToAdd: 100, batchNumber: 'PCM2412', expiryDate: '20271231', mrp: 30, retailPrice: 28,
      prescriptionRequired: false, medicineMatchStatus: 'not_found' } };
  const real = { rowIndex: 3, medicineName: 'Paracetamol', status: 'valid', data: { name: 'Paracetamol', quantityToAdd: 50, batchNumber: 'PCM-77', expiryDate: '20280131', mrp: 25, retailPrice: 22, medicineId: MED, medicineMatchStatus: 'matched', matchedMedicineName: 'Paracetamol' } };
  const now = new Date().toISOString();
  const backend = await mockBackend(page, { imports: [{ _id: IMP, fileName: 'stock-import-template.csv', importMode: 'upsert', status: 'previewed', totalRows: 2, validRows: 2, errorRows: 0, previewRows: [example, real], createdAt: now, updatedAt: now }] });
  await signIn(page, 'Stock');
  await page.goto(`/#/pharmacy/stock/imports/${IMP}`);
  await expect(page.getByText('Row 2 is the template’s example row (“(example - delete this row)”). Delete it from the file and upload the file again before adding anything.')).toBeVisible();
  await expect(page.getByRole('button', { name: /ready rows? to stock/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Discard this preview…' })).toBeVisible();
  expect(backend.commits).toBe(0);
});

test('WQ11c (re-review N2): Add stock names the supplier only when the recorded delivery carries it', async ({ page }) => {
  const backend = await mockBackend(page, { suppliers: [supplier({})] });
  // A backend that drops the unknown key (stripUnknown) saves the stock without the supplier.
  let drop = true;
  await page.route('**/api/v1/pharmacy-inventory', async (route) => {
    if (route.request().method() !== 'POST' || !drop) return route.fallback();
    const body = route.request().postDataJSON() as { items: Json[] };
    for (const it of body.items) delete it.supplierId;
    return route.fallback({ postData: JSON.stringify(body) });
  });
  await signIn(page, 'Stock');
  await page.getByRole('link', { name: 'Add a batch of Paracetamol 650mg' }).click();
  await fillBatch(page);
  await page.getByLabel('Supplier (optional)').selectOption({ label: 'Sun Distributors' });
  await page.getByRole('button', { name: 'Check and add' }).click();
  await page.getByRole('button', { name: 'Yes, add to stock' }).click();
  await expect(page.getByText('Added 100 units of Paracetamol 650mg, batch PCM-24B (expires 30 Jun 2028) (supplier not recorded).')).toBeVisible();
  await expect(page.getByText(/from Sun Distributors/)).toHaveCount(0);
  expect(backend.adjustments[0]).toMatchObject({ supplier: null });
  // A backend that records it: named.
  drop = false;
  await fillBatch(page, '20');
  await page.getByLabel('Supplier (optional)').selectOption({ label: 'Sun Distributors' });
  await page.getByRole('button', { name: 'Check and add' }).click();
  await page.getByRole('button', { name: 'Yes, add to stock' }).click();
  await expect(page.getByText('Added 20 units of Paracetamol 650mg, batch PCM-24B (expires 30 Jun 2028) from Sun Distributors.')).toBeVisible();
});

test('WQ11d: "Added …" shows at once from the save, the supplier line "checking" until the history read answers; the form is cleared meanwhile', async ({ page }) => {
  const backend = await mockBackend(page, { suppliers: [supplier({})] });
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => { release = r; });
  await page.route('**/api/v1/pharmacy-inventory/adjustments**', async (route) => { await gate; await route.fallback(); });
  await signIn(page, 'Stock');
  await page.getByRole('link', { name: 'Add a batch of Paracetamol 650mg' }).click();
  await fillBatch(page);
  await page.getByLabel('Supplier (optional)').selectOption({ label: 'Sun Distributors' });
  await page.getByRole('button', { name: 'Check and add' }).click();
  await page.getByRole('button', { name: 'Yes, add to stock' }).click();
  // The history read is held: the entry is confirmed anyway, and the form no longer holds it.
  await expect(page.getByText('Added 100 units of Paracetamol 650mg, batch PCM-24B (expires 30 Jun 2028) (checking the supplier…).')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Yes, add to stock' })).toHaveCount(0);
  await expect(page.getByLabel('Batch number')).toHaveValue('');
  release();
  await expect(page.getByText('Added 100 units of Paracetamol 650mg, batch PCM-24B (expires 30 Jun 2028) from Sun Distributors.')).toBeVisible();
  expect(backend.adjustments).toHaveLength(1);
});

test('WQ11c (re-review N2): a file supplier the server did not keep is said, and none is shown', async ({ page }) => {
  const backend = await mockBackend(page, { suppliers: [supplier({})] });
  // A preview that ignores the `supplierId` form field.
  await page.route('**/api/v1/pharmacy-inventory-imports/preview', (route) => {
    const rec = { _id: IMP, fileName: 'us.csv', importMode: 'upsert', status: 'previewed', totalRows: 3, validRows: 2, errorRows: 1, previewRows: PREVIEW_ROWS,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    backend.imports = [rec];
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: rec }) });
  });
  await signIn(page, 'Stock');
  await page.getByRole('link', { name: 'Import stock from a file' }).click();
  await page.getByLabel('Supplier of this delivery (optional)').selectOption({ label: 'Sun Distributors' });
  await page.getByLabel('Stock file').setInputFiles({ name: 'us.csv', mimeType: 'text/csv', buffer: Buffer.from('medicine name\r\nX\r\n') });
  await page.getByRole('button', { name: 'Check the file' }).click();
  await expect(page).toHaveURL(new RegExp(`imports/${IMP}`));
  await expect(page.getByText('You chose Sun Distributors as the supplier of this file, but the server did not record a supplier for it: no supplier is recorded for these rows.')).toBeVisible();
  await expect(page.locator('.ws-dl')).not.toContainText('Sun Distributors');
});

test('WQ11c (re-review N3): a preview cannot be discarded while its confirmation is on its way', async ({ page }) => {
  const now = new Date().toISOString();
  const backend = await mockBackend(page, { imports: [{ _id: IMP, fileName: 'restock.csv', importMode: 'upsert', status: 'previewed', totalRows: 3, validRows: 2, errorRows: 1, previewRows: PREVIEW_ROWS, createdAt: now, updatedAt: now }] });
  let release: () => void = () => undefined;
  const held = new Promise<void>((r) => { release = r; });
  await page.route('**/api/v1/pharmacy-inventory-imports/commit', async (route) => { await held; return route.fallback(); });
  await signIn(page, 'Stock');
  await page.goto(`/#/pharmacy/stock/imports/${IMP}`);
  await page.getByRole('button', { name: /Add 2 ready rows to stock/ }).click();
  await page.getByRole('button', { name: 'Yes, add them' }).click(); // held at the server
  await expect(page.getByRole('button', { name: 'Discard this preview…' })).toBeDisabled();
  release();
  await expect(page.getByText('Partly done: 2 rows were added; 1 were not.', { exact: false })).toBeVisible();
  await expect(page.getByText('You discarded this preview', { exact: false })).toHaveCount(0);
  expect(backend.commits).toBe(1);
});

test('WQ11c (re-review N4): a listed medicine not yet in my stock with a blank price is not on sale until priced; a known current price is named', async ({ page }) => {
  const rows = [
    { rowIndex: 2, medicineName: 'Cetirizine', status: 'valid', data: { name: 'Cetirizine', quantityToAdd: 10, batchNumber: 'CT-1', expiryDate: '20280131', medicineId: MED2, medicineMatchStatus: 'matched', matchedMedicineName: 'Cetirizine' }, inMyStock: false, currentPrices: null },
    { rowIndex: 3, medicineName: 'Paracetamol', status: 'valid', data: { name: 'Paracetamol', quantityToAdd: 5, batchNumber: 'P-1', expiryDate: '20280131', medicineId: MED, medicineMatchStatus: 'matched', matchedMedicineName: 'Paracetamol', wholesalePrice: 18 }, inMyStock: true, batchInStock: true, currentPrices: { mrp: 25, retailPrice: 22, wholesalePrice: 16, purchasePrice: null } },
    // Q16d: a new batch of a medicine in stock: its MRP is not kept from another batch (null), the selling price is.
    { rowIndex: 4, medicineName: 'Ibuprofen', status: 'valid', data: { name: 'Ibuprofen', quantityToAdd: 3, batchNumber: 'IB-NEW', expiryDate: '20280131', medicineId: MED, medicineMatchStatus: 'matched', matchedMedicineName: 'Ibuprofen' }, inMyStock: true, batchInStock: false, currentPrices: { mrp: null, retailPrice: 40, wholesalePrice: null, purchasePrice: null } },
  ];
  const now = new Date().toISOString();
  await mockBackend(page, { imports: [{ _id: IMP, fileName: 'first-stock.csv', importMode: 'upsert', status: 'previewed', totalRows: 3, validRows: 3, errorRows: 0, previewRows: rows, createdAt: now, updatedAt: now }] });
  await signIn(page, 'Stock');
  await page.goto(`/#/pharmacy/stock/imports/${IMP}`);
  const table = page.getByRole('table', { name: 'Rows of the file, problems first' });
  const cet = table.getByRole('row').filter({ hasText: 'Cetirizine' });
  await expect(cet).toContainText('No price yet');
  await expect(cet).toContainText('Not on sale until priced');
  await expect(cet).not.toContainText('Current price kept');
  const para = table.getByRole('row').filter({ hasText: 'Paracetamol' });
  await expect(para).toContainText('Kept: ₹22.00');
  // N7: the wholesale price this row changes is shown (purchase prices are not changed: no column).
  await expect(table.getByRole('columnheader', { name: 'Wholesale price' })).toBeVisible();
  await expect(table.getByRole('columnheader', { name: 'Purchase price' })).toHaveCount(0);
  await expect(para).toContainText('₹18.00');
  // Q16d: the new batch shows no MRP (another batch's is never offered as kept); its selling price is kept.
  const ibu = table.getByRole('row').filter({ hasText: 'Ibuprofen' });
  await expect(ibu).toContainText('No MRP yet');
  await expect(ibu).toContainText('Kept: ₹40.00');
  await page.getByRole('button', { name: 'Add 3 ready rows to stock…' }).click();
  await expect(page.getByRole('group', { name: 'Add 3 ready rows to stock…' })).toContainText('1 row leaves its medicine without a selling price: not on sale until priced (row 2 (Cetirizine)).');
});

test('WQ11c (re-review N5): one failed read again keeps the import page, with a quiet note', async ({ page }) => {
  const now = new Date().toISOString();
  const backend = await mockBackend(page, { imports: [{ _id: IMP, fileName: 'restock.csv', importMode: 'upsert', status: 'previewed', totalRows: 3, validRows: 2, errorRows: 1, previewRows: PREVIEW_ROWS, createdAt: now, updatedAt: now }] });
  let down = false;
  await page.route(`**/api/v1/pharmacy-inventory-imports/${IMP}`, (route) => (down && route.request().method() === 'GET' ? route.abort('connectionreset') : route.fallback()));
  await page.route('**/api/v1/pharmacy-inventory-imports/commit', (route) => route.abort('connectionreset')); // never reaches the server
  await signIn(page, 'Stock');
  await page.goto(`/#/pharmacy/stock/imports/${IMP}`);
  await page.getByRole('button', { name: /Add 2 ready rows to stock/ }).click();
  await page.getByRole('button', { name: 'Yes, add them' }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed import step' });
  await expect(panel).toBeVisible();
  down = true;
  await expect(page.getByText(/Could not refresh just now/)).toBeVisible({ timeout: 20_000 });
  await expect(panel).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Import of restock.csv' })).toBeVisible();
  // A check meanwhile says it could not check (never "not started" from the old read).
  await panel.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(panel).toContainText('Could not check');
  expect(backend.commits).toBe(0);
});

test('WQ11c (re-review N6): a retry lost within 30 s of the previous outcome is not settled by that outcome', async ({ page }) => {
  const justNow = new Date(Date.now() - 5_000).toISOString();
  const partly: Json = { _id: IMP, fileName: 'stock.csv', importMode: 'upsert', status: 'partially_committed', totalRows: 2, validRows: 2, errorRows: 0,
    committedRows: 1, failedRows: 1, committedAt: justNow,
    previewRows: [{ rowIndex: 2, medicineName: 'A', status: 'committed', data: { quantityToAdd: 5 } }, { rowIndex: 3, medicineName: 'B', status: 'failed', errors: ['timeout'], data: { quantityToAdd: 5 } }],
    createdAt: justNow, updatedAt: justNow };
  const backend = await mockBackend(page, { imports: [partly] });
  await signIn(page, 'Stock');
  await page.goto(`/#/pharmacy/stock/imports/${IMP}`);
  backend.loseNextRetry = true; // it never reaches the server
  await page.getByRole('button', { name: 'Try the failed rows again…' }).click();
  await page.getByRole('button', { name: 'Yes, try again' }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed import step' });
  await expect(panel).toBeVisible();
  await page.waitForTimeout(7_000); // past one 5-second read again
  await expect(panel).toBeVisible();
  await expect(page.getByText('Partly done: 1 rows were added; 1 were not.', { exact: false })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(panel).toContainText('It has not started yet.');
  // Sent again, it runs once and its own outcome settles it.
  await panel.getByRole('button', { name: 'Send it again' }).click();
  await expect(page.getByText('Done: 2 rows were added to stock.')).toBeVisible();
  expect(backend.retries).toBe(1);
});
