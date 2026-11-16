import type { FinanceEvent, SettlementAccount } from '@jansetu/api';
import { detailsLabel, draftOfDetails, eventText, formatDate } from './finance.tsx';

const account = (o: Partial<SettlementAccount>): SettlementAccount => ({
  _id: 'c1'.repeat(12), ownerKind: 'partner', ownerId: 'a1'.repeat(12), beneficiaryName: 'City Lab', isActive: true, payoutDetails: null,
  payoutDetailsState: 'none', payoutDetailsVersion: 0, financeVersion: 0, ...o,
});
const ev = (action: string, detail: Record<string, unknown>): FinanceEvent => ({ _id: 'e', settlementAccountId: 'c', action, byKind: 'admin', by: 'x', detail, at: '2026-11-16T06:30:00.000Z' });

describe('finance screen helpers', () => {
  it('labels a destination as the server labels payouts, never with the full number', () => {
    expect(detailsLabel({ method: 'bank', ifsc: 'HDFC0001234', bankName: 'HDFC', accountNumberLast4: '9012', accountNumber: '123456789012' })).toBe('HDFC HDFC0001234 XXXX9012');
    expect(detailsLabel({ method: 'bank', ifsc: 'HDFC0001234', accountNumberMasked: 'XXXX9012' })).toBe('HDFC0001234');
    expect(detailsLabel({ method: 'upi', upiId: 'lab@okbank' })).toBe('UPI lab@okbank');
    expect(detailsLabel(null)).toBe('No payout details');
  });

  it('starts the destination form from what is saved, with the account number only where the server shows it in full', () => {
    const masked = draftOfDetails(account({ payoutDetails: { method: 'bank', accountName: 'City Lab', ifsc: 'HDFC0001234', accountNumberMasked: 'XXXX9012', accountNumberLast4: '9012' } }));
    expect(masked).toMatchObject({ method: 'bank', accountName: 'City Lab', accountNumber: '', confirmNumber: '', ifsc: 'HDFC0001234' });
    const full = draftOfDetails(account({ payoutDetails: { method: 'bank', accountName: 'City Lab', ifsc: 'HDFC0001234', accountNumber: '123456789012' } }));
    expect(full).toMatchObject({ accountNumber: '123456789012', confirmNumber: '123456789012' });
    expect(draftOfDetails(account({ payoutDetails: { method: 'upi', upiId: 'lab@okbank' } }))).toMatchObject({ method: 'upi', upiId: 'lab@okbank' });
    expect(draftOfDetails(null)).toMatchObject({ method: 'bank', accountName: '', upiId: '' });
  });

  it('describes events from their own details only, with signed amounts', () => {
    expect(eventText(ev('finance.payout_recorded', { amountMinor: 150000, reference: 'UTR1', paidOn: '2026-11-15', balanceBeforeMinor: 9 }))).toBe('₹1,500.00 · reference UTR1 · paid on 15 Nov 2026');
    expect(eventText(ev('finance.adjustment_posted', { amountMinor: -2550, reason: 'Recovery' }))).toBe('− ₹25.50 · “Recovery”');
    expect(eventText(ev('finance.payout_details_changed', { method: 'bank', ifsc: 'HDFC0001234', last4: '9012', version: 2 }))).toBe('Bank, IFSC HDFC0001234, account ending 9012 · version 2');
    expect(eventText(ev('finance.payout_details_changed', { method: 'upi', upiId: 'lab@okbank', version: 3 }))).toBe('UPI lab@okbank · version 3');
    expect(eventText(ev('finance.payout_details_verified', { version: 2 }))).toBe('Version 2');
    expect(eventText(ev('finance.something_else', { secret: 'x' }))).toBe('');
  });

  it('shows India calendar dates as written, whatever the time zone', () => {
    expect(formatDate('2026-11-01')).toBe('1 Nov 2026');
    expect(formatDate('2026-02-30')).toBe('2026-02-30');
    expect(formatDate(undefined)).toBe('—');
  });
});
