import './doctor.css';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import {
  APPOINTMENT_STATUS_LABEL, appointmentStart, byPartner, CONSULT_MODE_LABEL, doctorDashboardApi, doctorStanding, INVOICE_STATES, istToday, OBJECT_ID_PATTERN, TODAY_PAGE_MAX,
  type ListedAppointment, type MyClinics, type TodayAnswer,
} from '@jansetu/api';
import { formatClock, formatPaise } from '@jansetu/i18n';
import { Alert, Badge, Button, ErrorState, Loading } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { useSession } from '../../session.tsx';
import { useFrontDesk, type FrontDesk } from '../front/desk.tsx';
import { BigActions, Failed, MoneyLine, PendingStrip, todayKey, Todos } from '../front/home.tsx';
import { openBill } from '../partner/billing.tsx';
import { feeLine } from '../partner/clinic.tsx';
import { usePartnerScope, type ScopeContext } from '../partner/scope.tsx';
import { offersKey, rupeesOf, useClinics, useDoctor, useDoctorProfile, useOwnedClinic, useUpcomingAppointments, type DoctorContext } from './doctor.tsx';
import { appointmentLabel } from './AppointmentsScreen.tsx';
import { useDoctorPresence } from './presence.tsx';
import { t } from '../../i18n/doctor/index.ts';

/**
 * WQ56 (P2, SIMPLE_DESIGN_PLAN_2026-11-26): the doctor's single dashboard. Big buttons (+ New, Find patient, Today, and
 * Bills only when he owns a clinic he can bill); today's appointments from every source in one time-ordered list with
 * chips (All · each clinic · Online · Booked by partners); what waits; what he earned today; his private to-dos; and his
 * standing with Jansetu (verified, available now, offers). Reads that need a verified, active doctor wait for it.
 */
export function DoctorHome() {
  const d = useDoctor();
  const desk = useFrontDesk();
  if (!d || !desk) return null;
  return <Dashboard key={d.identity} d={d} desk={desk} />;
}

function Dashboard({ d, desk }: { d: DoctorContext; desk: FrontDesk }) {
  const profile = useDoctorProfile(d);
  const standing = profile.data ? doctorStanding(profile.data) : null;
  const active = standing === 'active';
  return (
    <div className="simple">
      {active && <BigActions desk={desk} />}
      {active && <TodayAppointments d={d} desk={desk} />}
      <Status d={d} standing={standing} profileError={profile.isError ? profile.error : null} onRetry={() => void profile.refetch()} />
      <Todos desk={desk} />
    </div>
  );
}

/** His standing with Jansetu, "available now" and the offers waiting (the long way to each is the menu). */
function Status({ d, standing, profileError, onRetry }: { d: DoctorContext; standing: ReturnType<typeof doctorStanding> | null; profileError: unknown; onRetry: () => void }) {
  const presence = useDoctorPresence();
  const offers = useQuery({ queryKey: offersKey(d), queryFn: () => d.api.offers(), refetchInterval: 30_000, enabled: standing === 'active' });
  return (
    <section className="ws-section" aria-labelledby="status-h">
      <h2 id="status-h">{t('doctorHome.yourStatus')}</h2>
      {profileError ? <ErrorState message={messageOf(profileError)} onRetry={onRetry} /> : null}
      {standing === 'inactive' && <Alert>{t('doctorHome.yourDoctorAccountIsNot')}</Alert>}
      {standing === 'unverified' && <Alert tone="warn">{t('doctorHome.yourProfileIsWaitingFor')}</Alert>}
      <dl className="ws-dl">
        <dt>{t('common.verification')}</dt>
        <dd>{standing === null ? '…' : standing === 'active' ? <Badge tone="ok">{t('common.verified')}</Badge> : standing === 'inactive' ? <Badge tone="danger">{t('doctorHome.notActive')}</Badge> : <Badge tone="warn">{t('common.waitingForVerification')}</Badge>}</dd>
        <dt>{t('common.availableNow')}</dt>
        <dd>
          {presence.presence?.available
            ? <>{presence.live ? <Badge tone="ok">{t('common.on')}</Badge> : <Badge tone="warn">{t('common.onNotCheckedIn')}</Badge>} {presence.presence.modes.map((m) => CONSULT_MODE_LABEL[m]).join(', ')} · {rupeesOf(presence.presence.instantFeeMinor)}</>
            : presence.presence ? <Badge>{t('common.off')}</Badge> : presence.unconfirmed ? <Badge tone="warn">{t('common.notConfirmed')}</Badge>
            : presence.loading ? '…' : <Badge tone="warn">{t('doctorHome.couldNotBeRead')}</Badge>}
          {' '}<Link to="/doctor/consult-now">{t('common.consultNow')}</Link>
        </dd>
        {standing === 'active' && (
          <>
            <dt>{t('doctorHome.offersWaiting')}</dt>
            <dd>{offers.isPending ? '…' : offers.isError ? messageOf(offers.error) : offers.data.length === 0 ? t('doctorHome.none') : <Link to="/doctor/consult-now">{t('doctorHome.openOffers', { count: offers.data.length })}</Link>}</dd>
          </>
        )}
      </dl>
    </section>
  );
}

