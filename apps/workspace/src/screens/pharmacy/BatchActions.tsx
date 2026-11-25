import { useState, type FormEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  BATCH_ACTION_FROM, inventoryApi, orderStatusLabel, type Batch, type RecallTrace, type SupplierReturn, type SupplierReturnReason,
  type SupplierReturnRequest, requestKeysApi } from '@jansetu/api';
import { Alert, Button, formatDateTime, Loading, shared, TextArea, TextField , Parts } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { messageOf } from '../../errors.ts';
import { PendingOpPanel } from '../../components/PendingOpPanel.tsx';
import { afterFailure, beginAttempt, newRequestKey, resolveStored, startOp, stillCurrent, type PendingOp } from '../../requests.ts';
import { useSession, useStaff } from '../../session.tsx';
import { SupplierSelect, useActiveSuppliers } from './SupplierPicker.tsx';
import { t } from '../../i18n/pharmacy/index.ts';

type Panel = null | 'release' | 'supplier' | 'recall' | 'trace';

const RETURN_REASONS = (): { value: SupplierReturnReason; label: string }[] => ([
  { value: 'expired', label: t('batchActions.expired') },
  { value: 'near_expiry', label: t('batchActions.nearExpiry') },
  { value: 'damaged', label: t('batchActions.damaged') },
  { value: 'recalled', label: t('batchActions.recalled') },
  { value: 'other', label: t('batchActions.other') },
]);

/** Quality actions for one batch, offered only in the states the backend accepts (batchQuality.ts). */
export function BatchActions({ itemId, batch, onChanged }: { itemId: string; batch: Batch; onChanged: () => Promise<unknown> }) {
  const { api, memory } = useSession();
  const inv = inventoryApi(api);
  // An unconfirmed supplier return reopens its (locked) form, wherever staff left it.
  const [panel, setPanel] = useState<Panel>(() => (memory.get(supplierPendingKey(batch._id)) ? 'supplier' : null));
  const [notice, setNotice] = useState<string | null>(null);
  const can = (a: keyof typeof BATCH_ACTION_FROM) => (BATCH_ACTION_FROM[a] as readonly string[]).includes(batch.status);
  const done = async () => { setPanel(null); await onChanged(); };

  return (
    <div className="batch-actions">
      <div className="ws-actions">
        {can('quarantine') && (
          <ConfirmAction label={t('batchActions.quarantine')} confirmLabel={t('batchActions.quarantineBatch')} danger reason reasonLabel={t('batchActions.whyIsItHeld')}
            consequence={t('batchActions.batchCanNoLongerBe', { batchNumber: batch.batchNumber })}
            onConfirm={async (reason) => { await inv.quarantine(itemId, batch._id, reason); await onChanged(); }} />
        )}
        {can('release') && <Button variant="secondary" onClick={() => setPanel(panel === 'release' ? null : 'release')}>{t('batchActions.release')}</Button>}
        {can('supplierReturn') && batch.availableQty > 0 && panel !== 'supplier' && (
          <Button variant="secondary" onClick={() => { setNotice(null); setPanel('supplier'); }}>{t('batchActions.returnToSupplier')}</Button>
        )}
        {can('recall') && <Button variant="secondary" onClick={() => setPanel(panel === 'recall' ? null : 'recall')}>{t('batchActions.recall')}</Button>}
        {batch.status === 'recalled' && (
          <Button variant="secondary" onClick={() => setPanel(panel === 'trace' ? null : 'trace')}>{t('batchActions.recallTrace')}</Button>
        )}
      </div>
      {panel === 'release' && <ReleaseForm itemId={itemId} batch={batch} onDone={done} onCancel={() => setPanel(null)} />}
      {notice && <Alert tone="ok">{notice}</Alert>}
      {panel === 'supplier' && (
        <SupplierReturnForm itemId={itemId} batch={batch} onCancel={() => setPanel(null)}
          onDone={async (r) => {
            setNotice(t('batchActions.unitsOfBatchReturned', { value: r.duplicate ? t('batchActions.alreadyRecorded') : 'Recorded', quantity: r.quantity, batchNumber: r.batchNumber, value2: r.reason.replace(/_/g, ' ') }));
            await done();
          }} />
      )}
      {panel === 'recall' && <RecallForm itemId={itemId} batch={batch} onDone={onChanged} onCancel={() => setPanel(null)} />}
      {panel === 'trace' && <TraceLoader itemId={itemId} batchId={batch._id} />}
    </div>
  );
}

