import { ApiError, createApiClient } from './client.ts';
import {
  IMPORT_COLUMNS, IMPORT_TIMEOUT_MS, importCommittable, importPlan, importPriceOf, importPriceView, isTemplateExample, importUploadRefusal, importZeroPrices, monthFirstRows, recentSameFile, serverToday, TEMPLATE_EXAMPLE_MARK,
  isSupplierRefusal, type ImportCurrentPrices, type ImportRow, type InventoryImport, importStuck, importFileProblem, importRetryable, importTemplateCsv, isImportClaimed, isRealYyyymmdd,
  pharmacyStockApi, stockEntryBody, stockEntryProblems, type StockEntryDraft,
} from './pharmacyStock.ts';
import { cancelRefusal, orderStatusLabel, paymentStatusLabel } from './pharmacyOrders.ts';

const MED = 'ab'.repeat(12);
const IMP = 'cd'.repeat(12);
const KEY = 'k'.repeat(32);

function recorder(answer: () => Response = () => new Response(JSON.stringify({ success: true, data: {} }), { status: 200 })) {
  const calls: { method: string; url: string; body: unknown; raw: unknown; headers: Record<string, string> }[] = [];
  const client = createApiClient({ baseUrl: 'https://api.example.test', getToken: () => 'tok',
    fetchImpl: async (u, init) => {
      const raw = init?.body;
      calls.push({ method: String(init?.method), url: String(u).replace('https://api.example.test/api/v1', ''), raw,
        body: typeof raw === 'string' ? JSON.parse(raw) : undefined, headers: (init?.headers ?? {}) as Record<string, string> });
      return answer();
    } });
  return { client, calls };
}

const draft = (o: Partial<StockEntryDraft> = {}): StockEntryDraft => ({
  medicineId: MED, batchNumber: ' pcm-24a ', expiry: '2027-06-30', quantity: '100', mrp: '', retailPrice: '', purchasePrice: '',
  rackLocation: '', reorderThreshold: '', reason: 'purchase', note: '', ...o,
});

