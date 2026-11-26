import { COUNTER_PAYMENTS, type CounterPayment } from '@jansetu/api';
import { t } from '../../i18n/sale/index.ts';

/**
 * WQ54 (r37 review): how a counter payment was taken, the one choice every "Mark paid" offers (New sale and the Order page):
 * cash, UPI or card, sent as the mark-paid `paymentSource` exactly (the day's money is split by it).
 */
export function PaymentMethodPicker({ value, onChange, name }: { value: CounterPayment; onChange: (p: CounterPayment) => void; name: string }) {
  return (
    <fieldset className="ws-checks">
      <legend>{t('payment.how')}</legend>
      {COUNTER_PAYMENTS.map((p) => (
        <label key={p} className="ws-check"><input type="radio" name={name} checked={value === p} onChange={() => onChange(p)} /> {paymentWords(p)}</label>
      ))}
    </fieldset>
  );
}

export const paymentWords = (p: CounterPayment) => t(`payment.${p}`);
