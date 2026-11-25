import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  ApiError, rupeesToPaise, weeklyWait, withdrawalAmountProblem, withdrawalErrorCode, withdrawalErrorDetails, type PayoutDetailsInput, type SettlementAccount,
  type Withdrawable, type Withdrawal, type WithdrawalsApi,
} from '@jansetu/api';
import { formatPaise } from '@jansetu/i18n';
import { Alert, Badge, Button, ErrorState, formatDateTime, Loading, Parts, TextField } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { messageOf } from '../../errors.ts';
import { t } from '../../i18n/withdrawals/index.ts';
import { definitelyNotRecorded, newRequestKey, startOp, type PendingOp } from '../../requests.ts';
import { PayoutDetailsForm, useOneAtATime } from '../finance/finance.tsx';
import { CursorPager, useCursorPages } from './cursorList.tsx';
import { CheckPanel, useOwnedOp } from './ownedOp.tsx';

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
  /** May ask for and cancel withdrawals (a lab member needs `wallet.manage`). */
  canAct: boolean;
  /** Where the destination is set: the pharmacy's form here, or a link (a lab's Finance, a doctor's Earnings). */
  destination: { save: (body: PayoutDetailsInput, expectedDetailsVersion: number) => Promise<SettlementAccount> } | { link: string; page: 'finance' | 'earnings' };
}

const WORDED = ['PAYOUT_DESTINATION_NOT_VERIFIED', 'PAYOUT_DETAILS_CHANGED', 'WALLET_FROZEN', 'WALLET_RECEIVABLE', 'WITHDRAWALS_DISABLED', 'WITHDRAWAL_CHANGED',
  'WITHDRAWAL_NOT_REQUESTED', 'WITHDRAWAL_NOT_FOUND', 'WITHDRAWAL_NOT_PAID', 'IDEMPOTENCY_KEY_REUSED', 'REQUEST_ABANDONED', 'INDEXES_OUTDATED',
  'SPECIALIST_NOT_VERIFIED', 'REFERENCE_REUSED', 'DISPUTE_NOT_RECORDED', 'NOTHING_TO_RECOVER'] as const;
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
  return isWorded(code) ? t(`error.${code}`) : messageOf(err);
}
/** For `ConfirmAction` (which shows an `ApiError`'s message): the refusal in words, without its code. */
export const wordedError = (err: unknown) => new ApiError(err instanceof ApiError ? err.status : 0, withdrawalWords(err));
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
function Overview({ source, w, onNote }: { source: WithdrawalSource; w: Withdrawable; onNote: (n: Note) => void }) {
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
      {dest.state === 'none' && <Destination source={source} onNote={onNote} />}
    </>
  );
}

/** No destination yet: the pharmacy adds it here (the shared payout-details form); a lab or a doctor on its own page. */
function Destination({ source, onNote }: { source: WithdrawalSource; onNote: (n: Note) => void }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const d = source.destination;
  if ('link' in d) {
    const page = <Link key="page" to={d.link}>{d.page === 'finance' ? t('dest.finance') : t('dest.earnings')}</Link>;
    return <p><Parts of={t.rich('dest.elsewhere', { page })} /></p>;
  }
  const reread = async () => ({ payoutDetails: null, payoutDetailsVersion: (await source.api.withdrawable()).destination.detailsVersion });
  return (
    <>
      <p>{t('dest.none')}</p>
      {open ? (
        <PayoutDetailsForm account={null} audience={'owner'} reread={reread} save={d.save}
          onSaved={() => { setOpen(false); onNote({ tone: 'ok', text: t('dest.saved') }); void queryClient.invalidateQueries({ queryKey: keysOf(source).base }); }}
          onLost={(message) => { setOpen(false); onNote({ tone: 'warn', text: message }); void queryClient.invalidateQueries({ queryKey: keysOf(source).base }); }}
          onCancel={() => setOpen(false)} />
      ) : <div><Button variant="secondary" onClick={() => setOpen(true)}>{t('dest.add')}</Button></div>}
    </>
  );
}