describe('add stock (createInventoryItemSchema / saveItem)', () => {
  it('checks the draft like the server: batch, real unexpired date, whole units, rupees', () => {
    expect(stockEntryProblems(draft(), '20261120')).toEqual({});
    expect(stockEntryProblems(draft({ medicineId: '' }), '20261120').medicineId).toBeTruthy();
    expect(stockEntryProblems(draft({ batchNumber: '  ' }), '20261120').batchNumber).toBeTruthy();
    expect(stockEntryProblems(draft({ batchNumber: 'x'.repeat(101) }), '20261120').batchNumber).toMatch(/100/);
    expect(stockEntryProblems(draft({ expiry: '2027-02-31' }), '20261120').expiry).toBe('Enter the expiry date.');
    expect(stockEntryProblems(draft({ expiry: '2026-11-19' }), '20261120').expiry).toMatch(/expired/);
    expect(stockEntryProblems(draft({ expiry: '2026-11-20' }), '20261120').expiry).toBeUndefined(); // expiring today is accepted
    for (const quantity of ['0', '', '1.5', '-3']) expect(stockEntryProblems(draft({ quantity }), '20261120').quantity).toBeTruthy();
    expect(stockEntryProblems(draft({ mrp: '42.505' }), '20261120').mrp).toBeTruthy();
    expect(stockEntryProblems(draft({ mrp: '42.50', retailPrice: '40', purchasePrice: '31.2' }), '20261120')).toEqual({});
    expect(stockEntryProblems(draft({ reorderThreshold: '2.5' }), '20261120').reorderThreshold).toBeTruthy();
    expect(isRealYyyymmdd('20280229')).toBe(true);
    expect(isRealYyyymmdd('20270229')).toBe(false);
  });

  it('sends one item that only adds units with the request key beside it (Q15), the note as typed, prices only when given', async () => {
    const answers = [
      new Response(JSON.stringify({ success: true, data: [{ _id: 'i1' }] }), { status: 201 }),
      new Response(JSON.stringify({ success: true, data: [{ _id: 'i1' }], replayed: true }), { status: 200 }),
    ];
    const { client, calls } = recorder(() => answers.shift()!);
    const body = stockEntryBody(draft({ mrp: '42.50', rackLocation: ' B2 ', reorderThreshold: '20', note: ' Bill 77 ' }));
    expect(body).toEqual({
      medicineId: MED, quantity: 100, batchNumber: 'pcm-24a', expiryDate: '20270630', reason: 'purchase',
      notes: 'Bill 77', mrp: 42.5, rackLocation: 'B2', reorderThreshold: 20,
    });
    expect('notes' in stockEntryBody(draft())).toBe(false);
    const api = pharmacyStockApi(client);
    expect(await api.addStock(body, KEY)).toEqual({ items: [{ _id: 'i1' }], replayed: false });
    expect(await api.addStock(body, KEY)).toEqual({ items: [{ _id: 'i1' }], replayed: true });
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/pharmacy-inventory', body: { items: [body], requestKey: KEY } });
    expect(calls[1]!.body).toEqual(calls[0]!.body); // a resend is the same request
    await expect(api.addStock(body, 'bad key!')).rejects.toThrow('Invalid request key');
  });

  it('looks a lost entry up by its key: the items it saved, or null on 404 (nothing so far)', async () => {
    const answers = [
      new Response(JSON.stringify({ success: true, data: [{ _id: 'i1', availableQty: 100 }] }), { status: 200 }),
      new Response(JSON.stringify({ error: 404, code: 'REQUEST_KEY_NOT_FOUND', message: 'Nothing was saved with this key' }), { status: 404 }),
      new Response(JSON.stringify({ error: 500, message: 'boom' }), { status: 500 }),
    ];
    const { client, calls } = recorder(() => answers.shift()!);
    const api = pharmacyStockApi(client);
    expect(await api.savedByKey(KEY)).toEqual([{ _id: 'i1', availableQty: 100 }]);
    expect(await api.savedByKey(KEY)).toBeNull();
    await expect(api.savedByKey(KEY)).rejects.toThrow('boom');
    expect(calls.map((c) => c.url)).toEqual(Array(3).fill(`/pharmacy-inventory/by-key/${KEY}`));
    await expect(api.savedByKey('../x')).rejects.toThrow('Invalid request key');
  });

  it('review: only REQUEST_KEY_NOT_FOUND means "nothing so far"; another 404 stays unknown. Q15 abandon: abandoned or used', async () => {
    const answers = [
      new Response(JSON.stringify({ error: 404, code: 'NOT_FOUND', message: 'Not found' }), { status: 404 }),
      new Response(JSON.stringify({ success: true, data: { state: 'abandoned' } }), { status: 200 }),
      new Response(JSON.stringify({ success: true, data: { state: 'used', items: [{ _id: 'i1' }] } }), { status: 200 }),
    ];
    const { client, calls } = recorder(() => answers.shift()!);
    const api = pharmacyStockApi(client);
    await expect(api.savedByKey(KEY)).rejects.toThrow('Not found');
    expect(await api.abandonStock(KEY)).toEqual({ state: 'abandoned' });
    expect(await api.abandonStock(KEY)).toEqual({ state: 'used', items: [{ _id: 'i1' }] });
    expect(calls.slice(1).map((c) => `${c.method} ${c.url}`)).toEqual(Array(2).fill(`POST /pharmacy-inventory/by-key/${KEY}/abandon`));
    expect(() => api.abandonStock('x')).toThrow('Invalid request key');
  });

  it('searches active medicines with pagination and reads the stock history', async () => {
    const { client, calls } = recorder(() => new Response(JSON.stringify({ success: true, data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } }), { status: 200 }));
    const api = pharmacyStockApi(client);
    await api.medicines(' para ');
    await api.adjustments(2, 100);
    expect(calls[0]!.url).toBe('/pharmacy-medicines?search=para&isActive=true&page=1&limit=20');
    expect(calls[1]!.url).toBe('/pharmacy-inventory/adjustments?page=2&limit=100');
    expect(() => api.medicine('nope')).toThrow();
  });
});

