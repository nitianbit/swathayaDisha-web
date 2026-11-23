import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import {
  ADMIN_TOPUP_PAGE_SIZE, ADMIN_TOPUP_WARNING, adminPharmacyWalletApi, ApiError, adminTopupForm, adminTopupRefusal, adminWalletReadError, findAdminTopup,
  latestAdminCredit, MAX_ADMIN_TOPUP_NOTE, movementLabel, topupNotFoundWords, type PendingMarker, type WalletMovement, OBJECT_ID_PATTERN, pharmacyAdminApi, signedPaiseOf, walletBalancePaise, walletState, type AdminTopupBody, type PharmacyWallet,
  CLOSE_COMPENSATED_EXPLAIN, closeCompensatedFinal, closeCompensatedRefusal, closeReasonProblem, closeRefusedBeforeWriting, MAX_CLOSE_REASON, type CompensatedClose, type UncreditedTopup,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, formatDateTime, formatRupees, Loading, TextArea, TextField } from '@jansetu/ui';
import { PageHeading } from '../../PageHeading.tsx';
import { newRequestKey, startOp, type PendingOp } from '../../requests.ts';
import { useSession, useStaff } from '../../session.tsx';
import { useOneAtATime } from '../finance/finance.tsx';
import { CheckPanel, useOwnedOp } from '../pharmacy/ownedOp.tsx';
import { useAdminScope } from './adminScope.ts';
import { PharmacyBadges } from './PharmaciesScreen.tsx';

/**
 * WQ13 admin: pharmacy wallets. Pick a pharmacy (the admin pharmacy list, `GET /pharmacies?name=`), read its wallet and
 * history (`GET /pharmacy-wallet?pharmacyId=`, `/transactions`), and add money by hand (`POST /pharmacy-wallet/topup`
 * with an `Idempotency-Key` from an owned PendingOp made before sending; a lost answer is resent with the same key and
 * the same body, and can be found in the history by that key).
 */
export function PharmacyWalletsScreen() {
  const scope = useAdminScope('pharmacy-wallets');
  return (
    <>
      <PageHeading title="Pharmacy wallets">See a pharmacy’s Jansetu wallet and add money to it (for stage testing or a support credit).</PageHeading>
      <PickPharmacy key={scope.identity} scopeKey={scope.key} />
    </>
  );
}

