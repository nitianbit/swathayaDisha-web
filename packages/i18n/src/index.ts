/**
 * Jansetu UI words (docs/I18N_PLAN.md §3). Framework-free, so `@jansetu/api` can word its refusals; `@jansetu/ui` adds
 * the React side (react-i18next). English is the source and is bundled; another language is a JSON chunk per
 * catalogue, loaded when chosen. A word missing in a language shows in English. The engine is i18next (owner decision
 * 2026-11-25); screens only ever see the typed `t(key, params)` below, so the engine stays an internal detail.
 */
import { isLang, RELEASED, type AppName, type Lang } from './languages.ts';
import { pseudo } from './pseudo.ts';
import { applyLanguage, getLanguage, i18n, type UiLang } from './store.ts';

export * from './format.ts';
export * from './languages.ts';
export { getLanguage, i18n, subscribeLanguage, type UiLang } from './store.ts';

/** A plural: Intl.PluralRules picks the form from `count` (every first-wave language has just these two). */
export interface PluralEntry { readonly one: string; readonly other: string }
export type Entry = string | PluralEntry;
export type Messages = Readonly<Record<string, Entry>>;
/** Inserted as written: numbers are not regrouped, so English stays as it was (`${n}` before). */
export type Value = string | number;

type Placeholders<S> = S extends `${string}{${infer P}}${infer R}` ? P | Placeholders<R> : never;
type NamesOf<E> = E extends PluralEntry ? Placeholders<E['one']> | Placeholders<E['other']> : Placeholders<E>;
/** What a key takes: one value per `{name}` in its English text, plus `count` for a plural. */
export type ParamsOf<E, V = Value> = E extends PluralEntry
  ? { count: number } & { [K in Exclude<NamesOf<E>, 'count'>]: V }
  : { [K in NamesOf<E>]: V };
type Args<E> = E extends PluralEntry ? [params: ParamsOf<E>] : [NamesOf<E>] extends [never] ? [] : [params: ParamsOf<E>];

/** A translation as stored in `<lang>.json`: a string, or the plural forms of that language. */
export type Translation = Readonly<Record<string, string | Readonly<Partial<Record<Intl.LDMLPluralRule, string>>>>>;
type Loader = () => Promise<unknown>;

interface Catalogue {
  name: string;
  en: Messages;
  loaders: ReadonlyMap<string, Loader>;
  /** Languages whose words are in i18next (or that have none to load). */
  loaded: Set<string>;
}

const catalogues = new Map<string, Catalogue>();
const PLACEHOLDER = /\{(\w+)\}/g;
const STORE_KEY = 'jansetu.lang';
let offered: readonly Lang[] = ['en'];
let generation = 0;

const translated = (lang: UiLang): lang is Exclude<Lang, 'en'> => lang !== 'en' && lang !== 'pseudo';

/**
 * A catalogue's words as i18next holds them: flat keys, a plural as `key_<form>`. Only words shaped like their English
 * entry are kept (a string for a string, plural forms for a plural); anything else shows in English.
 */
function resources(en: Messages, words: Readonly<Record<string, unknown>>, map: (text: string) => string = (x) => x) {
  const out: Record<string, string> = {};
  for (const [key, english] of Object.entries(en)) {
    if (!Object.hasOwn(words, key)) continue;
    const own = words[key];
    if (typeof english === 'string') {
      if (typeof own === 'string') out[key] = map(own);
    } else if (own && typeof own === 'object' && !Array.isArray(own)) {
      for (const [form, text] of Object.entries(own)) if (typeof text === 'string') out[`${key}_${form}`] = map(text);
    }
  }
  return out;
}

const warned = new Set<string>();
/** Development only, once per key, by key alone: params may hold a person's name and are never printed. */
function noteMissing(catalogue: string, lang: string, key: string) {
  if (!import.meta.env.DEV || warned.has(`${lang}:${catalogue}:${key}`)) return;
  warned.add(`${lang}:${catalogue}:${key}`);
  console.warn(`[i18n] ${lang}: ${catalogue}:${key} is not translated yet; English is shown.`);
}

type Lookup = (key: string, options: Readonly<Record<string, unknown>>) => { res: string; usedLng: string };

/** The words for `key` in the current language, else English; filled from `params` unless `raw`. */
function lookup(c: Catalogue, key: string, params: Readonly<Record<string, unknown>> | undefined, raw: boolean): string {
  const en = c.en[key];
  if (en === undefined) return key; // typed keys make this unreachable; `has` guards keys made from server codes
  const { res, usedLng } = (i18n.t as unknown as Lookup)(key, {
    ns: c.name,
    replace: params ?? {},
    // Only a plural picks a form; `{count}` in a plain text is just a placeholder.
    ...(typeof en === 'string' ? {} : { count: Number(params?.count ?? 0) }),
    skipInterpolation: raw,
    nest: false,
    returnDetails: true,
  });
  const lang = getLanguage();
  if (translated(lang) && usedLng !== lang) noteMissing(c.name, lang, key);
  return res;
}

