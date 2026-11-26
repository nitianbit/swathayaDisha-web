import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError, doctorDashboardApi, DOCTOR_LEDGER_KIND_LABEL as LEDGER_KIND_LABEL, istToday, type EarningSum, doctorPayoutDetailsProblems as payoutDetailsProblems,
  type DoctorFinanceSummary as FinanceSummary, type Page,
  type DoctorPayoutDetailsInput as PayoutDetailsInput, type DoctorPayoutDetailsView as PayoutDetailsView, type SettlementAccountView,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, Loading, shared, TextField, formatDateTime } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession } from '../../session.tsx';
import { definitelyNotRecorded } from '../../requests.ts';
import { formatDay } from '../partner/labs.tsx';
import { OwnerFinanceTiles } from '../finance/financeTiles.tsx';
import { StatementPeriodFields, useStatementPeriod } from '../finance/finance.tsx';
import { NotADoctor, rupeesOf, useClinics, useDoctor, type DoctorContext } from './doctor.tsx';
import './doctor.css';
import { t } from '../../i18n/doctor/index.ts';
import { t as wt } from '../../i18n/withdrawals/index.ts';

const STATEMENT_PAGE = 50;
/** The statement file's name: `doctor-statement[-from][-to-…].csv`, as before. */
const CSV_PREFIX = 'doctor'; // i18n-ignore: a file-name part, not words
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
  const today = istToday();
  const period = useStatementPeriod({ from: `${today.slice(0, 8)}01`, to: today });
  return (
    <>
      <PageHeading title={t('earnings.earnings')}>{t('earnings.whatYouEarnedThroughJansetu')}</PageHeading>
      <p className="ws-muted">{t('earnings.youEarnForAConsultation')}</p>
      {finance.isPending ? <Loading label={t('earnings.loadingYourEarnings')} />
        : finance.isError ? <ErrorState message={messageOf(finance.error)} onRetry={() => void finance.refetch()} />
        : (
          <>
            <Summary f={finance.data} />
            {/* WQ48 (r35 §26.10): referral earnings and withdrawals to the bank, when the server sends them. */}
            <OwnerFinanceTiles referral={finance.data.referral} withdrawals={finance.data.withdrawals} />
            <PayoutDestination d={d} account={finance.data.account} />
          </>
        )}
      {/* WQ56b: one period for both: where the earnings came from, and the statement (and its CSV). */}
      <section className="ws-section" aria-labelledby="period-h">
        <h2 id="period-h">{t('earn.period')}</h2>
        <StatementPeriodFields p={period} csv={(q, signal) => d.api.statementCsv(q, signal)} csvPrefix={CSV_PREFIX} />
      </section>
      <Breakdown d={d} p={period} />
      <Statement d={d} p={period} />
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
      // WQ48 (r35): refused while a withdrawal to these details waits.
      if (err instanceof ApiError && err.code === 'WITHDRAWAL_OPEN') { setFailure({ tone: 'error', text: wt('error.WITHDRAWAL_OPEN') }); return; }
      setFailure({ tone: 'error', text: definitelyNotRecorded(err) ? t('common.notSaved', { value: messageOf(err) })
        : t('earnings.theyMayHaveBeenSaved', { value: messageOf(err) }) });
    } finally {
      setBusy(false);
      void queryClient.invalidateQueries({ queryKey: financeKey(d) });
      void queryClient.invalidateQueries({ queryKey: [...d.key, 'finance-events'] });
    }
  }

  const masked = f.method === 'bank' ? t('earnings.maskedBank', { last4: (f.accountNumber ?? '').replace(/\s+/g, '').slice(-4), ifsc: (f.ifsc ?? '').trim().toUpperCase() })
    : t('earnings.maskedUpi', { upi: (f.upiId ?? '').trim().toLowerCase() });
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
          <Button variant="ghost" onClick={onClose}>{shared('action.cancel')}</Button>
        </div>
      ) : (
        <div className="confirm" role="group" aria-label={t('earnings.savePayoutDetails')}>
          <div className="confirm-text">{t('earnings.sendFuturePayoutsToFull', { masked })}</div>
          <div className="confirm-actions">
            <Button busy={busy} onClick={() => void save()}>{t('earnings.savePayoutDetails')}</Button>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>{shared('action.back')}</Button>
          </div>
        </div>
      )}
    </form>
  );
}

// ── Statement ──

/** WQ52: the finance statements' period (India dates, a short pause while a date is typed); WQ56b: shared with the breakdown. */
type Period = ReturnType<typeof useStatementPeriod>;

