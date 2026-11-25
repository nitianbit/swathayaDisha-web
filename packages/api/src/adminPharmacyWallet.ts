import { ApiError, type ApiClient, type Page } from './client.ts';
import { assistedRefusal, isSwitchedOff, type PharmacyWallet, type WalletMovement } from './assisted.ts';
import type { WalletOwner } from './labWallet.ts';
import { t } from './i18n/admin/index.ts';
import { onLanguage, wordMap } from './i18n/words.ts';

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
// i18n-ignore: a programming error, not shown
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
      // i18n-ignore: a programming error, not shown
      if (!ADMIN_TOPUP_KEY_PATTERN.test(key)) throw new Error('Invalid request key');
      try {
        const r = await c.get<{ state?: string; transaction?: WalletMovement | null } | null>(ADMIN_TOPUP_BY_KEY_PATH(key), { query: { pharmacyId: pharmacyIdOf(pharmacyId) } });
        if (r?.state === 'credited' && r.transaction && typeof r.transaction === 'object') return { state: 'used', row: r.transaction };
        if (r?.state === 'not_found') return { state: 'none' };
        throw new ApiError(502, t('topup.answerUnreadable'));
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
      // i18n-ignore: a programming error, not shown
      if (!hex.test(paymentRecordId)) throw new Error('Invalid payment id');
      // i18n-ignore: a programming error, not shown
      if (!ADMIN_TOPUP_KEY_PATTERN.test(body.requestKey)) throw new Error('Invalid request key');
      const reason = cleanNote(body.reason);
      // i18n-ignore: a guard the screen checks first (closeReasonProblem), not shown
      if (closeReasonFault(reason)) throw new Error('Invalid reason');
      const r = await c.post<Partial<CompensatedClose> | null>(`/admin/wallet-payments/${paymentRecordId.toLowerCase()}/close-compensated`,
        { body: { reason, requestKey: body.requestKey } });
      // WQ15b L1: only a closure is a close; anything else (a 502 here) leaves the request unknown, never claimed closed.
      if (r?.closed !== true) throw new ApiError(502, t('topup.answerUnreadable'));
      return r as CompensatedClose;
    },
    /** r9: did this admin's close with `key` happen? 'closed' with the closure, or 'not_found'. Anything else is thrown. */
    closeCompensatedByKey: async (key: string): Promise<{ state: 'closed'; close: CompensatedClose } | { state: 'not_found' }> => {
      // i18n-ignore: a programming error, not shown
      if (!ADMIN_TOPUP_KEY_PATTERN.test(key)) throw new Error('Invalid request key');
      const r = await c.get<{ state?: string } & Partial<CompensatedClose> | null>(`/admin/wallet-payments/close-compensated/by-key/${key}`);
      if (r?.state === 'closed' && r.closed === true) return { state: 'closed', close: r as CompensatedClose };
      if (r?.state === 'not_found') return { state: 'not_found' };
      throw new ApiError(502, t('topup.answerUnreadable'));
    },
    /** The admin credit: the key in the `Idempotency-Key` header, the same body on every resend. Answers the wallet. */
    topup: (body: AdminTopupBody, idempotencyKey: string) => {
      // i18n-ignore: a programming error, not shown
      if (!ADMIN_TOPUP_KEY_PATTERN.test(idempotencyKey)) throw new Error('Invalid request key');
      // i18n-ignore: a guard the screen checks first (adminTopupForm), not shown
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
  if (!/^\d{1,7}$/.test(a) || Number(a) < 1) out.amount = t('topup.form.amount');
  else if (Number(a) > MAX_ADMIN_TOPUP_RUPEES) out.amount = t('topup.form.amountMax');
  const notes = cleanNote(noteText);
  if (notes.length < MIN_ADMIN_TOPUP_NOTE) out.notes = t('topup.form.note');
  else if (notes.length > MAX_ADMIN_TOPUP_NOTE) out.notes = t('form.maxLength', { max: MAX_ADMIN_TOPUP_NOTE });
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
  if (!s.complete) return t('topup.notFound.partial', { searched: s.searched });
  return canResend ? t('topup.notFound.resend') : s.exact ? t('topup.notFound.exact') : t('topup.notFound.history');
}

const TOPUP_WORDS: Readonly<Record<string, string>> = wordMap(t, {
  PHARMACY_NOT_FOUND: 'topup.refusal.PHARMACY_NOT_FOUND',
  PHARMACY_ID_REQUIRED: 'topup.refusal.PHARMACY_ID_REQUIRED',
  IDEMPOTENCY_KEY_REUSED: 'topup.refusal.IDEMPOTENCY_KEY_REUSED',
  IDEMPOTENCY_KEY_REQUIRED: 'topup.refusal.IDEMPOTENCY_KEY_REQUIRED',
  VALIDATION_ERROR: 'topup.refusal.VALIDATION_ERROR',
});

