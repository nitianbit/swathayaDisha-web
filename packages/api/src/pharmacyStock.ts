import { ApiError, type ApiClient, type Page } from './client.ts';
import { t as core } from './i18n/index.ts';
import { t } from './i18n/pharmacy/index.ts';
import { onLanguage, wordMap } from './i18n/words.ts';
import type { InventoryItem, MedicineRef } from './inventory.ts';

type Key = Parameters<typeof t>[0];
/** `{ <code>: value, label }` whose label is read at use (the words of the current language); `as const` keeps the code type. */
const option = <const V extends string>(value: V, key: Key) => Object.freeze({ value, get label() { return t(key); } });

/**
 * WQ10a: adding stock by hand and importing a stock file.
 *
 * Add stock mirrors src1/modules/pharmacyInventory: `POST /pharmacy-inventory` (`createInventoryItemSchema`, one item;
 * InventoryService.saveItem → `adjustBatchStock`): a positive `quantity` needs `batchNumber` and a real, unexpired
 * `expiryDate` (YYYYMMDD); the batch is matched on its upper-cased number and expiry, prices are rupees. Every saved
 * change writes an adjustment (`GET /pharmacy-inventory/adjustments`, newest first) carrying the request's `notes`.
 * Q15: the save takes a `requestKey` (exactly once per pharmacy and key; the same key and items again answer 200
 * `replayed: true` without adding stock again), and `GET /pharmacy-inventory/by-key/:key` returns what a key saved (404
 * REQUEST_KEY_NOT_FOUND = nothing so far).
 * WQ11c (owner, 22 Nov; backend Q16c): a delivery may name the pharmacy's own active `supplierId` (with a positive
 * quantity only; 404 SUPPLIER_NOT_FOUND / 409 SUPPLIER_ARCHIVED otherwise). It is kept on the delivery's adjustment, never
 * on the batch, and the adjustment history answers it as `supplier`.
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
  option('purchase', 'stock.reason.purchase'),
  option('return', 'stock.reason.return'),
  option('transfer', 'stock.reason.transfer'),
  option('correction', 'stock.reason.correction'),
  option('other', 'stock.reason.other'),
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
  /** WQ11c: the supplier this delivery came from ('' = not said). */
  supplierId?: string;
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
  /** Q16c: the pharmacy's own active supplier the units came from. */
  supplierId?: string;
}

/** Q16c `withSuppliers`: the supplier of a delivery, as the adjustment history answers it. */
export interface DeliverySupplier { supplierId: string; displayName: string; state: 'active' | 'archived' }

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
  /** Q16c: the delivery's supplier (id, and the supplier as the history reads it; null = none recorded). */
  supplierId?: string;
  supplier?: DeliverySupplier | null;
  createdAt?: string;
}

/** Q16c: refusals of a delivery's supplier. */
export const SUPPLIER_REFUSAL: Readonly<Record<string, string>> = wordMap(t, {
  SUPPLIER_NOT_FOUND: 'stock.supplierRefusal.SUPPLIER_NOT_FOUND',
  SUPPLIER_ARCHIVED: 'stock.supplierRefusal.SUPPLIER_ARCHIVED',
});
export const isSupplierRefusal = (err: unknown) => err instanceof ApiError && !!err.code && err.code in SUPPLIER_REFUSAL;

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const RUPEES = /^\d+(\.\d{1,2})?$/;

/** isValidInventoryDate: a real calendar date in YYYYMMDD. */
export function isRealYyyymmdd(v: string): boolean {
  if (!/^\d{8}$/.test(v)) return false;
  const y = Number(v.slice(0, 4)); const m = Number(v.slice(4, 6)); const d = Number(v.slice(6, 8));
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * The server's "today": Q16c makes every pharmacy expiry check use the India calendar date (`istTodayYyyymmdd`); stock
 * expiring before it is refused (BATCH_ALREADY_EXPIRED). Before Q16c the server used the UTC date, which is never later.
 */
export const serverToday = (now = new Date()) => new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10).replace(/-/g, '');

