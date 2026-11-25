import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ArrowLeft, ShoppingCart } from 'lucide-react';
import { ApiError, customerPharmacyApi, shelfOf, type Cart, type ShelfItem } from '@jansetu/api';
import { Alert, Button, Empty, ErrorState, formatRupees, Loading, shared, TextField } from '@jansetu/ui';
import { messageOf, PageHeading } from '../../common.tsx';
import { t } from '../../i18n/index.ts';
import { usePagedList } from '../../paging.ts';
import { useSession } from '../../session.tsx';

export function StoreScreen() {
  const { pharmacyId = '' } = useParams();
  if (!/^[0-9a-fA-F]{24}$/.test(pharmacyId)) return <Empty title={t('store.notFound')}><Link to="/pharmacy">{t('store.backToList')}</Link></Empty>;
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
      <Link to="/pharmacy" className="back"><ArrowLeft size={16} aria-hidden="true" /> {t('store.back')}</Link>
      {store.isPending ? <Loading /> : store.isError ? <ErrorState message={messageOf(store.error)} onRetry={() => void store.refetch()} /> : (
        <PageHeading title={store.data.name}>
          {[store.data.address, store.data.city, store.data.pincode].filter(Boolean).join(', ')}
        </PageHeading>
      )}
      {count > 0 && (
        <Link to="/pharmacy/cart" className="tile tile-inline">
          <ShoppingCart aria-hidden="true" /><span>{t('store.viewCart')} <strong className="tile-value">{count} · {formatRupees(cart.data?.subtotal)}</strong></span>
        </Link>
      )}
      {otherStore && (
        <Alert tone="warn">
          {cart.data?.pharmacyName ? t('store.otherCart', { pharmacy: cart.data.pharmacyName }) : t('store.otherCartUnknown')}{' '}
          <Button variant="secondary" onClick={() => void change(otherStore.medicineId, 1, true)}>{t('store.emptyAndAdd')}</Button>{' '}
          <Button variant="ghost" onClick={() => setOtherStore(null)}>{t('store.keepCart')}</Button>
        </Alert>
      )}
      {error && <Alert>{error}</Alert>}
      <form className="row" role="search" onSubmit={(e: FormEvent) => { e.preventDefault(); setSearch(text.trim()); }}>
        <TextField label={t('store.search')} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('store.searchPlaceholder')} />
        <Button type="submit">{shared('action.search')}</Button>
      </form>
      <p className="muted">{t('store.rxNote')}</p>
      {stock.isPending ? <Loading label={t('common.loadingMedicines')} />
        : stock.isError ? <ErrorState message={messageOf(stock.error)} onRetry={() => void stock.refetch()} />
        : shelf.length === 0 && stock.hasNextPage ? <Loading label={t('common.loadingMedicines')} />
        : shelf.length === 0 ? <Empty title={search ? t('store.noMatch', { search }) : t('store.none')} />
        : (
          <>
            <ul className="list">
              {shelf.map((m) => (
                <ShelfRow key={m.medicineId} item={m} quantity={inCart(m.medicineId)} busy={busy === m.medicineId} locked={busy !== null}
                  onChange={(delta) => void change(m.medicineId, delta)} />
              ))}
            </ul>
            {stock.hasNextPage && (
              <Button variant="secondary" busy={stock.isFetchingNextPage} onClick={() => void stock.fetchNextPage()}>{t('store.showMore')}</Button>
            )}
          </>
        )}
    </>
  );
}

function ShelfRow({ item, quantity, busy, locked, onChange }:
  { item: ShelfItem; quantity: number; busy: boolean; locked: boolean; onChange: (delta: number) => void }) {
  const price = item.minPrice === undefined ? t('store.priceAtPharmacy')
    : item.minPrice === item.maxPrice ? formatRupees(item.minPrice) : `${formatRupees(item.minPrice)} – ${formatRupees(item.maxPrice)}`;
  return (
    <li className="list-row">
      <strong>{item.name}</strong>
      {item.detail && <span className="muted">{item.detail}</span>}
      <div className="row-between">
        <span>{price}</span>
        {quantity === 0 ? (
          <Button variant="secondary" busy={busy} disabled={locked || item.minPrice === undefined} onClick={() => onChange(1)}
            aria-label={t('store.addAria', { name: item.name })}>{t('common.add')}</Button>
        ) : (
          <div className="stepper" role="group" aria-label={t('store.quantityAria', { name: item.name })}>
            <Button variant="secondary" disabled={locked} onClick={() => onChange(-1)} aria-label={t('store.lessAria', { name: item.name })}>−</Button>
            <span aria-live="polite">{quantity}</span>
            <Button variant="secondary" disabled={locked || quantity >= item.availableQty} onClick={() => onChange(1)}
              aria-label={t('store.moreAria', { name: item.name })}>+</Button>
          </div>
        )}
      </div>
    </li>
  );
}
