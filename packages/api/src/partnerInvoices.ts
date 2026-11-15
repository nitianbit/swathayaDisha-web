import type { ApiClient } from './client.ts';
import { GSTIN_PATTERN, OBJECT_ID_PATTERN, partnerWorkspaceBase, type PartnerScope, type TaxRegime } from './partners.ts';

/**
 * Q2 partner catalogue and in-house invoices (labs and clinics). Typed from the backend's
 * `src1/modules/partners/{types/catalogue.ts,types/invoice.ts,validation/catalogue.ts,validation/invoice.ts}`; the
 * money rules are mirrored from `services/invoice.ts` (`computeLines`, `computeTotals`, `classifyDocument`,
 * `assertTaxConsistent`, `assertRegistrationCovers`). Every amount is an integer number of PAISE (`...Minor`); the UI
 * converts to rupees only to show it. The server's numbers are final: the preview here only tells staff what to expect.
 *
 * Routes: `registerWorkspaceRoutes` in `partners/routes/index.ts`, for members (`/partner-workspace/...`) and admins
 * acting as owner (`/partner-workspace/admin/:partnerId/workspace/...`).
 */

export type CatalogueItemKind = 'test' | 'package';
export type VisitMode = 'home' | 'lab';
/** `Joi.number().valid(0, 5, 12, 18, 28)`. */
export const GST_RATES = [0, 5, 12, 18, 28] as const;
export type GstRate = (typeof GST_RATES)[number];

/** `priceMinor`/`mrpMinor`/`unitPriceMinor`: `Joi.number().integer().min(0).max(100_000_000_00)` (₹10 crore). */
export const MAX_PRICE_MINOR = 100_000_000_00;
/** `MAX_BILL_MINOR` (₹1,000 crore): the largest line or bill total the server accepts. */
export const MAX_BILL_MINOR = 10_000_000_000_00;
export const MAX_ITEM_NAME = 200;
export const MAX_CODE = 50;
export const MAX_DESCRIPTION = 1000;
export const MAX_PREPARATION = 500;
export const MAX_SAMPLE_TYPE = 100;
export const MAX_SAC = 20;
export const MAX_LINE_DESCRIPTION = 500;
export const MAX_QTY = 10_000;
export const MAX_LINES = 100;
export const MAX_REFERENCE = 200;
export const MAX_NOTE = 500;
export const MAX_CANCEL_REASON = 500;
/** `createInvoiceSchema.customer.phone`: ten digits, optionally after +91, 91 or 0. */
export const INVOICE_PHONE_PATTERN = /^(\+91|91|0)?[0-9]{10}$/;
/** `customer.placeOfSupply` and a branch's `stateCode`: the two-digit GST state code. */
export const STATE_CODE_PATTERN = /^[0-9]{2}$/;

