import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Button } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { messageOf } from '../../errors.ts';
import { afterFailure, beginAttempt, resolveStored, stillCurrent, type PendingOp } from '../../requests.ts';
import { useSession, useStaff } from '../../session.tsx';
import { t } from '../../i18n/pharmacy/index.ts';

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

/** A by-key answer (Q13 shape): the request was recorded (with what it recorded), given up for good, or not known yet. */
type KeyedAnswer = { state: 'used' } | { state: 'abandoned' } | { state: 'unknown' };

/**
 * WQ48b: "Check whether it was recorded" and "Give this up" of an owned request the server looks up by its key
 * (`…/by-key/:key`, `…/abandon`): one place that settles the stored request when the answer is `used` (found) or
 * `abandoned` (given up), and otherwise says what is still unknown. Used by the withdrawal and the set-off; "mark paid"
 * has neither route (it reads the withdrawal and offers Forget).
 */
export function useKeyedCheck<A extends KeyedAnswer>(settle: (requestKey: string) => void, read: {
  byKey: (requestKey: string) => Promise<A>; abandon: (requestKey: string) => Promise<A>;
}, on: {
  found: (answer: Extract<A, { state: 'used' }>) => void | Promise<void>;
  givenUp: () => void;
  /** What is still unknown after a check (`restored`: its details are not kept on this device). */
  notYet: (restored: boolean) => string;
  cannotGiveUp: () => void;
  failed: (err: unknown) => void;
}) {
  const [givingUp, setGivingUp] = useState(false);
  const settled = async (requestKey: string, r: A) => {
    if (r.state === 'used') { settle(requestKey); await on.found(r as Extract<A, { state: 'used' }>); return true; }
    if (r.state === 'abandoned') { settle(requestKey); on.givenUp(); return true; }
    return false;
  };
  return {
    givingUp,
    check: async <B,>(op: PendingOp<B>) => ((await settled(op.requestKey, await read.byKey(op.requestKey))) ? null : on.notYet(!!op.restored || !op.body)),
    giveUp: async <B,>(op: PendingOp<B>, perform: <T>(run: () => Promise<T>) => Promise<T>) => {
      setGivingUp(true);
      try {
        if (!(await settled(op.requestKey, await perform(() => read.abandon(op.requestKey))))) on.cannotGiveUp();
      } catch (err) {
        on.failed(err);
      } finally {
        setGivingUp(false);
      }
    },
  };
}

/**
 * An unconfirmed change: what it was, a way to find out whether it was recorded, and (only where repeating it is safe)
 * sending it again. `onCheck` answers null once it settled the change, or a sentence saying what is still unknown.
 */
export function CheckPanel({ label, children, onCheck, checkLabel, resend, giveUp, forget }: {
  label: string;
  /** WQ56d: the check button in the caller's words (default "Check whether it was recorded"). */
  checkLabel?: string;
  children: ReactNode;
  onCheck: () => Promise<string | null>;
  resend?: { label: string; busy: boolean; onClick: () => void };
  /** Q15: give the request up on the server (its key can then never be recorded), or learn that it was recorded. */
  giveUp?: { label: string; busy: boolean; onClick: () => void };
  /** Offered after a check found nothing, behind a second step that says what forgetting risks. */
  forget?: {
    label: string; confirmLabel: string; consequence: ReactNode; onForget: () => void;
    /** WQ13 review M1: a sentence the person must tick before forgetting is possible (e.g. "the money may already be added"). */
    acknowledge?: string;
  };
}) {
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<{ tone: 'warn' | 'error'; text: string } | null>(null);
  const [checked, setChecked] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  /** WQ14b: "forget" (and its tick) hides while a check runs, and after one fails, until a check finds nothing. */
  const unchecked = () => { setChecked(false); setAcknowledged(false); };

  async function check() {
    setChecking(true);
    setNote(null);
    unchecked();
    try {
      const left = await onCheck();
      if (!live.current) return;
      if (left) { setNote({ tone: 'warn', text: left }); setChecked(true); }
    } catch (err) {
      // WQ14 W3(b): a failed check hides "forget" again until a check succeeds.
      if (live.current) { setNote({ tone: 'error', text: t('ownedOp.couldNotCheck', { value: messageOf(err) }) }); unchecked(); }
    } finally {
      if (live.current) setChecking(false);
    }
  }

  return (
    <div className="confirm" role="group" aria-label={label}>
      {children}
      {note && <Alert tone={note.tone}>{note.text}</Alert>}
      <div className="confirm-actions">
        <Button variant={resend ? 'secondary' : 'primary'} busy={checking} disabled={resend?.busy || giveUp?.busy} onClick={() => void check()}>{checkLabel ?? t('ownedOp.checkWhetherItWasRecorded')}</Button>
        {resend && <Button busy={resend.busy} disabled={checking || giveUp?.busy} onClick={resend.onClick}>{resend.label}</Button>}
        {giveUp && (
          <Button variant="secondary" busy={giveUp.busy} disabled={checking || resend?.busy} onClick={giveUp.onClick}>{giveUp.label}</Button>
        )}
        {forget && checked && !resend?.busy && (
          <>
            {forget.acknowledge && (
              <label className="ws-check">
                <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
                {forget.acknowledge}
              </label>
            )}
            <ConfirmAction label={forget.label} danger confirmLabel={forget.confirmLabel} consequence={forget.consequence}
              disabled={!!forget.acknowledge && !acknowledged} onConfirm={async () => forget.onForget()} />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * WQ11c: previews discarded on this device (there is no server route to discard one: Q16c gap). They are hidden here,
 * for this sign-in only; the server keeps them as "checked, not added yet", and nothing is added unless confirmed.
 */
export const discardedSlot = (pharmacyId: string) => `stock-import-discarded:${pharmacyId}`;
export function useDiscarded(pharmacyId: string) {
  const { memory } = useSession();
  const [ids, setIds] = useState<readonly string[]>(() => memory.get<string[]>(discardedSlot(pharmacyId)) ?? []);
  const save = (next: string[]) => { memory.set(discardedSlot(pharmacyId), next); setIds(next); };
  return {
    ids,
    discard: (id: string) => save([...new Set([...(memory.get<string[]>(discardedSlot(pharmacyId)) ?? []), id])]),
    restore: (id: string) => save((memory.get<string[]>(discardedSlot(pharmacyId)) ?? []).filter((x) => x !== id)),
  };
}
