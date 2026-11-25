/**
 * WQ28: the account holder's answers to doctors asking to see records (docs/I18N_PLAN.md §3.3). A comment above a key is
 * the translator's note. "Records" are prescriptions from other doctors and released lab reports.
 */
export default {
  /** Heading of the card on Home and of the waiting list. */
  'pending.title': 'Requests to see your records',
  'pending.none': 'No requests are waiting for your answer.',
  /** {doctor}: the doctor's name ("Dr Asha Mehta"). */
  'pending.self': '{doctor} asks to see your prescriptions from other doctors and your lab reports.',
  /** {name}: the family member's name. */
  'pending.family': '{doctor} asks to see {name}’s prescriptions from other doctors and lab reports.',
  /** {at} and {until}: date and time. */
  'pending.when': 'Asked {at}. Answer before {until}, or the request ends.',
  /** Link from Home's card to the full page. */
  'home.more': 'All requests, and who can see your records',
  /** Link on the Profile page. */
  'profile.link': 'Requests to see your records',

  'page.title': 'Your health records',
  'page.intro': 'A doctor treating you can ask to see your prescriptions from other doctors and your lab reports. You decide.',

  'allow.button': 'Allow',
  'allow.confirm': 'Yes, allow',
  'allow.consequence': '{doctor} can then see these records while treating, for up to 12 months. Each time is recorded. You can stop it here at any time.',
  'allow.done': 'You allowed {doctor} to see these records.',
  'deny.button': 'Deny',
  'deny.confirm': 'Yes, deny',
  'deny.consequence': '{doctor} then sees only their own consultations.',
  'deny.done': 'You did not allow {doctor} to see these records.',

  'grants.title': 'Doctors who can see your records',
  'grants.none': 'No doctor can see your records from other doctors and labs.',
  /** {until}: a date and time. */
  'grants.self': '{doctor} can see your records until {until}.',
  'grants.family': '{doctor} can see {name}’s records until {until}.',
  'revoke.button': 'Stop sharing',
  'revoke.confirm': 'Yes, stop sharing',
  'revoke.consequence': '{doctor} can no longer see these records. They can ask again.',
  'revoke.done': 'Stopped. {doctor} can no longer see these records.',

  'history.title': 'Past requests',
  'history.none': 'No past requests.',
  'history.self': '{doctor}: your records',
  'history.family': '{doctor}: {name}’s records',
  /** {at}: date and time of the answer. */
  'history.approved': 'Allowed on {at}',
  'history.denied': 'Denied on {at}',
  'history.expired': 'Ended without an answer',
  'history.replaced': 'Replaced by a newer request',

  /** A doctor's name: "Dr" before it (unless the name already has it). */
  'doctor.name': 'Dr {name}',
  'doctor.unknown': 'A Jansetu doctor',

  'error.RECORDS_REQUEST_EXPIRED': 'This request has ended, so it can no longer be answered.',
  'error.RECORDS_REQUEST_NOT_PENDING': 'This request was already answered.',
  'error.RECORDS_REQUEST_NOT_FOUND': 'This request was not found.',
  'error.RECORDS_REQUEST_CHANGED': 'This request changed meanwhile. Look at it again, then answer.',
  'error.RECORDS_GRANT_NOT_FOUND': 'This was not found.',
  'error.RECORDS_ACCESS_DISABLED': 'Sharing records with doctors is not switched on yet.',
  'error.FORBIDDEN': 'Only the account holder can answer this.',
  'error.INDEXES_OUTDATED': 'This cannot be used just now. Please try again later.',
  /** The answer may or may not have arrived (no reply from the server). */
  'error.unknown': 'Your answer may not have arrived. The list was read again: if the request is still here, answer it again.',
  'error.load': 'Your requests could not be loaded.',
} as const;