describe('stock imports (pharmacyInventoryImports)', () => {
  it('accepts only .xlsx, .xls and .csv files up to 10 MB', () => {
    expect(importFileProblem(null)).toMatch(/Choose/);
    expect(importFileProblem({ name: 'stock.XLSX', size: 10 })).toBeNull();
    expect(importFileProblem({ name: 'stock.csv', size: 10 * 1024 * 1024 })).toBeNull();
    expect(importFileProblem({ name: 'stock.csv', size: 10 * 1024 * 1024 + 1 })).toMatch(/10 MB/);
    expect(importFileProblem({ name: 'stock.pdf', size: 10 })).toMatch(/Excel/);
    expect(importFileProblem({ name: 'stock.csv', size: 0 })).toMatch(/empty/);
  });

  it('offers a template with the headers the server reads (any case since Q15), and expiry as a date or text', () => {
    const [headerLine, example] = importTemplateCsv().trim().split('\r\n');
    const header = headerLine!.split(',');
    expect(header.slice(0, 4)).toEqual(['medicine name', 'quantity to add', 'batch number', 'expiry date']);
    expect(header).toEqual(expect.arrayContaining(['mrp', 'retail price', 'purchase price', 'rack location']));
    expect(header.every((h) => h === h.toLowerCase())).toBe(true);
    expect(IMPORT_COLUMNS.find((c) => c.header === 'expiry date')?.format).not.toMatch(/Text/);
    // WQ11c (owner, 22 Nov): one example row, expiry day first, one value per column.
    const cells = example!.split(',');
    expect(cells).toHaveLength(header.length);
    expect(cells[header.indexOf('expiry date')]).toBe('31-12-2027');
    expect(cells[header.indexOf('prescription required')]).toBe('no');
    // Q16c: the server's column order (supplier last) and its example mark (the importer refuses that row).
    expect(header.at(-1)).toBe('supplier');
    expect(cells[0]).toContain(TEMPLATE_EXAMPLE_MARK);
  });

  it('uploads the file as multipart `file` with the mode, commits by id, retries and lists', async () => {
    const { client, calls } = recorder(() => new Response(JSON.stringify({ success: true, data: { _id: IMP } }), { status: 200 }));
    const api = pharmacyStockApi(client);
    await api.previewImport(new File(['medicine name\n'], 'stock.csv', { type: 'text/csv' }), 'stock.csv', 'update_only');
    const form = calls[0]!.raw as FormData;
    expect(calls[0]!.url).toBe('/pharmacy-inventory-imports/preview');
    expect(form.get('importMode')).toBe('update_only');
    expect((form.get('file') as File).name).toBe('stock.csv');
    expect(calls[0]!.headers['Content-Type']).toBeUndefined();
    await api.commitImport(IMP);
    await api.retryImport(IMP);
    await api.import(IMP);
    expect(calls.slice(1).map((c) => [c.method, c.url, c.body])).toEqual([
      ['POST', '/pharmacy-inventory-imports/commit', { importId: IMP }],
      ['POST', `/pharmacy-inventory-imports/${IMP}/retry`, undefined],
      ['GET', `/pharmacy-inventory-imports/${IMP}`, undefined],
    ]);
    expect(() => api.commitImport('../x')).toThrow();
  });

  it('knows when an import can be confirmed or retried, and a claimed commit', () => {
    expect(importCommittable({ status: 'previewed', validRows: 2 })).toBe(true);
    expect(importCommittable({ status: 'previewed', validRows: 0 })).toBe(false);
    expect(importCommittable({ status: 'committed', validRows: 2 })).toBe(false);
    expect(importRetryable({ status: 'partially_committed', previewRows: [{ rowIndex: 2, status: 'failed' }] })).toBe(true);
    expect(importRetryable({ status: 'partially_committed', previewRows: [{ rowIndex: 2, status: 'error' }] })).toBe(false);
    expect(importRetryable({ status: 'committed', previewRows: [] })).toBe(false);
    expect(isImportClaimed(new ApiError(409, 'x', 'IMPORT_NOT_RETRYABLE'))).toBe(true);
    expect(isImportClaimed(new ApiError(409, 'x', 'IMPORT_ALREADY_PROCESSING'))).toBe(true);
    expect(isImportClaimed(new ApiError(409, 'x', 'OTHER'))).toBe(false);
  });

  it('review: an import stuck in committing for over 15 minutes can be retried (staleCommitting); a fresh one cannot', () => {
    const now = Date.parse('2026-11-20T12:00:00Z');
    const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
    expect(importStuck({ status: 'committing', updatedAt: at(16) }, now)).toBe(true);
    expect(importStuck({ status: 'committing', updatedAt: at(14) }, now)).toBe(false);
    expect(importStuck({ status: 'committing' }, now)).toBe(false);
    expect(importStuck({ status: 'previewed', updatedAt: at(60) }, now)).toBe(false);
    expect(importRetryable({ status: 'committing', updatedAt: at(16), previewRows: [] }, now)).toBe(true);
    expect(importRetryable({ status: 'committing', updatedAt: at(1), previewRows: [] }, now)).toBe(false);
  });
});

