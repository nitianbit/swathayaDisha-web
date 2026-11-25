import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  allowedGstRates, ApiError, catalogueAdminApi, chargesGst, holdsAny, ITEM_KINDS_FOR, MAX_CATALOGUE_SEARCH, MAX_CODE, MAX_DESCRIPTION, MAX_ITEM_NAME,
  MAX_PREPARATION, MAX_PRICE_MINOR, MAX_SAC, MAX_SAMPLE_TYPE, paiseToInput, rupeesToPaise, TAX_REGIME_LABEL, usesVisitModes,
  type CatalogueItem, type CatalogueItemKind, type CatalogueItemUpdate, type GstRate, type NewCatalogueItem, type Partner,
  type PartnerKind, type VisitMode,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, Loading, TextArea, TextField } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { PendingOpPanel } from '../../components/PendingOpPanel.tsx';
import { dirtyKeys, staleMessage, useDraft, type DraftState } from '../../draft.ts';
import { messageOf } from '../../errors.ts';
import {
  afterFailure, beginAttempt, keyedLookup, newRequestKey, ownsKey, resolveStored, startOp, stillCurrent, wasAbandoned, type PendingOp,
} from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { itemKindLabel, money, useCatalogue, visitModeLabel } from './billing.tsx';
import { NoSuchPartner, PartnerPageHeading, scopeIdentity, usePartnerScope, useWorkspacePartner, type ScopeContext } from './scope.tsx';
import { t, type PartnerKey } from '../../i18n/partner/index.ts';

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
const FIELD_KEY = {
  // i18n-ignore: keys of this catalogue, not words
  kind: 'catalogue.field.kind', name: 'catalogue.field.name', code: 'catalogue.field.code', description: 'catalogue.field.description',
  preparation: 'catalogue.field.preparation', sampleType: 'catalogue.field.sampleType', includes: 'catalogue.field.includes',
  price: 'catalogue.field.price', mrp: 'catalogue.field.mrp', gstRate: 'catalogue.field.gstRate', sac: 'catalogue.field.sac',
  visitModes: 'catalogue.field.visitModes', tat: 'catalogue.field.tat',
} as const satisfies Record<keyof Draft, PartnerKey>;
const fieldLabel = (k: keyof Draft) => t(FIELD_KEY[k]);

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
  if (!isEdit && !ITEM_KINDS_FOR[kind].includes(d.kind)) errors.kind = t('catalogue.error.kind');
  for (const k of Object.keys(LIMITS) as TextKey[]) {
    const v = d[k].trim();
    if (k === 'sampleType' && kind !== 'lab') continue;
    if (v.length > LIMITS[k]) { errors[k] = t('common.maxChars', { max: LIMITS[k] }); continue; }
    if (!v) {
      if (k === 'name') errors.name = t('catalogue.error.name');
      else if (isEdit && was[k].trim()) errors[k] = t('common.cannotRemove');
      continue;
    }
    full[k] = v;
  }
  const includes = d.includes.split('\n').map((x) => x.trim()).filter(Boolean);
  if (d.kind === 'package' || includes.length || (isEdit && was.includes.trim())) full.includes = includes;

  const price = rupeesToPaise(d.price);
  if (price === null) errors.price = d.price.trim() ? t('catalogue.error.priceFormat') : t('catalogue.error.price');
  else if (price > MAX_PRICE_MINOR) errors.price = t('catalogue.error.priceTooHigh');
  else full.priceMinor = price;
  if (d.mrp.trim()) {
    const mrp = rupeesToPaise(d.mrp);
    if (mrp === null) errors.mrp = t('catalogue.error.mrpFormat');
    else if (mrp > MAX_PRICE_MINOR) errors.mrp = t('catalogue.error.mrpTooHigh');
    else if (price !== null && mrp < price) errors.mrp = t('catalogue.error.mrpBelowPrice');
    else full.mrpMinor = mrp;
  } else if (isEdit && was.mrp) errors.mrp = t('catalogue.error.mrpRemoved');

  const rate = Number(d.gstRate) as GstRate;
  if (!rates.includes(rate) && dirty.has('gstRate')) errors.gstRate = t('catalogue.error.gstRate');
  else full.gstRate = rate;

  if (usesVisitModes(kind)) {
    if (d.visitModes.length === 0) errors.visitModes = t('catalogue.error.visitModes');
    else full.visitModes = MODES.filter((m) => d.visitModes.includes(m));
    const tat = d.tat.trim();
    if (tat) {
      if (!/^\d{1,5}$/.test(tat)) errors.tat = t('catalogue.error.tat');
      else full.reportTatHours = Number(tat);
    } else if (isEdit && was.tat) errors.tat = t('common.cannotRemove');
  }

  // Only the problems of fields this request will send (an untouched field is the server's own value).
  for (const k of Object.keys(errors) as (keyof Draft)[]) if (isEdit && !dirty.has(k)) delete errors[k];
  if (!isEdit) return { body: full as NewCatalogueItem, errors };
  const KEY: Partial<Record<keyof Draft, keyof NewCatalogueItem>> = {
    // i18n-ignore: field names of the request body, not words
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
    errors.price = t('catalogue.error.priceAboveMrp');
  }
  return { body, errors };
}

