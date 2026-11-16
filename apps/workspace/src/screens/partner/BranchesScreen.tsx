import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  canReopenBranches, hasGlobalScope, HHMM_PATTERN, ISO_DATE_PATTERN, MAX_HOLIDAYS, MAX_NAME, PARTNER_PHONE_PATTERN, WEEKDAYS,
  type Branch, type BranchInput, type BranchServices, type PartnerKind, type Weekday, type WeeklyHours,
} from '@jansetu/api';
import { Alert, Button, Empty, ErrorState, Loading, TextField } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { dirtyKeys, isRecordChanged, RECORD_CHANGED_MESSAGE, staleMessage, useDraft, type DraftState } from '../../draft.ts';
import { messageOf } from '../../errors.ts';
import { NoSuchPartner, PartnerPageHeading, scopeIdentity, usePartnerScope, useWorkspacePartner, type ScopeContext } from './scope.tsx';

const SERVICE_LABEL: Record<keyof BranchServices, string> = {
  homeCollection: 'Home sample collection', inLab: 'Walk-in at the lab', inClinic: 'Consultations at the clinic',
};
/** Services offered for each kind; the others are kept as they are. */
const SERVICES_FOR: Record<PartnerKind, (keyof BranchServices)[]> = { lab: ['homeCollection', 'inLab'], clinic: ['inClinic'] };

export interface Draft {
  name: string; phone: string;
  line1: string; line2: string; city: string; state: string; stateCode: string; pincode: string;
  days: Record<Weekday, { open: boolean; from: string; to: string }>;
  holidays: string[];
  services: BranchServices;
}
const ADDRESS_KEYS = ['line1', 'line2', 'city', 'state', 'stateCode', 'pincode'] as const;
const DRAFT_LABEL: Record<keyof Draft, string> = {
  name: 'name', phone: 'phone', line1: 'address', line2: 'address', city: 'city', state: 'state', stateCode: 'state code',
  pincode: 'PIN code', days: 'opening hours', holidays: 'holidays', services: 'services',
};

export function draftOf(b?: Branch): Draft {
  const days = Object.fromEntries(WEEKDAYS.map(({ value }) => {
    const h = b?.hours?.[value];
    return [value, h ? { open: true, from: h.open, to: h.close } : { open: !b && value !== 'sun', from: '09:00', to: '18:00' }];
  })) as Draft['days'];
  return {
    name: b?.name ?? '', phone: b?.phone ?? '',
    line1: b?.address?.line1 ?? '', line2: b?.address?.line2 ?? '', city: b?.address?.city ?? '', state: b?.address?.state ?? '',
    stateCode: b?.address?.stateCode ?? '', pincode: b?.address?.pincode ?? '',
    days,
    holidays: [...(b?.holidays ?? [])].sort(),
    services: { homeCollection: !!b?.services?.homeCollection, inLab: !!b?.services?.inLab, inClinic: !!b?.services?.inClinic },
  };
}

/**
 * Validates against `createBranchSchema` and builds the body. A new branch sends everything; an edit sends only what
 * the person changed from the baseline (holidays and services reshape the branch's slots on the server).
 */
export function branchBody(s: DraftState<Draft>, isNew: boolean): { body: Partial<BranchInput>; errors: Record<string, string> } {
  const d = s.draft;
  const dirty = new Set<keyof Draft>(isNew ? (Object.keys(d) as (keyof Draft)[]) : dirtyKeys(s));
  const addressDirty = ADDRESS_KEYS.some((k) => dirty.has(k));
  const errors: Record<string, string> = {};
  const t = (x: string) => x.trim();
  if (dirty.has('name')) {
    if (!t(d.name)) errors.name = 'Enter the branch name.';
    else if (t(d.name).length > MAX_NAME) errors.name = `Use at most ${MAX_NAME} characters.`;
  }
  if (dirty.has('phone') && !PARTNER_PHONE_PATTERN.test(d.phone)) errors.phone = 'Enter the 10-digit phone number.';
  if (addressDirty) for (const k of ['line1', 'city', 'state', 'stateCode', 'pincode'] as const) if (!t(d[k])) errors[k] = 'Required.';
  const hours: WeeklyHours = {};
  if (dirty.has('days')) {
    for (const { value, label } of WEEKDAYS) {
      const day = d.days[value];
      if (!day.open) continue;
      if (!HHMM_PATTERN.test(day.from) || !HHMM_PATTERN.test(day.to)) errors[`day-${value}`] = `Enter opening and closing times for ${label}.`;
      else hours[value] = { open: day.from, close: day.to };
    }
  }
  if (dirty.has('holidays') && d.holidays.length > MAX_HOLIDAYS) errors.holidays = `At most ${MAX_HOLIDAYS} holidays.`;
  const body: Partial<BranchInput> = {
    ...(dirty.has('name') ? { name: t(d.name) } : {}),
    ...(dirty.has('phone') ? { phone: d.phone } : {}),
    ...(addressDirty ? { address: { line1: t(d.line1), ...(t(d.line2) ? { line2: t(d.line2) } : {}), city: t(d.city), state: t(d.state),
      stateCode: t(d.stateCode), pincode: t(d.pincode) } } : {}),
    ...(dirty.has('days') ? { hours } : {}),
    ...(dirty.has('holidays') ? { holidays: d.holidays } : {}),
    ...(dirty.has('services') ? { services: d.services } : {}),
  };
  return { body, errors };
}