describe('orders: shared words and the cancel rule (requestCancel)', () => {
  it('labels statuses and payments in words', () => {
    expect(orderStatusLabel('pending_cancel')).toBe('Cancellation requested');
    expect(paymentStatusLabel(undefined)).toBe('Unpaid');
    expect(paymentStatusLabel('pending')).toBe('Unpaid');
    expect(paymentStatusLabel('partially_paid')).toBe('Partly paid');
  });
  it('allows a cancel request from Placed, Accepted or Packed, unpaid or holding money; never a refunded one', () => {
    for (const status of ['placed', 'accepted', 'packed'] as const) {
      for (const paymentStatus of [undefined, 'pending', 'failed', 'paid', 'authorized', 'partially_paid'] as const) {
        expect(cancelRefusal({ status, paymentStatus })).toBeNull();
      }
      expect(cancelRefusal({ status, paymentStatus: 'refunded' })).toBe('payment');
    }
    for (const status of ['ready_for_pickup', 'out_for_delivery', 'pending_cancel', 'completed', 'cancelled'] as const) {
      expect(cancelRefusal({ status, paymentStatus: 'paid' })).toBe('state');
    }
  });
});

describe('WQ11c: prices, prescriptions, suppliers and long imports', () => {
  const row = (rowIndex: number, data: ImportRow['data'], status: ImportRow['status'] = 'valid'): ImportRow => ({ rowIndex, medicineName: data?.name ?? 'X', status, data });

  it('a blank price keeps the current one; 0 is a price of ₹0 and is named', () => {
    expect(importPriceOf(undefined)).toBe('keep');
    expect(importPriceOf(null)).toBe('keep');
    expect(importPriceOf(0)).toBe(0);
    expect(importPriceOf(12.5)).toBe(12.5);
    expect(importZeroPrices(row(2, { mrp: 0, retailPrice: 0, purchasePrice: 3 }))).toEqual(['MRP', 'selling price']);
    expect(importZeroPrices(row(2, { mrp: 10 }))).toEqual([]);
  });

  it('the plan follows the mode: new medicines skipped in "already in my stock", prescription default, unpriced new ones', () => {
    const rows = [
      row(2, { name: 'Known', quantityToAdd: 10, medicineMatchStatus: 'matched', mrp: 5 }),
      row(3, { name: 'New Rx', quantityToAdd: 4, medicineMatchStatus: 'not_found' }),
      row(4, { name: 'New OTC', quantityToAdd: 6, medicineMatchStatus: 'not_found', prescriptionRequired: false, retailPrice: 0 }),
      row(5, { name: 'Bad' }, 'error'),
    ];
    const upsert = importPlan({ importMode: 'upsert', previewRows: rows });
    expect(upsert).toMatchObject({ rows: 3, units: 20, skippedNew: 0, newMedicines: 2, newNeedingPrescription: 1, mayBeSkipped: 0 });
    expect(upsert.unpriced.map((r) => r.rowIndex)).toEqual([3, 4]);
    expect(upsert.priceChanges.map((r) => r.rowIndex)).toEqual([2, 4]);
    expect(upsert.zeroPrices.map((r) => r.rowIndex)).toEqual([4]);
    expect(importPlan({ importMode: 'update_only', previewRows: rows })).toMatchObject({ rows: 1, units: 10, skippedNew: 2, newMedicines: 0 });
    expect(importPlan({ importMode: 'create_only', previewRows: rows })).toMatchObject({ rows: 3, mayBeSkipped: 1 });
  });

  it('finds another import of the same file added in the last 24 hours', () => {
    const now = Date.parse('2026-11-22T12:00:00Z');
    const me = { _id: IMP, fileName: 'a.csv' } as InventoryImport;
    const other = (o: Partial<InventoryImport>) => ({ _id: MED, fileName: 'a.csv', importMode: 'upsert', status: 'committed', totalRows: 1, validRows: 1, errorRows: 0, ...o }) as InventoryImport;
    expect(recentSameFile(me, [other({ committedAt: '2026-11-22T02:00:00Z' })], now)?._id).toBe(MED);
    expect(recentSameFile(me, [other({ committedAt: '2026-11-21T11:00:00Z' })], now)).toBeNull();
    expect(recentSameFile(me, [other({ status: 'previewed', createdAt: '2026-11-22T11:00:00Z' })], now)).toBeNull();
    expect(recentSameFile(me, [other({ fileName: 'b.csv', committedAt: '2026-11-22T11:00:00Z' })], now)).toBeNull();
    expect(recentSameFile(me, [{ ...me, status: 'committed', committedAt: '2026-11-22T11:00:00Z' } as InventoryImport], now)).toBeNull();
  });

  it('upload refusals in words, with the server words for codes not known yet', () => {
    // Q16c upload codes.
    expect(importUploadRefusal(new ApiError(400, 'x', 'FILE_TOO_LARGE'))).toMatch(/10 MB/);
    expect(importUploadRefusal(new ApiError(400, 'x', 'IMPORT_FILE_EMPTY'))).toMatch(/no rows/);
    expect(importUploadRefusal(new ApiError(400, 'x', 'UNSUPPORTED_FILE_TYPE'))).toMatch(/Excel/);
    expect(importUploadRefusal(new ApiError(400, 'x', 'IMPORT_COLUMNS_MISSING'))).toMatch(/medicine name/);
    expect(importUploadRefusal(new ApiError(400, 'x', 'IMPORT_FILE_TOO_BIG'))).toMatch(/too big to import at once.*Split it/);
    expect(importUploadRefusal(new ApiError(400, 'Something new', 'NEW_CODE'))).toBe('Something new');
    const rows = [row(2, undefined, 'error'), { ...row(3, undefined, 'error'), errors: ['this file writes dates month first (row 3: 12/31/2027), so 05/06/2027 cannot be read safely'] }];
    expect(monthFirstRows(rows).map((r) => r.rowIndex)).toEqual([3]);
  });

  it('a delivery names its supplier; upload, commit and retry wait 2 minutes; the supplier of a whole file is sent', async () => {
    const SUP = 'ef'.repeat(12);
    const d = draft({ supplierId: SUP.toUpperCase() });
    expect(stockEntryBody(d).supplierId).toBe(SUP);
    expect(stockEntryBody({ ...d, supplierId: '' }).supplierId).toBeUndefined();
    expect(stockEntryProblems({ ...d, supplierId: 'nope' }).supplierId).toBeTruthy();
    expect(isSupplierRefusal(new ApiError(409, 'x', 'SUPPLIER_ARCHIVED'))).toBe(true);
    expect(isSupplierRefusal(new ApiError(404, 'x', 'SUPPLIER_NOT_FOUND'))).toBe(true);
    expect(IMPORT_TIMEOUT_MS).toBe(120_000);
    const { client, calls } = recorder();
    await pharmacyStockApi(client).previewImport(new Blob(['a']), 'a.csv', 'upsert', SUP);
    expect((calls[0]!.raw as FormData).get('supplierId')).toBe(SUP);
  });

  it('the server template when there is one; otherwise null (the page makes one)', async () => {
    const ok = recorder(() => new Response('a,b', { status: 200, headers: { 'Content-Type': 'text/csv' } }));
    expect(await pharmacyStockApi(ok.client).importTemplate()).toBeInstanceOf(Blob);
    expect(ok.calls[0]!.url).toBe('/pharmacy-inventory-imports/template');
    const missing = recorder(() => new Response(JSON.stringify({ error: 500, message: 'Cast to ObjectId failed' }), { status: 500 }));
    expect(await pharmacyStockApi(missing.client).importTemplate()).toBeNull();
  });

  it('"today" for expiry is the India date (Q16c)', () => {
    expect(serverToday(new Date('2026-11-21T19:00:00Z'))).toBe('20261122'); // 00:30 IST
    expect(serverToday(new Date('2026-11-21T18:00:00Z'))).toBe('20261121'); // 23:30 IST
  });
});

