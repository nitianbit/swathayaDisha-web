import { useCallback, useEffect, useId, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type Ref, type TextareaHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

export function Button({ variant = 'primary', busy = false, className = '', children, disabled, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
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

export function TextField({ label, hint, error, id, ...rest }:
  FieldProps & InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  const auto = useId();
  const inputId = id ?? auto;
  const describedBy = [hint ? `${inputId}-hint` : '', error ? `${inputId}-error` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className="j-field">
      <label htmlFor={inputId}>{label}</label>
      <input {...rest} id={inputId} aria-invalid={error ? true : undefined} aria-describedby={describedBy} />
      {hint && <span id={`${inputId}-hint`} className="j-field__hint">{hint}</span>}
      {error && <span id={`${inputId}-error`} className="j-field__error">{error}</span>}
    </div>
  );
}

export function TextArea({ label, hint, error, id, ...rest }: FieldProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const auto = useId();
  const inputId = id ?? auto;
  const describedBy = [hint ? `${inputId}-hint` : '', error ? `${inputId}-error` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className="j-field">
      <label htmlFor={inputId}>{label}</label>
      <textarea {...rest} id={inputId} aria-invalid={error ? true : undefined} aria-describedby={describedBy} />
      {hint && <span id={`${inputId}-hint`} className="j-field__hint">{hint}</span>}
      {error && <span id={`${inputId}-error`} className="j-field__error">{error}</span>}
    </div>
  );
}

export function Alert({ tone = 'error', children }: { tone?: 'error' | 'ok' | 'warn'; children: ReactNode }) {
  return <div className={`j-alert j-alert--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>{children}</div>;
}

export function Badge({ tone, children }: { tone?: 'warn' | 'danger' | 'ok'; children: ReactNode }) {
  return <span className={`j-badge${tone ? ` j-badge--${tone}` : ''}`}>{children}</span>;
}

/** Every data screen shows one of these while it has no content to show. */
export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <div className="j-state" role="status" aria-live="polite">{label}</div>;
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
      {onRetry && <Button variant="secondary" onClick={onRetry}>Try again</Button>}
    </div>
  );
}

/** Money is held in rupees on these records; show it in Indian grouping. */
export function formatRupees(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(value);
}

export function formatDateTime(value: string | undefined | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(d);
}

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
