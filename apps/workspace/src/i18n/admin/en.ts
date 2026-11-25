/**
 * The admin screens' words (`screens/admin/**`, docs/I18N_PLAN.md round 6j). A comment above a key is the translator's
 * note. Names, notes, codes and money are never words here: they come in as `{placeholders}`.
 */
export default {
  // ---- Words several admin screens share.
  /** Table column: a person's or a business's name. */
  'common.name': 'Name',
  /** Table column. */
  'common.status': 'Status',
  /** Table column: when the account was created. */
  'common.added': 'Added',
  /** Table column. */
  'common.type': 'Type',
  /** Table column: money. */
  'common.amount': 'Amount',
  /** Table column holding one button. */
  'common.action': 'Action',
  /** Table column holding buttons. */
  'common.actions': 'Actions',
  /** Shown for an account saved without a name. */
  'common.noName': 'No name',
  /** Accessible name of a group of list filters. */
  'common.filters': 'Filters',
  /** Button of a search form. */
  'common.search': 'Search',
  /** Label of the search box of a list. */
  'common.searchByName': 'Search by name',
  /** Under "No … match" in a list. */
  'common.changeSearch': 'Change the search or filters.',
  /** Accessible name of the previous / next page bar. */
  'common.pages': 'Pages',
  'common.previous': 'Previous',
  'common.next': 'Next',
  /** Between Previous and Next. */
  'common.pageOf': 'Page {page} of {lastPage}',
  /** Filter label and option: whether an account is active. */
  'common.active': 'Active',
  'common.inactive': 'Inactive',
  /** First option of the Active filter: no filter. */
  'common.activeOrNot': 'Active or not',
  /** Filter label: whether an account is verified. */
  'common.verification': 'Verification',
  /** First option of the Verification filter: no filter. */
  'common.verifiedOrNot': 'Verified or not',
  'common.verified': 'Verified',
  'common.notVerified': 'Not verified',
  /** Link back to a list. */
  'common.backToPharmacies': 'Back to pharmacies',
  'common.backToDoctors': 'Back to doctors',
  'common.backToPartners': 'Back to labs and clinics',
  /** Button: verify an account. */
  'common.verify': 'Verify',
  /** The confirming button; {name} is the account's name. */
  'common.verifyNamed': 'Verify {name}',
  'common.cancel': 'Cancel',
  'common.back': 'Back',
  /** {reason}: why it was refused, a whole sentence. */
  'common.notChanged': 'Not changed: {reason}',

  // ---- Pharmacy and doctor accounts.
  // Doctors (list) and one doctor (DoctorsScreen, DoctorScreen).
  'doctors.title': 'Doctors',
  'doctors.intro': 'Doctor accounts: verify a doctor, or take a verification away.',
  'doctors.loading': 'Loading doctors…',
  'doctors.noneMatch': 'No doctors match',
  'doctors.noneYet': 'No doctors yet',
  'doctors.noneYetHint': 'Doctors who sign up appear here.',
  'doctors.count': { one: '{count} doctor', other: '{count} doctors' },
  /** Caption of the doctors table, read by screen readers. */
  'doctors.caption': 'Doctors, newest first',
  /** Page title of one doctor without a name, and the "no such" page's title. */
  'doctor.title': 'Doctor',
  'doctor.noSuch': 'No such doctor',
  'doctor.openFromList': 'Open it from the doctor list.',
  'doctor.loading': 'Loading doctor…',
  /** Link to the doctor's wallet. */
  'doctor.wallet': 'Wallet',
  /** Followed by two links: Waiting · Confirmed. */
  'doctor.consultationsLead': 'Consultations with this doctor:',
  /** Link: the doctor's consultations waiting for confirmation. */
  'doctor.waiting': 'Waiting',
  /** Link: the doctor's confirmed consultations. */
  'doctor.confirmed': 'Confirmed',
  'doctor.cannotAttend': '(this doctor cannot attend them: open one to close it with a full refund)',
  'doctor.speciality': 'Speciality',
  'doctor.registrationNumber': 'Registration number',
  'doctor.degree': 'Degree',
  /** The doctor's or pharmacy's sign-in mobile number and email. */
  'doctor.signsInWith': 'Signs in with',
  /** Section heading. */
  'doctor.verification': 'Verification',
  'doctor.inactive': 'This doctor is inactive: patients cannot book them even when verified. Making a doctor active again is not done here.',
  'doctor.noNameToVerify': 'No name is on record, so this doctor cannot be verified until they add one.',
  'doctor.done.verifiedActive': '{name} is verified. Patients can now find and book them.',
  'doctor.done.verifiedInactive': '{name} is verified. They are inactive, so patients still cannot book them.',
  'doctor.done.unverified': '{name} is no longer verified: patients cannot find or book them, and they cannot take consultations or prescribe.',
  /** {reason}: why the server refused, a whole sentence. */
  'doctor.fenceRefused': '{name} was not verified: {reason} The doctor was read again: review what is saved now before verifying.',
  /** Heading of the panel about a change whose answer was lost. */
  'doctor.unconfirmed': 'Unconfirmed change',
  'doctor.check.restoredVerified': 'Read again: {name} is verified now. The earlier change is not kept on this device, so whether it went through cannot be told. If this is not what you wanted, forget it and make the change again.',
  'doctor.check.restoredNotVerified': 'Read again: {name} is not verified now. The earlier change is not kept on this device, so whether it went through cannot be told. If this is not what you wanted, forget it and make the change again.',
  'doctor.check.notYetVerified': 'Not changed so far: {name} is verified now. It may still be on its way. Sending the same request again is safe.',
  'doctor.check.notYetNotVerified': 'Not changed so far: {name} is not verified now. It may still be on its way. Sending the same request again is safe.',
  'doctor.resend': 'Send the same request again',
  'doctor.forget': 'Forget it',
  'doctor.forgetConfirm': 'Yes, forget it',
  'doctor.forgetConsequence': 'The change may already have gone through, or may still go through. Forgetting it does not undo that. The status shown is what is saved now.',
  'doctor.restored': 'A verification change made earlier on this device (before the page was reloaded) was not confirmed. Its details are not kept here. Check the doctor’s status.',
  'doctor.unknown.verify': 'The outcome of this request is not known yet: verify {name}. Sending the same request again is safe.',
  /** {error}: the error seen, as given. */
  'doctor.unknown.verifyError': 'The outcome of this request is not known yet ({error}): verify {name}. Sending the same request again is safe.',
  'doctor.unknown.unverify': 'The outcome of this request is not known yet: take {name}’s verification away. Sending the same request again is safe.',
  'doctor.unknown.unverifyError': 'The outcome of this request is not known yet ({error}): take {name}’s verification away. Sending the same request again is safe.',
  /** Accessible name of the list comparing what was reviewed with what is saved now. */
  'doctor.mismatch.label': 'What changed',
  /** {name} and {number} are shown in bold. */
  'doctor.mismatch.reviewed': 'You reviewed: name {name}, registration number {number}.',
  /** Shown in bold when nothing was on record. */
  'doctor.mismatch.none': '(none)',
  'doctor.mismatch.saved': 'Saved now: name {name}, registration number {number}.',
  'doctor.mismatch.savedVerified': 'Saved now: name {name}, registration number {number} (and the doctor is verified now).',
  'doctor.mismatch.unread': 'The doctor could not be read again: use Try again below or reload the page before verifying.',
  /** {name} is shown in bold. */
  'doctor.verify.lead': 'Verify {name} with exactly what you reviewed:',
  /** {name} is shown in bold. */
  'doctor.verify.name': 'Name: {name}',
  /** {number} is shown in bold. */
  'doctor.verify.number': 'Registration number: {number}',
  'doctor.verify.noneOnRecord': 'none on record',
  'doctor.verify.noNumber': 'No medical registration number is on record for this doctor.',
  'doctor.verify.thenActive': 'Patients can then find and book them; they can open times, take consultations and prescribe.',
  'doctor.verify.thenInactive': 'They are inactive, so patients still cannot book them until they are active.',
  'doctor.verify.locked': 'After verification only the Jansetu team can change their name, registration number, speciality, degree, mobile number and email. If the name or registration number changes before you confirm, nothing is verified.',
  /** Button: take a doctor's verification away. */
  'doctor.unverify.label': 'Unverify',
  'doctor.unverify.confirm': 'Unverify {name}',
  /** {name} is shown in bold. */
  'doctor.unverify.consequence': '{name} is no longer verified: patients cannot find or book them, and they cannot open times, take consultations or prescribe. They no longer see their patients’ contact details.',
  'doctor.unverify.bookings': 'Their bookings stay as they are. Close each open one with a full refund from its consultation page (linked below).',

  // Pharmacies (list), one pharmacy, adding one, and their form fields.
  'pharmacies.title': 'Pharmacies',
  'pharmacies.intro': 'Pharmacy accounts: add a pharmacy, verify it, and change its details or how it signs in.',
  /** Link to the new-pharmacy page, and that page's title. */
  'pharmacies.add': 'Add a pharmacy',
  'pharmacies.loading': 'Loading pharmacies…',
  'pharmacies.noneMatch': 'No pharmacies match',
  'pharmacies.noneYet': 'No pharmacies yet',
  'pharmacies.noneYetHint': 'Pharmacies you add appear here.',
  'pharmacies.count': { one: '{count} pharmacy', other: '{count} pharmacies' },
  /** Table column: the owner's name. */
  'pharmacies.owner': 'Owner',
  'pharmacies.city': 'City',
  'pharmacies.findByPhone': 'Find by mobile number',
  'pharmacies.find': 'Find',
  'pharmacies.enterPhone': 'Enter the 10-digit mobile number.',
  'pharmacies.finding': 'Finding the pharmacy…',
  /** {pharmacy} is a link with the pharmacy's name. */
  'pharmacies.foundByPhone': '{pharmacy} signs in with {phone}.',
  'pharmacies.noneByPhone': 'No pharmacy signs in with {phone}.',
  'pharmacy.title': 'Pharmacy',
  'pharmacy.noSuch': 'No such pharmacy',
  'pharmacy.openFromList': 'Open it from the pharmacy list.',
  'pharmacy.loading': 'Loading pharmacy…',
  'pharmacy.walletLink': 'Wallet and adding money',
  'pharmacy.referralCutsLink': 'Referral cuts',
  /** The pharmacy's fields, lower case, listed inside a sentence about details someone else changed meanwhile. */
  'pharmacy.field.name': 'name',
  'pharmacy.field.nickname': 'short name',
  'pharmacy.field.ownerName': 'owner’s name',
  'pharmacy.field.address': 'address',
  'pharmacy.field.city': 'city',
  'pharmacy.field.state': 'state',
  'pharmacy.field.pincode': 'PIN code',
  'pharmacy.field.gstNumber': 'GST number',
  'pharmacy.field.drugLicenseNumber': 'drug licence number',
  'pharmacy.field.pickupAvailable': 'pickup',
  'pharmacy.field.deliveryAvailable': 'delivery',
  'pharmacy.changedMeanwhile': '{name} was changed by someone else meanwhile, so nothing was changed. Check what is shown now and try again.',
  /** {reason}: the error, a whole sentence. */
  'pharmacy.notConfirmedStatus': 'Not confirmed: {reason} The status shown is what is saved now; try again if it is still needed.',
  /** When the pharmacy was archived. */
  'pharmacy.archived': 'Archived',
  'pharmacy.pharmacist': 'Pharmacist',
  'pharmacy.noPharmacist': 'Not added yet (the pharmacy adds it in its settings)',
  'pharmacy.verify.consequence': '{name} is marked verified: customers can find it and order from it.',
  'pharmacy.verify.consequenceInactive': '{name} is marked verified: customers can find it and order from it once it is active again.',
  'pharmacy.verify.done': '{name} is verified.',
  'pharmacy.deactivate.label': 'Deactivate',
  'pharmacy.deactivate.confirm': 'Deactivate {name}',
  'pharmacy.deactivate.consequence': '{name} can no longer sign in, and customers no longer see it. Its orders and stock stay as they are. You can activate it again.',
  'pharmacy.deactivate.done': '{name} was deactivated: it can no longer sign in, and customers no longer see it.',
  'pharmacy.archivedNote': '{name} is archived: it cannot sign in and customers do not see it. An archived pharmacy cannot be activated here; the tech team restores it if it should come back.',
  'pharmacy.activate.label': 'Activate',
  'pharmacy.activate.confirm': 'Activate {name}',
  'pharmacy.activate.consequenceVerified': '{name} can sign in again, and customers see it again.',
  'pharmacy.activate.consequence': '{name} can sign in again. Customers see it once it is verified.',
  'pharmacy.activate.doneVerified': '{name} is active again: it can sign in, and customers see it.',
  'pharmacy.activate.done': '{name} is active again: it can sign in.',
  'pharmacy.nothingChanged': 'Nothing has changed.',
  /** Section heading: how the pharmacy signs in. */
  'pharmacy.signIn.title': 'Sign-in',
  'pharmacy.mobileNumber': 'Mobile number',
  'pharmacy.email': 'Email',
  /** No sign-in email. */
  'pharmacy.noEmail': 'None',
  'pharmacy.signIn.change': 'Change mobile number or email',
  'pharmacy.signIn.intro': 'The pharmacy signs in with these. Change them only when the pharmacy asks and you have checked it is them.',
  'pharmacy.signIn.continue': 'Continue',
  /** Accessible name of the confirmation, and what it does. */
  'pharmacy.signIn.confirmLabel': 'Change how the pharmacy signs in',
  'pharmacy.signIn.newPhone': 'From now on {name} signs in with mobile number {phone}; {oldPhone} no longer works for signing in.',
  'pharmacy.signIn.newEmail': 'Its sign-in email changes from {oldEmail} to {email}; the old one no longer works.',
  'pharmacy.signIn.addedEmail': 'It can also sign in with {email}.',
  'pharmacy.signIn.removedEmail': 'Its sign-in email {email} is removed: it signs in with its mobile number only.',
  /** Shown in bold at the start of pharmacy.signIn.signsOutWhere. */
  'pharmacy.signIn.signsOut': 'This signs {name} out',
  /** {signsOut}: pharmacy.signIn.signsOut, in bold. */
  'pharmacy.signIn.signsOutWhere': '{signsOut} on every computer and phone where it is signed in now. It signs in again with the new details. An app signed in long ago may stay signed in; to stop all access at once, deactivate the pharmacy.',
  'pharmacy.signIn.staysSignedIn': 'Anyone already signed in stays signed in.',
  'pharmacy.signIn.tell': 'Tell the pharmacy before you change it.',
  /** Button: confirms the new sign-in mobile number or email. */
  'pharmacy.signIn.confirm': 'Change sign-in',
  'pharmacy.signIn.changedMeanwhile': 'Someone else changed how {name} signs in while you were editing, so nothing was changed. The form now shows what is saved; check it again.',
  'pharmacy.signIn.savedBoth': '{name} now signs in with {phone} or {email}.',
  'pharmacy.signIn.savedPhone': '{name} now signs in with {phone} only.',
  'pharmacy.signIn.signedOut': 'It was signed out and signs in again with these.',
  'pharmacy.savingChanged': 'Someone else changed {name} while you were saving, so nothing was changed. The form now shows what is saved; check it again.',
  /** {reason}: the error, a whole sentence. */
  'pharmacy.notConfirmedDetails': 'Not confirmed: {reason} Check the details shown and try again.',
  /** Section heading: the pharmacy's details. */
  'pharmacy.details.title': 'Details',
  'pharmacy.details.intro': 'To remove an optional detail, empty its field and save. The name cannot be removed.',
  'pharmacy.details.saved': 'Saved.',
  'pharmacy.details.save': 'Save details',
  'pharmacy.phoneTaken': 'Another pharmacy already signs in with this mobile number. Use a different number, or find that pharmacy in the list.',
  'pharmacy.emailTaken': 'Another pharmacy already uses this email. Use a different email.',
  'pharmacyFields.phoneHint': 'The pharmacy signs in with this number (a code by SMS).',
  'pharmacyFields.email': 'Email (optional)',
  'pharmacyFields.emailHint': 'It can also sign in with this email (a code by email).',
  'pharmacyFields.name': 'Pharmacy name',
  'pharmacyFields.nickname': 'Short name (optional)',
  'pharmacyFields.ownerName': 'Owner’s name (optional)',
  'pharmacyFields.address': 'Address (optional)',
  'pharmacyFields.city': 'City (optional)',
  'pharmacyFields.state': 'State (optional)',
  'pharmacyFields.pincode': 'PIN code (optional)',
  'pharmacyFields.gstNumber': 'GST number (optional)',
  'pharmacyFields.drugLicenseNumber': 'Drug licence number (optional)',
  /** Followed by two check boxes: pick up, delivery. */
  'pharmacyFields.customersCan': 'Customers can',
  'pharmacyFields.pickup': 'Pick up at the pharmacy',
  'pharmacyFields.delivery': 'Get a delivery',
  'newPharmacy.intro': 'It starts as not verified: customers see it once you verify it. It signs in with its mobile number.',
  'newPharmacy.holderTaken': '{name} already signs in with this mobile number. Use a different number.',
  'newPharmacy.givenUpEarlier': 'This request was given up earlier, so nothing was created with it. Check the form and add the pharmacy again.',
  'newPharmacy.alreadyCreated': 'It had already been created. Find it in the pharmacy list.',
  'newPharmacy.givenUp': 'Given up: nothing was created, and that request can never create a pharmacy. You can change the form and add it again.',
  'newPharmacy.created': '{name} was created',
  'newPharmacy.createdOnce': 'The request whose answer was lost did go through. Nothing was created twice.',
  /** Button: opens the pharmacy's page. */
  'newPharmacy.open': 'Open {name}',
  'newPharmacy.addAnother': 'Add another',
  /** Section heading after a reload, when a creation's answer never arrived. */
  'newPharmacy.restored.title': 'An unconfirmed pharmacy',
  'newPharmacy.restored.checking': 'Checking whether it was created…',
  'newPharmacy.restored.text': 'Before the page reloaded, a pharmacy was being added and its answer never arrived. Nothing has been created with it so far, but the request could still arrive. Give it up so it never can, then add the pharmacy again. Its details are not kept on this device.',
  'newPharmacy.giveUp': 'Give up this create',
  'newPharmacy.checkAgain': 'Check again',
  /** Accessible name of the panel about a creation whose answer was lost. */
  'newPharmacy.unconfirmed.label': 'Unconfirmed pharmacy',
  'newPharmacy.unconfirmed.lead': 'We could not confirm whether {name} was created.',
  /** {error}: the error seen, as given. */
  'newPharmacy.unconfirmed.leadError': 'We could not confirm whether {name} was created ({error}).',
  'newPharmacy.unconfirmed.next': 'Send again to find out: it sends the same request, so it can never create a second pharmacy. Or give it up: then it can never be created, and you can change the form. The form stays locked until one of these is done.',
  'newPharmacy.sendAgain': 'Send again',
  /** The form's submit button. */
  'newPharmacy.submit': 'Add pharmacy',

  // ---- Consultations, close and refund, lab bookings, order and external cancellations.
  // ConsultationsScreen.tsx: the list of consultations
  'consultations.title': 'Consultations',
  'consultations.intro': 'Doctor consultation bookings. Open one to see its no-show history or move a no-show once.',
  /** First option of the Status filter: no filter. */
  'consultations.anyStatus': 'Any status',
  /** Date filter: the first appointment day shown. */
  'consultations.from': 'Appointments from',
  /** Date filter: the last appointment day shown. */
  'consultations.to': 'Appointments to',
  /** The list is filtered by one doctor; {doctor} is the doctor's name in bold. */
  'consultations.doctorFilter': 'Doctor: {doctor}',
  /** Stands in for the doctor's name when it is not known yet. */
  'consultations.chosenDoctor': 'the chosen doctor',
  /** Button: remove the doctor filter. */
  'consultations.allDoctors': 'All doctors',
  'consultations.loading': 'Loading consultations…',
  'consultations.noneMatch': 'No consultations match',
  'consultations.noneYet': 'No consultations yet',
  'consultations.changeFilters': 'Change the filters.',
  'consultations.noneYetHint': 'Consultations booked in the app appear here.',
  'consultations.count': { one: '{count} consultation', other: '{count} consultations' },
  /** Under a consultation's status in the list. */
  'consultations.movedAfterNoShow': 'Moved after a no-show',
  /** How the consultation was booked (before its mode, "Instant · Video"). */
  'consultations.kind.instant': 'Instant',
  'consultations.kind.clinicDesk': 'Clinic front desk',
  'consultations.kind.atClinic': 'At a clinic',
  /** Payment state of a consultation. */
  'consultations.payment.paid': 'Paid',
  'consultations.payment.refunded': 'Refunded',
  'consultations.payment.atClinic': 'At the clinic',
  'consultations.payment.failed': 'Payment failed',
  'consultations.payment.notPaid': 'Not paid',
  /** Label of the box to find a doctor by name. */
  'consultations.doctorName': 'Doctor’s name',
  /** Button. */
  'consultations.findDoctor': 'Find doctor',
  'consultations.findingDoctors': 'Finding doctors…',
  /** {search} is the text typed. */
  'consultations.noDoctorFound': 'No doctor’s name contains “{search}”.',
  /** Accessible name of the list of doctors found. */
  'consultations.doctorsFound': 'Doctors found',
  /** After a doctor's name in the list of doctors found ("Dr Rao · inactive"). */
  'consultations.inactive': 'inactive',

  // ConsultationScreen.tsx: one consultation (list columns and record fields)
  'consultation.field.appointment': 'Appointment',
  'consultation.field.patient': 'Patient',
  'consultation.field.doctor': 'Doctor',
  /** Instant, at a clinic, video… */
  'consultation.field.kind': 'Kind',
  'consultation.field.payment': 'Payment',
  'consultation.back': 'Back to consultations',
  'consultation.title': 'Consultation',
  /** {when} is the appointment's date and time. */
  'consultation.titleOn': 'Consultation on {when}',
  /** Under the title; {doctor} is the doctor's name. */
  'consultation.withDoctor': 'With {doctor}',
  'consultation.noSuch': 'No such consultation',
  'consultation.openFromList': 'Open it from the consultation list.',
  'consultation.loading': 'Loading consultation…',
  /** Section heading. */
  'consultation.booking': 'Booking',
  'consultation.cancellationReason': 'Cancellation reason',
  /** When the booking was made. */
  'consultation.booked': 'Booked',
  /** After the patient's name. */
  'consultation.patient.familyNote': '(a family member of the account holder)',
  'consultation.patient.holderNote': '(the account holder)',
  /** When the patient's name is not known. */
  'consultation.patient.family': 'A family member of the account holder',
  'consultation.patient.holder': 'The account holder',
  /** Section heading. */
  'consultation.noShow': 'No-show',
  'consultation.noShowRules': 'A no-show is not refunded and the doctor earns nothing for it. It may be moved once to a later time at the same price.',
  'consultation.instantNeverMoved': 'An instant consultation is never moved to a new time.',
  'consultation.clinicMoves': 'The clinic moves this appointment: it was booked at its front desk.',
  'consultation.noShowCancel.refunded': 'Cancelled by the Jansetu team after its move: the patient was refunded to their Jansetu wallet.',
  /** {at} is the date and time it was cancelled. */
  'consultation.noShowCancel.refundedAt': 'Cancelled by the Jansetu team after its move ({at}): the patient was refunded to their Jansetu wallet.',
  'consultation.noShowCancel.notRefunded': 'Cancelled by the Jansetu team after its move: not refunded; the payment stays and nobody earns it.',
  /** {at} is the date and time it was cancelled. */
  'consultation.noShowCancel.notRefundedAt': 'Cancelled by the Jansetu team after its move ({at}): not refunded; the payment stays and nobody earns it.',
  /** Who missed the appointment, in the move's sentences ("The patient’s no-show is moved…"). */
  'consultation.move.who': 'The patient',
  /** Shown before moving a no-show. */
  'consultation.move.consequence': 'The patient and the doctor are told the new time. The doctor earns for it only once it is completed.',
  /** No-show history entries. */
  'consultation.history.marked': 'Marked as a no-show',
  /** {when} is the missed appointment's date (and time). */
  'consultation.history.markedMissed': 'Marked as a no-show (missed {when})',
  'consultation.history.moved': 'Moved once to a new time. A second no-show is final.',
  /** {when} is the new appointment's date and time. */
  'consultation.history.movedNow': 'Moved once to a new time (now {when}). A second no-show is final.',
  /** {when} is the appointment's date and time. */
  'consultation.history.markedAt': 'Marked as a no-show ({when})',
  'consultation.history.markedFinal': 'Marked as a no-show ({when}): final, it was already moved once',
  'consultation.history.markedOnly': 'Marked as a no-show.',
  'consultation.history.none': 'This booking has no no-show.',
  /** Accessible name of the no-show history. */
  'consultation.history.label': 'No-show history',
  'consultation.slot.noDoctor': 'This booking names no doctor, so it cannot be moved here.',
  /** Where a free time is, after the time in the list of times. */
  'consultation.slot.ownPlace': 'the doctor’s own place',
  'consultation.slot.online': 'online',
  'consultation.slot.bookedClinic': 'the clinic it was booked at',
  /** Above the times offered for the move; {mode} is the consultation type in small letters (video, in person…). */
  'consultation.slot.timesClinic': 'Times at the clinic it was booked at, as booked.',
  'consultation.slot.timesClinicFor': 'Times for {mode} consultations at the clinic it was booked at, as booked.',
  'consultation.slot.timesOwnPlace': 'Times at the doctor’s own place, as booked.',
  'consultation.slot.timesOwnPlaceFor': 'Times for {mode} consultations at the doctor’s own place, as booked.',
  'consultation.slot.timesOnline': 'Times at no clinic (online), as booked.',
  'consultation.slot.timesOnlineFor': 'Times for {mode} consultations at no clinic (online), as booked.',
  /** Date field. */
  'consultation.slot.newDay': 'New day',
  'consultation.slot.realDate': 'Enter a real date.',
  'consultation.slot.loading': 'Loading the doctor’s free times…',
  /** {doctor} is the doctor's name. */
  'consultation.slot.noneNamed': '{doctor} has no free time that day. Choose another day.',
  'consultation.slot.noneNamedClinic': '{doctor} has no free time that day at a clinic. Choose another day.',
  'consultation.slot.none': 'The doctor has no free time that day. Choose another day.',
  'consultation.slot.noneClinic': 'The doctor has no free time that day at a clinic. Choose another day.',
  /** Label of the list of times. */
  'consultation.slot.newTime': 'New time',
  'consultation.slot.choose': 'Choose a time',
  /** Button and the name of its panel: the Jansetu team cancels a booking moved after a no-show. */
  'consultation.cancel.button': 'Cancel (admin)',
  'consultation.cancel.hint': 'Moved once after a no-show: only the Jansetu team cancels it, for example when the doctor cannot attend.',
  /** {when} is the appointment's date and time. */
  'consultation.cancel.confirm': 'Cancel the patient’s appointment on {when}? Its seat and the doctor’s time are freed at once, and the patient and the doctor are told. This cannot be undone.',
  /** {when} is the appointment's date and time; {doctor} the doctor's name. */
  'consultation.cancel.confirmWithDoctor': 'Cancel the patient’s appointment on {when} with {doctor}? Its seat and the doctor’s time are freed at once, and the patient and the doctor are told. This cannot be undone.',
  'consultation.cancel.reason': 'Reason (the patient sees this)',
  'consultation.cancel.refundQuestion': 'Refund the patient?',
  /** {amount} is the money paid. */
  'consultation.cancel.refundYesAmount': 'Yes: {amount} goes back to the patient’s Jansetu wallet (as when a doctor cancels).',
  'consultation.cancel.refundYes': 'Yes: what the patient paid goes back to the patient’s Jansetu wallet (as when a doctor cancels).',
  'consultation.cancel.refundNo': 'No: the payment stays with Jansetu, as for a no-show, and nobody earns it.',
  /** Button. */
  'consultation.cancel.submit': 'Cancel the appointment',
  /** Button: close the cancel panel. */
  'consultation.cancel.back': 'Back',
  'consultation.cancel.reasonShort': 'Give a reason (at least {min} characters).',
  'consultation.cancel.reasonLong': 'Use at most {max} characters.',
  'consultation.cancel.chooseRefund': 'Choose whether the patient is refunded.',
  /** {amount} is the money refunded. */
  'consultation.cancel.doneRefundedAmount': 'The appointment was cancelled; {amount} is back in the patient’s Jansetu wallet. The patient and the doctor are told.',
  'consultation.cancel.doneRefunded': 'The appointment was cancelled; the payment is back in the patient’s Jansetu wallet. The patient and the doctor are told.',
  'consultation.cancel.doneNotRefunded': 'The appointment was cancelled without a refund: the payment stays with Jansetu and nobody earns it. The patient and the doctor are told.',
  'consultation.cancel.already': 'This appointment was already cancelled: nothing more was done.',
  'consultation.cancel.alreadyRefunded': 'This appointment was already cancelled, with a refund to the patient’s Jansetu wallet: nothing more was done.',
  'consultation.cancel.alreadyNotRefunded': 'This appointment was already cancelled, without a refund: nothing more was done.',
  /** {reason} is why the server refused. */
  'consultation.cancel.notCancelled': 'Not cancelled: {reason}',
  /** {error} is the error met. */
  'consultation.cancel.notConfirmed': 'Not confirmed: {error} The booking is shown as saved now; cancel it again if it still has to be cancelled (it is never cancelled or refunded twice).',

  // BookingClose.tsx: close and refund a consultation whose doctor is not verified and active
  /** Section heading. */
  'bookingClose.title': 'Close and refund',
  /** Button. */
  'bookingClose.button': 'Close and refund',
  'bookingClose.confirmLabel': 'Yes, close and refund',
  'bookingClose.reasonLabel': 'Reason (only the Jansetu team sees it)',
  /** What the patient is told when the Jansetu team closes a consultation. */
  'bookingClose.patientNotice': 'The patient is told “Your consultation was cancelled by Jansetu.”',
  /** {when} is the appointment's date and time; {refund} says what was refunded. */
  'bookingClose.done.checked': 'It was closed: the appointment on {when} is cancelled. {refund}',
  'bookingClose.done.replayed': 'This close was already recorded: the appointment on {when} is cancelled. {refund} Nothing more was changed.',
  'bookingClose.done.sent': 'Closed: the appointment on {when} is cancelled. {refund}',
  'bookingClose.done.resent': 'Closed: the appointment on {when} is cancelled. {refund} It was closed once, even though it was sent more than once.',
  /** {reason} is why it cannot be closed (it is already cancelled). */
  'bookingClose.refused.alreadyCancelled': 'Not closed by this request: {reason} Its cancellation is shown on this page.',
  /** {reason} is why the server refused. */
  'bookingClose.refused.server': 'Not closed: {reason}',
  'bookingClose.refused.cancelledOtherWay': 'Not closed by this request: the booking was cancelled another way (its cancellation is shown on this page). This request refunded nothing.',
  'bookingClose.refused.completed': 'Not closed: the booking is completed now, so it can no longer be closed. This request changed nothing.',
  'bookingClose.refused.noShow': 'Not closed: the booking is a no-show now, so it can no longer be closed. This request changed nothing.',
  'bookingClose.check.wait': 'Not closed so far. It may still be on its way. Check again in a minute before closing it again.',
  'bookingClose.check.resend': 'Not closed so far. It may still be on its way. Sending the same request again is safe: it is closed only once.',
  'bookingClose.doctorStatus': 'Doctor’s status',
  'bookingClose.noDoctor': 'No doctor on this booking',
  'bookingClose.reading': 'Reading…',
  /** Link to the doctor's page. */
  'bookingClose.openDoctor': 'Open the doctor',
  'bookingClose.doctorGone': 'This doctor no longer exists',
  'bookingClose.unreadable': 'Could not be read',
  'bookingClose.offer.doctorGone': 'Its doctor no longer exists: the Jansetu team closes it with a full refund.',
  'bookingClose.offer.ineligible': 'Its doctor is not verified or not active: the Jansetu team closes it with a full refund.',
  /** {when} is the appointment's date and time (in bold). */
  'bookingClose.confirm.question': 'Close the appointment on {when} and refund it in full?',
  /** {when} is the appointment's date and time (in bold); {doctor} the doctor's name. */
  'bookingClose.confirm.questionWithDoctor': 'Close the appointment on {when} with {doctor} and refund it in full?',
  'bookingClose.confirm.atOnce': 'It is cancelled at once, whatever the time: the seat and the doctor’s time are freed. This cannot be undone.',
  'bookingClose.confirm.refund': 'Everything paid through Jansetu goes back in full: to the patient’s Jansetu wallet, or to the pharmacy if a pharmacy booked it.',
  'bookingClose.confirm.reasonHidden': 'Your reason is not shown to them.',
  'bookingClose.eligible': 'Its doctor is verified and active, so it is not closed here. Close and refund is for consultations whose doctor is not verified or not active.',
  'bookingClose.instant': 'An instant consultation is cancelled with its own admin cancel, not here.',
  'bookingClose.movedNoShow': 'This booking was moved after a no-show: use “Cancel (admin)” in its no-show section.',
  'bookingClose.notOpen': 'Only a waiting or confirmed consultation can be closed.',
  'bookingClose.closes.loading': 'Reading how it was closed…',
  'bookingClose.closes.none': 'Cancelled, but not with Close and refund.',
  /** Accessible name of the list of closes. */
  'bookingClose.closes.label': 'Closes by the Jansetu team',
  /**
   * One close: {date} when, {refund} what was refunded, {status} the booking's state before (waiting, confirmed…),
   * {payment} its payment state before, {reason} the admin's internal reason.
   */
  'bookingClose.closes.row': 'Closed by the Jansetu team on {date}: {refund} It was {status}, payment {payment}. Reason (internal): {reason}',
  /** A booking's state before it was closed: waiting for the doctor. */
  'bookingClose.closes.waiting': 'waiting',
  /** A close sent whose answer never arrived. */
  'bookingClose.pending.label': 'Unconfirmed close',
  'bookingClose.pending.resend': 'Send the same request again',
  'bookingClose.pending.forget': 'Forget it',
  'bookingClose.pending.forgetConfirm': 'Yes, forget it',
  'bookingClose.pending.forgetConsequence': 'The booking may already be closed, or may still be closed by this request. Forgetting it does not undo that. Read the booking again before closing it again: a booking already cancelled is never refunded twice.',
  'bookingClose.pending.restored': 'A close made earlier on this device (before the page was reloaded) was not confirmed. Its details are not kept here. Check whether it was recorded.',
  /** {when} is the appointment's date and time. */
  'bookingClose.pending.unknown': 'The outcome of this close is not known yet. The appointment on {when} may already be closed and refunded. Sending the same request again is safe: it is closed only once.',
  /** {error} is the error met; {when} the appointment's date and time. */
  'bookingClose.pending.unknownError': 'The outcome of this close is not known yet ({error}). The appointment on {when} may already be closed and refunded. Sending the same request again is safe: it is closed only once.',

  // AdminLabBookingsScreen.tsx: online lab bookings of every lab
  'labBookings.title': 'Lab bookings',
  'labBookings.intro': 'Online bookings at every partner lab, newest booked first. Open one to act on it as the lab’s owner.',
  /** Filter label and table column. */
  'labBookings.lab': 'Lab',
  'labBookings.allLabs': 'All labs',
  /** {error} says why. */
  'labBookings.labsFailed': 'Lab names could not be loaded: {error}',
  /** First option of the Status filter: every status. */
  'labBookings.allStatuses': 'All',
  'labBookings.loading': 'Loading lab bookings…',
  'labBookings.none': 'No lab bookings',
  'labBookings.noneMatch': 'No booking matches these filters.',
  'labBookings.noneYet': 'Bookings made in the app appear here.',
  'labBookings.count': { one: '{count} booking', other: '{count} bookings' },
  /** {shown} is how many are on the screen. */
  'labBookings.countShowing': { one: '{count} booking · showing the newest {shown}', other: '{count} bookings · showing the newest {shown}' },
  'labBookings.caption': 'Lab bookings of every lab',
  /** Table columns. */
  'labBookings.booked': 'Booked',
  'labBookings.slot': 'Slot',
  'labBookings.patient': 'Patient',
  /** How the sample is taken: at the lab or at home. */
  'labBookings.visit': 'Visit',
  'labBookings.payment': 'Payment',
  /** A lab whose name is not loaded; {id} is the end of its id. */
  'labBookings.unknownLab': 'Lab …{id}',
  /** Badge. */
  'labBookings.newTimeProposed': 'New time proposed',
  /** {error} says why. */
  'labBookings.moreFailed': 'Could not load more bookings: {error}',
  /** Button. */
  'labBookings.showMore': 'Show more',
  /** Button; {left} is how many are not shown yet. */
  'labBookings.showMoreLeft': 'Show more ({left} more)',

  // OrderCancellationsScreen.tsx: paid pharmacy orders waiting for a cancellation decision
  'orderCancellations.title': 'Order cancellations',
  'orderCancellations.intro': 'Paid pharmacy orders the customer or a pharmacy asked to cancel. Nothing moves until someone decides.',
  'orderCancellations.loading': 'Loading cancellation requests…',
  'orderCancellations.none': 'No cancellation requests waiting',
  'orderCancellations.count': { one: '{count} waiting for a decision', other: '{count} waiting for a decision' },
  /** Heading of one order; {order} is its number. */
  'orderCancellations.order': 'Order {order}',
  'orderCancellations.pharmacy': 'Pharmacy',
  'orderCancellations.unknownPharmacy': 'Unknown pharmacy',
  'orderCancellations.customer': 'Customer',
  /** When the order was placed. */
  'orderCancellations.placed': 'Placed',
  /** The order's state before the cancellation was asked. */
  'orderCancellations.was': 'Was',
  'orderCancellations.medicines': 'Medicines',
  /** Stands in for a medicine's name that is not known. */
  'orderCancellations.medicine': 'Medicine',

  // ExternalCancellationsScreen.tsx: lab and doctor bookings whose cancellation at the provider is not confirmed
  'externalCancellations.title': 'External cancellations',
  'externalCancellations.intro': 'Lab and doctor bookings whose cancellation at the provider is not confirmed. No refund is made until it is.',
  /** Accessible name of the two buttons below. */
  'externalCancellations.which': 'Which cancellations',
  'externalCancellations.waitingAdmin': 'Waiting for an admin',
  'externalCancellations.allOpen': 'All open',
  'externalCancellations.loading': 'Loading cancellations…',
  'externalCancellations.noneWaiting': 'Nothing is waiting for an admin',
  'externalCancellations.noneOpen': 'No open cancellations',
  'externalCancellations.countWaiting': { one: '{count} waiting for an admin', other: '{count} waiting for an admin' },
  'externalCancellations.countOpen': { one: '{count} open', other: '{count} open' },
  /** Stands in for the patient's name when it is not known. */
  'externalCancellations.patient': 'Patient',
  /** Cancellation states (badge). */
  'externalCancellations.state.requested': 'Waiting to cancel at the provider',
  'externalCancellations.state.calling': 'Cancelling at the provider now',
  'externalCancellations.state.unknown': 'Provider outcome unknown',
  /** When the cancellation was asked. */
  'externalCancellations.requested': 'Requested',
  /** {at} is the date and time; {by} who asked. */
  'externalCancellations.requestedBy': '{at} by {by}',
  /** {at} is the date and time; {by} who asked; {reason} the reason they gave. */
  'externalCancellations.requestedByReason': '{at} by {by} — “{reason}”',
  /** How many times the provider was called. */
  'externalCancellations.calls': 'Provider calls',
  /** {calls} is how many calls; {at} the date and time of the next. */
  'externalCancellations.callsNext': '{calls}, next {at}',
  'externalCancellations.blockedBy': 'Blocked by',
  'externalCancellations.lastError': 'Last error',
  'externalCancellations.providerBookings': 'Provider bookings',
  'externalCancellations.noneRecorded': 'None recorded',
  /** Badge after a provider booking reference. */
  'externalCancellations.ref.cancelled': 'cancelled',
  'externalCancellations.ref.notConfirmed': 'not confirmed',
  'externalCancellations.changed': 'The provider bookings changed while you were reviewing. Check every booking listed above with the provider again before recording anything.',
  /** Button. */
  'externalCancellations.checked': 'I have checked the updated list',
  'externalCancellations.retrying': 'Still being retried automatically. Act only if the provider has already told you the outcome.',
  /** {provider} is the provider's name. */
  'externalCancellations.checkWith': 'Check with {provider} before recording anything. What you record releases the refund.',
  /** Button. */
  'externalCancellations.confirmsCancelled': 'Provider confirms cancelled…',
  'externalCancellations.recordCancelled': 'Record: cancelled at the provider',
  'externalCancellations.cancelledConsequence': 'You confirm that the provider holds no active booking for this: every booking it had, also any made by a reschedule, is cancelled. The customer is then refunded.',
  /** {refs} is the provider booking references. */
  'externalCancellations.cancelledConsequenceRefs': 'You confirm that the provider holds no active booking for this: every booking it had (including {refs}), also any made by a reschedule, is cancelled. The customer is then refunded.',
  /** Button. */
  'externalCancellations.noBooking': 'No booking at the provider…',
  'externalCancellations.recordAbsent': 'Record: no provider booking exists',
  'externalCancellations.absentConsequence': 'You confirm that the provider holds no booking for this at all. The customer is then refunded.',
  'externalCancellations.absentImpossible': '“No booking at the provider” is not possible while provider booking references exist.',

  // ---- Wallets (pharmacy, lab, doctor), card refunds and refunds needing attention.
  // Shared by the pharmacy, lab and doctor wallet pages (PharmacyWalletsScreen, LabWalletAdminScreen, CardRefunds).
  /** Page title of one wallet; {name} is the pharmacy's, lab's or doctor's name. */
  'adminWallet.titleNamed': 'Wallet: {name}',
  'adminWallet.balance': 'Balance',
  'adminWallet.loadingWallet': 'Loading the wallet…',
  'adminWallet.addMoney': 'Add money',
  'adminWallet.loading': 'Loading…',
  /** Shown instead of the Add money form while the owner or its wallet could not be read. */
  'adminWallet.mustLoad.pharmacy': 'The pharmacy and its wallet must load first.',
  'adminWallet.mustLoad.lab': 'The lab and its wallet must load first.',
  'adminWallet.mustLoad.doctor': 'The doctor and its wallet must load first.',
  /** Accessible name of the newer / older pages of the wallet history. */
  'adminWallet.historyPages': 'Wallet history pages',
  /** Section heading: card payments that were paid but never added to the wallet. */
  'adminWallet.uncredited': 'Card top-ups not credited',
  /** Accessible name of the balance cards. */
  'adminWallet.cards': 'Wallet',
  'adminWallet.noWallet.pharmacy': 'This pharmacy has no wallet yet. It is made when the pharmacy opens its wallet, or when money is added here.',
  'adminWallet.noWallet.lab': 'This lab has no wallet yet. It is made when the lab opens its wallet, or when money is added here.',
  'adminWallet.noWallet.doctor': 'This doctor has no wallet yet. It is made when money is first added, by the doctor or here.',
  'adminWallet.moneyIn': 'Money in the wallet',
  'adminWallet.owed': 'Owed to Jansetu',
  /** Money paid in by card; it cannot be withdrawn yet. */
  'adminWallet.cardMoney': 'Card money (withdrawals coming later)',
  'adminWallet.owing': 'The wallet owes {amount} to Jansetu after a disputed card payment. It cannot pay for bookings. Money added clears this first.',
  'adminWallet.onHold': 'The wallet is on hold, so it cannot pay for bookings. Money can still be added.',
  /** {reason}: the reason an admin typed when putting the wallet on hold. */
  'adminWallet.onHoldReason': 'The wallet is on hold ({reason}), so it cannot pay for bookings. Money can still be added.',
  'adminWallet.off': 'The wallet is switched off.',
  'adminWallet.canPay': 'Can pay for bookings',
  /** First sentence when a request was sent but no answer came back. */
  'adminWallet.unknown': 'The outcome of this request is not known yet.',
  /** The same with the error seen ({error}). */
  'adminWallet.unknownWith': 'The outcome of this request is not known yet ({error}).',
  /** Button: send a request whose answer was lost again (it is done only once). */
  'adminWallet.sendAgain': 'Send the same request again',
  /** Button: stop tracking an unconfirmed request. */
  'adminWallet.forget': 'Forget it',
  'adminWallet.forgetConfirm': 'Yes, forget it',
  'adminWallet.cancel': 'Cancel',
  'adminWallet.back': 'Back',
  /** Table column: when it happened. */
  'adminWallet.col.when': 'When',
  'adminWallet.col.pharmacy': 'Pharmacy',
  'adminWallet.col.state': 'State',
  /** {reason}: what the admin typed, in bold. */
  'adminWallet.reasonIs': 'Reason: {reason}',
  // Add money (an admin credit).
  'adminWallet.add.done': '{amount} was added to the wallet of {name}.',
  'adminWallet.add.doneBalance': '{amount} was added to the wallet of {name}. Balance now: {balance}.',
  'adminWallet.add.once': 'It was added once, even though it was sent more than once.',
  'adminWallet.add.unconfirmed': 'Unconfirmed money added',
  'adminWallet.add.found': 'It was added: {amount} on {date}. Nothing was added twice.',
  'adminWallet.add.acknowledge': 'I understand the money may already have been added to this wallet.',
  'adminWallet.add.forget.pharmacy': 'The money may already have been added, or may still arrive. Forgetting it does not undo it. Check the wallet history, or ask the tech team, before adding money again: otherwise the pharmacy could be paid twice.',
  'adminWallet.add.forget.lab': 'The money may already have been added, or may still arrive. Forgetting it does not undo it. Check the wallet history, or ask the tech team, before adding money again: otherwise the lab could be paid twice.',
  'adminWallet.add.forget.doctor': 'The money may already have been added, or may still arrive. Forgetting it does not undo it. Check the wallet history, or ask the tech team, before adding money again: otherwise the doctor could be paid twice.',
  'adminWallet.add.restored': 'Money added earlier on this device (before the page was reloaded) was not confirmed. Its details are not kept here. Check the wallet history for it.',
  'adminWallet.add.mayBeAdded': '{amount} may already be added to the wallet of {name}. Sending the same request again is safe: it is never added twice.',
  'adminWallet.add.form': 'Add money to the wallet',
  'adminWallet.add.amount': 'Amount to add (₹)',
  'adminWallet.add.amountHint': 'Whole rupees, 1 or more.',
  'adminWallet.add.why': 'Why is the money added?',
  'adminWallet.add.whyHint': 'Required. For example “stage testing” or “support credit”. Kept with the credit.',
  /** {reason}: why the server refused. */
  'adminWallet.add.notAdded': 'Not added: {reason}',
  'adminWallet.add.next': 'Next: check before adding',
  'adminWallet.add.review': 'Add this money',
  'adminWallet.add.question': 'Add {amount} to the wallet of {name}?',
  /** {note}: the note the admin typed, in bold. */
  'adminWallet.add.note': 'Note: {note}',
  'adminWallet.add.readingLast': 'Reading the last money added by an admin…',
  'adminWallet.add.lastByYou': 'Last money added by you: {amount} on {date}. Make sure this is not the same credit.',
  /** {note}: that credit's note as typed. */
  'adminWallet.add.lastByYouNote': 'Last money added by you: {amount} on {date} (“{note}”). Make sure this is not the same credit.',
  'adminWallet.add.lastByAdmin': 'Last money added by an admin: {amount} on {date}. Make sure this is not the same credit.',
  'adminWallet.add.lastByAdminNote': 'Last money added by an admin: {amount} on {date} (“{note}”). Make sure this is not the same credit.',
  'adminWallet.add.lastUnread': 'Could not read the last money added by an admin. Look at the history below.',
  /** {size}: how many of the newest wallet movements were read. */
  'adminWallet.add.noneLatest': 'No money added by an admin in the latest {size} movements.',
  'adminWallet.add.clears.pharmacy': '{amount} of it first clears what the pharmacy owes Jansetu.',
  'adminWallet.add.clears.lab': '{amount} of it first clears what the lab owes Jansetu.',
  'adminWallet.add.clears.doctor': '{amount} of it first clears what the doctor owes Jansetu.',
  'adminWallet.add.balanceAfter': 'Balance after: {amount}',
  'adminWallet.add.confirm': 'Yes, add {amount}',
  // Card top-ups not credited, and "Mark as already paid by hand".
  'adminWallet.uncreditedState.paid_not_credited': 'Paid, not credited',
  'adminWallet.uncreditedState.not_checked_with_gateway': 'Not checked with Razorpay',
  /** A card top-up: {amount} and the {date} it was paid. Used inside other sentences. */
  'adminWallet.topup': '{amount} top-up of {date}',
  /** A card top-up when only its {amount} is known. Used inside other sentences. */
  'adminWallet.topupAmount': '{amount} top-up',
  'adminWallet.close.checked': 'It was closed: the {topup} will never be credited to the wallet.',
  'adminWallet.close.replayed': 'This top-up was already closed as paid by hand: the {topup} will never be credited to the wallet. Nothing more was changed.',
  'adminWallet.close.done': 'Marked as already paid by hand: the {topup} will never be credited to the wallet.',
  'adminWallet.close.once': 'It was closed once, even though it was sent more than once.',
  'adminWallet.close.unconfirmed': 'Unconfirmed close',
  'adminWallet.close.notYetRestored': 'Not closed so far. It may still be on its way. Read the list again in a minute before closing it again.',
  'adminWallet.close.notYet': 'Not closed so far. It may still be on its way. Sending the same request again is safe: it is closed only once.',
  'adminWallet.close.forget': 'The top-up may already be closed, or may still be closed. Forgetting it does not undo that. Read the list again before closing it again: a top-up already closed is never closed twice.',
  'adminWallet.close.restored': 'A top-up marked as already paid by hand earlier on this device (before the page was reloaded) was not confirmed. Its details are not kept here. Check whether it was recorded.',
  'adminWallet.close.mayBeClosed': 'The {topup} may already be closed. Sending the same request again is safe: it is closed only once.',
  'adminWallet.close.notClosed': 'Not closed: {reason}',
  'adminWallet.loadingTopups': 'Loading card top-ups…',
  'adminWallet.close.empty': 'No card top-ups waiting',
  'adminWallet.close.emptyText': 'Card top-ups of {name} that were not credited to the wallet are listed here.',
  'adminWallet.close.caption': 'Card top-ups not credited, oldest first',
  'adminWallet.close.col.reference': 'Payment reference',
  /** {id}: Razorpay's order id. */
  'adminWallet.close.razorpayOrder': 'Razorpay order {id}',
  /** {id}: Jansetu's payment record id. */
  'adminWallet.close.record': 'Record {id}',
  'adminWallet.close.markAria': 'Mark the {topup} as already paid by hand',
  'adminWallet.close.mark': 'Mark as already paid by hand',
  'adminWallet.close.chosen': 'The {topup}.',
  'adminWallet.close.chosenOrder': 'The {topup} (Razorpay order {order}).',
  'adminWallet.close.why': 'Why is it closed?',
  'adminWallet.close.whyHint.pharmacy': 'Required. For example who at Jansetu support paid the pharmacy, how and when.',
  'adminWallet.close.whyHint.lab': 'Required. For example who at Jansetu support paid the lab, how and when.',
  'adminWallet.close.whyHint.doctor': 'Required. For example who at Jansetu support paid the doctor, how and when.',
  'adminWallet.close.next': 'Next: check before closing',
  'adminWallet.close.review': 'Close this top-up',
  'adminWallet.close.question': 'Mark the {topup} of {name} as already paid by hand?',
  'adminWallet.close.confirm': 'Yes, mark as already paid',

  // Pharmacy wallets: the list page and one pharmacy's wallet.
  'pharmacyWallets.title': 'Pharmacy wallets',
  'pharmacyWallets.intro': 'See a pharmacy’s Jansetu wallet and add money to it (for stage testing or a support credit).',
  'pharmacyWallets.cardRefunds': 'Card refunds of bookings that need a person',
  'pharmacyWallets.findByName': 'Find a pharmacy by name',
  'pharmacyWallets.loading': 'Loading pharmacies…',
  'pharmacyWallets.noneMatch': 'No pharmacies match',
  'pharmacyWallets.noneYet': 'No pharmacies yet',
  'pharmacyWallets.tryAnother': 'Try another name.',
  /** "Pharmacies" is the name of the admin page in the side bar. */
  'pharmacyWallets.addUnder': 'Add pharmacies under Pharmacies.',
  'pharmacyWallets.caption': 'Pharmacies',
  'pharmacyWallets.col.city': 'City',
  /** Hidden column heading of the "Open wallet" links. */
  'pharmacyWallets.col.wallet': 'Wallet',
  'pharmacyWallets.openAria': 'Open the wallet of {name}',
  'pharmacyWallets.open': 'Open wallet',
  'pharmacyWallet.title': 'Pharmacy wallet',
  'pharmacyWallet.noSuch': 'No such pharmacy',
  'pharmacyWallet.noSuchText': 'Choose it from the pharmacy wallets list.',
  /** Stands for the pharmacy's name inside sentences until the name is read. */
  'pharmacyWallet.thisPharmacy': 'this pharmacy',
  'pharmacyWallet.history': 'Recent money in and out',
  'pharmacyWallet.loadingHistory': 'Loading the history…',
  'pharmacyWallet.noMovements': 'No money in or out yet',
  'pharmacyWallet.noMovementsText': 'Top-ups, booking payments, refunds and admin credits of {name} are listed here.',
  /** Pager button: the newer page of the history. */
  'pharmacyWallet.newer': 'Newer',
  /** Pager button: the older page of the history. */
  'pharmacyWallet.older': 'Older',

  // A lab's or a doctor's wallet (the same page for both).
  'labWallet.lab': 'Lab',
  'labWallet.noSuchLab': 'No such lab',
  'labWallet.openFromList': 'Open it from the list of labs and clinics.',
  'doctorWallet.doctor': 'Doctor',
  'doctorWallet.noSuchDoctor': 'No such doctor',
  'doctorWallet.openFromList': 'Open it from the doctor list.',
  /** Stands for the lab's name inside sentences until the name is read. */
  'labWallet.thisLab': 'this lab',
  /** Stands for the doctor's name inside sentences until the name is read. */
  'doctorWallet.thisDoctor': 'this doctor',
  /** Link back to the owner's page; {name}: the lab's or doctor's name. */
  'labWallet.backTo': 'Back to {name}',
  'labWallet.backToLab': 'Back to the lab',
  'doctorWallet.backToDoctor': 'Back to the doctor',
  'labWallet.title': 'Lab wallet',
  'doctorWallet.title': 'Doctor wallet',
  'labWallet.historyEmpty': 'Top-ups, admin credits and bookings of {name} are listed here.',
  'labWallet.hold.on': 'The wallet of {name} is on hold: it cannot pay for bookings; money can still be added.',
  'labWallet.hold.released': 'The wallet of {name} is released.',
  /** {message}: why the server refused. */
  'labWallet.hold.notChanged': 'Not changed: {message}',
  /** {message}: the error seen; a sentence follows it. */
  'labWallet.hold.notConfirmed': 'Not confirmed: {message} The hold shown is what is saved now; try again if it is still needed.',
  'labWallet.hold.release': 'Release the hold',
  'labWallet.hold.releaseConfirm': 'Yes, release it',
  'labWallet.hold.releaseWhy': 'Why is the hold released?',
  'labWallet.hold.releaseConsequence': 'The wallet of {name} can pay for bookings again.',
  'labWallet.hold.put': 'Put on hold',
  'labWallet.hold.putConfirm': 'Yes, put it on hold',
  'labWallet.hold.putWhy': 'Why is the wallet put on hold?',
  'labWallet.hold.putConsequence': 'The wallet of {name} cannot pay for bookings until the hold is released. Money can still be added.',
  'labWallet.dispute.lost': 'Card dispute recorded',
  'labWallet.lots.replayed': 'This card dispute was already recorded. Nothing more was changed.',
  'labWallet.lots.recorded': 'Card dispute recorded on the {amount} top-up. No money was taken from the wallet; that money is no longer withdrawable.',
  /** {message}: why the server refused. */
  'labWallet.lots.notRecorded': 'Not recorded: {message}',
  /** {message}: the error seen; a sentence follows it. */
  'labWallet.lots.notConfirmed': 'Not confirmed: {message} The list shows what is saved now; recording it again is safe.',
  'labWallet.lots.title': 'Card top-ups',
  'labWallet.lots.empty': 'No card top-ups yet.',
  'labWallet.lots.caption': 'Card top-ups, newest first',
  /** Table column: when the card top-up was paid. */
  'labWallet.lots.col.paid': 'Paid',
  /** Table column: how much of the top-up is still in the wallet. */
  'labWallet.lots.col.left': 'Left',
  /** Hidden column heading of the "Record a card dispute" buttons. */
  'labWallet.lots.col.dispute': 'Dispute',
  /** A card top-up whose money is all spent. */
  'labWallet.lots.usedUp': 'Used up',
  'labWallet.lots.record': 'Record a card dispute',
  'labWallet.lots.recordWhy': 'What did the bank say?',
  'labWallet.lots.recordConfirm': 'Yes, record it',
  'labWallet.lots.recordConsequence': 'Record that the {amount} card top-up of {date} was disputed and lost? Nothing is taken from the wallet; the money stops being withdrawable. This cannot be undone here.',

  // Card refunds of bookings that need a person (on the pharmacy wallets page). WQ24b: a booking is paid by a pharmacy, a
  // lab or a doctor: {payer} is that word (“pharmacy”, “lab” or “doctor”), {name} the payer’s name.
  'cardRefunds.move.explain': 'Only when the card refund cannot go through and the {payer} agreed to take the money in its Jansetu wallet instead. The money is added to its wallet at once (it cannot be withdrawn), and the card refund is closed.',
  'cardRefunds.mark.explain': 'Only when Razorpay cannot complete this card refund. Jansetu reads Razorpay first and refuses while it holds a refund of this payment. Afterwards the refund can be moved to the {payer}’s wallet, with its agreement.',
  /** A card refund: its {amount} and the {date} it was made. Used inside other sentences. */
  'cardRefunds.refund': '{amount} card refund of {date}',
  /** Stands for the payer's name when the row has none. */
  'cardRefunds.thePayer': 'the {payer}',
  'cardRefunds.move.button': 'Move to wallet',
  'cardRefunds.move.field': 'The {payer}’s agreement',
  'cardRefunds.move.hint': 'Required. Who at the {payer} agreed, how and when. Kept with the refund.',
  'cardRefunds.move.next': 'Next: check before moving',
  'cardRefunds.move.confirm': 'Yes, move to wallet',
  'cardRefunds.move.unconfirmed': 'Unconfirmed move to wallet',
  'cardRefunds.mark.button': 'Mark failed',
  'cardRefunds.mark.field': 'Why is it marked failed?',
  'cardRefunds.mark.hint': 'Required. For example what Razorpay support said. Kept with the refund.',
  'cardRefunds.mark.next': 'Next: check before marking',
  'cardRefunds.mark.confirm': 'Yes, mark failed',
  'cardRefunds.mark.unconfirmed': 'Unconfirmed mark failed',
  'cardRefunds.done.markedChecked': 'It was marked failed: the {refund} of {name}. It can now be moved to the {payer}’s wallet.',
  'cardRefunds.done.marked': 'Marked failed: the {refund} of {name}. It can now be moved to the {payer}’s wallet, with its agreement.',
  'cardRefunds.done.movedChecked': 'It was moved: the {refund} of {name} is in the {payer}’s Jansetu wallet.',
  'cardRefunds.done.alreadyMoved': 'This refund was already moved to the {payer}’s wallet: the {refund} of {name}. Nothing more was changed.',
  'cardRefunds.done.moved': 'Moved to the {payer}’s wallet: the {refund} of {name}.',
  'cardRefunds.done.movedOnce': 'It was moved once, even though it was sent more than once.',
  /** {reason}: why the server refused. */
  'cardRefunds.notDone': 'Not done: {reason}',
  'cardRefunds.writeWhy': 'Write why it is marked failed.',
  'cardRefunds.atMost': 'Use at most {max} characters.',
  /** Before the words of Razorpay's answer to a recheck. */
  'cardRefunds.recheckedOf': '{refund} of {name}.',
  'cardRefunds.unconfirmed': 'Unconfirmed refund change',
  'cardRefunds.check.restored': 'Its details are not kept on this device after a reload. Read the list again to see where the refund is.',
  'cardRefunds.check.notYet': 'Not done so far. It may still be on its way. Sending the same request again is safe: it is done only once.',
  'cardRefunds.forget': 'The change may already be done, or may still be. Forgetting it does not undo that. Read the list again before doing it again: a refund is never moved twice.',
  'cardRefunds.restored': 'A change to a card refund made earlier on this device (before the page was reloaded) was not confirmed. Its details are not kept here.',
  'cardRefunds.mayBe.move': 'The {refund} of {name} may already be in its wallet. Sending the same request again is safe.',
  'cardRefunds.mayBe.mark': 'The {refund} of {name} may already be marked failed. Sending the same request again is safe.',
  'cardRefunds.intro': 'Card and UPI refunds of bookings made for patients (by a pharmacy, a lab or a doctor) that did not go through on their own. One still in progress is listed after 20 failures or a day.',
  'cardRefunds.loading': 'Loading card refunds…',
  'cardRefunds.unavailable': 'Card refunds of bookings are not available on this server yet.',
  'cardRefunds.empty': 'No card refunds need a person',
  'cardRefunds.emptyText': 'Card refunds that fail or get stuck are listed here.',
  'cardRefunds.caption': 'Card refunds that need a person, oldest change first',
  /** Column: who paid for the booking (a pharmacy, a lab or a doctor). */
  'cardRefunds.col.paidBy': 'Paid by',
  'cardRefunds.col.why': 'Why',
  'cardRefunds.col.booking': 'Booking',
  'cardRefunds.chargeback': 'A card dispute was recorded: never refunded',
  /** How many times the card refund failed. */
  'cardRefunds.failures': { one: '{count} failure', other: '{count} failures' },
  'cardRefunds.openBooking': 'Open the booking',
  'cardRefunds.recheckAria': 'Recheck the {refund} with Razorpay',
  /** Button: ask Razorpay again where the refund is (no money moves). */
  'cardRefunds.recheck': 'Recheck',
  'cardRefunds.markAria': 'Mark the {refund} failed',
  'cardRefunds.moveAria': 'Move the {refund} to the {payer}’s wallet',
  'cardRefunds.chosen': 'The {refund} of {name}.',
  'cardRefunds.review.move': 'Move this refund to the wallet',
  'cardRefunds.review.mark': 'Mark this refund failed',
  'cardRefunds.question.move': 'Move the {refund} to the Jansetu wallet of {name}?',
  'cardRefunds.question.mark': 'Mark the {refund} of {name} failed?',
  /** {text}: the agreement the admin typed, in bold. */
  'cardRefunds.agreementIs': 'Agreement: {text}',

  // Pharmacy refunds needing attention.
  'refunds.cause.prescription_rejected': 'Prescription rejected',
  'refunds.cause.delivery_not_collected': 'Not collected',
  'refunds.cause.delivery_refused': 'Refused at the door',
  'refunds.cause.stock_hold_cancelled': 'Cancelled for held stock',
  'refunds.cause.order_cancelled': 'Order cancelled',
  'refunds.problem.WALLET_INACTIVE': 'The customer’s wallet is inactive',
  'refunds.problem.WALLET_CREDIT_FAILED': 'The wallet credit failed',
  'refunds.problem.PRIOR_REFUND_AMOUNT_MISMATCH': 'An earlier refund of this order does not match the amount',
  'refunds.problem.PAID_PAYMENT_RECORD_NOT_FOUND': 'The order’s payment record was not found',
  'refunds.problem.PAYMENT_AMOUNT_INVALID': 'The order’s paid amount is not valid',
  'refunds.title': 'Refunds needing attention',
  'refunds.intro': 'Pharmacy refunds that did not complete on their own. Waiting wallet credits can be retried; finance reviews are settled outside this workspace.',
  'refunds.loading': 'Loading refunds…',
  'refunds.empty': 'No refund needs attention',
  'refunds.col.order': 'Order',
  'refunds.col.why': 'Why',
  /** Table column: the refund's state. */
  'refunds.col.refund': 'Refund',
  'refunds.col.problem': 'Problem',
  'refunds.col.since': 'Since',
  'refunds.retry': 'Retry',
  'refunds.retryNow': 'Retry now',
  'refunds.retryConsequence': 'Try again to credit {amount} to the customer’s wallet.',
  'refunds.financeReview': 'Finance to review',
  'refunds.waitingProvider': 'Waiting for the payment provider',
  'refunds.first100': 'Showing the first 100.',

  // ---- Labs and clinics (partners) and referral cuts.
  // PartnerStateActions: verify, suspend or reinstate a lab or clinic ({name}: the lab's or clinic's name).
  /** Button. */
  'partnerActions.verify': 'Verify',
  /** Confirm button. */
  'partnerActions.verifyConfirm': 'Verify {name}',
  'partnerActions.verifyConsequence': '{name} is marked verified: its members can start using the workspace and it can take bookings.',
  /** Button. */
  'partnerActions.suspend': 'Suspend',
  /** Confirm button. */
  'partnerActions.suspendConfirm': 'Suspend {name}',
  'partnerActions.suspendConsequence': '{name} is suspended and deactivated: its members are signed out and cannot sign in until it is reinstated.',
  /** Button. */
  'partnerActions.reinstate': 'Reinstate',
  /** Confirm button. */
  'partnerActions.reinstateConfirm': 'Reinstate {name}',
  'partnerActions.reinstateConsequence': '{name} becomes verified and active again: its members can sign in and it can take bookings.',

  // PartnersScreen: the list of labs and clinics.
  /** Page title (also the list's hidden table caption). */
  'partners.title': 'Labs and clinics',
  'partners.intro': 'Partner accounts: verify new ones, manage them as their owner, or suspend them.',
  /** Link to the form that adds a partner. */
  'partners.add': 'Add a lab or clinic',
  /** First option of the Type filter: no filter. */
  'partners.anyKind': 'Labs and clinics',
  /** First option of the Status filter: no filter. */
  'partners.anyStatus': 'Any status',
  'partners.loading': 'Loading partners…',
  'partners.noneMatch': 'No labs or clinics match',
  'partners.noneMatchHint': 'Change the search or filters, or add one.',
  /** Above the list. */
  'partners.count': { one: '{count} partner', other: '{count} partners' },
  /** Table column and detail label: the partner's phone and email. */
  'partners.contact': 'Contact',
  // Shared by the partner page and the new-partner form.
  /** Field label: India's GST number. */
  'partners.gstin': 'GSTIN',
  /** Field label: India's Permanent Account Number. */
  'partners.pan': 'PAN',
  /** Field label of the tax regime list. */
  'partners.taxLabel': 'Tax',
  /** Field label: the letters printed before every invoice number. */
  'partners.invoicePrefix': 'Invoice prefix',
  'partners.gstinInvalid': 'Enter a valid 15-character GSTIN.',
  'partners.panInvalid': 'Enter a valid 10-character PAN.',
  'partners.prefixInvalid': 'Use 1 to 6 letters or digits.',

  // PartnerScreen: one lab or clinic.
  /** Page title before the partner's name is known. */
  'partner.title': 'Lab or clinic',
  /** Under the title: {kind} is "Lab" or "Clinic". */
  'partner.kindSolo': '{kind} · single-doctor practice',
  /** Link to the partner's referral cuts. */
  'partner.referralCuts': 'Referral cuts',
  'partner.loading': 'Loading partner…',
  /** Answer to "Active". */
  'partner.yes': 'Yes',
  /** Answer to "Active". */
  'partner.no': 'No',
  /** Detail label: how many owners the partner has. */
  'partner.owners': 'Owners',
  'partner.legalName': 'Legal name',
  'partner.manage.title': 'Manage as owner',
  /** {name}: the lab's or clinic's name. */
  'partner.manage.intro': 'Everything an owner of {name} can do. Your changes are recorded as a Jansetu admin in its activity log.',
  /** Links to the partner's workspace pages. */
  'partner.manage.profile': 'Profile',
  'partner.manage.staff': 'Staff',
  'partner.manage.branches': 'Branches',
  'partner.manage.audit': 'Activity log',
  'partner.manage.clinicCatalogue': 'Services and prices',
  'partner.manage.labCatalogue': 'Tests and prices',
  'partner.manage.bills': 'Bills',
  'partner.manage.labBookings': 'Lab bookings',
  'partner.manage.slots': 'Slots',
  'partner.manage.frontDesk': 'Front desk',
  'partner.manage.wallet': 'Wallet',
  'partner.manage.finance': 'Finance',
  'partner.manage.doctors': 'Doctors',
  'partner.tax.title': 'Tax and invoicing',
  /** A field's name inside "Someone else changed the … while you were editing." */
  'partner.tax.fieldRegime': 'tax regime',
  /** A field's name inside "Someone else changed the … while you were editing." */
  'partner.tax.fieldPrefix': 'invoice prefix',
  'partner.tax.gstinRemove': 'A GSTIN cannot be removed here. Enter a new one.',
  'partner.tax.panRemove': 'A PAN cannot be removed here. Enter a new one.',
  'partner.tax.unchanged': 'Nothing has changed.',
  'partner.tax.saved': 'Saved.',
  /** Button. */
  'partner.tax.save': 'Save tax details',

  // NewPartnerScreen: add a lab or clinic with its first owner.
  'newPartner.title': 'Add a lab or clinic',
  'newPartner.intro': 'It starts waiting for verification; its owner can use the workspace once it is verified.',
  'newPartner.nameMissing': 'Enter the name customers will see.',
  /** {max}: a number of characters. */
  'newPartner.tooLong': 'Use at most {max} characters.',
  'newPartner.contactPhoneInvalid': 'Enter the 10-digit contact number.',
  'newPartner.emailInvalid': 'Enter a valid email address.',
  'newPartner.ownerNameMissing': 'Enter the owner’s name.',
  'newPartner.ownerPhoneInvalid': 'Enter the owner’s 10-digit mobile number.',
  'newPartner.ownerEmailInvalid': 'Enter a valid email address, or leave it empty.',
  'newPartner.alreadyCreated': 'It had already been created. Find it in the list.',
  'newPartner.givenUp': 'Given up: nothing was created and that request can never create a partner. You can create it again.',
  /** Heading: an unconfirmed creation went through ({name}: the lab's or clinic's name). */
  'newPartner.foundTitle': '{name} was created',
  'newPartner.foundBody': 'The creation that was unconfirmed before the page reloaded did go through.',
  /** Link to the created partner. */
  'newPartner.foundOpen': 'Open {name}',
  /** Button: show the empty form again. */
  'newPartner.addAnother': 'Add another',
  'newPartner.restoredTitle': 'An unconfirmed creation',
  'newPartner.restoredChecking': 'Checking whether it was created…',
  'newPartner.restoredBody': 'Before the page reloaded, a lab or clinic was being created and its answer never arrived. Nothing has been created with it so far, but the request could still arrive. Give it up so it never can, then start again. Its details are not kept on this device.',
  /** Button. */
  'newPartner.giveUp': 'Give up this create',
  /** Button. */
  'newPartner.checkAgain': 'Check again',
  /** Accessible name of the box about a creation whose answer was lost. */
  'newPartner.pendingLabel': 'Unconfirmed creation',
  /** {name}: the lab or clinic being created. */
  'newPartner.pendingBody': 'We could not confirm whether {name} was created. Send again to find out: it sends the same request, so it can never create a second one. Or give it up: then it can never be created, and you can change the form. The form stays locked until one of these is done.',
  /** {name}: the lab or clinic being created; {error}: what went wrong. */
  'newPartner.pendingBodyWithError': 'We could not confirm whether {name} was created ({error}). Send again to find out: it sends the same request, so it can never create a second one. Or give it up: then it can never be created, and you can change the form. The form stays locked until one of these is done.',
  /** Button. */
  'newPartner.sendAgain': 'Send again',
  /** Choice of partner type. */
  'newPartner.kindLab': 'Lab',
  'newPartner.kindClinic': 'Clinic',
  /** Tick box for a clinic run by one doctor. */
  'newPartner.solo': 'Single-doctor practice',
  /** Field label: the name customers see. */
  'newPartner.displayName': 'Display name',
  'newPartner.legalName': 'Legal name (optional)',
  'newPartner.contactPhone': 'Contact phone',
  'newPartner.contactEmail': 'Contact email (optional)',
  'newPartner.gstin': 'GSTIN (optional)',
  'newPartner.pan': 'PAN (optional)',
  'newPartner.prefixHint': '1 to 6 letters or digits, printed on every invoice',
  'newPartner.firstOwner': 'First owner',
  'newPartner.ownerName': 'Owner name',
  'newPartner.ownerPhone': 'Owner mobile number',
  'newPartner.ownerEmail': 'Owner email (optional)',
  'newPartner.ownerEmailHint': 'The owner can sign in with this email too',
  /** Button: create the lab or clinic. */
  'newPartner.create': 'Create',

  // ReferralCutsScreen: what a pharmacy or lab earns for each booking it makes for a patient.
  'referralCuts.title': 'Referral cuts',
  /** Page title: {name} is the pharmacy's or lab's name. */
  'referralCuts.titleFor': 'Referral cuts: {name}',
  /** Shown for a page address with an id that cannot exist. */
  'referralCuts.noSuch': 'No such referral cuts',
  'referralCuts.noSuchPharmacyHint': 'Open it from the pharmacy’s page.',
  'referralCuts.noSuchLabHint': 'Open it from the lab’s page.',
  /** Link back: {name} is the pharmacy's or lab's name. */
  'referralCuts.backTo': 'Back to {name}',
  'referralCuts.backToPharmacy': 'Back to the pharmacy',
  'referralCuts.backToLab': 'Back to the lab',
  /** {name}: the pharmacy's or lab's name. */
  'referralCuts.intro': 'What {name} earns for each booking it makes for a patient. The cut is taken from the doctor’s or the lab’s earning, after any coupon.',
  'referralCuts.introNoName': 'What this partner earns for each booking it makes for a patient. The cut is taken from the doctor’s or the lab’s earning, after any coupon.',
  'referralCuts.loading': 'Loading…',
  'referralCuts.noClinics': 'No referral cuts for clinics',
  'referralCuts.noClinicsHint': 'Referral cuts are set for pharmacies and labs, the partners that book for patients.',
  /** A booking category inside a sentence ("the consultation cut"). */
  'referralCuts.catConsultation': 'consultation',
  /** A booking category inside a sentence ("the lab test cut"). */
  'referralCuts.catLabTest': 'lab test',
  /** A booking category inside a sentence ("the lab package cut"). */
  'referralCuts.catLabPackage': 'lab package',
  /** {category}: consultation, lab test or lab package; {terms}: e.g. "10% of each line"; {version}: a number. */
  'referralCuts.saved': 'Saved: the {category} cut of {name} is {terms} (version {version}).',
  'referralCuts.savedOff': 'Saved: the {category} cut of {name} is off (version {version}).',
  'referralCuts.overtaken': 'The {category} cut was changed by someone else meanwhile, so your change was not saved. Saved now: {terms} (version {version}). Check it, then save again if your change is still needed.',
  'referralCuts.overtakenSentBefore': 'The {category} cut is not what you sent: it was changed since. Saved now: {terms} (version {version}). Check it, then make your change again if it is still needed.',
  /** After "This cut was changed by someone else meanwhile, so nothing was saved." */
  'referralCuts.rereadFailed': 'The cuts could not be read again: reload the page before saving again.',
  /** {reason}: why the server refused. */
  'referralCuts.notSaved': 'Not saved: {reason}',
  'referralCuts.byCategory': 'Cuts by category',
  'referralCuts.byCategoryHint': 'A percent is of each line (0.01% to 50%, with an optional cap per line); a fixed amount is per line, with no upper limit. A change applies to bookings made after it; bookings already made keep their cut. Payouts of these earnings are paused until Jansetu switches them on.',
  'referralCuts.switchedOff': 'Referral cuts are switched off; rules are saved but not applied.',
  'referralCuts.loadingCuts': 'Loading the cuts…',
  'referralCuts.caption': 'Referral cuts by category',
  /** Table column. */
  'referralCuts.category': 'Category',
  /** Table column and field label: the amount a booking earns the partner. */
  'referralCuts.cut': 'Cut',
  /** Table column. */
  'referralCuts.lastChanged': 'Last changed',
  /** {terms}: e.g. "5% of each line". */
  'referralCuts.keptNotUsed': 'Kept but not used: {terms}',
  /** {when}: a date and time; {version}: a number. */
  'referralCuts.changedAt': '{when} · version {version}',
  'referralCuts.neverSet': 'Never set',
  /** Button. */
  'referralCuts.edit': 'Edit',
  /** Accessible name of the Edit button. */
  'referralCuts.editLabel': 'Edit the {category} cut',
  'referralCuts.unconfirmed': 'Unconfirmed change',
  'referralCuts.checkUnknown': 'Read again: the cuts shown are what is saved now. The earlier change is not kept on this device, so whether it went through cannot be told. If the cuts are not what you wanted, forget it and make the change again.',
  'referralCuts.checkNotYet': 'Not saved so far: the {category} cut is {terms} now (version {version}). It may still be on its way. Sending the same request again is safe: it is saved at most once.',
  /** Button. */
  'referralCuts.sendAgain': 'Send the same request again',
  /** Button. */
  'referralCuts.forget': 'Forget it',
  /** Confirm button. */
  'referralCuts.forgetConfirm': 'Yes, forget it',
  'referralCuts.forgetConsequence': 'The change may already have been saved, or may still be. Forgetting it does not undo that. The cuts shown are what is saved now.',
  'referralCuts.pendingRestored': 'A change to these cuts made earlier on this device (before the page was reloaded) was not confirmed. Its details are not kept here. Check the cuts.',
  'referralCuts.pendingUnknown': 'The outcome of this change is not known yet: the {category} cut to {terms}. Sending the same request again is safe.',
  /** {error}: what went wrong. */
  'referralCuts.pendingUnknownWithError': 'The outcome of this change is not known yet ({error}): the {category} cut to {terms}. Sending the same request again is safe.',
  /** Heading of the editor; {category}: consultation, lab test or lab package. */
  'referralCuts.editorTitle': 'Change the {category} cut',
  /** Options of the Cut list. */
  'referralCuts.modeOff': 'Off',
  'referralCuts.modePercent': 'Percent of each line',
  'referralCuts.modeFixed': 'Fixed amount per line',
  'referralCuts.percent': 'Percent',
  'referralCuts.percentHint': '0.01 to 50, for example 10 or 2.5.',
  'referralCuts.cap': 'Cap per line in ₹ (optional)',
  'referralCuts.capHint': 'The most one line can earn.',
  'referralCuts.fixed': 'Amount per line in ₹',
  'referralCuts.fixedHint': 'At least ₹0.01; no upper limit.',
  'referralCuts.nothingToSwitchOff': 'No cut is set, so there is nothing to switch off.',
  'referralCuts.unchanged': 'Nothing has changed yet.',
  /** Button. */
  'referralCuts.save': 'Save',
  /** Confirm button. */
  'referralCuts.saveConfirm': 'Save the {category} cut',
  'referralCuts.reasonLabel': 'Reason (kept in the history)',
  /** {terms} (shown in bold): e.g. "10% of each line"; {name}: the pharmacy's or lab's name. */
  'referralCuts.confirmActiveDoctor': 'New {category} bookings that {name} makes: {terms} goes to {name}, taken from the doctor’s earning.',
  'referralCuts.confirmActiveLab': 'New {category} bookings that {name} makes: {terms} goes to {name}, taken from the lab’s earning.',
  'referralCuts.confirmInactive': 'New {category} bookings that {name} makes earn it no cut.',
  'referralCuts.confirmKeep': 'Bookings already made keep their cut. If someone else changes this cut before you confirm, nothing is saved.',
  /** Button. */
  'referralCuts.cancel': 'Cancel',
  'referralCuts.history': 'History',
  'referralCuts.loadingHistory': 'Loading the history…',
  'referralCuts.noChanges': 'No changes yet',
  'referralCuts.noChangesHint': 'Every change to these cuts is listed here, with its reason.',
  'referralCuts.historyCaption': 'Changes to the referral cuts, newest first',
  /** Table columns of the history. */
  'referralCuts.when': 'When',
  'referralCuts.change': 'Change',
  'referralCuts.reason': 'Reason',
  /** Who made the change. */
  'referralCuts.by': 'By',
  /** Under a change: {version} is a number. */
  'referralCuts.version': 'Version {version}',
  /** Who made the change: the admin reading the page. */
  'referralCuts.byYou': 'You',
  /** Who made the change: another admin. */
  'referralCuts.byAdmin': 'Jansetu admin',
} as const;
