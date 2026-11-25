import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useParams } from 'react-router';
import { ArrowLeft, FileText } from 'lucide-react';
import {
  ApiError, DOCUMENT_KIND_LABEL, dueOf, holdsAny, INVOICE_STATE_LABEL, invoicePdfName, MAX_CANCEL_REASON, MAX_NOTE, MAX_PAYMENT_SPLITS, MAX_REFERENCE,
  OBJECT_ID_PATTERN, paidOf, paiseToInput, PAYMENT_MODES, paymentProblem, rupeesToPaise, takesPayment, tooLongWords, type Invoice, type InvoiceEvent,
  type InvoicePaymentMode, type PaymentInput, type PaymentSplit, type RefundInput,
} from '@jansetu/api';
import { Alert, Badge, Button, ErrorState, formatDateTime, Loading, shared, TextArea, TextField } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { afterFailure, beginAttempt, newRequestKey, startOp, stillCurrent, type PendingOp } from '../../requests.ts';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { sniffDocument } from '../pharmacy/documents.ts';
import { money, useClinicDoctors } from './billing.tsx';
import { stateTone } from './InvoicesScreen.tsx';
import { useSession } from '../../session.tsx';
import { NoSuchPartner, scopeIdentity, useBranches, usePartnerScope, useWorkspacePartner, type ScopeContext } from './scope.tsx';
import { t } from '../../i18n/partner/index.ts';

const MODE_LABEL = Object.fromEntries(PAYMENT_MODES.map((m) => [m.value, m.label])) as Record<InvoicePaymentMode, string>;
/** Q14 refusals of a payment, in words a cashier can act on (the server's message is the fallback). */
function payRefusal(err: unknown): string {
  const key = err instanceof ApiError && err.code ? `invoice.payRefusal.${err.code}` : '';
  return t.has(key) ? t(key) : messageOf(err);
}
/** Q14 review: 503 INVOICE_INDEXES_OUTDATED: this payment's insert was refused (its message is shown as the server gives it). */
const isIndexesOutdated = (err: unknown) => err instanceof ApiError && err.status === 503 && err.code === 'INVOICE_INDEXES_OUTDATED';
/** 409s the server answers only after finding no payment under this key, for a request that can never pass as it is. */
const REFUSED_409 = new Set(['PART_PAYMENTS_NOT_ALLOWED', 'AMOUNT_EXCEEDS_DUE', 'PAYMENT_METHOD_REQUIRED', 'REQUEST_KEY_REQUIRED', 'INVALID_AMOUNT']);
/**
 * A keyed payment refused for good, on ANY attempt: the server looks for this key's payment first (a recorded one is
 * answered as a replay) and these refusals abort the transaction, so nothing was recorded under the key. A version
 * conflict, a state conflict ("paid", "cancelled"), a network loss or another 5xx stays unknown: an earlier attempt of
 * the same payment may have committed in between.
 *
 * WQ11b: only CONTENT refusals (400, 422: the same content was sent by every attempt, so every attempt was refused the
 * same way) settle it. 401, 403 and 404 come before the server looks for the key (`loadForActor`: the session, the
 * permission or the bill's branch scope changed since), so they say nothing about an earlier attempt and stay unknown.
 */
export function paymentRefusedForGood(err: unknown): boolean {
  if (isIndexesOutdated(err)) return true;
  if (!(err instanceof ApiError)) return false;
  if ([400, 422].includes(err.status)) return true;
  return err.status === 409 && !!err.code && REFUSED_409.has(err.code);
}
/** What a new bill's page says it did (route state: words are made on this page, in the language showing). */
export interface IssuedNotice { serial: string; earlier: boolean; linked: boolean }
const isIssuedNotice = (x: unknown): x is IssuedNotice => !!x && typeof (x as IssuedNotice).serial === 'string';
/** What the payment form produces; the key and the version it was decided on are added when it is sent. */
type PaymentDraft = { note?: string } & ({ splits: PaymentSplit[] } | { mode: InvoicePaymentMode });

