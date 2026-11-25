import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { ApiError, customerPharmacyApi, PHARMACY_PAYMENT_WINDOW_MIN, requestKeysApi, type Cart, type CartItem, type PaymentMode } from '@jansetu/api';
import { Alert, Button, Empty, ErrorState, formatRupees, Loading, TextArea } from '@jansetu/ui';
import { messageOf, PageHeading } from '../../common.tsx';
import { t } from '../../i18n/index.ts';
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
  // Survives the view being replaced when the refreshed cart belongs to another pharmacy.
  const [cartNotice, setCartNotice] = useState<string | null>(null);
  return (
    <>
      <Link to={storeId ? `/pharmacy/stores/${storeId}` : '/pharmacy'} className="back"><ArrowLeft size={16} aria-hidden="true" /> {t('cart.continue')}</Link>
      <PageHeading title={t('cart.title')}>{cart.data?.pharmacyName ?? undefined}</PageHeading>
      <EarlierAttempt onChange={attemptChanged} />
      {cartNotice && <Alert tone="warn">{cartNotice}</Alert>}
      {cart.isPending ? <Loading /> : cart.isError ? <ErrorState message={messageOf(cart.error)} onRetry={() => void cart.refetch()} />
        : cart.data.items.length === 0 ? <Empty title={t('cart.empty')}><Link to="/pharmacy">{t('cart.findPharmacy')}</Link></Empty>
        // The pharmacy's pickup/delivery options decide what can be ordered: nothing is offered until they are known.
        : store.isPending ? <Loading label={t('cart.loadingPharmacy')} />
        : store.isError ? <ErrorState message={messageOf(store.error)} onRetry={() => void store.refetch()} />
        // Keyed by the pharmacy: a cart that now belongs to another pharmacy starts with nothing attached (a document
        // meant for one pharmacy is never sent to another; late uploads of the old view land nowhere).
        : <CartView key={cart.data.pharmacyId ?? 'none'} cart={cart.data} {...modesOf(store.data)} onAttemptChange={attemptChanged}
            onCartChanged={setCartNotice} />}
    </>
  );
}

/** How this pharmacy hands over orders: delivery only when it offers delivery; pickup when it offers pickup or nothing else. */
export function modesOf(store: { pickupAvailable?: boolean; deliveryAvailable?: boolean }): { pickup: boolean; delivery: boolean } {
  const delivery = store.deliveryAvailable === true;
  return { pickup: store.pickupAvailable === true || !delivery, delivery };
}

