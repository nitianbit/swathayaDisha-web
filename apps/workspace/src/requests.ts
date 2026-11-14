import { ApiError, type Page } from '@jansetu/api';

/**
 * Operations that must happen once (a return moves stock and money). Each submission gets a request key; the server
 * answers a repeated key with the first record. The rules below decide when the client may forget a submission.
 */
export const newRequestKey = () => crypto.randomUUID().replace(/-/g, '');

/** The server refused this request itself (validation, state, limits, access): this request recorded nothing. */
export function definitelyNotRecorded(err: unknown): boolean {
  return err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;
}

/**
 * A submission not yet known to be recorded or not. `uncertain` becomes true as soon as one attempt ended without a
 * definite answer: from then on a refusal of a RETRY proves nothing about the earlier attempt (e.g. an access check
 * may refuse before the key is looked up), so only finding the key in the server's records, or a successful answer,
 * settles it.
 */
export interface PendingOp<B> {
  requestKey: string;
  body: B;
  uncertain: boolean;
  firstAttemptAt: number;
  lastAttemptAt: number;
  error?: string;
}

export function startOp<B>(requestKey: string, body: B, now = Date.now()): PendingOp<B> {
  return { requestKey, body, uncertain: false, firstAttemptAt: now, lastAttemptAt: now };
}

/** What to keep after an attempt failed: null = forget it (only a first attempt definitely refused). */
export function afterFailure<B>(p: PendingOp<B>, err: unknown, message: string, now = Date.now()): PendingOp<B> | null {
  if (!p.uncertain && definitelyNotRecorded(err)) return null;
  return { ...p, uncertain: true, lastAttemptAt: now, error: message };
}

/**
 * A request still running on the server has finished by then: MongoDB aborts a transaction after 60 s
 * (transactionLifetimeLimitSeconds) and the client gives up after 20 s.
 */
export const SETTLE_MS = 2 * 60_000;

export type KeySearch<T> = { found: T } | { found: null; settled: boolean } | { found: null; incomplete: true };

/**
 * Looks for the record carrying `requestKey` in a newest-first list, stopping once records are older than the
 * submission (minus 5 minutes for clock differences). `settled` = the last attempt is long enough ago that an absent
 * key means it was not recorded.
 */
export async function findByKey<T extends { requestKey?: string; createdAt?: string }>(
  fetchPage: (page: number) => Promise<Page<T>>, op: PendingOp<unknown>, now = Date.now(), maxPages = 20,
): Promise<KeySearch<T>> {
  const since = op.firstAttemptAt - 5 * 60_000;
  for (let page = 1; page <= maxPages; page++) {
    const p = await fetchPage(page);
    const hit = p.items.find((r) => r.requestKey === op.requestKey);
    if (hit) return { found: hit };
    const oldest = p.items[p.items.length - 1];
    const reachedOlder = oldest?.createdAt !== undefined && Date.parse(oldest.createdAt) < since;
    if (page >= p.totalPages || p.items.length === 0 || reachedOlder) {
      return { found: null, settled: now - op.lastAttemptAt >= SETTLE_MS };
    }
  }
  return { found: null, incomplete: true };
}
