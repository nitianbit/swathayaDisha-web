import { useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import {
  PARTNER_KIND_LABEL, partnerAdminApi, VERIFICATION_LABEL, type PartnerKind, type PartnerQuery, type VerificationState,
} from '@jansetu/api';
import { Badge, Button, Empty, ErrorState, formatDateTime, Loading, shared, TextField } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { t } from '../../i18n/admin/index.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession } from '../../session.tsx';
import { PartnerStateActions } from './PartnerStateActions.tsx';

const KINDS: PartnerKind[] = ['lab', 'clinic'];
const STATES: VerificationState[] = ['pending', 'verified', 'suspended'];
const PAGE_SIZE = 20;

/**
 * Filters from the URL, kept only when they are values `partnerQuerySchema` accepts. WQ11b: the name searched for is
 * not one of them: it stays in the page's own state, never in the address (and so never in the browser's history).
 */
function queryOf(params: URLSearchParams): PartnerQuery {
  const kind = params.get('kind');
  const state = params.get('verificationState');
  const active = params.get('isActive');
  const page = Number.parseInt(params.get('page') ?? '1', 10);
  return {
    ...(Number.isInteger(page) && page > 1 ? { page } : {}),
    ...(KINDS.includes(kind as PartnerKind) ? { kind: kind as PartnerKind } : {}),
    ...(STATES.includes(state as VerificationState) ? { verificationState: state as VerificationState } : {}),
    ...(active === 'true' || active === 'false' ? { isActive: active } : {}),
  };
}

export const stateTone = (s?: VerificationState) => (s === 'verified' ? 'ok' : s === 'suspended' ? 'danger' : 'warn');

/** Admin: lab and clinic partner accounts, sorted by name, searchable and paged (Q8). */
export function PartnersScreen() {
  const { api } = useSession();
  const [params, setParams] = useSearchParams();
  // A name left in the address by an older link is taken into the page and removed from the address.
  const [name, setName] = useState(() => (params.get('q') ?? '').trim().slice(0, 100));
  const [search, setSearch] = useState(name);
  useEffect(() => {
    const fromAddress = params.get('q');
    if (fromAddress === null) return;
    const v = fromAddress.trim().slice(0, 100);
    setName(v); setSearch(v);
    const next = new URLSearchParams(params);
    next.delete('q');
    setParams(next, { replace: true });
  }, [params, setParams]);
  const q: PartnerQuery = { ...queryOf(params), ...(name ? { q: name } : {}) };
  const page = q.page ?? 1;
  const list = useQuery({ queryKey: ['admin-partners', 'list', q], queryFn: () => partnerAdminApi(api).list({ ...q, limit: PAGE_SIZE }) });
  /** A filter change starts again at page 1. */
  const setFilter = (key: Exclude<keyof PartnerQuery, 'q'>, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: key !== 'page' });
  };
  const lastPage = Math.max(1, list.data?.totalPages ?? 1);
  const submitSearch = (e: FormEvent) => {
    e.preventDefault();
    setName(search.trim().slice(0, 100));
    if (params.has('page')) { const next = new URLSearchParams(params); next.delete('page'); setParams(next, { replace: true }); }
  };

  return (
    <>
      <PageHeading title={t('partners.title')}>{t('partners.intro')}</PageHeading>
      <div><Link className="j-btn j-btn--primary" to="/admin/partners/new">{t('partners.add')}</Link></div>
      <form className="ws-search" role="search" onSubmit={submitSearch}>
        <TextField label={t('common.searchByName')} value={search} maxLength={100} onChange={(e) => setSearch(e.target.value)} />
        <Button type="submit" variant="secondary">{shared('action.search')}</Button>
      </form>
      <div className="ws-search" role="group" aria-label={t('common.filters')}>
        <div className="j-field ws-filter">
          <label htmlFor="pf-kind">{t('common.type')}</label>
          <select id="pf-kind" value={q.kind ?? ''} onChange={(e) => setFilter('kind', e.target.value)}>
            <option value="">{t('partners.anyKind')}</option>
            {KINDS.map((k) => <option key={k} value={k}>{PARTNER_KIND_LABEL[k]}</option>)}
          </select>
        </div>
        <div className="j-field ws-filter">
          <label htmlFor="pf-state">{t('common.status')}</label>
          <select id="pf-state" value={q.verificationState ?? ''} onChange={(e) => setFilter('verificationState', e.target.value)}>
            <option value="">{t('partners.anyStatus')}</option>
            {STATES.map((s) => <option key={s} value={s}>{VERIFICATION_LABEL[s]}</option>)}
          </select>
        </div>
        <div className="j-field ws-filter">
          <label htmlFor="pf-active">{t('common.active')}</label>
          <select id="pf-active" value={q.isActive ?? ''} onChange={(e) => setFilter('isActive', e.target.value)}>
            <option value="">{t('common.activeOrNot')}</option>
            <option value="true">{t('common.active')}</option>
            <option value="false">{t('common.inactive')}</option>
          </select>
        </div>
      </div>
      {list.isPending ? <Loading label={t('partners.loading')} />
        : list.isError ? <ErrorState message={messageOf(list.error)} onRetry={() => void list.refetch()} />
        : list.data.items.length === 0 && page === 1 ? <Empty title={t('partners.noneMatch')}>{t('partners.noneMatchHint')}</Empty>
        : (
          <>
            <p className="ws-count" aria-live="polite">{t('partners.count', { count: list.data.total })}</p>
            <div className="ws-table-wrap">
              <table className="j-table">
                <caption className="j-sr-only">{t('partners.title')}</caption>
                <thead><tr><th scope="col">{t('common.name')}</th><th scope="col">{t('common.type')}</th><th scope="col">{t('common.status')}</th><th scope="col">{t('partners.contact')}</th><th scope="col">{t('common.added')}</th><th scope="col">{t('common.actions')}</th></tr></thead>
                <tbody>
                  {list.data.items.map((p) => (
                    <tr key={p._id}>
                      <td><Link to={`/admin/partners/${p._id}`}>{p.name}</Link></td>
                      <td>{PARTNER_KIND_LABEL[p.kind] ?? p.kind}</td>
                      <td>
                        <Badge tone={stateTone(p.verification?.state)}>{VERIFICATION_LABEL[p.verification?.state] ?? p.verification?.state}</Badge>
                        {!p.isActive && p.verification?.state !== 'suspended' && <> <Badge tone="danger">{t('common.inactive')}</Badge></>}
                      </td>
                      <td>{p.contact?.phone}{p.contact?.email ? ` · ${p.contact.email}` : ''}</td>
                      <td>{formatDateTime(p.createdAt)}</td>
                      <td><PartnerStateActions partner={p} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {(lastPage > 1 || page > 1) && (
              <nav className="ws-pager" aria-label={t('common.pages')}>
                <Button variant="secondary" disabled={page <= 1} onClick={() => setFilter('page', page - 1 > 1 ? String(page - 1) : '')}>{t('common.previous')}</Button>
                <span>{t('common.pageOf', { page, lastPage })}</span>
                <Button variant="secondary" disabled={page >= lastPage} onClick={() => setFilter('page', String(page + 1))}>{t('common.next')}</Button>
              </nav>
            )}
          </>
        )}
    </>
  );
}
