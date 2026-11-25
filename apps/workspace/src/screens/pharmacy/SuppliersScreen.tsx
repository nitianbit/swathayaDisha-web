import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  allSuppliers, ApiError, draftOfSupplier, isSupplierConflict, pharmacySuppliersApi, SUPPLIER_FIELD_LABEL, SUPPLIER_FIELDS, SUPPLIER_LIMITS,
  supplierCreateBody, supplierHas, supplierPatchBody, supplierProblems, SUPPLIERS_PAGE_MAX,
  type PharmacySupplier, type SupplierDraft, type SupplierField, type SupplierFields, type SupplierState,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, formatDateTime, Loading, shared, TextArea, TextField } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { newRequestKey, startOp, wasAbandoned, type PendingOp } from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { useOneAtATime } from '../finance/finance.tsx';
import { CheckPanel, useOwnedOp, usePharmacyId } from './ownedOp.tsx';
import { t } from '../../i18n/pharmacy/index.ts';

/**
 * One change to the supplier list, kept in session memory until its answer is known (one at a time). Q15: an add is sent
 * with its request key, so resending it is safe and a lost add is looked up by key (`GET /pharmacy-suppliers/by-key/:key`).
 */
type SupplierChange =
  | { kind: 'create'; fields: SupplierFields }
  | { kind: 'update'; supplierId: string; name: string; fields: Partial<SupplierFields>; expectedRevision: number }
  | { kind: 'archive'; supplierId: string; name: string; expectedRevision: number };

const FILTERS = (): { value: SupplierState | 'all'; label: string }[] => ([
  { value: 'active', label: t('suppliers.active') }, { value: 'archived', label: t('suppliers.archived') }, { value: 'all', label: t('common.all') },
]);

/** WQ10a: the pharmacy's suppliers (`/pharmacy-suppliers`): list, add, edit and archive. */
export function SuppliersScreen() {
  const pharmacyId = usePharmacyId();
  return (
    <>
      <PageHeading title={t('suppliers.suppliers')}>{t('suppliers.theDistributorsYouBuyFrom')}</PageHeading>
      <Suppliers key={pharmacyId} pharmacyId={pharmacyId} />
    </>
  );
}

/** A refusal of the request's content (400/422): the same request is refused the same way every time. */
const isContentRefusal = (err: unknown) => err instanceof ApiError && (err.status === 400 || err.status === 422);

const describeChange = (c: SupplierChange) =>
  c.kind === 'create' ? t('suppliers.add', { displayName: c.fields.displayName }) : c.kind === 'update' ? t('suppliers.saveChangesTo', { name: c.name }) : t('suppliers.archive', { name: c.name });

