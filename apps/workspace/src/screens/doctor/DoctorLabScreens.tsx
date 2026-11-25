import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { DOCTOR_LAB_CLOSED_MESSAGE, isDoctorWalletClosed, OBJECT_ID_PATTERN } from '@jansetu/api';
import { Alert, Empty, Loading, shared } from '@jansetu/ui';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession, useStaff } from '../../session.tsx';
import { BookLabTest } from '../pharmacy/BookLabTestScreen.tsx';
import { LabDetail, LabList } from '../pharmacy/BookedLabTestsScreen.tsx';
import { doctorLabBooker } from '../pharmacy/labBooker.ts';
import { usePayerWallet } from '../pharmacy/WalletScreen.tsx';
import { t } from '../../i18n/doctor/index.ts';

/**
 * WQ25: a doctor books a lab test for a patient (assisted booking round 3b, backend r26, design §25.15) on the pharmacy's
 * Book lab test and Booked lab tests screens (WQ17), with the doctor as the booker: the patient of one of its own
 * consultations (Appointments › "Book lab test for this patient", `/doctor/lab-book/from/:bookingId`: an id only in the
 * address) or a walk-in by phone; paid from the doctor wallet (WQ23) only. Only a verified, active doctor books.
 */
export function DoctorBookLabTestScreen() {
  const doctor = useStaff();
  const { api } = useSession();
  const { fromBookingId } = useParams();
  return (
    <>
      <PageHeading title={t('doctorLab.bookLabTest')}>{t('doctorLab.bookALabTestFor')}</PageHeading>
      <VerifiedOnly doctorId={doctor.id}>
        {fromBookingId !== undefined && !OBJECT_ID_PATTERN.test(fromBookingId) ? (
          <Empty title={t('doctorLab.consultationNotFound')}><Link to="/doctor/lab-book">{t('doctorLab.bookForAPatientBy')}</Link></Empty>
        ) : (
          <BookLabTest key={`${doctor.id}:${fromBookingId ?? ''}`} booker={doctorLabBooker(api, doctor.id)} fromBookingId={fromBookingId} />
        )}
      </VerifiedOnly>
    </>
  );
}

/**
 * Every r26 route needs a verified, active doctor (403 `SPECIALIST_NOT_VERIFIED`, reads included): the doctor's wallet is
 * read first (the pay step reads it anyway), so an unverified doctor is told before typing anything. Once read, a later
 * failed read never hides the page (an unconfirmed booking stays on screen).
 */
function VerifiedOnly({ doctorId, children }: { doctorId: string; children: ReactNode }) {
  const wallet = usePayerWallet({ kind: 'doctor', id: doctorId });
  if (wallet.isPending) return <Loading label={shared('state.loading')} />;
  if (wallet.isError && wallet.data === undefined && isDoctorWalletClosed(wallet.error)) return <Alert tone="warn">{DOCTOR_LAB_CLOSED_MESSAGE}</Alert>;
  return <>{children}</>;
}

export function DoctorLabTestsScreen() {
  const doctor = useStaff();
  const { api } = useSession();
  return (
    <>
      <PageHeading title={t('doctorLab.labTestsBooked')}>{t('doctorLab.labTestsYouBookedFor')}{' '}<Link to="/doctor/lab-book">{t('doctorLab.bookANewOne')}</Link>.
      </PageHeading>
      <LabList key={doctor.id} booker={doctorLabBooker(api, doctor.id)} />
    </>
  );
}

/** `/doctor/lab-tests/:bookingId`: another doctor's booking answers 404 `LAB_BOOKING_NOT_FOUND` ("Lab test not found"). */
export function DoctorLabTestScreen() {
  const { bookingId = '' } = useParams();
  const doctor = useStaff();
  const { api } = useSession();
  return (
    <>
      <Link to="/doctor/lab-tests" className="ws-back"><ArrowLeft size={16} aria-hidden="true" />{t('doctorLab.labTestsBooked2')}</Link>
      <PageHeading title={t('doctorLab.labTest')} />
      <LabDetail key={`${doctor.id}:${bookingId}`} booker={doctorLabBooker(api, doctor.id)} bookingId={bookingId} />
    </>
  );
}