function FormShell({ name, title, children, onSubmit, busy, error, submitLabel, danger, onCancel }: {
  /** Short accessible name of the form; `title` is the explanation shown above the fields. */
  name: string; title: string; children: ReactNode; onSubmit: () => void; busy: boolean; error: string | null; submitLabel: string;
  danger?: boolean; onCancel: () => void;
}) {
  return (
    <form className="confirm" noValidate aria-label={name} onSubmit={(e: FormEvent) => { e.preventDefault(); onSubmit(); }}>
      <div className="confirm-text">{title}</div>
      {children}
      {error && <Alert>{error}</Alert>}
      <div className="confirm-actions">
        <Button type="submit" variant={danger ? 'danger' : 'primary'} busy={busy}>{submitLabel}</Button>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>{shared('action.back')}</Button>
      </div>
    </form>
  );
}

function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  };
  return { busy, error, run };
}

const wholeNumber = (text: string) => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : NaN);

function ReleaseForm({ itemId, batch, onDone, onCancel }: { itemId: string; batch: Batch; onDone: () => Promise<unknown>; onCancel: () => void }) {
  const { api } = useSession();
  const [writeOff, setWriteOff] = useState('0');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { busy, error, run } = useSubmit();
  return (
    <FormShell name={t('batchActions.releaseBatch', { batchNumber: batch.batchNumber })} title={t('batchActions.releaseBatchBackToSale', { batchNumber: batch.batchNumber })}
      submitLabel={t('batchActions.releaseBatch2')} busy={busy} error={error} onCancel={onCancel}
      onSubmit={() => {
        const n = wholeNumber(writeOff);
        const e: Record<string, string> = {};
        if (!Number.isInteger(n) || n < 0 || n > batch.availableQty) e.writeOff = t('batchActions.enterAWholeNumberFrom', { availableQty: batch.availableQty });
        if (reason.trim().length < 3) e.reason = t('common.giveAReasonAtLeast');
        setErrors(e);
        if (Object.keys(e).length === 0) void run(async () => { await inventoryApi(api).release(itemId, batch._id, { writeOffQty: n, reason: reason.trim() }); await onDone(); });
      }}>
      <TextField label={t('batchActions.unitsToWriteOff')} inputMode="numeric" value={writeOff} error={errors.writeOff}
        hint={t('batchActions.unreservedUnitsInThisBatch', { availableQty: batch.availableQty })} onChange={(e) => setWriteOff(e.target.value.replace(/\D/g, ''))} />
      <TextArea label={t('common.reason')} value={reason} maxLength={500} error={errors.reason} onChange={(e) => setReason(e.target.value)} />
    </FormShell>
  );
}

const supplierPendingKey = (batchId: string) => `supplier-return:${batchId}`;
type PendingSupplierReturn = PendingOp<SupplierReturnRequest> & { supplierName: string };

/**
 * A supplier return removes stock, so it must happen once. Each submission carries a request key; while its outcome
 * is unknown the form is locked to "send the same return again" (same key, same details), which the backend answers
 * with the first record. The unconfirmed return is kept in session memory, so it survives leaving the page.
 */
