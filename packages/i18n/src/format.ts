import { getLanguage } from './store.ts';

/**
 * Money, dates and times for every screen (docs/I18N_PLAN.md §3.5).
 * - Money uses `en-IN` in every language: Indian grouping and "₹1,23,456.50" everywhere (`or-IN` would group in
 *   thousands, `as-IN` adds a space after ₹).
 * - Dates and times use the language's month and weekday names with digits 0-9 (`<lang>-IN-u-nu-latn`); English is
 *   `en-IN`, exactly as before.
 */

export const INDIA_TIME = 'Asia/Kolkata';

/** A calendar date that is already India's (a YYYYMMDD or YYYY-MM-DD read as UTC midnight): "22 Nov 2026". */
export const CALENDAR_DATE: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' };
/** The same with the weekday: "Mon, 16 Nov 2026". */
export const CALENDAR_DAY: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' };
/** An instant as India time, 24-hour: "14:05". */
export const CLOCK: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: INDIA_TIME };
/** An instant as India date and time: "25 Nov 2026, 2:35 pm". */
export const DATE_TIME: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short', timeZone: INDIA_TIME };

const RUPEES = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });

/** Money held in rupees, in Indian grouping; "—" when there is none. */
export function formatRupees(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—';
  return RUPEES.format(value);
}

/** Money held in paise (`*Minor`, `*Paise`). */
export const formatPaise = (paise: number): string => RUPEES.format(paise / 100);

const dateFormats = new Map<string, Intl.DateTimeFormat>();

/** An instant with these options, in the current language. */
export function formatDateWith(at: Date | number, options: Intl.DateTimeFormatOptions): string {
  const lang = getLanguage();
  const locale = lang === 'en' || lang === 'pseudo' ? 'en-IN' : `${lang}-IN-u-nu-latn`;
  const id = `${locale} ${JSON.stringify(options)}`;
  let format = dateFormats.get(id);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, options);
    dateFormats.set(id, format);
  }
  return format.format(at);
}

/** An ISO instant as India date and time; "—" when missing or unreadable. */
export function formatDateTime(value: string | undefined | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return formatDateWith(d, DATE_TIME);
}

/** A valid YYYYMMDD (callers check it) as "22 Nov 2026". */
export function formatYmd(yyyymmdd: string): string {
  return formatDateWith(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8)), CALENDAR_DATE);
}

/** An instant as India time "HH:MM". */
export const formatClock = (at: Date | number): string => formatDateWith(at, CLOCK);
