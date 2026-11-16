import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  allowedGstRates, ApiError, catalogueAdminApi, chargesGst, holdsAny, ITEM_KINDS_FOR, MAX_CODE, MAX_DESCRIPTION, MAX_ITEM_NAME,
  MAX_PREPARATION, MAX_PRICE_MINOR, MAX_SAC, MAX_SAMPLE_TYPE, paiseToInput, rupeesToPaise, TAX_REGIME_LABEL, usesVisitModes,
  type CatalogueItem, type CatalogueItemKind, type CatalogueItemUpdate, type GstRate, type NewCatalogueItem, type Page, type Partner,
  type PartnerKind, type VisitMode,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, Loading, TextArea, TextField } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { PendingOpPanel } from '../../components/PendingOpPanel.tsx';
import { dirtyKeys, staleMessage, useDraft, type DraftState } from '../../draft.ts';
import { messageOf } from '../../errors.ts';
import { afterFailure, beginAttempt, newRequestKey, resolveStored, startOp, stillCurrent, type PendingOp } from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { ITEM_KIND_LABEL, money, useCatalogue, VISIT_MODE_LABEL } from './billing.tsx';
import { NoSuchPartner, PartnerPageHeading, scopeIdentity, usePartnerScope, useWorkspacePartner, type ScopeContext } from './scope.tsx';

const MODES: VisitMode[] = ['home', 'lab'];

interface Draft {
  kind: CatalogueItemKind; name: string; code: string; description: string; preparation: string; sampleType: string;
  includes: string; price: string; mrp: string; gstRate: string; sac: string; visitModes: VisitMode[]; tat: string;
}

