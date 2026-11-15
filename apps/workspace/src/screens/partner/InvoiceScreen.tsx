import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useParams } from 'react-router';
import { ArrowLeft, FileText } from 'lucide-react';
import {
  DOCUMENT_KIND_LABEL, holdsAny, INVOICE_STATE_LABEL, invoicePdfName, MAX_NOTE, MAX_REFERENCE, OBJECT_ID_PATTERN, PAYMENT_MODES,
  type Invoice, type InvoiceEvent, type InvoicePaymentMode,
} from '@jansetu/api';
import { Alert, Badge, Button, ErrorState, formatDateTime, Loading, TextField } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { sniffDocument } from '../pharmacy/documents.ts';
import { money, useClinicDoctors } from './billing.tsx';
import { stateTone } from './InvoicesScreen.tsx';
import { NoSuchPartner, usePartnerScope, useWorkspacePartner, type ScopeContext } from './scope.tsx';
import { useBranches } from './scope.tsx';

const MODE_LABEL = Object.fromEntries(PAYMENT_MODES.map((m) => [m.value, m.label])) as Record<InvoicePaymentMode, string>;
const GENDER_LABEL: Record<string, string> = { male: 'Male', female: 'Female', other: 'Other' };

/** One bill: what was issued (immutable), its payment and cancellation, its PDF; pay and cancel by permission. */
export function InvoiceScreen() {
  const ctx = usePartnerScope();
  const { invoiceId = '' } = useParams();
  if (!ctx || !OBJECT_ID_PATTERN.test(invoiceId)) return <NoSuchPartner />;
  return <InvoiceDetail ctx={ctx} invoiceId={invoiceId} />;
}

