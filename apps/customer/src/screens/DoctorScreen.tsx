import { useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import {
  COUPON_PATTERN, customerApi, type ConsultationMode, type CouponCheck, type NewConsultation, type Slot, type Specialist, requestKeysApi } from '@jansetu/api';
import { formatDateWith, INDIA_TIME } from '@jansetu/i18n';
import { Alert, Button, Empty, ErrorState, formatRupees, Loading, TextArea, TextField } from '@jansetu/ui';
import { Confirm, messageOf, PageHeading, relationshipLabel } from '../common.tsx';
import { t, type CustomerKey } from '../i18n/index.ts';
import { useAlive } from '../onceOnly.tsx';
import { payOrder } from '../payments.ts';
import { afterFailure, beginAttempt, settleByAbandon, startOp, stillCurrent, type PendingOp } from '../pending.ts';
import { useCustomer, useSession } from '../session.tsx';

/** The next `n` days as IST calendar dates (YYYYMMDD) with a short label. */
export function nextDays(n: number, now = new Date()): { date: string; label: string }[] {
  const out: { date: string; label: string }[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getTime() + i * 86_400_000);
    const ist = new Date(d.getTime() + 5.5 * 3_600_000);
    const date = ist.toISOString().slice(0, 10).replace(/-/g, '');
    const label = i === 0 ? t('doctor.today') : i === 1 ? t('doctor.tomorrow')
      : formatDateWith(d, { weekday: 'short', day: 'numeric', month: 'short', timeZone: INDIA_TIME });
    out.push({ date, label });
  }
  return out;
}

const MODE_LABEL: Readonly<Record<ConsultationMode, CustomerKey>> = {
  'in-person': 'doctor.mode.inPerson', video: 'doctor.mode.video', call: 'doctor.mode.call', chat: 'doctor.mode.chat',
};

/** Modes this doctor offers: clinic visits and phone calls always; video and chat when the doctor accepts them. */
export function modesOf(d: Specialist): ConsultationMode[] {
  const m: ConsultationMode[] = ['in-person', 'call'];
  if (d.availability?.acceptVideoConsultations) m.push('video');
  if (d.availability?.acceptChatConsultations) m.push('chat');
  return m;
}

export function DoctorScreen() {
  const { doctorId = '' } = useParams();
  const { api } = useSession();
  const valid = /^[0-9a-fA-F]{24}$/.test(doctorId);
  const q = useQuery({ queryKey: ['doctor', doctorId], queryFn: () => customerApi(api).doctor(doctorId), enabled: valid });
  return (
    <>
      <Link to="/doctors" className="back"><ArrowLeft size={16} aria-hidden="true" /> {t('doctor.back')}</Link>
      {!valid ? <Empty title={t('doctor.notFound')} />
        : q.isPending ? <Loading /> : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : <DoctorView doctor={q.data} />}
    </>
  );
}

type PendingCreate = PendingOp<NewConsultation> & { label: string };

/**
 * Creating a booking happens once per intent. The request is stored (session memory, per doctor) with its key before
 * it is sent; after an unanswered attempt the form is replaced by "send it again" (same key and details; the server
 * returns the first booking for a known key) or "give it up", also after choosing another slot or leaving the page.
 * WQ11a (as `useOnceOnly`): an answer counts only for the newest attempt of the request that still owns the slot, on
 * a page still on screen; payment and navigation never start for a page the customer left.
 */
