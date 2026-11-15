import type { ApiClient } from './client.ts';

/**
 * Q2 customer "Bills": in-house invoices issued by partner labs and clinics to this customer (linked by phone when the
 * bill was issued). Mirrors src1/modules/partners/types/invoice.ts and controller/invoice.ts (`listCustomerBills`,
 * `getCustomerBill`, `getCustomerBillPdf`). Every amount is integer paise (`*Minor`).
 */

export type BillDocumentKind = 'tax_invoice' | 'bill_of_supply' | 'commercial_invoice';
export type BillState = 'issued' | 'paid' | 'cancelled';
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
  /** Line amount before GST (qty × unit − discount). */
  amountMinor: number;
}

export interface BillTotals {
  subtotalMinor: number;
  discountMinor: number;
  taxableMinor: number;
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
  /** The partner's doctor named on the bill (a specialist id; the bill carries no name). */
  doctorId?: string;
  items: BillLine[];
  totals: BillTotals;
  lifecycleState: BillState;
  lifecycleVersion: number;
}

/** A payment or the cancellation, in lifecycle order. */
export interface BillEvent {
  _id?: string;
  kind: 'payment' | 'cancellation';
  mode?: BillPaymentMode;
  reference?: string;
  reason?: string;
  note?: string;
  version: number;
  at: string;
}

export const BILL_KIND_LABEL: Record<BillDocumentKind, string> = {
  tax_invoice: 'Tax invoice', bill_of_supply: 'Bill of supply', commercial_invoice: 'Invoice',
};

export const BILL_PAYMENT_MODE: Record<BillPaymentMode, string> = { cash: 'Cash', upi: 'UPI', card: 'Card', bank: 'Bank transfer', other: 'Other' };

/** The GST lines worth showing: CGST + SGST within the state, IGST across states; zero parts are left out. */
export function gstSplit(t: BillTotals): { label: string; minor: number }[] {
  return [
    { label: 'CGST', minor: t.cgstMinor },
    { label: 'SGST', minor: t.sgstMinor },
    { label: 'IGST', minor: t.igstMinor },
  ].filter((x) => Number(x.minor) > 0);
}

const hex = /^[0-9a-fA-F]{24}$/;
const id = (v: string) => { if (!hex.test(v)) throw new Error('Invalid bill id'); return v; };

/** A safe download name from the serial (the server's own file name uses the same shape). */
export const billFileName = (b: Pick<Bill, 'serial' | 'lifecycleVersion'>) =>
  `${(b.serial || 'bill').replace(/[^A-Za-z0-9-]+/g, '-')}-v${b.lifecycleVersion ?? 0}.pdf`;

export function customerBillsApi(c: ApiClient) {
  return {
    /** Newest first; the backend returns at most 200 and does not page. */
    bills: () => c.get<Bill[]>('/bills').then((d) => (Array.isArray(d) ? d : [])),
    bill: (invoiceId: string) => c.get<{ invoice: Bill; events: BillEvent[] }>(`/bills/${id(invoiceId)}`)
      .then((d) => ({ invoice: d.invoice, events: [...(d.events ?? [])].sort((a, b) => a.version - b.version) })),
    /** The PDF bytes (`application/pdf`), read with the customer's token; never a link carrying a token. */
    pdf: (invoiceId: string, signal?: AbortSignal) => c.blob(`/bills/${id(invoiceId)}/pdf`, { signal }),
  };
}
