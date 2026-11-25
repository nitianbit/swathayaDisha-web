import type { ApiClient, Page } from './client.ts';
import { PHONE_PATTERN } from './auth.ts';
import { idOf } from './assisted.ts';
import { refId, type PharmacyOrder } from './pharmacyOrders.ts';

/**
 * WQ50: a counter sale (backend `src1/modules/pharmacyOrders`, `pharmacyCustomers`, `file`; stage 43f46f57). The pharmacy
 * picks a linked customer or links a walk-in by name and phone (`POST /pharmacy-customers`: found or made by phone, so
 * sending it again is safe), creates an in-store pickup order from its stock (`POST /pharmacy-orders`; the server prices
 * it from the stock's retail price and adds tax; any prescription medicine puts it under pharmacist review, P9), and
 * records the counter payment (`POST /pharmacy-orders/:id/mark-paid`, refused until the pharmacist approved an Rx
 * order). The create has NO request key on the server (400 REQUEST_KEY_UNSUPPORTED for a plain order): a lost answer is
 * found by reading this customer's in-store orders made since (`sameSale`), never by sending it again.
 */

/** `GET /pharmacy-customers` rows: the holder's id, the name this pharmacy may show (typed, else masked) and the phone. */
export interface SaleCustomer {
  _id: string;
  userId: { _id: string; name?: string | null; phone?: string | null };
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

const orderPath = (id: string) => `/pharmacy-orders/${idOf(id, 'order')}`;

export function pharmacySaleApi(c: ApiClient) {
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
    create: (b: SaleBody) => c.post<SaleAnswer>('/pharmacy-orders', { body: {
      orderType: 'in_store', customerId: idOf(b.customerId, 'customer'), items: b.items.map((l) => ({ medicineId: idOf(l.medicineId, 'medicine'), orderedQty: l.orderedQty })),
      paymentMode: 'in_store_payment', deliveryMode: 'pickup', isWalkIn: b.isWalkIn, ...(b.prescriptionUrls.length ? { prescriptionUrls: b.prescriptionUrls } : {}),
    } }),
    /** This customer's in-store orders, newest first (to find a sale whose answer was lost). */
    recentFor: (customerId: string) =>
      c.page<PharmacyOrder>('/pharmacy-orders', { query: { customerId: idOf(customerId, 'customer'), orderType: 'in_store', limit: 20 } }),
    order: (id: string) => c.get<PharmacyOrder>(orderPath(id)),
    markPaid: (id: string, how: CounterPayment) => c.post<PharmacyOrder>(`${orderPath(id)}/mark-paid`, { body: { paymentSource: how } }),
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

/** How long before the first attempt a found order may have been made (the server's clock may differ from this device's). */
const CLOCK_SLACK_MS = 120_000;

/** Whether `o` is the sale `b` sent at `since` (or later): this customer, in-store, the same medicines and quantities. */
export function sameSale(o: PharmacyOrder, b: SaleBody, since: number): boolean {
  if (o.orderType !== 'in_store' || (refId(o.customerId) ?? '').toLowerCase() !== b.customerId.toLowerCase()) return false;
  if (!o.createdAt || Date.parse(o.createdAt) < since - CLOCK_SLACK_MS) return false;
  const key = (l: SaleLine) => `${String(l.medicineId).toLowerCase()}:${l.orderedQty}`;
  const have = o.items.map(key).sort().join(',');
  return have === b.items.map(key).sort().join(',');
}
