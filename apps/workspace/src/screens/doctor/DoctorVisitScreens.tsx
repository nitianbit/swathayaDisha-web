import './doctor.css';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import {
  addDays, ApiError, appointmentStart, bookableClinics, CONSULT_MODE_LABEL, doctorDashboardApi, FOLLOW_UP_DAYS, followUpLastDay, followUpOpen, freeSlots, istToday,
  OBJECT_ID_PATTERN, type DoctorClinicAnswer, type DoctorConsultationAnswer, type DoctorSlot, type DoctorVisitRequestKind, type MyClinics,
} from '@jansetu/api';
import { formatClock, formatDateTime } from '@jansetu/i18n';
import { Alert, Button, Empty, formatRupees, Loading, TextField } from '@jansetu/ui';
import { PageHeading } from '../../PageHeading.tsx';
import { newRequestKey, resolveStored, startOp, type PendingOp } from '../../requests.ts';
import { useSession, useStaff } from '../../session.tsx';
import { useFrontDesk } from '../front/desk.tsx';
import { Failed, homeWords, todayKey } from '../front/home.tsx';
import { HomeButton, VisitPatientLine, visitWho } from '../front/visitBar.tsx';
import { useVisitPreset, type VisitPatient } from '../front/visitPatient.ts';
import { openBill, type BillPrefill } from '../partner/billing.tsx';
import { feeLine } from '../partner/clinic.tsx';
import { visitRequest } from '../partner/DeskScreen.tsx';
import { usePartnerScope } from '../partner/scope.tsx';
import { useOwnedOp } from '../pharmacy/ownedOp.tsx';
import { formatYmd, NotADoctor, useClinics, useDoctor, useDoctorProfile, useOwnedClinic, useTicker, type DoctorContext } from './doctor.tsx';
import { t } from '../../i18n/doctor/index.ts';

/**
 * WQ56 (P2) / WQ56b: what a doctor's + New opens with the patient chosen there (handed over once, `useVisitPreset`):
 * - a clinic appointment at a clinic he consults at (his own included): the clinic (skipped when there is one), a day and
 *   his free time there; it is that clinic's desk appointment, paid at the clinic (r39 `POST /me/clinic-appointments`);
 * - an online consultation (video or call) on one of his online times: the patient pays in the Jansetu app within 30
 *   minutes (r39 `POST /me/consultations`);
 * - a free follow-up of one of his completed, paid consultations (from + New: the patient's of the last 14 days; from an
 *   Appointments row: that one), on a day its window allows.
 * Each booking is one operation with one request key (`requests.ts`): only a definite refusal of its first and only
 * attempt ends it; after an answer that was lost, the screen stays on that booking (Send again sends the same one) and
 * says to check the appointments — never a second booking.
 */

const useDash = () => {
  const { api } = useSession();
  return useMemo(() => doctorDashboardApi(api), [api]);
};

const visitSlot = (d: DoctorContext, kind: DoctorVisitRequestKind) => `doctor-visit:${d.identity}:${kind}`;

export function DoctorBookingRecovery({ d }: { d: DoctorContext }) {
  const { memory } = useSession();
  const pending = (['clinic', 'online', 'follow-up'] as const).filter((kind) => memory.get(visitSlot(d, kind)));
  if (!pending.length) return null;
  return (
    <Alert tone="warn">
      {t('visit.recoveryNotice')}
      <div className="ws-actions">{pending.map((kind) => (
        <Link key={kind} className="j-btn j-btn--secondary" to={`/doctor/new/${kind}`}>{t(`visit.resume.${kind}`)}</Link>
      ))}</div>
    </Alert>
  );
}

