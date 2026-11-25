import { formatClock } from '@jansetu/i18n';
import { ApiError, type ApiClient } from './client.ts';
import { assistedRefusal, hex, idOf as checkedId, rupees, type BookedConsultation, type BookingPayment, type CancelAnswer, type CardRefund, type OpenCardOrder } from './assisted.ts';
import { t, type AssistedKey } from './i18n/assisted/index.ts';
import { onLanguage, wordMap } from './i18n/words.ts';

/**
 * WQ16: assisted booking phase 1b, a pharmacy pays a walk-in consultation by card or UPI (backend r10
 * `m0/r10-phase1b` 9f2a1807, design ASSISTED_BOOKING_DESIGN.md §23.3). The booking is created with
 * `paymentMethod: 'razorpay'` (held as pending payment with ONE Razorpay order), Checkout takes the payment, the browser's
 * proof goes to `POST /payments/verify` (no `module`, S6), and the server's own check `POST /payments/reconcile` is the
 * fallback. Only the server's `paymentRecord.status` says paid or refunded; nothing here claims either on its own.
 */

const idOf = (v: string) => checkedId(v, 'payment');

/** The booker view of the booking inside a verify or reconcile answer (`forRequester`). */
export interface CardPaymentAnswer {
  context?: string;
  paymentRecord?: { status?: string; isProcessed?: boolean };
  entity?: Partial<BookedConsultation> | null;
}
/** `POST /payments/reconcile`: `paid` (as verify) or `unpaid` (Razorpay holds no capture for the order). */
export type ReconcileAnswer = ({ state: 'paid' } & CardPaymentAnswer) | { state: 'unpaid'; gatewayStatuses?: string[] };

export interface CardProof { paymentTransactionId: string; razorpayOrderId: string; razorpayPaymentId: string; razorpaySignature: string }

export function bookingPaymentApi(c: ApiClient) {
  return {
    /** The browser's proof. S6: no `module`; what was paid for comes from the stored record (context `assisted_booking`). */
    verify: (p: CardProof) => c.post<CardPaymentAnswer>('/payments/verify', {
      body: { paymentTransactionId: idOf(p.paymentTransactionId), razorpayOrderId: p.razorpayOrderId, razorpayPaymentId: p.razorpayPaymentId,
        razorpaySignature: p.razorpaySignature },
    }),
    /** The server asks Razorpay about the record's own order and applies a capture exactly once. */
    reconcile: (paymentTransactionId: string) =>
      c.post<ReconcileAnswer>('/payments/reconcile', { body: { paymentTransactionId: idOf(paymentTransactionId) } }),
  };
}

/**
 * What the screen may say after a payment step, from the server's answer only:
 * - `paid`: the record is paid (the booking is confirmed in the same transaction);
 * - `refunded`: the capture could not be used (expired, cancelled, doctor not available) and goes back to the card;
 * - `unpaid`: Razorpay holds no capture for the order (yet);
 * - `failed`: the record is marked failed: this order can no longer pay the booking;
 * - `blocked`: 403, the pharmacy is not operational, so it cannot check the payment here;
 * - `unknown`: no usable answer; the payment may have gone through.
 */
export type CardOutcome =
  | { kind: 'paid'; booking: Partial<BookedConsultation> | null }
  | { kind: 'refunded' }
  /**
   * WQ16c: `inFlight` = Razorpay reported a payment that is not captured yet (Checkout said paid, verify said not
   * completed, or the order has an authorized / created payment): never invite a second payment then.
   */
  | { kind: 'unpaid'; inFlight?: true }
  /** WQ16d (r10e): this payment was another one on a booking already paid: it is being refunded (final, never paid). */
  | { kind: 'duplicate'; message: string }
  | { kind: 'failed'; message: string }
  | { kind: 'blocked'; message: string }
  | { kind: 'unknown'; message: string };

/** A verify answer, or a reconcile answer that found the capture. `null` = the answer does not settle anything. */
export function outcomeOfAnswer(a: CardPaymentAnswer | ReconcileAnswer | null | undefined): CardOutcome | null {
  if (!a || typeof a !== 'object') return null;
  if ('state' in a && a.state === 'unpaid') {
    return (a.gatewayStatuses ?? []).some((s) => s === 'authorized' || s === 'created') ? { kind: 'unpaid', inFlight: true } : { kind: 'unpaid' };
  }
  const r = a as CardPaymentAnswer;
  const status = r.paymentRecord?.status;
  if (status === 'paid') return { kind: 'paid', booking: r.entity ?? null };
  if (status === 'refunded') return { kind: 'refunded' };
  return null;
}

