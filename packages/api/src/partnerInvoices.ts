import type { ApiClient, Page } from './client.ts';
import { GSTIN_PATTERN, OBJECT_ID_PATTERN, partnerWorkspaceBase, type PartnerKind, type PartnerScope, type TaxRegime } from './partners.ts';

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

/** Q10: labs sell tests and packages (with visit modes); clinics consultations, procedures, packages and other items (none). */
export type CatalogueItemKind = 'test' | 'package' | 'consultation' | 'procedure' | 'other';
/** `assertItemFits` (Q10 `services/catalogue.ts`): the kinds each partner type may list. */
export const ITEM_KINDS_FOR: Record<PartnerKind, readonly CatalogueItemKind[]> = {
  lab: ['test', 'package'],
  clinic: ['consultation', 'procedure', 'package', 'other'],
};
/** Labs need at least one visit mode; clinic items have none. */
export const usesVisitModes = (kind: PartnerKind) => kind === 'lab';
/** Q10 `createCatalogueItemSchema.requestKey`. */
export const ITEM_REQUEST_KEY_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;
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
  /** Labs only (clinic items have none). */
  visitModes?: VisitMode[];
  reportTatHours?: number;
  /** Deactivated items are listed only with `includeInactive` (catalogue managers) and can be reactivated. */
  isActive: boolean;
  /** Switched off by a Jansetu admin: listed (flagged) but neither bookable nor billable. Only an admin undoes it. */
  adminDisabled: boolean;
  createdAt?: string;
  /** Sent back as `expectedUpdatedAt` on an edit (Q10: 409 CATALOGUE_ITEM_CHANGED when it moved). */
  updatedAt?: string;
  /** Q10: the request key the item was created with (stored on the item). WQ7: a lost create is resolved by key (Q12), not by this field. */
  createRequestKey?: string;
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
  /** Labs: one or more. Clinics: none. */
  visitModes?: VisitMode[];
  reportTatHours?: number;
  /** Q10: exactly once per key; a replay answers the same item, other content under the key is 409 REQUEST_KEY_REUSED. */
  requestKey?: string;
}
/** `updateCatalogueItemSchema` (at least one field; the kind never changes; no field can be cleared). */
export type CatalogueItemUpdate = Partial<Omit<NewCatalogueItem, 'kind' | 'requestKey'>> & {
  /** Q10: the item's `updatedAt` the edit started from. */
  expectedUpdatedAt?: string;
};

export type DocumentKind = 'tax_invoice' | 'bill_of_supply' | 'commercial_invoice';
/** Q14: `partly_paid` = some payments recorded, an amount still due (only where the partner allows part payments). */
export type InvoiceState = 'issued' | 'partly_paid' | 'paid' | 'cancelled';
export const INVOICE_STATES: readonly InvoiceState[] = ['issued', 'partly_paid', 'paid', 'cancelled'];
export type InvoicePaymentMode = 'cash' | 'upi' | 'card' | 'bank' | 'other';

