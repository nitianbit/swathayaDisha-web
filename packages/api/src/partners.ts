import { ApiError, type ApiClient, type Page } from './client.ts';
import { normalizeEmail } from './auth.ts';

/**
 * Q1 partner workspace (labs and clinics): the partner account, its members (staff) and branches, and the activity
 * log. Typed from the backend's `src1/modules/partners/{types,validation}/index.ts`. The same workspace routes serve a
 * partner's own members (`/partner-workspace/*`) and platform admins acting with owner authority on any partner
 * (`/partner-workspace/admin/:partnerId/workspace/*`, `registerWorkspaceRoutes` in `partners/routes/index.ts`).
 */

export type PartnerKind = 'lab' | 'clinic';
export type TaxRegime = 'regular' | 'composition' | 'unregistered';
export type VerificationState = 'pending' | 'verified' | 'suspended';
export type MemberRole = 'owner' | 'staff';

export type PartnerPermission =
  | 'staff.manage'
  | 'branches.manage'
  | 'catalogue.manage'
  | 'slots.manage'
  | 'bookings.view'
  | 'bookings.manage'
  | 'reports.upload'
  | 'reports.release'
  | 'invoices.create'
  | 'invoices.cancel'
  | 'payments.record'
  | 'finance.view';

/** Backend `ALL_PERMISSIONS`, in its order, with the words shown to people. */
export const PARTNER_PERMISSIONS: readonly { value: PartnerPermission; label: string }[] = [
  { value: 'staff.manage', label: 'Manage staff' },
  { value: 'branches.manage', label: 'Manage branches' },
  { value: 'catalogue.manage', label: 'Manage tests and services' },
  { value: 'slots.manage', label: 'Manage slots' },
  { value: 'bookings.view', label: 'View bookings' },
  { value: 'bookings.manage', label: 'Manage bookings' },
  { value: 'reports.upload', label: 'Upload reports' },
  { value: 'reports.release', label: 'Release reports' },
  { value: 'invoices.create', label: 'Create invoices' },
  { value: 'invoices.cancel', label: 'Cancel invoices' },
  { value: 'payments.record', label: 'Record payments' },
  { value: 'finance.view', label: 'View finance' },
];
export const ALL_PARTNER_PERMISSIONS: readonly PartnerPermission[] = PARTNER_PERMISSIONS.map((p) => p.value);
export const PERMISSION_LABEL: Record<PartnerPermission, string> =
  Object.fromEntries(PARTNER_PERMISSIONS.map((p) => [p.value, p.label])) as Record<PartnerPermission, string>;
export const PARTNER_KIND_LABEL: Record<PartnerKind, string> = { lab: 'Lab', clinic: 'Clinic' };
export const VERIFICATION_LABEL: Record<VerificationState, string> = { pending: 'Waiting for verification', verified: 'Verified', suspended: 'Suspended' };
export const TAX_REGIME_LABEL: Record<TaxRegime, string> = { regular: 'GST regular', composition: 'GST composition', unregistered: 'Not GST-registered' };

/** Backend validation patterns (`partners/validation/index.ts`). */
export const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;
export const PARTNER_PHONE_PATTERN = /^[0-9]{10}$/;
export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const INVOICE_PREFIX_PATTERN = /^[A-Z0-9]{1,6}$/;
export const HHMM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** A pragmatic check for Joi `string().email()`; the server's own answer still decides. */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MAX_NAME = 200;
/** `holidays` is capped at 400 dates. */
export const MAX_HOLIDAYS = 400;

