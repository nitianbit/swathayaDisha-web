import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  ApiError, CONSULT_MINUTES, CONSULT_MODE_LABEL, doctorStanding, EXTEND_MINUTES_MAX, INSTANT_MODES, instantRefusal, istDateOf,
  offerSecondsLeft, paiseToInput, presenceProblems, rupeesToPaise,
  type DoctorAppointment, type DoctorProfile, type InstantMode, type InstantOffer,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, Loading, TextField, formatDateTime } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { definitelyNotRecorded, newRequestKey } from '../../requests.ts';
import { PageHeading } from '../../PageHeading.tsx';
import {
  appointmentsKey, MeetLink, NotADoctor, offersKey, rupeesOf, sortAppointments, useDoctor, useDoctorProfile, useMeetPoll, useTicker, type DoctorContext,
} from './doctor.tsx';

import { useDoctorPresence } from './presence.tsx';

/** Today's consultations (one cache entry shared by the accept outcome and the running list). */
const todayKey = (d: DoctorContext, today: string) => [...appointmentsKey(d), 'day', today];

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
      <Availability profile={profile.data} />
      <Offers d={d} />
      <Running d={d} />
    </>
  );
}

// ── Available now ──

function Availability({ profile }: { profile?: DoctorProfile }) {
  const p = useDoctorPresence();
  const now = useTicker(15_000);
  const pr = p.presence;
  const defaultFee = pr ? paiseToInput(pr.instantFeeMinor)
    : typeof profile?.consultationFee === 'number' ? paiseToInput(Math.round(profile.consultationFee * 100)) : '';
  const [chosen, setModes] = useState<InstantMode[] | null>(null);
  const modes = chosen ?? (pr?.modes.length ? [...pr.modes] : ['video' as InstantMode]);
  const [fee, setFee] = useState<string | null>(null);
  const [errors, setErrors] = useState<{ modes?: string; fee?: string }>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const feeText = fee ?? defaultFee;
  const on = pr?.available === true;

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
      const keepFee = minor !== undefined && minor !== null && !problems.fee ? minor : pr?.instantFeeMinor;
      const r = await p.set(available ? input : { available: false, modes, ...(keepFee !== undefined ? { instantFeeMinor: keepFee } : {}) });
      setFee(null);
      setModes(null);
      setNotice(r.available ? `You are available now for ${termsText(r)}.` : 'You are not available now. No new offers come to you.');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PRESENCE_CHANGED') {
        setFee(null);
        setModes(null);
        setFailure('Not changed: your availability was changed meanwhile (on another device, or by an earlier request of this page that arrived late). What the server has now is shown above; make your change again if it is still needed.');
      } else if (definitelyNotRecorded(err)) {
        // A refusal changed nothing; a lost answer is shown by the "not confirmed" notice (the terms are unknown).
        setFailure(available
          ? `Not changed: ${messageOf(err)}`
          : `Not switched off: ${messageOf(err)} This page has stopped its heartbeat, so you stop being offered consultations within two minutes.`);
      }
    }
  }

  async function check() {
    setFailure(null);
    setNotice(null);
    try {
      const r = await p.refresh();
      setFee(null);
      setModes(null);
      setNotice(`The server has: ${r.available ? `available for ${termsText(r)}` : 'not available'} (version ${r.presenceVersion}). Send your change again if it is still needed.`);
    } catch (err) {
      setFailure(`Could not read your availability: ${messageOf(err)}`);
    }
  }

  const sent = p.unconfirmed?.input;
  if (p.loading) return <section className="ws-section" aria-labelledby="avail-h"><h2 id="avail-h">Available now</h2><Loading label="Reading your availability…" /></section>;
  return (
    <section className="ws-section" aria-labelledby="avail-h">
      <h2 id="avail-h">Available now</h2>
      {pr ? (
        <p>
          {on && p.live ? <Badge tone="ok">On</Badge> : on ? <Badge tone="warn">On, not checked in</Badge> : <Badge>Off</Badge>}{' '}
          {on ? termsText(pr) : 'You are not taking instant consultations.'}
        </p>
      ) : sent ? (
        <p><Badge tone="warn">Not confirmed</Badge> Your availability and fee are not known here.</p>
      ) : null}
      {!pr && !sent && p.loadError && <ErrorState message={`Could not read your availability: ${p.loadError}`} onRetry={() => void check()} />}
      {sent && (
        <Alert tone="warn">
          Your last change ({sent.available
            ? `available for ${sent.modes.map((m) => CONSULT_MODE_LABEL[m]).join(', ')}${sent.instantFeeMinor !== undefined ? ` at ${rupeesOf(sent.instantFeeMinor)}` : ''}`
            : 'not available'}) was sent, but no answer came ({p.unconfirmed!.message}). It may or may not have been applied, so this page does not
          know your fee and has stopped checking in: if it was applied, offers stop coming within two minutes. Check what the server has, then
          send your change again if it is still needed. Offers cannot be accepted until then.
        </Alert>
      )}
      {on && !p.live && (
        <p className="ws-muted">Switched on, but no workspace page has checked in for two minutes, so you are not being offered consultations. Go available now to start again.</p>
      )}
      {on && p.live && (
        <p className="ws-muted">
          Keep a workspace page open and visible: it tells the server you are here every minute. When the page is hidden or closed you stop
          being offered consultations two minutes later.
          {p.lastBeatAt ? ` Last check-in ${formatDateTime(new Date(p.lastBeatAt).toISOString())}${now.getTime() - p.lastBeatAt > 120_000 ? ' (more than two minutes ago)' : ''}.` : ''}
        </p>
      )}
      {on && p.live && p.online === false && (
        <Alert tone="warn">
          You are not being offered consultations right now: {pr?.busy ? `you are in a consultation${pr.busyUntil ? ` until ${formatDateTime(pr.busyUntil)}` : ''}` : 'you are in a consultation, or “available now” was switched off elsewhere'}.
        </Alert>
      )}
      {p.problem && <Alert tone="warn">{p.problem}</Alert>}
      {notice && <Alert tone="ok">{notice}</Alert>}
      {failure && <Alert>{failure}</Alert>}
      {!pr ? (
        <div className="confirm-actions">
          <Button busy={p.busy} onClick={() => void check()}>Check what the server has</Button>
        </div>
      ) : (
        <form className="rx-form" noValidate onSubmit={(e) => void send(true, e)} aria-label="Available now">
          <fieldset className="ws-checks" aria-describedby={errors.modes ? 'avail-modes-err' : undefined}>
            <legend>Consultation types you take now</legend>
            {INSTANT_MODES.map((m) => (
              <label key={m} className="ws-check">
                <input type="checkbox" checked={modes.includes(m)} disabled={p.busy}
                  onChange={(e) => setModes(e.target.checked ? INSTANT_MODES.filter((y) => y === m || modes.includes(y)) : modes.filter((y) => y !== m))} />
                {CONSULT_MODE_LABEL[m]}
              </label>
            ))}
            {errors.modes && <span id="avail-modes-err" className="j-field__error">{errors.modes}</span>}
          </fieldset>
          <div className="rx-form-row">
            <TextField label="Your fee for an instant consultation (₹)" inputMode="decimal" value={feeText} error={errors.fee} disabled={p.busy}
              hint="Offers come only from patients who paid at least this much." onChange={(e) => setFee(e.target.value)} />
          </div>
          <div className="confirm-actions">
            <Button type="submit" busy={p.busy}>{on && p.live ? 'Update' : 'Go available now'}</Button>
            {on && <Button variant="secondary" disabled={p.busy} onClick={() => void send(false)}>Stop being available</Button>}
          </div>
        </form>
      )}
    </section>
  );
}

