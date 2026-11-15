import { agreementState } from './priceAgreement.ts';

describe('price agreement', () => {
  it('counts nothing as seen while the price is being worked out', () => {
    expect(agreementState(null, 'a', '1', false)).toEqual({ agreed: false, changed: false });
  });
  it('the first price shown for a choice is the one seen; a change for the same choice must be accepted again', () => {
    expect(agreementState(null, 'a', '500:450', true)).toMatchObject({ agreed: false, firstSight: true });
    expect(agreementState({ ctx: 'a', price: '500:450' }, 'a', '500:450', true)).toEqual({ agreed: true, changed: false });
    expect(agreementState({ ctx: 'a', price: '500:450' }, 'a', '600:550', true)).toEqual({ agreed: false, changed: true, previous: '500:450' });
  });
  it('a different choice (other tests, doctor, coupon) is a new first sight, not a change', () => {
    expect(agreementState({ ctx: 'a', price: '500:450' }, 'b', '900:900', true)).toMatchObject({ agreed: false, changed: false, firstSight: true });
  });
});
