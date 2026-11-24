import { useState } from 'react';
import { Link } from 'react-router';
import { assistedRefusal, walletBalancePaise, walletState, type AssistedPaymentMethod, type Refusal } from '@jansetu/api';
import { Alert, Button, ErrorState, formatRupees, Loading } from '@jansetu/ui';
import { TopUpForm } from './topup.tsx';
import { useWallet, walletHoldWords } from './WalletScreen.tsx';

/**
 * WQ17: paying an assisted booking from the pharmacy's Jansetu wallet (WQ12, moved here unchanged from Book consultation
 * so that Book lab test pays the very same way): the balance, a hold, the refusal with "Use the new price", the top-up in
 * place, and the one primary action.
 */

/** Plain refusal words, adjusted when a coupon explains the new price. */
export function refusalText(r: Refusal, coupon?: string): string {
  if (r.kind === 'price' && coupon && r.priceMinor !== undefined) return `With the coupon ${coupon}, the price is ${formatRupees(r.priceMinor / 100)}. Check it with the patient, then pay.`;
  return r.message;
}

/** The refusal of the last attempt, with "Use the new price" when the server named one (a new request). */
export function RefusalAlert({ refused, couponCode, onNewPrice }: { refused: Refusal | null; couponCode?: string; onNewPrice: (priceMinor: number) => void }) {
  if (!refused) return null;
  return (
    <Alert>
      {refusalText(refused, couponCode)}
      {refused.kind === 'price' && refused.priceMinor !== undefined && (
        <> <Button variant="secondary" onClick={() => onNewPrice(refused.priceMinor!)}>Use the new price ({formatRupees(refused.priceMinor / 100)})</Button></>
      )}
    </Alert>
  );
}

export function WalletPay({ pharmacyId, priceMinor, couponCode, refused, busy, onPay, onBack, onNewPrice, payLabel }: {
  pharmacyId: string; priceMinor: number; couponCode?: string; refused: Refusal | null; busy: boolean;
  onPay: () => void; onBack: () => void; onNewPrice: (priceMinor: number) => void;
  /** WQ22: the pay button's words (default "Pay ₹X from wallet"). */
  payLabel?: (amount: string) => string;
}) {
  const wallet = useWallet(pharmacyId);
  const balance = walletBalancePaise(wallet.data);
  const hold = walletHoldWords(wallet.data);
  const short = wallet.data !== undefined && walletState(wallet.data) === 'ok' && balance < priceMinor;
  const [showTopUp, setShowTopUp] = useState(false);
  const needTopUp = short || refused?.kind === 'topup';
  return (
    <>
      {wallet.isPending ? <Loading label="Reading your wallet…" />
        : wallet.isError ? <ErrorState message={assistedRefusal(wallet.error).message} onRetry={() => void wallet.refetch()} />
        : (
          <p>
            Money in your wallet: <strong>{formatRupees(balance / 100)}</strong>
            {!hold && !short ? <> · After this booking: {formatRupees((balance - priceMinor) / 100)}</> : null}
          </p>
        )}
      {hold && <Alert tone="warn">{hold}</Alert>}
      <RefusalAlert refused={refused} couponCode={couponCode} onNewPrice={onNewPrice} />
      {needTopUp && !hold && (
        <Alert tone="warn">
          {short ? `Your wallet needs ${formatRupees((priceMinor - balance) / 100)} more for this booking.` : 'Your wallet needs more money for this booking.'}
          {' '}<Button variant="secondary" onClick={() => setShowTopUp(true)}>Top up now</Button>{' '}
          or open the <Link to="/pharmacy/wallet">Wallet</Link> page (this booking is not kept if you leave).
        </Alert>
      )}
      {showTopUp && <TopUpForm pharmacyId={pharmacyId} suggested={Math.max(1, (priceMinor - balance) / 100)} onCredited={() => void wallet.refetch()} />}
      <span className="ws-muted">Collect {formatRupees(priceMinor / 100)} from the patient at your counter. If the booking is cancelled, the money comes back to your wallet.</span>
      <div className="confirm-actions">
        <Button busy={busy} disabled={!!hold || short || (refused?.kind === 'price')} onClick={onPay}>
          {payLabel ? payLabel(formatRupees(priceMinor / 100)) : `Pay ${formatRupees(priceMinor / 100)} from wallet`}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onBack}>Back</Button>
      </div>
    </>
  );
}

/**
 * WQ17c: "How do you pay?" (WQ16, moved here from Book consultation so that Book lab test offers card or UPI the very same
 * way): the wallet (the default) or card or UPI, only when there is something to pay; a switched-off card is said next to it.
 */
export function PayChoice({ pharmacyId, priceMinor, couponCode, refused, busy, method, cardOff, onMethod, onPay, onBack, onNewPrice }: {
  pharmacyId: string; priceMinor: number; couponCode?: string; refused: Refusal | null; busy: boolean;
  method: AssistedPaymentMethod; cardOff: string | null; onMethod: (m: AssistedPaymentMethod) => void;
  onPay: () => void; onBack: () => void; onNewPrice: (priceMinor: number) => void;
}) {
  // WQ16: card or UPI only when there is something to pay; the wallet path below stays as it was.
  const offerCard = priceMinor > 0;
  const byCard = offerCard && method === 'razorpay' && !cardOff;
  return (
    <>
      {offerCard && (
        <fieldset className="ws-checks" disabled={busy}>
          <legend>How do you pay?</legend>
          <label className="ws-check">
            <input type="radio" name="pay-method" checked={!byCard} onChange={() => onMethod('wallet')} />
            Pay from wallet
          </label>
          <label className="ws-check">
            <input type="radio" name="pay-method" checked={byCard} disabled={!!cardOff} aria-describedby={cardOff ? 'card-off' : undefined} onChange={() => onMethod('razorpay')} />
            Pay by card or UPI
          </label>
          {cardOff && <span id="card-off" className="j-field__hint">{cardOff}</span>}
        </fieldset>
      )}
      {byCard ? (
        <>
          <RefusalAlert refused={refused} couponCode={couponCode} onNewPrice={onNewPrice} />
          <span className="ws-muted">
            Collect {formatRupees(priceMinor / 100)} from the patient at your counter. You pay it on the Razorpay page next. The time is held for 30
            minutes while you pay. If the booking is cancelled later, the money goes back to the card or UPI, or to your wallet if you choose.
          </span>
          <div className="confirm-actions">
            <Button busy={busy} disabled={refused?.kind === 'price'} onClick={onPay}>Pay {formatRupees(priceMinor / 100)} by card or UPI</Button>
            <Button variant="ghost" disabled={busy} onClick={onBack}>Back</Button>
          </div>
        </>
      ) : (
        <WalletPay pharmacyId={pharmacyId} priceMinor={priceMinor} couponCode={couponCode} refused={refused} busy={busy}
          onPay={onPay} onBack={onBack} onNewPrice={onNewPrice} />
      )}
    </>
  );
}
