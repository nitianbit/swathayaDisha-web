import type { ReactNode } from 'react';
import { Alert } from '@jansetu/ui';
import type { PendingOp } from '../../requests.ts';
import { CheckPanel } from './ownedOp.tsx';
import { t } from '../../i18n/pharmacy/index.ts';

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
      <CheckPanel label={t('unconfirmedBooking.unconfirmed', { what })}
        onCheck={async () => {
          const r = await byKey();
          if (r.state === 'used') return onUsed(r as A & Used, restored);
          if (r.state === 'abandoned') { onAbandoned(); return null; }
          return restored
            ? t('unconfirmedBooking.notBookedSoFarIt')
            : t('unconfirmedBooking.notBookedSoFarIt2', { twice });
        }}
        resend={restored ? undefined : { label: t('common.sendTheSameRequestAgain'), busy: busy && !givingUp, onClick: onResend }}
        giveUp={{ label: t('common.giveThisUp'), busy: givingUp, onClick: onGiveUp }}>
        {!restored && extra}
        <Alert tone="warn">
          {restored
            ? t('unconfirmedBooking.aMadeEarlierOnThis', { what })
            : t('unconfirmedBooking.theOutcomeOfThisRequest', { value: op.error ? ` (${op.error})` : '', value2: charged ? ' and paid' : '', twice })}
        </Alert>
        {!restored && summary}
      </CheckPanel>
    </>
  );
}
