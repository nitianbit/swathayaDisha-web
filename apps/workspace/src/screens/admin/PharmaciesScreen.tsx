import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { PHARMACY_PHONE_PATTERN, pharmacyAdminApi, pharmacyState, type PharmacyAccount, type PharmacyQuery } from '@jansetu/api';
import { Alert, Button, Empty, ErrorState, formatDateTime, Loading, TextField } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession } from '../../session.tsx';
import { NameSearch, Pager, StateBadges, StateFilterSelects, stateFiltersOf, useNameSearch } from './accountList.tsx';
import { useAdminScope, useListParams } from './adminScope.ts';

/** Verification and active state as badges. */
export function PharmacyBadges({ p }: { p: Pick<PharmacyAccount, 'isVerified' | 'isActive'> }) {
  return <StateBadges {...pharmacyState(p)} />;
}

/** Admin: pharmacy accounts, newest first, searchable by name and filtered by status (WQ10b). */
export function PharmaciesScreen() {
  const scope = useAdminScope('pharmacies');
  return <Pharmacies key={scope.identity} scopeKey={scope.key} />;
}

function Pharmacies({ scopeKey }: { scopeKey: readonly string[] }) {
  const { api } = useSession();
  const { params, setFilter } = useListParams();
  // Typed text (a name searched, a mobile number) is never put in the address or the history: it is kept in the page's memory.
  const search = useNameSearch(params, setFilter);
  const q: PharmacyQuery = { ...stateFiltersOf(params), ...(search.name ? { name: search.name } : {}) };
  const page = q.page ?? 1;
  const list = useQuery({ queryKey: [...scopeKey, 'list', q], queryFn: () => pharmacyAdminApi(api).list(q), enabled: !search.resetting });
  const filtered = !!(q.name || q.isVerified || q.isActive);

  return (
    <>
      <PageHeading title="Pharmacies">Pharmacy accounts: add a pharmacy, verify it, and change its details or how it signs in.</PageHeading>
      <div><Link className="j-btn j-btn--primary" to="/admin/pharmacies/new">Add a pharmacy</Link></div>
      <NameSearch s={search} />
      <PhoneLookup scopeKey={scopeKey} />
      <StateFilterSelects idPrefix="ph" q={q} setFilter={setFilter} />
      {list.isPending ? <Loading label="Loading pharmacies…" />
        : list.isError ? <ErrorState message={messageOf(list.error)} onRetry={() => void list.refetch()} />
        : list.data.items.length === 0 && page === 1 ? (
          <Empty title={filtered ? 'No pharmacies match' : 'No pharmacies yet'}>{filtered ? 'Change the search or filters.' : 'Pharmacies you add appear here.'}</Empty>
        ) : (
          <>
            <p className="ws-count" aria-live="polite">{list.data.total} {list.data.total === 1 ? 'pharmacy' : 'pharmacies'}</p>
            <div className="ws-table-wrap">
              <table className="j-table">
                <caption className="j-sr-only">Pharmacies</caption>
                <thead>
                  <tr><th scope="col">Name</th><th scope="col">Owner</th><th scope="col">Signs in with</th><th scope="col">City</th><th scope="col">Status</th><th scope="col">Added</th></tr>
                </thead>
                <tbody>
                  {list.data.items.map((p) => (
                    <tr key={p._id}>
                      <td><Link to={`/admin/pharmacies/${p._id}`}>{p.name}</Link></td>
                      <td>{p.ownerName || '—'}</td>
                      <td>{p.phone}{p.email ? ` · ${p.email}` : ''}</td>
                      <td>{p.city || '—'}</td>
                      <td><PharmacyBadges p={p} /></td>
                      <td>{p.createdAt ? formatDateTime(p.createdAt) : '—'}</td>
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

/**
 * Q15: which pharmacy signs in with a mobile number (`GET /pharmacies?phone=`, exact). The number is kept in this page's
 * memory only, never in the address.
 */
function PhoneLookup({ scopeKey }: { scopeKey: readonly string[] }) {
  const { api } = useSession();
  const [text, setText] = useState('');
  const [phone, setPhone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const found = useQuery({
    queryKey: [...scopeKey, 'by-phone', phone],
    queryFn: () => pharmacyAdminApi(api).findByPhone(phone!),
    enabled: !!phone,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!PHARMACY_PHONE_PATTERN.test(text)) { setError('Enter the 10-digit mobile number.'); return; }
    setError(null);
    setPhone(text);
  };
  return (
    <section aria-label="Find by mobile number">
      <form className="ws-search" role="search" onSubmit={submit}>
        <TextField label="Find by mobile number" inputMode="numeric" maxLength={10} autoComplete="off" value={text} error={error ?? undefined}
          onChange={(e) => setText(e.target.value.replace(/\D/g, ''))} />
        <Button type="submit" variant="secondary">Find</Button>
      </form>
      {!phone ? null
        : found.isPending ? <Loading label="Finding the pharmacy…" />
        : found.isError ? <ErrorState message={messageOf(found.error)} onRetry={() => void found.refetch()} />
        : found.data ? (
          <Alert tone="ok">
            <Link to={`/admin/pharmacies/${found.data._id}`}>{found.data.name}</Link> signs in with {phone}. <PharmacyBadges p={found.data} />
          </Alert>
        ) : <p className="ws-muted">No pharmacy signs in with {phone}.</p>}
    </section>
  );
}
