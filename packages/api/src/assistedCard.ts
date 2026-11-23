import { ApiError, type ApiClient } from './client.ts';
import { assistedRefusal, type BookedConsultation, type CancelAnswer, type CardRefund } from './assisted.ts';

/**
 * WQ16: assisted booking phase 1b, a pharmacy pays a walk-in consultation by card or UPI (backend r10
 * `m0/r10-phase1b` 9f2a1807, design ASSISTED_BOOKING_DESIGN.md §23.3). The booking is created with
 * `paymentMethod: 'razorpay'` (held as pending payment with ONE Razorpay order), Checkout takes the payment, the browser's
 * proof goes to `POST /payments/verify` (no `module`, S6), and the server's own check `POST /payments/reconcile` is the
 * fallback. Only the server's `paymentRecord.status` says paid or refunded; nothing here claims either on its own.
 */

const hex = /^[0-9a-fA-F]{24}$/;
const idOf = (v: string) => { if (!hex.test(v)) throw new Error('Invalid payment id'); return v; };

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
  | { kind: 'unpaid' }
  | { kind: 'failed'; message: string }
  | { kind: 'blocked'; message: string }
  | { kind: 'unknown'; message: string };

/** A verify answer, or a reconcile answer that found the capture. `null` = the answer does not settle anything. */
export function outcomeOfAnswer(a: CardPaymentAnswer | ReconcileAnswer | null | undefined): CardOutcome | null {
  if (!a || typeof a !== 'object') return null;
  if ('state' in a && a.state === 'unpaid') return { kind: 'unpaid' };
  const r = a as CardPaymentAnswer;
  const status = r.paymentRecord?.status;
  if (status === 'paid') return { kind: 'paid', booking: r.entity ?? null };
  if (status === 'refunded') return { kind: 'refunded' };
  return null;
}

export const CARD_BLOCKED_WORDS =
  'Your pharmacy account is not active or not verified, so the payment cannot be checked here. If you paid, Jansetu checks it with Razorpay: the booking is confirmed, or the money goes back to the card or UPI.';
const CARD_FAILED_WORDS = 'This payment failed, so the booking is not paid. If the time is released, book again.';

/** A refusal of verify or reconcile, read for what it settles (`null`: nothing; try the next step or check again). */
export function outcomeOfError(err: unknown): CardOutcome | null {
  if (!(err instanceof ApiError)) return null;
  if (err.code === 'PAYMENT_REFUNDED') return { kind: 'refunded' };
  if (err.code === 'PAYMENT_FAILED') return { kind: 'failed', message: CARD_FAILED_WORDS };
  // r10b: a card dispute recorded on this payment: said as it is (never paid, never "not booked").
  if (err.code === 'PAYMENT_DISPUTED') return { kind: 'blocked', message: 'A card dispute was recorded on this booking payment. Please contact Jansetu support.' };
  if (err.status === 403) return { kind: 'blocked', message: CARD_BLOCKED_WORDS };
  return null;
}

/** Plain words for a verify or reconcile refusal that settles nothing (shown with "Check payment"). */
export function cardCheckProblem(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'PAYMENT_CHANGED') return 'The payment changed while it was checked. Check again.';
    if (err.code === 'RAZORPAY_PAYMENT_FETCH_FAILED' || err.status >= 500 || err.status === 0) return 'Razorpay could not be asked just now. Check again in a minute.';
    if (err.code === 'PAYMENT_RECORD_NOT_FOUND') return 'This payment was not found for your pharmacy.';
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
  return checkCardPayment(api, paymentTransactionId);
}

/** `POST /payments/reconcile` for one card booking payment. Never throws. */
export async function checkCardPayment(api: ApiClient, paymentTransactionId: string): Promise<CardOutcome> {
  try {
    return outcomeOfAnswer(await bookingPaymentApi(api).reconcile(paymentTransactionId)) ?? { kind: 'unknown', message: 'The answer about this payment could not be read.' };
  } catch (err) {
    return outcomeOfError(err) ?? { kind: 'unknown', message: cardCheckProblem(err) };
  }
}