function SupplierReturnForm({ itemId, batch, onDone, onCancel }: {
  itemId: string; batch: Batch; onDone: (r: SupplierReturn & { duplicate?: boolean }) => Promise<unknown>; onCancel: () => void;
}) {
  const { api, memory } = useSession();
  const key = supplierPendingKey(batch._id);
  const pharmacyId = useStaff().id;
  // WQ11c: every active supplier (all pages), with a name filter when the list is long.
  const suppliers = useActiveSuppliers(pharmacyId);
  const [pending, setPendingState] = useState<PendingSupplierReturn | undefined>(() => memory.get<PendingSupplierReturn>(key));
  const [supplierId, setSupplierId] = useState('');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState<SupplierReturnReason>(batch.status === 'recalled' ? 'recalled' : batch.status === 'expired' ? 'expired' : 'damaged');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  const setPending = (p: PendingSupplierReturn | undefined) => {
    if (p) memory.set(key, p); else memory.delete(key);
    setPendingState(p);
  };
  /** `requestKey` was recorded: end it, and only it (a different return may have been started since). */
  const recorded = (requestKey: string) => {
    resolveStored(memory, key, requestKey);
    setPendingState((cur) => (cur && cur.requestKey !== requestKey ? cur : undefined));
  };

  /** Sends exactly `p`. Only a success, or a definite refusal of its FIRST attempt, ends it (requests.ts). */
  async function send(p: PendingSupplierReturn) {
    const attempt = { ...beginAttempt(p), supplierName: p.supplierName }; // stored before sending
    setBusy(true);
    setRefused(null);
    setPending(attempt);
    try {
      const r = await inventoryApi(api).supplierReturn(itemId, batch._id, attempt.body);
      recorded(attempt.requestKey);
      await onDone(r);
    } catch (err) {
      // A newer attempt of the same return owns the state now; this older answer changes nothing.
      if (!stillCurrent(memory.get<PendingSupplierReturn>(key), attempt)) return;
      const next = afterFailure(attempt, err, messageOf(err));
      setPending(next ? { ...next, supplierName: attempt.supplierName } : undefined);
      if (!next) setRefused(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  if (pending) {
    const b = pending.body;
    return (
      <PendingOpPanel key={pending.attempts} label={t('batchActions.unconfirmedReturnOfBatch', { batchNumber: batch.batchNumber })} op={pending} busy={busy}
        onResend={() => void send(pending)}
        fetchPage={(page) => inventoryApi(api).supplierReturns({ page, limit: 100 })}
        onFound={(r) => { recorded(pending.requestKey); void onDone({ ...r, duplicate: true }); }}
        onDiscard={() => {
          const k = pending.requestKey; // only the request this panel was about
          resolveStored(memory, key, k);
          setPendingState((cur) => (cur && cur.requestKey !== k ? cur : undefined));
        }}
        abandon={async () => {
          const r = await requestKeysApi(api).abandon('supplier_return', pending.requestKey);
          return { state: r.state, record: r.record as unknown as SupplierReturn | undefined };
        }}
        summary={pending.restored || !b ? null : <div>{t('batchActions.unitsToFull', { quantity: b.quantity, supplierName: pending.supplierName, reason: b.reason.replace(/_/g, ' '), value: b.notes ? ` · “${b.notes}”` : '' })}</div>} />
    );
  }

  if (suppliers.isPending) return <Loading label={t('common.loadingSuppliers')} />;
  if (suppliers.isError) return <Alert>{messageOf(suppliers.error)}</Alert>;
  const active = suppliers.data.filter((s) => s.state === 'active');
  if (active.length === 0) {
    return (
      <Alert tone="warn"><Parts of={t.rich('batchActions.returnsGoToOneOfFull', { words: <Link to="/pharmacy/suppliers">{t('common.addASupplier')}</Link> })} /></Alert>
    );
  }

  return (
    <FormShell name={t('batchActions.returnBatch', { batchNumber: batch.batchNumber })} title={t('batchActions.sendUnreservedUnitsOfBatch', { batchNumber: batch.batchNumber })}
      submitLabel={t('batchActions.recordSupplierReturn')} danger busy={busy} error={refused ? t('batchActions.notRecorded', { refused }) : null} onCancel={onCancel}
      onSubmit={() => {
        const n = wholeNumber(qty);
        const e: Record<string, string> = {};
        if (!supplierId) e.supplier = t('batchActions.chooseTheSupplier');
        if (!Number.isInteger(n) || n < 1 || n > batch.availableQty) e.qty = t('batchActions.enterAWholeNumberFrom2', { availableQty: batch.availableQty });
        setErrors(e);
        if (Object.keys(e).length === 0) {
          const requestKey = newRequestKey();
          void send({
            ...startOp(requestKey, { supplierId, quantity: n, reason, ...(notes.trim() ? { notes: notes.trim() } : {}), requestKey }),
            supplierName: active.find((s) => s.supplierId === supplierId)?.displayName ?? 'the supplier',
          });
        }
      }}>
      <SupplierSelect id={`sup-${batch._id}`} label={t('common.supplier')} suppliers={active} value={supplierId} onChange={setSupplierId} error={errors.supplier} />
      <TextField label={t('common.units')} inputMode="numeric" value={qty} error={errors.qty} hint={t('batchActions.upToUnreservedUnits', { availableQty: batch.availableQty })}
        onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} />
      <div className="j-field">
        <label htmlFor={`why-${batch._id}`}>{t('common.reason')}</label>
        <select id={`why-${batch._id}`} value={reason} onChange={(e) => setReason(e.target.value as SupplierReturnReason)}>
          {RETURN_REASONS().map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
      </div>
      <TextArea label={t('batchActions.notesOptional')} value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
    </FormShell>
  );
}

function RecallForm({ itemId, batch, onDone, onCancel }: { itemId: string; batch: Batch; onDone: () => Promise<unknown>; onCancel: () => void }) {
  const { api } = useSession();
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [trace, setTrace] = useState<RecallTrace | null>(null);
  const { busy, error, run } = useSubmit();
  if (trace) return <TraceView trace={trace} justRecalled />;
  return (
    <FormShell name={t('batchActions.recallBatch', { batchNumber: batch.batchNumber })} title={t('batchActions.recallBatchThisCannotBe', { batchNumber: batch.batchNumber })}
      submitLabel={t('batchActions.recallBatch2')} danger busy={busy} error={error} onCancel={onCancel}
      onSubmit={() => {
        const e: Record<string, string> = {};
        if (reason.trim().length < 3) e.reason = t('common.giveAReasonAtLeast');
        setErrors(e);
        if (Object.keys(e).length === 0) {
          void run(async () => {
            const r = await inventoryApi(api).recall(itemId, batch._id, { reason: reason.trim(), ...(reference.trim() ? { reference: reference.trim() } : {}) });
            setTrace({ batch: r.batch, openOrders: r.impactedOrders ?? r.openOrders ?? [], dispensedTo: r.dispensedTo ?? [], dispensedTruncated: r.dispensedTruncated });
            await onDone();
          });
        }
      }}>
      <TextArea label={t('common.reason')} value={reason} maxLength={500} error={errors.reason} onChange={(e) => setReason(e.target.value)} />
      <TextField label={t('batchActions.noticeReferenceOptional')} hint={t('batchActions.theManufacturerSOrRegulator')} value={reference}
        maxLength={200} onChange={(e) => setReference(e.target.value)} />
    </FormShell>
  );
}

function TraceLoader({ itemId, batchId }: { itemId: string; batchId: string }) {
  const { api } = useSession();
  const q = useQuery({ queryKey: ['pharmacy-inventory', 'recall-trace', itemId, batchId], queryFn: () => inventoryApi(api).recallTrace(itemId, batchId) });
  if (q.isPending) return <Loading label={t('batchActions.loadingRecallTrace')} />;
  if (q.isError) return <Alert>{messageOf(q.error)}</Alert>;
  return <TraceView trace={q.data} />;
}

function TraceView({ trace, justRecalled = false }: { trace: RecallTrace; justRecalled?: boolean }) {
  return (
    <div className="confirm" role="region" aria-label={t('batchActions.recallTraceForBatch', { batchNumber: trace.batch.batchNumber })}>
      {justRecalled && <Alert tone="ok">{t('batchActions.batchFull', { batchNumber: trace.batch.batchNumber })}</Alert>}
      <div className="confirm-text">{t('batchActions.openOrdersHoldingThisBatch')}{trace.openOrders.length})</div>
      {trace.openOrders.length === 0 ? <span className="ws-muted">{t('batchActions.none')}</span> : (
        <ul className="ws-list">
          {trace.openOrders.map((o) => (
            <li key={o.orderId}>{t('batchActions.unitsSwapOrCancelItFull', { orderNumber: o.orderNumber ?? o.orderId.slice(-8), orderStatusLabel: orderStatusLabel(o.status), reduce: o.heldUnits.reduce((a, u) => a + u.quantity, 0) })}</li>
          ))}
        </ul>
      )}
      <div className="confirm-text">{t('batchActions.customersWhoReceivedIt')}{trace.dispensedTo.length}{trace.dispensedTruncated ? '+' : ''})</div>
      {trace.dispensedTo.length === 0 ? <span className="ws-muted">{t('batchActions.none')}</span> : (
        <ul className="ws-list">
          {trace.dispensedTo.map((d) => (
            <li key={d.orderId}>{t('common.orderFull', { orderNumber: d.orderNumber ?? d.orderId.slice(-8), quantity: d.quantity, value: d.returnedQty ? ` (${d.returnedQty} returned)` : '', time: formatDateTime(d.completedAt) })}</li>
          ))}
        </ul>
      )}
      {trace.dispensedTruncated && <Alert tone="warn">{t('batchActions.theListIsCutAt')}</Alert>}
    </div>
  );
}
