/**
 * Shared UI words (docs/I18N_PLAN.md §3.2). A comment above a key is the translator's note.
 *
 * Every area reuses these instead of adding its own copy: `import { shared } from '@jansetu/ui'`, then
 * `shared('action.cancel')`. Add a word here only when it means the same on every screen that uses it.
 * - Actions (buttons and links): `action.back` Back, `action.cancel` Cancel, `action.save` Save, `action.tryAgain` Try
 *   again, `action.continue` Continue, `action.next` Next, `action.previous` Previous, `action.newer` Newer,
 *   `action.older` Older, `action.showMore` Show more, `action.search` Search, `action.remove` Remove, `action.open` Open,
 *   `action.close` Close, `action.change` Change, `action.edit` Edit, `action.refresh` Refresh, `action.apply` Apply,
 *   `action.signInAgain` Sign in again.
 * - States: `state.loading` Loading…, `state.notFound` Not found, `state.reconnecting` Reconnecting….
 * - Field and column names: `field.status` Status, `field.amount` Amount, `field.date` Date, `field.name` Name,
 *   `field.phone` Phone, `field.email` Email, `field.reason` Reason, `field.note` Note.
 * "Something went wrong. Please try again." is `messageOf` in `@jansetu/api` (any failure goes through it).
 */
export default {
  /** Label of the language list (the switcher). */
  'language.label': 'Language',
  /** Under the language list when a language's words could not be downloaded. */
  'language.loadFailed': 'Could not load {language}. Check your connection and try again.',

  /** Button: go back to the previous step or page. */
  'action.back': 'Back',
  /** Button: stop without doing anything (not "cancel a booking"). */
  'action.cancel': 'Cancel',
  'action.save': 'Save',
  /** Button under an error: load or send again. */
  'action.tryAgain': 'Try again',
  'action.continue': 'Continue',
  /** Paging: the next page of a list. */
  'action.next': 'Next',
  /** Paging: the previous page of a list. */
  'action.previous': 'Previous',
  /** Paging: newer entries of a history. */
  'action.newer': 'Newer',
  /** Paging: older entries of a history. */
  'action.older': 'Older',
  /** Under a list: load more rows. */
  'action.showMore': 'Show more',
  'action.search': 'Search',
  'action.remove': 'Remove',
  'action.open': 'Open',
  'action.close': 'Close',
  'action.change': 'Change',
  'action.edit': 'Edit',
  /** Button: load the latest data again. */
  'action.refresh': 'Refresh',
  /** Button: use the chosen filters. */
  'action.apply': 'Apply',
  'action.signInAgain': 'Sign in again',

  /** Shown while a page or list loads. */
  'state.loading': 'Loading…',
  /** A record that does not exist or is not this account's. */
  'state.notFound': 'Not found',
  /** While the app tries to reach the server again; the person stays signed in. */
  'state.reconnecting': 'Reconnecting…',
  /** Shown instead of the start-up screen while the first sign-in check gets no answer. */
  'state.reconnectingStart': 'Reconnecting… We could not reach the server to resume your sign-in. We keep trying.',

  /** Column or field name. */
  'field.status': 'Status',
  'field.amount': 'Amount',
  'field.date': 'Date',
  /** A person's or a business's name. */
  'field.name': 'Name',
  'field.phone': 'Phone',
  'field.email': 'Email',
  'field.reason': 'Reason',
  'field.note': 'Note',
} as const;
