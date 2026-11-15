import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { ApiError, customerPharmacyApi, PHARMACY_PAYMENT_WINDOW_MIN, requestKeysApi, type Cart, type CartItem, type PaymentMode } from '@jansetu/api';
import { Alert, Button, Empty, ErrorState, formatRupees, Loading, TextArea } from '@jansetu/ui';
import { messageOf, PageHeading } from '../../common.tsx';
import { newRequestKey } from '../../pending.ts';
import { useSession } from '../../session.tsx';

export const paymentKey = (orderId: string) => `pharmacy-payment:${orderId}`;
/** P8: the slot of the checkout request key (kept across a reload as a body-less marker; ended by a placed order). */
export const CHECKOUT_SLOT = 'pharmacy-checkout';
interface CheckoutAttempt { requestKey: string; attempts: number; firstAttemptAt: number; lastAttemptAt: number; restored?: boolean }

/** The cart (one pharmacy) and checkout: pickup or delivery, how to pay, then the order is placed once. */
export function CartScreen() {
  const { api } = useSession();
  const pharmacy = customerPharmacyApi(api);
  const cart = useQuery({ queryKey: ['pharmacy-cart'], queryFn: () => pharmacy.cart() });
  const storeId = cart.data?.pharmacyId ?? '';
  const store = useQuery({ queryKey: ['pharmacy-store', storeId], queryFn: () => pharmacy.store(storeId), enabled: /^[0-9a-fA-F]{24}$/.test(storeId) });
  return (
    <>
      <Link to={storeId ? `/pharmacy/stores/${storeId}` : '/pharmacy'} className="back"><ArrowLeft size={16} aria-hidden="true" /> Continue shopping</Link>
      <PageHeading title="Cart">{cart.data?.pharmacyName ?? undefined}</PageHeading>
      <EarlierAttempt />
      {cart.isPending ? <Loading /> : cart.isError ? <ErrorState message={messageOf(cart.error)} onRetry={() => void cart.refetch()} />
        : cart.data.items.length === 0 ? <Empty title="Your cart is empty"><Link to="/pharmacy">Find a pharmacy</Link></Empty>
        // The pharmacy's pickup/delivery options decide what can be ordered: nothing is offered until they are known.
        : store.isPending ? <Loading label="Loading the pharmacy…" />
        : store.isError ? <ErrorState message={messageOf(store.error)} onRetry={() => void store.refetch()} />
        : <CartView cart={cart.data} {...modesOf(store.data)} />}
    </>
  );
}

/** How this pharmacy hands over orders: delivery only when it offers delivery; pickup when it offers pickup or nothing else. */
export function modesOf(store: { pickupAvailable?: boolean; deliveryAvailable?: boolean }): { pickup: boolean; delivery: boolean } {
  const delivery = store.deliveryAvailable === true;
  return { pickup: store.pickupAvailable === true || !delivery, delivery };
}

