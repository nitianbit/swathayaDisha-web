/**
 * `@jansetu/api` core words (docs/I18N_PLAN.md §3.2, §6): the shared error words of `messageOf`, and the sign-in and
 * session words. Each area's words are in its own catalogue beside this one (`assisted/`, `pharmacy/`, `lab/`, …).
 * `errors.<CODE>` is the shared word for a server or client error code, used when no area words matched; a code without
 * an entry shows the server's own message (English). A comment above a key is the translator's note.
 */
export default {
  /** The last fallback for any failure. */
  'errors.unknown': 'Something went wrong. Please try again.',
  /** A refusal (403) that came without the server's own words. */
  'errors.forbidden': 'Your account is not allowed to do this.',
  /** The server answered with an error and no words; {status} is the HTTP status number. */
  'errors.requestFailed': 'Request failed ({status})',
  /** No answer in time (code made by the app, not the server). */
  'errors.TIMEOUT': 'The server took too long to respond. Please try again.',
  /** No connection to the server (code made by the app). */
  'errors.NETWORK': 'Could not reach the server. Check your connection and try again.',

  /** The phone app has no saved sign-in left. */
  'session.signInAgain': 'Please sign in again',

  /** Customer, doctor or pharmacy sign-in with an email no account uses. */
  'auth.emailNotRegistered': 'No account uses this email. Sign in with your mobile number, then add this email to your profile.',
  /** The same for doctors and pharmacies, who have no profile email screen. */
  'auth.emailNotRegisteredStaff': 'No account uses this email. Sign in with your mobile number. To use email sign-in, ask the Jansetu team to add it to your account.',
  /** A lab or clinic member whose doctor is not verified and active. */
  'auth.clinicDoctorNotVerified': 'Your doctor account is not verified or not active, so this clinic workspace is closed for you. Contact the Jansetu team.',
} as const;
