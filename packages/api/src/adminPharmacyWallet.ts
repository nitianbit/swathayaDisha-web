import { ApiError, type ApiClient, type Page } from './client.ts';
import { assistedRefusal, isSwitchedOff, type PharmacyWallet, type WalletMovement } from './assisted.ts';

/**
 * WQ13 admin: a pharmacy's Jansetu wallet and the admin's manual credit (backend `src1/modules/pharmacyWallet`, q16
 * 338733f8). The reads are the pharmacy's own routes with `?pharmacyId=` (`requireAdminOrOperationalPharmacy`; an admin
 * must name the pharmacy, 400 PHARMACY_ID_REQUIRED; a pharmacy with no wallet yet reads as `null`, nothing is made).
 *
 * The credit (`POST /pharmacy-wallet/topup` with an admin token, review of fb4063c7 item 4) needs an `Idempotency-Key`
 * header (400 IDEMPOTENCY_KEY_REQUIRED, at most 100 characters): one credit per key. The same key and the same amount and
 * note answer the wallet again and add nothing; the same key with another amount or note is 409 IDEMPOTENCY_KEY_REUSED.
 * The ledger row keeps the key as `referenceId` (`referenceType: 'topup'`), so a lost answer can be found in the history.
 * An unknown pharmacy is 404 PHARMACY_NOT_FOUND. The credit posts whatever the wallet state; a credit on a wallet that
 * owes Jansetu clears what it owes first (`receivable_setoff`).
 */

export interface AdminTopupBody { pharmacyId: string; amount: number; notes: string }

/** The key goes in a header; ours are 32 letters and digits (`newRequestKey`). */
export const ADMIN_TOPUP_KEY_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;
/** `topupSchema.notes`: at most 500 characters after trimming (optional on the server; required here). */
export const MAX_ADMIN_TOPUP_NOTE = 500;
export const MIN_ADMIN_TOPUP_NOTE = 3;
/**
 * `topupSchema.amount` is a number of at least 1 (rupees) with no upper limit. Here: whole rupees, and at most the
 * pharmacy's own largest top-up (₹2,00,000), a guard against a mistyped amount (client-side only).
 */
export const MAX_ADMIN_TOPUP_RUPEES = 200_000;
export const ADMIN_TOPUP_PAGE_SIZE = 20;

const hex = /^[0-9a-fA-F]{24}$/;
/**
 * r7 (`m0/r7-followups`, not committed there yet when this was written): `GET /pharmacy-wallet/topups/admin/by-key/:key?pharmacyId=`
 * (admin), one exact read on the ledger's unique indexes: `{ state: 'credited', transaction, wallet }` or `{ state: 'not_found' }`.
 */
export const ADMIN_TOPUP_BY_KEY_PATH = (key: string) => `/pharmacy-wallet/topups/admin/by-key/${key}`;
const pharmacyIdOf = (v: string) => { if (!hex.test(v)) throw new Error('Invalid pharmacy id'); return v.toLowerCase(); };
const cleanNote = (s: string) => s.trim().replace(/\s+/g, ' ');

