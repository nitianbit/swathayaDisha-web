import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useParams } from 'react-router';
import { ArrowLeft, FileText } from 'lucide-react';
import {
  DOCUMENT_KIND_LABEL, holdsAny, INVOICE_STATE_LABEL, invoicePdfName, MAX_CANCEL_REASON, MAX_NOTE, MAX_REFERENCE, OBJECT_ID_PATTERN,
  PAYMENT_MODES, type Invoice, type InvoiceEvent, type InvoicePaymentMode, type PaymentInput, type RefundInput,
} from '@jansetu/api';
import { Alert, Badge, Button, ErrorState, formatDateTime, Loading, TextArea, TextField } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { afterFailure, beginAttempt, newRequestKey, startOp, stillCurrent, type PendingOp } from '../../requests.ts';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { sniffDocument } from '../pharmacy/documents.ts';
import { money, useClinicDoctors } from './billing.tsx';
import { stateTone } from './InvoicesScreen.tsx';
import { useSession } from '../../session.tsx';
import { NoSuchPartner, scopeIdentity, useBranches, usePartnerScope, useWorkspacePartner, type ScopeContext } from './scope.tsx';

const MODE_LABEL = Object.fromEntries(PAYMENT_MODES.map((m) => [m.value, m.label])) as Record<InvoicePaymentMode, string>;
const GENDER_LABEL: Record<string, string> = { male: 'Male', female: 'Female', other: 'Other' };

/** One bill: what was issued (immutable), its payment and cancellation, its PDF; pay and cancel by permission. */
export function InvoiceScreen() {
  const ctx = usePartnerScope();
  const { invoiceId = '' } = useParams();
  if (!ctx || !OBJECT_ID_PATTERN.test(invoiceId)) return <NoSuchPartner />;
  // One subtree per partner and bill: an open payment or cancellation never carries over to another bill or partner.
  return <InvoiceDetail key={`${scopeIdentity(ctx)}:${invoiceId}`} ctx={ctx} invoiceId={invoiceId} />;
}

type Detail = { invoice: Invoice; events: InvoiceEvent[] };

/**
 * Folds a pay/cancel answer into the cached bill without ever going back in time: events are merged by version (one
 * per version), and the bill itself is replaced only by an equal or newer lifecycle version. So a late payment answer
 * cannot turn a cancelled bill (v2) back into "paid" (v1), and a cancellation answer cannot drop the payment event.
 */
export function mergeDetail(cur: Detail | undefined, r: { invoice: Invoice; event: InvoiceEvent }): Detail {
  const byVersion = new Map((cur?.events ?? []).map((e) => [e.version, e]));
  byVersion.set(r.event.version, r.event);
  const events = [...byVersion.values()].sort((a, b) => a.version - b.version);
  const invoice = !cur || r.invoice.lifecycleVersion >= cur.invoice.lifecycleVersion ? r.invoice : cur.invoice;
  return { invoice, events };
}

