import { useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { PHARMACY_PHONE_PATTERN, pharmacyAdminApi, pharmacyState, type PharmacyAccount, type PharmacyQuery } from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, formatDateTime, Loading, TextField } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession } from '../../session.tsx';
import { useAdminScope, useListParams } from './adminScope.ts';

/**
 * Filters from the URL, kept only when they are values `pharmacyQuerySchema` accepts. Typed text (a name searched, a
 * mobile number) is never put in the address or the history: it is kept in the page's memory.
 */
function queryOf(params: URLSearchParams, name: string): PharmacyQuery {
  const verified = params.get('isVerified');
  const active = params.get('isActive');
  const page = Number.parseInt(params.get('page') ?? '1', 10);
  return {
    ...(name ? { name } : {}),
    ...(Number.isInteger(page) && page > 1 ? { page } : {}),
    ...(verified === 'true' || verified === 'false' ? { isVerified: verified } : {}),
    ...(active === 'true' || active === 'false' ? { isActive: active } : {}),
  };
}

/** Verification and active state as badges. */
export function PharmacyBadges({ p }: { p: Pick<PharmacyAccount, 'isVerified' | 'isActive'> }) {
  const s = pharmacyState(p);
  return (
    <>
      <Badge tone={s.verified ? 'ok' : 'warn'}>{s.verified ? 'Verified' : 'Not verified'}</Badge>
      {!s.active && <> <Badge tone="danger">Inactive</Badge></>}
    </>
  );
}

/** Admin: pharmacy accounts, newest first, searchable by name and filtered by status (WQ10b). */
export function PharmaciesScreen() {
  const scope = useAdminScope('pharmacies');
  return <Pharmacies key={scope.identity} scopeKey={scope.key} />;
}

function Pharmacies({ scopeKey }: { scopeKey: readonly string[] }) {
  const { api } = useSession();
  const { params, setFilter } = useListParams();
  /** The name searched (page memory only). */
  const [name, setName] = useState('');
  /** A new name was searched on a later page: nothing is read until the address is back on page 1. */
  const [resetting, setResetting] = useState(false);
  const urlPage = params.get('page');
  useEffect(() => { if (!urlPage) setResetting(false); }, [urlPage]);
  const q = queryOf(params, name);
  const page = q.page ?? 1;
  const list = useQuery({ queryKey: [...scopeKey, 'list', q], queryFn: () => pharmacyAdminApi(api).list(q), enabled: !resetting });
  const [search, setSearch] = useState('');
  /** A filter or search change starts again at page 1. */
  const lastPage = Math.max(1, list.data?.totalPages ?? 1);
  const submitSearch = (e: FormEvent) => {
    e.preventDefault();
    const next = search.trim().slice(0, 100);
    if (next === name) return;
    if (urlPage) { setResetting(true); setFilter('page', ''); }
    setName(next);
  };
  const filtered = !!(q.name || q.isVerified || q.isActive);

  return (
    <>
      <PageHeading title="Pharmacies">Pharmacy accounts: add a pharmacy, verify it, and change its details or how it signs in.</PageHeading>
      <div><Link className="j-btn j-btn--primary" to="/admin/pharmacies/new">Add a pharmacy</Link></div>
      <form className="ws-search" role="search" onSubmit={submitSearch}>
        <TextField label="Search by name" value={search} maxLength={100} onChange={(e) => setSearch(e.target.value)} />
        <Button type="submit" variant="secondary">Search</Button>
      </form>
      <PhoneLookup scopeKey={scopeKey} />
      <div className="ws-search" role="group" aria-label="Filters">
        <div className="j-field ws-filter">
          <label htmlFor="ph-verified">Verification</label>
          <select id="ph-verified" value={q.isVerified ?? ''} onChange={(e) => setFilter('isVerified', e.target.value)}>
            <option value="">Verified or not</option>
            <option value="true">Verified</option>
            <option value="false">Not verified</option>
          </select>
        </div>
        <div className="j-field ws-filter">
          <label htmlFor="ph-active">Active</label>
          <select id="ph-active" value={q.isActive ?? ''} onChange={(e) => setFilter('isActive', e.target.value)}>
            <option value="">Active or not</option>
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </select>
        </div>
      </div>
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
