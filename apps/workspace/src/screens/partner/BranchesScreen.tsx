import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  canReopenBranches, GST_STATE_CODE_PATTERN, hasGlobalScope, HHMM_PATTERN, ISO_DATE_PATTERN, MAX_HOLIDAYS, MAX_NAME, PARTNER_PHONE_PATTERN, tooLongWords, WEEKDAYS,
  type Branch, type BranchInput, type BranchServices, type PartnerKind, type Weekday, type WeeklyHours,
} from '@jansetu/api';
import { Alert, Button, Empty, ErrorState, Loading, shared, TextField } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { dirtyKeys, isRecordChanged, RECORD_CHANGED_MESSAGE, staleMessage, useDraft, type DraftState } from '../../draft.ts';
import { messageOf } from '../../errors.ts';
import { definitelyNotRecorded, newRequestKey } from '../../requests.ts';
import { NoSuchPartner, PartnerPageHeading, scopeIdentity, usePartnerScope, useWorkspacePartner, type ScopeContext } from './scope.tsx';
import { t, type PartnerKey } from '../../i18n/partner/index.ts';

const SERVICE_KEY = {
  homeCollection: 'branches.service.homeCollection', inLab: 'branches.service.inLab', inClinic: 'branches.service.inClinic',
} as const satisfies Record<keyof BranchServices, PartnerKey>;
const SERVICES = Object.keys(SERVICE_KEY) as (keyof BranchServices)[];
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
const DRAFT_KEY = {
  name: 'branches.field.name', phone: 'branches.field.phone', line1: 'branches.field.address', line2: 'branches.field.address',
  city: 'branches.field.city', state: 'branches.field.state', stateCode: 'branches.field.stateCode', pincode: 'branches.field.pincode',
  days: 'branches.field.days', holidays: 'branches.field.holidays', services: 'branches.field.services',
} as const satisfies Record<keyof Draft, PartnerKey>;

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
  const trim = (x: string) => x.trim();
  if (dirty.has('name')) {
    if (!trim(d.name)) errors.name = t('branches.error.name');
    else if (trim(d.name).length > MAX_NAME) errors.name = tooLongWords(MAX_NAME);
  }
  if (dirty.has('phone') && !PARTNER_PHONE_PATTERN.test(d.phone)) errors.phone = t('branches.error.phone');
  if (addressDirty) for (const k of ['line1', 'city', 'state', 'stateCode', 'pincode'] as const) if (!trim(d[k])) errors[k] = t('branches.error.required');
  // WQ11b: bills compare it with the GSTIN's first two digits (`assertRegistrationCovers`), so only a GST state code works.
  if (addressDirty && trim(d.stateCode) && !GST_STATE_CODE_PATTERN.test(trim(d.stateCode))) errors.stateCode = t('branches.error.stateCode');
  const hours: WeeklyHours = {};
  if (dirty.has('days')) {
    for (const { value, label } of WEEKDAYS) {
      const day = d.days[value];
      if (!day.open) continue;
      if (!HHMM_PATTERN.test(day.from) || !HHMM_PATTERN.test(day.to)) errors[`day-${value}`] = t('branches.error.hours', { day: label });
      else hours[value] = { open: day.from, close: day.to };
    }
  }
  if (dirty.has('holidays') && d.holidays.length > MAX_HOLIDAYS) errors.holidays = t('branches.error.maxHolidays', { max: MAX_HOLIDAYS });
  const body: Partial<BranchInput> = {
    ...(dirty.has('name') ? { name: trim(d.name) } : {}),
    ...(dirty.has('phone') ? { phone: d.phone } : {}),
    ...(addressDirty ? { address: { line1: trim(d.line1), ...(trim(d.line2) ? { line2: trim(d.line2) } : {}), city: trim(d.city), state: trim(d.state),
      stateCode: trim(d.stateCode), pincode: trim(d.pincode) } } : {}),
    ...(dirty.has('days') ? { hours } : {}),
    ...(dirty.has('holidays') ? { holidays: d.holidays } : {}),
    ...(dirty.has('services') ? { services: d.services } : {}),
  };
  return { body, errors };
}

