import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  ApiError, CONSULT_MINUTES, CONSULT_MODE_LABEL, doctorStanding, EXTEND_MINUTES_MAX, INSTANT_MODES, instantRefusal, istDateOf,
  offerSecondsLeft, paiseToInput, presenceProblems, rupeesToPaise,
  type DoctorAppointment, type DoctorProfile, type InstantMode, type InstantOffer,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, Loading, shared, TextField, formatDateTime , Parts } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { messageOf } from '../../errors.ts';
import { afterFailure, beginAttempt, definitelyNotRecorded, newRequestKey, startOp, stillCurrent, type PendingOp } from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { PageHeading } from '../../PageHeading.tsx';
import {
  appointmentsKey, MeetLink, NotADoctor, offersKey, RefreshFailed, rupeesOf, sortAppointments, useDoctor, useDoctorProfile, useMeetPoll, useTicker,
  type DoctorContext,
} from './doctor.tsx';

import { useDoctorPresence } from './presence.tsx';
import { t } from '../../i18n/doctor/index.ts';

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
      <PageHeading title={t('common.consultNow')}>{t('consultNow.takeInstantConsultationsPatientsWho')}</PageHeading>
      {standing === 'inactive' && <Alert>{t('consultNow.yourDoctorAccountIsNot')}</Alert>}
      {standing === 'unverified' && <Alert tone="warn">{t('consultNow.yourProfileIsWaitingFor')}</Alert>}
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
  /** While uncertain, the terms last read (shown, not acknowledged): the form starts from them. */
  const view = pr ?? (p.unconfirmed ? p.shown : null);
  const defaultFee = view ? paiseToInput(view.instantFeeMinor)
    : typeof profile?.consultationFee === 'number' ? paiseToInput(Math.round(profile.consultationFee * 100)) : '';
  const [chosen, setModes] = useState<InstantMode[] | null>(null);
  const modes = chosen ?? (view?.modes.length ? [...view.modes] : ['video' as InstantMode]);
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
    const problems = { ...presenceProblems(input), ...(minor === null ? { fee: t('consultNow.enterTheFeeInRupees') } : {}) };
    setErrors(available ? problems : {});
    if (available && Object.keys(problems).length) return;
    try {
      // Going off sends the types and fee again (the server would otherwise reset the fee to the consultation fee).
      const keepFee = minor !== undefined && minor !== null && !problems.fee ? minor : view?.instantFeeMinor;
      const r = await p.set(available ? input : { available: false, modes, ...(keepFee !== undefined ? { instantFeeMinor: keepFee } : {}) });
      setFee(null);
      setModes(null);
      setNotice(r.available ? t('consultNow.youAreAvailableNowFor', { value: termsText(r) }) : t('consultNow.youAreNotAvailableNow'));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PRESENCE_CHANGED') {
        setFee(null);
        setModes(null);
        setFailure(p.unconfirmed
          ? t('consultNow.notConfirmedTheServerS')
          : t('consultNow.notChangedYourAvailabilityWas'));
      } else if (definitelyNotRecorded(err)) {
        // A refusal changed nothing; a lost answer is shown by the "not confirmed" notice (the terms are unknown).
        setFailure(available
          ? t('consultNow.notChanged', { value: messageOf(err) })
          : t('consultNow.notSwitchedOffThisPage', { value: messageOf(err) }));
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
      setNotice(`${t('consultNow.theServerHasVersion', { state: stateWords(r), presenceVersion: r.presenceVersion })}${p.unconfirmed
        ? ` ${t('consultNow.confirmTheseTermsOrChange')}`
        : ''}`);
    } catch (err) {
      setFailure(t('consultNow.couldNotReadYourAvailability', { value: messageOf(err) }));
    }
  }

  const sent = p.unconfirmed?.input;
  const doubt = p.unconfirmed;
  /** What the form's one submit does (its primary button and Enter alike): confirm the shown terms while uncertain, else go on. */
  const primaryAvailable = doubt && p.shown ? p.shown.available : true;
  if (p.loading) return <section className="ws-section" aria-labelledby="avail-h"><h2 id="avail-h">{t('common.availableNow')}</h2><Loading label={t('consultNow.readingYourAvailability')} /></section>;
  return (
    <section className="ws-section" aria-labelledby="avail-h">
      <h2 id="avail-h">{t('common.availableNow')}</h2>
      {pr ? (
        <p>
          {on && p.live ? <Badge tone="ok">{t('common.on')}</Badge> : on ? <Badge tone="warn">{t('common.onNotCheckedIn')}</Badge> : <Badge>{t('common.off')}</Badge>}{' '}
          {on ? termsText(pr) : t('consultNow.youAreNotTakingInstant')}
        </p>
      ) : doubt ? (
        <p>
          <Badge tone="warn">{t('common.notConfirmed')}</Badge>{' '}
          {p.shown ? t('consultNow.theServerLastShowedVersion', { state: stateWords(p.shown), presenceVersion: p.shown.presenceVersion })
            : t('consultNow.yourAvailabilityAndFeeAre')}
        </p>
      ) : null}
      {!pr && !doubt && p.loadError && <ErrorState message={t('consultNow.couldNotReadYourAvailability2', { loadError: p.loadError })} onRetry={() => void check()} />}
      {doubt && (
        <Alert tone="warn">
          {sent ? <>{t('consultNow.lastChangeNoAnswer', { change: !sent.available ? t('consultNow.state.notAvailable')
            : sent.instantFeeMinor !== undefined ? t('consultNow.state.availableFor', { terms: termsText({ modes: sent.modes, instantFeeMinor: sent.instantFeeMinor }) })
            : t('consultNow.state.availableForModes', { modes: modesText(sent.modes) }), message: doubt.message })}</> : <>{t('consultNow.yourAvailabilityIsNotConfirmedFull', { message: doubt.message })}</>}
          {' '}{t('consultNow.itMayStillBeApplied')}</Alert>
      )}
      {on && !p.live && (
        <p className="ws-muted">{t('consultNow.switchedOnButNoWorkspace')}</p>
      )}
      {on && p.live && (
        <p className="ws-muted">{t('consultNow.keepAWorkspacePageOpen')}{p.lastBeatAt ? ` ${t(now.getTime() - p.lastBeatAt > 120_000 ? 'consultNow.lastCheckInOld' : 'consultNow.lastCheckIn', { when: formatDateTime(new Date(p.lastBeatAt).toISOString()) })}` : ''}
        </p>
      )}
      {on && p.live && p.online === false && (
        <Alert tone="warn">{pr?.busy ? (pr.busyUntil ? t('consultNow.notOffered.busyUntil', { date: formatDateTime(pr.busyUntil) }) : t('consultNow.notOffered.busy')) : t('consultNow.notOffered.unknown')}</Alert>
      )}
      {p.problem && <Alert tone="warn">{p.problem}</Alert>}
      {notice && <Alert tone="ok">{notice}</Alert>}
      {failure && <Alert>{failure}</Alert>}
      {!pr && !(doubt && p.shown) ? (
        <div className="confirm-actions">
          <Button busy={p.busy} onClick={() => void check()}>{t('consultNow.checkWhatTheServerHas')}</Button>
        </div>
      ) : (
        <form className="rx-form" noValidate onSubmit={(e) => void send(primaryAvailable, e)} aria-label={t('common.availableNow')}>
          <fieldset className="ws-checks" aria-describedby={errors.modes ? 'avail-modes-err' : undefined}>
            <legend>{t('consultNow.consultationTypesYouTakeNow')}</legend>
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
            <TextField label={t('consultNow.yourFeeForAnInstant')} inputMode="decimal" value={feeText} error={errors.fee} disabled={p.busy}
              hint={t('consultNow.offersComeOnlyFromPatients')} onChange={(e) => setFee(e.target.value)} />
          </div>
          {doubt && p.shown ? (
            <div className="confirm-actions">
              {/* An ordered write against the version just read: acknowledged, no earlier change of this page can commit any more. */}
              <Button type="submit" busy={p.busy}>{t('consultNow.confirmTheseTerms')}</Button>
              {p.shown.available && <Button variant="secondary" disabled={p.busy} onClick={() => void send(false)}>{t('consultNow.stopBeingAvailable')}</Button>}
              <Button variant="ghost" disabled={p.busy} onClick={() => void check()}>{t('consultNow.checkAgain')}</Button>
            </div>
          ) : (
            <div className="confirm-actions">
              <Button type="submit" busy={p.busy}>{on && p.live ? t('consultNow.update') : t('consultNow.goAvailableNow')}</Button>
              {on && <Button variant="secondary" disabled={p.busy} onClick={() => void send(false)}>{t('consultNow.stopBeingAvailable')}</Button>}
            </div>
          )}
        </form>
      )}
    </section>
  );
}

