import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  addDays, addressErrors, COLLECTOR_PHONE_PATTERN, CONSENT_STATEMENT_LANGUAGE, deskItems, deskRefusal, deskTotalMinor, isBookable, isSwitchedOff, istDateOf,
  LAB_DESK_CONSENT_STATEMENT, LAB_DESK_CONSENT_VERSION, LAB_DESK_SWITCHED_OFF_MESSAGE, labDeskApi, MAX_COLLECTOR_NAME, patientBody,
  type DeskBookingRequest, type DeskByKey, type DeskReceipt, type LabAddress, type LabBooking, type VisitMode,
} from '@jansetu/api';
import { formatPaise } from '@jansetu/i18n';
import { Alert, Button, ErrorState, Loading, Parts, shared, TextField } from '@jansetu/ui';
import { newRequestKey } from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { useOneAtATime } from '../finance/finance.tsx';
import { AddressFields, EMPTY_ADDRESS, labAddressLine, labAddressOf, LanguageSelect } from '../pharmacy/bookingFields.tsx';
import { useAssistedCreate } from '../pharmacy/assistedCreate.ts';
import { PatientSection, usePatientStep } from '../pharmacy/patientStep.tsx';
import { RecommendedTests, useRecommendedTicks } from '../pharmacy/recommendedTests.tsx';
import { SlotDays } from '../pharmacy/slotDays.tsx';
import { UnconfirmedBooking } from '../pharmacy/unconfirmedBooking.tsx';
import { BillLink, money, useCatalogue } from './billing.tsx';
import { formatDay, LabOnly, modesOf, useScopedBranches } from './labs.tsx';
import { NoSuchPartner, PartnerPageHeading, scopeIdentity, usePartnerScope, useWorkspacePartner, type ScopeContext } from './scope.tsx';
import { t, type PartnerKey } from '../../i18n/partner/index.ts';

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
      <PartnerPageHeading ctx={ctx} title={t('labDesk.title')} partnerName={partner.data?.name}>
        {t('labDesk.intro')}
      </PartnerPageHeading>
      <LabOnly ctx={ctx}><Desk ctx={ctx} /></LabOnly>
    </>
  );
}

type Mode = 'walkin' | 'lab' | 'home';
const MODE_KEY = { walkin: 'labDesk.mode.walkin', lab: 'labDesk.mode.lab', home: 'labDesk.mode.home' } as const satisfies Record<Mode, PartnerKey>;
const visitOf = (m: Mode): VisitMode => (m === 'home' ? 'home' : 'lab');
const SLOT_DAYS = 7;

interface Summary { patient: string; branch: string; mode: Mode; when: string; tests: string[]; address?: string; collector?: string; totalMinor: number }
interface PendingDesk { request: DeskBookingRequest; summary: Summary; bill: { name: string; phone: string } }
interface Done { booking: LabBooking | null; summary?: Summary; bill?: { name: string; phone: string }; replayed: boolean; newAccount?: boolean }

function SummaryList({ s }: { s: Summary }) {
  // A walk-in is booked for now (older records in this session hold the word itself).
  const parts = { mode: t(MODE_KEY[s.mode]), when: <strong>{s.when || t('labDesk.now')}</strong>, branch: s.branch };
  const visit = !s.address ? t.rich<'labDesk.summary.visit', ReactNode>('labDesk.summary.visit', parts)
    : s.collector ? t.rich<'labDesk.summary.visitAtCollector', ReactNode>('labDesk.summary.visitAtCollector', { ...parts, address: s.address, collector: s.collector })
    : t.rich<'labDesk.summary.visitAt', ReactNode>('labDesk.summary.visitAt', { ...parts, address: s.address });
  return (
    <ul className="ws-list">
      <li><Parts of={t.rich('labDesk.summary.patient', { patient: <strong>{s.patient}</strong> })} /></li>
      <li><Parts of={visit} /></li>
      <li><Parts of={t.rich('labDesk.summary.tests', { tests: <strong>{s.tests.join(', ')}</strong> })} /></li>
      <li><Parts of={t.rich('labDesk.summary.total', { total: <strong>{money(s.totalMinor)}</strong> })} /></li>
    </ul>
  );
}

