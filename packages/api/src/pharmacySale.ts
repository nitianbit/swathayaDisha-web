import type { ApiClient, Page } from './client.ts';
import { PHONE_PATTERN } from './auth.ts';
import { idOf } from './assisted.ts';
import { pharmacyOrdersApi, refId, type OrderStatus, type PharmacyOrder } from './pharmacyOrders.ts';

/**
 * WQ50: a counter sale (backend `src1/modules/pharmacyOrders`, `pharmacyCustomers`, `file`; stage 43f46f57). The pharmacy
 * picks a linked customer or links a walk-in by name and phone (`POST /pharmacy-customers`: found or made by phone, so
 * sending it again is safe), creates an in-store pickup order from its stock (`POST /pharmacy-orders`; the server prices
 * it from the stock's retail price, else its wholesale price; prices include GST, which the order shows as `taxTotal`
 * inside the total; any prescription medicine puts it under pharmacist review, P9), and records the counter payment
 * (`pharmacyOrdersApi().markPaid`, refused until the pharmacist approved an Rx order). The create has NO request key on
 * r35 (400 REQUEST_KEY_UNSUPPORTED for a plain order): a lost answer is looked for among this customer's in-store orders
 * that did not exist before the attempt (`saleCandidates`), never sent again.
 */

/** `GET /pharmacy-customers` rows: the holder's id, the name this pharmacy may show (typed, else masked) and the phone. */
export interface SaleCustomer {
  _id: string;
  userId: { _id?: string; name?: string | null; phone?: string | null } | null;
  typedName?: string | null;
}
export interface SaleLine { medicineId: string; orderedQty: number }
/** What the create sends (the rest is fixed: in-store, paid at the counter, picked up). */
export interface SaleBody { customerId: string; items: SaleLine[]; isWalkIn: boolean; prescriptionUrls: string[] }
export interface SaleAnswer { order: PharmacyOrder; paymentRequired: boolean }
/** How the counter was paid (sent as the mark-paid `paymentSource`). */
export type CounterPayment = 'cash' | 'upi';
export const COUNTER_PAYMENTS: readonly CounterPayment[] = ['cash', 'upi'];

/** `createPharmacyCustomerSchema`. */
export const MAX_CUSTOMER_NAME = 200;
export const MAX_SALE_SEARCH = 100;

/** A walk-in's problems before asking (the server checks again): which fields are wrong. */
export function walkInProblems(w: { name: string; phone: string; consent: boolean }): { name?: true; phone?: true; consent?: true } {
  const name = w.name.trim();
  return {
    ...(name.length < 1 || name.length > MAX_CUSTOMER_NAME ? { name: true as const } : {}),
    ...(PHONE_PATTERN.test(w.phone.trim()) ? {} : { phone: true as const }),
    ...(w.consent ? {} : { consent: true as const }),
  };
}

/** Rows a sale can use: only those naming the holder (a row without a `userId._id` is left out). */
export const usableCustomers = (rows: readonly SaleCustomer[]) =>
  rows.filter((r): r is SaleCustomer & { userId: { _id: string } } => typeof r.userId?._id === 'string' && /^[0-9a-fA-F]{24}$/.test(r.userId._id));

/**
 * The create's JSON body, or a throw for a bad id: built BEFORE the owned request is sent, so a programming error is
 * never taken for an unknown outcome.
 */
export function saleRequestBody(b: SaleBody) {
  return {
    orderType: 'in_store' as const, customerId: idOf(b.customerId, 'customer'),
    items: b.items.map((l) => ({ medicineId: idOf(l.medicineId, 'medicine'), orderedQty: l.orderedQty })),
    paymentMode: 'in_store_payment' as const, deliveryMode: 'pickup' as const, isWalkIn: b.isWalkIn,
    ...(b.prescriptionUrls.length ? { prescriptionUrls: b.prescriptionUrls } : {}),
  };
}

export function pharmacySaleApi(c: ApiClient) {
  const orders = pharmacyOrdersApi(c);
  return {
    /** This pharmacy's linked customers, by the name it may see or the phone (never the email). */
    customers: (search: string, page = 1, limit = 20): Promise<Page<SaleCustomer>> => {
      const s = search.trim();
      if (s.length > MAX_SALE_SEARCH) throw new Error('Search is too long'); // i18n-ignore: a programming error, the field limits it
      return c.page<SaleCustomer>('/pharmacy-customers', { query: { ...(s ? { search: s } : {}), page, limit } });
    },
    /** Links a walk-in (the patient agreed): found or made by phone, so the same call again answers the same holder. */
    linkWalkIn: (w: { name: string; phone: string }) =>
      c.post<{ userId: string; isNewUser: boolean }>('/pharmacy-customers', { body: { name: w.name.trim().replace(/\s+/g, ' '), phone: w.phone.trim(), consent: true } }),
    /** Sends a body made by `saleRequestBody`. */
    create: (body: ReturnType<typeof saleRequestBody>) => c.post<SaleAnswer>('/pharmacy-orders', { body }),
    /** This customer's in-store orders, newest first (the ones before a sale, and to find a sale whose answer was lost). */
    recentFor: (customerId: string) => orders.list({ customerId: idOf(customerId, 'customer'), orderType: 'in_store', limit: 20 }),
    /** A prescription (image or PDF) for this sale; its stored link goes into the create. */
    uploadPrescription: async (file: File): Promise<string | null> => {
      const form = new FormData();
      form.append('files', file);
      const r = await c.post<{ files?: { url?: string }[] }>('/file/upload/pharmacy-order-prescription', { form });
      const url = r?.files?.[0]?.url;
      return typeof url === 'string' && url ? url : null;
    },
  };
}

/** An order that is not (or no longer) a sale someone is waiting for. */
const CLOSED: readonly OrderStatus[] = ['cancelled', 'rejected', 'abandoned'];

/**
 * The orders that may be the sale `b` whose answer was lost: this customer's open in-store orders with exactly its
 * medicines and quantities that did NOT exist before it was sent (`before`: the ids read then). One = found; more = say so.
 */
export function saleCandidates(orders: readonly PharmacyOrder[], b: SaleBody, before: readonly string[]): PharmacyOrder[] {
  const known = new Set(before.map((x) => x.toLowerCase()));
  const key = (l: SaleLine) => `${String(l.medicineId).toLowerCase()}:${l.orderedQty}`;
  const want = b.items.map(key).sort().join(',');
  return orders.filter((o) => !known.has(o._id.toLowerCase()) && o.orderType === 'in_store' && !CLOSED.includes(o.status)
    && (refId(o.customerId) ?? '').toLowerCase() === b.customerId.toLowerCase() && o.items.map(key).sort().join(',') === want);
}
