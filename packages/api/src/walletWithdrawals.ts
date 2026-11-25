import type { ApiClient, Page } from './client.ts';
import { idOf, keyOf } from './assisted.ts';
import { partnerWorkspaceBase, type PartnerScope } from './partners.ts';
import type { PayoutDetailsView } from './finance.ts';

/**
 * WQ29: wallet withdrawals to the bank (backend r32 round 4d, design ASSISTED_BOOKING_DESIGN.md §26.16.4; switched off on
 * the server: `WALLET_WITHDRAWALS_ENABLED`). One set of owner routes for the pharmacy (`/pharmacy-assisted/wallet/…`), a lab
 * (`/partner-workspace/assisted/wallet/…`) and a doctor (`/specialists/me/assisted/wallet/…`); the admin's queue
 * (`/admin/wallet-withdrawals`) and the Recover of a disputed card top-up. Paise throughout. Routes, shapes and rules only:
 * the words are the workspace's `withdrawals` catalogue, keyed by the server's codes.
 */

export type WithdrawalState = 'requested' | 'cancelled' | 'rejected' | 'paid' | 'voided';
export type DestinationState = 'none' | 'unverified' | 'verified';

/** `GET …/wallet/withdrawable[?amountMinor]`. */
export interface Withdrawable {
  enabled: boolean;
  minimumMinor: number;
  withdrawableNowMinor: number;
  /** Card money that becomes withdrawable later (7 days after its payment). */
  availableLater: { amountMinor: number; availableAt: string }[];
  /** One withdrawal per rolling 7 days: the next one from this time (null: now). */
  nextAllowedAt: string | null;
  /** r35: `details` (masked) prefills the payout-details form. */
  destination: { state: DestinationState; masked: string | null; detailsVersion: number; details?: PayoutDetailsView | null };
  /**
   * With `amountMinor`: the fee is taken only on unspent card money. r35: `reason` says why a request of this amount would
   * be refused now (null: it would go through; `available` = `reason === null`).
   */
  quote?: { grossMinor: number; feeMinor: number; transferMinor: number; available: boolean; reason?: QuoteReason | null };
}
/** r35 (WQ29 gap 2): the first refusal that applies to a quoted amount, in the request's own order of checks. */
export type QuoteReason = 'WITHDRAWALS_DISABLED' | 'BELOW_MINIMUM' | 'DESTINATION_NOT_VERIFIED' | 'WALLET_RECEIVABLE' | 'WALLET_FROZEN' | 'WEEKLY_LIMIT'
  | 'ABOVE_WITHDRAWABLE' | 'LAB_NOT_VERIFIED' | 'WALLET_INACTIVE';

export interface Withdrawal {
  _id: string;
  walletKind: string;
  state: WithdrawalState;
  grossMinor: number;
  feeMinor: number;
  transferMinor: number;
  /** The server's sentence about the fee (shown as sent). */
  feeLine: string;
  lots: { lotId: string; amountMinor: number; feeMinor: number }[];
  destination: { masked: string | null; detailsVersion: number; homeAccountId?: string };
  /** r35: `disputeAcknowledged` when it was marked paid after a card dispute (`disputedMinor` of it is owed back). */
  paid: { method: string; reference: string; paidOn: string; at: string; note?: string | null; disputeAcknowledged?: boolean; disputedMinor?: number } | null;
  reason: string | null;
  /** r35b (WQ48b): whether the signed-in member asked for it (a branch-limited lab manager cancels only its own). */
  requestedByMe?: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}
/** The admin's row: whose wallet it is too. */
export interface AdminWithdrawal extends Withdrawal { walletRef: { kind: string; id: string } }
export interface WalletAfter { balanceMinor: number; withdrawableMinor: number; receivableMinor: number; frozen: boolean }
export type WithdrawalByKey = { state: 'used'; withdrawal: Withdrawal } | { state: 'abandoned' } | { state: 'unknown' };
export interface WithdrawalAnswer { withdrawal: Withdrawal; wallet: WalletAfter; replayed: boolean }

const CURSOR = /^\d{1,15}_[0-9a-fA-F]{24}$/;
const cursorOf = (cursor?: string) => {
  if (cursor !== undefined && cursor !== '' && !CURSOR.test(cursor)) throw new Error('Invalid cursor'); // i18n-ignore: a programming error, not shown
  return cursor || undefined;
};
const paise = (v: number) => {
  if (!Number.isSafeInteger(v) || v < 1) throw new Error('Invalid amount'); // i18n-ignore: a programming error, not shown
  return v;
};
const versionOf = (v: number) => {
  if (!Number.isSafeInteger(v) || v < 0) throw new Error('Invalid version'); // i18n-ignore: a programming error, not shown
  return v;
};

