import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import {
  ApiError, COUPON_PATTERN, customerApi, fromPaise, INSTANT_MODE_LABEL, CUSTOMER_INSTANT_MODES as INSTANT_MODES, INSTANT_OFFER_MIN, INSTANT_PAYMENT_WINDOW_MIN,
  instantConsultApi, instantPayableMinor, type CustomerInstantMode as InstantMode, type InstantPayment, type InstantTarget, type NewInstantRequest,
} from '@jansetu/api';
import { Alert, Button, Empty, ErrorState, formatRupees, Loading, TextField } from '@jansetu/ui';
import { messageOf, PageHeading, relationshipLabel } from '../../common.tsx';
import { t } from '../../i18n/index.ts';
import { PendingCreatePanel, useOnceOnly } from '../../onceOnly.tsx';
import { payOrder } from '../../payments.ts';
import { usePriceAgreement } from '../../priceAgreement.ts';
import { useCustomer, useSession } from '../../session.tsx';

const SLOT = 'instant-create';

/** Per way of consulting: the empty list's title and what a request is for (whole phrases, not the mode's name inside). */
const MODE_WORDS = {
  video: { noneOnline: 'consult.noDoctorOnline.video', forDoctor: 'consult.requestFor.video.doctor', forAny: 'consult.requestFor.video.any' },
  call: { noneOnline: 'consult.noDoctorOnline.call', forDoctor: 'consult.requestFor.call.doctor', forAny: 'consult.requestFor.call.any' },
  chat: { noneOnline: 'consult.noDoctorOnline.chat', forDoctor: 'consult.requestFor.chat.doctor', forAny: 'consult.requestFor.chat.any' },
} as const satisfies Record<InstantMode, unknown>;

