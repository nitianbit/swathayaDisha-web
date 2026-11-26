import './home.css';
import { useState, type FormEvent } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { CalendarDays, Pill, Plus, Search } from 'lucide-react';
import {
  ApiError, bookingsWaiting, CONSULT_MODE_LABEL, istToday, MAX_TODO_TEXT, moneyParts, OBJECT_ID_PATTERN, PAYMENT_METHOD_KEYS, PENDING_KEYS, pendingCount,
  pharmacyTodayApi, TODAY_PAGE_MAX, TODAY_SEARCH_MAX, TODAY_SEARCH_MIN, todayLink, todoText,
  type ConsultMode, type PaymentMethodKey, type PendingKey, type TodayAnswer, type TodayItem, type Todo,
} from '@jansetu/api';
import { CALENDAR_DATE, formatClock, formatDateWith, formatPaise } from '@jansetu/i18n';
import { Alert, Badge, Button, Empty, Loading, Parts, TextField } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { t } from '../../i18n/home/index.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { definitelyNotRecorded, newRequestKey } from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { usePharmacyId } from './ownedOp.tsx';
import { HomeButton } from './visitBar.tsx';

/**
 * WQ54 (P1, SIMPLE_DESIGN_PLAN_2026-11-26) / WQ54b: the simple pharmacy home, for a counter clerk used to a paper
 * register, on any device: four big buttons (+ New, Find patient, Sell medicines, Today), the day's money, what is waiting,
 * the latest 10 entries (newest first) and the pharmacy's to-dos. The menu stays (the side menu; "More" on a phone). Big
 * type and 48 px targets (`home.css`). Without internet: a plain message and Try again, keeping what was typed.
 */

/** No internet (or no answer in time): one plain sentence; anything else in the server's words. */
export function homeWords(err: unknown): string {
  return err instanceof ApiError && (err.code === 'NETWORK' || err.code === 'TIMEOUT') ? t('offline') : messageOf(err);
}

/** A failed read in plain words, with one big Try again. */
export function Failed({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div className="simple-failed" role="alert">
      <p>{homeWords(error)}</p>
      <Button onClick={onRetry}>{t('tryAgain')}</Button>
    </div>
  );
}

export const todayKey = (pharmacyId: string, date: string) => ['pharmacy-today', pharmacyId, date] as const;
const HOME_ROWS = 10;
const isOldestFirst = (items: readonly TodayItem[]) => items.length > 1 && Date.parse(items[0]!.at) < Date.parse(items[items.length - 1]!.at);

/**
 * The home's read: the day's money and what waits, and its latest 10 rows, newest first (r37c `order=desc`). A server
 * before r37c lists oldest first whatever is asked: its pages are followed to the last one for the latest 10.
 */
async function latestRows(today: ReturnType<typeof pharmacyTodayApi>['today'], date: string): Promise<TodayAnswer> {
  const first = await today({ date, order: 'desc', limit: HOME_ROWS });
  if (!isOldestFirst(first.items)) return first;
  let before: TodayItem[] = [];
  let page = first;
  for (let n = 0; page.nextCursor && n < 50; n += 1) {
    before = page.items;
    page = await today({ date, cursor: page.nextCursor, limit: TODAY_PAGE_MAX });
  }
  return { ...first, items: [...before, ...page.items].slice(-HOME_ROWS).reverse() };
}

export function useToday(pharmacyId: string, date: string) {
  const { api } = useSession();
  // Always read again when a page shows it: a sale or a booking made on another page has just changed the day.
  return useQuery({ queryKey: [...todayKey(pharmacyId, date), 'home'], queryFn: () => latestRows(pharmacyTodayApi(api).today, date),
    staleTime: 0, refetchOnMount: 'always' });
}

