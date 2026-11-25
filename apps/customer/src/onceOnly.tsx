import { useEffect, useRef, useState, type ReactNode } from 'react';
import { requestKeysApi, type OnceOnlyKind } from '@jansetu/api';
import { Alert, Button } from '@jansetu/ui';
import { Confirm, messageOf } from './common.tsx';
import { t } from './i18n/index.ts';
import { afterFailure, beginAttempt, settleByAbandon, startOp, stillCurrent, type PendingOp } from './pending.ts';
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
 * form and offers "send it again" (same key, same details: the server answers a known key with the first record) or
 * "give it up" (the server's abandon, WQ11a); a definite refusal of the sole first attempt unlocks it. A later attempt
 * refused for good is settled by the server's abandon (`settleByAbandon`, N5): `abandoned` unlocks it with the refusal
 * shown, `used` opens the record. After a reload only a body-less marker survives (D4).
 *
 * A success counts only for the newest attempt of the request that still owns the slot, on a page still on screen: an
 * answer for an ended or replaced intent, an older attempt's answer, or one arriving after the page was left changes
 * nothing (it never clears a newer attempt's state). Follow-ups (Checkout, navigation) re-check `alive()` after their
 * own waits.
 */
export function useOnceOnly<B, R>(slotKey: string, perform: (body: B, requestKey: string) => Promise<R>,
  onRecorded: (result: R, alive: () => boolean) => Promise<void>, onRefused: ((err: unknown) => void) | undefined,
  settle: { kind: OnceOnlyKind; onFound: (recordId: string) => void }) {
  const { api, memory } = useSession();
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
      const owns = () => stillCurrent(memory.get<PendingCreate<B>>(slotKey), attempt);
      if (!owns()) { done(); return; } // a newer attempt, or nothing, owns it
      const next = afterFailure(attempt, err, messageOf(err));
      if (next && settleByAbandon(attempt, err)) {
        // N5: refused for good after an unanswered attempt: only the server's abandon says whether it was made.
        setPending({ ...next, label: attempt.label });
        try {
          const r = await requestKeysApi(api).abandon(settle.kind, attempt.requestKey);
          if (!owns() || !alive.current) return;
          if (r.state === 'abandoned') {
            setPending(undefined);
            setError(messageOf(err)); // it can never be made now: the form stays as filled in, with the refusal
            onRefused?.(err);
          } else if (r.record?._id) {
            setPending(undefined);
            settle.onFound(r.record._id); // it was made after all: the server names it
          } else {
            setPending({ ...next, label: attempt.label, error: t('once.madeNotShownShort') });
          }
        } catch { /* not settled: it stays unconfirmed (send again or give it up) */ } finally { done(); }
        return;
      }
      done();
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

/** The panel's sentences for each create it serves (whole sentences: the words around "request" differ by language). */
const WORDS = {
  lab_booking_create: {
    group: 'once.lab.group', restored: 'once.lab.restored', noAnswer: 'once.lab.noAnswer', noAnswerWhy: 'once.lab.noAnswerWhy', giveUp: 'once.lab.giveUp',
  },
  instant_request_create: {
    group: 'once.consult.group', restored: 'once.consult.restored', noAnswer: 'once.consult.noAnswer', noAnswerWhy: 'once.consult.noAnswerWhy',
    giveUp: 'once.consult.giveUp',
  },
} as const;
export type PendingCreateKind = keyof typeof WORDS;

/**
 * Shown instead of the form while a create's outcome is unknown. In this page's memory: send it again unchanged, or
 * (WQ11a) give it up for good. Restored after a reload (no details kept on the device): the server is asked, read-only,
 * what became of the key (Q9 lookup): made → open it; abandoned → start again; unknown (may still be on its way) → check
 * again later, or give it up. Giving up is the server's abandon: afterwards the request can never be made, so the form
 * opens again; if it was made after all, the server names the record and it opens.
 */
export function PendingCreatePanel<B>({ once, kind, onFound, children }: {
  once: ReturnType<typeof useOnceOnly<B, unknown>>; kind: PendingCreateKind; onFound: (recordId: string) => void; children?: ReactNode;
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
  const giveUp = async () => {
    const r = await requestKeysApi(api).abandon(kind, key);
    if (!alive.current) return;
    if (r.state === 'abandoned') { once.endIfCurrent(key); return; }
    if (r.record?._id) { found(r.record._id); return; } // it was made after all: the server names it
    setUnknown(false);
    setNote(t('once.madeAfterAll'));
  };
  const words = WORDS[kind];
  const giveUpConsequence = t(words.giveUp);

  if (p.restored) {
    async function check() {
      setChecking(true); setNote(null);
      try {
        const r = await requestKeysApi(api).lookup(kind, key);
        if (!alive.current) return;
        if (r.state === 'used' && r.record?._id) { found(r.record._id); return; }
        if (r.state === 'used') { setNote(t('once.madeNotShown')); return; }
        if (r.state === 'abandoned') { once.endIfCurrent(key); return; }
        setUnknown(true);
        setNote(t('once.notYet'));
      } catch (err) {
        if (alive.current) setNote(t('once.checkFailed', { message: messageOf(err) }));
      } finally {
        if (alive.current) setChecking(false);
      }
    }
    return (
      <section className="card stack" role="group" aria-label={t(words.group)}>
        <Alert tone="warn">{t(words.restored)}</Alert>
        {note && <Alert tone={unknown ? 'warn' : 'error'}>{note}</Alert>}
        <div className="row"><Button busy={checking} onClick={() => void check()}>{unknown ? t('common.checkAgain') : t('once.checkWhat')}</Button></div>
        {unknown && <Confirm label={t('common.giveUpStartAgain')} confirmLabel={t('common.yesGiveUp')} consequence={giveUpConsequence} onConfirm={giveUp} />}
      </section>
    );
  }
  if (!p.uncertain && once.busy) return null; // a first attempt in flight keeps the form (busy button)
  return (
    <section className="card stack" role="group" aria-label={t(words.group)}>
      <Alert tone="warn">{p.error ? t(words.noAnswerWhy, { label: p.label, error: p.error }) : t(words.noAnswer, { label: p.label })}</Alert>
      {note && <Alert>{note}</Alert>}
      <div className="row">
        <Button busy={once.busy} onClick={() => void once.send(p)}>{t('common.sendAgain')}</Button>
        {children}
      </div>
      <Confirm label={t('common.giveUpStartAgain')} confirmLabel={t('common.yesGiveUp')} disabled={once.busy} consequence={giveUpConsequence} onConfirm={giveUp} />
    </section>
  );
}
