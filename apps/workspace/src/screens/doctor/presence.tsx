import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, doctorToolsApi, HEARTBEAT_MS, instantRefusal, type Presence, type PresenceInput } from '@jansetu/api';
import { useLanguage } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { definitelyNotRecorded, newRequestKey } from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { t } from '../../i18n/doctor/index.ts';

/**
 * A doctor's "available now", as the server last acknowledged it (Q13: `GET /me/presence` on start and on demand, the
 * heartbeat's answer, or the answer to an ordered `PUT /me/presence`).
 *
 * Terms are ACKNOWLEDGED only by a definite answer or a fresh read; only acknowledged terms are shown, kept alive by the
 * heartbeat, or used to accept. Every change names the version it was decided on (`expectedPresenceVersion`), so the
 * server refuses it (409 PRESENCE_CHANGED) if anything changed meanwhile — including an earlier request of this page
 * whose answer was lost and that runs late: it can never overwrite newer acknowledged terms.
 *
 * A change whose answer is lost makes the terms unknown (`presence` null, `unconfirmed` keeps what was sent; a body-less
 * marker survives a reload): no heartbeat, no accept. A fresh read only SHOWS what the server has (`shown`, with its
 * version) — the lost write may still commit on the version it named, so a read cannot retire it. The doctor confirms
 * (or changes) the shown terms with an ordered write against that version: acknowledged, the version has moved past the
 * lost write for good; refused 409, the lost write (or another device) got there first — read, show, confirm again.
 *
 * While on, live and visible, a heartbeat goes every minute (the server counts a doctor online for two minutes after the
 * last one); hidden pages send none. A presence found switched on but no longer checked in (`heartbeatExpired`) is not
 * revived on its own: the doctor switches it on again.
 */
export interface PresenceValue {
  /** The last acknowledged presence (null: not read yet, the read failed, or a change is unconfirmed). */
  presence: Presence | null;
  /** The first read is on its way; or it failed (with why). */
  loading: boolean;
  loadError: string | null;
  /**
   * A change sent whose outcome is unknown: its terms (absent after a reload), and why. A read does not retire it (the
   * write may still commit on the version it named): only an acknowledged ordered write does.
   */
  unconfirmed: { input?: PresenceInput; message: string } | null;
  /** While uncertain: the presence last read, shown with its version; confirming it is an ordered write against that version. */
  shown: Presence | null;
  /** This page keeps the acknowledged "on" alive with heartbeats. */
  live: boolean;
  /** Acknowledged, on, live, and no change on its way: the only state in which offers may be accepted. */
  confirmedOn: boolean;
  /** The last heartbeat's answer: false = busy in a consultation, or switched off elsewhere. */
  online: boolean | null;
  lastBeatAt: number | null;
  /** A heartbeat or switch problem the doctor should know about. */
  problem: string | null;
  busy: boolean;
  /** Sends new terms against the acknowledged version. Rejects with the server's error (409 PRESENCE_CHANGED is read again first). */
  set: (input: PresenceInput) => Promise<Presence>;
  /** Reads the presence again (acknowledges it, or while uncertain only shows it). */
  refresh: () => Promise<Presence>;
}

const PresenceContext = createContext<PresenceValue | null>(null);

const aborted = (err: unknown) => err instanceof DOMException && err.name === 'AbortError';
/** A read presence still counts as checked in (so this page may keep it alive). */
const checkedIn = (p: Presence) => p.available && p.heartbeatExpired !== true;

/** Session memory slot (with a body-less reload marker) of a presence write whose outcome is not known. */
const PENDING_SLOT = 'doctor-presence:pending';

