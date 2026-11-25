import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Package, ShoppingCart } from 'lucide-react';
import { customerPharmacyApi } from '@jansetu/api';
import { Button, Empty, ErrorState, formatRupees, Loading, shared, TextField } from '@jansetu/ui';
import { messageOf, PageHeading } from '../../common.tsx';
import { t } from '../../i18n/index.ts';
import { usePagedList } from '../../paging.ts';
import { useSession } from '../../session.tsx';

/** Pharmacies the customer can order from, with the cart and the customer's orders one tap away. */
export function StoresScreen() {
  const { api } = useSession();
  const pharmacy = customerPharmacyApi(api);
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  const { q, items, total } = usePagedList(['pharmacy-stores', search], (page) => pharmacy.stores({ search, page }));
  const cart = useQuery({ queryKey: ['pharmacy-cart'], queryFn: () => pharmacy.cart() });
  const count = cart.data?.items.reduce((n, i) => n + i.quantity, 0) ?? 0;
  return (
    <>
      <PageHeading title={t('nav.medicines')}>{t('stores.sub')}</PageHeading>
      <div className="row">
        <Link to="/pharmacy/cart" className="tile tile-inline">
          <ShoppingCart aria-hidden="true" />
          <span>{t('cart.title')}{count > 0 ? <strong className="tile-value">{count} · {formatRupees(cart.data?.subtotal)}</strong> : null}</span>
        </Link>
        <Link to="/pharmacy/orders" className="tile tile-inline"><Package aria-hidden="true" /><span>{t('stores.myOrders')}</span></Link>
      </div>
      <form className="row" role="search" onSubmit={(e: FormEvent) => { e.preventDefault(); setSearch(text.trim()); }}>
        <TextField label={t('stores.search')} value={text} onChange={(e) => setText(e.target.value)} />
        <Button type="submit">{shared('action.search')}</Button>
      </form>
      {q.isPending ? <Loading /> : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : items.length === 0 ? <Empty title={search ? t('stores.noMatch', { search }) : t('stores.none')} />
        : (
          <>
            <ul className="list">
              {items.map((p) => (
                <li key={p._id}>
                  <Link to={`/pharmacy/stores/${p._id}`} className="list-row link-row">
                    <strong>{p.name}</strong>
                    <span className="muted">{[p.address, p.city, p.pincode].filter(Boolean).join(', ')}</span>
                    <span>{[p.pickupAvailable ? t('pharmacy.pickup') : '', p.deliveryAvailable ? t('pharmacy.delivery') : ''].filter(Boolean).join(' · ') || t('pharmacy.visit')}</span>
                  </Link>
                </li>
              ))}
            </ul>
            <p className="muted">{t('common.showing', { shown: items.length, total })}</p>
            {q.hasNextPage && <Button variant="secondary" busy={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{shared('action.showMore')}</Button>}
          </>
        )}
    </>
  );
}