const conflictLabels = (keys: (keyof Draft)[]) => [...new Set(keys.map((k) => DRAFT_LABEL[k]))];

/** Branches (`branches.manage`): add, edit (address, hours, holidays, services), deactivate and reopen. */
export function BranchesScreen() {
  const ctx = usePartnerScope();
  if (!ctx) return <NoSuchPartner />;
  // One subtree per partner: a half-filled branch form never follows an admin to another partner.
  return <Branches key={scopeIdentity(ctx)} ctx={ctx} />;
}

function Branches({ ctx }: { ctx: ScopeContext }) {
  const queryClient = useQueryClient();
  const partner = useWorkspacePartner(ctx);
  const reopen = canReopenBranches(ctx.actor);
  // Q8: branch managers with partner-wide scope also see closed branches, to reopen them.
  const branches = useQuery({
    queryKey: [...ctx.key, 'branches', reopen ? 'with-closed' : 'open'],
    queryFn: () => ctx.api.branches({ includeInactive: reopen }),
  });
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const canCreate = hasGlobalScope(ctx.actor);
  const refresh = () => queryClient.invalidateQueries({ queryKey: [...ctx.key, 'branches'] });
  const open = branches.data?.filter((b) => b.isActive !== false) ?? [];
  const closed = branches.data?.filter((b) => b.isActive === false) ?? [];
  const target = editing && editing !== 'new' ? open.find((b) => b._id === editing) : undefined;
  const kind = partner.data?.kind;

  return (
    <>
      <PartnerPageHeading ctx={ctx} title="Branches" partnerName={partner.data?.name}>Where customers are served, and when.</PartnerPageHeading>
      {notice && <Alert tone="ok">{notice}</Alert>}
      {editing === null && (canCreate
        ? <div><Button onClick={() => { setEditing('new'); setNotice(null); }}>Add a branch</Button></div>
        : <p className="ws-muted">You manage only the branches given to you; an owner adds new branches.</p>)}
      {editing === 'new' && (
        <BranchForm key="new" ctx={ctx} kind={kind} onCancel={() => setEditing(null)}
          onSaved={async (b) => { setEditing(null); setNotice(`${b.name} was added.`); await refresh(); }} />
      )}
      {target && (
        <BranchForm key={target._id} ctx={ctx} branch={target} kind={kind} onCancel={() => setEditing(null)}
          onSaved={async (b) => { setEditing(null); setNotice(`${b.name} was saved.`); await refresh(); }} />
      )}
      {branches.isPending ? <Loading label="Loading branches…" />
        : branches.isError ? <ErrorState message={messageOf(branches.error)} onRetry={() => void branches.refetch()} />
        : open.length === 0 && closed.length === 0 ? <Empty title="No branches yet">{canCreate ? 'Add the first branch to start taking bookings.' : null}</Empty>
        : (
          <>
            {open.length === 0 ? <Empty title="No open branches" /> : (
              <div className="ws-table-wrap">
                <table className="j-table">
                  <caption className="j-sr-only">Open branches</caption>
                  <thead><tr><th scope="col">Branch</th><th scope="col">Address</th><th scope="col">Phone</th><th scope="col">Services</th><th scope="col">Open</th><th scope="col">Actions</th></tr></thead>
                  <tbody>
                    {open.map((b) => (
                      <tr key={b._id}>
                        <td>{b.name}</td>
                        <td>{[b.address?.line1, b.address?.line2, b.address?.city, b.address?.pincode].filter(Boolean).join(', ')}</td>
                        <td>{b.phone}</td>
                        <td>{(Object.keys(SERVICE_LABEL) as (keyof BranchServices)[]).filter((k) => b.services?.[k]).map((k) => SERVICE_LABEL[k]).join(', ') || 'None'}</td>
                        <td>{WEEKDAYS.filter((d) => b.hours?.[d.value]).map((d) => `${d.label.slice(0, 3)} ${b.hours![d.value]!.open}–${b.hours![d.value]!.close}`).join(', ') || 'No hours set'}</td>
                        <td>
                          <div className="ws-actions">
                            <Button variant="secondary" onClick={() => { setEditing(b._id); setNotice(null); }}>Edit</Button>
                            <ConfirmAction label="Deactivate" danger confirmLabel={`Deactivate ${b.name}`}
                              consequence={`${b.name} stops taking bookings and its open slots close.${reopen ? ' It can be reopened later.' : ' Only an owner or all-branch manager can reopen it.'}`}
                              onConfirm={async () => {
                                try { await ctx.api.deactivateBranch(b._id); setNotice(`${b.name} was deactivated.`); } finally { await refresh(); }
                              }} />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {closed.length > 0 && (
              <section className="ws-section" aria-labelledby="closed-h">
                <h2 id="closed-h">Closed branches</h2>
                <ul className="ws-list">
                  {closed.map((b) => (
                    <li key={b._id} className="ws-actions">
                      <span>{b.name}{b.address?.city ? ` · ${b.address.city}` : ''}</span>
                      <ConfirmAction label="Reopen" confirmLabel={`Reopen ${b.name}`}
                        consequence={`${b.name} opens again with its saved hours and services, and takes bookings again.`}
                        onConfirm={async () => {
                          try { await ctx.api.reactivateBranch(b._id); setNotice(`${b.name} was reopened.`); } finally { await refresh(); }
                        }} />
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
    </>
  );
}

function BranchForm({ ctx, branch, kind, onCancel, onSaved }: {
  ctx: ScopeContext; branch?: Branch; kind?: PartnerKind; onCancel: () => void; onSaved: (b: Branch) => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const draft = useDraft(() => draftOf(branch));
  const d = draft.draft;
  const { rebaseTo } = draft;
  const [holiday, setHoliday] = useState('');
  const [holidayError, setHolidayError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stale, setStale] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const services = kind ? SERVICES_FOR[kind] : (Object.keys(SERVICE_LABEL) as (keyof BranchServices)[]);
  // Editing: a refreshed branch moves untouched fields along; a field changed here AND there is flagged for review.
  const serverValue = branch ? JSON.stringify(draftOf(branch)) : null;
  useEffect(() => {
    if (!serverValue) return;
    const c = rebaseTo(JSON.parse(serverValue) as Draft);
    if (c.length) setStale(staleMessage(conflictLabels(c)));
  }, [serverValue, rebaseTo]);

  const field = (k: 'name' | 'line1' | 'line2' | 'city' | 'state' | 'stateCode' | 'pincode') =>
    ({ value: d[k], error: errors[k], onChange: (e: { target: { value: string } }) => draft.set(k, e.target.value) });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null); setNotice(null); setStale(null);
    const first = branchBody(draft.current(), !branch);
    setErrors(first.errors);
    if (Object.keys(first.errors).length) return;
    if (branch && Object.keys(first.body).length === 0) { setNotice('Nothing has changed.'); return; }
    setBusy(true);
    try {
      if (!branch) {
        await onSaved(await ctx.api.createBranch(first.body as BranchInput));
        return;
      }
      // Checked against what is saved now: nothing someone else changed meanwhile is overwritten unseen.
      const fresh = await ctx.api.branch(branch._id);
      const conflicts = rebaseTo(draftOf(fresh));
      if (conflicts.length) { setStale(staleMessage(conflictLabels(conflicts))); return; }
      if (fresh.isActive === false) { setStale(`${fresh.name} was closed meanwhile.`); return; }
      const { body } = branchBody(draft.current(), false);
      if (Object.keys(body).length === 0) { setNotice('Nothing has changed.'); return; }
      let saved: Branch;
      try {
        // Q10: refused (409 RECORD_CHANGED) if the branch moved after the read above.
        saved = await ctx.api.updateBranch(branch._id, body, fresh.updatedAt);
      } catch (err) {
        if (!isRecordChanged(err)) throw err;
        const c = rebaseTo(draftOf(await ctx.api.branch(branch._id)));
        setStale(c.length ? staleMessage(conflictLabels(c)) : RECORD_CHANGED_MESSAGE);
        return;
      }
      await onSaved(saved);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
      if (branch) void queryClient.invalidateQueries({ queryKey: [...ctx.key, 'branches'] });
    }
  }

  function addHoliday() {
    if (!ISO_DATE_PATTERN.test(holiday) || Number.isNaN(new Date(`${holiday}T00:00:00Z`).getTime())) { setHolidayError('Choose a date.'); return; }
    setHolidayError(null);
    draft.update((x) => ({ ...x, holidays: [...new Set([...x.holidays, holiday])].sort() }));
    setHoliday('');
  }

  return (
    <section className="ws-section" aria-labelledby="branch-form-h">
      <h2 id="branch-form-h">{branch ? `Edit ${branch.name}` : 'Add a branch'}</h2>
      <form className="rx-form" noValidate onSubmit={(e) => void submit(e)}>
        <fieldset className="ws-frozen" disabled={busy}>
        <div className="rx-form-row">
          <TextField label="Branch name" maxLength={MAX_NAME} {...field('name')} />
          <TextField label="Phone" inputMode="numeric" maxLength={10} value={d.phone} error={errors.phone}
            onChange={(e) => draft.set('phone', e.target.value.replace(/\D/g, ''))} />
        </div>
        <div className="rx-form-row">
          <TextField label="Address line 1" autoComplete="address-line1" {...field('line1')} />
          <TextField label="Address line 2 (optional)" autoComplete="address-line2" {...field('line2')} />
        </div>
        <div className="rx-form-row">
          <TextField label="City" autoComplete="address-level2" {...field('city')} />
          <TextField label="State" autoComplete="address-level1" {...field('state')} />
          <TextField label="State code" hint="GST state code, e.g. 29" {...field('stateCode')} />
          <TextField label="PIN code" inputMode="numeric" autoComplete="postal-code" {...field('pincode')} />
        </div>
        <fieldset className="ws-checks">
          <legend>Services</legend>
          {services.map((k) => (
            <label key={k} className="ws-check">
              <input type="checkbox" checked={d.services[k]} onChange={(e) => draft.set('services', { ...d.services, [k]: e.target.checked })} />
              {SERVICE_LABEL[k]}
            </label>
          ))}
        </fieldset>
        <fieldset className="ws-checks">
          <legend>Opening hours</legend>
          {WEEKDAYS.map(({ value, label }) => {
            const day = d.days[value];
            const set = (p: Partial<Draft['days'][Weekday]>) => draft.update((x) => ({ ...x, days: { ...x.days, [value]: { ...x.days[value], ...p } } }));
            return (
              <div key={value} className="ws-hours">
                <label className="ws-check"><input type="checkbox" checked={day.open} onChange={(e) => set({ open: e.target.checked })} /> {label}</label>
                {day.open ? (
                  <>
                    <TextField label={`${label} opens`} type="time" value={day.from} onChange={(e) => set({ from: e.target.value })} />
                    <TextField label={`${label} closes`} type="time" value={day.to} onChange={(e) => set({ to: e.target.value })}
                      error={errors[`day-${value}`]} />
                  </>
                ) : <span className="ws-muted">Closed</span>}
              </div>
            );
          })}
        </fieldset>
        <fieldset className="ws-checks">
          <legend>Holidays</legend>
          <div className="ws-search">
            <TextField label="Holiday date" type="date" value={holiday} onChange={(e) => setHoliday(e.target.value)} error={holidayError ?? errors.holidays} />
            <Button variant="secondary" onClick={addHoliday}>Add holiday</Button>
          </div>
          {d.holidays.length === 0 ? <p className="ws-muted">No holidays.</p> : (
            <ul className="ws-list">
              {d.holidays.map((h) => (
                <li key={h}>
                  {h}{' '}
                  <Button variant="ghost" aria-label={`Remove holiday ${h}`}
                    onClick={() => draft.update((x) => ({ ...x, holidays: x.holidays.filter((y) => y !== h) }))}>Remove</Button>
                </li>
              ))}
            </ul>
          )}
        </fieldset>
        </fieldset>
        {stale && <Alert tone="warn">{stale}</Alert>}
        {notice && <Alert tone="ok">{notice}</Alert>}
        {error && <Alert>{error}</Alert>}
        <div className="ws-actions">
          <Button type="submit" busy={busy}>{branch ? 'Save branch' : 'Add branch'}</Button>
          <Button variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
        </div>
      </form>
    </section>
  );
}
