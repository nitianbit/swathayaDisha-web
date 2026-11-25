import { useQuery } from '@tanstack/react-query';
import { hasGlobalScope, holdsAny, LAB_TOPUP_STATE_LABEL, labTopupCheckable, labWalletApi, labWithdrawalsApi, type ApiClient } from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, formatDateTime, formatRupees, Loading } from '@jansetu/ui';
import { useSession } from '../../session.tsx';
import { CHECK_LABEL, ownerTopupSource, TopUpForm, UNPAID_CHECK_AGAIN, useTopupCheck, type TopupSource } from '../pharmacy/topup.tsx';
import { CursorPager, useCursorPages } from '../pharmacy/cursorList.tsx';
import { WalletBalance, WalletHistory } from '../pharmacy/WalletScreen.tsx';
import { WithdrawSection } from '../pharmacy/withdrawals.tsx';
import { LabOnly } from './labs.tsx';
import { NoSuchPartner, PartnerPageHeading, scopeIdentity, usePartnerScope, useWorkspacePartner, type ScopeContext } from './scope.tsx';

/**
 * WQ20: the lab's Jansetu wallet (assisted booking round 2d, backend r13, design §24.13), shown with the pharmacy wallet's
 * own pieces: the balance (with the card money that becomes withdrawable later), "Add money" by Razorpay (a keyed order:
 * `POST /partner-workspace/assisted/wallet/topups`, then verify, else the server's check), the lab's card top-ups as the
 * server lists them (a lost answer is found here and checked), and the history. `wallet.view` reads; `wallet.manage` adds.
 */
export function LabWalletScreen() {
  const ctx = usePartnerScope();
  if (!ctx || ctx.scope.kind !== 'member') return <NoSuchPartner />;
  return <LabWallet key={scopeIdentity(ctx)} ctx={ctx} />;
}

function LabWallet({ ctx }: { ctx: ScopeContext }) {
  const partner = useWorkspacePartner(ctx);
  return (
    <>
      <PartnerPageHeading ctx={ctx} title="Wallet" partnerName={partner.data?.name}>
        Your lab’s Jansetu wallet. Add money by card or UPI; it pays for bookings your lab makes for patients.
      </PartnerPageHeading>
      <LabOnly ctx={ctx}><Wallet ctx={ctx} /></LabOnly>
    </>
  );
}

/**
 * WQ24b: the lab's own wallet: its routes, its query key and its keyed top-up, shared by this page and the wallet pay of
 * Book consultation (one cache, one unconfirmed top-up per lab).
 */
export function labWalletOf(api: ApiClient, ctx: ScopeContext) {
  const w = labWalletApi(api, ctx.scope);
  const queryKey = [...ctx.key, 'lab-wallet'];
  return { w, queryKey, topup: ownerTopupSource(w, 'lab', scopeIdentity(ctx), queryKey) };
}

function Wallet({ ctx }: { ctx: ScopeContext }) {
  const { api } = useSession();
  const { w, queryKey: key, topup: source } = labWalletOf(api, ctx);
  const wallet = useQuery({ queryKey: [...key, 'balance'], queryFn: () => w.wallet() });
  const history = useCursorPages();
  const entries = useQuery({ queryKey: [...key, 'entries', history.cursor], queryFn: () => w.entries(history.cursor || undefined) });
  return (
    <>
      <WalletBalance wallet={wallet} cardMoney />
      {holdsAny(ctx.actor, ['wallet.manage']) && (
        <section className="ws-section" aria-labelledby="top-h">
          <h2 id="top-h">Add money</h2>
          <TopUpForm pharmacyId={source.owner} source={source} />
        </section>
      )}
      <Topups ctx={ctx} source={source} />
      {/* WQ29 (r32): withdrawals to the bank (switched off on the server until allowed); `wallet.manage` asks and cancels. */}
      <WithdrawSection source={{ owner: `lab:${scopeIdentity(ctx)}`, walletKey: key, api: labWithdrawalsApi(api, ctx.scope), canAct: holdsAny(ctx.actor, ['wallet.manage']),
        // WQ29b: the Finance page needs `finance.view` and partner-wide scope (as its page declaration); else ask an owner.
        destination: holdsAny(ctx.actor, ['finance.view']) && hasGlobalScope(ctx.actor) ? { link: '/partner/finance', page: 'finance' } : { askOwner: true } }} />
      <WalletHistory q={entries} empty="Top-ups and bookings paid from the wallet are listed here." first={history.page === 1}
        pager={<CursorPager pages={history} nextCursor={entries.data?.nextCursor} label="Wallet history pages" />} />
    </>
  );
}

/**
 * The lab's card top-ups, newest first (`GET …/wallet/topups`). One that is not paid yet, or paid and not added yet (its
 * answer was lost), is checked with Razorpay by the server: added exactly once if it was paid.
 */
function Topups({ ctx, source }: { ctx: ScopeContext; source: TopupSource }) {
  const { api } = useSession();
  const pages = useCursorPages();
  const list = useQuery({ queryKey: [...source.queryKey, 'topups', pages.cursor], queryFn: () => labWalletApi(api, ctx.scope).topups(pages.cursor || undefined) });
  const { busy, checking, notes, check } = useTopupCheck(source, UNPAID_CHECK_AGAIN);
  return (
    <section className="ws-section" aria-labelledby="topups-h">
      <h2 id="topups-h">Top-ups</h2>
      {list.isPending ? <Loading label="Loading top-ups…" />
        : list.isError ? <ErrorState message={source.refusal(list.error).message} onRetry={() => void list.refetch()} />
        : list.data.items.length === 0 && pages.page === 1 ? <Empty title="No top-ups yet">Money added by card or UPI is listed here.</Empty>
        : (
          <>
            <div className="ws-table-wrap">
              <table className="j-table">
                <caption className="j-sr-only">Top-ups, newest first</caption>
                <thead><tr><th scope="col">Started</th><th scope="col">Amount</th><th scope="col">State</th><th scope="col"><span className="j-sr-only">Check</span></th></tr></thead>
                <tbody>
                  {list.data.items.map((r) => (
                    <tr key={r.paymentTransactionId}>
                      <td>{formatDateTime(r.createdAt)}</td>
                      <td>{formatRupees(r.amountMinor / 100)}</td>
                      <td><Badge tone={r.state === 'credited' ? 'ok' : labTopupCheckable(r.state) ? 'warn' : 'danger'}>{LAB_TOPUP_STATE_LABEL[r.state] ?? r.state}</Badge></td>
                      <td>
                        {labTopupCheckable(r.state) && (
                          <Button variant="secondary" busy={checking === r.paymentTransactionId} disabled={busy && checking !== r.paymentTransactionId}
                            aria-label={`${CHECK_LABEL}: ${formatRupees(r.amountMinor / 100)} of ${formatDateTime(r.createdAt)}`} onClick={() => void check(r.paymentTransactionId, r.amountMinor / 100)}>{CHECK_LABEL}</Button>
                        )}
                        {notes[r.paymentTransactionId] && <Alert tone={notes[r.paymentTransactionId]!.tone}>{notes[r.paymentTransactionId]!.text}</Alert>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <CursorPager pages={pages} nextCursor={list.data.nextCursor} label="Top-up pages" />
          </>
        )}
    </section>
  );
}
