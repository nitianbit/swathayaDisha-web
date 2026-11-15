import type { ApiClient, Page } from './client.ts';
import type { PaymentOrder } from './customer.ts';
import type { PaymentMode, PharmacyOrder } from './pharmacyOrders.ts';

/** GET /pharmacies row (public fields only). */
export interface PharmacyStore {
  _id: string;
  name: string;
  nickname?: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
  openingHours?: unknown;
  pickupAvailable?: boolean;
  deliveryAvailable?: boolean;
  profilePictureUrl?: string;
}

/** GET /pharmacy-inventory?pharmacyId= row, as a customer sees it (sellable quantity only). */
export interface StockRow {
  _id: string;
  pharmacyId: string;
  medicineId: string | { _id: string };
  availableQty: number;
  retailPrice?: number;
  isActive?: boolean;
  medicine?: { _id: string; name?: string; genericName?: string; brandName?: string; dosageForm?: string; strength?: string; manufacturer?: string };
}

/** One medicine on a pharmacy's shelf (several stock rows of one medicine are shown together). */
export interface ShelfItem {
  medicineId: string;
  name: string;
  detail: string;
  availableQty: number;
  /** Lowest and highest price across the rows; the cart shows the price actually charged. */
  minPrice?: number;
  maxPrice?: number;
}

export interface CartItem {
  medicineId: string;
  medicineName?: string;
  brandName?: string;
  genericName?: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  prescriptionRequired?: boolean;
}

export interface Cart {
  pharmacyId?: string | null;
  pharmacyName?: string | null;
  items: CartItem[];
  subtotal: number;
  requiresPrescription?: boolean;
  prescriptionMedicines?: { medicineId: string; name?: string }[];
}

export interface Checkout {
  paymentMode: PaymentMode;
  deliveryMode: 'pickup' | 'delivery';
  deliveryAddress?: string;
  notes?: string;
}

export interface CheckoutResult {
  order: PharmacyOrder;
  paymentRequired: boolean;
  payment?: PaymentOrder;
  /** P8: the request key had already placed this order (a repeat); nothing new was placed. */
  replayed?: boolean;
}

/**
 * Minutes after placing an online order within which a payment is applied (backend PHARMACY_ORDER_PAYMENT_WINDOW_MS);
 * a later capture is returned to the wallet, and the order is cancelled a few minutes later.
 */
export const PHARMACY_PAYMENT_WINDOW_MIN = 30;

const hex = /^[0-9a-fA-F]{24}$/;
const id = (v: string, what: string) => { if (!hex.test(v)) throw new Error(`Invalid ${what} id`); return v; };
const refOf = (v: string | { _id: string }) => (typeof v === 'string' ? v : v._id);

/** A cart in one shape whatever the server sent (an empty or missing cart is an empty cart, never a crash). */
export function normalizeCart(raw: unknown): Cart {
  const c = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Partial<Cart>;
  const items = Array.isArray(c.items) ? c.items.filter((i): i is CartItem => !!i && typeof i.medicineId === 'string' && Number(i.quantity) > 0) : [];
  return { ...c, items, subtotal: typeof c.subtotal === 'number' ? c.subtotal : items.reduce((n, i) => n + (Number(i.lineTotal) || 0), 0) };
}

/** Groups a pharmacy's stock rows by medicine (sellable quantity summed, price range kept). */
export function shelfOf(rows: readonly StockRow[]): ShelfItem[] {
  const byMedicine = new Map<string, ShelfItem>();
  for (const r of rows) {
    const medicineId = refOf(r.medicineId);
    // Inactive stock and stock without a positive price cannot be ordered (the cart refuses them).
    if (!hex.test(medicineId) || !(r.availableQty > 0) || r.isActive === false) continue;
    const m = r.medicine ?? { _id: medicineId };
    const prev = byMedicine.get(medicineId);
    const price = typeof r.retailPrice === 'number' && r.retailPrice > 0 ? r.retailPrice : undefined;
    if (prev) {
      prev.availableQty += r.availableQty;
      if (price !== undefined) {
        prev.minPrice = prev.minPrice === undefined ? price : Math.min(prev.minPrice, price);
        prev.maxPrice = prev.maxPrice === undefined ? price : Math.max(prev.maxPrice, price);
      }
    } else {
      byMedicine.set(medicineId, {
        medicineId,
        name: m.name || m.brandName || m.genericName || 'Medicine',
        detail: [m.strength, m.dosageForm, m.manufacturer].filter(Boolean).join(' · '),
        availableQty: r.availableQty,
        minPrice: price,
        maxPrice: price,
      });
    }
  }
  return [...byMedicine.values()];
}

