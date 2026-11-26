import { COUNTER_PAYMENTS, type CounterPayment, type PharmacyOrder } from '@jansetu/api';
import { t } from '../../i18n/sale/index.ts';

/**
 * WQ54 (r37 review): how a counter payment was taken, the one choice every "Mark paid" offers (New sale and the Order page):
 * cash, UPI or card, sent as the mark-paid `paymentSource` exactly (the day's money is split by it). WQ54b: nothing is
 * chosen at first (the clerk taps one; Mark paid waits for it); 48 px choices.
 */
export function PaymentMethodPicker({ value, onChange, name }: { value: CounterPayment | null; onChange: (p: CounterPayment) => void; name: string }) {
  return (
    <fieldset className="ws-checks pay-picker">
      <legend>{t('payment.how')}</legend>
      {COUNTER_PAYMENTS.map((p) => (
        <label key={p} className="ws-check"><input type="radio" name={name} checked={value === p} onChange={() => onChange(p)} /> {paymentWords(p)}</label>
      ))}
      {value === null && <p className="ws-muted">{t('payment.chooseFirst')}</p>}
    </fieldset>
  );
}

export const paymentWords = (p: CounterPayment) => t(`payment.${p}`);

const METHOD_WORDS: Readonly<Record<string, () => string>> = {
  cash: () => t('payment.cash'), upi: () => t('payment.upi'), card: () => t('payment.card'), in_store_payment: () => t('bill.atCounter'),
  cash_on_delivery: () => t('bill.onDelivery'),
};
/** A recorded payment method or an order's payment mode in words (another value as sent, readable). */
export const methodWords = (m: string) => METHOD_WORDS[m]?.() ?? m.replace(/_/g, ' ');

/** WQ54b: how an order is paid: once paid, the method recorded (cash, UPI, card…); before, its payment mode. */
export function orderPaymentWords(o: Pick<PharmacyOrder, 'paymentStatus' | 'paymentMode' | 'paymentSource' | 'bill'>): string | null {
  const m = (o.paymentStatus === 'paid' ? o.bill?.paymentMethod ?? o.paymentSource : null) ?? o.paymentMode;
  return m ? methodWords(m) : null;
}
