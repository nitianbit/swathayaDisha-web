import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  adminWalletFinanceApi, chargebackLot, chargebackTook, rupeesToPaise, walletRecoverApi, type LabWalletLot, type Refusal, type WalletKind,
} from '@jansetu/api';
import { formatPaise } from '@jansetu/i18n';
import { Alert, Badge, Button, ErrorState, formatDateTime, formatRupees, Loading, TextField } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { messageOf } from '../../errors.ts';
import { t } from '../../i18n/withdrawals/index.ts';
import { definitelyNotRecorded, newRequestKey, startOp, type PendingOp } from '../../requests.ts';
import { useSession, useStaff } from '../../session.tsx';
import { useOneAtATime, useReferralPayoutsPaused } from '../finance/finance.tsx';
import { CheckPanel, useOwnedOp } from '../pharmacy/ownedOp.tsx';
import { withdrawalWords, wordedError } from '../pharmacy/withdrawals.tsx';

type Notice = { tone: 'ok' | 'warn' | 'error'; text: string };

/**
 * WQ29's Recover, shared (WQ48) by the lots, the top-ups without a lot and the disputes list: by the lot, or (a top-up
 * credited without one) by its payment id; once per top-up, so a lost answer is read again and recovering again is safe.
 * Runs inside the caller's one-at-a-time `perform`; a refusal is thrown in words for the confirmation that asked.
 */
export function useRecover(changed: readonly unknown[], setNotice: (n: Notice | null) => void) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  return async (target: { lotId: string } | { paymentRecordId: string }, amount: string, reason: string) => {
    setNotice(null);
    try {
      const body = { reason, requestKey: newRequestKey() };
      const r = 'lotId' in target ? await walletRecoverApi(api).lot(target.lotId, body) : await walletRecoverApi(api).payment(target.paymentRecordId, body);
      setNotice({ tone: 'ok', text: r.replayed ? t('recover.replayed') : t('recover.done', { amount }) });
    } catch (err) {
      if (definitelyNotRecorded(err)) throw wordedError(err);
      setNotice({ tone: 'warn', text: t('recover.unknown', { error: messageOf(err) }) });
    } finally {
      await queryClient.invalidateQueries({ queryKey: changed });
    }
  };
}

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
  const [notice, setNotice] = useState<Notice | null>(null);
  const recoverBy = useRecover(changed, setNotice);
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
  const recover = (lot: LabWalletLot, reason: string) => perform(() => recoverBy({ lotId: lot._id }, amountOf(lot), reason));
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

/**
 * WQ48 (r35, WQ29 gap 3): a wallet's card top-ups credited before card money was tracked (no lot): never withdrawable and
 * found by nothing else, so a lost dispute on one is recovered here by its payment id (`/admin/wallet-payments/:id/recover`).
 */
