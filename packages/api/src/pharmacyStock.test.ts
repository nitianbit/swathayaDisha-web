import { ApiError, createApiClient } from './client.ts';
import {
  IMPORT_COLUMNS, importCommittable, importFileProblem, importRetryable, importTemplateCsv, isImportClaimed, isRealYyyymmdd,
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
    const header = importTemplateCsv().trim().split(',');
    expect(header.slice(0, 4)).toEqual(['medicine name', 'quantity to add', 'batch number', 'expiry date']);
    expect(header).toEqual(expect.arrayContaining(['mrp', 'retail price', 'purchase price', 'rack location']));
    expect(header.every((h) => h === h.toLowerCase())).toBe(true);
    expect(IMPORT_COLUMNS.find((c) => c.header === 'expiry date')?.format).not.toMatch(/Text/);
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
