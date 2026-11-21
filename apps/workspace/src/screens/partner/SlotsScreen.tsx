import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addDays, capacityProblem, holdsAny, istDateOf, isTemplateChanged, LAB_VISIT_MODE_LABEL, manualSlotProblems, MAX_WINDOWS_PER_DAY,
  mondayOf, reopenable, ROLLING_DAYS, SLOT_CLOSURE_LABEL, SLOT_SEATS_MAX, slotTimesFor, templateInput, TEMPLATE_WEEKDAYS, templateProblems, WEEKDAYS,
  type Branch, type LabSlot, type SlotTemplate, type SlotTemplateInput, type SlotWindow, type TemplateVersion, type VisitMode, type Weekday,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, Loading, TextField } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { staleMessage, useDraft } from '../../draft.ts';
import { messageOf } from '../../errors.ts';
import { definitelyNotRecorded } from '../../requests.ts';
import { formatDay, LabOnly, modesOf, slotLabel, useNow, useScopedBranches } from './labs.tsx';
import { NoSuchPartner, PartnerPageHeading, scopeIdentity, usePartnerScope, useWorkspacePartner, type ScopeContext } from './scope.tsx';

const DAY_LABEL = Object.fromEntries(WEEKDAYS.map((d) => [d.value, d.label])) as Record<Weekday, string>;

/** Server-owned lab slots of one branch and visit mode, a week at a time; `slots.manage` edits them. */
export function SlotsScreen() {
  const ctx = usePartnerScope();
  if (!ctx) return <NoSuchPartner />;
  // One subtree per partner: an admin moving to another partner starts with no editor or confirmation open.
  return <Slots key={scopeIdentity(ctx)} ctx={ctx} />;
}

function Slots({ ctx }: { ctx: ScopeContext }) {
  const partner = useWorkspacePartner(ctx);
  const canManage = holdsAny(ctx.actor, ['slots.manage']);
  return (
    <>
      <PartnerPageHeading ctx={ctx} title="Slots" partnerName={partner.data?.name}>
        Times customers can book, per branch and visit type. Slots come from the weekly template for the next {ROLLING_DAYS} days;
        {canManage ? ' you can add one-off slots, change seats, and close or reopen a slot.' : ' you can view them.'}
      </PartnerPageHeading>
      <LabOnly ctx={ctx}><Schedule ctx={ctx} canManage={canManage} /></LabOnly>
    </>
  );
}

function Schedule({ ctx, canManage }: { ctx: ScopeContext; canManage: boolean }) {
  const branches = useScopedBranches(ctx);
  const usable = branches.inScope.filter((b) => modesOf(b).length > 0);
  const [branchId, setBranchId] = useState('');
  const [mode, setMode] = useState<VisitMode | ''>('');
  const branch = usable.find((b) => b._id === branchId) ?? usable[0];
  const modes = branch ? modesOf(branch) : [];
  const visitMode = modes.includes(mode as VisitMode) ? (mode as VisitMode) : modes[0];

  if (branches.isPending) return <Loading label="Loading branches…" />;
  if (branches.isError) return <ErrorState message={messageOf(branches.error)} onRetry={() => void branches.refetch()} />;
  if (!branch || !visitMode) {
    return <Empty title="No branch takes bookings">None of your branches offers home collection or lab visits. Turn them on under Branches.</Empty>;
  }
  return (
    <>
      <div className="ws-search">
        <div className="j-field ws-filter">
          <label htmlFor="slot-branch">Branch</label>
          <select id="slot-branch" value={branch._id} onChange={(e) => setBranchId(e.target.value)}>
            {usable.map((b) => <option key={b._id} value={b._id}>{b.name}</option>)}
          </select>
        </div>
        <div className="j-field ws-filter">
          <label htmlFor="slot-mode">Visit type</label>
          <select id="slot-mode" value={visitMode} onChange={(e) => setMode(e.target.value as VisitMode)}>
            {modes.map((m) => <option key={m} value={m}>{LAB_VISIT_MODE_LABEL[m]}</option>)}
          </select>
        </div>
      </div>
      {/* One subtree per branch and visit type: an open template edit or manual slot never moves to another schedule. */}
      <BranchSchedule key={`${branch._id}:${visitMode}`} ctx={ctx} branch={branch} mode={visitMode} canManage={canManage} />
    </>
  );
}

