import { ApiError, type ApiClient, type Page } from './client.ts';
import { EMAIL_PATTERN } from './partners.ts';

/**
 * WQ10a: a pharmacy's suppliers. Mirrors src1/modules/pharmacySuppliers (types SupplierDto/SUPPLIER_TEXT_LIMITS,
 * validation normalizeSupplierCommand/fieldsSchema, repository create/update/archive/list), mounted at
 * /api/v1/pharmacy-suppliers for operational pharmacies (`requireOperationalPharmacy`).
 * Q15: the create takes a `requestKey` (exactly once per pharmacy and key; the same key and fields again answer 200
 * `replayed: true`), and `GET /by-key/:key` returns the supplier a key made (404 SUPPLIER_NOT_FOUND = nothing so far).
 */
export const SUPPLIER_FIELDS = ['displayName', 'contactName', 'phone', 'email', 'address'] as const;
export type SupplierField = (typeof SUPPLIER_FIELDS)[number];
export const SUPPLIER_LIMITS: Readonly<Record<SupplierField, number>> = { displayName: 120, contactName: 120, phone: 32, email: 254, address: 500 };
/** fieldsSchema.phone */
export const SUPPLIER_PHONE_PATTERN = /^[+0-9(). -]+$/;
export const SUPPLIER_FIELD_LABEL: Readonly<Record<SupplierField, string>> = {
  displayName: 'Supplier name', contactName: 'Contact person', phone: 'Phone', email: 'Email', address: 'Address',
};
/** Q15 `PHARMACY_REQUEST_KEY`. */
export const SUPPLIER_REQUEST_KEY_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;
/** listQuery `limit` maximum. */
export const SUPPLIERS_PAGE_MAX = 50;

export type SupplierState = 'active' | 'archived';

