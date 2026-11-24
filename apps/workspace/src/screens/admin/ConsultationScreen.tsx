import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import {
  ADMIN_CANCEL_REFUSAL, adminNoShowMove, ApiError, canAdminCancelMovedNoShow, consultationAdminApi, CONSULTATION_STATUS_LABEL, doctorAdminApi, fromYmd,
  CONSULT_MODE_LABEL, isRealDate, istDateOf, MAX_ADMIN_CANCEL_REASON, MIN_ADMIN_CANCEL_REASON, movableSlot, noShowSlotFits, OBJECT_ID_PATTERN, type AdminConsultation,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, formatDateTime, formatRupees, Loading, TextArea, TextField } from '@jansetu/ui';
import { FOCUS_HOST_STYLE, usePanelFocus } from '../../components/focus.ts';
import { definitelyNotRecorded } from '../../requests.ts';
import { NoShowMove, noShowMoveSlot, type NoShowTarget } from '../../components/NoShowMove.tsx';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession } from '../../session.tsx';
import { formatYmd, useTicker } from '../doctor/doctor.tsx';
import { useOneAtATime } from '../finance/finance.tsx';
import { formatDay } from '../partner/labs.tsx';
import { useAdminScope } from './adminScope.ts';
import { BookingCloseSection } from './BookingClose.tsx';
import { consultationKind, consultationTone, paymentLabel } from './ConsultationsScreen.tsx';

/** Admin: one consultation booking, its no-show history, the one move of a no-show (Q14, WQ10b), and close and refund (WQ18, S5c). */
export function ConsultationScreen() {
  const { bookingId = '' } = useParams();
  const scope = useAdminScope('consultations');
  if (!OBJECT_ID_PATTERN.test(bookingId)) return <NoSuchConsultation />;
  // One subtree per admin and booking: an open move or picker never follows the admin to another booking.
  return <Consultation key={`${scope.identity}:${bookingId}`} bookingId={bookingId} identity={scope.identity} scopeKey={scope.key} />;
}

function NoSuchConsultation() {
  return (
    <>
      <Link className="ws-back" to="/admin/consultations"><ArrowLeft size={16} aria-hidden="true" /> Back to consultations</Link>
      <PageHeading title="Consultation" />
      <Empty title="No such consultation">Open it from the consultation list.</Empty>
    </>
  );
}

const when = (b: Pick<AdminConsultation, 'bookingDate' | 'bookingTime'>) => `${formatYmd(b.bookingDate)}, ${b.bookingTime}`;

