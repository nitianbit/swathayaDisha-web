import { subscribeLanguage } from '@jansetu/i18n';

/**
 * Module-level words without words at module load (docs/I18N_PLAN.md §3.4 rule 1). The exported shapes stay as they
 * were (a code → words map, a list of `{ code, label }`, a plain string constant), so the screens that import them need
 * no change: the map and the list hold catalogue keys and read the words each time one is looked up; a string constant
 * is read again whenever the language changes.
 */

/** A catalogue's `t`; the keys given must be its own (typed), and take no params. */
type Reader = (key: any, ...params: any[]) => string;
type KeyOf<T extends Reader> = Parameters<T>[0];

/**
 * `const LABEL = wordMap(t, { pending: 'status.pending', … })`: a frozen `Record<code, string>` whose values are the
 * current language's words, read at lookup (own, enumerable properties, so `Object.hasOwn`, `Object.entries` and
 * `LABEL[code] ?? code` work as on a plain object).
 */
export function wordMap<T extends Reader, const M extends Readonly<Record<string, KeyOf<T>>>>(t: T, keys: M): Readonly<Record<keyof M, string>> {
  const out = {} as Record<keyof M, string>;
  for (const [code, key] of Object.entries(keys)) {
    Object.defineProperty(out, code, { get: () => t(key), enumerable: true });
  }
  return Object.freeze(out);
}

/** `[{ code, label }]` whose `label` is read at lookup (a picker's options). */
export function labelledList<T extends Reader, const C extends string>(t: T, entries: readonly (readonly [C, KeyOf<T>])[]): readonly { readonly code: C; readonly label: string }[] {
  return Object.freeze(entries.map(([code, key]) => Object.freeze({ code, get label() { return t(key); } })));
}

/** `[{ value, label }]` (a picker's options) whose `label` is read at lookup. */
export function valueList<T extends Reader, const V extends string>(t: T, entries: readonly (readonly [V, KeyOf<T>])[]): readonly { readonly value: V; readonly label: string }[] {
  return Object.freeze(entries.map(([value, key]) => Object.freeze({ value, get label() { return t(key); } })));
}

/**
 * For an exported string constant that screens import as a string (`export let X_MESSAGE = ''`): `set` runs now and
 * again on every language change, so the import (an ES live binding) always holds the current language's words.
 */
export function onLanguage(set: () => void): void {
  set();
  subscribeLanguage(set);
}
