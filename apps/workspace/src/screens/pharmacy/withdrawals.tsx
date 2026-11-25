import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  ApiError, quoteChangedOf, rupeesToPaise, weeklyWait, withdrawalAmountProblem, withdrawalErrorCode, withdrawalErrorDetails, type QuoteReason,
  type Withdrawable, type Withdrawal, type WithdrawalsApi,
} from '@jansetu/api';
import { formatPaise } from '@jansetu/i18n';
import { Alert, Badge, Button, ErrorState, formatDateTime, Loading, Parts, TextField } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { messageOf } from '../../errors.ts';
import { t } from '../../i18n/withdrawals/index.ts';
import { definitelyNotRecorded, newRequestKey, startOp, type PendingOp } from '../../requests.ts';
import { useOneAtATime } from '../finance/finance.tsx';
import { CursorPager, useCursorPages } from './cursorList.tsx';
import { CheckPanel, useKeyedCheck, useOwnedOp } from './ownedOp.tsx';

/**
 * WQ29: "Withdraw to bank" on a wallet page (backend r32 round 4d, design §26.16.4; switched off on the server until it is
 * allowed): what can be withdrawn now and later, the destination, an amount, its quote with the card fee line (the fee is
 * taken only on unspent card money), the request as one owned request (a lost answer is checked by its key, sent again or
 * given up), and the list of requests with Cancel. One piece for the pharmacy, a lab and a doctor (`WithdrawalSource`).
 */
export interface WithdrawalSource {
  /** This device's memory slot part (whose wallet). */
  owner: string;
  /** The wallet's query key: read again after a request or a cancel (the balance moves). */
  walletKey: readonly unknown[];
  api: WithdrawalsApi;
  /** May ask for withdrawals (a lab member needs `wallet.manage` and, WQ48 r35, partner-wide scope). */
  canAct: boolean;
  /** WQ48: why not (said instead of the form), when it is not the missing right to manage the wallet. */
  actNote?: string;
  /** WQ48 (r35b): may cancel a waiting one (a branch-limited lab manager may cancel the one it asked for); default `canAct`. */
  canCancel?: boolean;
  /**
   * Where the destination is set: a link (a lab's Finance, a doctor's Earnings), (WQ29b) a lab member who cannot open
   * Finance is told to ask a lab owner, or (WQ48) the pharmacy's payout details section on the same Finance page.
   */
  destination: { link: string; page: 'finance' | 'earnings' } | { askOwner: true } | { onPage: true };
}

const WORDED = ['PAYOUT_DESTINATION_NOT_VERIFIED', 'PAYOUT_DETAILS_CHANGED', 'WALLET_FROZEN', 'WALLET_RECEIVABLE', 'WITHDRAWALS_DISABLED', 'WITHDRAWAL_CHANGED',
  'WITHDRAWAL_NOT_REQUESTED', 'WITHDRAWAL_NOT_FOUND', 'WITHDRAWAL_NOT_PAID', 'IDEMPOTENCY_KEY_REUSED', 'REQUEST_ABANDONED', 'INDEXES_OUTDATED',
  'SPECIALIST_NOT_VERIFIED', 'REFERENCE_REUSED', 'DISPUTE_NOT_RECORDED', 'NOTHING_TO_RECOVER', 'WITHDRAWAL_LOT_DISPUTED', 'WITHDRAWAL_QUOTE_CHANGED',
  'WITHDRAWAL_OPEN', 'FINANCE_SCOPE_REQUIRED', 'REFERRAL_ACCOUNT_USES_HOME', 'REFERRAL_PAYOUTS_DISABLED', 'WALLET_NOT_FOUND', 'WALLET_INACTIVE',
  'PARTNER_NOT_VERIFIED'] as const;
type Worded = (typeof WORDED)[number];
const isWorded = (code: string | null): code is Worded => (WORDED as readonly (string | null)[]).includes(code);
const money = (v: unknown) => (Number.isFinite(Number(v)) ? formatPaise(Number(v)) : null);

