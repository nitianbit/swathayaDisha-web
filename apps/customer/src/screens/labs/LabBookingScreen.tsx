import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useParams } from 'react-router';
import { ArrowLeft, CheckCircle2, Circle } from 'lucide-react';
import {
  ApiError, customerLabsApi, fromPaise, LAB_CANCEL_CUTOFF_HOURS, LAB_PAYMENT_WINDOW_MIN, labCancelCheck, labTimeline, type LabBooking,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, formatDateTime, formatRupees, Loading } from '@jansetu/ui';
import { Confirm, messageOf, PageHeading } from '../../common.tsx';
import { PrivateFile } from '../../files.tsx';
import { PayAgainPanel } from '../../payAgain.tsx';
import { useSession } from '../../session.tsx';
import { clock, labStatusOf, labTitle, VISIT_MODE_LABEL } from './labels.ts';

export function LabBookingScreen() {
  const { bookingId = '' } = useParams();
  const { api } = useSession();
  const valid = /^[0-9a-fA-F]{24}$/.test(bookingId);
  const q = useQuery({
    queryKey: ['lab-bookings', 'one', bookingId], queryFn: () => customerLabsApi(api).booking(bookingId), enabled: valid,
    // While unpaid, the server may confirm a late payment or release the booking: keep it current.
    refetchInterval: (query) => (query.state.data?.status === 'pending_payment' ? 30_000 : false),
  });
  return (
    <>
      <Link to="/bookings" className="back"><ArrowLeft size={16} aria-hidden="true" /> My bookings</Link>
      {!valid ? <Empty title="Booking not found" />
        : q.isPending ? <Loading /> : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : <LabBookingView booking={q.data} />}
    </>
  );
}

const slotText = (s: LabBooking['slot']) => (s.startsAt ? formatDateTime(s.startsAt) : `${s.date} ${clock(s.startTime)}`);

function LabBookingView({ booking: b }: { booking: LabBooking }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const paymentError = (useLocation().state as { paymentError?: string } | null)?.paymentError;
  const labs = useQuery({ queryKey: ['partner-labs', {}], queryFn: () => customerLabsApi(api).labs({}) });
  const lab = labs.data?.find((l) => l.partnerId === b.partnerId);
  const branch = lab?.branches.find((x) => x.branchId === b.branchId);
  const s = labStatusOf(b);
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['lab-bookings'] });
    await queryClient.invalidateQueries({ queryKey: ['wallet'] });
  };
  const paid = b.paymentStatus === 'paid';
  const cancel = labCancelCheck(b);
  return (
    <>
      <PageHeading title={labTitle(b)}>{slotText(b.slot)} · {VISIT_MODE_LABEL[b.visitMode]}</PageHeading>
      <section className="card stack">
        <dl className="details">
          <dt>Status</dt><dd><Badge tone={s.tone}>{s.label}</Badge></dd>
          <dt>For</dt><dd>{b.patient.name}</dd>
          {lab && <><dt>Lab</dt><dd>{lab.name}{branch ? `, ${branch.name}` : ''}</dd></>}
          {b.visitMode === 'home' && b.address
            ? <><dt>Address</dt><dd>{[b.address.line1, b.address.line2, b.address.landmark, b.address.city, b.address.pincode].filter(Boolean).join(', ')}</dd></>
            : branch?.address ? <><dt>Where</dt><dd>{[branch.address.line1, branch.address.city, branch.address.pincode].filter(Boolean).join(', ')}</dd></> : null}
          {b.collector?.name && <><dt>Collector</dt><dd>{b.collector.name}{b.collector.phone ? ` · ${b.collector.phone}` : ''}</dd></>}
          <dt>Total</dt>
          <dd>
            {formatRupees(fromPaise(b.pricing.payableMinor))} · {paid ? 'paid' : b.paymentStatus === 'refunded' ? 'refunded to your wallet' : 'not paid'}
            {b.pricing.discountMinor > 0 && <span className="muted"> (coupon {b.pricing.couponCode ?? ''} −{formatRupees(fromPaise(b.pricing.discountMinor))})</span>}
          </dd>
        </dl>
        <ul className="plain">
          {b.items.map((i) => <li key={i.catalogItemId}>{i.name}{i.kind === 'package' ? ' (package)' : ''} · {formatRupees(fromPaise(i.priceMinor))}</li>)}
        </ul>
      </section>

      {b.status === 'cancelled' && <CancelledNote booking={b} />}
      {b.status === 'no_show' && <Alert tone="warn">The lab marked you as not present for this time. A missed booking is not refunded.</Alert>}
      {paymentError && b.paymentStatus === 'pending' && <Alert>The payment page could not open: {paymentError} You can pay below.</Alert>}
      {b.status === 'pending_payment' && b.paymentStatus === 'pending' && (
        <PayAgainPanel what="booking" deadline={b.paymentDeadline} paymentTransactionId={b.paymentTransactionId}
          expiredCode="LAB_BOOKING_PAYMENT_EXPIRED" description={`Lab tests${lab ? ` at ${lab.name}` : ''}`}
          pay={() => customerLabsApi(api).payAgain(b._id)} onSettled={refresh} />
      )}
      {b.status === 'confirmed' && b.reschedule?.pending && <ReschedulePanel booking={b} onChanged={refresh} />}
      <Timeline booking={b} />
      {b.report.files.length > 0 && (
        <section className="card stack" aria-labelledby="reports-h">
          <h2 id="reports-h">Reports</h2>
          {b.report.files.map((f, i) => {
            const r = b.report.files.length === b.report.releases.length ? b.report.releases[i] : undefined;
            const label = b.report.files.length === 1 ? 'report' : `report ${i + 1}`;
            return (
              <div key={f} className="stack">
                {r && <p className="muted">Released {formatDateTime(r.releasedAt)} by {r.signer.name}{r.signer.registrationNumber ? ` (Reg. ${r.signer.registrationNumber})` : ''}</p>}
                <PrivateFile label={label} baseName={`lab-report-${i + 1}`} load={(signal) => customerLabsApi(api).reportFile(f, signal)} />
              </div>
            );
          })}
        </section>
      )}
      {(b.status === 'pending_payment' || b.status === 'confirmed') && (
        <section className="card stack" aria-labelledby="cancel-h">
          <h2 id="cancel-h">Cancel</h2>
          {cancel.ok ? (
            <>
              {cancel.deadline && <p className="muted">You can cancel until {formatDateTime(cancel.deadline.toISOString())} ({LAB_CANCEL_CUTOFF_HOURS} hours before the time).</p>}
              {b.reschedule?.pending && paid && <p className="muted">While the lab’s new time is unanswered you can cancel at any time, with a full refund.</p>}
              <Confirm label="Cancel this booking" confirmLabel="Yes, cancel it" withReason
                consequence={cancel.refund
                  ? 'The booking is cancelled and everything you paid goes back to your Jansetu wallet.'
                  : 'The booking is cancelled and the time is released. Any wallet money held for it goes back to your wallet.'}
                onConfirm={async (reason) => { try { await customerLabsApi(api).cancel(b._id, reason || undefined); } finally { await refresh(); } }} />
            </>
          ) : (
            <Alert tone="warn">Paid bookings can be cancelled until {LAB_CANCEL_CUTOFF_HOURS} hours before the time. That time has passed.</Alert>
          )}
        </section>
      )}
    </>
  );
}

