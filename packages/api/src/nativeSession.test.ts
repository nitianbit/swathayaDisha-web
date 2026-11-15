import { ApiError, createApiClient } from './client.ts';
import { authApi } from './auth.ts';
import { refreshTokenKey, rotateNative, type SecureStore } from './nativeSession.ts';

function memoryStore(initial: Record<string, string> = {}): SecureStore & { data: Record<string, string> } {
  const data = { ...initial };
  return { data, get: async (k) => data[k] ?? null, set: async (k, v) => { data[k] = v; }, remove: async (k) => { delete data[k]; } };
}
const KEY = refreshTokenKey('customer');

describe('rotateNative', () => {
  it('stores the rotated refresh token before handing back the access token', async () => {
    const store = memoryStore({ [KEY]: 'rt-1' });
    const r = await rotateNative(store, 'customer', async (rt) => ({ refreshToken: rt === 'rt-1' ? 'rt-2' : 'x', token: 'a' }));
    expect(r.token).toBe('a');
    expect(store.data[KEY]).toBe('rt-2');
  });
  it('a refused refresh (401) removes the stored token; a network failure keeps it for a retry', async () => {
    const refused = memoryStore({ [KEY]: 'rt-1' });
    await expect(rotateNative(refused, 'customer', async () => { throw new ApiError(401, 'Please sign in again', 'SESSION_ENDED'); }))
      .rejects.toMatchObject({ status: 401 });
    expect(refused.data[KEY]).toBeUndefined();
    const offline = memoryStore({ [KEY]: 'rt-1' });
    await expect(rotateNative(offline, 'customer', async () => { throw new ApiError(0, 'offline', 'NETWORK'); })).rejects.toMatchObject({ status: 0 });
    expect(offline.data[KEY]).toBe('rt-1');
  });
  it('without a stored token there is no session', async () => {
    await expect(rotateNative(memoryStore(), 'workspace', async () => ({ refreshToken: 'x' }))).rejects.toMatchObject({ status: 401 });
  });
});

describe('native session requests', () => {
  it('send X-Jansetu-Native, never a cookie or the session header; the refresh token travels in the body only', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = createApiClient({ baseUrl: 'https://api.example.test', getToken: () => null,
      fetchImpl: async (u, init) => { calls.push({ url: String(u), init: init ?? {} }); return new Response(JSON.stringify({ success: true, data: {} }), { status: 200 }); } });
    const auth = authApi(client);
    await auth.verifyOtpNative('pharmacy', { phone: '9876543210' }, '123456', 'workspace', 'rt-old');
    await auth.refreshNative('workspace', 'rt-1');
    await auth.logoutNative('workspace', 'rt-2', 'access-2');
    for (const c of calls) {
      expect(c.init.credentials).toBe('omit');
      expect(c.init.headers).toMatchObject({ 'X-Jansetu-Native': '1' });
      expect((c.init.headers as Record<string, string>)['X-Jansetu-Session']).toBeUndefined();
    }
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ phone: '9876543210', otp: '123456', session: 'native', app: 'workspace', previousRefreshToken: 'rt-old' });
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ app: 'workspace', refreshToken: 'rt-1' });
    expect((calls[2]!.init.headers as Record<string, string>).Authorization).toBe('Bearer access-2');
    expect(calls.map((c) => c.url)).not.toContain(expect.stringContaining('rt-'));
  });
});
