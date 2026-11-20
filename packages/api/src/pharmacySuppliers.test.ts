import { ApiError, createApiClient } from './client.ts';
import {
  allSuppliers, draftOfSupplier, isSupplierConflict, pharmacySuppliersApi, supplierCreateBody, supplierHas, supplierPatchBody, supplierProblems,
  type PharmacySupplier,
} from './pharmacySuppliers.ts';

const S = 'ab'.repeat(12);
const KEY = 'k'.repeat(32);

function recorder(answer: (url: string) => Response) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const client = createApiClient({ baseUrl: 'https://api.example.test', getToken: () => 'tok',
    fetchImpl: async (u, init) => {
      const url = String(u).replace('https://api.example.test/api/v1', '');
      calls.push({ method: String(init?.method), url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      return answer(url);
    } });
  return { client, calls };
}

const supplier = (o: Partial<PharmacySupplier> = {}): PharmacySupplier => ({
  supplierId: S, displayName: 'Sun Distributors', contactName: 'Ravi', phone: '+91 98765 43210', email: null, address: null,
  state: 'active', revision: 3, createdAt: '2026-11-20T10:00:00.000Z', updatedAt: '2026-11-20T10:00:00.000Z', archivedAt: null, ...o,
});

describe('suppliers (pharmacySuppliers validation)', () => {
  it('checks fields like the server: a name, limits, phone characters, an email', () => {
    const d = draftOfSupplier();
    expect(supplierProblems(d).displayName).toBeTruthy();
    expect(supplierProblems({ ...d, displayName: 'Sun' })).toEqual({});
    expect(supplierProblems({ ...d, displayName: 'x'.repeat(121) }).displayName).toMatch(/120/);
    expect(supplierProblems({ ...d, displayName: 'Sun', phone: '98765#432' }).phone).toBeTruthy();
    expect(supplierProblems({ ...d, displayName: 'Sun', phone: '+91 (98765) 43210' }).phone).toBeUndefined();
    expect(supplierProblems({ ...d, displayName: 'Sun', email: 'orders@' }).email).toBeTruthy();
    expect(supplierProblems({ ...d, displayName: 'Sun', address: 'a'.repeat(501) }).address).toMatch(/500/);
  });

  it('creates with the name and only the filled fields; edits send only changes, emptied ones as null', () => {
    expect(supplierCreateBody({ displayName: ' Sun ', contactName: '', phone: ' 0612 22 ', email: '', address: '  ' }))
      .toEqual({ displayName: 'Sun', phone: '0612 22' });
    const base = supplier();
    expect(supplierPatchBody(draftOfSupplier(base), base)).toEqual({});
    expect(supplierPatchBody({ ...draftOfSupplier(base), contactName: '', email: 'a@b.in' }, base)).toEqual({ contactName: null, email: 'a@b.in' });
    expect(supplierHas(base, { contactName: 'Ravi', email: null })).toBe(true);
    expect(supplierHas(base, { contactName: 'Asha' })).toBe(false);
  });

  it('names the revision on every change and lists every page', async () => {
    const { client, calls } = recorder((url) => new Response(JSON.stringify(url.startsWith('/pharmacy-suppliers?')
      ? { success: true, data: [supplier()], pagination: { page: Number(new URL(`http://x${url}`).searchParams.get('page')), limit: 50, total: 2, totalPages: 2 } }
      : { success: true, data: supplier() }), { status: 200 }));
    const api = pharmacySuppliersApi(client);
    expect(await api.create({ displayName: 'Sun' }, KEY)).toEqual({ supplier: supplier(), replayed: false });
    await api.update(S, { phone: null }, 3);
    await api.archive(S, 4);
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['POST', '/pharmacy-suppliers', { displayName: 'Sun', requestKey: KEY }],
      ['PATCH', `/pharmacy-suppliers/${S}`, { phone: null, expectedRevision: 3 }],
      ['POST', `/pharmacy-suppliers/${S}/archive`, { expectedRevision: 4 }],
    ]);
    expect(() => api.update(S.toUpperCase(), {}, 1)).toThrow(); // the server accepts lower-case ids only
    expect(() => api.archive(S, 0)).toThrow();
    expect(await allSuppliers(client, 'all')).toHaveLength(2);
    expect(calls.slice(3).map((c) => c.url)).toEqual(['/pharmacy-suppliers?state=all&page=1&limit=50', '/pharmacy-suppliers?state=all&page=2&limit=50']);
    expect(isSupplierConflict(new ApiError(409, 'Supplier changed', 'SUPPLIER_CONFLICT'))).toBe(true);
    expect(isSupplierConflict(new ApiError(409, 'x', 'OTHER'))).toBe(false);
  });

  it('Q15: a keyed create answers a repeat with the same supplier (`replayed`); by-key finds it, or null on 404', async () => {
    const answers = [
      new Response(JSON.stringify({ success: true, data: supplier(), replayed: true }), { status: 200 }),
      new Response(JSON.stringify({ success: true, data: supplier() }), { status: 200 }),
      new Response(JSON.stringify({ error: 404, code: 'SUPPLIER_NOT_FOUND', message: 'No supplier was created with this key' }), { status: 404 }),
    ];
    const { client, calls } = recorder(() => answers.shift()!);
    const api = pharmacySuppliersApi(client);
    expect(await api.create({ displayName: 'Sun' }, KEY)).toEqual({ supplier: supplier(), replayed: true });
    expect(await api.createdByKey(KEY)).toEqual(supplier());
    expect(await api.createdByKey(KEY)).toBeNull();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['POST /pharmacy-suppliers', `GET /pharmacy-suppliers/by-key/${KEY}`, `GET /pharmacy-suppliers/by-key/${KEY}`]);
    await expect(api.create({ displayName: 'Sun' }, 'x')).rejects.toThrow('Invalid request key');
    await expect(api.createdByKey('a/b')).rejects.toThrow('Invalid request key');
  });

  it('review: another 404 on by-key stays unknown; Q15 abandon answers abandoned or used with the supplier', async () => {
    const answers = [
      new Response(JSON.stringify({ error: 404, code: 'NOT_FOUND', message: 'Not found' }), { status: 404 }),
      new Response(JSON.stringify({ success: true, data: { state: 'used', supplier: supplier() } }), { status: 200 }),
    ];
    const { client, calls } = recorder(() => answers.shift()!);
    const api = pharmacySuppliersApi(client);
    await expect(api.createdByKey(KEY)).rejects.toThrow('Not found');
    expect(await api.abandonCreate(KEY)).toEqual({ state: 'used', supplier: supplier() });
    expect(calls[1]).toMatchObject({ method: 'POST', url: `/pharmacy-suppliers/by-key/${KEY}/abandon` });
    expect(() => api.abandonCreate('../x')).toThrow('Invalid request key');
  });
});
