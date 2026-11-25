import { useQuery, useQueryClient } from '@tanstack/react-query';
import { adminQueuesApi, pharmacyOrdersApi } from '@jansetu/api';
import { Badge, Empty, ErrorState, formatDateTime, formatRupees, Loading } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { t } from '../../i18n/admin/index.ts';
import { useSession } from '../../session.tsx';
import { REFUND_STATUS_LABEL } from '../pharmacy/orderLabels.ts';

/** A code the screen has no words for yet: shown readably ("Some new reason"), never as a raw constant alone. */
export const humanCode = (code: string) => {
  const words = code.replace(/[_.]+/g, ' ').trim().toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : code;
};
/**
 * A `RefundCause` (`pharmacyOrders/prescriptionRefund.ts`; WQ11b: `order_cancelled`, a pharmacy order cancelled after
 * payment) in words: `refunds.cause.<cause>` in the admin catalogue.
 */
export const refundCause = (cause: string) => {
  const key = `refunds.cause.${cause}`;
  return t.has(key) ? t(key) : humanCode(cause);
};
/** Why a refund is stuck (`prescriptionRefund.lastError`), in words (`refunds.problem.<code>`); the code stays next to it for support. */
export const refundProblem = (code: string) => {
  const key = `refunds.problem.${code}`;
  return `${t.has(key) ? t(key) : humanCode(code)} (${code})`;
};

/** Pharmacy refunds that did not settle on their own (P2): waiting wallet credits, finance reviews, slow card refunds. */
export function RefundsScreen() {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['admin', 'refunds-attention'], queryFn: () => adminQueuesApi(api).refundsNeedingAttention() });

  return (
    <>
      <PageHeading title={t('refunds.title')}>{t('refunds.intro')}</PageHeading>
      {q.isPending ? <Loading label={t('refunds.loading')} />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : q.data.length === 0 ? <Empty title={t('refunds.empty')} />
        : (
          <div className="ws-table-wrap">
            <table className="j-table">
              <thead>
                <tr><th scope="col">{t('refunds.col.order')}</th><th scope="col">{t('refunds.col.why')}</th><th scope="col">{t('refunds.col.refund')}</th>
                  <th scope="col">{t('common.amount')}</th><th scope="col">{t('refunds.col.problem')}</th><th scope="col">{t('refunds.col.since')}</th>
                  <th scope="col">{t('common.action')}</th></tr>
              </thead>
              <tbody>
                {q.data.map((r) => {
                  const refund = r.prescriptionRefund;
                  return (
                    <tr key={r._id}>
                      <td>{r.orderNumber ?? r._id.slice(-8)}</td>
                      <td>{refund.cause ? refundCause(refund.cause) : '—'}</td>
                      <td><Badge tone={refund.status === 'manual_review' ? 'danger' : 'warn'}>{REFUND_STATUS_LABEL[refund.status] ?? refund.status}</Badge></td>
                      <td>{formatRupees(refund.walletAmount)}</td>
                      <td>{refund.lastError ? refundProblem(refund.lastError) : '—'}</td>
                      <td>{formatDateTime(refund.updatedAt ?? r.updatedAt)}</td>
                      <td>
                        {refund.status === 'wallet_pending' ? (
                          <ConfirmAction label={t('refunds.retry')} confirmLabel={t('refunds.retryNow')}
                            consequence={t('refunds.retryConsequence', { amount: formatRupees(refund.walletAmount) })}
                            onConfirm={async () => {
                              try { await pharmacyOrdersApi(api).retryRefund(r._id); }
                              finally { await queryClient.invalidateQueries({ queryKey: ['admin', 'refunds-attention'] }); }
                            }} />
                        ) : refund.status === 'manual_review' ? <span className="ws-muted">{t('refunds.financeReview')}</span>
                          : <span className="ws-muted">{t('refunds.waitingProvider')}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      {q.data && q.data.length >= 100 && <span className="ws-muted">{t('refunds.first100')}</span>}
    </>
  );
}