/** How a payment was made: its methods (each with its amount when there are several), references, and the amount. */
export function paymentText(e: Pick<InvoiceEvent, 'mode' | 'reference' | 'splits' | 'amountMinor'>): string {
  const parts: PaymentSplit[] = e.splits?.length ? e.splits : e.mode ? [{ mode: e.mode, amountMinor: e.amountMinor ?? 0, reference: e.reference }] : [];
  if (parts.length <= 1) {
    const p = parts[0];
    return [
      t('invoice.paidBy', { method: p ? MODE_LABEL[p.mode] ?? p.mode : t('invoice.unrecordedMethod') }),
      ...(p?.reference ? [t('invoice.reference', { ref: p.reference })] : []),
      ...(e.amountMinor ? [money(e.amountMinor)] : []),
    ].join(' · ');
  }
  const list = parts.map((p) => splitText(MODE_LABEL[p.mode] ?? p.mode, p)).join(' + ');
  return t('invoice.paidByAll', { methods: list, total: money(e.amountMinor ?? parts.reduce((n, p) => n + p.amountMinor, 0)) });
}
/** One method of a split payment: "Cash ₹500.00", "UPI ₹508.00 (reference U9)". */
const splitText = (method: string, p: { amountMinor: number; reference?: string }) => (p.reference
  ? t('invoice.splitRef', { method, amount: money(p.amountMinor), ref: p.reference })
  : t('invoice.split', { method, amount: money(p.amountMinor) }));
