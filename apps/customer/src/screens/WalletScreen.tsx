import { useQuery } from '@tanstack/react-query';
import { customerApi } from '@jansetu/api';
import { Badge, Button, Empty, ErrorState, formatDateTime, formatRupees, Loading } from '@jansetu/ui';
import { messageOf, PageHeading } from '../common.tsx';
import { t } from '../i18n/index.ts';
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
      <PageHeading title={t('nav.wallet')}>{t('wallet.sub')}</PageHeading>
      <section className="card balance" aria-live="polite">
        <span>{t('wallet.balance')}</span>
        {wallet.isPending ? <Loading /> : wallet.isError ? <ErrorState message={messageOf(wallet.error)} onRetry={() => void wallet.refetch()} />
          : <strong>{formatRupees(wallet.data.balance)}</strong>}
      </section>
      <section aria-labelledby="tx-h" className="stack">
        <h2 id="tx-h">{t('wallet.history')}</h2>
        {tx.isPending ? <Loading /> : tx.isError ? <ErrorState message={messageOf(tx.error)} onRetry={() => void tx.refetch()} />
          : items.length === 0 ? <Empty title={t('wallet.empty')} />
          : (
            <>
              <ul className="list">
                {items.map((tx) => (
                  <li key={tx._id} className="list-row">
                    <strong className={CREDIT.has(tx.transactionType) ? 'amount-in' : 'amount-out'}>
                      {CREDIT.has(tx.transactionType) ? '+' : '−'}{formatRupees(tx.amount)}
                    </strong>
                    <span>{tx.description ?? tx.transactionType}</span>
                    <span className="muted">
                      {formatDateTime(tx.createdAt)}{tx.status !== 'completed' && <> · <Badge tone="warn">{tx.status}</Badge></>}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="muted">{t('common.showing', { shown: items.length, total })}</p>
              {tx.hasNextPage && (
                <Button variant="secondary" busy={tx.isFetchingNextPage} onClick={() => void tx.fetchNextPage()}>{t('wallet.showOlder')}</Button>
              )}
            </>
          )}
      </section>
    </>
  );
}
