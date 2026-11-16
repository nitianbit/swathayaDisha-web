import type { ApiClient } from './client.ts';
import { OBJECT_ID_PATTERN, partnerWorkspaceBase, REQUEST_KEY_PATTERN, type PartnerScope } from './partners.ts';
import { isRealDate, istDateOf } from './partnerLabs.ts';

/**
 * Q5 finance: settlement accounts (partners and doctors), the append-only ledger (statement with running balance, CSV),
 * payout destinations and admin-recorded payouts, voids and adjustments. Typed from the backend's
 * `src1/modules/partners/{model/settlement.ts,validation/finance.ts,services/finance.ts,controller/finance.ts}`.
 * Every amount is an integer number of PAISE (`...Minor`).
 *
 * Routes (`partners/routes/index.ts`):
 * - partner workspace, for members with `finance.view` AND partner-wide scope (`assertPartnerFinanceReader`), and for
 *   admins acting as owner: `GET /finance`, `/finance/statement`, `/finance/statement.csv`, `/finance/payouts`,
 *   `/finance/events`; `PUT /finance/payout-details` (owners only: `setPayoutDetails` refuses staff with OWNER_REQUIRED);
 * - admins (`/api/v1/settlements`, `settlementAdminRouter`): accounts, statements, payouts, history, events, payout
 *   details (edit, verify), record payout, adjustment, the payout queue and void.
 */

export type SettlementOwnerKind = 'partner' | 'doctor';
export type PayoutDetailsState = 'none' | 'unverified' | 'verified';
export type LedgerKind = 'earning' | 'reversal' | 'payout' | 'adjustment';
export type PayoutMethod = 'bank_transfer' | 'upi' | 'other';
export type PayoutState = 'recorded' | 'voided';

export const OWNER_KIND_LABEL: Record<SettlementOwnerKind, string> = { partner: 'Lab or clinic', doctor: 'Doctor' };
export const DETAILS_STATE_LABEL: Record<PayoutDetailsState, string> = {
  none: 'Not given', unverified: 'Waiting for verification', verified: 'Verified',
};
export const LEDGER_KIND_LABEL: Record<LedgerKind, string> = { earning: 'Earning', reversal: 'Reversal', payout: 'Payout', adjustment: 'Adjustment' };
export const PAYOUT_METHOD_LABEL: Record<PayoutMethod, string> = { bank_transfer: 'Bank transfer', upi: 'UPI', other: 'Other' };
export const PAYOUT_METHODS: readonly PayoutMethod[] = ['bank_transfer', 'upi', 'other'];
export const PAYOUT_STATE_LABEL: Record<PayoutState, string> = { recorded: 'Recorded', voided: 'Voided' };

/** `detailsView`: owners and doctors get the account number masked; admins (who make the transfer) get it in full. */
export type PayoutDetailsView =
  | { method: 'upi'; upiId: string; accountName?: string }
  | {
    method: 'bank'; accountName?: string; ifsc?: string; bankName?: string; accountNumberLast4?: string;
    /** Admins only. */
    accountNumber?: string;
    /** Everyone else: `XXXX` + the last four digits. */
    accountNumberMasked?: string;
  };

/** `accountView`. `financeVersion` is never returned (it serializes writes on the server only). */
export interface SettlementAccount {
  _id: string;
  ownerKind: SettlementOwnerKind;
  ownerId: string;
  beneficiaryName: string;
  isActive: boolean;
  payoutDetails: PayoutDetailsView | null;
  payoutDetailsState: PayoutDetailsState;
  /** Bumped by every destination change; a verification and a payout must name the version they were made for. */
  payoutDetailsVersion: number;
  payoutDetailsChangedAt?: string;
  payoutDetailsVerifiedAt?: string;
}

export interface FinanceTotals { earnedMinor: number; reversedMinor: number; paidOutMinor: number; adjustedMinor: number }

export interface SettlementPayout {
  _id: string;
  settlementAccountId: string;
  amountMinor: number;
  method: PayoutMethod;
  /** Bank UTR / UPI reference; unique per account among recorded payouts. */
  reference: string;
  /** India date the money was sent, YYYY-MM-DD. */
  paidOn: string;
  note?: string;
  /** Where it was sent (masked label) and the verified details version the admin named. */
  destination: { method: 'bank' | 'upi'; label: string; detailsVersion: number };
  state: PayoutState;
  voidReason?: string;
  voidedAt?: string;
  voidedBy?: string;
  by: string;
  createdAt?: string;
  updatedAt?: string;
}

