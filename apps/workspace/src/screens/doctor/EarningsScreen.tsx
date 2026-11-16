import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError, LEDGER_KIND_LABEL, payoutDetailsProblems, periodProblem, statementCsvName,
  type FinanceSummary, type Page, type PayoutDetailsInput, type PayoutDetailsView, type SettlementAccountView,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, Loading, TextField, formatDateTime } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { definitelyNotRecorded } from '../../requests.ts';
import { formatDay } from '../partner/labs.tsx';
import { NotADoctor, rupeesOf, useDoctor, type DoctorContext } from './doctor.tsx';

const STATEMENT_PAGE = 50;
const PAYOUT_METHOD_LABEL = { bank_transfer: 'Bank transfer', upi: 'UPI', other: 'Other' } as const;
const EVENT_LABEL: Record<string, string> = {
  'finance.payout_details_changed': 'Payout details changed',
  'finance.payout_details_verified': 'Payout details verified by Jansetu',
  'finance.payout_recorded': 'Payout recorded',
  'finance.payout_voided': 'Payout voided',
  'finance.adjustment_posted': 'Adjustment',
};
const BY_LABEL = { admin: 'Jansetu', member: 'Clinic staff', doctor: 'You' } as const;

/** The doctor's earnings (Q5): balance, statement, CSV, payouts, earlier history and the payout destination. */
export function EarningsScreen() {
  const d = useDoctor();
  if (!d) return <NotADoctor />;
  return <Earnings key={d.identity} d={d} />;
}

const financeKey = (d: DoctorContext) => [...d.key, 'finance'];

function Earnings({ d }: { d: DoctorContext }) {
  const finance = useQuery({ queryKey: financeKey(d), queryFn: () => d.api.finance() });
  return (
    <>
      <PageHeading title="Earnings">What you earned through Jansetu, what was paid out, and where payouts go. Amounts in rupees; dates India time.</PageHeading>
      {finance.isPending ? <Loading label="Loading your earnings…" />
        : finance.isError ? <ErrorState message={messageOf(finance.error)} onRetry={() => void finance.refetch()} />
        : (
          <>
            <Summary f={finance.data} />
            <PayoutDestination d={d} account={finance.data.account} />
          </>
        )}
      <Statement d={d} />
      <Payouts d={d} />
      <History d={d} />
      <Events d={d} />
    </>
  );
}

function Summary({ f }: { f: FinanceSummary }) {
  return (
    <section className="ws-section" aria-labelledby="bal-h">
      <h2 id="bal-h">Balance</h2>
      {!f.account ? <p className="ws-muted">Nothing earned through Jansetu yet.</p> : null}
      <dl className="ws-dl">
        <dt>Balance due to you</dt><dd><strong>{rupeesOf(f.balanceMinor)}</strong></dd>
        <dt>Earned</dt><dd>{rupeesOf(f.totals.earnedMinor)}</dd>
        <dt>Reversed (refunds)</dt><dd>{rupeesOf(f.totals.reversedMinor)}</dd>
        <dt>Paid out</dt><dd>{rupeesOf(f.totals.paidOutMinor)}</dd>
        <dt>Adjustments</dt><dd>{rupeesOf(f.totals.adjustedMinor)}</dd>
        <dt>Last payout</dt>
        <dd>{f.lastPayout ? `${rupeesOf(f.lastPayout.amountMinor)} on ${formatDay(f.lastPayout.paidOn)} · ${f.lastPayout.destination.label}` : 'None yet'}</dd>
      </dl>
    </section>
  );
}

// ── Payout destination ──

const detailsText = (p: PayoutDetailsView) => (p.method === 'upi'
  ? `UPI ${p.upiId ?? ''}${p.accountName ? ` (${p.accountName})` : ''}`
  : `${p.bankName ? `${p.bankName} · ` : ''}${p.accountNumberMasked ?? (p.accountNumberLast4 ? `XXXX${p.accountNumberLast4}` : '')} · IFSC ${p.ifsc ?? ''}${p.accountName ? ` · ${p.accountName}` : ''}`);

