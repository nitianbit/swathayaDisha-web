import type { PharmacyOrder } from '@jansetu/api';
import { Alert, formatDateTime, shared } from '@jansetu/ui';
import { ORDER_STATUS_LABEL } from '../screens/pharmacy/orderLabels.ts';
import { t } from '../i18n/components/index.ts';
import { ConfirmAction } from './ConfirmAction.tsx';

/** Who is looking: the selling pharmacy and admins decide; a buying pharmacy only reads. */
export type CancelViewer = 'seller' | 'admin' | 'buyer';

/** Amount-free on purpose: the refund is what the payment records show was paid (it can differ from the order total). */
export function refundText(order: PharmacyOrder): string {
  if (order.paymentStatus === 'refunded') return t('cancelRequest.refund.returned');
  if (order.paymentStatus === 'authorized') return t('cancelRequest.refund.authorized');
  if (order.paymentMode !== 'online_payment') return t('cancelRequest.refund.offline');
  return t('cancelRequest.refund.online');
}

/**
 * D3: a paid order waits for this decision (the selling pharmacy or an admin). Each decision names the request it was
 * made on, so a newer request makes it fail with "changed" instead of deciding the wrong one. Key this component by
 * the request id: a newer request then replaces it and closes any open confirmation.
 */
export function CancelRequestPanel({ order, viewer, onApprove, onReject, headingLevel = 2 }: {
  order: PharmacyOrder; viewer: CancelViewer;
  onApprove: (requestId: string, note: string) => Promise<unknown>; onReject: (requestId: string, note: string) => Promise<unknown>;
  headingLevel?: 2 | 3;
}) {
  const r = order.cancelRequest!;
  const requestId = r.requestId; // fixed for this panel's life (the panel is keyed by it)
  const by = r.requestedByType === 'user' ? 'customer' : r.requestedByType === 'admin' ? 'admin'
    : viewer === 'seller' ? 'yourPharmacy' : 'pharmacy';
  const date = formatDateTime(r.requestedAt);
  const returned = order.paymentStatus === 'refunded';
  const refund = refundText(order);
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const headingId = `cancel-h-${order._id}`;
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <Heading id={headingId}>{t('cancelRequest.title')}</Heading>
      <Alert tone="warn">
        {r.reason ? t(`cancelRequest.byWithReason.${by}`, { date, reason: r.reason }) : t(`cancelRequest.by.${by}`, { date })} {refund}
      </Alert>
      {viewer !== 'buyer' && (
        <div className="ws-actions">
          <ConfirmAction label={t('cancelRequest.approve')} confirmLabel={t('cancelRequest.approve.confirm')} danger
            // i18n-ignore: `reason` is a mode (an optional reason field), not words
            reason="optional" reasonLabel={shared('field.note')}
            consequence={`${t('cancelRequest.approve.consequence')} ${refund}`}
            onConfirm={(note) => onApprove(requestId, note)} />
          <ConfirmAction label={t('cancelRequest.keep')} confirmLabel={t('cancelRequest.keep.confirm')} reason
            reasonLabel={t('cancelRequest.keep.reason')} disabled={returned}
            consequence={t('cancelRequest.keep.consequence', { status: ORDER_STATUS_LABEL[r.fromStatus] })}
            onConfirm={(note) => onReject(requestId, note)} />
          {returned && <span className="ws-muted">{t('cancelRequest.returned')}</span>}
        </div>
      )}
    </section>
  );
}