function Desk({ ctx }: { ctx: ScopeContext }) {
  const { api, memory } = useSession();
  const queryClient = useQueryClient();
  const desk = labDeskApi(api, ctx.scope);
  const identity = scopeIdentity(ctx);
  const { perform, busy } = useOneAtATime('booking');
  const [off, setOff] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  // The keyed create, shared with the pharmacy's assisted bookings (send, refusals, give up); nothing is charged here.
  const create = useAssistedCreate<PendingDesk, DeskReceipt, DeskByKey>({
    slot: `lab-desk-book:${identity}`, perform, book: (request) => desk.book(request), abandon: (key) => desk.abandon(key), refusal: deskRefusal,
    charged: false, refreshKeys: [[...ctx.key, 'lab-bookings'], [...ctx.key, 'slots']],
    onReceipt: (v, p) => setDone({ booking: v.booking, summary: p.body.summary, bill: p.body.bill, replayed: v.replayed, newAccount: v.newAccount }),
    onUsed: (r, p) => { settle(p.requestKey); setReview(null); setDone({ booking: r.booking, summary: p.body?.summary, bill: p.body?.bill, replayed: true }); create.refresh(); return null; },
    onOff: () => setOff(true),
    onNotice: setNotice,
    onRefused: (why) => {
      setReview(null);
      if (why.kind === 'slot') { setSlotId(null); void slots.refetch(); }
      else if (why.kind === 'doctor') setBranchId(null);
      // The lab's prices moved: the tests are read again and the new total is shown; booking again is a new request.
      else if (why.kind === 'price' || why.kind === 'other') void catalogue.refetch();
    },
  });
  const { op, settle, review, setReview, refused, setRefused, resendError, setResendError, givingUp } = create;

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
  // WQ21b: tests recommended by the doctor (the pharmacy's step, `recommendedTests.tsx`), ticked once per visit and code.
  const recItems = useMemo(() => (catalogue.data ? items.map((i) => ({ itemId: i._id, name: i.name })) : null), [catalogue.data, items]);
  const recTicks = useRecommendedTicks(recItems, recItems ? visit : null, setItemIds);
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
    setLanguage(''); setErrors({}); setReview(null); setRefused(null); setDone(null); setNotice(null); recTicks.reset();
  }

  function book(e: FormEvent) {
    e.preventDefault();
    setRefused(null);
    const errs: Record<string, string> = {};
    if (!branch) errs.branch = t('labDesk.error.branch');
    if (chosen.length === 0) errs.items = t('labDesk.error.noTests');
    else if (chosen.length > 20) errs.items = t('labDesk.error.tooManyTests');
    if (mode !== 'walkin' && !slot) errs.slot = t('labDesk.error.time');
    if (mode === 'home') for (const [k, v] of Object.entries(addressErrors(address))) errs[`address.${k}`] = v;
    const cName = collectorName.trim().replace(/\s+/g, ' ');
    const cPhone = collectorPhone.trim();
    if (mode === 'home' && cPhone && !COLLECTOR_PHONE_PATTERN.test(cPhone)) errs.collectorPhone = t('labDesk.error.collectorPhone');
    if (mode === 'home' && cPhone && !cName) errs.collectorName = t('labDesk.error.collectorName');
    if (!language) errs.language = t('labDesk.error.language');
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
        patient: patientLabel(), branch: branch.name, mode, when: slot ? `${formatDay(slot.date)}, ${slot.startTime}` : '',
        tests: items.filter((i) => chosen.includes(i._id)).map((i) => i.name), totalMinor,
        ...(home ? { address: labAddressLine(home) } : {}), ...(collector ? { collector: collector.name } : {}),
      },
    });
  }

  // An unconfirmed booking stays on screen while it is resent or given up (its first attempt shows the review busy).
  if (op && !(busy && !givingUp && op.attempts === 1 && !op.uncertain)) {
    return (
      <UnconfirmedBooking op={op}
        // i18n-ignore: the shared pharmacy component words `what` (its own round, 6f)
        what="booking" charged={false} busy={busy} givingUp={givingUp} resendError={resendError} byKey={() => desk.byKey(op.requestKey)}
        onUsed={(r) => { settle(op.requestKey); setReview(null); setDone({ booking: r.booking, summary: op.body?.summary, bill: op.body?.bill, replayed: true }); create.refresh(); return null; }}
        onAbandoned={() => create.abandonedByCheck(op.requestKey)}
        onResend={() => { setResendError(null); void create.send(op).catch((err: unknown) => setResendError(deskRefusal(err).message)); }}
        onGiveUp={() => void create.giveUp(op)}
        summary={op.body && <SummaryList s={op.body.summary} />} />
    );
  }

  if (off) return <Alert tone="warn">{LAB_DESK_SWITCHED_OFF_MESSAGE} {t('labDesk.offMore')}</Alert>;

  if (done) {
    const b = done.booking;
    return (
      <section className="ws-section" aria-labelledby="done-h">
        <h2 id="done-h">{done.replayed ? t('labDesk.done.alreadyTitle') : t('labDesk.done.title')}</h2>
        <Alert tone="ok">
          {done.replayed ? t('labDesk.done.already') : t('labDesk.done.booked')}
        </Alert>
        {done.summary && <SummaryList s={done.summary} />}
        {done.newAccount && <p className="ws-muted">{t('labDesk.done.newAccount')}</p>}
        {!b && <p className="ws-muted">{t('labDesk.done.notYourBranch')}</p>}
        <div className="ws-actions">
          {b && <Link to={`${ctx.link('lab-bookings')}/${b._id}`}>{t('labDesk.done.open')}</Link>}
          {b && (
            <BillLink ctx={ctx} memory={memory} label={t('labDesk.makeBill')} prefill={{
              link: { kind: 'lab_booking', id: b._id }, branchId: b.branchId, doctorId: '', name: done.bill?.name ?? '', phone: done.bill?.phone ?? '',
              label: b.patient?.name === undefined
                ? t('labDesk.billForUnnamed', { day: formatDay(b.slot.date), time: b.slot.startTime })
                : t('labDesk.billFor', { name: b.patient.name, day: formatDay(b.slot.date), time: b.slot.startTime }),
            }} />
          )}
          <Button onClick={resetAll}>{t('labDesk.another')}</Button>
        </div>
      </section>
    );
  }

  const frozen = !!review || busy;
  return (
    <>
      {notice && <Alert tone="ok">{notice}</Alert>}
      <PatientSection step={pt} busy={busy} frozen={patientDone || frozen} locked={frozen} nextLabel={t('labDesk.next')}
        // i18n-ignore: a code, not words
        booker="lab"
        consent={LAB_DESK_CONSENT_STATEMENT} />

      {patientDone && (
        <section className="ws-section" aria-labelledby="desk-h">
          <h2 id="desk-h">{t('labDesk.step2')}</h2>
          {lookup && <RecommendedTests load={desk.recommendation} phone={lookup.phone} perform={perform} disabled={frozen} ticks={recTicks} />}
          <form className="rx-form" noValidate onSubmit={book} aria-label={t('labDesk.testsAndTime')}>
            <fieldset className="ws-frozen" disabled={frozen}>
              <fieldset className="ws-checks">
                <legend>{t('labDesk.visit')}</legend>
                {(['walkin', 'lab', 'home'] as const).map((m) => (
                  <label key={m} className="ws-check">
                    <input type="radio" name="desk-visit" checked={mode === m} onChange={() => chooseMode(m)} /> {t(MODE_KEY[m])}
                  </label>
                ))}
              </fieldset>

              {branches.isPending ? <Loading label={t('common.loadingBranches')} />
                : branches.isError ? <ErrorState message={deskRefusal(branches.error).message} onRetry={() => void branches.refetch()} />
                : offering.length === 0 ? <Alert tone="warn">{t('labDesk.noBranch')}</Alert>
                : offering.length > 1 && (
                  <div className="j-field">
                    <label htmlFor="desk-branch">{t('labDesk.branch')}</label>
                    <select id="desk-branch" value={branchId ?? ''} aria-invalid={errors.branch ? true : undefined}
                      aria-describedby={errors.branch ? 'desk-branch-err' : undefined} onChange={(e) => { setBranchId(e.target.value || null); setSlotId(null); }}>
                      <option value="">{t('labDesk.choose')}</option>
                      {offering.map((b) => <option key={b._id} value={b._id}>{b.name}</option>)}
                    </select>
                    {errors.branch && <span id="desk-branch-err" className="j-field__error" role="alert">{errors.branch}</span>}
                  </div>
                )}

              <fieldset className="ws-checks">
                <legend>{t('labDesk.tests')}</legend>
                {catalogue.isPending ? <Loading label={t('labDesk.loadingTests')} />
                  : catalogue.isError ? <ErrorState message={deskRefusal(catalogue.error).message} onRetry={() => void catalogue.refetch()} />
                  : items.length === 0 ? <span>{t('labDesk.noTests')}</span>
                  : items.map((i) => (
                    <label key={i._id} className="ws-check">
                      <input type="checkbox" checked={chosen.includes(i._id)} onChange={() => toggleItem(i._id)} />
                      {i.kind === 'package' ? t('labDesk.package', { name: i.name }) : i.name} · {money(i.priceMinor)}
                      {i.preparation ? <span className="ws-muted"> · {i.preparation}</span> : null}
                    </label>
                  ))}
                {errors.items && <span className="j-field__error" role="alert">{errors.items}</span>}
              </fieldset>

              {mode !== 'walkin' && branch && (
                <>
                  <TextField label={t('labDesk.fromDay')} type="date" value={date} min={istDateOf(now)} hint={t('labDesk.fromDayHint', { count: SLOT_DAYS })}
                    onChange={(e) => { if (e.target.value) { setDate(e.target.value); setSlotId(null); } }} />
                  <div className="ws-day">
                    {slots.isPending ? <Loading label={t('labDesk.findingTimes')} />
                      : slots.isError ? <ErrorState message={deskRefusal(slots.error).message} onRetry={() => void slots.refetch()} />
                      : slotDays.length === 0 ? <span>{t('labDesk.noTimes')}</span>
                      : <SlotDays days={slotDays} chosen={slotId} onChoose={(s) => setSlotId(s.slotId)} />}
                  </div>
                  {errors.slot && <span className="j-field__error" role="alert">{errors.slot}</span>}
                </>
              )}

              {mode === 'home' && (
                <>
                  <AddressFields value={address} errors={errors} onChange={setAddress} />
                  <div className="rx-form-row">
                    <TextField label={t('labDesk.collectorName')} autoComplete="off" value={collectorName} maxLength={MAX_COLLECTOR_NAME} error={errors.collectorName}
                      onChange={(e) => setCollectorName(e.target.value)} />
                    <TextField label={t('labDesk.collectorPhone')} inputMode="tel" autoComplete="off" value={collectorPhone} error={errors.collectorPhone}
                      onChange={(e) => setCollectorPhone(e.target.value)} />
                  </div>
                </>
              )}

              <LanguageSelect id="desk-lang" value={language} error={errors.language} onChange={setLanguage} />
            </fieldset>
            {refused && !review && <Alert>{refused.message}</Alert>}
            {!review && (
              <div className="ws-actions">
                <span><Parts of={t.rich('labDesk.summary.total', { total: <strong>{formatPaise(totalMinor)}</strong> })} /></span>
                <Button type="submit">{t('labDesk.book')}</Button>
              </div>
            )}
          </form>
        </section>
      )}

      {review && (
        <section className="ws-section" aria-labelledby="desk-ok-h">
          <h2 id="desk-ok-h">{t('labDesk.step3')}</h2>
          <div className="confirm" role="group" aria-label={t('labDesk.check')}>
            <SummaryList s={review.summary} />
            {refused && <Alert>{refused.message}</Alert>}
            <div className="confirm-actions">
              <Button busy={busy} onClick={() => void create.pay()}>{t('labDesk.confirm', { total: money(review.summary.totalMinor) })}</Button>
              <Button variant="ghost" disabled={busy} onClick={() => { setReview(null); setRefused(null); }}>{shared('action.back')}</Button>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