/** What is wrong with the draft, field by field (the server checks the same and still decides). */
export function stockEntryProblems(d: StockEntryDraft, today = serverToday()): Partial<Record<keyof StockEntryDraft, string>> {
  const e: Partial<Record<keyof StockEntryDraft, string>> = {};
  if (!OBJECT_ID.test(d.medicineId)) e.medicineId = t('stock.medicine');
  const batch = d.batchNumber.trim();
  if (!batch) e.batchNumber = t('stock.batch');
  else if (batch.length > STOCK_LIMITS.batchNumber) e.batchNumber = t('field.atMost', { max: STOCK_LIMITS.batchNumber });
  const expiry = d.expiry.replace(/-/g, '');
  if (!isRealYyyymmdd(expiry)) e.expiry = t('stock.expiry');
  else if (expiry < today) e.expiry = t('stock.expired');
  const qty = d.quantity.trim();
  if (!/^\d+$/.test(qty) || !Number.isSafeInteger(Number(qty)) || Number(qty) < 1) e.quantity = t('stock.quantity');
  for (const k of ['mrp', 'retailPrice', 'purchasePrice'] as const) {
    const v = d[k].trim();
    if (v && !RUPEES.test(v)) e[k] = t('stock.rupees');
  }
  if (d.rackLocation.trim().length > STOCK_LIMITS.rackLocation) e.rackLocation = t('field.atMost', { max: STOCK_LIMITS.rackLocation });
  const reorder = d.reorderThreshold.trim();
  if (reorder && (!/^\d+$/.test(reorder) || !Number.isSafeInteger(Number(reorder)))) e.reorderThreshold = t('stock.reorder');
  if (d.note.trim().length > MAX_STOCK_NOTE) e.note = t('field.atMost', { max: MAX_STOCK_NOTE });
  if (!ADD_STOCK_REASONS.some((r) => r.value === d.reason)) e.reason = t('stock.reasonRequired');
  if (d.supplierId && !OBJECT_ID.test(d.supplierId)) e.supplierId = t('stock.supplierAgain');
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
  if (d.supplierId && OBJECT_ID.test(d.supplierId)) body.supplierId = d.supplierId.toLowerCase();
  return body;
}

const checkKey = (key: string) => {
  if (!PHARMACY_REQUEST_KEY_PATTERN.test(key)) throw new Error('Invalid request key'); // i18n-ignore: a programming error, not shown
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
    /** For a new medicine: whether it will need a prescription (Q16c: yes unless the row says "no"). */
    prescriptionRequired?: boolean;
    /** Q16c: the row's supplier, when the file or the row names one. */
    supplierId?: string; supplierName?: string;
  };
  /**
   * Q16c (`enrichPreviewRow`, on the row itself, not in `data`): whether this pharmacy already has the medicine in its
   * inventory, and its prices now (MRP from the row's batch, else the latest batch; each null when unset; the whole
   * object null when not stocked). A blank cell keeps a current price only when there is one; without these fields
   * (an import previewed before Q16c) that is not known.
   */
  inMyStock?: boolean;
  /**
   * Q16d: this exact batch (number and expiry) is already in stock. Only then is `currentPrices.mrp` that batch's MRP; a
   * new batch has no MRP to keep (null), so a blank MRP cell leaves it without one.
   */
  batchInStock?: boolean;
  currentPrices?: ImportCurrentPrices | null;
}

/** Q16c `ImportCurrentPrices`. */
export interface ImportCurrentPrices { mrp: number | null; retailPrice: number | null; wholesalePrice: number | null; purchasePrice: number | null }

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
  /** Q16c: the supplier named for the whole file, when one was. */
  supplierId?: string;
  supplier?: DeliverySupplier | null;
}

export const IMPORT_STATUS_LABEL: Readonly<Record<ImportStatus, string>> = wordMap(t, {
  pending: 'import.status.pending',
  previewed: 'import.status.previewed',
  committing: 'import.status.committing',
  committed: 'import.status.committed',
  partially_committed: 'import.status.partially_committed',
  failed: 'import.status.failed',
});
export const IMPORT_ROW_STATUS_LABEL: Readonly<Record<ImportRowStatus, string>> = wordMap(t, {
  valid: 'import.row.valid', error: 'import.row.error', skipped: 'import.row.skipped', committed: 'import.row.committed', failed: 'import.row.failed',
});
/** `importMode` (applyRowToInventory: create_only skips medicines already in stock, update_only skips new ones). */
const importMode = (value: ImportMode, label: Key, hint: Key) =>
  Object.freeze({ value, get label() { return t(label); }, get hint() { return t(hint); } });
