import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { BOOKING_PAYMENT_WINDOW_MIN, canCancelNow, customerApi, payByTime, type Booking } from '@jansetu/api';
import { Alert, Button, Empty, ErrorState, formatDateTime, formatRupees, Loading } from '@jansetu/ui';
import { Confirm, formatAppointment, messageOf, PageHeading } from '../common.tsx';
import { payOrder, type PaymentOutcome } from '../payments.ts';
import { ApiError } from '@jansetu/api';
import { useSession } from '../session.tsx';
import { StatusBadge } from './BookingsScreen.tsx';

export function BookingScreen() {
  const { bookingId = '' } = useParams();
  const { api } = useSession();
  const valid = /^[0-9a-fA-F]{24}$/.test(bookingId);
  const q = useQuery({ queryKey: ['booking', bookingId], queryFn: () => customerApi(api).booking(bookingId), enabled: valid });
  return (
    <>
      <Link to="/bookings" className="back"><ArrowLeft size={16} aria-hidden="true" /> My bookings</Link>
      {!valid ? <Empty title="Booking not found" />
        : q.isPending ? <Loading /> : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : <BookingView booking={q.data} />}
    </>
  );
}

/** A paid booking's money was taken: then the 24-hour (48 for Monday) window applies, and the refund goes to the wallet. */
export const isPaid = (paymentStatus?: string) => paymentStatus === 'paid';

export function cancelHint(check: ReturnType<typeof canCancelNow>): string | null {
  if (check.ok) return null;
  if (check.reason === 'started') return 'This appointment has already started, so it can no longer be cancelled.';
  if (check.reason === 'window_closed') return `Paid bookings can be cancelled until ${check.cutoffHours} hours before the appointment. That time has passed.`;
  return 'This booking’s time could not be read, so it cannot be cancelled here. Please contact support.';
}

function BookingView({ booking: b }: { booking: Booking }) {
  const { api } = useSession();
  const paymentError = (useLocation().state as { paymentError?: string } | null)?.paymentError;
  const queryClient = useQueryClient();
  const paid = isPaid(b.paymentStatus);
  // Q14: a booking moved after a no-show is never refunded, so it cannot be cancelled here (NO_SHOW_NOT_REFUNDABLE).
  const movedAfterNoShow = (b.noShows?.length ?? 0) > 0 || (b.noShowReschedules ?? 0) > 0;
  const cancellable = (b.status === 'pending' || b.status === 'confirmed') && !movedAfterNoShow;
  const missed = b.noShows?.[0];
  const check = canCancelNow(b.bookingDate, b.bookingTime, paid);
  return (
    <>
      <PageHeading title={b.doctorName ?? b.packageName ?? 'Booking'}>{formatAppointment(b.bookingDate, b.bookingTime)}</PageHeading>
      <section className="card stack">
        <dl className="details">
          <dt>Status</dt><dd><StatusBadge status={b.status} cause={b.cancellationCause} /></dd>
          {b.consultationMode && <><dt>Mode</dt><dd>{b.consultationMode.replace(/_/g, ' ')}</dd></>}
          <dt>Price</dt><dd>{formatRupees(b.price)} · {b.paymentStatus === 'paid' ? 'paid' : b.paymentStatus === 'refunded' ? 'refunded' : 'not paid'}</dd>
          {b.cancelledAt && <><dt>Cancelled</dt><dd>{formatDateTime(b.cancelledAt)}{b.cancellationReason ? ` · ${b.cancellationReason}` : ''}</dd></>}
        </dl>
      </section>
      {b.status === 'cancelled' && b.cancellationCause === 'payment_timeout' && (
        <Alert tone="warn">
          This booking expired because it was not paid within {BOOKING_PAYMENT_WINDOW_MIN} minutes, so the time was released.
          Any wallet money used for it is back in your wallet. You can book a new time with the doctor.
        </Alert>
      )}
      {b.status === 'no_show' && (
        <Alert tone="warn">
          You were marked as not present for this appointment. A missed appointment is not refunded.
          {movedAfterNoShow ? ' It had already been moved once after a missed time, so it cannot be moved again.' : ' The doctor or clinic may offer you one new time; you will be told if they do.'}
        </Alert>
      )}
      {movedAfterNoShow && b.status !== 'no_show' && (
        <Alert tone="warn">
          You missed {missed?.fromDate && missed.fromTime ? `the earlier time (${formatAppointment(missed.fromDate, missed.fromTime)})` : 'the earlier time'}, so
          the appointment was moved to the new time: {formatAppointment(b.bookingDate, b.bookingTime)}. It is not refunded and cannot be cancelled
          for a refund. If this time is missed too, it is final.
        </Alert>
      )}
      {paymentError && b.paymentStatus !== 'paid' && <Alert>The payment page could not open: {paymentError} You can pay below.</Alert>}
      {b.status === 'pending' && b.paymentStatus === 'pending' && b.paymentTransactionId && Number(b.price ?? 0) > 0 && (
        <PaymentPanel booking={b} />
      )}
      {b.bookingKind === 'instant' && <InstantNote booking={b} />}
      {cancellable && b.bookingKind !== 'instant' && (
        <section className="card stack" aria-labelledby="cancel-h">
          <h2 id="cancel-h">Cancel</h2>
          {check.ok ? (
            <>
              {check.deadline && <p className="muted">You can cancel until {formatDateTime(check.deadline.toISOString())}.</p>}
              <Confirm label="Cancel this booking" confirmLabel="Yes, cancel it" withReason
                consequence={paid ? 'The booking is cancelled and the amount you paid goes back to your Jansetu wallet.' : 'The booking is cancelled.'}
                onConfirm={async (reason) => {
                  try { await customerApi(api).cancelBooking(b._id, reason || undefined); }
                  finally {
                    await queryClient.invalidateQueries({ queryKey: ['booking', b._id] });
                    await queryClient.invalidateQueries({ queryKey: ['bookings'] });
                    await queryClient.invalidateQueries({ queryKey: ['wallet'] });
                  }
                }} />
            </>
          ) : <Alert tone="warn">{cancelHint(check)}</Alert>}
        </section>
      )}
    </>
  );
}

