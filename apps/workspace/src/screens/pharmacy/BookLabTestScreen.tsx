import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  addressErrors, isCardAnswer, routeCardAnswer, orderFromBooking, branchesFor, CONSENT_STATEMENT_LANGUAGE, formatSlotDate, isSwitchedOff, istToday,
  LAB_SWITCHED_OFF_MESSAGE, LAB_VISIT_MODE_LABEL, labTotalMinor, patientBody, type AssistedLabSlot, type LabAddress, type LabBookingView, type LabByKeyAnswer, type LabCreateRequest, type LabPatientSource, type LabReceipt, type AssistedCardPayment, type AssistedPaymentMethod, type OpenCardOrder, type Refusal,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, formatRupees, Loading, TextField , Parts } from '@jansetu/ui';
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
import { PayChoice, payerWallet } from './walletPay.tsx';
import { RecommendedTests, useRecommendedTicks } from './recommendedTests.tsx';
import { CardDueSection, CardPaymentPanel, isOrderFailed, NOT_PAYABLE_WORDS, NotBooked, ORDER_FAILED_WORDS, useCardChoice } from './cardBooking.tsx';
import { pharmacyLabBooker, type LabBooker } from './labBooker.ts';
import { t } from '../../i18n/pharmacy/index.ts';

/**
 * WQ17: a pharmacy books a lab test for a walk-in patient (assisted booking phase 2a, backend r11, design §24.11): the same
 * patient step as Book consultation, then the visit (at the lab or home collection), the lab (nearby first,
 * `GET /pharmacy-assisted/labs`), its branch, the tests (`…/labs/:partnerId/catalogue`), a time (`…/labs/branches/:id/slots`),
 * the price check and one keyed create paid from the wallet (`POST /pharmacy-assisted/lab-bookings`). The phone and the
 * address stay in this page's state and in POST bodies: never in the address bar, storage or logs.
 * WQ25: the same screen for a doctor (`LabBooker`, backend r26): the patient of its own consultation (`fromBookingId`) or a
 * walk-in by phone, paid from the doctor wallet; WQ27 (r29) or by card or UPI.
 */
export function BookLabTestScreen() {
  const pharmacyId = usePharmacyId();
  const { api } = useSession();
  return (
    <>
      <PageHeading title={t('bookLabTest.bookLabTest')}>{t('bookLabTest.bookALabTestFor')}</PageHeading>
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
      <li><Parts of={t.rich('common.patientFull', { patient: <strong>{s.patient}</strong> })} /></li>
      <li><Parts of={t.rich('bookLabTest.labFull', { lab: <strong>{s.lab}</strong>, branch: s.branch })} /></li>
      <li><Parts of={t.rich('bookLabTest.visitFull', { value: <strong>{LAB_VISIT_MODE_LABEL[s.mode]}</strong>, value2: s.address ? ` at ${s.address}` : '' })} /></li>
      <li><Parts of={t.rich('common.whenFull2', { strong: <strong>{formatSlotDate(s.date)}{` ${t('bookLabTest.at')} `}{s.time}</strong> })} /></li>
      <li><Parts of={t.rich('bookLabTest.testsFull', { tests: <strong>{s.tests.join(', ')}</strong> })} /></li>
      {s.priceMinor !== undefined && <li><Parts of={t.rich('common.priceFull', { amount: <strong>{formatRupees(s.priceMinor / 100)}</strong>, value: s.couponCode ? ` (coupon ${s.couponCode})` : '' })} /></li>}
    </ul>
  );
}

