import './home.css';
import { useState, type FormEvent } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  ApiError, bookingsWaiting, CONSULT_MODE_LABEL, istToday, MAX_TODO_TEXT, moneyParts, PAYMENT_METHOD_KEYS, pendingCount, TODAY_PAGE_MAX,
  TODAY_SEARCH_MAX, TODAY_SEARCH_MIN, todayLink, todoText,
  type ConsultMode, type PaymentMethodKey, type TodayAnswer, type TodayApi, type TodayDesk, type TodayItem, type Todo,
} from '@jansetu/api';
import { CALENDAR_DATE, formatClock, formatDateWith, formatPaise } from '@jansetu/i18n';
import { Alert, Badge, Button, Empty, Loading, Parts, TextField } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { t } from '../../i18n/home/index.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { definitelyNotRecorded, newRequestKey } from '../../requests.ts';
import { useFrontDesk, type FrontDesk } from './desk.tsx';
import { HomeButton } from './visitBar.tsx';

/**
 * WQ54 (P1, SIMPLE_DESIGN_PLAN_2026-11-26) / WQ54b / WQ55 (P4): the simple front-desk home, for a counter clerk used to a
 * paper register, on any device: a pharmacy's or a lab member's (`desk.tsx`). Big buttons (a pharmacy: + New, Find patient,
 * Sell medicines, Today; a lab: + New, Find patient, New bill, Today, by permission), the day's money, what is waiting, the
 * latest 10 entries (newest first) and the shared to-dos. The menu stays (the side menu; "Menu" on a phone). Big type and
 * 48 px targets (`home.css`). Without internet: a plain message and Try again, keeping what was typed.
 */

/**
 * No internet (or no answer in time): one plain sentence; WQ55 a read this person may not make: `forbidden` (a lab
 * member: ask the owner), never a blank screen; anything else in the server's words.
 */
export function homeWords(err: unknown, forbidden?: string | null): string {
  if (err instanceof ApiError && (err.code === 'NETWORK' || err.code === 'TIMEOUT')) return t('offline');
  return forbidden && err instanceof ApiError && err.status === 403 ? forbidden : messageOf(err);
}

/** A failed read in plain words, with one big Try again. */
export function Failed({ error, onRetry, forbidden }: { error: unknown; onRetry: () => void; forbidden?: string | null }) {
  return (
    <div className="simple-failed" role="alert">
      <p>{homeWords(error, forbidden)}</p>
      <Button onClick={onRetry}>{t('tryAgain')}</Button>
    </div>
  );
}

export const todayKey = (desk: Pick<FrontDesk, 'kind' | 'id'>, date: string) => ['front-today', desk.kind, desk.id, date] as const;
const HOME_ROWS = 10;
const isOldestFirst = (items: readonly TodayItem[]) => items.length > 1 && Date.parse(items[0]!.at) < Date.parse(items[items.length - 1]!.at);

/**
 * The home's read: the day's money and what waits, and its latest 10 rows, newest first (r37c `order=desc`). A server
 * before r37c lists oldest first whatever is asked: its pages are followed to the last one for the latest 10.
 */