/** A lost answer keeps this exact booking in session memory when the doctor checks the appointment list. */
function useOnce<B, T>(slot: string, run: (body: B, requestKey: string) => Promise<T>) {
  const { memory } = useSession();
  const { op, send: sendOwned } = useOwnedOp<B>(slot);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [done, setDone] = useState<T | null>(null);
  async function transmit(request: PendingOp<B>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setRefused(null);
    try {
      const answer = await sendOwned(request, (body) => run(body, request.requestKey));
      if (answer.kind === 'ok') setDone(answer.value);
      if (answer.kind === 'refused') setRefused(refusalWords(answer.error));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  const send = (body: B) => {
    if (!memory.get(slot)) void transmit(startOp(newRequestKey(), body));
  };
  const resend = () => {
    const stored = memory.get<PendingOp<B>>(slot);
    if (stored && !stored.restored && stored.body) void transmit(stored);
  };
  return { busy, refused, done, send, resend, open: op, locked: busy || !!op, clear: () => setRefused(null) };
}
type Once = ReturnType<typeof useOnce<unknown, unknown>>;

/** The refusals a doctor can act on, in words; anything else in the server's words (or "no internet"). */
function refusalWords(err: unknown): string {
  const key = err instanceof ApiError && err.code ? `visit.refusal.${err.code}` : '';
  return key && t.has(key) ? t(key) : homeWords(err);
}

/** The booking's button, or after a lost answer: what is not known, Send again (the same booking) and the appointments. */
function SendBar({ once, label, onSend }: { once: Pick<Once, 'busy' | 'refused'>; label: string | null; onSend: () => void }) {
  return (
    <>
      {once.refused && <Alert>{once.refused}</Alert>}
      {label && <div className="ws-actions"><Button busy={once.busy} onClick={onSend}>{label}</Button></div>}
    </>
  );
}

function ResumeBooking({ d, kind, once, visit }: {
  d: DoctorContext; kind: DoctorVisitRequestKind; once: Pick<Once, 'open' | 'busy' | 'resend'>; visit?: VisitPatient;
}) {
  if (once.busy) return <Loading />;
  if (once.open && (once.open.restored || !once.open.body)) {
    return <RestoredBooking d={d} kind={kind} requestKey={once.open.requestKey} />;
  }
  if (once.open) {
    return (
      <div className="ws-section" role="alert">
        {visit && <VisitPatientLine patient={visit} canChange={false} />}
        <Alert tone="warn">{once.open.error ? t('visit.uncertain', { reason: once.open.error }) : t('visit.unconfirmed')}</Alert>
        <div className="ws-actions">
          <Button onClick={once.resend}>{t('visit.sendAgain')}</Button>
          <Link className="j-btn j-btn--secondary" to="/doctor/appointments">{t('visit.checkAppointments')}</Link>
        </div>
      </div>
    );
  }
  return null;
}

/** The original key can be checked even when the patient details are no longer in memory. */
function RestoredBooking({ d, kind, requestKey }: { d: DoctorContext; kind: DoctorVisitRequestKind; requestKey: string }) {
  const { memory } = useSession();
  const dash = useDash();
  const check = useMutation({
    mutationFn: () => dash.checkVisitRequest(kind, requestKey),
    onSuccess: ({ appointmentId }) => {
      if (appointmentId) resolveStored(memory, visitSlot(d, kind), requestKey);
    },
  });
  if (check.data?.appointmentId) {
    return (
      <Alert tone="ok">
        {t('visit.found')}
        <div className="ws-actions">
          <Link className="j-btn j-btn--secondary" to={`/doctor/appointments?open=${check.data.appointmentId}`}>{t('visit.openAppointment')}</Link>
        </div>
      </Alert>
    );
  }
  return (
    <Alert tone="warn">
      {t('visit.afterReload')}
      {check.isSuccess && <p>{t('visit.stillUnknown')}</p>}
      {check.isError && <p>{check.error instanceof ApiError && check.error.status === 404
        ? t('visit.checkUnavailable') : homeWords(check.error)}</p>}
      <div className="ws-actions">
        <Button busy={check.isPending} onClick={() => check.mutate()}>{t('visit.checkByKey')}</Button>
        <Link className="j-btn j-btn--secondary" to="/doctor/appointments">{t('visit.checkAppointments')}</Link>
      </div>
    </Alert>
  );
}

/** A visit opened without its patient (a reload, or the address typed): back to + New. */
function NoPatient() {
  return <Empty title={t('visit.noPatient')}><Link className="j-btn j-btn--primary" to="/doctor/new">{t('visit.startNew')}</Link></Empty>;
}

function VisitPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="simple">
      <PageHeading title={title} />
      {children}
    </div>
  );
}

