import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import {
  isAdjustmentFor, isPayoutFor, istToday, MAX_FINANCE_MINOR, MAX_FINANCE_REASON, MAX_PAYOUT_NOTE, MAX_PAYOUT_REFERENCE,
  OBJECT_ID_PATTERN, OWNER_KIND_LABEL, PAYOUT_METHOD_LABEL, PAYOUT_METHODS, payoutProblems, reasonProblem, rupeesToPaise, settlementsApi,
  type AdjustmentInput, type FinanceSummary, type Page, type PayoutMethod, type RecordPayoutInput, type SettlementAccount,
  type SettlementPayout, type StatementLine,
} from '@jansetu/api';
import { Alert, Button, ErrorState, formatDateTime, Loading, TextArea, TextField } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { PendingOpPanel } from '../../components/PendingOpPanel.tsx';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { afterFailure, beginAttempt, newRequestKey, resolveStored, startOp, stillCurrent, type PendingOp } from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { NoSuchPartner } from '../partner/scope.tsx';
import { money } from '../partner/billing.tsx';
import {
  detailsLabel, EventsList, formatDate, ListSection, PayoutDetailsForm, PayoutDetailsList, PayoutsTable, Signed, StatementSection,
  SummaryCards, useOneAtATime, type Perform,
} from './finance.tsx';

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
  const payouts = useQuery({ queryKey: [...key, 'payouts'], queryFn: () => s.payouts(accountId) });
  const history = useQuery({ queryKey: [...key, 'history'], queryFn: () => s.history(accountId) });
  const events = useQuery({ queryKey: [...key, 'events'], queryFn: () => s.events(accountId) });
  const { perform, busy } = useOneAtATime('account');
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
      <Link className="ws-back" to="/admin/settlements"><ArrowLeft size={16} aria-hidden="true" /> Back to settlements</Link>
      <PageHeading title={a?.beneficiaryName ?? 'Settlement account'}>
        {a ? <>{OWNER_KIND_LABEL[a.ownerKind] ?? a.ownerKind}{a.isActive ? '' : ' · inactive'}{a.ownerKind === 'partner' && (
          <> · <Link to={`/admin/partners/${a.ownerId}`}>Partner page</Link> · <Link to={`/admin/partners/${a.ownerId}/finance`}>Its finance as owner</Link></>
        )}</> : null}
      </PageHeading>
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {summary.isPending ? <Loading label="Loading the account…" />
        : summary.isError || !data || !a ? <ErrorState message={messageOf(summary.error)} onRetry={() => void summary.refetch()} />
        : (
          <>
            <section className="ws-section" aria-labelledby="sa-bal-h">
              <h2 id="sa-bal-h">Balance</h2>
              <SummaryCards summary={data} />
            </section>

            <section className="ws-section" aria-labelledby="sa-dest-h">
              <h2 id="sa-dest-h">Payout details</h2>
              {a.payoutDetails ? <PayoutDetailsList account={a} /> : <p className="ws-muted">No payout details yet.</p>}
              {editing ? (
                <PayoutDetailsForm account={a} audience="admin" perform={perform}
                  reread={async () => (await s.account(accountId)).account}
                  save={(body) => s.setPayoutDetails(accountId, body)}
                  onSaved={(x) => { setEditing(false); setNotice({ tone: 'ok', text: `Payout details saved as version ${x.payoutDetailsVersion}. Verify them before recording a payout.` }); reload(); }}
                  onLost={(text) => { setEditing(false); setNotice({ tone: 'warn', text }); reload(); }}
                  onStale={reload}
                  onCancel={() => setEditing(false)} />
              ) : (
                <div className="ws-actions">
                  {a.payoutDetailsState === 'unverified' && a.payoutDetails && (
                    <ConfirmAction label="Mark as verified" confirmLabel="Yes, these details are verified" disabled={busy}
                      consequence={<>
                        Confirm that you checked these exact details (version {a.payoutDetailsVersion}: {detailsLabel(a.payoutDetails)}) outside Jansetu,
                        by a penny drop or the account holder’s documents. Payouts can then be recorded to them.
                      </>}
                      onConfirm={() => perform(async () => {
                        try {
                          await s.verifyPayoutDetails(accountId, a.payoutDetailsVersion);
                          setNotice({ tone: 'ok', text: `Payout details version ${a.payoutDetailsVersion} verified.` });
                        } finally {
                          reload();
                        }
                      })} />
                  )}
                  <Button variant="secondary" disabled={busy} onClick={() => { setNotice(null); setEditing(true); }}>
                    {a.payoutDetails ? 'Change payout details' : 'Add payout details'}
                  </Button>
                </div>
              )}
            </section>

            <RecordPayout api={s} accountId={accountId} summary={{ ...data, account: a }} perform={perform} onChanged={reload} />
            <PostAdjustment api={s} accountId={accountId} summary={{ ...data, account: a }} perform={perform} onChanged={reload} />

            <StatementSection queryKey={key} load={(q) => s.statement(accountId, q)} csv={(q, signal) => s.statementCsv(accountId, q, signal)}
              csvPrefix={`account-${accountId}`} emptyText="Earnings, payouts and adjustments appear here." />
          </>
        )}
      <ListSection id="sa-po-h" title="Payouts" q={payouts} empty="Payouts recorded for this account appear here.">
        {(rows) => (
          <>
            <PayoutsTable payouts={rows} caption="Payouts of this account, newest first" />
            <p className="ws-muted">A payout recorded by mistake is voided from <Link to={`/admin/payouts?account=${accountId}`}>Payouts</Link>.</p>
          </>
        )}
      </ListSection>
      <ListSection id="sa-hist-h" title="Earlier history" q={history} empty="No history from before the ledger.">
        {(rows) => (
          <>
            <p className="ws-muted">Imported from the earlier payout system for reference only: not part of the balance and never payable.</p>
            <div className="ws-table-wrap">
              <table className="j-table">
                <caption className="j-sr-only">Earlier history</caption>
                <thead><tr><th scope="col">Date</th><th scope="col">Kind</th><th scope="col">Period</th><th scope="col" className="fin-amount">Amount</th></tr></thead>
                <tbody>
                  {rows.map((h) => (
                    <tr key={h._id}>
                      <td>{formatDateTime(h.at)}</td><td>{h.legacyKind === 'disbursal' ? 'Paid out' : 'Billed'}</td><td>{h.periodLabel ?? '—'}</td>
                      <td className="fin-amount">{money(h.amountMinor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </ListSection>
      <ListSection id="sa-ev-h" title="Finance events" q={events} empty="Changes to payout details, payouts and adjustments appear here.">
        {(rows) => <EventsList events={rows} />}
      </ListSection>
    </>
  );
}

/** A one-page "list" of this account's payouts in which a lost payout is recognised (lists never return request keys). */
function payoutFinder(s: Api, accountId: string, op: PendingOp<RecordPayoutInput>) {
  return async (): Promise<Page<SettlementPayout & { requestKey?: string }>> => {
    const rows = await s.payouts(accountId);
    return {
      items: rows.map((p) => ({ ...p, requestKey: !op.restored && isPayoutFor(p, accountId, op.body) ? op.requestKey : undefined })),
      page: 1, limit: rows.length, total: rows.length, totalPages: 1,
    };
  };
}

/** The statement as newest-first pages in which an adjustment is found by its key (`sourceId = <admin>:<key>`). */
function adjustmentFinder(s: Api, accountId: string, requestKey: string) {
  let cursor: string | undefined;
  return async (page: number): Promise<Page<StatementLine & { requestKey?: string; createdAt: string }>> => {
    if (page === 1) cursor = undefined;
    const r = await s.statement(accountId, { limit: 200, before: cursor });
    cursor = r.nextCursor ?? undefined;
    return {
      items: r.lines.map((l) => ({ ...l, requestKey: isAdjustmentFor(l, requestKey) ? requestKey : undefined, createdAt: l.at })),
      page, limit: 200, total: r.lines.length, totalPages: cursor ? page + 1 : page,
    };
  };
}

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
 * content). The body names the verified details version the admin saw (`detailsVersion`): a change since is refused
 * (409 PAYOUT_DETAILS_CHANGED). A lost answer locks the payout: resend it unchanged, or find it in the payouts list.
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

  /** `requestKey` produced this payout (answer, replay or found): end it, and only it. */
  const recorded = (p: SettlementPayout, requestKey: string, earlier: boolean) => {
    resolveStored(memory, slot, requestKey);
    onChanged();
    if (!mounted.current) return;
    setPendingState((cur) => (cur && cur.requestKey !== requestKey ? cur : undefined));
    setDone(earlier
      ? `This payout had already been recorded: ${money(p.amountMinor)}, reference ${p.reference}, paid on ${formatDate(p.paidOn)}. Nothing was recorded twice.`
      : `Payout of ${money(p.amountMinor)} recorded (reference ${p.reference}, paid on ${formatDate(p.paidOn)}).`);
    setFormKey((k) => k + 1);
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
          recorded(r.payout, attempt.requestKey, r.replayed);
        } catch (err) {
          if (!stillCurrent(memory.get<PendingPayout>(slot), attempt)) return;
          const next = afterFailure(attempt, err, messageOf(err));
          if (mounted.current) {
            setPending(next ?? undefined);
            if (!next) setRefused(messageOf(err));
          } else if (next) memory.set(slot, next); else memory.delete(slot);
          // A refusal (stale details, balance, reference): show the account as it is now.
          if (!next) onChanged();
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
  const blocked = !a.isActive ? 'This settlement account is inactive: no payout can be recorded.'
    : a.payoutDetailsState === 'none' || !a.payoutDetails ? 'There are no payout details to pay to yet.'
    : a.payoutDetailsState !== 'verified' ? 'The payout details have changed and are not verified: verify them before recording a payout.'
    : summary.balanceMinor <= 0 ? 'Nothing is due on this account.'
    : null;
  const showPanel = pending && !(busy && pending.attempts === 1 && !pending.uncertain);
  return (
    <section className="ws-section" aria-labelledby="sa-pay-h">
      <h2 id="sa-pay-h">Record a payout</h2>
      <p className="ws-muted">
        For a transfer you have already made outside Jansetu to the verified details. It lowers the balance and cannot be
        deleted; a mistake is corrected by voiding it.
      </p>
      {done && <Alert tone="ok">{done}</Alert>}
      {refused && <Alert>Not recorded: {refused}</Alert>}
      {showPanel ? (
        <>
          {pending.restored && (
            <Alert tone="warn">
              Look for it in the payouts below (same bank reference, amount and date). If it is there, it was recorded.
              Recording the same transfer again with the same bank reference is refused by the server: a reference is recorded once per account.
            </Alert>
          )}
          <PendingOpPanel key={pending.attempts} label="Unconfirmed payout" op={pending} busy={busy} onResend={() => void send(pending)}
            fetchPage={payoutFinder(s, accountId, pending)}
            onFound={(p) => recorded(p, pending.requestKey, true)}
            forget={{
              label: 'Record a payout from the start',
              confirmLabel: 'Forget the unconfirmed payout',
              consequence: 'Only after checking the payouts list. If the earlier payout was recorded after all, the same bank reference is refused; under another reference the balance would go down twice and one payout must then be voided.',
              onForget: () => {
                const k = pending.requestKey;
                resolveStored(memory, slot, k);
                setPendingState((cur) => (cur && cur.requestKey !== k ? cur : undefined));
              },
            }}
            summary={pending.restored ? null : <PayoutSummary body={pending.body} />} />
        </>
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
      Payout of {money(body.amountMinor)} by {PAYOUT_METHOD_LABEL[body.method]}, reference {body.reference}, paid on {formatDate(body.paidOn)} (details version {body.detailsVersion}).
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

  // A refusal sends the person back to the form as typed; a change of details or balance closes a review made before it.
  useEffect(() => { if (refused) setReview(null); }, [refused]);
  useEffect(() => {
    if (review && (review.detailsVersion !== a.payoutDetailsVersion || review.amountMinor > summary.balanceMinor)) {
      setReview(null);
      setChanged('The payout details or the balance changed while you were reviewing. Check them and review again.');
    }
  }, [review, a.payoutDetailsVersion, summary.balanceMinor]);

  function submit(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    setChanged(null);
    if (Object.keys(all).length || amountMinor === null) return;
    setReview({ amountMinor, method, reference: reference.trim(), paidOn, ...(note.trim() ? { note: note.trim() } : {}), detailsVersion: a.payoutDetailsVersion });
  }

  return (
    <form className="rx-form" noValidate onSubmit={submit} aria-label="Record a payout">
      <div className="rx-form-row">
        <TextField label="Amount paid (₹)" inputMode="decimal" value={amount} error={errors.amount}
          hint={`At most the balance, ${money(summary.balanceMinor)}.`} onChange={(e) => edit(() => setAmount(e.target.value))} />
        <div className="j-field">
          <label htmlFor="sa-method">Paid by</label>
          <select id="sa-method" value={method} onChange={(e) => edit(() => setMethod(e.target.value as PayoutMethod))}>
            {PAYOUT_METHODS.map((m) => <option key={m} value={m}>{PAYOUT_METHOD_LABEL[m]}</option>)}
          </select>
        </div>
        <TextField label="Bank reference (UTR)" value={reference} maxLength={MAX_PAYOUT_REFERENCE} error={errors.reference}
          onChange={(e) => edit(() => setReference(e.target.value))} />
        <TextField label="Paid on (India date)" type="date" value={paidOn} max={istToday()} error={errors.paidOn} onChange={(e) => edit(() => setPaidOn(e.target.value))} />
      </div>
      <TextArea label="Note (optional)" value={note} maxLength={MAX_PAYOUT_NOTE} error={errors.note} onChange={(e) => edit(() => setNote(e.target.value))} />
      {changed && <Alert tone="warn">{changed}</Alert>}
      {!review ? (
        <div className="rx-actions"><Button type="submit">Review the payout</Button></div>
      ) : (
        <div className="confirm" role="group" aria-label="Record the payout">
          <div className="confirm-text">
            Record {money(review.amountMinor)} paid to {a.beneficiaryName} at {detailsLabel(a.payoutDetails)} (details version {review.detailsVersion})
            by {PAYOUT_METHOD_LABEL[review.method]} on {formatDate(review.paidOn)}, reference {review.reference}? The balance goes
            from {money(summary.balanceMinor)} to {money(summary.balanceMinor - review.amountMinor)}. A recorded payout cannot be deleted; a mistake is corrected by voiding it.
          </div>
          <div className="confirm-actions">
            <Button busy={busy} onClick={() => onRecord(review)}>Record payout</Button>
            <Button variant="ghost" disabled={busy} onClick={() => setReview(null)}>Back to the payout</Button>
          </div>
        </div>
      )}
    </form>
  );
}

// ── Post an adjustment ──

type PendingAdjustment = PendingOp<AdjustmentInput>;

/**
 * A signed correction with a reason, exactly once per (admin, requestKey). A lost answer is resent unchanged, or found
 * in the statement by its key (the entry's `sourceId` carries it), also after a reload.
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

  const posted = (amountMinor: number, requestKey: string, earlier: boolean) => {
    resolveStored(memory, slot, requestKey);
    onChanged();
    if (!mounted.current) return;
    setPendingState((cur) => (cur && cur.requestKey !== requestKey ? cur : undefined));
    const what = amountMinor < 0 ? `${money(-amountMinor)} taken from the balance` : `${money(amountMinor)} added to the balance`;
    setDone(earlier ? `This adjustment had already been posted (${what}). Nothing was posted twice.` : `Adjustment posted: ${what}.`);
    setFormKey((k) => k + 1);
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
          posted(r.entry.amountMinor, attempt.requestKey, r.replayed);
        } catch (err) {
          if (!stillCurrent(memory.get<PendingAdjustment>(slot), attempt)) return;
          const next = afterFailure(attempt, err, messageOf(err));
          if (mounted.current) {
            setPending(next ?? undefined);
            if (!next) setRefused(messageOf(err));
          } else if (next) memory.set(slot, next); else memory.delete(slot);
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
      <h2 id="sa-adj-h">Post an adjustment</h2>
      <p className="ws-muted">A correction with a reason: add to the balance, or take from it (a recovery; the balance may go below zero).</p>
      {done && <Alert tone="ok">{done}</Alert>}
      {refused && <Alert>Not posted: {refused}</Alert>}
      {showPanel ? (
        <PendingOpPanel key={pending.attempts} label="Unconfirmed adjustment" op={pending} busy={busy} onResend={() => void send(pending)}
          fetchPage={adjustmentFinder(s, accountId, pending.requestKey)}
          onFound={(l) => posted(l.amountMinor, pending.requestKey, true)}
          forget={{
            label: 'Post an adjustment from the start',
            confirmLabel: 'Forget the unconfirmed adjustment',
            consequence: 'If it was posted after all, the balance is adjusted twice and must be corrected with another adjustment.',
            onForget: () => {
              const k = pending.requestKey;
              resolveStored(memory, slot, k);
              setPendingState((cur) => (cur && cur.requestKey !== k ? cur : undefined));
            },
          }}
          summary={pending.restored ? null : (
            <div>{pending.body.amountMinor < 0 ? `Take ${money(-pending.body.amountMinor)} from` : `Add ${money(pending.body.amountMinor)} to`} the balance: “{pending.body.reason}”.</div>
          )} />
      ) : !a.isActive ? <p className="ws-muted">This settlement account is inactive.</p>
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
  const paise = rupeesToPaise(amount);
  const amountError = paise === null ? 'Enter rupees, like 500 or 500.50.' : paise < 1 ? 'Enter an amount above zero.' : paise > MAX_FINANCE_MINOR ? 'This is above the largest adjustment the server accepts.' : null;
  const reasonError = reasonProblem(reason);
  const edit = (fn: () => void) => { fn(); setReview(null); };
  useEffect(() => { if (refused) setReview(null); }, [refused]);

  function submit(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    if (amountError || reasonError || paise === null) return;
    setReview({ amountMinor: direction === 'debit' ? -paise : paise, reason: reason.trim() });
  }

  const after = review ? summary.balanceMinor + review.amountMinor : 0;
  return (
    <form className="rx-form" noValidate onSubmit={submit} aria-label="Post an adjustment">
      <fieldset className="fin-radio">
        <legend>Direction</legend>
        <label><input type="radio" name="sa-dir" checked={direction === 'credit'} onChange={() => edit(() => setDirection('credit'))} /> Add to the balance</label>
        <label><input type="radio" name="sa-dir" checked={direction === 'debit'} onChange={() => edit(() => setDirection('debit'))} /> Take from the balance (recovery)</label>
      </fieldset>
      <div className="rx-form-row">
        <TextField label="Adjustment amount (₹)" inputMode="decimal" value={amount} error={tried ? amountError : null} onChange={(e) => edit(() => setAmount(e.target.value))} />
      </div>
      <TextArea label="Reason (kept with the entry)" value={reason} maxLength={MAX_FINANCE_REASON} error={tried ? reasonError : null} onChange={(e) => edit(() => setReason(e.target.value))} />
      {!review ? (
        <div className="rx-actions"><Button type="submit">Review the adjustment</Button></div>
      ) : (
        <div className="confirm" role="group" aria-label="Post the adjustment">
          <div className="confirm-text">
            {review.amountMinor < 0 ? `Take ${money(-review.amountMinor)} from` : `Add ${money(review.amountMinor)} to`} the balance of {summary.account.beneficiaryName}?
            It goes from {money(summary.balanceMinor)} to <Signed minor={after} />. Reason: “{review.reason}”.
            {after < 0 ? ` The balance will be below zero: ${summary.account.beneficiaryName} then owes ${money(-after)} back.` : ''}
            {' '}An adjustment is recorded for good; a mistake is corrected with another adjustment.
          </div>
          <div className="confirm-actions">
            <Button busy={busy} onClick={() => onPost(review)}>Post adjustment</Button>
            <Button variant="ghost" disabled={busy} onClick={() => setReview(null)}>Back to the adjustment</Button>
          </div>
        </div>
      )}
    </form>
  );
}

