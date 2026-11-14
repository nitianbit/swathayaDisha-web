import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  pharmacyOrdersApi, type CustomerReturn, type Page, type CustomerReturnLine, type CustomerReturnRequest, type PharmacyOrder,
} from '@jansetu/api';
import { Alert, Button, ErrorState, formatDateTime, formatRupees, Loading, TextArea, TextField } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { definitelyNotRecorded, newRequestKey } from '../../requests.ts';
import { useSession } from '../../session.tsx';

interface Row { key: string; medicineId: string; medicineName: string; batchId: string; batchNumber: string; sold: number }

/** A submitted return whose outcome is not known yet. Kept in session memory, so leaving the page does not lose it. */
interface Pending { requestKey: string; body: CustomerReturnRequest; error?: string }
type Receipt = CustomerReturn & { duplicate?: boolean };

/** Rupees with at most two decimals, as the backend's Joi rule accepts (`precision(2).strict()`). */
export function parseRupees(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return null;
  return Number(t);
}

const pendingKey = (orderId: string) => `customer-return:${orderId}`;
const DISPOSITION = { restock: 'back to stock', discard: 'discarded' } as const;

/**
 * Customer brings back medicines from a completed order (P3b). One physical return must be recorded once:
 * - each submission has a request key; a retry sends the SAME key and the SAME details (the form is locked until the
 *   outcome is known), so the server answers with the first record instead of recording twice;
 * - an unconfirmed submission survives leaving the page (session memory, not browser storage);
 * - returns already recorded for the order are always listed before another can be started (also after a reload).
 */
export function CustomerReturnForm({ order, onDone }: { order: PharmacyOrder; onDone: () => void }) {
  const { api, memory } = useSession();
  const queryClient = useQueryClient();
  const orders = pharmacyOrdersApi(api);
  const rows: Row[] = order.items
    .filter((it) => (it.itemStatus ?? 'active') === 'active')
    .flatMap((it) => (it.batchAllocations ?? []).map((b) => ({
      key: `${it.medicineId}:${b.batchId}`, medicineId: it.medicineId, medicineName: it.medicineName ?? it.medicineId,
      batchId: b.batchId, batchNumber: b.batchNumber, sold: b.quantity,
    })));

  const history = useQuery({ queryKey: ['customer-returns', order._id], queryFn: () => orders.customerReturnsFor(order._id) });
  const [pending, setPendingState] = useState<Pending | undefined>(() => memory.get<Pending>(pendingKey(order._id)));
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [disposition, setDisposition] = useState<Record<string, CustomerReturnLine['disposition']>>({});
  const [reason, setReason] = useState('');
  const [refund, setRefund] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);

  if (rows.length === 0) return null;

  const setPending = (p: Pending | undefined) => {
    if (p) memory.set(pendingKey(order._id), p); else memory.delete(pendingKey(order._id));
    setPendingState(p);
  };

  /** Sends exactly `p`; only a definite answer clears it. */
  async function send(p: Pending) {
    setBusy(true);
    setRefused(null);
    setPending({ ...p, error: undefined });
    try {
      const result = await orders.customerReturn(order._id, p.body);
      setPending(undefined);
      setReceipt(result);
      setOpen(false);
      onDone();
    } catch (err) {
      if (definitelyNotRecorded(err)) {
        setPending(undefined);
        setRefused(messageOf(err)); // the form keeps what was typed; the next submission gets a new key
      } else {
        setPending({ ...p, error: messageOf(err) });
      }
    } finally {
      setBusy(false);
      void queryClient.invalidateQueries({ queryKey: ['customer-returns', order._id] });
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const lines: CustomerReturnLine[] = [];
    for (const r of rows) {
      const raw = (qty[r.key] ?? '').trim();
      if (!raw || raw === '0') continue;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > r.sold) { errs[r.key] = `Enter a whole number from 1 to ${r.sold}.`; continue; }
      lines.push({ medicineId: r.medicineId, batchId: r.batchId, quantity: n, disposition: disposition[r.key] ?? 'restock' });
    }
    if (lines.length === 0 && Object.keys(errs).length === 0) errs.lines = 'Enter a quantity for at least one medicine.';
    if (reason.trim().length < 3) errs.reason = 'Give a reason (at least 3 characters).';
    const refundAmount = refund.trim() === '' ? undefined : parseRupees(refund);
    if (refundAmount === null) errs.refund = 'Enter an amount in rupees, like 120 or 120.50.';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    void send(withKey({ reason: reason.trim(), lines, ...(refundAmount != null ? { refundAmount } : {}) }));
  }

  function startAnother() {
    setReceipt(null); setQty({}); setDisposition({}); setReason(''); setRefund(''); setErrors({}); setRefused(null); setOpen(true);
  }

  const nameOf = (medicineId: string, batchId: string) => rows.find((r) => r.medicineId === medicineId && r.batchId === batchId);

  return (
    <section className="ws-section" aria-labelledby="return-h">
      <h2 id="return-h">Customer return</h2>

      <ReturnHistory query={history} />

      {pending ? (
        <div className="confirm" role="group" aria-label="Unconfirmed return">
          <Alert tone="warn">
            This return was sent but its answer did not arrive{pending.error ? ` (${pending.error})` : ''}. It may already be
            recorded. Send the same return again to find out; it will not be recorded twice.
          </Alert>
          <ReturnLines lines={pending.body.lines.map((l) => ({ ...l, ...nameOf(l.medicineId, l.batchId) }))} />
          <div>Reason: “{pending.body.reason}” · Refund: {pending.body.refundAmount != null ? formatRupees(pending.body.refundAmount) : 'none'}</div>
          <div className="confirm-actions"><Button busy={busy} onClick={() => void send(pending)}>Send the same return again</Button></div>
        </div>
      ) : receipt ? (
        <div className="confirm" role="group" aria-label="Recorded return">
          <Alert tone="ok">
            {receipt.duplicate ? 'This return had already been recorded. These are the recorded details:' : 'Return recorded:'}
          </Alert>
          <ReturnLines lines={receipt.lines} />
          <div>Value {formatRupees(receipt.returnValuePaise / 100)} · refunded to the wallet {formatRupees(receipt.refundPaise / 100)}</div>
          <div className="confirm-actions"><Button variant="secondary" onClick={startAnother}>Record another return…</Button></div>
        </div>
      ) : !open ? (
        <div className="ws-action">
          {/* The recorded returns are the check against recording one twice: no new return without them. */}
          <Button variant="secondary" onClick={() => setOpen(true)} disabled={!history.isSuccess}>Record a return…</Button>
          {history.data && history.data.total > 0 && (
            <span className="ws-muted">Check the returns above first: do not record the same return again.</span>
          )}
        </div>
      ) : (
        <form className="rx-form" noValidate onSubmit={submit}>
          <div className="ws-table-wrap">
            <table className="j-table">
              <thead>
                <tr><th scope="col">Medicine</th><th scope="col">Batch</th><th scope="col">Sold</th><th scope="col">Returned</th><th scope="col">Then</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td>{r.medicineName}</td>
                    <td>{r.batchNumber}</td>
                    <td>{r.sold}</td>
                    <td>
                      <TextField label={`Returned quantity of ${r.medicineName}, batch ${r.batchNumber}`} className="ws-qty"
                        inputMode="numeric" value={qty[r.key] ?? ''} error={errors[r.key]}
                        onChange={(e) => setQty((q) => ({ ...q, [r.key]: e.target.value.replace(/\D/g, '') }))} />
                    </td>
                    <td>
                      <div className="j-field">
                        <label htmlFor={`disp-${r.key}`} className="j-sr-only">What happens to {r.medicineName}, batch {r.batchNumber}</label>
                        <select id={`disp-${r.key}`} value={disposition[r.key] ?? 'restock'}
                          onChange={(e) => setDisposition((d) => ({ ...d, [r.key]: e.target.value as CustomerReturnLine['disposition'] }))}>
                          <option value="restock">Back to stock</option>
                          <option value="discard">Discard</option>
                        </select>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {errors.lines && <Alert>{errors.lines}</Alert>}
          <TextArea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} error={errors.reason} maxLength={500} />
          <TextField label="Refund to the customer’s wallet (₹, optional)" inputMode="decimal" value={refund}
            onChange={(e) => setRefund(e.target.value)} error={errors.refund}
            hint="Leave empty for no refund. It cannot exceed the value of what is returned or what was paid." />
          {refused && <Alert>Not recorded: {refused}</Alert>}
          <div className="rx-actions">
            <Button type="submit" busy={busy}>Record return</Button>
            <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </form>
      )}
    </section>
  );
}