export const IMPORT_MODES: readonly { value: ImportMode; label: string; hint: string }[] = [
  importMode('upsert', 'import.mode.upsert', 'import.mode.upsertHint'),
  importMode('update_only', 'import.mode.updateOnly', 'import.mode.updateOnlyHint'),
  importMode('create_only', 'import.mode.createOnly', 'import.mode.createOnlyHint'),
];

/**
 * The columns `validateRow` reads, on the first sheet; any other column is ignored. Q15: headers match in any case and
 * without surrounding spaces, and the expiry may be any of `IMPORT_EXPIRY_FORMS`.
 */
/** `header` is the column name the importer reads (never translated); `need` and `format` are words, read at use. */
const column = (header: string, need: Key, format: Key) =>
  Object.freeze({ header, get need() { return t(need); }, get format() { return t(format); } });
export const IMPORT_COLUMNS: readonly { header: string; need: string; format: string }[] = [
  // Q16c: in the server template's order (`IMPORT_COLUMNS` of the importer).
  column('medicine name', 'import.need.required', 'import.format.medicineName'),
  column('quantity to add', 'import.need.toAddUnits', 'import.format.quantity'),
  column('batch number', 'import.need.whenAdding', 'import.format.batch'),
  column('expiry date', 'import.need.whenAdding', 'import.format.expiry'),
  column('mrp', 'import.need.keepsPrice', 'import.format.mrp'),
  column('retail price', 'import.need.keepsPrice', 'import.format.retail'),
  column('wholesale price', 'import.need.keepsPrice', 'import.format.rupees'),
  column('purchase price', 'import.need.keepsPrice', 'import.format.rupees'),
  column('gst percent', 'import.need.optional', 'import.format.gst'),
  column('hsn code', 'import.need.optional', 'import.format.newOnly'),
  column('prescription required', 'import.need.optional', 'import.format.prescription'),
  column('generic name', 'import.need.optional', 'import.format.newOnly'),
  column('brand name', 'import.need.optional', 'import.format.newOnly'),
  column('rack location', 'import.need.optional', 'import.format.rack'),
  column('active status', 'import.need.optional', 'import.format.active'),
  column('supplier', 'import.need.optional', 'import.format.supplier'),
];

/**
 * The expiry date forms the import reads (Q15 review, `expiryOf` / `EXPIRY_FORMS`), as shown to staff. Anything else is
 * refused on its row with the server's words ("expiry date must be a valid date: …").
 */
export const IMPORT_EXPIRY_FORMS: readonly string[] = (() => {
  const keys: readonly Key[] = ['import.expiry.ymd', 'import.expiry.isoDate', 'import.expiry.dayFirst', 'import.expiry.monthYear', 'import.expiry.excel'];
  // Each item is read at use (an index getter), so the list is in the current language.
  const list: string[] = [];
  keys.forEach((key, i) => Object.defineProperty(list, i, { get: () => t(key), enumerable: true }));
  return Object.freeze(list);
})();

/**
 * Q15 re-review: how the import reads numbers. Grouping commas are fine ("1,000", "10,00,000"); a price with a decimal
 * comma ("1,5") or extra text ("12 rs") is refused on its row.
 */
export let IMPORT_NUMBER_NOTE = '';
onLanguage(() => { IMPORT_NUMBER_NOTE = t('import.numberNote'); });

/** The upload route's multer limits. */
export const IMPORT_ACCEPT = '.xlsx,.xls,.csv';
export const IMPORT_MAX_BYTES = 10 * 1024 * 1024;

export function importFileProblem(f: { name: string; size: number } | null | undefined): string | null {
  if (!f) return t('import.file.choose');
  const ext = /\.[^.]+$/.exec(f.name.toLowerCase())?.[0] ?? '';
  if (!IMPORT_ACCEPT.split(',').includes(ext)) return t('import.file.type');
  if (f.size === 0) return t('import.file.empty');
  if (f.size > IMPORT_MAX_BYTES) return t('import.file.tooLarge');
  return null;
}

