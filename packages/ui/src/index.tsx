import { useCallback, useEffect, useId, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type Ref, type TextareaHTMLAttributes } from 'react';
import { t } from './i18n/index.ts';

/** The shared UI words (`packages/ui/src/i18n/en.ts` lists them): Back, Cancel, Try again, Loading… */
export { t as shared } from './i18n/index.ts';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

export function Button({ variant = 'primary', busy = false, className = '', children, disabled, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean; ref?: Ref<HTMLButtonElement> }) {
  return (
    <button {...rest} type={rest.type ?? 'button'} disabled={disabled || busy} aria-busy={busy || undefined}
      className={`j-btn j-btn--${variant} ${className}`.trim()}>
      {children}
    </button>
  );
}

interface FieldProps {
  label: string;
  hint?: string;
  error?: string | null;
}

/**
 * A field's description: an `aria-describedby` passed in (e.g. the sentence naming where a code was sent) comes first,
 * then the hint and the error. WQ11a: the error is announced when it appears (`role="alert"`).
 */
const describedByOf = (own: string | undefined, inputId: string, hint?: string, error?: string | null) =>
  [own ?? '', hint ? `${inputId}-hint` : '', error ? `${inputId}-error` : ''].filter(Boolean).join(' ') || undefined;

export function TextField({ label, hint, error, id, 'aria-describedby': own, ...rest }:
  FieldProps & InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <div className="j-field">
      <label htmlFor={inputId}>{label}</label>
      <input {...rest} id={inputId} aria-invalid={error ? true : undefined} aria-describedby={describedByOf(own, inputId, hint, error)} />
      {hint && <span id={`${inputId}-hint`} className="j-field__hint">{hint}</span>}
      {error && <span id={`${inputId}-error`} className="j-field__error" role="alert">{error}</span>}
    </div>
  );
}

export function TextArea({ label, hint, error, id, 'aria-describedby': own, ...rest }: FieldProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <div className="j-field">
      <label htmlFor={inputId}>{label}</label>
      <textarea {...rest} id={inputId} aria-invalid={error ? true : undefined} aria-describedby={describedByOf(own, inputId, hint, error)} />
      {hint && <span id={`${inputId}-hint`} className="j-field__hint">{hint}</span>}
      {error && <span id={`${inputId}-error`} className="j-field__error" role="alert">{error}</span>}
    </div>
  );
}

export function Alert({ tone = 'error', children }: { tone?: 'error' | 'ok' | 'warn'; children: ReactNode }) {
  return <div className={`j-alert j-alert--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>{children}</div>;
}

export function Badge({ tone, children }: { tone?: 'warn' | 'danger' | 'ok'; children: ReactNode }) {
  return <span className={`j-badge${tone ? ` j-badge--${tone}` : ''}`}>{children}</span>;
}

/**
 * WQ11a: shown while a session renewal is being retried after a network or server failure: the person stays signed in
 * and nothing else changes; it goes away once the renewal succeeds.
 */
export function Reconnecting() {
  return <div className="j-reconnecting" role="status" aria-live="polite">{t('state.reconnecting')}</div>;
}

/**
 * WQ11a N3: shown instead of the start-up screen while the first refresh gets no answer: the session may still be
 * there and is resumed as soon as the server answers; "Sign in again" is the way out.
 */
export function ReconnectingStart({ onSignIn }: { onSignIn: () => void }) {
  return (
    <main className="login">
      <div className="j-state">
        <span role="status" aria-live="polite">{t('state.reconnectingStart')}</span>
        <Button variant="secondary" onClick={onSignIn}>{t('action.signInAgain')}</Button>
      </div>
    </main>
  );
}

/** Every data screen shows one of these while it has no content to show. */
export function Loading({ label }: { label?: string }) {
  return <div className="j-state" role="status" aria-live="polite">{label ?? t('state.loading')}</div>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="j-state">
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="j-state" role="alert">
      <span>{message}</span>
      {onRetry && <Button variant="secondary" onClick={onRetry}>{t('action.tryAgain')}</Button>}
    </div>
  );
}

/** Money in Indian grouping and India date-times, in the current language (docs/I18N_PLAN.md §3.5). */
export { formatDateTime, formatRupees } from '@jansetu/i18n';
export { LanguageScope, LanguageSwitcher, Parts, useLanguage } from './language.tsx';

/** Whole seconds left until `until` (epoch ms) at `now`; 0 when none or passed. */
export const cooldownLeft = (until: number | undefined, now: number) => (until && until > now ? Math.ceil((until - now) / 1000) : 0);

/**
 * WQ9: code-resend waits kept per destination (O1 limits are per destination), in memory only: switching from A to B
 * and back to A keeps A's wait. `start` (re)arms one destination; `remaining` reads one.
 */
export function useCooldowns() {
  const [until, setUntil] = useState<Record<string, number>>({});
  const [now, setNow] = useState(() => Date.now());
  const active = Object.values(until).some((t) => t > now);
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => setNow(Date.now()), 1000);
    return () => clearTimeout(t);
  }, [active, now]);
  const start = useCallback((key: string, seconds: number) => {
    const t = Date.now();
    setNow(t);
    setUntil((u) => ({ ...u, [key]: t + seconds * 1000 }));
  }, []);
  const remaining = (key: string | null | undefined) => (key ? cooldownLeft(until[key], now) : 0);
  return { start, remaining };
}
