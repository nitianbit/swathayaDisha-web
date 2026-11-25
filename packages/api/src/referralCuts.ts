import { formatPaise } from '@jansetu/i18n';
import { ApiError, type ApiClient, type Page } from './client.ts';
import { LEDGER_KIND_LABEL, STATEMENT_CURSOR_PATTERN, STATEMENT_PAGE_MAX, type StatementLine } from './finance.ts';
import { paiseToInput, rupeesToPaise } from './partnerInvoices.ts';
import { checkId } from './partners.ts';

/**
 * WQ26 referral cuts (assisted booking phase 4a/4b; backend `src1/modules/referralCuts`, ASSISTED_BOOKING_DESIGN.md
 * §26.5, §26.6, §26.15). The cut is paid TO the booking partner, per partner and per category, as a percent of each line
 * or a fixed amount per line, and comes OUT OF the provider's earning (owner, 22 Nov). Doctor cuts stay off (no screen
 * sets them, `REFERRAL_DOCTOR_CUTS_ENABLED`); payouts stay off until the CA answers (O1), so earnings show as due.
 *
 * - Admin (`adminAssistedRouter`, `requireAdmin`): `GET /admin/referral-rules?bookerKind&bookerId` → the rules set, by
 *   category (`effective`: it cuts new bookings now, given the switches); `PUT /admin/referral-rules/:bookerKind/:bookerId/
 *   :category {basis, percentBasisPoints? (1–5000), fixedMinor? (≥ 1), capMinor? (≥ 1), isActive, expectedVersion (0 =
 *   create), reason (1–500)}` → the rule (`putRule`: 400 VALIDATION_ERROR, 404 BOOKER_NOT_FOUND, 409 RECORD_CHANGED, 503
 *   ASSISTED_BOOKING_DISABLED while ASSISTED_ADMIN_TOOLS_ENABLED is off, 503 INDEXES_OUTDATED); `GET …/:category/events` →
 *   one row per version, newest first.
 * - Pharmacy (`pharmacyAssistedRouter`, an operational pharmacy): `GET /pharmacy-assisted/referral-rules` (the list without
 *   `updatedBy`), `GET /pharmacy-assisted/referral` → `{earnedMinor, paidMinor, dueMinor, payoutsEnabled}`, `GET
 *   /pharmacy-assisted/referral/statement?before&limit` → newest first, `pagination.nextCursor` (`statementPage`).
 */

/** The bookers whose cuts work (owner, 22 Nov): pharmacies and labs. */
export type ReferralBookerKind = 'pharmacy' | 'lab';
export const REFERRAL_BOOKER_KINDS: readonly ReferralBookerKind[] = ['pharmacy', 'lab'];
/** `REFERRAL_CATEGORIES` (`assisted/types.ts`): consultations (scheduled and instant), catalogue `test`, catalogue `package`. */
export type ReferralCategory = 'consultation' | 'lab_test' | 'lab_package';
export const REFERRAL_CATEGORIES: readonly ReferralCategory[] = ['consultation', 'lab_test', 'lab_package'];
export const REFERRAL_CATEGORY_LABEL: Record<ReferralCategory, string> = { consultation: 'Consultation', lab_test: 'Lab test', lab_package: 'Lab package' };
export type ReferralBasis = 'percent' | 'fixed';

/** `ruleBodySchema` / `putRule`: a percent rule is 0.01%–50% (1–5,000 basis points); a fixed rule ≥ ₹0.01, with no upper limit. */
export const REFERRAL_PERCENT_MIN_BP = 1;
export const REFERRAL_PERCENT_MAX_BP = 5000;
export const REFERRAL_FIXED_MIN_MINOR = 1;
export const MAX_REFERRAL_REASON = 500;

/** What a rule cuts (the fields `putRule` records in its history). */
export interface ReferralTerms {
  basis: ReferralBasis;
  percentBasisPoints: number | null;
  fixedMinor: number | null;
  /** Per line, optional. */
  capMinor: number | null;
  isActive: boolean;
}

/** `ruleView`: a rule as admins read it (`updatedBy` for admins only). */
export interface ReferralRule extends ReferralTerms {
  _id: string;
  category: ReferralCategory;
  version: number;
  updatedAt?: string;
  /** Active AND the switches let it cut new bookings now (`REFERRAL_CUTS_ENABLED`). */
  effective: boolean;
  updatedBy?: string;
}

/** `referral_rule_events`, one per version (`before` is null when the rule was created). */
export interface ReferralRuleEvent {
  ruleId: string;
  version: number;
  before: Partial<ReferralTerms> | null;
  after: Partial<ReferralTerms>;
  by: string;
  reason: string;
  at: string;
}

