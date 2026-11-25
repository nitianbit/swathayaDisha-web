import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  addressErrors, isCardAnswer, routeCardAnswer, orderFromBooking, branchesFor, CONSENT_STATEMENT_LANGUAGE, formatSlotDate, isSwitchedOff, istToday,
  LAB_SWITCHED_OFF_MESSAGE, LAB_VISIT_MODE_LABEL, labTotalMinor, patientBody, type AssistedLabSlot, type LabAddress, type LabBookingView, type LabByKeyAnswer, type LabCreateRequest, type LabPatientSource, type LabReceipt, type AssistedCardPayment, type AssistedPaymentMethod, type OpenCardOrder, type Refusal,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, formatRupees, Loading, TextField } from '@jansetu/ui';
import { PageHeading } from '../../PageHeading.tsx';
import { newRequestKey } from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { useOneAtATime } from '../finance/finance.tsx';
import { usePharmacyId } from './ownedOp.tsx';
import { useAssistedCreate } from './assistedCreate.ts';
import { SlotDays } from './slotDays.tsx';
import { UnconfirmedBooking } from './unconfirmedBooking.tsx';
import { AddressFields, EMPTY_ADDRESS, labAddressLine, labAddressOf, LanguageSelect } from './bookingFields.tsx';
import { ConsultationPatientSection, PatientSection, useConsultationPatient, usePatientStep } from './patientStep.tsx';
import { PayChoice, WalletPay } from './walletPay.tsx';
import { RecommendedTests, useRecommendedTicks } from './recommendedTests.tsx';
import { CardDueSection, CardPaymentPanel, isOrderFailed, labCardSource, NOT_PAYABLE_WORDS, NotBooked, ORDER_FAILED_WORDS, useCardChoice } from './cardBooking.tsx';
import { pharmacyLabBooker, type LabBooker } from './labBooker.ts';

/**
 * WQ17: a pharmacy books a lab test for a walk-in patient (assisted booking phase 2a, backend r11, design §24.11): the same
 * patient step as Book consultation, then the visit (at the lab or home collection), the lab (nearby first,
 * `GET /pharmacy-assisted/labs`), its branch, the tests (`…/labs/:partnerId/catalogue`), a time (`…/labs/branches/:id/slots`),
 * the price check and one keyed create paid from the wallet (`POST /pharmacy-assisted/lab-bookings`). The phone and the
 * address stay in this page's state and in POST bodies: never in the address bar, storage or logs.
 * WQ25: the same screen for a doctor (`LabBooker`, backend r26): the patient of its own consultation (`fromBookingId`) or a
 * walk-in by phone, paid from the doctor wallet only.
 */
export function BookLabTestScreen() {
  const pharmacyId = usePharmacyId();
  const { api } = useSession();
  return (
    <>
      <PageHeading title="Book lab test">
        Book a lab test for a patient at your counter. Jansetu takes the price from your wallet; you collect it from the patient.
      </PageHeading>
      <BookLabTest key={pharmacyId} booker={pharmacyLabBooker(api, pharmacyId)} />
    </>
  );
}

type Mode = 'lab' | 'home';
interface Summary { patient: string; lab: string; branch: string; mode: Mode; date: string; time: string; tests: string[]; address?: string; priceMinor: number; couponCode?: string;
  couponChecked?: boolean }
interface PendingLab { request: LabCreateRequest; summary: Summary }
/** WQ17b M1: a booking found by its key after a reload: its price is not in the booker view, so none is shown. */
type ShownSummary = Omit<Summary, 'priceMinor'> & { priceMinor?: number };
interface Done { summary: ShownSummary; ref?: string; paidMinor?: number; replayed: boolean; newAccount?: boolean; paidBy?: 'wallet' | 'card'; note?: string }
/** WQ17c: a card lab booking held until it is paid (or its time is released). */
interface CardDue { bookingId: string; requestKey: string; order: OpenCardOrder | null; summary: ShownSummary; ref?: string; newAccount?: boolean; autoOpen: boolean }

