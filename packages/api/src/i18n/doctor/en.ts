/**
 * Doctor words of `@jansetu/api` (docs/I18N_PLAN.md §3.2): `doctorTools.ts` (schedule, Consult now, appointments,
 * clinics, earnings and payout details) and `noShows.ts` (moving a missed appointment). A comment above a key is the
 * translator's note.
 */
export default {
  /** How a consultation happens. */
  'consultMode.video': 'Video',
  'consultMode.call': 'Phone call',
  'consultMode.chat': 'Chat',
  'consultMode.inPerson': 'In person',

  /** Weekly schedule: the length of one slot. */
  'schedule.minutes': 'Enter whole minutes from {min} to {max}.',
  /** Weekly schedule: a "window" is one stretch of working time in a day. */
  'schedule.tooManyWindows': 'At most {max} windows a day.',
  'schedule.times': 'Enter every start and end time (HH:MM).',
  'schedule.modesRequired': 'Choose at least one consultation type for every window.',
  'schedule.clinicInPerson': 'Clinic windows are for in-person consultations only.',
  'schedule.clinicBranch': 'One window is at a clinic branch you do not consult at (or whose clinic is not verified). Choose another place.',
  /** {start} and {end} are times such as 09:00. */
  'schedule.endBeforeStart': '{start}–{end}: a window must end after it starts.',
  /** {start} and {end} are times such as 09:00; {minutes} is the slot length. */
  'schedule.tooShort': '{start}–{end} is shorter than one {minutes}-minute slot.',
  /** Two working windows of one day that overlap; each start and end is a time such as 09:00. */
  'schedule.overlap': '{start1}–{end1} and {start2}–{end2} overlap.',

  'modes.required': 'Choose at least one consultation type.',
  'modes.once': 'Choose each consultation type once.',
  /** Consult now: the doctor's own fee for an instant consultation. */
  'presence.fee': 'Enter a fee from ₹0 to ₹10,00,000 (up to two decimals).',

  /** Consult now: why taking a patient's request was refused. */
  'instant.refusal.OFFER_EXPIRED': 'This offer has expired.',
  'instant.refusal.OFFER_NO_LONGER_AVAILABLE': 'Another doctor accepted it first, or the patient withdrew or was refunded.',
  'instant.refusal.INSTANT_REQUEST_NOT_FOUND': 'This offer is no longer open to you.',
  'instant.refusal.DOCTOR_NOT_AVAILABLE': 'You are not available now for this consultation type: switch “Available now” on with this type, then accept.',
  'instant.refusal.SPECIALIZATION_MISMATCH': 'This request is for another speciality than the one on your profile.',
  'instant.refusal.COUPON_NOT_FOR_DOCTOR': 'The patient used a coupon for other doctors, so you cannot take this request.',
  'instant.refusal.FEE_ABOVE_QUOTE': 'Your instant fee is above what this patient paid. Lower your fee to take requests like this one.',
  'instant.refusal.OFFER_NO_LONGER_AFFORDABLE': 'What this patient paid no longer covers your fee once their coupon is worked out again, so you cannot take this request. It stays open for other doctors.',
  'instant.refusal.DOCTOR_BUSY': 'You already have a consultation at this time.',
  'instant.refusal.SPECIALIST_NOT_ACTIVE': 'Your doctor account is not active or not verified, so you cannot take instant consultations. Contact Jansetu.',
  'instant.refusal.BOOKING_NOT_FOUND': 'This consultation is not one of yours, or it is no longer running.',
  'instant.refusal.RESERVATION_NOT_ACTIVE': 'This consultation is no longer held (it was completed or cancelled).',
  /** Making a running consultation longer. */
  'instant.refusal.INVALID_MINUTES': 'Extend by 1 to {max} minutes.',
  'instant.refusal.INVALID_FEE': 'Enter a valid fee.',

  /** An appointment's state. */
  'appointment.status.pending': 'Waiting',
  'appointment.status.confirmed': 'Confirmed',
  'appointment.status.completed': 'Completed',
  'appointment.status.cancelled': 'Cancelled',
  'appointment.status.no_show': 'No-show',
  'appointment.refusal.NOT_STARTED_YET': 'This appointment has not started yet. Mark it completed once its time has come.',
  'appointment.refusal.APPOINTMENT_NOT_STARTED': 'It is too early to mark this appointment a no-show: wait until 15 minutes after its time (in a session with several patients, 15 minutes after the session ends).',
  'appointment.refusal.BOOKING_NOT_PAID': 'This appointment is not paid yet, so it cannot be completed.',

  /** Shown for a clinic without a name, before " · <branch name>". */
  'clinic.unnamed': 'Clinic',
  'clinic.email': 'Enter a valid email address, or leave it empty.',
  'practice.name': 'Enter 2 to 120 characters.',
  'practice.legalName': 'At most 160 characters.',
  /** The short letters that start each bill number. */
  'practice.invoicePrefix': '1 to 6 letters or digits, e.g. DRK.',
  'practice.gstin': 'A GSTIN looks like 29ABCDE1234F1Z5.',
  'practice.pan': 'A PAN looks like ABCDE1234F.',
  'practice.phone': 'Enter the 10-digit number.',
  /** Under an empty address field that must be filled. */
  'practice.required': 'Required.',

  /** Kinds of line on the doctor's earnings statement. */
  'ledger.earning': 'Earning',
  'ledger.reversal': 'Reversal',
  'ledger.payout': 'Payout',
  'ledger.adjustment': 'Adjustment',
  /** A statement period: "from" and "to" are the two date fields. */
  'period.from': 'Enter a real “from” date.',
  'period.to': 'Enter a real “to” date.',
  'period.order': 'The “from” date must not be after the “to” date.',
  'payout.atMost120': 'At most 120 characters.',
  'payout.accountName': 'Enter the account holder’s name.',
  'payout.accountNumber': 'Enter 9 to 18 digits.',
  'payout.ifsc': 'An IFSC looks like ABCD0123456.',
  'payout.upi': 'A UPI ID looks like name@bank.',

  /** Moving an appointment the patient missed (a "no-show") to a later time: why the move was refused. */
  'noShow.refusal.NO_SHOW_RESCHEDULE_USED': 'This booking was already moved once after a no-show. A second no-show is final, so it cannot be moved again.',
  'noShow.refusal.BOOKING_NOT_NO_SHOW': 'This booking is no longer a no-show, so there is nothing to move.',
  'noShow.refusal.SAME_SLOT': 'That is the time that was missed. Pick a later time.',
  'noShow.refusal.SLOT_STARTED': 'That time has already started. Pick a later time.',
  'noShow.refusal.SLOT_NOT_AVAILABLE': 'That time is no longer free. Pick another time.',
  'noShow.refusal.SLOT_NOT_THIS_DOCTOR': 'That time belongs to another doctor. Pick one of this doctor’s times.',
  'noShow.refusal.IDEMPOTENCY_KEY_REUSED': 'This request was already used for a different time. Reload the page and start again.',
  'noShow.refusal.CLINIC_APPOINTMENT': 'The clinic can move this appointment: it was booked at its front desk.',
  'noShow.refusal.SLOT_MODE_NOT_OFFERED': 'That time is not offered for this consultation type. Pick another time.',
} as const;
