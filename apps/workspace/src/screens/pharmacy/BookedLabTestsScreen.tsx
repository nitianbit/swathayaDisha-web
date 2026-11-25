import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ArrowLeft, FileText } from 'lucide-react';
import {
  ApiError, bookingPaidBy, canCancelLab, formatSlotDate, isSwitchedOff, LAB_SWITCHED_OFF_MESSAGE, LAB_VISIT_MODE_LABEL, LATE_PAYMENT_BACK, labStatusLabel,
  orderFromBooking, type LabBookingListStatus, type LabBookingView, type RefundTo,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, formatDateTime, Loading } from '@jansetu/ui';
import { PageHeading } from '../../PageHeading.tsx';
import { newRequestKey, startOp, type PendingOp } from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { useOneAtATime, type Perform } from '../finance/finance.tsx';
import { DocumentPreview, useDocumentViewer } from './documentViewer.tsx';
import { CursorPager, StatusFilter, useCursorPages } from './cursorList.tsx';
import { CardAwareCancel } from './ownedCancel.tsx';
import { CardPaymentPanel } from './cardBooking.tsx';
import { CheckPanel, useOwnedOp, usePharmacyId } from './ownedOp.tsx';
import { pharmacyLabBooker, type LabBooker } from './labBooker.ts';

/**
 * WQ17: lab tests this pharmacy booked for walk-in patients (assisted booking phase 2a, backend r11 §24.11):
 * `GET /pharmacy-assisted/lab-bookings` (newest first, cursor-paged) and one booking (`…/lab-bookings/:id`): status, time,
 * tests, collector, the lab's proposed new time (accept it, or cancel with the refund to the wallet), cancel (up to 1 hour
 * before the time), and the released report files (`/file/fetch`, 90 days from the first release).
 * WQ25: the same list and booking for a doctor (`LabBooker`, backend r26); WQ27 (r29) with its card payments too.
 */
export function BookedLabTestsScreen() {
  const pharmacyId = usePharmacyId();
  const { api } = useSession();
  return (
    <>
      <PageHeading title="Booked lab tests">
        Lab tests your pharmacy booked for patients, newest first. Open one to see its time, cancel it or read its report.
        {' '}<Link to="/pharmacy/lab-book">Book a new one</Link>.
      </PageHeading>
      <LabList key={pharmacyId} booker={pharmacyLabBooker(api, pharmacyId)} />
    </>
  );
}

