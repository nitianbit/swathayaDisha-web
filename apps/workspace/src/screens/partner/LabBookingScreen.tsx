import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import {
  addDays, ApiError, canReadDrafts, COLLECTOR_PHONE_PATTERN, eligibleSigners, hasGlobalScope, holdsAny, isBookable, isLabBookingChanged, isReportTooLarge,
  istDateOf, isUploadFailed, LAB_BOOKING_STATUS_LABEL, LAB_PAYMENT_STATUS_LABEL, LAB_VISIT_MODE_LABEL, labActions, labNoShowMove, MAX_COLLECTOR_NAME,
  MAX_LAB_REASON, MIN_LAB_REASON, noShowMovedOnce, OBJECT_ID_PATTERN, releaseOf, REPORT_ACCEPT, REPORT_MAX_BYTES, reportFileName, reportFileProblem,
  labBookingsAdminApi, tooLongWords, type LabAction, type LabActionOffer, type LabBooking, type LabLifecycleKey, type LabSlot, type PartnerMember,
  canBillDesk, canDeskCancel, deskRefusal, INVOICE_STATE_LABEL, isDeskBooking, labDeskApi, type DeskCancelAnswer,
} from '@jansetu/api';
import { Alert, Badge, Button, ErrorState, formatDateTime, Loading, Parts, shared, TextArea, TextField } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { FOCUS_HOST_STYLE, usePanelFocus } from '../../components/focus.ts';
import { NoShowMove, noShowMoveSlot, type NoShowTarget } from '../../components/NoShowMove.tsx';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { definitelyNotRecorded, newRequestKey } from '../../requests.ts';
import { useSession, useStaff } from '../../session.tsx';
import { BILL_READERS, BillLink, money } from './billing.tsx';
import { OwnedCancel } from '../pharmacy/ownedCancel.tsx';
import {
  formatDay, LabOnly, LabPayment, labStatusTone, ReportPreview, slotLabel, useNow, useReportViewer, ViewFileButton,
} from './labs.tsx';
import { NoSuchPartner, scopeIdentity, useBranches, usePartnerScope, useWorkspacePartner, type ScopeContext } from './scope.tsx';
import { t } from '../../i18n/partner/index.ts';

const LIFECYCLE: readonly LabLifecycleKey[] = [
  'paidAt', 'confirmedAt', 'collectedAt', 'visitedAt', 'processingAt', 'reportReadyAt', 'completedAt', 'cancelledAt', 'noShowAt',
];
/**
 * Why a booking was cancelled (Q16a: an admin cancels a booking moved after a no-show, with or without a refund; r11 /
 * r12: the pharmacy that booked it, or the lab's own front desk). A reason this app does not know shows as sent.
 */
const cancelReason = (reason: string) => {
  const key = `labBooking.cancelReason.${reason}`;
  return t.has(key) ? t(key) : reason;
};
/** A gender as given at booking (the new-bill form's words). */
const genderLabel = (g: string) => {
  const key = `newInvoice.gender.${g}`;
  return g !== 'none' && t.has(key) ? t(key) : g;
};

/**
 * WQ11b: every step names the booking's `statusVersion` it was reviewed on (Q11 `expectedVersion`). When the booking
 * moved meanwhile the server does nothing (409 LAB_BOOKING_CHANGED); the page reads the booking again (every step
 * re-reads it when it ends) and says so.
 */
