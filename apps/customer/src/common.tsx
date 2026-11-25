import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { appointmentInstant, messageOf, type Relationship } from '@jansetu/api';
import { formatDateWith, INDIA_TIME } from '@jansetu/i18n';
import { Alert, Button, shared, TextArea } from '@jansetu/ui';
import { t, type CustomerKey } from './i18n/index.ts';

export function PageHeading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="page-head">
      <h1 id="page-title" tabIndex={-1}>{title}</h1>
      {children && <p className="page-sub">{children}</p>}
    </header>
  );
}

/** One sentence the customer can act on: the shared `messageOf` of `@jansetu/api` (re-exported for the screens). */
export { messageOf };

/** "Fri, 20 Nov 2026 · 9:30 am" in IST, from the backend's YYYYMMDD + time. */
export function formatAppointment(bookingDate: string, bookingTime: string): string {
  const a = appointmentInstant(bookingDate, bookingTime);
  if (!a) return [bookingDate, bookingTime].filter(Boolean).join(' ');
  const d = formatDateWith(a.at, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: INDIA_TIME });
  const time = formatDateWith(a.at, { hour: 'numeric', minute: '2-digit', timeZone: INDIA_TIME });
  return `${d} · ${time}`;
}

type Tone = 'ok' | 'warn' | 'danger';
/** A status's words (a catalogue key) and badge tone; worded at render by `statusOf`. */
export type StatusWords = { key: CustomerKey; tone?: Tone };

/** A status badge: its words, or the raw code (underscores as spaces) when the app does not know it. */
export function statusOf(map: Readonly<Record<string, StatusWords>>, status: string): { label: string; tone?: Tone } {
  const s = Object.hasOwn(map, status) ? map[status] : undefined;
  return s ? { label: t(s.key), tone: s.tone } : { label: String(status).replace(/_/g, ' ') };
}

export const BOOKING_STATUS: Readonly<Record<string, StatusWords>> = {
  pending: { key: 'status.awaitingConfirmation', tone: 'warn' },
  pending_payment: { key: 'status.awaitingPayment', tone: 'warn' },
  created: { key: 'status.created', tone: 'warn' },
  confirmed: { key: 'status.confirmed', tone: 'ok' },
  rescheduled: { key: 'status.rescheduled', tone: 'ok' },
  completed: { key: 'status.completed' },
  report_delivered: { key: 'status.reportReady', tone: 'ok' },
  cancellation_requested: { key: 'status.cancelling', tone: 'warn' },
  cancelled: { key: 'status.cancelled', tone: 'danger' },
  no_show: { key: 'status.missedNoRefund', tone: 'danger' },
};

const GENDER = { Female: 'gender.female', Male: 'gender.male', Other: 'gender.other' } as const;
/** A gender value from the server in words; an unknown value as sent. */
export const genderLabel = (g: string) => (Object.hasOwn(GENDER, g) ? t(GENDER[g as keyof typeof GENDER]) : g);

const RELATIONSHIP: Readonly<Record<Relationship, CustomerKey>> = {
  Me: 'relationship.me', Father: 'relationship.father', Mother: 'relationship.mother', Spouse: 'relationship.spouse', Son: 'relationship.son',
  Daughter: 'relationship.daughter', Brother: 'relationship.brother', Sister: 'relationship.sister', Grandfather: 'relationship.grandfather',
  Grandmother: 'relationship.grandmother', Friend: 'relationship.friend', Other: 'relationship.other',
};
/** A relationship from the server in words; an unknown value as sent. */
export const relationshipLabel = (r: string): string => (Object.hasOwn(RELATIONSHIP, r) ? t(RELATIONSHIP[r as Relationship]) : r);

/**
 * Two-step confirmation for things that cannot be undone: the first tap says what will happen, the second does it.
 * WQ11a: opening it moves the focus to "Back" (never to the action: pressing Enter twice cannot carry it out), the
 * consequence is the group's description, so it is read out; Back, or finishing, returns the focus to the opener.
 */
export function Confirm({ label, consequence, confirmLabel, withReason = false, onConfirm, disabled }: {
  label: string; consequence: ReactNode; confirmLabel: string; withReason?: boolean; disabled?: boolean;
  onConfirm: (reason: string) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const back = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  // null: nothing to move; 'in' after opening; 'back' after closing (only when the focus was inside the group).
  const move = useRef<'in' | 'back' | null>(null);
  const group = useRef<HTMLDivElement>(null);
  const consequenceId = useId();
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (move.current === 'in') back.current?.focus();
    else if (move.current === 'back') opener.current?.focus();
    move.current = null;
  }, [open]);
  const close = () => {
    if (group.current?.contains(document.activeElement) || document.activeElement === document.body) move.current = 'back';
    setOpen(false);
  };
  if (!open) {
    return <Button ref={opener} variant="secondary" disabled={disabled} onClick={() => { move.current = 'in'; setOpen(true); }}>{label}</Button>;
  }
  return (
    <div ref={group} className="confirm" role="group" aria-label={label} aria-describedby={consequenceId}>
      <div id={consequenceId}>{consequence}</div>
      {withReason && <TextArea label={t('confirm.reason')} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />}
      {error && <Alert>{error}</Alert>}
      <div className="confirm-actions">
        <Button variant="danger" busy={busy} onClick={async () => {
          setBusy(true); setError(null);
          try {
            await onConfirm(reason.trim());
            if (alive.current) close();
          } catch (err) { setError(messageOf(err)); } finally { if (alive.current) setBusy(false); }
        }}>{confirmLabel}</Button>
        <Button ref={back} variant="ghost" disabled={busy} onClick={() => { setError(null); close(); }}>{shared('action.back')}</Button>
      </div>
    </div>
  );
}
