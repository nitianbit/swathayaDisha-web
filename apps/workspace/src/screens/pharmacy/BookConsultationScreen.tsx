import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  ASSISTED_MODE_LABEL, assistedRefusal, isCardAnswer, routeCardAnswer, CONSENT_STATEMENT_LANGUAGE,
  CONSENT_STATEMENT_VERSION, formatSlotDate, isSwitchedOff, istToday, joinWords, nextFreeSlot, supportedModes,
  patientBody, pharmacyAssistedApi, SWITCHED_OFF_MESSAGE, type AssistedCardPayment, type AssistedDoctor, type AssistedMode, type AssistedSlot, type BookedConsultation,
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
import { PayChoice, refusalText } from './walletPay.tsx';
import { usePharmacyId } from './ownedOp.tsx';

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
interface Done { summary: Summary; ref?: string; paidMinor?: number; replayed: boolean; newAccount?: boolean; paidBy?: 'wallet' | 'card'; note?: string }
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

/** The doctor card's next time: only one the time list would show (a chat-only next time is left out, as in the list). */
function nextWords(d: AssistedDoctor, modeFilter: AssistedMode | ''): string {
  const next = nextFreeSlot(d, modeFilter);
  if (next) return `Next free time: ${formatSlotDate(next.date)} at ${next.startTime}`;
  return d.nextSlot ? 'Choose to see the free times' : 'No free times soon';
}


