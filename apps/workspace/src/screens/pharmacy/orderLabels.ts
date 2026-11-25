import type { DeliveryExceptionType, OrderStatus, PharmacyOrder, PrescriptionRefundStatus } from '@jansetu/api';
import { t } from '../../i18n/pharmacy/index.ts';

// The status words live in @jansetu/api so every screen (orders, prescription review, quality) uses the same ones.
export { ORDER_STATUS_LABEL, PAYMENT_STATUS_LABEL } from '@jansetu/api';

/** Words read at render (a language switch shows the new words). */
export const REFUND_STATUS_LABEL = (): Record<PrescriptionRefundStatus, string> => ({
  wallet_pending: t('orderLabels.waitingToCreditTheWallet'),
  wallet_credited: t('orderLabels.creditedToTheCustomerS'),
  source_processing: t('orderLabels.beingRefundedToTheOriginal'),
  source_refunded: t('orderLabels.refundedToTheOriginalPayment'),
  manual_review: t('orderLabels.needsManualReviewByFinance'),
});

export const DELIVERY_EXCEPTION_LABEL = (): Record<DeliveryExceptionType, string> => ({
  delivery_failed: t('orderLabels.deliveryFailed'),
  retry_delivery: t('orderLabels.retryDelivery'),
  switch_to_pickup: t('orderLabels.switchToPickup'),
  not_collected: t('orderLabels.notCollected'),
  refused_at_door: t('orderLabels.refusedAtTheDoor'),
});

/** Forward moves shown as buttons, with the words staff use. */
export const FORWARD_LABEL = (): Partial<Record<OrderStatus, string>> => ({
  accepted: t('orderLabels.acceptOrder'),
  packed: t('orderLabels.markPacked'),
  ready_for_pickup: t('orderLabels.readyForPickup'),
  out_for_delivery: t('orderLabels.outForDelivery'),
  completed: t('orderLabels.markCompleted'),
});

/** Money has (or may have) been taken. */
export const holdsMoney = (o: PharmacyOrder) =>
  o.paymentStatus === 'paid' || o.paymentStatus === 'partially_paid' || o.paymentStatus === 'authorized';

export const TERMINAL: readonly OrderStatus[] = ['completed', 'abandoned', 'cancelled', 'rejected'];

export const orderLabel = (o: PharmacyOrder) => o.orderNumber ?? o._id.slice(-8);

/** WQ50b: an in-store or cash-on-delivery order can be marked paid here (the Order page and New sale share this). */
export const canMarkPaid = (o: PharmacyOrder) => (o.paymentMode === 'in_store_payment' || o.paymentMode === 'cash_on_delivery')
  && o.paymentStatus !== 'paid' && !TERMINAL.includes(o.status) && o.status !== 'pending_cancel';
/**
 * WQ50b (P9, `markPaid` in pharmacyOrders services): an order with a prescription medicine is paid only once the
 * pharmacist approved it; the server refuses otherwise (409 PRESCRIPTION_REVIEW_REQUIRED).
 */
export const paymentWaitsForPharmacist = (o: PharmacyOrder) =>
  ((o.prescriptionStatus ?? 'not_required') !== 'not_required' || o.items.some((i) => i.prescriptionRequired === true))
  && !(o.prescriptionStatus === 'approved' && o.prescriptionReview?.decision === 'approved');

const PRESCRIPTION_GATED: readonly OrderStatus[] = ['packed', 'ready_for_pickup', 'out_for_delivery', 'completed'];

/**
 * Why the backend would refuse moving `o` to `target` (pharmacyOrders services, updateStatus), so the page can say so
 * before the click. `null` = allowed as far as these rules go; the server still decides.
 */
export function blockedReason(o: PharmacyOrder, target: OrderStatus): string | null {
  if (['packed', 'ready_for_pickup', 'out_for_delivery'].includes(target)
    && o.paymentMode !== 'cash_on_delivery' && o.paymentStatus !== 'paid') {
    return t('common.waitingForPayment');
  }
  if (o.refill && target === 'accepted' && o.paymentStatus !== 'paid') {
    return t('orderLabels.aRefillOrderIsConfirmed');
  }
  if (target === 'completed' && o.paymentStatus !== 'paid') return t('orderLabels.recordThePaymentFirst');
  if (PRESCRIPTION_GATED.includes(target) && o.prescriptionStatus !== 'approved' && o.prescriptionStatus !== 'not_required') {
    return t('orderLabels.thePrescriptionMustBeApproved');
  }
  return null;
}
