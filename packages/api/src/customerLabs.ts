import type { ApiClient, Page } from './client.ts';
import type { PaymentOrder } from './customer.ts';
import { fetchableFileUrl } from './pharmacyOrders.ts';

/**
 * Q3 partner labs for customers: discovery (`/partner-labs`) and bookings (`/lab-bookings`). Shapes mirror the backend
 * (src1/modules/partners/services/labBookings.ts: `listLabs`, `labCatalogue`, `branchSlots`, `customerView`;
 * validation/labBooking.ts; model/labBooking.ts). Amounts are integer paise (`*Minor`) unless named otherwise.
 */

export type VisitMode = 'home' | 'lab';

export interface LabAddress { line1: string; line2?: string; city: string; state?: string; stateCode?: string; pincode: string }

export interface LabBranch {
  branchId: string;
  name: string;
  address?: LabAddress;
  phone?: string;
  homeCollection: boolean;
  inLab: boolean;
  hours?: Partial<Record<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun', { open: string; close: string }>>;
}

/** GET /partner-labs: verified, active lab partners that have at least one matching active branch. */
export interface PartnerLab { partnerId: string; name: string; logo?: string; provider: 'partner'; branches: LabBranch[] }

/** GET /partner-labs/:partnerId/catalogue */
export interface LabCatalogueItem {
  itemId: string;
  kind: 'test' | 'package';
  name: string;
  code?: string;
  description?: string;
  preparation?: string;
  sampleType?: string;
  includes?: string[];
  /** Rupees (the backend's own conversion of priceMinor). */
  price: number;
  priceMinor: number;
  mrpMinor?: number;
  visitModes: VisitMode[];
  reportTatHours?: number;
}

/** GET /partner-labs/branches/:branchId/slots: bookable slots only (start at least an hour from now, seats left). */
export interface LabSlot { slotId: string; /** YYYY-MM-DD (IST) */ date: string; /** HH:mm */ startTime: string; endTime: string; seatsLeft: number }

export type LabBookingStatus =
  | 'pending_payment' | 'confirmed' | 'sample_collected' | 'visited' | 'processing' | 'report_ready' | 'completed' | 'cancelled' | 'no_show';

export interface LabBookingSlot { slotId: string; date: string; startTime: string; endTime: string; /** ISO instant */ startsAt: string }

export interface LabBookingItem {
  catalogItemId: string; kind: 'test' | 'package'; name: string; code?: string; priceMinor: number; mrpMinor?: number; gstRate?: number;
  reportTatHours?: number;
}

/** The customer view of a partner-lab booking (`customerView`): no ledger, no staff ids, released reports only. */
export interface LabBooking {
  _id: string;
  partnerId: string;
  branchId: string;
  userId?: string;
  patient: { kind: 'self' | 'dependent'; dependentId?: string; name: string; age?: number; gender?: string };
  visitMode: VisitMode;
  address?: { line1: string; line2?: string; city: string; state?: string; pincode: string; landmark?: string };
  slot: LabBookingSlot;
  items: LabBookingItem[];
  pricing: { subtotalMinor: number; couponCode?: string; discountMinor: number; payableMinor: number; currency: 'INR' };
  status: LabBookingStatus;
  statusVersion?: number;
  paymentStatus: 'pending' | 'paid' | 'refunded';
  paymentTransactionId?: string;
  /** ISO: an unpaid booking is released after this (30 minutes from creation, LAB_PAYMENT_WINDOW_MS). */
  paymentDeadline: string;
  cancellation?: { reason: 'timeout' | 'customer' | 'lab_reject'; note?: string; at?: string; byKind?: 'customer' | 'member' | 'admin' | 'system' };
  /** A lab-proposed new time waits for the customer while `pending` (the slot shown is already the proposed one). */
  reschedule?: { version: number; pending: boolean; previousSlot?: LabBookingSlot; reason?: string; at?: string };
  collector?: { name: string; phone?: string };
  /** Released report files (stored `/api/static/...` URLs, D1 private: read through the authenticated file route). */
  report: { files: string[]; releases: { /** Q9: the released file this record is for. */ file?: string; releasedAt: string; signer: { name: string; kind?: string; registrationNumber: string } }[] };
  /** Q9: the lab's and branch's names (read time). */
  lab?: { name?: string };
  branch?: { name?: string; address?: LabAddress; phone?: string };
  lifecycle?: Partial<Record<'paidAt' | 'confirmedAt' | 'collectedAt' | 'visitedAt' | 'processingAt' | 'reportReadyAt' | 'completedAt' | 'cancelledAt' | 'noShowAt', string>>;
  /**
   * Q14 `customerView.noShows`: a missed slot the lab moved once to a new time (`slot` is the new time). Such a booking
   * is never refunded (409 NO_SHOW_NOT_REFUNDABLE on cancel).
   */
  noShows?: { at?: string; rescheduledAt: string; fromSlot: LabBookingSlot; toSlot: LabBookingSlot }[];
  createdAt?: string;
  updatedAt?: string;
}

