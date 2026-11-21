import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError, APPOINTMENT_STATUS_LABEL, appointmentActions, appointmentRefusal, CONSULT_MODE_LABEL, doctorNoShowMove, fromYmd, isRealDate, istDateOf,
  movableSlot, noShowSlotFits, schedulableBranches, type AppointmentAction, type DoctorAppointment, type DoctorSlot,
} from '@jansetu/api';
import { Alert, Badge, Empty, ErrorState, Loading, TextField, formatRupees } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { NoShowMove, noShowMoveSlot, type NoShowTarget } from '../../components/NoShowMove.tsx';
import { useSession } from '../../session.tsx';
import { useOneAtATime } from '../finance/finance.tsx';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { formatDay } from '../partner/labs.tsx';
import {
  appointmentsKey, formatYmd, MeetLink, NotADoctor, RefreshFailed, sortAppointments, useClinics, useDoctor, useMeetPoll, useTicker, useUpcomingAppointments,
  type DoctorContext,
} from './doctor.tsx';

type MeetPoll = ReturnType<typeof useMeetPoll>;

const UPCOMING_DAYS = 14;
type View = 'today' | 'upcoming' | 'day';

/** The doctor's consultations (specialist portal routes) with the status commands the server accepts. */
export function AppointmentsScreen() {
  const d = useDoctor();
  if (!d) return <NotADoctor />;
  return <Appointments key={d.identity} d={d} />;
}

function Appointments({ d }: { d: DoctorContext }) {
  const [view, setView] = useState<View>('today');
  const [day, setDay] = useState(() => istDateOf(new Date()));
  return (
    <>
      <PageHeading title="Appointments">Your consultations, scheduled and instant. Times are India time.</PageHeading>
      <div className="ws-search">
        <div className="j-field ws-filter">
          <label htmlFor="appt-view">Show</label>
          <select id="appt-view" value={view} onChange={(e) => setView(e.target.value as View)}>
            <option value="today">Today</option>
            <option value="upcoming">Next {UPCOMING_DAYS} days</option>
            <option value="day">One day</option>
          </select>
        </div>
        {view === 'day' && <TextField label="Day" type="date" value={day} onChange={(e) => setDay(e.target.value)} />}
      </div>
      {view === 'day' ? (isRealDate(day) ? <DayList key={day} d={d} day={day} /> : <Empty title="Choose a day">Pick the day to show.</Empty>)
        : <UpcomingList key={view} d={d} days={view === 'today' ? 1 : UPCOMING_DAYS} />}
    </>
  );
}

function UpcomingList({ d, days }: { d: DoctorContext; days: number }) {
  // A just-accepted instant consultation's call link arrives after it: read again (bounded) while one is missing.
  const meet = useMeetPoll();
  const q = useUpcomingAppointments(d, days, meet.interval);
  if (q.pending) return <Loading label="Loading appointments…" />;
  if (q.error) return <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />;
  return (
    <>
      {q.refreshError && <RefreshFailed error={q.refreshError} readAt={q.readAt} onRetry={q.refetch} />}
      <AppointmentTable d={d} items={q.items} meet={meet} refresh={q.refetch} readAt={q.readAt} reading={q.fetching}
        empty={days === 1 ? 'No appointments today.' : `No appointments in the next ${days} days.`} />
    </>
  );
}

function DayList({ d, day }: { d: DoctorContext; day: string }) {
  const meet = useMeetPoll();
  const q = useQuery({ queryKey: [...appointmentsKey(d), 'day', day], queryFn: () => d.api.appointmentsOn(day), refetchInterval: (query) => meet.interval(query.state.data) });
  if (q.isPending) return <Loading label="Loading appointments…" />;
  if (q.isError && q.data === undefined) return <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />;
  return (
    <>
      {q.isError && <RefreshFailed error={q.error} readAt={q.dataUpdatedAt} onRetry={q.refetch} />}
      <AppointmentTable d={d} items={sortAppointments(q.data ?? [])} meet={meet} refresh={q.refetch} readAt={q.dataUpdatedAt} reading={q.isFetching}
        empty={`No appointments on ${formatDay(day)}.`} />
    </>
  );
}