/** The form's view of an item (or of a new one for this kind of partner). */
export function draftOf(item?: CatalogueItem, partnerKind: PartnerKind = 'lab'): Draft {
  return {
    kind: item?.kind ?? ITEM_KINDS_FOR[partnerKind][0]!, name: item?.name ?? '', code: item?.code ?? '', description: item?.description ?? '',
    preparation: item?.preparation ?? '', sampleType: item?.sampleType ?? '', includes: (item?.includes ?? []).join('\n'),
    price: paiseToInput(item?.priceMinor), mrp: paiseToInput(item?.mrpMinor), gstRate: String(item?.gstRate ?? 0),
    sac: item?.sac ?? '',
    visitModes: item ? MODES.filter((m) => item.visitModes?.includes(m)) : usesVisitModes(partnerKind) ? ['lab'] : [],
    tat: item?.reportTatHours === undefined ? '' : String(item.reportTatHours),
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
 * Checks a draft against `createCatalogueItemSchema` / `updateCatalogueItemSchema` and the service's rules (MRP, Q10
 * `assertItemFits`: kinds by partner type, visit modes for labs only, GST only where it can be charged), and builds the
 * body: prices typed in rupees go out as integer paise. A new item sends every filled field; an edit sends ONLY the
 * fields the person changed from the baseline (`draft.ts`), so a field someone else changed meanwhile is never written
 * back. The schema cannot clear a text field, so emptying one that is set is refused here.
 */
export function itemBody(s: DraftState<Draft>, rates: readonly GstRate[], kind: PartnerKind, isEdit: boolean):
  { body: NewCatalogueItem | CatalogueItemUpdate; errors: Record<string, string> } {
  const d = s.draft;
  const was = s.base;
  const dirty = new Set<keyof Draft>(isEdit ? dirtyKeys(s) : (Object.keys(d) as (keyof Draft)[]));
  const errors: Record<string, string> = {};
  const full: Partial<NewCatalogueItem> = { kind: d.kind };
  if (!isEdit && !ITEM_KINDS_FOR[kind].includes(d.kind)) errors.kind = 'Choose one of the types offered.';
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

  if (usesVisitModes(kind)) {
    if (d.visitModes.length === 0) errors.visitModes = 'Choose at least one.';
    else full.visitModes = MODES.filter((m) => d.visitModes.includes(m));
    const tat = d.tat.trim();
    if (tat) {
      if (!/^\d{1,5}$/.test(tat)) errors.tat = 'Enter whole hours, like 24.';
      else full.reportTatHours = Number(tat);
    } else if (isEdit && was.tat) errors.tat = 'This cannot be removed here. Enter a new value.';
  }

  // Only the problems of fields this request will send (an untouched field is the server's own value).
  for (const k of Object.keys(errors) as (keyof Draft)[]) if (isEdit && !dirty.has(k)) delete errors[k];
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

/** A new item sent and not yet confirmed (Q10: exactly once per `requestKey`). Session memory + body-less reload marker. */
type PendingItem = PendingOp<NewCatalogueItem & { requestKey: string }>;

/** The price list as newest-first "records" a lost create is looked up in, by its stored `createRequestKey`. */
function itemFinder(ctx: ScopeContext) {
  return async (page: number): Promise<Page<CatalogueItem & { requestKey?: string; createdAt?: string }>> => {
    const all = await ctx.billing.catalogue(undefined, true);
    const items = all.map((i) => ({ ...i, requestKey: i.createRequestKey }));
    return { items, page, limit: items.length, total: items.length, totalPages: 1 };
  };
}

/** Tests and packages (labs) or services (clinics) with their prices: `catalogue.manage` edits, `invoices.create` reads. */
export function CatalogueScreen() {
  const ctx = usePartnerScope();
  if (!ctx) return <NoSuchPartner />;
  // One subtree per partner: an admin moving to another partner's price list starts with nothing open.
  return <Catalogue key={scopeIdentity(ctx)} ctx={ctx} />;
}

type StatusFilter = 'active' | 'offered' | 'disabled' | 'inactive';

function Catalogue({ ctx }: { ctx: ScopeContext }) {
  const queryClient = useQueryClient();
  const { api, memory } = useSession();
  const partner = useWorkspacePartner(ctx);
  const canManage = holdsAny(ctx.actor, ['catalogue.manage']);
  // Q10: catalogue managers also see deactivated items (to reactivate them).
  const items = useCatalogue(ctx, { includeInactive: canManage });
  const [kindFilter, setKindFilter] = useState<'' | CatalogueItemKind>('');
  const [status, setStatus] = useState<StatusFilter>('active');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const isAdmin = ctx.scope.kind === 'admin';
  const p = partner.data;
  const kind = p?.kind ?? 'lab';
  const refresh = () => queryClient.invalidateQueries({ queryKey: [...ctx.key, 'catalogue'] });
  const target = editing && editing !== 'new' ? items.data?.find((i) => i._id === editing && i.isActive) : undefined;
  const q = search.trim().toLowerCase();
  const shown = (items.data ?? []).filter((i) => (!kindFilter || i.kind === kindFilter)
    && (status === 'inactive' ? !i.isActive : i.isActive && (status === 'active' || (status === 'disabled') === i.adminDisabled))
    && (!q || i.name.toLowerCase().includes(q) || (i.code ?? '').toLowerCase().includes(q)));

  // ── Exactly-once create (Q10 requestKey) ──
  const slot = `catalogue-create:${scopeIdentity(ctx)}`;
  const [pending, setPendingState] = useState<PendingItem | undefined>(() => memory.get<PendingItem>(slot));
  const [createBusy, setCreateBusy] = useState(false);
  const [createRefused, setCreateRefused] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const setPending = (op: PendingItem | undefined) => {
    if (op) memory.set(slot, op); else memory.delete(slot);
    setPendingState(op);
  };
  /** An answer for `op` acts only while this page is on screen and the stored item is still exactly `op` (key + attempt). */
  const owns = (op: PendingItem) => mounted.current && stillCurrent(memory.get<PendingItem>(slot), op);
  const created = (it: CatalogueItem, op: PendingItem, earlier = false) => {
    void refresh();
    if (!owns(op)) return; // a newer attempt owns the state; resending it replays this same item
    const requestKey = op.requestKey;
    resolveStored(memory, slot, requestKey);
    setPendingState((cur) => (cur && cur.requestKey !== requestKey ? cur : undefined));
    setEditing((e) => (e === 'new' ? null : e));
    setNotice(earlier ? `${it.name} had already been added.` : `${it.name} was added.`);
  };
  /** Sends exactly `op` (same key, same content); only success or a definite refusal of its first attempt ends it. */
  async function sendCreate(op: PendingItem) {
    const attempt = beginAttempt(op);
    setCreateBusy(true);
    setCreateRefused(null);
    setPending(attempt);
    try {
      created(await ctx.billing.createCatalogueItem(attempt.body), attempt);
    } catch (err) {
      if (!stillCurrent(memory.get<PendingItem>(slot), attempt)) return;
      const next = afterFailure(attempt, err, messageOf(err));
      if (mounted.current) {
        setPending(next ?? undefined);
        if (!next) setCreateRefused(messageOf(err)); // refused, nothing added: the form keeps what was typed
        else setEditing((e) => (e === 'new' ? null : e)); // locked: only "send again" from here
      } else if (next) memory.set(slot, next); else memory.delete(slot);
    } finally {
      if (mounted.current) setCreateBusy(false);
    }
  }
  const showPending = pending && !(createBusy && pending.attempts === 1 && !pending.uncertain);

  return (
    <>
      <PartnerPageHeading ctx={ctx} title={kind === 'clinic' ? 'Services and prices' : 'Tests and prices'} partnerName={p?.name}>
        What customers can book and what appears on bills. Price changes apply at once.
      </PartnerPageHeading>
      {notice && <Alert tone="ok">{notice}</Alert>}
      {failure && <Alert>{failure}</Alert>}
      {p && !chargesGst(p) && (
        <p className="ws-muted">
          {p.name} cannot charge GST ({TAX_REGIME_LABEL[p.taxRegime]}{p.taxRegime !== 'unregistered' && !p.gstin ? ', no GSTIN' : ''}): items carry 0% GST.
        </p>
      )}
      {showPending ? (
        <PendingOpPanel key={pending.attempts} label="Unconfirmed item" op={pending} busy={createBusy} onResend={() => void sendCreate(pending)}
          fetchPage={itemFinder(ctx)}
          onFound={(it) => created(it, pending, true)}
          // No content is kept after a reload, and items have no server abandon: a new item is a deliberate decision.
          forget={pending.restored ? {
            label: 'Add a new item instead', confirmLabel: 'It may be a duplicate: add a new item',
            consequence: 'If the earlier item was added after all, the price list will have it twice: deactivate the extra one.',
            onForget: () => {
              if (!owns(pending)) return;
              const k = pending.requestKey;
              resolveStored(memory, slot, k);
              setPendingState((cur) => (cur && cur.requestKey !== k ? cur : undefined));
            },
          } : undefined}
          summary={pending.restored ? null : <div>New item: {pending.body.name} at {money(pending.body.priceMinor)}.</div>} />
      ) : canManage && editing === null && (
        <div><Button onClick={() => { setEditing('new'); setNotice(null); setCreateRefused(null); }}>Add an item</Button></div>
      )}
      {!canManage && <p className="ws-muted">You can see the catalogue to make bills; someone with “Manage tests and services” changes it.</p>}
      {p && ((editing === 'new' && !showPending) || target) && (
        <ItemForm key={editing} ctx={ctx} partner={p} item={target} onCancel={() => setEditing(null)}
          createBusy={createBusy} createRefused={createRefused}
          onCreate={(body) => {
            const requestKey = newRequestKey();
            void sendCreate(startOp(requestKey, { ...body, requestKey }));
          }}
          onSaved={async (it) => { setEditing(null); setNotice(`${it.name} was saved.`); await refresh(); }} />
      )}
      <div className="ws-search">
        <div className="j-field ws-filter">
          <label htmlFor="cat-kind">Type</label>
          <select id="cat-kind" value={kindFilter} onChange={(e) => setKindFilter(e.target.value as '' | CatalogueItemKind)}>
            <option value="">All</option>
            {ITEM_KINDS_FOR[kind].map((k) => <option key={k} value={k}>{ITEM_KIND_LABEL[k]}</option>)}
          </select>
        </div>
        <div className="j-field ws-filter">
          <label htmlFor="cat-status">Status</label>
          <select id="cat-status" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
            <option value="active">All active items</option>
            <option value="offered">Offered</option>
            <option value="disabled">Disabled by Jansetu</option>
            {canManage && <option value="inactive">Deactivated</option>}
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
                  {kind === 'lab' && <><th scope="col">Where</th><th scope="col">Report in</th></>}<th scope="col">Status</th>
                  {(canManage || isAdmin) && <th scope="col">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {shown.map((i) => (
                  <tr key={i._id}>
                    <td>{i.name}{i.code ? <span className="ws-muted"> · {i.code}</span> : null}</td>
                    <td>{ITEM_KIND_LABEL[i.kind] ?? i.kind}</td>
                    <td>{money(i.priceMinor)}{i.mrpMinor !== undefined && i.mrpMinor !== i.priceMinor ? <span className="ws-muted"> (MRP {money(i.mrpMinor)})</span> : null}</td>
                    <td>{i.gstRate}%{p && i.gstRate > 0 && !chargesGst(p) ? <> <Badge tone="warn">Cannot be billed</Badge></> : null}</td>
                    {kind === 'lab' && <>
                      <td>{(i.visitModes ?? []).map((m) => VISIT_MODE_LABEL[m] ?? m).join(', ') || '—'}</td>
                      <td>{i.reportTatHours !== undefined ? `${i.reportTatHours} h` : '—'}</td>
                    </>}
                    <td>
                      {!i.isActive ? <Badge>Deactivated</Badge> : null}{!i.isActive && i.adminDisabled ? ' ' : null}
                      {i.adminDisabled ? <Badge tone="danger">Disabled by Jansetu</Badge> : i.isActive ? <Badge tone="ok">Offered</Badge> : null}
                    </td>
                    {(canManage || isAdmin) && (
                      <td>
                        <div className="ws-actions">
                          {canManage && i.isActive && <Button variant="secondary" aria-label={`Edit ${i.name}`} onClick={() => { setEditing(i._id); setNotice(null); }}>Edit</Button>}
                          {canManage && i.isActive && (
                            <ConfirmAction label="Deactivate" danger confirmLabel={`Deactivate ${i.name}`}
                              consequence={`${i.name} is taken off the catalogue: customers can no longer book it and it cannot be put on new bills. Bills already issued keep it. It can be reactivated later (Status: Deactivated).`}
                              onConfirm={async () => {
                                try { await ctx.billing.deactivateCatalogueItem(i._id); setNotice(`${i.name} was deactivated.`); } finally { await refresh(); }
                              }} />
                          )}
                          {canManage && !i.isActive && (
                            <Button variant="secondary" aria-label={`Reactivate ${i.name}`} onClick={async () => {
                              setNotice(null); setFailure(null);
                              try { await ctx.billing.reactivateCatalogueItem(i._id); setNotice(`${i.name} is active again.`); }
                              catch (err) { setFailure(`${i.name} was not reactivated: ${messageOf(err)}`); } finally { await refresh(); }
                            }}>Reactivate</Button>
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

function ItemForm({ ctx, partner, item, onCancel, onSaved, onCreate, createBusy, createRefused }: {
  ctx: ScopeContext; partner: Partner; item?: CatalogueItem; onCancel: () => void; onSaved: (i: CatalogueItem) => Promise<void>;
  /** New items go through the exactly-once create of the screen (keyed, resendable). */
  onCreate: (body: NewCatalogueItem) => void; createBusy: boolean; createRefused: string | null;
}) {
  const queryClient = useQueryClient();
  const kind = partner.kind;
  const draft = useDraft(() => draftOf(item, kind));
  const d = draft.draft;
  const { rebaseTo } = draft;
  /** Q10: the item's `updatedAt` the baseline belongs to, sent as `expectedUpdatedAt`. */
  const baseUpdatedAt = useRef(item?.updatedAt);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stale, setStale] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const allowed = allowedGstRates(partner);
  const current = item ? (Number(draft.state.base.gstRate) as GstRate) : undefined;
  const rateOptions = current !== undefined && !allowed.includes(current) ? [...allowed, current] : allowed;
  const setField = <K extends keyof Draft>(k: K, v: Draft[K]) => draft.set(k, v);
  const text = (k: TextKey) => ({ value: d[k], error: errors[k], maxLength: LIMITS[k], onChange: (e: { target: { value: string } }) => setField(k, e.target.value) });

  // Editing: a refreshed item moves untouched fields along; a field changed here AND there is reset for review.
  const serverValue = item ? JSON.stringify(draftOf(item, kind)) : null;
  const serverUpdatedAt = item?.updatedAt;
  useEffect(() => {
    if (!serverValue) return;
    const c = rebaseTo(JSON.parse(serverValue) as Draft);
    baseUpdatedAt.current = serverUpdatedAt;
    if (c.length) setStale(staleMessage(c.map((k) => FIELD_LABEL[k])));
  }, [serverValue, serverUpdatedAt, rebaseTo]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null); setNotice(null); setStale(null);
    const first = itemBody(draft.current(), allowed, kind, !!item);
    setErrors(first.errors);
    if (Object.keys(first.errors).length) return;
    if (!item) { onCreate(first.body as NewCatalogueItem); return; }
    if (Object.keys(first.body).length === 0) { setNotice('Nothing has changed.'); return; }
    setBusy(true);
    try {
      // Checked against what is saved now: nothing someone else changed meanwhile is overwritten unseen.
      const fresh = await ctx.billing.catalogueItem(item._id);
      if (fresh.isActive === false) { setStale(`${fresh.name} was deactivated meanwhile.`); return; }
      const conflicts = rebaseTo(draftOf(fresh, kind));
      baseUpdatedAt.current = fresh.updatedAt;
      if (conflicts.length) { setStale(staleMessage(conflicts.map((k) => FIELD_LABEL[k]))); return; }
      const { body, errors: errs } = itemBody(draft.current(), allowed, kind, true);
      setErrors(errs);
      if (Object.keys(errs).length) return;
      if (Object.keys(body).length === 0) { setNotice('Nothing has changed.'); return; }
      // Q10: the server refuses (409 CATALOGUE_ITEM_CHANGED) if the item moved after the version this edit is based on.
      await onSaved(await ctx.billing.updateCatalogueItem(item._id, { ...body, ...(baseUpdatedAt.current ? { expectedUpdatedAt: baseUpdatedAt.current } : {}) }));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CATALOGUE_ITEM_CHANGED') {
        setStale(`${err.message} The form now follows the saved item; your changes to other fields are kept.`);
      } else setError(messageOf(err));
    } finally {
      setBusy(false);
      void queryClient.invalidateQueries({ queryKey: [...ctx.key, 'catalogue'] });
    }
  }

  const kinds = ITEM_KINDS_FOR[kind];
  return (
    <section className="ws-section" aria-labelledby="item-form-h">
      <h2 id="item-form-h">{item ? `Edit ${item.name}` : 'Add an item'}</h2>
      <form className="rx-form" noValidate onSubmit={(e) => void submit(e)}>
        {!item && (
          <fieldset className="ws-checks" aria-describedby={errors.kind ? 'item-kind-error' : undefined}>
            <legend>Type</legend>
            {kinds.map((k) => (
              <label key={k} className="ws-check">
                <input type="radio" name="item-kind" checked={d.kind === k} onChange={() => setField('kind', k)} /> {ITEM_KIND_LABEL[k]}
              </label>
            ))}
            {errors.kind && <span id="item-kind-error" className="j-field__error">{errors.kind}</span>}
          </fieldset>
        )}
        <div className="rx-form-row">
          <TextField label="Name" {...text('name')} />
          <TextField label="Code (optional)" {...text('code')} />
        </div>
        <div className="rx-form-row">
          <TextField label="Price (₹)" inputMode="decimal" value={d.price} error={errors.price} onChange={(e) => setField('price', e.target.value)} />
          <TextField label="MRP (₹, optional)" inputMode="decimal" value={d.mrp} error={errors.mrp} hint="Not below the price."
            onChange={(e) => setField('mrp', e.target.value)} />
          <div className="j-field">
            <label htmlFor="item-gst">GST rate</label>
            <select id="item-gst" value={d.gstRate} aria-describedby="item-gst-hint" aria-invalid={errors.gstRate ? true : undefined}
              onChange={(e) => setField('gstRate', e.target.value)}>
              {rateOptions.map((r) => <option key={r} value={r}>{r}%{allowed.includes(r) ? '' : ' (cannot be billed)'}</option>)}
            </select>
            <span id="item-gst-hint" className="j-field__hint">
              {chargesGst(partner) ? 'The rate charged on bills.' : `${partner.name} is not registered for regular GST, so only 0% can be billed.`}
            </span>
            {errors.gstRate && <span className="j-field__error">{errors.gstRate}</span>}
          </div>
          <TextField label="SAC (optional)" {...text('sac')} />
        </div>
        {usesVisitModes(kind) && (
          <>
            <fieldset className="ws-checks" aria-describedby={errors.visitModes ? 'item-modes-error' : undefined}>
              <legend>Where it is offered</legend>
              {MODES.map((m) => (
                <label key={m} className="ws-check">
                  <input type="checkbox" checked={d.visitModes.includes(m)}
                    onChange={(e) => draft.update((x) => ({ ...x, visitModes: e.target.checked ? MODES.filter((y) => y === m || x.visitModes.includes(y)) : x.visitModes.filter((y) => y !== m) }))} />
                  {VISIT_MODE_LABEL[m]}
                </label>
              ))}
              {errors.visitModes && <span id="item-modes-error" className="j-field__error">{errors.visitModes}</span>}
            </fieldset>
            <div className="rx-form-row">
              <TextField label="Sample type (optional)" {...text('sampleType')} />
              <TextField label="Report within (hours, optional)" inputMode="numeric" value={d.tat} error={errors.tat}
                onChange={(e) => setField('tat', e.target.value.replace(/\D/g, ''))} />
            </div>
          </>
        )}
        <TextArea label="Description (optional)" {...text('description')} />
        <TextArea label="Preparation (optional)" hint="For example: fasting for 10 hours." {...text('preparation')} />
        {(d.kind === 'package' || d.includes.trim()) && (
          <TextArea label="Includes (one per line)" value={d.includes} onChange={(e) => setField('includes', e.target.value)} />
        )}
        {notice && <Alert tone="ok">{notice}</Alert>}
        {stale && <Alert tone="warn">{stale}</Alert>}
        {error && <Alert>{error}</Alert>}
        {!item && createRefused && <Alert>Not added: {createRefused}</Alert>}
        <div className="ws-actions">
          <Button type="submit" busy={busy || (!item && createBusy)}>{item ? 'Save item' : 'Add item'}</Button>
          <Button variant="ghost" disabled={busy || (!item && createBusy)} onClick={onCancel}>Cancel</Button>
        </div>
      </form>
    </section>
  );
}
