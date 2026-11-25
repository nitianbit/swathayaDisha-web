import type { OrderStatus, PharmacyOrder, PrescriptionRefundStatus } from '@jansetu/api';
import type { StatusWords } from '../../common.tsx';
import { t, type CustomerKey } from '../../i18n/index.ts';

/** Customer words for a pharmacy order's state. */
export const ORDER_STATUS: Readonly<Record<OrderStatus, StatusWords>> = {
  placed: { key: 'status.placed', tone: 'warn' },
  accepted: { key: 'status.acceptedByPharmacy', tone: 'ok' },
  packed: { key: 'status.packed', tone: 'ok' },
  ready_for_pickup: { key: 'status.readyToCollect', tone: 'ok' },
  out_for_delivery: { key: 'status.outForDelivery', tone: 'ok' },
  delivery_failed: { key: 'status.deliveryFailed', tone: 'warn' },
  completed: { key: 'status.completed' },
  cancelled: { key: 'status.cancelled', tone: 'danger' },
  rejected: { key: 'status.notAccepted', tone: 'danger' },
  abandoned: { key: 'status.cancelledNotPaid', tone: 'danger' },
  pending_cancel: { key: 'status.cancellationRequested', tone: 'warn' },
};

/** An order's status badge; an unknown status shows as the server sent it. */
export function orderStatusOf(status: OrderStatus) {
  const s = Object.hasOwn(ORDER_STATUS, status) ? ORDER_STATUS[status] : undefined;
  return s ? { label: t(s.key), tone: s.tone } : { label: status as string };
}

const REFUND_STATUS: Readonly<Record<PrescriptionRefundStatus, CustomerKey>> = {
  wallet_pending: 'order.refund.walletPending',
  wallet_credited: 'order.refund.walletCredited',
  source_processing: 'order.refund.sourceProcessing',
  source_refunded: 'order.refund.sourceRefunded',
  manual_review: 'order.refund.manualReview',
};
/** Where a prescription refund is; an unknown state shows as the server sent it. */
export const refundStatusText = (status: PrescriptionRefundStatus) =>
  (Object.hasOwn(REFUND_STATUS, status) ? t(REFUND_STATUS[status]) : status as string);

const PAYMENT_MODE: Readonly<Record<string, CustomerKey>> = {
  online_payment: 'order.paymentMode.online',
  in_store_payment: 'order.paymentMode.inStore',
  cash_on_delivery: 'order.paymentMode.cod',
};
/** How an order is paid; an unknown mode shows as the server sent it. */
export const paymentModeLabel = (mode: string) => (Object.hasOwn(PAYMENT_MODE, mode) ? t(PAYMENT_MODE[mode]!) : mode);

export const orderTitle = (o: PharmacyOrder) => (o.orderNumber ? t('order.title', { number: o.orderNumber }) : t('order.titleFallback'));
export const pharmacyName = (o: PharmacyOrder) =>
  typeof o.pharmacyId === 'object' && o.pharmacyId?.name ? o.pharmacyId.name : undefined;
export const isUnpaid = (o: PharmacyOrder) => !o.paymentStatus || o.paymentStatus === 'pending' || o.paymentStatus === 'failed';