const statusTone = (s: DoctorAppointment['status']) => (s === 'completed' ? 'ok' : s === 'cancelled' || s === 'no_show' ? 'danger' : s === 'pending' ? 'warn' : undefined);
export const appointmentLabel = (b: DoctorAppointment) => `${formatYmd(b.bookingDate)}, ${b.bookingTime}`;

function AppointmentTable({ d, items, empty, meet, refresh, readAt, reading }: {
  d: DoctorContext; items: DoctorAppointment[]; empty: string; meet: MeetPoll; refresh: () => Promise<unknown>; readAt: number; reading: boolean;
}) {
  const queryClient = useQueryClient();
  const now = useTicker(30_000);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // Q14: one no-show move at a time on this page (the central guard).
  const guard = useOneAtATime('appointment list');
  const changed = (message: string) => { setFailure(null); setNotice(message); void queryClient.invalidateQueries({ queryKey: appointmentsKey(d) }); };
  const move: MoveProps = {
    readAt, reading, busy: guard.busy, now, perform: guard.perform,
    reread: () => void queryClient.invalidateQueries({ queryKey: appointmentsKey(d) }),
    onNotice: (t) => { setFailure(null); setNotice(t); }, onFailure: (t) => { setNotice(null); setFailure(t); },
  };
  // The notice of a move stays visible even when the moved booking left this list (it may have been the only one).
  const alerts = <>{notice && <Alert tone="ok">{notice}</Alert>}{failure && <Alert>{failure}</Alert>}</>;
  if (items.length === 0) return <>{alerts}<Empty title="Nothing here">{empty}</Empty></>;
  return (
    <>
      {alerts}
      <div className="ws-table-wrap">
        <table className="j-table" aria-label="Appointments">
          <thead>
            <tr><th scope="col">When</th><th scope="col">Kind</th><th scope="col">Type</th><th scope="col">Concern</th><th scope="col">Status</th><th scope="col">Payment</th><th scope="col">Actions</th></tr>
          </thead>
          <tbody>
            {items.map((b) => (
              // Keyed by status too: once the booking moves on, an open confirmation for its old state is gone.
              <Row key={`${b._id}:${b.status}:${b.updatedAt ?? ''}`} d={d} b={b} actions={appointmentActions(b, now)} onChanged={changed} move={move}
                link={<MeetLink b={b} gaveUp={meet.gaveUp(b._id, now)} onRefresh={() => { meet.restart(b._id); return refresh(); }} />}
                onRefused={() => void queryClient.invalidateQueries({ queryKey: appointmentsKey(d) })} />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

interface MoveProps {
  readAt: number; reading: boolean; busy: boolean; now: Date; perform: <T>(run: () => Promise<T>) => Promise<T>;
  reread: () => void; onNotice: (t: string) => void; onFailure: (t: string) => void;
}

function Row({ d, b, actions, link, onChanged, onRefused, move }: {
  d: DoctorContext; b: DoctorAppointment; actions: AppointmentAction[]; link: ReactNode; onChanged: (m: string) => void; onRefused: () => void; move: MoveProps;
}) {
  const { memory } = useSession();
  const queryClient = useQueryClient();
  const label = appointmentLabel(b);
  // Q14: the one move of a no-show (never an instant one), also while a move sent earlier is unconfirmed.
  const moveSlot = noShowMoveSlot(d.identity, b._id);
  const noShowMove = doctorNoShowMove(b);
  const showMove = noShowMove === 'offer' || noShowMove === 'used' || (b.bookingKind !== 'instant' && !b.clinicDesk && !!memory.get(moveSlot));
  const movedFrom = b.noShows?.[0];
  const run = async (status: 'confirmed' | 'completed' | 'cancelled' | 'no_show', done: string, reason?: string) => {
    try {
      await d.api.setAppointmentStatus(b._id, status, reason);
      onChanged(done);
    } catch (err) {
      onRefused();
      // WQ11c: the server's refusals in words (409 NOT_STARTED_YET: completed only once the time has come).
      const words = appointmentRefusal(err);
      throw words && err instanceof ApiError ? new ApiError(err.status, words, err.code, err.retryAfter) : err;
    }
  };
  const clinic = !!(b.clinicVisit || b.clinicDesk);
  return (
    <tr>
      <td>{label}</td>
      <td>{b.bookingKind === 'instant' ? 'Instant' : clinic ? 'At a clinic' : 'Booked'}{b.dependentId ? ' · family member' : ''}</td>
      <td>
        {b.consultationMode ? CONSULT_MODE_LABEL[b.consultationMode] ?? b.consultationMode : '—'}
        {link && <div>{link}</div>}
      </td>
      <td>{b.primaryConcern || '—'}</td>
      <td>
        <Badge tone={statusTone(b.status)}>{APPOINTMENT_STATUS_LABEL[b.status] ?? b.status}</Badge>{b.cancellationReason ? <div className="ws-muted">{b.cancellationReason}</div> : null}
        {movedFrom && <div className="ws-muted">Moved after a no-show{movedFrom.fromDate ? ` (missed ${formatYmd(movedFrom.fromDate)}${movedFrom.fromTime ? `, ${movedFrom.fromTime}` : ''})` : ''}. A second no-show is final.</div>}
      </td>
      <td>
        {b.paymentStatus === 'paid' ? `Paid${typeof b.price === 'number' ? ` · ${formatRupees(b.price)}` : ''}` : b.paymentStatus === 'refunded' ? 'Refunded' : b.settlementSystem === 'clinic' ? 'At the clinic' : 'Not paid'}
        {b.status === 'no_show' && <div className="ws-muted">No earning: you are paid only for a consultation that takes place. The patient is not refunded.</div>}
      </td>
      <td>
        {noShowMove === 'clinic' && <p className="ws-muted">The clinic can move this appointment: it was booked at its front desk.</p>}
        {showMove && (
          <NoShowMove slot={moveSlot} who="The patient" missed={label} state={noShowMove === 'used' ? 'used' : 'offer'} status={b.status}
            readAt={move.readAt} reading={move.reading} disabled={move.busy || move.reading} version={b.updatedAt}
            consequence={<>The patient is told the new time. You earn for it only once it is completed.</>}
            picker={(choose) => <DoctorSlotPicker d={d} b={b} now={move.now} onChoose={choose} />}
            send={(t: NoShowTarget, requestKey) => move.perform(() => d.api.rescheduleNoShow(b._id, t.slotId, requestKey, typeof t.version === 'string' ? t.version : undefined))}
            reread={move.reread} onNotice={move.onNotice} onFailure={move.onFailure}
            onSlotRefused={() => void queryClient.invalidateQueries({ queryKey: [...d.key, 'slots'] })} />
        )}
        {actions.length === 0 ? (!showMove && noShowMove !== 'clinic' && <span className="ws-muted">—</span>) : (
          <div className="ws-actions">
            {actions.includes('confirm') && (
              <ConfirmAction label="Confirm" confirmLabel={`Confirm ${label}`}
                consequence={<>Confirm the appointment on {label}? The patient is told it is confirmed.</>}
                onConfirm={() => run('confirmed', `${label} is confirmed.`)} />
            )}
            {actions.includes('complete') && (
              <ConfirmAction label="Mark completed" confirmLabel={`Complete ${label}`}
                consequence={<>Mark the consultation on {label} as completed? This cannot be changed later; your earning for it is recorded.</>}
                onConfirm={() => run('completed', `${label} is completed.`)} />
            )}
            {actions.includes('no_show') && (
              <ConfirmAction label="Patient did not come" confirmLabel={`Mark ${label} as no-show`} danger
                consequence={<>Mark {label} as a no-show? The patient is not refunded and you are not paid for it (you earn only for a consultation that takes place). You may move it once to a new time afterwards.</>}
                onConfirm={() => run('no_show', `${label} is marked as a no-show.`)} />
            )}
            {actions.includes('cancel') && (
              <ConfirmAction label="Cancel" confirmLabel={`Cancel ${label}`} danger reason reasonLabel="Reason (the patient sees it)"
                consequence={<>Cancel the appointment on {label}? {b.paymentStatus === 'paid' ? 'The patient gets their full payment back in their Jansetu wallet. ' : ''}This cannot be undone.</>}
                onConfirm={(reason) => run('cancelled', `${label} is cancelled${b.paymentStatus === 'paid' ? ' and the patient refunded in full' : ''}.`, reason)} />
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

/**
 * The place of a slot in words: a clinic branch by its name (the doctor's clinics), or none: the doctor's own place for
 * an in-person slot, online otherwise.
 */
function placeOf(s: Pick<DoctorSlot, 'branchId'>, inPerson: boolean, branches: ReadonlyMap<string, string>): string {
  if (!s.branchId) return inPerson ? 'your own place' : 'online';
  return branches.get(String(s.branchId).toLowerCase()) ?? 'a clinic';
}

/**
 * Q14: the doctor's own open, not-yet-started slots on a chosen day, for the one move of a no-show. WQ11c: only slots that
 * take the booking's consultation type and are at its place (`noShowSlotFits`); each names its place, and so does the
 * confirmation.
 */
function DoctorSlotPicker({ d, b, now, onChoose }: { d: DoctorContext; b: DoctorAppointment; now: Date; onChoose: (t: NoShowTarget | null) => void }) {
  const [day, setDay] = useState(() => istDateOf(now));
  const [slotId, setSlotId] = useState('');
  const ok = isRealDate(day);
  const slots = useQuery({ queryKey: [...d.key, 'slots', day], queryFn: () => d.api.slotsOn(day), enabled: ok });
  const clinics = useClinics(d);
  const branches = new Map((clinics.data ? schedulableBranches(clinics.data) : []).map((x) => [x.branchId.toLowerCase(), x.label]));
  const inPerson = b.consultationMode === 'in-person';
  const choices = (slots.data ?? []).filter((s) => movableSlot(s, now) && noShowSlotFits(s, b));
  const where = (s: DoctorSlot) => placeOf(s, inPerson, branches);
  const mode = b.consultationMode ? CONSULT_MODE_LABEL[b.consultationMode] ?? b.consultationMode : null;
  return (
    <>
      <p className="ws-muted">
        Times {mode ? `for ${mode.toLowerCase()} consultations ` : ''}at {inPerson ? (b.clinicVisit?.branchId ? branches.get(String(b.clinicVisit.branchId).toLowerCase()) ?? 'the same clinic' : 'your own place') : 'no clinic (online)'}, as booked.
      </p>
      <TextField label="New day" type="date" value={day} min={istDateOf(now)} error={ok ? undefined : 'Enter a real date.'}
        onChange={(e) => { setDay(e.target.value); setSlotId(''); onChoose(null); }} />
      {!ok ? null
        : slots.isPending ? <Loading label="Loading your slots…" />
        : slots.isError ? <ErrorState message={messageOf(slots.error)} onRetry={() => void slots.refetch()} />
        : choices.length === 0 ? <p className="ws-muted">No open slot for this consultation that day. Choose another day, or add hours on your schedule.</p>
        : (
          <div className="j-field">
            <label htmlFor={`noshow-slot-${b._id}`}>New time</label>
            <select id={`noshow-slot-${b._id}`} value={slotId} onChange={(e) => {
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
