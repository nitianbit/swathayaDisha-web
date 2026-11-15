import { useState, type ReactNode } from 'react';
import { requestKeysApi, type OnceOnlyKind } from '@jansetu/api';
import { Alert, Button } from '@jansetu/ui';
import { messageOf } from './common.tsx';
import { afterFailure, beginAttempt, startOp, stillCurrent, type PendingOp } from './pending.ts';
import { useSession } from './session.tsx';

export type PendingCreate<B> = PendingOp<B> & { label: string };

/**
 * A create that must happen once per intent (lab booking, Consult now request), with the doctor booking's rules
 * (pending.ts): the request is stored in session memory with its key BEFORE it is sent; an unanswered attempt locks the
 * form and offers only "send it again" (same key, same details: the server answers a known key with the first record);
 * only a definite refusal of the sole first attempt unlocks it. After a reload only a body-less marker survives (D4).
 */
export function useOnceOnly<B, R>(slotKey: string, perform: (body: B, requestKey: string) => Promise<R>, onRecorded: (result: R) => Promise<void>) {
  const { memory } = useSession();
  const [pending, setPendingState] = useState<PendingCreate<B> | undefined>(() => memory.get<PendingCreate<B>>(slotKey));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setPending = (p: PendingCreate<B> | undefined) => { if (p) memory.set(slotKey, p); else memory.delete(slotKey); setPendingState(p); };

  async function send(p: PendingCreate<B>) {
    const attempt: PendingCreate<B> = { ...beginAttempt(p), label: p.label };
    setBusy(true);
    setError(null);
    setPending(attempt);
    let result: R;
    try {
      result = await perform(attempt.body, attempt.requestKey);
    } catch (err) {
      setBusy(false);
      if (!stillCurrent(memory.get<PendingCreate<B>>(slotKey), attempt)) return; // a newer attempt owns it
      const next = afterFailure(attempt, err, messageOf(err));
      if (next) { setPending({ ...next, label: attempt.label }); return; }
      setPending(undefined);
      setError(messageOf(err)); // the first attempt was refused: nothing was made; the form stays as filled in
      return;
    }
    if (memory.get<PendingCreate<B>>(slotKey)?.requestKey === attempt.requestKey) memory.delete(slotKey);
    setPendingState(undefined);
    // Busy until the follow-up (payment, navigation) is done: the form cannot start a second request meanwhile.
    try { await onRecorded(result); } finally { setBusy(false); }
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
 * Restored after a reload (no details kept on the device): ask the server to settle the key. If it was used, the
 * server names the record; otherwise the key is abandoned for good (it can never be recorded later) and the form is
 * usable again.
 */
export function PendingCreatePanel<B>({ once, kind, what, onFound, children }: {
  once: ReturnType<typeof useOnceOnly<B, unknown>>; kind: OnceOnlyKind; what: string; onFound: (recordId: string) => void; children?: ReactNode;
}) {
  const { api } = useSession();
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const p = once.pending;
  if (!p) return null;
  if (p.restored) {
    async function settle() {
      setChecking(true); setNote(null);
      try {
        const r = await requestKeysApi(api).abandon(kind, p!.requestKey);
        if (r.state === 'abandoned') { once.endIfCurrent(p!.requestKey); return; }
        if (r.record?._id) { once.endIfCurrent(p!.requestKey); onFound(r.record._id); return; }
        setNote(`It was made, but it could not be shown here. Look in My bookings.`);
      } catch (err) {
        setNote(`Could not check it: ${messageOf(err)}`);
      } finally {
        setChecking(false);
      }
    }
    return (
      <section className="card stack" role="group" aria-label={`Unconfirmed ${what}`}>
        <Alert tone="warn">
          A {what} made earlier on this device (before the page was reloaded, or before you signed out) has not been
          confirmed. Find out what happened before starting again: if it was made, you are taken to it; if not, it is
          cancelled for good and you can start again.
        </Alert>
        {note && <Alert>{note}</Alert>}
        <div className="row"><Button busy={checking} onClick={() => void settle()}>Find out what happened</Button></div>
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
