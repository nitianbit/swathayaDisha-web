import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  ASSISTED_MODE_LABEL, isCardAnswer, routeCardAnswer, CONSENT_STATEMENT_LANGUAGE,
  formatSlotDate, isSwitchedOff, istToday, joinWords, nextFreeSlot, supportedModes,
  patientBody, SWITCHED_OFF_MESSAGE, type AssistedCardPayment, type AssistedDoctor, type AssistedMode, type AssistedSlot, type BookedConsultation, type BookerKind,
  type ByKeyAnswer, type ConsultationReceipt, type ConsultationRequest, type JoinOn, type Refusal,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, formatRupees, Loading, TextField } from '@jansetu/ui';
import { PageHeading } from '../../PageHeading.tsx';
import { newRequestKey, type PendingOp } from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { useOneAtATime } from '../finance/finance.tsx';
import {
  CardDueSection, CardPaymentPanel, consultationCardSource, isOrderFailed, NOT_PAYABLE_WORDS, NotBooked, ORDER_FAILED_WORDS, useCardBookings, useCardChoice,
} from './cardBooking.tsx';
import { ConsultExtras, consultExtrasProblems, couponOf, EMPTY_EXTRAS, EMPTY_JOIN, JoinFields, joinOf, joinProblems, type ConsultExtrasDraft, type JoinDraft } from './bookingFields.tsx';
import { PatientSection, usePatientStep } from './patientStep.tsx';
import { SlotDays } from './slotDays.tsx';
import { useAssistedCreate } from './assistedCreate.ts';
import { UnconfirmedBooking } from './unconfirmedBooking.tsx';
import { PayChoice, refusalText, type PayWallet } from './walletPay.tsx';
import { usePharmacyId } from './ownedOp.tsx';
import { pharmacyConsultBooker, type ConsultBooker } from './consultBooker.ts';
import { t } from '../../i18n/pharmacy/index.ts';

/**
 * WQ12: a pharmacy books a doctor consultation for a walk-in patient (assisted booking phase 1a, §19.3):
 * the patient by phone (`POST /pharmacy-assisted/patients/lookup`: the masked holder name only), the "patient agreed"
 * tick, the doctor (`GET /pharmacy-assisted/doctors`, nearby first) and time (`GET …/doctors/:id/slots`), then the price and the wallet, and one
 * keyed create (`POST /pharmacy-assisted/consultations`, paid from the wallet). The phone stays in this page's state and
 * in POST bodies: never in the address, storage or logs.
 * WQ16 (r10 phase 1b, §23.3): or paid by card or UPI (`paymentMethod: 'razorpay'`: the same body, key and owned request);
 * the booking is then held until its `payBy` and paid on its one Razorpay order (`cardBooking.tsx`).
 * WQ24 (r21): the same screen books for a lab member (`BookConsultation` with the lab's `ConsultBooker`): its branch,
 * its routes, its wallet and its card payment routes.
 */
export function BookConsultationScreen() {
  const pharmacyId = usePharmacyId();
  const { api } = useSession();
  return (
    <>
      <PageHeading title={t('bookConsultation.bookConsultation')}>{t('bookConsultation.bookADoctorForA')}</PageHeading>
      <BookConsultation key={pharmacyId} booker={pharmacyConsultBooker(api, pharmacyId)} />
    </>
  );
}

/** What the screen shows about a booking being sent (kept in session memory with the request, never in storage). */
interface Summary { patient: string; doctor: string; date: string; time: string; mode: AssistedMode; joinOn?: JoinOn; priceMinor: number; couponCode?: string;
  /** The price came from the server's answer with the coupon applied (PRICE_CHANGED), not from the doctor's fee. */
  couponChecked?: boolean;
  /** WQ24: the lab branch it is booked at (labs only). */
  branch?: string;
  /** WQ24: who books (absent: a pharmacy, as before). */
  org?: BookerKind }
interface PendingBooking { request: ConsultationRequest; summary: Summary }
interface Done { summary: Summary; ref?: string; paidMinor?: number; replayed: boolean; newAccount?: boolean; paidBy?: 'wallet' | 'card'; note?: string }
/** WQ16: a card booking held until it is paid (or its time is released). */
interface CardDue { bookingId: string; requestKey: string; order: AssistedCardPayment | null; summary: Summary; ref?: string; newAccount?: boolean; autoOpen: boolean }
type PayMethod = ConsultationRequest['paymentMethod'];