function Consultation({ bookingId, identity, scopeKey }: { bookingId: string; identity: string; scopeKey: readonly string[] }) {
  const { api, memory } = useSession();
  const queryClient = useQueryClient();
  const key = [...scopeKey, 'one', bookingId];
  const q = useQuery({ queryKey: key, queryFn: () => consultationAdminApi(api).get(bookingId) });
  // One move at a time on this page (the central guard): a confirmation already open is refused while another runs.
  const guard = useOneAtATime('consultation');
  const now = useTicker(30_000);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const reread = () => void queryClient.invalidateQueries({ queryKey: scopeKey });
  const b = q.data;
  const slot = noShowMoveSlot(identity, bookingId);
  const move = b ? adminNoShowMove(b) : null;
  // The move is shown while it can be offered or was used, and while a move sent earlier is still unconfirmed.
  const showMove = !!b && (move === 'offer' || move === 'used' || (b.bookingKind !== 'instant' && !b.clinicDesk && !!memory.get(slot)));
  return (
    <>
      <Link className="ws-back" to="/admin/consultations"><ArrowLeft size={16} aria-hidden="true" /> Back to consultations</Link>
      <PageHeading title={b ? `Consultation on ${when(b)}` : 'Consultation'}>{b?.doctorName ? `With ${b.doctorName}` : null}</PageHeading>
      {notice && <Alert tone="ok">{notice}</Alert>}
      {failure && <Alert>{failure}</Alert>}
      {q.isPending ? <Loading label="Loading consultation…" />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : (
          <>
            <section className="ws-section" aria-labelledby="cs-h">
              <h2 id="cs-h">Booking</h2>
              <dl className="ws-dl">
                <dt>Status</dt><dd><Badge tone={consultationTone(q.data.status)}>{CONSULTATION_STATUS_LABEL[q.data.status] ?? q.data.status}</Badge></dd>
                <dt>Appointment</dt><dd>{when(q.data)}</dd>
                <dt>Doctor</dt><dd>{q.data.doctorName || '—'}</dd>
                <dt>Kind</dt><dd>{consultationKind(q.data)}</dd>
                <dt>Patient</dt>
                <dd>
                  {q.data.patientName?.trim()
                    ? <>{q.data.patientName.trim()} <span className="ws-muted">({q.data.dependentId ? 'a family member of the account holder' : 'the account holder'})</span></>
                    : q.data.dependentId ? 'A family member of the account holder' : 'The account holder'}
                </dd>
                <dt>Payment</dt><dd>{paymentLabel(q.data)}{typeof q.data.price === 'number' && q.data.paymentStatus === 'paid' ? ` · ${formatRupees(q.data.price)}` : ''}</dd>
                {q.data.cancellationReason && <><dt>Cancellation reason</dt><dd>{q.data.cancellationReason}</dd></>}
                {q.data.createdAt && <><dt>Booked</dt><dd>{formatDateTime(q.data.createdAt)}</dd></>}
              </dl>
            </section>
            {/* WQ18 (S5c): close and refund a consultation whose doctor is not verified and active. */}
            <BookingCloseSection b={q.data} bookingId={bookingId} scopeKey={scopeKey} perform={guard.perform} busy={guard.busy || q.isFetching}
              readNow={async () => { const fresh = await consultationAdminApi(api).get(bookingId); queryClient.setQueryData(key, fresh); return fresh; }}
              reread={reread} />
            <section className="ws-section" aria-labelledby="ns-h">
              <h2 id="ns-h">No-show</h2>
              <NoShowHistory b={q.data} />
              {q.data.status === 'no_show' && (
                <p className="ws-muted">A no-show is not refunded and the doctor earns nothing for it. It may be moved once to a later time at the same price.</p>
              )}
              {move === 'instant' && <p className="ws-muted">An instant consultation is never moved to a new time.</p>}
              {move === 'clinic' && <p className="ws-muted">The clinic moves this appointment: it was booked at its front desk.</p>}
              {q.data.noShowCancel && q.data.status === 'cancelled' && (
                <p className="ws-muted">
                  Cancelled by the Jansetu team after its move{q.data.noShowCancel.at ? ` (${formatDateTime(q.data.noShowCancel.at)})` : ''}:
                  {q.data.noShowCancel.refund ? ' the patient was refunded to their Jansetu wallet.' : ' not refunded; the payment stays and nobody earns it.'}
                </p>
              )}
              {canAdminCancelMovedNoShow(q.data) && (
                <AdminCancel key={q.data.updatedAt ?? ''} b={q.data} perform={guard.perform} busy={guard.busy || q.isFetching}
                  cancel={(input) => consultationAdminApi(api).cancelMovedNoShow(bookingId, input)}
                  readNow={async () => { const fresh = await consultationAdminApi(api).get(bookingId); queryClient.setQueryData(key, fresh); return fresh; }}
                  reread={reread}
                  onNotice={(t) => { setFailure(null); setNotice(t); }}
                  onFailure={(t) => { setNotice(null); setFailure(t); }} />
              )}
              {showMove && (
                <NoShowMove slot={slot} who="The patient" missed={when(q.data)} state={move === 'used' ? 'used' : 'offer'} status={q.data.status}
                  readAt={q.dataUpdatedAt} reading={q.isFetching} disabled={guard.busy || q.isFetching} version={q.data.updatedAt}
                  consequence={<>The patient and the doctor are told the new time. The doctor earns for it only once it is completed.</>}
                  picker={(choose) => <AdminSlotPicker b={q.data} now={now} scopeKey={scopeKey} onChoose={choose} />}
                  send={(t: NoShowTarget, requestKey) => guard.perform(() =>
                    doctorAdminApi(api).rescheduleNoShow(bookingId, t.slotId, requestKey, typeof t.version === 'string' ? t.version : undefined))}
                  reread={reread}
                  onNotice={(t) => { setFailure(null); setNotice(t); }}
                  onFailure={(t) => { setNotice(null); setFailure(t); }}
                  onSlotRefused={() => void queryClient.invalidateQueries({ queryKey: [...scopeKey, 'slots'] })} />
              )}
            </section>
          </>
        )}
    </>
  );
}