const SLOT_DAYS = 7;

function SummaryList({ s }: { s: ShownSummary }) {
  return (
    <ul className="ws-list">
      <li>Patient: <strong>{s.patient}</strong></li>
      <li>Lab: <strong>{s.lab}</strong>, {s.branch}</li>
      <li>Visit: <strong>{LAB_VISIT_MODE_LABEL[s.mode]}</strong>{s.address ? ` at ${s.address}` : ''}</li>
      <li>When: <strong>{formatSlotDate(s.date)} at {s.time}</strong></li>
      <li>Tests: <strong>{s.tests.join(', ')}</strong></li>
      {s.priceMinor !== undefined && <li>Price: <strong>{formatRupees(s.priceMinor / 100)}</strong>{s.couponCode ? ` (coupon ${s.couponCode})` : ''}</li>}
    </ul>
  );
}

function summaryOf(b: LabBookingView, summary: Summary | undefined): ShownSummary {
  return summary ?? {
    patient: b.patientName ?? 'The patient', lab: b.lab?.name ?? 'The lab', branch: b.branch?.name ?? '', mode: (b.visitMode as Mode) ?? 'lab',
    date: b.slot?.date?.replace(/-/g, '') ?? '', time: b.slot?.startTime ?? '', tests: (b.items ?? []).map((i) => i.name),
  };
}
function doneFromView(b: LabBookingView, summary: Summary | undefined): Done {
  return { summary: summaryOf(b, summary), ref: b.assisted?.shortRef, replayed: true, paidBy: b.payment?.method === 'razorpay' ? 'card' : 'wallet' };
}

