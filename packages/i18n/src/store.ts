import type { Lang } from './languages.ts';

/** `pseudo`: English made strange and longer, to find missed words and tight layouts (development and tests only). */
export type UiLang = Lang | 'pseudo';

let current: UiLang = 'en';
const listeners = new Set<() => void>();

export const getLanguage = (): UiLang => current;

export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Internal: the one place the language changes (after its words are loaded). */
export function applyLanguage(lang: UiLang): void {
  current = lang;
  if (typeof document !== 'undefined') document.documentElement.lang = lang === 'pseudo' ? 'en' : lang;
  for (const listener of [...listeners]) listener();
}

/** Internal: a catalogue's words arrived late (it was registered while another language was showing). */
export function notifyLanguage(): void {
  for (const listener of [...listeners]) listener();
}