function BranchSchedule({ ctx, branch, mode, canManage }: { ctx: ScopeContext; branch: Branch; mode: VisitMode; canManage: boolean }) {
  const today = istDateOf(new Date());
  const [week, setWeek] = useState(() => mondayOf(today));
  // Each opened editor gets its own generation; an answer that arrives after another editor was opened (or this one was
  // reopened) still reports what happened, but never closes the newer editor or moves the week.
  const [open, setOpen] = useState<{ kind: 'template' | 'slot'; gen: number } | null>(null);
  const generation = useRef(0);
  const [notice, setNotice] = useState<string | null>(null);
  const where = `${LAB_VISIT_MODE_LABEL[mode].toLowerCase()} at ${branch.name}`;
  const openEditor = (kind: 'template' | 'slot') => { generation.current += 1; setOpen({ kind, gen: generation.current }); setNotice(null); };
  const current = (gen: number) => generation.current === gen;
  const closeIf = (gen: number) => { if (current(gen)) setOpen(null); };
  return (
    <>
      {notice && <Alert tone="ok">{notice}</Alert>}
      {canManage && (
        <div className="ws-actions">
          {open?.kind !== 'template' && <Button variant="secondary" onClick={() => openEditor('template')}>Edit the weekly template</Button>}
          {open?.kind !== 'slot' && <Button variant="secondary" onClick={() => openEditor('slot')}>Add a one-off slot</Button>}
        </div>
      )}
      {canManage && open?.kind === 'template' && (() => {
        const gen = open.gen;
        return (
          <TemplateEditor key={gen} ctx={ctx} branch={branch} mode={mode} where={where} onClose={() => closeIf(gen)}
            onSaved={(m) => { closeIf(gen); setNotice(m); }} />
        );
      })()}
      {canManage && open?.kind === 'slot' && (() => {
        const gen = open.gen;
        return (
          <ManualSlotForm key={gen} ctx={ctx} branch={branch} mode={mode} defaultDate={week < today ? today : week} onClose={() => closeIf(gen)}
            onAdded={(s) => {
              if (current(gen)) { setOpen(null); setWeek(mondayOf(s.date)); }
              setNotice(`Slot ${slotLabel(s)} added with ${s.capacity} ${s.capacity === 1 ? 'seat' : 'seats'}.`);
            }} />
        );
      })()}
      <section className="ws-section" aria-labelledby="week-h">
        <h2 id="week-h">Week of {formatDay(week)}</h2>
        <div className="ws-actions">
          <Button variant="secondary" onClick={() => setWeek(addDays(week, -7))}>Previous week</Button>
          <Button variant="secondary" disabled={week === mondayOf(today)} onClick={() => setWeek(mondayOf(today))}>This week</Button>
          <Button variant="secondary" onClick={() => setWeek(addDays(week, 7))}>Next week</Button>
        </div>
        {/* Keyed by week: an open capacity change or confirmation belongs to the week it was opened in. */}
        <WeekView key={week} ctx={ctx} branch={branch} mode={mode} week={week} canManage={canManage} />
      </section>
    </>
  );
}

const slotsKey = (ctx: ScopeContext, branchId: string, mode: VisitMode, from: string, to: string) => [...ctx.key, 'slots', branchId, mode, from, to];