/** The one way of writing a date that is always read right: day first, then month, then the year in full. */
export let IMPORT_DATE_FORMAT = '';
onLanguage(() => { IMPORT_DATE_FORMAT = t('import.dateFormat'); });

/** Q16c `TEMPLATE_EXAMPLE_MARK`: the example row's name says to delete it, and the importer refuses a row so named. */
export const TEMPLATE_EXAMPLE_MARK = '(example - delete this row)';
/** The example row of the template (one per column, as the server's template has it). */
const TEMPLATE_EXAMPLE: Readonly<Record<string, string>> = {
  // i18n-ignore: the template file's example cell (data the importer reads, refused by its mark)
  'medicine name': `Paracetamol 500 mg tablet ${TEMPLATE_EXAMPLE_MARK}`, 'quantity to add': '100', 'batch number': 'PCM2412',
  'expiry date': '31-12-2027', mrp: '30', 'retail price': '28', 'wholesale price': '25', 'purchase price': '20', 'gst percent': '12',
  // i18n-ignore: the template file's example cells (data, as in the server's template)
  'hsn code': '3004', 'prescription required': 'no', 'generic name': 'Paracetamol', 'brand name': 'Example brand',
  'rack location': 'A-3', 'active status': 'yes', supplier: '',
};
const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/**
 * WQ11c (owner, 22 Nov): the template made on this device when the server's `GET /pharmacy-inventory-imports/template`
 * (Q16c) cannot be had: every column header and the same example row (expiry 31-12-2027, day first). Delete the example
 * before importing (Q16c refuses a row with its name).
 */
export const importTemplateCsv = () =>
  `${IMPORT_COLUMNS.map((c) => c.header).join(',')}\r\n${IMPORT_COLUMNS.map((c) => csvCell(TEMPLATE_EXAMPLE[c.header] ?? '')).join(',')}\r\n`;

/** WQ11c: an import with a large file can take long; upload, commit and retry wait up to 2 minutes for the answer. */
export const IMPORT_TIMEOUT_MS = 120_000;

/**
 * Q16c: the server's refusals of an upload (400, the file is removed), in words. The server's own message is the fallback,
 * so a code added later still reads right. Dates written month first are refused per row, not here (`monthFirstRows`).
 */
export const IMPORT_UPLOAD_REFUSAL: Readonly<Record<string, string>> = wordMap(t, {
  FILE_REQUIRED: 'import.file.choose',
  UNSUPPORTED_FILE_TYPE: 'import.file.type',
  FILE_TOO_LARGE: 'import.file.tooLarge',
  UNEXPECTED_FILE_FIELD: 'import.refusal.UNEXPECTED_FILE_FIELD',
  UPLOAD_INVALID: 'import.refusal.UPLOAD_INVALID',
  PARSE_FAILED: 'import.refusal.PARSE_FAILED',
  IMPORT_FILE_EMPTY: 'import.refusal.IMPORT_FILE_EMPTY',
  IMPORT_COLUMNS_MISSING: 'import.refusal.IMPORT_COLUMNS_MISSING',
  // Q16c re-review (`assertImportSize`): more than 200,000 cells (all sheets), or a read longer than 5 seconds.
  IMPORT_FILE_TOO_BIG: 'import.refusal.IMPORT_FILE_TOO_BIG',
});
export function importUploadRefusal(err: unknown): string {
  if (!(err instanceof ApiError)) return err instanceof Error ? err.message : core('errors.unknown');
  const known = err.code ? IMPORT_UPLOAD_REFUSAL[err.code] : undefined;
  return known ?? err.message;
}

/** Q16c: rows refused because the file writes dates month first (the server's row errors say so). */
export const monthFirstRows = (rows: readonly ImportRow[]) =>
  rows.filter((r) => r.status === 'error' && (r.errors ?? []).some((e) => /month first/i.test(e)));

/** A price as the import will apply it: a number (0 included), or 'keep' when the cell was blank (Q16c). */
export type ImportPrice = number | 'keep';
export const importPriceOf = (v: number | null | undefined): ImportPrice => (typeof v === 'number' && Number.isFinite(v) ? v : 'keep');
const priceField = <const K extends 'mrp' | 'retailPrice' | 'purchasePrice' | 'wholesalePrice'>(key: K, word: Key) =>
  Object.freeze({ key, get label() { return t(word); } });
