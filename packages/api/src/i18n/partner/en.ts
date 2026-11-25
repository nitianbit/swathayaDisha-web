/**
 * Partner workspace words from `@jansetu/api` (docs/I18N_PLAN.md §3.2): members, branches and permissions
 * (`partners.ts`), bills and payments (`partnerInvoices.ts`), clinic doctors and the clinic front desk (`clinic.ts`).
 * A comment above a key is the translator's note.
 */
export default {
  /** A permission a partner owner gives a staff member (a tick box). */
  'permission.staff.manage': 'Manage staff',
  'permission.branches.manage': 'Manage branches',
  'permission.catalogue.manage': 'Manage tests and services',
  /** A slot is a bookable time at a lab or clinic. */
  'permission.slots.manage': 'Manage slots',
  'permission.bookings.view': 'View bookings',
  'permission.bookings.manage': 'Manage bookings',
  /** Lab test reports. */
  'permission.reports.upload': 'Upload reports',
  'permission.reports.release': 'Release reports',
  /** Bills the partner gives its patients. */
  'permission.invoices.create': 'Create invoices',
  'permission.invoices.cancel': 'Cancel invoices',
  'permission.payments.record': 'Record payments',
  'permission.finance.view': 'View finance',
  /** The partner's Jansetu wallet. */
  'permission.wallet.view': 'View the wallet',
  'permission.wallet.manage': 'Add money to the wallet',
  'permission.assisted.book': 'Book doctor consultations for patients',

  /** The kind of partner business. */
  'kind.lab': 'Lab',
  'kind.clinic': 'Clinic',

  /** Whether Jansetu has checked the partner. */
  'verification.pending': 'Waiting for verification',
  'verification.verified': 'Verified',
  'verification.suspended': 'Suspended',

  /** The partner's GST (goods and services tax) registration. */
  'taxRegime.regular': 'GST regular',
  'taxRegime.composition': 'GST composition',
  'taxRegime.unregistered': 'Not GST-registered',

  /** What a member is registered as (they sign lab reports under it). */
  'professional.pathologist': 'Pathologist',
  'professional.doctor': 'Doctor',
  'professional.pharmacist': 'Pharmacist',
  'professional.problem.kind': 'Choose what they are registered as.',
  'professional.problem.registration': 'Enter the registration number ({min} to {max} characters).',

  'weekday.mon': 'Monday',
  'weekday.tue': 'Tuesday',
  'weekday.wed': 'Wednesday',
  'weekday.thu': 'Thursday',
  'weekday.fri': 'Friday',
  'weekday.sat': 'Saturday',
  'weekday.sun': 'Sunday',

  'member.ownerEmailAdminOnly': 'An owner’s sign-in email is set or changed by the Jansetu team only. Ask Jansetu support.',
  'member.invalidBranchIds': 'One of the chosen branches is closed or no longer exists, so nothing was saved. Untick it and save again.',
  'member.emailInUse': 'Another member of this workspace already signs in with this email. Use a different email.',
  /** Shown instead of "Remove" on a clinic doctor's staff row. */
  'member.removal.doctor': 'A doctor of this clinic: removed on the Doctors page (owner only).',
  'member.removal.self': 'You cannot remove yourself.',
  'member.removal.ownerOnly': 'Only an owner can remove an owner.',
  'member.removal.lastOwner': 'The last owner cannot be removed.',

  /** Giving a member access to branches. */
  'scope.closedBranch': 'A closed branch cannot be given. Untick the branches marked “(closed)”.',
  'scope.chooseOwn': 'Choose at least one of your branches.',
  'scope.ownOnly': 'You can only give access to your own branches.',

  /** The kind of bill, as printed on it. */
  'document.tax_invoice': 'Tax invoice',
  'document.bill_of_supply': 'Bill of supply',
  'document.commercial_invoice': 'Invoice (no GST)',

  /** A bill's state. */
  'invoice.state.issued': 'Unpaid',
  'invoice.state.partly_paid': 'Partly paid',
  'invoice.state.paid': 'Paid',
  'invoice.state.cancelled': 'Cancelled',

  /** How a bill was paid at the counter. */
  'payment.mode.cash': 'Cash',
  'payment.mode.upi': 'UPI',
  'payment.mode.card': 'Card',
  'payment.mode.bank': 'Bank transfer',
  'payment.mode.other': 'Other',
  'payment.problem.none': 'Add how the bill was paid.',
  'payment.problem.tooManyMethods': 'At most {max} methods in one payment.',
  'payment.problem.amount': 'Enter each amount in rupees, more than ₹0.',
  'payment.problem.reference': 'Use at most {max} characters for a reference.',
  /** {due}: an amount of money. */
  'payment.problem.overDue': 'That is more than is due ({due}). A bill is never paid more than what is due.',
  /** {due}: an amount of money. */
  'payment.problem.fullOnly': 'Only full payment is taken here: the amounts must add up to {due}.',

  'tax.problem.unregistered': 'This partner is not GST-registered: every line must have GST rate 0',
  'tax.problem.billOfSupply': 'A bill of supply cannot charge GST: every line must have GST rate 0',
  /** {gstState} and {branchState}: two-digit GST state codes. */
  'tax.problem.registration': 'The partner\'s GST registration (state {gstState}) does not cover this branch (state {branchState}); this branch cannot issue GST bills yet',
  'bill.problem.lineTooLarge': 'This line is larger than a single bill can be',
  'bill.problem.discount': 'A line discount cannot exceed the line amount',
  'bill.problem.billTooLarge': 'This bill is larger than a single bill can be',
  /** GSTIN: the GST registration number. */
  'gstin.problem': 'Enter a valid 15-character GSTIN.',

  /** An invitation for a doctor to join a clinic. */
  'clinic.invite.pending': 'Waiting for the doctor',
  'clinic.invite.accepted': 'Accepted',
  'clinic.invite.declined': 'Declined by the doctor',
  'clinic.invite.revoked': 'Revoked',
  'clinic.link.problem.doctor': 'Choose the doctor.',
  'clinic.link.problem.tooManyBranches': 'Choose at most {max} branches.',
  'clinic.link.problem.branches': 'Choose branches of this clinic that take in-clinic consultations.',
  'clinic.link.refusal.DOCTOR_NOT_FOUND': 'This doctor was not found.',
  'clinic.link.refusal.DOCTOR_NOT_ELIGIBLE': 'Only active, verified doctors can be linked to a clinic.',
  'clinic.link.refusal.DOCTOR_PHONE_REQUIRED': 'This doctor has no mobile number on their profile (it is their clinic sign-in). Add one first.',
  'clinic.link.refusal.DOCTOR_ALREADY_MEMBER': 'This doctor already consults at this clinic.',
  'clinic.link.refusal.PHONE_USED_BY_ANOTHER_DOCTOR': 'This doctor’s mobile number belongs to another doctor at this clinic.',
  'clinic.link.refusal.DOCTOR_LINK_ADMIN_ONLY': 'Doctors are linked to clinics by the Jansetu team after checking. Ask them to add this doctor.',

  /** A clinic appointment's state at the front desk. */
  'clinic.status.pending': 'Waiting for payment',
  'clinic.status.confirmed': 'Booked',
  /** The doctor saw the patient. */
  'clinic.status.completed': 'Seen',
  'clinic.status.cancelled': 'Cancelled',
  'clinic.status.no_show': 'Did not come',

  'clinic.family.problem.name': 'Enter the family member’s name.',
  'clinic.family.problem.relation': 'Choose how they are related to the account holder.',
  'clinic.family.problem.gender': 'Choose a gender, or leave it empty.',
  'clinic.family.problem.dateOfBirth': 'Enter a real date that is not in the future.',
  'clinic.desk.problem.phone': 'Enter the patient’s mobile number.',
  'clinic.desk.problem.mobile': 'Enter a ten-digit mobile number.',
  'clinic.range.problem.dates': 'Enter real dates.',
  'clinic.range.problem.order': 'The end date is before the start date.',
  'clinic.range.problem.tooLong': 'At most {max} days at a time.',
  /** Why a front-desk step is not offered yet. */
  'clinic.desk.blocked.seen': 'A visit can be marked as seen from the day of the appointment.',
  'clinic.desk.blocked.noShowSession': 'In a session with several patients, a no-show can be marked 15 minutes after the session ends.',
  'clinic.desk.blocked.noShow': 'A no-show can be marked 15 minutes after the appointment time.',
} as const;
