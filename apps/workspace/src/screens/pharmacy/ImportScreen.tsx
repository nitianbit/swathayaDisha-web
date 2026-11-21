import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useParams } from 'react-router';
import { ArrowLeft, Download } from 'lucide-react';
import {
  formatExpiry, IMPORT_MODES, IMPORT_ROW_STATUS_LABEL, IMPORT_STATUS_LABEL, importCommittable, importPlan, importRetryable, importSettled,
  importStuck, importZeroPrices, isImportClaimed, monthFirstRows, pharmacyStockApi, recentSameFile, type ImportRow, type InventoryImport,
  IMPORT_DATE_FORMAT, allSuppliers, importLeavesUnpriced, importPriceView, IMPORT_PRICE_FIELDS, TEMPLATE_EXAMPLE_MARK, type ImportPriceView,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, formatDateTime, formatRupees, Loading } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { newRequestKey, startOp, type PendingOp } from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { useOneAtATime } from '../finance/finance.tsx';
import { RefreshFailed, useTicker } from '../doctor/doctor.tsx';
import { importTone } from './ImportStockScreen.tsx';
import { CheckPanel, useDiscarded, useOwnedOp, usePharmacyId } from './ownedOp.tsx';

/**
 * The step being sent for this import: adding its ready rows, or trying its failed rows again. A retry keeps the
 * outcome on screen when it was sent (`since`: the import's `updatedAt`), so only another outcome settles it.
 */
interface PendingStep { kind: 'commit' | 'retry'; importId: string; since?: string }

/** Navigation state from the file check: the supplier chosen for the whole file (to tell whether the server kept it). */
export interface ImportArrival { supplierAsked?: string }

/**
 * The kind of a stored step. A commit is stored under the import's id as its key, a retry under a new key: so a marker
 * restored after a reload (no body) still says which it was.
 */
const stepKind = (p: PendingOp<PendingStep>, importId: string): PendingStep['kind'] => p.body?.kind ?? (p.requestKey === importId ? 'commit' : 'retry');

/**
 * Whether the import as read now settles the stored step: it finished adding, and (for a retry, whose import had an
 * outcome before it was sent) the outcome is another one. WQ11c re-review N6: with the outcome on screen when the retry
 * was sent (`since`), only a different one written after the retry was first sent (30 s for clocks) settles it; without
 * it (a marker restored after a reload) the outcome must be strictly later than the first send, with no allowance.
 */
function settles(p: PendingOp<PendingStep>, r: InventoryImport): boolean {
  if (!importSettled(r.status)) return false;
  if (stepKind(p, r._id) === 'commit') return true;
  const stamp = r.updatedAt ?? r.committedAt ?? '';
  const at = Date.parse(stamp);
  if (!Number.isFinite(at)) return false;
  if (p.body?.since !== undefined) return stamp !== p.body.since && at >= p.firstAttemptAt - 30_000;
  return at > p.firstAttemptAt;
}


/** WQ10a: one stock import: its checked rows, the confirmation that adds them, and what happened. */
export function ImportScreen() {
  const { importId = '' } = useParams();
  const pharmacyId = usePharmacyId();
  const back = <Link to="/pharmacy/stock/import" className="ws-back"><ArrowLeft size={16} aria-hidden="true" /> Import stock</Link>;
  if (!/^[0-9a-fA-F]{24}$/.test(importId)) return <>{back}<Empty title="Import not found">Open it from the list of recent imports.</Empty></>;
  return <>{back}<ImportLoader key={`${pharmacyId}:${importId}`} pharmacyId={pharmacyId} importId={importId} /></>;
}

const importKey = (pharmacyId: string, importId: string) => ['pharmacy-inventory', pharmacyId, 'imports', 'one', importId];

function ImportLoader({ pharmacyId, importId }: { pharmacyId: string; importId: string }) {
  const { api } = useSession();
  const q = useQuery({
    queryKey: importKey(pharmacyId, importId),
    queryFn: () => pharmacyStockApi(api).import(importId),
    // While rows are being added, read again until it is done.
    refetchInterval: (query) => (query.state.data?.status === 'committing' ? 5_000 : false),
  });
  if (q.isPending) return <Loading label="Loading import…" />;
  if (q.isError && q.data === undefined) return <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />;
  // WQ11c re-review N5: a failed read again keeps the import on screen, with a quiet note. A read that failed is never
  // taken as the import as it is now (a check says it could not check).
  return (
    <>
      {q.isError && <RefreshFailed error={q.error} readAt={q.dataUpdatedAt} onRetry={q.refetch} />}
      <ImportView pharmacyId={pharmacyId} record={q.data}
        reread={() => q.refetch().then((r) => { if (r.isError) throw r.error; return r.data; })} />
    </>
  );
}

