import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  movementLabel, pharmacyWalletApi, signedPaiseOf, walletBalancePaise, walletState, type PharmacyWallet,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, formatDateTime, formatRupees, Loading } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession } from '../../session.tsx';
import { usePharmacyId } from './ownedOp.tsx';
import { TopUpForm } from './topup.tsx';

/** WQ12: the pharmacy's Jansetu wallet (`GET /pharmacy-wallet`, `/transactions`): balance, hold, history, top-ups. */
export function WalletScreen() {
  const pharmacyId = usePharmacyId();
  return (
    <>
      <PageHeading title="Wallet">
        Your Jansetu wallet pays for consultations you book for patients. Collect the amount from the patient at your counter.
      </PageHeading>
      <Wallet key={pharmacyId} pharmacyId={pharmacyId} />
    </>
  );
}

export function useWallet(pharmacyId: string) {
  const { api } = useSession();
  return useQuery({ queryKey: ['pharmacy-wallet', pharmacyId, 'balance'], queryFn: () => pharmacyWalletApi(api).wallet() });
}

/** The words for a wallet that cannot pay (on hold, owing, switched off), or null. */
export function walletHoldWords(w: PharmacyWallet | undefined): string | null {
  const s = walletState(w);
  if (s === 'owing') {
    return `Your wallet owes ${formatRupees(Number(w?.receivableMinor ?? 0) / 100)} to Jansetu after a disputed card payment. It cannot pay for bookings. The next money added clears this first. Please contact Jansetu support.`;
  }
  if (s === 'frozen') return 'Your wallet is on hold, so it cannot pay for bookings. Money can still be added. Please contact Jansetu support.';
  if (s === 'off') return 'Your wallet is switched off. Please contact Jansetu support.';
  return null;
}

const PAGE_SIZE = 20;

function Wallet({ pharmacyId }: { pharmacyId: string }) {
  const { api } = useSession();
  const wallet = useWallet(pharmacyId);
  const [page, setPage] = useState(1);
  const movements = useQuery({
    queryKey: ['pharmacy-wallet', pharmacyId, 'movements', page],
    queryFn: () => pharmacyWalletApi(api).movements(page, PAGE_SIZE),
  });
  const hold = walletHoldWords(wallet.data);

  return (
    <>
      <section className="ws-section" aria-labelledby="bal-h">
        <h2 id="bal-h">Balance</h2>
        {wallet.isPending ? <Loading label="Loading your wallet…" />
          : wallet.isError ? <ErrorState message={messageOf(wallet.error)} onRetry={() => void wallet.refetch()} />
          : (
            <>
              <dl className="fin-cards" aria-label="Wallet">
                <div className="fin-card fin-card--main"><dt>Money in your wallet</dt><dd>{formatRupees(walletBalancePaise(wallet.data) / 100)}</dd></div>
                {Number(wallet.data?.receivableMinor ?? 0) > 0 && (
                  <div className="fin-card"><dt>Owed to Jansetu</dt><dd>{formatRupees(Number(wallet.data?.receivableMinor) / 100)}</dd></div>
                )}
              </dl>
              {hold && <Alert tone="warn">{hold}</Alert>}
            </>
          )}
      </section>

      <section className="ws-section" aria-labelledby="top-h">
        <h2 id="top-h">Add money</h2>
        <TopUpForm pharmacyId={pharmacyId} />
      </section>

      <section className="ws-section" aria-labelledby="hist-h">
        <h2 id="hist-h">Wallet history</h2>
        {movements.isPending ? <Loading label="Loading wallet history…" />
          : movements.isError ? <ErrorState message={messageOf(movements.error)} onRetry={() => void movements.refetch()} />
          : movements.data.items.length === 0 ? <Empty title="No money in or out yet">Top-ups, booking payments and refunds are listed here.</Empty>
          : (
            <>
              <div className="ws-table-wrap">
                <table className="j-table">
                  <caption className="j-sr-only">Wallet history, newest first</caption>
                  <thead><tr><th scope="col">When</th><th scope="col">What</th><th scope="col">In / out</th><th scope="col">Balance after</th></tr></thead>
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
    </>
  );
}
