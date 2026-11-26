import type { ApiClient, Page } from './client.ts';
import { isRealDate } from './partnerLabs.ts';

/**
 * WQ54 (P1, the simple pharmacy home; backend r37, stage 950417ab): the day's register
 * (`GET /pharmacy-assisted/today?date&cursor&limit`: every order, consultation, lab booking and wallet top-up MADE at the
 * counter on an India day, oldest first, in cursor pages; the whole day's money by method on every page; what is pending on
 * the first page) and the pharmacy's shared to-dos (`/pharmacy-assisted/todos`: a create once per request key, an edit
 * fenced by the version it was made on). Paise throughout.
 */

export type TodayKind = 'order' | 'consultation' | 'lab_booking' | 'wallet_topup';
export type TodayLinkKind = 'pharmacy_order' | 'booking' | 'lab_booking' | 'wallet_transaction';
export interface TodayItem {
  kind: TodayKind | string;
  id: string;
  at: string;
  shortRef: string | null;
  /** The name this pharmacy may show (typed, else masked). */
  patientName: string | null;
  /** The server's ready-made line ("Dolo 650 +1 more", "Dr Kavya · 11:30 · video"): data, shown as sent. */
  what: string;
  amountMinor: number;
  paid: boolean;
  method: PaymentMethodKey | null;
  status: string;
  /** The record that shows it. */
  link: { kind: TodayLinkKind | string; id: string } | null;
}
export type PaymentMethodKey = 'cash' | 'upi' | 'card' | 'wallet' | 'online' | 'other';
export const PAYMENT_METHOD_KEYS: readonly PaymentMethodKey[] = ['cash', 'upi', 'card', 'wallet', 'online', 'other'];
/** The whole day's money (a wallet top-up is listed but not collected). */
export interface TodayTotals { collectedMinor: number; byMethod: Partial<Record<PaymentMethodKey, number>>; unpaidMinor: number; count: number }
interface Counted { count: number }
/** What waits (the first page only). */
export interface TodayPending {
  prescriptionsToReview?: Counted & { ids?: string[] };
  unpaidCounterSales?: Counted & { ids?: string[] };
  bookingsAwaiting?: Counted & { consultationIds?: string[]; labBookingIds?: string[] };
  labReportsReady?: Counted & { ids?: string[] };
  lowStock?: Counted & { ids?: string[] };
}
export const PENDING_KEYS = ['prescriptionsToReview', 'unpaidCounterSales', 'bookingsAwaiting', 'labReportsReady', 'lowStock'] as const;
export type PendingKey = (typeof PENDING_KEYS)[number];
export interface TodayAnswer { date?: string; items: TodayItem[]; totals: TodayTotals; pending?: TodayPending; truncated?: boolean; nextCursor: string | null }

/** `todo` (shared within the pharmacy; `createdBy.name` is who added it). */
export interface Todo {
  _id: string; text: string; dueAt?: string | null; done: boolean; doneAt?: string | null; version: number;
  createdBy?: { kind: string; id: string; name?: string | null } | null; createdAt?: string; updatedAt?: string;
}
export const MAX_TODO_TEXT = 200;
export const TODAY_PAGE_MAX = 200;
const KEY = /^[A-Za-z0-9_-]{8,64}$/;
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const CURSOR = /^[A-Za-z0-9_.:-]{1,200}$/;

/** A to-do's text as sent (trimmed, single spaces), or null when it is empty or too long. */
export function todoText(raw: string): string | null {
  const text = raw.trim().replace(/\s+/g, ' ');
  return text && text.length <= MAX_TODO_TEXT ? text : null;
}

