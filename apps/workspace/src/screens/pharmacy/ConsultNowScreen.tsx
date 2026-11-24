import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  changedQuote, CONSENT_STATEMENT_LANGUAGE, CONSENT_STATEMENT_VERSION, INSTANT_ACTIVITY_MS, INSTANT_DESK_MODES, INSTANT_MODE_LABEL, INSTANT_POLL_MS,
  INSTANT_SWITCHED_OFF_MESSAGE, instantBookerRefusal, instantStage, offerCountdown, patientBody, pharmacyAssistedApi, pharmacyInstantApi,
  type InstantBookerByKey, type InstantBookerReceipt, type InstantBookerRequest, type InstantDeskMode, type InstantTarget,
} from '@jansetu/api';
import { Alert, Badge, Button, ErrorState, formatRupees, Loading } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { PageHeading } from '../../PageHeading.tsx';
import { definitelyNotRecorded, newRequestKey } from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { useOneAtATime } from '../finance/finance.tsx';
import { useAssistedCreate } from './assistedCreate.ts';
import { CursorPager, useCursorPages } from './cursorList.tsx';
import { ConsultExtras, consultExtrasProblems, couponOf, EMPTY_EXTRAS, EMPTY_JOIN, JoinFields, joinOf, joinProblems, type ConsultExtrasDraft, type JoinDraft } from './bookingFields.tsx';
import { JoinCall } from './BookedConsultationScreen.tsx';
import { usePharmacyId } from './ownedOp.tsx';
import { PatientSection, usePatientStep } from './patientStep.tsx';
import { UnconfirmedBooking } from './unconfirmedBooking.tsx';
import { WalletPay } from './walletPay.tsx';

/**
 * WQ22: "Consult now" (assisted booking round 3e, backend r17, design §25.12): a pharmacy connects a patient at its
 * counter with a doctor online now, paid from its Jansetu wallet. The shared patient step, then the speciality, video or
 * phone call, any available doctor or a chosen one, the quote and one keyed request (`POST /pharmacy-assisted/instant/
 * requests`, the shared assisted create). Then the request waits for a doctor: the screen tells the server the pharmacy is
 * still here (activity), and offers "Ask again" and "Cancel and refund"; once a doctor accepts, the booking's Join call.
 * The phone stays in this page's state and in POST bodies: never in the address bar, storage or logs.
 */
export function PharmacyConsultNowScreen() {
  const pharmacyId = usePharmacyId();
  return (
    <>
      <PageHeading title="Consult now">
        Connect a patient at your counter with a doctor who is online now. Jansetu takes the fee from your wallet; you collect it from the patient.
      </PageHeading>
      <Consult key={pharmacyId} pharmacyId={pharmacyId} />
    </>
  );
}

interface Summary { patient: string; speciality: string; mode: InstantDeskMode; doctor: string; priceMinor: number; couponCode?: string; couponChecked?: boolean }
interface PendingInstant { request: InstantBookerRequest; summary: Summary }
/** The request being followed on this screen (its id only is kept in session memory, so leaving and coming back finds it). */
const activeSlot = (pharmacyId: string) => `assisted-instant-active:${pharmacyId}`;

function SummaryList({ s }: { s: Summary }) {
  return (
    <ul className="ws-list">
      <li>Patient: <strong>{s.patient}</strong></li>
      <li>Doctor: <strong>{s.doctor}</strong>, {s.speciality}</li>
      <li>How: <strong>{INSTANT_MODE_LABEL[s.mode]}</strong></li>
      <li>Price: <strong>{formatRupees(s.priceMinor / 100)}</strong>{s.couponCode ? ` (coupon ${s.couponCode})` : ''}</li>
    </ul>
  );
}

