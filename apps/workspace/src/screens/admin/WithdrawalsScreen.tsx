import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { adminWithdrawalsApi, isPaidReference, istToday, withdrawalErrorCode, type AdminWithdrawal, type PaidBody, type PaidMethod, type WithdrawalState } from '@jansetu/api';
import { formatPaise } from '@jansetu/i18n';
import { Alert, Badge, Button, Empty, ErrorState, formatDateTime, Loading, TextField } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { messageOf } from '../../errors.ts';
import { t } from '../../i18n/withdrawals/index.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { definitelyNotRecorded, newRequestKey, startOp, type PendingOp } from '../../requests.ts';
import { useSession, useStaff } from '../../session.tsx';
import { useOneAtATime } from '../finance/finance.tsx';
import { CursorPager, useCursorPages } from '../pharmacy/cursorList.tsx';
import { CheckPanel, useOwnedOp } from '../pharmacy/ownedOp.tsx';
import { useAdminScope } from './adminScope.ts';
import { WITHDRAWAL_STATE_TONE, withdrawalStateWords, withdrawalWords, wordedError } from '../pharmacy/withdrawals.tsx';

/**
 * WQ29: the admin's withdrawals queue (backend r32 round 4d, `/admin/wallet-withdrawals`, design §26.16.4): oldest first,
 * the waiting ones by default. A waiting one is paid outside Jansetu and then marked paid with the bank's reference (one
 * owned request with its key: a lost answer is checked by reading the withdrawal, or sent again), or rejected; a paid one
 * whose transfer came back is voided. Reject and void are fenced by the version shown. Words: the `withdrawals` catalogue.
 */
export function WithdrawalsScreen() {
  const admin = useStaff();
  const scope = useAdminScope('withdrawals');
  return (
    <>
      <PageHeading title={t('admin.title')}>{t('admin.intro')}</PageHeading>
      <Queue key={scope.identity} adminId={admin.id} queueKey={scope.key} />
    </>
  );
}

const FILTERS: readonly (WithdrawalState | '')[] = ['requested', 'paid', 'rejected', 'cancelled', 'voided', ''];
const walletPath = (w: AdminWithdrawal) => (w.walletRef.kind === 'pharmacy' ? `/admin/pharmacy-wallets/${w.walletRef.id}`
  : w.walletRef.kind === 'lab' ? `/admin/partners/${w.walletRef.id}/wallet` : `/admin/doctors/${w.walletRef.id}/wallet`);
/** WQ29c: a withdrawal named without anyone's details: the last six characters of its id. */
const shortRef = (w: AdminWithdrawal) => w._id.slice(-6).toUpperCase();
const ownerWords = (kind: string) => (kind === 'pharmacy' || kind === 'lab' || kind === 'doctor' ? t(`owner.${kind}`) : kind);

