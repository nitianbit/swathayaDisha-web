import { useState, type ReactNode } from 'react';
import { cancelWords, LATE_PAYMENT_BACK, MAX_BOOKER_CANCEL_REASON, type CancelAnswer, type RefundTo } from '@jansetu/api';
import { Alert } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { newRequestKey, startOp, type PendingOp } from '../../requests.ts';
import type { Perform } from '../finance/finance.tsx';
import { CheckPanel, useOwnedOp } from './ownedOp.tsx';
import { t } from '../../i18n/pharmacy/index.ts';

/**
 * WQ17: the booker's cancel of an assisted booking (WQ12, moved here from Booked consultations so that a booked lab test
 * cancels the very same way): a reason (optional) and a confirm step, one owned request, and when its outcome is unknown
 * the check (the booking read again), the same request again (safe: a cancelled booking answers `alreadyCancelled`), or
 * forget. The booking-specific words and request come from the caller.
 */
export function OwnedCancel<B, R, V extends object>({ slot, label, intro, extra, consequence, version, perform, busy, makeBody, send, doneWords, refusalWords, onChanged,
  isCancelled, checkedWords, forgetConsequence, onDone }: {
  /** The memory slot of this booking's cancel (per pharmacy and booking). */
  slot: string;
  /** The button, e.g. "Cancel this consultation". */
  label: string;
  intro: ReactNode;
  /** Shown above the button (a choice that goes into the request). */
  extra?: ReactNode;
  consequence: string;
  /** The booking's version the confirmation is opened on. */
  version?: string | number;
  perform: Perform;
  busy: boolean;
  makeBody: (reason: string) => B;
  send: (body: B) => Promise<R>;
  doneWords: (answer: R) => string;
  refusalWords: (err: unknown) => string;
  /** After any answer that may have changed the booking (done, refused, found cancelled). */
  onChanged?: () => void;
  /** Reads the booking again: the booking when it is cancelled, else null (never a true/false: `V` is an object). */
  isCancelled: () => Promise<V | null>;
  /** Said once the check found it cancelled (`body` is gone after a reload; `found`: the booking as read). */
  checkedWords: (body: B | undefined, restored: boolean, found: V) => string;
  forgetConsequence: string;
  onDone: (words: string) => void;
}) {
  const { op, send: sendOp, settle } = useOwnedOp<B>(slot);
  const [resendError, setResendError] = useState<string | null>(null);

  async function sendCancel(p: PendingOp<B>) {
    const r = await perform(() => sendOp(p, send));
    if (r.kind === 'stale') return;
    if (r.kind === 'ok') { onDone(doneWords(r.value)); onChanged?.(); return; }
    if (r.kind === 'refused') { onChanged?.(); throw new Error(refusalWords(r.error)); }
  }

  if (op && !(busy && op.attempts === 1 && !op.uncertain)) {
    const restored = !!op.restored || !op.body;
    return (
      <section className="ws-section" aria-labelledby="cancel-h">
        <h2 id="cancel-h">{t('common.cancel')}</h2>
        {resendError && <Alert>{resendError}</Alert>}
        <CheckPanel label={t('ownedCancel.unconfirmedCancellation')}
          onCheck={async () => {
            const found = await isCancelled();
            if (found !== null) { settle(op.requestKey); onDone(checkedWords(restored ? undefined : op.body, restored, found)); onChanged?.(); return null; }
            return t('ownedCancel.notCancelledSoFarIt');
          }}
          resend={restored ? undefined : {
            label: t('common.sendTheSameRequestAgain'), busy,
            onClick: () => { setResendError(null); void sendCancel(op).catch((err: unknown) => setResendError(err instanceof Error ? err.message : String(err))); },
          }}
          forget={{ label: t('common.forgetIt'), confirmLabel: t('common.yesForgetIt'), onForget: () => settle(op.requestKey), consequence: forgetConsequence }}>
          <Alert tone="warn">
            {restored
              ? t('ownedCancel.aCancellationMadeEarlierOn')
              : t('ownedCancel.theOutcomeOfThisRequest', { value: op.error ? ` (${op.error})` : '' })}
          </Alert>
        </CheckPanel>
      </section>
    );
  }

  return (
    <section className="ws-section" aria-labelledby="cancel-h">
      <h2 id="cancel-h">{t('common.cancel')}</h2>
      <p className="ws-muted">{intro}</p>
      {extra}
      <ConfirmAction label={label} danger confirmLabel={t('common.yesCancelIt')} reason={'optional'} reasonLabel={t('ownedCancel.whyOptional')}
        maxReason={MAX_BOOKER_CANCEL_REASON} version={version} consequence={consequence}
        onConfirm={async (reason) => { await sendCancel(startOp(newRequestKey(), makeBody(reason.trim()))); }} />
    </section>
  );
}

