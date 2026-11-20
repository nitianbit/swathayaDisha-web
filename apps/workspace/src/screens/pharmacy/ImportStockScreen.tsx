import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { ArrowLeft, Download } from 'lucide-react';
import {
  IMPORT_ACCEPT, IMPORT_COLUMNS, IMPORT_MODES, IMPORT_STATUS_LABEL, importFileProblem, importTemplateCsv, pharmacyStockApi,
  type ImportMode, type ImportStatus, type InventoryImport,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, formatDateTime, Loading } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { newRequestKey, startOp } from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { useOneAtATime } from '../finance/finance.tsx';
import { CheckPanel, useOwnedOp, usePharmacyId } from './ownedOp.tsx';

export const importTone = (s: ImportStatus) =>
  s === 'committed' ? 'ok' : s === 'failed' ? 'danger' : s === 'partially_committed' || s === 'committing' ? 'warn' : undefined;

/** Only the file's name and the mode are kept for an unconfirmed check, never its contents. */
interface PendingCheck { fileName: string; mode: ImportMode }

/** WQ10a: upload a stock file to be checked (nothing changes in stock yet), and the list of earlier imports. */
export function ImportStockScreen() {
  const pharmacyId = usePharmacyId();
  return (
    <>
      <Link to="/pharmacy/stock" className="ws-back"><ArrowLeft size={16} aria-hidden="true" /> Stock</Link>
      <PageHeading title="Import stock from a file">
        Upload a spreadsheet of the stock you received. It is checked first; nothing is added until you confirm.
      </PageHeading>
      <ImportStock key={pharmacyId} pharmacyId={pharmacyId} />
    </>
  );
}

function ImportStock({ pharmacyId }: { pharmacyId: string }) {
  return (
    <>
      <Columns />
      <Upload pharmacyId={pharmacyId} />
      <History pharmacyId={pharmacyId} />
    </>
  );
}

