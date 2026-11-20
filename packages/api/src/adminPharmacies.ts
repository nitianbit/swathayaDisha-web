import { ApiError, type ApiClient, type Page } from './client.ts';
import { normalizeEmail } from './auth.ts';

/**
 * WQ10b admin: pharmacy accounts (`/api/v1/pharmacies`, backend `src1/modules/pharmacies`). Owner decision (19 Nov
 * 2026): only admins create pharmacies (`POST /` is `requireAdmin`). Admins read every pharmacy in full (`getAll` /
 * `getById` skip the public view for admins), edit any field (`PUT /:id`, `updatePharmacySchema`; this is also the
 * support path for a pharmacy's sign-in mobile number and email, which its own profile edit leaves out), and archive
 * (`DELETE /:id`: `isActive: false` + `archivedAt`). The workspace deactivates with `isActive` instead of archiving.
 *
 * Not in the backend (so not here): a request key on create, a version fence (`expectedUpdatedAt`) on update, a way to
 * clear an optional field (every string must be non-empty), a filter by mobile number.
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
/** `updatePharmacySchema` (the fields the workspace changes; at least one). */
export type PharmacyUpdate = Partial<PharmacyDetails> & { isVerified?: boolean; isActive?: boolean };

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
 * update). `existing`: an update cannot clear a field the server holds (the schema refuses empty strings).
 */
export function pharmacyBody(f: PharmacyForm, fields: readonly (keyof PharmacyForm)[], existing?: PharmacyAccount): { body: PharmacyUpdate; errors: FieldErrors } {
  const e: FieldErrors = {};
  const body: PharmacyUpdate = {};
  const want = new Set(fields);
  const t = (k: keyof PharmacyForm) => String(f[k]).trim();
  if (want.has('name')) {
    if (!t('name')) e.name = 'Enter the pharmacy’s name.';
    else if (t('name').length > MAX_PHARMACY_NAME) e.name = `Use at most ${MAX_PHARMACY_NAME} characters.`;
    else body.name = t('name');
  }
  if (want.has('phone')) {
    if (!PHARMACY_PHONE_PATTERN.test(f.phone)) e.phone = 'Enter the 10-digit mobile number.';
    else body.phone = f.phone;
  }
  if (want.has('email')) {
    if (t('email')) {
      const email = normalizeEmail(f.email);
      if (!email) e.email = 'Enter a valid email address.';
      else body.email = email;
    } else if (existing?.email) e.email = 'An email cannot be removed. Enter a new one, or leave it as it is.';
  }
  if (want.has('pincode')) {
    if (t('pincode') && !PHARMACY_PINCODE_PATTERN.test(t('pincode'))) e.pincode = 'Enter the 6-digit PIN code.';
    else if (t('pincode')) body.pincode = t('pincode');
    else if (existing?.pincode) e.pincode = 'A PIN code cannot be removed. Enter a new one.';
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
    else if (existing?.[k as keyof PharmacyAccount]) e[k] = 'This cannot be removed here. Enter a new value, or leave it as it is.';
  }
  if (want.has('pickupAvailable')) body.pickupAvailable = f.pickupAvailable;
  if (want.has('deliveryAvailable')) body.deliveryAvailable = f.deliveryAvailable;
  return { body, errors: e };
}

/** The fields a create sends. */
export const PHARMACY_FIELDS: readonly (keyof PharmacyForm)[] = Object.keys(EMPTY_PHARMACY_FORM) as (keyof PharmacyForm)[];

/** 400 PHONE_ALREADY_EXISTS (create or update): another pharmacy signs in with this mobile number. */
export const isPharmacyPhoneTaken = (err: unknown) => err instanceof ApiError && err.code === 'PHONE_ALREADY_EXISTS';
/** 400 EMAIL_ALREADY_EXISTS (create or update): another pharmacy uses this email. */
export const isPharmacyEmailTaken = (err: unknown) => err instanceof ApiError && err.code === 'EMAIL_ALREADY_EXISTS';

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
      return c.page<PharmacyAccount>('/pharmacies', { query: {
        ...(name ? { name } : {}), isVerified: q.isVerified, isActive: q.isActive, page: q.page ?? 1, limit: PHARMACY_PAGE_SIZE,
      } });
    },
    get: (id: string) => c.get<PharmacyAccount>(`/pharmacies/${checkId(id)}`),
    /**
     * `POST /pharmacies` (admin only). No request key: a resend is a new request. The mobile number is unique among
     * pharmacies (unique index), so a resend can never create a second pharmacy with the same number: it is refused 400
     * PHONE_ALREADY_EXISTS once the first one exists.
     */
    create: (body: NewPharmacy) => c.post<PharmacyAccount>('/pharmacies', { body }),
    /** `PUT /pharmacies/:id` (admin only): only the fields given. No version fence on the server. */
    update: (id: string, body: PharmacyUpdate) => c.put<PharmacyAccount>(`/pharmacies/${checkId(id)}`, { body }),
    /**
     * After an unconfirmed create: the pharmacy with this mobile number among those created since `since` (ms; an hour
     * of margin for clocks), reading the newest first, 100 a page, at most `maxPages`. There is no filter by number, so
     * the list is read; not finding it proves only that it is not there yet.
     */
    findByPhone: async (phone: string, since: number, maxPages = 10): Promise<PharmacyAccount | null> => {
      if (!PHARMACY_PHONE_PATTERN.test(phone)) throw new Error('Invalid mobile number');
      const before = since - 60 * 60_000;
      for (let page = 1; page <= maxPages; page++) {
        const p = await c.page<PharmacyAccount>('/pharmacies', { query: { page, limit: 100, sortBy: 'createdAt', sortOrder: 'desc' } });
        const hit = p.items.find((x) => x.phone === phone);
        if (hit) return hit;
        const oldest = p.items[p.items.length - 1];
        if (page >= p.totalPages || p.items.length === 0 || (oldest?.createdAt && Date.parse(oldest.createdAt) < before)) break;
      }
      return null;
    },
  };
}
