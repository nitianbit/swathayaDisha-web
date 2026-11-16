import { ApiError } from '@jansetu/api';
import { useCallback, useReducer, useRef } from 'react';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * An edit form's state: what the person started from (`base`, the server's value when the edit began or was last
 * rebased) and what they typed (`draft`). Only fields that differ from `base` are ever sent, so a field nobody touched
 * is never written back with an old value.
 */
export interface DraftState<T> { base: T; draft: T }

/** Fields the person changed. */
export function dirtyKeys<T extends object>(s: DraftState<T>): (keyof T)[] {
  return (Object.keys(s.draft) as (keyof T)[]).filter((k) => !same(s.draft[k], s.base[k]));
}

/** What to send: the changed fields only. */
export function changedFields<T extends object>(s: DraftState<T>): Partial<T> {
  return Object.fromEntries(dirtyKeys(s).map((k) => [k, s.draft[k]])) as Partial<T>;
}

/**
 * Moves an open draft onto a newer server value. Untouched fields follow the server. A field the person changed AND
 * the server changed (to something else) is a conflict: it is reset to the server's value so they review it again.
 */
export function rebase<T extends object>(s: DraftState<T>, latest: T): { next: DraftState<T>; conflicts: (keyof T)[] } {
  const draft = { ...s.draft };
  const conflicts: (keyof T)[] = [];
  for (const k of Object.keys(latest) as (keyof T)[]) {
    if (same(latest[k], s.base[k])) continue; // the server did not change it
    const touched = !same(s.draft[k], s.base[k]);
    if (touched && !same(s.draft[k], latest[k])) conflicts.push(k);
    draft[k] = latest[k];
  }
  return { next: { base: latest, draft }, conflicts };
}

/** React state for `DraftState`, readable synchronously (submit handlers check it after an await). */
export function useDraft<T extends object>(initial: () => T) {
  const ref = useRef<DraftState<T> | null>(null);
  if (ref.current === null) { const v = initial(); ref.current = { base: v, draft: v }; }
  const [, render] = useReducer((n: number) => n + 1, 0);
  const set = useCallback(<K extends keyof T>(key: K, value: T[K]) => {
    ref.current = { ...ref.current!, draft: { ...ref.current!.draft, [key]: value } };
    render();
  }, []);
  const update = useCallback((fn: (d: T) => T) => {
    ref.current = { ...ref.current!, draft: fn(ref.current!.draft) };
    render();
  }, []);
  /** Rebases onto `latest`; returns the conflicting fields (empty when none). */
  const rebaseTo = useCallback((latest: T) => {
    const { next, conflicts } = rebase(ref.current!, latest);
    ref.current = next;
    render();
    return conflicts;
  }, []);
  return { state: ref.current, draft: ref.current.draft, set, update, rebaseTo, current: () => ref.current! };
}

/** Plain words for a conflict found when the server changed a field the person was also changing. */
export function staleMessage(fields: string[]): string {
  const list = fields.length > 1 ? `${fields.slice(0, -1).join(', ')} and ${fields.at(-1)}` : fields[0] ?? 'this record';
  return `Someone else changed the ${list} while you were editing. The form now shows what is saved; make your change again if it is still needed.`;
}

/** Q10: the server refused an edit made from an older version of the record (409 RECORD_CHANGED). */
export const isRecordChanged = (err: unknown) => err instanceof ApiError && err.status === 409 && err.code === 'RECORD_CHANGED';

/** Shown when the record moved under a save but none of the person's own fields were touched by the other change. */
export const RECORD_CHANGED_MESSAGE = 'Someone else changed this while you were saving, so nothing was saved. The form now shows what is saved; check it and save again.';