function ImportView({ pharmacyId, record, reread }: {
  pharmacyId: string; record: InventoryImport; reread: () => Promise<InventoryImport | undefined>;
}) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const stock = pharmacyStockApi(api);
  const { op, send, settle } = useOwnedOp<PendingStep>(`stock-import:${pharmacyId}:${record._id}`);
  const { perform, busy } = useOneAtATime('import');
  const [notice, setNotice] = useState<string | null>(null);
  const discarded = useDiscarded(pharmacyId);
  const arrival = (useLocation().state ?? null) as ImportArrival | null;
  const now = useTicker(30_000);
  const stuck = importStuck(record, now.getTime());
  const rows = record.previewRows ?? [];
  const plan = importPlan(record);
  const problemRows = rows.filter((r) => r.status === 'error' || r.status === 'failed').length;
  const isDiscarded = record.status === 'previewed' && discarded.ids.includes(record._id);
  // WQ11c: another import of this file name added in the last 24 hours (the same delivery imported twice?).
  const others = useQuery({
    queryKey: ['pharmacy-inventory', pharmacyId, 'imports', 1],
    queryFn: () => stock.imports(1, 20),
    enabled: record.status === 'previewed',
  });
  const twin = record.status === 'previewed' && others.data ? recentSameFile(record, others.data.items, now.getTime()) : null;
  // Q16c: the import keeps the file's supplier as an id; its name comes from the supplier list (archived ones too).
  const suppliers = useQuery({
    queryKey: ['pharmacy-suppliers', pharmacyId, 'all-names'],
    queryFn: () => allSuppliers(api, 'all'),
    enabled: !!(record.supplierId && !record.supplier),
  });
  const fileSupplier = record.supplier?.displayName
    ?? (record.supplierId ? suppliers.data?.find((x) => x.supplierId === String(record.supplierId).toLowerCase())?.displayName ?? 'A supplier' : null);
  const monthFirst = monthFirstRows(rows);

  const changed = (r: InventoryImport) => {
    queryClient.setQueryData(importKey(pharmacyId, record._id), r);
    void queryClient.invalidateQueries({ queryKey: ['pharmacy-inventory'] });
  };
  const outcome = (r: InventoryImport) => {
    const skipped = (r.previewRows ?? []).filter((x) => x.status === 'skipped').length;
    const skip = skipped > 0 ? ` ${skipped} ${skipped === 1 ? 'row was' : 'rows were'} skipped by the rows you chose to add.` : '';
    return r.status === 'committed' ? `Done: ${r.committedRows ?? 0} rows were added to stock.${skip}`
      : r.status === 'partially_committed' ? `Partly done: ${r.committedRows ?? 0} rows were added; ${r.failedRows ?? 0} were not.${skip} See the rows below.`
      : r.status === 'failed' ? 'No row was added. See the problems below.'
      : null;
  };

  /** Settles the stored step from the import as the server has it now; answers what is still unknown. */
  async function checkStep(p: PendingOp<PendingStep>): Promise<string | null> {
    const fresh = await reread();
    if (!fresh) return 'Could not read the import.';
    // A retry (also one restored after a reload, whose body is not kept) is settled only by an outcome written after it
    // was first sent, never by the outcome of an earlier commit or retry of the same import.
    if (settles(p, fresh)) {
      settle(p.requestKey);
      setNotice(outcome(fresh));
      changed(fresh);
      return null;
    }
    if (fresh.status === 'committing') return 'The rows are still being added. Check again in a moment.';
    if (p.restored && (fresh.status === 'previewed' || importSettled(fresh.status))) {
      // Its details are not kept, so it cannot be resent. Doing it again is safe: an import is claimed once, a second
      // claim is refused, and a row already added is never added twice.
      settle(p.requestKey);
      setNotice(stepKind(p, fresh._id) === 'commit'
        ? 'The earlier step has not started. Confirm again below if you still want these rows added; they are added only once.'
        : 'The earlier try of the failed rows has not started. Try them again below if you still want; a row already added is never added twice.');
      return null;
    }
    return 'It has not started yet. It may still be on its way. Sending it again is safe: each row is added only once.';
  }

  // WQ11c: while a step is unconfirmed the import is read again every 5 seconds, and an outcome that settles it ends it.
  useEffect(() => {
    if (!op || busy) return undefined;
    const t = setInterval(() => { void reread().catch(() => undefined); }, 5_000);
    return () => clearInterval(t);
  }, [op, busy]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!op || busy || !settles(op, record)) return;
    settle(op.requestKey);
    setNotice(outcome(record));
  }, [op, busy, record]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(p: PendingOp<PendingStep>) {
    await perform(async () => {
      const r = await send(p, (b) => (b.kind === 'commit' ? stock.commitImport(b.importId) : stock.retryImport(b.importId)));
      if (r.kind === 'ok') { setNotice(outcome(r.value)); changed(r.value); return; }
      if (r.kind === 'stale') return;
      // Another window already started it: the import as saved says what happened.
      if (isImportClaimed(r.error)) {
        if (r.kind === 'unknown') await checkStep(p);
        else { const fresh = await reread(); if (fresh) changed(fresh); }
        throw r.error;
      }
      if (r.kind === 'refused') throw r.error;
    });
  }

  const mode = IMPORT_MODES.find((m) => m.value === record.importMode);
  const rowsWord = (n: number) => `${n} ${n === 1 ? 'row' : 'rows'}`;
  const named = (list: readonly ImportRow[]) => list.slice(0, 5).map((r) => `row ${r.rowIndex} (${r.medicineName || 'no name'})`).join(', ') + (list.length > 5 ? ` and ${list.length - 5} more` : '');
  return (
    <>
      <PageHeading title={`Import of ${record.fileName}`}>
        Uploaded {formatDateTime(record.createdAt)} · <Badge tone={importTone(record.status)}>{isDiscarded ? 'Discarded on this device' : IMPORT_STATUS_LABEL[record.status] ?? record.status}</Badge>
      </PageHeading>
      {notice && <Alert tone="ok">{notice}</Alert>}
      <section className="ws-section" aria-labelledby="sum-h">
        <h2 id="sum-h">Summary</h2>
        <dl className="ws-dl">
          <dt>Rows</dt><dd>{record.totalRows}</dd>
          <dt>Ready to add</dt><dd>{record.validRows}</dd>
          <dt>With problems</dt><dd>{record.errorRows}</dd>
          {(record.status !== 'previewed' && record.status !== 'pending') && <><dt>Added</dt><dd>{record.committedRows ?? 0}</dd></>}
          {record.committedAt && <><dt>Finished</dt><dd>{formatDateTime(record.committedAt)}</dd></>}
          <dt>Rows used</dt><dd>{mode ? `${mode.label} (${mode.hint})` : record.importMode}</dd>
          {fileSupplier && <><dt>Supplier</dt><dd>{fileSupplier}</dd></>}
        </dl>
        {arrival?.supplierAsked && !record.supplierId && record.status === 'previewed' && (
          <Alert tone="warn">
            You chose {arrival.supplierAsked} as the supplier of this file, but the server did not record a supplier for it: no
            supplier is recorded for these rows.
          </Alert>
        )}
        {monthFirst.length > 0 && (
          <Alert tone="warn">
            This file writes dates month first, so {monthFirst.length === 1 ? '1 row was' : `${monthFirst.length} rows were`} refused. Dates are read
            day first: write them as {IMPORT_DATE_FORMAT} and upload the file again.
          </Alert>
        )}
        {problemRows > 0 && <ProblemFile importId={record._id} fileName={record.fileName} />}
      </section>

      {op && !(busy && op.attempts === 1 && !op.uncertain) ? (
        <CheckPanel label="Unconfirmed import step" onCheck={() => checkStep(op)}
          resend={op.restored || !op.body ? undefined : { label: 'Send it again', busy, onClick: () => void run(op).catch(() => undefined) }}>
          <Alert tone="warn">
            {op.restored
              ? 'A step on this import started earlier on this device (before the page was reloaded, or before you signed out) was not confirmed.'
              : `The answer did not arrive${op.error ? ` (${op.error})` : ''}. The rows may already be added.`}
            {' '}Each row is added only once, so checking or sending again is safe. This page checks again on its own every few seconds.
          </Alert>
        </CheckPanel>
      ) : (
        <>
          {record.status === 'previewed' && isDiscarded && (
            <section className="ws-section" aria-labelledby="go-h">
              <h2 id="go-h">Add to stock</h2>
              <Alert tone="warn">
                You discarded this preview on this device: nothing from it was added. The server still keeps it as checked; it is
                added only if someone confirms it.
              </Alert>
              <div><Button variant="secondary" onClick={() => discarded.restore(record._id)}>Use this preview after all</Button></div>
            </section>
          )}
          {record.status === 'previewed' && !isDiscarded && (
            <section className="ws-section" aria-labelledby="go-h">
              <h2 id="go-h">Add to stock</h2>
              {twin && (
                <Alert tone="warn">
                  Another import of {record.fileName} was added {formatDateTime(twin.committedAt ?? twin.updatedAt)}{' '}
                  (<Link to={`/pharmacy/stock/imports/${twin._id}`}>open it</Link>). Adding this one too adds the units again.
                </Alert>
              )}
              {plan.zeroPrices.length > 0 && (
                <Alert tone="warn">
                  {rowsWord(plan.zeroPrices.length)} would set a price to ₹0: {named(plan.zeroPrices)}. If a cell should keep the
                  current price, leave it blank in the file and upload it again.
                </Alert>
              )}
              {plan.examples.length > 0 ? (
                <Alert>
                  Row {plan.examples.map((r) => r.rowIndex).join(', ')} is the template’s example row (“{TEMPLATE_EXAMPLE_MARK}”). Delete it
                  from the file and upload the file again before adding anything.
                </Alert>
              ) : importCommittable(record) && plan.rows > 0 ? (
                <ConfirmAction label={`Add ${record.validRows} ready ${record.validRows === 1 ? 'row' : 'rows'} to stock…`} confirmLabel="Yes, add them"
                  consequence={<>
                    {record.importMode === 'create_only' && plan.mayBeSkipped > 0
                      ? `Up to ${rowsWord(plan.rows)} (${plan.units} units) are added: ${plan.mayBeSkipped} of them are for medicines in the list, and any already in your stock are skipped.`
                      : `${rowsWord(plan.rows)} (${plan.units} units) ${plan.rows === 1 ? 'is' : 'are'} added${record.importMode === 'update_only' ? ' if the medicine is in your stock (others are skipped)' : ''}.`}
                    {plan.skippedNew > 0 && ` ${rowsWord(plan.skippedNew)} for medicines not in your stock ${plan.skippedNew === 1 ? 'is' : 'are'} skipped and not counted.`}
                    {plan.newMedicines > 0 && ` ${plan.newMedicines} ${plan.newMedicines === 1 ? 'medicine is' : 'medicines are'} not in the medicine list yet and will be added to it`}
                    {plan.newMedicines > 0 && (plan.newNeedingPrescription > 0 ? ` (${plan.newNeedingPrescription} needing a prescription).` : ' (none needing a prescription).')}
                    {plan.unpriced.length > 0 && ` ${rowsWord(plan.unpriced.length)} ${plan.unpriced.length === 1 ? 'leaves its medicine' : 'leave their medicines'} without a selling price: not on sale until priced (${named(plan.unpriced)}).`}
                    {plan.priceChanges.length > 0
                      ? ` Prices change in ${rowsWord(plan.priceChanges.length)}: ${named(plan.priceChanges)}${plan.zeroPrices.length > 0 ? `, ${rowsWord(plan.zeroPrices.length)} to ₹0` : ''}. Blank price cells keep the current price.`
                      : ' No price changes: every price cell is blank, so current prices stay.'}
                    {' '}Stock with a selling price is on sale once added.
                    {record.errorRows > 0 && ` ${record.errorRows} ${record.errorRows === 1 ? 'row with a problem is' : 'rows with problems are'} left out: fix them and import them in a new file.`}
                    {' '}The workspace cannot undo this.
                  </>}
                  onConfirm={() => run(startOp(record._id, { kind: 'commit', importId: record._id }))} />
              ) : importCommittable(record) ? <Alert tone="warn">Every ready row is for a medicine not in your stock, and you chose to add only medicines already in your stock: nothing would be added. Upload the file again with another choice.</Alert>
                : <Alert tone="warn">No row is ready to add. Fix the file and upload it again.</Alert>}
              <div className="ws-action">
                {/* N3: never while a confirmation is on its way or unconfirmed; under the page's one-at-a-time guard. */}
                <ConfirmAction label="Discard this preview…" danger confirmLabel="Discard it" disabled={busy || !!op}
                  consequence="Nothing from this file is added. The preview is hidden on this device; the server keeps it as checked, and it is added only if someone confirms it (there is no way to delete it on the server yet)."
                  onConfirm={() => perform(async () => { discarded.discard(record._id); })} />
              </div>
            </section>
          )}
          {record.status === 'committing' && !stuck && <Alert tone="warn">The rows are being added. This page updates on its own.</Alert>}
          {stuck && (
            <section className="ws-section" aria-labelledby="stuck-h">
              <h2 id="stuck-h">Adding stopped</h2>
              <Alert tone="warn">
                Adding these rows started but has not finished since {formatDateTime(record.updatedAt)}. You can try again: rows
                already added are never added twice.
              </Alert>
              <ConfirmAction label="Try again…" confirmLabel="Yes, try again"
                consequence="The rows not added yet are added now. A row already added is never added twice. Rows with problems in the file are not tried."
                onConfirm={() => run(startOp(newRequestKey(), { kind: 'retry', importId: record._id, since: record.updatedAt ?? record.committedAt }))} />
            </section>
          )}
          {importRetryable(record, now.getTime()) && !stuck && (
            <section className="ws-section" aria-labelledby="retry-h">
              <h2 id="retry-h">Rows that failed</h2>
              <ConfirmAction label="Try the failed rows again…" confirmLabel="Yes, try again"
                consequence="Only rows that failed while being added are tried again; a row already added is never added twice. Rows with problems in the file are not tried: fix them in a new file."
                onConfirm={() => run(startOp(newRequestKey(), { kind: 'retry', importId: record._id, since: record.updatedAt ?? record.committedAt }))} />
            </section>
          )}
        </>
      )}

      <Rows rows={rows} />
    </>
  );
}