function Consult({ pharmacyId }: { pharmacyId: string }) {
  const { api, memory } = useSession();
  const instant = pharmacyInstantApi(api);
  const { perform, busy } = useOneAtATime('booking');
  const [off, setOff] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeId, setActiveIdState] = useState<string | null>(() => memory.get<string>(activeSlot(pharmacyId)) ?? null);
  const setActive = (id: string | null) => { if (id) memory.set(activeSlot(pharmacyId), id); else memory.delete(activeSlot(pharmacyId)); setActiveIdState(id); };
  /** QUOTE_CHANGED: the quote and discount the server named, for "Use the new price". */
  const [newQuote, setNewQuote] = useState<{ quotedAmountMinor: number; discountMinor: number } | null>(null);

  // The keyed create, shared with Book consultation and Book lab test (`assistedCreate.ts`).
  const create = useAssistedCreate<PendingInstant, InstantBookerReceipt, InstantBookerByKey>({
    slot: `assisted-instant:${pharmacyId}`, perform, book: (request) => instant.request(request), abandon: (key) => instant.abandon(key),
    refusal: instantBookerRefusal, walletKey: ['pharmacy-wallet', pharmacyId], refreshKeys: [['pharmacy-bookings', pharmacyId], ['assisted-instant', pharmacyId]],
    onReceipt: (r) => { setActive(r.request._id); if (r.newAccount) setNotice('This number was new to Jansetu. An account was made for it.'); },
    onUsed: (r, p) => { settle(p.requestKey); setReview(null); setActive(r.request._id); create.refresh(); return null; },
    onOff: () => setOff(true),
    onNotice: setNotice,
    onRefused: (why, err) => {
      if (why.kind === 'price') setNewQuote(changedQuote(err));
      if (why.kind === 'doctor') { setReview(null); setDoctorId(''); void doctors.refetch(); void specialities.refetch(); }
    },
  });
  const { op, settle, review, setReview, refused, setRefused, resendError, setResendError, givingUp } = create;

  // Step 1: the patient (the shared step).
  const pt = usePatientStep({ pharmacyId, perform, onFind: () => setNotice(null), onSwitchedOff: () => setOff(true),
    onChangePhone: () => { setReview(null); setRefused(null); } });
  const { lookup, patient, patientDone, patientLabel } = pt;

  // Step 2: speciality, video or call, any doctor or a chosen one, where the patient joins, the extras.
  const [mode, setMode] = useState<InstantDeskMode>('video');
  const [speciality, setSpeciality] = useState('');
  /** '' = any available doctor. */
  const [doctorId, setDoctorId] = useState('');
  const [join, setJoin] = useState<JoinDraft>(EMPTY_JOIN);
  const [extras, setExtras] = useState<ConsultExtrasDraft>(EMPTY_EXTRAS);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [quoting, setQuoting] = useState(false);
  const specialities = useQuery({ queryKey: ['assisted-instant', pharmacyId, 'specialities', mode], queryFn: () => instant.specialities(mode), enabled: patientDone && !off });
  const doctors = useQuery({
    queryKey: ['assisted-instant', pharmacyId, 'doctors', speciality, mode], queryFn: () => instant.doctors({ speciality, mode }), enabled: patientDone && !off && !!speciality,
  });
  // WQ22c L3: also a server without these routes (a 404 with no code) says "not switched on".
  const offOf = (err: unknown) => !!err && instantBookerRefusal(err).kind === 'off';
  useEffect(() => { if (offOf(specialities.error) || offOf(doctors.error)) setOff(true); }, [specialities.error, doctors.error]);
  const online = useMemo(() => (specialities.data ?? []).filter((x) => x.onlineNow > 0), [specialities.data]);

  function resetAll() {
    pt.reset(); setMode('video'); setSpeciality(''); setDoctorId(''); setJoin(EMPTY_JOIN); setExtras(EMPTY_EXTRAS); setErrors({});
    setReview(null); setRefused(null); setNotice(null); setNewQuote(null); setActive(null);
    // The waiting list is read again (the request just followed may have been accepted or refunded meanwhile).
    create.refresh();
  }

  async function next(e: FormEvent) {
    e.preventDefault();
    setRefused(null);
    const errs: Record<string, string> = { ...joinProblems(mode, join), ...consultExtrasProblems(extras) };
    if (!speciality) errs.speciality = 'Choose what the patient needs.';
    setErrors(errs);
    if (Object.keys(errs).length || !lookup) return;
    const doctor = doctors.data?.find((d) => d.doctorId === doctorId);
    setQuoting(true);
    try {
      // The price now: the chosen doctor's fee, or for any doctor the highest fee among those online.
      const q = await perform(() => instant.quote({ speciality, mode, ...(doctorId ? { doctorId } : {}) }));
      const target: InstantTarget = doctorId ? { kind: 'specific', doctorId } : { kind: 'any' };
      const code = couponOf(extras);
      const requestKey = newRequestKey();
      const request: InstantBookerRequest = {
        requestKey, phone: lookup.phone, ...patientBody({ ...patient, phone: lookup.phone }),
        consent: { agreed: true, statementVersion: CONSENT_STATEMENT_VERSION, statementLanguage: CONSENT_STATEMENT_LANGUAGE },
        preferredLanguage: extras.language, specialization: speciality, mode, target, join: joinOf(mode, join)!,
        ...(code ? { couponCode: code } : {}), acceptedQuoteMinor: q.quotedAmountMinor, acceptedPayableMinor: q.quotedAmountMinor,
        ...(extras.concern.trim() ? { primaryConcern: extras.concern.trim() } : {}), paymentMethod: 'wallet',
      };
      setNewQuote(null);
      setReview({ requestKey, request, summary: { patient: patientLabel(), speciality, mode, doctor: doctor?.name ?? 'Any available doctor',
        priceMinor: q.quotedAmountMinor, ...(code ? { couponCode: code } : {}) } });
    } catch (err) {
      const why = instantBookerRefusal(err);
      if (why.kind === 'off') setOff(true); else setRefused(why);
    } finally {
      setQuoting(false);
    }
  }

  /** "Use the new price" after QUOTE_CHANGED: the quote and payable the server named, as a new request (a new key). */
  function useNewQuote() {
    if (!review || !newQuote) return;
    const payable = Math.max(0, newQuote.quotedAmountMinor - newQuote.discountMinor);
    const requestKey = newRequestKey();
    setRefused(null);
    setReview({ ...review, requestKey, request: { ...review.request, requestKey, acceptedQuoteMinor: newQuote.quotedAmountMinor, acceptedPayableMinor: payable },
      summary: { ...review.summary, priceMinor: payable, couponChecked: true } });
    setNewQuote(null);
  }

  if (op && !(busy && !givingUp && op.attempts === 1 && !op.uncertain)) {
    return (
      <UnconfirmedBooking op={op} what="request" busy={busy} givingUp={givingUp} resendError={resendError} byKey={() => instant.byKey(op.requestKey)}
        onUsed={(r) => { settle(op.requestKey); setReview(null); setActive(r.request._id); create.refresh(); return null; }}
        onAbandoned={() => create.abandonedByCheck(op.requestKey)}
        onResend={() => { setResendError(null); void create.send(op).catch((err: unknown) => setResendError(instantBookerRefusal(err).message)); }}
        onGiveUp={() => void create.giveUp(op)}
        summary={op.body && <SummaryList s={op.body.summary} />} />
    );
  }
  if (off) return <Alert tone="warn">{INSTANT_SWITCHED_OFF_MESSAGE} Jansetu turns it on for your pharmacy when it is ready. Book consultation works as usual.</Alert>;
  if (activeId) return <Waiting pharmacyId={pharmacyId} requestId={activeId} onAnother={resetAll} />;

  const frozen = !!review || busy;
  return (
    <>
      {notice && <Alert tone="ok">{notice}</Alert>}
      <OpenRequests pharmacyId={pharmacyId} onOpen={setActive} />
      <PatientSection step={pt} busy={busy} frozen={patientDone || frozen} locked={frozen} nextLabel="Next: choose the doctor" />
      {patientDone && (
        <section className="ws-section" aria-labelledby="cn-h">
          <h2 id="cn-h">2. Doctor</h2>
          <form className="rx-form" noValidate onSubmit={(e) => void next(e)} aria-label="Doctor">
            <fieldset className="ws-frozen" disabled={frozen}>
              <fieldset className="ws-checks">
                <legend>How does the consultation happen?</legend>
                {INSTANT_DESK_MODES.map((m) => (
                  <label key={m} className="ws-check">
                    <input type="radio" name="cn-mode" checked={mode === m} onChange={() => { setMode(m); setSpeciality(''); setDoctorId(''); setJoin(EMPTY_JOIN); }} /> {INSTANT_MODE_LABEL[m]}
                  </label>
                ))}
              </fieldset>
              {specialities.isPending ? <Loading label="Finding doctors online…" />
                : specialities.isError ? <ErrorState message={instantBookerRefusal(specialities.error).message} onRetry={() => void specialities.refetch()} />
                : online.length === 0 ? <Alert tone="warn">No doctor is online for {INSTANT_MODE_LABEL[mode].toLowerCase()}s now. Try again in a few minutes, or <Link to="/pharmacy/book">book a time</Link>.</Alert>
                : (
                  <div className="j-field">
                    <label htmlFor="cn-speciality">What does the patient need?</label>
                    <select id="cn-speciality" value={speciality} aria-invalid={errors.speciality ? true : undefined}
                      aria-describedby={errors.speciality ? 'cn-speciality-err' : undefined} onChange={(e) => { setSpeciality(e.target.value); setDoctorId(''); }}>
                      <option value="">Choose…</option>
                      {online.map((x) => <option key={x.specialization} value={x.specialization}>{x.specialization} ({x.onlineNow} online)</option>)}
                    </select>
                    {errors.speciality && <span id="cn-speciality-err" className="j-field__error" role="alert">{errors.speciality}</span>}
                  </div>
                )}
              {speciality && (
                <fieldset className="ws-checks">
                  <legend>Doctor</legend>
                  <label className="ws-check">
                    <input type="radio" name="cn-doctor" checked={doctorId === ''} onChange={() => setDoctorId('')} /> Any available doctor (the first to accept)
                  </label>
                  {doctors.isPending ? <Loading label="Finding doctors…" />
                    : doctors.isError ? <ErrorState message={instantBookerRefusal(doctors.error).message} onRetry={() => void doctors.refetch()} />
                    : doctors.data.map((d) => (
                      <label key={d.doctorId} className="ws-check">
                        <input type="radio" name="cn-doctor" checked={doctorId === d.doctorId} onChange={() => setDoctorId(d.doctorId)} />
                        {d.name} · {formatRupees(d.instantFeeMinor / 100)}
                        {d.nearby === 'pincode' ? <> <Badge tone="ok">Near you</Badge></> : d.nearby === 'city' ? <> <Badge>Same city</Badge></> : null}
                      </label>
                    ))}
                </fieldset>
              )}
              <JoinFields mode={mode} value={join} errors={errors} onChange={setJoin} />
              <ConsultExtras value={extras} errors={errors} onChange={setExtras} />
            </fieldset>
            {refused && !review && <Alert>{refused.message}</Alert>}
            {!review && <div><Button type="submit" busy={quoting}>Next: check the price</Button></div>}
          </form>
        </section>
      )}
      {review && (
        <section className="ws-section" aria-labelledby="cn-pay-h">
          <h2 id="cn-pay-h">3. Check and pay</h2>
          <div className="confirm" role="group" aria-label="Check and pay">
            <SummaryList s={review.summary} />
            {review.summary.couponCode && !review.summary.couponChecked && <p className="ws-muted">Price before the coupon; the coupon is checked when you pay.</p>}
            <WalletPay pharmacyId={pharmacyId} priceMinor={review.summary.priceMinor} couponCode={review.summary.couponCode} refused={refused} busy={busy}
              payLabel={(amount) => `Pay ${amount} from wallet and request`}
              onPay={() => void create.pay()} onBack={() => { setReview(null); setRefused(null); }} onNewPrice={useNewQuote} />
          </div>
        </section>
      )}
    </>
  );
}

