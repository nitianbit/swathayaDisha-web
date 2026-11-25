import { useState, type ReactNode } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  ApiError, APPOINTMENT_STATUS_LABEL, appointmentActions, appointmentInstant, appointmentRefusal, CONSULT_MODE_LABEL, doctorNoShowMove, fromYmd, isRealDate, istDateOf,
  labBookableFrom, movableSlot, NO_SHOW_GRACE_MS, noShowSlotFits, schedulableBranches, sessionEndOf, type AppointmentAction, type DoctorAppointment, type DoctorSlot,
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
import { t } from '../../i18n/doctor/index.ts';

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
      <PageHeading title={t('common.appointments')}>{t('appointments.yourConsultationsScheduledAndInstant')}</PageHeading>
      <div className="ws-search">
        <div className="j-field ws-filter">
          <label htmlFor="appt-view">{t('common.show')}</label>
          <select id="appt-view" value={view} onChange={(e) => setView(e.target.value as View)}>
            <option value="today">{t('appointments.today')}</option>
            <option value="upcoming">{t('appointments.next')}{UPCOMING_DAYS}{t('appointments.days')}</option>
            <option value="day">{t('appointments.oneDay')}</option>
          </select>
        </div>
        {view === 'day' && <TextField label={t('appointments.day')} type="date" value={day} onChange={(e) => setDay(e.target.value)} />}
      </div>
      {view === 'day' ? (isRealDate(day) ? <DayList key={day} d={d} day={day} /> : <Empty title={t('appointments.chooseADay')}>{t('appointments.pickTheDayToShow')}</Empty>)
        : <UpcomingList key={view} d={d} days={view === 'today' ? 1 : UPCOMING_DAYS} />}
    </>
  );
}

function UpcomingList({ d, days }: { d: DoctorContext; days: number }) {
  // A just-accepted instant consultation's call link arrives after it: read again (bounded) while one is missing.
  const meet = useMeetPoll();
  const q = useUpcomingAppointments(d, days, meet.interval);
  if (q.pending) return <Loading label={t('common.loadingAppointments')} />;
  if (q.error) return <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />;
  return (
    <>
      {q.refreshError && <RefreshFailed error={q.refreshError} readAt={q.readAt} onRetry={q.refetch} />}
      <AppointmentTable d={d} items={q.items} meet={meet} refresh={q.refetch} readAt={q.readAt} reading={q.fetching}
        empty={days === 1 ? t('appointments.noAppointmentsToday') : t('appointments.noAppointmentsInTheNext', { days })} />
    </>
  );
}