/** `financeSummary`: `account` is null when the owner has no settlement account yet (reading never creates one). */
export interface FinanceSummary {
  account: SettlementAccount | null;
  balanceMinor: number;
  totals: FinanceTotals;
  lastPayout: SettlementPayout | null;
}

export interface StatementLine {
  _id: string;
  at: string;
  kind: LedgerKind;
  /** e.g. `partner_lab_booking`, `consultation`, `payout`, `payout_void`, `admin_adjustment`. */
  source: string;
  /** For `admin_adjustment`: `<adminId>:<requestKey>`. */
  sourceId: string;
  description: string;
  reference?: string;
  note?: string;
  /** Signed paise. */
  amountMinor: number;
  /** The account balance right after this line (over every entry, whatever the date filter). */
  balanceAfterMinor: number;
}
/** Newest first; `nextCursor` (`<ms>_<entryId>`) reads further back. */
export interface StatementPage { lines: StatementLine[]; nextCursor: string | null }

export interface LedgerEntry {
  _id: string; settlementAccountId: string; kind: LedgerKind; amountMinor: number; grossMinor: number; commissionMinor: number;
  source: string; sourceId: string; reference?: string; note?: string; at: string; by: string; byKind: 'system' | 'admin';
}

export interface FinanceEvent {
  _id: string;
  settlementAccountId: string;
  /** `finance.payout_details_changed`, `finance.payout_details_verified`, `finance.payout_recorded`, `finance.payout_voided`, `finance.adjustment_posted`. */
  action: string;
  byKind: 'admin' | 'member' | 'doctor';
  by: string;
  detail?: Record<string, unknown>;
  at: string;
}

/** §7a legacy history: shown for context, never part of the balance. */
export interface HistoryRef {
  _id: string; settlementAccountId: string; source: 'legacy_import'; legacyKind: 'billing' | 'disbursal'; legacyId: string;
  periodLabel?: string; amountMinor: number; at: string;
}

export interface AccountRow extends SettlementAccount { balanceMinor: number }
/** `adminListAccounts`: `total` matching accounts, `totalDueMinor` = Σ positive balances over ALL of them (not just the page). */
export interface AccountsPage { total: number; totalDueMinor: number; rows: AccountRow[] }

/** `accountsQuerySchema`. Sorted by balance (largest first), then name. */
export interface AccountsQuery {
  ownerKind?: SettlementOwnerKind; due?: boolean; search?: string; detailsState?: PayoutDetailsState; limit?: number; skip?: number;
}
/** `payoutsQuerySchema`. `from`/`to` filter `paidOn`. Newest paid first; no paging beyond `limit` (≤ 500). */
export interface PayoutsQuery { accountId?: string; from?: string; to?: string; state?: PayoutState; limit?: number }
/** `statementQuerySchema` (`from`/`to` are India calendar dates). */
export interface StatementQuery { before?: string; limit?: number; from?: string; to?: string }
export interface PeriodQuery { from?: string; to?: string }

/** `payoutDetailsSchema` (normalized as `normalizeDetails` does). */
export type PayoutDetailsInput =
  | { method: 'bank'; accountName: string; accountNumber: string; ifsc: string; bankName?: string }
  | { method: 'upi'; upiId: string; accountName?: string };

/** `recordPayoutSchema`. */
export interface RecordPayoutInput {
  amountMinor: number; method: PayoutMethod; reference: string; paidOn: string; note?: string; detailsVersion: number; requestKey: string;
}
/** `adjustmentSchema`: signed (+ credit, − recovery). */
export interface AdjustmentInput { amountMinor: number; reason: string; requestKey: string }

// ── Limits and rules (mirrors of validation/finance.ts and services/finance.ts) ──

