import type { ApiClient, Page } from './client.ts';
import { idOf, keyOf, type WalletMovement } from './assisted.ts';
import {
  period, STATEMENT_CURSOR_PATTERN, STATEMENT_PAGE_MAX, type PayoutDetailsView, type PeriodQuery, type ReferralBlock, type WithdrawalsBlock,
} from './finance.ts';
import { REFERRAL_STATEMENT_PAGE, type ReferralStatementLine } from './referralCuts.ts';
import type { DestinationState } from './walletWithdrawals.ts';

/**
 * WQ48 (backend r35 rounds 4e/4f, design ASSISTED_BOOKING_DESIGN.md §26.10 and §26.18.3): the pharmacy's Finance reads
 * (`/pharmacy-assisted/finance*`: wallet, referral, withdrawals and destination blocks; one statement for the wallet or
 * the referral account, with its CSV) and the admin's wallet money tools: card disputes, card top-ups credited without a
 * lot, and a wallet's owed amount paid from the owner's referral earnings (exactly once per key). Paise throughout.
 */

export type WalletKind = 'pharmacy' | 'lab' | 'doctor';
export const WALLET_KINDS: readonly WalletKind[] = ['pharmacy', 'lab', 'doctor'];

/** `GET /pharmacy-assisted/finance`. */
export interface PharmacyFinance {
  wallet: {
    balanceMinor: number;
    /** Card money past its 7-day hold. */
    withdrawableNowMinor: number;
    /** Card money that becomes withdrawable later. */
    availableLater: { amountMinor: number; availableAt: string }[];
    receivableMinor: number;
    frozen: boolean;
  };
  referral: ReferralBlock;
  withdrawals: WithdrawalsBlock;
  /** The pharmacy's own payout destination, masked (`details` prefills its form; the full number is never sent). */
  payoutDetails: { state: DestinationState; masked: string | null; detailsVersion: number; details: PayoutDetailsView | null };
}

/** Which statement: the wallet's rows (as the wallet history reads them) or the referral account's lines. */
export type FinanceStatementKind = 'wallet' | 'referral';

const statementQuery = (before: string | undefined, limit: number, q: PeriodQuery) => {
  if (before !== undefined && !STATEMENT_CURSOR_PATTERN.test(before)) throw new Error('Invalid statement cursor'); // i18n-ignore: a programming error, not shown
  if (!Number.isInteger(limit) || limit < 1 || limit > STATEMENT_PAGE_MAX) throw new Error('Invalid limit'); // i18n-ignore: a programming error, not shown
  return { ...period(q), before, limit };
};

/** The signed-in pharmacy's Finance screen. */
export function pharmacyFinanceApi(c: ApiClient) {
  const at = '/pharmacy-assisted/finance';
  return {
    summary: () => c.get<PharmacyFinance>(at),
    /** Wallet rows newest first (`transactionView`), of a period; `before` is the previous page's `nextCursor`. */
    walletStatement: (before?: string, limit = REFERRAL_STATEMENT_PAGE, q: PeriodQuery = {}): Promise<Page<WalletMovement>> =>
      c.page<WalletMovement>(`${at}/statement`, { query: { kind: 'wallet', ...statementQuery(before, limit, q) } }),
    /** The referral account's lines (r33's), the same signature as the referral page's statement. */
    referralStatement: (before?: string, limit = REFERRAL_STATEMENT_PAGE, q: PeriodQuery = {}): Promise<Page<ReferralStatementLine>> =>
      c.page<ReferralStatementLine>(`${at}/statement`, { query: { kind: 'referral', ...statementQuery(before, limit, q) } }),
    /** The one finance CSV for either kind (400 EXPORT_TOO_LARGE over 5,000 rows), read with the session's token into memory. */
    statementCsv: (kind: FinanceStatementKind, q: PeriodQuery = {}, signal?: AbortSignal) =>
      c.blob(`${at}/statement.csv`, { query: { kind, ...period(q) }, signal }),
  };
}

// ── Admin ──

