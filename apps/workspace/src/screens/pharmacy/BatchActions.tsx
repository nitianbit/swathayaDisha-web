import { useState, type FormEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BATCH_ACTION_FROM, inventoryApi, type Batch, type RecallTrace, type SupplierReturn, type SupplierReturnReason,
  type SupplierReturnRequest,
} from '@jansetu/api';
import { Alert, Button, formatDateTime, Loading, TextArea, TextField } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { messageOf } from '../../errors.ts';
import { PendingOpPanel } from '../../components/PendingOpPanel.tsx';
import { afterFailure, beginAttempt, newRequestKey, startOp, stillCurrent, type PendingOp } from '../../requests.ts';
import { useSession } from '../../session.tsx';

type Panel = null | 'release' | 'supplier' | 'recall' | 'trace';

const RETURN_REASONS: { value: SupplierReturnReason; label: string }[] = [
  { value: 'expired', label: 'Expired' },
  { value: 'near_expiry', label: 'Near expiry' },
  { value: 'damaged', label: 'Damaged' },
  { value: 'recalled', label: 'Recalled' },
  { value: 'other', label: 'Other' },
];

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
          <ConfirmAction label="Quarantine" confirmLabel="Quarantine batch" danger reason reasonLabel="Why is it held?"
            consequence={`Batch ${batch.batchNumber} can no longer be sold or reserved. Orders already holding its units are listed under Quality.`}
            onConfirm={async (reason) => { await inv.quarantine(itemId, batch._id, reason); await onChanged(); }} />
        )}
        {can('release') && <Button variant="secondary" onClick={() => setPanel(panel === 'release' ? null : 'release')}>Release…</Button>}
        {can('supplierReturn') && batch.availableQty > 0 && panel !== 'supplier' && (
          <Button variant="secondary" onClick={() => { setNotice(null); setPanel('supplier'); }}>Return to supplier…</Button>
        )}
        {can('recall') && <Button variant="secondary" onClick={() => setPanel(panel === 'recall' ? null : 'recall')}>Recall…</Button>}
        {batch.status === 'recalled' && (
          <Button variant="secondary" onClick={() => setPanel(panel === 'trace' ? null : 'trace')}>Recall trace</Button>
        )}
      </div>
      {panel === 'release' && <ReleaseForm itemId={itemId} batch={batch} onDone={done} onCancel={() => setPanel(null)} />}
      {notice && <Alert tone="ok">{notice}</Alert>}
      {panel === 'supplier' && (
        <SupplierReturnForm itemId={itemId} batch={batch} onCancel={() => setPanel(null)}
          onDone={async (r) => {
            setNotice(`${r.duplicate ? 'Already recorded' : 'Recorded'}: ${r.quantity} units of batch ${r.batchNumber} returned (${r.reason.replace(/_/g, ' ')}).`);
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
        <Button variant="ghost" disabled={busy} onClick={onCancel}>Back</Button>
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

const wholeNumber = (t: string) => (/^\d+$/.test(t.trim()) ? Number(t.trim()) : NaN);

function ReleaseForm({ itemId, batch, onDone, onCancel }: { itemId: string; batch: Batch; onDone: () => Promise<unknown>; onCancel: () => void }) {
  const { api } = useSession();
  const [writeOff, setWriteOff] = useState('0');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { busy, error, run } = useSubmit();
  return (
    <FormShell name={`Release batch ${batch.batchNumber}`} title={`Release batch ${batch.batchNumber} back to sale. Units written off are removed from stock; reserved units stay with their orders.`}
      submitLabel="Release batch" busy={busy} error={error} onCancel={onCancel}
      onSubmit={() => {
        const n = wholeNumber(writeOff);
        const e: Record<string, string> = {};
        if (!Number.isInteger(n) || n < 0 || n > batch.availableQty) e.writeOff = `Enter a whole number from 0 to ${batch.availableQty}.`;
        if (reason.trim().length < 3) e.reason = 'Give a reason (at least 3 characters).';
        setErrors(e);
        if (Object.keys(e).length === 0) void run(async () => { await inventoryApi(api).release(itemId, batch._id, { writeOffQty: n, reason: reason.trim() }); await onDone(); });
      }}>
      <TextField label="Units to write off" inputMode="numeric" value={writeOff} error={errors.writeOff}
        hint={`${batch.availableQty} unreserved units in this batch.`} onChange={(e) => setWriteOff(e.target.value.replace(/\D/g, ''))} />
      <TextArea label="Reason" value={reason} maxLength={500} error={errors.reason} onChange={(e) => setReason(e.target.value)} />
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
  const suppliers = useQuery({ queryKey: ['pharmacy-suppliers', 'active'], queryFn: () => inventoryApi(api).suppliers() });
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

  /** Sends exactly `p`. Only a success, or a definite refusal of its FIRST attempt, ends it (requests.ts). */
  async function send(p: PendingSupplierReturn) {
    const attempt = { ...beginAttempt(p), supplierName: p.supplierName }; // stored before sending
    setBusy(true);
    setRefused(null);
    setPending(attempt);
    try {
      const r = await inventoryApi(api).supplierReturn(itemId, batch._id, attempt.body);
      setPending(undefined);
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
      <PendingOpPanel key={pending.attempts} label={`Unconfirmed return of batch ${batch.batchNumber}`} op={pending} busy={busy}
        onResend={() => void send(pending)}
        fetchPage={(page) => inventoryApi(api).supplierReturns({ page, limit: 100 })}
        onFound={(r) => { setPending(undefined); void onDone({ ...r, duplicate: true }); }}
        summary={<div>{b.quantity} units to {pending.supplierName} · {b.reason.replace(/_/g, ' ')}{b.notes ? ` · “${b.notes}”` : ''}</div>} />
    );
  }

  if (suppliers.isPending) return <Loading label="Loading suppliers…" />;
  if (suppliers.isError) return <Alert>{messageOf(suppliers.error)}</Alert>;
  const active = suppliers.data.items.filter((s) => s.state === 'active');
  if (active.length === 0) return <Alert tone="warn">Add a supplier first; returns go to one of your active suppliers.</Alert>;

  return (
    <FormShell name={`Return batch ${batch.batchNumber}`} title={`Send unreserved units of batch ${batch.batchNumber} back to a supplier. They leave your stock.`}
      submitLabel="Record supplier return" danger busy={busy} error={refused ? `Not recorded: ${refused}` : null} onCancel={onCancel}
      onSubmit={() => {
        const n = wholeNumber(qty);
        const e: Record<string, string> = {};
        if (!supplierId) e.supplier = 'Choose the supplier.';
        if (!Number.isInteger(n) || n < 1 || n > batch.availableQty) e.qty = `Enter a whole number from 1 to ${batch.availableQty}.`;
        setErrors(e);
        if (Object.keys(e).length === 0) {
          const requestKey = newRequestKey();
          void send({
            ...startOp(requestKey, { supplierId, quantity: n, reason, ...(notes.trim() ? { notes: notes.trim() } : {}), requestKey }),
            supplierName: active.find((s) => s.supplierId === supplierId)?.displayName ?? 'the supplier',
          });
        }
      }}>
      <div className="j-field">
        <label htmlFor={`sup-${batch._id}`}>Supplier</label>
        <select id={`sup-${batch._id}`} value={supplierId} aria-invalid={errors.supplier ? true : undefined} onChange={(e) => setSupplierId(e.target.value)}>
          <option value="">Choose…</option>
          {active.map((s) => <option key={s.supplierId} value={s.supplierId}>{s.displayName}</option>)}
        </select>
        {errors.supplier && <span className="j-field__error">{errors.supplier}</span>}
      </div>
      <TextField label="Units" inputMode="numeric" value={qty} error={errors.qty} hint={`Up to ${batch.availableQty} unreserved units.`}
        onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} />
      <div className="j-field">
        <label htmlFor={`why-${batch._id}`}>Reason</label>
        <select id={`why-${batch._id}`} value={reason} onChange={(e) => setReason(e.target.value as SupplierReturnReason)}>
          {RETURN_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
      </div>
      <TextArea label="Notes (optional)" value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
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
    <FormShell name={`Recall batch ${batch.batchNumber}`} title={`Recall batch ${batch.batchNumber}. This cannot be undone: the batch is never sold again, and you get the list of open orders and customers who received it.`}
      submitLabel="Recall batch" danger busy={busy} error={error} onCancel={onCancel}
      onSubmit={() => {
        const e: Record<string, string> = {};
        if (reason.trim().length < 3) e.reason = 'Give a reason (at least 3 characters).';
        setErrors(e);
        if (Object.keys(e).length === 0) {
          void run(async () => {
            const r = await inventoryApi(api).recall(itemId, batch._id, { reason: reason.trim(), ...(reference.trim() ? { reference: reference.trim() } : {}) });
            setTrace({ batch: r.batch, openOrders: r.impactedOrders ?? r.openOrders ?? [], dispensedTo: r.dispensedTo ?? [], dispensedTruncated: r.dispensedTruncated });
            await onDone();
          });
        }
      }}>
      <TextArea label="Reason" value={reason} maxLength={500} error={errors.reason} onChange={(e) => setReason(e.target.value)} />
      <TextField label="Notice reference (optional)" hint="The manufacturer’s or regulator’s recall notice number." value={reference}
        maxLength={200} onChange={(e) => setReference(e.target.value)} />
    </FormShell>
  );
}

function TraceLoader({ itemId, batchId }: { itemId: string; batchId: string }) {
  const { api } = useSession();
  const q = useQuery({ queryKey: ['pharmacy-inventory', 'recall-trace', itemId, batchId], queryFn: () => inventoryApi(api).recallTrace(itemId, batchId) });
  if (q.isPending) return <Loading label="Loading recall trace…" />;
  if (q.isError) return <Alert>{messageOf(q.error)}</Alert>;
  return <TraceView trace={q.data} />;
}

function TraceView({ trace, justRecalled = false }: { trace: RecallTrace; justRecalled?: boolean }) {
  return (
    <div className="confirm" role="region" aria-label={`Recall trace for batch ${trace.batch.batchNumber}`}>
      {justRecalled && <Alert tone="ok">Batch {trace.batch.batchNumber} is recalled.</Alert>}
      <div className="confirm-text">Open orders holding this batch ({trace.openOrders.length})</div>
      {trace.openOrders.length === 0 ? <span className="ws-muted">None.</span> : (
        <ul className="ws-list">
          {trace.openOrders.map((o) => (
            <li key={o.orderId}>{o.orderNumber ?? o.orderId.slice(-8)} · {o.status.replace(/_/g, ' ')} ·{' '}
              {o.heldUnits.reduce((a, u) => a + u.quantity, 0)} units — swap or cancel it under Quality</li>
          ))}
        </ul>
      )}
      <div className="confirm-text">Customers who received it ({trace.dispensedTo.length}{trace.dispensedTruncated ? '+' : ''})</div>
      {trace.dispensedTo.length === 0 ? <span className="ws-muted">None.</span> : (
        <ul className="ws-list">
          {trace.dispensedTo.map((d) => (
            <li key={d.orderId}>Order {d.orderNumber ?? d.orderId.slice(-8)} · {d.quantity} units
              {d.returnedQty ? ` (${d.returnedQty} returned)` : ''} · {formatDateTime(d.completedAt)}</li>
          ))}
        </ul>
      )}
      {trace.dispensedTruncated && <Alert tone="warn">The list is cut at 1000 orders; ask an admin for the full list.</Alert>}
    </div>
  );
}