function Columns() {
  const [file, setFile] = useState<string | null>(null);
  useEffect(() => () => { if (file) URL.revokeObjectURL(file); }, [file]);
  function template() {
    const url = URL.createObjectURL(new Blob([importTemplateCsv()], { type: 'text/csv' }));
    setFile(url);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'stock-import-template.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  return (
    <section className="ws-section" aria-labelledby="cols-h">
      <h2 id="cols-h">1. Prepare the file</h2>
      <p>
        Use an Excel (.xlsx, .xls) or CSV file of up to 10 MB. Only the first sheet is read. The first row holds the column
        names, written exactly as below in small letters; other columns are ignored. One row per batch.
      </p>
      <div className="ws-actions">
        <Button variant="secondary" onClick={template}><Download size={16} aria-hidden="true" /> Download a blank template (CSV)</Button>
        {file && <a href={file} download="stock-import-template.csv">Save the template again</a>}
      </div>
      <div className="ws-table-wrap">
        <table className="j-table">
          <caption className="j-sr-only">Columns of a stock file</caption>
          <thead><tr><th scope="col">Column name</th><th scope="col">Needed</th><th scope="col">What to write</th></tr></thead>
          <tbody>
            {IMPORT_COLUMNS.map((c) => (
              <tr key={c.header}><td><code>{c.header}</code></td><td>{c.need}</td><td>{c.format}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <Alert tone="warn">
        Write the expiry date as text (for example 20271231 or 2027-12-31). If your spreadsheet turns it into a date, set
        that column’s format to Text first, or the row is refused.
      </Alert>
    </section>
  );
}

function Upload({ pharmacyId }: { pharmacyId: string }) {
  const { api } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const stock = pharmacyStockApi(api);
  const { op, send, settle } = useOwnedOp<PendingCheck>(`stock-import-check:${pharmacyId}`);
  const { perform, busy } = useOneAtATime('stock file');
  const [mode, setMode] = useState<ImportMode>('upsert');
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);

  const open = (r: InventoryImport) => {
    if (/^[0-9a-fA-F]{24}$/.test(r._id)) navigate(`/pharmacy/stock/imports/${r._id}`);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setRefused(null);
    const problem = importFileProblem(file);
    setFileError(problem);
    if (problem || !file) return;
    const chosen = file;
    try {
      await perform(async () => {
        const r = await send(startOp(newRequestKey(), { fileName: chosen.name, mode }), (b) => stock.previewImport(chosen, b.fileName, b.mode));
        if (r.kind === 'ok') { void queryClient.invalidateQueries({ queryKey: ['pharmacy-inventory', pharmacyId, 'imports'] }); open(r.value); }
        else if (r.kind === 'refused') setRefused(messageOf(r.error));
      });
    } catch (err) {
      setRefused(messageOf(err));
    }
  }

  return (
    <section className="ws-section" aria-labelledby="upload-h">
      <h2 id="upload-h">2. Upload and check</h2>
      {op && !busy ? (
        <CheckPanel label="Unconfirmed file check"
          onCheck={async () => {
            const recent = await stock.imports(1, 20);
            const since = op.firstAttemptAt - 5 * 60_000;
            const hit = recent.items.find((r) => (!op.body || r.fileName === op.body.fileName)
              && r.createdAt && Date.parse(r.createdAt) >= since);
            void queryClient.invalidateQueries({ queryKey: ['pharmacy-inventory', pharmacyId, 'imports'] });
            if (!hit) return 'It is not in your imports yet. It may still be on its way, or it never arrived.';
            settle(op.requestKey);
            open(hit);
            return null;
          }}
          forget={{
            label: 'Forget it', confirmLabel: 'Forget it and upload again',
            consequence: 'Checking a file adds nothing to stock, so uploading it again is safe. If the first check arrives later it stays in the list below, unconfirmed.',
            onForget: () => settle(op.requestKey),
          }}>
          <Alert tone="warn">
            The answer to the file check did not arrive{op.error ? ` (${op.error})` : ''}. Nothing was added to stock: a checked
            file waits for you to confirm it.{op.body ? ` File: ${op.body.fileName}.` : ''}
          </Alert>
        </CheckPanel>
      ) : (
        <form className="rx-form" noValidate onSubmit={(e) => void submit(e)}>
          <fieldset className="ws-checks" disabled={busy}>
            <legend>Which rows to add</legend>
            {IMPORT_MODES.map((m) => (
              <label key={m.value} className="ws-check">
                <input type="radio" name="import-mode" value={m.value} checked={mode === m.value} onChange={() => setMode(m.value)} />
                <span>{m.label} <span className="ws-muted">— {m.hint}</span></span>
              </label>
            ))}
          </fieldset>
          <div className="j-field">
            <label htmlFor="import-file">Stock file</label>
            <input id="import-file" type="file" accept={IMPORT_ACCEPT} disabled={busy}
              aria-invalid={fileError ? true : undefined} aria-describedby={fileError ? 'import-file-error' : 'import-file-hint'}
              onChange={(e) => { setFile(e.target.files?.[0] ?? null); setFileError(null); setRefused(null); }} />
            <span id="import-file-hint" className="j-field__hint">.xlsx, .xls or .csv, up to 10 MB.</span>
            {fileError && <span id="import-file-error" className="j-field__error">{fileError}</span>}
          </div>
          {refused && <Alert>The file was not checked: {refused}</Alert>}
          <div><Button type="submit" busy={busy}>Check the file</Button></div>
        </form>
      )}
    </section>
  );
}

const PAGE_SIZE = 20;

function History({ pharmacyId }: { pharmacyId: string }) {
  const { api } = useSession();
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['pharmacy-inventory', pharmacyId, 'imports', page],
    queryFn: () => pharmacyStockApi(api).imports(page, PAGE_SIZE),
  });
  return (
    <section className="ws-section" aria-labelledby="history-h">
      <h2 id="history-h">Recent imports</h2>
      {q.isPending ? <Loading label="Loading imports…" />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : q.data.items.length === 0 ? <Empty title="No imports yet">Files you upload are listed here.</Empty>
        : (
          <>
            <div className="ws-table-wrap">
              <table className="j-table">
                <caption className="j-sr-only">Stock files uploaded, newest first</caption>
                <thead>
                  <tr><th scope="col">Uploaded</th><th scope="col">File</th><th scope="col">Status</th><th scope="col">Rows</th><th scope="col">Added</th></tr>
                </thead>
                <tbody>
                  {q.data.items.map((r) => (
                    <tr key={r._id}>
                      <td><Link to={`/pharmacy/stock/imports/${r._id}`}>{formatDateTime(r.createdAt)}</Link></td>
                      <td>{r.fileName}</td>
                      <td><Badge tone={importTone(r.status)}>{IMPORT_STATUS_LABEL[r.status] ?? r.status}</Badge></td>
                      <td>{r.totalRows} ({r.validRows} ready, {r.errorRows} with problems)</td>
                      <td>{r.committedRows ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {q.data.totalPages > 1 && (
              <nav className="ws-pager" aria-label="Pages">
                <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
                <span>Page {page} of {q.data.totalPages}</span>
                <Button variant="secondary" disabled={page >= q.data.totalPages} onClick={() => setPage(page + 1)}>Next</Button>
              </nav>
            )}
          </>
        )}
    </section>
  );
}
