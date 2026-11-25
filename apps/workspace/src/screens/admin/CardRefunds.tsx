import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  adminCardRefundsApi, adminWalletReadError, agreementProblem, isSwitchedOff, cardRefundCauseLabel, CARD_REFUND_STATE_LABEL, findMarkedFailed, findMovedRefund,
  markFailedFinal, markFailedRefusal, markFailedRefusedBeforeWriting, MAX_REFUND_AGREEMENT, moveRefundFinal, moveRefundRefusal, moveRefusedBeforeWriting,
  payerLabel, payerNameOf, payerWord, recheckRefusal, recheckWords, type AdminCardRefund, type CardRefund,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, formatDateTime, formatRupees, Loading, TextArea } from '@jansetu/ui';
import { t } from '../../i18n/admin/index.ts';
import { newRequestKey, startOp, type PendingOp } from '../../requests.ts';
import { useSession, useStaff } from '../../session.tsx';
import { useOneAtATime } from '../finance/finance.tsx';
import { CheckPanel, useOwnedOp } from '../pharmacy/ownedOp.tsx';
import { humanCode } from './RefundsScreen.tsx';

/**
 * WQ16 (backend r10 phase 1b, design §23.3 "Admin"): card refunds of assisted bookings that need a person
 * (`GET /admin/assisted/card-refunds`: failed, held for a check, and card refunds still pending after 20 failures or a day),
 * and "Move to wallet": a failed or held card refund credited to the pharmacy's wallet instead, only with the pharmacy's
 * recorded agreement (`POST /admin/assisted/card-refunds/:id/to-wallet {agreement}`). The move is once per refund whatever is
 * sent, so a lost answer is sent again with the same body; "Check" looks for the refund among the processed ones.
 * WQ16b (r10b/r10c, §23.6): each row names its pharmacy; "Recheck" asks Razorpay now (`POST …/:id/recheck`, no money moves);
 * "Mark failed" a pending card refund with a reason (`POST …/:id/mark-failed {reason}`: refused while Razorpay holds a live
 * refund), after which it can be moved to the wallet. Both changes are owned requests with a confirm step.
 * WQ24b (r21): a row is paid by a pharmacy, a lab or a doctor (`payerKind`, `payerName`; an older answer is a pharmacy's,
 * named by `pharmacyName`): the words and the wallet named are the payer's.
 */
const refundWords = (r: CardRefund) => t('cardRefunds.refund', { amount: formatRupees(r.amountMinor / 100), date: formatDateTime(r.createdAt) });
/** Who paid for the row's booking, in words: "pharmacy", "lab" or "doctor" (WQ24b). */
const payerOf = (r: AdminCardRefund) => payerLabel(r.payerKind);
const nameOf = (r: AdminCardRefund) => payerNameOf(r) ?? t('cardRefunds.thePayer', { payer: payerOf(r) });
/** The first sentence of an unconfirmed request's notice (shared with the wallet pages). */
export const notKnownYet = (error?: string | null) => (error ? t('adminWallet.unknownWith', { error }) : t('adminWallet.unknown'));
const movable = (r: CardRefund) => (r.state === 'failed' || r.state === 'manual_review') && r.lastError !== 'CHARGEBACK_RECORDED';
const markable = (r: CardRefund) => r.state === 'pending' && r.method === 'card';

type Action = 'move' | 'mark';
interface PendingAction { action: Action; row: AdminCardRefund; text: string }
/** Each action's words (catalogue keys, worded at render). */
const WORDS = {
  move: { button: 'cardRefunds.move.button', field: 'cardRefunds.move.field', fieldHint: 'cardRefunds.move.hint', next: 'cardRefunds.move.next',
    confirm: 'cardRefunds.move.confirm', explain: 'cardRefunds.move.explain', unconfirmed: 'cardRefunds.move.unconfirmed' },
  mark: { button: 'cardRefunds.mark.button', field: 'cardRefunds.mark.field', fieldHint: 'cardRefunds.mark.hint', next: 'cardRefunds.mark.next',
    confirm: 'cardRefunds.mark.confirm', explain: 'cardRefunds.mark.explain', unconfirmed: 'cardRefunds.mark.unconfirmed' },
} as const satisfies Record<Action, Record<string, Parameters<typeof t>[0]>>;

