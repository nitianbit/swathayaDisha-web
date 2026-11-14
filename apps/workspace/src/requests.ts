import { ApiError } from '@jansetu/api';

/**
 * Request keys for operations that must happen once (a return removes or adds stock and money). A key is made per
 * submission; a retry after an uncertain outcome resends the same key AND the same details.
 */
export const newRequestKey = () => crypto.randomUUID().replace(/-/g, '');

/**
 * The server refused the request itself (validation, state, limits): nothing was recorded, so details may change and
 * go out under a new key. Anything else (no answer, timeout, 5xx, rate limit, cancelled) may have been recorded.
 */
export function definitelyNotRecorded(err: unknown): boolean {
  return err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;
}