export function PharmacyHome() {
  const pharmacyId = usePharmacyId();
  const day = istToday();
  const q = useToday(pharmacyId, day);
  return (
    <div className="simple">
      <nav className="big-actions" aria-label={t('big.label')}>
        <Link className="big-action big-action--main" to="/pharmacy/new"><Plus size={28} aria-hidden="true" />{t('big.new')}</Link>
        <Link className="big-action" to="/pharmacy/new?find=1"><Search size={28} aria-hidden="true" />{t('big.find')}</Link>
        <Link className="big-action" to="/pharmacy/sale"><Pill size={28} aria-hidden="true" />{t('big.sell')}</Link>
        <Link className="big-action" to="/pharmacy/today"><CalendarDays size={28} aria-hidden="true" />{t('big.today')}</Link>
      </nav>
      <section className="ws-section" aria-labelledby="reg-h">
        <h2 id="reg-h">{t('register.title')}</h2>
        {!q.data ? (q.isError ? <Failed error={q.error} onRetry={() => void q.refetch()} /> : <Loading label={t('register.loading')} />) : (
          <>
            <MoneyLine day={q.data} date={day} />
            <PendingStrip day={q.data} />
            <Register items={q.data.items} date={day} />
            {(q.data.nextCursor || q.data.totals.count > q.data.items.length) && (
              <p><Link className="j-btn j-btn--secondary" to="/pharmacy/today">{t('register.all')}</Link></p>
            )}
          </>
        )}
      </section>
      <Todos pharmacyId={pharmacyId} />
    </div>
  );
}

/** An India date (YYYY-MM-DD) as people read it ("24 Nov 2026"). */
const formatDay = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? formatDateWith(Date.parse(`${d}T00:00:00Z`), CALENDAR_DATE) : d);

/** "Collected today ₹820", then the methods that took money ("Cash ₹320 · Wallet ₹500"), then "To collect ₹x". */
export function MoneyLine({ day, date }: { day: TodayAnswer; date: string }) {
  const collected = formatPaise(day.totals.collectedMinor);
  const methods = moneyParts(day.totals).map((p) => t(`money.${p.key}`, { amount: formatPaise(p.minor) }));
  const due = day.totals.unpaidMinor;
  return (
    <section className="money-line" aria-label={t('money.label')}>
      <p className="money-main">{date === istToday() ? t('money.collectedToday', { amount: collected }) : t('money.collectedOn', { date: formatDay(date), amount: collected })}</p>
      {methods.length > 0 && <p className="money-methods">{methods.join(' · ')}</p>}
      <p className={due > 0 ? 'money-due money-due--warn' : 'money-due'}>{t('money.toCollect', { amount: formatPaise(due) })}</p>
    </section>
  );
}

/** The one record's page when the list names exactly one, else the list page. */
const oneOr = (ids: readonly string[] | undefined, count: number, one: (id: string) => string, list: string) =>
  (count === 1 && ids?.length === 1 && OBJECT_ID_PATTERN.test(ids[0]!) ? one(ids[0]!) : list);

type PendingLine = { id: string; text: string; to: string | null };
/** What is waiting in lines, each with where it is done (r37c: bookings waiting for payment, by kind). */
function pendingLines(day: TodayAnswer): PendingLine[] {
  const p = day.pending;
  const lines: PendingLine[] = [];
  const add = (k: Exclude<PendingKey, 'bookingsAwaiting'>, to: string) => {
    const n = pendingCount(p, k);
    if (n === null) lines.push({ id: k, text: t(`pending.failed.${k}`), to: null });
    else if (n > 0) lines.push({ id: k, text: t(`pending.${k}`, { count: n }), to });
  };
  for (const k of PENDING_KEYS) {
    if (k === 'prescriptionsToReview') add(k, '/pharmacy/prescriptions');
    else if (k === 'unpaidCounterSales') add(k, oneOr(p?.unpaidCounterSales?.ids, pendingCount(p, k) ?? 0, (id) => `/pharmacy/sale/${id}`, '/pharmacy/orders'));
    else if (k === 'labReportsReady') add(k, '/pharmacy/lab-tests');
    else if (k === 'lowStock') add(k, '/pharmacy/low-stock');
    else {
      const n = pendingCount(p, k);
      const b = bookingsWaiting(p);
      if (n === null || !b) { lines.push({ id: k, text: t('pending.failed.bookingsAwaiting'), to: null }); continue; }
      const ba = p?.bookingsAwaiting;
      if (b.consultations > 0) {
        lines.push({ id: 'consultations', text: t('pending.doctorPayments', { count: b.consultations }),
          to: oneOr(ba?.consultationIds, b.consultations, (id) => `/pharmacy/consultations/${id}`, '/pharmacy/consultations') });
      }
      if (b.labBookings > 0) {
        lines.push({ id: 'labBookings', text: t('pending.labPayments', { count: b.labBookings }),
          to: oneOr(ba?.labBookingIds, b.labBookings, (id) => `/pharmacy/lab-tests/${id}`, '/pharmacy/lab-tests') });
      }
      if (n > 0 && b.consultations + b.labBookings === 0) lines.push({ id: k, text: t('pending.bookingsAwaiting', { count: n }), to: '/pharmacy/consultations' });
    }
  }
  return lines;
}