/** One plain sentence for a failed READ on the wallet screens (never "nothing was added": nothing was being added). */
export function adminWalletReadError(err: unknown): string {
  if (err instanceof ApiError && err.code === 'PHARMACY_NOT_FOUND') return t('topup.read.notFound');
  if (err instanceof ApiError && (err.code === 'PHARMACY_ID_REQUIRED' || err.code === 'VALIDATION_ERROR')) return t('topup.read.notReadable');
  if (err instanceof ApiError && err.status === 403) return t('topup.read.forbidden');
  return assistedRefusal(err).message;
}

/** One plain sentence for a refusal of the admin credit. */
export function adminTopupRefusal(err: unknown): string {
  if (err instanceof ApiError && err.code && TOPUP_WORDS[err.code]) return TOPUP_WORDS[err.code]!;
  if (err instanceof ApiError && err.status === 403) return t('topup.refusal.forbidden');
  return assistedRefusal(err).message;
}

/** S6: the warning shown on the form and its review (owner wording). */
/** WQ20: the same words for a lab's wallet. */
const TOPUP_WARNING: Readonly<Record<WalletOwner, string>> = wordMap(t, {
  pharmacy: 'topup.warning.pharmacy', lab: 'topup.warning.lab', doctor: 'topup.warning.doctor',
});
export const adminTopupWarning = (owner: WalletOwner) => TOPUP_WARNING[owner];
export let ADMIN_TOPUP_WARNING = '';
onLanguage(() => { ADMIN_TOPUP_WARNING = adminTopupWarning('pharmacy'); });

// ── WQ15: card top-ups not credited, closed as already paid by hand (backend r9, design §22) ──

/** One row of `GET /admin/wallet-recharges/uncredited` (`uncreditedTopups`). The record id is what the close names. */
export interface UncreditedTopup {
  paymentTransactionId: string;
  pharmacyId: string;
  /** r13: a lab's top-up names `walletKind: 'lab'` and its `partnerId`; r20: a doctor's `walletKind: 'doctor'` and `specialistId`. */
  walletKind?: WalletOwner | string;
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
const closeReasonFault = (r: string): 'empty' | 'long' | null => (!r ? 'empty' : r.length > MAX_CLOSE_REASON ? 'long' : null);
const CLOSE_REASON_EMPTY: Readonly<Record<WalletOwner, string>> = wordMap(t, {
  pharmacy: 'compensated.reason.pharmacy', lab: 'compensated.reason.lab', doctor: 'compensated.reason.doctor',
});
export function closeReasonProblem(text: string, owner: WalletOwner): string | undefined {
  const fault = closeReasonFault(cleanNote(text));
  if (fault === 'empty') return CLOSE_REASON_EMPTY[owner];
  if (fault === 'long') return t('form.maxLength', { max: MAX_CLOSE_REASON });
  return undefined;
}

/** Owner wording: shown on the section and on the confirm step. */
const CLOSE_EXPLAIN: Readonly<Record<WalletOwner, string>> = wordMap(t, {
  pharmacy: 'compensated.explain.pharmacy', lab: 'compensated.explain.lab', doctor: 'compensated.explain.doctor',
});
export const closeCompensatedExplain = (owner: WalletOwner) => CLOSE_EXPLAIN[owner];

const CLOSE_WORDS: Readonly<Record<string, string>> = wordMap(t, {
  TOPUP_ALREADY_CREDITED: 'compensated.refusal.TOPUP_ALREADY_CREDITED',
  TOPUP_REFUNDED: 'compensated.refusal.TOPUP_REFUNDED',
  TOPUP_BLOCKED: 'compensated.refusal.TOPUP_BLOCKED',
  IDEMPOTENCY_KEY_REUSED: 'compensated.refusal.IDEMPOTENCY_KEY_REUSED',
  PAYMENT_AMBIGUOUS: 'compensated.refusal.PAYMENT_AMBIGUOUS',
  TOPUP_NOT_FOUND: 'compensated.refusal.TOPUP_NOT_FOUND',
  TOPUP_NOT_FOUND_BY_PAYMENT_ID: 'compensated.refusal.TOPUP_NOT_FOUND',
  INDEXES_OUTDATED: 'compensated.refusal.INDEXES_OUTDATED',
  WALLET_CHANGED: 'compensated.refusal.WALLET_CHANGED',
});

/** One plain sentence for a refusal of the close (or of its by-key read). */
export function closeCompensatedRefusal(err: unknown): string {
  if (err instanceof ApiError && err.code === 'VALIDATION_ERROR') return t('compensated.refusal.VALIDATION_ERROR', { max: MAX_CLOSE_REASON });
  if (err instanceof ApiError && err.code && CLOSE_WORDS[err.code]) return CLOSE_WORDS[err.code]!;
  if (isSwitchedOff(err)) return t('compensated.refusal.switchedOff');
  if (err instanceof ApiError && err.status === 403) return t('compensated.refusal.forbidden');
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
