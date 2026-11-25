import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { chargebackLot, chargebackTook, walletRecoverApi, type LabWalletLot, type Refusal } from '@jansetu/api';
import { Alert, Badge, ErrorState, formatDateTime, formatRupees, Loading } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { messageOf } from '../../errors.ts';
import { t } from '../../i18n/withdrawals/index.ts';
import { definitelyNotRecorded, newRequestKey } from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { useOneAtATime } from '../finance/finance.tsx';
import { wordedError } from '../pharmacy/withdrawals.tsx';

/**
 * WQ20/WQ23, moved here by WQ29 for every wallet (a pharmacy's too): the admin's card top-ups as lots (newest first, at
 * most 200). "Record a card dispute" (`POST /admin/wallet-lots/:lotId/chargeback`): a lab's or a doctor's top-up is only
 * flagged (nothing taken; the money stops being withdrawable); WQ29b (r32b §26.17.7): a pharmacy's is taken back at once
 * while the server's `WALLET_CHARGEBACK_FLAG_ONLY` is off (the default), so its step says so (`takesNow`); what was done is
 * said from the answer (the debit `entry`, or the flag). WQ29 (r32 §26.8.4): a flagged top-up then gets "Recover the money"
 * (`POST /admin/wallet-lots/:lotId/recover {reason, requestKey}`): from the balance, the rest owed, the wallet put on hold;
 * once per top-up, so a lost answer is read again and recovering again is safe.
 */
export function Lots({ load, refusal, queryKey, changed, takesNow = false }: {
  load: () => Promise<LabWalletLot[]>;
  refusal: (err: unknown) => Refusal;
  queryKey: readonly unknown[];
  /** Read again after a flag or a recover (the wallet and its lots). */
  changed: readonly unknown[];
  /** WQ29b: a pharmacy's dispute takes the money back at once (the server's default). */
  takesNow?: boolean;
}) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const lots = useQuery({ queryKey, queryFn: load });
  const { perform, busy } = useOneAtATime('lot');
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);
  const amountOf = (lot: LabWalletLot) => formatRupees(lot.amountMinor / 100);
  const dispute = (lot: LabWalletLot, reason: string) => perform(async () => {
    setNotice(null);
    try {
      const r = await chargebackLot(api, lot._id, reason);
      setNotice({ tone: 'ok', text: r.replayed ? t('flag.replayed') : chargebackTook(r) ? t('flag.taken', { amount: amountOf(lot) }) : t('flag.done', { amount: amountOf(lot) }) });
    } catch (err) {
      if (definitelyNotRecorded(err)) setNotice({ tone: 'error', text: t('flag.notRecorded', { error: refusal(err).message }) });
      else setNotice({ tone: 'warn', text: t('flag.notConfirmed', { error: refusal(err).message }) });
    } finally {
      await queryClient.invalidateQueries({ queryKey: changed });
    }
  });
  const recover = (lot: LabWalletLot, reason: string) => perform(async () => {
    setNotice(null);
    try {
      const r = await walletRecoverApi(api).lot(lot._id, { reason, requestKey: newRequestKey() });
      setNotice({ tone: 'ok', text: r.replayed ? t('recover.replayed') : t('recover.done', { amount: amountOf(lot) }) });
    } catch (err) {
      if (definitelyNotRecorded(err)) throw wordedError(err);
      setNotice({ tone: 'warn', text: t('recover.unknown', { error: messageOf(err) }) });
    } finally {
      await queryClient.invalidateQueries({ queryKey: changed });
    }
  });
  return (
    <section className="ws-section" aria-labelledby="lots-h">
      <h2 id="lots-h">{t('lots.title')}</h2>
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {/* WQ29c: a failed read again keeps the lots read before. */}
      {!lots.data ? (lots.isError ? <ErrorState message={refusal(lots.error).message} onRetry={() => void lots.refetch()} /> : <Loading label={t('lots.loading')} />)
        : lots.data.length === 0 ? <p className="ws-muted">{t('lots.none')}</p>
        : (
          <div className="ws-table-wrap">
            <table className="j-table">
              <caption className="j-sr-only">{t('lots.caption')}</caption>
              <thead>
                <tr><th scope="col">{t('lots.paid')}</th><th scope="col">{t('lots.amount')}</th><th scope="col">{t('lots.left')}</th><th scope="col">{t('lots.state')}</th>
                  <th scope="col"><span className="j-sr-only">{t('lots.dispute')}</span></th></tr>
              </thead>
              <tbody>
                {lots.data.map((l) => (
                  <tr key={l._id}>
                    <td>{formatDateTime(l.createdAt)}</td>
                    <td>{amountOf(l)}</td>
                    <td>{formatRupees(l.remainingMinor / 100)}</td>
                    <td>
                      {l.disputeState === 'lost' ? <Badge tone="danger">{t('lots.disputed')}</Badge> : l.closed ? t('lots.usedUp') : '—'}
                      {l.chargedBackAt && <div><Badge>{t('recover.badge')}</Badge></div>}
                    </td>
                    <td>
                      {l.disputeState !== 'lost' ? (
                        <ConfirmAction label={t('flag.button')} danger reason reasonLabel={t('flag.reason')} confirmLabel={t('flag.confirm')} disabled={busy}
                          consequence={takesNow ? t('flag.consequenceTake', { amount: amountOf(l), date: formatDateTime(l.createdAt) })
                            : t('flag.consequence', { amount: amountOf(l), date: formatDateTime(l.createdAt) })}
                          onConfirm={(reason) => dispute(l, reason)} />
                      ) : !l.chargedBackAt && (
                        <ConfirmAction label={t('recover.button')} danger reason reasonLabel={t('recover.reason')} confirmLabel={t('recover.confirm')} disabled={busy}
                          consequence={t('recover.consequence', { amount: amountOf(l), date: formatDateTime(l.createdAt) })}
                          onConfirm={(reason) => recover(l, reason)} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </section>
  );
}
