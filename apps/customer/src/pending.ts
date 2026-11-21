import { ApiError } from '@jansetu/api';

/**
 * A request that must take effect once (booking create). Same rules as the staff workspace's returns: the request is
 * stored with its key BEFORE it is sent; a resend uses the same key and details (the server answers a known key with
 * the first result); only a definite refusal of the sole first attempt ends it without a result.
 */
export interface PendingOp<B> {
  requestKey: string; body: B; attempts: number; uncertain: boolean; error?: string;
  firstAttemptAt: number; lastAttemptAt: number;
  /** D4: brought back after a reload from its body-less marker: can be looked up or abandoned, not resent. */
  restored?: boolean;
}


export const newRequestKey = () => crypto.randomUUID().replace(/-/g, '');

export function definitelyNotDone(err: unknown): boolean {
  return err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;
}

export const startOp = <B,>(body: B, now = Date.now()): PendingOp<B> =>
  ({ requestKey: newRequestKey(), body, attempts: 0, uncertain: false, firstAttemptAt: now, lastAttemptAt: now });

/** Stored before each send. A resend makes the operation uncertain (an earlier attempt may still take effect). */
export const beginAttempt = <B,>(p: PendingOp<B>, now = Date.now()): PendingOp<B> =>
  ({ ...p, attempts: p.attempts + 1, uncertain: p.uncertain || p.attempts > 0, lastAttemptAt: now, error: undefined });

/**
 * WQ11a (as the workspace, WQ7/WQ10c): refusals that settle ANY attempt as not made. 409 `REQUEST_ABANDONED`: the key
 * was given up, and the server writes the key's claim in the same transaction as the record, so nothing was or ever
 * will be made under it. 400/422: the request's own content is refused, so the same body sent earlier was refused too.
 * Other refusals of a resend (a slot taken, a price changed, 401/403) may race an earlier attempt still on its way:
 * they leave the request unconfirmed, and "Give it up" (the server's abandon) settles it.
 */
export function definitelyNeverDone(err: unknown): boolean {
  return err instanceof ApiError && ((err.status === 409 && err.code === 'REQUEST_ABANDONED') || err.status === 400 || err.status === 422);
}

/** null = forget it (a sole first attempt definitely refused, or any attempt refused for good); otherwise keep it, uncertain. */
export function afterFailure<B>(attempt: PendingOp<B>, err: unknown, message: string): PendingOp<B> | null {
  if (attempt.attempts === 1 && !attempt.uncertain && definitelyNotDone(err)) return null;
  if (definitelyNeverDone(err)) return null;
  return { ...attempt, uncertain: true, error: message };
}

/** Whether `attempt` still owns the stored state (no newer attempt, no other operation). */
export const stillCurrent = <B,>(stored: PendingOp<B> | undefined, attempt: PendingOp<B>) =>
  !!stored && stored.requestKey === attempt.requestKey && stored.attempts === attempt.attempts;
