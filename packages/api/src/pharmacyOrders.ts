import type { ApiClient, Page } from './client.ts';

/** Mirrors src1/modules/pharmacyOrders/types (only the fields the screens read). */
export type OrderStatus =
  | 'placed' | 'accepted' | 'packed' | 'ready_for_pickup' | 'out_for_delivery' | 'delivery_failed'
  | 'completed' | 'abandoned' | 'cancelled' | 'rejected'
  /** D3: a paid order whose cancellation waits for the pharmacy or an admin (frozen). */
  | 'pending_cancel';
export type PaymentStatus = 'pending' | 'authorized' | 'paid' | 'failed' | 'refunded' | 'partially_paid';
export type PrescriptionStatus = 'not_required' | 'pending' | 'approved' | 'rejected';

export interface BatchAllocation { batchId: string; batchNumber: string; expiryDate: string; quantity: number }

export interface OrderItem {
  medicineId: string;
  medicineName?: string;
  orderedQty: number;
  unitPrice: number;
  lineTotal: number;
  itemStatus?: 'active' | 'replaced' | 'removed';
  batchAllocations?: BatchAllocation[];
}

export type PaymentMode = 'online_payment' | 'in_store_payment' | 'cash_on_delivery';
export type DeliveryExceptionType = 'delivery_failed' | 'retry_delivery' | 'switch_to_pickup' | 'not_collected' | 'refused_at_door';

export interface DeliveryException {
  type: DeliveryExceptionType;
  reason?: string;
  at: string;
  fromStatus: OrderStatus;
  toStatus: OrderStatus;
  refundRequired: boolean;
}

export type PrescriptionRefundStatus = 'wallet_pending' | 'wallet_credited' | 'source_processing' | 'source_refunded' | 'manual_review';

/** Refund owed after a rejection, a failed delivery or a stock-hold cancellation (P2); amounts as the backend stores them. */
export interface PrescriptionRefund {
  cause?: 'prescription_rejected' | 'delivery_not_collected' | 'delivery_refused' | 'stock_hold_cancelled' | 'order_cancelled';
  status: PrescriptionRefundStatus;
  walletAmount: number;
  gatewayAmountPaise: number;
  walletCreditedAt?: string;
  lastError?: string;
  updatedAt?: string;
}

export interface PrescriptionReview {
  decision: 'approved' | 'rejected';
  pharmacistName: string;
  pharmacistRegistrationNumber: string;
  reason?: string;
  reviewedDocumentCount: number;
  reviewedAt: string;
}

/** A reference the backend may populate (the review queue populates the customer's name and phone). */
export type Ref<T> = string | ({ _id: string } & T);

export interface PharmacyOrder {
  /** D3: the current (or last) cancellation request. */
  cancelRequest?: CancelRequest;
  _id: string;
  orderNumber?: string;
  /** The selling pharmacy: only it may review the prescription. */
  pharmacyId: Ref<{ name?: string }>;
  /** Set when another pharmacy is the buyer (B2B). */
  buyerPharmacyId?: Ref<{ name?: string }> | null;
  customerId?: Ref<{ name?: string; phone?: string }> | null;
  orderType: 'in_store' | 'online';
  status: OrderStatus;
  items: OrderItem[];
  grandTotal?: number;
  paymentStatus?: PaymentStatus;
  paymentMode?: PaymentMode;
  /** The online payment's record (customers check it with /payments/reconcile). */
  paymentTransactionId?: string;
  deliveryMode?: 'pickup' | 'delivery';
  deliveryAddress?: string;
  deliveryExceptions?: DeliveryException[];
  prescriptionRefund?: PrescriptionRefund;
  customerReturns?: { count: number; refundedPaise: number; lastReturnAt?: string };
  refill?: { subscriptionId: string; cycleDate: string; paymentDueBy: string };
  prescriptionUrls?: string[];
  prescriptionStatus?: PrescriptionStatus;
  prescriptionReview?: PrescriptionReview;
  notes?: string;
  createdAt?: string;
}

