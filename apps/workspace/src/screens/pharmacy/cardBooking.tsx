import { useEffect, useRef, useState } from 'react';
import {
  assistedRefusal, beforeCheckout, checkCardPayment, checkoutSeconds, LATE_CAPTURE_WORDS, orderFromBooking, PAY_NOW_MARGIN_MS, payByWords, payNowOpen, pharmacyAssistedApi,
  settleCardPayment, type ApiClient, type AssistedCardPayment, type BookedConsultation, type CardOutcome, type PendingMarker,
} from '@jansetu/api';
import { Alert, Button, formatRupees } from '@jansetu/ui';
import { useSession } from '../../session.tsx';
import type { Perform } from '../finance/finance.tsx';
import { NOT_OPENED, openCheckout } from './topup.tsx';

/**
 * WQ16 (r10 phase 1b, §23.3): a walk-in consultation paid by card or UPI. The booking is held as pending payment with ONE
 * Razorpay order; "Pay now" reopens that same order (there is no second order, C10). Proof → `POST /payments/verify`,
 * then the server's own check `POST /payments/reconcile`. The screen says "paid" or "refunded" only from those answers.
 *
 * Card bookings made on this device are remembered by their request key only (a body-less reload marker, D4: no amount,
 * no names), per pharmacy and booking: `GET /pharmacy-assisted/bookings/by-key/:key` then gives the open order back, so
 * "Pay now" works from the booked consultation too, also after a reload. WQ16b: the booker view's `payment` (r10c) says how
 * a booking is paid, its pay-by time and its record ("Check payment" from any device); the marker remains for "Pay now"
 * (no read gives the open order without the key) and, on an older server, for the cancel step's refund choice.
 * WQ16c: r10d adds the open order to that `payment` while it waits, so "Pay now" works from any device on such a server.
 * "Pay now" re-reads the order first, stops 2 minutes before the pay-by time (Checkout closes itself by then), and is never
 * offered again once Razorpay reported a payment or the outcome is unknown: only "Check payment" then.
 */
const cardSlot = (pharmacyId: string, bookingId: string) => `assisted-card:${pharmacyId}:${bookingId.toLowerCase()}`;

export function useCardBookings(pharmacyId: string) {
  const { memory } = useSession();
  return {
    keyOf: (bookingId: string) => memory.get<PendingMarker>(cardSlot(pharmacyId, bookingId))?.requestKey ?? null,
    remember: (bookingId: string, requestKey: string) => {
      const now = Date.now();
      memory.set<PendingMarker>(cardSlot(pharmacyId, bookingId), { requestKey, attempts: 0, firstAttemptAt: now, lastAttemptAt: now });
    },
    forget: (bookingId: string) => memory.delete(cardSlot(pharmacyId, bookingId)),
  };
}

export type CardStep = CardOutcome | { kind: 'not_opened' };

/**
 * Opens Checkout on the booking's order (closing itself before the cut-off), then settles the attempt with the server.
 * Never throws. `reported`: Checkout said the payment went through.
 */
export async function payCardOrder(api: ApiClient, order: AssistedCardPayment): Promise<{ step: CardStep; reported: boolean }> {
  const timeoutSeconds = checkoutSeconds(order.payBy);
  if (timeoutSeconds === 0) return { step: { kind: 'unpaid' }, reported: false };
  let result;
  try {
    result = await openCheckout({ razorpayKeyId: order.razorpayKeyId, razorpayOrderId: order.razorpayOrderId, amountMinor: order.amountMinor,
      currency: order.currency, description: 'Doctor consultation for a patient', ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}) });
  } catch {
    return { step: { kind: 'not_opened' }, reported: false };
  }
  const reported = result.kind === 'paid';
  const step = await settleCardPayment(api, order.paymentTransactionId, result.kind === 'paid'
    ? { razorpayOrderId: result.razorpayOrderId, razorpayPaymentId: result.razorpayPaymentId, razorpaySignature: result.razorpaySignature } : null);
  return { step, reported };
}

type Note = { tone: 'ok' | 'warn' | 'error'; text: string };
export const DO_NOT_PAY_AGAIN = 'Razorpay reported the payment; it is being confirmed. Do not pay again. Tap “Check payment” in a minute.';
export const NO_ORDER_WORDS = 'The card payment for this booking could not be started. Tap “Check payment”, or cancel this booking under Booked consultations and book again.';

