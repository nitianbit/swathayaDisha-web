import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { canCancelNow, customerApi, type Booking } from '@jansetu/api';
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
  const cancellable = b.status === 'pending' || b.status === 'confirmed';
  const check = canCancelNow(b.bookingDate, b.bookingTime, paid);
  return (
    <>
      <PageHeading title={b.doctorName ?? b.packageName ?? 'Booking'}>{formatAppointment(b.bookingDate, b.bookingTime)}</PageHeading>
      <section className="card stack">
        <dl className="details">
          <dt>Status</dt><dd><StatusBadge status={b.status} /></dd>
          {b.consultationMode && <><dt>Mode</dt><dd>{b.consultationMode.replace(/_/g, ' ')}</dd></>}
          <dt>Price</dt><dd>{formatRupees(b.price)} · {b.paymentStatus === 'paid' ? 'paid' : b.paymentStatus === 'refunded' ? 'refunded' : 'not paid'}</dd>
          {b.cancelledAt && <><dt>Cancelled</dt><dd>{formatDateTime(b.cancelledAt)}{b.cancellationReason ? ` · ${b.cancellationReason}` : ''}</dd></>}
        </dl>
      </section>
      {paymentError && b.paymentStatus !== 'paid' && <Alert>The payment page could not open: {paymentError} You can pay below.</Alert>}
      {b.status === 'pending' && b.paymentStatus === 'pending' && b.paymentTransactionId && Number(b.price ?? 0) > 0 && (
        <PaymentPanel booking={b} />
      )}
      {cancellable && (
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

/**
 * An unpaid booking: on opening, the server checks the payment with Razorpay once (a payment whose confirmation was
 * lost is applied then); the customer can pay (a new order) or check again.
 */
function PaymentPanel({ booking: b }: { booking: Booking }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const [state, setState] = useState<'checking' | PaymentOutcome | 'paying'>('checking');
  const [error, setError] = useState<string | null>(null);
  const checked = useRef(false);
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['booking', b._id] });
    await queryClient.invalidateQueries({ queryKey: ['bookings'] });
    await queryClient.invalidateQueries({ queryKey: ['wallet'] });
  };
  // Every payment attempt of the booking is checked (an older order replaced by "Pay now" too).
  const check = async () => {
    setState('checking');
    try {
      const r = await customerApi(api).reconcileBookingPayments(b._id);
      const paid = r.booking.paymentStatus === 'paid';
      setState(paid ? 'paid' : r.unknown > 0 ? 'unknown' : 'unpaid');
      if (paid || r.booking.status !== b.status) await refresh();
    } catch {
      setState('unknown');
    }
  };
  useEffect(() => { if (!checked.current) { checked.current = true; void check(); } }, []);

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
        : (
          <>
            <Alert tone="warn">
              {state === 'unknown'
                ? 'We could not check your payment just now. If you have paid, it will show here once we can.'
                : 'This booking is not paid yet. Your time is held for you until you pay or cancel.'}
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