describe('WQ11c re-review: what a blank price leaves, and the template example', () => {
  const row = (data: ImportRow['data'], medicineName = 'X', stock: Pick<ImportRow, 'inMyStock' | 'batchInStock' | 'currentPrices'> = {}): ImportRow =>
    ({ rowIndex: 2, medicineName, status: 'valid', data, ...stock });
  const prices = (p: Partial<ImportCurrentPrices>): ImportCurrentPrices => ({ mrp: null, retailPrice: null, wholesalePrice: null, purchasePrice: null, ...p });
  it('a blank cell keeps a current price only when there is one (Q16c inMyStock / currentPrices)', () => {
    expect(importPriceView(row({ retailPrice: 0 }), 'retailPrice')).toEqual({ kind: 'set', value: 0 });
    expect(importPriceView(row({ medicineMatchStatus: 'not_found' }), 'retailPrice')).toEqual({ kind: 'none' });
    expect(importPriceView(row({ medicineMatchStatus: 'matched' }, 'X', { inMyStock: false, currentPrices: null }), 'retailPrice')).toEqual({ kind: 'none' });
    expect(importPriceView(row({ medicineMatchStatus: 'matched' }, 'X', { inMyStock: true, currentPrices: prices({ retailPrice: 22 }) }), 'retailPrice')).toEqual({ kind: 'kept', value: 22 });
    expect(importPriceView(row({ medicineMatchStatus: 'matched' }, 'X', { inMyStock: true, currentPrices: prices({ mrp: 30 }) }), 'retailPrice')).toEqual({ kind: 'none' });
    expect(importPriceView(row({ medicineMatchStatus: 'matched' }), 'retailPrice')).toEqual({ kind: 'unknown' });
    // Q16d: MRP is the batch's own; a new batch (batchInStock false, mrp null) has none, the selling price is still kept.
    const newBatch = { inMyStock: true, batchInStock: false, currentPrices: prices({ retailPrice: 22 }) };
    expect(importPriceView(row({ medicineMatchStatus: 'matched' }, 'X', newBatch), 'mrp')).toEqual({ kind: 'none' });
    expect(importPriceView(row({ medicineMatchStatus: 'matched' }, 'X', newBatch), 'retailPrice')).toEqual({ kind: 'kept', value: 22 });
    expect(importPriceView(row({ medicineMatchStatus: 'matched' }, 'X', { inMyStock: true, batchInStock: true, currentPrices: prices({ mrp: 30 }) }), 'mrp'))
      .toEqual({ kind: 'kept', value: 30 });
    const plan = importPlan({ importMode: 'upsert', previewRows: [
      row({ medicineMatchStatus: 'matched', quantityToAdd: 1 }, 'X', { inMyStock: false, currentPrices: null }),
      row({ medicineMatchStatus: 'matched', quantityToAdd: 1 }, 'X', { inMyStock: true, currentPrices: prices({ retailPrice: 9 }) }),
    ] });
    expect(plan.unpriced).toHaveLength(1);
  });
  it('finds the template example row by its mark, in any case', () => {
    expect(isTemplateExample(row({ name: 'Paracetamol 500 mg tablet (Example - delete this row)' }))).toBe(true);
    expect(isTemplateExample(row({ name: 'Paracetamol' }), )).toBe(false);
    expect(importPlan({ importMode: 'upsert', previewRows: [row({ name: `A ${TEMPLATE_EXAMPLE_MARK}` }, `A ${TEMPLATE_EXAMPLE_MARK}`)] }).examples).toHaveLength(1);
  });
});
