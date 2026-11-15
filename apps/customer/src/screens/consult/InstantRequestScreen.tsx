import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import {
  ApiError, countdown, customerApi, fromPaise, heldRefundMinor, INSTANT_INACTIVITY_MIN, INSTANT_MODE_LABEL, INSTANT_PAYMENT_WINDOW_MIN,
  instantConsultApi, waitingState, type InstantRequest, type InstantTarget,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, formatDateTime, formatRupees, Loading } from '@jansetu/ui';
import { Confirm, messageOf, PageHeading } from '../../common.tsx';
import { PayAgainPanel } from '../../payAgain.tsx';
import { useSession } from '../../session.tsx';
import { instantStatusOf } from './labels.ts';

/** How often the customer's presence is reported while the waiting screen is visible (the refund comes after 30 idle minutes). */
export const ACTIVITY_EVERY_MS = 2 * 60_000;
/** After acceptance: the call link is made after the accept, and the doctor may still cancel (refund): keep looking. */
export const ACCEPTED_REFRESH_MS = 15_000;

export function InstantRequestScreen() {
  const { requestId = '' } = useParams();
  const { api } = useSession();
  const valid = /^[0-9a-fA-F]{24}$/.test(requestId);
  const q = useQuery({
    queryKey: ['instant-requests', 'one', requestId], queryFn: () => instantConsultApi(api).request(requestId), enabled: valid,
    // Waiting: look often for an acceptance; unpaid: the server may confirm a late payment or close the request.
    // Waiting: often; unpaid: the server may confirm a late payment or close it; accepted: until the consultation ends
    // (a doctor cancellation turns it into a refund). Refunded and expired requests are final.
    refetchInterval: (query) => {
      const st = query.state.data?.status;
      return st === 'offered' ? 5_000 : st === 'pending_payment' ? 30_000 : st === 'accepted' ? ACCEPTED_REFRESH_MS : false;
    },
  });
  return (
    <>
      <Link to="/bookings" className="back"><ArrowLeft size={16} aria-hidden="true" /> My bookings</Link>
      {!valid ? <Empty title="Request not found" />
        : q.isPending ? <Loading /> : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : <RequestView request={q.data} />}
    </>
  );
}

function RequestView({ request: r }: { request: InstantRequest }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const paymentError = (useLocation().state as { paymentError?: string } | null)?.paymentError;
  const s = instantStatusOf(r);
  const paidAmount = fromPaise(r.quotedAmountMinor - r.discountMinor);
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['instant-requests'] });
    await queryClient.invalidateQueries({ queryKey: ['wallet'] });
  };
  return (
    <>
      <PageHeading title={`${INSTANT_MODE_LABEL[r.mode]} · ${r.specialization}`}>For {r.patient.name}{r.createdAt ? ` · ${formatDateTime(r.createdAt)}` : ''}</PageHeading>
      <section className="card stack">
        <dl className="details">
          <dt>Status</dt><dd><Badge tone={s.tone}>{s.label}</Badge></dd>
          <dt>Doctor</dt><dd>{r.target.kind === 'any' ? 'Any available doctor' : 'The doctor you chose'}</dd>
          <dt>Price</dt>
          <dd>
            {formatRupees(fromPaise(r.quotedAmountMinor))}
            {r.discountMinor > 0 && <span className="muted"> (coupon {r.couponCode ?? ''} −{formatRupees(fromPaise(r.discountMinor))})</span>}
            {' · '}{r.paymentStatus === 'paid' ? 'paid' : r.paymentStatus === 'refunded' ? 'refunded to your wallet' : 'not paid'}
          </dd>
        </dl>
      </section>

      {paymentError && r.paymentStatus === 'pending' && <Alert>The payment page could not open: {paymentError} You can pay below.</Alert>}
      {r.status === 'pending_payment' && r.paymentStatus === 'pending' && (
        <PayAgainPanel key={`${r._id}:${r.paymentTransactionId ?? ''}`} what="request" deadline={r.paymentDeadline} paymentTransactionId={r.paymentTransactionId} expiredCode="INSTANT_PAYMENT_EXPIRED"
          description={`Consultation now · ${r.specialization}`} pay={() => instantConsultApi(api).pay(r._id)} onSettled={refresh} />
      )}
      {r.status === 'expired_unpaid' && (
        <Alert tone="warn">
          This request was not paid within {INSTANT_PAYMENT_WINDOW_MIN} minutes, so it was closed. Any wallet money used is back
          in your wallet. <Link to="/consult">Start again</Link>
        </Alert>
      )}
      {r.status === 'offered' && <Waiting request={r} paid={paidAmount ?? 0} onChanged={refresh} />}
      {r.status === 'accepted' && <Accepted request={r} />}
      {r.status === 'refunded' && (
        <Alert tone="ok">
          {r.refundReason === 'inactivity' ? `Nobody accepted and this screen was not open for ${INSTANT_INACTIVITY_MIN} minutes, so the request was closed. `
            : r.refundReason === 'doctor_cancelled' ? 'The doctor cancelled the consultation. '
            : 'You asked for a refund, so the request was closed. '}
          {formatRupees(fromPaise(heldRefundMinor(r)))} went back to your Jansetu wallet. <Link to="/consult">Start again</Link>
        </Alert>
      )}
    </>
  );
}

