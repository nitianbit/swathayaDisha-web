import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import {
  adminLabWalletApi, asPharmacyWallet, labWalletRefusal, OBJECT_ID_PATTERN, partnerAdminApi, type ApiClient, type LabWalletLot,
} from '@jansetu/api';
import { Alert, Badge, ErrorState, formatDateTime, formatRupees, Loading } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { PageHeading } from '../../PageHeading.tsx';
import { definitelyNotRecorded } from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { useCursorPages, WalletHistory } from '../pharmacy/WalletScreen.tsx';
import { useOneAtATime } from '../finance/finance.tsx';
import { NoSuchRecord } from './accountList.tsx';
import { useAdminScope } from './adminScope.ts';
import { AddMoney, Balance, UncreditedTopups, type AdminTopupTarget } from './PharmacyWalletsScreen.tsx';

/**
 * WQ20 admin: one lab's Jansetu wallet (r13, `/admin/labs/:partnerId/wallet*`), on the admin pharmacy wallet's own pieces:
 * the balance, its hold (`PUT …/freeze`), money added by an admin (`POST …/topup`, Idempotency-Key, at most ₹2,00,000,
 * exact by-key read), the history, the card top-ups (lots) with the existing chargeback (a lab's is flag only), and the
 * card top-ups not credited with the existing "already paid by hand" close.
 */
export function LabWalletAdminScreen() {
  const { partnerId = '' } = useParams();
  const scope = useAdminScope('lab-wallets');
  if (!OBJECT_ID_PATTERN.test(partnerId)) return <NoSuchRecord back="/admin/partners" backLabel="Back to labs and clinics" title="Lab">Open it from the list of labs and clinics.</NoSuchRecord>;
  return <LabWallet key={`${scope.identity}:${partnerId}`} scopeKey={scope.key} partnerId={partnerId.toLowerCase()} />;
}

/** A lab's wallet as the admin credit's target (the shared Add money form). */
function labTarget(api: ApiClient, scopeKey: readonly string[], partnerId: string, name: string): AdminTopupTarget {
  const w = adminLabWalletApi(api);
  return {
    ownerKey: `lab-${partnerId}`, ownerName: name, owner: 'lab', queryKey: [...scopeKey, partnerId], recentKey: [...scopeKey, partnerId, 'entries', 'recent'],
    recent: () => w.entries(partnerId),
    topup: async (body, key) => asPharmacyWallet(await w.topup(partnerId, { amountMinor: body.amount * 100, notes: body.notes }, key)),
    findCredit: async (key) => {
      const exact = await w.topupByKey(partnerId, key);
      return exact.state === 'used' ? { row: exact.row } : { row: null, complete: true, searched: 0, exact: true };
    },
  };
}

function LabWallet({ scopeKey, partnerId }: { scopeKey: readonly string[]; partnerId: string }) {
  const { api } = useSession();
  const w = adminLabWalletApi(api);
  const lab = useQuery({ queryKey: [...scopeKey, partnerId, 'lab'], queryFn: () => partnerAdminApi(api).get(partnerId) });
  const wallet = useQuery({ queryKey: [...scopeKey, partnerId, 'wallet'], queryFn: () => w.wallet(partnerId) });
  const history = useCursorPages();
  const entries = useQuery({ queryKey: [...scopeKey, partnerId, 'entries', history.cursor ?? 'first'], queryFn: () => w.entries(partnerId, history.cursor) });
  const name = lab.data?.name ?? 'this lab';
  const view = wallet.data ? asPharmacyWallet(wallet.data) : null;
  return (
    <>
      <Link className="ws-back" to={`/admin/partners/${partnerId}`}><ArrowLeft size={16} aria-hidden="true" /> Back to {lab.data?.name ?? 'the lab'}</Link>
      <PageHeading title={lab.data ? `Wallet: ${lab.data.name}` : 'Lab wallet'} />
      <section className="ws-section" aria-labelledby="bal-h">
        <h2 id="bal-h">Balance</h2>
        {wallet.isPending ? <Loading label="Loading the wallet…" />
          : wallet.isError ? <ErrorState message={labWalletRefusal(wallet.error).message} onRetry={() => void wallet.refetch()} />
          : (
            <>
              <Balance w={wallet.data.exists === false ? null : view} owner="lab" />
              <Hold scopeKey={scopeKey} partnerId={partnerId} name={name} frozen={wallet.data.frozen} />
            </>
          )}
      </section>
      <section className="ws-section" aria-labelledby="add-h">
        <h2 id="add-h">Add money</h2>
        {lab.data && wallet.isSuccess ? <AddMoney target={labTarget(api, scopeKey, partnerId, lab.data.name)} wallet={view} />
          : lab.isPending || wallet.isPending ? <Loading label="Loading…" /> : <p className="ws-muted">The lab and its wallet must load first.</p>}
      </section>
      <WalletHistory q={entries} notes empty={`Top-ups, admin credits and bookings of ${name} are listed here.`} pager={history.pager(entries.data?.nextCursor)} />
      <Lots scopeKey={scopeKey} partnerId={partnerId} />
      <section className="ws-section" aria-labelledby="uncredited-h">
        <h2 id="uncredited-h">Card top-ups not credited</h2>
        <UncreditedTopups scopeKey={scopeKey} ownerId={partnerId} ownerName={name} owner="lab" />
      </section>
    </>
  );
}

/**
 * Put the wallet on hold (it cannot pay; money can still be added) or release it, with a reason. Setting a state twice
 * changes nothing more, so a lost answer is settled by reading the wallet again.
 */
