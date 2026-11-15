import { useEffect, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  allowedGstRates, catalogueAdminApi, chargesGst, holdsAny, MAX_CODE, MAX_DESCRIPTION, MAX_ITEM_NAME, MAX_PREPARATION,
  MAX_PRICE_MINOR, MAX_SAC, MAX_SAMPLE_TYPE, paiseToInput, rupeesToPaise, TAX_REGIME_LABEL,
  type CatalogueItem, type CatalogueItemKind, type CatalogueItemUpdate, type GstRate, type NewCatalogueItem, type Partner,
  type PartnerKind, type VisitMode,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, Loading, TextArea, TextField } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { dirtyKeys, staleMessage, useDraft, type DraftState } from '../../draft.ts';
import { definitelyNotRecorded } from '../../requests.ts';
import { messageOf } from '../../errors.ts';
import { useSession } from '../../session.tsx';
import { ITEM_KIND_LABEL, money, useCatalogue, VISIT_MODE_LABEL } from './billing.tsx';
import { NoSuchPartner, PartnerPageHeading, scopeIdentity, usePartnerScope, useWorkspacePartner, type ScopeContext } from './scope.tsx';

const KINDS: CatalogueItemKind[] = ['test', 'package'];
const MODES: VisitMode[] = ['home', 'lab'];

interface Draft {
  kind: CatalogueItemKind; name: string; code: string; description: string; preparation: string; sampleType: string;
  includes: string; price: string; mrp: string; gstRate: string; sac: string; visitModes: VisitMode[]; tat: string;
}

export function draftOf(item?: CatalogueItem): Draft {
  return {
    kind: item?.kind ?? 'test', name: item?.name ?? '', code: item?.code ?? '', description: item?.description ?? '',
    preparation: item?.preparation ?? '', sampleType: item?.sampleType ?? '', includes: (item?.includes ?? []).join('\n'),
    price: paiseToInput(item?.priceMinor), mrp: paiseToInput(item?.mrpMinor), gstRate: String(item?.gstRate ?? 0),
    sac: item?.sac ?? '', visitModes: item ? MODES.filter((m) => item.visitModes?.includes(m)) : ['lab'], tat: item?.reportTatHours === undefined ? '' : String(item.reportTatHours),
  };
}

type TextKey = 'name' | 'code' | 'description' | 'preparation' | 'sampleType' | 'sac';
const LIMITS: Record<TextKey, number> = {
  name: MAX_ITEM_NAME, code: MAX_CODE, description: MAX_DESCRIPTION, preparation: MAX_PREPARATION, sampleType: MAX_SAMPLE_TYPE, sac: MAX_SAC,
};

/** Words for a field in a stale-edit notice. */
const FIELD_LABEL: Record<keyof Draft, string> = {
  kind: 'type', name: 'name', code: 'code', description: 'description', preparation: 'preparation', sampleType: 'sample type',
  includes: 'contents', price: 'price', mrp: 'MRP', gstRate: 'GST rate', sac: 'SAC', visitModes: 'places offered', tat: 'report time',
};

/**
 * Checks a draft against `createCatalogueItemSchema` / `updateCatalogueItemSchema` and the service's MRP rule, and
 * builds the body: prices typed in rupees go out as integer paise. A new item sends every filled field; an edit sends
 * ONLY the fields the person changed from the baseline (`draft.ts`), so a field someone else changed meanwhile is never
 * written back. The schema cannot clear a text field, so emptying one that is set is refused here.
 */
