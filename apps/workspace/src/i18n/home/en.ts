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
  'big.label': 'What do you want to do?',

  /** The day's money: {amount}s are formatted. r37b: money received that day. */
  'money.collectedToday': 'Collected today {amount}',
  /** An earlier day; {date}: that day. */
  'money.collectedOn': 'Collected on {date}: {amount}',
  /** Only the methods that took money, joined by " · ". */
  'money.cash': 'Cash {amount}',
  'money.upi': 'UPI {amount}',
  'money.card': 'Card {amount}',
  'money.wallet': 'Wallet {amount}',
  'money.online': 'Online {amount}',
  'money.other': 'Other {amount}',
  /** r37b: money still to collect from patients. */
  'money.toCollect': 'To collect {amount}',
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
  /** A row (not a wallet top-up) without a patient name. */
  'register.noName': 'Customer',
  'register.loading': 'Loading the register…',

  'method.cash': 'cash',
  'method.upi': 'UPI',
  'method.card': 'card',
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
  /** r37b: the server could not read that list just now (only that line). */
  'pending.failed.prescriptionsToReview': 'Prescriptions to review: couldn’t load',
  'pending.failed.unpaidCounterSales': 'Unpaid sales: couldn’t load',
  'pending.failed.bookingsAwaiting': 'Bookings waiting for payment: couldn’t load',
  'pending.failed.labReportsReady': 'Lab reports ready: couldn’t load',
  'pending.failed.lowStock': 'Low stock: couldn’t load',

  'todos.title': 'My to-dos',
  'todos.add': 'Add',
  'todos.new': 'New to-do',
  'todos.newHint': 'For example: Call supplier for Dolo 650',
  'todos.none': 'No to-dos. Add one above.',
  'todos.textError': 'Write the to-do (at most {max} characters).',
  /** {who}: who added it. */
  'todos.by': 'Added by {who}',
  /** r37b: the pharmacy has 500 open to-dos. */
  'todos.limit': 'There are 500 open to-dos. Tick the done ones, then add this one.',
  'todos.keyReused': 'This to-do was sent before in another form. Tap Add to add it now.',
  'todos.changed': 'This to-do was changed meanwhile. The list shows it as it is now.',
  'todos.loading': 'Loading the to-dos…',

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
} as const;
