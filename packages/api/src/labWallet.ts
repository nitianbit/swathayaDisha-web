import { formatPaise } from '@jansetu/i18n';
import { ApiError, type ApiClient, type Page } from './client.ts';
import { assistedRefusal, type PharmacyWallet, type Refusal, type TopupCheck, type TopupOrder, type WalletMovement } from './assisted.ts';
import { ADMIN_TOPUP_KEY_PATTERN } from './adminPharmacyWallet.ts';
import { checkId, partnerWorkspaceBase, REQUEST_KEY_PATTERN, type PartnerScope } from './partners.ts';

/**
 * WQ20: the lab wallet (assisted booking round 2d, backend r13 `m0/r13-phase2d` 215556e2, design §24.13). One wallet
 * implementation on the server for pharmacies and labs; here the lab's answers (integer paise, cursor pages) are read into
 * the shapes the pharmacy wallet screens already show (`PharmacyWallet`, `WalletMovement`, `TopupOrder`), so the very same
 * screens show both. Members: `/partner-workspace/assisted/*` (`wallet.view`, `wallet.manage`); admins:
 * `/admin/labs/:partnerId/wallet*`. The existing admin chargeback and close-compensated routes take lab top-ups too.
 */

/** `labWalletView` (+ the admin fields). */
export interface LabWalletView {
  balanceMinor: number; withdrawableMinor: number; receivableMinor: number; frozen: boolean; isActive: boolean; updatedAt: string | null;
  exists?: boolean; frozenReason?: string | null; frozenAt?: string | null; version?: number; createdAt?: string | null;
}
/** `entryView` / `adminEntryView`: `amountMinor` signed. */
export interface LabWalletEntry {
  _id: string; kind: string; amountMinor: number; balanceAfterMinor: number; description?: string; referenceType?: string; referenceId?: string;
  at: string; notes?: string | null; actor?: { kind: string; id: string } | null;
}
export type LabTopupState = 'awaiting_payment' | 'credited' | 'paid_not_credited' | 'blocked' | 'closed_compensated' | 'failed' | 'refunded';
export interface LabTopupRow {
  paymentTransactionId: string; amountMinor: number; state: LabTopupState | string; status: string; memberId: string | null;
  razorpayOrderId?: string; createdAt: string; paidAt: string | null;
}
export interface LabTopupOrder {
  paymentTransactionId: string; razorpayOrderId: string; razorpayKeyId: string; amountMinor: number; currency: string; state: string; replayed: boolean;
}
export interface LabWalletLot {
  _id: string; paymentRecordId: string; amountMinor: number; gatewayFeeMinor?: number; feeState?: string; disputeState?: string; closed?: boolean;
  remainingMinor: number; withdrawableAfter?: string | null; createdAt: string;
}

/** The lab wallet in the shape the wallet screens show. */
export const asPharmacyWallet = (w: LabWalletView | null | undefined): PharmacyWallet | null => (w ? {
  balancePaise: w.balanceMinor, withdrawableMinor: w.withdrawableMinor, receivableMinor: w.receivableMinor, frozen: w.frozen,
  isActive: w.isActive, ...(w.frozenReason ? { frozenReason: w.frozenReason } : {}),
} : null);
/** One lab wallet entry in the shape the wallet history shows (a card top-up credit names `wallet_recharge`). */
export const asMovement = (e: LabWalletEntry): WalletMovement => ({
  _id: e._id, transactionType: e.amountMinor >= 0 ? 'credit' : 'debit', movementType: e.kind, signedAmountPaise: e.amountMinor,
  balanceAfterPaise: e.balanceAfterMinor, description: e.description, referenceType: e.referenceType, referenceId: e.referenceId,
  ...(e.notes ? { notes: e.notes } : {}), ...(e.actor ? { actor: e.actor } : {}), createdAt: e.at,
});

/** The lab's own Razorpay top-ups: ₹1 to ₹50,000 (the most a lab wallet holds, O2), whole paise. */
export const LAB_TOPUP_MIN_MINOR = 100;
export const LAB_TOPUP_MAX_MINOR = 5_000_000;
export const LAB_TOPUP_STATE_LABEL: Readonly<Record<string, string>> = {
  awaiting_payment: 'Not paid yet', credited: 'Added', paid_not_credited: 'Paid, not added yet', blocked: 'Blocked after a dispute',
  closed_compensated: 'Paid by hand', failed: 'Failed', refunded: 'Refunded',
};
/** A top-up "Check" can still settle: not paid yet, or paid and not added yet. */
export const labTopupCheckable = (state: string) => state === 'awaiting_payment' || state === 'paid_not_credited';

const cursorQuery = (cursor?: string, limit?: number) => {
  if (cursor !== undefined && !/^\d{1,15}_[0-9a-fA-F]{24}$/.test(cursor)) throw new Error('Invalid cursor');
  return { cursor, limit };
};

/**
 * WQ23: an owner's own wallet routes (r13 labs at `/partner-workspace/assisted`, r20 doctors at `/specialists/me/assisted`):
 * the same shapes; the proof of payment goes to `verifyPath` (a lab's own, a doctor's the existing `/payments/verify`).
 */
