import { Fragment, useId, useState, useSyncExternalStore, type ReactNode } from 'react';
import { chooseLanguage, getLanguage, isLang, languageName, offeredLanguages, subscribeLanguage, type UiLang } from '@jansetu/i18n';
import { t } from './i18n/index.ts';

/** The current UI language; a component using it renders again when it changes. */
export function useLanguage(): UiLang {
  return useSyncExternalStore(subscribeLanguage, getLanguage);
}

/**
 * The page content under it is mounted again when the language changes, as if the person left the page and came back
 * (docs/I18N_PLAN.md §3.7): every word is read again. Keep it below whatever must outlive a switch (session, query
 * cache, a doctor's presence).
 */
export function LanguageScope({ children }: { children: ReactNode }) {
  return <Fragment key={useLanguage()}>{children}</Fragment>;
}

/** Text and elements from `t.rich`, rendered in order. */
export function Parts({ of }: { of: readonly ReactNode[] }) {
  return <>{of.map((part, i) => <Fragment key={i}>{part}</Fragment>)}</>;
}

/**
 * The language list (docs/I18N_PLAN.md §3.7): each language in its own script; the label also in English when the
 * screen is not. Shows nothing until this app offers a second language.
 */
export function LanguageSwitcher({ className }: { className?: string }) {
  const lang = useLanguage();
  const id = useId();
  const [failed, setFailed] = useState<string | null>(null);
  const offered = offeredLanguages();
  if (offered.length < 2) return null;
  const label = t('language.label');
  return (
    <div className={`j-field ${className ?? ''}`.trim()}>
      <label htmlFor={id}>{lang === 'en' || lang === 'pseudo' ? label : `${label} · Language`}</label>
      <select id={id} value={lang} aria-describedby={failed ? `${id}-error` : undefined}
        onChange={(e) => {
          const next = e.target.value;
          if (!isLang(next)) return;
          setFailed(null);
          void chooseLanguage(next).then((ok) => { if (!ok) setFailed(languageName(next)); });
        }}>
        {offered.map((code) => <option key={code} value={code} lang={code}>{languageName(code)}</option>)}
      </select>
      {failed && <span id={`${id}-error`} className="j-field__error" role="alert">{t('language.loadFailed', { language: failed })}</span>}
    </div>
  );
}