const clock = (s: Pick<DoctorSlot, 'date' | 'startTime'>) => {
  const at = appointmentStart({ bookingDate: s.date, bookingTime: s.startTime });
  return at ? formatClock(at.getTime()) : s.startTime;
};

/** A day (today on, at most `last`) and his free times that day at the place asked, as big buttons. */
function TimePicker({ d, where, slotId, onPick, disabled, label, last }: {
  d: DoctorContext; where: Parameters<typeof freeSlots>[2]; slotId: string | null; onPick: (s: DoctorSlot | null) => void; disabled: boolean;
  label: (s: DoctorSlot) => string; last?: string;
}) {
  const today = istToday();
  const max = last && last < addDays(today, 29) ? last : addDays(today, 29);
  const [day, setDay] = useState(today);
  const now = useTicker(60_000);
  const slots = useQuery({ queryKey: [...d.key, 'slots', day], queryFn: () => d.api.slotsOn(day), staleTime: 0 });
  const free = slots.data ? freeSlots(slots.data, now, where) : [];
  return (
    <section className="ws-section" aria-labelledby="vt-h">
      <h2 id="vt-h">{t('visit.when')}</h2>
      <div className="simple-row">
        <TextField label={t('visit.day')} type="date" min={today} max={max} value={day} disabled={disabled}
          onChange={(e) => { if (e.target.value && e.target.value <= max) { setDay(e.target.value); onPick(null); } }} />
      </div>
      {!slots.data ? (slots.isError ? <Failed error={slots.error} onRetry={() => void slots.refetch()} /> : <Loading label={t('visit.loadingTimes')} />)
        : free.length === 0 ? <Alert tone="warn">{t('visit.noTimes', { day: formatYmd(day.replace(/-/g, '')) })}</Alert>
        : (
          <div className="pay-buttons" role="group" aria-label={t('visit.times')}>
            {free.map((s) => (
              <button key={s._id} type="button" className="pay-button" aria-pressed={slotId === s._id} disabled={disabled} onClick={() => onPick(s)}>{label(s)}</button>
            ))}
          </div>
        )}
    </section>
  );
}

/** Where each of his bookable clinic branches is, in words: "Demo Care Clinic · Baner" (the branch alone for one clinic). */
function placeWords(clinics: MyClinics | undefined) {
  const places = bookableClinics(clinics);
  const map = new Map<string, string>();
  for (const c of places) {
    for (const b of c.branches) map.set(b.branchId.toLowerCase(), `${c.name ?? t('dash.clinicUnnamed')} · ${b.name}`);
  }
  return { places, of: (s: DoctorSlot) => map.get(String(s.branchId ?? '').toLowerCase()) ?? '' };
}

/** The dashboard's reads that a new booking changes. */
function useRefreshDay(d: DoctorContext) {
  const queryClient = useQueryClient();
  const desk = useFrontDesk();
  return () => {
    void queryClient.invalidateQueries({ queryKey: [...d.key, 'dash'] });
    void queryClient.invalidateQueries({ queryKey: [...d.key, 'appointments'] });
    void queryClient.invalidateQueries({ queryKey: [...d.key, 'slots'] });
    if (desk) void queryClient.invalidateQueries({ queryKey: todayKey(desk, istToday()) });
  };
}

/** After a booking: what was booked, and Home or another visit. */
function Booked({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="ws-section" aria-labelledby="vb-h">
      <Alert tone="ok"><strong id="vb-h">{title}</strong></Alert>
      {children}
      <div className="ws-actions">
        {actions}
        <Link className="j-btn j-btn--secondary" to="/doctor/new">{t('visit.another')}</Link>
        <HomeButton />
      </div>
    </section>
  );
}

// ── Clinic appointment ──

export function DoctorClinicVisitScreen() {
  const d = useDoctor();
  const visit = useVisitPreset();
  if (!d) return <NotADoctor />;
  return <VisitPage title={t('visit.clinic.title')}><ClinicVisit key={d.identity} d={d} visit={visit} /></VisitPage>;
}

interface ClinicChoice { clinicId: string; clinic: string; slot: DoctorSlot; own: boolean; visit: VisitPatient }
interface ClinicBooked extends ClinicChoice { answer: DoctorClinicAnswer }

