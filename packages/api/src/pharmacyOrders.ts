import type { ApiClient, Page } from './client.ts';

/** Mirrors src1/modules/pharmacyOrders/types (only the fields the screens read). */
export type OrderStatus =
  | 'placed' | 'accepted' | 'packed' | 'ready_for_pickup' | 'out_for_delivery' | 'delivery_failed'
  | 'completed' | 'abandoned' | 'cancelled' | 'rejected';
export type PaymentStatus = 'pending' | 'authorized' | 'paid' | 'failed' | 'refunded' | 'partially_paid';
export type PrescriptionStatus = 'not_required' | 'pending' | 'approved' | 'rejected';

export interface OrderItem {
  medicineId: string;
  medicineName?: string;
  orderedQty: number;
  unitPrice: number;
  lineTotal: number;
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
  deliveryMode?: 'pickup' | 'delivery';
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
    /** A prescription file, fetched with the staff token (`GET /file/fetch?url=`). */
    prescriptionFile: (storedUrl: string, signal?: AbortSignal) =>
      c.blob('/file/fetch', { query: { url: fetchableFileUrl(storedUrl) }, signal }),
  };
}

export type { Page };