function useCreateBooking(doctor: Specialist) {
  const { api, memory } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const slotKey = `consult-create:${doctor._id}`;
  const [pending, setPendingState] = useState<PendingCreate | undefined>(() => memory.get<PendingCreate>(slotKey));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setPending = (p: PendingCreate | undefined) => { if (p) memory.set(slotKey, p); else memory.delete(slotKey); setPendingState(p); };
  const alive = useAlive();
  const seq = useRef(0);

  async function send(p: PendingCreate, payer: { name?: string; contact?: string; email?: string }) {
    const attempt: PendingCreate = { ...beginAttempt(p), label: p.label };
    const mine = ++seq.current;
    const done = () => { if (seq.current === mine && alive.current) setBusy(false); };
    setBusy(true);
    setError(null);
    setPending(attempt);
    let created;
    try {
      created = await customerApi(api).bookConsultation(attempt.body, attempt.requestKey);
    } catch (err) {
      const owns = () => stillCurrent(memory.get<PendingCreate>(slotKey), attempt);
      if (!owns()) { done(); return; } // a newer attempt, or nothing, owns it
      const next = afterFailure(attempt, err, messageOf(err));
      if (next && settleByAbandon(attempt, err)) {
        // N5: refused for good after an unanswered attempt (bookings answer 400 SLOT_NOT_AVAILABLE / SLOT_FULL after
        // the key lookup): only the server's abandon says whether it was booked.
        setPending({ ...next, label: attempt.label });
        try {
          const r = await requestKeysApi(api).abandon('booking_create', attempt.requestKey);
          if (!owns() || !alive.current) return;
          if (r.state === 'abandoned') { setPending(undefined); setError(messageOf(err)); }
          else if (r.record?._id) { setPending(undefined); navigate(`/bookings/${r.record._id}`); }
          else setPending({ ...next, label: attempt.label, error: t('doctor.bookedNotShownShort') });
        } catch { /* not settled: it stays unconfirmed (send again or give it up) */ } finally { done(); }
        return;
      }
      done();
      if (next) { setPending({ ...next, label: attempt.label }); return; }
      setPending(undefined);
      setError(messageOf(err)); // refused for good: nothing was booked; the form stays as typed
      return;
    }
    // Only the newest attempt, on a page still on screen, finishes the booking (an older or abandoned page's answer
    // leaves the stored request alone: sending it again, or a check after a reload, gets the same booking).
    if (!alive.current || !stillCurrent(memory.get<PendingCreate>(slotKey), attempt)) { done(); return; }
    memory.delete(slotKey);
    setPendingState(undefined);
    try {
      await queryClient.invalidateQueries({ queryKey: ['bookings'] });
      await queryClient.invalidateQueries({ queryKey: ['wallet'] });
      if (!alive.current) return; // the customer left: the booking is in My bookings, nothing opens on its own
      const bookingPath = `/bookings/${created.booking._id}`;
      // A resent create that finished an interrupted creation also returns its payment order: pay it now.
      if (created.paymentRequired && created.payment) {
        try {
          await payOrder(api, created.payment, payer, t('doctor.payDescription', { doctor: doctor.name }));
        } catch (err) {
          // The booking exists; the payment page could not open. The booking page offers to pay or check.
          if (alive.current) navigate(bookingPath, { state: { paymentError: messageOf(err) } });
          return;
        }
      }
      if (alive.current) navigate(bookingPath);
    } finally {
      done();
    }
  }

  /** D4: a restored request whose booking was found: end it and open the booking. */
  /** Ends the stored request `requestKey` only if it is still the stored one (a newer one may exist). */
  const endIfCurrent = (requestKey: string) => {
    if (memory.get<PendingCreate>(slotKey)?.requestKey !== requestKey) return false;
    memory.delete(slotKey);
    setPendingState((cur) => (cur && cur.requestKey !== requestKey ? cur : undefined));
    return true;
  };
  /** D4: a restored request whose booking was found: end it and open the booking. */
  const found = (requestKey: string, bookingId: string) => { if (endIfCurrent(requestKey)) navigate(`/bookings/${bookingId}`); };
  /** D4: a restored request abandoned on the server: forget it, the form is usable again. */
  const discard = (requestKey: string) => { endIfCurrent(requestKey); };
  /** WQ11a: gives up an unanswered request on the server (abandon): then it can never be booked. */
  const giveUp = async (requestKey: string) => {
    const r = await requestKeysApi(api).abandon('booking_create', requestKey);
    if (!alive.current) return null;
    if (r.state === 'abandoned') { discard(requestKey); return null; }
    if (r.record?._id) { found(requestKey, r.record._id); return null; } // it was booked: the server names the booking
    return t('doctor.bookedAfterAll');
  };

  return { pending, busy, error, send, found, discard, giveUp, start: (body: NewConsultation, label: string) => ({ ...startOp(body), label }) };
}