/** How many days of one doctor's free times are shown at once (the slots read allows 1–14). */
const SLOT_DAYS = 7;
const describeWhen = (s: Summary) => `${formatSlotDate(s.date)} at ${s.time}`;

function SummaryList({ s }: { s: Summary }) {
  const org = s.org ?? 'pharmacy';
  return (
    <ul className="ws-list">
      <li>{t('common.patient')}<strong>{s.patient}</strong></li>
      {s.branch && <li>{t('bookConsultation.bookedAt')}<strong>{s.branch}</strong></li>}
      <li>{t('common.doctor')}<strong>{s.doctor}</strong></li>
      <li>{t('common.when2')}<strong>{describeWhen(s)}</strong></li>
      <li>{t('common.how2')}<strong>{ASSISTED_MODE_LABEL[s.mode]}</strong>{s.mode !== 'in-person' && s.joinOn ? t('bookConsultation.joinsOn', { where: s.joinOn === 'partner_device' ? t(`bookConsultation.onThisDevice.${org}`) : t('bookConsultation.onThePatientsPhone') }) : ''}</li>
      <li>{t('common.price')}<strong>{formatRupees(s.priceMinor / 100)}</strong>{s.couponCode ? ` (coupon ${s.couponCode})` : ''}</li>
    </ul>
  );
}

function doneFromReceipt(r: ConsultationReceipt, summary: Summary): Done {
  return { summary, ref: r.booking.assisted?.shortRef, paidMinor: r.funding?.amountMinor, replayed: r.replayed, newAccount: r.newAccount,
    paidBy: r.funding?.method === 'razorpay' ? 'card' : 'wallet' };
}
function summaryOf(b: BookedConsultation, summary: Summary | undefined, org: BookerKind): Summary {
  return summary ?? {
    patient: b.patientName ?? t('common.thePatient'), doctor: b.doctorName ?? t('common.theDoctor'), date: b.bookingDate ?? '', time: b.bookingTime ?? '',
    mode: (b.consultationMode as AssistedMode) ?? 'video', joinOn: b.assisted?.join?.on, priceMinor: Math.round(Number(b.price ?? 0) * 100),
    ...(org === 'pharmacy' ? {} : { org }),
  };
}
function doneFromView(b: BookedConsultation, summary: Summary | undefined, org: BookerKind, paidBy: Done['paidBy'] = 'wallet'): Done {
  return { summary: summaryOf(b, summary, org), ref: b.assisted?.shortRef, paidMinor: typeof b.price === 'number' ? Math.round(b.price * 100) : undefined, replayed: true, paidBy };
}

/** The doctor card's next time: only one the time list would show (a chat-only next time is left out, as in the list). */
function nextWords(d: AssistedDoctor, modeFilter: AssistedMode | ''): string {
  const next = nextFreeSlot(d, modeFilter);
  if (next) return t('bookConsultation.nextFreeTimeAt', { when: formatSlotDate(next.date), startTime: next.startTime });
  return d.nextSlot ? t('bookConsultation.chooseToSeeTheFree') : t('bookConsultation.noFreeTimesSoon');
}