/** `MAX_MINOR` (₹1,00,00,00,000): the largest payout or adjustment. */
export const MAX_FINANCE_MINOR = 1_000_000_000_00;
export const STATEMENT_PAGE_MAX = 200;
export const ACCOUNTS_PAGE_MAX = 200;
export const PAYOUTS_LIMIT_MAX = 500;
export const MAX_ACCOUNT_SEARCH = 100;
export const MAX_ACCOUNT_NAME = 120;
export const MAX_BANK_NAME = 120;
export const MAX_UPI_ID = 320;
export const MIN_REFERENCE = 4;
export const MAX_PAYOUT_REFERENCE = 64;
export const MAX_PAYOUT_NOTE = 500;
export const MIN_FINANCE_REASON = 3;
export const MAX_FINANCE_REASON = 500;
/** `normalizeDetails`. */
export const ACCOUNT_NUMBER_PATTERN = /^\d{9,18}$/;
export const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const UPI_ID_PATTERN = /^[a-z0-9._-]{2,256}@[a-z][a-z0-9]{1,63}$/;
/** `parseCursor`: `<ms>_<entryId>`. */
export const STATEMENT_CURSOR_PATTERN = /^\d{1,15}_[0-9a-fA-F]{24}$/;

/** Field problems of a destination, or the body the server accepts (`payoutDetailsSchema` + `normalizeDetails`). */
export function payoutDetailsProblems(raw: {
  method: 'bank' | 'upi'; accountName?: string; accountNumber?: string; ifsc?: string; bankName?: string; upiId?: string;
}): { body: PayoutDetailsInput | null; errors: Partial<Record<'accountName' | 'accountNumber' | 'ifsc' | 'bankName' | 'upiId', string>> } {
  const errors: Partial<Record<'accountName' | 'accountNumber' | 'ifsc' | 'bankName' | 'upiId', string>> = {};
  const accountName = (raw.accountName ?? '').trim();
  if (accountName.length > MAX_ACCOUNT_NAME) errors.accountName = `Use at most ${MAX_ACCOUNT_NAME} characters.`;
  if (raw.method === 'bank') {
    const accountNumber = (raw.accountNumber ?? '').replace(/\s+/g, '');
    const ifsc = (raw.ifsc ?? '').trim().toUpperCase();
    const bankName = (raw.bankName ?? '').trim();
    if (!accountName) errors.accountName = 'Enter the account holder’s name.';
    if (!ACCOUNT_NUMBER_PATTERN.test(accountNumber)) errors.accountNumber = 'The account number must be 9 to 18 digits.';
    if (!IFSC_PATTERN.test(ifsc)) errors.ifsc = 'The IFSC must look like ABCD0123456.';
    if (bankName.length > MAX_BANK_NAME) errors.bankName = `Use at most ${MAX_BANK_NAME} characters.`;
    return {
      errors,
      body: Object.keys(errors).length ? null : { method: 'bank', accountName, accountNumber, ifsc, ...(bankName ? { bankName } : {}) },
    };
  }
  const upiId = (raw.upiId ?? '').trim().toLowerCase();
  if (upiId.length > MAX_UPI_ID || !UPI_ID_PATTERN.test(upiId)) errors.upiId = 'The UPI ID must look like name@bank.';
  return { errors, body: Object.keys(errors).length ? null : { method: 'upi', upiId, ...(accountName ? { accountName } : {}) } };
}

/** `recordPayout`'s own checks, plus "not above the balance" as last read (the server decides on its balance). */
export function payoutProblems(p: { amountMinor: number | null; reference: string; paidOn: string; note: string }, balanceMinor: number, today: string):
  Partial<Record<'amount' | 'reference' | 'paidOn' | 'note', string>> {
  const e: Partial<Record<'amount' | 'reference' | 'paidOn' | 'note', string>> = {};
  const a = p.amountMinor;
  if (a === null) e.amount = 'Enter rupees, like 4500 or 4500.50.';
  else if (!Number.isSafeInteger(a) || a < 1) e.amount = 'Enter an amount above zero.';
  else if (a > MAX_FINANCE_MINOR) e.amount = 'This is above the largest payout the server accepts.';
  else if (a > balanceMinor) e.amount = 'A payout cannot be more than the balance.';
  const ref = p.reference.trim();
  if (ref.length < MIN_REFERENCE || ref.length > MAX_PAYOUT_REFERENCE) e.reference = `Enter the bank reference (UTR), ${MIN_REFERENCE} to ${MAX_PAYOUT_REFERENCE} characters.`;
  if (!isRealDate(p.paidOn)) e.paidOn = 'Enter the date the money was sent.';
  else if (p.paidOn > today) e.paidOn = 'The date cannot be in the future.';
  if (p.note.trim().length > MAX_PAYOUT_NOTE) e.note = `Use at most ${MAX_PAYOUT_NOTE} characters.`;
  return e;
}

