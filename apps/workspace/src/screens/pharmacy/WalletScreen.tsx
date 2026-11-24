import { useState } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import {
  movementLabel, pharmacyWalletApi, signedPaiseOf, walletBalancePaise, walletState, type Page, type PharmacyWallet, type WalletMovement,
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

      <WalletHistory q={movements} empty="Top-ups, booking payments and refunds are listed here."
        pager={{ label: `Page ${page} of ${movements.data?.totalPages ?? 1}`, newer: page > 1 ? () => setPage(page - 1) : null,
          older: page < (movements.data?.totalPages ?? 1) ? () => setPage(page + 1) : null }} />
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

/** Newer / older through a wallet's history (page numbers for the pharmacy, cursors for a lab). */
export interface HistoryPager { label: string; newer: (() => void) | null; older: (() => void) | null }

/** WQ20: the wallet history every wallet screen shows (the table, its states and its pager). */
export function WalletHistory({ q, empty, pager, notes = false }: {
  q: UseQueryResult<Page<WalletMovement>>; empty: string; pager: HistoryPager; notes?: boolean;
}) {
  return (
    <section className="ws-section" aria-labelledby="hist-h">
      <h2 id="hist-h">Wallet history</h2>
      {q.isPending ? <Loading label="Loading wallet history…" />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : q.data.items.length === 0 && !pager.newer ? <Empty title="No money in or out yet">{empty}</Empty>
        : (
          <>
            <MovementsTable rows={q.data.items} notes={notes} />
            <PagerNav pager={pager} label="Wallet history pages" />
          </>
        )}
    </section>
  );
}

/** Newer / older buttons, when there is another page either way. */
export function PagerNav({ pager, label }: { pager: HistoryPager; label: string }) {
  if (!pager.newer && !pager.older) return null;
  return (
    <nav className="ws-pager" aria-label={label}>
      <Button variant="secondary" disabled={!pager.newer} onClick={() => pager.newer?.()}>Newer</Button>
      <span>{pager.label}</span>
      <Button variant="secondary" disabled={!pager.older} onClick={() => pager.older?.()}>Older</Button>
    </nav>
  );
}

/**
 * WQ20: a newest-first history read by cursors (`nextCursor`): the cursors of the pages seen, so "Newer" goes back
 * exactly. `cursor` is the current page's (undefined on the first).
 */
export function useCursorPages() {
  const [stack, setStack] = useState<(string | undefined)[]>([undefined]);
  const cursor = stack[stack.length - 1];
  return {
    cursor,
    pager: (next: string | null | undefined): HistoryPager => ({
      label: `Page ${stack.length}`,
      newer: stack.length > 1 ? () => setStack((s) => s.slice(0, -1)) : null,
      older: next ? () => setStack((s) => [...s, next]) : null,
    }),
  };
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