export interface Partner {
  _id: string;
  kind: PartnerKind;
  name: string;
  legalName?: string;
  gstin?: string;
  pan?: string;
  contact: { phone: string; email?: string };
  logo?: string;
  verification: { state: VerificationState; documents?: string[]; verifiedAt?: string; verifiedBy?: string };
  taxRegime: TaxRegime;
  invoiceSeries: { prefix: string };
  activeOwnerCount: number;
  solo?: boolean;
  isActive: boolean;
  /**
   * Q14: the partner's own counter policy (default false): whether an in-house bill may be paid in several payments.
   * Off: a payment settles everything still due. Owners (and admins as owner) change it with `updateMe`.
   */
  allowPartPayments?: boolean;
  createdAt?: string;
  /** Q10: sent back as `expectedUpdatedAt` by an edit (409 RECORD_CHANGED when it moved). */
  updatedAt?: string;
}

export interface PartnerMember {
  _id: string;
  partnerId: string;
  phone: string;
  /** WQ9: an optional sign-in email (trimmed and lower-cased by the server; unique among the partner's active members). */
  email?: string;
  name: string;
  role: MemberRole;
  permissions: PartnerPermission[];
  /** Empty = every branch of the partner. */
  branchIds: string[];
  doctorId?: string;
  professional?: MemberProfessional;
  isActive: boolean;
  invitedBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Q11 `IMemberProfessional`: the registration a member signs reports under (`releaseReport` needs one on the signer,
 * else 409 SIGNER_REGISTRATION_MISSING).
 */
export type ProfessionalKind = 'pathologist' | 'pharmacist' | 'doctor';
export interface MemberProfessional { kind: ProfessionalKind; registrationNumber: string }
export const PROFESSIONAL_KINDS: readonly { value: ProfessionalKind; label: string }[] = [
  { value: 'pathologist', label: 'Pathologist' },
  { value: 'doctor', label: 'Doctor' },
  { value: 'pharmacist', label: 'Pharmacist' },
];
export const PROFESSIONAL_KIND_LABEL: Record<ProfessionalKind, string> =
  Object.fromEntries(PROFESSIONAL_KINDS.map((k) => [k.value, k.label])) as Record<ProfessionalKind, string>;
/** `memberProfessionalSchema.registrationNumber`: trimmed, 3 to 60 characters. */
export const MIN_REGISTRATION = 3;
export const MAX_REGISTRATION = 60;

/** Checks a registration as `memberProfessionalSchema` does; returns what is sent, or the problem in words. */
export function professionalInput(kind: string, registrationNumber: string): { value: MemberProfessional } | { problem: { kind?: string; registrationNumber?: string } } {
  const problem: { kind?: string; registrationNumber?: string } = {};
  const reg = registrationNumber.trim();
  if (!PROFESSIONAL_KINDS.some((k) => k.value === kind)) problem.kind = 'Choose what they are registered as.';
  if (reg.length < MIN_REGISTRATION || reg.length > MAX_REGISTRATION) problem.registrationNumber = `Enter the registration number (${MIN_REGISTRATION} to ${MAX_REGISTRATION} characters).`;
  return Object.keys(problem).length ? { problem } : { value: { kind: kind as ProfessionalKind, registrationNumber: reg } };
}

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export const WEEKDAYS: readonly { value: Weekday; label: string }[] = [
  { value: 'mon', label: 'Monday' }, { value: 'tue', label: 'Tuesday' }, { value: 'wed', label: 'Wednesday' },
  { value: 'thu', label: 'Thursday' }, { value: 'fri', label: 'Friday' }, { value: 'sat', label: 'Saturday' },
  { value: 'sun', label: 'Sunday' },
];
export type WeeklyHours = Partial<Record<Weekday, { open: string; close: string }>>;
export interface BranchServices { homeCollection: boolean; inLab: boolean; inClinic: boolean }
export interface BranchAddress { line1: string; line2?: string; city: string; state: string; stateCode: string; pincode: string }

export interface Branch {
  _id: string;
  partnerId: string;
  name: string;
  address: BranchAddress;
  phone: string;
  hours?: WeeklyHours;
  holidays?: string[];
  services?: Partial<BranchServices>;
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** `createBranchSchema` (geo is not edited here). */
export interface BranchInput {
  name: string;
  address: BranchAddress;
  phone: string;
  hours?: WeeklyHours;
  holidays?: string[];
  services?: Partial<BranchServices>;
}

export interface PartnerAuditEvent {
  _id: string;
  partnerId: string;
  actorKind: 'member' | 'admin';
  /** Member id, or the admin id for admin actions. */
  actorId: string;
  action: string;
  targetKind?: string;
  targetId?: string;
  detail?: Record<string, unknown>;
  at: string;
}

/** `addMemberSchema`. An owner's permissions and branches are fixed by the server (all of them). */
export interface NewMember {
  phone: string;
  /** WQ9 `addMemberSchema.email`: optional; 409 `EMAIL_IN_USE` when another active member already signs in with it. */
  email?: string;
  name: string;
  role: MemberRole;
  permissions: PartnerPermission[];
  branchIds?: string[];
}

/** `updateMyPartnerSchema` (a partner's own members, and admins through the workspace routes). */
export interface MyPartnerUpdate {
  name?: string; legalName?: string; contactPhone?: string; contactEmail?: string; logo?: string;
  /** Q14 `updateMyPartnerSchema.allowPartPayments`. */
  allowPartPayments?: boolean;
}
/** `updatePartnerSchema` (admins only). */
export interface PartnerUpdate extends MyPartnerUpdate { gstin?: string; pan?: string; taxRegime?: TaxRegime; invoiceSeriesPrefix?: string }
/** `createPartnerSchema`. */
export interface NewPartner {
  kind: PartnerKind;
  name: string;
  legalName?: string;
  gstin?: string;
  pan?: string;
  contactPhone: string;
  contactEmail?: string;
  taxRegime?: TaxRegime;
  invoiceSeriesPrefix: string;
  solo?: boolean;
  /** WQ9 `createPartnerSchema.firstOwner.email`: optional. */
  firstOwner: { phone: string; name: string; email?: string };
}
/** `partnerQuerySchema` (Q8: name search `q`, `page`, `limit` up to 200). */
export interface PartnerQuery {
  kind?: PartnerKind; verificationState?: VerificationState; isActive?: 'true' | 'false'; q?: string; page?: number; limit?: number;
}
/** Q8 `createPartnerSchema.requestKey`: exactly-once creation per admin. */
export const REQUEST_KEY_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;

/**
 * Q10 optimistic concurrency: the `updatedAt` of the record an edit started from. The server refuses the edit with 409
 * RECORD_CHANGED when the record moved since. Omitted when the record carries no `updatedAt`.
 */
export type Version = string | undefined;
const fence = (v: Version) => (v ? { expectedUpdatedAt: v } : {});

/** Whose workspace: the signed-in member's own partner, or (admins) any partner by id. */
export type PartnerScope = { kind: 'member' } | { kind: 'admin'; partnerId: string };

function checkId(id: string, what: string): string {
  if (!OBJECT_ID_PATTERN.test(id)) throw new Error(`Invalid ${what} id`);
  return id;
}

/** The workspace root for a scope; an id is checked before it is put in a path. */
export function partnerWorkspaceBase(scope: PartnerScope): string {
  return scope.kind === 'admin'
    ? `/partner-workspace/admin/${checkId(scope.partnerId, 'partner')}/workspace`
    : '/partner-workspace';
}

export function partnerWorkspaceApi(c: ApiClient, scope: PartnerScope) {
  const base = () => partnerWorkspaceBase(scope);
  return {
    me: () => c.get<Partner>(`${base()}/me`),
    updateMe: (body: MyPartnerUpdate, version?: Version) => c.put<Partner>(`${base()}/me`, { body: { ...body, ...fence(version) } }),
    members: () => c.get<PartnerMember[]>(`${base()}/members`),
    /** Q8: a staff member's branch access, replaced whole (empty = all branches). Not for owners or yourself. */
    setBranches: (id: string, branchIds: string[], version?: Version) =>
      c.put<PartnerMember>(`${base()}/members/${checkId(id, 'member')}/branches`, { body: { branchIds, ...fence(version) } }),
    member: (id: string) => c.get<PartnerMember>(`${base()}/members/${checkId(id, 'member')}`),
    addMember: (body: NewMember) => c.post<PartnerMember>(`${base()}/members`, { body }),
    removeMember: (id: string) => c.delete<unknown>(`${base()}/members/${checkId(id, 'member')}`),
    /**
     * WQ9 `PUT /members/:memberId/email` (`updateMemberEmailSchema`): sets (or, with null, removes) a member's sign-in
     * email, fenced like the other member edits (409 RECORD_CHANGED when it moved; 409 `EMAIL_IN_USE` when another active
     * member of the partner already signs in with it; 403 `OWNER_REQUIRED` for anyone but an owner).
     */
    setEmail: (id: string, email: string | null, version?: Version) =>
      c.put<PartnerMember>(`${base()}/members/${checkId(id, 'member')}/email`, { body: { email, ...fence(version) } }),
    /**
     * Q11 `PUT /members/:memberId/professional` (`memberProfessionalSchema`): sets (or, with null, removes) the registration
     * a member signs reports under. Owners only (403 `OWNER_REQUIRED`; admins act as owner); fenced like the other member
     * edits (409 RECORD_CHANGED). The route admits `staff.manage`, but `setMemberProfessional` refuses anyone but an owner.
     */
    setProfessional: (id: string, professional: MemberProfessional | null, version?: Version) =>
      c.put<PartnerMember>(`${base()}/members/${checkId(id, 'member')}/professional`, { body: { professional, ...fence(version) } }),
    setPermissions: (id: string, permissions: PartnerPermission[], version?: Version) =>
      c.put<PartnerMember>(`${base()}/members/${checkId(id, 'member')}/permissions`, { body: { permissions, ...fence(version) } }),
    /** Q8: every member may read its branches; closed ones too (`includeInactive`) only for branch managers. */
    branches: (o: { includeInactive?: boolean } = {}) =>
      c.get<Branch[]>(`${base()}/branches`, { query: { includeInactive: o.includeInactive ? 'true' : undefined } }),
    branch: (id: string) => c.get<Branch>(`${base()}/branches/${checkId(id, 'branch')}`),
    createBranch: (body: BranchInput) => c.post<Branch>(`${base()}/branches`, { body }),
    updateBranch: (id: string, body: Partial<BranchInput>, version?: Version) =>
      c.put<Branch>(`${base()}/branches/${checkId(id, 'branch')}`, { body: { ...body, ...fence(version) } }),
    deactivateBranch: (id: string) => c.delete<unknown>(`${base()}/branches/${checkId(id, 'branch')}`),
    /** Q8: reopens a closed branch (all-branch actors with `branches.manage`); 409 BRANCH_ALREADY_ACTIVE. */
    reactivateBranch: (id: string) => c.post<Branch>(`${base()}/branches/${checkId(id, 'branch')}/reactivate`, { body: {} }),
    /** The latest 100 events, newest first (partner-wide actors only). */
    audit: () => c.get<PartnerAuditEvent[]>(`${base()}/audit`),
  };
}

/** Platform admins: partner accounts (`/partner-workspace/admin`). */
export function partnerAdminApi(c: ApiClient) {
  const one = (id: string) => `/partner-workspace/admin/${checkId(id, 'partner')}`;
  return {
    /** Sorted by name, paged (Q8). */
    list: (q: PartnerQuery = {}): Promise<Page<Partner>> => c.page<Partner>('/partner-workspace/admin', { query: { ...q } }),
    /**
     * Q8: exactly once per (admin, requestKey): a resend with the same key and content answers the same partner; other
     * content under the key is refused (409 REQUEST_KEY_REUSED).
     */
    create: (body: NewPartner, requestKey: string) => {
      if (!REQUEST_KEY_PATTERN.test(requestKey)) throw new Error('Invalid request key');
      return c.post<{ partner: Partner; owner: PartnerMember }>('/partner-workspace/admin', { body: { requestKey, ...body } });
    },
    get: (id: string) => c.get<Partner>(one(id)),
    update: (id: string, body: PartnerUpdate, version?: Version) => c.put<Partner>(one(id), { body: { ...body, ...fence(version) } }),
    /**
     * Q10: what this admin's create key produced; null when nothing was created under it (404). Not finding it proves
     * nothing on its own (the request may still arrive): only `abandonCreate` settles that.
     */
    createdByKey: async (key: string): Promise<{ partner: Partner; owner: PartnerMember } | null> => {
      if (!REQUEST_KEY_PATTERN.test(key)) throw new Error('Invalid request key');
      try {
        return await c.get<{ partner: Partner; owner: PartnerMember }>(`/partner-workspace/admin/by-key/${key}`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
    /** Q10: 'abandoned' = this key can never create a partner; 'used' = it did (here it is). */
    abandonCreate: (key: string) => {
      if (!REQUEST_KEY_PATTERN.test(key)) throw new Error('Invalid request key');
      return c.post<{ state: 'abandoned' | 'used'; partner?: Partner }>(`/partner-workspace/admin/by-key/${key}/abandon`, { body: {} });
    },
    /** pending → verified only (409 VERIFICATION_STATE_CONFLICT otherwise). */
    verify: (id: string) => c.post<Partner>(`${one(id)}/verify`, { body: {} }),
    /** Any state but suspended → suspended and inactive (409 ALREADY_SUSPENDED). No endpoint reinstates a partner. */
    suspend: (id: string) => c.post<Partner>(`${one(id)}/suspend`, { body: {} }),
    /** Q8: suspended → verified and active again (409 NOT_SUSPENDED). */
    reinstate: (id: string) => c.post<Partner>(`${one(id)}/reinstate`, { body: {} }),
  };
}

/**
 * Who is acting, for the UI's mirror of the backend's rules (`partners/services/index.ts`). Admins act as an owner
 * with every permission and every branch (`adminActor`).
 */
export interface PartnerActorView {
  role: MemberRole;
  permissions: readonly PartnerPermission[];
  branchIds: readonly string[];
  /** Absent for an admin (an admin is never one of the members). */
  memberId?: string;
}

export const ADMIN_ACTOR: PartnerActorView = { role: 'owner', permissions: ALL_PARTNER_PERMISSIONS, branchIds: [] };

/** `hasGlobalScope`: owners, and staff with no branch restriction. */
export const hasGlobalScope = (a: Pick<PartnerActorView, 'role' | 'branchIds'>) => a.role === 'owner' || a.branchIds.length === 0;

/** Route guards: owners pass every permission check; staff need at least one of `anyOf`. */
export function holdsAny(a: Pick<PartnerActorView, 'role' | 'permissions'>, anyOf: readonly PartnerPermission[]): boolean {
  return a.role === 'owner' || anyOf.length === 0 || anyOf.some((p) => a.permissions.includes(p));
}

/** Delegation ceiling: an owner may grant anything; staff only what they hold. */
export function grantablePermissions(a: Pick<PartnerActorView, 'role' | 'permissions'>): PartnerPermission[] {
  return a.role === 'owner' ? [...ALL_PARTNER_PERMISSIONS] : ALL_PARTNER_PERMISSIONS.filter((p) => a.permissions.includes(p));
}

/** Q8: only owners (and admins) change the partner profile (`updateOwnProfile`). */
export const canEditProfile = (a: Pick<PartnerActorView, 'role'>) => a.role === 'owner';

/** Q8 `updateMemberBranches`: a staff member other than yourself (owners always cover every branch). */
export const canChangeBranches = (a: Pick<PartnerActorView, 'memberId'>, target: Pick<PartnerMember, '_id' | 'role' | 'isActive'>) =>
  target.role === 'staff' && target.isActive !== false && a.memberId !== target._id;

/** Q8 `reactivateBranch` / `includeInactive`: branch managers with partner-wide scope. */
export const canReopenBranches = (a: Pick<PartnerActorView, 'role' | 'permissions' | 'branchIds'>) =>
  hasGlobalScope(a) && holdsAny(a, ['branches.manage']);

/** Only owners add owners and change a staff member's permissions (owners' permissions are fixed). */
export const canAddOwner = (a: Pick<PartnerActorView, 'role'>) => a.role === 'owner';
/**
 * WQ9 `updateMemberEmail`: a sign-in identity, so like permissions only an owner (or an admin acting as owner) changes
 * it, for any active member including owners and themselves (`canGiveEmail` for a new member's).
 */
export const canEditEmail = (a: Pick<PartnerActorView, 'role'>, target: Pick<PartnerMember, 'isActive'>) =>
  a.role === 'owner' && target.isActive !== false;
/** Q11 `setMemberProfessional`: owners only (admins act as owner), for any active member including owners and themselves. */
export const canEditProfessional = (a: Pick<PartnerActorView, 'role'>, target: Pick<PartnerMember, 'isActive'>) =>
  a.role === 'owner' && target.isActive !== false;
/** WQ9 `addMember`: only an owner (or an admin as owner) gives a new member a sign-in email (403 `OWNER_REQUIRED`). */
export const canGiveEmail = (a: Pick<PartnerActorView, 'role'>) => a.role === 'owner';
export const isOwnerRequired = (err: unknown) => err instanceof ApiError && err.status === 403 && err.code === 'OWNER_REQUIRED';
/** WQ9: 409 `EMAIL_IN_USE`: another active member of this partner already signs in with this email. */
export const isEmailInUse = (err: unknown) => err instanceof ApiError && err.status === 409 && err.code === 'EMAIL_IN_USE';
export const EMAIL_IN_USE_MESSAGE = 'Another member of this workspace already signs in with this email. Use a different email.';
/** WQ9: an optional email as sent (`normalizeEmail`: trimmed, lower-cased, ASCII domain); '' when left empty; null when invalid. */
export function memberEmail(raw: string): string | null {
  return raw.trim() ? normalizeEmail(raw) : '';
}
export const canEditPermissions = (a: Pick<PartnerActorView, 'role'>, target: Pick<PartnerMember, 'role' | 'isActive'>) =>
  a.role === 'owner' && target.role === 'staff' && target.isActive !== false;

/** Why a member cannot be removed by this actor, or null (the server still decides; `removeMember`). */
export function removalBlock(a: PartnerActorView, target: Pick<PartnerMember, '_id' | 'role'>, activeOwnerCount: number | undefined): string | null {
  if (a.memberId && a.memberId === target._id) return 'You cannot remove yourself.';
  if (target.role === 'owner' && a.role !== 'owner') return 'Only an owner can remove an owner.';
  if (target.role === 'owner' && activeOwnerCount !== undefined && activeOwnerCount <= 1) return 'The last owner cannot be removed.';
  return null;
}

/**
 * `assertScopeWithin`: the branch scope this actor may hand out. A partner-wide actor may give all branches (empty) or
 * any set; a branch-restricted actor only a non-empty subset of its own branches.
 */
export function scopeProblem(a: Pick<PartnerActorView, 'role' | 'branchIds'>, target: readonly string[]): string | null {
  if (hasGlobalScope(a)) return null;
  if (target.length === 0) return 'Choose at least one of your branches.';
  if (target.some((b) => !a.branchIds.includes(b))) return 'You can only give access to your own branches.';
  return null;
}
