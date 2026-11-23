import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  adminCardRefundsApi, adminWalletReadError, agreementProblem, isSwitchedOff, CARD_REFUND_CAUSE_LABEL, CARD_REFUND_STATE_LABEL, findMovedRefund, MAX_REFUND_AGREEMENT,
  moveRefundFinal, moveRefundRefusal, moveRefusedBeforeWriting, type CardRefund, type CardRefundMove,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, formatDateTime, formatRupees, Loading, TextArea } from '@jansetu/ui';
import { newRequestKey, startOp, type PendingOp } from '../../requests.ts';
import { useSession, useStaff } from '../../session.tsx';
import { useOneAtATime } from '../finance/finance.tsx';
import { CheckPanel, useOwnedOp } from '../pharmacy/ownedOp.tsx';
import { humanCode } from './RefundsScreen.tsx';

/**
 * WQ16 (backend r10 phase 1b, design §23.3 "Admin"): card refunds of assisted bookings that need a person
 * (`GET /admin/assisted/card-refunds`: failed, held for a check, and card refunds still pending after 20 attempts or a day),
 * and "Move to wallet": a failed or held card refund credited to the pharmacy's wallet instead, only with the pharmacy's
 * recorded agreement (`POST /admin/assisted/card-refunds/:id/to-wallet {agreement}`). The move is once per refund whatever is
 * sent, so a lost answer is sent again with the same body; "Check" looks for the refund among the processed ones.
 * The rows do not name the pharmacy (r10 `cardRefundView` has no `payerId`; a backend follow-up), nor does the admin booking page yet.
 */
const MOVE_EXPLAIN = 'Only when the card refund cannot go through and the pharmacy agreed to take the money in its Jansetu wallet instead. The money is added to its wallet at once (it cannot be withdrawn), and the card refund is closed.';
const refundWords = (r: CardRefund) => `${formatRupees(r.amountMinor / 100)} card refund of ${formatDateTime(r.createdAt)}`;
const movable = (r: CardRefund) => (r.state === 'failed' || r.state === 'manual_review') && r.lastError !== 'CHARGEBACK_RECORDED';

interface PendingMove { row: CardRefund; agreement: string }

