import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { Badge, Button, Empty, TextField } from '@jansetu/ui';
import { t } from '../../i18n/admin/index.ts';
import { PageHeading } from '../../PageHeading.tsx';

/**
 * Pieces shared by the admin account lists and pages (pharmacies, doctors): the verification and active filters and the
 * page number from the address, the name searched (page memory only, never the address), status badges, the pager and the
 * "no such record" page.
 */

export interface StateFilters { isVerified?: 'true' | 'false'; isActive?: 'true' | 'false'; page?: number }

/** `isVerified`, `isActive` and `page` from the address, kept only when they are values the list schemas accept. */
export function stateFiltersOf(params: URLSearchParams): StateFilters {
  const verified = params.get('isVerified');
  const active = params.get('isActive');
  const page = Number.parseInt(params.get('page') ?? '1', 10);
  return {
    ...(Number.isInteger(page) && page > 1 ? { page } : {}),
    ...(verified === 'true' || verified === 'false' ? { isVerified: verified } : {}),
    ...(active === 'true' || active === 'false' ? { isActive: active } : {}),
  };
}

/**
 * The name searched, in the page's memory only. A new name searched on a later page reads nothing until the address is
 * back on page 1 (`resetting`).
 */
export function useNameSearch(params: URLSearchParams, setFilter: (key: string, value: string) => void, maxLength = 100) {
  const [name, setName] = useState('');
  const [search, setSearch] = useState('');
  const [resetting, setResetting] = useState(false);
  const urlPage = params.get('page');
  useEffect(() => { if (!urlPage) setResetting(false); }, [urlPage]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next = search.trim().slice(0, maxLength);
    if (next === name) return;
    if (urlPage) { setResetting(true); setFilter('page', ''); }
    setName(next);
  };
  return { name, search, setSearch, submit, resetting, maxLength };
}

/** The search-by-name form of `useNameSearch`. */
export function NameSearch({ s }: { s: ReturnType<typeof useNameSearch> }) {
  return (
    <form className="ws-search" role="search" onSubmit={s.submit}>
      <TextField label={t('common.searchByName')} value={s.search} maxLength={s.maxLength} onChange={(e) => s.setSearch(e.target.value)} />
      <Button type="submit" variant="secondary">{t('common.search')}</Button>
    </form>
  );
}
/** The verification and active filters (`idPrefix` keeps the labels' ids unique per page). */
export function StateFilterSelects({ idPrefix, q, setFilter }: { idPrefix: string; q: StateFilters; setFilter: (key: string, value: string) => void }) {
  return (
    <div className="ws-search" role="group" aria-label={t('common.filters')}>
      <div className="j-field ws-filter">
        <label htmlFor={`${idPrefix}-verified`}>{t('common.verification')}</label>
        <select id={`${idPrefix}-verified`} value={q.isVerified ?? ''} onChange={(e) => setFilter('isVerified', e.target.value)}>
          <option value="">{t('common.verifiedOrNot')}</option>
          <option value="true">{t('common.verified')}</option>
          <option value="false">{t('common.notVerified')}</option>
        </select>
      </div>
      <div className="j-field ws-filter">
        <label htmlFor={`${idPrefix}-active`}>{t('common.active')}</label>
        <select id={`${idPrefix}-active`} value={q.isActive ?? ''} onChange={(e) => setFilter('isActive', e.target.value)}>
          <option value="">{t('common.activeOrNot')}</option>
          <option value="true">{t('common.active')}</option>
          <option value="false">{t('common.inactive')}</option>
        </select>
      </div>
    </div>
  );
}

/** Verification and active state as badges. */
export function StateBadges({ verified, active }: { verified: boolean; active: boolean }) {
  return (
    <>
      <Badge tone={verified ? 'ok' : 'warn'}>{verified ? t('common.verified') : t('common.notVerified')}</Badge>
      {!active && <> <Badge tone="danger">{t('common.inactive')}</Badge></>}
    </>
  );
}

/** Previous / next through the address's `page`. */
export function Pager({ page, lastPage, setFilter }: { page: number; lastPage: number; setFilter: (key: string, value: string) => void }) {
  if (lastPage <= 1 && page <= 1) return null;
  return (
    <nav className="ws-pager" aria-label={t('common.pages')}>
      <Button variant="secondary" disabled={page <= 1} onClick={() => setFilter('page', page - 1 > 1 ? String(page - 1) : '')}>{t('common.previous')}</Button>
      <span>{t('common.pageOf', { page, lastPage })}</span>
      <Button variant="secondary" disabled={page >= lastPage} onClick={() => setFilter('page', String(page + 1))}>{t('common.next')}</Button>
    </nav>
  );
}

/** A record page opened with an id that cannot exist (`missing`: "No such pharmacy"). */
export function NoSuchRecord({ back, backLabel, title, missing, children }: {
  back: string; backLabel: string; title: string; missing: string; children: ReactNode;
}) {
  return (
    <>
      <Link className="ws-back" to={back}><ArrowLeft size={16} aria-hidden="true" /> {backLabel}</Link>
      <PageHeading title={title} />
      <Empty title={missing}>{children}</Empty>
    </>
  );
}
