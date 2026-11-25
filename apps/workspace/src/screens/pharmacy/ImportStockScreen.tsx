import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { ArrowLeft, Download } from 'lucide-react';
import {
  IMPORT_ACCEPT, IMPORT_COLUMNS, IMPORT_DATE_FORMAT, IMPORT_EXPIRY_FORMS, IMPORT_NUMBER_NOTE, IMPORT_MODES, IMPORT_STATUS_LABEL, importFileProblem,
  importTemplateCsv, importUploadRefusal, isSupplierRefusal, pharmacyStockApi, SUPPLIER_REFUSAL, type ApiError, type ImportMode, type ImportStatus,
  type InventoryImport,
} from '@jansetu/api';
import { formatClock } from '@jansetu/i18n';
import { Alert, Badge, Button, Empty, ErrorState, formatDateTime, Loading } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { newRequestKey, startOp } from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { useOneAtATime } from '../finance/finance.tsx';
import { CheckPanel, useDiscarded, useOwnedOp, usePharmacyId } from './ownedOp.tsx';
import { SupplierSelect, useActiveSuppliers } from './SupplierPicker.tsx';
import type { ImportArrival } from './ImportScreen.tsx';
import { t } from '../../i18n/pharmacy/index.ts';

export const importTone = (s: ImportStatus) =>
  s === 'committed' ? 'ok' : s === 'failed' ? 'danger' : s === 'partially_committed' || s === 'committing' ? 'warn' : undefined;

/** Only the file's name, the mode and the supplier are kept for an unconfirmed check, never its contents. */
interface PendingCheck { fileName: string; mode: ImportMode; supplierId?: string }