function parts<V>(text: string, params: Readonly<Record<string, unknown>>): (string | V)[] {
  const out: (string | V)[] = [];
  let last = 0;
  for (const m of text.matchAll(PLACEHOLDER)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const name = m[1]!;
    const value = Object.hasOwn(params, name) ? params[name] : m[0];
    out.push(typeof value === 'string' || typeof value === 'number' ? String(value) : value as V);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

async function load(c: Catalogue, lang: UiLang): Promise<boolean> {
  if (c.loaded.has(lang)) return true;
  // `import.meta.env.DEV` first: a release build drops the pseudo-language entirely.
  if (import.meta.env.DEV && lang === 'pseudo') {
    i18n.addResourceBundle(lang, c.name, resources(c.en, c.en, pseudo), false, true);
    c.loaded.add(lang);
    return true;
  }
  const loader = c.loaders.get(lang);
  if (!loader) {
    c.loaded.add(lang);
    return true;
  }
  try {
    const words = ((await loader()) as { default?: unknown } | null)?.default;
    const own = words && typeof words === 'object' && !Array.isArray(words) ? words as Readonly<Record<string, unknown>> : {};
    i18n.addResourceBundle(lang, c.name, resources(c.en, own), false, true);
    c.loaded.add(lang);
    return true;
  } catch {
    return false;
  }
}

/**
 * One catalogue: its English words (`en.ts`, `as const`) and its translations (`import.meta.glob` of its JSON files,
 * `<lang>.source.json` excluded). Returns its `t`: typed keys, and typed `{placeholders}` from the English text. The
 * catalogue is one i18next namespace, named `name`.
 */
export function catalogue<const C extends Messages>(name: string, en: C, files: Readonly<Record<string, Loader>> = {}) {
  const loaders = new Map<string, Loader>();
  for (const [path, loader] of Object.entries(files)) {
    const lang = /\/([a-z]{2,3})\.json$/.exec(path)?.[1];
    if (lang) loaders.set(lang, loader);
  }
  // Replaced by name: a module run again (hot reload) does not keep old words.
  if (catalogues.has(name)) for (const lng of Object.keys(i18n.store.data)) i18n.removeResourceBundle(lng, name);
  const c: Catalogue = { name, en, loaders, loaded: new Set(['en']) };
  catalogues.set(name, c);
  i18n.addResourceBundle('en', name, resources(en, en), false, true);
  const lang = getLanguage();
  if (lang !== 'en') void load(c, lang);

  function t<K extends keyof C & string>(key: K, ...args: Args<C[K]>): string {
    return lookup(c, key, args[0] as Readonly<Record<string, unknown>> | undefined, false);
  }
  /** The words with some placeholders as elements (React nodes): text and elements in order. */
  t.rich = <K extends keyof C & string, V>(key: K, params: ParamsOf<C[K], Value | V>): (string | V)[] => {
    const p = params as Readonly<Record<string, unknown>>;
    return parts<V>(lookup(c, key, p, true), p);
  };
  /** For keys made from server codes (`errors.${code}`). */
  t.has = (key: string): key is keyof C & string => Object.hasOwn(en, key);
  return t;
}

/** The languages this app offers (English first). The switcher shows itself only when there are two or more. */
export const offeredLanguages = (): readonly Lang[] => offered;

const pseudoAllowed = () => import.meta.env.DEV;

/**
 * Switches once every catalogue's words for `lang` are loaded (false, and nothing changes, if one cannot load or a
 * later call won). English and the pseudo-language need no loading.
 */
export async function setLanguage(lang: UiLang): Promise<boolean> {
  const mine = ++generation;
  if (lang === 'pseudo' && !pseudoAllowed()) return false;
  const loaded = await Promise.all([...catalogues.values()].map((c) => load(c, lang)));
  if (!loaded.every(Boolean) || mine !== generation) return false;
  if (lang !== getLanguage()) await applyLanguage(lang);
  return true;
}

function storedLanguage(): string | null {
  try { return localStorage.getItem(STORE_KEY); } catch { return null; }
}

/** A person's own choice: applied, then kept on this device for the sign-in screen (the code only, nothing else). */
export async function chooseLanguage(lang: Lang): Promise<boolean> {
  if (!offered.includes(lang)) return false;
  const ok = await setLanguage(lang);
  if (ok) {
    try { localStorage.setItem(STORE_KEY, lang); } catch { /* the choice still applies to this visit */ }
  }
  return ok;
}

/**
 * Before the first render: the code kept on this device if this app offers it, else the first browser language it
 * offers, else English (docs/I18N_PLAN.md §3.7). The pseudo-language can be kept only in development. Never fails: a
 * language that cannot load leaves English.
 */
export async function startLanguage(app: AppName, released: readonly Lang[] = RELEASED[app]): Promise<void> {
  offered = released.includes('en') ? released : ['en', ...released];
  const kept = storedLanguage();
  const browser = (typeof navigator === 'undefined' ? [] : navigator.languages ?? []).map((b) => b.toLowerCase().split('-')[0]);
  const wanted: UiLang = kept === 'pseudo' && pseudoAllowed() ? 'pseudo'
    : isLang(kept) && offered.includes(kept) ? kept
      : browser.find((b): b is Lang => isLang(b) && offered.includes(b)) ?? 'en';
  if (wanted !== getLanguage()) await setLanguage(wanted);
}
