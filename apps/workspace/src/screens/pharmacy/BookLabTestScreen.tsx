import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  addressErrors, isCardAnswer, routeCardAnswer, cleanRecommendationCode, matchRecommended, pharmacyRecommendationsApi, recommendationRefusal, recommendationsOff, orderFromBooking, branchesFor, CONSENT_STATEMENT_LANGUAGE, CONSENT_STATEMENT_VERSION, formatSlotDate, isSwitchedOff, istToday,
  LAB_SWITCHED_OFF_MESSAGE, LAB_VISIT_MODE_LABEL, labRefusal, labTotalMinor, PATIENT_LANGUAGES, patientBody, pharmacyLabApi, type AssistedLabSlot, type LabAddress, type LabBookingRequest, type LabBookingView, type LabByKeyAnswer, type LabReceipt, type TestRecommendation, type AssistedCardPayment, type AssistedPaymentMethod, type OpenCardOrder, type Refusal,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, formatRupees, Loading, TextField } from '@jansetu/ui';
import { PageHeading } from '../../PageHeading.tsx';
import { newRequestKey } from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { useOneAtATime, type Perform } from '../finance/finance.tsx';
import { usePharmacyId } from './ownedOp.tsx';
import { useAssistedCreate } from './assistedCreate.ts';
import { SlotDays } from './slotDays.tsx';
import { UnconfirmedBooking } from './unconfirmedBooking.tsx';
import { PatientSection, usePatientStep } from './patientStep.tsx';
import { PayChoice } from './walletPay.tsx';
import { CardDueSection, CardPaymentPanel, isOrderFailed, labCardSource, NOT_PAYABLE_WORDS, NotBooked, ORDER_FAILED_WORDS, useCardChoice } from './cardBooking.tsx';

/**
 * WQ17: a pharmacy books a lab test for a walk-in patient (assisted booking phase 2a, backend r11, design §24.11): the same
 * patient step as Book consultation, then the visit (at the lab or home collection), the lab (nearby first,
 * `GET /pharmacy-assisted/labs`), its branch, the tests (`…/labs/:partnerId/catalogue`), a time (`…/labs/branches/:id/slots`),
 * the price check and one keyed create paid from the wallet (`POST /pharmacy-assisted/lab-bookings`). The phone and the
 * address stay in this page's state and in POST bodies: never in the address bar, storage or logs.
 */
export function BookLabTestScreen() {
  const pharmacyId = usePharmacyId();
  return (
    <>
      <PageHeading title="Book lab test">
        Book a lab test for a patient at your counter. Jansetu takes the price from your wallet; you collect it from the patient.
      </PageHeading>
      <Book key={pharmacyId} pharmacyId={pharmacyId} />
    </>
  );
}

type Mode = 'lab' | 'home';
interface Summary { patient: string; lab: string; branch: string; mode: Mode; date: string; time: string; tests: string[]; address?: string; priceMinor: number; couponCode?: string;
  couponChecked?: boolean }
interface PendingLab { request: LabBookingRequest; summary: Summary }
/** WQ17b M1: a booking found by its key after a reload: its price is not in the booker view, so none is shown. */
type ShownSummary = Omit<Summary, 'priceMinor'> & { priceMinor?: number };
interface Done { summary: ShownSummary; ref?: string; paidMinor?: number; replayed: boolean; newAccount?: boolean; paidBy?: 'wallet' | 'card'; note?: string }
/** WQ17c: a card lab booking held until it is paid (or its time is released). */
interface CardDue { bookingId: string; requestKey: string; order: OpenCardOrder | null; summary: ShownSummary; ref?: string; newAccount?: boolean; autoOpen: boolean }

const SLOT_DAYS = 7;
const EMPTY_ADDRESS = { line1: '', line2: '', city: '', state: '', pincode: '', landmark: '' };

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

