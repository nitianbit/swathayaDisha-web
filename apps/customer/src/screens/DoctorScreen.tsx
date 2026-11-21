import { useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import {
  COUPON_PATTERN, customerApi, type ConsultationMode, type CouponCheck, type NewConsultation, type Slot, type Specialist, requestKeysApi } from '@jansetu/api';
import { Alert, Button, Empty, ErrorState, formatRupees, Loading, TextArea, TextField } from '@jansetu/ui';
import { Confirm, messageOf, PageHeading } from '../common.tsx';
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
          else setPending({ ...next, label: attempt.label, error: 'It was booked, but the booking could not be shown. Open My bookings' });
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
          await payOrder(api, created.payment, payer, `Consultation with ${doctor.name}`);
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
    return 'It was booked after all, but the booking could not be shown. Open My bookings.';
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
      setNote('Not found in your bookings. It may still be on its way. To book again, first cancel this request: once cancelled it can never be booked.');
    } catch (err) {
      setNote(`Could not check your bookings: ${messageOf(err)}`);
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
      setNote('It was booked, but the booking could not be shown. Open My bookings.');
    } catch (err) {
      setNote(`Could not cancel it: ${messageOf(err)}`);
    } finally {
      setBusy(null);
    }
  }
  return (
    <section className="card stack" role="group" aria-label="Unconfirmed booking request">
      <Alert tone="warn">
        A booking request made earlier on this device (before the page was reloaded, or before you signed out) has not
        been confirmed yet. Check whether it was booked before booking again.
      </Alert>
      {note && <Alert>{note}</Alert>}
      <div className="row">
        <Button busy={busy === 'check'} disabled={busy === 'cancel'} onClick={() => void check()}>Check my bookings</Button>
        {notFound && <Button variant="secondary" busy={busy === 'cancel'} disabled={busy === 'check'} onClick={() => void cancelIt()}>Cancel it and book again</Button>}
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
          {d.experienceYears ? <><dt>Experience</dt><dd>{d.experienceYears} years</dd></> : null}
          {d.hospitalOrClinic && <><dt>Clinic</dt><dd>{d.hospitalOrClinic}{d.city ? `, ${d.city}` : ''}</dd></>}
          {d.languages?.length ? <><dt>Languages</dt><dd>{d.languages.join(', ')}</dd></> : null}
          <dt>Fee</dt><dd>{fee ? formatRupees(fee) : 'Free'}</dd>
        </dl>
        {d.bio && <p className="muted">{d.bio}</p>}
      </section>
      {/* The panel is for a request whose outcome is unknown: after a failed attempt, or one restored from an
          earlier visit (it may still be running). A first attempt in flight keeps the form, with a busy button. */}
      {create.pending?.restored ? (
        <RestoredRequest pending={create.pending} onFound={(id) => create.found(create.pending!.requestKey, id)}
          onDiscard={() => create.discard(create.pending!.requestKey)} />
      ) : create.pending && (create.pending.uncertain || !create.busy) ? (
        <section className="card stack" role="group" aria-label="Unconfirmed booking request">
          <Alert tone="warn">
            Your booking request for {create.pending.label} did not get an answer{create.pending.error ? ` (${create.pending.error})` : ''}.
            It may already be booked. Send it again to find out: it will not be booked twice.
          </Alert>
          {giveUpNote && <Alert>{giveUpNote}</Alert>}
          <div className="row">
            <Button busy={create.busy} onClick={() => void create.send(create.pending!, payer)}>Send it again</Button>
            <Link to="/bookings">My bookings</Link>
          </div>
          <Confirm label="Give it up and book again" confirmLabel="Yes, give it up" disabled={create.busy}
            consequence="The booking request is cancelled for good: it can never be booked later, even if it is still on its way. Then you can book again."
            onConfirm={async () => setGiveUpNote(await create.giveUp(create.pending!.requestKey))} />
        </section>
      ) : (
      <>
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
    if (!COUPON_PATTERN.test(value)) { setCouponError('Enter a valid coupon code.'); return; }
    try {
      const r = await c.checkCoupon({ code: value, specialistId: d._id, purchaseAmount: fee, ...(forWhom ? { dependentId: forWhom } : {}) });
      if (r?.isValid) setCoupon({ ...r, code: value }); else { setCoupon(null); setCouponError('This coupon cannot be used for this booking.'); }
    } catch (err) { setCoupon(null); setCouponError(messageOf(err)); }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (concern.trim().length < 3) errs.concern = 'Tell the doctor briefly what it is about.';
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
      <h2 id="book-h">Book {slot.startTime}</h2>
      <div className="j-field">
        <label htmlFor="who">For</label>
        {/* A coupon is checked for one patient: a new patient drops it, and says so (WQ11a). */}
        <select id="who" value={forWhom} onChange={(e) => {
          setForWhom(e.target.value);
          if (coupon?.isValid) setCouponError(`Coupon ${coupon.code} was removed because the patient changed. Apply it again to check it for them.`);
          setCoupon(null);
        }}>
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
      {create.error && <Alert>{create.error}</Alert>}
      <Button type="submit" busy={create.busy}>{toPay > 0 ? 'Book and pay' : 'Book'}</Button>
    </form>
  );
}
