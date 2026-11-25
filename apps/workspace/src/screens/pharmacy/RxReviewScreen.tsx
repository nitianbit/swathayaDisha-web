import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ArrowLeft, FileText } from 'lucide-react';
import {
  ApiError, orderStatusLabel, paymentStatusLabel, pharmacyOrdersApi, pharmacyProfileApi, PRESCRIPTION_REVIEWABLE_STATUSES, refId,
  type PharmacyOrder, type PrescriptionReviewRequest,
} from '@jansetu/api';
import {
  Alert, Badge, Button, Empty, ErrorState, formatDateTime, formatRupees, Loading, shared, TextArea, Parts } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession, useStaff } from '../../session.tsx';
import { sniffDocument, type DocumentKind } from './documents.ts';
import { t } from '../../i18n/pharmacy/index.ts';

/** P9: the pharmacy's registered pharmacist (Settings), recorded on every decision. */
export const PHARMACY_PROFILE_KEY = ['pharmacy', 'me'] as const;

export function RxReviewScreen() {
  const { orderId = '' } = useParams();
  if (!/^[0-9a-fA-F]{24}$/.test(orderId)) {
    return <Empty title={t('common.orderNotFound')}><Link to="/pharmacy/prescriptions">{t('rxReview.backToPrescriptionReview')}</Link></Empty>;
  }
  return <RxReview key={orderId} orderId={orderId} />;
}

function RxReview({ orderId }: { orderId: string }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ['pharmacy-orders', 'detail', orderId],
    queryFn: () => pharmacyOrdersApi(api).get(orderId),
  });

  return (
    <>
      <Link to="/pharmacy/prescriptions" className="ws-back"><ArrowLeft size={16} aria-hidden="true" />{` ${t('rxReview.prescriptionReview')}`}</Link>
      {q.isPending ? <Loading label={t('common.loadingOrder')} />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : <OrderReview order={q.data} onChanged={() => {
            // Re-read rather than trust the response's field set; the queue loses this order.
            void queryClient.invalidateQueries({ queryKey: ['pharmacy-orders'] });
          }} onStale={() => void q.refetch()} />}
    </>
  );
}

