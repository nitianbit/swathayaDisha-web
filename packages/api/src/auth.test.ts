import { authApi, maskTarget, parseLoginIdentifier, targetKey, targetKind } from './auth.ts';
import { createApiClient } from './client.ts';

describe('WQ9 parseLoginIdentifier', () => {
  it('reads a 10-digit mobile, with spaces, dashes or a +91 prefix', () => {
    expect(parseLoginIdentifier('9876543210')).toEqual({ phone: '9876543210' });
    expect(parseLoginIdentifier('  98765 43210 ')).toEqual({ phone: '9876543210' });
    expect(parseLoginIdentifier('98765-43210')).toEqual({ phone: '9876543210' });
    expect(parseLoginIdentifier('+91 98765 43210')).toEqual({ phone: '9876543210' });
    expect(parseLoginIdentifier('919876543210')).toEqual({ phone: '9876543210' });
  });

  it('refuses numbers that are not exactly 10 digits after the prefix', () => {
    for (const s of ['12345', '98765432101', '+44 9876543210', '+919876543', '98765x43210', '0 9876543210', '+91']) {
      expect(parseLoginIdentifier(s)).toBeNull();
    }
  });

  it('reads an email, trimmed and lower-cased', () => {
    expect(parseLoginIdentifier('  Ravi.Owner@Example.COM ')).toEqual({ email: 'ravi.owner@example.com' });
    expect(parseLoginIdentifier('a+b@lab.co.in')).toEqual({ email: 'a+b@lab.co.in' });
  });

  it('refuses malformed or overlong emails, and anything empty', () => {
    for (const s of ['ravi@', '@example.com', 'ravi@example', 'ravi @example.com', 'a@b@c.com', '', '   ']) {
      expect(parseLoginIdentifier(s)).toBeNull();
    }
    expect(parseLoginIdentifier(`${'a'.repeat(250)}@x.in`)).toBeNull();
  });

  it('gives exactly one key, never both', () => {
    expect(Object.keys(parseLoginIdentifier('9876543210')!)).toEqual(['phone']);
    expect(Object.keys(parseLoginIdentifier('r@x.in')!)).toEqual(['email']);
  });
});

describe('WQ9 target helpers', () => {
  it('masks the destination on the code step', () => {
    expect(maskTarget({ phone: '9876543210' })).toBe('••••••3210');
    expect(maskTarget({ email: 'ravi.owner@example.com' })).toBe('r•••@example.com');
  });

  it('keys and kinds per destination', () => {
    expect(targetKey({ phone: '9876543210' })).toBe('phone:9876543210');
    expect(targetKey({ email: 'r@x.in' })).toBe('email:r@x.in');
    expect(targetKind({ phone: '9876543210' })).toBe('phone');
    expect(targetKind({ email: 'r@x.in' })).toBe('email');
  });

  it('sends the email key to send and verify', async () => {
    const bodies: unknown[] = [];
    const client = createApiClient({
      baseUrl: 'https://api.example.test/', getToken: () => null, onUnauthorized: () => undefined,
      fetchImpl: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ success: true, data: { token: 't', user: {} } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    });
    const auth = authApi(client);
    await auth.sendOtp('partner', { email: 'r@x.in' });
    await auth.verifyOtp('partner', { email: 'r@x.in' }, '123456');
    expect(bodies).toEqual([{ email: 'r@x.in' }, { email: 'r@x.in', otp: '123456' }]);
  });
});
