import { useEffect, useRef, useState, type ReactNode } from 'react';
import { requestKeysApi, type OnceOnlyKind } from '@jansetu/api';
import { Alert, Button } from '@jansetu/ui';
import { Confirm, messageOf } from './common.tsx';
import { afterFailure, beginAttempt, startOp, stillCurrent, type PendingOp } from './pending.ts';
import { useSession } from './session.tsx';

export type PendingCreate<B> = PendingOp<B> & { label: string };

/** Whether this page is still on screen (a late answer must not open Checkout or navigate from a page the customer left). */
export function useAlive() {
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  return alive;
}

/**
 * A create that must happen once per intent (lab booking, Consult now request), with the doctor booking's rules
 * (pending.ts): the request is stored in session memory with its key BEFORE it is sent; an unanswered attempt locks the
 * form and offers only "send it again" (same key, same details: the server answers a known key with the first record);
 * only a definite refusal of the sole first attempt unlocks it. After a reload only a body-less marker survives (D4).
 *
 * A success counts only for the newest attempt of the request that still owns the slot, on a page still on screen: an
 * answer for an ended or replaced intent, an older attempt's answer, or one arriving after the page was left changes
 * nothing (it never clears a newer attempt's state). Follow-ups (Checkout, navigation) re-check `alive()` after their
 * own waits.
 */
export function useOnceOnly<B, R>(slotKey: string, perform: (body: B, requestKey: string) => Promise<R>,
  onRecorded: (result: R, alive: () => boolean) => Promise<void>, onRefused?: (err: unknown) => void) {
  const { memory } = useSession();
  const alive = useAlive();
  const [pending, setPendingState] = useState<PendingCreate<B> | undefined>(() => memory.get<PendingCreate<B>>(slotKey));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const setPending = (p: PendingCreate<B> | undefined) => { if (p) memory.set(slotKey, p); else memory.delete(slotKey); setPendingState(p); };

  async function send(p: PendingCreate<B>) {
    const attempt: PendingCreate<B> = { ...beginAttempt(p), label: p.label };
    const mine = ++seq.current;
    const done = () => { if (seq.current === mine && alive.current) setBusy(false); };
    setBusy(true);
    setError(null);
    setPending(attempt);
    let result: R;
    try {
      result = await perform(attempt.body, attempt.requestKey);
    } catch (err) {
      done();
      if (!stillCurrent(memory.get<PendingCreate<B>>(slotKey), attempt)) return; // a newer attempt, or nothing, owns it
      const next = afterFailure(attempt, err, messageOf(err));
      if (next) { setPending({ ...next, label: attempt.label }); return; }
      setPending(undefined);
      setError(messageOf(err)); // the first attempt was refused: nothing was made; the form stays as filled in
      onRefused?.(err);
      return;
    }
    // Only the newest attempt, on a page still on screen, may finish the operation. An older attempt (or one from a
    // page that was left and came back) leaves the stored state alone: the newer attempt for the same key gets the same
    // record from the server and finishes it; if no page is waiting, the request stays locked until it is sent again
    // (the server answers with the first record) or looked up after a reload.
    if (!alive.current || !stillCurrent(memory.get<PendingCreate<B>>(slotKey), attempt)) { done(); return; }
    memory.delete(slotKey);
    setPendingState(undefined);
    // Busy until the follow-up (payment, navigation) is done: the form cannot start a second request meanwhile.
    try { await onRecorded(result, () => alive.current); } finally { done(); }
  }

  /** Ends the stored request `requestKey` only if it is still the stored one (a newer one may exist). */
  const endIfCurrent = (requestKey: string) => {
    if (memory.get<PendingCreate<B>>(slotKey)?.requestKey !== requestKey) return false;
    memory.delete(slotKey);
    setPendingState((cur) => (cur && cur.requestKey !== requestKey ? cur : undefined));
    return true;
  };

  return { pending, busy, error, send, endIfCurrent, start: (body: B, label: string): PendingCreate<B> => ({ ...startOp(body), label }) };
}

/**
 * Shown instead of the form while a create's outcome is unknown. In this page's memory: send it again unchanged.
 * Restored after a reload (no details kept on the device): the server is asked, read-only, what became of the key
 * (Q9 lookup): made → open it; abandoned → start again; unknown (may still be on its way) → check again later, or, only
 * if the customer chooses, give it up for good (abandon: then it can never be made) and start again.
 */
export function PendingCreatePanel<B>({ once, kind, what, onFound, children }: {
  once: ReturnType<typeof useOnceOnly<B, unknown>>; kind: OnceOnlyKind; what: string; onFound: (recordId: string) => void; children?: ReactNode;
}) {
  const { api } = useSession();
  const alive = useAlive();
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [unknown, setUnknown] = useState(false);
  const p = once.pending;
  if (!p) return null;
  const key = p.requestKey;
  // Opens the record only if this request still owns the slot and the page is still on screen.
  const found = (id: string) => { if (once.endIfCurrent(key) && alive.current) onFound(id); };

  if (p.restored) {
    async function check() {
      setChecking(true); setNote(null);
      try {
        const r = await requestKeysApi(api).lookup(kind, key);
        if (!alive.current) return;
        if (r.state === 'used' && r.record?._id) { found(r.record._id); return; }
        if (r.state === 'used') { setNote('It was made, but it could not be shown here. Look in My bookings.'); return; }
        if (r.state === 'abandoned') { once.endIfCurrent(key); return; }
        setUnknown(true);
        setNote('It has not been made yet, but it may still be on its way. Check again in a moment, or give it up and start again.');
      } catch (err) {
        if (alive.current) setNote(`Could not check it: ${messageOf(err)}`);
      } finally {
        if (alive.current) setChecking(false);
      }
    }
    return (
      <section className="card stack" role="group" aria-label={`Unconfirmed ${what}`}>
        <Alert tone="warn">
          A {what} made earlier on this device (before the page was reloaded, or before you signed out) has not been
          confirmed. Check what happened to it before starting again.
        </Alert>
        {note && <Alert tone={unknown ? 'warn' : 'error'}>{note}</Alert>}
        <div className="row"><Button busy={checking} onClick={() => void check()}>{unknown ? 'Check again' : 'Check what happened'}</Button></div>
        {unknown && (
          <Confirm label="Give it up and start again" confirmLabel="Yes, give it up"
            consequence={`The earlier ${what} is cancelled for good: it can never be made later, even if it is still on its way. Then you can start again.`}
            onConfirm={async () => {
              const r = await requestKeysApi(api).abandon(kind, key);
              if (r.state === 'abandoned') { once.endIfCurrent(key); return; }
              if (r.record?._id) { found(r.record._id); return; } // it was made after all: the server names it
              setUnknown(false);
              setNote('It was made after all, but it could not be shown here. Look in My bookings.');
            }} />
        )}
      </section>
    );
  }
  if (!p.uncertain && once.busy) return null; // a first attempt in flight keeps the form (busy button)
  return (
    <section className="card stack" role="group" aria-label={`Unconfirmed ${what}`}>
      <Alert tone="warn">
        Your {what} for {p.label} did not get an answer{p.error ? ` (${p.error})` : ''}. It may already have been made. Send it
        again to find out: it will not be made twice.
      </Alert>
      <div className="row">
        <Button busy={once.busy} onClick={() => void once.send(p)}>Send it again</Button>
        {children}
      </div>
    </section>
  );
}
