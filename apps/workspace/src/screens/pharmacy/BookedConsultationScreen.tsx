import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ArrowLeft, FileText } from 'lucide-react';
import {
  ApiError, assistedRefusal, canBookerCancel, canBookerReschedule, isAssistedBooking, typedNameTarget, formatSlotDate, joinWords, medicineName,
  bookingPaidBy, bookingPayBy, formatRecommendationCode, bookingWasPaid, LATE_PAYMENT_BACK, orderFromBooking, PATIENT_LANGUAGES, payByWords, pharmacyAssistedApi, pharmacyStockApi, requestKeysApi, rxOrderProblems, type BookedConsultation,
  type BookerKind, type Medicine, type RefundTo, type RxMedicine, type RxOrderRequest,
} from '@jansetu/api';
import { Alert, Button, Empty, ErrorState, formatDateTime, formatRupees, Loading, TextField } from '@jansetu/ui';
import { PageHeading } from '../../PageHeading.tsx';
import { newRequestKey, startOp, wasAbandoned, type PendingOp } from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { useOneAtATime } from '../finance/finance.tsx';
import { BookingBadges, modeWords, statusWords, waitingForCard } from './BookedConsultationsScreen.tsx';
import { CardPaymentPanel, consultationCardSource, useCardBookings } from './cardBooking.tsx';
import { ChangeTime, CorrectName, type BookingGuard } from './BookingChanges.tsx';
import { DocumentPreview, useDocumentViewer } from './documentViewer.tsx';
import { CardAwareCancel } from './ownedCancel.tsx';
import { CheckPanel, useOwnedOp, usePharmacyId } from './ownedOp.tsx';
import { pharmacyConsultBooker, type ConsultBooker } from './consultBooker.ts';
import { RefreshFailed } from '../doctor/doctor.tsx';
import { t } from '../../i18n/pharmacy/index.ts';

/**
 * WQ12: one consultation this pharmacy booked (`GET /pharmacy-bookings/:id`): join, cancel, the dispensing copy, an order.
 * WQ13: change its time (same doctor) and correct the name the pharmacy typed for the patient.
 * WQ16: a card booking waiting for its payment ("Pay now" on its one order); a cancel of a card-paid booking chooses where
 * the money goes back (`refundTo`) and says the refund's state.
 * WQ24: the same page for a lab member (`BookedConsultationDetail` with the lab's booker); a lab has no typed-name edit
 * (r21 F6) and no medicine order.
 */
export function BookedConsultationScreen() {
  const { bookingId = '' } = useParams();
  const pharmacyId = usePharmacyId();
  const { api } = useSession();
  return (
    <>
      <Link to="/pharmacy/consultations" className="ws-back"><ArrowLeft size={16} aria-hidden="true" />{t('bookedConsultation.bookedConsultations')}</Link>
      <PageHeading title={t('bookedConsultation.consultation')} />
      <BookedConsultationDetail key={`${pharmacyId}:${bookingId}`} booker={pharmacyConsultBooker(api, pharmacyId)} bookingId={bookingId} />
    </>
  );
}

const languageWords = (code: string | undefined) => PATIENT_LANGUAGES.find((l) => l.code === code)?.label ?? code;

