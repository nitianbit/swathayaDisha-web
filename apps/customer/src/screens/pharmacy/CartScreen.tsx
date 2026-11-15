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
  // Re-reads the stored checkout attempt whenever an attempt starts or ends (session memory is not reactive).
  const [, setAttemptVersion] = useState(0);
  const attemptChanged = () => setAttemptVersion((v) => v + 1);
  return (
    <>
      <Link to={storeId ? `/pharmacy/stores/${storeId}` : '/pharmacy'} className="back"><ArrowLeft size={16} aria-hidden="true" /> Continue shopping</Link>
      <PageHeading title="Cart">{cart.data?.pharmacyName ?? undefined}</PageHeading>
      <EarlierAttempt onChange={attemptChanged} />
      {cart.isPending ? <Loading /> : cart.isError ? <ErrorState message={messageOf(cart.error)} onRetry={() => void cart.refetch()} />
        : cart.data.items.length === 0 ? <Empty title="Your cart is empty"><Link to="/pharmacy">Find a pharmacy</Link></Empty>
        // The pharmacy's pickup/delivery options decide what can be ordered: nothing is offered until they are known.
        : store.isPending ? <Loading label="Loading the pharmacy…" />
        : store.isError ? <ErrorState message={messageOf(store.error)} onRetry={() => void store.refetch()} />
        : <CartView cart={cart.data} {...modesOf(store.data)} onAttemptChange={attemptChanged} />}
    </>
  );
}

/** How this pharmacy hands over orders: delivery only when it offers delivery; pickup when it offers pickup or nothing else. */
export function modesOf(store: { pickupAvailable?: boolean; deliveryAvailable?: boolean }): { pickup: boolean; delivery: boolean } {
  const delivery = store.deliveryAvailable === true;
  return { pickup: store.pickupAvailable === true || !delivery, delivery };
}

function CartView({ cart, pickup, delivery, onAttemptChange }: { cart: Cart; pickup: boolean; delivery: boolean; onAttemptChange: () => void }) {
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
  // P9: optional prescription files (links of this customer's own uploads), sent with the order.
  const [prescriptions, setPrescriptions] = useState<string[]>([]);
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
    // Never retried automatically. The key is stored before sending and reused until an order is confirmed.
    const now = Date.now();
    const stored = memory.get<CheckoutAttempt>(CHECKOUT_SLOT);
    const attempt: CheckoutAttempt = { requestKey: stored?.requestKey ?? newRequestKey(), attempts: (stored?.attempts ?? 0) + 1,
      firstAttemptAt: stored?.firstAttemptAt ?? now, lastAttemptAt: now };
    /** Ends the stored attempt only if it is still `requestKey` (true), else leaves the newer one alone (false). */
    const endIfCurrent = (requestKey: string) => {
      if (memory.get<CheckoutAttempt>(CHECKOUT_SLOT)?.requestKey !== requestKey) return false;
      memory.delete(CHECKOUT_SLOT);
      onAttemptChange();
      return true;
    };
    try {
      memory.set(CHECKOUT_SLOT, attempt);
      onAttemptChange();
      const r = await pharmacy.checkout({ paymentMode: payMode, deliveryMode: mode, deliveryAddress: address.trim(), notes: notes.trim() || undefined,
        prescriptionUrls: rx.length ? prescriptions : undefined },
        attempt.requestKey);
      await queryClient.invalidateQueries({ queryKey: ['pharmacy-orders'] });
      // A late answer for a key that is no longer the stored one (another attempt started meanwhile, e.g. in another
      // view) changes nothing here: it must not end that newer attempt's protection or take the customer away.
      if (!endIfCurrent(attempt.requestKey)) { setPlacing(false); return; }
      queryClient.removeQueries({ queryKey: ['pharmacy-cart'] });
      // The payment details live in this session's memory only (never stored): the order page opens Checkout with them.
      if (r.paymentRequired && r.payment) memory.set(paymentKey(r.order._id), r.payment);
      navigate(`/pharmacy/orders/${r.order._id}`, { state: { startPayment: r.paymentRequired && !!r.payment, replayed: r.replayed === true } });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'REQUEST_ABANDONED') {
        // That attempt can never be placed: the next one gets a new key (only if it is still the stored one).
        if (endIfCurrent(attempt.requestKey)) setError('That attempt was cancelled. Please place the order again.');
      } else if (err instanceof ApiError && err.code === 'CART_PRICE_CHANGED') {
        setError('Some prices changed since you added the medicines. Check the new total and place the order again.');
        await refresh();
      } else if (err instanceof ApiError && err.status === 0) {
        setError('We could not tell whether your order was placed. Use “Check my last order” above.');
        onAttemptChange();
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
            {i.prescriptionRequired !== false && <span className="muted">Needs a prescription: the pharmacist checks it before packing.</span>}
          </li>
        ))}
      </ul>
      <p><strong>Total {formatRupees(cart.subtotal)}</strong></p>
      {rx.length > 0 && (
        <PrescriptionUpload names={rx.map((i) => i.medicineName ?? 'A medicine')} urls={prescriptions} onChange={setPrescriptions} disabled={placing} />
      )}
      {(
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

    </>
  );
}