/** A refusal of the withdrawal routes in words (with the server's safe details), else the server's message. */
export function withdrawalWords(err: unknown): string {
  const code = withdrawalErrorCode(err);
  const d = withdrawalErrorDetails(err);
  if (code === 'WITHDRAWAL_BELOW_MINIMUM' && money(d.minimumMinor)) return t('error.WITHDRAWAL_BELOW_MINIMUM', { minimum: money(d.minimumMinor)! });
  if (code === 'WITHDRAWAL_ABOVE_AVAILABLE' && money(d.withdrawableNowMinor)) return t('error.WITHDRAWAL_ABOVE_AVAILABLE', { max: money(d.withdrawableNowMinor)! });
  if (code === 'WITHDRAWAL_WEEKLY_LIMIT' && typeof d.nextAllowedAt === 'string') return t('error.WITHDRAWAL_WEEKLY_LIMIT', { date: formatDateTime(d.nextAllowedAt) });
  if (code === 'SETOFF_ABOVE_AVAILABLE') {
    const max = [d.receivableMinor, d.referralDueMinor].filter((v): v is number => Number.isSafeInteger(v)).sort((a, b) => a - b)[0];
    return max !== undefined ? t('setoff.above', { max: formatPaise(max) }) : t('error.SETOFF_ABOVE_AVAILABLE');
  }
  return isWorded(code) ? t(`error.${code}`) : messageOf(err);
}
/** For `ConfirmAction` (which shows an `ApiError`'s message): the refusal in words, without its code. */
export const wordedError = (err: unknown) => new ApiError(err instanceof ApiError ? err.status : 0, withdrawalWords(err));
/** WQ48 (r35): why a quoted amount cannot be withdrawn now, in the words the page already uses for each refusal. */
function reasonWords(reason: QuoteReason | null | undefined, w: Withdrawable): string {
  switch (reason) {
    case 'WITHDRAWALS_DISABLED': return t('error.WITHDRAWALS_DISABLED');
    case 'BELOW_MINIMUM': return t('amount.belowMinimum', { minimum: formatPaise(w.minimumMinor) });
    case 'DESTINATION_NOT_VERIFIED': return t('error.PAYOUT_DESTINATION_NOT_VERIFIED');
    case 'WALLET_RECEIVABLE': return t('error.WALLET_RECEIVABLE');
    case 'WALLET_FROZEN': return t('error.WALLET_FROZEN');
    case 'WEEKLY_LIMIT': return t('weekly', { date: w.nextAllowedAt ? formatDateTime(w.nextAllowedAt) : '—' });
    case 'ABOVE_WITHDRAWABLE': return t('amount.above', { max: formatPaise(w.withdrawableNowMinor) });
    case 'LAB_NOT_VERIFIED': return t('error.PARTNER_NOT_VERIFIED');
    case 'WALLET_INACTIVE': return t('error.WALLET_INACTIVE');
    // A reason this page does not know (a newer server), or none sent: said plainly, never a guess.
    default: return t('reason.other');
  }
}
/** The switch, or indexes not built: refused before anything was written (a sole first attempt asked nothing). */
const refusedBeforeWriting = (err: unknown) => ['WITHDRAWALS_DISABLED', 'INDEXES_OUTDATED'].includes(withdrawalErrorCode(err) ?? '');

const keysOf = (s: WithdrawalSource) => ({ base: [...s.walletKey, 'withdrawals'], withdrawable: [...s.walletKey, 'withdrawals', 'withdrawable'] });

export function WithdrawSection({ source }: { source: WithdrawalSource }) {
  const w = useQuery({ queryKey: keysOf(source).withdrawable, queryFn: () => source.api.withdrawable() });
  return (
    <section className="ws-section" aria-labelledby="wd-h">
      <h2 id="wd-h">{t('section.title')}</h2>
      {w.isPending ? <Loading />
        : w.isError && w.data === undefined ? <ErrorState message={withdrawalWords(w.error)} onRetry={() => void w.refetch()} />
        : <Withdraw source={source} w={w.data!} />}
      {w.data && <WithdrawalList source={source} />}
    </section>
  );
}

/** What can be withdrawn now and later, the rules and the destination. */
function Overview({ source, w }: { source: WithdrawalSource; w: Withdrawable }) {
  const dest = w.destination;
  return (
    <>
      <dl className="ws-dl">
        <dt>{t('now')}</dt><dd><strong>{formatPaise(w.withdrawableNowMinor)}</strong></dd>
        {w.availableLater.length > 0 && (
          <>
            <dt>{t('later.title')}</dt>
            <dd>{w.availableLater.map((l) => <div key={l.availableAt}>{t('later.item', { amount: formatPaise(l.amountMinor), date: formatDateTime(l.availableAt) })}</div>)}</dd>
          </>
        )}
      </dl>
      <p className="ws-muted">{t('rules', { minimum: formatPaise(w.minimumMinor) })}</p>
      {dest.state === 'verified' && dest.masked && <p>{t('dest.to', { masked: dest.masked })}</p>}
      {dest.state === 'unverified' && <Alert tone="warn">{t('dest.unverified', { masked: dest.masked ?? '' })}</Alert>}
      {dest.state === 'none' && <Destination source={source} />}
    </>
  );
}

