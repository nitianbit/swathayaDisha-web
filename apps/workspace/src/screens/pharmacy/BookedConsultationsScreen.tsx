import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  ASSISTED_MODE_LABEL, awaitingCardPayment, bookingStatusLabel, isAssistedBooking, formatSlotDate, isSwitchedOff, SWITCHED_OFF_MESSAGE,
  type AssistedBookingStatus, type AssistedMode, type BookedConsultation,
} from '@jansetu/api';
import { Alert, Badge, Empty, ErrorState, Loading , Parts } from '@jansetu/ui';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession } from '../../session.tsx';
import { CursorPager, StatusFilter, useCursorPages } from './cursorList.tsx';
import { usePharmacyId } from './ownedOp.tsx';
import { pharmacyConsultBooker, type ConsultBooker } from './consultBooker.ts';
import { t } from '../../i18n/pharmacy/index.ts';

/**
 * WQ12: consultations this pharmacy booked (`GET /pharmacy-bookings`, newest first, cursor-paged; phase 0 + 1a).
 * WQ24: the same list for a lab member (`BookedConsultationsList` with the lab's booker: `GET /partner-workspace/assisted/bookings`).
 */
export function BookedConsultationsScreen() {
  const pharmacyId = usePharmacyId();
  const { api } = useSession();
  return (
    <>
      <PageHeading title={t('common.bookedConsultations')}>{t('bookedConsultations.consultationsYourPharmacyBookedFor')}{' '}<Link to="/pharmacy/book">{t('common.bookANewOne')}</Link>.
      </PageHeading>
      <BookedConsultationsList key={pharmacyId} booker={pharmacyConsultBooker(api, pharmacyId)} />
    </>
  );
}

const STATUS_FILTERS = (): { value: AssistedBookingStatus | ''; label: string }[] => ([
  { value: '', label: t('common.all') }, { value: 'confirmed', label: t('bookedConsultations.booked') }, { value: 'completed', label: t('bookedConsultations.done') },
  { value: 'cancelled', label: t('common.cancelled') }, { value: 'no_show', label: t('bookedConsultations.patientDidNotCome') }, { value: 'pending', label: t('bookedConsultations.waiting') },
]);
const PAGE_SIZE = 20;

export const modeWords = (m: string | undefined) => (m && m in ASSISTED_MODE_LABEL ? ASSISTED_MODE_LABEL[m as AssistedMode] : m ?? '—');

/** WQ16: an assisted booking held for its card or UPI payment (a wallet booking is never pending). */
export const waitingForCard = (b: BookedConsultation) => isAssistedBooking(b) && awaitingCardPayment(b);
/** The status in words; "Waiting for payment" for a card booking not paid yet. */
export const statusWords = (b: BookedConsultation) => (waitingForCard(b) ? t('common.waitingForPayment2') : bookingStatusLabel(b.status));

/** Badges next to the status: cancelled by the patient, reported as "not mine", a prescription to read. */
export function BookingBadges({ b }: { b: BookedConsultation }) {
  return (
    <>
      {b.status === 'cancelled' && b.cancellationCause === 'patient' && <> <Badge tone="warn">{t('common.cancelledByPatient')}</Badge></>}
      {b.assisted?.disputed?.state === 'open' && <> <Badge tone="danger">{t('common.patientSaysThisIsNot')}</Badge></>}
      {b.prescription && <> <Badge tone="ok">{t('common.prescription')}</Badge></>}
    </>
  );
}

export function BookedConsultationsList({ booker }: { booker: ConsultBooker }) {
  const [status, setStatus] = useState<AssistedBookingStatus | ''>('');
  const pages = useCursorPages();
  const { cursor } = pages;
  const list = booker.paths.list;
  const q = useQuery({
    queryKey: [...booker.bookingsKey, 'list', status, cursor],
    queryFn: () => booker.api.bookings({ ...(status ? { status } : {}), ...(cursor ? { cursor } : {}), limit: PAGE_SIZE }),
  });

  return (
    <section className="ws-section" aria-labelledby="list-h">
      <h2 id="list-h" className="j-sr-only">{t('common.bookedConsultations')}</h2>
      <StatusFilter id="bk-status" value={status} options={STATUS_FILTERS()} onChange={(v) => { setStatus(v); pages.reset(); }} />
      {q.isPending ? <Loading label={t('bookedConsultations.loadingBookedConsultations')} />
        : q.isError ? (isSwitchedOff(q.error) ? <Alert tone="warn">{SWITCHED_OFF_MESSAGE}</Alert>
          : <ErrorState message={booker.refusal(q.error).message} onRetry={() => void q.refetch()} />)
        : q.data.items.length === 0 ? (
          <Empty title={status ? t('bookedConsultations.noConsultationsWithThisStatus') : t('bookedConsultations.noConsultationsBookedYet')}>
            <Parts of={t.rich('common.forAPatientAtYourFull', { words: <Link to={booker.paths.book}>{t('bookedConsultations.bookAConsultation')}</Link> })} /></Empty>
        ) : (
          <>
            <div className="ws-table-wrap">
              <table className="j-table">
                <caption className="j-sr-only">{t('bookedConsultations.bookedConsultationsNewestFirst')}</caption>
                <thead>
                  <tr><th scope={'col'}>{t('common.when')}</th><th scope={'col'}>{t('common.patient2')}</th><th scope={'col'}>{t('common.doctor2')}</th><th scope={'col'}>{t('common.how')}</th><th scope={'col'}>{t('common.status')}</th><th scope={'col'}><span className="j-sr-only">{t('common.open')}</span></th></tr>
                </thead>
                <tbody>
                  {q.data.items.map((b) => (
                    <tr key={b._id}>
                      <td>{formatSlotDate(b.bookingDate)}{b.bookingTime ? `, ${b.bookingTime}` : ''}</td>
                      <td>{b.patientName ?? '—'}</td>
                      <td>{b.doctorName ?? '—'}</td>
                      <td>{modeWords(b.consultationMode)}</td>
                      <td>{statusWords(b)}<BookingBadges b={b} /></td>
                      <td>
                        {waitingForCard(b)
                          ? <Link to={`${list}/${b._id}`} aria-label={t('bookedConsultations.payNowForTheConsultation', { patient: b.patientName ?? t('common.patientFallback'), doctor: b.doctorName ?? t('common.doctorFallback') })}>{t('common.payNow')}</Link>
                          : <Link to={`${list}/${b._id}`} aria-label={t('bookedConsultations.openTheConsultationOfWith', { patient: b.patientName ?? t('common.patientFallback'), doctor: b.doctorName ?? t('common.doctorFallback') })}>{t('common.open')}</Link>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <CursorPager pages={pages} nextCursor={q.data.nextCursor} label={t('bookedConsultations.bookedConsultationPages')} />
          </>
        )}
    </section>
  );
}
