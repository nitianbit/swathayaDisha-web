import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { holdsAny, LAB_TOPUP_MAX_MINOR, LAB_TOPUP_STATE_LABEL, labTopupCheckable, labWalletApi, labWalletRefusal, type LabTopupRow } from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, formatDateTime, formatRupees, Loading } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { useSession } from '../../session.tsx';
import { useOneAtATime } from '../finance/finance.tsx';
import { CHECK_LABEL, checkTopup, TopUpForm, UNPAID_CHECK_AGAIN, type TopupSource } from '../pharmacy/topup.tsx';
import { PagerNav, useCursorPages, WalletBalance, WalletHistory } from '../pharmacy/WalletScreen.tsx';
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

function Wallet({ ctx }: { ctx: ScopeContext }) {
  const { api } = useSession();
  const w = labWalletApi(api, ctx.scope);
  const key = [...ctx.key, 'lab-wallet'];
  const wallet = useQuery({ queryKey: [...key, 'balance'], queryFn: () => w.wallet() });
  const history = useCursorPages();
  const entries = useQuery({ queryKey: [...key, 'entries', history.cursor], queryFn: () => w.entries(history.cursor) });
  const source: TopupSource = {
    owner: `lab-${scopeIdentity(ctx)}`, queryKey: key, maxRupees: LAB_TOPUP_MAX_MINOR / 100,
    start: (rupees, requestKey) => w.startTopup(Math.round(rupees * 100), requestKey),
    verify: (p) => w.verify(p), check: (id) => w.checkTopup(id), refusal: labWalletRefusal, rememberOnDevice: false,
  };
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
      <WalletHistory q={entries} empty="Top-ups and bookings paid from the wallet are listed here." pager={history.pager(entries.data?.nextCursor)} />
    </>
  );
}

/**
 * The lab's card top-ups, newest first (`GET …/wallet/topups`). One that is not paid yet, or paid and not added yet (its
 * answer was lost), is checked with Razorpay by the server: added exactly once if it was paid.
 */
function Topups({ ctx, source }: { ctx: ScopeContext; source: TopupSource }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const pages = useCursorPages();
  const list = useQuery({ queryKey: [...source.queryKey, 'topups', pages.cursor], queryFn: () => labWalletApi(api, ctx.scope).topups(pages.cursor) });
  const { perform, busy } = useOneAtATime('top-up check');
  const [checking, setChecking] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, { tone: 'ok' | 'warn' | 'error'; text: string }>>({});

  async function check(r: LabTopupRow) {
    setChecking(r.paymentTransactionId);
    try {
      await perform(async () => {
        const outcome = await checkTopup(source, r.paymentTransactionId);
        void queryClient.invalidateQueries({ queryKey: source.queryKey });
        setNotes((n) => ({ ...n, [r.paymentTransactionId]: outcome.kind === 'credited' ? { tone: 'ok', text: `${formatRupees(r.amountMinor / 100)} was added to your wallet.` }
          : outcome.kind === 'closed' ? { tone: 'error', text: outcome.message }
          : outcome.kind === 'unpaid' ? { tone: 'warn', text: UNPAID_CHECK_AGAIN }
          : { tone: 'warn', text: `Could not check just now: ${outcome.message}` } }));
      });
    } catch (err) {
      setNotes((n) => ({ ...n, [r.paymentTransactionId]: { tone: 'error', text: messageOf(err) } }));
    } finally {
      setChecking(null);
    }
  }

  const pager = pages.pager(list.data?.nextCursor);
  return (
    <section className="ws-section" aria-labelledby="topups-h">
      <h2 id="topups-h">Top-ups</h2>
      {list.isPending ? <Loading label="Loading top-ups…" />
        : list.isError ? <ErrorState message={source.refusal(list.error).message} onRetry={() => void list.refetch()} />
        : list.data.items.length === 0 && !pager.newer ? <Empty title="No top-ups yet">Money added by card or UPI is listed here.</Empty>
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
                            aria-label={`${CHECK_LABEL}: ${formatRupees(r.amountMinor / 100)} of ${formatDateTime(r.createdAt)}`} onClick={() => void check(r)}>{CHECK_LABEL}</Button>
                        )}
                        {notes[r.paymentTransactionId] && <Alert tone={notes[r.paymentTransactionId]!.tone}>{notes[r.paymentTransactionId]!.text}</Alert>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <PagerNav pager={pager} label="Top-up pages" />
          </>
        )}
    </section>
  );
}
