import { ApiError, type ApiClient, type Page } from './client.ts';
import { normalizeEmail } from './auth.ts';

/**
 * WQ10b admin: pharmacy accounts (`/api/v1/pharmacies`, backend `src1/modules/pharmacies`). Owner decision (19 Nov
 * 2026): only admins create pharmacies (`POST /` is `requireAdmin`). Admins read every pharmacy in full (`getAll` /
 * `getById` skip the public view for admins), edit any field (`PUT /:id`, `updatePharmacySchema`; this is also the
 * support path for a pharmacy's sign-in mobile number and email, which its own profile edit leaves out), and archive
 * (`DELETE /:id`: `isActive: false` + `archivedAt`). The workspace deactivates with `isActive` instead of archiving.
 *
 * Q15: the create takes a `requestKey` (exactly once per admin and key; a repeat answers 200 `replayed: true`), with
 * `GET /by-key/:key` and `POST /by-key/:key/abandon`; the admin list filters by exact mobile number (`phone`); the edit
 * takes `expectedUpdatedAt` (409 RECORD_CHANGED) and clears an optional field sent as null (`phone` and `name` cannot be
 * cleared); a changed sign-in mobile number, or a changed or removed email, signs the pharmacy out (its sessions end).
 * Q15 review: EMAIL_ALREADY_EXISTS is 409 (older servers answered 400; both are handled); latitude and longitude are
 * cleared together (the workspace does not edit them); a keyed create can be 503 INDEXES_OUTDATED (kept, sent later).
 */