/**
 * Waiting for a doctor. While this screen is visible the customer's presence is reported (so the held money is not
 * refunded for inactivity); the current offer's time left is shown. When nobody accepted in time the customer offers
 * it again within the amount already paid, or asks for a refund to the wallet.
 */
function Waiting({ request: r, paid, onChanged }: { request: InstantRequest; paid: number; onChanged: () => Promise<void> }) {
  const { api } = useSession();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => {
    const ping = () => {
      if (document.visibilityState !== 'visible') return;
      instantConsultApi(api).activity(r._id).catch((err: unknown) => {
        // No longer waiting (accepted or refunded meanwhile): read the request again.
        if (err instanceof ApiError && err.code === 'REQUEST_NOT_OPEN') void onChanged();
      });
    };
    ping();
    const t = setInterval(ping, ACTIVITY_EVERY_MS);
    document.addEventListener('visibilitychange', ping);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', ping); };
  }, [r._id]);
  const w = waitingState(r, now);
  return (
    <section className="card stack" aria-labelledby="wait-h">
      <h2 id="wait-h">{w === 'offer_open' ? 'Waiting for a doctor to accept' : 'Nobody accepted in time'}</h2>
      {w === 'offer_open' ? (
        <>
          <p className="muted">
            {r.target.kind === 'any' ? 'Every online doctor within your paid amount has been asked.' : 'The doctor you chose has been asked.'} Keep this
            screen open; it updates by itself.
          </p>
          <p role="timer" aria-live="off" aria-label="Time left for this offer"><span className="countdown">{countdown(r.offerExpiresAt, now)}</span> left</p>
        </>
      ) : (
        <>
          <Alert tone="warn">No doctor accepted within the time. Offer it again, or get your {formatRupees(paid)} back in your wallet.</Alert>
          <Reoffer request={r} onChanged={onChanged} />
        </>
      )}
      <Confirm label="Cancel and refund to my wallet" confirmLabel="Yes, refund to my wallet"
        consequence={`The request is closed and everything you paid (${formatRupees(paid)}) goes back to your Jansetu wallet. A doctor can no longer accept it.`}
        onConfirm={async () => {
          try { await instantConsultApi(api).refund(r._id); }
          catch (err) {
            if (err instanceof ApiError && err.code === 'REQUEST_NOT_REFUNDABLE') {
              throw new ApiError(409, 'A doctor has just accepted, so it can no longer be refunded. Open your consultation below.', err.code);
            }
            throw err;
          } finally { await onChanged(); }
        }} />
    </section>
  );
}