/** The whole day's register (every page, oldest first): the patients' names, the money, what waits. */
async function wholeDay(desk: FrontDesk, date: string): Promise<TodayAnswer> {
  const first = await desk.today.today({ date, order: 'asc', limit: TODAY_PAGE_MAX });
  let items = first.items;
  let cursor = first.nextCursor;
  for (let n = 0; cursor && n < 10; n += 1) {
    const next = await desk.today.today({ date, cursor, order: 'asc', limit: TODAY_PAGE_MAX });
    items = [...items, ...next.items];
    cursor = next.nextCursor;
  }
  return { ...first, items, nextCursor: cursor };
}

type Chip = { id: string; label: string; test: (a: ListedAppointment) => boolean };

/** The chips: All, each clinic he consults at (and any other clinic on today's list), Online, Booked by partners. */
function chipsOf(clinics: MyClinics | undefined, rows: readonly ListedAppointment[]): Chip[] {
  const named = new Map<string, string>();
  for (const c of clinics?.clinics ?? []) named.set(c.partnerId.toLowerCase(), c.name ?? t('dash.clinicUnnamed'));
  for (const a of rows) if (a.clinic && !named.has(a.clinic.id.toLowerCase())) named.set(a.clinic.id.toLowerCase(), a.clinic.name ?? t('dash.clinicUnnamed'));
  return [
    { id: 'all', label: t('dash.chip.all'), test: () => true },
    ...[...named].map(([id, label]) => ({ id: `clinic:${id}`, label, test: (a: ListedAppointment) => a.clinic?.id.toLowerCase() === id })),
    { id: 'online', label: t('dash.chip.online'), test: (a: ListedAppointment) => a.channel === 'online' },
    { id: 'partners', label: t('dash.chip.partners'), test: (a: ListedAppointment) => byPartner(a.source) },
  ];
}

/** Where an appointment came from, in words (truthful: who booked it, and where it is). */
function sourceWords(a: ListedAppointment): string {
  const clinic = a.clinic ? a.clinic.name ?? t('dash.clinicUnnamed') : null;
  // r39c: he booked it himself (a clinic appointment, or an online consultation).
  if (a.bookedByMe || a.source === 'doctor_assisted') return clinic ? t('dash.source.youAt', { clinic }) : t('dash.source.you');
  switch (a.source) {
    case 'clinic_desk': return t('dash.source.at', { clinic: clinic ?? t('dash.clinicUnnamed') });
    case 'pharmacy_assisted': return a.paidBy ? t('dash.source.bookedBy', { name: a.paidBy }) : t('dash.source.pharmacy');
    case 'lab_assisted': return a.paidBy ? t('dash.source.bookedBy', { name: a.paidBy }) : t('dash.source.lab');
    case 'instant': return t('dash.source.instant');
    default: return clinic ? t('dash.source.appAt', { clinic }) : t('dash.source.app');
  }
}

