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
import { t } from '../../i18n/index.ts';
import { useSession } from '../../session.tsx';
import { billStateOf } from './BillsScreen.tsx';

const rupees = (minor: number | undefined) => formatRupees(fromPaise(minor));
/** "Paid ₹500 by Cash + UPI on …": one whole sentence for each part the payment names. */
const paidWords = (amount: string, methods: string, date: string) => (amount
  ? methods ? t('bill.paidAmountBy', { amount, methods, date }) : t('bill.paidAmount', { amount, date })
  : methods ? t('bill.paidBy', { methods, date }) : t('bill.paidOn', { date }));

export function BillScreen() {
  const { invoiceId = '' } = useParams();
  const { api } = useSession();
  const valid = /^[0-9a-fA-F]{24}$/.test(invoiceId);
  const q = useQuery({ queryKey: ['bills', 'one', invoiceId], queryFn: () => customerBillsApi(api).bill(invoiceId), enabled: valid,
    staleTime: 0 }); // paid or cancelled at the counter at any time: always read it again
  return (
    <>
      <Link to="/bills" className="back"><ArrowLeft size={16} aria-hidden="true" /> {t('home.bills')}</Link>
      {!valid ? <Empty title={t('bill.notFound')} />
        : q.isPending ? <Loading /> : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : <BillView bill={q.data.invoice} events={q.data.events} />}
    </>
  );
}

function BillView({ bill: b, events }: { bill: Bill; events: BillEvent[] }) {
  const { api } = useSession();
  const s = billStateOf(b.lifecycleState);
  const payments = events.filter((e) => e.kind === 'payment');
  const methods = (e: BillEvent) => (e.splits?.length ? e.splits.map((x) => BILL_PAYMENT_MODE[x.mode] ?? x.mode).join(' + ') : e.mode ? BILL_PAYMENT_MODE[e.mode] ?? e.mode : '');
  const cancellation = events.find((e) => e.kind === 'cancellation');
  const totals = b.totals;
  return (
    <>
      <PageHeading title={b.supplier.name}>{BILL_KIND_LABEL[b.documentKind] ?? t('bills.bill')} {b.serial} · {formatDateTime(b.issuedAt)}</PageHeading>
      <section className="card stack">
        <dl className="details">
          <dt>{t('common.status')}</dt><dd><Badge tone={s.tone}>{s.label}</Badge></dd>
          <dt>{t('common.total')}</dt><dd><strong>{rupees(totals.totalMinor)}</strong></dd>
          <dt>{t('bill.billedTo')}</dt><dd>{b.customer.name}</dd>
          {b.doctorName && <><dt>{t('common.doctor')}</dt><dd>{b.doctorName}</dd></>}
          <dt>{t('bill.from')}</dt><dd>{[b.supplier.legalName && b.supplier.legalName !== b.supplier.name ? b.supplier.legalName : '', b.supplier.address].filter(Boolean).join(', ')}</dd>
          {b.supplier.gstin && <><dt>{t('bill.gstin')}</dt><dd>{b.supplier.gstin}</dd></>}
        </dl>
      </section>
      {payments.map((p) => (
        <Alert key={p.version} tone="ok">{paidWords(p.amountMinor ? rupees(p.amountMinor) : '', methods(p), formatDateTime(p.at))}</Alert>
      ))}
      {b.lifecycleState === 'issued' && <Alert tone="warn">{t('bill.notPaid', { supplier: b.supplier.name })}</Alert>}
      {b.lifecycleState === 'partly_paid' && (
        <Alert tone="warn">{typeof b.dueMinor === 'number' ? t('bill.partlyDue', { due: rupees(b.dueMinor), supplier: b.supplier.name }) : t('bill.partly', { supplier: b.supplier.name })}</Alert>
      )}
      {cancellation && <Alert tone="warn">{cancellation.reason
        ? t('bill.cancelledWhy', { date: formatDateTime(cancellation.at), reason: cancellation.reason })
        : t('bill.cancelled', { date: formatDateTime(cancellation.at) })}</Alert>}

      <section className="card stack" aria-labelledby="lines-h">
        <h2 id="lines-h">{t('bill.items')}</h2>
        <ul className="lines">
          {b.items.map((l, i) => (
            <li key={i}>
              <span className="row-between"><strong>{l.description}</strong><span>{rupees(l.amountMinor)}</span></span>
              <span className="muted">
                {l.qty} × {rupees(l.unitPriceMinor)}{l.discountMinor > 0 ? ` − ${t('bill.lineDiscount', { amount: rupees(l.discountMinor) })}` : ''}
                {l.taxTreatment === 'exempt' ? ` · ${l.sac ? t('bill.exemptSac', { sac: l.sac }) : t('bill.exempt')}`
                  : <>{b.documentKind === 'tax_invoice' ? ` · GST ${l.gstRate}%` : ''}{l.sac ? ` · SAC ${l.sac}` : l.hsn ? ` · HSN ${l.hsn}` : ''}</>}
              </span>
            </li>
          ))}
        </ul>
        <dl className="details" aria-label={t('bill.totals')}>
          <dt>{t('bill.subtotal')}</dt><dd>{rupees(totals.subtotalMinor)}</dd>
          {totals.discountMinor > 0 && <><dt>{t('bill.discount')}</dt><dd>−{rupees(totals.discountMinor)}</dd></>}
          {gstSplit(totals).length > 0 && <><dt>{t('bill.taxable')}</dt><dd>{rupees(totals.taxableMinor)}</dd></>}
          {/* WQ58 (r42): exempt lines add up apart from the taxable value (never shown as ₹0.00). */}
          {!!totals.exemptMinor && <><dt>{t('bill.exemptValue')}</dt><dd>{rupees(totals.exemptMinor)}</dd></>}
          {gstSplit(totals).map((g) => <Fragment key={g.label}><dt>{g.label}</dt><dd>{rupees(g.minor)}</dd></Fragment>)}
          <dt>{t('common.total')}</dt><dd><strong>{rupees(totals.totalMinor)}</strong></dd>
        </dl>
      </section>

      <section className="card stack" aria-labelledby="pdf-h">
        <h2 id="pdf-h">{t('bill.pdf')}</h2>
        {/* Exactly this bill at this version: the PDF is requested for the version on screen, and a new version starts afresh. */}
        <PrivateFile id={`${b._id}:${b.lifecycleVersion}`} label={t('files.billPdf')} baseName={billFileName(b).replace(/\.pdf$/, '')}
          load={(signal) => customerBillsApi(api).pdf(b._id, b.lifecycleVersion, signal)} />
      </section>
    </>
  );
}