export interface ReferralRuleInput {
  basis: ReferralBasis;
  percentBasisPoints?: number;
  fixedMinor?: number;
  capMinor?: number;
  isActive: boolean;
  expectedVersion: number;
  reason: string;
}

/** `GET /pharmacy-assisted/referral`: the pharmacy's `pharmacy_referral` account (`financeSummary`). */
export interface ReferralSummary { earnedMinor: number; paidMinor: number; dueMinor: number; payoutsEnabled: boolean }

/** A statement line of a referral account: an earning carries the booking's base (`grossMinor`); its amount is the cut. */
export interface ReferralStatementLine extends StatementLine { grossMinor?: number; commissionMinor?: number }

// ── Terms: parsing, checking and words ──

/** The terms of a rule, normalised (the other basis's amount dropped), for comparing and for the history. */
export function ruleTerms(t: Partial<ReferralTerms>): ReferralTerms {
  const basis: ReferralBasis = t.basis === 'fixed' ? 'fixed' : 'percent';
  return {
    basis,
    percentBasisPoints: basis === 'percent' ? t.percentBasisPoints ?? null : null,
    fixedMinor: basis === 'fixed' ? t.fixedMinor ?? null : null,
    capMinor: t.capMinor ?? null,
    isActive: t.isActive === true,
  };
}
export const sameRuleTerms = (a: Partial<ReferralTerms>, b: Partial<ReferralTerms>) => JSON.stringify(ruleTerms(a)) === JSON.stringify(ruleTerms(b));

/**
 * A percentage typed by a person → basis points, without floating-point arithmetic ("2.5" → 250, "10%" → 1000). Digits
 * with at most two decimals, 0.01 to 50 (`percentBasisPoints` 1–5000); anything else is null.
 */
export function percentToBasisPoints(text: string): number | null {
  const m = /^(\d{1,2})(?:\.(\d{1,2}))?$/.exec(text.trim().replace(/\s*%$/, ''));
  if (!m) return null;
  const bp = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return bp >= REFERRAL_PERCENT_MIN_BP && bp <= REFERRAL_PERCENT_MAX_BP ? bp : null;
}

/** Basis points as the percentage people type and read ("2.5", "10", "0.01"). */
export function basisPointsToInput(bp: number): string {
  if (!Number.isSafeInteger(bp) || bp < 0) return '';
  const r = bp % 100;
  return r === 0 ? String(bp / 100) : `${Math.floor(bp / 100)}.${String(r).padStart(2, '0').replace(/0$/, '')}`;
}

/** The editor's fields: off, a percent of each line (with an optional cap per line), or a fixed amount per line. */
export type ReferralMode = 'off' | ReferralBasis;
export interface ReferralDraft { mode: ReferralMode; percent: string; fixed: string; cap: string }
export type ReferralDraftErrors = Partial<Record<'percent' | 'fixed' | 'cap', string>>;

export const PERCENT_PROBLEM = 'Enter a percentage from 0.01 to 50, with at most two decimals.';
export const FIXED_PROBLEM = 'Enter the amount per line in rupees, at least ₹0.01, with at most two decimals.';
export const CAP_PROBLEM = 'Enter the cap per line in rupees, at least ₹0.01, or leave it empty.';

/** The editor's starting fields from the rule as saved (an inactive rule keeps its amounts, shown when it is turned on). */
export function referralDraftOf(rule?: ReferralRule | null): ReferralDraft {
  return {
    mode: !rule || !rule.isActive ? 'off' : rule.basis,
    percent: rule?.basis === 'percent' && rule.percentBasisPoints ? basisPointsToInput(rule.percentBasisPoints) : '',
    fixed: rule?.basis === 'fixed' && rule.fixedMinor ? paiseToInput(rule.fixedMinor) : '',
    cap: rule?.basis === 'percent' && rule.capMinor ? paiseToInput(rule.capMinor) : '',
  };
}

/**
 * The terms the fields ask for, checked as `putRule` checks them: a percent of 0.01–50 with an optional cap per line
 * (≥ ₹0.01); a fixed amount ≥ ₹0.01 per line with no upper limit (and no cap: a cap below a fixed amount would only
 * lower it). "Off" keeps the saved amounts and sets `isActive: false`; with no rule saved there is nothing to switch off
 * (`terms` null, no errors).
 */