export function adminPharmacyWalletApi(c: ApiClient) {
  return {
    /** `GET /pharmacy-wallet?pharmacyId=`: null when the pharmacy has no wallet yet. */
    wallet: (pharmacyId: string) => c.get<PharmacyWallet | null>('/pharmacy-wallet', { query: { pharmacyId: pharmacyIdOf(pharmacyId) } }),
    /** `GET /pharmacy-wallet/transactions?pharmacyId=`: newest first, page-numbered. */
    movements: (pharmacyId: string, page = 1, limit = ADMIN_TOPUP_PAGE_SIZE): Promise<Page<WalletMovement>> =>
      c.page<WalletMovement>('/pharmacy-wallet/transactions', { query: { pharmacyId: pharmacyIdOf(pharmacyId), page, limit } }),
    /**
     * WQ13 review M1: the exact read of the credit made with an Idempotency-Key (r7). 'used' with the ledger row, or
     * 'none' (nothing credited with this key so far); 'unavailable' when this server has no such route (the catch-all
     * 404 without a code, or 405): then the history is searched.
     */
    topupByKey: async (pharmacyId: string, key: string): Promise<{ state: 'used'; row: WalletMovement } | { state: 'none' } | { state: 'unavailable' }> => {
      if (!ADMIN_TOPUP_KEY_PATTERN.test(key)) throw new Error('Invalid request key');
      try {
        const r = await c.get<{ state?: string; transaction?: WalletMovement | null } | null>(ADMIN_TOPUP_BY_KEY_PATH(key), { query: { pharmacyId: pharmacyIdOf(pharmacyId) } });
        if (r?.state === 'credited' && r.transaction && typeof r.transaction === 'object') return { state: 'used', row: r.transaction };
        if (r?.state === 'not_found') return { state: 'none' };
        throw new ApiError(502, 'The answer about this top-up could not be read.');
      } catch (err) {
        if (err instanceof ApiError && ((err.status === 404 && !err.code) || err.status === 405)) return { state: 'unavailable' };
        throw err;
      }
    },
    /**
     * WQ15: `GET /admin/wallet-recharges/uncredited` (no query; every pharmacy): paid card top-ups with no wallet credit,
     * then attempts nobody checked with Razorpay (`uncreditedTopups`, at most 200 of each). Rows of `pharmacyId` only.
     */
    uncredited: async (pharmacyId: string): Promise<UncreditedTopup[]> =>
      uncreditedOf(await c.get<unknown>('/admin/wallet-recharges/uncredited'), pharmacyIdOf(pharmacyId)),
    /**
     * r9 (design §22.2): `POST /admin/wallet-payments/:paymentId/close-compensated { reason, requestKey }`: support
     * already paid this top-up by hand, so it is closed and never credited. Once per (admin, key); the same key and body
     * answer the closure again (`replayed`). `paymentId` here is always the payment record id.
     */
    closeCompensated: async (paymentRecordId: string, body: { reason: string; requestKey: string }): Promise<CompensatedClose> => {
      if (!hex.test(paymentRecordId)) throw new Error('Invalid payment id');
      if (!ADMIN_TOPUP_KEY_PATTERN.test(body.requestKey)) throw new Error('Invalid request key');
      const reason = cleanNote(body.reason);
      if (closeReasonProblem(reason)) throw new Error('Invalid reason');
      const r = await c.post<Partial<CompensatedClose> | null>(`/admin/wallet-payments/${paymentRecordId.toLowerCase()}/close-compensated`,
        { body: { reason, requestKey: body.requestKey } });
      // WQ15b L1: only a closure is a close; anything else (a 502 here) leaves the request unknown, never claimed closed.
      if (r?.closed !== true) throw new ApiError(502, 'The answer about this top-up could not be read.');
      return r as CompensatedClose;
    },
    /** r9: did this admin's close with `key` happen? 'closed' with the closure, or 'not_found'. Anything else is thrown. */
    closeCompensatedByKey: async (key: string): Promise<{ state: 'closed'; close: CompensatedClose } | { state: 'not_found' }> => {
      if (!ADMIN_TOPUP_KEY_PATTERN.test(key)) throw new Error('Invalid request key');
      const r = await c.get<{ state?: string } & Partial<CompensatedClose> | null>(`/admin/wallet-payments/close-compensated/by-key/${key}`);
      if (r?.state === 'closed' && r.closed === true) return { state: 'closed', close: r as CompensatedClose };
      if (r?.state === 'not_found') return { state: 'not_found' };
      throw new ApiError(502, 'The answer about this top-up could not be read.');
    },
    /** The admin credit: the key in the `Idempotency-Key` header, the same body on every resend. Answers the wallet. */
    topup: (body: AdminTopupBody, idempotencyKey: string) => {
      if (!ADMIN_TOPUP_KEY_PATTERN.test(idempotencyKey)) throw new Error('Invalid request key');
      if (!Number.isSafeInteger(body.amount) || body.amount < 1) throw new Error('Invalid amount');
      return c.post<PharmacyWallet>('/pharmacy-wallet/topup', {
        body: { pharmacyId: pharmacyIdOf(body.pharmacyId), amount: body.amount, notes: cleanNote(body.notes) },
        idempotencyKey,
      });
    },
  };
}