export interface OrderQuery {
  status?: OrderStatus;
  paymentStatus?: PaymentStatus;
  prescriptionStatus?: PrescriptionStatus;
  page?: number;
  limit?: number;
}

export interface PrescriptionReviewRequest {
  decision: 'approve' | 'reject';
  pharmacistName: string;
  pharmacistRegistrationNumber: string;
  reason?: string;
  /** Exactly the order's `prescriptionUrls`, in order: the backend refuses the review if the set changed. */
  reviewedPrescriptionUrls: string[];
}

/**
 * Generic status moves the backend allows (pharmacyOrders services, ALLOWED_STATUS_TRANSITIONS). `delivery_failed`
 * moves only through delivery exceptions.
 */
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  placed: ['accepted', 'rejected', 'cancelled', 'abandoned'],
  accepted: ['packed', 'cancelled'],
  packed: ['ready_for_pickup', 'out_for_delivery', 'cancelled'],
  ready_for_pickup: ['completed'],
  out_for_delivery: ['completed'],
  delivery_failed: [],
  completed: [],
  abandoned: [],
  cancelled: [],
  rejected: [],
  // Only through the cancellation-request decisions (D3).
  pending_cancel: [],
};

/** D3: statuses from which a cancellation can be requested (later ones go through delivery exceptions). */
export const CANCELLABLE_STATUSES: readonly OrderStatus[] = ['placed', 'accepted', 'packed'];

/** D3: the current (or last) cancellation request of an order. Decisions name `requestId`. */
export interface CancelRequest {
  requestId: string;
  state: 'pending' | 'approved' | 'rejected';
  fromStatus: OrderStatus;
  paymentStatusAtRequest: PaymentStatus;
  requestedByType: 'user' | 'pharmacy' | 'admin';
  requestedAt: string;
  reason?: string;
  decidedByType?: 'pharmacy' | 'admin';
  decidedAt?: string;
  decisionNote?: string;
  restoredStatus?: OrderStatus;
}

/** Delivery exceptions and the states each starts from (pharmacyOrders services, recordDeliveryException). */
export const DELIVERY_EXCEPTION_FROM: Readonly<Record<DeliveryExceptionType, readonly OrderStatus[]>> = {
  delivery_failed: ['out_for_delivery'],
  retry_delivery: ['delivery_failed'],
  switch_to_pickup: ['out_for_delivery', 'delivery_failed'],
  not_collected: ['ready_for_pickup'],
  refused_at_door: ['out_for_delivery', 'delivery_failed'],
};

export interface CustomerReturnLine {
  medicineId: string;
  batchId: string;
  quantity: number;
  disposition: 'restock' | 'discard';
}

export interface CustomerReturnRequest {
  /** Same key on a retry returns the first record instead of a second return (pattern ^[A-Za-z0-9_-]{8,64}$). */
  requestKey: string;
  reason: string;
  lines: CustomerReturnLine[];
  /** Rupees, at most 2 decimals; omitted = no refund. */
  refundAmount?: number;
}

export interface CustomerReturn {
  _id: string;
  requestKey: string;
  lines: (CustomerReturnLine & { medicineName?: string; batchNumber?: string; valuePaise?: number })[];
  reason: string;
  returnValuePaise: number;
  refundPaise: number;
  createdAt: string;
}

/** Order states the backend's review accepts (pharmacyOrders services, PRESCRIPTION_REVIEWABLE_STATUSES). */
export const PRESCRIPTION_REVIEWABLE_STATUSES: readonly OrderStatus[] = ['placed', 'accepted'];

export const refId = (ref: Ref<object> | null | undefined): string | undefined =>
  ref == null ? undefined : typeof ref === 'string' ? ref : ref._id;

/**
 * Turns a stored prescription URL into the `url` that `GET /file/fetch` understands. Uploads are stored as
 * `/api/static/<path>` (backend file service), but fetch only strips `/api/v1/file/...` prefixes, so the static form
 * must be rewritten. The review itself must still send the stored URLs verbatim.
 */
