import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  ApiError, CONSULT_MINUTES, CONSULT_MODE_LABEL, doctorStanding, EXTEND_MINUTES_MAX, INSTANT_MODES, instantRefusal, istDateOf,
  offerSecondsLeft, paiseToInput, presenceProblems, rupeesToPaise,
  type DoctorAppointment, type DoctorProfile, type InstantMode, type InstantOffer,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, Loading, TextField, formatDateTime } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { appointmentsKey, NotADoctor, offersKey, rupeesOf, sortAppointments, useDoctor, useDoctorProfile, useTicker, type DoctorContext } from './doctor.tsx';
import { useDoctorPresence } from './presence.tsx';

/** How often the open offers are read again while this page is visible. */
const OFFERS_POLL_MS = 15_000;

/** "Available now", live offers with accept, and extending a running instant consultation (Q4b). */
export function ConsultNowScreen() {
  const d = useDoctor();
  if (!d) return <NotADoctor />;
  return <ConsultNow key={d.identity} d={d} />;
}

function ConsultNow({ d }: { d: DoctorContext }) {
  const profile = useDoctorProfile(d);
  const standing = profile.data ? doctorStanding(profile.data) : null;
  return (
    <>
      <PageHeading title="Consult now">
        Take instant consultations: patients who pay now are offered to doctors of their speciality who are available. The first doctor to accept gets it.
      </PageHeading>
      {standing === 'inactive' && <Alert>Your doctor account is not active, so you cannot take instant consultations. Contact Jansetu.</Alert>}
      {standing === 'unverified' && <Alert tone="warn">Your profile is waiting for verification by Jansetu. You can take instant consultations once it is verified.</Alert>}
      <Availability d={d} profile={profile.data} />
      <Offers d={d} />
      <Running d={d} />
    </>
  );
}

// ── Available now ──

