import type { ApiClient } from './client.ts';
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

/**
 * The server has no route that reads a saved template, so the editor starts from what the template GENERATED: the
 * template slots (`source: 'template'`) the template still wants (not `closed: 'template'`). The slot length and seats
 * are the most common among unbooked ones (a booked slot keeps its old time and never loses seats); each weekday's
 * windows are runs of back-to-back start times. Null when no generated slot is in the given list.
 */
export function deriveTemplate(slots: readonly LabSlot[]): SlotTemplateInput | null {
  const wanted = slots.filter((s) => s.source === 'template' && s.closed !== 'template'
    && HHMM_PATTERN.test(s.startTime) && HHMM_PATTERN.test(s.endTime) && isRealDate(s.date));
  if (wanted.length === 0) return null;
  const unbooked = wanted.filter((s) => s.booked === 0);
  const basis = unbooked.length ? unbooked : wanted;
  const slotMinutes = mostCommon(basis.map((s) => toMinutes(s.endTime) - toMinutes(s.startTime)).filter((m) => m > 0));
  const capacity = mostCommon(basis.map((s) => s.capacity).filter((c) => c >= 1));
  if (!slotMinutes || !capacity) return null;
  const days: TemplateDays = {};
  for (const day of TEMPLATE_WEEKDAYS) {
    const starts = [...new Set(wanted.filter((s) => weekdayOf(s.date) === day).map((s) => toMinutes(s.startTime)))].sort((a, b) => a - b);
    const windows: SlotWindow[] = [];
    for (const m of starts) {
      const last = windows[windows.length - 1];
      if (last && toMinutes(last.end) === m) last.end = toHHMM(Math.min(m + slotMinutes, 24 * 60 - 1));
      else windows.push({ start: toHHMM(m), end: toHHMM(Math.min(m + slotMinutes, 24 * 60 - 1)) });
    }
    if (windows.length) days[day] = windows;
  }
  return { slotMinutes, capacity, days };
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

export interface LabBookingSlot { slotId: string; date: string; startTime: string; endTime: string; startsAt: string }
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
  cancellation?: { reason: 'timeout' | 'customer' | 'lab_reject'; note?: string; by: string; byKind: 'customer' | 'member' | 'admin' | 'system'; at: string };
  reschedule: { version: number; pending: boolean; previousSlot?: LabBookingSlot; reason?: string; at?: string; by?: string };
  collector?: { memberId?: string; name: string; phone?: string };
  report: { draftFiles: string[]; releasedFiles: string[]; releases: LabReportRelease[] };
  lifecycle: Partial<Record<LabLifecycleKey, string>>;
  /** Q14: the no-show this booking was moved after (at most one; a second no-show is final). */
  noShows?: LabNoShowMove[];
  noShowReschedules?: number;
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

/** `partnerLabBookingQuerySchema`: sorted by slot time (oldest first); `limit` 1–500 (server default 100); no paging. */
export interface LabBookingQuery { status?: LabBookingStatus; branchId?: string; from?: string; to?: string; limit?: number }
export const MAX_LAB_BOOKINGS = 500;
/** `GET /partner-workspace/admin/lab-bookings`: newest created first, at most 200, filters partnerId and status only. */
export interface AdminLabBookingQuery { partnerId?: string; status?: LabBookingStatus }
export const MAX_ADMIN_LAB_BOOKINGS = 200;

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

export type LabAction = 'assign' | 'collect' | 'visit' | 'no_show' | 'process' | 'complete' | 'reject' | 'reschedule' | 'upload' | 'release';
/** An action this person may take on this booking now; `blocked` says why it cannot be taken yet (offered, disabled). */
export interface LabActionOffer { action: LabAction; blocked?: string }

/**
 * The §4 transitions of `services/labBookings.ts`, for this actor:
 * - `bookings.manage`: on a confirmed booking — assign a collector (home collections here), mark collected (home) or
 *   visited (lab), no-show (only after the slot time), each of these three only while no new time is waiting for the
 *   customer; reject (full refund) and propose a new time. Then processing (from collected/visited) and completed (from
 *   report released).
 * - `reports.upload`: add draft files while processing or report released; `reports.release`: release a draft then.
 * Unpaid (`pending_payment`) and finished bookings offer nothing.
 */
export function labActions(b: Pick<LabBooking, 'status' | 'paymentStatus' | 'visitMode' | 'reschedule' | 'slot' | 'report' | 'noShows' | 'noShowReschedules'>,
  actor: Pick<PartnerActorView, 'role' | 'permissions'>, now: Date): LabActionOffer[] {
  if (b.paymentStatus !== 'paid') return [];
  const manage = holdsAny(actor, ['bookings.manage']);
  const out: LabActionOffer[] = [];
  const waiting = b.reschedule?.pending ? 'The customer has not answered the new time yet.' : undefined;
  if (b.status === 'confirmed' && manage) {
    if (b.visitMode === 'home') out.push({ action: 'assign' }, { action: 'collect', blocked: waiting });
    else out.push({ action: 'visit', blocked: waiting });
    const started = Date.parse(b.slot.startsAt) <= now.getTime();
    out.push({ action: 'no_show', blocked: waiting ?? (started ? undefined : 'A no-show can be marked only after the slot time.') });
    // Q14: a booking moved after a no-show is neither moved again the ordinary way (409 NO_SHOW_RESCHEDULE_USED) nor
    // rejected for a refund (409 NO_SHOW_NOT_REFUNDABLE).
    if (!noShowMovedOnce(b)) out.push({ action: 'reschedule' }, { action: 'reject' });
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
  const act = (id: string, command: string) => c.post<LabBooking>(`${booking(id)}/${command}`, { body: {} });
  return {
    /** Every slot of one branch and visit mode between two IST dates (inclusive), by start time; at most 2000. */
    slots: (q: SlotQuery) => c.get<LabSlot[]>(`${base()}/slots`, {
      query: { branchId: checkId(q.branchId, 'branch'), visitMode: checkMode(q.visitMode), from: checkDate(q.from, 'from'), to: checkDate(q.to, 'to') },
    }),
    /** Replaces the weekly template and expands the next 30 days at once (`saveSlotTemplate`). */
    saveTemplate: (branchId: string, visitMode: VisitMode, body: SlotTemplateInput) =>
      c.put<{ template: SlotTemplate; expansion: ExpansionResult }>(
        `${base()}/branches/${checkId(branchId, 'branch')}/slot-templates/${checkMode(visitMode)}`, { body }),
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

    bookings: (q: LabBookingQuery = {}) => c.get<LabBooking[]>(`${base()}/lab-bookings`, {
      query: {
        status: q.status, branchId: q.branchId === undefined ? undefined : checkId(q.branchId, 'branch'),
        from: checkDate(q.from, 'from'), to: checkDate(q.to, 'to'), limit: q.limit,
      },
    }),
    booking: (id: string) => c.get<LabBooking>(booking(id)),
    assignCollector: (id: string, body: CollectorInput) => {
      if (body.memberId !== undefined) checkId(body.memberId, 'member');
      return c.post<LabBooking>(`${booking(id)}/assign`, { body });
    },
    markCollected: (id: string) => act(id, 'collect'),
    markVisited: (id: string) => act(id, 'visit'),
    markNoShow: (id: string) => act(id, 'no-show'),
    startProcessing: (id: string) => act(id, 'process'),
    complete: (id: string) => act(id, 'complete'),
    /** Cancels a confirmed booking and returns the full payment to the customer's wallet (`refunded` in rupees). */
    reject: (id: string, reason: string) => c.post<{ booking: LabBooking; refunded: number }>(`${booking(id)}/reject`, { body: { reason } }),
    /** Moves the seat to another slot now; the customer accepts it or cancels with a full refund. */
    reschedule: (id: string, slotId: string, reason: string) =>
      c.post<LabBooking>(`${booking(id)}/reschedule`, { body: { slotId: checkId(slotId, 'slot'), reason } }),
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
    /** multipart `files`: each becomes a draft report of this booking (not visible to the customer). */
    uploadReports: (id: string, files: readonly File[]) => {
      const form = new FormData();
      for (const f of files) form.append('files', f, f.name);
      return c.post<LabBooking>(`${booking(id)}/reports`, { form });
    },
    /**
     * Releases one draft to the customer under a professional (`releaseReport`): members always sign as themselves (omit
     * `signerMemberId`); admins must name the signer. Releasing an already released file changes nothing.
     */
    releaseReport: (id: string, file: string, signerMemberId?: string) => {
      if (reportFileBooking(file) !== id.toLowerCase()) throw new Error('Not a report file of this booking');
      if (signerMemberId !== undefined) checkId(signerMemberId, 'signer');
      return c.post<LabBooking>(`${booking(id)}/reports/release`, { body: { file, ...(signerMemberId ? { signerMemberId } : {}) } });
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

/** Platform admins: lab bookings of every partner. */
export function labBookingsAdminApi(c: ApiClient) {
  return {
    list: (q: AdminLabBookingQuery = {}) => c.get<AdminLabBookingRow[]>('/partner-workspace/admin/lab-bookings', {
      query: { partnerId: q.partnerId === undefined ? undefined : checkId(q.partnerId, 'partner'), status: q.status },
    }),
  };
}
