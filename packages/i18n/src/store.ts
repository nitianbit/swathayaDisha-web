import { createInstance } from 'i18next';
import type { Lang } from './languages.ts';

/** `pseudo`: English made strange and longer, to find missed words and tight layouts (development and tests only). */
export type UiLang = Lang | 'pseudo';

/**
 * The one i18next instance (owner decision 2026-11-25, docs/I18N_PLAN.md §3.1). Each catalogue is a namespace of flat
 * keys (`'wallet.title'`): neither `.` nor `:` splits a key. Placeholders are `{name}`, inserted as written (React
 * escapes, so i18next does not); plurals are `key_one` / `key_other`, picked by `Intl.PluralRules`; English is the
 * fallback for every missing word. Words are only added by `catalogue()` and `setLanguage()`: i18next fetches nothing.
 * Exported for the React bindings in `@jansetu/ui` only; screens use a catalogue's typed `t`, never this.
 */
export const i18n = createInstance();
// Registered before any other listener (the React bindings), so `<html lang>` is right when screens render again.
i18n.on('languageChanged', (lng: string) => {
  if (typeof document !== 'undefined') document.documentElement.lang = lng === 'pseudo' ? 'en' : lng;
});
void i18n.init({
  lng: 'en',
  fallbackLng: 'en',
  resources: {},
  initAsync: false,
  ns: [],
  defaultNS: false,
  keySeparator: false,
  nsSeparator: false,
  pluralSeparator: '_',
  returnNull: false,
  returnEmptyString: false,
  interpolation: { prefix: '{', suffix: '}', escapeValue: false, skipOnVariables: true },
  // Read by react-i18next (`@jansetu/ui`): every word is bundled or loaded before a switch, so nothing suspends; the
  // bindings render again when words are added (a catalogue loaded after the switch).
  react: { useSuspense: false, bindI18n: 'languageChanged', bindI18nStore: 'added' },
});

export const getLanguage = (): UiLang => i18n.language as UiLang;

/** Called when the language changes, and when words for the language showing arrive late. */
export function subscribeLanguage(listener: () => void): () => void {
  const late = (lng: string) => { if (lng === i18n.language) listener(); };
  i18n.on('languageChanged', listener);
  i18n.store.on('added', late);
  return () => {
    i18n.off('languageChanged', listener);
    i18n.store.off('added', late);
  };
}

/** Internal: the one place the language changes (after its words are loaded). */
export async function applyLanguage(lang: UiLang): Promise<void> {
  await i18n.changeLanguage(lang);
}