export interface NewLabBooking {
  partnerId: string;
  branchId: string;
  visitMode: VisitMode;
  slotId: string;
  itemIds: string[];
  patient: { kind: 'self' } | { kind: 'dependent'; dependentId: string };
  /** Required for a home collection, forbidden for a lab visit (createLabBookingSchema). */
  address?: { line1: string; line2?: string; city: string; state?: string; pincode: string; landmark?: string };
  couponCode?: string;
  useWalletBalance?: boolean;
  /** Q9 price fence (paise): what the customer saw and accepted; the server refuses (409 PRICE_CHANGED) on any difference. */
  acceptedPayableMinor: number;
  acceptedSubtotalMinor?: number;
}

/** POST /lab-bookings and POST /lab-bookings/:id/pay (`LabBookingPaymentInit`). */
export interface LabBookingPayment {
  booking: LabBooking;
  paymentRequired: boolean;
  walletDeductedAmount: number;
  payment?: PaymentOrder;
}

/** Backend constants (services/labBookings.ts). The server decides; the app only explains them. */
export const LAB_PAYMENT_WINDOW_MIN = 30;
export const LAB_CANCEL_CUTOFF_HOURS = 2;
/** createLabBookingSchema: at most 20 distinct items. */
export const LAB_MAX_ITEMS = 20;
/** createLabBookingSchema address rules. */
export const LAB_PINCODE_PATTERN = /^[1-9][0-9]{5}$/;
export const LAB_ADDRESS_LIMITS = { line1: [3, 200], city: [2, 80], line2: [0, 200], state: [0, 80], landmark: [0, 120] } as const;

/** Paise → rupees (for formatRupees). */
export const fromPaise = (minor: number | undefined | null) => (minor == null || !Number.isFinite(minor) ? undefined : Math.round(minor) / 100);

/** Inline errors for a home-collection address, by the backend's own limits (null = valid). */
export function addressErrors(a: { line1: string; line2?: string; city: string; state?: string; pincode: string; landmark?: string }): Record<string, string> {
  const e: Record<string, string> = {};
  const len = (v: string | undefined) => (v ?? '').trim().length;
  if (len(a.line1) < 3) e.line1 = 'Enter the house number and street (at least 3 characters).';
  else if (len(a.line1) > 200) e.line1 = 'Keep this under 200 characters.';
  if (len(a.line2) > 200) e.line2 = 'Keep this under 200 characters.';
  if (len(a.city) < 2) e.city = 'Enter the city.';
  else if (len(a.city) > 80) e.city = 'Keep this under 80 characters.';
  if (len(a.state) > 80) e.state = 'Keep this under 80 characters.';
  if (len(a.landmark) > 120) e.landmark = 'Keep this under 120 characters.';
  if (!LAB_PINCODE_PATTERN.test(a.pincode.trim())) e.pincode = 'Enter a 6-digit pincode.';
  return e;
}

export type LabCancelCheck =
  | { ok: true; deadline: Date | null; refund: boolean }
  | { ok: false; reason: 'state' | 'window_closed' | 'no_show_moved' };

/**
 * `customerCancel`: only pending_payment or confirmed bookings can be cancelled; once money was captured, only until
 * 2 hours before the slot, except while a lab-proposed new time is unanswered (then any time, full refund).
 */