/** "Consult now": how and a speciality, an online doctor (or any available) at the quoted price, paid upfront. */
export function ConsultScreen() {
  const { api } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const me = useCustomer();
  const profile = useQuery({ queryKey: ['me', me.id], queryFn: () => customerApi(api).profile() });
  const payer = { name: profile.data?.name, contact: profile.data?.phone, email: profile.data?.email };
  // Q9: a refused price (409 QUOTE_CHANGED) re-reads the quote and re-checks the coupon; the form then asks the
  // customer to accept the new price before anything can be sent again.
  const [quoteRefusals, setQuoteRefusals] = useState(0);
  const once = useOnceOnly<NewInstantRequest, InstantPayment>(SLOT, (body, key) => instantConsultApi(api).create(body, key), async (r, alive) => {
    await queryClient.invalidateQueries({ queryKey: ['instant-requests'] });
    await queryClient.invalidateQueries({ queryKey: ['wallet'] });
    if (!alive()) return; // the customer left: the request is in My bookings, nothing opens on its own
    const path = `/consult/requests/${r.request._id}`;
    if (r.paymentRequired && r.payment) {
      try {
        await payOrder(api, r.payment, payer, t('consult.payDescription', { speciality: r.request.specialization }));
      } catch (err) {
        if (alive()) navigate(path, { state: { paymentError: messageOf(err) } });
        return;
      }
    }
    if (alive()) navigate(path);
  }, (err) => {
    // The server checks the coupon before the quote (INVALID_COUPON comes first): both mean the shown price is stale.
    if (err instanceof ApiError && (err.code === 'QUOTE_CHANGED' || err.code === 'INVALID_COUPON')) {
      void queryClient.invalidateQueries({ queryKey: ['instant-quote'] });
      void queryClient.invalidateQueries({ queryKey: ['instant-doctors'] });
      setQuoteRefusals((n) => n + 1);
    }
  }, { kind: 'instant_request_create', onFound: (id) => navigate(`/consult/requests/${id}`) });

  const [mode, setMode] = useState<InstantMode>('video');
  const [speciality, setSpeciality] = useState('');
  const [specError, setSpecError] = useState<string | null>(null);
  const [search, setSearch] = useState<{ specialization: string; mode: InstantMode } | null>(null);
  // Q9: the specialities customers can ask for, with how many doctors are online now for this mode (always fresh).
  const specialities = useQuery({ queryKey: ['instant-specialities', mode], queryFn: () => instantConsultApi(api).specialities(mode), staleTime: 0 });

  function find(e: FormEvent) {
    e.preventDefault();
    if (!speciality) { setSpecError(t('consult.specialityMissing')); return; }
    setSpecError(null);
    setSearch({ specialization: speciality, mode });
  }

  const locked = !!once.pending && (once.pending.restored || once.pending.uncertain || !once.busy);
  return (
    <>
      <PageHeading title={t('common.consultNow')}>{t('consult.sub')}</PageHeading>
      <PendingCreatePanel once={once} kind="instant_request_create" onFound={(id) => navigate(`/consult/requests/${id}`)}>
        <Link to="/bookings">{t('common.myBookings')}</Link>
      </PendingCreatePanel>
      {!locked && (
        <>
          <form className="card stack" onSubmit={find} noValidate aria-labelledby="need-h">
            <h2 id="need-h">{t('consult.need')}</h2>
            <fieldset className="choice">
              <legend>{t('common.how')}</legend>
              {INSTANT_MODES.map((m) => (
                <label key={m}><input type="radio" name="mode" checked={mode === m} onChange={() => { setMode(m); setSearch(null); }} /> {INSTANT_MODE_LABEL[m]}</label>
              ))}
            </fieldset>
            {specialities.isPending ? <Loading label={t('consult.loadingSpecialities')} />
              : specialities.isError ? <ErrorState message={messageOf(specialities.error)} onRetry={() => void specialities.refetch()} />
              : specialities.data.length === 0 ? <Empty title={t('consult.noSpecialities')} />
              : (
                <div className="j-field">
                  <label htmlFor="speciality">{t('consult.speciality')}</label>
                  <select id="speciality" value={speciality} aria-invalid={specError ? true : undefined} aria-describedby={specError ? 'speciality-error' : undefined}
                    onChange={(e) => { setSpeciality(e.target.value); setSearch(null); setSpecError(null); }}>
                    <option value="">{t('common.choose')}</option>
                    {specialities.data.map((x) => (
                      <option key={x.specialization} value={x.specialization}>
                        {x.specialization} · {x.onlineNow > 0 ? t('consult.onlineNow', { number: x.onlineNow }) : t('consult.nobodyOnlineNow')}
                      </option>
                    ))}
                  </select>
                  {specError && <span id="speciality-error" className="j-field__error">{specError}</span>}
                </div>
              )}
            <div className="row">
              <Button type="submit" disabled={!specialities.data?.length}>{t('consult.seeOnline')}</Button>
              <Button variant="ghost" onClick={() => void specialities.refetch()}>{t('common.refresh')}</Button>
            </div>
          </form>
          {search && <Doctors key={`${search.specialization}:${search.mode}`} search={search} once={once} quoteRefusals={quoteRefusals} />}
        </>
      )}
    </>
  );
}

type Once = ReturnType<typeof useOnceOnly<NewInstantRequest, InstantPayment>>;

function Doctors({ search, once, quoteRefusals }: { search: { specialization: string; mode: InstantMode }; once: Once; quoteRefusals: number }) {
  const { api } = useSession();
  const doctors = useQuery({ queryKey: ['instant-doctors', search], queryFn: () => instantConsultApi(api).doctors(search.specialization, search.mode),
    staleTime: 0 }); // presence is live: always read it again
  const [target, setTarget] = useState<InstantTarget | null>(null);
  return (
    <section className="stack" aria-labelledby="online-h">
      <h2 id="online-h">{t('consult.onlineHeading')}</h2>
      {doctors.isPending ? <Loading label={t('common.findingDoctors')} />
        : doctors.isError ? <ErrorState message={messageOf(doctors.error)} onRetry={() => void doctors.refetch()} />
        : doctors.data.length === 0 ? (
          <Empty title={t(MODE_WORDS[search.mode].noneOnline, { speciality: search.specialization })}>
            <Button variant="secondary" onClick={() => void doctors.refetch()}>{t('common.checkAgain')}</Button>
            <Link to="/doctors">{t('consult.bookLater')}</Link>
          </Empty>
        ) : (
          <>
            <fieldset className="stack fieldset-plain">
              <legend>{t('common.doctor')}</legend>
              <label className="check">
                <input type="radio" name="doctor" checked={target?.kind === 'any'} onChange={() => setTarget({ kind: 'any' })} />
                <span>{t('consult.anyDoctorOnline', { number: doctors.data.length })}</span>
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
              quoteRefusals={quoteRefusals}
              doctorName={target.kind === 'specific' ? doctors.data.find((d) => d.doctorId === target.doctorId)?.name : undefined} />}
          </>
        )}
    </section>
  );
}

