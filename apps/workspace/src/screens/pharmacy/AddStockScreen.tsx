import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import {
  ADD_STOCK_REASONS, formatExpiry, MAX_STOCK_NOTE, medicineName, pharmacyStockApi, STOCK_LIMITS, stockEntryBody,
  stockEntryProblems, type AddStockReason, type InventoryItem, type Medicine, type StockEntry, type StockEntryDraft,
} from '@jansetu/api';
import { Alert, Button, Empty, ErrorState, formatRupees, Loading, TextArea, TextField } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { newRequestKey, startOp, type PendingOp } from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { useOneAtATime } from '../finance/finance.tsx';
import { CheckPanel, useOwnedOp, usePharmacyId } from './ownedOp.tsx';

/**
 * What is kept (in session memory only) for an entry being sent: the request and the words to describe it. Q15: it is
 * sent with its request key, so the same entry can be sent again safely (the server answers the key with what it saved,
 * `replayed`, and never adds the units twice) and a lost answer is looked up by key.
 */
interface PendingEntry { entry: StockEntry; medicineName: string }

type Fields = Omit<StockEntryDraft, 'medicineId'>;
const EMPTY: Fields = {
  batchNumber: '', expiry: '', quantity: '', mrp: '', retailPrice: '', purchasePrice: '', rackLocation: '', reorderThreshold: '',
  reason: 'purchase', note: '',
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

const describe = (e: StockEntry, name: string) =>
  `${e.quantity} units of ${name}, batch ${e.batchNumber.toUpperCase()} (expires ${formatExpiry(e.expiryDate)})`;

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
  const [picked, setPicked] = useState<Medicine | null>(null);
  const [draft, setDraft] = useState<Fields>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<keyof StockEntryDraft, string>>>({});
  const [review, setReview] = useState<{ requestKey: string } & PendingEntry | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [done, setDone] = useState<{ text: string; search: string } | null>(null);

  // "Add a batch" on the Stock page names the medicine (its id only).
  const preset = params.get('medicine') ?? '';
  const presetQ = useQuery({
    queryKey: ['pharmacy-medicines', pharmacyId, 'one', preset],
    queryFn: () => stock.medicine(preset),
    enabled: /^[0-9a-fA-F]{24}$/.test(preset),
  });
  const chosen = picked ?? (preset ? presetQ.data ?? null : null);

  const set = <K extends keyof Fields>(k: K, v: Fields[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['pharmacy-inventory'] });

  function check(e: FormEvent) {
    e.preventDefault();
    setDone(null);
    setRefused(null);
    const full: StockEntryDraft = { ...draft, medicineId: chosen?._id ?? '' };
    const problems = stockEntryProblems(full);
    setErrors(problems);
    if (Object.keys(problems).length || !chosen) return;
    setReview({ requestKey: newRequestKey(), entry: stockEntryBody(full), medicineName: medicineName(chosen) });
  }

  /** Sends `p` (its key, its entry) under the one-at-a-time guard; an unknown outcome stays stored for the panel below. */
  async function sendEntry(p: PendingOp<PendingEntry>, search: string) {
    const r = await perform(() => send(p, (b) => stock.addStock(b.entry, p.requestKey)));
    if (r.kind === 'stale') return;
    setReview(null);
    if (r.kind === 'ok') {
      const what = p.body ? describe(p.body.entry, p.body.medicineName) : 'the units';
      setDone({
        text: r.value.replayed ? `Already added: ${what}. Nothing was added twice.` : `Added ${what}.`,
        search: search || itemSearch(r.value.items),
      });
      setDraft(EMPTY);
      setErrors({});
      void refresh();
    } else if (r.kind === 'refused') {
      setRefused(messageOf(r.error));
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

  if (op && !busy) {
    const restored = !!op.restored || !op.body;
    return (
      <>
        {resendError && <Alert>{resendError}</Alert>}
        <CheckPanel label="Unconfirmed stock entry"
          onCheck={async () => {
            const items = await stock.savedByKey(op.requestKey);
            if (!items) {
              return restored
                ? 'Not recorded so far. It may still be on its way: this cannot be told apart from here.'
                : 'Not recorded so far. It may still be on its way. Sending the same entry again is safe: it is never added twice.';
            }
            settle(op.requestKey);
            setDone({
              text: `Recorded: ${op.body ? describe(op.body.entry, op.body.medicineName) : 'the stock entry'} was added. Nothing was added twice.`,
              search: itemSearch(items),
            });
            void refresh();
            return null;
          }}
          resend={restored ? undefined : {
            label: 'Send the same entry again', busy,
            onClick: () => { setResendError(null); void sendEntry(op, '').catch((err: unknown) => setResendError(messageOf(err))); },
          }}
          forget={{
            label: 'Forget it and add again', confirmLabel: 'Forget it',
            consequence: restored
              ? 'Only do this if the batch in Stock does not show these units. If the earlier entry still arrives, its units are added then and would be counted twice; you would have to ask the Jansetu team to correct it.'
              : 'Sending the same entry again is the safe choice. If you forget it and the earlier entry still arrives, its units are added then and would be counted twice; you would have to ask the Jansetu team to correct it.',
            onForget: () => settle(op.requestKey),
          }}>
          <Alert tone="warn">
            {restored
              ? 'A stock entry made earlier on this device (before the page was reloaded, or before you signed out) was not confirmed. Its details are not kept here.'
              : `This stock entry was not confirmed${op.error ? ` (${op.error})` : ''}. The units may already be in stock. Sending the same entry again is safe: it is never added twice.`}
          </Alert>
          {!restored && op.body && <div>{describe(op.body.entry, op.body.medicineName)}</div>}
        </CheckPanel>
      </>
    );
  }

  return (
    <>
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
            <li>{ADD_STOCK_REASONS.find((r) => r.value === review.entry.reason)?.label}</li>
          </ul>
          <span className="ws-muted">The units go on sale at once. The workspace cannot take them out again, so check the number.</span>
          <div className="confirm-actions">
            <Button busy={busy} onClick={() => void add()}>Yes, add to stock</Button>
            <Button variant="ghost" disabled={busy} onClick={() => setReview(null)}>Back</Button>
          </div>
        </div>
      )}
    </>
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