function ownWalletApi(c: ApiClient, base: () => string, verifyPath: () => string) {
  return {
    wallet: async () => asPharmacyWallet(await c.get<LabWalletView>(`${base()}/wallet`))!,
    /** Newest first, 1–50 a page, the next page by `nextCursor`. */
    entries: async (cursor?: string, limit = 20): Promise<Page<WalletMovement>> => {
      const p = await c.page<LabWalletEntry>(`${base()}/wallet/entries`, { query: cursorQuery(cursor, limit) });
      return { ...p, items: p.items.map(asMovement) };
    },
    /** One Razorpay order per (owner, key): the same key and amount answer the same order (`replayed`). */
    startTopup: async (amountMinor: number, requestKey: string): Promise<TopupOrder & { replayed: boolean }> => {
      if (!Number.isSafeInteger(amountMinor) || amountMinor < LAB_TOPUP_MIN_MINOR || amountMinor > LAB_TOPUP_MAX_MINOR) throw new Error('Invalid amount');
      if (!REQUEST_KEY_PATTERN.test(requestKey)) throw new Error('Invalid request key');
      const o = await c.post<LabTopupOrder>(`${base()}/wallet/topups`, { body: { amountMinor, requestKey } });
      return { paymentRequired: true, paymentTransactionId: o.paymentTransactionId, razorpayOrderId: o.razorpayOrderId, razorpayKeyId: o.razorpayKeyId,
        amount: o.amountMinor / 100, currency: o.currency, replayed: o.replayed };
    },
    /** `wallet` is absent for an ineligible doctor (r20 E8). */
    checkTopup: async (paymentTransactionId: string): Promise<TopupCheck> => {
      const r = await c.post<{ state: 'credited' | 'unpaid'; wallet?: LabWalletView | null }>(`${base()}/wallet/topups/${checkId(paymentTransactionId, 'payment')}/check`);
      return { state: r.state, wallet: asPharmacyWallet(r.wallet ?? null) };
    },
    verify: (p: { paymentTransactionId: string; razorpayOrderId: string; razorpayPaymentId: string; razorpaySignature: string }) =>
      c.post<{ context: string; paymentRecord: { status: string; credited?: boolean } }>(verifyPath(), {
        body: { paymentTransactionId: checkId(p.paymentTransactionId, 'payment'), razorpayOrderId: p.razorpayOrderId,
          razorpayPaymentId: p.razorpayPaymentId, razorpaySignature: p.razorpaySignature },
      }),
  };
}

export function labWalletApi(c: ApiClient, scope: PartnerScope) {
  const base = () => `${partnerWorkspaceBase(scope)}/assisted`;
  return {
    ...ownWalletApi(c, base, () => `${base()}/payments/verify`),
    /** The lab's card top-ups with their state (a lost answer is found here; a doctor has no such list, r20 E7). */
    topups: (cursor?: string, limit = 20) => c.page<LabTopupRow>(`${base()}/wallet/topups`, { query: cursorQuery(cursor, limit) }),
  };
}

/** WQ23: the doctor's own wallet (r20, specialist token; an eligible doctor reads it). */
export const doctorWalletApi = (c: ApiClient) => ownWalletApi(c, () => '/specialists/me/assisted', () => '/payments/verify');
/** What a lab's or a doctor's own top-up needs (the shared top-up form). */
export type OwnWalletApi = ReturnType<typeof ownWalletApi>;

/** The admin's credit: at most ₹2,00,000 at one time (checked by the server too), a note of at most 500 characters. */
export const LAB_ADMIN_TOPUP_MAX_MINOR = 20_000_000;

/** WQ23: whose wallet an admin works on beside a pharmacy's: a lab's (r13) or a doctor's (r20); the same routes and shapes. */
export type WalletOwnerKind = 'lab' | 'doctor';
/** Every wallet owner the admin and the shared words name. */
export type WalletOwner = 'pharmacy' | WalletOwnerKind;
const ADMIN_WALLET_BASE: Record<WalletOwnerKind, string> = { lab: '/admin/labs', doctor: '/admin/doctors' };