/** What is waiting, each a link to where it is done; a list that could not be read is said on its own line. */
export function PendingStrip({ day }: { day: TodayAnswer }) {
  if (!day.pending) return null;
  const lines = pendingLines(day);
  return (
    <div className="pending-strip" aria-label={t('pending.title')} role="group">
      {lines.length === 0 ? <span className="ws-muted">{t('pending.none')}</span>
        : lines.map((x) => (x.to === null
          ? <span key={x.id} className="pending-item pending-item--failed">{x.text}</span>
          : <Link key={x.id} className="pending-item" to={x.to}>{x.text}</Link>))}
    </div>
  );
}

const methodWords = (m: string | null) => (m && (PAYMENT_METHOD_KEYS as readonly string[]).includes(m) ? t(`method.${m as PaymentMethodKey}`) : m);
const present = (v: unknown): v is string | number => (typeof v === 'string' && v.trim() !== '') || typeof v === 'number';

/** r37c: a row's line in the app's words (`whatParts`; names stay data); the server's English `what` when not known. */
export function whatWords(i: Pick<TodayItem, 'what' | 'whatParts'>): string {
  const p = i.whatParts;
  const v = p?.values ?? {};
  const list = (none: string) => (!present(v.first) ? none : Number(v.more) > 0 ? t('what.more', { first: String(v.first), more: Number(v.more) }) : String(v.first));
  const mode = present(v.mode) ? CONSULT_MODE_LABEL[v.mode as ConsultMode] ?? String(v.mode) : null;
  switch (p?.code) {
    case 'order.items': return list(t('what.counter'));
    case 'order.counter': return t('what.counter');
    case 'order.online': return t('what.online');
    case 'lab.tests': return list(t('what.labTests'));
    case 'wallet.topup': return t('what.topup');
    case 'consult.scheduled':
    case 'consult.instant': {
      const when = p.code === 'consult.instant' ? t('what.now') : present(v.time) ? String(v.time) : null;
      const parts = [present(v.doctor) ? String(v.doctor) : null, when, mode].filter((x): x is string => !!x);
      return parts.length ? parts.join(' · ') : t('what.consultation');
    }
    default: return String(i.what ?? '');
  }
}

/**
 * The register: the time, who and what (tap to open), the amount, paid or not. `date`: the register's day (an earlier
 * day's entry paid that day says so).
 */
