import './finance.css';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import {
  ApiError, DETAILS_STATE_LABEL, isRealDate, isStatementCsv, LEDGER_KIND_LABEL, MAX_ACCOUNT_NAME, MAX_BANK_NAME, MAX_UPI_ID,
  PAYOUT_METHOD_LABEL, PAYOUT_STATE_LABEL, payoutDetailsProblems, settlementsApi, statementCsvName,
  type FinanceEvent, type FinanceSummary, type Page, type PayoutDetailsInput, type PayoutDetailsState, type PayoutDetailsView, type PeriodQuery,
  type SettlementAccount, type SettlementPayout, type StatementLine, type StatementPage, type StatementQuery,
} from '@jansetu/api';
import { CALENDAR_DATE, formatDateWith } from '@jansetu/i18n';
import { Alert, Badge, Button, Empty, ErrorState, formatDateTime, Loading, shared, TextField } from '@jansetu/ui';
import { dirtyKeys, useDraft } from '../../draft.ts';
import { messageOf } from '../../errors.ts';
import { t } from '../../i18n/finance/index.ts';
import { definitelyNotRecorded } from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { money } from '../partner/billing.tsx';
import { t as wt } from '../../i18n/withdrawals/index.ts';

/**
 * WQ5 building blocks shared by the partner finance page (members and admins as owner) and the admin settlement pages.
 * Amounts are integer paise from the server, shown with `money` (formatRupees); dates are India time.
 */

/** A signed amount: a minus sign (and the danger colour) for money going out or owed. */
export function Signed({ minor }: { minor: number }) {
  return minor < 0 ? <span className="fin-minus">− {money(-minor)}</span> : <>{money(minor)}</>;
}

/** An India calendar date (YYYY-MM-DD) as people read it. */
export function formatDate(date: string | undefined): string {
  if (!date || !isRealDate(date)) return date ?? '—';
  return formatDateWith(Date.parse(`${date}T00:00:00Z`), CALENDAR_DATE);
}

export const detailsTone = (s: PayoutDetailsState) => (s === 'verified' ? 'ok' : s === 'unverified' ? 'warn' : undefined);

/** One line for a destination, as the server labels payouts (`destinationLabel`): bank + IFSC + masked number, or the UPI ID. */
export function detailsLabel(d: PayoutDetailsView | null | undefined): string {
  if (!d) return t('details.none');
  if (d.method === 'upi') return t('details.upiLine', { upiId: d.upiId });
  const last4 = d.accountNumberLast4 ?? d.accountNumber?.slice(-4);
  return `${d.bankName ? `${d.bankName} ` : ''}${d.ifsc ?? ''}${last4 ? ` XXXX${last4}` : ''}`.trim();
}

/**
 * One money action on an account at a time (record payout, adjustment, verify, edit details, void), enforced in one
 * place: confirmations that were already open are refused while another action runs (WQ3 `perform`).
 */