export function adminOwnerWalletApi(c: ApiClient, kind: WalletOwnerKind) {
  const base = (ownerId: string) => `${ADMIN_WALLET_BASE[kind]}/${checkId(ownerId, kind).toLowerCase()}/wallet`;
  return {
    /** `exists: false` (zeros) while the owner has no wallet yet. */
    wallet: (ownerId: string) => c.get<LabWalletView>(base(ownerId)),
    entries: async (ownerId: string, cursor?: string, limit = 20): Promise<Page<WalletMovement>> => {
      const p = await c.page<LabWalletEntry>(`${base(ownerId)}/entries`, { query: cursorQuery(cursor, limit) });
      return { ...p, items: p.items.map(asMovement) };
    },
    lots: (ownerId: string) => c.get<LabWalletLot[]>(`${base(ownerId)}/lots`),
    /** The exact read of an admin credit by its Idempotency-Key: the entry it made, or none (resend the same body). */
    topupByKey: async (ownerId: string, key: string): Promise<{ state: 'used'; row: WalletMovement } | { state: 'none' }> => {
      if (!ADMIN_TOPUP_KEY_PATTERN.test(key)) throw new Error('Invalid request key');
      const r = await c.get<{ state?: string; entry?: LabWalletEntry | null } | null>(`${base(ownerId)}/topups/by-key/${key}`);
      if (r?.state === 'credited' && r.entry && typeof r.entry === 'object') return { state: 'used', row: asMovement(r.entry) };
      if (r?.state === 'not_found') return { state: 'none' };
      throw new ApiError(502, 'The answer about this top-up could not be read.');
    },
    /** Once per key (the same body answers the wallet again; another body is 409 IDEMPOTENCY_KEY_REUSED). Non-withdrawable. */
    topup: (ownerId: string, body: { amountMinor: number; notes: string }, idempotencyKey: string) => {
      if (!ADMIN_TOPUP_KEY_PATTERN.test(idempotencyKey)) throw new Error('Invalid request key');
      if (!Number.isSafeInteger(body.amountMinor) || body.amountMinor < 1 || body.amountMinor > LAB_ADMIN_TOPUP_MAX_MINOR) throw new Error('Invalid amount');
      return c.post<LabWalletView>(`${base(ownerId)}/topup`, { body: { amountMinor: body.amountMinor, notes: body.notes.trim().replace(/\s+/g, ' ') }, idempotencyKey });
    },
    /** Hold (no spending) or release; 409 WALLET_RECEIVABLE to release a wallet that owes. */
    freeze: (ownerId: string, frozen: boolean, reason: string) =>
      c.put<LabWalletView>(`${base(ownerId)}/freeze`, { body: { frozen, reason: reason.trim() } }),
    /**
     * The existing chargeback of one top-up lot (`POST /admin/wallet-lots/:lotId/chargeback`): a lab's is flag only (D1:
     * the lot is no longer withdrawable, nothing is taken). Repeating it answers the flag again (`replayed`).
     */
    chargebackLot: (lotId: string, reason: string) =>
      c.post<{ flagged?: boolean; replayed?: boolean; message?: string }>(`/admin/wallet-lots/${checkId(lotId, 'lot')}/chargeback`, { body: { reason: reason.trim() } }),
  };
}

/** The ₹50,000 most a lab or doctor wallet holds (`WALLET_LIMIT_REACHED`, paise `details`), in words; else the shared assisted words. */
export function ownerWalletRefusal(err: unknown, kind: WalletOwnerKind): Refusal {
  if (err instanceof ApiError && err.code === 'WALLET_LIMIT_REACHED') {
    const d = (err.details ?? {}) as { maxBalanceMinor?: number; allowedMinor?: number };
    const max = Number.isFinite(Number(d.maxBalanceMinor)) ? formatPaise(Number(d.maxBalanceMinor)) : '₹50,000';
    const allowed = Number(d.allowedMinor);
    return { kind: 'limit', message: Number.isFinite(allowed) && allowed > 0
      ? `The wallet can hold at most ${max}. You can add up to ${formatPaise(allowed)} now.`
      : `The wallet can hold at most ${max}, so no more money can be added now.` };
  }
  if (err instanceof ApiError && err.code === 'WALLET_NOT_FOUND') return { kind: 'other', message: 'The wallet is for labs only.' };
  if (err instanceof ApiError && err.code === 'LAB_NOT_FOUND') return { kind: 'other', message: 'This lab was not found.' };
  if (err instanceof ApiError && err.code === 'SPECIALIST_NOT_FOUND') return { kind: 'other', message: 'This doctor was not found.' };
  if (err instanceof ApiError && err.code === 'SPECIALIST_NOT_VERIFIED') return { kind: 'other', message: DOCTOR_WALLET_CLOSED_MESSAGE };
  if (err instanceof ApiError && err.code === 'WALLET_RECEIVABLE') return { kind: 'other', message: 'The wallet owes Jansetu money, so its hold cannot be released yet.' };
  const shared = assistedRefusal(err);
  return shared.kind === 'off' ? { kind: 'off', message: kind === 'doctor' ? DOCTOR_WALLET_SWITCHED_OFF_MESSAGE : LAB_WALLET_SWITCHED_OFF_MESSAGE } : shared;
}
export const LAB_WALLET_SWITCHED_OFF_MESSAGE = 'Adding money to the lab wallet is not switched on yet.';
export const DOCTOR_WALLET_SWITCHED_OFF_MESSAGE = 'Adding money to your wallet is not switched on yet.';
/** r20: only a verified, active doctor has a wallet to read (403 SPECIALIST_NOT_VERIFIED). */
export const DOCTOR_WALLET_CLOSED_MESSAGE = 'Your wallet opens once Jansetu has verified your account and it is active.';
export const isDoctorWalletClosed = (err: unknown) => err instanceof ApiError && err.code === 'SPECIALIST_NOT_VERIFIED';