/** SupplierDto. `revision` fences every change (`expectedRevision`). */
export interface PharmacySupplier {
  supplierId: string;
  displayName: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  state: SupplierState;
  revision: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

/** What the form holds: every field as typed. */
export type SupplierDraft = Record<SupplierField, string>;
export type SupplierFields = { displayName: string } & Partial<Record<Exclude<SupplierField, 'displayName'>, string | null>>;

export const draftOfSupplier = (s?: PharmacySupplier): SupplierDraft => ({
  displayName: s?.displayName ?? '', contactName: s?.contactName ?? '', phone: s?.phone ?? '', email: s?.email ?? '', address: s?.address ?? '',
});

/** The server's checks (trimmed; empty optional fields become null), so the form can say what is wrong before sending. */
export function supplierProblems(d: SupplierDraft): Partial<Record<SupplierField, string>> {
  const e: Partial<Record<SupplierField, string>> = {};
  for (const f of SUPPLIER_FIELDS) {
    const v = d[f].trim();
    if (f === 'displayName' && !v) e[f] = 'Enter the supplier’s name.';
    else if (v.length > SUPPLIER_LIMITS[f]) e[f] = `At most ${SUPPLIER_LIMITS[f]} characters.`;
  }
  const phone = d.phone.trim();
  if (!e.phone && phone && !SUPPLIER_PHONE_PATTERN.test(phone)) e.phone = 'Use digits, spaces and + ( ) . - only.';
  const email = d.email.trim();
  if (!e.email && email && !EMAIL_PATTERN.test(email)) e.email = 'Enter an email such as orders@distributor.in.';
  return e;
}

const clean = (f: SupplierField, v: string): string | null => {
  const t = v.trim();
  return f === 'displayName' || t ? t : null;
};

/** Create body: the name and only the optional fields that were filled (absent ones are stored as null). */
export function supplierCreateBody(d: SupplierDraft): SupplierFields {
  const body: Record<string, string> = {};
  for (const f of SUPPLIER_FIELDS) {
    const v = clean(f, d[f]);
    if (v !== null) body[f] = v;
  }
  return body as SupplierFields;
}

/** PATCH body: only the fields that differ from `base` (an emptied optional field is sent as null to clear it). */
export function supplierPatchBody(d: SupplierDraft, base: PharmacySupplier): Partial<SupplierFields> {
  const body: Record<string, string | null> = {};
  for (const f of SUPPLIER_FIELDS) {
    const v = clean(f, d[f]);
    if (v !== (base[f] ?? null)) body[f] = v;
  }
  return body as Partial<SupplierFields>;
}

/** Whether the supplier as saved has exactly these values (a lost save can be recognised on a re-read). */
export const supplierHas = (s: PharmacySupplier, fields: Partial<SupplierFields>) =>
  (Object.keys(fields) as SupplierField[]).every((f) => (s[f] ?? null) === (fields[f] ?? null));

/** 409 SUPPLIER_CONFLICT: the supplier's revision moved (or it was archived) since it was read. */
export const isSupplierConflict = (err: unknown) => err instanceof ApiError && err.status === 409 && err.code === 'SUPPLIER_CONFLICT';

/** isSupplierId: lower-case hex only. */
const supplierPath = (id: string) => {
  if (!/^[0-9a-f]{24}$/.test(id)) throw new Error('Invalid supplier id');
  return `/pharmacy-suppliers/${id}`;
};
const checkRevision = (r: number) => {
  if (!Number.isSafeInteger(r) || r < 1) throw new Error('Invalid supplier revision');
  return r;
};

export function pharmacySuppliersApi(c: ApiClient) {
  return {
    /** Oldest first (`_id` ascending); default state `active`. */
    list: (q: { state?: SupplierState | 'all'; page?: number; limit?: number } = {}): Promise<Page<PharmacySupplier>> =>
      c.page<PharmacySupplier>('/pharmacy-suppliers', { query: { ...q } }),
    /** Exactly once per `requestKey` (Q15): a repeat answers the supplier the key made (`replayed`), never a second one. */
    create: async (fields: SupplierFields, requestKey: string): Promise<{ supplier: PharmacySupplier; replayed: boolean }> => {
      if (!SUPPLIER_REQUEST_KEY_PATTERN.test(requestKey)) throw new Error('Invalid request key');
      const r = await c.postKeyed<PharmacySupplier>('/pharmacy-suppliers', { body: { ...fields, requestKey } });
      return { supplier: r.data, replayed: r.replayed };
    },
    /** Q15 `GET /pharmacy-suppliers/by-key/:key`: the supplier a key made (as it is now); null on 404 (nothing so far). */
    createdByKey: async (requestKey: string): Promise<PharmacySupplier | null> => {
      if (!SUPPLIER_REQUEST_KEY_PATTERN.test(requestKey)) throw new Error('Invalid request key');
      try {
        return await c.get<PharmacySupplier>(`/pharmacy-suppliers/by-key/${requestKey}`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
    /** 409 SUPPLIER_CONFLICT when the supplier is archived or its revision is no longer `expectedRevision`. */
    update: (id: string, fields: Partial<SupplierFields>, expectedRevision: number) =>
      c.patch<PharmacySupplier>(supplierPath(id), { body: { ...fields, expectedRevision: checkRevision(expectedRevision) } }),
    /** Archiving an archived supplier answers it unchanged; otherwise fenced like `update`. */
    archive: (id: string, expectedRevision: number) =>
      c.post<PharmacySupplier>(`${supplierPath(id)}/archive`, { body: { expectedRevision: checkRevision(expectedRevision) } }),
  };
}

/** Every supplier in `state` (all pages, bounded): the list is short, and lost changes are settled from it. */
export async function allSuppliers(c: ApiClient, state: SupplierState | 'all', maxPages = 20): Promise<PharmacySupplier[]> {
  const api = pharmacySuppliersApi(c);
  const out: PharmacySupplier[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const p = await api.list({ state, page, limit: SUPPLIERS_PAGE_MAX });
    out.push(...p.items);
    if (page >= p.totalPages || p.items.length === 0) break;
  }
  return out;
}
