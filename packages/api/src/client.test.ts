import { ApiError, createApiClient } from './client.ts';
import { fetchableFileUrl, pharmacyOrdersApi } from './pharmacyOrders.ts';

function setup(response: Response | (() => Promise<Response>), token: string | null = 'tok') {
  const calls: { url: string; init: RequestInit }[] = [];
  const onUnauthorized = vi.fn();
  const client = createApiClient({
    baseUrl: 'https://api.example.test/',
    getToken: () => token,
    onUnauthorized,
    timeoutMs: 50,
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return typeof response === 'function' ? response() : response;
    },
  });
  return { client, calls, onUnauthorized };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('api client', () => {
  it('sends the bearer token, no cookies, no cache, no redirects; returns data', async () => {
    const { client, calls } = setup(json(200, { success: true, data: { ok: 1 } }));
    await expect(client.post('/things', { body: { a: 1 }, idempotencyKey: 'k1' })).resolves.toEqual({ ok: 1 });
    const call = calls[0]!;
    expect(call.url).toBe('https://api.example.test/api/v1/things');
    expect(call.init).toMatchObject({ method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error' });
    expect(call.init.headers).toMatchObject({ Authorization: 'Bearer tok', 'Idempotency-Key': 'k1', 'Content-Type': 'application/json' });
    expect(call.init.body).toBe('{"a":1}');
  });

  it('omits the token when auth is false and drops empty query values', async () => {
    const { client, calls } = setup(json(200, { success: true }));
    await client.get('/x', { auth: false, query: { a: 'b c', n: 0, empty: '', u: undefined } });
    expect(calls[0]!.url).toBe('https://api.example.test/api/v1/x?a=b+c&n=0');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('maps the backend error body and ends the session on 401', async () => {
    const { client, onUnauthorized } = setup(json(401, { error: 401, message: 'Token expired', code: 'TOKEN_EXPIRED' }));
    const err = await client.get('/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401, message: 'Token expired', code: 'TOKEN_EXPIRED' });
    expect(onUnauthorized).toHaveBeenCalledExactlyOnceWith('tok');
  });

  it('O1: a 429 carries the Retry-After wait; other errors carry none', async () => {
    const limited = new Response(JSON.stringify({ error: 429, code: 'OTP_SEND_LIMIT', message: 'Too many codes requested.', retryAfter: 25 }),
      { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '25' } });
    const err = await setup(limited).client.post('/auth/user/send', { auth: false }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 429, code: 'OTP_SEND_LIMIT', retryAfter: 25 });
    const other = await setup(json(404, { message: 'Incorrect code. 4 attempts left.', code: 'OTP_NOT_FOUND' })).client
      .post('/auth/user/verify', { auth: false }).catch((e: unknown) => e);
    expect((other as ApiError).retryAfter).toBeUndefined();
  });

  it('D4: session commands send the session header and the first-party cookie; nothing else does', async () => {
    const { client, calls } = setup(async () => json(200, { success: true, data: {} }));
    await client.post('/auth/session/refresh', { body: {}, auth: false, session: true });
    expect(calls[0]!.init).toMatchObject({ credentials: 'same-origin' });
    expect(calls[0]!.init.headers).toMatchObject({ 'X-Jansetu-Session': '1' });
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBeUndefined();
    await client.get('/x');
    expect(calls[1]!.init).toMatchObject({ credentials: 'omit' });
    expect((calls[1]!.init.headers as Record<string, string>)['X-Jansetu-Session']).toBeUndefined();
  });

  it('D4: a 401 renews once for the same person and resends the same request unchanged', async () => {
    let token = 'old';
    const calls: { headers: Record<string, string>; body: unknown }[] = [];
    const renew = vi.fn(async () => { token = 'new'; return 'new'; });
    const onUnauthorized = vi.fn();
    const client = createApiClient({ baseUrl: '', getToken: () => token, renew, onUnauthorized, fetchImpl: async (_u, init) => {
      calls.push({ headers: init!.headers as Record<string, string>, body: init!.body });
      return calls.length === 1 ? json(401, { code: 'TOKEN_EXPIRED' }) : json(200, { success: true, data: { ok: true } });
    } });
    await expect(client.post('/returns', { body: { requestKey: 'k1', qty: 2 } })).resolves.toEqual({ ok: true });
    expect(renew).toHaveBeenCalledExactlyOnceWith('old');
    expect(calls.map((c) => c.headers.Authorization)).toEqual(['Bearer old', 'Bearer new']);
    expect(calls[1]!.body).toBe(calls[0]!.body);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('D4: no renewal (or a second 401) ends the session; never more than one retry', async () => {
    const onUnauthorized = vi.fn();
    let n = 0;
    const client = createApiClient({ baseUrl: '', getToken: () => (n === 0 ? 't0' : 't1'), onUnauthorized,
      renew: async () => 't1', fetchImpl: async () => { n++; return json(401, { code: 'X' }); } });
    await expect(client.get('/x')).rejects.toMatchObject({ status: 401 });
    expect(n).toBe(2);
    expect(onUnauthorized).toHaveBeenCalledExactlyOnceWith('t1');
    const none = createApiClient({ baseUrl: '', getToken: () => 't', onUnauthorized, renew: async () => null, fetchImpl: async () => json(401, {}) });
    await expect(none.get('/x')).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenLastCalledWith('t');
  });

  it('D4: noRenew requests never renew (no wait on the session lock); an explicit token is sent as given', async () => {
    const renew = vi.fn(async () => 'new');
    const onUnauthorized = vi.fn();
    const seen: string[] = [];
    const client = createApiClient({ baseUrl: '', getToken: () => 'cur', renew, onUnauthorized, fetchImpl: async (_u, init) => {
      seen.push((init!.headers as Record<string, string>).Authorization ?? '');
      return json(401, {});
    } });
    await expect(client.get('/auth/profile', { noRenew: true })).rejects.toMatchObject({ status: 401 });
    expect(renew).not.toHaveBeenCalled();
    await expect(client.post('/auth/session/logout', { body: {}, session: true, token: 'tab-token', noRenew: true })).rejects.toMatchObject({ status: 401 });
    expect(seen).toEqual(['Bearer cur', 'Bearer tab-token']);
  });

  it('cancels a request when its session ends, and never reports its late 401', async () => {
    const session = new AbortController();
    const onUnauthorized = vi.fn();
    let respond!: (r: Response) => void;
    const client = createApiClient({
      baseUrl: '', getToken: () => 'old', getSessionSignal: () => session.signal, onUnauthorized, timeoutMs: 5_000,
      // Like a server that answers late, after the user signed out.
      fetchImpl: () => new Promise<Response>((r) => { respond = r; }),
    });
    const pending = client.get('/x');
    session.abort();
    respond(json(401, { error: 401, message: 'Token expired' }));
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('AbortError');
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('times out while reading a body that stalls after the headers', async () => {
    const client = createApiClient({
      baseUrl: '', getToken: () => 'tok', timeoutMs: 30,
      fetchImpl: async (_i, init) => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"data":'));
          // Never closes; a real fetch body errors when the request signal aborts.
          init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
        },
      }), { status: 200 }),
    });
    await expect(client.get('/x')).rejects.toMatchObject({ status: 0, code: 'TIMEOUT' });
    await expect(client.blob('/x')).rejects.toMatchObject({ status: 0, code: 'TIMEOUT' });
  });

  it('does not end the session for a 401 on a call without a token (wrong OTP)', async () => {
    const { client, onUnauthorized } = setup(json(401, { error: 401, message: 'Invalid OTP' }), null);
    await expect(client.post('/auth/user/verify', { auth: false })).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('gives a generic message when the error body is not JSON', async () => {
    const { client } = setup(new Response('<html>', { status: 502 }));
    await expect(client.get('/x')).rejects.toMatchObject({ status: 502, message: 'Request failed (502)' });
  });

  it('reports network failure and timeout as ApiError status 0', async () => {
    await expect(setup(() => Promise.reject(new TypeError('fail'))).client.get('/x'))
      .rejects.toMatchObject({ status: 0, code: 'NETWORK' });
    // A server that never answers: the client's own timer aborts (rejecting on abort is fetch's job; emulated).
    const hanging = createApiClient({
      baseUrl: '', getToken: () => null, timeoutMs: 20,
      fetchImpl: (_i, init) => new Promise((_r, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    });
    await expect(hanging.get('/x')).rejects.toMatchObject({ status: 0, code: 'TIMEOUT' });
  });

  it('refuses unsafe paths', async () => {
    const { client } = setup(json(200, {}));
    await expect(client.get('/a/../b')).rejects.toThrow('Invalid API path');
    await expect(client.get('https://evil.test/x')).rejects.toThrow('Invalid API path');
    await expect(client.get('//evil.test/x')).rejects.toThrow('Invalid API path');
  });

  it('reads paginated lists', async () => {
    const { client } = setup(json(200, { success: true, data: [{ _id: '1' }], pagination: { page: 2, limit: 20, total: 21, totalPages: 2 } }));
    await expect(client.page('/list')).resolves.toEqual({ items: [{ _id: '1' }], page: 2, limit: 20, total: 21, totalPages: 2 });
  });
});

describe('pharmacy orders api', () => {
  it('refuses a malformed order id before calling the server', () => {
    const { client, calls } = setup(json(200, {}));
    expect(() => pharmacyOrdersApi(client).get('../admins')).toThrow('Invalid order id');
    expect(calls).toHaveLength(0);
  });

  it('rewrites stored upload URLs into the form the file route resolves, and leaves others alone', () => {
    expect(fetchableFileUrl('/api/static/pharmacy/abc/rx.png')).toBe('/api/v1/file/static/pharmacy/abc/rx.png');
    expect(fetchableFileUrl('/api/v1/file/static/pharmacy/abc/rx.png')).toBe('/api/v1/file/static/pharmacy/abc/rx.png');
    expect(fetchableFileUrl('pharmacy/abc/rx.png')).toBe('pharmacy/abc/rx.png');
  });

  it('fetches a stored /api/static upload through the file route', async () => {
    const { client, calls } = setup(new Response('img', { status: 200 }));
    await pharmacyOrdersApi(client).prescriptionFile('/api/static/pharmacy/abc/rx.png');
    expect(new URL(calls[0]!.url).searchParams.get('url')).toBe('/api/v1/file/static/pharmacy/abc/rx.png');
  });

  it('fetches a prescription file through the authenticated file route', async () => {
    const { client, calls } = setup(new Response('pdf-bytes', { status: 200 }));
    const blob = await pharmacyOrdersApi(client).prescriptionFile('pharmacy/abc/rx 1.pdf');
    expect(await blob.text()).toBe('pdf-bytes');
    expect(calls[0]!.url).toBe('https://api.example.test/api/v1/file/fetch?url=pharmacy%2Fabc%2Frx+1.pdf');
  });
});
