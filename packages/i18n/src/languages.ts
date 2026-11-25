/**
 * The UI languages (docs/I18N_PLAN.md §1, §3.7). Each is written in its own script and never translated. A language is
 * offered in an app only once it is released there (at least 95% of that app's words present, machine translations
 * included, §5.4); English always is.
 */
export const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'hi', name: 'हिन्दी' },
  { code: 'as', name: 'অসমীয়া' },
  { code: 'bn', name: 'বাংলা' },
  { code: 'or', name: 'ଓଡ଼ିଆ' },
] as const;

export type Lang = (typeof LANGUAGES)[number]['code'];
export type AppName = 'customer' | 'workspace';

/** Released per app. Only English until a language's translations are 95% present for that app (round 6k). */
export const RELEASED: Readonly<Record<AppName, readonly Lang[]>> = {
  customer: ['en'],
  workspace: ['en'],
};

export const isLang = (code: unknown): code is Lang => LANGUAGES.some((l) => l.code === code);
export const languageName = (code: Lang) => LANGUAGES.find((l) => l.code === code)?.name ?? code;
