import type { ApiClient, Page } from './client.ts';
import { t } from './i18n/customer/index.ts';
import { wordMap } from './i18n/words.ts';

/**
 * Q2 customer "Bills": in-house invoices issued by partner labs and clinics to this customer (linked by phone when the
 * bill was issued). Mirrors src1/modules/partners/types/invoice.ts and controller/invoice.ts (`listCustomerBills`,
 * `getCustomerBill`, `getCustomerBillPdf`). Every amount is integer paise (`*Minor`).
 */

export type BillDocumentKind = 'tax_invoice' | 'bill_of_supply' | 'commercial_invoice';
/** Q14: `partly_paid` = some payments recorded, an amount still due (where the partner takes part payments). */
export type BillState = 'issued' | 'partly_paid' | 'paid' | 'cancelled';
export type BillPaymentMode = 'cash' | 'upi' | 'card' | 'bank' | 'other';

export interface BillLine {
  catalogItemId?: string;
  description: string;
  hsn?: string;
  sac?: string;
  qty: number;
  unitPriceMinor: number;
  discountMinor: number;
  gstRate: 0 | 5 | 12 | 18 | 28;
  /** r42: `exempt` on a tax invoice's exempt line (health care at 0%); absent: taxable. */
  taxTreatment?: 'taxable' | 'exempt';
  /** Line amount before GST (qty × unit − discount). */
  amountMinor: number;
}

export interface BillTotals {
  subtotalMinor: number;
  discountMinor: number;
  taxableMinor: number;
  /** r42: the exempt lines' value (only on a tax invoice with one); `taxableMinor` is then the taxable lines only. */
  exemptMinor?: number;
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
  totalMinor: number;
  currency: 'INR';
}

export interface Bill {
  _id: string;
  partnerId: string;
  branchId: string;
  /** e.g. "LAB/2026-27/000123" */
  serial: string;
  financialYear?: string;
  documentKind: BillDocumentKind;
  issuedAt: string;
  supplier: { name: string; legalName?: string; gstin?: string; pan?: string; address: string; placeOfSupply: string };
  customer: { name: string; phone?: string; gstin?: string; age?: number; gender?: string; placeOfSupply?: string };
  /** The partner's doctor named on the bill. */
  doctorId?: string;
  /** Q9: that doctor's name (read time). */
  doctorName?: string;
  items: BillLine[];
  totals: BillTotals;
  lifecycleState: BillState;
  lifecycleVersion: number;
  /** Q14: paid so far and still due (paise). */
  paidMinor?: number;
  dueMinor?: number;
}

/** A payment or the cancellation, in lifecycle order. */
export interface BillEvent {
  _id?: string;
  kind: 'payment' | 'cancellation';
  mode?: BillPaymentMode;
  reference?: string;
  reason?: string;
  note?: string;
  /** Q14: a payment's amount and methods (one or several). The customer view carries no request key or staff id. */
  amountMinor?: number;
  splits?: { mode: BillPaymentMode; amountMinor: number; reference?: string }[];
  version: number;
  at: string;
}

export const BILL_KIND_LABEL: Record<BillDocumentKind, string> = wordMap(t, {
  tax_invoice: 'bill.kind.tax_invoice', bill_of_supply: 'bill.kind.bill_of_supply', commercial_invoice: 'bill.kind.commercial_invoice',
});

export const BILL_PAYMENT_MODE: Record<BillPaymentMode, string> = wordMap(t, {
  cash: 'bill.payment.cash', upi: 'bill.payment.upi', card: 'bill.payment.card', bank: 'bill.payment.bank', other: 'bill.payment.other',
});

/** The GST lines worth showing: CGST + SGST within the state, IGST across states; zero parts are left out. */
export function gstSplit(totals: BillTotals): { label: string; minor: number }[] {
  return [
    { label: t('bill.tax.cgst'), minor: totals.cgstMinor },
    { label: t('bill.tax.sgst'), minor: totals.sgstMinor },
    { label: t('bill.tax.igst'), minor: totals.igstMinor },
  ].filter((x) => Number(x.minor) > 0);
}

const hex = /^[0-9a-fA-F]{24}$/;
const id = (v: string) => { if (!hex.test(v)) throw new Error('Invalid bill id'); return v; }; // i18n-ignore: a programming error, not shown

/** A safe download name from the serial (the server's own file name uses the same shape). */
export const billFileName = (b: Pick<Bill, 'serial' | 'lifecycleVersion'>) =>
  `${(b.serial || 'bill').replace(/[^A-Za-z0-9-]+/g, '-')}-v${b.lifecycleVersion ?? 0}.pdf`;

export function customerBillsApi(c: ApiClient) {
  return {
    /** Q9: newest first, paged. */
    bills: (page = 1, limit = 20): Promise<Page<Bill>> => c.page<Bill>('/bills', { query: { page, limit } }),
    bill: (invoiceId: string) => c.get<{ invoice: Bill; events: BillEvent[] }>(`/bills/${id(invoiceId)}`)
      .then((d) => ({ invoice: d.invoice, events: [...(d.events ?? [])].sort((a, b) => a.version - b.version) })),
    /**
     * The PDF bytes of exactly `version` of the bill (0 = as issued; invoicePdfQuerySchema), read with the customer's
     * token; never a link carrying a token.
     */
    pdf: (invoiceId: string, version: number, signal?: AbortSignal) => {
      if (!Number.isInteger(version) || version < 0) throw new Error('Invalid bill version'); // i18n-ignore: a programming error, not shown
      return c.blob(`/bills/${id(invoiceId)}/pdf`, { query: { version }, signal });
    },
  };
}