export function useOneAtATime(what = t('busy.what.account')) {
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const perform = useCallback(async <T,>(run: () => Promise<T>): Promise<T> => {
    if (inFlight.current) {
      throw new ApiError(409, t('busy.another', { what }), 'ACTION_IN_FLIGHT');
    }
    inFlight.current = true;
    setBusy(true);
    try {
      return await run();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [what]);
  return { perform, busy, running: () => inFlight.current };
}
export type Perform = <T>(run: () => Promise<T>) => Promise<T>;

/**
 * WQ48 (r35 §26.9), admins: whether referral payouts (and paying an owed wallet amount from referral earnings) are paused
 * (`REFERRAL_PAYOUTS_ENABLED` off, until tax advice), as any referral account says (`payoutsPaused`, one server switch);
 * null when there is no referral account at all.
 */
export function useReferralPayoutsPaused(queryKey: readonly unknown[], enabled = true) {
  const { api } = useSession();
  return useQuery({
    queryKey: [...queryKey, 'referral-payouts-paused'], enabled,
    queryFn: async () => {
      const row = (await settlementsApi(api).accounts({ ownerKind: 'referral', limit: 1 })).rows[0];
      return row ? row.payoutsPaused === true : null;
    },
  });
}

/** Balance and lifetime totals (`financeSummary`). */
export function SummaryCards({ summary }: { summary: FinanceSummary }) {
  const totals = summary.totals;
  const last = summary.lastPayout;
  return (
    <>
      <dl className="fin-cards" aria-label={t('summary.label')}>
        <div className="fin-card fin-card--main"><dt>{summary.balanceMinor < 0 ? t('summary.balanceOwed') : t('summary.balanceDue')}</dt><dd><Signed minor={summary.balanceMinor} /></dd></div>
        <div className="fin-card"><dt>{t('summary.earned')}</dt><dd>{money(totals.earnedMinor)}</dd></div>
        <div className="fin-card"><dt>{t('summary.reversed')}</dt><dd>{money(totals.reversedMinor)}</dd></div>
        <div className="fin-card"><dt>{t('summary.paidOut')}</dt><dd>{money(totals.paidOutMinor)}</dd></div>
        <div className="fin-card"><dt>{t('summary.adjustments')}</dt><dd><Signed minor={totals.adjustedMinor} /></dd></div>
      </dl>
      <p className="ws-muted">
        {last ? t('summary.lastPayout', { amount: money(last.amountMinor), date: formatDate(last.paidOn), reference: last.reference, destination: last.destination?.label ?? '' })
          : t('summary.noPayout')}
        {' '}{t('summary.formula')}
      </p>
    </>
  );
}

/** The current destination as the server shows it to this viewer (masked for owners, full for admins). */
export function PayoutDetailsList({ account }: { account: SettlementAccount }) {
  const d = account.payoutDetails;
  const state = account.payoutDetailsState ?? 'none';
  return (
    <dl className="ws-dl">
      <dt>{shared('field.status')}</dt>
      <dd>
        <Badge tone={detailsTone(state)}>{DETAILS_STATE_LABEL[state] ?? state}</Badge>
        {account.payoutDetailsVersion > 0 ? ` · ${t('details.version', { version: account.payoutDetailsVersion })}` : ''}
      </dd>
      {d?.method === 'bank' && (
        <>
          <dt>{t('details.paidTo')}</dt><dd>{t('details.bankAccount')}</dd>
          <dt>{t('details.accountHolder')}</dt><dd>{d.accountName || '—'}</dd>
          <dt>{t('details.accountNumber')}</dt><dd>{d.accountNumber ?? d.accountNumberMasked ?? (d.accountNumberLast4 ? `XXXX${d.accountNumberLast4}` : '—')}</dd>
          <dt>{t('details.ifsc')}</dt><dd>{d.ifsc || '—'}</dd>
          {d.bankName && <><dt>{t('details.bank')}</dt><dd>{d.bankName}</dd></>}
        </>
      )}
      {d?.method === 'upi' && (
        <>
          <dt>{t('details.paidTo')}</dt><dd>{t('details.upi')}</dd>
          <dt>{t('details.upiId')}</dt><dd>{d.upiId}</dd>
          {d.accountName && <><dt>{shared('field.name')}</dt><dd>{d.accountName}</dd></>}
        </>
      )}
      {account.payoutDetailsChangedAt && <><dt>{t('details.lastChanged')}</dt><dd>{formatDateTime(account.payoutDetailsChangedAt)}</dd></>}
      {account.payoutDetailsVerifiedAt && <><dt>{t('details.verified')}</dt><dd>{formatDateTime(account.payoutDetailsVerifiedAt)}</dd></>}
    </dl>
  );
}

// ── Statement ──

const STATEMENT_PAGE = 50;

/**
 * Newest first, with the balance after each line, paged back by the server's cursor; optional India-date period, and
 * the same period as a CSV read into memory. `queryKey` must identify the account (and the person's scope).
 */
export function StatementSection({ queryKey, load, csv, csvPrefix, emptyText = t('statement.emptyAll') }: {
  queryKey: readonly unknown[];
  load: (q: StatementQuery) => Promise<StatementPage>;
  csv: (q: PeriodQuery, signal?: AbortSignal) => Promise<Blob>;
  csvPrefix: string;
  /** Under "No entries" when no period is chosen. */
  emptyText?: string;
}) {
  const statementPeriod = useStatementPeriod();
  const { period, filtered } = statementPeriod;
  const list = useInfiniteQuery({
    queryKey: [...queryKey, 'statement', period],
    queryFn: ({ pageParam }) => load({ ...period, limit: STATEMENT_PAGE, before: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: period !== null,
  });
  const lines = useMemo(() => {
    const seen = new Set<string>();
    const out: StatementLine[] = [];
    for (const p of list.data?.pages ?? []) for (const l of p.lines) if (!seen.has(l._id)) { seen.add(l._id); out.push(l); }
    return out;
  }, [list.data]);

  return (
    <section className="ws-section" aria-labelledby="fin-st-h">
      <h2 id="fin-st-h">{t('statement.title')}</h2>
      <StatementPeriodFields p={statementPeriod} csv={csv} csvPrefix={csvPrefix} />
      <p className="ws-muted">{t('statement.intro')}</p>
      {!period ? null
        : list.isPending ? <Loading label={t('statement.loading')} />
        : list.isError && !list.data ? <ErrorState message={messageOf(list.error)} onRetry={() => void list.refetch()} />
        : lines.length === 0 ? <Empty title={t('statement.empty')}>{filtered ? t('statement.emptyPeriod') : emptyText}</Empty>
        : (
          <>
            <div className="ws-table-wrap">
              <table className="j-table">
                <caption className="j-sr-only">{t('statement.caption')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('statement.column.date')}</th><th scope="col">{t('statement.column.description')}</th>
                    <th scope="col">{t('statement.column.type')}</th><th scope="col">{t('column.reference')}</th>
                    <th scope="col" className="fin-amount">{shared('field.amount')}</th><th scope="col" className="fin-amount">{t('statement.column.balanceAfter')}</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l._id}>
                      <td>{formatDateTime(l.at)}</td>
                      <td>{l.description}{l.note ? <div className="ws-muted">{l.note}</div> : null}</td>
                      <td>{LEDGER_KIND_LABEL[l.kind] ?? l.kind}</td>
                      <td>{l.reference || '—'}</td>
                      <td className="fin-amount"><Signed minor={l.amountMinor} /></td>
                      <td className="fin-amount"><Signed minor={l.balanceAfterMinor} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {list.isFetchNextPageError && <ErrorState message={t('statement.olderFailed', { error: messageOf(list.error) })} onRetry={() => void list.fetchNextPage()} />}
            {list.hasNextPage && (
              <div><Button variant="secondary" busy={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>{t('statement.older')}</Button></div>
            )}
          </>
        )}
    </section>
  );
}

/**
 * A statement's India-date period (WQ26c: shared by the finance statements and the referral statements): the typed dates,
 * whether they are real, and the period they make (null while they are not).
 */
export function useStatementPeriod() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const bad = (from && !isRealDate(from)) || (to && !isRealDate(to)) ? t('period.badDates') : from && to && from > to ? t('period.endsBeforeStart') : null;
  const period: PeriodQuery | null = bad ? null : { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  return { from, to, setFrom, setTo, bad, period, filtered: !!(from || to) };
}

/** The period's fields and the CSV of that period (a new download for each period; the server's refusal is shown). */
export function StatementPeriodFields({ p, csv, csvPrefix }: {
  p: ReturnType<typeof useStatementPeriod>;
  csv: (q: PeriodQuery, signal?: AbortSignal) => Promise<Blob>;
  csvPrefix: string;
}) {
  return (
    <div className="ws-search" role="group" aria-label={t('statement.period')}>
      <TextField label={t('statement.from')} type="date" value={p.from} onChange={(e) => p.setFrom(e.target.value)} error={p.bad} />
      <TextField label={t('statement.to')} type="date" value={p.to} onChange={(e) => p.setTo(e.target.value)} />
      {p.period && <CsvDownload key={JSON.stringify(p.period)} period={p.period} csv={csv} csvPrefix={csvPrefix} />}
    </div>
  );
}

/**
 * The statement CSV of one period, read with the session's token into an in-memory blob (never a link with a token).
 * Keyed by the period: changing it aborts a running download and drops the file of the old period.
 */
function CsvDownload({ period, csv, csvPrefix }: { period: PeriodQuery; csv: (q: PeriodQuery, signal?: AbortSignal) => Promise<Blob>; csvPrefix: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<{ url: string; name: string } | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  useEffect(() => () => ctrl.current?.abort(), []);
  useEffect(() => () => { if (file) URL.revokeObjectURL(file.url); }, [file]);

  async function download() {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setBusy(true);
    setError(null);
    setFile(null);
    try {
      const blob = await csv(period, c.signal);
      const real = await isStatementCsv(blob);
      if (c.signal.aborted) return;
      if (!real) { setError(t('csv.notAFile')); return; }
      const name = statementCsvName(csvPrefix, period);
      const url = URL.createObjectURL(new Blob([blob], { type: 'text/csv' }));
      setFile({ url, name });
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      if (!c.signal.aborted) setError(messageOf(err));
    } finally {
      if (ctrl.current === c) setBusy(false);
    }
  }

  const which = period.from && period.to ? t('csv.period.fromTo', { from: formatDate(period.from), to: formatDate(period.to) })
    : period.from ? t('csv.period.from', { from: formatDate(period.from) })
    : period.to ? t('csv.period.to', { to: formatDate(period.to) })
    : t('csv.period.all');
  return (
    <div className="ws-action">
      <Button variant="secondary" busy={busy} onClick={() => void download()}>
        <Download size={16} aria-hidden="true" /> {t('csv.download', { period: which })}
      </Button>
      {file && <a href={file.url} download={file.name}>{t('csv.saveAgain', { file: file.name })}</a>}
      {error && <Alert>{t('csv.failed', { error })}</Alert>}
    </div>
  );
}

// ── Payouts and events ──

export function PayoutsTable<P extends SettlementPayout>({ payouts, caption, accountCell, actions }: {
  payouts: readonly P[];
  caption: string;
  /** Admin queue: which account each payout belongs to. */
  accountCell?: (p: P) => ReactNode;
  actions?: (p: P) => ReactNode;
}) {
  return (
    <div className="ws-table-wrap">
      <table className="j-table">
        <caption className="j-sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{t('payouts.column.paidOn')}</th>
            {accountCell && <th scope="col">{t('payouts.column.account')}</th>}
            <th scope="col" className="fin-amount">{shared('field.amount')}</th><th scope="col">{t('payouts.column.method')}</th><th scope="col">{t('column.reference')}</th>
            <th scope="col">{t('payouts.column.sentTo')}</th><th scope="col">{shared('field.status')}</th>
            {actions && <th scope="col">{t('payouts.column.actions')}</th>}
          </tr>
        </thead>
        <tbody>
          {payouts.map((p) => (
            <tr key={p._id}>
              <td>{formatDate(p.paidOn)}</td>
              {accountCell && <td>{accountCell(p)}</td>}
              <td className="fin-amount">{money(p.amountMinor)}</td>
              <td>{PAYOUT_METHOD_LABEL[p.method] ?? p.method}</td>
              <td>{p.reference}{p.note ? <div className="ws-muted">{p.note}</div> : null}</td>
              <td>{p.destination?.label}{p.destination ? <div className="ws-muted">{t('payouts.detailsVersion', { version: p.destination.detailsVersion })}</div> : null}</td>
              <td>
                <Badge tone={p.state === 'voided' ? 'danger' : 'ok'}>{PAYOUT_STATE_LABEL[p.state] ?? p.state}</Badge>
                {p.state === 'voided' && <div className="ws-muted">{p.voidReason ? `“${p.voidReason}”` : ''}{p.voidedAt ? ` · ${formatDateTime(p.voidedAt)}` : ''}</div>}
              </td>
              {actions && <td>{actions(p)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Keys of the finance event names, read at render. */
const ACTION_LABEL = {
  'finance.payout_details_changed': 'event.action.detailsChanged',
  'finance.payout_details_verified': 'event.action.detailsVerified',
  'finance.payout_recorded': 'event.action.payoutRecorded',
  'finance.payout_voided': 'event.action.payoutVoided',
  'finance.adjustment_posted': 'event.action.adjustmentPosted',
} as const;
const actionLabel = (action: string) => (Object.hasOwn(ACTION_LABEL, action) ? t(ACTION_LABEL[action as keyof typeof ACTION_LABEL]) : action);

/** "Bank", with the IFSC and the account number's last four digits when known. */
function bankLine(ifsc: string | undefined, last4: string | undefined): string {
  if (ifsc && last4) return t('event.bankIfscLast4', { ifsc, last4 });
  if (ifsc) return t('event.bankIfsc', { ifsc });
  if (last4) return t('event.bankLast4', { last4 });
  return t('event.bank');
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/** The event's own details in a sentence (amounts, references, destinations; never anything else from `detail`). */
export function eventText(e: FinanceEvent): string {
  const d = e.detail ?? {};
  const amount = num(d.amountMinor);
  const version = num(d.version);
  switch (e.action) {
    case 'finance.payout_details_changed':
      return [d.method === 'upi' ? t('event.upi', { upiId: str(d.upiId) ?? '' }).trim() : bankLine(str(d.ifsc), str(d.last4)),
        version ? t('details.version', { version }) : ''].filter(Boolean).join(' · ');
    case 'finance.payout_details_verified':
      return version ? t('event.versionTitle', { version }) : '';
    case 'finance.payout_recorded':
      return [amount !== undefined ? money(amount) : '', str(d.reference) ? t('event.reference', { reference: str(d.reference)! }) : '',
        str(d.paidOn) ? t('event.paidOn', { date: formatDate(str(d.paidOn)) }) : ''].filter(Boolean).join(' · ');
    case 'finance.payout_voided':
    case 'finance.adjustment_posted':
      return [amount !== undefined ? (amount < 0 ? `− ${money(-amount)}` : money(amount)) : '', str(d.reason) ? `“${str(d.reason)}”` : ''].filter(Boolean).join(' · ');
    default:
      return '';
  }
}

export function EventsList({ events, selfId }: { events: readonly FinanceEvent[]; selfId?: string }) {
  const who = (e: FinanceEvent) => (e.byKind === 'admin' ? t('event.by.admin') : e.byKind === 'doctor' ? t('event.by.doctor')
    : selfId && e.by === selfId ? t('event.by.you') : t('event.by.member'));
  return (
    <ul className="fin-events">
      {events.map((e) => (
        <li key={e._id}>
          <time dateTime={e.at}>{formatDateTime(e.at)}</time>
          <strong>{actionLabel(e.action)}</strong> · {who(e)}
          {eventText(e) ? <div className="ws-muted">{eventText(e)}</div> : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * Q13: a list read one exact cursor page at a time (`pagination {total, nextCursor}`), with the four states, the total and
 * "Show more". `queryKey` must identify the list (account and scope); pages are de-duplicated by `_id`.
 */
export function PagedSection<T extends { _id: string }>({ id, title, loading, emptyTitle, queryKey, load, empty, more = shared('action.showMore'), children }: {
  /** The heading, the loading line ("Loading payouts…") and the empty state's title ("No payouts"). */
  id: string; title: string; loading: string; emptyTitle: string; queryKey: readonly unknown[];
  load: (cursor: string | undefined) => Promise<Page<T>>;
  empty: ReactNode; more?: string; children: (rows: T[]) => ReactNode;
}) {
  const list = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => load(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = useMemo(() => {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const p of list.data?.pages ?? []) for (const r of p.items) if (!seen.has(r._id)) { seen.add(r._id); out.push(r); }
    return out;
  }, [list.data]);
  const total = list.data?.pages.at(-1)?.total ?? rows.length;
  return (
    <section className="ws-section" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {list.isPending ? <Loading label={loading} />
        : list.isError && !list.data ? <ErrorState message={messageOf(list.error)} onRetry={() => void list.refetch()} />
        : rows.length === 0 ? <Empty title={emptyTitle}>{empty}</Empty>
        : (
          <>
            <p className="ws-count">{t('list.count', { total, shown: rows.length })}</p>
            {children(rows)}
            {list.isFetchNextPageError && <ErrorState message={t('list.moreFailed', { error: messageOf(list.error) })} onRetry={() => void list.fetchNextPage()} />}
            {list.hasNextPage && (
              <div><Button variant="secondary" busy={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>{more}</Button></div>
            )}
          </>
        )}
    </section>
  );
}

/** A list section with the four states. */
export function ListSection<T>({ id, title, loading, emptyTitle, q, empty, children }: {
  /** The heading, the loading line and the empty state's title. */
  id: string; title: string; loading: string; emptyTitle: string;
  q: { isPending: boolean; isError: boolean; error: unknown; data: T[] | undefined; refetch: () => unknown };
  empty: string; children: (rows: T[]) => ReactNode;
}) {
  return (
    <section className="ws-section" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {q.isPending ? <Loading label={loading} />
        : q.isError || !q.data ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : q.data.length === 0 ? <Empty title={emptyTitle}>{empty}</Empty>
        : children(q.data)}
    </section>
  );
}

// ── Payout destination form ──

interface DetailsDraft { method: 'bank' | 'upi'; accountName: string; accountNumber: string; confirmNumber: string; ifsc: string; bankName: string; upiId: string }
const BLANK: DetailsDraft = { method: 'bank', accountName: '', accountNumber: '', confirmNumber: '', ifsc: '', bankName: '', upiId: '' };

/** The form's starting point: the saved destination (the account number only where the server shows it in full: admins). */
export function draftOfDetails(a: Pick<SettlementAccount, 'payoutDetails'> | null): DetailsDraft {
  const d = a?.payoutDetails;
  if (d?.method === 'upi') return { ...BLANK, method: 'upi', accountName: d.accountName ?? '', upiId: d.upiId };
  if (d?.method === 'bank') {
    return { ...BLANK, accountName: d.accountName ?? '', accountNumber: d.accountNumber ?? '', confirmNumber: d.accountNumber ?? '', ifsc: d.ifsc ?? '', bankName: d.bankName ?? '' };
  }
  return BLANK;
}

/**
 * Change where payouts go (`payoutDetailsSchema`). The form keeps the version it started from: a change made elsewhere
 * meanwhile replaces the draft with what is saved (with a notice), and the account is read again right before sending; a
 * different version there stops the save. Q13: the PUT also names that version (`expectedDetailsVersion`), so a change
 * landing between the re-read and the write is refused by the server (409 PAYOUT_DETAILS_CHANGED): the form then shows
 * what is saved now and closes the review. Any change makes the destination unverified until an admin verifies it.
 */
export function PayoutDetailsForm({ account, audience, reread, save, perform, onSaved, onLost, onStale, onCancel }: {
  /** WQ48: only the destination and its version are used (a pharmacy's comes from its finance read, masked). */
  account: Pick<SettlementAccount, 'payoutDetails' | 'payoutDetailsVersion'> | null;
  audience: 'owner' | 'admin';
  /** WQ29: only the destination and its version are read (a pharmacy's comes from its withdrawable answer). */
  reread: () => Promise<Pick<SettlementAccount, 'payoutDetails' | 'payoutDetailsVersion'> | null>;
  /** Sends the destination with the version it was reviewed on (`expectedDetailsVersion`). */
  save: (body: PayoutDetailsInput, expectedDetailsVersion: number) => Promise<SettlementAccount>;
  perform?: Perform;
  onSaved: (saved: SettlementAccount) => void;
  /** The answer did not come back: the details may or may not have changed (the caller reloads and says so). */
  onLost: (message: string) => void;
  /** The re-read found newer details: the page should show them too. */
  onStale?: () => void;
  onCancel: () => void;
}) {
  const d = useDraft(() => draftOfDetails(account));
  const { rebaseTo, update } = d;
  const baseVersion = useRef(account?.payoutDetailsVersion ?? 0);
  /** Bumped by every change of the draft (typing or a rebase): a save may send only the draft it reviewed. */
  const generation = useRef(0);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const [stale, setStale] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Replaces the draft with what is saved now (version `v`); tells the person if they had changed anything. */
  const moveTo = useCallback((latest: DetailsDraft, v: number, touched: boolean) => {
    baseVersion.current = v;
    generation.current += 1;
    rebaseTo(latest);
    update(() => latest);
    setReviewing(false);
    if (touched) {
      setStale(t('form.staleEditing', { version: v }));
    }
  }, [rebaseTo, update]);

  const version = account?.payoutDetailsVersion ?? 0;
  const latestJson = JSON.stringify(draftOfDetails(account));
  useEffect(() => {
    if (version === baseVersion.current) return;
    moveTo(JSON.parse(latestJson) as DetailsDraft, version, dirtyKeys(d.current()).length > 0);
  }, [version, latestJson, moveTo, d]);

  const draft = d.draft;
  const built = payoutDetailsProblems(draft);
  const mismatch = draft.method === 'bank' && draft.accountNumber.replace(/\s+/g, '') !== draft.confirmNumber.replace(/\s+/g, '');
  const allErrors: Record<string, string | undefined> = { ...built.errors, ...(mismatch ? { confirmNumber: t('form.mismatch') } : {}) };
  const errors = tried ? allErrors : {};
  const valid = built.body !== null && !mismatch;
  const set = <K extends keyof DetailsDraft>(k: K, v: DetailsDraft[K]) => { generation.current += 1; d.set(k, v); setReviewing(false); setError(null); };

  function review(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    setError(null);
    setStale(null);
    if (valid) setReviewing(true);
  }

  /**
   * Sends exactly the reviewed draft, only if nothing moved since the review: the version and the draft generation are
   * captured BEFORE the re-read, and after it the page must still be on screen, the draft unchanged (no typing, no
   * rebase by a background refresh) and the server still on the reviewed version. Anything else sends nothing.
   */
  async function send() {
    const body = built.body;
    if (!body) return;
    const reviewedVersion = baseVersion.current;
    const reviewedGeneration = generation.current;
    const moved = () => !live.current || generation.current !== reviewedGeneration || baseVersion.current !== reviewedVersion;
    let sent = false;
    setBusy(true);
    setError(null);
    const run = async (): Promise<SettlementAccount | null> => {
      if (moved()) return null;
      const now = await reread();
      if (!live.current) return null;
      const v = now?.payoutDetailsVersion ?? 0;
      if (moved() || v !== reviewedVersion) {
        // A newer destination exists (seen by the re-read or by a refresh meanwhile): show it, send nothing.
        if (baseVersion.current !== v) moveTo(draftOfDetails(now), v, true);
        else setStale(t('form.staleSaving', { version: v }));
        setReviewing(false);
        onStale?.();
        return null;
      }
      sent = true;
      return save(body, reviewedVersion);
    };
    try {
      const saved = await (perform ? perform(run) : run());
      if (saved && live.current) onSaved(saved);
    } catch (err) {
      if (!live.current) return;
      if (sent && err instanceof ApiError && err.code === 'PAYOUT_DETAILS_CHANGED') {
        // Q13: someone saved other details after the re-read; nothing was saved here. Show what is saved now.
        setReviewing(false);
        onStale?.();
        try {
          const now = await reread();
          if (!live.current) return;
          const v = now?.payoutDetailsVersion ?? 0;
          if (baseVersion.current !== v) moveTo(draftOfDetails(now), v, true);
        } catch { /* the page's own refresh shows the details */ }
        if (live.current) setStale(t('form.staleRace'));
        return;
      }
      // WQ48 (r35): a waiting withdrawal to these details, or (r35b) a referral account paid to its home account's details.
      const code = err instanceof ApiError ? err.code : undefined;
      if (sent && (code === 'WITHDRAWAL_OPEN' || code === 'REFERRAL_ACCOUNT_USES_HOME')) setError(wt(`error.${code}`));
      else if (!sent || definitelyNotRecorded(err)) setError(sent ? t('form.notSaved', { error: messageOf(err) }) : messageOf(err));
      else onLost(t('form.lost', { error: messageOf(err) }));
    } finally {
      if (live.current) setBusy(false);
    }
  }

  const label = built.body ? detailsLabel(built.body.method === 'bank'
    ? { method: 'bank', ifsc: built.body.ifsc, bankName: built.body.bankName, accountNumberLast4: built.body.accountNumber.slice(-4) }
    : { method: 'upi', upiId: built.body.upiId }) : '';
  return (
    <form className="rx-form" noValidate onSubmit={review} aria-label={t('details.change')}>
      {stale && <Alert tone="warn">{stale}</Alert>}
      <fieldset className="fin-radio">
        <legend>{t('form.payTo')}</legend>
        <label><input type="radio" name="fin-method" checked={draft.method === 'bank'} onChange={() => set('method', 'bank')} /> {t('details.bankAccount')}</label>
        <label><input type="radio" name="fin-method" checked={draft.method === 'upi'} onChange={() => set('method', 'upi')} /> {t('details.upi')}</label>
      </fieldset>
      {draft.method === 'bank' ? (
        <div className="rx-form-row">
          <TextField label={t('form.accountName')} value={draft.accountName} maxLength={MAX_ACCOUNT_NAME} error={errors.accountName} onChange={(e) => set('accountName', e.target.value)} />
          <TextField label={t('details.accountNumber')} inputMode="numeric" autoComplete="off" value={draft.accountNumber} error={errors.accountNumber}
            hint={audience === 'owner' && account?.payoutDetails?.method === 'bank' ? t('form.accountNumberHint') : undefined}
            onChange={(e) => set('accountNumber', e.target.value)} />
          <TextField label={t('form.accountNumberAgain')} inputMode="numeric" autoComplete="off" value={draft.confirmNumber} error={errors.confirmNumber}
            onChange={(e) => set('confirmNumber', e.target.value)} />
          <TextField label={t('details.ifsc')} value={draft.ifsc} maxLength={11} error={errors.ifsc} onChange={(e) => set('ifsc', e.target.value)} />
          <TextField label={t('form.bankName')} value={draft.bankName} maxLength={MAX_BANK_NAME} error={errors.bankName} onChange={(e) => set('bankName', e.target.value)} />
        </div>
      ) : (
        <div className="rx-form-row">
          <TextField label={t('details.upiId')} value={draft.upiId} maxLength={MAX_UPI_ID} error={errors.upiId} onChange={(e) => set('upiId', e.target.value)} />
          <TextField label={t('form.nameOptional')} value={draft.accountName} maxLength={MAX_ACCOUNT_NAME} error={errors.accountName} onChange={(e) => set('accountName', e.target.value)} />
        </div>
      )}
      {error && <Alert>{error}</Alert>}
      {!reviewing ? (
        <div className="rx-actions ws-actions">
          <Button type="submit">{t('form.review')}</Button>
          <Button variant="ghost" onClick={onCancel}>{shared('action.cancel')}</Button>
        </div>
      ) : (
        <div className="confirm" role="group" aria-label={t('form.confirmLabel')}>
          <div className="confirm-text">
            {audience === 'owner' ? t('form.confirm.owner', { destination: label }) : t('form.confirm.admin', { destination: label })}
          </div>
          <div className="confirm-actions">
            <Button busy={busy} onClick={() => void send()}>{t('form.save')}</Button>
            <Button variant="ghost" disabled={busy} onClick={() => setReviewing(false)}>{shared('action.back')}</Button>
          </div>
        </div>
      )}
    </form>
  );
}
