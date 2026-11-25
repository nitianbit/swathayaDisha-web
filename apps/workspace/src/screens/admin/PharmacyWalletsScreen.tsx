import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import {
  ADMIN_TOPUP_PAGE_SIZE, adminTopupWarning, adminPharmacyWalletApi, ApiError, adminTopupForm, adminTopupRefusal, adminWalletReadError, findAdminTopup,
  latestAdminCredit, MAX_ADMIN_TOPUP_NOTE, topupNotFoundWords, type PendingMarker, type WalletMovement, OBJECT_ID_PATTERN, pharmacyAdminApi, signedPaiseOf, walletBalancePaise, walletState, type ApiClient, type Page, type PharmacyWallet,
  closeCompensatedExplain, closeCompensatedFinal, closeCompensatedRefusal, closeReasonProblem, closeRefusedBeforeWriting, MAX_CLOSE_REASON, type CompensatedClose, type UncreditedTopup, type WalletOwner,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, formatDateTime, formatRupees, Loading, shared, TextArea, TextField } from '@jansetu/ui';
import { t } from '../../i18n/admin/index.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { newRequestKey, startOp, type PendingOp } from '../../requests.ts';
import { useSession, useStaff } from '../../session.tsx';
import { useOneAtATime } from '../finance/finance.tsx';
import { CheckPanel, useOwnedOp } from '../pharmacy/ownedOp.tsx';
import { MovementsTable } from '../pharmacy/WalletScreen.tsx';
import { useAdminScope } from './adminScope.ts';
import { CardRefundsQueue, notKnownYet } from './CardRefunds.tsx';
import { PharmacyBadges } from './PharmaciesScreen.tsx';
import { Lots } from './walletLots.tsx';

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
      <PageHeading title={t('pharmacyWallets.title')}>{t('pharmacyWallets.intro')}</PageHeading>
      <PickPharmacy key={scope.identity} scopeKey={scope.key} />
      {/* WQ16: card refunds of consultations booked by pharmacies (every pharmacy; the rows do not name one). */}
      <section className="ws-section" aria-labelledby="card-refunds-h">
        <h2 id="card-refunds-h">{t('pharmacyWallets.cardRefunds')}</h2>
        <CardRefundsQueue key={scope.identity} scopeKey={scope.key} />
      </section>
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
        <TextField label={t('pharmacyWallets.findByName')} value={text} maxLength={100} onChange={(e) => setText(e.target.value)} />
        <Button type="submit" variant="secondary">{shared('action.search')}</Button>
      </form>
      {list.isPending ? <Loading label={t('pharmacyWallets.loading')} />
        : list.isError ? <ErrorState message={adminWalletReadError(list.error)} onRetry={() => void list.refetch()} />
        : list.data.items.length === 0 ? (
          <Empty title={name ? t('pharmacyWallets.noneMatch') : t('pharmacyWallets.noneYet')}>
            {name ? t('pharmacyWallets.tryAnother') : t('pharmacyWallets.addUnder')}
          </Empty>
        )
        : (
          <>
            <div className="ws-table-wrap">
              <table className="j-table">
                <caption className="j-sr-only">{t('pharmacyWallets.caption')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('adminWallet.col.pharmacy')}</th><th scope="col">{t('pharmacyWallets.col.city')}</th><th scope="col">{t('common.status')}</th>
                    <th scope="col"><span className="j-sr-only">{t('pharmacyWallets.col.wallet')}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.map((p) => (
                    <tr key={p._id}>
                      <td>{p.name}</td>
                      <td>{p.city || '—'}</td>
                      <td><PharmacyBadges p={p} /></td>
                      <td><Link to={`/admin/pharmacy-wallets/${p._id}`} aria-label={t('pharmacyWallets.openAria', { name: p.name })}>{t('pharmacyWallets.open')}</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {last > 1 && (
              <nav className="ws-pager" aria-label={t('common.pages')}>
                <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>{t('common.previous')}</Button>
                <span>{t('common.pageOf', { page, lastPage: last })}</span>
                <Button variant="secondary" disabled={page >= last} onClick={() => setPage(page + 1)}>{t('common.next')}</Button>
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
  const back = <Link className="ws-back" to="/admin/pharmacy-wallets"><ArrowLeft size={16} aria-hidden="true" /> {t('pharmacyWallets.title')}</Link>;
  if (!OBJECT_ID_PATTERN.test(pharmacyId)) {
    return <>{back}<PageHeading title={t('pharmacyWallet.title')} /><Empty title={t('pharmacyWallet.noSuch')}>{t('pharmacyWallet.noSuchText')}</Empty></>;
  }
  return <>{back}<WalletDetail key={`${scope.identity}:${pharmacyId}`} scopeKey={scope.key} pharmacyId={pharmacyId.toLowerCase()} /></>;
}

/** The wallet owner of these pages (a code, not words). */
const PHARMACY: WalletOwner = 'pharmacy';
const movementsKey = (scopeKey: readonly string[], pharmacyId: string, page: number) => [...scopeKey, pharmacyId, 'movements', page];

function WalletDetail({ scopeKey, pharmacyId }: { scopeKey: readonly string[]; pharmacyId: string }) {
  const { api } = useSession();
  const wallets = adminPharmacyWalletApi(api);
  const [page, setPage] = useState(1);
  const pharmacy = useQuery({ queryKey: [...scopeKey, pharmacyId, 'pharmacy'], queryFn: () => pharmacyAdminApi(api).get(pharmacyId) });
  const wallet = useQuery({ queryKey: [...scopeKey, pharmacyId, 'wallet'], queryFn: () => wallets.wallet(pharmacyId) });
  const movements = useQuery({ queryKey: movementsKey(scopeKey, pharmacyId, page), queryFn: () => wallets.movements(pharmacyId, page) });
  const name = pharmacy.data?.name ?? t('pharmacyWallet.thisPharmacy');

  return (
    <>
      <PageHeading title={pharmacy.data ? t('adminWallet.titleNamed', { name: pharmacy.data.name }) : t('pharmacyWallet.title')}>
        {pharmacy.data ? [pharmacy.data.city, pharmacy.data.phone].filter(Boolean).join(' · ') : null}
      </PageHeading>
      {pharmacy.isError && <ErrorState message={adminWalletReadError(pharmacy.error)} onRetry={() => void pharmacy.refetch()} />}

      <section className="ws-section" aria-labelledby="bal-h">
        <h2 id="bal-h">{t('adminWallet.balance')}</h2>
        {wallet.isPending ? <Loading label={t('adminWallet.loadingWallet')} />
          : wallet.isError ? <ErrorState message={adminWalletReadError(wallet.error)} onRetry={() => void wallet.refetch()} />
          : <Balance w={wallet.data} owner={PHARMACY} />}
      </section>

      <section className="ws-section" aria-labelledby="add-h">
        <h2 id="add-h">{t('adminWallet.addMoney')}</h2>
        {pharmacy.data && wallet.isSuccess
          ? <AddMoney target={pharmacyTarget(api, scopeKey, pharmacyId, pharmacy.data.name)} wallet={wallet.data} />
          : pharmacy.isPending || wallet.isPending ? <Loading label={shared('state.loading')} /> : <p className="ws-muted">{t('adminWallet.mustLoad.pharmacy')}</p>}
      </section>

      <section className="ws-section" aria-labelledby="hist-h">
        <h2 id="hist-h">{t('pharmacyWallet.history')}</h2>
        {movements.isPending ? <Loading label={t('pharmacyWallet.loadingHistory')} />
          : movements.isError ? <ErrorState message={adminWalletReadError(movements.error)} onRetry={() => void movements.refetch()} />
          : movements.data.items.length === 0 ? <Empty title={t('pharmacyWallet.noMovements')}>{t('pharmacyWallet.noMovementsText', { name })}</Empty>
          : (
            <>
              <MovementsTable rows={movements.data.items} notes />
              {movements.data.totalPages > 1 && (
                <nav className="ws-pager" aria-label={t('adminWallet.historyPages')}>
                  <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>{t('pharmacyWallet.newer')}</Button>
                  <span>{t('common.pageOf', { page, lastPage: movements.data.totalPages })}</span>
                  <Button variant="secondary" disabled={page >= movements.data.totalPages} onClick={() => setPage(page + 1)}>{t('pharmacyWallet.older')}</Button>
                </nav>
              )}
            </>
          )}
      </section>

      {/* WQ29 (r32): the pharmacy's card top-ups with the dispute and Recover; WQ29b (r32b): its dispute takes the money at once. */}
      <Lots load={() => wallets.lots(pharmacyId)} refusal={(err) => ({ kind: 'other', message: adminWalletReadError(err) })}
        queryKey={[...scopeKey, pharmacyId, 'lots']} changed={[...scopeKey, pharmacyId]} takesNow />

      <section className="ws-section" aria-labelledby="uncredited-h">
        <h2 id="uncredited-h">{t('adminWallet.uncredited')}</h2>
        <UncreditedTopups scopeKey={scopeKey} ownerId={pharmacyId} ownerName={name} owner={PHARMACY} />
      </section>
    </>
  );
}

/** WQ20: a pharmacy's, a lab's or (WQ23) a doctor's wallet as an admin sees it (`owner` names it). */
export function Balance({ w, owner }: { w: PharmacyWallet | null; owner: WalletOwner }) {
  if (!w) {
    // r20: reading a doctor's wallet makes none; the first money added (by the doctor or here) does.
    return <p>{t(`adminWallet.noWallet.${owner}`)}</p>;
  }
  const state = walletState(w);
  const owed = Number(w.receivableMinor ?? 0);
  return (
    <>
      <dl className="fin-cards" aria-label={t('adminWallet.cards')}>
        <div className="fin-card fin-card--main"><dt>{t('adminWallet.moneyIn')}</dt><dd>{formatRupees(walletBalancePaise(w) / 100)}</dd></div>
        {owed > 0 && <div className="fin-card"><dt>{t('adminWallet.owed')}</dt><dd>{formatRupees(owed / 100)}</dd></div>}
        {owner !== 'pharmacy' && <div className="fin-card"><dt>{t('adminWallet.cardMoney')}</dt><dd>{formatRupees(Number(w.withdrawableMinor ?? 0) / 100)}</dd></div>}
      </dl>
      {state === 'owing' && <Alert tone="warn">{t('adminWallet.owing', { amount: formatRupees(owed / 100) })}</Alert>}
      {state !== 'owing' && w.frozen === true && (
        <Alert tone="warn">{w.frozenReason ? t('adminWallet.onHoldReason', { reason: w.frozenReason }) : t('adminWallet.onHold')}</Alert>
      )}
      {state === 'off' && <Alert tone="warn">{t('adminWallet.off')}</Alert>}
      {state === 'ok' && <p className="ws-muted"><Badge tone="ok">{t('adminWallet.canPay')}</Badge></p>}
    </>
  );
}

/** What an admin credit sends, and to whom (the name shown). */
interface PendingTopup { body: { amount: number; notes: string }; pharmacyName: string }

/**
 * WQ20: the wallet an admin adds money to: a pharmacy's (`/pharmacy-wallet/topup`) or a lab's (`/admin/labs/:id/wallet/topup`).
 * Both are once per Idempotency-Key with an exact by-key read; the same form, review, resend and check serve both.
 */
export interface AdminTopupTarget {
  /** The memory slots' owner part (a pharmacy's id as before; a lab's `lab-<id>`). */
  ownerKey: string;
  ownerName: string;
  owner: WalletOwner;
  /** Read again after every answer. */
  queryKey: readonly unknown[];
  /** The newest history page (for the last admin credit on the review). */
  recentKey: readonly unknown[];
  recent: () => Promise<Page<WalletMovement>>;
  topup: (body: { amount: number; notes: string }, key: string) => Promise<PharmacyWallet | null>;
  findCredit: (key: string) => Promise<{ row: WalletMovement } | { row: null; complete: boolean; searched: number; exact?: boolean }>;
}

/** WQ13/WQ14: a pharmacy's wallet as the credit's target (unchanged routes, slots and fallback search). */
function pharmacyTarget(api: ApiClient, scopeKey: readonly string[], pharmacyId: string, pharmacyName: string): AdminTopupTarget {
  const wallets = adminPharmacyWalletApi(api);
  return {
    ownerKey: pharmacyId, ownerName: pharmacyName, owner: 'pharmacy', queryKey: [...scopeKey, pharmacyId], recentKey: movementsKey(scopeKey, pharmacyId, 1),
    recent: () => wallets.movements(pharmacyId, 1),
    topup: (body, key) => wallets.topup({ pharmacyId, ...body }, key),
    // Review M1: the exact by-key read first (backend r7); on an older server, the history, newest first, up to 20 pages.
    findCredit: async (key) => {
      const exact = await wallets.topupByKey(pharmacyId, key);
      if (exact.state === 'used') return { row: exact.row };
      if (exact.state === 'none') return { row: null, complete: true, searched: 0, exact: true };
      return findAdminTopup((page) => wallets.movements(pharmacyId, page, ADMIN_TOPUP_PAGE_SIZE), key);
    },
  };
}

/**
 * The admin credit: amount and note, a review, then one send with an owned PendingOp (its key is the Idempotency-Key).
 * A lost answer stays on screen: send the same request again (same key, same body: never added twice), or find it by its
 * key.
 */
export function AddMoney({ target, wallet }: { target: AdminTopupTarget; wallet: PharmacyWallet | null }) {
  const { memory } = useSession();
  const admin = useStaff();
  const queryClient = useQueryClient();
  const { ownerKey, ownerName: pharmacyName } = target;
  const { op, send, settle } = useOwnedOp<PendingTopup>(`admin-wallet-topup:${admin.id}:${ownerKey}`);
  /**
   * WQ14 W1: the key of an unconfirmed credit, checked (not found so far) and then forgotten (WQ14b M2: any such credit,
   * not only one restored after a reload). It may still be finishing on the server, so the next credit to this wallet
   * reuses it: the same body is replayed, another body is 409 IDEMPOTENCY_KEY_REUSED (so it was added), and if it never
   * landed it is added once. WQ14b M1: kept in the pending-marker shape, so it survives a reload or signing in again
   * as an opaque key only (never a body); it has its own slot, so it is never shown as an unconfirmed credit.
   */
  const carrySlot = `admin-wallet-topup-carry:${admin.id}:${ownerKey}`;
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

  const reread = () => queryClient.invalidateQueries({ queryKey: target.queryKey });
  // Review L6: the newest page of the history, read again when the review opens, for the last admin credit.
  const recent = useQuery({ queryKey: target.recentKey, queryFn: target.recent });
  const lastCredit = latestAdminCredit(recent.data?.items ?? []);
  const added = (body: PendingTopup['body'], w: PharmacyWallet | null, again: boolean) => {
    setReview(null);
    setAmount('');
    setNote('');
    const amount = formatRupees(body.amount);
    const first = w ? t('adminWallet.add.doneBalance', { amount, name: pharmacyName, balance: formatRupees(walletBalancePaise(w) / 100) })
      : t('adminWallet.add.done', { amount, name: pharmacyName });
    setDone(again ? `${first} ${t('adminWallet.add.once')}` : first);
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
    setReview({ requestKey: carriedKey() ?? newRequestKey(), body: { ...f.value }, pharmacyName });
    void recent.refetch();
  }

  async function sendTopup(p: PendingOp<PendingTopup>) {
    // WQ14 W1: once sent, the stored request owns a carried key; only a refusal that does not prove the earlier credit
    // (anything but 409 IDEMPOTENCY_KEY_REUSED) gives it back to the next credit.
    const carried = carriedKey() === p.requestKey;
    const r = await perform(() => { if (carried) memory.delete(carrySlot); return send(p, (b) => target.topup(b.body, p.requestKey)); });
    if (r.kind === 'stale') return;
    if (r.kind === 'ok') { added(p.body.body, r.value, p.attempts > 0); return; }
    if (r.kind === 'refused') {
      if (carried && !(r.error instanceof ApiError && r.error.code === 'IDEMPOTENCY_KEY_REUSED')) carry(p.requestKey);
      setReview(null); setRefused(adminTopupRefusal(r.error)); void reread();
    }
    // Review L7: the outcome is not known: read the history again (the credit may show there).
    if (r.kind === 'unknown') void reread();
  }

  if (op && !(busy && op.attempts === 1 && !op.uncertain)) {
    const restored = !!op.restored || !op.body;
    return (
      <>
        {resendError && <Alert>{resendError}</Alert>}
        <CheckPanel label={t('adminWallet.add.unconfirmed')}
          onCheck={async () => {
            const found = await target.findCredit(op.requestKey);
            void reread();
            if (found.row) {
              // WQ14b L1: a key kept for the next credit is dropped once its credit is found.
              if (carriedKey() === op.requestKey) memory.delete(carrySlot);
              settle(op.requestKey);
              setReview(null);
              setDone(t('adminWallet.add.found', { amount: formatRupees(signedPaiseOf(found.row) / 100), date: formatDateTime(found.row.createdAt) }));
              return null;
            }
            return topupNotFoundWords(found, !restored);
          }}
          resend={restored ? undefined : {
            label: shared('action.sendAgain'), busy,
            onClick: () => { setResendError(null); void sendTopup(op).catch((err: unknown) => setResendError(adminTopupRefusal(err))); },
          }}
          forget={{ label: t('adminWallet.forget'), confirmLabel: t('adminWallet.forgetConfirm'),
            onForget: () => { carry(op.requestKey); settle(op.requestKey); },
            acknowledge: t('adminWallet.add.acknowledge'),
            consequence: t(`adminWallet.add.forget.${target.owner}`) }}>
          <Alert tone="warn">
            {restored
              ? t('adminWallet.add.restored')
              : `${notKnownYet(op.error)} ${t('adminWallet.add.mayBeAdded', { amount: formatRupees(op.body.body.amount), name: op.body.pharmacyName })}`}
          </Alert>
        </CheckPanel>
      </>
    );
  }

  const balance = walletBalancePaise(wallet);
  const owed = Number(wallet?.receivableMinor ?? 0);
  return (
    <form className="rx-form" noValidate onSubmit={check} aria-label={t('adminWallet.add.form')}>
      <Alert tone="warn">{adminTopupWarning(target.owner)}</Alert>
      {done && <Alert tone="ok">{done}</Alert>}
      <fieldset className="ws-frozen" disabled={!!review || busy}>
        <div className="rx-form-row">
          <TextField label={t('adminWallet.add.amount')} inputMode="numeric" autoComplete="off" value={amount} error={errors.amount}
            hint={t('adminWallet.add.amountHint')} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <TextArea label={t('adminWallet.add.why')} value={note} maxLength={MAX_ADMIN_TOPUP_NOTE} error={errors.notes}
          hint={t('adminWallet.add.whyHint')} onChange={(e) => setNote(e.target.value)} />
      </fieldset>
      {refused && <Alert>{t('adminWallet.add.notAdded', { reason: refused })}</Alert>}
      {!review ? (
        <div><Button type="submit">{t('adminWallet.add.next')}</Button></div>
      ) : (
        <div className="confirm" role="group" aria-label={t('adminWallet.add.review')}>
          <div className="confirm-text">
            {t.rich('adminWallet.add.question', {
              amount: <strong key="a">{formatRupees(review.body.amount)}</strong>, name: <strong key="n">{review.pharmacyName}</strong>,
            })}
          </div>
          <ul className="ws-list">
            <li>{t.rich('adminWallet.add.note', { note: <strong key="n">{review.body.notes}</strong> })}</li>
            <li>
              {recent.isFetching && !recent.data ? t('adminWallet.add.readingLast')
                : lastCredit ? <LastCredit row={lastCredit} mine={String(lastCredit.actor?.id ?? '').toLowerCase() === admin.id.toLowerCase()} />
                  : recent.isError ? t('adminWallet.add.lastUnread')
                  : t('adminWallet.add.noneLatest', { size: ADMIN_TOPUP_PAGE_SIZE })}
            </li>
            {owed > 0
              ? <li>{t(`adminWallet.add.clears.${target.owner}`, { amount: formatRupees(Math.min(owed, review.body.amount * 100) / 100) })}</li>
              : <li>{t('adminWallet.add.balanceAfter', { amount: formatRupees((balance + review.body.amount * 100) / 100) })}</li>}
          </ul>
          <span className="ws-muted">{adminTopupWarning(target.owner)}</span>
          <div className="confirm-actions">
            <Button busy={busy} onClick={() => {
              const { requestKey, ...pending } = review;
              void sendTopup(startOp(requestKey, pending)).catch((err: unknown) => { setReview(null); setRefused(adminTopupRefusal(err)); });
            }}>{t('adminWallet.add.confirm', { amount: formatRupees(review.body.amount) })}</Button>
            <Button variant="ghost" disabled={busy} onClick={() => setReview(null)}>{shared('action.back')}</Button>
          </div>
        </div>
      )}
    </form>
  );
}

/** The last money an admin added to this wallet, on the review (`mine`: added by the admin signed in). */
function LastCredit({ row, mine }: { row: WalletMovement; mine: boolean }) {
  const params = { amount: <strong key="a">{formatRupees(signedPaiseOf(row) / 100)}</strong>, date: formatDateTime(row.createdAt) };
  if (row.notes) return <>{t.rich(mine ? 'adminWallet.add.lastByYouNote' : 'adminWallet.add.lastByAdminNote', { ...params, note: row.notes })}</>;
  return <>{t.rich(mine ? 'adminWallet.add.lastByYou' : 'adminWallet.add.lastByAdmin', params)}</>;
}

interface PendingClose { row: UncreditedTopup; reason: string }

/** An uncredited top-up's state in words (`adminWallet.uncreditedState.<state>`); an unknown state shows as sent. */
const uncreditedState = (state: string) => { const key = `adminWallet.uncreditedState.${state}`; return t.has(key) ? t(key) : state; };
const topupWords = (r: UncreditedTopup) => t('adminWallet.topup', { amount: formatRupees(r.amountMinor / 100), date: formatDateTime(r.createdAt) });

/**
 * WQ15 (backend r9, design §22): the pharmacy's card top-ups that were never credited (`GET /admin/wallet-recharges/uncredited`,
 * its rows only), and "Mark as already paid by hand": a reason, a confirm step, then one send with an owned PendingOp
 * (`POST /admin/wallet-payments/:paymentId/close-compensated {reason, requestKey}`). A lost answer is sent again with the
 * same key and body (the server answers the closure again), or checked by key (`.../close-compensated/by-key/:key`).
 * Closing is once per top-up whatever the key, so forgetting an unconfirmed close is safe: closing again is replayed.
 */
export function UncreditedTopups({ scopeKey, ownerId: pharmacyId, ownerName: pharmacyName, owner }: {
  scopeKey: readonly string[]; ownerId: string; ownerName: string; owner: WalletOwner;
}) {
  const { api } = useSession();
  const admin = useStaff();
  const queryClient = useQueryClient();
  const wallets = adminPharmacyWalletApi(api);
  const list = useQuery({ queryKey: [...scopeKey, pharmacyId, 'uncredited'], queryFn: () => wallets.uncredited(pharmacyId) });
  const { op, send, settle } = useOwnedOp<PendingClose>(`admin-wallet-close:${admin.id}:${pharmacyId}`);
  const { perform, busy } = useOneAtATime('topup');
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
    const what = { topup: row ? topupWords(row) : t('adminWallet.topupAmount', { amount: formatRupees(c.amountPaise / 100) }) };
    // WQ15b N2: a replayed answer (this key's earlier attempt, or a close under another key) never claims this admin closed it.
    setDone(how === 'checked' ? t('adminWallet.close.checked', what)
      : c.replayed ? t('adminWallet.close.replayed', what)
      : `${t('adminWallet.close.done', what)}${how === 'resent' ? ` ${t('adminWallet.close.once')}` : ''}`);
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
    const problem = closeReasonProblem(reason, owner);
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
        <p>{closeCompensatedExplain(owner)}</p>
        {resendError && <Alert>{resendError}</Alert>}
        <CheckPanel label={t('adminWallet.close.unconfirmed')}
          onCheck={async () => {
            const found = await wallets.closeCompensatedByKey(op.requestKey);
            void reread();
            if (found.state === 'closed') {
              settle(op.requestKey);
              closed(found.close, restored ? null : op.body.row, 'checked');
              return null;
            }
            return restored
              ? t('adminWallet.close.notYetRestored')
              : t('adminWallet.close.notYet');
          }}
          resend={restored ? undefined : {
            label: shared('action.sendAgain'), busy,
            onClick: () => { setResendError(null); void sendClose(op).catch((err: unknown) => setResendError(closeCompensatedRefusal(err))); },
          }}
          forget={{ label: t('adminWallet.forget'), confirmLabel: t('adminWallet.forgetConfirm'), onForget: () => settle(op.requestKey),
            consequence: t('adminWallet.close.forget') }}>
          <Alert tone="warn">
            {restored
              ? t('adminWallet.close.restored')
              : `${notKnownYet(op.error)} ${t('adminWallet.close.mayBeClosed', { topup: topupWords(op.body.row) })}`}
          </Alert>
        </CheckPanel>
      </>
    );
  }

  const rows = list.data ?? [];
  return (
    <>
      <p>{closeCompensatedExplain(owner)}</p>
      {done && <Alert tone="ok">{done}</Alert>}
      {refused && <Alert>{t('adminWallet.close.notClosed', { reason: refused })}</Alert>}
      {list.isPending ? <Loading label={t('adminWallet.loadingTopups')} />
        : list.isError ? <ErrorState message={adminWalletReadError(list.error)} onRetry={() => void list.refetch()} />
        : rows.length === 0 ? <Empty title={t('adminWallet.close.empty')}>{t('adminWallet.close.emptyText', { name: pharmacyName })}</Empty>
        : (
          <div className="ws-table-wrap">
            <table className="j-table">
              <caption className="j-sr-only">{t('adminWallet.close.caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('adminWallet.col.when')}</th><th scope="col">{t('common.amount')}</th><th scope="col">{t('adminWallet.col.state')}</th>
                  <th scope="col">{t('adminWallet.close.col.reference')}</th><th scope="col"><span className="j-sr-only">{t('common.action')}</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.paymentTransactionId}>
                    <td>{formatDateTime(r.createdAt)}</td>
                    <td>{formatRupees(r.amountMinor / 100)}</td>
                    <td><Badge tone={r.state === 'paid_not_credited' ? 'warn' : undefined}>{uncreditedState(r.state)}</Badge></td>
                    <td>{r.razorpayOrderId ? t('adminWallet.close.razorpayOrder', { id: r.razorpayOrderId }) : t('adminWallet.close.record', { id: r.paymentTransactionId })}</td>
                    <td>
                      <Button variant="secondary" disabled={busy || (!!review && chosen?.paymentTransactionId !== r.paymentTransactionId)}
                        aria-label={t('adminWallet.close.markAria', { topup: topupWords(r) })} onClick={() => start(r)}>{t('adminWallet.close.mark')}</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      {chosen && (
        <form className="rx-form" noValidate onSubmit={check} aria-label={t('adminWallet.close.mark')}>
          <p>
            {chosen.razorpayOrderId
              ? t.rich('adminWallet.close.chosenOrder', { topup: <strong key="t">{topupWords(chosen)}</strong>, order: chosen.razorpayOrderId })
              : t.rich('adminWallet.close.chosen', { topup: <strong key="t">{topupWords(chosen)}</strong> })}
          </p>
          <fieldset className="ws-frozen" disabled={!!review || busy}>
            <TextArea label={t('adminWallet.close.why')} value={reason} maxLength={MAX_CLOSE_REASON} error={reasonError}
              hint={t(`adminWallet.close.whyHint.${owner}`)} onChange={(e) => setReason(e.target.value)} />
          </fieldset>
          {!review ? (
            <div className="confirm-actions">
              <Button type="submit">{t('adminWallet.close.next')}</Button>
              <Button variant="ghost" onClick={() => setChosen(null)}>{shared('action.cancel')}</Button>
            </div>
          ) : (
            <div className="confirm" role="group" aria-label={t('adminWallet.close.review')}>
              <div className="confirm-text">
                {t.rich('adminWallet.close.question', { topup: <strong key="t">{topupWords(review.row)}</strong>, name: <strong key="n">{pharmacyName}</strong> })}
              </div>
              <ul className="ws-list">
                <li>{t.rich('adminWallet.reasonIs', { reason: <strong key="r">{review.reason}</strong> })}</li>
                <li>{closeCompensatedExplain(owner)}</li>
              </ul>
              <div className="confirm-actions">
                <Button busy={busy} onClick={() => {
                  const { requestKey, ...pending } = review;
                  void sendClose(startOp(requestKey, pending)).catch((err: unknown) => refuse(err));
                }}>{t('adminWallet.close.confirm')}</Button>
                <Button variant="ghost" disabled={busy} onClick={() => setReview(null)}>{shared('action.back')}</Button>
              </div>
            </div>
          )}
        </form>
      )}
    </>
  );
}