function withKey(body: Omit<CustomerReturnRequest, 'requestKey'>): Pending {
  const requestKey = newRequestKey();
  return { requestKey, body: { ...body, requestKey } };
}

function ReturnLines({ lines }: { lines: (CustomerReturnLine & { medicineName?: string; batchNumber?: string })[] }) {
  return (
    <ul className="ws-list">
      {lines.map((l, i) => (
        <li key={i}>{l.medicineName ?? l.medicineId} (batch {l.batchNumber ?? l.batchId}) × {l.quantity}, {DISPOSITION[l.disposition]}</li>
      ))}
    </ul>
  );
}

function ReturnHistory({ query }: { query: UseQueryResult<Page<CustomerReturn>> }) {
  if (query.isPending) return <Loading label="Loading recorded returns…" />;
  if (query.isError) return <ErrorState message={`Could not load recorded returns: ${messageOf(query.error)}`} onRetry={() => void query.refetch()} />;
  if (query.data.total === 0) return <p className="ws-muted">No return has been recorded for this order.</p>;
  return (
    <div>
      <h3>Already recorded ({query.data.total})</h3>
      <ul className="ws-list">
        {query.data.items.map((r) => (
          <li key={r._id}>
            {formatDateTime(r.createdAt)} · {r.lines.map((l) => `${l.medicineName ?? l.medicineId} × ${l.quantity} ${DISPOSITION[l.disposition]}`).join('; ')}
            {' '}· refund {formatRupees(r.refundPaise / 100)} · “{r.reason}”
          </li>
        ))}
      </ul>
    </div>
  );
}