function Statement({ d, p }: { d: DoctorContext; p: Period }) {
  const { period, filtered } = p;
  const q = useInfiniteQuery({
    queryKey: [...d.key, 'statement', period],
    queryFn: ({ pageParam }) => d.api.statement({ ...period, before: pageParam, limit: STATEMENT_PAGE }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: period !== null,
  });

  const lines = q.data?.pages.flatMap((p) => p.lines) ?? [];
  const olderError = q.isFetchNextPageError ? messageOf(q.error) : null;
  return (
    <section className="ws-section" aria-labelledby="stmt-h">
      <h2 id="stmt-h">{t('earnings.statement')}</h2>
      {!period ? null
        : q.isPending ? <Loading label={t('earnings.loadingTheStatement')} />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : lines.length === 0 ? <Empty title={t('earnings.noEntries')}>{filtered ? t('earnings.nothingInThisPeriod') : t('earnings.nothingHasBeenEarnedOr')}</Empty>
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
                      <td>{l.description}{l.reference ? ` · ${t('earnings.ref', { reference: l.reference })}` : ''}{l.note ? <div className="ws-muted">{l.note}</div> : null}</td>
                      <td>{rupeesOf(l.amountMinor)}</td>
                      <td>{rupeesOf(l.balanceAfterMinor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {q.hasNextPage && <div className="ws-actions"><Button variant="secondary" busy={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{t('earnings.showOlderEntries')}</Button></div>}
            {olderError && <Alert>{t('earnings.couldNotLoadOlderEntriesFull', { olderError })}</Alert>}
          </>
        )}
    </section>
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
      {q.isFetchNextPageError && <Alert>{t('earnings.couldNotLoadMoreFull', { messageOf: messageOf(q.error) })}</Alert>}
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
          <p className="ws-count">{t('earnings.showingFull', { length: items.length, total })}</p>
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
                    <td>{h.legacyKind === 'disbursal' ? t('earnings.paidOut') : t('earnings.billed')}</td>
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

/**
 * WQ56 (r39 `breakdown`): one combined view of what he earned, by where it came from: online, each clinic, bookings
 * made by pharmacies and labs, referral cuts. Chips show one part. The statement, download and breakdown use the same
 * dates; r39b answers the breakdown only when asked (`breakdown=1`).
 */
function Breakdown({ d, p }: { d: DoctorContext; p: Period }) {
  const { api } = useSession();
  const clinics = useClinics(d);
  const period = p.period;
  const q = useQuery({ queryKey: [...d.key, 'breakdown', period], queryFn: () => doctorDashboardApi(api).finance(period!), enabled: !!period });
  const [chip, setChip] = useState('all');
  const b = q.data?.breakdown;
  const names = new Map((clinics.data?.clinics ?? []).map((c) => [c.partnerId.toLowerCase(), c.name]));
  const parts: { id: string; label: string; sum: EarningSum }[] = b ? [
    { id: 'online', label: t('earn.online'), sum: b.online },
    // r39b: in-person visits with no clinic (older ones) are a part of their own.
    ...b.clinics.map((c) => ({ id: `clinic:${c.clinicId ?? 'none'}`, sum: c,
      label: c.clinicId === null ? t('earn.noClinic') : c.name ?? names.get(c.clinicId.toLowerCase()) ?? t('dash.clinicUnnamed') })),
    { id: 'partner', label: t('earn.partner'), sum: b.partner },
    { id: 'referral', label: t('earn.referral'), sum: b.referral },
    ...(b.other.count || b.other.netMinor ? [{ id: 'other', label: t('earn.other'), sum: b.other }] : []),
  ] : [];
  const shown = chip === 'all' ? parts : parts.filter((x) => x.id === chip);
  return (
    <section className="ws-section" aria-labelledby="earn-h">
      <h2 id="earn-h">{t('earn.title')}</h2>
      <p className="ws-muted">{t('earn.intro')}</p>
      {!period ? null : q.isPending ? <Loading label={t('earn.loading')} />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : !b ? <p className="ws-muted">{t('earn.notYet')}</p>
        : (
          <>
            <div className="chips" role="group" aria-label={t('earn.show')}>
              {[{ id: 'all', label: t('dash.chip.all') }, ...parts].map((x) => (
                <button key={x.id} type="button" className="chip" aria-pressed={chip === x.id} onClick={() => setChip(x.id)}>{x.label}</button>
              ))}
            </div>
            {chip === 'all' && <p className="earned-line">{t('earn.total', { amount: rupeesOf(b.totals.netMinor) })}</p>}
            <div className="earn-sums">
              {shown.map((x) => (
                <div key={x.id} className="earn-sum">
                  <span>{x.label}</span>
                  <strong>{rupeesOf(x.sum.netMinor)}</strong>
                  <span className="ws-muted">{t('earn.line', { count: x.sum.count, reversed: rupeesOf(x.sum.reversedMinor) })}</span>
                </div>
              ))}
            </div>
          </>
        )}
    </section>
  );
}