function QuoteForm({ search, target, doctorName, once, quoteRefusals }: {
  search: { specialization: string; mode: InstantMode }; target: InstantTarget; doctorName?: string; once: Once; quoteRefusals: number;
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
  /** The code the customer applied; checked again whenever the quote or the patient changes. */
  const [applied, setApplied] = useState<string | null>(null);
  const [coupon, setCoupon] = useState<{ code: string; discount: number; ctx: string } | null>(null);
  /**
   * The coupon the customer chose (applied or removed by hand). The price agreement follows this choice, not whether the
   * coupon still checks out: a coupon dropped by an automatic re-check raises the price, which must be accepted again.
   */
  const [chosen, setChosen] = useState<string | null>(null);
  const [couponBusy, setCouponBusy] = useState(false);
  const [couponError, setCouponError] = useState<string | null>(null);
  const [useWallet, setUseWallet] = useState(true);

  const quoteMinor = quote.data?.quotedAmountMinor;
  const ctx = `${doctorId ?? 'any'}|${forWhom}|${quoteMinor ?? ''}`;
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const current = coupon && coupon.ctx === ctx ? coupon : null;
  const payableMinor = quoteMinor === undefined ? 0 : instantPayableMinor(quoteMinor, current?.discount);
  const couponSettled = !couponBusy && (!applied || !!current || !!couponError);
  // What the customer chose (price excluded): a changed quote or discount for the same choice must be accepted again.
  const agreement = usePriceAgreement(`${doctorId ?? 'any'}|${forWhom}|${chosen ?? ''}`, `${quoteMinor}:${payableMinor}`,
    quoteMinor !== undefined && !quote.isFetching && couponSettled);

  const seq = useRef(0);
  async function checkCoupon(value: string, forCtx: string, price: number, dependentId: string) {
    const mine = ++seq.current;
    const stale = () => mine !== seq.current || ctxRef.current !== forCtx;
    setCouponBusy(true); setCouponError(null);
    try {
      const r = await instantConsultApi(api).checkCoupon({ code: value, purchaseAmount: price, doctorId, dependentId: dependentId || undefined });
      if (stale()) return; // asked for another price or patient: a newer check (or none) decides
      if (r?.isValid) setCoupon({ code: r.coupon?.code ?? value, discount: Math.min(price, Number(r.discountAmount ?? 0)), ctx: forCtx });
      else { setCoupon(null); setApplied(null); setCouponError(t('consult.couponNotForConsult', { code: value })); }
    } catch (err) {
      if (stale()) return;
      setCoupon(null); setApplied(null); setCouponError(messageOf(err));
    } finally {
      if (mine === seq.current) setCouponBusy(false);
    }
  }
  useEffect(() => {
    if (applied && quoteMinor !== undefined && coupon?.ctx !== ctx) void checkCoupon(applied, ctx, quoteMinor / 100, forWhom);
  }, [ctx]);
  useEffect(() => {
    if (quoteRefusals > 0 && applied && quoteMinor !== undefined) { setCoupon(null); void checkCoupon(applied, ctx, quoteMinor / 100, forWhom); }
  }, [quoteRefusals]);

  if (quote.isPending) return <Loading label={t('consult.gettingPrice')} />;
  if (quote.isError) return <ErrorState message={messageOf(quote.error)} onRetry={() => void quote.refetch()} />;
  const price = quote.data.quotedAmountMinor / 100;
  const afterCoupon = payableMinor / 100;
  const walletUse = useWallet ? Math.min(afterCoupon, Number(wallet.data?.balance ?? 0)) : 0;
  const toPay = Math.max(0, afterCoupon - walletUse);

  async function applyCoupon() {
    setCouponError(null);
    const value = code.trim().toUpperCase();
    if (!COUPON_PATTERN.test(value)) { setCouponError(t('common.couponInvalid')); return; }
    setChosen(value);
    setApplied(value);
    await checkCoupon(value, ctx, price, forWhom);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!agreement.agreed || quoteMinor === undefined) return;
    void once.send(once.start({
      target, specialization: search.specialization, mode: search.mode,
      patient: forWhom ? { kind: 'dependent', dependentId: forWhom } : { kind: 'self' },
      ...(current ? { couponCode: current.code } : {}), useWalletBalance: useWallet,
      // Q9: exactly the quote and payable on screen, which the customer agreed to; the server refuses any other.
      acceptedQuoteMinor: quoteMinor, acceptedPayableMinor: payableMinor,
    }, doctorName !== undefined ? t(MODE_WORDS[search.mode].forDoctor, { doctor: doctorName })
      : t(MODE_WORDS[search.mode].forAny, { speciality: search.specialization })));
  }

  return (
    <form className="card stack" onSubmit={submit} noValidate aria-labelledby="pay-h">
      <h2 id="pay-h">{doctorName ?? t('consult.anyDoctor')}</h2>
      <Alert tone="ok">
        {target.kind === 'any'
          ? t('consult.youPayAny', { price: formatRupees(price), doctors: quote.data.doctors })
          : t('consult.youPay', { price: formatRupees(price) })}
        {` ${t('consult.offerTime', { minutes: INSTANT_OFFER_MIN })}`}
      </Alert>
      <div className="j-field">
        <label htmlFor="who">{t('common.for')}</label>
        <select id="who" value={forWhom} onChange={(e) => setForWhom(e.target.value)}>
          <option value="">{t('common.myself')}</option>
          {(family.data?.items ?? []).filter((x) => x.relationship !== 'Me').map((x) => (
            <option key={x._id} value={x._id}>{x.name} ({relationshipLabel(x.relationship)})</option>
          ))}
        </select>
      </div>
      {price > 0 && (
        <div className="stack">
          <div className="row">
            <TextField label={t('common.couponOptional')} value={code} onChange={(e) => { setCode(e.target.value.toUpperCase()); setChosen(null); setApplied(null); setCoupon(null); setCouponError(null); }}
              error={couponError} autoCapitalize="characters" />
            <Button variant="secondary" busy={couponBusy} onClick={() => void applyCoupon()} disabled={!code.trim()}>{t('common.apply')}</Button>
          </div>
          {couponBusy && applied && <p className="muted" role="status">{t('consult.checkingCoupon', { code: applied })}</p>}
          {current && !couponBusy && <Alert tone="ok">{t('common.couponOff', { code: current.code, amount: formatRupees(current.discount) })}</Alert>}
          {Number(wallet.data?.balance ?? 0) > 0 && (
            <label className="check"><input type="checkbox" checked={useWallet} onChange={(e) => setUseWallet(e.target.checked)} />
              {t('common.useWallet', { amount: formatRupees(wallet.data?.balance) })}</label>
          )}
        </div>
      )}
      <dl className="details" aria-label={t('common.price')}>
        <dt>{t('consult.quotedPrice')}</dt><dd>{formatRupees(price)}</dd>
        {current ? <><dt>{t('common.coupon')}</dt><dd>−{formatRupees(current.discount)}</dd></> : null}
        {walletUse > 0 ? <><dt>{t('common.fromWallet')}</dt><dd>−{formatRupees(walletUse)}</dd></> : null}
        <dt>{t('common.toPayNow')}</dt><dd><strong>{formatRupees(toPay)}</strong></dd>
      </dl>
      <p className="muted">{t('consult.serverChecks', { minutes: INSTANT_PAYMENT_WINDOW_MIN })}</p>
      {once.error && <Alert>{once.error}</Alert>}
      {agreement.changed && (
        <div className="confirm" role="group" aria-label={t('common.priceChanged')}>
          <Alert tone="warn">
            {agreement.previous
              ? t('consult.priceChangedWas', { quote: formatRupees(price), pay: formatRupees(afterCoupon), was: formatRupees(Number(agreement.previous.split(':')[1]) / 100) })
              : t('consult.priceChanged', { quote: formatRupees(price), pay: formatRupees(afterCoupon) })}
          </Alert>
          <div className="row"><Button variant="secondary" onClick={agreement.accept}>{t('common.acceptNewPrice')}</Button></div>
        </div>
      )}
      <Button type="submit" busy={once.busy || couponBusy} disabled={!agreement.agreed}>{toPay > 0 ? t('consult.payAndRequest') : t('consult.request')}</Button>
    </form>
  );
}
