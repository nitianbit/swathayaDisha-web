import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router';
import {
  addDays, ApiError, appointmentAt, appointmentDay, canonicalMobile, CLINIC_APPOINTMENT_STATUS_LABEL, clinicBranchesFor, DESK_GENDERS, DESK_RELATIONS,
  deskActions, deskBookingProblems, doctorsAtBranch, familyMemberProblems, holdsAny, INVOICE_STATE_LABEL, isRealDate, istDateOf, MAX_APPOINTMENTS,
  MAX_DESK_CANCEL_REASON, MAX_DESK_NAME, MAX_DESK_NOTES, MAX_FAMILY_NAME, noShowMovedOnce,
  type Branch, type ClinicAppointment, type ClinicDoctorRow, type DeskAction, type DeskActionOffer, type DeskAppointment, type DeskBookingResult,
  type DeskGender, type DeskPatientInput, type DeskRelation, type DeskSlot, type DeskSlotKnown,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, formatRupees, Loading, Parts, shared, TextArea, TextField } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { NoShowMove, noShowMoveSlot, type NoShowMoveOp, type NoShowTarget } from '../../components/NoShowMove.tsx';
import { PendingOpPanel } from '../../components/PendingOpPanel.tsx';
import { messageOf } from '../../errors.ts';
import { afterFailure, beginAttempt, keyedLookup, newRequestKey, ownsKey, resolveStored, startOp, stillCurrent, wasAbandoned } from '../../requests.ts';
import { useSession, type SessionMemory } from '../../session.tsx';
import { BILL_READERS, BillLink, openBill, type BillPrefill } from './billing.tsx';
import { useVisitPreset, type VisitPatient } from '../front/visitPatient.ts';
import { VisitPatientLine } from '../front/visitBar.tsx';
import {
  appointmentLabel, appointmentTone, ClinicOnly, clinicLink, istTime, useClinicApi, useDoctorList, type ClinicApi,
} from './clinic.tsx';
import { deskBookingSlot, type DeskPending, type DeskPendingBody } from './desk.ts';
import { formatDay, useNow } from './labs.tsx';
import { NoSuchPartner, PartnerPageHeading, scopeIdentity, useBranches, usePartnerScope, useWorkspacePartner, type ScopeContext } from './scope.tsx';
import { t } from '../../i18n/partner/index.ts';

/** A slot or booking time as stored ("HH:mm" or "h:mm AM") shown as India time "HH:MM". */
const clock = (raw: string) => {
  const at = appointmentAt({ bookingDate: '20000101', bookingTime: raw });
  return at ? istTime(at) : raw;
};
/** Q13 409 BOOKING_CHANGED: the step named the version the person saw, and the appointment had changed since. */
const isChanged = (err: unknown) => err instanceof ApiError && err.status === 409 && err.code === 'BOOKING_CHANGED';
/**
 * Q16d (`closeDeskAppointment`): 409 NOT_STARTED_YET — a visit is marked as seen on the appointment's own day or later.
 * Q16d: 409 APPOINTMENT_NOT_STARTED — a no-show 15 minutes after the time; in a session with several patients, after its end.
 */
const readable = (err: unknown) => (err instanceof ApiError && err.status === 409 && err.code === 'NOT_STARTED_YET'
  ? new ApiError(409, t('desk.notStarted'), 'NOT_STARTED_YET')
  : err instanceof ApiError && err.status === 409 && err.code === 'APPOINTMENT_NOT_STARTED' ? new ApiError(409, t('desk.noShowTooEarly'), 'APPOINTMENT_NOT_STARTED') : err);
/** Q13: the slot is taken (SLOT_NOT_AVAILABLE) or has started meanwhile (SLOT_STARTED): choose another; the details stay. */
const slotGoneCodes = new Set(['SLOT_NOT_AVAILABLE', 'SLOT_STARTED']);

/** The clinic's front desk: a day of appointments per branch and doctor, booking walk-in and phone patients, and the desk steps. */
export function DeskScreen() {
  const ctx = usePartnerScope();
  if (!ctx) return <NoSuchPartner />;
  // One subtree per partner: an open booking form, confirmation or selected appointment never carries over to another
  // partner, and a late answer of one partner's request shows nothing on another's page.
  return <Desk key={scopeIdentity(ctx)} ctx={ctx} />;
}

function Desk({ ctx }: { ctx: ScopeContext }) {
  const partner = useWorkspacePartner(ctx);
  // WQ57 (P3): opened from + New, the visit's patient (handed over once); WQ57b: the page then starts with the task.
  const visit = useVisitPreset();
  return (
    <>
      {!visit && (
        <PartnerPageHeading ctx={ctx} title={t('desk.title')} partnerName={partner.data?.name}>
          {t('desk.intro')}
        </PartnerPageHeading>
      )}
      <ClinicOnly ctx={ctx}><DeskDay ctx={ctx} visit={visit} /></ClinicOnly>
    </>
  );
}

/**
 * Q14: who is seen — the account holder of the mobile, or a family member named here (name and relation; the server
 * reuses an active family member with the same name and relation). The desk never sees an account's family list.
 */
type Patient = { phone: string; name: string; notes: string; forFamily: boolean; familyName: string; relation: '' | DeskRelation; gender: '' | DeskGender; dateOfBirth: string };
const NO_PATIENT: Patient = { phone: '', name: '', notes: '', forFamily: false, familyName: '', relation: '', gender: '', dateOfBirth: '' };
interface Chosen { slot: DeskSlot; doctor: ClinicDoctorRow; branch: Branch }
type Perform = (a: ClinicAppointment, action: DeskAction, run: () => Promise<DeskAppointment>, done: (next: DeskAppointment) => string) => Promise<void>;
type Guard = <T>(a: ClinicAppointment, action: DeskAction, run: () => Promise<T>) => Promise<T>;

