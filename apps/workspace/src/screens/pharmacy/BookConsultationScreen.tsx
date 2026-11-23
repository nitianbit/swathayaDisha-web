import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  ApiError, ASSISTED_GENDERS, ASSISTED_MODE_LABEL, ASSISTED_RELATIONS, assistedRefusal, canonicalPhone, CONSENT_STATEMENT, CONSENT_STATEMENT_LANGUAGE,
  CONSENT_STATEMENT_VERSION, EMPTY_PATIENT, familyBookedBefore, formatSlotDate, isSwitchedOff, istToday, joinWords, nextFreeSlot, refusedBeforeWriting, supportedModes,
  MAX_CONCERN, MAX_PERSON_NAME, PATIENT_LANGUAGES, patientBody, patientProblems, pharmacyAssistedApi, SWITCHED_OFF_MESSAGE, walletBalancePaise,
  walletState, type AssistedCardPayment, type AssistedDoctor, type AssistedGender, type AssistedMode, type AssistedRelation, type AssistedSlot, type BookedConsultation,
  type ConsultationReceipt, type ConsultationRequest, type JoinOn, type PatientDraft, type PatientLookup, type Refusal,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, formatRupees, Loading, TextArea, TextField } from '@jansetu/ui';
import { PageHeading } from '../../PageHeading.tsx';
import { newRequestKey, startOp, wasAbandoned, type PendingOp } from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { useOneAtATime } from '../finance/finance.tsx';
import { CardPaymentPanel, useCardBookings } from './cardBooking.tsx';
import { CheckPanel, useOwnedOp, usePharmacyId } from './ownedOp.tsx';
import { TopUpForm } from './topup.tsx';
import { useWallet, walletHoldWords } from './WalletScreen.tsx';

/**
 * WQ12: a pharmacy books a doctor consultation for a walk-in patient (assisted booking phase 1a, §19.3):
 * the patient by phone (`POST /pharmacy-assisted/patients/lookup`: the masked holder name only), the "patient agreed"
 * tick, the doctor (`GET /pharmacy-assisted/doctors`, nearby first) and time (`GET …/doctors/:id/slots`), then the price and the wallet, and one
 * keyed create (`POST /pharmacy-assisted/consultations`, paid from the wallet). The phone stays in this page's state and
 * in POST bodies: never in the address, storage or logs.
 * WQ16 (r10 phase 1b, §23.3): or paid by card or UPI (`paymentMethod: 'razorpay'`: the same body, key and owned request);
 * the booking is then held until its `payBy` and paid on its one Razorpay order (`cardBooking.tsx`).
 */
export function BookConsultationScreen() {
  const pharmacyId = usePharmacyId();
  return (
    <>
      <PageHeading title="Book consultation">
        Book a doctor for a patient at your counter. You pay Jansetu from your wallet, or by card or UPI; you collect the fee from the patient.
      </PageHeading>
      <Book key={pharmacyId} pharmacyId={pharmacyId} />
    </>
  );
}

/** What the screen shows about a booking being sent (kept in session memory with the request, never in storage). */
interface Summary { patient: string; doctor: string; date: string; time: string; mode: AssistedMode; joinOn?: JoinOn; priceMinor: number; couponCode?: string;
  /** The price came from the server's answer with the coupon applied (PRICE_CHANGED), not from the doctor's fee. */
  couponChecked?: boolean }
interface PendingBooking { request: ConsultationRequest; summary: Summary }
interface Done { summary: Summary; ref?: string; paidMinor?: number; replayed: boolean; newAccount?: boolean; paidBy?: 'wallet' | 'card' }
/** WQ16: a card booking held until it is paid (or its time is released). */
interface CardDue { bookingId: string; requestKey: string; order: AssistedCardPayment | null; summary: Summary; ref?: string; newAccount?: boolean; autoOpen: boolean }
type PayMethod = ConsultationRequest['paymentMethod'];

/** How many days of one doctor's free times are shown at once (the slots read allows 1–14). */
const SLOT_DAYS = 7;
const describeWhen = (s: Summary) => `${formatSlotDate(s.date)} at ${s.time}`;

function SummaryList({ s }: { s: Summary }) {
  return (
    <ul className="ws-list">
      <li>Patient: <strong>{s.patient}</strong></li>
      <li>Doctor: <strong>{s.doctor}</strong></li>
      <li>When: <strong>{describeWhen(s)}</strong></li>
      <li>How: <strong>{ASSISTED_MODE_LABEL[s.mode]}</strong>{s.mode !== 'in-person' && s.joinOn ? ` (${s.joinOn === 'partner_device' ? 'on this pharmacy’s device' : 'on the patient’s phone'})` : ''}</li>
      <li>Price: <strong>{formatRupees(s.priceMinor / 100)}</strong>{s.couponCode ? ` (coupon ${s.couponCode})` : ''}</li>
    </ul>
  );
}

function doneFromReceipt(r: ConsultationReceipt, summary: Summary): Done {
  return { summary, ref: r.booking.assisted?.shortRef, paidMinor: r.funding?.amountMinor, replayed: r.replayed, newAccount: r.newAccount,
    paidBy: r.funding?.method === 'razorpay' ? 'card' : 'wallet' };
}
function summaryOf(b: BookedConsultation, summary: Summary | undefined): Summary {
  return summary ?? {
    patient: b.patientName ?? 'The patient', doctor: b.doctorName ?? 'The doctor', date: b.bookingDate ?? '', time: b.bookingTime ?? '',
    mode: (b.consultationMode as AssistedMode) ?? 'video', joinOn: b.assisted?.join?.on, priceMinor: Math.round(Number(b.price ?? 0) * 100),
  };
}
function doneFromView(b: BookedConsultation, summary: Summary | undefined, paidBy: Done['paidBy'] = 'wallet'): Done {
  return { summary: summaryOf(b, summary), ref: b.assisted?.shortRef, paidMinor: typeof b.price === 'number' ? Math.round(b.price * 100) : undefined, replayed: true, paidBy };
}
/** WQ16: a card booking that can no longer be paid (cancelled, or its time released unpaid). */
const NOT_PAYABLE_WORDS = 'This booking was not paid in time (or was cancelled), so its time was released and nothing is booked. Book again if the patient still wants it.';

