import { useRef, useState, type FormEvent } from 'react';
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
import { t } from '../../i18n/pharmacy/index.ts';

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
      <Link to="/pharmacy/stock" className="ws-back"><ArrowLeft size={16} aria-hidden="true" />{t('common.stock')}</Link>
      <PageHeading title={t('common.addStock')}>{t('addStock.addTheUnitsOfOne')}<Link to="/pharmacy/stock/import">{t('addStock.importAFile')}</Link>.
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

  /**
   * WQ11d: the confirmation is shown at once from the save's answer (the form is cleared in the same step, so nothing can
   * be entered again under a new key meanwhile); a supplier is named only once the recorded delivery says so, the line
   * saying "checking the supplier…" until then.
   */
  const shown = useRef(0);
  function showAdded(p: PendingOp<PendingEntry>, words: (what: string) => string, search: string) {
    const mine = ++shown.current;
    const b = p.body;
    const base = b ? describe(b.entry, b.medicineName) : 'the units';
    const checking = !!b?.entry.supplierId;
    setDone({ text: words(checking ? `${base} (checking the supplier…)` : base), search });
    if (checking) {
      void savedWords(readAdjustments, p).then((what) => {
        if (shown.current === mine) setDone((d) => (d ? { ...d, text: words(what) } : d));
      });
    }
  }

  /** Sends `p` (its key, its entry) under the one-at-a-time guard; an unknown outcome stays stored for the panel below. */
  async function sendEntry(p: PendingOp<PendingEntry>, search: string) {
    const r = await perform(() => send(p, (b) => stock.addStock(b.entry, p.requestKey)));
    if (r.kind === 'stale') return;
    setReview(null);
    if (r.kind === 'unknown' && wasAbandoned(r.error)) {
      // Given up meanwhile (e.g. in another tab): the server says this key can never add anything.
      settle(p.requestKey);
      setNotice(t('addStock.thisEntryWasGivenUp'));
      return;
    }
    if (r.kind === 'ok') {
      setDraft(EMPTY);
      setErrors({});
      void refresh();
      const replayed = !!r.value.replayed;
      showAdded(p, (what) => (replayed ? t('addStock.alreadyAddedNothingWasAdded', { what }) : t('addStock.added', { what })), search || itemSearch(r.value.items));
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
    showAdded(p, (what) => t('addStock.recordedWasAddedNothingWas', { what }), itemSearch(items));
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
      setNotice(t('addStock.givenUpNothingWasAdded'));
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
        <CheckPanel label={t('addStock.unconfirmedStockEntry')}
          onCheck={async () => {
            const items = await stock.savedByKey(op.requestKey);
            if (!items) {
              return restored
                ? t('addStock.notRecordedSoFarIt')
                : t('addStock.notRecordedSoFarIt2');
            }
            await recorded(op, items);
            return null;
          }}
          resend={restored ? undefined : {
            label: t('addStock.sendTheSameEntryAgain'), busy: busy && !givingUp,
            onClick: () => { setResendError(null); void sendEntry(op, '').catch((err: unknown) => setResendError(messageOf(err))); },
          }}
          giveUp={{ label: t('common.giveThisUp'), busy: givingUp, onClick: () => void giveUp(op) }}>
          <Alert tone="warn">
            {restored
              ? t('addStock.aStockEntryMadeEarlier')
              : t('addStock.thisStockEntryWasNot', { value: op.error ? ` (${op.error})` : '' })}
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
          <Link to={done.search ? `/pharmacy/stock?q=${encodeURIComponent(done.search)}` : '/pharmacy/stock'}>{t('addStock.seeItInStock')}</Link>
        </Alert>
      )}
      <section className="ws-section" aria-labelledby="med-h">
        <h2 id="med-h">{t('common.medicine')}</h2>
        {chosen ? (
          <div className="ws-actions">
            <strong>{medicineName(chosen)}</strong>
            {chosen.dosageForm && <span className="ws-muted">{chosen.dosageForm}</span>}
            {chosen.manufacturer && <span className="ws-muted">{chosen.manufacturer}</span>}
            <Button variant="ghost" disabled={!!review || busy} onClick={changeMedicine}>{t('addStock.changeMedicine')}</Button>
          </div>
        ) : presetMissing ? (
          <>
            <Alert tone="warn">{t('addStock.medicineNotFoundPickAnother')}</Alert>
            <MedicinePicker pharmacyId={pharmacyId} error={errors.medicineId} onChoose={(m) => { setPicked(m); setParams({}, { replace: true }); setErrors((e) => ({ ...e, medicineId: undefined })); }} />
          </>
        ) : preset && presetQ.isPending ? <Loading label={t('addStock.loadingMedicine')} />
          : preset && presetQ.isError ? <ErrorState message={messageOf(presetQ.error)} onRetry={() => void presetQ.refetch()} />
          : <MedicinePicker pharmacyId={pharmacyId} error={errors.medicineId} onChoose={(m) => { setPicked(m); setErrors((e) => ({ ...e, medicineId: undefined })); }} />}
      </section>

      <form className="rx-form ws-section" noValidate aria-labelledby="batch-h" onSubmit={check}>
        <h2 id="batch-h">{t('common.batch')}</h2>
        <fieldset className="ws-frozen" disabled={!!review || busy}>
          <div className="rx-form-row">
            <TextField label={t('addStock.batchNumber')} value={draft.batchNumber} maxLength={STOCK_LIMITS.batchNumber} error={errors.batchNumber}
              hint={t('addStock.asPrintedOnThePack')} onChange={(e) => set('batchNumber', e.target.value)} />
            <TextField label={t('common.expiryDate')} type="date" value={draft.expiry} error={errors.expiry} onChange={(e) => set('expiry', e.target.value)} />
            <TextField label={t('addStock.unitsReceived')} inputMode="numeric" value={draft.quantity} error={errors.quantity}
              onChange={(e) => set('quantity', e.target.value.replace(/\D/g, ''))} />
          </div>
          <div className="rx-form-row">
            <TextField label={t('addStock.mrpPerUnitOptional')} inputMode="decimal" value={draft.mrp} error={errors.mrp} onChange={(e) => set('mrp', e.target.value)} />
            <TextField label={t('addStock.sellingPricePerUnitOptional')} inputMode="decimal" value={draft.retailPrice} error={errors.retailPrice}
              hint={t('addStock.whatCustomersPayLeftEmpty')} onChange={(e) => set('retailPrice', e.target.value)} />
            <TextField label={t('addStock.purchasePricePerUnitOptional')} inputMode="decimal" value={draft.purchasePrice} error={errors.purchasePrice}
              onChange={(e) => set('purchasePrice', e.target.value)} />
          </div>
          <div className="rx-form-row">
            <TextField label={t('addStock.rackOptional')} value={draft.rackLocation} maxLength={STOCK_LIMITS.rackLocation} error={errors.rackLocation}
              onChange={(e) => set('rackLocation', e.target.value)} />
            <TextField label={t('addStock.reorderWhenStockFallsTo')} inputMode="numeric" value={draft.reorderThreshold} error={errors.reorderThreshold}
              onChange={(e) => set('reorderThreshold', e.target.value.replace(/\D/g, ''))} />
            <div className="j-field">
              <label htmlFor="stock-reason">{t('addStock.whyIsItAdded')}</label>
              <select id="stock-reason" value={draft.reason} onChange={(e) => set('reason', e.target.value as AddStockReason)}>
                {ADD_STOCK_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>
          </div>
          <div className="rx-form-row">
            {suppliers.isError ? (
              <Alert tone="warn">{t('common.yourSuppliersCouldNotBe')}{messageOf(suppliers.error)}{t('addStock.youCanAddTheStock')}</Alert>
            ) : (
              <SupplierSelect id="stock-supplier" label={t('addStock.supplierOptional')} suppliers={supplierList} value={draft.supplierId ?? ''}
                noneLabel={suppliers.isPending ? t('common.loadingSuppliers') : t('common.notSaid')} error={errors.supplierId}
                hint={supplierList.length === 0 && !suppliers.isPending ? t('addStock.youHaveNoActiveSuppliers') : t('addStock.whoDeliveredTheseUnitsShown')}
                onChange={(v) => { set('supplierId', v); setErrors((e) => ({ ...e, supplierId: undefined })); }} />
            )}
          </div>
          <TextArea label={t('addStock.noteOptional')} value={draft.note} maxLength={MAX_STOCK_NOTE} error={errors.note}
            hint={t('addStock.forExampleTheSupplierS')} onChange={(e) => set('note', e.target.value)} />
        </fieldset>
        {refused && <Alert>{t('addStock.notAdded')}{refused}</Alert>}
        {!review && <div><Button type="submit">{t('addStock.checkAndAdd')}</Button></div>}
      </form>

      {review && (
        <div className="confirm" role="group" aria-label={t('addStock.addThisStock')}>
          <div className="confirm-text">{t('addStock.add')}{describe(review.entry, review.medicineName)}?</div>
          <ul className="ws-list">
            {review.entry.mrp !== undefined && <li>{t('addStock.mrp')}{formatRupees(review.entry.mrp)}</li>}
            {review.entry.retailPrice !== undefined && <li>{t('addStock.sellingPrice')}{formatRupees(review.entry.retailPrice)}</li>}
            {review.entry.purchasePrice !== undefined && <li>{t('addStock.purchasePrice')}{formatRupees(review.entry.purchasePrice)}</li>}
            {review.entry.rackLocation && <li>{t('addStock.rack')}{review.entry.rackLocation}</li>}
            {review.entry.reorderThreshold !== undefined && <li>{t('addStock.reorderAt')}{review.entry.reorderThreshold}</li>}
            <li>{t('addStock.supplier')}{review.supplierName ?? 'not said'}</li>
            <li>{ADD_STOCK_REASONS.find((r) => r.value === review.entry.reason)?.label}</li>
          </ul>
          <span className="ws-muted">{t('addStock.theUnitsAreOnSale')}</span>
          <div className="confirm-actions">
            <Button busy={busy} onClick={() => void add()}>{t('addStock.yesAddToStock')}</Button>
            <Button variant="ghost" disabled={busy} onClick={() => setReview(null)}>{t('common.back')}</Button>
          </div>
        </div>
      )}
      <StockHistory pharmacyId={pharmacyId} suppliers={supplierList} />
    </>
  );
}