const modesText = (modes: readonly InstantMode[]) => modes.map((m) => CONSULT_MODE_LABEL[m]).join(', ');
const termsText = (pr: { modes: InstantMode[]; instantFeeMinor: number }) =>
  t('consultNow.terms', { modes: modesText(pr.modes), fee: rupeesOf(pr.instantFeeMinor) });
/** What the server has: available (with its terms) or not. */
const stateWords = (r: { available: boolean; modes: InstantMode[]; instantFeeMinor: number }) =>
  (r.available ? t('consultNow.state.availableFor', { terms: termsText(r) }) : t('consultNow.state.notAvailable'));

// ── Offers ──

type Outcome =
  | { kind: 'accepted'; offer: InstantOffer; booking: DoctorAppointment; replayed?: boolean }
  | { kind: 'refused'; offer: InstantOffer; message: string }
  | { kind: 'unknown'; offer: InstantOffer; message: string; checking: boolean; checked?: string };

const offerLabel = (o: InstantOffer) => t('consultNow.offerLabel', { mode: CONSULT_MODE_LABEL[o.mode], specialization: o.specialization });
const patientLabel = (o: InstantOffer) =>
  [o.patient.name, o.patient.age !== undefined ? t('consultNow.ageYears', { age: o.patient.age }) : null, o.patient.gender ?? null].filter(Boolean).join(', ');
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
            checked: t('consultNow.itIsNotAmongYour') });
        } catch (lookErr) {
          if (current(n)) setOutcome({ kind: 'unknown', offer, message: messageOf(err), checking: false, checked: t('consultNow.couldNotCheckYourAppointments', { value: messageOf(lookErr) }) });
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
      <h2 id="offers-h">{t('consultNow.offersForYou')}</h2>
      <p className="ws-muted">{t('consultNow.anOfferStaysOpenForFull', { CONSULT_MINUTES })}</p>
      {outcome?.kind === 'accepted' && (
        <Alert tone="ok"><Parts of={t.rich(outcome.replayed ? 'consultNow.youAcceptedTheReplayed' : 'consultNow.youAcceptedTheFull', { offerLabel: offerLabel(outcome.offer).toLowerCase(), name: outcome.offer.patient.name, words: <Link to="/doctor/appointments">{t('consultNow.appointments')}</Link> })} /></Alert>
      )}
      {acceptedBooking && <MeetLink b={acceptedBooking} onRefresh={() => day.refetch()} />}
      {outcome?.kind === 'refused' && <Alert>{t('consultNow.notAccepted')}{outcome.offer.patient.name}): {outcome.message}</Alert>}
      {outcome?.kind === 'unknown' && (
        <Alert tone="warn">{t('consultNow.theAnswerToYourAcceptFull', { name: outcome.offer.patient.name, message: outcome.message, checkingYourAppointments: outcome.checking ? t('consultNow.checkingYourAppointments') : outcome.checked ?? '' })}
        </Alert>
      )}
      {offers.isError && offers.data !== undefined && <RefreshFailed error={offers.error} readAt={offers.dataUpdatedAt} onRetry={offers.refetch} />}
      {offers.isPending ? <Loading label={t('consultNow.loadingOffers')} />
        : offers.isError && offers.data === undefined ? <ErrorState message={messageOf(offers.error)} onRetry={() => void offers.refetch()} />
        : list.length === 0 ? <Empty title={t('consultNow.noOffersRightNow')}>{presence.presence?.available ? t('consultNow.newOffersAppearHereOn') : t('consultNow.goAvailableNowToReceive')}</Empty>
        : (
          <>
          {!canAccept && (
            <Alert tone="warn">
              {presence.busy ? t('consultNow.yourChangeToAvailableNow')
                : t('consultNow.toAcceptSwitchAvailableNow')}
            </Alert>
          )}
          <ul className="stock-list" aria-label={t('consultNow.openOffers')}>
            {list.map((o) => {
              const left = offerSecondsLeft(o, now);
              // Q13: the patient's paid quote caps the fee. Judged on the acknowledged fee (the one the accept will use).
              const myFee = canAccept && presence.presence ? presence.presence.instantFeeMinor : o.yourFeeMinor ?? null;
              const tooHigh = o.quotedAmountMinor !== undefined && myFee !== null ? myFee > o.quotedAmountMinor : o.feeWithinQuote === false;
              return (
                <li key={`${o.requestId}:${o.generation}`} className="doc-offer" aria-label={t('consultNow.offerFor', { name: o.patient.name })}>
                  <div className="stock-head">
                    <strong>{offerLabel(o)}</strong>
                    {left > 0 ? <Badge tone={left < 60 ? 'warn' : undefined}>{t('consultNow.closesInFull', { mmss: mmss(left) })}</Badge> : <Badge tone="danger">{t('consultNow.closed')}</Badge>}
                  </div>
                  <span>{o.quotedAmountMinor !== undefined ? t('consultNow.patientPaid', { patientLabel: patientLabel(o), amount: rupeesOf(o.quotedAmountMinor) }) : t('consultNow.patientFull', { patientLabel: patientLabel(o) })}</span>
                  {tooHigh && <span className="ws-muted">{t('consultNow.isAboveWhatThisPatientFull', { value: myFee !== null ? ` (${rupeesOf(myFee)})` : '' })}</span>}
                  {confirmFor === o.requestId ? (
                    <div className="confirm" role="group" aria-label={t('consultNow.acceptTheOfferFor', { name: o.patient.name })}>
                      <div className="confirm-text">{t('consultNow.acceptTheFull', { offerLabel: offerLabel(o).toLowerCase(), patientLabel: patientLabel(o), CONSULT_MINUTES, fee: fee ?? t('consultNow.feeNotConfirmed') })}</div>
                      <div className="confirm-actions">
                        <Button busy={sending === o.requestId} disabled={left === 0 || !canAccept || tooHigh || (sending !== null && sending !== o.requestId)} onClick={() => void accept(o)}>{t('consultNow.acceptAndStart')}</Button>
                        <Button variant="ghost" disabled={sending === o.requestId} onClick={() => setConfirmFor(null)}>{shared('action.back')}</Button>
                      </div>
                    </div>
                  ) : (
                    <div className="ws-actions">
                      <Button disabled={left === 0 || !canAccept || tooHigh || sending !== null} aria-label={t('consultNow.acceptTheOfferFor', { name: o.patient.name })}
                        onClick={() => { setConfirmFor(o.requestId); setOutcome(null); }}>{t('consultNow.accept')}</Button>
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
      <h2 id="running-h">{t('consultNow.instantConsultationsToday')}</h2>
      {q.isError && q.data !== undefined && <RefreshFailed error={q.error} readAt={q.dataUpdatedAt} onRetry={q.refetch} />}
      {q.isPending ? <Loading label={t('consultNow.loadingTodaySConsultations')} />
        : q.isError && q.data === undefined ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : running.length === 0 ? <Empty title={t('consultNow.noneRunning')}>{t('consultNow.acceptedInstantConsultationsAppearHere')}</Empty>
        : (
          <ul className="stock-list" aria-label={t('consultNow.runningInstantConsultations')}>
            {running.map((b) => (
              <RunningItem key={b._id} d={d} booking={b}
                link={<MeetLink b={b} gaveUp={meet.gaveUp(b._id, now)} onRefresh={() => { meet.restart(b._id); return q.refetch(); }} />} />
            ))}
          </ul>
        )}
      <p className="ws-muted"><Parts of={t.rich('consultNow.markAConsultationCompletedOrFull', { words: <Link to="/doctor/appointments">{t('common.appointments')}</Link> })} /></p>
    </section>
  );
}

type ExtendBody = { minutes: number };
/** Session memory slot of an extension whose outcome is not known (one per booking; the session is the doctor's). */
const extendSlot = (bookingId: string) => `doctor-extend:${bookingId}`;

/**
 * One running instant consultation and its extensions. An extension is a once-only operation (Q13 request key): it is
 * stored in session memory BEFORE it is sent (a body-less marker survives a reload), so leaving the page or the row
 * unmounting never loses it. While it is unresolved only reconciliation is offered — the booking read, which lists the
 * recorded extensions with their keys, or the unchanged same-key resend — never a new extension. It is settled only by
 * the attempt that still owns it.
 */
function RunningItem({ d, booking, link }: { d: DoctorContext; booking: DoctorAppointment; link: ReactNode }) {
  const { memory } = useSession();
  const slot = extendSlot(booking._id);
  const [minutes, setMinutes] = useState('10');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);
  const [op, setOp] = useState<PendingOp<ExtendBody> | undefined>(() => memory.get<PendingOp<ExtendBody>>(slot));
  /**
   * WQ11c: the key whose same-key resend the server refused outright (e.g. it would run into the next booking): that key
   * was not recorded when the resend arrived, so another extension (a new key) may be chosen; and the key a check found
   * not recorded (e.g. after a reload): it may be forgotten after a second step. Neither is kept across leaving the page.
   */
  const [refusedKey, setRefusedKey] = useState<string | null>(null);
  const [notFoundKey, setNotFoundKey] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const sync = () => { if (alive.current) setOp(memory.get<PendingOp<ExtendBody>>(slot)); };
  const say = (tone: 'ok' | 'warn' | 'error', text: string) => { if (alive.current) setNotice({ tone, text }); };
  const label = t('consultNow.acceptedAt', { mode: booking.consultationMode ? CONSULT_MODE_LABEL[booking.consultationMode] : t('consultNow.instant'), time: booking.bookingTime });

  /** Looks for the unresolved extension on the booking (its recorded extensions carry their request keys). */
  async function reconcile(cause?: string) {
    const current = memory.get<PendingOp<ExtendBody>>(slot);
    if (!current) return;
    // The answer may settle only the operation it was asked for, on the page that asked: a check captured before a
    // newer attempt started (or by a page since left) never deletes or rewrites that attempt's recovery state.
    const owns = () => alive.current && stillCurrent(memory.get<PendingOp<ExtendBody>>(slot), current);
    setChecking(true);
    try {
      const b = await d.api.instantBooking(booking._id);
      if (!owns()) return;
      const done = b.extensions.find((x) => x.requestKey === current.requestKey);
      if (done) {
        memory.delete(slot);
        sync();
        say('ok', t('consultNow.extendedByMinutesYourTime', { minutes: done.minutes, when: formatDateTime(done.endTime) }));
        return;
      }
      if (b.status !== 'confirmed' || !b.held?.isActive) {
        // The consultation is over: this extension can never be added any more.
        memory.delete(slot);
        sync();
        say('warn', t('consultNow.notExtendedTheConsultationIs'));
        return;
      }
      setNotFoundKey(current.requestKey);
      say('warn', `${cause ? `${cause} ` : ''}${t('consultNow.extensionNotRecorded')} ${current.restored
        ? t('consultNow.itsDetailsWereNotKept')
        : t('consultNow.sendTheSameExtensionAgain')}`);
    } catch (err) {
      if (!owns()) return;
      say('warn', `${cause ? `${cause} ` : ''}${t('consultNow.extensionCheckFailed', { message: messageOf(err) })} ${current.restored
        ? t('consultNow.checkAgainInAMoment') : t('consultNow.sendingTheSameExtensionAgain')}`);
    } finally {
      if (alive.current) setChecking(false);
    }
  }

  // Coming back to an unresolved extension: look for it first.
  const checked = useRef(false);
  useEffect(() => {
    if (checked.current || !memory.get(slot)) return;
    checked.current = true;
    void reconcile();
  });

  async function extend(e: FormEvent) {
    e.preventDefault();
    let base = memory.get<PendingOp<ExtendBody>>(slot);
    if (base?.restored || (base && !base.body)) return; // only reconciliation
    if (!base) {
      const n = /^\d{1,2}$/.test(minutes.trim()) ? Number(minutes.trim()) : NaN;
      if (!Number.isInteger(n) || n < 1 || n > EXTEND_MINUTES_MAX) { setFieldError(t('consultNow.enter1ToMinutes', { EXTEND_MINUTES_MAX })); return; }
      base = startOp(newRequestKey(), { minutes: n });
    }
    const attempt = beginAttempt(base);
    memory.set(slot, attempt); // stored before it is sent
    sync();
    setFieldError(null);
    setBusy(true);
    setNotice(null);
    try {
      const r = await d.api.extend(booking._id, attempt.body.minutes, attempt.requestKey);
      // Settled only by the attempt that still owns the stored operation, on the page that sent it. An older attempt
      // answering late (its page left, a same-key retry made since) leaves the newer attempt's state alone: the next
      // check on that page finds the key recorded and settles it.
      if (!alive.current || !stillCurrent(memory.get<PendingOp<ExtendBody>>(slot), attempt)) return;
      memory.delete(slot);
      sync();
      say('ok', t('consultNow.extendedByMinutesYourTime', { minutes: attempt.body.minutes, when: formatDateTime(r.extension?.endTime ?? r.endTime) }));
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return; // the session ended
      if (!alive.current || !stillCurrent(memory.get<PendingOp<ExtendBody>>(slot), attempt)) return;
      const refusal = instantRefusal(err);
      const after = afterFailure(attempt, err, messageOf(err));
      if (after) memory.set(slot, after); else memory.delete(slot);
      sync();
      if (!after) { say('error', t('consultNow.notExtended', { value: refusal ?? messageOf(err) })); return; }
      // A same-key resend refused outright: the key was not recorded when it arrived (a recorded key is answered again).
      // (A 401 says nothing about the request: the session ended.)
      if (definitelyNotRecorded(err) && !(err instanceof ApiError && err.status === 401)) setRefusedKey(attempt.requestKey);
      await reconcile(refusal ? t('consultNow.notExtendedThisTime', { refusal }) : messageOf(err));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  /** Ends the unresolved extension on this page (only the one shown): the field is free for a new extension. */
  function release(text: string) {
    const current = memory.get<PendingOp<ExtendBody>>(slot);
    if (!op || !current || current.requestKey !== op.requestKey) return;
    if (current.body) setMinutes(String(current.body.minutes));
    memory.delete(slot);
    sync();
    setRefusedKey(null);
    setNotFoundKey(null);
    say('warn', text);
  }

  /**
   * WQ11d: a refused resend says nothing about the FIRST send, which may still have been added. Before a new key is
   * allowed the booking is read again: a recorded extension settles it; otherwise the field is freed with the time held
   * now, and the words say the earlier one may still have been added.
   */
  async function chooseAnother() {
    const current = memory.get<PendingOp<ExtendBody>>(slot);
    if (!current) return;
    setChecking(true);
    try {
      const b = await d.api.instantBooking(booking._id);
      if (!alive.current || !stillCurrent(memory.get<PendingOp<ExtendBody>>(slot), current)) return;
      const done = b.extensions.find((x) => x.requestKey === current.requestKey);
      if (done) {
        memory.delete(slot);
        sync();
        setRefusedKey(null);
        say('ok', t('consultNow.extendedByMinutesAfterAll', { minutes: done.minutes, when: formatDateTime(done.endTime) }));
        return;
      }
      release(b.held?.endTime ? t('consultNow.extendAgainHeldUntil', { until: formatDateTime(b.held.endTime) }) : t('consultNow.chooseTheMinutesAndExtend'));
    } catch (err) {
      say('warn', t('consultNow.couldNotReadTheConsultation', { value: messageOf(err) }));
    } finally {
      if (alive.current) setChecking(false);
    }
  }

  const locked = !!op;
  const refused = !!op && refusedKey === op.requestKey;
  const forgettable = !!op && !busy && !checking && (refused || notFoundKey === op.requestKey);
  return (
    <li className="doc-offer" aria-label={label}>
      <strong>{label}</strong>
      {link}
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      <form className="ws-search" noValidate onSubmit={(e) => void extend(e)} aria-label={t('consultNow.extendThe', { value: label.toLowerCase() })}>
        <TextField label={t('consultNow.extendByMinutes')} inputMode="numeric" value={op?.body ? String(op.body.minutes) : locked ? '' : minutes} error={fieldError} disabled={locked}
          hint={t('consultNow.extendMinutesHint', { max: EXTEND_MINUTES_MAX })} onChange={(e) => setMinutes(e.target.value)} />
        {!op ? <Button type="submit" variant="secondary" busy={busy}>{t('consultNow.extend')}</Button> : (
          <>
            {!op.restored && op.body && <Button type="submit" variant="secondary" busy={busy} disabled={checking}>{t('consultNow.sendTheSameExtensionAgain2')}</Button>}
            <Button variant="ghost" busy={checking} disabled={busy} onClick={() => void reconcile()}>{t('consultNow.checkWhetherItWasRecorded')}</Button>
            {refused && !busy && !checking && (
              <Button variant="secondary" onClick={() => void chooseAnother()}>{t('consultNow.chooseAnotherExtension')}</Button>
            )}
          </>
        )}
      </form>
      {forgettable && (
        <ConfirmAction label={t('consultNow.forgetIt')} danger confirmLabel={t('consultNow.forgetThisExtension')}
          consequence={t('consultNow.theExtensionIsNotRecorded')}
          onConfirm={async () => release(t('consultNow.forgottenCheckTheTimeHeld'))} />
      )}
    </li>
  );
}
