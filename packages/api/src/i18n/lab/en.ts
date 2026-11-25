/**
 * Lab words from `@jansetu/api` (docs/I18N_PLAN.md §3.2): slots and lab bookings (`partnerLabs.ts`), the lab front desk
 * (`labDesk.ts`) and the lab's and doctor's own wallet (`labWallet.ts`). A comment above a key is the translator's note.
 */
export default {
  /** How the sample is taken. */
  'visitMode.home': 'Home collection',
  'visitMode.lab': 'At the lab',

  /** Why a bookable time (slot) is closed. */
  'slot.closure.holiday': 'Closed: branch holiday',
  'slot.closure.template': 'Closed: no longer in the weekly template',
  'slot.closure.manual': 'Closed by staff',

  'slot.problem.minutes': 'Enter whole minutes from {min} to {max}.',
  /** Seats: how many patients one time can take. */
  'slot.problem.seats': 'Enter a number of seats from 1 to {max}.',
  'slot.problem.windows': 'At most {max} time windows a day.',
  /** HH:MM: hours and minutes, e.g. 09:30 (keep "HH:MM" as is). */
  'slot.problem.timeFormat': 'Enter each time as HH:MM.',
  'slot.problem.windowOrder': 'A window must end after it starts.',
  'slot.problem.overlap': 'These windows overlap.',
  'slot.problem.date': 'Enter a real date.',
  'slot.problem.start': 'Enter the start time.',
  'slot.problem.end': 'Enter the end time.',
  'slot.problem.order': 'A slot must end after it starts.',
  'slot.problem.capacity': 'Enter a number from {min} to {max}.',
  'slot.problem.belowBooked': {
    one: '{count} seat is already booked: the capacity cannot be lower.',
    other: '{count} seats are already booked: the capacity cannot be lower.',
  },

  /** A lab booking's state. */
  'booking.status.pending_payment': 'Waiting for payment',
  'booking.status.confirmed': 'Confirmed',
  'booking.status.sample_collected': 'Sample collected',
  'booking.status.visited': 'Visited',
  'booking.status.processing': 'Processing',
  'booking.status.report_ready': 'Report released',
  'booking.status.completed': 'Completed',
  'booking.status.cancelled': 'Cancelled',
  /** The patient did not come. */
  'booking.status.no_show': 'No-show',
  'booking.payment.pending': 'Not paid yet',
  'booking.payment.paid': 'Paid online',
  'booking.payment.refunded': 'Refunded',

  /** {file}: the file's own name. */
  'report.file.type': '{file}: only PDF, JPEG, PNG or WebP files can be uploaded.',
  'report.file.empty': '{file} is empty.',
  'report.file.tooLarge': '{file} is larger than 10 MB.',

  /** Why a lab booking step is not offered yet. */
  'booking.blocked.rescheduleWaiting': 'The customer has not answered the new time yet.',
  /** {end}: the time the slot ends. */
  'booking.blocked.noShow': 'A no-show can be marked only after the slot has ended ({end}).',
  'booking.blocked.release': 'Upload a report first.',

  /** The lab front desk (walk-in patients). */
  'desk.switchedOff': 'The lab front desk is not switched on yet.',
  'desk.refusal.SLOT_REQUIRED': 'Choose a time for the home collection.',
  'desk.refusal.COLLECTOR_NOT_MEMBER': 'This collector is not a member of this lab. Type the collector’s name instead.',
  'desk.refusal.BRANCH_SCOPE_EXCEEDED': 'You do not work at this branch. Choose one of your branches.',
  'desk.refusal.LAB_PARTNER_REQUIRED': 'The front desk is for labs only.',
  'desk.refusal.PARTNER_NOT_VERIFIED': 'This lab is not verified or not active, so it cannot book now.',
  'desk.refusal.DEPENDENT_NOT_FOUND': 'This family member was not found on the number. Enter the patient again.',
  'desk.refusal.PRICE_CHANGED': 'The lab’s prices changed.',
  'desk.price.changed': 'The lab’s prices changed. Choose the tests again to see the new total.',
  /** {total}: an amount of money. */
  'desk.price.changedTo': 'The lab’s prices changed: the total is now {total}. Tell the patient, then book at the new total.',

  /** A card or UPI top-up of the wallet. */
  'wallet.topup.awaiting_payment': 'Not paid yet',
  'wallet.topup.credited': 'Added',
  'wallet.topup.paid_not_credited': 'Paid, not added yet',
  /** Blocked after a card dispute (chargeback). */
  'wallet.topup.blocked': 'Blocked after a dispute',
  /** The payment was settled by hand by Jansetu. */
  'wallet.topup.closed_compensated': 'Paid by hand',
  'wallet.topup.failed': 'Failed',
  'wallet.topup.refunded': 'Refunded',
  'wallet.topup.unreadable': 'The answer about this top-up could not be read.',
  /** {max} and {allowed}: amounts of money. */
  'wallet.limit.upTo': 'The wallet can hold at most {max}. You can add up to {allowed} now.',
  /** {max}: an amount of money. */
  'wallet.limit.full': 'The wallet can hold at most {max}, so no more money can be added now.',
  'wallet.labsOnly': 'The wallet is for labs only.',
  'wallet.labNotFound': 'This lab was not found.',
  'wallet.doctorNotFound': 'This doctor was not found.',
  /** The wallet is on hold and owes money to Jansetu. */
  'wallet.receivable': 'The wallet owes Jansetu money, so its hold cannot be released yet.',
  'wallet.lab.switchedOff': 'Adding money to the lab wallet is not switched on yet.',
  'wallet.doctor.switchedOff': 'Adding money to your wallet is not switched on yet.',
  'wallet.doctor.closed': 'Your wallet opens once Jansetu has verified your account and it is active.',
} as const;
