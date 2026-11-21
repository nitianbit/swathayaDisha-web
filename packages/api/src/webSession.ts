/**
 * D4 helpers shared by the web apps: one cross-tab lock for every cookie-changing command (sign-in, refresh, sign-out),
 * identity announcements between tabs, and reload markers for once-only requests whose outcome is not known yet.
 * Markers hold only an opaque request key, a slot name and timestamps - never a request body, names, health data or
 * credentials - in the tab's sessionStorage, under the signed-in person's id. They are kept through account switches
 * and session ends (another person never sees them) until the server resolves the key: found, or abandoned. An
 * explicit sign-out may clear the person's own markers (`clear`, WQ11a: the customer app on a shared phone).
 */

export interface Principal { userId: string; userType: string }
export const samePrincipal = (a: Principal | null | undefined, b: Principal | null | undefined) =>
  !!a && !!b && a.userId === b.userId && a.userType === b.userType;

const chains = new Map<string, Promise<unknown>>();

/** Runs `fn` exclusively across all tabs of this app (Web Locks; falls back to this tab only where unavailable). */
export async function withSessionLock<T>(app: string, fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis.navigator as unknown as { locks?: { request: (n: string, o: object, f: () => Promise<T>) => Promise<T> } } | undefined)?.locks;
  if (locks?.request) return locks.request(`sd-session-${app}`, { mode: 'exclusive' }, fn);
  const prev = chains.get(app) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => { release = r; });
  chains.set(app, prev.then(() => mine));
  await prev;
  try { return await fn(); } finally { release(); }
}

export type SessionAnnouncement = { type: 'signed-in'; userId: string; userType: string } | { type: 'signed-out' };

/** Identity announcements between this app's tabs (null where BroadcastChannel is unavailable). */
export function sessionChannel(app: string): { post: (m: SessionAnnouncement) => void; listen: (cb: (m: SessionAnnouncement) => void) => () => void; close: () => void } | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  const ch = new BroadcastChannel(`sd-session-${app}`);
  return {
    post: (m) => ch.postMessage(m),
    listen: (cb) => { const h = (e: MessageEvent) => cb(e.data as SessionAnnouncement); ch.addEventListener('message', h); return () => ch.removeEventListener('message', h); },
    close: () => ch.close(),
  };
}

/** A once-only request whose outcome is unknown, as remembered across a reload (no body). */
export interface PendingMarker { requestKey: string; attempts: number; firstAttemptAt: number; lastAttemptAt: number }

const PREFIX = 'sd:pend:';
function storage(): Storage | null {
  try { return typeof sessionStorage === 'undefined' ? null : sessionStorage; } catch { return null; }
}

export function markerStore(app: string, userId: string) {
  const base = `${PREFIX}${app}:${userId}:`;
  return {
    save(slot: string, m: PendingMarker) {
      try { storage()?.setItem(base + slot, JSON.stringify({ requestKey: m.requestKey, attempts: m.attempts, firstAttemptAt: m.firstAttemptAt, lastAttemptAt: m.lastAttemptAt })); } catch { /* storage full or blocked: memory still holds it */ }
    },
    remove(slot: string) { try { storage()?.removeItem(base + slot); } catch { /* ignore */ } },
    /** WQ11a: forgets every marker of this person in this app (explicit sign-out). */
    clear() {
      const s = storage();
      if (!s) return;
      try {
        const mine: string[] = [];
        for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k?.startsWith(base)) mine.push(k); }
        for (const k of mine) s.removeItem(k);
      } catch { /* ignore */ }
    },
    all(): Record<string, PendingMarker> {
      const s = storage(); const out: Record<string, PendingMarker> = {};
      if (!s) return out;
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (!k?.startsWith(base)) continue;
        try {
          const v = JSON.parse(s.getItem(k) ?? 'null') as PendingMarker | null;
          if (v && typeof v.requestKey === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v.requestKey)) out[k.slice(base.length)] = v;
        } catch { /* ignore a damaged entry */ }
      }
      return out;
    },
  };
}


/*
 * WQ11a: a web sign-out must hold even when the logout request never reaches the server (weak signal, the tab closed
 * at once): otherwise the cookie session stays valid and the next person to open the app on a shared phone or PC is
 * signed in as the previous one. The intent is recorded synchronously, BEFORE the request is sent, as a plain flag and
 * time (no token, no personal data) in localStorage (sessionStorage when that is blocked). While it is recorded - or
 * cannot be read - no start resumes the session: every start finishes the logout first. It is cleared only when the
 * server answered the logout, or a new sign-in replaced the browser's session.
 */
const webSignOutKey = (app: string) => `sd:signout:${app}`;

function stores(): Storage[] {
  const out: Storage[] = [];
  try { if (typeof localStorage !== 'undefined') out.push(localStorage); } catch { /* blocked */ }
  try { if (typeof sessionStorage !== 'undefined') out.push(sessionStorage); } catch { /* blocked */ }
  return out;
}

/** 'pending': a sign-out has not reached the server yet. 'unknown': the record cannot be read (treated as pending). */
export function webSignOutState(app: string): 'none' | 'pending' | 'unknown' {
  let readable = false;
  for (const s of stores()) {
    try {
      if (s.getItem(webSignOutKey(app)) !== null) return 'pending';
      readable = true;
    } catch { /* this one cannot be read */ }
  }
  return readable ? 'none' : 'unknown';
}

/** Records the sign-out intent (synchronously). False when it could not be recorded and read back anywhere. */
export function markWebSignOutPending(app: string, now = Date.now()): boolean {
  const value = JSON.stringify({ pending: true, at: now });
  for (const s of stores()) {
    try {
      s.setItem(webSignOutKey(app), value);
      if (s.getItem(webSignOutKey(app)) === value) return true;
    } catch { /* full or blocked: try the next one */ }
  }
  return false;
}

/** The server answered the logout, or a new sign-in replaced the session: no sign-out is pending any more. */
export function clearWebSignOutPending(app: string): void {
  for (const s of stores()) {
    try { s.removeItem(webSignOutKey(app)); } catch { /* an unreadable record keeps blocking resumption: safe */ }
  }
}

/**
 * WQ11a: whether a session command (refresh, logout) failed without a definite answer: no connection, a timeout, 408,
 * 429 or a server error. Then the session is neither known to be over (a refresh is retried, the screen keeps the
 * session) nor known to be ended (a logout is retried). Any other answer from the server is definite.
 */
export function isTransientSessionError(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status !== 'number') return !(err instanceof DOMException && err.name === 'AbortError');
  return status === 0 || status === 408 || status === 429 || status >= 500;
}
