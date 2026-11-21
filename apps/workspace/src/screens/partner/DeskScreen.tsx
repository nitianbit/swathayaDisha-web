import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import {
  addDays, ApiError, appointmentAt, appointmentDay, canonicalMobile, CLINIC_APPOINTMENT_STATUS_LABEL, clinicBranchesFor, DESK_GENDERS, DESK_RELATIONS,
  deskActions, deskBookingProblems, doctorsAtBranch, familyMemberProblems, holdsAny, INVOICE_STATE_LABEL, isRealDate, istDateOf, MAX_APPOINTMENTS,
  MAX_DESK_CANCEL_REASON, MAX_DESK_NAME, MAX_DESK_NOTES, MAX_FAMILY_NAME, noShowMovedOnce,
  type Branch, type ClinicAppointment, type ClinicDoctorRow, type DeskAction, type DeskActionOffer, type DeskAppointment, type DeskBookingResult,
  type DeskGender, type DeskPatientInput, type DeskRelation, type DeskSlot, type DeskSlotKnown,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, formatRupees, Loading, TextArea, TextField } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { NoShowMove, noShowMoveSlot, type NoShowMoveOp, type NoShowTarget } from '../../components/NoShowMove.tsx';
import { PendingOpPanel } from '../../components/PendingOpPanel.tsx';
import { messageOf } from '../../errors.ts';
import { afterFailure, beginAttempt, keyedLookup, newRequestKey, ownsKey, resolveStored, startOp, stillCurrent, wasAbandoned } from '../../requests.ts';
import { useSession, type SessionMemory } from '../../session.tsx';
import { billPrefillSlot, type BillHandover, type BillPrefill } from './billing.tsx';
import {
  appointmentLabel, appointmentTone, ClinicOnly, clinicLink, istTime, useClinicApi, useDoctorList, type ClinicApi,
} from './clinic.tsx';
import { deskBookingSlot, type DeskPending, type DeskPendingBody } from './desk.ts';
import { formatDay, useNow } from './labs.tsx';
import { NoSuchPartner, PartnerPageHeading, scopeIdentity, useBranches, usePartnerScope, useWorkspacePartner, type ScopeContext } from './scope.tsx';

/** A slot or booking time as stored ("HH:mm" or "h:mm AM") shown as India time "HH:MM". */
const clock = (raw: string) => {
  const at = appointmentAt({ bookingDate: '20000101', bookingTime: raw });
  return at ? istTime(at) : raw;
};
const BILL_READERS = ['invoices.create', 'invoices.cancel', 'payments.record', 'finance.view'] as const;
const NO_MONEY = 'Nothing is charged or refunded through Jansetu: desk appointments are paid at the clinic.';
/** Q13 409 BOOKING_CHANGED: the step named the version the person saw, and the appointment had changed since. */
const isChanged = (err: unknown) => err instanceof ApiError && err.status === 409 && err.code === 'BOOKING_CHANGED';
/** Q16d (`closeDeskAppointment`): 409 NOT_STARTED_YET — a visit is marked as seen on the appointment's own day or later. */
const NOT_STARTED = 'It is not the day of this appointment yet, so it was not marked as seen. Mark it on the day of the appointment.';
/** Q16d: 409 APPOINTMENT_NOT_STARTED — a no-show 15 minutes after the time; in a session with several patients, after its end. */
const NO_SHOW_TOO_EARLY = 'It is too early to mark a no-show: wait until 15 minutes after the appointment time (in a session with several patients, 15 minutes after the session ends).';
const readable = (err: unknown) => (err instanceof ApiError && err.status === 409 && err.code === 'NOT_STARTED_YET'
  ? new ApiError(409, NOT_STARTED, 'NOT_STARTED_YET')
  : err instanceof ApiError && err.status === 409 && err.code === 'APPOINTMENT_NOT_STARTED' ? new ApiError(409, NO_SHOW_TOO_EARLY, 'APPOINTMENT_NOT_STARTED') : err);
