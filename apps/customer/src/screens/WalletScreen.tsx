import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { customerApi } from '@jansetu/api';
import { Badge, Button, Empty, ErrorState, formatDateTime, formatRupees, Loading } from '@jansetu/ui';
import { messageOf, PageHeading } from '../common.tsx';
import { useCustomer, useSession } from '../session.tsx';

const CREDIT = new Set(['credit', 'refund', 'cashback', 'promotion']);
const STEP = 20;

export function WalletScreen() {
  const { api } = useSession();
  const me = useCustomer();
  const c = customerApi(api);
  const wallet = useQuery({ queryKey: ['wallet', me.id], queryFn: () => c.wallet(me.id) });
  const [limit, setLimit] = useState(STEP);
  const tx = useQuery({ queryKey: ['wallet', me.id, 'tx', limit], queryFn: () => c.transactions(me.id, 1, limit), placeholderData: (p) => p });

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
          : tx.data.items.length === 0 ? <Empty title="No transactions yet" />
          : (
            <>
              <ul className="list">
                {tx.data.items.map((t) => (
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
              {tx.data.total > tx.data.items.length && limit < 100 && (
                <Button variant="secondary" busy={tx.isFetching} onClick={() => setLimit((l) => Math.min(100, l + STEP))}>Show more</Button>
              )}
            </>
          )}
      </section>
    </>
  );
}
