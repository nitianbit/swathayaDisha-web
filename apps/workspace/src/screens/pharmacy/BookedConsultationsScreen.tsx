import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  ASSISTED_MODE_LABEL, assistedRefusal, awaitingCardPayment, bookingStatusLabel, isAssistedBooking, formatSlotDate, isSwitchedOff, pharmacyAssistedApi, SWITCHED_OFF_MESSAGE,
  type AssistedBookingStatus, type AssistedMode, type BookedConsultation,
} from '@jansetu/api';
import { Alert, Badge, Empty, ErrorState, Loading } from '@jansetu/ui';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession } from '../../session.tsx';
import { CursorPager, StatusFilter, useCursorPages } from './cursorList.tsx';
import { usePharmacyId } from './ownedOp.tsx';

/** WQ12: consultations this pharmacy booked (`GET /pharmacy-bookings`, newest first, cursor-paged; phase 0 + 1a). */
export function BookedConsultationsScreen() {
  const pharmacyId = usePharmacyId();
  return (
    <>
      <PageHeading title="Booked consultations">
        Consultations your pharmacy booked for patients, newest first. Open one to cancel it, join the call or see the prescription.
        {' '}<Link to="/pharmacy/book">Book a new one</Link>.
      </PageHeading>
      <BookedList key={pharmacyId} pharmacyId={pharmacyId} />
    </>
  );
}

const STATUS_FILTERS: { value: AssistedBookingStatus | ''; label: string }[] = [
  { value: '', label: 'All' }, { value: 'confirmed', label: 'Booked' }, { value: 'completed', label: 'Done' },
  { value: 'cancelled', label: 'Cancelled' }, { value: 'no_show', label: 'Patient did not come' }, { value: 'pending', label: 'Waiting' },
];
const PAGE_SIZE = 20;

export const modeWords = (m: string | undefined) => (m && m in ASSISTED_MODE_LABEL ? ASSISTED_MODE_LABEL[m as AssistedMode] : m ?? '—');

/** WQ16: an assisted booking held for its card or UPI payment (a wallet booking is never pending). */
export const waitingForCard = (b: BookedConsultation) => isAssistedBooking(b) && awaitingCardPayment(b);
/** The status in words; "Waiting for payment" for a card booking not paid yet. */
export const statusWords = (b: BookedConsultation) => (waitingForCard(b) ? 'Waiting for payment' : bookingStatusLabel(b.status));

/** Badges next to the status: cancelled by the patient, reported as "not mine", a prescription to read. */
export function BookingBadges({ b }: { b: BookedConsultation }) {
  return (
    <>
      {b.status === 'cancelled' && b.cancellationCause === 'patient' && <> <Badge tone="warn">Cancelled by patient</Badge></>}
      {b.assisted?.disputed?.state === 'open' && <> <Badge tone="danger">Patient says this is not theirs</Badge></>}
      {b.prescription && <> <Badge tone="ok">Prescription</Badge></>}
    </>
  );
}

function BookedList({ pharmacyId }: { pharmacyId: string }) {
  const { api } = useSession();
  const [status, setStatus] = useState<AssistedBookingStatus | ''>('');
  const pages = useCursorPages();
  const { cursor } = pages;
  const q = useQuery({
    queryKey: ['pharmacy-bookings', pharmacyId, 'list', status, cursor],
    queryFn: () => pharmacyAssistedApi(api).bookings({ ...(status ? { status } : {}), ...(cursor ? { cursor } : {}), limit: PAGE_SIZE }),
  });

  return (
    <section className="ws-section" aria-labelledby="list-h">
      <h2 id="list-h" className="j-sr-only">Booked consultations</h2>
      <StatusFilter id="bk-status" value={status} options={STATUS_FILTERS} onChange={(v) => { setStatus(v); pages.reset(); }} />
      {q.isPending ? <Loading label="Loading booked consultations…" />
        : q.isError ? (isSwitchedOff(q.error) ? <Alert tone="warn">{SWITCHED_OFF_MESSAGE}</Alert>
          : <ErrorState message={assistedRefusal(q.error).message} onRetry={() => void q.refetch()} />)
        : q.data.items.length === 0 ? (
          <Empty title={status ? 'No consultations with this status' : 'No consultations booked yet'}>
            <Link to="/pharmacy/book">Book a consultation</Link> for a patient at your counter.
          </Empty>
        ) : (
          <>
            <div className="ws-table-wrap">
              <table className="j-table">
                <caption className="j-sr-only">Booked consultations, newest first</caption>
                <thead>
                  <tr><th scope="col">When</th><th scope="col">Patient</th><th scope="col">Doctor</th><th scope="col">How</th><th scope="col">Status</th><th scope="col"><span className="j-sr-only">Open</span></th></tr>
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
                          ? <Link to={`/pharmacy/consultations/${b._id}`} aria-label={`Pay now for the consultation of ${b.patientName ?? 'the patient'} with ${b.doctorName ?? 'the doctor'}`}>Pay now</Link>
                          : <Link to={`/pharmacy/consultations/${b._id}`} aria-label={`Open the consultation of ${b.patientName ?? 'the patient'} with ${b.doctorName ?? 'the doctor'}`}>Open</Link>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <CursorPager pages={pages} nextCursor={q.data.nextCursor} label="Booked consultation pages" />
          </>
        )}
    </section>
  );
}
