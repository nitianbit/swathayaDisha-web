import { ApiError, createApiClient } from './client.ts';
import {
  EMPTY_PHARMACY_FORM, isPharmacyEmailTaken, isPharmacyPhoneTaken, PHARMACY_FIELDS, pharmacyAdminApi, pharmacyBody, pharmacyForm, pharmacyHolds,
  signsPharmacyOut, type PharmacyAccount,
} from './adminPharmacies.ts';

const ID = 'a1'.repeat(12);
const KEY = 'k'.repeat(32);

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
  it('lists with the name or exact mobile filter, status filters and 20 a page; reads, creates with a key and updates with a version', async () => {
    const { api, calls } = recorder((url) => (url.startsWith('/pharmacies?') ? { success: true, data: [], pagination: { page: 2, limit: 20, total: 0, totalPages: 1 } } : { success: true, data: account({}) }));
    await api.list({ name: ' Apollo ', isVerified: 'false', isActive: 'true', page: 2 });
    await api.list();
    await api.list({ phone: '9000000001' });
    await api.get(ID);
    expect(await api.create({ name: 'Apollo', phone: '9000000001' }, KEY)).toEqual({ pharmacy: account({}), replayed: false });
    await api.update(ID, { isVerified: true }, '2026-11-20T10:00:00.000Z');
    await api.update(ID, { city: null });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /pharmacies?name=Apollo&isVerified=false&isActive=true&page=2&limit=20',
      'GET /pharmacies?page=1&limit=20',
      'GET /pharmacies?phone=9000000001&page=1&limit=20',
      `GET /pharmacies/${ID}`,
      'POST /pharmacies',
      `PUT /pharmacies/${ID}`,
      `PUT /pharmacies/${ID}`,
    ]);
    expect(calls[4]!.body).toEqual({ name: 'Apollo', phone: '9000000001', requestKey: KEY });
    expect(calls[5]!.body).toEqual({ isVerified: true, expectedUpdatedAt: '2026-11-20T10:00:00.000Z' });
    expect(calls[6]!.body).toEqual({ city: null });
  });

  it('refuses a bad id, number or key before any request', async () => {
    const { api, calls } = recorder();
    expect(() => api.get('../x')).toThrow('Invalid pharmacy id');
    expect(() => api.update('1', {})).toThrow('Invalid pharmacy id');
    expect(() => api.list({ phone: '12345' })).toThrow('Invalid mobile number');
    await expect(api.findByPhone('12345')).rejects.toThrow('Invalid mobile number');
    await expect(api.create({ name: 'A', phone: '9000000001' }, 'short')).rejects.toThrow('Invalid request key');
    await expect(api.createdByKey('../x')).rejects.toThrow('Invalid request key');
    expect(() => api.abandonCreate('a b c d e f')).toThrow('Invalid request key');
    expect(calls).toHaveLength(0);
  });

  it('Q15 by key: a replayed create, the pharmacy a key made (null on 404), giving a key up, and the exact phone lookup', async () => {
    const answers: unknown[] = [
      { success: true, data: account({}), replayed: true },
      { success: true, data: account({}) },
      { error: 404, code: 'PHARMACY_NOT_FOUND', message: 'No pharmacy was created with this key' },
      { error: 404, code: 'NOT_FOUND', message: 'Not found' },
      { success: true, data: { state: 'abandoned' } },
      { success: true, data: [account({})], pagination: { page: 1, limit: 1, total: 1, totalPages: 1 } },
      { success: true, data: [], pagination: { page: 1, limit: 1, total: 0, totalPages: 0 } },
    ];
    const calls: string[] = [];
    const client = createApiClient({ baseUrl: 'https://api.example.test', getToken: () => 'tok',
      fetchImpl: async (u, init) => {
        calls.push(`${String(init?.method)} ${String(u).replace('https://api.example.test/api/v1', '')}`);
        const body = answers.shift() as { error?: number };
        return new Response(JSON.stringify(body), { status: body.error ?? 200 });
      } });
    const api = pharmacyAdminApi(client);
    expect(await api.create({ name: 'Apollo', phone: '9000000001' }, KEY)).toEqual({ pharmacy: account({}), replayed: true });
    expect(await api.createdByKey(KEY)).toEqual(account({}));
    expect(await api.createdByKey(KEY)).toBeNull();
    await expect(api.createdByKey(KEY)).rejects.toThrow('Not found'); // review: any other 404 stays unknown
    expect(await api.abandonCreate(KEY)).toEqual({ state: 'abandoned' });
    expect(await api.findByPhone('9000000001')).toEqual(account({}));
    expect(await api.findByPhone('9000000002')).toBeNull();
    expect(calls).toEqual([
      'POST /pharmacies', `GET /pharmacies/by-key/${KEY}`, `GET /pharmacies/by-key/${KEY}`, `GET /pharmacies/by-key/${KEY}`, `POST /pharmacies/by-key/${KEY}/abandon`,
      'GET /pharmacies?phone=9000000001&page=1&limit=1', 'GET /pharmacies?phone=9000000002&page=1&limit=1',
    ]);
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

  it('an update sends only the given fields; an emptied optional field is sent as null (Q15), the name and number stay required', () => {
    const p = account({ email: 'old@apollo.in', city: 'Pune', pincode: '411001' });
    const form = { ...pharmacyForm(p), city: '', email: '', pincode: '', ownerName: 'Ravi' };
    expect(pharmacyBody(form, ['city', 'email', 'pincode', 'ownerName'], p)).toEqual({ body: { city: null, email: null, pincode: null, ownerName: 'Ravi' }, errors: {} });
    expect(pharmacyBody(form, ['ownerName'], p)).toEqual({ body: { ownerName: 'Ravi' }, errors: {} });
    expect(pharmacyBody({ ...form, address: '' }, ['address'], p)).toEqual({ body: {}, errors: {} }); // nothing held: nothing to clear
    const r = pharmacyBody({ ...form, name: ' ', phone: '' }, ['name', 'phone'], p);
    expect(r.errors).toEqual({ name: 'The name cannot be removed. Enter the new name.', phone: expect.stringMatching(/cannot be removed/) });
  });

  it('knows when a save signs the pharmacy out and when a re-read holds a save', () => {
    const p = account({ email: 'old@apollo.in', city: 'Pune' });
    expect(signsPharmacyOut(p, { phone: '9000000002' })).toBe(true);
    expect(signsPharmacyOut(p, { email: 'new@apollo.in' })).toBe(true);
    expect(signsPharmacyOut(p, { email: null })).toBe(true);
    expect(signsPharmacyOut(account({}), { email: 'first@apollo.in' })).toBe(false); // a first email ends nothing
    expect(signsPharmacyOut(p, { city: 'Mumbai' })).toBe(false);
    expect(pharmacyHolds(account({ city: 'Mumbai', isActive: false }), { city: 'Mumbai', isActive: false, email: null })).toBe(true);
    expect(pharmacyHolds(p, { city: null })).toBe(false);
    expect(pharmacyHolds(account({}), { pickupAvailable: false, isActive: true })).toBe(true);
  });

  it('names the server’s duplicate refusals', () => {
    expect(isPharmacyPhoneTaken(new ApiError(400, 'A pharmacy with this phone number already exists', 'PHONE_ALREADY_EXISTS'))).toBe(true);
    expect(isPharmacyEmailTaken(new ApiError(400, 'A pharmacy with this email already exists', 'EMAIL_ALREADY_EXISTS'))).toBe(true);
    expect(isPharmacyEmailTaken(new ApiError(409, 'A pharmacy with this email already exists', 'EMAIL_ALREADY_EXISTS'))).toBe(true); // Q15 review: 409 too
    expect(isPharmacyPhoneTaken(new ApiError(400, 'x', 'EMAIL_ALREADY_EXISTS'))).toBe(false);
  });
});
