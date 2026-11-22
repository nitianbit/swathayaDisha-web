import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ArrowLeft, FileText } from 'lucide-react';
import {
  ApiError, assistedRefusal, bookingStatusLabel, canBookerCancel, formatSlotDate, joinWords, MAX_BOOKER_CANCEL_REASON, medicineName,
  PATIENT_LANGUAGES, pharmacyAssistedApi, pharmacyStockApi, requestKeysApi, rxOrderProblems, type BookedConsultation, type CancelAnswer,
  type Medicine, type RxMedicine, type RxOrderRequest,
} from '@jansetu/api';
import { Alert, Button, Empty, ErrorState, formatDateTime, formatRupees, Loading, TextField } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { PageHeading } from '../../PageHeading.tsx';
import { newRequestKey, startOp, wasAbandoned, type PendingOp } from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { useOneAtATime } from '../finance/finance.tsx';
import { BookingBadges, modeWords } from './BookedConsultationsScreen.tsx';
import { sniffDocument } from './documents.ts';
import { CheckPanel, useOwnedOp, usePharmacyId } from './ownedOp.tsx';

/** WQ12: one consultation this pharmacy booked (`GET /pharmacy-bookings/:id`): join, cancel, the dispensing copy, an order. */
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
  const joinUrl = b.virtualMeeting?.joinUrl && /^https:\/\//.test(b.virtualMeeting.joinUrl) ? b.virtualMeeting.joinUrl : null;

  return (
    <>
      <section className="ws-section" aria-labelledby="bk-h">
        <h2 id="bk-h">Booking</h2>
        <dl className="ws-dl">
          {b.assisted?.shortRef && <><dt>Reference</dt><dd>{b.assisted.shortRef}</dd></>}
          <dt>Status</dt><dd>{bookingStatusLabel(b.status)}<BookingBadges b={b} /></dd>
          <dt>Patient</dt><dd>{b.patientName ?? '—'}</dd>
          <dt>Doctor</dt><dd>{b.doctorName ?? '—'}</dd>
          <dt>When</dt><dd>{formatSlotDate(b.bookingDate)}{b.bookingTime ? ` at ${b.bookingTime}` : ''}</dd>
          <dt>How</dt><dd>{modeWords(b.consultationMode)}</dd>
          {b.status !== 'cancelled' && <><dt>How the patient joins</dt><dd>{joinWords(String(b.consultationMode ?? ''), b.assisted?.join?.on)}</dd></>}
          {typeof b.price === 'number' && <><dt>Paid from your wallet</dt><dd>{formatRupees(b.price)}</dd></>}
          {b.assisted?.preferredLanguage && <><dt>Language</dt><dd>{languageWords(b.assisted.preferredLanguage)}</dd></>}
          {b.primaryConcern && <><dt>Problem</dt><dd>{b.primaryConcern}</dd></>}
          {b.status === 'cancelled' && <><dt>Cancelled</dt><dd>{b.cancellationCause === 'patient' ? 'By the patient' : b.cancellationCause === 'booker' ? 'By your pharmacy' : b.cancellationCause === 'doctor' ? 'By the doctor' : b.cancellationCause === 'admin' ? 'By Jansetu' : '—'}{b.cancellationReason ? `: ${b.cancellationReason}` : ''}</dd></>}
        </dl>
        {b.assisted?.disputed?.state === 'open' && (
          <Alert tone="warn">The account holder told Jansetu this booking is not theirs. Jansetu is looking into it.</Alert>
        )}
        {joinUrl && (
          <p><a className="j-btn j-btn--primary" href={joinUrl} target="_blank" rel="noopener noreferrer">Join call</a> Open it on this device with the patient next to you.</p>
        )}
      </section>

      {cancelNote && <Alert tone="ok">{cancelNote}</Alert>}
      {canBookerCancel(b) && !cancelNote && <CancelBooking pharmacyId={pharmacyId} booking={b} onChanged={changed} onDone={setCancelNote} />}

      <Prescription pharmacyId={pharmacyId} booking={b} onRetry={() => void q.refetch()} />
    </>
  );
}

// ── Cancel ──

interface PendingCancel { bookingId: string; reason?: string; expectedUpdatedAt?: string; label: string }

/**
 * `POST /pharmacy-assisted/bookings/:id/cancel`: any time before the start, full refund to the wallet. Sending it again
 * is safe (a cancelled booking answers `alreadyCancelled`, before any version check), so an unknown outcome is resent.
 */