/** "Pay before 14:35 or the time is released." (India time, 24-hour like the slot times). */
export function payByWords(payBy: string | undefined | null): string {
  const t = payByClock(payBy);
  return t ? `Pay before ${t} or the time is released.` : 'Pay within 30 minutes of booking or the time is released.';
}
export function payByClock(payBy: string | undefined | null): string | null {
  const d = payBy ? new Date(payBy) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Kolkata' }).format(d);
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

export const LATE_CAPTURE_WORDS =
  'The payment came after the booking could no longer take it (the time was released, it was cancelled, or the doctor is not available). The amount is being refunded to the card or UPI it was paid with. Nothing is booked: book again if the patient still wants it.';

const rupees = (paise: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(paise / 100);

/** The refund of a card-paid booking in plain words, from the server's state only (only `processed` is done). */
export function cardRefundWords(r: CardRefund): string {
  const amount = rupees(r.amountMinor);
  if (r.method === 'wallet') {
    return r.state === 'processed'
      ? `${amount} is back in your Jansetu wallet. This money pays for bookings; it cannot be withdrawn.`
      : `${amount} is being returned to your Jansetu wallet.`;
  }
  switch (r.state) {
    case 'processed': return `${amount} was refunded to the card or UPI it was paid with.`;
    case 'pending': return `Refund of ${amount} to the card or UPI: in progress. It usually reaches the card in 5 to 7 working days.`;
    case 'failed': return `The refund of ${amount} to the card or UPI did not go through. Jansetu will contact you to return it another way.`;
    case 'manual_review': return `The refund of ${amount} is held for a check by Jansetu. Jansetu will contact you.`;
    default: return `Refund of ${amount}: ${r.state}.`;
  }
}

/** What a cancellation did with the money (WQ12 words for a wallet booking; the `refund` for a card booking). */
export function cancelWords(a: CancelAnswer): string {
  if (a.alreadyCancelled) return 'It was already cancelled. Nothing was refunded twice.';
  // r10: `refund` is present only for a card booking (null: cancelled before it was paid).
  if (!('refund' in a)) return `Cancelled. ${rupees(a.refundedMinor)} is back in your Jansetu wallet. The patient and the doctor are told.`;
  if (!a.refund) return 'Cancelled. It was not paid, so nothing is refunded.';
  return `Cancelled. ${cardRefundWords(a.refund)} The patient and the doctor are told.`;
}

// ── Admin: card refunds of assisted bookings that need a person (r10 `cardRefunds.ts`, §23.3 "Admin") ──

export const CARD_REFUND_STATES = ['pending', 'processed', 'failed', 'manual_review'] as const;
export type CardRefundState = (typeof CARD_REFUND_STATES)[number];
export const CARD_REFUND_STATE_LABEL: Readonly<Record<string, string>> = {
  pending: 'Refund to card in progress', processed: 'Refunded', failed: 'Refund to card failed', manual_review: 'Held for a check',
};
export const CARD_REFUND_CAUSE_LABEL: Readonly<Record<string, string>> = {
  booker: 'Cancelled by the pharmacy', patient: 'Cancelled by the patient', doctor: 'Cancelled by the doctor', admin: 'Cancelled by Jansetu',
  late_capture: 'Paid after the booking was released',
};
/** `cardRefundToWalletSchema.agreement`: 1–500 characters after trimming. */
export const MAX_REFUND_AGREEMENT = 500;
const clean = (s: string) => s.trim().replace(/\s+/g, ' ');

export function agreementProblem(text: string): string | undefined {
  const a = clean(text);
  if (!a) return 'Write what the pharmacy agreed to, and how (for example “Agreed on a call with the owner on 23 Nov”).';
  if (a.length > MAX_REFUND_AGREEMENT) return `Use at most ${MAX_REFUND_AGREEMENT} characters.`;
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
      if (!hex.test(refundId)) throw new Error('Invalid refund id');
      const a = clean(agreement);
      if (agreementProblem(a)) throw new Error('Invalid agreement');
      const r = await c.post<Partial<CardRefundMove> | null>(`/admin/assisted/card-refunds/${refundId.toLowerCase()}/to-wallet`, { body: { agreement: a } });
      if (!r?.refund || r.refund.method !== 'wallet' || r.refund.state !== 'processed') throw new ApiError(502, 'The answer about this refund could not be read.');
      return { refund: r.refund, replayed: r.replayed === true };
    },
    /** r10b `POST …/:id/recheck`: asks Razorpay now (a pending row may be sent or settled); moves no wallet money. */
    recheck: async (refundId: string): Promise<CardRefundRecheck> => {
      if (!hex.test(refundId)) throw new Error('Invalid refund id');
      const r = await c.post<Partial<CardRefundRecheck> | null>(`/admin/assisted/card-refunds/${refundId.toLowerCase()}/recheck`);
      if (!r?.refund || !Array.isArray(r.gateway)) throw new ApiError(502, 'The answer about this refund could not be read.');
      return { refund: r.refund, gateway: r.gateway };
    },
    /**
     * r10b `POST …/:id/mark-failed { reason }` (admin tools switch): a pending card refund marked failed after Razorpay was
     * read (then it may be moved to the wallet). Only an answer showing it failed counts; anything else is a 502.
     */
    markFailed: async (refundId: string, reason: string): Promise<{ refund: AdminCardRefund }> => {
      if (!hex.test(refundId)) throw new Error('Invalid refund id');
      const why = clean(reason);
      if (!why || why.length > MAX_REFUND_AGREEMENT) throw new Error('Invalid reason');
      const r = await c.post<{ refund?: AdminCardRefund } | null>(`/admin/assisted/card-refunds/${refundId.toLowerCase()}/mark-failed`, { body: { reason: why } });
      if (!r?.refund || r.refund.state !== 'failed') throw new ApiError(502, 'The answer about this refund could not be read.');
      return { refund: r.refund };
    },
  };
}