/** `flagged`: a dispute recorded, nothing taken (Recover); `recovered`: taken back; `blocked`: never credited. */
export type DisputeState = 'flagged' | 'recovered' | 'blocked';
export const DISPUTE_STATES: readonly DisputeState[] = ['flagged', 'recovered', 'blocked'];
/** `GET /admin/wallet-disputes`: a card top-up with a recorded dispute (ids, amounts and times only). */
export interface WalletDispute {
  paymentRecordId: string;
  walletKind: WalletKind | null;
  ownerId: string | null;
  /** The top-up's lot (Recover by lot), or null (Recover by payment id). */
  lotId: string | null;
  amountMinor: number | null;
  remainingMinor: number | null;
  state: DisputeState;
  chargebackAt: string | null;
  recoveredAt: string | null;
  at: string | null;
}
/** `GET /admin/wallets/:kind/:id/topups-without-lot`: a card top-up credited before lots existed (never withdrawable). */
export interface TopupWithoutLot {
  paymentRecordId: string; walletKind: WalletKind; ownerId: string; razorpayPaymentId: string | null; amountMinor: number;
  paidAt: string | null; creditedAt: string | null; chargebackAt: string | null;
}
export interface SetOff { amountMinor: number; referralAccountId: string; ledgerEntryId: string; walletEntryId: string | null; at: string }
export interface SetOffAnswer { setoff: SetOff; wallet: { receivableMinor: number; frozen: boolean } | null; replayed: boolean }
export type SetOffByKey = { state: 'used'; setoff: SetOff } | { state: 'abandoned' } | { state: 'unknown' };

const kindOf = (k: WalletKind) => {
  if (!WALLET_KINDS.includes(k)) throw new Error('Invalid wallet kind'); // i18n-ignore: a programming error, not shown
  return k;
};

/** The admin's wallet money tools (r35). */
export function adminWalletFinanceApi(c: ApiClient) {
  const wallet = (kind: WalletKind, id: string) => `/admin/wallets/${kindOf(kind)}/${idOf(id, 'wallet')}`;
  const setoff = (kind: WalletKind, id: string) => `${wallet(kind, id)}/receivable/setoff-from-referral`;
  return {
    /** Newest first, at most 200 (no cursor). */
    disputes: (q: { state?: DisputeState; walletKind?: WalletKind; limit?: number } = {}) => {
      if (q.limit !== undefined && (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > 200)) throw new Error('Invalid limit'); // i18n-ignore: a programming error, not shown
      return c.get<WalletDispute[]>('/admin/wallet-disputes', { query: { state: q.state, walletKind: q.walletKind ? kindOf(q.walletKind) : undefined, limit: q.limit } });
    },
    topupsWithoutLot: (kind: WalletKind, id: string) => c.get<TopupWithoutLot[]>(`${wallet(kind, id)}/topups-without-lot`),
    /**
     * Pays `amountMinor` of what the wallet owes from the owner's referral earnings, once per key (the same key and amount
     * answer it again: `replayed`). 409 REFERRAL_PAYOUTS_DISABLED, SETOFF_ABOVE_AVAILABLE (`details`), IDEMPOTENCY_KEY_REUSED,
     * REQUEST_ABANDONED; 404 WALLET_NOT_FOUND (no wallet or no referral account).
     */
    setOff: (kind: WalletKind, id: string, body: { amountMinor: number; requestKey: string }) => {
      if (!Number.isSafeInteger(body.amountMinor) || body.amountMinor < 1) throw new Error('Invalid amount'); // i18n-ignore: a programming error, not shown
      return c.post<SetOffAnswer>(setoff(kind, id), { body: { amountMinor: body.amountMinor, requestKey: keyOf(body.requestKey) } });
    },
    setOffByKey: (kind: WalletKind, id: string, key: string) => c.get<SetOffByKey>(`${setoff(kind, id)}/by-key/${keyOf(key)}`),
    abandonSetOff: (kind: WalletKind, id: string, key: string) => c.post<SetOffByKey>(`${setoff(kind, id)}/by-key/${keyOf(key)}/abandon`),
  };
}