function CartView({ cart, pickup, delivery, onAttemptChange, onCartChanged }: {
  cart: Cart; pickup: boolean; delivery: boolean; onAttemptChange: () => void; onCartChanged: (notice: string | null) => void;
}) {
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
  // Uploads still on their way: the order is not placed until they finish (a selected prescription is never dropped).
  const [uploading, setUploading] = useState(0);
  const uploadingRef = useRef(0);
  const trackUpload = (delta: number) => { uploadingRef.current += delta; setUploading(uploadingRef.current); };
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
    onCartChanged(null);
    if (uploadingRef.current > 0) { setError(t('cart.waitUpload')); return; }
    if (!modeAllowed) { setError(t('cart.chooseMode')); return; }
    if (mode === 'delivery' && address.trim().length < 10) { setFieldError(t('cart.addressMissing')); return; }
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
        prescriptionUrls: rx.length ? prescriptions : undefined, expectedPharmacyId: cart.pharmacyId ?? undefined },
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
        if (endIfCurrent(attempt.requestKey)) setError(t('cart.attemptCancelled'));
      } else if (err instanceof ApiError && err.code === 'CART_CHANGED') {
        // The cart now belongs to another pharmacy (changed elsewhere): reload it; the view starts fresh for it.
        onCartChanged(t('cart.changedElsewhere'));
        await refresh();
      } else if (err instanceof ApiError && err.code === 'CART_PRICE_CHANGED') {
        setError(t('cart.pricesChanged'));
        await refresh();
      } else if (err instanceof ApiError && err.status === 0) {
        setError(t('cart.unknownOutcome'));
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
            <strong>{i.medicineName ?? i.brandName ?? t('common.medicine')}</strong>
            <div className="row-between">
              <span>{formatRupees(i.unitPrice)} × {i.quantity} = {formatRupees(i.lineTotal)}</span>
              <div className="stepper" role="group" aria-label={t('store.quantityAria', { name: i.medicineName ?? t('common.medicine') })}>
                <Button variant="secondary" disabled={busy || placing} onClick={() => void change(i, -1)} aria-label={t('store.lessAria', { name: i.medicineName ?? '' })}>−</Button>
                <span>{i.quantity}</span>
                <Button variant="secondary" disabled={busy || placing} onClick={() => void change(i, 1)} aria-label={t('store.moreAria', { name: i.medicineName ?? '' })}>+</Button>
              </div>
            </div>
            {i.prescriptionRequired !== false && <span className="muted">{t('cart.needsRx')}</span>}
          </li>
        ))}
      </ul>
      <p><strong>{t('cart.total', { amount: formatRupees(cart.subtotal) })}</strong></p>
      {rx.length > 0 && (
        <PrescriptionUpload names={rx.map((i) => i.medicineName ?? t('cart.aMedicine'))} urls={prescriptions} setUrls={setPrescriptions}
          onUpload={trackUpload} disabled={placing} />
      )}
      {(
        <section className="card stack" aria-labelledby="checkout-h">
          <h2 id="checkout-h">{t('cart.howGet')}</h2>
          <fieldset className="choice">
            <legend>{t('cart.pickupOrDelivery')}</legend>
            {pickup && <label><input type="radio" name="mode" checked={mode === 'pickup'} onChange={() => setMode('pickup')} /> {t('cart.collect')}</label>}
            {delivery && <label><input type="radio" name="mode" checked={mode === 'delivery'} onChange={() => setMode('delivery')} /> {t('cart.deliver')}</label>}
          </fieldset>
          {mode === 'delivery' && (
            <TextArea label={t('cart.address')} value={address} maxLength={500} onChange={(e) => setAddress(e.target.value)} error={fieldError}
              hint={t('cart.addressHint')} />
          )}
          <fieldset className="choice">
            <legend>{t('cart.howPay')}</legend>
            <label><input type="radio" name="pay" checked={pay === 'online_payment'} onChange={() => setPay('online_payment')} /> {t('cart.payOnline')}</label>
            <label><input type="radio" name="pay" checked={pay !== 'online_payment'} onChange={() => setPay(offline)} />
              {' '}{mode === 'pickup' ? t('order.paymentMode.inStore') : t('order.paymentMode.cod')}</label>
          </fieldset>
          <TextArea label={t('cart.note')} value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
          {payMode === 'online_payment' && (
            <p className="muted">{t('cart.payWithin', { minutes: PHARMACY_PAYMENT_WINDOW_MIN })}</p>
          )}
          {error && <Alert>{error}</Alert>}
          {uploading > 0 && <p className="muted">{t('cart.attaching')}</p>}
          <Button busy={placing} disabled={busy || !modeAllowed || uploading > 0} onClick={() => void place()}>
            {payMode === 'online_payment' ? t('cart.placeAndPay', { amount: formatRupees(cart.subtotal) }) : t('cart.place', { amount: formatRupees(cart.subtotal) })}
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
    return clearedKey ? <Alert tone="ok">{t('cart.earlierNone')}</Alert> : null;
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
      {t('cart.lastAttempt')}{' '}
      <Button variant="secondary" busy={busy} onClick={() => void check()}>{t('cart.checkLast')}</Button>
      {error && error.key === key && <span> {error.message}</span>}
    </Alert>
  );
}

/**
 * P9: medicines that need a prescription are checked by the pharmacist before the order is packed. Attaching a
 * prescription is optional (images or PDF); without one the pharmacist may contact you.
 */
function PrescriptionUpload({ names, urls, setUrls, onUpload, disabled }: {
  names: string[]; urls: string[]; setUrls: (update: (current: string[]) => string[]) => void;
  onUpload: (delta: number) => void; disabled: boolean;
}) {
  const { api } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function add(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true); setError(null);
    onUpload(1);
    try {
      for (const f of Array.from(files)) {
        if (!/^(image\/(jpeg|png|webp)|application\/pdf)$/.test(f.type)) throw new Error(t('cart.rx.type'));
        if (f.size > 10 * 1024 * 1024) throw new Error(t('cart.rx.size'));
        const url = await customerPharmacyApi(api).uploadPrescription(f);
        // Appended to the list as it is NOW (a removal made meanwhile stays removed).
        setUrls((current) => (current.includes(url) ? current : [...current, url]));
      }
    } catch (err) {
      setError(err instanceof ApiError ? messageOf(err) : (err as Error).message || t('cart.rx.failed'));
    } finally {
      setBusy(false);
      onUpload(-1);
    }
  }
  return (
    <section className="card stack" aria-labelledby="rx-h">
      <h2 id="rx-h">{t('cart.rx.title')}</h2>
      <p>{t('cart.rx.needs', { count: names.length, names: names.join(', ') })}</p>
      <label className="file-pick">
        <span>{t('cart.rx.attach')}</span>
        <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" multiple disabled={busy || disabled}
          onChange={(e) => { void add(e.target.files); e.target.value = ''; }} />
      </label>
      {busy && <Loading label={t('cart.rx.attachingShort')} />}
      {error && <Alert>{error}</Alert>}
      {urls.length > 0 && (
        <ul className="plain">
          {urls.map((u, i) => (
            <li key={u} className="row-between">
              <span>{t('cart.rx.attached', { number: i + 1 })}</span>
              <Button variant="ghost" disabled={disabled} onClick={() => setUrls((current) => current.filter((x) => x !== u))}>{t('cart.rx.remove')}</Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
