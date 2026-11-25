/**
 * `@jansetu/api` finance words (docs/I18N_PLAN.md §3.2): settlement accounts, the ledger, payout destinations and
 * payouts (`finance.ts`). A comment above a key is the translator's note.
 */
export default {

  /** Who a settlement account belongs to. */
  'owner.partner': 'Lab or clinic',
  'owner.doctor': 'Doctor',
  /** Where the payout bank account or UPI ID stands. */
  'details.none': 'Not given',
  'details.unverified': 'Waiting for verification',
  'details.verified': 'Verified',
  /** Kind of a statement line. */
  'ledger.earning': 'Earning',
  /** An earning taken back (e.g. a cancelled booking). */
  'ledger.reversal': 'Reversal',
  'ledger.payout': 'Payout',
  /** A correction posted by Jansetu. */
  'ledger.adjustment': 'Adjustment',
  /** How a payout was sent. */
  'payoutMethod.bank_transfer': 'Bank transfer',
  'payoutMethod.upi': 'UPI',
  'payoutMethod.other': 'Other',
  'payoutState.recorded': 'Recorded',
  /** A payout cancelled after it was recorded. */
  'payoutState.voided': 'Voided',

  /** Under the payout destination fields. */
  'details.accountName': 'Enter the account holder’s name.',
  'details.accountNumber': 'The account number must be 9 to 18 digits.',
  /** Keep ABCD0123456 as written: it is the shape of the code. */
  'details.ifsc': 'The IFSC must look like ABCD0123456.',
  /** Keep name@bank as written: it is the shape of the ID. */
  'details.upiId': 'The UPI ID must look like name@bank.',
  /** Under the fields of a payout the admin records. */
  'payout.amount.format': 'Enter rupees, like 4500 or 4500.50.',
  'payout.amount.zero': 'Enter an amount above zero.',
  'payout.amount.tooLarge': 'This is above the largest payout the server accepts.',
  'payout.amount.aboveBalance': 'A payout cannot be more than the balance.',
  /** UTR: the bank's transfer reference. */
  'payout.reference': 'Enter the bank reference (UTR), {min} to {max} characters.',
  'payout.paidOn.missing': 'Enter the date the money was sent.',
  'payout.paidOn.future': 'The date cannot be in the future.',
  /** The reason for an adjustment or a void. */
  'reason.tooShort': 'Give a reason (at least {min} characters).',
} as const;