function summaryOf(b: LabBookingView, summary: Summary | undefined): ShownSummary {
  return summary ?? {
    patient: b.patientName ?? t('common.thePatient'), lab: b.lab?.name ?? t('bookLabTest.theLab'), branch: b.branch?.name ?? '', mode: (b.visitMode as Mode) ?? 'lab',
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
      ended: () => setEnded(NOT_PAYABLE_WORDS()),
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
      ended: () => setEnded(NOT_PAYABLE_WORDS()),
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
    // Review (WQ25): from a consultation no lookup reaches the server first, so the labs are read at once: a switch that is
    // off is said up front, as the walk-in's lookup says it.
    enabled: (patientDone || fromConsultation) && !off,
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
    if (!lab) errs.lab = t('bookLabTest.chooseALab');
    else if (!branch) errs.branch = t('bookLabTest.chooseABranch');
    if (itemIds.length === 0) errs.items = t('bookLabTest.chooseAtLeastOneTest');
    else if (itemIds.length > 20) errs.items = t('bookLabTest.chooseAtMost20Tests');
    if (!slot) errs.slot = t('common.chooseATime');
    if (mode === 'home') for (const [k, v] of Object.entries(addressErrors(address))) errs[`address.${k}`] = v;
    if (!language) errs.language = t('common.chooseTheLanguageThePatient');
    const code = coupon.trim().toUpperCase();
    if (code && !/^[A-Z0-9_-]{2,50}$/.test(code)) errs.coupon = t('common.checkTheCouponCodeLetters');
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
      <UnconfirmedBooking op={op} kind="labBooking" busy={busy} givingUp={givingUp} resendError={resendError} byKey={() => labsApi.byKey(op.requestKey)}
        onUsed={(r, restored) => afterUsed(r, op.requestKey, restored ? undefined : op.body?.summary, restored)}
        extra={orderFailed && <Alert tone="warn">{ORDER_FAILED_WORDS()}</Alert>}
        onAbandoned={() => create.abandonedByCheck(op.requestKey)}
        onResend={() => { setResendError(null); void create.send(op).catch((err: unknown) => setResendError(booker.refusal(err).message)); }}
        onGiveUp={() => void create.giveUp(op)}
        summary={op.body && <SummaryList s={op.body.summary} />} />
    );
  }

  if (off) {
    return <Alert tone="warn">{t(`bookLabTest.turnsItOn.${booker.kind}`, { LAB_SWITCHED_OFF_MESSAGE })}</Alert>;
  }

  if (ended) {
    return <NotBooked words={ended} againLabel={t('bookLabTest.bookAnotherLabTest')} onAgain={resetAll} listPath={booker.paths.list} listLabel={t('bookLabTest.seeBookedLabTests')} />;
  }

  if (cardDue) {
    const due = cardDue;
    return (
      <CardDueSection bookingRef={due.ref} summary={<SummaryList s={due.summary} />} newAccount={due.newAccount} listPath={booker.paths.list}
        listLabel={t('bookLabTest.seeBookedLabTests')} held={cardHeld}>
        <CardPaymentPanel key={due.bookingId} source={booker.cardSource(api, due.bookingId, due.requestKey)} order={due.order} amountMinor={due.summary.priceMinor}
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
        <h2 id="done-h">{done.replayed ? t('common.alreadyBooked') : t('common.booked')}</h2>
        <Alert tone="ok">
          {done.replayed ? t('common.thisBookingWasAlreadyMade')
            : byCard ? t('bookLabTest.theLabTestIsBooked') : t('bookLabTest.theLabTestIsBooked2')}
          {done.ref ? <>{' '}<Parts of={t.rich('common.bookingReferenceFull', { ref: <strong>{done.ref}</strong> })} /></> : null}
        </Alert>
        {done.note && <Alert tone="warn">{done.note}</Alert>}
        <SummaryList s={done.summary} />
        {done.paidMinor !== undefined && <p>{byCard ? t('common.paidByCardOrUpi') : t('common.paidFromYourWallet')}: <strong>{formatRupees(done.paidMinor / 100)}</strong>{t('common.collectThisFromThePatient')}</p>}
        {done.newAccount && <p className="ws-muted">{t('common.thisNumberWasNewTo')}</p>}
        <div className="ws-actions">
          <Button onClick={resetAll}>{t('bookLabTest.bookAnotherLabTest')}</Button>
          <Link to={booker.paths.list}>{t('bookLabTest.seeBookedLabTests')}</Link>
        </div>
      </section>
    );
  }

  const frozen = !!review || busy;
  return (
    <>
      {notice && <Alert tone="ok">{notice}</Alert>}
      {fromConsultation ? <ConsultationPatientSection step={cs} frozen={patientDone || frozen} locked={frozen} consent={booker.consent.statement} walkInPath={booker.paths.book} />
        : <PatientSection step={pt} busy={busy} frozen={patientDone || frozen} locked={frozen} nextLabel={t('common.nextChooseTheLab')} booker={booker.kind}
          consent={booker.consent.statement} forTest />}

      {patientDone && (
        <section className="ws-section" aria-labelledby="lab-h">
          <h2 id="lab-h">{t('bookLabTest.n2LabTestsAndTime')}</h2>
          {lookup && !fromConsultation && <RecommendedTests load={booker.loadRecommendation} phone={lookup.phone} perform={perform} disabled={frozen} ticks={recTicks}
            label={booker.words.recommendationLabel} />}
          <form className="rx-form" noValidate onSubmit={visitNext}>
            <fieldset className="ws-frozen" disabled={frozen}>
              <fieldset className="ws-checks">
                <legend>{t('bookLabTest.whereIsTheSampleTaken')}</legend>
                {(['lab', 'home'] as const).map((m) => (
                  <label key={m} className="ws-check">
                    <input type="radio" name="visit" checked={mode === m} onChange={() => chooseMode(m)} />
                    {LAB_VISIT_MODE_LABEL[m]}
                  </label>
                ))}
              </fieldset>

              {labs.isPending ? <Loading label={t('bookLabTest.findingLabs')} />
                : labs.isError ? <ErrorState message={booker.refusal(labs.error).message} onRetry={() => void labs.refetch()} />
                : labs.data.length === 0 ? <Empty title={t('bookLabTest.noLabsFound')}>{t('bookLabTest.tryTheOtherKindOf')}</Empty>
                : (
                  <ul className="stock-list" aria-label={t('bookLabTest.labsNearestFirst')}>
                    {labs.data.map((l) => (
                      <li key={l.partnerId} className="ws-section">
                        <div className="stock-head">
                          <h3>{l.name}</h3>
                          {l.nearby === 'pincode' ? <Badge tone="ok">{t('common.nearYou')}</Badge> : l.nearby === 'city' ? <Badge>{t('common.sameCity')}</Badge> : null}
                        </div>
                        <div className="ws-actions">
                          <span className="ws-muted">{branchesFor(l, mode).map((b) => b.name).join(' · ') || t('bookLabTest.noBranchForThisVisit')}</span>
                          {partnerId === l.partnerId ? <Badge tone="ok">{t('common.chosen')}</Badge>
                            : <Button variant="secondary" aria-label={t('common.choose4', { name: l.name })} onClick={() => chooseLab(l.partnerId)}>{t('common.choose2')}</Button>}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              {errors.lab && <span className="j-field__error" role="alert">{errors.lab}</span>}

              {lab && branches.length > 1 && (
                <fieldset className="ws-checks">
                  <legend>{t('bookLabTest.branch')}</legend>
                  {branches.map((b) => (
                    <label key={b.branchId} className="ws-check">
                      <input type="radio" name="branch" checked={branchId === b.branchId} onChange={() => { setBranchId(b.branchId); setSlotId(null); }} />
                      {b.name}{b.address ? ` (${b.address})` : ''}
                    </label>
                  ))}
                  {errors.branch && <span className="j-field__error" role="alert">{errors.branch}</span>}
                </fieldset>
              )}
              {lab && branches.length === 0 && <Alert tone="warn">{t('bookLabTest.thisLabHasNoBranch')}</Alert>}

              {lab && (
                <fieldset className="ws-checks">
                  <legend>{t('common.tests')}</legend>
                  {catalogue.isPending ? <Loading label={t('bookLabTest.loadingTests')} />
                    : catalogue.isError ? <ErrorState message={booker.refusal(catalogue.error).message} onRetry={() => void catalogue.refetch()} />
                    : items.length === 0 ? <span>{t('bookLabTest.noTestsForThisKind')}</span>
                    : items.map((i) => (
                      <label key={i.itemId} className="ws-check">
                        <input type="checkbox" checked={itemIds.includes(i.itemId)} onChange={() => toggleItem(i.itemId)} />
                        {i.name}{i.kind === 'package' ? ` ${t('bookLabTest.packageTag')}` : ''} · {formatRupees(i.priceMinor / 100)}
                        {i.preparation ? <span className="ws-muted"> · {i.preparation}</span> : null}
                      </label>
                    ))}
                  {errors.items && <span className="j-field__error" role="alert">{errors.items}</span>}
                </fieldset>
              )}

              {branch && (
                <>
                  <TextField label={t('common.fromDay')} type="date" value={date} min={istToday()} hint={t('common.freeTimesForDaysFrom', { SLOT_DAYS })}
                    onChange={(e) => { if (e.target.value) { setDate(e.target.value); setSlotId(null); } }} />
                  <div className="ws-day">
                    {slots.isPending ? <Loading label={t('common.findingFreeTimes')} />
                      : slots.isError ? <ErrorState message={booker.refusal(slots.error).message} onRetry={() => void slots.refetch()} />
                      : slotDays.length === 0 ? <span>{t('bookLabTest.noFreeTimesInThese')}</span>
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
                    <TextField label={t('common.couponCodeOptional')} value={coupon} error={errors.coupon} maxLength={50} hint={t('common.onlyIfThePatientHas')} onChange={(e) => setCoupon(e.target.value)} />
                  </div>
                </>
              )}
            </fieldset>
            {refused && !review && <Alert>{refused.message}</Alert>}
            {!review && <div><Button type="submit">{t('common.nextCheckThePrice')}</Button></div>}
          </form>
        </section>
      )}

      {review && (
        <ReviewAndPay booker={booker} review={review} busy={busy} refused={refused}
          method={choice.method} cardOff={choice.cardOff} onMethod={(m) => { choice.setMethod(m); if (refused?.kind === 'card') setRefused(null); }}
          onPay={() => void create.pay((p) => ({ ...p, request: { ...p.request, paymentMethod: choice.methodFor(p.summary.priceMinor) } }))}
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
  const { api } = useSession();
  const s = review.summary;
  return (
    <section className="ws-section" aria-labelledby="pay-h">
      <h2 id="pay-h">{t('common.n3CheckAndPay')}</h2>
      <div className="confirm" role="group" aria-label={t('common.checkAndPay')}>
        <SummaryList s={s} />
        {s.couponCode && !s.couponChecked && <p className="ws-muted">{t('common.priceBeforeTheCouponThe')}</p>}
        <PayChoice wallet={payerWallet(api, booker.payer)} priceMinor={s.priceMinor} couponCode={s.couponCode} refused={refused} busy={busy} method={method} cardOff={cardOff}
          onMethod={onMethod} onPay={onPay} onBack={onBack} onNewPrice={onNewPrice} />
      </div>
    </section>
  );
}
