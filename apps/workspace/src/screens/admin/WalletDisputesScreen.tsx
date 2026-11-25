import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { adminWalletFinanceApi, DISPUTE_STATES, type DisputeState, type WalletDispute } from '@jansetu/api';
import { formatPaise } from '@jansetu/i18n';
import { Alert, Badge, Empty, ErrorState, formatDateTime, Loading } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { t } from '../../i18n/withdrawals/index.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession } from '../../session.tsx';
import { useOneAtATime } from '../finance/finance.tsx';
import { withdrawalWords } from '../pharmacy/withdrawals.tsx';
import { useAdminScope } from './adminScope.ts';
import { useRecover } from './walletLots.tsx';

/**
 * WQ48 (backend r35 round 4f, `GET /admin/wallet-disputes`, design §26.10): every wallet's card top-ups with a recorded
 * dispute, newest first (at most 200), by state: to recover (Recover here, by the lot or by the payment id), recovered, or
 * never credited (nothing to take). Each row opens its wallet. Ids, amounts and times only.
 */
export function WalletDisputesScreen() {
  const scope = useAdminScope('wallet-disputes');
  return (
    <>
      <PageHeading title={t('disputes.title')}>{t('disputes.intro')}</PageHeading>
      <Disputes key={scope.identity} scopeKey={scope.key} />
    </>
  );
}

const TONE: Readonly<Record<DisputeState, 'warn' | 'ok' | undefined>> = { flagged: 'warn', recovered: 'ok', blocked: undefined };
const walletPath = (d: WalletDispute) => (!d.ownerId ? null : d.walletKind === 'pharmacy' ? `/admin/pharmacy-wallets/${d.ownerId}`
  : d.walletKind === 'lab' ? `/admin/partners/${d.ownerId}/wallet` : d.walletKind === 'doctor' ? `/admin/doctors/${d.ownerId}/wallet` : null);
const ownerWords = (kind: string | null) => (kind === 'pharmacy' || kind === 'lab' || kind === 'doctor' ? t(`owner.${kind}`) : '—');

function Disputes({ scopeKey }: { scopeKey: readonly unknown[] }) {
  const { api } = useSession();
  const [state, setState] = useState<DisputeState | ''>('flagged');
  const q = useQuery({ queryKey: [...scopeKey, state], queryFn: () => adminWalletFinanceApi(api).disputes({ limit: 200, ...(state ? { state } : {}) }) });
  const { perform, busy } = useOneAtATime('lot');
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);
  const recover = useRecover(scopeKey, setNotice);
  return (
    <section className="ws-section" aria-labelledby="disp-h">
      <h2 id="disp-h" className="j-sr-only">{t('disputes.title')}</h2>
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      <div className="ws-filter">
        <div className="j-field">
          <label htmlFor="disp-state">{t('disputes.filter')}</label>
          <select id="disp-state" value={state} onChange={(e) => setState(e.target.value as DisputeState | '')}>
            {DISPUTE_STATES.map((s) => <option key={s} value={s}>{t(`disputes.state.${s}`)}</option>)}
            <option value="">{t('disputes.filter.all')}</option>
          </select>
        </div>
      </div>
      {!q.data ? (q.isError ? <ErrorState message={withdrawalWords(q.error)} onRetry={() => void q.refetch()} /> : <Loading />)
        : q.data.length === 0 ? <Empty title={t('disputes.none')} />
        : (
          <div className="ws-table-wrap">
            <table className="j-table">
              <caption className="j-sr-only">{t('disputes.caption')}</caption>
              <thead>
                <tr>
                  <th scope={'col'}>{t('disputes.wallet')}</th><th scope={'col'}>{t('disputes.amount')}</th><th scope={'col'}>{t('disputes.left')}</th>
                  <th scope={'col'}>{t('disputes.when')}</th><th scope={'col'}>{t('disputes.state')}</th><th scope={'col'}>{t('disputes.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {q.data.map((d) => {
                  const path = walletPath(d);
                  const amount = d.amountMinor === null ? '—' : formatPaise(d.amountMinor);
                  const target = d.lotId ? { lotId: d.lotId } : { paymentRecordId: d.paymentRecordId };
                  return (
                    <tr key={d.paymentRecordId}>
                      <td>
                        {ownerWords(d.walletKind)}
                        <div className="ws-muted">{t('disputes.ref', { ref: d.paymentRecordId.slice(-6).toUpperCase() })}</div>
                        {path && <div><Link to={path}>{t('admin.openWallet')}</Link></div>}
                      </td>
                      <td>{amount}</td>
                      <td>{d.remainingMinor === null ? '—' : formatPaise(d.remainingMinor)}</td>
                      <td>{d.chargebackAt ? formatDateTime(d.chargebackAt) : d.at ? formatDateTime(d.at) : '—'}</td>
                      <td>
                        <Badge tone={TONE[d.state]}>{t(`disputes.state.${d.state}`)}</Badge>
                        {d.recoveredAt && <div className="ws-muted">{formatDateTime(d.recoveredAt)}</div>}
                      </td>
                      <td>
                        {d.state === 'flagged' && (
                          <ConfirmAction label={t('recover.button')} danger reason reasonLabel={t('recover.reason')} confirmLabel={t('recover.confirm')} disabled={busy}
                            consequence={t('disputes.recoverConsequence', { amount })}
                            onConfirm={(reason) => perform(() => recover(target, amount, reason))} />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
    </section>
  );
}