/** The words for a recheck answer: the row's state and what Razorpay holds. */
export function recheckWords(r: CardRefundRecheck): string {
  const state = CARD_REFUND_STATE_LABEL[r.refund.state] ?? r.refund.state;
  const held = r.gateway.length === 0 ? 'Razorpay holds no refund of this payment yet.'
    : `Razorpay holds ${r.gateway.length} refund${r.gateway.length === 1 ? '' : 's'} of this payment (${r.gateway.map((g) => g.status).join(', ')}).`;
  return `Checked with Razorpay: ${state}. ${held}`;
}

/** Marked failed already? The row among the failed ones, marked by an admin (at most 200, oldest change first). */
export async function findMarkedFailed(api: ApiClient, refundId: string): Promise<CardRefund | null> {
  const rows = await adminCardRefundsApi(api).queue({ state: 'failed', limit: 200 });
  return rows.find((r) => r.refundId.toLowerCase() === refundId.toLowerCase() && r.lastError === 'MARKED_FAILED_BY_ADMIN') ?? null;
}

/** Moved to the wallet already? Looks for the row among the processed ones (at most 200, oldest change first). */
export async function findMovedRefund(api: ApiClient, refundId: string): Promise<CardRefund | null> {
  const rows = await adminCardRefundsApi(api).queue({ state: 'processed', limit: 200 });
  return rows.find((r) => r.refundId.toLowerCase() === refundId.toLowerCase() && r.method === 'wallet' && r.state === 'processed') ?? null;
}

const MOVE_WORDS: Readonly<Record<string, string>> = {
  REFUND_NOT_FAILED: 'Only a refund that failed or is held for a check can be moved to the wallet. Nothing was changed. Read the list again.',
  CHARGEBACK_RECORDED: 'A card dispute was recorded on this payment: the bank already took the money back. Nothing was moved.',
  REFUND_NOT_FOUND: 'This refund was not found. Nothing was changed.',
  REFUND_CHANGED: 'This refund changed while it was being moved. Read the list again, then try again.',
  REFUND_AT_GATEWAY: 'Razorpay already has a refund of this payment, done or on its way, so nothing was moved. Tap “Recheck” to see it.',
  GATEWAY_LOOKUP_FAILED: 'Razorpay could not be asked about this payment just now. Nothing was moved. Try again in a minute.',
  VALIDATION_ERROR: `Write the agreement in 1 to ${MAX_REFUND_AGREEMENT} characters. Nothing was changed.`,
};

/** One plain sentence for a refusal of "Move to wallet". */
export function moveRefundRefusal(err: unknown): string {
  if (err instanceof ApiError && err.code && MOVE_WORDS[err.code]) return MOVE_WORDS[err.code]!;
  if (err instanceof ApiError && (err.code === 'ASSISTED_BOOKING_DISABLED' || ((err.status === 404 || err.status === 503) && !err.code))) {
    return 'The admin tools are switched off on this server, so refunds cannot be moved here. Nothing was changed.';
  }
  if (err instanceof ApiError && err.status === 403) return 'Only Jansetu admins can move a refund.';
  return assistedRefusal(err).message;
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

const MARK_WORDS: Readonly<Record<string, string>> = {
  REFUND_AT_GATEWAY: 'Razorpay already has a refund of this payment, done or on its way, so it was not marked failed. Tap “Recheck” to see it.',
  REFUND_BUSY: 'This refund is being worked on right now. Nothing was changed. Try again in a few minutes.',
  REFUND_NOT_PENDING: 'Only a card refund still in progress can be marked failed. Read the list again.',
  GATEWAY_LOOKUP_FAILED: 'Razorpay could not be asked about this payment just now. Nothing was changed. Try again in a minute.',
  REFUND_NOT_FOUND: 'This refund was not found. Nothing was changed.',
  VALIDATION_ERROR: `Write a reason of 1 to ${MAX_REFUND_AGREEMENT} characters. Nothing was changed.`,
};
/** One plain sentence for a refusal of "Mark failed" or "Recheck". */
export function markFailedRefusal(err: unknown): string {
  if (err instanceof ApiError && err.code && MARK_WORDS[err.code]) return MARK_WORDS[err.code]!;
  return moveRefundRefusal(err).replace('Only Jansetu admins can move a refund.', 'Only Jansetu admins can change a refund.');
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
