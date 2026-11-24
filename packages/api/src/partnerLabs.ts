import { ApiError, type ApiClient, type Page } from './client.ts';
import { noShowMovedOnce } from './noShows.ts';
import type { VisitMode } from './partnerInvoices.ts';
import {
  HHMM_PATTERN, holdsAny, ISO_DATE_PATTERN, OBJECT_ID_PATTERN, partnerWorkspaceBase, REQUEST_KEY_PATTERN, type PartnerActorView, type PartnerMember,
  type PartnerScope, type Weekday,
} from './partners.ts';

/**
 * Q3 partner lab operations: server-owned slots (weekly template, manual slots, capacity, closures) and online lab
 * bookings (staff transitions, reschedule proposals, report upload and release). Typed from the backend's
 * `src1/modules/partners/{model/slot.ts,model/labBooking.ts,validation/labBooking.ts}`; the rules are mirrored from
 * `services/slots.ts` and `services/labBookings.ts` (cited per function). The server decides; these mirrors only say
 * what to offer and why something is not offered.
 *
 * Routes: `registerWorkspaceRoutes` in `partners/routes/index.ts`, for members (`/partner-workspace/...`) and admins
 * acting as owner (`/partner-workspace/admin/:partnerId/workspace/...`); admins also list every partner's bookings at
 * `GET /partner-workspace/admin/lab-bookings`.
 */

export const LAB_VISIT_MODES: readonly VisitMode[] = ['home', 'lab'];
export const LAB_VISIT_MODE_LABEL: Record<VisitMode, string> = { home: 'Home collection', lab: 'At the lab' };

// ── Slots (model/slot.ts, validation/labBooking.ts) ──

/** Why a slot is not bookable; null = open. Template expansion never undoes a manual closure. */
export type SlotClosure = null | 'holiday' | 'template' | 'manual';

export interface LabSlot {
  _id: string;
  partnerId: string;
  branchId: string;
  visitMode: VisitMode;
  /** India-time calendar date YYYY-MM-DD. */
  date: string;
  /** India-time HH:mm. */
  startTime: string;
  endTime: string;
  startsAt: string;
  endsAt: string;
  capacity: number;
  /** Seats taken; server-owned (never sent). */
  booked: number;
  closed: SlotClosure;
  source: 'template' | 'manual';
}

export interface SlotWindow { start: string; end: string }
export type TemplateDays = Partial<Record<Weekday, SlotWindow[]>>;
/** `slotTemplateSchema`: the whole weekly template, replaced on every save. */
export interface SlotTemplateInput { slotMinutes: number; capacity: number; days: TemplateDays }
export interface SlotTemplate extends SlotTemplateInput {
  _id: string; partnerId: string; branchId: string; visitMode: VisitMode; isActive: boolean; updatedAt?: string;
}
/**
 * Q11 `slotTemplateSchema.expectedUpdatedAt`: the saved template's `updatedAt` the editor started from, or null when it
 * started from no template. Another save in between is refused with 409 TEMPLATE_CHANGED (`saveSlotTemplate`).
 */
export type TemplateVersion = string | null;
/** 409 TEMPLATE_CHANGED: the weekly template was saved by someone else since the editor read it. */
export const isTemplateChanged = (err: unknown) => err instanceof ApiError && err.status === 409 && err.code === 'TEMPLATE_CHANGED';
/** `expandSlots` result, answered with a template save (the next 30 days are brought in line at once). */
export interface ExpansionResult { inserted: number; updated: number; closed: number; reopened: number }
/** `manualSlotSchema`. */
export interface NewManualSlot { branchId: string; visitMode: VisitMode; date: string; startTime: string; endTime: string; capacity: number }
/** `partnerSlotsQuerySchema` (every field required). */
export interface SlotQuery { branchId: string; visitMode: VisitMode; from: string; to: string }

/** `slotTemplateSchema.slotMinutes`. */
export const SLOT_MINUTES_MIN = 5;
export const SLOT_MINUTES_MAX = 480;
/** `slotTemplateSchema.capacity` and `manualSlotSchema.capacity`: 1–500 seats. */
export const SLOT_SEATS_MAX = 500;
/** `slotCapacitySchema`: a slot's capacity may be set to 0–500, never below its booked seats (`setSlotCapacity`). */
export const SLOT_CAPACITY_MIN = 0;
/** `day = Joi.array().items(window).max(12)`. */
export const MAX_WINDOWS_PER_DAY = 12;
/** `ROLLING_DAYS`: templates are expanded this many days ahead (daily, and on every save). */
export const ROLLING_DAYS = 30;

/** Template weekdays in the order people read a week (the server stores them by key). */
export const TEMPLATE_WEEKDAYS: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const SUNDAY_FIRST: readonly Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export const SLOT_CLOSURE_LABEL: Record<Exclude<SlotClosure, null>, string> = {
  holiday: 'Closed: branch holiday',
  template: 'Closed: no longer in the weekly template',
  manual: 'Closed by staff',
};

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const toHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** `isRealDate`: a real calendar date YYYY-MM-DD (2027-02-31 is refused). */
export function isRealDate(date: unknown): date is string {
  if (typeof date !== 'string' || !ISO_DATE_PATTERN.test(date)) return false;
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d!));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m! - 1 && t.getUTCDate() === d;
}