const conflictLabels = (keys: (keyof Draft)[]) => [...new Set(keys.map((k) => t(DRAFT_KEY[k])))];
const listWords = (xs: string[]) => (xs.length > 1 ? t('common.listAnd', { rest: xs.slice(0, -1).join(', '), last: xs.at(-1)! }) : xs[0] ?? '');
/** The same branch name as typed (the server trims it; people may differ in case or spacing). */
const sameName = (a: string, b: string) => a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase();

/** What a save said: `dropped` names fields reset because someone else changed them meanwhile (not sent, not saved). */
type Saved = { branch: Branch; dropped: string[]; found?: boolean };

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
  const [notice, setNoticeState] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  const setNotice = (text: string | null) => setNoticeState(text ? { tone: 'ok', text } : null);
  /** WQ11b: a save closes only the form that made it (a late answer never closes another one, or drops what was typed there). */
  const savedFrom = (form: string | 'new', s: Saved, done: 'branches.added' | 'branches.saved') => {
    setEditing((e) => (e === form ? null : e));
    const name = s.branch.name;
    setNoticeState(s.dropped.length
      ? { tone: 'warn', text: t('branches.savedExcept', { count: s.dropped.length, name, fields: listWords(s.dropped) }) }
      : { tone: 'ok', text: s.found ? t('branches.foundAfterLoss', { name }) : t(done, { name }) });
  };
  const canCreate = hasGlobalScope(ctx.actor);
  const refresh = () => queryClient.invalidateQueries({ queryKey: [...ctx.key, 'branches'] });
  const open = branches.data?.filter((b) => b.isActive !== false) ?? [];
  const closed = branches.data?.filter((b) => b.isActive === false) ?? [];
  const target = editing && editing !== 'new' ? open.find((b) => b._id === editing) : undefined;
  const kind = partner.data?.kind;

  return (
    <>
      <PartnerPageHeading ctx={ctx} title={t('branches.title')} partnerName={partner.data?.name}>{t('branches.intro')}</PartnerPageHeading>
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {editing === null && (canCreate
        ? <div><Button onClick={() => { setEditing('new'); setNotice(null); }}>{t('branches.add')}</Button></div>
        : <p className="ws-muted">{t('branches.onlyYours')}</p>)}
      {editing === 'new' && (
        <BranchForm key="new" ctx={ctx} kind={kind} onCancel={() => setEditing(null)}
          onSaved={async (s) => { savedFrom('new', s, 'branches.added'); await refresh(); }} />
      )}
      {target && (
        <BranchForm key={target._id} ctx={ctx} branch={target} kind={kind} onCancel={() => setEditing(null)}
          onSaved={async (s) => { savedFrom(target._id, s, 'branches.saved'); await refresh(); }} />
      )}
      {branches.isPending ? <Loading label={t('common.loadingBranches')} />
        : branches.isError ? <ErrorState message={messageOf(branches.error)} onRetry={() => void branches.refetch()} />
        : open.length === 0 && closed.length === 0 ? <Empty title={t('branches.none.title')}>{canCreate ? t('branches.none.body') : null}</Empty>
        : (
          <>
            {open.length === 0 ? <Empty title={t('branches.noneOpen')} /> : (
              <div className="ws-table-wrap">
                <table className="j-table">
                  <caption className="j-sr-only">{t('branches.caption')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('branches.col.branch')}</th><th scope="col">{t('branches.col.address')}</th><th scope="col">{t('branches.col.phone')}</th>
                      <th scope="col">{t('branches.col.services')}</th><th scope="col">{t('branches.col.open')}</th><th scope="col">{t('branches.col.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {open.map((b) => (
                      <tr key={b._id}>
                        <td>{b.name}</td>
                        <td>{[b.address?.line1, b.address?.line2, b.address?.city, b.address?.pincode].filter(Boolean).join(', ')}</td>
                        <td>{b.phone}</td>
                        <td>{SERVICES.filter((k) => b.services?.[k]).map((k) => t(SERVICE_KEY[k])).join(', ') || t('branches.noServices')}</td>
                        <td>
                          {WEEKDAYS.filter((d) => b.hours?.[d.value])
                            .map((d) => t('branches.dayHours', { day: d.label.slice(0, 3), open: b.hours![d.value]!.open, close: b.hours![d.value]!.close }))
                            .join(', ') || t('branches.noHours')}
                        </td>
                        <td>
                          <div className="ws-actions">
                            <Button variant="secondary" onClick={() => { setEditing(b._id); setNotice(null); }}>{t('branches.edit')}</Button>
                            <ConfirmAction label={t('branches.deactivate')} danger confirmLabel={t('branches.deactivateName', { name: b.name })}
                              consequence={t(reopen ? 'branches.deactivate.reopenable' : 'branches.deactivate.ownerReopens', { name: b.name })}
                              onConfirm={async () => {
                                try { await ctx.api.deactivateBranch(b._id); setNotice(t('branches.deactivated', { name: b.name })); } finally { await refresh(); }
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
                <h2 id="closed-h">{t('branches.closed')}</h2>
                <ul className="ws-list">
                  {closed.map((b) => (
                    <li key={b._id} className="ws-actions">
                      <span>{b.name}{b.address?.city ? ` · ${b.address.city}` : ''}</span>
                      <ConfirmAction label={t('branches.reopen')} confirmLabel={t('branches.reopenName', { name: b.name })}
                        consequence={t('branches.reopen.consequence', { name: b.name })}
                        onConfirm={async () => {
                          try { await ctx.api.reactivateBranch(b._id); setNotice(t('branches.reopened', { name: b.name })); } finally { await refresh(); }
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

/**
 * A new branch is sent with a request key (Q16b `createBranchSchema.requestKey`: exactly once per partner and key). An
 * answer that never arrives locks the form: the branch list is read again and a new branch of this name is taken as the
 * one sent; otherwise only "Send again" (the same key and details: never a second branch) or, after a second step,
 * starting again is offered.
 */
function BranchForm({ ctx, branch, kind, onCancel, onSaved }: {
  ctx: ScopeContext; branch?: Branch; kind?: PartnerKind; onCancel: () => void; onSaved: (s: Saved) => Promise<void>;
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
  const inFlight = useRef(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  /** A create whose answer was lost: what was sent, under which key, and the branches there were before it. */
  const [lost, setLost] = useState<{ body: BranchInput; requestKey: string; before: string[] } | null>(null);
  /** WQ11b: fields reset because someone else changed them meanwhile; never reported as saved unless typed again. */
  const dropped = useRef(new Set<keyof Draft>());
  const services = kind ? SERVICES_FOR[kind] : SERVICES;
  // Editing: a refreshed branch moves untouched fields along; a field changed here AND there is flagged for review.
  const serverValue = branch ? JSON.stringify(draftOf(branch)) : null;
  useEffect(() => {
    if (!serverValue) return;
    const c = rebaseTo(JSON.parse(serverValue) as Draft);
    for (const k of c) dropped.current.add(k);
    if (c.length) setStale(staleMessage(conflictLabels(c)));
  }, [serverValue, rebaseTo]);
  /** Fields reset by someone else's change and not typed again since (so not part of this save). */
  const stillDropped = () => { const dirty = new Set(dirtyKeys(draft.current())); return [...dropped.current].filter((k) => !dirty.has(k)); };

  /** Sends a new branch; a lost answer is settled by reading the list (a branch of this name made since is the one sent). */
  async function create(body: BranchInput, requestKey: string, before: string[], resend = false) {
    try {
      const made = await ctx.api.createBranch(body, requestKey);
      if (live.current) setLost(null);
      await onSaved({ branch: made, dropped: [] });
    } catch (err) {
      // Only the FIRST send's definite refusal frees the form. WQ11d: a refused resend says nothing about the earlier
      // send, which may still arrive: it stays locked and is settled only by the branch list (below) or "Send again".
      if (definitelyNotRecorded(err) && !resend) { if (live.current) { setLost(null); setError(messageOf(err)); } return; }
      if (live.current) setLost({ body, requestKey, before });
      try {
        const now = await ctx.api.branches();
        void queryClient.invalidateQueries({ queryKey: [...ctx.key, 'branches'] });
        const found = now.find((b) => b.isActive !== false && !before.includes(b._id) && sameName(b.name, body.name));
        if (found) { if (live.current) setLost(null); await onSaved({ branch: found, dropped: [], found: true }); return; }
      } catch { /* still unknown: said below */ }
      if (live.current) {
        setError(resend && definitelyNotRecorded(err)
          ? t('branches.notSentAgain', { reason: messageOf(err), name: body.name })
          : t('branches.notConfirmed', { reason: messageOf(err), name: body.name }));
      }
    }
  }

  const field = (k: 'name' | 'line1' | 'line2' | 'city' | 'state' | 'stateCode' | 'pincode') =>
    ({ value: d[k], error: errors[k], onChange: (e: { target: { value: string } }) => draft.set(k, e.target.value) });

  /** One send at a time (a double click, or Enter while saving, sends nothing more). */
  async function once(run: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try { await run(); } finally {
      inFlight.current = false;
      if (live.current) setBusy(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current || lost) return;
    setError(null); setNotice(null); setStale(null);
    const first = branchBody(draft.current(), !branch);
    setErrors(first.errors);
    if (Object.keys(first.errors).length) return;
    if (branch && Object.keys(first.body).length === 0) { setNotice(t('common.nothingChanged')); return; }
    if (!branch) {
      await once(async () => {
        // The branches there are now, so that after a lost answer only a branch made since can be taken as this one.
        const known = queryClient.getQueryData<Branch[]>([...ctx.key, 'branches', 'with-closed'])
          ?? queryClient.getQueryData<Branch[]>([...ctx.key, 'branches', 'open']) ?? await ctx.api.branches({ includeInactive: canReopenBranches(ctx.actor) });
        await create(first.body as BranchInput, newRequestKey(), known.map((b) => b._id));
      });
      return;
    }
    await once(() => saveEdit(branch));
  }

  async function saveEdit(branch: Branch) {
    try {
      // Checked against what is saved now: nothing someone else changed meanwhile is overwritten unseen.
      const fresh = await ctx.api.branch(branch._id);
      const conflicts = rebaseTo(draftOf(fresh));
      for (const k of conflicts) dropped.current.add(k);
      if (conflicts.length) { setStale(staleMessage(conflictLabels(conflicts))); return; }
      if (fresh.isActive === false) { setStale(t('branches.closedMeanwhile', { name: fresh.name })); return; }
      const { body } = branchBody(draft.current(), false);
      if (Object.keys(body).length === 0) { setNotice(t('common.nothingChanged')); return; }
      const notSent = conflictLabels(stillDropped());
      let saved: Branch;
      try {
        // Q10: refused (409 RECORD_CHANGED) if the branch moved after the read above.
        saved = await ctx.api.updateBranch(branch._id, body, fresh.updatedAt);
      } catch (err) {
        if (!isRecordChanged(err)) throw err;
        const c = rebaseTo(draftOf(await ctx.api.branch(branch._id)));
        for (const k of c) dropped.current.add(k);
        setStale(c.length ? staleMessage(conflictLabels(c)) : RECORD_CHANGED_MESSAGE);
        return;
      }
      dropped.current.clear();
      await onSaved({ branch: saved, dropped: notSent });
    } catch (err) {
      if (live.current) setError(messageOf(err));
    } finally {
      void queryClient.invalidateQueries({ queryKey: [...ctx.key, 'branches'] });
    }
  }

  function addHoliday() {
    if (!ISO_DATE_PATTERN.test(holiday) || Number.isNaN(new Date(`${holiday}T00:00:00Z`).getTime())) { setHolidayError(t('branches.chooseDate')); return; }
    setHolidayError(null);
    draft.update((x) => ({ ...x, holidays: [...new Set([...x.holidays, holiday])].sort() }));
    setHoliday('');
  }

  return (
    <section className="ws-section" aria-labelledby="branch-form-h">
      <h2 id="branch-form-h">{branch ? t('branches.editName', { name: branch.name }) : t('branches.add')}</h2>
      <form className="rx-form" noValidate onSubmit={(e) => void submit(e)}>
        <fieldset className="ws-frozen" disabled={busy || !!lost}>
        <div className="rx-form-row">
          <TextField label={t('branches.name')} maxLength={MAX_NAME} {...field('name')} />
          <TextField label={t('branches.phone')} inputMode="numeric" maxLength={10} value={d.phone} error={errors.phone}
            onChange={(e) => draft.set('phone', e.target.value.replace(/\D/g, ''))} />
        </div>
        <div className="rx-form-row">
          <TextField label={t('branches.line1')} autoComplete="address-line1" {...field('line1')} />
          <TextField label={t('branches.line2')} autoComplete="address-line2" {...field('line2')} />
        </div>
        <div className="rx-form-row">
          <TextField label={t('branches.city')} autoComplete="address-level2" {...field('city')} />
          <TextField label={t('branches.state')} autoComplete="address-level1" {...field('state')} />
          <TextField label={t('branches.stateCode')} hint={t('branches.stateCodeHint')} {...field('stateCode')} />
          <TextField label={t('branches.pincode')} inputMode="numeric" autoComplete="postal-code" {...field('pincode')} />
        </div>
        <fieldset className="ws-checks">
          <legend>{t('branches.services')}</legend>
          {services.map((k) => (
            <label key={k} className="ws-check">
              <input type="checkbox" checked={d.services[k]} onChange={(e) => draft.set('services', { ...d.services, [k]: e.target.checked })} />
              {t(SERVICE_KEY[k])}
            </label>
          ))}
        </fieldset>
        <fieldset className="ws-checks">
          <legend>{t('branches.hours')}</legend>
          {WEEKDAYS.map(({ value, label }) => {
            const day = d.days[value];
            const set = (p: Partial<Draft['days'][Weekday]>) => draft.update((x) => ({ ...x, days: { ...x.days, [value]: { ...x.days[value], ...p } } }));
            return (
              <div key={value} className="ws-hours">
                <label className="ws-check"><input type="checkbox" checked={day.open} onChange={(e) => set({ open: e.target.checked })} /> {label}</label>
                {day.open ? (
                  <>
                    <TextField label={t('branches.opens', { day: label })} type="time" value={day.from} onChange={(e) => set({ from: e.target.value })} />
                    <TextField label={t('branches.closes', { day: label })} type="time" value={day.to} onChange={(e) => set({ to: e.target.value })}
                      error={errors[`day-${value}`]} />
                  </>
                ) : <span className="ws-muted">{t('branches.dayClosed')}</span>}
              </div>
            );
          })}
        </fieldset>
        <fieldset className="ws-checks">
          <legend>{t('branches.holidays')}</legend>
          <div className="ws-search">
            <TextField label={t('branches.holidayDate')} type="date" value={holiday} onChange={(e) => setHoliday(e.target.value)} error={holidayError ?? errors.holidays} />
            <Button variant="secondary" onClick={addHoliday}>{t('branches.addHoliday')}</Button>
          </div>
          {d.holidays.length === 0 ? <p className="ws-muted">{t('branches.noHolidays')}</p> : (
            <ul className="ws-list">
              {d.holidays.map((h) => (
                <li key={h}>
                  {h}{' '}
                  <Button variant="ghost" aria-label={t('branches.removeHoliday', { date: h })}
                    onClick={() => draft.update((x) => ({ ...x, holidays: x.holidays.filter((y) => y !== h) }))}>{shared('action.remove')}</Button>
                </li>
              ))}
            </ul>
          )}
        </fieldset>
        </fieldset>
        {stale && <Alert tone="warn">{stale}</Alert>}
        {notice && <Alert tone="ok">{notice}</Alert>}
        {error && <Alert>{error}</Alert>}
        {lost ? (
          <div className="confirm" role="group" aria-label={t('branches.unconfirmed')}>
            <div className="confirm-text">
              {t('branches.lost', { name: lost.body.name })}
            </div>
            <div className="confirm-actions">
              <Button busy={busy} onClick={() => { setError(null); void once(() => create(lost.body, lost.requestKey, lost.before, true)); }}>{t('branches.sendAgain')}</Button>
              <ConfirmAction label={t('branches.startAgain')} danger disabled={busy} confirmLabel={t('branches.unlock')}
                consequence={t('branches.startAgain.consequence', { name: lost.body.name })}
                onConfirm={async () => { setLost(null); setError(null); }} />
            </div>
          </div>
        ) : (
          <div className="ws-actions">
            <Button type="submit" busy={busy}>{branch ? t('branches.save') : t('branches.addBranch')}</Button>
            <Button variant="ghost" disabled={busy} onClick={onCancel}>{shared('action.cancel')}</Button>
          </div>
        )}
      </form>
    </section>
  );
}
