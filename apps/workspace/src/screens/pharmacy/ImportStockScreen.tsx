import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { ArrowLeft, Download } from 'lucide-react';
import {
  IMPORT_ACCEPT, IMPORT_COLUMNS, IMPORT_DATE_FORMAT, IMPORT_EXPIRY_FORMS, IMPORT_NUMBER_NOTE, IMPORT_MODES, IMPORT_STATUS_LABEL, importFileProblem,
  importTemplateCsv, importUploadRefusal, isSupplierRefusal, pharmacyStockApi, SUPPLIER_REFUSAL, type ApiError, type ImportMode, type ImportStatus,
  type InventoryImport,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, formatDateTime, Loading } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { newRequestKey, startOp } from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { useOneAtATime } from '../finance/finance.tsx';
import { CheckPanel, useDiscarded, useOwnedOp, usePharmacyId } from './ownedOp.tsx';
import { SupplierSelect, useActiveSuppliers } from './SupplierPicker.tsx';
import type { ImportArrival } from './ImportScreen.tsx';

export const importTone = (s: ImportStatus) =>
  s === 'committed' ? 'ok' : s === 'failed' ? 'danger' : s === 'partially_committed' || s === 'committing' ? 'warn' : undefined;

/** Only the file's name, the mode and the supplier are kept for an unconfirmed check, never its contents. */
interface PendingCheck { fileName: string; mode: ImportMode; supplierId?: string }

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

const TEMPLATE_NAME = 'stock-import-template.csv';