/**
 * D4: a booking request made before the page was reloaded whose answer was never seen. Its details are not kept on this
 * device, so it cannot be resent from here: the customer's bookings are searched for its key; a new booking is allowed
 * only after the server has abandoned the old key (then the old request can never be booked).
 */
function RestoredRequest({ pending, onFound, onDiscard }: {
  pending: PendingCreate; onFound: (bookingId: string) => void; onDiscard: () => void;
}) {
  const { api } = useSession();
  const [busy, setBusy] = useState<'check' | 'cancel' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  async function find(): Promise<string | null> {
    for (let page = 1; page <= 5; page++) {
      const p = await customerApi(api).bookings(page, 50);
      const hit = p.items.find((b) => b.createRequestKey === pending.requestKey);
      if (hit) return hit._id;
      if (page >= p.totalPages) break;
    }
    return null;
  }
  async function check() {
    setBusy('check'); setNote(null);
    try {
      const id = await find();
      if (id) { onFound(id); return; }
      setNotFound(true);
      setNote(t('doctor.restored.notFound'));
    } catch (err) {
      setNote(t('doctor.restored.checkFailed', { message: messageOf(err) }));
    } finally {
      setBusy(null);
    }
  }
  async function cancelIt() {
    setBusy('cancel'); setNote(null);
    try {
      const r = await requestKeysApi(api).abandon('booking_create', pending.requestKey);
      if (r.state === 'abandoned') { onDiscard(); return; }
      if (r.record?._id) { onFound(r.record._id); return; } // it was booked: the server names the booking
      setNotFound(false);
      setNote(t('doctor.bookedNotShown'));
    } catch (err) {
      setNote(t('doctor.restored.cancelFailed', { message: messageOf(err) }));
    } finally {
      setBusy(null);
    }
  }
  return (
    <section className="card stack" role="group" aria-label={t('doctor.unconfirmed')}>
      <Alert tone="warn">{t('doctor.restored.body')}</Alert>
      {note && <Alert>{note}</Alert>}
      <div className="row">
        <Button busy={busy === 'check'} disabled={busy === 'cancel'} onClick={() => void check()}>{t('doctor.restored.check')}</Button>
        {notFound && <Button variant="secondary" busy={busy === 'cancel'} disabled={busy === 'check'} onClick={() => void cancelIt()}>{t('doctor.restored.cancel')}</Button>}
      </div>
    </section>
  );
}

