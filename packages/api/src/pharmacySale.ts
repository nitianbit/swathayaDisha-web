import type { ApiClient } from './client.ts';
import { PHONE_PATTERN } from './auth.ts';
import { idOf } from './assisted.ts';
import { OBJECT_ID_PATTERN } from './partners.ts';
import type { PharmacyOrder } from './pharmacyOrders.ts';

/**
 * WQ50: a counter sale (backend `src1/modules/pharmacyOrders`, `pharmacyCustomers`, `file`; stage 43f46f57). The pharmacy
 * picks a linked customer or links a walk-in by name and phone (`POST /pharmacy-customers`: found or made by phone, so
 * sending it again is safe), creates an in-store pickup order from its stock (`POST /pharmacy-orders`; the server prices
 * it from the stock's retail price, else its wholesale price; prices include GST, which the order shows as `taxTotal`
 * inside the total; any prescription medicine puts it under pharmacist review, P9), and records the counter payment
 * (`pharmacyOrdersApi().markPaid`, refused until the pharmacist approved an Rx order). r36: the create takes a request key
 * (the same key and body answer the first order again, `replayed`; another body 409 IDEMPOTENCY_KEY_REUSED; a key given
 * up 409 REQUEST_ABANDONED; 503 INDEXES_OUTDATED until the server's indexes are built), read by key and given up by key.
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
export interface SaleAnswer { order: PharmacyOrder; paymentRequired: boolean; replayed?: boolean }
/** r36 `GET /pharmacy-orders/by-key/:key` (and its abandon). */
export type SaleByKey = { state: 'used'; order: PharmacyOrder } | { state: 'abandoned' } | { state: 'unknown' };
/** r36 `inStoreSaleKeySchema`. */
export const SALE_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const keyOf = (k: string) => {
  if (!SALE_KEY_PATTERN.test(k)) throw new Error('Invalid request key'); // i18n-ignore: a programming error, keys are made here
  return k;
};
/** How the counter was paid (sent as the mark-paid `paymentSource`). */
export type CounterPayment = 'cash' | 'upi' | 'card';
export const COUNTER_PAYMENTS: readonly CounterPayment[] = ['cash', 'upi', 'card'];

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
  rows.filter((r): r is SaleCustomer & { userId: { _id: string } } => typeof r.userId?._id === 'string' && OBJECT_ID_PATTERN.test(r.userId._id));

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
  return {
    /**
     * This pharmacy's linked customers, by the name it may see or the phone (never the email). r36: a POST, so no name or
     * phone is ever in an address.
     */
    customers: (search: string, page = 1, limit = 20): Promise<SaleCustomer[]> => {
      const s = search.trim();
      if (s.length > MAX_SALE_SEARCH) throw new Error('Search is too long'); // i18n-ignore: a programming error, the field limits it
      return c.post<SaleCustomer[]>('/pharmacy-customers/search', { body: { ...(s ? { search: s } : {}), page, limit } }).then((r) => (Array.isArray(r) ? r : []));
    },
    /** Links a walk-in (the patient agreed): found or made by phone, so the same call again answers the same holder. */
    linkWalkIn: (w: { name: string; phone: string }) =>
      c.post<{ userId: string; isNewUser: boolean }>('/pharmacy-customers', { body: { name: w.name.trim().replace(/\s+/g, ' '), phone: w.phone.trim(), consent: true } }),
    /** Once per key: a body made by `saleRequestBody`, sent again unchanged with the same key after a lost answer. */
    create: (body: ReturnType<typeof saleRequestBody>, requestKey: string) => c.post<SaleAnswer>('/pharmacy-orders', { body: { ...body, requestKey: keyOf(requestKey) } }),
    byKey: (requestKey: string) => c.get<SaleByKey>(`/pharmacy-orders/by-key/${keyOf(requestKey)}`),
    abandon: (requestKey: string) => c.post<SaleByKey>(`/pharmacy-orders/by-key/${keyOf(requestKey)}/abandon`),
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