function DeskDay({ ctx, visit }: { ctx: ScopeContext; visit: VisitPatient | null }) {
  const { memory } = useSession();
  const queryClient = useQueryClient();
  const clinic = useClinicApi(ctx);
  const branches = useBranches(ctx);
  const doctors = useDoctorList(ctx, clinic);
  const now = useNow();
  const manage = holdsAny(ctx.actor, ['bookings.manage']);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  // ── What is shown: branch, day, doctor ──
  const offered = clinicBranchesFor(branches.data ?? [], ctx.actor);
  const [branchChoice, setBranchChoice] = useState('');
  const branch = offered.find((b) => b._id === branchChoice) ?? offered[0];
  const [day, setDay] = useState(() => istDateOf(new Date()));
  const [doctorChoice, setDoctorChoice] = useState('');
  const here = branch ? doctorsAtBranch(doctors.data ?? [], branch._id) : [];
  const doctor = here.find((d) => d.doctorId === doctorChoice);
  const dayOk = isRealDate(day);
  const listQuery = { from: day, to: day, branchId: branch?._id, doctorId: doctor?.doctorId };
  const list = useQuery({
    queryKey: [...ctx.key, 'clinic-appointments', listQuery], enabled: !!branch && dayOk,
    queryFn: () => clinic.appointments({ from: day, to: day, ...(branch ? { branchId: branch._id } : {}), ...(doctor ? { doctorId: doctor.doctorId } : {}) }),
  });
  const slots = useQuery({
    queryKey: [...ctx.key, 'clinic-slots', doctor?.doctorId, branch?._id, day], enabled: !!doctor && !!branch && dayOk,
    queryFn: () => clinic.deskSlots({ doctorId: doctor!.doctorId, branchId: branch!._id, date: day }),
  });
  const branchNames = useMemo(() => new Map((branches.data ?? []).map((b) => [b._id, b.name])), [branches.data]);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: [...ctx.key, 'clinic-appointments'] });
    void queryClient.invalidateQueries({ queryKey: [...ctx.key, 'clinic-slots'] });
    // WQ57b: a refusal (e.g. 409 DOCTOR_BUSY) reads the doctor's busy times again too.
    void queryClient.invalidateQueries({ queryKey: [...ctx.key, 'clinic-busy'] });
  };

  // ── Steps on appointments: one at a time per appointment, wherever it was started from ──
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;
  const inFlight = useRef(new Set<string>());
  const [busy, setBusy] = useState<Record<string, DeskAction>>({});
  const [stepNotice, setStepNotice] = useState<{ id: string; text: string } | null>(null);
  const [stepFailure, setStepFailure] = useState<{ id: string; text: string } | null>(null);

  /** The single gate for every step on an appointment, including confirmations that were already open when another started. */
  const guard: Guard = async (a, action, run) => {
    const id = a.bookingId;
    if (inFlight.current.has(id)) {
      throw new ApiError(409, t('desk.stepRunning'), 'STEP_IN_FLIGHT');
    }
    inFlight.current.add(id);
    setBusy((b) => ({ ...b, [id]: action }));
    if (selectedRef.current === id) { setStepNotice(null); setStepFailure(null); }
    try {
      return await run();
    } catch (err) {
      // Q13: refused because the appointment moved on since it was shown; the re-read below shows it as it is now.
      if (isChanged(err) && mounted.current && selectedRef.current === id) setStepFailure({ id, text: t('desk.changed') });
      throw err;
    } finally {
      inFlight.current.delete(id);
      if (mounted.current) setBusy(({ [id]: _done, ...rest }) => rest);
      // Success or not (it may have changed meanwhile), read the day again: the page settles on the server's state.
      refresh();
    }
  };
  const perform: Perform = async (a, action, run, done) => {
    const id = a.bookingId;
    const next = await guard(a, action, run);
    // The answer is never written into the cached day: it carries no version, so a late one (from a page the person
    // left and came back to) could put an older time or status over a newer change. Only the re-read shows state.
    // A late answer (the person left the page or opened another appointment) shows nothing, not even its notice.
    if (mounted.current && selectedRef.current === id) setStepNotice({ id, text: done(next) });
  };
  /** Q14: the one move of a desk no-show settled (only for the attempt that owns it): show its new day, the appointment open. */
  const moved = (id: string, next: DeskAppointment) => {
    if (!mounted.current) return;
    const d = appointmentDay(next.bookingDate);
    if (d) setDay(d);
    if (next.branchId) setBranchChoice(next.branchId);
    setSelected(id);
  };
  const click = (a: ClinicAppointment, action: DeskAction, what: string, run: () => Promise<DeskAppointment>, done: (n: DeskAppointment) => string) =>
    perform(a, action, run, done).catch((err: unknown) => {
      if (mounted.current && selectedRef.current === a.bookingId) setStepFailure({ id: a.bookingId, text: isChanged(err) ? t('desk.changed') : t('desk.stepFailed', { what, reason: messageOf(err) }) });
    });

  // ── Booking: once only, with the server's request key; an unknown outcome locks the form ──
  const slotKey = deskBookingSlot(scopeIdentity(ctx));
  const [pending, setPendingState] = useState<DeskPending | undefined>(() => memory.get<DeskPending>(slotKey));
  const [sending, setSending] = useState(false);
  const [chosen, setChosen] = useState<Chosen | null>(null);
  // WQ57 (P3): a visit's "now" or "later" (read once from the address; nothing about the patient is in it).
  const [params] = useSearchParams();
  const [when] = useState<'now' | 'later'>(() => (params.get('when') === 'later' ? 'later' : 'now'));
  const [patient, setPatient] = useState<Patient>(() => (visit ? patientOf(visit) : NO_PATIENT));
  const [refused, setRefused] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ReceiptView | null>(null);
  const [gaveUp, setGaveUp] = useState<string | null>(null);
  const setPending = (p: DeskPending | undefined) => {
    if (p) memory.set(slotKey, p); else memory.delete(slotKey);
    setPendingState(p);
  };
  /** Whether an answer started for `op` may still act: this page is on screen AND the stored booking is still exactly `op`. */
  const owns = (op: DeskPending) => mounted.current && stillCurrent(memory.get<DeskPending>(slotKey), op);
  /**
   * WQ11b: an answer about the key itself (a by-key lookup, a give-up's `used` or `abandoned`) settles what this page
   * shows when the stored booking is this key or is gone: after leaving mid-send and coming back, the first page's late
   * answer removes the stored booking while this page still shows it, and "Give up" must still act on the server's word.
   */
  const ownsTheKey = (op: DeskPending) => mounted.current && ownsKey(memory.get<DeskPending>(slotKey), op.requestKey);

  /**
   * `op` made this appointment (its answer, a replay, a by-key lookup or a give-up answered `used`): end it, and only it,
   * while this page owns it, then show the day with the appointment open. After a reload `op.body` is gone.
   */
  function settled(view: ReceiptView, op: DeskPending, byKey = false) {
    refresh();
    if (byKey ? !ownsTheKey(op) : !owns(op)) return;
    resolveStored(memory, slotKey, op.requestKey);
    const k = op.requestKey;
    setPendingState((cur) => (cur && cur.requestKey !== k ? cur : undefined));
    setChosen(null);
    setPatient(NO_PATIENT);
    setReceipt(view);
    const b = view.booking;
    const d = appointmentDay(b.bookingDate);
    if (d) setDay(d);
    const branchId = b.branchId ?? op.body?.shown.branchId;
    if (branchId) setBranchChoice(branchId);
    const doctorId = b.doctorId ?? op.body?.shown.doctorId;
    if (doctorId) setDoctorChoice(doctorId);
    setSelected(b.bookingId);
  }
  const viewOf = (b: DeskAppointment, op: DeskPending, extra: Pick<ReceiptView, 'replayed' | 'created' | 'family'>): ReceiptView => ({
    booking: b, ...extra,
    who: op.body ? familyOf(op.body) ?? (op.body.request.customer.name?.trim() || canonicalMobile(op.body.request.customer.phone) || op.body.request.customer.phone) : undefined,
    branchName: op.body?.shown.branchName ?? branchNames.get(b.branchId ?? '') ?? t('desk.theClinic'),
    doctorName: b.doctorName ?? op.body?.shown.doctorName,
  });
  const booked = (result: DeskBookingResult, op: DeskPending) =>
    settled(viewOf(result.booking, op, { replayed: result.replayed, created: result.customer.created,
      family: result.patient ? { name: result.patient.name, relationship: result.patient.relationship } : undefined }), op);

  /** Given up on the server, or known booked but outside this desk's branches: ends `op` only while this page owns it. */
  function closeWith(op: DeskPending, text: string) {
    refresh();
    if (!ownsTheKey(op)) return;
    const k = op.requestKey;
    resolveStored(memory, slotKey, k);
    setPendingState((cur) => (cur && cur.requestKey !== k ? cur : undefined));
    setGaveUp(text);
  }

  /** Sends exactly `p` (same key, same content). Only success, or a definite refusal of its FIRST attempt, ends it. */
  async function send(p: DeskPending) {
    const attempt = beginAttempt(p);
    setSending(true);
    setRefused(null);
    setGaveUp(null);
    setPending(attempt);
    try {
      booked(await clinic.book(attempt.body.request), attempt);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) refresh(); // e.g. the slot was taken: show the free slots now
      if (!stillCurrent(memory.get<DeskPending>(slotKey), attempt)) return;
      // Q13: the key was given up (e.g. in another tab after a reload): nothing was or can ever be booked with it.
      if (wasAbandoned(err)) {
        closeWith(attempt, t('desk.givenUpEarlier'));
        return;
      }
      // Customer linking is checked before anything is written; on a first attempt that refusal is definite too.
      const linkingOff = err instanceof ApiError && err.code === 'CUSTOMER_LINKING_UNAVAILABLE' && attempt.attempts === 1 && !attempt.uncertain;
      const next = linkingOff ? null : afterFailure(attempt, err, messageOf(err));
      if (mounted.current) {
        setPending(next ?? undefined);
        if (!next) {
          const slotGone = err instanceof ApiError && !!err.code && slotGoneCodes.has(err.code);
          setRefused(slotGone ? t('desk.slotGone', { reason: messageOf(err) }) : messageOf(err));
          if (slotGone) setChosen(null);
        }
      } else if (next) memory.set(slotKey, next); else memory.delete(slotKey);
    } finally {
      if (mounted.current) setSending(false);
    }
  }


  /** Books `chosen` for `request` (one key; the desk's own form and a visit from + New alike). */
  const bookChosen = (c: Chosen, request: Omit<DeskPendingBody['request'], 'requestKey'>) => {
    const requestKey = newRequestKey();
    const body: DeskPendingBody = {
      request: { ...request, requestKey },
      shown: { doctorName: c.doctor.name, doctorId: c.doctor.doctorId, branchName: c.branch.name, branchId: c.branch._id, day: c.slot.date, time: clock(c.slot.startTime) },
    };
    memory.set(lastBranchSlot(ctx), c.branch._id);
    void send(startOp(requestKey, body));
  };
  // WQ57: after a visit's appointment, its bill (the doctor's fee on it) opens at once for a member who makes bills.
  const navigate = useNavigate();
  const billed = useRef(false);
  // WQ57b: only once the booked appointment is read back (the server's patient and account holder, never typed names).
  const bookedRow = receipt ? list.data?.find((r) => r.bookingId === receipt.booking.bookingId) : undefined;
  useEffect(() => {
    if (!visit || !bookedRow || billed.current || !holdsAny(ctx.actor, ['invoices.create'])) return;
    billed.current = true;
    openBill(ctx, memory, { ...prefillOf(bookedRow), simple: true }, navigate);
  }, [bookedRow]); // eslint-disable-line react-hooks/exhaustive-deps

  const locked = !!pending;
  const rows = list.data ?? [];
  const current = rows.find((r) => r.bookingId === selected);

  // Q14: a no-show whose move was sent but not confirmed, and which has left the day it was on (a no-show can only leave
  // its day by its one move): read after the attempt, at that same day, branch and doctor, it is settled as moved.
  useEffect(() => {
    if (!selected || current || !list.isSuccess || list.isFetching) return;
    const slot = noShowMoveSlot(scopeIdentity(ctx), selected);
    const op = memory.get<NoShowMoveOp>(slot);
    const from = op?.body?.from;
    if (!op || !from || list.dataUpdatedAt <= op.lastAttemptAt) return;
    if (from.day !== day || (from.branchId && from.branchId !== branch?._id) || (doctor && from.doctorId !== doctor.doctorId)) return;
    resolveStored(memory, slot, op.requestKey);
    setStepFailure(null);
    setStepNotice({ id: selected, text: t('desk.noShowMoved') });
  }, [selected, current, list.isSuccess, list.isFetching, list.dataUpdatedAt, day, branch?._id, doctor?.doctorId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (branches.isPending || doctors.isPending) return <Loading label={t('desk.loading')} />;
  if (branches.isError) return <ErrorState message={messageOf(branches.error)} onRetry={() => void branches.refetch()} />;
  if (doctors.isError) return <ErrorState message={messageOf(doctors.error)} onRetry={() => void doctors.refetch()} />;
  if (offered.length === 0) {
    return (
      <Empty title={t('desk.noBranch.title')}>
        {ctx.actor.role === 'owner' ? t('desk.noBranch.owner') : t('desk.noBranch.other')}
      </Empty>
    );
  }

  const pendingPanel = pending && !(sending && pending.attempts === 1 && !pending.uncertain) ? (
        <PendingOpPanel key={pending.attempts} label={t('desk.unconfirmed')} op={pending} busy={sending} onResend={() => void send(pending)}
          // Q13: the exact appointment this desk member's key booked (`GET /clinic/appointments/by-key/:key`), also after a reload.
          fetchPage={keyedLookup(pending.requestKey, () => clinic.appointmentByKey(pending.requestKey))}
          onFound={(b) => settled(viewOf(b, pending, { replayed: true }), pending, true)}
          // Q13: decided by the server: `abandoned` = it can never be booked; `used` = here it is (or it is no longer in your branches).
          abandon={async () => {
            const r = await clinic.abandonBookingKey(pending.requestKey);
            if (r.state === 'used' && !r.booking) {
              closeWith(pending, t('desk.madeElsewhere'));
            }
            return { state: r.state, record: r.booking ? { ...r.booking, requestKey: pending.requestKey } : undefined };
          }}
          abandonWhenNotFound abandonLabel={t('desk.giveUp')}
          onDiscard={() => closeWith(pending, t('desk.gaveUp'))}
          summary={pending.restored || !pending.body ? null : <PendingBookingSummary body={pending.body} />} />
  ) : null;

  // WQ57 (P3): a visit from + New: the doctor and the time only (the patient came from + New), booked in one tap.
  if (visit) {
    return (
      <>
        {pendingPanel}
        {gaveUp && !pending && <Alert tone="ok">{gaveUp}</Alert>}
        {receipt ? (
          <>
            <Receipt ctx={ctx} receipt={receipt} memory={memory} row={rows.find((r) => r.bookingId === receipt.booking.bookingId)} />
            {!holdsAny(ctx.actor, ['invoices.create']) && <Link className="j-btn j-btn--primary" to="/">{t('desk.visit.done')}</Link>}
          </>
        ) : !pendingPanel && (
          <ClinicVisit ctx={ctx} clinic={clinic} visit={visit} when={when} branches={offered} doctors={doctors.data ?? []} patient={patient}
            sending={sending} refused={refused} memory={memory} onBook={bookChosen} />
        )}
      </>
    );
  }

  return (
    <>
      {pendingPanel}
      {gaveUp && !pending && <Alert tone="ok">{gaveUp}</Alert>}
      {receipt && <Receipt ctx={ctx} receipt={receipt} memory={memory} row={rows.find((r) => r.bookingId === receipt.booking.bookingId)} />}

      <div className="ws-search">
        <div className="j-field ws-filter">
          <label htmlFor="desk-branch">{t('desk.branch')}</label>
          <select id="desk-branch" value={branch?._id ?? ''} onChange={(e) => { setBranchChoice(e.target.value); setDoctorChoice(''); setChosen(null); }}>
            {offered.map((b) => <option key={b._id} value={b._id}>{b.name}</option>)}
          </select>
        </div>
        <TextField label={t('desk.day')} type="date" value={day} error={dayOk ? undefined : t('common.enterRealDate')} onChange={(e) => { setDay(e.target.value); setChosen(null); }} />
        <div className="j-field ws-filter">
          <label htmlFor="desk-doctor">{t('desk.doctor')}</label>
          <select id="desk-doctor" value={doctor?.doctorId ?? ''} onChange={(e) => { setDoctorChoice(e.target.value); setChosen(null); }}>
            <option value="">{t('desk.allDoctors')}</option>
            {here.map((d) => <option key={d.doctorId} value={d.doctorId}>{d.name}{d.specialization ? ` (${d.specialization})` : ''}</option>)}
          </select>
        </div>
      </div>
      <div className="ws-actions">
        <Button variant="secondary" disabled={!dayOk} onClick={() => { setDay(addDays(day, -1)); setChosen(null); }}>{t('desk.previousDay')}</Button>
        <Button variant="secondary" onClick={() => { setDay(istDateOf(new Date())); setChosen(null); }}>{t('desk.today')}</Button>
        <Button variant="secondary" disabled={!dayOk} onClick={() => { setDay(addDays(day, 1)); setChosen(null); }}>{t('desk.nextDay')}</Button>
      </div>

      <section className="ws-section" aria-labelledby="desk-appts-h">
        <h2 id="desk-appts-h">{dayOk ? t('desk.appointmentsOn', { day: formatDay(day) }) : t('desk.appointments')}</h2>
        {stepNotice && stepNotice.id === selected && <Alert tone="ok">{stepNotice.text}</Alert>}
        {!dayOk ? null
          : list.isPending ? <Loading label={t('desk.loadingAppointments')} />
          : list.isError ? <ErrorState message={messageOf(list.error)} onRetry={() => void list.refetch()} />
          : rows.length === 0 ? (
            <Empty title={t('desk.noAppointments.title')}>
              {doctor ? t('desk.noAppointments.doctor', { doctor: doctor.name, branch: branch!.name }) : t('desk.noAppointments.body', { branch: branch!.name })}
            </Empty>
          )
          : (
            <>
              {rows.length >= MAX_APPOINTMENTS && <p className="ws-count">{t('desk.firstMax', { max: MAX_APPOINTMENTS })}</p>}
              <div className="ws-table-wrap">
                <table className="j-table">
                  <caption className="j-sr-only">{t('desk.appointmentsOn', { day: formatDay(day) })}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('desk.col.time')}</th><th scope="col">{t('desk.col.patient')}</th><th scope="col">{t('desk.col.doctor')}</th>
                      <th scope="col">{t('desk.col.booked')}</th><th scope="col">{t('desk.col.status')}</th><th scope="col">{t('desk.col.bill')}</th>
                      <th scope="col">{t('desk.col.details')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.bookingId} aria-current={r.bookingId === selected ? 'true' : undefined}>
                        <td>{clock(r.bookingTime)}</td>
                        <td>{patientName(r)}{r.patient?.relationship ? <div className="ws-muted">{familyLine(r)}</div> : null}{r.patient?.phone ? <div className="ws-muted">{r.patient.phone}</div> : null}</td>
                        <td>{r.doctorName ?? '—'}</td>
                        <td>{r.source === 'desk' ? t('desk.source.desk') : r.paidOnline ? t('desk.source.onlinePaid') : t('desk.source.online')}</td>
                        <td>
                          <Badge tone={appointmentTone(r.status)}>{CLINIC_APPOINTMENT_STATUS_LABEL[r.status] ?? r.status}</Badge>
                          {r.arrivedAt && r.status === 'confirmed' && <> <Badge tone="ok">{t('desk.arrivedBadge', { time: istTime(r.arrivedAt) })}</Badge></>}
                          {busy[r.bookingId] && <div className="ws-muted">{t('desk.saving')}</div>}
                        </td>
                        <td><BillCell ctx={ctx} appt={r} memory={memory} branchName={branchNames.get(r.branchId ?? '') ?? ''} /></td>
                        <td>
                          <Button variant="ghost" aria-label={t('desk.openLabel', { name: patientName(r), time: clock(r.bookingTime) })}
                            onClick={() => { setSelected(r.bookingId); setStepNotice(null); setStepFailure(null); }}>{t('desk.open')}</Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
      </section>

      {/* Only from a day read that succeeded: when the re-read fails, the list shows the error with a retry and no
          appointment (or its steps) is offered from the last copy. While it is being read again, steps wait for it. */}
      {current && !list.isError && (
        // Keyed by the appointment's version too (Q13 `updatedAt`): when the appointment changes, an open confirmation or
        // move form closes, so a step is only ever sent for the version the person was looking at.
        <AppointmentPanel key={`${current.bookingId}:${current.updatedAt ?? ''}`} ctx={ctx} clinic={clinic} appt={current} doctors={doctors.data ?? []} branches={offered}
          branchName={branchNames.get(current.branchId ?? '') ?? t('desk.thisClinic')} now={now} busy={busy[current.bookingId]} reading={list.isFetching}
          failure={stepFailure?.id === current.bookingId ? stepFailure.text : null}
          perform={perform} guard={guard} click={click} onClose={() => setSelected(null)} readAt={list.dataUpdatedAt} memory={memory}
          onMoveNotice={(text) => { if (mounted.current && selectedRef.current === current.bookingId) { setStepFailure(null); setStepNotice({ id: current.bookingId, text }); } }}
          onMoveFailure={(text) => { if (mounted.current && selectedRef.current === current.bookingId) { setStepNotice(null); setStepFailure({ id: current.bookingId, text }); } }}
          onMoved={moved} slotKnown={sessionOf(current, slots.data)} />
      )}

      <section className="ws-section" aria-labelledby="desk-slots-h">
        <h2 id="desk-slots-h">{doctor ? t('desk.freeSlotsOf', { doctor: doctor.name }) : t('desk.freeSlots')}</h2>
        {manage && locked && <Alert tone="warn">{t('desk.settleFirst')}</Alert>}
        {here.length === 0 ? (
          <Empty title={t('desk.noDoctorHere.title')}>
            <Parts of={t.rich('desk.noDoctorHere.body', { branch: branch!.name, doctors: <Link to={clinicLink(ctx, 'clinic-doctors')}>{t('desk.doctorsLink')}</Link> })} />
          </Empty>
        )
          : !doctor ? <p className="ws-muted">{manage ? t('desk.chooseDoctorBook') : t('desk.chooseDoctor')}</p>
          : !dayOk ? null
          : slots.isPending ? <Loading label={t('desk.loadingSlots')} />
          : slots.isError ? <ErrorState message={messageOf(slots.error)} onRetry={() => void slots.refetch()} />
          : (slots.data ?? []).length === 0 ? <Empty title={t('desk.noFreeSlots.title')}>{t('desk.noFreeSlots.body', { doctor: doctor.name, branch: branch!.name })}</Empty>
          : (
            <>
              {!manage && <p className="ws-muted">{t('desk.needsManage')}</p>}
              <div className="ws-table-wrap">
                <table className="j-table">
                  <caption className="j-sr-only">{t('desk.slotsCaption', { doctor: doctor.name, day: formatDay(day) })}</caption>
                  <thead>
                    <tr><th scope="col">{t('desk.col.time')}</th><th scope="col">{t('desk.col.seatsLeft')}</th>{manage && <th scope="col">{t('desk.col.book')}</th>}</tr>
                  </thead>
                  <tbody>
                    {slots.data!.map((s) => {
                      // Q13: the server lists only slots that have not started (and refuses one that starts meanwhile).
                      return (
                        <tr key={s.slotId} aria-current={chosen?.slot.slotId === s.slotId ? 'true' : undefined}>
                          <td>{clock(s.startTime)}–{clock(s.endTime)}</td>
                          <td>{s.seatsLeft}</td>
                          {manage && (
                            <td>
                              <Button variant="secondary" disabled={locked || sending} aria-label={t('desk.bookAt', { time: clock(s.startTime) })}
                                onClick={() => { setChosen({ slot: s, doctor, branch: branch! }); setRefused(null); setReceipt(null); }}>{t('desk.book')}</Button>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        {manage && refused && !chosen && <Alert>{t('desk.notBooked', { reason: refused })}</Alert>}
      </section>

      {manage && chosen && !(pending && !(sending && pending.attempts === 1 && !pending.uncertain)) && (
        <BookingForm chosen={chosen} patient={patient} setPatient={setPatient} sending={sending} refused={refused}
          onCancel={() => { setChosen(null); setRefused(null); }}
          onBook={(request) => bookChosen(chosen, request)} />
      )}
    </>
  );
}

const patientName = (r: Pick<ClinicAppointment, 'patient'>) => r.patient?.name || t('desk.nameNotGiven');

/**
 * WQ57 (P3): a visit's appointment: the branch (the last-used one first), the doctor (big buttons), then "now" the next free
 * time today or "later" a day and its free times. A time when the doctor is busy elsewhere (r40) is never offered.
 */
function ClinicVisit({ ctx, clinic, visit, when, branches, doctors, patient, sending, refused, memory, onBook }: {
  ctx: ScopeContext; clinic: ClinicApi; visit: VisitPatient; when: 'now' | 'later'; branches: Branch[]; doctors: ClinicDoctorRow[]; patient: Patient;
  sending: boolean; refused: string | null; memory: SessionMemory; onBook: (c: Chosen, request: Omit<DeskPendingBody['request'], 'requestKey'>) => void;
}) {
  const today = istDateOf(new Date());
  // WQ57b: with several branches, none is chosen for the clerk (the last used one is only marked).
  const [branchId, setBranchId] = useState(() => (branches.length === 1 ? branches[0]!._id : ''));
  const lastUsed = memory.get<string>(lastBranchSlot(ctx));
  const branch = branches.find((b) => b._id === branchId);
  const here = branch ? doctorsAtBranch(doctors, branch._id) : [];
  const [doctorId, setDoctorId] = useState<string | null>(null);
  const doctor = here.find((d) => d.doctorId === doctorId) ?? (here.length === 1 ? here[0] : undefined);
  const [day, setDay] = useState(today);
  const [pickDay, setPickDay] = useState(false);
  const [slotId, setSlotId] = useState<string | null>(null);
  const slots = useQuery({
    queryKey: [...ctx.key, 'clinic-slots', doctor?.doctorId, branch?._id, day], enabled: !!doctor && !!branch && isRealDate(day),
    queryFn: () => clinic.deskSlots({ doctorId: doctor!.doctorId, branchId: branch!._id, date: day }),
  });
  const busy = useQuery({
    queryKey: [...ctx.key, 'clinic-busy', doctor?.doctorId, day], enabled: !!doctor && isRealDate(day),
    queryFn: () => clinic.dayView({ from: day, to: day, doctorId: doctor!.doctorId }),
  });
  // WQ57b: the server leaves out a one-patient slot inside the doctor's busy time and refuses one (409 DOCTOR_BUSY); a shared
  // session stays offered. The page only says why some times are missing.
  const free = (slots.data ?? []).filter((s) => s.seatsLeft > 0);
  const slot = when === 'now' ? free[0] : free.find((s) => s.slotId === slotId);
  const book = () => doctor && branch && slot && onBook({ slot, doctor, branch }, requestOf(patient, slot.slotId));
  const fee = doctor?.consultationFee;
  const tomorrow = addDays(today, 1);
  const chooseDay = (d: string) => { setDay(d); setSlotId(null); };
  return (
    <section className="ws-section visit-task" aria-labelledby="cv-h">
      <h1 id="cv-h" className="visit-task-title">{when === 'now' ? t('desk.visit.now') : t('desk.visit.later')}</h1>
      <VisitPatientLine patient={visit} canChange={!sending} />
      {branches.length > 1 && (
        <div className="big-actions big-actions--two" role="group" aria-label={t('desk.visit.whichBranch')}>
          {branches.map((b) => (
            <button key={b._id} type="button" className={b._id === lastUsed ? 'big-action big-action--last' : 'big-action'} aria-pressed={branchId === b._id}
              onClick={() => { setBranchId(b._id); setDoctorId(null); setSlotId(null); }}>
              {b.name}{b._id === lastUsed ? <span className="big-action-text">{t('desk.visit.lastUsed')}</span> : null}
            </button>
          ))}
        </div>
      )}
      {branch && (here.length === 0 ? <Alert tone="warn">{t('desk.visit.noDoctor')}</Alert> : (
        <div className="big-actions big-actions--two" role="group" aria-label={t('desk.visit.whichDoctor')}>
          {here.map((d) => (
            <button key={d.doctorId} type="button" className="big-action" aria-pressed={doctor?.doctorId === d.doctorId}
              onClick={() => { setDoctorId(d.doctorId); setSlotId(null); }}>{d.name}{d.specialization ? <span className="big-action-text">{d.specialization}</span> : null}</button>
          ))}
        </div>
      ))}
      {doctor && when === 'later' && (
        <>
          <div className="pay-buttons" role="group" aria-label={t('desk.visit.day')}>
            <button type="button" className="pay-button" aria-pressed={!pickDay && day === today} onClick={() => { setPickDay(false); chooseDay(today); }}>{t('desk.visit.today')}</button>
            <button type="button" className="pay-button" aria-pressed={!pickDay && day === tomorrow} onClick={() => { setPickDay(false); chooseDay(tomorrow); }}>{t('desk.visit.tomorrow')}</button>
            <button type="button" className="pay-button" aria-pressed={pickDay} onClick={() => setPickDay(true)}>{t('desk.visit.pickDate')}</button>
          </div>
          {pickDay && <TextField label={t('desk.visit.date')} type="date" min={today} value={day} onChange={(e) => { if (e.target.value) chooseDay(e.target.value); }} />}
        </>
      )}
      {doctor && (!slots.data || !busy.data ? (slots.isError || busy.isError
        ? <ErrorState message={messageOf(slots.error ?? busy.error)} onRetry={() => { void slots.refetch(); void busy.refetch(); }} /> : <Loading label={t('desk.loadingSlots')} />)
        : free.length === 0 ? <Alert tone="warn">{when === 'now' ? t('desk.visit.noneToday', { doctor: doctor.name }) : t('desk.visit.noTimes', { doctor: doctor.name })}</Alert>
        : when === 'now' ? <p className="visit-next-free">{t('desk.visit.nextFree', { time: clock(free[0]!.startTime) })}</p>
        : (
          <div className="pay-buttons" role="group" aria-label={t('desk.visit.times')}>
            {free.map((s) => (
              <button key={s.slotId} type="button" className="pay-button" aria-pressed={slotId === s.slotId} onClick={() => setSlotId(s.slotId)}>{clock(s.startTime)}</button>
            ))}
          </div>
        ))}
      {doctor && busy.data && busy.data.busy.some((b) => b.doctorId === doctor.doctorId) && <p className="ws-muted">{t('desk.visit.busyHidden')}</p>}
      {refused && <Alert>{t('desk.notBooked', { reason: refused })}</Alert>}
      {doctor && branch && slot && (
        // On a short phone the one action stays in sight at the bottom.
        <div className="visit-book-bar">
          <Button busy={sending} onClick={book}>{t('desk.visit.book', { doctor: doctor.name, time: clock(slot.startTime), branch: branch.name })}</Button>
          <span className="ws-muted">{fee ? t('desk.form.fee', { fee: formatRupees(fee) }) : t('desk.form.feeNone')}</span>
        </div>
      )}
    </section>
  );
}

/** A booking's request from the desk's patient details (the account holder's mobile and name; a family member when chosen). */
function requestOf(patient: Patient, slotId: string): Omit<DeskPendingBody['request'], 'requestKey'> {
  const name = patient.name.trim();
  const notes = patient.notes.trim();
  const seen: DeskPatientInput | undefined = patient.forFamily && patient.relation
    ? { name: patient.familyName.trim().replace(/\s+/g, ' '), relation: patient.relation, ...(patient.gender ? { gender: patient.gender } : {}),
      ...(patient.dateOfBirth ? { dateOfBirth: patient.dateOfBirth } : {}) }
    : undefined;
  return { slotId, customer: { phone: canonicalMobile(patient.phone)!, ...(name ? { name } : {}) }, ...(seen ? { patient: seen } : {}), ...(notes ? { notes } : {}) };
}

/** WQ57: + New's patient as the desk's details: the account holder's name (the owner's, for a family member) and who is seen. */
/** WQ56b: + New's patient as a desk booking's request (a doctor's own clinic appointment and online consultation too). */
export const visitRequest = (v: VisitPatient, slotId: string) => requestOf(patientOf(v), slotId);

const patientOf = (v: VisitPatient): Patient => ({
  ...NO_PATIENT, phone: v.phone, name: v.family ? v.family.holderName : v.name,
  ...(v.family ? { forFamily: true, familyName: v.name, relation: v.family.relation, gender: v.family.gender, dateOfBirth: v.family.dateOfBirth } : {}),
});

/** WQ57: this person's last-used branch at the desk (session memory only). */
const lastBranchSlot = (ctx: ScopeContext) => `clinic-last-branch:${scopeIdentity(ctx)}`;

/** Q14: who is being seen, when it is a family member: "Mother of Kiran Shah". */
const familyLine = (r: Pick<ClinicAppointment, 'patient'>) =>
  (!r.patient?.relationship ? ''
    : r.patient.accountName == null ? t('desk.familyLineHolder', { relation: r.patient.relationship })
    : t('desk.familyLine', { relation: r.patient.relationship, name: r.patient.accountName }));
/** The family member named in a desk booking request, if any. */
const familyOf = (body: DeskPendingBody) => (body.request.patient && 'name' in body.request.patient ? body.request.patient.name : undefined);

/** What a settled booking shows (from its answer, or from a by-key lookup when the details are gone after a reload). */
interface ReceiptView {
  booking: DeskAppointment; replayed: boolean; created?: boolean; who?: string; branchName: string; doctorName?: string;
  /** Q14: the family member being seen (from the answer). */
  family?: { name: string | null; relationship: string | null };
}

/** The answer to a booking: what was booked, the fee to collect, and the way to bill it. */
/**
 * The bill for the visit is prefilled from the appointment as the server lists it (its account holder's mobile and name),
 * never from what this device remembers: after a reload the details are gone. Until the row is read, the receipt points
 * to the row's "Create bill".
 */
function Receipt({ ctx, receipt, memory, row }: { ctx: ScopeContext; receipt: ReceiptView; memory: SessionMemory; row?: ClinicAppointment }) {
  const b = receipt.booking;
  // WQ57b: the server's patient (the booked row read back), never the names typed for the booking.
  const name = row?.patient?.name ?? receipt.family?.name ?? t('desk.thePatient');
  const relation = receipt.family?.relationship;
  const what = t('desk.receipt.what', {
    who: relation ? t('desk.receipt.withRelation', { name, relation }) : name, doctor: receipt.doctorName ?? t('desk.theDoctor'),
    when: appointmentLabel(b), branch: receipt.branchName,
  });
  return (
    <Alert tone="ok">
      {receipt.replayed ? t('desk.receipt.replayed') : t('desk.receipt.booked')} {what}
      {' '}{t('desk.receipt.fee', { fee: formatRupees(b.fee ?? 0) })}
      {receipt.created ? <> {t('desk.receipt.created')}</> : null}
      {' '}{t('desk.receipt.notified')}
      {row?.patient?.phone ? null : holdsAny(ctx.actor, ['invoices.create']) ? <>{' '}{t('desk.receipt.makeBill')}</> : null}
      {/* WQ57: the next step is the bill (the main button, the doctor's fee on it). */}
      {row?.patient?.phone && <div className="ws-actions"><BillLink ctx={ctx} memory={memory} prefill={prefillOf(row)} className="j-btn j-btn--primary" /></div>}
    </Alert>
  );
}

/** The booking held while its outcome is unknown (session memory only; never stored or put in a URL). */
function PendingBookingSummary({ body }: { body: DeskPendingBody }) {
  const { request, shown } = body;
  return (
    <div>
      {t('desk.pending.summary', {
        who: familyOf(body) ? t('desk.pending.family', { name: familyOf(body)!, phone: request.customer.phone })
          : request.customer.name ? `${request.customer.name} (${request.customer.phone})` : request.customer.phone,
        doctor: shown.doctorName, day: formatDay(shown.day), time: shown.time, branch: shown.branchName,
      })}
    </div>
  );
}

/**
 * Q14: the bill's customer is the appointment's account holder (409 APPOINTMENT_CUSTOMER_MISMATCH otherwise), not a family
 * member. WQ57: the doctor's fee is on it.
 */
const prefillOf = (a: ClinicAppointment): BillPrefill => ({
  link: { kind: 'appointment', id: a.bookingId }, branchId: a.branchId ?? '', doctorId: a.doctorId,
  name: (a.patient?.relationship ? a.patient.accountName : a.patient?.name) ?? '', phone: a.patient?.phone ?? '',
  label: `${a.doctorName ?? t('desk.theDoctor')}, ${appointmentLabel(a)}`,
  ...(a.fee ? { handLines: [feeLine(a.doctorName, a.fee)] } : {}),
});
/** WQ57: the doctor's fee (rupees) as a bill line. */
export const feeLine = (doctor: string | undefined, fee: number) => ({
  description: t('desk.feeLine', { doctor: doctor ?? t('desk.theDoctor') }), priceMinor: Math.round(fee * 100), ...(doctor ? { doctor } : {}),
});

/**
 * Q14: an appointment's bill (its open bill, else the latest cancelled one): its number and status with a link; or, for
 * a desk appointment without an open bill, "Create bill" for bill makers.
 */
function BillCell({ ctx, appt, memory, branchName }: { ctx: ScopeContext; appt: ClinicAppointment; memory: SessionMemory; branchName: string }) {
  const bill = appt.bill;
  const open = bill && bill.state !== 'cancelled';
  const readers = holdsAny(ctx.actor, BILL_READERS);
  return (
    <>
      {bill && (readers
        ? <Link to={`${ctx.link('invoices')}/${bill.invoiceId}`} aria-label={t('desk.billLabel', { serial: bill.serial, state: INVOICE_STATE_LABEL[bill.state] ?? bill.state })}>{bill.serial}</Link>
        : <span>{bill.serial}</span>)}
      {bill && <div className="ws-muted">{INVOICE_STATE_LABEL[bill.state] ?? bill.state}</div>}
      {!open && appt.source === 'desk' && appt.status !== 'cancelled' && holdsAny(ctx.actor, ['invoices.create']) && (
        <div>
          <BillLink ctx={ctx} memory={memory} prefill={prefillOf(appt)} label={t('desk.createBill')} />
          <span className="j-sr-only"> {t('desk.createBillFor', { name: patientName(appt), branch: branchName })}</span>
        </div>
      )}
      {!bill && !(appt.source === 'desk' && appt.status !== 'cancelled' && holdsAny(ctx.actor, ['invoices.create'])) && <span className="ws-muted">—</span>}
    </>
  );
}

function BookingForm({ chosen, patient, setPatient, sending, refused, onCancel, onBook }: {
  chosen: Chosen; patient: Patient; setPatient: (p: Patient) => void; sending: boolean; refused: string | null;
  onCancel: () => void; onBook: (request: Omit<DeskPendingBody['request'], 'requestKey'>) => void;
}) {
  const [tried, setTried] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const today = istDateOf(new Date());
  const family = patient.forFamily
    ? familyMemberProblems({ name: patient.familyName, relation: patient.relation, gender: patient.gender, dateOfBirth: patient.dateOfBirth }, new Date()) : {};
  const problems: Record<string, string | undefined> = { ...deskBookingProblems(patient), ...(patient.forFamily ? {
    familyName: family.name, relation: family.relation, gender: family.gender, dateOfBirth: family.dateOfBirth } : {}) };
  for (const k of Object.keys(problems)) if (!problems[k]) delete problems[k];
  const errors = tried ? problems : {};
  const set = (p: Partial<Patient>) => { setPatient({ ...patient, ...p }); setReviewing(false); };
  useEffect(() => { if (refused) setReviewing(false); }, [refused]);
  const when = `${formatDay(chosen.slot.date)}, ${clock(chosen.slot.startTime)}`;
  const fee = chosen.doctor.consultationFee;
  const name = patient.name.trim();
  const familyName = patient.familyName.trim().replace(/\s+/g, ' ');
  const seen: DeskPatientInput | undefined = patient.forFamily && patient.relation
    ? { name: familyName, relation: patient.relation, ...(patient.gender ? { gender: patient.gender } : {}), ...(patient.dateOfBirth ? { dateOfBirth: patient.dateOfBirth } : {}) }
    : undefined;

  function review(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    if (Object.keys(problems).length === 0) setReviewing(true);
  }

  return (
    <section className="ws-section" aria-labelledby="desk-book-h">
      <h2 id="desk-book-h">{t('desk.form.title', { doctor: chosen.doctor.name, when })}</h2>
      <p className="ws-muted">{t('desk.form.intro', { branch: chosen.branch.name })}</p>
      <form className="rx-form" noValidate onSubmit={review}>
        <fieldset className="ws-frozen" disabled={sending}>
          <div className="rx-form-row">
            <TextField label={t('desk.form.phone')} inputMode="tel" value={patient.phone} error={errors.phone} onChange={(e) => set({ phone: e.target.value })}
              hint={t('desk.form.phoneHint')} />
            <TextField label={patient.forFamily ? t('desk.form.holderName') : t('desk.form.patientName')} value={patient.name} maxLength={MAX_DESK_NAME} error={errors.name}
              onChange={(e) => set({ name: e.target.value })} hint={t('desk.form.nameHint')} />
          </div>
          <fieldset className="ws-checks">
            <legend>{t('desk.form.who')}</legend>
            <label className="ws-check"><input type="radio" name="desk-who" checked={!patient.forFamily} onChange={() => set({ forFamily: false })} /> {t('desk.form.holder')}</label>
            <label className="ws-check"><input type="radio" name="desk-who" checked={patient.forFamily} onChange={() => set({ forFamily: true })} /> {t('desk.form.family')}</label>
          </fieldset>
          {patient.forFamily && (
            <div className="rx-form-row">
              <TextField label={t('desk.form.familyName')} value={patient.familyName} maxLength={MAX_FAMILY_NAME} error={errors.familyName}
                onChange={(e) => set({ familyName: e.target.value })}
                hint={t('desk.form.familyNameHint')} />
              <div className="j-field">
                <label htmlFor="desk-relation">{t('desk.form.relation')}</label>
                <select id="desk-relation" value={patient.relation} aria-invalid={errors.relation ? true : undefined} aria-describedby={errors.relation ? 'desk-relation-err' : undefined}
                  onChange={(e) => set({ relation: e.target.value as DeskRelation })}>
                  <option value="">{t('desk.form.choose')}</option>
                  {DESK_RELATIONS.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
                {errors.relation && <span id="desk-relation-err" className="j-field__error">{errors.relation}</span>}
              </div>
              <div className="j-field">
                <label htmlFor="desk-gender">{t('desk.form.gender')}</label>
                <select id="desk-gender" value={patient.gender} onChange={(e) => set({ gender: e.target.value as DeskGender })}>
                  <option value="">{t('desk.form.genderNone')}</option>
                  {DESK_GENDERS.map((g) => <option key={g} value={g}>{g}</option>)}
                </select>
              </div>
              <TextField label={t('desk.form.dateOfBirth')} type="date" max={today} value={patient.dateOfBirth} error={errors.dateOfBirth} onChange={(e) => set({ dateOfBirth: e.target.value })} />
            </div>
          )}
          <TextArea label={t('desk.form.notes')} value={patient.notes} maxLength={MAX_DESK_NOTES} error={errors.notes} onChange={(e) => set({ notes: e.target.value })} />
        </fieldset>
        {refused && <Alert>{t('desk.notBooked', { reason: refused })}</Alert>}
        {!reviewing ? (
          <div className="rx-actions">
            <Button type="submit">{t('desk.form.review')}</Button>
            <Button variant="ghost" onClick={onCancel}>{shared('action.back')}</Button>
          </div>
        ) : (
          <div className="confirm" role="group" aria-label={t('desk.form.confirmGroup')}>
            <div className="confirm-text">
              {seen && 'name' in seen
                ? t('desk.form.confirmFamily', {
                  name: seen.name, relation: seen.relation, phone: canonicalMobile(patient.phone) ?? '', doctor: chosen.doctor.name, when, branch: chosen.branch.name,
                })
                : t('desk.form.confirm', {
                  who: name ? `${name} (${canonicalMobile(patient.phone) ?? ''})` : canonicalMobile(patient.phone) ?? '', doctor: chosen.doctor.name, when, branch: chosen.branch.name,
                })}
              {' '}{fee ? t('desk.form.fee', { fee: formatRupees(fee) }) : t('desk.form.feeNone')}
              {' '}{t('desk.form.notified')}
              {' '}{t('desk.form.once')}
            </div>
            <div className="confirm-actions">
              <Button busy={sending} onClick={() => onBook(requestOf(patient, chosen.slot.slotId))}>{t('desk.form.book')}</Button>
              <Button variant="ghost" disabled={sending} onClick={() => setReviewing(false)}>{t('desk.form.backToDetails')}</Button>
            </div>
          </div>
        )}
      </form>
    </section>
  );
}

// ── One appointment ──

/**
 * Q16d: the desk rows do not say how many seats their slot has. When the appointment's own slot is still listed with a
 * free seat while it holds one, it is a session with several patients (its no-show waits for the session's end).
 */
function sessionOf(appt: ClinicAppointment, free: readonly DeskSlot[] | undefined): DeskSlotKnown | undefined {
  const s = appt.slotId ? free?.find((x) => x.slotId.toLowerCase() === appt.slotId!.toLowerCase()) : undefined;
  return s && s.seatsLeft > 0 ? { seats: s.seatsLeft + 1, endTime: s.endTime } : undefined;
}

function AppointmentPanel({ ctx, clinic, appt, doctors, branches, branchName, now, busy, reading, failure, perform, guard, click, onClose, readAt, memory,
  onMoveNotice, onMoveFailure, onMoved, slotKnown }: {
  ctx: ScopeContext; clinic: ClinicApi; appt: ClinicAppointment; doctors: ClinicDoctorRow[]; branches: Branch[]; branchName: string; now: Date;
  busy: DeskAction | undefined; reading: boolean; failure: string | null; perform: Perform; guard: Guard;
  click: (a: ClinicAppointment, action: DeskAction, what: string, run: () => Promise<DeskAppointment>, done: (n: DeskAppointment) => string) => Promise<void>;
  onClose: () => void; readAt: number; memory: SessionMemory;
  onMoveNotice: (text: string) => void; onMoveFailure: (text: string) => void; onMoved: (id: string, next: DeskAppointment) => void;
  slotKnown?: DeskSlotKnown;
}) {
  const queryClient = useQueryClient();
  const offers = deskActions(appt, ctx.actor, now, slotKnown);
  // Q14: the one move of a desk no-show (also while a move sent earlier is unconfirmed, whatever the status is now).
  const moveSlot = noShowMoveSlot(scopeIdentity(ctx), appt.bookingId);
  const showMove = !!offers.find((o) => o.action === 'reschedule_no_show') || (holdsAny(ctx.actor, ['bookings.manage']) && !!memory.get(moveSlot));
  const offer = (a: DeskAction) => offers.find((o) => o.action === a);
  // A step waits while one runs on this appointment, and while the day is being read again (it may have changed).
  const disabled = busy !== undefined || reading;
  const who = patientName(appt);
  const when = appointmentLabel(appt);
  const finished = ['completed', 'cancelled', 'no_show'].includes(appt.status);
  // Whether its one move after a no-show was used: known only when the server lists it (true/false), else undefined.
  const movedOnce = appt.noShows !== undefined || appt.noShowReschedules !== undefined ? noShowMovedOnce(appt) : undefined;

  return (
    <section className="ws-section" aria-labelledby="desk-appt-h">
      <h2 id="desk-appt-h">{t('desk.appt.title', { name: who, when })}</h2>
      <dl className="ws-dl">
        <dt>{t('desk.appt.patient')}</dt>
        <dd>{who}{appt.patient?.relationship ? ` (${familyLine(appt)})` : ''}</dd>
        {appt.patient?.phone && <><dt>{t('desk.appt.mobile')}</dt><dd>{appt.patient.phone}</dd></>}
        <dt>{t('desk.appt.doctor')}</dt><dd>{appt.doctorName ?? '—'}</dd>
        <dt>{t('desk.appt.when')}</dt><dd>{t('desk.appt.whenIst', { when, branch: branchName })}</dd>
        <dt>{t('desk.appt.booked')}</dt>
        <dd>
          {appt.source === 'desk' ? t('desk.appt.bookedDesk')
            : appt.consultationMode ? t('desk.appt.bookedOnlineMode', { mode: appt.consultationMode }) : t('desk.appt.bookedOnline')}
        </dd>
        <dt>{t('desk.appt.payment')}</dt>
        <dd>
          {appt.source === 'desk' ? t('desk.appt.paidAtClinic', { fee: formatRupees(appt.fee ?? 0) })
            : appt.paidOnline ? t('desk.appt.paidOnline', { fee: formatRupees(appt.fee ?? 0) }) : t('desk.appt.notPaidOnline')}
        </dd>
        <dt>{t('desk.appt.status')}</dt>
        <dd>
          <Badge tone={appointmentTone(appt.status)}>{CLINIC_APPOINTMENT_STATUS_LABEL[appt.status] ?? appt.status}</Badge>
          {appt.arrivedAt && appt.status === 'confirmed' && <> {t('desk.appt.arrivedAt', { time: istTime(appt.arrivedAt) })}</>}
        </dd>
      </dl>
      {appt.bill && (
        <p>
          <Parts of={t.rich('desk.appt.bill', {
            serial: holdsAny(ctx.actor, BILL_READERS) ? <Link to={`${ctx.link('invoices')}/${appt.bill.invoiceId}`}>{appt.bill.serial}</Link> : appt.bill.serial,
          })} /> · {INVOICE_STATE_LABEL[appt.bill.state] ?? appt.bill.state}
        </p>
      )}
      {failure && <Alert>{failure}</Alert>}
      {appt.status === 'no_show' && appt.source === 'desk' && (
        <p className="ws-muted">
          {movedOnce === true ? t('desk.appt.noShowFinal') : movedOnce === false ? t('desk.appt.noShowMovable') : t('desk.appt.noShowMaybe')}
        </p>
      )}
      {showMove && (
        <div className="ws-actions">
          <NoShowMove<DeskAppointment & { replayed?: boolean }> slot={moveSlot} who={who} missed={when}
            // i18n-ignore: a code, not words
            state="offer" status={appt.status} readAt={readAt} reading={reading} disabled={busy !== undefined || reading} version={appt.updatedAt}
            consequence={t('desk.appt.moveConsequence')}
            picker={(choose) => <DeskSlotPicker ctx={ctx} clinic={clinic} appt={appt} doctors={doctors} branches={branches} now={now} onChoose={choose} />}
            send={(target: NoShowTarget, requestKey) => guard(appt, 'reschedule_no_show', () => clinic.rescheduleNoShow(appt.bookingId, target.slotId, requestKey, typeof target.version === 'string' ? target.version : undefined))}
            onMoved={(next: DeskAppointment) => onMoved(appt.bookingId, next)}
            reread={() => void queryClient.invalidateQueries({ queryKey: [...ctx.key, 'clinic-appointments'] })}
            onNotice={onMoveNotice} onFailure={onMoveFailure}
            onSlotRefused={() => void queryClient.invalidateQueries({ queryKey: [...ctx.key, 'clinic-slots'] })} />
        </div>
      )}
      {offers.some((o) => o.action !== 'reschedule_no_show') ? (
        <div className="ws-actions">
          {offer('arrived') && (
            <Button disabled={disabled} busy={busy === 'arrived'}
              onClick={() => void click(appt, 'arrived', t('desk.arrived.failed'), () => clinic.arrived(appt.bookingId, appt.updatedAt), () => t('desk.arrived.done', { name: who }))}>
              {t('desk.arrived')}
            </Button>
          )}
          {offer('complete') && (offer('complete')!.blocked ? (
            <div className="ws-action">
              <Button disabled>{t('desk.seen')}</Button>
              <span className="ws-muted">{offer('complete')!.blocked}</span>
            </div>
          ) : (
            <ConfirmAction label={t('desk.seen')} disabled={disabled} confirmLabel={t('desk.seen')}
              consequence={t('desk.seen.consequence', { name: who, doctor: appt.doctorName ?? t('desk.theDoctor'), fee: formatRupees(appt.fee ?? 0) })}
              onConfirm={() => perform(appt, 'complete', () => clinic.complete(appt.bookingId, appt.updatedAt), () => t('desk.seen.done', { name: who }))
                .catch((err: unknown) => { throw readable(err); })} />
          ))}
          {offer('no_show') && <NoShow appt={appt} offer={offer('no_show')!} who={who} when={when} disabled={disabled} perform={perform} clinic={clinic} movedOnce={movedOnce} />}
          {offer('reschedule') && (
            <Reschedule ctx={ctx} clinic={clinic} appt={appt} doctors={doctors} branches={branches} now={now} disabled={disabled} perform={perform} />
          )}
          {offer('cancel') && (
            <ConfirmAction label={t('desk.cancel')} danger disabled={disabled}
              // i18n-ignore: "optional" is a mode of the reason field, not words
              reason="optional" reasonLabel={t('desk.cancel.reason')} maxReason={MAX_DESK_CANCEL_REASON}
              confirmLabel={t('desk.cancel')}
              consequence={t('desk.cancel.consequence', { name: who, doctor: appt.doctorName ?? t('desk.theDoctor'), when })}
              onConfirm={(reason) => perform(appt, 'cancel', () => clinic.cancel(appt.bookingId, reason, appt.updatedAt), () => t('desk.cancel.done', { name: who }))} />
          )}
        </div>
      ) : showMove ? null : appt.source === 'online' ? (
        <p className="ws-muted">{t('desk.onlineNote')}</p>
      ) : !finished && !holdsAny(ctx.actor, ['bookings.manage']) ? (
        <p className="ws-muted">{t('desk.viewOnly')}</p>
      ) : null}
      <div className="ws-actions">
        {appt.source === 'desk' && appt.status !== 'cancelled' && (!appt.bill || appt.bill.state === 'cancelled') && (
          <BillLink ctx={ctx} memory={memory} prefill={prefillOf(appt)} />
        )}
        <Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>
      </div>
    </section>
  );
}

function NoShow({ appt, offer, who, when, disabled, perform, clinic, movedOnce }: {
  appt: ClinicAppointment; offer: DeskActionOffer; who: string; when: string; disabled: boolean; perform: Perform; clinic: ClinicApi;
  /** WQ11b: whether this appointment was already moved once after a no-show (undefined: the server does not say). */
  movedOnce: boolean | undefined;
}) {
  if (offer.blocked) {
    return (
      <div className="ws-action">
        <Button variant="secondary" disabled>{t('desk.noShow')}</Button>
        <span className="ws-muted">{offer.blocked}</span>
      </div>
    );
  }
  return (
    <ConfirmAction label={t('desk.noShow')} danger disabled={disabled} confirmLabel={t('desk.noShow')}
      // WQ11b: never promise a move the server refuses (a booking moves once after a no-show; a second no-show is final).
      consequence={t(movedOnce === true ? 'desk.noShow.final' : movedOnce === false ? 'desk.noShow.movable' : 'desk.noShow.maybe', { name: who, when })}
      onConfirm={() => perform(appt, 'no_show', () => clinic.noShow(appt.bookingId, appt.updatedAt), () => t('desk.noShow.done', { name: who }))
        .catch((err: unknown) => { throw readable(err); })} />
  );
}

/** Another free slot of the same doctor (any day, a branch of this clinic in the actor's scope where the doctor consults). */
function Reschedule({ ctx, clinic, appt, doctors, branches, now, disabled, perform }: {
  ctx: ScopeContext; clinic: ClinicApi; appt: ClinicAppointment; doctors: ClinicDoctorRow[]; branches: Branch[]; now: Date; disabled: boolean; perform: Perform;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const doctor = doctors.find((d) => d.doctorId === appt.doctorId);
  const places = branches.filter((b) => (doctor ? doctor.active && (doctor.branchIds.length === 0 || doctor.branchIds.includes(b._id)) : b._id === appt.branchId));
  const [branchId, setBranchId] = useState(() => (places.some((b) => b._id === appt.branchId) ? appt.branchId! : places[0]?._id ?? ''));
  const [date, setDate] = useState(() => appointmentDay(appt.bookingDate) ?? istDateOf(now));
  const [slotId, setSlotId] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const dateOk = isRealDate(date);
  const slotsKey = [...ctx.key, 'clinic-slots', appt.doctorId, branchId, date];
  const slots = useQuery({
    queryKey: slotsKey, enabled: open && !!branchId && dateOk,
    queryFn: () => clinic.deskSlots({ doctorId: appt.doctorId, branchId, date }),
  });

  if (!open) return <Button variant="secondary" disabled={disabled} onClick={() => setOpen(true)}>{t('desk.move')}</Button>;

  const choices = (slots.data ?? []).filter((s) => s.slotId !== appt.slotId);
  const picked = choices.find((s) => s.slotId === slotId);
  const target = places.find((b) => b._id === branchId);
  const when = picked ? `${formatDay(picked.date)}, ${clock(picked.startTime)}` : '';

  function review(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!picked) { setFieldError(t('desk.move.chooseTime')); return; }
    setFieldError(null);
    setConfirming(true);
  }

  async function move() {
    if (!picked) return;
    setSending(true);
    setError(null);
    try {
      await perform(appt, 'reschedule', () => clinic.reschedule(appt.bookingId, picked.slotId, appt.updatedAt),
        (n) => t('desk.move.done', { when: appointmentLabel(n), branch: target?.name ?? t('desk.theClinic') }));
      setOpen(false);
    } catch (err) {
      // E.g. the slot was taken or has started meanwhile (409 SLOT_NOT_AVAILABLE / SLOT_STARTED): show the free slots
      // as they are now. A changed appointment (BOOKING_CHANGED) is said above the steps and the day is read again.
      setError(isChanged(err) ? t('desk.changed') : messageOf(err));
      setConfirming(false);
      void queryClient.invalidateQueries({ queryKey: slotsKey });
    } finally {
      setSending(false);
    }
  }

  return (
    <form className="confirm" noValidate onSubmit={review} aria-label={t('desk.move')}>
      {places.length === 0 ? <p className="ws-muted">{noPlaces(appt)}</p> : !confirming ? (
        <fieldset className="ws-frozen" disabled={sending}>
          <div className="rx-form-row">
            <div className="j-field">
              <label htmlFor="desk-move-branch">{t('desk.branch')}</label>
              <select id="desk-move-branch" value={branchId} onChange={(e) => { setBranchId(e.target.value); setSlotId(''); }}>
                {places.map((b) => <option key={b._id} value={b._id}>{b.name}</option>)}
              </select>
            </div>
            <TextField label={t('desk.move.newDay')} type="date" value={date} error={dateOk ? undefined : t('common.enterRealDate')} onChange={(e) => { setDate(e.target.value); setSlotId(''); }} />
          </div>
          {!dateOk ? null
            : slots.isPending ? <Loading label={t('desk.loadingSlots')} />
            : slots.isError ? <ErrorState message={messageOf(slots.error)} onRetry={() => void slots.refetch()} />
            : choices.length === 0 ? <p className="ws-muted">{noSlot(appt)}</p>
            : (
              <div className="j-field">
                <label htmlFor="desk-move-slot">{t('desk.move.newTime')}</label>
                <select id="desk-move-slot" value={slotId} aria-invalid={fieldError ? true : undefined} aria-describedby={fieldError ? 'desk-move-slot-err' : undefined}
                  onChange={(e) => setSlotId(e.target.value)}>
                  <option value="">{t('desk.move.chooseATime')}</option>
                  {choices.map((s) => <option key={s.slotId} value={s.slotId}>{slotOption(s)}</option>)}
                </select>
                {fieldError && <span id="desk-move-slot-err" className="j-field__error">{fieldError}</span>}
              </div>
            )}
        </fieldset>
      ) : (
        <div className="confirm-text">
          {t(appt.arrivedAt ? 'desk.move.confirmArrived' : 'desk.move.confirm', { name: patientName(appt), from: appointmentLabel(appt), to: when, branch: target?.name ?? '' })}
        </div>
      )}
      {error && <Alert>{t('desk.move.failed', { reason: error })}</Alert>}
      <div className="confirm-actions">
        {!confirming ? <Button type="submit" disabled={choices.length === 0 || places.length === 0}>{t('common.continue')}</Button>
          : <Button busy={sending} disabled={disabled && !sending} onClick={() => void move()}>{t('desk.move.send')}</Button>}
        <Button variant="ghost" disabled={sending} onClick={() => (confirming ? setConfirming(false) : setOpen(false))}>{shared('action.back')}</Button>
      </div>
    </form>
  );
}

/** A free slot: "09:00–09:30 (2 free)". */
const slotOption = (s: DeskSlot) => t('desk.slotOption', { start: clock(s.startTime), end: clock(s.endTime), free: s.seatsLeft });
const noPlaces = (a: ClinicAppointment) => (a.doctorName == null ? t('desk.move.noPlacesUnnamed') : t('desk.move.noPlaces', { doctor: a.doctorName }));
const noSlot = (a: ClinicAppointment) => (a.doctorName == null ? t('desk.move.noSlotUnnamed') : t('desk.move.noSlot', { doctor: a.doctorName }));

/** Q14: a free slot of the same doctor at a branch of this clinic in scope (any day), for the one move of a desk no-show. */
function DeskSlotPicker({ ctx, clinic, appt, doctors, branches, now, onChoose }: {
  ctx: ScopeContext; clinic: ClinicApi; appt: ClinicAppointment; doctors: ClinicDoctorRow[]; branches: Branch[]; now: Date; onChoose: (t: NoShowTarget | null) => void;
}) {
  const doctor = doctors.find((d) => d.doctorId === appt.doctorId);
  const places = branches.filter((b) => (doctor ? doctor.active && (doctor.branchIds.length === 0 || doctor.branchIds.includes(b._id)) : b._id === appt.branchId));
  const [branchId, setBranchId] = useState(() => (places.some((b) => b._id === appt.branchId) ? appt.branchId! : places[0]?._id ?? ''));
  const [date, setDate] = useState(() => istDateOf(now));
  const [slotId, setSlotId] = useState('');
  const dateOk = isRealDate(date);
  const slots = useQuery({
    queryKey: [...ctx.key, 'clinic-slots', appt.doctorId, branchId, date], enabled: !!branchId && dateOk,
    queryFn: () => clinic.deskSlots({ doctorId: appt.doctorId, branchId, date }),
  });
  const choices = (slots.data ?? []).filter((s) => s.slotId !== appt.slotId);
  const pick = (id: string) => {
    setSlotId(id);
    const s = choices.find((x) => x.slotId === id);
    const b = places.find((x) => x._id === branchId);
    onChoose(s ? { slotId: s.slotId, label: t('desk.noShowTarget', { day: formatDay(s.date), time: clock(s.startTime), branch: b?.name ?? t('desk.theClinic') }),
      from: { day: appointmentDay(appt.bookingDate) ?? '', branchId: appt.branchId, doctorId: appt.doctorId } } : null);
  };
  if (places.length === 0) return <p className="ws-muted">{noPlaces(appt)}</p>;
  return (
    <>
      <div className="rx-form-row">
        <div className="j-field">
          <label htmlFor="desk-noshow-branch">{t('desk.branch')}</label>
          <select id="desk-noshow-branch" value={branchId} onChange={(e) => { setBranchId(e.target.value); pick(''); }}>
            {places.map((b) => <option key={b._id} value={b._id}>{b.name}</option>)}
          </select>
        </div>
        <TextField label={t('desk.move.newDay')} type="date" value={date} error={dateOk ? undefined : t('common.enterRealDate')} onChange={(e) => { setDate(e.target.value); pick(''); }} />
      </div>
      {!dateOk ? null
        : slots.isPending ? <Loading label={t('desk.loadingSlots')} />
        : slots.isError ? <ErrorState message={messageOf(slots.error)} onRetry={() => void slots.refetch()} />
        : choices.length === 0 ? <p className="ws-muted">{noSlot(appt)}</p>
        : (
          <div className="j-field">
            <label htmlFor="desk-noshow-slot">{t('desk.move.newTime')}</label>
            <select id="desk-noshow-slot" value={slotId} onChange={(e) => pick(e.target.value)}>
              <option value="">{t('desk.move.chooseATime')}</option>
              {choices.map((s) => <option key={s.slotId} value={s.slotId}>{slotOption(s)}</option>)}
            </select>
          </div>
        )}
    </>
  );
}
