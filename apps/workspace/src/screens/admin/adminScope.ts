import { useCallback, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router';
import { useStaff } from '../../session.tsx';

/**
 * WQ10b: an admin page's query-key prefix and subtree identity, bound to the signed-in admin. Pages render their content
 * under `key={identity}` and keep their queries under `key`, so nothing read, typed or confirmed by one admin can show for
 * another in the same tab (sign-out also clears every query and the session memory).
 */
export function useAdminScope(area: string) {
  const user = useStaff();
  return { key: ['admin', user.id, area] as const, identity: `admin:${user.id}` };
}

/**
 * A list's filters in the address (`?status=…&page=…`), changed one at a time. Each change starts from the last one made,
 * even before the router has re-rendered with it, so two quick changes (a search, then a filter) both count. A change
 * other than the page goes back to page 1.
 */
export function useListParams() {
  const [params, setParams] = useSearchParams();
  const pending = useRef<URLSearchParams | null>(null);
  const seen = params.toString();
  useEffect(() => { pending.current = null; }, [seen]);
  const setFilter = useCallback((key: string, value: string) => {
    const next = new URLSearchParams(pending.current ?? params);
    if (value) next.set(key, value); else next.delete(key);
    if (key !== 'page') next.delete('page');
    pending.current = next;
    setParams(next, { replace: key !== 'page' });
  }, [params, setParams]);
  return { params, setFilter };
}
