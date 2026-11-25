import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  adminCardRefundsApi, adminWalletReadError, agreementProblem, isSwitchedOff, cardRefundCauseLabel, CARD_REFUND_STATE_LABEL, findMarkedFailed, findMovedRefund,
  markFailedFinal, markFailedRefusal, markFailedRefusedBeforeWriting, MAX_REFUND_AGREEMENT, moveRefundFinal, moveRefundRefusal, moveRefusedBeforeWriting,
  payerNameOf, payerWord, recheckRefusal, recheckWords, type AdminCardRefund, type CardRefund, type CardRefundPayerKind,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, formatDateTime, formatRupees, Loading, TextArea } from '@jansetu/ui';
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
const refundWords = (r: CardRefund) => `${formatRupees(r.amountMinor / 100)} card refund of ${formatDateTime(r.createdAt)}`;
const payerOf = (r: AdminCardRefund) => payerNameOf(r) ?? `the ${payerWord(r.payerKind)}`;
const movable = (r: CardRefund) => (r.state === 'failed' || r.state === 'manual_review') && r.lastError !== 'CHARGEBACK_RECORDED';
const markable = (r: CardRefund) => r.state === 'pending' && r.method === 'card';

type Action = 'move' | 'mark';
interface PendingAction { action: Action; row: AdminCardRefund; text: string }
/** The words of each change, for the row's payer (`w`: "pharmacy", "lab" or "doctor"). */
const wordsFor = (action: Action, w: CardRefundPayerKind) => (action === 'move' ? {
  button: 'Move to wallet', field: `The ${w}’s agreement`, hint: `Required. Who at the ${w} agreed, how and when. Kept with the refund.`,
  next: 'Next: check before moving', confirm: 'Yes, move to wallet', label: 'Unconfirmed move to wallet',
  explain: `Only when the card refund cannot go through and the ${w} agreed to take the money in its Jansetu wallet instead. The money is added to its wallet at once (it cannot be withdrawn), and the card refund is closed.`,
} : {
  button: 'Mark failed', field: 'Why is it marked failed?', hint: 'Required. For example what Razorpay support said. Kept with the refund.',
  next: 'Next: check before marking', confirm: 'Yes, mark failed', label: 'Unconfirmed mark failed',
  explain: `Only when Razorpay cannot complete this card refund. Jansetu reads Razorpay first and refuses while it holds a refund of this payment. Afterwards the refund can be moved to the ${w}’s wallet, with its agreement.`,
});
const WORDS = (action: Action, row: AdminCardRefund) => wordsFor(action, payerWord(row.payerKind));

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
    const what = `the ${refundWords(p.row)} of ${payerOf(p.row)}`;
    const w = payerWord(p.row.payerKind);
    if (p.action === 'mark') {
      setDone(how === 'checked' ? `It was marked failed: ${what}. It can now be moved to the ${w}’s wallet.`
        : `Marked failed: ${what}. It can now be moved to the ${w}’s wallet, with its agreement.`);
    } else {
      setDone(how === 'checked' ? `It was moved: ${what} is in the ${w}’s Jansetu wallet.`
        : replayed ? `This refund was already moved to the ${w}’s wallet: ${what}. Nothing more was changed.`
        : `Moved to the ${w}’s wallet: ${what}.${how === 'resent' ? ' It was moved once, even though it was sent more than once.' : ''}`);
    }
    void reread();
  };
  const refuse = (action: Action, err: unknown) => { setChosen(null); setReview(null); setRefused(`Not done: ${refusalOf(action, err)}`); void reread(); };

  function start(action: Action, row: AdminCardRefund) {
    setDone(null); setRefused(null); setReview(null); setText(''); setTextError(undefined); setChosen({ action, row });
  }

  function check(e: FormEvent) {
    e.preventDefault();
    if (!chosen) return;
    const problem = chosen.action === 'move' ? agreementProblem(text, payerWord(chosen.row.payerKind))
      : !text.trim() ? 'Write why it is marked failed.' : text.trim().length > MAX_REFUND_AGREEMENT ? `Use at most ${MAX_REFUND_AGREEMENT} characters.` : undefined;
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
      setDone(`${refundWords(row)} of ${payerOf(row)}. ${recheckWords(r)}`);
    } catch (err) {
      setRefused(recheckRefusal(err));
    } finally {
      setRechecking(null);
      void reread();
    }
  }

  if (op && !(busy && op.attempts === 1 && !op.uncertain)) {
    const restored = !!op.restored || !op.body;
    const w = restored ? null : WORDS(op.body.action, op.body.row);
    return (
      <>
        {w && <p>{w.explain}</p>}
        {resendError && <Alert>{resendError}</Alert>}
        <CheckPanel label={w ? w.label : 'Unconfirmed refund change'}
          onCheck={async () => {
            if (restored) return 'Its details are not kept on this device after a reload. Read the list again to see where the refund is.';
            // The row is read by id (r10e `GET …/card-refunds/:id`); never the 200-row list, never recheck (it can send the
            // refund). A server without the route fails the check: the outcome stays unknown.
            const found = op.body.action === 'move' ? await findMovedRefund(api, op.body.row.refundId) : await findMarkedFailed(api, op.body.row.refundId);
            void reread();
            if (found) { settle(op.requestKey); finished(op.body, 'checked'); return null; }
            return 'Not done so far. It may still be on its way. Sending the same request again is safe: it is done only once.';
          }}
          resend={restored ? undefined : {
            label: 'Send the same request again', busy,
            onClick: () => { setResendError(null); void sendAction(op).catch((err: unknown) => setResendError(refusalOf(op.body.action, err))); },
          }}
          forget={{ label: 'Forget it', confirmLabel: 'Yes, forget it', onForget: () => { settle(op.requestKey); setReview(null); setChosen(null); setText(''); },
            consequence: 'The change may already be done, or may still be. Forgetting it does not undo that. Read the list again before doing it again: a refund is never moved twice.' }}>
          <Alert tone="warn">
            {restored
              ? 'A change to a card refund made earlier on this device (before the page was reloaded) was not confirmed. Its details are not kept here.'
              : `The outcome of this request is not known yet${op.error ? ` (${op.error})` : ''}. The ${refundWords(op.body.row)} of ${payerOf(op.body.row)} may already be ${op.body.action === 'move' ? 'in its wallet' : 'marked failed'}. Sending the same request again is safe.`}
          </Alert>
        </CheckPanel>
      </>
    );
  }

  const rows = list.data ?? [];
  return (
    <>
      <p className="ws-muted">Card and UPI refunds of bookings made for patients (by a pharmacy, a lab or a doctor) that did not go through on their own. One still in progress is listed after 20 failures or a day.</p>
      {done && <Alert tone="ok">{done}</Alert>}
      {refused && <Alert>{refused}</Alert>}
      {list.isPending ? <Loading label="Loading card refunds…" />
        : list.isError ? (isSwitchedOff(list.error) ? <p className="ws-muted">Card refunds of bookings are not available on this server yet.</p>
          : <ErrorState message={adminWalletReadError(list.error)} onRetry={() => void list.refetch()} />)
        : rows.length === 0 ? <Empty title="No card refunds need a person">Card refunds that fail or get stuck are listed here.</Empty>
        : (
          <div className="ws-table-wrap">
            <table className="j-table">
              <caption className="j-sr-only">Card refunds that need a person, oldest change first</caption>
              <thead><tr><th scope="col">When</th><th scope="col">Paid by</th><th scope="col">Amount</th><th scope="col">Why</th><th scope="col">State</th><th scope="col">Booking</th><th scope="col"><span className="j-sr-only">Actions</span></th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.refundId}>
                    <td>{formatDateTime(r.createdAt)}</td>
                    <td>{payerNameOf(r) ?? '—'}</td>
                    <td>{formatRupees(r.amountMinor / 100)}</td>
                    <td>{cardRefundCauseLabel(r.cause, r.payerKind) ?? humanCode(r.cause)}</td>
                    <td>
                      <Badge tone={r.state === 'pending' ? undefined : 'warn'}>{CARD_REFUND_STATE_LABEL[r.state] ?? humanCode(r.state)}</Badge>
                      {r.lastError === 'CHARGEBACK_RECORDED' ? <div className="ws-muted">A card dispute was recorded: never refunded</div>
                        : r.lastError ? <div className="ws-muted">{humanCode(r.lastError)}</div> : null}
                      <div className="ws-muted">{r.attempts} {r.attempts === 1 ? 'failure' : 'failures'}</div>
                    </td>
                    <td><Link to={`/admin/consultations/${r.bookingId}`}>Open the booking</Link></td>
                    <td>
                      <div className="ws-actions">
                        {r.state !== 'processed' && (
                          <Button variant="ghost" busy={rechecking === r.refundId} disabled={busy && rechecking !== r.refundId}
                            aria-label={`Recheck the ${refundWords(r)} with Razorpay`} onClick={() => void recheck(r)}>Recheck</Button>
                        )}
                        {markable(r) && (
                          <Button variant="secondary" disabled={busy || (!!review && chosen?.row.refundId !== r.refundId)}
                            aria-label={`Mark the ${refundWords(r)} failed`} onClick={() => start('mark', r)}>Mark failed</Button>
                        )}
                        {movable(r) && (
                          <Button variant="secondary" disabled={busy || (!!review && chosen?.row.refundId !== r.refundId)}
                            aria-label={`Move the ${refundWords(r)} to the ${payerWord(r.payerKind)}’s wallet`} onClick={() => start('move', r)}>Move to wallet</Button>
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
        <form className="rx-form" noValidate onSubmit={check} aria-label={WORDS(chosen.action, chosen.row).button}>
          <p>The <strong>{refundWords(chosen.row)}</strong> of <strong>{payerOf(chosen.row)}</strong>. {WORDS(chosen.action, chosen.row).explain}</p>
          <fieldset className="ws-frozen" disabled={!!review || busy}>
            <TextArea label={WORDS(chosen.action, chosen.row).field} value={text} maxLength={MAX_REFUND_AGREEMENT} error={textError}
              hint={WORDS(chosen.action, chosen.row).hint} onChange={(e) => setText(e.target.value)} />
          </fieldset>
          {!review ? (
            <div className="confirm-actions">
              <Button type="submit">{WORDS(chosen.action, chosen.row).next}</Button>
              <Button variant="ghost" onClick={() => setChosen(null)}>Cancel</Button>
            </div>
          ) : (
            <div className="confirm" role="group" aria-label={review.action === 'move' ? 'Move this refund to the wallet' : 'Mark this refund failed'}>
              <div className="confirm-text">
                {review.action === 'move'
                  ? <>Move the <strong>{refundWords(review.row)}</strong> to the Jansetu wallet of <strong>{payerOf(review.row)}</strong>?</>
                  : <>Mark the <strong>{refundWords(review.row)}</strong> of <strong>{payerOf(review.row)}</strong> failed?</>}
              </div>
              <ul className="ws-list">
                <li>{review.action === 'move' ? 'Agreement' : 'Reason'}: <strong>{review.text}</strong></li>
                <li>{WORDS(review.action, review.row).explain}</li>
              </ul>
              <div className="confirm-actions">
                <Button busy={busy} onClick={() => {
                  const { requestKey, ...pending } = review;
                  void sendAction(startOp(requestKey, pending)).catch((err: unknown) => refuse(pending.action, err));
                }}>{WORDS(review.action, review.row).confirm}</Button>
                <Button variant="ghost" disabled={busy} onClick={() => setReview(null)}>Back</Button>
              </div>
            </div>
          )}
        </form>
      )}
    </>
  );
}
