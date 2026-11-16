import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  APPOINTMENT_STATUS_LABEL, appointmentActions, CONSULT_MODE_LABEL, isRealDate, istDateOf, type AppointmentAction, type DoctorAppointment,
} from '@jansetu/api';
import { Alert, Badge, Empty, ErrorState, Loading, TextField, formatRupees } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { formatDay } from '../partner/labs.tsx';
import { appointmentsKey, formatYmd, NotADoctor, sortAppointments, useDoctor, useTicker, useUpcomingAppointments, type DoctorContext } from './doctor.tsx';

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
  const q = useUpcomingAppointments(d, days);
  if (q.pending) return <Loading label="Loading appointments…" />;
  if (q.error) return <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />;
  return <AppointmentTable d={d} items={q.items} empty={days === 1 ? 'No appointments today.' : `No appointments in the next ${days} days.`} />;
}

function DayList({ d, day }: { d: DoctorContext; day: string }) {
  const q = useQuery({ queryKey: [...appointmentsKey(d), 'day', day], queryFn: () => d.api.appointmentsOn(day) });
  if (q.isPending) return <Loading label="Loading appointments…" />;
  if (q.isError) return <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />;
  return <AppointmentTable d={d} items={sortAppointments(q.data ?? [])} empty={`No appointments on ${formatDay(day)}.`} />;
}

const statusTone = (s: DoctorAppointment['status']) => (s === 'completed' ? 'ok' : s === 'cancelled' || s === 'no_show' ? 'danger' : s === 'pending' ? 'warn' : undefined);
export const appointmentLabel = (b: DoctorAppointment) => `${formatYmd(b.bookingDate)}, ${b.bookingTime}`;

function AppointmentTable({ d, items, empty }: { d: DoctorContext; items: DoctorAppointment[]; empty: string }) {
  const queryClient = useQueryClient();
  const now = useTicker(30_000);
  const [notice, setNotice] = useState<string | null>(null);
  if (items.length === 0) return <Empty title="Nothing here">{empty}</Empty>;
  const changed = (message: string) => { setNotice(message); void queryClient.invalidateQueries({ queryKey: appointmentsKey(d) }); };
  return (
    <>
      {notice && <Alert tone="ok">{notice}</Alert>}
      <div className="ws-table-wrap">
        <table className="j-table" aria-label="Appointments">
          <thead>
            <tr><th scope="col">When</th><th scope="col">Kind</th><th scope="col">Type</th><th scope="col">Concern</th><th scope="col">Status</th><th scope="col">Payment</th><th scope="col">Actions</th></tr>
          </thead>
          <tbody>
            {items.map((b) => (
              // Keyed by status too: once the booking moves on, an open confirmation for its old state is gone.
              <Row key={`${b._id}:${b.status}`} d={d} b={b} actions={appointmentActions(b, now)} onChanged={changed}
                onRefused={() => void queryClient.invalidateQueries({ queryKey: appointmentsKey(d) })} />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Row({ d, b, actions, onChanged, onRefused }: {
  d: DoctorContext; b: DoctorAppointment; actions: AppointmentAction[]; onChanged: (m: string) => void; onRefused: () => void;
}) {
  const label = appointmentLabel(b);
  const run = async (status: 'confirmed' | 'completed' | 'cancelled' | 'no_show', done: string, reason?: string) => {
    try {
      await d.api.setAppointmentStatus(b._id, status, reason);
      onChanged(done);
    } catch (err) {
      onRefused();
      throw err;
    }
  };
  const clinic = !!(b.clinicVisit || b.clinicDesk);
  return (
    <tr>
      <td>{label}</td>
      <td>{b.bookingKind === 'instant' ? 'Instant' : clinic ? 'At a clinic' : 'Booked'}{b.dependentId ? ' · family member' : ''}</td>
      <td>
        {b.consultationMode ? CONSULT_MODE_LABEL[b.consultationMode] ?? b.consultationMode : '—'}
        {b.virtualMeeting?.joinUrl && b.status === 'confirmed' && <> · <a href={b.virtualMeeting.joinUrl} target="_blank" rel="noreferrer noopener">Join</a></>}
      </td>
      <td>{b.primaryConcern || '—'}</td>
      <td><Badge tone={statusTone(b.status)}>{APPOINTMENT_STATUS_LABEL[b.status] ?? b.status}</Badge>{b.cancellationReason ? <div className="ws-muted">{b.cancellationReason}</div> : null}</td>
      <td>{b.paymentStatus === 'paid' ? `Paid${typeof b.price === 'number' ? ` · ${formatRupees(b.price)}` : ''}` : b.paymentStatus === 'refunded' ? 'Refunded' : b.settlementSystem === 'clinic' ? 'At the clinic' : 'Not paid'}</td>
      <td>
        {actions.length === 0 ? <span className="ws-muted">—</span> : (
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
                consequence={<>Mark {label} as a no-show? The patient is not refunded and you are paid for it. This cannot be undone.</>}
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
