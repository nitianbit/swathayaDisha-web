import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  ApiError, BOOKING_CLOSE_REFUSAL, bookingCloseApi, bookingCloseFinal, bookingCloseRefusal, bookingCloseRefusedBeforeWriting, canCloseAndRefund,
  closeByKey, closeRefundTarget, closeRefundWords, doctorAdminListApi, doctorEligibility, isAlreadyCancelled, MAX_ADMIN_CANCEL_REASON, OBJECT_ID_PATTERN,
  type AdminConsultation, type BookingClose, type BookingCloseAnswer, type CloseRefundTarget,
} from '@jansetu/api';
import { Alert, ErrorState, formatDateTime, formatRupees, Loading } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { messageOf } from '../../errors.ts';
import { newRequestKey, startOp, type PendingOp } from '../../requests.ts';
import { useSession, useStaff } from '../../session.tsx';
import { formatYmd } from '../doctor/doctor.tsx';
import type { Perform } from '../finance/finance.tsx';
import { CheckPanel, useOwnedOp } from '../pharmacy/ownedOp.tsx';
import { DoctorBadges } from './DoctorsScreen.tsx';

/** A close kept until its answer is known: the reason and the booking version reviewed (`expectedUpdatedAt`). */
interface PendingClose { reason: string; expectedUpdatedAt?: string; when: string }

type Booking = AdminConsultation & { assisted?: unknown };
const when = (b: Pick<AdminConsultation, 'bookingDate' | 'bookingTime'>) => `${formatYmd(b.bookingDate)}, ${b.bookingTime}`;
const PATIENT_NOTICE = 'The patient is told “Your consultation was cancelled by Jansetu.”';

/**
 * WQ18 (backend S5c–S5f, `bookings/adminClose.ts`): "Close and refund" for a consultation stuck with a doctor who is not
 * verified and active. The existing ConfirmAction asks for an internal reason (3–500; the patient never sees it, S5d) and
 * holds the booking version it was opened on (it closes, saying so, if the booking changes while open); one owned PendingOp is stored before sending `POST /specialists/admin/bookings/:id/close {reason, requestKey,
 * expectedUpdatedAt}`. The server closes once per (admin, key) and answers a repeat with the same close (`replayed`), so a
 * lost answer is sent again unchanged, or checked: the booking is read first, then its closes
 * (`GET /specialists/admin/bookings/:id/close`): our key there = closed; the booking cancelled without our key = closed by
 * someone else (a cancelled booking can never be closed later); otherwise still unknown. The result and the refund are
 * said as the server answers them, and every close of the booking is listed with its refund.
 */
