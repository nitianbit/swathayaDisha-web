import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CONSULT_MODE_LABEL, CONSULT_MODES, DOCTOR_ROLLING_DAYS, fromYmd, isRealDate, istDateOf, SCHEDULE_MINUTES_MAX, SCHEDULE_MINUTES_MIN,
  SCHEDULE_WEEKDAYS, SCHEDULE_WINDOWS_MAX, schedulableBranches, scheduleProblems, scheduleSlotCount, WEEKDAYS,
  type ConsultMode, type DoctorSchedule, type MyClinics, type ScheduleExpansion, type ScheduleInput, type ScheduleWindow, type Weekday,
} from '@jansetu/api';
import { Alert, Button, ErrorState, Loading, TextField } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { staleMessage, useDraft } from '../../draft.ts';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { definitelyNotRecorded } from '../../requests.ts';
import { formatDay } from '../partner/labs.tsx';
import { NotADoctor, useClinics, useDoctor, type DoctorContext } from './doctor.tsx';
import { t } from '../../i18n/doctor/index.ts';

const DAY_LABEL = Object.fromEntries(WEEKDAYS.map((d) => [d.value, d.label])) as Record<Weekday, string>;
const expansionText = (x: ScheduleExpansion) =>
  t('schedule.nextDaysSlotsAddedChanged', { DOCTOR_ROLLING_DAYS, inserted: x.inserted, updated: x.updated, closed: x.closed, reopened: x.reopened });

/** The doctor's weekly template (modes per window, in-person windows at a clinic branch) and leave days (Q4a). */
export function ScheduleScreen() {
  const d = useDoctor();
  if (!d) return <NotADoctor />;
  return <Schedule key={d.identity} d={d} />;
}

const scheduleKey = (d: DoctorContext) => [...d.key, 'schedule'];

function Schedule({ d }: { d: DoctorContext }) {
  const schedule = useQuery({ queryKey: scheduleKey(d), queryFn: () => d.api.schedule() });
  const clinics = useClinics(d);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <>
      <PageHeading title={t('schedule.schedule')}>{t('schedule.yourWeeklyHoursAndLeave')}{DOCTOR_ROLLING_DAYS}{t('schedule.daysTimesAreIndiaTime')}</PageHeading>
      {notice && <Alert tone="ok">{notice}</Alert>}
      {schedule.isPending || clinics.isPending ? <Loading label={t('schedule.loadingYourSchedule')} />
        : schedule.isError ? <ErrorState message={messageOf(schedule.error)} onRetry={() => void schedule.refetch()} />
        : clinics.isError ? <ErrorState message={messageOf(clinics.error)} onRetry={() => void clinics.refetch()} />
        : (
          <>
            <section className="ws-section" aria-labelledby="week-h">
              <h2 id="week-h">{t('schedule.weeklyHours')}</h2>
              {editing
                ? <TemplateForm d={d} saved={schedule.data} clinics={clinics.data} onClose={() => setEditing(false)}
                    onSaved={(m) => { setEditing(false); setNotice(m); }} />
                : (
                  <>
                    <WeekSummary schedule={schedule.data} clinics={clinics.data} />
                    <div className="ws-actions"><Button onClick={() => { setEditing(true); setNotice(null); }}>{t('schedule.changeWeeklyHours')}</Button></div>
                  </>
                )}
            </section>
            <LeaveDays d={d} schedule={schedule.data} />
          </>
        )}
    </>
  );
}

function placeName(w: Pick<ScheduleWindow, 'branchId'>, clinics: MyClinics): string {
  if (!w.branchId) return '';
  for (const c of clinics.clinics) {
    const b = c.branches.find((x) => x.branchId === w.branchId);
    if (b) return ` at ${c.name ?? 'a clinic'} · ${b.name}`;
  }
  return ' at a clinic branch you no longer consult at';
}