/** The owner's routes under its own base (the pharmacy's, a lab's or a doctor's). */
function ownerWithdrawals(c: ApiClient, base: () => string) {
  const at = (path = '') => `${base()}/wallet${path}`;
  return {
    /** What can be withdrawn now and later, the weekly limit and the destination; with an amount, its quote. */
    withdrawable: (amountMinor?: number) =>
      c.get<Withdrawable>(at('/withdrawable'), { query: amountMinor !== undefined ? { amountMinor: paise(amountMinor) } : {} }),
    /**
     * One withdrawal per key: the same key and amount answer it again (`replayed`). `detailsVersion` fences the destination;
     * r35: `expectedTransferMinor` (the quote shown) fences the fee: 409 WITHDRAWAL_QUOTE_CHANGED with the new quote.
     */
    request: (body: { amountMinor: number; requestKey: string; detailsVersion: number; expectedTransferMinor?: number }) =>
      c.post<WithdrawalAnswer>(at('/withdrawals'), { body: {
        amountMinor: paise(body.amountMinor), requestKey: keyOf(body.requestKey), detailsVersion: versionOf(body.detailsVersion),
        ...(body.expectedTransferMinor !== undefined ? { expectedTransferMinor: versionOf(body.expectedTransferMinor) } : {}),
      } }),
    /** Newest first, 1–50 a page, the next page by `nextCursor`. */
    list: (q: { state?: WithdrawalState; cursor?: string; limit?: number } = {}): Promise<Page<Withdrawal>> =>
      c.page<Withdrawal>(at('/withdrawals'), { query: { ...(q.state ? { state: q.state } : {}), cursor: cursorOf(q.cursor), limit: q.limit ?? 20 } }),
    get: (id: string) => c.get<Withdrawal>(at(`/withdrawals/${idOf(id, 'withdrawal')}`)),
    byKey: (key: string) => c.get<WithdrawalByKey>(at(`/withdrawals/by-key/${keyOf(key)}`)),
    abandon: (key: string) => c.post<WithdrawalByKey>(at(`/withdrawals/by-key/${keyOf(key)}/abandon`)),
    /** Only while `requested`; the hold goes back to the wallet. */
    cancel: (id: string, expectedVersion: number) =>
      c.post<WithdrawalAnswer>(at(`/withdrawals/${idOf(id, 'withdrawal')}/cancel`), { body: { expectedVersion: versionOf(expectedVersion) } }),
  };
}
export type WithdrawalsApi = ReturnType<typeof ownerWithdrawals>;

export const pharmacyWithdrawalsApi = (c: ApiClient) => ownerWithdrawals(c, () => '/pharmacy-assisted');
export const labWithdrawalsApi = (c: ApiClient, scope: PartnerScope) => ownerWithdrawals(c, () => `${partnerWorkspaceBase(scope)}/assisted`);
export const doctorWithdrawalsApi = (c: ApiClient) => ownerWithdrawals(c, () => '/specialists/me/assisted');

export type PaidMethod = 'bank_transfer' | 'upi';
export interface PaidBody {
  method: PaidMethod; reference: string; paidOn: string; note?: string; detailsVersion: number; expectedVersion: number; requestKey: string;
  /** r35: the bank transfer already went out although a card dispute was recorded since (else 409 WITHDRAWAL_LOT_DISPUTED). */
  disputeAcknowledged?: true;
}

/** `/admin/wallet-withdrawals`: the queue oldest first, one withdrawal, reject, paid (the bank's reference) and void. */
export function adminWithdrawalsApi(c: ApiClient) {
  const at = (path = '') => `/admin/wallet-withdrawals${path}`;
  return {
    list: (q: { state?: WithdrawalState; cursor?: string } = {}): Promise<Page<AdminWithdrawal>> =>
      c.page<AdminWithdrawal>(at(), { query: { ...(q.state ? { state: q.state } : {}), cursor: cursorOf(q.cursor) } }),
    get: (id: string) => c.get<AdminWithdrawal>(at(`/${idOf(id, 'withdrawal')}`)),
    reject: (id: string, body: { reason: string; expectedVersion: number }) =>
      c.post<{ withdrawal: AdminWithdrawal }>(at(`/${idOf(id, 'withdrawal')}/reject`), { body: { reason: body.reason.trim(), expectedVersion: versionOf(body.expectedVersion) } }),
    /** Once per key: the same key and body answer it again. */
    paid: (id: string, body: PaidBody) => c.post<{ withdrawal: AdminWithdrawal }>(at(`/${idOf(id, 'withdrawal')}/paid`), { body: {
      method: body.method, reference: body.reference.trim(), paidOn: body.paidOn, ...(body.note?.trim() ? { note: body.note.trim() } : {}),
      detailsVersion: versionOf(body.detailsVersion), expectedVersion: versionOf(body.expectedVersion), requestKey: keyOf(body.requestKey),
      ...(body.disputeAcknowledged === true ? { disputeAcknowledged: true } : {}) } }),
    /** Only a paid one (the transfer came back): the amount returns to the wallet. */
    void: (id: string, body: { reason: string; expectedVersion: number }) =>
      c.post<{ withdrawal: AdminWithdrawal }>(at(`/${idOf(id, 'withdrawal')}/void`), { body: { reason: body.reason.trim(), expectedVersion: versionOf(body.expectedVersion) } }),
  };
}

