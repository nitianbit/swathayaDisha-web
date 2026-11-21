import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, isNoShowMoveUsed, isSlotRefusal, NO_SHOW_MOVE_REFUSAL } from '@jansetu/api';
import { Alert, Button } from '@jansetu/ui';
import { ConfirmAction } from './ConfirmAction.tsx';
import { messageOf } from '../errors.ts';
import { afterFailure, beginAttempt, definitelyNotRecorded, newRequestKey, resolveStored, startOp, stillCurrent, type PendingOp } from '../requests.ts';
import { useSession } from '../session.tsx';
import { FOCUS_HOST_STYLE, usePanelFocus } from './focus.ts';

/** The new time chosen for a no-show (what the page shows about it; never patient details). */
export interface NoShowTarget {
  slotId: string;
  label: string;
  /** Where the booking was when the move was decided (desk: its day, branch and doctor), so a page can tell it has left. */
  from?: { day: string; branchId?: string; doctorId?: string };
  /** The booking version the move was decided on (`updatedAt` or `statusVersion`): every resend names the same one. */
  version?: string | number;
}
/**
 * `refused` (WQ11b): the last attempt was definitely refused by the server (nothing was done by it). With the booking read
 * again afterwards and still a no-show, the person may then start a new move with a new time (and a new key).
 */
export type NoShowMoveOp = PendingOp<NoShowTarget> & { refused?: boolean };

/** Session-memory slot of the one move of one booking's no-show, per workspace identity (a body-less marker survives a reload). */
export const noShowMoveSlot = (identity: string, bookingId: string) => `no-show-move:${identity}:${bookingId}`;

/** The words for a refusal of a move (the server's own message is the fallback). */
export const noShowRefusal = (err: unknown) => (err instanceof ApiError && err.code && NO_SHOW_MOVE_REFUSAL[err.code]) || messageOf(err);

interface Props<R extends { replayed?: boolean }> {
  /** `noShowMoveSlot(...)`. */
  slot: string;
  /** Who missed it and when, for the confirmation ("Asha Rao", "Tue, 17 Nov 2026, 09:30"). */
  who: string;
  missed: string;
  /** 'offer' = it can be moved; 'used' = it was moved once already (the step stays visible, disabled). */
  state: 'offer' | 'used';
  /**
   * The booking as last read: its status, and when that read finished. A stored move is decided only by a read made
   * after its last attempt: no longer a no-show = moved (by this request or another: a booking moves once only); still a
   * no-show after a move was used = it can never be moved again.
   */
  status: string;
  readAt: number;
  reading: boolean;
  /** Another step on this booking is running, or it is being read again. */
  disabled: boolean;
  /** The booking version shown (stored with the move when it is confirmed, so a resend is the same request). */
  version: string | number | undefined;
  /** What happens to money and earnings, for the confirmation. */
  consequence: ReactNode;
  /** The slot picker; it reports the chosen time (or null). */
  picker: (choose: (t: NoShowTarget | null) => void) => ReactNode;
  /** Sends the move (under the page's one-at-a-time guard). */
  send: (target: NoShowTarget, requestKey: string) => Promise<R>;
  /** The move this attempt made, when it still owns it (e.g. to show the booking's new day). Never written into a cache. */
  onMoved?: (answer: R) => void;
  /** Reads the booking again (after every answer, success or not). */
  reread: () => void;
  /** Shown by the page (it outlives this panel, which is keyed by the booking's version). Only for the attempt that owns the move. */
  onNotice: (text: string) => void;
  onFailure: (text: string) => void;
  /** The chosen time was refused (taken, started, the missed one): the picker's slots are read again. */
  onSlotRefused?: () => void;
}

