import './finance.css';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import {
  ApiError, DETAILS_STATE_LABEL, isRealDate, isStatementCsv, LEDGER_KIND_LABEL, MAX_ACCOUNT_NAME, MAX_BANK_NAME, MAX_UPI_ID,
  PAYOUT_METHOD_LABEL, PAYOUT_STATE_LABEL, payoutDetailsProblems, statementCsvName,
  type FinanceEvent, type FinanceSummary, type Page, type PayoutDetailsInput, type PayoutDetailsState, type PayoutDetailsView, type PeriodQuery,
  type SettlementAccount, type SettlementPayout, type StatementLine, type StatementPage, type StatementQuery,
} from '@jansetu/api';
import { CALENDAR_DATE, formatDateWith } from '@jansetu/i18n';
import { Alert, Badge, Button, Empty, ErrorState, formatDateTime, Loading, TextField } from '@jansetu/ui';
import { dirtyKeys, useDraft } from '../../draft.ts';
import { messageOf } from '../../errors.ts';
import { definitelyNotRecorded } from '../../requests.ts';
import { money } from '../partner/billing.tsx';

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
  if (!d) return 'No payout details';
  if (d.method === 'upi') return `UPI ${d.upiId}`;
  const last4 = d.accountNumberLast4 ?? d.accountNumber?.slice(-4);
  return `${d.bankName ? `${d.bankName} ` : ''}${d.ifsc ?? ''}${last4 ? ` XXXX${last4}` : ''}`.trim();
}

/**
 * One money action on an account at a time (record payout, adjustment, verify, edit details, void), enforced in one
 * place: confirmations that were already open are refused while another action runs (WQ3 `perform`).
 */