function ClinicVisit({ d, visit }: { d: DoctorContext; visit: VisitPatient | null }) {
  const dash = useDash();
  const clinics = useClinics(d);
  const { owned } = useOwnedClinic(d.user.id);
  const refresh = useRefreshDay(d);
  const once = useOnce<ClinicChoice, ClinicBooked>(visitSlot(d, 'clinic'), async (c, requestKey) => {
    const { slotId: _s, ...who } = visitRequest(c.visit, c.slot._id);
    const answer = await dash.bookClinic({ clinicId: c.clinicId, ...(c.slot.branchId ? { branchId: String(c.slot.branchId) } : {}), slotId: c.slot._id, requestKey, ...who });
    refresh();
    return { ...c, answer };
  });
  const [clinicId, setClinicId] = useState<string | null>(null);
  const [slot, setSlot] = useState<DoctorSlot | null>(null);
  if (once.done) return <ClinicDone visit={once.done.visit} done={once.done} />;
  if (once.locked) return <ResumeBooking d={d} kind="clinic" once={once} visit={once.open?.body?.visit} />;
  if (!visit) return <NoPatient />;
  if (!clinics.data) return clinics.isError ? <Failed error={clinics.error} onRetry={() => void clinics.refetch()} /> : <Loading />;
  const { places, of } = placeWords(clinics.data);
  const clinic = places.find((c) => c.partnerId === clinicId);
  const chosen = slot;
  const name = (c: { name?: string }) => c.name ?? t('dash.clinicUnnamed');
  return (
    <>
      <VisitPatientLine patient={visit} canChange={!once.locked} />
      {places.length === 0 ? (
        <Alert tone="warn">{t('visit.clinic.none')} <Link to="/doctor/clinics">{t('visit.clinic.toClinics')}</Link></Alert>
      ) : (
        <>
          <section className="ws-section" aria-labelledby="vc-h">
            <h2 id="vc-h">{t('visit.clinic.which')}</h2>
            <div className="big-actions big-actions--two" role="group" aria-labelledby="vc-h">
              {places.map((c) => (
                <button key={c.partnerId} type="button" className="big-action" aria-pressed={clinic?.partnerId === c.partnerId}
                  onClick={() => { setClinicId(c.partnerId); setSlot(null); once.clear(); }}>{name(c)}</button>
              ))}
            </div>
          </section>
          {clinic && (
            <>
              <TimePicker key={clinic.partnerId} d={d} where={{ branchIds: clinic.branches.map((b) => b.branchId) }} slotId={chosen?._id ?? null} disabled={once.locked}
                onPick={(s) => { setSlot(s); once.clear(); }} label={(s) => (clinic.branches.length > 1 ? `${clock(s)} · ${of(s).split(' · ').pop()}` : clock(s))} />
              <SendBar once={once}
                label={chosen ? t('visit.clinic.book', { time: clock(chosen), day: formatYmd(chosen.date), clinic: name(clinic) }) : null}
                onSend={() => chosen && once.send({ clinicId: clinic.partnerId, clinic: name(clinic), slot: chosen, own: owned?.partnerId === clinic.partnerId, visit })} />
              <p className="ws-muted">{t('visit.clinic.paidAtClinic')}</p>
            </>
          )}
        </>
      )}
    </>
  );
}

/** Booked at a clinic: it is in that clinic's reception list; at his own clinic he makes the bill here (the short one). */
function ClinicDone({ visit, done }: { visit: VisitPatient; done: ClinicBooked }) {
  const ctx = usePartnerScope();
  const { memory } = useSession();
  const me = useStaff();
  const navigate = useNavigate();
  return (
    <Booked title={t('visit.clinic.booked', { who: visitWho(visit), clinic: done.clinic, time: clock(done.slot), day: formatYmd(done.slot.date) })}
      actions={done.own && ctx ? (
        // His own clinic: the reception's short bill with his fee on it (WQ57's fee line).
        <Button onClick={() => openBill(ctx, memory, ownVisitBill(done.answer, visit, me), navigate)}>{t('visit.clinic.bill')}</Button>
      ) : null}>
      <p>{done.own ? t('visit.clinic.inOwnList') : t('visit.clinic.inList', { clinic: done.clinic })}</p>
    </Booked>
  );
}