/** The checked form: the body to send, or the problems to show. */
export function adminTopupForm(amountText: string, noteText: string): { amount?: string; notes?: string; value?: { amount: number; notes: string } } {
  const out: { amount?: string; notes?: string } = {};
  const a = amountText.trim().replace(/,/g, '');
  if (!/^\d{1,7}$/.test(a) || Number(a) < 1) out.amount = 'Enter a whole number of rupees, 1 or more (for example 500).';
  else if (Number(a) > MAX_ADMIN_TOPUP_RUPEES) out.amount = 'At most ₹2,00,000 at one time.';
  const notes = cleanNote(noteText);
  if (notes.length < MIN_ADMIN_TOPUP_NOTE) out.notes = 'Write why the money is added, for example “stage testing” or “support credit”.';
  else if (notes.length > MAX_ADMIN_TOPUP_NOTE) out.notes = `Use at most ${MAX_ADMIN_TOPUP_NOTE} characters.`;
  if (out.amount || out.notes) return out;
  return { value: { amount: Number(a), notes } };
}

/** The ledger row an admin credit made with `key`, in a newest-first page of the wallet history. */
export const isAdminTopupRow = (m: WalletMovement, key: string) => m.referenceType === 'topup' && m.referenceId === key;

/** How many history pages the fallback search reads at most (20 rows each). */
export const ADMIN_TOPUP_SEARCH_PAGES = 20;

/**
 * What a search of the history for the credit made with `key` found: the row, or not found after reading the whole
 * history (`complete`), or not found within the page limit (`complete: false`: the credit may be older than what was read).
 */
export type AdminTopupSearch = { row: WalletMovement } | { row: null; complete: boolean; searched: number };

/**
 * WQ13 fallback (an older backend without the exact by-key read): looks for the credit made with `key` in the history,
 * newest first, up to `maxPages`. There is no time cut-off (the browser's clock is not trusted for one): it stops at the
 * end of the history or at the page limit. Not finding it proves nothing (the request may still be on its way).
 */
export async function findAdminTopup(fetchPage: (page: number) => Promise<Page<WalletMovement>>, key: string,
  maxPages = ADMIN_TOPUP_SEARCH_PAGES): Promise<AdminTopupSearch> {
  let searched = 0;
  for (let page = 1; page <= maxPages; page++) {
    const p = await fetchPage(page);
    searched += p.items.length;
    const hit = p.items.find((m) => isAdminTopupRow(m, key));
    if (hit) return { row: hit };
    if (page >= p.totalPages || p.items.length === 0) return { row: null, complete: true, searched };
  }
  return { row: null, complete: false, searched };
}

/** The newest admin credit in a newest-first page of the history (shown on the review, so two admins do not credit twice). */
export const latestAdminCredit = (rows: readonly WalletMovement[]): WalletMovement | null =>
  rows.find((m) => m.referenceType === 'topup') ?? null;

/** The words when the credit was not found: by the exact by-key read (`exact`, WQ14 W3(c)), or by the fallback search. */
export function topupNotFoundWords(s: { complete: boolean; searched: number; exact?: boolean }, canResend: boolean): string {
  if (!s.complete) return `Only the latest ${s.searched} movements were searched; the credit may be older. Ask the tech team before adding money again.`;
  return canResend
    ? 'Not added so far. It may still be on its way. Sending the same request again is safe: the money is never added twice.'
    : `Not found${s.exact ? '' : ' in the wallet history'} so far. It may still be on its way. Look at the history again in a minute before adding money again.`;
}