export function BookingCloseSection({ b, bookingId, scopeKey, perform, busy, readNow, reread }: {
  b: Booking; bookingId: string; scopeKey: readonly string[]; perform: Perform; busy: boolean; readNow: () => Promise<Booking>; reread: () => void;
}) {
  const { api } = useSession();
  const admin = useStaff();
  const closes = bookingCloseApi(api);
  const { op, send, settle } = useOwnedOp<PendingClose>(`admin-booking-close:${admin.id}:${bookingId}`);
  const doctorId = b.specialistId && OBJECT_ID_PATTERN.test(b.specialistId) ? b.specialistId : null;
  const doctor = useQuery({
    queryKey: [...scopeKey, 'doctor', doctorId],
    queryFn: () => doctorAdminListApi(api).get(doctorId!),
    enabled: !!doctorId,
    retry: (n, err) => !(err instanceof ApiError && err.status === 404) && n < 2,
  });
  const record = useQuery({
    queryKey: [...scopeKey, 'closes', bookingId],
    queryFn: () => closes.closes(bookingId),
    enabled: b.status === 'cancelled',
  });
  const [done, setDone] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const target = closeRefundTarget(b);

  const doctorState: 'eligible' | 'ineligible' | 'missing' | 'unknown' = !doctorId ? 'missing'
    : doctor.data ? (doctorEligibility(doctor.data).eligible ? 'eligible' : 'ineligible')
    : doctor.error instanceof ApiError && doctor.error.status === 404 ? 'missing' : 'unknown';

  const closedWords = (refunded: number, to: CloseRefundTarget) => `${closeRefundWords(refunded, to, formatRupees)} ${PATIENT_NOTICE}`;
  /** `how`: answered to the first send, to a resend of the same request, or found by a check. */
  const closed = (a: { refunded: number; replayed?: boolean; to: CloseRefundTarget }, whenText: string, how: 'sent' | 'resent' | 'checked') => {
    if (!live.current) return;
    setRefused(null);
    setDone(how === 'checked' ? `It was closed: the appointment on ${whenText} is cancelled. ${closedWords(a.refunded, a.to)}`
      : a.replayed ? `This close was already recorded: the appointment on ${whenText} is cancelled. ${closeRefundWords(a.refunded, a.to, formatRupees)} Nothing more was changed.`
      : `Closed: the appointment on ${whenText} is cancelled. ${closedWords(a.refunded, a.to)}${how === 'resent' ? ' It was closed once, even though it was sent more than once.' : ''}`);
    reread();
  };
  const refuse = (text: string) => { if (live.current) { setDone(null); setRefused(text); } reread(); };

  /**
   * ALREADY_CANCELLED: our own key may have closed it (a resend racing its first attempt); the closes, read while the guard
   * is still held, say who did. `rows` null = they could not be read: an attempt that may have closed it stays unknown.
   */
  function alreadyCancelled(p: PendingOp<PendingClose>, sole: boolean, rows: BookingClose[] | null): boolean {
    const mine = closeByKey(rows, p.requestKey);
    if (mine) { settle(p.requestKey); closed({ refunded: mine.refunded, to: target }, p.body.when, 'checked'); return true; }
    if (rows || sole) {
      settle(p.requestKey);
      refuse(`Not closed by this request: ${BOOKING_CLOSE_REFUSAL.ALREADY_CANCELLED} Its cancellation is shown on this page.`);
      return true;
    }
    return false;
  }

  async function sendClose(p: PendingOp<PendingClose>) {
    setDone(null);
    setRefused(null);
    setResendError(null);
    const sole = p.attempts === 0 && !p.uncertain;
    const { r, rows } = await perform(async () => {
      const answer = await send(p, (body) => closes.close(bookingId, { reason: body.reason, requestKey: p.requestKey, expectedUpdatedAt: body.expectedUpdatedAt }));
      const cancelled = (answer.kind === 'refused' || answer.kind === 'unknown') && isAlreadyCancelled(answer.error);
      return { r: answer, rows: cancelled ? await closes.closes(bookingId).catch(() => null) : null };
    });
    if (r.kind === 'stale') return;
    if (r.kind === 'ok') {
      const a: BookingCloseAnswer = r.value;
      closed({ refunded: a.refunded, replayed: a.replayed, to: closeRefundTarget(a) }, p.body.when, p.attempts > 0 ? 'resent' : 'sent');
      return;
    }
    if (isAlreadyCancelled(r.error) && alreadyCancelled(p, r.kind === 'refused', rows)) return;
    // Refused before anything was written (a sole first attempt), or a state this booking never leaves (any attempt).
    if (r.kind === 'refused' || (r.kind === 'unknown' && ((sole && bookingCloseRefusedBeforeWriting(r.error)) || (bookingCloseFinal(r.error) && !isAlreadyCancelled(r.error))))) {
      if (r.kind === 'unknown') settle(p.requestKey);
      refuse(`Not closed: ${bookingCloseRefusal(r.error)}`);
      if (r.error instanceof ApiError && r.error.code === 'BOOKING_CHANGED') void readNow().catch(() => null);
      return;
    }
    reread();
  }

  const open = b.status === 'pending' || b.status === 'confirmed';
  const offered = canCloseAndRefund(b, doctorState);
  const showClose = offered && !(op && !(busy && op.attempts === 1 && !op.uncertain));

  return (
    <section className="ws-section" aria-labelledby="close-h">
      <h2 id="close-h">Close and refund</h2>
      {done && <Alert tone="ok">{done}</Alert>}
      {refused && <Alert>{refused}</Alert>}
      <dl className="ws-dl">
        <dt>Doctor’s status</dt>
        <dd>
          {!doctorId ? 'No doctor on this booking'
            : doctor.isPending ? 'Reading…'
            : doctor.data ? <><DoctorBadges d={doctor.data} /> <Link to={`/admin/doctors/${doctorId}`}>Open the doctor</Link></>
            : doctorState === 'missing' ? 'This doctor no longer exists'
            : 'Could not be read'}
        </dd>
      </dl>
      {doctorId && doctor.isError && doctorState === 'unknown' && <ErrorState message={messageOf(doctor.error)} onRetry={() => void doctor.refetch()} />}
      {b.status === 'cancelled' && <ClosesList q={record} to={target} />}
      {op && !(busy && op.attempts === 1 && !op.uncertain) ? (
        <>
          {resendError && <Alert>{resendError}</Alert>}
          <PendingClosePanel op={op} busy={busy}
            onCheck={async () => {
              // The booking first, then its closes: a booking cancelled before the closes were read can never be closed later.
              const now = await readNow();
              const rows = await closes.closes(bookingId);
              reread();
              const mine = closeByKey(rows, op.requestKey);
              const whenText = op.body ? op.body.when : when(now);
              if (mine) { settle(op.requestKey); closed({ refunded: mine.refunded, to: closeRefundTarget(now) }, whenText, 'checked'); return null; }
              if (now.status === 'cancelled' || now.status === 'completed' || now.status === 'no_show') {
                settle(op.requestKey);
                refuse(now.status === 'cancelled'
                  ? 'Not closed by this request: the booking was cancelled another way (its cancellation is shown on this page). This request refunded nothing.'
                  : `Not closed: the booking is ${now.status === 'completed' ? 'completed' : 'a no-show'} now, so it can no longer be closed. This request changed nothing.`);
                return null;
              }
              return op.restored || !op.body
                ? 'Not closed so far. It may still be on its way. Check again in a minute before closing it again.'
                : 'Not closed so far. It may still be on its way. Sending the same request again is safe: it is closed only once.';
            }}
            onResend={() => { setResendError(null); void sendClose(op).catch((err: unknown) => setResendError(bookingCloseRefusal(err))); }}
            onForget={() => settle(op.requestKey)} />
        </>
      ) : showClose ? (
        <>
          <p className="ws-muted">{doctorState === 'missing' ? 'Its doctor no longer exists' : 'Its doctor is not verified or not active'}: the Jansetu team closes it with a full refund.</p>
          <ConfirmAction key="close" label="Close and refund" danger confirmLabel="Yes, close and refund" reason reasonLabel="Reason (only the Jansetu team sees it)"
            maxReason={MAX_ADMIN_CANCEL_REASON} disabled={busy} version={b.updatedAt}
            consequence={(
              <>
                <p>Close the appointment on <strong>{when(b)}</strong>{b.doctorName ? ` with ${b.doctorName}` : ''} and refund it in full?</p>
                <ul className="ws-list">
                  <li>It is cancelled at once, whatever the time: the seat and the doctor’s time are freed. This cannot be undone.</li>
                  <li>Everything paid through Jansetu goes back in full: to the patient’s Jansetu wallet, or to the pharmacy if a pharmacy booked it.</li>
                  <li>{PATIENT_NOTICE} Your reason is not shown to them.</li>
                </ul>
              </>
            )}
            onConfirm={(reason, openedOn) => sendClose(startOp(newRequestKey(), {
              reason, when: when(b), ...(typeof openedOn === 'string' ? { expectedUpdatedAt: openedOn } : {}),
            }))} />
        </>
      ) : open && doctorState === 'eligible' ? (
        <p className="ws-muted">Its doctor is verified and active, so it is not closed here. Close and refund is for consultations whose doctor is not verified or not active.</p>
      ) : open && b.bookingKind === 'instant' ? (
        <p className="ws-muted">An instant consultation is cancelled with its own admin cancel, not here.</p>
      ) : open && !offered && doctorState !== 'unknown' ? (
        <p className="ws-muted">This booking was moved after a no-show: use “Cancel (admin)” in its no-show section.</p>
      ) : !open && b.status !== 'cancelled' ? (
        <p className="ws-muted">Only a waiting or confirmed consultation can be closed.</p>
      ) : null}
    </section>
  );
}

