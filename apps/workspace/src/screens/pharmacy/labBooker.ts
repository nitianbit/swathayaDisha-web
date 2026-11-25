import {
  CONSENT_STATEMENT, CONSENT_STATEMENT_VERSION, DOCTOR_LAB_CLOSED_MESSAGE, DOCTOR_LAB_CONSENT_STATEMENT, DOCTOR_LAB_CONSENT_VERSION, doctorLabApi, doctorLabRefusal,
  doctorRecommendationsApi, isDoctorWalletClosed, labRefusal, pharmacyLabApi, pharmacyRecommendationsApi, type ApiClient, type LabBookerKind, type LabCreateRequest,
  type LabReceipt, type LabRoutes, type PatientLookup, type Refusal, type TestRecommendation,
} from '@jansetu/api';
import type { WalletPayer } from './WalletScreen.tsx';
import { doctorLabCardSource, labCardSource, type CardBookingSource } from './cardBooking.tsx';
import { t } from '../../i18n/pharmacy/index.ts';

/**
 * WQ25: who books a lab test for a patient, for the one Book lab test and Booked lab tests screens (WQ17, generalised, not
 * copied): a pharmacy (its counter) or a verified, active doctor (backend r26 phase 3b, design §25.15: the patient of its
 * own consultation or a walk-in by phone). Both pay from their wallet or by card / UPI (WQ27: a doctor from r29 phase 3c,
 * §25.16). Only the routes, keys, memory slots, paths and a few words differ; the pharmacy's are exactly WQ17's.
 */
export interface LabBooker {
  kind: LabBookerKind;
  /** The signed-in booker's id: the screens are keyed by it. */
  id: string;
  routes: LabRoutes & { book: (request: LabCreateRequest) => Promise<LabReceipt> };
  /** The booker's own masked lookup (a doctor's); the pharmacy's is the patient step's default. */
  lookup?: (phone: string) => Promise<PatientLookup>;
  loadRecommendation: (code: string, phone: string) => Promise<TestRecommendation>;
  refusal: (err: unknown) => Refusal;
  /** A doctor not verified and active (403 `SPECIALIST_NOT_VERIFIED` on every route): only `closedMessage` is shown. */
  closed?: (err: unknown) => boolean;
  closedMessage?: string;
  consent: { statement: string; version: string };
  payer: WalletPayer;
  /** Where a card booking of this booker is read again (WQ17c; WQ27 a doctor's). */
  cardSource: (api: ApiClient, bookingId: string, requestKey: string | null) => CardBookingSource;
  /** This booker's memory slot for one owned request (`book`, or a booking's `accept` / `cancel`). */
  slot: (what: 'book' | 'accept' | 'cancel', bookingId?: string) => string;
  listKey: readonly unknown[];
  labsKey: readonly unknown[];
  walletKey: readonly unknown[];
  paths: { book: string; list: string };
  words: {
    /** "Jansetu turns it on for …". */
    offFor: string;
    /** A cancellation by the booker. */
    byBooker: string;
    /** After "Book a lab test" on an empty list. */
    emptyFor: string;
    /** The recommended-tests code field (the pharmacy's: "from the doctor"). */
    recommendationLabel?: string;
  };
}

export function pharmacyLabBooker(api: ApiClient, pharmacyId: string): LabBooker {
  const labs = pharmacyLabApi(api);
  return {
    kind: 'pharmacy', id: pharmacyId,
    routes: { ...labs, book: (r) => { if (!('phone' in r)) throw new Error(t('labBooker.aPharmacyBooksByPhone')); return labs.book(r); } },
    loadRecommendation: pharmacyRecommendationsApi(api).load, refusal: labRefusal,
    consent: { statement: CONSENT_STATEMENT, version: CONSENT_STATEMENT_VERSION }, payer: { kind: 'pharmacy', id: pharmacyId }, cardSource: labCardSource,
    slot: (what, bookingId) => `assisted-lab-${what}:${pharmacyId}${bookingId ? `:${bookingId}` : ''}`,
    listKey: ['pharmacy-lab-bookings', pharmacyId], labsKey: ['assisted-labs', pharmacyId], walletKey: ['pharmacy-wallet', pharmacyId],
    paths: { book: '/pharmacy/lab-book', list: '/pharmacy/lab-tests' },
    words: { offFor: 'for your pharmacy', byBooker: t('labBooker.byYourPharmacy'), emptyFor: ` ${t('common.forAPatientAtYour')}` },
  };
}

export function doctorLabBooker(api: ApiClient, doctorId: string): LabBooker {
  const labs = doctorLabApi(api);
  return {
    kind: 'doctor', id: doctorId, routes: labs, lookup: labs.lookup, loadRecommendation: doctorRecommendationsApi(api).load, refusal: doctorLabRefusal,
    closed: isDoctorWalletClosed, closedMessage: DOCTOR_LAB_CLOSED_MESSAGE,
    consent: { statement: DOCTOR_LAB_CONSENT_STATEMENT, version: DOCTOR_LAB_CONSENT_VERSION }, payer: { kind: 'doctor', id: doctorId },
    cardSource: doctorLabCardSource,
    slot: (what, bookingId) => `assisted-lab-${what}:doctor:${doctorId}${bookingId ? `:${bookingId}` : ''}`,
    listKey: ['doctor-lab-bookings', doctorId], labsKey: ['doctor-assisted-labs', doctorId], walletKey: ['doctor-wallet', doctorId],
    paths: { book: '/doctor/lab-book', list: '/doctor/lab-tests' },
    words: { offFor: 'for you', byBooker: t('labBooker.byYou'), emptyFor: ` ${t('labBooker.forAPatient')}`, recommendationLabel: t('labBooker.haveARecommendedTestsCode') },
  };
}