function Suppliers({ pharmacyId }: { pharmacyId: string }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const suppliers = pharmacySuppliersApi(api);
  const [state, setState] = useState<SupplierState | 'all'>('active');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<'new' | PharmacySupplier | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);
  const [givingUp, setGivingUp] = useState(false);
  const { op, send, settle } = useOwnedOp<SupplierChange>(`supplier-change:${pharmacyId}`);
  const { perform, busy } = useOneAtATime('supplier list');
  const q = useQuery({
    queryKey: ['pharmacy-suppliers', pharmacyId, 'list', state, page],
    queryFn: () => suppliers.list({ state, page, limit: SUPPLIERS_PAGE_MAX }),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['pharmacy-suppliers'] });
  const locked = !!op;

  /** Sends one change. Resolves with the saved supplier, or throws what to show; an unknown outcome leaves `op` stored. */
  async function apply(p: PendingOp<SupplierChange>): Promise<PharmacySupplier | null> {
    return perform(async () => {
      const r = await send(p, async (c): Promise<PharmacySupplier> => (c.kind === 'create' ? (await suppliers.create(c.fields, p.requestKey)).supplier
        : c.kind === 'update' ? suppliers.update(c.supplierId, c.fields, c.expectedRevision)
        : suppliers.archive(c.supplierId, c.expectedRevision)));
      if (r.kind === 'ok') { void refresh(); return r.value; }
      if (r.kind === 'refused') { void refresh(); throw r.error; }
      if (r.kind === 'unknown' && isSupplierConflict(r.error)) { await check(p); return null; } // a resend met its own (or someone's) change
      if (r.kind === 'unknown' && (wasAbandoned(r.error) || isContentRefusal(r.error))) {
        // The server refused this very request for its content (400/422: same key, same content, same revision, so an
        // earlier copy was refused the same way), or its key was given up (it can never be recorded). Anything else on a
        // resend (401, 403, 404, 409 …) says nothing about the earlier copy: it stays unconfirmed.
        settle(p.requestKey);
        void refresh();
        const what = p.body?.kind === 'create' ? t('suppliers.notAdded') : t('suppliers.notSaved');
        throw new ApiError(400, wasAbandoned(r.error)
          ? t('suppliers.thisAddWasGivenUp')
          : `${what}: ${messageOf(r.error)}`, 'SETTLED_NOT_RECORDED');
      }
      return null;
    });
  }

  /**
   * Q15: gives an unconfirmed add up on the server (`by-key/:key/abandon`): 'abandoned' = that key can never add a
   * supplier now; 'used' = it added this one. A body-less marker after a reload may also have been an edit or archive:
   * then giving it up only frees the list, and the list shows what is saved.
   */
  async function giveUp(p: PendingOp<SupplierChange>) {
    setResendError(null);
    setGivingUp(true);
    try {
      const r = await perform(() => suppliers.abandonCreate(p.requestKey));
      settle(p.requestKey);
      void refresh();
      if (r.state === 'used') { setNotice(r.supplier ? t('suppliers.wasAddedNothingWasAdded', { displayName: r.supplier.displayName }) : t('suppliers.itWasAddedSeeThe')); return; }
      setNotice(p.body
        ? t('suppliers.givenUpNothingWasAdded')
        : t('suppliers.givenUpIfItWas'));
    } catch (err) {
      setResendError(messageOf(err));
    } finally {
      setGivingUp(false);
    }
  }

  /** Settles the stored change from the list as the server has it now; answers what is still unknown. */
  async function check(p: PendingOp<SupplierChange>): Promise<string | null> {
    const c = p.body;
    if (!c || c.kind === 'create') {
      // Q15: an add is found by its key. A restored marker without details may also be an edit or archive: then the key
      // finds nothing, and the list (read below for those) is the check.
      const hit = await suppliers.createdByKey(p.requestKey);
      void refresh();
      if (hit) { settle(p.requestKey); setNotice(t('suppliers.wasAddedNothingWasAdded', { displayName: hit.displayName })); return null; }
      return c
        ? t('suppliers.notAddedSoFarIt')
        : t('suppliers.nothingWasAddedWithIt');
    }
    const all = await allSuppliers(api, 'all');
    void refresh();
    const now = all.find((s) => s.supplierId === c.supplierId);
    if (!now) { settle(p.requestKey); setNotice(t('suppliers.isNoLongerInYour', { name: c.name })); return null; }
    if (now.revision === c.expectedRevision && now.state === 'active') {
      return t('suppliers.notSavedYetItMay');
    }
    settle(p.requestKey);
    if (c.kind === 'archive') {
      setNotice(now.state === 'archived' ? t('suppliers.isArchived', { displayName: now.displayName }) : t('suppliers.wasChangedBySomeoneElse', { displayName: now.displayName }));
    } else {
      setNotice(now.state === 'active' && supplierHas(now, c.fields) ? t('suppliers.wasSaved', { displayName: now.displayName })
        : t('suppliers.wasChangedBySomeoneElse2', { displayName: now.displayName }));
    }
    return null;
  }

  return (
    <>
      {notice && <Alert tone="ok">{notice}</Alert>}
      {resendError && <Alert>{resendError}</Alert>}
      {op && !(busy && !givingUp && op.attempts === 1 && !op.uncertain) && (
        <CheckPanel label={t('suppliers.unconfirmedSupplierChange')} onCheck={() => check(op)}
          resend={op.body && !op.restored
            ? { label: t('suppliers.sendTheSameChangeAgain'), busy: busy && !givingUp, onClick: () => {
              setResendError(null);
              const kind = op.body!.kind;
              void apply(op).then((saved) => {
                if (saved) setNotice(kind === 'create' ? t('suppliers.wasAdded', { displayName: saved.displayName }) : kind === 'update' ? t('suppliers.wasSaved', { displayName: saved.displayName }) : t('suppliers.isArchived', { displayName: saved.displayName }));
              }).catch((err) => setResendError(messageOf(err)));
            } }
            : undefined}
          giveUp={!op.body || op.body.kind === 'create' ? { label: t('common.giveThisUp'), busy: givingUp, onClick: () => void giveUp(op) } : undefined}
          forget={op.body && op.body.kind !== 'create' ? {
            label: t('common.forgetIt'), confirmLabel: t('common.forgetIt'),
            consequence: t('suppliers.ifTheEarlierStillArrives', { value: op.body.kind === 'archive' ? 'archive' : 'change', name: op.body.name }),
            onForget: () => { settle(op.requestKey); setResendError(null); },
          } : undefined}>
          <Alert tone="warn">
            {op.restored || !op.body
              ? t('suppliers.aSupplierChangeMadeEarlier')
              : t('suppliers.notConfirmedItMayAlready', { value: describeChange(op.body), value2: op.error ? ` (${op.error})` : '' })}
            {' '}{t('suppliers.otherSupplierChangesWaitUntil')}</Alert>
        </CheckPanel>
      )}

      {editing === null && (
        <div><Button disabled={locked} onClick={() => { setEditing('new'); setNotice(null); setResendError(null); }}>{t('common.addASupplier')}</Button></div>
      )}
      {editing !== null && (
        <SupplierForm key={editing === 'new' ? 'new' : editing.supplierId} base={editing === 'new' ? undefined : editing} busy={busy} locked={locked}
          onCancel={() => setEditing(null)}
          onSave={async (draft, base) => {
            setResendError(null);
            const p = base
              ? startOp<SupplierChange>(newRequestKey(), { kind: 'update', supplierId: base.supplierId, name: base.displayName, fields: supplierPatchBody(draft, base), expectedRevision: base.revision })
              : startOp<SupplierChange>(newRequestKey(), { kind: 'create', fields: supplierCreateBody(draft) });
            const saved = await apply(p);
            setEditing(null); // saved, or an unknown outcome the panel above takes over
            if (saved) setNotice(base ? t('suppliers.wasSaved', { displayName: saved.displayName }) : t('suppliers.wasAdded', { displayName: saved.displayName }));
          }}
          reread={async (id) => (await allSuppliers(api, 'all')).find((s) => s.supplierId === id)} />
      )}

      <section className="ws-section" aria-labelledby="sup-list-h">
        <h2 id="sup-list-h">{t('suppliers.yourSuppliers')}</h2>
        <div className="j-field ws-filter">
          <label htmlFor="sup-state">{t('suppliers.show')}</label>
          <select id="sup-state" value={state} onChange={(e) => { setState(e.target.value as SupplierState | 'all'); setPage(1); }}>
            {FILTERS().map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </div>
        {q.isPending ? <Loading label={t('common.loadingSuppliers')} />
          : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
          : q.data.items.length === 0 ? (
            <Empty title={state === 'archived' ? t('suppliers.noArchivedSuppliers') : t('suppliers.noSuppliersYet')}>
              {state === 'archived' ? null : t('suppliers.addTheDistributorsYouBuy')}
            </Empty>
          ) : (
            <>
              <div className="ws-table-wrap">
                <table className="j-table">
                  <caption className="j-sr-only">{t('suppliers.suppliers')}</caption>
                  <thead>
                    <tr><th scope={'col'}>{t('common.supplier')}</th><th scope={'col'}>{t('suppliers.contactPerson')}</th><th scope={'col'}>{t('suppliers.phone')}</th><th scope={'col'}>{t('suppliers.email')}</th><th scope={'col'}>{t('common.address')}</th><th scope={'col'}>{t('common.actions')}</th></tr>
                  </thead>
                  <tbody>
                    {q.data.items.map((s) => (
                      <tr key={s.supplierId}>
                        <td>{s.displayName}{s.state === 'archived' && <> <Badge>{t('suppliers.archivedFull', { time: formatDateTime(s.archivedAt) })}</Badge></>}</td>
                        <td>{s.contactName ?? '—'}</td>
                        <td>{s.phone ?? '—'}</td>
                        <td>{s.email ?? '—'}</td>
                        <td>{s.address ?? '—'}</td>
                        <td>
                          {s.state === 'active' ? (
                            <div className="ws-actions">
                              <Button variant="secondary" aria-label={t('suppliers.edit', { displayName: s.displayName })} disabled={locked || editing !== null}
                                onClick={() => { setEditing(s); setNotice(null); }}>{t('suppliers.edit2')}</Button>
                              <ConfirmAction label={t('suppliers.archive2', { displayName: s.displayName })} danger confirmLabel={t('suppliers.yesArchive')} disabled={locked || busy}
                                consequence={t('suppliers.isNoLongerOfferedFor', { displayName: s.displayName })}
                                onConfirm={async () => {
                                  const p = startOp<SupplierChange>(newRequestKey(), { kind: 'archive', supplierId: s.supplierId, name: s.displayName, expectedRevision: s.revision });
                                  try {
                                    const saved = await apply(p);
                                    if (saved) setNotice(t('suppliers.isArchived', { displayName: saved.displayName }));
                                  } catch (err) {
                                    if (isSupplierConflict(err)) throw new ApiError(409, t('suppliers.wasChangedMeanwhileCheckIt', { displayName: s.displayName }), 'SUPPLIER_CONFLICT');
                                    throw err;
                                  }
                                }} />
                            </div>
                          ) : <span className="ws-muted">{t('suppliers.archived')}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {q.data.totalPages > 1 && (
                <nav className="ws-pager" aria-label={t('common.pages')}>
                  <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>{t('common.previous')}</Button>
                  <span>{t('common.pageFull', { page, totalPages: q.data.totalPages })}</span>
                  <Button variant="secondary" disabled={page >= q.data.totalPages} onClick={() => setPage(page + 1)}>{t('common.next')}</Button>
                </nav>
              )}
            </>
          )}
      </section>
    </>
  );
}

function SupplierForm({ base: opened, busy, locked, onCancel, onSave, reread }: {
  base?: PharmacySupplier; busy: boolean; locked: boolean; onCancel: () => void;
  onSave: (draft: SupplierDraft, base?: PharmacySupplier) => Promise<void>;
  reread: (id: string) => Promise<PharmacySupplier | undefined>;
}) {
  // The version this edit names (`expectedRevision`); replaced only after the person has seen a newer one.
  const [base, setBase] = useState(opened);
  const [draft, setDraft] = useState<SupplierDraft>(() => draftOfSupplier(opened));
  const [errors, setErrors] = useState<Partial<Record<SupplierField, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState<string | null>(null);
  const [nothing, setNothing] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null); setStale(null); setNothing(false);
    const problems = supplierProblems(draft);
    setErrors(problems);
    if (Object.keys(problems).length) return;
    if (base && Object.keys(supplierPatchBody(draft, base)).length === 0) { setNothing(true); return; }
    try {
      await onSave(draft, base);
    } catch (err) {
      if (base && isSupplierConflict(err)) {
        const fresh = await reread(base.supplierId).catch(() => undefined);
        if (!fresh || fresh.state === 'archived') { setStale(t('suppliers.wasArchivedMeanwhileSoIt', { displayName: base.displayName })); return; }
        // Fields changed there but not here take the saved value; a field changed in both keeps what was typed here.
        const before = draftOfSupplier(base);
        const saved = draftOfSupplier(fresh);
        const theirs = SUPPLIER_FIELDS.filter((f) => saved[f] !== before[f]);
        const both = theirs.filter((f) => draft[f] !== before[f] && draft[f].trim() !== saved[f]);
        setDraft((d) => ({ ...d, ...Object.fromEntries(theirs.filter((f) => !both.includes(f)).map((f) => [f, saved[f]])) }));
        setBase(fresh);
        setStale(both.length
          ? t('suppliers.someoneChangedThisSupplierMeanwhile', { value: both.map((f) => `${SUPPLIER_FIELD_LABEL[f]}: now “${saved[f]}”`).join('; ') })
          : t('suppliers.someoneChangedThisSupplierMeanwhile2'));
        return;
      }
      setError(messageOf(err));
    }
  }

  const field = (f: SupplierField, extra: { hint?: string; inputMode?: 'tel' | 'email'; type?: string } = {}) => (
    <TextField label={f === 'displayName' ? SUPPLIER_FIELD_LABEL[f] : `${SUPPLIER_FIELD_LABEL[f]} (optional)`} value={draft[f]}
      maxLength={SUPPLIER_LIMITS[f]} error={errors[f]} {...extra}
      onChange={(e) => setDraft((d) => ({ ...d, [f]: e.target.value }))} />
  );

  return (
    <section className="ws-section" aria-labelledby="sup-form-h">
      <h2 id="sup-form-h">{opened ? t('suppliers.edit', { displayName: opened.displayName }) : t('common.addASupplier')}</h2>
      <form className="rx-form" noValidate onSubmit={(e) => void submit(e)}>
        <fieldset className="ws-frozen" disabled={busy || locked}>
          <div className="rx-form-row">
            {field('displayName')}
            {field('contactName')}
          </div>
          <div className="rx-form-row">
            {field('phone', { inputMode: 'tel' })}
            {field('email', { inputMode: 'email', type: 'email' })}
          </div>
          <TextArea label={t('suppliers.addressOptional')} value={draft.address} maxLength={SUPPLIER_LIMITS.address} error={errors.address}
            onChange={(e) => setDraft((d) => ({ ...d, address: e.target.value }))} />
        </fieldset>
        {stale && <Alert tone="warn">{stale}</Alert>}
        {nothing && <Alert tone="warn">{t('suppliers.nothingHasChanged')}</Alert>}
        {error && <Alert>{opened ? t('suppliers.notSaved') : t('suppliers.notAdded')}: {error}</Alert>}
        <div className="confirm-actions">
          <Button type="submit" busy={busy} disabled={locked}>{opened ? t('suppliers.saveChanges') : t('suppliers.addSupplier')}</Button>
          <Button variant="ghost" disabled={busy} onClick={onCancel}>{shared('action.back')}</Button>
        </div>
      </form>
    </section>
  );
}