/**
 * Q14: "Reschedule no-show" — the one move of a no-show to a new time (same price, nothing paid or refunded), after a
 * confirmation. The move is an owned once-only record (`requests.ts` PendingOp) stored in session memory BEFORE it is
 * sent, with the server's request key: a lost answer can be sent again unchanged (the server answers the same key with
 * the move it made), and a booking is moved once only whatever the key (409 NO_SHOW_RESCHEDULE_USED), so nothing is ever
 * moved twice. An answer settles the record only while this page is on screen AND it still owns the stored attempt.
 */
export function NoShowMove<R extends { replayed?: boolean }>({
  slot, who, missed, state, status, readAt, reading, disabled, version, consequence, picker, send, onMoved, reread, onNotice, onFailure, onSlotRefused,
}: Props<R>) {
  const { memory } = useSession();
  const [op, setOpState] = useState<NoShowMoveOp | undefined>(() => memory.get<NoShowMoveOp>(slot));
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<NoShowTarget | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const store = (p: NoShowMoveOp | undefined) => {
    if (p) memory.set(slot, p); else memory.delete(slot);
    setOpState(p);
  };
  const owns = (p: NoShowMoveOp) => live.current && stillCurrent(memory.get<NoShowMoveOp>(slot), p);
  const end = (p: NoShowMoveOp) => {
    resolveStored(memory, slot, p.requestKey);
    const k = p.requestKey;
    setOpState((cur) => (cur && cur.requestKey !== k ? cur : undefined));
  };

  // The booking as read after the last attempt settles a stored move (also one restored after a reload).
  const fresh = !!op && !reading && readAt > op.lastAttemptAt;
  const phase = op ? (sending && op.attempts === 1 && !op.uncertain ? 'first' : 'unconfirmed')
    : state === 'used' ? 'used' : !open ? 'closed' : confirming ? 'confirming' : 'picking';
  // WQ11b: focus follows the panel (its first control on every step; the trigger again after Back).
  const host = usePanelFocus<HTMLSpanElement>(phase);
  useEffect(() => {
    if (!op || !fresh || sending) return;
    if (status === 'no_show' && state !== 'used') return; // not decided yet: it may still be on its way
    if (!owns(op)) return;
    end(op);
    if (status !== 'no_show') onNotice(`${who}’s no-show has been moved to a new time (it can be moved only once). Nothing more to do.`);
    else onFailure('This booking was already moved once after a no-show. A second no-show is final, so it cannot be moved again.');
  }, [op, fresh, status, state, sending]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Sends exactly `p` (same key, same time). Only success, or a definite refusal of its first attempt, ends it. */
  async function go(p: NoShowMoveOp) {
    const attempt = beginAttempt(p);
    store(attempt);
    setSending(true);
    try {
      const r = await send(attempt.body!, attempt.requestKey);
      reread();
      if (!owns(attempt)) return;
      end(attempt);
      onMoved?.(r);
      onNotice(r.replayed
        ? `${who}’s no-show had already been moved to ${attempt.body!.label}: nothing was moved twice.`
        : `${who}’s no-show is moved to ${attempt.body!.label}. It is booked again at the same price.`);
    } catch (err) {
      reread();
      if (!owns(attempt)) return;
      // Moved once already (by anyone): this request can never move it.
      if (isNoShowMoveUsed(err)) { end(attempt); onFailure(noShowRefusal(err)); return; }
      const failed = afterFailure(attempt, err, noShowRefusal(err));
      const next: NoShowMoveOp | null = failed && { ...failed, refused: definitelyNotRecorded(err) };
      if (live.current) store(next ?? undefined); else if (next) memory.set(slot, next); else memory.delete(slot);
      if (!next) {
        onFailure(`Not moved: ${noShowRefusal(err)}`);
        if (isSlotRefusal(err)) { onSlotRefused?.(); setChosen(null); setConfirming(false); setOpen(true); }
      }
    } finally {
      if (live.current) setSending(false);
    }
  }

  /**
   * WQ11b: a new time may be chosen once the booking, read after the last attempt, is still a no-show and that attempt
   * was refused for certain (or the move came back from a reload without its details). If an earlier attempt still
   * arrives it moves the booking and the new move is refused (a no-show moves once), so nothing can move twice.
   */
  const canChooseAgain = !!op && !sending && fresh && status === 'no_show' && state !== 'used' && (!!op.restored || !!op.refused);
  return <span ref={host} style={FOCUS_HOST_STYLE}>{body()}</span>;

  function body() {
  if (op && phase === 'unconfirmed') {
    return (
      <div className="confirm" role="group" aria-label="Unconfirmed no-show move">
        <Alert tone="warn">
          {op.restored
            ? `A move of ${who}’s no-show was sent from this device before the page was reloaded, and its answer never arrived. Its details are not kept here. Check the booking: once it is no longer a no-show, the move happened.`
            : `${sending ? 'Sending… ' : ''}The move of ${who}’s no-show to ${op.body!.label} has not been confirmed${op.error ? ` (${op.error})` : ''}. Sending the same move again is safe: a booking is moved only once.`}
        </Alert>
        <div className="confirm-actions">
          {!op.restored && <Button busy={sending} onClick={() => void go(op)}>Send the same move again</Button>}
          <Button variant="secondary" disabled={sending || reading} onClick={reread}>Check the booking</Button>
          {canChooseAgain && (
            <ConfirmAction label="Choose a new time again" confirmLabel="Forget it and choose again"
              consequence={`The booking is still a no-show${op.refused && op.error ? ` and the last send was refused (${op.error})` : ''}. A new time is sent as a new move. If the earlier move still arrives, it moves the booking and the new move is refused (a no-show is moved only once), so nothing can be moved twice.`}
              onConfirm={async () => {
                if (!owns(op)) return;
                end(op);
                setChosen(null); setConfirming(false); setFieldError(null); setOpen(true);
              }} />
          )}
        </div>
      </div>
    );
  }

  if (op) return <Button variant="secondary" busy disabled>Reschedule no-show</Button>; // its first attempt is on its way
  if (state === 'used') {
    return (
      <div className="ws-action">
        <Button variant="secondary" disabled>Reschedule no-show</Button>
        <span className="ws-muted">Already moved once after a no-show: a second no-show is final.</span>
      </div>
    );
  }
  if (!open) return <Button variant="secondary" disabled={disabled} onClick={() => { setOpen(true); setChosen(null); setConfirming(false); }}>Reschedule no-show</Button>;

  return (
    <form className="confirm" noValidate onSubmit={review} aria-label="Reschedule no-show">
      {!confirming ? (
        <>
          {picker((t) => { setChosen(t); setFieldError(null); })}
          {fieldError && <span className="j-field__error" role="alert">{fieldError}</span>}
        </>
      ) : chosen && (
        <div className="confirm-text">
          Move {who}’s missed time ({missed}) to {chosen.label}? It is booked again at the same price: nothing is paid or refunded.
          {' '}{consequence} This can be done only once: if the new time is missed too, that no-show is final.
        </div>
      )}
      <div className="confirm-actions">
        {!confirming ? <Button type="submit">Continue</Button>
          : <Button busy={sending} disabled={disabled && !sending} onClick={() => { const t = { ...chosen!, version }; setOpen(false); void go(startOp(newRequestKey(), t)); }}>Move to {chosen?.label}</Button>}
        {/* Back from the confirmation shows the picker again with nothing chosen (it starts empty), so the choice starts again too. */}
        <Button variant="ghost" data-focus-back disabled={sending} onClick={() => { setChosen(null); setFieldError(null); if (confirming) setConfirming(false); else setOpen(false); }}>Back</Button>
      </div>
    </form>
  );
  }

  function review(e: FormEvent) {
    e.preventDefault();
    if (!chosen) { setFieldError('Choose the new time.'); return; }
    setFieldError(null);
    setConfirming(true);
  }
}