function CartView({ cart, pickup, delivery }: { cart: Cart; pickup: boolean; delivery: boolean }) {
  const { api, memory } = useSession();
  const pharmacy = customerPharmacyApi(api);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'pickup' | 'delivery'>(pickup ? 'pickup' : 'delivery');
  const [pay, setPay] = useState<PaymentMode>('online_payment');
  const [address, setAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [placing, setPlacing] = useState(false);
  const inFlight = useRef(false);
  // If the options change (e.g. fresher pharmacy details), the choice follows: never an option the pharmacy lacks.
  useEffect(() => {
    if (mode === 'pickup' && !pickup && delivery) setMode('delivery');
    if (mode === 'delivery' && !delivery && pickup) setMode('pickup');
  }, [mode, pickup, delivery]);
  const modeAllowed = mode === 'pickup' ? pickup : delivery;

  const rx = cart.items.filter((i) => i.prescriptionRequired !== false);
  const offline: PaymentMode = mode === 'pickup' ? 'in_store_payment' : 'cash_on_delivery';
  const payMode: PaymentMode = pay === 'online_payment' ? pay : offline;

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['pharmacy-cart'] });
  async function change(item: CartItem, delta: number) {
    if (inFlight.current) return; // one cart change at a time
    inFlight.current = true;
    setError(null); setBusy(true);
    try {
      // A change, never "remove all" from a possibly stale quantity: the server drops the line at 0.
      const next = await pharmacy.addToCart(cart.pharmacyId!, item.medicineId, delta);
      queryClient.setQueryData(['pharmacy-cart'], next);
    } catch (err) { setError(messageOf(err)); } finally { await refresh(); inFlight.current = false; setBusy(false); }
  }

  async function place() {
    setError(null);
    if (!modeAllowed) { setError('Choose how you get the order.'); return; }
    if (mode === 'delivery' && address.trim().length < 10) { setFieldError('Enter the full delivery address.'); return; }
    setFieldError(null);
    setPlacing(true);
    try {
      // Never retried automatically. The key is stored before sending and reused until an order is confirmed.
      const now = Date.now();
      const stored = memory.get<CheckoutAttempt>(CHECKOUT_SLOT);
      const attempt: CheckoutAttempt = { requestKey: stored?.requestKey ?? newRequestKey(), attempts: (stored?.attempts ?? 0) + 1,
        firstAttemptAt: stored?.firstAttemptAt ?? now, lastAttemptAt: now };
      memory.set(CHECKOUT_SLOT, attempt);
      const r = await pharmacy.checkout({ paymentMode: payMode, deliveryMode: mode, deliveryAddress: address.trim(), notes: notes.trim() || undefined },
        attempt.requestKey);
      memory.delete(CHECKOUT_SLOT);
      queryClient.removeQueries({ queryKey: ['pharmacy-cart'] });
      await queryClient.invalidateQueries({ queryKey: ['pharmacy-orders'] });
      // The payment details live in this session's memory only (never stored): the order page opens Checkout with them.
      if (r.paymentRequired && r.payment) memory.set(paymentKey(r.order._id), r.payment);
      navigate(`/pharmacy/orders/${r.order._id}`, { state: { startPayment: r.paymentRequired && !!r.payment, replayed: r.replayed === true } });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'REQUEST_ABANDONED') {
        memory.delete(CHECKOUT_SLOT); // that attempt can never be placed: the next one gets a new key
        setError('That attempt was cancelled. Please place the order again.');
      } else if (err instanceof ApiError && err.code === 'CART_PRICE_CHANGED') {
        setError('Some prices changed since you added the medicines. Check the new total and place the order again.');
        await refresh();
      } else if (err instanceof ApiError && err.status === 0) {
        setError('We could not tell whether your order was placed. Use “Check my last order” above.');
        await queryClient.invalidateQueries({ queryKey: ['pharmacy-orders'] });
        await refresh();
      } else {
        setError(messageOf(err));
      }
      setPlacing(false);
    }
  }

  return (
    <>
      <ul className="list">
        {cart.items.map((i) => (
          <li key={i.medicineId} className="list-row">
            <strong>{i.medicineName ?? i.brandName ?? 'Medicine'}</strong>
            <div className="row-between">
              <span>{formatRupees(i.unitPrice)} × {i.quantity} = {formatRupees(i.lineTotal)}</span>
              <div className="stepper" role="group" aria-label={`${i.medicineName ?? 'Medicine'} quantity`}>
                <Button variant="secondary" disabled={busy || placing} onClick={() => void change(i, -1)} aria-label={`One less ${i.medicineName ?? ''}`}>−</Button>
                <span>{i.quantity}</span>
                <Button variant="secondary" disabled={busy || placing} onClick={() => void change(i, 1)} aria-label={`One more ${i.medicineName ?? ''}`}>+</Button>
              </div>
            </div>
            {i.prescriptionRequired !== false && <span className="muted">Needs a prescription: can’t be ordered online yet.</span>}
          </li>
        ))}
      </ul>
      <p><strong>Total {formatRupees(cart.subtotal)}</strong></p>
      {rx.length > 0 ? (
        <Alert tone="warn">
          {rx.map((i) => i.medicineName ?? 'A medicine').join(', ')} {rx.length === 1 ? 'needs' : 'need'} a prescription. Medicines
          that need a prescription can’t be ordered online yet: remove {rx.length === 1 ? 'it' : 'them'} to continue, and buy
          {rx.length === 1 ? ' it' : ' them'} at the pharmacy.
        </Alert>
      ) : (
        <section className="card stack" aria-labelledby="checkout-h">
          <h2 id="checkout-h">How you get it</h2>
          <fieldset className="choice">
            <legend>Pickup or delivery</legend>
            {pickup && <label><input type="radio" name="mode" checked={mode === 'pickup'} onChange={() => setMode('pickup')} /> Collect at the pharmacy</label>}
            {delivery && <label><input type="radio" name="mode" checked={mode === 'delivery'} onChange={() => setMode('delivery')} /> Deliver to me</label>}
          </fieldset>
          {mode === 'delivery' && (
            <TextArea label="Delivery address" value={address} maxLength={500} onChange={(e) => setAddress(e.target.value)} error={fieldError}
              hint="House, street, area, city and pincode." />
          )}
          <fieldset className="choice">
            <legend>How you pay</legend>
            <label><input type="radio" name="pay" checked={pay === 'online_payment'} onChange={() => setPay('online_payment')} /> Pay online now</label>
            <label><input type="radio" name="pay" checked={pay !== 'online_payment'} onChange={() => setPay(offline)} />
              {mode === 'pickup' ? ' Pay at the pharmacy' : ' Cash on delivery'}</label>
          </fieldset>
          <TextArea label="Note for the pharmacy (optional)" value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
          {payMode === 'online_payment' && (
            <p className="muted">Pay within {PHARMACY_PAYMENT_WINDOW_MIN} minutes, or the order is cancelled and the medicines are released.</p>
          )}
          {error && <Alert>{error}</Alert>}
          <Button busy={placing} disabled={busy || !modeAllowed} onClick={() => void place()}>
            {payMode === 'online_payment' ? `Place order and pay ${formatRupees(cart.subtotal)}` : `Place order · ${formatRupees(cart.subtotal)}`}
          </Button>
        </section>
      )}
      {rx.length > 0 && error && <Alert>{error}</Alert>}
    </>
  );
}