export function labCancelCheck(b: Pick<LabBooking, 'status' | 'paymentStatus' | 'reschedule' | 'slot' | 'noShows'>, now = new Date()): LabCancelCheck {
  if (b.status !== 'pending_payment' && b.status !== 'confirmed') return { ok: false, reason: 'state' };
  // Q14: a booking moved after a no-show is never refunded (`NO_SHOW_NOT_REFUNDABLE`).
  if ((b.noShows?.length ?? 0) > 0) return { ok: false, reason: 'no_show_moved' };
  const paid = b.paymentStatus === 'paid';
  if (!paid || b.reschedule?.pending) return { ok: true, deadline: null, refund: paid };
  const starts = Date.parse(b.slot.startsAt);
  if (!Number.isFinite(starts)) return { ok: true, deadline: null, refund: true };
  const deadline = new Date(starts - LAB_CANCEL_CUTOFF_HOURS * 3_600_000);
  return now.getTime() > deadline.getTime() ? { ok: false, reason: 'window_closed' } : { ok: true, deadline, refund: true };
}

export interface TimelineStep { key: string; label: string; at?: string; done: boolean }

/** The booking's path through the backend's state machine, with the time of each step the server recorded. */
export function labTimeline(b: Pick<LabBooking, 'status' | 'visitMode' | 'lifecycle' | 'createdAt'>): TimelineStep[] {
  const l = b.lifecycle ?? {};
  const order: LabBookingStatus[] = ['pending_payment', 'confirmed', b.visitMode === 'home' ? 'sample_collected' : 'visited', 'processing', 'report_ready', 'completed'];
  const reached = order.indexOf(b.status);
  const steps: TimelineStep[] = [
    { key: 'booked', label: 'Booked', at: b.createdAt, done: true },
    { key: 'confirmed', label: 'Paid and confirmed', at: l.confirmedAt ?? l.paidAt, done: !!(l.confirmedAt ?? l.paidAt) || reached >= 1 },
    b.visitMode === 'home'
      ? { key: 'collected', label: 'Sample collected', at: l.collectedAt, done: !!l.collectedAt || reached >= 2 }
      : { key: 'visited', label: 'Lab visit done', at: l.visitedAt, done: !!l.visitedAt || reached >= 2 },
    { key: 'processing', label: 'Sample being tested', at: l.processingAt, done: !!l.processingAt || reached >= 3 },
    { key: 'report_ready', label: 'Report ready', at: l.reportReadyAt, done: !!l.reportReadyAt || reached >= 4 },
    { key: 'completed', label: 'Completed', at: l.completedAt, done: !!l.completedAt || reached >= 5 },
  ];
  if (b.status === 'cancelled') return [...steps.filter((s) => s.done), { key: 'cancelled', label: 'Cancelled', at: l.cancelledAt, done: true }];
  if (b.status === 'no_show') return [...steps.filter((s) => s.done), { key: 'no_show', label: 'Marked as not present', at: l.noShowAt, done: true }];
  return steps;
}

/** The amount the server will charge (`couponFor` + create): subtotal minus the coupon discount, in paise. */
export function labPayableMinor(subtotalMinor: number, couponDiscountRupees?: number): number {
  const discount = couponDiscountRupees ? Math.min(subtotalMinor, Math.round(Number(couponDiscountRupees) * 100)) : 0;
  return Math.max(0, subtotalMinor - discount);
}

/** Q9 `GET /partner-labs/:partnerId` answers raw branch records; this gives them the list's shape. */
export function normalizeLab(raw: unknown): PartnerLab {
  const r = (raw ?? {}) as { partnerId?: string; name?: string; logo?: string; branches?: Record<string, unknown>[] };
  const branches = (Array.isArray(r.branches) ? r.branches : []).map((b) => {
    const services = (b.services ?? {}) as { homeCollection?: boolean; inLab?: boolean };
    return {
      branchId: String(b.branchId ?? b._id ?? ''), name: String(b.name ?? ''), address: b.address as LabAddress | undefined, phone: b.phone as string | undefined,
      homeCollection: Boolean(b.homeCollection ?? services.homeCollection), inLab: Boolean(b.inLab ?? services.inLab), hours: b.hours as LabBranch['hours'],
    };
  }).filter((b) => /^[0-9a-fA-F]{24}$/.test(b.branchId));
  return { partnerId: String(r.partnerId ?? ''), name: String(r.name ?? ''), logo: r.logo, provider: 'partner', branches };
}

const hex = /^[0-9a-fA-F]{24}$/;
const id = (v: string, what: string) => { if (!hex.test(v)) throw new Error(`Invalid ${what} id`); return v; };

