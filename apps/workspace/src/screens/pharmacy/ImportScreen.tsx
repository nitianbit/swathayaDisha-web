import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useParams } from 'react-router';
import { ArrowLeft, Download } from 'lucide-react';
import {
  formatExpiry, IMPORT_MODES, IMPORT_ROW_STATUS_LABEL, IMPORT_STATUS_LABEL, importCommittable, importPlan, importRetryable, importSettled,
  importStuck, importZeroPrices, isImportClaimed, monthFirstRows, pharmacyStockApi, recentSameFile, type ImportRow, type InventoryImport,
  IMPORT_DATE_FORMAT, allSuppliers, importLeavesUnpriced, importPriceView, IMPORT_PRICE_FIELDS, TEMPLATE_EXAMPLE_MARK, type ImportPriceView,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, formatDateTime, formatRupees, Loading , Parts } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { newRequestKey, startOp, type PendingOp } from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { useOneAtATime } from '../finance/finance.tsx';
import { RefreshFailed, useTicker } from '../doctor/doctor.tsx';
import { importTone } from './ImportStockScreen.tsx';
import { CheckPanel, useDiscarded, useOwnedOp, usePharmacyId } from './ownedOp.tsx';
import { t } from '../../i18n/pharmacy/index.ts';

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
  const back = <Link to="/pharmacy/stock/import" className="ws-back"><ArrowLeft size={16} aria-hidden="true" />{` ${t('import.importStock')}`}</Link>;
  if (!/^[0-9a-fA-F]{24}$/.test(importId)) return <>{back}<Empty title={t('import.importNotFound')}>{t('import.openItFromTheList')}</Empty></>;
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
  if (q.isPending) return <Loading label={t('import.loadingImport')} />;
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
    ?? (record.supplierId ? suppliers.data?.find((x) => x.supplierId === String(record.supplierId).toLowerCase())?.displayName ?? t('common.aSupplier') : null);
  const monthFirst = monthFirstRows(rows);

  const changed = (r: InventoryImport) => {
    queryClient.setQueryData(importKey(pharmacyId, record._id), r);
    void queryClient.invalidateQueries({ queryKey: ['pharmacy-inventory'] });
  };
  const outcome = (r: InventoryImport) => {
    const skipped = (r.previewRows ?? []).filter((x) => x.status === 'skipped').length;
    const skip = skipped > 0 ? ` ${t('import.skipped', { count: skipped })}` : '';
    return r.status === 'committed' ? t('import.doneRowsWereAddedTo', { value: r.committedRows ?? 0, skip })
      : r.status === 'partially_committed' ? t('import.partlyDoneRowsWereAdded', { value: r.committedRows ?? 0, value2: r.failedRows ?? 0, skip })
      : r.status === 'failed' ? t('import.noRowWasAddedSee')
      : null;
  };

  /** Settles the stored step from the import as the server has it now; answers what is still unknown. */
  async function checkStep(p: PendingOp<PendingStep>): Promise<string | null> {
    const fresh = await reread();
    if (!fresh) return t('import.couldNotReadTheImport');
    // A retry (also one restored after a reload, whose body is not kept) is settled only by an outcome written after it
    // was first sent, never by the outcome of an earlier commit or retry of the same import.
    if (settles(p, fresh)) {
      settle(p.requestKey);
      setNotice(outcome(fresh));
      changed(fresh);
      return null;
    }
    if (fresh.status === 'committing') return t('import.theRowsAreStillBeing');
    if (p.restored && (fresh.status === 'previewed' || importSettled(fresh.status))) {
      // Its details are not kept, so it cannot be resent. Doing it again is safe: an import is claimed once, a second
      // claim is refused, and a row already added is never added twice.
      settle(p.requestKey);
      setNotice(stepKind(p, fresh._id) === 'commit'
        ? t('import.theEarlierStepHasNot')
        : t('import.theEarlierTryOfThe'));
      return null;
    }
    return t('import.itHasNotStartedYet');
  }

  // WQ11c: while a step is unconfirmed the import is read again every 5 seconds, and an outcome that settles it ends it.
  useEffect(() => {
    if (!op || busy) return undefined;
    const timer = setInterval(() => { void reread().catch(() => undefined); }, 5_000);
    return () => clearInterval(timer);
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
  const rowsWord = (n: number) => t('import.rows', { count: n });
  const named = (list: readonly ImportRow[]) => list.slice(0, 5).map((r) => t('import.namedRow', { row: r.rowIndex, name: r.medicineName || t('import.noName') })).join(', ')
    + (list.length > 5 ? ` ${t('import.andMore', { count: list.length - 5 })}` : '');
  return (
    <>
      <PageHeading title={t('import.importOf', { fileName: record.fileName })}><Parts of={t.rich('import.uploadedFull', { time: formatDateTime(record.createdAt), discardedOnThisDevice: <Badge tone={importTone(record.status)}>{isDiscarded ? t('common.discardedOnThisDevice') : IMPORT_STATUS_LABEL[record.status] ?? record.status}</Badge> })} />
      </PageHeading>
      {notice && <Alert tone="ok">{notice}</Alert>}
      <section className="ws-section" aria-labelledby="sum-h">
        <h2 id="sum-h">{t('import.summary')}</h2>
        <dl className="ws-dl">
          <dt>{t('common.rows')}</dt><dd>{record.totalRows}</dd>
          <dt>{t('import.readyToAdd')}</dt><dd>{record.validRows}</dd>
          <dt>{t('import.withProblems')}</dt><dd>{record.errorRows}</dd>
          {(record.status !== 'previewed' && record.status !== 'pending') && <><dt>{t('common.added')}</dt><dd>{record.committedRows ?? 0}</dd></>}
          {record.committedAt && <><dt>{t('import.finished')}</dt><dd>{formatDateTime(record.committedAt)}</dd></>}
          <dt>{t('import.rowsUsed')}</dt><dd>{mode ? `${mode.label} (${mode.hint})` : record.importMode}</dd>
          {fileSupplier && <><dt>{t('common.supplier')}</dt><dd>{fileSupplier}</dd></>}
        </dl>
        {arrival?.supplierAsked && !record.supplierId && record.status === 'previewed' && (
          <Alert tone="warn">{t('import.youChoseFull', { supplierAsked: arrival.supplierAsked })}</Alert>
        )}
        {monthFirst.length > 0 && (
          <Alert tone="warn">{t('import.monthFirst', { count: monthFirst.length, IMPORT_DATE_FORMAT })}</Alert>
        )}
        {problemRows > 0 && <ProblemFile importId={record._id} fileName={record.fileName} />}
      </section>

      {op && !(busy && op.attempts === 1 && !op.uncertain) ? (
        <CheckPanel label={t('import.unconfirmedImportStep')} onCheck={() => checkStep(op)}
          resend={op.restored || !op.body ? undefined : { label: t('import.sendItAgain'), busy, onClick: () => void run(op).catch(() => undefined) }}>
          <Alert tone="warn">
            {op.restored
              ? t('import.aStepOnThisImport')
              : t('import.theAnswerDidNotArrive', { value: op.error ? ` (${op.error})` : '' })}
            {' '}{t('import.eachRowIsAddedOnly')}</Alert>
        </CheckPanel>
      ) : null}
      {op && !(busy && op.attempts === 1 && !op.uncertain) && stuck && (
        // WQ11d: a tab holding an unconfirmed step for a stuck import may still try again (the server's retry of a stale
        // `committing` import): it replaces that step here; rows already added are never added twice.
        <StuckRetry record={record} disabled={busy} onRetry={() => run(startOp(newRequestKey(), { kind: 'retry', importId: record._id, since: record.updatedAt ?? record.committedAt }))} />
      )}
      {op && !(busy && op.attempts === 1 && !op.uncertain) ? null : (
        <>
          {record.status === 'previewed' && isDiscarded && (
            <section className="ws-section" aria-labelledby="go-h">
              <h2 id="go-h">{t('import.addToStock')}</h2>
              <Alert tone="warn">{t('import.youDiscardedThisPreviewOn')}</Alert>
              <div><Button variant="secondary" onClick={() => discarded.restore(record._id)}>{t('import.useThisPreviewAfterAll')}</Button></div>
            </section>
          )}
          {record.status === 'previewed' && !isDiscarded && (
            <section className="ws-section" aria-labelledby="go-h">
              <h2 id="go-h">{t('import.addToStock')}</h2>
              {twin && (
                <Alert tone="warn"><Parts of={t.rich('import.anotherImportOfFull', { fileName: record.fileName, time: formatDateTime(twin.committedAt ?? twin.updatedAt), words: <Link to={`/pharmacy/stock/imports/${twin._id}`}>{t('import.openIt')}</Link> })} /></Alert>
              )}
              {plan.zeroPrices.length > 0 && (
                <Alert tone="warn">
                  {t('import.wouldSetAPriceToFull', { rowsWord: rowsWord(plan.zeroPrices.length), named: named(plan.zeroPrices) })}</Alert>
              )}
              {plan.examples.length > 0 ? (
                <Alert>{t('import.rowFull', { examples: plan.examples.map((r) => r.rowIndex).join(', '), TEMPLATE_EXAMPLE_MARK })}</Alert>
              ) : importCommittable(record) && plan.rows > 0 ? (
                <ConfirmAction label={t('import.addReadyRows', { count: record.validRows })} confirmLabel={t('import.yesAddThem')}
                  consequence={<>
                    {record.importMode === 'create_only' && plan.mayBeSkipped > 0
                      ? t('import.upToUnitsAreAdded', { rows: rowsWord(plan.rows), units: plan.units, mayBeSkipped: plan.mayBeSkipped })
                      : t(record.importMode === 'update_only' ? 'import.unitsAddedIfInStock' : 'import.unitsAdded', { count: plan.rows, rows: rowsWord(plan.rows), units: plan.units })}
                    {plan.skippedNew > 0 && ` ${t('import.skippedNotInStock', { count: plan.skippedNew, rows: rowsWord(plan.skippedNew) })}`}
                    {plan.newMedicines > 0 && ` ${t('import.newMedicines', { count: plan.newMedicines })}`}
                    {plan.newMedicines > 0 && (plan.newNeedingPrescription > 0 ? ` ${t('import.needingAPrescription', { newNeedingPrescription: plan.newNeedingPrescription })}` : ` ${t('import.noneNeedingAPrescription')}`)}
                    {plan.unpriced.length > 0 && ` ${t('import.unpriced', { count: plan.unpriced.length, rows: rowsWord(plan.unpriced.length), named: named(plan.unpriced) })}`}
                    {plan.priceChanges.length > 0
                      ? ` ${(plan.zeroPrices.length > 0
                        ? t('import.pricesChangeZero', { rows: rowsWord(plan.priceChanges.length), named: named(plan.priceChanges), zeroRows: rowsWord(plan.zeroPrices.length) })
                        : t('import.pricesChange', { rows: rowsWord(plan.priceChanges.length), named: named(plan.priceChanges) }))}`
                      : ` ${t('import.noPriceChangesEveryPrice')}`}
                    {' '}{t('import.stockWithASellingPrice')}{record.errorRows > 0 && ` ${t('import.leftOut', { count: record.errorRows })}`}
                    {' '}{t('import.theWorkspaceCannotUndoThis')}</>}
                  onConfirm={() => run(startOp(record._id, { kind: 'commit', importId: record._id }))} />
              ) : importCommittable(record) ? <Alert tone="warn">{t('import.everyReadyRowIsFor')}</Alert>
                : <Alert tone="warn">{t('import.noRowIsReadyTo')}</Alert>}
              <div className="ws-action">
                {/* N3: never while a confirmation is on its way or unconfirmed; under the page's one-at-a-time guard. */}
                <ConfirmAction label={t('import.discardThisPreview')} danger confirmLabel={t('import.discardIt')} disabled={busy || !!op}
                  consequence={t('import.nothingFromThisFileIs')}
                  onConfirm={() => perform(async () => { discarded.discard(record._id); })} />
              </div>
            </section>
          )}
          {record.status === 'committing' && !stuck && <Alert tone="warn">{t('import.theRowsAreBeingAdded')}</Alert>}
          {stuck && (
            <StuckRetry record={record} disabled={busy} onRetry={() => run(startOp(newRequestKey(), { kind: 'retry', importId: record._id, since: record.updatedAt ?? record.committedAt }))} />
          )}
          {importRetryable(record, now.getTime()) && !stuck && (
            <section className="ws-section" aria-labelledby="retry-h">
              <h2 id="retry-h">{t('import.rowsThatFailed')}</h2>
              <ConfirmAction label={t('import.tryTheFailedRowsAgain')} confirmLabel={t('import.yesTryAgain')}
                consequence={t('import.onlyRowsThatFailedWhile')}
                onConfirm={() => run(startOp(newRequestKey(), { kind: 'retry', importId: record._id, since: record.updatedAt ?? record.committedAt }))} />
            </section>
          )}
        </>
      )}

      <Rows rows={rows} />
    </>
  );
}

/** An import whose adding stopped (`importStuck`): the server's retry adds the rows not added yet. */
function StuckRetry({ record, disabled, onRetry }: { record: InventoryImport; disabled: boolean; onRetry: () => Promise<unknown> }) {
  return (
    <section className="ws-section" aria-labelledby="stuck-h">
      <h2 id="stuck-h">{t('import.addingStopped')}</h2>
      <Alert tone="warn">{t('import.addingTheseRowsStartedButFull', { time: formatDateTime(record.updatedAt) })}</Alert>
      <ConfirmAction label={t('import.tryAgain')} confirmLabel={t('import.yesTryAgain')} disabled={disabled}
        consequence={t('import.theRowsNotAddedYet')}
        onConfirm={onRetry} />
    </section>
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
        <Download size={16} aria-hidden="true" />{` ${t('import.downloadTheRowsWithProblems')}`}</Button>
      {file && <a href={file.url} download={file.name}>{t('import.saveFull', { name: file.name })}</a>}
      {error && <Alert>{t('import.couldNotDownloadTheRowsFull', { error })}</Alert>}
    </div>
  );
}

const MATCH_LABEL = () => ({ matched: t('import.inTheList'), not_found: t('import.newWillBeAddedTo'), duplicate: t('import.severalMedicinesHaveThisName') } as const);
const rowTone = (s: ImportRow['status']) => (s === 'committed' || s === 'valid' ? 'ok' : s === 'skipped' ? undefined : 'danger');
const STEP = 100;

/**
 * A price as the row leaves it: its own number (₹0 shown as such, never a dash); a blank cell keeps the current price,
 * named when the preview says it (Q16c `currentPrices`), or none when there is none (a new medicine, or one not yet in
 * this pharmacy's stock: `inMyStock`).
 */
function Price({ view, ready, mrp = false }: { view: ImportPriceView; ready: boolean; mrp?: boolean }) {
  if (!ready) return <>—</>;
  if (view.kind === 'set') return <>{formatRupees(view.value)}</>;
  if (view.kind === 'kept') return <span className="ws-muted">{t('import.keptFull', { amount: formatRupees(view.value) })}</span>;
  // Q16d: MRP is per batch; a new batch (`batchInStock` false) with a blank cell has none.
  if (view.kind === 'none') return <span className="ws-muted">{mrp ? t('import.noMrpYet') : t('import.noPriceYet')}</span>;
  return <span className="ws-muted">{t('import.currentPriceKept')}</span>;
}

function Rows({ rows }: { rows: ImportRow[] }) {
  const [shown, setShown] = useState(STEP);
  if (rows.length === 0) return <Empty title={t('import.noRows')}>{t('import.theFileHadNoRows')}</Empty>;
  // Problems first, then the rest in file order.
  const ordered = [...rows].sort((a, b) => Number(b.status === 'error' || b.status === 'failed') - Number(a.status === 'error' || a.status === 'failed') || a.rowIndex - b.rowIndex);
  const withSupplier = rows.some((r) => r.data?.supplierName || r.data?.supplierId);
  // N7: wholesale and purchase prices are shown when a row changes them.
  const extra = IMPORT_PRICE_FIELDS.filter((f) => (f.key === 'wholesalePrice' || f.key === 'purchasePrice')
    && rows.some((r) => r.status !== 'error' && importPriceView(r, f.key).kind === 'set'));
  return (
    <section className="ws-section" aria-labelledby="rows-h">
      <h2 id="rows-h">{t('common.rows')}</h2>
      <p className="ws-muted">{t('import.pricesAreWhatEachRow')}</p>
      <div className="ws-table-wrap">
        <table className="j-table">
          <caption className="j-sr-only">{t('import.rowsOfTheFileProblems')}</caption>
          <thead>
            <tr>
              <th scope={'col'}>{t('import.row2')}</th><th scope={'col'}>{t('common.medicine')}</th><th scope={'col'}>{t('import.medicineList')}</th><th scope={'col'}>{t('common.prescription')}</th><th scope={'col'}>{t('common.batch')}</th>
              <th scope={'col'}>{t('common.expiry')}</th><th scope={'col'}>{t('common.units')}</th><th scope={'col'}>{t('import.mrp')}</th><th scope={'col'}>{t('import.sellingPrice')}</th>
              {extra.map((f) => <th key={f.key} scope={'col'}>{f.key === 'wholesalePrice' ? t('import.wholesalePrice') : t('import.purchasePrice')}</th>)}
              {withSupplier && <th scope={'col'}>{t('common.supplier')}</th>}<th scope={'col'}>{t('import.result')}</th>
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
                      ? t('import.inTheListAs', { matchedMedicineName: r.data.matchedMedicineName }) : MATCH_LABEL()[r.data.medicineMatchStatus]
                  ) : '—'}</td>
                  <td>{isNew ? (r.data?.prescriptionRequired === false ? t('import.notNeeded') : t('import.needsAPrescription')) : <span className="ws-muted">{t('import.asInTheList')}</span>}</td>
                  <td>{r.data?.batchNumber || '—'}</td>
                  <td>{r.data?.expiryDate ? formatExpiry(r.data.expiryDate) : '—'}</td>
                  <td>{r.data?.quantityToAdd ?? '—'}</td>
                  <td><Price ready={ready} mrp view={importPriceView(r, 'mrp')} /></td>
                  <td>
                    <Price ready={ready} view={importPriceView(r, 'retailPrice')} />
                    {ready && importLeavesUnpriced(r) && <div className="ws-muted">{t('import.notOnSaleUntilPriced')}</div>}
                  </td>
                  {extra.map((f) => <td key={f.key}><Price ready={ready} view={importPriceView(r, f.key)} /></td>)}
                  {withSupplier && <td>{r.data?.supplierName ?? (r.data?.supplierId ? t('common.aSupplier') : '—')}</td>}
                  <td>
                    <Badge tone={rowTone(r.status)}>{IMPORT_ROW_STATUS_LABEL[r.status] ?? r.status}</Badge>
                    {zero.length > 0 && <div className="ws-warn-text">{t('import.setsTheFull', { zero: zero.join(', ') })}</div>}
                    {r.errors?.length ? <div className="ws-muted">{r.errors.join('; ')}</div> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {ordered.length > shown && (
        <div><Button variant="secondary" onClick={() => setShown(shown + STEP)}>{t('import.showFull', { min: Math.min(STEP, ordered.length - shown), value: ordered.length - shown })}</Button></div>
      )}
    </section>
  );
}