export function DoctorPresenceProvider({ children }: { children: ReactNode }) {
  const { api, memory } = useSession();
  const doctor = useMemo(() => doctorToolsApi(api), [api]);
  const [presence, setPresence] = useState<Presence | null>(null);
  const [shown, setShown] = useState<Presence | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [unconfirmed, setUnconfirmedState] = useState<PresenceValue['unconfirmed']>(null);
  const [live, setLive] = useState(false);
  const [online, setOnline] = useState<boolean | null>(null);
  const [lastBeatAt, setLastBeatAt] = useState<number | null>(null);
  // Words made when shown (the provider outlives a language switch): a function, not the sentence.
  const [problemWords, setProblem] = useState<(() => string) | null>(null);
  const [busy, setBusy] = useState(false);
  /** Bumped by every change and read: an answer for an older state is ignored. */
  const generation = useRef(0);
  const busyRef = useRef(false);
  const beatInFlight = useRef(false);
  const lastBeat = useRef<number | null>(null);
  /** The acknowledged presence, and (while uncertain) the presence last read: the base of the next ordered write. */
  const acknowledged = useRef<Presence | null>(null);
  const lastRead = useRef<Presence | null>(null);
  const uncertain = useRef(false);

  const setUnconfirmed = useCallback((u: PresenceValue['unconfirmed']) => { uncertain.current = u !== null; setUnconfirmedState(u); }, []);
  /** Recorded BEFORE a write is sent, and kept across a reload (marker only): a write that may still commit. */
  const markPending = useCallback(() => {
    const now = Date.now();
    memory.set(PENDING_SLOT, { requestKey: newRequestKey(), attempts: 1, uncertain: true, firstAttemptAt: now, lastAttemptAt: now });
  }, [memory]);

  /** Adopts a definite answer of an ordered write, or (only when no write of this page can still commit) a fresh read. */
  const adopt = useCallback((p: Presence, keepAlive: boolean) => {
    acknowledged.current = p;
    lastRead.current = null;
    memory.delete(PENDING_SLOT);
    setPresence(p);
    setShown(null);
    setUnconfirmed(null);
    setLive(keepAlive);
    setOnline(p.online ?? (keepAlive ? true : null));
    lastBeat.current = keepAlive ? Date.now() : null;
    setLastBeatAt(lastBeat.current);
  }, [memory, setUnconfirmed]);

  /** The terms become unknown: nothing is shown as acknowledged, nothing is kept alive. */
  const becomeUncertain = useCallback((u: NonNullable<PresenceValue['unconfirmed']>) => {
    acknowledged.current = null;
    setPresence(null);
    setUnconfirmed(u);
    setLive(false);
    setOnline(null);
    lastBeat.current = null;
    setLastBeatAt(null);
  }, [setUnconfirmed]);

  /** One operation at a time (a read or a change); the busy flag also holds the heartbeat back. */
  const exclusive = useCallback(async <T,>(run: (mine: number) => Promise<T>): Promise<T> => {
    if (busyRef.current) throw new Error(t('presence.aChangeIsAlreadyBeing'));
    busyRef.current = true;
    setBusy(true);
    const mine = ++generation.current;
    try {
      return await run(mine);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  /**
   * A fresh read. With no write of this page unresolved it acknowledges what the server has. While one may still commit
   * (its expected version is not retired by a read) it only SHOWS the terms: they become the base of the ordered write
   * that confirms them, and nothing is accepted or kept alive until that write is acknowledged.
   */
  const read = useCallback(async (mine: number) => {
    const p = await doctor.presence();
    if (generation.current === mine) {
      if (uncertain.current) { lastRead.current = p; setShown(p); } else {
        adopt(p, checkedIn(p));
        // WQ11c: a read is not a check-in. After a reload the last heartbeat may be close to two minutes old, so the
        // heartbeats start with one at once (below) instead of a minute later.
        lastBeat.current = null;
        setLastBeatAt(null);
      }
      setProblem(null);
      setLoadError(null);
    }
    return p;
  }, [doctor, adopt]);

  const refresh = useCallback(() => exclusive(read), [exclusive, read]);

  // The presence as the server has it, once per signed-in shell (a ref, so StrictMode's second effect run reads nothing).
  // A write left unresolved before a reload (its marker) starts the page uncertain.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (memory.get(PENDING_SLOT)) {
      // A getter: the words are read when shown, so a language switch (this provider stays mounted) shows the new ones.
      setUnconfirmed({ get message() { return t('presence.aChangeSentBeforeThis'); } });
    }
    void refresh()
      .catch((err: unknown) => { if (!aborted(err)) setLoadError(messageOf(err)); })
      .finally(() => setLoading(false));
  }, [refresh, memory, setUnconfirmed]);

  const set = useCallback((input: PresenceInput) => exclusive(async (mine) => {
    const base = uncertain.current ? lastRead.current : acknowledged.current;
    if (!base) throw new Error(t('presence.checkWhatTheServerHas'));
    const wasUncertain = uncertain.current;
    // Going off stops the heartbeats at once, whatever the answer: without them the server drops the doctor in 2 minutes.
    if (!input.available) setLive(false);
    markPending();
    try {
      const p = await doctor.setPresence({ ...input, expectedPresenceVersion: base.presenceVersion });
      // Acknowledged: the version moved past every earlier write of this page, so none of them can commit any more.
      if (generation.current === mine) { adopt(p, p.available); setProblem(null); }
      return p;
    } catch (err) {
      if (generation.current !== mine) throw err;
      if (err instanceof ApiError && err.code === 'PRESENCE_CHANGED') {
        // Changed meanwhile (another device, or an earlier request of this page that committed first): read it again. While
        // uncertain that read is only shown, and confirming it is the next step.
        if (!wasUncertain) memory.delete(PENDING_SLOT);
        try { await read(mine); } catch { if (!wasUncertain) { acknowledged.current = null; setPresence(null); setLive(false); } }
      } else if (definitelyNotRecorded(err)) {
        // This write changed nothing; an earlier unresolved one (if any) stays unresolved.
        if (!wasUncertain) memory.delete(PENDING_SLOT);
      } else {
        // It may have been applied: the terms are unknown until read again and confirmed by an ordered write.
        lastRead.current = null;
        setShown(null);
        becomeUncertain({ input, message: messageOf(err) });
      }
      throw err;
    }
  }), [exclusive, doctor, adopt, read, markPending, memory, becomeUncertain]);

  const beating = live && presence?.available === true;
  useEffect(() => {
    if (!beating) return undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    /** Answers false when it did not send (a change, a read or another heartbeat is on its way). */
    const beat = async (): Promise<boolean> => {
      // One heartbeat at a time, and never while a change or read is on its way.
      if (busyRef.current || beatInFlight.current) return false;
      beatInFlight.current = true;
      const mine = generation.current;
      try {
        const p = await doctor.heartbeat();
        if (generation.current !== mine || uncertain.current) return true;
        // An answer older than the terms already adopted (it was overtaken) changes nothing.
        if (acknowledged.current && p.presenceVersion < acknowledged.current.presenceVersion) return true;
        // The heartbeat answers the presence as it is: a fresh read (terms changed elsewhere are adopted as such).
        acknowledged.current = p;
        setPresence(p);
        lastBeat.current = Date.now();
        setLastBeatAt(lastBeat.current);
        setOnline(p.online ?? null);
        if (!p.available) setLive(false);
        setProblem(null);
      } catch (err) {
        if (generation.current !== mine || aborted(err)) return true;
        if (err instanceof ApiError && err.status === 403) {
          // A deactivated or unverified doctor is taken offline by the server (a new version): read it again.
          generation.current += 1;
          setLive(false);
          setOnline(false);
          setProblem(() => () => instantRefusal(err) ?? messageOf(err));
          void refresh().catch(() => undefined);
          return true;
        }
        setProblem(() => () => t('presence.theLastHeartbeatDidNot', { value: messageOf(err) }));
      } finally {
        beatInFlight.current = false;
      }
      return true;
    };
    /** A heartbeat now when none was sent for a minute (or since the page loaded); held back by a change, tried again shortly. */
    const due = (tries = 5) => {
      if (lastBeat.current !== null && Date.now() - lastBeat.current < HEARTBEAT_MS) return;
      void beat().then((sent) => { if (!sent && tries > 1) retry = setTimeout(() => due(tries - 1), 1_000); });
    };
    const stop = () => {
      if (timer !== undefined) clearInterval(timer);
      if (retry !== undefined) clearTimeout(retry);
      timer = undefined; retry = undefined;
    };
    const start = () => { stop(); timer = setInterval(() => void beat(), HEARTBEAT_MS); };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        start();
        due();
      } else {
        stop();
      }
    };
    if (document.visibilityState === 'visible') { start(); due(); }
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [beating, doctor, refresh]);

  const confirmedOn = beating && unconfirmed === null && !busy;
  useLanguage(); // the problem's words are made again in a new language
  const problem = problemWords ? problemWords() : null;
  const value = useMemo(() => ({ presence, shown, loading, loadError, unconfirmed, live, confirmedOn, online, lastBeatAt, problem, busy, set, refresh }),
    [presence, shown, loading, loadError, unconfirmed, live, confirmedOn, online, lastBeatAt, problem, busy, set, refresh]);
  return <PresenceContext.Provider value={value}>{children}</PresenceContext.Provider>;
}

export function useDoctorPresence(): PresenceValue {
  const v = useContext(PresenceContext);
  if (!v) throw new Error('useDoctorPresence outside DoctorPresenceProvider');
  return v;
}
