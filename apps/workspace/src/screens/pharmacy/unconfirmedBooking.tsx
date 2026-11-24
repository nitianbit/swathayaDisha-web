import type { ReactNode } from 'react';
import { Alert } from '@jansetu/ui';
import type { PendingOp } from '../../requests.ts';
import { CheckPanel } from './ownedOp.tsx';

type Used = { state: 'used' };
/**
 * WQ17: an assisted booking whose create answer is not known (WQ12, moved here from Book consultation so that Book lab
 * test handles it the very same way): check it by its key, send the same request again (never booked or charged twice),
 * or give it up on the server (then it can never be booked). After a reload only the key is kept: check or give up.
 */
export function UnconfirmedBooking<B, A extends { state: string }>({ op, what, busy, givingUp, resendError, byKey, onUsed, onAbandoned, onResend, onGiveUp,
  extra, summary, charged = true }: {
  op: PendingOp<B>;
  /** "booking", "lab booking". */
  what: string;
  busy: boolean;
  givingUp: boolean;
  resendError: string | null;
  byKey: () => Promise<A>;
  /** The key was used: settle and show it; a sentence when something is still to do. */
  onUsed: (answer: A & Used, restored: boolean) => string | null;
  onAbandoned: () => void;
  onResend: () => void;
  onGiveUp: () => void;
  extra?: ReactNode;
  summary?: ReactNode;
  /** WQ19: false for a booking paid at the lab (nothing is charged through Jansetu). */
  charged?: boolean;
}) {
  const restored = !!op.restored || !op.body;
  const twice = charged ? 'never booked or charged twice' : 'never booked twice';
  return (
    <>
      {resendError && <Alert>{resendError}</Alert>}
      <CheckPanel label={`Unconfirmed ${what}`}
        onCheck={async () => {
          const r = await byKey();
          if (r.state === 'used') return onUsed(r as A & Used, restored);
          if (r.state === 'abandoned') { onAbandoned(); return null; }
          return restored
            ? 'Not booked so far. It may still be on its way. Give it up to make sure it never is, then book again.'
            : `Not booked so far. It may still be on its way. Sending the same request again is safe: it is ${twice}.`;
        }}
        resend={restored ? undefined : { label: 'Send the same request again', busy: busy && !givingUp, onClick: onResend }}
        giveUp={{ label: 'Give this up', busy: givingUp, onClick: onGiveUp }}>
        {!restored && extra}
        <Alert tone="warn">
          {restored
            ? `A ${what} made earlier on this device (before the page was reloaded, or before you signed out) was not confirmed. Its details are not kept here. Check it, or give it up: then it can never be booked.`
            : `The outcome of this request is not known yet${op.error ? ` (${op.error})` : ''}. The booking may already be made${charged ? ' and paid' : ''}. Sending the same request again is safe: it is ${twice}. Or give it up: then it can never be booked.`}
        </Alert>
        {!restored && summary}
      </CheckPanel>
    </>
  );
}
