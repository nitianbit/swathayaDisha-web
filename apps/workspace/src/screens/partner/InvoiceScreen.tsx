import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useParams } from 'react-router';
import { ArrowLeft, FileText } from 'lucide-react';
import {
  ApiError, DOCUMENT_KIND_LABEL, dueOf, holdsAny, INVOICE_STATE_LABEL, invoicePdfName, MAX_CANCEL_REASON, MAX_NOTE, MAX_PAYMENT_SPLITS, MAX_REFERENCE,
  OBJECT_ID_PATTERN, paidOf, paiseToInput, PAYMENT_MODES, paymentProblem, rupeesToPaise, takesPayment, type Invoice, type InvoiceEvent,
  type InvoicePaymentMode, type PaymentInput, type PaymentSplit, type RefundInput,
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
/** Q14 refusals of a payment, in words a cashier can act on (the server's message is the fallback). */
const PAY_REFUSAL: Record<string, string> = {
  LIFECYCLE_VERSION_CONFLICT: 'The bill changed while you were recording this (another payment or a cancellation), so nothing was recorded. Check what is due now and try again.',
  AMOUNT_EXCEEDS_DUE: 'That is more than is still due on this bill (it changed meanwhile), so nothing was recorded. Check what is due now.',
  PART_PAYMENTS_NOT_ALLOWED: 'This partner takes full payment only, so nothing was recorded. Record everything that is due.',
};
const payRefusal = (err: unknown) => (err instanceof ApiError && err.code && PAY_REFUSAL[err.code]) || messageOf(err);
/** Q14 review: 503 INVOICE_INDEXES_OUTDATED: this payment's insert was refused (its message is shown as the server gives it). */
const isIndexesOutdated = (err: unknown) => err instanceof ApiError && err.status === 503 && err.code === 'INVOICE_INDEXES_OUTDATED';
/** 409s the server answers only after finding no payment under this key, for a request that can never pass as it is. */
const REFUSED_409 = new Set(['PART_PAYMENTS_NOT_ALLOWED', 'AMOUNT_EXCEEDS_DUE', 'PAYMENT_METHOD_REQUIRED', 'REQUEST_KEY_REQUIRED', 'INVALID_AMOUNT']);
/**
 * A keyed payment refused for good, on ANY attempt: the server looks for this key's payment first (a recorded one is
 * answered as a replay) and these refusals abort the transaction, so nothing was recorded under the key. A version
 * conflict, a state conflict ("paid", "cancelled"), a network loss or another 5xx stays unknown: an earlier attempt of
 * the same payment may have committed in between.
 */
export function paymentRefusedForGood(err: unknown): boolean {
  if (isIndexesOutdated(err)) return true;
  if (!(err instanceof ApiError)) return false;
  if ([400, 403, 404, 422].includes(err.status)) return true;
  return err.status === 409 && !!err.code && REFUSED_409.has(err.code);
}
/** Shown when the bill moved on while a payment or a cancellation was being reviewed. */
export const BILL_CHANGED = 'This bill changed — check the amounts again.';
/** What the payment form produces; the key and the version it was decided on are added when it is sent. */
type PaymentDraft = { note?: string } & ({ splits: PaymentSplit[] } | { mode: InvoicePaymentMode });

/** How a payment was made: its methods (each with its amount when there are several), references, and the amount. */
export function paymentText(e: Pick<InvoiceEvent, 'mode' | 'reference' | 'splits' | 'amountMinor'>): string {
  const parts: PaymentSplit[] = e.splits?.length ? e.splits : e.mode ? [{ mode: e.mode, amountMinor: e.amountMinor ?? 0, reference: e.reference }] : [];
  if (parts.length <= 1) {
    const p = parts[0];
    return `Paid by ${p ? MODE_LABEL[p.mode] ?? p.mode : 'an unrecorded method'}${p?.reference ? ` · reference ${p.reference}` : ''}${e.amountMinor ? ` · ${money(e.amountMinor)}` : ''}`;
  }
  const list = parts.map((p) => `${MODE_LABEL[p.mode] ?? p.mode} ${money(p.amountMinor)}${p.reference ? ` (reference ${p.reference})` : ''}`).join(' + ');
  return `Paid by ${list} · ${money(e.amountMinor ?? parts.reduce((n, p) => n + p.amountMinor, 0))} in all`;
}
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

  // The bill as read settles the stored payment (Q14: every payment carries its key): its own receipt → recorded; the
  // bill moved past the version it named, or was cancelled → never recorded. A restored record (no details after a
  // reload) is settled by its receipt or a cancellation; otherwise a new payment may be recorded once the bill is read.
  useEffect(() => {
    if (!payOp || !q.data || !freshRead || inFlight === 'pay') return;
    const outcome = paymentOutcome(q.data, payOp);
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
      const next = paymentRefusedForGood(err) ? null : afterFailure(attempt, err, messageOf(err));
      storePay(next ?? undefined);
      // Refused outright (e.g. "This bill is paid": someone else recorded another payment): the server's message.
      if (!next) setFailure(`Payment not recorded: ${payRefusal(err)}`);
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
        <UnconfirmedPayment op={payOp} sending={inFlight === 'pay'}
          billUnpaid={freshRead && !!inv && takesPayment(inv) && !events.some((e) => e.requestKey === payOp.requestKey)}
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
              {inv.lifecycleState !== 'cancelled' && (
                <dl className="ws-dl" aria-label="Paid and due">
                  <dt>Paid</dt><dd>{money(paidOf(inv))} of {money(inv.totals.totalMinor)}</dd>
                  <dt>Due</dt><dd>{money(dueOf(inv))}</dd>
                </dl>
              )}
              {inv.lifecycleState === 'cancelled' && paidOf(inv) > 0 && <p className="ws-muted">{money(paidOf(inv))} had been paid and was returned to the customer.</p>}
              {events.length === 0 ? <p className="ws-muted">No payment has been recorded.</p> : (
                <ul className="ws-list" aria-label="Payment and cancellation">
                  {events.map((e) => (
                    <li key={e.version}>
                      {e.kind === 'payment'
                        ? <>{paymentText(e)}{e.note ? ` · “${e.note}”` : ''}</>
                        : <>Cancelled: “{e.reason}”{e.refund ? <> · money returned by {MODE_LABEL[e.refund.mode] ?? e.refund.mode}{e.refund.reference ? ` · reference ${e.refund.reference}` : ''}{e.refund.note ? ` · “${e.refund.note}”` : ''}{e.refund.amountMinor ? ` · ${money(e.refund.amountMinor)} returned` : ''}</> : null}</>}
                      {' '}· {formatDateTime(e.at)}{e.byKind === 'admin' ? ' · by a Jansetu admin' : ''}
                    </li>
                  ))}
                </ul>
              )}
              <div className="ws-actions">
                {canPay && takesPayment(inv) && !payOp && (
                  <PaymentForm invoice={inv} allowPartPayments={partner.data?.allowPartPayments === true} locked={inFlight === 'cancel'} busy={inFlight === 'pay'}
                    onRecord={async (draft, reviewedVersion) => {
                      // Q14: the server's request key and the bill version this payment was REVIEWED on (captured when
                      // its confirmation opened), never the version on screen at the click.
                      const requestKey = newRequestKey();
                      await sendPayment(startOp(requestKey, { ...draft, requestKey, expectedLifecycleVersion: reviewedVersion } as PaymentInput));
                    }} />
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
                  {inv.appointmentId && (
                    <><dt>Appointment</dt><dd>
                      Clinic appointment …{inv.appointmentId.slice(-6)}
                      {' · '}<Link to={ctx.link('invoices')} state={{ appointmentId: inv.appointmentId }}>All bills of this appointment</Link>
                    </dd></>
                  )}
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

/**
 * A payment as an owned once-only record. Q14: its key is the server's request key (the same key and content answer the
 * payment already recorded), and the body names the bill version it was decided on.
 */
type PayOp = PendingOp<PaymentInput>;

/**
 * What the bill as read says about a payment sent without an answer (Q14). Its own receipt (an event with its key) →
 * recorded. Otherwise, once the bill is cancelled, or has moved past the version the payment named (another payment or
 * a cancellation took that version), it can never be recorded: every payment is a compare-and-set on that version.
 * A restored record has no version: only its receipt or a cancellation decide it.
 */
export function paymentOutcome(d: Detail, op: Pick<PayOp, 'requestKey' | 'body' | 'restored'>): 'recorded' | 'unknown' | { refused: string } {
  if (d.events.some((e) => e.kind === 'payment' && e.requestKey === op.requestKey)) return 'recorded';
  if (d.invoice.lifecycleState === 'cancelled') return { refused: 'the bill was cancelled.' };
  const named = op.restored ? undefined : op.body?.expectedLifecycleVersion;
  if (named !== undefined && d.invoice.lifecycleVersion > named) {
    const other = d.events.find((e) => e.version === named + 1);
    return { refused: other?.kind === 'payment' ? `another payment was recorded first (${paymentText(other)}).` : 'the bill changed before it arrived.' };
  }
  return 'unknown';
}

const splitsTotal = (splits: readonly PaymentSplit[]) => splits.reduce((n, x) => n + x.amountMinor, 0);
/** "of ₹1,008.00 by UPI (reference UTR9)", or with several methods "of ₹1,008.00 (Cash ₹500.00 + UPI ₹508.00)". */
function payWords(b: PaymentInput): string {
  if (!b.splits) return ` of ${money(0)} by ${MODE_LABEL[b.mode]}`;
  if (b.splits.length === 1) {
    const x = b.splits[0]!;
    return ` of ${money(x.amountMinor)} by ${MODE_LABEL[x.mode]}${x.reference ? ` (reference ${x.reference})` : ''}`;
  }
  return ` of ${money(splitsTotal(b.splits))} (${b.splits.map((x) => `${MODE_LABEL[x.mode]} ${money(x.amountMinor)}${x.reference ? `, reference ${x.reference}` : ''}`).join(' + ')})`;
}

function UnconfirmedPayment({ op, sending, billUnpaid, onResend, onCheck, onForget }: {
  op: PayOp; sending: boolean; billUnpaid: boolean;
  onResend: () => void; onCheck: () => void; onForget: () => void;
}) {
  if (op.restored) {
    return (
      <div className="confirm" role="group" aria-label="Unconfirmed payment">
        <Alert tone="warn">
          A payment was sent from this device before the page was reloaded, and its answer never arrived. Its details are
          not kept here. Check the bill: its receipt on the bill settles this.
        </Alert>
        <div className="confirm-actions">
          <Button onClick={onCheck}>Check the bill</Button>
          {billUnpaid && (
            <ConfirmAction label="Record the payment again" confirmLabel="The bill is unpaid: record it again"
              consequence="The bill shows no receipt of it. Recording a payment now is safe: every payment names the bill version it was decided on, so if the earlier one arrives later only one of them is recorded."
              onConfirm={async () => onForget()} />
          )}
        </div>
      </div>
    );
  }
  const what = payWords(op.body);
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

type SplitDraft = { key: number; mode: InvoicePaymentMode; amount: string; reference: string };
let splitSeq = 0;
/** "", " (method 2)", … — each method's fields get their own label. */
const nth = (i: number) => (i === 0 ? '' : ` (method ${i + 1})`);

/**
 * Q14: one payment, in one or several methods (e.g. cash + UPI) whose amounts add up to it, then a confirmation: a
 * recorded payment cannot be removed. Without part payments (the partner's setting) the amounts must add up to all that
 * is due; with them, to anything up to it. Never more than is due (the server refuses it too: AMOUNT_EXCEEDS_DUE).
 */
type OnRecord = (body: PaymentDraft, reviewedVersion: number) => Promise<void>;

/**
 * The bill version a form was reviewed on: when the bill moves on (another payment, a cancellation) while the form is
 * open, the confirmation closes and the person is told to check the amounts again.
 */
function useReviewGuard(version: number, open: boolean, close: () => void) {
  const [changed, setChanged] = useState(false);
  const seen = useRef(version);
  useEffect(() => {
    if (seen.current === version) return;
    seen.current = version;
    if (open) { close(); setChanged(true); }
  }, [version]); // eslint-disable-line react-hooks/exhaustive-deps
  return { changed, clear: () => setChanged(false) };
}

function PaymentForm({ invoice, allowPartPayments, locked, busy, onRecord }: {
  invoice: Invoice; allowPartPayments: boolean; locked: boolean; busy: boolean;
  onRecord: OnRecord;
}) {
  if (invoice.totals.totalMinor === 0) return <ZeroBillPayment invoice={invoice} locked={locked} busy={busy} onRecord={onRecord} />;
  return <SplitPaymentForm invoice={invoice} allowPartPayments={allowPartPayments} locked={locked} busy={busy} onRecord={onRecord} />;
}

/** Q14 review: a bill of ₹0 is marked paid with a plain method (there is no amount to split). */
function ZeroBillPayment({ invoice, locked, busy, onRecord }: { invoice: Invoice; locked: boolean; busy: boolean; onRecord: OnRecord }) {
  const [open, setOpen] = useState<{ version: number } | null>(null);
  const [mode, setMode] = useState<InvoicePaymentMode>('cash');
  const guard = useReviewGuard(invoice.lifecycleVersion, !!open, () => setOpen(null));
  if (!open) {
    return (
      <>
        {guard.changed && <Alert tone="warn">{BILL_CHANGED}</Alert>}
        <Button disabled={locked || busy} onClick={() => { guard.clear(); setOpen({ version: invoice.lifecycleVersion }); }}>Record payment</Button>
      </>
    );
  }
  return (
    <div className="confirm" role="group" aria-label="Record payment">
      <div className="j-field">
        <label htmlFor="pay-zero-mode">Paid by</label>
        <select id="pay-zero-mode" value={mode} onChange={(e) => setMode(e.target.value as InvoicePaymentMode)}>
          {PAYMENT_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      </div>
      <div className="confirm-text">Bill {invoice.serial} is for {money(0)}. Mark it as paid? It will show Paid; this cannot be changed or removed.</div>
      <div className="confirm-actions">
        <Button busy={busy} disabled={locked} onClick={() => { const v = open.version; setOpen(null); void onRecord({ mode }, v); }}>Mark as paid</Button>
        <Button variant="ghost" disabled={busy} onClick={() => setOpen(null)}>Back</Button>
      </div>
    </div>
  );
}

function SplitPaymentForm({ invoice, allowPartPayments, locked, busy, onRecord }: {
  invoice: Invoice; allowPartPayments: boolean; locked: boolean; busy: boolean;
  onRecord: OnRecord;
}) {
  const due = dueOf(invoice);
  const [open, setOpen] = useState(false);
  /** The version, due and amounts the person reviewed (captured when the confirmation opens): exactly what is sent. */
  const [reviewed, setReviewed] = useState<{ version: number; due: number; body: { splits: PaymentSplit[]; note?: string } } | null>(null);
  const confirming = !!reviewed;
  const setConfirming = (on: false) => { if (!on) setReviewed(null); };
  const guard = useReviewGuard(invoice.lifecycleVersion, open, () => setReviewed(null));
  const [rows, setRows] = useState<SplitDraft[]>(() => [{ key: ++splitSeq, mode: 'cash', amount: paiseToInput(due), reference: '' }]);
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  if (!open) return <Button disabled={locked || busy} onClick={() => { guard.clear(); setOpen(true); }}>Record payment</Button>;

  const splits = rows.map((r) => ({ mode: r.mode, amountMinor: rupeesToPaise(r.amount), reference: r.reference.trim() }));
  const total = splits.reduce((n, x) => n + (x.amountMinor ?? 0), 0);
  const set = (key: number, patch: Partial<SplitDraft>) => { setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r))); setConfirming(false); };

  function review(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    rows.forEach((r) => {
      const a = rupeesToPaise(r.amount);
      if (a === null || a <= 0) errs[`amount${r.key}`] = r.amount.trim() ? 'Enter rupees, like 500 or 500.50.' : 'Enter the amount.';
      if (r.reference.trim().length > MAX_REFERENCE) errs[`reference${r.key}`] = `Use at most ${MAX_REFERENCE} characters.`;
    });
    if (note.trim().length > MAX_NOTE) errs.note = `Use at most ${MAX_NOTE} characters.`;
    const problem = Object.keys(errs).length ? null : paymentProblem(splits, due, allowPartPayments, money);
    if (problem) errs.total = problem;
    setErrors(errs);
    guard.clear();
    if (!Object.keys(errs).length) setReviewed({ version: invoice.lifecycleVersion, due, body });
  }

  const body: { splits: PaymentSplit[]; note?: string } = {
    splits: splits.map((x) => ({ mode: x.mode, amountMinor: x.amountMinor!, ...(x.reference ? { reference: x.reference } : {}) })),
    ...(note.trim() ? { note: note.trim() } : {}),
  };
  // The confirmation shows (and sends) what was reviewed.
  const shown = reviewed?.body ?? body;
  const one = shown.splits.length === 1 ? shown.splits[0] : undefined;
  const shownTotal = shown.splits.reduce((n, x) => n + x.amountMinor, 0);
  const left = (reviewed?.due ?? due) - (reviewed ? shownTotal : total);
  return (
    <form className="confirm" noValidate onSubmit={review} aria-label="Record payment">
      {guard.changed && <Alert tone="warn">{BILL_CHANGED}</Alert>}
      {!confirming ? (
        <>
          <p className="ws-muted">
            {money(due)} is due. {allowPartPayments
              ? 'Any amount up to that can be recorded; the rest stays due on the bill.'
              : 'Only full payment is taken: the amounts must add up to all that is due.'} One payment may be split across methods (cash and UPI, for example).
          </p>
          {rows.map((r, i) => (
            <div key={r.key} className="rx-form-row">
              <div className="j-field">
                <label htmlFor={`pay-mode-${r.key}`}>Paid by{nth(i)}</label>
                <select id={`pay-mode-${r.key}`} value={r.mode} onChange={(e) => set(r.key, { mode: e.target.value as InvoicePaymentMode })}>
                  {PAYMENT_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </div>
              <TextField label={`Amount (₹)${nth(i)}`} inputMode="decimal" value={r.amount} error={errors[`amount${r.key}`]} onChange={(e) => set(r.key, { amount: e.target.value })} />
              <TextField label={`Reference (optional)${nth(i)}`} hint={i === 0 ? 'UPI or card reference, cheque number…' : undefined} value={r.reference} maxLength={MAX_REFERENCE}
                error={errors[`reference${r.key}`]} onChange={(e) => set(r.key, { reference: e.target.value })} />
              {i > 0 && <Button variant="ghost" aria-label={`Remove method ${i + 1}`} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>Remove</Button>}
            </div>
          ))}
          <TextField label="Note (optional)" value={note} maxLength={MAX_NOTE} error={errors.note} onChange={(e) => setNote(e.target.value)} />
          <p className="ws-muted" aria-live="polite">Payment: {money(total)}{left > 0 ? ` · ${money(left)} would stay due` : ''}</p>
          {errors.total && <Alert>{errors.total}</Alert>}
          <div className="confirm-actions">
            <Button type="submit">Continue</Button>
            {rows.length < MAX_PAYMENT_SPLITS && (
              <Button variant="secondary" onClick={() => setRows((rs) => [...rs, { key: ++splitSeq, mode: 'upi', amount: paiseToInput(Math.max(0, due - total)) || '', reference: '' }])}>
                Add another method
              </Button>
            )}
            <Button variant="ghost" onClick={() => setOpen(false)}>Back</Button>
          </div>
        </>
      ) : (
        <>
          <div className="confirm-text">
            {one
              ? <>Record {money(one.amountMinor)} as paid by {MODE_LABEL[one.mode]}{one.reference ? ` (reference ${one.reference})` : ''} for bill {invoice.serial}?</>
              : <>Record {money(shownTotal)} as paid by {shown.splits.map((x) => `${MODE_LABEL[x.mode]} ${money(x.amountMinor)}${x.reference ? ` (reference ${x.reference})` : ''}`).join(' + ')} for bill {invoice.serial}?</>}
            {left > 0 ? ` ${money(left)} stays due: the bill will show Partly paid.` : ' The bill will show Paid.'} A recorded payment cannot be changed or removed.
          </div>
          {locked && <p className="ws-muted">A cancellation of this bill is being sent; wait for its answer.</p>}
          <div className="confirm-actions">
            <Button busy={busy} disabled={locked} onClick={() => { const r = reviewed!; setReviewed(null); setOpen(false); void onRecord(r.body, r.version); }}>Record {money(shownTotal)} paid</Button>
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
  // Q14: whatever was paid (in full or in parts) goes back, and the refund names exactly that amount — the amount the
  // person reviewed, captured with the bill version when the form opened. A newer version closes the form to ask again.
  const [reviewed, setReviewed] = useState<{ version: number; paidMinor: number } | null>(null);
  const guard = useReviewGuard(invoice.lifecycleVersion, open, () => { setOpen(false); setReviewed(null); });
  const paidMinor = reviewed?.paidMinor ?? paidOf(invoice);
  const paid = paidMinor > 0;

  if (!open) {
    return (
      <>
        {guard.changed && <Alert tone="warn">{BILL_CHANGED}</Alert>}
        <Button variant="secondary" disabled={locked} onClick={() => { guard.clear(); setReviewed({ version: invoice.lifecycleVersion, paidMinor: paidOf(invoice) }); setOpen(true); }}>Cancel bill</Button>
      </>
    );
  }

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
      ? { mode: refundMode, ...(refundRef.trim() ? { reference: refundRef.trim() } : {}), ...(refundNote.trim() ? { note: refundNote.trim() } : {}), amountMinor: paidMinor }
      : undefined;
    setBusy(true);
    onBusy(true);
    try {
      onDone(await ctx.billing.cancelInvoice(invoice._id, reason.trim(), refund));
      setOpen(false);
    } catch (err) {
      // Q14 REFUND_AMOUNT_MISMATCH: a payment landed meanwhile; the bill is read again and the refund names the new amount.
      setError(err instanceof ApiError && err.code === 'REFUND_AMOUNT_MISMATCH'
        ? `${messageOf(err)}. A payment was recorded meanwhile: the bill has been read again; check the amount to return and confirm again.`
        : messageOf(err));
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
        {paid ? ` It was paid (${money(paidMinor)}): give the money back to the customer and record how it went back. The refund recorded is ${money(paidMinor)}, all that was paid.` : ''}
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