const stepMessage = (err: unknown) => (isLabBookingChanged(err) ? t('labBooking.changed') : messageOf(err));

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
      <Link className="ws-back" to={ctx.link('lab-bookings')}><ArrowLeft size={16} aria-hidden="true" /> {t('labBooking.back')}</Link>
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
      throw new ApiError(409, t('labBooking.stepRunning'), 'STEP_IN_FLIGHT');
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
    perform(action, run, done).catch((err: unknown) => setFailure(t('labBooking.stepFailed', { what, reason: stepMessage(err) })));
  /** For confirmations: the refusal in words (LAB_BOOKING_CHANGED explained), shown inside the confirmation. */
  const confirmed = (action: LabAction, run: () => Promise<LabBooking>, done: string) =>
    perform(action, run, done).catch((err: unknown) => { throw new ApiError(err instanceof ApiError ? err.status : 0, stepMessage(err), err instanceof ApiError ? err.code : undefined); });

  if (q.isPending) return <><PageHeading title={t('labBooking.titleUnknown')} /><Loading label={t('labBooking.loading')} /></>;
  if (q.isError || !b) return <><PageHeading title={t('labBooking.titleUnknown')} /><ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} /></>;

  const branchName = branches.data?.find((x) => x._id === b.branchId)?.name ?? t('common.branchById', { tail: b.branchId.slice(-6) });
  const offers = labActions(b, ctx.actor, now);
  // Q14: the one move of a no-show (also shown while a move sent earlier is still unconfirmed, whatever the status now).
  const move = labNoShowMove(b, ctx.actor);
  const showMove = !!move || (holdsAny(ctx.actor, ['bookings.manage']) && !!memory.get(moveSlot));
  const offer = (a: LabAction) => offers.find((o) => o.action === a);
  const disabled = busy !== null;
  const tests = b.items.map((i) => i.name).join(', ');

  return (
    <>
      <PageHeading title={t('labBooking.title', { name: b.patient.name })}>
        {ctx.adminHome ? <>{partnerName === undefined ? t('scope.managingThis') : t('scope.managing', { name: partnerName })} </> : null}
        {slotLabel(b.slot)} · {LAB_VISIT_MODE_LABEL[b.visitMode]} · {branchName}
      </PageHeading>
      {notice && <Alert tone="ok">{notice}</Alert>}

      <section className="ws-section" aria-labelledby="lb-status-h">
        <h2 id="lb-status-h">{t('labBooking.status')}</h2>
        {failure && <Alert>{failure}</Alert>}
        <div className="ws-actions">
          <Badge tone={labStatusTone(b.status)}>{LAB_BOOKING_STATUS_LABEL[b.status] ?? b.status}</Badge>
          <LabPayment b={b} />
          {b.reschedule?.pending && <Badge tone="warn">{t('labBooking.newTimeProposed')}</Badge>}
        </div>
        {b.status === 'pending_payment' && (
          <p className="ws-muted">{t('labBooking.unpaid', { deadline: formatDateTime(b.paymentDeadline) })}</p>
        )}
        {b.reschedule?.pending && b.reschedule.previousSlot && (
          <Alert tone="warn">
            {b.reschedule.reason
              ? t('labBooking.proposedReason', { slot: slotLabel(b.slot), previous: slotLabel(b.reschedule.previousSlot), reason: b.reschedule.reason })
              : t('labBooking.proposed', { slot: slotLabel(b.slot), previous: slotLabel(b.reschedule.previousSlot) })}
          </Alert>
        )}
        {b.cancellation && (
          <p>{cancelReason(b.cancellation.reason)}{b.cancellation.note ? `: “${b.cancellation.note}”` : ''} · {formatDateTime(b.cancellation.at)}
            {/* WQ11d: an admin's cancel of a moved no-show says whether the patient was refunded. */}
            {b.cancellation.reason === 'admin_no_show' && (b.cancellation.refund === true
              ? <> · {t('labBooking.adminRefunded', { amount: money(b.pricing.payableMinor) })}</>
              : b.cancellation.refund === false ? <> · {t('labBooking.adminNotRefunded')}</> : null)}
          </p>
        )}
        {b.status === 'no_show' && (
          <p className="ws-muted">{move === 'offer' ? t('labBooking.noShowMovable') : t('labBooking.noShow')}</p>
        )}
        <NoShowHistory booking={b} />
        {showMove && (
          <div className="ws-actions">
            <NoShowMove key={`${b._id}:${b.statusVersion}`} slot={moveSlot} who={b.patient.name} missed={slotLabel(b.slot)} state={move === 'used' ? 'used' : 'offer'}
              status={b.status} readAt={q.dataUpdatedAt} reading={q.isFetching} disabled={busy !== null || q.isFetching} version={b.statusVersion}
              consequence={t('labBooking.move.consequence')}
              picker={(choose) => <LabSlotPicker ctx={ctx} booking={b} now={now} onChoose={choose} />}
              send={(target: NoShowTarget, requestKey) => guarded('reschedule_no_show', () => ctx.labs.rescheduleNoShow(b._id, target.slotId, requestKey, typeof target.version === 'number' ? target.version : undefined))}
              reread={() => void queryClient.invalidateQueries({ queryKey: key, exact: true })}
              onNotice={(text) => { setFailure(null); setNotice(text); }} onFailure={(text) => { setNotice(null); setFailure(text); }}
              onSlotRefused={() => void queryClient.invalidateQueries({ queryKey: [...ctx.key, 'slots', b.branchId, b.visitMode] })} />
          </div>
        )}
        {offers.length > 0 ? (
          <div className="ws-actions">
            {/* A button step is reviewed on the booking as shown: it names that version. */}
            {offer('collect') && (
              <Step offer={offer('collect')!} disabled={disabled} busy={busy === 'collect'} label={t('labBooking.collect')}
                onClick={() => void click('collect', t('labBooking.collect.failed'), () => ctx.labs.markCollected(b._id, b.statusVersion), t('labBooking.collect.done'))} />
            )}
            {offer('visit') && (
              <Step offer={offer('visit')!} disabled={disabled} busy={busy === 'visit'} label={t('labBooking.visit')}
                onClick={() => void click('visit', t('labBooking.visit.failed'), () => ctx.labs.markVisited(b._id, b.statusVersion), t('labBooking.visit.done'))} />
            )}
            {offer('process') && (
              <Step offer={offer('process')!} disabled={disabled} busy={busy === 'process'} label={t('labBooking.process')}
                onClick={() => void click('process', t('labBooking.process.failed'), () => ctx.labs.startProcessing(b._id, b.statusVersion), t('labBooking.process.done'))} />
            )}
            {offer('no_show') && (offer('no_show')!.blocked
              ? <Step offer={offer('no_show')!} disabled label={t('labBooking.noShowMark')} onClick={() => undefined} />
              : (
                <ConfirmAction label={t('labBooking.noShowMark')} danger disabled={disabled} confirmLabel={t('labBooking.noShowMark')} version={b.statusVersion}
                  // Q14: a booking already moved once after a no-show is never moved again (409 NO_SHOW_RESCHEDULE_USED).
                  consequence={t(noShowMovedOnce(b) ? 'labBooking.noShowMark.final' : 'labBooking.noShowMark.consequence', { name: b.patient.name, slot: slotLabel(b.slot) })}
                  onConfirm={(_r, v) => confirmed('no_show', () => ctx.labs.markNoShow(b._id, v as number), t('labBooking.noShowMark.done'))} />
              ))}
            {offer('complete') && (
              <ConfirmAction label={t('labBooking.complete')} disabled={disabled} confirmLabel={t('labBooking.complete')} version={b.statusVersion}
                consequence={isDeskBooking(b)
                  ? t('labBooking.complete.desk')
                  : t('labBooking.complete.online', { amount: money(Math.max(0, b.pricing.subtotalMinor - b.pricing.discountMinor)) })}
                onConfirm={(_r, v) => confirmed('complete', () => ctx.labs.complete(b._id, v as number), t('labBooking.complete.done'))} />
            )}
            {offer('assign') && <AssignCollector ctx={ctx} booking={b} disabled={disabled} perform={perform} />}
            {offer('reschedule') && <ProposeTime ctx={ctx} booking={b} disabled={disabled} now={now} perform={perform} />}
            {offer('reject') && (
              <ConfirmAction label={t('labBooking.reject')} danger disabled={disabled} reason reasonLabel={t('labBooking.reject.reason')}
                maxReason={MAX_LAB_REASON} confirmLabel={t('labBooking.reject.confirm')} version={b.statusVersion}
                consequence={t('labBooking.reject.consequence', { amount: money(b.pricing.payableMinor) })}
                onConfirm={(reason, v) => confirmed('reject', async () => (await ctx.labs.reject(b._id, reason, v as number)).booking, t('labBooking.reject.done'))} />
            )}
          </div>
        ) : !showMove && b.status !== 'pending_payment' && !['completed', 'cancelled', 'no_show'].includes(b.status) && (
          <p className="ws-muted">{t('labBooking.viewOnly')}</p>
        )}
        {ctx.scope.kind === 'admin' && b.status === 'confirmed' && noShowMovedOnce(b) && (
          <AdminCancelNoShow booking={b} disabled={disabled}
            run={(reason, refund) => guarded('reject', async () => {
              try {
                const r = await labBookingsAdminApi(api).cancelMovedNoShow(b._id, { reason, refund });
                await apply(r.booking);
                setNotice(refund ? t('labBooking.adminCancel.refunded') : t('labBooking.adminCancel.notRefunded'));
              } catch (err) {
                // Q16a final: a repeat is refused 409 ALREADY_CANCELLED (another admin, or an earlier try whose answer was
                // lost); nothing more was done, never refunded twice. The booking is read again (`guarded`).
                if (!(err instanceof ApiError && err.code === 'ALREADY_CANCELLED')) throw err;
                setNotice(t('labBooking.adminCancel.already'));
              }
            })} />
        )}
      </section>

      {isDeskBooking(b) && <DeskParts ctx={ctx} booking={b} disabled={disabled}
        perform={(run) => guarded('desk_cancel', run)} onNotice={(t) => { setFailure(null); setNotice(t); }}
        reread={() => { void queryClient.invalidateQueries({ queryKey: key, exact: true }); void queryClient.invalidateQueries({ queryKey: [...ctx.key, 'lab-bookings'] }); }}
        readNow={() => ctx.labs.booking(b._id)} />}

      <Reports ctx={ctx} booking={b} offers={offers} disabled={disabled} perform={perform} />

      <section className="ws-section" aria-labelledby="lb-visit-h">
        <h2 id="lb-visit-h">{t('labBooking.patientAndVisit')}</h2>
        <dl className="ws-dl">
          <dt>{t('labBooking.patient')}</dt>
          <dd>{b.patient.kind === 'dependent' ? t('labBooking.dependent', { name: b.patient.name }) : b.patient.name}</dd>
          {b.patient.age !== undefined && <><dt>{t('labBooking.age')}</dt><dd>{b.patient.age}</dd></>}
          {b.patient.gender && <><dt>{t('labBooking.gender')}</dt><dd>{genderLabel(b.patient.gender)}</dd></>}
          <dt>{t('labBooking.slot')}</dt><dd>{t('labBooking.slotIst', { slot: slotLabel(b.slot) })}</dd>
          <dt>{t('labBooking.visitLabel')}</dt><dd>{LAB_VISIT_MODE_LABEL[b.visitMode]} · {branchName}</dd>
          {b.visitMode === 'home' && b.address && (
            <><dt>{t('labBooking.address')}</dt><dd>{[b.address.line1, b.address.line2, b.address.landmark, b.address.city, b.address.state, b.address.pincode].filter(Boolean).join(', ')}</dd></>
          )}
          {b.collector && <><dt>{t('labBooking.collector')}</dt><dd>{b.collector.name}{b.collector.phone ? ` · ${b.collector.phone}` : ''}</dd></>}
        </dl>
      </section>

      <section className="ws-section" aria-labelledby="lb-tests-h">
        <h2 id="lb-tests-h">{t('labBooking.testsAndPayment')}</h2>
        <div className="ws-table-wrap">
          <table className="j-table">
            <caption className="j-sr-only">{t('labBooking.testsCaption', { tests })}</caption>
            <thead>
              <tr>
                <th scope="col">{t('labBooking.col.test')}</th><th scope="col">{t('labBooking.col.code')}</th><th scope="col">{t('labBooking.col.type')}</th>
                <th scope="col">{t('labBooking.col.reportWithin')}</th><th scope="col">{t('labBooking.col.price')}</th>
              </tr>
            </thead>
            <tbody>
              {b.items.map((i) => (
                <tr key={i.catalogItemId}>
                  <td>{i.name}</td><td>{i.code ?? '—'}</td><td>{i.kind === 'package' ? t('billing.kind.package') : t('billing.kind.test')}</td>
                  <td>{i.reportTatHours ? t('catalogue.hours', { n: i.reportTatHours }) : '—'}</td><td>{money(i.priceMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="ws-dl" aria-label={t('labBooking.payment')}>
          <dt>{t('labBooking.tests')}</dt><dd>{money(b.pricing.subtotalMinor)}</dd>
          {b.pricing.discountMinor > 0 && (
            <>
              <dt>{b.pricing.couponCode ? t('labBooking.couponCode', { code: b.pricing.couponCode }) : t('labBooking.coupon')}</dt>
              <dd>− {money(b.pricing.discountMinor)}</dd>
            </>
          )}
          <dt><strong>{t('labBooking.paidByCustomer')}</strong></dt><dd><strong>{money(b.pricing.payableMinor)}</strong> · {LAB_PAYMENT_STATUS_LABEL[b.paymentStatus] ?? b.paymentStatus}</dd>
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
    if (r.length < MIN_LAB_REASON) errs.reason = t('labBooking.adminCancel.reasonShort', { min: MIN_LAB_REASON });
    else if (r.length > MAX_LAB_REASON) errs.reason = tooLongWords(MAX_LAB_REASON);
    if (!refund) errs.refund = t('labBooking.adminCancel.chooseRefund');
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
      setError(definitelyNotRecorded(err) ? t('labBooking.adminCancel.notCancelled', { reason: stepMessage(err) })
        : t('labBooking.adminCancel.notConfirmed', { reason: messageOf(err) }));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span ref={host} style={FOCUS_HOST_STYLE}>
      {!open ? (
        <div className="ws-actions">
          <Button variant="secondary" disabled={disabled} onClick={() => setOpen(true)}>{t('labBooking.adminCancel.open')}</Button>
          <span className="ws-muted">{t('labBooking.adminCancel.intro')}</span>
        </div>
      ) : (
        <form className="confirm" noValidate onSubmit={review} aria-label={t('labBooking.adminCancel.open')}>
          {!confirming ? (
            <>
              <TextArea label={t('labBooking.adminCancel.reason')} value={reason} maxLength={MAX_LAB_REASON} error={errors.reason} onChange={(e) => setReason(e.target.value)} />
              <fieldset className="ws-checks" aria-describedby={errors.refund ? 'lb-admin-refund-err' : undefined}>
                <legend>{t('labBooking.adminCancel.refund')}</legend>
                <label className="ws-check">
                  <input type="radio" name="lb-admin-refund" checked={refund === 'yes'} onChange={() => setRefund('yes')} /> {t('labBooking.adminCancel.yes', { amount: money(b.pricing.payableMinor) })}
                </label>
                <label className="ws-check">
                  <input type="radio" name="lb-admin-refund" checked={refund === 'no'} onChange={() => setRefund('no')} /> {t('labBooking.adminCancel.no')}
                </label>
                {errors.refund && <span id="lb-admin-refund-err" className="j-field__error">{errors.refund}</span>}
              </fieldset>
            </>
          ) : (
            <div className="confirm-text">
              {refund === 'yes'
                ? t('labBooking.adminCancel.confirmRefund', { name: b.patient.name, slot: slotLabel(b.slot), amount: money(b.pricing.payableMinor) })
                : t('labBooking.adminCancel.confirmNoRefund', { name: b.patient.name, slot: slotLabel(b.slot) })}
            </div>
          )}
          {error && <Alert>{error}</Alert>}
          <div className="confirm-actions">
            {!confirming ? <Button type="submit" disabled={disabled}>{t('common.continue')}</Button>
              : (
                <Button variant="danger" busy={busy} disabled={disabled && !busy} onClick={() => void go()}>
                  {refund === 'yes' ? t('labBooking.adminCancel.withRefund') : t('labBooking.adminCancel.withoutRefund')}
                </Button>
              )}
            <Button variant="ghost" data-focus-back disabled={busy} onClick={() => (confirming ? setConfirming(false) : close())}>{shared('action.back')}</Button>
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
type Step = LabAction | 'reschedule_no_show' | 'desk_cancel';

/** Q14: the no-show this booking was moved after (when, from which slot, to which). */
function NoShowHistory({ booking: b }: { booking: LabBooking }) {
  if (!b.noShows?.length) return null;
  return (
    <ul className="ws-list" aria-label={t('labBooking.noShowHistory')}>
      {b.noShows.map((n, i) => {
        const words = { from: slotLabel(n.fromSlot), to: slotLabel(n.toSlot), date: formatDateTime(n.rescheduledAt) };
        const admin = n.byKind === 'admin';
        return (
          <li key={i}>
            {n.at
              ? t(admin ? 'labBooking.noShowHistory.itemMarkedAdmin' : 'labBooking.noShowHistory.itemMarked', { ...words, marked: formatDateTime(n.at) })
              : t(admin ? 'labBooking.noShowHistory.itemAdmin' : 'labBooking.noShowHistory.item', words)}
          </li>
        );
      })}
    </ul>
  );
}

/** A slot to choose: "Mon, 16 Nov 2026, 09:00–09:30 (2 free)". */
const slotOption = (s: LabSlot) => t('labBooking.slotOption', { day: formatDay(s.date), start: s.startTime, end: s.endTime, free: s.capacity - s.booked });

/** Q14: a later open slot of this branch and visit mode (next two weeks), for the one move of a no-show. */
function LabSlotPicker({ ctx, booking, now, onChoose }: { ctx: ScopeContext; booking: LabBooking; now: Date; onChoose: (t: NoShowTarget | null) => void }) {
  const from = istDateOf(now);
  const to = addDays(from, 13);
  const slots = useQuery({
    queryKey: [...ctx.key, 'slots', booking.branchId, booking.visitMode, from, to],
    queryFn: () => ctx.labs.slots({ branchId: booking.branchId, visitMode: booking.visitMode, from, to }),
  });
  const [slotId, setSlotId] = useState('');
  if (slots.isPending) return <Loading label={t('labBooking.loadingSlots')} />;
  if (slots.isError) return <ErrorState message={messageOf(slots.error)} onRetry={() => void slots.refetch()} />;
  const choices = (slots.data ?? []).filter((s) => isBookable(s, now) && s._id !== booking.slot.slotId);
  if (choices.length === 0) return <p className="ws-muted">{t('labBooking.noOpenSlot')}</p>;
  const byDay = new Map<string, LabSlot[]>();
  for (const s of choices) byDay.set(s.date, [...(byDay.get(s.date) ?? []), s]);
  return (
    <div className="j-field">
      <label htmlFor="lb-noshow-slot">{t('labBooking.newTime')}</label>
      <select id="lb-noshow-slot" value={slotId} onChange={(e) => {
        setSlotId(e.target.value);
        const s = choices.find((x) => x._id === e.target.value);
        onChoose(s ? { slotId: s._id, label: slotLabel(s) } : null);
      }}>
        <option value="">{t('labBooking.chooseSlot')}</option>
        {[...byDay].map(([day, rows]) => (
          <optgroup key={day} label={formatDay(day)}>
            {rows.map((s) => <option key={s._id} value={s._id}>{slotOption(s)}</option>)}
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
      {booking.collector ? t('labBooking.collector.change') : t('labBooking.collector.assign')}
    </Button>
  )}</span>;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const n = (chosen?.name ?? name).trim();
    const p = phone.trim();
    const errs: Record<string, string> = {};
    if (!chosen && !n) errs.name = t('labBooking.collector.errorName');
    else if (n.length > MAX_COLLECTOR_NAME) errs.name = tooLongWords(MAX_COLLECTOR_NAME);
    if (p && !COLLECTOR_PHONE_PATTERN.test(p)) errs.phone = t('labBooking.collector.errorPhone');
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setError(null);
    try {
      await perform('assign', () => ctx.labs.assignCollector(booking._id, { ...(chosen ? { memberId: chosen._id } : {}), name: n, ...(p ? { phone: p } : {}) }, openedOn),
        t('labBooking.collector.done', { name: n }));
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
    <form className="confirm" noValidate onSubmit={(e) => void submit(e)} aria-label={t('labBooking.collector.assign')}>
      {canList && (
        <div className="j-field">
          <label htmlFor="lb-collector">{t('labBooking.collector.who')}</label>
          <select id="lb-collector" value={memberId} onChange={(e) => setMemberId(e.target.value)}>
            <option value="">{t('labBooking.collector.someoneElse')}</option>
            {here.map((m) => <option key={m._id} value={m._id}>{m.name}</option>)}
          </select>
          {members.isError && <span className="j-field__hint">{t('labBooking.collector.staffFailed', { reason: messageOf(members.error) })}</span>}
        </div>
      )}
      <div className="rx-form-row">
        {!chosen && <TextField label={t('labBooking.collector.name')} value={name} maxLength={MAX_COLLECTOR_NAME} error={errors.name} onChange={(e) => setName(e.target.value)} />}
        <TextField label={t('labBooking.collector.phone')} inputMode="numeric" value={phone} maxLength={10} error={errors.phone} onChange={(e) => setPhone(e.target.value)} />
      </div>
      <p className="ws-muted">{t('labBooking.collector.visible')}</p>
      {error && <Alert>{error}</Alert>}
      <div className="confirm-actions">
        <Button type="submit" busy={busy}>{t('labBooking.collector.save')}</Button>
        <Button variant="ghost" data-focus-back disabled={busy} onClick={() => setOpen(false)}>{shared('action.back')}</Button>
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
    <Button variant="secondary" disabled={disabled} onClick={() => { setError(null); setConfirming(false); setOpen(true); }}>{t('labBooking.propose')}</Button>
  )}</span>;

  function form() {
  function review(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!picked) errs.slot = t('labBooking.propose.chooseTime');
    const r = reason.trim();
    if (r.length < MIN_LAB_REASON) errs.reason = t('labBooking.adminCancel.reasonShort', { min: MIN_LAB_REASON });
    else if (r.length > MAX_LAB_REASON) errs.reason = tooLongWords(MAX_LAB_REASON);
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
        t('labBooking.propose.done', { slot: slotLabel(picked) }));
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
    <form className="confirm" noValidate onSubmit={review} aria-label={t('labBooking.propose')}>
      {slots.isPending ? <Loading label={t('labBooking.loadingSlots')} />
        : slots.isError ? <ErrorState message={messageOf(slots.error)} onRetry={() => void slots.refetch()} />
        : choices.length === 0 ? <p className="ws-muted">{t('labBooking.noOpenSlot')}</p>
        : !confirming ? (
          <>
            <div className="j-field">
              <label htmlFor="lb-new-slot">{t('labBooking.newTime')}</label>
              <select id="lb-new-slot" value={slotId} aria-invalid={errors.slot ? true : undefined} aria-describedby={errors.slot ? 'lb-new-slot-err' : undefined}
                onChange={(e) => setSlotId(e.target.value)}>
                <option value="">{t('labBooking.chooseSlot')}</option>
                {[...byDay].map(([day, rows]) => (
                  <optgroup key={day} label={formatDay(day)}>
                    {rows.map((s) => <option key={s._id} value={s._id}>{slotOption(s)}</option>)}
                  </optgroup>
                ))}
              </select>
              {errors.slot && <span id="lb-new-slot-err" className="j-field__error">{errors.slot}</span>}
            </div>
            <TextArea label={t('labBooking.propose.reason')} value={reason} maxLength={MAX_LAB_REASON} error={errors.reason} onChange={(e) => setReason(e.target.value)} />
          </>
        ) : picked && (
          <div className="confirm-text">
            {t(booking.visitMode === 'home' ? 'labBooking.propose.confirmHome' : 'labBooking.propose.confirmLab', { slot: slotLabel(picked), previous: slotLabel(booking.slot) })}
          </div>
        )}
      {error && <Alert>{t('labBooking.propose.failed', { reason: error })}</Alert>}
      <div className="confirm-actions">
        {!confirming ? <Button type="submit" disabled={choices.length === 0}>{t('common.continue')}</Button>
          : <Button busy={busy} onClick={() => void propose()}>{t('labBooking.propose.send')}</Button>}
        <Button variant="ghost" data-focus-back disabled={busy} onClick={() => (confirming ? setConfirming(false) : setOpen(false))}>{shared('action.back')}</Button>
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
      <h2 id="lb-reports-h">{t('labBooking.reports')}</h2>
      <h3>{t('labBooking.reports.released')}</h3>
      {released.length === 0 ? <p className="ws-muted">{t('labBooking.reports.noneReleased')}</p> : (
        <ul className="ws-list" aria-label={t('labBooking.reports.releasedList')}>
          {released.map((f) => {
            const r = releaseOf(booking, f);
            return (
              <li key={f}>
                <div className="ws-actions">
                  <span>
                    {!r ? reportFileName(f) : t(r.signer.kind ? 'labBooking.reports.releasedFileKind' : 'labBooking.reports.releasedFile', {
                      file: reportFileName(f), date: formatDateTime(r.releasedAt), signer: r.signer.name, kind: r.signer.kind ?? '', registration: r.signer.registrationNumber,
                    })}
                  </span>
                  <ViewFileButton viewer={viewer} file={f} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <h3>{t('labBooking.reports.drafts')}</h3>
      {drafts.length === 0 ? <p className="ws-muted">{t('labBooking.reports.noDraft')}</p>
        : !seeDrafts ? <p className="ws-muted">{t('labBooking.reports.draftsWaiting', { count: drafts.length })}</p>
        : (
          <ul className="ws-list" aria-label={t('labBooking.reports.draftList')}>
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
  if (isReportTooLarge(err)) return { text: t('labBooking.upload.tooLarge', { file: name, max: REPORT_MAX_BYTES / 1024 / 1024 }), certain: true };
  // UPLOAD_FAILED: the file service gave up before anything was attached (its files are removed again).
  if (isUploadFailed(err) || definitelyNotRecorded(err)) return { text: t('labBooking.upload.notUploaded', { file: name, reason: stepMessage(err) }), certain: true };
  return {
    text: t('labBooking.upload.unknown', { file: name, reason: messageOf(err) }),
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
      setError(still.length === 0 ? null : [
        ...(found.length ? [t('labBooking.upload.found', { files: found.map((f) => f.file.name).join(', ') })] : []),
        t('labBooking.upload.notFound', { count: still.length, files: still.map((x) => x.file.name).join(', ') }),
      ].join(' '));
      if (still.length === 0 && input.current) input.current.value = '';
    } catch (err) {
      setError(t('labBooking.upload.checkFailed', { reason: messageOf(err) }));
    } finally {
      setChecking(false);
    }
  }

  async function upload(e: FormEvent) {
    e.preventDefault();
    if (items.length === 0) { setError(t('labBooking.upload.chooseFirst')); return; }
    if (problems.length) { setError(problems.join(' ')); return; }
    setBusy(true);
    setError(null);
    let added = items.length - left.length;
    try {
      for (const it of left) {
        const last = added + 1 === items.length;
        try {
          await perform('upload', () => ctx.labs.uploadReport(booking._id, it.file, it.key), last
            ? t('labBooking.upload.allAdded', { count: items.length })
            : t('labBooking.upload.oneAdded', { file: it.file.name }));
        } catch (err) {
          const why = uploadFailureMessage(it.file.name, err);
          setItems((cur) => cur.map((x) => (x.key === it.key ? { ...x, uncertain: !why.certain } : x)));
          setError([...(added ? [t('labBooking.upload.partial', { added, total: items.length })] : []), why.text].join(' '));
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
    <form className="rx-form" noValidate onSubmit={(e) => void upload(e)} aria-label={t('labBooking.upload.form')}>
      <h3>{t('labBooking.upload.form')}</h3>
      <div className="j-field">
        <label htmlFor="lb-files">{t('labBooking.upload.files')}</label>
        <input id="lb-files" ref={input} type="file" multiple accept={REPORT_ACCEPT} aria-describedby={error ? 'lb-files-err' : undefined}
          disabled={locked || busy}
          onChange={(e) => { if (locked) return; setItems([...(e.target.files ?? [])].map((file) => ({ file, key: newRequestKey(), done: false }))); setError(null); }} />
        {locked && (
          <span className="j-field__hint">{t('labBooking.upload.locked')}</span>
        )}
        {problems.length > 0 && <span className="j-field__error">{problems.join(' ')}</span>}
        {items.length > 1 && left.length < items.length && left.length > 0 && (
          <span className="j-field__hint">{t('labBooking.upload.stillToSend', { files: left.map((i) => i.file.name).join(', ') })}</span>
        )}
      </div>
      {error && <div id="lb-files-err"><Alert>{error}</Alert></div>}
      <div className="ws-actions">
        <Button type="submit" busy={busy} disabled={(disabled && !busy) || checking}>{locked || (left.length < items.length && left.length > 0) ? t('labBooking.upload.rest') : t('labBooking.upload.asDrafts')}</Button>
        {locked && <Button variant="secondary" busy={checking} disabled={busy || disabled} onClick={() => void check()}>{t('labBooking.upload.check')}</Button>}
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
        <Button variant="secondary" disabled={disabled} aria-label={t('labBooking.release.name', { file: name })} onClick={() => { setOpenedOn(booking.statusVersion); setOpen(true); }}>{t('labBooking.release')}</Button>
      )}
    </span>
  );

  function panel() {
  let who: string | undefined;
  if (!admin) who = t('labBooking.release.self', { name: user.name });
  else if (signer) who = t('labBooking.release.signer', { name: signer.name, kind: signer.professional!.kind, registration: signer.professional!.registrationNumber });

  return (
    <div className="confirm" role="group" aria-label={t('labBooking.release.name', { file: name })}>
      {admin && (members.isPending ? <Loading label={t('labBooking.release.loadingSigners')} />
        : members.isError ? <ErrorState message={messageOf(members.error)} onRetry={() => void members.refetch()} />
        : signers.length === 0 ? (
          <Alert tone="warn">
            <Parts of={t.rich('labBooking.release.nobody', { staff: <Link to={ctx.link('staff')}>{t('labBooking.release.staffLink')}</Link> })} />
          </Alert>
        ) : (
          <div className="j-field">
            <label htmlFor={`signer-${name}`}>{t('labBooking.release.signedBy')}</label>
            <select id={`signer-${name}`} value={signerId} onChange={(e) => setSignerId(e.target.value)}>
              <option value="">{t('labBooking.release.chooseSigner')}</option>
              {signers.map((m) => <option key={m._id} value={m._id}>{m.name} · {m.professional!.registrationNumber}</option>)}
            </select>
          </div>
        ))}
      {who && (
        <div className="confirm-text">
          {t('labBooking.release.confirm', { file: name, who })}
        </div>
      )}
      <ConfirmLess
        label={t('labBooking.release.name', { file: name })} ready={!!who} blocked={disabled} staffLink={ctx.link('staff')}
        onConfirm={() => perform('release', () => ctx.labs.releaseReport(booking._id, file, admin ? signer?._id : undefined, openedOn),
          t('labBooking.release.done', { file: name }))}
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
        setError(<Parts of={t.rich('labBooking.release.noRegistration', { staff: <Link to={staffLink}>{t('labBooking.release.staffLink')}</Link> })} />);
      } else setError(t('labBooking.release.failed', { reason: stepMessage(err) }));
      if (isLabBookingChanged(err)) onChanged();
    } finally { setBusy(false); }
  }
  return (
    <>
      {error && <Alert>{error}</Alert>}
      <div className="confirm-actions">
        <Button busy={busy} disabled={!ready || (blocked && !busy)} onClick={() => void go()}>{label}</Button>
        <Button variant="ghost" data-focus-back disabled={busy} onClick={onBack}>{shared('action.back')}</Button>
      </div>
    </>
  );
}

function Timeline({ booking: b }: { booking: LabBooking }) {
  const events: { at: string; text: string }[] = [];
  if (b.createdAt) events.push({ at: b.createdAt, text: t('labBooking.timeline.booked') });
  for (const k of LIFECYCLE) {
    const at = b.lifecycle?.[k];
    if (at) events.push({ at, text: t(`labBooking.lifecycle.${k}`) });
  }
  const r = b.reschedule;
  if (r?.at && r.previousSlot) {
    const words = { slot: slotLabel(b.slot), previous: slotLabel(r.previousSlot) };
    events.push({
      at: r.at,
      text: r.reason
        ? t(r.pending ? 'labBooking.timeline.proposedReasonWaiting' : 'labBooking.timeline.proposedReason', { ...words, reason: r.reason })
        : t(r.pending ? 'labBooking.timeline.proposedWaiting' : 'labBooking.timeline.proposed', words),
    });
  }
  for (const x of b.report.releases) {
    events.push({ at: x.releasedAt, text: t('labBooking.timeline.released', { file: reportFileName(x.path), name: x.signer.name, registration: x.signer.registrationNumber }) });
  }
  for (const n of b.noShows ?? []) {
    if (n.at) events.push({ at: n.at, text: t('labBooking.timeline.noShow', { slot: slotLabel(n.fromSlot) }) });
    events.push({ at: n.rescheduledAt, text: t('labBooking.timeline.moved', { slot: slotLabel(n.toSlot) }) });
  }
  events.sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
  return (
    <section className="ws-section" aria-labelledby="lb-time-h">
      <h2 id="lb-time-h">{t('labBooking.timeline')}</h2>
      {events.length === 0 ? <p className="ws-muted">{t('labBooking.timeline.empty')}</p> : (
        <ol className="ws-timeline">
          {events.map((e, i) => <li key={i}><time dateTime={e.at}>{formatDateTime(e.at)}</time><span>{e.text}</span></li>)}
        </ol>
      )}
    </section>
  );
}

/**
 * WQ19 (r12): a booking made at this lab's front desk, paid at the lab. Its bill (`labBookingId`): the number with a link,
 * or "Make bill" (the new-bill form with the booking prefilled; the member enters the account holder's mobile). The desk's
 * own cancel while it is confirmed (`POST /lab-desk/bookings/:id/cancel`, no money moves) with the version it was
 * confirmed on, through the shared owned cancel (check, resend or forget an unconfirmed one).
 */
function DeskParts({ ctx, booking: b, disabled, perform, onNotice, reread, readNow }: {
  ctx: ScopeContext; booking: LabBooking; disabled: boolean; perform: <T>(run: () => Promise<T>) => Promise<T>;
  onNotice: (text: string) => void; reread: () => void; readNow: () => Promise<LabBooking>;
}) {
  const { api, memory } = useSession();
  const desk = labDeskApi(api, ctx.scope);
  const manage = holdsAny(ctx.actor, ['bookings.manage']);
  return (
    <>
      <section className="ws-section" aria-labelledby="lb-bill-h">
        <h2 id="lb-bill-h">{t('labBooking.desk.bill')}</h2>
        <p className="ws-muted">{t('labBooking.desk.billIntro')}</p>
        {b.bill ? (
          <p>
            <Parts of={t.rich('labBooking.desk.billSerial', {
              serial: holdsAny(ctx.actor, BILL_READERS) ? <Link to={`${ctx.link('invoices')}/${b.bill.invoiceId}`}>{b.bill.serial}</Link> : b.bill.serial,
            })} />
            {' · '}{INVOICE_STATE_LABEL[b.bill.state as keyof typeof INVOICE_STATE_LABEL] ?? b.bill.state}
          </p>
        ) : <p>{t('labBooking.desk.noBill')}</p>}
        {canBillDesk(b) && (
          <BillLink ctx={ctx} memory={memory} label={t('labBooking.desk.makeBill')} prefill={{
            link: { kind: 'lab_booking', id: b._id }, branchId: b.branchId, doctorId: '', name: '', phone: '', label: `${b.patient.name}, ${slotLabel(b.slot)}`,
          }} />
        )}
      </section>
      {manage && canDeskCancel(b) && (
        <OwnedCancel<{ reason?: string; expectedVersion: number }, DeskCancelAnswer, LabBooking> slot={`lab-desk-cancel:${scopeIdentity(ctx)}:${b._id}`}
          label={t('labBooking.desk.cancel')} intro={t('labBooking.desk.cancelIntro')} version={b.statusVersion}
          consequence={t(b.slot.walkIn ? 'labBooking.desk.cancelWalkIn' : 'labBooking.desk.cancelSeat', { name: b.patient.name, slot: slotLabel(b.slot) })}
          perform={perform} busy={disabled}
          makeBody={(reason) => ({ ...(reason ? { reason } : {}), expectedVersion: b.statusVersion })}
          send={(body) => desk.cancel(b._id, body)}
          doneWords={(a) => (a.alreadyCancelled ? t('labBooking.desk.alreadyCancelled') : t('labBooking.desk.cancelled'))}
          refusalWords={(err) => deskRefusal(err).message}
          onChanged={reread}
          isCancelled={async () => { const now = await readNow(); return now.status === 'cancelled' ? now : null; }}
          checkedWords={() => t('labBooking.desk.isCancelled')}
          forgetConsequence={t('labBooking.desk.forget')}
          onDone={onNotice} />
      )}
    </>
  );
}
