import { ApiError } from '@jansetu/api';

/**
 * A request that must take effect once (booking create). Same rules as the staff workspace's returns: the request is
 * stored with its key BEFORE it is sent; a resend uses the same key and details (the server answers a known key with
 * the first result); only a definite refusal of the sole first attempt ends it without a result.
 */
export interface PendingOp<B> { requestKey: string; body: B; attempts: number; uncertain: boolean; error?: string }

export const newRequestKey = () => crypto.randomUUID().replace(/-/g, '');

export function definitelyNotDone(err: unknown): boolean {
  return err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;
}

export const startOp = <B,>(body: B): PendingOp<B> => ({ requestKey: newRequestKey(), body, attempts: 0, uncertain: false });

/** Stored before each send. A resend makes the operation uncertain (an earlier attempt may still take effect). */
export const beginAttempt = <B,>(p: PendingOp<B>): PendingOp<B> =>
  ({ ...p, attempts: p.attempts + 1, uncertain: p.uncertain || p.attempts > 0, error: undefined });

/** null = forget it (only a sole first attempt definitely refused); otherwise keep it, uncertain. */
export function afterFailure<B>(attempt: PendingOp<B>, err: unknown, message: string): PendingOp<B> | null {
  if (attempt.attempts === 1 && !attempt.uncertain && definitelyNotDone(err)) return null;
  return { ...attempt, uncertain: true, error: message };
}

/** Whether `attempt` still owns the stored state (no newer attempt, no other operation). */
export const stillCurrent = <B,>(stored: PendingOp<B> | undefined, attempt: PendingOp<B>) =>
  !!stored && stored.requestKey === attempt.requestKey && stored.attempts === attempt.attempts;