export let CARD_BLOCKED_WORDS = '';
export let DUPLICATE_WORDS = '';
onLanguage(() => {
  CARD_BLOCKED_WORDS = t('card.blocked');
  DUPLICATE_WORDS = t('card.duplicate');
});

/** A refusal of verify or reconcile, read for what it settles (`null`: nothing; try the next step or check again). */
export function outcomeOfError(err: unknown): CardOutcome | null {
  if (!(err instanceof ApiError)) return null;
  if (err.code === 'PAYMENT_REFUNDED') return { kind: 'refunded' };
  if (err.code === 'PAYMENT_FAILED') return { kind: 'failed', message: t('card.failed') };
  if (err.code === 'DUPLICATE_PAYMENT_REFUNDED') return { kind: 'duplicate', message: DUPLICATE_WORDS };
  // r10b: a card dispute recorded on this payment: said as it is (never paid, never "not booked").
  if (err.code === 'PAYMENT_DISPUTED') return { kind: 'blocked', message: t('card.disputed') };
  if (err.status === 403) return { kind: 'blocked', message: CARD_BLOCKED_WORDS };
  return null;
}

/** Plain words for a verify or reconcile refusal that settles nothing (shown with "Check payment"). */
export function cardCheckProblem(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'PAYMENT_CHANGED') return t('card.changed');
    if (err.code === 'RAZORPAY_PAYMENT_FETCH_FAILED' || err.status >= 500 || err.status === 0) return t('card.razorpayDown');
    if (err.code === 'PAYMENT_RECORD_NOT_FOUND') return t('card.notFound');
  }
  return assistedRefusal(err).message;
}

/**
 * Settles one payment attempt with the server: the proof first (when Checkout gave one), then the server's own check.
 * Never throws. `proof` is null when Checkout was closed without paying (it may still have been paid just before).
 */
export async function settleCardPayment(api: ApiClient, paymentTransactionId: string, proof: Omit<CardProof, 'paymentTransactionId'> | null): Promise<CardOutcome> {
  const pay = bookingPaymentApi(api);
  if (proof) {
    try {
      const settled = outcomeOfAnswer(await pay.verify({ paymentTransactionId, ...proof }));
      if (settled) return settled;
    } catch (err) {
      const settled = outcomeOfError(err);
      if (settled) return settled;
      // Anything else (a bad signature, a lost answer, Razorpay not answering): the server's own check decides.
    }
  }
  const checked = await checkCardPayment(api, paymentTransactionId);
  // WQ16c: Checkout reported a payment: "not captured yet" is a payment on its way, never an invitation to pay again.
  return proof && checked.kind === 'unpaid' ? { kind: 'unpaid', inFlight: true } : checked;
}

/**
 * card-last: asked before Checkout is opened again on a held order. An `authorized` payment at Razorpay is on its way, so
 * Checkout is not opened (`settled`, in flight); a `created` (unfinished) attempt still opens it, with `created` set so the
 * screen keeps its warning. A paid, refunded or refused answer settles it; no usable answer is unknown. Never throws.
 */
export async function beforeCheckout(api: ApiClient, paymentTransactionId: string): Promise<{ kind: 'open'; created: boolean } | { kind: 'settled'; outcome: CardOutcome }> {
  try {
    const a = await bookingPaymentApi(api).reconcile(paymentTransactionId);
    if (a && a.state === 'unpaid') {
      const s = a.gatewayStatuses ?? [];
      return s.includes('authorized') ? { kind: 'settled', outcome: { kind: 'unpaid', inFlight: true } } : { kind: 'open', created: s.includes('created') };
    }
    return { kind: 'settled', outcome: outcomeOfAnswer(a) ?? { kind: 'unknown', message: t('card.unreadable') } };
  } catch (err) {
    return { kind: 'settled', outcome: outcomeOfError(err) ?? { kind: 'unknown', message: cardCheckProblem(err) } };
  }
}

