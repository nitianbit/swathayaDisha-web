import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import {
  COUPON_PATTERN, customerApi, fromPaise, INSTANT_MODE_LABEL, INSTANT_MODES, INSTANT_OFFER_MIN, INSTANT_PAYMENT_WINDOW_MIN, instantConsultApi,
  SPECIALITY_LIMITS, type InstantMode, type InstantPayment, type InstantTarget, type NewInstantRequest,
} from '@jansetu/api';
import { Alert, Button, Empty, ErrorState, formatRupees, Loading, TextField } from '@jansetu/ui';
import { messageOf, PageHeading } from '../../common.tsx';
import { PendingCreatePanel, useOnceOnly } from '../../onceOnly.tsx';
import { payOrder } from '../../payments.ts';
import { useCustomer, useSession } from '../../session.tsx';

const SLOT = 'instant-create';

/** "Consult now": a speciality and how, an online doctor (or any available) at the quoted price, paid upfront. */
export function ConsultScreen() {
  const { api } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const profile = useQuery({ queryKey: ['me'], queryFn: () => customerApi(api).profile() });
  const payer = { name: profile.data?.name, contact: profile.data?.phone, email: profile.data?.email };
  const once = useOnceOnly<NewInstantRequest, InstantPayment>(SLOT, (body, key) => instantConsultApi(api).create(body, key), async (r) => {
    await queryClient.invalidateQueries({ queryKey: ['instant-requests'] });
    await queryClient.invalidateQueries({ queryKey: ['wallet'] });
    const path = `/consult/requests/${r.request._id}`;
    if (r.paymentRequired && r.payment) {
      try {
        await payOrder(api, r.payment, payer, `Consultation now · ${r.request.specialization}`);
      } catch (err) {
        navigate(path, { state: { paymentError: messageOf(err) } });
        return;
      }
    }
    navigate(path);
  });

  const [text, setText] = useState('');
  const [mode, setMode] = useState<InstantMode>('video');
  const [specError, setSpecError] = useState<string | null>(null);
  const [search, setSearch] = useState<{ specialization: string; mode: InstantMode } | null>(null);

  function find(e: FormEvent) {
    e.preventDefault();
    const v = text.trim();
    if (v.length < SPECIALITY_LIMITS.min || v.length > SPECIALITY_LIMITS.max) { setSpecError('Enter a speciality, for example General Physician.'); return; }
    setSpecError(null);
    setSearch({ specialization: v, mode });
  }

  const locked = !!once.pending && (once.pending.restored || once.pending.uncertain || !once.busy);
  return (
    <>
      <PageHeading title="Consult now">Talk to a doctor who is online now. You pay first; if nobody can take it, you get your money back in your wallet.</PageHeading>
      <PendingCreatePanel once={once} kind="instant_request_create" what="consultation request" onFound={(id) => navigate(`/consult/requests/${id}`)}>
        <Link to="/bookings">My bookings</Link>
      </PendingCreatePanel>
      {!locked && (
        <>
          <form className="card stack" onSubmit={find} noValidate aria-labelledby="need-h">
            <h2 id="need-h">What do you need?</h2>
            <TextField label="Speciality" value={text} onChange={(e) => { setText(e.target.value); setSearch(null); }} error={specError}
              hint="For example General Physician, Dermatology, Paediatrics" maxLength={SPECIALITY_LIMITS.max} />
            <fieldset className="choice">
              <legend>How</legend>
              {INSTANT_MODES.map((m) => (
                <label key={m}><input type="radio" name="mode" checked={mode === m} onChange={() => { setMode(m); setSearch(null); }} /> {INSTANT_MODE_LABEL[m]}</label>
              ))}
            </fieldset>
            <Button type="submit">See who is online</Button>
          </form>
          {search && <Doctors key={`${search.specialization}:${search.mode}`} search={search} once={once} />}
        </>
      )}
    </>
  );
}

type Once = ReturnType<typeof useOnceOnly<NewInstantRequest, InstantPayment>>;

function Doctors({ search, once }: { search: { specialization: string; mode: InstantMode }; once: Once }) {
  const { api } = useSession();
  const doctors = useQuery({ queryKey: ['instant-doctors', search], queryFn: () => instantConsultApi(api).doctors(search.specialization, search.mode),
    staleTime: 0 }); // presence is live: always read it again
  const [target, setTarget] = useState<InstantTarget | null>(null);
  return (
    <section className="stack" aria-labelledby="online-h">
      <h2 id="online-h">Online now</h2>
      {doctors.isPending ? <Loading label="Finding doctors online…" />
        : doctors.isError ? <ErrorState message={messageOf(doctors.error)} onRetry={() => void doctors.refetch()} />
        : doctors.data.length === 0 ? (
          <Empty title={`No ${search.specialization} doctor is online for a ${INSTANT_MODE_LABEL[search.mode].toLowerCase()} right now`}>
            <Button variant="secondary" onClick={() => void doctors.refetch()}>Check again</Button>
            <Link to="/doctors">Book a doctor for later</Link>
          </Empty>
        ) : (
          <>
            <fieldset className="stack fieldset-plain">
              <legend>Doctor</legend>
              <label className="check">
                <input type="radio" name="doctor" checked={target?.kind === 'any'} onChange={() => setTarget({ kind: 'any' })} />
                <span>Any available doctor ({doctors.data.length} online)</span>
              </label>
              {doctors.data.map((d) => (
                <label key={d.doctorId} className="check">
                  <input type="radio" name="doctor" checked={target?.kind === 'specific' && target.doctorId === d.doctorId}
                    onChange={() => setTarget({ kind: 'specific', doctorId: d.doctorId })} />
                  <span>{d.name} · {formatRupees(fromPaise(d.instantFeeMinor))}{d.rating ? <span className="muted"> · {d.rating.toFixed(1)}★</span> : null}</span>
                </label>
              ))}
            </fieldset>
            {target && <QuoteForm key={target.kind === 'specific' ? target.doctorId : 'any'} search={search} target={target} once={once}
              doctorName={target.kind === 'specific' ? doctors.data.find((d) => d.doctorId === target.doctorId)?.name : undefined} />}
          </>
        )}
    </section>
  );
}