export function BookedConsultationDetail({ booker, bookingId }: { booker: ConsultBooker; bookingId: string }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const pharmacyId = booker.id;
  const org = booker.kind;
  const valid = /^[0-9a-fA-F]{24}$/.test(bookingId);
  const q = useQuery({
    queryKey: [...booker.bookingsKey, 'one', bookingId],
    queryFn: () => booker.api.booking(bookingId),
    enabled: valid,
    retry: (n, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && n < 2,
  });
  // Kept here: once cancelled, the re-read booking no longer offers the cancel section that said so.
  const [cancelNote, setCancelNote] = useState<string | null>(null);
  const [moveNote, setMoveNote] = useState<string | null>(null);
  const [payNote, setPayNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const cards = useCardBookings(pharmacyId);
  // One change of this booking at a time: cancel, change time and the name share this guard.
  const guard: BookingGuard = useOneAtATime('booking');
  const changed = () => {
    void queryClient.invalidateQueries({ queryKey: booker.bookingsKey });
    void queryClient.invalidateQueries({ queryKey: booker.wallet.queryKey });
  };

  if (!valid || (q.isError && q.error instanceof ApiError && q.error.status === 404 && q.error.code === 'BOOKING_NOT_FOUND')) {
    return <Empty title={t('bookedConsultation.consultationNotFound')}><Link to={booker.paths.list}>{t('bookedConsultation.seeAllBookedConsultations')}</Link></Empty>;
  }
  // WQ24b: gated on the data: a failed read again (on focus, after a UPI app) keeps the page and its payment panel, with a note.
  if (!q.data) return q.isError ? <ErrorState message={booker.refusal(q.error).message} onRetry={() => void q.refetch()} /> : <Loading label={t('common.loadingTheConsultation')} />;
  const b = q.data;
  const assistedRow = isAssistedBooking(b);
  // r21 F6: a lab has no typed-name edit.
  const nameTarget = org === 'pharmacy' ? typedNameTarget(b) : null;
  // WQ16b: how it was paid comes from the booker view's `payment` (r10c); on an older server, a card booking made on this
  // device is known by its remembered key. The key also gives the open order back for "Pay now".
  const waiting = assistedRow && waitingForCard(b);
  const cardKey = assistedRow ? cards.keyOf(b._id) : null;
  const fromServer = bookingPaidBy(b);
  const paidBy: 'card' | 'wallet' | 'unknown' = fromServer !== 'unknown' ? fromServer : cardKey ? 'card' : 'unknown';
  const payBy = bookingPayBy(b);
  const recordId = b.payment?.paymentTransactionId ?? null;

  return (
    <>
      {q.isError && <RefreshFailed error={q.error} readAt={q.dataUpdatedAt} onRetry={() => q.refetch()} />}
      <section className="ws-section" aria-labelledby="bk-h">
        <h2 id="bk-h">{t('common.booking')}</h2>
        <dl className="ws-dl">
          {b.assisted?.shortRef && <><dt>{t('common.reference')}</dt><dd>{b.assisted.shortRef}</dd></>}
          <dt>{t('common.status')}</dt><dd>{statusWords(b)}<BookingBadges b={b} /></dd>
          <dt>{t('common.patient2')}</dt>
          <dd>
            {b.patientName ?? '—'}
            {assistedRow && b.dependentId && <span className="ws-muted">{t('bookedConsultation.aFamilyMemberOnThe')}</span>}
          </dd>
          <dt>{t('common.doctor2')}</dt><dd>{b.doctorName ?? '—'}</dd>
          <dt>{t('common.when')}</dt><dd>{formatSlotDate(b.bookingDate)}{b.bookingTime ? ` at ${b.bookingTime}` : ''}</dd>
          <dt>{t('common.how')}</dt><dd>{modeWords(b.consultationMode)}</dd>
          {assistedRow && b.status !== 'cancelled' && <><dt>{t('bookedConsultation.howThePatientJoins')}</dt><dd>{joinWords(String(b.consultationMode ?? ''), b.assisted?.join?.on, org)}</dd></>}
          {/* WQ16c: "paid" only when the server says the money was taken (captured, refunded or forfeited). */}
          {assistedRow && typeof b.price === 'number' && (waiting
            ? <><dt>{t('bookedConsultation.price')}</dt><dd>{formatRupees(b.price)}{t('bookedConsultation.notPaidYet')}</dd></>
            : !bookingWasPaid(b) ? <><dt>{t('bookedConsultation.price')}</dt><dd>{formatRupees(b.price)}{t('bookedConsultation.notPaid')}</dd></>
            : <><dt>{paidBy === 'card' ? t('common.paidByCardOrUpi') : paidBy === 'wallet' ? t('common.paidFromYourWallet') : t('bookedConsultation.amountPaid')}</dt><dd>{formatRupees(b.price)}</dd></>)}
          {b.assisted?.preferredLanguage && <><dt>{t('bookedConsultation.language')}</dt><dd>{languageWords(b.assisted.preferredLanguage)}</dd></>}
          {b.primaryConcern && <><dt>{t('bookedConsultation.problem')}</dt><dd>{b.primaryConcern}</dd></>}
          {b.status === 'cancelled' && <><dt>{t('common.cancelled')}</dt><dd>{b.cancellationCause === 'patient' ? t('common.byThePatient') : b.cancellationCause === 'booker' ? t(`bookedConsultation.byYour.${org}`) : b.cancellationCause === 'doctor' ? t('bookedConsultation.byTheDoctor') : b.cancellationCause === 'admin' ? t('common.byJansetu') : b.cancellationCause === 'payment_timeout' ? t('bookedConsultation.paymentWasNotCompletedIn') : '—'}{b.cancellationReason ? `: ${b.cancellationReason}` : ''}</dd></>}
        </dl>
        {b.assisted?.disputed?.state === 'open' && (
          <Alert tone="warn">{t('common.theAccountHolderToldJansetu')}</Alert>
        )}
        <JoinCall b={b} />
      </section>

      {payNote && <Alert tone={payNote.tone}>{payNote.text}</Alert>}
      {waiting && !cancelNote && (
        <section className="ws-section" aria-labelledby="pay-h">
          <h2 id="pay-h">{t('common.payment')}</h2>
          {cardKey || recordId ? (
            <CardPaymentPanel source={consultationCardSource(api, b._id, cardKey, booker)} paymentTransactionId={recordId} order={orderFromBooking(b)} payBy={payBy} amountMinor={typeof b.price === 'number' ? Math.round(b.price * 100) : undefined}
              perform={guard.perform} busy={guard.busy}
              onPaid={(_b, note) => { setPayNote({ tone: 'ok', text: t('bookedConsultation.paidTheConsultationIsBooked', { value: note ? ` ${note}` : '' }) }); changed(); void q.refetch(); }}
              onEnded={(words) => { cards.forget(b._id); setPayNote({ tone: 'error', text: words }); changed(); void q.refetch(); }} />
          ) : (
            <Alert tone="warn">
              <strong>{t('common.waitingForPayment')}</strong> {payByWords(payBy)}
              {' '}{t('bookedConsultation.itCanBePaidOnly')}</Alert>
          )}
        </section>
      )}

      {assistedRow && nameTarget && <CorrectName pharmacyId={pharmacyId} booking={b} target={nameTarget} guard={guard} onChanged={changed} />}

      {moveNote && !cancelNote && <Alert tone="ok">{moveNote}</Alert>}
      {canBookerReschedule(b) && !cancelNote && (!booker.branches || booker.branches.length > 0)
        && <ChangeTime booker={booker} booking={b} guard={guard} onChanged={changed} onDone={setMoveNote} />}

      {cancelNote && <Alert tone="ok">{cancelNote}</Alert>}
      {canBookerCancel(b) && !cancelNote && <CancelBooking booker={booker} booking={b} guard={guard} onChanged={changed} paidBy={paidBy} waiting={waiting}
        captured={!b.payment || b.payment.state === 'captured'}
        onDone={(w) => { setMoveNote(null); setPayNote(null); setCancelNote(w); if (cardKey) cards.forget(b._id); }} />}

      <Prescription pharmacyId={pharmacyId} org={org} booking={b} onRetry={() => void q.refetch()} />
    </>
  );
}

// ── Cancel ──

interface PendingCancel { bookingId: string; reason?: string; expectedUpdatedAt?: string; label: string; refundTo?: RefundTo }

/**
 * `POST /pharmacy-assisted/bookings/:id/cancel`: any time before the start, full refund to the wallet. Sending it again
 * is safe (a cancelled booking answers `alreadyCancelled`, before any version check), so an unknown outcome is resent.
 */
function CancelBooking({ booker, booking, guard, onChanged, onDone, paidBy, waiting, captured }: {
  booker: ConsultBooker; booking: BookedConsultation; guard: BookingGuard; onChanged: () => void; onDone: (words: string) => void;
  /** WQ16b: from the booker view's `payment` (r10c); `unknown` only on an older server for a booking not made on this device. */
  paidBy: 'card' | 'wallet' | 'unknown';
  /** The server says the money was taken (`payment.state: 'captured'`; assumed on an older server). */
  captured: boolean;
  /** WQ16: a card booking not paid yet: nothing is refunded. */
  waiting: boolean;
}) {
  const assisted = booker.api;
  return (
    <CardAwareCancel<PendingCancel, BookedConsultation> slot={`assisted-cancel:${booker.id}:${booking._id}`} label={t('bookedConsultation.cancelThisConsultation')}
      what={t('bookedConsultation.consultation2')} when={`${formatSlotDate(booking.bookingDate)} at ${booking.bookingTime}`} introLead={t('bookedConsultation.youCanCancelAnyTime')}
      amount={typeof booking.price === 'number' ? formatRupees(booking.price) : t('common.theAmount')} told={t('bookedConsultation.thePatientAndTheDoctor')}
      paidBy={paidBy} waiting={waiting} captured={captured} version={booking.updatedAt} perform={guard.perform} busy={guard.busy}
      makeBody={(reason, refundTo) => ({ bookingId: booking._id, ...(reason ? { reason } : {}), ...(booking.updatedAt ? { expectedUpdatedAt: booking.updatedAt } : {}),
        label: booking.doctorName ?? '', ...(refundTo ? { refundTo } : {}) })}
      send={(b) => assisted.cancel(b.bookingId, { ...(b.reason ? { reason: b.reason } : {}), ...(b.expectedUpdatedAt ? { expectedUpdatedAt: b.expectedUpdatedAt } : {}),
        ...(b.refundTo ? { refundTo: b.refundTo } : {}) })}
      refusalWords={(err) => booker.refusal(err).message}
      onChanged={onChanged}
      isCancelled={async () => { const now = await assisted.booking(booking._id); return now.status === 'cancelled' ? now : null; }}
      // WQ16c: a restored cancellation's choice is not kept here, so no destination is named.
      checkedWords={(body, restored) => (waiting ? t('common.cancelledItWasNotPaid', { LATE_PAYMENT_BACK })
        : restored && paidBy === 'card' ? t('common.cancelledTheAmountGoesBack')
        : body?.refundTo === 'wallet' ? t('common.cancelledTheAmountGoesBack2')
        : paidBy === 'card' ? t('common.cancelledTheAmountGoesBack3')
        : paidBy === 'wallet' ? t('common.cancelledTheAmountIsBack')
        : t('bookedConsultation.cancelledTheAmountGoesBack4'))}
      onDone={onDone} />
  );
}

// ── The dispensing copy ──

function Prescription({ pharmacyId, org, booking, onRetry }: { pharmacyId: string; org: BookerKind; booking: BookedConsultation; onRetry: () => void }) {
  const p = booking.prescription;
  const { open, opening, error: fileError, preview } = useDocumentViewer();

  if (!p) {
    return (
      <section className="ws-section" aria-labelledby="rx-h">
        <h2 id="rx-h">{t('common.prescription')}</h2>
        <p className="ws-muted">
          {booking.status === 'completed'
            ? t('bookedConsultation.noPrescriptionToShowThe')
            : t('bookedConsultation.theDoctorWritesThePrescription')}
        </p>
      </section>
    );
  }

  const medicines = p.medicines ?? [];
  return (
    <section className="ws-section" aria-labelledby="rx-h">
      <h2 id="rx-h">{t('bookedConsultation.prescriptionDispensingCopy')}</h2>
      <p className="ws-muted">{t(`bookedConsultation.diagnosisNotShown.${org}`)}
        {p.prescribedBySpecialistName ? t('bookedConsultation.writtenBy', { prescribedBySpecialistName: p.prescribedBySpecialistName }) : ''}{p.prescribedAt ? ` on ${formatDateTime(p.prescribedAt)}` : ''}.
      </p>
      {medicines.length > 0 ? (
        <div className="ws-table-wrap">
          <table className="j-table">
            <caption className="j-sr-only">{t('bookedConsultation.prescribedMedicines')}</caption>
            <thead><tr><th scope={'col'}>{t('common.medicine')}</th><th scope={'col'}>{t('bookedConsultation.dose')}</th><th scope={'col'}>{t('bookedConsultation.howOften')}</th><th scope={'col'}>{t('bookedConsultation.howLong')}</th><th scope={'col'}>{t('bookedConsultation.instructions')}</th></tr></thead>
            <tbody>
              {medicines.map((m, i) => (
                <tr key={i}><td>{m.name}</td><td>{m.dosage ?? '—'}</td><td>{m.frequency ?? '—'}</td><td>{m.duration ?? '—'}</td><td>{m.instructions ?? '—'}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p>{t('bookedConsultation.noMedicinesPrescribed')}</p>}
      {p.advice && <p><strong>{t('bookedConsultation.advice')}</strong> {p.advice}</p>}
      {(p.testsAdvised ?? []).length > 0 && <p><strong>{t('bookedConsultation.testsAdvised')}</strong> {(p.testsAdvised ?? []).join(', ')}</p>}
      {/* WQ21 (r16): the code the patient shows to book these tests (here, at Book lab test). */}
      {p.recommendationCode && <p><strong>{t('bookedConsultation.recommendedTestsCode')}</strong> {formatRecommendationCode(p.recommendationCode)}</p>}
      <div className="ws-actions">
        {p.fileUrls[0] ? (
          <Button variant="secondary" busy={opening !== null} onClick={() => void open(p.fileUrls[0]!)}><FileText size={16} aria-hidden="true" />{t('bookedConsultation.openThePrescriptionCopy')}</Button>
        ) : p.copyPending ? (
          <>
            <span className="ws-muted">{t('bookedConsultation.thePrintableCopyIsBeing')}</span>
            <Button variant="secondary" onClick={onRetry}>{t('bookedConsultation.checkAgain')}</Button>
          </>
        ) : null}
      </div>
      {fileError && <Alert>{t('bookedConsultation.couldNotOpenTheCopy')}{fileError}</Alert>}
      <DocumentPreview preview={preview} title={t('bookedConsultation.prescriptionCopy')} noun={t('bookedConsultation.copy')} fileName={t('bookedConsultation.prescriptionCopy2')} />
      {org === 'pharmacy' && medicines.length > 0 && <RxOrder pharmacyId={pharmacyId} booking={booking} medicines={medicines} />}
    </section>
  );
}

// ── Medicine order from the prescription (phase 0, §18.3) ──

interface Line { medicine: Medicine | null; qty: string }
interface PendingRxOrder { request: RxOrderRequest; words: string[] }

function RxOrder({ pharmacyId, booking, medicines }: { pharmacyId: string; booking: BookedConsultation; medicines: RxMedicine[] }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const assisted = pharmacyAssistedApi(api);
  const keys = requestKeysApi(api);
  const { op, send, settle } = useOwnedOp<PendingRxOrder>(`rx-order:${pharmacyId}:${booking._id}`);
  const { perform, busy } = useOneAtATime('order');
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<Line[]>(() => medicines.map(() => ({ medicine: null, qty: '' })));
  const [notes, setNotes] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [review, setReview] = useState<({ requestKey: string } & PendingRxOrder) | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [done, setDone] = useState<{ orderId: string; text: string } | null>(null);
  const [givingUp, setGivingUp] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);

  const setLine = (i: number, l: Partial<Line>) => setLines((all) => all.map((x, j) => (j === i ? { ...x, ...l } : x)));

  function check(e: FormEvent) {
    e.preventDefault();
    setRefused(null);
    const why = rxOrderProblems(lines.map((l) => ({ medicineId: l.medicine?._id ?? '', qty: l.qty })));
    setProblem(why);
    if (why) return;
    const chosen = lines.filter((l) => l.medicine);
    const requestKey = newRequestKey();
    setReview({
      requestKey,
      request: {
        prescriptionFromBookingId: booking._id, requestKey, orderType: 'in_store', paymentMode: 'in_store_payment', deliveryMode: 'pickup', isWalkIn: true,
        items: chosen.map((l) => ({ medicineId: l.medicine!._id, medicineName: medicineName(l.medicine!), orderedQty: Number(l.qty) })),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      },
      words: chosen.map((l) => `${l.qty} × ${medicineName(l.medicine!)}`),
    });
  }

  const finished = (orderId: string, text: string) => {
    setReview(null);
    setOpen(false);
    setDone({ orderId, text });
    void queryClient.invalidateQueries({ queryKey: ['pharmacy-orders'] });
  };

  async function sendOrder(p: PendingOp<PendingRxOrder>) {
    const r = await perform(() => send(p, (b) => assisted.orderFromPrescription(b.request)));
    if (r.kind === 'stale') return;
    if (r.kind === 'ok') {
      finished(r.value.order._id, r.value.replayed ? t('bookedConsultation.thisOrderWasAlreadyMade') : t('bookedConsultation.orderMade'));
      return;
    }
    if (r.kind === 'unknown' && wasAbandoned(r.error)) { settle(p.requestKey); setReview(null); setRefused(t('bookedConsultation.thisOrderWasGivenUp')); return; }
    if (r.kind === 'refused') { setReview(null); setRefused(assistedRefusal(r.error).message); }
  }

  async function giveUp(p: PendingOp<PendingRxOrder>) {
    setGivingUp(true);
    setResendError(null);
    try {
      const r = await perform(() => keys.abandon('pharmacy_rx_order', p.requestKey));
      if (r.state === 'used' && r.record?._id) { settle(p.requestKey); finished(r.record._id, t('bookedConsultation.theOrderWasMadeNothing')); return; }
      // Only `abandoned` means given up; any other answer leaves it unknown (the panel stays).
      if (r.state !== 'abandoned') { setResendError(t('common.itCouldNotBeGiven')); return; }
      settle(p.requestKey);
      setRefused(t('bookedConsultation.givenUpThatOrderWas'));
    } catch (err) {
      setResendError(assistedRefusal(err).message);
    } finally {
      setGivingUp(false);
    }
  }

  if (done) {
    return <Alert tone="ok">{done.text} <Link to={`/pharmacy/orders/${done.orderId}`}>{t('bookedConsultation.openTheOrder')}</Link>{t('bookedConsultation.thePatientPaysAtYour')}</Alert>;
  }

  if (op && !(busy && !givingUp && op.attempts === 1 && !op.uncertain)) {
    const restored = !!op.restored || !op.body;
    return (
      <>
        {resendError && <Alert>{resendError}</Alert>}
        <CheckPanel label={t('bookedConsultation.unconfirmedMedicineOrder')}
          onCheck={async () => {
            const r = await keys.lookup('pharmacy_rx_order', op.requestKey);
            if (r.state === 'used' && r.record?._id) { settle(op.requestKey); finished(r.record._id, t('bookedConsultation.theOrderWasMadeNothing')); return null; }
            if (r.state === 'abandoned') { settle(op.requestKey); setRefused(t('bookedConsultation.thatOrderWasGivenUp')); return null; }
            return t('bookedConsultation.notMadeSoFarIt');
          }}
          resend={restored ? undefined : {
            label: t('common.sendTheSameRequestAgain'), busy: busy && !givingUp,
            onClick: () => { setResendError(null); void sendOrder(op).catch((err: unknown) => setResendError(assistedRefusal(err).message)); },
          }}
          giveUp={{ label: t('common.giveThisUp'), busy: givingUp, onClick: () => void giveUp(op) }}>
          <Alert tone="warn">
            {restored
              ? t('bookedConsultation.aMedicineOrderMadeEarlier')
              : t('bookedConsultation.theOutcomeOfThisRequest', { value: op.error ? ` (${op.error})` : '' })}
          </Alert>
          {!restored && op.body && <ul className="ws-list">{op.body.words.map((w) => <li key={w}>{w}</li>)}</ul>}
        </CheckPanel>
      </>
    );
  }

  if (!open) {
    return (
      <div className="ws-actions">
        <Button onClick={() => setOpen(true)}>{t('bookedConsultation.makeAMedicineOrderFrom')}</Button>
        {refused && <Alert>{refused}</Alert>}
      </div>
    );
  }

  return (
    <form className="rx-form ws-section" noValidate onSubmit={check} aria-labelledby="rxo-h">
      <h3 id="rxo-h">{t('bookedConsultation.medicineOrderFromThisPrescription')}</h3>
      <p className="ws-muted">{t('bookedConsultation.forEachPrescribedMedicineChoose')}</p>
      <fieldset className="ws-frozen" disabled={!!review || busy}>
        {medicines.map((m, i) => (
          <RxLine key={i} pharmacyId={pharmacyId} prescribed={m} line={lines[i]!} onChange={(l) => setLine(i, l)} />
        ))}
        <TextField label={t('bookedConsultation.noteForTheOrderOptional')} value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
      </fieldset>
      {problem && <Alert>{problem}</Alert>}
      {refused && <Alert>{t('bookedConsultation.notMade')}{refused}</Alert>}
      {!review ? (
        <div className="ws-actions">
          <Button type="submit">{t('bookedConsultation.checkTheOrder')}</Button>
          <Button variant="ghost" onClick={() => setOpen(false)}>{t('common.close')}</Button>
        </div>
      ) : (
        <div className="confirm" role="group" aria-label={t('bookedConsultation.makeThisOrder')}>
          <div className="confirm-text">{t('bookedConsultation.makeAnOrderFor')}</div>
          <ul className="ws-list">{review.words.map((w) => <li key={w}>{w}</li>)}</ul>
          <span className="ws-muted">{t('bookedConsultation.pricesComeFromYourStock')}</span>
          <div className="confirm-actions">
            <Button busy={busy} onClick={() => { const { requestKey, ...pending } = review; void sendOrder(startOp(requestKey, pending)).catch((err: unknown) => setRefused(assistedRefusal(err).message)); }}>{t('bookedConsultation.makeTheOrder')}</Button>
            <Button variant="ghost" disabled={busy} onClick={() => setReview(null)}>{t('common.back')}</Button>
          </div>
        </div>
      )}
    </form>
  );
}

function RxLine({ pharmacyId, prescribed, line, onChange }: { pharmacyId: string; prescribed: RxMedicine; line: Line; onChange: (l: Partial<Line>) => void }) {
  const { api } = useSession();
  const [text, setText] = useState(prescribed.name);
  const [search, setSearch] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['pharmacy-medicines', pharmacyId, 'search', search],
    queryFn: () => pharmacyStockApi(api).medicines(search ?? ''),
    enabled: search !== null,
  });
  const detail = [prescribed.dosage, prescribed.frequency, prescribed.duration].filter(Boolean).join(' · ');
  return (
    <fieldset className="ws-line">
      <legend>{prescribed.name}{detail ? ` (${detail})` : ''}</legend>
      {line.medicine ? (
        <div className="ws-actions">
          <strong>{medicineName(line.medicine)}</strong>
          <TextField label={t('common.units')} inputMode="numeric" value={line.qty} onChange={(e) => onChange({ qty: e.target.value.replace(/\D/g, '') })} />
          <Button variant="ghost" onClick={() => onChange({ medicine: null, qty: '' })}>{t('common.change')}</Button>
        </div>
      ) : (
        <>
          <div className="ws-search">
            <TextField label={t('bookedConsultation.findTheMedicineFor', { name: prescribed.name })} value={text} onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (text.trim()) setSearch(text.trim()); } }} />
            <Button variant="secondary" onClick={() => { if (text.trim()) setSearch(text.trim()); }}>{t('common.search')}</Button>
          </div>
          {search === null ? <span className="ws-muted">{t('bookedConsultation.notAddedYet')}</span>
            : q.isPending ? <Loading label={t('common.searchingMedicines')} />
            : q.isError ? <ErrorState message={assistedRefusal(q.error).message} onRetry={() => void q.refetch()} />
            : q.data.items.length === 0 ? <span className="ws-muted">{t('bookedConsultation.noMedicineMatches')}{search}{t('bookedConsultation.tryAnotherNameOrLeave')}</span>
            : (
              <ul className="ws-list" aria-label={t('bookedConsultation.medicinesFoundFor', { name: prescribed.name })}>
                {q.data.items.map((m) => (
                  <li key={m._id} className="ws-actions">
                    <span>{medicineName(m)}{m.dosageForm ? ` · ${m.dosageForm}` : ''}</span>
                    <Button variant="secondary" aria-label={t('common.choose', { value: medicineName(m) })} onClick={() => onChange({ medicine: m, qty: line.qty || '1' })}>{t('common.choose2')}</Button>
                  </li>
                ))}
              </ul>
            )}
        </>
      )}
    </fieldset>
  );
}

/** The booking's Join call (an https link only, while the server gives one): also shown by Consult now once a doctor accepts. */
export function JoinCall({ b }: { b: Pick<BookedConsultation, 'virtualMeeting'> }) {
  const joinUrl = b.virtualMeeting?.joinUrl && /^https:\/\//.test(b.virtualMeeting.joinUrl) ? b.virtualMeeting.joinUrl : null;
  if (!joinUrl) return null;
  return <p><a className="j-btn j-btn--primary" href={joinUrl} target="_blank" rel="noopener noreferrer">{t('bookedConsultation.joinCall')}</a>{t('bookedConsultation.openItOnThisDevice')}</p>;
}
