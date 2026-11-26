import './doctor.css';
import { useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import {
  addDays, ApiError, appointmentStart, bookableClinics, CONSULT_MODE_LABEL, doctorDashboardApi, freeSlots, istToday, OBJECT_ID_PATTERN, ownedClinic,
  type DoctorClinicAnswer, type DoctorConsultationAnswer, type DoctorSlot, type TodayItem,
} from '@jansetu/api';
import { formatClock, formatDateTime } from '@jansetu/i18n';
import { Alert, Button, Empty, Loading, TextField } from '@jansetu/ui';
import { PageHeading } from '../../PageHeading.tsx';
import { definitelyNotRecorded, newRequestKey } from '../../requests.ts';
import { useSession, useStaff } from '../../session.tsx';
import { useFrontDesk } from '../front/desk.tsx';
import { Failed, homeWords, todayKey } from '../front/home.tsx';
import { HomeButton, VisitPatientLine, visitWho } from '../front/visitBar.tsx';
import { useVisitPreset, visitDeskRequest, type VisitPatient } from '../front/visitPatient.ts';
import { openBill } from '../partner/billing.tsx';
import { feeLine } from '../partner/clinic.tsx';
import type { BillPrefill } from '../partner/billing.tsx';
import { usePartnerScope } from '../partner/scope.tsx';
import { formatYmd, NotADoctor, useClinics, useDoctor, useTicker, type DoctorContext } from './doctor.tsx';
import { t } from '../../i18n/doctor/index.ts';

/**
 * WQ56 (P2): what a doctor's + New opens with the patient chosen there (handed over once, `useVisitPreset`), in big type:
 * - a clinic appointment at a clinic he consults at (his own included): the clinic (skipped when there is one), a day and
 *   his free time there; it is that clinic's desk appointment, paid at the clinic (r39 `POST /me/clinic-appointments`);
 * - an online consultation (video or call) on one of his online times: the patient pays in the Jansetu app within 30
 *   minutes (r39 `POST /me/consultations`);
 * - a follow-up of one of his completed consultations (from + New: the patient's consultations of the last 14 days; from
 *   an Appointments row: that one), free under the follow-up rule.
 * Each create is sent once per request key: a lost answer is sent again with the same key (never a second booking).
 */

const useDash = () => {
  const { api } = useSession();
  return useMemo(() => doctorDashboardApi(api), [api]);
};

/** One create at a time, its key kept until the server answers for sure (the to-dos' rule). */
function useOnce<T>() {
  const [key, setKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; retry: boolean } | null>(null);
  const [done, setDone] = useState<T | null>(null);
  async function send(run: (key: string) => Promise<T>) {
    const k = key ?? newRequestKey();
    setKey(k); setBusy(true); setError(null);
    try {
      setDone(await run(k));
    } catch (err) {
      const settled = definitelyNotRecorded(err);
      if (settled) setKey(null);
      setError({ text: refusalWords(err), retry: !settled });
    } finally {
      setBusy(false);
    }
  }
  /** A new choice is a new request (a new key), unless one is waiting for its answer. */
  const changed = () => { if (!error?.retry) { setKey(null); setError(null); } };
  return { busy, error, done, send, changed, locked: busy || !!error?.retry };
}

/** The refusals a doctor can act on, in words; anything else in the server's words (or "no internet"). */
function refusalWords(err: unknown): string {
  const key = err instanceof ApiError && err.code ? `visit.refusal.${err.code}` : '';
  return key && t.has(key) ? t(key) : homeWords(err);
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

/** A day (today on) and his free times that day at the place asked, as big buttons. */
function TimePicker({ d, where, slotId, onPick, disabled, label }: {
  d: DoctorContext; where: Parameters<typeof freeSlots>[2]; slotId: string | null; onPick: (s: DoctorSlot | null) => void; disabled: boolean;
  label: (s: DoctorSlot) => string;
}) {
  const today = istToday();
  const [day, setDay] = useState(today);
  const now = useTicker(60_000);
  const slots = useQuery({ queryKey: [...d.key, 'slots', day], queryFn: () => d.api.slotsOn(day), staleTime: 0 });
  const free = slots.data ? freeSlots(slots.data, now, where) : [];
  return (
    <section className="ws-section" aria-labelledby="vt-h">
      <h2 id="vt-h">{t('visit.when')}</h2>
      <div className="simple-row">
        <TextField label={t('visit.day')} type="date" min={today} max={addDays(today, 29)} value={day} disabled={disabled}
          onChange={(e) => { if (e.target.value) { setDay(e.target.value); onPick(null); } }} />
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
  return <VisitPage title={t('visit.clinic.title')}>{visit ? <ClinicVisit key={d.identity} d={d} visit={visit} /> : <NoPatient />}</VisitPage>;
}

interface ClinicBooked { clinic: string; slot: DoctorSlot; own: boolean; answer: DoctorClinicAnswer }

function ClinicVisit({ d, visit }: { d: DoctorContext; visit: VisitPatient }) {
  const dash = useDash();
  const clinics = useClinics(d);
  const once = useOnce<ClinicBooked>();
  const refresh = useRefreshDay(d);
  const [clinicId, setClinicId] = useState<string | null>(null);
  const [slot, setSlot] = useState<DoctorSlot | null>(null);
  if (once.done) return <ClinicDone visit={visit} done={once.done} />;
  if (!clinics.data) return clinics.isError ? <Failed error={clinics.error} onRetry={() => void clinics.refetch()} /> : <Loading />;
  const places = bookableClinics(clinics.data);
  const clinic = places.length === 1 ? places[0]! : places.find((c) => c.partnerId === clinicId) ?? null;
  const name = (c: { name?: string }) => c.name ?? t('visit.clinic.unnamed');
  const branchName = (s: DoctorSlot) => clinic?.branches.find((b) => b.branchId.toLowerCase() === String(s.branchId ?? '').toLowerCase())?.name ?? '';
  const book = (c: NonNullable<typeof clinic>, s: DoctorSlot) => once.send(async (requestKey) => {
    const r = await dash.bookClinic({ clinicId: c.partnerId, ...(s.branchId ? { branchId: String(s.branchId) } : {}), slotId: s._id, requestKey, ...visitDeskRequest(visit) });
    refresh();
    return { clinic: name(c), slot: s, own: ownedClinic(clinics.data)?.partnerId === c.partnerId, answer: r };
  });
  return (
    <>
      <VisitPatientLine patient={visit} canChange={!once.locked} />
      {places.length === 0 ? (
        <Alert tone="warn">{t('visit.clinic.none')} <Link to="/doctor/clinics">{t('visit.clinic.toClinics')}</Link></Alert>
      ) : (
        <>
          {places.length > 1 && (
            <section className="ws-section" aria-labelledby="vc-h">
              <h2 id="vc-h">{t('visit.clinic.which')}</h2>
              <div className="big-actions big-actions--two" role="group" aria-labelledby="vc-h">
                {places.map((c) => (
                  <button key={c.partnerId} type="button" className="big-action" aria-pressed={clinic?.partnerId === c.partnerId} disabled={once.locked}
                    onClick={() => { setClinicId(c.partnerId); setSlot(null); once.changed(); }}>{name(c)}</button>
                ))}
              </div>
            </section>
          )}
          {clinic && (
            <>
              {places.length === 1 && <p>{t('visit.clinic.at', { clinic: name(clinic) })}</p>}
              <TimePicker key={clinic.partnerId} d={d} where={{ branchIds: clinic.branches.map((b) => b.branchId) }} slotId={slot?._id ?? null} disabled={once.locked}
                onPick={(s) => { setSlot(s); once.changed(); }} label={(s) => (clinic.branches.length > 1 ? `${clock(s)} · ${branchName(s)}` : clock(s))} />
              {once.error && <Alert tone={once.error.retry ? 'warn' : 'error'}>{once.error.text}</Alert>}
              {slot && (
                <div className="ws-actions">
                  <Button busy={once.busy} onClick={() => void book(clinic, slot)}>
                    {once.error?.retry ? t('visit.sendAgain') : t('visit.clinic.book', { time: clock(slot), day: formatYmd(slot.date), clinic: name(clinic) })}
                  </Button>
                </div>
              )}
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
        // His own clinic: the reception's short bill with his fee on it (WQ57's).
        <Button onClick={() => openBill(ctx, memory, ownVisitBill(done.answer, visit, me), navigate)}>
          {t('visit.clinic.bill')}
        </Button>
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
  return <VisitPage title={t('visit.online.title')}>{visit ? <OnlineVisit key={d.identity} d={d} visit={visit} /> : <NoPatient />}</VisitPage>;
}

const ONLINE_MODES = ['video', 'call'] as const;

function OnlineVisit({ d, visit }: { d: DoctorContext; visit: VisitPatient }) {
  const dash = useDash();
  const once = useOnce<DoctorConsultationAnswer>();
  const refresh = useRefreshDay(d);
  // No mode is chosen for him: video or a phone call is asked.
  const [mode, setMode] = useState<'video' | 'call' | null>(null);
  const [slot, setSlot] = useState<DoctorSlot | null>(null);
  if (once.done) return <ConsultationDone visit={visit} answer={once.done} />;
  return (
    <>
      <VisitPatientLine patient={visit} canChange={!once.locked} />
      <p className="doctor-note">{t('visit.online.paysInApp')}</p>
      <section className="ws-section" aria-labelledby="vo-h">
        <h2 id="vo-h">{t('visit.online.how')}</h2>
        <div className="big-actions big-actions--two" role="group" aria-labelledby="vo-h">
          {ONLINE_MODES.map((m) => (
            <button key={m} type="button" className="big-action" aria-pressed={mode === m} disabled={once.locked}
              onClick={() => { setMode(m); setSlot(null); once.changed(); }}>{CONSULT_MODE_LABEL[m]}</button>
          ))}
        </div>
      </section>
      {mode && (
        <TimePicker key={mode} d={d} where={{ mode }} slotId={slot?._id ?? null} disabled={once.locked} onPick={(s) => { setSlot(s); once.changed(); }} label={clock} />
      )}
      {once.error && <Alert tone={once.error.retry ? 'warn' : 'error'}>{once.error.text}</Alert>}
      {mode && slot && (
        <div className="ws-actions">
          <Button busy={once.busy} onClick={() => void once.send(async (requestKey) => {
            const r = await dash.bookConsultation({ slotId: slot._id, mode, requestKey, ...visitDeskRequest(visit) });
            refresh();
            return r;
          })}>
            {once.error?.retry ? t('visit.sendAgain') : t('visit.online.book', { mode: CONSULT_MODE_LABEL[mode], time: clock(slot), day: formatYmd(slot.date) })}
          </Button>
        </div>
      )}
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
      {answer.payment.required
        ? <p>{payBy ? t('visit.online.payBy', { time: formatDateTime(payBy) }) : t('visit.online.payInApp')}</p>
        : <p>{t('visit.online.nothingToPay')}</p>}
    </Booked>
  );
}

// ── Follow-up ──

/** `/doctor/new/follow-up` (+ New's patient) or `/doctor/follow-up/:bookingId` (an Appointments row). */
export function DoctorFollowUpScreen() {
  const d = useDoctor();
  const { bookingId } = useParams();
  const visit = useVisitPreset();
  if (!d) return <NotADoctor />;
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

/** The follow-up window (days after the consultation), as the server's rule. */
const FOLLOW_UP_DAYS = 14;

/** + New's patient: his completed consultations of this number in the last 14 days (the day register searched by phone). */
function PickEarlier({ d, visit }: { d: DoctorContext; visit: VisitPatient }) {
  const desk = useFrontDesk();
  const [parent, setParent] = useState<TodayItem | null>(null);
  const today = istToday();
  const q = useQuery({
    queryKey: [...d.key, 'dash', 'earlier', visit.phone, today],
    queryFn: async () => {
      const days = Array.from({ length: FOLLOW_UP_DAYS + 1 }, (_, i) => addDays(today, -i));
      const pages = await Promise.all(days.map((date) => desk!.today.search({ date, q: visit.phone, order: 'desc', limit: 50 })));
      return pages.flatMap((p) => p.items).filter((i) => i.kind === 'appointment' && i.status === 'completed' && i.link?.id);
    },
    enabled: !!desk, gcTime: 0,
  });
  if (parent) return <FollowUp d={d} parentId={parent.link!.id} visit={visit} />;
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
                <li key={i.id}>
                  <Button variant="secondary" onClick={() => setParent(i)}>
                    {`${formatDateTime(i.at)} · ${i.patientName ?? t('visit.noName')}`}
                  </Button>
                </li>
              ))}
            </ul>
          )}
      </section>
    </>
  );
}

const FOLLOW_UP_MODES = ['video', 'call', 'in-person'] as const;

function FollowUp({ d, parentId, visit }: { d: DoctorContext; parentId: string; visit: VisitPatient | null }) {
  const dash = useDash();
  const clinics = useClinics(d);
  const parent = useQuery({ queryKey: [...d.key, 'appointment', parentId], queryFn: () => d.api.appointment(parentId), retry: false });
  const once = useOnce<DoctorConsultationAnswer>();
  const refresh = useRefreshDay(d);
  const [mode, setMode] = useState<(typeof FOLLOW_UP_MODES)[number] | null>(null);
  const [slot, setSlot] = useState<DoctorSlot | null>(null);
  if (once.done) return <ConsultationDone visit={visit} answer={once.done} />;
  if (!parent.data) return parent.isError ? <Failed error={parent.error} onRetry={() => void parent.refetch()} /> : <Loading />;
  const p = parent.data;
  const at = appointmentStart(p);
  const branchIds = (clinics.data?.clinics ?? []).flatMap((c) => c.branches.map((b) => b.branchId));
  return (
    <>
      {visit && <VisitPatientLine patient={visit} canChange={!once.locked} />}
      <p>{t('visit.followUp.of', { day: formatYmd(p.bookingDate), time: at ? formatClock(at.getTime()) : p.bookingTime,
        mode: p.consultationMode ? CONSULT_MODE_LABEL[p.consultationMode] : t('visit.consultation') })}</p>
      <p className="ws-muted">{t('visit.followUp.free')}</p>
      <section className="ws-section" aria-labelledby="vf-h">
        <h2 id="vf-h">{t('visit.followUp.how')}</h2>
        <div className="big-actions" role="group" aria-labelledby="vf-h">
          {FOLLOW_UP_MODES.filter((m) => m !== 'in-person' || branchIds.length > 0).map((m) => (
            <button key={m} type="button" className="big-action" aria-pressed={mode === m} disabled={once.locked}
              onClick={() => { setMode(m); setSlot(null); once.changed(); }}>{CONSULT_MODE_LABEL[m]}</button>
          ))}
        </div>
      </section>
      {mode && (
        <TimePicker key={mode} d={d} where={mode === 'in-person' ? { branchIds } : { mode }} slotId={slot?._id ?? null} disabled={once.locked}
          onPick={(s) => { setSlot(s); once.changed(); }} label={clock} />
      )}
      {once.error && <Alert tone={once.error.retry ? 'warn' : 'error'}>{once.error.text}</Alert>}
      {mode && slot && (
        <div className="ws-actions">
          <Button busy={once.busy} onClick={() => void once.send(async (requestKey) => {
            const r = await dash.bookConsultation({ slotId: slot._id, mode, followUpOf: parentId, requestKey });
            refresh();
            return r;
          })}>
            {once.error?.retry ? t('visit.sendAgain') : t('visit.followUp.book', { time: clock(slot), day: formatYmd(slot.date) })}
          </Button>
        </div>
      )}
    </>
  );
}
