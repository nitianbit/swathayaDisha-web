/**
 * The one HTTP client for the SwasthaDisha backend (`/api/v1`). Every screen goes through it, so these rules hold
 * everywhere: a bearer token (cookies only for the three web-session commands, D4), no caching, no redirects, a
 * timeout, and one error type.
 *
 * Backend response shapes (src1): success `{ success, message?, data, pagination? }`, failure `{ error, message, code }`.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  /** Seconds to wait before trying again (429 `Retry-After`), when the server says. */
  readonly retryAfter: number | undefined;
  constructor(status: number, message: string, code?: string, retryAfter?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export type QueryValue = string | number | boolean | undefined | null;

export interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** Sent as `Idempotency-Key` (allowed by the backend's CORS). */
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** Default true. Login calls pass false so no stale token is sent. */
  auth?: boolean;
  /**
   * D4 web-session commands (OTP verify with a cookie session, refresh, logout): sends `X-Jansetu-Session: 1` and the
   * app's own first-party cookie (`credentials: 'same-origin'`). Every other request sends no cookie.
   */
  session?: boolean;
  /** D4: never renew on a 401 (requests made while holding the session lock, e.g. the sign-in profile check). */
  noRenew?: boolean;
  /** D4: send this bearer token instead of the current one (sign-out names the token the tab was using). */
  token?: string;
}

export interface Page<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface ApiClientOptions {
  /** Backend origin, e.g. `https://api.example.com`; '' means same origin (the dev server proxies `/api`). */
  baseUrl: string;
  getToken: () => string | null;
  /**
   * Aborted when the session that issued a request ends: sign-out cancels everything still in flight, so nothing
   * started for one staff member can complete (or sign out) the next one.
   */
  getSessionSignal?: () => AbortSignal | undefined;
  /** A request that carried `token` got 401. The session decides whether that token is still the current one. */
  onUnauthorized?: (token: string) => void;
  /**
   * D4: called once when a request with `token` gets 401. Returns a renewed token for the SAME signed-in person, or
   * null. With a token, the request is sent once more unchanged (same body, same request key).
   */
  renew?: (token: string) => Promise<string | null>;
  /** Covers the whole exchange: connecting, headers and reading the body. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export type ApiClient = ReturnType<typeof createApiClient>;

const SAFE_PATH = /^\/[A-Za-z0-9\-._~/:%]*$/;

function parseJson(text: string): unknown {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

export function createApiClient(options: ApiClientOptions) {
  const root = `${options.baseUrl.replace(/\/+$/, '')}/api/v1`;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const doFetch = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

  function url(path: string, query?: Record<string, QueryValue>): string {
    if (!SAFE_PATH.test(path) || path.includes('//') || path.split('/').includes('..')) {
      throw new Error(`Invalid API path: ${path}`);
    }
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      params.append(key, String(value));
    }
    const qs = params.toString();
    return `${root}${path}${qs ? `?${qs}` : ''}`;
  }

  /** One exchange; `read` consumes the body of a successful response under the same timeout and cancellation. */
  async function request<T>(method: string, path: string, o: RequestOptions, read: (res: Response) => Promise<T>, renewed = false): Promise<T> {
    const target = url(path, o.query); // before the try: a bad path is a programming error, not a network one
    const headers: Record<string, string> = { Accept: 'application/json' };
    const token = o.token ?? (o.auth === false ? null : options.getToken());
    if (token) headers.Authorization = `Bearer ${token}`;
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    if (o.idempotencyKey) headers['Idempotency-Key'] = o.idempotencyKey;
    if (o.session) headers['X-Jansetu-Session'] = '1';

    const sessionSignal = token ? options.getSessionSignal?.() : undefined;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    const signals = [timeout.signal, o.signal, sessionSignal].filter((x): x is AbortSignal => x !== undefined);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : timeout.signal;

    // The caller or the session cancelled: rethrow as is (an AbortError), never as a network or server failure.
    const translate = (err: unknown) => {
      if (err instanceof ApiError) return err;
      if (o.signal?.aborted || sessionSignal?.aborted) return err;
      if (timeout.signal.aborted) return new ApiError(0, 'The server took too long to respond. Please try again.', 'TIMEOUT');
      return new ApiError(0, 'Could not reach the server. Check your connection and try again.', 'NETWORK');
    };

    try {
      let res: Response;
      try {
        res = await doFetch(target, {
          method,
          headers,
          body: o.body === undefined ? undefined : JSON.stringify(o.body),
          credentials: o.session ? 'same-origin' : 'omit',
          cache: 'no-store',
          redirect: 'error',
          signal,
        });
      } catch (err) {
        throw translate(err);
      }
      if (!res.ok) {
        // A late answer for a session that has already ended is not news about the current one.
        if (sessionSignal?.aborted) throw new DOMException('The session ended', 'AbortError');
        if (res.status === 401 && token && options.renew && !renewed && !o.noRenew) {
          const next = await options.renew(token);
          if (next && next !== token) return request(method, path, o, read, true);
        }
        if (res.status === 401 && token) options.onUnauthorized?.(token);
        const text = await res.text().catch((err: unknown) => { throw translate(err); });
        const body = parseJson(text) as { message?: unknown; code?: unknown } | null;
        const message = typeof body?.message === 'string' && body.message ? body.message : `Request failed (${res.status})`;
        const wait = Number(res.headers.get('retry-after'));
        throw new ApiError(res.status, message, typeof body?.code === 'string' ? body.code : undefined,
          res.status === 429 && Number.isFinite(wait) && wait > 0 ? Math.ceil(wait) : undefined);
      }
      try {
        return await read(res);
      } catch (err) {
        throw translate(err);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  const json = <T>(method: string, path: string, o: RequestOptions = {}) =>
    request(method, path, o, async (res) => (parseJson(await res.text()) as { data?: T } | null)?.data as T);

  return {
    get: <T>(path: string, o?: RequestOptions) => json<T>('GET', path, o),
    post: <T>(path: string, o?: RequestOptions) => json<T>('POST', path, o),
    put: <T>(path: string, o?: RequestOptions) => json<T>('PUT', path, o),
    patch: <T>(path: string, o?: RequestOptions) => json<T>('PATCH', path, o),
    /** Lists that answer `{ data: T[], pagination: { page, limit, total, totalPages } }`. */
    page: <T>(path: string, o: RequestOptions = {}) => request('GET', path, o, async (res): Promise<Page<T>> => {
      const body = parseJson(await res.text()) as {
        data?: T[];
        pagination?: { page?: number; limit?: number; total?: number; totalPages?: number };
      } | null;
      const items = Array.isArray(body?.data) ? body.data : [];
      const p = body?.pagination ?? {};
      return {
        items,
        page: p.page ?? 1,
        limit: p.limit ?? items.length,
        total: p.total ?? items.length,
        totalPages: p.totalPages ?? 1,
      };
    }),
    blob: (path: string, o: RequestOptions = {}) => request('GET', path, o, (res) => res.blob()),
  };
}
