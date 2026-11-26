import './home.css';
import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { CalendarDays, Pill, Plus, Search } from 'lucide-react';
import {
  ApiError, istToday, MAX_TODO_TEXT, moneyParts, PENDING_KEYS, pharmacyTodayApi, todoText,
  type TodayAnswer, type TodayItem, type Todo,
} from '@jansetu/api';
import { formatPaise } from '@jansetu/i18n';
import { Alert, Badge, Button, Empty, formatDateTime, Loading, TextField } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { t } from '../../i18n/home/index.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { definitelyNotRecorded, newRequestKey } from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { usePharmacyId } from './ownedOp.tsx';

/**
 * WQ54 (P1, SIMPLE_DESIGN_PLAN_2026-11-26): the simple pharmacy home, for a counter clerk used to a paper register, on any
 * device: four big buttons (+ New, Find patient, Sell medicines, Today), today's register (the latest 10) with the day's
 * money, what is waiting, and the pharmacy's to-dos. The menu stays (the side menu; "More" on a phone). Big type and 48 px
 * targets (`home.css`). Without internet: a plain message and Try again, keeping what was typed.
 */

/** No internet (or no answer in time): one plain sentence; anything else in the server's words. */
export function homeWords(err: unknown): string {
  return err instanceof ApiError && (err.code === 'NETWORK' || err.code === 'TIMEOUT') ? t('offline') : messageOf(err);
}

/** A failed read in plain words, with one big Try again. */
function Failed({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div className="simple-failed" role="alert">
      <p>{homeWords(error)}</p>
      <Button onClick={onRetry}>{t('tryAgain')}</Button>
    </div>
  );
}

export const todayKey = (pharmacyId: string, date: string) => ['pharmacy-today', pharmacyId, date] as const;

export function useToday(pharmacyId: string, date: string) {
  const { api } = useSession();
  // Always read again when a page shows it: a sale or a booking made on another page has just changed the day.
  return useQuery({ queryKey: todayKey(pharmacyId, date), queryFn: () => pharmacyTodayApi(api).today(date), staleTime: 0, refetchOnMount: 'always' });
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
            <MoneyLine day={q.data} />
            <PendingStrip day={q.data} />
            <Register items={q.data.items.slice(0, 10)} />
            {q.data.items.length > 10 && <p><Link to="/pharmacy/today">{t('register.all')}</Link></p>}
          </>
        )}
      </section>
      <Todos pharmacyId={pharmacyId} />
    </div>
  );
}

/** "Collected ₹x: cash ₹a · UPI ₹b · wallet ₹c · unpaid ₹d". */
export function MoneyLine({ day }: { day: TodayAnswer }) {
  const parts = moneyParts(day.totals).map((p) => t(`money.${p.key}`, { amount: formatPaise(p.minor) }));
  return (
    <p className="money-line" aria-label={t('money.label')}>
      <strong>{t('money.collected', { amount: formatPaise(day.totals.collectedMinor) })}</strong>
      {': '}{[...parts, t('money.unpaid', { amount: formatPaise(day.totals.unpaidMinor) })].join(' · ')}
    </p>
  );
}

const PENDING_LINK: Readonly<Record<(typeof PENDING_KEYS)[number], string>> = {
  prescriptions: '/pharmacy/prescriptions', unpaidSales: '/pharmacy/today', labReports: '/pharmacy/lab-tests', consultations: '/pharmacy/consultations',
};

/** What is waiting, each a link to where it is done. */
export function PendingStrip({ day }: { day: TodayAnswer }) {
  const items = PENDING_KEYS.map((k) => ({ k, n: Number(day.pending?.[k] ?? 0) })).filter((x) => Number.isInteger(x.n) && x.n > 0);
  return (
    <div className="pending-strip" aria-label={t('pending.title')} role="group">
      {items.length === 0 ? <span className="ws-muted">{t('pending.none')}</span>
        : items.map((x) => <Link key={x.k} className="pending-item" to={PENDING_LINK[x.k]}>{t(`pending.${x.k}`, { count: x.n })}</Link>)}
    </div>
  );
}