function Book({ pharmacyId }: { pharmacyId: string }) {
  const { api } = useSession();
  const labsApi = pharmacyLabApi(api);
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
    slot: `assisted-lab-book:${pharmacyId}`, perform, book: (request) => labsApi.book(request), abandon: (key) => labsApi.abandon(key), refusal: labRefusal,
    walletKey: ['pharmacy-wallet', pharmacyId], refreshKeys: [['pharmacy-lab-bookings', pharmacyId], ['assisted-labs', pharmacyId]],
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

  /** A create (or its replay) answered: as the consultation's (`routeCardAnswer`). */
  function afterReceipt(v: LabReceipt, requestKey: string, summary: Summary) {
    const base: Done = { summary, ref: v.booking.assisted?.shortRef, paidMinor: v.funding?.amountMinor, replayed: v.replayed, newAccount: v.newAccount };
    routeCardAnswer('lab', { card: v.funding?.method === 'razorpay', booking: v.booking, order: v.payment ?? null }, null, {
      done: (card) => setDone({ ...base, paidBy: card ? 'card' : 'wallet' }),
      due: (order) => setCardDue({ bookingId: v.booking._id, requestKey, order, summary, ref: v.booking.assisted?.shortRef, newAccount: v.newAccount, autoOpen: !!order }),
      ended: () => setEnded(NOT_PAYABLE_WORDS),
    });
  }

  /** A by-key answer `used` (check or give-up): as the consultation's (`routeCardAnswer`). */
  function afterUsed(r: { booking: LabBookingView; payment?: AssistedCardPayment | null }, requestKey: string, summary: Summary | undefined, restored: boolean): string | null {
    const b = r.booking;
    return routeCardAnswer('lab', { card: isCardAnswer(r), booking: b, order: r.payment ?? orderFromBooking(b) }, { restored }, {
      settle: () => { settle(requestKey); setReview(null); create.refresh(); },
      done: () => setDone(doneFromView(b, summary)),
      due: (order) => setCardDue({ bookingId: b._id, requestKey, order, summary: summaryOf(b, summary), ref: b.assisted?.shortRef, autoOpen: false }),
      ended: () => setEnded(NOT_PAYABLE_WORDS),
    });
  }

  // Step 1: the patient (shared with Book consultation).
  const pt = usePatientStep({ pharmacyId, perform, onFind: () => setNotice(null), onSwitchedOff: () => setOff(true),
    onChangePhone: () => { setReview(null); setRefused(null); } });
  const { lookup, patient, patientDone, patientLabel } = pt;

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
    queryKey: ['assisted-labs', pharmacyId, mode],
    queryFn: () => labsApi.labs({ visitMode: mode, limit: 50 }),
    enabled: patientDone && !off,
  });
  const lab = labs.data?.find((l) => l.partnerId === partnerId) ?? null;
  const branches = useMemo(() => (lab ? branchesFor(lab, mode) : []), [lab, mode]);
  const branch = branches.find((b) => b.branchId === branchId) ?? null;
  const catalogue = useQuery({
    queryKey: ['assisted-labs', pharmacyId, 'catalogue', partnerId, mode],
    queryFn: () => labsApi.catalogue(partnerId!, mode),
    enabled: patientDone && !off && !!partnerId,
  });
  const slots = useQuery({
    queryKey: ['assisted-labs', pharmacyId, 'slots', branchId, mode, date],
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
  // WQ21 (r16 phase 3d): tests recommended by the doctor, loaded by the code on the prescription and the patient's number.
  const [rec, setRec] = useState<TestRecommendation | null>(null);
  const [recOff, setRecOff] = useState(false);
  const recApplied = useRef('');
  // The recommended tests this lab lists are ticked once per lab and code; the pharmacist can change the ticks.
  useEffect(() => {
    if (!rec || !catalogue.data || !partnerId) return;
    const key = `${partnerId}:${mode}:${rec.code}`;
    if (recApplied.current === key) return;
    recApplied.current = key;
    setItemIds(matchRecommended(catalogue.data, rec.items.map((i) => i.name)).itemIds);
  }, [rec, catalogue.data, partnerId, mode]);
  const recUnmatched = rec && catalogue.data && partnerId ? matchRecommended(catalogue.data, rec.items.map((i) => i.name)).unmatched : null;
  const priceMinor = labTotalMinor(items, itemIds);

  function chooseMode(m: Mode) { setMode(m); setPartnerId(null); setBranchId(null); setItemIds([]); setSlotId(null); setErrors({}); setRefused(null); }
  function chooseLab(id: string) { setPartnerId(id); setBranchId(null); setItemIds([]); setSlotId(null); setErrors({}); setRefused(null); }
  function toggleItem(id: string) { setItemIds((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id])); setRefused(null); }

  function resetAll() {
    pt.reset(); setMode('lab'); setPartnerId(null); setBranchId(null); setItemIds([]); setSlotId(null); setAddress(EMPTY_ADDRESS); setLanguage('');
    setCoupon(''); setErrors({}); setReview(null); setRefused(null); setDone(null); setNotice(null);
    setCardDue(null); setEnded(null); choice.setMethod('wallet'); setRec(null); recApplied.current = '';
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
    if (Object.keys(errs).length || !lab || !branch || !slot || !lookup) return;
    const home: LabAddress | undefined = mode === 'home' ? {
      line1: address.line1.trim(), city: address.city.trim(), pincode: address.pincode.trim(),
      ...(address.line2.trim() ? { line2: address.line2.trim() } : {}), ...(address.state.trim() ? { state: address.state.trim() } : {}),
      ...(address.landmark.trim() ? { landmark: address.landmark.trim() } : {}),
    } : undefined;
    const requestKey = newRequestKey();
    const request: LabBookingRequest = {
      requestKey, phone: lookup.phone, ...patientBody({ ...patient, phone: lookup.phone }),
      consent: { agreed: true, statementVersion: CONSENT_STATEMENT_VERSION, statementLanguage: CONSENT_STATEMENT_LANGUAGE },
      preferredLanguage: language, partnerId: lab.partnerId, branchId: branch.branchId, visitMode: mode, slotId: slot.slotId, itemIds: [...itemIds],
      ...(home ? { address: home } : {}), ...(code ? { couponCode: code } : {}), acceptedPriceMinor: priceMinor,
      // No `notes`: r11 checks it but never stores or shows it (an API gap), so no note is offered here.
      paymentMethod: 'wallet',
    };
    setReview({
      requestKey, request,
      summary: { patient: patientLabel(), lab: lab.name, branch: branch.name, mode, date: slot.date.replace(/-/g, ''), time: slot.startTime,
        tests: items.filter((i) => itemIds.includes(i.itemId)).map((i) => i.name), priceMinor,
        ...(home ? { address: [home.line1, home.city, home.pincode].join(', ') } : {}), ...(code ? { couponCode: code } : {}) },
    });
  }

  // An unconfirmed booking stays on screen while it is resent or given up (its first attempt shows the review busy).
  if (op && !(busy && !givingUp && op.attempts === 1 && !op.uncertain)) {
    return (
      <UnconfirmedBooking op={op} what="lab booking" busy={busy} givingUp={givingUp} resendError={resendError} byKey={() => labsApi.byKey(op.requestKey)}
        onUsed={(r, restored) => afterUsed(r, op.requestKey, restored ? undefined : op.body?.summary, restored)}
        extra={orderFailed && <Alert tone="warn">{ORDER_FAILED_WORDS}</Alert>}
        onAbandoned={() => create.abandonedByCheck(op.requestKey)}
        onResend={() => { setResendError(null); void create.send(op).catch((err: unknown) => setResendError(labRefusal(err).message)); }}
        onGiveUp={() => void create.giveUp(op)}
        summary={op.body && <SummaryList s={op.body.summary} />} />
    );
  }

  if (off) {
    return <Alert tone="warn">{LAB_SWITCHED_OFF_MESSAGE} Jansetu turns it on for your pharmacy when it is ready. Your other tools work as usual.</Alert>;
  }

  if (ended) {
    return <NotBooked words={ended} againLabel="Book another lab test" onAgain={resetAll} listPath="/pharmacy/lab-tests" listLabel="See booked lab tests" />;
  }

  if (cardDue) {
    const due = cardDue;
    return (
      <CardDueSection bookingRef={due.ref} summary={<SummaryList s={due.summary} />} newAccount={due.newAccount} listPath="/pharmacy/lab-tests"
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
          <Link to="/pharmacy/lab-tests">See booked lab tests</Link>
        </div>
      </section>
    );
  }

  const frozen = !!review || busy;
  const addr = (k: keyof typeof EMPTY_ADDRESS, label: string, hint?: string) => (
    <TextField label={label} autoComplete="off" value={address[k]} error={errors[`address.${k}`]} hint={hint} inputMode={k === 'pincode' ? 'numeric' : undefined}
      onChange={(e) => setAddress((a) => ({ ...a, [k]: e.target.value }))} />
  );
  return (
    <>
      {notice && <Alert tone="ok">{notice}</Alert>}
      <PatientSection step={pt} busy={busy} frozen={patientDone || frozen} locked={frozen} nextLabel="Next: choose the lab" />

      {patientDone && (
        <section className="ws-section" aria-labelledby="lab-h">
          <h2 id="lab-h">2. Lab, tests and time</h2>
          {!recOff && lookup && (
            <RecommendedTests phone={lookup.phone} perform={perform} disabled={frozen} rec={rec} unmatched={recUnmatched}
              onLoaded={(r) => { recApplied.current = ''; setRec(r); }} onOff={() => { setRecOff(true); setRec(null); }} />
          )}
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
                : labs.isError ? <ErrorState message={labRefusal(labs.error).message} onRetry={() => void labs.refetch()} />
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
                    : catalogue.isError ? <ErrorState message={labRefusal(catalogue.error).message} onRetry={() => void catalogue.refetch()} />
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
                      : slots.isError ? <ErrorState message={labRefusal(slots.error).message} onRetry={() => void slots.refetch()} />
                      : slotDays.length === 0 ? <span>No free times in these days. Choose a later day or another branch.</span>
                      : <SlotDays days={slotDays} chosen={slotId} onChoose={(s) => setSlotId(s.slotId)} />}
                  </div>
                  {errors.slot && <span className="j-field__error" role="alert">{errors.slot}</span>}
                </>
              )}

              {mode === 'home' && lab && (
                <fieldset className="ws-checks">
                  <legend>Address for the home collection</legend>
                  {addr('line1', 'House and street')}
                  {addr('line2', 'Area (optional)')}
                  <div className="rx-form-row">{addr('city', 'City')}{addr('pincode', 'Pincode')}</div>
                  <div className="rx-form-row">{addr('state', 'State (optional)')}{addr('landmark', 'Landmark (optional)')}</div>
                </fieldset>
              )}

              {lab && (
                <>
                  <div className="rx-form-row">
                    <div className="j-field">
                      <label htmlFor="lab-lang">Language the patient speaks</label>
                      <select id="lab-lang" value={language} aria-invalid={errors.language ? true : undefined}
                        aria-describedby={errors.language ? 'lab-lang-err' : undefined} onChange={(e) => setLanguage(e.target.value)}>
                        <option value="">Choose…</option>
                        {PATIENT_LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
                      </select>
                      {errors.language && <span id="lab-lang-err" className="j-field__error" role="alert">{errors.language}</span>}
                    </div>
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
        <ReviewAndPay pharmacyId={pharmacyId} review={review} busy={busy} refused={refused}
          method={choice.method} cardOff={choice.cardOff} onMethod={(m) => { choice.setMethod(m); if (refused?.kind === 'card') setRefused(null); }}
          onPay={() => void create.pay((p) => ({ ...p, request: { ...p.request, paymentMethod: choice.methodFor(p.summary.priceMinor) } }))}
          onBack={() => { setReview(null); setRefused(null); }} onNewPrice={create.payAtNewPrice} />
      )}
    </>
  );
}