export const IMPORT_PRICE_FIELDS = [
  priceField('mrp', 'import.price.mrp'), priceField('retailPrice', 'import.price.retailPrice'),
  priceField('purchasePrice', 'import.price.purchasePrice'), priceField('wholesalePrice', 'import.price.wholesalePrice'),
] as const;
type PriceKey = (typeof IMPORT_PRICE_FIELDS)[number]['key'];
/**
 * The price a row leaves in place for `key`: 'set' (the row's own number), 'kept' (a blank cell and a known current price),
 * 'none' (a blank cell and no price: a new medicine, one not yet in this pharmacy's stock, or a current price that is
 * empty) or 'unknown' (a blank cell; whether there is a current price is not said).
 */
export type ImportPriceView = { kind: 'set'; value: number } | { kind: 'kept'; value: number } | { kind: 'none' } | { kind: 'unknown' };
export function importPriceView(r: ImportRow, key: PriceKey): ImportPriceView {
  const own = importPriceOf(r.data?.[key]);
  if (own !== 'keep') return { kind: 'set', value: own };
  if (r.data?.medicineMatchStatus === 'not_found' || r.inMyStock === false) return { kind: 'none' };
  // Q16d: MRP belongs to the batch: a batch not in stock yet keeps none (whatever another batch has).
  if (key === 'mrp' && r.batchInStock === false) return { kind: 'none' };
  const current = r.currentPrices?.[key];
  if (typeof current === 'number' && Number.isFinite(current) && current > 0) return { kind: 'kept', value: current };
  if (r.currentPrices && key in r.currentPrices) return { kind: 'none' };
  return { kind: 'unknown' };
}
/** A row whose medicine will have no selling price after it (blank or 0, nothing current): not on sale until priced. */
export function importLeavesUnpriced(r: ImportRow): boolean {
  const v = importPriceView(r, 'retailPrice');
  return v.kind === 'none' || (v.kind === 'set' && v.value <= 0);
}
/** WQ11c: the template's example row, still in the file (Q16c refuses it by name; an older importer would not). */
export const isTemplateExample = (r: ImportRow) =>
  [r.medicineName, r.data?.name].some((n) => typeof n === 'string' && n.toLowerCase().includes(TEMPLATE_EXAMPLE_MARK));

/** The prices a ready row would set to ₹0 (by their words). */
export const importZeroPrices = (r: ImportRow) => IMPORT_PRICE_FIELDS.filter((f) => importPriceOf(r.data?.[f.key]) === 0).map((f) => f.label);
/** The prices a ready row would change (any number, 0 included). */
export const importSetPrices = (r: ImportRow) => IMPORT_PRICE_FIELDS.filter((f) => importPriceOf(r.data?.[f.key]) !== 'keep').map((f) => f.label);

/**
 * What a confirmed import would do, from its checked rows and mode. Q16c: a new medicine needs a prescription unless its
 * row says "no". In "Only medicines already in my stock" rows for a medicine not in the list are skipped (it cannot be in
 * stock); whether a listed medicine is in this pharmacy's stock is decided only while adding, so those rows are "up to".
 */
export function importPlan(record: Pick<InventoryImport, 'importMode' | 'previewRows'>) {
  const ready = (record.previewRows ?? []).filter((r) => r.status === 'valid');
  const isNew = (r: ImportRow) => r.data?.medicineMatchStatus === 'not_found';
  const used = record.importMode === 'update_only' ? ready.filter((r) => !isNew(r)) : ready;
  const skippedNew = ready.length - used.length;
  const units = used.reduce((a, r) => a + Number(r.data?.quantityToAdd ?? 0), 0);
  const newRows = used.filter(isNew);
  return {
    rows: used.length,
    units,
    skippedNew,
    /** create_only: rows for medicines already in this pharmacy's stock are skipped while adding. */
    mayBeSkipped: record.importMode === 'create_only' ? used.filter((r) => !isNew(r)).length : 0,
    newMedicines: newRows.length,
    newNeedingPrescription: newRows.filter((r) => r.data?.prescriptionRequired !== false).length,
    /** New medicines, medicines not yet in this pharmacy's stock, and selling prices set to 0, with no selling price after. */
    unpriced: used.filter(importLeavesUnpriced),
    /** The template's example row (the confirmation is blocked while it is there). */
    examples: ready.filter(isTemplateExample),
    priceChanges: used.filter((r) => importSetPrices(r).length > 0),
    zeroPrices: used.filter((r) => importZeroPrices(r).length > 0),
  };
}