/** A reason for an adjustment or a void (`Joi.string().trim().min(3).max(500)`), or its problem. */
export function reasonProblem(reason: string): string | null {
  const r = reason.trim();
  if (r.length < MIN_FINANCE_REASON) return `Give a reason (at least ${MIN_FINANCE_REASON} characters).`;
  if (r.length > MAX_FINANCE_REASON) return `Use at most ${MAX_FINANCE_REASON} characters.`;
  return null;
}

/** Today in India (payout dates are India calendar dates; the server refuses a future one). */
export const istToday = (now: Date = new Date()) => istDateOf(now);

/** An adjustment line recorded under `requestKey` (`postAdjustment` stores `sourceId = <adminId>:<requestKey>`). */
export const isAdjustmentFor = (line: Pick<StatementLine, 'source' | 'sourceId'>, requestKey: string) =>
  line.source === 'admin_adjustment' && line.sourceId.endsWith(`:${requestKey}`);

/**
 * The recorded payout a lost `recordPayout` would have created. Payout lists never return the request key, but a
 * reference is unique per account among recorded payouts, so the same account + reference + amount + date is it.
 */
export const isPayoutFor = (p: SettlementPayout, accountId: string, body: Omit<RecordPayoutInput, 'requestKey'>) =>
  p.state === 'recorded' && p.settlementAccountId.toLowerCase() === accountId.toLowerCase() && p.reference === body.reference.trim()
  && p.amountMinor === body.amountMinor && p.paidOn === body.paidOn;

/** The file name the server gives a statement CSV (`csvName` in controller/finance.ts). */
export function statementCsvName(prefix: string, q: PeriodQuery = {}): string {
  return `${prefix}-statement${q.from ? `-${q.from}` : ''}${q.to ? `-to-${q.to}` : ''}.csv`;
}

/** Whether the bytes are the server's statement CSV (header row first), not an error page or anything else. */
export async function isStatementCsv(blob: Blob): Promise<boolean> {
  const head = await blob.slice(0, 64).text();
  return head.replace(/^﻿/, '').startsWith('"Date (IST)","Type"');
}

// ── Path and query checks ──

function checkId(id: string, what: string): string {
  if (!OBJECT_ID_PATTERN.test(id)) throw new Error(`Invalid ${what} id`);
  return id;
}
function checkDate(d: string | undefined, what: string): string | undefined {
  if (d === undefined || d === '') return undefined;
  if (!isRealDate(d)) throw new Error(`Invalid ${what} date`);
  return d;
}
function checkLimit(n: number | undefined, max: number): number | undefined {
  if (n === undefined) return undefined;
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error('Invalid limit');
  return n;
}
function period(q: PeriodQuery): PeriodQuery {
  const from = checkDate(q.from, 'from');
  const to = checkDate(q.to, 'to');
  if (from && to && from > to) throw new Error('The period ends before it starts');
  return { from, to };
}
function statementQuery(q: StatementQuery) {
  if (q.before !== undefined && !STATEMENT_CURSOR_PATTERN.test(q.before)) throw new Error('Invalid statement cursor');
  return { ...period(q), before: q.before, limit: checkLimit(q.limit, STATEMENT_PAGE_MAX) };
}
function checkKey(key: string): string {
  if (!REQUEST_KEY_PATTERN.test(key)) throw new Error('Invalid request key');
  return key;
}

/** The partner's own finance (member with `finance.view` and partner-wide scope, or an admin acting as owner). */
export function partnerFinanceApi(c: ApiClient, scope: PartnerScope) {
  const base = () => `${partnerWorkspaceBase(scope)}/finance`;
  return {
    summary: (signal?: AbortSignal) => c.get<FinanceSummary>(base(), { signal }),
    statement: (q: StatementQuery = {}, signal?: AbortSignal) => c.get<StatementPage>(`${base()}/statement`, { query: { ...statementQuery(q) }, signal }),
    /** The statement CSV for a period, read with the session's token into memory. 400 EXPORT_TOO_LARGE over 5,000 entries. */
    statementCsv: (q: PeriodQuery = {}, signal?: AbortSignal) => c.blob(`${base()}/statement.csv`, { query: { ...period(q) }, signal }),
    /** The latest 100 payouts, newest first. */
    payouts: () => c.get<SettlementPayout[]>(`${base()}/payouts`),
    /** The latest 200 finance events, newest first. */
    events: () => c.get<FinanceEvent[]>(`${base()}/events`),
    /** Owners (and admins): replaces the destination; it is unverified until an admin verifies the new version. */
    setPayoutDetails: (body: PayoutDetailsInput) => c.put<SettlementAccount>(`${base()}/payout-details`, { body }),
  };
}

