import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ArrowLeft, FileText } from 'lucide-react';
import {
  ApiError, bookingPaidBy, canCancelLab, formatSlotDate, isSwitchedOff, LAB_SWITCHED_OFF_MESSAGE, LAB_VISIT_MODE_LABEL, LATE_PAYMENT_BACK, labStatusLabel,
  orderFromBooking, type LabBookingListStatus, type LabBookingView, type RefundTo,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, formatDateTime, Loading, shared , Parts } from '@jansetu/ui';
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
import { t } from '../../i18n/pharmacy/index.ts';

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
      <PageHeading title={t('common.bookedLabTests')}>{t('bookedLabTests.labTestsYourPharmacyBooked')}{' '}<Link to="/pharmacy/lab-book">{t('common.bookANewOne')}</Link>.
      </PageHeading>
      <LabList key={pharmacyId} booker={pharmacyLabBooker(api, pharmacyId)} />
    </>
  );
}

const STATUS_FILTERS = (): { value: LabBookingListStatus | ''; label: string }[] => ([
  { value: '', label: t('common.all') }, { value: 'pending_payment', label: t('common.waitingForPayment2') }, { value: 'confirmed', label: t('bookedLabTests.confirmed') }, { value: 'sample_collected', label: t('bookedLabTests.sampleCollected') },
  { value: 'visited', label: t('bookedLabTests.visited') }, { value: 'processing', label: t('bookedLabTests.processing') }, { value: 'report_ready', label: t('bookedLabTests.reportReleased') }, { value: 'completed', label: t('bookedLabTests.completed') },
  { value: 'cancelled', label: t('common.cancelled') }, { value: 'no_show', label: t('bookedLabTests.noShow') },
]);
const PAGE_SIZE = 20;
const ymd8 = (d: string | undefined) => (d ?? '').replace(/-/g, '');
const when = (b: Pick<LabBookingView, 'slot'>) => `${formatSlotDate(ymd8(b.slot?.date))}${b.slot?.startTime ? `, ${b.slot.startTime}` : ''}`;

