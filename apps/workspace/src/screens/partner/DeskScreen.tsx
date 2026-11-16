import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  addDays, ApiError, appointmentAt, appointmentDay, canonicalMobile, CLINIC_APPOINTMENT_STATUS_LABEL, clinicBranchesFor, deskActions,
  deskBookingProblems, doctorsAtBranch, holdsAny, isRealDate, istDateOf, MAX_APPOINTMENTS, MAX_DESK_CANCEL_REASON, MAX_DESK_NAME, MAX_DESK_NOTES,
  type Branch, type ClinicAppointment, type ClinicDoctorRow, type DeskAction, type DeskActionOffer, type DeskAppointment, type DeskBookingResult,
  type DeskSlot,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, formatRupees, Loading, TextArea, TextField } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { PendingOpPanel } from '../../components/PendingOpPanel.tsx';
import { messageOf } from '../../errors.ts';
import { afterFailure, beginAttempt, keyedLookup, newRequestKey, resolveStored, startOp, stillCurrent, wasAbandoned } from '../../requests.ts';
import { useSession } from '../../session.tsx';
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

type Patient = { phone: string; name: string; notes: string };
const NO_PATIENT: Patient = { phone: '', name: '', notes: '' };
interface Chosen { slot: DeskSlot; doctor: ClinicDoctorRow; branch: Branch }
type Perform = (a: ClinicAppointment, action: DeskAction, run: () => Promise<DeskAppointment>, done: (next: DeskAppointment) => string) => Promise<void>;

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

  const perform: Perform = async (a, action, run, done) => {
    const id = a.bookingId;
    // The single gate for every step, including confirmations that were already open when another step started.
    if (inFlight.current.has(id)) {
      throw new ApiError(409, 'Another step on this appointment is still running. Wait for it to finish, then try again.', 'STEP_IN_FLIGHT');
    }
    inFlight.current.add(id);
    setBusy((b) => ({ ...b, [id]: action }));
    if (selectedRef.current === id) { setStepNotice(null); setStepFailure(null); }
    try {
      const next = await run();
      // The answer is never written into the cached day: it carries no version, so a late one (from a page the person
      // left and came back to) could put an older time or status over a newer change. Only the re-read below shows state.
      // A late answer (the person left the page or opened another appointment) shows nothing, not even its notice.
      if (mounted.current && selectedRef.current === id) setStepNotice({ id, text: done(next) });
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
   * `op` made this appointment (its answer, a replay, a by-key lookup or a give-up answered `used`): end it, and only it,
   * while this page owns it, then show the day with the appointment open. After a reload `op.body` is gone.
   */
  function settled(view: ReceiptView, op: DeskPending) {
    refresh();
    if (!owns(op)) return;
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
  const viewOf = (b: DeskAppointment, op: DeskPending, extra: Pick<ReceiptView, 'replayed' | 'created'>): ReceiptView => ({
    booking: b, ...extra,
    who: op.body ? op.body.request.customer.name?.trim() || canonicalMobile(op.body.request.customer.phone) || op.body.request.customer.phone : undefined,
    branchName: op.body?.shown.branchName ?? branchNames.get(b.branchId ?? '') ?? 'the clinic',
    doctorName: b.doctorName ?? op.body?.shown.doctorName,
  });
  const booked = (result: DeskBookingResult, op: DeskPending) =>
    settled(viewOf(result.booking, op, { replayed: result.replayed, created: result.customer.created }), op);

  /** Given up on the server, or known booked but outside this desk's branches: ends `op` only while this page owns it. */
  function closeWith(op: DeskPending, text: string) {
    refresh();
    if (!owns(op)) return;
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
          onFound={(b) => settled(viewOf(b, pending, { replayed: true }), pending)}
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
      {receipt && <Receipt ctx={ctx} receipt={receipt} />}

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
                  <thead><tr><th scope="col">Time</th><th scope="col">Patient</th><th scope="col">Doctor</th><th scope="col">Booked</th><th scope="col">Status</th><th scope="col">Details</th></tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.bookingId} aria-current={r.bookingId === selected ? 'true' : undefined}>
                        <td>{clock(r.bookingTime)}</td>
                        <td>{patientName(r)}{r.patient?.phone ? <div className="ws-muted">{r.patient.phone}</div> : null}</td>
                        <td>{r.doctorName ?? '—'}</td>
                        <td>{r.source === 'desk' ? 'At the desk' : r.paidOnline ? 'Online, paid' : 'Online'}</td>
                        <td>
                          <Badge tone={appointmentTone(r.status)}>{CLINIC_APPOINTMENT_STATUS_LABEL[r.status] ?? r.status}</Badge>
                          {r.arrivedAt && r.status === 'confirmed' && <> <Badge tone="ok">Arrived {istTime(r.arrivedAt)}</Badge></>}
                          {busy[r.bookingId] && <div className="ws-muted">Saving…</div>}
                        </td>
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
          perform={perform} click={click} onClose={() => setSelected(null)} />
      )}

      <section className="ws-section" aria-labelledby="desk-slots-h">
        <h2 id="desk-slots-h">Free slots{doctor ? ` of ${doctor.name}` : ''}</h2>
        {manage && locked && <Alert tone="warn">Settle the unconfirmed booking above before booking another.</Alert>}
        {here.length === 0 ? <Empty title="No doctor here">No active doctor consults at {branch!.name}. Doctors join by accepting an invitation (<Link to={clinicLink(ctx, 'clinic-doctors')}>Doctors</Link>).</Empty>
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

/** What a settled booking shows (from its answer, or from a by-key lookup when the details are gone after a reload). */
interface ReceiptView { booking: DeskAppointment; replayed: boolean; created?: boolean; who?: string; branchName: string; doctorName?: string }

/** The answer to a booking: what was booked, the fee to collect, and the way to bill it. */
function Receipt({ ctx, receipt }: { ctx: ScopeContext; receipt: ReceiptView }) {
  const b = receipt.booking;
  return (
    <Alert tone="ok">
      {receipt.replayed ? 'This booking had already been made; nothing was booked twice. ' : 'Booked. '}
      {receipt.who ?? 'The patient'} with {receipt.doctorName ?? 'the doctor'} on {appointmentLabel(b)} at {receipt.branchName}.
      {' '}Fee {formatRupees(b.fee ?? 0)}, paid at the clinic.
      {receipt.created ? ' A Jansetu account was created for this mobile number.' : ''}
      {' '}<BillLink ctx={ctx} />
    </Alert>
  );
}

/** The booking held while its outcome is unknown (session memory only; never stored or put in a URL). */
function PendingBookingSummary({ body }: { body: DeskPendingBody }) {
  const { request, shown } = body;
  return (
    <div>
      {request.customer.name ? `${request.customer.name} (${request.customer.phone})` : request.customer.phone} with {shown.doctorName} on {formatDay(shown.day)}, {shown.time} at {shown.branchName}.
    </div>
  );
}

/** WQ2's new-bill form starts empty (it cannot be prefilled), so this links to it, or to the bills list. */
function BillLink({ ctx }: { ctx: ScopeContext }) {
  if (holdsAny(ctx.actor, ['invoices.create'])) return <Link to={`${ctx.link('invoices')}/new`}>Make a bill for this visit</Link>;
  if (holdsAny(ctx.actor, BILL_READERS)) return <Link to={ctx.link('invoices')}>Bills</Link>;
  return null;
}

function BookingForm({ chosen, patient, setPatient, sending, refused, onCancel, onBook }: {
  chosen: Chosen; patient: Patient; setPatient: (p: Patient) => void; sending: boolean; refused: string | null;
  onCancel: () => void; onBook: (request: Omit<DeskPendingBody['request'], 'requestKey'>) => void;
}) {
  const [tried, setTried] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const problems = deskBookingProblems(patient);
  const errors = tried ? problems : {};
  const set = (p: Partial<Patient>) => { setPatient({ ...patient, ...p }); setReviewing(false); };
  useEffect(() => { if (refused) setReviewing(false); }, [refused]);
  const when = `${formatDay(chosen.slot.date)}, ${clock(chosen.slot.startTime)}`;
  const fee = chosen.doctor.consultationFee;
  const name = patient.name.trim();

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
            <TextField label="Patient’s name (optional)" value={patient.name} maxLength={MAX_DESK_NAME} error={errors.name} onChange={(e) => set({ name: e.target.value })}
              hint="Saved only if the account has no name yet; an existing account is never changed." />
          </div>
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
              Book {name || canonicalMobile(patient.phone)}{name ? ` (${canonicalMobile(patient.phone)})` : ''} with {chosen.doctor.name} on {when} at {chosen.branch.name}?
              {fee ? ` The fee of ${formatRupees(fee)} is paid at the clinic.` : ' The fee is paid at the clinic.'}
              {' '}It is booked once: if the answer is lost, the same booking can be sent again safely.
            </div>
            <div className="confirm-actions">
              <Button busy={sending} onClick={() => {
                const notes = patient.notes.trim();
                onBook({ slotId: chosen.slot.slotId, customer: { phone: canonicalMobile(patient.phone)!, ...(name ? { name } : {}) }, ...(notes ? { notes } : {}) });
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

function AppointmentPanel({ ctx, clinic, appt, doctors, branches, branchName, now, busy, reading, failure, perform, click, onClose }: {
  ctx: ScopeContext; clinic: ClinicApi; appt: ClinicAppointment; doctors: ClinicDoctorRow[]; branches: Branch[]; branchName: string; now: Date;
  busy: DeskAction | undefined; reading: boolean; failure: string | null; perform: Perform;
  click: (a: ClinicAppointment, action: DeskAction, what: string, run: () => Promise<DeskAppointment>, done: (n: DeskAppointment) => string) => Promise<void>;
  onClose: () => void;
}) {
  const offers = deskActions(appt, ctx.actor, now);
  const offer = (a: DeskAction) => offers.find((o) => o.action === a);
  // A step waits while one runs on this appointment, and while the day is being read again (it may have changed).
  const disabled = busy !== undefined || reading;
  const who = patientName(appt);
  const when = appointmentLabel(appt);
  const finished = ['completed', 'cancelled', 'no_show'].includes(appt.status);

  return (
    <section className="ws-section" aria-labelledby="desk-appt-h">
      <h2 id="desk-appt-h">Appointment: {who}, {when}</h2>
      <dl className="ws-dl">
        <dt>Patient</dt>
        <dd>{who}{appt.patient?.relationship ? ` (${appt.patient.relationship} of ${appt.patient.accountName ?? 'the account holder'})` : ''}</dd>
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
      {failure && <Alert>{failure}</Alert>}
      {offers.length > 0 ? (
        <div className="ws-actions">
          {offer('arrived') && (
            <Button disabled={disabled} busy={busy === 'arrived'}
              onClick={() => void click(appt, 'arrived', 'Not marked arrived', () => clinic.arrived(appt.bookingId, appt.updatedAt), () => `${who} is marked as arrived.`)}>
              Mark arrived
            </Button>
          )}
          {offer('complete') && (
            <ConfirmAction label="Mark as seen" disabled={disabled} confirmLabel="Mark as seen"
              consequence={<>Mark {who}’s visit with {appt.doctorName ?? 'the doctor'} as seen? The appointment ends here and the doctor’s time is freed. The fee of {formatRupees(appt.fee ?? 0)} is paid at the clinic: make a bill for it under Bills.</>}
              onConfirm={() => perform(appt, 'complete', () => clinic.complete(appt.bookingId, appt.updatedAt), () => `${who}’s visit is marked as seen.`)} />
          )}
          {offer('no_show') && <NoShow appt={appt} offer={offer('no_show')!} who={who} when={when} disabled={disabled} perform={perform} clinic={clinic} />}
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
      ) : appt.source === 'online' ? (
        <p className="ws-muted">Booked online in the Jansetu app. The clinic can view it; the doctor or the patient makes any change.</p>
      ) : !finished && !holdsAny(ctx.actor, ['bookings.manage']) ? (
        <p className="ws-muted">You can view this appointment; the steps need the “Manage bookings” permission.</p>
      ) : null}
      <div className="ws-actions">
        {appt.source === 'desk' && appt.status !== 'cancelled' && <BillLink ctx={ctx} />}
        <Button variant="ghost" onClick={onClose}>Close</Button>
      </div>
    </section>
  );
}

function NoShow({ appt, offer, who, when, disabled, perform, clinic }: {
  appt: ClinicAppointment; offer: DeskActionOffer; who: string; when: string; disabled: boolean; perform: Perform; clinic: ClinicApi;
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
      consequence={<>Mark {who} as not come for {when}? The appointment ends and the doctor’s time is freed. {NO_MONEY} This cannot be undone.</>}
      onConfirm={() => perform(appt, 'no_show', () => clinic.noShow(appt.bookingId, appt.updatedAt), () => `${who} is marked as not come.`)} />
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
        (n) => `Moved to ${appointmentLabel(n)} at ${target?.name ?? 'the clinic'}. Tell the patient: Jansetu does not notify them of desk appointment changes.`);
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
          {appt.arrivedAt ? ' The check-in is cleared: mark them arrived again when they come.' : ''} Jansetu does not tell the patient; let them know yourself.
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
