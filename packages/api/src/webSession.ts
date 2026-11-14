/**
 * D4 helpers shared by the web apps: one cross-tab lock for every cookie-changing command (sign-in, refresh, sign-out),
 * identity announcements between tabs, and reload markers for once-only requests whose outcome is not known yet.
 * Markers hold only an opaque request key, a slot name and timestamps - never a request body, names, health data or
 * credentials - in the tab's sessionStorage, under the signed-in person's id. They are kept through sign-out and
 * account switches (another person never sees them) until the server resolves the key: found, or abandoned.
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