/** The words printed on the PDF (`invoicePdf.ts` TITLES), with what they mean for staff. */
export const DOCUMENT_KIND_LABEL: Record<DocumentKind, string> = {
  tax_invoice: 'Tax invoice', bill_of_supply: 'Bill of supply', commercial_invoice: 'Invoice (no GST)',
};
/** The PDF calls an issued bill "Unpaid" (`statusAfter`). */
export const INVOICE_STATE_LABEL: Record<InvoiceState, string> = { issued: 'Unpaid', partly_paid: 'Partly paid', paid: 'Paid', cancelled: 'Cancelled' };
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
  /** Q14: the clinic appointment (booking id) this bill is for; part of the issued document. */
  appointmentId?: string;
  items: InvoiceLine[];
  totals: InvoiceTotals;
  lifecycleState: InvoiceState;
  /** 0 as issued; +1 per event (payment, cancellation). Q14: a payment names it (`expectedLifecycleVersion`). */
  lifecycleVersion: number;
  /** Q14 `withDue`: what has been paid so far and what is still due (paise; a cancelled bill has nothing due). */
  paidMinor?: number;
  dueMinor?: number;
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
  /** Q10: how the money of a paid bill went back (on its cancellation). Q14: `amountMinor` = what had been paid. */
  refund?: RefundInput;
  /** Q14: a payment's amount and its methods (one or several); absent on payments made before Q14 (the full total). */
  amountMinor?: number;
  splits?: PaymentSplit[];
  /** Q14: the payment's request key (the same key again answers this payment). */
  requestKey?: string;
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
  /**
   * Q14 `createInvoiceSchema.appointmentId`: the clinic appointment this bill is for (an in-clinic consultation of this
   * clinic, at the bill's branch, with the bill's doctor, not cancelled; one open bill per appointment: 409
   * APPOINTMENT_ALREADY_BILLED, 400 APPOINTMENT_BRANCH_MISMATCH / APPOINTMENT_DOCTOR_MISMATCH, 409 APPOINTMENT_CANCELLED).
   */
  appointmentId?: string;
  items: NewInvoiceLine[];
  idempotencyKey: string;
}
/**
 * `invoiceQuerySchema` (Q10): newest first; `cursor` is the exact `<ms>_<id>` from `pagination.nextCursor`; `from`/`to`
 * are IST dates (YYYY-MM-DD, inclusive); `q` searches serial, customer name and phone; `limit` 1–200 (default 50).
 */
export interface InvoiceQuery {
  state?: InvoiceState; branchId?: string; limit?: number; cursor?: string; from?: string; to?: string; q?: string;
  /** Q14: only the bills of this appointment. */
  appointmentId?: string;
}
/** Q14 `recordPaymentSchema.splits[]`: one method and its amount (paise, ≥ 1). */
export interface PaymentSplit { mode: InvoicePaymentMode; amountMinor: number; reference?: string }
/**
 * Q14 `recordPaymentSchema` as the workspace sends it: always `splits` (one or several methods summing to the payment),
 * the request key (the same key and content answer the payment already recorded: `replayed`), and the
 * `lifecycleVersion` the cashier decided on (409 LIFECYCLE_VERSION_CONFLICT otherwise). Never more than is due (409
 * AMOUNT_EXCEEDS_DUE); less than is due only where the partner allows part payments (409 PART_PAYMENTS_NOT_ALLOWED).
 */
export type PaymentInput = { note?: string; requestKey: string; expectedLifecycleVersion: number }
  & ({ splits: PaymentSplit[]; mode?: never } | { /** Q14 review: a ₹0 bill is marked paid with a plain method. */ mode: InvoicePaymentMode; splits?: never });
/** `recordPaymentSchema.splits.max(10)`. */
export const MAX_PAYMENT_SPLITS = 10;
/** `recordPayment` (controller/invoice.ts). Q12: `replayed` is inside `data` (true = this payment had already been recorded). */
export interface PaymentAnswer { invoice: Invoice; event: InvoiceEvent; replayed?: boolean }
/** Q12 `catalogueListQuerySchema.q`: trimmed, 1–60 characters; searches name or code (case-insensitive, literal). */
export const MAX_CATALOGUE_SEARCH = 60;
/** Q12 `abandonKey`: `abandoned` = that key can never make an item; `used` = it did (with the item). */
export interface CatalogueKeyAbandon { state: 'abandoned' | 'used'; item?: CatalogueItem | null }
/** `cancelInvoiceSchema.refund`: required for a PAID bill (400 REFUND_REQUIRED), refused for an unpaid one (NOTHING_TO_REFUND). */
export interface RefundInput {
  mode: InvoicePaymentMode; reference?: string; note?: string;
  /** Q14: when given it must equal the amount paid (400 REFUND_AMOUNT_MISMATCH): a payment landing meanwhile refuses the cancellation. */
  amountMinor?: number;
}

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

// ── Payments (Q14 mirrors of services/invoice.ts `paidOf`, `withDue`, `recordPayment`) ──