/** When it was missed and where it went (the server's scrubbed view: never who marked or moved it). */
function NoShowHistory({ b }: { b: AdminConsultation }) {
  const events: { at: string; text: string }[] = [];
  const moved = b.noShows?.[0];
  if (moved?.at) events.push({ at: moved.at, text: `Marked as a no-show${moved.fromDate ? ` (missed ${formatYmd(moved.fromDate)}${moved.fromTime ? `, ${moved.fromTime}` : ''})` : ''}` });
  if (moved?.rescheduledAt) events.push({ at: moved.rescheduledAt, text: `Moved once to a new time${b.noShows!.length === 1 ? ` (now ${when(b)})` : ''}. A second no-show is final.` });
  if (b.status === 'no_show' && b.noShow?.at) events.push({ at: b.noShow.at, text: `Marked as a no-show (${when(b)})${moved ? ': final, it was already moved once' : ''}` });
  if (events.length === 0) return <p className="ws-muted">{b.status === 'no_show' ? 'Marked as a no-show.' : 'This booking has no no-show.'}</p>;
  events.sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
  return (
    <ol className="ws-timeline" aria-label="No-show history">
      {events.map((e, i) => <li key={i}><time dateTime={e.at}>{formatDateTime(e.at)}</time><span>{e.text}</span></li>)}
    </ol>
  );
}

/**
 * The booking's own doctor's open, not-yet-started slots on a chosen day, offered for its consultation type
 * (`GET /slots/available`), for the one move of a no-show. In-person bookings move to clinic slots, others to slots without
 * a clinic branch; the server decides finally (SLOT_NOT_AVAILABLE, SLOT_STARTED, SAME_SLOT, and Q15 SLOT_NOT_THIS_DOCTOR
 * when the time belongs to another doctor).
 */