/** `istDate`: the India-time calendar date of an instant. */
export function istDateOf(at: Date): string {
  return new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

/** `addDays` on calendar dates. */
export function addDays(date: string, n: number): string {
  const t = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** `weekdayOf`. */
export function weekdayOf(date: string): Weekday {
  const t = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  return SUNDAY_FIRST[new Date(t).getUTCDay()]!;
}

/** The Monday of the week a date is in (weeks are shown Monday to Sunday). */
export function mondayOf(date: string): string {
  return addDays(date, -TEMPLATE_WEEKDAYS.indexOf(weekdayOf(date)));
}

/** `slotTimesFor`: the slots a template gives on one weekday (whole slots only; a window's remainder is unused). */
export function slotTimesFor(t: Pick<SlotTemplateInput, 'slotMinutes' | 'days'>, day: Weekday): SlotWindow[] {
  const out: SlotWindow[] = [];
  if (!Number.isInteger(t.slotMinutes) || t.slotMinutes < SLOT_MINUTES_MIN) return out;
  for (const w of t.days[day] ?? []) {
    if (!HHMM_PATTERN.test(w.start) || !HHMM_PATTERN.test(w.end)) continue;
    for (let m = toMinutes(w.start); m + t.slotMinutes <= toMinutes(w.end); m += t.slotMinutes) {
      out.push({ start: toHHMM(m), end: toHHMM(m + t.slotMinutes) });
    }
  }
  return out;
}

/**
 * Why the server would refuse this template, per field: `slotTemplateSchema` (minutes 5–480, seats 1–500, at most 12
 * windows a day, HH:mm) and `validateWindows` (each window ends after it starts; windows of a day do not overlap).
 * Keys: `slotMinutes`, `capacity`, and a weekday for its windows.
 */
export function templateProblems(t: SlotTemplateInput): Partial<Record<'slotMinutes' | 'capacity' | Weekday, string>> {
  const out: Partial<Record<'slotMinutes' | 'capacity' | Weekday, string>> = {};
  if (!Number.isInteger(t.slotMinutes) || t.slotMinutes < SLOT_MINUTES_MIN || t.slotMinutes > SLOT_MINUTES_MAX) {
    out.slotMinutes = `Enter whole minutes from ${SLOT_MINUTES_MIN} to ${SLOT_MINUTES_MAX}.`;
  }
  if (!Number.isInteger(t.capacity) || t.capacity < 1 || t.capacity > SLOT_SEATS_MAX) {
    out.capacity = `Enter a number of seats from 1 to ${SLOT_SEATS_MAX}.`;
  }
  for (const day of TEMPLATE_WEEKDAYS) {
    const windows = t.days[day] ?? [];
    if (windows.length > MAX_WINDOWS_PER_DAY) { out[day] = `At most ${MAX_WINDOWS_PER_DAY} time windows a day.`; continue; }
    if (windows.some((w) => !HHMM_PATTERN.test(w.start) || !HHMM_PATTERN.test(w.end))) { out[day] = 'Enter each time as HH:MM.'; continue; }
    const sorted = [...windows].sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
    for (let i = 0; i < sorted.length; i++) {
      if (toMinutes(sorted[i]!.end) <= toMinutes(sorted[i]!.start)) { out[day] = 'A window must end after it starts.'; break; }
      if (i > 0 && toMinutes(sorted[i]!.start) < toMinutes(sorted[i - 1]!.end)) { out[day] = 'These windows overlap.'; break; }
    }
  }
  return out;
}

const mostCommon = (values: number[]): number | undefined => {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: number | undefined;
  for (const [v, n] of counts) if (best === undefined || n > counts.get(best)! || (n === counts.get(best)! && v < best)) best = v;
  return best;
};

/** The saved template as the editor edits it (whole windows per weekday; days with no window are left out). */
export function templateInput(t: Pick<SlotTemplate, 'slotMinutes' | 'capacity' | 'days'>): SlotTemplateInput {
  const days: TemplateDays = {};
  for (const day of TEMPLATE_WEEKDAYS) {
    const windows = (t.days?.[day] ?? []).map((w) => ({ start: w.start, end: w.end }));
    if (windows.length) days[day] = windows;
  }
  return { slotMinutes: t.slotMinutes, capacity: t.capacity, days };
}

/** `addManualSlot` + `manualSlotSchema`: why this manual slot would be refused, per field. */
export function manualSlotProblems(s: Pick<NewManualSlot, 'date' | 'startTime' | 'endTime' | 'capacity'>):
  Partial<Record<'date' | 'startTime' | 'endTime' | 'capacity', string>> {
  const out: Partial<Record<'date' | 'startTime' | 'endTime' | 'capacity', string>> = {};
  if (!isRealDate(s.date)) out.date = 'Enter a real date.';
  if (!HHMM_PATTERN.test(s.startTime)) out.startTime = 'Enter the start time.';
  if (!HHMM_PATTERN.test(s.endTime)) out.endTime = 'Enter the end time.';
  else if (!out.startTime && toMinutes(s.endTime) <= toMinutes(s.startTime)) out.endTime = 'A slot must end after it starts.';
  if (!Number.isInteger(s.capacity) || s.capacity < 1 || s.capacity > SLOT_SEATS_MAX) out.capacity = `Enter a number of seats from 1 to ${SLOT_SEATS_MAX}.`;
  return out;
}

/** `setSlotCapacity` + `slotCapacitySchema`: 0–500 and never below the seats already booked. */
export function capacityProblem(slot: Pick<LabSlot, 'booked'>, capacity: number): string | null {
  if (!Number.isInteger(capacity) || capacity < SLOT_CAPACITY_MIN || capacity > SLOT_SEATS_MAX) return `Enter a number from ${SLOT_CAPACITY_MIN} to ${SLOT_SEATS_MAX}.`;
  if (capacity < slot.booked) return `${slot.booked} ${slot.booked === 1 ? 'seat is' : 'seats are'} already booked: the capacity cannot be lower.`;
  return null;
}

/**
 * Whether staff should be offered "Reopen". The server's reopen clears ANY closure, but a holiday or template closure
 * is put back by the next expansion (and a holiday is refused at booking anyway), so only manual closures are offered.
 */
export const reopenable = (s: Pick<LabSlot, 'closed'>) => s.closed === 'manual';

/** What a customer could book now (`listBookableSlots` without the booking lead time, as `labReschedule` uses `now`). */
export function isBookable(s: Pick<LabSlot, 'closed' | 'booked' | 'capacity' | 'startsAt'>, now: Date): boolean {
  return s.closed === null && s.booked < s.capacity && Date.parse(s.startsAt) > now.getTime();
}

// ── Lab bookings (model/labBooking.ts, services/labBookings.ts) ──

export type LabBookingStatus =
  | 'pending_payment' | 'confirmed' | 'sample_collected' | 'visited' | 'processing'
  | 'report_ready' | 'completed' | 'cancelled' | 'no_show';
export const LAB_BOOKING_STATUSES: readonly LabBookingStatus[] = [
  'pending_payment', 'confirmed', 'sample_collected', 'visited', 'processing', 'report_ready', 'completed', 'cancelled', 'no_show',
];
export const LAB_BOOKING_STATUS_LABEL: Record<LabBookingStatus, string> = {
  pending_payment: 'Waiting for payment', confirmed: 'Confirmed', sample_collected: 'Sample collected', visited: 'Visited',
  processing: 'Processing', report_ready: 'Report released', completed: 'Completed', cancelled: 'Cancelled', no_show: 'No-show',
};
export type LabPaymentStatus = 'pending' | 'paid' | 'refunded';
export const LAB_PAYMENT_STATUS_LABEL: Record<LabPaymentStatus, string> = { pending: 'Not paid yet', paid: 'Paid online', refunded: 'Refunded' };

/** r12: a desk walk-in has no seat: `walkIn`, its IST arrival as `date`/`startTime`, no `slotId` or `endTime`. */
export interface LabBookingSlot { slotId: string; date: string; startTime: string; endTime: string; startsAt: string; walkIn?: boolean }
export interface LabBookingItem {
  catalogItemId: string; kind: 'test' | 'package'; name: string; code?: string; priceMinor: number; mrpMinor?: number;
  gstRate: number; sac?: string; reportTatHours?: number;
}
export interface LabReportRelease {
  /** Upload-dir path of the released file (no `/api/static/` prefix). */
  path: string;
  releasedAt: string;
  /** Member id, or `admin:<id>`. */
  releasedBy: string;
  signer: { memberId: string; name: string; kind?: string; registrationNumber: string };
}
export type LabLifecycleKey = 'paidAt' | 'confirmedAt' | 'collectedAt' | 'visitedAt' | 'processingAt' | 'reportReadyAt' | 'completedAt' | 'cancelledAt' | 'noShowAt';

/** `partnerView`: the booking without wallet/request internals; report files as `/api/static/...` values. */
export interface LabBooking {
  _id: string;
  partnerId: string;
  branchId: string;
  userId: string;
  patient: { kind: 'self' | 'dependent'; dependentId?: string; name: string; age?: number; gender?: string };
  visitMode: VisitMode;
  address?: { line1: string; line2?: string; city: string; state?: string; pincode: string; landmark?: string };
  slot: LabBookingSlot;
  items: LabBookingItem[];
  pricing: { subtotalMinor: number; couponCode?: string; discountMinor: number; payableMinor: number; commissionMinor: number; currency: 'INR' };
  status: LabBookingStatus;
  statusVersion: number;
  paymentStatus: LabPaymentStatus;
  paymentDeadline: string;
  /**
   * Q16a: `admin_no_show` = an admin cancelled a booking moved after a no-show, with `refund` saying whether the patient
   * was refunded (`adminCancelMovedNoShow`).
   */
  cancellation?: { reason: 'timeout' | 'customer' | 'lab_reject' | 'admin_no_show' | 'desk' | 'partner'; note?: string; by: string; byKind: 'customer' | 'member' | 'admin' | 'system'; at: string; refund?: boolean };
  reschedule: { version: number; pending: boolean; previousSlot?: LabBookingSlot; reason?: string; at?: string; by?: string };
  collector?: { memberId?: string; name: string; phone?: string };
  report: { draftFiles: string[]; releasedFiles: string[]; releases: LabReportRelease[] };
  lifecycle: Partial<Record<LabLifecycleKey, string>>;
  /** Q14: the no-show this booking was moved after (at most one; a second no-show is final). */
  noShows?: LabNoShowMove[];
  noShowReschedules?: number;
  /**
   * r12 (`deskLabPart`): `lab_desk` rows were booked at the lab's front desk and are paid at the lab (`payAtLab`, no
   * Jansetu money: `paymentStatus` stays `pending`); `bill` is the lab's bill linked to it (`labBookingId`), or null.
   */
  source?: 'self' | 'pharmacy_assisted' | 'lab_desk' | string;
  payAtLab?: boolean;
  desk?: { memberId: string; branchId: string; arrivedAt: string | null; preferredLanguage?: string; payAtLab: boolean } | null;
  bill?: { invoiceId: string; serial: string; number: number; state: string } | null;
  createdAt?: string;
  updatedAt?: string;
}

/** Q14 `IPartnerLabBooking.noShows[]`: when the slot was missed, when and by whom it was moved, from and to which slot. */
export interface LabNoShowMove {
  at?: string;
  rescheduledAt: string;
  by?: string;
  byKind?: 'member' | 'admin';
  fromSlot: LabBookingSlot;
  toSlot: LabBookingSlot;
}

/**
 * Q14 `rescheduleNoShow` (`services/labBookings.ts`): a lab no-show may be moved once, by `bookings.manage`, to a later
 * open slot of the same branch and visit mode. 'offer' = it can be moved now; 'used' = it was moved once already (a
 * second no-show is final); null = not a no-show, or not this person's step.
 */
export function labNoShowMove(b: Pick<LabBooking, 'status' | 'noShows' | 'noShowReschedules'>,
  actor: Pick<PartnerActorView, 'role' | 'permissions'>): 'offer' | 'used' | null {
  if (b.status !== 'no_show' || !holdsAny(actor, ['bookings.manage'])) return null;
  return noShowMovedOnce(b) ? 'used' : 'offer';
}

/** Admin list rows are the stored records (report paths without the `/api/static/` prefix). */
export type AdminLabBookingRow = Omit<LabBooking, 'report'> & { report?: { draftFiles?: string[]; releasedFiles?: string[] } };

/**
 * `partnerLabBookingQuerySchema` + Q11 `listForPartnerPage`: soonest slot first (then id), one page of at most 200
 * (`limit` defaults to 50 and is capped at 200 by the service, whatever the schema admits), with the total that match
 * and an exact `nextCursor` (`<slot start ms>_<id>`) for the page after, or null on the last one.
 */
export interface LabBookingQuery {
  status?: LabBookingStatus; branchId?: string; from?: string; to?: string; limit?: number; cursor?: string;
  /** r12: only the bookings from one source (`lab_desk` = booked at this lab's front desk). */
  source?: 'self' | 'pharmacy_assisted' | 'lab_desk';
}
/** The most one page holds (`listForPartnerPage` caps `limit` at 200). */
export const LAB_BOOKINGS_PAGE_MAX = 200;
/** Q11 cursors are `<ms>_<objectId>` (the service refuses anything else with 400 INVALID_CURSOR). */
export const LAB_BOOKING_CURSOR_PATTERN = /^\d{1,15}_[0-9a-fA-F]{24}$/;
/**
 * `adminLabBookingQuerySchema` + Q11 `adminList`: newest booked first (`createdAt`, then id), paged by `page` with
 * `limit` 1–200 (default 50); filters lab, status and slot dates. Answered with `{ page, limit, total, totalPages }`.
 */
export interface AdminLabBookingQuery { partnerId?: string; status?: LabBookingStatus; from?: string; to?: string; page?: number; limit?: number }
export const ADMIN_LAB_BOOKINGS_PAGE_MAX = 200;

/** `assignCollectorSchema`. */
export interface CollectorInput { memberId?: string; name: string; phone?: string }
export const MAX_COLLECTOR_NAME = 120;
export const COLLECTOR_PHONE_PATTERN = /^[0-9]{10}$/;
/** `rejectSchema.reason` and `labRescheduleSchema.reason`: 3–500 characters after trimming. */
export const MIN_LAB_REASON = 3;
export const MAX_LAB_REASON = 500;

/** `FileService` (`maxFileSize`, `allowedMimeTypes`, judged by the file's extension): reports are PDF or images, 10 MB each. */
export const REPORT_MAX_BYTES = 10 * 1024 * 1024;
export const REPORT_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png', '.webp'] as const;
export const REPORT_ACCEPT = 'application/pdf,image/jpeg,image/png,image/webp,.pdf,.jpg,.jpeg,.png,.webp';

/** Why a chosen file cannot be uploaded as a report, or null. */
export function reportFileProblem(f: Pick<File, 'name' | 'size'>): string | null {
  const name = f.name.toLowerCase();
  if (!REPORT_EXTENSIONS.some((e) => name.endsWith(e))) return `${f.name}: only PDF, JPEG, PNG or WebP files can be uploaded.`;
  if (f.size === 0) return `${f.name} is empty.`;
  if (f.size > REPORT_MAX_BYTES) return `${f.name} is larger than 10 MB.`;
  return null;
}

/**
 * The server's refusal of an uploaded report file because of its size: `FileService.uploadFiles` answers 400
 * FILE_TOO_LARGE for one file over 10 MB, and formidable's own size limits (`maxFileSize`, and `maxTotalFileSize`, which
 * defaults to the same 10 MB for the whole request) surface as 500 UPLOAD_FAILED "options.max…FileSize … exceeded";
 * a proxy in front may answer 413. In every case the request was refused before anything was attached.
 */
export function isReportTooLarge(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  if (err.status === 413 || err.code === 'FILE_TOO_LARGE') return true;
  return err.code === 'UPLOAD_FAILED' && /max(Total)?FileSize|exceed/i.test(err.message);
}
/**
 * `uploadFiles` fails as a whole before the booking is touched (the files it wrote are removed again and nothing is
 * attached), and the attach step itself is fenced by the request key: so UPLOAD_FAILED is a definite "not uploaded".
 */
export const isUploadFailed = (err: unknown) => err instanceof ApiError && err.code === 'UPLOAD_FAILED';

/** Report files of THIS booking, as the partner view gives them (`REPORT_UPLOAD_MODULE` folder of the booking). */
const REPORT_FILE = /^\/api\/static\/partner-lab-reports\/([0-9a-f]{24})\/([^/?#]+)$/;
/** The booking a stored report value belongs to, or null if it is not a report file value. */
export function reportFileBooking(stored: string): string | null {
  return REPORT_FILE.exec(stored)?.[1] ?? null;
}
/** A readable name for a report file (the file part of its path). */
export function reportFileName(stored: string): string {
  const name = stored.split('/').pop() ?? stored;
  try { return decodeURIComponent(name); } catch { return name; }
}
/** The `report.releases` entry of a released file value (`/api/static/<path>`). */
export const releaseOf = (b: Pick<LabBooking, 'report'>, stored: string) =>
  b.report.releases.find((r) => `/api/static/${r.path}` === stored);

/** Q11: 409 LAB_BOOKING_CHANGED — the booking moved since the step was reviewed (nothing was done; read it again). */
export const isLabBookingChanged = (err: unknown) => err instanceof ApiError && err.status === 409 && err.code === 'LAB_BOOKING_CHANGED';

/**
 * Q16a re-review (N6) `labSlotEnd`: the end of a booked lab slot — its start plus the slot's own length ("HH:mm" start →
 * end; a window running past midnight wraps; unreadable times give no length).
 */
export function labSlotEnd(slot: Pick<LabBookingSlot, 'startsAt' | 'startTime' | 'endTime'>): Date {
  const start = Date.parse(slot.startsAt);
  const min = (t?: string) => (typeof t === 'string' && /^\d{2}:\d{2}$/.test(t) ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : NaN);
  let len = min(slot.endTime) - min(slot.startTime);
  if (!Number.isFinite(len)) len = 0;
  if (len < 0) len += 24 * 60;
  return new Date(start + len * 60_000);
}

/** WQ11d: how long a report upload's answer is awaited (the client's default is 20 s). */
export const REPORT_UPLOAD_TIMEOUT_MS = 120_000;

export type LabAction = 'assign' | 'collect' | 'visit' | 'no_show' | 'process' | 'complete' | 'reject' | 'reschedule' | 'upload' | 'release';
/** An action this person may take on this booking now; `blocked` says why it cannot be taken yet (offered, disabled). */
export interface LabActionOffer { action: LabAction; blocked?: string }

/**
 * The §4 transitions of `services/labBookings.ts`, for this actor:
 * - `bookings.manage`: on a confirmed booking — assign a collector (home collections here), mark collected (home) or
 *   visited (lab), no-show (Q16a: only once the arrival window has ENDED, `labSlotEnd`; 409 SLOT_NOT_STARTED), each of these three only while no new time is waiting for the
 *   customer; reject (full refund) and propose a new time. Then processing (from collected/visited) and completed (from
 *   report released).
 * - `reports.upload`: add draft files while processing or report released; `reports.release`: release a draft then.
 * Unpaid (`pending_payment`) and finished bookings offer nothing.
 */
export function labActions(b: Pick<LabBooking, 'status' | 'paymentStatus' | 'visitMode' | 'reschedule' | 'slot' | 'report' | 'noShows' | 'noShowReschedules' | 'payAtLab'>,
  actor: Pick<PartnerActorView, 'role' | 'permissions'>, now: Date): LabActionOffer[] {
  // r12: a desk row is paid at the lab (`payAtLab`, never `paid` here); its steps run as for a paid booking, without money.
  const desk = b.payAtLab === true;
  if (b.paymentStatus !== 'paid' && !desk) return [];
  const manage = holdsAny(actor, ['bookings.manage']);
  const out: LabActionOffer[] = [];
  const waiting = b.reschedule?.pending ? 'The customer has not answered the new time yet.' : undefined;
  if (b.status === 'confirmed' && manage) {
    if (b.visitMode === 'home') out.push({ action: 'assign' }, { action: 'collect', blocked: waiting });
    else out.push({ action: 'visit', blocked: waiting });
    // r12: a walk-in is tested on arrival: never a no-show (409 WALK_IN_ARRIVED) nor moved (409 WALK_IN_NOT_RESCHEDULABLE).
    if (!b.slot?.walkIn) {
      const ended = labSlotEnd(b.slot).getTime() <= now.getTime();
      out.push({ action: 'no_show', blocked: waiting ?? (ended ? undefined : `A no-show can be marked only after the slot has ended (${b.slot.endTime}).`) });
      // Q14: a booking moved after a no-show is neither moved again the ordinary way (409 NO_SHOW_RESCHEDULE_USED) nor
      // rejected for a refund (409 NO_SHOW_NOT_REFUNDABLE). r12: a desk row is cancelled with the desk cancel (no money).
      if (!noShowMovedOnce(b)) out.push({ action: 'reschedule' }, ...(desk ? [] : [{ action: 'reject' as const }]));
    }
  }
  if ((b.status === 'sample_collected' || b.status === 'visited') && manage) out.push({ action: 'process' });
  if (b.status === 'processing' || b.status === 'report_ready') {
    if (holdsAny(actor, ['reports.upload'])) out.push({ action: 'upload' });
    if (holdsAny(actor, ['reports.release'])) {
      out.push({ action: 'release', blocked: b.report.draftFiles.length ? undefined : 'Upload a report first.' });
    }
  }
  if (b.status === 'report_ready' && manage) out.push({ action: 'complete' });
  return out;
}

/** D1 `canReadPartnerLabReport`: drafts are readable by report staff only; released files also by booking staff. */
export const canReadDrafts = (actor: Pick<PartnerActorView, 'role' | 'permissions'>) => holdsAny(actor, ['reports.upload', 'reports.release']);

/**
 * `signerFor` (admins name the signer): an active member of this partner, owner or holding `reports.release`, whose
 * branches cover the booking's branch, with a professional registration number on record.
 */
export function eligibleSigners(members: readonly PartnerMember[], branchId: string): PartnerMember[] {
  return members.filter((m) => m.isActive !== false
    && (m.role === 'owner' || m.permissions.includes('reports.release'))
    && (m.role === 'owner' || m.branchIds.length === 0 || m.branchIds.includes(branchId))
    && !!m.professional?.registrationNumber?.trim());
}

// ── Paths ──

function checkId(id: string, what: string): string {
  if (!OBJECT_ID_PATTERN.test(id)) throw new Error(`Invalid ${what} id`);
  return id;
}
function checkMode(mode: string): VisitMode {
  if (mode !== 'home' && mode !== 'lab') throw new Error('Invalid visit mode');
  return mode;
}
function checkDate(date: string | undefined, what: string): string | undefined {
  if (date !== undefined && !isRealDate(date)) throw new Error(`Invalid ${what} date`);
  return date;
}

/** Slots and lab bookings of one partner workspace (member, or admin acting as owner). Ids are checked before any path. */
export function partnerLabsApi(c: ApiClient, scope: PartnerScope) {
  const base = () => partnerWorkspaceBase(scope);
  const slot = (id: string) => `${base()}/slots/${checkId(id, 'slot')}`;
  const booking = (id: string) => `${base()}/lab-bookings/${checkId(id, 'booking')}`;
  /**
   * Q11 `expectedVersionSchema`: every step may name the booking's `statusVersion` it was reviewed on; the server then
   * refuses it with 409 LAB_BOOKING_CHANGED if the booking moved since (`assertVersion`).
   */
  const fence = (v: number | undefined) => {
    if (v === undefined) return {};
    if (!Number.isSafeInteger(v) || v < 0) throw new Error('Invalid booking version');
    return { expectedVersion: v };
  };
  const act = (id: string, command: string, v?: number) => c.post<LabBooking>(`${booking(id)}/${command}`, { body: fence(v) });
  return {
    /** Every slot of one branch and visit mode between two IST dates (inclusive), by start time; at most 2000. */
    slots: (q: SlotQuery) => c.get<LabSlot[]>(`${base()}/slots`, {
      query: { branchId: checkId(q.branchId, 'branch'), visitMode: checkMode(q.visitMode), from: checkDate(q.from, 'from'), to: checkDate(q.to, 'to') },
    }),
    /** Q11 `getSlotTemplate`: the saved weekly template of a branch and visit mode, or null when it has none. */
    template: async (branchId: string, visitMode: VisitMode) =>
      (await c.get<SlotTemplate | null>(`${base()}/branches/${checkId(branchId, 'branch')}/slot-templates/${checkMode(visitMode)}`)) ?? null,
    /**
     * Replaces the weekly template and expands the next 30 days at once (`saveSlotTemplate`). `expectedUpdatedAt` is the
     * version the editor started from (null = no template then): 409 TEMPLATE_CHANGED when another save came in between.
     */
    saveTemplate: (branchId: string, visitMode: VisitMode, body: SlotTemplateInput, expectedUpdatedAt: TemplateVersion) =>
      c.put<{ template: SlotTemplate; expansion: ExpansionResult }>(
        `${base()}/branches/${checkId(branchId, 'branch')}/slot-templates/${checkMode(visitMode)}`, { body: { ...body, expectedUpdatedAt } }),
    /** 409 SLOT_EXISTS when a slot already starts then (so a resend after a lost answer cannot make a second one). */
    addSlot: (body: NewManualSlot) => {
      checkId(body.branchId, 'branch'); checkMode(body.visitMode); checkDate(body.date, 'slot');
      return c.post<LabSlot>(`${base()}/slots`, { body });
    },
    /** 409 SLOT_CAPACITY_BELOW_BOOKED below the booked seats. */
    setCapacity: (id: string, capacity: number) => c.put<LabSlot>(`${slot(id)}/capacity`, { body: { capacity } }),
    /** Stops new bookings; existing bookings keep their seats. */
    closeSlot: (id: string) => c.post<LabSlot>(`${slot(id)}/close`, { body: {} }),
    reopenSlot: (id: string) => c.post<LabSlot>(`${slot(id)}/reopen`, { body: {} }),

    /** One page of bookings, soonest slot first; pass the last page's `nextCursor` for the next one. */
    bookings: (q: LabBookingQuery = {}): Promise<Page<LabBooking>> => {
      if (q.cursor !== undefined && !LAB_BOOKING_CURSOR_PATTERN.test(q.cursor)) throw new Error('Invalid cursor');
      if (q.limit !== undefined && (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > LAB_BOOKINGS_PAGE_MAX)) throw new Error('Invalid page size');
      return c.page<LabBooking>(`${base()}/lab-bookings`, {
        query: {
          status: q.status, branchId: q.branchId === undefined ? undefined : checkId(q.branchId, 'branch'),
          from: checkDate(q.from, 'from'), to: checkDate(q.to, 'to'), limit: q.limit, cursor: q.cursor, source: q.source,
        },
      });
    },
    booking: (id: string) => c.get<LabBooking>(booking(id)),
    /** Every step below takes the `statusVersion` it was reviewed on (409 LAB_BOOKING_CHANGED when the booking moved). */
    assignCollector: (id: string, body: CollectorInput, v?: number) => {
      if (body.memberId !== undefined) checkId(body.memberId, 'member');
      return c.post<LabBooking>(`${booking(id)}/assign`, { body: { ...body, ...fence(v) } });
    },
    markCollected: (id: string, v?: number) => act(id, 'collect', v),
    markVisited: (id: string, v?: number) => act(id, 'visit', v),
    markNoShow: (id: string, v?: number) => act(id, 'no-show', v),
    startProcessing: (id: string, v?: number) => act(id, 'process', v),
    complete: (id: string, v?: number) => act(id, 'complete', v),
    /** Cancels a confirmed booking and returns the full payment to the customer's wallet (`refunded` in rupees). */
    reject: (id: string, reason: string, v?: number) =>
      c.post<{ booking: LabBooking; refunded: number }>(`${booking(id)}/reject`, { body: { reason, ...fence(v) } }),
    /** Moves the seat to another slot now; the customer accepts it or cancels with a full refund. */
    reschedule: (id: string, slotId: string, reason: string, v?: number) =>
      c.post<LabBooking>(`${booking(id)}/reschedule`, { body: { slotId: checkId(slotId, 'slot'), reason, ...fence(v) } }),
    /**
     * Q14: moves a no-show once to a later open slot of its branch and visit mode (same price, no payment, no refund);
     * back to confirmed. `expectedVersion` is the `statusVersion` the move was decided on (409 LAB_BOOKING_CHANGED).
     * The same key and slot again answer the move already made (`replayed`); a booking moved once is 409 NO_SHOW_RESCHEDULE_USED.
     */
    rescheduleNoShow: (id: string, slotId: string, requestKey: string, expectedVersion?: number) => {
      if (!REQUEST_KEY_PATTERN.test(requestKey)) throw new Error('Invalid request key');
      if (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)) throw new Error('Invalid booking version');
      return c.post<LabBooking & { replayed?: boolean }>(`${booking(id)}/reschedule-no-show`, {
        body: { slotId: checkId(slotId, 'slot'), requestKey, ...(expectedVersion !== undefined ? { expectedVersion } : {}) },
      });
    },
    /**
     * multipart `files`: ONE file per request (WQ11b: the server's upload limit of 10 MB is for the whole request, so
     * several files together are refused), added as a draft report of this booking (not visible to the customer). Q11
     * `?requestKey=`: the same key again answers the booking with that file already attached (`replayed`), never a copy.
     */
    uploadReport: (id: string, file: File, requestKey: string) => {
      if (!REQUEST_KEY_PATTERN.test(requestKey)) throw new Error('Invalid request key');
      const form = new FormData();
      form.append('files', file, file.name);
      // WQ11d: a report of up to 10 MB on a slow connection takes long: the answer is awaited up to 2 minutes, not 20 s.
      return c.post<LabBooking>(`${booking(id)}/reports`, { form, query: { requestKey }, timeoutMs: REPORT_UPLOAD_TIMEOUT_MS });
    },
    /**
     * Releases one draft to the customer under a professional (`releaseReport`): members always sign as themselves (omit
     * `signerMemberId`); admins must name the signer. Releasing an already released file changes nothing.
     */
    releaseReport: (id: string, file: string, signerMemberId?: string, v?: number) => {
      if (reportFileBooking(file) !== id.toLowerCase()) throw new Error('Not a report file of this booking');
      if (signerMemberId !== undefined) checkId(signerMemberId, 'signer');
      return c.post<LabBooking>(`${booking(id)}/reports/release`, { body: { file, ...(signerMemberId ? { signerMemberId } : {}), ...fence(v) } });
    },
    /**
     * A report file of `bookingId`, read with the session's token through the authenticated file route (D1 decides:
     * drafts for report staff, released files for booking staff too). Never a link with a token in it.
     */
    reportFile: (bookingId: string, stored: string, signal?: AbortSignal) => {
      if (reportFileBooking(stored) !== checkId(bookingId, 'booking').toLowerCase()) throw new Error('Not a report file of this booking');
      return c.blob('/file/fetch', { query: { url: stored }, signal });
    },
  };
}

/** Q16a `adminCancelNoShowSchema`: a reason (trimmed, 3–500) and an explicit refund choice. */
export interface AdminNoShowCancel { reason: string; refund: boolean }

/** Platform admins: lab bookings of every partner. */
export function labBookingsAdminApi(c: ApiClient) {
  return {
    /**
     * Q16a `POST /partner-workspace/admin/lab-bookings/:bookingId/cancel-no-show` (`adminCancelMovedNoShow`): an admin
     * cancels a CONFIRMED booking that was moved after a no-show (409 BOOKING_NOT_MOVED_NO_SHOW otherwise; 409
     * LAB_BOOKING_STATE_CONFLICT when it is no longer confirmed). `refund` true = the ordinary full refund to the
     * wallet (`refunded`, rupees); false = the money stays as for a no-show. The seat is freed either way.
     */
    cancelMovedNoShow: (bookingId: string, body: AdminNoShowCancel) => {
      const reason = body.reason.trim();
      if (reason.length < MIN_LAB_REASON || reason.length > MAX_LAB_REASON) throw new Error('Invalid reason');
      if (typeof body.refund !== 'boolean') throw new Error('Choose whether the patient is refunded');
      return c.post<{ booking: LabBooking; refunded: number }>(`/partner-workspace/admin/lab-bookings/${checkId(bookingId, 'booking')}/cancel-no-show`,
        { body: { reason, refund: body.refund } });
    },
    /** One page, newest booked first (`page` from 1, `limit` up to 200). */
    list: (q: AdminLabBookingQuery = {}): Promise<Page<AdminLabBookingRow>> => {
      if (q.page !== undefined && (!Number.isInteger(q.page) || q.page < 1)) throw new Error('Invalid page');
      if (q.limit !== undefined && (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > ADMIN_LAB_BOOKINGS_PAGE_MAX)) throw new Error('Invalid page size');
      return c.page<AdminLabBookingRow>('/partner-workspace/admin/lab-bookings', {
        query: {
          partnerId: q.partnerId === undefined ? undefined : checkId(q.partnerId, 'partner'), status: q.status,
          from: checkDate(q.from, 'from'), to: checkDate(q.to, 'to'), page: q.page, limit: q.limit,
        },
      });
    },
  };
}