export function TopupsWithoutLot({ kind, ownerId, queryKey, changed }: { kind: WalletKind; ownerId: string; queryKey: readonly unknown[]; changed: readonly unknown[] }) {
  const { api } = useSession();
  const list = useQuery({ queryKey, queryFn: () => adminWalletFinanceApi(api).topupsWithoutLot(kind, ownerId) });
  const { perform, busy } = useOneAtATime('lot');
  const [notice, setNotice] = useState<Notice | null>(null);
  const recoverBy = useRecover(changed, setNotice);
  return (
    <section className="ws-section" aria-labelledby="nolot-h">
      <h2 id="nolot-h">{t('noLot.title')}</h2>
      <p className="ws-muted">{t('noLot.intro')}</p>
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {!list.data ? (list.isError ? <ErrorState message={withdrawalWords(list.error)} onRetry={() => void list.refetch()} /> : <Loading />)
        : list.data.length === 0 ? <p className="ws-muted">{t('noLot.none')}</p>
        : (
          <div className="ws-table-wrap">
            <table className="j-table">
              <caption className="j-sr-only">{t('noLot.caption')}</caption>
              <thead>
                <tr><th scope={'col'}>{t('noLot.paid')}</th><th scope={'col'}>{t('noLot.amount')}</th><th scope={'col'}>{t('noLot.dispute')}</th>
                  <th scope={'col'}><span className="j-sr-only">{t('recover.button')}</span></th></tr>
              </thead>
              <tbody>
                {list.data.map((r) => (
                  <tr key={r.paymentRecordId}>
                    <td>{r.paidAt ? formatDateTime(r.paidAt) : '—'}</td>
                    <td>{formatPaise(r.amountMinor)}</td>
                    <td>{r.chargebackAt ? t('noLot.disputed', { date: formatDateTime(r.chargebackAt) }) : t('noLot.noDispute')}</td>
                    <td>
                      {r.chargebackAt && (
                        <ConfirmAction label={t('recover.button')} danger reason reasonLabel={t('recover.reason')} confirmLabel={t('recover.confirm')} disabled={busy}
                          consequence={t('recover.consequence', { amount: formatPaise(r.amountMinor), date: r.paidAt ? formatDateTime(r.paidAt) : '—' })}
                          onConfirm={(reason) => perform(() => recoverBy({ paymentRecordId: r.paymentRecordId }, formatPaise(r.amountMinor), reason))} />
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

interface PendingSetOff { amountMinor: number }

/**
 * WQ48 (r35 round 4e, §26.9): what a wallet owes Jansetu, paid from the owner's referral earnings: one owned request with
 * its key (a lost answer is checked by the key, sent again unchanged, or given up on the server). Shown only while the
 * wallet owes something (or a request is unconfirmed) and the server allows it: referral payouts on; paused, it says so.
 */
export function SetOffFromReferral({ kind, ownerId, owedMinor, scopeKey, changed }: {
  kind: WalletKind; ownerId: string; owedMinor: number; scopeKey: readonly unknown[]; changed: readonly unknown[];
}) {
  const { api } = useSession();
  const admin = useStaff();
  const queryClient = useQueryClient();
  const { op, send, settle } = useOwnedOp<PendingSetOff>(`wallet-setoff:${admin.id}:${kind}:${ownerId}`);
  const paused = useReferralPayoutsPaused(scopeKey, owedMinor > 0 || !!op);
  const { perform, busy } = useOneAtATime('wallet');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<{ amountMinor: number; requestKey: string } | null>(null);
  const [note, setNote] = useState<Notice | null>(null);
  const [givingUp, setGivingUp] = useState(false);
  const w = adminWalletFinanceApi(api);
  const reread = () => queryClient.invalidateQueries({ queryKey: changed });
  const owed = formatPaise(owedMinor);

  function check(e: FormEvent) {
    e.preventDefault();
    setNote(null);
    const amount = rupeesToPaise(text);
    if (amount === null || amount < 1 || amount > owedMinor) { setError(t('setoff.invalid', { owed })); return; }
    setError(null);
    setReview({ amountMinor: amount, requestKey: newRequestKey() });
  }

  async function pay(p: PendingOp<PendingSetOff>) {
    const r = await perform(() => send(p, (b) => w.setOff(kind, ownerId, { amountMinor: b.amountMinor, requestKey: p.requestKey })));
    if (r.kind === 'stale') return;
    if (r.kind === 'ok') {
      setReview(null); setText('');
      const amount = formatPaise(r.value.setoff.amountMinor);
      setNote({ tone: 'ok', text: r.value.replayed ? t('setoff.replayed', { amount }) : t('setoff.done', { amount }) });
      await reread();
      return;
    }
    if (r.kind === 'refused') {
      setReview(null);
      setNote({ tone: 'error', text: withdrawalWords(r.error) });
      // REFERRAL_PAYOUTS_DISABLED: the switch went off meanwhile; read it again (the form then says it is paused).
      await queryClient.invalidateQueries({ queryKey: [...scopeKey, 'referral-payouts-paused'] });
      await reread();
    }
  }

  async function giveUp(p: PendingOp<PendingSetOff>) {
    setGivingUp(true);
    try {
      const r = await perform(() => w.abandonSetOff(kind, ownerId, p.requestKey));
      if (r.state === 'used') { settle(p.requestKey); setReview(null); setText(''); setNote({ tone: 'ok', text: t('setoff.found', { amount: formatPaise(r.setoff.amountMinor) }) }); await reread(); return; }
      if (r.state !== 'abandoned') { setNote({ tone: 'warn', text: t('setoff.cannotGiveUp') }); return; }
      settle(p.requestKey); setReview(null);
      setNote({ tone: 'ok', text: t('setoff.givenUp') });
    } catch (err) {
      setNote({ tone: 'error', text: withdrawalWords(err) });
    } finally {
      setGivingUp(false);
    }
  }

  if (!op && (owedMinor <= 0 || paused.data === null)) return note ? <Alert tone={note.tone}>{note.text}</Alert> : null;
  const said = note && <Alert tone={note.tone}>{note.text}</Alert>;
  let body;
  if (op && !(busy && !givingUp && op.attempts === 1 && !op.uncertain)) {
    const restored = !!op.restored || !op.body;
    body = (
      <CheckPanel label={t('setoff.panel')}
        onCheck={async () => {
          const r = await w.setOffByKey(kind, ownerId, op.requestKey);
          if (r.state === 'used') { settle(op.requestKey); setReview(null); setText(''); setNote({ tone: 'ok', text: t('setoff.found', { amount: formatPaise(r.setoff.amountMinor) }) }); await reread(); return null; }
          if (r.state === 'abandoned') { settle(op.requestKey); setReview(null); setNote({ tone: 'ok', text: t('setoff.givenUp') }); return null; }
          return t('setoff.notYet');
        }}
        resend={restored ? undefined : { label: t('unconfirmed.resend'), busy: busy && !givingUp, onClick: () => { setNote(null); void pay(op).catch((e: unknown) => setNote({ tone: 'error', text: withdrawalWords(e) })); } }}
        giveUp={{ label: t('setoff.giveUp'), busy: givingUp, onClick: () => void giveUp(op) }}>
        <Alert tone="warn">{restored ? t('setoff.restored') : t('setoff.unconfirmed', { error: op.error ?? '' })}</Alert>
      </CheckPanel>
    );
  } else if (paused.data === undefined) {
    body = paused.isError ? <ErrorState message={messageOf(paused.error)} onRetry={() => void paused.refetch()} /> : <Loading />;
  } else if (paused.data) {
    body = <p>{t('setoff.paused')}</p>;
  } else if (review) {
    body = (
      <div className="confirm" role="group" aria-label={t('setoff.title')}>
        <p>{t('setoff.consequence', { amount: formatPaise(review.amountMinor), owed })}</p>
        <div className="confirm-actions">
          <Button busy={busy} onClick={() => { setNote(null); void pay(startOp(review.requestKey, { amountMinor: review.amountMinor })); }}>{t('setoff.confirm')}</Button>
          <Button variant="ghost" disabled={busy} onClick={() => setReview(null)}>{t('quote.back')}</Button>
        </div>
      </div>
    );
  } else {
    body = (
      <form className="ws-search" noValidate onSubmit={check}>
        <TextField label={t('setoff.amount')} inputMode="decimal" autoComplete="off" value={text} error={error}
          hint={t('setoff.amountHint', { owed })} onChange={(e) => setText(e.target.value)} />
        <Button type="submit" variant="secondary">{t('setoff.next')}</Button>
      </form>
    );
  }
  return (
    <section className="ws-section" aria-labelledby="setoff-h">
      <h2 id="setoff-h">{t('setoff.title')}</h2>
      {owedMinor > 0 && <p className="ws-muted">{t('setoff.intro', { owed })}</p>}
      {said}
      {body}
    </section>
  );
}
