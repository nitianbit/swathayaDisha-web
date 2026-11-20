import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  allSuppliers, ApiError, draftOfSupplier, isSupplierConflict, pharmacySuppliersApi, SUPPLIER_FIELD_LABEL, SUPPLIER_FIELDS, SUPPLIER_LIMITS,
  supplierCreateBody, supplierHas, supplierPatchBody, supplierProblems, SUPPLIERS_PAGE_MAX,
  type PharmacySupplier, type SupplierDraft, type SupplierField, type SupplierFields, type SupplierState,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, formatDateTime, Loading, TextArea, TextField } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { newRequestKey, startOp, type PendingOp } from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { useOneAtATime } from '../finance/finance.tsx';
import { CheckPanel, useOwnedOp, usePharmacyId } from './ownedOp.tsx';

/** One change to the supplier list, kept in session memory until its answer is known (one at a time). */
type SupplierChange =
  | { kind: 'create'; fields: SupplierFields }
  | { kind: 'update'; supplierId: string; name: string; fields: Partial<SupplierFields>; expectedRevision: number }
  | { kind: 'archive'; supplierId: string; name: string; expectedRevision: number };

const FILTERS: { value: SupplierState | 'all'; label: string }[] = [
  { value: 'active', label: 'Active' }, { value: 'archived', label: 'Archived' }, { value: 'all', label: 'All' },
];

/** WQ10a: the pharmacy's suppliers (`/pharmacy-suppliers`): list, add, edit and archive. */
export function SuppliersScreen() {
  const pharmacyId = usePharmacyId();
  return (
    <>
      <PageHeading title="Suppliers">The distributors you buy from. Stock is returned to one of your active suppliers.</PageHeading>
      <Suppliers key={pharmacyId} pharmacyId={pharmacyId} />
    </>
  );
}

const describeChange = (c: SupplierChange) =>
  c.kind === 'create' ? `Add ${c.fields.displayName}` : c.kind === 'update' ? `Save changes to ${c.name}` : `Archive ${c.name}`;

