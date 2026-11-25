import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import {
  ApiError, addressErrors, COUPON_PATTERN, customerApi, customerLabsApi, fromPaise, LAB_CANCEL_CUTOFF_HOURS, LAB_MAX_ITEMS, LAB_PAYMENT_WINDOW_MIN,
  labPayableMinor,
  type LabBookingPayment, type LabCatalogueItem, type CustomerLabSlot as LabSlot, type NewLabBooking, type PartnerLab, type CustomerVisitMode as VisitMode,
} from '@jansetu/api';
import { Alert, Button, Empty, ErrorState, formatRupees, Loading, TextField } from '@jansetu/ui';
import { messageOf, PageHeading, relationshipLabel } from '../../common.tsx';
import { t } from '../../i18n/index.ts';
import { PendingCreatePanel, useOnceOnly } from '../../onceOnly.tsx';
import { payOrder } from '../../payments.ts';
import { usePriceAgreement } from '../../priceAgreement.ts';
import { useCustomer, useSession } from '../../session.tsx';
import { nextDays } from '../DoctorScreen.tsx';
import { clock, visitModeLabel } from './labels.ts';

const DAYS = 7;
const isoDay = (yyyymmdd: string) => `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;

export function LabScreen() {
  const { partnerId = '' } = useParams();
  const { api } = useSession();
  const valid = /^[0-9a-fA-F]{24}$/.test(partnerId);
  // Q9: one lab with its active branches.
  const q = useQuery({ queryKey: ['partner-lab', partnerId], queryFn: () => customerLabsApi(api).lab(partnerId), enabled: valid });
  const gone = q.error instanceof ApiError && q.error.status === 404;
  return (
    <>
      <Link to="/labs" className="back"><ArrowLeft size={16} aria-hidden="true" /> {t('common.labTests')}</Link>
      {!valid ? <Empty title={t('lab.notFound')} />
        : q.isPending ? <Loading />
        : gone ? <Empty title={t('lab.gone')}>{t('lab.goneBody')} <Link to="/labs">{t('lab.otherLabs')}</Link></Empty>
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : <LabView key={q.data.partnerId} lab={q.data} />}
    </>
  );
}

function LabView({ lab }: { lab: PartnerLab }) {
  const { api } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const me = useCustomer();
  const profile = useQuery({ queryKey: ['me', me.id], queryFn: () => customerApi(api).profile() });
  const payer = { name: profile.data?.name, contact: profile.data?.phone, email: profile.data?.email };
  // Q9: a refused price (409 PRICE_CHANGED) re-reads the prices and re-checks the coupon; the form then asks the
  // customer to accept the new price before anything can be sent again.
  const [priceRefusals, setPriceRefusals] = useState(0);
  const once = useOnceOnly<NewLabBooking, LabBookingPayment>(`lab-create:${lab.partnerId}`,
    (body, key) => customerLabsApi(api).book(body, key),
    async (r, alive) => {
      await queryClient.invalidateQueries({ queryKey: ['lab-bookings'] });
      await queryClient.invalidateQueries({ queryKey: ['wallet'] });
      if (!alive()) return; // the customer left: the booking is in My bookings, nothing opens on its own
      const path = `/partner-lab-bookings/${r.booking._id}`;
      if (r.paymentRequired && r.payment) {
        try {
          await payOrder(api, r.payment, payer, t('lab.payDescription', { lab: lab.name }));
        } catch (err) {
          if (alive()) navigate(path, { state: { paymentError: messageOf(err) } });
          return;
        }
      }
      if (alive()) navigate(path);
    },
    (err) => {
      // The server checks the coupon before the price (INVALID_COUPON comes first): both mean the shown price is stale.
      if (err instanceof ApiError && (err.code === 'PRICE_CHANGED' || err.code === 'INVALID_COUPON')) {
        void queryClient.invalidateQueries({ queryKey: ['partner-lab-catalogue', lab.partnerId] });
        setPriceRefusals((n) => n + 1);
      }
    }, { kind: 'lab_booking_create', onFound: (id) => navigate(`/partner-lab-bookings/${id}`) });

  const modes = (['home', 'lab'] as VisitMode[]).filter((m) => lab.branches.some((b) => (m === 'home' ? b.homeCollection : b.inLab)));
  const [mode, setMode] = useState<VisitMode>(modes[0] ?? 'lab');
  const branches = lab.branches.filter((b) => (mode === 'home' ? b.homeCollection : b.inLab));
  const [branchId, setBranchId] = useState(branches[0]?.branchId ?? '');
  const branch = branches.find((b) => b.branchId === branchId) ?? branches[0];
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [itemsError, setItemsError] = useState<string | null>(null);
  const days = nextDays(DAYS);
  const [day, setDay] = useState(isoDay(days[0]!.date));
  const [slot, setSlot] = useState<LabSlot | null>(null);

  const catalogue = useQuery({ queryKey: ['partner-lab-catalogue', lab.partnerId, mode], queryFn: () => customerLabsApi(api).catalogue(lab.partnerId, mode) });
  const slots = useQuery({
    queryKey: ['partner-lab-slots', branch?.branchId, mode, isoDay(days[0]!.date)],
    queryFn: () => customerLabsApi(api).slots(branch!.branchId, mode, isoDay(days[0]!.date), DAYS),
    enabled: !!branch,
  });
  const chosen = (catalogue.data ?? []).filter((i) => picked.has(i.itemId));
  const daySlots = (slots.data ?? []).filter((s) => s.date === day);

  function changeMode(m: VisitMode) {
    setMode(m); setSlot(null); setPicked(new Set());
    const next = lab.branches.filter((b) => (m === 'home' ? b.homeCollection : b.inLab));
    setBranchId(next[0]?.branchId ?? '');
  }
  function toggle(item: LabCatalogueItem) {
    setItemsError(null);
    setPicked((cur) => {
      const n = new Set(cur);
      if (n.has(item.itemId)) n.delete(item.itemId);
      else if (n.size >= LAB_MAX_ITEMS) { setItemsError(t('lab.maxItems', { max: LAB_MAX_ITEMS })); return cur; }
      else n.add(item.itemId);
      return n;
    });
  }

  if (modes.length === 0 || !branch) return <Empty title={t('lab.notTaking')} />;
  return (
    <>
      <PageHeading title={lab.name}>
        {lab.branches.length === 1 ? [branch.name, branch.address?.city].filter(Boolean).join(', ') : t('labs.branches', { count: lab.branches.length })}
      </PageHeading>
      {once.pending ? (
        <PendingCreatePanel once={once} kind="lab_booking_create"
          onFound={(id) => navigate(`/partner-lab-bookings/${id}`)}>
          <Link to="/bookings">{t('common.myBookings')}</Link>
        </PendingCreatePanel>
      ) : null}
      {once.pending && (once.pending.restored || once.pending.uncertain || !once.busy) ? null : (
        <>
          <section className="stack" aria-labelledby="how-h">
            <h2 id="how-h">{t('common.how')}</h2>
            <div className="chips" role="group" aria-label={t('lab.visitType')}>
              {modes.map((m) => (
                <button key={m} type="button" className="chip" aria-pressed={m === mode} onClick={() => changeMode(m)}>{visitModeLabel(m)}</button>
              ))}
            </div>
            {branches.length > 1 ? (
              <div className="j-field">
                <label htmlFor="branch">{t('lab.branch')}</label>
                <select id="branch" value={branch.branchId} onChange={(e) => { setBranchId(e.target.value); setSlot(null); }}>
                  {branches.map((b) => <option key={b.branchId} value={b.branchId}>{b.name}{b.address?.city ? `, ${b.address.city}` : ''}</option>)}
                </select>
              </div>
            ) : (
              <p className="muted">{branch.name}{branch.address ? ` · ${[branch.address.line1, branch.address.city, branch.address.pincode].filter(Boolean).join(', ')}` : ''}</p>
            )}
          </section>

          <section className="stack" aria-labelledby="tests-h">
            <h2 id="tests-h">{t('lab.tests')}</h2>
            {catalogue.isPending ? <Loading label={t('lab.loadingTests')} />
              : catalogue.isError ? <ErrorState message={messageOf(catalogue.error)} onRetry={() => void catalogue.refetch()} />
              : catalogue.data.length === 0 ? <Empty title={mode === 'home' ? t('lab.noTests.home') : t('lab.noTests.lab')} />
              : (
                <ul className="list" aria-describedby={itemsError ? 'items-error' : undefined}>
                  {catalogue.data.map((i) => (
                    <li key={i.itemId} className="list-row">
                      <label className="check">
                        <input type="checkbox" checked={picked.has(i.itemId)} onChange={() => toggle(i)} />
                        <span><strong>{i.name}</strong>{i.kind === 'package' ? ` (${t('lab.packageTag')})` : ''} · {formatRupees(fromPaise(i.priceMinor))}
                          {i.mrpMinor && i.mrpMinor > i.priceMinor ? <span className="muted"> <s>{formatRupees(fromPaise(i.mrpMinor))}</s></span> : null}</span>
                      </label>
                      {i.includes?.length ? <span className="muted">{t('lab.includes', { tests: i.includes.join(', ') })}</span> : null}
                      {i.preparation && <span className="muted">{t('lab.preparation', { text: i.preparation })}</span>}
                      {i.reportTatHours ? <span className="muted">{t('lab.reportIn', { hours: i.reportTatHours })}</span> : null}
                    </li>
                  ))}
                </ul>
              )}
            {itemsError && <span id="items-error" className="j-field__error">{itemsError}</span>}
          </section>

          <section className="stack" aria-labelledby="time-h">
            <h2 id="time-h">{t('common.time')}</h2>
            <div className="chips" role="group" aria-label={t('common.day')}>
              {days.map((x) => (
                <button key={x.date} type="button" className="chip" aria-pressed={isoDay(x.date) === day}
                  onClick={() => { setDay(isoDay(x.date)); setSlot(null); }}>{x.label}</button>
              ))}
            </div>
            {slots.isPending ? <Loading label={t('common.loadingTimes')} />
              : slots.isError ? <ErrorState message={messageOf(slots.error)} onRetry={() => void slots.refetch()} />
              : daySlots.length === 0 ? <Empty title={t('common.noFreeTimes')}>{t('common.tryAnotherDay')}</Empty>
              : (
                <div className="chips" role="group" aria-label={t('common.time')}>
                  {daySlots.map((s) => (
                    <button key={s.slotId} type="button" className="chip" aria-pressed={slot?.slotId === s.slotId} onClick={() => setSlot(s)}>
                      {clock(s.startTime)}
                    </button>
                  ))}
                </div>
              )}
          </section>

          {chosen.length > 0 && slot ? (
            <BookForm key={`${branch.branchId}:${slot.slotId}`} lab={lab} branchId={branch.branchId} mode={mode} items={chosen} slot={slot}
              dayLabel={days.find((x) => isoDay(x.date) === day)?.label ?? day} once={once} priceRefusals={priceRefusals} />
          ) : (
            <p className="muted">{t('lab.chooseTestAndTime')}</p>
          )}
        </>
      )}
    </>
  );
}

type Once = ReturnType<typeof useOnceOnly<NewLabBooking, LabBookingPayment>>;

function BookForm({ lab, branchId, mode, items, slot, dayLabel, once, priceRefusals }: {
  lab: PartnerLab; branchId: string; mode: VisitMode; items: LabCatalogueItem[]; slot: LabSlot; dayLabel: string; once: Once; priceRefusals: number;
}) {
  const { api } = useSession();
  const me = useCustomer();
  const c = customerApi(api);
  const profile = useQuery({ queryKey: ['me', me.id], queryFn: () => c.profile() });
  const family = useQuery({ queryKey: ['dependents', me.id, 'all-first'], queryFn: () => c.dependents(me.id, 1, 50) });
  const wallet = useQuery({ queryKey: ['wallet', me.id], queryFn: () => c.wallet(me.id) });
  const [forWhom, setForWhom] = useState('');
  const p = profile.data;
  const [address, setAddress] = useState(() => ({ line1: p?.address ?? '', line2: '', city: p?.city ?? '', state: p?.state ?? '', pincode: p?.pincode ?? '', landmark: '' }));
  const [code, setCode] = useState('');
  /** The code the customer applied; it is checked again for every change of lab, visit type, tests or prices. */
  const [applied, setApplied] = useState<string | null>(null);
  /** A coupon result is valid only for the exact context it was checked for. */
  const [coupon, setCoupon] = useState<{ code: string; discount: number; ctx: string } | null>(null);
  /**
   * The coupon the customer chose (applied or removed by hand). The price agreement follows this choice, not whether the
   * coupon still checks out: a coupon dropped by an automatic re-check raises the price, which must be accepted again.
   */
  const [chosen, setChosen] = useState<string | null>(null);
  const [couponBusy, setCouponBusy] = useState(false);
  const [couponError, setCouponError] = useState<string | null>(null);
  const [useWallet, setUseWallet] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const subtotalMinor = useMemo(() => items.reduce((a, i) => a + i.priceMinor, 0), [items]);
  const subtotal = subtotalMinor / 100;
  const ctx = `${lab.partnerId}|${mode}|${items.map((i) => `${i.itemId}:${i.kind}:${i.priceMinor}`).sort().join(',')}`;
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const current = coupon && coupon.ctx === ctx ? coupon : null;
  const payableMinor = labPayableMinor(subtotalMinor, current?.discount);
  const afterCoupon = payableMinor / 100;
  const walletUse = useWallet ? Math.min(afterCoupon, Number(wallet.data?.balance ?? 0)) : 0;
  const toPay = Math.max(0, afterCoupon - walletUse);
  const set = (k: keyof typeof address) => (e: { target: { value: string } }) => setAddress((a) => ({ ...a, [k]: e.target.value }));
  const couponSettled = !couponBusy && (!applied || !!current || !!couponError);
  // What the customer chose (prices excluded): a price change for the same tests and chosen coupon must be accepted again.
  const agreement = usePriceAgreement(`${lab.partnerId}|${mode}|${items.map((i) => i.itemId).sort().join(',')}|${chosen ?? ''}`,
    `${subtotalMinor}:${payableMinor}`, couponSettled);

  const seq = useRef(0);
  async function checkCoupon(value: string, forCtx: string, forItems: LabCatalogueItem[]) {
    const mine = ++seq.current;
    const stale = () => mine !== seq.current || ctxRef.current !== forCtx;
    setCouponBusy(true); setCouponError(null);
    try {
      const sub = forItems.reduce((a, i) => a + i.priceMinor, 0) / 100;
      const r = await customerLabsApi(api).checkCoupon({ code: value, partnerId: lab.partnerId, purchaseAmount: sub,
        testIds: forItems.filter((i) => i.kind === 'test').map((i) => i.itemId), packageIds: forItems.filter((i) => i.kind === 'package').map((i) => i.itemId) });
      if (stale()) return; // asked for other tests or prices: a newer check (or none) decides
      if (r?.isValid) setCoupon({ code: r.coupon?.code ?? value, discount: Math.min(sub, Number(r.discountAmount ?? 0)), ctx: forCtx });
      else { setCoupon(null); setApplied(null); setCouponError(r?.message || t('lab.couponNotForTests', { code: value })); }
    } catch (err) {
      if (stale()) return;
      setCoupon(null); setApplied(null); setCouponError(messageOf(err));
    } finally {
      if (mine === seq.current) setCouponBusy(false);
    }
  }
  async function applyCoupon() {
    setCouponError(null);
    const value = code.trim().toUpperCase();
    if (!COUPON_PATTERN.test(value)) { setCouponError(t('common.couponInvalid')); return; }
    setChosen(value);
    setApplied(value);
    await checkCoupon(value, ctx, items);
  }
  // Tests, visit type or prices changed: the applied coupon is checked again for exactly what is now chosen.
  useEffect(() => { if (applied && coupon?.ctx !== ctx) void checkCoupon(applied, ctx, items); }, [ctx]);
  // The server refused the price: re-check the coupon too (its discount may have changed).
  useEffect(() => { if (priceRefusals > 0 && applied) { setCoupon(null); void checkCoupon(applied, ctx, items); } }, [priceRefusals]);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!agreement.agreed) return;
    const errs = mode === 'home' ? addressErrors(address) : {};
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const trimmed = Object.fromEntries(Object.entries(address).map(([k, v]) => [k, v.trim()]));
    const body: NewLabBooking = {
      partnerId: lab.partnerId, branchId, visitMode: mode, slotId: slot.slotId, itemIds: items.map((i) => i.itemId),
      patient: forWhom ? { kind: 'dependent', dependentId: forWhom } : { kind: 'self' },
      ...(mode === 'home' ? { address: {
        line1: trimmed.line1!, city: trimmed.city!, pincode: trimmed.pincode!,
        ...(trimmed.line2 ? { line2: trimmed.line2 } : {}), ...(trimmed.state ? { state: trimmed.state } : {}), ...(trimmed.landmark ? { landmark: trimmed.landmark } : {}),
      } } : {}),
      ...(current ? { couponCode: current.code } : {}),
      useWalletBalance: useWallet,
      // Q9: exactly the price on screen, which the customer agreed to; the server refuses any other.
      acceptedPayableMinor: payableMinor, acceptedSubtotalMinor: subtotalMinor,
    };
    void once.send(once.start(body, `${clock(slot.startTime)}, ${dayLabel}`));
  }

  return (
    <form className="card stack" onSubmit={submit} noValidate aria-labelledby="book-h">
      <h2 id="book-h">{t('common.bookAt', { time: `${clock(slot.startTime)}, ${dayLabel}` })}</h2>
      <div className="j-field">
        <label htmlFor="who">{t('common.for')}</label>
        {/* WQ11a: the applied coupon is checked again for the new patient (never left half-applied, which kept Book off). */}
        <select id="who" value={forWhom} onChange={(e) => { setForWhom(e.target.value); if (applied) { setCoupon(null); void checkCoupon(applied, ctx, items); } }}>
          <option value="">{t('common.myself')}</option>
          {(family.data?.items ?? []).filter((x) => x.relationship !== 'Me').map((x) => (
            <option key={x._id} value={x._id}>{x.name} ({relationshipLabel(x.relationship)})</option>
          ))}
        </select>
      </div>
      {mode === 'home' && (
        <fieldset className="stack fieldset-plain">
          <legend>{t('lab.address')}</legend>
          <TextField label={t('lab.line1')} value={address.line1} onChange={set('line1')} error={errors.line1} maxLength={200} autoComplete="address-line1" />
          <TextField label={t('lab.line2')} value={address.line2} onChange={set('line2')} error={errors.line2} maxLength={200} autoComplete="address-line2" />
          <TextField label={t('lab.landmark')} value={address.landmark} onChange={set('landmark')} error={errors.landmark} maxLength={120} />
          <TextField label={t('lab.city')} value={address.city} onChange={set('city')} error={errors.city} maxLength={80} autoComplete="address-level2" />
          <TextField label={t('lab.state')} value={address.state} onChange={set('state')} error={errors.state} maxLength={80} autoComplete="address-level1" />
          <TextField label={t('lab.pincode')} value={address.pincode} onChange={set('pincode')} error={errors.pincode} inputMode="numeric" maxLength={6} autoComplete="postal-code" />
        </fieldset>
      )}
      {subtotal > 0 && (
        <div className="stack">
          <div className="row">
            <TextField label={t('common.couponOptional')} value={code} onChange={(e) => { setCode(e.target.value.toUpperCase()); setChosen(null); setApplied(null); setCoupon(null); setCouponError(null); }}
              error={couponError} autoCapitalize="characters" />
            <Button variant="secondary" busy={couponBusy} onClick={() => void applyCoupon()} disabled={!code.trim()}>{t('common.apply')}</Button>
          </div>
          {couponBusy && applied && <p className="muted" role="status">{t('lab.checkingCoupon', { code: applied })}</p>}
          {current && !couponBusy && <Alert tone="ok">{t('common.couponOff', { code: current.code, amount: formatRupees(current.discount) })}</Alert>}
          {Number(wallet.data?.balance ?? 0) > 0 && (
            <label className="check"><input type="checkbox" checked={useWallet} onChange={(e) => setUseWallet(e.target.checked)} />
              {t('common.useWallet', { amount: formatRupees(wallet.data?.balance) })}</label>
          )}
        </div>
      )}
      <dl className="details" aria-label={t('common.price')}>
        {items.map((i) => <Fragment key={i.itemId}><dt>{i.name}</dt><dd>{formatRupees(fromPaise(i.priceMinor))}</dd></Fragment>)}
        {current ? <><dt>{t('common.coupon')}</dt><dd>−{formatRupees(current.discount)}</dd></> : null}
        {walletUse > 0 ? <><dt>{t('common.fromWallet')}</dt><dd>−{formatRupees(walletUse)}</dd></> : null}
        <dt>{t('common.toPayNow')}</dt><dd><strong>{formatRupees(toPay)}</strong></dd>
      </dl>
      <p className="muted">{t('lab.finalAmount', { minutes: LAB_PAYMENT_WINDOW_MIN, hours: LAB_CANCEL_CUTOFF_HOURS })}</p>
      {once.error && <Alert>{once.error}</Alert>}
      {agreement.changed && (
        <div className="confirm" role="group" aria-label={t('common.priceChanged')}>
          <Alert tone="warn">
            {agreement.previous
              ? t('lab.priceChangedWas', { amount: formatRupees(afterCoupon), was: formatRupees(Number(agreement.previous.split(':')[1]) / 100) })
              : t('lab.priceChanged', { amount: formatRupees(afterCoupon) })}
          </Alert>
          <div className="row"><Button variant="secondary" onClick={agreement.accept}>{t('common.acceptNewPrice')}</Button></div>
        </div>
      )}
      <Button type="submit" busy={once.busy || couponBusy} disabled={!agreement.agreed}>{toPay > 0 ? t('common.bookAndPay') : t('common.book')}</Button>
    </form>
  );
}