/** `POST /payments/reconcile` for one card booking payment. Never throws. */
export async function checkCardPayment(api: ApiClient, paymentTransactionId: string): Promise<CardOutcome> {
  try {
    return outcomeOfAnswer(await bookingPaymentApi(api).reconcile(paymentTransactionId)) ?? { kind: 'unknown', message: t('card.unreadable') };
  } catch (err) {
    return outcomeOfError(err) ?? { kind: 'unknown', message: cardCheckProblem(err) };
  }
}

/** "Pay before 14:35 or the time is released." (India time, 24-hour like the slot times). */
export function payByWords(payBy: string | undefined | null): string {
  const time = payByClock(payBy);
  return time ? t('card.payBy', { time }) : t('card.payWithin');
}
export function payByClock(payBy: string | undefined | null): string | null {
  const d = payBy ? new Date(payBy) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return formatClock(d);
}

/**
 * WQ16c: whether the money was taken, from the server's `payment.state` (captured, refunded or forfeited); an older
 * server without the field: every booking not waiting was paid (as before).
 */
export function bookingWasPaid(b: Pick<BookedConsultation, 'status' | 'paymentStatus' | 'payment'>): boolean {
  if (!b.payment) return !(b.status === 'pending' && b.paymentStatus === 'pending');
  return ['captured', 'refunded', 'forfeited'].includes(b.payment.state);
}
/**
 * WQ16c (r10d): the open order of a waiting card booking from its booker view, for Checkout on any device; null when none.
 * WQ17c: any booking kind; the amount only when the view carries the price (a lab view does not).
 */
export function orderFromBooking(b: { payment?: BookingPayment; price?: number }): OpenCardOrder | null {
  const p = b.payment;
  if (!p || p.method !== 'razorpay' || p.state !== 'pending' || !p.razorpayOrderId || !p.razorpayKeyId || !p.paymentTransactionId) return null;
  return { paymentRequired: true, paymentTransactionId: p.paymentTransactionId, razorpayOrderId: p.razorpayOrderId, razorpayKeyId: p.razorpayKeyId,
    ...(typeof b.price === 'number' ? { amount: b.price, amountMinor: Math.round(b.price * 100) } : {}), currency: 'INR', payBy: p.payBy ?? '' };
}

/**
 * WQ17c: where a card booking stands, by kind: a consultation waits as `pending`/`pending` and is paid once `confirmed`/`paid`;
 * a lab booking waits as `pending_payment` and is paid once it moved on (any status but `pending_payment` and `cancelled`).
 */
export type CardBookingKind = 'consultation' | 'lab';
export function cardBookingState(kind: CardBookingKind, b: { status?: string; paymentStatus?: string }): 'waiting' | 'paid' | 'ended' {
  if (kind === 'lab') return b.status === 'pending_payment' ? 'waiting' : b.status && b.status !== 'cancelled' ? 'paid' : 'ended';
  if (b.status === 'pending' && b.paymentStatus === 'pending') return 'waiting';
  return b.status === 'confirmed' && b.paymentStatus === 'paid' ? 'paid' : 'ended';
}
/** A by-key answer of a card booking carries `payment` (r10/r14); a booker view says how it was paid (r10c). */
export const isCardAnswer = (r: { booking?: { payment?: { method?: string } } }) => 'payment' in r || r.booking?.payment?.method === 'razorpay';
export let HELD_NOT_STARTED = '';
onLanguage(() => { HELD_NOT_STARTED = t('card.heldNotStarted'); });

/**
 * WQ21 L1: what a create's answer, or a by-key `used` answer (`byKey`), means for the booking screen — the same for a
 * consultation and a lab test: a wallet booking is done; a card booking is paid, waits for its payment, or can no longer be
 * paid. A waiting card booking found by key without its order (502 at create) needs the same request again: the sentence
 * is answered and nothing is settled (unless only the key is left after a reload).
 */
export function routeCardAnswer<O>(kind: CardBookingKind, a: { card: boolean; booking: { status?: string; paymentStatus?: string }; order: O | null },
  byKey: { restored: boolean } | null, on: { settle?: () => void; done: (card: boolean) => void; due: (order: O | null) => void; ended: () => void }): string | null {
  if (!a.card) { on.settle?.(); on.done(false); return null; }
  const state = cardBookingState(kind, a.booking);
  if (byKey && state === 'waiting' && !a.order && !byKey.restored) return HELD_NOT_STARTED;
  on.settle?.();
  if (state === 'paid') on.done(true);
  else if (state === 'waiting') on.due(a.order);
  else on.ended();
  return null;
}