/**
 * No destination yet: where it is added. WQ48: the pharmacy's payout details section on the same Finance page; a lab's
 * Finance or a doctor's Earnings (a link); or (WQ29b) a lab member who cannot open Finance asks a lab owner.
 */
function Destination({ source }: { source: WithdrawalSource }) {
  const d = source.destination;
  if ('askOwner' in d) return <p>{t('dest.askOwner')}</p>;
  if ('onPage' in d) return <p>{t('dest.onPage')}</p>;
  const page = <Link key="page" to={d.link}>{d.page === 'finance' ? t('dest.finance') : t('dest.earnings')}</Link>;
  return <p><Parts of={t.rich('dest.elsewhere', { page })} /></p>;
}

type Note = { tone: 'ok' | 'error' | 'warn'; text: string };
/**
 * What is sent (`amountMinor`, `detailsVersion`, r35: `expectedTransferMinor`, the transfer the person confirmed: the server
 * refuses with the new quote if the fee moved) and, kept with it on this device only, the fee shown.
 */
interface PendingWithdrawal { amountMinor: number; detailsVersion: number; expectedTransferMinor: number; quotedFeeMinor: number }
interface Review extends PendingWithdrawal { requestKey: string; masked: string }

const feeWords = (r: { feeMinor: number; transferMinor: number; grossMinor: number }) => (r.feeMinor > 0
  ? t('quote.fee', { fee: formatPaise(r.feeMinor), transfer: formatPaise(r.transferMinor), gross: formatPaise(r.grossMinor) })
  : t('quote.noFee', { transfer: formatPaise(r.transferMinor) }));

/**
 * The owned request and what the section says, mounted while the withdrawable answer is shown (so an unconfirmed request
 * and the last answer stay on screen whatever the switch, the weekly limit or the destination say now); then an amount,
 * its quote (the fee line) and the request.
 */
