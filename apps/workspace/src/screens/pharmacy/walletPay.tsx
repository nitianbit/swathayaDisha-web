import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  assistedRefusal, doctorWalletApi, pharmacyWalletApi, walletBalancePaise, walletState, type ApiClient, type AssistedPaymentMethod, type BookerKind, type PharmacyWallet,
  type Refusal,
} from '@jansetu/api';
import { Alert, Button, ErrorState, formatRupees, Loading, shared } from '@jansetu/ui';
import { pharmacyTopupSource, TopUpForm, type TopupSource } from './topup.tsx';
import { walletHoldWords, walletKeyOf, type WalletPayer } from './WalletScreen.tsx';
import { t } from '../../i18n/pharmacy/index.ts';

/**
 * WQ17: paying an assisted booking from the pharmacy's Jansetu wallet (WQ12, moved here unchanged from Book consultation
 * so that Book lab test pays the very same way): the balance, a hold, the refusal with "Use the new price", the top-up in
 * place, and the one primary action. WQ25: a doctor pays the same way from its own wallet (r20), adding money on its
 * Wallet page.
 */

/**
 * WQ24: the wallet that pays a booking: the pharmacy's (WQ12), a lab's (WQ20) when a lab member books, or (WQ25) a doctor's
 * own. `read` is null when this person cannot see the balance, `topup` null when they cannot add money here, `page` null
 * when they cannot open the wallet page.
 */
export interface PayWallet {
  owner: BookerKind | 'doctor';
  /** The wallet's query key (the balance is read under `[...queryKey, 'balance']`, as its page reads it). */
  queryKey: readonly unknown[];
  read: (() => Promise<PharmacyWallet | null>) | null;
  topup: TopupSource | null;
  page: string | null;
}
export const pharmacyPayWallet = (api: ApiClient, pharmacyId: string): PayWallet => ({
  owner: 'pharmacy', queryKey: walletKeyOf({ kind: 'pharmacy', id: pharmacyId }), read: () => pharmacyWalletApi(api).wallet(),
  topup: pharmacyTopupSource(api, pharmacyId), page: '/pharmacy/wallet',
});
/** WQ25: a doctor's own wallet (WQ23): money is added on its Wallet page, not here. */
export const doctorPayWallet = (api: ApiClient, doctorId: string): PayWallet => ({
  owner: 'doctor', queryKey: walletKeyOf({ kind: 'doctor', id: doctorId }), read: () => doctorWalletApi(api).wallet(), topup: null, page: '/doctor/wallet',
});
/** WQ25's payer (a pharmacy or a doctor) as the wallet that pays. */
export const payerWallet = (api: ApiClient, payer: WalletPayer): PayWallet =>
  (payer.kind === 'doctor' ? doctorPayWallet(api, payer.id) : pharmacyPayWallet(api, payer.id));

/** Review (WQ25): where the booker collects: a pharmacy or a lab at its counter; a doctor from its patient (no counter). */
const counterWords = (owner: PayWallet['owner']) => (owner === 'doctor' ? '' : ' at your counter');

/** Plain refusal words, adjusted when a coupon explains the new price. */
export function refusalText(r: Refusal, coupon?: string): string {
  if (r.kind === 'price' && coupon && r.priceMinor !== undefined) return t('walletPay.withTheCouponThePrice', { coupon, amount: formatRupees(r.priceMinor / 100) });
  return r.message;
}

/** The refusal of the last attempt, with "Use the new price" when the server named one (a new request). */
export function RefusalAlert({ refused, couponCode, onNewPrice }: { refused: Refusal | null; couponCode?: string; onNewPrice: (priceMinor: number) => void }) {
  if (!refused) return null;
  return (
    <Alert>
      {refusalText(refused, couponCode)}
      {refused.kind === 'price' && refused.priceMinor !== undefined && (
        <> <Button variant="secondary" onClick={() => onNewPrice(refused.priceMinor!)}>{t('walletPay.useTheNewPrice')}{formatRupees(refused.priceMinor / 100)})</Button></>
      )}
    </Alert>
  );
}