/** WQ16c: "Pay now" stops 2 minutes before the pay-by time (the page could not finish in time); only "Check payment" then. */
export const PAY_NOW_MARGIN_MS = 2 * 60_000;
export function payNowOpen(payBy: string | undefined | null, now = Date.now()): boolean {
  const t = payBy ? Date.parse(payBy) : NaN;
  return !Number.isFinite(t) || now < t - PAY_NOW_MARGIN_MS;
}
/** Seconds Checkout may stay open so that it closes itself before the cut-off (Razorpay's `timeout` option). */
export function checkoutSeconds(payBy: string | undefined | null, now = Date.now()): number | undefined {
  const t = payBy ? Date.parse(payBy) : NaN;
  // card-last: at least about a minute, so a page opened close to the cut-off is not closed at once.
  return Number.isFinite(t) ? Math.max(60, Math.floor((t - PAY_NOW_MARGIN_MS - now) / 1000)) : undefined;
}

/**
 * An assisted booking waiting for its card payment. r10c: the booker view's `payment` says so; an older server has no
 * field, and there a pending booking is a card one (a wallet booking is paid at create).
 */
export const awaitingCardPayment = (b: Pick<BookedConsultation, 'status' | 'paymentStatus' | 'payment'>) => b.status === 'pending' && b.paymentStatus === 'pending'
  && (!b.payment || (b.payment.method === 'razorpay' && b.payment.state === 'pending'));
/** r10c: how the booking was paid, from the booker view (`unknown` on an older server). */
export const bookingPaidBy = (b: Pick<BookedConsultation, 'payment'>): 'card' | 'wallet' | 'unknown' =>
  b.payment?.method === 'razorpay' ? 'card' : b.payment?.method === 'wallet' ? 'wallet' : 'unknown';
/** When a waiting card booking is released: the server's `payBy`; on an older server its creation + 30 minutes (the server's rule). */
export function bookingPayBy(b: Pick<BookedConsultation, 'payment' | 'createdAt'>): string | undefined {
  if (b.payment) return b.payment.payBy ?? undefined;
  const t = b.createdAt ? Date.parse(b.createdAt) : NaN;
  return Number.isFinite(t) ? new Date(t + 30 * 60_000).toISOString() : undefined;
}

/** WQ16c: said whenever a card booking is cancelled (or released) before it was paid. */
export let LATE_PAYMENT_BACK = '';
export let LATE_CAPTURE_WORDS = '';
onLanguage(() => {
  LATE_PAYMENT_BACK = t('card.lateBack');
  LATE_CAPTURE_WORDS = t('card.lateCapture');
});


/** The refund of a card-paid booking in plain words, from the server's state only (only `processed` is done). */
export function cardRefundWords(r: CardRefund): string {
  const amount = rupees(r.amountMinor);
  if (r.method === 'wallet') {
    return t(r.state === 'processed' ? 'refund.walletDone' : 'refund.walletPending', { amount });
  }
  switch (r.state) {
    case 'processed': return t('refund.processed', { amount });
    case 'pending': return t('refund.pending', { amount });
    case 'failed': return t('refund.failed', { amount });
    case 'manual_review': return t('refund.manual_review', { amount });
    default: return t('refund.other', { amount, state: r.state });
  }
}

/** What a cancellation did with the money (WQ12 words for a wallet booking; the `refund` for a card booking). */
/** `told`: who hears of it (WQ17c: a lab test tells the patient only). */
export function cancelWords(a: Pick<CancelAnswer, 'refundedMinor' | 'alreadyCancelled' | 'refund'> & { booking?: unknown }, told = t('cancel.told')): string {
  if (a.alreadyCancelled) return t('cancel.already');
  // r10: `refund` is present only for a card booking (null: cancelled before it was paid).
  if (!('refund' in a)) return t('cancel.wallet', { amount: rupees(a.refundedMinor), told });
  if (!a.refund) return t('cancel.unpaid', { later: LATE_PAYMENT_BACK });
  return t('cancel.card', { refund: cardRefundWords(a.refund), told });
}

// ── Admin: card refunds of assisted bookings that need a person (r10 `cardRefunds.ts`, §23.3 "Admin") ──

