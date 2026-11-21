import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import {
  addDays, ApiError, canReadDrafts, COLLECTOR_PHONE_PATTERN, eligibleSigners, hasGlobalScope, holdsAny, isBookable, isLabBookingChanged, isReportTooLarge,
  istDateOf, isUploadFailed, LAB_BOOKING_STATUS_LABEL, LAB_PAYMENT_STATUS_LABEL, LAB_VISIT_MODE_LABEL, labActions, labNoShowMove, MAX_COLLECTOR_NAME,
  MAX_LAB_REASON, MIN_LAB_REASON, noShowMovedOnce, OBJECT_ID_PATTERN, releaseOf, REPORT_ACCEPT, REPORT_MAX_BYTES, reportFileName, reportFileProblem,
  labBookingsAdminApi, type LabAction, type LabActionOffer, type LabBooking, type LabLifecycleKey, type LabSlot, type PartnerMember,
} from '@jansetu/api';
import { Alert, Badge, Button, ErrorState, formatDateTime, Loading, TextArea, TextField } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { FOCUS_HOST_STYLE, usePanelFocus } from '../../components/focus.ts';
import { NoShowMove, noShowMoveSlot, type NoShowTarget } from '../../components/NoShowMove.tsx';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { definitelyNotRecorded, newRequestKey } from '../../requests.ts';
import { useSession, useStaff } from '../../session.tsx';
import { money } from './billing.tsx';
import {
  formatDay, LabOnly, labStatusTone, ReportPreview, slotLabel, useNow, useReportViewer, ViewFileButton,
} from './labs.tsx';
import { NoSuchPartner, scopeIdentity, useBranches, usePartnerScope, useWorkspacePartner, type ScopeContext } from './scope.tsx';

const LIFECYCLE: readonly [LabLifecycleKey, string][] = [
  ['paidAt', 'Paid'], ['confirmedAt', 'Confirmed'], ['collectedAt', 'Sample collected'], ['visitedAt', 'Visited the lab'],
  ['processingAt', 'Processing started'], ['reportReadyAt', 'First report released'], ['completedAt', 'Completed'],
  ['cancelledAt', 'Cancelled'], ['noShowAt', 'Marked as no-show'],
];
const CANCEL_REASON: Record<string, string> = {
  timeout: 'Not paid in time', customer: 'Cancelled by the customer', lab_reject: 'Rejected by the lab',
  // Q16a: an admin cancels a booking moved after a no-show, with or without a refund (`cancellation.refund`).
  admin_no_show: 'Cancelled by the Jansetu team after a no-show move',
};

/**
 * WQ11b: every step names the booking's `statusVersion` it was reviewed on (Q11 `expectedVersion`). When the booking
 * moved meanwhile the server does nothing (409 LAB_BOOKING_CHANGED); the page reads the booking again (every step
 * re-reads it when it ends) and says so.
 */
export const LAB_BOOKING_CHANGED_MESSAGE = 'The booking changed since you looked at it (someone else acted on it), so nothing was done. It has been read again: check it and try again.';
const stepMessage = (err: unknown) => (isLabBookingChanged(err) ? LAB_BOOKING_CHANGED_MESSAGE : messageOf(err));
const GENDER_LABEL: Record<string, string> = { male: 'Male', female: 'Female', other: 'Other' };

/** One online lab booking: what was booked, its timeline, the steps this person may take now, and its reports. */
export function LabBookingScreen() {
  const ctx = usePartnerScope();
  const { bookingId = '' } = useParams();
  if (!ctx || !OBJECT_ID_PATTERN.test(bookingId)) return <NoSuchPartner />;
  // One subtree per partner and booking: an open form, confirmation or file preview never carries over to another.
  return <BookingPage key={`${scopeIdentity(ctx)}:${bookingId}`} ctx={ctx} bookingId={bookingId} />;
}

function BookingPage({ ctx, bookingId }: { ctx: ScopeContext; bookingId: string }) {
  const partner = useWorkspacePartner(ctx);
  return (
    <>
      <Link className="ws-back" to={ctx.link('lab-bookings')}><ArrowLeft size={16} aria-hidden="true" /> Back to lab bookings</Link>
      <LabOnly ctx={ctx}><BookingDetail ctx={ctx} bookingId={bookingId} partnerName={partner.data?.name} /></LabOnly>
    </>
  );
}