/** "YYYY-MM-DD" in IST for `now` plus `days`. */
export function istDay(now = new Date(), days = 0): string {
  return new Date(now.getTime() + days * 86_400_000 + 330 * 60_000).toISOString().slice(0, 10);
}

export function customerLabsApi(c: ApiClient) {
  return {
    /** labsQuerySchema: optional city, 6-digit pincode, visit mode. */
    labs: (f: { city?: string; pincode?: string; visitMode?: VisitMode } = {}) => {
      if (f.pincode && !LAB_PINCODE_PATTERN.test(f.pincode)) throw new Error('Invalid pincode');
      return c.get<PartnerLab[]>('/partner-labs', { query: { city: f.city?.trim() || undefined, pincode: f.pincode, visitMode: f.visitMode } })
        .then((d) => (Array.isArray(d) ? d : []));
    },
    /** Q9: one lab (verified, active) with its active branches; 404 LAB_NOT_FOUND otherwise. */
    lab: (partnerId: string) => c.get<unknown>(`/partner-labs/${id(partnerId, 'lab')}`).then(normalizeLab),
    catalogue: (partnerId: string, visitMode?: VisitMode) =>
      c.get<LabCatalogueItem[]>(`/partner-labs/${id(partnerId, 'lab')}/catalogue`, { query: { visitMode } }).then((d) => (Array.isArray(d) ? d : [])),
    /** branchSlotsQuerySchema: from YYYY-MM-DD (default today, IST), days 1–30 (default 7). */
    slots: (branchId: string, visitMode: VisitMode, from?: string, days = 7) => {
      if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new Error('Invalid date');
      return c.get<LabSlot[]>(`/partner-labs/branches/${id(branchId, 'branch')}/slots`, { query: { visitMode, from, days: Math.min(Math.max(days, 1), 30) } })
        .then((d) => (Array.isArray(d) ? d : []));
    },

    /** Keyed create: the same key and details again return the first booking (and its open payment), never a second. */
    book: (body: NewLabBooking, requestKey: string) => c.post<LabBookingPayment>('/lab-bookings', { body: { ...body, requestKey } }),
    /** Q9: newest first, paged. */
    bookings: (page = 1, limit = 20): Promise<Page<LabBooking>> => c.page<LabBooking>('/lab-bookings', { query: { page, limit } }),
    booking: (bookingId: string) => c.get<LabBooking>(`/lab-bookings/${id(bookingId, 'booking')}`),
    /** Pay again within the window: earlier attempts are checked first; the open order is reused. */
    payAgain: (bookingId: string, useWalletBalance = false) =>
      c.post<LabBookingPayment>(`/lab-bookings/${id(bookingId, 'booking')}/pay`, { body: useWalletBalance ? { useWalletBalance: true } : {} }),
    /** Full refund to the wallet of whatever was paid. */
    cancel: (bookingId: string, note?: string) =>
      c.post<{ booking: LabBooking; refunded: number }>(`/lab-bookings/${id(bookingId, 'booking')}/cancel`, { body: note ? { note } : {} }),
    /** Accepts exactly the proposal shown (its version); a newer proposal is refused (409 RESCHEDULE_CHANGED). */
    acceptReschedule: (bookingId: string, version: number) =>
      c.post<LabBooking>(`/lab-bookings/${id(bookingId, 'booking')}/accept-reschedule`, { body: { version } }),
    /** A released report file, read with the customer's token through `GET /file/fetch` (never a token in a URL). */
    reportFile: (storedUrl: string, signal?: AbortSignal) => c.blob('/file/fetch', { query: { url: fetchableFileUrl(storedUrl) }, signal }),
    /** Coupon check with the same context the create uses (`couponFor`: external_diagnostics, partner id, items). */
    checkCoupon: (b: { code: string; partnerId: string; purchaseAmount: number; testIds: string[]; packageIds: string[] }) =>
      c.post<{ isValid: boolean; discountAmount?: number; finalAmount?: number; message?: string; coupon?: { code: string } }>('/coupons/validate', {
        body: { code: b.code, bookingType: 'external_diagnostics', bookingId: id(b.partnerId, 'lab'), purchaseAmount: b.purchaseAmount,
          ...(b.testIds.length ? { testIds: b.testIds } : {}), ...(b.packageIds.length ? { packageIds: b.packageIds } : {}) },
      }),
  };
}