function Availability({ d, profile }: { d: DoctorContext; profile?: DoctorProfile }) {
  const p = useDoctorPresence();
  const now = useTicker(15_000);
  const defaultFee = p.presence ? paiseToInput(p.presence.instantFeeMinor)
    : typeof profile?.consultationFee === 'number' ? paiseToInput(Math.round(profile.consultationFee * 100)) : '';
  const [modes, setModes] = useState<InstantMode[]>(() => p.presence?.modes.length ? [...p.presence.modes] : ['video']);
  const [fee, setFee] = useState<string | null>(null);
  const [errors, setErrors] = useState<{ modes?: string; fee?: string }>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const feeText = fee ?? defaultFee;
  const on = p.presence?.available === true;

  async function send(available: boolean, e?: FormEvent) {
    e?.preventDefault();
    setFailure(null);
    setNotice(null);
    const minor = feeText.trim() === '' ? undefined : rupeesToPaise(feeText);
    const input = { available, modes, ...(minor !== undefined && minor !== null ? { instantFeeMinor: minor } : {}) };
    const problems = { ...presenceProblems(input), ...(minor === null ? { fee: 'Enter the fee in rupees, e.g. 500 or 499.50.' } : {}) };
    setErrors(available ? problems : {});
    if (available && Object.keys(problems).length) return;
    try {
      // Going off sends the types and fee again (the server would otherwise reset the fee to the consultation fee).
      const keepFee = minor !== undefined && minor !== null && !problems.fee ? minor : p.presence?.instantFeeMinor;
      const r = await p.set(available ? input : { available: false, modes, ...(keepFee !== undefined ? { instantFeeMinor: keepFee } : {}) });
      setFee(null);
      setNotice(r.available
        ? `You are available now for ${r.modes.map((m) => CONSULT_MODE_LABEL[m]).join(', ')} at ${rupeesOf(r.instantFeeMinor)}.`
        : 'You are not available now. No new offers come to you.');
    } catch (err) {
      setFailure(available
        ? `Not switched on: ${messageOf(err)}`
        : `${messageOf(err)} This page has stopped its heartbeat, so you stop being offered consultations within two minutes; try again to be sure.`);
    }
  }

  return (
    <section className="ws-section" aria-labelledby="avail-h">
      <h2 id="avail-h">Available now</h2>
      <p>
        {on ? <Badge tone="ok">On</Badge> : p.presence ? <Badge>Off</Badge> : <Badge tone="warn">Not set on this device</Badge>}{' '}
        {on ? `${p.presence!.modes.map((m) => CONSULT_MODE_LABEL[m]).join(', ')} · fee ${rupeesOf(p.presence!.instantFeeMinor)}`
          : p.presence ? 'You are not taking instant consultations.'
          : 'The server does not tell the workspace whether you switched this on earlier (for example before a reload). Switch it on to take consultations, or off to be sure.'}
      </p>
      {on && (
        <p className="ws-muted">
          Keep a workspace page open and visible: it tells the server you are here every minute. When the page is hidden or closed you stop
          being offered consultations two minutes later.
          {p.lastBeatAt ? ` Last check-in ${formatDateTime(new Date(p.lastBeatAt).toISOString())}${now.getTime() - p.lastBeatAt > 120_000 ? ' (more than two minutes ago)' : ''}.` : ''}
        </p>
      )}
      {on && p.online === false && <Alert tone="warn">You are not being offered consultations right now: you are in a consultation, or “available now” was switched off elsewhere.</Alert>}
      {p.problem && <Alert tone="warn">{p.problem}</Alert>}
      {notice && <Alert tone="ok">{notice}</Alert>}
      {failure && <Alert>{failure}</Alert>}
      <form className="rx-form" noValidate onSubmit={(e) => void send(true, e)} aria-label="Available now">
        <fieldset className="ws-checks" aria-describedby={errors.modes ? 'avail-modes-err' : undefined}>
          <legend>Consultation types you take now</legend>
          {INSTANT_MODES.map((m) => (
            <label key={m} className="ws-check">
              <input type="checkbox" checked={modes.includes(m)} disabled={p.busy}
                onChange={(e) => setModes((x) => (e.target.checked ? INSTANT_MODES.filter((y) => y === m || x.includes(y)) : x.filter((y) => y !== m)))} />
              {CONSULT_MODE_LABEL[m]}
            </label>
          ))}
          {errors.modes && <span id="avail-modes-err" className="j-field__error">{errors.modes}</span>}
        </fieldset>
        <div className="rx-form-row">
          <TextField label="Your fee for an instant consultation (₹)" inputMode="decimal" value={feeText} error={errors.fee} disabled={p.busy}
            hint="Offers come only from patients who paid at least this much. Empty = your consultation fee." onChange={(e) => setFee(e.target.value)} />
        </div>
        <div className="confirm-actions">
          <Button type="submit" busy={p.busy}>{on ? 'Update' : 'Go available now'}</Button>
          {(on || !p.presence) && <Button variant="secondary" disabled={p.busy} onClick={() => void send(false)}>{on ? 'Stop being available' : 'Make sure I am not available'}</Button>}
        </div>
      </form>
    </section>
  );
}

// ── Offers ──

type Outcome =
  | { kind: 'accepted'; offer: InstantOffer; booking: DoctorAppointment }
  | { kind: 'refused'; offer: InstantOffer; message: string }
  | { kind: 'unknown'; offer: InstantOffer; message: string; checking: boolean; checked?: string };

const offerLabel = (o: InstantOffer) => `${CONSULT_MODE_LABEL[o.mode]} consultation · ${o.specialization}`;
const patientLabel = (o: InstantOffer) =>
  [o.patient.name, o.patient.age !== undefined ? `${o.patient.age} years` : null, o.patient.gender ?? null].filter(Boolean).join(', ');
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

