import { useEffect, useRef, useState } from 'react';
import {
  assistedRefusal, checkCardPayment, LATE_CAPTURE_WORDS, payByWords, pharmacyAssistedApi, settleCardPayment, type ApiClient, type AssistedCardPayment,
  type BookedConsultation, type CardOutcome, type PendingMarker,
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

/** Opens Checkout on the booking's order, then settles the attempt with the server. Never throws. */
export async function payCardOrder(api: ApiClient, order: AssistedCardPayment): Promise<CardStep> {
  let result;
  try {
    result = await openCheckout({ razorpayKeyId: order.razorpayKeyId, razorpayOrderId: order.razorpayOrderId, amountMinor: order.amountMinor,
      currency: order.currency, description: 'Doctor consultation for a patient' });
  } catch {
    return { kind: 'not_opened' };
  }
  return settleCardPayment(api, order.paymentTransactionId, result.kind === 'paid'
    ? { razorpayOrderId: result.razorpayOrderId, razorpayPaymentId: result.razorpayPaymentId, razorpaySignature: result.razorpaySignature } : null);
}

type Note = { tone: 'ok' | 'warn' | 'error'; text: string };

/**
 * A card booking waiting for its payment: "Pay before HH:MM or the time is released", "Pay now" (the same order) and
 * "Check payment". `onPaid` runs once the server says paid; `onEnded` once it says the payment can never pay this booking
 * (a late capture refunded to the card, a failed payment, the booking no longer payable).
 */
export function CardPaymentPanel({ requestKey, order: initial, amountMinor, payBy, paymentTransactionId, perform, busy, autoOpen, onPaid, onEnded }: {
  /** The create's key (this device): it gives the open order back for "Pay now". Without it only "Check payment" works. */
  requestKey: string | null;
  /** WQ16b (r10c booker view `payment`): the record to check from any device. */
  paymentTransactionId?: string | null;
  order: AssistedCardPayment | null;
  amountMinor?: number;
  /** Until the order is read: the booking's own pay-by time (its creation + 30 minutes, the server's rule). */
  payBy?: string;
  perform: Perform;
  busy: boolean;
  /** Open Checkout once as soon as the panel shows (right after the booking was made). */
  autoOpen?: boolean;
  onPaid: (booking: Partial<BookedConsultation> | null) => void;
  onEnded: (words: string) => void;
}) {
  const { api } = useSession();
  const [order, setOrder] = useState<AssistedCardPayment | null>(initial);
  const [note, setNote] = useState<Note | null>(null);
  const live = useRef(true);
  const opened = useRef(false);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  function apply(step: CardStep, o: AssistedCardPayment | null) {
    if (!live.current) return;
    const due = payByWords(o?.payBy ?? payBy);
    switch (step.kind) {
      case 'paid': onPaid(step.booking); return;
      case 'refunded': onEnded(LATE_CAPTURE_WORDS); return;
      case 'failed': onEnded(step.message); return;
      case 'not_opened': setNote({ tone: 'warn', text: `${NOT_OPENED} ${due} Tap “Pay now” to try again.` }); return;
      case 'unpaid': setNote({ tone: 'warn', text: `Not paid yet. ${due} Tap “Pay now” to pay. If you did pay, wait a minute and tap “Check payment”.` }); return;
      case 'blocked': setNote({ tone: 'error', text: step.message }); return;
      default: setNote({ tone: 'warn', text: `We could not confirm the payment yet (${step.message}) If you paid, your money is safe: tap “Check payment” in a minute.` });
    }
  }

  /** The open order: the one held here, else the booking's by its key (read only; null when none is open). */
  async function currentOrder(): Promise<AssistedCardPayment | null> {
    if (order) return order;
    if (!requestKey) return null;
    const r = await pharmacyAssistedApi(api).byKey(requestKey);
    if (r.state !== 'used') { setNote({ tone: 'error', text: 'This booking was not found on this device. Look for it under Booked consultations.' }); return null; }
    if (r.payment) { if (live.current) setOrder(r.payment); return r.payment; }
    const b = r.booking;
    if (b.status === 'confirmed' && b.paymentStatus === 'paid') { onPaid(b); return null; }
    if (b.status !== 'pending') { onEnded('This booking can no longer be paid: it was cancelled, or its time was released because it was not paid in time. If money was taken, it goes back to the card or UPI.'); return null; }
    setNote({ tone: 'warn', text: 'The payment page for this booking is not ready yet. Try “Pay now” again in a minute.' });
    return null;
  }

  async function payNow() {
    setNote(null);
    try {
      await perform(async () => {
        const o = await currentOrder();
        if (!o) return;
        apply(await payCardOrder(api, o), o);
      });
    } catch (err) {
      if (live.current) setNote({ tone: 'error', text: assistedRefusal(err).message });
    }
  }

  async function check() {
    setNote(null);
    try {
      await perform(async () => {
        const o = paymentTransactionId && !order ? null : await currentOrder();
        const id = o?.paymentTransactionId ?? paymentTransactionId;
        if (!id) return;
        apply(await checkCardPayment(api, id), o);
      });
    } catch (err) {
      if (live.current) setNote({ tone: 'error', text: assistedRefusal(err).message });
    }
  }

  useEffect(() => {
    if (!autoOpen || opened.current) return;
    opened.current = true;
    void payNow();
  }, [autoOpen]);

  const price = order?.amountMinor ?? amountMinor;
  return (
    <div className="confirm" role="group" aria-label="Waiting for payment">
      <Alert tone="warn">
        <strong>Waiting for payment.</strong> {payByWords(order?.payBy ?? payBy)} The time is held for the patient until then. The patient and the doctor are told once it is paid.
      </Alert>
      {note && <Alert tone={note.tone}>{note.text}</Alert>}
      {!order && !requestKey && (
        <p className="ws-muted">
          The payment page opens only in the browser tab where this booking was made (Razorpay’s order is kept there). If it was paid there, tap “Check payment”.
        </p>
      )}
      <div className="confirm-actions">
        {(order || requestKey) && <Button busy={busy} onClick={() => void payNow()}>Pay now{price !== undefined ? ` ${formatRupees(price / 100)}` : ''}</Button>}
        <Button variant={order || requestKey ? 'secondary' : 'primary'} disabled={busy} onClick={() => void check()}>Check payment</Button>
      </div>
    </div>
  );
}