/**
 * P8: a "Place order" whose answer never arrived (the connection dropped, or the app was reloaded). The server is asked
 * about that request key: if it placed an order, that order opens; if not, the attempt is cancelled for good on the
 * server (it can never be placed later) and the customer simply places the order again. Never two orders.
 */
function EarlierAttempt() {
  const { api, memory } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const attempt = memory.get<CheckoutAttempt>(CHECKOUT_SLOT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cleared, setCleared] = useState(false);
  if (cleared) return <Alert tone="ok">Your earlier attempt did not place an order. You can place the order now.</Alert>;
  if (!attempt) return null;
  async function check() {
    setBusy(true); setError(null);
    try {
      const r = await requestKeysApi(api).abandon('pharmacy_checkout', attempt!.requestKey);
      if (memory.get<CheckoutAttempt>(CHECKOUT_SLOT)?.requestKey === attempt!.requestKey) memory.delete(CHECKOUT_SLOT);
      await queryClient.invalidateQueries({ queryKey: ['pharmacy-cart'] });
      await queryClient.invalidateQueries({ queryKey: ['pharmacy-orders'] });
      if (r.state === 'used' && r.record?._id) navigate(`/pharmacy/orders/${r.record._id}`, { state: { replayed: true } });
      else setCleared(true);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Alert tone="warn">
      Your last attempt to place an order may have gone through.{' '}
      <Button variant="secondary" busy={busy} onClick={() => void check()}>Check my last order</Button>
      {error && <span> {error}</span>}
    </Alert>
  );
}