function InvoiceDetail({ ctx, invoiceId }: { ctx: ScopeContext; invoiceId: string }) {
  const queryClient = useQueryClient();
  const location = useLocation();
  const issuedNotice = (location.state as { issued?: string } | null)?.issued;
  const partner = useWorkspacePartner(ctx);
  const branches = useBranches(ctx);
  const doctors = useClinicDoctors(ctx, partner.data?.kind);
  const key = [...ctx.key, 'invoice', invoiceId];
  const q = useQuery({ queryKey: key, queryFn: () => ctx.billing.invoice(invoiceId) });
  const [notice, setNotice] = useState<string | null>(null);
  /** A refused payment: the server's message stays while the bill shows its current state. */
  const [failure, setFailure] = useState<string | null>(null);
  const inv = q.data?.invoice;
  const events = [...(q.data?.events ?? [])].sort((a, b) => a.version - b.version);

  /** After a change (or a refusal: the bill may have changed meanwhile), show the server's current bill. */
  const reload = async () => {
    await queryClient.invalidateQueries({ queryKey: key });
    await queryClient.invalidateQueries({ queryKey: [...ctx.key, 'invoices'] });
  };
  const changed = (r: { invoice: Invoice; event: InvoiceEvent }) => {
    queryClient.setQueryData(key, { invoice: r.invoice, events: [...events.filter((e) => e.version !== r.event.version), r.event] });
    void queryClient.invalidateQueries({ queryKey: [...ctx.key, 'invoices'] });
  };

  const branchName = inv ? branches.data?.find((b) => b._id === inv.branchId)?.name ?? `Branch …${inv.branchId.slice(-6)}` : '';
  const doctor = inv?.doctorId ? doctors.data?.find((d) => d.doctorId === inv.doctorId) : undefined;
  const canPay = holdsAny(ctx.actor, ['payments.record']);
  const canCancel = holdsAny(ctx.actor, ['invoices.cancel']);
  // `computeTotals`: inter-state (IGST) only when the customer's state is given and differs from the branch's.
  const interState = !!inv?.customer.placeOfSupply && inv.customer.placeOfSupply !== inv.supplier.placeOfSupply;

  return (
    <>
      <Link className="ws-back" to={ctx.link('invoices')}><ArrowLeft size={16} aria-hidden="true" /> Back to bills</Link>
      <PageHeading title={inv ? `Bill ${inv.serial}` : 'Bill'}>
        {ctx.adminHome ? <>Managing {partner.data?.name ?? 'this partner'} with owner authority. </> : null}
        {inv ? <>{DOCUMENT_KIND_LABEL[inv.documentKind]} · issued {formatDateTime(inv.issuedAt)} · {branchName}</> : null}
      </PageHeading>
      {issuedNotice && !notice && <Alert tone="ok">{issuedNotice}</Alert>}
      {notice && <Alert tone="ok">{notice}</Alert>}
      {q.isPending ? <Loading label="Loading the bill…" />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : inv && (
          <>
            <section className="ws-section" aria-labelledby="inv-state-h">
              <h2 id="inv-state-h">Status</h2>
              {failure && <Alert>{failure}</Alert>}
              <div><Badge tone={stateTone(inv.lifecycleState)}>{INVOICE_STATE_LABEL[inv.lifecycleState] ?? inv.lifecycleState}</Badge></div>
              {events.length === 0 ? <p className="ws-muted">No payment has been recorded.</p> : (
                <ul className="ws-list" aria-label="Payment and cancellation">
                  {events.map((e) => (
                    <li key={e.version}>
                      {e.kind === 'payment'
                        ? <>Paid by {MODE_LABEL[e.mode as InvoicePaymentMode] ?? e.mode}{e.reference ? ` · reference ${e.reference}` : ''}{e.note ? ` · “${e.note}”` : ''}</>
                        : <>Cancelled: “{e.reason}”</>}
                      {' '}· {formatDateTime(e.at)}{e.byKind === 'admin' ? ' · by a Jansetu admin' : ''}
                    </li>
                  ))}
                </ul>
              )}
              <div className="ws-actions">
                {inv.lifecycleState === 'issued' && canPay && <PaymentForm ctx={ctx} invoice={inv} onDone={(r) => { changed(r); setFailure(null); setNotice('Payment recorded.'); }}
                  onRefused={async (message) => { setNotice(null); setFailure(`Payment not recorded: ${message}`); await reload(); }} />}
                {inv.lifecycleState !== 'cancelled' && canCancel && (
                  <ConfirmAction label="Cancel bill" danger reason reasonLabel="Why is this bill cancelled?" confirmLabel={`Cancel bill ${inv.serial}`}
                    consequence={<>
                      Bill {inv.serial} will be cancelled for good: it cannot be paid, edited or issued again, and its number is not reused.
                      Its PDF will show “Cancelled” with your reason.
                      {inv.lifecycleState === 'paid' ? ' The payment recorded on it stays on record; giving money back to the customer is done outside Jansetu.' : ''}
                    </>}
                    onConfirm={async (reason) => {
                      try { changed(await ctx.billing.cancelInvoice(inv._id, reason)); setNotice(`Bill ${inv.serial} was cancelled.`); }
                      catch (err) { void reload(); throw err; }
                    }} />
                )}
              </div>
              {!canPay && !canCancel && <p className="ws-muted">You can view this bill; recording payments and cancelling need other permissions.</p>}
            </section>

            <PdfPanel ctx={ctx} invoice={inv} />

            <section className="ws-section" aria-labelledby="inv-parties-h">
              <h2 id="inv-parties-h">Supplier and customer</h2>
              <div className="rx-form-row">
                <dl className="ws-dl" aria-label="Supplier">
                  <dt>Supplier</dt><dd>{inv.supplier.name}{inv.supplier.legalName ? ` (${inv.supplier.legalName})` : ''}</dd>
                  <dt>Address</dt><dd>{inv.supplier.address}</dd>
                  {inv.supplier.gstin && <><dt>GSTIN</dt><dd>{inv.supplier.gstin}</dd></>}
                  {inv.supplier.pan && <><dt>PAN</dt><dd>{inv.supplier.pan}</dd></>}
                  <dt>State code</dt><dd>{inv.supplier.placeOfSupply}</dd>
                </dl>
                <dl className="ws-dl" aria-label="Customer">
                  <dt>Customer</dt><dd>{inv.customer.name}</dd>
                  {inv.customer.phone && <><dt>Phone</dt><dd>{inv.customer.phone}</dd></>}
                  {inv.customer.phone && <><dt>Jansetu account</dt><dd>{inv.customer.userId ? 'Linked: the bill is in the customer’s app under Bills' : 'Not linked'}</dd></>}
                  {inv.customer.age !== undefined && <><dt>Age</dt><dd>{inv.customer.age}</dd></>}
                  {inv.customer.gender && <><dt>Gender</dt><dd>{GENDER_LABEL[inv.customer.gender] ?? inv.customer.gender}</dd></>}
                  {inv.customer.gstin && <><dt>GSTIN</dt><dd>{inv.customer.gstin}</dd></>}
                  <dt>Place of supply</dt><dd>{inv.customer.placeOfSupply ?? inv.supplier.placeOfSupply}</dd>
                  {inv.doctorId && <><dt>Doctor</dt><dd>{doctor?.name ?? `Doctor …${inv.doctorId.slice(-6)}`}</dd></>}
                </dl>
              </div>
            </section>

            <section className="ws-section" aria-labelledby="inv-lines-h">
              <h2 id="inv-lines-h">Items</h2>
              <div className="ws-table-wrap">
                <table className="j-table">
                  <caption className="j-sr-only">Items on bill {inv.serial}</caption>
                  <thead>
                    <tr><th scope="col">Item</th><th scope="col">SAC/HSN</th><th scope="col">Qty</th><th scope="col">Unit price</th><th scope="col">Discount</th><th scope="col">Taxable value</th><th scope="col">GST</th></tr>
                  </thead>
                  <tbody>
                    {inv.items.map((l, i) => (
                      <tr key={i}>
                        <td>{l.description}</td><td>{l.sac ?? l.hsn ?? '—'}</td><td>{l.qty}</td><td>{money(l.unitPriceMinor)}</td>
                        <td>{l.discountMinor ? money(l.discountMinor) : '—'}</td><td>{money(l.amountMinor)}</td><td>{l.gstRate}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Totals totals={inv.totals} igst={interState} />
            </section>
          </>
        )}
    </>
  );
}

export function Totals({ totals, igst, label = 'Totals' }: { totals: Invoice['totals']; igst: boolean; label?: string }) {
  return (
    <dl className="ws-dl" aria-label={label}>
      <dt>Subtotal</dt><dd>{money(totals.subtotalMinor)}</dd>
      {totals.discountMinor > 0 && <><dt>Discount</dt><dd>− {money(totals.discountMinor)}</dd></>}
      <dt>Taxable value</dt><dd>{money(totals.taxableMinor)}</dd>
      {igst ? <><dt>IGST</dt><dd>{money(totals.igstMinor)}</dd></>
        : <><dt>CGST</dt><dd>{money(totals.cgstMinor)}</dd><dt>SGST</dt><dd>{money(totals.sgstMinor)}</dd></>}
      <dt><strong>Total</strong></dt><dd><strong>{money(totals.totalMinor)}</strong></dd>
    </dl>
  );
}

/** Mode and reference, then a confirmation: a recorded payment cannot be removed (the bill moves to Paid). */
function PaymentForm({ ctx, invoice, onDone, onRefused }: {
  ctx: ScopeContext; invoice: Invoice; onDone: (r: { invoice: Invoice; event: InvoiceEvent }) => void; onRefused: (message: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [mode, setMode] = useState<InvoicePaymentMode>('cash');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  if (!open) return <Button onClick={() => setOpen(true)}>Record payment</Button>;

  function review(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (reference.trim().length > MAX_REFERENCE) errs.reference = `Use at most ${MAX_REFERENCE} characters.`;
    if (note.trim().length > MAX_NOTE) errs.note = `Use at most ${MAX_NOTE} characters.`;
    setErrors(errs);
    if (!Object.keys(errs).length) setConfirming(true);
  }

  async function record() {
    setBusy(true);
    try {
      onDone(await ctx.billing.recordPayment(invoice._id, {
        mode, ...(reference.trim() ? { reference: reference.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}),
      }));
    } catch (err) {
      // E.g. "This bill is paid": an earlier answer was lost, or someone else recorded it. The page shows the server's
      // message and the bill as it is now.
      setConfirming(false);
      await onRefused(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="confirm" noValidate onSubmit={review} aria-label="Record payment">
      {!confirming ? (
        <>
          <div className="rx-form-row">
            <div className="j-field">
              <label htmlFor="pay-mode">Paid by</label>
              <select id="pay-mode" value={mode} onChange={(e) => setMode(e.target.value as InvoicePaymentMode)}>
                {PAYMENT_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
            <TextField label="Reference (optional)" hint="UPI or card reference, cheque number…" value={reference} maxLength={MAX_REFERENCE}
              error={errors.reference} onChange={(e) => setReference(e.target.value)} />
            <TextField label="Note (optional)" value={note} maxLength={MAX_NOTE} error={errors.note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <div className="confirm-actions">
            <Button type="submit">Continue</Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>Back</Button>
          </div>
        </>
      ) : (
        <>
          <div className="confirm-text">
            Record {money(invoice.totals.totalMinor)} as paid by {MODE_LABEL[mode]}{reference.trim() ? ` (reference ${reference.trim()})` : ''} for bill {invoice.serial}?
            The bill will show Paid. A recorded payment cannot be changed or removed.
          </div>
          <div className="confirm-actions">
            <Button busy={busy} onClick={() => void record()}>Record {money(invoice.totals.totalMinor)} paid</Button>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>Back</Button>
          </div>
        </>
      )}
    </form>
  );
}

/**
 * The PDF is fetched with the session's token and shown from an in-memory blob: no token or link to the file ever
 * appears in a URL. Only content that really is a PDF is shown.
 */
function PdfPanel({ ctx, invoice }: { ctx: ScopeContext; invoice: Invoice }) {
  const [pdf, setPdf] = useState<{ url: string; version: number } | null>(null);
  const [loading, setLoading] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fetching = useRef<AbortController | null>(null);
  useEffect(() => () => { if (pdf) URL.revokeObjectURL(pdf.url); }, [pdf]);
  useEffect(() => () => fetching.current?.abort(), []);

  async function open(version: number) {
    fetching.current?.abort();
    const ctrl = new AbortController();
    fetching.current = ctrl;
    setLoading(version);
    setError(null);
    setPdf(null);
    try {
      const blob = await ctx.billing.invoicePdf(invoice._id, version, ctrl.signal);
      const { kind } = await sniffDocument(blob);
      if (ctrl.signal.aborted) return;
      if (kind !== 'pdf') { setError('The server did not return a PDF. Try again.'); return; }
      setPdf({ url: URL.createObjectURL(new Blob([blob], { type: 'application/pdf' })), version });
    } catch (err) {
      if (!ctrl.signal.aborted) setError(messageOf(err));
    } finally {
      if (fetching.current === ctrl) setLoading(null);
    }
  }

  const current = invoice.lifecycleVersion;
  return (
    <section className="ws-section" aria-labelledby="inv-pdf-h">
      <h2 id="inv-pdf-h">PDF</h2>
      <div className="ws-actions">
        <Button variant="secondary" busy={loading === current} onClick={() => void open(current)}>
          <FileText size={16} aria-hidden="true" /> {current > 0 ? 'Open PDF (current)' : 'Open PDF'}
        </Button>
        {current > 0 && (
          <Button variant="secondary" busy={loading === 0} onClick={() => void open(0)}>
            <FileText size={16} aria-hidden="true" /> Open PDF as issued
          </Button>
        )}
      </div>
      {error && <Alert>Could not open the PDF: {error}</Alert>}
      {pdf && (
        <div className="rx-preview">
          <div className="rx-pdf">
            <iframe src={pdf.url} title={`Bill ${invoice.serial} PDF`} />
            <a href={pdf.url} download={invoicePdfName(invoice.serial, pdf.version)}>Save the PDF</a>
          </div>
        </div>
      )}
    </section>
  );
}
