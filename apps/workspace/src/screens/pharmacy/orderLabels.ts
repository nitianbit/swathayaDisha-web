import type { DeliveryExceptionType, OrderStatus, PharmacyOrder, PrescriptionRefundStatus } from '@jansetu/api';

// The status words live in @jansetu/api so every screen (orders, prescription review, quality) uses the same ones.
export { ORDER_STATUS_LABEL, PAYMENT_STATUS_LABEL } from '@jansetu/api';

export const REFUND_STATUS_LABEL: Record<PrescriptionRefundStatus, string> = {
  wallet_pending: 'Waiting to credit the wallet',
  wallet_credited: 'Credited to the customer’s wallet',
  source_processing: 'Being refunded to the original payment method',
  source_refunded: 'Refunded to the original payment method',
  manual_review: 'Needs manual review by finance',
};

export const DELIVERY_EXCEPTION_LABEL: Record<DeliveryExceptionType, string> = {
  delivery_failed: 'Delivery failed',
  retry_delivery: 'Retry delivery',
  switch_to_pickup: 'Switch to pickup',
  not_collected: 'Not collected',
  refused_at_door: 'Refused at the door',
};

/** Forward moves shown as buttons, with the words staff use. */
export const FORWARD_LABEL: Partial<Record<OrderStatus, string>> = {
  accepted: 'Accept order',
  packed: 'Mark packed',
  ready_for_pickup: 'Ready for pickup',
  out_for_delivery: 'Out for delivery',
  completed: 'Mark completed',
};

/** Money has (or may have) been taken. */
export const holdsMoney = (o: PharmacyOrder) =>
  o.paymentStatus === 'paid' || o.paymentStatus === 'partially_paid' || o.paymentStatus === 'authorized';

export const TERMINAL: readonly OrderStatus[] = ['completed', 'abandoned', 'cancelled', 'rejected'];

export const orderLabel = (o: PharmacyOrder) => o.orderNumber ?? o._id.slice(-8);

const PRESCRIPTION_GATED: readonly OrderStatus[] = ['packed', 'ready_for_pickup', 'out_for_delivery', 'completed'];

/**
 * Why the backend would refuse moving `o` to `target` (pharmacyOrders services, updateStatus), so the page can say so
 * before the click. `null` = allowed as far as these rules go; the server still decides.
 */
export function blockedReason(o: PharmacyOrder, target: OrderStatus): string | null {
  if (['packed', 'ready_for_pickup', 'out_for_delivery'].includes(target)
    && o.paymentMode !== 'cash_on_delivery' && o.paymentStatus !== 'paid') {
    return 'Waiting for payment.';
  }
  if (o.refill && target === 'accepted' && o.paymentStatus !== 'paid') {
    return 'A refill order is confirmed only after the customer pays.';
  }
  if (target === 'completed' && o.paymentStatus !== 'paid') return 'Record the payment first.';
  if (PRESCRIPTION_GATED.includes(target) && o.prescriptionStatus !== 'approved' && o.prescriptionStatus !== 'not_required') {
    return 'The prescription must be approved first.';
  }
  return null;
}
