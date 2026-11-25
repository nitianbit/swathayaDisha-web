/**
 * Referral earnings of a booking partner (WQ26, WQ26b): the pharmacy's and the lab's page. Keys as WQ45 named the
 * pharmacy page's words. A comment above a key is the translator's note.
 */
export default {
  /** Page title and the totals' label. */
  'referralEarnings.referralEarnings': 'Referral earnings',
  /** Under the title, for a lab (labs book consultations with doctors). */
  'referralEarnings.whatYourLabEarnsFor': 'What your lab earns for the consultations it books for patients. It comes out of the doctor’s earning, not from the patient.',
  'referralEarnings.earnings': 'Earnings',
  'referralEarnings.loadingYourReferralEarnings': 'Loading your referral earnings…',
  'referralEarnings.dueToYou': 'Due to you',
  'referralEarnings.earned': 'Earned',
  'referralEarnings.paidToYou': 'Paid to you',
  'referralEarnings.payoutsStartOnceJansetuSwitches': 'Payouts start once Jansetu switches them on.',
  'referralEarnings.yourRates': 'Your rates',
  'referralEarnings.loadingYourRates': 'Loading your rates…',
  'referralEarnings.jansetuHasNotSwitchedReferral': 'Jansetu has not switched referral cuts on yet, so new bookings earn no cut for now.',
  'referralEarnings.jansetuSetsTheseRatesA': 'Jansetu sets these rates. A booking keeps the rate it was made with; the cut is earned when it is completed.',
  'referralEarnings.statement': 'Statement',
  'referralEarnings.loadingTheStatement': 'Loading the statement…',
  'referralEarnings.noReferralEarningsYet': 'No referral earnings yet',
  'referralEarnings.aCutIsListedHere': 'A cut is listed here when a booking you made is completed.',
  /** The statement of a chosen period has no entries. */
  'referralEarnings.noEntries': 'No entries',
  'referralEarnings.nothingInThisPeriod': 'Nothing was recorded in this period.',
  /** Hidden caption of the statement table (screen readers). */
  'referralEarnings.referralStatementNewestFirst': 'Referral statement, newest first',
  'referralEarnings.dateIndiaTime': 'Date (India time)',
  /** Column: the booking's short reference code. */
  'referralEarnings.ref': 'Ref',
  'referralEarnings.category': 'Category',
  /** Column: the booking's amount the cut is taken from. */
  'referralEarnings.base': 'Base',
  /** Column: the referral cut earned. */
  'referralEarnings.cut': 'Cut',
  /** Label of the statement's page buttons (screen readers). */
  'referralEarnings.statementPages': 'Statement pages',
  'referralEarnings.category.consultation': 'Consultation',
  'referralEarnings.category.lab_test': 'Lab test',
  'referralEarnings.category.lab_package': 'Lab package',
  /** A lab booking whose cut lines are both tests and packages. */
  'referralEarnings.category.mixed': 'Lab tests and packages',
  /** One line of a lab booking under its row: "Lab test ₹300.00: cut ₹15.00". */
  'referralEarnings.line': '{category} {base}: cut {cut}',
} as const;