function DoctorView({ doctor: d }: { doctor: Specialist }) {
  const { api } = useSession();
  const create = useCreateBooking(d);
  const [giveUpNote, setGiveUpNote] = useState<string | null>(null);
  const me = useCustomer();
  const profile = useQuery({ queryKey: ['me', me.id], queryFn: () => customerApi(api).profile() });
  const payer = { name: profile.data?.name, contact: profile.data?.phone, email: profile.data?.email };
  const days = nextDays(14);
  const [date, setDate] = useState(days[0]!.date);
  const [slot, setSlot] = useState<Slot | null>(null);
  const slots = useQuery({ queryKey: ['slots', d._id, date], queryFn: () => customerApi(api).doctorSlots(d._id, date) });
  const fee = d.isConsultationFree ? 0 : Number(d.consultationFee ?? 0);
  return (
    <>
      <PageHeading title={d.name}>{[d.specialization, d.degree].filter(Boolean).join(' · ')}</PageHeading>
      <section className="card stack">
        <dl className="details">
          {d.experienceYears ? <><dt>{t('doctor.experience')}</dt><dd>{t('common.years', { years: d.experienceYears })}</dd></> : null}
          {d.hospitalOrClinic && <><dt>{t('doctor.clinic')}</dt><dd>{d.hospitalOrClinic}{d.city ? `, ${d.city}` : ''}</dd></>}
          {d.languages?.length ? <><dt>{t('doctor.languages')}</dt><dd>{d.languages.join(', ')}</dd></> : null}
          <dt>{t('common.fee')}</dt><dd>{fee ? formatRupees(fee) : t('doctor.free')}</dd>
        </dl>
        {d.bio && <p className="muted">{d.bio}</p>}
      </section>
      {/* The panel is for a request whose outcome is unknown: after a failed attempt, or one restored from an
          earlier visit (it may still be running). A first attempt in flight keeps the form, with a busy button. */}
      {create.pending?.restored ? (
        <RestoredRequest pending={create.pending} onFound={(id) => create.found(create.pending!.requestKey, id)}
          onDiscard={() => create.discard(create.pending!.requestKey)} />
      ) : create.pending && (create.pending.uncertain || !create.busy) ? (
        <section className="card stack" role="group" aria-label={t('doctor.unconfirmed')}>
          <Alert tone="warn">
            {create.pending.error ? t('doctor.noAnswerWhy', { label: create.pending.label, error: create.pending.error })
              : t('doctor.noAnswer', { label: create.pending.label })}
          </Alert>
          {giveUpNote && <Alert>{giveUpNote}</Alert>}
          <div className="row">
            <Button busy={create.busy} onClick={() => void create.send(create.pending!, payer)}>{t('common.sendAgain')}</Button>
            <Link to="/bookings">{t('common.myBookings')}</Link>
          </div>
          <Confirm label={t('doctor.giveUp')} confirmLabel={t('common.yesGiveUp')} disabled={create.busy}
            consequence={t('doctor.giveUpConsequence')}
            onConfirm={async () => setGiveUpNote(await create.giveUp(create.pending!.requestKey))} />
        </section>
      ) : (
      <>
      <section className="stack" aria-labelledby="when-h">
        <h2 id="when-h">{t('doctor.chooseTime')}</h2>
        <div className="chips" role="group" aria-label={t('common.day')}>
          {days.map((x) => (
            <button key={x.date} type="button" className="chip" aria-pressed={x.date === date}
              onClick={() => { setDate(x.date); setSlot(null); }}>{x.label}</button>
          ))}
        </div>
        {slots.isPending ? <Loading label={t('common.loadingTimes')} />
          : slots.isError ? <ErrorState message={messageOf(slots.error)} onRetry={() => void slots.refetch()} />
          : slots.data.length === 0 ? <Empty title={t('common.noFreeTimes')}>{t('common.tryAnotherDay')}</Empty>
          : (
            <div className="chips" role="group" aria-label={t('common.time')}>
              {slots.data.map((s) => (
                <button key={s._id} type="button" className="chip" aria-pressed={slot?._id === s._id} onClick={() => setSlot(s)}>{s.startTime}</button>
              ))}
            </div>
          )}
      </section>
      {slot && <BookForm key={slot._id} doctor={d} slot={slot} fee={fee} dayLabel={days.find((x) => x.date === date)?.label ?? ''}
        create={create} payer={payer} />}
      </>
      )}
    </>
  );
}

