import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useParams } from 'react-router';
import { ArrowLeft, CheckCircle2, Circle } from 'lucide-react';
import {
  ApiError, customerLabsApi, fromPaise, LAB_CANCEL_CUTOFF_HOURS, LAB_PAYMENT_WINDOW_MIN, labCancelCheck, labTimeline, type CustomerLabBooking as LabBooking,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, formatDateTime, formatRupees, Loading } from '@jansetu/ui';
import { Confirm, messageOf, PageHeading } from '../../common.tsx';
import { PrivateFile } from '../../files.tsx';
import { t } from '../../i18n/index.ts';
import { PayAgainPanel } from '../../payAgain.tsx';
import { useSession } from '../../session.tsx';
import { clock, labStatusOf, labTitle, visitModeLabel } from './labels.ts';

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
      <Link to="/bookings" className="back"><ArrowLeft size={16} aria-hidden="true" /> {t('common.myBookings')}</Link>
      {!valid ? <Empty title={t('common.bookingNotFound')} />
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
  // Q9: the booking carries its lab's and branch's names.
  const lab = b.lab?.name ? { name: b.lab.name } : undefined;
  const branch = b.branch;
  const s = labStatusOf(b);
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['lab-bookings'] });
    await queryClient.invalidateQueries({ queryKey: ['wallet'] });
  };
  const paid = b.paymentStatus === 'paid';
  const cancel = labCancelCheck(b);
  return (
    <>
      <PageHeading title={labTitle(b)}>{slotText(b.slot)} · {visitModeLabel(b.visitMode)}</PageHeading>
      <section className="card stack">
        <dl className="details">
          <dt>{t('common.status')}</dt><dd><Badge tone={s.tone}>{s.label}</Badge></dd>
          <dt>{t('common.for')}</dt><dd>{b.patient.name}</dd>
          {lab && <><dt>{t('common.lab')}</dt><dd>{lab.name}{branch?.name ? `, ${branch.name}` : ''}</dd></>}
          {branch?.phone && <><dt>{t('labBooking.labPhone')}</dt><dd><a href={`tel:${branch.phone}`}>{branch.phone}</a></dd></>}
          {b.visitMode === 'home' && b.address
            ? <><dt>{t('labBooking.address')}</dt><dd>{[b.address.line1, b.address.line2, b.address.landmark, b.address.city, b.address.pincode].filter(Boolean).join(', ')}</dd></>
            : branch?.address ? <><dt>{t('labBooking.where')}</dt><dd>{[branch.address.line1, branch.address.city, branch.address.pincode].filter(Boolean).join(', ')}</dd></> : null}
          {b.collector?.name && <><dt>{t('labBooking.collector')}</dt><dd>{b.collector.name}{b.collector.phone ? ` · ${b.collector.phone}` : ''}</dd></>}
          <dt>{t('common.total')}</dt>
          <dd>
            {formatRupees(fromPaise(b.pricing.payableMinor))} · {paid ? t('common.paid') : b.paymentStatus === 'refunded' ? t('common.refundedToWallet') : t('common.notPaid')}
            {b.pricing.discountMinor > 0 && <span className="muted"> {t('common.couponDiscount', { code: b.pricing.couponCode ?? '', amount: formatRupees(fromPaise(b.pricing.discountMinor)) })}</span>}
          </dd>
        </dl>
        <ul className="plain">
          {b.items.map((i) => <li key={i.catalogItemId}>{i.name}{i.kind === 'package' ? ` (${t('lab.packageTag')})` : ''} · {formatRupees(fromPaise(i.priceMinor))}</li>)}
        </ul>
      </section>

      {b.status === 'cancelled' && <CancelledNote booking={b} />}
      {b.status === 'no_show' && (
        <Alert tone="warn">{b.noShows?.length ? t('labBooking.noShow.moved') : t('labBooking.noShow.mayOffer')}</Alert>
      )}
      {!!b.noShows?.length && b.status !== 'no_show' && (
        <Alert tone="warn">{t('labBooking.moved', { from: slotText(b.noShows[0]!.fromSlot), time: slotText(b.slot) })}</Alert>
      )}
      {paymentError && b.paymentStatus === 'pending' && <Alert>{t('common.paymentPageFailed', { message: paymentError })}</Alert>}
      {b.status === 'pending_payment' && b.paymentStatus === 'pending' && (
        <PayAgainPanel key={`${b._id}:${b.paymentTransactionId ?? ''}`} kind="booking" amountDue={fromPaise(b.pricing.payableMinor)} deadline={b.paymentDeadline} paymentTransactionId={b.paymentTransactionId}
          // i18n-ignore: a server error code, not words
          expiredCode="LAB_BOOKING_PAYMENT_EXPIRED" description={lab ? t('lab.payDescription', { lab: lab.name }) : t('common.labTests')}
          pay={() => customerLabsApi(api).payAgain(b._id)} onSettled={refresh} />
      )}
      {b.status === 'confirmed' && b.reschedule?.pending && <ReschedulePanel booking={b} onChanged={refresh} />}
      <Timeline booking={b} />
      {b.report.files.length > 0 && (
        <section className="card stack" aria-labelledby="reports-h">
          <h2 id="reports-h">{t('labBooking.reports')}</h2>
          {b.report.files.map((f, i) => {
            // Q9: each release names its file, so the signer shown is exactly this report's.
            const r = b.report.releases.find((x) => x.file === f);
            const label = b.report.files.length === 1 ? t('files.report') : t('files.reportNumber', { number: i + 1 });
            return (
              <div key={f} className="stack">
                {r && <p className="muted">{r.signer.registrationNumber
                  ? t('labBooking.releasedReg', { date: formatDateTime(r.releasedAt), name: r.signer.name, number: r.signer.registrationNumber })
                  : t('labBooking.released', { date: formatDateTime(r.releasedAt), name: r.signer.name })}</p>}
                <PrivateFile id={f} label={label} baseName={`lab-report-${i + 1}`} load={(signal) => customerLabsApi(api).reportFile(f, signal)} />
              </div>
            );
          })}
        </section>
      )}
      {(b.status === 'pending_payment' || b.status === 'confirmed') && (
        <section className="card stack" aria-labelledby="cancel-h">
          <h2 id="cancel-h">{t('common.cancel')}</h2>
          {cancel.ok ? (
            <>
              {cancel.deadline && <p className="muted">{t('labBooking.cancelUntil', { deadline: formatDateTime(cancel.deadline.toISOString()), hours: LAB_CANCEL_CUTOFF_HOURS })}</p>}
              {b.reschedule?.pending && paid && <p className="muted">{t('labBooking.cancelDuringReschedule')}</p>}
              <Confirm label={t('common.cancelBooking')} confirmLabel={t('common.yesCancel')} withReason
                consequence={cancel.refund ? t('labBooking.cancelRefund') : t('labBooking.cancelRelease')}
                onConfirm={async (reason) => { try { await customerLabsApi(api).cancel(b._id, reason || undefined); } finally { await refresh(); } }} />
            </>
          ) : cancel.reason === 'no_show_moved' ? (
            <Alert tone="warn">{t('labBooking.movedNoCancel')}</Alert>
          ) : (
            <Alert tone="warn">{t('labBooking.windowClosed', { hours: LAB_CANCEL_CUTOFF_HOURS })}</Alert>
          )}
        </section>
      )}
    </>
  );
}