/** The booking flow, for a pharmacy or (WQ24) a lab member: `booker` gives the routes, keys, wallet and words. */
export function BookConsultation({ booker }: { booker: ConsultBooker }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const assisted = booker.api;
  const org = booker.kind;
  const pharmacyId = booker.id;
  const { perform, busy } = useOneAtATime('booking');
  const [off, setOff] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // WQ16: card or UPI.
  const cards = useCardBookings(pharmacyId);
  const choice = useCardChoice();
  const { method, setMethod, cardOff } = choice;
  const [cardDue, setCardDue] = useState<CardDue | null>(null);
  /** card-last: the card payment is being confirmed (only "Check payment" is offered then). */
  const [cardHeld, setCardHeld] = useState(false);
  /** The booking could not be made or paid after all (a late payment refunded, the time released): said once. */
  const [ended, setEnded] = useState<string | null>(null);
  /** 502 RAZORPAY_ORDER_CREATION_FAILED: the booking is held; the same request again gets the payment page. */
  const [orderFailed, setOrderFailed] = useState(false);

  // WQ17b: the keyed create, shared with Book lab test (`assistedCreate.ts`); the card branches plug into its answers.
  const create = useAssistedCreate<PendingBooking, ConsultationReceipt, ByKeyAnswer>({
    slot: `assisted-book:${pharmacyId}`, perform, book: (request) => assisted.book(request), abandon: (key) => assisted.abandon(key), refusal: booker.refusal,
    walletKey: booker.wallet.queryKey, refreshKeys: [booker.bookingsKey, booker.doctorsKey],
    onReceipt: (r, p) => afterReceipt(r, p.requestKey, p.body.summary),
    onUsed: (r, p, restored) => afterUsed(r, p, restored),
    onOff: () => setOff(true),
    onNotice: setNotice,
    onResult: (r) => setOrderFailed(r.kind === 'unknown' && isOrderFailed(r.error)),
    onRefusedBeforeWriting: (why, err) => { if (why.kind === 'card') cardRefused(err); },
    onRefused: (why, err) => {
      // WQ16: card or UPI cannot pay this booking: the review stays, with the wallet; paying again is a new request.
      if (why.kind === 'card') { cardRefused(err); create.rotateKey(); return; }
      if (why.kind === 'slot' || why.kind === 'doctor') {
        setReview(null);
        setSlotId(null);
        void doctors.refetch();
        void slots.refetch();
      }
    },
  });
  const { op, settle, review, setReview, refused, setRefused, resendError, setResendError, givingUp } = create;
  const refreshAfterBooking = create.refresh;

  // Step 1: the patient (WQ17: the shared step, `patientStep.tsx`).
  const pt = usePatientStep({ pharmacyId, perform, booker, onFind: () => setNotice(null), onSwitchedOff: () => setOff(true),
    onChangePhone: () => { setReview(null); setRefused(null); } });
  const { lookup, patient, patientDone, patientLabel } = pt;

  // Step 2: the doctor and the time. WQ24: a lab books at one of its branches (chosen at once when it has one).
  const branches = booker.branches;
  const [chosenBranch, setChosenBranch] = useState<string | null>(() => (branches?.length === 1 ? branches[0]!.id : null));
  const branch = branches?.find((b) => b.id === chosenBranch) ?? null;
  const branchId = branch?.id ?? null;
  const branchPart = branchId ? { branchId } : {};
  const branchReady = !branches || !!branchId;
  const [speciality, setSpeciality] = useState('');
  const [modeFilter, setModeFilter] = useState<AssistedMode | ''>('');
  const [date, setDate] = useState(() => istToday());
  const [doctorId, setDoctorId] = useState<string | null>(null);
  const [slotId, setSlotId] = useState<string | null>(null);
  const [mode, setMode] = useState<AssistedMode | ''>('');
  const [join, setJoin] = useState<JoinDraft>(EMPTY_JOIN);
  const [extras, setExtras] = useState<ConsultExtrasDraft>(EMPTY_EXTRAS);
  const [visitErrors, setVisitErrors] = useState<Record<string, string>>({});

  // Step 3: check and pay.
  const [done, setDone] = useState<Done | null>(null);

  function resetAll() {
    pt.reset(); setDoctorId(null); setSlotId(null); setMode(''); setJoin(EMPTY_JOIN); setExtras(EMPTY_EXTRAS);
    setVisitErrors({}); setReview(null); setRefused(null); setDone(null); setNotice(null);
    setCardDue(null); setEnded(null); setMethod('wallet');
    // A transient 503 while a booking was held must not stay as "switched off": the doctor reads' kept errors are cleared
    // too, so only the next doctor read says it again if the service really is off.
    setOff(false);
    void queryClient.resetQueries({ queryKey: booker.doctorsKey });
  }

  // The doctor list: nearby first (the pharmacy's pincode, then its city; a lab's branch); that day's free times.
  const doctorsKey = [...booker.doctorsKey, ...(branchId ? [branchId] : [])];
  const doctors = useQuery({
    queryKey: [...doctorsKey, speciality, modeFilter],
    queryFn: () => assisted.doctors({ ...branchPart, ...(speciality ? { speciality } : {}), ...(modeFilter ? { mode: modeFilter } : {}), limit: 50 }),
    enabled: patientDone && !off && branchReady,
  });
  // The chosen doctor's free times for a week from the chosen day (`GET /pharmacy-assisted/doctors/:id/slots`).
  const slots = useQuery({
    queryKey: [...doctorsKey, 'slots', doctorId, modeFilter, date],
    queryFn: () => assisted.doctorSlots(doctorId!, { ...branchPart, from: date, days: SLOT_DAYS, ...(modeFilter ? { mode: modeFilter } : {}) }),
    enabled: patientDone && !off && !!doctorId && branchReady,
  });
  const allDoctors = useQuery({
    queryKey: [...doctorsKey, 'specialities'],
    queryFn: () => assisted.doctors({ ...branchPart, limit: 100 }),
    enabled: patientDone && !off && branchReady,
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

  function chooseDoctor(id: string) { setDoctorId(id); setSlotId(null); setMode(''); setJoin(EMPTY_JOIN); setVisitErrors({}); setRefused(null); }
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
    if (!branchReady) errs.branch = t('bookConsultation.chooseTheBranchThePatient');
    else if (!doctor) errs.doctor = t('bookConsultation.chooseADoctor');
    else if (!slot) errs.slot = t('common.chooseATime');
    else if (!mode) errs.mode = t('bookConsultation.chooseHowTheConsultationHappens');
    if (mode) Object.assign(errs, joinProblems(mode, join));
    Object.assign(errs, consultExtrasProblems(extras));
    const code = couponOf(extras);
    setVisitErrors(errs);
    if (Object.keys(errs).length || !doctor || !slot || !mode || !lookup) return;
    // The fee as the doctor's own slot read says (fresher than the list); the server still fences it (PRICE_CHANGED).
    const price = priceMinor ?? slots.data?.doctor.feeMinor ?? doctor.feeMinor;
    // The "number to call" field is shown (and sent) only for a phone call on the patient's phone.
    const joinBody = joinOf(mode, join);
    const concern = extras.concern;
    const requestKey = newRequestKey();
    const request: ConsultationRequest = {
      requestKey, phone: lookup.phone, ...patientBody({ ...patient, phone: lookup.phone }),
      consent: { agreed: true, statementVersion: booker.consent.version, statementLanguage: CONSENT_STATEMENT_LANGUAGE },
      preferredLanguage: extras.language, slotId: slot.slotId, consultationMode: mode, ...(joinBody ? { join: joinBody } : {}),
      ...(code ? { couponCode: code } : {}), acceptedPriceMinor: price, ...(concern.trim() ? { primaryConcern: concern.trim() } : {}),
      paymentMethod: 'wallet', ...branchPart,
    };
    setReview({
      requestKey, request,
      summary: { patient: patientLabel(), doctor: doctor.name, date: slot.date, time: slot.startTime, mode, ...(joinBody ? { joinOn: joinBody.on } : {}), priceMinor: price,
        ...(code ? { couponCode: code } : {}), ...(branch ? { branch: branch.name } : {}), ...(org === 'pharmacy' ? {} : { org }) },
    });
  }

  const cardRefused = choice.refused;

  /** WQ16: what a create (or its replay) answered: a wallet booking is done; a card booking waits for its payment. */
  function afterReceipt(r: ConsultationReceipt, requestKey: string, summary: Summary) {
    const card = r.funding?.method === 'razorpay';
    if (card) cards.remember(r.booking._id, requestKey);
    routeCardAnswer('consultation', { card, booking: r.booking, order: r.payment ?? null }, null, {
      done: () => setDone(doneFromReceipt(r, summary)),
      due: (order) => setCardDue({ bookingId: r.booking._id, requestKey, order, summary, ref: r.booking.assisted?.shortRef, newAccount: r.newAccount, autoOpen: !!order }),
      ended: () => { cards.forget(r.booking._id); setEnded(NOT_PAYABLE_WORDS()); },
    });
  }

  /**
   * A by-key answer `used` (the check, or a give-up that found it). A card booking (`payment` present) waits for its
   * payment; one still without its order (502 at create) needs the same request again, so the request stays stored.
   * Answers null once settled, or what is still to do (WQ21 L1: `routeCardAnswer`, shared with Book lab test).
   */
  function afterUsed(r: { booking: BookedConsultation; payment?: AssistedCardPayment | null }, p: PendingOp<PendingBooking>, restored: boolean): string | null {
    const summary = restored ? undefined : p.body?.summary;
    const b = r.booking;
    return routeCardAnswer('consultation', { card: isCardAnswer(r), booking: b, order: r.payment ?? null }, { restored }, {
      settle: () => { settle(p.requestKey); setReview(null); refreshAfterBooking(); },
      done: (card) => { if (card) cards.remember(b._id, p.requestKey); setDone(doneFromView(b, summary, org, card ? 'card' : 'wallet')); },
      due: (order) => {
        cards.remember(b._id, p.requestKey);
        setCardDue({ bookingId: b._id, requestKey: p.requestKey, order, summary: summaryOf(b, summary, org), ref: b.assisted?.shortRef, autoOpen: false });
      },
      ended: () => setEnded(NOT_PAYABLE_WORDS()),
    });
  }

  /** WQ16: the chosen way to pay goes in the same body (a free consultation is always booked with the wallet method). */
  const pay = () => create.pay((p) => ({ ...p, request: { ...p.request, paymentMethod: choice.methodFor(p.summary.priceMinor) } }));

  // An unconfirmed booking stays on screen while it is resent or given up (its first attempt shows the review busy).
  if (op && !(busy && !givingUp && op.attempts === 1 && !op.uncertain)) {
    return (
      <UnconfirmedBooking op={op} what={t('bookConsultation.booking')} busy={busy} givingUp={givingUp} resendError={resendError} byKey={() => assisted.byKey(op.requestKey)}
        onUsed={(r, restored) => afterUsed(r, op, restored)}
        onAbandoned={() => create.abandonedByCheck(op.requestKey)}
        onResend={() => { setResendError(null); void create.send(op).catch((err: unknown) => setResendError(booker.refusal(err).message)); }}
        onGiveUp={() => void create.giveUp(op)}
        extra={orderFailed && (
          <Alert tone="warn">{ORDER_FAILED_WORDS()}</Alert>
        )}
        summary={op.body && <SummaryList s={op.body.summary} />} />
    );
  }

  if (ended) {
    return <NotBooked words={ended} againLabel={t('bookConsultation.bookAnotherConsultation')} onAgain={resetAll} listPath={booker.paths.list} listLabel={t('bookConsultation.seeBookedConsultations')} />;
  }

  if (cardDue) {
    const due = cardDue;
    return (
      <CardDueSection bookingRef={due.ref} summary={<SummaryList s={due.summary} />} newAccount={due.newAccount} listPath={booker.paths.list}
        listLabel={t('bookConsultation.seeBookedConsultations')} held={cardHeld}>
        <CardPaymentPanel key={due.bookingId} source={consultationCardSource(api, due.bookingId, due.requestKey, booker)} order={due.order}
          amountMinor={due.summary.priceMinor} perform={perform} busy={busy}
          autoOpen={due.autoOpen} onHeld={setCardHeld}
          onPaid={(_b, note) => { setCardDue(null); setDone({ summary: due.summary, ref: due.ref, paidMinor: due.order?.amountMinor ?? due.summary.priceMinor, replayed: false, newAccount: due.newAccount, paidBy: 'card', ...(note ? { note } : {}) }); refreshAfterBooking(); }}
          onEnded={(words) => { cards.forget(due.bookingId); setCardDue(null); setEnded(words); refreshAfterBooking(); }} />
      </CardDueSection>
    );
  }

  if (done) {
    const byCard = done.paidBy === 'card';
    return (
      <section className="ws-section" aria-labelledby="done-h">
        <h2 id="done-h">{done.replayed ? t('common.alreadyBooked') : 'Booked'}</h2>
        <Alert tone="ok">
          {done.replayed ? t('common.thisBookingWasAlreadyMade')
            : byCard ? t('bookConsultation.theConsultationIsBookedAnd') : t('bookConsultation.theConsultationIsBookedAnd2')}
          {done.ref ? <>{t('common.bookingReference')}<strong>{done.ref}</strong>.</> : null}
        </Alert>
        {done.note && <Alert tone="warn">{done.note}</Alert>}
        <SummaryList s={done.summary} />
        {done.paidMinor !== undefined && <p>{byCard ? t('common.paidByCardOrUpi') : t('common.paidFromYourWallet')}: <strong>{formatRupees(done.paidMinor / 100)}</strong>{t('common.collectThisFromThePatient')}</p>}
        <p><strong>{t('bookConsultation.howThePatientJoins')}</strong> {joinWords(done.summary.mode, done.summary.joinOn, org)}</p>
        {done.newAccount && <p className="ws-muted">{t('common.thisNumberWasNewTo')}</p>}
        <div className="ws-actions">
          <Button onClick={resetAll}>{t('bookConsultation.bookAnotherConsultation')}</Button>
          <Link to={booker.paths.list}>{t('bookConsultation.seeBookedConsultations')}</Link>
        </div>
      </section>
    );
  }

  // WQ24b re-check: after the booking states. A background doctor read answering 503 or a code-less 404 (a proxy during
  // a deploy) reads as "switched off"; it never replaces a booking held for its card payment, or one already made.
  if (off) {
    return (
      <Alert tone="warn">
        {SWITCHED_OFF_MESSAGE}{t(`bookConsultation.turnsItOnFor.${org}`)}</Alert>
    );
  }

  const frozenPatient = patientDone || !!review || busy;
  return (
    <>
      {notice && <Alert tone="ok">{notice}</Alert>}

      <PatientSection step={pt} busy={busy} frozen={frozenPatient} locked={!!review || busy} booker={org} consent={booker.consent.statement} />
      {patientDone && (
        <section className="ws-section" aria-labelledby="dr-h">
          <h2 id="dr-h">{t('bookConsultation.n2DoctorAndTime')}</h2>
          <form className="rx-form" noValidate onSubmit={(e) => visitNext(e)}>
            <fieldset className="ws-frozen" disabled={!!review || busy}>
              {branches && (
                branches.length === 0 ? <Alert>{t('bookConsultation.yourAccountHasNoBranch')}</Alert>
                  : branches.length > 1 && (
                    <div className="j-field">
                      <label htmlFor="dr-branch">{t('bookConsultation.branchThePatientIsAt')}</label>
                      <select id="dr-branch" value={chosenBranch ?? ''} aria-invalid={visitErrors.branch ? true : undefined}
                        aria-describedby={visitErrors.branch ? 'dr-branch-err' : undefined}
                        onChange={(e) => { setChosenBranch(e.target.value || null); setDoctorId(null); setSlotId(null); setMode(''); }}>
                        <option value="">{t('common.choose3')}</option>
                        {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                      </select>
                      {visitErrors.branch && <span id="dr-branch-err" className="j-field__error" role="alert">{visitErrors.branch}</span>}
                    </div>
                  )
              )}
              <div className="rx-form-row">
                <div className="j-field">
                  <label htmlFor="dr-spec">{t('bookConsultation.speciality')}</label>
                  <select id="dr-spec" value={speciality} onChange={(e) => { setSpeciality(e.target.value); setDoctorId(null); setSlotId(null); }}>
                    <option value="">{t('common.all')}</option>
                    {specialities.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div className="j-field">
                  <label htmlFor="dr-mode">{t('common.how')}</label>
                  <select id="dr-mode" value={modeFilter} onChange={(e) => { setModeFilter(e.target.value as AssistedMode | ''); setSlotId(null); setMode(''); }}>
                    <option value="">{t('bookConsultation.any')}</option>
                    {(Object.keys(ASSISTED_MODE_LABEL) as AssistedMode[]).map((m) => <option key={m} value={m}>{ASSISTED_MODE_LABEL[m]}</option>)}
                  </select>
                </div>
                <TextField label={t('common.fromDay')} type="date" value={date} min={istToday()} hint={t('common.freeTimesForDaysFrom', { SLOT_DAYS })}
                  onChange={(e) => { if (e.target.value) { setDate(e.target.value); setSlotId(null); } }} />
              </div>

              {!branchReady ? <span className="ws-muted">{t('bookConsultation.chooseTheBranchFirstDoctors')}</span>
                : doctors.isPending ? <Loading label={t('common.findingDoctors')} />
                : doctors.isError ? <ErrorState message={booker.refusal(doctors.error).message} onRetry={() => void doctors.refetch()} />
                : doctors.data.length === 0 ? <Empty title={t('bookConsultation.noDoctorsFound')}>{t('bookConsultation.tryAnotherSpecialityAnotherWay')}</Empty>
                : (
                  <ul className="stock-list" aria-label={t('bookConsultation.doctorsNearestFirst')}>
                    {doctors.data.map((d) => (
                      <li key={d.doctorId} className="ws-section">
                        <div className="stock-head">
                          <h3>{d.name}</h3>
                          {d.specialization && <span>{d.specialization}</span>}
                          {d.nearby === 'pincode' ? <Badge tone="ok">{t('common.nearYou')}</Badge> : d.nearby === 'city' ? <Badge>{t('common.sameCity')}</Badge> : null}
                          <strong>{d.feeMinor === 0 ? 'Free' : formatRupees(d.feeMinor / 100)}</strong>
                        </div>
                        <div className="ws-muted">
                          {[d.experienceYears ? `${d.experienceYears} years` : null, d.languages.length ? t('bookConsultation.speaks', { value: d.languages.join(', ') }) : null, d.city]
                            .filter(Boolean).join(' · ')}
                        </div>
                        <div className="ws-actions">
                          <span>{nextWords(d, modeFilter)}</span>
                          {doctorId === d.doctorId ? <Badge tone="ok">{t('common.chosen')}</Badge>
                            : <Button variant="secondary" aria-label={t('common.choose4', { name: d.name })} onClick={() => chooseDoctor(d.doctorId)}>{t('common.choose2')}</Button>}
                        </div>
                        {doctorId === d.doctorId && (
                          <div className="ws-day">
                            {slots.isPending ? <Loading label={t('common.findingFreeTimes')} />
                              : slots.isError ? <ErrorState message={booker.refusal(slots.error).message} onRetry={() => void slots.refetch()} />
                              : slotDays.length === 0 ? (
                                <span>{t('bookConsultation.noFreeTimesFrom')}{formatSlotDate(slots.data.from)}{t('common.to')}{formatSlotDate(slots.data.to)}{t('bookConsultation.chooseALaterDayOr')}</span>
                              ) : <SlotDays days={slotDays} chosen={slotId} onChoose={chooseSlot} />}
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
                    <legend>{t('common.howDoesTheConsultationHappen')}</legend>
                    {modes.map((m) => (
                      <label key={m} className="ws-check">
                        <input type="radio" name="mode" checked={mode === m} onChange={() => { setMode(m); if (m === 'in-person') setJoin(EMPTY_JOIN); }} />
                        {ASSISTED_MODE_LABEL[m]}
                      </label>
                    ))}
                    {visitErrors.mode && <span className="j-field__error" role="alert">{visitErrors.mode}</span>}
                  </fieldset>
                  <JoinFields mode={mode} value={join} errors={visitErrors} onChange={setJoin} org={org} />
                  <ConsultExtras value={extras} errors={visitErrors} onChange={setExtras} />
                </>
              )}
            </fieldset>
            {refused && !review && <Alert>{refusalText(refused)}</Alert>}
            {!review && <div><Button type="submit">{t('common.nextCheckThePrice')}</Button></div>}
          </form>
        </section>
      )}

      {review && (
        <ReviewAndPay wallet={booker.wallet} org={org} review={review} busy={busy} refused={refused}
          method={method} cardOff={cardOff} onMethod={(m) => { setMethod(m); if (refused?.kind === 'card') setRefused(null); }}
          onPay={() => void pay()} onBack={() => { setReview(null); setRefused(null); }}
          onNewPrice={create.payAtNewPrice} />
      )}
    </>
  );
}

function ReviewAndPay({ wallet, org, review, busy, refused, method, cardOff, onMethod, onPay, onBack, onNewPrice }: {
  wallet: PayWallet;
  org: BookerKind;
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
  const s = review.summary;
  return (
    <section className="ws-section" aria-labelledby="pay-h">
      <h2 id="pay-h">{t('common.n3CheckAndPay')}</h2>
      <div className="confirm" role="group" aria-label={t('common.checkAndPay')}>
        <SummaryList s={s} />
        {s.couponCode && !s.couponChecked && <p className="ws-muted">{t('common.priceBeforeTheCouponThe')}</p>}
        <p><strong>{t('bookConsultation.howThePatientJoins')}</strong> {joinWords(s.mode, s.joinOn, org)}</p>
        <PayChoice wallet={wallet} priceMinor={s.priceMinor} couponCode={s.couponCode} refused={refused} busy={busy} method={method} cardOff={cardOff}
          onMethod={onMethod} onPay={onPay} onBack={onBack} onNewPrice={onNewPrice} />
      </div>
    </section>
  );
}
