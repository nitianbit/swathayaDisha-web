import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import {
  ApiError, COUPON_PATTERN, customerApi, type ConsultationMode, type CouponCheck, type Slot, type Specialist,
} from '@jansetu/api';
import { Alert, Button, Empty, ErrorState, formatRupees, Loading, TextArea, TextField } from '@jansetu/ui';
import { messageOf, PageHeading } from '../common.tsx';
import { payOrder } from '../payments.ts';
import { useCustomer, useSession } from '../session.tsx';

/** The next `n` days as IST calendar dates (YYYYMMDD) with a short label. */
export function nextDays(n: number, now = new Date()): { date: string; label: string }[] {
  const out: { date: string; label: string }[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getTime() + i * 86_400_000);
    const ist = new Date(d.getTime() + 5.5 * 3_600_000);
    const date = ist.toISOString().slice(0, 10).replace(/-/g, '');
    const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow'
      : new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }).format(d);
    out.push({ date, label });
  }
  return out;
}

const MODE_LABEL: Record<ConsultationMode, string> = { 'in-person': 'At the clinic', video: 'Video call', call: 'Phone call', chat: 'Chat' };

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
      <Link to="/doctors" className="back"><ArrowLeft size={16} aria-hidden="true" /> Doctors</Link>
      {!valid ? <Empty title="Doctor not found" />
        : q.isPending ? <Loading /> : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : <DoctorView doctor={q.data} />}
    </>
  );
}

function DoctorView({ doctor: d }: { doctor: Specialist }) {
  const { api } = useSession();
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
          {d.experienceYears ? <><dt>Experience</dt><dd>{d.experienceYears} years</dd></> : null}
          {d.hospitalOrClinic && <><dt>Clinic</dt><dd>{d.hospitalOrClinic}{d.city ? `, ${d.city}` : ''}</dd></>}
          {d.languages?.length ? <><dt>Languages</dt><dd>{d.languages.join(', ')}</dd></> : null}
          <dt>Fee</dt><dd>{fee ? formatRupees(fee) : 'Free'}</dd>
        </dl>
        {d.bio && <p className="muted">{d.bio}</p>}
      </section>
      <section className="stack" aria-labelledby="when-h">
        <h2 id="when-h">Choose a time</h2>
        <div className="chips" role="group" aria-label="Day">
          {days.map((x) => (
            <button key={x.date} type="button" className="chip" aria-pressed={x.date === date}
              onClick={() => { setDate(x.date); setSlot(null); }}>{x.label}</button>
          ))}
        </div>
        {slots.isPending ? <Loading label="Loading times…" />
          : slots.isError ? <ErrorState message={messageOf(slots.error)} onRetry={() => void slots.refetch()} />
          : slots.data.length === 0 ? <Empty title="No free times on this day">Try another day.</Empty>
          : (
            <div className="chips" role="group" aria-label="Time">
              {slots.data.map((s) => (
                <button key={s._id} type="button" className="chip" aria-pressed={slot?._id === s._id} onClick={() => setSlot(s)}>{s.startTime}</button>
              ))}
            </div>
          )}
      </section>
      {slot && <BookForm key={slot._id} doctor={d} slot={slot} fee={fee} />}
    </>
  );
}