export const CARD_REFUND_STATES = ['pending', 'processed', 'failed', 'manual_review'] as const;
export type CardRefundState = (typeof CARD_REFUND_STATES)[number];
export const CARD_REFUND_STATE_LABEL: Readonly<Record<string, string>> = wordMap(t, {
  pending: 'refundState.pending', processed: 'refundState.processed', failed: 'refundState.failed', manual_review: 'refundState.manual_review',
});
export const CARD_REFUND_CAUSE_LABEL: Readonly<Record<string, string>> = wordMap(t, {
  booker: 'refundCause.booker', patient: 'refundCause.patient', doctor: 'refundCause.doctor', admin: 'refundCause.admin',
  late_capture: 'refundCause.late_capture',
  extra_capture: 'refundCause.extra_capture',
});
/** `cardRefundToWalletSchema.agreement`: 1–500 characters after trimming. */
export const MAX_REFUND_AGREEMENT = 500;
const clean = (s: string) => s.trim().replace(/\s+/g, ' ');

export function agreementProblem(text: string): string | undefined {
  const a = clean(text);
  if (!a) return t('agreement.empty');
  if (a.length > MAX_REFUND_AGREEMENT) return t('field.tooLong', { max: MAX_REFUND_AGREEMENT });
  return undefined;
}

/** The rows of the queue answer that can be shown (anything malformed is dropped). */
export function cardRefundRowsOf(data: unknown): CardRefund[] {
  if (!Array.isArray(data)) return [];
  return data.filter((r): r is CardRefund => !!r && typeof r === 'object' && hex.test(String((r as CardRefund).refundId))
    && Number.isSafeInteger((r as CardRefund).amountMinor) && typeof (r as CardRefund).state === 'string');
}

export interface CardRefundMove { refund: CardRefund; replayed: boolean }
/** r10c: admin rows name the paying pharmacy. */
export type AdminCardRefund = CardRefund & { pharmacyId?: string | null; pharmacyName?: string | null };
/** r10b `recheckCardRefund`: the row after asking Razorpay, and every refund Razorpay holds for the payment. */
export interface CardRefundRecheck { refund: AdminCardRefund; gateway: { id: string; status: string; amountMinor: number; ours: boolean }[] }

export function adminCardRefundsApi(c: ApiClient) {
  return {
    /**
     * `GET /admin/assisted/card-refunds?state&limit` (1–200, default 50): with no state, the rows that need a person
     * (failed, held for a check, and pending ones over 20 attempts or older than 24 h), oldest change first.
     */
    queue: async (q: { state?: CardRefundState; limit?: number } = {}): Promise<AdminCardRefund[]> =>
      cardRefundRowsOf(await c.get<unknown>('/admin/assisted/card-refunds', { query: { ...(q.state ? { state: q.state } : {}), ...(q.limit ? { limit: q.limit } : {}) } })),
    /**
     * `POST /admin/assisted/card-refunds/:id/to-wallet { agreement }` (admin tools switch): a failed or held card refund
     * credited to the pharmacy's wallet instead, once (a repeat answers `replayed`). Only an answer showing the refund
     * processed to the wallet counts; anything else is a 502, so the request stays unknown.
     */
    toWallet: async (refundId: string, agreement: string): Promise<CardRefundMove> => {
      if (!hex.test(refundId)) throw new Error('Invalid refund id'); // i18n-ignore: a programming error, not shown
      const a = clean(agreement);
      if (agreementProblem(a)) throw new Error('Invalid agreement'); // i18n-ignore: a programming error, not shown
      const r = await c.post<Partial<CardRefundMove> | null>(`/admin/assisted/card-refunds/${refundId.toLowerCase()}/to-wallet`, { body: { agreement: a } });
      if (!r?.refund || r.refund.method !== 'wallet' || r.refund.state !== 'processed') throw new ApiError(502, t('refund.unreadable'));
      return { refund: r.refund, replayed: r.replayed === true };
    },
    /** r10b `POST …/:id/recheck`: asks Razorpay now (a pending row may be sent or settled); moves no wallet money. */
    recheck: async (refundId: string): Promise<CardRefundRecheck> => {
      if (!hex.test(refundId)) throw new Error('Invalid refund id'); // i18n-ignore: a programming error, not shown
      const r = await c.post<Partial<CardRefundRecheck> | null>(`/admin/assisted/card-refunds/${refundId.toLowerCase()}/recheck`);
      if (!r?.refund || !Array.isArray(r.gateway)) throw new ApiError(502, t('refund.unreadable'));
      return { refund: r.refund, gateway: r.gateway };
    },
    /**
     * r10b `POST …/:id/mark-failed { reason }` (admin tools switch): a pending card refund marked failed after Razorpay was
     * read (then it may be moved to the wallet). Only an answer showing it failed counts; anything else is a 502.
     */
    markFailed: async (refundId: string, reason: string): Promise<{ refund: AdminCardRefund }> => {
      if (!hex.test(refundId)) throw new Error('Invalid refund id'); // i18n-ignore: a programming error, not shown
      const why = clean(reason);
      if (!why || why.length > MAX_REFUND_AGREEMENT) throw new Error('Invalid reason'); // i18n-ignore: a programming error, not shown
      const r = await c.post<{ refund?: AdminCardRefund } | null>(`/admin/assisted/card-refunds/${refundId.toLowerCase()}/mark-failed`, { body: { reason: why } });
      if (!r?.refund || r.refund.state !== 'failed') throw new ApiError(502, t('refund.unreadable'));
      return { refund: r.refund };
    },
  };
}

