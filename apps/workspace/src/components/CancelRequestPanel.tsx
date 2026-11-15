import type { PharmacyOrder } from '@jansetu/api';
import { Alert, formatDateTime } from '@jansetu/ui';
import { ORDER_STATUS_LABEL } from '../screens/pharmacy/orderLabels.ts';
import { ConfirmAction } from './ConfirmAction.tsx';

/** Who is looking: the selling pharmacy and admins decide; a buying pharmacy only reads. */
export type CancelViewer = 'seller' | 'admin' | 'buyer';

/** Amount-free on purpose: the refund is what the payment records show was paid (it can differ from the order total). */
export function refundText(order: PharmacyOrder): string {
  if (order.paymentStatus === 'refunded') return 'The payment was already returned to the customer.';
  if (order.paymentStatus === 'authorized') return 'The payment is still being confirmed; decide in a few minutes.';
  if (order.paymentMode !== 'online_payment') return 'The refund is not automatic for a cash or counter payment: an admin arranges it.';
  return 'What the customer paid online goes back to their Jansetu wallet first (they can ask for it on their card/UPI). If the payment cannot be matched to its record, an admin reviews the refund.';
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
  const by = r.requestedByType === 'user' ? 'the customer' : r.requestedByType === 'admin' ? 'an admin'
    : viewer === 'seller' ? 'your pharmacy' : 'the pharmacy';
  const returned = order.paymentStatus === 'refunded';
  const refund = refundText(order);
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const headingId = `cancel-h-${order._id}`;
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <Heading id={headingId}>Cancellation requested</Heading>
      <Alert tone="warn">
        Requested by {by} on {formatDateTime(r.requestedAt)}{r.reason ? `: “${r.reason}”` : ''}. Until it is decided the order
        cannot move. {refund}
      </Alert>
      {viewer !== 'buyer' && (
        <div className="ws-actions">
          <ConfirmAction label="Approve cancellation" confirmLabel="Yes, cancel the order" danger reason="optional" reasonLabel="Note"
            consequence={`The order is cancelled and its stock goes back to the pharmacy’s inventory. ${refund}`}
            onConfirm={(note) => onApprove(requestId, note)} />
          <ConfirmAction label="Keep the order" confirmLabel="Yes, keep it" reason reasonLabel="Why it is kept (shown to the customer)"
            disabled={returned}
            consequence={`The request is declined and the order continues from “${ORDER_STATUS_LABEL[r.fromStatus]}”.`}
            onConfirm={(note) => onReject(requestId, note)} />
          {returned && <span className="ws-muted">The payment was already returned, so the order cannot continue: approve to complete the cancellation.</span>}
        </div>
      )}
    </section>
  );
}
