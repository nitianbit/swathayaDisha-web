/**
 * Customer app words (docs/I18N_PLAN.md §3.2): the English source. A comment above a key is the translator's note.
 * Placeholders in braces ({name}) are filled in by the app and must stay exactly as written.
 */
export default {
  // ---- Shared words, the shell, sign-in and session notices, statuses, and the shared panels (unconfirmed requests, paying again, private files).

  /** The app's name. Keep it in Latin letters unless told otherwise. */
  'common.brand': 'Jansetu',
  'common.cancel': 'Cancel',
  'common.add': 'Add',
  'common.apply': 'Apply',
  /** A label in a list of details (booking, order). */
  'common.status': 'Status',
  /** A label in a list of details: the person the booking or order is for. */
  'common.for': 'For',
  /** A label in a list of details: how the consultation happens (video, at the clinic …). */
  'common.how': 'How',
  'common.total': 'Total',
  'common.price': 'Price',
  'common.fee': 'Fee',
  'common.payment': 'Payment',
  'common.email': 'Email',
  'common.doctor': 'Doctor',
  'common.medicine': 'Medicine',
  'common.booking': 'Booking',
  'common.lab': 'Lab',
  'common.labTests': 'Lab tests',
  'common.time': 'Time',
  'common.day': 'Day',
  'common.coupon': 'Coupon',
  'common.couponOptional': 'Coupon (optional)',
  'common.couponInvalid': 'Enter a valid coupon code.',
  /** The person booking for themselves (as opposed to a family member). */
  'common.myself': 'Myself',
  /** The first, empty choice of a list. */
  'common.choose': 'Choose…',
  'common.myBookings': 'My bookings',
  'common.orderMedicines': 'Order medicines',
  'common.consultNow': 'Consult now',
  'common.joinCall': 'Join the call',
  'common.fromWallet': 'From wallet',
  'common.toPayNow': 'To pay now',
  'common.payNow': 'Pay now',
  'common.checkNow': 'Check now',
  /** After a price: whether it is paid (small letters). */
  'common.refunded': 'refunded',
  'common.notPaidYet': 'not paid yet',
  'common.paidCheckAgain': 'I have paid, check again',
  'common.checkingPayment': 'Checking your payment…',
  'common.priceChanged': 'Price changed',
  'common.acceptNewPrice': 'Accept the new price',
  'common.bookingNotFound': 'Booking not found',
  'common.bookingCancelled': 'The booking is cancelled.',
  'common.cancelBooking': 'Cancel this booking',
  'common.yesCancel': 'Yes, cancel it',
  'common.startAgain': 'Start again',
  'common.sendAgain': 'Send it again',
  'common.giveUpStartAgain': 'Give it up and start again',
  'common.yesGiveUp': 'Yes, give it up',
  'common.noFreeTimes': 'No free times on this day',
  'common.tryAnotherDay': 'Try another day.',
  'common.loadingTimes': 'Loading times…',
  'common.loadingMedicines': 'Loading medicines…',
  'common.findingDoctors': 'Finding doctors online…',
  'common.sixDigitCode': '6-digit code',
  'common.resendCode': 'Resend code',
  /** {seconds} is a number. */
  'common.resendCodeIn': 'Resend code in {seconds}s',

  /** The bottom tabs. */
  'nav.main': 'Main',
  'nav.home': 'Home',
  'nav.bookings': 'Bookings',
  'nav.medicines': 'Medicines',
  'nav.wallet': 'Wallet',
  'nav.profile': 'Profile',
  /** A link for keyboard and screen-reader users, first on every page. */
  'nav.skip': 'Skip to content',
  'app.notFound.title': 'Page not found',
  'app.notFound.body': 'This page does not exist.',
  'app.signingIn': 'Signing you in…',

  /** Shown on the sign-in screen; several can show together, one after another. */
  'session.notice.signedOutHere': 'You are signed out on this device. The server has not confirmed it yet: this app keeps trying, and nobody is signed back in here until it does.',
  'session.notice.phoneNotCleared': 'This phone could not clear its saved sign-in yet; it will be cleared when the app next opens.',
  'session.notice.phoneStillSigningOut': 'This phone could not finish signing out yet. Keep the app open for a moment while it tries again.',
  'session.notice.ended': 'Your session has ended. Please sign in again.',
  'session.notice.someoneElse': 'Someone else signed in on this browser. Please sign in again.',
  'session.notice.otherTab': 'You signed out in another tab.',
  'session.notice.everywhere': 'You have been signed out on all your devices.',
  'session.error.notCustomer': 'This account cannot use the customer app.',
  'session.error.secureStore': 'This phone could not save your sign-in. Please try again.',
  'session.error.noSession': 'Sign-in did not return a session. Please try again.',

  'login.title': 'Sign in',
  'login.sub': 'Book doctors and lab tests for you and your family.',
  'login.identifier': 'Mobile number or email',
  'login.identifierHint': 'We will send a 6-digit code by SMS or email. New here? Start with your mobile number; an email works once you add it to your profile.',
  'login.identifierMissing': 'Enter your 10-digit mobile number or your email address.',
  'code.missing': 'Enter the 6-digit code.',
  'code.send': 'Send code',
  /** {seconds} is a number. */
  'code.sendIn': 'Send code in {seconds}s',
  'login.verify': 'Verify and sign in',
  'login.change': 'Change number or email',

  /** Statuses of bookings, lab bookings, Consult now requests and medicine orders (a short badge). */
  'status.awaitingConfirmation': 'Awaiting confirmation',
  'status.awaitingPayment': 'Awaiting payment',
  'status.created': 'Created',
  'status.confirmed': 'Confirmed',
  'status.rescheduled': 'Rescheduled',
  'status.completed': 'Completed',
  'status.reportReady': 'Report ready',
  'status.cancelling': 'Cancelling',
  'status.cancelled': 'Cancelled',
  'status.missedNoRefund': 'Missed (no refund)',
  'status.expired': 'Expired',
  'status.sampleCollected': 'Sample collected',
  'status.visited': 'Visited',
  'status.beingTested': 'Being tested',
  'status.notPresent': 'Not present',
  'status.waitingForDoctor': 'Waiting for a doctor',
  'status.doctorAccepted': 'Doctor accepted',
  'status.refunded': 'Refunded',
  'status.nobodyAccepted': 'Nobody accepted yet',
  'status.placed': 'Placed',
  'status.acceptedByPharmacy': 'Accepted by the pharmacy',
  'status.packed': 'Packed',
  'status.readyToCollect': 'Ready to collect',
  'status.outForDelivery': 'Out for delivery',
  'status.deliveryFailed': 'Delivery failed',
  'status.notAccepted': 'Not accepted',
  'status.cancelledNotPaid': 'Cancelled (not paid in time)',
  'status.cancellationRequested': 'Cancellation requested',

  'visitMode.home': 'Home collection',
  'visitMode.lab': 'Visit the lab',
  /** A lab booking's title when it names no test. */
  'lab.titleFallback': 'Lab test',

  /** {number} is the pharmacy's order number. */
  'order.title': 'Order {number}',
  'order.titleFallback': 'Pharmacy order',
  'order.refund.walletPending': 'Your refund is being added to your Jansetu wallet.',
  'order.refund.walletCredited': 'Refunded to your Jansetu wallet.',
  'order.refund.sourceProcessing': 'Your refund is on its way to your card/UPI. Banks can take 5–7 working days.',
  'order.refund.sourceRefunded': 'Refunded to your card/UPI. Banks can take 5–7 working days to show it.',
  'order.refund.manualReview': 'Our team is checking your refund and will contact you if needed.',
  'order.paymentMode.online': 'Online',
  'order.paymentMode.inStore': 'Pay at the pharmacy',
  'order.paymentMode.cod': 'Cash on delivery',

  /** A two-step confirmation: the optional reason field. */
  'confirm.reason': 'Reason (optional)',

  /** A booking or request whose answer was lost. "Lab booking request" variants. */
  'once.lab.group': 'Unconfirmed lab booking request',
  'once.lab.restored': 'A lab booking request made earlier on this device (before the page was reloaded, or before you signed out) has not been confirmed. Check what happened to it before starting again.',
  /** {label} is the time asked for, e.g. "9:30 am, Fri 20 Nov". */
  'once.lab.noAnswer': 'Your lab booking request for {label} did not get an answer. It may already have been made. Send it again to find out: it will not be made twice. Or give it up to start again.',
  /** {label} is the time asked for; {error} is the reason, a whole sentence. */
  'once.lab.noAnswerWhy': 'Your lab booking request for {label} did not get an answer ({error}). It may already have been made. Send it again to find out: it will not be made twice. Or give it up to start again.',
  'once.lab.giveUp': 'The lab booking request is cancelled for good: it can never be made later, even if it is still on its way. Then you can start again.',
  /** "Consultation request" (Consult now) variants. */
  'once.consult.group': 'Unconfirmed consultation request',
  'once.consult.restored': 'A consultation request made earlier on this device (before the page was reloaded, or before you signed out) has not been confirmed. Check what happened to it before starting again.',
  /** {label} is the speciality asked for. */
  'once.consult.noAnswer': 'Your consultation request for {label} did not get an answer. It may already have been made. Send it again to find out: it will not be made twice. Or give it up to start again.',
  'once.consult.noAnswerWhy': 'Your consultation request for {label} did not get an answer ({error}). It may already have been made. Send it again to find out: it will not be made twice. Or give it up to start again.',
  'once.consult.giveUp': 'The consultation request is cancelled for good: it can never be made later, even if it is still on its way. Then you can start again.',
  /** Shown in brackets inside the "did not get an answer" sentence, so no final full stop. */
  'once.madeNotShownShort': 'It was made, but it could not be shown here. Look in My bookings',
  'once.madeNotShown': 'It was made, but it could not be shown here. Look in My bookings.',
  'once.madeAfterAll': 'It was made after all, but it could not be shown here. Look in My bookings.',
  'once.notYet': 'It has not been made yet, but it may still be on its way. Check again in a moment, or give it up and start again.',
  /** {message} is the reason, a whole sentence. */
  'once.checkFailed': 'Could not check it: {message}',
  'common.checkAgain': 'Check again',
  'once.checkWhat': 'Check what happened',

  /** Paying for a lab booking ("booking") or a Consult now request ("request") again. */
  'pay.received': 'Payment received.',
  'pay.unknown': 'We could not check your payment just now. If you have paid, it will show here once we can.',
  'pay.booking.closed': 'The time to pay for this booking has passed, so a new payment cannot be started. If you already paid, it will be confirmed; otherwise it will be released and any wallet money used goes back to your wallet.',
  /** {deadline} is a date and time. */
  'pay.booking.unpaidBy': 'This booking is not paid yet. Pay by {deadline}, or it is released.',
  'pay.booking.unpaidSoon': 'This booking is not paid yet. Pay within 30 minutes, or it is released.',
  'pay.booking.returned': 'An earlier payment for this booking was returned to your Jansetu wallet.',
  'pay.request.closed': 'The time to pay for this request has passed, so a new payment cannot be started. If you already paid, it will be confirmed; otherwise it will be released and any wallet money used goes back to your wallet.',
  'pay.request.unpaidBy': 'This request is not paid yet. Pay by {deadline}, or it is released.',
  'pay.request.unpaidSoon': 'This request is not paid yet. Pay within 30 minutes, or it is released.',
  'pay.request.returned': 'An earlier payment for this request was returned to your Jansetu wallet.',
  'pay.amount': 'Amount',
  'pay.amountDue': 'Amount due',
  'pay.heldFromWallet': 'Already held from your wallet',
  'pay.onPaymentPage': 'To pay on the payment page',

  /** A private file (bill, lab report). {document} is one of the names below ("bill PDF", "report 2"). */
  'files.get': 'Get {document}',
  'files.open': 'Open {document}',
  'files.save': 'Save {document}',
  /** {message} is the reason, a whole sentence. The sentence starts with the document's name, written in small letters. */
  'files.failed': '{document} could not be loaded: {message}',
  'files.saveOnly': 'This file can only be saved to your device.',
  'files.billPdf': 'bill PDF',
  'files.report': 'report',
  /** {number} is 1, 2, 3 … */
  'files.reportNumber': 'report {number}',

  // ---- Home, bookings, profile, family and wallet.

  /** {name} is the person's first name. */
  'home.hello': 'Hello, {name}',
  'home.helloAnon': 'Hello',
  'home.profileFailed': 'Your profile could not be loaded. Pull down or try again later.',
  /** Followed by a link "Complete profile". */
  'home.completeProfile': 'Complete your profile so we can book for you.',
  'home.completeProfileLink': 'Complete profile',
  'home.bills': 'Bills',

  /** The kinds of ordinary bookings. */
  'bookings.type.package': 'Health package',
  'bookings.type.consultation': 'Doctor consultation',
  'bookings.type.secondOpinion': 'Second opinion',
  'bookings.type.surgery': 'Surgery',
  'bookings.doctorsHeading': 'Doctors and health packages',
  'bookings.empty': 'No bookings yet',
  'bookings.noLabTests': 'No lab tests yet',
  'bookings.instantHeading': 'Consult now requests',
  'bookings.noInstant': 'No consult now requests',
  'bookings.consultLink': 'Consult a doctor now',
  'bookings.partnerLabs': 'Partner lab bookings',
  'bookings.noPartnerLabs': 'No partner lab bookings',
  'bookings.bookLabTest': 'Book a lab test',
  /** A badge on a lab booking whose report is ready. */
  'bookings.report': 'Report',

  'booking.cancel.started': 'This appointment has already started, so it can no longer be cancelled.',
  /** {hours} is a number (24 or 48). */
  'booking.cancel.windowClosed': 'Paid bookings can be cancelled until {hours} hours before the appointment. That time has passed.',
  'booking.cancel.unreadable': 'This booking’s time could not be read, so it cannot be cancelled here. Please contact support.',
  /** A label: how the consultation happens. */
  'booking.mode': 'Mode',
  /** {minutes} is a number. */
  'booking.expired': 'This booking expired because it was not paid within {minutes} minutes, so the time was released. Any wallet money used for it is back in your wallet. You can book a new time with the doctor.',
  'booking.noShow.moved': 'You were marked as not present for this appointment. A missed appointment is not refunded. It had already been moved once after a missed time, so it cannot be moved again.',
  'booking.noShow.instant': 'You were marked as not present for this appointment. A missed appointment is not refunded.',
  'booking.noShow.mayOffer': 'You were marked as not present for this appointment. A missed appointment is not refunded. The doctor or clinic may offer you one new time; you will be told if they do.',
  /** {earlier} and {time} are dates with times. */
  'booking.movedFrom': 'You missed the earlier time ({earlier}), so the appointment was moved to the new time: {time}. It is not refunded and cannot be cancelled for a refund. If this time is missed too, it is final.',
  'booking.moved': 'You missed the earlier time, so the appointment was moved to the new time: {time}. It is not refunded and cannot be cancelled for a refund. If this time is missed too, it is final.',
  /** {deadline} is a date and time. */
  'booking.cancelUntil': 'You can cancel until {deadline}.',
  'booking.cancelPaid': 'The booking is cancelled and the amount you paid goes back to your Jansetu wallet.',
  'booking.instantNote': 'This consultation started when the doctor accepted, so it cannot be cancelled. If the doctor cancels, everything you paid goes back to your Jansetu wallet.',
  'booking.seeRequest': 'See the request',
  'booking.paid': 'Payment received. Your booking is confirmed.',
  'booking.payClosed': 'The time to pay for this booking has passed, so a new payment cannot be started. If you already paid, the booking will be confirmed; otherwise it will be released. This page checks again every minute.',
  /** {time} is a date and time. */
  'booking.heldUntil': 'This booking is not paid yet. Your time is held until {time}; after that it is released.',
  /** {minutes} is a number. */
  'booking.heldFor': 'This booking is not paid yet. Your time is held for {minutes} minutes from booking; after that it is released.',

  'profile.family': 'Family',
  'profile.familyLink': 'Family members you book for',
  'profile.account': 'Account',
  'profile.signOut': 'Sign out',
  'profile.signOutAll': 'Sign out on all devices',
  'profile.signOutEverywhere': 'Sign out everywhere',
  'profile.signOutAllConsequence': 'Every phone or browser signed in to your account will be signed out, including this one.',
  'profile.nameMissing': 'Enter your full name.',
  'profile.dobMissing': 'Enter your date of birth.',
  'profile.details': 'Your details',
  /** {fields} is a list of the field names below, joined with commas. */
  'profile.complete': 'Please complete: {fields}.',
  /** Field names inside "Please complete: …" (small letters). */
  'profile.field.name': 'name',
  'profile.field.email': 'email',
  'profile.field.gender': 'gender',
  'profile.field.dateOfBirth': 'date of birth',
  'profile.fullName': 'Full name',
  'profile.mobile': 'Mobile number',
  'profile.gender': 'Gender',
  'profile.dob': 'Date of birth',
  'profile.saved': 'Saved.',
  'profile.emailAdded': 'Email added. You can now also sign in with it.',
  'profile.emailFixed': 'You can sign in with it. To change it, contact support.',
  'profile.emailInvalid': 'Enter a valid email address.',
  'profile.emailHint': 'We will send a code to it. Once added, you can also sign in with it; only support can change it.',
  'profile.verifyEmail': 'Verify and add email',
  'profile.otherEmail': 'Use another email',

  'family.title': 'Family members',
  'family.sub': 'People you can book appointments and tests for.',
  'family.empty': 'No family members yet',
  /** {shown} and {total} are numbers. */
  'family.showMore': 'Show more ({shown} of {total})',
  'family.add': 'Add a family member',
  'family.nameMissing': 'Enter their name.',
  'family.relationshipMissing': 'Choose how they are related to you.',
  'family.name': 'Name',
  'family.relationship': 'Relationship',
  'family.genderOptional': 'Gender (optional)',
  'family.genderUnsaid': 'Prefer not to say',
  /** How a family member is related to the customer. "Me" is the customer themself. */
  'relationship.me': 'Me',
  'relationship.father': 'Father',
  'relationship.mother': 'Mother',
  'relationship.spouse': 'Spouse',
  'relationship.son': 'Son',
  'relationship.daughter': 'Daughter',
  'relationship.brother': 'Brother',
  'relationship.sister': 'Sister',
  'relationship.grandfather': 'Grandfather',
  'relationship.grandmother': 'Grandmother',
  'relationship.friend': 'Friend',
  'relationship.other': 'Other',
  'gender.female': 'Female',
  'gender.male': 'Male',
  'gender.other': 'Other',

  'wallet.sub': 'Refunds and top-ups. You can use it to pay for bookings.',
  'wallet.balance': 'Balance',
  'wallet.history': 'History',
  'wallet.empty': 'No transactions yet',
  'wallet.showOlder': 'Show older',

  // ---- Doctors, booking a doctor and Consult now.

  'common.bookDoctor': 'Book a doctor',
  'doctors.search': 'Doctor or speciality',
  'doctors.searchPlaceholder': 'e.g. cardiologist',
  /** {search} is what the customer typed. */
  'doctors.noMatch': 'No doctors match “{search}”',
  'doctors.none': 'No doctors available yet',
  'doctors.freeConsultation': 'Free consultation',
  /** Under a list: {shown} and {total} are numbers. */
  'common.showing': 'Showing {shown} of {total}.',

  /** A doctor's experience; {years} is a number (shown as "1 years" too, as today). */
  'common.years': '{years} years',
  /** The link back to the list of doctors. */
  'doctor.back': 'Doctors',
  'doctor.notFound': 'Doctor not found',
  /** Days to choose a time on. */
  'doctor.today': 'Today',
  'doctor.tomorrow': 'Tomorrow',
  /** How a consultation happens. */
  'doctor.mode.inPerson': 'At the clinic',
  'doctor.mode.video': 'Video call',
  'doctor.mode.call': 'Phone call',
  'doctor.mode.chat': 'Chat',
  'doctor.experience': 'Experience',
  'doctor.clinic': 'Clinic',
  'doctor.languages': 'Languages',
  /** The fee when the consultation costs nothing. */
  'doctor.free': 'Free',
  /** Shown in brackets inside the "did not get an answer" sentence, so no final full stop. */
  'doctor.bookedNotShownShort': 'It was booked, but the booking could not be shown. Open My bookings',
  'doctor.bookedNotShown': 'It was booked, but the booking could not be shown. Open My bookings.',
  'doctor.bookedAfterAll': 'It was booked after all, but the booking could not be shown. Open My bookings.',
  'doctor.unconfirmed': 'Unconfirmed booking request',
  'doctor.restored.body': 'A booking request made earlier on this device (before the page was reloaded, or before you signed out) has not been confirmed yet. Check whether it was booked before booking again.',
  'doctor.restored.notFound': 'Not found in your bookings. It may still be on its way. To book again, first cancel this request: once cancelled it can never be booked.',
  /** {message} is the reason, a whole sentence. */
  'doctor.restored.checkFailed': 'Could not check your bookings: {message}',
  /** {message} is the reason, a whole sentence. */
  'doctor.restored.cancelFailed': 'Could not cancel it: {message}',
  'doctor.restored.check': 'Check my bookings',
  'doctor.restored.cancel': 'Cancel it and book again',
  /** {label} is the time asked for, e.g. "11:30 PM, Today". */
  'doctor.noAnswer': 'Your booking request for {label} did not get an answer. It may already be booked. Send it again to find out: it will not be booked twice.',
  /** {label} is the time asked for; {error} is the reason, a whole sentence. */
  'doctor.noAnswerWhy': 'Your booking request for {label} did not get an answer ({error}). It may already be booked. Send it again to find out: it will not be booked twice.',
  'doctor.giveUp': 'Give it up and book again',
  'doctor.giveUpConsequence': 'The booking request is cancelled for good: it can never be booked later, even if it is still on its way. Then you can book again.',
  'doctor.chooseTime': 'Choose a time',
  'doctor.couponNotForBooking': 'This coupon cannot be used for this booking.',
  'doctor.concernMissing': 'Tell the doctor briefly what it is about.',
  /** Heading of the booking form; {time} is the chosen time, e.g. "11:30 PM". */
  'common.bookAt': 'Book {time}',
  /** {code} is the coupon code. */
  'doctor.couponRemoved': 'Coupon {code} was removed because the patient changed. Apply it again to check it for them.',
  'doctor.concern': 'What is it about?',
  /** {code} is the coupon code; {amount} the money taken off. */
  'common.couponOff': 'Coupon {code}: {amount} off.',
  /** {amount} is the wallet balance. */
  'common.useWallet': 'Use my wallet ({amount})',
  'doctor.finalAmount': 'The final amount is worked out by the server and shown on the payment page.',
  'common.bookAndPay': 'Book and pay',
  'common.book': 'Book',
  /** On the payment page; {doctor} is the doctor's name. */
  'doctor.payDescription': 'Consultation with {doctor}',

  /** On the payment page; {speciality} is the speciality asked for. */
  'consult.payDescription': 'Consultation now · {speciality}',
  'consult.specialityMissing': 'Choose a speciality.',
  'consult.sub': 'Talk to a doctor who is online now. You pay first; if nobody can take it, you get your money back in your wallet.',
  'consult.need': 'What do you need?',
  'consult.loadingSpecialities': 'Loading specialities…',
  'consult.noSpecialities': 'No specialities available yet',
  'consult.speciality': 'Speciality',
  /** After a speciality in a list; {number} is how many doctors are online. */
  'consult.onlineNow': '{number} online now',
  'consult.nobodyOnlineNow': 'nobody online now',
  'consult.seeOnline': 'See who is online',
  'consult.onlineHeading': 'Online now',
  /** {speciality} is the speciality asked for, e.g. "Dermatology". One sentence per way of consulting. */
  'consult.noDoctorOnline.video': 'No {speciality} doctor is online for a video call right now',
  'consult.noDoctorOnline.call': 'No {speciality} doctor is online for a phone call right now',
  'consult.noDoctorOnline.chat': 'No {speciality} doctor is online for a chat right now',
  'consult.bookLater': 'Book a doctor for later',
  'consult.anyDoctor': 'Any available doctor',
  /** {number} is how many doctors are online. */
  'consult.anyDoctorOnline': 'Any available doctor ({number} online)',
  /** {code} is the coupon code. */
  'consult.couponNotForConsult': 'Coupon {code} cannot be used for this consultation.',
  'consult.gettingPrice': 'Getting the price…',
  /**
   * What a Consult now request is for, inside "Your consultation request for … did not get an answer". {doctor} is a
   * doctor's name; {speciality} the speciality asked for. Small letters: it sits inside a sentence.
   */
  'consult.requestFor.video.doctor': 'video call with {doctor}',
  'consult.requestFor.video.any': 'video call with any {speciality} doctor',
  'consult.requestFor.call.doctor': 'phone call with {doctor}',
  'consult.requestFor.call.any': 'phone call with any {speciality} doctor',
  'consult.requestFor.chat.doctor': 'chat with {doctor}',
  'consult.requestFor.chat.any': 'chat with any {speciality} doctor',
  /** {price} is the amount; {doctors} is how many doctors are online (shown as "1 doctors" too, as today). */
  'consult.youPayAny': 'You pay {price} now (the highest fee among the {doctors} doctors online). If the doctor who accepts charges less, the difference goes back to your wallet.',
  'consult.youPay': 'You pay {price} now.',
  /** {minutes} is a number. */
  'consult.offerTime': 'Each doctor has {minutes} minutes to accept. If nobody does, you can offer it again or get your money back in your wallet.',
  /** {code} is the coupon code being checked. */
  'consult.checkingCoupon': 'Checking coupon {code}…',
  'consult.quotedPrice': 'Quoted price',
  /** {minutes} is a number. */
  'consult.serverChecks': 'The server checks the price again when you request. Pay within {minutes} minutes.',
  /** {quote} and {pay} are amounts. */
  'consult.priceChanged': 'The price changed: the quote is now {quote} and you pay {pay}. Check it before you request.',
  /** {quote}, {pay} and {was} are amounts. */
  'consult.priceChangedWas': 'The price changed: the quote is now {quote} and you pay {pay} (it was {was}). Check it before you request.',
  'consult.payAndRequest': 'Pay and request a doctor',
  'consult.request': 'Request a doctor',

  'instant.notFound': 'Request not found',
  /** {name} is the patient's name. */
  'instant.forPatient': 'For {name}',
  'instant.chosenDoctor': 'The doctor you chose',
  /** After the price; {code} is the coupon code, {amount} the money taken off. */
  'common.couponDiscount': '(coupon {code} −{amount})',
  /** Payment state after the price (small letters: it follows "·"). */
  'common.paid': 'paid',
  'common.refundedToWallet': 'refunded to your wallet',
  'common.notPaid': 'not paid',
  /** {message} is the reason, a whole sentence. */
  'common.paymentPageFailed': 'The payment page could not open: {message} You can pay below.',
  /** {minutes} is a number. Followed by a "Start again" link. */
  'instant.expired': 'This request was not paid within {minutes} minutes, so it was closed. Any amount taken is back in your wallet, including a payment that went through after the time ran out.',
  /** {minutes} is a number. */
  'instant.refund.inactivity': 'Nobody accepted and this screen was not open for {minutes} minutes, so the request was closed.',
  'instant.refund.doctorCancelled': 'The doctor cancelled the consultation.',
  'instant.refund.asked': 'You asked for a refund, so the request was closed.',
  /** {amount} is the money refunded. Followed by a "Start again" link. */
  'instant.refund.amount': '{amount} went back to your Jansetu wallet.',
  'instant.refund.cancel': 'Cancel and refund to my wallet',
  'instant.refund.yes': 'Yes, refund to my wallet',
  /** {amount} is what the customer paid. */
  'instant.refund.consequence': 'The request is closed and everything you paid ({amount}) goes back to your Jansetu wallet. A doctor can no longer accept it.',
  'instant.refund.tooLate': 'A doctor has just accepted, so it can no longer be refunded. Open your consultation below.',
  'instant.waiting.title': 'Waiting for a doctor to accept',
  'instant.waiting.timeUp': 'Nobody accepted in time',
  'instant.waiting.askedAll': 'Every online doctor within your paid amount has been asked.',
  'instant.waiting.askedOne': 'The doctor you chose has been asked.',
  'instant.waiting.keepOpen': 'Keep this screen open; it updates by itself.',
  'instant.waiting.timeLeftLabel': 'Time left for this offer',
  /** {time} is a countdown such as "4:59". */
  'instant.waiting.left': '{time} left',
  /** {amount} is what the customer paid. */
  'instant.waiting.noneAccepted': 'No doctor accepted within the time. Offer it again, or get your {amount} back in your wallet.',
  'instant.reoffer.to': 'Offer it to',
  'instant.reoffer.anyNobody': 'Any available doctor (nobody online right now)',
  'instant.reoffer.offer': 'Offer again',
  'instant.reoffer.refresh': 'Refresh doctors',
  'instant.accepted.title': 'A doctor accepted',
  /** {doctor} is the doctor's name. One sentence per way of consulting. */
  'instant.accepted.named.video': '{doctor} is joining your video call.',
  'instant.accepted.named.call': '{doctor} is joining your phone call.',
  'instant.accepted.named.chat': '{doctor} is joining your chat.',
  'instant.accepted.yours.video': 'Your doctor is joining your video call.',
  'instant.accepted.yours.call': 'Your doctor is joining your phone call.',
  'instant.accepted.yours.chat': 'Your doctor is joining your chat.',
  /** {amount} is money given back. */
  'instant.accepted.back': '{amount} (the difference from your quote) is back in your wallet.',
  'instant.accepted.open': 'Open your consultation',
  /** {message} is the reason, a whole sentence. */
  'instant.accepted.loadFailed': 'Your consultation could not be loaded: {message}',
  'instant.accepted.linkPreparing': 'The call link is being prepared. It appears here and on your consultation once it is ready; this page checks by itself.',
  'instant.accepted.cancelled': 'This consultation was cancelled.',
  'instant.accepted.noCancel': 'A consultation cannot be cancelled once a doctor has accepted it. If the doctor cancels, you get a full refund to your wallet.',

  // ---- Partner labs, lab bookings, bills and other lab tests.

  'labs.sub': 'Book tests at a partner lab, or have a sample collected at home.',
  'labs.search': 'Pincode or city',
  /** {place} is the pincode or city typed. */
  'labs.noneIn': 'No partner labs in “{place}” yet',
  'labs.none': 'No partner labs available yet',
  'labs.tryAnother': 'Try another pincode or city.',
  'labs.branches': { one: '{count} branch', other: '{count} branches' },
  'labs.labVisit': 'Lab visit',

  'lab.notFound': 'Lab not found',
  'lab.gone': 'This lab is not available',
  /** Followed by a link "See other labs". */
  'lab.goneBody': 'It may have stopped taking bookings.',
  'lab.otherLabs': 'See other labs',
  /** Shown on the payment page; {lab} is the lab's name. */
  'lab.payDescription': 'Lab tests at {lab}',
  /** {max} is a number. */
  'lab.maxItems': 'You can choose up to {max} tests in one booking.',
  'lab.notTaking': 'This lab is not taking bookings right now',
  'lab.visitType': 'Visit type',
  'lab.branch': 'Branch',
  'lab.tests': 'Tests',
  'lab.loadingTests': 'Loading tests…',
  'lab.noTests.home': 'No tests offered for home collection',
  'lab.noTests.lab': 'No tests offered for visit the lab',
  /** After a test's name, in brackets: it is a package of tests. */
  'lab.packageTag': 'package',
  /** {tests} is a list of test names. */
  'lab.includes': 'Includes {tests}',
  /** {text} is the lab's own preparation note. */
  'lab.preparation': 'Preparation: {text}',
  /** {hours} is a number. */
  'lab.reportIn': 'Report in about {hours} hours',
  'lab.chooseTestAndTime': 'Choose at least one test and a time to continue.',
  /** {code} is the coupon code. */
  'lab.couponNotForTests': 'Coupon {code} cannot be used for these tests.',
  'lab.address': 'Collection address',
  'lab.line1': 'House and street',
  'lab.line2': 'Area (optional)',
  'lab.landmark': 'Landmark (optional)',
  'lab.city': 'City',
  'lab.state': 'State (optional)',
  'lab.pincode': 'Pincode',
  /** {code} is the coupon code. */
  'lab.checkingCoupon': 'Checking coupon {code} for these tests…',
  /** {minutes} and {hours} are numbers. */
  'lab.finalAmount': 'The final amount is worked out by the lab’s prices on the server and shown on the payment page. Pay within {minutes} minutes or the time is released. You can cancel for a full refund to your wallet until {hours} hours before the time.',
  /** {amount} and {was} are money. */
  'lab.priceChangedWas': 'The price changed: you now pay {amount} for these tests (it was {was}). Check it before you book.',
  'lab.priceChanged': 'The price changed: you now pay {amount} for these tests. Check it before you book.',

  'labBooking.labPhone': 'Lab phone',
  'labBooking.address': 'Address',
  /** A label: where the lab is. */
  'labBooking.where': 'Where',
  /** A label: the person who collects the sample. */
  'labBooking.collector': 'Collector',
  'labBooking.noShow.moved': 'The lab marked you as not present for this time. A missed booking is not refunded. It had already been moved once after a missed time, so it cannot be moved again.',
  'labBooking.noShow.mayOffer': 'The lab marked you as not present for this time. A missed booking is not refunded. The lab may offer you one new time; you will be told if they do.',
  /** {from} and {time} are dates with times. */
  'labBooking.moved': 'You missed {from}, so the lab moved the booking to the new time: {time}. It is not refunded and cannot be cancelled for a refund. If this time is missed too, it is final.',
  'labBooking.reports': 'Reports',
  /** {date} is a date and time; {name} is the person who signed the report; {number} their registration number. */
  'labBooking.releasedReg': 'Released {date} by {name} (Reg. {number})',
  'labBooking.released': 'Released {date} by {name}',
  /** {deadline} is a date and time; {hours} a number. */
  'labBooking.cancelUntil': 'You can cancel until {deadline} ({hours} hours before the time).',
  'labBooking.cancelDuringReschedule': 'While the lab’s new time is unanswered you can cancel at any time, with a full refund.',
  'labBooking.cancelRefund': 'The booking is cancelled and everything you paid goes back to your Jansetu wallet.',
  'labBooking.cancelRelease': 'The booking is cancelled and the time is released. Any wallet money held for it goes back to your wallet.',
  'labBooking.movedNoCancel': 'This booking was moved after a missed time, so it is not refunded and cannot be cancelled.',
  /** {hours} is a number. */
  'labBooking.windowClosed': 'Paid bookings can be cancelled until {hours} hours before the time. That time has passed.',
  /** {minutes} is a number. */
  'labBooking.expired': 'Payment was not completed in time, so the booking was released (the time to pay is {minutes} minutes). Any amount taken is back in your Jansetu wallet, including a payment that went through after the time ran out. You can book again.',
  /** {note} is what the lab wrote. */
  'labBooking.rejectedWhy': 'The lab could not take this booking: “{note}” Everything you paid is back in your Jansetu wallet.',
  'labBooking.rejected': 'The lab could not take this booking. Everything you paid is back in your Jansetu wallet.',
  /** {date} is a date and time. */
  'labBooking.cancelledOn': 'You cancelled this booking on {date}. Anything you paid is back in your Jansetu wallet.',
  'labBooking.cancelled': 'You cancelled this booking. Anything you paid is back in your Jansetu wallet.',
  'labBooking.resched.changed': 'The lab changed the time again. Check the new time below before accepting.',
  'labBooking.resched.title': 'The lab proposed a new time',
  'labBooking.resched.newTime': 'New time',
  /** A label: the earlier time. */
  'labBooking.resched.was': 'Was',
  'labBooking.resched.reason': 'Reason',
  'labBooking.resched.body': 'Accept the new time, or cancel below for a full refund to your wallet.',
  'labBooking.resched.accept': 'Accept the new time',
  'labBooking.progress': 'Progress',
  /** For screen readers, after a step of the progress list, in brackets. */
  'labBooking.stepDone': 'done',
  'labBooking.stepToCome': 'to come',

  /** Bill states (a short badge). */
  'bills.state.unpaid': 'Unpaid',
  'bills.state.partlyPaid': 'Partly paid',
  'bills.state.paid': 'Paid',
  'bills.sub': 'Bills from partner labs and clinics you visited.',
  'bills.empty': 'No bills yet',
  'bills.emptyBody': 'Bills from partner labs and clinics appear here when they use your mobile number.',
  'bills.bill': 'Bill',

  'bill.notFound': 'Bill not found',
  'bill.billedTo': 'Billed to',
  'bill.from': 'From',
  /** The supplier's GST number (an Indian tax ID). */
  'bill.gstin': 'GSTIN',
  /** {amount} is money, {methods} how it was paid (e.g. "Cash + UPI"), {date} a date and time. */
  'bill.paidAmountBy': 'Paid {amount} by {methods} on {date}.',
  'bill.paidAmount': 'Paid {amount} on {date}.',
  'bill.paidBy': 'Paid by {methods} on {date}.',
  'bill.paidOn': 'Paid on {date}.',
  /** {supplier} is the lab's or clinic's name. */
  'bill.notPaid': 'Not paid yet. Pay at the {supplier} counter.',
  /** {due} is money. */
  'bill.partlyDue': 'Partly paid: {due} is still due. Pay the rest at the {supplier} counter.',
  'bill.partly': 'Partly paid. Pay the rest at the {supplier} counter.',
  /** {reason} is what the counter wrote. */
  'bill.cancelledWhy': 'This bill was cancelled on {date}: “{reason}”',
  'bill.cancelled': 'This bill was cancelled on {date}.',
  'bill.items': 'Items',
  /** On a bill line, after "−": {amount} is money. */
  'bill.lineDiscount': '{amount} discount',
  'bill.totals': 'Totals',
  'bill.subtotal': 'Subtotal',
  'bill.discount': 'Discount',
  'bill.taxable': 'Taxable',
  'bill.exemptValue': 'Exempt value',
  /** A health-care line GST does not apply to (a doctor's consultation). */
  'bill.exempt': 'Exempt',
  'bill.exemptSac': 'Exempt (SAC {sac})',
  'bill.pdf': 'PDF',

  'external.cancelRequested': 'Your cancellation is with the lab. As soon as the lab confirms it, the amount you paid goes back to your Jansetu wallet. You do not need to do anything.',
  'external.cancel': 'Cancel this test',
  'external.cancelPaid': 'We ask the lab to cancel. Once the lab confirms, the amount you paid goes back to your Jansetu wallet.',

  // ---- Pharmacies, cart and medicine orders.

  /** How a pharmacy hands over orders. */
  'pharmacy.pickup': 'Pickup',
  'pharmacy.delivery': 'Delivery',
  'pharmacy.visit': 'Visit the pharmacy',

  'stores.sub': 'Order from a pharmacy near you for pickup or delivery.',
  'stores.myOrders': 'My orders',
  'stores.search': 'Pharmacy, area or pincode',
  /** {search} is what the person typed. */
  'stores.noMatch': 'No pharmacies match “{search}”',
  'stores.none': 'No pharmacies available yet',

  'store.notFound': 'Pharmacy not found',
  'store.backToList': 'Back to pharmacies',
  /** A back link to the list of pharmacies. */
  'store.back': 'Pharmacies',
  /** Followed by the number of items and the amount. */
  'store.viewCart': 'View cart',
  /** {pharmacy} is a pharmacy's name. */
  'store.otherCart': 'Your cart has medicines from {pharmacy}. One order comes from one pharmacy.',
  'store.otherCartUnknown': 'Your cart has medicines from another pharmacy. One order comes from one pharmacy.',
  'store.emptyAndAdd': 'Empty the cart and add this',
  'store.keepCart': 'Keep my cart',
  'store.search': 'Search this pharmacy',
  'store.searchPlaceholder': 'e.g. paracetamol',
  'store.rxNote': 'Medicines that need a prescription are checked by the pharmacist before your order is packed.',
  /** {search} is what the person typed. */
  'store.noMatch': 'Nothing in stock matches “{search}”',
  'store.none': 'No medicines in stock right now',
  'store.showMore': 'Show more medicines',
  'store.priceAtPharmacy': 'Price at the pharmacy',
  /** Screen-reader names of the cart buttons; {name} is a medicine's name. */
  'store.addAria': 'Add {name} to cart',
  'store.quantityAria': '{name} quantity',
  'store.lessAria': 'One less {name}',
  'store.moreAria': 'One more {name}',

  'cart.title': 'Cart',
  'cart.continue': 'Continue shopping',
  'cart.empty': 'Your cart is empty',
  'cart.findPharmacy': 'Find a pharmacy',
  'cart.loadingPharmacy': 'Loading the pharmacy…',
  'cart.waitUpload': 'Wait until your prescription has finished attaching.',
  'cart.chooseMode': 'Choose how you get the order.',
  'cart.addressMissing': 'Enter the full delivery address.',
  'cart.attemptCancelled': 'That attempt was cancelled. Please place the order again.',
  'cart.changedElsewhere': 'Your cart changed in another window. Check it and place the order again.',
  'cart.pricesChanged': 'Some prices changed since you added the medicines. Check the new total and place the order again.',
  /** “Check my last order” is the button named below (cart.checkLast). */
  'cart.unknownOutcome': 'We could not tell whether your order was placed. Use “Check my last order” above.',
  'cart.needsRx': 'Needs a prescription: the pharmacist checks it before packing.',
  /** {amount} is money. */
  'cart.total': 'Total {amount}',
  /** Stands for a medicine without a name in a list of names. */
  'cart.aMedicine': 'A medicine',
  'cart.howGet': 'How you get it',
  'cart.pickupOrDelivery': 'Pickup or delivery',
  'cart.collect': 'Collect at the pharmacy',
  'cart.deliver': 'Deliver to me',
  'cart.address': 'Delivery address',
  'cart.addressHint': 'House, street, area, city and pincode.',
  'cart.howPay': 'How you pay',
  'cart.payOnline': 'Pay online now',
  'cart.note': 'Note for the pharmacy (optional)',
  /** {minutes} is a number. */
  'cart.payWithin': 'Pay within {minutes} minutes, or the order is cancelled and the medicines are released.',
  'cart.attaching': 'Attaching your prescription… the order can be placed when it is done.',
  /** {amount} is money. */
  'cart.placeAndPay': 'Place order and pay {amount}',
  'cart.place': 'Place order · {amount}',
  'cart.earlierNone': 'Your earlier attempt did not place an order. You can place the order now.',
  /** Followed by the button "Check my last order". */
  'cart.lastAttempt': 'Your last attempt to place an order may have gone through.',
  'cart.checkLast': 'Check my last order',
  'cart.rx.type': 'Attach a photo (JPG, PNG) or a PDF.',
  'cart.rx.size': 'Each file must be under 10 MB.',
  'cart.rx.failed': 'The file could not be attached.',
  'cart.rx.title': 'Prescription',
  /** {names} is a list of medicine names joined with commas; {count} is how many. */
  'cart.rx.needs': {
    one: '{names} needs a prescription. The pharmacist checks your order before packing it; if it is not approved, you are refunded.',
    other: '{names} need a prescription. The pharmacist checks your order before packing it; if it is not approved, you are refunded.',
  },
  'cart.rx.attach': 'Attach your prescription (optional)',
  'cart.rx.attachingShort': 'Attaching…',
  /** {number} is 1, 2, 3 … */
  'cart.rx.attached': 'Prescription {number} attached',

  'orders.title': 'My medicine orders',
  'orders.empty': 'No medicine orders yet',
  'orders.medicines': { one: '{count} medicine', other: '{count} medicines' },

  'order.notFound': 'Order not found',
  'order.toYourAddress': 'To your address',
  'order.replayed': 'This order had already been placed by your earlier attempt; nothing was placed twice.',
  'order.rx.pendingWithFile': 'This order has medicines that need a prescription. The pharmacist checks your prescription before packing; if it is not approved, you are refunded.',
  'order.rx.pending': 'This order has medicines that need a prescription. The pharmacist checks it before packing and may contact you; if it is not approved, you are refunded.',
  'order.rx.approved': 'The pharmacist approved the prescription medicines.',
  /** {reason} is what the pharmacist wrote. */
  'order.rx.rejectedWhy': 'The pharmacist could not approve the prescription medicines: “{reason}” Any payment is refunded below.',
  'order.rx.rejected': 'The pharmacist could not approve the prescription medicines. Any payment is refunded below.',
  'order.abandoned': 'This order was cancelled because it was not paid in time. If money was taken from you, it goes back to your Jansetu wallet. You can order again.',
  'order.paid': 'Payment received. The pharmacy will prepare your order.',
  /** {date} is a date and time. */
  'order.cancelAsked.onlineOn': 'You asked to cancel this order on {date}. The pharmacy or Jansetu will confirm it; once cancelled, what you paid goes back to your Jansetu wallet.',
  'order.cancelAsked.offlineOn': 'You asked to cancel this order on {date}. The pharmacy or Jansetu will confirm it; once cancelled, Jansetu will arrange your refund.',
  'order.cancelAsked.online': 'You asked to cancel this order. The pharmacy or Jansetu will confirm it; once cancelled, what you paid goes back to your Jansetu wallet.',
  'order.cancelAsked.offline': 'You asked to cancel this order. The pharmacy or Jansetu will confirm it; once cancelled, Jansetu will arrange your refund.',
  /** {note} is what the pharmacy wrote. */
  'order.cancelRefusedWhy': 'The pharmacy could not cancel this order: “{note}”',
  'order.cancelRefused': 'The pharmacy could not cancel this order.',
  'order.cancel': 'Cancel this order',
  'order.askCancel': 'Yes, ask to cancel',
  'order.cancelNow': 'The order is cancelled now. If a payment was still going through, it goes back to your Jansetu wallet.',
  'order.cancelPaidOnline': 'This order is paid, so the pharmacy or Jansetu confirms the cancellation first. Then what you paid goes back to your Jansetu wallet (you can move it to your card/UPI).',
  'order.cancelPaidOffline': 'This order is paid, so the pharmacy or Jansetu confirms the cancellation first, and Jansetu arranges your refund.',
  /** {deadline} is a date and time. */
  'order.unpaidBy': 'This order is not paid yet. Pay by {deadline}, or it is cancelled.',
  /** {minutes} is a number. */
  'order.unpaidWithin': 'This order is not paid yet. Pay within {minutes} minutes, or it is cancelled.',
  /** {amount} is money. */
  'order.pay': 'Pay {amount}',
  /** Shown on the payment page; {number} is the order number. */
  'order.payDescription': 'Medicines, order {number}',
  'order.refund.title': 'Refund',
  'order.refund.toSource': 'Send it to my card/UPI instead',
  'order.refund.toSourceYes': 'Yes, send it to my card/UPI',
  'order.refund.toSourceConsequence': 'The refund leaves your Jansetu wallet and goes back to the card or UPI you paid with. Banks can take 5–7 working days.',
  'order.refund.used': 'Your wallet no longer holds this refund (it was used), so it can’t be sent to your card/UPI.',
} as const;