function InvoiceDetail({ ctx, invoiceId }: { ctx: ScopeContext; invoiceId: string }) {
  const queryClient = useQueryClient();
  const { memory } = useSession();
  const location = useLocation();
  const issuedNotice = (location.state as { issued?: string } | null)?.issued;
  const partner = useWorkspacePartner(ctx);
  const branches = useBranches(ctx);
  const doctors = useClinicDoctors(ctx, partner.data?.kind);
  const key = [...ctx.key, 'invoice', invoiceId];
  const q = useQuery({ queryKey: key, queryFn: () => ctx.billing.invoice(invoiceId) });
  const [notice, setNotice] = useState<string | null>(null);
  /** A refused action: the server's message stays while the bill shows its current state. */
  const [failure, setFailure] = useState<string | null>(null);
  /** One change at a time: while a payment or a cancellation is being sent, the other cannot start. */
  const [inFlight, setInFlight] = useState<'pay' | 'cancel' | null>(null);
  /**
   * A payment being sent or whose answer was lost, as an owned once-only record (`requests.ts` PendingOp): stored in
   * session memory per partner and bill BEFORE the request goes out (attempts counted), with a body-less reload marker.
   * While it exists no page offers another payment or a cancellation: it shows this payment and its recovery instead.
   * An answer may settle, replace or delete it only while its page is on screen AND the stored record is still the same
   * attempt (`owns`); otherwise it is left for the page that owns it. The bill as read also settles it (its receipt, or
   * another payment / a cancellation on the bill). The server records at most one payment per bill.
   */
  const paySlot = `invoice-payment:${scopeIdentity(ctx)}:${invoiceId}`;
  const [payOp, setPayOpState] = useState<PayOp | undefined>(() => memory.get<PayOp>(paySlot));
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const storePay = (op: PayOp | undefined) => {
    if (op) memory.set(paySlot, op); else memory.delete(paySlot);
    setPayOpState(op);
  };
  const owns = (op: PayOp) => live.current && stillCurrent(memory.get<PayOp>(paySlot), op);
  const inv = q.data?.invoice;
  const events = [...(q.data?.events ?? [])].sort((a, b) => a.version - b.version);
  /** The bill was read successfully after the payment was last sent (a cached read from before proves nothing). */
  const freshRead = !!payOp && q.isSuccess && !q.isFetching && q.dataUpdatedAt > payOp.lastAttemptAt;

  // The bill as read settles the stored payment: its receipt → recorded; another payment, or a cancellation → not
  // recorded. A restored record (no details after a reload) is settled by any payment or cancellation on the bill.
  useEffect(() => {
    if (!payOp || !q.data || !freshRead || inFlight === 'pay') return;
    const outcome = payOp.restored
      ? (q.data.events.some((e) => e.kind === 'payment') ? 'recorded' as const : q.data.invoice.lifecycleState === 'cancelled' ? { refused: 'the bill was cancelled.' } : 'unknown' as const)
      : paymentOutcome(q.data, payOp.body);
    if (outcome === 'unknown') return;
    if (!owns(payOp)) return;
    storePay(undefined);
    if (outcome === 'recorded') { setFailure(null); setNotice(payOp.restored ? 'The bill shows a payment.' : 'Payment recorded.'); }
    else { setNotice(null); setFailure(`Payment not recorded: ${outcome.refused}`); }
  }, [q.data, payOp, freshRead, inFlight]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Sends exactly `op` (a new payment, or the stored one unchanged), recorded as an attempt before the request. */
  async function sendPayment(op: PayOp) {
    const attempt = beginAttempt(op);
    storePay(attempt);
    setInFlight('pay');
    setFailure(null);
    setNotice(null);
    try {
      const r = await ctx.billing.recordPayment(invoiceId, attempt.body);
      queryClient.setQueryData<Detail>(key, (cur) => mergeDetail(cur, r)); // version-fenced: always safe to fold in
      if (!owns(attempt)) return; // a newer attempt or another page owns the record: it settles it
      storePay(undefined);
      // Q12: `replayed` (inside data) = this payment had already been recorded; the answer is its receipt.
      setNotice(r.replayed ? 'Payment recorded. It had already been recorded: nothing was recorded twice.' : 'Payment recorded.');
      void reload().catch(() => undefined);
    } catch (err) {
      if (!owns(attempt)) return;
      const next = afterFailure(attempt, err, messageOf(err));
      storePay(next ?? undefined);
      // Refused outright (e.g. "This bill is paid": someone else recorded another payment): the server's message.
      if (!next) setFailure(`Payment not recorded: ${messageOf(err)}`);
      void reload().catch(() => undefined);
    } finally {
      if (live.current) setInFlight(null);
    }
  }

  /** After any change or refusal, read the exact bill again (the server's state is what is shown). */
  const reload = async () => {
    await queryClient.invalidateQueries({ queryKey: key });
    await queryClient.invalidateQueries({ queryKey: [...ctx.key, 'invoices'] });
  };
  const changed = (r: { invoice: Invoice; event: InvoiceEvent }) => {
    queryClient.setQueryData<Detail>(key, (cur) => mergeDetail(cur, r));
    void reload();
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
      {payOp && canPay && (
        <UnconfirmedPayment op={payOp} totalMinor={inv?.totals.totalMinor} sending={inFlight === 'pay'}
          billUnpaid={freshRead && inv?.lifecycleState === 'issued'}
          onResend={() => void sendPayment(payOp)}
          onCheck={() => void q.refetch()}
          onForget={() => { if (owns(payOp)) storePay(undefined); }} />
      )}
      {q.isError && q.data && (
        <ErrorState message={`Could not refresh the bill: ${messageOf(q.error)}`} onRetry={() => void q.refetch()} />
      )}
      {q.isPending ? <Loading label="Loading the bill…" />
        : q.isError && !q.data ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
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
                        : <>Cancelled: “{e.reason}”{e.refund ? <> · money returned by {MODE_LABEL[e.refund.mode] ?? e.refund.mode}{e.refund.reference ? ` · reference ${e.refund.reference}` : ''}{e.refund.note ? ` · “${e.refund.note}”` : ''}</> : null}</>}
                      {' '}· {formatDateTime(e.at)}{e.byKind === 'admin' ? ' · by a Jansetu admin' : ''}
                    </li>
                  ))}
                </ul>
              )}
              <div className="ws-actions">
                {canPay && inv.lifecycleState === 'issued' && !payOp && (
                  <PaymentForm invoice={inv} locked={inFlight === 'cancel'} busy={inFlight === 'pay'}
                    onRecord={async (body) => sendPayment(startOp(newRequestKey(), body))} />
                )}
                {inv.lifecycleState !== 'cancelled' && canCancel && (
                  <CancelForm ctx={ctx} invoice={inv} locked={inFlight === 'pay' || !!payOp} onBusy={(b) => setInFlight(b ? 'cancel' : null)}
                    onDone={(r) => { changed(r); setFailure(null); setNotice(`Bill ${inv.serial} was cancelled.`); }}
                    onRefused={reload} />
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

/** A payment as an owned once-only record (the key is local: it only tells attempts and pages apart). */
type PayOp = PendingOp<PaymentInput>;

/** What the bill as read says about a payment sent without an answer. */
export function paymentOutcome(d: Detail, body: PaymentInput): 'recorded' | 'unknown' | { refused: string } {
  const paid = d.events.find((e) => e.kind === 'payment');
  if (paid) {
    if (paid.mode === body.mode && (paid.reference ?? '') === (body.reference ?? '')) return 'recorded';
    return { refused: `another payment was recorded first (${MODE_LABEL[paid.mode as InvoicePaymentMode] ?? paid.mode}${paid.reference ? ` · reference ${paid.reference}` : ''}).` };
  }
  if (d.invoice.lifecycleState === 'cancelled') return { refused: 'the bill was cancelled.' };
  return 'unknown';
}

function UnconfirmedPayment({ op, totalMinor, sending, billUnpaid, onResend, onCheck, onForget }: {
  op: PayOp; totalMinor: number | undefined; sending: boolean; billUnpaid: boolean;
  onResend: () => void; onCheck: () => void; onForget: () => void;
}) {
  const amount = totalMinor !== undefined ? ` of ${money(totalMinor)}` : '';
  if (op.restored) {
    return (
      <div className="confirm" role="group" aria-label="Unconfirmed payment">
        <Alert tone="warn">
          A payment{amount} was sent from this device before the page was reloaded, and its answer never arrived. Its details are
          not kept here. Check the bill: a payment on it settles this. The bill can only ever be paid once.
        </Alert>
        <div className="confirm-actions">
          <Button onClick={onCheck}>Check the bill</Button>
          {billUnpaid && (
            <ConfirmAction label="Record the payment again" confirmLabel="The bill is unpaid: record it again"
              consequence="The bill shows no payment. Recording one now is safe: if the earlier one arrives later, it is refused (a bill is paid once)."
              onConfirm={async () => onForget()} />
          )}
        </div>
      </div>
    );
  }
  const b = op.body;
  const what = `${amount} by ${MODE_LABEL[b.mode]}${b.reference ? ` (reference ${b.reference})` : ''}`;
  return (
    <div className="confirm" role="group" aria-label="Unconfirmed payment">
      <Alert tone="warn">
        {sending || (!op.uncertain && !op.error)
          ? `A payment${what} is being sent and has not been answered yet. `
          : `We could not confirm the payment${what} (${op.error ?? 'no answer'}). `}
        Send the same payment again if needed: if it was recorded, the server answers with it; it is never recorded twice.
        No other payment or cancellation can start until this is settled.
      </Alert>
      <div className="confirm-actions">
        <Button busy={sending} onClick={onResend}>Send the same payment again</Button>
        <Button variant="secondary" disabled={sending} onClick={onCheck}>Check the bill</Button>
      </div>
    </div>
  );
}

/** Mode and reference, then a confirmation: a recorded payment cannot be removed (the bill moves to Paid). */
function PaymentForm({ invoice, locked, busy, onRecord }: {
  invoice: Invoice; locked: boolean; busy: boolean; onRecord: (body: PaymentInput) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [mode, setMode] = useState<InvoicePaymentMode>('cash');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  if (!open) return <Button disabled={locked || busy} onClick={() => setOpen(true)}>Record payment</Button>;

  function review(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (reference.trim().length > MAX_REFERENCE) errs.reference = `Use at most ${MAX_REFERENCE} characters.`;
    if (note.trim().length > MAX_NOTE) errs.note = `Use at most ${MAX_NOTE} characters.`;
    setErrors(errs);
    if (!Object.keys(errs).length) setConfirming(true);
  }

  const body: PaymentInput = { mode, ...(reference.trim() ? { reference: reference.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}) };
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
          {locked && <p className="ws-muted">A cancellation of this bill is being sent; wait for its answer.</p>}
          <div className="confirm-actions">
            <Button busy={busy} disabled={locked} onClick={() => { setConfirming(false); setOpen(false); void onRecord(body); }}>Record {money(invoice.totals.totalMinor)} paid</Button>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>Back</Button>
          </div>
        </>
      )}
    </form>
  );
}

