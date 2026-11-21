import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import {
  ADD_STOCK_REASONS, ApiError, formatExpiry, isSupplierRefusal, MAX_STOCK_NOTE, medicineName, pharmacyStockApi, STOCK_LIMITS, stockEntryBody,
  stockEntryProblems, SUPPLIER_REFUSAL, type AddStockReason, type InventoryItem, type Medicine, type PharmacySupplier, type StockAdjustment,
  type StockEntry, type StockEntryDraft,
} from '@jansetu/api';
import { Alert, Button, Empty, ErrorState, formatDateTime, formatRupees, Loading, TextArea, TextField } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { newRequestKey, startOp, wasAbandoned, type PendingOp } from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { useOneAtATime } from '../finance/finance.tsx';
import { CheckPanel, useOwnedOp, usePharmacyId } from './ownedOp.tsx';
import { SupplierSelect, useActiveSuppliers } from './SupplierPicker.tsx';

/**
 * What is kept (in session memory only) for an entry being sent: the request and the words to describe it. Q15: it is
 * sent with its request key, so the same entry can be sent again safely (the server answers the key with what it saved,
 * `replayed`, and never adds the units twice) and a lost answer is looked up by key.
 */
interface PendingEntry { entry: StockEntry; medicineName: string; supplierName?: string }

type Fields = Omit<StockEntryDraft, 'medicineId'>;
const EMPTY: Fields = {
  batchNumber: '', expiry: '', quantity: '', mrp: '', retailPrice: '', purchasePrice: '', rackLocation: '', reorderThreshold: '',
  reason: 'purchase', note: '', supplierId: '',
};

/** WQ10a: add units of one batch of a medicine (`POST /pharmacy-inventory`, keyed since Q15). */
export function AddStockScreen() {
  const pharmacyId = usePharmacyId();
  return (
    <>
      <Link to="/pharmacy/stock" className="ws-back"><ArrowLeft size={16} aria-hidden="true" /> Stock</Link>
      <PageHeading title="Add stock">
        Add the units of one batch you received. To add many medicines at once, <Link to="/pharmacy/stock/import">import a file</Link>.
      </PageHeading>
      <AddStock key={pharmacyId} pharmacyId={pharmacyId} />
    </>
  );
}

const describe = (e: StockEntry, name: string, supplier?: string) =>
  `${e.quantity} units of ${name}, batch ${e.batchNumber.toUpperCase()} (expires ${formatExpiry(e.expiryDate)})${supplier ? ` from ${supplier}` : ''}`;
const describeOp = (b: PendingEntry) => describe(b.entry, b.medicineName, b.supplierName);

/** The adjustment's medicine id (populated or not). */
const adjustmentMedicine = (a: StockAdjustment) => String(typeof a.medicineId === 'object' && a.medicineId ? a.medicineId._id : a.medicineId).toLowerCase();

/**
 * WQ11c re-review N2: the words for a saved entry. The save answers only the items, so a supplier is named only when the
 * delivery as recorded (the newest matching adjustment, re-read) carries it; otherwise "(supplier not recorded)", or
 * "(supplier not confirmed …)" when the history could not be read. An entry without a supplier is described as it is.
 */
async function savedWords(read: () => Promise<StockAdjustment[]>, p: PendingOp<PendingEntry>): Promise<string> {
  const b = p.body;
  if (!b) return 'the stock entry';
  if (!b.entry.supplierId) return describe(b.entry, b.medicineName);
  const base = describe(b.entry, b.medicineName);
  try {
    const since = p.firstAttemptAt - 10 * 60_000;
    const hit = (await read()).find((a) => adjustmentMedicine(a) === b.entry.medicineId.toLowerCase()
      && (a.batchNumber ?? '').toUpperCase() === b.entry.batchNumber.toUpperCase() && a.quantity === b.entry.quantity
      && a.adjustmentType === 'add' && (!a.createdAt || Date.parse(a.createdAt) >= since));
    const recorded = hit?.supplier?.supplierId ?? hit?.supplierId;
    if (hit && recorded && String(recorded).toLowerCase() === b.entry.supplierId.toLowerCase()) {
      return `${base} from ${hit.supplier?.displayName ?? b.supplierName ?? 'the supplier'}`;
    }
    return `${base} (supplier not recorded)`;
  } catch {
    return `${base} (supplier not confirmed: see the stock history)`;
  }
}

