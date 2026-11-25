import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { canCancelNow, customerApi, type ExternalBooking } from '@jansetu/api';
import { Alert, Empty, ErrorState, formatRupees, Loading } from '@jansetu/ui';
import { Confirm, formatAppointment, messageOf, PageHeading } from '../common.tsx';
import { t } from '../i18n/index.ts';
import { useSession } from '../session.tsx';
import { cancelHint, isPaid } from './BookingScreen.tsx';
import { StatusBadge, titleOf } from './BookingsScreen.tsx';

/** States in which a customer may ask to cancel (the backend has no status guard; these are the sensible ones). */
const CANCELLABLE = ['created', 'pending', 'pending_payment', 'confirmed', 'rescheduled'];

export function ExternalBookingScreen() {
  const { bookingId = '' } = useParams();
  const { api } = useSession();
  const valid = /^[0-9a-fA-F]{24}$/.test(bookingId);
  const q = useQuery({ queryKey: ['external-booking', bookingId], queryFn: () => customerApi(api).externalBooking(bookingId), enabled: valid });
  return (
    <>
      <Link to="/bookings" className="back"><ArrowLeft size={16} aria-hidden="true" /> {t('common.myBookings')}</Link>
      {!valid ? <Empty title={t('common.bookingNotFound')} />
        : q.isPending ? <Loading /> : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : <ExternalView booking={q.data} />}
    </>
  );
}

function ExternalView({ booking: b }: { booking: ExternalBooking }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const status = b.status ?? 'pending';
  const paid = isPaid(b.paymentStatus);
  const check = canCancelNow(b.bookingDate, b.bookingTime, paid);
  return (
    <>
      <PageHeading title={titleOf(b)}>{formatAppointment(b.bookingDate, b.bookingTime)}</PageHeading>
      {status === 'cancellation_requested' && (
        <Alert tone="warn">{t('external.cancelRequested')}</Alert>
      )}
      <section className="card stack">
        <dl className="details">
          <dt>{t('common.status')}</dt><dd><StatusBadge status={status} /></dd>
          {b.patientName && <><dt>{t('common.for')}</dt><dd>{b.patientName}</dd></>}
          {b.labName && <><dt>{t('common.lab')}</dt><dd>{b.labName}</dd></>}
          <dt>{t('common.price')}</dt><dd>{formatRupees(b.price)} · {paid ? t('common.paid') : b.paymentStatus === 'refunded' ? t('common.refunded') : t('common.notPaid')}</dd>
        </dl>
      </section>
      {CANCELLABLE.includes(status) && (
        <section className="card stack" aria-labelledby="cancel-h">
          <h2 id="cancel-h">{t('common.cancel')}</h2>
          {check.ok ? (
            <Confirm label={t('external.cancel')} confirmLabel={t('common.yesCancel')} withReason
              consequence={paid ? t('external.cancelPaid') : t('common.bookingCancelled')}
              onConfirm={async (reason) => {
                try { await customerApi(api).cancelExternal(b._id, reason || undefined); }
                finally {
                  await queryClient.invalidateQueries({ queryKey: ['external-booking', b._id] });
                  await queryClient.invalidateQueries({ queryKey: ['external-bookings'] });
                  await queryClient.invalidateQueries({ queryKey: ['wallet'] });
                }
              }} />
          ) : <Alert tone="warn">{cancelHint(check)}</Alert>}
        </section>
      )}
    </>
  );
}