export function referralTermsOf(d: ReferralDraft, current?: ReferralRule | null): { terms: ReferralTerms | null; errors: ReferralDraftErrors } {
  if (d.mode === 'off') return { terms: current ? { ...ruleTerms(current), isActive: false } : null, errors: {} };
  if (d.mode === 'fixed') {
    const fixed = rupeesToPaise(d.fixed);
    if (fixed === null || fixed < REFERRAL_FIXED_MIN_MINOR) return { terms: null, errors: { fixed: FIXED_PROBLEM } };
    return { terms: { basis: 'fixed', percentBasisPoints: null, fixedMinor: fixed, capMinor: null, isActive: true }, errors: {} };
  }
  const errors: ReferralDraftErrors = {};
  const bp = percentToBasisPoints(d.percent);
  if (bp === null) errors.percent = PERCENT_PROBLEM;
  const cap = d.cap.trim() ? rupeesToPaise(d.cap) : null;
  if (d.cap.trim() && (cap === null || cap < 1)) errors.cap = CAP_PROBLEM;
  if (errors.percent || errors.cap) return { terms: null, errors };
  return { terms: { basis: 'percent', percentBasisPoints: bp, fixedMinor: null, capMinor: cap, isActive: true }, errors };
}

/** The PUT body, checked again before it is sent (a programming error never reaches the server). */
export function referralRuleBody(terms: ReferralTerms, expectedVersion: number, reason: string): ReferralRuleInput {
  const t = ruleTerms(terms);
  const r = reason.trim();
  const whole = (n: number | null, min: number, max = Number.MAX_SAFE_INTEGER) => n !== null && Number.isSafeInteger(n) && n >= min && n <= max;
  if (t.basis === 'percent' && !whole(t.percentBasisPoints, REFERRAL_PERCENT_MIN_BP, REFERRAL_PERCENT_MAX_BP)) throw new Error('Invalid percent');
  if (t.basis === 'fixed' && !whole(t.fixedMinor, REFERRAL_FIXED_MIN_MINOR)) throw new Error('Invalid fixed amount');
  if (t.capMinor !== null && !whole(t.capMinor, 1)) throw new Error('Invalid cap');
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error('Invalid version');
  if (r.length < 1 || r.length > MAX_REFERRAL_REASON) throw new Error('Invalid reason');
  return {
    basis: t.basis,
    ...(t.basis === 'percent' ? { percentBasisPoints: t.percentBasisPoints! } : { fixedMinor: t.fixedMinor! }),
    ...(t.capMinor !== null ? { capMinor: t.capMinor } : {}),
    isActive: t.isActive,
    expectedVersion,
    reason: r,
  };
}

/** What the terms cut, in words: "10% of each line, at most ₹100.00 a line", "₹50.00 a line". */
export function referralTermsText(t: Partial<ReferralTerms>): string {
  const x = ruleTerms(t);
  if (x.basis === 'fixed') return x.fixedMinor ? `${formatPaise(x.fixedMinor)} a line` : '—';
  const pct = x.percentBasisPoints ? `${basisPointsToInput(x.percentBasisPoints)}% of each line` : '—';
  return x.capMinor ? `${pct}, at most ${formatPaise(x.capMinor)} a line` : pct;
}

/** A rule (or a history row's terms) as one short phrase: "Off" (none, or switched off) or its terms. */
export const referralRuleText = (rule: Partial<ReferralTerms> | null | undefined) => (!rule || rule.isActive !== true ? 'Off' : referralTermsText(rule));

/**
 * The master switch (`REFERRAL_CUTS_ENABLED`) as a booker's rules show it: an active rule that does not cut now means it is
 * off. Null when no rule is active (nothing is cut either way, and the list does not say). Pharmacy and lab rules only.
 */
export function referralCutsOn(rules: readonly ReferralRule[]): boolean | null {
  const active = rules.filter((r) => r.isActive);
  return active.length ? active.some((r) => r.effective) : null;
}

// ── Refusals ──

export const REFERRAL_RULE_REFUSAL: Readonly<Record<string, string>> = {
  RECORD_CHANGED: 'This cut was changed by someone else meanwhile, so nothing was saved.',
  BOOKER_NOT_FOUND: 'This partner was not found, so nothing was saved.',
  ASSISTED_BOOKING_DISABLED: 'Changing referral cuts is switched off on the server (assisted-booking admin tools), so nothing was saved.',
  INDEXES_OUTDATED: 'The database needs an update (sync-indexes) before referral cuts can be saved: ask the Jansetu team.',
};

export function referralRuleRefusal(err: unknown): string {
  if (!(err instanceof ApiError)) return err instanceof Error ? err.message : 'Something went wrong. Please try again.';
  return (err.code && REFERRAL_RULE_REFUSAL[err.code]) || err.message;
}