function CancelBooking({ pharmacyId, booking, onChanged, onDone }: {
  pharmacyId: string; booking: BookedConsultation; onChanged: () => void; onDone: (words: string) => void;
}) {
  const { api } = useSession();
  const assisted = pharmacyAssistedApi(api);
  const { op, send, settle } = useOwnedOp<PendingCancel>(`assisted-cancel:${pharmacyId}:${booking._id}`);
  const { perform, busy } = useOneAtATime('booking');
  const [resendError, setResendError] = useState<string | null>(null);

  const doneWords = (a: CancelAnswer) => (a.alreadyCancelled
    ? 'It was already cancelled. Nothing was refunded twice.'
    : `Cancelled. ${formatRupees(a.refundedMinor / 100)} is back in your Jansetu wallet. The patient and the doctor are told.`);

  async function sendCancel(p: PendingOp<PendingCancel>) {
    const r = await perform(() => send(p, (b) => assisted.cancel(b.bookingId, { ...(b.reason ? { reason: b.reason } : {}), ...(b.expectedUpdatedAt ? { expectedUpdatedAt: b.expectedUpdatedAt } : {}) })));
    if (r.kind === 'stale') return;
    if (r.kind === 'ok') { onDone(doneWords(r.value)); onChanged(); return; }
    if (r.kind === 'refused') { onChanged(); throw new Error(assistedRefusal(r.error).message); }
  }

  if (op && !(busy && op.attempts === 1 && !op.uncertain)) {
    const restored = !!op.restored || !op.body;
    return (
      <section className="ws-section" aria-labelledby="cancel-h">
        <h2 id="cancel-h">Cancel</h2>
        {resendError && <Alert>{resendError}</Alert>}
        <CheckPanel label="Unconfirmed cancellation"
          onCheck={async () => {
            const now = await assisted.booking(booking._id);
            if (now.status === 'cancelled') {
              settle(op.requestKey);
              onDone('Cancelled. The amount is back in your Jansetu wallet.');
              onChanged();
              return null;
            }
            return 'Not cancelled so far. It may still be on its way. Sending the same cancellation again is safe: the money is never refunded twice.';
          }}
          resend={restored ? undefined : {
            label: 'Send the same request again', busy,
            onClick: () => { setResendError(null); void sendCancel(op).catch((err: unknown) => setResendError(err instanceof Error ? err.message : String(err))); },
          }}
          forget={{ label: 'Forget it', confirmLabel: 'Yes, forget it', onForget: () => settle(op.requestKey),
            consequence: 'If the earlier cancellation still arrives, the booking is cancelled and the money comes back to your wallet. You can cancel again from here.' }}>
          <Alert tone="warn">
            {restored
              ? 'A cancellation made earlier on this device was not confirmed. Check whether the booking was cancelled.'
              : `The outcome of this request is not known yet${op.error ? ` (${op.error})` : ''}. The booking may already be cancelled. Sending the same request again is safe.`}
          </Alert>
        </CheckPanel>
      </section>
    );
  }

  return (
    <section className="ws-section" aria-labelledby="cancel-h">
      <h2 id="cancel-h">Cancel</h2>
      <p className="ws-muted">You can cancel any time before the consultation starts. The full amount goes back to your Jansetu wallet.</p>
      <ConfirmAction label="Cancel this consultation" danger confirmLabel="Yes, cancel it" reason="optional" reasonLabel="Why? (optional)"
        maxReason={MAX_BOOKER_CANCEL_REASON} version={booking.updatedAt}
        consequence={`The consultation on ${formatSlotDate(booking.bookingDate)} at ${booking.bookingTime} is cancelled. ${typeof booking.price === 'number' ? formatRupees(booking.price) : 'The amount'} goes back to your wallet; give the patient their money back. The patient and the doctor are told.`}
        onConfirm={async (reason) => {
          await sendCancel(startOp(newRequestKey(), { bookingId: booking._id, ...(reason.trim() ? { reason: reason.trim() } : {}),
            ...(booking.updatedAt ? { expectedUpdatedAt: booking.updatedAt } : {}), label: booking.doctorName ?? '' }));
        }} />
    </section>
  );
}

// ── The dispensing copy ──

function Prescription({ pharmacyId, booking, onRetry }: { pharmacyId: string; booking: BookedConsultation; onRetry: () => void }) {
  const { api } = useSession();
  const p = booking.prescription;
  const [preview, setPreview] = useState<{ url: string; kind: 'pdf' | 'image' | 'other' } | null>(null);
  const [opening, setOpening] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const fetching = useRef<AbortController | null>(null);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);
  useEffect(() => () => fetching.current?.abort(), []);

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

  async function open(url: string) {
    fetching.current?.abort();
    const ctrl = new AbortController();
    fetching.current = ctrl;
    setOpening(true);
    setFileError(null);
    try {
      const blob = await pharmacyAssistedApi(api).file(url, ctrl.signal);
      const { kind, type } = await sniffDocument(blob);
      if (ctrl.signal.aborted) return;
      setPreview({ url: URL.createObjectURL(new Blob([blob], { type })), kind });
    } catch (err) {
      if (!ctrl.signal.aborted) setFileError(assistedRefusal(err).message);
    } finally {
      if (fetching.current === ctrl) setOpening(false);
    }
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
          <Button variant="secondary" busy={opening} onClick={() => void open(p.fileUrls[0]!)}><FileText size={16} aria-hidden="true" /> Open the prescription copy</Button>
        ) : p.copyPending ? (
          <>
            <span className="ws-muted">The printable copy is being made. Try again in a minute.</span>
            <Button variant="secondary" onClick={onRetry}>Check again</Button>
          </>
        ) : null}
      </div>
      {fileError && <Alert>Could not open the copy: {fileError}</Alert>}
      {preview && (
        <div className="rx-preview-wrap">
          <div className="rx-preview">
            {preview.kind === 'pdf' ? (
              <div className="rx-pdf">
                <iframe src={preview.url} title="Prescription copy" />
                <a href={preview.url} target="_blank" rel="noopener">Open the copy in a new tab (to print)</a>
              </div>
            ) : preview.kind === 'image' ? <img src={preview.url} alt="Prescription copy" />
              : <a href={preview.url} download="prescription-copy">Download the copy</a>}
          </div>
        </div>
      )}
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
      settle(p.requestKey);
      if (r.state === 'used' && r.record?._id) finished(r.record._id, 'The order was made. Nothing was ordered twice.');
      else setRefused('Given up: that order was not made and can never be made now. You can make the order again.');
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
