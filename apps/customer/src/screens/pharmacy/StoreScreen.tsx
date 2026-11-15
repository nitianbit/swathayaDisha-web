import { useMemo, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ArrowLeft, ShoppingCart } from 'lucide-react';
import { ApiError, customerPharmacyApi, shelfOf, type Cart, type ShelfItem } from '@jansetu/api';
import { Alert, Button, Empty, ErrorState, formatRupees, Loading, TextField } from '@jansetu/ui';
import { messageOf, PageHeading } from '../../common.tsx';
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
  const stock = useQuery({ queryKey: ['pharmacy-stock', pharmacyId, search], queryFn: () => pharmacy.stock(pharmacyId, { search }) });
  const cart = useQuery({ queryKey: ['pharmacy-cart'], queryFn: () => pharmacy.cart() });
  const shelf = useMemo(() => shelfOf(stock.data?.items ?? []), [stock.data]);
  const [error, setError] = useState<string | null>(null);
  const [otherStore, setOtherStore] = useState<{ medicineId: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const cartHere = cart.data?.pharmacyId === pharmacyId ? cart.data : null;
  const inCart = (medicineId: string) => cartHere?.items.find((i) => i.medicineId === medicineId)?.quantity ?? 0;
  const count = cart.data?.items.reduce((n, i) => n + i.quantity, 0) ?? 0;

  async function change(medicineId: string, delta: number, replaceCart = false) {
    setError(null); setOtherStore(null); setBusy(medicineId);
    try {
      if (replaceCart) await pharmacy.clearCart();
      const next = delta < 0 && inCart(medicineId) <= -delta
        ? await pharmacy.removeFromCart(medicineId)
        : await pharmacy.addToCart(pharmacyId, medicineId, delta);
      queryClient.setQueryData<Cart>(['pharmacy-cart'], next);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CART_PHARMACY_MISMATCH') setOtherStore({ medicineId });
      else setError(messageOf(err));
    } finally {
      setBusy(null);
      await queryClient.invalidateQueries({ queryKey: ['pharmacy-cart'] });
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
        : shelf.length === 0 ? <Empty title={search ? `Nothing in stock matches “${search}”` : 'No medicines in stock right now'} />
        : (
          <ul className="list">
            {shelf.map((m) => (
              <ShelfRow key={m.medicineId} item={m} quantity={inCart(m.medicineId)} busy={busy === m.medicineId}
                onChange={(delta) => void change(m.medicineId, delta)} />
            ))}
          </ul>
        )}
    </>
  );
}

function ShelfRow({ item, quantity, busy, onChange }: { item: ShelfItem; quantity: number; busy: boolean; onChange: (delta: number) => void }) {
  const price = item.minPrice === undefined ? 'Price at the pharmacy'
    : item.minPrice === item.maxPrice ? formatRupees(item.minPrice) : `${formatRupees(item.minPrice)} – ${formatRupees(item.maxPrice)}`;
  return (
    <li className="list-row">
      <strong>{item.name}</strong>
      {item.detail && <span className="muted">{item.detail}</span>}
      <div className="row-between">
        <span>{price}</span>
        {quantity === 0 ? (
          <Button variant="secondary" busy={busy} disabled={item.minPrice === undefined} onClick={() => onChange(1)}
            aria-label={`Add ${item.name} to cart`}>Add</Button>
        ) : (
          <div className="stepper" role="group" aria-label={`${item.name} quantity`}>
            <Button variant="secondary" disabled={busy} onClick={() => onChange(-1)} aria-label={`One less ${item.name}`}>−</Button>
            <span aria-live="polite">{quantity}</span>
            <Button variant="secondary" disabled={busy || quantity >= item.availableQty} onClick={() => onChange(1)}
              aria-label={`One more ${item.name}`}>+</Button>
          </div>
        )}
      </div>
    </li>
  );
}