function PickPharmacy({ scopeKey }: { scopeKey: readonly string[] }) {
  const { api } = useSession();
  const [text, setText] = useState('');
  /** The name searched: page memory only, never the address. */
  const [name, setName] = useState('');
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: [...scopeKey, 'pick', name, page],
    queryFn: () => pharmacyAdminApi(api).list({ ...(name ? { name } : {}), page }),
  });
  const submit = (e: FormEvent) => { e.preventDefault(); setName(text.trim().slice(0, 100)); setPage(1); };
  const last = Math.max(1, list.data?.totalPages ?? 1);
  return (
    <>
      <form className="ws-search" role="search" onSubmit={submit}>
        <TextField label="Find a pharmacy by name" value={text} maxLength={100} onChange={(e) => setText(e.target.value)} />
        <Button type="submit" variant="secondary">Search</Button>
      </form>
      {list.isPending ? <Loading label="Loading pharmacies…" />
        : list.isError ? <ErrorState message={adminWalletReadError(list.error)} onRetry={() => void list.refetch()} />
        : list.data.items.length === 0 ? <Empty title={name ? 'No pharmacies match' : 'No pharmacies yet'}>{name ? 'Try another name.' : 'Add pharmacies under Pharmacies.'}</Empty>
        : (
          <>
            <div className="ws-table-wrap">
              <table className="j-table">
                <caption className="j-sr-only">Pharmacies</caption>
                <thead><tr><th scope="col">Pharmacy</th><th scope="col">City</th><th scope="col">Status</th><th scope="col"><span className="j-sr-only">Wallet</span></th></tr></thead>
                <tbody>
                  {list.data.items.map((p) => (
                    <tr key={p._id}>
                      <td>{p.name}</td>
                      <td>{p.city || '—'}</td>
                      <td><PharmacyBadges p={p} /></td>
                      <td><Link to={`/admin/pharmacy-wallets/${p._id}`} aria-label={`Open the wallet of ${p.name}`}>Open wallet</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {last > 1 && (
              <nav className="ws-pager" aria-label="Pages">
                <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
                <span>Page {page} of {last}</span>
                <Button variant="secondary" disabled={page >= last} onClick={() => setPage(page + 1)}>Next</Button>
              </nav>
            )}
          </>
        )}
    </>
  );
}

/** `/admin/pharmacy-wallets/:pharmacyId`: one pharmacy's wallet, history and the add-money form. */
export function PharmacyWalletScreen() {
  const { pharmacyId = '' } = useParams();
  const scope = useAdminScope('pharmacy-wallets');
  const back = <Link className="ws-back" to="/admin/pharmacy-wallets"><ArrowLeft size={16} aria-hidden="true" /> Pharmacy wallets</Link>;
  if (!OBJECT_ID_PATTERN.test(pharmacyId)) {
    return <>{back}<PageHeading title="Pharmacy wallet" /><Empty title="No such pharmacy">Choose it from the pharmacy wallets list.</Empty></>;
  }
  return <>{back}<WalletDetail key={`${scope.identity}:${pharmacyId}`} scopeKey={scope.key} pharmacyId={pharmacyId.toLowerCase()} /></>;
}

const movementsKey = (scopeKey: readonly string[], pharmacyId: string, page: number) => [...scopeKey, pharmacyId, 'movements', page];

function WalletDetail({ scopeKey, pharmacyId }: { scopeKey: readonly string[]; pharmacyId: string }) {
  const { api } = useSession();
  const wallets = adminPharmacyWalletApi(api);
  const [page, setPage] = useState(1);
  const pharmacy = useQuery({ queryKey: [...scopeKey, pharmacyId, 'pharmacy'], queryFn: () => pharmacyAdminApi(api).get(pharmacyId) });
  const wallet = useQuery({ queryKey: [...scopeKey, pharmacyId, 'wallet'], queryFn: () => wallets.wallet(pharmacyId) });
  const movements = useQuery({ queryKey: movementsKey(scopeKey, pharmacyId, page), queryFn: () => wallets.movements(pharmacyId, page) });
  const name = pharmacy.data?.name ?? 'this pharmacy';

  return (
    <>
      <PageHeading title={pharmacy.data ? `Wallet: ${pharmacy.data.name}` : 'Pharmacy wallet'}>
        {pharmacy.data ? [pharmacy.data.city, pharmacy.data.phone].filter(Boolean).join(' · ') : null}
      </PageHeading>
      {pharmacy.isError && <ErrorState message={adminWalletReadError(pharmacy.error)} onRetry={() => void pharmacy.refetch()} />}

      <section className="ws-section" aria-labelledby="bal-h">
        <h2 id="bal-h">Balance</h2>
        {wallet.isPending ? <Loading label="Loading the wallet…" />
          : wallet.isError ? <ErrorState message={adminWalletReadError(wallet.error)} onRetry={() => void wallet.refetch()} />
          : <Balance w={wallet.data} />}
      </section>

      <section className="ws-section" aria-labelledby="add-h">
        <h2 id="add-h">Add money</h2>
        {pharmacy.data && wallet.isSuccess
          ? <AddMoney scopeKey={scopeKey} pharmacyId={pharmacyId} pharmacyName={pharmacy.data.name} wallet={wallet.data} />
          : pharmacy.isPending || wallet.isPending ? <Loading label="Loading…" /> : <p className="ws-muted">The pharmacy and its wallet must load first.</p>}
      </section>

      <section className="ws-section" aria-labelledby="hist-h">
        <h2 id="hist-h">Recent money in and out</h2>
        {movements.isPending ? <Loading label="Loading the history…" />
          : movements.isError ? <ErrorState message={adminWalletReadError(movements.error)} onRetry={() => void movements.refetch()} />
          : movements.data.items.length === 0 ? <Empty title="No money in or out yet">Top-ups, booking payments, refunds and admin credits of {name} are listed here.</Empty>
          : (
            <>
              <div className="ws-table-wrap">
                <table className="j-table">
                  <caption className="j-sr-only">Wallet history, newest first</caption>
                  <thead><tr><th scope="col">When</th><th scope="col">What</th><th scope="col">Note</th><th scope="col">In / out</th><th scope="col">Balance after</th></tr></thead>
                  <tbody>
                    {movements.data.items.map((m) => {
                      const signed = signedPaiseOf(m);
                      const after = typeof m.balanceAfterPaise === 'number' ? m.balanceAfterPaise / 100 : m.balanceAfter;
                      return (
                        <tr key={m._id}>
                          <td>{formatDateTime(m.createdAt)}</td>
                          <td>
                            {movementLabel(m)}
                            {m.status && m.status !== 'completed' && <> <Badge tone="warn">{m.status === 'pending' ? 'Pending' : 'Failed'}</Badge></>}
                          </td>
                          <td>{m.notes || '—'}</td>
                          <td>{signed >= 0 ? <span>+{formatRupees(signed / 100)}</span> : <span className="ws-warn-text">−{formatRupees(-signed / 100)}</span>}</td>
                          <td>{formatRupees(after)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {movements.data.totalPages > 1 && (
                <nav className="ws-pager" aria-label="Wallet history pages">
                  <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Newer</Button>
                  <span>Page {page} of {movements.data.totalPages}</span>
                  <Button variant="secondary" disabled={page >= movements.data.totalPages} onClick={() => setPage(page + 1)}>Older</Button>
                </nav>
              )}
            </>
          )}
      </section>

      <section className="ws-section" aria-labelledby="uncredited-h">
        <h2 id="uncredited-h">Card top-ups not credited</h2>
        <UncreditedTopups scopeKey={scopeKey} pharmacyId={pharmacyId} pharmacyName={name} />
      </section>
    </>
  );
}

function Balance({ w }: { w: PharmacyWallet | null }) {
  if (!w) return <p>This pharmacy has no wallet yet. It is made when the pharmacy opens its wallet, or when money is added here.</p>;
  const state = walletState(w);
  const owed = Number(w.receivableMinor ?? 0);
  return (
    <>
      <dl className="fin-cards" aria-label="Wallet">
        <div className="fin-card fin-card--main"><dt>Money in the wallet</dt><dd>{formatRupees(walletBalancePaise(w) / 100)}</dd></div>
        {owed > 0 && <div className="fin-card"><dt>Owed to Jansetu</dt><dd>{formatRupees(owed / 100)}</dd></div>}
      </dl>
      {state === 'owing' && <Alert tone="warn">The wallet owes {formatRupees(owed / 100)} to Jansetu after a disputed card payment. It cannot pay for bookings. Money added clears this first.</Alert>}
      {state !== 'owing' && w.frozen === true && <Alert tone="warn">The wallet is on hold{w.frozenReason ? ` (${w.frozenReason})` : ''}, so it cannot pay for bookings. Money can still be added.</Alert>}
      {state === 'off' && <Alert tone="warn">The wallet is switched off.</Alert>}
      {state === 'ok' && <p className="ws-muted"><Badge tone="ok">Can pay for bookings</Badge></p>}
    </>
  );
}

interface PendingTopup { body: AdminTopupBody; pharmacyName: string }

/**
 * The admin credit: amount and note, a review, then one send with an owned PendingOp (its key is the Idempotency-Key).
 * A lost answer stays on screen: send the same request again (same key, same body: never added twice), or find it in
 * the history by its key.
 */
function AddMoney({ scopeKey, pharmacyId, pharmacyName, wallet }: { scopeKey: readonly string[]; pharmacyId: string; pharmacyName: string; wallet: PharmacyWallet | null }) {
  const { api, memory } = useSession();
  const admin = useStaff();
  const queryClient = useQueryClient();
  const wallets = adminPharmacyWalletApi(api);
  const { op, send, settle } = useOwnedOp<PendingTopup>(`admin-wallet-topup:${admin.id}:${pharmacyId}`);
  /**
   * WQ14 W1: the key of an unconfirmed credit, checked (not found so far) and then forgotten (WQ14b M2: any such credit,
   * not only one restored after a reload). It may still be finishing on the server, so the next credit to this pharmacy
   * reuses it: the same body is replayed, another body is 409 IDEMPOTENCY_KEY_REUSED (so it was added), and if it never
   * landed it is added once. WQ14b M1: kept in the pending-marker shape, so it survives a reload or signing in again
   * as an opaque key only (never a body); it has its own slot, so it is never shown as an unconfirmed credit.
   */
  const carrySlot = `admin-wallet-topup-carry:${admin.id}:${pharmacyId}`;
  const carriedKey = () => memory.get<PendingMarker>(carrySlot)?.requestKey;
  const carry = (requestKey: string) => { const now = Date.now(); memory.set<PendingMarker>(carrySlot, { requestKey, attempts: 0, firstAttemptAt: now, lastAttemptAt: now }); };
  const { perform, busy } = useOneAtATime('wallet');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<{ amount?: string; notes?: string }>({});
  const [review, setReview] = useState<({ requestKey: string } & PendingTopup) | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);

  const reread = () => queryClient.invalidateQueries({ queryKey: [...scopeKey, pharmacyId] });
  // Review L6: the newest page of the history, read again when the review opens, for the last admin credit.
  const recent = useQuery({ queryKey: movementsKey(scopeKey, pharmacyId, 1), queryFn: () => wallets.movements(pharmacyId, 1) });
  const lastCredit = latestAdminCredit(recent.data?.items ?? []);
  const added = (body: AdminTopupBody, w: PharmacyWallet | null, again: boolean) => {
    setReview(null);
    setAmount('');
    setNote('');
    setDone(`${formatRupees(body.amount)} was added to the wallet of ${pharmacyName}${w ? `. Balance now: ${formatRupees(walletBalancePaise(w) / 100)}` : ''}.${again ? ' It was added once, even though it was sent more than once.' : ''}`);
    void reread();
  };

  function check(e: FormEvent) {
    e.preventDefault();
    setDone(null);
    setRefused(null);
    const f = adminTopupForm(amount, note);
    setErrors({ amount: f.amount, notes: f.notes });
    if (!f.value) return;
    // The key is made now, with the reviewed body; confirming sends exactly this.
    setReview({ requestKey: carriedKey() ?? newRequestKey(), body: { pharmacyId, ...f.value }, pharmacyName });
    void recent.refetch();
  }

  async function sendTopup(p: PendingOp<PendingTopup>) {
    // WQ14 W1: once sent, the stored request owns a carried key; only a refusal that does not prove the earlier credit
    // (anything but 409 IDEMPOTENCY_KEY_REUSED) gives it back to the next credit.
    const carried = carriedKey() === p.requestKey;
    const r = await perform(() => { if (carried) memory.delete(carrySlot); return send(p, (b) => wallets.topup(b.body, p.requestKey)); });
    if (r.kind === 'stale') return;
    if (r.kind === 'ok') { added(p.body.body, r.value, p.attempts > 0); return; }
    if (r.kind === 'refused') {
      if (carried && !(r.error instanceof ApiError && r.error.code === 'IDEMPOTENCY_KEY_REUSED')) carry(p.requestKey);
      setReview(null); setRefused(adminTopupRefusal(r.error)); void reread();
    }
    // Review L7: the outcome is not known: read the history again (the credit may show there).
    if (r.kind === 'unknown') void reread();
  }

  /**
   * Review M1: the exact by-key read first (backend r7); on an older server, the history, newest first, up to 20 pages and
   * with no time cut-off. Answers the row it made, or what was searched.
   */
  async function findCredit(key: string): Promise<{ row: WalletMovement } | { row: null; complete: boolean; searched: number; exact?: boolean }> {
    const exact = await wallets.topupByKey(pharmacyId, key);
    if (exact.state === 'used') return { row: exact.row };
    if (exact.state === 'none') return { row: null, complete: true, searched: 0, exact: true };
    return findAdminTopup((page) => wallets.movements(pharmacyId, page, ADMIN_TOPUP_PAGE_SIZE), key);
  }

  if (op && !(busy && op.attempts === 1 && !op.uncertain)) {
    const restored = !!op.restored || !op.body;
    return (
      <>
        {resendError && <Alert>{resendError}</Alert>}
        <CheckPanel label="Unconfirmed money added"
          onCheck={async () => {
            const found = await findCredit(op.requestKey);
            void reread();
            if (found.row) {
              // WQ14b L1: a key kept for the next credit is dropped once its credit is found.
              if (carriedKey() === op.requestKey) memory.delete(carrySlot);
              settle(op.requestKey);
              setReview(null);
              setDone(`It was added: ${formatRupees(signedPaiseOf(found.row) / 100)} on ${formatDateTime(found.row.createdAt)}. Nothing was added twice.`);
              return null;
            }
            return topupNotFoundWords(found, !restored);
          }}
          resend={restored ? undefined : {
            label: 'Send the same request again', busy,
            onClick: () => { setResendError(null); void sendTopup(op).catch((err: unknown) => setResendError(adminTopupRefusal(err))); },
          }}
          forget={{ label: 'Forget it', confirmLabel: 'Yes, forget it',
            onForget: () => { carry(op.requestKey); settle(op.requestKey); },
            acknowledge: 'I understand the money may already have been added to this wallet.',
            consequence: 'The money may already have been added, or may still arrive. Forgetting it does not undo it. Check the wallet history, or ask the tech team, before adding money again: otherwise the pharmacy could be paid twice.' }}>
          <Alert tone="warn">
            {restored
              ? 'Money added earlier on this device (before the page was reloaded) was not confirmed. Its details are not kept here. Check the wallet history for it.'
              : `The outcome of this request is not known yet${op.error ? ` (${op.error})` : ''}. ${formatRupees(op.body.body.amount)} may already be added to the wallet of ${op.body.pharmacyName}. Sending the same request again is safe: it is never added twice.`}
          </Alert>
        </CheckPanel>
      </>
    );
  }

  const balance = walletBalancePaise(wallet);
  const owed = Number(wallet?.receivableMinor ?? 0);
  return (
    <form className="rx-form" noValidate onSubmit={check} aria-label="Add money to the wallet">
      <Alert tone="warn">{ADMIN_TOPUP_WARNING}</Alert>
      {done && <Alert tone="ok">{done}</Alert>}
      <fieldset className="ws-frozen" disabled={!!review || busy}>
        <div className="rx-form-row">
          <TextField label="Amount to add (₹)" inputMode="numeric" autoComplete="off" value={amount} error={errors.amount}
            hint="Whole rupees, 1 or more." onChange={(e) => setAmount(e.target.value)} />
        </div>
        <TextArea label="Why is the money added?" value={note} maxLength={MAX_ADMIN_TOPUP_NOTE} error={errors.notes}
          hint="Required. For example “stage testing” or “support credit”. Kept with the credit." onChange={(e) => setNote(e.target.value)} />
      </fieldset>
      {refused && <Alert>Not added: {refused}</Alert>}
      {!review ? (
        <div><Button type="submit">Next: check before adding</Button></div>
      ) : (
        <div className="confirm" role="group" aria-label="Add this money">
          <div className="confirm-text">
            Add <strong>{formatRupees(review.body.amount)}</strong> to the wallet of <strong>{review.pharmacyName}</strong>?
          </div>
          <ul className="ws-list">
            <li>Note: <strong>{review.body.notes}</strong></li>
            <li>
              {recent.isFetching && !recent.data ? 'Reading the last money added by an admin…'
                : lastCredit
                  ? <>Last money added by {String(lastCredit.actor?.id ?? '').toLowerCase() === admin.id.toLowerCase() ? 'you' : 'an admin'}: <strong>{formatRupees(signedPaiseOf(lastCredit) / 100)}</strong> on {formatDateTime(lastCredit.createdAt)}{lastCredit.notes ? ` (“${lastCredit.notes}”)` : ''}. Make sure this is not the same credit.</>
                  : recent.isError ? 'Could not read the last money added by an admin. Look at the history below.'
                  : `No money added by an admin in the latest ${ADMIN_TOPUP_PAGE_SIZE} movements.`}
            </li>
            {owed > 0
              ? <li>{formatRupees(Math.min(owed, review.body.amount * 100) / 100)} of it first clears what the pharmacy owes Jansetu.</li>
              : <li>Balance after: {formatRupees((balance + review.body.amount * 100) / 100)}</li>}
          </ul>
          <span className="ws-muted">{ADMIN_TOPUP_WARNING}</span>
          <div className="confirm-actions">
            <Button busy={busy} onClick={() => {
              const { requestKey, ...pending } = review;
              void sendTopup(startOp(requestKey, pending)).catch((err: unknown) => { setReview(null); setRefused(adminTopupRefusal(err)); });
            }}>Yes, add {formatRupees(review.body.amount)}</Button>
            <Button variant="ghost" disabled={busy} onClick={() => setReview(null)}>Back</Button>
          </div>
        </div>
      )}
    </form>
  );
}

interface PendingClose { row: UncreditedTopup; reason: string }

const UNCREDITED_STATE: Readonly<Record<string, string>> = {
  paid_not_credited: 'Paid, not credited',
  not_checked_with_gateway: 'Not checked with Razorpay',
};
const topupWords = (r: UncreditedTopup) => `${formatRupees(r.amountMinor / 100)} top-up of ${formatDateTime(r.createdAt)}`;

/**
 * WQ15 (backend r9, design §22): the pharmacy's card top-ups that were never credited (`GET /admin/wallet-recharges/uncredited`,
 * its rows only), and "Mark as already paid by hand": a reason, a confirm step, then one send with an owned PendingOp
 * (`POST /admin/wallet-payments/:paymentId/close-compensated {reason, requestKey}`). A lost answer is sent again with the
 * same key and body (the server answers the closure again), or checked by key (`.../close-compensated/by-key/:key`).
 * Closing is once per top-up whatever the key, so forgetting an unconfirmed close is safe: closing again is replayed.
 */
function UncreditedTopups({ scopeKey, pharmacyId, pharmacyName }: { scopeKey: readonly string[]; pharmacyId: string; pharmacyName: string }) {
  const { api } = useSession();
  const admin = useStaff();
  const queryClient = useQueryClient();
  const wallets = adminPharmacyWalletApi(api);
  const list = useQuery({ queryKey: [...scopeKey, pharmacyId, 'uncredited'], queryFn: () => wallets.uncredited(pharmacyId) });
  const { op, send, settle } = useOwnedOp<PendingClose>(`admin-wallet-close:${admin.id}:${pharmacyId}`);
  const { perform, busy } = useOneAtATime('top-up');
  const [chosen, setChosen] = useState<UncreditedTopup | null>(null);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | undefined>();
  const [review, setReview] = useState<({ requestKey: string } & PendingClose) | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);
  const reread = () => queryClient.invalidateQueries({ queryKey: [...scopeKey, pharmacyId] });

  /** `how`: answered to the first send, to a resend of the same request, or found by "Check". */
  const closed = (c: CompensatedClose, row: UncreditedTopup | null, how: 'sent' | 'resent' | 'checked') => {
    setChosen(null);
    setReview(null);
    setReason('');
    const what = `the ${row ? topupWords(row) : `${formatRupees(c.amountPaise / 100)} top-up`}`;
    // WQ15b N2: a replayed answer (this key's earlier attempt, or a close under another key) never claims this admin closed it.
    setDone(how === 'checked' ? `It was closed: ${what} will never be credited to the wallet.`
      : c.replayed ? `This top-up was already closed as paid by hand: ${what} will never be credited to the wallet. Nothing more was changed.`
      : `Marked as already paid by hand: ${what} will never be credited to the wallet.${how === 'resent' ? ' It was closed once, even though it was sent more than once.' : ''}`);
    void reread();
  };
  const refuse = (err: unknown) => { setChosen(null); setReview(null); setRefused(closeCompensatedRefusal(err)); void reread(); };

  function start(row: UncreditedTopup) {
    setDone(null);
    setRefused(null);
    setReview(null);
    setReason('');
    setReasonError(undefined);
    setChosen(row);
  }

  function check(e: FormEvent) {
    e.preventDefault();
    if (!chosen) return;
    const problem = closeReasonProblem(reason);
    setReasonError(problem);
    if (problem) return;
    // The key is made now, with the reviewed body; confirming sends exactly this.
    setReview({ requestKey: newRequestKey(), row: chosen, reason: reason.trim().replace(/\s+/g, ' ') });
  }

  async function sendClose(p: PendingOp<PendingClose>) {
    const sole = p.attempts === 0 && !p.uncertain;
    const r = await perform(() => send(p, (b) => wallets.closeCompensated(b.row.paymentTransactionId, { reason: b.reason, requestKey: p.requestKey })));
    if (r.kind === 'stale') return;
    if (r.kind === 'ok') { closed(r.value, p.body.row, p.attempts > 0 ? 'resent' : 'sent'); return; }
    // The switch or the indexes refused the only attempt before any write; or the top-up can never be closed (credited,
    // blocked, not a top-up), which an earlier attempt that did close it would have been answered as its closure instead.
    if (r.kind === 'unknown' && ((sole && closeRefusedBeforeWriting(r.error)) || closeCompensatedFinal(r.error))) {
      settle(p.requestKey);
      refuse(r.error);
      return;
    }
    if (r.kind === 'refused') { refuse(r.error); return; }
    void reread();
  }

  if (op && !(busy && op.attempts === 1 && !op.uncertain)) {
    const restored = !!op.restored || !op.body;
    return (
      <>
        <p>{CLOSE_COMPENSATED_EXPLAIN}</p>
        {resendError && <Alert>{resendError}</Alert>}
        <CheckPanel label="Unconfirmed close"
          onCheck={async () => {
            const found = await wallets.closeCompensatedByKey(op.requestKey);
            void reread();
            if (found.state === 'closed') {
              settle(op.requestKey);
              closed(found.close, restored ? null : op.body.row, 'checked');
              return null;
            }
            return restored
              ? 'Not closed so far. It may still be on its way. Read the list again in a minute before closing it again.'
              : 'Not closed so far. It may still be on its way. Sending the same request again is safe: it is closed only once.';
          }}
          resend={restored ? undefined : {
            label: 'Send the same request again', busy,
            onClick: () => { setResendError(null); void sendClose(op).catch((err: unknown) => setResendError(closeCompensatedRefusal(err))); },
          }}
          forget={{ label: 'Forget it', confirmLabel: 'Yes, forget it', onForget: () => settle(op.requestKey),
            consequence: 'The top-up may already be closed, or may still be closed. Forgetting it does not undo that. Read the list again before closing it again: a top-up already closed is never closed twice.' }}>
          <Alert tone="warn">
            {restored
              ? 'A top-up marked as already paid by hand earlier on this device (before the page was reloaded) was not confirmed. Its details are not kept here. Check whether it was recorded.'
              : `The outcome of this request is not known yet${op.error ? ` (${op.error})` : ''}. The ${topupWords(op.body.row)} may already be closed. Sending the same request again is safe: it is closed only once.`}
          </Alert>
        </CheckPanel>
      </>
    );
  }

  const rows = list.data ?? [];
  return (
    <>
      <p>{CLOSE_COMPENSATED_EXPLAIN}</p>
      {done && <Alert tone="ok">{done}</Alert>}
      {refused && <Alert>Not closed: {refused}</Alert>}
      {list.isPending ? <Loading label="Loading card top-ups…" />
        : list.isError ? <ErrorState message={adminWalletReadError(list.error)} onRetry={() => void list.refetch()} />
        : rows.length === 0 ? <Empty title="No card top-ups waiting">Card top-ups of {pharmacyName} that were not credited to the wallet are listed here.</Empty>
        : (
          <div className="ws-table-wrap">
            <table className="j-table">
              <caption className="j-sr-only">Card top-ups not credited, oldest first</caption>
              <thead><tr><th scope="col">When</th><th scope="col">Amount</th><th scope="col">State</th><th scope="col">Payment reference</th><th scope="col"><span className="j-sr-only">Action</span></th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.paymentTransactionId}>
                    <td>{formatDateTime(r.createdAt)}</td>
                    <td>{formatRupees(r.amountMinor / 100)}</td>
                    <td><Badge tone={r.state === 'paid_not_credited' ? 'warn' : undefined}>{UNCREDITED_STATE[r.state] ?? r.state}</Badge></td>
                    <td>{r.razorpayOrderId ? `Razorpay order ${r.razorpayOrderId}` : `Record ${r.paymentTransactionId}`}</td>
                    <td>
                      <Button variant="secondary" disabled={busy || (!!review && chosen?.paymentTransactionId !== r.paymentTransactionId)}
                        aria-label={`Mark the ${topupWords(r)} as already paid by hand`} onClick={() => start(r)}>Mark as already paid by hand</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      {chosen && (
        <form className="rx-form" noValidate onSubmit={check} aria-label="Mark as already paid by hand">
          <p>The <strong>{topupWords(chosen)}</strong>{chosen.razorpayOrderId ? ` (Razorpay order ${chosen.razorpayOrderId})` : ''}.</p>
          <fieldset className="ws-frozen" disabled={!!review || busy}>
            <TextArea label="Why is it closed?" value={reason} maxLength={MAX_CLOSE_REASON} error={reasonError}
              hint="Required. For example who at Jansetu support paid the pharmacy, how and when." onChange={(e) => setReason(e.target.value)} />
          </fieldset>
          {!review ? (
            <div className="confirm-actions">
              <Button type="submit">Next: check before closing</Button>
              <Button variant="ghost" onClick={() => setChosen(null)}>Cancel</Button>
            </div>
          ) : (
            <div className="confirm" role="group" aria-label="Close this top-up">
              <div className="confirm-text">
                Mark the <strong>{topupWords(review.row)}</strong> of <strong>{pharmacyName}</strong> as already paid by hand?
              </div>
              <ul className="ws-list">
                <li>Reason: <strong>{review.reason}</strong></li>
                <li>{CLOSE_COMPENSATED_EXPLAIN}</li>
              </ul>
              <div className="confirm-actions">
                <Button busy={busy} onClick={() => {
                  const { requestKey, ...pending } = review;
                  void sendClose(startOp(requestKey, pending)).catch((err: unknown) => refuse(err));
                }}>Yes, mark as already paid</Button>
                <Button variant="ghost" disabled={busy} onClick={() => setReview(null)}>Back</Button>
              </div>
            </div>
          )}
        </form>
      )}
    </>
  );
}