/**
 * WQ21 (r16 phase 3d, §25.12.4): "Have a test code from the doctor?": loads the recommended test names by the code and the
 * patient's number (`GET /pharmacy-assisted/recommendations/:code?phone=`). The code and the number stay in this page's
 * state. The booking is not linked to the recommendation yet (the backend's next round): nothing new is sent on create.
 */
function RecommendedTests({ phone, perform, disabled, rec, unmatched, onLoaded, onOff }: {
  phone: string; perform: Perform; disabled: boolean; rec: TestRecommendation | null; unmatched: string[] | null;
  onLoaded: (r: TestRecommendation) => void; onOff: () => void;
}) {
  const { api } = useSession();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  async function load(e: FormEvent) {
    e.preventDefault();
    const code = cleanRecommendationCode(text);
    if (!code) { setError('This code is not valid. Check it on the prescription.'); return; }
    setError(null);
    setLoading(true);
    try {
      onLoaded(await perform(() => pharmacyRecommendationsApi(api).load(code, phone)));
    } catch (err) {
      if (recommendationsOff(err)) { onOff(); return; }
      setError(recommendationRefusal(err));
    } finally {
      setLoading(false);
    }
  }
  return (
    <form className="ws-search" noValidate onSubmit={(e) => void load(e)} aria-label="Recommended tests">
      <TextField label="Have a test code from the doctor? (optional)" autoComplete="off" value={text} error={error} disabled={disabled} maxLength={20}
        hint={rec ? `Recommended tests: ${rec.items.map((i) => i.name).join(', ')}.` : 'It is on the prescription, for example ABCD-EFGH.'}
        onChange={(e) => setText(e.target.value)} />
      <Button type="submit" variant="secondary" busy={loading} disabled={disabled}>Load tests</Button>
      {unmatched && unmatched.length > 0 && <span className="ws-muted">{unmatched.map((n) => `${n}: not in this lab's list`).join('. ')}.</span>}
    </form>
  );
}

function ReviewAndPay({ pharmacyId, review, busy, refused, method, cardOff, onMethod, onPay, onBack, onNewPrice }: {
  pharmacyId: string; review: { requestKey: string } & PendingLab; busy: boolean; refused: Refusal | null;
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
        <PayChoice pharmacyId={pharmacyId} priceMinor={s.priceMinor} couponCode={s.couponCode} refused={refused} busy={busy} method={method} cardOff={cardOff}
          onMethod={onMethod} onPay={onPay} onBack={onBack} onNewPrice={onNewPrice} />
      </div>
    </section>
  );
}