export interface CatalogueItem {
  _id: string;
  partnerId: string;
  kind: CatalogueItemKind;
  name: string;
  code?: string;
  description?: string;
  preparation?: string;
  sampleType?: string;
  includes?: string[];
  priceMinor: number;
  mrpMinor?: number;
  gstRate: GstRate;
  sac?: string;
  visitModes: VisitMode[];
  reportTatHours?: number;
  /** Deactivated items are never listed (the list returns active ones only). */
  isActive: boolean;
  /** Switched off by a Jansetu admin: listed (flagged) but neither bookable nor billable. Only an admin undoes it. */
  adminDisabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** `createCatalogueItemSchema`. */
export interface NewCatalogueItem {
  kind: CatalogueItemKind;
  name: string;
  code?: string;
  description?: string;
  preparation?: string;
  sampleType?: string;
  includes?: string[];
  priceMinor: number;
  mrpMinor?: number;
  gstRate: GstRate;
  sac?: string;
  visitModes: VisitMode[];
  reportTatHours?: number;
}
/** `updateCatalogueItemSchema` (at least one field; the kind never changes; no field can be cleared). */
export type CatalogueItemUpdate = Partial<Omit<NewCatalogueItem, 'kind'>>;

export type DocumentKind = 'tax_invoice' | 'bill_of_supply' | 'commercial_invoice';
export type InvoiceState = 'issued' | 'paid' | 'cancelled';
export type InvoicePaymentMode = 'cash' | 'upi' | 'card' | 'bank' | 'other';

/** The words printed on the PDF (`invoicePdf.ts` TITLES), with what they mean for staff. */
export const DOCUMENT_KIND_LABEL: Record<DocumentKind, string> = {
  tax_invoice: 'Tax invoice', bill_of_supply: 'Bill of supply', commercial_invoice: 'Invoice (no GST)',
};
/** The PDF calls an issued bill "Unpaid" (`statusAfter`). */
export const INVOICE_STATE_LABEL: Record<InvoiceState, string> = { issued: 'Unpaid', paid: 'Paid', cancelled: 'Cancelled' };
export const PAYMENT_MODES: readonly { value: InvoicePaymentMode; label: string }[] = [
  { value: 'cash', label: 'Cash' }, { value: 'upi', label: 'UPI' }, { value: 'card', label: 'Card' },
  { value: 'bank', label: 'Bank transfer' }, { value: 'other', label: 'Other' },
];

export interface InvoiceSupplier { name: string; legalName?: string; gstin?: string; pan?: string; address: string; placeOfSupply: string }
export interface InvoiceCustomer {
  name: string;
  /** Ten digits as stored (normalised by the server). */
  phone?: string;
  /** Set when the phone was linked to a Jansetu customer account (found, or created on the spot). */
  userId?: string;
  gstin?: string;
  age?: number;
  gender?: string;
  placeOfSupply?: string;
}
export interface InvoiceLine {
  catalogItemId?: string;
  description: string;
  hsn?: string;
  sac?: string;
  qty: number;
  unitPriceMinor: number;
  discountMinor: number;
  gstRate: GstRate;
  /** qty × unit price − discount (the taxable value of the line). */
  amountMinor: number;
}
export interface InvoiceTotals {
  subtotalMinor: number;
  discountMinor: number;
  taxableMinor: number;
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
  totalMinor: number;
  currency: 'INR';
}
export interface Invoice {
  _id: string;
  partnerId: string;
  branchId: string;
  number: number;
  financialYear: string;
  /** `<PREFIX>/<YYZZ>/<NNNN>`: the partner's own series. */
  serial: string;
  documentKind: DocumentKind;
  issuedAt: string;
  supplier: InvoiceSupplier;
  customer: InvoiceCustomer;
  doctorId?: string;
  items: InvoiceLine[];
  totals: InvoiceTotals;
  lifecycleState: InvoiceState;
  /** 0 as issued; +1 per event (payment, cancellation). */
  lifecycleVersion: number;
  createdBy: string;
  idempotencyKey: string;
  createdAt?: string;
}
export interface InvoiceEvent {
  _id: string;
  invoiceId: string;
  kind: 'payment' | 'cancellation';
  mode?: InvoicePaymentMode;
  reference?: string;
  reason?: string;
  note?: string;
  version: number;
  at: string;
  by: string;
  byKind: 'member' | 'admin';
}

export interface NewInvoiceLine {
  catalogItemId?: string;
  description: string;
  hsn?: string;
  sac?: string;
  qty: number;
  unitPriceMinor: number;
  discountMinor?: number;
  gstRate: GstRate;
}
export type InvoiceGender = 'male' | 'female' | 'other';
/** `createInvoiceSchema`. The request key travels in the BODY (`idempotencyKey`), not in a header. */
export interface NewInvoice {
  branchId: string;
  customer: { name: string; phone?: string; gstin?: string; age?: number; gender?: InvoiceGender; placeOfSupply?: string };
  doctorId?: string;
  items: NewInvoiceLine[];
  idempotencyKey: string;
}
/** `invoiceQuerySchema`: newest first; `before` pages back by issue time (exclusive); `limit` 1–200 (server default 50). */
export interface InvoiceQuery { state?: InvoiceState; branchId?: string; limit?: number; before?: string }
/** `recordPaymentSchema`. */
export interface PaymentInput { mode: InvoicePaymentMode; reference?: string; note?: string }

/** `GET /clinic/doctors` (Q6): the clinic's doctors visible to the caller. */
export interface ClinicDoctor {
  memberId: string;
  doctorId: string;
  role: 'owner' | 'staff';
  /** Empty = every branch. */
  branchIds: string[];
  name: string;
  specialization?: string;
  active: boolean;
}

// ── Money ──

/**
 * Rupees typed by a person → integer paise, without floating-point arithmetic ("12.05" → 1205). Accepts digits with
 * at most two decimals and optional Indian/Western grouping commas; anything else (signs, exponents, three decimals)
 * is null.
 */
export function rupeesToPaise(text: string): number | null {
  const t = text.trim().replace(/,/g, '');
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  const paise = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(paise) ? paise : null;
}

/** Integer paise → the rupee value `formatRupees` shows (exact to the paisa for every amount the server accepts). */
export const paiseToRupees = (minor: number) => minor / 100;

/** Integer paise → the text to put back in a rupee field ("1205" → "12.05", "1200" → "12"). */
export function paiseToInput(minor: number | undefined): string {
  if (minor === undefined || !Number.isSafeInteger(minor) || minor < 0) return '';
  const r = Math.floor(minor / 100);
  const p = minor % 100;
  return p === 0 ? String(r) : `${r}.${String(p).padStart(2, '0')}`;
}

// ── Tax rules (mirrors of services/invoice.ts) ──

export interface SupplierTax { taxRegime: TaxRegime; gstin?: string }

/** Only a regular GST registration with a GSTIN can charge GST (anything else must bill every line at 0%). */
export const chargesGst = (s: SupplierTax) => s.taxRegime === 'regular' && !!s.gstin;

/** The GST rates this supplier may put on a bill line or catalogue item. */
export const allowedGstRates = (s: SupplierTax): GstRate[] => (chargesGst(s) ? [...GST_RATES] : [0]);

/** `classifyDocument`: §6 classification from the supplier's regime, GSTIN and line rates. */
export function classifyDocument(s: SupplierTax, lines: readonly { gstRate: number }[]): DocumentKind {
  const taxable = lines.some((l) => l.gstRate > 0);
  if (s.taxRegime === 'regular' && s.gstin) return taxable ? 'tax_invoice' : 'bill_of_supply';
  if (s.taxRegime === 'composition' && s.gstin) return 'bill_of_supply';
  return 'commercial_invoice';
}

/** `assertTaxConsistent`: why GST lines are refused for this document kind, or null. */
export function taxRateProblem(kind: DocumentKind): string | null {
  if (kind === 'tax_invoice') return null;
  return kind === 'commercial_invoice'
    ? 'This partner is not GST-registered: every line must have GST rate 0'
    : 'A bill of supply cannot charge GST: every line must have GST rate 0';
}

/** `assertRegistrationCovers`: a bill printing a GSTIN must come from a branch in that GSTIN's state. */
export function registrationProblem(kind: DocumentKind, gstin: string | undefined, branchStateCode: string): string | null {
  if (kind === 'commercial_invoice' || !gstin) return null;
  if (gstin.slice(0, 2) === branchStateCode) return null;
  return `The partner's GST registration (state ${gstin.slice(0, 2)}) does not cover this branch (state ${branchStateCode}); this branch cannot issue GST bills yet`;
}

export interface LinePreview { amountMinor: number; taxMinor: number; problem: string | null }
export interface InvoicePreview {
  lines: LinePreview[];
  totals: InvoiceTotals;
  documentKind: DocumentKind;
  /** CGST + SGST (same state, or no customer state given) or IGST. */
  sameState: boolean;
  /** Problems the server would refuse the bill for (each also shown on its line where it belongs). */
  problems: string[];
}

/**
 * What the server will compute (`computeLines` + `computeTotals`): per line, amount = unit price × qty − discount; tax
 * per line = round(amount × rate / 100) to the paisa; totals are sums of the rounded line values; with CGST/SGST the
 * odd paisa goes to SGST. Place of supply: no customer state = the branch's state (intra-state).
 */
export function previewInvoice(
  supplier: SupplierTax,
  branchStateCode: string,
  customerPlaceOfSupply: string | undefined,
  items: readonly NewInvoiceLine[],
): InvoicePreview {
  const sameState = !customerPlaceOfSupply || customerPlaceOfSupply === branchStateCode;
  const documentKind = classifyDocument(supplier, items);
  const rateProblem = taxRateProblem(documentKind);
  const problems: string[] = [];
  const t = { subtotalMinor: 0, discountMinor: 0, taxableMinor: 0, cgstMinor: 0, sgstMinor: 0, igstMinor: 0 };
  const lines = items.map((item): LinePreview => {
    const discount = item.discountMinor ?? 0;
    const gross = item.unitPriceMinor * item.qty;
    let problem: string | null = null;
    if (!Number.isSafeInteger(gross) || gross > MAX_BILL_MINOR) problem = 'This line is larger than a single bill can be';
    else if (discount > gross) problem = 'A line discount cannot exceed the line amount';
    else if (item.gstRate > 0 && rateProblem) problem = rateProblem;
    const amountMinor = problem && problem !== rateProblem ? 0 : gross - discount;
    const taxMinor = Math.round((amountMinor * item.gstRate) / 100);
    t.subtotalMinor += problem && problem !== rateProblem ? 0 : gross;
    t.discountMinor += problem && problem !== rateProblem ? 0 : discount;
    t.taxableMinor += amountMinor;
    if (sameState) {
      const half = Math.floor(taxMinor / 2);
      t.cgstMinor += half;
      t.sgstMinor += taxMinor - half;
    } else {
      t.igstMinor += taxMinor;
    }
    if (problem && !problems.includes(problem)) problems.push(problem);
    return { amountMinor, taxMinor, problem };
  });
  const totals: InvoiceTotals = { ...t, totalMinor: t.taxableMinor + t.cgstMinor + t.sgstMinor + t.igstMinor, currency: 'INR' };
  if (totals.totalMinor > MAX_BILL_MINOR || totals.subtotalMinor > MAX_BILL_MINOR) problems.push('This bill is larger than a single bill can be');
  const reg = registrationProblem(documentKind, supplier.gstin, branchStateCode);
  if (reg) problems.push(reg);
  return { lines, totals, documentKind, sameState, problems };
}

// ── Paths ──

function checkId(id: string, what: string): string {
  if (!OBJECT_ID_PATTERN.test(id)) throw new Error(`Invalid ${what} id`);
  return id;
}

/** A customer GSTIN as the server stores it (`trim().uppercase()`), or the problem with it. */
export function customerGstinProblem(raw: string): string | null {
  const v = raw.trim().toUpperCase();
  return !v || GSTIN_PATTERN.test(v) ? null : 'Enter a valid 15-character GSTIN.';
}

/** Catalogue and invoices of one partner workspace (member, or admin acting as owner). Ids are checked before any path. */
export function partnerBillingApi(c: ApiClient, scope: PartnerScope) {
  const base = () => partnerWorkspaceBase(scope);
  const item = (id: string) => `${base()}/catalogue/${checkId(id, 'catalogue item')}`;
  const invoice = (id: string) => `${base()}/invoices/${checkId(id, 'invoice')}`;
  return {
    /** Active items (admin-disabled ones included, flagged), sorted by name; no paging. */
    catalogue: (kind?: CatalogueItemKind) => c.get<CatalogueItem[]>(`${base()}/catalogue`, { query: { kind } }),
    catalogueItem: (id: string) => c.get<CatalogueItem>(item(id)),
    createCatalogueItem: (body: NewCatalogueItem) => c.post<CatalogueItem>(`${base()}/catalogue`, { body }),
    updateCatalogueItem: (id: string, body: CatalogueItemUpdate) => c.put<CatalogueItem>(item(id), { body }),
    /** Sets `isActive: false`; the item disappears from the list. No endpoint reactivates it. */
    deactivateCatalogueItem: (id: string) => c.delete<unknown>(item(id)),

    invoices: (q: InvoiceQuery = {}) => c.get<Invoice[]>(`${base()}/invoices`, { query: { ...q } }),
    invoice: (id: string) => c.get<{ invoice: Invoice; events: InvoiceEvent[] }>(invoice(id)),
    /** Once-only by `body.idempotencyKey`: the same key with the same request answers the bill already issued. */
    createInvoice: (body: NewInvoice) => c.post<Invoice>(`${base()}/invoices`, { body }),
    /** The bill's PDF as of lifecycle `version` (0 = as issued; default = now), read with the session's token. */
    invoicePdf: (id: string, version?: number, signal?: AbortSignal) =>
      c.blob(`${invoice(id)}/pdf`, { query: { version }, signal }),
    recordPayment: (id: string, body: PaymentInput) => c.post<{ invoice: Invoice; event: InvoiceEvent }>(`${invoice(id)}/pay`, { body }),
    cancelInvoice: (id: string, reason: string) =>
      c.post<{ invoice: Invoice; event: InvoiceEvent }>(`${invoice(id)}/cancel`, { body: { reason } }),

    /** Clinics only (Q6). */
    clinicDoctors: () => c.get<ClinicDoctor[]>(`${base()}/clinic/doctors`),
  };
}

/** Platform admins: switch a partner's catalogue item off or on (the partner cannot undo a disable). */
export function catalogueAdminApi(c: ApiClient) {
  const one = (id: string) => `/partner-workspace/admin/catalogue/${checkId(id, 'catalogue item')}`;
  return {
    disable: (id: string) => c.post<CatalogueItem>(`${one(id)}/disable`, { body: {} }),
    enable: (id: string) => c.post<CatalogueItem>(`${one(id)}/enable`, { body: {} }),
  };
}

/** The file name the server gives the PDF (`<serial with dashes>-v<version>.pdf`). */
export const invoicePdfName = (serial: string, version: number) => `${serial.replace(/[^A-Za-z0-9-]/g, '-')}-v${version}.pdf`;
