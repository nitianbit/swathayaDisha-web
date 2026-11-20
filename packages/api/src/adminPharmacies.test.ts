import { ApiError, createApiClient } from './client.ts';
import {
  EMPTY_PHARMACY_FORM, isPharmacyEmailTaken, isPharmacyPhoneTaken, PHARMACY_FIELDS, pharmacyAdminApi, pharmacyBody, pharmacyForm, type PharmacyAccount,
} from './adminPharmacies.ts';

const ID = 'a1'.repeat(12);

function recorder(answer: (url: string) => unknown = () => ({ success: true, data: {} })) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const client = createApiClient({ baseUrl: 'https://api.example.test', getToken: () => 'tok',
    fetchImpl: async (u, init) => {
      const url = String(u).replace('https://api.example.test/api/v1', '');
      calls.push({ method: String(init?.method), url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      return new Response(JSON.stringify(answer(url)), { status: 200 });
    } });
  return { api: pharmacyAdminApi(client), calls };
}

const account = (o: Partial<PharmacyAccount>): PharmacyAccount => ({ _id: ID, name: 'Apollo', phone: '9000000001', ...o });

describe('admin pharmacies: paths and bodies (pharmacies/routes)', () => {
  it('lists with the name filter, status filters and 20 a page; reads, creates and updates by id', async () => {
    const { api, calls } = recorder((url) => (url.startsWith('/pharmacies?') ? { success: true, data: [], pagination: { page: 2, limit: 20, total: 0, totalPages: 1 } } : { success: true, data: account({}) }));
    await api.list({ name: ' Apollo ', isVerified: 'false', isActive: 'true', page: 2 });
    await api.list();
    await api.get(ID);
    await api.create({ name: 'Apollo', phone: '9000000001' });
    await api.update(ID, { isVerified: true });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /pharmacies?name=Apollo&isVerified=false&isActive=true&page=2&limit=20',
      'GET /pharmacies?page=1&limit=20',
      `GET /pharmacies/${ID}`,
      'POST /pharmacies',
      `PUT /pharmacies/${ID}`,
    ]);
    expect(calls[3]!.body).toEqual({ name: 'Apollo', phone: '9000000001' });
    expect(calls[4]!.body).toEqual({ isVerified: true });
  });

  it('refuses a bad id or number before any request', async () => {
    const { api, calls } = recorder();
    expect(() => api.get('../x')).toThrow('Invalid pharmacy id');
    expect(() => api.update('1', {})).toThrow('Invalid pharmacy id');
    await expect(api.findByPhone('12345', Date.now())).rejects.toThrow('Invalid mobile number');
    expect(calls).toHaveLength(0);
  });

  it('finds an unconfirmed create by its number, newest first, and stops at pharmacies older than the attempt', async () => {
    const since = Date.parse('2026-11-20T10:00:00Z');
    const pages: Record<number, PharmacyAccount[]> = {
      1: [account({ _id: 'b'.repeat(24), phone: '9000000009', createdAt: '2026-11-20T10:05:00Z' })],
      2: [account({ _id: 'c'.repeat(24), phone: '9000000001', createdAt: '2026-11-20T10:01:00Z' })],
    };
    const { api, calls } = recorder((url) => {
      const page = Number(new URL(`https://x${url}`).searchParams.get('page'));
      return { success: true, data: pages[page] ?? [], pagination: { page, limit: 100, total: 2, totalPages: 3 } };
    });
    expect((await api.findByPhone('9000000001', since))?._id).toBe('c'.repeat(24));
    expect(calls.map((c) => c.url)).toEqual([
      '/pharmacies?page=1&limit=100&sortBy=createdAt&sortOrder=desc',
      '/pharmacies?page=2&limit=100&sortBy=createdAt&sortOrder=desc',
    ]);
    const old = recorder(() => ({ success: true, data: [account({ phone: '9000000009', createdAt: '2026-11-19T00:00:00Z' })], pagination: { page: 1, limit: 100, total: 300, totalPages: 3 } }));
    expect(await old.api.findByPhone('9000000001', since)).toBeNull();
    expect(old.calls).toHaveLength(1); // older than an hour before the first attempt: not ours, stop
  });
});

describe('admin pharmacies: the form as createPharmacySchema / updatePharmacySchema', () => {
  it('a create needs a name and a 10-digit number; optional fields only when given, trimmed; the email normalised', () => {
    expect(pharmacyBody(EMPTY_PHARMACY_FORM, PHARMACY_FIELDS).errors).toEqual({ name: 'Enter the pharmacy’s name.', phone: 'Enter the 10-digit mobile number.' });
    const { body, errors } = pharmacyBody({ ...EMPTY_PHARMACY_FORM, name: ' Apollo ', phone: '9000000001', email: ' Desk@Apollo.IN ', city: ' Pune ', pincode: '411001', deliveryAvailable: true }, PHARMACY_FIELDS);
    expect(errors).toEqual({});
    expect(body).toEqual({ name: 'Apollo', phone: '9000000001', email: 'desk@apollo.in', city: 'Pune', pincode: '411001', pickupAvailable: false, deliveryAvailable: true });
    expect(pharmacyBody({ ...EMPTY_PHARMACY_FORM, name: 'A', phone: '9000000001', email: 'x@', pincode: '4110' }, PHARMACY_FIELDS).errors)
      .toEqual({ email: 'Enter a valid email address.', pincode: 'Enter the 6-digit PIN code.' });
    expect(pharmacyBody({ ...EMPTY_PHARMACY_FORM, name: 'n'.repeat(201), phone: '9000000001', gstNumber: 'g'.repeat(51) }, PHARMACY_FIELDS).errors)
      .toEqual({ name: 'Use at most 200 characters.', gstNumber: 'Use at most 50 characters.' });
  });

  it('an update sends only the given fields and refuses to clear one the server holds (it takes no empty strings)', () => {
    const p = account({ email: 'old@apollo.in', city: 'Pune', pincode: '411001' });
    const form = { ...pharmacyForm(p), city: '', email: '', ownerName: 'Ravi' };
    const r = pharmacyBody(form, ['city', 'email', 'ownerName'], p);
    expect(r.errors.city).toMatch(/cannot be removed/);
    expect(r.errors.email).toMatch(/cannot be removed/);
    expect(pharmacyBody(form, ['ownerName'], p)).toEqual({ body: { ownerName: 'Ravi' }, errors: {} });
  });

  it('names the server’s duplicate refusals', () => {
    expect(isPharmacyPhoneTaken(new ApiError(400, 'A pharmacy with this phone number already exists', 'PHONE_ALREADY_EXISTS'))).toBe(true);
    expect(isPharmacyEmailTaken(new ApiError(400, 'A pharmacy with this email already exists', 'EMAIL_ALREADY_EXISTS'))).toBe(true);
    expect(isPharmacyPhoneTaken(new ApiError(400, 'x', 'EMAIL_ALREADY_EXISTS'))).toBe(false);
  });
});
