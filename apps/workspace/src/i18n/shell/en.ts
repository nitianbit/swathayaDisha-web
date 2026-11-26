/**
 * Workspace shell words (docs/I18N_PLAN.md §4, round 6d): the side navigation, sign-in, home, the session notices and
 * the app frame. Shared words (Back, Try again …) are `shared` from `@jansetu/ui`. "Jansetu" stays in Latin letters and
 * is not in the catalogue. A comment above a key is the translator's note.
 */
export default {
  // ── Side navigation: one page name each (a short menu entry) ──
  'nav.activityLog': 'Activity log',
  'nav.appointments': 'Appointments',
  'nav.bills': 'Bills',
  'nav.bookConsultation': 'Book consultation',
  'nav.bookLabTest': 'Book lab test',
  'nav.bookedConsultations': 'Booked consultations',
  'nav.bookedLabTests': 'Booked lab tests',
  'nav.branches': 'Branches',
  'nav.clinics': 'Clinics',
  'nav.consultNow': 'Consult now',
  'nav.consultations': 'Consultations',
  'nav.doctors': 'Doctors',
  'nav.earnings': 'Earnings',
  'nav.externalCancellations': 'External cancellations',
  'nav.finance': 'Finance',
  'nav.frontDesk': 'Front desk',
  'nav.home': 'Home',
  'nav.labBookings': 'Lab bookings',
  'nav.labTestsBooked': 'Lab tests booked',
  'nav.labsAndClinics': 'Labs and clinics',
  'nav.lowStock': 'Low stock',
  'nav.orderCancellations': 'Order cancellations',
  'nav.orders': 'Orders',
  /** WQ50: a sale at the pharmacy's counter. */
  'nav.newSale': 'New sale',
  /** WQ54: the day's register. */
  'nav.today': 'Today',
  /** WQ54: on a phone, the menu behind one button. */
  /** WQ54d: the phone header's two buttons, a short word under each icon. */
  'shell.menu': 'Menu',
  'shell.close': 'Close',
  'nav.payouts': 'Payouts',
  'nav.pharmacies': 'Pharmacies',
  'nav.pharmacyWallets': 'Pharmacy wallets',
  'nav.prescriptionReview': 'Prescription review',
  'nav.testsAndPackages': 'Tests and packages',
  'nav.servicesAndPrices': 'Services and prices',
  'nav.profile': 'Profile',
  'nav.quality': 'Quality',
  'nav.referralEarnings': 'Referral earnings',
  'nav.refundsNeedingAttention': 'Refunds needing attention',
  'nav.schedule': 'Schedule',
  'nav.settings': 'Settings',
  'nav.settlements': 'Settlements',
  'nav.slots': 'Slots',
  'nav.staff': 'Staff',
  'nav.stock': 'Stock',
  'nav.suppliers': 'Suppliers',
  'nav.wallet': 'Wallet',
  /** Admin: wallet withdrawals to the bank waiting for a person. */
  'nav.withdrawals': 'Withdrawals',
  /** WQ48: card top-ups whose payment was disputed. */
  'nav.cardDisputes': 'Card disputes',
  /** Headings above groups of menu entries. */
  'nav.section.admin': 'Admin',
  'nav.section.billing': 'Billing',
  'nav.section.clinic': 'Clinic',
  'nav.section.doctor': 'Doctor',
  'nav.section.lab': 'Lab',
  'nav.section.organisation': 'Organisation',
  'nav.section.pharmacy': 'Pharmacy',

  // ── App frame ──
  /** Link for keyboard users, jumps past the menu. */
  'shell.skip': 'Skip to content',
  /** After the brand name: "Jansetu Workspace". */
  'shell.workspace': 'Workspace',
  /** Name of the side menu, read by screen readers. */
  'shell.nav': 'Main',
  'shell.signOut': 'Sign out',
  /** The person's role, under their name. */
  'shell.role.admin': 'Admin',
  'shell.role.pharmacy': 'Pharmacy',
  'shell.role.specialist': 'Doctor',
  'app.notFound.title': 'Page not found',
  /** While a saved sign-in is resumed. */
  'app.signingIn': 'Signing you in…',

  // ── Home ──
  'home.welcome': 'Welcome, {name}',
  'home.question': 'What would you like to do?',
  /** {partner} is the lab or clinic name. */
  'home.questionAt': '{partner} · What would you like to do?',
  'home.suspended': 'This account is suspended. Contact Jansetu support.',
  'home.unverified': '{partner} is waiting for verification by Jansetu. The workspace opens once it is verified.',
  'home.empty.title': 'Nothing here yet',
  'home.empty.body': 'Tools for your role are being added.',

  // ── Sign-in ──
  'login.title': 'Sign in',
  'login.roles': 'I am signing in as',
  'login.role.pharmacy': 'Pharmacy staff',
  'login.role.partner': 'Lab or clinic staff',
  'login.role.specialist': 'Doctor',
  'login.role.admin': 'Admin',
  'login.identifier': 'Mobile number or email',
  'login.identifier.hint': 'We will send a 6-digit code by SMS to a mobile number, or to an email address.',
  'login.identifier.missing': 'Enter a 10-digit mobile number or an email address.',
  'login.send': 'Send code',
  /** Countdown before another code can be sent; {seconds} is a number. */
  'login.sendIn': 'Send code in {seconds}s',
  'login.chooseAnother': 'Choose another workspace',
  'login.choose.email': 'Your email belongs to several workspaces. Which one do you want to open?',
  'login.choose.number': 'Your number belongs to several workspaces. Which one do you want to open?',
  'login.choose.missing': 'Choose the workspace to open.',
  /** Under a workspace name: its kind (Lab, Clinic) and the person's role in it. */
  'login.choice': '{kind} · {role}',
  'login.choice.solo': '{kind} · single-doctor practice · {role}',
  'login.choice.owner': 'Owner',
  'login.choice.staff': 'Staff',
  'login.open': 'Open workspace',
  'login.startAgain': 'Start again',
  'login.expired': 'This sign-in has expired. Request a new code to continue.',
  'login.code': '6-digit code',
  'login.code.missing': 'Enter the 6-digit code.',
  'login.verify': 'Verify and sign in',
  'login.resend': 'Resend code',
  'login.resendIn': 'Resend code in {seconds}s',
  'login.change': 'Change number or email',

  // ── Session notices (shown on the sign-in screen) ──
  'session.ended': 'Your session has ended. Please sign in again.',
  'session.someoneElse': 'Someone else signed in to the workspace in this browser. Please sign in again.',
  'session.otherTab': 'You signed out in another tab.',
  /** After a doctor chose Bills or Services and prices: their clinic's workspace is a separate sign-in. */
  'session.toClinicWorkspace': 'Sign in as “Lab or clinic staff” with your mobile number, then choose your clinic.',
  'session.notStaff': 'This account cannot use the staff workspace.',
  'session.incompleteProfile': 'Sign-in returned an incomplete profile. Please try again.',
  'session.noSession': 'Sign-in did not return a session. Please try again.',
  'session.secureStore': 'This phone could not save your sign-in. Please try again.',
  'session.noWorkspace': 'None of your lab or clinic workspaces is available.',
  'session.partnerSameOrigin': 'Lab and clinic sign-in needs the workspace served from the Jansetu site itself (the same-origin build). Ask your administrator for the right address.',
  'session.signedOutHere': 'You are signed out on this device. The server has not confirmed it yet: the workspace keeps trying, and nobody is signed back in here until it does.',
  'session.phoneNotCleared': 'This phone could not clear its saved sign-in yet; it will be cleared when the app next opens.',
  'session.phoneNotSignedOut': 'This phone could not finish signing out yet. Keep the app open for a moment while it tries again.',

  // ── Errors and edits ──
  /** After the server's own sentence (its full stop removed). */
  'errors.indexesOutdated': '{message}: ask the Jansetu team',
  /** {fields} names the changed fields, e.g. "services and holidays". */
  'draft.stale': 'Someone else changed the {fields} while you were editing. The form now shows what is saved; make your change again if it is still needed.',
  /** A list of field names: "services, hours and holidays". */
  'draft.fields': '{list} and {last}',
  /** In place of {fields} when no field is named. */
  'draft.thisRecord': 'this record',
  'draft.recordChanged': 'Someone else changed this while you were saving, so nothing was saved. The form now shows what is saved; check it and save again.',
} as const;