const STATUS_FILTERS: { value: LabBookingListStatus | ''; label: string }[] = [
  { value: '', label: 'All' }, { value: 'pending_payment', label: 'Waiting for payment' }, { value: 'confirmed', label: 'Confirmed' }, { value: 'sample_collected', label: 'Sample collected' },
  { value: 'visited', label: 'Visited' }, { value: 'processing', label: 'Processing' }, { value: 'report_ready', label: 'Report released' }, { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' }, { value: 'no_show', label: 'No-show' },
];
const PAGE_SIZE = 20;
const ymd8 = (d: string | undefined) => (d ?? '').replace(/-/g, '');
const when = (b: Pick<LabBookingView, 'slot'>) => `${formatSlotDate(ymd8(b.slot?.date))}${b.slot?.startTime ? `, ${b.slot.startTime}` : ''}`;

function LabBadges({ b }: { b: LabBookingView }) {
  return (
    <>
      {b.reschedule?.pending && <> <Badge tone="warn">New time proposed</Badge></>}
      {b.status === 'cancelled' && b.cancellation?.byKind === 'customer' && <> <Badge tone="warn">Cancelled by patient</Badge></>}
      {b.assisted?.disputed?.state === 'open' && <> <Badge tone="danger">Patient says this is not theirs</Badge></>}
      {(b.report?.releases?.length ?? 0) > 0 && <> <Badge tone="ok">Report</Badge></>}
    </>
  );
}

/** The list of what one booker booked (newest first, cursor-paged). */
export function LabList({ booker }: { booker: LabBooker }) {
  const [status, setStatus] = useState<LabBookingListStatus | ''>('');
  const pages = useCursorPages();
  const { cursor } = pages;
  const q = useQuery({
    queryKey: [...booker.listKey, 'list', status, cursor],
    queryFn: () => booker.routes.bookings({ ...(status ? { status } : {}), ...(cursor ? { cursor } : {}), limit: PAGE_SIZE }),
  });
  // WQ25: a doctor not verified and active is told so, and nothing else (r26: every route needs an eligible doctor).
  if (q.isError && booker.closed?.(q.error)) return <Alert tone="warn">{booker.closedMessage}</Alert>;
  return (
    <section className="ws-section" aria-labelledby="lab-list-h">
      <h2 id="lab-list-h" className="j-sr-only">Booked lab tests</h2>
      <StatusFilter id="lab-status" value={status} options={STATUS_FILTERS} onChange={(v) => { setStatus(v); pages.reset(); }} />
      {q.isPending ? <Loading label="Loading booked lab tests…" />
        : q.isError ? (isSwitchedOff(q.error) ? <Alert tone="warn">{LAB_SWITCHED_OFF_MESSAGE}</Alert>
          : <ErrorState message={booker.refusal(q.error).message} onRetry={() => void q.refetch()} />)
        : q.data.items.length === 0 ? (
          <Empty title={status ? 'No lab tests with this status' : 'No lab tests booked yet'}>
            <Link to={booker.paths.book}>Book a lab test</Link>{booker.words.emptyFor}
          </Empty>
        ) : (
          <>
            <div className="ws-table-wrap">
              <table className="j-table">
                <caption className="j-sr-only">Booked lab tests, newest first</caption>
                <thead>
                  <tr><th scope="col">When</th><th scope="col">Patient</th><th scope="col">Lab</th><th scope="col">Tests</th><th scope="col">Status</th><th scope="col"><span className="j-sr-only">Open</span></th></tr>
                </thead>
                <tbody>
                  {q.data.items.map((b) => (
                    <tr key={b._id}>
                      <td>{when(b)}</td>
                      <td>{b.patientName ?? '—'}</td>
                      <td>{b.lab?.name ?? '—'}</td>
                      <td>{(b.items ?? []).map((i) => i.name).join(', ') || '—'}</td>
                      <td>{labStatusLabel(b.status)}<LabBadges b={b} /></td>
                      <td>
                        {/* WQ21 L2: a card booking waiting for its payment, as in Booked consultations. */}
                        {b.status === 'pending_payment'
                          ? <Link to={`${booker.paths.list}/${b._id}`} aria-label={`Pay now for the lab test of ${b.patientName ?? 'the patient'} at ${b.lab?.name ?? 'the lab'}`}>Pay now</Link>
                          : <Link to={`${booker.paths.list}/${b._id}`} aria-label={`Open the lab test of ${b.patientName ?? 'the patient'} at ${b.lab?.name ?? 'the lab'}`}>Open</Link>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <CursorPager pages={pages} nextCursor={q.data.nextCursor} label="Booked lab test pages" />
          </>
        )}
    </section>
  );
}

/** `/pharmacy/lab-tests/:bookingId`. */
export function BookedLabTestScreen() {
  const { bookingId = '' } = useParams();
  const pharmacyId = usePharmacyId();
  const { api } = useSession();
  return (
    <>
      <Link to="/pharmacy/lab-tests" className="ws-back"><ArrowLeft size={16} aria-hidden="true" /> Booked lab tests</Link>
      <PageHeading title="Lab test" />
      <LabDetail key={`${pharmacyId}:${bookingId}`} booker={pharmacyLabBooker(api, pharmacyId)} bookingId={bookingId} />
    </>
  );
}

const CANCELLED_BY: Readonly<Record<string, string>> = {
  customer: 'By the patient', partner: 'By the lab', admin: 'By Jansetu',
};

/** One booking of one booker: its details, a new time to accept, cancel and the released report. */
export function LabDetail({ booker, bookingId }: { booker: LabBooker; bookingId: string }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const valid = /^[0-9a-fA-F]{24}$/.test(bookingId);
  const q = useQuery({
    queryKey: [...booker.listKey, 'one', bookingId],
    queryFn: () => booker.routes.booking(bookingId),
    enabled: valid,
    retry: (n, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && n < 2,
  });
  const [note, setNote] = useState<string | null>(null);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const guard = useOneAtATime('lab booking');
  const changed = () => {
    void queryClient.invalidateQueries({ queryKey: booker.listKey });
    void queryClient.invalidateQueries({ queryKey: booker.walletKey });
  };

  if (!valid || (q.isError && q.error instanceof ApiError && q.error.status === 404 && q.error.code === 'LAB_BOOKING_NOT_FOUND')) {
    return <Empty title="Lab test not found"><Link to={booker.paths.list}>See all booked lab tests</Link></Empty>;
  }
  if (q.isError && booker.closed?.(q.error)) return <Alert tone="warn">{booker.closedMessage}</Alert>;
  if (q.isPending) return <Loading label="Loading the lab test…" />;
  if (q.isError) return <ErrorState message={booker.refusal(q.error).message} onRetry={() => void q.refetch()} />;
  const b = q.data;
  const r = b.reschedule?.pending ? b.reschedule : null;

  return (
    <>
      <section className="ws-section" aria-labelledby="lab-bk-h">
        <h2 id="lab-bk-h">Booking</h2>
        <dl className="ws-dl">
          {b.assisted?.shortRef && <><dt>Reference</dt><dd>{b.assisted.shortRef}</dd></>}
          <dt>Status</dt><dd>{labStatusLabel(b.status)}<LabBadges b={b} /></dd>
          <dt>Patient</dt><dd>{b.patientName ?? '—'}</dd>
          <dt>Lab</dt><dd>{b.lab?.name ?? '—'}{b.branch?.name ? `, ${b.branch.name}` : ''}{b.branch?.phone ? ` (${b.branch.phone})` : ''}</dd>
          <dt>Visit</dt><dd>{b.visitMode === 'home' || b.visitMode === 'lab' ? LAB_VISIT_MODE_LABEL[b.visitMode] : '—'}</dd>
          {b.visitMode === 'home' && b.address && <><dt>Address</dt><dd>{[b.address.line1, b.address.line2, b.address.city, b.address.pincode].filter(Boolean).join(', ')}</dd></>}
          {b.visitMode === 'lab' && b.branch?.address && <><dt>Lab address</dt><dd>{b.branch.address}</dd></>}
          <dt>When</dt><dd>{formatSlotDate(ymd8(b.slot?.date))}{b.slot?.startTime ? ` at ${b.slot.startTime}` : ''}{b.slot?.endTime ? `–${b.slot.endTime}` : ''}</dd>
          <dt>Tests</dt><dd>{(b.items ?? []).map((i) => i.name).join(', ') || '—'}</dd>
          {b.collector?.name && <><dt>Sample collector</dt><dd>{b.collector.name}</dd></>}
          {b.status === 'cancelled' && b.cancellation && <><dt>Cancelled</dt><dd>{(b.cancellation.byKind === 'booker' ? booker.words.byBooker : CANCELLED_BY[b.cancellation.byKind ?? '']) ?? '—'}{b.cancellation.at ? ` on ${formatDateTime(b.cancellation.at)}` : ''}</dd></>}
        </dl>
        {b.assisted?.disputed?.state === 'open' && <Alert tone="warn">The account holder told Jansetu this booking is not theirs. Jansetu is looking into it.</Alert>}
      </section>

      {note && <Alert tone="ok">{note}</Alert>}
      {acceptError && !note && <Alert>{acceptError}</Alert>}
      {/* WQ17c: a card booking waiting for its payment: the consultation's panel, on the lab's reads (any device, r14). */}
      {b.status === 'pending_payment' && !note && (
        <section className="ws-section" aria-labelledby="lab-pay-h">
          <h2 id="lab-pay-h">Payment</h2>
          <CardPaymentPanel source={booker.cardSource(api, b._id, null)} order={orderFromBooking(b)} payBy={b.payment?.payBy ?? undefined}
            paymentTransactionId={b.payment?.paymentTransactionId ?? null} perform={guard.perform} busy={guard.busy}
            onPaid={(_b, n) => { setNote(`Paid. The lab test is booked. The patient is told.${n ? ` ${n}` : ''}`); changed(); void q.refetch(); }}
            onEnded={(w) => { setNote(w); changed(); void q.refetch(); }} />
        </section>
      )}
      {r && b.status === 'confirmed' && !note && (
        <AcceptNewTime booker={booker} booking={b} version={r.version} perform={guard.perform} busy={guard.busy}
          onDone={(w) => { setAcceptError(null); setNote(w); changed(); void q.refetch(); }}
          onRefused={(w) => { setAcceptError(w); void q.refetch(); }} />
      )}
      {!note && (canCancelLab(b) ? (
        <CancelLab booker={booker} booking={b} perform={guard.perform} busy={guard.busy} onDone={(w) => { setNote(w); changed(); void q.refetch(); }} />
      ) : b.status === 'confirmed' ? (
        <section className="ws-section" aria-labelledby="lab-cancel-h">
          <h2 id="lab-cancel-h">Cancel</h2>
          <p className="ws-muted">Lab tests can be cancelled up to 1 hour before the time. It is too late to cancel this one here.</p>
        </section>
      ) : null)}

      <Reports booking={b} />
    </>
  );
}

// ── The lab's new time ──

interface PendingAccept { bookingId: string; version: number }

/** `POST …/accept-reschedule {version}`: the new time the lab proposed; or cancel it (below) with the refund to the wallet. */
function AcceptNewTime({ booker, booking, version, perform, busy, onDone, onRefused }: {
  booker: LabBooker; booking: LabBookingView; version: number; perform: Perform; busy: boolean; onDone: (words: string) => void;
  /** WQ17b L2: a refusal is said by the page, which reads the booking again (the proposal may have changed). */
  onRefused: (words: string) => void;
}) {
  const { op, send, settle } = useOwnedOp<PendingAccept>(booker.slot('accept', booking._id));
  const [error, setError] = useState<string | null>(null);
  const r = booking.reschedule!;
  const newTime = `${formatSlotDate(ymd8(booking.slot?.date))} at ${booking.slot?.startTime ?? '—'}`;
  const oldTime = r.previousSlot ? `${formatSlotDate(ymd8(r.previousSlot.date))} at ${r.previousSlot.startTime ?? '—'}` : null;

  async function accept(p: PendingOp<PendingAccept>) {
    setError(null);
    const res = await perform(() => send(p, (b) => booker.routes.acceptReschedule(b.bookingId, b.version)));
    if (res.kind === 'stale') return;
    if (res.kind === 'ok') { onDone(`New time accepted: ${newTime}. The patient is told.`); return; }
    if (res.kind === 'refused') onRefused(booker.refusal(res.error).message);
  }

  if (op && !(busy && op.attempts === 1 && !op.uncertain)) {
    return (
      <section className="ws-section" aria-labelledby="lab-new-h">
        <h2 id="lab-new-h">New time from the lab</h2>
        <CheckPanel label="Unconfirmed acceptance"
          onCheck={async () => {
            const now = await booker.routes.booking(booking._id);
            // WQ17b L1: accepted only when the booking is still confirmed and the very proposal sent is no longer waiting.
            if (op.body && now.status === 'confirmed' && now.reschedule && !now.reschedule.pending && now.reschedule.version === op.body.version) {
              settle(op.requestKey); onDone('The new time is accepted.'); return null;
            }
            return op.body ? 'Not accepted so far. It may still be on its way. Sending it again is safe.'
              : 'Its details are not kept on this device after a reload. Look at the booking: if no new time is waiting, it was answered.';
          }}
          resend={op.restored || !op.body ? undefined : { label: 'Send the same request again', busy, onClick: () => void accept(op).catch((e: unknown) => setError(booker.refusal(e).message)) }}
          forget={{ label: 'Forget it', confirmLabel: 'Yes, forget it', onForget: () => settle(op.requestKey), consequence: 'If the earlier acceptance still arrives, the new time is accepted.' }}>
          <Alert tone="warn">The outcome of accepting the new time is not known yet{op.error ? ` (${op.error})` : ''}.</Alert>
        </CheckPanel>
      </section>
    );
  }
  return (
    <section className="ws-section" aria-labelledby="lab-new-h">
      <h2 id="lab-new-h">New time from the lab</h2>
      <Alert tone="warn">
        The lab proposed a new time: <strong>{newTime}</strong>{oldTime ? ` (it was ${oldTime})` : ''}.{r.reason ? ` Reason: ${r.reason}.` : ''}
        {' '}Ask the patient, then accept it, or cancel the booking (the money comes back to your wallet).
      </Alert>
      {error && <Alert>{error}</Alert>}
      <div className="ws-actions">
        <Button busy={busy} onClick={() => void accept(startOp(newRequestKey(), { bookingId: booking._id, version })).catch((e: unknown) => setError(booker.refusal(e).message))}>
          Accept new time
        </Button>
      </div>
    </section>
  );
}

// ── Cancel ──

interface PendingCancel { bookingId: string; reason?: string; expectedVersion?: number; refundTo?: RefundTo }

/**
 * `POST …/cancel {reason?, expectedVersion, refundTo?}` (the shared cancel, `ownedCancel.tsx`): a wallet booking's money goes
 * back to the wallet; a card-paid one's to the card or the wallet (r14); one still waiting for payment refunds nothing.
 */
function CancelLab({ booker, booking, perform, busy, onDone }: {
  booker: LabBooker; booking: LabBookingView; perform: Perform; busy: boolean; onDone: (words: string) => void;
}) {
  const labs = booker.routes;
  const waiting = booking.status === 'pending_payment';
  const paidBy = bookingPaidBy(booking);
  return (
    <CardAwareCancel<PendingCancel, LabBookingView> slot={booker.slot('cancel', booking._id)} label="Cancel this lab test"
      what="lab test" when={`${formatSlotDate(ymd8(booking.slot?.date))} at ${booking.slot?.startTime ?? '—'}`}
      introLead={waiting ? 'You can cancel it at any time.' : booking.reschedule?.pending ? 'While the new time is not answered you can cancel at any time.' : 'You can cancel up to 1 hour before the time.'}
      amount="The amount" told="The patient is told." paidBy={paidBy} waiting={waiting} captured={!booking.payment || booking.payment.state === 'captured'}
      version={booking.statusVersion} perform={perform} busy={busy}
      makeBody={(reason, refundTo) => ({ bookingId: booking._id, ...(reason ? { reason } : {}), ...(typeof booking.statusVersion === 'number' ? { expectedVersion: booking.statusVersion } : {}),
        ...(refundTo ? { refundTo } : {}) })}
      send={(b) => labs.cancel(b.bookingId, { ...(b.reason ? { reason: b.reason } : {}), ...(b.expectedVersion !== undefined ? { expectedVersion: b.expectedVersion } : {}),
        ...(b.refundTo ? { refundTo: b.refundTo } : {}) })}
      refusalWords={(err) => booker.refusal(err).message}
      isCancelled={async () => { const now = await labs.booking(booking._id); return now.status === 'cancelled' ? now : null; }}
      // WQ17b L3: the money words follow the server's `payment.state` (WQ17c: and how it was paid).
      checkedWords={(body, restored, now) => {
        // WQ27: a doctor's view carries `payment` too (r29 G1), so its found cancel says refund or forfeit the same way.
        const state = now.payment?.state;
        if (state === 'not_paid') return `Cancelled. It was not paid, so nothing is refunded. ${LATE_PAYMENT_BACK}`;
        if (state === 'forfeited') return 'Cancelled. Nothing was refunded.';
        if (state !== 'refunded') return 'Cancelled.';
        if (now.payment?.method !== 'razorpay') return 'Cancelled. The amount is back in your Jansetu wallet.';
        return restored ? 'Cancelled. The amount goes back the way chosen.'
          : body?.refundTo === 'wallet' ? 'Cancelled. The amount goes back to your Jansetu wallet. See it under Wallet.'
          : 'Cancelled. The amount goes back to the card or UPI it was paid with.';
      }}
      onDone={onDone} />
  );
}

// ── Released reports ──

function Reports({ booking }: { booking: LabBookingView }) {
  const releases = booking.report?.releases ?? [];
  const { open, opening, error, preview } = useDocumentViewer();
  return (
    <section className="ws-section" aria-labelledby="lab-rep-h">
      <h2 id="lab-rep-h">Report</h2>
      {releases.length === 0 ? (
        <p className="ws-muted">The report shows here once the lab releases it, for 90 days from then.</p>
      ) : (
        <ul className="ws-list">
          {releases.map((r, i) => (
            <li key={`${r.file}:${i}`} className="ws-actions">
              <span>Released {r.releasedAt ? formatDateTime(r.releasedAt) : ''}{r.signer?.name ? `, signed by ${r.signer.name}` : ''}</span>
              <Button variant="secondary" busy={opening === r.file} onClick={() => void open(r.file)}>
                <FileText size={16} aria-hidden="true" /> Open the report{releases.length > 1 ? ` ${i + 1}` : ''}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error && <Alert>Could not open the report: {error}</Alert>}
      <DocumentPreview preview={preview} title="Lab report" noun="report" fileName="lab-report" />
    </section>
  );
}
