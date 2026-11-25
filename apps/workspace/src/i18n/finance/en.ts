/**
 * Workspace finance words (docs/I18N_PLAN.md §3.2, round 6d): partner finance, the admin settlement accounts and the
 * payouts queue, and their shared building blocks. A comment above a key is the translator's note. Amounts, dates,
 * names, references and bank details are values, never words.
 */
export default {
  /**
   * Refusal while another money action runs. {what} names the thing in the screen's own words ("account", "booking",
   * "wallet", …).
   */
  'busy.another': 'Another action on this {what} is still running. Wait for it to finish, then try again.',
  /** {what} in "Another action on this {what} is still running". */
  'busy.what.account': 'account',
  /** {what} in "Another action on this {what} is still running". */
  'busy.what.payoutList': 'payout list',

  /** Section heading and column: the money due to the account. */
  'balance.title': 'Balance',
  /** Screen-reader name of the balance cards. */
  'summary.label': 'Balance and totals',
  /** The balance is below zero: the account owes money back to Jansetu. */
  'summary.balanceOwed': 'Balance (owed back)',
  'summary.balanceDue': 'Balance due',
  'summary.earned': 'Earned',
  /** Earnings taken back (refunds, cancellations). */
  'summary.reversed': 'Reversed',
  'summary.paidOut': 'Paid out',
  'summary.adjustments': 'Adjustments',
  /** {destination} is the bank or UPI line the payout went to. */
  'summary.lastPayout': 'Last payout: {amount} on {date} (reference {reference}) to {destination}.',
  'summary.noPayout': 'No payout yet.',
  'summary.formula': 'Balance = earnings − reversals − payouts ± adjustments.',

  /** Section heading, filter and column: where payouts are sent (bank account or UPI ID). */
  'details.title': 'Payout details',
  'details.none': 'No payout details',
  'details.noneYet': 'No payout details yet.',
  /** The payout details' version number, after their state ("Verified · version 2"). */
  'details.version': 'version {version}',
  /** One line naming a UPI destination. */
  'details.upiLine': 'UPI {upiId}',
  /** Label: the kind of destination (bank account or UPI). */
  'details.paidTo': 'Paid to',
  'details.bankAccount': 'Bank account',
  'details.accountHolder': 'Account holder',
  'details.accountNumber': 'Account number',
  /** Indian bank branch code. */
  'details.ifsc': 'IFSC',
  'details.bank': 'Bank',
  'details.upi': 'UPI',
  'details.upiId': 'UPI ID',
  'details.lastChanged': 'Last changed',
  'details.verified': 'Verified',
  /** Button, and the name of the form. */
  'details.change': 'Change payout details',
  'details.add': 'Add payout details',

  'period.badDates': 'Enter real dates.',
  'period.endsBeforeStart': 'The period ends before it starts.',

  'statement.title': 'Statement',
  /** Screen-reader name of the two date fields. */
  'statement.period': 'Statement period',
  'statement.from': 'From (India date)',
  'statement.to': 'To (India date)',
  'statement.intro': 'Newest first. “Balance after” is the whole account’s balance right after each entry, whatever the period shown.',
  'statement.loading': 'Loading the statement…',
  'statement.empty': 'No entries',
  'statement.emptyPeriod': 'Nothing was recorded in this period.',
  'statement.emptyAll': 'Earnings, payouts and adjustments appear here.',
  'statement.caption': 'Statement entries, newest first',
  'statement.column.date': 'Date (India time)',
  'statement.column.description': 'Description',
  'statement.column.type': 'Type',
  'statement.column.balanceAfter': 'Balance after',
  'statement.olderFailed': 'Could not load older entries: {error}',
  'statement.older': 'Show older entries',

  /** Column: a payout's bank reference (UTR). */
  'column.reference': 'Reference',

  'csv.notAFile': 'The server did not return the statement file. Try again.',
  /** Inside "Download CSV ({period})". */
  'csv.period.fromTo': 'from {from} to {to}',
  /** Inside "Download CSV ({period})". */
  'csv.period.from': 'from {from}',
  /** Inside "Download CSV ({period})". */
  'csv.period.to': 'to {to}',
  /** Inside "Download CSV ({period})". */
  'csv.period.all': 'all entries',
  'csv.download': 'Download CSV ({period})',
  /** Link to save the downloaded file again; {file} is its name. */
  'csv.saveAgain': 'Save {file} again',
  'csv.failed': 'Could not download the statement: {error}',

  'payouts.title': 'Payouts',
  'payouts.loading': 'Loading payouts…',
  'payouts.empty': 'No payouts',
  'payouts.older': 'Show older payouts',
  'payouts.column.paidOn': 'Paid on',
  'payouts.column.account': 'Account',
  /** Column: bank transfer, UPI, … */
  'payouts.column.method': 'Method',
  'payouts.column.sentTo': 'Sent to',
  'payouts.column.actions': 'Actions',
  'payouts.detailsVersion': 'Details version {version}',
  'payouts.caption.partner': 'Payouts, newest first',
  'payouts.caption.account': 'Payouts of this account, newest first',
  'payouts.emptyText.partner': 'Transfers Jansetu records appear here.',
  'payouts.emptyText.account': 'Payouts recorded for this account appear here.',

  'events.title': 'Finance events',
  'events.loading': 'Loading finance events…',
  'events.empty': 'No finance events',
  'events.emptyText': 'Changes to payout details, payouts and adjustments appear here.',
  'events.older': 'Show older events',
  'event.action.detailsChanged': 'Payout details changed',
  'event.action.detailsVerified': 'Payout details verified',
  'event.action.payoutRecorded': 'Payout recorded',
  'event.action.payoutVoided': 'Payout voided',
  'event.action.adjustmentPosted': 'Adjustment posted',
  /** A change of payout details to a UPI ID. */
  'event.upi': 'UPI {upiId}',
  /** A change of payout details to a bank account. */
  'event.bank': 'Bank',
  'event.bankIfsc': 'Bank, IFSC {ifsc}',
  /** {last4}: the account number's last four digits. */
  'event.bankLast4': 'Bank, account ending {last4}',
  'event.bankIfscLast4': 'Bank, IFSC {ifsc}, account ending {last4}',
  /** The payout details' version that was verified. */
  'event.versionTitle': 'Version {version}',
  'event.reference': 'reference {reference}',
  'event.paidOn': 'paid on {date}',
  /** Who made a change. */
  'event.by.admin': 'Jansetu admin',
  'event.by.doctor': 'The doctor',
  'event.by.you': 'You',
  'event.by.member': 'A member',

  /** Above a list: how many rows exist and how many are shown. */
  'list.count': '{total} in all · showing {shown}',
  'list.moreFailed': 'Could not load more: {error}',
  /** Screen-reader name of a group of filters. */
  'filters.label': 'Filters',

  'form.staleEditing': 'The payout details were changed elsewhere while you were editing (now version {version}). The form shows what is saved now; make your change again if it is still needed.',
  'form.staleSaving': 'The payout details were changed elsewhere while you were saving (now version {version}). Nothing was saved; the form shows what is saved now. Make your change again if it is still needed.',
  'form.staleRace': 'The payout details were changed elsewhere just as you saved, so nothing was saved. The form shows what is saved now; make your change again if it is still needed.',
  'form.mismatch': 'The two account numbers are not the same.',
  'form.notSaved': 'Not saved: {error}',
  'form.lost': 'The answer did not come back ({error}), so the details may or may not have been saved. Check the payout details shown before changing them again.',
  /** Choice: send payouts to a bank account or a UPI ID. */
  'form.payTo': 'Pay to',
  'form.accountName': 'Account holder name',
  'form.accountNumberHint': 'Enter the full number: the saved one is shown masked.',
  'form.accountNumberAgain': 'Account number again',
  'form.bankName': 'Bank name (optional)',
  'form.nameOptional': 'Name (optional)',
  'form.review': 'Review the change',
  /** Name of the confirmation step. */
  'form.confirmLabel': 'Save the payout details',
  /** {destination}: the bank or UPI line. */
  'form.confirm.owner': 'Send payouts to {destination} from now on? Jansetu must verify any change (even to the same details) before the next payout: payouts wait until then. The earlier details stop being used.',
  /** {destination}: the bank or UPI line. */
  'form.confirm.admin': 'Save {destination} as the payout details? They replace the current ones and must be verified again before a payout can be recorded to them.',
  'form.save': 'Save payout details',

  /** Page title (a partner's own finance page). */
  'partner.title': 'Finance',
  'partner.intro': 'Money Jansetu collected online for {name} and paid out. Bills paid at the counter are not part of it.',
  'partner.introUnnamed': 'Money Jansetu collected online for this partner and paid out. Bills paid at the counter are not part of it.',
  'partner.loading': 'Loading finance…',
  'partner.nothingEarned': 'Nothing earned yet',
  'partner.nothingEarnedText': 'Earnings from online bookings appear here once the first one is completed.',
  'partner.destination': 'Where payouts are sent',
  'partner.destinationWarning': 'Any change to these details, even to the same values, must be verified again by Jansetu before the next payout. Payouts wait until then.',
  'partner.noDetailsOwner': 'No payout details yet: add a bank account or UPI ID so Jansetu can pay out the balance.',
  'partner.unverified': 'Jansetu has not verified these details yet; no payout is made until it has.',
  'partner.ownerOnly': 'Only an owner can change where payouts are sent.',
  'partner.saved': 'Payout details saved (version {version}). They wait for Jansetu’s verification; no payout is made until then.',

  /** Admin: a payouts list for one account, when its name is not known. {id}: the account id's last characters. */
  'queue.accountShort': 'Account …{id}',
  'queue.voided': 'Payout {reference} ({amount}) is voided; {amount} is back in the account’s balance.',
  'queue.intro': 'Transfers recorded for labs, clinics and doctors, newest recorded first. Void one recorded by mistake.',
  /** Status filter: every state. */
  'queue.all': 'All',
  /** Date filter: payouts paid on or after this date. */
  'queue.paidFrom': 'Paid from',
  /** Date filter: payouts paid on or before this date. */
  'queue.paidTo': 'Paid to',
  /** The list shows one account's payouts only. */
  'queue.only': 'Only {account}.',
  /** The list shows one account's payouts only. {id}: the account id's last characters. */
  'queue.onlyUnnamed': 'Only account …{id}.',
  'queue.everyAccount': 'Show every account',
  'queue.noMatch': 'No payout matches these filters.',
  'queue.emptyText': 'Payouts recorded from an account appear here.',
  'queue.count': { one: '{count} payout · showing {shown}', other: '{count} payouts · showing {shown}' },
  'queue.caption': 'Payouts, newest recorded first',
  /** Button: cancel a payout recorded by mistake. */
  'queue.void': 'Void',
  'queue.voidReason': 'Why is it voided?',
  'queue.voidConfirm': 'Void the payout',
  'queue.voidConsequence': 'Void the payout of {amount} paid on {date} (reference {reference})? It stays listed as voided and {amount} is credited back to {account}’s balance. Do this only if the transfer did not reach them or came back. It cannot be undone.',
  'queue.voidConsequenceUnnamed': 'Void the payout of {amount} paid on {date} (reference {reference})? It stays listed as voided and {amount} is credited back to the account’s balance. Do this only if the transfer did not reach them or came back. It cannot be undone.',

  'settlements.title': 'Settlements',
  'settlements.intro': 'Balances Jansetu owes labs, clinics and doctors from online payments. Record a payout from an account.',
  'settlements.search': 'Search by account name',
  /** Filter: whose account (partner or doctor). */
  'settlements.of': 'Account of',
  'settlements.everyone': 'Everyone',
  /** Payout details filter: any state. */
  'settlements.any': 'Any',
  'settlements.dueOnly': 'Only with a balance due',
  'settlements.loading': 'Loading accounts…',
  'settlements.noMatch': 'No accounts match',
  'settlements.noneDue': 'No account has a balance due with these filters.',
  'settlements.changeFilters': 'Change the search or filters.',
  'settlements.count': { one: '{count} account · due in total {amount}', other: '{count} accounts · due in total {amount}' },
  'settlements.caption': 'Settlement accounts, largest balance first',
  /** Column: whose account (partner or doctor). */
  'settlements.column.of': 'Of',
  'settlements.inactive': 'Inactive',
  /** Screen-reader name of the page buttons. */
  'settlements.pages': 'Pages',
  'settlements.page': 'Page {page} of {pages}',

  'account.back': 'Back to settlements',
  'account.title': 'Settlement account',
  /** After the account's kind in the heading ("Doctor · inactive"). */
  'account.inactive': 'inactive',
  'account.partnerPage': 'Partner page',
  /** Link: the partner's finance page as the partner's owner sees it. */
  'account.asOwner': 'Its finance as owner',
  'account.loading': 'Loading the account…',
  'account.saved': 'Payout details saved as version {version}. Verify them before recording a payout.',
  'account.verify': 'Mark as verified',
  'account.verifyConfirm': 'Yes, these details are verified',
  /** {destination}: the bank or UPI line. A penny drop is a test transfer of ₹1. */
  'account.verifyConsequence': 'Confirm that you checked these exact details (version {version}: {destination}) outside Jansetu, by a penny drop or the account holder’s documents. Payouts can then be recorded to them.',
  'account.verified': 'Payout details version {version} verified.',
  /** {link} is a link named "Payouts". */
  'account.voidFrom': 'A payout recorded by mistake is voided from {link}.',
  'account.moved': 'The account changed while you were reviewing (a payout, adjustment or change of payout details). Check it and review again.',

  /** Amounts from the payout system used before this ledger. */
  'history.title': 'Earlier history',
  'history.loading': 'Loading earlier history…',
  'history.empty': 'No earlier history',
  'history.emptyText': 'No history from before the ledger.',
  'history.intro': 'Imported from the earlier payout system for reference only: not part of the balance and never payable.',
  'history.column.kind': 'Kind',
  'history.column.period': 'Period',
  'history.kind.paidOut': 'Paid out',
  'history.kind.billed': 'Billed',

  'payout.title': 'Record a payout',
  'payout.intro': 'For a transfer you have already made outside Jansetu to the verified details. It lowers the balance and cannot be deleted; a mistake is corrected by voiding it.',
  'payout.done': 'Payout of {amount} recorded (reference {reference}, paid on {date}).',
  'payout.doneEarlier': 'This payout had already been recorded: {amount}, reference {reference}, paid on {date}. Nothing was recorded twice.',
  'payout.abandoned': 'This payout was given up earlier, so it was not recorded and never will be. Record it again if the transfer was made.',
  'payout.discarded': 'The unconfirmed payout was given up: it can never be recorded. Record the transfer again if it was made.',
  'payout.blocked.inactive': 'This settlement account is inactive: no payout can be recorded.',
  'payout.blocked.noDetails': 'There are no payout details to pay to yet.',
  'payout.blocked.unverified': 'The payout details have changed and are not verified: verify them before recording a payout.',
  'payout.blocked.nothingDue': 'Nothing is due on this account.',
  'payout.notRecorded': 'Not recorded: {error}',
  /** A payout whose answer was lost. */
  'payout.unconfirmed': 'Unconfirmed payout',
  'payout.giveUp': 'Give up this payout',
  /** {method}: bank transfer, UPI, … */
  'payout.summary': 'Payout of {amount} by {method}, reference {reference}, paid on {date} (details version {version}).',
  'payout.amount': 'Amount paid (₹)',
  'payout.amountHint': 'At most the balance, {amount}.',
  'payout.method': 'Paid by',
  /** UTR: the bank's transfer reference number. */
  'payout.reference': 'Bank reference (UTR)',
  'payout.paidOn': 'Paid on (India date)',
  'payout.note': 'Note (optional)',
  'payout.changed': 'The payout details or the balance changed while you were reviewing. Check them and review again.',
  'payout.review': 'Review the payout',
  /** Name of the confirmation step. */
  'payout.confirmLabel': 'Record the payout',
  /** {destination}: the bank or UPI line; {method}: bank transfer, UPI, … */
  'payout.confirm': 'Record {amount} paid to {name} at {destination} (details version {version}) by {method} on {date}, reference {reference}? The balance goes from {from} to {to}. A recorded payout cannot be deleted; a mistake is corrected by voiding it.',
  'payout.record': 'Record payout',
  'payout.backToForm': 'Back to the payout',

  'adjust.title': 'Post an adjustment',
  'adjust.intro': 'A correction with a reason: add to the balance, or take from it (a recovery; the balance may go below zero).',
  'adjust.doneAdded': 'Adjustment posted: {amount} added to the balance.',
  'adjust.doneTaken': 'Adjustment posted: {amount} taken from the balance.',
  'adjust.doneEarlierAdded': 'This adjustment had already been posted ({amount} added to the balance). Nothing was posted twice.',
  'adjust.doneEarlierTaken': 'This adjustment had already been posted ({amount} taken from the balance). Nothing was posted twice.',
  'adjust.abandoned': 'This adjustment was given up earlier, so it was not posted and never will be. Post it again if it is still needed.',
  'adjust.discarded': 'The unconfirmed adjustment was given up: it can never be posted. Post it again if it is still needed.',
  'adjust.notPosted': 'Not posted: {error}',
  /** An adjustment whose answer was lost. */
  'adjust.unconfirmed': 'Unconfirmed adjustment',
  'adjust.giveUp': 'Give up this adjustment',
  /** {reason}: what the admin typed. */
  'adjust.summaryAdd': 'Add {amount} to the balance: “{reason}”.',
  /** {reason}: what the admin typed. */
  'adjust.summaryTake': 'Take {amount} from the balance: “{reason}”.',
  'adjust.inactive': 'This settlement account is inactive.',
  'adjust.amountFormat': 'Enter rupees, like 500 or 500.50.',
  'adjust.amountZero': 'Enter an amount above zero.',
  'adjust.amountMax': 'This is above the largest adjustment the server accepts.',
  'adjust.direction': 'Direction',
  'adjust.add': 'Add to the balance',
  'adjust.take': 'Take from the balance (recovery)',
  'adjust.amount': 'Adjustment amount (₹)',
  'adjust.reason': 'Reason (kept with the entry)',
  'adjust.review': 'Review the adjustment',
  /** Name of the confirmation step. */
  'adjust.confirmLabel': 'Post the adjustment',
  /** {name}: the account; {to}: the new balance; {reason}: what the admin typed. */
  'adjust.confirmAdd': 'Add {amount} to the balance of {name}? It goes from {from} to {to}. Reason: “{reason}”.',
  /** {name}: the account; {to}: the new balance; {reason}: what the admin typed. */
  'adjust.confirmTake': 'Take {amount} from the balance of {name}? It goes from {from} to {to}. Reason: “{reason}”.',
  'adjust.belowZero': 'The balance will be below zero: {name} then owes {amount} back.',
  'adjust.forGood': 'An adjustment is recorded for good; a mistake is corrected with another adjustment.',
  'adjust.post': 'Post adjustment',
  'adjust.backToForm': 'Back to the adjustment',

  /** WQ48 (r35 §26.10): the pharmacy's Finance page. */
  'pharmacy.title': 'Finance',
  'pharmacy.intro': 'Your wallet, its card money and your referral earnings in one place. Withdraw card money to your bank here.',
  'pharmacy.loading': 'Loading your finance…',
  'pharmacy.detailsIntro': 'Where withdrawals are sent. Any change, even to the same details, is checked by Jansetu again before the next withdrawal.',
  /** The full account number is never shown; the form asks for it again. */
  'pharmacy.detailsSaved': 'Saved. Jansetu checks these details before your next withdrawal.',
  'pharmacy.referralTitle': 'Referral earnings',
  'pharmacy.referralHint': 'Choose “Referral earnings” in the statement below to see each cut.',

  /** WQ48: the money tiles (pharmacy, lab and doctor Finance). Screen-reader name of the tiles. */
  'tiles.label': 'Money at a glance',
  'tiles.wallet': 'Wallet balance',
  'tiles.now': 'Withdrawable now: {amount}',
  'tiles.later': 'Withdrawable later: {amount}',
  'tiles.owed': 'Owed to Jansetu: {amount}',
  'tiles.onHold': 'The wallet is on hold.',
  /** Card top-ups not spent yet: the only wallet money that can be withdrawn. */
  'tiles.card': 'Card money',
  'tiles.cardText': 'Card top-ups not spent yet. Only this can be withdrawn.',
  'tiles.referral': 'Referral earned',
  'tiles.referralPaid': 'Paid out: {amount}',
  /** r35b: referral earnings that paid what the wallet owed Jansetu. */
  'tiles.referralSetOff': 'Paid what the wallet owed: {amount}',
  'tiles.referralDue': 'Due to you: {amount}',
  'tiles.referralPaused': 'Payouts are paused for now.',
  'tiles.referralLink': 'See referral earnings',
  'tiles.withdrawals': 'Withdrawals to the bank',
  'tiles.withdrawalsOff': 'Not open yet',
  /** How many withdrawals are waiting for Jansetu to pay them. */
  'tiles.waiting': 'Waiting: {count}',
  'tiles.lastPaid': 'Last paid: {date}',
  'tiles.nonePaid': 'None paid yet',

  /** WQ48: which statement the pharmacy reads. */
  'statement.show': 'Show',
  'statement.kind.wallet': 'Wallet',
  'statement.kind.referral': 'Referral earnings',
  'statement.walletEmpty': 'Top-ups, booking payments, refunds and withdrawals appear here.',
  'statement.pages': 'Statement pages',

  /** WQ48 (r35 §26.9): referral accounts in the admin's settlement list. */
  'settlements.referralAll': 'Referral (all)',
  'settlements.paused': 'Paused until tax advice',
  'payout.blocked.paused': 'Paused until tax advice: referral earnings cannot be paid out yet.',
  /** r35b: a lab's or doctor's referral account is paid to its own account's details. {destination}: masked; {state}: verified or not. */
  'account.home': 'Payouts go to the payout details of the lab’s or doctor’s own account: {destination} ({state}).',
  'account.homeNone': 'Payouts go to the payout details of the lab’s or doctor’s own account, which has none yet.',
  'account.homeLink': 'Open that account',
} as const;