async function latestRows(today: TodayApi['today'], date: string): Promise<TodayAnswer> {
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

export function useToday(desk: FrontDesk, date: string) {
  // Always read again when a page shows it: a sale or a booking made on another page has just changed the day.
  return useQuery({ queryKey: [...todayKey(desk, date), 'home'], queryFn: () => latestRows(desk.today.today, date), staleTime: 0, refetchOnMount: 'always' });
}

/** The front desk's home (a pharmacy's or WQ55 a lab member's). */
export function FrontDeskHome({ desk }: { desk: FrontDesk }) {
  const day = istToday();
  const q = useToday(desk, day);
  return (
    <div className="simple">
      <nav className="big-actions" aria-label={t('big.label')}>
        {desk.big.map(({ to, label, Icon }, i) => (
          <Link key={to} className={i === 0 ? 'big-action big-action--main' : 'big-action'} to={to}><Icon size={28} aria-hidden="true" />{label}</Link>
        ))}
      </nav>
      {/* WQ55: a member allowed none of the visits says so (never a blank home). */}
      {desk.choices.length === 0 && <Alert tone="warn">{t('askOwnerVisits')}</Alert>}
      <section className="ws-section" aria-labelledby="reg-h">
        <h2 id="reg-h">{t('register.title')}</h2>
        {!q.data ? (q.isError ? <Failed error={q.error} forbidden={desk.forbidden} onRetry={() => void q.refetch()} /> : <Loading label={t('register.loading')} />) : (
          <>
            <MoneyLine day={q.data} date={day} />
            <PendingStrip day={q.data} desk={desk} />
            <Register items={q.data.items} date={day} desk={desk.kind} />
            {(q.data.nextCursor || q.data.totals.count > q.data.items.length) && (
              <p><Link className="j-btn j-btn--secondary" to={desk.todayPath}>{t('register.all')}</Link></p>
            )}
          </>
        )}
      </section>
      <Todos desk={desk} />
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
      {/* r38b: what was returned that day, on its own line (collected stays as received). */}
      {(day.totals.refundedMinor ?? 0) > 0 && (
        <p className="money-refunded">{date === istToday() ? t('money.refundedToday', { amount: formatPaise(day.totals.refundedMinor!) })
          : t('money.refundedOn', { date: formatDay(date), amount: formatPaise(day.totals.refundedMinor!) })}</p>
      )}
    </section>
  );
}

type PendingLine = { id: string; text: string; to: string | null; failed?: boolean };
/** What is waiting in lines, in the desk's order, each with where it is done (r37c: bookings waiting for payment, by kind). */
function pendingLines(day: TodayAnswer, desk: FrontDesk): PendingLine[] {
  const p = day.pending;
  const lines: PendingLine[] = [];
  for (const k of desk.pending) {
    const n = pendingCount(p, k);
    if (k === 'reportsDue') {
      // r38: reports to upload and to release, each on its line (one line when the server does not split them).
      const r = p?.reportsDue;
      if (n === null) { lines.push({ id: k, text: t('pending.failed.reportsDue'), to: null, failed: true }); continue; }
      const up = Number(r?.toUploadCount ?? 0);
      const rel = Number(r?.toReleaseCount ?? 0);
      if (up > 0) lines.push({ id: 'reportsToUpload', text: t('pending.reportsToUpload', { count: up }), to: desk.pendingTo(k, r?.toUploadIds, up) });
      if (rel > 0) lines.push({ id: 'reportsToRelease', text: t('pending.reportsToRelease', { count: rel }), to: desk.pendingTo(k, r?.toReleaseIds, rel) });
      if (n > 0 && up + rel === 0) lines.push({ id: k, text: t('pending.reportsDue', { count: n }), to: desk.pendingTo(k, undefined, n) });
      continue;
    }
    if (k !== 'bookingsAwaiting') {
      const q = p?.[k] as { ids?: string[]; visitIds?: string[]; homeIds?: string[] } | null | undefined;
      const ids = k === 'samplesToCollect' ? [...(q?.visitIds ?? []), ...(q?.homeIds ?? [])] : q?.ids;
      if (n === null) lines.push({ id: k, text: t(`pending.failed.${k}`), to: null, failed: true });
      else if (n > 0) lines.push({ id: k, text: t(`pending.${k}`, { count: n }), to: desk.pendingTo(k, ids, n) });
      continue;
    }
    const b = bookingsWaiting(p);
    if (n === null || !b) { lines.push({ id: k, text: t('pending.failed.bookingsAwaiting'), to: null, failed: true }); continue; }
    const ba = p?.bookingsAwaiting;
    if (b.consultations > 0) {
      lines.push({ id: 'consultations', text: t('pending.doctorPayments', { count: b.consultations }), to: desk.bookingTo.consultations(ba?.consultationIds, b.consultations) });
    }
    if (b.labBookings > 0) {
      lines.push({ id: 'labBookings', text: t('pending.labPayments', { count: b.labBookings }), to: desk.bookingTo.labBookings(ba?.labBookingIds, b.labBookings) });
    }
    if (n > 0 && b.consultations + b.labBookings === 0) lines.push({ id: k, text: t('pending.bookingsAwaiting', { count: n }), to: desk.bookingTo.consultations(undefined, n) });
  }
  return lines;
}

/** What is waiting, each a link to where it is done; a list that could not be read is said on its own line. */
export function PendingStrip({ day, desk }: { day: TodayAnswer; desk: FrontDesk }) {
  if (!day.pending) return null;
  const lines = pendingLines(day, desk);
  return (
    <div className="pending-strip" aria-label={t('pending.title')} role="group">
      {lines.length === 0 ? <span className="ws-muted">{t('pending.none')}</span>
        : lines.map((x) => (x.to === null
          ? <span key={x.id} className={x.failed ? 'pending-item pending-item--failed' : 'pending-item'}>{x.text}</span>
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
    // r38: a lab's own test at home says so.
    case 'lab.tests': return v.visit === 'home' ? `${list(t('what.labTests'))} · ${t('what.home')}` : list(t('what.labTests'));
    case 'bill.items': return list(t('what.bill'));
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
export function Register({ items, date, desk }: { items: readonly TodayItem[]; date: string; desk: TodayDesk }) {
  if (items.length === 0) return <Empty title={t('register.none')}>{t('register.noneText')}</Empty>;
  return (
    <ul className="register" aria-label={t('register.caption')}>
      {items.map((i) => {
        const to = todayLink(i, desk);
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
                // r38: a desk booking's money is on its bill (its own row says so, not "Not paid").
                : i.kind === 'lab_booking' && i.whatParts?.values?.source === 'lab_desk' ? <Badge>{t('register.onBill')}</Badge>
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
export function Todos({ desk }: { desk: FrontDesk }) {
  const queryClient = useQueryClient();
  const todos = desk.today;
  const key = ['front-todos', desk.kind, desk.id];
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
      setError(code === 'TODO_LIMIT' ? t('todos.limit') : code === 'IDEMPOTENCY_KEY_REUSED' ? t('todos.keyReused') : homeWords(err, desk.forbidden));
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
      setNote(err instanceof ApiError && err.code === 'TODO_CHANGED' ? t('todos.changed') : homeWords(err, desk.forbidden));
    } finally {
      await reread();
      setTicked((m) => { const { [x._id]: _gone, ...rest } = m; return rest; });
    }
  }

  return (
    <section className="ws-section" aria-labelledby="todo-h">
      <h2 id="todo-h">{t('todos.title')}</h2>
      <form className="todo-add" noValidate onSubmit={(e) => void add(e)}>
        <TextField label={t('todos.new')} hint={desk.kind === 'lab' ? t('todos.newHintLab') : t('todos.newHint')} value={text} maxLength={MAX_TODO_TEXT} autoComplete="off" error={error}
          onChange={(e) => { setText(e.target.value); setRequestKey(null); }} />
        <Button type="submit" busy={busy}>{error && requestKey ? t('tryAgain') : t('todos.add')}</Button>
      </form>
      {note && <Alert tone="warn">{note}</Alert>}
      {!q.data ? (q.isError ? <Failed error={q.error} forbidden={desk.forbidden} onRetry={() => void q.refetch()} /> : <Loading label={t('todos.loading')} />)
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
 * Today (`/pharmacy/today`, WQ55 `/partner/today`): one India day's full register, newest first (an earlier day by its
 * date), in pages of 50 with Show more; the whole day's money and what waits. r37c: a search covers the whole day on the
 * server (a POST).
 */
export function TodayScreen() {
  const desk = useFrontDesk();
  return desk ? <DayRegister desk={desk} /> : <Empty title={t('askOwner')} />;
}

function DayRegister({ desk }: { desk: FrontDesk }) {
  const today = desk.today;
  const [date, setDate] = useState(() => istToday());
  const [text, setText] = useState('');
  const [searched, setSearched] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const pages = { initialPageParam: undefined as string | undefined, getNextPageParam: (last: TodayAnswer) => last.nextCursor ?? undefined,
    staleTime: 0, refetchOnMount: 'always' as const };
  const q = useInfiniteQuery({ queryKey: [...todayKey(desk, date), 'pages'], ...pages,
    queryFn: ({ pageParam }) => today.today({ date, order: 'desc', limit: 50, cursor: pageParam }) });
  const found = useInfiniteQuery({ queryKey: [...todayKey(desk, date), 'search', searched], ...pages, enabled: searched !== null,
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
      {!first ? (q.isError ? <Failed error={q.error} forbidden={desk.forbidden} onRetry={() => void q.refetch()} /> : <Loading label={t('register.loading')} />) : (
        <>
          <MoneyLine day={first} date={date} />
          <PendingStrip day={first} desk={desk} />
          <p className="ws-muted">{t('today.count', { count: first.totals.count })}</p>
          {first.truncated && <Alert tone="warn">{t('today.truncated')}</Alert>}
          {!list.data ? (list.isError ? <Failed error={list.error} onRetry={() => void list.refetch()} /> : <Loading label={t('register.loading')} />)
            : searched !== null && items.length === 0 ? <p>{t('today.noMatch')}</p> : <Register items={items} date={date} desk={desk.kind} />}
          {list.isFetchNextPageError && <Failed error={list.error} onRetry={() => void list.fetchNextPage()} />}
          {list.hasNextPage && <div><Button variant="secondary" busy={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>{t('today.more')}</Button></div>}
        </>
      )}
    </div>
  );
}