function AdminSlotPicker({ b, now, scopeKey, onChoose }: { b: AdminConsultation; now: Date; scopeKey: readonly string[]; onChoose: (t: NoShowTarget | null) => void }) {
  const { api } = useSession();
  const [day, setDay] = useState(() => istDateOf(now));
  const [slotId, setSlotId] = useState('');
  const ok = isRealDate(day);
  const doctor = b.specialistId && OBJECT_ID_PATTERN.test(b.specialistId) ? b.specialistId : null;
  const slots = useQuery({
    queryKey: [...scopeKey, 'slots', doctor, day, b.consultationMode ?? ''],
    queryFn: () => consultationAdminApi(api).freeSlots(doctor!, day, b.consultationMode),
    enabled: ok && !!doctor,
  });
  if (!doctor) return <p className="ws-muted">This booking names no doctor, so it cannot be moved here.</p>;
  const inPerson = b.consultationMode === 'in-person';
  // WQ11d: as the doctor's own picker (`noShowSlotFits`): the booking's consultation type and place; each time names it.
  const choices = (slots.data ?? []).filter((s) => s._id !== b.slotId && movableSlot(s, now) && noShowSlotFits(s, b)
    && (!s.specialistId || s.specialistId === doctor));
  const where = (s: { branchId?: string }) => (!s.branchId ? (inPerson ? 'the doctor’s own place' : 'online') : 'the clinic it was booked at');
  const mode = b.consultationMode ? CONSULT_MODE_LABEL[b.consultationMode] ?? b.consultationMode : null;
  return (
    <>
      <p className="ws-muted">
        Times {mode ? `for ${mode.toLowerCase()} consultations ` : ''}at {inPerson ? (b.clinicVisit?.branchId ? 'the clinic it was booked at' : 'the doctor’s own place') : 'no clinic (online)'}, as booked.
      </p>
      <TextField label="New day" type="date" value={day} min={istDateOf(now)} error={ok ? undefined : 'Enter a real date.'}
        onChange={(e) => { setDay(e.target.value); setSlotId(''); onChoose(null); }} />
      {!ok ? null
        : slots.isPending ? <Loading label="Loading the doctor’s free times…" />
        : slots.isError ? <ErrorState message={messageOf(slots.error)} onRetry={() => void slots.refetch()} />
        : choices.length === 0 ? <p className="ws-muted">{b.doctorName || 'The doctor'} has no free time that day{inPerson ? ' at a clinic' : ''}. Choose another day.</p>
        : (
          <div className="j-field">
            <label htmlFor={`admin-noshow-slot-${b._id}`}>New time</label>
            <select id={`admin-noshow-slot-${b._id}`} value={slotId} onChange={(e) => {
              setSlotId(e.target.value);
              const s = choices.find((x) => x._id === e.target.value);
              const iso = s ? fromYmd(s.date) : null;
              onChoose(s ? { slotId: s._id, label: `${iso ? formatDay(iso) : s.date}, ${s.startTime} (${where(s)})` } : null);
            }}>
              <option value="">Choose a time</option>
              {choices.map((s) => <option key={s._id} value={s._id}>{s.startTime}–{s.endTime} · {where(s)}</option>)}
            </select>
          </div>
        )}
    </>
  );
}

/**
 * Q16a (owner, 22 Nov 2026): "Cancel (admin)" for a booking moved after a no-show that its doctor cannot attend. The
 * admin gives a reason and chooses, explicitly (no default), whether the patient is refunded; the confirmation says what
 * each choice does with the money, and that the patient and the doctor are told. One step at a time on this page; the
 * booking is read again after every answer. A lost answer is settled by reading it: cancelled = done. Q16a final: a
 * repeat of the command is refused 409 ALREADY_CANCELLED (never refunded twice); that is said as "already cancelled,
 * nothing more was done", with how it was cancelled as read now. Keyed by the booking's version, so a confirmation
 * never outlives a change to the booking.
 */