function Columns() {
  const { api } = useSession();
  const [file, setFile] = useState<{ url: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const ctrl = useRef<AbortController | null>(null);
  useEffect(() => () => { ctrl.current?.abort(); }, []);
  useEffect(() => () => { if (file) URL.revokeObjectURL(file.url); }, [file]);
  /**
   * WQ11c (owner, 22 Nov): the server's template (`GET /pharmacy-inventory-imports/template`, Q16c) when it answers one;
   * until then one made here with every column and an example row (expiry 31-12-2027, day first).
   */
  async function template() {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setBusy(true);
    let blob: Blob | null = null;
    let name = TEMPLATE_NAME;
    try {
      blob = await pharmacyStockApi(api).importTemplate(c.signal);
      if (blob && /sheet|excel/i.test(blob.type)) name = 'stock-import-template.xlsx';
    } catch {
      if (c.signal.aborted) return;
    } finally {
      if (ctrl.current === c) setBusy(false);
    }
    if (c.signal.aborted) return;
    const url = URL.createObjectURL(blob ?? new Blob([importTemplateCsv()], { type: 'text/csv' }));
    setFile({ url, name });
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  return (
    <section className="ws-section" aria-labelledby="cols-h">
      <h2 id="cols-h">1. Prepare the file</h2>
      <p>
        Use an Excel (.xlsx, .xls) or CSV file of up to 10 MB. Only the first sheet is read. The first row holds the column
        names below, in capitals or small letters; other columns are ignored. One row per batch.
      </p>
      <Alert tone="warn">
        <strong>Dates are read day first.</strong> Write expiry dates as {IMPORT_DATE_FORMAT}. 05-06-2027 is 5 June 2027, never 6 May.
        A file that writes a date month first (12/31/2027) has that date and every date like 05/06/2027 refused.
      </Alert>
      <div className="ws-actions">
        <Button variant="secondary" busy={busy} onClick={() => void template()}><Download size={16} aria-hidden="true" /> Download the template (with an example row)</Button>
        {file && <a href={file.url} download={file.name}>Save the template again</a>}
      </div>
      <p className="ws-muted">The template has every column and one example row. Delete the example row and add your own before importing.</p>
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
      <h3 id="expiry-h">Expiry date</h3>
      <p>Write it in one of these ways:</p>
      <ul className="ws-list" aria-labelledby="expiry-h">
        {IMPORT_EXPIRY_FORMS.map((f) => <li key={f}>{f}</li>)}
      </ul>
      <p className="ws-muted">A row with an expiry in any other form is shown with a problem and is not added.</p>
      <h3>Numbers and prices</h3>
      <p>{IMPORT_NUMBER_NOTE}</p>
      <p>
        A price cell left blank keeps the medicine’s current price. A price of 0 sets it to ₹0: the check shows every row that
        would. A new medicine without a selling price is not on sale until you price it.
      </p>
      <h3>New medicines</h3>
      <p>A medicine not in the list is added to it. It needs a prescription unless its row says “no” under <code>prescription required</code>.</p>
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
  const [supplierId, setSupplierId] = useState('');
  const [supplierError, setSupplierError] = useState<string | null>(null);
  const suppliers = useActiveSuppliers(pharmacyId);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  /** A recent import with this file's name, found by "Check": the person decides whether it is this upload. */
  const [candidate, setCandidate] = useState<InventoryImport | null>(null);

  const open = (r: InventoryImport, arrival?: ImportArrival) => {
    if (/^[0-9a-fA-F]{24}$/.test(r._id)) navigate(`/pharmacy/stock/imports/${r._id}`, arrival ? { state: arrival } : undefined);
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
        const body: PendingCheck = { fileName: chosen.name, mode, ...(supplierId ? { supplierId } : {}) };
        const r = await send(startOp(newRequestKey(), body), (b) => stock.previewImport(chosen, b.fileName, b.mode, b.supplierId));
        if (r.kind === 'ok') {
          void queryClient.invalidateQueries({ queryKey: ['pharmacy-inventory', pharmacyId, 'imports'] });
          // N2: the import page names a supplier only when the answer carries it, and says so when one was asked for.
          const asked = body.supplierId ? (suppliers.data ?? []).find((x) => x.supplierId === body.supplierId)?.displayName ?? 'a supplier' : undefined;
          open(r.value, asked ? { supplierAsked: asked } : undefined);
        }
        else if (r.kind === 'refused') {
          if (isSupplierRefusal(r.error)) {
            const words = SUPPLIER_REFUSAL[(r.error as ApiError).code ?? ''] ?? messageOf(r.error);
            setSupplierError(words);
            void suppliers.refetch();
            setRefused(words);
          } else setRefused(importUploadRefusal(r.error));
        }
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
            setCandidate(null);
            void queryClient.invalidateQueries({ queryKey: ['pharmacy-inventory', pharmacyId, 'imports'] });
            // A marker restored after a reload keeps no file name: nothing is matched for it (the list below shows every import).
            if (!op.body) return 'Its file name is not kept on this device. Look for it under Recent imports below, or upload the file again.';
            const recent = await stock.imports(1, 20);
            // Only an import of this file name started after this check was first sent (30 s allowed for clocks). It is
            // never opened on its own: an older or another upload of the same name could look the same.
            const since = op.firstAttemptAt - 30_000;
            const hit = recent.items.find((r) => r.fileName === op.body!.fileName && !!r.createdAt && Date.parse(r.createdAt) >= since);
            if (!hit) return 'It is not in your imports yet. It may still be on its way, or it never arrived.';
            setCandidate(hit);
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
          {candidate && (
            <div className="confirm" role="group" aria-label="Is this the import?">
              <div className="confirm-text">
                An import of {candidate.fileName} started at {formatTime(candidate.createdAt)}. Is this it?
              </div>
              <div className="confirm-actions">
                <Button onClick={() => { settle(op.requestKey); open(candidate); }}>Open it</Button>
                <Button variant="secondary" onClick={() => { setCandidate(null); settle(op.requestKey); }}>Upload again</Button>
              </div>
            </div>
          )}
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
          {suppliers.isError ? (
            <Alert tone="warn">Your suppliers could not be read ({messageOf(suppliers.error)}). You can check the file without one.</Alert>
          ) : (
            <SupplierSelect id="import-supplier" label="Supplier of this delivery (optional)" suppliers={suppliers.data ?? []} value={supplierId}
              noneLabel={suppliers.isPending ? 'Loading suppliers…' : 'Not said'} disabled={busy} error={supplierError ?? undefined}
              hint="Recorded with every row of the file that adds units. Shown in the stock history."
              onChange={(v) => { setSupplierId(v); setSupplierError(null); }} />
          )}
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

/** HH:MM in India time (24-hour). */
const formatTime = (value: string | undefined) =>
  (value ? new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Kolkata' }).format(new Date(value)) : '—');

const PAGE_SIZE = 20;

function History({ pharmacyId }: { pharmacyId: string }) {
  const { api } = useSession();
  const [page, setPage] = useState(1);
  const discarded = useDiscarded(pharmacyId);
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
                      <td>{r.status === 'previewed' && discarded.ids.includes(r._id)
                        ? <Badge>Discarded on this device</Badge>
                        : <Badge tone={importTone(r.status)}>{IMPORT_STATUS_LABEL[r.status] ?? r.status}</Badge>}</td>
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