const CHANGED = 'The appointment changed since you opened it (someone else updated it), so nothing was done. It has been read again: check it and try again.';
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
  return (
    <>
      <PartnerPageHeading ctx={ctx} title="Front desk" partnerName={partner.data?.name}>
        Appointments with the clinic’s doctors by day (India time), desk and online. Desk appointments are in person and
        paid at the clinic.
      </PartnerPageHeading>
      <ClinicOnly ctx={ctx}><DeskDay ctx={ctx} /></ClinicOnly>
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

function DeskDay({ ctx }: { ctx: ScopeContext }) {
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
      throw new ApiError(409, 'Another step on this appointment is still running. Wait for it to finish, then try again.', 'STEP_IN_FLIGHT');
    }
    inFlight.current.add(id);
    setBusy((b) => ({ ...b, [id]: action }));
    if (selectedRef.current === id) { setStepNotice(null); setStepFailure(null); }
    try {
      return await run();
    } catch (err) {
      // Q13: refused because the appointment moved on since it was shown; the re-read below shows it as it is now.
      if (isChanged(err) && mounted.current && selectedRef.current === id) setStepFailure({ id, text: CHANGED });
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
      if (mounted.current && selectedRef.current === a.bookingId) setStepFailure({ id: a.bookingId, text: isChanged(err) ? CHANGED : `${what}: ${messageOf(err)}` });
    });

  // ── Booking: once only, with the server's request key; an unknown outcome locks the form ──
  const slotKey = deskBookingSlot(scopeIdentity(ctx));
  const [pending, setPendingState] = useState<DeskPending | undefined>(() => memory.get<DeskPending>(slotKey));
  const [sending, setSending] = useState(false);
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const [patient, setPatient] = useState<Patient>(NO_PATIENT);
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
    branchName: op.body?.shown.branchName ?? branchNames.get(b.branchId ?? '') ?? 'the clinic',
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
        closeWith(attempt, 'This booking was given up earlier, so it was not made and never will be. Book the patient again if needed.');
        return;
      }
      // Customer linking is checked before anything is written; on a first attempt that refusal is definite too.
      const linkingOff = err instanceof ApiError && err.code === 'CUSTOMER_LINKING_UNAVAILABLE' && attempt.attempts === 1 && !attempt.uncertain;
      const next = linkingOff ? null : afterFailure(attempt, err, messageOf(err));
      if (mounted.current) {
        setPending(next ?? undefined);
        if (!next) {
          const slotGone = err instanceof ApiError && !!err.code && slotGoneCodes.has(err.code);
          setRefused(slotGone ? `${messageOf(err)}. Choose another time; the patient’s details are kept.` : messageOf(err));
          if (slotGone) setChosen(null);
        }
      } else if (next) memory.set(slotKey, next); else memory.delete(slotKey);
    } finally {
      if (mounted.current) setSending(false);
    }
  }


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
    setStepNotice({ id: selected, text: 'The no-show has been moved to a new time (it can be moved only once): it is no longer on this day. Nothing more to do.' });
  }, [selected, current, list.isSuccess, list.isFetching, list.dataUpdatedAt, day, branch?._id, doctor?.doctorId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (branches.isPending || doctors.isPending) return <Loading label="Loading the front desk…" />;
  if (branches.isError) return <ErrorState message={messageOf(branches.error)} onRetry={() => void branches.refetch()} />;
  if (doctors.isError) return <ErrorState message={messageOf(doctors.error)} onRetry={() => void doctors.refetch()} />;
  if (offered.length === 0) {
    return (
      <Empty title="No branch for consultations">
        Desk appointments are made at branches that take in-clinic consultations. {ctx.actor.role === 'owner' ? 'Turn that on for a branch under Branches.' : 'None of your branches takes them.'}
      </Empty>
    );
  }

  return (
    <>
      {pending && !(sending && pending.attempts === 1 && !pending.uncertain) && (
        <PendingOpPanel key={pending.attempts} label="Unconfirmed booking" op={pending} busy={sending} onResend={() => void send(pending)}
          // Q13: the exact appointment this desk member's key booked (`GET /clinic/appointments/by-key/:key`), also after a reload.
          fetchPage={keyedLookup(pending.requestKey, () => clinic.appointmentByKey(pending.requestKey))}
          onFound={(b) => settled(viewOf(b, pending, { replayed: true }), pending, true)}
          // Q13: decided by the server: `abandoned` = it can never be booked; `used` = here it is (or it is no longer in your branches).
          abandon={async () => {
            const r = await clinic.abandonBookingKey(pending.requestKey);
            if (r.state === 'used' && !r.booking) {
              closeWith(pending, 'The earlier booking was made, but the appointment is no longer at one of your branches (it was moved). Nothing more to do here.');
            }
            return { state: r.state, record: r.booking ? { ...r.booking, requestKey: pending.requestKey } : undefined };
          }}
          abandonWhenNotFound abandonLabel="Give up this booking"
          onDiscard={() => closeWith(pending, 'The unconfirmed booking was given up: it can never be made. You can book the patient again now.')}
          summary={pending.restored || !pending.body ? null : <PendingBookingSummary body={pending.body} />} />
      )}
      {gaveUp && !pending && <Alert tone="ok">{gaveUp}</Alert>}
      {receipt && <Receipt ctx={ctx} receipt={receipt} memory={memory} row={rows.find((r) => r.bookingId === receipt.booking.bookingId)} />}

      <div className="ws-search">
        <div className="j-field ws-filter">
          <label htmlFor="desk-branch">Branch</label>
          <select id="desk-branch" value={branch?._id ?? ''} onChange={(e) => { setBranchChoice(e.target.value); setDoctorChoice(''); setChosen(null); }}>
            {offered.map((b) => <option key={b._id} value={b._id}>{b.name}</option>)}
          </select>
        </div>
        <TextField label="Day" type="date" value={day} error={dayOk ? undefined : 'Enter a real date.'} onChange={(e) => { setDay(e.target.value); setChosen(null); }} />
        <div className="j-field ws-filter">
          <label htmlFor="desk-doctor">Doctor</label>
          <select id="desk-doctor" value={doctor?.doctorId ?? ''} onChange={(e) => { setDoctorChoice(e.target.value); setChosen(null); }}>
            <option value="">All doctors</option>
            {here.map((d) => <option key={d.doctorId} value={d.doctorId}>{d.name}{d.specialization ? ` (${d.specialization})` : ''}</option>)}
          </select>
        </div>
      </div>
      <div className="ws-actions">
        <Button variant="secondary" disabled={!dayOk} onClick={() => { setDay(addDays(day, -1)); setChosen(null); }}>Previous day</Button>
        <Button variant="secondary" onClick={() => { setDay(istDateOf(new Date())); setChosen(null); }}>Today</Button>
        <Button variant="secondary" disabled={!dayOk} onClick={() => { setDay(addDays(day, 1)); setChosen(null); }}>Next day</Button>
      </div>

      <section className="ws-section" aria-labelledby="desk-appts-h">
        <h2 id="desk-appts-h">Appointments{dayOk ? ` on ${formatDay(day)}` : ''}</h2>
        {stepNotice && stepNotice.id === selected && <Alert tone="ok">{stepNotice.text}</Alert>}
        {!dayOk ? null
          : list.isPending ? <Loading label="Loading appointments…" />
          : list.isError ? <ErrorState message={messageOf(list.error)} onRetry={() => void list.refetch()} />
          : rows.length === 0 ? <Empty title="No appointments">No appointment {doctor ? `with ${doctor.name} ` : ''}at {branch!.name} on this day.</Empty>
          : (
            <>
              {rows.length >= MAX_APPOINTMENTS && <p className="ws-count">The first {MAX_APPOINTMENTS}; choose a doctor to see the rest.</p>}
              <div className="ws-table-wrap">
                <table className="j-table">
                  <caption className="j-sr-only">Appointments on {formatDay(day)}</caption>
                  <thead><tr><th scope="col">Time</th><th scope="col">Patient</th><th scope="col">Doctor</th><th scope="col">Booked</th><th scope="col">Status</th><th scope="col">Bill</th><th scope="col">Details</th></tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.bookingId} aria-current={r.bookingId === selected ? 'true' : undefined}>
                        <td>{clock(r.bookingTime)}</td>
                        <td>{patientName(r)}{r.patient?.relationship ? <div className="ws-muted">{familyLine(r)}</div> : null}{r.patient?.phone ? <div className="ws-muted">{r.patient.phone}</div> : null}</td>
                        <td>{r.doctorName ?? '—'}</td>
                        <td>{r.source === 'desk' ? 'At the desk' : r.paidOnline ? 'Online, paid' : 'Online'}</td>
                        <td>
                          <Badge tone={appointmentTone(r.status)}>{CLINIC_APPOINTMENT_STATUS_LABEL[r.status] ?? r.status}</Badge>
                          {r.arrivedAt && r.status === 'confirmed' && <> <Badge tone="ok">Arrived {istTime(r.arrivedAt)}</Badge></>}
                          {busy[r.bookingId] && <div className="ws-muted">Saving…</div>}
                        </td>
                        <td><BillCell ctx={ctx} appt={r} memory={memory} branchName={branchNames.get(r.branchId ?? '') ?? ''} /></td>
                        <td>
                          <Button variant="ghost" aria-label={`Open ${patientName(r)} at ${clock(r.bookingTime)}`}
                            onClick={() => { setSelected(r.bookingId); setStepNotice(null); setStepFailure(null); }}>Open</Button>
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
          branchName={branchNames.get(current.branchId ?? '') ?? 'this clinic'} now={now} busy={busy[current.bookingId]} reading={list.isFetching}
          failure={stepFailure?.id === current.bookingId ? stepFailure.text : null}
          perform={perform} guard={guard} click={click} onClose={() => setSelected(null)} readAt={list.dataUpdatedAt} memory={memory}
          onMoveNotice={(text) => { if (mounted.current && selectedRef.current === current.bookingId) { setStepFailure(null); setStepNotice({ id: current.bookingId, text }); } }}
          onMoveFailure={(text) => { if (mounted.current && selectedRef.current === current.bookingId) { setStepNotice(null); setStepFailure({ id: current.bookingId, text }); } }}
          onMoved={moved} slotKnown={sessionOf(current, slots.data)} />
      )}

      <section className="ws-section" aria-labelledby="desk-slots-h">
        <h2 id="desk-slots-h">Free slots{doctor ? ` of ${doctor.name}` : ''}</h2>
        {manage && locked && <Alert tone="warn">Settle the unconfirmed booking above before booking another.</Alert>}
        {here.length === 0 ? <Empty title="No doctor here">No active doctor consults at {branch!.name}. Our admin team adds doctors to your clinic (<Link to={clinicLink(ctx, 'clinic-doctors')}>Doctors</Link>).</Empty>
          : !doctor ? <p className="ws-muted">Choose a doctor to see their free in-clinic slots{manage ? ' and book one' : ''}.</p>
          : !dayOk ? null
          : slots.isPending ? <Loading label="Loading free slots…" />
          : slots.isError ? <ErrorState message={messageOf(slots.error)} onRetry={() => void slots.refetch()} />
          : (slots.data ?? []).length === 0 ? <Empty title="No free slots">{doctor.name} has no free in-clinic slot at {branch!.name} on this day.</Empty>
          : (
            <>
              {!manage && <p className="ws-muted">Booking needs the “Manage bookings” permission.</p>}
              <div className="ws-table-wrap">
                <table className="j-table">
                  <caption className="j-sr-only">Free slots of {doctor.name} on {formatDay(day)}</caption>
                  <thead><tr><th scope="col">Time</th><th scope="col">Seats left</th>{manage && <th scope="col">Book</th>}</tr></thead>
                  <tbody>
                    {slots.data!.map((s) => {
                      // Q13: the server lists only slots that have not started (and refuses one that starts meanwhile).
                      return (
                        <tr key={s.slotId} aria-current={chosen?.slot.slotId === s.slotId ? 'true' : undefined}>
                          <td>{clock(s.startTime)}–{clock(s.endTime)}</td>
                          <td>{s.seatsLeft}</td>
                          {manage && (
                            <td>
                              <Button variant="secondary" disabled={locked || sending} aria-label={`Book ${clock(s.startTime)}`}
                                onClick={() => { setChosen({ slot: s, doctor, branch: branch! }); setRefused(null); setReceipt(null); }}>Book</Button>
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
        {manage && refused && !chosen && <Alert>Not booked: {refused}</Alert>}
      </section>

      {manage && chosen && !(pending && !(sending && pending.attempts === 1 && !pending.uncertain)) && (
        <BookingForm chosen={chosen} patient={patient} setPatient={setPatient} sending={sending} refused={refused}
          onCancel={() => { setChosen(null); setRefused(null); }}
          onBook={(request) => {
            const requestKey = newRequestKey();
            const body: DeskPendingBody = {
              request: { ...request, requestKey },
              shown: { doctorName: chosen.doctor.name, doctorId: chosen.doctor.doctorId, branchName: chosen.branch.name, branchId: chosen.branch._id,
                day: chosen.slot.date, time: clock(chosen.slot.startTime) },
            };
            void send(startOp(requestKey, body));
          }} />
      )}
    </>
  );
}

const patientName = (r: Pick<ClinicAppointment, 'patient'>) => r.patient?.name || 'Name not given';
/** Q14: who is being seen, when it is a family member: "Mother of Kiran Shah". */
const familyLine = (r: Pick<ClinicAppointment, 'patient'>) =>
  r.patient?.relationship ? `${r.patient.relationship} of ${r.patient.accountName ?? 'the account holder'}` : '';
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
  const who = receipt.family?.name ?? receipt.who;
  return (
    <Alert tone="ok">
      {receipt.replayed ? 'This booking had already been made; nothing was booked twice. ' : 'Booked. '}
      {who ?? 'The patient'}{receipt.family?.relationship ? ` (${receipt.family.relationship})` : ''} with {receipt.doctorName ?? 'the doctor'} on {appointmentLabel(b)} at {receipt.branchName}.
      {' '}Fee {formatRupees(b.fee ?? 0)}, paid at the clinic.
      {receipt.created ? ' A Jansetu account was created for this mobile number.' : ''}
      {' '}The patient and the doctor are notified.
      {' '}{row?.patient?.phone ? <BillLink ctx={ctx} memory={memory} prefill={prefillOf(row)} />
        : holdsAny(ctx.actor, ['invoices.create']) ? 'Make its bill with “Create bill” on its row in the day list.' : null}
    </Alert>
  );
}

/** The booking held while its outcome is unknown (session memory only; never stored or put in a URL). */
function PendingBookingSummary({ body }: { body: DeskPendingBody }) {
  const { request, shown } = body;
  return (
    <div>
      {familyOf(body) ? `${familyOf(body)}, family member of ${request.customer.phone}` : request.customer.name ? `${request.customer.name} (${request.customer.phone})` : request.customer.phone} with {shown.doctorName} on {formatDay(shown.day)}, {shown.time} at {shown.branchName}.
    </div>
  );
}

/**
 * Q14: the new-bill form for this visit, prefilled with the patient, doctor, branch and appointment (handed over in
 * session memory only, never in the URL), or the bills list for other bill readers.
 */
function BillLink({ ctx, memory, prefill, label = 'Make a bill for this visit' }: { ctx: ScopeContext; memory: SessionMemory; prefill: BillPrefill; label?: string }) {
  const navigate = useNavigate();
  if (holdsAny(ctx.actor, ['invoices.create'])) {
    const to = `${ctx.link('invoices')}/new`;
    return (
      <Link to={to} onClick={(e) => {
        // A modified click opens another tab (its own session memory): nothing is handed over, the form starts empty.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        // Bound to this navigation: the form takes it only when the route state names this token, once.
        const token = newRequestKey();
        memory.set(billPrefillSlot(scopeIdentity(ctx)), { token, prefill } satisfies BillHandover);
        navigate(to, { state: { prefillToken: token } });
      }}>{label}</Link>
    );
  }
  if (holdsAny(ctx.actor, BILL_READERS)) return <Link to={ctx.link('invoices')}>Bills</Link>;
  return null;
}

/** Q14: the bill's customer is the appointment's account holder (409 APPOINTMENT_CUSTOMER_MISMATCH otherwise), not a family member. */
const prefillOf = (a: ClinicAppointment): BillPrefill => ({
  appointmentId: a.bookingId, branchId: a.branchId ?? '', doctorId: a.doctorId,
  name: (a.patient?.relationship ? a.patient.accountName : a.patient?.name) ?? '', phone: a.patient?.phone ?? '',
  label: `${a.doctorName ?? 'the doctor'}, ${appointmentLabel(a)}`,
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
        ? <Link to={`${ctx.link('invoices')}/${bill.invoiceId}`} aria-label={`Bill ${bill.serial}, ${INVOICE_STATE_LABEL[bill.state] ?? bill.state}`}>{bill.serial}</Link>
        : <span>{bill.serial}</span>)}
      {bill && <div className="ws-muted">{INVOICE_STATE_LABEL[bill.state] ?? bill.state}</div>}
      {!open && appt.source === 'desk' && appt.status !== 'cancelled' && holdsAny(ctx.actor, ['invoices.create']) && (
        <div><BillLink ctx={ctx} memory={memory} prefill={prefillOf(appt)} label="Create bill" /><span className="j-sr-only"> for {patientName(appt)} at {branchName}</span></div>
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
      <h2 id="desk-book-h">Book {chosen.doctor.name} at {when}</h2>
      <p className="ws-muted">In person at {chosen.branch.name} (desk appointments are always in person). For a walk-in or a phone call.</p>
      <form className="rx-form" noValidate onSubmit={review}>
        <fieldset className="ws-frozen" disabled={sending}>
          <div className="rx-form-row">
            <TextField label="Patient’s mobile number" inputMode="tel" value={patient.phone} error={errors.phone} onChange={(e) => set({ phone: e.target.value })}
              hint="The appointment is made for the Jansetu account of this number; one is created if there is none." />
            <TextField label={patient.forFamily ? 'Account holder’s name (optional)' : 'Patient’s name (optional)'} value={patient.name} maxLength={MAX_DESK_NAME} error={errors.name} onChange={(e) => set({ name: e.target.value })}
              hint="Saved only if the account has no name yet; an existing account is never changed." />
          </div>
          <fieldset className="ws-checks">
            <legend>Who is seen</legend>
            <label className="ws-check"><input type="radio" name="desk-who" checked={!patient.forFamily} onChange={() => set({ forFamily: false })} /> The account holder (the person with this mobile number)</label>
            <label className="ws-check"><input type="radio" name="desk-who" checked={patient.forFamily} onChange={() => set({ forFamily: true })} /> A family member of the account holder</label>
          </fieldset>
          {patient.forFamily && (
            <div className="rx-form-row">
              <TextField label="Family member’s name" value={patient.familyName} maxLength={MAX_FAMILY_NAME} error={errors.familyName}
                onChange={(e) => set({ familyName: e.target.value })}
                hint="If the account already has a family member with this name and relation, that one is used; otherwise they are added to the account." />
              <div className="j-field">
                <label htmlFor="desk-relation">Relation to the account holder</label>
                <select id="desk-relation" value={patient.relation} aria-invalid={errors.relation ? true : undefined} aria-describedby={errors.relation ? 'desk-relation-err' : undefined}
                  onChange={(e) => set({ relation: e.target.value as DeskRelation })}>
                  <option value="">Choose</option>
                  {DESK_RELATIONS.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
                {errors.relation && <span id="desk-relation-err" className="j-field__error">{errors.relation}</span>}
              </div>
              <div className="j-field">
                <label htmlFor="desk-gender">Gender (optional)</label>
                <select id="desk-gender" value={patient.gender} onChange={(e) => set({ gender: e.target.value as DeskGender })}>
                  <option value="">Not given</option>
                  {DESK_GENDERS.map((g) => <option key={g} value={g}>{g}</option>)}
                </select>
              </div>
              <TextField label="Date of birth (optional)" type="date" max={today} value={patient.dateOfBirth} error={errors.dateOfBirth} onChange={(e) => set({ dateOfBirth: e.target.value })} />
            </div>
          )}
          <TextArea label="Notes for the clinic (optional)" value={patient.notes} maxLength={MAX_DESK_NOTES} error={errors.notes} onChange={(e) => set({ notes: e.target.value })} />
        </fieldset>
        {refused && <Alert>Not booked: {refused}</Alert>}
        {!reviewing ? (
          <div className="rx-actions">
            <Button type="submit">Review the booking</Button>
            <Button variant="ghost" onClick={onCancel}>Back</Button>
          </div>
        ) : (
          <div className="confirm" role="group" aria-label="Book the appointment">
            <div className="confirm-text">
              {seen && 'name' in seen
                ? <>Book {seen.name} ({seen.relation} of the account holder of {canonicalMobile(patient.phone)}) with {chosen.doctor.name} on {when} at {chosen.branch.name}?</>
                : <>Book {name || canonicalMobile(patient.phone)}{name ? ` (${canonicalMobile(patient.phone)})` : ''} with {chosen.doctor.name} on {when} at {chosen.branch.name}?</>}
              {fee ? ` The fee of ${formatRupees(fee)} is paid at the clinic.` : ' The fee is paid at the clinic.'}
              {' '}The patient and the doctor will be notified.
              {' '}It is booked once: if the answer is lost, the same booking can be sent again safely.
            </div>
            <div className="confirm-actions">
              <Button busy={sending} onClick={() => {
                const notes = patient.notes.trim();
                onBook({ slotId: chosen.slot.slotId, customer: { phone: canonicalMobile(patient.phone)!, ...(name ? { name } : {}) }, ...(seen ? { patient: seen } : {}), ...(notes ? { notes } : {}) });
              }}>Book appointment</Button>
              <Button variant="ghost" disabled={sending} onClick={() => setReviewing(false)}>Back to the details</Button>
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
      <h2 id="desk-appt-h">Appointment: {who}, {when}</h2>
      <dl className="ws-dl">
        <dt>Patient</dt>
        <dd>{who}{appt.patient?.relationship ? ` (${familyLine(appt)})` : ''}</dd>
        {appt.patient?.phone && <><dt>Mobile</dt><dd>{appt.patient.phone}</dd></>}
        <dt>Doctor</dt><dd>{appt.doctorName ?? '—'}</dd>
        <dt>When</dt><dd>{when} (India time) · {branchName}</dd>
        <dt>Booked</dt><dd>{appt.source === 'desk' ? 'At the desk, in person' : `Online in the Jansetu app${appt.consultationMode ? ` (${appt.consultationMode})` : ''}`}</dd>
        <dt>Payment</dt>
        <dd>{appt.source === 'desk' ? `Paid at the clinic · fee ${formatRupees(appt.fee ?? 0)}` : appt.paidOnline ? `Paid online (${formatRupees(appt.fee ?? 0)})` : 'Not paid online'}</dd>
        <dt>Status</dt>
        <dd>
          <Badge tone={appointmentTone(appt.status)}>{CLINIC_APPOINTMENT_STATUS_LABEL[appt.status] ?? appt.status}</Badge>
          {appt.arrivedAt && appt.status === 'confirmed' && <> Arrived at {istTime(appt.arrivedAt)}</>}
        </dd>
      </dl>
      {appt.bill && (
        <p>Bill: {holdsAny(ctx.actor, BILL_READERS) ? <Link to={`${ctx.link('invoices')}/${appt.bill.invoiceId}`}>{appt.bill.serial}</Link> : appt.bill.serial} · {INVOICE_STATE_LABEL[appt.bill.state] ?? appt.bill.state}</p>
      )}
      {failure && <Alert>{failure}</Alert>}
      {appt.status === 'no_show' && appt.source === 'desk' && (
        <p className="ws-muted">
          Did not come. Nothing is charged or refunded through Jansetu, and the doctor earns nothing for it.
          {movedOnce === true ? ' It was already moved once after an earlier no-show, so this second no-show is final: it cannot be moved again.'
            : movedOnce === false ? ' The desk may move it once to a new time.'
            : ' The desk may move it once to a new time, unless it was already moved after an earlier no-show (then this second no-show is final).'}
        </p>
      )}
      {showMove && (
        <div className="ws-actions">
          <NoShowMove<DeskAppointment & { replayed?: boolean }> slot={moveSlot} who={who} missed={when} state="offer" status={appt.status} readAt={readAt} reading={reading} disabled={busy !== undefined || reading} version={appt.updatedAt}
            consequence={<>The seat moves now; the patient and the doctor are notified of the new time.</>}
            picker={(choose) => <DeskSlotPicker ctx={ctx} clinic={clinic} appt={appt} doctors={doctors} branches={branches} now={now} onChoose={choose} />}
            send={(t: NoShowTarget, requestKey) => guard(appt, 'reschedule_no_show', () => clinic.rescheduleNoShow(appt.bookingId, t.slotId, requestKey, typeof t.version === 'string' ? t.version : undefined))}
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
              onClick={() => void click(appt, 'arrived', 'Not marked arrived', () => clinic.arrived(appt.bookingId, appt.updatedAt), () => `${who} is marked as arrived.`)}>
              Mark arrived
            </Button>
          )}
          {offer('complete') && (offer('complete')!.blocked ? (
            <div className="ws-action">
              <Button disabled>Mark as seen</Button>
              <span className="ws-muted">{offer('complete')!.blocked}</span>
            </div>
          ) : (
            <ConfirmAction label="Mark as seen" disabled={disabled} confirmLabel="Mark as seen"
              consequence={<>Mark {who}’s visit with {appt.doctorName ?? 'the doctor'} as seen? The appointment ends here and the doctor’s time is freed. The fee of {formatRupees(appt.fee ?? 0)} is paid at the clinic: make a bill for it under Bills.</>}
              onConfirm={() => perform(appt, 'complete', () => clinic.complete(appt.bookingId, appt.updatedAt), () => `${who}’s visit is marked as seen.`)
                .catch((err: unknown) => { throw readable(err); })} />
          ))}
          {offer('no_show') && <NoShow appt={appt} offer={offer('no_show')!} who={who} when={when} disabled={disabled} perform={perform} clinic={clinic} movedOnce={movedOnce} />}
          {offer('reschedule') && (
            <Reschedule ctx={ctx} clinic={clinic} appt={appt} doctors={doctors} branches={branches} now={now} disabled={disabled} perform={perform} />
          )}
          {offer('cancel') && (
            <ConfirmAction label="Cancel appointment" danger disabled={disabled} reason="optional" reasonLabel="Reason" maxReason={MAX_DESK_CANCEL_REASON}
              confirmLabel="Cancel appointment"
              consequence={<>Cancel {who}’s appointment with {appt.doctorName ?? 'the doctor'} on {when}? The seat and the doctor’s time are freed at once. No money moves: desk appointments are paid at the clinic, so nothing was taken online (if a bill was issued for this visit, cancel it under Bills). Without a reason, “Cancelled by the clinic” is recorded. This cannot be undone.</>}
              onConfirm={(reason) => perform(appt, 'cancel', () => clinic.cancel(appt.bookingId, reason, appt.updatedAt), () => `${who}’s appointment is cancelled.`)} />
          )}
        </div>
      ) : showMove ? null : appt.source === 'online' ? (
        <p className="ws-muted">Booked online in the Jansetu app. The clinic can view it; the doctor or the patient makes any change.</p>
      ) : !finished && !holdsAny(ctx.actor, ['bookings.manage']) ? (
        <p className="ws-muted">You can view this appointment; the steps need the “Manage bookings” permission.</p>
      ) : null}
      <div className="ws-actions">
        {appt.source === 'desk' && appt.status !== 'cancelled' && (!appt.bill || appt.bill.state === 'cancelled') && (
          <BillLink ctx={ctx} memory={memory} prefill={prefillOf(appt)} />
        )}
        <Button variant="ghost" onClick={onClose}>Close</Button>
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
        <Button variant="secondary" disabled>Mark did not come</Button>
        <span className="ws-muted">{offer.blocked}</span>
      </div>
    );
  }
  return (
    <ConfirmAction label="Mark did not come" danger disabled={disabled} confirmLabel="Mark did not come"
      consequence={<>Mark {who} as not come for {when}? The appointment ends and the doctor’s time is freed. {NO_MONEY}{' '}
        {/* WQ11b: never promise a move the server refuses (a booking moves once after a no-show; a second no-show is final). */}
        {movedOnce === true ? 'It was already moved once after an earlier no-show, so this second no-show is final: it cannot be moved to a new time. '
          : movedOnce === false ? 'Afterwards the desk may move it once to a new time. '
          : 'Afterwards the desk may move it once to a new time, unless it was already moved after an earlier no-show: then this second no-show is final. '}
        This cannot be undone.</>}
      onConfirm={() => perform(appt, 'no_show', () => clinic.noShow(appt.bookingId, appt.updatedAt), () => `${who} is marked as not come.`)
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

  if (!open) return <Button variant="secondary" disabled={disabled} onClick={() => setOpen(true)}>Move to another time</Button>;

  const choices = (slots.data ?? []).filter((s) => s.slotId !== appt.slotId);
  const picked = choices.find((s) => s.slotId === slotId);
  const target = places.find((b) => b._id === branchId);
  const when = picked ? `${formatDay(picked.date)}, ${clock(picked.startTime)}` : '';

  function review(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!picked) { setFieldError('Choose the new time.'); return; }
    setFieldError(null);
    setConfirming(true);
  }

  async function move() {
    if (!picked) return;
    setSending(true);
    setError(null);
    try {
      await perform(appt, 'reschedule', () => clinic.reschedule(appt.bookingId, picked.slotId, appt.updatedAt),
        (n) => `Moved to ${appointmentLabel(n)} at ${target?.name ?? 'the clinic'}. The patient and the doctor are notified.`);
      setOpen(false);
    } catch (err) {
      // E.g. the slot was taken or has started meanwhile (409 SLOT_NOT_AVAILABLE / SLOT_STARTED): show the free slots
      // as they are now. A changed appointment (BOOKING_CHANGED) is said above the steps and the day is read again.
      setError(isChanged(err) ? CHANGED : messageOf(err));
      setConfirming(false);
      void queryClient.invalidateQueries({ queryKey: slotsKey });
    } finally {
      setSending(false);
    }
  }

  return (
    <form className="confirm" noValidate onSubmit={review} aria-label="Move to another time">
      {places.length === 0 ? <p className="ws-muted">{appt.doctorName ?? 'This doctor'} does not consult at any branch you can book.</p> : !confirming ? (
        <fieldset className="ws-frozen" disabled={sending}>
          <div className="rx-form-row">
            <div className="j-field">
              <label htmlFor="desk-move-branch">Branch</label>
              <select id="desk-move-branch" value={branchId} onChange={(e) => { setBranchId(e.target.value); setSlotId(''); }}>
                {places.map((b) => <option key={b._id} value={b._id}>{b.name}</option>)}
              </select>
            </div>
            <TextField label="New day" type="date" value={date} error={dateOk ? undefined : 'Enter a real date.'} onChange={(e) => { setDate(e.target.value); setSlotId(''); }} />
          </div>
          {!dateOk ? null
            : slots.isPending ? <Loading label="Loading free slots…" />
            : slots.isError ? <ErrorState message={messageOf(slots.error)} onRetry={() => void slots.refetch()} />
            : choices.length === 0 ? <p className="ws-muted">No free slot of {appt.doctorName ?? 'this doctor'} on this day at this branch.</p>
            : (
              <div className="j-field">
                <label htmlFor="desk-move-slot">New time</label>
                <select id="desk-move-slot" value={slotId} aria-invalid={fieldError ? true : undefined} aria-describedby={fieldError ? 'desk-move-slot-err' : undefined}
                  onChange={(e) => setSlotId(e.target.value)}>
                  <option value="">Choose a time</option>
                  {choices.map((s) => <option key={s.slotId} value={s.slotId}>{clock(s.startTime)}–{clock(s.endTime)} ({s.seatsLeft} free)</option>)}
                </select>
                {fieldError && <span id="desk-move-slot-err" className="j-field__error">{fieldError}</span>}
              </div>
            )}
        </fieldset>
      ) : (
        <div className="confirm-text">
          Move {patientName(appt)} from {appointmentLabel(appt)} to {when} at {target?.name}? The new seat is taken and the old one freed at once.
          {appt.arrivedAt ? ' The check-in is cleared: mark them arrived again when they come.' : ''} The patient and the doctor are notified of the new time.
        </div>
      )}
      {error && <Alert>Not moved: {error}</Alert>}
      <div className="confirm-actions">
        {!confirming ? <Button type="submit" disabled={choices.length === 0 || places.length === 0}>Continue</Button>
          : <Button busy={sending} disabled={disabled && !sending} onClick={() => void move()}>Move the appointment</Button>}
        <Button variant="ghost" disabled={sending} onClick={() => (confirming ? setConfirming(false) : setOpen(false))}>Back</Button>
      </div>
    </form>
  );
}

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
    onChoose(s ? { slotId: s.slotId, label: `${formatDay(s.date)}, ${clock(s.startTime)} at ${b?.name ?? 'the clinic'}`,
      from: { day: appointmentDay(appt.bookingDate) ?? '', branchId: appt.branchId, doctorId: appt.doctorId } } : null);
  };
  if (places.length === 0) return <p className="ws-muted">{appt.doctorName ?? 'This doctor'} does not consult at any branch you can book.</p>;
  return (
    <>
      <div className="rx-form-row">
        <div className="j-field">
          <label htmlFor="desk-noshow-branch">Branch</label>
          <select id="desk-noshow-branch" value={branchId} onChange={(e) => { setBranchId(e.target.value); pick(''); }}>
            {places.map((b) => <option key={b._id} value={b._id}>{b.name}</option>)}
          </select>
        </div>
        <TextField label="New day" type="date" value={date} error={dateOk ? undefined : 'Enter a real date.'} onChange={(e) => { setDate(e.target.value); pick(''); }} />
      </div>
      {!dateOk ? null
        : slots.isPending ? <Loading label="Loading free slots…" />
        : slots.isError ? <ErrorState message={messageOf(slots.error)} onRetry={() => void slots.refetch()} />
        : choices.length === 0 ? <p className="ws-muted">No free slot of {appt.doctorName ?? 'this doctor'} on this day at this branch.</p>
        : (
          <div className="j-field">
            <label htmlFor="desk-noshow-slot">New time</label>
            <select id="desk-noshow-slot" value={slotId} onChange={(e) => pick(e.target.value)}>
              <option value="">Choose a time</option>
              {choices.map((s) => <option key={s.slotId} value={s.slotId}>{clock(s.startTime)}–{clock(s.endTime)} ({s.seatsLeft} free)</option>)}
            </select>
          </div>
        )}
    </>
  );
}