function Offers({ d }: { d: DoctorContext }) {
  const queryClient = useQueryClient();
  const presence = useDoctorPresence();
  const offers = useQuery({ queryKey: offersKey(d), queryFn: () => d.api.offers(), refetchInterval: OFFERS_POLL_MS });
  const now = useTicker(1000);
  const [confirmFor, setConfirmFor] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // Answers belong to the attempt that asked and to this page: a later attempt, or leaving the page, makes them stale.
  const attempt = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const current = (n: number) => alive.current && attempt.current === n;

  /** Did this doctor accept it after all? Today's appointments carry the request it came from. */
  async function lookUp(offer: InstantOffer, n: number): Promise<DoctorAppointment | null> {
    const list = await d.api.appointmentsOn(istDateOf(new Date()));
    if (!current(n)) return null;
    return list.find((b) => b.instantRequestId === offer.requestId && b.status !== 'cancelled') ?? null;
  }

  async function accept(offer: InstantOffer) {
    const n = ++attempt.current;
    setSending(offer.requestId);
    setOutcome(null);
    try {
      const r = await d.api.accept(offer.requestId);
      if (!current(n)) return;
      setConfirmFor(null);
      setOutcome({ kind: 'accepted', offer, booking: r.booking });
    } catch (err) {
      if (!current(n) || (err instanceof DOMException && err.name === 'AbortError')) return;
      const refusal = instantRefusal(err);
      setConfirmFor(null);
      if (refusal && !(err instanceof ApiError && err.code === 'OFFER_NO_LONGER_AVAILABLE')) {
        setOutcome({ kind: 'refused', offer, message: refusal });
      } else {
        // Taken, or no answer: it may be this doctor's own earlier attempt that won. Look before saying anything.
        setOutcome({ kind: 'unknown', offer, message: refusal ?? messageOf(err), checking: true });
        try {
          const found = await lookUp(offer, n);
          if (!current(n)) return;
          if (found) setOutcome({ kind: 'accepted', offer, booking: found });
          else if (refusal) setOutcome({ kind: 'refused', offer, message: refusal });
          else setOutcome({ kind: 'unknown', offer, message: messageOf(err), checking: false,
            checked: 'It is not among your appointments today. If the offer is still listed below you can try again: the first accept wins, so it is never taken twice.' });
        } catch (lookErr) {
          if (current(n)) setOutcome({ kind: 'unknown', offer, message: messageOf(err), checking: false, checked: `Could not check your appointments: ${messageOf(lookErr)}` });
        }
      }
    } finally {
      if (alive.current && attempt.current === n) setSending(null);
      void queryClient.invalidateQueries({ queryKey: offersKey(d) });
      void queryClient.invalidateQueries({ queryKey: appointmentsKey(d) });
    }
  }

  const fee = presence.presence ? rupeesOf(presence.presence.instantFeeMinor) : null;
  const list = offers.data ?? [];
  return (
    <section className="ws-section" aria-labelledby="offers-h">
      <h2 id="offers-h">Offers for you</h2>
      <p className="ws-muted">An offer stays open for 5 minutes. Accepting starts a {CONSULT_MINUTES}-minute consultation now.</p>
      {outcome?.kind === 'accepted' && (
        <Alert tone="ok">
          You accepted the {offerLabel(outcome.offer).toLowerCase()} for {outcome.offer.patient.name}. It is on your <Link to="/doctor/appointments">appointments</Link>
          {outcome.booking.virtualMeeting?.joinUrl ? <> · <a href={outcome.booking.virtualMeeting.joinUrl} target="_blank" rel="noreferrer noopener">Join the call</a></> : ''}.
        </Alert>
      )}
      {outcome?.kind === 'refused' && <Alert>Not accepted ({outcome.offer.patient.name}): {outcome.message}</Alert>}
      {outcome?.kind === 'unknown' && (
        <Alert tone="warn">
          The answer to your accept for {outcome.offer.patient.name} did not arrive ({outcome.message}).{' '}
          {outcome.checking ? 'Checking your appointments…' : outcome.checked}
        </Alert>
      )}
      {offers.isPending ? <Loading label="Loading offers…" />
        : offers.isError ? <ErrorState message={messageOf(offers.error)} onRetry={() => void offers.refetch()} />
        : list.length === 0 ? <Empty title="No offers right now">{presence.presence?.available ? 'New offers appear here on their own.' : 'Go available now to receive offers.'}</Empty>
        : (
          <ul className="stock-list" aria-label="Open offers">
            {list.map((o) => {
              const left = offerSecondsLeft(o, now);
              return (
                <li key={`${o.requestId}:${o.generation}`} className="doc-offer" aria-label={`Offer for ${o.patient.name}`}>
                  <div className="stock-head">
                    <strong>{offerLabel(o)}</strong>
                    {left > 0 ? <Badge tone={left < 60 ? 'warn' : undefined}>Closes in {mmss(left)}</Badge> : <Badge tone="danger">Closed</Badge>}
                  </div>
                  <span>Patient: {patientLabel(o)}</span>
                  {confirmFor === o.requestId ? (
                    <div className="confirm" role="group" aria-label={`Accept the offer for ${o.patient.name}`}>
                      <div className="confirm-text">
                        Accept the {offerLabel(o).toLowerCase()} for {patientLabel(o)}? A {CONSULT_MINUTES}-minute consultation starts now and the patient is told you are joining.
                        {' '}Your fee: {fee ?? 'your instant fee as last set'}. It is refused if your fee is above what the patient paid.
                      </div>
                      <div className="confirm-actions">
                        <Button busy={sending === o.requestId} disabled={left === 0 || (sending !== null && sending !== o.requestId)} onClick={() => void accept(o)}>Accept and start</Button>
                        <Button variant="ghost" disabled={sending === o.requestId} onClick={() => setConfirmFor(null)}>Back</Button>
                      </div>
                    </div>
                  ) : (
                    <div className="ws-actions">
                      <Button disabled={left === 0 || sending !== null} aria-label={`Accept the offer for ${o.patient.name}`}
                        onClick={() => { setConfirmFor(o.requestId); setOutcome(null); }}>Accept…</Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
    </section>
  );
}

// ── Running consultations ──

function Running({ d }: { d: DoctorContext }) {
  const today = istDateOf(new Date());
  const q = useQuery({ queryKey: [...appointmentsKey(d), 'day', today], queryFn: () => d.api.appointmentsOn(today) });
  const running = sortAppointments((q.data ?? []).filter((b) => b.bookingKind === 'instant' && b.status === 'confirmed'));
  return (
    <section className="ws-section" aria-labelledby="running-h">
      <h2 id="running-h">Instant consultations today</h2>
      {q.isPending ? <Loading label="Loading today’s consultations…" />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : running.length === 0 ? <Empty title="None running">Accepted instant consultations appear here so you can give them more time.</Empty>
        : (
          <ul className="stock-list" aria-label="Running instant consultations">
            {running.map((b) => <RunningItem key={b._id} d={d} booking={b} />)}
          </ul>
        )}
      <p className="ws-muted">Mark a consultation completed (or cancel it with a full refund) on <Link to="/doctor/appointments">Appointments</Link>.</p>
    </section>
  );
}

function RunningItem({ d, booking }: { d: DoctorContext; booking: DoctorAppointment }) {
  const [minutes, setMinutes] = useState('10');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const label = `${booking.consultationMode ? CONSULT_MODE_LABEL[booking.consultationMode] : 'Instant'} consultation accepted at ${booking.bookingTime}`;

  async function extend(e: FormEvent) {
    e.preventDefault();
    const n = /^\d{1,2}$/.test(minutes.trim()) ? Number(minutes.trim()) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > EXTEND_MINUTES_MAX) { setFieldError(`Enter 1 to ${EXTEND_MINUTES_MAX} minutes.`); return; }
    setFieldError(null);
    setBusy(true);
    setNotice(null);
    try {
      const r = await d.api.extend(booking._id, n);
      if (alive.current) setNotice({ tone: 'ok', text: `Extended by ${n} minutes: your time is held until ${formatDateTime(r.endTime)}.` });
    } catch (err) {
      if (!alive.current) return;
      const refusal = instantRefusal(err);
      // Not keyed on the server: each extension that arrives adds time, so a lost answer must not be resent blindly.
      setNotice(refusal ? { tone: 'error', text: `Not extended: ${refusal}` }
        : { tone: 'warn', text: `${messageOf(err)} It may have been extended. Extending again adds another ${n} minutes.` });
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  return (
    <li className="doc-offer" aria-label={label}>
      <strong>{label}</strong>
      {booking.virtualMeeting?.joinUrl && <a href={booking.virtualMeeting.joinUrl} target="_blank" rel="noreferrer noopener">Join the call</a>}
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      <form className="ws-search" noValidate onSubmit={(e) => void extend(e)} aria-label={`Extend the ${label.toLowerCase()}`}>
        <TextField label="Extend by (minutes)" inputMode="numeric" value={minutes} error={fieldError} hint={`1 to ${EXTEND_MINUTES_MAX}; refused if it would run into your next booking`}
          onChange={(e) => setMinutes(e.target.value)} />
        <Button type="submit" variant="secondary" busy={busy}>Extend</Button>
      </form>
    </li>
  );
}
