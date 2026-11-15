import type { OrderStatus, PharmacyOrder, PrescriptionRefundStatus } from '@jansetu/api';

/** Customer words for a pharmacy order's state. */
export const ORDER_STATUS: Record<OrderStatus, { label: string; tone?: 'ok' | 'warn' | 'danger' }> = {
  placed: { label: 'Placed', tone: 'warn' },
  accepted: { label: 'Accepted by the pharmacy', tone: 'ok' },
  packed: { label: 'Packed', tone: 'ok' },
  ready_for_pickup: { label: 'Ready to collect', tone: 'ok' },
  out_for_delivery: { label: 'Out for delivery', tone: 'ok' },
  delivery_failed: { label: 'Delivery failed', tone: 'warn' },
  completed: { label: 'Completed' },
  cancelled: { label: 'Cancelled', tone: 'danger' },
  rejected: { label: 'Not accepted', tone: 'danger' },
  abandoned: { label: 'Cancelled (not paid in time)', tone: 'danger' },
  pending_cancel: { label: 'Cancellation requested', tone: 'warn' },
};

export const REFUND_STATUS: Record<PrescriptionRefundStatus, string> = {
  wallet_pending: 'Your refund is being added to your Jansetu wallet.',
  wallet_credited: 'Refunded to your Jansetu wallet.',
  source_processing: 'Your refund is on its way to your card/UPI. Banks can take 5–7 working days.',
  source_refunded: 'Refunded to your card/UPI. Banks can take 5–7 working days to show it.',
  manual_review: 'Our team is checking your refund and will contact you if needed.',
};

export const PAYMENT_MODE: Record<string, string> = {
  online_payment: 'Online',
  in_store_payment: 'Pay at the pharmacy',
  cash_on_delivery: 'Cash on delivery',
};

export const orderTitle = (o: PharmacyOrder) => (o.orderNumber ? `Order ${o.orderNumber}` : 'Pharmacy order');
export const pharmacyName = (o: PharmacyOrder) =>
  typeof o.pharmacyId === 'object' && o.pharmacyId?.name ? o.pharmacyId.name : undefined;
export const isUnpaid = (o: PharmacyOrder) => !o.paymentStatus || o.paymentStatus === 'pending' || o.paymentStatus === 'failed';
