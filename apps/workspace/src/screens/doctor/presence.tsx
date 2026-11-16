import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, doctorToolsApi, HEARTBEAT_MS, instantRefusal, type Presence, type PresenceInput } from '@jansetu/api';
import { messageOf } from '../../errors.ts';
import { useSession } from '../../session.tsx';

/**
 * A doctor's "available now" in this signed-in session. The backend has no route that reads it back (only
 * `PUT /me/presence` answers it), so what is known is what this session last set: `presence` is null until then.
 *
 * While it is on and the page is visible, a heartbeat goes every minute (the server counts a doctor online for two
 * minutes after the last one); when the page is hidden the heartbeats stop, so the doctor drops out of the offers two
 * minutes later. One change at a time; an answer for an older state (a heartbeat sent before a switch) changes nothing.
 */
export interface PresenceValue {
  presence: Presence | null;
  /** The last heartbeat's answer: false = in a consultation now, or switched off elsewhere. */
  online: boolean | null;
  lastBeatAt: number | null;
  /** A heartbeat or switch problem the doctor should know about. */
  problem: string | null;
  busy: boolean;
  /** Sets "available now" (and the modes and fee). Rejects with the server's error. */
  set: (input: PresenceInput) => Promise<Presence>;
}

const PresenceContext = createContext<PresenceValue | null>(null);

const aborted = (err: unknown) => err instanceof DOMException && err.name === 'AbortError';

export function DoctorPresenceProvider({ children }: { children: ReactNode }) {
  const { api } = useSession();
  const doctor = useMemo(() => doctorToolsApi(api), [api]);
  const [presence, setPresence] = useState<Presence | null>(null);
  const [online, setOnline] = useState<boolean | null>(null);
  const [lastBeatAt, setLastBeatAt] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Bumped by every switch: a heartbeat answer for an older state is ignored. */
  const generation = useRef(0);
  const busyRef = useRef(false);
  const lastBeat = useRef<number | null>(null);

  const set = useCallback(async (input: PresenceInput) => {
    if (busyRef.current) throw new Error('A change is already being sent.');
    busyRef.current = true;
    setBusy(true);
    const mine = ++generation.current;
    // Going off stops the heartbeats at once, whatever the answer: without them the server drops the doctor in 2 minutes.
    if (!input.available) setPresence((p) => (p ? { ...p, available: false } : p));
    try {
      const p = await doctor.setPresence(input);
      if (generation.current === mine) {
        setPresence(p);
        setOnline(p.available);
        lastBeat.current = p.available ? Date.now() : null; // the switch itself counts as a heartbeat (`lastSeenAt: now`)
        setLastBeatAt(lastBeat.current);
        setProblem(null);
      }
      return p;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [doctor]);

  const available = presence?.available === true;
  useEffect(() => {
    if (!available) return undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const beat = async () => {
      // Bound to the state it was sent for: a switch (or "Update") made while it travels makes its answer stale.
      const mine = generation.current;
      try {
        const r = await doctor.heartbeat();
        if (generation.current !== mine) return;
        lastBeat.current = Date.now();
        setLastBeatAt(lastBeat.current);
        setOnline(r.online);
        setProblem(null);
      } catch (err) {
        if (generation.current !== mine || aborted(err)) return;
        if (err instanceof ApiError && err.status === 403) {
          // A deactivated or unverified doctor is taken offline by the server: stop here too.
          generation.current += 1;
          setPresence((p) => (p ? { ...p, available: false } : p));
          setOnline(false);
          setProblem(instantRefusal(err) ?? messageOf(err));
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
  }, [available, doctor]);

  const value = useMemo(() => ({ presence, online, lastBeatAt, problem, busy, set }), [presence, online, lastBeatAt, problem, busy, set]);
  return <PresenceContext.Provider value={value}>{children}</PresenceContext.Provider>;
}

export function useDoctorPresence(): PresenceValue {
  const v = useContext(PresenceContext);
  if (!v) throw new Error('useDoctorPresence outside DoctorPresenceProvider');
  return v;
}