/**
 * Customer pharmacy ordering: one cart per customer (one pharmacy at a time), checkout creates the order, online
 * orders are paid through Razorpay Checkout. Never sends `userId`/`customerId` to the order list: the server scopes it.
 */
export function customerPharmacyApi(c: ApiClient) {
  return {
    /** Verified, active pharmacies the customer may order from. Always paginated. */
    stores: (q: { search?: string; page?: number; limit?: number } = {}): Promise<Page<PharmacyStore>> =>
      c.page<PharmacyStore>('/pharmacies', { query: { page: q.page ?? 1, limit: q.limit ?? 20, search: q.search || undefined } }),
    store: (pharmacyId: string) => c.get<PharmacyStore>(`/pharmacies/${id(pharmacyId, 'pharmacy')}`),
    stock: (pharmacyId: string, q: { search?: string; page?: number; limit?: number } = {}): Promise<Page<StockRow>> =>
      c.page<StockRow>('/pharmacy-inventory', { query: { pharmacyId: id(pharmacyId, 'pharmacy'), isActive: true, search: q.search || undefined, page: q.page ?? 1, limit: q.limit ?? 50 } }),

    cart: () => c.get<unknown>('/pharmacy-cart').then(normalizeCart),
    /** `quantity` is a change: +1 adds a unit, -1 takes one off (the server drops the line at 0). A cart holds one pharmacy: another pharmacy answers 409 CART_PHARMACY_MISMATCH. */
    addToCart: (pharmacyId: string, medicineId: string, quantity: number) =>
      c.post<unknown>('/pharmacy-cart/items', { body: { pharmacyId: id(pharmacyId, 'pharmacy'), medicineId: id(medicineId, 'medicine'), quantity } }).then(normalizeCart),
    removeFromCart: (medicineId: string) => c.delete<unknown>(`/pharmacy-cart/items/${id(medicineId, 'medicine')}`).then(normalizeCart),
    clearCart: () => c.delete<unknown>('/pharmacy-cart'),
    /** Places the order (the server prices it again; 409 CART_PRICE_CHANGED if a price moved). Never retried automatically. */
    /** With a request key a repeat answers with the first order (`replayed`), never a second one. */
    checkout: (body: Checkout, requestKey?: string) => c.post<CheckoutResult>('/pharmacy-cart/checkout', { body: {
      ...(requestKey ? { requestKey } : {}),
      paymentMode: body.paymentMode, deliveryMode: body.deliveryMode,
      ...(body.deliveryMode === 'delivery' ? { deliveryAddress: body.deliveryAddress } : {}),
      ...(body.notes ? { notes: body.notes } : {}),
    } }),

    orders: (page = 1, limit = 20) => c.page<PharmacyOrder>('/pharmacy-orders', { query: { page, limit } }),
    order: (orderId: string) => c.get<PharmacyOrder>(`/pharmacy-orders/${id(orderId, 'order')}`),
    /**
     * P8: pay an unpaid online order (again). The server checks earlier attempts first (then it may already be paid:
     * `paymentRequired` false) and hands back the order's own open Razorpay order.
     */
    retryPayment: (orderId: string) => c.post<CheckoutResult>(`/pharmacy-orders/${id(orderId, 'order')}/retry-payment`),
    /** Unpaid: cancelled at once. Paid: waits for the pharmacy or Jansetu (pending_cancel); then refunded to the wallet. */
    requestCancel: (orderId: string, reason?: string) =>
      c.post<PharmacyOrder>(`/pharmacy-orders/${id(orderId, 'order')}/cancel-request`, { body: reason ? { reason } : {} }),
    /** Moves a wallet refund back to the card/UPI it was paid with. */
    refundToSource: (orderId: string) =>
      c.post<{ orderId: string; prescriptionRefund: PharmacyOrder['prescriptionRefund'] }>(`/pharmacy-orders/${id(orderId, 'order')}/prescription-refund/to-source`),
  };
}