function Book({ pharmacyId }: { pharmacyId: string }) {
  const { api } = useSession();
  const assisted = pharmacyAssistedApi(api);
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
    slot: `assisted-book:${pharmacyId}`, perform, book: (request) => assisted.book(request), abandon: (key) => assisted.abandon(key), refusal: assistedRefusal,
    walletKey: ['pharmacy-wallet', pharmacyId], refreshKeys: [['pharmacy-bookings', pharmacyId], ['assisted-doctors', pharmacyId]],
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
  const pt = usePatientStep({ pharmacyId, perform, onFind: () => setNotice(null), onSwitchedOff: () => setOff(true),
    onChangePhone: () => { setReview(null); setRefused(null); } });
  const { lookup, patient, patientDone, patientLabel } = pt;

  // Step 2: the doctor and the time.
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
  }

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
    if (!doctor) errs.doctor = 'Choose a doctor.';
    else if (!slot) errs.slot = 'Choose a time.';
    else if (!mode) errs.mode = 'Choose how the consultation happens.';
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
      consent: { agreed: true, statementVersion: CONSENT_STATEMENT_VERSION, statementLanguage: CONSENT_STATEMENT_LANGUAGE },
      preferredLanguage: extras.language, slotId: slot.slotId, consultationMode: mode, ...(joinBody ? { join: joinBody } : {}),
      ...(code ? { couponCode: code } : {}), acceptedPriceMinor: price, ...(concern.trim() ? { primaryConcern: concern.trim() } : {}),
      paymentMethod: 'wallet',
    };
    setReview({
      requestKey, request,
      summary: { patient: patientLabel(), doctor: doctor.name, date: slot.date, time: slot.startTime, mode, ...(joinBody ? { joinOn: joinBody.on } : {}), priceMinor: price,
        ...(code ? { couponCode: code } : {}) },
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
      ended: () => { cards.forget(r.booking._id); setEnded(NOT_PAYABLE_WORDS); },
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
      done: (card) => { if (card) cards.remember(b._id, p.requestKey); setDone(doneFromView(b, summary, card ? 'card' : 'wallet')); },
      due: (order) => {
        cards.remember(b._id, p.requestKey);
        setCardDue({ bookingId: b._id, requestKey: p.requestKey, order, summary: summaryOf(b, summary), ref: b.assisted?.shortRef, autoOpen: false });
      },
      ended: () => setEnded(NOT_PAYABLE_WORDS),
    });
  }

  /** WQ16: the chosen way to pay goes in the same body (a free consultation is always booked with the wallet method). */
  const pay = () => create.pay((p) => ({ ...p, request: { ...p.request, paymentMethod: choice.methodFor(p.summary.priceMinor) } }));

  // An unconfirmed booking stays on screen while it is resent or given up (its first attempt shows the review busy).
  if (op && !(busy && !givingUp && op.attempts === 1 && !op.uncertain)) {
    return (
      <UnconfirmedBooking op={op} what="booking" busy={busy} givingUp={givingUp} resendError={resendError} byKey={() => assisted.byKey(op.requestKey)}
        onUsed={(r, restored) => afterUsed(r, op, restored)}
        onAbandoned={() => create.abandonedByCheck(op.requestKey)}
        onResend={() => { setResendError(null); void create.send(op).catch((err: unknown) => setResendError(assistedRefusal(err).message)); }}
        onGiveUp={() => void create.giveUp(op)}
        extra={orderFailed && (
          <Alert tone="warn">{ORDER_FAILED_WORDS}</Alert>
        )}
        summary={op.body && <SummaryList s={op.body.summary} />} />
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
    return <NotBooked words={ended} againLabel="Book another consultation" onAgain={resetAll} listPath="/pharmacy/consultations" listLabel="See booked consultations" />;
  }

  if (cardDue) {
    const due = cardDue;
    return (
      <CardDueSection bookingRef={due.ref} summary={<SummaryList s={due.summary} />} newAccount={due.newAccount} listPath="/pharmacy/consultations"
        listLabel="See booked consultations" held={cardHeld}>
        <CardPaymentPanel key={due.bookingId} source={consultationCardSource(api, due.bookingId, due.requestKey)} order={due.order} amountMinor={due.summary.priceMinor} perform={perform} busy={busy}
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
        <h2 id="done-h">{done.replayed ? 'Already booked' : 'Booked'}</h2>
        <Alert tone="ok">
          {done.replayed ? 'This booking was already made. Nothing was booked or charged twice.'
            : byCard ? 'The consultation is booked and paid by card or UPI.' : 'The consultation is booked and paid from your wallet.'}
          {done.ref ? <> Booking reference: <strong>{done.ref}</strong>.</> : null}
        </Alert>
        {done.note && <Alert tone="warn">{done.note}</Alert>}
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

      <PatientSection step={pt} busy={busy} frozen={frozenPatient} locked={!!review || busy} />
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
                    <legend>How does the consultation happen?</legend>
                    {modes.map((m) => (
                      <label key={m} className="ws-check">
                        <input type="radio" name="mode" checked={mode === m} onChange={() => { setMode(m); if (m === 'in-person') setJoin(EMPTY_JOIN); }} />
                        {ASSISTED_MODE_LABEL[m]}
                      </label>
                    ))}
                    {visitErrors.mode && <span className="j-field__error" role="alert">{visitErrors.mode}</span>}
                  </fieldset>
                  <JoinFields mode={mode} value={join} errors={visitErrors} onChange={setJoin} />
                  <ConsultExtras value={extras} errors={visitErrors} onChange={setExtras} />
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
          onNewPrice={create.payAtNewPrice} />
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
  const s = review.summary;
  return (
    <section className="ws-section" aria-labelledby="pay-h">
      <h2 id="pay-h">3. Check and pay</h2>
      <div className="confirm" role="group" aria-label="Check and pay">
        <SummaryList s={s} />
        {s.couponCode && !s.couponChecked && <p className="ws-muted">Price before the coupon; the coupon is checked when you pay.</p>}
        <p><strong>How the patient joins:</strong> {joinWords(s.mode, s.joinOn)}</p>
        <PayChoice payer={{ kind: 'pharmacy', id: pharmacyId }} priceMinor={s.priceMinor} couponCode={s.couponCode} refused={refused} busy={busy} method={method} cardOff={cardOff}
          onMethod={onMethod} onPay={onPay} onBack={onBack} onNewPrice={onNewPrice} />
      </div>
    </section>
  );
}
