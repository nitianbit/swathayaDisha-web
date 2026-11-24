import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ArrowLeft, FileText } from 'lucide-react';
import {
  ApiError, assistedRefusal, canBookerCancel, canBookerReschedule, isAssistedBooking, typedNameTarget, formatSlotDate, joinWords, medicineName,
  bookingPaidBy, bookingPayBy, bookingWasPaid, LATE_PAYMENT_BACK, orderFromBooking, PATIENT_LANGUAGES, payByWords, pharmacyAssistedApi, pharmacyStockApi, requestKeysApi, rxOrderProblems, type BookedConsultation,
  type Medicine, type RefundTo, type RxMedicine, type RxOrderRequest,
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

/**
 * WQ12: one consultation this pharmacy booked (`GET /pharmacy-bookings/:id`): join, cancel, the dispensing copy, an order.
 * WQ13: change its time (same doctor) and correct the name the pharmacy typed for the patient.
 * WQ16: a card booking waiting for its payment ("Pay now" on its one order); a cancel of a card-paid booking chooses where
 * the money goes back (`refundTo`) and says the refund's state.
 */
export function BookedConsultationScreen() {
  const { bookingId = '' } = useParams();
  const pharmacyId = usePharmacyId();
  return (
    <>
      <Link to="/pharmacy/consultations" className="ws-back"><ArrowLeft size={16} aria-hidden="true" /> Booked consultations</Link>
      <PageHeading title="Consultation" />
      <Detail key={`${pharmacyId}:${bookingId}`} pharmacyId={pharmacyId} bookingId={bookingId} />
    </>
  );
}

const languageWords = (code: string | undefined) => PATIENT_LANGUAGES.find((l) => l.code === code)?.label ?? code;

function Detail({ pharmacyId, bookingId }: { pharmacyId: string; bookingId: string }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const valid = /^[0-9a-fA-F]{24}$/.test(bookingId);
  const q = useQuery({
    queryKey: ['pharmacy-bookings', pharmacyId, 'one', bookingId],
    queryFn: () => pharmacyAssistedApi(api).booking(bookingId),
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
    void queryClient.invalidateQueries({ queryKey: ['pharmacy-bookings', pharmacyId] });
    void queryClient.invalidateQueries({ queryKey: ['pharmacy-wallet', pharmacyId] });
  };

  if (!valid || (q.isError && q.error instanceof ApiError && q.error.status === 404 && q.error.code === 'BOOKING_NOT_FOUND')) {
    return <Empty title="Consultation not found"><Link to="/pharmacy/consultations">See all booked consultations</Link></Empty>;
  }
  if (q.isPending) return <Loading label="Loading the consultation…" />;
  if (q.isError) return <ErrorState message={assistedRefusal(q.error).message} onRetry={() => void q.refetch()} />;
  const b = q.data;
  const assistedRow = isAssistedBooking(b);
  const nameTarget = typedNameTarget(b);
  const joinUrl = b.virtualMeeting?.joinUrl && /^https:\/\//.test(b.virtualMeeting.joinUrl) ? b.virtualMeeting.joinUrl : null;
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
      <section className="ws-section" aria-labelledby="bk-h">
        <h2 id="bk-h">Booking</h2>
        <dl className="ws-dl">
          {b.assisted?.shortRef && <><dt>Reference</dt><dd>{b.assisted.shortRef}</dd></>}
          <dt>Status</dt><dd>{statusWords(b)}<BookingBadges b={b} /></dd>
          <dt>Patient</dt>
          <dd>
            {b.patientName ?? '—'}
            {assistedRow && b.dependentId && <span className="ws-muted"> (a family member on the phone owner’s account: only the phone’s owner can change this name, in their Jansetu app)</span>}
          </dd>
          <dt>Doctor</dt><dd>{b.doctorName ?? '—'}</dd>
          <dt>When</dt><dd>{formatSlotDate(b.bookingDate)}{b.bookingTime ? ` at ${b.bookingTime}` : ''}</dd>
          <dt>How</dt><dd>{modeWords(b.consultationMode)}</dd>
          {assistedRow && b.status !== 'cancelled' && <><dt>How the patient joins</dt><dd>{joinWords(String(b.consultationMode ?? ''), b.assisted?.join?.on)}</dd></>}
          {/* WQ16c: "paid" only when the server says the money was taken (captured, refunded or forfeited). */}
          {assistedRow && typeof b.price === 'number' && (waiting
            ? <><dt>Price</dt><dd>{formatRupees(b.price)} (not paid yet)</dd></>
            : !bookingWasPaid(b) ? <><dt>Price</dt><dd>{formatRupees(b.price)} (not paid)</dd></>
            : <><dt>{paidBy === 'card' ? 'Paid by card or UPI' : paidBy === 'wallet' ? 'Paid from your wallet' : 'Amount paid'}</dt><dd>{formatRupees(b.price)}</dd></>)}
          {b.assisted?.preferredLanguage && <><dt>Language</dt><dd>{languageWords(b.assisted.preferredLanguage)}</dd></>}
          {b.primaryConcern && <><dt>Problem</dt><dd>{b.primaryConcern}</dd></>}
          {b.status === 'cancelled' && <><dt>Cancelled</dt><dd>{b.cancellationCause === 'patient' ? 'By the patient' : b.cancellationCause === 'booker' ? 'By your pharmacy' : b.cancellationCause === 'doctor' ? 'By the doctor' : b.cancellationCause === 'admin' ? 'By Jansetu' : b.cancellationCause === 'payment_timeout' ? 'Payment was not completed in time' : '—'}{b.cancellationReason ? `: ${b.cancellationReason}` : ''}</dd></>}
        </dl>
        {b.assisted?.disputed?.state === 'open' && (
          <Alert tone="warn">The account holder told Jansetu this booking is not theirs. Jansetu is looking into it.</Alert>
        )}
        {joinUrl && (
          <p><a className="j-btn j-btn--primary" href={joinUrl} target="_blank" rel="noopener noreferrer">Join call</a> Open it on this device with the patient next to you.</p>
        )}
      </section>

      {payNote && <Alert tone={payNote.tone}>{payNote.text}</Alert>}
      {waiting && !cancelNote && (
        <section className="ws-section" aria-labelledby="pay-h">
          <h2 id="pay-h">Payment</h2>
          {cardKey || recordId ? (
            <CardPaymentPanel source={consultationCardSource(api, b._id, cardKey)} paymentTransactionId={recordId} order={orderFromBooking(b)} payBy={payBy} amountMinor={typeof b.price === 'number' ? Math.round(b.price * 100) : undefined}
              perform={guard.perform} busy={guard.busy}
              onPaid={(_b, note) => { setPayNote({ tone: 'ok', text: `Paid. The consultation is booked. The patient and the doctor are told.${note ? ` ${note}` : ''}` }); changed(); void q.refetch(); }}
              onEnded={(words) => { cards.forget(b._id); setPayNote({ tone: 'error', text: words }); changed(); void q.refetch(); }} />
          ) : (
            <Alert tone="warn">
              <strong>Waiting for payment.</strong> {payByWords(payBy)}
              {' '}It can be paid only in the browser tab where it was booked (the payment is kept there, not in this tab). If it is not paid, book again when the time is released.
            </Alert>
          )}
        </section>
      )}

      {assistedRow && nameTarget && <CorrectName pharmacyId={pharmacyId} booking={b} target={nameTarget} guard={guard} onChanged={changed} />}

      {moveNote && !cancelNote && <Alert tone="ok">{moveNote}</Alert>}
      {canBookerReschedule(b) && !cancelNote && <ChangeTime pharmacyId={pharmacyId} booking={b} guard={guard} onChanged={changed} onDone={setMoveNote} />}

      {cancelNote && <Alert tone="ok">{cancelNote}</Alert>}
      {canBookerCancel(b) && !cancelNote && <CancelBooking pharmacyId={pharmacyId} booking={b} guard={guard} onChanged={changed} paidBy={paidBy} waiting={waiting}
        captured={!b.payment || b.payment.state === 'captured'}
        onDone={(w) => { setMoveNote(null); setPayNote(null); setCancelNote(w); if (cardKey) cards.forget(b._id); }} />}

      <Prescription pharmacyId={pharmacyId} booking={b} onRetry={() => void q.refetch()} />
    </>
  );
}

// ── Cancel ──

interface PendingCancel { bookingId: string; reason?: string; expectedUpdatedAt?: string; label: string; refundTo?: RefundTo }

/**
 * `POST /pharmacy-assisted/bookings/:id/cancel`: any time before the start, full refund to the wallet. Sending it again
 * is safe (a cancelled booking answers `alreadyCancelled`, before any version check), so an unknown outcome is resent.
 */
function CancelBooking({ pharmacyId, booking, guard, onChanged, onDone, paidBy, waiting, captured }: {
  pharmacyId: string; booking: BookedConsultation; guard: BookingGuard; onChanged: () => void; onDone: (words: string) => void;
  /** WQ16b: from the booker view's `payment` (r10c); `unknown` only on an older server for a booking not made on this device. */
  paidBy: 'card' | 'wallet' | 'unknown';
  /** The server says the money was taken (`payment.state: 'captured'`; assumed on an older server). */
  captured: boolean;
  /** WQ16: a card booking not paid yet: nothing is refunded. */
  waiting: boolean;
}) {
  const { api } = useSession();
  const assisted = pharmacyAssistedApi(api);
  return (
    <CardAwareCancel<PendingCancel, BookedConsultation> slot={`assisted-cancel:${pharmacyId}:${booking._id}`} label="Cancel this consultation"
      what="consultation" when={`${formatSlotDate(booking.bookingDate)} at ${booking.bookingTime}`} introLead="You can cancel any time before the consultation starts."
      amount={typeof booking.price === 'number' ? formatRupees(booking.price) : 'The amount'} told="The patient and the doctor are told."
      paidBy={paidBy} waiting={waiting} captured={captured} version={booking.updatedAt} perform={guard.perform} busy={guard.busy}
      makeBody={(reason, refundTo) => ({ bookingId: booking._id, ...(reason ? { reason } : {}), ...(booking.updatedAt ? { expectedUpdatedAt: booking.updatedAt } : {}),
        label: booking.doctorName ?? '', ...(refundTo ? { refundTo } : {}) })}
      send={(b) => assisted.cancel(b.bookingId, { ...(b.reason ? { reason: b.reason } : {}), ...(b.expectedUpdatedAt ? { expectedUpdatedAt: b.expectedUpdatedAt } : {}),
        ...(b.refundTo ? { refundTo: b.refundTo } : {}) })}
      refusalWords={(err) => assistedRefusal(err).message}
      onChanged={onChanged}
      isCancelled={async () => { const now = await assisted.booking(booking._id); return now.status === 'cancelled' ? now : null; }}
      // WQ16c: a restored cancellation's choice is not kept here, so no destination is named.
      checkedWords={(body, restored) => (waiting ? `Cancelled. It was not paid, so nothing is refunded. ${LATE_PAYMENT_BACK}`
        : restored && paidBy === 'card' ? 'Cancelled. The amount goes back the way chosen.'
        : body?.refundTo === 'wallet' ? 'Cancelled. The amount goes back to your Jansetu wallet. See it under Wallet.'
        : paidBy === 'card' ? 'Cancelled. The amount goes back to the card or UPI it was paid with.'
        : paidBy === 'wallet' ? 'Cancelled. The amount is back in your Jansetu wallet.'
        : 'Cancelled. The amount goes back the way it was paid: to your Jansetu wallet, or to the card or UPI.')}
      onDone={onDone} />
  );
}

// ── The dispensing copy ──

function Prescription({ pharmacyId, booking, onRetry }: { pharmacyId: string; booking: BookedConsultation; onRetry: () => void }) {
  const p = booking.prescription;
  const { open, opening, error: fileError, preview } = useDocumentViewer();

  if (!p) {
    return (
      <section className="ws-section" aria-labelledby="rx-h">
        <h2 id="rx-h">Prescription</h2>
        <p className="ws-muted">
          {booking.status === 'completed'
            ? 'No prescription to show. The doctor may not have written one, or it is more than 90 days old.'
            : 'The doctor writes the prescription during or after the consultation. It shows here when it is ready.'}
        </p>
      </section>
    );
  }

  const medicines = p.medicines ?? [];
  return (
    <section className="ws-section" aria-labelledby="rx-h">
      <h2 id="rx-h">Prescription (dispensing copy)</h2>
      <p className="ws-muted">
        Medicines, advice and tests only: the diagnosis is not shown to pharmacies.
        {p.prescribedBySpecialistName ? ` Written by ${p.prescribedBySpecialistName}` : ''}{p.prescribedAt ? ` on ${formatDateTime(p.prescribedAt)}` : ''}.
      </p>
      {medicines.length > 0 ? (
        <div className="ws-table-wrap">
          <table className="j-table">
            <caption className="j-sr-only">Prescribed medicines</caption>
            <thead><tr><th scope="col">Medicine</th><th scope="col">Dose</th><th scope="col">How often</th><th scope="col">How long</th><th scope="col">Instructions</th></tr></thead>
            <tbody>
              {medicines.map((m, i) => (
                <tr key={i}><td>{m.name}</td><td>{m.dosage ?? '—'}</td><td>{m.frequency ?? '—'}</td><td>{m.duration ?? '—'}</td><td>{m.instructions ?? '—'}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p>No medicines prescribed.</p>}
      {p.advice && <p><strong>Advice:</strong> {p.advice}</p>}
      {(p.testsAdvised ?? []).length > 0 && <p><strong>Tests advised:</strong> {(p.testsAdvised ?? []).join(', ')}</p>}
      <div className="ws-actions">
        {p.fileUrls[0] ? (
          <Button variant="secondary" busy={opening !== null} onClick={() => void open(p.fileUrls[0]!)}><FileText size={16} aria-hidden="true" /> Open the prescription copy</Button>
        ) : p.copyPending ? (
          <>
            <span className="ws-muted">The printable copy is being made. Try again in a minute.</span>
            <Button variant="secondary" onClick={onRetry}>Check again</Button>
          </>
        ) : null}
      </div>
      {fileError && <Alert>Could not open the copy: {fileError}</Alert>}
      <DocumentPreview preview={preview} title="Prescription copy" noun="copy" fileName="prescription-copy" />
      {medicines.length > 0 && <RxOrder pharmacyId={pharmacyId} booking={booking} medicines={medicines} />}
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
      finished(r.value.order._id, r.value.replayed ? 'This order was already made. Nothing was ordered twice.' : 'Order made.');
      return;
    }
    if (r.kind === 'unknown' && wasAbandoned(r.error)) { settle(p.requestKey); setReview(null); setRefused('This order was given up earlier, so it was not made. Make it again.'); return; }
    if (r.kind === 'refused') { setReview(null); setRefused(assistedRefusal(r.error).message); }
  }

  async function giveUp(p: PendingOp<PendingRxOrder>) {
    setGivingUp(true);
    setResendError(null);
    try {
      const r = await perform(() => keys.abandon('pharmacy_rx_order', p.requestKey));
      if (r.state === 'used' && r.record?._id) { settle(p.requestKey); finished(r.record._id, 'The order was made. Nothing was ordered twice.'); return; }
      // Only `abandoned` means given up; any other answer leaves it unknown (the panel stays).
      if (r.state !== 'abandoned') { setResendError('It could not be given up yet. Check whether it was recorded, then try again.'); return; }
      settle(p.requestKey);
      setRefused('Given up: that order was not made and can never be made now. You can make the order again.');
    } catch (err) {
      setResendError(assistedRefusal(err).message);
    } finally {
      setGivingUp(false);
    }
  }

  if (done) {
    return <Alert tone="ok">{done.text} <Link to={`/pharmacy/orders/${done.orderId}`}>Open the order</Link>. The patient pays at your counter.</Alert>;
  }

  if (op && !(busy && !givingUp && op.attempts === 1 && !op.uncertain)) {
    const restored = !!op.restored || !op.body;
    return (
      <>
        {resendError && <Alert>{resendError}</Alert>}
        <CheckPanel label="Unconfirmed medicine order"
          onCheck={async () => {
            const r = await keys.lookup('pharmacy_rx_order', op.requestKey);
            if (r.state === 'used' && r.record?._id) { settle(op.requestKey); finished(r.record._id, 'The order was made. Nothing was ordered twice.'); return null; }
            if (r.state === 'abandoned') { settle(op.requestKey); setRefused('That order was given up, so it was not made. You can make it again.'); return null; }
            return 'Not made so far. It may still be on its way. Sending the same order again is safe: it is never made twice.';
          }}
          resend={restored ? undefined : {
            label: 'Send the same request again', busy: busy && !givingUp,
            onClick: () => { setResendError(null); void sendOrder(op).catch((err: unknown) => setResendError(assistedRefusal(err).message)); },
          }}
          giveUp={{ label: 'Give this up', busy: givingUp, onClick: () => void giveUp(op) }}>
          <Alert tone="warn">
            {restored
              ? 'A medicine order made earlier on this device was not confirmed. Its details are not kept here. Check it, or give it up.'
              : `The outcome of this request is not known yet${op.error ? ` (${op.error})` : ''}. The order may already be made. Sending the same request again is safe: it is never made twice.`}
          </Alert>
          {!restored && op.body && <ul className="ws-list">{op.body.words.map((w) => <li key={w}>{w}</li>)}</ul>}
        </CheckPanel>
      </>
    );
  }

  if (!open) {
    return (
      <div className="ws-actions">
        <Button onClick={() => setOpen(true)}>Make a medicine order from this prescription</Button>
        {refused && <Alert>{refused}</Alert>}
      </div>
    );
  }

  return (
    <form className="rx-form ws-section" noValidate onSubmit={check} aria-labelledby="rxo-h">
      <h3 id="rxo-h">Medicine order from this prescription</h3>
      <p className="ws-muted">For each prescribed medicine, choose the one you will give and how many. Leave out any you do not have. The order is for pickup at your counter, paid at the counter.</p>
      <fieldset className="ws-frozen" disabled={!!review || busy}>
        {medicines.map((m, i) => (
          <RxLine key={i} pharmacyId={pharmacyId} prescribed={m} line={lines[i]!} onChange={(l) => setLine(i, l)} />
        ))}
        <TextField label="Note for the order (optional)" value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
      </fieldset>
      {problem && <Alert>{problem}</Alert>}
      {refused && <Alert>Not made: {refused}</Alert>}
      {!review ? (
        <div className="ws-actions">
          <Button type="submit">Check the order</Button>
          <Button variant="ghost" onClick={() => setOpen(false)}>Close</Button>
        </div>
      ) : (
        <div className="confirm" role="group" aria-label="Make this order">
          <div className="confirm-text">Make an order for:</div>
          <ul className="ws-list">{review.words.map((w) => <li key={w}>{w}</li>)}</ul>
          <span className="ws-muted">Prices come from your stock. The order appears under Orders.</span>
          <div className="confirm-actions">
            <Button busy={busy} onClick={() => { const { requestKey, ...pending } = review; void sendOrder(startOp(requestKey, pending)).catch((err: unknown) => setRefused(assistedRefusal(err).message)); }}>Make the order</Button>
            <Button variant="ghost" disabled={busy} onClick={() => setReview(null)}>Back</Button>
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
          <TextField label="Units" inputMode="numeric" value={line.qty} onChange={(e) => onChange({ qty: e.target.value.replace(/\D/g, '') })} />
          <Button variant="ghost" onClick={() => onChange({ medicine: null, qty: '' })}>Change</Button>
        </div>
      ) : (
        <>
          <div className="ws-search">
            <TextField label={`Find the medicine for ${prescribed.name}`} value={text} onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (text.trim()) setSearch(text.trim()); } }} />
            <Button variant="secondary" onClick={() => { if (text.trim()) setSearch(text.trim()); }}>Search</Button>
          </div>
          {search === null ? <span className="ws-muted">Not added yet.</span>
            : q.isPending ? <Loading label="Searching medicines…" />
            : q.isError ? <ErrorState message={assistedRefusal(q.error).message} onRetry={() => void q.refetch()} />
            : q.data.items.length === 0 ? <span className="ws-muted">No medicine matches “{search}”. Try another name, or leave it out.</span>
            : (
              <ul className="ws-list" aria-label={`Medicines found for ${prescribed.name}`}>
                {q.data.items.map((m) => (
                  <li key={m._id} className="ws-actions">
                    <span>{medicineName(m)}{m.dosageForm ? ` · ${m.dosageForm}` : ''}</span>
                    <Button variant="secondary" aria-label={`Choose ${medicineName(m)}`} onClick={() => onChange({ medicine: m, qty: line.qty || '1' })}>Choose</Button>
                  </li>
                ))}
              </ul>
            )}
        </>
      )}
    </fieldset>
  );
}