export function fetchableFileUrl(stored: string): string {
  const STATIC = '/api/static/';
  return stored.startsWith(STATIC) ? `/api/v1/file/static/${stored.slice(STATIC.length)}` : stored;
}

/** Backend rule (prescriptionReviewSchema). */
export const REGISTRATION_NUMBER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9/\-. ]{2,59}$/;

const idPath = (id: string) => {
  if (!/^[0-9a-fA-F]{24}$/.test(id)) throw new Error('Invalid order id');
  return `/pharmacy-orders/${id}`;
};

export function pharmacyOrdersApi(c: ApiClient) {
  return {
    list: (q: OrderQuery = {}) => c.page<PharmacyOrder>('/pharmacy-orders', { query: { ...q } }),
    /** Pharmacist work queue: orders this pharmacy sells whose prescription can be reviewed now; oldest first. */
    reviewQueue: (q: { page?: number; limit?: number } = {}) =>
      c.page<PharmacyOrder>('/pharmacy-orders/prescription-reviews', { query: { ...q } }),
    get: (id: string) => c.get<PharmacyOrder>(idPath(id)),
    reviewPrescription: (id: string, body: PrescriptionReviewRequest) =>
      c.post<PharmacyOrder>(`${idPath(id)}/prescription-review`, { body }),
    updateStatus: (id: string, status: OrderStatus, notes?: string) =>
      c.post<PharmacyOrder>(`${idPath(id)}/status`, { body: { status, ...(notes ? { notes } : {}) } }),
    /** Only for in-store / cash-on-delivery orders. */
    markPaid: (id: string, body: { paymentSource?: string; notes?: string } = {}) =>
      c.post<PharmacyOrder>(`${idPath(id)}/mark-paid`, { body }),
    deliveryException: (id: string, type: DeliveryExceptionType, reason?: string) =>
      c.post<PharmacyOrder>(`${idPath(id)}/delivery-exception`, { body: { type, ...(reason ? { reason } : {}) } }),
    /** Re-attempts a `wallet_pending` refund. */
    retryRefund: (id: string) => c.post<PharmacyOrder>(`${idPath(id)}/prescription-refund/retry`),
    /** Moves this order's units off held (quarantined/recalled/expired) batches onto sellable ones. */
    reallocateHeldStock: (id: string) => c.post<{ order: PharmacyOrder; moves: unknown[] }>(`${idPath(id)}/reallocate-held-stock`),
    /** Cancels an order that holds units of a held batch; releases its stock and refunds it if paid. */
    stockHoldCancel: (id: string, reason: string) => c.post<PharmacyOrder>(`${idPath(id)}/stock-hold-cancel`, { body: { reason } }),
    /** D3: an unpaid order is cancelled at once; a paid one becomes pending_cancel until decided. */
    requestCancel: (id: string, reason?: string) =>
      c.post<PharmacyOrder>(`${idPath(id)}/cancel-request`, { body: reason ? { reason } : {} }),
    approveCancel: (id: string, requestId: string, note?: string) =>
      c.post<PharmacyOrder>(`${idPath(id)}/cancel-request/approve`, { body: { requestId, ...(note ? { note } : {}) } }),
    rejectCancel: (id: string, requestId: string, note: string) =>
      c.post<PharmacyOrder>(`${idPath(id)}/cancel-request/reject`, { body: { requestId, note } }),
    /** Returns already recorded for this order (newest first). */
    customerReturnsFor: (id: string, limit = 50, page = 1) => {
      idPath(id);
      return c.page<CustomerReturn>('/pharmacy-inventory/customer-returns', { query: { orderId: id, limit, page } });
    },
    customerReturn: (id: string, body: CustomerReturnRequest) =>
      c.post<CustomerReturn & { duplicate?: boolean }>(`${idPath(id)}/customer-returns`, { body }),
    /** A prescription file, fetched with the staff token (`GET /file/fetch?url=`). */
    prescriptionFile: (storedUrl: string, signal?: AbortSignal) =>
      c.blob('/file/fetch', { query: { url: fetchableFileUrl(storedUrl) }, signal }),
  };
}

export type { Page };
