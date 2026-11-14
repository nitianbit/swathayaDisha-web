import { useQuery } from '@tanstack/react-query';
import { customerApi } from '@jansetu/api';
import { Badge, Button, Empty, ErrorState, formatDateTime, formatRupees, Loading } from '@jansetu/ui';
import { messageOf, PageHeading } from '../common.tsx';
import { usePagedList } from '../paging.ts';
import { useCustomer, useSession } from '../session.tsx';

const CREDIT = new Set(['credit', 'refund', 'cashback', 'promotion']);
const PAGE = 20;

export function WalletScreen() {
  const { api } = useSession();
  const me = useCustomer();
  const c = customerApi(api);
  const wallet = useQuery({ queryKey: ['wallet', me.id], queryFn: () => c.wallet(me.id) });
  const { q: tx, items, total } = usePagedList(['wallet', me.id, 'tx'], (page) => c.transactions(me.id, page, PAGE));

  return (
    <>
      <PageHeading title="Wallet">Refunds and top-ups. You can use it to pay for bookings.</PageHeading>
      <section className="card balance" aria-live="polite">
        <span>Balance</span>
        {wallet.isPending ? <Loading /> : wallet.isError ? <ErrorState message={messageOf(wallet.error)} onRetry={() => void wallet.refetch()} />
          : <strong>{formatRupees(wallet.data.balance)}</strong>}
      </section>
      <section aria-labelledby="tx-h" className="stack">
        <h2 id="tx-h">History</h2>
        {tx.isPending ? <Loading /> : tx.isError ? <ErrorState message={messageOf(tx.error)} onRetry={() => void tx.refetch()} />
          : items.length === 0 ? <Empty title="No transactions yet" />
          : (
            <>
              <ul className="list">
                {items.map((t) => (
                  <li key={t._id} className="list-row">
                    <strong className={CREDIT.has(t.transactionType) ? 'amount-in' : 'amount-out'}>
                      {CREDIT.has(t.transactionType) ? '+' : '−'}{formatRupees(t.amount)}
                    </strong>
                    <span>{t.description ?? t.transactionType}</span>
                    <span className="muted">
                      {formatDateTime(t.createdAt)}{t.status !== 'completed' && <> · <Badge tone="warn">{t.status}</Badge></>}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="muted">Showing {items.length} of {total}.</p>
              {tx.hasNextPage && (
                <Button variant="secondary" busy={tx.isFetchingNextPage} onClick={() => void tx.fetchNextPage()}>Show older</Button>
              )}
            </>
          )}
      </section>
    </>
  );
}