function PayoutDestination({ d, account }: { d: DoctorContext; account: SettlementAccountView | null }) {
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const state = account?.payoutDetailsState ?? 'none';
  return (
    <section className="ws-section" aria-labelledby="dest-h">
      <h2 id="dest-h">Where payouts go</h2>
      {notice && <Alert tone="ok">{notice}</Alert>}
      {account?.payoutDetails ? (
        <p>
          {detailsText(account.payoutDetails)}{' '}
          {state === 'verified' ? <Badge tone="ok">Verified</Badge> : <Badge tone="warn">Waiting for Jansetu to verify</Badge>}
        </p>
      ) : <p className="ws-muted">No payout details yet. Add them so Jansetu can pay you.</p>}
      {state === 'unverified' && <Alert tone="warn">No payout is made until Jansetu has checked these details.</Alert>}
      <p className="ws-muted">Any change, even to the same details, has to be verified by Jansetu again before the next payout.</p>
      {open
        ? <PayoutForm d={d} version={account?.payoutDetailsVersion ?? 0} onClose={() => setOpen(false)}
            onSaved={(a) => { setOpen(false); setNotice(`Saved: ${a.payoutDetails ? detailsText(a.payoutDetails) : ''}. Jansetu verifies it before the next payout.`); }} />
        : <div className="ws-actions"><Button variant="secondary" onClick={() => { setOpen(true); setNotice(null); }}>{account?.payoutDetails ? 'Change payout details' : 'Add payout details'}</Button></div>}
    </section>
  );
}