export function itemBody(s: DraftState<Draft>, rates: readonly GstRate[], kind: PartnerKind, isEdit: boolean):
  { body: NewCatalogueItem | CatalogueItemUpdate; errors: Record<string, string> } {
  const d = s.draft;
  const was = s.base;
  const dirty = new Set<keyof Draft>(isEdit ? dirtyKeys(s) : (Object.keys(d) as (keyof Draft)[]));
  const errors: Record<string, string> = {};
  const full: Partial<NewCatalogueItem> = { kind: d.kind };
  for (const k of Object.keys(LIMITS) as TextKey[]) {
    const v = d[k].trim();
    if (k === 'sampleType' && kind !== 'lab') continue;
    if (v.length > LIMITS[k]) { errors[k] = `Use at most ${LIMITS[k]} characters.`; continue; }
    if (!v) {
      if (k === 'name') errors.name = 'Enter the name.';
      else if (isEdit && was[k].trim()) errors[k] = 'This cannot be removed here. Enter a new value.';
      continue;
    }
    full[k] = v;
  }
  const includes = d.includes.split('\n').map((x) => x.trim()).filter(Boolean);
  if (d.kind === 'package' || includes.length || (isEdit && was.includes.trim())) full.includes = includes;

  const price = rupeesToPaise(d.price);
  if (price === null) errors.price = d.price.trim() ? 'Enter rupees, like 450 or 450.50.' : 'Enter the price.';
  else if (price > MAX_PRICE_MINOR) errors.price = 'This price is above the largest the server accepts.';
  else full.priceMinor = price;
  if (d.mrp.trim()) {
    const mrp = rupeesToPaise(d.mrp);
    if (mrp === null) errors.mrp = 'Enter rupees, like 500 or 500.50.';
    else if (mrp > MAX_PRICE_MINOR) errors.mrp = 'This MRP is above the largest the server accepts.';
    else if (price !== null && mrp < price) errors.mrp = 'MRP cannot be below the price.';
    else full.mrpMinor = mrp;
  } else if (isEdit && was.mrp) errors.mrp = 'The MRP cannot be removed here. Enter a new value.';

  const rate = Number(d.gstRate) as GstRate;
  if (!rates.includes(rate) && dirty.has('gstRate')) errors.gstRate = 'Choose one of the GST rates offered.';
  else full.gstRate = rate;

  if (d.visitModes.length === 0) errors.visitModes = 'Choose at least one.';
  else full.visitModes = MODES.filter((m) => d.visitModes.includes(m));

  if (kind === 'lab') {
    const tat = d.tat.trim();
    if (tat) {
      if (!/^\d{1,5}$/.test(tat)) errors.tat = 'Enter whole hours, like 24.';
      else full.reportTatHours = Number(tat);
    } else if (isEdit && was.tat) errors.tat = 'This cannot be removed here. Enter a new value.';
  }

  // Only the problems of fields this request will send (an untouched field is the server's own value).
  const sent = (k: keyof Draft) => dirty.has(k);
  for (const k of Object.keys(errors) as (keyof Draft)[]) if (isEdit && !sent(k)) delete errors[k];
  if (!isEdit) return { body: full as NewCatalogueItem, errors };
  const KEY: Partial<Record<keyof Draft, keyof NewCatalogueItem>> = {
    name: 'name', code: 'code', description: 'description', preparation: 'preparation', sampleType: 'sampleType', sac: 'sac',
    includes: 'includes', price: 'priceMinor', mrp: 'mrpMinor', gstRate: 'gstRate', visitModes: 'visitModes', tat: 'reportTatHours',
  };
  const body: CatalogueItemUpdate = {};
  for (const k of dirty) {
    const key = KEY[k];
    if (key && full[key] !== undefined) (body as Record<string, unknown>)[key] = full[key];
  }
  // The MRP may not fall below the price: a changed price is checked against the saved MRP too (the server re-checks).
  const savedMrp = d.mrp.trim() ? rupeesToPaise(d.mrp) : null;
  if (body.priceMinor !== undefined && !dirty.has('mrp') && savedMrp !== null && savedMrp < body.priceMinor) {
    errors.price = 'The price cannot be above the MRP. Change the MRP too.';
  }
  return { body, errors };
}

