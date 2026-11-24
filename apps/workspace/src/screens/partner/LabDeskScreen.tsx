import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  addDays, addressErrors, COLLECTOR_PHONE_PATTERN, CONSENT_STATEMENT_LANGUAGE, deskItems, deskRefusal, deskTotalMinor, isBookable, isSwitchedOff, istDateOf,
  LAB_DESK_CONSENT_STATEMENT, LAB_DESK_CONSENT_VERSION, LAB_DESK_SWITCHED_OFF_MESSAGE, labDeskApi, MAX_COLLECTOR_NAME, patientBody, refusedBeforeWriting,
  type DeskBookingRequest, type LabAddress, type LabBooking, type Refusal, type VisitMode,
} from '@jansetu/api';
import { Alert, Button, ErrorState, formatRupees, Loading, TextField } from '@jansetu/ui';
import { newRequestKey, startOp, wasAbandoned, type PendingOp } from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { useOneAtATime } from '../finance/finance.tsx';
import { AddressFields, EMPTY_ADDRESS, labAddressLine, labAddressOf, LanguageSelect } from '../pharmacy/bookingFields.tsx';
import { useOwnedOp } from '../pharmacy/ownedOp.tsx';
import { PatientSection, usePatientStep } from '../pharmacy/patientStep.tsx';
import { SlotDays } from '../pharmacy/slotDays.tsx';
import { UnconfirmedBooking } from '../pharmacy/unconfirmedBooking.tsx';
import { BillLink, money, useCatalogue } from './billing.tsx';
import { formatDay, LabOnly, modesOf, useScopedBranches } from './labs.tsx';
import { NoSuchPartner, PartnerPageHeading, scopeIdentity, usePartnerScope, useWorkspacePartner, type ScopeContext } from './scope.tsx';

/**
 * WQ19: the lab front desk (assisted booking round 2c, backend r12, design §24.12). A lab member with `bookings.manage`
 * books this lab's own tests for a patient at the counter, paid at the lab: the shared patient step (lookup on
 * `POST /lab-desk/patients/lookup`), then walk-in now, a lab visit at a time or a home collection (address, time, an
 * optional collector), the tests from `GET /catalogue`, a time from `GET /slots`, and one keyed create
 * (`POST /lab-desk/bookings`, the total fenced). The phone and the address stay in this page's state and in POST bodies:
 * never in the address bar, storage or logs. The booking then lives in Lab bookings (steps, reports, Make bill, cancel).
 */
export function LabDeskScreen() {
  const ctx = usePartnerScope();
  if (!ctx) return <NoSuchPartner />;
  // One subtree per partner: a half-made booking never carries over to another lab.
  return <LabDesk key={scopeIdentity(ctx)} ctx={ctx} />;
}

function LabDesk({ ctx }: { ctx: ScopeContext }) {
  const partner = useWorkspacePartner(ctx);
  return (
    <>
      <PartnerPageHeading ctx={ctx} title="Front desk" partnerName={partner.data?.name}>
        Book tests for a patient at your lab. The patient pays at the lab; make the bill from the booking.
      </PartnerPageHeading>
      <LabOnly ctx={ctx}><Desk ctx={ctx} /></LabOnly>
    </>
  );
}

type Mode = 'walkin' | 'lab' | 'home';
const MODE_LABEL: Record<Mode, string> = { walkin: 'Walk-in now', lab: 'Lab visit at a time', home: 'Home collection' };
const visitOf = (m: Mode): VisitMode => (m === 'home' ? 'home' : 'lab');
const SLOT_DAYS = 7;

interface Summary { patient: string; branch: string; mode: Mode; when: string; tests: string[]; address?: string; collector?: string; totalMinor: number }
interface PendingDesk { request: DeskBookingRequest; summary: Summary; bill: { name: string; phone: string } }
interface Done { booking: LabBooking | null; summary?: Summary; bill?: { name: string; phone: string }; replayed: boolean; newAccount?: boolean }

function SummaryList({ s }: { s: Summary }) {
  return (
    <ul className="ws-list">
      <li>Patient: <strong>{s.patient}</strong></li>
      <li>{MODE_LABEL[s.mode]}: <strong>{s.when}</strong>, {s.branch}{s.address ? ` · at ${s.address}` : ''}{s.collector ? ` · collector ${s.collector}` : ''}</li>
      <li>Tests: <strong>{s.tests.join(', ')}</strong></li>
      <li>Total: <strong>{money(s.totalMinor)}</strong>, paid at the lab</li>
    </ul>
  );
}