/** The booking flow of one booker; `fromBookingId` (a doctor's only): the patient of that consultation. */
export function BookLabTest({ booker, fromBookingId }: { booker: LabBooker; fromBookingId?: string }) {
  const { api } = useSession();
  const labsApi = booker.routes;
  const fromConsultation = booker.kind === 'doctor' && !!fromBookingId;
  const { perform, busy } = useOneAtATime('booking');
  const [off, setOff] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  // WQ17c (r14 phase 2b): card or UPI, the consultation's way (`cardBooking.tsx`).
  const choice = useCardChoice();
  const [cardDue, setCardDue] = useState<CardDue | null>(null);
  const [cardHeld, setCardHeld] = useState(false);
  const [ended, setEnded] = useState<string | null>(null);
  const [orderFailed, setOrderFailed] = useState(false);

  // WQ17b: the keyed create, shared with Book consultation (`assistedCreate.ts`).
  const create = useAssistedCreate<PendingLab, LabReceipt, LabByKeyAnswer>({
    slot: booker.slot('book'), perform, book: (request) => labsApi.book(request), abandon: (key) => labsApi.abandon(key), refusal: booker.refusal,
    walletKey: booker.walletKey, refreshKeys: [booker.listKey, booker.labsKey],
    onReceipt: (v, p) => afterReceipt(v, p.requestKey, p.body.summary),
    onUsed: (r, p, restored) => afterUsed(r, p.requestKey, restored ? undefined : p.body?.summary, restored),
    onOff: () => setOff(true),
    onNotice: setNotice,
    onResult: (r) => setOrderFailed(r.kind === 'unknown' && isOrderFailed(r.error)),
    onRefusedBeforeWriting: (why, err) => { if (why.kind === 'card') choice.refused(err); },
    onRefused: (why, err) => {
      if (why.kind === 'card') { choice.refused(err); create.rotateKey(); return; }
      if (why.kind === 'slot') { setReview(null); setSlotId(null); void slots.refetch(); }
      else if (why.kind === 'doctor') { setReview(null); setPartnerId(null); setBranchId(null); setSlotId(null); void labs.refetch(); }
      else if (why.kind === 'patient' || why.kind === 'coupon' || why.kind === 'other' || why.kind === 'limit') void catalogue.refetch();
    },
  });
  const { op, settle, review, setReview, refused, setRefused, resendError, setResendError, givingUp } = create;

  /** WQ25 (names): once the server answers, a doctor is shown its `patientName` (typed or masked; a family member's own name). */
  function named<S extends ShownSummary | undefined>(s: S, b: LabBookingView): S {
    return s && booker.kind === 'doctor' && b.patientName ? { ...s, patient: b.patientName } : s;
  }

  /** A create (or its replay) answered: as the consultation's (`routeCardAnswer`). */
  function afterReceipt(v: LabReceipt, requestKey: string, typed: Summary) {
    const summary = named(typed, v.booking);
    const base: Done = { summary, ref: v.booking.assisted?.shortRef, paidMinor: v.funding?.amountMinor, replayed: v.replayed, newAccount: v.newAccount };
    routeCardAnswer('lab', { card: v.funding?.method === 'razorpay', booking: v.booking, order: v.payment ?? null }, null, {
      done: (card) => setDone({ ...base, paidBy: card ? 'card' : 'wallet' }),
      due: (order) => setCardDue({ bookingId: v.booking._id, requestKey, order, summary, ref: v.booking.assisted?.shortRef, newAccount: v.newAccount, autoOpen: !!order }),
      ended: () => setEnded(NOT_PAYABLE_WORDS),
    });
  }

  /** A by-key answer `used` (check or give-up): as the consultation's (`routeCardAnswer`). */
  function afterUsed(r: { booking: LabBookingView; payment?: AssistedCardPayment | null }, requestKey: string, typed: Summary | undefined, restored: boolean): string | null {
    const b = r.booking;
    const summary = named(typed, b);
    return routeCardAnswer('lab', { card: isCardAnswer(r), booking: b, order: r.payment ?? orderFromBooking(b) }, { restored }, {
      settle: () => { settle(requestKey); setReview(null); create.refresh(); },
      done: () => setDone(doneFromView(b, summary)),
      due: (order) => setCardDue({ bookingId: b._id, requestKey, order, summary: summaryOf(b, summary), ref: b.assisted?.shortRef, autoOpen: false }),
      ended: () => setEnded(NOT_PAYABLE_WORDS),
    });
  }

  // Step 1: the patient (shared with Book consultation); WQ25: or the doctor's own consultation.
  const pt = usePatientStep({ pharmacyId: booker.id, perform, ...(booker.lookup ? { lookupPatient: booker.lookup, refusal: booker.refusal } : {}),
    onFind: () => setNotice(null), onSwitchedOff: () => setOff(true), onChangePhone: () => { setReview(null); setRefused(null); } });
  const cs = useConsultationPatient({ doctorId: booker.id, fromBookingId: fromConsultation ? fromBookingId : undefined });
  const { lookup, patient } = pt;
  const patientDone = fromConsultation ? cs.done : pt.patientDone;
  const patientLabel = fromConsultation ? () => cs.typedName : pt.patientLabel;

  // Step 2: the visit, lab, branch, tests and time.
  const [mode, setMode] = useState<Mode>('lab');
  const [partnerId, setPartnerId] = useState<string | null>(null);
  const [branchId, setBranchId] = useState<string | null>(null);
  const [itemIds, setItemIds] = useState<string[]>([]);
  const [date, setDate] = useState(() => istToday());
  const [slotId, setSlotId] = useState<string | null>(null);
  const [address, setAddress] = useState(EMPTY_ADDRESS);
  const [language, setLanguage] = useState('');
  const [coupon, setCoupon] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const labs = useQuery({
    queryKey: [...booker.labsKey, mode],
    queryFn: () => labsApi.labs({ visitMode: mode, limit: 50 }),
    enabled: patientDone && !off,
  });
  const lab = labs.data?.find((l) => l.partnerId === partnerId) ?? null;
  const branches = useMemo(() => (lab ? branchesFor(lab, mode) : []), [lab, mode]);
  const branch = branches.find((b) => b.branchId === branchId) ?? null;
  const catalogue = useQuery({
    queryKey: [...booker.labsKey, 'catalogue', partnerId, mode],
    queryFn: () => labsApi.catalogue(partnerId!, mode),
    enabled: patientDone && !off && !!partnerId,
  });
  const slots = useQuery({
    queryKey: [...booker.labsKey, 'slots', branchId, mode, date],
    queryFn: () => labsApi.slots(branchId!, { visitMode: mode, from: date, days: SLOT_DAYS }),
    enabled: patientDone && !off && !!branchId,
  });
  useEffect(() => {
    if (isSwitchedOff(labs.error) || isSwitchedOff(catalogue.error) || isSwitchedOff(slots.error)) setOff(true);
  }, [labs.error, catalogue.error, slots.error]);
  // One branch for this visit: chosen at once.
  useEffect(() => { if (branches.length === 1 && !branchId) setBranchId(branches[0]!.branchId); }, [branches, branchId]);
  const slot: AssistedLabSlot | null = slots.data?.find((s) => s.slotId === slotId) ?? null;
  const slotDays = useMemo(() => {
    const days = new Map<string, AssistedLabSlot[]>();
    for (const s of slots.data ?? []) if (s.seatsLeft > 0) days.set(s.date, [...(days.get(s.date) ?? []), s]);
    return [...days];
  }, [slots.data]);
  const items = catalogue.data ?? [];
  // WQ21: tests recommended by the doctor (the shared step, `recommendedTests.tsx`); ticked once per lab, visit and code.
  const recTicks = useRecommendedTicks(catalogue.data ?? null, partnerId ? `${partnerId}:${mode}` : null, setItemIds);
  const priceMinor = labTotalMinor(items, itemIds);

  function chooseMode(m: Mode) { setMode(m); setPartnerId(null); setBranchId(null); setItemIds([]); setSlotId(null); setErrors({}); setRefused(null); }
  function chooseLab(id: string) { setPartnerId(id); setBranchId(null); setItemIds([]); setSlotId(null); setErrors({}); setRefused(null); }
  function toggleItem(id: string) { setItemIds((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id])); setRefused(null); }

  function resetAll() {
    pt.reset(); cs.reset(); setMode('lab'); setPartnerId(null); setBranchId(null); setItemIds([]); setSlotId(null); setAddress(EMPTY_ADDRESS); setLanguage('');
    setCoupon(''); setErrors({}); setReview(null); setRefused(null); setDone(null); setNotice(null);
    setCardDue(null); setEnded(null); choice.setMethod('wallet'); recTicks.reset();
  }

  function visitNext(e: FormEvent) {
    e.preventDefault();
    setRefused(null);
    const errs: Record<string, string> = {};
    if (!lab) errs.lab = 'Choose a lab.';
    else if (!branch) errs.branch = 'Choose a branch.';
    if (itemIds.length === 0) errs.items = 'Choose at least one test.';
    else if (itemIds.length > 20) errs.items = 'Choose at most 20 tests.';
    if (!slot) errs.slot = 'Choose a time.';
    if (mode === 'home') for (const [k, v] of Object.entries(addressErrors(address))) errs[`address.${k}`] = v;
    if (!language) errs.language = 'Choose the language the patient speaks.';
    const code = coupon.trim().toUpperCase();
    if (code && !/^[A-Z0-9_-]{2,50}$/.test(code)) errs.coupon = 'Check the coupon code (letters and numbers only).';
    setErrors(errs);
    // The patient: a walk-in by phone, or (WQ25) the doctor's own consultation with the name the doctor typed.
    const source: LabPatientSource | null = fromConsultation ? (cs.done ? { fromBookingId: fromBookingId!.toLowerCase(), typedName: cs.typedName } : null)
      : lookup ? { phone: lookup.phone, ...patientBody({ ...patient, phone: lookup.phone }) } : null;
    if (Object.keys(errs).length || !lab || !branch || !slot || !source) return;
    const home: LabAddress | undefined = mode === 'home' ? labAddressOf(address) : undefined;
    const requestKey = newRequestKey();
    const request: LabCreateRequest = {
      requestKey, ...source,
      consent: { agreed: true, statementVersion: booker.consent.version, statementLanguage: CONSENT_STATEMENT_LANGUAGE },
      preferredLanguage: language, partnerId: lab.partnerId, branchId: branch.branchId, visitMode: mode, slotId: slot.slotId, itemIds: [...itemIds],
      ...(home ? { address: home } : {}), ...(code ? { couponCode: code } : {}), acceptedPriceMinor: priceMinor,
      // No `notes`: r11 checks it but never stores or shows it (an API gap), so no note is offered here.
      paymentMethod: 'wallet',
    };
    setReview({
      requestKey, request,
      summary: { patient: patientLabel(), lab: lab.name, branch: branch.name, mode, date: slot.date.replace(/-/g, ''), time: slot.startTime,
        tests: items.filter((i) => itemIds.includes(i.itemId)).map((i) => i.name), priceMinor,
        ...(home ? { address: labAddressLine(home) } : {}), ...(code ? { couponCode: code } : {}) },
    });
  }

  // An unconfirmed booking stays on screen while it is resent or given up (its first attempt shows the review busy).
  if (op && !(busy && !givingUp && op.attempts === 1 && !op.uncertain)) {
    return (
      <UnconfirmedBooking op={op} what="lab booking" busy={busy} givingUp={givingUp} resendError={resendError} byKey={() => labsApi.byKey(op.requestKey)}
        onUsed={(r, restored) => afterUsed(r, op.requestKey, restored ? undefined : op.body?.summary, restored)}
        extra={orderFailed && <Alert tone="warn">{ORDER_FAILED_WORDS}</Alert>}
        onAbandoned={() => create.abandonedByCheck(op.requestKey)}
        onResend={() => { setResendError(null); void create.send(op).catch((err: unknown) => setResendError(booker.refusal(err).message)); }}
        onGiveUp={() => void create.giveUp(op)}
        summary={op.body && <SummaryList s={op.body.summary} />} />
    );
  }

  if (off) {
    return <Alert tone="warn">{LAB_SWITCHED_OFF_MESSAGE} Jansetu turns it on {booker.words.offFor} when it is ready. Your other tools work as usual.</Alert>;
  }

  if (ended) {
    return <NotBooked words={ended} againLabel="Book another lab test" onAgain={resetAll} listPath={booker.paths.list} listLabel="See booked lab tests" />;
  }

  if (cardDue) {
    const due = cardDue;
    return (
      <CardDueSection bookingRef={due.ref} summary={<SummaryList s={due.summary} />} newAccount={due.newAccount} listPath={booker.paths.list}
        listLabel="See booked lab tests" held={cardHeld}>
        <CardPaymentPanel key={due.bookingId} source={labCardSource(api, due.bookingId, due.requestKey)} order={due.order} amountMinor={due.summary.priceMinor}
          perform={perform} busy={busy} autoOpen={due.autoOpen} onHeld={setCardHeld}
          onPaid={(_b, note) => { setCardDue(null); setDone({ summary: due.summary, ref: due.ref, paidMinor: due.order?.amountMinor ?? due.summary.priceMinor, replayed: false, newAccount: due.newAccount, paidBy: 'card', ...(note ? { note } : {}) }); create.refresh(); }}
          onEnded={(words) => { setCardDue(null); setEnded(words); create.refresh(); }} />
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
            : byCard ? 'The lab test is booked and paid by card or UPI.' : 'The lab test is booked and paid from your wallet.'}
          {done.ref ? <> Booking reference: <strong>{done.ref}</strong>.</> : null}
        </Alert>
        {done.note && <Alert tone="warn">{done.note}</Alert>}
        <SummaryList s={done.summary} />
        {done.paidMinor !== undefined && <p>{byCard ? 'Paid by card or UPI' : 'Paid from your wallet'}: <strong>{formatRupees(done.paidMinor / 100)}</strong>. Collect this from the patient.</p>}
        {done.newAccount && <p className="ws-muted">This number was new to Jansetu. An account was made for it; the patient can sign in with this number later.</p>}
        <div className="ws-actions">
          <Button onClick={resetAll}>Book another lab test</Button>
          <Link to={booker.paths.list}>See booked lab tests</Link>
        </div>
      </section>
    );
  }

  const frozen = !!review || busy;
  return (
    <>
      {notice && <Alert tone="ok">{notice}</Alert>}
      {fromConsultation ? <ConsultationPatientSection step={cs} frozen={patientDone || frozen} locked={frozen} consent={booker.consent.statement} walkInPath={booker.paths.book} />
        : <PatientSection step={pt} busy={busy} frozen={patientDone || frozen} locked={frozen} nextLabel="Next: choose the lab" booker={booker.kind}
          consent={booker.consent.statement} />}

      {patientDone && (
        <section className="ws-section" aria-labelledby="lab-h">
          <h2 id="lab-h">2. Lab, tests and time</h2>
          {lookup && !fromConsultation && <RecommendedTests load={booker.loadRecommendation} phone={lookup.phone} perform={perform} disabled={frozen} ticks={recTicks}
            label={booker.words.recommendationLabel} />}
          <form className="rx-form" noValidate onSubmit={visitNext}>
            <fieldset className="ws-frozen" disabled={frozen}>
              <fieldset className="ws-checks">
                <legend>Where is the sample taken?</legend>
                {(['lab', 'home'] as const).map((m) => (
                  <label key={m} className="ws-check">
                    <input type="radio" name="visit" checked={mode === m} onChange={() => chooseMode(m)} />
                    {LAB_VISIT_MODE_LABEL[m]}
                  </label>
                ))}
              </fieldset>

              {labs.isPending ? <Loading label="Finding labs…" />
                : labs.isError ? <ErrorState message={booker.refusal(labs.error).message} onRetry={() => void labs.refetch()} />
                : labs.data.length === 0 ? <Empty title="No labs found">Try the other kind of visit.</Empty>
                : (
                  <ul className="stock-list" aria-label="Labs, nearest first">
                    {labs.data.map((l) => (
                      <li key={l.partnerId} className="ws-section">
                        <div className="stock-head">
                          <h3>{l.name}</h3>
                          {l.nearby === 'pincode' ? <Badge tone="ok">Near you</Badge> : l.nearby === 'city' ? <Badge>Same city</Badge> : null}
                        </div>
                        <div className="ws-actions">
                          <span className="ws-muted">{branchesFor(l, mode).map((b) => b.name).join(' · ') || 'No branch for this visit'}</span>
                          {partnerId === l.partnerId ? <Badge tone="ok">Chosen</Badge>
                            : <Button variant="secondary" aria-label={`Choose ${l.name}`} onClick={() => chooseLab(l.partnerId)}>Choose</Button>}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              {errors.lab && <span className="j-field__error" role="alert">{errors.lab}</span>}

              {lab && branches.length > 1 && (
                <fieldset className="ws-checks">
                  <legend>Branch</legend>
                  {branches.map((b) => (
                    <label key={b.branchId} className="ws-check">
                      <input type="radio" name="branch" checked={branchId === b.branchId} onChange={() => { setBranchId(b.branchId); setSlotId(null); }} />
                      {b.name}{b.address ? ` (${b.address})` : ''}
                    </label>
                  ))}
                  {errors.branch && <span className="j-field__error" role="alert">{errors.branch}</span>}
                </fieldset>
              )}
              {lab && branches.length === 0 && <Alert tone="warn">This lab has no branch for this kind of visit. Choose another lab or visit.</Alert>}

              {lab && (
                <fieldset className="ws-checks">
                  <legend>Tests</legend>
                  {catalogue.isPending ? <Loading label="Loading tests…" />
                    : catalogue.isError ? <ErrorState message={booker.refusal(catalogue.error).message} onRetry={() => void catalogue.refetch()} />
                    : items.length === 0 ? <span>No tests for this kind of visit here.</span>
                    : items.map((i) => (
                      <label key={i.itemId} className="ws-check">
                        <input type="checkbox" checked={itemIds.includes(i.itemId)} onChange={() => toggleItem(i.itemId)} />
                        {i.name}{i.kind === 'package' ? ' (package)' : ''} · {formatRupees(i.priceMinor / 100)}
                        {i.preparation ? <span className="ws-muted"> · {i.preparation}</span> : null}
                      </label>
                    ))}
                  {errors.items && <span className="j-field__error" role="alert">{errors.items}</span>}
                </fieldset>
              )}

              {branch && (
                <>
                  <TextField label="From day" type="date" value={date} min={istToday()} hint={`Free times for ${SLOT_DAYS} days from this day.`}
                    onChange={(e) => { if (e.target.value) { setDate(e.target.value); setSlotId(null); } }} />
                  <div className="ws-day">
                    {slots.isPending ? <Loading label="Finding free times…" />
                      : slots.isError ? <ErrorState message={booker.refusal(slots.error).message} onRetry={() => void slots.refetch()} />
                      : slotDays.length === 0 ? <span>No free times in these days. Choose a later day or another branch.</span>
                      : <SlotDays days={slotDays} chosen={slotId} onChoose={(s) => setSlotId(s.slotId)} />}
                  </div>
                  {errors.slot && <span className="j-field__error" role="alert">{errors.slot}</span>}
                </>
              )}

              {mode === 'home' && lab && <AddressFields value={address} errors={errors} onChange={setAddress} />}

              {lab && (
                <>
                  <div className="rx-form-row">
                    <LanguageSelect id="lab-lang" value={language} error={errors.language} onChange={setLanguage} />
                    <TextField label="Coupon code (optional)" value={coupon} error={errors.coupon} maxLength={50} hint="Only if the patient has one." onChange={(e) => setCoupon(e.target.value)} />
                  </div>
                </>
              )}
            </fieldset>
            {refused && !review && <Alert>{refused.message}</Alert>}
            {!review && <div><Button type="submit">Next: check the price</Button></div>}
          </form>
        </section>
      )}

      {review && (
        <ReviewAndPay booker={booker} review={review} busy={busy} refused={refused}
          method={choice.method} cardOff={choice.cardOff} onMethod={(m) => { choice.setMethod(m); if (refused?.kind === 'card') setRefused(null); }}
          onPay={() => void create.pay((p) => ({ ...p, request: { ...p.request, paymentMethod: booker.card ? choice.methodFor(p.summary.priceMinor) : 'wallet' } }))}
          onBack={() => { setReview(null); setRefused(null); }} onNewPrice={create.payAtNewPrice} />
      )}
    </>
  );
}

function ReviewAndPay({ booker, review, busy, refused, method, cardOff, onMethod, onPay, onBack, onNewPrice }: {
  booker: LabBooker; review: { requestKey: string } & PendingLab; busy: boolean; refused: Refusal | null;
  method: AssistedPaymentMethod; cardOff: string | null; onMethod: (m: AssistedPaymentMethod) => void;
  onPay: () => void; onBack: () => void; onNewPrice: (priceMinor: number) => void;
}) {
  const s = review.summary;
  return (
    <section className="ws-section" aria-labelledby="pay-h">
      <h2 id="pay-h">3. Check and pay</h2>
      <div className="confirm" role="group" aria-label="Check and pay">
        <SummaryList s={s} />
        {s.couponCode && !s.couponChecked && <p className="ws-muted">Price before the coupon; the coupon is checked when you pay.</p>}
        {/* WQ25: a doctor pays from its wallet only (card is round 3c). */}
        {booker.card ? (
          <PayChoice pharmacyId={booker.id} priceMinor={s.priceMinor} couponCode={s.couponCode} refused={refused} busy={busy} method={method} cardOff={cardOff}
            onMethod={onMethod} onPay={onPay} onBack={onBack} onNewPrice={onNewPrice} />
        ) : (
          <WalletPay payer={booker.payer} priceMinor={s.priceMinor} couponCode={s.couponCode} refused={refused} busy={busy}
            onPay={onPay} onBack={onBack} onNewPrice={onNewPrice} />
        )}
      </div>
    </section>
  );
}