export function Register({ items, date }: { items: readonly TodayItem[]; date: string }) {
  if (items.length === 0) return <Empty title={t('register.none')}>{t('register.noneText')}</Empty>;
  return (
    <ul className="register" aria-label={t('register.caption')}>
      {items.map((i) => {
        const to = todayLink(i);
        // A wallet top-up has no patient: no name is said for it.
        const who = i.patientName ?? (i.kind === 'wallet_topup' ? null : t('register.noName'));
        const words = <>{who ? <Parts of={t.rich('register.line', { who: <strong>{who}</strong>, what: whatWords(i) })} /> : whatWords(i)}{i.shortRef ? <span className="ws-muted">{` · ${i.shortRef}`}</span> : null}</>;
        const at = Date.parse(i.at);
        return (
          <li key={`${i.kind}:${i.id}`} className="register-row">
            <span className="register-time">{Number.isNaN(at) ? '' : formatClock(at)}</span>{' '}
            <span className="register-item">{to ? <Link to={to}>{words}</Link> : words}</span>
            <span className="register-pay">
              <span className="register-amount">{formatPaise(i.amountMinor)}</span>{' '}
              {i.paid ? <Badge tone="ok">{i.method ? t('register.paidBy', { method: methodWords(i.method) ?? '' }) : t('register.paid')}</Badge>
                : <Badge tone="warn">{t('register.unpaid')}</Badge>}
              {i.paidToday && i.madeOn && i.madeOn !== date && <span className="register-note">{t('register.paidTodayMade', { date: formatDay(i.madeOn) })}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The pharmacy's shared to-dos: add (once per request key: a lost answer is sent again with the same key, the text kept),
 * and tick (fenced by the version shown; a change made meanwhile is read again and said).
 */
export function Todos({ pharmacyId }: { pharmacyId: string }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const todos = pharmacyTodayApi(api);
  const key = ['pharmacy-todos', pharmacyId];
  const q = useQuery({ queryKey: key, queryFn: () => todos.todos({ limit: 100 }) });
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [requestKey, setRequestKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  /** A tick shows at once; the list read again after the answer is the truth (a refusal puts it back). */
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const reread = () => queryClient.invalidateQueries({ queryKey: key });

  async function add(e: FormEvent) {
    e.preventDefault();
    setNote(null);
    const clean = todoText(text);
    if (!clean) { setError(t('todos.textError', { max: MAX_TODO_TEXT })); return; }
    setError(null);
    // The key stays with the text until it is answered: Try again sends the same to-do again, never a second one.
    const k = requestKey ?? newRequestKey();
    setRequestKey(k);
    setBusy(true);
    try {
      await todos.addTodo(clean, k);
      setText(''); setRequestKey(null);
      await reread();
    } catch (err) {
      if (definitelyNotRecorded(err)) setRequestKey(null);
      const code = err instanceof ApiError ? err.code : undefined;
      // r37b: 500 open to-dos at most; a key already used (also a deleted to-do's) needs a new one: Add sends one.
      setError(code === 'TODO_LIMIT' ? t('todos.limit') : code === 'IDEMPOTENCY_KEY_REUSED' ? t('todos.keyReused') : homeWords(err));
    } finally {
      setBusy(false);
    }
  }

  async function tick(x: Todo, done: boolean) {
    setNote(null);
    setTicked((m) => ({ ...m, [x._id]: done }));
    try {
      await todos.setDone(x._id, done, x.version);
    } catch (err) {
      setNote(err instanceof ApiError && err.code === 'TODO_CHANGED' ? t('todos.changed') : homeWords(err));
    } finally {
      await reread();
      setTicked((m) => { const { [x._id]: _gone, ...rest } = m; return rest; });
    }
  }

  return (
    <section className="ws-section" aria-labelledby="todo-h">
      <h2 id="todo-h">{t('todos.title')}</h2>
      <form className="todo-add" noValidate onSubmit={(e) => void add(e)}>
        <TextField label={t('todos.new')} hint={t('todos.newHint')} value={text} maxLength={MAX_TODO_TEXT} autoComplete="off" error={error}
          onChange={(e) => { setText(e.target.value); setRequestKey(null); }} />
        <Button type="submit" busy={busy}>{error && requestKey ? t('tryAgain') : t('todos.add')}</Button>
      </form>
      {note && <Alert tone="warn">{note}</Alert>}
      {!q.data ? (q.isError ? <Failed error={q.error} onRetry={() => void q.refetch()} /> : <Loading label={t('todos.loading')} />)
        : q.data.items.length === 0 ? <p className="ws-muted">{t('todos.none')}</p>
        : (
          <ul className="todo-list">
            {q.data.items.map((x) => (
              <li key={x._id}>
                <label className={(ticked[x._id] ?? x.done) ? 'todo todo--done' : 'todo'}>
                  <input type="checkbox" checked={ticked[x._id] ?? x.done} onChange={(e) => void tick(x, e.target.checked)} />
                  <span>{x.text}</span>
                </label>
                {x.createdBy?.name && <span className="ws-muted">{t('todos.by', { who: x.createdBy.name })}</span>}
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}

/**
 * Today (`/pharmacy/today`): one India day's full register, newest first (an earlier day by its date), in pages of 50 with
 * Show more; the whole day's money and what waits. r37c: a search covers the whole day on the server (a POST).
 */
export function TodayScreen() {
  const pharmacyId = usePharmacyId();
  const { api } = useSession();
  const today = pharmacyTodayApi(api);
  const [date, setDate] = useState(() => istToday());
  const [text, setText] = useState('');
  const [searched, setSearched] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const pages = { initialPageParam: undefined as string | undefined, getNextPageParam: (last: TodayAnswer) => last.nextCursor ?? undefined,
    staleTime: 0, refetchOnMount: 'always' as const };
  const q = useInfiniteQuery({ queryKey: [...todayKey(pharmacyId, date), 'pages'], ...pages,
    queryFn: ({ pageParam }) => today.today({ date, order: 'desc', limit: 50, cursor: pageParam }) });
  const found = useInfiniteQuery({ queryKey: [...todayKey(pharmacyId, date), 'search', searched], ...pages, enabled: searched !== null,
    queryFn: ({ pageParam }) => today.search({ date, q: searched ?? '', order: 'desc', limit: 50, cursor: pageParam }) });
  const first = q.data?.pages[0];
  const list = searched !== null ? found : q;
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];

  function search(e: FormEvent) {
    e.preventDefault();
    const s = text.trim();
    if (!s) { setSearched(null); setSearchError(null); return; }
    const ok = s.length >= TODAY_SEARCH_MIN && s.length <= TODAY_SEARCH_MAX;
    setSearchError(ok ? null : t('today.searchError', { min: TODAY_SEARCH_MIN }));
    if (ok) setSearched(s);
  }

  return (
    <div className="simple">
      <PageHeading title={t('today.title')}>{t('today.intro')}</PageHeading>
      <div className="simple-top"><HomeButton /></div>
      <div className="ws-search">
        <TextField label={t('today.date')} type="date" value={date} max={istToday()} onChange={(e) => { if (e.target.value) setDate(e.target.value); }} />
      </div>
      <form className="simple-row" role="search" noValidate onSubmit={search}>
        <TextField label={t('today.search')} value={text} maxLength={TODAY_SEARCH_MAX} autoComplete="off" error={searchError} onChange={(e) => setText(e.target.value)} />
        <Button type="submit" busy={found.isFetching && !found.isFetchingNextPage}>{t('today.find')}</Button>
        {searched !== null && <Button variant="secondary" onClick={() => { setText(''); setSearched(null); setSearchError(null); }}>{t('today.clear')}</Button>}
      </form>
      {!first ? (q.isError ? <Failed error={q.error} onRetry={() => void q.refetch()} /> : <Loading label={t('register.loading')} />) : (
        <>
          <MoneyLine day={first} date={date} />
          <PendingStrip day={first} />
          <p className="ws-muted">{t('today.count', { count: first.totals.count })}</p>
          {first.truncated && <Alert tone="warn">{t('today.truncated')}</Alert>}
          {!list.data ? (list.isError ? <Failed error={list.error} onRetry={() => void list.refetch()} /> : <Loading label={t('register.loading')} />)
            : searched !== null && items.length === 0 ? <p>{t('today.noMatch')}</p> : <Register items={items} date={date} />}
          {list.isFetchNextPageError && <Failed error={list.error} onRetry={() => void list.fetchNextPage()} />}
          {list.hasNextPage && <div><Button variant="secondary" busy={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>{t('today.more')}</Button></div>}
        </>
      )}
    </div>
  );
}
