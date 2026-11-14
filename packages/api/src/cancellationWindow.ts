/**
 * The backend's customer cancellation rule (src1/modules/common/utils/cancellationWindow.ts), mirrored so the app can
 * say BEFORE a tap whether a paid booking can still be cancelled. The server still decides.
 * Appointment time = bookingDate (YYYYMMDD) + bookingTime ("HH:MM[:SS] [AM|PM]") in IST. Paid bookings close 24 hours
 * before the appointment (48 hours for a Monday appointment) and cannot be cancelled once it has started. Unpaid
 * bookings are exempt from every time check.
 */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export function appointmentInstant(bookingDate: string, bookingTime: string): { at: Date; weekday: number } | null {
  if (typeof bookingDate !== 'string' || typeof bookingTime !== 'string' || !/^\d{8}$/.test(bookingDate)) return null;
  const m = bookingTime.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (!m) return null;
  const year = Number(bookingDate.slice(0, 4));
  const month = Number(bookingDate.slice(4, 6));
  const day = Number(bookingDate.slice(6, 8));
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const second = Number(m[3] || 0);
  const meridiem = m[4]?.toUpperCase();
  if (month < 1 || month > 12 || minute > 59 || second > 59 || (meridiem ? hour < 1 || hour > 12 : hour > 23)) return null;
  if (meridiem) hour = (hour % 12) + (meridiem === 'PM' ? 12 : 0);
  const local = new Date(Date.UTC(year, month - 1, day));
  if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1 || local.getUTCDate() !== day) return null;
  return { at: new Date(Date.UTC(year, month - 1, day, hour, minute, second) - IST_OFFSET_MS), weekday: local.getUTCDay() };
}

export type CancelCheck =
  | { ok: true; deadline: Date | null }
  | { ok: false; reason: 'invalid_time' | 'started' | 'window_closed'; cutoffHours?: number };

/** `paid`: money was taken (only then does the 24/48-hour window apply). */
export function canCancelNow(bookingDate: string, bookingTime: string, paid: boolean, now = new Date()): CancelCheck {
  // The backend applies the whole time check only when money was captured (bookings/holds.ts, providerOps.ts):
  // an unpaid booking can be cancelled even if it has started or its time cannot be read.
  if (!paid) return { ok: true, deadline: null };
  const a = appointmentInstant(bookingDate, bookingTime);
  if (!a) return { ok: false, reason: 'invalid_time' };
  if (a.at.getTime() <= now.getTime()) return { ok: false, reason: 'started' };
  const cutoffHours = a.weekday === 1 ? 48 : 24;
  const deadline = new Date(a.at.getTime() - cutoffHours * HOUR_MS);
  return now.getTime() >= deadline.getTime() ? { ok: false, reason: 'window_closed', cutoffHours } : { ok: true, deadline };
}