function BookingDetail({ ctx, bookingId, partnerName }: { ctx: ScopeContext; bookingId: string; partnerName?: string }) {
  const queryClient = useQueryClient();
  const key = [...ctx.key, 'lab-booking', bookingId];
  const q = useQuery({ queryKey: key, queryFn: () => ctx.labs.booking(bookingId) });
  const branches = useBranches(ctx);
  const now = useNow();
  const { memory, api } = useSession();
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState<Step | null>(null);
  const inFlight = useRef(false);
  const b = q.data;
  const moveSlot = noShowMoveSlot(scopeIdentity(ctx), bookingId);

  /** A newer answer replaces the page's booking; an older one (lower status version) never does. */
  async function apply(next: LabBooking) {
    await queryClient.cancelQueries({ queryKey: key });
    queryClient.setQueryData<LabBooking>(key, (old) => (!old || next.statusVersion >= old.statusVersion ? next : old));
    void queryClient.invalidateQueries({ queryKey: [...ctx.key, 'lab-bookings'] });
  }
  /**
   * Runs one step for THIS booking (the subtree is keyed by partner and booking, so a late answer after leaving writes
   * only this booking's own record and shows nothing anywhere else). One step at a time.
   */
  async function perform(action: LabAction, run: () => Promise<LabBooking>, done: string) {
    await guarded(action, async () => { await apply(await run()); setNotice(done); });
  }
  /**
   * The single gate for every step, including confirmations that were already open when another step started: two
   * steps never run together (an upload keeps the status version, so out-of-order snapshots could not be told apart).
   */
  async function guarded<T>(action: Step, run: () => Promise<T>): Promise<T> {
    if (inFlight.current) {
      throw new ApiError(409, 'Another step on this booking is still running. Wait for it to finish, then try again.', 'STEP_IN_FLIGHT');
    }
    inFlight.current = true;
    setBusy(action);
    setNotice(null);
    setFailure(null);
    try {
      return await run();
    } finally {
      inFlight.current = false;
      setBusy(null);
      // Success or not (the booking may have moved meanwhile: LAB_BOOKING_CHANGED, a state conflict), re-read this
      // exact booking so the page settles on the server's current record.
      void queryClient.invalidateQueries({ queryKey: key, exact: true });
    }
  }
  const click = (action: LabAction, what: string, run: () => Promise<LabBooking>, done: string) =>
    perform(action, run, done).catch((err: unknown) => setFailure(`${what}: ${stepMessage(err)}`));
  /** For confirmations: the refusal in words (LAB_BOOKING_CHANGED explained), shown inside the confirmation. */
  const confirmed = (action: LabAction, run: () => Promise<LabBooking>, done: string) =>
    perform(action, run, done).catch((err: unknown) => { throw new ApiError(err instanceof ApiError ? err.status : 0, stepMessage(err), err instanceof ApiError ? err.code : undefined); });

  if (q.isPending) return <><PageHeading title="Lab booking" /><Loading label="Loading the booking…" /></>;
  if (q.isError || !b) return <><PageHeading title="Lab booking" /><ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} /></>;

  const branchName = branches.data?.find((x) => x._id === b.branchId)?.name ?? `Branch …${b.branchId.slice(-6)}`;
  const offers = labActions(b, ctx.actor, now);
  // Q14: the one move of a no-show (also shown while a move sent earlier is still unconfirmed, whatever the status now).
  const move = labNoShowMove(b, ctx.actor);
  const showMove = !!move || (holdsAny(ctx.actor, ['bookings.manage']) && !!memory.get(moveSlot));
  const offer = (a: LabAction) => offers.find((o) => o.action === a);
  const disabled = busy !== null;
  const tests = b.items.map((i) => i.name).join(', ');

  return (
    <>
      <PageHeading title={`Lab booking: ${b.patient.name}`}>
        {ctx.adminHome ? <>Managing {partnerName ?? 'this partner'} with owner authority. </> : null}
        {slotLabel(b.slot)} · {LAB_VISIT_MODE_LABEL[b.visitMode]} · {branchName}
      </PageHeading>
      {notice && <Alert tone="ok">{notice}</Alert>}

      <section className="ws-section" aria-labelledby="lb-status-h">
        <h2 id="lb-status-h">Status</h2>
        {failure && <Alert>{failure}</Alert>}
        <div className="ws-actions">
          <Badge tone={labStatusTone(b.status)}>{LAB_BOOKING_STATUS_LABEL[b.status] ?? b.status}</Badge>
          <Badge tone={b.paymentStatus === 'paid' ? 'ok' : b.paymentStatus === 'refunded' ? 'danger' : 'warn'}>{LAB_PAYMENT_STATUS_LABEL[b.paymentStatus] ?? b.paymentStatus}</Badge>
          {b.reschedule?.pending && <Badge tone="warn">New time proposed</Badge>}
        </div>
        {b.status === 'pending_payment' && (
          <p className="ws-muted">The customer has not paid yet (until {formatDateTime(b.paymentDeadline)}). Nothing can be done on it until it is paid; unpaid bookings expire on their own.</p>
        )}
        {b.reschedule?.pending && b.reschedule.previousSlot && (
          <Alert tone="warn">
            You proposed {slotLabel(b.slot)} instead of {slotLabel(b.reschedule.previousSlot)}{b.reschedule.reason ? ` (“${b.reschedule.reason}”)` : ''}.
            The customer has not accepted it yet; they may also cancel with a full refund.
          </Alert>
        )}
        {b.cancellation && (
          <p>{CANCEL_REASON[b.cancellation.reason] ?? b.cancellation.reason}{b.cancellation.note ? `: “${b.cancellation.note}”` : ''} · {formatDateTime(b.cancellation.at)}
            {/* WQ11d: an admin's cancel of a moved no-show says whether the patient was refunded. */}
            {b.cancellation.reason === 'admin_no_show' && (b.cancellation.refund === true
              ? <> · The patient’s payment of {money(b.pricing.payableMinor)} went back to their Jansetu wallet.</>
              : b.cancellation.refund === false ? <> · The patient was not refunded: the payment is kept, as for a no-show, and nobody earns it.</> : null)}
          </p>
        )}
        {b.status === 'no_show' && (
          <p className="ws-muted">
            Not refunded: the customer missed the slot. The lab earns nothing for a no-show; it earns only when a booking is completed.
            {move === 'offer' ? ' The lab may move it once to a new time.' : ''}
          </p>
        )}
        <NoShowHistory booking={b} />
        {showMove && (
          <div className="ws-actions">
            <NoShowMove key={`${b._id}:${b.statusVersion}`} slot={moveSlot} who={b.patient.name} missed={slotLabel(b.slot)} state={move === 'used' ? 'used' : 'offer'}
              status={b.status} readAt={q.dataUpdatedAt} reading={q.isFetching} disabled={busy !== null || q.isFetching} version={b.statusVersion}
              consequence={<>The seat moves now; the customer is told the new time. The lab earns only once the booking is completed.</>}
              picker={(choose) => <LabSlotPicker ctx={ctx} booking={b} now={now} onChoose={choose} />}
              send={(t: NoShowTarget, requestKey) => guarded('reschedule_no_show', () => ctx.labs.rescheduleNoShow(b._id, t.slotId, requestKey, typeof t.version === 'number' ? t.version : undefined))}
              reread={() => void queryClient.invalidateQueries({ queryKey: key, exact: true })}
              onNotice={(t) => { setFailure(null); setNotice(t); }} onFailure={(t) => { setNotice(null); setFailure(t); }}
              onSlotRefused={() => void queryClient.invalidateQueries({ queryKey: [...ctx.key, 'slots', b.branchId, b.visitMode] })} />
          </div>
        )}
        {offers.length > 0 ? (
          <div className="ws-actions">
            {/* A button step is reviewed on the booking as shown: it names that version. */}
            {offer('collect') && (
              <Step offer={offer('collect')!} disabled={disabled} busy={busy === 'collect'} label="Mark sample collected"
                onClick={() => void click('collect', 'Not marked collected', () => ctx.labs.markCollected(b._id, b.statusVersion), 'Marked as sample collected.')} />
            )}
            {offer('visit') && (
              <Step offer={offer('visit')!} disabled={disabled} busy={busy === 'visit'} label="Mark visited"
                onClick={() => void click('visit', 'Not marked visited', () => ctx.labs.markVisited(b._id, b.statusVersion), 'Marked as visited.')} />
            )}
            {offer('process') && (
              <Step offer={offer('process')!} disabled={disabled} busy={busy === 'process'} label="Start processing"
                onClick={() => void click('process', 'Not moved to processing', () => ctx.labs.startProcessing(b._id, b.statusVersion), 'Processing started. Reports can be uploaded now.')} />
            )}
            {offer('no_show') && (offer('no_show')!.blocked
              ? <Step offer={offer('no_show')!} disabled label="Mark no-show" onClick={() => undefined} />
              : (
                <ConfirmAction label="Mark no-show" danger disabled={disabled} confirmLabel="Mark no-show" version={b.statusVersion}
                  consequence={noShowMovedOnce(b)
                    // Q14: a booking already moved once after a no-show is never moved again (409 NO_SHOW_RESCHEDULE_USED).
                    ? <>Mark {b.patient.name} as not present for {slotLabel(b.slot)}? This booking was already moved once after a no-show, so this second no-show is final: it cannot be moved again, the customer is not refunded and the lab earns nothing for it. This cannot be undone.</>
                    : <>Mark {b.patient.name} as not present for {slotLabel(b.slot)}? The customer is not refunded and the lab earns nothing for it. Afterwards the lab may move it once to a new time; otherwise the booking ends here. This cannot be undone.</>}
                  onConfirm={(_r, v) => confirmed('no_show', () => ctx.labs.markNoShow(b._id, v as number), 'Marked as no-show.')} />
              ))}
            {offer('complete') && (
              <ConfirmAction label="Complete booking" disabled={disabled} confirmLabel="Complete booking" version={b.statusVersion}
                consequence={<>Complete this booking? It ends here: no more reports can be uploaded or released, and the lab’s earning of {money(Math.max(0, b.pricing.subtotalMinor - b.pricing.discountMinor))} is recorded.</>}
                onConfirm={(_r, v) => confirmed('complete', () => ctx.labs.complete(b._id, v as number), 'Booking completed.')} />
            )}
            {offer('assign') && <AssignCollector ctx={ctx} booking={b} disabled={disabled} perform={perform} />}
            {offer('reschedule') && <ProposeTime ctx={ctx} booking={b} disabled={disabled} now={now} perform={perform} />}
            {offer('reject') && (
              <ConfirmAction label="Reject booking" danger disabled={disabled} reason reasonLabel="Why can the lab not take this booking? (the customer sees this)"
                maxReason={MAX_LAB_REASON} confirmLabel="Reject and refund" version={b.statusVersion}
                consequence={<>Reject this booking? It is cancelled, its seat is freed, and the customer’s full payment of {money(b.pricing.payableMinor)} goes back to their Jansetu wallet. This cannot be undone.</>}
                onConfirm={(reason, v) => confirmed('reject', async () => (await ctx.labs.reject(b._id, reason, v as number)).booking, 'Booking rejected; the customer’s payment is back in their wallet.')} />
            )}
          </div>
        ) : !showMove && b.status !== 'pending_payment' && !['completed', 'cancelled', 'no_show'].includes(b.status) && (
          <p className="ws-muted">You can view this booking; the next step needs another permission.</p>
        )}
        {ctx.scope.kind === 'admin' && b.status === 'confirmed' && noShowMovedOnce(b) && (
          <AdminCancelNoShow booking={b} disabled={disabled}
            run={(reason, refund) => guarded('reject', async () => {
              try {
                const r = await labBookingsAdminApi(api).cancelMovedNoShow(b._id, { reason, refund });
                await apply(r.booking);
                setNotice(refund ? 'Cancelled by the Jansetu team; the patient’s payment is back in their wallet.' : 'Cancelled by the Jansetu team; the patient was not refunded.');
              } catch (err) {
                // Q16a final: a repeat is refused 409 ALREADY_CANCELLED (another admin, or an earlier try whose answer was
                // lost); nothing more was done, never refunded twice. The booking is read again (`guarded`).
                if (!(err instanceof ApiError && err.code === 'ALREADY_CANCELLED')) throw err;
                setNotice('This booking was already cancelled (by another admin, or by an earlier try whose answer was lost): nothing more was done. It is shown as it is now.');
              }
            })} />
        )}
      </section>

      <Reports ctx={ctx} booking={b} offers={offers} disabled={disabled} perform={perform} />

      <section className="ws-section" aria-labelledby="lb-visit-h">
        <h2 id="lb-visit-h">Patient and visit</h2>
        <dl className="ws-dl">
          <dt>Patient</dt>
          <dd>{b.patient.name}{b.patient.kind === 'dependent' ? ' (family member of the account holder)' : ''}</dd>
          {b.patient.age !== undefined && <><dt>Age</dt><dd>{b.patient.age}</dd></>}
          {b.patient.gender && <><dt>Gender</dt><dd>{GENDER_LABEL[b.patient.gender] ?? b.patient.gender}</dd></>}
          <dt>Slot</dt><dd>{slotLabel(b.slot)} (India time)</dd>
          <dt>Visit</dt><dd>{LAB_VISIT_MODE_LABEL[b.visitMode]} · {branchName}</dd>
          {b.visitMode === 'home' && b.address && (
            <><dt>Address</dt><dd>{[b.address.line1, b.address.line2, b.address.landmark, b.address.city, b.address.state, b.address.pincode].filter(Boolean).join(', ')}</dd></>
          )}
          {b.collector && <><dt>Collector</dt><dd>{b.collector.name}{b.collector.phone ? ` · ${b.collector.phone}` : ''}</dd></>}
        </dl>
      </section>

      <section className="ws-section" aria-labelledby="lb-tests-h">
        <h2 id="lb-tests-h">Tests and payment</h2>
        <div className="ws-table-wrap">
          <table className="j-table">
            <caption className="j-sr-only">Tests booked: {tests}</caption>
            <thead><tr><th scope="col">Test</th><th scope="col">Code</th><th scope="col">Type</th><th scope="col">Report within</th><th scope="col">Price</th></tr></thead>
            <tbody>
              {b.items.map((i) => (
                <tr key={i.catalogItemId}>
                  <td>{i.name}</td><td>{i.code ?? '—'}</td><td>{i.kind === 'package' ? 'Package' : 'Test'}</td>
                  <td>{i.reportTatHours ? `${i.reportTatHours} h` : '—'}</td><td>{money(i.priceMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="ws-dl" aria-label="Payment">
          <dt>Tests</dt><dd>{money(b.pricing.subtotalMinor)}</dd>
          {b.pricing.discountMinor > 0 && <><dt>Coupon{b.pricing.couponCode ? ` ${b.pricing.couponCode}` : ''}</dt><dd>− {money(b.pricing.discountMinor)}</dd></>}
          <dt><strong>Paid by the customer</strong></dt><dd><strong>{money(b.pricing.payableMinor)}</strong> · {LAB_PAYMENT_STATUS_LABEL[b.paymentStatus] ?? b.paymentStatus}</dd>
        </dl>
      </section>

      <Timeline booking={b} />
    </>
  );
}

/**
 * Q16a (owner, 22 Nov 2026): a booking moved after a no-show that the lab cannot attend is cancelled by a Jansetu admin
 * only, who chooses whether the patient is refunded (`POST /partner-workspace/admin/lab-bookings/:id/cancel-no-show`).
 * A reason (the patient sees it) and the refund choice are required; nothing is chosen for the admin.
 */
function AdminCancelNoShow({ booking: b, disabled, run }: { booking: LabBooking; disabled: boolean; run: (reason: string, refund: boolean) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [refund, setRefund] = useState<'' | 'yes' | 'no'>('');
  const [errors, setErrors] = useState<{ reason?: string; refund?: string }>({});
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const host = usePanelFocus<HTMLSpanElement>(!open ? 'closed' : confirming ? 'confirming' : 'form');
  const close = () => { setOpen(false); setConfirming(false); setError(null); setErrors({}); };

  function review(e: FormEvent) {
    e.preventDefault();
    const r = reason.trim();
    const errs: { reason?: string; refund?: string } = {};
    if (r.length < MIN_LAB_REASON) errs.reason = `Give a reason (at least ${MIN_LAB_REASON} characters).`;
    else if (r.length > MAX_LAB_REASON) errs.reason = `Use at most ${MAX_LAB_REASON} characters.`;
    if (!refund) errs.refund = 'Choose whether the patient is refunded.';
    setErrors(errs);
    setError(null);
    if (!Object.keys(errs).length) setConfirming(true);
  }
  async function go() {
    setBusy(true);
    setError(null);
    try {
      await run(reason.trim(), refund === 'yes');
      close();
    } catch (err) {
      // Every answer re-reads the booking: a lost answer is settled by what it shows (Cancelled = done).
      setError(definitelyNotRecorded(err) ? `Not cancelled: ${stepMessage(err)}` : `Not confirmed: ${messageOf(err)} The booking was read again: if it shows Cancelled, it is done.`);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span ref={host} style={FOCUS_HOST_STYLE}>
      {!open ? (
        <div className="ws-actions">
          <Button variant="secondary" disabled={disabled} onClick={() => setOpen(true)}>Cancel (admin)</Button>
          <span className="ws-muted">Moved after a no-show: only the Jansetu team cancels it, with or without a refund.</span>
        </div>
      ) : (
        <form className="confirm" noValidate onSubmit={review} aria-label="Cancel (admin)">
          {!confirming ? (
            <>
              <TextArea label="Reason (the patient sees this)" value={reason} maxLength={MAX_LAB_REASON} error={errors.reason} onChange={(e) => setReason(e.target.value)} />
              <fieldset className="ws-checks" aria-describedby={errors.refund ? 'lb-admin-refund-err' : undefined}>
                <legend>Refund the patient?</legend>
                <label className="ws-check">
                  <input type="radio" name="lb-admin-refund" checked={refund === 'yes'} onChange={() => setRefund('yes')} /> Yes: the full payment of {money(b.pricing.payableMinor)} goes back to their Jansetu wallet
                </label>
                <label className="ws-check">
                  <input type="radio" name="lb-admin-refund" checked={refund === 'no'} onChange={() => setRefund('no')} /> No: the payment is kept, as for a no-show (nobody earns it)
                </label>
                {errors.refund && <span id="lb-admin-refund-err" className="j-field__error">{errors.refund}</span>}
              </fieldset>
            </>
          ) : (
            <div className="confirm-text">
              Cancel {b.patient.name}’s booking for {slotLabel(b.slot)}? Its seat is freed and the patient is told.
              {refund === 'yes' ? ` The full payment of ${money(b.pricing.payableMinor)} goes back to their Jansetu wallet.` : ' The patient is not refunded: the payment is kept, as for a no-show, and nobody earns it.'}
              {' '}This cannot be undone.
            </div>
          )}
          {error && <Alert>{error}</Alert>}
          <div className="confirm-actions">
            {!confirming ? <Button type="submit" disabled={disabled}>Continue</Button>
              : <Button variant="danger" busy={busy} disabled={disabled && !busy} onClick={() => void go()}>{refund === 'yes' ? 'Cancel and refund' : 'Cancel without a refund'}</Button>}
            <Button variant="ghost" data-focus-back disabled={busy} onClick={() => (confirming ? setConfirming(false) : close())}>Back</Button>
          </div>
        </form>
      )}
    </span>
  );
}

/** A step button; a blocked step stays visible, disabled, with the reason next to it. */
function Step({ offer, label, disabled, busy, onClick }: { offer: LabActionOffer; label: string; disabled: boolean; busy?: boolean; onClick: () => void }) {
  return (
    <div className="ws-action">
      <Button disabled={disabled || !!offer.blocked} busy={busy} onClick={onClick}>{label}</Button>
      {offer.blocked && <span className="ws-muted">{offer.blocked}</span>}
    </div>
  );
}

type Perform = (action: LabAction, run: () => Promise<LabBooking>, done: string) => Promise<void>;
/** A step on this booking: the WQ3 transitions, and Q14's one move of a no-show. */
type Step = LabAction | 'reschedule_no_show';

/** Q14: the no-show this booking was moved after (when, from which slot, to which). */
function NoShowHistory({ booking: b }: { booking: LabBooking }) {
  if (!b.noShows?.length) return null;
  return (
    <ul className="ws-list" aria-label="No-show history">
      {b.noShows.map((n, i) => (
        <li key={i}>
          Missed {slotLabel(n.fromSlot)}{n.at ? ` (marked ${formatDateTime(n.at)})` : ''} · moved to {slotLabel(n.toSlot)} on {formatDateTime(n.rescheduledAt)}
          {n.byKind === 'admin' ? ' by a Jansetu admin' : ''}. A second no-show is final.
        </li>
      ))}
    </ul>
  );
}

/** Q14: a later open slot of this branch and visit mode (next two weeks), for the one move of a no-show. */
function LabSlotPicker({ ctx, booking, now, onChoose }: { ctx: ScopeContext; booking: LabBooking; now: Date; onChoose: (t: NoShowTarget | null) => void }) {
  const from = istDateOf(now);
  const to = addDays(from, 13);
  const slots = useQuery({
    queryKey: [...ctx.key, 'slots', booking.branchId, booking.visitMode, from, to],
    queryFn: () => ctx.labs.slots({ branchId: booking.branchId, visitMode: booking.visitMode, from, to }),
  });
  const [slotId, setSlotId] = useState('');
  if (slots.isPending) return <Loading label="Loading open slots…" />;
  if (slots.isError) return <ErrorState message={messageOf(slots.error)} onRetry={() => void slots.refetch()} />;
  const choices = (slots.data ?? []).filter((s) => isBookable(s, now) && s._id !== booking.slot.slotId);
  if (choices.length === 0) return <p className="ws-muted">No open slot with a free seat in the next two weeks. Add a slot under Slots first.</p>;
  const byDay = new Map<string, LabSlot[]>();
  for (const s of choices) byDay.set(s.date, [...(byDay.get(s.date) ?? []), s]);
  return (
    <div className="j-field">
      <label htmlFor="lb-noshow-slot">New time</label>
      <select id="lb-noshow-slot" value={slotId} onChange={(e) => {
        setSlotId(e.target.value);
        const s = choices.find((x) => x._id === e.target.value);
        onChoose(s ? { slotId: s._id, label: slotLabel(s) } : null);
      }}>
        <option value="">Choose a slot</option>
        {[...byDay].map(([day, rows]) => (
          <optgroup key={day} label={formatDay(day)}>
            {rows.map((s) => <option key={s._id} value={s._id}>{formatDay(s.date)}, {s.startTime}–{s.endTime} ({s.capacity - s.booked} free)</option>)}
          </optgroup>
        ))}
      </select>
    </div>
  );
}

/** Who collects the sample: a member working at this branch (when staff can be listed), or someone named by hand. */
function AssignCollector({ ctx, booking, disabled, perform }: { ctx: ScopeContext; booking: LabBooking; disabled: boolean; perform: Perform }) {
  const [open, setOpen] = useState(false);
  const canList = holdsAny(ctx.actor, ['staff.manage']);
  const members = useQuery({ queryKey: [...ctx.key, 'members'], queryFn: () => ctx.api.members(), enabled: open && canList });
  const [memberId, setMemberId] = useState('');
  const [name, setName] = useState(booking.collector?.name ?? '');
  const [phone, setPhone] = useState(booking.collector?.phone ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** WQ11b: the booking version the form was opened on (the step names it: 409 LAB_BOOKING_CHANGED if it moved). */
  const [openedOn, setOpenedOn] = useState(booking.statusVersion);
  const [adopt, setAdopt] = useState(false);
  if (adopt && booking.statusVersion !== openedOn) { setAdopt(false); setOpenedOn(booking.statusVersion); }
  const host = usePanelFocus<HTMLSpanElement>(open ? 'open' : 'closed');
  const here = (members.data ?? []).filter((m: PartnerMember) => m.isActive !== false
    && (hasGlobalScope(m) || m.branchIds.includes(booking.branchId)));
  const chosen = here.find((m) => m._id === memberId);

  return <span ref={host} style={FOCUS_HOST_STYLE}>{open ? form() : (
    <Button variant="secondary" disabled={disabled} onClick={() => { setOpenedOn(booking.statusVersion); setError(null); setOpen(true); }}>
      {booking.collector ? 'Change collector' : 'Assign collector'}
    </Button>
  )}</span>;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const n = (chosen?.name ?? name).trim();
    const p = phone.trim();
    const errs: Record<string, string> = {};
    if (!chosen && !n) errs.name = 'Enter the collector’s name.';
    else if (n.length > MAX_COLLECTOR_NAME) errs.name = `Use at most ${MAX_COLLECTOR_NAME} characters.`;
    if (p && !COLLECTOR_PHONE_PATTERN.test(p)) errs.phone = 'Enter 10 digits.';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setError(null);
    try {
      await perform('assign', () => ctx.labs.assignCollector(booking._id, { ...(chosen ? { memberId: chosen._id } : {}), name: n, ...(p ? { phone: p } : {}) }, openedOn),
        `${n} will collect the sample.`);
      setOpen(false);
    } catch (err) {
      setError(stepMessage(err));
      // The booking is being read again: once it is shown, the form names that version (what is on screen now).
      if (isLabBookingChanged(err)) setAdopt(true);
    } finally {
      setBusy(false);
    }
  }

  function form() {
  return (
    <form className="confirm" noValidate onSubmit={(e) => void submit(e)} aria-label="Assign collector">
      {canList && (
        <div className="j-field">
          <label htmlFor="lb-collector">Who collects</label>
          <select id="lb-collector" value={memberId} onChange={(e) => setMemberId(e.target.value)}>
            <option value="">Someone else (type the name)</option>
            {here.map((m) => <option key={m._id} value={m._id}>{m.name}</option>)}
          </select>
          {members.isError && <span className="j-field__hint">Staff could not be listed: {messageOf(members.error)}</span>}
        </div>
      )}
      <div className="rx-form-row">
        {!chosen && <TextField label="Collector’s name" value={name} maxLength={MAX_COLLECTOR_NAME} error={errors.name} onChange={(e) => setName(e.target.value)} />}
        <TextField label="Collector’s mobile (optional)" inputMode="numeric" value={phone} maxLength={10} error={errors.phone} onChange={(e) => setPhone(e.target.value)} />
      </div>
      <p className="ws-muted">The customer sees the collector’s name and mobile number.</p>
      {error && <Alert>{error}</Alert>}
      <div className="confirm-actions">
        <Button type="submit" busy={busy}>Save collector</Button>
        <Button variant="ghost" data-focus-back disabled={busy} onClick={() => setOpen(false)}>Back</Button>
      </div>
    </form>
  );
  }
}

/** A new time from this branch's open slots (next two weeks) with a reason; the customer accepts or cancels for a refund. */
function ProposeTime({ ctx, booking, disabled, now, perform }: { ctx: ScopeContext; booking: LabBooking; disabled: boolean; now: Date; perform: Perform }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const from = istDateOf(now);
  const to = addDays(from, 13);
  const slotsKey = [...ctx.key, 'slots', booking.branchId, booking.visitMode, from, to];
  const slots = useQuery({
    queryKey: slotsKey, enabled: open,
    queryFn: () => ctx.labs.slots({ branchId: booking.branchId, visitMode: booking.visitMode, from, to }),
  });
  const [slotId, setSlotId] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  /** WQ11b: the booking version the proposal was reviewed on (taken when it is confirmed, named by the step). */
  const [reviewedOn, setReviewedOn] = useState(booking.statusVersion);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The picker's slots load after it opens: focus moves on to the slot list once it is there.
  const host = usePanelFocus<HTMLSpanElement>(!open ? 'closed' : confirming ? 'confirming' : slots.isPending ? 'loading' : 'picking');


  const choices = (slots.data ?? []).filter((s) => isBookable(s, now) && s._id !== booking.slot.slotId);
  const byDay = new Map<string, LabSlot[]>();
  for (const s of choices) byDay.set(s.date, [...(byDay.get(s.date) ?? []), s]);
  const picked = choices.find((s) => s._id === slotId);

  return <span ref={host} style={FOCUS_HOST_STYLE}>{open ? form() : (
    <Button variant="secondary" disabled={disabled} onClick={() => { setError(null); setConfirming(false); setOpen(true); }}>Propose a new time</Button>
  )}</span>;

  function form() {
  function review(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!picked) errs.slot = 'Choose the new time.';
    const r = reason.trim();
    if (r.length < MIN_LAB_REASON) errs.reason = `Give a reason (at least ${MIN_LAB_REASON} characters).`;
    else if (r.length > MAX_LAB_REASON) errs.reason = `Use at most ${MAX_LAB_REASON} characters.`;
    setErrors(errs);
    setError(null);
    if (!Object.keys(errs).length) { setReviewedOn(booking.statusVersion); setConfirming(true); }
  }

  async function propose() {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      await perform('reschedule', () => ctx.labs.reschedule(booking._id, picked._id, reason.trim(), reviewedOn),
        `New time proposed: ${slotLabel(picked)}. The customer has been told and can accept it or cancel for a full refund.`);
      setOpen(false);
    } catch (err) {
      // E.g. "That slot is no longer available", or the booking changed: show the current slots and booking.
      setError(stepMessage(err));
      setConfirming(false);
      void queryClient.invalidateQueries({ queryKey: slotsKey });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="confirm" noValidate onSubmit={review} aria-label="Propose a new time">
      {slots.isPending ? <Loading label="Loading open slots…" />
        : slots.isError ? <ErrorState message={messageOf(slots.error)} onRetry={() => void slots.refetch()} />
        : choices.length === 0 ? <p className="ws-muted">No open slot with a free seat in the next two weeks. Add a slot under Slots first.</p>
        : !confirming ? (
          <>
            <div className="j-field">
              <label htmlFor="lb-new-slot">New time</label>
              <select id="lb-new-slot" value={slotId} aria-invalid={errors.slot ? true : undefined} aria-describedby={errors.slot ? 'lb-new-slot-err' : undefined}
                onChange={(e) => setSlotId(e.target.value)}>
                <option value="">Choose a slot</option>
                {[...byDay].map(([day, rows]) => (
                  <optgroup key={day} label={formatDay(day)}>
                    {rows.map((s) => <option key={s._id} value={s._id}>{formatDay(s.date)}, {s.startTime}–{s.endTime} ({s.capacity - s.booked} free)</option>)}
                  </optgroup>
                ))}
              </select>
              {errors.slot && <span id="lb-new-slot-err" className="j-field__error">{errors.slot}</span>}
            </div>
            <TextArea label="Reason (the customer sees this)" value={reason} maxLength={MAX_LAB_REASON} error={errors.reason} onChange={(e) => setReason(e.target.value)} />
          </>
        ) : picked && (
          <div className="confirm-text">
            Propose {slotLabel(picked)} instead of {slotLabel(booking.slot)}? The new seat is taken now and the current one is freed.
            The customer is told and can accept the new time or cancel for a full refund; until they answer, the booking cannot be marked
            {booking.visitMode === 'home' ? ' collected' : ' visited'} or no-show.
          </div>
        )}
      {error && <Alert>Not proposed: {error}</Alert>}
      <div className="confirm-actions">
        {!confirming ? <Button type="submit" disabled={choices.length === 0}>Continue</Button>
          : <Button busy={busy} onClick={() => void propose()}>Propose the new time</Button>}
        <Button variant="ghost" data-focus-back disabled={busy} onClick={() => (confirming ? setConfirming(false) : setOpen(false))}>Back</Button>
      </div>
    </form>
  );
  }
}

// ── Reports ──

function Reports({ ctx, booking, offers, disabled, perform }: {
  ctx: ScopeContext; booking: LabBooking; offers: LabActionOffer[]; disabled: boolean; perform: Perform;
}) {
  const viewer = useReportViewer(ctx, booking._id);
  const drafts = booking.report.draftFiles;
  const released = booking.report.releasedFiles;
  const canUpload = offers.some((o) => o.action === 'upload');
  const canRelease = offers.some((o) => o.action === 'release');
  const seeDrafts = canReadDrafts(ctx.actor);
  if (!drafts.length && !released.length && !canUpload) return null;
  return (
    <section className="ws-section" aria-labelledby="lb-reports-h">
      <h2 id="lb-reports-h">Reports</h2>
      <h3>Released to the customer</h3>
      {released.length === 0 ? <p className="ws-muted">No report has been released yet.</p> : (
        <ul className="ws-list" aria-label="Released reports">
          {released.map((f) => {
            const r = releaseOf(booking, f);
            return (
              <li key={f}>
                <div className="ws-actions">
                  <span>{reportFileName(f)}{r ? ` · released ${formatDateTime(r.releasedAt)} under ${r.signer.name}${r.signer.kind ? ` (${r.signer.kind})` : ''}, registration ${r.signer.registrationNumber}` : ''}</span>
                  <ViewFileButton viewer={viewer} file={f} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <h3>Drafts (not visible to the customer)</h3>
      {drafts.length === 0 ? <p className="ws-muted">No draft waiting.</p>
        : !seeDrafts ? <p className="ws-muted">{drafts.length} {drafts.length === 1 ? 'draft is' : 'drafts are'} waiting for release. Only report staff can open drafts.</p>
        : (
          <ul className="ws-list" aria-label="Draft reports">
            {drafts.map((f) => (
              <li key={f}>
                <div className="ws-actions">
                  <span>{reportFileName(f)}</span>
                  <ViewFileButton viewer={viewer} file={f} />
                  {canRelease && <ReleaseDraft ctx={ctx} booking={booking} file={f} disabled={disabled} perform={perform} />}
                </div>
              </li>
            ))}
          </ul>
        )}
      <ReportPreview viewer={viewer} />
      {canUpload && <UploadReports ctx={ctx} booking={booking} disabled={disabled} perform={perform} />}
    </section>
  );
}

/** A chosen report file and the request key it is sent with (the same key on every resend: never attached twice). */
interface UploadItem { file: File; key: string; done: boolean; /** WQ11d: its last send got no answer (it may be attached). */ uncertain?: boolean }

/**
 * WQ11b: report files are sent ONE PER REQUEST (the server's upload limit of 10 MB is for a whole request, so two 6 MB
 * files together were always refused), each under its own request key (Q11 `?requestKey=`). Each file is checked to be
 * at most 10 MB before anything is sent. A file the server refused for its size says so; a lost answer leaves that file
 * and the ones after it to send again with the same keys (a file already attached is answered, not copied).
 */
export function uploadFailureMessage(name: string, err: unknown): { text: string; certain: boolean } {
  if (isReportTooLarge(err)) return { text: `File too large: ${name} is over the ${REPORT_MAX_BYTES / 1024 / 1024} MB limit, so it was not uploaded. Choose a smaller file.`, certain: true };
  // UPLOAD_FAILED: the file service gave up before anything was attached (its files are removed again).
  if (isUploadFailed(err) || definitelyNotRecorded(err)) return { text: `${name} was not uploaded: ${stepMessage(err)}`, certain: true };
  return {
    text: `${name}: ${messageOf(err)} It may have been uploaded. Upload again to send it once more: a file already added is never added twice.`,
    certain: false,
  };
}

function UploadReports({ ctx, booking, disabled, perform }: { ctx: ScopeContext; booking: LabBooking; disabled: boolean; perform: Perform }) {
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const problems = items.map((i) => reportFileProblem(i.file)).filter((p): p is string => !!p);
  const left = items.filter((i) => !i.done);
  /**
   * WQ11d: while a send is unanswered the same files and keys are kept: choosing files again would give that file a new
   * key and could attach a second copy. It is settled by "Upload the rest" (same keys: answered, never copied) or by a
   * check that finds it among the booking's reports.
   */
  const locked = left.some((i) => i.uncertain);
  const [checking, setChecking] = useState(false);

  async function check() {
    setChecking(true);
    try {
      const now = await queryClient.fetchQuery({ queryKey: [...ctx.key, 'lab-booking', booking._id], queryFn: () => ctx.labs.booking(booking._id), staleTime: 0 });
      const there = new Set([...now.report.draftFiles, ...now.report.releasedFiles].map((f) => reportFileName(f)));
      const found = left.filter((i) => there.has(i.file.name));
      const next = items.map((x) => (found.some((f) => f.key === x.key) ? { ...x, done: true, uncertain: false } : x));
      setItems(next.every((x) => x.done) ? [] : next);
      const still = next.filter((x) => !x.done);
      setError(still.length === 0 ? null
        : `${found.length ? `Found: ${found.map((f) => f.file.name).join(', ')}. ` : ''}Not found among the reports yet: ${still.map((x) => x.file.name).join(', ')}. Tap “Upload the rest” to send ${still.length === 1 ? 'it' : 'them'} again (never added twice).`);
      if (still.length === 0 && input.current) input.current.value = '';
    } catch (err) {
      setError(`Could not check: ${messageOf(err)}`);
    } finally {
      setChecking(false);
    }
  }

  async function upload(e: FormEvent) {
    e.preventDefault();
    if (items.length === 0) { setError('Choose the report files first.'); return; }
    if (problems.length) { setError(problems.join(' ')); return; }
    setBusy(true);
    setError(null);
    let added = items.length - left.length;
    try {
      for (const it of left) {
        const last = added + 1 === items.length;
        try {
          await perform('upload', () => ctx.labs.uploadReport(booking._id, it.file, it.key), last
            ? `${items.length} ${items.length === 1 ? 'file was' : 'files were'} added as drafts. Release each one when it is checked.`
            : `${it.file.name} was added as a draft; sending the next file…`);
        } catch (err) {
          const why = uploadFailureMessage(it.file.name, err);
          setItems((cur) => cur.map((x) => (x.key === it.key ? { ...x, uncertain: !why.certain } : x)));
          setError(`${added ? `${added} of ${items.length} added. ` : ''}${why.text}`);
          if (!why.certain) void queryClient.invalidateQueries({ queryKey: [...ctx.key, 'lab-booking', booking._id] });
          return;
        }
        added += 1;
        setItems((cur) => cur.map((x) => (x.key === it.key ? { ...x, done: true } : x)));
      }
      setItems([]);
      if (input.current) input.current.value = '';
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="rx-form" noValidate onSubmit={(e) => void upload(e)} aria-label="Upload reports">
      <h3>Upload reports</h3>
      <div className="j-field">
        <label htmlFor="lb-files">Report files (PDF, JPEG, PNG or WebP; up to 10 MB each, sent one by one)</label>
        <input id="lb-files" ref={input} type="file" multiple accept={REPORT_ACCEPT} aria-describedby={error ? 'lb-files-err' : undefined}
          disabled={locked || busy}
          onChange={(e) => { if (locked) return; setItems([...(e.target.files ?? [])].map((file) => ({ file, key: newRequestKey(), done: false }))); setError(null); }} />
        {locked && (
          <span className="j-field__hint">
            An upload got no answer, so these files are kept with their keys: tap “Upload the rest” (a file already added is never
            added twice) or check the reports. Other files can be chosen once this is settled.
          </span>
        )}
        {problems.length > 0 && <span className="j-field__error">{problems.join(' ')}</span>}
        {items.length > 1 && left.length < items.length && left.length > 0 && (
          <span className="j-field__hint">Still to send: {left.map((i) => i.file.name).join(', ')}.</span>
        )}
      </div>
      {error && <div id="lb-files-err"><Alert>{error}</Alert></div>}
      <div className="ws-actions">
        <Button type="submit" busy={busy} disabled={(disabled && !busy) || checking}>{locked || (left.length < items.length && left.length > 0) ? 'Upload the rest' : 'Upload as drafts'}</Button>
        {locked && <Button variant="secondary" busy={checking} disabled={busy || disabled} onClick={() => void check()}>Check the reports</Button>}
      </div>
    </form>
  );
}

/**
 * Releases one draft under a professional (`releaseReport`): members sign as themselves; admins name a member who may
 * sign for this branch and has a professional registration on record. Confirmed first: the customer sees it at once.
 */
function ReleaseDraft({ ctx, booking, file, disabled, perform }: { ctx: ScopeContext; booking: LabBooking; file: string; disabled: boolean; perform: Perform }) {
  const user = useStaff();
  const admin = ctx.scope.kind === 'admin';
  const [open, setOpen] = useState(false);
  const members = useQuery({ queryKey: [...ctx.key, 'members'], queryFn: () => ctx.api.members(), enabled: open && admin });
  const signers = eligibleSigners(members.data ?? [], booking.branchId);
  const [signerId, setSignerId] = useState('');
  const signer = signers.find((m) => m._id === signerId);
  const name = reportFileName(file);
  /** WQ11b: the booking version the release was opened on (named by the step: 409 LAB_BOOKING_CHANGED if it moved). */
  const [openedOn, setOpenedOn] = useState(booking.statusVersion);
  const [adopt, setAdopt] = useState(false);
  if (adopt && booking.statusVersion !== openedOn) { setAdopt(false); setOpenedOn(booking.statusVersion); }
  const host = usePanelFocus<HTMLSpanElement>(open ? 'open' : 'closed');
  return (
    <span ref={host} style={FOCUS_HOST_STYLE}>
      {open ? panel() : (
        <Button variant="secondary" disabled={disabled} aria-label={`Release ${name}`} onClick={() => { setOpenedOn(booking.statusVersion); setOpen(true); }}>Release</Button>
      )}
    </span>
  );

  function panel() {
  let who: ReactNode;
  if (!admin) who = <>under your own name ({user.name}) and your professional registration</>;
  else if (signer) who = <>under {signer.name} ({signer.professional!.kind}, registration {signer.professional!.registrationNumber})</>;

  return (
    <div className="confirm" role="group" aria-label={`Release ${name}`}>
      {admin && (members.isPending ? <Loading label="Loading who can sign…" />
        : members.isError ? <ErrorState message={messageOf(members.error)} onRetry={() => void members.refetch()} />
        : signers.length === 0 ? (
          <Alert tone="warn">
            Nobody can sign this report. A signer must be an owner or hold “Release reports”, work at this branch, and have a professional
            registration number on their staff record. Add one on <Link to={ctx.link('staff')}>Staff</Link> (“Add registration”).
          </Alert>
        ) : (
          <div className="j-field">
            <label htmlFor={`signer-${name}`}>Signed by</label>
            <select id={`signer-${name}`} value={signerId} onChange={(e) => setSignerId(e.target.value)}>
              <option value="">Choose the professional</option>
              {signers.map((m) => <option key={m._id} value={m._id}>{m.name} · {m.professional!.registrationNumber}</option>)}
            </select>
          </div>
        ))}
      {who && (
        <div className="confirm-text">
          Release {name} to the customer {who}? They can open and download it in the Jansetu app at once and are told it is ready.
          A released report cannot be withdrawn here.
        </div>
      )}
      <ConfirmLess
        label={`Release ${name}`} ready={!!who} blocked={disabled} staffLink={ctx.link('staff')}
        onConfirm={() => perform('release', () => ctx.labs.releaseReport(booking._id, file, admin ? signer?._id : undefined, openedOn),
          `${name} was released to the customer.`)}
        onChanged={() => setAdopt(true)}
        onBack={() => setOpen(false)} />
    </div>
  );
  }
}

/** The final buttons of an already explained step; shows the server's refusal in place. */
function ConfirmLess({ label, ready, blocked, staffLink, onConfirm, onChanged, onBack }: {
  label: string; ready: boolean; blocked: boolean; staffLink: string; onConfirm: () => Promise<void>;
  /** The booking changed under the step (409 LAB_BOOKING_CHANGED): the next try is about the booking as read again. */
  onChanged: () => void; onBack: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReactNode>(null);
  async function go() {
    setBusy(true);
    setError(null);
    try { await onConfirm(); } catch (err) {
      // Releasing the same file again is safe (an already released file is left as it is).
      // Q11: the signer's staff record has no registration (409 SIGNER_REGISTRATION_MISSING): an owner adds it on Staff.
      if (err instanceof ApiError && err.code === 'SIGNER_REGISTRATION_MISSING') {
        setError(<>Not released: the signer’s staff record has no professional registration number. An owner adds it on <Link to={staffLink}>Staff</Link> (“Add registration”).</>);
      } else setError(`Not released: ${stepMessage(err)}`);
      if (isLabBookingChanged(err)) onChanged();
    } finally { setBusy(false); }
  }
  return (
    <>
      {error && <Alert>{error}</Alert>}
      <div className="confirm-actions">
        <Button busy={busy} disabled={!ready || (blocked && !busy)} onClick={() => void go()}>{label}</Button>
        <Button variant="ghost" data-focus-back disabled={busy} onClick={onBack}>Back</Button>
      </div>
    </>
  );
}

function Timeline({ booking: b }: { booking: LabBooking }) {
  const events: { at: string; text: string }[] = [];
  if (b.createdAt) events.push({ at: b.createdAt, text: 'Booked in the app' });
  for (const [k, label] of LIFECYCLE) {
    const at = b.lifecycle?.[k];
    if (at) events.push({ at, text: label });
  }
  if (b.reschedule?.at && b.reschedule.previousSlot) {
    events.push({
      at: b.reschedule.at,
      text: `New time proposed: ${slotLabel(b.slot)} instead of ${slotLabel(b.reschedule.previousSlot)}${b.reschedule.reason ? ` (“${b.reschedule.reason}”)` : ''}${b.reschedule.pending ? '; waiting for the customer' : '; accepted'}`,
    });
  }
  for (const r of b.report.releases) {
    events.push({ at: r.releasedAt, text: `Report ${reportFileName(r.path)} released under ${r.signer.name} (registration ${r.signer.registrationNumber})` });
  }
  for (const n of b.noShows ?? []) {
    if (n.at) events.push({ at: n.at, text: `Marked as no-show (${slotLabel(n.fromSlot)})` });
    events.push({ at: n.rescheduledAt, text: `No-show moved to ${slotLabel(n.toSlot)}` });
  }
  events.sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
  return (
    <section className="ws-section" aria-labelledby="lb-time-h">
      <h2 id="lb-time-h">Timeline</h2>
      {events.length === 0 ? <p className="ws-muted">Nothing recorded yet.</p> : (
        <ol className="ws-timeline">
          {events.map((e, i) => <li key={i}><time dateTime={e.at}>{formatDateTime(e.at)}</time><span>{e.text}</span></li>)}
        </ol>
      )}
    </section>
  );
}
