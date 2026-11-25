import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError, DOCTOR_LEDGER_KIND_LABEL as LEDGER_KIND_LABEL, doctorPayoutDetailsProblems as payoutDetailsProblems, periodProblem,
  doctorStatementCsvName as statementCsvName, type DoctorFinanceSummary as FinanceSummary, type Page,
  type DoctorPayoutDetailsInput as PayoutDetailsInput, type DoctorPayoutDetailsView as PayoutDetailsView, type SettlementAccountView,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, Loading, TextField, formatDateTime } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { definitelyNotRecorded } from '../../requests.ts';
import { formatDay } from '../partner/labs.tsx';
import { NotADoctor, rupeesOf, useDoctor, type DoctorContext } from './doctor.tsx';
import { t } from '../../i18n/doctor/index.ts';

const STATEMENT_PAGE = 50;
const PAYOUT_METHOD_LABEL = () => ({ bank_transfer: t('earnings.bankTransfer'), upi: 'UPI', other: 'Other' } as const);
const EVENT_LABEL = (): Record<string, string> => ({
  'finance.payout_details_changed': t('earnings.payoutDetailsChanged'),
  'finance.payout_details_verified': t('earnings.payoutDetailsVerifiedByJansetu'),
  'finance.payout_recorded': t('earnings.payoutRecorded'),
  'finance.payout_voided': t('earnings.payoutVoided'),
  'finance.adjustment_posted': 'Adjustment',
});
const BY_LABEL = () => ({ admin: 'Jansetu', member: t('earnings.clinicStaff'), doctor: 'You' } as const);

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
      <PageHeading title={t('earnings.earnings')}>{t('earnings.whatYouEarnedThroughJansetu')}</PageHeading>
      <p className="ws-muted">{t('earnings.youEarnForAConsultation')}</p>
      {finance.isPending ? <Loading label={t('earnings.loadingYourEarnings')} />
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
      <h2 id="bal-h">{t('earnings.balance')}</h2>
      {!f.account ? <p className="ws-muted">{t('earnings.nothingEarnedThroughJansetuYet')}</p> : null}
      <dl className="ws-dl">
        <dt>{t('earnings.balanceDueToYou')}</dt><dd><strong>{rupeesOf(f.balanceMinor)}</strong></dd>
        <dt>{t('earnings.earned')}</dt><dd>{rupeesOf(f.totals.earnedMinor)}</dd>
        <dt>{t('earnings.reversedRefunds')}</dt><dd>{rupeesOf(f.totals.reversedMinor)}</dd>
        <dt>{t('earnings.paidOut')}</dt><dd>{rupeesOf(f.totals.paidOutMinor)}</dd>
        <dt>{t('earnings.adjustments')}</dt><dd>{rupeesOf(f.totals.adjustedMinor)}</dd>
        <dt>{t('earnings.lastPayout')}</dt>
        <dd>{f.lastPayout ? `${rupeesOf(f.lastPayout.amountMinor)} on ${formatDay(f.lastPayout.paidOn)} · ${f.lastPayout.destination.label}` : t('earnings.noneYet')}</dd>
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
      <h2 id="dest-h">{t('earnings.wherePayoutsGo')}</h2>
      {notice && <Alert tone="ok">{notice}</Alert>}
      {account?.payoutDetails ? (
        <p>
          {detailsText(account.payoutDetails)}{' '}
          {state === 'verified' ? <Badge tone="ok">{t('common.verified')}</Badge> : <Badge tone="warn">{t('earnings.waitingForJansetuToVerify')}</Badge>}
        </p>
      ) : <p className="ws-muted">{t('earnings.noPayoutDetailsYetAdd')}</p>}
      {state === 'unverified' && <Alert tone="warn">{t('earnings.noPayoutIsMadeUntil')}</Alert>}
      <p className="ws-muted">{t('earnings.anyChangeEvenToThe')}</p>
      {open
        ? <PayoutForm d={d} version={account?.payoutDetailsVersion ?? 0} onClose={() => setOpen(false)}
            onSaved={(a) => { setOpen(false); setNotice(t('earnings.savedJansetuVerifiesItBefore', { value: a.payoutDetails ? detailsText(a.payoutDetails) : '' })); }} />
        : <div className="ws-actions"><Button variant="secondary" onClick={() => { setOpen(true); setNotice(null); }}>{account?.payoutDetails ? t('earnings.changePayoutDetails') : t('earnings.addPayoutDetails')}</Button></div>}
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
        setFailure({ tone: 'warn', text: t('earnings.yourPayoutDetailsWereChanged', { value: fresh.account?.payoutDetails ? ` (now: ${detailsText(fresh.account.payoutDetails)})` : '' }) });
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
        setFailure({ tone: 'warn', text: t('earnings.yourPayoutDetailsWereChanged', { value: fresh?.account?.payoutDetails ? ` (now: ${detailsText(fresh.account.payoutDetails)})` : '' }) });
        return;
      }
      setFailure({ tone: 'error', text: definitelyNotRecorded(err) ? t('common.notSaved', { value: messageOf(err) })
        : t('earnings.theyMayHaveBeenSaved', { value: messageOf(err) }) });
    } finally {
      setBusy(false);
      void queryClient.invalidateQueries({ queryKey: financeKey(d) });
      void queryClient.invalidateQueries({ queryKey: [...d.key, 'finance-events'] });
    }
  }

  const masked = f.method === 'bank' ? `account ending ${(f.accountNumber ?? '').replace(/\s+/g, '').slice(-4)}, IFSC ${(f.ifsc ?? '').trim().toUpperCase()}` : `UPI ${(f.upiId ?? '').trim().toLowerCase()}`;
  return (
    <form className="rx-form" noValidate onSubmit={review} aria-label={t('earnings.payoutDetails')}>
      <fieldset className="ws-checks">
        <legend>{t('earnings.payMeBy')}</legend>
        <label className="ws-check"><input type="radio" name="payout-method" checked={f.method === 'bank'} disabled={lock} onChange={() => setF((x) => ({ ...x, method: 'bank' }))} />{t('earnings.bankTransfer')}</label>
        <label className="ws-check"><input type="radio" name="payout-method" checked={f.method === 'upi'} disabled={lock} onChange={() => setF((x) => ({ ...x, method: 'upi' }))} />{t('earnings.upi')}</label>
      </fieldset>
      <div className="rx-form-row">
        {f.method === 'bank' ? (
          <>
            <TextField label={t('earnings.accountHolder')} value={f.accountName} error={errors.accountName} disabled={lock} onChange={set('accountName')} autoComplete="off" />
            <TextField label={t('earnings.accountNumber')} inputMode="numeric" value={f.accountNumber} error={errors.accountNumber} disabled={lock} onChange={set('accountNumber')} autoComplete="off" />
            <TextField label={t('earnings.ifsc')} value={f.ifsc} error={errors.ifsc} disabled={lock} onChange={set('ifsc')} autoComplete="off" />
            <TextField label={t('earnings.bankNameOptional')} value={f.bankName} error={errors.bankName} disabled={lock} onChange={set('bankName')} autoComplete="off" />
          </>
        ) : (
          <>
            <TextField label={t('earnings.upiId')} value={f.upiId} error={errors.upiId} disabled={lock} onChange={set('upiId')} autoComplete="off" />
            <TextField label={t('earnings.nameOptional')} value={f.accountName} error={errors.accountName} disabled={lock} onChange={set('accountName')} autoComplete="off" />
          </>
        )}
      </div>
      {failure && <Alert tone={failure.tone}>{failure.text}</Alert>}
      {!confirming ? (
        <div className="confirm-actions">
          <Button type="submit">{t('common.review')}</Button>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
        </div>
      ) : (
        <div className="confirm" role="group" aria-label={t('earnings.savePayoutDetails')}>
          <div className="confirm-text">{t('earnings.sendFuturePayoutsTo')}{masked}{t('earnings.theDetailsYouHaveNow')}</div>
          <div className="confirm-actions">
            <Button busy={busy} onClick={() => void save()}>{t('earnings.savePayoutDetails')}</Button>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>{t('common.back')}</Button>
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
      <h2 id="stmt-h">{t('earnings.statement')}</h2>
      <form className="ws-search" noValidate onSubmit={apply} aria-label={t('earnings.statementPeriod')}>
        <TextField label={t('earnings.from')} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <TextField label={t('earnings.to')} type="date" value={to} error={periodError} onChange={(e) => setTo(e.target.value)} />
        <Button type="submit" variant="secondary">{t('common.show')}</Button>
      </form>
      {/* Keyed by period: a download started for one period never reports into another. */}
      <CsvDownload key={`${period.from ?? ''}:${period.to ?? ''}`} d={d} from={period.from} to={period.to} />
      {q.isPending ? <Loading label={t('earnings.loadingTheStatement')} />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : lines.length === 0 ? <Empty title={t('earnings.noEntries')}>{period.from || period.to ? t('earnings.nothingInThisPeriod') : t('earnings.nothingHasBeenEarnedOr')}</Empty>
        : (
          <>
            <div className="ws-table-wrap">
              <table className="j-table" aria-label={t('earnings.statementLines')}>
                <thead><tr><th scope={'col'}>{t('earnings.date')}</th><th scope={'col'}>{t('common.type')}</th><th scope={'col'}>{t('earnings.description')}</th><th scope={'col'}>{t('earnings.amount')}</th><th scope={'col'}>{t('earnings.balanceAfter')}</th></tr></thead>
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
            {q.hasNextPage && <div className="ws-actions"><Button variant="secondary" busy={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{t('earnings.showOlderEntries')}</Button></div>}
            {olderError && <Alert>{t('earnings.couldNotLoadOlderEntries')}{olderError}</Alert>}
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
      <Button variant="secondary" busy={busy} onClick={() => void download()}>{t('earnings.downloadCsv')}{from || to ? ` (${from ? formatDay(from) : 'start'} to ${to ? formatDay(to) : 'today'})` : ' (everything)'}
      </Button>
      {error && <Alert>{t('earnings.couldNotDownloadTheStatement')}{error}</Alert>}
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
      {q.isFetchNextPageError && <Alert>{t('earnings.couldNotLoadMore')}{messageOf(q.error)}</Alert>}
    </>
  );
}

function Payouts({ d }: { d: DoctorContext }) {
  const { q, items, total } = usePaged([...d.key, 'payouts'], (c) => d.api.payouts(c));
  return (
    <section className="ws-section" aria-labelledby="payouts-h">
      <h2 id="payouts-h">{t('earnings.payouts')}</h2>
      {q.isPending ? <Loading label={t('earnings.loadingPayouts')} />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : items.length === 0 ? <Empty title={t('earnings.noPayoutsYet')} />
        : (
          <>
          <p className="ws-count">{t('earnings.showing')}{items.length}{t('earnings.of')}{total}</p>
          <div className="ws-table-wrap">
            <table className="j-table" aria-label={t('earnings.payouts')}>
              <thead><tr><th scope={'col'}>{t('earnings.paidOn')}</th><th scope={'col'}>{t('earnings.amount')}</th><th scope={'col'}>{t('earnings.how')}</th><th scope={'col'}>{t('earnings.reference')}</th><th scope={'col'}>{t('earnings.to')}</th><th scope={'col'}>{t('earnings.state')}</th></tr></thead>
              <tbody>
                {items.map((p) => (
                  <tr key={p._id}>
                    <td>{formatDay(p.paidOn)}</td>
                    <td>{rupeesOf(p.amountMinor)}</td>
                    <td>{PAYOUT_METHOD_LABEL()[p.method] ?? p.method}</td>
                    <td>{p.reference}</td>
                    <td>{p.destination.label}</td>
                    <td>{p.state === 'voided' ? <><Badge tone="danger">{t('earnings.voided')}</Badge>{p.voidReason ? <div className="ws-muted">{p.voidReason}</div> : null}</> : <Badge tone="ok">{t('earnings.paid')}</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <MoreButton q={q} label={t('earnings.showOlderPayouts')} />
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
      <h2 id="hist-h">{t('earnings.earlierPayoutsBeforeTheCurrent')}</h2>
      <p className="ws-muted">{t('earnings.forReferenceOnlyTheseAre')}</p>
      {q.isPending ? <Loading label={t('earnings.loadingEarlierPayouts')} />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : (
          <div className="ws-table-wrap">
            <table className="j-table" aria-label={t('earnings.earlierPayouts')}>
              <thead><tr><th scope={'col'}>{t('earnings.date')}</th><th scope={'col'}>{t('earnings.period')}</th><th scope={'col'}>{t('common.kind')}</th><th scope={'col'}>{t('earnings.amount')}</th></tr></thead>
              <tbody>
                {q.data.map((h) => (
                  <tr key={h._id}>
                    <td>{formatDateTime(h.at)}</td>
                    <td>{h.periodLabel ?? '—'}</td>
                    <td>{h.legacyKind === 'disbursal' ? t('earnings.paidOut') : 'Billed'}</td>
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
      <h2 id="ev-h">{t('earnings.accountActivity')}</h2>
      {q.isPending ? <Loading label={t('earnings.loadingActivity')} />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : items.length === 0 ? <Empty title={t('earnings.noActivityYet')} />
        : (
          <>
          <ul className="ws-timeline" aria-label={t('earnings.accountActivity')}>
            {items.map((e) => (
              <li key={e._id}><time dateTime={e.at}>{formatDateTime(e.at)}</time><span>{EVENT_LABEL()[e.action] ?? e.action} · {BY_LABEL()[e.byKind] ?? e.byKind}</span></li>
            ))}
          </ul>
          <MoreButton q={q} label={t('earnings.showOlderActivity')} />
          </>
        )}
    </section>
  );
}