/**
 * WQ17c: the cancel of a booking that may have been paid by card (WQ16, moved here from Booked consultations so that a lab
 * test cancels the very same way): the words follow how it was paid; a card-paid one chooses "Refund to card (default)" or
 * "Refund to wallet" (`refundTo`); one still waiting for its payment refunds nothing. The answer's `refund` is said.
 */
export function CardAwareCancel<B, V extends object>({ slot, label, what, when, introLead, amount, told, paidBy, waiting, captured, version, perform, busy, makeBody, send,
  refusalWords, isCancelled, checkedWords, onChanged, onDone }: {
  slot: string;
  label: string;
  /** "consultation", "lab test". */
  what: string;
  /** "24 Nov 2026 at 10:30". */
  when: string;
  /** "You can cancel any time before the consultation starts." */
  introLead: string;
  /** "₹500.00", or "The amount" when the view has no price. */
  amount: string;
  /** "The patient and the doctor are told." */
  told: string;
  /** From the booker view's `payment` (`unknown` only on an older server for a consultation not made on this device). */
  paidBy: 'card' | 'wallet' | 'unknown';
  /** A card booking not paid yet: nothing is refunded. */
  waiting: boolean;
  /** The server says the money was taken (`payment.state: 'captured'`; assumed on an older server). */
  captured: boolean;
  version?: string | number;
  perform: Perform;
  busy: boolean;
  makeBody: (reason: string, refundTo: RefundTo | undefined) => B;
  send: (body: B) => Promise<Pick<CancelAnswer, 'refundedMinor' | 'alreadyCancelled' | 'refund'>>;
  refusalWords: (err: unknown) => string;
  isCancelled: () => Promise<V | null>;
  checkedWords: (body: B | undefined, restored: boolean, found: V) => string;
  onChanged?: () => void;
  onDone: (words: string) => void;
}) {
  // WQ16 (r10 C2): a card-paid booking's money goes back to the card by default, or to the wallet on the pharmacy's choice.
  const [refundTo, setRefundTo] = useState<RefundTo>('card');
  const choose = paidBy === 'card' && !waiting && captured;
  return (
    <OwnedCancel<B, Pick<CancelAnswer, 'refundedMinor' | 'alreadyCancelled' | 'refund'>, V> slot={slot} label={label} perform={perform} busy={busy} version={version}
      intro={<>
        {introLead}{' '}
        {waiting ? t('ownedCancel.itIsNotPaidYet', { LATE_PAYMENT_BACK })
          : choose ? t('ownedCancel.theFullAmountGoesBack')
          : paidBy === 'wallet' ? t('ownedCancel.theFullAmountGoesBack2')
          : t('ownedCancel.theFullAmountGoesBack3')}
      </>}
      extra={choose && (
        <fieldset className="ws-checks" disabled={busy}>
          <legend>{t('ownedCancel.whereDoesTheMoneyGo')}</legend>
          <label className="ws-check">
            <input type="radio" name="refund-to" checked={refundTo === 'card'} onChange={() => setRefundTo('card')} />{t('ownedCancel.refundToCardDefaultTo')}</label>
          <label className="ws-check">
            <input type="radio" name="refund-to" checked={refundTo === 'wallet'} onChange={() => setRefundTo('wallet')} />{t('ownedCancel.refundToWalletAtOnce')}</label>
        </fieldset>
      )}
      consequence={t('ownedCancel.theOnIsCancelled', { what, when, value: waiting ? t('ownedCancel.itWasNotPaidSo', { LATE_PAYMENT_BACK })
          : choose ? `${amount} goes back to ${refundTo === 'wallet' ? 'your Jansetu wallet' : 'the card or UPI it was paid with'}; give the patient their money back. ${told}`
          : paidBy === 'wallet' ? `${amount} goes back to your wallet; give the patient their money back. ${told}`
          : `${amount} goes back the way it was paid (your wallet, or the card or UPI); give the patient their money back. ${told}` })}
      makeBody={(reason) => makeBody(reason, choose ? refundTo : undefined)}
      send={send}
      doneWords={(a) => cancelWords(a, told)}
      refusalWords={refusalWords}
      onChanged={onChanged}
      isCancelled={isCancelled}
      checkedWords={checkedWords}
      forgetConsequence={t('ownedCancel.ifTheEarlierCancellationStill')}
      onDone={onDone} />
  );
}