/** `assertAdminToolsOn` and the index checks answer 503 before anything is written: they settle a sole first attempt. */
export const referralRuleRefusedBeforeWriting = (err: unknown) =>
  err instanceof ApiError && err.status === 503 && (err.code === 'ASSISTED_BOOKING_DISABLED' || err.code === 'INDEXES_OUTDATED');

// ── Statement rows ──

/** One referral statement row as the pharmacy reads it: no patient name (the server sends none, M9). */
export interface ReferralRow { _id: string; at: string; ref: string | null; category: string; baseMinor: number | null; cutMinor: number }

/**
 * The row of a statement line. The server words a referral earning "Referral · consultation · <date> · Ref <shortRef>"
 * (`describe`, `partners/services/finance.ts`); the short ref is read from it and the category from `source`, as the
 * lines carry neither as a field (API gap). Other lines (payouts, adjustments) are named by their kind.
 */
export function referralRowOf(l: ReferralStatementLine): ReferralRow {
  const ref = /\bRef ([A-Za-z0-9]{4,16})$/.exec(l.description ?? '')?.[1] ?? null;
  const category = l.source === 'referral_consultation' ? (/instant consultation/i.test(l.description ?? '') ? 'Instant consultation' : 'Consultation')
    : l.source === 'referral_lab_booking' ? 'Lab booking'
      : LEDGER_KIND_LABEL[l.kind] ?? l.kind;
  return { _id: l._id, at: l.at, ref, category, baseMinor: l.kind === 'earning' && typeof l.grossMinor === 'number' ? l.grossMinor : null, cutMinor: l.amountMinor };
}

// ── Routes ──

export const REFERRAL_STATEMENT_PAGE = 50;

const listOf = <T>(rows: T[] | null | undefined): T[] => (Array.isArray(rows) ? rows : []);
function checkBooker(kind: ReferralBookerKind): ReferralBookerKind {
  if (!REFERRAL_BOOKER_KINDS.includes(kind)) throw new Error('Invalid booker');
  return kind;
}
function checkCategory(category: ReferralCategory): ReferralCategory {
  if (!REFERRAL_CATEGORIES.includes(category)) throw new Error('Invalid category');
  return category;
}

/** Admins: a pharmacy's or a lab's rules, their change (version-fenced) and their history. */
export function referralRulesAdminApi(c: ApiClient) {
  const rulePath = (kind: ReferralBookerKind, id: string, category: ReferralCategory) =>
    `/admin/referral-rules/${checkBooker(kind)}/${checkId(id, kind)}/${checkCategory(category)}`;
  return {
    list: (kind: ReferralBookerKind, id: string): Promise<ReferralRule[]> =>
      c.get<ReferralRule[]>('/admin/referral-rules', { query: { bookerKind: checkBooker(kind), bookerId: checkId(id, kind) } }).then(listOf),
    /** Creates (`expectedVersion` 0) or changes the rule; 409 RECORD_CHANGED when it moved since that version. */
    put: (kind: ReferralBookerKind, id: string, category: ReferralCategory, terms: ReferralTerms, expectedVersion: number, reason: string) =>
      c.put<ReferralRule>(rulePath(kind, id, category), { body: referralRuleBody(terms, expectedVersion, reason) }),
    events: (kind: ReferralBookerKind, id: string, category: ReferralCategory): Promise<ReferralRuleEvent[]> =>
      c.get<ReferralRuleEvent[]>(`${rulePath(kind, id, category)}/events`).then(listOf),
  };
}

/** The signed-in pharmacy: its rates (read only), what its cuts earned, and the statement. */
export function pharmacyReferralApi(c: ApiClient) {
  return {
    rules: (): Promise<ReferralRule[]> => c.get<ReferralRule[]>('/pharmacy-assisted/referral-rules').then(listOf),
    summary: () => c.get<ReferralSummary>('/pharmacy-assisted/referral'),
    /** Newest first; `before` is the previous page's `nextCursor` (`<ms>_<entryId>`). */
    statement: (before?: string, limit = REFERRAL_STATEMENT_PAGE): Promise<Page<ReferralStatementLine>> => {
      if (before !== undefined && !STATEMENT_CURSOR_PATTERN.test(before)) throw new Error('Invalid statement cursor');
      if (!Number.isInteger(limit) || limit < 1 || limit > STATEMENT_PAGE_MAX) throw new Error('Invalid limit');
      return c.page<ReferralStatementLine>('/pharmacy-assisted/referral/statement', { query: { before, limit } });
    },
  };
}