export function WalletPay({ wallet: w, priceMinor, couponCode, refused, busy, onPay, onBack, onNewPrice, payLabel }: {
  /** WQ24: the wallet that pays (`pharmacyPayWallet`, `doctorPayWallet`, or a lab's). */
  wallet: PayWallet;
  priceMinor: number; couponCode?: string; refused: Refusal | null; busy: boolean;
  onPay: () => void; onBack: () => void; onNewPrice: (priceMinor: number) => void;
  /** WQ22: the pay button's words (default "Pay ₹X from wallet"). */
  payLabel?: (amount: string) => string;
}) {
  const wallet = useQuery({ queryKey: [...w.queryKey, 'balance'], queryFn: () => w.read!(), enabled: !!w.read });
  const balance = walletBalancePaise(wallet.data);
  const hold = walletHoldWords(wallet.data);
  const short = wallet.data !== undefined && walletState(wallet.data) === 'ok' && balance < priceMinor;
  const [showTopUp, setShowTopUp] = useState(false);
  const needTopUp = short || refused?.kind === 'topup';
  const where = counterWords(w.owner);
  return (
    <>
      {!w.read ? <p className="ws-muted">{t(`walletPay.cannotSeeBalance.${w.owner}`)}</p>
        : wallet.isPending ? <Loading label={t('walletPay.readingYourWallet')} />
        : wallet.isError ? <ErrorState message={assistedRefusal(wallet.error).message} onRetry={() => void wallet.refetch()} />
        : (
          <p>{t('walletPay.moneyInYourWallet')}<strong>{formatRupees(balance / 100)}</strong>
            {!hold && !short ? <>{t('walletPay.afterThisBooking')}{formatRupees((balance - priceMinor) / 100)}</> : null}
          </p>
        )}
      {hold && <Alert tone="warn">{hold}</Alert>}
      <RefusalAlert refused={refused} couponCode={couponCode} onNewPrice={onNewPrice} />
      {needTopUp && !hold && (
        <Alert tone="warn">
          {short ? t('walletPay.yourWalletNeedsMoreFor', { amount: formatRupees((priceMinor - balance) / 100) }) : t('walletPay.yourWalletNeedsMoreMoney')}
          {w.topup ? (
            <>
              {' '}<Button variant="secondary" onClick={() => setShowTopUp(true)}>{t('walletPay.topUpNow')}</Button>{' '}
              {w.page && <>{t('walletPay.orOpenThe')}<Link to={w.page}>{t('common.wallet')}</Link>{t('walletPay.pageThisBookingIsNot')}</>}
            </>
          ) : w.owner === 'doctor' && w.page ? (
            // WQ25: a doctor adds money on its own Wallet page (WQ23).
            <>{' '}<Link to={w.page}>{t('common.addMoney')}</Link>{t('walletPay.onYourWalletPageThen')}</>
          ) : t('walletPay.askSomeoneWhoCanAdd')}
        </Alert>
      )}
      {showTopUp && w.topup && (
        // WQ24b: the balance is read again only where this person may read it (`wallet.manage` without `wallet.view`: never).
        <TopUpForm pharmacyId={w.topup.owner} source={w.topup} suggested={Math.max(1, (priceMinor - balance) / 100)}
          {...(w.read ? { onCredited: () => void wallet.refetch() } : {})} />
      )}
      <span className="ws-muted">{t('walletPay.collect')}{formatRupees(priceMinor / 100)}{t('walletPay.fromThePatient')}{where}{t('walletPay.ifTheBookingIsCancelled')}</span>
      <div className="confirm-actions">
        <Button busy={busy} disabled={!!hold || short || (refused?.kind === 'price')} onClick={onPay}>
          {payLabel ? payLabel(formatRupees(priceMinor / 100)) : t('walletPay.payFromWallet', { amount: formatRupees(priceMinor / 100) })}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onBack}>{shared('action.back')}</Button>
      </div>
    </>
  );
}

/**
 * WQ17c: "How do you pay?" (WQ16, moved here from Book consultation so that Book lab test offers card or UPI the very same
 * way): the wallet (the default) or card or UPI, only when there is something to pay; a switched-off card is said next to it.
 * WQ27: a doctor's lab test too; WQ24: a lab's consultation (`wallet`).
 */
export function PayChoice({ wallet, priceMinor, couponCode, refused, busy, method, cardOff, onMethod, onPay, onBack, onNewPrice }: {
  wallet: PayWallet; priceMinor: number; couponCode?: string; refused: Refusal | null; busy: boolean;
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
          <legend>{t('walletPay.howDoYouPay')}</legend>
          <label className="ws-check">
            <input type="radio" name="pay-method" checked={!byCard} onChange={() => onMethod('wallet')} />{t('walletPay.payFromWallet2')}</label>
          <label className="ws-check">
            <input type="radio" name="pay-method" checked={byCard} disabled={!!cardOff} aria-describedby={cardOff ? 'card-off' : undefined} onChange={() => onMethod('razorpay')} />{t('walletPay.payByCardOrUpi')}</label>
          {cardOff && <span id="card-off" className="j-field__hint">{cardOff}</span>}
        </fieldset>
      )}
      {byCard ? (
        <>
          <RefusalAlert refused={refused} couponCode={couponCode} onNewPrice={onNewPrice} />
          <span className="ws-muted">{t('walletPay.collect')}{formatRupees(priceMinor / 100)}{t('walletPay.fromThePatient')}{counterWords(wallet.owner)}{t('walletPay.youPayItOnThe')}</span>
          <div className="confirm-actions">
            <Button busy={busy} disabled={refused?.kind === 'price'} onClick={onPay}>{t('walletPay.pay')}{formatRupees(priceMinor / 100)}{t('walletPay.byCardOrUpi')}</Button>
            <Button variant="ghost" disabled={busy} onClick={onBack}>{shared('action.back')}</Button>
          </div>
        </>
      ) : (
        <WalletPay wallet={wallet} priceMinor={priceMinor} couponCode={couponCode} refused={refused} busy={busy}
          onPay={onPay} onBack={onBack} onNewPrice={onNewPrice} />
      )}
    </>
  );
}
