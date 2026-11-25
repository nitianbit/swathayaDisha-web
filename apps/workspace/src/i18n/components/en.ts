/**
 * Words of the shared workspace components used by several areas (`apps/workspace/src/components`): the two-step
 * confirmation, the panel for a request whose outcome is not known, the no-show move and the order cancel request.
 * A comment above a key is the translator's note.
 */
export default {
  // ── ConfirmAction: a two-step confirmation ──
  /** Shown next to the button when the record changed while its confirmation was open. */
  'confirm.changedWhileOpen': 'This changed while the confirmation was open, so nothing was done. Check what is shown now and try again.',
  /** A step's refusal shown next to its button: {step} is the step's button words, {message} the refusal. */
  'confirm.stepNote': '{step}: {message}',
  'confirm.reasonTooShort': 'Give a reason (at least 3 characters).',
  /** A field label marked optional: {label} is the field's name (e.g. "Note"). */
  'confirm.optional': '{label} (optional)',

  // ── PendingOpPanel: a request whose outcome is not known ──
  /** Before the sentence about a request being sent again. */
  'pending.sending': 'Sending…',
  'pending.unknown': 'The outcome of this request is not known yet. It may already be recorded. Sending the same request again is safe: it is never recorded twice. If it keeps being refused, ask an admin.',
  /** {error} is the reason the last send failed. */
  'pending.unknownWithError': 'The outcome of this request is not known yet ({error}). It may already be recorded. Sending the same request again is safe: it is never recorded twice. If it keeps being refused, ask an admin.',
  'pending.restored': 'A request made earlier on this device (before the page was reloaded, or before you signed out) has not been confirmed yet. Its details are not kept, so it cannot be sent again from here. Check whether it was recorded before making it again.',
  'pending.resend': 'Send the same request again',
  'pending.check': 'Check whether it was recorded',
  /** Button: give up a request whose outcome is not known, so a new one can be made. */
  'pending.abandon': 'Cancel it and start again',
  'pending.recordedNotShown': 'It was recorded, but its record could not be shown. Reload the page.',
  /** {reason} is why the request could not be given up. */
  'pending.abandonFailed': 'Could not cancel it: {reason}',
  /** {reason} is why the records could not be read. */
  'pending.checkFailed': 'Could not check the records: {reason}',
  'pending.restoredNotFound.cancelFirst': 'Not found in the records. It may still be on its way. To make the request again, first cancel this one: once cancelled it can never be recorded.',
  'pending.restoredNotFound.unknown': 'Not found in the records. It may still be on its way, or it was never recorded: this cannot be told apart from here.',
  'pending.notFound.giveUp': 'Not recorded so far, but it may still be finishing. Send the same request again (it is never recorded twice), or give it up: the server then makes sure it can never be recorded.',
  'pending.notFound.resend': 'Not found in the recent records. That does not prove it was not recorded: it may still be finishing. Send the same request again; if it was not recorded it will be now, and if it was you get its record.',

  // ── NoShowMove: the one move of a missed consultation to a new time ──
  /** Button and form name. */
  'noShow.reschedule': 'Reschedule no-show',
  'noShow.used': 'Already moved once after a no-show: a second no-show is final.',
  'noShow.chooseTime': 'Choose the new time.',
  /** {time} is the new date and time. */
  'noShow.moveTo': 'Move to {time}',
  /** {who} is the patient's name, {missed} the missed date and time, {time} the new one, {consequence} what happens to money and earnings. */
  'noShow.confirm': 'Move {who}’s missed time ({missed}) to {time}? It is booked again at the same price: nothing is paid or refunded. {consequence} This can be done only once: if the new time is missed too, that no-show is final.',
  'noShow.moved': '{who}’s no-show is moved to {time}. It is booked again at the same price.',
  'noShow.replayed': '{who}’s no-show had already been moved to {time}: nothing was moved twice.',
  'noShow.movedLater': '{who}’s no-show has been moved to a new time (it can be moved only once). Nothing more to do.',
  'noShow.alreadyMoved': 'This booking was already moved once after a no-show. A second no-show is final, so it cannot be moved again.',
  /** {reason} is why the move was refused. */
  'noShow.notMoved': 'Not moved: {reason}',
  /** Name of the panel shown while a move's outcome is not known. */
  'noShow.unconfirmed.label': 'Unconfirmed no-show move',
  'noShow.unconfirmed': 'The move of {who}’s no-show to {time} has not been confirmed. Sending the same move again is safe: a booking is moved only once.',
  /** {error} is the reason the last send failed. */
  'noShow.unconfirmedWithError': 'The move of {who}’s no-show to {time} has not been confirmed ({error}). Sending the same move again is safe: a booking is moved only once.',
  'noShow.restored': 'A move of {who}’s no-show was sent from this device before the page was reloaded, and its answer never arrived. Its details are not kept here. Check the booking: once it is no longer a no-show, the move happened.',
  'noShow.resend': 'Send the same move again',
  'noShow.check': 'Check the booking',
  'noShow.chooseAgain': 'Choose a new time again',
  'noShow.chooseAgain.confirm': 'Forget it and choose again',
  'noShow.chooseAgain.consequence': 'The booking is still a no-show. A new time is sent as a new move. If the earlier move still arrives, it moves the booking and the new move is refused (a no-show is moved only once), so nothing can be moved twice.',
  /** {error} is why the last send was refused. */
  'noShow.chooseAgain.consequenceRefused': 'The booking is still a no-show and the last send was refused ({error}). A new time is sent as a new move. If the earlier move still arrives, it moves the booking and the new move is refused (a no-show is moved only once), so nothing can be moved twice.',

  // ── CancelRequestPanel: a customer's or admin's request to cancel a paid medicine order ──
  'cancelRequest.title': 'Cancellation requested',
  /** {date} is when it was requested. */
  'cancelRequest.by.customer': 'Requested by the customer on {date}. Until it is decided the order cannot move.',
  'cancelRequest.by.admin': 'Requested by an admin on {date}. Until it is decided the order cannot move.',
  /** Seen by the selling pharmacy about its own request. */
  'cancelRequest.by.yourPharmacy': 'Requested by your pharmacy on {date}. Until it is decided the order cannot move.',
  'cancelRequest.by.pharmacy': 'Requested by the pharmacy on {date}. Until it is decided the order cannot move.',
  /** {reason} is the reason as typed by the person who asked. */
  'cancelRequest.byWithReason.customer': 'Requested by the customer on {date}: “{reason}”. Until it is decided the order cannot move.',
  'cancelRequest.byWithReason.admin': 'Requested by an admin on {date}: “{reason}”. Until it is decided the order cannot move.',
  'cancelRequest.byWithReason.yourPharmacy': 'Requested by your pharmacy on {date}: “{reason}”. Until it is decided the order cannot move.',
  'cancelRequest.byWithReason.pharmacy': 'Requested by the pharmacy on {date}: “{reason}”. Until it is decided the order cannot move.',
  'cancelRequest.refund.returned': 'The payment was already returned to the customer.',
  'cancelRequest.refund.authorized': 'The payment is still being confirmed; decide in a few minutes.',
  'cancelRequest.refund.offline': 'The refund is not automatic for a cash or counter payment: an admin arranges it.',
  'cancelRequest.refund.online': 'What the customer paid online goes back to their Jansetu wallet first (they can ask for it on their card/UPI). If the payment cannot be matched to its record, an admin reviews the refund.',
  'cancelRequest.approve': 'Approve cancellation',
  'cancelRequest.approve.confirm': 'Yes, cancel the order',
  'cancelRequest.approve.consequence': 'The order is cancelled and its stock goes back to the pharmacy’s inventory.',
  'cancelRequest.keep': 'Keep the order',
  'cancelRequest.keep.confirm': 'Yes, keep it',
  'cancelRequest.keep.reason': 'Why it is kept (shown to the customer)',
  /** {status} is the order's status before the request (e.g. "Packed"). */
  'cancelRequest.keep.consequence': 'The request is declined and the order continues from “{status}”.',
  'cancelRequest.returned': 'The payment was already returned, so the order cannot continue: approve to complete the cancellation.',
} as const;
