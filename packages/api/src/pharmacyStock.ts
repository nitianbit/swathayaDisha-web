import { ApiError, type ApiClient, type Page } from './client.ts';
import type { InventoryItem, MedicineRef } from './inventory.ts';

/**
 * WQ10a: adding stock by hand and importing a stock file.
 *
 * Add stock mirrors src1/modules/pharmacyInventory: `POST /pharmacy-inventory` (`createInventoryItemSchema`, one item;
 * InventoryService.saveItem → `adjustBatchStock`): a positive `quantity` needs `batchNumber` and a real, unexpired
 * `expiryDate` (YYYYMMDD); the batch is matched on its upper-cased number and expiry, prices are rupees. Every saved
 * change writes an adjustment (`GET /pharmacy-inventory/adjustments`, newest first) carrying the request's `notes`.
 * Q15: the save takes a `requestKey` (exactly once per pharmacy and key; the same key and items again answer 200
 * `replayed: true` without adding stock again), and `GET /pharmacy-inventory/by-key/:key` returns what a key saved (404
 * REQUEST_KEY_NOT_FOUND = nothing so far). Stock rows have no supplier field.
 *
 * Imports mirror src1/modules/pharmacyInventoryImports: `POST /preview` (multipart `file` + `importMode`), `POST /commit`
 * (`importId`), `POST /:id/retry`, `GET /`, `GET /:id`, `GET /:id/failed-rows/download`.
 */

/** pharmacyMedicines model (fields the picker shows). */
export interface Medicine extends MedicineRef {
  manufacturer?: string;
  prescriptionRequired?: boolean;
  isActive?: boolean;
}

/** Adjustment reasons the inventory create accepts (`adjustmentReasons`), with the words staff use for adding stock. */
export const ADD_STOCK_REASONS = [
  { value: 'purchase', label: 'New purchase' },
  { value: 'return', label: 'Returned stock put back' },
  { value: 'transfer', label: 'Transfer from another shop' },
  { value: 'correction', label: 'Stock count correction' },
  { value: 'other', label: 'Other' },
] as const;
export type AddStockReason = (typeof ADD_STOCK_REASONS)[number]['value'];

/** createInventoryItemBodySchema limits. */
export const STOCK_LIMITS = { batchNumber: 100, rackLocation: 100, notes: 500 } as const;
/** The note's limit (`notes` max 500). */
export const MAX_STOCK_NOTE = STOCK_LIMITS.notes;
/** Q15 `PHARMACY_REQUEST_KEY`: the keys inventory saves and supplier creates take. */
export const PHARMACY_REQUEST_KEY_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;

export interface StockEntryDraft {
  medicineId: string;
  batchNumber: string;
  /** YYYY-MM-DD from a date input. */
  expiry: string;
  quantity: string;
  mrp: string;
  retailPrice: string;
  purchasePrice: string;
  rackLocation: string;
  reorderThreshold: string;
  reason: AddStockReason;
  note: string;
}

/** One item of `POST /pharmacy-inventory` as this app sends it (only ever adding units). */
export interface StockEntry {
  medicineId: string;
  quantity: number;
  batchNumber: string;
  expiryDate: string;
  reason: AddStockReason;
  notes?: string;
  mrp?: number;
  retailPrice?: number;
  purchasePrice?: number;
  rackLocation?: string;
  reorderThreshold?: number;
}

/** inventory adjustment (`IInventoryAdjustment`, `medicineId` populated with name and generic name). */
export interface StockAdjustment {
  _id: string;
  medicineId: MedicineRef | string;
  adjustmentType: 'add' | 'remove' | 'correction';
  quantity: number;
  batchNumber?: string;
  expiryDate?: string;
  availableQtyBefore?: number;
  availableQtyAfter?: number;
  sourceType?: 'manual' | 'inventory_import' | 'order';
  reason?: string;
  notes?: string;
  createdAt?: string;
}

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const RUPEES = /^\d+(\.\d{1,2})?$/;