function CancelledNote({ booking: b }: { booking: LabBooking }) {
  const c = b.cancellation;
  if (c?.reason === 'timeout') {
    // WQ11a: the server's own words for an expired booking (its notification): a payment the gateway captured after the
    // window, too, is returned to the wallet, never applied to the released time.
    return (
      <Alert tone="warn">{t('labBooking.expired', { minutes: LAB_PAYMENT_WINDOW_MIN })}</Alert>
    );
  }
  if (c?.reason === 'lab_reject') {
    return <Alert tone="warn">{c.note ? t('labBooking.rejectedWhy', { note: c.note }) : t('labBooking.rejected')}</Alert>;
  }
  return <Alert tone="warn">{c?.at ? t('labBooking.cancelledOn', { date: formatDateTime(c.at) }) : t('labBooking.cancelled')}</Alert>;
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
        ? t('labBooking.resched.changed') : messageOf(err));
    } finally {
      setBusy(false);
      await onChanged();
    }
  }
  return (
    <section className="card stack" aria-labelledby="resched-h">
      <h2 id="resched-h">{t('labBooking.resched.title')}</h2>
      <dl className="details">
        <dt>{t('labBooking.resched.newTime')}</dt><dd><strong>{slotText(b.slot)}</strong></dd>
        {r.previousSlot && <><dt>{t('labBooking.resched.was')}</dt><dd>{slotText(r.previousSlot)}</dd></>}
        {r.reason && <><dt>{t('labBooking.resched.reason')}</dt><dd>{r.reason}</dd></>}
      </dl>
      <p className="muted">{t('labBooking.resched.body')}</p>
      {error && <Alert>{error}</Alert>}
      <div className="row"><Button busy={busy} onClick={() => void accept()}>{t('labBooking.resched.accept')}</Button></div>
    </section>
  );
}

function Timeline({ booking: b }: { booking: LabBooking }) {
  const steps = labTimeline(b);
  return (
    <section className="card stack" aria-labelledby="progress-h">
      <h2 id="progress-h">{t('labBooking.progress')}</h2>
      <ol className="timeline">
        {steps.map((s) => (
          <li key={s.key} data-done={s.done}>
            {s.done ? <CheckCircle2 size={16} aria-hidden="true" /> : <Circle size={16} aria-hidden="true" />}
            <span>{s.label}{s.at ? <span className="muted"> · {formatDateTime(s.at)}</span> : null}<span className="j-sr-only">{s.done ? ` (${t('labBooking.stepDone')})` : ` (${t('labBooking.stepToCome')})`}</span></span>
          </li>
        ))}
      </ol>
    </section>
  );
}