/** What a bill has been paid: `paidMinor` when the server says it; otherwise (pre-Q14 answers) a paid bill counts as paid in full. */
export function paidOf(inv: Pick<Invoice, 'paidMinor' | 'lifecycleState' | 'totals'>): number {
  if (typeof inv.paidMinor === 'number') return inv.paidMinor;
  return inv.lifecycleState === 'paid' ? inv.totals.totalMinor : 0;
}
/** What is still due: nothing on a cancelled bill. */
export function dueOf(inv: Pick<Invoice, 'paidMinor' | 'dueMinor' | 'lifecycleState' | 'totals'>): number {
  if (inv.lifecycleState === 'cancelled') return 0;
  if (typeof inv.dueMinor === 'number') return inv.dueMinor;
  return Math.max(0, inv.totals.totalMinor - paidOf(inv));
}
/** A bill can take a payment while something is due and it is neither paid nor cancelled. */
export const takesPayment = (inv: Pick<Invoice, 'paidMinor' | 'dueMinor' | 'lifecycleState' | 'totals'>) =>
  (inv.lifecycleState === 'issued' || inv.lifecycleState === 'partly_paid') && (dueOf(inv) > 0 || inv.totals.totalMinor === 0);

/**
 * Why the server would refuse this payment (`recordPaymentSchema` + `recordPayment`): 1–10 parts, each a positive
 * amount, references ≤ 200; never more than is due (AMOUNT_EXCEEDS_DUE); with part payments off, exactly what is due
 * (PART_PAYMENTS_NOT_ALLOWED). Null when it would be accepted.
 */