function Reoffer({ request: r, onChanged }: { request: InstantRequest; onChanged: () => Promise<void> }) {
  const { api } = useSession();
  const doctors = useQuery({ queryKey: ['instant-doctors', { specialization: r.specialization, mode: r.mode }], queryFn: () => instantConsultApi(api).doctors(r.specialization, r.mode),
    staleTime: 0 });
  // Only doctors within the amount already paid (and the coupon's doctors, when the coupon names some).
  const eligible = (doctors.data ?? []).filter((d) => d.instantFeeMinor <= r.quotedAmountMinor && (!r.couponDoctorIds || r.couponDoctorIds.includes(d.doctorId)));
  const [target, setTarget] = useState<InstantTarget>({ kind: 'any' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function offer() {
    setBusy(true); setError(null);
    try { await instantConsultApi(api).reoffer(r._id, target); }
    catch (err) { setError(messageOf(err)); }
    finally { setBusy(false); await onChanged(); }
  }
  return (
    <div className="stack">
      {doctors.isPending ? <Loading label="Finding doctors online…" />
        : doctors.isError ? <ErrorState message={messageOf(doctors.error)} onRetry={() => void doctors.refetch()} />
        : (
          <fieldset className="stack fieldset-plain">
            <legend>Offer it to</legend>
            <label className="check">
              <input type="radio" name="reoffer" checked={target.kind === 'any'} onChange={() => setTarget({ kind: 'any' })} />
              <span>Any available doctor{eligible.length ? ` (${eligible.length} online)` : ' (nobody online right now)'}</span>
            </label>
            {eligible.map((d) => (
              <label key={d.doctorId} className="check">
                <input type="radio" name="reoffer" checked={target.kind === 'specific' && target.doctorId === d.doctorId}
                  onChange={() => setTarget({ kind: 'specific', doctorId: d.doctorId })} />
                <span>{d.name} · {formatRupees(fromPaise(d.instantFeeMinor))}</span>
              </label>
            ))}
          </fieldset>
        )}
      {error && <Alert>{error}</Alert>}
      <div className="row">
        <Button busy={busy} onClick={() => void offer()}>Offer again</Button>
        <Button variant="secondary" disabled={busy} onClick={() => void doctors.refetch()}>Refresh doctors</Button>
      </div>
    </div>
  );
}

/** Accepted: the consultation booking exists; the Meet link (call/video) comes from it when it has been created. */
function Accepted({ request: r }: { request: InstantRequest }) {
  const { api } = useSession();
  const bookingId = r.bookingId ?? '';
  const queryClient = useQueryClient();
  const booking = useQuery({
    queryKey: ['booking', bookingId], queryFn: () => customerApi(api).booking(bookingId), enabled: /^[0-9a-fA-F]{24}$/.test(bookingId),
    // The Meet link is created after the accept (best effort): keep reading the consultation until it has a link or ends.
    refetchInterval: (query) => {
      const b = query.state.data;
      if (b && (b.status === 'completed' || b.status === 'cancelled')) return false;
      return ACCEPTED_REFRESH_MS;
    },
  });
  const back = (r.returned?.walletMinor ?? 0) + (r.returned?.gatewayMinor ?? 0);
  const meet = booking.data?.virtualMeeting;
  const join = meet?.status === 'active' && meet.joinUrl && /^https:\/\//.test(meet.joinUrl) ? meet.joinUrl : null;
  const [refreshing, setRefreshing] = useState(false);
  async function refreshNow() {
    setRefreshing(true);
    try {
      await queryClient.invalidateQueries({ queryKey: ['instant-requests', 'one', r._id] });
      await booking.refetch();
    } finally { setRefreshing(false); }
  }
  return (
    <section className="card stack" aria-labelledby="acc-h">
      <h2 id="acc-h">A doctor accepted</h2>
      <Alert tone="ok">
        {booking.data?.doctorName ? `${booking.data.doctorName} is` : 'Your doctor is'} joining your {INSTANT_MODE_LABEL[r.mode].toLowerCase()}.
        {back > 0 ? ` ${formatRupees(fromPaise(back))} (the difference from your quote) is back in your wallet.` : ''}
      </Alert>
      <div className="row">
        {join && <a className="j-btn j-btn--primary" href={join} target="_blank" rel="noopener noreferrer">Join the call</a>}
        {bookingId && <Link className="j-btn j-btn--secondary" to={`/bookings/${bookingId}`}>Open your consultation</Link>}
      </div>
      {booking.isError && (
        <ErrorState message={`Your consultation could not be loaded: ${messageOf(booking.error)}`} onRetry={() => void booking.refetch()} />
      )}
      {!join && r.mode !== 'chat' && booking.isSuccess && booking.data.status === 'confirmed' && (
        <p className="muted" role="status">The call link is being prepared. It appears here and on your consultation once it is ready; this page checks by itself.</p>
      )}
      {booking.data?.status === 'cancelled' && <Alert tone="warn">This consultation was cancelled.</Alert>}
      <div className="row"><Button variant="ghost" busy={refreshing} onClick={() => void refreshNow()}>Refresh</Button></div>
      <p className="muted">A consultation cannot be cancelled once a doctor has accepted it. If the doctor cancels, you get a full refund to your wallet.</p>
    </section>
  );
}
