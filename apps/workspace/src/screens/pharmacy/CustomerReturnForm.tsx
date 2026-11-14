import { useState, type FormEvent } from 'react';
import { pharmacyOrdersApi, type CustomerReturn, type CustomerReturnLine, type PharmacyOrder } from '@jansetu/api';
import { Alert, Button, formatRupees, TextArea, TextField } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { useSession } from '../../session.tsx';

interface Row { key: string; medicineId: string; medicineName: string; batchId: string; batchNumber: string; sold: number }

/** One key per form: a retried submission (lost answer, double click) returns the first record instead of a second return. */
export const newRequestKey = () => crypto.randomUUID().replace(/-/g, '');

/** Rupees with at most two decimals, as the backend's Joi rule accepts (`precision(2).strict()`). */
export function parseRupees(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return null;
  return Number(t);
}

/** Customer brings back medicines from a completed order (P3b). The server checks quantities, batches and refund limits. */
export function CustomerReturnForm({ order, onDone }: { order: PharmacyOrder; onDone: () => void }) {
  const { api } = useSession();
  const rows: Row[] = order.items
    .filter((it) => (it.itemStatus ?? 'active') === 'active')
    .flatMap((it) => (it.batchAllocations ?? []).map((b) => ({
      key: `${it.medicineId}:${b.batchId}`, medicineId: it.medicineId, medicineName: it.medicineName ?? it.medicineId,
      batchId: b.batchId, batchNumber: b.batchNumber, sold: b.quantity,
    })));

  const [open, setOpen] = useState(false);
  const [requestKey, setRequestKey] = useState(newRequestKey);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [disposition, setDisposition] = useState<Record<string, CustomerReturnLine['disposition']>>({});
  const [reason, setReason] = useState('');
  const [refund, setRefund] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<(CustomerReturn & { duplicate?: boolean }) | null>(null);

  if (rows.length === 0) return null;

  async function submit(e: FormEvent) {
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

    setBusy(true);
    setError(null);
    try {
      const result = await pharmacyOrdersApi(api).customerReturn(order._id, {
        requestKey, reason: reason.trim(), lines, ...(refundAmount != null ? { refundAmount } : {}),
      });
      setDone(result);
      onDone();
    } catch (err) {
      // Same key on the next attempt: if this one was in fact recorded, the server answers with that record.
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setRequestKey(newRequestKey());
    setQty({}); setDisposition({}); setReason(''); setRefund(''); setErrors({}); setError(null); setDone(null); setOpen(false);
  }

  return (
    <section className="ws-section" aria-labelledby="return-h">
      <h2 id="return-h">Customer return</h2>
      {done ? (
        <>
          <Alert tone="ok">
            {done.duplicate ? 'This return was already recorded. ' : 'Return recorded. '}
            Value {formatRupees(done.returnValuePaise / 100)}, refunded to the wallet {formatRupees(done.refundPaise / 100)}.
          </Alert>
          <div><Button variant="secondary" onClick={reset}>Record another return</Button></div>
        </>
      ) : !open ? (
        <div><Button variant="secondary" onClick={() => setOpen(true)}>Record a return…</Button></div>
      ) : (
        <form className="rx-form" noValidate onSubmit={(e) => void submit(e)}>
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
          {error && <Alert>{error}</Alert>}
          <div className="rx-actions">
            <Button type="submit" busy={busy}>Record return</Button>
            <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </form>
      )}
    </section>
  );
}
