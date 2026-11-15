import { Fragment, useMemo, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import {
  addressErrors, COUPON_PATTERN, customerApi, customerLabsApi, fromPaise, LAB_CANCEL_CUTOFF_HOURS, LAB_MAX_ITEMS, LAB_PAYMENT_WINDOW_MIN,
  type LabBookingPayment, type LabCatalogueItem, type LabSlot, type NewLabBooking, type PartnerLab, type VisitMode,
} from '@jansetu/api';
import { Alert, Button, Empty, ErrorState, formatRupees, Loading, TextField } from '@jansetu/ui';
import { messageOf, PageHeading } from '../../common.tsx';
import { PendingCreatePanel, useOnceOnly } from '../../onceOnly.tsx';
import { payOrder } from '../../payments.ts';
import { useCustomer, useSession } from '../../session.tsx';
import { nextDays } from '../DoctorScreen.tsx';
import { clock, VISIT_MODE_LABEL } from './labels.ts';

const DAYS = 7;
const isoDay = (yyyymmdd: string) => `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;

export function LabScreen() {
  const { partnerId = '' } = useParams();
  const { api } = useSession();
  const valid = /^[0-9a-fA-F]{24}$/.test(partnerId);
  // There is no single-lab read: the lab and its branches come from the (cached) list of labs.
  const labs = useQuery({ queryKey: ['partner-labs', {}], queryFn: () => customerLabsApi(api).labs({}), enabled: valid });
  const lab = labs.data?.find((l) => l.partnerId === partnerId);
  return (
    <>
      <Link to="/labs" className="back"><ArrowLeft size={16} aria-hidden="true" /> Lab tests</Link>
      {!valid ? <Empty title="Lab not found" />
        : labs.isPending ? <Loading /> : labs.isError ? <ErrorState message={messageOf(labs.error)} onRetry={() => void labs.refetch()} />
        : !lab ? <Empty title="This lab is not available">It may have stopped taking bookings. <Link to="/labs">See other labs</Link></Empty>
        : <LabView key={lab.partnerId} lab={lab} />}
    </>
  );
}

function LabView({ lab }: { lab: PartnerLab }) {
  const { api } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const profile = useQuery({ queryKey: ['me'], queryFn: () => customerApi(api).profile() });
  const payer = { name: profile.data?.name, contact: profile.data?.phone, email: profile.data?.email };
  const once = useOnceOnly<NewLabBooking, LabBookingPayment>(`lab-create:${lab.partnerId}`,
    (body, key) => customerLabsApi(api).book(body, key),
    async (r) => {
      await queryClient.invalidateQueries({ queryKey: ['lab-bookings'] });
      await queryClient.invalidateQueries({ queryKey: ['wallet'] });
      const path = `/partner-lab-bookings/${r.booking._id}`;
      if (r.paymentRequired && r.payment) {
        try {
          await payOrder(api, r.payment, payer, `Lab tests at ${lab.name}`);
        } catch (err) {
          navigate(path, { state: { paymentError: messageOf(err) } });
          return;
        }
      }
      navigate(path);
    });

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
      else if (n.size >= LAB_MAX_ITEMS) { setItemsError(`You can choose up to ${LAB_MAX_ITEMS} tests in one booking.`); return cur; }
      else n.add(item.itemId);
      return n;
    });
  }

  if (modes.length === 0 || !branch) return <Empty title="This lab is not taking bookings right now" />;
  return (
    <>
      <PageHeading title={lab.name}>
        {lab.branches.length === 1 ? [branch.name, branch.address?.city].filter(Boolean).join(', ') : `${lab.branches.length} branches`}
      </PageHeading>
      {once.pending ? (
        <PendingCreatePanel once={once} kind="lab_booking_create" what="lab booking request"
          onFound={(id) => navigate(`/partner-lab-bookings/${id}`)}>
          <Link to="/bookings">My bookings</Link>
        </PendingCreatePanel>
      ) : null}
      {once.pending && (once.pending.restored || once.pending.uncertain || !once.busy) ? null : (
        <>
          <section className="stack" aria-labelledby="how-h">
            <h2 id="how-h">How</h2>
            <div className="chips" role="group" aria-label="Visit type">
              {modes.map((m) => (
                <button key={m} type="button" className="chip" aria-pressed={m === mode} onClick={() => changeMode(m)}>{VISIT_MODE_LABEL[m]}</button>
              ))}
            </div>
            {branches.length > 1 ? (
              <div className="j-field">
                <label htmlFor="branch">Branch</label>
                <select id="branch" value={branch.branchId} onChange={(e) => { setBranchId(e.target.value); setSlot(null); }}>
                  {branches.map((b) => <option key={b.branchId} value={b.branchId}>{b.name}{b.address?.city ? `, ${b.address.city}` : ''}</option>)}
                </select>
              </div>
            ) : (
              <p className="muted">{branch.name}{branch.address ? ` · ${[branch.address.line1, branch.address.city, branch.address.pincode].filter(Boolean).join(', ')}` : ''}</p>
            )}
          </section>

          <section className="stack" aria-labelledby="tests-h">
            <h2 id="tests-h">Tests</h2>
            {catalogue.isPending ? <Loading label="Loading tests…" />
              : catalogue.isError ? <ErrorState message={messageOf(catalogue.error)} onRetry={() => void catalogue.refetch()} />
              : catalogue.data.length === 0 ? <Empty title={`No tests offered for ${VISIT_MODE_LABEL[mode].toLowerCase()}`} />
              : (
                <ul className="list" aria-describedby={itemsError ? 'items-error' : undefined}>
                  {catalogue.data.map((i) => (
                    <li key={i.itemId} className="list-row">
                      <label className="check">
                        <input type="checkbox" checked={picked.has(i.itemId)} onChange={() => toggle(i)} />
                        <span><strong>{i.name}</strong>{i.kind === 'package' ? ' (package)' : ''} · {formatRupees(fromPaise(i.priceMinor))}
                          {i.mrpMinor && i.mrpMinor > i.priceMinor ? <span className="muted"> <s>{formatRupees(fromPaise(i.mrpMinor))}</s></span> : null}</span>
                      </label>
                      {i.includes?.length ? <span className="muted">Includes {i.includes.join(', ')}</span> : null}
                      {i.preparation && <span className="muted">Preparation: {i.preparation}</span>}
                      {i.reportTatHours ? <span className="muted">Report in about {i.reportTatHours} hours</span> : null}
                    </li>
                  ))}
                </ul>
              )}
            {itemsError && <span id="items-error" className="j-field__error">{itemsError}</span>}
          </section>

          <section className="stack" aria-labelledby="time-h">
            <h2 id="time-h">Time</h2>
            <div className="chips" role="group" aria-label="Day">
              {days.map((x) => (
                <button key={x.date} type="button" className="chip" aria-pressed={isoDay(x.date) === day}
                  onClick={() => { setDay(isoDay(x.date)); setSlot(null); }}>{x.label}</button>
              ))}
            </div>
            {slots.isPending ? <Loading label="Loading times…" />
              : slots.isError ? <ErrorState message={messageOf(slots.error)} onRetry={() => void slots.refetch()} />
              : daySlots.length === 0 ? <Empty title="No free times on this day">Try another day.</Empty>
              : (
                <div className="chips" role="group" aria-label="Time">
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
              dayLabel={days.find((x) => isoDay(x.date) === day)?.label ?? day} once={once} />
          ) : (
            <p className="muted">Choose at least one test and a time to continue.</p>
          )}
        </>
      )}
    </>
  );
}

type Once = ReturnType<typeof useOnceOnly<NewLabBooking, LabBookingPayment>>;

function BookForm({ lab, branchId, mode, items, slot, dayLabel, once }: {
  lab: PartnerLab; branchId: string; mode: VisitMode; items: LabCatalogueItem[]; slot: LabSlot; dayLabel: string; once: Once;
}) {
  const { api } = useSession();
  const me = useCustomer();
  const c = customerApi(api);
  const profile = useQuery({ queryKey: ['me'], queryFn: () => c.profile() });
  const family = useQuery({ queryKey: ['dependents', me.id, 'all-first'], queryFn: () => c.dependents(me.id, 1, 50) });
  const wallet = useQuery({ queryKey: ['wallet', me.id], queryFn: () => c.wallet(me.id) });
  const [forWhom, setForWhom] = useState('');
  const p = profile.data;
  const [address, setAddress] = useState(() => ({ line1: p?.address ?? '', line2: '', city: p?.city ?? '', state: p?.state ?? '', pincode: p?.pincode ?? '', landmark: '' }));
  const [code, setCode] = useState('');
  const [coupon, setCoupon] = useState<{ code: string; discount: number } | null>(null);
  const [couponError, setCouponError] = useState<string | null>(null);
  const [useWallet, setUseWallet] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const subtotal = useMemo(() => items.reduce((a, i) => a + i.priceMinor, 0) / 100, [items]);
  const afterCoupon = Math.max(0, subtotal - (coupon?.discount ?? 0));
  const walletUse = useWallet ? Math.min(afterCoupon, Number(wallet.data?.balance ?? 0)) : 0;
  const toPay = Math.max(0, afterCoupon - walletUse);
  const set = (k: keyof typeof address) => (e: { target: { value: string } }) => setAddress((a) => ({ ...a, [k]: e.target.value }));

  async function applyCoupon() {
    setCouponError(null);
    const value = code.trim().toUpperCase();
    if (!COUPON_PATTERN.test(value)) { setCouponError('Enter a valid coupon code.'); return; }
    try {
      const r = await customerLabsApi(api).checkCoupon({ code: value, partnerId: lab.partnerId, purchaseAmount: subtotal,
        testIds: items.filter((i) => i.kind === 'test').map((i) => i.itemId), packageIds: items.filter((i) => i.kind === 'package').map((i) => i.itemId) });
      if (r?.isValid) setCoupon({ code: r.coupon?.code ?? value, discount: Math.min(subtotal, Number(r.discountAmount ?? 0)) });
      else { setCoupon(null); setCouponError(r?.message || 'This coupon cannot be used for these tests.'); }
    } catch (err) { setCoupon(null); setCouponError(messageOf(err)); }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
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
      ...(coupon ? { couponCode: coupon.code } : {}),
      useWalletBalance: useWallet,
    };
    void once.send(once.start(body, `${clock(slot.startTime)}, ${dayLabel}`));
  }

  return (
    <form className="card stack" onSubmit={submit} noValidate aria-labelledby="book-h">
      <h2 id="book-h">Book {clock(slot.startTime)}, {dayLabel}</h2>
      <div className="j-field">
        <label htmlFor="who">For</label>
        <select id="who" value={forWhom} onChange={(e) => { setForWhom(e.target.value); setCoupon(null); }}>
          <option value="">Myself</option>
          {(family.data?.items ?? []).filter((x) => x.relationship !== 'Me').map((x) => (
            <option key={x._id} value={x._id}>{x.name} ({x.relationship})</option>
          ))}
        </select>
      </div>
      {mode === 'home' && (
        <fieldset className="stack fieldset-plain">
          <legend>Collection address</legend>
          <TextField label="House and street" value={address.line1} onChange={set('line1')} error={errors.line1} maxLength={200} autoComplete="address-line1" />
          <TextField label="Area (optional)" value={address.line2} onChange={set('line2')} error={errors.line2} maxLength={200} autoComplete="address-line2" />
          <TextField label="Landmark (optional)" value={address.landmark} onChange={set('landmark')} error={errors.landmark} maxLength={120} />
          <TextField label="City" value={address.city} onChange={set('city')} error={errors.city} maxLength={80} autoComplete="address-level2" />
          <TextField label="State (optional)" value={address.state} onChange={set('state')} error={errors.state} maxLength={80} autoComplete="address-level1" />
          <TextField label="Pincode" value={address.pincode} onChange={set('pincode')} error={errors.pincode} inputMode="numeric" maxLength={6} autoComplete="postal-code" />
        </fieldset>
      )}
      {subtotal > 0 && (
        <div className="stack">
          <div className="row">
            <TextField label="Coupon (optional)" value={code} onChange={(e) => { setCode(e.target.value.toUpperCase()); setCoupon(null); }}
              error={couponError} autoCapitalize="characters" />
            <Button variant="secondary" onClick={() => void applyCoupon()} disabled={!code.trim()}>Apply</Button>
          </div>
          {coupon && <Alert tone="ok">Coupon {coupon.code}: {formatRupees(coupon.discount)} off.</Alert>}
          {Number(wallet.data?.balance ?? 0) > 0 && (
            <label className="check"><input type="checkbox" checked={useWallet} onChange={(e) => setUseWallet(e.target.checked)} />
              Use my wallet ({formatRupees(wallet.data?.balance)})</label>
          )}
        </div>
      )}
      <dl className="details" aria-label="Price">
        {items.map((i) => <Fragment key={i.itemId}><dt>{i.name}</dt><dd>{formatRupees(fromPaise(i.priceMinor))}</dd></Fragment>)}
        {coupon ? <><dt>Coupon</dt><dd>−{formatRupees(coupon.discount)}</dd></> : null}
        {walletUse > 0 ? <><dt>From wallet</dt><dd>−{formatRupees(walletUse)}</dd></> : null}
        <dt>To pay now</dt><dd><strong>{formatRupees(toPay)}</strong></dd>
      </dl>
      <p className="muted">
        The final amount is worked out by the lab’s prices on the server and shown on the payment page. Pay within
        {' '}{LAB_PAYMENT_WINDOW_MIN} minutes or the time is released. You can cancel for a full refund to your wallet until
        {' '}{LAB_CANCEL_CUTOFF_HOURS} hours before the time.
      </p>
      {once.error && <Alert>{once.error}</Alert>}
      <Button type="submit" busy={once.busy}>{toPay > 0 ? 'Book and pay' : 'Book'}</Button>
    </form>
  );
}