const TOPUP_WORDS: Readonly<Record<string, string>> = {
  PHARMACY_NOT_FOUND: 'This pharmacy was not found. Nothing was added.',
  PHARMACY_ID_REQUIRED: 'Choose a pharmacy first. Nothing was added.',
  IDEMPOTENCY_KEY_REUSED: 'This request was already used with a different amount or note, so nothing more was added. Look at the history below before adding money again.',
  IDEMPOTENCY_KEY_REQUIRED: 'The request was not sent correctly, so nothing was added. Reload the page and try again.',
  VALIDATION_ERROR: 'Check the amount (a whole number of rupees, 1 or more) and the note. Nothing was added.',
};

/** One plain sentence for a failed READ on the wallet screens (never "nothing was added": nothing was being added). */
export function adminWalletReadError(err: unknown): string {
  if (err instanceof ApiError && err.code === 'PHARMACY_NOT_FOUND') return 'This pharmacy was not found.';
  if (err instanceof ApiError && (err.code === 'PHARMACY_ID_REQUIRED' || err.code === 'VALIDATION_ERROR')) return 'This is not a pharmacy that can be read. Choose it from the list.';
  if (err instanceof ApiError && err.status === 403) return 'Only Jansetu admins can see pharmacy wallets.';
  return assistedRefusal(err).message;
}

/** One plain sentence for a refusal of the admin credit. */
export function adminTopupRefusal(err: unknown): string {
  if (err instanceof ApiError && err.code && TOPUP_WORDS[err.code]) return TOPUP_WORDS[err.code]!;
  if (err instanceof ApiError && err.status === 403) return 'Only Jansetu admins can add money to a pharmacy wallet.';
  return assistedRefusal(err).message;
}

/** S6: the warning shown on the form and its review (owner wording). */
/** WQ20: the same words for a lab's wallet. */
export const adminTopupWarning = (owner: 'pharmacy' | 'lab' | 'doctor') =>
  `Do not use this to make up for a card top-up that never arrived. Ask the tech team to run the top-up check instead, or the ${owner} could be paid twice.`;
export const ADMIN_TOPUP_WARNING = adminTopupWarning('pharmacy');

// ── WQ15: card top-ups not credited, closed as already paid by hand (backend r9, design §22) ──

/** One row of `GET /admin/wallet-recharges/uncredited` (`uncreditedTopups`). The record id is what the close names. */
export interface UncreditedTopup {
  paymentTransactionId: string;
  pharmacyId: string;
  /** r13: a lab's top-up names `walletKind: 'lab'` and its `partnerId`; r20: a doctor's `walletKind: 'doctor'` and `specialistId`. */
  walletKind?: 'pharmacy' | 'lab' | 'doctor' | string;
  partnerId?: string;
  specialistId?: string;
  amountMinor: number;
  createdAt: string;
  /** `paid_not_credited`: the card payment was taken; `not_checked_with_gateway`: an attempt nobody checked with Razorpay. */
  state: 'paid_not_credited' | 'not_checked_with_gateway' | string;
  /** Not in the r9 row: shown only if a server adds it. */
  razorpayOrderId?: string;
}

/** The rows of one pharmacy (or, r13, one lab: `walletKind: 'lab'` by `partnerId`), in the server's order, dropping anything malformed. */
export function uncreditedOf(data: unknown, ownerId: string): UncreditedTopup[] {
  if (!Array.isArray(data)) return [];
  const id = ownerId.toLowerCase();
  const ownerOf = (r: UncreditedTopup) => (r.walletKind === 'lab' ? r.partnerId : r.walletKind === 'doctor' ? r.specialistId : r.pharmacyId);
  return data.filter((r): r is UncreditedTopup => !!r && typeof r === 'object'
    && hex.test(String((r as UncreditedTopup).paymentTransactionId)) && String(ownerOf(r as UncreditedTopup) ?? '').toLowerCase() === id
    && Number.isSafeInteger((r as UncreditedTopup).amountMinor));
}