type Note = { tone: 'ok' | 'error' | 'warn'; text: string };
interface PendingWithdrawal { amountMinor: number; detailsVersion: number }
interface Review extends PendingWithdrawal { requestKey: string; feeMinor: number; transferMinor: number }

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
  const [givingUp, setGivingUp] = useState(false);
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
      const q = (await perform(() => source.api.withdrawable(amount))).quote;
      if (!q || !q.available) { setError(t('amount.above', { max: formatPaise(w.withdrawableNowMinor) })); return; }
      setReview({ amountMinor: amount, detailsVersion: w.destination.detailsVersion, requestKey: newRequestKey(), feeMinor: q.feeMinor, transferMinor: q.transferMinor });
    } catch (err) {
      setError(withdrawalWords(err));
    }
  }

  const found = (x: Withdrawal) => setNote({ tone: 'ok', text: t('unconfirmed.found', { transfer: formatPaise(x.transferMinor), masked: x.destination.masked ?? masked }) });

  async function ask(p: PendingOp<PendingWithdrawal>) {
    const sole = p.attempts === 0 && !p.uncertain;
    const r = await perform(() => send(p, (b) => source.api.request({ ...b, requestKey: p.requestKey })));
    if (r.kind === 'stale') return;
    if (r.kind === 'ok') {
      setReview(null); setText('');
      setNote({ tone: 'ok', text: t('done', { transfer: formatPaise(r.value.withdrawal.transferMinor), masked: r.value.withdrawal.destination.masked ?? masked }) });
      await refresh();
      return;
    }
    // The switch or the indexes refused the only attempt before anything was written.
    if (r.kind === 'unknown' && sole && refusedBeforeWriting(r.error)) { settle(p.requestKey); setReview(null); setNote({ tone: 'error', text: withdrawalWords(r.error) }); await refresh(); return; }
    if (r.kind === 'refused') { setReview(null); setNote({ tone: 'error', text: withdrawalWords(r.error) }); await refresh(); }
  }

  async function giveUp(p: PendingOp<PendingWithdrawal>) {
    setGivingUp(true);
    try {
      const r = await perform(() => source.api.abandon(p.requestKey));
      if (r.state === 'used') { settle(p.requestKey); found(r.withdrawal); await refresh(); return; }
      if (r.state !== 'abandoned') { setNote({ tone: 'warn', text: t('unconfirmed.cannotGiveUp') }); return; }
      settle(p.requestKey); setReview(null);
      setNote({ tone: 'ok', text: t('unconfirmed.givenUp') });
    } catch (err) {
      setNote({ tone: 'error', text: withdrawalWords(err) });
    } finally {
      setGivingUp(false);
    }
  }

  if (op && !(busy && !givingUp && op.attempts === 1 && !op.uncertain)) {
    const restored = !!op.restored || !op.body;
    return (
      <>
        {note && <Alert tone={note.tone}>{note.text}</Alert>}
        <CheckPanel label={t('unconfirmed.panel')}
          onCheck={async () => {
            const r = await source.api.byKey(op.requestKey);
            if (r.state === 'used') { settle(op.requestKey); setReview(null); found(r.withdrawal); await refresh(); return null; }
            if (r.state === 'abandoned') { settle(op.requestKey); setReview(null); setNote({ tone: 'ok', text: t('unconfirmed.givenUp') }); return null; }
            return restored ? t('unconfirmed.notYetRestored') : t('unconfirmed.notYet');
          }}
          resend={restored ? undefined : { label: t('unconfirmed.resend'), busy: busy && !givingUp, onClick: () => { setNote(null); void ask(op).catch((e: unknown) => setNote({ tone: 'error', text: withdrawalWords(e) })); } }}
          giveUp={{ label: t('unconfirmed.giveUp'), busy: givingUp, onClick: () => void giveUp(op) }}>
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
      <Overview source={source} w={w} onNote={setNote} />
      {!source.canAct ? <p className="ws-muted">{t('noRights')}</p>
        : wait ? <Alert tone="warn">{t('weekly', { date: formatDateTime(wait) })}</Alert>
        : w.destination.state !== 'verified' ? null
        : review ? (
        <div className="confirm" role="group" aria-label={t('quote.title')}>
          <p>{t('quote.amount', { gross: formatPaise(review.amountMinor) })}</p>
          <p><strong>{feeWords({ ...review, grossMinor: review.amountMinor })}</strong></p>
          <p>{t('dest.to', { masked })}</p>
          <div className="confirm-actions">
            <Button busy={busy} onClick={() => { setNote(null); const { requestKey, amountMinor, detailsVersion } = review; void ask(startOp(requestKey, { amountMinor, detailsVersion })); }}>
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
      if (definitelyNotRecorded(err)) throw wordedError(err);
      setNote({ tone: 'warn', text: t('cancel.unknown', { error: messageOf(err) }) });
    } finally {
      await queryClient.invalidateQueries({ queryKey: source.walletKey });
    }
  }
  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorState message={withdrawalWords(q.error)} onRetry={() => void q.refetch()} />;
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
                  {x.state === 'requested' && source.canAct && (
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