function Suppliers({ pharmacyId }: { pharmacyId: string }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const suppliers = pharmacySuppliersApi(api);
  const [state, setState] = useState<SupplierState | 'all'>('active');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<'new' | PharmacySupplier | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);
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
      const r = await send(p, (c) => (c.kind === 'create' ? suppliers.create(c.fields)
        : c.kind === 'update' ? suppliers.update(c.supplierId, c.fields, c.expectedRevision)
        : suppliers.archive(c.supplierId, c.expectedRevision)));
      if (r.kind === 'ok') { void refresh(); return r.value; }
      if (r.kind === 'refused') { void refresh(); throw r.error; }
      if (r.kind === 'unknown' && isSupplierConflict(r.error)) await check(p); // a resend met its own (or someone's) change
      return null;
    });
  }

  /** Settles the stored change from the list as the server has it now; answers what is still unknown. */
  async function check(p: PendingOp<SupplierChange>): Promise<string | null> {
    const all = await allSuppliers(api, 'all');
    void refresh();
    const c = p.body;
    const since = p.firstAttemptAt - 5 * 60_000;
    if (!c || c.kind === 'create') {
      const added = all.filter((s) => Date.parse(s.createdAt) >= since);
      const hit = c ? added.find((s) => s.displayName.toLowerCase() === c.fields.displayName.toLowerCase()) : undefined;
      if (hit) { settle(p.requestKey); setNotice(`${hit.displayName} was added.`); return null; }
      if (!c && added.length) return `Added since then: ${added.map((s) => s.displayName).join(', ')}. If one of them is it, forget this one.`;
      return 'It is not in the list. It may still be on its way, or it never arrived: this cannot be told apart from here.';
    }
    const now = all.find((s) => s.supplierId === c.supplierId);
    if (!now) { settle(p.requestKey); setNotice(`${c.name} is no longer in your list.`); return null; }
    if (now.revision === c.expectedRevision && now.state === 'active') {
      return 'Not saved yet. It may still be on its way. Sending it again is safe: it can only be saved once.';
    }
    settle(p.requestKey);
    if (c.kind === 'archive') {
      setNotice(now.state === 'archived' ? `${now.displayName} is archived.` : `${now.displayName} was changed by someone else meanwhile and is not archived. Check it and archive it again.`);
    } else {
      setNotice(now.state === 'active' && supplierHas(now, c.fields) ? `${now.displayName} was saved.`
        : `${now.displayName} was changed by someone else meanwhile. Check its details and edit it again.`);
    }
    return null;
  }

  return (
    <>
      {notice && <Alert tone="ok">{notice}</Alert>}
      {op && resendError && <Alert>{resendError}</Alert>}
      {op && !busy && (
        <CheckPanel label="Unconfirmed supplier change" onCheck={() => check(op)}
          resend={op.body && op.body.kind !== 'create' && !op.restored
            ? { label: 'Send the same change again', busy, onClick: () => { setResendError(null); void apply(op).catch((err) => setResendError(messageOf(err))); } }
            : undefined}
          forget={!op.body || op.body.kind === 'create' ? {
            label: 'Forget it', confirmLabel: 'Forget it',
            consequence: 'If the supplier was added after all, it will be listed twice. Archive the extra one.',
            onForget: () => settle(op.requestKey),
          } : undefined}>
          <Alert tone="warn">
            {op.restored || !op.body
              ? 'A supplier change made earlier on this device (before the page was reloaded, or before you signed out) was not confirmed. Its details are not kept here.'
              : `${describeChange(op.body)}: the answer did not arrive${op.error ? ` (${op.error})` : ''}. It may already be saved.`}
            {' '}Other supplier changes wait until this one is checked.
          </Alert>
        </CheckPanel>
      )}

      {editing === null && (
        <div><Button disabled={locked} onClick={() => { setEditing('new'); setNotice(null); }}>Add a supplier</Button></div>
      )}
      {editing !== null && (
        <SupplierForm key={editing === 'new' ? 'new' : editing.supplierId} base={editing === 'new' ? undefined : editing} busy={busy} locked={locked}
          onCancel={() => setEditing(null)}
          onSave={async (draft, base) => {
            const p = base
              ? startOp<SupplierChange>(newRequestKey(), { kind: 'update', supplierId: base.supplierId, name: base.displayName, fields: supplierPatchBody(draft, base), expectedRevision: base.revision })
              : startOp<SupplierChange>(newRequestKey(), { kind: 'create', fields: supplierCreateBody(draft) });
            const saved = await apply(p);
            setEditing(null); // saved, or an unknown outcome the panel above takes over
            if (saved) setNotice(base ? `${saved.displayName} was saved.` : `${saved.displayName} was added.`);
          }}
          reread={async (id) => (await allSuppliers(api, 'all')).find((s) => s.supplierId === id)} />
      )}

      <section className="ws-section" aria-labelledby="sup-list-h">
        <h2 id="sup-list-h">Your suppliers</h2>
        <div className="j-field ws-filter">
          <label htmlFor="sup-state">Show</label>
          <select id="sup-state" value={state} onChange={(e) => { setState(e.target.value as SupplierState | 'all'); setPage(1); }}>
            {FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </div>
        {q.isPending ? <Loading label="Loading suppliers…" />
          : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
          : q.data.items.length === 0 ? (
            <Empty title={state === 'archived' ? 'No archived suppliers' : 'No suppliers yet'}>
              {state === 'archived' ? null : 'Add the distributors you buy from, so stock can be returned to them.'}
            </Empty>
          ) : (
            <>
              <div className="ws-table-wrap">
                <table className="j-table">
                  <caption className="j-sr-only">Suppliers</caption>
                  <thead>
                    <tr><th scope="col">Supplier</th><th scope="col">Contact person</th><th scope="col">Phone</th><th scope="col">Email</th><th scope="col">Address</th><th scope="col">Actions</th></tr>
                  </thead>
                  <tbody>
                    {q.data.items.map((s) => (
                      <tr key={s.supplierId}>
                        <td>{s.displayName}{s.state === 'archived' && <> <Badge>Archived {formatDateTime(s.archivedAt)}</Badge></>}</td>
                        <td>{s.contactName ?? '—'}</td>
                        <td>{s.phone ?? '—'}</td>
                        <td>{s.email ?? '—'}</td>
                        <td>{s.address ?? '—'}</td>
                        <td>
                          {s.state === 'active' ? (
                            <div className="ws-actions">
                              <Button variant="secondary" aria-label={`Edit ${s.displayName}`} disabled={locked || editing !== null}
                                onClick={() => { setEditing(s); setNotice(null); }}>Edit</Button>
                              <ConfirmAction label={`Archive ${s.displayName}`} danger confirmLabel="Yes, archive" disabled={locked || busy}
                                consequence={`${s.displayName} is no longer offered for returns. Returns already recorded keep it. An archived supplier cannot be brought back here; add it again if you need it.`}
                                onConfirm={async () => {
                                  const p = startOp<SupplierChange>(newRequestKey(), { kind: 'archive', supplierId: s.supplierId, name: s.displayName, expectedRevision: s.revision });
                                  try {
                                    const saved = await apply(p);
                                    if (saved) setNotice(`${saved.displayName} is archived.`);
                                  } catch (err) {
                                    if (isSupplierConflict(err)) throw new ApiError(409, `${s.displayName} was changed meanwhile. Check it and archive it again.`, 'SUPPLIER_CONFLICT');
                                    throw err;
                                  }
                                }} />
                            </div>
                          ) : <span className="ws-muted">Archived</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {q.data.totalPages > 1 && (
                <nav className="ws-pager" aria-label="Pages">
                  <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
                  <span>Page {page} of {q.data.totalPages}</span>
                  <Button variant="secondary" disabled={page >= q.data.totalPages} onClick={() => setPage(page + 1)}>Next</Button>
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
        if (!fresh || fresh.state === 'archived') { setStale(`${base.displayName} was archived meanwhile, so it cannot be edited.`); return; }
        // Fields changed there but not here take the saved value; a field changed in both keeps what was typed here.
        const before = draftOfSupplier(base);
        const saved = draftOfSupplier(fresh);
        const theirs = SUPPLIER_FIELDS.filter((f) => saved[f] !== before[f]);
        const both = theirs.filter((f) => draft[f] !== before[f] && draft[f].trim() !== saved[f]);
        setDraft((d) => ({ ...d, ...Object.fromEntries(theirs.filter((f) => !both.includes(f)).map((f) => [f, saved[f]])) }));
        setBase(fresh);
        setStale(both.length
          ? `Someone changed this supplier meanwhile (${both.map((f) => `${SUPPLIER_FIELD_LABEL[f]}: now “${saved[f]}”`).join('; ')}). Your value is kept below; save again to replace theirs.`
          : 'Someone changed this supplier meanwhile; their changes are shown below. Check them and save again.');
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
      <h2 id="sup-form-h">{opened ? `Edit ${opened.displayName}` : 'Add a supplier'}</h2>
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
          <TextArea label="Address (optional)" value={draft.address} maxLength={SUPPLIER_LIMITS.address} error={errors.address}
            onChange={(e) => setDraft((d) => ({ ...d, address: e.target.value }))} />
        </fieldset>
        {stale && <Alert tone="warn">{stale}</Alert>}
        {nothing && <Alert tone="warn">Nothing has changed.</Alert>}
        {error && <Alert>{opened ? 'Not saved' : 'Not added'}: {error}</Alert>}
        <div className="confirm-actions">
          <Button type="submit" busy={busy} disabled={locked}>{opened ? 'Save changes' : 'Add supplier'}</Button>
          <Button variant="ghost" disabled={busy} onClick={onCancel}>Back</Button>
        </div>
      </form>
    </section>
  );
}