function Desk({ ctx }: { ctx: ScopeContext }) {
  const { api, memory } = useSession();
  const queryClient = useQueryClient();
  const desk = labDeskApi(api, ctx.scope);
  const identity = scopeIdentity(ctx);
  const { op, send, settle } = useOwnedOp<PendingDesk>(`lab-desk-book:${identity}`);
  const { perform, busy } = useOneAtATime('booking');
  const [off, setOff] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);
  const [givingUp, setGivingUp] = useState(false);
  const [review, setReview] = useState<({ requestKey: string } & PendingDesk) | null>(null);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  // Step 1: the patient (the shared step, with the desk's own lookup and consent words).
  const pt = usePatientStep({ pharmacyId: identity, perform, lookupPatient: (phone) => desk.lookup(phone),
    onFind: () => setNotice(null), onSwitchedOff: () => setOff(true), onChangePhone: () => { setReview(null); setRefused(null); } });
  const { lookup, patient, patientDone, patientLabel } = pt;

  // Step 2: the visit, branch, tests and time.
  const branches = useScopedBranches(ctx);
  const [mode, setMode] = useState<Mode>('walkin');
  const visit = visitOf(mode);
  const offering = useMemo(() => branches.inScope.filter((b) => modesOf(b).includes(visit)), [branches.inScope, visit]);
  const [branchId, setBranchId] = useState<string | null>(null);
  const branch = offering.find((b) => b._id === branchId) ?? null;
  useEffect(() => { if (offering.length === 1 && !branchId) setBranchId(offering[0]!._id); }, [offering, branchId]);
  const catalogue = useCatalogue(ctx, { enabled: patientDone && !off });
  const items = useMemo(() => deskItems(catalogue.data ?? [], visit), [catalogue.data, visit]);
  const [itemIds, setItemIds] = useState<string[]>([]);
  const chosen = itemIds.filter((id) => items.some((i) => i._id === id));
  const totalMinor = deskTotalMinor(items, chosen);
  const now = new Date();
  const [date, setDate] = useState(() => istDateOf(new Date()));
  const [slotId, setSlotId] = useState<string | null>(null);
  const slots = useQuery({
    queryKey: [...ctx.key, 'slots', branchId, visit, 'desk', date],
    queryFn: () => ctx.labs.slots({ branchId: branchId!, visitMode: visit, from: date, to: addDays(date, SLOT_DAYS - 1) }),
    enabled: patientDone && !off && !!branchId && mode !== 'walkin',
  });
  // Open seats starting after now (the desk may take any; no 60-minute lead), grouped by day for the shared picker.
  const slotDays = useMemo(() => {
    const days = new Map<string, { slotId: string; startTime: string; endTime: string; date: string }[]>();
    for (const s of slots.data ?? []) {
      if (isBookable(s, new Date())) days.set(s.date, [...(days.get(s.date) ?? []), { slotId: s._id, startTime: s.startTime, endTime: s.endTime, date: s.date }]);
    }
    return [...days];
  }, [slots.data]);
  const slot = slotDays.flatMap(([, x]) => x).find((s) => s.slotId === slotId) ?? null;
  const [address, setAddress] = useState(EMPTY_ADDRESS);
  const [collectorName, setCollectorName] = useState('');
  const [collectorPhone, setCollectorPhone] = useState('');
  const [language, setLanguage] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => { if (isSwitchedOff(catalogue.error)) setOff(true); }, [catalogue.error]);

  function chooseMode(m: Mode) { setMode(m); setBranchId(null); setSlotId(null); setErrors({}); setRefused(null); }
  function toggleItem(id: string) { setItemIds((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id])); setRefused(null); }
  function resetAll() {
    pt.reset(); setMode('walkin'); setBranchId(null); setItemIds([]); setSlotId(null); setAddress(EMPTY_ADDRESS); setCollectorName(''); setCollectorPhone('');
    setLanguage(''); setErrors({}); setReview(null); setRefused(null); setDone(null); setNotice(null);
  }

  function book(e: FormEvent) {
    e.preventDefault();
    setRefused(null);
    const errs: Record<string, string> = {};
    if (!branch) errs.branch = 'Choose a branch.';
    if (chosen.length === 0) errs.items = 'Choose at least one test.';
    else if (chosen.length > 20) errs.items = 'Choose at most 20 tests.';
    if (mode !== 'walkin' && !slot) errs.slot = 'Choose a time.';
    if (mode === 'home') for (const [k, v] of Object.entries(addressErrors(address))) errs[`address.${k}`] = v;
    const cName = collectorName.trim().replace(/\s+/g, ' ');
    const cPhone = collectorPhone.trim();
    if (mode === 'home' && cPhone && !COLLECTOR_PHONE_PATTERN.test(cPhone)) errs.collectorPhone = 'Enter a 10-digit mobile number.';
    if (mode === 'home' && cPhone && !cName) errs.collectorName = 'Enter the collector’s name.';
    if (!language) errs.language = 'Choose the language the patient speaks.';
    setErrors(errs);
    if (Object.keys(errs).length || !branch || !lookup) return;
    const home: LabAddress | undefined = mode === 'home' ? labAddressOf(address) : undefined;
    const collector = mode === 'home' && cName ? { name: cName, ...(cPhone ? { phone: cPhone } : {}) } : undefined;
    const requestKey = newRequestKey();
    const typed = patientBody({ ...patient, phone: lookup.phone });
    const request: DeskBookingRequest = {
      requestKey, phone: lookup.phone, ...typed,
      consent: { agreed: true, statementVersion: LAB_DESK_CONSENT_VERSION, statementLanguage: CONSENT_STATEMENT_LANGUAGE },
      preferredLanguage: language, branchId: branch._id, visitMode: visit, ...(slot ? { slotId: slot.slotId } : {}), itemIds: [...chosen],
      ...(home ? { address: home } : {}), ...(collector ? { collector } : {}), acceptedTotalMinor: totalMinor,
      // No `notes`: the desk offers no note.
    };
    // The bill's customer is the account holder: the phone owner (named when typed).
    const holder = patient.who === 'self' ? patient.name.trim().replace(/\s+/g, ' ') : patient.holderName.trim().replace(/\s+/g, ' ');
    setReview({
      requestKey, request, bill: { name: holder, phone: lookup.phone },
      summary: {
        patient: patientLabel(), branch: branch.name, mode, when: slot ? `${formatDay(slot.date)}, ${slot.startTime}` : 'now',
        tests: items.filter((i) => chosen.includes(i._id)).map((i) => i.name), totalMinor,
        ...(home ? { address: labAddressLine(home) } : {}), ...(collector ? { collector: collector.name } : {}),
      },
    });
  }

  const refreshAfterBooking = () => {
    void queryClient.invalidateQueries({ queryKey: [...ctx.key, 'lab-bookings'] });
    void queryClient.invalidateQueries({ queryKey: [...ctx.key, 'slots'] });
  };
  const rotateKey = () => {
    const requestKey = newRequestKey();
    setReview((v) => (v ? { ...v, requestKey, request: { ...v.request, requestKey } } : v));
  };

  /** Sends `p` (its key, its request) under the one-at-a-time guard; an unknown outcome stays stored for the panel. */
  async function sendBooking(p: PendingOp<PendingDesk>) {
    const sole = p.attempts === 0 && !p.uncertain;
    const r = await perform(() => send(p, (b) => desk.book(b.request)));
    if (r.kind === 'stale') return;
    if (r.kind === 'ok') {
      setReview(null);
      setDone({ booking: r.value.booking, summary: p.body.summary, bill: p.body.bill, replayed: r.value.replayed, newAccount: r.value.newAccount });
      refreshAfterBooking();
      return;
    }
    if (r.kind === 'unknown' && wasAbandoned(r.error)) {
      settle(p.requestKey);
      setReview(null);
      setNotice('This booking was given up earlier, so nothing was booked with it. Book again if the patient still wants it.');
      return;
    }
    // The switch, the indexes, customer linking or the lookup limit refused the only attempt before any write: not booked.
    if (r.kind === 'unknown' && sole && refusedBeforeWriting(r.error)) settle(p.requestKey);
    if (r.kind === 'refused' || (r.kind === 'unknown' && sole && refusedBeforeWriting(r.error))) {
      const why = deskRefusal(r.error);
      if (why.kind === 'off') { setOff(true); setReview(null); return; }
      setRefused(why);
      setReview(null);
      if (why.kind === 'slot') { setSlotId(null); void slots.refetch(); }
      else if (why.kind === 'doctor') setBranchId(null);
      // The lab's prices moved: the tests are read again and the new total is shown; booking again is a new request.
      else if (why.kind === 'price' || why.kind === 'other') void catalogue.refetch();
      else if (why.kind === 'limit') rotateKey();
    }
  }

  async function confirm() {
    if (!review) return;
    const { requestKey, ...pending } = review;
    setRefused(null);
    try {
      await sendBooking(startOp(requestKey, pending));
    } catch (err) {
      setRefused(deskRefusal(err)); // the one-at-a-time guard refused: nothing was sent
    }
  }

  async function giveUp(p: PendingOp<PendingDesk>) {
    setResendError(null);
    setGivingUp(true);
    try {
      const r = await perform(() => desk.abandon(p.requestKey));
      if (r.state === 'used') { settle(p.requestKey); setReview(null); setDone({ booking: r.booking, summary: p.body?.summary, bill: p.body?.bill, replayed: true }); refreshAfterBooking(); return; }
      if (r.state !== 'abandoned') { setResendError('It could not be given up yet. Check whether it was recorded, then try again.'); return; }
      settle(p.requestKey);
      setReview(null);
      setNotice('Given up: nothing was booked with that request, and it can never be booked now. You can book again.');
    } catch (err) {
      setResendError(deskRefusal(err).message);
    } finally {
      setGivingUp(false);
    }
  }

  // An unconfirmed booking stays on screen while it is resent or given up (its first attempt shows the review busy).
  if (op && !(busy && !givingUp && op.attempts === 1 && !op.uncertain)) {
    return (
      <UnconfirmedBooking op={op} what="booking" charged={false} busy={busy} givingUp={givingUp} resendError={resendError} byKey={() => desk.byKey(op.requestKey)}
        onUsed={(r) => { settle(op.requestKey); setReview(null); setDone({ booking: r.booking, summary: op.body?.summary, bill: op.body?.bill, replayed: true }); refreshAfterBooking(); return null; }}
        onAbandoned={() => { settle(op.requestKey); setReview(null); setNotice('That booking was given up, so nothing was booked with it. You can book again.'); }}
        onResend={() => { setResendError(null); void sendBooking(op).catch((err: unknown) => setResendError(deskRefusal(err).message)); }}
        onGiveUp={() => void giveUp(op)}
        summary={op.body && <SummaryList s={op.body.summary} />} />
    );
  }

  if (off) return <Alert tone="warn">{LAB_DESK_SWITCHED_OFF_MESSAGE} Jansetu turns it on for your lab when it is ready. Lab bookings, reports and bills work as usual.</Alert>;

  if (done) {
    const b = done.booking;
    return (
      <section className="ws-section" aria-labelledby="done-h">
        <h2 id="done-h">{done.replayed ? 'Already booked' : 'Booked'}</h2>
        <Alert tone="ok">
          {done.replayed ? 'This booking was already made. Nothing was booked twice.' : 'The tests are booked. The patient pays at the lab.'}
        </Alert>
        {done.summary && <SummaryList s={done.summary} />}
        {done.newAccount && <p className="ws-muted">This number was new to Jansetu. An account was made for it; the report reaches the patient’s Jansetu app.</p>}
        {!b && <p className="ws-muted">This booking is at a branch you do not work at, so it is not shown here.</p>}
        <div className="ws-actions">
          {b && <Link to={`${ctx.link('lab-bookings')}/${b._id}`}>Open the booking</Link>}
          {b && (
            <BillLink ctx={ctx} memory={memory} label="Make bill" prefill={{
              link: { kind: 'lab_booking', id: b._id }, branchId: b.branchId, doctorId: '', name: done.bill?.name ?? '', phone: done.bill?.phone ?? '',
              label: `${b.patient?.name ?? 'the patient'}, ${formatDay(b.slot.date)} ${b.slot.startTime}`,
            }} />
          )}
          <Button onClick={resetAll}>Book for another patient</Button>
        </div>
      </section>
    );
  }

  const frozen = !!review || busy;
  return (
    <>
      {notice && <Alert tone="ok">{notice}</Alert>}
      <PatientSection step={pt} busy={busy} frozen={patientDone || frozen} locked={frozen} nextLabel="Next: choose the tests" booker="lab"
        consent={LAB_DESK_CONSENT_STATEMENT} />

      {patientDone && (
        <section className="ws-section" aria-labelledby="desk-h">
          <h2 id="desk-h">2. Tests and time</h2>
          <form className="rx-form" noValidate onSubmit={book} aria-label="Tests and time">
            <fieldset className="ws-frozen" disabled={frozen}>
              <fieldset className="ws-checks">
                <legend>Visit</legend>
                {(['walkin', 'lab', 'home'] as const).map((m) => (
                  <label key={m} className="ws-check">
                    <input type="radio" name="desk-visit" checked={mode === m} onChange={() => chooseMode(m)} /> {MODE_LABEL[m]}
                  </label>
                ))}
              </fieldset>

              {branches.isPending ? <Loading label="Loading branches…" />
                : branches.isError ? <ErrorState message={deskRefusal(branches.error).message} onRetry={() => void branches.refetch()} />
                : offering.length === 0 ? <Alert tone="warn">None of your branches offers this visit. Choose another visit.</Alert>
                : offering.length > 1 && (
                  <div className="j-field">
                    <label htmlFor="desk-branch">Branch</label>
                    <select id="desk-branch" value={branchId ?? ''} aria-invalid={errors.branch ? true : undefined}
                      aria-describedby={errors.branch ? 'desk-branch-err' : undefined} onChange={(e) => { setBranchId(e.target.value || null); setSlotId(null); }}>
                      <option value="">Choose…</option>
                      {offering.map((b) => <option key={b._id} value={b._id}>{b.name}</option>)}
                    </select>
                    {errors.branch && <span id="desk-branch-err" className="j-field__error" role="alert">{errors.branch}</span>}
                  </div>
                )}

              <fieldset className="ws-checks">
                <legend>Tests</legend>
                {catalogue.isPending ? <Loading label="Loading tests…" />
                  : catalogue.isError ? <ErrorState message={deskRefusal(catalogue.error).message} onRetry={() => void catalogue.refetch()} />
                  : items.length === 0 ? <span>No tests of this lab are offered for this visit.</span>
                  : items.map((i) => (
                    <label key={i._id} className="ws-check">
                      <input type="checkbox" checked={chosen.includes(i._id)} onChange={() => toggleItem(i._id)} />
                      {i.name}{i.kind === 'package' ? ' (package)' : ''} · {money(i.priceMinor)}
                      {i.preparation ? <span className="ws-muted"> · {i.preparation}</span> : null}
                    </label>
                  ))}
                {errors.items && <span className="j-field__error" role="alert">{errors.items}</span>}
              </fieldset>

              {mode !== 'walkin' && branch && (
                <>
                  <TextField label="From day" type="date" value={date} min={istDateOf(now)} hint={`Free times for ${SLOT_DAYS} days from this day.`}
                    onChange={(e) => { if (e.target.value) { setDate(e.target.value); setSlotId(null); } }} />
                  <div className="ws-day">
                    {slots.isPending ? <Loading label="Finding free times…" />
                      : slots.isError ? <ErrorState message={deskRefusal(slots.error).message} onRetry={() => void slots.refetch()} />
                      : slotDays.length === 0 ? <span>No free times in these days. Choose a later day.</span>
                      : <SlotDays days={slotDays} chosen={slotId} onChoose={(s) => setSlotId(s.slotId)} />}
                  </div>
                  {errors.slot && <span className="j-field__error" role="alert">{errors.slot}</span>}
                </>
              )}

              {mode === 'home' && (
                <>
                  <AddressFields value={address} errors={errors} onChange={setAddress} />
                  <div className="rx-form-row">
                    <TextField label="Collector’s name (optional)" autoComplete="off" value={collectorName} maxLength={MAX_COLLECTOR_NAME} error={errors.collectorName}
                      onChange={(e) => setCollectorName(e.target.value)} />
                    <TextField label="Collector’s mobile (optional)" inputMode="tel" autoComplete="off" value={collectorPhone} error={errors.collectorPhone}
                      onChange={(e) => setCollectorPhone(e.target.value)} />
                  </div>
                </>
              )}

              <LanguageSelect id="desk-lang" value={language} error={errors.language} onChange={setLanguage} />
            </fieldset>
            {refused && !review && <Alert>{refused.message}</Alert>}
            {!review && (
              <div className="ws-actions">
                <span>Total: <strong>{formatRupees(totalMinor / 100)}</strong>, paid at the lab</span>
                <Button type="submit">Book</Button>
              </div>
            )}
          </form>
        </section>
      )}

      {review && (
        <section className="ws-section" aria-labelledby="desk-ok-h">
          <h2 id="desk-ok-h">3. Check the total</h2>
          <div className="confirm" role="group" aria-label="Check the total">
            <SummaryList s={review.summary} />
            {refused && <Alert>{refused.message}</Alert>}
            <div className="confirm-actions">
              <Button busy={busy} onClick={() => void confirm()}>Yes, book for {money(review.summary.totalMinor)}</Button>
              <Button variant="ghost" disabled={busy} onClick={() => { setReview(null); setRefused(null); }}>Back</Button>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
