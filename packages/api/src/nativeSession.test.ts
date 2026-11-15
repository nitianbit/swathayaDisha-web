import { ApiError, createApiClient } from './client.ts';
import { authApi } from './auth.ts';
import { clearSignOutPending, nativeSignOut, refreshTokenKey, rotateNative, signOutPending, type SecureStore } from './nativeSession.ts';

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

describe('nativeSignOut', () => {
  beforeEach(() => { localStorage.clear(); });
  const failing = (initial: Record<string, string>, fail: { get?: boolean; remove?: number }) => {
    const base = memoryStore(initial);
    let removeFailures = fail.remove ?? 0;
    return { ...base, data: base.data,
      get: async (k: string) => { if (fail.get) throw new Error('keychain locked'); return base.get(k); },
      remove: async (k: string) => { if (removeFailures > 0) { removeFailures--; throw new Error('busy'); } return base.remove(k); } };
  };

  it('tells the server even when the stored token cannot be read, and still clears the store', async () => {
    const store = failing({ [KEY]: 'rt-1' }, { get: true });
    const logout = vi.fn(async () => undefined);
    await expect(nativeSignOut(store, 'customer', logout)).resolves.toBe(true);
    expect(logout).toHaveBeenCalledExactlyOnceWith(null);
    expect(store.data[KEY]).toBeUndefined();
    expect(signOutPending('customer')).toBe(false);
  });
  it('retries a failing removal; if it keeps failing the sign-out stays pending (the next start finishes it)', async () => {
    const flaky = failing({ [KEY]: 'rt-1' }, { remove: 1 });
    await expect(nativeSignOut(flaky, 'customer', async () => undefined)).resolves.toBe(true);
    expect(flaky.data[KEY]).toBeUndefined();
    const stuck = failing({ [refreshTokenKey('workspace')]: 'rt-1' }, { remove: 5 });
    const logout = vi.fn(async () => { throw new Error('offline'); });
    await expect(nativeSignOut(stuck, 'workspace', logout)).resolves.toBe(false);
    expect(logout).toHaveBeenCalledExactlyOnceWith('rt-1');
    expect(signOutPending('workspace')).toBe(true);
    expect(signOutPending('customer')).toBe(false);
    clearSignOutPending('workspace');
    expect(signOutPending('workspace')).toBe(false);
  });
  it('the pending mark holds no token', async () => {
    await nativeSignOut(failing({ [KEY]: 'rt-secret' }, { remove: 5 }), 'customer', async () => undefined);
    expect(JSON.stringify({ ...localStorage })).not.toContain('rt-secret');
  });
});