function PayoutForm({ d, version, onClose, onSaved }: {
  d: DoctorContext; version: number; onClose: () => void; onSaved: (a: SettlementAccountView) => void;
}) {
  const queryClient = useQueryClient();
  // The version the form was opened against: a change saved elsewhere meanwhile is shown, never silently replaced.
  const baseVersion = useRef(version);
  const [f, setF] = useState<PayoutDetailsInput>({ method: 'bank', accountName: '', accountNumber: '', ifsc: '', bankName: '', upiId: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ tone: 'warn' | 'error'; text: string } | null>(null);
  const set = (k: keyof PayoutDetailsInput) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const lock = confirming || busy;

  function review(e: FormEvent) {
    e.preventDefault();
    setFailure(null);
    const p = payoutDetailsProblems(f);
    setErrors(p as Record<string, string>);
    if (Object.keys(p).length === 0) setConfirming(true);
  }

  async function save() {
    setBusy(true);
    setFailure(null);
    try {
      const fresh = await queryClient.fetchQuery({ queryKey: financeKey(d), queryFn: () => d.api.finance(), staleTime: 0 });
      const now = fresh.account?.payoutDetailsVersion ?? 0;
      if (now !== baseVersion.current) {
        baseVersion.current = now;
        setConfirming(false);
        setFailure({ tone: 'warn', text: `Your payout details were changed since you opened this form${fresh.account?.payoutDetails ? ` (now: ${detailsText(fresh.account.payoutDetails)})` : ''}. Check them; send yours again only if they are still needed.` });
        return;
      }
      // Q13: also fenced on the server (409 PAYOUT_DETAILS_CHANGED) for a change landing after this read.
      const a = await d.api.setPayoutDetails(f, baseVersion.current);
      queryClient.setQueryData<FinanceSummary>(financeKey(d), (old) => (old ? { ...old, account: a } : old));
      onSaved(a);
    } catch (err) {
      setConfirming(false);
      if (err instanceof ApiError && err.code === 'PAYOUT_DETAILS_CHANGED') {
        // Read what is there now and make it the base: the doctor reviews it before deciding to send again.
        const fresh = await queryClient.fetchQuery({ queryKey: financeKey(d), queryFn: () => d.api.finance(), staleTime: 0 }).catch(() => null);
        if (fresh) baseVersion.current = fresh.account?.payoutDetailsVersion ?? 0;
        setFailure({ tone: 'warn', text: `Your payout details were changed since you opened this form${fresh?.account?.payoutDetails ? ` (now: ${detailsText(fresh.account.payoutDetails)})` : ''}. Check them; send yours again only if they are still needed.` });
        return;
      }
      setFailure({ tone: 'error', text: definitelyNotRecorded(err) ? `Not saved: ${messageOf(err)}`
        : `${messageOf(err)} They may have been saved: look at the details above before sending again.` });
    } finally {
      setBusy(false);
      void queryClient.invalidateQueries({ queryKey: financeKey(d) });
      void queryClient.invalidateQueries({ queryKey: [...d.key, 'finance-events'] });
    }
  }

  const masked = f.method === 'bank' ? `account ending ${(f.accountNumber ?? '').replace(/\s+/g, '').slice(-4)}, IFSC ${(f.ifsc ?? '').trim().toUpperCase()}` : `UPI ${(f.upiId ?? '').trim().toLowerCase()}`;
  return (
    <form className="rx-form" noValidate onSubmit={review} aria-label="Payout details">
      <fieldset className="ws-checks">
        <legend>Pay me by</legend>
        <label className="ws-check"><input type="radio" name="payout-method" checked={f.method === 'bank'} disabled={lock} onChange={() => setF((x) => ({ ...x, method: 'bank' }))} />Bank transfer</label>
        <label className="ws-check"><input type="radio" name="payout-method" checked={f.method === 'upi'} disabled={lock} onChange={() => setF((x) => ({ ...x, method: 'upi' }))} />UPI</label>
      </fieldset>
      <div className="rx-form-row">
        {f.method === 'bank' ? (
          <>
            <TextField label="Account holder" value={f.accountName} error={errors.accountName} disabled={lock} onChange={set('accountName')} autoComplete="off" />
            <TextField label="Account number" inputMode="numeric" value={f.accountNumber} error={errors.accountNumber} disabled={lock} onChange={set('accountNumber')} autoComplete="off" />
            <TextField label="IFSC" value={f.ifsc} error={errors.ifsc} disabled={lock} onChange={set('ifsc')} autoComplete="off" />
            <TextField label="Bank name (optional)" value={f.bankName} error={errors.bankName} disabled={lock} onChange={set('bankName')} autoComplete="off" />
          </>
        ) : (
          <>
            <TextField label="UPI ID" value={f.upiId} error={errors.upiId} disabled={lock} onChange={set('upiId')} autoComplete="off" />
            <TextField label="Name (optional)" value={f.accountName} error={errors.accountName} disabled={lock} onChange={set('accountName')} autoComplete="off" />
          </>
        )}
      </div>
      {failure && <Alert tone={failure.tone}>{failure.text}</Alert>}
      {!confirming ? (
        <div className="confirm-actions">
          <Button type="submit">Review</Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      ) : (
        <div className="confirm" role="group" aria-label="Save payout details">
          <div className="confirm-text">
            Send future payouts to {masked}? The details you have now stop being used, and no payout is made until Jansetu has verified the new ones.
          </div>
          <div className="confirm-actions">
            <Button busy={busy} onClick={() => void save()}>Save payout details</Button>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>Back</Button>
          </div>
        </div>
      )}
    </form>
  );
}

// ── Statement ──

function Statement({ d }: { d: DoctorContext }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [period, setPeriod] = useState<{ from?: string; to?: string }>({});
  const [periodError, setPeriodError] = useState<string | null>(null);
  const q = useInfiniteQuery({
    queryKey: [...d.key, 'statement', period.from ?? '', period.to ?? ''],
    queryFn: ({ pageParam }) => d.api.statement({ before: pageParam, limit: STATEMENT_PAGE, from: period.from, to: period.to }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  function apply(e: FormEvent) {
    e.preventDefault();
    const p = periodProblem(from || undefined, to || undefined);
    setPeriodError(p);
    if (!p) setPeriod({ ...(from ? { from } : {}), ...(to ? { to } : {}) });
  }

  const lines = q.data?.pages.flatMap((p) => p.lines) ?? [];
  const olderError = q.isFetchNextPageError ? messageOf(q.error) : null;
  return (
    <section className="ws-section" aria-labelledby="stmt-h">
      <h2 id="stmt-h">Statement</h2>
      <form className="ws-search" noValidate onSubmit={apply} aria-label="Statement period">
        <TextField label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <TextField label="To" type="date" value={to} error={periodError} onChange={(e) => setTo(e.target.value)} />
        <Button type="submit" variant="secondary">Show</Button>
      </form>
      {/* Keyed by period: a download started for one period never reports into another. */}
      <CsvDownload key={`${period.from ?? ''}:${period.to ?? ''}`} d={d} from={period.from} to={period.to} />
      {q.isPending ? <Loading label="Loading the statement…" />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : lines.length === 0 ? <Empty title="No entries">{period.from || period.to ? 'Nothing in this period.' : 'Nothing has been earned or paid out yet.'}</Empty>
        : (
          <>
            <div className="ws-table-wrap">
              <table className="j-table" aria-label="Statement lines">
                <thead><tr><th scope="col">Date</th><th scope="col">Type</th><th scope="col">Description</th><th scope="col">Amount</th><th scope="col">Balance after</th></tr></thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l._id}>
                      <td>{formatDateTime(l.at)}</td>
                      <td>{LEDGER_KIND_LABEL[l.kind] ?? l.kind}</td>
                      <td>{l.description}{l.reference ? ` · ref ${l.reference}` : ''}{l.note ? <div className="ws-muted">{l.note}</div> : null}</td>
                      <td>{rupeesOf(l.amountMinor)}</td>
                      <td>{rupeesOf(l.balanceAfterMinor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {q.hasNextPage && <div className="ws-actions"><Button variant="secondary" busy={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Show older entries</Button></div>}
            {olderError && <Alert>Could not load older entries: {olderError}</Alert>}
          </>
        )}
    </section>
  );
}

/** The period's CSV, read with the session's token into an in-memory blob and saved under the server's file name. */
function CsvDownload({ d, from, to }: { d: DoctorContext; from?: string; to?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  useEffect(() => () => ctrl.current?.abort(), []);

  async function download() {
    ctrl.current?.abort();
    const mine = new AbortController();
    ctrl.current = mine;
    setBusy(true);
    setError(null);
    try {
      const blob = await d.api.statementCsv({ from, to }, mine.signal);
      if (mine.signal.aborted) return;
      const url = URL.createObjectURL(new Blob([blob], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = statementCsvName(from, to);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      if (!mine.signal.aborted) setError(messageOf(err));
    } finally {
      if (ctrl.current === mine) { ctrl.current = null; setBusy(false); }
    }
  }

  return (
    <div className="ws-action">
      <Button variant="secondary" busy={busy} onClick={() => void download()}>
        Download CSV{from || to ? ` (${from ? formatDay(from) : 'start'} to ${to ? formatDay(to) : 'today'})` : ' (everything)'}
      </Button>
      {error && <Alert>Could not download the statement: {error}</Alert>}
    </div>
  );
}

// ── Payouts, earlier history, activity ──

/** Q13: payouts and events come newest first, a page at a time, by the exact cursor the server gives. */
function usePaged<T>(key: readonly unknown[], read: (cursor?: string) => Promise<Page<T>>) {
  const q = useInfiniteQuery({
    queryKey: key, queryFn: ({ pageParam }) => read(pageParam),
    initialPageParam: undefined as string | undefined, getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const total = q.data?.pages[0]?.total ?? 0;
  return { q, items, total };
}

function MoreButton({ q, label }: { q: ReturnType<typeof usePaged>['q']; label: string }) {
  if (!q.hasNextPage) return null;
  return (
    <>
      <div className="ws-actions"><Button variant="secondary" busy={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{label}</Button></div>
      {q.isFetchNextPageError && <Alert>Could not load more: {messageOf(q.error)}</Alert>}
    </>
  );
}

function Payouts({ d }: { d: DoctorContext }) {
  const { q, items, total } = usePaged([...d.key, 'payouts'], (c) => d.api.payouts(c));
  return (
    <section className="ws-section" aria-labelledby="payouts-h">
      <h2 id="payouts-h">Payouts</h2>
      {q.isPending ? <Loading label="Loading payouts…" />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : items.length === 0 ? <Empty title="No payouts yet" />
        : (
          <>
          <p className="ws-count">Showing {items.length} of {total}</p>
          <div className="ws-table-wrap">
            <table className="j-table" aria-label="Payouts">
              <thead><tr><th scope="col">Paid on</th><th scope="col">Amount</th><th scope="col">How</th><th scope="col">Reference</th><th scope="col">To</th><th scope="col">State</th></tr></thead>
              <tbody>
                {items.map((p) => (
                  <tr key={p._id}>
                    <td>{formatDay(p.paidOn)}</td>
                    <td>{rupeesOf(p.amountMinor)}</td>
                    <td>{PAYOUT_METHOD_LABEL[p.method] ?? p.method}</td>
                    <td>{p.reference}</td>
                    <td>{p.destination.label}</td>
                    <td>{p.state === 'voided' ? <><Badge tone="danger">Voided</Badge>{p.voidReason ? <div className="ws-muted">{p.voidReason}</div> : null}</> : <Badge tone="ok">Paid</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <MoreButton q={q} label="Show older payouts" />
          </>
        )}
    </section>
  );
}

function History({ d }: { d: DoctorContext }) {
  const q = useQuery({ queryKey: [...d.key, 'finance-history'], queryFn: () => d.api.history() });
  if (q.isSuccess && q.data.length === 0) return null; // only doctors moved from the earlier payout system have any
  return (
    <section className="ws-section" aria-labelledby="hist-h">
      <h2 id="hist-h">Earlier payouts (before the current statement)</h2>
      <p className="ws-muted">For reference only: these are not part of the balance above.</p>
      {q.isPending ? <Loading label="Loading earlier payouts…" />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : (
          <div className="ws-table-wrap">
            <table className="j-table" aria-label="Earlier payouts">
              <thead><tr><th scope="col">Date</th><th scope="col">Period</th><th scope="col">Kind</th><th scope="col">Amount</th></tr></thead>
              <tbody>
                {q.data.map((h) => (
                  <tr key={h._id}>
                    <td>{formatDateTime(h.at)}</td>
                    <td>{h.periodLabel ?? '—'}</td>
                    <td>{h.legacyKind === 'disbursal' ? 'Paid out' : 'Billed'}</td>
                    <td>{rupeesOf(h.amountMinor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </section>
  );
}

function Events({ d }: { d: DoctorContext }) {
  const { q, items } = usePaged([...d.key, 'finance-events'], (c) => d.api.events(c));
  return (
    <section className="ws-section" aria-labelledby="ev-h">
      <h2 id="ev-h">Account activity</h2>
      {q.isPending ? <Loading label="Loading activity…" />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : items.length === 0 ? <Empty title="No activity yet" />
        : (
          <>
          <ul className="ws-timeline" aria-label="Account activity">
            {items.map((e) => (
              <li key={e._id}><time dateTime={e.at}>{formatDateTime(e.at)}</time><span>{EVENT_LABEL[e.action] ?? e.action} · {BY_LABEL[e.byKind] ?? e.byKind}</span></li>
            ))}
          </ul>
          <MoreButton q={q} label="Show older activity" />
          </>
        )}
    </section>
  );
}