/** Another import of the same file name that was added in the last 24 hours (the newest), if any. */
export function recentSameFile(record: Pick<InventoryImport, '_id' | 'fileName'>, others: readonly InventoryImport[], now = Date.now()): InventoryImport | null {
  const since = now - 24 * 60 * 60_000;
  return others.find((r) => r._id !== record._id && r.fileName === record.fileName
    && (r.status === 'committed' || r.status === 'partially_committed' || r.status === 'committing')
    && Date.parse(r.committedAt ?? r.updatedAt ?? r.createdAt ?? '') >= since) ?? null;
}

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
  if (!OBJECT_ID.test(id)) throw new Error('Invalid import id'); // i18n-ignore: a programming error, not shown
  return `/pharmacy-inventory-imports/${id}`;
};

export function pharmacyStockApi(c: ApiClient) {
  return {
    /** The medicine list (`GET /pharmacy-medicines`, paginated when page and limit are given). */
    medicines: (search: string, page = 1) =>
      c.page<Medicine>('/pharmacy-medicines', { query: { search: search.trim() || undefined, isActive: 'true', page, limit: 20 } }),
    medicine: (id: string) => {
      if (!OBJECT_ID.test(id)) throw new Error('Invalid medicine id'); // i18n-ignore: a programming error, not shown
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
    /**
     * Reads the file and checks every row; nothing changes in stock until `commitImport`. Q15: another mode is a 400.
     * Q16c: an optional `supplierId` names the supplier of the whole file.
     */
    previewImport: (file: Blob, fileName: string, importMode: ImportMode, supplierId?: string) => {
      const form = new FormData();
      form.append('importMode', importMode);
      if (supplierId && OBJECT_ID.test(supplierId)) form.append('supplierId', supplierId.toLowerCase());
      form.append('file', file, fileName);
      return c.post<InventoryImport>('/pharmacy-inventory-imports/preview', { form, timeoutMs: IMPORT_TIMEOUT_MS });
    },
    /** Adds the ready rows once: a second commit is refused (409) once the first has started. */
    commitImport: (importId: string) => {
      importPath(importId);
      return c.post<InventoryImport>('/pharmacy-inventory-imports/commit', { body: { importId }, timeoutMs: IMPORT_TIMEOUT_MS });
    },
    /** Tries the rows that failed again; a row already added is never added twice (one adjustment per row). */
    retryImport: (importId: string) => c.post<InventoryImport>(`${importPath(importId)}/retry`, { timeoutMs: IMPORT_TIMEOUT_MS }),
    /**
     * Q16c `GET /pharmacy-inventory-imports/template`: the server's template file, or null when it cannot be had. Until
     * the route is deployed the path falls to `GET /:id` (a 500 for the id "template"), so any refusal of the server means
     * "not there": the page then makes `importTemplateCsv` on this device. A cancelled download is rethrown.
     */
    importTemplate: async (signal?: AbortSignal): Promise<Blob | null> => {
      try {
        return await c.blob('/pharmacy-inventory-imports/template', { signal });
      } catch (err) {
        if (err instanceof ApiError) return null;
        throw err;
      }
    },
    imports: (page = 1, limit = 20): Promise<Page<InventoryImport>> => c.page<InventoryImport>('/pharmacy-inventory-imports', { query: { page, limit } }),
    import: (importId: string) => c.get<InventoryImport>(importPath(importId)),
    /** An .xlsx of the rows with problems (404 NO_FAILED_IMPORT_ROWS when there are none). */
    problemRowsFile: (importId: string, signal?: AbortSignal) => c.blob(`${importPath(importId)}/failed-rows/download`, { signal }),
  };
}