/** Platform admins: every settlement account (`/api/v1/settlements`). */
export function settlementsApi(c: ApiClient) {
  const acc = (id: string) => `/settlements/accounts/${checkId(id, 'account')}`;
  return {
    accounts: (q: AccountsQuery = {}) => {
      const search = q.search?.trim();
      if (search && search.length > MAX_ACCOUNT_SEARCH) throw new Error('Search is too long');
      if (q.skip !== undefined && (!Number.isInteger(q.skip) || q.skip < 0)) throw new Error('Invalid skip');
      return c.get<AccountsPage>('/settlements/accounts', { query: {
        ownerKind: q.ownerKind, due: q.due ? 'true' : undefined, search: search || undefined, detailsState: q.detailsState,
        limit: checkLimit(q.limit, ACCOUNTS_PAGE_MAX), skip: q.skip || undefined,
      } });
    },
    /** The account with the full payout details, balance, totals and last payout. */
    account: (id: string, signal?: AbortSignal) => c.get<FinanceSummary>(acc(id), { signal }),
    statement: (id: string, q: StatementQuery = {}, signal?: AbortSignal) =>
      c.get<StatementPage>(`${acc(id)}/statement`, { query: { ...statementQuery(q) }, signal }),
    statementCsv: (id: string, q: PeriodQuery = {}, signal?: AbortSignal) => c.blob(`${acc(id)}/statement.csv`, { query: { ...period(q) }, signal }),
    payouts: (id: string) => c.get<SettlementPayout[]>(`${acc(id)}/payouts`),
    history: (id: string) => c.get<HistoryRef[]>(`${acc(id)}/history`),
    events: (id: string) => c.get<FinanceEvent[]>(`${acc(id)}/events`),
    setPayoutDetails: (id: string, body: PayoutDetailsInput) => c.put<SettlementAccount>(`${acc(id)}/payout-details`, { body }),
    /** Verifies exactly `version` (409 PAYOUT_DETAILS_CHANGED if the details changed since); a repeat is answered as done. */
    verifyPayoutDetails: (id: string, version: number) => {
      if (!Number.isInteger(version) || version < 1) throw new Error('Invalid details version');
      return c.post<SettlementAccount>(`${acc(id)}/payout-details/verify`, { body: { version } });
    },
    /**
     * Exactly once per (admin, requestKey): a resend with the same key and content answers the payout already recorded
     * (`replayed: true`); other content under the key is refused (409 REQUEST_KEY_REUSED). Refusals: 409
     * PAYOUT_DETAILS_NOT_VERIFIED, PAYOUT_DETAILS_CHANGED (`detailsVersion` is stale), INSUFFICIENT_BALANCE,
     * PAYOUT_REFERENCE_EXISTS, ACCOUNT_INACTIVE.
     */
    recordPayout: (id: string, body: RecordPayoutInput) => {
      checkKey(body.requestKey);
      return c.post<{ payout: SettlementPayout; replayed: boolean }>(`${acc(id)}/payouts`, { body });
    },
    /** Exactly once per (admin, requestKey) as above; may take the balance below zero (a recovery owed). */
    postAdjustment: (id: string, body: AdjustmentInput) => {
      checkKey(body.requestKey);
      return c.post<{ entry: LedgerEntry; replayed: boolean }>(`${acc(id)}/adjustments`, { body });
    },
    payoutQueue: (q: PayoutsQuery = {}) => c.get<SettlementPayout[]>('/settlements/payouts', { query: {
      accountId: q.accountId === undefined ? undefined : checkId(q.accountId, 'account'), ...period(q), state: q.state,
      limit: checkLimit(q.limit, PAYOUTS_LIMIT_MAX),
    } }),
    /** Marks a recorded payout voided and credits it back (an `adjustment`); voiding a voided payout answers it unchanged. */
    voidPayout: (payoutId: string, reason: string) =>
      c.post<SettlementPayout>(`/settlements/payouts/${checkId(payoutId, 'payout')}/void`, { body: { reason } }),
  };
}
