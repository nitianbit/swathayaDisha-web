import { authApi, isEmailNotRegistered, maskTarget, normalizeEmail, parseLoginIdentifier, targetKey, targetKind } from './auth.ts';
import { ApiError } from './client.ts';
import { createApiClient } from './client.ts';

describe('WQ9 parseLoginIdentifier', () => {
  it('reads a 10-digit mobile, with spaces, dashes or a +91 prefix', () => {
    expect(parseLoginIdentifier('9876543210')).toEqual({ phone: '9876543210' });
    expect(parseLoginIdentifier('  98765 43210 ')).toEqual({ phone: '9876543210' });
    expect(parseLoginIdentifier('98765-43210')).toEqual({ phone: '9876543210' });
    expect(parseLoginIdentifier('+91 98765 43210')).toEqual({ phone: '9876543210' });
    expect(parseLoginIdentifier('919876543210')).toEqual({ phone: '9876543210' });
    expect(parseLoginIdentifier('09876543210')).toEqual({ phone: '9876543210' });
    expect(parseLoginIdentifier('0 98765 43210')).toEqual({ phone: '9876543210' });
  });

  it('refuses numbers that are not exactly 10 digits after the prefix', () => {
    for (const s of ['12345', '98765432101', '+44 9876543210', '+919876543', '98765x43210', '00 9876543210', '+91', '0']) {
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
    expect(maskTarget({ email: 'abc@x.in' })).toBe('a•••@x.in');
    // A part of 2 characters or fewer would be given away almost whole: only the domain is shown.
    expect(maskTarget({ email: 'ab@x.in' })).toBe('•••@x.in');
    expect(maskTarget({ email: 'a@x.in' })).toBe('•••@x.in');
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

describe('WQ9 normalizeEmail', () => {
  it('lower-cases and trims, and sends an internationalised domain in its ASCII (punycode) form', () => {
    expect(normalizeEmail(' Asha@Example.COM ')).toBe('asha@example.com');
    expect(normalizeEmail('asha@bücher.de')).toBe('asha@xn--bcher-kva.de');
    expect(normalizeEmail('asha@BÜCHER.de')).toBe('asha@xn--bcher-kva.de');
    expect(normalizeEmail('asha@xn--bcher-kva.de')).toBe('asha@xn--bcher-kva.de'); // what a Chromium email input answers
    const hindi = normalizeEmail('asha@मेरा.भारत')!;
    expect(hindi).toMatch(/^asha@xn--[a-z0-9-]+\.xn--h2brj9c$/);
    expect(normalizeEmail(hindi)).toBe(hindi); // already ASCII: unchanged
  });

  it('refuses what is not a plain address', () => {
    for (const s of ['asha', 'asha@', '@x.in', 'asha@x', 'asha@x.in:80', 'asha@x.in/a', 'asha@1.2.3.4', 'as ha@x.in', 'asha@x .in', 'asha@[::1]']) {
      expect(normalizeEmail(s)).toBeNull();
    }
  });

  it('is what the sign-in field sends', () => {
    expect(parseLoginIdentifier('Asha@Bücher.de')).toEqual({ email: 'asha@xn--bcher-kva.de' });
  });

  it('recognises EMAIL_NOT_REGISTERED', () => {
    expect(isEmailNotRegistered(new ApiError(404, 'No account uses this email', 'EMAIL_NOT_REGISTERED'))).toBe(true);
    expect(isEmailNotRegistered(new ApiError(404, 'Not found', 'USER_NOT_FOUND'))).toBe(false);
  });
});