/** The bank's reference (UTR) of a paid withdrawal: 4–64 characters. */
export const isPaidReference = (s: string) => s.trim().length >= 4 && s.trim().length <= 64;

export interface RecoverAnswer {
  recovered: true; replayed: boolean; lotId: string; paymentRecordId: string; walletKind: string; withoutLot: boolean; compensated?: boolean;
  wallet?: { balanceMinor?: number; receivableMinor?: number; frozen?: boolean };
}
/**
 * r32 (§26.8.4): after a lost card dispute was recorded (the flag), the admin takes the money back: the wallet is debited up
 * to its balance, the rest is owed and the wallet is put on hold. Once per top-up (a repeat answers `replayed`).
 */
export function walletRecoverApi(c: ApiClient) {
  return {
    lot: (lotId: string, body: { reason: string; requestKey: string }) =>
      c.post<RecoverAnswer>(`/admin/wallet-lots/${idOf(lotId, 'lot')}/recover`, { body: { reason: body.reason.trim(), requestKey: keyOf(body.requestKey) } }),
    /** A top-up credited without a lot: by its payment record id. */
    payment: (paymentRecordId: string, body: { reason: string; requestKey: string }) =>
      c.post<RecoverAnswer>(`/admin/wallet-payments/${idOf(paymentRecordId, 'payment')}/recover`, { body: { reason: body.reason.trim(), requestKey: keyOf(body.requestKey) } }),
  };
}

// ── Rules ──

/** What is wrong with an amount before asking the server (the server checks again). */
export function withdrawalAmountProblem(amountMinor: number, w: Pick<Withdrawable, 'minimumMinor' | 'withdrawableNowMinor'>): 'invalid' | 'below_minimum' | 'above_available' | null {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 1) return 'invalid';
  if (amountMinor < w.minimumMinor) return 'below_minimum';
  if (amountMinor > w.withdrawableNowMinor) return 'above_available';
  return null;
}
/** The weekly limit: the time from which the next withdrawal may be asked for, or null when it may be asked for now. */
export const weeklyWait = (w: Pick<Withdrawable, 'nextAllowedAt'>, now = new Date()): string | null =>
  (w.nextAllowedAt && Date.parse(w.nextAllowedAt) > now.getTime() ? w.nextAllowedAt : null);
/** The server's code of a refusal, or null. */
export const withdrawalErrorCode = (err: unknown): string | null =>
  err && typeof err === 'object' && 'code' in err && typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : null;
/** r35: the new quote of a 409 WITHDRAWAL_QUOTE_CHANGED (the card fee moved since the screen was read), or null. */
export function quoteChangedOf(err: unknown): { grossMinor: number; feeMinor: number; transferMinor: number } | null {
  if (withdrawalErrorCode(err) !== 'WITHDRAWAL_QUOTE_CHANGED') return null;
  const d = withdrawalErrorDetails(err);
  const n = (v: unknown) => (Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : null);
  const grossMinor = n(d.grossMinor), feeMinor = n(d.feeMinor), transferMinor = n(d.transferMinor);
  return grossMinor !== null && feeMinor !== null && transferMinor !== null ? { grossMinor, feeMinor, transferMinor } : null;
}
/** A refusal's safe details (`minimumMinor`, `withdrawableNowMinor`, `nextAllowedAt`). */
export const withdrawalErrorDetails = (err: unknown): Record<string, unknown> =>
  (err && typeof err === 'object' && 'details' in err && (err as { details?: unknown }).details && typeof (err as { details?: unknown }).details === 'object'
    ? (err as { details: Record<string, unknown> }).details : {});
