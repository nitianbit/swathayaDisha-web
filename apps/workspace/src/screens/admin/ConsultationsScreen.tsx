import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  consultationAdminApi, consultationQueryProblem, CONSULTATION_STATUS_FILTERS, CONSULTATION_STATUS_LABEL, CONSULT_MODE_LABEL, OBJECT_ID_PATTERN,
  type AdminConsultation, type ConsultationQuery, type DoctorRef,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, Loading, TextField } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession } from '../../session.tsx';
import { formatYmd } from '../doctor/doctor.tsx';
import { useAdminScope, useListParams } from './adminScope.ts';

/** Filters from the URL, kept only when they are values `bookingQuerySchema` accepts. */
function queryOf(params: URLSearchParams): ConsultationQuery {
  const status = params.get('status');
  const doctor = params.get('doctor') ?? '';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const page = Number.parseInt(params.get('page') ?? '1', 10);
  return {
    ...((CONSULTATION_STATUS_FILTERS as readonly string[]).includes(status ?? '') ? { status: status as ConsultationQuery['status'] } : {}),
    ...(OBJECT_ID_PATTERN.test(doctor) ? { specialistId: doctor } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(Number.isInteger(page) && page > 1 ? { page } : {}),
  };
}

export const consultationTone = (s: AdminConsultation['status']) =>
  (s === 'completed' ? 'ok' : s === 'cancelled' || s === 'no_show' ? 'danger' : s === 'pending' ? 'warn' : undefined);

/** "Video", "Instant · Video", "Clinic front desk · In person". */
export function consultationKind(b: Pick<AdminConsultation, 'bookingKind' | 'clinicDesk' | 'clinicVisit' | 'consultationMode'>): string {
  const mode = b.consultationMode ? CONSULT_MODE_LABEL[b.consultationMode] ?? b.consultationMode : '';
  const kind = b.bookingKind === 'instant' ? 'Instant' : b.clinicDesk ? 'Clinic front desk' : b.clinicVisit ? 'At a clinic' : '';
  return [kind, mode].filter(Boolean).join(' · ') || '—';
}

/**
 * Admin: doctor consultation bookings (WQ10b), latest appointment first, filtered by status, doctor and appointment dates.
 * Open one to see its no-show history and move a no-show once. The server cannot filter no-shows on their own (its status
 * filter takes waiting, confirmed, completed and cancelled), so they are found in the unfiltered list, marked.
 */
export function ConsultationsScreen() {
  const scope = useAdminScope('consultations');
  return <Consultations key={scope.identity} scopeKey={scope.key} />;
}

function Consultations({ scopeKey }: { scopeKey: readonly string[] }) {
  const { api } = useSession();
  const { params, setFilter } = useListParams();
  const q = queryOf(params);
  const page = q.page ?? 1;
  const problem = consultationQueryProblem(q);
  const list = useQuery({ queryKey: [...scopeKey, 'list', q], queryFn: () => consultationAdminApi(api).list(q), enabled: !problem });
  const [doctorName, setDoctorName] = useState<string | null>(null);
  const lastPage = Math.max(1, list.data?.totalPages ?? 1);
  const filtered = !!(q.status || q.specialistId || q.from || q.to);
  const shownDoctor = doctorName ?? list.data?.items.find((b) => b.specialistId === q.specialistId)?.doctorName ?? 'the chosen doctor';

  return (
    <>
      <PageHeading title="Consultations">Doctor consultation bookings. Open one to see its no-show history or move a no-show once.</PageHeading>
      <div className="ws-search" role="group" aria-label="Filters">
        <div className="j-field ws-filter">
          <label htmlFor="cs-status">Status</label>
          <select id="cs-status" value={q.status ?? ''} onChange={(e) => setFilter('status', e.target.value)}>
            <option value="">Any status (no-shows included)</option>
            {CONSULTATION_STATUS_FILTERS.map((s) => <option key={s} value={s}>{CONSULTATION_STATUS_LABEL[s]}</option>)}
          </select>
        </div>
        <TextField label="Appointments from" type="date" value={q.from ?? ''} onChange={(e) => setFilter('from', e.target.value)} />
        <TextField label="Appointments to" type="date" value={q.to ?? ''} onChange={(e) => setFilter('to', e.target.value)} />
      </div>
      <p className="ws-muted">No-shows cannot be listed on their own yet: leave the status on “Any status” and narrow by doctor and dates.</p>
      {q.specialistId ? (
        <p>
          Doctor: <strong>{shownDoctor}</strong>{' '}
          <Button variant="ghost" onClick={() => { setDoctorName(null); setFilter('doctor', ''); }}>All doctors</Button>
        </p>
      ) : (
        <DoctorFilter scopeKey={scopeKey} onChoose={(d) => { setDoctorName(d.name); setFilter('doctor', d._id); }} />
      )}
      {problem ? <Alert>{problem}</Alert>
        : list.isPending ? <Loading label="Loading consultations…" />
        : list.isError ? <ErrorState message={messageOf(list.error)} onRetry={() => void list.refetch()} />
        : list.data.items.length === 0 && page === 1 ? (
          <Empty title={filtered ? 'No consultations match' : 'No consultations yet'}>{filtered ? 'Change the filters.' : 'Consultations booked in the app appear here.'}</Empty>
        ) : (
          <>
            <p className="ws-count" aria-live="polite">{list.data.total} {list.data.total === 1 ? 'consultation' : 'consultations'}</p>
            <div className="ws-table-wrap">
              <table className="j-table">
                <caption className="j-sr-only">Consultations</caption>
                <thead>
                  <tr><th scope="col">Appointment</th><th scope="col">Doctor</th><th scope="col">Kind</th><th scope="col">Status</th><th scope="col">Payment</th></tr>
                </thead>
                <tbody>
                  {list.data.items.map((b) => (
                    <tr key={b._id}>
                      <td><Link to={`/admin/consultations/${b._id}`}>{formatYmd(b.bookingDate)}, {b.bookingTime}</Link></td>
                      <td>{b.doctorName || '—'}</td>
                      <td>{consultationKind(b)}</td>
                      <td>
                        <Badge tone={consultationTone(b.status)}>{CONSULTATION_STATUS_LABEL[b.status] ?? b.status}</Badge>
                        {(b.noShows?.length ?? 0) > 0 && <div className="ws-muted">Moved after a no-show</div>}
                      </td>
                      <td>{paymentLabel(b)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {(lastPage > 1 || page > 1) && (
              <nav className="ws-pager" aria-label="Pages">
                <Button variant="secondary" disabled={page <= 1} onClick={() => setFilter('page', page - 1 > 1 ? String(page - 1) : '')}>Previous</Button>
                <span>Page {page} of {lastPage}</span>
                <Button variant="secondary" disabled={page >= lastPage} onClick={() => setFilter('page', String(page + 1))}>Next</Button>
              </nav>
            )}
          </>
        )}
    </>
  );
}

export const paymentLabel = (b: Pick<AdminConsultation, 'paymentStatus' | 'settlementSystem'>) =>
  b.paymentStatus === 'paid' ? 'Paid' : b.paymentStatus === 'refunded' ? 'Refunded' : b.settlementSystem === 'clinic' ? 'At the clinic' : b.paymentStatus === 'failed' ? 'Payment failed' : 'Not paid';

/** Find a doctor by part of their name (any status) and filter by them. */
function DoctorFilter({ scopeKey, onChoose }: { scopeKey: readonly string[]; onChoose: (d: DoctorRef) => void }) {
  const { api } = useSession();
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  const found = useQuery({ queryKey: [...scopeKey, 'doctors', search], queryFn: () => consultationAdminApi(api).doctors(search), enabled: !!search });
  const submit = (e: FormEvent) => { e.preventDefault(); setSearch(text.trim()); };
  return (
    <section aria-label="Doctor">
      <form className="ws-search" role="search" onSubmit={submit}>
        <TextField label="Doctor’s name" value={text} maxLength={100} onChange={(e) => setText(e.target.value)} />
        <Button type="submit" variant="secondary" disabled={!text.trim()}>Find doctor</Button>
      </form>
      {!search ? null
        : found.isPending ? <Loading label="Finding doctors…" />
        : found.isError ? <ErrorState message={messageOf(found.error)} onRetry={() => void found.refetch()} />
        : found.data.items.length === 0 ? <p className="ws-muted">No doctor’s name contains “{search}”.</p>
        : (
          <ul className="ws-list" aria-label="Doctors found">
            {found.data.items.map((d) => (
              <li key={d._id}>
                <Button variant="secondary" onClick={() => onChoose(d)}>
                  {d.name}{d.specialization ? ` · ${d.specialization}` : ''}{d.isActive === false ? ' · inactive' : ''}
                </Button>
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}