export function CardRefundsQueue({ scopeKey }: { scopeKey: readonly string[] }) {
  const { api } = useSession();
  const admin = useStaff();
  const queryClient = useQueryClient();
  const refunds = adminCardRefundsApi(api);
  const list = useQuery({ queryKey: [...scopeKey, 'card-refunds'], queryFn: () => refunds.queue() });
  const { op, send, settle } = useOwnedOp<PendingMove>(`admin-card-refund-move:${admin.id}`);
  const { perform, busy } = useOneAtATime('refund');
  const [chosen, setChosen] = useState<CardRefund | null>(null);
  const [agreement, setAgreement] = useState('');
  const [agreementError, setAgreementError] = useState<string | undefined>();
  const [review, setReview] = useState<({ requestKey: string } & PendingMove) | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);
  const reread = () => queryClient.invalidateQueries({ queryKey: [...scopeKey, 'card-refunds'] });

  const moved = (m: CardRefundMove | { refund: CardRefund; replayed: boolean }, how: 'sent' | 'resent' | 'checked') => {
    setChosen(null);
    setReview(null);
    setAgreement('');
    const what = refundWords(m.refund);
    setDone(how === 'checked' ? `It was moved: the ${what} is in the pharmacy’s Jansetu wallet.`
      : m.replayed ? `This refund was already moved to the pharmacy’s wallet: the ${what}. Nothing more was changed.`
      : `Moved to the pharmacy’s wallet: the ${what}.${how === 'resent' ? ' It was moved once, even though it was sent more than once.' : ''}`);
    void reread();
  };
  const refuse = (err: unknown) => { setChosen(null); setReview(null); setRefused(moveRefundRefusal(err)); void reread(); };

  function start(row: CardRefund) {
    setDone(null); setRefused(null); setReview(null); setAgreement(''); setAgreementError(undefined); setChosen(row);
  }

  function check(e: FormEvent) {
    e.preventDefault();
    if (!chosen) return;
    const problem = agreementProblem(agreement);
    setAgreementError(problem);
    if (problem) return;
    setReview({ requestKey: newRequestKey(), row: chosen, agreement: agreement.trim().replace(/\s+/g, ' ') });
  }

  async function sendMove(p: PendingOp<PendingMove>) {
    const sole = p.attempts === 0 && !p.uncertain;
    const r = await perform(() => send(p, (b) => refunds.toWallet(b.row.refundId, b.agreement)));
    if (r.kind === 'stale') return;
    if (r.kind === 'ok') { moved(r.value, p.attempts > 0 ? 'resent' : 'sent'); return; }
    if (r.kind === 'unknown' && ((sole && moveRefusedBeforeWriting(r.error)) || moveRefundFinal(r.error))) { settle(p.requestKey); refuse(r.error); return; }
    if (r.kind === 'refused') { refuse(r.error); return; }
    void reread();
  }

  if (op && !(busy && op.attempts === 1 && !op.uncertain)) {
    const restored = !!op.restored || !op.body;
    return (
      <>
        <p>{MOVE_EXPLAIN}</p>
        {resendError && <Alert>{resendError}</Alert>}
        <CheckPanel label="Unconfirmed move to wallet"
          onCheck={async () => {
            if (restored) return 'Its details are not kept on this device after a reload. Read the list again: a refund moved to the wallet leaves it.';
            const found = await findMovedRefund(api, op.body.row.refundId);
            void reread();
            if (found) { settle(op.requestKey); moved({ refund: found, replayed: false }, 'checked'); return null; }
            return 'Not moved so far. It may still be on its way. Sending the same request again is safe: it is moved only once.';
          }}
          resend={restored ? undefined : {
            label: 'Send the same request again', busy,
            onClick: () => { setResendError(null); void sendMove(op).catch((err: unknown) => setResendError(moveRefundRefusal(err))); },
          }}
          forget={{ label: 'Forget it', confirmLabel: 'Yes, forget it', onForget: () => settle(op.requestKey),
            consequence: 'The refund may already be moved, or may still be. Forgetting it does not undo that. Read the list again before moving it again: a refund is never moved twice.' }}>
          <Alert tone="warn">
            {restored
              ? 'A refund moved to a wallet earlier on this device (before the page was reloaded) was not confirmed. Its details are not kept here.'
              : `The outcome of this request is not known yet${op.error ? ` (${op.error})` : ''}. The ${refundWords(op.body.row)} may already be in the pharmacy’s wallet. Sending the same request again is safe: it is moved only once.`}
          </Alert>
        </CheckPanel>
      </>
    );
  }

  const rows = list.data ?? [];
  return (
    <>
      <p className="ws-muted">Card and UPI refunds of consultations booked by pharmacies that did not go through on their own. A pending one is listed after 20 tries or a day.</p>
      {done && <Alert tone="ok">{done}</Alert>}
      {refused && <Alert>Not moved: {refused}</Alert>}
      {list.isPending ? <Loading label="Loading card refunds…" />
        : list.isError ? (isSwitchedOff(list.error) ? <p className="ws-muted">Card refunds of bookings are not available on this server yet.</p>
          : <ErrorState message={adminWalletReadError(list.error)} onRetry={() => void list.refetch()} />)
        : rows.length === 0 ? <Empty title="No card refunds need a person">Card refunds that fail or get stuck are listed here.</Empty>
        : (
          <div className="ws-table-wrap">
            <table className="j-table">
              <caption className="j-sr-only">Card refunds that need a person, oldest change first</caption>
              <thead><tr><th scope="col">When</th><th scope="col">Amount</th><th scope="col">Why</th><th scope="col">State</th><th scope="col">Booking</th><th scope="col"><span className="j-sr-only">Action</span></th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.refundId}>
                    <td>{formatDateTime(r.createdAt)}</td>
                    <td>{formatRupees(r.amountMinor / 100)}</td>
                    <td>{CARD_REFUND_CAUSE_LABEL[r.cause] ?? humanCode(r.cause)}</td>
                    <td>
                      <Badge tone={r.state === 'pending' ? undefined : 'warn'}>{CARD_REFUND_STATE_LABEL[r.state] ?? humanCode(r.state)}</Badge>
                      {r.lastError === 'CHARGEBACK_RECORDED' ? <div className="ws-muted">A card dispute was recorded: never refunded</div>
                        : r.lastError ? <div className="ws-muted">{humanCode(r.lastError)}</div> : null}
                      <div className="ws-muted">{r.attempts} {r.attempts === 1 ? 'try' : 'tries'}</div>
                    </td>
                    <td><Link to={`/admin/consultations/${r.bookingId}`}>Open the booking</Link></td>
                    <td>
                      {movable(r) && (
                        <Button variant="secondary" disabled={busy || (!!review && chosen?.refundId !== r.refundId)}
                          aria-label={`Move the ${refundWords(r)} to the pharmacy’s wallet`} onClick={() => start(r)}>Move to wallet</Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      {chosen && (
        <form className="rx-form" noValidate onSubmit={check} aria-label="Move to wallet">
          <p>The <strong>{refundWords(chosen)}</strong>. {MOVE_EXPLAIN}</p>
          <fieldset className="ws-frozen" disabled={!!review || busy}>
            <TextArea label="The pharmacy’s agreement" value={agreement} maxLength={MAX_REFUND_AGREEMENT} error={agreementError}
              hint="Required. Who at the pharmacy agreed, how and when. Kept with the refund." onChange={(e) => setAgreement(e.target.value)} />
          </fieldset>
          {!review ? (
            <div className="confirm-actions">
              <Button type="submit">Next: check before moving</Button>
              <Button variant="ghost" onClick={() => setChosen(null)}>Cancel</Button>
            </div>
          ) : (
            <div className="confirm" role="group" aria-label="Move this refund to the wallet">
              <div className="confirm-text">Move the <strong>{refundWords(review.row)}</strong> to the pharmacy’s Jansetu wallet?</div>
              <ul className="ws-list">
                <li>Agreement: <strong>{review.agreement}</strong></li>
                <li>{MOVE_EXPLAIN}</li>
              </ul>
              <div className="confirm-actions">
                <Button busy={busy} onClick={() => {
                  const { requestKey, ...pending } = review;
                  void sendMove(startOp(requestKey, pending)).catch((err: unknown) => refuse(err));
                }}>Yes, move to wallet</Button>
                <Button variant="ghost" disabled={busy} onClick={() => setReview(null)}>Back</Button>
              </div>
            </div>
          )}
        </form>
      )}
    </>
  );
}
