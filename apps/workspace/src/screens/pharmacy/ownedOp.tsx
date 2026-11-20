import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Button } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { messageOf } from '../../errors.ts';
import { afterFailure, beginAttempt, resolveStored, stillCurrent, type PendingOp } from '../../requests.ts';
import { useSession, useStaff } from '../../session.tsx';

/**
 * WQ10a: the signed-in pharmacy's identity. Screens are keyed by it and put it in their query keys and memory slots,
 * so nothing held for one pharmacy (a draft, an unconfirmed change) is ever shown to or sent for another.
 */
export function usePharmacyId(): string {
  return useStaff().id;
}

export type SendResult<R> =
  | { kind: 'ok'; value: R }
  /** The server refused the only attempt: nothing was recorded. */
  | { kind: 'refused'; error: unknown }
  /** No definite answer: it may have been recorded. The operation stays stored until it is settled. */
  | { kind: 'unknown'; error: unknown }
  /** The page left, or a newer attempt owns the slot: this answer changes nothing. */
  | { kind: 'stale' };

/**
 * One owned change per memory slot. The change is stored BEFORE it is sent (session memory, plus a body-less reload
 * marker), and an answer settles it only while this page is on screen and the attempt still owns the slot
 * (`stillCurrent`). Anything else leaves it stored, and the page shows it as unconfirmed until it is checked.
 */
export function useOwnedOp<B>(slot: string) {
  const { memory } = useSession();
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const [op, setOp] = useState<PendingOp<B> | undefined>(() => memory.get<PendingOp<B>>(slot));
  const show = (p: PendingOp<B> | undefined) => { if (live.current) setOp(p); };

  async function send<R>(p: PendingOp<B>, request: (body: B) => Promise<R>): Promise<SendResult<R>> {
    const attempt = beginAttempt(p);
    memory.set(slot, attempt);
    show(attempt);
    try {
      const value = await request(attempt.body);
      if (!live.current || !stillCurrent(memory.get<PendingOp<B>>(slot), attempt)) return { kind: 'stale' };
      resolveStored(memory, slot, attempt.requestKey);
      show(undefined);
      return { kind: 'ok', value };
    } catch (error) {
      if (!live.current || !stillCurrent(memory.get<PendingOp<B>>(slot), attempt)) return { kind: 'stale' };
      const next = afterFailure(attempt, error, messageOf(error));
      if (next) memory.set(slot, next); else memory.delete(slot);
      show(next ?? undefined);
      return next ? { kind: 'unknown', error } : { kind: 'refused', error };
    }
  }

  /** Ends the stored change `requestKey` (found, or knowingly forgotten), and only that one; only while on screen. */
  function settle(requestKey: string) {
    if (!live.current) return;
    resolveStored(memory, slot, requestKey);
    show(memory.get<PendingOp<B>>(slot));
  }

  return { op, send, settle, live };
}

/**
 * An unconfirmed change: what it was, a way to find out whether it was recorded, and (only where repeating it is safe)
 * sending it again. `onCheck` answers null once it settled the change, or a sentence saying what is still unknown.
 */
export function CheckPanel({ label, children, onCheck, resend, giveUp, forget }: {
  label: string;
  children: ReactNode;
  onCheck: () => Promise<string | null>;
  resend?: { label: string; busy: boolean; onClick: () => void };
  /** Q15: give the request up on the server (its key can then never be recorded), or learn that it was recorded. */
  giveUp?: { label: string; busy: boolean; onClick: () => void };
  /** Offered after a check found nothing, behind a second step that says what forgetting risks. */
  forget?: { label: string; confirmLabel: string; consequence: ReactNode; onForget: () => void };
}) {
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<{ tone: 'warn' | 'error'; text: string } | null>(null);
  const [checked, setChecked] = useState(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  async function check() {
    setChecking(true);
    setNote(null);
    try {
      const left = await onCheck();
      if (!live.current) return;
      if (left) { setNote({ tone: 'warn', text: left }); setChecked(true); }
    } catch (err) {
      if (live.current) setNote({ tone: 'error', text: `Could not check: ${messageOf(err)}` });
    } finally {
      if (live.current) setChecking(false);
    }
  }

  return (
    <div className="confirm" role="group" aria-label={label}>
      {children}
      {note && <Alert tone={note.tone}>{note.text}</Alert>}
      <div className="confirm-actions">
        <Button variant={resend ? 'secondary' : 'primary'} busy={checking} disabled={resend?.busy || giveUp?.busy} onClick={() => void check()}>Check whether it was recorded</Button>
        {resend && <Button busy={resend.busy} disabled={checking || giveUp?.busy} onClick={resend.onClick}>{resend.label}</Button>}
        {giveUp && (
          <Button variant="secondary" busy={giveUp.busy} disabled={checking || resend?.busy} onClick={giveUp.onClick}>{giveUp.label}</Button>
        )}
        {forget && checked && !resend?.busy && (
          <ConfirmAction label={forget.label} danger confirmLabel={forget.confirmLabel} consequence={forget.consequence}
            onConfirm={async () => forget.onForget()} />
        )}
      </div>
    </div>
  );
}