/** A gender as given on the bill (the new-bill form's words). */
const genderLabel = (g: string) => {
  const key = `newInvoice.gender.${g}`;
  return g !== 'none' && t.has(key) ? t(key) : g;
};

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
  const issued = (location.state as { issued?: unknown } | null)?.issued;
  const issuedNotice = isIssuedNotice(issued)
    ? [t(issued.earlier ? 'invoice.issuedEarlier' : 'invoice.issuedNotice', { serial: issued.serial }), ...(issued.linked ? [t('invoice.issuedLinked')] : [])].join(' ')
    : undefined;
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
    if (outcome === 'recorded') { setFailure(null); setNotice(payOp.restored ? t('invoice.shownPayment') : t('invoice.paymentRecorded')); }
    else { setNotice(null); setFailure(t('invoice.paymentNotRecorded', { reason: outcome.refused })); }
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
      setNotice(r.replayed ? t('invoice.paymentReplayed') : t('invoice.paymentRecorded'));
      void reload().catch(() => undefined);
    } catch (err) {
      if (!owns(attempt)) return;
      const next = paymentRefusedForGood(err) ? null : afterFailure(attempt, err, messageOf(err));
      storePay(next ?? undefined);
      // Refused outright (e.g. "This bill is paid": someone else recorded another payment): the server's message.
      if (!next) setFailure(t('invoice.paymentNotRecorded', { reason: payRefusal(err) }));
      void reload().catch(() => undefined);
    } finally {
      if (live.current) setInFlight(null);
    }
  }

  /** After any change or refusal, read the exact bill again (the server's state is what is shown). */
  const reload = async () => {
    await queryClient.invalidateQueries({ queryKey: key });
    await queryClient.invalidateQueries({ queryKey: [...ctx.key, 'invoices'] });
    // WQ11b: the front desk's Bill column shows this bill's state (paid, cancelled): read the day again too.
    await queryClient.invalidateQueries({ queryKey: [...ctx.key, 'clinic-appointments'] });
  };
  const changed = (r: { invoice: Invoice; event: InvoiceEvent }) => {
    queryClient.setQueryData<Detail>(key, (cur) => mergeDetail(cur, r));
    void reload();
  };

  const branchName = inv ? branches.data?.find((b) => b._id === inv.branchId)?.name ?? t('common.branchById', { tail: inv.branchId.slice(-6) }) : '';
  const doctor = inv?.doctorId ? doctors.data?.find((d) => d.doctorId === inv.doctorId) : undefined;
  const canPay = holdsAny(ctx.actor, ['payments.record']);
  const canCancel = holdsAny(ctx.actor, ['invoices.cancel']);
  // `computeTotals`: inter-state (IGST) only when the customer's state is given and differs from the branch's.
  const interState = !!inv?.customer.placeOfSupply && inv.customer.placeOfSupply !== inv.supplier.placeOfSupply;

  return (
    <>
      <Link className="ws-back" to={ctx.link('invoices')}><ArrowLeft size={16} aria-hidden="true" /> {t('invoice.backToBills')}</Link>
      <PageHeading title={inv ? t('invoice.title', { serial: inv.serial }) : t('invoice.titleUnknown')}>
        {ctx.adminHome
          ? <>{partner.data?.name === undefined ? t('scope.managingThis') : t('scope.managing', { name: partner.data.name })} </>
          : null}
        {inv ? t('invoice.issuedLine', { kind: DOCUMENT_KIND_LABEL[inv.documentKind], date: formatDateTime(inv.issuedAt), branch: branchName }) : null}
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
        <ErrorState message={t('invoice.refreshFailed', { reason: messageOf(q.error) })} onRetry={() => void q.refetch()} />
      )}
      {q.isPending ? <Loading label={t('invoice.loading')} />
        : q.isError && !q.data ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : inv && (
          <>
            <section className="ws-section" aria-labelledby="inv-state-h">
              <h2 id="inv-state-h">{t('invoice.status')}</h2>
              {failure && <Alert>{failure}</Alert>}
              <div><Badge tone={stateTone(inv.lifecycleState)}>{INVOICE_STATE_LABEL[inv.lifecycleState] ?? inv.lifecycleState}</Badge></div>
              {inv.lifecycleState !== 'cancelled' && (
                <dl className="ws-dl" aria-label={t('invoice.paidAndDue')}>
                  <dt>{t('invoice.paid')}</dt><dd>{t('invoice.paidOf', { paid: money(paidOf(inv)), total: money(inv.totals.totalMinor) })}</dd>
                  <dt>{t('invoice.due')}</dt><dd>{money(dueOf(inv))}</dd>
                </dl>
              )}
              {inv.lifecycleState === 'cancelled' && paidOf(inv) > 0 && <p className="ws-muted">{t('invoice.returned', { amount: money(paidOf(inv)) })}</p>}
              {events.length === 0 ? <p className="ws-muted">{t('invoice.noPayment')}</p> : (
                <ul className="ws-list" aria-label={t('invoice.events')}>
                  {events.map((e) => (
                    <li key={e.version}>
                      {e.kind === 'payment'
                        ? <>{paymentText(e)}{e.note ? ` · “${e.note}”` : ''}</>
                        : cancellationText(e)}
                      {' '}· {formatDateTime(e.at)}{e.byKind === 'admin' ? ` · ${t('invoice.event.byAdmin')}` : ''}
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
                    onDone={(r) => { changed(r); setFailure(null); setNotice(t('invoice.cancelledNotice', { serial: inv.serial })); }}
                    onRefused={reload} />
                )}
              </div>
              {!canPay && !canCancel && <p className="ws-muted">{t('invoice.viewOnly')}</p>}
            </section>

            <PdfPanel ctx={ctx} invoice={inv} />

            <section className="ws-section" aria-labelledby="inv-parties-h">
              <h2 id="inv-parties-h">{t('invoice.parties')}</h2>
              <div className="rx-form-row">
                <dl className="ws-dl" aria-label={t('invoice.supplier')}>
                  <dt>{t('invoice.supplier')}</dt><dd>{inv.supplier.name}{inv.supplier.legalName ? ` (${inv.supplier.legalName})` : ''}</dd>
                  <dt>{t('invoice.address')}</dt><dd>{inv.supplier.address}</dd>
                  {inv.supplier.gstin && <><dt>{t('invoice.gstin')}</dt><dd>{inv.supplier.gstin}</dd></>}
                  {inv.supplier.pan && <><dt>{t('invoice.pan')}</dt><dd>{inv.supplier.pan}</dd></>}
                  <dt>{t('invoice.stateCode')}</dt><dd>{inv.supplier.placeOfSupply}</dd>
                </dl>
                <dl className="ws-dl" aria-label={t('invoice.customer')}>
                  <dt>{t('invoice.customer')}</dt><dd>{inv.customer.name}</dd>
                  {inv.customer.phone && <><dt>{t('invoice.phone')}</dt><dd>{inv.customer.phone}</dd></>}
                  {inv.customer.phone && <><dt>{t('invoice.account')}</dt><dd>{inv.customer.userId ? t('invoice.accountLinked') : t('invoice.accountNotLinked')}</dd></>}
                  {inv.customer.age !== undefined && <><dt>{t('invoice.age')}</dt><dd>{inv.customer.age}</dd></>}
                  {inv.customer.gender && <><dt>{t('invoice.gender')}</dt><dd>{genderLabel(inv.customer.gender)}</dd></>}
                  {inv.customer.gstin && <><dt>{t('invoice.gstin')}</dt><dd>{inv.customer.gstin}</dd></>}
                  <dt>{t('invoice.placeOfSupply')}</dt><dd>{inv.customer.placeOfSupply ?? inv.supplier.placeOfSupply}</dd>
                  {inv.doctorId && <><dt>{t('invoice.doctor')}</dt><dd>{doctor?.name ?? t('invoice.doctorById', { tail: inv.doctorId.slice(-6) })}</dd></>}
                  {inv.appointmentId && (
                    <><dt>{t('invoice.appointment')}</dt><dd>
                      {t('invoice.appointmentById', { tail: inv.appointmentId.slice(-6) })}
                      {' · '}<Link to={ctx.link('invoices')} state={{ appointmentId: inv.appointmentId }}>{t('invoice.appointmentBills')}</Link>
                    </dd></>
                  )}
                </dl>
              </div>
            </section>

            <section className="ws-section" aria-labelledby="inv-lines-h">
              <h2 id="inv-lines-h">{t('invoice.items')}</h2>
              <div className="ws-table-wrap">
                <table className="j-table">
                  <caption className="j-sr-only">{t('invoice.itemsCaption', { serial: inv.serial })}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('invoice.col.item')}</th><th scope="col">{t('invoice.col.sac')}</th><th scope="col">{t('invoice.col.qty')}</th>
                      <th scope="col">{t('invoice.col.unitPrice')}</th><th scope="col">{t('invoice.col.discount')}</th><th scope="col">{t('invoice.col.taxable')}</th>
                      <th scope="col">{t('invoice.col.gst')}</th>
                    </tr>
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

/** A cancellation in the bill's history: the reason, and how the money went back. */
function cancellationText(e: InvoiceEvent): string {
  const r = e.refund;
  return [
    t('invoice.event.cancelled', { reason: e.reason ?? '' }),
    ...(r ? [
      t('invoice.event.returnedBy', { method: MODE_LABEL[r.mode] ?? r.mode }),
      ...(r.reference ? [t('invoice.reference', { ref: r.reference })] : []),
      ...(r.note ? [`“${r.note}”`] : []),
      ...(r.amountMinor ? [t('invoice.event.returnedAmount', { amount: money(r.amountMinor) })] : []),
    ] : []),
  ].join(' · ');
}

export function Totals({ totals, igst, label }: { totals: Invoice['totals']; igst: boolean; label?: string }) {
  return (
    <dl className="ws-dl" aria-label={label ?? t('invoice.totals')}>
      <dt>{t('invoice.subtotal')}</dt><dd>{money(totals.subtotalMinor)}</dd>
      {totals.discountMinor > 0 && <><dt>{t('invoice.discount')}</dt><dd>− {money(totals.discountMinor)}</dd></>}
      <dt>{t('invoice.taxable')}</dt><dd>{money(totals.taxableMinor)}</dd>
      {igst ? <><dt>{t('invoice.igst')}</dt><dd>{money(totals.igstMinor)}</dd></>
        : <><dt>{t('invoice.cgst')}</dt><dd>{money(totals.cgstMinor)}</dd><dt>{t('invoice.sgst')}</dt><dd>{money(totals.sgstMinor)}</dd></>}
      <dt><strong>{t('invoice.total')}</strong></dt><dd><strong>{money(totals.totalMinor)}</strong></dd>
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
  if (d.invoice.lifecycleState === 'cancelled') return { refused: t('invoice.outcome.cancelled') };
  const named = op.restored ? undefined : op.body?.expectedLifecycleVersion;
  if (named !== undefined && d.invoice.lifecycleVersion > named) {
    const other = d.events.find((e) => e.version === named + 1);
    return { refused: other?.kind === 'payment' ? t('invoice.outcome.otherPayment', { payment: paymentText(other) }) : t('invoice.outcome.changed') };
  }
  return 'unknown';
}

const splitsTotal = (splits: readonly PaymentSplit[]) => splits.reduce((n, x) => n + x.amountMinor, 0);
/** "of ₹1,008.00 by UPI (reference UTR9)", or with several methods "of ₹1,008.00 (Cash ₹500.00 + UPI ₹508.00)". */
function payWords(b: PaymentInput): string {
  if (!b.splits) return t('invoice.what.single', { amount: money(0), method: MODE_LABEL[b.mode] });
  if (b.splits.length === 1) {
    const x = b.splits[0]!;
    return x.reference
      ? t('invoice.what.singleRef', { amount: money(x.amountMinor), method: MODE_LABEL[x.mode], ref: x.reference })
      : t('invoice.what.single', { amount: money(x.amountMinor), method: MODE_LABEL[x.mode] });
  }
  const splits = b.splits.map((x) => (x.reference
    ? t('invoice.what.splitRef', { method: MODE_LABEL[x.mode], amount: money(x.amountMinor), ref: x.reference })
    : t('invoice.what.split', { method: MODE_LABEL[x.mode], amount: money(x.amountMinor) }))).join(' + ');
  return t('invoice.what.splits', { amount: money(splitsTotal(b.splits)), splits });
}

/**
 * A payment whose answer did not arrive. It can be sent again unchanged, or (WQ11b) — once the bill, read after its last
 * attempt, still takes a payment and shows no receipt of it — forgotten after a second step, without a reload: every
 * payment names the bill version it was decided on, so if the earlier one still arrives after another payment it is
 * refused, and the bill is never paid twice.
 */
function UnconfirmedPayment({ op, sending, billUnpaid, onResend, onCheck, onForget }: {
  op: PayOp; sending: boolean; billUnpaid: boolean;
  onResend: () => void; onCheck: () => void; onForget: () => void;
}) {
  if (op.restored) {
    return (
      <div className="confirm" role="group" aria-label={t('invoice.unconfirmed')}>
        <Alert tone="warn">{t('invoice.unconfirmed.restored')}</Alert>
        <div className="confirm-actions">
          <Button onClick={onCheck}>{t('invoice.unconfirmed.check')}</Button>
          {billUnpaid && (
            <ConfirmAction label={t('invoice.unconfirmed.recordAgain')} confirmLabel={t('invoice.unconfirmed.recordAgainConfirm')}
              consequence={t('invoice.unconfirmed.recordAgainConsequence')}
              onConfirm={async () => onForget()} />
          )}
        </div>
      </div>
    );
  }
  const what = payWords(op.body);
  return (
    <div className="confirm" role="group" aria-label={t('invoice.unconfirmed')}>
      <Alert tone="warn">
        {sending || (!op.uncertain && !op.error)
          ? t('invoice.unconfirmed.sending', { what })
          : t('invoice.unconfirmed.lost', { what, reason: op.error ?? t('invoice.unconfirmed.noAnswer') })}
      </Alert>
      <div className="confirm-actions">
        <Button busy={sending} onClick={onResend}>{t('invoice.unconfirmed.resend')}</Button>
        <Button variant="secondary" disabled={sending} onClick={onCheck}>{t('invoice.unconfirmed.check')}</Button>
        {billUnpaid && !sending && (
          <ConfirmAction label={t('invoice.unconfirmed.forget')} danger confirmLabel={t('invoice.unconfirmed.forgetConfirm')}
            consequence={t('invoice.unconfirmed.forgetConsequence')}
            onConfirm={async () => onForget()} />
        )}
      </div>
    </div>
  );
}

type SplitDraft = { key: number; mode: InvoicePaymentMode; amount: string; reference: string };
let splitSeq = 0;
/** Each method's fields get their own label: "Amount (₹)", "Amount (₹) (method 2)", … */
const nth = (i: number, first: string, later: (n: number) => string): string => (i === 0 ? first : later(i + 1));

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
        {guard.changed && <Alert tone="warn">{t('invoice.billChanged')}</Alert>}
        <Button disabled={locked || busy} onClick={() => { guard.clear(); setOpen({ version: invoice.lifecycleVersion }); }}>{t('invoice.pay.record')}</Button>
      </>
    );
  }
  return (
    <div className="confirm" role="group" aria-label={t('invoice.pay.record')}>
      <div className="j-field">
        <label htmlFor="pay-zero-mode">{t('invoice.pay.paidBy')}</label>
        <select id="pay-zero-mode" value={mode} onChange={(e) => setMode(e.target.value as InvoicePaymentMode)}>
          {PAYMENT_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      </div>
      <div className="confirm-text">{t('invoice.pay.zero', { serial: invoice.serial, amount: money(0) })}</div>
      <div className="confirm-actions">
        <Button busy={busy} disabled={locked} onClick={() => { const v = open.version; setOpen(null); void onRecord({ mode }, v); }}>{t('invoice.pay.markPaid')}</Button>
        <Button variant="ghost" disabled={busy} onClick={() => setOpen(null)}>{shared('action.back')}</Button>
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

  if (!open) return <Button disabled={locked || busy} onClick={() => { guard.clear(); setOpen(true); }}>{t('invoice.pay.record')}</Button>;

  const splits = rows.map((r) => ({ mode: r.mode, amountMinor: rupeesToPaise(r.amount), reference: r.reference.trim() }));
  const total = splits.reduce((n, x) => n + (x.amountMinor ?? 0), 0);
  const set = (key: number, patch: Partial<SplitDraft>) => { setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r))); setConfirming(false); };

  function review(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    rows.forEach((r) => {
      const a = rupeesToPaise(r.amount);
      if (a === null || a <= 0) errs[`amount${r.key}`] = r.amount.trim() ? t('invoice.pay.enterRupees') : t('invoice.pay.enterAmount');
      if (r.reference.trim().length > MAX_REFERENCE) errs[`reference${r.key}`] = tooLongWords(MAX_REFERENCE);
    });
    if (note.trim().length > MAX_NOTE) errs.note = tooLongWords(MAX_NOTE);
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
    <form className="confirm" noValidate onSubmit={review} aria-label={t('invoice.pay.record')}>
      {guard.changed && <Alert tone="warn">{t('invoice.billChanged')}</Alert>}
      {!confirming ? (
        <>
          <p className="ws-muted">{t(allowPartPayments ? 'invoice.pay.duePart' : 'invoice.pay.dueFull', { due: money(due) })}</p>
          {rows.map((r, i) => (
            <div key={r.key} className="rx-form-row">
              <div className="j-field">
                <label htmlFor={`pay-mode-${r.key}`}>{nth(i, t('invoice.pay.paidBy'), (n) => t('invoice.pay.paidByN', { n }))}</label>
                <select id={`pay-mode-${r.key}`} value={r.mode} onChange={(e) => set(r.key, { mode: e.target.value as InvoicePaymentMode })}>
                  {PAYMENT_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </div>
              <TextField label={nth(i, t('invoice.pay.amount'), (n) => t('invoice.pay.amountN', { n }))} inputMode="decimal" value={r.amount} error={errors[`amount${r.key}`]} onChange={(e) => set(r.key, { amount: e.target.value })} />
              <TextField label={nth(i, t('invoice.pay.reference'), (n) => t('invoice.pay.referenceN', { n }))} hint={i === 0 ? t('invoice.pay.referenceHint') : undefined} value={r.reference} maxLength={MAX_REFERENCE}
                error={errors[`reference${r.key}`]} onChange={(e) => set(r.key, { reference: e.target.value })} />
              {i > 0 && (
                <Button variant="ghost" aria-label={t('invoice.pay.removeMethod', { n: i + 1 })} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>
                  {shared('action.remove')}
                </Button>
              )}
            </div>
          ))}
          <TextField label={t('invoice.pay.note')} value={note} maxLength={MAX_NOTE} error={errors.note} onChange={(e) => setNote(e.target.value)} />
          <p className="ws-muted" aria-live="polite">
            {left > 0 ? t('invoice.pay.totalLeft', { total: money(total), left: money(left) }) : t('invoice.pay.total', { total: money(total) })}
          </p>
          {errors.total && <Alert>{errors.total}</Alert>}
          <div className="confirm-actions">
            <Button type="submit">{t('common.continue')}</Button>
            {rows.length < MAX_PAYMENT_SPLITS && (
              <Button variant="secondary" onClick={() => setRows((rs) => [...rs, { key: ++splitSeq, mode: 'upi', amount: paiseToInput(Math.max(0, due - total)) || '', reference: '' }])}>
                {t('invoice.pay.addMethod')}
              </Button>
            )}
            <Button variant="ghost" onClick={() => setOpen(false)}>{shared('action.back')}</Button>
          </div>
        </>
      ) : (
        <>
          <div className="confirm-text">
            {one
              ? t('invoice.pay.confirm', {
                amount: money(one.amountMinor), serial: invoice.serial,
                methods: one.reference ? t('invoice.methodRef', { method: MODE_LABEL[one.mode], ref: one.reference }) : MODE_LABEL[one.mode],
              })
              : t('invoice.pay.confirm', {
                amount: money(shownTotal), serial: invoice.serial, methods: shown.splits.map((x) => splitText(MODE_LABEL[x.mode], x)).join(' + '),
              })}
            {' '}{left > 0 ? t('invoice.pay.staysDue', { left: money(left) }) : t('invoice.pay.willBePaid')}
          </div>
          {locked && <p className="ws-muted">{t('invoice.pay.cancelSending')}</p>}
          <div className="confirm-actions">
            <Button busy={busy} disabled={locked} onClick={() => { const r = reviewed!; setReviewed(null); setOpen(false); void onRecord(r.body, r.version); }}>{t('invoice.pay.recordAmount', { amount: money(shownTotal) })}</Button>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>{shared('action.back')}</Button>
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
        {guard.changed && <Alert tone="warn">{t('invoice.billChanged')}</Alert>}
        <Button variant="secondary" disabled={locked} onClick={() => { guard.clear(); setReviewed({ version: invoice.lifecycleVersion, paidMinor: paidOf(invoice) }); setOpen(true); }}>
          {t('invoice.cancel.open')}
        </Button>
      </>
    );
  }

  async function confirm() {
    const errs: Record<string, string> = {};
    if (reason.trim().length < 3) errs.reason = t('invoice.cancel.reasonShort');
    else if (reason.trim().length > MAX_CANCEL_REASON) errs.reason = tooLongWords(MAX_CANCEL_REASON);
    if (paid && refundRef.trim().length > MAX_REFERENCE) errs.refundRef = tooLongWords(MAX_REFERENCE);
    if (paid && refundNote.trim().length > MAX_NOTE) errs.refundNote = tooLongWords(MAX_NOTE);
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
        ? t('invoice.cancel.refundMismatch', { reason: messageOf(err) })
        : messageOf(err));
      await onRefused(); // the bill as it is now (e.g. it was paid meanwhile: the money question appears)
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }

  return (
    <div className="confirm" role="group" aria-label={t('invoice.cancel.open')}>
      <div className="confirm-text">
        {t('invoice.cancel.text', { serial: invoice.serial })}
        {paid ? <> {t('invoice.cancel.paid', { amount: money(paidMinor) })}</> : null}
      </div>
      <TextArea label={t('invoice.cancel.reason')} value={reason} maxLength={MAX_CANCEL_REASON} error={errors.reason} onChange={(e) => setReason(e.target.value)} />
      {paid && (
        <div className="rx-form-row">
          <div className="j-field">
            <label htmlFor="refund-mode">{t('invoice.cancel.returnedBy')}</label>
            <select id="refund-mode" value={refundMode} onChange={(e) => setRefundMode(e.target.value as InvoicePaymentMode)}>
              {PAYMENT_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </div>
          <TextField label={t('invoice.cancel.refundRef')} value={refundRef} maxLength={MAX_REFERENCE} error={errors.refundRef} onChange={(e) => setRefundRef(e.target.value)} />
          <TextField label={t('invoice.cancel.refundNote')} value={refundNote} maxLength={MAX_NOTE} error={errors.refundNote} onChange={(e) => setRefundNote(e.target.value)} />
        </div>
      )}
      {error && <Alert>{error}</Alert>}
      {locked && <p className="ws-muted">{t('invoice.cancel.paySending')}</p>}
      <div className="confirm-actions">
        <Button variant="danger" busy={busy} disabled={locked} onClick={() => void confirm()}>{t('invoice.cancel.confirm', { serial: invoice.serial })}</Button>
        <Button variant="ghost" disabled={busy} onClick={() => { setOpen(false); setError(null); setErrors({}); }}>{shared('action.back')}</Button>
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
      if (kind !== 'pdf') { setError(t('invoice.pdf.notPdf')); return; }
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
      <h2 id="inv-pdf-h">{t('invoice.pdf')}</h2>
      <div className="ws-actions">
        <Button variant="secondary" busy={loading === current} onClick={() => void open(current)}>
          <FileText size={16} aria-hidden="true" /> {current > 0 ? t('invoice.pdf.openCurrent') : t('invoice.pdf.open')}
        </Button>
        {current > 0 && (
          <Button variant="secondary" busy={loading === 0} onClick={() => void open(0)}>
            <FileText size={16} aria-hidden="true" /> {t('invoice.pdf.openIssued')}
          </Button>
        )}
      </div>
      {error && <Alert>{t('invoice.pdf.failed', { reason: error })}</Alert>}
      {pdf && (
        <div className="rx-preview">
          <div className="rx-pdf">
            <iframe src={pdf.url} title={t('invoice.pdf.title', { serial: invoice.serial })} />
            <a href={pdf.url} download={invoicePdfName(invoice.serial, pdf.version)}>{t('invoice.pdf.save')}</a>
          </div>
        </div>
      )}
    </section>
  );
}