export function useOneAtATime(what = 'account') {
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const perform = useCallback(async <T,>(run: () => Promise<T>): Promise<T> => {
    if (inFlight.current) {
      throw new ApiError(409, `Another action on this ${what} is still running. Wait for it to finish, then try again.`, 'ACTION_IN_FLIGHT');
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

/** Balance and lifetime totals (`financeSummary`). */
export function SummaryCards({ summary }: { summary: FinanceSummary }) {
  const t = summary.totals;
  const last = summary.lastPayout;
  return (
    <>
      <dl className="fin-cards" aria-label="Balance and totals">
        <div className="fin-card fin-card--main"><dt>{summary.balanceMinor < 0 ? 'Balance (owed back)' : 'Balance due'}</dt><dd><Signed minor={summary.balanceMinor} /></dd></div>
        <div className="fin-card"><dt>Earned</dt><dd>{money(t.earnedMinor)}</dd></div>
        <div className="fin-card"><dt>Reversed</dt><dd>{money(t.reversedMinor)}</dd></div>
        <div className="fin-card"><dt>Paid out</dt><dd>{money(t.paidOutMinor)}</dd></div>
        <div className="fin-card"><dt>Adjustments</dt><dd><Signed minor={t.adjustedMinor} /></dd></div>
      </dl>
      <p className="ws-muted">
        {last ? <>Last payout: {money(last.amountMinor)} on {formatDate(last.paidOn)} (reference {last.reference}) to {last.destination?.label}.</> : 'No payout yet.'}
        {' '}Balance = earnings − reversals − payouts ± adjustments.
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
      <dt>Status</dt>
      <dd>
        <Badge tone={detailsTone(state)}>{DETAILS_STATE_LABEL[state] ?? state}</Badge>
        {account.payoutDetailsVersion > 0 ? ` · version ${account.payoutDetailsVersion}` : ''}
      </dd>
      {d?.method === 'bank' && (
        <>
          <dt>Paid to</dt><dd>Bank account</dd>
          <dt>Account holder</dt><dd>{d.accountName || '—'}</dd>
          <dt>Account number</dt><dd>{d.accountNumber ?? d.accountNumberMasked ?? (d.accountNumberLast4 ? `XXXX${d.accountNumberLast4}` : '—')}</dd>
          <dt>IFSC</dt><dd>{d.ifsc || '—'}</dd>
          {d.bankName && <><dt>Bank</dt><dd>{d.bankName}</dd></>}
        </>
      )}
      {d?.method === 'upi' && (
        <>
          <dt>Paid to</dt><dd>UPI</dd>
          <dt>UPI ID</dt><dd>{d.upiId}</dd>
          {d.accountName && <><dt>Name</dt><dd>{d.accountName}</dd></>}
        </>
      )}
      {account.payoutDetailsChangedAt && <><dt>Last changed</dt><dd>{formatDateTime(account.payoutDetailsChangedAt)}</dd></>}
      {account.payoutDetailsVerifiedAt && <><dt>Verified</dt><dd>{formatDateTime(account.payoutDetailsVerifiedAt)}</dd></>}
    </dl>
  );
}

// ── Statement ──

const STATEMENT_PAGE = 50;

/**
 * Newest first, with the balance after each line, paged back by the server's cursor; optional India-date period, and
 * the same period as a CSV read into memory. `queryKey` must identify the account (and the person's scope).
 */
export function StatementSection({ queryKey, load, csv, csvPrefix, emptyText }: {
  queryKey: readonly unknown[];
  load: (q: StatementQuery) => Promise<StatementPage>;
  csv: (q: PeriodQuery, signal?: AbortSignal) => Promise<Blob>;
  csvPrefix: string;
  emptyText: string;
}) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const bad = (from && !isRealDate(from)) || (to && !isRealDate(to)) ? 'Enter real dates.' : from && to && from > to ? 'The period ends before it starts.' : null;
  const period: PeriodQuery | null = bad ? null : { ...(from ? { from } : {}), ...(to ? { to } : {}) };
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
  const filtered = !!(from || to);

  return (
    <section className="ws-section" aria-labelledby="fin-st-h">
      <h2 id="fin-st-h">Statement</h2>
      <div className="ws-search" role="group" aria-label="Statement period">
        <TextField label="From (India date)" type="date" value={from} onChange={(e) => setFrom(e.target.value)} error={bad} />
        <TextField label="To (India date)" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        {period && <CsvDownload key={JSON.stringify(period)} period={period} csv={csv} csvPrefix={csvPrefix} />}
      </div>
      <p className="ws-muted">Newest first. “Balance after” is the whole account’s balance right after each entry, whatever the period shown.</p>
      {!period ? null
        : list.isPending ? <Loading label="Loading the statement…" />
        : list.isError && !list.data ? <ErrorState message={messageOf(list.error)} onRetry={() => void list.refetch()} />
        : lines.length === 0 ? <Empty title="No entries">{filtered ? 'Nothing was recorded in this period.' : emptyText}</Empty>
        : (
          <>
            <div className="ws-table-wrap">
              <table className="j-table">
                <caption className="j-sr-only">Statement entries, newest first</caption>
                <thead>
                  <tr>
                    <th scope="col">Date (India time)</th><th scope="col">Description</th><th scope="col">Type</th><th scope="col">Reference</th>
                    <th scope="col" className="fin-amount">Amount</th><th scope="col" className="fin-amount">Balance after</th>
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
            {list.isFetchNextPageError && <ErrorState message={`Could not load older entries: ${messageOf(list.error)}`} onRetry={() => void list.fetchNextPage()} />}
            {list.hasNextPage && (
              <div><Button variant="secondary" busy={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>Show older entries</Button></div>
            )}
          </>
        )}
    </section>
  );
}

/**
 * The statement CSV of one period, read with the session's token into an in-memory blob (never a link with a token).
 * Keyed by the period: changing it aborts a running download and drops the file of the old period.
 */
export function CsvDownload({ period, csv, csvPrefix }: { period: PeriodQuery; csv: (q: PeriodQuery, signal?: AbortSignal) => Promise<Blob>; csvPrefix: string }) {
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
      if (!real) { setError('The server did not return the statement file. Try again.'); return; }
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

  const which = period.from || period.to ? `${period.from ? `from ${formatDate(period.from)} ` : ''}${period.to ? `to ${formatDate(period.to)}` : ''}`.trim() : 'all entries';
  return (
    <div className="ws-action">
      <Button variant="secondary" busy={busy} onClick={() => void download()}>
        <Download size={16} aria-hidden="true" /> Download CSV ({which})
      </Button>
      {file && <a href={file.url} download={file.name}>Save {file.name} again</a>}
      {error && <Alert>Could not download the statement: {error}</Alert>}
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
            <th scope="col">Paid on</th>
            {accountCell && <th scope="col">Account</th>}
            <th scope="col" className="fin-amount">Amount</th><th scope="col">Method</th><th scope="col">Reference</th>
            <th scope="col">Sent to</th><th scope="col">Status</th>
            {actions && <th scope="col">Actions</th>}
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
              <td>{p.destination?.label}{p.destination ? <div className="ws-muted">Details version {p.destination.detailsVersion}</div> : null}</td>
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

const ACTION_LABEL: Record<string, string> = {
  'finance.payout_details_changed': 'Payout details changed',
  'finance.payout_details_verified': 'Payout details verified',
  'finance.payout_recorded': 'Payout recorded',
  'finance.payout_voided': 'Payout voided',
  'finance.adjustment_posted': 'Adjustment posted',
};

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/** The event's own details in a sentence (amounts, references, destinations; never anything else from `detail`). */
export function eventText(e: FinanceEvent): string {
  const d = e.detail ?? {};
  const amount = num(d.amountMinor);
  const version = num(d.version);
  switch (e.action) {
    case 'finance.payout_details_changed':
      return [d.method === 'upi' ? `UPI ${str(d.upiId) ?? ''}`.trim() : `Bank${str(d.ifsc) ? `, IFSC ${str(d.ifsc)}` : ''}${str(d.last4) ? `, account ending ${str(d.last4)}` : ''}`,
        version ? `version ${version}` : ''].filter(Boolean).join(' · ');
    case 'finance.payout_details_verified':
      return version ? `Version ${version}` : '';
    case 'finance.payout_recorded':
      return [amount !== undefined ? money(amount) : '', str(d.reference) ? `reference ${str(d.reference)}` : '', str(d.paidOn) ? `paid on ${formatDate(str(d.paidOn))}` : ''].filter(Boolean).join(' · ');
    case 'finance.payout_voided':
    case 'finance.adjustment_posted':
      return [amount !== undefined ? (amount < 0 ? `− ${money(-amount)}` : money(amount)) : '', str(d.reason) ? `“${str(d.reason)}”` : ''].filter(Boolean).join(' · ');
    default:
      return '';
  }
}

export function EventsList({ events, selfId }: { events: readonly FinanceEvent[]; selfId?: string }) {
  const who = (e: FinanceEvent) => (e.byKind === 'admin' ? 'Jansetu admin' : e.byKind === 'doctor' ? 'The doctor' : selfId && e.by === selfId ? 'You' : 'A member');
  return (
    <ul className="fin-events">
      {events.map((e) => (
        <li key={e._id}>
          <time dateTime={e.at}>{formatDateTime(e.at)}</time>
          <strong>{ACTION_LABEL[e.action] ?? e.action}</strong> · {who(e)}
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
export function PagedSection<T extends { _id: string }>({ id, title, queryKey, load, empty, more = 'Show more', children }: {
  id: string; title: string; queryKey: readonly unknown[];
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
      {list.isPending ? <Loading label={`Loading ${title.toLowerCase()}…`} />
        : list.isError && !list.data ? <ErrorState message={messageOf(list.error)} onRetry={() => void list.refetch()} />
        : rows.length === 0 ? <Empty title={`No ${title.toLowerCase()}`}>{empty}</Empty>
        : (
          <>
            <p className="ws-count">{total} in all · showing {rows.length}</p>
            {children(rows)}
            {list.isFetchNextPageError && <ErrorState message={`Could not load more: ${messageOf(list.error)}`} onRetry={() => void list.fetchNextPage()} />}
            {list.hasNextPage && (
              <div><Button variant="secondary" busy={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>{more}</Button></div>
            )}
          </>
        )}
    </section>
  );
}

/** A list section with the four states. */
export function ListSection<T>({ id, title, q, empty, children }: {
  id: string; title: string;
  q: { isPending: boolean; isError: boolean; error: unknown; data: T[] | undefined; refetch: () => unknown };
  empty: string; children: (rows: T[]) => ReactNode;
}) {
  return (
    <section className="ws-section" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {q.isPending ? <Loading label={`Loading ${title.toLowerCase()}…`} />
        : q.isError || !q.data ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : q.data.length === 0 ? <Empty title={`No ${title.toLowerCase()}`}>{empty}</Empty>
        : children(q.data)}
    </section>
  );
}

// ── Payout destination form ──

interface DetailsDraft { method: 'bank' | 'upi'; accountName: string; accountNumber: string; confirmNumber: string; ifsc: string; bankName: string; upiId: string }
const BLANK: DetailsDraft = { method: 'bank', accountName: '', accountNumber: '', confirmNumber: '', ifsc: '', bankName: '', upiId: '' };

/** The form's starting point: the saved destination (the account number only where the server shows it in full: admins). */
export function draftOfDetails(a: SettlementAccount | null): DetailsDraft {
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
  account: SettlementAccount | null;
  audience: 'owner' | 'admin';
  reread: () => Promise<SettlementAccount | null>;
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
      setStale(`The payout details were changed elsewhere while you were editing (now version ${v}). The form shows what is saved now; make your change again if it is still needed.`);
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
  const allErrors: Record<string, string | undefined> = { ...built.errors, ...(mismatch ? { confirmNumber: 'The two account numbers are not the same.' } : {}) };
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
        else setStale(`The payout details were changed elsewhere while you were saving (now version ${v}). Nothing was saved; the form shows what is saved now. Make your change again if it is still needed.`);
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
        if (live.current) setStale('The payout details were changed elsewhere just as you saved, so nothing was saved. The form shows what is saved now; make your change again if it is still needed.');
        return;
      }
      if (!sent || definitelyNotRecorded(err)) setError(sent ? `Not saved: ${messageOf(err)}` : messageOf(err));
      else onLost(`The answer did not come back (${messageOf(err)}), so the details may or may not have been saved. Check the payout details shown before changing them again.`);
    } finally {
      if (live.current) setBusy(false);
    }
  }

  const label = built.body ? detailsLabel(built.body.method === 'bank'
    ? { method: 'bank', ifsc: built.body.ifsc, bankName: built.body.bankName, accountNumberLast4: built.body.accountNumber.slice(-4) }
    : { method: 'upi', upiId: built.body.upiId }) : '';
  return (
    <form className="rx-form" noValidate onSubmit={review} aria-label="Change payout details">
      {stale && <Alert tone="warn">{stale}</Alert>}
      <fieldset className="fin-radio">
        <legend>Pay to</legend>
        <label><input type="radio" name="fin-method" checked={draft.method === 'bank'} onChange={() => set('method', 'bank')} /> Bank account</label>
        <label><input type="radio" name="fin-method" checked={draft.method === 'upi'} onChange={() => set('method', 'upi')} /> UPI</label>
      </fieldset>
      {draft.method === 'bank' ? (
        <div className="rx-form-row">
          <TextField label="Account holder name" value={draft.accountName} maxLength={MAX_ACCOUNT_NAME} error={errors.accountName} onChange={(e) => set('accountName', e.target.value)} />
          <TextField label="Account number" inputMode="numeric" autoComplete="off" value={draft.accountNumber} error={errors.accountNumber}
            hint={audience === 'owner' && account?.payoutDetails?.method === 'bank' ? 'Enter the full number: the saved one is shown masked.' : undefined}
            onChange={(e) => set('accountNumber', e.target.value)} />
          <TextField label="Account number again" inputMode="numeric" autoComplete="off" value={draft.confirmNumber} error={errors.confirmNumber}
            onChange={(e) => set('confirmNumber', e.target.value)} />
          <TextField label="IFSC" value={draft.ifsc} maxLength={11} error={errors.ifsc} onChange={(e) => set('ifsc', e.target.value)} />
          <TextField label="Bank name (optional)" value={draft.bankName} maxLength={MAX_BANK_NAME} error={errors.bankName} onChange={(e) => set('bankName', e.target.value)} />
        </div>
      ) : (
        <div className="rx-form-row">
          <TextField label="UPI ID" value={draft.upiId} maxLength={MAX_UPI_ID} error={errors.upiId} onChange={(e) => set('upiId', e.target.value)} />
          <TextField label="Name (optional)" value={draft.accountName} maxLength={MAX_ACCOUNT_NAME} error={errors.accountName} onChange={(e) => set('accountName', e.target.value)} />
        </div>
      )}
      {error && <Alert>{error}</Alert>}
      {!reviewing ? (
        <div className="rx-actions ws-actions">
          <Button type="submit">Review the change</Button>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        </div>
      ) : (
        <div className="confirm" role="group" aria-label="Save the payout details">
          <div className="confirm-text">
            {audience === 'owner'
              ? <>Send payouts to {label} from now on? Jansetu must verify any change (even to the same details) before the next payout: payouts wait until then. The earlier details stop being used.</>
              : <>Save {label} as the payout details? They replace the current ones and must be verified again before a payout can be recorded to them.</>}
          </div>
          <div className="confirm-actions">
            <Button busy={busy} onClick={() => void send()}>Save payout details</Button>
            <Button variant="ghost" disabled={busy} onClick={() => setReviewing(false)}>Back</Button>
          </div>
        </div>
      )}
    </form>
  );
}