/** The doctor card's next time: only one the time list would show (a chat-only next time is left out, as in the list). */
function nextWords(d: AssistedDoctor, modeFilter: AssistedMode | ''): string {
  const next = nextFreeSlot(d, modeFilter);
  if (next) return `Next free time: ${formatSlotDate(next.date)} at ${next.startTime}`;
  return d.nextSlot ? 'Choose to see the free times' : 'No free times soon';
}

/** Plain refusal words, adjusted when a coupon explains the new price. */
function refusalText(r: Refusal, coupon?: string): string {
  if (r.kind === 'price' && coupon && r.priceMinor !== undefined) return `With the coupon ${coupon}, the price is ${formatRupees(r.priceMinor / 100)}. Check it with the patient, then pay.`;
  return r.message;
}

function Book({ pharmacyId }: { pharmacyId: string }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const assisted = pharmacyAssistedApi(api);
  const { op, send, settle } = useOwnedOp<PendingBooking>(`assisted-book:${pharmacyId}`);
  const { perform, busy } = useOneAtATime('booking');
  const [off, setOff] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);
  const [givingUp, setGivingUp] = useState(false);
  // WQ16: card or UPI.
  const cards = useCardBookings(pharmacyId);
  const [method, setMethod] = useState<PayMethod>('wallet');
  /** Why card or UPI cannot pay (the switch is off, no gateway keys): the card option is then disabled. */
  const [cardOff, setCardOff] = useState<string | null>(null);
  const [cardDue, setCardDue] = useState<CardDue | null>(null);
  /** The booking could not be made or paid after all (a late payment refunded, the time released): said once. */
  const [ended, setEnded] = useState<string | null>(null);
  /** 502 RAZORPAY_ORDER_CREATION_FAILED: the booking is held; the same request again gets the payment page. */
  const [orderFailed, setOrderFailed] = useState(false);

  // Step 1: the patient.
  const [phoneText, setPhoneText] = useState('');
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [lookup, setLookup] = useState<{ phone: string; result: PatientLookup } | null>(null);
  const [patient, setPatient] = useState<PatientDraft>(EMPTY_PATIENT);
  const [patientErrors, setPatientErrors] = useState<Partial<Record<keyof PatientDraft, string>>>({});
  const [agreed, setAgreed] = useState(false);
  const [agreeError, setAgreeError] = useState<string | null>(null);
  const [patientDone, setPatientDone] = useState(false);

  // Step 2: the doctor and the time.
  const [speciality, setSpeciality] = useState('');
  const [modeFilter, setModeFilter] = useState<AssistedMode | ''>('');
  const [date, setDate] = useState(() => istToday());
  const [doctorId, setDoctorId] = useState<string | null>(null);
  const [slotId, setSlotId] = useState<string | null>(null);
  const [mode, setMode] = useState<AssistedMode | ''>('');
  const [joinOn, setJoinOn] = useState<JoinOn | ''>('');
  const [joinPhone, setJoinPhone] = useState('');
  const [language, setLanguage] = useState('');
  const [concern, setConcern] = useState('');
  const [coupon, setCoupon] = useState('');
  const [visitErrors, setVisitErrors] = useState<Record<string, string>>({});

  // Step 3: check and pay.
  const [review, setReview] = useState<({ requestKey: string } & PendingBooking) | null>(null);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  const set = <K extends keyof PatientDraft>(k: K, v: PatientDraft[K]) => setPatient((d) => ({ ...d, [k]: v }));

  function resetAll() {
    setPhoneText(''); setPhoneError(null); setLookup(null); setPatient(EMPTY_PATIENT); setPatientErrors({}); setAgreed(false); setAgreeError(null);
    setPatientDone(false); setDoctorId(null); setSlotId(null); setMode(''); setJoinOn(''); setJoinPhone(''); setLanguage(''); setConcern('');
    setCoupon(''); setVisitErrors({}); setReview(null); setRefused(null); setDone(null); setNotice(null);
    setCardDue(null); setEnded(null); setMethod('wallet');
  }

  async function find(e: FormEvent) {
    e.preventDefault();
    setNotice(null);
    const phone = canonicalPhone(phoneText);
    if (!phone) { setPhoneError('Enter a valid 10-digit mobile number.'); return; }
    setPhoneError(null);
    try {
      const result = await perform(() => assisted.lookup(phone));
      setLookup({ phone, result });
      setPatient({ ...EMPTY_PATIENT, phone });
      setPatientErrors({});
    } catch (err) {
      if (isSwitchedOff(err)) { setOff(true); return; }
      setPhoneError(assistedRefusal(err).message);
    }
  }

  function changePhone() {
    setLookup(null); setPatient(EMPTY_PATIENT); setPatientErrors({}); setAgreed(false); setPatientDone(false); setReview(null); setRefused(null);
  }

  // Family members this pharmacy booked for before on this number (its own list; the lookup never lists the family).
  const family = useQuery({
    queryKey: ['pharmacy-bookings', pharmacyId, 'family-source'],
    queryFn: async () => {
      const first = await assisted.bookings({ limit: 50 });
      const second = first.nextCursor ? await assisted.bookings({ limit: 50, cursor: first.nextCursor }) : null;
      return [...first.items, ...(second?.items ?? [])];
    },
    enabled: !!lookup?.result.exists,
    staleTime: 60_000,
  });
  const knownFamily = useMemo(() => (lookup && family.data ? familyBookedBefore(family.data, lookup.phone) : []), [lookup, family.data]);

  function patientNext(e: FormEvent) {
    e.preventDefault();
    if (!lookup) return;
    const problems = patientProblems({ ...patient, phone: lookup.phone }, lookup.result.exists);
    setPatientErrors(problems);
    setAgreeError(agreed ? null : 'Ask the patient, then tick this box. Without it you cannot book.');
    if (Object.keys(problems).length || !agreed) return;
    setPatientDone(true);
  }

  const patientLabel = (): string => {
    if (patient.who === 'known') return knownFamily.find((f) => f.dependentId === patient.dependentId)?.name ?? 'Family member';
    const name = patient.name.trim().replace(/\s+/g, ' ');
    return patient.who === 'family' ? `${name} (${patient.relation.toLowerCase()} of the phone’s owner)` : name;
  };

  // The doctor list: nearby first (the pharmacy's pincode, then its city); that day's free times.
  const doctors = useQuery({
    queryKey: ['assisted-doctors', pharmacyId, speciality, modeFilter],
    queryFn: () => assisted.doctors({ ...(speciality ? { speciality } : {}), ...(modeFilter ? { mode: modeFilter } : {}), limit: 50 }),
    enabled: patientDone && !off,
  });
  // The chosen doctor's free times for a week from the chosen day (`GET /pharmacy-assisted/doctors/:id/slots`).
  const slots = useQuery({
    queryKey: ['assisted-doctors', pharmacyId, 'slots', doctorId, modeFilter, date],
    queryFn: () => assisted.doctorSlots(doctorId!, { from: date, days: SLOT_DAYS, ...(modeFilter ? { mode: modeFilter } : {}) }),
    enabled: patientDone && !off && !!doctorId,
  });
  const allDoctors = useQuery({
    queryKey: ['assisted-doctors', pharmacyId, 'specialities'],
    queryFn: () => assisted.doctors({ limit: 100 }),
    enabled: patientDone && !off,
    staleTime: 5 * 60_000,
  });
  useEffect(() => {
    if (isSwitchedOff(doctors.error) || isSwitchedOff(allDoctors.error) || isSwitchedOff(slots.error)) setOff(true);
  }, [doctors.error, allDoctors.error, slots.error]);
  const specialities = useMemo(() => [...new Set((allDoctors.data ?? []).map((d) => d.specialization).filter((x): x is string => !!x))].sort(), [allDoctors.data]);
  const doctor: AssistedDoctor | null = doctors.data?.find((d) => d.doctorId === doctorId) ?? null;
  const slot: AssistedSlot | null = (doctor && slots.data?.slots.find((s) => s.slotId === slotId)) || null;
  const slotDays = useMemo(() => {
    const days = new Map<string, AssistedSlot[]>();
    // A time offered only in a mode the booking cannot use (e.g. chat) is not shown.
    for (const s of slots.data?.slots ?? []) if (supportedModes(s.modes, modeFilter).length) days.set(s.date, [...(days.get(s.date) ?? []), s]);
    return [...days];
  }, [slots.data, modeFilter]);
  const modes: AssistedMode[] = slot ? supportedModes(slot.modes, modeFilter) : [];

  function chooseDoctor(id: string) { setDoctorId(id); setSlotId(null); setMode(''); setJoinOn(''); setVisitErrors({}); setRefused(null); }
  function chooseSlot(s: AssistedSlot) {
    setSlotId(s.slotId);
    const m = supportedModes(s.modes, modeFilter);
    setMode(m.length === 1 ? m[0]! : '');
    setVisitErrors({});
    setRefused(null);
  }

  function visitNext(e: FormEvent, priceMinor?: number) {
    e.preventDefault();
    setRefused(null);
    const errs: Record<string, string> = {};
    if (!doctor) errs.doctor = 'Choose a doctor.';
    else if (!slot) errs.slot = 'Choose a time.';
    else if (!mode) errs.mode = 'Choose how the consultation happens.';
    if (mode && mode !== 'in-person') {
      if (!joinOn) errs.joinOn = 'Choose where the patient joins.';
      if (mode === 'call' && joinOn === 'patient_phone' && joinPhone.trim() && !canonicalPhone(joinPhone)) errs.joinPhone = 'Enter a valid 10-digit mobile number, or leave it empty.';
    }
    if (!language) errs.language = 'Choose the language the patient speaks.';
    if (concern.trim().length > MAX_CONCERN) errs.concern = `Use at most ${MAX_CONCERN} characters.`;
    const code = coupon.trim().toUpperCase();
    if (code && !/^[A-Z0-9_-]{2,50}$/.test(code)) errs.coupon = 'Check the coupon code (letters and numbers only).';
    setVisitErrors(errs);
    if (Object.keys(errs).length || !doctor || !slot || !mode || !lookup) return;
    // The fee as the doctor's own slot read says (fresher than the list); the server still fences it (PRICE_CHANGED).
    const price = priceMinor ?? slots.data?.doctor.feeMinor ?? doctor.feeMinor;
    const join = mode === 'in-person' ? undefined
      // The "number to call" field is shown (and sent) only for a phone call on the patient's phone.
      : { on: joinOn as JoinOn, ...(mode === 'call' && joinOn === 'patient_phone' && joinPhone.trim() ? { phone: canonicalPhone(joinPhone)! } : {}) };
    const requestKey = newRequestKey();
    const request: ConsultationRequest = {
      requestKey, phone: lookup.phone, ...patientBody({ ...patient, phone: lookup.phone }),
      consent: { agreed: true, statementVersion: CONSENT_STATEMENT_VERSION, statementLanguage: CONSENT_STATEMENT_LANGUAGE },
      preferredLanguage: language, slotId: slot.slotId, consultationMode: mode, ...(join ? { join } : {}),
      ...(code ? { couponCode: code } : {}), acceptedPriceMinor: price, ...(concern.trim() ? { primaryConcern: concern.trim() } : {}),
      paymentMethod: 'wallet',
    };
    setReview({
      requestKey, request,
      summary: { patient: patientLabel(), doctor: doctor.name, date: slot.date, time: slot.startTime, mode, ...(join ? { joinOn: join.on } : {}), priceMinor: price,
        ...(code ? { couponCode: code } : {}) },
    });
  }

  const refreshAfterBooking = () => {
    void queryClient.invalidateQueries({ queryKey: ['pharmacy-wallet', pharmacyId] });
    void queryClient.invalidateQueries({ queryKey: ['pharmacy-bookings', pharmacyId] });
    void queryClient.invalidateQueries({ queryKey: ['assisted-doctors', pharmacyId] });
  };

  /** Sends `p` (its key, its request) under the one-at-a-time guard; an unknown outcome stays stored for the panel. */
  async function sendBooking(p: PendingOp<PendingBooking>) {
    const sole = p.attempts === 0 && !p.uncertain;
    const r = await perform(() => send(p, (b) => assisted.book(b.request)));
    if (r.kind === 'stale') return;
    setOrderFailed(r.kind === 'unknown' && r.error instanceof ApiError && r.error.code === 'RAZORPAY_ORDER_CREATION_FAILED');
    if (r.kind === 'ok') {
      setReview(null);
      afterReceipt(r.value, p.requestKey, p.body.summary);
      refreshAfterBooking();
      return;
    }
    if (r.kind === 'unknown' && wasAbandoned(r.error)) {
      settle(p.requestKey);
      setReview(null);
      setNotice('This booking was given up earlier, so nothing was booked or charged with it. Book again if the patient still wants it.');
      return;
    }
    // A limit, the switch, the indexes or customer linking refused the only attempt before any booking write
    // (`refusedBeforeWriting`): nothing was booked. Paying again later is a new request.
    if (r.kind === 'unknown' && sole && refusedBeforeWriting(r.error)) {
      settle(p.requestKey);
      const why = assistedRefusal(r.error);
      if (why.kind === 'off') { setOff(true); setReview(null); return; }
      if (why.kind === 'card') cardRefused(r.error);
      setRefused(why);
      rotateKey();
      return;
    }
    if (r.kind === 'refused') {
      const why = assistedRefusal(r.error);
      if (why.kind === 'off') { setOff(true); setReview(null); return; }
      setRefused(why);
      // WQ16: card or UPI cannot pay this booking: the review stays, with the wallet; paying again is a new request.
      if (why.kind === 'card') { cardRefused(r.error); rotateKey(); return; }
      if (why.kind === 'slot' || why.kind === 'doctor') {
        setReview(null);
        setSlotId(null);
        void doctors.refetch();
        void slots.refetch();
      } else if (why.kind === 'patient' || why.kind === 'coupon' || why.kind === 'other' || why.kind === 'limit') setReview(null);
      // 'price', 'topup', 'wallet': the review stays, with what to do next; paying again is a new request (a new key).
      if (why.kind === 'topup' || why.kind === 'wallet') {
        void queryClient.invalidateQueries({ queryKey: ['pharmacy-wallet', pharmacyId] });
        rotateKey();
      }
    }
  }

  /** WQ16: the switch is off, or there are no gateway keys: the card option is disabled. "Nothing to pay": wallet only. */
  function cardRefused(err: unknown) {
    setMethod('wallet');
    const code = err instanceof ApiError ? err.code : undefined;
    if (code === 'PAYMENT_METHOD_UNAVAILABLE') setCardOff('Card payment is not switched on yet.');
    else if (code === 'RAZORPAY_NOT_CONFIGURED') setCardOff('Card and UPI payments are not set up on this server yet.');
  }

  /** WQ16: what a create (or its replay) answered: a wallet booking is done; a card booking waits for its payment. */
  function afterReceipt(r: ConsultationReceipt, requestKey: string, summary: Summary) {
    if (r.funding?.method !== 'razorpay') { setDone(doneFromReceipt(r, summary)); return; }
    cards.remember(r.booking._id, requestKey);
    const b = r.booking;
    if (b.status === 'confirmed' && b.paymentStatus === 'paid') { setDone(doneFromReceipt(r, summary)); return; }
    if (b.status === 'pending') {
      setCardDue({ bookingId: b._id, requestKey, order: r.payment ?? null, summary, ref: b.assisted?.shortRef, newAccount: r.newAccount, autoOpen: !!r.payment });
      return;
    }
    cards.forget(b._id);
    setEnded(NOT_PAYABLE_WORDS);
  }

  /**
   * A by-key answer `used` (the check, or a give-up that found it). A card booking (`payment` present) waits for its
   * payment; one still without its order (502 at create) needs the same request again, so the request stays stored.
   * Answers null once settled, or what is still to do.
   */
  function afterUsed(r: { booking: BookedConsultation; payment?: AssistedCardPayment | null }, p: PendingOp<PendingBooking>, restored: boolean): string | null {
    const summary = restored ? undefined : p.body?.summary;
    if (!('payment' in r)) {
      settle(p.requestKey);
      setReview(null);
      setDone(doneFromView(r.booking, summary));
      refreshAfterBooking();
      return null;
    }
    const b = r.booking;
    if (b.status === 'pending' && !r.payment && !restored) return 'The booking is held, but its card payment could not be started. Send the same request again to get the payment page.';
    settle(p.requestKey);
    setReview(null);
    refreshAfterBooking();
    if (b.status === 'confirmed' && b.paymentStatus === 'paid') { cards.remember(b._id, p.requestKey); setDone(doneFromView(b, summary, 'card')); return null; }
    if (b.status === 'pending') {
      cards.remember(b._id, p.requestKey);
      setCardDue({ bookingId: b._id, requestKey: p.requestKey, order: r.payment ?? null, summary: summaryOf(b, summary), ref: b.assisted?.shortRef, autoOpen: false });
      return null;
    }
    setEnded(NOT_PAYABLE_WORDS);
    return null;
  }

  /** The review stays, but paying again is a new request (a new key). */
  const rotateKey = () => {
    const requestKey = newRequestKey();
    setReview((v) => (v ? { ...v, requestKey, request: { ...v.request, requestKey } } : v));
  };

  async function pay() {
    if (!review) return;
    const { requestKey, ...rest } = review;
    // WQ16: the chosen way to pay goes in the same body (a free consultation is always booked with the wallet method).
    const paymentMethod: PayMethod = method === 'razorpay' && !cardOff && rest.summary.priceMinor > 0 ? 'razorpay' : 'wallet';
    const pending: PendingBooking = { ...rest, request: { ...rest.request, paymentMethod } };
    setRefused(null);
    try {
      await sendBooking(startOp(requestKey, pending));
    } catch (err) {
      setRefused(assistedRefusal(err)); // the one-at-a-time guard refused: nothing was sent
    }
  }

  /** A new review at the price the server named (a coupon or a changed fee): a new request with a new key. */
  function payAtNewPrice(priceMinor: number) {
    if (!review) return;
    const requestKey = newRequestKey();
    setRefused(null);
    setReview({ requestKey, request: { ...review.request, requestKey, acceptedPriceMinor: priceMinor }, summary: { ...review.summary, priceMinor, couponChecked: true } });
  }

  async function giveUp(p: PendingOp<PendingBooking>) {
    setResendError(null);
    setGivingUp(true);
    try {
      const r = await perform(() => assisted.abandon(p.requestKey));
      if (r.state === 'used') {
        const left = afterUsed(r, p, !!p.restored || !p.body);
        if (left) setResendError(left);
        return;
      }
      // Only `abandoned` means given up; any other answer leaves it unknown (the panel stays).
      if (r.state !== 'abandoned') { setResendError('It could not be given up yet. Check whether it was recorded, then try again.'); return; }
      settle(p.requestKey);
      setReview(null);
      setNotice('Given up: nothing was booked or charged with that request, and it can never be booked now. You can book again.');
    } catch (err) {
      setResendError(assistedRefusal(err).message);
    } finally {
      setGivingUp(false);
    }
  }

  // An unconfirmed booking stays on screen while it is resent or given up (its first attempt shows the review busy).
  if (op && !(busy && !givingUp && op.attempts === 1 && !op.uncertain)) {
    const restored = !!op.restored || !op.body;
    return (
      <>
        {resendError && <Alert>{resendError}</Alert>}
        <CheckPanel label="Unconfirmed booking"
          onCheck={async () => {
            const r = await assisted.byKey(op.requestKey);
            if (r.state === 'used') return afterUsed(r, op, restored);
            if (r.state === 'abandoned') {
              settle(op.requestKey);
              setReview(null);
              setNotice('That booking was given up, so nothing was booked or charged with it. You can book again.');
              return null;
            }
            return restored
              ? 'Not booked so far. It may still be on its way. Give it up to make sure it never is, then book again.'
              : 'Not booked so far. It may still be on its way. Sending the same request again is safe: it is never booked or charged twice.';
          }}
          resend={restored ? undefined : {
            label: 'Send the same request again', busy: busy && !givingUp,
            onClick: () => { setResendError(null); void sendBooking(op).catch((err: unknown) => setResendError(assistedRefusal(err).message)); },
          }}
          giveUp={{ label: 'Give this up', busy: givingUp, onClick: () => void giveUp(op) }}>
          {orderFailed && !restored && (
            <Alert tone="warn">The booking is held, but the card payment could not be started. Send the same request again to get the payment page: it is never booked twice.</Alert>
          )}
          <Alert tone="warn">
            {restored
              ? 'A booking made earlier on this device (before the page was reloaded, or before you signed out) was not confirmed. Its details are not kept here. Check it, or give it up: then it can never be booked.'
              : `The outcome of this request is not known yet${op.error ? ` (${op.error})` : ''}. The booking may already be made and paid. Sending the same request again is safe: it is never booked or charged twice. Or give it up: then it can never be booked.`}
          </Alert>
          {!restored && op.body && <SummaryList s={op.body.summary} />}
        </CheckPanel>
      </>
    );
  }

  if (off) {
    return (
      <Alert tone="warn">
        {SWITCHED_OFF_MESSAGE} Jansetu turns it on for your pharmacy when it is ready. Your other tools work as usual.
      </Alert>
    );
  }

  if (ended) {
    return (
      <section className="ws-section" aria-labelledby="ended-h">
        <h2 id="ended-h">Not booked</h2>
        <Alert>{ended}</Alert>
        <div className="ws-actions">
          <Button onClick={resetAll}>Book another consultation</Button>
          <Link to="/pharmacy/consultations">See booked consultations</Link>
        </div>
      </section>
    );
  }

  if (cardDue) {
    const due = cardDue;
    return (
      <section className="ws-section" aria-labelledby="card-h">
        <h2 id="card-h">Booking held: waiting for payment</h2>
        <p>Pay by card or UPI on the Razorpay page.{due.ref ? <> Booking reference: <strong>{due.ref}</strong>.</> : null}</p>
        <SummaryList s={due.summary} />
        <CardPaymentPanel key={due.bookingId} requestKey={due.requestKey} order={due.order} amountMinor={due.summary.priceMinor} perform={perform} busy={busy}
          autoOpen={due.autoOpen}
          onPaid={() => { setCardDue(null); setDone({ summary: due.summary, ref: due.ref, paidMinor: due.order?.amountMinor ?? due.summary.priceMinor, replayed: false, newAccount: due.newAccount, paidBy: 'card' }); refreshAfterBooking(); }}
          onEnded={(words) => { cards.forget(due.bookingId); setCardDue(null); setEnded(words); refreshAfterBooking(); }} />
        {due.newAccount && <p className="ws-muted">This number was new to Jansetu. An account was made for it; the patient can sign in with this number later.</p>}
        <div className="ws-actions">
          <Link to="/pharmacy/consultations">See booked consultations</Link>
          <span className="ws-muted">You can also pay it from there, on this device.</span>
        </div>
      </section>
    );
  }

  if (done) {
    const byCard = done.paidBy === 'card';
    return (
      <section className="ws-section" aria-labelledby="done-h">
        <h2 id="done-h">{done.replayed ? 'Already booked' : 'Booked'}</h2>
        <Alert tone="ok">
          {done.replayed ? 'This booking was already made. Nothing was booked or charged twice.'
            : byCard ? 'The consultation is booked and paid by card or UPI.' : 'The consultation is booked and paid from your wallet.'}
          {done.ref ? <> Booking reference: <strong>{done.ref}</strong>.</> : null}
        </Alert>
        <SummaryList s={done.summary} />
        {done.paidMinor !== undefined && <p>{byCard ? 'Paid by card or UPI' : 'Paid from your wallet'}: <strong>{formatRupees(done.paidMinor / 100)}</strong>. Collect this from the patient.</p>}
        <p><strong>How the patient joins:</strong> {joinWords(done.summary.mode, done.summary.joinOn)}</p>
        {done.newAccount && <p className="ws-muted">This number was new to Jansetu. An account was made for it; the patient can sign in with this number later.</p>}
        <div className="ws-actions">
          <Button onClick={resetAll}>Book another consultation</Button>
          <Link to="/pharmacy/consultations">See booked consultations</Link>
        </div>
      </section>
    );
  }

  const frozenPatient = patientDone || !!review || busy;
  return (
    <>
      {notice && <Alert tone="ok">{notice}</Alert>}

      <section className="ws-section" aria-labelledby="pt-h">
        <h2 id="pt-h">1. Patient</h2>
        {!lookup ? (
          <form className="ws-search" noValidate onSubmit={(e) => void find(e)}>
            <TextField label="Patient’s mobile number" inputMode="tel" autoComplete="off" value={phoneText} error={phoneError}
              hint="The number the patient (or their family) uses. A family can share one number." onChange={(e) => setPhoneText(e.target.value)} />
            <Button type="submit" busy={busy}>Find</Button>
          </form>
        ) : (
          <form className="rx-form" noValidate onSubmit={patientNext}>
            <div className="ws-actions">
              <span>Mobile number <strong>{lookup.phone}</strong></span>
              <Button variant="ghost" disabled={frozenPatient} onClick={changePhone}>Change number</Button>
            </div>
            {lookup.result.exists ? (
              <Alert tone="ok">
                This number is on Jansetu. Account holder: <strong>{lookup.result.holderNameMasked ?? 'name not given'}</strong>.
                {' '}Only part of the name is shown, to protect the patient.
              </Alert>
            ) : (
              <Alert tone="warn">This number is new to Jansetu. An account is made for it when you book.</Alert>
            )}
            <fieldset className="ws-frozen" disabled={frozenPatient}>
              {!lookup.result.exists && (
                <TextField label="Type the number again" inputMode="tel" autoComplete="off" value={patient.phoneAgain} error={patientErrors.phoneAgain}
                  onChange={(e) => set('phoneAgain', e.target.value)} />
              )}
              <fieldset className="ws-checks" aria-describedby={patientErrors.dependentId ? 'who-err' : undefined}>
                <legend>Who is the patient?</legend>
                <label className="ws-check">
                  <input type="radio" name="who" checked={patient.who === 'self'} onChange={() => setPatient((d) => ({ ...d, who: 'self', dependentId: '' }))} />
                  The phone’s owner{lookup.result.exists && lookup.result.holderNameMasked ? ` (${lookup.result.holderNameMasked})` : ''}
                </label>
                {knownFamily.map((f) => (
                  <label key={f.dependentId} className="ws-check">
                    <input type="radio" name="who" checked={patient.who === 'known' && patient.dependentId === f.dependentId}
                      onChange={() => setPatient((d) => ({ ...d, who: 'known', dependentId: f.dependentId }))} />
                    {f.name} (family member, booked here before)
                  </label>
                ))}
                <label className="ws-check">
                  <input type="radio" name="who" checked={patient.who === 'family'} onChange={() => setPatient((d) => ({ ...d, who: 'family', dependentId: '' }))} />
                  {knownFamily.length ? 'Another family member' : 'A family member of the phone’s owner'}
                </label>
                {patientErrors.dependentId && <span id="who-err" className="j-field__error" role="alert">{patientErrors.dependentId}</span>}
              </fieldset>
              {lookup.result.exists && family.isPending && <span className="ws-muted">Looking for family members you booked for before…</span>}

              {patient.who === 'self' && (
                <TextField label="Patient’s full name" autoComplete="off" value={patient.name} maxLength={MAX_PERSON_NAME} error={patientErrors.name}
                  hint="Type the name the patient tells you." onChange={(e) => set('name', e.target.value)} />
              )}
              {patient.who === 'family' && (
                <>
                  <div className="rx-form-row">
                    <TextField label="Family member’s full name" autoComplete="off" value={patient.name} maxLength={MAX_PERSON_NAME} error={patientErrors.name}
                      onChange={(e) => set('name', e.target.value)} />
                    <div className="j-field">
                      <label htmlFor="pt-relation">Relation to the phone’s owner</label>
                      <select id="pt-relation" value={patient.relation} aria-invalid={patientErrors.relation ? true : undefined}
                        aria-describedby={patientErrors.relation ? 'pt-relation-err' : undefined}
                        onChange={(e) => set('relation', e.target.value as AssistedRelation | '')}>
                        <option value="">Choose…</option>
                        {ASSISTED_RELATIONS.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                      {patientErrors.relation && <span id="pt-relation-err" className="j-field__error" role="alert">{patientErrors.relation}</span>}
                    </div>
                  </div>
                  <div className="rx-form-row">
                    <div className="j-field">
                      <label htmlFor="pt-gender">Gender (optional)</label>
                      <select id="pt-gender" value={patient.gender} onChange={(e) => set('gender', e.target.value as AssistedGender | '')}>
                        <option value="">Not said</option>
                        {ASSISTED_GENDERS.map((g) => <option key={g} value={g}>{g}</option>)}
                      </select>
                    </div>
                    <TextField label="Date of birth (optional)" type="date" value={patient.dateOfBirth} max={istToday()} error={patientErrors.dateOfBirth}
                      onChange={(e) => set('dateOfBirth', e.target.value)} />
                  </div>
                  <p className="ws-muted">If this family member is already on the account with the same name and relation, they are used; otherwise they are added.</p>
                </>
              )}
              {patient.who !== 'self' && (
                <TextField label="Phone owner’s name (optional)" autoComplete="off" value={patient.holderName} maxLength={MAX_PERSON_NAME} error={patientErrors.holderName}
                  hint="Only used the first time your pharmacy books on this number." onChange={(e) => set('holderName', e.target.value)} />
              )}

              <label className="rx-ack">
                <input type="checkbox" checked={agreed} aria-describedby={agreeError ? 'agree-err' : 'agree-text'}
                  onChange={(e) => { setAgreed(e.target.checked); if (e.target.checked) setAgreeError(null); }} />
                Patient agreed to this booking
              </label>
              <span id="agree-text" className="j-field__hint">{CONSENT_STATEMENT}</span>
              {agreeError && <span id="agree-err" className="j-field__error" role="alert">{agreeError}</span>}
            </fieldset>
            {patientDone ? (
              <div className="ws-actions">
                <Badge tone="ok">Patient ready</Badge>
                <Button variant="ghost" disabled={!!review || busy} onClick={() => setPatientDone(false)}>Change patient details</Button>
              </div>
            ) : (
              <div><Button type="submit">Next: choose the doctor</Button></div>
            )}
          </form>
        )}
      </section>

      {patientDone && (
        <section className="ws-section" aria-labelledby="dr-h">
          <h2 id="dr-h">2. Doctor and time</h2>
          <form className="rx-form" noValidate onSubmit={(e) => visitNext(e)}>
            <fieldset className="ws-frozen" disabled={!!review || busy}>
              <div className="rx-form-row">
                <div className="j-field">
                  <label htmlFor="dr-spec">Speciality</label>
                  <select id="dr-spec" value={speciality} onChange={(e) => { setSpeciality(e.target.value); setDoctorId(null); setSlotId(null); }}>
                    <option value="">All</option>
                    {specialities.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div className="j-field">
                  <label htmlFor="dr-mode">How</label>
                  <select id="dr-mode" value={modeFilter} onChange={(e) => { setModeFilter(e.target.value as AssistedMode | ''); setSlotId(null); setMode(''); }}>
                    <option value="">Any</option>
                    {(Object.keys(ASSISTED_MODE_LABEL) as AssistedMode[]).map((m) => <option key={m} value={m}>{ASSISTED_MODE_LABEL[m]}</option>)}
                  </select>
                </div>
                <TextField label="From day" type="date" value={date} min={istToday()} hint={`Free times for ${SLOT_DAYS} days from this day.`}
                  onChange={(e) => { if (e.target.value) { setDate(e.target.value); setSlotId(null); } }} />
              </div>

              {doctors.isPending ? <Loading label="Finding doctors…" />
                : doctors.isError ? <ErrorState message={assistedRefusal(doctors.error).message} onRetry={() => void doctors.refetch()} />
                : doctors.data.length === 0 ? <Empty title="No doctors found">Try another speciality, another way, or another day.</Empty>
                : (
                  <ul className="stock-list" aria-label="Doctors, nearest first">
                    {doctors.data.map((d) => (
                      <li key={d.doctorId} className="ws-section">
                        <div className="stock-head">
                          <h3>{d.name}</h3>
                          {d.specialization && <span>{d.specialization}</span>}
                          {d.nearby === 'pincode' ? <Badge tone="ok">Near you</Badge> : d.nearby === 'city' ? <Badge>Same city</Badge> : null}
                          <strong>{d.feeMinor === 0 ? 'Free' : formatRupees(d.feeMinor / 100)}</strong>
                        </div>
                        <div className="ws-muted">
                          {[d.experienceYears ? `${d.experienceYears} years` : null, d.languages.length ? `Speaks ${d.languages.join(', ')}` : null, d.city]
                            .filter(Boolean).join(' · ')}
                        </div>
                        <div className="ws-actions">
                          <span>{nextWords(d, modeFilter)}</span>
                          {doctorId === d.doctorId ? <Badge tone="ok">Chosen</Badge>
                            : <Button variant="secondary" aria-label={`Choose ${d.name}`} onClick={() => chooseDoctor(d.doctorId)}>Choose</Button>}
                        </div>
                        {doctorId === d.doctorId && (
                          <div className="ws-day">
                            {slots.isPending ? <Loading label="Finding free times…" />
                              : slots.isError ? <ErrorState message={assistedRefusal(slots.error).message} onRetry={() => void slots.refetch()} />
                              : slotDays.length === 0 ? (
                                <span>No free times from {formatSlotDate(slots.data.from)} to {formatSlotDate(slots.data.to)}. Choose a later day or another doctor.</span>
                              ) : slotDays.map(([day, times]) => (
                                <fieldset key={day} className="ws-checks">
                                  <legend>Free times on {formatSlotDate(day)}</legend>
                                  <div className="ws-actions">
                                    {times.map((s) => (
                                      <Button key={s.slotId} variant={slotId === s.slotId ? 'primary' : 'secondary'} aria-pressed={slotId === s.slotId}
                                        aria-label={`${formatSlotDate(day)} ${s.startTime}${s.endTime ? `–${s.endTime}` : ''}`} onClick={() => chooseSlot(s)}>
                                        {s.startTime}{s.endTime ? `–${s.endTime}` : ''}
                                      </Button>
                                    ))}
                                  </div>
                                </fieldset>
                              ))}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              {visitErrors.doctor && <span className="j-field__error" role="alert">{visitErrors.doctor}</span>}
              {visitErrors.slot && <span className="j-field__error" role="alert">{visitErrors.slot}</span>}

              {slot && (
                <>
                  <fieldset className="ws-checks">
                    <legend>How does the consultation happen?</legend>
                    {modes.map((m) => (
                      <label key={m} className="ws-check">
                        <input type="radio" name="mode" checked={mode === m} onChange={() => { setMode(m); if (m === 'in-person') setJoinOn(''); }} />
                        {ASSISTED_MODE_LABEL[m]}
                      </label>
                    ))}
                    {visitErrors.mode && <span className="j-field__error" role="alert">{visitErrors.mode}</span>}
                  </fieldset>
                  {mode && mode !== 'in-person' && (
                    <fieldset className="ws-checks">
                      <legend>Where does the patient join?</legend>
                      <label className="ws-check">
                        <input type="radio" name="join" checked={joinOn === 'partner_device'} onChange={() => setJoinOn('partner_device')} />
                        {mode === 'call' ? 'The doctor calls this pharmacy (the patient stays with you)' : 'On this pharmacy’s device'}
                      </label>
                      <label className="ws-check">
                        <input type="radio" name="join" checked={joinOn === 'patient_phone'} onChange={() => setJoinOn('patient_phone')} />
                        On the patient’s own phone
                      </label>
                      {visitErrors.joinOn && <span className="j-field__error" role="alert">{visitErrors.joinOn}</span>}
                    </fieldset>
                  )}
                  {mode === 'call' && joinOn === 'patient_phone' && (
                    <TextField label="Number the doctor should call (optional)" inputMode="tel" autoComplete="off" value={joinPhone} error={visitErrors.joinPhone}
                      hint="Leave empty to use the patient’s mobile number above." onChange={(e) => setJoinPhone(e.target.value)} />
                  )}
                  <div className="rx-form-row">
                    <div className="j-field">
                      <label htmlFor="pt-lang">Language the patient speaks</label>
                      <select id="pt-lang" value={language} aria-invalid={visitErrors.language ? true : undefined}
                        aria-describedby={visitErrors.language ? 'pt-lang-err' : undefined} onChange={(e) => setLanguage(e.target.value)}>
                        <option value="">Choose…</option>
                        {PATIENT_LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
                      </select>
                      {visitErrors.language && <span id="pt-lang-err" className="j-field__error" role="alert">{visitErrors.language}</span>}
                    </div>
                    <TextField label="Coupon code (optional)" value={coupon} error={visitErrors.coupon} maxLength={50}
                      hint="Only if the patient has one." onChange={(e) => setCoupon(e.target.value)} />
                  </div>
                  <TextArea label="What is the problem? (optional)" autoComplete="off" value={concern} maxLength={MAX_CONCERN} error={visitErrors.concern}
                    hint="A few words for the doctor, for example “fever for 3 days”." onChange={(e) => setConcern(e.target.value)} />
                </>
              )}
            </fieldset>
            {refused && !review && <Alert>{refusalText(refused)}</Alert>}
            {!review && <div><Button type="submit">Next: check the price</Button></div>}
          </form>
        </section>
      )}

      {review && (
        <ReviewAndPay pharmacyId={pharmacyId} review={review} busy={busy} refused={refused}
          method={method} cardOff={cardOff} onMethod={(m) => { setMethod(m); if (refused?.kind === 'card') setRefused(null); }}
          onPay={() => void pay()} onBack={() => { setReview(null); setRefused(null); }}
          onNewPrice={payAtNewPrice} />
      )}
    </>
  );
}

function ReviewAndPay({ pharmacyId, review, busy, refused, method, cardOff, onMethod, onPay, onBack, onNewPrice }: {
  pharmacyId: string;
  review: { requestKey: string } & PendingBooking;
  busy: boolean;
  refused: Refusal | null;
  method: PayMethod;
  cardOff: string | null;
  onMethod: (m: PayMethod) => void;
  onPay: () => void;
  onBack: () => void;
  onNewPrice: (priceMinor: number) => void;
}) {
  const wallet = useWallet(pharmacyId);
  const s = review.summary;
  const balance = walletBalancePaise(wallet.data);
  const hold = walletHoldWords(wallet.data);
  const short = wallet.data !== undefined && walletState(wallet.data) === 'ok' && balance < s.priceMinor;
  const [showTopUp, setShowTopUp] = useState(false);
  const needTopUp = short || refused?.kind === 'topup';
  // WQ16: card or UPI only when there is something to pay; the wallet path below stays as it was.
  const offerCard = s.priceMinor > 0;
  const byCard = offerCard && method === 'razorpay' && !cardOff;

  return (
    <section className="ws-section" aria-labelledby="pay-h">
      <h2 id="pay-h">3. Check and pay</h2>
      <div className="confirm" role="group" aria-label="Check and pay">
        <SummaryList s={s} />
        {s.couponCode && !s.couponChecked && <p className="ws-muted">Price before the coupon; the coupon is checked when you pay.</p>}
        <p><strong>How the patient joins:</strong> {joinWords(s.mode, s.joinOn)}</p>
        {offerCard && (
          <fieldset className="ws-checks" disabled={busy}>
            <legend>How do you pay?</legend>
            <label className="ws-check">
              <input type="radio" name="pay-method" checked={!byCard} onChange={() => onMethod('wallet')} />
              Pay from wallet
            </label>
            <label className="ws-check">
              <input type="radio" name="pay-method" checked={byCard} disabled={!!cardOff} aria-describedby={cardOff ? 'card-off' : undefined} onChange={() => onMethod('razorpay')} />
              Pay by card or UPI
            </label>
            {cardOff && <span id="card-off" className="j-field__hint">{cardOff}</span>}
          </fieldset>
        )}
        {byCard ? (
          <>
            {refused && <Alert>{refusalText(refused, s.couponCode)}{refused.kind === 'price' && refused.priceMinor !== undefined && (
              <> <Button variant="secondary" onClick={() => onNewPrice(refused.priceMinor!)}>Use the new price ({formatRupees(refused.priceMinor / 100)})</Button></>
            )}</Alert>}
            <span className="ws-muted">
              Collect {formatRupees(s.priceMinor / 100)} from the patient at your counter. You pay it on the Razorpay page next. The time is held for 30
              minutes while you pay. If the booking is cancelled later, the money goes back to the card or UPI, or to your wallet if you choose.
            </span>
            <div className="confirm-actions">
              <Button busy={busy} disabled={refused?.kind === 'price'} onClick={onPay}>Pay {formatRupees(s.priceMinor / 100)} by card or UPI</Button>
              <Button variant="ghost" disabled={busy} onClick={onBack}>Back</Button>
            </div>
          </>
        ) : (<>
        {wallet.isPending ? <Loading label="Reading your wallet…" />
          : wallet.isError ? <ErrorState message={assistedRefusal(wallet.error).message} onRetry={() => void wallet.refetch()} />
          : (
            <p>
              Money in your wallet: <strong>{formatRupees(balance / 100)}</strong>
              {!hold && !short ? <> · After this booking: {formatRupees((balance - s.priceMinor) / 100)}</> : null}
            </p>
          )}
        {hold && <Alert tone="warn">{hold}</Alert>}
        {refused && (
          <Alert>
            {refusalText(refused, s.couponCode)}
            {refused.kind === 'price' && refused.priceMinor !== undefined && (
              <> <Button variant="secondary" onClick={() => onNewPrice(refused.priceMinor!)}>Use the new price ({formatRupees(refused.priceMinor / 100)})</Button></>
            )}
          </Alert>
        )}
        {needTopUp && !hold && (
          <Alert tone="warn">
            {short ? `Your wallet needs ${formatRupees((s.priceMinor - balance) / 100)} more for this booking.` : 'Your wallet needs more money for this booking.'}
            {' '}<Button variant="secondary" onClick={() => setShowTopUp(true)}>Top up now</Button>{' '}
            or open the <Link to="/pharmacy/wallet">Wallet</Link> page (this booking is not kept if you leave).
          </Alert>
        )}
        {showTopUp && <TopUpForm pharmacyId={pharmacyId} suggested={Math.max(1, (s.priceMinor - balance) / 100)} onCredited={() => void wallet.refetch()} />}
        <span className="ws-muted">Collect {formatRupees(s.priceMinor / 100)} from the patient at your counter. If the booking is cancelled, the money comes back to your wallet.</span>
        <div className="confirm-actions">
          <Button busy={busy} disabled={!!hold || short || (refused?.kind === 'price')} onClick={onPay}>Pay {formatRupees(s.priceMinor / 100)} from wallet</Button>
          <Button variant="ghost" disabled={busy} onClick={onBack}>Back</Button>
        </div>
        </>)}
      </div>
    </section>
  );
}