function WeekSummary({ schedule, clinics }: { schedule: DoctorSchedule | null; clinics: MyClinics }) {
  if (!schedule || SCHEDULE_WEEKDAYS.every((day) => !(schedule.days[day] ?? []).length)) {
    return <p className="ws-muted">{t('schedule.noWeeklyHoursYetPatients')}</p>;
  }
  return (
    <>
      <p className="ws-muted">{schedule.slotMinutes}{t('schedule.minuteSlots')}{schedule.isActive === false ? ' · the template is switched off' : ''}.</p>
      <ul className="ws-list" aria-label={t('schedule.weeklyHours')}>
        {SCHEDULE_WEEKDAYS.map((day) => {
          const windows = schedule.days[day] ?? [];
          return (
            <li key={day}>
              <strong>{DAY_LABEL[day]}:</strong>{' '}
              {windows.length === 0 ? 'off' : windows.map((w) => `${w.start}–${w.end} (${w.modes.map((m) => CONSULT_MODE_LABEL[m] ?? m).join(', ')}${placeName(w, clinics)})`).join('; ')}
            </li>
          );
        })}
      </ul>
    </>
  );
}

// ── Weekly template editor ──

type TemplateDraft = { slotMinutes: string } & Record<Weekday, ScheduleWindow[]>;
const DRAFT_LABEL: Record<keyof TemplateDraft, string> = {
  slotMinutes: 'slot length',
  ...Object.fromEntries(SCHEDULE_WEEKDAYS.map((d) => [d, `${DAY_LABEL[d]} hours`])) as Record<Weekday, string>,
};
const cleanWindow = (w: ScheduleWindow): ScheduleWindow => ({ start: w.start, end: w.end, modes: [...w.modes], ...(w.branchId ? { branchId: w.branchId } : {}) });
const toDraft = (schedule: DoctorSchedule | null): TemplateDraft => ({
  slotMinutes: String(schedule?.slotMinutes ?? 30),
  ...Object.fromEntries(SCHEDULE_WEEKDAYS.map((d) => [d, (schedule?.days[d] ?? []).map(cleanWindow)])) as Record<Weekday, ScheduleWindow[]>,
});
const fromDraft = (d: TemplateDraft): ScheduleInput => ({
  slotMinutes: /^\d{1,3}$/.test(d.slotMinutes.trim()) ? Number(d.slotMinutes.trim()) : NaN,
  days: Object.fromEntries(SCHEDULE_WEEKDAYS.map((day) => [day, d[day].map(cleanWindow)])),
});