/** Q4b: a "Consult now" consultation (made when a doctor accepted): the call link; no customer cancel after acceptance. */
function InstantNote({ booking: b }: { booking: Booking }) {
  const meet = b.virtualMeeting;
  const join = meet?.status === 'active' && meet.joinUrl && /^https:\/\//.test(meet.joinUrl) ? meet.joinUrl : null;
  return (
    <section className="card stack" aria-labelledby="instant-h">
      <h2 id="instant-h">Consult now</h2>
      {join && b.status === 'confirmed' && <div className="row"><a className="j-btn j-btn--primary" href={join} target="_blank" rel="noopener noreferrer">Join the call</a></div>}
      <p className="muted">
        This consultation started when the doctor accepted, so it cannot be cancelled. If the doctor cancels, everything you
        paid goes back to your Jansetu wallet.
      </p>
      {b.instantRequestId && /^[0-9a-fA-F]{24}$/.test(b.instantRequestId) && <Link to={`/consult/requests/${b.instantRequestId}`}>See the request</Link>}
    </section>
  );
}

/**
 * An unpaid booking: on opening, the server checks the payment with Razorpay once (a payment whose confirmation was
 * lost is applied then); the customer can pay (a new order) or check again.
 */
function PaymentPanel({ booking: b }: { booking: Booking }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  // 'closed' = the server refused a new payment because the window passed. That is not the final answer: an earlier
  // payment may still be captured (then the booking is confirmed), otherwise the sweep cancels it. Keep checking.
  const [state, setState] = useState<'checking' | PaymentOutcome | 'paying' | 'closed'>('checking');
  const closed = useRef(false);
  const payBy = payByTime(b.createdAt);
  const [error, setError] = useState<string | null>(null);
  const checked = useRef(false);
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['booking', b._id] });
    await queryClient.invalidateQueries({ queryKey: ['bookings'] });
    await queryClient.invalidateQueries({ queryKey: ['wallet'] });
  };
  // Every payment attempt of the booking is checked (an older order replaced by "Pay now" too).
  const check = async () => {
    if (!closed.current) setState('checking');
    try {
      const r = await customerApi(api).reconcileBookingPayments(b._id);
      const paid = r.booking.paymentStatus === 'paid';
      if (paid) setState('paid');
      else if (!closed.current) setState(r.unknown > 0 ? 'unknown' : 'unpaid');
      if (paid || r.booking.status !== b.status || r.booking.paymentStatus !== b.paymentStatus) await refresh();
    } catch {
      if (!closed.current) setState('unknown');
    }
  };
  useEffect(() => { if (!checked.current) { checked.current = true; void check(); } }, []);
  // While the window is closed but the booking is still pending, look again every minute for the final state.
  useEffect(() => {
    if (state !== 'closed') return;
    const t = setInterval(() => void check(), 60_000);
    return () => clearInterval(t);
  }, [state]);

  async function payNow() {
    setError(null);
    setState('paying');
    try {
      const r = await customerApi(api).retryPayment(b._id, {});
      if (r.paymentRequired && r.payment) {
        const outcome = await payOrder(api, r.payment, {}, b.doctorName ? `Consultation with ${b.doctorName}` : 'Booking');
        setState(outcome);
      } else {
        setState('paid');
      }
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'BOOKING_ALREADY_PAID') { setState('paid'); await refresh(); return; }
      // The payment window has passed: no new order. The booking's final state is still to come.
      if (err instanceof ApiError && err.code === 'BOOKING_PAYMENT_EXPIRED') { closed.current = true; setState('closed'); await refresh(); return; }
      setError(messageOf(err));
      // The server refuses a new order while an earlier payment cannot be checked.
      setState(err instanceof ApiError && err.code === 'PAYMENT_STATE_UNKNOWN' ? 'unknown' : 'unpaid');
    }
  }

  return (
    <section className="card stack" aria-labelledby="pay-h">
      <h2 id="pay-h">Payment</h2>
      {state === 'checking' ? <Loading label="Checking your payment…" />
        : state === 'paid' ? <Alert tone="ok">Payment received. Your booking is confirmed.</Alert>
        : state === 'closed' ? (
          <>
            <Alert tone="warn">
              The time to pay for this booking has passed, so a new payment cannot be started. If you already paid, the
              booking will be confirmed; otherwise it will be released. This page checks again every minute.
            </Alert>
            <div className="row">
              <Button variant="secondary" onClick={() => void check()}>Check now</Button>
            </div>
          </>
        ) : (
          <>
            <Alert tone="warn">
              {state === 'unknown'
                ? 'We could not check your payment just now. If you have paid, it will show here once we can.'
                : `This booking is not paid yet. Your time is held ${payBy ? `until ${formatDateTime(payBy.toISOString())}` : `for ${BOOKING_PAYMENT_WINDOW_MIN} minutes from booking`}; after that it is released.`}
            </Alert>
            {error && <Alert>{error}</Alert>}
            <div className="row">
              {/* Never offer a new payment while an earlier one could not be checked: it might already be paid. */}
              <Button busy={state === 'paying'} disabled={state === 'unknown'} onClick={() => void payNow()}>Pay now</Button>
              <Button variant="secondary" disabled={state === 'paying'} onClick={() => void check()}>I have paid, check again</Button>
            </div>
          </>
        )}
    </section>
  );
}