function Withdraw({ source, w }: { source: WithdrawalSource; w: Withdrawable }) {
  const queryClient = useQueryClient();
  const { perform, busy } = useOneAtATime('withdrawal');
  const { op, send, settle } = useOwnedOp<PendingWithdrawal>(`wallet-withdrawal:${source.owner}`);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const masked = w.destination.masked ?? '';
  const refresh = () => queryClient.invalidateQueries({ queryKey: source.walletKey });

  async function quote(e: FormEvent) {
    e.preventDefault();
    setNote(null);
    const amount = rupeesToPaise(text) ?? NaN;
    const problem = withdrawalAmountProblem(amount, w);
    if (problem === 'invalid') { setError(t('amount.invalid')); return; }
    if (problem === 'below_minimum') { setError(t('amount.belowMinimum', { minimum: formatPaise(w.minimumMinor) })); return; }
    if (problem === 'above_available') { setError(t('amount.above', { max: formatPaise(w.withdrawableNowMinor) })); return; }
    setError(null);
    try {
      const fresh = await perform(() => source.api.withdrawable(amount));
      const q = fresh.quote;
      // WQ48 (r35): the server says why this amount cannot go through now; the page is read again (the switch, the weekly
      // limit or the destination may have moved).
      if (!q || !q.available) { setError(reasonWords(q?.reason, fresh)); if (q?.reason && q.reason !== 'BELOW_MINIMUM' && q.reason !== 'ABOVE_WITHDRAWABLE') await refresh(); return; }
      // WQ29b: the destination (and its version, the fence) as the fresh answer has it, not as the page first read it.
      if (fresh.destination.state !== 'verified') { setError(null); await refresh(); return; }
      setReview({ amountMinor: amount, detailsVersion: fresh.destination.detailsVersion, requestKey: newRequestKey(), quotedFeeMinor: q.feeMinor,
        expectedTransferMinor: q.transferMinor, masked: fresh.destination.masked ?? '' });
    } catch (err) {
      setError(withdrawalWords(err));
    }
  }

  const found = (x: Withdrawal) => setNote({ tone: 'ok', text: t('unconfirmed.found', { transfer: formatPaise(x.transferMinor), masked: x.destination.masked ?? masked }) });
  const keyed = useKeyedCheck(settle, { byKey: source.api.byKey, abandon: source.api.abandon }, {
    found: async (r) => { setReview(null); found(r.withdrawal); await refresh(); },
    givenUp: () => { setReview(null); setNote({ tone: 'ok', text: t('unconfirmed.givenUp') }); },
    notYet: (restored) => (restored ? t('unconfirmed.notYetRestored') : t('unconfirmed.notYet')),
    cannotGiveUp: () => setNote({ tone: 'warn', text: t('unconfirmed.cannotGiveUp') }),
    failed: (err) => setNote({ tone: 'error', text: withdrawalWords(err) }),
  });
  const givingUp = keyed.givingUp;

  async function ask(p: PendingOp<PendingWithdrawal>) {
    const sole = p.attempts === 0 && !p.uncertain;
    const r = await perform(() => send(p, (b) => source.api.request({ ...b, requestKey: p.requestKey })));
    if (r.kind === 'stale') return;
    if (r.kind === 'ok') {
      setReview(null); setText('');
      const x = r.value.withdrawal;
      // WQ29b: the same key answered an earlier request that is no longer waiting: say what the server holds.
      if (r.value.replayed && x.state !== 'requested') setNote({ tone: 'warn', text: t('replayed', { state: stateWords(x.state) }) });
      else setNote({ tone: 'ok', text: t('done', { transfer: formatPaise(x.transferMinor), masked: x.destination.masked ?? masked }) });
      await refresh();
      return;
    }
    // The switch or the indexes refused the only attempt before anything was written.
    if (r.kind === 'unknown' && sole && refusedBeforeWriting(r.error)) { settle(p.requestKey); setReview(null); setNote({ tone: 'error', text: withdrawalWords(r.error) }); await refresh(); return; }
    // WQ48 (r35): the card fee moved since the check: nothing was withdrawn; the new figures are shown to confirm again (a new key).
    const changed = r.kind === 'refused' ? quoteChangedOf(r.error) : null;
    if (changed && changed.grossMinor === p.body.amountMinor) {
      setReview((v) => v && { ...v, requestKey: newRequestKey(), quotedFeeMinor: changed.feeMinor, expectedTransferMinor: changed.transferMinor });
      setNote({ tone: 'warn', text: t('quote.changed') });
      return;
    }
    // WQ48b: a resend refused because the fee moved: that attempt recorded nothing, but the first one may have.
    if (r.kind === 'unknown' && quoteChangedOf(r.error)) { setNote({ tone: 'warn', text: t('unconfirmed.quoteChanged') }); return; }
    if (r.kind === 'refused') { setReview(null); setNote({ tone: 'error', text: withdrawalWords(r.error) }); await refresh(); }
  }

  if (op && !(busy && !givingUp && op.attempts === 1 && !op.uncertain)) {
    const restored = !!op.restored || !op.body;
    return (
      <>
        {note && <Alert tone={note.tone}>{note.text}</Alert>}
        <CheckPanel label={t('unconfirmed.panel')}
          onCheck={() => keyed.check(op)}
          resend={restored ? undefined : { label: t('unconfirmed.resend'), busy: busy && !givingUp, onClick: () => { setNote(null); void ask(op).catch((e: unknown) => setNote({ tone: 'error', text: withdrawalWords(e) })); } }}
          giveUp={{ label: t('unconfirmed.giveUp'), busy: givingUp, onClick: () => void keyed.giveUp(op, perform) }}>
          <Alert tone="warn">{restored ? t('unconfirmed.restored') : t('unconfirmed.text', { error: op.error ?? '' })}</Alert>
        </CheckPanel>
      </>
    );
  }

  const said = note && <Alert tone={note.tone}>{note.text}</Alert>;
  if (!w.enabled) return <>{said}<p className="ws-muted">{t('off')}</p></>;
  const wait = weeklyWait(w);
  return (
    <>
      {said}
      <Overview source={source} w={w} />
      {!source.canAct ? <p className="ws-muted">{source.actNote ?? t('noRights')}</p>
        : wait ? <Alert tone="warn">{t('weekly', { date: formatDateTime(wait) })}</Alert>
        : w.destination.state !== 'verified' ? null
        : review ? (
        <div className="confirm" role="group" aria-label={t('quote.title')}>
          <p>{t('quote.amount', { gross: formatPaise(review.amountMinor) })}</p>
          <p><strong>{feeWords({ feeMinor: review.quotedFeeMinor, transferMinor: review.expectedTransferMinor, grossMinor: review.amountMinor })}</strong></p>
          <p>{t('dest.to', { masked: review.masked })}</p>
          <div className="confirm-actions">
            <Button busy={busy} onClick={() => { setNote(null); const { requestKey, masked: _m, ...body } = review; void ask(startOp(requestKey, body)); }}>
              {t('quote.send', { gross: formatPaise(review.amountMinor) })}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setReview(null)}>{t('quote.back')}</Button>
          </div>
        </div>
      ) : (
        <form className="ws-search" noValidate onSubmit={(e) => void quote(e)}>
          <TextField label={t('amount.label')} inputMode="decimal" autoComplete="off" value={text} error={error}
            hint={t('amount.hint', { max: formatPaise(w.withdrawableNowMinor) })} onChange={(e) => setText(e.target.value)} />
          <Button type="submit" busy={busy}>{t('amount.next')}</Button>
        </form>
      )}
    </>
  );
}

