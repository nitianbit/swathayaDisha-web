/**
 * WQ54 (P1): the simple pharmacy home (SIMPLE_DESIGN_PLAN_2026-11-26): for a counter clerk used to a paper register.
 * Short, plain words. A comment above a key is the translator's note. Amounts arrive formatted ("₹320.00"); names, phones
 * and times are values, never words.
 */
export default {
  /** The four big buttons. */
  'big.new': '+ New',
  'big.find': 'Find patient',
  'big.sell': 'Sell medicines',
  'big.today': 'Today',
  /** WQ55: a lab's "New bill" (an in-house bill). */
  'big.bill': 'New bill',
  'big.label': 'What do you want to do?',

  /** The day's money: {amount}s are formatted. r37b: money received that day. */
  'money.collectedToday': 'Collected today {amount}',
  /** An earlier day; {date}: that day. */
  'money.collectedOn': 'Collected on {date}: {amount}',
  /** Only the methods that took money, joined by " · ". */
  'money.cash': 'Cash {amount}',
  'money.upi': 'UPI {amount}',
  'money.card': 'Card {amount}',
  /** r38: a lab's bills may be paid by bank transfer. */
  'money.bank': 'Bank {amount}',
  'money.wallet': 'Wallet {amount}',
  'money.online': 'Online {amount}',
  'money.other': 'Other {amount}',
  /** r37b: money still to collect from patients. */
  'money.toCollect': 'To collect {amount}',
  /** r38b: money returned that day (its own line, only when there was any). */
  'money.refundedToday': 'Refunded today {amount}',
  'money.refundedOn': 'Refunded on {date}: {amount}',
  'money.label': 'Money of the day',

  'register.title': 'Today’s register',
  'register.caption': 'The day’s visits, sales and tests',
  'register.none': 'Nothing yet today',
  'register.noneText': 'Each visit, sale and test of the day is listed here.',
  'register.all': 'See all of today',
  'register.paid': 'Paid',
  /** {method}: cash, UPI, wallet… */
  'register.paidBy': 'Paid ({method})',
  'register.unpaid': 'Not paid',
  /** r37b: an earlier day's entry paid today; {date}: the day it was made. */
  'register.paidTodayMade': 'paid today · made {date}',
  /** A row: {who} the patient, {what} the line. */
  'register.line': '{who}: {what}',
  /**
   * WQ55b: a desk booking's money is on its bill: not yet paid there (r38b: a paid bill marks the booking paid), no bill yet,
   * or (the bill not known here) to pay on its bill.
   */
  'register.onBill': 'Pay on its bill',
  'register.billUnpaid': 'Bill not paid',
  'register.noBill': 'No bill yet',
  /** A row (not a wallet top-up) without a patient name. */
  'register.noName': 'Customer',
  'register.loading': 'Loading the register…',

  'method.cash': 'cash',
  'method.upi': 'UPI',
  'method.card': 'card',
  'method.bank': 'bank',
  'method.wallet': 'wallet',
  'method.online': 'online',
  'method.other': 'other',

  'pending.title': 'Waiting for you',
  'pending.none': 'Nothing is waiting.',
  'pending.prescriptionsToReview': { one: '{count} prescription to review', other: '{count} prescriptions to review' },
  'pending.unpaidCounterSales': { one: '{count} unpaid sale', other: '{count} unpaid sales' },
  /** r37c: bookings waiting for their payment, by kind (the last when the kind is not known). */
  'pending.doctorPayments': { one: '{count} doctor booking waiting for payment', other: '{count} doctor bookings waiting for payment' },
  'pending.labPayments': { one: '{count} lab test waiting for payment', other: '{count} lab tests waiting for payment' },
  'pending.bookingsAwaiting': { one: '{count} booking waiting for payment', other: '{count} bookings waiting for payment' },
  'pending.labReportsReady': { one: '{count} lab report ready', other: '{count} lab reports ready' },
  'pending.lowStock': { one: '{count} medicine low in stock', other: '{count} medicines low in stock' },
  /** WQ55 (r38): a lab's waiting work. */
  'pending.samplesToCollect': { one: '{count} sample to collect today', other: '{count} samples to collect today' },
  /** Reports due, by step (the last when the server does not split them). */
  'pending.reportsToUpload': { one: '{count} report to upload', other: '{count} reports to upload' },
  'pending.reportsToRelease': { one: '{count} report to release', other: '{count} reports to release' },
  'pending.reportsDue': { one: '{count} report due', other: '{count} reports due' },
  'pending.unpaidBills': { one: '{count} unpaid bill', other: '{count} unpaid bills' },
  /** r38b: desk walk-ins without a bill yet. */
  'pending.deskUnbilled': { one: '{count} walk-in without a bill', other: '{count} walk-ins without a bill' },
  'pending.failed.deskUnbilled': 'Walk-ins without a bill: couldn’t load',
  'pending.consultationsWaiting': { one: '{count} consultation waiting', other: '{count} consultations waiting' },
  /** r37b: the server could not read that list just now (only that line). */
  'pending.failed.samplesToCollect': 'Samples to collect: couldn’t load',
  'pending.failed.reportsDue': 'Reports due: couldn’t load',
  'pending.failed.unpaidBills': 'Unpaid bills: couldn’t load',
  'pending.failed.bookingsAwaitingPayment': 'Doctor bookings waiting for payment: couldn’t load',
  'pending.failed.consultationsWaiting': 'Consultations waiting: couldn’t load',
  'pending.failed.prescriptionsToReview': 'Prescriptions to review: couldn’t load',
  'pending.failed.unpaidCounterSales': 'Unpaid sales: couldn’t load',
  'pending.failed.bookingsAwaiting': 'Bookings waiting for payment: couldn’t load',
  'pending.failed.labReportsReady': 'Lab reports ready: couldn’t load',
  'pending.failed.lowStock': 'Low stock: couldn’t load',

  'todos.title': 'My to-dos',
  'todos.add': 'Add',
  'todos.new': 'New to-do',
  'todos.newHint': 'For example: Call supplier for Dolo 650',
  /** WQ55: a lab's example. */
  'todos.newHintLab': 'For example: Call the courier for the home samples',
  'todos.none': 'No to-dos. Add one above.',
  'todos.textError': 'Write the to-do (at most {max} characters).',
  /** {who}: who added it. */
  'todos.by': 'Added by {who}',
  /** r37b: the pharmacy has 500 open to-dos. */
  'todos.limit': 'There are 500 open to-dos. Tick the done ones, then add this one.',
  'todos.keyReused': 'This to-do was sent before in another form. Tap Add to add it now.',
  'todos.changed': 'This to-do was changed meanwhile. The list shows it as it is now.',
  'todos.loading': 'Loading the to-dos…',

  /** WQ55: a lab member asked to do (or read) what their permissions do not allow: never a blank screen. */
  'askOwner': 'Ask the lab owner to allow this.',
  'askOwnerVisits': 'To start visits or bills here, ask the lab owner to allow them.',

  /** No internet: what was typed stays. */
  'offline': 'No internet connection. Check it, then tap Try again. Nothing you typed is lost.',
  'tryAgain': 'Try again',

  /** WQ54b: back to this home, from + New, Today and a flow opened from + New. */
  'home': 'Home',
  /** A flow opened from + New names its patient; {who}: name and phone (or the phone). */
  'visit.patient': 'Patient: {who}',
  'visit.change': 'Change',
  /** WQ54c: a family member of the phone's owner; {relation}: son, mother…; {holder}: the owner's (masked) name. */
  'visit.family': '{name} ({relation} of {holder})',

  'new.title': 'New',
  'new.findTitle': 'Find patient',
  'new.findIntro': 'Find a patient to see or start a visit.',
  'new.step1': 'Step 1 of 2: who is the patient?',
  /** {name}: the patient's name. */
  'new.step2': 'Step 2 of 2: what does {name} need?',
  'new.step2NoName': 'Step 2 of 2: what does the patient need?',
  /** WQ54c: one box: digits are a phone number, letters a name. */
  'new.search': 'Phone number or name',
  'new.searchHint': 'Type the 10-digit number or the name, then tap Find.',
  'new.searchError': 'Type a 10-digit mobile number or at least 2 letters of the name.',
  'new.find': 'Find',
  'new.results': 'Patients found',
  'new.noneByName': 'No patient with this name here. Find them by their phone number.',
  /** A patient whose name this pharmacy may not show. */
  'new.noName': 'Name not given',
  /** WQ54c: {name}: the account holder's masked name. */
  'new.onJansetu': 'This number is on Jansetu: {name}',
  'new.newNumber': 'This number is new to Jansetu.',
  'new.whoIs': 'Who is the patient?',
  'new.thisPerson': 'This person',
  'new.someoneElse': 'Someone else (family member)',
  'new.again': 'Type the number again',
  'new.phoneError': 'Enter a 10-digit mobile number.',
  'new.next': 'Next',
  /** WQ54b: a small second choice, for 30 minutes after that patient's visit; {name}: name (or phone). */
  'new.sameAgain': 'Same patient again: {name}',
  'new.changePatient': 'Change patient',
  'new.what': 'What does the patient need?',
  /** WQ54c: Find patient lists the number's visits of today. */
  'new.todayVisits': 'Visits today',
  'new.noVisits': 'No visits today.',
  /** The four kinds of visit, in plain words. */
  'new.video': 'See a doctor now (video)',
  'new.doctor': 'Book a doctor for later',
  'new.lab': 'Book a lab test',
  'new.medicines': 'Sell medicines',
  /** WQ55: a lab's kinds of visit. */
  'new.labDesk': 'Lab test at the desk',
  'new.homeCollection': 'Home collection',
  'new.labDoctor': 'Book a doctor',
  'new.bill': 'Bill',
  /** WQ55: a lab finds a patient by phone only. */
  'new.phoneOnly': 'Patient’s mobile number',
  'new.phoneOnlyHint': 'Type the 10-digit number, then tap Find.',

  'today.title': 'Today',
  'today.intro': 'Everything of a day: visits, sales and tests, the money and what is waiting.',
  'today.date': 'Day',
  'today.search': 'Search the day by name, phone or ref',
  'today.find': 'Search',
  'today.clear': 'Show all',
  /** {min}: the fewest letters or digits a search takes. */
  'today.searchError': 'Type at least {min} letters or digits.',
  'today.count': { one: '{count} item', other: '{count} items' },
  'today.noMatch': 'Nothing matches this search.',
  'today.more': 'Show more',
  /** The server lists a very busy day only in part. */
  'today.truncated': 'This day has too many rows to list them all here. The money above is the whole day’s.',

  /** r37c: a register row's line; names (medicines, tests, doctors) and times are data. {first}: the first name. */
  'what.more': '{first} +{more} more',
  'what.counter': 'Counter sale',
  'what.online': 'Online order',
  'what.labTests': 'Lab tests',
  'what.consultation': 'Consultation',
  /** An instant consultation (in place of its time). */
  'what.now': 'now',
  'what.topup': 'Wallet top-up',
  /** WQ55: a lab's bill without a first line. */
  'what.bill': 'Bill',
  /** WQ55b: a bill on its own; {items}: its first item (+N more). */
  'what.billOf': 'Bill · {items}',
  /** r38: a lab test collected at home. */
  'what.home': 'home collection',
} as const;