function AdminCancel({ b, perform, busy, cancel, readNow, reread, onNotice, onFailure }: {
  b: AdminConsultation; perform: <T>(run: () => Promise<T>) => Promise<T>; busy: boolean;
  cancel: (input: { reason: string; refund: boolean }) => Promise<AdminConsultation & { refunded?: number }>;
  readNow: () => Promise<AdminConsultation>; reread: () => void; onNotice: (text: string) => void;
  /** Shown by the page: this panel is keyed by the booking's version and may be gone once the booking is read again. */
  onFailure: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [refund, setRefund] = useState<'yes' | 'no' | ''>('');
  const [errors, setErrors] = useState<{ reason?: string; refund?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const host = usePanelFocus<HTMLSpanElement>(open ? 'open' : 'closed');
  const paid = typeof b.price === 'number' && b.paymentStatus === 'paid' ? formatRupees(b.price) : 'what the patient paid';
  const done = (refunded: boolean, amount?: number) => `The appointment was cancelled${refunded
    ? `; ${typeof amount === 'number' && amount > 0 ? formatRupees(amount) : 'the payment'} is back in the patient’s Jansetu wallet`
    : ' without a refund: the payment stays with Jansetu and nobody earns it'}. The patient and the doctor are told.`;

  async function submit() {
    const r = reason.trim();
    const errs: { reason?: string; refund?: string } = {};
    if (r.length < MIN_ADMIN_CANCEL_REASON) errs.reason = `Give a reason (at least ${MIN_ADMIN_CANCEL_REASON} characters).`;
    else if (r.length > MAX_ADMIN_CANCEL_REASON) errs.reason = `Use at most ${MAX_ADMIN_CANCEL_REASON} characters.`;
    if (!refund) errs.refund = 'Choose whether the patient is refunded.';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const choice = refund === 'yes';
    setError(null);
    setSending(true);
    try {
      await perform(async () => {
        try {
          const after = await cancel({ reason: r, refund: choice });
          onNotice(done(after.noShowCancel ? after.noShowCancel.refund : choice, after.refunded));
          if (live.current) setOpen(false);
        } catch (err) {
          if (err instanceof ApiError && err.code === 'ALREADY_CANCELLED') {
            // An earlier try of this admin (its answer lost) or another admin cancelled it: nothing more was done.
            const now = await readNow().catch(() => null);
            const how = now?.noShowCancel ? (now.noShowCancel.refund ? ', with a refund to the patient’s Jansetu wallet' : ', without a refund') : '';
            onNotice(`This appointment was already cancelled${how}: nothing more was done.`);
            if (live.current) setOpen(false);
            return;
          }
          if (definitelyNotRecorded(err)) {
            onFailure(`Not cancelled: ${(err instanceof ApiError && err.code && ADMIN_CANCEL_REFUSAL[err.code]) || (err instanceof Error ? err.message : String(err))}`);
            if (live.current) setOpen(false);
            return;
          }
          // The answer was lost: the booking as read now tells whether it was cancelled.
          const now = await readNow().catch(() => null);
          if (now?.status === 'cancelled') { onNotice(done(now.noShowCancel ? now.noShowCancel.refund : choice)); if (live.current) setOpen(false); return; }
          onFailure(`Not confirmed: ${err instanceof Error ? err.message : String(err)} The booking is shown as saved now; cancel it again if it still has to be cancelled (it is never cancelled or refunded twice).`);
        } finally {
          reread();
        }
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (live.current) setSending(false);
    }
  }

  return (
    <span ref={host} style={FOCUS_HOST_STYLE}>
      {!open ? (
        <div className="ws-actions">
          <Button variant="secondary" disabled={busy} onClick={() => { setOpen(true); setError(null); setErrors({}); }}>Cancel (admin)</Button>
          <span className="ws-muted">Moved once after a no-show: only the Jansetu team cancels it, for example when the doctor cannot attend.</span>
        </div>
      ) : (
        <div className="confirm" role="group" aria-label="Cancel (admin)">
          <div className="confirm-text">
            Cancel the patient’s appointment on {formatYmd(b.bookingDate)}, {b.bookingTime}{b.doctorName ? ` with ${b.doctorName}` : ''}? Its seat and the
            doctor’s time are freed at once, and the patient and the doctor are told. This cannot be undone.
          </div>
          <TextArea label="Reason (the patient sees this)" value={reason} maxLength={MAX_ADMIN_CANCEL_REASON} error={errors.reason}
            onChange={(e) => setReason(e.target.value)} />
          <fieldset className="ws-checks" aria-describedby={errors.refund ? 'admin-cancel-refund-err' : undefined}>
            <legend>Refund the patient?</legend>
            <label className="ws-check">
              <input type="radio" name="admin-cancel-refund" checked={refund === 'yes'} onChange={() => setRefund('yes')} />
              {' '}Yes: {paid} goes back to the patient’s Jansetu wallet (as when a doctor cancels).
            </label>
            <label className="ws-check">
              <input type="radio" name="admin-cancel-refund" checked={refund === 'no'} onChange={() => setRefund('no')} />
              {' '}No: the payment stays with Jansetu, as for a no-show, and nobody earns it.
            </label>
            {errors.refund && <span id="admin-cancel-refund-err" className="j-field__error">{errors.refund}</span>}
          </fieldset>
          {error && <Alert>{error}</Alert>}
          <div className="confirm-actions">
            <Button variant="danger" busy={sending} disabled={busy && !sending} onClick={() => void submit()}>Cancel the appointment</Button>
            <Button variant="ghost" data-focus-back disabled={sending} onClick={() => { setOpen(false); setError(null); }}>Back</Button>
          </div>
        </div>
      )}
    </span>
  );
}