/** The words for a recheck answer: the row's state and what Razorpay holds. */
export function recheckWords(r: CardRefundRecheck): string {
  const state = CARD_REFUND_STATE_LABEL[r.refund.state] ?? r.refund.state;
  const held = r.gateway.length === 0 ? t('recheck.none')
    : t('recheck.held', { count: r.gateway.length, statuses: r.gateway.map((g) => g.status).join(', ') });
  return t('recheck.words', { state, held });
}

/**
 * WQ16c/d: one refund row as it is now: `GET /admin/assisted/card-refunds/:id` (r10e `cardRefundById`: the queue row, with
 * the pharmacy, as `data`; 404 REFUND_NOT_FOUND). Never the list (cut at 200 rows), and never recheck (it can send the
 * refund): on an older server without the route the outcome stays unknown.
 */
export async function readCardRefund(api: ApiClient, refundId: string): Promise<AdminCardRefund> {
  if (!hex.test(refundId)) throw new Error('Invalid refund id'); // i18n-ignore: a programming error, not shown
  try {
    const r = await api.get<AdminCardRefund | null>(`/admin/assisted/card-refunds/${refundId.toLowerCase()}`);
    if (!r || !hex.test(String(r.refundId)) || typeof r.state !== 'string') throw new ApiError(502, t('refund.unreadable'));
    return r;
  } catch (err) {
    if (err instanceof ApiError && ((err.status === 404 && !err.code) || err.status === 405)) {
      throw new ApiError(err.status, t('refund.routeMissing'), 'ROUTE_NOT_AVAILABLE');
    }
    throw err;
  }
}

/** Marked failed already? Read by id: failed, marked by an admin. */
export async function findMarkedFailed(api: ApiClient, refundId: string): Promise<CardRefund | null> {
  const r = await readCardRefund(api, refundId);
  // card-last: whatever its state now (a row marked failed may since have been moved to the wallet).
  return r.lastError === 'MARKED_FAILED_BY_ADMIN' ? r : null;
}

/** Moved to the wallet already? Read by id (WQ16c: not the list, which is cut at 200 rows). */
export async function findMovedRefund(api: ApiClient, refundId: string): Promise<CardRefund | null> {
  const r = await readCardRefund(api, refundId);
  return r.method === 'wallet' && r.state === 'processed' ? r : null;
}

/** A refusal code → the key of its words (`{max}`: the longest text allowed). */
const MOVE_WORDS: Readonly<Record<string, AssistedKey>> = {
  REFUND_NOT_FAILED: 'move.REFUND_NOT_FAILED',
  CHARGEBACK_RECORDED: 'move.CHARGEBACK_RECORDED',
  REFUND_NOT_FOUND: 'refund.notFound',
  REFUND_CHANGED: 'move.REFUND_CHANGED',
  REFUND_AT_GATEWAY: 'move.REFUND_AT_GATEWAY',
  GATEWAY_LOOKUP_FAILED: 'move.GATEWAY_LOOKUP_FAILED',
  VALIDATION_ERROR: 'move.VALIDATION_ERROR',
};
const wordsFor = (map: Readonly<Record<string, AssistedKey>>, err: unknown): string | null =>
  err instanceof ApiError && err.code && Object.hasOwn(map, err.code) ? t(map[err.code]!, { max: MAX_REFUND_AGREEMENT }) : null;