/** 200 of the close and the `closed` by-key read (`closedView`). */
export interface CompensatedClose {
  closed: true; credited: false; replayed: boolean; paymentRecordId: string; pharmacyId: string; amountPaise: number;
  compensatedAt: string; status: string; message?: string;
}

/** `closeCompensatedSchema.reason`: 1–500 characters after trimming. */
export const MAX_CLOSE_REASON = 500;
export function closeReasonProblem(text: string): string | undefined {
  const r = cleanNote(text);
  if (!r) return 'Write why this top-up is closed, for example who paid the pharmacy and how.';
  if (r.length > MAX_CLOSE_REASON) return `Use at most ${MAX_CLOSE_REASON} characters.`;
  return undefined;
}

/** Owner wording: shown on the section and on the confirm step. */
export const CLOSE_COMPENSATED_EXPLAIN =
  'Use this only when Jansetu support already paid this amount to the pharmacy another way. The top-up can then never be credited.';

const CLOSE_WORDS: Readonly<Record<string, string>> = {
  TOPUP_ALREADY_CREDITED: 'This top-up was already credited, nothing to close.',
  TOPUP_REFUNDED: 'This top-up was already refunded to the card, nothing to close.',
  TOPUP_BLOCKED: 'This top-up was already blocked after a lost card dispute. It is never credited, so there is nothing to close.',
  IDEMPOTENCY_KEY_REUSED: 'This request was already used for another top-up or another reason, so nothing was changed. Read the list again, then try again.',
  PAYMENT_AMBIGUOUS: 'More than one top-up carries this payment id, so nothing was changed. Ask the tech team.',
  TOPUP_NOT_FOUND: 'This top-up was not found (it is not a pharmacy card top-up). Nothing was changed.',
  TOPUP_NOT_FOUND_BY_PAYMENT_ID: 'This top-up was not found (it is not a pharmacy card top-up). Nothing was changed.',
  INDEXES_OUTDATED: 'The server needs an update before top-ups can be closed. Nothing was changed. Please ask the Jansetu team.',
  WALLET_CHANGED: 'This top-up changed while it was being closed. Read the list again, then try again.',
  VALIDATION_ERROR: `Write a reason of 1 to ${MAX_CLOSE_REASON} characters. Nothing was changed.`,
};

/** One plain sentence for a refusal of the close (or of its by-key read). */
export function closeCompensatedRefusal(err: unknown): string {
  if (err instanceof ApiError && err.code && CLOSE_WORDS[err.code]) return CLOSE_WORDS[err.code]!;
  if (isSwitchedOff(err)) return 'The admin tools are switched off on this server, so top-ups cannot be closed here. Nothing was changed.';
  if (err instanceof ApiError && err.status === 403) return 'Only Jansetu admins can close a top-up.';
  return assistedRefusal(err).message;
}

/**
 * The close refuses these before any write (`assertAdminToolsOn`, then `assertUniqueIndex`): for a sole first attempt
 * nothing was closed. A 503 without one of these codes (a proxy, a timeout) stays unknown.
 */
export const closeRefusedBeforeWriting = (err: unknown) =>
  err instanceof ApiError && err.status === 503 && (err.code === 'ASSISTED_BOOKING_DISABLED' || err.code === 'INDEXES_OUTDATED');

/**
 * Answers that settle the close on ANY attempt: the top-up can never be closed (credited, refunded to the card, blocked
 * after a dispute, or not a pharmacy top-up). An earlier attempt that did close it would be answered as its closure (`replayed`) instead.
 */
export const closeCompensatedFinal = (err: unknown) => err instanceof ApiError && (err.status === 409 || err.status === 404)
  && ['TOPUP_ALREADY_CREDITED', 'TOPUP_REFUNDED', 'TOPUP_BLOCKED', 'TOPUP_NOT_FOUND'].includes(err.code ?? '');