/** WQ11b: the words after a save that kept someone else's value for fields this person had also changed. */
export const keptMessage = (fields: readonly string[]) => {
  const list = fields.length > 1 ? t('common.listAnd', { rest: fields.slice(0, -1).join(', '), last: fields.at(-1)! }) : fields[0] ?? '';
  return t('catalogue.kept', { count: fields.length, fields: list });
};

/** A new item sent and not yet confirmed (Q10: exactly once per `requestKey`). Session memory + body-less reload marker. */
type PendingItem = PendingOp<NewCatalogueItem & { requestKey: string }>;

/** The search waits this long after the last keystroke before asking the server (Q12 `GET /catalogue?q=`). */
const SEARCH_DELAY_MS = 300;

/** `value`, once it has stopped changing for `ms`. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
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
  // The search text lives in this page's state only (never the URL); the server searches name and code (Q12).
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim().slice(0, MAX_CATALOGUE_SEARCH), SEARCH_DELAY_MS);
  // Q10: catalogue managers also see deactivated items (to reactivate them).
  const items = useCatalogue(ctx, { includeInactive: canManage, q });
  const [kindFilter, setKindFilter] = useState<'' | CatalogueItemKind>('');
  const [status, setStatus] = useState<StatusFilter>('active');
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** WQ11b: a save that kept someone else's value for a field this person had also changed (never "saved" alone). */
  const [warning, setWarning] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  /** WQ11b: one row step (reactivate, enable) at a time on this list, shown busy while it runs. */
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const rowRunning = useRef(false);
  const rowStep = async (id: string, run: () => Promise<void>) => {
    if (rowRunning.current) return;
    rowRunning.current = true;
    setRowBusy(id);
    setNotice(null); setWarning(null); setFailure(null);
    try { await run(); } finally {
      rowRunning.current = false;
      if (mounted.current) setRowBusy(null);
    }
  };
  const isAdmin = ctx.scope.kind === 'admin';
  const p = partner.data;
  const kind = p?.kind ?? 'lab';
  const refresh = () => queryClient.invalidateQueries({ queryKey: [...ctx.key, 'catalogue'] });
  // The item being edited comes from the whole price list, never from the search results: searching for something
  // else while an edit is open must not unmount the form (and lose what was typed). WQ7 review.
  const editingItem = !!editing && editing !== 'new';
  const everything = useCatalogue(ctx, { includeInactive: canManage, enabled: editingItem });
  const target = editingItem ? everything.data?.find((i) => i._id === editing && i.isActive) : undefined;
  const shown = (items.data ?? []).filter((i) => (!kindFilter || i.kind === kindFilter)
    && (status === 'inactive' ? !i.isActive : i.isActive && (status === 'active' || (status === 'disabled') === i.adminDisabled)));
  const searching = q !== search.trim().slice(0, MAX_CATALOGUE_SEARCH) || (items.isFetching && items.isPlaceholderData);

  // ── Exactly-once create (Q10 requestKey) ──
  const slot = `catalogue-create:${scopeIdentity(ctx)}`;
  const [pending, setPendingState] = useState<PendingItem | undefined>(() => memory.get<PendingItem>(slot));
  const [createBusy, setCreateBusy] = useState(false);
  const [createRefused, setCreateRefused] = useState<string | null>(null);
  const [gaveUp, setGaveUp] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const setPending = (op: PendingItem | undefined) => {
    if (op) memory.set(slot, op); else memory.delete(slot);
    setPendingState(op);
  };
  /** An answer for `op` acts only while this page is on screen and the stored item is still exactly `op` (key + attempt). */
  const owns = (op: PendingItem) => mounted.current && stillCurrent(memory.get<PendingItem>(slot), op);
  /**
   * WQ11b: an answer about the key itself (a by-key lookup, a give-up's `used` or `abandoned`) settles what this page
   * shows when the stored item is this key or is gone: after leaving mid-send and coming back, the first page's late
   * answer removes the stored item while this page still shows it, and "Give up" must still act on the server's word.
   */
  const ownsTheKey = (op: PendingItem) => mounted.current && ownsKey(memory.get<PendingItem>(slot), op.requestKey);
  const created = (it: CatalogueItem, op: PendingItem, earlier = false) => {
    void refresh();
    if (earlier ? !ownsTheKey(op) : !owns(op)) return; // a newer attempt owns the state; resending it replays this same item
    const requestKey = op.requestKey;
    resolveStored(memory, slot, requestKey);
    setPendingState((cur) => (cur && cur.requestKey !== requestKey ? cur : undefined));
    setEditing((e) => (e === 'new' ? null : e));
    setNotice(earlier ? t('catalogue.alreadyAdded', { name: it.name }) : t('catalogue.added', { name: it.name }));
  };
  /** Given up on the server (abandon, or a resend refused REQUEST_ABANDONED): ends `op` only while this page owns it. */
  const givenUp = (op: PendingItem, text: string) => {
    if (!ownsTheKey(op)) return;
    const k = op.requestKey;
    resolveStored(memory, slot, k);
    setPendingState((cur) => (cur && cur.requestKey !== k ? cur : undefined));
    setGaveUp(text);
  };
  /** Sends exactly `op` (same key, same content); only success or a definite refusal of its first attempt ends it. */
  async function sendCreate(op: PendingItem) {
    const attempt = beginAttempt(op);
    setCreateBusy(true);
    setCreateRefused(null);
    setGaveUp(null);
    setPending(attempt);
    try {
      created(await ctx.billing.createCatalogueItem(attempt.body), attempt);
    } catch (err) {
      if (!stillCurrent(memory.get<PendingItem>(slot), attempt)) return;
      // Q12: the key was given up (e.g. from another tab after a reload): no item was or can ever be made with it.
      if (wasAbandoned(err)) {
        givenUp(attempt, t('catalogue.givenUpEarlier'));
        return;
      }
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
      <PartnerPageHeading ctx={ctx} title={kind === 'clinic' ? t('catalogue.title.clinic') : t('catalogue.title.lab')} partnerName={p?.name}>
        {t('catalogue.intro')}
      </PartnerPageHeading>
      {notice && <Alert tone="ok">{notice}</Alert>}
      {warning && <Alert tone="warn">{warning}</Alert>}
      {failure && <Alert>{failure}</Alert>}
      {gaveUp && !pending && <Alert tone="ok">{gaveUp}</Alert>}
      {p && !chargesGst(p) && (
        <p className="ws-muted">
          {t(p.taxRegime !== 'unregistered' && !p.gstin ? 'catalogue.noGstNoGstin' : 'catalogue.noGst', { name: p.name, regime: TAX_REGIME_LABEL[p.taxRegime] })}
        </p>
      )}
      {showPending ? (
        <PendingOpPanel key={pending.attempts} label={t('catalogue.unconfirmed')} op={pending} busy={createBusy} onResend={() => void sendCreate(pending)}
          // Q12: exact lookup by key (`GET /catalogue/by-key/:key`); "not found" only means "not added so far".
          fetchPage={keyedLookup(pending.requestKey, () => ctx.billing.catalogueItemByKey(pending.requestKey))}
          onFound={(it) => created(it, pending, true)}
          // Q12: giving up is decided by the server: `abandoned` = this item can never be added; `used` = here it is.
          abandon={async () => {
            const r = await ctx.billing.abandonCatalogueKey(pending.requestKey);
            return { state: r.state, record: r.item ? { ...r.item, requestKey: pending.requestKey } : undefined };
          }}
          abandonWhenNotFound abandonLabel={t('catalogue.giveUp')}
          onDiscard={() => givenUp(pending, t('catalogue.gaveUp'))}
          summary={pending.restored ? null : <div>{t('catalogue.pendingSummary', { name: pending.body.name, price: money(pending.body.priceMinor) })}</div>} />
      ) : canManage && editing === null && (
        <div><Button onClick={() => { setEditing('new'); setNotice(null); setCreateRefused(null); setGaveUp(null); }}>{t('catalogue.addItem')}</Button></div>
      )}
      {!canManage && <p className="ws-muted">{t('catalogue.readOnly')}</p>}
      {p && ((editing === 'new' && !showPending) || target) && (
        <ItemForm key={editing} ctx={ctx} partner={p} item={target} onCancel={() => setEditing(null)}
          createBusy={createBusy} createRefused={createRefused}
          onCreate={(body) => {
            const requestKey = newRequestKey();
            void sendCreate(startOp(requestKey, { ...body, requestKey }));
          }}
          onSaved={async (it, kept) => {
            setEditing(null);
            if (kept.length) { setNotice(null); setWarning(keptMessage(kept)); } else { setWarning(null); setNotice(t('catalogue.saved', { name: it.name })); }
            await refresh();
          }} />
      )}
      <div className="ws-search">
        <div className="j-field ws-filter">
          <label htmlFor="cat-kind">{t('catalogue.type')}</label>
          <select id="cat-kind" value={kindFilter} onChange={(e) => setKindFilter(e.target.value as '' | CatalogueItemKind)}>
            <option value="">{t('catalogue.allTypes')}</option>
            {ITEM_KINDS_FOR[kind].map((k) => <option key={k} value={k}>{itemKindLabel(k)}</option>)}
          </select>
        </div>
        <div className="j-field ws-filter">
          <label htmlFor="cat-status">{t('catalogue.status')}</label>
          <select id="cat-status" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
            <option value="active">{t('catalogue.status.active')}</option>
            <option value="offered">{t('catalogue.status.offered')}</option>
            <option value="disabled">{t('catalogue.status.disabled')}</option>
            {canManage && <option value="inactive">{t('catalogue.status.inactive')}</option>}
          </select>
        </div>
        <TextField label={t('catalogue.search')} type="search" value={search} maxLength={MAX_CATALOGUE_SEARCH}
          onChange={(e) => setSearch(e.target.value)} hint={searching ? t('catalogue.searching') : undefined} />
      </div>
      {items.isPending || partner.isPending ? <Loading label={t('catalogue.loading')} />
        : items.isError ? <ErrorState message={messageOf(items.error)} onRetry={() => void items.refetch()} />
        : partner.isError ? <ErrorState message={messageOf(partner.error)} onRetry={() => void partner.refetch()} />
        : items.data.length === 0 && !q ? <Empty title={t('catalogue.none.title')}>{canManage ? t('catalogue.none.body') : null}</Empty>
        : items.data.length === 0 ? <Empty title={t('catalogue.noMatch.title')}>{t('catalogue.noMatch.search', { q })}</Empty>
        : shown.length === 0 ? <Empty title={t('catalogue.noMatch.title')}>{t('catalogue.noMatch.filters')}</Empty>
        : (
          <div className="ws-table-wrap">
            <table className="j-table">
              <caption className="j-sr-only">{t('catalogue.caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('catalogue.col.name')}</th><th scope="col">{t('catalogue.col.type')}</th>
                  <th scope="col">{t('catalogue.col.price')}</th><th scope="col">{t('catalogue.col.gst')}</th>
                  {kind === 'lab' && <><th scope="col">{t('catalogue.col.where')}</th><th scope="col">{t('catalogue.col.reportIn')}</th></>}
                  <th scope="col">{t('catalogue.col.status')}</th>
                  {(canManage || isAdmin) && <th scope="col">{t('catalogue.col.actions')}</th>}
                </tr>
              </thead>
              <tbody>
                {shown.map((i) => (
                  <tr key={i._id}>
                    <td>{i.name}{i.code ? <span className="ws-muted"> · {i.code}</span> : null}</td>
                    <td>{itemKindLabel(i.kind)}</td>
                    <td>{money(i.priceMinor)}{i.mrpMinor !== undefined && i.mrpMinor !== i.priceMinor ? <span className="ws-muted"> {t('catalogue.mrpOf', { mrp: money(i.mrpMinor) })}</span> : null}</td>
                    <td>{i.gstRate}%{p && i.gstRate > 0 && !chargesGst(p) ? <> <Badge tone="warn">{t('catalogue.cannotBeBilled')}</Badge></> : null}</td>
                    {kind === 'lab' && <>
                      <td>{(i.visitModes ?? []).map(visitModeLabel).join(', ') || '—'}</td>
                      <td>{i.reportTatHours !== undefined ? t('catalogue.hours', { n: i.reportTatHours }) : '—'}</td>
                    </>}
                    <td>
                      {!i.isActive ? <Badge>{t('catalogue.badge.deactivated')}</Badge> : null}{!i.isActive && i.adminDisabled ? ' ' : null}
                      {i.adminDisabled ? <Badge tone="danger">{t('catalogue.badge.disabled')}</Badge> : i.isActive ? <Badge tone="ok">{t('catalogue.badge.offered')}</Badge> : null}
                    </td>
                    {(canManage || isAdmin) && (
                      <td>
                        <div className="ws-actions">
                          {canManage && i.isActive && <Button variant="secondary" aria-label={t('catalogue.editName', { name: i.name })} onClick={() => { setEditing(i._id); setNotice(null); }}>
                              {t('catalogue.edit')}
                            </Button>}
                          {canManage && i.isActive && (
                            <ConfirmAction label={t('catalogue.deactivate')} danger confirmLabel={t('catalogue.deactivateName', { name: i.name })} disabled={rowBusy !== null}
                              consequence={t('catalogue.deactivate.consequence', { name: i.name })}
                              onConfirm={async () => {
                                try { await ctx.billing.deactivateCatalogueItem(i._id); setNotice(t('catalogue.deactivated', { name: i.name })); } finally { await refresh(); }
                              }} />
                          )}
                          {canManage && !i.isActive && (
                            <Button variant="secondary" aria-label={t('catalogue.reactivateName', { name: i.name })} busy={rowBusy === `${i._id}:reactivate`}
                              disabled={rowBusy !== null} onClick={() => void rowStep(`${i._id}:reactivate`, async () => {
                                try { await ctx.billing.reactivateCatalogueItem(i._id); if (mounted.current) setNotice(t('catalogue.reactivated', { name: i.name })); }
                                catch (err) { if (mounted.current) setFailure(t('catalogue.notReactivated', { name: i.name, reason: messageOf(err) })); } finally { await refresh(); }
                              })}>{t('catalogue.reactivate')}</Button>
                          )}
                          {isAdmin && (i.adminDisabled ? (
                            <Button variant="secondary" aria-label={t('catalogue.enableName', { name: i.name })} busy={rowBusy === `${i._id}:enable`}
                              disabled={rowBusy !== null} onClick={() => void rowStep(`${i._id}:enable`, async () => {
                                try { await catalogueAdminApi(api).enable(i._id); if (mounted.current) setNotice(t('catalogue.enabled', { name: i.name })); }
                                catch (err) { if (mounted.current) setFailure(t('catalogue.notEnabled', { name: i.name, reason: messageOf(err) })); } finally { await refresh(); }
                              })}>{t('catalogue.enable')}</Button>
                          ) : (
                            <ConfirmAction label={t('catalogue.disable')} danger confirmLabel={t('catalogue.disableName', { name: i.name })} disabled={rowBusy !== null}
                              consequence={t('catalogue.disable.consequence', { name: i.name })}
                              onConfirm={async () => {
                                try { await catalogueAdminApi(api).disable(i._id); setNotice(t('catalogue.disabled', { name: i.name })); } finally { await refresh(); }
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
  ctx: ScopeContext; partner: Partner; item?: CatalogueItem; onCancel: () => void;
  /** `kept`: fields this person had changed that someone else changed too, so the saved values were kept (WQ11b). */
  onSaved: (i: CatalogueItem, kept: string[]) => Promise<void>;
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
  /**
   * WQ11b: fields this person had changed that a newer server value (a background refresh) also changed: they were reset
   * to the saved value for review. Until the person changes one again, a save of the other fields says it kept them.
   */
  const kept = useRef(new Set<keyof Draft>());
  const setField = <K extends keyof Draft>(k: K, v: Draft[K]) => { kept.current.delete(k); draft.set(k, v); };
  const text = (k: TextKey) => ({ value: d[k], error: errors[k], maxLength: LIMITS[k], onChange: (e: { target: { value: string } }) => setField(k, e.target.value) });

  // Editing: a refreshed item moves untouched fields along; a field changed here AND there is reset for review.
  const serverValue = item ? JSON.stringify(draftOf(item, kind)) : null;
  const serverUpdatedAt = item?.updatedAt;
  useEffect(() => {
    if (!serverValue) return;
    const c = rebaseTo(JSON.parse(serverValue) as Draft);
    baseUpdatedAt.current = serverUpdatedAt;
    for (const k of c) kept.current.add(k);
    if (c.length) setStale(staleMessage(c.map(fieldLabel)));
  }, [serverValue, serverUpdatedAt, rebaseTo]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null); setNotice(null); setStale(null);
    const first = itemBody(draft.current(), allowed, kind, !!item);
    setErrors(first.errors);
    if (Object.keys(first.errors).length) return;
    if (!item) { onCreate(first.body as NewCatalogueItem); return; }
    if (Object.keys(first.body).length === 0) { setNotice(t('common.nothingChanged')); return; }
    setBusy(true);
    try {
      // Checked against what is saved now: nothing someone else changed meanwhile is overwritten unseen.
      const fresh = await ctx.billing.catalogueItem(item._id);
      if (fresh.isActive === false) { setStale(t('catalogue.deactivatedMeanwhile', { name: fresh.name })); return; }
      const conflicts = rebaseTo(draftOf(fresh, kind));
      baseUpdatedAt.current = fresh.updatedAt;
      if (conflicts.length) { setStale(staleMessage(conflicts.map(fieldLabel))); return; }
      const { body, errors: errs } = itemBody(draft.current(), allowed, kind, true);
      setErrors(errs);
      if (Object.keys(errs).length) return;
      if (Object.keys(body).length === 0) { setNotice(t('common.nothingChanged')); return; }
      // Q10: the server refuses (409 CATALOGUE_ITEM_CHANGED) if the item moved after the version this edit is based on.
      const saved = await ctx.billing.updateCatalogueItem(item._id, { ...body, ...(baseUpdatedAt.current ? { expectedUpdatedAt: baseUpdatedAt.current } : {}) });
      await onSaved(saved, [...kept.current].map(fieldLabel));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CATALOGUE_ITEM_CHANGED') {
        // WQ11b: nothing was saved. Read the item as saved now and show it: a field changed here AND there is flagged.
        try {
          const now = await ctx.billing.catalogueItem(item._id);
          const c = rebaseTo(draftOf(now, kind));
          baseUpdatedAt.current = now.updatedAt;
          for (const k of c) kept.current.add(k);
          setStale(c.length ? staleMessage(c.map(fieldLabel)) : t('catalogue.changedWhileSaving'));
        } catch (readErr) {
          setError(t('catalogue.notSavedUnread', { reason: err.message, readError: messageOf(readErr) }));
        }
      } else setError(messageOf(err));
    } finally {
      setBusy(false);
      void queryClient.invalidateQueries({ queryKey: [...ctx.key, 'catalogue'] });
    }
  }

  const kinds = ITEM_KINDS_FOR[kind];
  return (
    <section className="ws-section" aria-labelledby="item-form-h">
      <h2 id="item-form-h">{item ? t('catalogue.editName', { name: item.name }) : t('catalogue.form.add')}</h2>
      <form className="rx-form" noValidate onSubmit={(e) => void submit(e)}>
        {!item && (
          <fieldset className="ws-checks" aria-describedby={errors.kind ? 'item-kind-error' : undefined}>
            <legend>{t('catalogue.type')}</legend>
            {kinds.map((k) => (
              <label key={k} className="ws-check">
                <input type="radio" name="item-kind" checked={d.kind === k} onChange={() => setField('kind', k)} /> {itemKindLabel(k)}
              </label>
            ))}
            {errors.kind && <span id="item-kind-error" className="j-field__error">{errors.kind}</span>}
          </fieldset>
        )}
        <div className="rx-form-row">
          <TextField label={t('catalogue.form.name')} {...text('name')} />
          <TextField label={t('catalogue.form.code')} {...text('code')} />
        </div>
        <div className="rx-form-row">
          <TextField label={t('catalogue.form.price')} inputMode="decimal" value={d.price} error={errors.price} onChange={(e) => setField('price', e.target.value)} />
          <TextField label={t('catalogue.form.mrp')} inputMode="decimal" value={d.mrp} error={errors.mrp} hint={t('catalogue.form.mrpHint')}
            onChange={(e) => setField('mrp', e.target.value)} />
          <div className="j-field">
            <label htmlFor="item-gst">{t('catalogue.form.gstRate')}</label>
            <select id="item-gst" value={d.gstRate} aria-describedby="item-gst-hint" aria-invalid={errors.gstRate ? true : undefined}
              onChange={(e) => setField('gstRate', e.target.value)}>
              {rateOptions.map((r) => <option key={r} value={r}>{allowed.includes(r) ? `${r}%` : t('catalogue.form.rateNotBillable', { rate: r })}</option>)}
            </select>
            <span id="item-gst-hint" className="j-field__hint">
              {chargesGst(partner) ? t('catalogue.form.gstHint') : t('catalogue.form.gstHintNoGst', { name: partner.name })}
            </span>
            {errors.gstRate && <span className="j-field__error">{errors.gstRate}</span>}
          </div>
          <TextField label={t('catalogue.form.sac')} {...text('sac')} />
        </div>
        {usesVisitModes(kind) && (
          <>
            <fieldset className="ws-checks" aria-describedby={errors.visitModes ? 'item-modes-error' : undefined}>
              <legend>{t('catalogue.form.where')}</legend>
              {MODES.map((m) => (
                <label key={m} className="ws-check">
                  <input type="checkbox" checked={d.visitModes.includes(m)}
                    onChange={(e) => { kept.current.delete('visitModes'); draft.update((x) => ({ ...x, visitModes: e.target.checked ? MODES.filter((y) => y === m || x.visitModes.includes(y)) : x.visitModes.filter((y) => y !== m) })); }} />
                  {visitModeLabel(m)}
                </label>
              ))}
              {errors.visitModes && <span id="item-modes-error" className="j-field__error">{errors.visitModes}</span>}
            </fieldset>
            <div className="rx-form-row">
              <TextField label={t('catalogue.form.sampleType')} {...text('sampleType')} />
              <TextField label={t('catalogue.form.tat')} inputMode="numeric" value={d.tat} error={errors.tat}
                onChange={(e) => setField('tat', e.target.value.replace(/\D/g, ''))} />
            </div>
          </>
        )}
        <TextArea label={t('catalogue.form.description')} {...text('description')} />
        <TextArea label={t('catalogue.form.preparation')} hint={t('catalogue.form.preparationHint')} {...text('preparation')} />
        {(d.kind === 'package' || d.includes.trim()) && (
          <TextArea label={t('catalogue.form.includes')} value={d.includes} onChange={(e) => setField('includes', e.target.value)} />
        )}
        {notice && <Alert tone="ok">{notice}</Alert>}
        {stale && <Alert tone="warn">{stale}</Alert>}
        {error && <Alert>{error}</Alert>}
        {!item && createRefused && <Alert>{t('catalogue.form.notAdded', { reason: createRefused })}</Alert>}
        <div className="ws-actions">
          <Button type="submit" busy={busy || (!item && createBusy)}>{item ? t('catalogue.form.save') : t('catalogue.form.addItem')}</Button>
          <Button variant="ghost" disabled={busy || (!item && createBusy)} onClick={onCancel}>{t('common.cancel')}</Button>
        </div>
      </form>
    </section>
  );
}