function TemplateForm({ d, saved, clinics, onClose, onSaved }: {
  d: DoctorContext; saved: DoctorSchedule | null; clinics: MyClinics; onClose: () => void; onSaved: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const draft = useDraft(() => toDraft(saved));
  const { rebaseTo } = draft;
  const places = useMemo(() => schedulableBranches(clinics), [clinics]);
  const allowed = useMemo(() => new Set(places.map((p) => p.branchId)), [places]);
  const unverified = clinics.clinics.filter((c) => !c.verified && c.branches.length > 0);
  const [errors, setErrors] = useState<Partial<Record<keyof TemplateDraft, string>>>({});
  const [stale, setStale] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  // A refetch moves untouched days along; a day changed here and on the server is reset with a notice.
  const serverValue = JSON.stringify(toDraft(saved));
  useEffect(() => {
    const c = rebaseTo(JSON.parse(serverValue) as TemplateDraft);
    if (c.length) { setStale(staleMessage(c.map((k) => DRAFT_LABEL[k]))); setConfirming(false); }
  }, [serverValue, rebaseTo]);

  const tpl = draft.draft;
  const body = fromDraft(tpl);

  function check(): boolean {
    const p = scheduleProblems(fromDraft(draft.current().draft), allowed);
    setErrors(p);
    return Object.keys(p).length === 0;
  }

  function review(e: FormEvent) {
    e.preventDefault();
    setFailure(null);
    setStale(null);
    if (check()) setConfirming(true);
  }

  async function save() {
    setBusy(true);
    setFailure(null);
    try {
      // Read again right before replacing it: a change saved elsewhere since this form opened is shown, not overwritten.
      const fresh = await queryClient.fetchQuery({ queryKey: scheduleKey(d), queryFn: () => d.api.schedule(), staleTime: 0 });
      const conflicts = rebaseTo(toDraft(fresh));
      if (conflicts.length) { setStale(staleMessage(conflicts.map((k) => DRAFT_LABEL[k]))); setConfirming(false); return; }
      if (!check()) { setConfirming(false); return; }
      // Q13: the write names the version it is based on; a change landing after this read is refused (409 SCHEDULE_CHANGED).
      const r = await d.api.saveSchedule(fromDraft(draft.current().draft), fresh ? fresh.updatedAt ?? null : null);
      queryClient.setQueryData(scheduleKey(d), r.template);
      onSaved(t('schedule.weeklyHoursSaved', { value: expansionText(r.expansion) }));
    } catch (err) {
      // A refusal (also SCHEDULE_CHANGED: the hours are read again below and a day changed on both sides is reset) saved
      // nothing. After a lost answer the hours are read again too: if they were saved, the form already shows them.
      setFailure(definitelyNotRecorded(err) ? t('common.notSaved', { value: messageOf(err) })
        : t('schedule.itMayHaveBeenSaved', { value: messageOf(err) }));
      setConfirming(false);
    } finally {
      setBusy(false);
      void queryClient.invalidateQueries({ queryKey: scheduleKey(d) });
    }
  }

  const edit = (day: Weekday, i: number, fn: (w: ScheduleWindow) => ScheduleWindow) =>
    draft.update((x) => ({ ...x, [day]: x[day].map((w, j) => (j === i ? fn(w) : w)) }));
  const toggleMode = (day: Weekday, i: number, m: ConsultMode, on: boolean) =>
    edit(day, i, (w) => ({ ...w, modes: on ? CONSULT_MODES.filter((x) => x === m || w.modes.includes(x)) : w.modes.filter((x) => x !== m) }));
  const setPlace = (day: Weekday, i: number, branchId: string) =>
    edit(day, i, (w) => (branchId ? { start: w.start, end: w.end, modes: ['in-person'], branchId } : { start: w.start, end: w.end, modes: w.modes }));

  return (
    <form className="rx-form" noValidate onSubmit={review} aria-label={t('schedule.weeklyHours')}>
      <p className="ws-muted">{t('schedule.eachWindowIsCutInto')}</p>
      {places.length === 0 && (
        <p className="ws-muted">{t('schedule.youDoNotConsultAt')}</p>
      )}
      {unverified.length > 0 && (
        <p className="ws-muted">{t('schedule.notOfferedUntilJansetuVerifies')}{unverified.length === 1 ? 'it' : 'them'}: {unverified.map((c) => c.name ?? 'a clinic').join(', ')}.
        </p>
      )}
      <div className="rx-form-row">
        <TextField label={t('schedule.slotLengthMinutes')} inputMode="numeric" value={tpl.slotMinutes} error={errors.slotMinutes} disabled={confirming}
          hint={`${SCHEDULE_MINUTES_MIN} to ${SCHEDULE_MINUTES_MAX}`} onChange={(e) => draft.set('slotMinutes', e.target.value)} />
      </div>
      {SCHEDULE_WEEKDAYS.map((day) => {
        const count = scheduleSlotCount(body, day);
        return (
          <fieldset key={day} className="ws-line" aria-describedby={errors[day] ? `sch-${day}-err` : undefined}>
            <legend>{DAY_LABEL[day]}: {tpl[day].length === 0 ? 'off' : `${count} ${count === 1 ? 'slot' : 'slots'}`}</legend>
            {tpl[day].map((w, i) => {
              const name = `${DAY_LABEL[day]} window ${i + 1}`;
              const known = !w.branchId || places.some((p) => p.branchId === w.branchId);
              return (
                <div key={i} className="doc-window">
                  <div className="ws-window">
                    <TextField label={`${name} from`} type="time" value={w.start} disabled={confirming} onChange={(e) => edit(day, i, (x) => ({ ...x, start: e.target.value }))} />
                    <TextField label={`${name} to`} type="time" value={w.end} disabled={confirming} onChange={(e) => edit(day, i, (x) => ({ ...x, end: e.target.value }))} />
                    <Button variant="ghost" disabled={confirming} aria-label={t('schedule.remove', { name })}
                      onClick={() => draft.update((x) => ({ ...x, [day]: x[day].filter((_, j) => j !== i) }))}>{t('schedule.remove2')}</Button>
                  </div>
                  <div className="j-field ws-filter">
                    <label htmlFor={`place-${day}-${i}`}>{name}{t('schedule.place')}</label>
                    <select id={`place-${day}-${i}`} value={w.branchId ?? ''} disabled={confirming} onChange={(e) => setPlace(day, i, e.target.value)}>
                      <option value="">{t('schedule.onlineOrYourOwnPlace')}</option>
                      {places.map((p) => <option key={p.branchId} value={p.branchId}>{t('schedule.clinic')}{p.label}</option>)}
                      {!known && <option value={w.branchId}>{t('schedule.aClinicBranchYouNo')}</option>}
                    </select>
                  </div>
                  <fieldset className="ws-checks doc-modes">
                    <legend>{name}{t('schedule.consultationTypes')}</legend>
                    {CONSULT_MODES.map((m) => (
                      <label key={m} className="ws-check">
                        <input type="checkbox" checked={w.modes.includes(m)} disabled={confirming || !!w.branchId}
                          onChange={(e) => toggleMode(day, i, m, e.target.checked)} />
                        {CONSULT_MODE_LABEL[m]}
                      </label>
                    ))}
                    {w.branchId && <span className="ws-muted">{t('schedule.clinicWindowsAreInPerson')}</span>}
                  </fieldset>
                </div>
              );
            })}
            {errors[day] && <span id={`sch-${day}-err`} className="j-field__error">{errors[day]}</span>}
            <div>
              <Button variant="secondary" disabled={confirming || tpl[day].length >= SCHEDULE_WINDOWS_MAX} aria-label={t('schedule.addAWindowOn', { value: DAY_LABEL[day] })}
                onClick={() => draft.update((x) => ({ ...x, [day]: [...x[day], { start: '', end: '', modes: ['video'] }] }))}>{t('schedule.addAWindow')}</Button>
            </div>
          </fieldset>
        );
      })}
      {stale && <Alert tone="warn">{stale}</Alert>}
      {failure && <Alert>{failure}</Alert>}
      {!confirming ? (
        <div className="confirm-actions">
          <Button type="submit">{t('schedule.reviewTheWeeklyHours')}</Button>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
        </div>
      ) : (
        <div className="confirm" role="group" aria-label={t('schedule.saveTheWeeklyHours')}>
          <div className="confirm-text">{t('schedule.replaceYourWeeklyHours')}{body.slotMinutes}{t('schedule.minuteSlots2')}<ul className="ws-list">
              {SCHEDULE_WEEKDAYS.map((day) => (
                <li key={day}>{DAY_LABEL[day]}: {tpl[day].length === 0 ? 'off'
                  : tpl[day].map((w) => `${w.start}–${w.end} (${w.modes.map((m) => CONSULT_MODE_LABEL[m]).join(', ')}${placeName(w, clinics)})`).join('; ')}</li>
              ))}
            </ul>{t('schedule.overTheNext')}{DOCTOR_ROLLING_DAYS}{t('schedule.daysMissingSlotsAreAdded')}</div>
          <div className="confirm-actions">
            <Button busy={busy} onClick={() => void save()}>{t('schedule.saveTheWeeklyHours')}</Button>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>{t('common.back')}</Button>
          </div>
        </div>
      )}
    </form>
  );
}

// ── Leave days ──

function LeaveDays({ d, schedule }: { d: DoctorContext; schedule: DoctorSchedule | null }) {
  const queryClient = useQueryClient();
  const today = istDateOf(new Date());
  const dates = (schedule?.leaveDates ?? []).map(fromYmd).filter((x): x is string => !!x).sort();
  const upcoming = dates.filter((x) => x >= today);
  const past = dates.length - upcoming.length;
  const [date, setDate] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const done = (message: string, template: DoctorSchedule) => {
    queryClient.setQueryData(scheduleKey(d), template);
    void queryClient.invalidateQueries({ queryKey: scheduleKey(d) });
    setNotice(message);
  };

  function review(e: FormEvent) {
    e.preventDefault();
    setFailure(null);
    setNotice(null);
    if (!isRealDate(date)) { setFieldError(t('schedule.chooseADate')); return; }
    if (date < today) { setFieldError(t('schedule.chooseTodayOrALater')); return; }
    if (upcoming.includes(date)) { setFieldError(t('schedule.thisIsAlreadyALeave')); return; }
    setFieldError(null);
    setReviewing(date);
  }

  async function add(day: string) {
    setBusy(true);
    setFailure(null);
    try {
      const r = await d.api.addLeave(day);
      setReviewing(null);
      setDate('');
      done(t('schedule.isALeaveDayOpen', { when: formatDay(day), closed: r.expansion.closed, value: r.expansion.closed === 1 ? 'slot' : 'slots' }), r.template);
    } catch (err) {
      // Marking the same day again changes nothing on the server, so trying again is safe.
      setFailure(definitelyNotRecorded(err) ? messageOf(err) : t('schedule.itMayHaveBeenRecorded', { value: messageOf(err) }));
      void queryClient.invalidateQueries({ queryKey: scheduleKey(d) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ws-section" aria-labelledby="leave-h">
      <h2 id="leave-h">{t('schedule.leaveDays')}</h2>
      <p className="ws-muted">{t('schedule.onALeaveDayNobody')}</p>
      {notice && <Alert tone="ok">{notice}</Alert>}
      {upcoming.length === 0 ? <p className="ws-muted">{t('schedule.noLeaveDaysAhead')}</p> : (
        <ul className="ws-list" aria-label={t('schedule.upcomingLeaveDays')}>
          {upcoming.map((day) => (
            <li key={day} className="ws-actions">
              <span>{formatDay(day)}</span>
              <ConfirmAction label={t('schedule.remove2')} confirmLabel={t('schedule.removeLeaveOn', { when: formatDay(day) })}
                consequence={<>{t('schedule.removeTheLeaveOn')}{formatDay(day)}{t('schedule.slotsOfYourWeeklyHours')}</>}
                onConfirm={async () => {
                  setNotice(null);
                  try {
                    const r = await d.api.removeLeave(day);
                    done(t('schedule.leaveOnRemovedReopened', { when: formatDay(day), reopened: r.expansion.reopened, value: r.expansion.reopened === 1 ? 'slot' : 'slots' }), r.template);
                  } finally {
                    void queryClient.invalidateQueries({ queryKey: scheduleKey(d) });
                  }
                }} />
            </li>
          ))}
        </ul>
      )}
      {past > 0 && <p className="ws-muted">{past}{t('schedule.earlierLeave')}{past === 1 ? 'day' : 'days'}{t('schedule.notShown')}</p>}
      {reviewing ? (
        <div className="confirm" role="group" aria-label={t('schedule.addALeaveDay')}>
          <div className="confirm-text">{t('schedule.takeLeaveOn')}{formatDay(reviewing)}{t('schedule.nobodyCanBookYouThat')}</div>
          {failure && <Alert>{failure}</Alert>}
          <div className="confirm-actions">
            <Button busy={busy} onClick={() => void add(reviewing)}>{t('schedule.takeLeaveOn')}{formatDay(reviewing)}</Button>
            <Button variant="ghost" disabled={busy} onClick={() => { setReviewing(null); setFailure(null); }}>{t('common.back')}</Button>
          </div>
        </div>
      ) : (
        <form className="ws-search" noValidate onSubmit={review} aria-label={t('schedule.addALeaveDay')}>
          <TextField label={t('schedule.leaveDate')} type="date" min={today} value={date} error={fieldError} onChange={(e) => setDate(e.target.value)} />
          <Button type="submit" variant="secondary">{t('schedule.addALeaveDay')}</Button>
        </form>
      )}
    </section>
  );
}
