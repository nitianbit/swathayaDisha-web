import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { canCancelNow, customerApi, type Booking } from '@jansetu/api';
import { Alert, Empty, ErrorState, formatDateTime, formatRupees, Loading } from '@jansetu/ui';
import { Confirm, formatAppointment, messageOf, PageHeading } from '../common.tsx';
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