const STATE_TONE: Readonly<Record<string, 'ok' | 'warn' | 'danger' | undefined>> = { requested: 'warn', paid: 'ok', rejected: 'danger', voided: 'danger' };
const stateWords = (s: string) => (s === 'requested' || s === 'cancelled' || s === 'rejected' || s === 'paid' || s === 'voided' ? t(`state.${s}`) : s);
export { stateWords as withdrawalStateWords, STATE_TONE as WITHDRAWAL_STATE_TONE };

/** The owner's requests, newest first, with Cancel while one waits. */
function WithdrawalList({ source }: { source: WithdrawalSource }) {
  const queryClient = useQueryClient();
  const pages = useCursorPages();
  const q = useQuery({ queryKey: [...keysOf(source).base, 'list', pages.cursor], queryFn: () => source.api.list({ cursor: pages.cursor || undefined }) });
  const [note, setNote] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  async function cancel(x: Withdrawal) {
    setNote(null);
    try {
      await source.api.cancel(x._id, x.version);
      setNote({ tone: 'ok', text: t('cancel.done', { gross: formatPaise(x.grossMinor) }) });
    } catch (err) {
      // WQ48b: a branch-limited lab manager may cancel only the withdrawals it asked for (r35b).
      if (withdrawalErrorCode(err) === 'FINANCE_SCOPE_REQUIRED') throw new ApiError(err instanceof ApiError ? err.status : 403, t('cancel.notYours'));
      if (definitelyNotRecorded(err)) throw wordedError(err);
      setNote({ tone: 'warn', text: t('cancel.unknown', { error: messageOf(err) }) });
    } finally {
      await queryClient.invalidateQueries({ queryKey: source.walletKey });
    }
  }
  // WQ29b: a failed read again keeps the list read before.
  if (!q.data) return q.isError ? <ErrorState message={withdrawalWords(q.error)} onRetry={() => void q.refetch()} /> : <Loading />;
  if (q.data.items.length === 0 && pages.page === 1) return null;
  return (
    <>
      <h3>{t('list.title')}</h3>
      {note && <Alert tone={note.tone}>{note.text}</Alert>}
      <div className="ws-table-wrap">
        <table className="j-table">
          <caption className="j-sr-only">{t('list.caption')}</caption>
          <thead><tr><th scope="col">{t('list.asked')}</th><th scope="col">{t('list.amount')}</th><th scope="col">{t('list.state')}</th><th scope="col"><span className="j-sr-only">{t('list.cancelColumn')}</span></th></tr></thead>
          <tbody>
            {q.data.items.map((x) => (
              <tr key={x._id}>
                <td>{formatDateTime(x.createdAt)}</td>
                <td>{formatPaise(x.grossMinor)}<div className="ws-muted">{x.feeLine}</div></td>
                <td>
                  <Badge tone={STATE_TONE[x.state]}>{stateWords(x.state)}</Badge>
                  {x.paid && <div className="ws-muted">{t('list.paid', { date: x.paid.paidOn, reference: x.paid.reference })}</div>}
                  {x.reason && <div className="ws-muted">{t('list.reason', { reason: x.reason })}</div>}
                </td>
                <td>
                  {/* r35b: one this person did not ask for is not offered to a manager who can only cancel its own. */}
                  {x.state === 'requested' && (source.canCancel ?? source.canAct) && (source.canAct || x.requestedByMe !== false) && (
                    <ConfirmAction label={t('cancel.button')} confirmLabel={t('cancel.confirm')} version={x.version}
                      consequence={t('cancel.consequence', { gross: formatPaise(x.grossMinor) })} onConfirm={() => cancel(x)} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <CursorPager pages={pages} nextCursor={q.data.nextCursor} label={t('list.pages')} />
    </>
  );
}