function CancelledNote({ booking: b }: { booking: LabBooking }) {
  const c = b.cancellation;
  if (c?.reason === 'timeout') {
    return (
      <Alert tone="warn">
        This booking expired because it was not paid within {LAB_PAYMENT_WINDOW_MIN} minutes, so the time was released. Any
        wallet money used for it is back in your wallet. You can book again.
      </Alert>
    );
  }
  if (c?.reason === 'lab_reject') {
    return <Alert tone="warn">The lab could not take this booking{c.note ? `: “${c.note}”` : '.'} Everything you paid is back in your Jansetu wallet.</Alert>;
  }
  return <Alert tone="warn">You cancelled this booking{c?.at ? ` on ${formatDateTime(c.at)}` : ''}. Anything you paid is back in your Jansetu wallet.</Alert>;
}

/** The lab moved the booking: the customer accepts exactly the proposal shown (its version), or cancels with a full refund. */
function ReschedulePanel({ booking: b, onChanged }: { booking: LabBooking; onChanged: () => Promise<void> }) {
  const { api } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const r = b.reschedule!;
  async function accept() {
    setBusy(true); setError(null);
    try {
      await customerLabsApi(api).acceptReschedule(b._id, r.version);
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'RESCHEDULE_CHANGED'
        ? 'The lab changed the time again. Check the new time below before accepting.' : messageOf(err));
    } finally {
      setBusy(false);
      await onChanged();
    }
  }
  return (
    <section className="card stack" aria-labelledby="resched-h">
      <h2 id="resched-h">The lab proposed a new time</h2>
      <dl className="details">
        <dt>New time</dt><dd><strong>{slotText(b.slot)}</strong></dd>
        {r.previousSlot && <><dt>Was</dt><dd>{slotText(r.previousSlot)}</dd></>}
        {r.reason && <><dt>Reason</dt><dd>{r.reason}</dd></>}
      </dl>
      <p className="muted">Accept the new time, or cancel below for a full refund to your wallet.</p>
      {error && <Alert>{error}</Alert>}
      <div className="row"><Button busy={busy} onClick={() => void accept()}>Accept the new time</Button></div>
    </section>
  );
}

function Timeline({ booking: b }: { booking: LabBooking }) {
  const steps = labTimeline(b);
  return (
    <section className="card stack" aria-labelledby="progress-h">
      <h2 id="progress-h">Progress</h2>
      <ol className="timeline">
        {steps.map((s) => (
          <li key={s.key} data-done={s.done}>
            {s.done ? <CheckCircle2 size={16} aria-hidden="true" /> : <Circle size={16} aria-hidden="true" />}
            <span>{s.label}{s.at ? <span className="muted"> · {formatDateTime(s.at)}</span> : null}<span className="j-sr-only">{s.done ? ' (done)' : ' (to come)'}</span></span>
          </li>
        ))}
      </ol>
    </section>
  );
}
