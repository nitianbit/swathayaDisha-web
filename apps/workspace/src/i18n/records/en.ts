/**
 * WQ28: the doctor's patient-records page (docs/I18N_PLAN.md §3.3). A comment above a key is the translator's note.
 * "Records" are the patient's prescriptions from other doctors and their released lab reports.
 */
export default {
  /** Link on a row of the doctor's Appointments list. */
  'link.records': 'Patient’s records',
  /** The same link's full name for screen readers; {when} is the consultation's date and time. */
  'link.recordsFor': 'Patient’s records ({when})',

  'page.title': 'Patient records',
  'page.intro': 'Your consultations with this patient and, when the patient allows it, their records from other doctors and labs.',
  /** Back link to the Appointments page. */
  'page.back': 'Appointments',
  'notFound.title': 'Consultation not found',
  'notFound.back': 'See your appointments',

  'own.title': 'Your consultations with this patient',
  /** Table caption, read by screen readers. */
  'own.caption': 'Your consultations with this patient',
  'own.when': 'When',
  'own.type': 'Type',
  'own.status': 'Status',
  /** {date} and {time} of one consultation. */
  'own.at': '{date}, {time}',

  'others.title': 'Other records',
  'others.ownOnly': 'Only your own consultations are shown.',
  'others.why': 'To see this patient’s prescriptions from other doctors and their lab reports, ask the patient. They answer in the Jansetu app.',
  'others.none': 'No prescriptions from other doctors and no lab reports yet.',
  'others.caption': 'Records from other doctors and labs, newest first',
  'others.date': 'Date',
  'others.from': 'Doctor or lab',
  'others.type': 'Type',
  'others.open': 'Open',
  /** A doctor's name with their speciality. */
  'others.doctorWith': '{name}, {specialization}',
  'others.prescription': 'Prescription',
  /** {tests}: the names of the tests, as the lab wrote them. */
  'others.labReport': 'Lab report: {tests}',
  /** Screen-reader name of an Open button; {what} is "Prescription" or the lab report words, {date} its date. */
  'others.openOne': 'Open: {what}, {date}',
  /** When a lab test has more than one released report file. */
  'others.openPart': 'Open part {n}',
  'others.openPartFor': 'Open part {n}: {what}, {date}',
  'others.noFile': 'No file',
  /** Unknown doctor or lab name. */
  'others.unknown': '—',
  /** Title of the opened file (frame and image). */
  'viewer.title': 'Patient record',
  /** Word used in "Open the record in a new tab" and "Download the record". */
  'viewer.noun': 'record',
  'viewer.failed': 'Could not open it: {error}',

  'identity': 'Identity attested by the partner, not verified.',

  'ask.button': 'Ask the patient to see their other records',
  'ask.confirm': 'Yes, ask the patient',
  'ask.consequence': 'The account holder is asked in the Jansetu app. The request ends after 24 hours, or earlier when this consultation’s treating time ends. Every record you open is logged.',
  'ask.sent': 'Asked. The patient answers in the Jansetu app.',
  /** Asking found the patient's permission already in force: nothing was asked. */
  'ask.alreadyAllowed': 'The patient has already allowed it.',
  /** `channels.app` is false: the account holder has never signed in to the customer app. */
  'ask.noApp': 'The patient hasn’t used the Jansetu app yet; they can’t approve until they sign in.',
  /** The outcome of the request is unknown (a lost answer); {error} says why. */
  'ask.unconfirmed': 'The outcome of asking is not known yet ({error}).',
  'ask.restored': 'A request made earlier on this device was not confirmed. Check whether it reached the patient.',
  'ask.notYet': 'Not asked so far. It may still be on its way. Asking again is safe: a newer request replaces the older one.',
  'ask.resend': 'Ask again',
  'ask.panel': 'Unconfirmed request',
  'ask.forget': 'Forget it',
  'ask.forgetConfirm': 'Yes, forget it',
  'ask.forgetConsequence': 'If the earlier request still arrives, the patient is asked.',

  /** {until}: date and time. */
  'state.pending': 'Waiting for the patient to answer in the Jansetu app, until {until}.',
  'state.check': 'Check again',
  'state.denied': 'The patient did not allow it. You can ask again.',
  'state.expired': 'The request ended before the patient answered. You can ask again.',
  /** {until}: the earlier of the end of the patient's permission and the end of this consultation's treating time. */
  'state.approved': 'The patient allowed it. You can see these records until {until}. Every record you open is logged.',
  'state.off': 'Seeing other records is not switched on yet.',

  'error.BOOKING_NOT_FOUND': 'This consultation was not found among yours.',
  'error.PATIENT_HISTORY_NOT_FOUND': 'This consultation was not found among yours.',
  'error.TREATING_WINDOW_CLOSED': 'This consultation is not open for treatment now, so its patient’s records are not shown. It is open from its start until 7 days after it ends, or 30 days after it is completed.',
  'error.SPECIALIST_NOT_VERIFIED': 'Patient records open once Jansetu has verified your account and it is active.',
  'error.RECORDS_ACCESS_DISABLED': 'Asking for other records is not switched on yet.',
  'error.READ_LOG_UNAVAILABLE': 'Records cannot be shown right now. Try again in a minute.',
  'error.INDEXES_OUTDATED': 'The server needs an update before this can be used. Please ask the Jansetu team.',
  'error.RECORDS_REQUEST_CHANGED': 'The request changed meanwhile. Try again.',
} as const;