function WeekView({ ctx, branch, mode, week, canManage }: { ctx: ScopeContext; branch: Branch; mode: VisitMode; week: string; canManage: boolean }) {
  const queryClient = useQueryClient();
  const to = addDays(week, 6);
  const q = useQuery({
    queryKey: slotsKey(ctx, branch._id, mode, week, to),
    queryFn: () => ctx.labs.slots({ branchId: branch._id, visitMode: mode, from: week, to }),
  });
  const now = useNow();
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const refresh = () => queryClient.invalidateQueries({ queryKey: [...ctx.key, 'slots'] });
  const changed = (message: string) => { setNotice(message); setEditing(null); void refresh(); };

  if (q.isPending) return <Loading label="Loading slots…" />;
  if (q.isError) return <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />;
  const slots = q.data ?? [];
  return (
    <>
      {notice && <Alert tone="ok">{notice}</Alert>}
      {slots.length === 0 && <Empty title="No slots this week">{canManage ? 'Edit the weekly template or add a one-off slot.' : 'No times are set up for this week.'}</Empty>}
      {slots.length > 0 && days.map((day) => {
        const rows = slots.filter((s) => s.date === day);
        return (
          <div key={day} className="ws-day">
            <h3 id={`day-${day}`}>{formatDay(day)}</h3>
            {rows.length === 0 ? <p className="ws-muted">No slots.</p> : (
              <div className="ws-table-wrap">
                <table className="j-table" aria-labelledby={`day-${day}`}>
                  <thead>
                    <tr><th scope="col">Time</th><th scope="col">Booked</th><th scope="col">Seats</th><th scope="col">Status</th><th scope="col">From</th>{canManage && <th scope="col">Actions</th>}</tr>
                  </thead>
                  <tbody>
                    {rows.map((s) => (
                      <SlotRow key={s._id} ctx={ctx} slot={s} canManage={canManage} started={Date.parse(s.startsAt) <= now.getTime()}
                        editing={editing === s._id} onEdit={(on) => setEditing(on ? s._id : null)} onChanged={changed} onRefused={() => void refresh()} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

function SlotRow({ ctx, slot, canManage, started, editing, onEdit, onChanged, onRefused }: {
  ctx: ScopeContext; slot: LabSlot; canManage: boolean; started: boolean; editing: boolean;
  onEdit: (on: boolean) => void; onChanged: (message: string) => void; onRefused: () => void;
}) {
  const label = slotLabel(slot);
  const full = slot.closed === null && slot.booked >= slot.capacity;
  return (
    <tr>
      <td>{slot.startTime}–{slot.endTime}</td>
      <td>{slot.booked}</td>
      <td>{slot.capacity}</td>
      <td>
        {slot.closed ? <Badge tone="danger">{SLOT_CLOSURE_LABEL[slot.closed]}</Badge>
          : started ? <Badge>Started</Badge> : full ? <Badge tone="warn">Full</Badge> : <Badge tone="ok">Open</Badge>}
      </td>
      <td>{slot.source === 'manual' ? 'One-off' : 'Template'}</td>
      {canManage && (
        <td>
          {started ? <span className="ws-muted">—</span> : editing
            ? <CapacityForm ctx={ctx} slot={slot} onCancel={() => onEdit(false)} onDone={(s) => onChanged(`${label} now has ${s.capacity} ${s.capacity === 1 ? 'seat' : 'seats'}.`)} onRefused={onRefused} />
            : (
              <div className="ws-actions">
                <Button variant="secondary" aria-label={`Change seats of ${label}`} onClick={() => onEdit(true)}>Change seats</Button>
                {slot.closed === null && (
                  <ConfirmAction label="Close" confirmLabel={`Close ${label}`} danger
                    consequence={<>Close {label}? Customers can no longer book it.{slot.booked > 0 ? ` The ${slot.booked} booked ${slot.booked === 1 ? 'customer keeps' : 'customers keep'} their seats; reschedule or reject those bookings separately.` : ''} You can reopen it later.</>}
                    onConfirm={async () => {
                      try { await ctx.labs.closeSlot(slot._id); onChanged(`${label} is closed.`); } catch (err) { onRefused(); throw err; }
                    }} />
                )}
                {reopenable(slot) && (
                  <ConfirmAction label="Reopen" confirmLabel={`Reopen ${label}`}
                    consequence={<>Reopen {label}? Customers can book its {Math.max(slot.capacity - slot.booked, 0)} free {slot.capacity - slot.booked === 1 ? 'seat' : 'seats'} again.</>}
                    onConfirm={async () => {
                      try { await ctx.labs.reopenSlot(slot._id); onChanged(`${label} is open again.`); } catch (err) { onRefused(); throw err; }
                    }} />
                )}
                {slot.closed === 'holiday' && <span className="ws-muted">Change the branch holidays to open it.</span>}
                {slot.closed === 'template' && <span className="ws-muted">Add this time to the weekly template to open it.</span>}
              </div>
            )}
        </td>
      )}
    </tr>
  );
}

function CapacityForm({ ctx, slot, onCancel, onDone, onRefused }: {
  ctx: ScopeContext; slot: LabSlot; onCancel: () => void; onDone: (s: LabSlot) => void; onRefused: () => void;
}) {
  const [value, setValue] = useState(String(slot.capacity));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save(e: FormEvent) {
    e.preventDefault();
    const n = /^\d{1,3}$/.test(value.trim()) ? Number(value.trim()) : NaN;
    const problem = capacityProblem(slot, n);
    if (problem) { setError(problem); return; }
    setError(null);
    setBusy(true);
    try {
      onDone(await ctx.labs.setCapacity(slot._id, n));
    } catch (err) {
      // E.g. 409 "Capacity cannot be lower than the seats already booked": a booking landed meanwhile.
      setError(messageOf(err));
      onRefused();
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="ws-inline-form" noValidate onSubmit={(e) => void save(e)} aria-label={`Seats of ${slotLabel(slot)}`}>
      <TextField label="Seats" inputMode="numeric" value={value} error={error} hint={slot.booked ? `${slot.booked} booked` : undefined}
        onChange={(e) => setValue(e.target.value)} />
      <div className="confirm-actions">
        <Button type="submit" busy={busy}>Save seats</Button>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

// ── Manual slot ──

function ManualSlotForm({ ctx, branch, mode, defaultDate, onClose, onAdded }: {
  ctx: ScopeContext; branch: Branch; mode: VisitMode; defaultDate: string; onClose: () => void; onAdded: (s: LabSlot) => void;
}) {
  const queryClient = useQueryClient();
  const [date, setDate] = useState(defaultDate);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [seats, setSeats] = useState('1');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add(e: FormEvent) {
    e.preventDefault();
    const capacity = /^\d{1,3}$/.test(seats.trim()) ? Number(seats.trim()) : NaN;
    const body = { branchId: branch._id, visitMode: mode, date, startTime: start, endTime: end, capacity };
    const errs = manualSlotProblems(body);
    setErrors(errs as Record<string, string>);
    setFailure(null);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      onAdded(await ctx.labs.addSlot(body));
    } catch (err) {
      // No request key on this route, but a second slot at the same start is refused (409 SLOT_EXISTS), so a resend is safe.
      setFailure(definitelyNotRecorded(err) ? messageOf(err)
        : `${messageOf(err)} The slot may have been added: look for it in the week below before adding it again (a second one at the same time is refused).`);
    } finally {
      setBusy(false);
      void queryClient.invalidateQueries({ queryKey: [...ctx.key, 'slots'] });
    }
  }

  return (
    <section className="ws-section" aria-labelledby="manual-h">
      <h2 id="manual-h">Add a one-off slot</h2>
      <p className="ws-muted">For {LAB_VISIT_MODE_LABEL[mode].toLowerCase()} at {branch.name}. Times are India time. A one-off slot is never changed by the weekly template.</p>
      <form className="rx-form" noValidate onSubmit={(e) => void add(e)}>
        <div className="rx-form-row">
          <TextField label="Date" type="date" value={date} error={errors.date} onChange={(e) => setDate(e.target.value)} />
          <TextField label="Starts" type="time" value={start} error={errors.startTime} onChange={(e) => setStart(e.target.value)} />
          <TextField label="Ends" type="time" value={end} error={errors.endTime} onChange={(e) => setEnd(e.target.value)} />
          <TextField label="Seats" inputMode="numeric" value={seats} error={errors.capacity} hint={`1 to ${SLOT_SEATS_MAX}`} onChange={(e) => setSeats(e.target.value)} />
        </div>
        {failure && <Alert>{failure}</Alert>}
        <div className="confirm-actions">
          <Button type="submit" busy={busy}>Add slot</Button>
          <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </section>
  );
}

// ── Weekly template ──

type TemplateDraft = { slotMinutes: string; capacity: string } & Record<Weekday, SlotWindow[]>;
const DRAFT_LABEL: Record<keyof TemplateDraft, string> = {
  slotMinutes: 'slot length', capacity: 'seats per slot',
  ...Object.fromEntries(TEMPLATE_WEEKDAYS.map((d) => [d, `${DAY_LABEL[d]} times`])) as Record<Weekday, string>,
};

const toDraft = (t: SlotTemplateInput): TemplateDraft => ({
  slotMinutes: String(t.slotMinutes), capacity: String(t.capacity),
  ...Object.fromEntries(TEMPLATE_WEEKDAYS.map((d) => [d, (t.days[d] ?? []).map((w) => ({ ...w }))])) as Record<Weekday, SlotWindow[]>,
});
const fromDraft = (d: TemplateDraft): SlotTemplateInput => ({
  slotMinutes: /^\d{1,3}$/.test(d.slotMinutes.trim()) ? Number(d.slotMinutes.trim()) : NaN,
  capacity: /^\d{1,3}$/.test(d.capacity.trim()) ? Number(d.capacity.trim()) : NaN,
  // Every weekday is sent (an empty list = no slots that day): the server replaces the whole template.
  days: Object.fromEntries(TEMPLATE_WEEKDAYS.map((day) => [day, d[day].map((w) => ({ start: w.start, end: w.end }))])),
});

type Basis = { template: SlotTemplateInput; source: 'saved' | 'hours' | 'none'; version: TemplateVersion };
/**
 * WQ11b: the editor starts from the SAVED template (Q11 `GET .../slot-templates/:visitMode`), and its version
 * (`updatedAt`) fences the save. With no template yet it starts from the branch's opening hours, else from nothing
 * (version null: a template saved by someone else in between is refused too).
 */
function basisOf(saved: SlotTemplate | null, branch: Branch): Basis {
  if (saved) return { template: templateInput(saved), source: 'saved', version: saved.updatedAt ?? null };
  const days = Object.fromEntries(Object.entries(branch.hours ?? {}).filter(([, h]) => h?.open && h?.close).map(([d, h]) => [d, [{ start: h!.open, end: h!.close }]]));
  return Object.keys(days).length
    ? { template: { slotMinutes: 30, capacity: 1, days }, source: 'hours', version: null }
    : { template: { slotMinutes: 30, capacity: 1, days: {} }, source: 'none', version: null };
}

/** Whether two templates are the same (the server keeps exactly what is sent). */
const sameTemplate = (a: SlotTemplateInput, b: SlotTemplateInput) => JSON.stringify(toDraft(a)) === JSON.stringify(toDraft(b));

export const TEMPLATE_CHANGED_MESSAGE = 'Someone else saved the weekly template while you were editing, so nothing was saved. The form now shows what is saved; check it and save again.';

function TemplateEditor({ ctx, branch, mode, where, onClose, onSaved }: {
  ctx: ScopeContext; branch: Branch; mode: VisitMode; where: string; onClose: () => void; onSaved: (message: string) => void;
}) {
  const key = [...ctx.key, 'slot-template', branch._id, mode];
  const read = () => ctx.labs.template(branch._id, mode);
  // WQ11d: every opening reads the template again, and the form is shown only from a read made since it opened: a
  // cached copy (older than a save made meanwhile, possibly from another editor) is never shown as "the saved template",
  // and a late read can never reset what was typed.
  const queryClient = useQueryClient();
  const readsSoFar = () => queryClient.getQueryState(key)?.dataUpdateCount ?? 0;
  const [openedAt] = useState(readsSoFar);
  const saved = useQuery({ queryKey: key, queryFn: read, refetchOnMount: 'always' });
  const [fresh, setFresh] = useState(false);
  if (!fresh && saved.isSuccess && !saved.isFetching && readsSoFar() > openedAt) setFresh(true);
  return (
    <section className="ws-section" aria-labelledby="tpl-h">
      <h2 id="tpl-h">Weekly template: {where}</h2>
      {!fresh && saved.isError ? <ErrorState message={messageOf(saved.error)} onRetry={() => void saved.refetch()} />
        : !fresh ? <Loading label="Reading the saved template…" />
        : saved.isError ? <ErrorState message={messageOf(saved.error)} onRetry={() => void saved.refetch()} />
        : <TemplateForm ctx={ctx} branch={branch} mode={mode} where={where} saved={saved.data ?? null} reread={read} templateKey={key} onClose={onClose} onSaved={onSaved} />}
    </section>
  );
}

function TemplateForm({ ctx, branch, mode, where, saved, reread, templateKey, onClose, onSaved }: {
  ctx: ScopeContext; branch: Branch; mode: VisitMode; where: string; saved: SlotTemplate | null; reread: () => Promise<SlotTemplate | null>;
  templateKey: readonly unknown[]; onClose: () => void; onSaved: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const basis = useMemo(() => basisOf(saved, branch), [saved, branch]);
  const d = useDraft(() => toDraft(basis.template));
  const { rebaseTo } = d;
  /** The saved version the form's baseline belongs to (sent as `expectedUpdatedAt`). */
  const baseVersion = useRef<TemplateVersion>(basis.version);
  const [errors, setErrors] = useState<Partial<Record<keyof TemplateDraft, string>>>({});
  const [stale, setStale] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const serverValue = JSON.stringify(toDraft(basis.template));
  const serverVersion = basis.version;
  // A refetch moves untouched fields along; a field changed here and there is reset with a notice.
  useEffect(() => {
    const c = rebaseTo(JSON.parse(serverValue) as TemplateDraft);
    baseVersion.current = serverVersion;
    if (c.length) { setStale(staleMessage(c.map((k) => DRAFT_LABEL[k]))); setConfirming(false); }
  }, [serverValue, serverVersion, rebaseTo]);
  /** Reads the saved template now (and shows it), moving the form onto it; the conflicting fields, if any. */
  const rebaseOnSaved = async () => {
    const fresh = await queryClient.fetchQuery({ queryKey: templateKey, queryFn: reread, staleTime: 0 });
    const b = basisOf(fresh, branch);
    baseVersion.current = b.version;
    return { fresh, conflicts: rebaseTo(toDraft(b.template)) };
  };

  const t = d.draft;
  const body = fromDraft(t);
  const counts = Object.fromEntries(TEMPLATE_WEEKDAYS.map((day) => [day, slotTimesFor(body, day).length])) as Record<Weekday, number>;

  function check(): boolean {
    const p = templateProblems(fromDraft(d.current().draft));
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
    let sent: SlotTemplateInput | null = null;
    try {
      // Read again right before replacing: a change made elsewhere since the form opened is shown, not overwritten.
      const { conflicts } = await rebaseOnSaved();
      if (conflicts.length) { setStale(staleMessage(conflicts.map((k) => DRAFT_LABEL[k]))); setConfirming(false); return; }
      if (!check()) { setConfirming(false); return; }
      sent = fromDraft(d.current().draft);
      // Q11: named by the version just read; another save in between is refused (409 TEMPLATE_CHANGED), never overwritten.
      const r = await ctx.labs.saveTemplate(branch._id, mode, sent, baseVersion.current);
      // WQ11d: the saved template is the cache from now on (also when this editor was closed meanwhile).
      if (r.template) queryClient.setQueryData(templateKey, r.template);
      const x = r.expansion;
      onSaved(`Weekly template saved for ${where}. Next ${ROLLING_DAYS} days: ${x.inserted} slots added, ${x.updated} changed, ${x.closed} closed, ${x.reopened} reopened.`);
    } catch (err) {
      if (isTemplateChanged(err)) {
        // Read the template as saved now and show it: what someone else changed is never overwritten unseen.
        setConfirming(false);
        try {
          const { conflicts } = await rebaseOnSaved();
          setStale(conflicts.length ? staleMessage(conflicts.map((k) => DRAFT_LABEL[k])) : TEMPLATE_CHANGED_MESSAGE);
        } catch (e) { setFailure(`Not saved: ${TEMPLATE_CHANGED_MESSAGE} It could not be read again: ${messageOf(e)}`); }
        return;
      }
      if (definitelyNotRecorded(err) || !sent) { setFailure(`Not saved: ${messageOf(err)}`); return; }
      // The answer was lost: the template as saved now says whether it went through.
      try {
        const now = await queryClient.fetchQuery({ queryKey: templateKey, queryFn: reread, staleTime: 0 });
        if (now && sameTemplate(templateInput(now), sent)) {
          onSaved(`Weekly template saved for ${where} (its answer was lost; the saved template is what you sent). The slots of the next ${ROLLING_DAYS} days follow it.`);
          return;
        }
      } catch { /* still unknown: said below */ }
      setFailure(`${messageOf(err)} It is not known whether the template was saved. Check the slots, then review and save again if needed.`);
    } finally {
      setBusy(false);
      void queryClient.invalidateQueries({ queryKey: [...ctx.key, 'slots'] });
      // Read again whether or not an editor is open now (WQ11d: a closed one left no observer, so the cache stayed old).
      void queryClient.invalidateQueries({ queryKey: templateKey, refetchType: 'all' });
    }
  }

  const setWindow = (day: Weekday, i: number, part: 'start' | 'end', v: string) =>
    d.update((x) => ({ ...x, [day]: x[day].map((w, j) => (j === i ? { ...w, [part]: v } : w)) }));

  return (
    <form className="rx-form" noValidate onSubmit={review} aria-label="Weekly template">
      <p className="ws-muted">
        {basis.source === 'saved' ? 'This is the saved weekly template.'
          : basis.source === 'hours' ? 'There is no weekly template yet, so this starts from the branch’s opening hours.'
          : 'There is no weekly template yet and no opening hours: add the times for each day.'}
        {' '}Times are India time. Saving replaces the whole template.
      </p>
      <div className="rx-form-row">
        <TextField label="Slot length (minutes)" inputMode="numeric" value={t.slotMinutes} error={errors.slotMinutes} disabled={confirming}
          onChange={(e) => d.set('slotMinutes', e.target.value)} />
        <TextField label="Seats per slot" inputMode="numeric" value={t.capacity} error={errors.capacity} disabled={confirming}
          onChange={(e) => d.set('capacity', e.target.value)} />
      </div>
      {TEMPLATE_WEEKDAYS.map((day) => (
        <fieldset key={day} className="ws-line" aria-describedby={errors[day] ? `tpl-${day}-err` : undefined}>
          <legend>{DAY_LABEL[day]}: {t[day].length === 0 ? 'no slots' : `${counts[day]} ${counts[day] === 1 ? 'slot' : 'slots'}`}</legend>
          {t[day].map((w, i) => (
            <div key={i} className="ws-window">
              <TextField label={`${DAY_LABEL[day]} window ${i + 1} from`} type="time" value={w.start} disabled={confirming} onChange={(e) => setWindow(day, i, 'start', e.target.value)} />
              <TextField label={`${DAY_LABEL[day]} window ${i + 1} to`} type="time" value={w.end} disabled={confirming} onChange={(e) => setWindow(day, i, 'end', e.target.value)} />
              <Button variant="ghost" disabled={confirming} aria-label={`Remove ${DAY_LABEL[day]} window ${i + 1}`}
                onClick={() => d.update((x) => ({ ...x, [day]: x[day].filter((_, j) => j !== i) }))}>Remove</Button>
            </div>
          ))}
          {errors[day] && <span id={`tpl-${day}-err`} className="j-field__error">{errors[day]}</span>}
          <div>
            <Button variant="secondary" disabled={confirming || t[day].length >= MAX_WINDOWS_PER_DAY} aria-label={`Add a window on ${DAY_LABEL[day]}`}
              onClick={() => d.update((x) => ({ ...x, [day]: [...x[day], { start: '', end: '' }] }))}>Add a window</Button>
          </div>
        </fieldset>
      ))}
      {stale && <Alert tone="warn">{stale}</Alert>}
      {failure && <Alert>{failure}</Alert>}
      {!confirming ? (
        <div className="confirm-actions">
          <Button type="submit">Review the template</Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      ) : (
        <div className="confirm" role="group" aria-label="Save the weekly template">
          <div className="confirm-text">
            Replace the weekly template for {where}: {body.slotMinutes}-minute slots, {body.capacity} {body.capacity === 1 ? 'seat' : 'seats'} each.
            <ul className="ws-list">
              {TEMPLATE_WEEKDAYS.map((day) => (
                <li key={day}>{DAY_LABEL[day]}: {t[day].length === 0 ? 'no slots' : `${t[day].map((w) => `${w.start}–${w.end}`).join(', ')} (${counts[day]} ${counts[day] === 1 ? 'slot' : 'slots'})`}</li>
              ))}
            </ul>
            Over the next {ROLLING_DAYS} days, missing slots are added; slots nobody booked take the new length and seats; slots no longer in the
            template are closed (their bookings stay). Booked slots keep their time and never lose seats. Holidays and slots closed by staff stay closed.
          </div>
          <div className="confirm-actions">
            <Button busy={busy} onClick={() => void save()}>Save the template</Button>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>Back</Button>
          </div>
        </div>
      )}
    </form>
  );
}
