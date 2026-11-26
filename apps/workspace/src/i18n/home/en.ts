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

  /** Money line of a day: {amount}s are formatted. */
  /** r37b: received that day. */
  'money.collected': 'Collected {amount}',
  'money.cash': 'cash {amount}',
  'money.upi': 'UPI {amount}',
  'money.card': 'card {amount}',
  'money.wallet': 'wallet {amount}',
  'money.online': 'online {amount}',
  'money.other': 'other {amount}',
  /** r37b: money still to collect from patients. */
  'money.unpaid': 'to collect {amount}',
  'money.label': 'Money of the day',

  'register.title': 'Today’s register',
  'register.caption': 'The day’s visits, sales and tests, in the order they were made',
  'register.none': 'Nothing yet today',
  'register.noneText': 'Each visit, sale and test of the day is listed here.',
  'register.all': 'See all of today',
  'register.time': 'Time',
  'register.item': 'Item',
  'register.amount': 'Amount',
  'register.paid': 'Paid',
  /** {method}: cash, UPI, wallet… */
  'register.paidBy': 'Paid ({method})',
  'register.unpaid': 'Not paid',
  /** r37b: an earlier day's entry paid today; {date}: the day it was made. */
  'register.paidTodayMade': 'paid today · made {date}',
  /** A row without a patient name. */
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
  /** Bookings (doctor or lab) that are coming up. */
  'pending.bookingsAwaiting': { one: '{count} booking coming up', other: '{count} bookings coming up' },
  'pending.labReportsReady': { one: '{count} lab report ready', other: '{count} lab reports ready' },
  'pending.lowStock': { one: '{count} medicine low in stock', other: '{count} medicines low in stock' },
  /** r37b: card payments of bookings not yet confirmed. */
  'pending.cardPaymentsWaiting': { one: '{count} card payment waiting', other: '{count} card payments waiting' },
  /** r37b: the server could not read that list just now (only that line). */
  'pending.failed.prescriptionsToReview': 'Prescriptions to review: couldn’t load',
  'pending.failed.unpaidCounterSales': 'Unpaid sales: couldn’t load',
  'pending.failed.cardPaymentsWaiting': 'Card payments waiting: couldn’t load',
  'pending.failed.bookingsAwaiting': 'Bookings coming up: couldn’t load',
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

  'new.title': 'New',
  'new.findTitle': 'Find patient',
  'new.intro': 'Who is it for? Type the phone number or the name.',
  'new.step1': 'Step 1 of 2: the patient',
  'new.step2': 'Step 2 of 2: what does {name} need?',
  'new.same': 'Same patient: {patient}',
  'new.continueSame': 'Continue with {name}',
  'new.another': 'Another patient',
  'new.search': 'Phone number or name',
  'new.searchHint': 'A 10-digit mobile number finds the patient fastest.',
  'new.find': 'Find',
  'new.results': 'Patients found',
  /** {patient}: name and phone. */
  'new.choose': 'Choose {patient}',
  'new.noneFound': 'Not found. Add the patient below.',
  'new.addTitle': 'New patient',
  'new.phone': 'Mobile number (10 digits)',
  'new.name': 'Name',
  'new.phoneError': 'Enter a 10-digit mobile number.',
  'new.nameError': 'Enter the patient’s name (at most {max} characters).',
  'new.next': 'Next',
  'new.changePatient': 'Change patient',
  'new.what': 'What does the patient need?',
  /** The four kinds of visit. */
  'new.doctor': 'Doctor',
  'new.doctorText': 'Book a doctor for now or a later time',
  'new.video': 'Doctor now (video)',
  'new.videoText': 'A doctor on video, right now',
  'new.lab': 'Lab test',
  'new.labText': 'A test at a lab, or sample collection',
  'new.medicines': 'Medicines',
  'new.medicinesText': 'Sell medicines from your stock',

  'today.title': 'Today',
  'today.intro': 'Everything of a day: visits, sales and tests, the money and what is waiting.',
  'today.date': 'Day',
  'today.search': 'Search by name or ref',
  'today.count': { one: '{count} item', other: '{count} items' },
  'today.noMatch': 'Nothing matches this search.',
  'today.older': 'Earlier days: change the day above.',
  'today.more': 'Show more',
  /** The server lists a very busy day only in part. */
  'today.truncated': 'This day has too many rows to list them all here. The money above is the whole day’s.',
} as const;
