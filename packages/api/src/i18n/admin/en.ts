/**
 * `@jansetu/api` words of the Jansetu admin tools (docs/I18N_PLAN.md §3.2): consultations and their no-show cancel,
 * doctors and the close-and-refund, pharmacy accounts, wallet credits and compensated top-ups, referral cuts
 * (`adminConsultations.ts`, `adminDoctors.ts`, `adminPharmacies.ts`, `adminPharmacyWallet.ts`, `referralCuts.ts`).
 * Refusal keys end with the server's error code. A comment above a key is the translator's note.
 */
export default {

  /** Status of a doctor consultation booking (a filter and a badge). */
  'consultation.status.pending': 'Waiting',
  'consultation.status.confirmed': 'Confirmed',
  'consultation.status.completed': 'Completed',
  'consultation.status.cancelled': 'Cancelled',
  /** The patient did not come. */
  'consultation.status.no_show': 'No-show',
  'consultation.query.realDates': 'Enter real dates.',
  'consultation.query.periodOrder': 'The period ends before it starts.',
  /** Refusals of the admin cancel of a booking moved after a no-show. */
  'consultation.cancelRefusal.BOOKING_NOT_MOVED_NO_SHOW': 'This booking was not moved after a no-show, so it cannot be cancelled here. Use the ordinary cancellation.',
  'consultation.cancelRefusal.BOOKING_NOT_CANCELLABLE': 'This booking can no longer be cancelled (it was completed, cancelled or marked a no-show again meanwhile).',
  'consultation.cancelRefusal.INSTANT_CONSULT_COMMAND_REQUIRED': 'An instant consultation is cancelled with its own command, not here.',
  'consultation.cancelRefusal.ADMIN_ONLY': 'Only the Jansetu team can cancel a moved no-show.',
  'consultation.cancelRefusal.BOOKING_NOT_FOUND': 'This booking no longer exists.',
  'consultation.cancelRefusal.ALREADY_CANCELLED': 'This booking is already cancelled: nothing more was done.',
  'consultation.cancelRefusal.USE_CLINIC_CANCEL': 'This is a clinic front-desk appointment, paid at the clinic: cancel it from that clinic’s front desk (as its owner), not here.',

  /** Refusals of verifying or unverifying a doctor. */
  'doctor.stateRefusal.SPECIALIST_CHANGED_SINCE_REVIEW': 'The doctor’s name or registration number changed since you read them, so nothing was changed.',
  'doctor.stateRefusal.SPECIALIST_NOT_FOUND': 'This doctor no longer exists.',
  /** "sync-indexes" is the name of a server task: keep it as written. */
  'doctor.stateRefusal.INDEXES_OUTDATED': 'The database needs an update (sync-indexes) before doctors can be verified: ask the Jansetu team.',

  /** Refusals of an admin "close and refund" of a consultation. */
  'close.refusal.BOOKING_NOT_FOUND': 'This booking no longer exists.',
  'close.refusal.NOT_A_CONSULTATION': 'Only a consultation or a second opinion is closed here.',
  'close.refusal.USE_INSTANT_ADMIN_CANCEL': 'An instant consultation is cancelled with its own admin cancel, not here.',
  'close.refusal.ALREADY_CANCELLED': 'This booking is already cancelled, so nothing more was done.',
  'close.refusal.BOOKING_NOT_CANCELLABLE': 'This booking can no longer be closed: it was completed or marked a no-show meanwhile.',
  /** “Cancel (admin)” is the name of a button. */
  'close.refusal.NO_SHOW_NOT_REFUNDABLE': 'This booking was moved after a no-show: use “Cancel (admin)” in its no-show section instead.',
  'close.refusal.BOOKING_CHANGED': 'The booking changed since you read it, so nothing was done. It is shown as it is now: review it and close it again if it is still needed.',
  'close.refusal.REQUEST_KEY_REUSED': 'This request was already used for another close. Start again.',
  /** "sync-indexes" is the name of a server task: keep it as written. */
  'close.refusal.INDEXES_OUTDATED': 'The database needs an update (sync-indexes) before bookings can be closed here: ask the Jansetu team.',
  'close.refusal.FORBIDDEN': 'Only the Jansetu team can close a booking.',
  'close.unconfirmed': 'The server’s answer did not confirm the close.',
  'close.refund.none': 'Nothing was refunded: no money was held for it through Jansetu.',
  /** {amount} is money, e.g. ₹500.00. */
  'close.refund.pharmacyCard': '{amount} is being refunded to the card or UPI the pharmacy paid with.',
  'close.refund.pharmacyWallet': '{amount} was refunded to the pharmacy that booked it.',
  'close.refund.patient': '{amount} was refunded to the patient’s Jansetu wallet.',

  /** Under the field of a pharmacy account (admin create and edit). */
  'pharmacy.form.nameRemoved': 'The name cannot be removed. Enter the new name.',
  'pharmacy.form.name': 'Enter the pharmacy’s name.',
  'pharmacy.form.phoneRemoved': 'The mobile number cannot be removed: the pharmacy signs in with it. Enter the new number.',
  'pharmacy.form.phone': 'Enter the 10-digit mobile number.',
  'pharmacy.form.email': 'Enter a valid email address.',
  'pharmacy.form.pincode': 'Enter the 6-digit PIN code.',

  /** The admin adds money to a wallet by hand. */
  'topup.form.amount': 'Enter a whole number of rupees, 1 or more (for example 500).',
  'topup.form.amountMax': 'At most ₹2,00,000 at one time.',
  'topup.form.note': 'Write why the money is added, for example “stage testing” or “support credit”.',
  'topup.answerUnreadable': 'The answer about this top-up could not be read.',
  'topup.notFound.partial': 'Only the latest {searched} movements were searched; the credit may be older. Ask the tech team before adding money again.',
  'topup.notFound.resend': 'Not added so far. It may still be on its way. Sending the same request again is safe: the money is never added twice.',
  'topup.notFound.exact': 'Not found so far. It may still be on its way. Look at the history again in a minute before adding money again.',
  'topup.notFound.history': 'Not found in the wallet history so far. It may still be on its way. Look at the history again in a minute before adding money again.',
  'topup.refusal.PHARMACY_NOT_FOUND': 'This pharmacy was not found. Nothing was added.',
  'topup.refusal.PHARMACY_ID_REQUIRED': 'Choose a pharmacy first. Nothing was added.',
  'topup.refusal.IDEMPOTENCY_KEY_REUSED': 'This request was already used with a different amount or note, so nothing more was added. Look at the history below before adding money again.',
  'topup.refusal.IDEMPOTENCY_KEY_REQUIRED': 'The request was not sent correctly, so nothing was added. Reload the page and try again.',
  'topup.refusal.VALIDATION_ERROR': 'Check the amount (a whole number of rupees, 1 or more) and the note. Nothing was added.',
  'topup.refusal.forbidden': 'Only Jansetu admins can add money to a pharmacy wallet.',
  'topup.read.notFound': 'This pharmacy was not found.',
  'topup.read.notReadable': 'This is not a pharmacy that can be read. Choose it from the list.',
  'topup.read.forbidden': 'Only Jansetu admins can see pharmacy wallets.',
  /** On the wallet credit form and its review; one per wallet owner. */
  'topup.warning.pharmacy': 'Do not use this to make up for a card top-up that never arrived. Ask the tech team to run the top-up check instead, or the pharmacy could be paid twice.',
  'topup.warning.lab': 'Do not use this to make up for a card top-up that never arrived. Ask the tech team to run the top-up check instead, or the lab could be paid twice.',
  'topup.warning.doctor': 'Do not use this to make up for a card top-up that never arrived. Ask the tech team to run the top-up check instead, or the doctor could be paid twice.',

  /** A card top-up that support already paid by hand is closed (never credited). One per wallet owner. */
  'compensated.reason.pharmacy': 'Write why this top-up is closed, for example who paid the pharmacy and how.',
  'compensated.reason.lab': 'Write why this top-up is closed, for example who paid the lab and how.',
  'compensated.reason.doctor': 'Write why this top-up is closed, for example who paid the doctor and how.',
  'compensated.explain.pharmacy': 'Use this only when Jansetu support already paid this amount to the pharmacy another way. The top-up can then never be credited.',
  'compensated.explain.lab': 'Use this only when Jansetu support already paid this amount to the lab another way. The top-up can then never be credited.',
  'compensated.explain.doctor': 'Use this only when Jansetu support already paid this amount to the doctor another way. The top-up can then never be credited.',
  'compensated.refusal.TOPUP_ALREADY_CREDITED': 'This top-up was already credited, nothing to close.',
  'compensated.refusal.TOPUP_REFUNDED': 'This top-up was already refunded to the card, nothing to close.',
  'compensated.refusal.TOPUP_BLOCKED': 'This top-up was already blocked after a lost card dispute. It is never credited, so there is nothing to close.',
  'compensated.refusal.IDEMPOTENCY_KEY_REUSED': 'This request was already used for another top-up or another reason, so nothing was changed. Read the list again, then try again.',
  'compensated.refusal.PAYMENT_AMBIGUOUS': 'More than one top-up carries this payment id, so nothing was changed. Ask the tech team.',
  'compensated.refusal.TOPUP_NOT_FOUND': 'This top-up was not found (it is not a pharmacy card top-up). Nothing was changed.',
  'compensated.refusal.INDEXES_OUTDATED': 'The server needs an update before top-ups can be closed. Nothing was changed. Please ask the Jansetu team.',
  'compensated.refusal.WALLET_CHANGED': 'This top-up changed while it was being closed. Read the list again, then try again.',
  'compensated.refusal.VALIDATION_ERROR': 'Write a reason of 1 to {max} characters. Nothing was changed.',
  'compensated.refusal.switchedOff': 'The admin tools are switched off on this server, so top-ups cannot be closed here. Nothing was changed.',
  'compensated.refusal.forbidden': 'Only Jansetu admins can close a top-up.',

  /** What a referral cut applies to. */
  'referral.category.consultation': 'Consultation',
  'referral.category.lab_test': 'Lab test',
  'referral.category.lab_package': 'Lab package',
  'referral.problem.percent': 'Enter a percentage from 0.01 to 50, with at most two decimals.',
  'referral.problem.fixed': 'Enter the amount per line in rupees, at least ₹0.01, with at most two decimals.',
  'referral.problem.cap': 'Enter the cap per line in rupees, at least ₹0.01, or leave it empty.',
  /** A cut that is switched off (or none set). */
  'referral.off': 'Off',
  /** What a cut takes; a "line" is one item of a booking. {amount} is money, e.g. ₹50.00. */
  'referral.terms.fixed': '{amount} a line',
  /** {percent} is a number such as 2.5. */
  'referral.terms.percent': '{percent}% of each line',
  /** {cap} is money, e.g. ₹100.00. */
  'referral.terms.percentCapped': '{percent}% of each line, at most {cap} a line',
  /** A capped percent cut whose percentage is not known ("—" stands for it). */
  'referral.terms.capOnly': '—, at most {cap} a line',
  'referral.refusal.RECORD_CHANGED': 'This cut was changed by someone else meanwhile, so nothing was saved.',
  'referral.refusal.BOOKER_NOT_FOUND': 'This partner was not found, so nothing was saved.',
  'referral.refusal.ASSISTED_BOOKING_DISABLED': 'Changing referral cuts is switched off on the server (assisted-booking admin tools), so nothing was saved.',
  /** "sync-indexes" is the name of a server task: keep it as written. */
  'referral.refusal.INDEXES_OUTDATED': 'The database needs an update (sync-indexes) before referral cuts can be saved: ask the Jansetu team.',
} as const;
