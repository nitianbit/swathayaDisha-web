import { ApiError, type ApiClient, type Page } from './client.ts';
import { assistedRefusal, type PharmacyWallet, type WalletMovement } from './assisted.ts';

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

/** The words when the fallback search did not find the credit. */
export function topupNotFoundWords(s: { complete: boolean; searched: number }, canResend: boolean): string {
  if (!s.complete) return `Only the latest ${s.searched} movements were searched; the credit may be older. Ask the tech team before adding money again.`;
  return canResend
    ? 'Not added so far. It may still be on its way. Sending the same request again is safe: the money is never added twice.'
    : 'Not found in the wallet history so far. It may still be on its way. Look at the history again in a minute before adding money again.';
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
export const ADMIN_TOPUP_WARNING =
  'Do not use this to make up for a card top-up that never arrived. Ask the tech team to run the top-up check instead, or the pharmacy could be paid twice.';