function QuoteForm({ search, target, doctorName, once }: {
  search: { specialization: string; mode: InstantMode }; target: InstantTarget; doctorName?: string; once: Once;
}) {
  const { api } = useSession();
  const me = useCustomer();
  const c = customerApi(api);
  const doctorId = target.kind === 'specific' ? target.doctorId : undefined;
  const quote = useQuery({ queryKey: ['instant-quote', search, doctorId ?? 'any'], queryFn: () => instantConsultApi(api).quote(search.specialization, search.mode, doctorId),
    staleTime: 0 });
  const family = useQuery({ queryKey: ['dependents', me.id, 'all-first'], queryFn: () => c.dependents(me.id, 1, 50) });
  const wallet = useQuery({ queryKey: ['wallet', me.id], queryFn: () => c.wallet(me.id) });
  const [forWhom, setForWhom] = useState('');
  const [code, setCode] = useState('');
  const [coupon, setCoupon] = useState<{ code: string; discount: number } | null>(null);
  const [couponError, setCouponError] = useState<string | null>(null);
  const [useWallet, setUseWallet] = useState(true);

  if (quote.isPending) return <Loading label="Getting the price…" />;
  if (quote.isError) return <ErrorState message={messageOf(quote.error)} onRetry={() => void quote.refetch()} />;
  const price = fromPaise(quote.data.quotedAmountMinor) ?? 0;
  const afterCoupon = Math.max(0, price - (coupon?.discount ?? 0));
  const walletUse = useWallet ? Math.min(afterCoupon, Number(wallet.data?.balance ?? 0)) : 0;
  const toPay = Math.max(0, afterCoupon - walletUse);

  async function applyCoupon() {
    setCouponError(null);
    const value = code.trim().toUpperCase();
    if (!COUPON_PATTERN.test(value)) { setCouponError('Enter a valid coupon code.'); return; }
    try {
      const r = await instantConsultApi(api).checkCoupon({ code: value, purchaseAmount: price, doctorId, dependentId: forWhom || undefined });
      if (r?.isValid) setCoupon({ code: r.coupon?.code ?? value, discount: Math.min(price, Number(r.discountAmount ?? 0)) });
      else { setCoupon(null); setCouponError('This coupon cannot be used for this consultation.'); }
    } catch (err) { setCoupon(null); setCouponError(messageOf(err)); }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void once.send(once.start({
      target, specialization: search.specialization, mode: search.mode,
      patient: forWhom ? { kind: 'dependent', dependentId: forWhom } : { kind: 'self' },
      ...(coupon ? { couponCode: coupon.code } : {}), useWalletBalance: useWallet,
    }, `${INSTANT_MODE_LABEL[search.mode].toLowerCase()} with ${doctorName ?? `any ${search.specialization} doctor`}`));
  }

  return (
    <form className="card stack" onSubmit={submit} noValidate aria-labelledby="pay-h">
      <h2 id="pay-h">{doctorName ?? 'Any available doctor'}</h2>
      <Alert tone="ok">
        {target.kind === 'any'
          ? `You pay ${formatRupees(price)} now (the highest fee among the ${quote.data.doctors} doctors online). If the doctor who accepts charges less, the difference goes back to your wallet.`
          : `You pay ${formatRupees(price)} now.`}
        {` Each doctor has ${INSTANT_OFFER_MIN} minutes to accept. If nobody does, you can offer it again or get your money back in your wallet.`}
      </Alert>
      <div className="j-field">
        <label htmlFor="who">For</label>
        <select id="who" value={forWhom} onChange={(e) => { setForWhom(e.target.value); setCoupon(null); }}>
          <option value="">Myself</option>
          {(family.data?.items ?? []).filter((x) => x.relationship !== 'Me').map((x) => (
            <option key={x._id} value={x._id}>{x.name} ({x.relationship})</option>
          ))}
        </select>
      </div>
      {price > 0 && (
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
        <dt>Quoted price</dt><dd>{formatRupees(price)}</dd>
        {coupon ? <><dt>Coupon</dt><dd>−{formatRupees(coupon.discount)}</dd></> : null}
        {walletUse > 0 ? <><dt>From wallet</dt><dd>−{formatRupees(walletUse)}</dd></> : null}
        <dt>To pay now</dt><dd><strong>{formatRupees(toPay)}</strong></dd>
      </dl>
      <p className="muted">The server confirms the price when you request. Pay within {INSTANT_PAYMENT_WINDOW_MIN} minutes.</p>
      {once.error && <Alert>{once.error}</Alert>}
      <Button type="submit" busy={once.busy}>{toPay > 0 ? 'Pay and request a doctor' : 'Request a doctor'}</Button>
    </form>
  );
}
