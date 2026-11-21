import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ApiError, appointmentInstant } from '@jansetu/api';
import { Alert, Button, TextArea } from '@jansetu/ui';

export function PageHeading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="page-head">
      <h1 id="page-title" tabIndex={-1}>{title}</h1>
      {children && <p className="page-sub">{children}</p>}
    </header>
  );
}

/** One sentence the customer can act on. Server messages are written for people and shown as given. */
export function messageOf(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return 'Something went wrong. Please try again.';
}

/** "Fri, 20 Nov 2026 · 9:30 am" in IST, from the backend's YYYYMMDD + time. */
export function formatAppointment(bookingDate: string, bookingTime: string): string {
  const a = appointmentInstant(bookingDate, bookingTime);
  if (!a) return [bookingDate, bookingTime].filter(Boolean).join(' ');
  const d = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(a.at);
  const t = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(a.at);
  return `${d} · ${t}`;
}

export const BOOKING_STATUS: Record<string, { label: string; tone?: 'ok' | 'warn' | 'danger' }> = {
  pending: { label: 'Awaiting confirmation', tone: 'warn' },
  pending_payment: { label: 'Awaiting payment', tone: 'warn' },
  created: { label: 'Created', tone: 'warn' },
  confirmed: { label: 'Confirmed', tone: 'ok' },
  rescheduled: { label: 'Rescheduled', tone: 'ok' },
  completed: { label: 'Completed' },
  report_delivered: { label: 'Report ready', tone: 'ok' },
  cancellation_requested: { label: 'Cancelling', tone: 'warn' },
  cancelled: { label: 'Cancelled', tone: 'danger' },
  no_show: { label: 'Missed (no refund)', tone: 'danger' },
};

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
      {withReason && <TextArea label="Reason (optional)" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />}
      {error && <Alert>{error}</Alert>}
      <div className="confirm-actions">
        <Button variant="danger" busy={busy} onClick={async () => {
          setBusy(true); setError(null);
          try {
            await onConfirm(reason.trim());
            if (alive.current) close();
          } catch (err) { setError(messageOf(err)); } finally { if (alive.current) setBusy(false); }
        }}>{confirmLabel}</Button>
        <Button ref={back} variant="ghost" disabled={busy} onClick={() => { setError(null); close(); }}>Back</Button>
      </div>
    </div>
  );
}