/**
 * His own clinic's visit bill (the reception's short bill): the appointment, its account holder (+ New's number and name,
 * the owner's for a family member) and his fee as the consultation line.
 */
function ownVisitBill(a: DoctorClinicAnswer, v: VisitPatient, me: { id: string; name: string }): BillPrefill {
  const b = a.booking;
  const at = appointmentStart(b);
  return {
    link: { kind: 'appointment', id: b.bookingId }, branchId: b.branchId ?? '', doctorId: me.id, name: v.family ? v.family.holderName : v.name, phone: v.phone,
    label: `${formatYmd(b.bookingDate)}, ${at ? formatClock(at.getTime()) : b.bookingTime}`, simple: true,
    ...(b.fee ? { handLines: [feeLine(me.name, b.fee)] } : {}),
  };
}

// ── Online consultation ──

export function DoctorOnlineVisitScreen() {
  const d = useDoctor();
  const visit = useVisitPreset();
  if (!d) return <NotADoctor />;
  return <VisitPage title={t('visit.online.title')}><OnlineVisit key={d.identity} d={d} visit={visit} /></VisitPage>;
}

const ONLINE_MODES = ['video', 'call'] as const;
interface OnlineChoice { mode: 'video' | 'call'; slot: DoctorSlot; visit: VisitPatient }

function OnlineVisit({ d, visit }: { d: DoctorContext; visit: VisitPatient | null }) {
  const dash = useDash();
  const profile = useDoctorProfile(d);
  const refresh = useRefreshDay(d);
  const once = useOnce<OnlineChoice, { answer: DoctorConsultationAnswer; visit: VisitPatient }>(visitSlot(d, 'online'), async (c, requestKey) => {
    const { slotId: _s, notes: _n, ...who } = visitRequest(c.visit, c.slot._id);
    const answer = await dash.bookConsultation({ slotId: c.slot._id, mode: c.mode, requestKey, ...who });
    refresh();
    return { answer, visit: c.visit };
  });
  // No mode is chosen for him: video or a phone call is asked.
  const [mode, setMode] = useState<'video' | 'call' | null>(null);
  const [slot, setSlot] = useState<DoctorSlot | null>(null);
  if (once.done) return <ConsultationDone visit={once.done.visit} answer={once.done.answer} />;
  if (once.locked) return <ResumeBooking d={d} kind="online" once={once} visit={once.open?.body?.visit} />;
  if (!visit) return <NoPatient />;
  const m = mode;
  const chosen = slot;
  const fee = profile.data?.consultationFee;
  return (
    <>
      <VisitPatientLine patient={visit} canChange={!once.locked} />
      <div className="doctor-note">
        <p>{t('visit.online.paysInApp')}</p>
        {typeof fee === 'number' && <p>{t('visit.online.fee', { fee: formatRupees(fee) })}</p>}
        <p>{t('visit.online.signInHint')}</p>
      </div>
      <section className="ws-section" aria-labelledby="vo-h">
        <h2 id="vo-h">{t('visit.online.how')}</h2>
        <div className="big-actions big-actions--two" role="group" aria-labelledby="vo-h">
          {ONLINE_MODES.map((x) => (
            <button key={x} type="button" className="big-action" aria-pressed={m === x} disabled={once.locked}
              onClick={() => { setMode(x); setSlot(null); once.clear(); }}>{CONSULT_MODE_LABEL[x]}</button>
          ))}
        </div>
      </section>
      {m && <TimePicker key={m} d={d} where={{ mode: m }} slotId={chosen?._id ?? null} disabled={once.locked} onPick={(s) => { setSlot(s); once.clear(); }} label={clock} />}
      <SendBar once={once} label={m && chosen ? t('visit.online.book', { mode: CONSULT_MODE_LABEL[m], time: clock(chosen), day: formatYmd(chosen.date) }) : null}
        onSend={() => m && chosen && once.send({ mode: m, slot: chosen, visit })} />
    </>
  );
}

