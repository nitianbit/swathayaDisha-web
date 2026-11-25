import type { Entry, Messages } from './index.ts';

/**
 * The catalogue check (docs/I18N_PLAN.md §5.4), as a pure function so it is tested on its own; `catalogues.test.ts`
 * runs it on every catalogue in the repo.
 */
export type ProblemKind = 'extra' | 'shape' | 'plural' | 'empty' | 'placeholders' | 'stale';
export interface Problem { key: string; kind: ProblemKind }
export interface CheckResult {
  problems: Problem[];
  /** English keys, and how many have a usable translation (present, well formed and current: the release gate). */
  total: number;
  translated: number;
  missing: string[];
}

const placeholders = (text: string) => new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!));
const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((x) => b.has(x));
const englishNames = (e: Entry) => (typeof e === 'string' ? placeholders(e) : new Set([...placeholders(e.one), ...placeholders(e.other)]));

/**
 * One language of one catalogue: `translation` is its `<lang>.json`, `source` its `<lang>.source.json` (the English each
 * translation was made from). A translation whose English has changed since is stale: give the key a new name if the
 * meaning changed, or accept it if it did not.
 */
export function checkTranslation(en: Messages, lang: string, translation: Readonly<Record<string, unknown>>,
  source: Readonly<Record<string, unknown>>): CheckResult {
  const problems: Problem[] = [];
  const forms = new Set<string>(new Intl.PluralRules(lang).resolvedOptions().pluralCategories);
  let translated = 0;
  const missing: string[] = [];
  for (const key of Object.keys(translation)) {
    if (!Object.hasOwn(en, key)) problems.push({ key, kind: 'extra' });
  }
  for (const [key, english] of Object.entries(en)) {
    if (!Object.hasOwn(translation, key)) {
      missing.push(key);
      continue;
    }
    const own = translation[key];
    const texts: string[] = [];
    if (typeof english === 'string') {
      if (typeof own !== 'string') { problems.push({ key, kind: 'shape' }); continue; }
      texts.push(own);
    } else {
      if (!own || typeof own !== 'object' || Array.isArray(own)) { problems.push({ key, kind: 'shape' }); continue; }
      const given = Object.keys(own);
      if (!sameSet(new Set(given), forms) || given.some((f) => typeof (own as Record<string, unknown>)[f] !== 'string')) {
        problems.push({ key, kind: 'plural' });
        continue;
      }
      texts.push(...Object.values(own as Record<string, string>));
    }
    if (texts.some((x) => !x.trim())) { problems.push({ key, kind: 'empty' }); continue; }
    const expected = englishNames(english);
    const used = new Set(texts.flatMap((x) => [...placeholders(x)]));
    // A plural form may leave out {count} (Hindi "one" covers 0 and 1), but no form may add a name.
    const fits = typeof english === 'string' ? sameSet(used, expected)
      : [...used].every((n) => expected.has(n)) && [...expected].every((n) => n === 'count' || used.has(n));
    if (!fits) { problems.push({ key, kind: 'placeholders' }); continue; }
    if (JSON.stringify(source[key]) !== JSON.stringify(english)) { problems.push({ key, kind: 'stale' }); continue; }
    translated++;
  }
  return { problems, total: Object.keys(en).length, translated, missing };
}