const termsText = (pr: { modes: InstantMode[]; instantFeeMinor: number }) =>
  `${pr.modes.map((m) => CONSULT_MODE_LABEL[m]).join(', ')} at ${rupeesOf(pr.instantFeeMinor)}`;

// ── Offers ──

type Outcome =
  | { kind: 'accepted'; offer: InstantOffer; booking: DoctorAppointment; replayed?: boolean }
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
      // Q13: accepting again as the same doctor answers the own booking (`replayed`): the same success.
      setOutcome({ kind: 'accepted', offer, booking: r.booking, replayed: r.replayed === true });
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
            checked: 'It is not among your appointments today. If the offer is still listed below you can accept again: if your earlier accept went through you get that consultation back, never a second one.' });
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

  // The accepted booking as today's list has it now (its call link is made after the accept, and the list is re-read).
  const today = istDateOf(new Date());
  const day = useQuery({ queryKey: todayKey(d, today), queryFn: () => d.api.appointmentsOn(today) });
  const acceptedBooking = outcome?.kind === 'accepted' ? day.data?.find((b) => b._id === outcome.booking._id) ?? outcome.booking : null;
  // Accepting needs acknowledged terms: the fee named here is the one the server will use.
  const canAccept = presence.confirmedOn;
  const fee = canAccept && presence.presence ? rupeesOf(presence.presence.instantFeeMinor) : null;
  const list = offers.data ?? [];
  return (
    <section className="ws-section" aria-labelledby="offers-h">
      <h2 id="offers-h">Offers for you</h2>
      <p className="ws-muted">An offer stays open for 5 minutes. Accepting starts a {CONSULT_MINUTES}-minute consultation now.</p>
      {outcome?.kind === 'accepted' && (
        <Alert tone="ok">
          You accepted the {offerLabel(outcome.offer).toLowerCase()} for {outcome.offer.patient.name}{outcome.replayed ? ' (your earlier accept had gone through)' : ''}. It is on your <Link to="/doctor/appointments">appointments</Link>.
        </Alert>
      )}
      {acceptedBooking && <MeetLink b={acceptedBooking} onRefresh={() => day.refetch()} />}
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
          <>
          {!canAccept && (
            <Alert tone="warn">
              {presence.busy ? 'Your change to “Available now” is on its way: accept once the server has confirmed it.'
                : 'To accept, switch “Available now” on above and wait until the server confirms your types and fee.'}
            </Alert>
          )}
          <ul className="stock-list" aria-label="Open offers">
            {list.map((o) => {
              const left = offerSecondsLeft(o, now);
              // Q13: the patient's paid quote caps the fee. Judged on the acknowledged fee (the one the accept will use).
              const myFee = canAccept && presence.presence ? presence.presence.instantFeeMinor : o.yourFeeMinor ?? null;
              const tooHigh = o.quotedAmountMinor !== undefined && myFee !== null ? myFee > o.quotedAmountMinor : o.feeWithinQuote === false;
              return (
                <li key={`${o.requestId}:${o.generation}`} className="doc-offer" aria-label={`Offer for ${o.patient.name}`}>
                  <div className="stock-head">
                    <strong>{offerLabel(o)}</strong>
                    {left > 0 ? <Badge tone={left < 60 ? 'warn' : undefined}>Closes in {mmss(left)}</Badge> : <Badge tone="danger">Closed</Badge>}
                  </div>
                  <span>Patient: {patientLabel(o)}{o.quotedAmountMinor !== undefined ? ` · paid ${rupeesOf(o.quotedAmountMinor)}` : ''}</span>
                  {tooHigh && <span className="ws-muted">Your fee{myFee !== null ? ` (${rupeesOf(myFee)})` : ''} is above what this patient paid, so you cannot take it. Lower your fee to take requests like this one.</span>}
                  {confirmFor === o.requestId ? (
                    <div className="confirm" role="group" aria-label={`Accept the offer for ${o.patient.name}`}>
                      <div className="confirm-text">
                        Accept the {offerLabel(o).toLowerCase()} for {patientLabel(o)}? A {CONSULT_MINUTES}-minute consultation starts now and the patient is told you are joining.
                        {' '}Your fee: {fee ?? 'not confirmed'}. It is refused if your fee is above what the patient paid.
                      </div>
                      <div className="confirm-actions">
                        <Button busy={sending === o.requestId} disabled={left === 0 || !canAccept || tooHigh || (sending !== null && sending !== o.requestId)} onClick={() => void accept(o)}>Accept and start</Button>
                        <Button variant="ghost" disabled={sending === o.requestId} onClick={() => setConfirmFor(null)}>Back</Button>
                      </div>
                    </div>
                  ) : (
                    <div className="ws-actions">
                      <Button disabled={left === 0 || !canAccept || tooHigh || sending !== null} aria-label={`Accept the offer for ${o.patient.name}`}
                        onClick={() => { setConfirmFor(o.requestId); setOutcome(null); }}>Accept…</Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          </>
        )}
    </section>
  );
}

// ── Running consultations ──

function Running({ d }: { d: DoctorContext }) {
  const today = istDateOf(new Date());
  const meet = useMeetPoll();
  const now = useTicker(15_000);
  const q = useQuery({ queryKey: todayKey(d, today), queryFn: () => d.api.appointmentsOn(today), refetchInterval: (query) => meet.interval(query.state.data) });
  const running = sortAppointments((q.data ?? []).filter((b) => b.bookingKind === 'instant' && b.status === 'confirmed'));
  return (
    <section className="ws-section" aria-labelledby="running-h">
      <h2 id="running-h">Instant consultations today</h2>
      {q.isPending ? <Loading label="Loading today’s consultations…" />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : running.length === 0 ? <Empty title="None running">Accepted instant consultations appear here so you can give them more time.</Empty>
        : (
          <ul className="stock-list" aria-label="Running instant consultations">
            {running.map((b) => (
              <RunningItem key={b._id} d={d} booking={b}
                link={<MeetLink b={b} gaveUp={meet.gaveUp(b._id, now)} onRefresh={() => { meet.restart(b._id); return q.refetch(); }} />} />
            ))}
          </ul>
        )}
      <p className="ws-muted">Mark a consultation completed (or cancel it with a full refund) on <Link to="/doctor/appointments">Appointments</Link>.</p>
    </section>
  );
}

function RunningItem({ d, booking, link }: { d: DoctorContext; booking: DoctorAppointment; link: ReactNode }) {
  const [minutes, setMinutes] = useState('10');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);
  /** Q13: an extension whose answer was lost, kept with its request key: only the same one may be sent again (added once). */
  const [pending, setPending] = useState<{ key: string; minutes: number } | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const label = `${booking.consultationMode ? CONSULT_MODE_LABEL[booking.consultationMode] : 'Instant'} consultation accepted at ${booking.bookingTime}`;

  async function extend(e: FormEvent) {
    e.preventDefault();
    let op = pending;
    if (!op) {
      const n = /^\d{1,2}$/.test(minutes.trim()) ? Number(minutes.trim()) : NaN;
      if (!Number.isInteger(n) || n < 1 || n > EXTEND_MINUTES_MAX) { setFieldError(`Enter 1 to ${EXTEND_MINUTES_MAX} minutes.`); return; }
      op = { key: newRequestKey(), minutes: n };
    }
    setFieldError(null);
    setBusy(true);
    setNotice(null);
    try {
      const r = await d.api.extend(booking._id, op.minutes, op.key);
      if (!alive.current) return;
      setPending(null);
      setNotice({ tone: 'ok', text: `Extended by ${op.minutes} minutes: your time is held until ${formatDateTime(r.extension?.endTime ?? r.endTime)}.` });
    } catch (err) {
      if (!alive.current) return;
      const refusal = instantRefusal(err);
      if (refusal) { setPending(null); setNotice({ tone: 'error', text: `Not extended: ${refusal}` }); return; }
      // The answer was lost: look for this extension on the booking before anything else.
      setPending(op);
      try {
        const b = await d.api.instantBooking(booking._id);
        if (!alive.current) return;
        const done = b.extensions.find((x) => x.requestKey === op.key);
        if (done) { setPending(null); setNotice({ tone: 'ok', text: `Extended by ${op.minutes} minutes: your time is held until ${formatDateTime(done.endTime)}.` }); return; }
        setNotice({ tone: 'warn', text: `${messageOf(err)} The extension is not recorded yet. Send the same extension again: it is added once, never twice.` });
      } catch (lookErr) {
        if (alive.current) setNotice({ tone: 'warn', text: `${messageOf(err)} Could not check whether it was recorded (${messageOf(lookErr)}). Sending the same extension again is safe: it is added once.` });
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  return (
    <li className="doc-offer" aria-label={label}>
      <strong>{label}</strong>
      {link}
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      <form className="ws-search" noValidate onSubmit={(e) => void extend(e)} aria-label={`Extend the ${label.toLowerCase()}`}>
        <TextField label="Extend by (minutes)" inputMode="numeric" value={pending ? String(pending.minutes) : minutes} error={fieldError} disabled={!!pending}
          hint={`1 to ${EXTEND_MINUTES_MAX}; refused if it would run into your next booking`} onChange={(e) => setMinutes(e.target.value)} />
        <Button type="submit" variant="secondary" busy={busy}>{pending ? 'Send the same extension again' : 'Extend'}</Button>
      </form>
    </li>
  );
}
