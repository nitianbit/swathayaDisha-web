import { useState, type ReactNode } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import {
  doctorWalletApi, movementLabel, pharmacyWalletApi, signedPaiseOf, walletBalancePaise, walletState, type Page, type PharmacyWallet, type WalletMovement,
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
  return usePayerWallet({ kind: 'pharmacy', id: pharmacyId });
}

/** WQ25: whose wallet pays a booking: the pharmacy's (`/pharmacy-wallet`) or a doctor's own (`/specialists/me/assisted/wallet`, WQ23). */
export interface WalletPayer { kind: 'pharmacy' | 'doctor'; id: string }
/** The payer's balance, under the query key its Wallet page reads. */
export function usePayerWallet(payer: WalletPayer) {
  const { api } = useSession();
  return useQuery({
    queryKey: [payer.kind === 'doctor' ? 'doctor-wallet' : 'pharmacy-wallet', payer.id, 'balance'],
    queryFn: (): Promise<PharmacyWallet | null> => (payer.kind === 'doctor' ? doctorWalletApi(api).wallet() : pharmacyWalletApi(api).wallet()),
  });
}

/** The words for a wallet that cannot pay (on hold, owing, switched off), or null. */
export function walletHoldWords(w: PharmacyWallet | null | undefined): string | null {
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

  return (
    <>
      <WalletBalance wallet={wallet} />

      <section className="ws-section" aria-labelledby="top-h">
        <h2 id="top-h">Add money</h2>
        <TopUpForm pharmacyId={pharmacyId} />
      </section>

      <WalletHistory q={movements} empty="Top-ups, booking payments and refunds are listed here." pager={movements.data && movements.data.totalPages > 1 && (
        <nav className="ws-pager" aria-label="Wallet history pages">
          <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Newer</Button>
          <span>Page {page} of {movements.data.totalPages}</span>
          <Button variant="secondary" disabled={page >= movements.data.totalPages} onClick={() => setPage(page + 1)}>Older</Button>
        </nav>
      )} />
    </>
  );
}

/**
 * WQ20: the balance every wallet shows (the pharmacy's and the lab's own): the money in it, what it owes, its hold. A lab's
 * also shows the card money that will be withdrawable once withdrawals exist (O2).
 */
export function WalletBalance({ wallet, cardMoney = false }: { wallet: UseQueryResult<PharmacyWallet | null>; cardMoney?: boolean }) {
  const hold = walletHoldWords(wallet.data ?? undefined);
  return (
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
              {cardMoney && <div className="fin-card"><dt>Card money (withdrawals coming later)</dt><dd>{formatRupees(Number(wallet.data?.withdrawableMinor ?? 0) / 100)}</dd></div>}
            </dl>
            {hold && <Alert tone="warn">{hold}</Alert>}
          </>
        )}
    </section>
  );
}

/** WQ20: the wallet history every wallet screen shows (the table, its states and its pager). */
export function WalletHistory({ q, empty, pager, first = true, notes = false }: {
  /** `pager`: the pharmacy's page numbers, or a lab's `CursorPager`; `first`: on the first page (an empty one says so). */
  q: UseQueryResult<Page<WalletMovement>>; empty: string; pager: ReactNode; first?: boolean; notes?: boolean;
}) {
  return (
    <section className="ws-section" aria-labelledby="hist-h">
      <h2 id="hist-h">Wallet history</h2>
      {q.isPending ? <Loading label="Loading wallet history…" />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : q.data.items.length === 0 && first ? <Empty title="No money in or out yet">{empty}</Empty>
        : (
          <>
            <MovementsTable rows={q.data.items} notes={notes} />
            {pager}
          </>
        )}
    </section>
  );
}

/**
 * WQ20: the wallet history table (newest first) every wallet screen shows: the pharmacy's and the lab's own, and the
 * admin's (`notes`: with the admin credit's note).
 */
export function MovementsTable({ rows, notes = false }: { rows: readonly WalletMovement[]; notes?: boolean }) {
  return (
    <div className="ws-table-wrap">
      <table className="j-table">
        <caption className="j-sr-only">Wallet history, newest first</caption>
        <thead>
          <tr><th scope="col">When</th><th scope="col">What</th>{notes && <th scope="col">Note</th>}<th scope="col">In / out</th><th scope="col">Balance after</th></tr>
        </thead>
        <tbody>
          {rows.map((m) => {
            const signed = signedPaiseOf(m);
            const after = typeof m.balanceAfterPaise === 'number' ? m.balanceAfterPaise / 100 : m.balanceAfter;
            return (
              <tr key={m._id}>
                <td>{formatDateTime(m.createdAt)}</td>
                <td>
                  {movementLabel(m)}
                  {m.status && m.status !== 'completed' && <> <Badge tone="warn">{m.status === 'pending' ? 'Pending' : 'Failed'}</Badge></>}
                </td>
                {notes && <td>{m.notes || '—'}</td>}
                <td>{signed >= 0 ? <span>+{formatRupees(signed / 100)}</span> : <span className="ws-warn-text">−{formatRupees(-signed / 100)}</span>}</td>
                <td>{formatRupees(after)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