/**
 * WQ22b: this pharmacy's requests still waiting for a doctor (`GET /requests?status=offered`, newest first), shown only when
 * there are some: after a reload or on another device a waiting request is found here (its id is kept in session memory
 * only), so it is followed, refunded or asked again rather than requested a second time.
 */
function OpenRequests({ pharmacyId, onOpen }: { pharmacyId: string; onOpen: (id: string) => void }) {
  const { api } = useSession();
  const pages = useCursorPages();
  const list = useQuery({
    queryKey: ['assisted-instant', pharmacyId, 'open', pages.cursor],
    queryFn: () => pharmacyInstantApi(api).requests({ status: 'offered', limit: 20, ...(pages.cursor ? { cursor: pages.cursor } : {}) }),
  });
  if (!list.data || (list.data.items.length === 0 && pages.page === 1)) return null;
  return (
    <section className="ws-section" aria-labelledby="open-h">
      <h2 id="open-h">Waiting for a doctor</h2>
      <ul className="ws-list" aria-label="Requests waiting for a doctor">
        {list.data.items.map((r) => (
          <li key={r._id} className="ws-actions">
            <span>{r.patientName ?? 'A patient'} · {r.specialization} · {INSTANT_MODE_LABEL[r.mode] ?? r.mode}{r.money ? ` · ${formatRupees(r.money.paidMinor / 100)}` : ''}</span>
            <Button variant="secondary" aria-label={`Open the request for ${r.patientName ?? 'the patient'}`} onClick={() => onOpen(r._id)}>Open</Button>
          </li>
        ))}
      </ul>
      <CursorPager pages={pages} nextCursor={list.data.nextCursor} label="Waiting request pages" />
    </section>
  );
}