export function CardRefundsQueue({ scopeKey }: { scopeKey: readonly string[] }) {
  const { api } = useSession();
  const admin = useStaff();
  const queryClient = useQueryClient();
  const refunds = adminCardRefundsApi(api);
  const list = useQuery({ queryKey: [...scopeKey, 'card-refunds'], queryFn: () => refunds.queue() });
  const { op, send, settle } = useOwnedOp<PendingAction>(`admin-card-refund-change:${admin.id}`);
  const { perform, busy } = useOneAtATime('refund');
  const [chosen, setChosen] = useState<{ action: Action; row: AdminCardRefund } | null>(null);
  const [text, setText] = useState('');
  const [textError, setTextError] = useState<string | undefined>();
  const [review, setReview] = useState<({ requestKey: string } & PendingAction) | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);
  const [rechecking, setRechecking] = useState<string | null>(null);
  const reread = () => queryClient.invalidateQueries({ queryKey: [...scopeKey, 'card-refunds'] });
  const refusalOf = (action: Action, err: unknown) => (action === 'move' ? moveRefundRefusal(err) : markFailedRefusal(err));

  const finished = (p: PendingAction, how: 'sent' | 'resent' | 'checked', replayed = false) => {
    setChosen(null);
    setReview(null);
    setText('');
    const what = { refund: refundWords(p.row), name: nameOf(p.row), payer: payerOf(p.row) };
    if (p.action === 'mark') {
      setDone(how === 'checked' ? t('cardRefunds.done.markedChecked', what) : t('cardRefunds.done.marked', what));
    } else {
      setDone(how === 'checked' ? t('cardRefunds.done.movedChecked', what)
        : replayed ? t('cardRefunds.done.alreadyMoved', what)
        : `${t('cardRefunds.done.moved', what)}${how === 'resent' ? ` ${t('cardRefunds.done.movedOnce')}` : ''}`);
    }
    void reread();
  };
  const refuse = (action: Action, err: unknown) => { setChosen(null); setReview(null); setRefused(t('cardRefunds.notDone', { reason: refusalOf(action, err) })); void reread(); };

  function start(action: Action, row: AdminCardRefund) {
    setDone(null); setRefused(null); setReview(null); setText(''); setTextError(undefined); setChosen({ action, row });
  }

  function check(e: FormEvent) {
    e.preventDefault();
    if (!chosen) return;
    const problem = chosen.action === 'move' ? agreementProblem(text, payerWord(chosen.row.payerKind))
      : !text.trim() ? t('cardRefunds.writeWhy') : text.trim().length > MAX_REFUND_AGREEMENT ? t('cardRefunds.atMost', { max: MAX_REFUND_AGREEMENT }) : undefined;
    setTextError(problem);
    if (problem) return;
    setReview({ requestKey: newRequestKey(), ...chosen, text: text.trim().replace(/\s+/g, ' ') });
  }

  async function sendAction(p: PendingOp<PendingAction>) {
    const sole = p.attempts === 0 && !p.uncertain;
    const { action } = p.body;
    const r = await perform(() => send(p, async (b): Promise<{ replayed: boolean }> => (b.action === 'move'
      ? refunds.toWallet(b.row.refundId, b.text) : { ...(await refunds.markFailed(b.row.refundId, b.text)), replayed: false })));
    if (r.kind === 'stale') return;
    if (r.kind === 'ok') { finished(p.body, p.attempts > 0 ? 'resent' : 'sent', r.value.replayed); return; }
    const final = action === 'move' ? (sole && moveRefusedBeforeWriting(r.error)) || moveRefundFinal(r.error)
      : (sole && markFailedRefusedBeforeWriting(r.error)) || markFailedFinal(r.error);
    if (r.kind === 'unknown' && final) { settle(p.requestKey); refuse(action, r.error); return; }
    if (r.kind === 'refused') { refuse(action, r.error); return; }
    void reread();
  }

  /** Asks Razorpay now about one refund (no wallet money moves; a pending row may be sent or settled). */
  async function recheck(row: AdminCardRefund) {
    setDone(null); setRefused(null); setRechecking(row.refundId);
    try {
      const r = await perform(() => refunds.recheck(row.refundId));
      setDone(`${t('cardRefunds.recheckedOf', { refund: refundWords(row), name: nameOf(row) })} ${recheckWords(r)}`);
    } catch (err) {
      setRefused(recheckRefusal(err));
    } finally {
      setRechecking(null);
      void reread();
    }
  }

  if (op && !(busy && op.attempts === 1 && !op.uncertain)) {
    const restored = !!op.restored || !op.body;
    const w = WORDS[restored ? 'move' : op.body.action];
    return (
      <>
        {!restored && <p>{t(w.explain, { payer: payerOf(op.body.row) })}</p>}
        {resendError && <Alert>{resendError}</Alert>}
        <CheckPanel label={restored ? t('cardRefunds.unconfirmed') : t(w.unconfirmed)}
          onCheck={async () => {
            if (restored) return t('cardRefunds.check.restored');
            // The row is read by id (r10e `GET …/card-refunds/:id`); never the 200-row list, never recheck (it can send the
            // refund). A server without the route fails the check: the outcome stays unknown.
            const found = op.body.action === 'move' ? await findMovedRefund(api, op.body.row.refundId) : await findMarkedFailed(api, op.body.row.refundId);
            void reread();
            if (found) { settle(op.requestKey); finished(op.body, 'checked'); return null; }
            return t('cardRefunds.check.notYet');
          }}
          resend={restored ? undefined : {
            label: t('adminWallet.sendAgain'), busy,
            onClick: () => { setResendError(null); void sendAction(op).catch((err: unknown) => setResendError(refusalOf(op.body.action, err))); },
          }}
          forget={{ label: t('adminWallet.forget'), confirmLabel: t('adminWallet.forgetConfirm'), onForget: () => { settle(op.requestKey); setReview(null); setChosen(null); setText(''); },
            consequence: t('cardRefunds.forget') }}>
          <Alert tone="warn">
            {restored
              ? t('cardRefunds.restored')
              : `${notKnownYet(op.error)} ${t(op.body.action === 'move' ? 'cardRefunds.mayBe.move' : 'cardRefunds.mayBe.mark', { refund: refundWords(op.body.row), name: nameOf(op.body.row) })}`}
          </Alert>
        </CheckPanel>
      </>
    );
  }

  const rows = list.data ?? [];
  return (
    <>
      <p className="ws-muted">{t('cardRefunds.intro')}</p>
      {done && <Alert tone="ok">{done}</Alert>}
      {refused && <Alert>{refused}</Alert>}
      {list.isPending ? <Loading label={t('cardRefunds.loading')} />
        : list.isError ? (isSwitchedOff(list.error) ? <p className="ws-muted">{t('cardRefunds.unavailable')}</p>
          : <ErrorState message={adminWalletReadError(list.error)} onRetry={() => void list.refetch()} />)
        : rows.length === 0 ? <Empty title={t('cardRefunds.empty')}>{t('cardRefunds.emptyText')}</Empty>
        : (
          <div className="ws-table-wrap">
            <table className="j-table">
              <caption className="j-sr-only">{t('cardRefunds.caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('adminWallet.col.when')}</th><th scope="col">{t('cardRefunds.col.paidBy')}</th><th scope="col">{t('common.amount')}</th>
                  <th scope="col">{t('cardRefunds.col.why')}</th><th scope="col">{t('adminWallet.col.state')}</th><th scope="col">{t('cardRefunds.col.booking')}</th>
                  <th scope="col"><span className="j-sr-only">{t('common.actions')}</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.refundId}>
                    <td>{formatDateTime(r.createdAt)}</td>
                    <td>{payerNameOf(r) ?? '—'}</td>
                    <td>{formatRupees(r.amountMinor / 100)}</td>
                    <td>{cardRefundCauseLabel(r.cause, r.payerKind) ?? humanCode(r.cause)}</td>
                    <td>
                      <Badge tone={r.state === 'pending' ? undefined : 'warn'}>{CARD_REFUND_STATE_LABEL[r.state] ?? humanCode(r.state)}</Badge>
                      {r.lastError === 'CHARGEBACK_RECORDED' ? <div className="ws-muted">{t('cardRefunds.chargeback')}</div>
                        : r.lastError ? <div className="ws-muted">{humanCode(r.lastError)}</div> : null}
                      <div className="ws-muted">{t('cardRefunds.failures', { count: r.attempts })}</div>
                    </td>
                    <td><Link to={`/admin/consultations/${r.bookingId}`}>{t('cardRefunds.openBooking')}</Link></td>
                    <td>
                      <div className="ws-actions">
                        {r.state !== 'processed' && (
                          <Button variant="ghost" busy={rechecking === r.refundId} disabled={busy && rechecking !== r.refundId}
                            aria-label={t('cardRefunds.recheckAria', { refund: refundWords(r) })} onClick={() => void recheck(r)}>{t('cardRefunds.recheck')}</Button>
                        )}
                        {markable(r) && (
                          <Button variant="secondary" disabled={busy || (!!review && chosen?.row.refundId !== r.refundId)}
                            aria-label={t('cardRefunds.markAria', { refund: refundWords(r) })} onClick={() => start('mark', r)}>{t('cardRefunds.mark.button')}</Button>
                        )}
                        {movable(r) && (
                          <Button variant="secondary" disabled={busy || (!!review && chosen?.row.refundId !== r.refundId)}
                            aria-label={t('cardRefunds.moveAria', { refund: refundWords(r), payer: payerOf(r) })} onClick={() => start('move', r)}>{t('cardRefunds.move.button')}</Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      {chosen && (
        <form className="rx-form" noValidate onSubmit={check} aria-label={t(WORDS[chosen.action].button)}>
          <p>
            {t.rich('cardRefunds.chosen', { refund: <strong key="r">{refundWords(chosen.row)}</strong>, name: <strong key="p">{nameOf(chosen.row)}</strong> })}
            {' '}{t(WORDS[chosen.action].explain, { payer: payerOf(chosen.row) })}
          </p>
          <fieldset className="ws-frozen" disabled={!!review || busy}>
            <TextArea label={t(WORDS[chosen.action].field, { payer: payerOf(chosen.row) })} value={text} maxLength={MAX_REFUND_AGREEMENT} error={textError}
              hint={t(WORDS[chosen.action].fieldHint, { payer: payerOf(chosen.row) })} onChange={(e) => setText(e.target.value)} />
          </fieldset>
          {!review ? (
            <div className="confirm-actions">
              <Button type="submit">{t(WORDS[chosen.action].next)}</Button>
              <Button variant="ghost" onClick={() => setChosen(null)}>{t('adminWallet.cancel')}</Button>
            </div>
          ) : (
            <div className="confirm" role="group" aria-label={t(review.action === 'move' ? 'cardRefunds.review.move' : 'cardRefunds.review.mark')}>
              <div className="confirm-text">
                {t.rich(review.action === 'move' ? 'cardRefunds.question.move' : 'cardRefunds.question.mark', {
                  refund: <strong key="r">{refundWords(review.row)}</strong>, name: <strong key="p">{nameOf(review.row)}</strong>,
                })}
              </div>
              <ul className="ws-list">
                <li>
                  {review.action === 'move' ? t.rich('cardRefunds.agreementIs', { text: <strong key="t">{review.text}</strong> })
                    : t.rich('adminWallet.reasonIs', { reason: <strong key="t">{review.text}</strong> })}
                </li>
                <li>{t(WORDS[review.action].explain, { payer: payerOf(review.row) })}</li>
              </ul>
              <div className="confirm-actions">
                <Button busy={busy} onClick={() => {
                  const { requestKey, ...pending } = review;
                  void sendAction(startOp(requestKey, pending)).catch((err: unknown) => refuse(pending.action, err));
                }}>{t(WORDS[review.action].confirm)}</Button>
                <Button variant="ghost" disabled={busy} onClick={() => setReview(null)}>{t('adminWallet.back')}</Button>
              </div>
            </div>
          )}
        </form>
      )}
    </>
  );
}
