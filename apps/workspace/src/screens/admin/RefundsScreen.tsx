import { useQuery, useQueryClient } from '@tanstack/react-query';
import { adminQueuesApi, pharmacyOrdersApi } from '@jansetu/api';
import { Badge, Empty, ErrorState, formatDateTime, formatRupees, Loading } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession } from '../../session.tsx';
import { REFUND_STATUS_LABEL } from '../pharmacy/orderLabels.ts';

const CAUSE: Record<string, string> = {
  prescription_rejected: 'Prescription rejected',
  delivery_not_collected: 'Not collected',
  delivery_refused: 'Refused at the door',
  stock_hold_cancelled: 'Cancelled for held stock',
};

/** Pharmacy refunds that did not settle on their own (P2): waiting wallet credits, finance reviews, slow card refunds. */
export function RefundsScreen() {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['admin', 'refunds-attention'], queryFn: () => adminQueuesApi(api).refundsNeedingAttention() });

  return (
    <>
      <PageHeading title="Refunds needing attention">
        Pharmacy refunds that did not complete on their own. Waiting wallet credits can be retried; finance reviews are
        settled outside this workspace.
      </PageHeading>
      {q.isPending ? <Loading label="Loading refunds…" />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : q.data.length === 0 ? <Empty title="No refund needs attention" />
        : (
          <div className="ws-table-wrap">
            <table className="j-table">
              <thead>
                <tr><th scope="col">Order</th><th scope="col">Why</th><th scope="col">Refund</th><th scope="col">Amount</th>
                  <th scope="col">Problem</th><th scope="col">Since</th><th scope="col">Action</th></tr>
              </thead>
              <tbody>
                {q.data.map((r) => {
                  const refund = r.prescriptionRefund;
                  return (
                    <tr key={r._id}>
                      <td>{r.orderNumber ?? r._id.slice(-8)}</td>
                      <td>{refund.cause ? CAUSE[refund.cause] ?? refund.cause : '—'}</td>
                      <td><Badge tone={refund.status === 'manual_review' ? 'danger' : 'warn'}>{REFUND_STATUS_LABEL[refund.status] ?? refund.status}</Badge></td>
                      <td>{formatRupees(refund.walletAmount)}</td>
                      <td>{refund.lastError ?? '—'}</td>
                      <td>{formatDateTime(refund.updatedAt ?? r.updatedAt)}</td>
                      <td>
                        {refund.status === 'wallet_pending' ? (
                          <ConfirmAction label="Retry" confirmLabel="Retry now"
                            consequence={`Try again to credit ${formatRupees(refund.walletAmount)} to the customer’s wallet.`}
                            onConfirm={async () => {
                              try { await pharmacyOrdersApi(api).retryRefund(r._id); }
                              finally { await queryClient.invalidateQueries({ queryKey: ['admin', 'refunds-attention'] }); }
                            }} />
                        ) : refund.status === 'manual_review' ? <span className="ws-muted">Finance to review</span>
                          : <span className="ws-muted">Waiting for the payment provider</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      {q.data && q.data.length >= 100 && <span className="ws-muted">Showing the first 100.</span>}
    </>
  );
}
