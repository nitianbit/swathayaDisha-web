import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import {
  PARTNER_KIND_LABEL, partnerAdminApi, VERIFICATION_LABEL, type PartnerKind, type PartnerQuery, type VerificationState,
} from '@jansetu/api';
import { Badge, Empty, ErrorState, formatDateTime, Loading } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession } from '../../session.tsx';
import { PartnerStateActions } from './PartnerStateActions.tsx';

const KINDS: PartnerKind[] = ['lab', 'clinic'];
const STATES: VerificationState[] = ['pending', 'verified', 'suspended'];

/** Filters from the URL, kept only when they are values `partnerQuerySchema` accepts. */
function queryOf(params: URLSearchParams): PartnerQuery {
  const kind = params.get('kind');
  const state = params.get('verificationState');
  const active = params.get('isActive');
  return {
    ...(KINDS.includes(kind as PartnerKind) ? { kind: kind as PartnerKind } : {}),
    ...(STATES.includes(state as VerificationState) ? { verificationState: state as VerificationState } : {}),
    ...(active === 'true' || active === 'false' ? { isActive: active } : {}),
  };
}

export const stateTone = (s?: VerificationState) => (s === 'verified' ? 'ok' : s === 'suspended' ? 'danger' : 'warn');

/** Admin: every lab and clinic partner account (the backend returns all matches, sorted by name). */
export function PartnersScreen() {
  const { api } = useSession();
  const [params, setParams] = useSearchParams();
  const q = queryOf(params);
  const list = useQuery({ queryKey: ['admin-partners', q], queryFn: () => partnerAdminApi(api).list(q) });
  const setFilter = (key: keyof PartnerQuery, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };

  return (
    <>
      <PageHeading title="Labs and clinics">Partner accounts: verify new ones, manage them as their owner, or suspend them.</PageHeading>
      <div><Link className="j-btn j-btn--primary" to="/admin/partners/new">Add a lab or clinic</Link></div>
      <div className="ws-search" role="group" aria-label="Filters">
        <div className="j-field ws-filter">
          <label htmlFor="pf-kind">Type</label>
          <select id="pf-kind" value={q.kind ?? ''} onChange={(e) => setFilter('kind', e.target.value)}>
            <option value="">Labs and clinics</option>
            {KINDS.map((k) => <option key={k} value={k}>{PARTNER_KIND_LABEL[k]}</option>)}
          </select>
        </div>
        <div className="j-field ws-filter">
          <label htmlFor="pf-state">Status</label>
          <select id="pf-state" value={q.verificationState ?? ''} onChange={(e) => setFilter('verificationState', e.target.value)}>
            <option value="">Any status</option>
            {STATES.map((s) => <option key={s} value={s}>{VERIFICATION_LABEL[s]}</option>)}
          </select>
        </div>
        <div className="j-field ws-filter">
          <label htmlFor="pf-active">Active</label>
          <select id="pf-active" value={q.isActive ?? ''} onChange={(e) => setFilter('isActive', e.target.value)}>
            <option value="">Active or not</option>
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </select>
        </div>
      </div>
      {list.isPending ? <Loading label="Loading partners…" />
        : list.isError ? <ErrorState message={messageOf(list.error)} onRetry={() => void list.refetch()} />
        : list.data.length === 0 ? <Empty title="No labs or clinics match">Change the filters, or add one.</Empty>
        : (
          <>
            <p className="ws-count" aria-live="polite">{list.data.length} {list.data.length === 1 ? 'partner' : 'partners'}</p>
            <div className="ws-table-wrap">
              <table className="j-table">
                <caption className="j-sr-only">Labs and clinics</caption>
                <thead><tr><th scope="col">Name</th><th scope="col">Type</th><th scope="col">Status</th><th scope="col">Contact</th><th scope="col">Added</th><th scope="col">Actions</th></tr></thead>
                <tbody>
                  {list.data.map((p) => (
                    <tr key={p._id}>
                      <td><Link to={`/admin/partners/${p._id}`}>{p.name}</Link></td>
                      <td>{PARTNER_KIND_LABEL[p.kind] ?? p.kind}</td>
                      <td>
                        <Badge tone={stateTone(p.verification?.state)}>{VERIFICATION_LABEL[p.verification?.state] ?? p.verification?.state}</Badge>
                        {!p.isActive && p.verification?.state !== 'suspended' && <> <Badge tone="danger">Inactive</Badge></>}
                      </td>
                      <td>{p.contact?.phone}{p.contact?.email ? ` · ${p.contact.email}` : ''}</td>
                      <td>{formatDateTime(p.createdAt)}</td>
                      <td><PartnerStateActions partner={p} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
    </>
  );
}