/** isValidInventoryDate: a real calendar date in YYYYMMDD. */
export function isRealYyyymmdd(v: string): boolean {
  if (!/^\d{8}$/.test(v)) return false;
  const y = Number(v.slice(0, 4)); const m = Number(v.slice(4, 6)); const d = Number(v.slice(6, 8));
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** The server's "today" (UTC date, as `saveItem` computes it): stock expiring before it is refused (BATCH_ALREADY_EXPIRED). */
export const serverToday = (now = new Date()) => now.toISOString().slice(0, 10).replace(/-/g, '');

/** What is wrong with the draft, field by field (the server checks the same and still decides). */
export function stockEntryProblems(d: StockEntryDraft, today = serverToday()): Partial<Record<keyof StockEntryDraft, string>> {
  const e: Partial<Record<keyof StockEntryDraft, string>> = {};
  if (!OBJECT_ID.test(d.medicineId)) e.medicineId = 'Choose the medicine.';
  const batch = d.batchNumber.trim();
  if (!batch) e.batchNumber = 'Enter the batch number printed on the pack.';
  else if (batch.length > STOCK_LIMITS.batchNumber) e.batchNumber = `At most ${STOCK_LIMITS.batchNumber} characters.`;
  const expiry = d.expiry.replace(/-/g, '');
  if (!isRealYyyymmdd(expiry)) e.expiry = 'Enter the expiry date.';
  else if (expiry < today) e.expiry = 'This batch has expired. Expired stock cannot be added.';
  const qty = d.quantity.trim();
  if (!/^\d+$/.test(qty) || !Number.isSafeInteger(Number(qty)) || Number(qty) < 1) e.quantity = 'Enter the number of units, at least 1.';
  for (const k of ['mrp', 'retailPrice', 'purchasePrice'] as const) {
    const v = d[k].trim();
    if (v && !RUPEES.test(v)) e[k] = 'Enter an amount in rupees, e.g. 42.50.';
  }
  if (d.rackLocation.trim().length > STOCK_LIMITS.rackLocation) e.rackLocation = `At most ${STOCK_LIMITS.rackLocation} characters.`;
  const reorder = d.reorderThreshold.trim();
  if (reorder && (!/^\d+$/.test(reorder) || !Number.isSafeInteger(Number(reorder)))) e.reorderThreshold = 'Enter a whole number of units.';
  if (d.note.trim().length > MAX_STOCK_NOTE) e.note = `At most ${MAX_STOCK_NOTE} characters.`;
  if (!ADD_STOCK_REASONS.some((r) => r.value === d.reason)) e.reason = 'Choose why the stock is added.';
  return e;
}

/** The request for a checked draft (one item that only adds units; prices only when given). */
export function stockEntryBody(d: StockEntryDraft): StockEntry {
  const money = (v: string) => (v.trim() ? Number(v.trim()) : undefined);
  const note = d.note.trim();
  const body: StockEntry = {
    medicineId: d.medicineId,
    quantity: Number(d.quantity.trim()),
    batchNumber: d.batchNumber.trim(),
    expiryDate: d.expiry.replace(/-/g, ''),
    reason: d.reason,
  };
  if (note) body.notes = note;
  const mrp = money(d.mrp); if (mrp !== undefined) body.mrp = mrp;
  const retail = money(d.retailPrice); if (retail !== undefined) body.retailPrice = retail;
  const purchase = money(d.purchasePrice); if (purchase !== undefined) body.purchasePrice = purchase;
  if (d.rackLocation.trim()) body.rackLocation = d.rackLocation.trim();
  if (d.reorderThreshold.trim()) body.reorderThreshold = Number(d.reorderThreshold.trim());
  return body;
}

const checkKey = (key: string) => {
  if (!PHARMACY_REQUEST_KEY_PATTERN.test(key)) throw new Error('Invalid request key');
  return key;
};

// ── Imports ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type ImportMode = 'create_only' | 'update_only' | 'upsert';
export type ImportStatus = 'pending' | 'previewed' | 'committing' | 'committed' | 'partially_committed' | 'failed';
export type ImportRowStatus = 'valid' | 'error' | 'skipped' | 'committed' | 'failed';

/** ImportRowResult; `data` is the row as the server read it (only for rows without problems). */
export interface ImportRow {
  rowIndex: number;
  medicineName?: string;
  status: ImportRowStatus;
  errors?: string[];
  data?: {
    name?: string; quantityToAdd?: number; batchNumber?: string; expiryDate?: string; mrp?: number; retailPrice?: number;
    wholesalePrice?: number; purchasePrice?: number; rackLocation?: string;
    medicineId?: string; medicineMatchStatus?: 'matched' | 'not_found' | 'duplicate'; matchedMedicineName?: string;
  };
}

export interface ImportCommitError { rowIndex: number; medicineName?: string; error: string; code?: string; retryable?: boolean }

/** IInventoryImport (Q15: the answers no longer carry the server's file path). */
export interface InventoryImport {
  _id: string;
  fileName: string;
  importMode: ImportMode;
  status: ImportStatus;
  totalRows: number;
  validRows: number;
  errorRows: number;
  committedRows?: number;
  failedRows?: number;
  commitErrors?: ImportCommitError[];
  previewRows?: ImportRow[];
  errorSummary?: string;
  createdAt?: string;
  updatedAt?: string;
  committedAt?: string;
}

export const IMPORT_STATUS_LABEL: Readonly<Record<ImportStatus, string>> = {
  pending: 'Uploading',
  previewed: 'Checked, not added yet',
  committing: 'Being added',
  committed: 'Added',
  partially_committed: 'Partly added',
  failed: 'Not added',
};
export const IMPORT_ROW_STATUS_LABEL: Readonly<Record<ImportRowStatus, string>> = {
  valid: 'Ready', error: 'Problem', skipped: 'Skipped', committed: 'Added', failed: 'Failed',
};
/** `importMode` (applyRowToInventory: create_only skips medicines already in stock, update_only skips new ones). */
export const IMPORT_MODES: readonly { value: ImportMode; label: string; hint: string }[] = [
  { value: 'upsert', label: 'Add every row', hint: 'Medicines already in your stock get the new batch; others are added.' },
  { value: 'update_only', label: 'Only medicines already in my stock', hint: 'Rows for other medicines are skipped.' },
  { value: 'create_only', label: 'Only medicines not yet in my stock', hint: 'Rows for medicines you already stock are skipped.' },
];

/**
 * The columns `validateRow` reads, on the first sheet; any other column is ignored. Q15: headers match in any case and
 * without surrounding spaces, and the expiry may be any of `IMPORT_EXPIRY_FORMS`.
 */
export const IMPORT_COLUMNS: readonly { header: string; need: string; format: string }[] = [
  { header: 'medicine name', need: 'Required', format: 'As in the medicine list. A name not in the list adds a new medicine.' },
  { header: 'quantity to add', need: 'Required to add units', format: 'Whole number, 0 or more (1,000 is fine). 0 only updates prices and rack.' },
  { header: 'batch number', need: 'When adding units', format: 'As printed on the pack.' },
  { header: 'expiry date', need: 'When adding units', format: 'A date (see below). Not in the past.' },
  { header: 'mrp', need: 'Optional', format: 'Rupees, e.g. 42.50 or 1,250.00. Use a point for paise: 1,5 is refused.' },
  { header: 'retail price', need: 'Optional', format: 'Your selling price in rupees.' },
  { header: 'purchase price', need: 'Optional', format: 'Rupees.' },
  { header: 'wholesale price', need: 'Optional', format: 'Rupees.' },
  { header: 'rack location', need: 'Optional', format: 'e.g. B2.' },
  { header: 'generic name', need: 'Optional', format: 'Used only for a new medicine.' },
  { header: 'brand name', need: 'Optional', format: 'Used only for a new medicine.' },
  { header: 'hsn code', need: 'Optional', format: 'Used only for a new medicine.' },
  { header: 'gst percent', need: 'Optional', format: '0 to 100. Used only for a new medicine.' },
  { header: 'prescription required', need: 'Optional', format: '“yes” for a new prescription medicine.' },
  { header: 'active status', need: 'Optional', format: '“no” to keep a new medicine inactive.' },
];

/**
 * The expiry date forms the import reads (Q15 review, `expiryOf` / `EXPIRY_FORMS`), as shown to staff. Anything else is
 * refused on its row with the server's words ("expiry date must be a valid date: …").
 */
export const IMPORT_EXPIRY_FORMS: readonly string[] = [
  'YYYYMMDD, for example 20271231 (as text or a number)',
  'YYYY-MM-DD, for example 2027-12-31',
  'DD-MM-YYYY or DD/MM/YYYY, day first, for example 31-12-2027 or 31/12/2027',
  'MM/YYYY or MM-YYYY, as printed on packs, for example 12/2027: the last day of that month',
  'a date cell in Excel',
];

/**
 * Q15 re-review: how the import reads numbers. Grouping commas are fine ("1,000", "10,00,000"); a price with a decimal
 * comma ("1,5") or extra text ("12 rs") is refused on its row.
 */
export const IMPORT_NUMBER_NOTE = 'Numbers may use commas between thousands, such as 1,000 or 10,00,000. Write paise with a point (12.50): a price such as 1,5 or 12 rs is refused on its row.';

/** The upload route's multer limits. */
export const IMPORT_ACCEPT = '.xlsx,.xls,.csv';
export const IMPORT_MAX_BYTES = 10 * 1024 * 1024;

export function importFileProblem(f: { name: string; size: number } | null | undefined): string | null {
  if (!f) return 'Choose the file to import.';
  const ext = /\.[^.]+$/.exec(f.name.toLowerCase())?.[0] ?? '';
  if (!IMPORT_ACCEPT.split(',').includes(ext)) return 'Use an Excel (.xlsx, .xls) or CSV (.csv) file.';
  if (f.size === 0) return 'This file is empty.';
  if (f.size > IMPORT_MAX_BYTES) return 'The file is larger than 10 MB. Split it into smaller files.';
  return null;
}

/** A blank CSV with every column header, for staff to fill in. */
export const importTemplateCsv = () => `${IMPORT_COLUMNS.map((c) => c.header).join(',')}\r\n`;

/** commit: only a checked import with at least one ready row. */
export const importCommittable = (r: Pick<InventoryImport, 'status' | 'validRows'>) => r.status === 'previewed' && r.validRows > 0;
/** The backend lets a retry resume an import stuck in `committing` once it has not moved for 15 minutes. */
export const IMPORT_STUCK_AFTER_MS = 15 * 60_000;
/** An import stuck while being added (`committing`, unchanged for more than 15 minutes): `POST /:id/retry` resumes it. */
export const importStuck = (r: Pick<InventoryImport, 'status' | 'updatedAt'>, now = Date.now()) =>
  r.status === 'committing' && !!r.updatedAt && Date.parse(r.updatedAt) < now - IMPORT_STUCK_AFTER_MS;
/**
 * retry (`commit(…, true)`): failed or partly added imports with rows that failed while being added; or (`staleCommitting`)
 * one stuck while being added: then its ready rows are added (a row already added is never added twice).
 */
export const importRetryable = (r: Pick<InventoryImport, 'status' | 'previewRows' | 'updatedAt'>, now = Date.now()) =>
  ((r.status === 'failed' || r.status === 'partially_committed') && (r.previewRows ?? []).some((x) => x.status === 'failed'))
  || importStuck(r, now);
/** An import whose adding has finished, one way or the other. */
export const importSettled = (s: ImportStatus) => s === 'committed' || s === 'partially_committed' || s === 'failed';
/** 409 IMPORT_NOT_RETRYABLE / IMPORT_ALREADY_PROCESSING: another commit or retry of this import already started. */
export const isImportClaimed = (err: unknown) =>
  err instanceof ApiError && err.status === 409 && (err.code === 'IMPORT_NOT_RETRYABLE' || err.code === 'IMPORT_ALREADY_PROCESSING');

const importPath = (id: string) => {
  if (!OBJECT_ID.test(id)) throw new Error('Invalid import id');
  return `/pharmacy-inventory-imports/${id}`;
};

export function pharmacyStockApi(c: ApiClient) {
  return {
    /** The medicine list (`GET /pharmacy-medicines`, paginated when page and limit are given). */
    medicines: (search: string, page = 1) =>
      c.page<Medicine>('/pharmacy-medicines', { query: { search: search.trim() || undefined, isActive: 'true', page, limit: 20 } }),
    medicine: (id: string) => {
      if (!OBJECT_ID.test(id)) throw new Error('Invalid medicine id');
      return c.get<Medicine>(`/pharmacy-medicines/${id}`);
    },
    /**
     * One batch, exactly once per `requestKey` (Q15): the same key and entry again answer 200 with the items as they are
     * now and `replayed: true` (no units added again); another entry under the key is 409 REQUEST_KEY_REUSED.
     */
    addStock: async (entry: StockEntry, requestKey: string): Promise<{ items: InventoryItem[]; replayed: boolean }> => {
      const r = await c.postKeyed<InventoryItem[]>('/pharmacy-inventory', { body: { items: [entry], requestKey: checkKey(requestKey) } });
      return { items: Array.isArray(r.data) ? r.data : [], replayed: r.replayed };
    },
    /** Q15 `GET /pharmacy-inventory/by-key/:key`: the items a key saved (as they are now); null on 404 (nothing so far). */
    savedByKey: async (requestKey: string): Promise<InventoryItem[] | null> => {
      try {
        return await c.get<InventoryItem[]>(`/pharmacy-inventory/by-key/${checkKey(requestKey)}`);
      } catch (err) {
        // Only the route's own "nothing saved with this key"; any other 404 (e.g. a route missing) stays unknown.
        if (err instanceof ApiError && err.status === 404 && err.code === 'REQUEST_KEY_NOT_FOUND') return null;
        throw err;
      }
    },
    /**
     * Q15 `POST /pharmacy-inventory/by-key/:key/abandon`: 'abandoned' = this key can never save now (a later send is 409
     * REQUEST_ABANDONED); 'used' = it saved these items.
     */
    abandonStock: (requestKey: string) =>
      c.post<{ state: 'abandoned' } | { state: 'used'; items: InventoryItem[] }>(`/pharmacy-inventory/by-key/${checkKey(requestKey)}/abandon`, { body: {} }),
    adjustments: (page = 1, limit = 100) => c.page<StockAdjustment>('/pharmacy-inventory/adjustments', { query: { page, limit } }),
    /** Reads the file and checks every row; nothing changes in stock until `commitImport`. Q15: another mode is a 400. */
    previewImport: (file: Blob, fileName: string, importMode: ImportMode) => {
      const form = new FormData();
      form.append('importMode', importMode);
      form.append('file', file, fileName);
      return c.post<InventoryImport>('/pharmacy-inventory-imports/preview', { form });
    },
    /** Adds the ready rows once: a second commit is refused (409) once the first has started. */
    commitImport: (importId: string) => {
      importPath(importId);
      return c.post<InventoryImport>('/pharmacy-inventory-imports/commit', { body: { importId } });
    },
    /** Tries the rows that failed again; a row already added is never added twice (one adjustment per row). */
    retryImport: (importId: string) => c.post<InventoryImport>(`${importPath(importId)}/retry`),
    imports: (page = 1, limit = 20): Promise<Page<InventoryImport>> => c.page<InventoryImport>('/pharmacy-inventory-imports', { query: { page, limit } }),
    import: (importId: string) => c.get<InventoryImport>(importPath(importId)),
    /** An .xlsx of the rows with problems (404 NO_FAILED_IMPORT_ROWS when there are none). */
    problemRowsFile: (importId: string, signal?: AbortSignal) => c.blob(`${importPath(importId)}/failed-rows/download`, { signal }),
  };
}