/**
 * Cancel with a reason, after a step that says what happens. Q10: a PAID bill needs how the money went back (mode,
 * reference, note; 400 REFUND_REQUIRED otherwise); an unpaid one takes none (NOTHING_TO_REFUND).
 */
function CancelForm({ ctx, invoice, locked, onBusy, onDone, onRefused }: {
  ctx: ScopeContext; invoice: Invoice; locked: boolean; onBusy: (busy: boolean) => void;
  onDone: (r: { invoice: Invoice; event: InvoiceEvent }) => void; onRefused: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [refundMode, setRefundMode] = useState<InvoicePaymentMode>('cash');
  const [refundRef, setRefundRef] = useState('');
  const [refundNote, setRefundNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const paid = invoice.lifecycleState === 'paid';

  if (!open) return <Button variant="secondary" disabled={locked} onClick={() => setOpen(true)}>Cancel bill</Button>;

  async function confirm() {
    const errs: Record<string, string> = {};
    if (reason.trim().length < 3) errs.reason = 'Give a reason (at least 3 characters).';
    else if (reason.trim().length > MAX_CANCEL_REASON) errs.reason = `Use at most ${MAX_CANCEL_REASON} characters.`;
    if (paid && refundRef.trim().length > MAX_REFERENCE) errs.refundRef = `Use at most ${MAX_REFERENCE} characters.`;
    if (paid && refundNote.trim().length > MAX_NOTE) errs.refundNote = `Use at most ${MAX_NOTE} characters.`;
    setErrors(errs);
    setError(null);
    if (Object.keys(errs).length) return;
    const refund: RefundInput | undefined = paid
      ? { mode: refundMode, ...(refundRef.trim() ? { reference: refundRef.trim() } : {}), ...(refundNote.trim() ? { note: refundNote.trim() } : {}) }
      : undefined;
    setBusy(true);
    onBusy(true);
    try {
      onDone(await ctx.billing.cancelInvoice(invoice._id, reason.trim(), refund));
      setOpen(false);
    } catch (err) {
      setError(messageOf(err));
      await onRefused(); // the bill as it is now (e.g. it was paid meanwhile: the money question appears)
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }

  return (
    <div className="confirm" role="group" aria-label="Cancel bill">
      <div className="confirm-text">
        Bill {invoice.serial} will be cancelled for good: it cannot be paid, edited or issued again, and its number is not reused.
        Its PDF will show “Cancelled” with your reason.
        {paid ? ` It was paid (${money(invoice.totals.totalMinor)}): give the money back to the customer and record how it went back.` : ''}
      </div>
      <TextArea label="Why is this bill cancelled?" value={reason} maxLength={MAX_CANCEL_REASON} error={errors.reason} onChange={(e) => setReason(e.target.value)} />
      {paid && (
        <div className="rx-form-row">
          <div className="j-field">
            <label htmlFor="refund-mode">Money returned by</label>
            <select id="refund-mode" value={refundMode} onChange={(e) => setRefundMode(e.target.value as InvoicePaymentMode)}>
              {PAYMENT_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </div>
          <TextField label="Refund reference (optional)" value={refundRef} maxLength={MAX_REFERENCE} error={errors.refundRef} onChange={(e) => setRefundRef(e.target.value)} />
          <TextField label="Refund note (optional)" value={refundNote} maxLength={MAX_NOTE} error={errors.refundNote} onChange={(e) => setRefundNote(e.target.value)} />
        </div>
      )}
      {error && <Alert>{error}</Alert>}
      {locked && <p className="ws-muted">A payment of this bill is being sent; wait for its answer.</p>}
      <div className="confirm-actions">
        <Button variant="danger" busy={busy} disabled={locked} onClick={() => void confirm()}>Cancel bill {invoice.serial}</Button>
        <Button variant="ghost" disabled={busy} onClick={() => { setOpen(false); setError(null); setErrors({}); }}>Back</Button>
      </div>
    </div>
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