/** Booked online, or a follow-up: what the patient must do (pay in the app by a time), said as the server answered it. */
function ConsultationDone({ visit, answer }: { visit: VisitPatient | null; answer: DoctorConsultationAnswer }) {
  const b = answer.booking;
  const at = appointmentStart({ bookingDate: b.bookingDate, bookingTime: b.bookingTime });
  const when = { day: formatYmd(b.bookingDate), time: at ? formatClock(at.getTime()) : b.bookingTime };
  const mode = b.consultationMode ? CONSULT_MODE_LABEL[b.consultationMode as keyof typeof CONSULT_MODE_LABEL] ?? b.consultationMode : '';
  const payBy = answer.payment.payBy && !Number.isNaN(Date.parse(answer.payment.payBy)) ? answer.payment.payBy : null;
  return (
    <Booked title={b.followUpOf ? t('visit.followUp.booked', when) : t('visit.online.booked', { who: visit ? visitWho(visit) : '', mode, ...when })}>
      {answer.payment.required ? (
        <>
          <p>{t('visit.online.fee', { fee: formatRupees(b.fee) })}</p>
          <p>{payBy ? t('visit.online.payBy', { time: formatDateTime(payBy) }) : t('visit.online.payInApp')}</p>
          <p>{t('visit.online.signInHint')}</p>
        </>
      ) : <p>{t('visit.online.nothingToPay')}</p>}
    </Booked>
  );
}

// ── Follow-up ──

/** `/doctor/new/follow-up` (+ New's patient) or `/doctor/follow-up/:bookingId` (an Appointments row). */
export function DoctorFollowUpScreen() {
  const d = useDoctor();
  const { bookingId } = useParams();
  const { memory } = useSession();
  const visit = useVisitPreset();
  if (!d) return <NotADoctor />;
  const pending = memory.get<PendingOp<FollowUpChoice>>(visitSlot(d, 'follow-up'));
  if (pending) {
    if (pending.restored || !pending.body) {
      return <VisitPage title={t('visit.followUp.title')}><RestoredBooking d={d} kind="follow-up" requestKey={pending.requestKey} /></VisitPage>;
    }
    const parentId = pending.body.parentId;
    return <VisitPage title={t('visit.followUp.title')}><FollowUp key={`${d.identity}:${parentId}`} d={d} parentId={parentId} visit={null} /></VisitPage>;
  }
  if (bookingId !== undefined) {
    return (
      <VisitPage title={t('visit.followUp.title')}>
        {OBJECT_ID_PATTERN.test(bookingId) ? <FollowUp key={`${d.identity}:${bookingId}`} d={d} parentId={bookingId} visit={null} />
          : <Empty title={t('visit.followUp.notFound')} />}
      </VisitPage>
    );
  }
  return <VisitPage title={t('visit.followUp.title')}>{visit ? <PickEarlier key={d.identity} d={d} visit={visit} /> : <NoPatient />}</VisitPage>;
}

/**
 * + New's patient: his consultations with this number whose free follow-up is still open (completed, paid, not a
 * follow-up): the day register searched by the number for the last 14 days, kept only when his list says they qualify.
 */
function PickEarlier({ d, visit }: { d: DoctorContext; visit: VisitPatient }) {
  const desk = useFrontDesk();
  const dash = useDash();
  const [parentId, setParentId] = useState<string | null>(null);
  const today = istToday();
  const q = useQuery({
    queryKey: [...d.key, 'dash', 'earlier', visit.phone, today],
    queryFn: async () => {
      const from = addDays(today, -FOLLOW_UP_DAYS);
      const days = Array.from({ length: FOLLOW_UP_DAYS + 1 }, (_, i) => addDays(today, -i));
      const [rows, ...pages] = await Promise.all([dash.appointments({ from, to: today, status: 'completed' }),
        ...days.map((date) => desk!.today.search({ date, q: visit.phone, order: 'desc', limit: 50 }))]);
      const open = new Map(rows.items.filter((r) => followUpOpen(r, today)).map((r) => [r._id.toLowerCase(), r]));
      return pages.flatMap((p) => p.items).filter((i) => i.kind === 'appointment' && open.has(i.id.toLowerCase()));
    },
    enabled: !!desk, gcTime: 0,
  });
  if (parentId) return <FollowUp d={d} parentId={parentId} visit={visit} />;
  return (
    <>
      <VisitPatientLine patient={visit} canChange />
      <section className="ws-section" aria-labelledby="ve-h">
        <h2 id="ve-h">{t('visit.followUp.which')}</h2>
        {!q.data ? (q.isError ? <Failed error={q.error} onRetry={() => void q.refetch()} /> : <Loading />)
          : q.data.length === 0 ? <Alert tone="warn">{t('visit.followUp.noneEarlier', { days: FOLLOW_UP_DAYS })}</Alert>
          : (
            <ul className="simple-choices">
              {q.data.map((i) => (
                <li key={i.id}><Button variant="secondary" onClick={() => setParentId(i.id)}>{`${formatDateTime(i.at)} · ${i.patientName ?? t('dash.noName')}`}</Button></li>
              ))}
            </ul>
          )}
      </section>
    </>
  );
}

