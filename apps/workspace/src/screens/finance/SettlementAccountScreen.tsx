import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import {
  istToday, MAX_FINANCE_MINOR, MAX_FINANCE_REASON, MAX_PAYOUT_NOTE, MAX_PAYOUT_REFERENCE,
  OBJECT_ID_PATTERN, OWNER_KIND_LABEL, PAYOUT_METHOD_LABEL, PAYOUT_METHODS, payoutProblems, reasonProblem, rupeesToPaise, settlementsApi,
  type AdjustmentInput, type FinanceSummary, type PayoutMethod, type RecordPayoutInput, type SettlementAccount, type SettlementPayout,
} from '@jansetu/api';
import { Alert, Button, ErrorState, formatDateTime, Loading, Parts, shared, TextArea, TextField } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { PendingOpPanel } from '../../components/PendingOpPanel.tsx';
import { messageOf } from '../../errors.ts';
import { t } from '../../i18n/finance/index.ts';
import { PageHeading } from '../../PageHeading.tsx';
import {
  afterFailure, beginAttempt, keyedLookup, newRequestKey, resolveStored, startOp, stillCurrent, wasAbandoned, type PendingOp,
} from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { NoSuchPartner } from '../partner/scope.tsx';
import { money } from '../partner/billing.tsx';
import {
  detailsLabel, EventsList, formatDate, ListSection, PagedSection, PayoutDetailsForm, PayoutDetailsList, PayoutsTable, Signed, StatementSection,
  SummaryCards, useOneAtATime, type Perform,
} from './finance.tsx';

/** Q13 cursor pages of the account's payouts and events. */
const PAGE = 50;

type Api = ReturnType<typeof settlementsApi>;
type Funded = FinanceSummary & { account: SettlementAccount };

/** Admin: one settlement account (`/admin/settlements/:accountId`). */
export function SettlementAccountScreen() {
  const { accountId = '' } = useParams();
  if (!OBJECT_ID_PATTERN.test(accountId)) return <NoSuchPartner />;
  // One subtree per account: an open form, a confirmation or a running action never moves to another account.
  return <AccountPage key={accountId.toLowerCase()} accountId={accountId.toLowerCase()} />;
}

