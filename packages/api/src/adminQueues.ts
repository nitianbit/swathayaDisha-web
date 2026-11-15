import type { ApiClient, Page } from './client.ts';
import type { OrderStatus, PaymentStatus, PharmacyOrder, PrescriptionRefund } from './pharmacyOrders.ts';

/** GET /pharmacy-orders/prescription-refunds/attention row (admin): refunds that did not settle on their own (P2). */
export interface RefundAttentionRow {
  _id: string;
  orderNumber?: string;
  pharmacyId: string;
  customerId?: string;
  status: OrderStatus;
  paymentStatus?: PaymentStatus;
  prescriptionRefund: PrescriptionRefund;
  updatedAt?: string;
}

export type CancelState = 'requested' | 'calling' | 'unknown';

/** GET /external-bookings/bookings/cancellations/attention row (admin, backend W2c). */
export interface OpenCancellation {
  _id: string;
  status?: string;
  integration: string;
  providerType?: string;
  appointmentType?: string;
  bookingDate?: string;
  bookingTime?: string;
  patientName?: string;
  doctorName?: string;
  labName?: string;
  packageNames?: string[];
  testNames?: string[];
  price?: number;
  paymentStatus?: string;
  /** Every booking the provider may hold for it; `cancelled` = the provider acknowledged that one's cancellation. */
  providerRefs: { ref: string; cancelled: boolean }[];
  /** Fingerprint of exactly these provider obligations; a reconciliation must send it back unchanged. */
  obligations: string;
  cancel: {
    by: 'user' | 'admin' | 'system';
    reason?: string;
    at: string;
    state: CancelState;
    calls: number;
    nextAt?: string;
    needsAdmin: boolean;
    blockedBy?: string;
    error?: string;
  };
}

export type ProviderOutcome = 'absent' | 'cancelled';

export function adminQueuesApi(c: ApiClient) {
  return {
    /** D3: paid pharmacy orders waiting for a cancellation decision (an admin or the selling pharmacy decides). */
    orderCancellations: (q: { page?: number; limit?: number } = {}): Promise<Page<PharmacyOrder>> =>
      c.page<PharmacyOrder>('/pharmacy-orders', { query: { status: 'pending_cancel', ...q } }),
    /** A pharmacy's name for display (GET /pharmacies/:id). */
    pharmacyName: async (id: string): Promise<string | undefined> => {
      if (!/^[0-9a-fA-F]{24}$/.test(id)) return undefined;
      const p = await c.get<{ name?: unknown } | null>(`/pharmacies/${id}`);
      return p && typeof p.name === 'string' && p.name.trim() ? p.name.trim() : undefined;
    },
    refundsNeedingAttention: (limit = 100) =>
      c.get<RefundAttentionRow[]>('/pharmacy-orders/prescription-refunds/attention', { query: { limit } }),
    openCancellations: (q: { scope?: 'admin' | 'open'; page?: number; limit?: number } = {}): Promise<Page<OpenCancellation>> =>
      c.page<OpenCancellation>('/external-bookings/bookings/cancellations/attention', { query: { ...q } }),
    /**
     * Admin attestation after checking with the provider: 'cancelled' = every provider booking of it is cancelled;
     * 'absent' = no provider booking exists. Either settles the cancellation (refund) when nothing else is open.
     */
    reconcileCancellation: (bookingId: string, providerOutcome: ProviderOutcome, expectedObligations: string) => {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(bookingId)) throw new Error('Invalid booking id');
      // Refused with 409 EXTERNAL_OBLIGATIONS_CHANGED if the obligations differ from what the admin reviewed.
      return c.post<{ _id: string; status?: string }>(`/external-bookings/bookings/${bookingId}/reconcile-cancellation`,
        { body: { providerOutcome, expectedObligations } });
    },
  };
}