/**
 * A card booking waiting for its payment: "Pay before HH:MM or the time is released", "Pay now" (the same order) and
 * "Check payment". `onPaid` runs once the server says paid; `onEnded` once it says the payment can never pay this booking
 * (a late capture refunded to the card, a failed payment, the booking no longer payable).
 */
export function CardPaymentPanel({ bookingId, requestKey, order: initial, amountMinor, payBy, paymentTransactionId, perform, busy, autoOpen, onHeld, onPaid, onEnded }: {
  bookingId: string;
  /** The create's key (this device): it gives the open order back for "Pay now" on any server. */
  requestKey: string | null;
  /** WQ16b (r10c booker view `payment`): the record to check from any device. */
  paymentTransactionId?: string | null;
  /** The open order known now (the create's answer, or r10d's booker view); re-read before Checkout is reopened. */
  order: AssistedCardPayment | null;
  amountMinor?: number;
  /** Until the order is read: the booking's pay-by time (the server's, else its creation + 30 minutes). */
  payBy?: string;
  perform: Perform;
  busy: boolean;
  /** Open Checkout once as soon as the panel shows (right after the booking was made, on the create's own order). */
  autoOpen?: boolean;
  /** card-last: told whenever the payment is (or stops being) held for confirmation. */
  onHeld?: (held: boolean) => void;
  /** `note`: WQ16d, said with it (another payment of this booking is being refunded). */
  onPaid: (booking: Partial<BookedConsultation> | null, note?: string) => void;
  onEnded: (words: string) => void;
}) {
  const { api } = useSession();
  const [order, setOrder] = useState<AssistedCardPayment | null>(initial);
  const [note, setNote] = useState<Note | null>(null);
  /** Razorpay reported a payment, or the outcome is unknown: "Pay now" is not offered again (only "Check payment"). */
  const [held, setHeld] = useState(false);
  const reported = useRef(false);
  useEffect(() => { onHeld?.(held); }, [held]);
  const [now, setNow] = useState(() => Date.now());
  const live = useRef(true);
  const opened = useRef(false);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const due = order?.payBy || payBy;
  // "Pay now" closes 2 minutes before the pay-by time, also while the page stays open.
  useEffect(() => {
    const t = due ? Date.parse(due) - PAY_NOW_MARGIN_MS - Date.now() : NaN;
    if (!Number.isFinite(t) || t <= 0 || t > 2 ** 31 - 1) return;
    const timer = setTimeout(() => setNow(Date.now()), t + 50);
    return () => clearTimeout(timer);
  }, [due]);
  const late = !payNowOpen(due, now);
  const canPay = !!order || !!requestKey;
  const payOffered = canPay && !late && !held;

  async function apply(step: CardStep, o: AssistedCardPayment | null, didReport = false) {
    if (!live.current) return;
    // WQ16d (r10e): this payment was a second one on a booking already paid; it goes back to the card. Never "paid" by
    // itself: the booking is read again, and shown paid only if the server says so.
    if (step.kind === 'duplicate') {
      setHeld(true);
      setNote({ tone: 'warn', text: step.message });
      // card-last: a failed re-read leaves the duplicate sentence on screen.
      const b = await (requestKey ? pharmacyAssistedApi(api).byKey(requestKey).then((r) => (r.state === 'used' ? r.booking : null))
        : pharmacyAssistedApi(api).booking(bookingId)).catch(() => null);
      if (live.current && b?.status === 'confirmed' && b.paymentStatus === 'paid') onPaid(b, step.message);
      return;
    }
    if (didReport) reported.current = true;
    const dueWords = payByWords(o?.payBy || due);
    const stillOpen = canPay && payNowOpen(o?.payBy || due);
    switch (step.kind) {
      case 'paid': onPaid(step.booking); return;
      case 'refunded': onEnded(LATE_CAPTURE_WORDS); return;
      case 'failed': onEnded(step.message); return;
      case 'not_opened':
        setNote({ tone: 'warn', text: `${NOT_OPENED} ${dueWords}${stillOpen && !held ? ' Tap “Pay now” to try again.' : ''}` }); return;
      case 'unpaid':
        if (step.inFlight || reported.current) { setHeld(true); setNote({ tone: 'warn', text: DO_NOT_PAY_AGAIN }); return; }
        setHeld(false);
        setNote({ tone: 'warn', text: `Not paid yet. ${dueWords}${stillOpen ? ' Tap “Pay now” to pay.' : ''} If you did pay, wait a minute and tap “Check payment”.` });
        return;
      case 'blocked': if (reported.current) setHeld(true); setNote({ tone: 'error', text: step.message }); return;
      default:
        setHeld(true);
        setNote({ tone: 'warn', text: reported.current ? DO_NOT_PAY_AGAIN
          : `We could not confirm the payment yet (${step.message}) Do not pay again: if you paid, your money is safe. Tap “Check payment” in a minute.` });
    }
  }

  /**
   * The open order as the server has it now: by the create's key (any server), else from the booking (r10d). Settles the
   * panel when the booking is paid or no longer payable; null when there is no order to open.
   */
  async function freshOrder(): Promise<AssistedCardPayment | null> {
    const assisted = pharmacyAssistedApi(api);
    let b: BookedConsultation;
    let o: AssistedCardPayment | null;
    if (requestKey) {
      const r = await assisted.byKey(requestKey);
      if (r.state !== 'used') { setNote({ tone: 'error', text: 'This booking was not found on this device. Look for it under Booked consultations.' }); return null; }
      b = r.booking;
      o = r.payment ?? null;
    } else {
      b = await assisted.booking(bookingId);
      o = orderFromBooking(b);
    }
    if (o) { if (live.current) setOrder(o); return o; }
    if (b.status === 'confirmed' && b.paymentStatus === 'paid') { onPaid(b); return null; }
    if (b.status !== 'pending') { onEnded(`This booking can no longer be paid: it was cancelled, or its time was released because it was not paid in time. If money was taken, it goes back to the card or UPI.`); return null; }
    if (live.current) { setOrder(null); setNote({ tone: 'warn', text: NO_ORDER_WORDS }); }
    return null;
  }

  async function payNow(first = false) {
    try {
      await perform(async () => {
        // The create's own order is used as answered; a reopen reads the order again first.
        const o = first && order ? order : await freshOrder();
        if (!o) return;
        if (!payNowOpen(o.payBy || due)) { setNow(Date.now()); setNote({ tone: 'warn', text: 'It is too late to open the payment page now. If you paid, tap “Check payment”.' }); return; }
        // card-last: a reopen asks the server first (also after the panel was shown again): an authorized payment at
        // Razorpay is on its way, so no second payment page; an unfinished (created) attempt opens it, keeping any warning.
        if (!first) {
          const pre = await beforeCheckout(api, o.paymentTransactionId);
          if (pre.kind === 'settled') { await apply(pre.outcome, o); return; }
          if (!pre.created) setNote(null);
        } else setNote(null);
        const r = await payCardOrder(api, o);
        await apply(r.step, o, r.reported);
      });
    } catch (err) {
      if (live.current) setNote({ tone: 'error', text: assistedRefusal(err).message });
    }
  }

  async function check() {
    setNote(null);
    try {
      await perform(async () => {
        const id = order?.paymentTransactionId ?? paymentTransactionId ?? (requestKey ? (await freshOrder())?.paymentTransactionId : undefined);
        if (!id) { if (live.current && !requestKey) setNote({ tone: 'warn', text: NO_ORDER_WORDS }); return; }
        await apply(await checkCardPayment(api, id), order);
      });
    } catch (err) {
      if (live.current) setNote({ tone: 'error', text: assistedRefusal(err).message });
    }
  }

  useEffect(() => {
    if (!autoOpen || opened.current) return;
    opened.current = true;
    void payNow(true);
  }, [autoOpen]);

  const price = order?.amountMinor ?? amountMinor;
  return (
    <div className="confirm" role="group" aria-label="Waiting for payment">
      <Alert tone="warn">
        <strong>Waiting for payment.</strong> {payByWords(due)} The time is held for the patient until then. The patient and the doctor are told once it is paid.
      </Alert>
      {note && <Alert tone={note.tone}>{note.text}</Alert>}
      {!canPay && !held && (
        <p className="ws-muted">
          The payment page opens only in the browser tab where this booking was made (Razorpay’s order is kept there). If it was paid there, tap “Check payment”.
        </p>
      )}
      {canPay && late && !held && <p className="ws-muted">The time to pay is almost over, so the payment page is not opened again. If you paid, tap “Check payment”.</p>}
      <div className="confirm-actions">
        {payOffered && <Button busy={busy} onClick={() => void payNow()}>Pay now{price !== undefined ? ` ${formatRupees(price / 100)}` : ''}</Button>}
        <Button variant={payOffered ? 'secondary' : 'primary'} disabled={busy} onClick={() => void check()}>Check payment</Button>
      </div>
    </div>
  );
}
