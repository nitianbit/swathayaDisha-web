import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ArrowLeft, ShoppingCart } from 'lucide-react';
import { ApiError, customerPharmacyApi, shelfOf, type Cart, type ShelfItem } from '@jansetu/api';
import { Alert, Button, Empty, ErrorState, formatRupees, Loading, TextField } from '@jansetu/ui';
import { messageOf, PageHeading } from '../../common.tsx';
import { usePagedList } from '../../paging.ts';
import { useSession } from '../../session.tsx';

export function StoreScreen() {
  const { pharmacyId = '' } = useParams();
  if (!/^[0-9a-fA-F]{24}$/.test(pharmacyId)) return <Empty title="Pharmacy not found"><Link to="/pharmacy">Back to pharmacies</Link></Empty>;
  return <Store key={pharmacyId} pharmacyId={pharmacyId} />;
}

function Store({ pharmacyId }: { pharmacyId: string }) {
  const { api } = useSession();
  const pharmacy = customerPharmacyApi(api);
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  const store = useQuery({ queryKey: ['pharmacy-store', pharmacyId], queryFn: () => pharmacy.store(pharmacyId) });
  // Every page of the pharmacy's stock can be reached; rows of one medicine on different pages merge into one line.
  const { q: stock, items: rows } = usePagedList(['pharmacy-stock', pharmacyId, search], (page) => pharmacy.stock(pharmacyId, { search, page }));
  const cart = useQuery({ queryKey: ['pharmacy-cart'], queryFn: () => pharmacy.cart() });
  const shelf = useMemo(() => shelfOf(rows), [rows]);
  // Pages whose rows are all unorderable (sold out, inactive, unpriced) show nothing: read on until something can be
  // shown or the stock ends, so "nothing in stock" is only said when it is true.
  // A failed page stops the reading (the error offers Retry); it is never re-requested on its own.
  useEffect(() => {
    if (shelf.length === 0 && stock.hasNextPage && !stock.isFetching && !stock.isError) void stock.fetchNextPage();
  }, [shelf.length, stock.hasNextPage, stock.isFetching, stock.isError, stock.fetchNextPage]);
  const [error, setError] = useState<string | null>(null);
  const [otherStore, setOtherStore] = useState<{ medicineId: string } | null>(null);
  // One cart change at a time (the cart is shared by every line): all steppers wait while one is on its way.
  const [busy, setBusy] = useState<string | null>(null);
  const inFlight = useRef(false);

  const cartHere = cart.data?.pharmacyId === pharmacyId ? cart.data : null;
  const inCart = (medicineId: string) => cartHere?.items.find((i) => i.medicineId === medicineId)?.quantity ?? 0;
  const count = cart.data?.items.reduce((n, i) => n + i.quantity, 0) ?? 0;

  async function change(medicineId: string, delta: number, replaceCart = false) {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null); setOtherStore(null); setBusy(medicineId);
    try {
      if (replaceCart) await pharmacy.clearCart();
      // Always a change (+1 / -1), never "remove all" chosen from a possibly stale quantity; the server drops the line at 0.
      const next = await pharmacy.addToCart(pharmacyId, medicineId, delta);
      queryClient.setQueryData<Cart>(['pharmacy-cart'], next);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CART_PHARMACY_MISMATCH') setOtherStore({ medicineId });
      else setError(messageOf(err));
    } finally {
      await queryClient.invalidateQueries({ queryKey: ['pharmacy-cart'] });
      inFlight.current = false;
      setBusy(null);
    }
  }

  return (
    <>
      <Link to="/pharmacy" className="back"><ArrowLeft size={16} aria-hidden="true" /> Pharmacies</Link>
      {store.isPending ? <Loading /> : store.isError ? <ErrorState message={messageOf(store.error)} onRetry={() => void store.refetch()} /> : (
        <PageHeading title={store.data.name}>
          {[store.data.address, store.data.city, store.data.pincode].filter(Boolean).join(', ')}
        </PageHeading>
      )}
      {count > 0 && (
        <Link to="/pharmacy/cart" className="tile tile-inline">
          <ShoppingCart aria-hidden="true" /><span>View cart <strong className="tile-value">{count} · {formatRupees(cart.data?.subtotal)}</strong></span>
        </Link>
      )}
      {otherStore && (
        <Alert tone="warn">
          Your cart has medicines from {cart.data?.pharmacyName ?? 'another pharmacy'}. One order comes from one pharmacy.{' '}
          <Button variant="secondary" onClick={() => void change(otherStore.medicineId, 1, true)}>Empty the cart and add this</Button>{' '}
          <Button variant="ghost" onClick={() => setOtherStore(null)}>Keep my cart</Button>
        </Alert>
      )}
      {error && <Alert>{error}</Alert>}
      <form className="row" role="search" onSubmit={(e: FormEvent) => { e.preventDefault(); setSearch(text.trim()); }}>
        <TextField label="Search this pharmacy" value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. paracetamol" />
        <Button type="submit">Search</Button>
      </form>
      <p className="muted">Medicines that need a prescription can’t be ordered online yet; buy them at the pharmacy.</p>
      {stock.isPending ? <Loading label="Loading medicines…" />
        : stock.isError ? <ErrorState message={messageOf(stock.error)} onRetry={() => void stock.refetch()} />
        : shelf.length === 0 && stock.hasNextPage ? <Loading label="Loading medicines…" />
        : shelf.length === 0 ? <Empty title={search ? `Nothing in stock matches “${search}”` : 'No medicines in stock right now'} />
        : (
          <>
            <ul className="list">
              {shelf.map((m) => (
                <ShelfRow key={m.medicineId} item={m} quantity={inCart(m.medicineId)} busy={busy === m.medicineId} locked={busy !== null}
                  onChange={(delta) => void change(m.medicineId, delta)} />
              ))}
            </ul>
            {stock.hasNextPage && (
              <Button variant="secondary" busy={stock.isFetchingNextPage} onClick={() => void stock.fetchNextPage()}>Show more medicines</Button>
            )}
          </>
        )}
    </>
  );
}

function ShelfRow({ item, quantity, busy, locked, onChange }:
  { item: ShelfItem; quantity: number; busy: boolean; locked: boolean; onChange: (delta: number) => void }) {
  const price = item.minPrice === undefined ? 'Price at the pharmacy'
    : item.minPrice === item.maxPrice ? formatRupees(item.minPrice) : `${formatRupees(item.minPrice)} – ${formatRupees(item.maxPrice)}`;
  return (
    <li className="list-row">
      <strong>{item.name}</strong>
      {item.detail && <span className="muted">{item.detail}</span>}
      <div className="row-between">
        <span>{price}</span>
        {quantity === 0 ? (
          <Button variant="secondary" busy={busy} disabled={locked || item.minPrice === undefined} onClick={() => onChange(1)}
            aria-label={`Add ${item.name} to cart`}>Add</Button>
        ) : (
          <div className="stepper" role="group" aria-label={`${item.name} quantity`}>
            <Button variant="secondary" disabled={locked} onClick={() => onChange(-1)} aria-label={`One less ${item.name}`}>−</Button>
            <span aria-live="polite">{quantity}</span>
            <Button variant="secondary" disabled={locked || quantity >= item.availableQty} onClick={() => onChange(1)}
              aria-label={`One more ${item.name}`}>+</Button>
          </div>
        )}
      </div>
    </li>
  );
}