function Hold({ scopeKey, partnerId, name, frozen }: { scopeKey: readonly string[]; partnerId: string; name: string; frozen: boolean }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const { perform, busy } = useOneAtATime('wallet');
  const [outcome, setOutcome] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const say = (tone: 'ok' | 'warn' | 'error', text: string) => { if (live.current) setOutcome({ tone, text }); };
  const act = (to: boolean, reason: string) => perform(async () => {
    setOutcome(null);
    const done = to ? `The wallet of ${name} is on hold: it cannot pay for bookings; money can still be added.` : `The wallet of ${name} is released.`;
    try {
      await adminLabWalletApi(api).freeze(partnerId, to, reason);
      say('ok', done);
    } catch (err) {
      if (definitelyNotRecorded(err)) say('error', `Not changed: ${labWalletRefusal(err).message}`);
      else {
        const now = await adminLabWalletApi(api).wallet(partnerId).catch(() => null);
        if (now && now.frozen === to) say('ok', done);
        else say('warn', `Not confirmed: ${labWalletRefusal(err).message} The hold shown is what is saved now; try again if it is still needed.`);
      }
    } finally {
      await queryClient.invalidateQueries({ queryKey: [...scopeKey, partnerId] });
    }
  });
  return (
    <>
      {outcome && <Alert tone={outcome.tone}>{outcome.text}</Alert>}
      <div className="ws-actions">
        {frozen ? (
          <ConfirmAction key="release" label="Release the hold" confirmLabel="Yes, release it" reason reasonLabel="Why is the hold released?" disabled={busy}
            consequence={`The wallet of ${name} can pay for bookings again.`} onConfirm={(reason) => act(false, reason)} />
        ) : (
          <ConfirmAction key="hold" label="Put on hold" danger confirmLabel="Yes, put it on hold" reason reasonLabel="Why is the wallet put on hold?" disabled={busy}
            consequence={`The wallet of ${name} cannot pay for bookings until the hold is released. Money can still be added.`} onConfirm={(reason) => act(true, reason)} />
        )}
      </div>
    </>
  );
}

const DISPUTE_LABEL: Readonly<Record<string, string>> = { lost: 'Card dispute recorded' };

/**
 * The lab's card top-ups as lots (newest first, at most 200). The existing chargeback of a lot
 * (`POST /admin/wallet-lots/:lotId/chargeback`): for a lab it only flags the top-up (no money is taken; the lot stops being
 * withdrawable; recovering the money is an admin decision). Repeating it answers the flag again.
 */
function Lots({ scopeKey, partnerId }: { scopeKey: readonly string[]; partnerId: string }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const w = adminLabWalletApi(api);
  const lots = useQuery({ queryKey: [...scopeKey, partnerId, 'lots'], queryFn: () => w.lots(partnerId) });
  const { perform, busy } = useOneAtATime('lot');
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);
  const dispute = (lot: LabWalletLot, reason: string) => perform(async () => {
    setNotice(null);
    try {
      const r = await w.chargebackLot(lot._id, reason);
      setNotice({ tone: 'ok', text: r.replayed ? 'This card dispute was already recorded. Nothing more was changed.'
        : `Card dispute recorded on the ${formatRupees(lot.amountMinor / 100)} top-up. No money was taken from the wallet; that money is no longer withdrawable.` });
    } catch (err) {
      if (definitelyNotRecorded(err)) setNotice({ tone: 'error', text: `Not recorded: ${labWalletRefusal(err).message}` });
      else setNotice({ tone: 'warn', text: `Not confirmed: ${labWalletRefusal(err).message} The list shows what is saved now; recording it again is safe.` });
    } finally {
      await queryClient.invalidateQueries({ queryKey: [...scopeKey, partnerId] });
    }
  });
  return (
    <section className="ws-section" aria-labelledby="lots-h">
      <h2 id="lots-h">Card top-ups</h2>
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {lots.isPending ? <Loading label="Loading card top-ups…" />
        : lots.isError ? <ErrorState message={labWalletRefusal(lots.error).message} onRetry={() => void lots.refetch()} />
        : lots.data.length === 0 ? <p className="ws-muted">No card top-ups yet.</p>
        : (
          <div className="ws-table-wrap">
            <table className="j-table">
              <caption className="j-sr-only">Card top-ups, newest first</caption>
              <thead><tr><th scope="col">Paid</th><th scope="col">Amount</th><th scope="col">Left</th><th scope="col">State</th><th scope="col"><span className="j-sr-only">Dispute</span></th></tr></thead>
              <tbody>
                {lots.data.map((l) => (
                  <tr key={l._id}>
                    <td>{formatDateTime(l.createdAt)}</td>
                    <td>{formatRupees(l.amountMinor / 100)}</td>
                    <td>{formatRupees(l.remainingMinor / 100)}</td>
                    <td>{l.disputeState && DISPUTE_LABEL[l.disputeState] ? <Badge tone="danger">{DISPUTE_LABEL[l.disputeState]}</Badge> : l.closed ? 'Used up' : '—'}</td>
                    <td>
                      {l.disputeState !== 'lost' && (
                        <ConfirmAction label="Record a card dispute" danger reason reasonLabel="What did the bank say?" confirmLabel="Yes, record it" disabled={busy}
                          consequence={`Record that the ${formatRupees(l.amountMinor / 100)} card top-up of ${formatDateTime(l.createdAt)} was disputed and lost? Nothing is taken from the wallet; the money stops being withdrawable. This cannot be undone here.`}
                          onConfirm={(reason) => dispute(l, reason)} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </section>
  );
}