/** Tests and packages (labs) or services (clinics) with their prices: `catalogue.manage` edits, `invoices.create` reads. */
export function CatalogueScreen() {
  const ctx = usePartnerScope();
  if (!ctx) return <NoSuchPartner />;
  // One subtree per partner: an admin moving to another partner's price list starts with nothing open.
  return <Catalogue key={scopeIdentity(ctx)} ctx={ctx} />;
}

function Catalogue({ ctx }: { ctx: ScopeContext }) {
  const queryClient = useQueryClient();
  const { api } = useSession();
  const partner = useWorkspacePartner(ctx);
  const items = useCatalogue(ctx);
  const [kindFilter, setKindFilter] = useState<'' | CatalogueItemKind>('');
  const [status, setStatus] = useState<'all' | 'offered' | 'disabled'>('all');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const canManage = holdsAny(ctx.actor, ['catalogue.manage']);
  const isAdmin = ctx.scope.kind === 'admin';
  const p = partner.data;
  const kind = p?.kind ?? 'lab';
  const refresh = () => queryClient.invalidateQueries({ queryKey: [...ctx.key, 'catalogue'] });
  const target = editing && editing !== 'new' ? items.data?.find((i) => i._id === editing) : undefined;
  const q = search.trim().toLowerCase();
  const shown = (items.data ?? []).filter((i) => (!kindFilter || i.kind === kindFilter)
    && (status === 'all' || (status === 'disabled') === i.adminDisabled)
    && (!q || i.name.toLowerCase().includes(q) || (i.code ?? '').toLowerCase().includes(q)));

  return (
    <>
      <PartnerPageHeading ctx={ctx} title={kind === 'clinic' ? 'Services and prices' : 'Tests and prices'} partnerName={p?.name}>
        What customers can book and what appears on bills. Price changes apply at once.
      </PartnerPageHeading>
      {notice && <Alert tone="ok">{notice}</Alert>}
      {failure && <Alert>{failure}</Alert>}
      {warning && <Alert tone="warn">{warning}</Alert>}
      {p && !chargesGst(p) && (
        <p className="ws-muted">
          {p.name} cannot charge GST ({TAX_REGIME_LABEL[p.taxRegime]}{p.taxRegime !== 'unregistered' && !p.gstin ? ', no GSTIN' : ''}): bills carry 0% GST,
          and an item with another rate cannot be billed.
        </p>
      )}
      {canManage && editing === null && <div><Button onClick={() => { setEditing('new'); setNotice(null); setWarning(null); }}>Add an item</Button></div>}
      {!canManage && <p className="ws-muted">You can see the catalogue to make bills; someone with “Manage tests and services” changes it.</p>}
      {p && (editing === 'new' || target) && (
        <ItemForm key={editing} ctx={ctx} partner={p} item={target} onCancel={() => setEditing(null)}
          onSaved={async (it, created) => { setEditing(null); setNotice(created ? `${it.name} was added.` : `${it.name} was saved.`); await refresh(); }}
          onUnsure={async (name) => {
            setEditing(null); setKindFilter(''); setStatus('all'); setSearch(name);
            setWarning(`The answer to adding ${name} was lost. The list below is fresh: if ${name} is in it, it was added; add it again only if it is not.`);
            await refresh();
          }} />
      )}
      <div className="ws-search">
        <div className="j-field ws-filter">
          <label htmlFor="cat-kind">Type</label>
          <select id="cat-kind" value={kindFilter} onChange={(e) => setKindFilter(e.target.value as '' | CatalogueItemKind)}>
            <option value="">All</option>
            {KINDS.map((k) => <option key={k} value={k}>{ITEM_KIND_LABEL[kind][k]}</option>)}
          </select>
        </div>
        <div className="j-field ws-filter">
          <label htmlFor="cat-status">Status</label>
          <select id="cat-status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="all">All active items</option>
            <option value="offered">Offered</option>
            <option value="disabled">Disabled by Jansetu</option>
          </select>
        </div>
        <TextField label="Search by name or code" type="search" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {items.isPending || partner.isPending ? <Loading label="Loading the catalogue…" />
        : items.isError ? <ErrorState message={messageOf(items.error)} onRetry={() => void items.refetch()} />
        : partner.isError ? <ErrorState message={messageOf(partner.error)} onRetry={() => void partner.refetch()} />
        : items.data.length === 0 ? <Empty title="No items yet">{canManage ? 'Add the first item to start billing and taking bookings.' : null}</Empty>
        : shown.length === 0 ? <Empty title="No matching items">Change the filters to see more.</Empty>
        : (
          <div className="ws-table-wrap">
            <table className="j-table">
              <caption className="j-sr-only">Catalogue items</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th><th scope="col">Type</th><th scope="col">Price</th><th scope="col">GST</th>
                  <th scope="col">Where</th>{kind === 'lab' && <th scope="col">Report in</th>}<th scope="col">Status</th>
                  {(canManage || isAdmin) && <th scope="col">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {shown.map((i) => (
                  <tr key={i._id}>
                    <td>{i.name}{i.code ? <span className="ws-muted"> · {i.code}</span> : null}</td>
                    <td>{ITEM_KIND_LABEL[kind][i.kind] ?? i.kind}</td>
                    <td>{money(i.priceMinor)}{i.mrpMinor !== undefined && i.mrpMinor !== i.priceMinor ? <span className="ws-muted"> (MRP {money(i.mrpMinor)})</span> : null}</td>
                    <td>{i.gstRate}%{p && i.gstRate > 0 && !chargesGst(p) ? <> <Badge tone="warn">Cannot be billed</Badge></> : null}</td>
                    <td>{i.visitModes.map((m) => VISIT_MODE_LABEL[kind][m] ?? m).join(', ')}</td>
                    {kind === 'lab' && <td>{i.reportTatHours !== undefined ? `${i.reportTatHours} h` : '—'}</td>}
                    <td>{i.adminDisabled ? <Badge tone="danger">Disabled by Jansetu</Badge> : <Badge tone="ok">Offered</Badge>}</td>
                    {(canManage || isAdmin) && (
                      <td>
                        <div className="ws-actions">
                          {canManage && <Button variant="secondary" aria-label={`Edit ${i.name}`} onClick={() => { setEditing(i._id); setNotice(null); }}>Edit</Button>}
                          {canManage && (
                            <ConfirmAction label="Deactivate" danger confirmLabel={`Deactivate ${i.name}`}
                              consequence={`${i.name} is removed from the catalogue: customers can no longer book it and it cannot be put on new bills. Bills already issued keep it. It cannot be reactivated from the workspace.`}
                              onConfirm={async () => {
                                try { await ctx.billing.deactivateCatalogueItem(i._id); setNotice(`${i.name} was deactivated.`); } finally { await refresh(); }
                              }} />
                          )}
                          {isAdmin && (i.adminDisabled ? (
                            <Button variant="secondary" onClick={async () => {
                              setNotice(null); setFailure(null);
                              try { await catalogueAdminApi(api).enable(i._id); setNotice(`${i.name} is offered again.`); }
                              catch (err) { setFailure(`${i.name} was not enabled: ${messageOf(err)}`); } finally { await refresh(); }
                            }}>Enable</Button>
                          ) : (
                            <ConfirmAction label="Disable" danger confirmLabel={`Disable ${i.name}`}
                              consequence={`${i.name} stays in the partner’s list marked “Disabled by Jansetu”: customers cannot book it and it cannot be billed until a Jansetu admin enables it again. The partner cannot undo this.`}
                              onConfirm={async () => {
                                try { await catalogueAdminApi(api).disable(i._id); setNotice(`${i.name} was disabled.`); } finally { await refresh(); }
                              }} />
                          ))}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </>
  );
}

function ItemForm({ ctx, partner, item, onCancel, onSaved, onUnsure }: {
  ctx: ScopeContext; partner: Partner; item?: CatalogueItem; onCancel: () => void; onSaved: (i: CatalogueItem, created: boolean) => Promise<void>;
  /** A new item's answer was lost: the person must look in the list before adding it again. */
  onUnsure: (name: string) => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const draft = useDraft(() => draftOf(item));
  const d = draft.draft;
  const { rebaseTo } = draft;
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stale, setStale] = useState<string | null>(null);
  /** Create only: the outcome is unknown and the backend cannot recognise a repeat (no request key for items). */
  const [unsure, setUnsure] = useState<{ name: string; error: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const kind = partner.kind;
  const allowed = allowedGstRates(partner);
  const current = item ? (Number(draft.state.base.gstRate) as GstRate) : undefined;
  const rateOptions = current !== undefined && !allowed.includes(current) ? [...allowed, current] : allowed;
  const setField = <K extends keyof Draft>(k: K, v: Draft[K]) => draft.set(k, v);
  const text = (k: TextKey) => ({ value: d[k], error: errors[k], maxLength: LIMITS[k], disabled: !!unsure, onChange: (e: { target: { value: string } }) => setField(k, e.target.value) });

  // Editing: a refreshed item moves untouched fields along; a field changed here AND there is reset for review.
  const serverValue = item ? JSON.stringify(draftOf(item)) : null;
  useEffect(() => {
    if (!serverValue) return;
    const c = rebaseTo(JSON.parse(serverValue) as Draft);
    if (c.length) setStale(staleMessage(c.map((k) => FIELD_LABEL[k])));
  }, [serverValue, rebaseTo]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (unsure) return;
    setError(null); setNotice(null); setStale(null);
    const first = itemBody(draft.current(), allowed, kind, !!item);
    setErrors(first.errors);
    if (Object.keys(first.errors).length) return;
    if (item && Object.keys(first.body).length === 0) { setNotice('Nothing has changed.'); return; }
    setBusy(true);
    try {
      if (!item) {
        try {
          await onSaved(await ctx.billing.createCatalogueItem(first.body as NewCatalogueItem), true);
        } catch (err) {
          // Refused by the server: nothing was added and the form can be corrected. Otherwise it may have been added.
          if (definitelyNotRecorded(err)) setError(messageOf(err));
          else setUnsure({ name: (first.body as NewCatalogueItem).name, error: messageOf(err) });
        }
        return;
      }
      // Checked against what is saved now: nothing someone else changed meanwhile is overwritten unseen.
      const fresh = await ctx.billing.catalogueItem(item._id);
      if (fresh.isActive === false) { setStale(`${fresh.name} was deactivated meanwhile.`); return; }
      const conflicts = rebaseTo(draftOf(fresh));
      if (conflicts.length) { setStale(staleMessage(conflicts.map((k) => FIELD_LABEL[k]))); return; }
      const { body, errors: errs } = itemBody(draft.current(), allowed, kind, true);
      setErrors(errs);
      if (Object.keys(errs).length) return;
      if (Object.keys(body).length === 0) { setNotice('Nothing has changed.'); return; }
      await onSaved(await ctx.billing.updateCatalogueItem(item._id, body), false);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
      if (item) void queryClient.invalidateQueries({ queryKey: [...ctx.key, 'catalogue'] });
    }
  }

  return (
    <section className="ws-section" aria-labelledby="item-form-h">
      <h2 id="item-form-h">{item ? `Edit ${item.name}` : 'Add an item'}</h2>
      <form className="rx-form" noValidate onSubmit={(e) => void submit(e)}>
        {!item && (
          <fieldset className="ws-checks">
            <legend>Type</legend>
            {KINDS.map((k) => (
              <label key={k} className="ws-check">
                <input type="radio" name="item-kind" checked={d.kind === k} disabled={!!unsure} onChange={() => setField('kind', k)} /> {ITEM_KIND_LABEL[kind][k]}
              </label>
            ))}
          </fieldset>
        )}
        <div className="rx-form-row">
          <TextField label="Name" {...text('name')} />
          <TextField label="Code (optional)" {...text('code')} />
        </div>
        <div className="rx-form-row">
          <TextField label="Price (₹)" inputMode="decimal" value={d.price} error={errors.price} disabled={!!unsure} onChange={(e) => setField('price', e.target.value)} />
          <TextField label="MRP (₹, optional)" inputMode="decimal" value={d.mrp} error={errors.mrp} hint="Not below the price."
            disabled={!!unsure} onChange={(e) => setField('mrp', e.target.value)} />
          <div className="j-field">
            <label htmlFor="item-gst">GST rate</label>
            <select id="item-gst" value={d.gstRate} aria-describedby="item-gst-hint" aria-invalid={errors.gstRate ? true : undefined}
              disabled={!!unsure} onChange={(e) => setField('gstRate', e.target.value)}>
              {rateOptions.map((r) => <option key={r} value={r}>{r}%{allowed.includes(r) ? '' : ' (cannot be billed)'}</option>)}
            </select>
            <span id="item-gst-hint" className="j-field__hint">
              {chargesGst(partner) ? 'The rate charged on bills.' : `${partner.name} is not registered for regular GST, so only 0% can be billed.`}
            </span>
            {errors.gstRate && <span className="j-field__error">{errors.gstRate}</span>}
          </div>
          <TextField label="SAC (optional)" {...text('sac')} />
        </div>
        <fieldset className="ws-checks" aria-describedby={errors.visitModes ? 'item-modes-error' : undefined}>
          <legend>Where it is offered</legend>
          {MODES.map((m) => (
            <label key={m} className="ws-check">
              <input type="checkbox" checked={d.visitModes.includes(m)}
                disabled={!!unsure} onChange={(e) => draft.update((x) => ({ ...x, visitModes: e.target.checked ? MODES.filter((y) => y === m || x.visitModes.includes(y)) : x.visitModes.filter((y) => y !== m) }))} />
              {VISIT_MODE_LABEL[kind][m]}
            </label>
          ))}
          {errors.visitModes && <span id="item-modes-error" className="j-field__error">{errors.visitModes}</span>}
        </fieldset>
        {kind === 'lab' && (
          <div className="rx-form-row">
            <TextField label="Sample type (optional)" {...text('sampleType')} />
            <TextField label="Report within (hours, optional)" inputMode="numeric" value={d.tat} error={errors.tat}
              disabled={!!unsure} onChange={(e) => setField('tat', e.target.value.replace(/\D/g, ''))} />
          </div>
        )}
        <TextArea label="Description (optional)" {...text('description')} />
        <TextArea label="Preparation (optional)" hint="For example: fasting for 10 hours." {...text('preparation')} />
        {(d.kind === 'package' || d.includes.trim()) && (
          <TextArea label="Includes (one per line)" value={d.includes} disabled={!!unsure} onChange={(e) => setField('includes', e.target.value)} />
        )}
        {notice && <Alert tone="ok">{notice}</Alert>}
        {stale && <Alert tone="warn">{stale}</Alert>}
        {error && <Alert>{error}</Alert>}
        {unsure ? (
          <div className="confirm" role="group" aria-label="Unconfirmed item">
            <Alert tone="warn">
              We could not confirm whether {unsure.name} was added ({unsure.error}). Adding it again could make a second copy,
              because the server cannot recognise a repeat. Look for it in the list first.
            </Alert>
            <div className="confirm-actions">
              <Button busy={busy} onClick={() => { setBusy(true); void onUnsure(unsure.name).finally(() => setBusy(false)); }}>Look in the list</Button>
            </div>
          </div>
        ) : (
          <div className="ws-actions">
            <Button type="submit" busy={busy}>{item ? 'Save item' : 'Add item'}</Button>
            <Button variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
          </div>
        )}
      </form>
    </section>
  );
}
