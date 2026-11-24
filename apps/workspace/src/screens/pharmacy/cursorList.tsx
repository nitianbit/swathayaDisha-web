import { useState } from 'react';
import { Button } from '@jansetu/ui';

/**
 * WQ17: the newest-first, cursor-paged lists of what a pharmacy booked (consultations, lab tests): a status filter and
 * "Newer" / "Older" over the cursors seen so far ('' = the first page). Moved here from Booked consultations.
 */
export function useCursorPages() {
  const [cursors, setCursors] = useState<string[]>(['']);
  return {
    cursor: cursors[cursors.length - 1]!,
    page: cursors.length,
    reset: () => setCursors(['']),
    older: (next: string) => setCursors((c) => [...c, next]),
    newer: () => setCursors((c) => c.slice(0, -1)),
  };
}

export function CursorPager({ pages, nextCursor, label }: { pages: ReturnType<typeof useCursorPages>; nextCursor: string | null | undefined; label: string }) {
  if (pages.page <= 1 && !nextCursor) return null;
  return (
    <nav className="ws-pager" aria-label={label}>
      <Button variant="secondary" disabled={pages.page <= 1} onClick={pages.newer}>Newer</Button>
      <span>Page {pages.page}</span>
      <Button variant="secondary" disabled={!nextCursor} onClick={() => pages.older(nextCursor!)}>Older</Button>
    </nav>
  );
}

export function StatusFilter<T extends string>({ id, value, options, onChange }: {
  id: string; value: T | ''; options: readonly { value: T | ''; label: string }[]; onChange: (v: T | '') => void;
}) {
  return (
    <div className="ws-filter">
      <div className="j-field">
        <label htmlFor={id}>Status</label>
        <select id={id} value={value} onChange={(e) => onChange(e.target.value as T | '')}>
          {options.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
      </div>
    </div>
  );
}
