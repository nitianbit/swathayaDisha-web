import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, doctorToolsApi, HEARTBEAT_MS, instantRefusal, type Presence, type PresenceInput } from '@jansetu/api';
import { messageOf } from '../../errors.ts';
import { definitelyNotRecorded } from '../../requests.ts';
import { useSession } from '../../session.tsx';

/**
 * A doctor's "available now", as the server last acknowledged it (Q13: `GET /me/presence` on start and on demand, the
 * heartbeat's answer, or the answer to an ordered `PUT /me/presence`).
 *
 * Terms are ACKNOWLEDGED only by a definite answer or a fresh read; only acknowledged terms are shown, kept alive by the
 * heartbeat, or used to accept. Every change names the version it was decided on (`expectedPresenceVersion`), so the
 * server refuses it (409 PRESENCE_CHANGED) if anything changed meanwhile — including an earlier request of this page
 * whose answer was lost and that runs late: it can never overwrite newer acknowledged terms.
 *
 * A change whose answer is lost makes the terms unknown (`presence` null, `unconfirmed` keeps what was sent): no
 * heartbeat, no accept. The way on is a fresh read (`refresh`), which shows what the server has and its version; only
 * then can the doctor send a change again (against that version).
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
  /** A change sent whose outcome is unknown: its terms, and why. Cleared only by a fresh read. */
  unconfirmed: { input: PresenceInput; message: string } | null;
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
  /** Reads the presence again (acknowledges what the server has). */
  refresh: () => Promise<Presence>;
}

const PresenceContext = createContext<PresenceValue | null>(null);

const aborted = (err: unknown) => err instanceof DOMException && err.name === 'AbortError';
/** A read presence still counts as checked in (so this page may keep it alive). */
const checkedIn = (p: Presence) => p.available && p.heartbeatExpired !== true;

export function DoctorPresenceProvider({ children }: { children: ReactNode }) {
  const { api } = useSession();
  const doctor = useMemo(() => doctorToolsApi(api), [api]);
  const [presence, setPresence] = useState<Presence | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [unconfirmed, setUnconfirmed] = useState<PresenceValue['unconfirmed']>(null);
  const [live, setLive] = useState(false);
  const [online, setOnline] = useState<boolean | null>(null);
  const [lastBeatAt, setLastBeatAt] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Bumped by every change and read: an answer for an older state is ignored. */
  const generation = useRef(0);
  const busyRef = useRef(false);
  const lastBeat = useRef<number | null>(null);
  const acknowledged = useRef<Presence | null>(null);

  /** Adopts a definite answer or a fresh read. */
  const adopt = useCallback((p: Presence, keepAlive: boolean) => {
    acknowledged.current = p;
    setPresence(p);
    setUnconfirmed(null);
    setLive(keepAlive);
    setOnline(p.online ?? (keepAlive ? true : null));
    lastBeat.current = keepAlive ? Date.now() : null;
    setLastBeatAt(lastBeat.current);
  }, []);

  /** One operation at a time (a read or a change); the busy flag also holds the heartbeat back. */
  const exclusive = useCallback(async <T,>(run: (mine: number) => Promise<T>): Promise<T> => {
    if (busyRef.current) throw new Error('A change is already being sent.');
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

  const read = useCallback(async (mine: number) => {
    const p = await doctor.presence();
    if (generation.current === mine) { adopt(p, checkedIn(p)); setProblem(null); setLoadError(null); }
    return p;
  }, [doctor, adopt]);

  const refresh = useCallback(() => exclusive(read), [exclusive, read]);

  // The presence as the server has it, once per signed-in shell (a ref, so StrictMode's second effect run reads nothing).
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void refresh()
      .catch((err: unknown) => { if (!aborted(err)) setLoadError(messageOf(err)); })
      .finally(() => setLoading(false));
  }, [refresh]);

  const set = useCallback((input: PresenceInput) => exclusive(async (mine) => {
    const base = acknowledged.current;
    if (!base) throw new Error('Read your current availability first.');
    // Going off stops the heartbeats at once, whatever the answer: without them the server drops the doctor in 2 minutes.
    if (!input.available) setLive(false);
    try {
      const p = await doctor.setPresence({ ...input, expectedPresenceVersion: base.presenceVersion });
      if (generation.current === mine) { adopt(p, p.available); setProblem(null); }
      return p;
    } catch (err) {
      if (generation.current !== mine) throw err;
      if (err instanceof ApiError && err.code === 'PRESENCE_CHANGED') {
        // Changed meanwhile (another device, or an earlier request of this page that ran late): show what is there now.
        try { await read(mine); } catch { acknowledged.current = null; setPresence(null); setLive(false); }
      } else if (!definitelyNotRecorded(err)) {
        // It may have been applied: the terms are unknown until read again, and nothing keeps them alive.
        acknowledged.current = null;
        setPresence(null);
        setUnconfirmed({ input, message: messageOf(err) });
        setLive(false);
        setOnline(null);
        lastBeat.current = null;
        setLastBeatAt(null);
      }
      throw err;
    }
  }), [exclusive, doctor, adopt, read]);

  const beating = live && presence?.available === true;
  useEffect(() => {
    if (!beating) return undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const beat = async () => {
      if (busyRef.current) return; // never while a change or read is on its way
      const mine = generation.current;
      try {
        const p = await doctor.heartbeat();
        if (generation.current !== mine) return;
        // The heartbeat answers the presence as it is: a fresh read (terms changed elsewhere are adopted as such).
        acknowledged.current = p;
        setPresence(p);
        lastBeat.current = Date.now();
        setLastBeatAt(lastBeat.current);
        setOnline(p.online ?? null);
        if (!p.available) setLive(false);
        setProblem(null);
      } catch (err) {
        if (generation.current !== mine || aborted(err)) return;
        if (err instanceof ApiError && err.status === 403) {
          // A deactivated or unverified doctor is taken offline by the server (a new version): read it again.
          generation.current += 1;
          setLive(false);
          setOnline(false);
          setProblem(instantRefusal(err) ?? messageOf(err));
          void refresh().catch(() => undefined);
          return;
        }
        setProblem(`The last heartbeat did not reach the server (${messageOf(err)}). If this goes on for two minutes you stop being offered consultations.`);
      }
    };
    const stop = () => { if (timer !== undefined) clearInterval(timer); timer = undefined; };
    const start = () => { stop(); timer = setInterval(() => void beat(), HEARTBEAT_MS); };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        if (lastBeat.current === null || Date.now() - lastBeat.current >= HEARTBEAT_MS) void beat();
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [beating, doctor, refresh]);

  const confirmedOn = beating && unconfirmed === null && !busy;
  const value = useMemo(() => ({ presence, loading, loadError, unconfirmed, live, confirmedOn, online, lastBeatAt, problem, busy, set, refresh }),
    [presence, loading, loadError, unconfirmed, live, confirmedOn, online, lastBeatAt, problem, busy, set, refresh]);
  return <PresenceContext.Provider value={value}>{children}</PresenceContext.Provider>;
}

export function useDoctorPresence(): PresenceValue {
  const v = useContext(PresenceContext);
  if (!v) throw new Error('useDoctorPresence outside DoctorPresenceProvider');
  return v;
}
