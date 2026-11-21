import { ApiError, type Page } from '@jansetu/api';

/**
 * Operations that must happen once (a return moves stock and money). Each submission gets a request key; the server
 * answers a repeated key with the first record, so resending the same request is always safe. The client therefore
 * never needs to decide "it was not recorded" except in one provable case: the FIRST and ONLY attempt was refused.
 */
export const newRequestKey = () => crypto.randomUUID().replace(/-/g, '');

/** The server refused this request itself (validation, state, limits, access): this request recorded nothing. */
export function definitelyNotRecorded(err: unknown): boolean {
  return err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;
}

/**
 * A submission whose outcome is not yet known. `attempts` counts sends (stored BEFORE each send, so a remount sees
 * an attempt that may still be running); `uncertain` is true once any attempt ended without a definite answer or a
 * second attempt started. Only success, or a definite refusal of attempt 1 while no other attempt exists, ends it.
 */
export interface PendingOp<B> {
  requestKey: string;
  body: B;
  attempts: number;
  uncertain: boolean;
  firstAttemptAt: number;
  lastAttemptAt: number;
  error?: string;
  /**
   * D4: brought back after a page reload from its body-less marker. Its details are not kept on this device, so it
   * cannot be resent; it can be looked up by key, or abandoned on the server (then it can never be recorded).
   */
  restored?: boolean;
}

export function startOp<B>(requestKey: string, body: B, now = Date.now()): PendingOp<B> {
  return { requestKey, body, attempts: 0, uncertain: false, firstAttemptAt: now, lastAttemptAt: now };
}

/** The state to store before sending: a resend makes the operation uncertain (an earlier attempt may still commit). */
export function beginAttempt<B>(p: PendingOp<B>, now = Date.now()): PendingOp<B> {
  return { ...p, attempts: p.attempts + 1, uncertain: p.uncertain || p.attempts > 0, lastAttemptAt: now, error: undefined };
}

/** What to store after `attempt` failed: null = forget it (only a sole first attempt definitely refused). */
export function afterFailure<B>(attempt: PendingOp<B>, err: unknown, message: string): PendingOp<B> | null {
  if (attempt.attempts === 1 && !attempt.uncertain && definitelyNotRecorded(err)) return null;
  return { ...attempt, uncertain: true, error: message };
}

/** Whether `attempt` still owns the stored state (no newer attempt of the same operation has started). */
export function stillCurrent<B>(stored: PendingOp<B> | undefined, attempt: PendingOp<B>): boolean {
  return !!stored && stored.requestKey === attempt.requestKey && stored.attempts === attempt.attempts;
}

/**
 * Looks for the record carrying the operation's key in a newest-first list, so its receipt can be shown. Not finding
 * it proves nothing (the request may still be running), so the only answer besides the record is "not found".
 * Stops after records clearly older than the submission or after `maxPages`, to bound the work.
 */
export async function findByKey<T extends { requestKey?: string; createdAt?: string }>(
  fetchPage: (page: number) => Promise<Page<T>>, op: PendingOp<unknown>, maxPages = 20,
): Promise<T | null> {
  const before = op.firstAttemptAt - 60 * 60_000;
  for (let page = 1; page <= maxPages; page++) {
    const p = await fetchPage(page);
    const hit = p.items.find((r) => r.requestKey === op.requestKey);
    if (hit) return hit;
    const oldest = p.items[p.items.length - 1];
    if (page >= p.totalPages || p.items.length === 0 || (oldest?.createdAt && Date.parse(oldest.createdAt) < before)) break;
  }
  return null;
}

/**
 * Ends the stored operation `requestKey` after it was recorded (answer or found record) — and only that one. A late
 * answer of an older operation must not clear a different operation started since (e.g. after a remount).
 */
export function resolveStored(memory: { get<T>(key: string): T | undefined; delete(key: string): void }, slot: string, requestKey: string): void {
  const stored = memory.get<PendingOp<unknown>>(slot);
  if (!stored || stored.requestKey === requestKey) memory.delete(slot);
}


/**
 * The server refused the request because its key was given up (`REQUEST_ABANDONED`): the key's claim is abandoned, and
 * the claim is written in the same transaction as the record, so nothing was or ever will be recorded under it. Unlike
 * other refusals this is definite for every attempt, not only a sole first one.
 */
export const wasAbandoned = (err: unknown) => err instanceof ApiError && err.status === 409 && err.code === 'REQUEST_ABANDONED';

/**
 * An exact by-key lookup (Q10/Q12/Q13 `GET .../by-key/:key`) as the newest-first "records" `PendingOpPanel` checks: the
 * record that key produced, or nothing on a 404 (not recorded yet: only a give-up on the server settles that).
 * WQ11c: with `notFoundCodes`, only a 404 carrying one of the route's own "nothing with this key" codes means not
 * recorded; any other 404 (the account or the route itself missing) stays unknown and is shown as a failed check.
 */
export function keyedLookup<T>(requestKey: string, find: () => Promise<T>, notFoundCodes?: readonly string[]) {
  return async (page: number): Promise<Page<T & { requestKey: string }>> => {
    let items: (T & { requestKey: string })[] = [];
    try {
      items = [{ ...(await find()), requestKey }];
    } catch (err) {
      const notRecorded = err instanceof ApiError && err.status === 404 && (!notFoundCodes || (!!err.code && notFoundCodes.includes(err.code)));
      if (!notRecorded) throw err;
    }
    return { items, page, limit: 1, total: items.length, totalPages: 1 };
  };
}
