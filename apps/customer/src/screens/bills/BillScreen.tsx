import { Fragment } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import {
  BILL_KIND_LABEL, BILL_PAYMENT_MODE, billFileName, customerBillsApi, fromPaise, gstSplit, type Bill, type BillEvent,
} from '@jansetu/api';
import { Alert, Badge, Empty, ErrorState, formatDateTime, formatRupees, Loading } from '@jansetu/ui';
import { messageOf, PageHeading } from '../../common.tsx';
import { PrivateFile } from '../../files.tsx';
import { useSession } from '../../session.tsx';
import { BILL_STATE } from './BillsScreen.tsx';

const rupees = (minor: number | undefined) => formatRupees(fromPaise(minor));

export function BillScreen() {
  const { invoiceId = '' } = useParams();
  const { api } = useSession();
  const valid = /^[0-9a-fA-F]{24}$/.test(invoiceId);
  const q = useQuery({ queryKey: ['bills', 'one', invoiceId], queryFn: () => customerBillsApi(api).bill(invoiceId), enabled: valid,
    staleTime: 0 }); // paid or cancelled at the counter at any time: always read it again
  return (
    <>
      <Link to="/bills" className="back"><ArrowLeft size={16} aria-hidden="true" /> Bills</Link>
      {!valid ? <Empty title="Bill not found" />
        : q.isPending ? <Loading /> : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : <BillView bill={q.data.invoice} events={q.data.events} />}
    </>
  );
}

function BillView({ bill: b, events }: { bill: Bill; events: BillEvent[] }) {
  const { api } = useSession();
  const s = BILL_STATE[b.lifecycleState] ?? { label: b.lifecycleState };
  const payment = events.find((e) => e.kind === 'payment');
  const cancellation = events.find((e) => e.kind === 'cancellation');
  const t = b.totals;
  return (
    <>
      <PageHeading title={b.supplier.name}>{BILL_KIND_LABEL[b.documentKind] ?? 'Bill'} {b.serial} · {formatDateTime(b.issuedAt)}</PageHeading>
      <section className="card stack">
        <dl className="details">
          <dt>Status</dt><dd><Badge tone={s.tone}>{s.label}</Badge></dd>
          <dt>Total</dt><dd><strong>{rupees(t.totalMinor)}</strong></dd>
          <dt>Billed to</dt><dd>{b.customer.name}</dd>
          {b.doctorName && <><dt>Doctor</dt><dd>{b.doctorName}</dd></>}
          <dt>From</dt><dd>{[b.supplier.legalName && b.supplier.legalName !== b.supplier.name ? b.supplier.legalName : '', b.supplier.address].filter(Boolean).join(', ')}</dd>
          {b.supplier.gstin && <><dt>GSTIN</dt><dd>{b.supplier.gstin}</dd></>}
        </dl>
      </section>
      {payment && (
        <Alert tone="ok">Paid{payment.mode ? ` by ${BILL_PAYMENT_MODE[payment.mode] ?? payment.mode}` : ''} on {formatDateTime(payment.at)}.</Alert>
      )}
      {b.lifecycleState === 'issued' && <Alert tone="warn">Not paid yet. Pay at the {b.supplier.name} counter.</Alert>}
      {cancellation && <Alert tone="warn">This bill was cancelled on {formatDateTime(cancellation.at)}{cancellation.reason ? `: “${cancellation.reason}”` : '.'}</Alert>}

      <section className="card stack" aria-labelledby="lines-h">
        <h2 id="lines-h">Items</h2>
        <ul className="lines">
          {b.items.map((l, i) => (
            <li key={i}>
              <span className="row-between"><strong>{l.description}</strong><span>{rupees(l.amountMinor)}</span></span>
              <span className="muted">
                {l.qty} × {rupees(l.unitPriceMinor)}{l.discountMinor > 0 ? ` − ${rupees(l.discountMinor)} discount` : ''}
                {b.documentKind === 'tax_invoice' ? ` · GST ${l.gstRate}%` : ''}{l.sac ? ` · SAC ${l.sac}` : l.hsn ? ` · HSN ${l.hsn}` : ''}
              </span>
            </li>
          ))}
        </ul>
        <dl className="details" aria-label="Totals">
          <dt>Subtotal</dt><dd>{rupees(t.subtotalMinor)}</dd>
          {t.discountMinor > 0 && <><dt>Discount</dt><dd>−{rupees(t.discountMinor)}</dd></>}
          {gstSplit(t).length > 0 && <><dt>Taxable</dt><dd>{rupees(t.taxableMinor)}</dd></>}
          {gstSplit(t).map((g) => <Fragment key={g.label}><dt>{g.label}</dt><dd>{rupees(g.minor)}</dd></Fragment>)}
          <dt>Total</dt><dd><strong>{rupees(t.totalMinor)}</strong></dd>
        </dl>
      </section>

      <section className="card stack" aria-labelledby="pdf-h">
        <h2 id="pdf-h">PDF</h2>
        {/* Exactly this bill at this version: the PDF is requested for the version on screen, and a new version starts afresh. */}
        <PrivateFile id={`${b._id}:${b.lifecycleVersion}`} label="bill PDF" baseName={billFileName(b).replace(/\.pdf$/, '')}
          load={(signal) => customerBillsApi(api).pdf(b._id, b.lifecycleVersion, signal)} />
      </section>
    </>
  );
}
