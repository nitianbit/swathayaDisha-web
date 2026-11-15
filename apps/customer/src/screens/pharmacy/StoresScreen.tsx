import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Package, ShoppingCart } from 'lucide-react';
import { customerPharmacyApi } from '@jansetu/api';
import { Button, Empty, ErrorState, formatRupees, Loading, TextField } from '@jansetu/ui';
import { messageOf, PageHeading } from '../../common.tsx';
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
      <PageHeading title="Medicines">Order from a pharmacy near you for pickup or delivery.</PageHeading>
      <div className="row">
        <Link to="/pharmacy/cart" className="tile tile-inline">
          <ShoppingCart aria-hidden="true" />
          <span>Cart{count > 0 ? <strong className="tile-value">{count} · {formatRupees(cart.data?.subtotal)}</strong> : null}</span>
        </Link>
        <Link to="/pharmacy/orders" className="tile tile-inline"><Package aria-hidden="true" /><span>My orders</span></Link>
      </div>
      <form className="row" role="search" onSubmit={(e: FormEvent) => { e.preventDefault(); setSearch(text.trim()); }}>
        <TextField label="Pharmacy, area or pincode" value={text} onChange={(e) => setText(e.target.value)} />
        <Button type="submit">Search</Button>
      </form>
      {q.isPending ? <Loading /> : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : items.length === 0 ? <Empty title={search ? `No pharmacies match “${search}”` : 'No pharmacies available yet'} />
        : (
          <>
            <ul className="list">
              {items.map((p) => (
                <li key={p._id}>
                  <Link to={`/pharmacy/stores/${p._id}`} className="list-row link-row">
                    <strong>{p.name}</strong>
                    <span className="muted">{[p.address, p.city, p.pincode].filter(Boolean).join(', ')}</span>
                    <span>{[p.pickupAvailable ? 'Pickup' : '', p.deliveryAvailable ? 'Delivery' : ''].filter(Boolean).join(' · ') || 'Visit the pharmacy'}</span>
                  </Link>
                </li>
              ))}
            </ul>
            <p className="muted">Showing {items.length} of {total}.</p>
            {q.hasNextPage && <Button variant="secondary" busy={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Show more</Button>}
          </>
        )}
    </>
  );
}