const searchText = (m: Medicine) => m.name ?? m.brandName ?? m.genericName ?? '';

/** The medicine's name in a saved item (populated) for the Stock link, or ''. */
const itemSearch = (items: InventoryItem[]) => {
  const m = items[0]?.medicineId;
  return typeof m === 'object' && m ? m.name ?? m.brandName ?? m.genericName ?? '' : '';
};

function AddStock({ pharmacyId }: { pharmacyId: string }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const stock = pharmacyStockApi(api);
  const [params, setParams] = useSearchParams();
  const { op, send, settle } = useOwnedOp<PendingEntry>(`stock-add:${pharmacyId}`);
  const { perform, busy } = useOneAtATime('stock entry');
  const [resendError, setResendError] = useState<string | null>(null);
  const [givingUp, setGivingUp] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [picked, setPicked] = useState<Medicine | null>(null);
  const [draft, setDraft] = useState<Fields>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<keyof StockEntryDraft, string>>>({});
  const [review, setReview] = useState<{ requestKey: string } & PendingEntry | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [done, setDone] = useState<{ text: string; search: string } | null>(null);

  // "Add a batch" on the Stock page names the medicine (its id only).
  const preset = params.get('medicine') ?? '';
  const presetValid = /^[0-9a-fA-F]{24}$/.test(preset);
  const presetQ = useQuery({
    queryKey: ['pharmacy-medicines', pharmacyId, 'one', preset],
    queryFn: () => stock.medicine(preset),
    enabled: presetValid,
    retry: (n, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && n < 2,
  });
  // WQ11c: a malformed id in the address, or one the server does not know: say so and offer the picker.
  const presetMissing = !!preset && !picked && (!presetValid || (presetQ.isError && presetQ.error instanceof ApiError && (presetQ.error.status === 404 || presetQ.error.status === 400)));
  const chosen = picked ?? (preset && presetValid ? presetQ.data ?? null : null);
  const suppliers = useActiveSuppliers(pharmacyId);
  const supplierList = suppliers.data ?? [];

  const set = <K extends keyof Fields>(k: K, v: Fields[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['pharmacy-inventory'] });
  const readAdjustments = () => stock.adjustments(1, 20).then((x) => x.items);

  function check(e: FormEvent) {
    e.preventDefault();
    setDone(null);
    setRefused(null);
    setNotice(null);
    const full: StockEntryDraft = { ...draft, medicineId: chosen?._id ?? '' };
    const problems = stockEntryProblems(full);
    setErrors(problems);
    if (Object.keys(problems).length || !chosen) return;
    const supplier = draft.supplierId ? supplierList.find((x) => x.supplierId === draft.supplierId) : undefined;
    setReview({ requestKey: newRequestKey(), entry: stockEntryBody(full), medicineName: medicineName(chosen), ...(supplier ? { supplierName: supplier.displayName } : {}) });
  }

  /** Sends `p` (its key, its entry) under the one-at-a-time guard; an unknown outcome stays stored for the panel below. */
  async function sendEntry(p: PendingOp<PendingEntry>, search: string) {
    const r = await perform(() => send(p, (b) => stock.addStock(b.entry, p.requestKey)));
    if (r.kind === 'stale') return;
    setReview(null);
    if (r.kind === 'unknown' && wasAbandoned(r.error)) {
      // Given up meanwhile (e.g. in another tab): the server says this key can never add anything.
      settle(p.requestKey);
      setNotice('This entry was given up earlier, so nothing was added with it. Add the units again if they are still to be added.');
      return;
    }
    if (r.kind === 'ok') {
      setDraft(EMPTY);
      setErrors({});
      void refresh();
      const what = p.body ? await savedWords(readAdjustments, p) : 'the units';
      setDone({
        text: r.value.replayed ? `Already added: ${what}. Nothing was added twice.` : `Added ${what}.`,
        search: search || itemSearch(r.value.items),
      });
    } else if (r.kind === 'refused') {
      // Q16c: the supplier is no longer one of the pharmacy's active ones: read them again and ask for another.
      if (isSupplierRefusal(r.error)) {
        const words = SUPPLIER_REFUSAL[(r.error as ApiError).code ?? ''] ?? messageOf(r.error);
        setErrors((e) => ({ ...e, supplierId: words }));
        void suppliers.refetch();
        setRefused(words);
      } else setRefused(messageOf(r.error));
    }
  }

  /** The recorded entry was found (by key or by giving up): show it and clear the form, so it is not added again. */
  async function recorded(p: PendingOp<PendingEntry>, items: InventoryItem[]) {
    settle(p.requestKey);
    setDraft(EMPTY);
    setErrors({});
    setReview(null);
    void refresh();
    const what = await savedWords(readAdjustments, p);
    setDone({ text: `Recorded: ${what} was added. Nothing was added twice.`, search: itemSearch(items) });
  }

  /**
   * Q15: gives the entry up on the server. 'abandoned' = its key can never add anything now: the form is free again (with
   * what was typed, when it is still here); 'used' = it was added, and that is shown.
   */
  async function giveUp(p: PendingOp<PendingEntry>) {
    setResendError(null);
    setGivingUp(true);
    try {
      const r = await perform(() => stock.abandonStock(p.requestKey));
      if (r.state === 'used') { await recorded(p, r.items); return; }
      settle(p.requestKey);
      setNotice('Given up: nothing was added with that entry, and it can never be added now. Check the details and add the units again.');
    } catch (err) {
      setResendError(messageOf(err));
    } finally {
      setGivingUp(false);
    }
  }

  async function add() {
    if (!review) return;
    const { requestKey, ...pending } = review;
    try {
      await sendEntry(startOp(requestKey, pending), chosen ? searchText(chosen) : '');
    } catch (err) {
      setRefused(messageOf(err)); // refused by the one-at-a-time guard: nothing was sent
    }
  }

  function changeMedicine() {
    setPicked(null);
    setReview(null);
    if (preset) setParams({}, { replace: true });
  }

  // The unconfirmed entry stays on screen while it is resent or given up; only its first attempt (sent from this page, not
  // a give-up of it) shows the review busy.
  if (op && !(busy && !givingUp && op.attempts === 1 && !op.uncertain)) {
    const restored = !!op.restored || !op.body;
    return (
      <>
        {resendError && <Alert>{resendError}</Alert>}
        <CheckPanel label="Unconfirmed stock entry"
          onCheck={async () => {
            const items = await stock.savedByKey(op.requestKey);
            if (!items) {
              return restored
                ? 'Not recorded so far. It may still be on its way. Give it up to make sure it never is, then add the units again.'
                : 'Not recorded so far. It may still be on its way. Sending the same entry again is safe: it is never added twice.';
            }
            await recorded(op, items);
            return null;
          }}
          resend={restored ? undefined : {
            label: 'Send the same entry again', busy: busy && !givingUp,
            onClick: () => { setResendError(null); void sendEntry(op, '').catch((err: unknown) => setResendError(messageOf(err))); },
          }}
          giveUp={{ label: 'Give this up', busy: givingUp, onClick: () => void giveUp(op) }}>
          <Alert tone="warn">
            {restored
              ? 'A stock entry made earlier on this device (before the page was reloaded, or before you signed out) was not confirmed. Its details are not kept here. Check it, or give it up: then it can never be added.'
              : `This stock entry was not confirmed${op.error ? ` (${op.error})` : ''}. The units may already be in stock. Sending the same entry again is safe: it is never added twice. Or give it up: then it can never be added.`}
          </Alert>
          {!restored && op.body && <div>{describeOp(op.body)}</div>}
        </CheckPanel>
      </>
    );
  }

  return (
    <>
      {notice && <Alert tone="ok">{notice}</Alert>}
      {done && (
        <Alert tone="ok">
          {done.text}{' '}
          <Link to={done.search ? `/pharmacy/stock?q=${encodeURIComponent(done.search)}` : '/pharmacy/stock'}>See it in Stock</Link>
        </Alert>
      )}
      <section className="ws-section" aria-labelledby="med-h">
        <h2 id="med-h">Medicine</h2>
        {chosen ? (
          <div className="ws-actions">
            <strong>{medicineName(chosen)}</strong>
            {chosen.dosageForm && <span className="ws-muted">{chosen.dosageForm}</span>}
            {chosen.manufacturer && <span className="ws-muted">{chosen.manufacturer}</span>}
            <Button variant="ghost" disabled={!!review || busy} onClick={changeMedicine}>Change medicine</Button>
          </div>
        ) : presetMissing ? (
          <>
            <Alert tone="warn">Medicine not found — pick another.</Alert>
            <MedicinePicker pharmacyId={pharmacyId} error={errors.medicineId} onChoose={(m) => { setPicked(m); setParams({}, { replace: true }); setErrors((e) => ({ ...e, medicineId: undefined })); }} />
          </>
        ) : preset && presetQ.isPending ? <Loading label="Loading medicine…" />
          : preset && presetQ.isError ? <ErrorState message={messageOf(presetQ.error)} onRetry={() => void presetQ.refetch()} />
          : <MedicinePicker pharmacyId={pharmacyId} error={errors.medicineId} onChoose={(m) => { setPicked(m); setErrors((e) => ({ ...e, medicineId: undefined })); }} />}
      </section>

      <form className="rx-form ws-section" noValidate aria-labelledby="batch-h" onSubmit={check}>
        <h2 id="batch-h">Batch</h2>
        <fieldset className="ws-frozen" disabled={!!review || busy}>
          <div className="rx-form-row">
            <TextField label="Batch number" value={draft.batchNumber} maxLength={STOCK_LIMITS.batchNumber} error={errors.batchNumber}
              hint="As printed on the pack. Saved in capital letters." onChange={(e) => set('batchNumber', e.target.value)} />
            <TextField label="Expiry date" type="date" value={draft.expiry} error={errors.expiry} onChange={(e) => set('expiry', e.target.value)} />
            <TextField label="Units received" inputMode="numeric" value={draft.quantity} error={errors.quantity}
              onChange={(e) => set('quantity', e.target.value.replace(/\D/g, ''))} />
          </div>
          <div className="rx-form-row">
            <TextField label="MRP per unit (₹, optional)" inputMode="decimal" value={draft.mrp} error={errors.mrp} onChange={(e) => set('mrp', e.target.value)} />
            <TextField label="Selling price per unit (₹, optional)" inputMode="decimal" value={draft.retailPrice} error={errors.retailPrice}
              hint="What customers pay. Left empty, the current price stays." onChange={(e) => set('retailPrice', e.target.value)} />
            <TextField label="Purchase price per unit (₹, optional)" inputMode="decimal" value={draft.purchasePrice} error={errors.purchasePrice}
              onChange={(e) => set('purchasePrice', e.target.value)} />
          </div>
          <div className="rx-form-row">
            <TextField label="Rack (optional)" value={draft.rackLocation} maxLength={STOCK_LIMITS.rackLocation} error={errors.rackLocation}
              onChange={(e) => set('rackLocation', e.target.value)} />
            <TextField label="Reorder when stock falls to (optional)" inputMode="numeric" value={draft.reorderThreshold} error={errors.reorderThreshold}
              onChange={(e) => set('reorderThreshold', e.target.value.replace(/\D/g, ''))} />
            <div className="j-field">
              <label htmlFor="stock-reason">Why is it added?</label>
              <select id="stock-reason" value={draft.reason} onChange={(e) => set('reason', e.target.value as AddStockReason)}>
                {ADD_STOCK_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>
          </div>
          <div className="rx-form-row">
            {suppliers.isError ? (
              <Alert tone="warn">Your suppliers could not be read ({messageOf(suppliers.error)}). You can add the stock without one.</Alert>
            ) : (
              <SupplierSelect id="stock-supplier" label="Supplier (optional)" suppliers={supplierList} value={draft.supplierId ?? ''}
                noneLabel={suppliers.isPending ? 'Loading suppliers…' : 'Not said'} error={errors.supplierId}
                hint={supplierList.length === 0 && !suppliers.isPending ? 'You have no active suppliers. Add them on the Suppliers page.' : 'Who delivered these units. Shown in the stock history.'}
                onChange={(v) => { set('supplierId', v); setErrors((e) => ({ ...e, supplierId: undefined })); }} />
            )}
          </div>
          <TextArea label="Note (optional)" value={draft.note} maxLength={MAX_STOCK_NOTE} error={errors.note}
            hint="For example the supplier’s bill number." onChange={(e) => set('note', e.target.value)} />
        </fieldset>
        {refused && <Alert>Not added: {refused}</Alert>}
        {!review && <div><Button type="submit">Check and add</Button></div>}
      </form>

      {review && (
        <div className="confirm" role="group" aria-label="Add this stock">
          <div className="confirm-text">Add {describe(review.entry, review.medicineName)}?</div>
          <ul className="ws-list">
            {review.entry.mrp !== undefined && <li>MRP {formatRupees(review.entry.mrp)}</li>}
            {review.entry.retailPrice !== undefined && <li>Selling price {formatRupees(review.entry.retailPrice)}</li>}
            {review.entry.purchasePrice !== undefined && <li>Purchase price {formatRupees(review.entry.purchasePrice)}</li>}
            {review.entry.rackLocation && <li>Rack {review.entry.rackLocation}</li>}
            {review.entry.reorderThreshold !== undefined && <li>Reorder at {review.entry.reorderThreshold}</li>}
            <li>Supplier: {review.supplierName ?? 'not said'}</li>
            <li>{ADD_STOCK_REASONS.find((r) => r.value === review.entry.reason)?.label}</li>
          </ul>
          <span className="ws-muted">The units are on sale once added if the medicine has a selling price (without one it is not on sale until priced). The workspace cannot take them out again, so check the number.</span>
          <div className="confirm-actions">
            <Button busy={busy} onClick={() => void add()}>Yes, add to stock</Button>
            <Button variant="ghost" disabled={busy} onClick={() => setReview(null)}>Back</Button>
          </div>
        </div>
      )}
      <StockHistory pharmacyId={pharmacyId} suppliers={supplierList} />
    </>
  );
}

const SOURCE_LABEL: Readonly<Record<NonNullable<StockAdjustment['sourceType']>, string>> = {
  manual: 'Added by hand', inventory_import: 'Import', order: 'Order',
};
const HISTORY_SIZE = 20;

/** WQ11c: the latest stock changes (`GET /pharmacy-inventory/adjustments`, newest first) with each delivery's supplier. */
function StockHistory({ pharmacyId, suppliers }: { pharmacyId: string; suppliers: readonly PharmacySupplier[] }) {
  const { api } = useSession();
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['pharmacy-inventory', pharmacyId, 'adjustments', page],
    queryFn: () => pharmacyStockApi(api).adjustments(page, HISTORY_SIZE),
  });
  const supplierOf = (a: StockAdjustment) =>
    a.supplier?.displayName ?? (a.supplierId ? suppliers.find((s) => s.supplierId === String(a.supplierId).toLowerCase())?.displayName ?? 'A supplier' : '—');
  return (
    <section className="ws-section" aria-labelledby="hist-h">
      <h2 id="hist-h">Stock history</h2>
      {q.isPending ? <Loading label="Loading stock history…" />
        : q.isError && q.data === undefined ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : q.data.items.length === 0 ? <Empty title="No stock changes yet">Stock you add, import or sell is listed here.</Empty>
        : (
          <>
            <div className="ws-table-wrap">
              <table className="j-table">
                <caption className="j-sr-only">Stock changes, newest first</caption>
                <thead>
                  <tr><th scope="col">When</th><th scope="col">Medicine</th><th scope="col">Change</th><th scope="col">Batch</th><th scope="col">Supplier</th><th scope="col">How</th></tr>
                </thead>
                <tbody>
                  {q.data.items.map((a) => (
                    <tr key={a._id}>
                      <td>{formatDateTime(a.createdAt)}</td>
                      <td>{medicineName(a.medicineId as InventoryItem['medicineId'])}</td>
                      <td>{a.adjustmentType === 'remove' ? `−${a.quantity}` : a.adjustmentType === 'add' ? `+${a.quantity}` : `set ${a.quantity}`}</td>
                      <td>{a.batchNumber ? `${a.batchNumber}${a.expiryDate ? ` · ${formatExpiry(a.expiryDate)}` : ''}` : '—'}</td>
                      <td>{supplierOf(a)}</td>
                      <td>{a.sourceType ? SOURCE_LABEL[a.sourceType] ?? a.sourceType : '—'}{a.notes ? <div className="ws-muted">{a.notes}</div> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {q.data.totalPages > 1 && (
              <nav className="ws-pager" aria-label="Stock history pages">
                <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Newer</Button>
                <span>Page {page} of {q.data.totalPages}</span>
                <Button variant="secondary" disabled={page >= q.data.totalPages} onClick={() => setPage(page + 1)}>Older</Button>
              </nav>
            )}
          </>
        )}
    </section>
  );
}

function MedicinePicker({ pharmacyId, error, onChoose }: { pharmacyId: string; error?: string; onChoose: (m: Medicine) => void }) {
  const { api } = useSession();
  const [text, setText] = useState('');
  const [search, setSearch] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['pharmacy-medicines', pharmacyId, 'search', search],
    queryFn: () => pharmacyStockApi(api).medicines(search ?? ''),
    enabled: search !== null,
  });
  const go = () => { if (text.trim()) setSearch(text.trim()); };
  return (
    <>
      <div className="ws-search">
        <TextField label="Find the medicine" value={text} error={error} placeholder="Name, brand or generic name"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } }} />
        <Button type="button" variant="secondary" onClick={go}>Search</Button>
      </div>
      {search === null ? null
        : q.isPending ? <Loading label="Searching medicines…" />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : q.data.items.length === 0 ? (
          <Empty title={`No medicine matches “${search}”`}>
            A medicine that is not in the list yet is added by <Link to="/pharmacy/stock/import">importing a file</Link> with its name.
          </Empty>
        ) : (
          <ul className="ws-list" aria-label="Medicines found">
            {q.data.items.map((m) => (
              <li key={m._id} className="ws-actions">
                <span>{medicineName(m)}{m.dosageForm ? ` · ${m.dosageForm}` : ''}{m.manufacturer ? ` · ${m.manufacturer}` : ''}</span>
                <Button variant="secondary" aria-label={`Choose ${medicineName(m)}`} onClick={() => onChoose(m)}>Choose</Button>
              </li>
            ))}
            {q.data.total > q.data.items.length && (
              <li className="ws-muted">Showing {q.data.items.length} of {q.data.total}. Type more of the name to narrow the list.</li>
            )}
          </ul>
        )}
    </>
  );
}