function LabBadges({ b }: { b: LabBookingView }) {
  return (
    <>
      {b.reschedule?.pending && <> <Badge tone="warn">{t('bookedLabTests.newTimeProposed')}</Badge></>}
      {b.status === 'cancelled' && b.cancellation?.byKind === 'customer' && <> <Badge tone="warn">{t('common.cancelledByPatient')}</Badge></>}
      {b.assisted?.disputed?.state === 'open' && <> <Badge tone="danger">{t('common.patientSaysThisIsNot')}</Badge></>}
      {(b.report?.releases?.length ?? 0) > 0 && <> <Badge tone="ok">{t('bookedLabTests.report')}</Badge></>}
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
      <h2 id="lab-list-h" className="j-sr-only">{t('common.bookedLabTests')}</h2>
      <StatusFilter id="lab-status" value={status} options={STATUS_FILTERS()} onChange={(v) => { setStatus(v); pages.reset(); }} />
      {q.isPending ? <Loading label={t('bookedLabTests.loadingBookedLabTests')} />
        : q.isError ? (isSwitchedOff(q.error) ? <Alert tone="warn">{LAB_SWITCHED_OFF_MESSAGE}</Alert>
          : <ErrorState message={booker.refusal(q.error).message} onRetry={() => void q.refetch()} />)
        : q.data.items.length === 0 ? (
          <Empty title={status ? t('bookedLabTests.noLabTestsWithThis') : t('bookedLabTests.noLabTestsBookedYet')}>
            <Link to={booker.paths.book}>{t('bookedLabTests.bookALabTest')}</Link>{booker.words.emptyFor}
          </Empty>
        ) : (
          <>
            <div className="ws-table-wrap">
              <table className="j-table">
                <caption className="j-sr-only">{t('bookedLabTests.bookedLabTestsNewestFirst')}</caption>
                <thead>
                  <tr><th scope={'col'}>{t('common.when')}</th><th scope={'col'}>{t('common.patient2')}</th><th scope={'col'}>{t('bookedLabTests.lab')}</th><th scope={'col'}>{t('common.tests')}</th><th scope={'col'}>{t('common.status')}</th><th scope={'col'}><span className="j-sr-only">{t('common.open')}</span></th></tr>
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
                          ? <Link to={`${booker.paths.list}/${b._id}`} aria-label={t('bookedLabTests.payNowForTheLab', { value: b.patientName ?? 'the patient', value2: b.lab?.name ?? 'the lab' })}>{t('common.payNow')}</Link>
                          : <Link to={`${booker.paths.list}/${b._id}`} aria-label={t('bookedLabTests.openTheLabTestOf', { value: b.patientName ?? 'the patient', value2: b.lab?.name ?? 'the lab' })}>{t('common.open')}</Link>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <CursorPager pages={pages} nextCursor={q.data.nextCursor} label={t('bookedLabTests.bookedLabTestPages')} />
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
      <Link to="/pharmacy/lab-tests" className="ws-back"><ArrowLeft size={16} aria-hidden="true" />{` ${t('bookedLabTests.bookedLabTests2')}`}</Link>
      <PageHeading title={t('bookedLabTests.labTest')} />
      <LabDetail key={`${pharmacyId}:${bookingId}`} booker={pharmacyLabBooker(api, pharmacyId)} bookingId={bookingId} />
    </>
  );
}

const CANCELLED_BY = (): Readonly<Record<string, string>> => ({
  customer: t('common.byThePatient'), partner: t('bookedLabTests.byTheLab'), admin: t('common.byJansetu'),
});

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
    return <Empty title={t('bookedLabTests.labTestNotFound')}><Link to={booker.paths.list}>{t('bookedLabTests.seeAllBookedLabTests')}</Link></Empty>;
  }
  if (q.isError && booker.closed?.(q.error)) return <Alert tone="warn">{booker.closedMessage}</Alert>;
  if (q.isPending) return <Loading label={t('bookedLabTests.loadingTheLabTest')} />;
  if (q.isError) return <ErrorState message={booker.refusal(q.error).message} onRetry={() => void q.refetch()} />;
  const b = q.data;
  const r = b.reschedule?.pending ? b.reschedule : null;

  return (
    <>
      <section className="ws-section" aria-labelledby="lab-bk-h">
        <h2 id="lab-bk-h">{t('common.booking')}</h2>
        <dl className="ws-dl">
          {b.assisted?.shortRef && <><dt>{t('common.reference')}</dt><dd>{b.assisted.shortRef}</dd></>}
          <dt>{t('common.status')}</dt><dd>{labStatusLabel(b.status)}<LabBadges b={b} /></dd>
          <dt>{t('common.patient2')}</dt><dd>{b.patientName ?? '—'}</dd>
          <dt>{t('bookedLabTests.lab')}</dt><dd>{b.lab?.name ?? '—'}{b.branch?.name ? `, ${b.branch.name}` : ''}{b.branch?.phone ? ` (${b.branch.phone})` : ''}</dd>
          <dt>{t('bookedLabTests.visit')}</dt><dd>{b.visitMode === 'home' || b.visitMode === 'lab' ? LAB_VISIT_MODE_LABEL[b.visitMode] : '—'}</dd>
          {b.visitMode === 'home' && b.address && <><dt>{t('common.address')}</dt><dd>{[b.address.line1, b.address.line2, b.address.city, b.address.pincode].filter(Boolean).join(', ')}</dd></>}
          {b.visitMode === 'lab' && b.branch?.address && <><dt>{t('bookedLabTests.labAddress')}</dt><dd>{b.branch.address}</dd></>}
          <dt>{t('common.when')}</dt><dd>{formatSlotDate(ymd8(b.slot?.date))}{b.slot?.startTime ? ` at ${b.slot.startTime}` : ''}{b.slot?.endTime ? `–${b.slot.endTime}` : ''}</dd>
          <dt>{t('common.tests')}</dt><dd>{(b.items ?? []).map((i) => i.name).join(', ') || '—'}</dd>
          {b.collector?.name && <><dt>{t('bookedLabTests.sampleCollector')}</dt><dd>{b.collector.name}</dd></>}
          {b.status === 'cancelled' && b.cancellation && <><dt>{t('common.cancelled')}</dt><dd>{(b.cancellation.byKind === 'booker' ? booker.words.byBooker : CANCELLED_BY()[b.cancellation.byKind ?? '']) ?? '—'}{b.cancellation.at ? ` on ${formatDateTime(b.cancellation.at)}` : ''}</dd></>}
        </dl>
        {b.assisted?.disputed?.state === 'open' && <Alert tone="warn">{t('common.theAccountHolderToldJansetu')}</Alert>}
      </section>

      {note && <Alert tone="ok">{note}</Alert>}
      {acceptError && !note && <Alert>{acceptError}</Alert>}
      {/* WQ17c: a card booking waiting for its payment: the consultation's panel, on the lab's reads (any device, r14). */}
      {b.status === 'pending_payment' && !note && (
        <section className="ws-section" aria-labelledby="lab-pay-h">
          <h2 id="lab-pay-h">{t('common.payment')}</h2>
          <CardPaymentPanel source={booker.cardSource(api, b._id, null)} order={orderFromBooking(b)} payBy={b.payment?.payBy ?? undefined}
            paymentTransactionId={b.payment?.paymentTransactionId ?? null} perform={guard.perform} busy={guard.busy}
            onPaid={(_b, n) => { setNote(t('bookedLabTests.paidTheLabTestIs', { value: n ? ` ${n}` : '' })); changed(); void q.refetch(); }}
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
          <h2 id="lab-cancel-h">{t('common.cancel')}</h2>
          <p className="ws-muted">{t('bookedLabTests.labTestsCanBeCancelled')}</p>
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
    if (res.kind === 'ok') { onDone(t('bookedLabTests.newTimeAcceptedThePatient', { newTime })); return; }
    if (res.kind === 'refused') onRefused(booker.refusal(res.error).message);
  }

  if (op && !(busy && op.attempts === 1 && !op.uncertain)) {
    return (
      <section className="ws-section" aria-labelledby="lab-new-h">
        <h2 id="lab-new-h">{t('bookedLabTests.newTimeFromTheLab')}</h2>
        <CheckPanel label={t('bookedLabTests.unconfirmedAcceptance')}
          onCheck={async () => {
            const now = await booker.routes.booking(booking._id);
            // WQ17b L1: accepted only when the booking is still confirmed and the very proposal sent is no longer waiting.
            if (op.body && now.status === 'confirmed' && now.reschedule && !now.reschedule.pending && now.reschedule.version === op.body.version) {
              settle(op.requestKey); onDone(t('bookedLabTests.theNewTimeIsAccepted')); return null;
            }
            return op.body ? t('bookedLabTests.notAcceptedSoFarIt')
              : t('bookedLabTests.itsDetailsAreNotKept');
          }}
          resend={op.restored || !op.body ? undefined : { label: shared('action.sendAgain'), busy, onClick: () => void accept(op).catch((e: unknown) => setError(booker.refusal(e).message)) }}
          forget={{ label: t('common.forgetIt'), confirmLabel: t('common.yesForgetIt'), onForget: () => settle(op.requestKey), consequence: t('bookedLabTests.ifTheEarlierAcceptanceStill') }}>
          <Alert tone="warn">{t('bookedLabTests.theOutcomeOfAcceptingThe')}{op.error ? ` (${op.error})` : ''}.</Alert>
        </CheckPanel>
      </section>
    );
  }
  return (
    <section className="ws-section" aria-labelledby="lab-new-h">
      <h2 id="lab-new-h">{t('bookedLabTests.newTimeFromTheLab')}</h2>
      <Alert tone="warn"><Parts of={t.rich('bookedLabTests.theLabProposedANewFull', { newTime: <strong>{newTime}</strong>, value: oldTime ? ` (it was ${oldTime})` : '', reason: r.reason ? ` ${t('bookedLabTests.reason', { reason: r.reason })}` : '' })} /></Alert>
      {error && <Alert>{error}</Alert>}
      <div className="ws-actions">
        <Button busy={busy} onClick={() => void accept(startOp(newRequestKey(), { bookingId: booking._id, version })).catch((e: unknown) => setError(booker.refusal(e).message))}>{t('bookedLabTests.acceptNewTime')}</Button>
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
    <CardAwareCancel<PendingCancel, LabBookingView> slot={booker.slot('cancel', booking._id)} label={t('bookedLabTests.cancelThisLabTest')}
      what={t('bookedLabTests.labTest2')} when={`${formatSlotDate(ymd8(booking.slot?.date))} at ${booking.slot?.startTime ?? '—'}`}
      introLead={waiting ? t('bookedLabTests.youCanCancelItAt') : booking.reschedule?.pending ? t('bookedLabTests.whileTheNewTimeIs') : t('bookedLabTests.youCanCancelUpTo')}
      amount={t('common.theAmount')} told={t('bookedLabTests.thePatientIsTold')} paidBy={paidBy} waiting={waiting} captured={!booking.payment || booking.payment.state === 'captured'}
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
        if (state === 'not_paid') return t('common.cancelledItWasNotPaid', { LATE_PAYMENT_BACK });
        if (state === 'forfeited') return t('bookedLabTests.cancelledNothingWasRefunded');
        if (state !== 'refunded') return t('bookedLabTests.cancelled');
        if (now.payment?.method !== 'razorpay') return t('common.cancelledTheAmountIsBack');
        return restored ? t('common.cancelledTheAmountGoesBack')
          : body?.refundTo === 'wallet' ? t('common.cancelledTheAmountGoesBack2')
          : t('common.cancelledTheAmountGoesBack3');
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
      <h2 id="lab-rep-h">{t('bookedLabTests.report')}</h2>
      {releases.length === 0 ? (
        <p className="ws-muted">{t('bookedLabTests.theReportShowsHereOnce')}</p>
      ) : (
        <ul className="ws-list">
          {releases.map((r, i) => (
            <li key={`${r.file}:${i}`} className="ws-actions">
              <span>{t('bookedLabTests.releasedFull', { time: r.releasedAt ? formatDateTime(r.releasedAt) : '', value: r.signer?.name ? `, signed by ${r.signer.name}` : '' })}</span>
              <Button variant="secondary" busy={opening === r.file} onClick={() => void open(r.file)}>
                <FileText size={16} aria-hidden="true" />{' '}{t('bookedLabTests.openTheReportFull', { value: releases.length > 1 ? ` ${i + 1}` : '' })}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error && <Alert>{t('bookedLabTests.couldNotOpenTheReportFull', { error })}</Alert>}
      <DocumentPreview preview={preview} title={t('bookedLabTests.labReport')} noun={t('bookedLabTests.report2')} fileName={t('bookedLabTests.labReport2')} />
    </section>
  );
}
