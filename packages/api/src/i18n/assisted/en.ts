/**
 * Assisted booking words of `@jansetu/api` (docs/I18N_PLAN.md §3.2): a pharmacy, lab desk or doctor books for a walk-in
 * patient (consultations, Consult now, lab tests, card payments and refunds, the wallet). A comment above a key is the
 * translator's note.
 */
export default {
  'mode.video': 'Video call',
  'mode.call': 'Phone call',
  /** The patient goes to the doctor's clinic. */
  'mode.in-person': 'At the clinic',
  'mode.chat': 'Chat',

  /** A language the patient may ask the doctor to speak (a list to pick from). */
  'language.hi': 'Hindi',
  'language.en': 'English',
  'language.bn': 'Bengali',
  'language.mr': 'Marathi',
  'language.te': 'Telugu',
  'language.ta': 'Tamil',
  'language.gu': 'Gujarati',
  'language.kn': 'Kannada',
  'language.ml': 'Malayalam',
  'language.or': 'Odia',
  'language.pa': 'Punjabi',
  'language.as': 'Assamese',
  'language.lus': 'Mizo',
  'language.mni': 'Manipuri',
  'language.kha': 'Khasi',
  'language.grt': 'Garo',
  'language.ne': 'Nepali',
  'language.brx': 'Bodo',
  'language.trp': 'Kokborok',

  /** Status of a consultation booked for a patient. */
  'status.pending': 'Waiting',
  'status.confirmed': 'Booked',
  'status.completed': 'Done',
  'status.cancelled': 'Cancelled',
  'status.no_show': 'Patient did not come',

  /** One line of the pharmacy wallet's history. */
  'movement.booking_debit': 'Paid for a consultation booking',
  'movement.refund_credit': 'Refund of a cancelled booking',
  'movement.chargeback': 'Taken back after a card dispute',
  'movement.receivable_setoff': 'Used to clear money owed to Jansetu',
  'movement.opening_balance': 'Opening balance',
  'movement.adjustment': 'Correction by Jansetu',
  'movement.withdrawal_hold': 'Withdrawal requested',
  'movement.withdrawal_release': 'Withdrawal cancelled: money back',
  'movement.withdrawal_void': 'Withdrawal bounced: money back',
  'movement.consultation_payment': 'Paid for a consultation',
  'movement.refund': 'Refund',
  'movement.debit': 'Money taken out',
  'movement.topup': 'Top-up (card / UPI)',
  'movement.adminCredit': 'Money added by Jansetu',
  'movement.credit': 'Money added',

  /** Shown next to "Change time". {mode} is one of reschedule.mode.* ("It stays a video call."). */
  'reschedule.rule': 'You can move this consultation to another free time of the same doctor, any time before it starts. The price stays the same: nothing more is taken from your wallet and nothing is refunded. It stays a {mode}. The patient and the doctor are told the new time.',
  /** Fills {mode} in reschedule.rule. */
  'reschedule.mode.in-person': 'visit at the clinic',
  /** Fills {mode} in reschedule.rule. */
  'reschedule.mode.call': 'phone call',
  /** Fills {mode} in reschedule.rule. */
  'reschedule.mode.video': 'video call',

  /** Under a text field: the text is too long. */
  'field.tooLong': 'Use at most {max} characters.',
  'patient.nameEmpty': 'Type the patient’s name.',
  'patient.familyNameEmpty': 'Type the family member’s name.',
  'patient.phoneInvalid': 'Enter a valid 10-digit mobile number.',
  'patient.phoneAgain': 'Type the same number again. This number is new to Jansetu, so it is checked twice.',
  'patient.chooseFamily': 'Choose the family member.',
  'patient.relation': 'Choose how they are related to the phone’s owner.',
  'patient.dateOfBirth': 'Enter a real date of birth (not in the future), or leave it empty.',

  /** How the patient joins the consultation. */
  'join.inPerson': 'The patient goes to the doctor’s clinic at the booked time.',
  'join.callHere': 'The doctor phones this pharmacy’s number at the booked time. Keep the patient with you.',
  'join.callPatient': 'The doctor phones the patient’s number at the booked time.',
  'join.videoHere': 'Open “Booked consultations” on this device. A “Join call” button appears 10 minutes before the time.',
  'join.videoPatient': 'The patient signs in to the Jansetu app on their phone with this number and taps Join.',

  'switchedOff': 'Booking for patients is not switched on yet.',

  /** Fills {wait} in "Try again {wait}." */
  'wait.later': 'later',
  /** Fills {wait} in "Try again {wait}." */
  'wait.minute': 'in a minute',
  /** Fills {wait} in "Try again {wait}." ({n} is 2 or more). */
  'wait.minutes': 'in about {n} minutes',
  /** Fills {wait} in "Try again {wait}." */
  'wait.hours': 'in about {n} hours',
  /** {wait} is one of wait.* ("later", "in a minute" …). */
  'limit.lookups': 'You have looked up many patients this hour. Try again {wait}.',
  'limit.new_accounts': 'Your pharmacy has added the most new patients allowed today. Try again tomorrow, or book for a patient already on Jansetu.',
  'limit.bookings_per_phone': 'This phone number already has the most bookings allowed today. Try again tomorrow.',
  'limit.booker_cancellations': 'Your pharmacy cancelled many bookings today, so new bookings are paused until tomorrow. You can still cancel.',
  'limit.pending_card_bookings': 'Too many bookings are waiting for payment. Pay or cancel one of them first.',
  /** {wait} is one of wait.* ("later", "in a minute" …). */
  'limit.tooMany': 'Too many requests. Try again {wait}.',

  'refusal.INSUFFICIENT_BALANCE': 'Your Jansetu wallet does not have enough money for this booking. Top up the wallet, then pay again.',
  'refusal.WALLET_FROZEN': 'Your Jansetu wallet is on hold, so it cannot pay for bookings. Please contact Jansetu support.',
  'refusal.WALLET_RECEIVABLE': 'Your wallet owes money to Jansetu after a disputed card payment, so it cannot pay for bookings. Please contact Jansetu support.',
  'refusal.WALLET_INACTIVE': 'Your Jansetu wallet is switched off. Please contact Jansetu support.',
  'refusal.SLOT_NOT_AVAILABLE': 'This time was just taken. Choose another time.',
  'refusal.SLOT_STARTED': 'This time has already started. Choose a later time.',
  'refusal.DOCTOR_NOT_AVAILABLE': 'This doctor is not taking bookings now. Choose another doctor.',
  'refusal.SPECIALIST_NOT_VERIFIED': 'This doctor is not verified yet. Choose another doctor.',
  'refusal.CONSENT_REQUIRED': 'Tick “Patient agreed to this booking” first.',
  'refusal.DEPENDENT_NOT_FOUND': 'This family member was not found on this phone number. Add them by name instead.',
  'refusal.INVALID_COUPON': 'This coupon code does not work for this booking. Remove it or check the code.',
  'refusal.COUPON_NOT_FOR_ASSISTED': 'This coupon cannot be used on a booking made for a patient. Remove it.',
  'refusal.COUPON_EXHAUSTED': 'This coupon has been fully used. Remove it.',
  'refusal.PAYMENT_METHOD_UNAVAILABLE': 'Card payment is not switched on yet. Pay from your Jansetu wallet.',
  'refusal.NOTHING_TO_PAY': 'There is nothing to pay for this consultation, so it cannot be paid by card. Book it with the wallet: nothing is taken from it.',
  'refusal.IDEMPOTENCY_KEY_REUSED': 'This booking request was already used with other details. Start the booking again.',
  'refusal.REQUEST_ABANDONED': 'This booking was given up earlier, so it was not made. Start the booking again.',
  'refusal.CUSTOMER_LINKING_UNAVAILABLE': 'Booking for patients is not ready on the server yet. Try again later.',
  'refusal.INDEXES_OUTDATED': 'The server needs an update before this can be used. Please ask the Jansetu team.',
  'refusal.PHARMACY_INACTIVE': 'Your pharmacy account is not active. Please contact Jansetu support.',
  'refusal.PHARMACY_NOT_VERIFIED': 'Your pharmacy is not verified yet, so it cannot book for patients.',
  'refusal.PHARMACY_PROFILE_REQUIRED': 'Your pharmacy profile is not complete. Please contact Jansetu support.',
  'refusal.BOOKING_ALREADY_STARTED': 'The consultation has already started, so it can no longer be cancelled.',
  'refusal.BOOKING_NOT_CANCELLABLE': 'This consultation is finished, so it cannot be cancelled.',
  'refusal.NO_SHOW_NOT_REFUNDABLE': 'This consultation was moved after the patient did not come, so it cannot be cancelled for a refund.',
  'refusal.BOOKING_CHANGED': 'This booking changed since you opened it. Look at it again, then try again.',
  'refusal.BOOKING_NOT_FOUND': 'This booking was not found.',
  'refusal.PRESCRIPTION_NOT_READY': 'The doctor has not written the prescription yet.',
  'refusal.PRESCRIPTION_ACCESS_EXPIRED': 'This prescription is more than 90 days old, so it can no longer be used here.',
  'refusal.CUSTOMER_CONSENT_REQUIRED': 'The patient’s agreement is not recorded for your pharmacy, so an order cannot be made from it.',
  'refusal.CUSTOMER_NOT_LINKED': 'This patient is not linked to your pharmacy, so an order cannot be made from it.',
  'refusal.DISPENSING_COPY_UNAVAILABLE': 'The prescription copy could not be made just now. Try again in a minute.',
  'refusal.TOPUP_BLOCKED': 'This top-up was blocked after a card dispute and will not be added. Please contact Jansetu support.',
  'refusal.PAYMENT_FAILED': 'This payment failed. No money was added. You can start a new top-up.',
  'refusal.PAYMENT_REFUNDED': 'This payment was refunded to your card or UPI. No money was added.',
  'refusal.PAYMENT_RECORD_NOT_FOUND': 'This top-up was not found.',
  'refusal.PAYMENT_SERVICE_UNAVAILABLE': 'Card and UPI payments are not available right now. Try again later.',
  'refusal.RAZORPAY_NOT_CONFIGURED': 'Card and UPI payments are not set up on this server yet.',
  /** {price} is an amount of money ("₹500"). */
  'refusal.priceChangedTo': 'The price has changed. It is now {price}. Check it with the patient, then pay again.',
  'refusal.priceChanged': 'The price has changed. Choose the doctor again to see the new price.',
  'refusal.forbidden': 'Your account is not allowed to do this.',

  'reschedule.SLOT_NOT_AVAILABLE': 'This time was just taken, or is no longer free. Choose another time.',
  'reschedule.SAME_SLOT': 'The consultation is already at this time. Choose another time.',
  'reschedule.SLOT_NOT_THIS_DOCTOR': 'This time belongs to another doctor. Choose one of this doctor’s times.',
  'reschedule.DOCTOR_BUSY': 'The doctor is not free at that time. Choose another time.',
  'reschedule.DOCTOR_NOT_AVAILABLE': 'This doctor is not taking bookings now, so the time cannot be changed. You can cancel instead.',
  'reschedule.BOOKING_CHANGED': 'This booking changed since you opened it (perhaps on another device). Look at it again, then choose the time again.',
  'reschedule.BOOKING_ALREADY_STARTED': 'Too late: the consultation has already started, so its time can no longer be changed.',
  'reschedule.BOOKING_NOT_RESCHEDULABLE': 'This consultation is cancelled or finished, so its time can no longer be changed.',
  'reschedule.INSTANT_CONSULT_COMMAND_REQUIRED': 'A “Consult now” consultation has no booked time, so it cannot be moved.',
  'reschedule.CLINIC_APPOINTMENT': 'This is a clinic appointment. Ask the clinic to change it.',
  'reschedule.IDEMPOTENCY_KEY_REUSED': 'This change was already sent with another time. Look at the booking again, then choose the time again.',

  'typedName.notLinked': 'This patient is not linked to your pharmacy, so the name cannot be changed here.',
  'typedName.length': 'Type a name of 1 to {max} characters.',

  'rxOrder.none': 'Choose at least one medicine from your stock.',
  'rxOrder.qty': 'Enter how many units of each chosen medicine (a whole number).',

  'card.blocked': 'Your pharmacy account is not active or not verified, so the payment cannot be checked here. If you paid, Jansetu checks it with Razorpay: the booking is confirmed, or the money goes back to the card or UPI.',
  'card.duplicate': 'This booking was already paid with another payment. This payment is being refunded to the card or UPI.',
  'card.failed': 'This payment failed, so the booking is not paid. If the time is released, book again.',
  'card.disputed': 'A card dispute was recorded on this booking payment. Please contact Jansetu support.',
  'card.changed': 'The payment changed while it was checked. Check again.',
  'card.razorpayDown': 'Razorpay could not be asked just now. Check again in a minute.',
  'card.notFound': 'This payment was not found for your pharmacy.',
  'card.unreadable': 'The answer about this payment could not be read.',
  /** {time} is a 24-hour India time ("14:35"). */
  'card.payBy': 'Pay before {time} or the time is released.',
  'card.payWithin': 'Pay within 30 minutes of booking or the time is released.',
  'card.heldNotStarted': 'The booking is held, but its card payment could not be started. Send the same request again to get the payment page.',
  'card.lateBack': 'If a payment arrives later, it goes back to the card.',
  'card.lateCapture': 'The payment came after the booking could no longer take it (the time was released, it was cancelled, or the doctor is not available). The amount is being refunded to the card or UPI it was paid with. Nothing is booked: book again if the patient still wants it.',

  /** {amount} is money ("₹500"). */
  'refund.walletDone': '{amount} is back in your Jansetu wallet. This money pays for bookings; it cannot be withdrawn.',
  'refund.walletPending': '{amount} is being returned to your Jansetu wallet.',
  'refund.processed': '{amount} was refunded to the card or UPI it was paid with.',
  'refund.pending': 'Refund of {amount} to the card or UPI: in progress. It usually reaches the card in 5 to 7 working days.',
  'refund.failed': 'The refund of {amount} to the card or UPI did not go through. Jansetu will contact you to return it another way.',
  'refund.manual_review': 'The refund of {amount} is held for a check by Jansetu. Jansetu will contact you.',
  /** {state} is a code from the server, shown as it is. */
  'refund.other': 'Refund of {amount}: {state}.',

  'cancel.told': 'The patient and the doctor are told.',
  'cancel.already': 'It was already cancelled. Nothing was refunded twice.',
  /** {told} is who hears of it ("The patient and the doctor are told."). */
  'cancel.wallet': 'Cancelled. {amount} is back in your Jansetu wallet. {told}',
  /** {later} is card.lateBack. */
  'cancel.unpaid': 'Cancelled. It was not paid, so nothing is refunded. {later}',
  /** {refund} is one of refund.*; {told} is who hears of it. */
  'cancel.card': 'Cancelled. {refund} {told}',

  /** State of a card refund (admin list). */
  'refundState.pending': 'Refund to card in progress',
  'refundState.processed': 'Refunded',
  'refundState.failed': 'Refund to card failed',
  'refundState.manual_review': 'Held for a check',
  /** Why a card refund was made (admin list). */
  'refundCause.booker': 'Cancelled by the pharmacy',
  'refundCause.patient': 'Cancelled by the patient',
  'refundCause.doctor': 'Cancelled by the doctor',
  'refundCause.admin': 'Cancelled by Jansetu',
  'refundCause.late_capture': 'Paid after the booking was released',
  'refundCause.extra_capture': 'Second payment, refunded',

  'agreement.empty': 'Write what the pharmacy agreed to, and how (for example “Agreed on a call with the owner on 23 Nov”).',
  'refund.unreadable': 'The answer about this refund could not be read.',
  'refund.routeMissing': 'Not available on this server yet. The outcome is not known.',
  'recheck.none': 'Razorpay holds no refund of this payment yet.',
  /** {statuses}: Razorpay's own refund states, as given ("processed, pending"). */
  'recheck.held': { one: 'Razorpay holds {count} refund of this payment ({statuses}).', other: 'Razorpay holds {count} refunds of this payment ({statuses}).' },
  /** {state} is one of refundState.*; {held} is recheck.none or recheck.held. */
  'recheck.words': 'Checked with Razorpay: {state}. {held}',

  'move.REFUND_NOT_FAILED': 'Only a refund that failed or is held for a check can be moved to the wallet. Nothing was changed. Read the list again.',
  'move.CHARGEBACK_RECORDED': 'A card dispute was recorded on this payment: the bank already took the money back. Nothing was moved.',
  'refund.notFound': 'This refund was not found. Nothing was changed.',
  'move.REFUND_CHANGED': 'This refund changed while it was being moved. Read the list again, then try again.',
  'move.REFUND_AT_GATEWAY': 'Razorpay already has a refund of this payment, done or on its way, so nothing was moved. Tap “Recheck” to see it.',
  'move.GATEWAY_LOOKUP_FAILED': 'Razorpay could not be asked about this payment just now. Nothing was moved. Try again in a minute.',
  'move.VALIDATION_ERROR': 'Write the agreement in 1 to {max} characters. Nothing was changed.',
  'move.routeMissing': 'Not available on this server yet. Nothing was changed.',
  'move.switchedOff': 'The admin tools are switched off on this server, so refunds cannot be moved here. Nothing was changed.',
  'move.forbidden': 'Only Jansetu admins can move a refund.',
  'mark.forbidden': 'Only Jansetu admins can change a refund.',
  'mark.REFUND_AT_GATEWAY': 'Razorpay already has a refund of this payment, done or on its way, so it was not marked failed. Tap “Recheck” to see it.',
  'mark.REFUND_BUSY': 'This refund is being worked on right now. Nothing was changed. Try again in a few minutes.',
  'mark.REFUND_NOT_PENDING': 'Only a card refund still in progress can be marked failed. Read the list again.',
  'mark.GATEWAY_LOOKUP_FAILED': 'Razorpay could not be asked about this payment just now. Nothing was changed. Try again in a minute.',
  'mark.VALIDATION_ERROR': 'Write a reason of 1 to {max} characters. Nothing was changed.',
  'recheck.razorpayDown': 'Razorpay could not be asked just now. The outcome is not known: tap “Recheck” again in a minute.',
  'recheck.busy': 'This refund is being worked on right now. Try again in a few minutes.',

  'instant.switchedOff': 'Consult now for patients is not switched on yet.',
  'instant.NO_DOCTOR_ONLINE': 'No doctor of this speciality is online now. Try again in a few minutes, or book a time instead.',
  'instant.DOCTOR_NOT_ONLINE': 'This doctor is not online any more. Choose “Any available doctor” or another doctor.',
  'instant.DOCTOR_REQUIRED': 'Choose a doctor, or “Any available doctor”.',
  'instant.INSTANT_REQUEST_NOT_FOUND': 'This request was not found.',
  'instant.REQUEST_NOT_OPEN': 'This request is no longer waiting for a doctor. It is shown as it is now.',
  'instant.REQUEST_NOT_REFUNDABLE': 'A doctor has already accepted, so it can no longer be refunded here. Cancel the booking instead.',
  'instant.INSTANT_REQUEST_CHANGED': 'The request changed meanwhile (a doctor may have accepted). It is shown as it is now.',
  'instant.PAYMENT_METHOD_UNAVAILABLE': 'Consult now can only be paid from the Jansetu wallet.',

  'lab.switchedOff': 'Booking lab tests for patients is not switched on yet.',
  'lab.LAB_NOT_FOUND': 'This lab is not taking bookings now. Choose another lab.',
  'lab.BRANCH_NOT_AVAILABLE': 'This branch is not taking bookings now. Choose another branch or lab.',
  'lab.VISIT_MODE_NOT_SUPPORTED': 'This branch does not offer this kind of visit. Choose another branch or visit.',
  'lab.CATALOGUE_ITEM_NOT_AVAILABLE': 'One of the chosen tests is no longer offered here. Choose the tests again.',
  'lab.ADDRESS_REQUIRED': 'Enter the address for the home collection.',
  'lab.LAB_BOOKING_NOT_FOUND': 'This lab booking was not found.',
  'lab.LAB_BOOKING_NOT_CANCELLABLE': 'This lab booking can no longer be cancelled (the sample is taken or the test is done).',
  'lab.CANCELLATION_WINDOW_CLOSED': 'Too late to cancel: lab bookings can be cancelled up to 1 hour before the time.',
  'lab.NO_SHOW_NOT_REFUNDABLE': 'This booking was moved after the patient did not come, so it cannot be cancelled for a refund.',
  'lab.NO_PENDING_RESCHEDULE': 'There is no new time to accept any more. Look at the booking again.',
  'lab.RESCHEDULE_CHANGED': 'The lab changed the time again. Look at the new time, then accept it or cancel.',
  /** Shown to a doctor whose account is not verified and active yet. */
  'lab.doctorClosed': 'Booking lab tests for your patients opens once Jansetu has verified your account and it is active.',
  'lab.doctor.BOOKING_NOT_FOUND': 'This consultation was not found among yours. Book for the patient by their mobile number instead.',
  'lab.doctor.TREATING_WINDOW_CLOSED': 'This consultation is not open for booking tests now (it is open while you treat the patient). Book for the patient by their mobile number instead.',
  'lab.doctor.PAYMENT_METHOD_UNAVAILABLE': 'Lab tests you book are paid from your Jansetu wallet.',

  /** The recommended-tests code printed on a prescription. */
  'recommendation.invalid': 'This code is not valid. Check it on the prescription.',
  'recommendation.notFound': 'No recommended tests were found for this code and this mobile number. Check both with the patient.',
} as const;