function AccountPage({ accountId }: { accountId: string }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const s = useMemo(() => settlementsApi(api), [api]);
  const key = ['settlements', 'account', accountId];
  const summary = useQuery({ queryKey: [...key, 'summary'], queryFn: () => s.account(accountId) });
  const history = useQuery({ queryKey: [...key, 'history'], queryFn: () => s.history(accountId) });
  const { perform, busy } = useOneAtATime();
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  /** Everything about this account is read again (after every action, whatever its outcome). */
  const reload = () => {
    void queryClient.invalidateQueries({ queryKey: key });
    void queryClient.invalidateQueries({ queryKey: ['settlements', 'accounts'] });
    void queryClient.invalidateQueries({ queryKey: ['settlements', 'payouts'] });
  };

  const data = summary.data;
  const a = data?.account;
  return (
    <>
      <Link className="ws-back" to="/admin/settlements"><ArrowLeft size={16} aria-hidden="true" /> {t('account.back')}</Link>
      <PageHeading title={a?.beneficiaryName ?? t('account.title')}>
        {a ? <>{OWNER_KIND_LABEL[a.ownerKind] ?? a.ownerKind}{a.isActive ? '' : ` · ${t('account.inactive')}`}{a.ownerKind === 'partner' && (
          <> · <Link to={`/admin/partners/${a.ownerId}`}>{t('account.partnerPage')}</Link> · <Link to={`/admin/partners/${a.ownerId}/finance`}>{t('account.asOwner')}</Link></>
        )}</> : null}
      </PageHeading>
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {summary.isPending ? <Loading label={t('account.loading')} />
        : summary.isError || !data || !a ? <ErrorState message={messageOf(summary.error)} onRetry={() => void summary.refetch()} />
        : (
          <>
            <section className="ws-section" aria-labelledby="sa-bal-h">
              <h2 id="sa-bal-h">{t('balance.title')}</h2>
              <SummaryCards summary={data} />
            </section>

            <section className="ws-section" aria-labelledby="sa-dest-h">
              <h2 id="sa-dest-h">{t('details.title')}</h2>
              {a.payoutDetails ? <PayoutDetailsList account={a} /> : <p className="ws-muted">{t('details.noneYet')}</p>}
              {editing ? (
                // i18n-ignore: `audience` is a code (who edits), not words
                <PayoutDetailsForm account={a} audience="admin" perform={perform}
                  reread={async () => (await s.account(accountId)).account}
                  save={(body, version) => s.setPayoutDetails(accountId, body, version)}
                  onSaved={(x) => { setEditing(false); setNotice({ tone: 'ok', text: t('account.saved', { version: x.payoutDetailsVersion }) }); reload(); }}
                  onLost={(text) => { setEditing(false); setNotice({ tone: 'warn', text }); reload(); }}
                  onStale={reload}
                  onCancel={() => setEditing(false)} />
              ) : (
                <div className="ws-actions">
                  {a.payoutDetailsState === 'unverified' && a.payoutDetails && (
                    <ConfirmAction label={t('account.verify')} confirmLabel={t('account.verifyConfirm')} disabled={busy}
                      consequence={t('account.verifyConsequence', { version: a.payoutDetailsVersion, destination: detailsLabel(a.payoutDetails) })}
                      onConfirm={() => perform(async () => {
                        try {
                          await s.verifyPayoutDetails(accountId, a.payoutDetailsVersion);
                          setNotice({ tone: 'ok', text: t('account.verified', { version: a.payoutDetailsVersion }) });
                        } finally {
                          reload();
                        }
                      })} />
                  )}
                  <Button variant="secondary" disabled={busy} onClick={() => { setNotice(null); setEditing(true); }}>
                    {a.payoutDetails ? t('details.change') : t('details.add')}
                  </Button>
                </div>
              )}
            </section>

            <RecordPayout api={s} accountId={accountId} summary={{ ...data, account: a }} perform={perform} onChanged={reload} />
            <PostAdjustment api={s} accountId={accountId} summary={{ ...data, account: a }} perform={perform} onChanged={reload} />

            <StatementSection queryKey={key} load={(q) => s.statement(accountId, q)} csv={(q, signal) => s.statementCsv(accountId, q, signal)}
              csvPrefix={`account-${accountId}`} />
          </>
        )}
      <PagedSection id="sa-po-h" title={t('payouts.title')} loading={t('payouts.loading')} emptyTitle={t('payouts.empty')}
        queryKey={[...key, 'payouts']} load={(cursor) => s.payouts(accountId, { cursor, limit: PAGE })}
        empty={t('payouts.emptyText.account')} more={t('payouts.older')}>
        {(rows) => (
          <>
            <PayoutsTable payouts={rows} caption={t('payouts.caption.account')} />
            <p className="ws-muted">
              <Parts of={t.rich('account.voidFrom', { link: <Link to={`/admin/payouts?account=${accountId}`}>{t('payouts.title')}</Link> })} />
            </p>
          </>
        )}
      </PagedSection>
      <ListSection id="sa-hist-h" title={t('history.title')} loading={t('history.loading')} emptyTitle={t('history.empty')} q={history} empty={t('history.emptyText')}>
        {(rows) => (
          <>
            <p className="ws-muted">{t('history.intro')}</p>
            <div className="ws-table-wrap">
              <table className="j-table">
                <caption className="j-sr-only">{t('history.title')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{shared('field.date')}</th><th scope="col">{t('history.column.kind')}</th><th scope="col">{t('history.column.period')}</th>
                    <th scope="col" className="fin-amount">{shared('field.amount')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((h) => (
                    <tr key={h._id}>
                      <td>{formatDateTime(h.at)}</td><td>{h.legacyKind === 'disbursal' ? t('history.kind.paidOut') : t('history.kind.billed')}</td><td>{h.periodLabel ?? '—'}</td>
                      <td className="fin-amount">{money(h.amountMinor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </ListSection>
      <PagedSection id="sa-ev-h" title={t('events.title')} loading={t('events.loading')} emptyTitle={t('events.empty')}
        queryKey={[...key, 'events']} load={(cursor) => s.events(accountId, { cursor, limit: PAGE })}
        empty={t('events.emptyText')} more={t('events.older')}>
        {(rows) => <EventsList events={rows} />}
      </PagedSection>
    </>
  );
}

/**
 * The finance version a review was made on closes the review when the account moves (another payout, adjustment, void,
 * destination change or verification): the admin then looks at the account as it is now before deciding again.
 */
const moved = () => t('account.moved');

/** Whether the component is still on the page (a late answer then only updates session memory). */
function useMounted() {
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return mounted;
}

// ── Record a payout ──

type PendingPayout = PendingOp<RecordPayoutInput>;

/**
 * Records a transfer the admin already made, exactly once (`requestKey` per admin; the server replays the same key and
 * content). The body names the verified details version the admin saw (`detailsVersion`: 409 PAYOUT_DETAILS_CHANGED) and
 * the account's finance version (Q13 `expectedFinanceVersion`: 409 FINANCE_CHANGED). A lost answer locks the payout:
 * resend it unchanged, look it up by its key (Q13 `GET .../payouts/by-key/:key`), or give it up on the server (`abandon`:
 * then it can never be recorded). The same works after a reload, from the body-less marker's key.
 */
function RecordPayout({ api: s, accountId, summary, perform, onChanged }: { api: Api; accountId: string; summary: Funded; perform: Perform; onChanged: () => void }) {
  const { memory } = useSession();
  const slot = `settlement-payout:${accountId}`;
  const [pending, setPendingState] = useState<PendingPayout | undefined>(() => memory.get<PendingPayout>(slot));
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);
  const mounted = useMounted();
  const setPending = (p: PendingPayout | undefined) => {
    if (p) memory.set(slot, p); else memory.delete(slot);
    setPendingState(p);
  };

  /**
   * Whether an answer or a check made for `op` may still act: this page is on screen AND the stored payout is still
   * exactly `op` (same key, same attempt). Otherwise another attempt (here, or on a page opened since) owns it, and it
   * stays as it is, reload marker included, for that page to settle (a resend replays the same payout).
   */
  const owns = (op: PendingPayout) => mounted.current && stillCurrent(memory.get<PendingPayout>(slot), op);

  /** `op` produced this payout (answer, replay or found): end it, and only it, if this page still owns it. */
  const recorded = (p: SettlementPayout, op: PendingPayout, earlier: boolean) => {
    onChanged();
    if (!owns(op)) return;
    resolveStored(memory, slot, op.requestKey);
    const requestKey = op.requestKey;
    setPendingState((cur) => (cur && cur.requestKey !== requestKey ? cur : undefined));
    const words = { amount: money(p.amountMinor), reference: p.reference, date: formatDate(p.paidOn) };
    setDone(earlier ? t('payout.doneEarlier', words) : t('payout.done', words));
    setFormKey((k) => k + 1);
  };

  /** Given up on the server (abandon, or a resend refused REQUEST_ABANDONED): ends `op` only while this page owns it. */
  const givenUp = (op: PendingPayout, text: string) => {
    onChanged();
    if (!owns(op)) return;
    const k = op.requestKey;
    resolveStored(memory, slot, k);
    setPendingState((cur) => (cur && cur.requestKey !== k ? cur : undefined));
    setDone(text);
  };

  /** Sends exactly `p` (same key, same content). Only success, or a definite refusal of its FIRST attempt, ends it. */
  async function send(p: PendingPayout) {
    try {
      await perform(async () => {
        const attempt = beginAttempt(p);
        setBusy(true);
        setRefused(null);
        setDone(null);
        setPending(attempt);
        try {
          const r = await s.recordPayout(accountId, attempt.body);
          recorded(r.payout, attempt, r.replayed);
        } catch (err) {
          onChanged();
          if (!owns(attempt)) return;
          if (wasAbandoned(err)) {
            givenUp(attempt, t('payout.abandoned'));
            return;
          }
          const next = afterFailure(attempt, err, messageOf(err));
          setPending(next ?? undefined);
          // A refusal (stale details, balance, reference): the account is read again and shown as it is now.
          if (!next) setRefused(messageOf(err));
        } finally {
          if (mounted.current) setBusy(false);
        }
      });
    } catch (err) {
      // The one-at-a-time guard refused it before anything was sent or stored.
      if (mounted.current) setRefused(messageOf(err));
    }
  }

  const a = summary.account;
  const blocked = !a.isActive ? t('payout.blocked.inactive')
    : a.payoutDetailsState === 'none' || !a.payoutDetails ? t('payout.blocked.noDetails')
    : a.payoutDetailsState !== 'verified' ? t('payout.blocked.unverified')
    : summary.balanceMinor <= 0 ? t('payout.blocked.nothingDue')
    : null;
  const showPanel = pending && !(busy && pending.attempts === 1 && !pending.uncertain);
  return (
    <section className="ws-section" aria-labelledby="sa-pay-h">
      <h2 id="sa-pay-h">{t('payout.title')}</h2>
      <p className="ws-muted">{t('payout.intro')}</p>
      {done && <Alert tone="ok">{done}</Alert>}
      {refused && <Alert>{t('payout.notRecorded', { error: refused })}</Alert>}
      {showPanel ? (
        <PendingOpPanel key={pending.attempts} label={t('payout.unconfirmed')} op={pending} busy={busy} onResend={() => void send(pending)}
          fetchPage={keyedLookup(pending.requestKey, () => s.payoutByKey(accountId, pending.requestKey), ['PAYOUT_NOT_FOUND'])}
          onFound={(p) => recorded(p, pending, true)}
          // Q13: decided by the server: `abandoned` = this payout can never be recorded; `used` = here it is.
          abandon={async () => {
            const r = await s.abandonPayoutKey(accountId, pending.requestKey);
            return { state: r.state, record: r.payout ? { ...r.payout, requestKey: pending.requestKey } : undefined };
          }}
          abandonWhenNotFound abandonLabel={t('payout.giveUp')}
          onDiscard={() => givenUp(pending, t('payout.discarded'))}
          summary={pending.restored ? null : <PayoutSummary body={pending.body} />} />
      ) : blocked ? <p className="ws-muted">{blocked}</p>
        : (
          <PayoutForm key={formKey} summary={summary} busy={busy} refused={refused}
            onRecord={(body) => {
              const requestKey = newRequestKey();
              void send(startOp(requestKey, { ...body, requestKey }));
            }} />
        )}
    </section>
  );
}

function PayoutSummary({ body }: { body: RecordPayoutInput }) {
  return (
    <div>
      {t('payout.summary', {
        amount: money(body.amountMinor), method: PAYOUT_METHOD_LABEL[body.method], reference: body.reference, date: formatDate(body.paidOn),
        version: body.detailsVersion,
      })}
    </div>
  );
}

function PayoutForm({ summary, busy, refused, onRecord }: {
  summary: Funded; busy: boolean; refused: string | null; onRecord: (body: Omit<RecordPayoutInput, 'requestKey'>) => void;
}) {
  const a = summary.account;
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PayoutMethod>(a.payoutDetails?.method === 'upi' ? 'upi' : 'bank_transfer');
  const [reference, setReference] = useState('');
  const [paidOn, setPaidOn] = useState(() => istToday());
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  const [review, setReview] = useState<Omit<RecordPayoutInput, 'requestKey'> | null>(null);
  const [changed, setChanged] = useState<string | null>(null);
  const amountMinor = rupeesToPaise(amount);
  const all = payoutProblems({ amountMinor, reference, paidOn, note }, summary.balanceMinor, istToday());
  const errors = tried ? all : {};
  const edit = (fn: () => void) => { fn(); setReview(null); setChanged(null); };

  // A refusal sends the person back to the form as typed; a change of details, balance or (Q13) finance version closes a
  // review made before it.
  useEffect(() => { if (refused) setReview(null); }, [refused]);
  useEffect(() => {
    if (review && (review.detailsVersion !== a.payoutDetailsVersion || review.amountMinor > summary.balanceMinor)) {
      setReview(null);
      setChanged(t('payout.changed'));
    } else if (review && review.expectedFinanceVersion !== a.financeVersion) {
      setReview(null);
      setChanged(moved());
    }
  }, [review, a.payoutDetailsVersion, a.financeVersion, summary.balanceMinor]);

  function submit(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    setChanged(null);
    if (Object.keys(all).length || amountMinor === null) return;
    setReview({ amountMinor, method, reference: reference.trim(), paidOn, ...(note.trim() ? { note: note.trim() } : {}), detailsVersion: a.payoutDetailsVersion,
      expectedFinanceVersion: a.financeVersion });
  }

  return (
    <form className="rx-form" noValidate onSubmit={submit} aria-label={t('payout.title')}>
      <div className="rx-form-row">
        <TextField label={t('payout.amount')} inputMode="decimal" value={amount} error={errors.amount}
          hint={t('payout.amountHint', { amount: money(summary.balanceMinor) })} onChange={(e) => edit(() => setAmount(e.target.value))} />
        <div className="j-field">
          <label htmlFor="sa-method">{t('payout.method')}</label>
          <select id="sa-method" value={method} onChange={(e) => edit(() => setMethod(e.target.value as PayoutMethod))}>
            {PAYOUT_METHODS.map((m) => <option key={m} value={m}>{PAYOUT_METHOD_LABEL[m]}</option>)}
          </select>
        </div>
        <TextField label={t('payout.reference')} value={reference} maxLength={MAX_PAYOUT_REFERENCE} error={errors.reference}
          onChange={(e) => edit(() => setReference(e.target.value))} />
        <TextField label={t('payout.paidOn')} type="date" value={paidOn} max={istToday()} error={errors.paidOn} onChange={(e) => edit(() => setPaidOn(e.target.value))} />
      </div>
      <TextArea label={t('payout.note')} value={note} maxLength={MAX_PAYOUT_NOTE} error={errors.note} onChange={(e) => edit(() => setNote(e.target.value))} />
      {changed && <Alert tone="warn">{changed}</Alert>}
      {!review ? (
        <div className="rx-actions"><Button type="submit">{t('payout.review')}</Button></div>
      ) : (
        <div className="confirm" role="group" aria-label={t('payout.confirmLabel')}>
          <div className="confirm-text">
            {t('payout.confirm', {
              amount: money(review.amountMinor), name: a.beneficiaryName, destination: detailsLabel(a.payoutDetails), version: review.detailsVersion,
              method: PAYOUT_METHOD_LABEL[review.method], date: formatDate(review.paidOn), reference: review.reference,
              from: money(summary.balanceMinor), to: money(summary.balanceMinor - review.amountMinor),
            })}
          </div>
          <div className="confirm-actions">
            <Button busy={busy} onClick={() => onRecord(review)}>{t('payout.record')}</Button>
            <Button variant="ghost" disabled={busy} onClick={() => setReview(null)}>{t('payout.backToForm')}</Button>
          </div>
        </div>
      )}
    </form>
  );
}

// ── Post an adjustment ──

type PendingAdjustment = PendingOp<AdjustmentInput>;

/**
 * A signed correction with a reason, exactly once per (admin, requestKey), fenced on the finance version it was reviewed
 * on (Q13). A lost answer is resent unchanged, looked up by its key (`GET .../adjustments/by-key/:key`) or given up on the
 * server, also after a reload.
 */
function PostAdjustment({ api: s, accountId, summary, perform, onChanged }: { api: Api; accountId: string; summary: Funded; perform: Perform; onChanged: () => void }) {
  const { memory } = useSession();
  const slot = `settlement-adjustment:${accountId}`;
  const [pending, setPendingState] = useState<PendingAdjustment | undefined>(() => memory.get<PendingAdjustment>(slot));
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);
  const mounted = useMounted();
  const setPending = (p: PendingAdjustment | undefined) => {
    if (p) memory.set(slot, p); else memory.delete(slot);
    setPendingState(p);
  };

  /** As for payouts: only a live page whose stored adjustment is still exactly `op` may settle or replace it. */
  const owns = (op: PendingAdjustment) => mounted.current && stillCurrent(memory.get<PendingAdjustment>(slot), op);

  const posted = (amountMinor: number, op: PendingAdjustment, earlier: boolean) => {
    onChanged();
    if (!owns(op)) return;
    resolveStored(memory, slot, op.requestKey);
    const requestKey = op.requestKey;
    setPendingState((cur) => (cur && cur.requestKey !== requestKey ? cur : undefined));
    const taken = amountMinor < 0;
    const amount = money(Math.abs(amountMinor));
    setDone(earlier ? t(taken ? 'adjust.doneEarlierTaken' : 'adjust.doneEarlierAdded', { amount }) : t(taken ? 'adjust.doneTaken' : 'adjust.doneAdded', { amount }));
    setFormKey((k) => k + 1);
  };

  const givenUp = (op: PendingAdjustment, text: string) => {
    onChanged();
    if (!owns(op)) return;
    const k = op.requestKey;
    resolveStored(memory, slot, k);
    setPendingState((cur) => (cur && cur.requestKey !== k ? cur : undefined));
    setDone(text);
  };

  async function send(p: PendingAdjustment) {
    try {
      await perform(async () => {
        const attempt = beginAttempt(p);
        setBusy(true);
        setRefused(null);
        setDone(null);
        setPending(attempt);
        try {
          const r = await s.postAdjustment(accountId, attempt.body);
          posted(r.entry.amountMinor, attempt, r.replayed);
        } catch (err) {
          onChanged();
          if (!owns(attempt)) return;
          if (wasAbandoned(err)) {
            givenUp(attempt, t('adjust.abandoned'));
            return;
          }
          const next = afterFailure(attempt, err, messageOf(err));
          setPending(next ?? undefined);
          if (!next) setRefused(messageOf(err));
        } finally {
          if (mounted.current) setBusy(false);
        }
      });
    } catch (err) {
      if (mounted.current) setRefused(messageOf(err));
    }
  }

  const a = summary.account;
  const showPanel = pending && !(busy && pending.attempts === 1 && !pending.uncertain);
  return (
    <section className="ws-section" aria-labelledby="sa-adj-h">
      <h2 id="sa-adj-h">{t('adjust.title')}</h2>
      <p className="ws-muted">{t('adjust.intro')}</p>
      {done && <Alert tone="ok">{done}</Alert>}
      {refused && <Alert>{t('adjust.notPosted', { error: refused })}</Alert>}
      {showPanel ? (
        <PendingOpPanel key={pending.attempts} label={t('adjust.unconfirmed')} op={pending} busy={busy} onResend={() => void send(pending)}
          fetchPage={keyedLookup(pending.requestKey, () => s.adjustmentByKey(accountId, pending.requestKey), ['ADJUSTMENT_NOT_FOUND'])}
          onFound={(l) => posted(l.amountMinor, pending, true)}
          abandon={async () => {
            const r = await s.abandonAdjustmentKey(accountId, pending.requestKey);
            return { state: r.state, record: r.entry ? { ...r.entry, requestKey: pending.requestKey } : undefined };
          }}
          abandonWhenNotFound abandonLabel={t('adjust.giveUp')}
          onDiscard={() => givenUp(pending, t('adjust.discarded'))}
          summary={pending.restored ? null : (
            <div>
              {t(pending.body.amountMinor < 0 ? 'adjust.summaryTake' : 'adjust.summaryAdd', { amount: money(Math.abs(pending.body.amountMinor)), reason: pending.body.reason })}
            </div>
          )} />
      ) : !a.isActive ? <p className="ws-muted">{t('adjust.inactive')}</p>
        : (
          <AdjustmentForm key={formKey} summary={summary} busy={busy} refused={refused}
            onPost={(body) => {
              const requestKey = newRequestKey();
              void send(startOp(requestKey, { ...body, requestKey }));
            }} />
        )}
    </section>
  );
}

function AdjustmentForm({ summary, busy, refused, onPost }: {
  summary: Funded; busy: boolean; refused: string | null; onPost: (body: Omit<AdjustmentInput, 'requestKey'>) => void;
}) {
  const [direction, setDirection] = useState<'credit' | 'debit'>('credit');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [review, setReview] = useState<Omit<AdjustmentInput, 'requestKey'> | null>(null);
  const [changed, setChanged] = useState<string | null>(null);
  const paise = rupeesToPaise(amount);
  const amountError = paise === null ? t('adjust.amountFormat') : paise < 1 ? t('adjust.amountZero') : paise > MAX_FINANCE_MINOR ? t('adjust.amountMax') : null;
  const reasonError = reasonProblem(reason);
  const edit = (fn: () => void) => { fn(); setReview(null); setChanged(null); };
  useEffect(() => { if (refused) setReview(null); }, [refused]);
  // Q13: the review names the finance version it was made on; any move of the account closes it.
  const financeVersion = summary.account.financeVersion;
  useEffect(() => {
    if (review && review.expectedFinanceVersion !== financeVersion) { setReview(null); setChanged(moved()); }
  }, [review, financeVersion]);

  function submit(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    setChanged(null);
    if (amountError || reasonError || paise === null) return;
    setReview({ amountMinor: direction === 'debit' ? -paise : paise, reason: reason.trim(), expectedFinanceVersion: financeVersion });
  }

  const after = review ? summary.balanceMinor + review.amountMinor : 0;
  return (
    <form className="rx-form" noValidate onSubmit={submit} aria-label={t('adjust.title')}>
      <fieldset className="fin-radio">
        <legend>{t('adjust.direction')}</legend>
        <label><input type="radio" name="sa-dir" checked={direction === 'credit'} onChange={() => edit(() => setDirection('credit'))} /> {t('adjust.add')}</label>
        <label><input type="radio" name="sa-dir" checked={direction === 'debit'} onChange={() => edit(() => setDirection('debit'))} /> {t('adjust.take')}</label>
      </fieldset>
      <div className="rx-form-row">
        <TextField label={t('adjust.amount')} inputMode="decimal" value={amount} error={tried ? amountError : null} onChange={(e) => edit(() => setAmount(e.target.value))} />
      </div>
      <TextArea label={t('adjust.reason')} value={reason} maxLength={MAX_FINANCE_REASON} error={tried ? reasonError : null} onChange={(e) => edit(() => setReason(e.target.value))} />
      {changed && <Alert tone="warn">{changed}</Alert>}
      {!review ? (
        <div className="rx-actions"><Button type="submit">{t('adjust.review')}</Button></div>
      ) : (
        <div className="confirm" role="group" aria-label={t('adjust.confirmLabel')}>
          <div className="confirm-text">
            <Parts of={t.rich(review.amountMinor < 0 ? 'adjust.confirmTake' : 'adjust.confirmAdd', {
              amount: money(Math.abs(review.amountMinor)), name: summary.account.beneficiaryName, from: money(summary.balanceMinor),
              to: <Signed minor={after} />, reason: review.reason,
            })} />
            {after < 0 ? ` ${t('adjust.belowZero', { name: summary.account.beneficiaryName, amount: money(-after) })}` : ''}
            {' '}{t('adjust.forGood')}
          </div>
          <div className="confirm-actions">
            <Button busy={busy} onClick={() => onPost(review)}>{t('adjust.post')}</Button>
            <Button variant="ghost" disabled={busy} onClick={() => setReview(null)}>{t('adjust.backToForm')}</Button>
          </div>
        </div>
      )}
    </form>
  );
}