const check = (ok: boolean, what: string) => {
  if (!ok) throw new Error(`Invalid ${what}`); // i18n-ignore: a programming error, the screens check first
};

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
/** The answer in its shape whatever the server sent (a missing part is empty, never a crash). */
export function todayOf(raw: unknown): TodayAnswer {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Partial<TodayAnswer>;
  const t = (r.totals && typeof r.totals === 'object' ? r.totals : {}) as Partial<TodayTotals>;
  return {
    ...(typeof r.date === 'string' ? { date: r.date } : {}),
    items: Array.isArray(r.items) ? r.items.filter((i): i is TodayItem => !!i && typeof i === 'object' && typeof (i as TodayItem).id === 'string') : [],
    totals: { collectedMinor: num(t.collectedMinor), byMethod: t.byMethod && typeof t.byMethod === 'object' ? t.byMethod : {}, unpaidMinor: num(t.unpaidMinor), count: num(t.count) },
    ...(r.pending && typeof r.pending === 'object' ? { pending: r.pending } : {}),
    ...(r.truncated === true ? { truncated: true } : {}),
    nextCursor: typeof r.nextCursor === 'string' && r.nextCursor ? r.nextCursor : null,
  };
}

/** A waiting kind's count (0 when the server does not say). */
export const pendingCount = (p: TodayPending | undefined, k: PendingKey) => {
  const n = Number(p?.[k]?.count ?? 0);
  return Number.isInteger(n) && n > 0 ? n : 0;
};

export function pharmacyTodayApi(c: ApiClient) {
  const todo = (id: string) => { check(OBJECT_ID.test(id), 'to-do'); return `/pharmacy-assisted/todos/${id}`; };
  return {
    /** One India day's register (YYYY-MM-DD; none = today), oldest first, one cursor page (1–200 rows). */
    today: (q: { date?: string; cursor?: string; limit?: number } = {}) => {
      check(q.date === undefined || isRealDate(q.date), 'date');
      check(q.cursor === undefined || CURSOR.test(q.cursor), 'cursor');
      check(q.limit === undefined || (Number.isInteger(q.limit) && q.limit >= 1 && q.limit <= TODAY_PAGE_MAX), 'limit');
      return c.get<unknown>('/pharmacy-assisted/today', { query: { date: q.date, cursor: q.cursor, limit: q.limit } }).then(todayOf);
    },
    /** Newest first; open and done alike. */
    todos: (q: { done?: boolean; cursor?: string; limit?: number } = {}): Promise<Page<Todo>> =>
      c.page<Todo>('/pharmacy-assisted/todos', { query: { done: q.done, cursor: q.cursor, limit: q.limit } }),
    /** Once per key: the same key and text answer the first to-do again (`replayed`). */
    addTodo: (text: string, requestKey: string) => {
      const clean = todoText(text);
      check(clean !== null, 'to-do text');
      check(KEY.test(requestKey), 'request key');
      return c.post<{ todo: Todo; replayed: boolean }>('/pharmacy-assisted/todos', { body: { text: clean, requestKey } });
    },
    /** Fenced: 409 TODO_CHANGED if the to-do changed since `expectedVersion`. */
    setDone: (id: string, done: boolean, expectedVersion: number) => c.patch<Todo>(todo(id), { body: { done, expectedVersion } }),
    remove: (id: string) => c.delete<{ deleted: boolean }>(todo(id)),
  };
}

/** Today's money in one line's parts: the methods with money (cash, UPI and wallet always). */
export function moneyParts(t: TodayTotals): { key: PaymentMethodKey; minor: number }[] {
  return PAYMENT_METHOD_KEYS.map((key) => ({ key, minor: Number(t.byMethod?.[key] ?? 0) }))
    .filter((p) => Number.isFinite(p.minor) && (p.minor > 0 || p.key === 'cash' || p.key === 'upi' || p.key === 'wallet'));
}

/** The app page of a register row's record (the existing detail pages), or null. */
export function todayLink(i: Pick<TodayItem, 'link'>): string | null {
  const l = i.link;
  if (!l || !OBJECT_ID.test(String(l.id))) return null;
  if (l.kind === 'pharmacy_order') return `/pharmacy/orders/${l.id}`;
  if (l.kind === 'booking') return `/pharmacy/consultations/${l.id}`;
  if (l.kind === 'lab_booking') return `/pharmacy/lab-tests/${l.id}`;
  if (l.kind === 'wallet_transaction') return '/pharmacy/wallet';
  return null;
}
