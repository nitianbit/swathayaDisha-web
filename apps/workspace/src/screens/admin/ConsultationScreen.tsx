import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import {
  adminNoShowMove, consultationAdminApi, CONSULTATION_STATUS_LABEL, doctorAdminApi, fromYmd, isRealDate, istDateOf, movableSlot,
  OBJECT_ID_PATTERN, type AdminConsultation,
} from '@jansetu/api';
import { Alert, Badge, Empty, ErrorState, formatDateTime, formatRupees, Loading, TextField } from '@jansetu/ui';
import { NoShowMove, noShowMoveSlot, type NoShowTarget } from '../../components/NoShowMove.tsx';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession } from '../../session.tsx';
import { formatYmd, useTicker } from '../doctor/doctor.tsx';
import { useOneAtATime } from '../finance/finance.tsx';
import { formatDay } from '../partner/labs.tsx';
import { useAdminScope } from './adminScope.ts';
import { consultationKind, consultationTone, paymentLabel } from './ConsultationsScreen.tsx';

/** Admin: one consultation booking, its no-show history, and the one move of a no-show (Q14, WQ10b). */
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
            <section className="ws-section" aria-labelledby="ns-h">
              <h2 id="ns-h">No-show</h2>
              <NoShowHistory b={q.data} />
              {q.data.status === 'no_show' && (
                <p className="ws-muted">A no-show is not refunded and the doctor earns nothing for it. It may be moved once to a later time at the same price.</p>
              )}
              {move === 'instant' && <p className="ws-muted">An instant consultation is never moved to a new time.</p>}
              {move === 'clinic' && <p className="ws-muted">The clinic moves this appointment: it was booked at its front desk.</p>}
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
  const choices = (slots.data ?? []).filter((s) => s._id !== b.slotId && movableSlot(s, now) && (inPerson ? !!s.branchId : !s.branchId)
    && (!s.specialistId || s.specialistId === doctor));
  return (
    <>
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
              onChoose(s ? { slotId: s._id, label: `${iso ? formatDay(iso) : s.date}, ${s.startTime}` } : null);
            }}>
              <option value="">Choose a time</option>
              {choices.map((s) => <option key={s._id} value={s._id}>{s.startTime}–{s.endTime}</option>)}
            </select>
          </div>
        )}
    </>
  );
}