function Queue({ adminId, queueKey }: { adminId: string; queueKey: readonly unknown[] }) {
  const { api } = useSession();
  const [state, setState] = useState<WithdrawalState | ''>('requested');
  const pages = useCursorPages();
  const q = useQuery({ queryKey: [...queueKey, state, pages.cursor], queryFn: () => adminWithdrawalsApi(api).list({ ...(state ? { state } : {}), cursor: pages.cursor || undefined }) });
  // WQ29c: what was just done, above the list: a paid, rejected or voided row leaves the filter shown when it is read again.
  const [done, setDone] = useState<string | null>(null);
  return (
    <section className="ws-section" aria-labelledby="wq-h">
      <h2 id="wq-h" className="j-sr-only">{t('admin.title')}</h2>
      {done && <Alert tone="ok">{done}</Alert>}
      <div className="ws-filter">
        <div className="j-field">
          <label htmlFor="wd-state">{t('admin.filter')}</label>
          <select id="wd-state" value={state} onChange={(e) => { setState(e.target.value as WithdrawalState | ''); pages.reset(); }}>
            {FILTERS.map((f) => <option key={f} value={f}>{f ? withdrawalStateWords(f) : t('admin.filter.all')}</option>)}
          </select>
        </div>
      </div>
      {/* WQ29b: a failed read again keeps the queue read before. */}
      {!q.data ? (q.isError ? <ErrorState message={withdrawalWords(q.error)} onRetry={() => void q.refetch()} /> : <Loading />)
        : q.data.items.length === 0 ? <Empty title={t('admin.none')} />
        : (
          <>
            <div className="ws-table-wrap">
              <table className="j-table">
                <caption className="j-sr-only">{t('admin.caption')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('admin.wallet')}</th><th scope="col">{t('admin.asked')}</th><th scope="col">{t('admin.amount')}</th>
                    <th scope="col">{t('admin.toPay')}</th><th scope="col">{t('admin.to')}</th><th scope="col">{t('admin.state')}</th><th scope="col">{t('admin.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {/* Keyed by the withdrawal only: an open confirmation stays (it closes itself on a new version). */}
                  {q.data.items.map((w) => <Row key={w._id} adminId={adminId} w={w} queueKey={queueKey} onDone={setDone} />)}
                </tbody>
              </table>
            </div>
            <CursorPager pages={pages} nextCursor={q.data.nextCursor} label={t('admin.pages')} />
          </>
        )}
    </section>
  );
}

function Row({ adminId, w, queueKey, onDone }: { adminId: string; w: AdminWithdrawal; queueKey: readonly unknown[]; onDone: (words: string) => void }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const [note, setNote] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  const reread = () => queryClient.invalidateQueries({ queryKey: queueKey });
  // WQ29b: the stored "mark paid" request is the row's: when a read shows the withdrawal paid with its reference (or, after a
  // reload, paid at all), it is settled here, whatever the row shows now.
  const paid = useOwnedOp<PendingPaid>(`admin-withdrawal-paid:${adminId}:${w._id}`);
  const stored = paid.op;
  useEffect(() => {
    if (!stored || w.state !== 'paid') return;
    if (stored.restored || !stored.body || w.paid?.reference === stored.body.reference) {
      paid.settle(stored.requestKey);
      setNote({ tone: 'ok', text: t('paid.done', { reference: w.paid?.reference ?? '' }) });
      onDone(t('admin.paidRef', { ref: shortRef(w), amount: formatPaise(w.transferMinor) }));
    }
  }, [stored, w.state, w.paid?.reference]);

  /** Reject (waiting) or void (paid), fenced by the version shown; an unknown outcome is read again. */
  async function act(kind: 'reject' | 'void', reason: string) {
    setNote(null);
    const body = { reason, expectedVersion: w.version };
    try {
      await (kind === 'reject' ? adminWithdrawalsApi(api).reject(w._id, body) : adminWithdrawalsApi(api).void(w._id, body));
      setNote({ tone: 'ok', text: kind === 'reject' ? t('reject.done', { gross: formatPaise(w.grossMinor) }) : t('void.done', { gross: formatPaise(w.grossMinor) }) });
      onDone(t(kind === 'reject' ? 'admin.rejectedRef' : 'admin.voidedRef', { ref: shortRef(w), amount: formatPaise(w.grossMinor) }));
    } catch (err) {
      if (definitelyNotRecorded(err)) throw wordedError(err);
      setNote({ tone: 'warn', text: t('admin.unknown', { error: messageOf(err) }) });
    } finally {
      await reread();
    }
  }

  return (
    <tr>
      <td>{ownerWords(w.walletRef.kind)}<div className="ws-muted">{t('admin.ref', { ref: shortRef(w) })}</div><div><Link to={walletPath(w)}>{t('admin.openWallet')}</Link></div></td>
      <td>{formatDateTime(w.createdAt)}</td>
      <td>{formatPaise(w.grossMinor)}<div className="ws-muted">{w.feeLine}</div></td>
      <td><strong>{formatPaise(w.transferMinor)}</strong></td>
      <td>{w.destination.masked ?? '—'}</td>
      <td>
        <Badge tone={WITHDRAWAL_STATE_TONE[w.state]}>{withdrawalStateWords(w.state)}</Badge>
        {w.paid && <div className="ws-muted">{t('list.paid', { date: w.paid.paidOn, reference: w.paid.reference })}</div>}
        {w.paid?.disputeAcknowledged && <div className="ws-muted">{t('paid.disputeNote', { amount: formatPaise(w.paid.disputedMinor ?? 0) })}</div>}
        {w.reason && <div className="ws-muted">{t('list.reason', { reason: w.reason })}</div>}
      </td>
      <td>
        {note && <Alert tone={note.tone}>{note.text}</Alert>}
        <div className="ws-actions">
          {(w.state === 'requested' || stored) && (
            <MarkPaid w={w} owned={paid} queueKey={queueKey} onPaid={() => onDone(t('admin.paidRef', { ref: shortRef(w), amount: formatPaise(w.transferMinor) }))} />
          )}
          {w.state === 'requested' && (
            <>
              <ConfirmAction label={t('reject.button')} danger reason reasonLabel={t('reject.reason')} confirmLabel={t('reject.confirm')} version={w.version}
                consequence={t('reject.consequence', { gross: formatPaise(w.grossMinor) })} onConfirm={(reason) => act('reject', reason)} />
            </>
          )}
          {w.state === 'paid' && (
            <ConfirmAction label={t('void.button')} danger reason reasonLabel={t('void.reason')} confirmLabel={t('void.confirm')} version={w.version}
              consequence={t('void.consequence', { gross: formatPaise(w.grossMinor) })} onConfirm={(reason) => act('void', reason)} />
          )}
        </div>
      </td>
    </tr>
  );
}

type PendingPaid = Omit<PaidBody, 'requestKey'>;

/** "Mark paid": how it was paid, the bank's reference and the day; then one owned request with its key (held by the row). */
function MarkPaid({ w, owned, queueKey, onPaid }: {
  w: AdminWithdrawal; owned: ReturnType<typeof useOwnedOp<PendingPaid>>; queueKey: readonly unknown[]; onPaid: () => void;
}) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const { perform, busy } = useOneAtATime('withdrawal');
  const { op, send, settle } = owned;
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<PaidMethod>('bank_transfer');
  const [reference, setReference] = useState('');
  const [paidOn, setPaidOn] = useState(() => istToday());
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<{ reference?: string; paidOn?: string }>({});
  const [review, setReview] = useState<PendingPaid | null>(null);
  const [outcome, setOutcome] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  /** WQ48 (r35): refused because a card dispute was recorded since: what was reviewed, to mark paid anyway if the transfer went out. */
  const [disputed, setDisputed] = useState<PendingPaid | null>(null);
  const reread = () => queryClient.invalidateQueries({ queryKey: queueKey });

  function check(e: FormEvent) {
    e.preventDefault();
    const errs = { ...(isPaidReference(reference) ? {} : { reference: t('paid.referenceError') }), ...(/^\d{4}-\d{2}-\d{2}$/.test(paidOn) ? {} : { paidOn: t('paid.onError') }) };
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setReview({ method, reference: reference.trim(), paidOn, ...(note.trim() ? { note: note.trim() } : {}), detailsVersion: w.destination.detailsVersion, expectedVersion: w.version });
  }

  async function sendPaid(p: PendingOp<PendingPaid>) {
    setOutcome(null);
    const r = await perform(() => send(p, (b) => adminWithdrawalsApi(api).paid(w._id, { ...b, requestKey: p.requestKey })));
    if (r.kind === 'stale') return;
    if (r.kind === 'ok') { setOutcome({ tone: 'ok', text: t('paid.done', { reference: p.body.reference }) }); onPaid(); setReview(null); setDisputed(null); setOpen(false); await reread(); return; }
    // WQ48 (r35): a card dispute was recorded on the money it holds: reject it, or, only if the bank transfer already went
    // out, mark it paid acknowledging the dispute (a new request: this one recorded nothing).
    if (r.kind === 'refused' && withdrawalErrorCode(r.error) === 'WITHDRAWAL_LOT_DISPUTED' && !p.body.disputeAcknowledged) {
      setReview(null); setDisputed(p.body); await reread(); return;
    }
    if (r.kind === 'refused') { setReview(null); setDisputed(null); setOutcome({ tone: 'error', text: withdrawalWords(r.error) }); await reread(); }
  }

  if (op && !(busy && op.attempts === 1 && !op.uncertain)) {
    const restored = !!op.restored || !op.body;
    return (
      <CheckPanel label={t('paid.panel')}
        onCheck={async () => {
          const now = await adminWithdrawalsApi(api).get(w._id);
          if (now.state === 'paid' && (restored || now.paid?.reference === op.body.reference)) {
            settle(op.requestKey); setOutcome({ tone: 'ok', text: t('paid.done', { reference: now.paid?.reference ?? '' }) }); onPaid(); await reread(); return null;
          }
          return t('paid.notYet');
        }}
        resend={restored ? undefined : { label: t('paid.resend'), busy, onClick: () => void sendPaid(op).catch((e: unknown) => setOutcome({ tone: 'error', text: withdrawalWords(e) })) }}
        forget={{ label: t('paid.forget'), confirmLabel: t('paid.forgetConfirm'), consequence: t('paid.forgetConsequence'), onForget: () => settle(op.requestKey) }}>
        <Alert tone="warn">{restored ? t('paid.restored') : t('paid.unconfirmed', { error: op.error ?? '' })}</Alert>
      </CheckPanel>
    );
  }
  if (!open) {
    return (
      <>
        {outcome && <Alert tone={outcome.tone}>{outcome.text}</Alert>}
        <Button variant="secondary" onClick={() => { setOutcome(null); setOpen(true); }}>{t('paid.button')}</Button>
      </>
    );
  }
  return (
    <div className="confirm" role="group" aria-label={t('paid.form')}>
      {outcome && <Alert tone={outcome.tone}>{outcome.text}</Alert>}
      {disputed ? (
        <>
          <Alert tone="warn">{t('paid.disputed')}</Alert>
          <div className="confirm-actions">
            <ConfirmAction label={t('paid.wentOut')} danger confirmLabel={t('paid.wentOutConfirm')} disabled={busy}
              consequence={t('paid.wentOutConsequence', { transfer: formatPaise(w.transferMinor), masked: w.destination.masked ?? '—' })}
              onConfirm={() => sendPaid(startOp(newRequestKey(), { ...disputed, disputeAcknowledged: true }))} />
            <Button variant="ghost" disabled={busy} onClick={() => { setDisputed(null); setOpen(false); }}>{t('paid.close')}</Button>
          </div>
        </>
      ) : review ? (
        <>
          <p>{t('paid.consequence', { transfer: formatPaise(w.transferMinor), masked: w.destination.masked ?? '—', date: review.paidOn, reference: review.reference })}</p>
          <div className="confirm-actions">
            <Button busy={busy} onClick={() => void sendPaid(startOp(newRequestKey(), review))}>{t('paid.confirm')}</Button>
            <Button variant="ghost" disabled={busy} onClick={() => setReview(null)}>{t('quote.back')}</Button>
          </div>
        </>
      ) : (
        <form className="rx-form" noValidate onSubmit={check}>
          <fieldset className="ws-checks">
            <legend>{t('paid.method')}</legend>
            <label className="ws-check"><input type="radio" name={`wd-method-${w._id}`} checked={method === 'bank_transfer'} onChange={() => setMethod('bank_transfer')} /> {t('paid.bank')}</label>
            <label className="ws-check"><input type="radio" name={`wd-method-${w._id}`} checked={method === 'upi'} onChange={() => setMethod('upi')} /> {t('paid.upi')}</label>
          </fieldset>
          <TextField label={t('paid.reference')} autoComplete="off" maxLength={64} value={reference} error={errors.reference} onChange={(e) => setReference(e.target.value)} />
          <TextField label={t('paid.on')} type="date" value={paidOn} max={istToday()} error={errors.paidOn} onChange={(e) => setPaidOn(e.target.value)} />
          <TextField label={t('paid.note')} autoComplete="off" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="confirm-actions">
            <Button type="submit">{t('paid.next')}</Button>
            <Button variant="ghost" onClick={() => { setOpen(false); setReview(null); }}>{t('paid.close')}</Button>
          </div>
        </form>
      )}
    </div>
  );
}