/** The closes recorded for this booking (S5e), each with its refund and the admin's internal reason. */
function ClosesList({ q, to }: { q: { isPending: boolean; isError: boolean; error: unknown; data?: BookingClose[]; refetch: () => unknown }; to: CloseRefundTarget }) {
  if (q.isPending) return <Loading label="Reading how it was closed…" />;
  if (q.isError) return <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />;
  const rows = q.data ?? [];
  if (rows.length === 0) return <p className="ws-muted">Cancelled, but not with Close and refund.</p>;
  return (
    <ul className="ws-list" aria-label="Closes by the Jansetu team">
      {rows.map((r) => (
        <li key={r.auditId}>
          Closed by the Jansetu team on {formatDateTime(r.closedAt)}: {closeRefundWords(r.refunded, to, formatRupees)}
          {' '}It was {r.statusBefore === 'pending' ? 'waiting' : r.statusBefore}, payment {r.paymentStatusBefore}. Reason (internal): {r.reason}
        </li>
      ))}
    </ul>
  );
}

function PendingClosePanel({ op, busy, onCheck, onResend, onForget }: {
  op: PendingOp<PendingClose>; busy: boolean; onCheck: () => Promise<string | null>; onResend: () => void; onForget: () => void;
}) {
  const restored = !!op.restored || !op.body;
  return (
    <CheckPanel label="Unconfirmed close" onCheck={onCheck}
      resend={restored ? undefined : { label: 'Send the same request again', busy, onClick: onResend }}
      forget={{ label: 'Forget it', confirmLabel: 'Yes, forget it', onForget,
        consequence: 'The booking may already be closed, or may still be closed by this request. Forgetting it does not undo that. Read the booking again before closing it again: a booking already cancelled is never refunded twice.' }}>
      <Alert tone="warn">
        {restored
          ? 'A close made earlier on this device (before the page was reloaded) was not confirmed. Its details are not kept here. Check whether it was recorded.'
          : `The outcome of this close is not known yet${op.error ? ` (${op.error})` : ''}. The appointment on ${op.body.when} may already be closed and refunded. Sending the same request again is safe: it is closed only once.`}
      </Alert>
    </CheckPanel>
  );
}