/** "Move to wallet" and "Mark failed" share these; `forbidden` is the 403 sentence of each. */
function refundRefusal(err: unknown, forbidden: 'move.forbidden' | 'mark.forbidden'): string {
  const known = wordsFor(MOVE_WORDS, err);
  if (known) return known;
  if (err instanceof ApiError && err.status === 404 && !err.code) return t('move.routeMissing');
  if (err instanceof ApiError && (err.code === 'ASSISTED_BOOKING_DISABLED' || (err.status === 503 && !err.code))) {
    return t('move.switchedOff');
  }
  if (err instanceof ApiError && err.status === 403) return t(forbidden);
  return assistedRefusal(err).message;
}

/** One plain sentence for a refusal of "Move to wallet". */
export function moveRefundRefusal(err: unknown): string {
  return refundRefusal(err, 'move.forbidden');
}

/** Refused before any write (`assertAdminToolsOn` is the first line): for a sole first attempt nothing was moved. */
// r10b: Razorpay is asked before the transaction (502 GATEWAY_LOOKUP_FAILED): nothing written by that attempt.
export const moveRefusedBeforeWriting = (err: unknown) => err instanceof ApiError
  && ((err.status === 503 && err.code === 'ASSISTED_BOOKING_DISABLED') || (err.status === 502 && err.code === 'GATEWAY_LOOKUP_FAILED'));
/**
 * Answers that settle the move on ANY attempt: an earlier attempt that did move it would be answered `replayed` (checked
 * first), so these mean it was not, and cannot be, moved.
 */
export const moveRefundFinal = (err: unknown) => err instanceof ApiError && ((err.status === 409 && ['REFUND_NOT_FAILED', 'CHARGEBACK_RECORDED', 'REFUND_AT_GATEWAY'].includes(err.code ?? ''))
  || (err.status === 404 && err.code === 'REFUND_NOT_FOUND'));

const MARK_WORDS: Readonly<Record<string, AssistedKey>> = {
  REFUND_AT_GATEWAY: 'mark.REFUND_AT_GATEWAY',
  REFUND_BUSY: 'mark.REFUND_BUSY',
  REFUND_NOT_PENDING: 'mark.REFUND_NOT_PENDING',
  GATEWAY_LOOKUP_FAILED: 'mark.GATEWAY_LOOKUP_FAILED',
  REFUND_NOT_FOUND: 'refund.notFound',
  VALIDATION_ERROR: 'mark.VALIDATION_ERROR',
};
/** One plain sentence for a refusal of "Mark failed" or "Recheck". */
export function markFailedRefusal(err: unknown): string {
  return wordsFor(MARK_WORDS, err) ?? refundRefusal(err, 'mark.forbidden');
}
/** Refused before any change (switch, Razorpay not answering: the row is freed): for a sole first attempt nothing was marked. */
export const markFailedRefusedBeforeWriting = (err: unknown) => err instanceof ApiError
  && ((err.status === 503 && err.code === 'ASSISTED_BOOKING_DISABLED') || (err.status === 502 && err.code === 'GATEWAY_LOOKUP_FAILED'));
/**
 * Settles mark-failed on ANY attempt: a live refund at Razorpay, or no such refund. Not REFUND_NOT_PENDING: an earlier
 * attempt that did mark it is answered that way.
 */
export const markFailedFinal = (err: unknown) => err instanceof ApiError
  && ((err.status === 409 && err.code === 'REFUND_AT_GATEWAY') || (err.status === 404 && err.code === 'REFUND_NOT_FOUND'));

/** WQ16c: a refusal of "Recheck". A 5xx (Razorpay not answering included) may come after the refund was sent: not known. */
export function recheckRefusal(err: unknown): string {
  if (err instanceof ApiError && (err.status >= 500 || err.status === 0) && err.status !== 503) {
    return t('recheck.razorpayDown');
  }
  if (err instanceof ApiError && err.code === 'REFUND_BUSY') return t('recheck.busy');
  return markFailedRefusal(err);
}
