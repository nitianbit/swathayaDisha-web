import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { doctorAdminListApi, doctorEligibility, MAX_DOCTOR_NAME_SEARCH, type AdminDoctor, type AdminDoctorQuery } from '@jansetu/api';
import { Empty, ErrorState, formatDateTime, Loading } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession } from '../../session.tsx';
import { NameSearch, Pager, StateBadges, StateFilterSelects, stateFiltersOf, useNameSearch } from './accountList.tsx';
import { useAdminScope, useListParams } from './adminScope.ts';

/** Verification and active state (S5: a doctor is booked only when both hold; a missing flag is not). */
export function DoctorBadges({ d }: { d: Pick<AdminDoctor, 'isVerified' | 'isActive'> }) {
  return <StateBadges {...doctorEligibility(d)} />;
}

/** Admin: doctor accounts, newest first, searchable by name and filtered by verification and active state (WQ18). */
export function DoctorsScreen() {
  const scope = useAdminScope('doctors');
  return <Doctors key={scope.identity} scopeKey={scope.key} />;
}

function Doctors({ scopeKey }: { scopeKey: readonly string[] }) {
  const { api } = useSession();
  const { params, setFilter } = useListParams();
  const search = useNameSearch(params, setFilter, MAX_DOCTOR_NAME_SEARCH);
  const q: AdminDoctorQuery = { ...stateFiltersOf(params), ...(search.name ? { name: search.name } : {}) };
  const page = q.page ?? 1;
  const list = useQuery({ queryKey: [...scopeKey, 'list', q], queryFn: () => doctorAdminListApi(api).list(q), enabled: !search.resetting });
  const filtered = !!(q.name || q.isVerified || q.isActive);

  return (
    <>
      <PageHeading title="Doctors">Doctor accounts: verify a doctor, or take a verification away.</PageHeading>
      <NameSearch s={search} />
      <StateFilterSelects idPrefix="dr" q={q} setFilter={setFilter} />
      {list.isPending ? <Loading label="Loading doctors…" />
        : list.isError ? <ErrorState message={messageOf(list.error)} onRetry={() => void list.refetch()} />
        : list.data.items.length === 0 && page === 1 ? (
          <Empty title={filtered ? 'No doctors match' : 'No doctors yet'}>{filtered ? 'Change the search or filters.' : 'Doctors who sign up appear here.'}</Empty>
        ) : (
          <>
            <p className="ws-count" aria-live="polite">{list.data.total} {list.data.total === 1 ? 'doctor' : 'doctors'}</p>
            <div className="ws-table-wrap">
              <table className="j-table">
                <caption className="j-sr-only">Doctors, newest first</caption>
                <thead>
                  <tr><th scope="col">Name</th><th scope="col">Speciality</th><th scope="col">Registration number</th><th scope="col">Status</th><th scope="col">Added</th></tr>
                </thead>
                <tbody>
                  {list.data.items.map((d) => (
                    <tr key={d._id}>
                      <td><Link to={`/admin/doctors/${d._id}`}>{d.name || 'No name'}</Link></td>
                      <td>{d.specialization || '—'}</td>
                      <td>{d.medicalRegistrationNumber?.trim() || '—'}</td>
                      <td><DoctorBadges d={d} /></td>
                      <td>{d.createdAt ? formatDateTime(d.createdAt) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={page} lastPage={Math.max(1, list.data.totalPages)} setFilter={setFilter} />
          </>
        )}
    </>
  );
}