const FOLLOW_UP_MODES = ['video', 'call', 'in-person'] as const;
interface FollowUpChoice { parentId: string; mode: (typeof FOLLOW_UP_MODES)[number]; slot: DoctorSlot }

function FollowUp({ d, parentId, visit }: { d: DoctorContext; parentId: string; visit: VisitPatient | null }) {
  const dash = useDash();
  const clinics = useClinics(d);
  const parent = useQuery({ queryKey: [...d.key, 'appointment', parentId], queryFn: () => d.api.appointment(parentId), retry: false });
  const refresh = useRefreshDay(d);
  const once = useOnce<FollowUpChoice, DoctorConsultationAnswer>(visitSlot(d, 'follow-up'), async (c, requestKey) => {
    const answer = await dash.bookConsultation({ slotId: c.slot._id, mode: c.mode, followUpOf: c.parentId, requestKey });
    refresh();
    return answer;
  });
  const [mode, setMode] = useState<FollowUpChoice['mode'] | null>(null);
  const [slot, setSlot] = useState<DoctorSlot | null>(null);
  if (once.done) return <ConsultationDone visit={visit} answer={once.done} />;
  if (once.locked) return <ResumeBooking d={d} kind="follow-up" once={once} />;
  if (!parent.data) return parent.isError ? <Failed error={parent.error} onRetry={() => void parent.refetch()} /> : <Loading />;
  const p = parent.data;
  const at = appointmentStart(p);
  const { places, of } = placeWords(clinics.data);
  const branchIds = places.flatMap((c) => c.branches.map((b) => b.branchId));
  const m = mode;
  const chosen = slot;
  const last = followUpLastDay(p);
  const today = istToday();
  return (
    <>
      {visit && <VisitPatientLine patient={visit} canChange={!once.locked} />}
      <p>{t('visit.followUp.of', { day: formatYmd(p.bookingDate), time: at ? formatClock(at.getTime()) : p.bookingTime,
        mode: p.consultationMode ? CONSULT_MODE_LABEL[p.consultationMode] : t('doctorHome.consultation') })}</p>
      {!last || !followUpOpen(p, today) ? <Alert tone="warn">{t('visit.followUp.notOpen')}</Alert> : (
        <>
          <p className="ws-muted">{t('visit.followUp.free', { day: formatYmd(last.replace(/-/g, '')) })}</p>
          <section className="ws-section" aria-labelledby="vf-h">
            <h2 id="vf-h">{t('visit.followUp.how')}</h2>
            <div className="big-actions" role="group" aria-labelledby="vf-h">
              {FOLLOW_UP_MODES.filter((x) => x !== 'in-person' || branchIds.length > 0).map((x) => (
                <button key={x} type="button" className="big-action" aria-pressed={m === x} disabled={once.locked}
                  onClick={() => { setMode(x); setSlot(null); once.clear(); }}>{CONSULT_MODE_LABEL[x]}</button>
              ))}
            </div>
          </section>
          {m && (
            <TimePicker key={m} d={d} where={m === 'in-person' ? { branchIds } : { mode: m }} slotId={chosen?._id ?? null} disabled={once.locked} last={last}
              onPick={(s) => { setSlot(s); once.clear(); }} label={(s) => (m === 'in-person' ? `${clock(s)} · ${of(s)}` : clock(s))} />
          )}
          <SendBar once={once} label={m && chosen ? t('visit.followUp.book', { time: clock(chosen), day: formatYmd(chosen.date) }) : null}
            onSend={() => m && chosen && once.send({ parentId, mode: m, slot: chosen })} />
        </>
      )}
    </>
  );
}
