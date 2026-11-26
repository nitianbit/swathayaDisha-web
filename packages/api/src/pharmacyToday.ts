import type { ApiClient } from './client.ts';
import { isRealDate } from './partnerLabs.ts';

/**
 * WQ54 (P1, the simple pharmacy home; backend r37, built in parallel: these are the coordinator's draft shapes): the
 * day's register (`GET /pharmacy-assisted/today?date=`: every visit, sale, test and bill of an India day, its money by
 * method and what is still pending) and the pharmacy's shared to-dos (`/pharmacy-assisted/todos`: a create once per request
 * key, an edit fenced by the version it was made on). Paise throughout.
 */

/** What a register row is (the server's code; a code this app does not know is shown by its `what`). */
export type TodayKind = 'sale' | 'consultation' | 'instant' | 'lab' | string;
export interface TodayItem {
  kind: TodayKind;
  id: string;
  at: string;
  shortRef: string | null;
  /** The name this pharmacy may show (typed, else masked). */
  patientName: string | null;
  /** The server's plain words for the row ("Dr Kavya video", "medicines"). */
  what: string;
  amountMinor: number;
  paid: boolean;
  /** How it was paid (`cash`, `upi`, `card`, `wallet`, `online`, `other`), or null. */
  method: string | null;
  status: string;
  /** The page that shows it (an app path), when the server names one. */
  link: string | null;
}
export type PaymentMethodKey = 'cash' | 'upi' | 'card' | 'wallet' | 'online' | 'other';
export const PAYMENT_METHOD_KEYS: readonly PaymentMethodKey[] = ['cash', 'upi', 'card', 'wallet', 'online', 'other'];
export interface TodayTotals { collectedMinor: number; byMethod: Partial<Record<PaymentMethodKey, number>>; unpaidMinor: number; count: number }
/** Work still waiting (each a count; a key this app does not know is left out). */
export interface TodayPending { prescriptions?: number; unpaidSales?: number; labReports?: number; consultations?: number }
export const PENDING_KEYS = ['prescriptions', 'unpaidSales', 'labReports', 'consultations'] as const;
export interface TodayAnswer { date?: string; items: TodayItem[]; totals: TodayTotals; pending: TodayPending }

export interface Todo { _id: string; text: string; done: boolean; version: number; createdAt?: string; createdByName?: string | null }
export const MAX_TODO_TEXT = 200;
const KEY = /^[A-Za-z0-9_-]{8,64}$/;
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

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
    pending: r.pending && typeof r.pending === 'object' ? r.pending : {},
  };
}

export function pharmacyTodayApi(c: ApiClient) {
  const todo = (id: string) => { check(OBJECT_ID.test(id), 'to-do'); return `/pharmacy-assisted/todos/${id}`; };
  return {
    /** One India day's register (YYYY-MM-DD; none = today). */
    today: (date?: string) => {
      check(date === undefined || isRealDate(date), 'date');
      return c.get<unknown>('/pharmacy-assisted/today', { query: { date } }).then(todayOf);
    },
    todos: () => c.get<Todo[]>('/pharmacy-assisted/todos').then((r) => (Array.isArray(r) ? r : [])),
    /** Once per key: the same key answers the first to-do again. */
    addTodo: (text: string, requestKey: string) => {
      const clean = todoText(text);
      check(clean !== null, 'to-do text');
      check(KEY.test(requestKey), 'request key');
      return c.post<Todo>('/pharmacy-assisted/todos', { body: { text: clean, requestKey } });
    },
    /** Fenced: refused (409) if the to-do changed since `expectedVersion`. */
    setDone: (id: string, done: boolean, expectedVersion: number) => c.patch<Todo>(todo(id), { body: { done, expectedVersion } }),
    remove: (id: string, expectedVersion: number) => c.delete<unknown>(todo(id), { query: { expectedVersion } }),
  };
}

/** Today's money in one line's parts: collected, the methods with money (cash, UPI and wallet always), and unpaid. */
export function moneyParts(t: TodayTotals): { key: PaymentMethodKey; minor: number }[] {
  return PAYMENT_METHOD_KEYS.map((key) => ({ key, minor: Number(t.byMethod?.[key] ?? 0) }))
    .filter((p) => Number.isFinite(p.minor) && (p.minor > 0 || p.key === 'cash' || p.key === 'upi' || p.key === 'wallet'));
}