/**
 * P8: a "Place order" whose answer never arrived (the connection dropped, or the app was reloaded). The server is asked
 * about that request key: if it placed an order, that order opens; if not, the attempt is cancelled for good on the
 * server (it can never be placed later) and the customer simply places the order again. Never two orders.
 */
function EarlierAttempt({ onChange }: { onChange: () => void }) {
  const { api, memory } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const attempt = memory.get<CheckoutAttempt>(CHECKOUT_SLOT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  // The result belongs to the key it was about: a newer unresolved attempt always shows its own recovery.
  const [clearedKey, setClearedKey] = useState<string | null>(null);
  if (!attempt) {
    return clearedKey ? <Alert tone="ok">Your earlier attempt did not place an order. You can place the order now.</Alert> : null;
  }
  const key = attempt.requestKey;
  async function check() {
    setBusy(true); setError(null);
    try {
      const r = await requestKeysApi(api).abandon('pharmacy_checkout', key);
      await queryClient.invalidateQueries({ queryKey: ['pharmacy-cart'] });
      await queryClient.invalidateQueries({ queryKey: ['pharmacy-orders'] });
      // Decided only now, after every wait: if a newer attempt started meanwhile, this result changes nothing.
      const current = memory.get<CheckoutAttempt>(CHECKOUT_SLOT)?.requestKey === key;
      if (current) {
        memory.delete(CHECKOUT_SLOT);
        if (r.state === 'used' && r.record?._id) navigate(`/pharmacy/orders/${r.record._id}`, { state: { replayed: true } });
        else setClearedKey(key);
      }
      onChange();
    } catch (err) {
      setError({ key, message: messageOf(err) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Alert tone="warn">
      Your last attempt to place an order may have gone through.{' '}
      <Button variant="secondary" busy={busy} onClick={() => void check()}>Check my last order</Button>
      {error && error.key === key && <span> {error.message}</span>}
    </Alert>
  );
}

/**
 * P9: medicines that need a prescription are checked by the pharmacist before the order is packed. Attaching a
 * prescription is optional (images or PDF); without one the pharmacist may contact you.
 */
function PrescriptionUpload({ names, urls, onChange, disabled }: {
  names: string[]; urls: string[]; onChange: (urls: string[]) => void; disabled: boolean;
}) {
  const { api } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function add(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true); setError(null);
    try {
      const added: string[] = [];
      for (const f of Array.from(files)) {
        if (!/^(image\/(jpeg|png|webp)|application\/pdf)$/.test(f.type)) throw new Error('Attach a photo (JPG, PNG) or a PDF.');
        if (f.size > 10 * 1024 * 1024) throw new Error('Each file must be under 10 MB.');
        added.push(await customerPharmacyApi(api).uploadPrescription(f));
      }
      onChange([...urls, ...added]);
    } catch (err) {
      setError(err instanceof ApiError ? messageOf(err) : (err as Error).message || 'The file could not be attached.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card stack" aria-labelledby="rx-h">
      <h2 id="rx-h">Prescription</h2>
      <p>
        {names.join(', ')} {names.length === 1 ? 'needs' : 'need'} a prescription. The pharmacist checks your order before packing
        it; if it is not approved, you are refunded.
      </p>
      <label className="file-pick">
        <span>Attach your prescription (optional)</span>
        <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" multiple disabled={busy || disabled}
          onChange={(e) => { void add(e.target.files); e.target.value = ''; }} />
      </label>
      {busy && <Loading label="Attaching…" />}
      {error && <Alert>{error}</Alert>}
      {urls.length > 0 && (
        <ul className="plain">
          {urls.map((u, i) => (
            <li key={u} className="row-between">
              <span>Prescription {i + 1} attached</span>
              <Button variant="ghost" disabled={disabled} onClick={() => onChange(urls.filter((x) => x !== u))}>Remove</Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