/** WQ10a: upload a stock file to be checked (nothing changes in stock yet), and the list of earlier imports. */
export function ImportStockScreen() {
  const pharmacyId = usePharmacyId();
  return (
    <>
      <Link to="/pharmacy/stock" className="ws-back"><ArrowLeft size={16} aria-hidden="true" />{t('common.stock')}</Link>
      <PageHeading title={t('common.importStockFromAFile')}>{t('importStock.uploadASpreadsheetOfThe')}</PageHeading>
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
      <h2 id="cols-h">{t('importStock.n1PrepareTheFile')}</h2>
      <p>{t('importStock.useAnExcelXlsxXls')}</p>
      <Alert tone="warn">
        <strong>{t('importStock.datesAreReadDayFirst')}</strong>{t('importStock.writeExpiryDatesAs')}{IMPORT_DATE_FORMAT}{t('importStock.n05062027Is5')}</Alert>
      <div className="ws-actions">
        <Button variant="secondary" busy={busy} onClick={() => void template()}><Download size={16} aria-hidden="true" />{t('importStock.downloadTheTemplateWithAn')}</Button>
        {file && <a href={file.url} download={file.name}>{t('importStock.saveTheTemplateAgain')}</a>}
      </div>
      <p className="ws-muted">{t('importStock.theTemplateHasEveryColumn')}</p>
      <div className="ws-table-wrap">
        <table className="j-table">
          <caption className="j-sr-only">{t('importStock.columnsOfAStockFile')}</caption>
          <thead><tr><th scope={'col'}>{t('importStock.columnName')}</th><th scope={'col'}>{t('importStock.needed')}</th><th scope={'col'}>{t('importStock.whatToWrite')}</th></tr></thead>
          <tbody>
            {IMPORT_COLUMNS.map((c) => (
              <tr key={c.header}><td><code>{c.header}</code></td><td>{c.need}</td><td>{c.format}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3 id="expiry-h">{t('common.expiryDate')}</h3>
      <p>{t('importStock.writeItInOneOf')}</p>
      <ul className="ws-list" aria-labelledby="expiry-h">
        {IMPORT_EXPIRY_FORMS.map((f) => <li key={f}>{f}</li>)}
      </ul>
      <p className="ws-muted">{t('importStock.aRowWithAnExpiry')}</p>
      <h3>{t('importStock.numbersAndPrices')}</h3>
      <p>{IMPORT_NUMBER_NOTE}</p>
      <p>{t('importStock.aPriceCellLeftBlank')}</p>
      <h3>{t('importStock.newMedicines')}</h3>
      <p>{t('importStock.aMedicineNotInThe')}<code>{t('importStock.prescriptionRequired')}</code>.</p>
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
      <h2 id="upload-h">{t('importStock.n2UploadAndCheck')}</h2>
      {op && !busy ? (
        <CheckPanel label={t('importStock.unconfirmedFileCheck')}
          onCheck={async () => {
            setCandidate(null);
            void queryClient.invalidateQueries({ queryKey: ['pharmacy-inventory', pharmacyId, 'imports'] });
            // A marker restored after a reload keeps no file name: nothing is matched for it (the list below shows every import).
            if (!op.body) return t('importStock.itsFileNameIsNot');
            const recent = await stock.imports(1, 20);
            // Only an import of this file name started after this check was first sent (30 s allowed for clocks). It is
            // never opened on its own: an older or another upload of the same name could look the same.
            const since = op.firstAttemptAt - 30_000;
            const hit = recent.items.find((r) => r.fileName === op.body!.fileName && !!r.createdAt && Date.parse(r.createdAt) >= since);
            if (!hit) return t('importStock.itIsNotInYour');
            setCandidate(hit);
            return null;
          }}
          forget={{
            label: t('common.forgetIt'), confirmLabel: t('importStock.forgetItAndUploadAgain'),
            consequence: t('importStock.checkingAFileAddsNothing'),
            onForget: () => settle(op.requestKey),
          }}>
          <Alert tone="warn">{t('importStock.theAnswerToTheFile')}{op.error ? ` (${op.error})` : ''}{t('importStock.nothingWasAddedToStock')}{op.body ? t('importStock.file', { fileName: op.body.fileName }) : ''}
          </Alert>
          {candidate && (
            <div className="confirm" role="group" aria-label={t('importStock.isThisTheImport')}>
              <div className="confirm-text">{t('importStock.anImportOf')}{candidate.fileName}{t('importStock.startedAt')}{formatTime(candidate.createdAt)}{t('importStock.isThisIt')}</div>
              <div className="confirm-actions">
                <Button onClick={() => { settle(op.requestKey); open(candidate); }}>{t('importStock.openIt')}</Button>
                <Button variant="secondary" onClick={() => { setCandidate(null); settle(op.requestKey); }}>{t('importStock.uploadAgain')}</Button>
              </div>
            </div>
          )}
        </CheckPanel>
      ) : (
        <form className="rx-form" noValidate onSubmit={(e) => void submit(e)}>
          <fieldset className="ws-checks" disabled={busy}>
            <legend>{t('importStock.whichRowsToAdd')}</legend>
            {IMPORT_MODES.map((m) => (
              <label key={m.value} className="ws-check">
                <input type="radio" name="import-mode" value={m.value} checked={mode === m.value} onChange={() => setMode(m.value)} />
                <span>{m.label} <span className="ws-muted">— {m.hint}</span></span>
              </label>
            ))}
          </fieldset>
          {suppliers.isError ? (
            <Alert tone="warn">{t('common.yourSuppliersCouldNotBe')}{messageOf(suppliers.error)}{t('importStock.youCanCheckTheFile')}</Alert>
          ) : (
            <SupplierSelect id="import-supplier" label={t('importStock.supplierOfThisDeliveryOptional')} suppliers={suppliers.data ?? []} value={supplierId}
              noneLabel={suppliers.isPending ? t('common.loadingSuppliers') : t('common.notSaid')} disabled={busy} error={supplierError ?? undefined}
              hint={t('importStock.recordedWithEveryRowOf')}
              onChange={(v) => { setSupplierId(v); setSupplierError(null); }} />
          )}
          <div className="j-field">
            <label htmlFor="import-file">{t('importStock.stockFile')}</label>
            <input id="import-file" type="file" accept={IMPORT_ACCEPT} disabled={busy}
              aria-invalid={fileError ? true : undefined} aria-describedby={fileError ? 'import-file-error' : 'import-file-hint'}
              onChange={(e) => { setFile(e.target.files?.[0] ?? null); setFileError(null); setRefused(null); }} />
            <span id="import-file-hint" className="j-field__hint">{t('importStock.xlsxXlsOrCsvUp')}</span>
            {fileError && <span id="import-file-error" className="j-field__error">{fileError}</span>}
          </div>
          {refused && <Alert>{t('importStock.theFileWasNotChecked')}{refused}</Alert>}
          <div><Button type="submit" busy={busy}>{t('importStock.checkTheFile')}</Button></div>
        </form>
      )}
    </section>
  );
}

/** HH:MM in India time (24-hour). */
const formatTime = (value: string | undefined) =>
  (value ? formatClock(new Date(value)) : '—');

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
      <h2 id="history-h">{t('importStock.recentImports')}</h2>
      {q.isPending ? <Loading label={t('importStock.loadingImports')} />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : q.data.items.length === 0 ? <Empty title={t('importStock.noImportsYet')}>{t('importStock.filesYouUploadAreListed')}</Empty>
        : (
          <>
            <div className="ws-table-wrap">
              <table className="j-table">
                <caption className="j-sr-only">{t('importStock.stockFilesUploadedNewestFirst')}</caption>
                <thead>
                  <tr><th scope={'col'}>{t('importStock.uploaded')}</th><th scope={'col'}>{t('importStock.file2')}</th><th scope={'col'}>{t('common.status')}</th><th scope={'col'}>{t('common.rows')}</th><th scope={'col'}>{t('common.added')}</th></tr>
                </thead>
                <tbody>
                  {q.data.items.map((r) => (
                    <tr key={r._id}>
                      <td><Link to={`/pharmacy/stock/imports/${r._id}`}>{formatDateTime(r.createdAt)}</Link></td>
                      <td>{r.fileName}</td>
                      <td>{r.status === 'previewed' && discarded.ids.includes(r._id)
                        ? <Badge>{t('common.discardedOnThisDevice')}</Badge>
                        : <Badge tone={importTone(r.status)}>{IMPORT_STATUS_LABEL[r.status] ?? r.status}</Badge>}</td>
                      <td>{r.totalRows} ({r.validRows}{t('importStock.ready')}{r.errorRows}{t('importStock.withProblems')}</td>
                      <td>{r.committedRows ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {q.data.totalPages > 1 && (
              <nav className="ws-pager" aria-label={t('common.pages')}>
                <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>{t('common.previous')}</Button>
                <span>{t('common.page')}{page}{t('common.of')}{q.data.totalPages}</span>
                <Button variant="secondary" disabled={page >= q.data.totalPages} onClick={() => setPage(page + 1)}>{t('common.next')}</Button>
              </nav>
            )}
          </>
        )}
    </section>
  );
}