/** A register row's own page (the existing detail pages). */
function linkOf(i: TodayItem): string | null {
  if (i.link && i.link.startsWith('/pharmacy/')) return i.link;
  if (!/^[0-9a-fA-F]{24}$/.test(i.id)) return null;
  if (i.kind === 'sale') return `/pharmacy/orders/${i.id}`;
  if (i.kind === 'consultation' || i.kind === 'instant') return `/pharmacy/consultations/${i.id}`;
  if (i.kind === 'lab') return `/pharmacy/lab-tests/${i.id}`;
  return null;
}
const METHOD_KEYS = ['cash', 'upi', 'card', 'wallet', 'online', 'other'] as const;
const methodWords = (m: string | null) => (m && (METHOD_KEYS as readonly string[]).includes(m) ? t(`method.${m as (typeof METHOD_KEYS)[number]}`) : m);

/** The register: time, who and what (tap to open), amount, paid or not. */
export function Register({ items }: { items: readonly TodayItem[] }) {
  if (items.length === 0) return <Empty title={t('register.none')}>{t('register.noneText')}</Empty>;
  return (
    <ul className="register" aria-label={t('register.caption')}>
      {items.map((i) => {
        const to = linkOf(i);
        const words = <><strong>{i.patientName ?? t('register.noName')}</strong>{`: ${i.what}`}{i.shortRef ? <span className="ws-muted">{` · ${i.shortRef}`}</span> : null}</>;
        return (
          <li key={`${i.kind}:${i.id}`} className="register-row">
            <span className="register-time">{formatDateTime(i.at)}</span>
            <span className="register-item">{to ? <Link to={to}>{words}</Link> : words}</span>
            <span className="register-amount">{formatPaise(i.amountMinor)}</span>
            <span>{i.paid ? <Badge tone="ok">{i.method ? t('register.paidBy', { method: methodWords(i.method) ?? '' }) : t('register.paid')}</Badge>
              : <Badge tone="warn">{t('register.unpaid')}</Badge>}</span>
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
  const q = useQuery({ queryKey: key, queryFn: () => todos.todos() });
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
      setError(homeWords(err));
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
      setNote(err instanceof ApiError && err.status === 409 ? t('todos.changed') : homeWords(err));
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
        : q.data.length === 0 ? <p className="ws-muted">{t('todos.none')}</p>
        : (
          <ul className="todo-list">
            {q.data.map((x) => (
              <li key={x._id}>
                <label className={(ticked[x._id] ?? x.done) ? 'todo todo--done' : 'todo'}>
                  <input type="checkbox" checked={ticked[x._id] ?? x.done} onChange={(e) => void tick(x, e.target.checked)} />
                  <span>{x.text}</span>
                </label>
                {x.createdByName && <span className="ws-muted">{t('todos.by', { who: x.createdByName })}</span>}
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}

/** Today (`/pharmacy/today`): one day's full register (an earlier day by its date), searched by name or ref, its totals and what waits. */
export function TodayScreen() {
  const pharmacyId = usePharmacyId();
  const [date, setDate] = useState(() => istToday());
  const [search, setSearch] = useState('');
  const q = useToday(pharmacyId, date);
  const s = search.trim().toLowerCase();
  const items = (q.data?.items ?? []).filter((i) => !s || (i.patientName ?? '').toLowerCase().includes(s) || (i.shortRef ?? '').toLowerCase().includes(s)
    || String(i.what ?? '').toLowerCase().includes(s));
  return (
    <div className="simple">
      <PageHeading title={t('today.title')}>{t('today.intro')}</PageHeading>
      <div className="ws-search">
        <TextField label={t('today.date')} type="date" value={date} max={istToday()} onChange={(e) => { if (e.target.value) setDate(e.target.value); }} />
        <TextField label={t('today.search')} value={search} autoComplete="off" onChange={(e) => setSearch(e.target.value)} />
      </div>
      {!q.data ? (q.isError ? <Failed error={q.error} onRetry={() => void q.refetch()} /> : <Loading label={t('register.loading')} />) : (
        <>
          <MoneyLine day={q.data} />
          <PendingStrip day={q.data} />
          <p className="ws-muted">{t('today.count', { count: items.length })}</p>
          {s && items.length === 0 ? <p>{t('today.noMatch')}</p> : <Register items={items} />}
        </>
      )}
    </div>
  );
}