function ProblemFile({ importId, fileName }: { importId: string; fileName: string }) {
  const { api } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<{ url: string; name: string } | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  useEffect(() => () => { ctrl.current?.abort(); }, []);
  useEffect(() => () => { if (file) URL.revokeObjectURL(file.url); }, [file]);
  async function download() {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setBusy(true);
    setError(null);
    try {
      const blob = await pharmacyStockApi(api).problemRowsFile(importId, c.signal);
      if (c.signal.aborted) return;
      const name = `problems-${fileName.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 60) || 'import'}.xlsx`;
      const url = URL.createObjectURL(new Blob([blob], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      setFile({ url, name });
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      if (!c.signal.aborted) setError(messageOf(err));
    } finally {
      if (ctrl.current === c) setBusy(false);
    }
  }
  return (
    <div className="ws-action">
      <Button variant="secondary" busy={busy} onClick={() => void download()}>
        <Download size={16} aria-hidden="true" /> Download the rows with problems
      </Button>
      {file && <a href={file.url} download={file.name}>Save {file.name} again</a>}
      {error && <Alert>Could not download the rows: {error}</Alert>}
    </div>
  );
}

const MATCH_LABEL = { matched: 'In the list', not_found: 'New: will be added to the list', duplicate: 'Several medicines have this name' } as const;
const rowTone = (s: ImportRow['status']) => (s === 'committed' || s === 'valid' ? 'ok' : s === 'skipped' ? undefined : 'danger');
const STEP = 100;

/**
 * A price as the row leaves it: its own number (₹0 shown as such, never a dash); a blank cell keeps the current price,
 * named when the preview says it (Q16c `currentPrices`), or none when there is none (a new medicine, or one not yet in
 * this pharmacy's stock: `inMyStock`).
 */
function Price({ view, ready }: { view: ImportPriceView; ready: boolean }) {
  if (!ready) return <>—</>;
  if (view.kind === 'set') return <>{formatRupees(view.value)}</>;
  if (view.kind === 'kept') return <span className="ws-muted">Kept: {formatRupees(view.value)}</span>;
  if (view.kind === 'none') return <span className="ws-muted">No price yet</span>;
  return <span className="ws-muted">Current price kept</span>;
}

function Rows({ rows }: { rows: ImportRow[] }) {
  const [shown, setShown] = useState(STEP);
  if (rows.length === 0) return <Empty title="No rows">The file had no rows under its column names.</Empty>;
  // Problems first, then the rest in file order.
  const ordered = [...rows].sort((a, b) => Number(b.status === 'error' || b.status === 'failed') - Number(a.status === 'error' || a.status === 'failed') || a.rowIndex - b.rowIndex);
  const withSupplier = rows.some((r) => r.data?.supplierName || r.data?.supplierId);
  // N7: wholesale and purchase prices are shown when a row changes them.
  const extra = IMPORT_PRICE_FIELDS.filter((f) => (f.key === 'wholesalePrice' || f.key === 'purchasePrice')
    && rows.some((r) => r.status !== 'error' && importPriceView(r, f.key).kind === 'set'));
  return (
    <section className="ws-section" aria-labelledby="rows-h">
      <h2 id="rows-h">Rows</h2>
      <p className="ws-muted">Prices are what each row will set. “Current price kept” means the cell was blank.</p>
      <div className="ws-table-wrap">
        <table className="j-table">
          <caption className="j-sr-only">Rows of the file, problems first</caption>
          <thead>
            <tr>
              <th scope="col">Row</th><th scope="col">Medicine</th><th scope="col">Medicine list</th><th scope="col">Prescription</th><th scope="col">Batch</th>
              <th scope="col">Expiry</th><th scope="col">Units</th><th scope="col">MRP</th><th scope="col">Selling price</th>
              {extra.map((f) => <th key={f.key} scope="col">{f.key === 'wholesalePrice' ? 'Wholesale price' : 'Purchase price'}</th>)}
              {withSupplier && <th scope="col">Supplier</th>}<th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {ordered.slice(0, shown).map((r) => {
              const ready = !!r.data && r.status !== 'error';
              const zero = ready && r.status === 'valid' ? importZeroPrices(r) : [];
              const isNew = r.data?.medicineMatchStatus === 'not_found';
              return (
                <tr key={r.rowIndex}>
                  <td>{r.rowIndex}</td>
                  <td>{r.medicineName || '—'}</td>
                  <td>{r.data?.medicineMatchStatus ? (
                    r.data.medicineMatchStatus === 'matched' && r.data.matchedMedicineName && r.data.matchedMedicineName !== r.medicineName
                      ? `In the list as ${r.data.matchedMedicineName}` : MATCH_LABEL[r.data.medicineMatchStatus]
                  ) : '—'}</td>
                  <td>{isNew ? (r.data?.prescriptionRequired === false ? 'Not needed' : 'Needs a prescription') : <span className="ws-muted">As in the list</span>}</td>
                  <td>{r.data?.batchNumber || '—'}</td>
                  <td>{r.data?.expiryDate ? formatExpiry(r.data.expiryDate) : '—'}</td>
                  <td>{r.data?.quantityToAdd ?? '—'}</td>
                  <td><Price ready={ready} view={importPriceView(r, 'mrp')} /></td>
                  <td>
                    <Price ready={ready} view={importPriceView(r, 'retailPrice')} />
                    {ready && importLeavesUnpriced(r) && <div className="ws-muted">Not on sale until priced</div>}
                  </td>
                  {extra.map((f) => <td key={f.key}><Price ready={ready} view={importPriceView(r, f.key)} /></td>)}
                  {withSupplier && <td>{r.data?.supplierName ?? (r.data?.supplierId ? 'A supplier' : '—')}</td>}
                  <td>
                    <Badge tone={rowTone(r.status)}>{IMPORT_ROW_STATUS_LABEL[r.status] ?? r.status}</Badge>
                    {zero.length > 0 && <div className="ws-warn-text">Sets the {zero.join(', ')} to ₹0</div>}
                    {r.errors?.length ? <div className="ws-muted">{r.errors.join('; ')}</div> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {ordered.length > shown && (
        <div><Button variant="secondary" onClick={() => setShown(shown + STEP)}>Show {Math.min(STEP, ordered.length - shown)} more of {ordered.length - shown}</Button></div>
      )}
    </section>
  );
}