/**
 * The request waiting for a doctor (`GET /requests/:id`, read every few seconds). While it waits the screen tells the
 * server the pharmacy is still here (`POST …/activity`; without it the money comes back 30 minutes later). "Ask again"
 * offers it again (to the same choice, or to any doctor), "Cancel and refund" returns the money before a doctor accepts;
 * both name the version shown. Once a doctor accepts: the booking's Join call and its page.
 */
function Waiting({ pharmacyId, requestId, onAnother }: { pharmacyId: string; requestId: string; onAnother: () => void }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const instant = pharmacyInstantApi(api);
  const key = ['assisted-instant', pharmacyId, 'request', requestId];
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const q = useQuery({ queryKey: key, queryFn: () => instant.one(requestId), refetchInterval: (query) => (query.state.data?.status === 'offered' ? INSTANT_POLL_MS : false) });
  const v = q.data;
  // WQ22c L1: activity ONLY while an offer is open (a doctor may still accept). Once the offer ran out nothing is sent, so
  // the 30-minute inactivity refund starts even with this tab open; "Ask again" opens a new offer (and activity again).
  const offerOpen = !!v && instantStage(v, now) === 'waiting';
  // Activity while the screen is open and the offer waits (best effort: a missed one only brings the refund nearer).
  useEffect(() => {
    if (!offerOpen) return;
    const tell = () => { void instant.activity(requestId).catch(() => undefined); };
    tell();
    const t = setInterval(tell, INSTANT_ACTIVITY_MS);
    return () => clearInterval(t);
  }, [offerOpen, requestId]); // eslint-disable-line react-hooks/exhaustive-deps
  const booking = useQuery({
    queryKey: ['pharmacy-bookings', pharmacyId, 'one', v?.bookingId],
    queryFn: () => pharmacyAssistedApi(api).booking(v!.bookingId!),
    enabled: v?.status === 'accepted' && !!v.bookingId,
  });
  const { perform, busy } = useOneAtATime('request');
  const [outcome, setOutcome] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);
  const settleRead = () => queryClient.invalidateQueries({ queryKey: key });

  /** A command on the version shown; a lost answer is settled by reading the request again. */
  const command = <T,>(run: () => Promise<T>, done: (answer: T) => string) => perform(async () => {
    setOutcome(null);
    try {
      setOutcome({ tone: 'ok', text: done(await run()) });
    } catch (err) {
      const why = instantBookerRefusal(err);
      setOutcome({ tone: definitelyNotRecorded(err) ? 'error' : 'warn', text: definitelyNotRecorded(err) ? why.message : `Not confirmed: ${why.message} It is shown as it is now.` });
    } finally {
      await settleRead();
      void queryClient.invalidateQueries({ queryKey: ['assisted-instant', pharmacyId, 'open'] });
      void queryClient.invalidateQueries({ queryKey: ['pharmacy-wallet', pharmacyId] });
    }
  });

  if (q.isPending) return <Loading label="Reading the request…" />;
  if (q.isError || !v) return <ErrorState message={instantBookerRefusal(q.error).message} onRetry={() => void q.refetch()} />;
  const stage = instantStage(v, now);
  const paid = v.money ? formatRupees(v.money.paidMinor / 100) : 'The amount';
  const refundStep = (
    <ConfirmAction key="refund" label="Cancel and refund" danger confirmLabel="Yes, cancel and refund" disabled={busy} version={v.statusVersion}
      consequence={`The request is cancelled before any doctor accepts. ${paid} goes back to your wallet; give the patient their money back.`}
      onConfirm={() => command(() => instant.refund(v._id, v.statusVersion),
        // WQ22c L2: what the server says it refunded.
        (a) => `Cancelled. ${formatRupees(a.refundedMinor / 100)} is back in your wallet; give the patient their money back.`)} />
  );
  const sameTarget: InstantTarget = v.target.kind === 'specific' && v.target.doctorId ? { kind: 'specific', doctorId: v.target.doctorId } : { kind: 'any' };
  return (
    <section className="ws-section" aria-labelledby="wait-h">
      <h2 id="wait-h">{stage === 'accepted' ? 'A doctor accepted' : stage === 'refunded' ? 'Cancelled and refunded' : 'Waiting for a doctor'}</h2>
      {outcome && <Alert tone={outcome.tone}>{outcome.text}</Alert>}
      <ul className="ws-list">
        <li>Patient: <strong>{v.patientName ?? 'The patient'}</strong></li>
        <li>{v.specialization} · {INSTANT_MODE_LABEL[v.mode] ?? v.mode}{v.assisted?.shortRef ? <> · Ref <strong>{v.assisted.shortRef}</strong></> : null}</li>
        {v.money && <li>Paid from your wallet: <strong>{paid}</strong></li>}
      </ul>
      {stage === 'waiting' && (
        <>
          <p>Offered to {v.offeredCount ?? 'the'} {v.offeredCount === 1 ? 'doctor' : 'doctors'} online. <strong>{offerCountdown(v.offerExpiresAt ?? undefined, now)}</strong> left for a doctor to accept.</p>
          <p className="ws-muted">Keep this screen open: the money comes back to your wallet 30 minutes after you leave it, unless a doctor accepts.</p>
          <div className="ws-actions">{refundStep}</div>
        </>
      )}
      {stage === 'expired' && (
        <>
          <Alert tone="warn">No doctor accepted this time. Ask again, or cancel and get the money back.</Alert>
          <div className="ws-actions">
            <Button busy={busy} onClick={() => void command(() => instant.reoffer(v._id, sameTarget, v.statusVersion), () => 'Asked again. Waiting for a doctor.').catch(() => undefined)}>Ask again</Button>
            {v.target.kind === 'specific' && (
              <Button variant="secondary" disabled={busy} onClick={() => void command(() => instant.reoffer(v._id, { kind: 'any' }, v.statusVersion), () => 'Asked any available doctor. Waiting for a doctor.').catch(() => undefined)}>
                Ask any available doctor
              </Button>
            )}
            {refundStep}
          </div>
        </>
      )}
      {stage === 'accepted' && (
        <>
          <Alert tone="ok">{v.acceptedDoctorName ?? 'The doctor'} accepted. {v.money && v.money.returnedMinor > 0 ? `${formatRupees(v.money.returnedMinor / 100)} of the price came back to your wallet (this doctor’s fee is lower).` : ''}</Alert>
          {booking.data && <JoinCall b={booking.data} />}
          {v.bookingId && <p><Link to={`/pharmacy/consultations/${v.bookingId}`}>Open the booking</Link></p>}
        </>
      )}
      {stage === 'refunded' && <p>{v.money ? `${formatRupees(v.money.refundedMinor / 100)} is back in your wallet.` : 'The money is back in your wallet.'} Give the patient their money back.</p>}
      {(stage === 'accepted' || stage === 'refunded') && <div><Button variant="secondary" onClick={onAnother}>Start another</Button></div>}
    </section>
  );
}

