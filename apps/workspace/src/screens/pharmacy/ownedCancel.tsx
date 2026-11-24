import { useState, type ReactNode } from 'react';
import { MAX_BOOKER_CANCEL_REASON } from '@jansetu/api';
import { Alert } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { newRequestKey, startOp, type PendingOp } from '../../requests.ts';
import type { Perform } from '../finance/finance.tsx';
import { CheckPanel, useOwnedOp } from './ownedOp.tsx';

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
        <h2 id="cancel-h">Cancel</h2>
        {resendError && <Alert>{resendError}</Alert>}
        <CheckPanel label="Unconfirmed cancellation"
          onCheck={async () => {
            const found = await isCancelled();
            if (found !== null) { settle(op.requestKey); onDone(checkedWords(restored ? undefined : op.body, restored, found)); onChanged?.(); return null; }
            return 'Not cancelled so far. It may still be on its way. Sending the same cancellation again is safe: the money is never refunded twice.';
          }}
          resend={restored ? undefined : {
            label: 'Send the same request again', busy,
            onClick: () => { setResendError(null); void sendCancel(op).catch((err: unknown) => setResendError(err instanceof Error ? err.message : String(err))); },
          }}
          forget={{ label: 'Forget it', confirmLabel: 'Yes, forget it', onForget: () => settle(op.requestKey), consequence: forgetConsequence }}>
          <Alert tone="warn">
            {restored
              ? 'A cancellation made earlier on this device was not confirmed. Check whether the booking was cancelled.'
              : `The outcome of this request is not known yet${op.error ? ` (${op.error})` : ''}. The booking may already be cancelled. Sending the same request again is safe.`}
          </Alert>
        </CheckPanel>
      </section>
    );
  }

  return (
    <section className="ws-section" aria-labelledby="cancel-h">
      <h2 id="cancel-h">Cancel</h2>
      <p className="ws-muted">{intro}</p>
      {extra}
      <ConfirmAction label={label} danger confirmLabel="Yes, cancel it" reason="optional" reasonLabel="Why? (optional)"
        maxReason={MAX_BOOKER_CANCEL_REASON} version={version} consequence={consequence}
        onConfirm={async (reason) => { await sendCancel(startOp(newRequestKey(), makeBody(reason.trim()))); }} />
    </section>
  );
}