function BookForm({ doctor: d, slot, fee, dayLabel, create, payer }: {
  doctor: Specialist; slot: Slot; fee: number; dayLabel: string; create: ReturnType<typeof useCreateBooking>;
  payer: { name?: string; contact?: string; email?: string };
}) {
  const { api } = useSession();
  const me = useCustomer();
  const c = customerApi(api);
  const family = useQuery({ queryKey: ['dependents', me.id, 'all-first'], queryFn: () => c.dependents(me.id, 1, 50) });
  const wallet = useQuery({ queryKey: ['wallet', me.id], queryFn: () => c.wallet(me.id) });
  const modes = modesOf(d);
  const [forWhom, setForWhom] = useState('');
  const [mode, setMode] = useState<ConsultationMode>(modes[0]!);
  const [concern, setConcern] = useState('');
  const [code, setCode] = useState('');
  const [coupon, setCoupon] = useState<(CouponCheck & { code: string }) | null>(null);
  const [couponError, setCouponError] = useState<string | null>(null);
  const [useWallet, setUseWallet] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const afterCoupon = coupon?.isValid ? Number(coupon.finalAmount ?? fee) : fee;
  const walletUse = useWallet ? Math.min(afterCoupon, Number(wallet.data?.balance ?? 0)) : 0;
  const toPay = Math.max(0, afterCoupon - walletUse);

  async function applyCoupon() {
    setCouponError(null);
    const value = code.trim().toUpperCase();
    if (!COUPON_PATTERN.test(value)) { setCouponError(t('common.couponInvalid')); return; }
    try {
      const r = await c.checkCoupon({ code: value, specialistId: d._id, purchaseAmount: fee, ...(forWhom ? { dependentId: forWhom } : {}) });
      if (r?.isValid) setCoupon({ ...r, code: value }); else { setCoupon(null); setCouponError(t('doctor.couponNotForBooking')); }
    } catch (err) { setCoupon(null); setCouponError(messageOf(err)); }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (concern.trim().length < 3) errs.concern = t('doctor.concernMissing');
    setErrors(errs);
    if (Object.keys(errs).length) return;
    void create.send(create.start({
      specialistId: d._id, slotId: slot._id, bookingDate: slot.date, bookingTime: slot.startTime, consultationMode: mode,
      primaryConcern: concern.trim(), ...(forWhom ? { dependentId: forWhom } : {}),
      ...(coupon?.isValid ? { couponCode: coupon.code } : {}), useWalletBalance: useWallet,
    }, `${slot.startTime}, ${dayLabel}`), payer);
  }

  return (
    <form className="card stack" onSubmit={submit} noValidate aria-labelledby="book-h">
      <h2 id="book-h">{t('common.bookAt', { time: slot.startTime })}</h2>
      <div className="j-field">
        <label htmlFor="who">{t('common.for')}</label>
        {/* A coupon is checked for one patient: a new patient drops it, and says so (WQ11a). */}
        <select id="who" value={forWhom} onChange={(e) => {
          setForWhom(e.target.value);
          if (coupon?.isValid) setCouponError(t('doctor.couponRemoved', { code: coupon.code }));
          setCoupon(null);
        }}>
          <option value="">{t('common.myself')}</option>
          {(family.data?.items ?? []).filter((x) => x.relationship !== 'Me').map((x) => (
            <option key={x._id} value={x._id}>{x.name} ({relationshipLabel(x.relationship)})</option>
          ))}
        </select>
      </div>
      <fieldset className="choice">
        <legend>{t('common.how')}</legend>
        {modes.map((m) => (
          <label key={m}><input type="radio" name="mode" checked={mode === m} onChange={() => setMode(m)} /> {t(MODE_LABEL[m])}</label>
        ))}
      </fieldset>
      <TextArea label={t('doctor.concern')} value={concern} onChange={(e) => setConcern(e.target.value)} error={errors.concern} maxLength={1000} />
      {fee > 0 && (
        <div className="stack">
          <div className="row">
            <TextField label={t('common.couponOptional')} value={code} onChange={(e) => { setCode(e.target.value.toUpperCase()); setCoupon(null); }}
              error={couponError} autoCapitalize="characters" />
            <Button variant="secondary" onClick={() => void applyCoupon()} disabled={!code.trim()}>{t('common.apply')}</Button>
          </div>
          {coupon?.isValid && <Alert tone="ok">{t('common.couponOff', { code: coupon.code, amount: formatRupees(coupon.discountAmount ?? 0) })}</Alert>}
          {Number(wallet.data?.balance ?? 0) > 0 && (
            <label className="check"><input type="checkbox" checked={useWallet} onChange={(e) => setUseWallet(e.target.checked)} />
              {t('common.useWallet', { amount: formatRupees(wallet.data?.balance) })}</label>
          )}
        </div>
      )}
      <dl className="details" aria-label={t('common.price')}>
        <dt>{t('common.fee')}</dt><dd>{fee ? formatRupees(fee) : t('doctor.free')}</dd>
        {coupon?.isValid ? <><dt>{t('common.coupon')}</dt><dd>−{formatRupees(coupon.discountAmount ?? 0)}</dd></> : null}
        {walletUse > 0 ? <><dt>{t('common.fromWallet')}</dt><dd>−{formatRupees(walletUse)}</dd></> : null}
        <dt>{t('common.toPayNow')}</dt><dd><strong>{formatRupees(toPay)}</strong></dd>
      </dl>
      <p className="muted">{t('doctor.finalAmount')}</p>
      {create.error && <Alert>{create.error}</Alert>}
      <Button type="submit" busy={create.busy}>{toPay > 0 ? t('common.bookAndPay') : t('common.book')}</Button>
    </form>
  );
}
