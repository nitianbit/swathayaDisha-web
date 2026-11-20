import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ArrowLeft, Download } from 'lucide-react';
import {
  formatExpiry, IMPORT_MODES, IMPORT_ROW_STATUS_LABEL, IMPORT_STATUS_LABEL, importCommittable, importRetryable, importSettled,
  importStuck, isImportClaimed, pharmacyStockApi, type ImportRow, type InventoryImport,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, formatDateTime, formatRupees, Loading } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { newRequestKey, startOp, type PendingOp } from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { useOneAtATime } from '../finance/finance.tsx';
import { useTicker } from '../doctor/doctor.tsx';
import { importTone } from './ImportStockScreen.tsx';
import { CheckPanel, useOwnedOp, usePharmacyId } from './ownedOp.tsx';

/** The step being sent for this import: adding its ready rows, or trying its failed rows again. */
interface PendingStep { kind: 'commit' | 'retry'; importId: string }

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
  if (q.isError) return <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />;
  return <ImportView pharmacyId={pharmacyId} record={q.data} reread={() => q.refetch().then((r) => r.data)} />;
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
  const now = useTicker(30_000);
  const stuck = importStuck(record, now.getTime());
  const rows = record.previewRows ?? [];
  const newMedicines = rows.filter((r) => r.status === 'valid' && r.data?.medicineMatchStatus === 'not_found').length;
  const units = rows.filter((r) => r.status === 'valid').reduce((a, r) => a + Number(r.data?.quantityToAdd ?? 0), 0);
  const problemRows = rows.filter((r) => r.status === 'error' || r.status === 'failed').length;

  const changed = (r: InventoryImport) => {
    queryClient.setQueryData(importKey(pharmacyId, record._id), r);
    void queryClient.invalidateQueries({ queryKey: ['pharmacy-inventory'] });
  };
  const outcome = (r: InventoryImport) =>
    r.status === 'committed' ? `Done: ${r.committedRows ?? 0} rows were added to stock.`
      : r.status === 'partially_committed' ? `Partly done: ${r.committedRows ?? 0} rows were added; ${r.failedRows ?? 0} were not. See the rows below.`
      : r.status === 'failed' ? 'No row was added. See the problems below.'
      : null;

  /** Settles the stored step from the import as the server has it now; answers what is still unknown. */
  async function checkStep(p: PendingOp<PendingStep>): Promise<string | null> {
    const fresh = await reread();
    if (!fresh) return 'Could not read the import.';
    const retry = p.body?.kind === 'retry';
    // A retry is settled only by an outcome written after it was first sent (30 s allowed for clocks), never by the
    // outcome of an earlier commit or retry of the same import.
    const since = p.firstAttemptAt - 30_000;
    if (importSettled(fresh.status) && (!retry || (fresh.updatedAt && Date.parse(fresh.updatedAt) >= since))) {
      settle(p.requestKey);
      setNotice(outcome(fresh));
      changed(fresh);
      return null;
    }
    if (fresh.status === 'committing') return 'The rows are still being added. Check again in a moment.';
    if (p.restored && fresh.status === 'previewed') {
      // Its details are not kept, so it cannot be resent. Confirming again is safe: an import is claimed once, and a
      // second claim is refused, so the rows are never added twice.
      settle(p.requestKey);
      setNotice('The earlier step has not started. Confirm again below if you still want these rows added; they are added only once.');
      return null;
    }
    return 'It has not started yet. It may still be on its way. Sending it again is safe: each row is added only once.';
  }

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
  return (
    <>
      <PageHeading title={`Import of ${record.fileName}`}>
        Uploaded {formatDateTime(record.createdAt)} · <Badge tone={importTone(record.status)}>{IMPORT_STATUS_LABEL[record.status] ?? record.status}</Badge>
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
        </dl>
        {problemRows > 0 && <ProblemFile importId={record._id} fileName={record.fileName} />}
      </section>

      {op && !(busy && op.attempts === 1 && !op.uncertain) ? (
        <CheckPanel label="Unconfirmed import step" onCheck={() => checkStep(op)}
          resend={op.restored || !op.body ? undefined : { label: 'Send it again', busy, onClick: () => void run(op).catch(() => undefined) }}>
          <Alert tone="warn">
            {op.restored
              ? 'A step on this import started earlier on this device (before the page was reloaded, or before you signed out) was not confirmed.'
              : `The answer did not arrive${op.error ? ` (${op.error})` : ''}. The rows may already be added.`}
            {' '}Each row is added only once, so checking or sending again is safe.
          </Alert>
        </CheckPanel>
      ) : (
        <>
          {record.status === 'previewed' && (
            <section className="ws-section" aria-labelledby="go-h">
              <h2 id="go-h">Add to stock</h2>
              {importCommittable(record) ? (
                <ConfirmAction label={`Add ${record.validRows} ready ${record.validRows === 1 ? 'row' : 'rows'} to stock…`} confirmLabel="Yes, add them"
                  consequence={<>
                    {units} units in {record.validRows} {record.validRows === 1 ? 'row' : 'rows'} go on sale at once.
                    {newMedicines > 0 && ` ${newMedicines} ${newMedicines === 1 ? 'medicine is' : 'medicines are'} not in the medicine list yet and will be added to it.`}
                    {record.errorRows > 0 && ` ${record.errorRows} ${record.errorRows === 1 ? 'row with a problem is' : 'rows with problems are'} left out: fix them and import them in a new file.`}
                    {' '}The workspace cannot undo this.
                  </>}
                  onConfirm={() => run(startOp(record._id, { kind: 'commit', importId: record._id }))} />
              ) : <Alert tone="warn">No row is ready to add. Fix the file and upload it again.</Alert>}
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
                onConfirm={() => run(startOp(newRequestKey(), { kind: 'retry', importId: record._id }))} />
            </section>
          )}
          {importRetryable(record, now.getTime()) && !stuck && (
            <section className="ws-section" aria-labelledby="retry-h">
              <h2 id="retry-h">Rows that failed</h2>
              <ConfirmAction label="Try the failed rows again…" confirmLabel="Yes, try again"
                consequence="Only rows that failed while being added are tried again; a row already added is never added twice. Rows with problems in the file are not tried: fix them in a new file."
                onConfirm={() => run(startOp(newRequestKey(), { kind: 'retry', importId: record._id }))} />
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

function Rows({ rows }: { rows: ImportRow[] }) {
  const [shown, setShown] = useState(STEP);
  if (rows.length === 0) return <Empty title="No rows">The file had no rows under its column names.</Empty>;
  // Problems first, then the rest in file order.
  const ordered = [...rows].sort((a, b) => Number(b.status === 'error' || b.status === 'failed') - Number(a.status === 'error' || a.status === 'failed') || a.rowIndex - b.rowIndex);
  return (
    <section className="ws-section" aria-labelledby="rows-h">
      <h2 id="rows-h">Rows</h2>
      <div className="ws-table-wrap">
        <table className="j-table">
          <caption className="j-sr-only">Rows of the file, problems first</caption>
          <thead>
            <tr>
              <th scope="col">Row</th><th scope="col">Medicine</th><th scope="col">Medicine list</th><th scope="col">Batch</th>
              <th scope="col">Expiry</th><th scope="col">Units</th><th scope="col">MRP</th><th scope="col">Selling price</th><th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {ordered.slice(0, shown).map((r) => (
              <tr key={r.rowIndex}>
                <td>{r.rowIndex}</td>
                <td>{r.medicineName || '—'}</td>
                <td>{r.data?.medicineMatchStatus ? (
                  r.data.medicineMatchStatus === 'matched' && r.data.matchedMedicineName && r.data.matchedMedicineName !== r.medicineName
                    ? `In the list as ${r.data.matchedMedicineName}` : MATCH_LABEL[r.data.medicineMatchStatus]
                ) : '—'}</td>
                <td>{r.data?.batchNumber || '—'}</td>
                <td>{r.data?.expiryDate ? formatExpiry(r.data.expiryDate) : '—'}</td>
                <td>{r.data?.quantityToAdd ?? '—'}</td>
                <td>{r.data?.mrp ? formatRupees(r.data.mrp) : '—'}</td>
                <td>{r.data?.retailPrice ? formatRupees(r.data.retailPrice) : '—'}</td>
                <td>
                  <Badge tone={rowTone(r.status)}>{IMPORT_ROW_STATUS_LABEL[r.status] ?? r.status}</Badge>
                  {r.errors?.length ? <div className="ws-muted">{r.errors.join('; ')}</div> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {ordered.length > shown && (
        <div><Button variant="secondary" onClick={() => setShown(shown + STEP)}>Show {Math.min(STEP, ordered.length - shown)} more of {ordered.length - shown}</Button></div>
      )}
    </section>
  );
}