function DayList({ d, day }: { d: DoctorContext; day: string }) {
  const meet = useMeetPoll();
  const q = useQuery({ queryKey: [...appointmentsKey(d), 'day', day], queryFn: () => d.api.appointmentsOn(day), refetchInterval: (query) => meet.interval(query.state.data) });
  if (q.isPending) return <Loading label={t('common.loadingAppointments')} />;
  if (q.isError && q.data === undefined) return <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />;
  return (
    <>
      {q.isError && <RefreshFailed error={q.error} readAt={q.dataUpdatedAt} onRetry={q.refetch} />}
      <AppointmentTable d={d} items={sortAppointments(q.data ?? [])} meet={meet} refresh={q.refetch} readAt={q.dataUpdatedAt} reading={q.isFetching}
        empty={t('appointments.noAppointmentsOn', { when: formatDay(day) })} />
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
    onNotice: (text) => { setFailure(null); setNotice(text); }, onFailure: (text) => { setNotice(null); setFailure(text); },
  };
  // Q16d: a booking whose no-show time has come by its start is checked against its slot (the doctor's slots of that day):
  // in a session with several seats the no-show waits for the session's end. Until that read answers the no-show is not
  // offered; if it fails, the start rule is used and the server decides.
  const needsSlot = (b: DoctorAppointment) => {
    const at = appointmentInstant(b.bookingDate, b.bookingTime)?.at;
    return b.status === 'confirmed' && b.paymentStatus === 'paid' && b.bookingKind !== 'instant' && !!b.slotId && !!at && at.getTime() + NO_SHOW_GRACE_MS <= now.getTime();
  };
  const slotDays = [...new Set(items.filter(needsSlot).map((b) => fromYmd(b.bookingDate)).filter((x): x is string => !!x))];
  const daySlots = useQueries({ queries: slotDays.map((day) => ({ queryKey: [...d.key, 'slots', day], queryFn: () => d.api.slotsOn(day) })) });
  const slotsOf = new Map(slotDays.map((day, i) => [day, daySlots[i]!]));
  const actionsOf = (b: DoctorAppointment): AppointmentAction[] => {
    if (!needsSlot(b)) return appointmentActions(b, now);
    const q = slotsOf.get(fromYmd(b.bookingDate) ?? '');
    if (q?.isPending) return appointmentActions(b, now).filter((a) => a !== 'no_show');
    return appointmentActions(b, now, sessionEndOf(b, q?.data));
  };
  // The notice of a move stays visible even when the moved booking left this list (it may have been the only one).
  const alerts = <>{notice && <Alert tone="ok">{notice}</Alert>}{failure && <Alert>{failure}</Alert>}</>;
  if (items.length === 0) return <>{alerts}<Empty title={t('appointments.nothingHere')}>{empty}</Empty></>;
  return (
    <>
      {alerts}
      <div className="ws-table-wrap">
        <table className="j-table" aria-label={t('common.appointments')}>
          <thead>
            <tr><th scope={'col'}>{t('appointments.when')}</th><th scope={'col'}>{t('common.kind')}</th><th scope={'col'}>{t('common.type')}</th><th scope={'col'}>{t('appointments.concern')}</th><th scope={'col'}>{t('appointments.status')}</th><th scope={'col'}>{t('appointments.payment')}</th><th scope={'col'}>{t('appointments.actions')}</th></tr>
          </thead>
          <tbody>
            {items.map((b) => (
              // Keyed by status too: once the booking moves on, an open confirmation for its old state is gone.
              <Row key={`${b._id}:${b.status}:${b.updatedAt ?? ''}`} d={d} b={b} actions={actionsOf(b)} onChanged={changed} move={move}
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
  reread: () => void; onNotice: (text: string) => void; onFailure: (text: string) => void;
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
  // WQ25: a lab test for the patient of this consultation (the server checks its treating window).
  const labLink = labBookableFrom(b, move.now);
  return (
    <tr>
      <td>{label}</td>
      <td>{b.bookingKind === 'instant' ? 'Instant' : clinic ? t('appointments.atAClinic') : 'Booked'}{b.dependentId ? ' · family member' : ''}</td>
      <td>
        {b.consultationMode ? CONSULT_MODE_LABEL[b.consultationMode] ?? b.consultationMode : '—'}
        {link && <div>{link}</div>}
      </td>
      <td>{b.primaryConcern || '—'}</td>
      <td>
        <Badge tone={statusTone(b.status)}>{APPOINTMENT_STATUS_LABEL[b.status] ?? b.status}</Badge>{b.cancellationReason ? <div className="ws-muted">{b.cancellationReason}</div> : null}
        {movedFrom && <div className="ws-muted">{t('appointments.movedAfterANoShow')}{movedFrom.fromDate ? ` (missed ${formatYmd(movedFrom.fromDate)}${movedFrom.fromTime ? `, ${movedFrom.fromTime}` : ''})` : ''}{t('appointments.aSecondNoShowIs')}</div>}
      </td>
      <td>
        {b.paymentStatus === 'paid' ? t('appointments.paid', { value: typeof b.price === 'number' ? ` · ${formatRupees(b.price)}` : '' }) : b.paymentStatus === 'refunded' ? 'Refunded' : b.settlementSystem === 'clinic' ? t('appointments.atTheClinic') : t('appointments.notPaid')}
        {b.status === 'no_show' && <div className="ws-muted">{t('appointments.noEarningYouArePaid')}</div>}
      </td>
      <td>
        {noShowMove === 'clinic' && <p className="ws-muted">{t('appointments.theClinicCanMoveThis')}</p>}
        {showMove && (
          <NoShowMove slot={moveSlot} who={t('appointments.thePatient')} missed={label} state={noShowMove === 'used' ? 'used' : 'offer'} status={b.status}
            readAt={move.readAt} reading={move.reading} disabled={move.busy || move.reading} version={b.updatedAt}
            consequence={<>{t('appointments.thePatientIsToldThe')}</>}
            picker={(choose) => <DoctorSlotPicker d={d} b={b} now={move.now} onChoose={choose} />}
            send={(target: NoShowTarget, requestKey) => move.perform(() => d.api.rescheduleNoShow(b._id, target.slotId, requestKey, typeof target.version === 'string' ? target.version : undefined))}
            reread={move.reread} onNotice={move.onNotice} onFailure={move.onFailure}
            onSlotRefused={() => void queryClient.invalidateQueries({ queryKey: [...d.key, 'slots'] })} />
        )}
        {actions.length === 0 ? (!showMove && noShowMove !== 'clinic' && !labLink && <span className="ws-muted">—</span>) : (
          <div className="ws-actions">
            {actions.includes('confirm') && (
              <ConfirmAction label={t('appointments.confirm')} confirmLabel={t('appointments.confirm2', { label })}
                consequence={<>{t('appointments.confirmTheAppointmentOn')}{label}{t('appointments.thePatientIsToldIt')}</>}
                onConfirm={() => run('confirmed', t('appointments.isConfirmed', { label }))} />
            )}
            {actions.includes('complete') && (
              <ConfirmAction label={t('appointments.markCompleted')} confirmLabel={t('appointments.complete', { label })}
                consequence={<>{t('appointments.markTheConsultationOn')}{label}{t('appointments.asCompletedThisCannotBe')}</>}
                onConfirm={() => run('completed', t('appointments.isCompleted', { label }))} />
            )}
            {actions.includes('no_show') && (
              <ConfirmAction label={t('appointments.patientDidNotCome')} confirmLabel={t('appointments.markAsNoShow', { label })} danger
                consequence={<>{t('appointments.mark')}{label}{t('appointments.asANoShowThe')}</>}
                onConfirm={() => run('no_show', t('appointments.isMarkedAsANo', { label }))} />
            )}
            {actions.includes('cancel') && (
              <ConfirmAction label={t('common.cancel')} confirmLabel={t('appointments.cancel2', { label })} danger reason reasonLabel={t('appointments.reasonThePatientSeesIt')}
                consequence={<>{t('appointments.cancelTheAppointmentOn')}{label}? {b.paymentStatus === 'paid' ? t('appointments.thePatientGetsTheirFull') : ''}{t('appointments.thisCannotBeUndone')}</>}
                onConfirm={(reason) => run('cancelled', t('appointments.isCancelled', { label, value: b.paymentStatus === 'paid' ? ' and the patient refunded in full' : '' }), reason)} />
            )}
          </div>
        )}
        {labLink && (
          <div><Link to={`/doctor/lab-book/from/${b._id}`} aria-label={t('appointments.bookLabTestForThis', { label })}>{t('appointments.bookLabTestForThis2')}</Link></div>
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
function DoctorSlotPicker({ d, b, now, onChoose }: { d: DoctorContext; b: DoctorAppointment; now: Date; onChoose: (target: NoShowTarget | null) => void }) {
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
      <p className="ws-muted">{t('appointments.times')}{mode ? `for ${mode.toLowerCase()} consultations ` : ''}{t('appointments.at')}{inPerson ? (b.clinicVisit?.branchId ? branches.get(String(b.clinicVisit.branchId).toLowerCase()) ?? 'the same clinic' : 'your own place') : 'no clinic (online)'}{t('appointments.asBooked')}</p>
      <TextField label={t('appointments.newDay')} type="date" value={day} min={istDateOf(now)} error={ok ? undefined : t('appointments.enterARealDate')}
        onChange={(e) => { setDay(e.target.value); setSlotId(''); onChoose(null); }} />
      {!ok ? null
        : slots.isPending ? <Loading label={t('appointments.loadingYourSlots')} />
        : slots.isError ? <ErrorState message={messageOf(slots.error)} onRetry={() => void slots.refetch()} />
        : choices.length === 0 ? <p className="ws-muted">{t('appointments.noOpenSlotForThis')}</p>
        : (
          <div className="j-field">
            <label htmlFor={`noshow-slot-${b._id}`}>{t('appointments.newTime')}</label>
            <select id={`noshow-slot-${b._id}`} value={slotId} onChange={(e) => {
              setSlotId(e.target.value);
              const s = choices.find((x) => x._id === e.target.value);
              const iso = s ? fromYmd(s.date) : null;
              onChoose(s ? { slotId: s._id, label: `${iso ? formatDay(iso) : s.date}, ${s.startTime} (${where(s)})` } : null);
            }}>
              <option value="">{t('appointments.chooseATime')}</option>
              {choices.map((s) => <option key={s._id} value={s._id}>{s.startTime}–{s.endTime} · {where(s)}</option>)}
            </select>
          </div>
        )}
    </>
  );
}