function OrderReview({ order, onChanged, onStale }:
  { order: PharmacyOrder; onChanged: () => void; onStale: () => void }) {
  const staff = useStaff();
  const title = t('common.order2', { value: order.orderNumber ?? order._id.slice(-8) });
  // The backend reviews only for the selling pharmacy and only in these states; anything else is read-only here.
  const seller = refId(order.pharmacyId) === staff.id;
  const reviewableState = PRESCRIPTION_REVIEWABLE_STATUSES.includes(order.status);
  const pending = order.prescriptionStatus === 'pending';

  return (
    <>
      <PageHeading title={title}><Parts of={t.rich('common.placedFull2', { time: formatDateTime(order.createdAt), amount: formatRupees(order.grandTotal), orderStatusLabel: <Badge>{orderStatusLabel(order.status)}</Badge>, paymentStatusLabel: <Badge tone={order.paymentStatus === 'paid' ? 'ok' : undefined}>{paymentStatusLabel(order.paymentStatus)}</Badge> })} />
      </PageHeading>
      <section className="ws-section" aria-labelledby="items-h">
        <h2 id="items-h">{t('common.medicines')}</h2>
        <table className="j-table">
          <thead><tr><th scope={'col'}>{t('common.medicine')}</th><th scope={'col'}>{t('common.quantity')}</th></tr></thead>
          <tbody>
            {order.items.map((it, i) => (
              <tr key={`${it.medicineId}-${i}`}><td>{it.medicineName ?? it.medicineId}</td><td>{it.orderedQty}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
      {pending && !seller ? (
        <Alert tone="warn">{t('rxReview.yourPharmacyIsTheBuyer')}</Alert>
      ) : pending && !reviewableState ? (
        <Alert tone="warn">{t('common.thisOrderIsFull2', { orderStatusLabel: orderStatusLabel(order.status).toLowerCase() })}</Alert>
      ) : pending ? (
        // A changed document list starts the review again: what was read no longer covers it.
        <ReviewForm key={(order.prescriptionUrls ?? []).join('\n')} order={order} onChanged={onChanged} onStale={onStale} />
      ) : (
        <ReviewOutcome order={order} />
      )}
    </>
  );
}

function ReviewOutcome({ order }: { order: PharmacyOrder }) {
  const r = order.prescriptionReview;
  if (order.prescriptionStatus === 'not_required') {
    return <Alert tone="warn">{t('rxReview.thisOrderDoesNotNeed')}</Alert>;
  }
  return (
    <section className="ws-section" aria-labelledby="outcome-h">
      <h2 id="outcome-h">{t('rxReview.review')}</h2>
      <Alert tone={order.prescriptionStatus === 'approved' ? 'ok' : 'error'}>
        {order.prescriptionStatus === 'approved' ? t('rxReview.prescriptionApprovedTheOrderCan') : t('rxReview.prescriptionRejected')}
      </Alert>
      {r && (
        <dl className="ws-dl">
          <dt>{t('common.pharmacist')}</dt><dd>{r.pharmacistName} ({r.pharmacistRegistrationNumber})</dd>
          <dt>{t('common.when')}</dt><dd>{formatDateTime(r.reviewedAt)}</dd>
          <dt>{t('rxReview.documentsReviewed')}</dt><dd>{r.reviewedDocumentCount}{r.prescriptionAttached === false ? ` ${t('rxReview.noPrescriptionAttached')}` : ''}</dd>
          {r.reason && (<><dt>{t('common.reason')}</dt><dd>{r.reason}</dd></>)}
        </dl>
      )}
      <Link to="/pharmacy/prescriptions">{t('rxReview.backToTheQueue')}</Link>
    </section>
  );
}

/**
 * A document counts as read only when it was displayed (or, for a file the browser cannot show, downloaded) AND the
 * pharmacist confirms it. Fetching it is not enough: a corrupt or unreadable file must not unlock a decision.
 */
type DocState =
  | { status: 'loading' } | { status: 'download' } | { status: 'failed'; message: string } | { status: 'shown' };
interface Preview { index: number; url: string; kind: DocumentKind }

function ReviewForm({ order, onChanged, onStale }:
  { order: PharmacyOrder; onChanged: () => void; onStale: () => void }) {
  const { api } = useSession();
  const orders = pharmacyOrdersApi(api);
  const queryClient = useQueryClient();
  const docs = order.prescriptionUrls ?? [];
  const profile = useQuery({ queryKey: PHARMACY_PROFILE_KEY, queryFn: () => pharmacyProfileApi(api).me() });
  const pharmacist = profile.data?.pharmacist ?? null;

  const [docState, setDocState] = useState<Record<number, DocState>>({});
  const [read, setRead] = useState<ReadonlySet<number>>(new Set());
  const [preview, setPreview] = useState<Preview | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const fetching = useRef<AbortController | null>(null);
  const [fetchingIndex, setFetchingIndex] = useState<number | null>(null);

  // Object URLs hold the file in memory until revoked; a pending fetch is cancelled when the form goes away.
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);
  useEffect(() => () => fetching.current?.abort(), []);

  const setState = (index: number, s: DocState) => setDocState((m) => ({ ...m, [index]: s }));

  async function open(index: number) {
    fetching.current?.abort();
    const ctrl = new AbortController();
    fetching.current = ctrl;
    setFetchingIndex(index);
    setState(index, { status: 'loading' });
    setPreview(null);
    try {
      const blob = await orders.prescriptionFile(docs[index]!, ctrl.signal);
      const { kind, type } = await sniffDocument(blob);
      if (ctrl.signal.aborted) return;
      // Render only by content, never by the server's content type: images and PDFs get a fixed safe type, anything
      // else can only be downloaded.
      const url = URL.createObjectURL(new Blob([blob], { type }));
      setPreview({ index, url, kind });
      // Images confirm they decoded (onLoad/onError). A browser cannot tell whether a PDF is readable, so a PDF counts
      // as shown once displayed and the pharmacist's confirmation carries the judgement. Other files: once downloaded.
      setState(index, { status: kind === 'pdf' ? 'shown' : kind === 'image' ? 'loading' : 'download' });
    } catch (err) {
      if (ctrl.signal.aborted) return;
      setState(index, { status: 'failed', message: messageOf(err) });
    } finally {
      if (fetching.current === ctrl) setFetchingIndex(null);
    }
  }

  const failed = (index: number) =>
    setState(index, { status: 'failed', message: t('rxReview.thisFileCouldNotBe') });

  const review = useMutation({
    mutationFn: (body: PrescriptionReviewRequest) => orders.reviewPrescription(order._id, body),
    onSuccess: () => onChanged(),
    onError: (err) => { if (err instanceof ApiError && err.status === 409) onStale(); },
  });

  // P9: with no prescription attached the pharmacist may still approve (owner decision); every attached document must
  // be opened and confirmed first.
  const allRead = docs.every((_, i) => read.has(i));

  function submit(decision: 'approve' | 'reject') {
    const e: Record<string, string> = {};
    if (decision === 'reject' && reason.trim().length < 3) e.reason = t('rxReview.tellTheCustomerWhyAt');
    setErrors(e);
    if (Object.keys(e).length || !pharmacist) return;
    // One button: the server records the pharmacy's registered pharmacist.
    review.mutate({
      decision,
      // The version on screen: if anyone changed the order since it was opened, the server refuses the decision.
      expectedRevision: order.revision ?? 0,
      ...(decision === 'reject' ? { reason: reason.trim() } : {}),
      // Exactly the stored list, verbatim and in order; the server refuses if the order's documents changed.
      reviewedPrescriptionUrls: docs,
    });
  }

  const current = preview ? docState[preview.index] : undefined;
  const label = (i: number) => t('rxReview.prescriptionDocument', { value: i + 1 });

  return (
    <>
      <section className="ws-section" aria-labelledby="docs-h">
        <h2 id="docs-h">{t('rxReview.prescriptionDocuments')}</h2>
        {docs.length === 0 ? (
          <Alert tone="warn">{t('rxReview.theCustomerHasNotAttached')}</Alert>
        ) : (
          <>
            <p className="ws-muted">{t('rxReview.openAndReadEveryDocument')}</p>
            <ul className="rx-docs">
              {docs.map((_, i) => {
                const s = docState[i];
                return (
                  <li key={i}>
                    <Button variant={preview?.index === i ? 'primary' : 'secondary'} busy={fetchingIndex === i}
                      onClick={() => void open(i)}>
                      <FileText size={16} aria-hidden="true" />{' '}{t('rxReview.documentFull', { value: i + 1 })}
                    </Button>
                    {read.has(i) ? <Badge tone="ok">{t('rxReview.read')}</Badge>
                      : s?.status === 'failed' ? <Badge tone="danger">{t('rxReview.couldNotOpen')}</Badge> : null}
                  </li>
                );
              })}
            </ul>
            {Object.entries(docState).filter(([, s]) => s.status === 'failed').map(([i, s]) => (
              <Alert key={i}>{t('rxReview.documentFull2', { value: Number(i) + 1, message: (s as { message: string }).message })}</Alert>
            ))}
            {preview && current?.status !== 'failed' && (
              <div className="rx-preview-wrap">
                <div className="rx-preview">
                  {preview.kind === 'image' ? (
                    <img src={preview.url} alt={label(preview.index)}
                      onLoad={() => setState(preview.index, { status: 'shown' })} onError={() => failed(preview.index)} />
                  ) : preview.kind === 'pdf' ? (
                    <div className="rx-pdf">
                      <iframe src={preview.url} title={label(preview.index)} />
                      <a href={preview.url} target="_blank" rel="noopener">{t('rxReview.openDocumentFull', { value: preview.index + 1 })}</a>
                    </div>
                  ) : (
                    <div className="j-state">
                      <span>{t('rxReview.thisFileTypeCannotBe')}</span>
                      <a href={preview.url} download={`prescription-${preview.index + 1}`}
                        onClick={() => setState(preview.index, { status: 'shown' })}>{t('rxReview.downloadDocumentFull', { value: preview.index + 1 })}</a>
                    </div>
                  )}
                </div>
                <label className="rx-ack">
                  <input type="checkbox" disabled={current?.status !== 'shown'} checked={read.has(preview.index)}
                    onChange={(e) => {
                      const i = preview.index;
                      setRead((r) => { const n = new Set(r); if (e.target.checked) n.add(i); else n.delete(i); return n; });
                    }} />{t('rxReview.iHaveReadDocumentFull', { value: preview.index + 1 })}</label>
              </div>
            )}
          </>
        )}
      </section>

      <section className="ws-section" aria-labelledby="decision-h">
        <h2 id="decision-h">{t('rxReview.decision')}</h2>
        <form className="rx-form" noValidate onSubmit={(e: FormEvent) => { e.preventDefault(); submit(rejecting ? 'reject' : 'approve'); }}>
          {profile.isPending ? <Loading label={t('rxReview.loadingYourPharmacist')} />
            : !pharmacist ? (
              <Alert tone="warn">{t('rxReview.addYourPharmacistSName')}{' '}
                <Link to="/pharmacy/settings">{t('rxReview.goToSettings')}</Link>
              </Alert>
            ) : (
              <p className="ws-muted"><Parts of={t.rich('rxReview.decidingAsFull', { name: pharmacist.name, registrationNumber: pharmacist.registrationNumber, words: <Link to="/pharmacy/settings">{t('common.change')}</Link> })} /></p>
            )}
          {rejecting && (
            <TextArea label={t('rxReview.reasonForRejection')} hint={t('rxReview.theCustomerSeesThisPaid')}
              value={reason} onChange={(e) => setReason(e.target.value)} error={errors.reason} maxLength={1000} />
          )}
          {review.isError && <Alert>{messageOf(review.error)}{review.error instanceof ApiError && review.error.status === 409
            ? ` ${t('rxReview.theOrderHasBeenReloaded')}` : ''}</Alert>}
          <div className="rx-actions">
            {!rejecting ? (
              <>
                <Button type="submit" busy={review.isPending} disabled={!allRead || !pharmacist}>{t('rxReview.approve')}</Button>
                {/* Rejecting is allowed without reading: an unreadable or missing prescription is a reason to reject. */}
                <Button variant="secondary" disabled={review.isPending || !pharmacist} onClick={() => setRejecting(true)}>{t('rxReview.reject')}</Button>
                {docs.length > 0 && !allRead && (
                  <span className="ws-muted">{t('rxReview.readAndConfirmAllFull', { length: docs.length })}</span>
                )}
              </>
            ) : (
              <>
                <Button type="submit" variant="danger" busy={review.isPending} disabled={!pharmacist}>{t('rxReview.confirmRejection')}</Button>
                <Button variant="ghost" disabled={review.isPending} onClick={() => { setRejecting(false); setErrors({}); }}>{shared('action.cancel')}</Button>
              </>
            )}
          </div>
        </form>
      </section>
    </>
  );
}