export function paymentProblem(splits: readonly { amountMinor: number | null; reference?: string }[], dueMinor: number, allowPartPayments: boolean,
  money: (minor: number) => string = (m) => `₹${(m / 100).toFixed(2)}`): string | null {
  if (splits.length === 0) return 'Add how the bill was paid.';
  if (splits.length > MAX_PAYMENT_SPLITS) return `At most ${MAX_PAYMENT_SPLITS} methods in one payment.`;
  if (splits.some((x) => x.amountMinor === null || !Number.isSafeInteger(x.amountMinor) || x.amountMinor <= 0)) return 'Enter each amount in rupees, more than ₹0.';
  if (splits.some((x) => (x.reference ?? '').trim().length > MAX_REFERENCE)) return `Use at most ${MAX_REFERENCE} characters for a reference.`;
  const total = splits.reduce((n, x) => n + (x.amountMinor ?? 0), 0);
  if (total > dueMinor) return `That is more than is due (${money(dueMinor)}). A bill is never paid more than what is due.`;
  if (!allowPartPayments && total !== dueMinor) return `Only full payment is taken here: the amounts must add up to ${money(dueMinor)}.`;
  return null;
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

/** `invoiceKeyParamSchema` allows 1–100 characters; the workspace only ever makes path-safe keys. */
const BILL_KEY_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
function checkKey(key: string): string {
  if (!BILL_KEY_PATTERN.test(key)) throw new Error('Invalid request key');
  return key;
}
/** Q12 `catalogueKeyParamSchema`: 8–100 path-safe characters. */
function checkItemKey(key: string): string {
  if (!ITEM_REQUEST_KEY_PATTERN.test(key)) throw new Error('Invalid request key');
  return key;
}
/** Q12: the search text the server accepts, or undefined for none (an over-long one is refused before any request). */
function searchText(q: string | undefined): string | undefined {
  const t = q?.trim();
  if (!t) return undefined;
  if (t.length > MAX_CATALOGUE_SEARCH) throw new Error('Search is too long');
  return t;
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
    /**
     * Active items (admin-disabled ones included, flagged), sorted by name; no paging. `includeInactive` adds
     * deactivated ones for catalogue managers (others get active ones only). Q12: `q` searches name or code on the server.
     */
    catalogue: (kind?: CatalogueItemKind, includeInactive = false, q?: string) =>
      c.get<CatalogueItem[]>(`${base()}/catalogue`, { query: { kind, includeInactive: includeInactive ? 'true' : undefined, q: searchText(q) } }),
    /** Q12: the item a create request key made (404 ITEM_NOT_FOUND: not made yet, never, or given up). `catalogue.manage`. */
    catalogueItemByKey: (key: string) => c.get<CatalogueItem>(`${base()}/catalogue/by-key/${checkItemKey(key)}`),
    /** Q12: gives up a lost item create, decided by the server (the key is claimed with the item). `catalogue.manage`. */
    abandonCatalogueKey: (key: string) => c.post<CatalogueKeyAbandon>(`${base()}/catalogue/by-key/${checkItemKey(key)}/abandon`, { body: {} }),
    catalogueItem: (id: string) => c.get<CatalogueItem>(item(id)),
    createCatalogueItem: (body: NewCatalogueItem) => c.post<CatalogueItem>(`${base()}/catalogue`, { body }),
    updateCatalogueItem: (id: string, body: CatalogueItemUpdate) => c.put<CatalogueItem>(item(id), { body }),
    /** Sets `isActive: false` (listed again only with `includeInactive`). */
    deactivateCatalogueItem: (id: string) => c.delete<unknown>(item(id)),
    /** Q10: a deactivated item comes back (409 ITEM_ALREADY_ACTIVE); an admin-disabled one stays disabled. */
    reactivateCatalogueItem: (id: string) => c.post<CatalogueItem>(`${item(id)}/reactivate`, { body: {} }),

    /** One page of bills with `total` and `nextCursor`. */
    invoices: (q: InvoiceQuery = {}): Promise<Page<Invoice>> => {
      if (q.appointmentId !== undefined) checkId(q.appointmentId, 'appointment');
      return c.page<Invoice>(`${base()}/invoices`, { query: { ...q } });
    },
    /** Q10: the bill a request key produced (404 INVOICE_NOT_FOUND when none, in the caller's scope). */
    invoiceByKey: (key: string) => c.get<Invoice>(`${base()}/invoices/by-key/${checkKey(key)}`),
    /** Q10: gives up a lost bill: `abandoned` = it can never be issued; `used` = it was, with the bill. */
    abandonInvoiceKey: (key: string) =>
      c.post<{ state: 'abandoned' | 'used'; invoice?: Invoice | null }>(`${base()}/invoices/by-key/${checkKey(key)}/abandon`, { body: {} }),
    invoice: (id: string) => c.get<{ invoice: Invoice; events: InvoiceEvent[] }>(invoice(id)),
    /** Once-only by `body.idempotencyKey`: the same key with the same request answers the bill already issued. */
    createInvoice: (body: NewInvoice) => {
      if (body.appointmentId !== undefined) checkId(body.appointmentId, 'appointment');
      return c.post<Invoice>(`${base()}/invoices`, { body });
    },
    /** The bill's PDF as of lifecycle `version` (0 = as issued; default = now), read with the session's token. */
    invoicePdf: (id: string, version?: number, signal?: AbortSignal) =>
      c.blob(`${invoice(id)}/pdf`, { query: { version }, signal }),
    /** Q14: always as `splits` with the request key and the version decided on (see `PaymentInput`). */
    recordPayment: (id: string, body: PaymentInput) => {
      if (!ITEM_REQUEST_KEY_PATTERN.test(body.requestKey)) throw new Error('Invalid request key');
      if (!Number.isSafeInteger(body.expectedLifecycleVersion) || body.expectedLifecycleVersion < 0) throw new Error('Invalid bill version');
      const knownMode = (m: string) => PAYMENT_MODES.some((x) => x.value === m);
      if (body.mode !== undefined ? !knownMode(body.mode) || body.splits !== undefined
        : !body.splits || body.splits.length < 1 || body.splits.length > MAX_PAYMENT_SPLITS
          || body.splits.some((x) => !Number.isSafeInteger(x.amountMinor) || x.amountMinor <= 0 || !knownMode(x.mode))) {
        throw new Error('Invalid payment');
      }
      return c.post<PaymentAnswer>(`${invoice(id)}/pay`, { body });
    },
    cancelInvoice: (id: string, reason: string, refund?: RefundInput) =>
      c.post<{ invoice: Invoice; event: InvoiceEvent }>(`${invoice(id)}/cancel`, { body: { reason, ...(refund ? { refund } : {}) } }),

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