const SOURCE_LABEL = (): Readonly<Record<NonNullable<StockAdjustment['sourceType']>, string>> => ({
  manual: t('addStock.addedByHand'), inventory_import: 'Import', order: 'Order',
});
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
    a.supplier?.displayName ?? (a.supplierId ? suppliers.find((s) => s.supplierId === String(a.supplierId).toLowerCase())?.displayName ?? t('common.aSupplier') : '—');
  return (
    <section className="ws-section" aria-labelledby="hist-h">
      <h2 id="hist-h">{t('addStock.stockHistory')}</h2>
      {q.isPending ? <Loading label={t('addStock.loadingStockHistory')} />
        : q.isError && q.data === undefined ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : q.data.items.length === 0 ? <Empty title={t('addStock.noStockChangesYet')}>{t('addStock.stockYouAddImportOr')}</Empty>
        : (
          <>
            <div className="ws-table-wrap">
              <table className="j-table">
                <caption className="j-sr-only">{t('addStock.stockChangesNewestFirst')}</caption>
                <thead>
                  <tr><th scope={'col'}>{t('common.when')}</th><th scope={'col'}>{t('common.medicine')}</th><th scope={'col'}>{t('common.change')}</th><th scope={'col'}>{t('common.batch')}</th><th scope={'col'}>{t('common.supplier')}</th><th scope={'col'}>{t('common.how')}</th></tr>
                </thead>
                <tbody>
                  {q.data.items.map((a) => (
                    <tr key={a._id}>
                      <td>{formatDateTime(a.createdAt)}</td>
                      <td>{medicineName(a.medicineId as InventoryItem['medicineId'])}</td>
                      <td>{a.adjustmentType === 'remove' ? `−${a.quantity}` : a.adjustmentType === 'add' ? `+${a.quantity}` : `set ${a.quantity}`}</td>
                      <td>{a.batchNumber ? `${a.batchNumber}${a.expiryDate ? ` · ${formatExpiry(a.expiryDate)}` : ''}` : '—'}</td>
                      <td>{supplierOf(a)}</td>
                      <td>{a.sourceType ? SOURCE_LABEL()[a.sourceType] ?? a.sourceType : '—'}{a.notes ? <div className="ws-muted">{a.notes}</div> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {q.data.totalPages > 1 && (
              <nav className="ws-pager" aria-label={t('addStock.stockHistoryPages')}>
                <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>{t('common.newer')}</Button>
                <span>{t('common.page')}{page}{t('common.of')}{q.data.totalPages}</span>
                <Button variant="secondary" disabled={page >= q.data.totalPages} onClick={() => setPage(page + 1)}>{t('common.older')}</Button>
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
        <TextField label={t('addStock.findTheMedicine')} value={text} error={error} placeholder={t('common.nameBrandOrGenericName')}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } }} />
        <Button type="button" variant="secondary" onClick={go}>{t('common.search')}</Button>
      </div>
      {search === null ? null
        : q.isPending ? <Loading label={t('common.searchingMedicines')} />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : q.data.items.length === 0 ? (
          <Empty title={t('addStock.noMedicineMatches', { search })}>{t('addStock.aMedicineThatIsNot')}<Link to="/pharmacy/stock/import">{t('addStock.importingAFile')}</Link>{t('addStock.withItsName')}</Empty>
        ) : (
          <ul className="ws-list" aria-label={t('addStock.medicinesFound')}>
            {q.data.items.map((m) => (
              <li key={m._id} className="ws-actions">
                <span>{medicineName(m)}{m.dosageForm ? ` · ${m.dosageForm}` : ''}{m.manufacturer ? ` · ${m.manufacturer}` : ''}</span>
                <Button variant="secondary" aria-label={t('common.choose', { value: medicineName(m) })} onClick={() => onChoose(m)}>{t('common.choose2')}</Button>
              </li>
            ))}
            {q.data.total > q.data.items.length && (
              <li className="ws-muted">{t('common.showing')}{q.data.items.length}{t('common.of')}{q.data.total}{t('addStock.typeMoreOfTheName')}</li>
            )}
          </ul>
        )}
    </>
  );
}