function BookForm({ doctor: d, slot, fee }: { doctor: Specialist; slot: Slot; fee: number }) {
  const { api } = useSession();
  const me = useCustomer();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const c = customerApi(api);
  const profile = useQuery({ queryKey: ['me'], queryFn: () => c.profile() });
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const afterCoupon = coupon?.isValid ? Number(coupon.finalAmount ?? fee) : fee;
  const walletUse = useWallet ? Math.min(afterCoupon, Number(wallet.data?.balance ?? 0)) : 0;
  const toPay = Math.max(0, afterCoupon - walletUse);

  async function applyCoupon() {
    setCouponError(null);
    const value = code.trim().toUpperCase();
    if (!COUPON_PATTERN.test(value)) { setCouponError('Enter a valid coupon code.'); return; }
    try {
      const r = await c.checkCoupon({ code: value, specialistId: d._id, purchaseAmount: fee, ...(forWhom ? { dependentId: forWhom } : {}) });
      if (r?.isValid) setCoupon({ ...r, code: value }); else { setCoupon(null); setCouponError('This coupon cannot be used for this booking.'); }
    } catch (err) { setCoupon(null); setCouponError(messageOf(err)); }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (concern.trim().length < 3) errs.concern = 'Tell the doctor briefly what it is about.';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setError(null);
    let created;
    try {
      created = await c.bookConsultation({
        specialistId: d._id, slotId: slot._id, bookingDate: slot.date, bookingTime: slot.startTime, consultationMode: mode,
        primaryConcern: concern.trim(), ...(forWhom ? { dependentId: forWhom } : {}),
        ...(coupon?.isValid ? { couponCode: coupon.code } : {}), useWalletBalance: useWallet,
      });
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) { setError(messageOf(err)); return; }
      // No definite answer: the booking may exist. Never resend (it would hold a second slot); show the bookings.
      setError('We could not confirm whether your booking was made. Please check My bookings before trying again.');
      await queryClient.invalidateQueries({ queryKey: ['bookings'] });
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ['bookings'] });
    await queryClient.invalidateQueries({ queryKey: ['wallet'] });
    if (created.paymentRequired && created.payment) {
      const p = profile.data;
      await payOrder(api, created.payment, { name: p?.name, contact: p?.phone, email: p?.email }, `Consultation with ${d.name}`);
    }
    navigate(`/bookings/${created.booking._id}`);
  }

  return (
    <form className="card stack" onSubmit={(e) => void submit(e)} noValidate aria-labelledby="book-h">
      <h2 id="book-h">Book {slot.startTime}</h2>
      <div className="j-field">
        <label htmlFor="who">For</label>
        <select id="who" value={forWhom} onChange={(e) => { setForWhom(e.target.value); setCoupon(null); }}>
          <option value="">Myself</option>
          {(family.data?.items ?? []).filter((x) => x.relationship !== 'Me').map((x) => (
            <option key={x._id} value={x._id}>{x.name} ({x.relationship})</option>
          ))}
        </select>
      </div>
      <fieldset className="choice">
        <legend>How</legend>
        {modes.map((m) => (
          <label key={m}><input type="radio" name="mode" checked={mode === m} onChange={() => setMode(m)} /> {MODE_LABEL[m]}</label>
        ))}
      </fieldset>
      <TextArea label="What is it about?" value={concern} onChange={(e) => setConcern(e.target.value)} error={errors.concern} maxLength={1000} />
      {fee > 0 && (
        <div className="stack">
          <div className="row">
            <TextField label="Coupon (optional)" value={code} onChange={(e) => { setCode(e.target.value.toUpperCase()); setCoupon(null); }}
              error={couponError} autoCapitalize="characters" />
            <Button variant="secondary" onClick={() => void applyCoupon()} disabled={!code.trim()}>Apply</Button>
          </div>
          {coupon?.isValid && <Alert tone="ok">Coupon {coupon.code}: {formatRupees(coupon.discountAmount ?? 0)} off.</Alert>}
          {Number(wallet.data?.balance ?? 0) > 0 && (
            <label className="check"><input type="checkbox" checked={useWallet} onChange={(e) => setUseWallet(e.target.checked)} />
              Use my wallet ({formatRupees(wallet.data?.balance)})</label>
          )}
        </div>
      )}
      <dl className="details" aria-label="Price">
        <dt>Fee</dt><dd>{fee ? formatRupees(fee) : 'Free'}</dd>
        {coupon?.isValid ? <><dt>Coupon</dt><dd>−{formatRupees(coupon.discountAmount ?? 0)}</dd></> : null}
        {walletUse > 0 ? <><dt>From wallet</dt><dd>−{formatRupees(walletUse)}</dd></> : null}
        <dt>To pay now</dt><dd><strong>{formatRupees(toPay)}</strong></dd>
      </dl>
      <p className="muted">The final amount is worked out by the server and shown on the payment page.</p>
      {error && <Alert>{error}</Alert>}
      {error?.startsWith('We could not confirm') ? (
        <Link to="/bookings">Go to My bookings</Link>
      ) : (
        <Button type="submit" busy={busy}>{toPay > 0 ? 'Book and pay' : 'Book'}</Button>
      )}
    </form>
  );
}
