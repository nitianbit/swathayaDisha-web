import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ArrowLeft, FileText } from 'lucide-react';
import {
  ApiError, pharmacyOrdersApi, pharmacyProfileApi, PRESCRIPTION_REVIEWABLE_STATUSES, refId,
  type PharmacyOrder, type PrescriptionReviewRequest,
} from '@jansetu/api';
import {
  Alert, Badge, Button, Empty, ErrorState, formatDateTime, formatRupees, Loading, TextArea,
} from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession, useStaff } from '../../session.tsx';
import { sniffDocument, type DocumentKind } from './documents.ts';

/** P9: the pharmacy's registered pharmacist (Settings), recorded on every decision. */
export const PHARMACY_PROFILE_KEY = ['pharmacy', 'me'] as const;

const statusLabel = (s: string) => s.replace(/_/g, ' ');

export function RxReviewScreen() {
  const { orderId = '' } = useParams();
  if (!/^[0-9a-fA-F]{24}$/.test(orderId)) {
    return <Empty title="Order not found"><Link to="/pharmacy/prescriptions">Back to prescription review</Link></Empty>;
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
      <Link to="/pharmacy/prescriptions" className="ws-back"><ArrowLeft size={16} aria-hidden="true" /> Prescription review</Link>
      {q.isPending ? <Loading label="Loading order…" />
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
  const title = `Order ${order.orderNumber ?? order._id.slice(-8)}`;
  // The backend reviews only for the selling pharmacy and only in these states; anything else is read-only here.
  const seller = refId(order.pharmacyId) === staff.id;
  const reviewableState = PRESCRIPTION_REVIEWABLE_STATUSES.includes(order.status);
  const pending = order.prescriptionStatus === 'pending';

  return (
    <>
      <PageHeading title={title}>
        Placed {formatDateTime(order.createdAt)} · {formatRupees(order.grandTotal)} · Order{' '}
        <Badge>{statusLabel(order.status)}</Badge> · Payment{' '}
        <Badge tone={order.paymentStatus === 'paid' ? 'ok' : undefined}>{statusLabel(order.paymentStatus ?? 'pending')}</Badge>
      </PageHeading>
      <section className="ws-section" aria-labelledby="items-h">
        <h2 id="items-h">Medicines</h2>
        <table className="j-table">
          <thead><tr><th scope="col">Medicine</th><th scope="col">Quantity</th></tr></thead>
          <tbody>
            {order.items.map((it, i) => (
              <tr key={`${it.medicineId}-${i}`}><td>{it.medicineName ?? it.medicineId}</td><td>{it.orderedQty}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
      {pending && !seller ? (
        <Alert tone="warn">
          Your pharmacy is the buyer on this order. The selling pharmacy's pharmacist reviews its prescription.
        </Alert>
      ) : pending && !reviewableState ? (
        <Alert tone="warn">
          This order is {statusLabel(order.status)}, so its prescription can no longer be reviewed.
        </Alert>
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
    return <Alert tone="warn">This order does not need a prescription review.</Alert>;
  }
  return (
    <section className="ws-section" aria-labelledby="outcome-h">
      <h2 id="outcome-h">Review</h2>
      <Alert tone={order.prescriptionStatus === 'approved' ? 'ok' : 'error'}>
        {order.prescriptionStatus === 'approved' ? 'Prescription approved. The order can be packed.' : 'Prescription rejected.'}
      </Alert>
      {r && (
        <dl className="ws-dl">
          <dt>Pharmacist</dt><dd>{r.pharmacistName} ({r.pharmacistRegistrationNumber})</dd>
          <dt>When</dt><dd>{formatDateTime(r.reviewedAt)}</dd>
          <dt>Documents reviewed</dt><dd>{r.reviewedDocumentCount}{r.prescriptionAttached === false ? ' (no prescription attached)' : ''}</dd>
          {r.reason && (<><dt>Reason</dt><dd>{r.reason}</dd></>)}
        </dl>
      )}
      <Link to="/pharmacy/prescriptions">Back to the queue</Link>
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
    setState(index, { status: 'failed', message: 'This file could not be displayed. Ask the customer for a clearer copy.' });

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
    if (decision === 'reject' && reason.trim().length < 3) e.reason = 'Tell the customer why (at least 3 characters).';
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
  const label = (i: number) => `Prescription document ${i + 1}`;

  return (
    <>
      <section className="ws-section" aria-labelledby="docs-h">
        <h2 id="docs-h">Prescription documents</h2>
        {docs.length === 0 ? (
          <Alert tone="warn">
            The customer has not attached a prescription. Check it another way (for example when delivering, or by calling the
            customer) before approving; the approval records that none was attached.
          </Alert>
        ) : (
          <>
            <p className="ws-muted">Open and read every document, then confirm each one, before you decide.</p>
            <ul className="rx-docs">
              {docs.map((_, i) => {
                const s = docState[i];
                return (
                  <li key={i}>
                    <Button variant={preview?.index === i ? 'primary' : 'secondary'} busy={fetchingIndex === i}
                      onClick={() => void open(i)}>
                      <FileText size={16} aria-hidden="true" /> Document {i + 1}
                    </Button>
                    {read.has(i) ? <Badge tone="ok">Read</Badge>
                      : s?.status === 'failed' ? <Badge tone="danger">Could not open</Badge> : null}
                  </li>
                );
              })}
            </ul>
            {Object.entries(docState).filter(([, s]) => s.status === 'failed').map(([i, s]) => (
              <Alert key={i}>Document {Number(i) + 1}: {(s as { message: string }).message}</Alert>
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
                      <a href={preview.url} target="_blank" rel="noopener">Open document {preview.index + 1} in a new tab</a>
                    </div>
                  ) : (
                    <div className="j-state">
                      <span>This file type cannot be shown here.</span>
                      <a href={preview.url} download={`prescription-${preview.index + 1}`}
                        onClick={() => setState(preview.index, { status: 'shown' })}>
                        Download document {preview.index + 1} to read it
                      </a>
                    </div>
                  )}
                </div>
                <label className="rx-ack">
                  <input type="checkbox" disabled={current?.status !== 'shown'} checked={read.has(preview.index)}
                    onChange={(e) => {
                      const i = preview.index;
                      setRead((r) => { const n = new Set(r); if (e.target.checked) n.add(i); else n.delete(i); return n; });
                    }} />
                  I have read document {preview.index + 1} and it is legible
                </label>
              </div>
            )}
          </>
        )}
      </section>

      <section className="ws-section" aria-labelledby="decision-h">
        <h2 id="decision-h">Decision</h2>
        <form className="rx-form" noValidate onSubmit={(e: FormEvent) => { e.preventDefault(); submit(rejecting ? 'reject' : 'approve'); }}>
          {profile.isPending ? <Loading label="Loading your pharmacist…" />
            : !pharmacist ? (
              <Alert tone="warn">
                Add your pharmacist's name and registration number first; every decision records them.{' '}
                <Link to="/pharmacy/settings">Go to Settings</Link>
              </Alert>
            ) : (
              <p className="ws-muted">Deciding as {pharmacist.name} ({pharmacist.registrationNumber}). <Link to="/pharmacy/settings">Change</Link></p>
            )}
          {rejecting && (
            <TextArea label="Reason for rejection" hint="The customer sees this. Paid orders are refunded and the stock is released."
              value={reason} onChange={(e) => setReason(e.target.value)} error={errors.reason} maxLength={1000} />
          )}
          {review.isError && <Alert>{messageOf(review.error)}{review.error instanceof ApiError && review.error.status === 409
            ? ' The order has been reloaded; check it again.' : ''}</Alert>}
          <div className="rx-actions">
            {!rejecting ? (
              <>
                <Button type="submit" busy={review.isPending} disabled={!allRead || !pharmacist}>Approve</Button>
                {/* Rejecting is allowed without reading: an unreadable or missing prescription is a reason to reject. */}
                <Button variant="secondary" disabled={review.isPending || !pharmacist} onClick={() => setRejecting(true)}>Reject…</Button>
                {docs.length > 0 && !allRead && (
                  <span className="ws-muted">Read and confirm all {docs.length} documents to approve.</span>
                )}
              </>
            ) : (
              <>
                <Button type="submit" variant="danger" busy={review.isPending} disabled={!pharmacist}>Confirm rejection</Button>
                <Button variant="ghost" disabled={review.isPending} onClick={() => { setRejecting(false); setErrors({}); }}>
                  Cancel
                </Button>
              </>
            )}
          </div>
        </form>
      </section>
    </>
  );
}