function TodayAppointments({ d, desk }: { d: DoctorContext; desk: FrontDesk }) {
  const { api } = useSession();
  const dash = useMemo(() => doctorDashboardApi(api), [api]);
  const day = istToday();
  const clinics = useClinics(d);
  const { owned } = useOwnedClinic(d.user.id);
  const ctx = usePartnerScope();
  const list = useQuery({ queryKey: [...d.key, 'dash', 'list', day], queryFn: () => dash.appointments({ from: day, to: day }), staleTime: 0, refetchOnMount: 'always' });
  const reg = useQuery({ queryKey: [...todayKey(desk, day), 'doctor-day'], queryFn: () => wholeDay(desk, day), staleTime: 0, refetchOnMount: 'always' });
  const next = useUpcomingAppointments(d, 14);
  const [chip, setChip] = useState('all');
  const rows = list.data?.items ?? [];
  const chips = chipsOf(clinics.data, rows);
  const shown = rows.filter((chips.find((c) => c.id === chip) ?? chips[0]!).test);
  const items = reg.data?.items ?? [];
  // The patient seen at each appointment, from the register (the list has no names).
  const names = new Map(items.filter((i) => i.kind === 'appointment').map((i) => [i.id.toLowerCase(), i.patientName]));
  const ownId = owned?.partnerId.toLowerCase();
  const coming = rows.length === 0 && list.data ? next.items.find((b) => (b.status === 'confirmed' || b.status === 'pending') && b.bookingDate > day.replace(/-/g, '')) : undefined;
  return (
    <section className="ws-section" aria-labelledby="appts-h">
      <h2 id="appts-h">{t('dash.appointments')}</h2>
      {reg.data && <p className="earned-line">{t('dash.earnedToday', { amount: formatPaise(reg.data.totals.earnedMinor ?? 0) })}</p>}
      {/* His own clinic's bills of the day: collected and still to collect (only when he owns one and it has any). */}
      {reg.data && owned && (items.some((i) => i.kind === 'bill') || reg.data.totals.collectedMinor > 0 || reg.data.totals.unpaidMinor > 0) && <MoneyLine day={reg.data} date={day} />}
      {!reg.data ? (reg.isError ? <Failed error={reg.error} onRetry={() => void reg.refetch()} /> : <Loading label={t('dash.loading')} />)
        : <PendingStrip day={reg.data} desk={desk} />}
      <div className="chips" role="group" aria-label={t('dash.chip.label')}>
        {chips.map((c) => <button key={c.id} type="button" className="chip" aria-pressed={chip === c.id} onClick={() => setChip(c.id)}>{c.label}</button>)}
      </div>
      {!list.data ? (list.isError ? <Failed error={list.error} onRetry={() => void list.refetch()} /> : <Loading label={t('common.loadingAppointments')} />)
        : shown.length === 0 ? (
          <>
            <p className="ws-muted">{rows.length === 0 ? t('dash.none') : t('dash.noneHere')}</p>
            {coming && <p>{t('dash.next', { when: appointmentLabel(coming), mode: coming.consultationMode ? CONSULT_MODE_LABEL[coming.consultationMode] : t('doctorHome.consultation') })}</p>}
          </>
        )
        : (
          <ul className="appt-list" aria-label={t('dash.appointments')}>
            {shown.map((a) => {
              const at = appointmentStart(a);
              const time = at ? formatClock(at.getTime()) : a.bookingTime;
              const name = names.get(a._id.toLowerCase()) ?? null;
              const deskRow = a.clinicDesk;
              return (
                <li key={a._id} className="appt-row">
                  {/* The row opens the appointment (join, mark done, records) on Appointments. */}
                  <Link className="appt-open" to={`/doctor/appointments?open=${a._id}`}>
                    <span className="appt-time">{time}</span> <span className="appt-who">{name ?? t('dash.noName')}</span>
                  </Link>
                  <span>{a.consultationMode ? CONSULT_MODE_LABEL[a.consultationMode] : t('doctorHome.consultation')}</span>
                  <span className="appt-source">{sourceWords(a)}</span>
                  <Badge tone={a.status === 'pending' ? 'warn' : a.status === 'confirmed' || a.status === 'completed' ? 'ok' : undefined}>{APPOINTMENT_STATUS_LABEL[a.status] ?? a.status}</Badge>
                  {a.status === 'pending' && a.paymentStatus !== 'paid' && a.source === 'doctor_assisted' && <span className="ws-muted">{t('dash.payInApp')}</span>}
                  {ctx?.scope.kind === 'doctor' && deskRow && deskRow.partnerId.toLowerCase() === ownId && a.status !== 'cancelled' && (
                    <AppointmentBillAction ctx={ctx} d={d} appointment={a} branchId={deskRow.branchId} name={name} time={time} />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      {list.data?.truncated && <Alert tone="warn">{t('dash.truncated')}</Alert>}
      <p><Link to="/doctor/appointments">{t('doctorHome.allAppointments')}</Link></p>
    </section>
  );
}

/** r39c does not attach bill state to appointment rows. Its invoice filter works across issue dates. */
async function findAppointmentBill(ctx: ScopeContext, appointmentId: string) {
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await ctx.billing.invoices({ appointmentId, limit: 25, cursor });
    if (page.items.some((invoice) => !invoice || typeof invoice.appointmentId !== 'string'
      || invoice.appointmentId.toLowerCase() !== appointmentId.toLowerCase()
      || !OBJECT_ID_PATTERN.test(invoice._id) || !INVOICE_STATES.includes(invoice.lifecycleState))) {
      throw new Error(); // The UI offers Retry without relying on an unverified bill.
    }
    const bill = page.items.find((invoice) => invoice.lifecycleState !== 'cancelled');
    if (bill) return { invoiceId: bill._id, state: bill.lifecycleState };
    cursor = page.nextCursor ?? undefined;
    if (cursor) {
      if (seen.has(cursor)) throw new Error();
      seen.add(cursor);
    }
  } while (cursor);
  return null;
}

function AppointmentBillAction({ ctx, d, appointment: a, branchId, name, time }: {
  ctx: ScopeContext; d: DoctorContext; appointment: ListedAppointment; branchId: string; name: string | null; time: string;
}) {
  const { memory } = useSession();
  const navigate = useNavigate();
  const linked = useQuery({
    queryKey: [...ctx.key, 'invoices', 'appointment', a._id],
    queryFn: () => findAppointmentBill(ctx, a._id),
    enabled: a.bill === undefined,
    retry: false,
    staleTime: 0,
  });
  const bill = a.bill === undefined ? linked.data : a.bill;
  if (a.bill === undefined && linked.isError) return <Failed error={linked.error} onRetry={() => void linked.refetch()} />;
  if (bill === undefined || (a.bill === undefined && linked.isFetching)) return <Loading label={t('dash.checkingBill')} />;
  if (bill && bill.state !== 'cancelled') {
    return <Link className="j-btn j-btn--secondary" to={`/doctor/clinic/invoices/${bill.invoiceId}`}>{bill.state === 'paid' ? t('dash.billPaid') : t('dash.billed')}</Link>;
  }
  return (
    <Button variant="secondary" onClick={() => openBill(ctx, memory, {
      link: { kind: 'appointment', id: a._id }, branchId, doctorId: d.user.id,
      name: a.customer?.name?.trim() || (a.dependentId ? '' : name ?? ''), phone: a.customer?.phone ?? '',
      label: name ? `${time} · ${name}` : time, simple: true,
      ...(a.price ? { handLines: [feeLine(d.user.name, a.price)] } : {}),
    }, navigate)}>{t('dash.bill')}</Button>
  );
}