export interface PharmacyAccount {
  _id: string;
  name: string;
  nickname?: string;
  ownerName?: string;
  /** The sign-in mobile number (10 digits; unique among pharmacies). */
  phone: string;
  /** An optional sign-in email (stored lower-case). */
  email?: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
  gstNumber?: string;
  drugLicenseNumber?: string;
  pharmacist?: { name: string; registrationNumber: string; updatedAt?: string };
  pickupAvailable?: boolean;
  deliveryAvailable?: boolean;
  isVerified?: boolean;
  isActive?: boolean;
  archivedAt?: string;
  archiveReason?: string;
  walletEnabled?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** `pharmacyQuerySchema` (the admin list): `name` matches part of the name, any case. */
export interface PharmacyQuery {
  name?: string;
  /** Q15 (admins): the exact 10-digit mobile number. */
  phone?: string;
  isVerified?: 'true' | 'false';
  isActive?: 'true' | 'false';
  page?: number;
}

/** The details an admin types (`createPharmacySchema`; only `name` and `phone` are required). */
export interface PharmacyDetails {
  name: string;
  nickname?: string;
  ownerName?: string;
  phone: string;
  email?: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
  gstNumber?: string;
  drugLicenseNumber?: string;
  pickupAvailable?: boolean;
  deliveryAvailable?: boolean;
}
export type NewPharmacy = PharmacyDetails;
/** Optional fields an edit may clear by sending null (Q15 `updatePharmacySchema`); `phone` and `name` cannot be cleared. */
export type ClearablePharmacyField = 'nickname' | 'ownerName' | 'email' | 'address' | 'city' | 'state' | 'pincode' | 'gstNumber' | 'drugLicenseNumber';
/** `updatePharmacySchema` (the fields the workspace changes; at least one). null clears an optional field. */
export type PharmacyUpdate = Partial<Omit<PharmacyDetails, ClearablePharmacyField>>
  & { [K in ClearablePharmacyField]?: string | null }
  & { isVerified?: boolean; isActive?: boolean };

export const PHARMACY_PHONE_PATTERN = /^[0-9]{10}$/;
export const PHARMACY_PINCODE_PATTERN = /^\d{6}$/;
export const MAX_PHARMACY_NAME = 200;
export const MAX_PHARMACY_NICKNAME = 100;
export const MAX_PHARMACY_OWNER = 200;
export const MAX_GST_NUMBER = 50;
export const MAX_DRUG_LICENSE = 100;
export const PHARMACY_PAGE_SIZE = 20;

/** The form's text fields (every one a string; '' = not given). */
export interface PharmacyForm {
  name: string; nickname: string; ownerName: string; phone: string; email: string; address: string; city: string; state: string;
  pincode: string; gstNumber: string; drugLicenseNumber: string; pickupAvailable: boolean; deliveryAvailable: boolean;
}
export const EMPTY_PHARMACY_FORM: PharmacyForm = {
  name: '', nickname: '', ownerName: '', phone: '', email: '', address: '', city: '', state: '', pincode: '', gstNumber: '',
  drugLicenseNumber: '', pickupAvailable: false, deliveryAvailable: false,
};

/** A pharmacy as the edit form shows it. */
export const pharmacyForm = (p: PharmacyAccount): PharmacyForm => ({
  name: p.name ?? '', nickname: p.nickname ?? '', ownerName: p.ownerName ?? '', phone: p.phone ?? '', email: p.email ?? '',
  address: p.address ?? '', city: p.city ?? '', state: p.state ?? '', pincode: p.pincode ?? '', gstNumber: p.gstNumber ?? '',
  drugLicenseNumber: p.drugLicenseNumber ?? '', pickupAvailable: p.pickupAvailable === true, deliveryAvailable: p.deliveryAvailable === true,
});

type FieldErrors = Partial<Record<keyof PharmacyForm, string>>;
const OPTIONAL_TEXT: readonly (keyof PharmacyForm)[] = ['nickname', 'ownerName', 'address', 'city', 'state', 'gstNumber', 'drugLicenseNumber'];

/**
 * Checks the given fields as `createPharmacySchema` / `updatePharmacySchema` do and builds what is sent (trimmed; the
 * email normalised, lower-case). `fields` are the fields to check and send (all for a create, the changed ones for an
 * update). `existing` (an update): an emptied optional field the server holds is sent as null, which clears it (Q15);
 * the name and the mobile number cannot be cleared.
 */
export function pharmacyBody(f: PharmacyForm, fields: readonly (keyof PharmacyForm)[], existing?: PharmacyAccount): { body: PharmacyUpdate; errors: FieldErrors } {
  const e: FieldErrors = {};
  const body: PharmacyUpdate = {};
  const want = new Set(fields);
  const t = (k: keyof PharmacyForm) => String(f[k]).trim();
  if (want.has('name')) {
    if (!t('name')) e.name = existing ? 'The name cannot be removed. Enter the new name.' : 'Enter the pharmacy’s name.';
    else if (t('name').length > MAX_PHARMACY_NAME) e.name = `Use at most ${MAX_PHARMACY_NAME} characters.`;
    else body.name = t('name');
  }
  if (want.has('phone')) {
    if (existing && !f.phone.trim()) e.phone = 'The mobile number cannot be removed: the pharmacy signs in with it. Enter the new number.';
    else if (!PHARMACY_PHONE_PATTERN.test(f.phone)) e.phone = 'Enter the 10-digit mobile number.';
    else body.phone = f.phone;
  }
  if (want.has('email')) {
    if (t('email')) {
      const email = normalizeEmail(f.email);
      if (!email) e.email = 'Enter a valid email address.';
      else body.email = email;
    } else if (existing?.email) body.email = null;
  }
  if (want.has('pincode')) {
    if (t('pincode') && !PHARMACY_PINCODE_PATTERN.test(t('pincode'))) e.pincode = 'Enter the 6-digit PIN code.';
    else if (t('pincode')) body.pincode = t('pincode');
    else if (existing?.pincode) body.pincode = null;
  }
  const limits: Partial<Record<keyof PharmacyForm, number>> = {
    nickname: MAX_PHARMACY_NICKNAME, ownerName: MAX_PHARMACY_OWNER, gstNumber: MAX_GST_NUMBER, drugLicenseNumber: MAX_DRUG_LICENSE,
  };
  for (const k of OPTIONAL_TEXT) {
    if (!want.has(k)) continue;
    const v = t(k);
    const max = limits[k];
    if (max && v.length > max) e[k] = `Use at most ${max} characters.`;
    else if (v) (body as Record<string, unknown>)[k] = v;
    else if (existing?.[k as keyof PharmacyAccount]) (body as Record<string, unknown>)[k] = null;
  }
  if (want.has('pickupAvailable')) body.pickupAvailable = f.pickupAvailable;
  if (want.has('deliveryAvailable')) body.deliveryAvailable = f.deliveryAvailable;
  return { body, errors: e };
}

/** The fields a create sends. */
export const PHARMACY_FIELDS: readonly (keyof PharmacyForm)[] = Object.keys(EMPTY_PHARMACY_FORM) as (keyof PharmacyForm)[];

/** 400 PHONE_ALREADY_EXISTS (create or update): another pharmacy signs in with this mobile number. */
export const isPharmacyPhoneTaken = (err: unknown) => err instanceof ApiError && err.code === 'PHONE_ALREADY_EXISTS';
/** EMAIL_ALREADY_EXISTS (409 since the Q15 re-review; 400 before it, still accepted): another pharmacy uses this email. */
export const isPharmacyEmailTaken = (err: unknown) => err instanceof ApiError && err.code === 'EMAIL_ALREADY_EXISTS';

/**
 * Whether saving `body` over `p` ends the pharmacy's sessions (Q15 `update`): a changed mobile number, or a changed or
 * removed email it already had. Adding a first email ends nothing.
 */
export const signsPharmacyOut = (p: Pick<PharmacyAccount, 'phone' | 'email'>, body: PharmacyUpdate) =>
  (body.phone !== undefined && body.phone !== p.phone) || (!!p.email && body.email !== undefined && body.email !== p.email);

/** Whether the record holds every value in `body` (null = the field is absent): a lost save is settled by a re-read. */
export const pharmacyHolds = (p: PharmacyAccount, body: PharmacyUpdate) =>
  Object.entries(body).every(([k, v]) => {
    const cur = (p as unknown as Record<string, unknown>)[k];
    if (v === null) return cur === undefined || cur === null || cur === '';
    if (k === 'pickupAvailable' || k === 'deliveryAvailable' || k === 'isVerified') return (cur === true) === v;
    if (k === 'isActive') return (cur !== false) === v;
    return cur === v;
  });

/** Q15: the admin's create key (`createPharmacySchema.requestKey`). */
export const PHARMACY_REQUEST_KEY_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;
const checkKey = (key: string) => {
  if (!PHARMACY_REQUEST_KEY_PATTERN.test(key)) throw new Error('Invalid request key');
  return key;
};

/** Verification and active state in words. */
export function pharmacyState(p: Pick<PharmacyAccount, 'isVerified' | 'isActive'>): { verified: boolean; active: boolean } {
  return { verified: p.isVerified === true, active: p.isActive !== false };
}

function checkId(id: string): string {
  if (!/^[0-9a-fA-F]{24}$/.test(id)) throw new Error('Invalid pharmacy id');
  return id;
}

export function pharmacyAdminApi(c: ApiClient) {
  return {
    /** Newest first, 20 a page (`findWithPagination`). */
    list: (q: PharmacyQuery = {}): Promise<Page<PharmacyAccount>> => {
      const name = q.name?.trim();
      if (q.phone !== undefined && !PHARMACY_PHONE_PATTERN.test(q.phone)) throw new Error('Invalid mobile number');
      return c.page<PharmacyAccount>('/pharmacies', { query: {
        ...(name ? { name } : {}), ...(q.phone ? { phone: q.phone } : {}), isVerified: q.isVerified, isActive: q.isActive,
        page: q.page ?? 1, limit: PHARMACY_PAGE_SIZE,
      } });
    },
    get: (id: string) => c.get<PharmacyAccount>(`/pharmacies/${checkId(id)}`),
    /**
     * `POST /pharmacies` (admin only), Q15: exactly once per (admin, `requestKey`). The same key and details again answer
     * 200 with the pharmacy it made (`replayed`); other details under the key 409 REQUEST_KEY_REUSED; a key given up 409
     * REQUEST_ABANDONED. The mobile number stays unique (400 PHONE_ALREADY_EXISTS).
     */
    create: async (body: NewPharmacy, requestKey: string): Promise<{ pharmacy: PharmacyAccount; replayed: boolean }> => {
      const r = await c.postKeyed<PharmacyAccount>('/pharmacies', { body: { ...body, requestKey: checkKey(requestKey) } });
      return { pharmacy: r.data, replayed: r.replayed };
    },
    /** Q15 `GET /pharmacies/by-key/:key`: what this admin's key made; null on 404 PHARMACY_NOT_FOUND (nothing so far). */
    createdByKey: async (key: string): Promise<PharmacyAccount | null> => {
      try {
        return await c.get<PharmacyAccount>(`/pharmacies/by-key/${checkKey(key)}`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404 && err.code === 'PHARMACY_NOT_FOUND') return null;
        throw err;
      }
    },
    /** Q15 `POST /pharmacies/by-key/:key/abandon`: 'abandoned' = this key can never make a pharmacy; 'used' = it did. */
    abandonCreate: (key: string) =>
      c.post<{ state: 'abandoned' | 'used'; pharmacy?: PharmacyAccount | null }>(`/pharmacies/by-key/${checkKey(key)}/abandon`, { body: {} }),
    /**
     * `PUT /pharmacies/:id` (admin only): only the fields given (null clears an optional one). Q15: `version` is the
     * `updatedAt` the change was decided on; the server refuses it 409 RECORD_CHANGED when the pharmacy moved since.
     */
    update: (id: string, body: PharmacyUpdate, version?: string) =>
      c.put<PharmacyAccount>(`/pharmacies/${checkId(id)}`, { body: { ...body, ...(version ? { expectedUpdatedAt: version } : {}) } }),
    /** Q15: the pharmacy that signs in with this mobile number (the admin list's exact `phone` filter), or null. */
    findByPhone: async (phone: string): Promise<PharmacyAccount | null> => {
      if (!PHARMACY_PHONE_PATTERN.test(phone)) throw new Error('Invalid mobile number');
      const p = await c.page<PharmacyAccount>('/pharmacies', { query: { phone, page: 1, limit: 1 } });
      return p.items.find((x) => x.phone === phone) ?? null;
    },
  };
}
