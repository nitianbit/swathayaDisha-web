import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import {
  ADMIN_CANCEL_REFUSAL, adminNoShowMove, ApiError, canAdminCancelMovedNoShow, consultationAdminApi, CONSULTATION_STATUS_LABEL, doctorAdminApi, fromYmd,
  CONSULT_MODE_LABEL, isRealDate, istDateOf, MAX_ADMIN_CANCEL_REASON, MIN_ADMIN_CANCEL_REASON, movableSlot, noShowSlotFits, OBJECT_ID_PATTERN, tooLongWords, type AdminConsultation,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, formatDateTime, formatRupees, Loading, shared, TextArea, TextField } from '@jansetu/ui';
import { FOCUS_HOST_STYLE, usePanelFocus } from '../../components/focus.ts';
import { definitelyNotRecorded } from '../../requests.ts';
import { NoShowMove, noShowMoveSlot, type NoShowTarget } from '../../components/NoShowMove.tsx';
import { messageOf } from '../../errors.ts';
import { t } from '../../i18n/admin/index.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession } from '../../session.tsx';
import { formatYmd, useTicker } from '../doctor/doctor.tsx';
import { useOneAtATime } from '../finance/finance.tsx';
import { formatDay } from '../partner/labs.tsx';
import { useAdminScope } from './adminScope.ts';
import { BookingCloseSection } from './BookingClose.tsx';
import { consultationKind, consultationTone, paymentLabel } from './ConsultationsScreen.tsx';

/** Admin: one consultation booking, its no-show history, the one move of a no-show (Q14, WQ10b), and close and refund (WQ18, S5c). */
export function ConsultationScreen() {
  const { bookingId = '' } = useParams();
  const scope = useAdminScope('consultations');
  if (!OBJECT_ID_PATTERN.test(bookingId)) return <NoSuchConsultation />;
  // One subtree per admin and booking: an open move or picker never follows the admin to another booking.
  return <Consultation key={`${scope.identity}:${bookingId}`} bookingId={bookingId} identity={scope.identity} scopeKey={scope.key} />;
}

function NoSuchConsultation() {
  return (
    <>
      <Link className="ws-back" to="/admin/consultations"><ArrowLeft size={16} aria-hidden="true" /> {t('consultation.back')}</Link>
      <PageHeading title={t('consultation.title')} />
      <Empty title={t('consultation.noSuch')}>{t('consultation.openFromList')}</Empty>
    </>
  );
}

const when = (b: Pick<AdminConsultation, 'bookingDate' | 'bookingTime'>) => `${formatYmd(b.bookingDate)}, ${b.bookingTime}`;

function Consultation({ bookingId, identity, scopeKey }: { bookingId: string; identity: string; scopeKey: readonly string[] }) {
  const { api, memory } = useSession();
  const queryClient = useQueryClient();
  const key = [...scopeKey, 'one', bookingId];
  const q = useQuery({ queryKey: key, queryFn: () => consultationAdminApi(api).get(bookingId) });
  // One move at a time on this page (the central guard): a confirmation already open is refused while another runs.
  const guard = useOneAtATime('consultation');
  const now = useTicker(30_000);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const reread = () => void queryClient.invalidateQueries({ queryKey: scopeKey });
  const b = q.data;
  const slot = noShowMoveSlot(identity, bookingId);
  const move = b ? adminNoShowMove(b) : null;
  // The move is shown while it can be offered or was used, and while a move sent earlier is still unconfirmed.
  const showMove = !!b && (move === 'offer' || move === 'used' || (b.bookingKind !== 'instant' && !b.clinicDesk && !!memory.get(slot)));
  return (
    <>
      <Link className="ws-back" to="/admin/consultations"><ArrowLeft size={16} aria-hidden="true" /> {t('consultation.back')}</Link>
      <PageHeading title={b ? t('consultation.titleOn', { when: when(b) }) : t('consultation.title')}>
        {b?.doctorName ? t('consultation.withDoctor', { doctor: b.doctorName }) : null}
      </PageHeading>
      {notice && <Alert tone="ok">{notice}</Alert>}
      {failure && <Alert>{failure}</Alert>}
      {q.isPending ? <Loading label={t('consultation.loading')} />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : (
          <>
            <section className="ws-section" aria-labelledby="cs-h">
              <h2 id="cs-h">{t('consultation.booking')}</h2>
              <dl className="ws-dl">
                <dt>{t('common.status')}</dt><dd><Badge tone={consultationTone(q.data.status)}>{CONSULTATION_STATUS_LABEL[q.data.status] ?? q.data.status}</Badge></dd>
                <dt>{t('consultation.field.appointment')}</dt><dd>{when(q.data)}</dd>
                <dt>{t('consultation.field.doctor')}</dt><dd>{q.data.doctorName || '—'}</dd>
                <dt>{t('consultation.field.kind')}</dt><dd>{consultationKind(q.data)}</dd>
                <dt>{t('consultation.field.patient')}</dt>
                <dd>
                  {q.data.patientName?.trim()
                    ? <>{q.data.patientName.trim()} <span className="ws-muted">{t(q.data.dependentId ? 'consultation.patient.familyNote' : 'consultation.patient.holderNote')}</span></>
                    : t(q.data.dependentId ? 'consultation.patient.family' : 'consultation.patient.holder')}
                </dd>
                <dt>{t('consultation.field.payment')}</dt><dd>{paymentLabel(q.data)}{typeof q.data.price === 'number' && q.data.paymentStatus === 'paid' ? ` · ${formatRupees(q.data.price)}` : ''}</dd>
                {q.data.cancellationReason && <><dt>{t('consultation.cancellationReason')}</dt><dd>{q.data.cancellationReason}</dd></>}
                {q.data.createdAt && <><dt>{t('consultation.booked')}</dt><dd>{formatDateTime(q.data.createdAt)}</dd></>}
              </dl>
            </section>
            {/* WQ18 (S5c): close and refund a consultation whose doctor is not verified and active. */}
            <BookingCloseSection b={q.data} bookingId={bookingId} scopeKey={scopeKey} perform={guard.perform} busy={guard.busy || q.isFetching}
              readNow={async () => { const fresh = await consultationAdminApi(api).get(bookingId); queryClient.setQueryData(key, fresh); return fresh; }}
              reread={reread} />
            <section className="ws-section" aria-labelledby="ns-h">
              <h2 id="ns-h">{t('consultation.noShow')}</h2>
              <NoShowHistory b={q.data} />
              {q.data.status === 'no_show' && (
                <p className="ws-muted">{t('consultation.noShowRules')}</p>
              )}
              {move === 'instant' && <p className="ws-muted">{t('consultation.instantNeverMoved')}</p>}
              {move === 'clinic' && <p className="ws-muted">{t('consultation.clinicMoves')}</p>}
              {q.data.noShowCancel && q.data.status === 'cancelled' && (
                <p className="ws-muted">
                  {q.data.noShowCancel.at
                    ? t(q.data.noShowCancel.refund ? 'consultation.noShowCancel.refundedAt' : 'consultation.noShowCancel.notRefundedAt',
                      { at: formatDateTime(q.data.noShowCancel.at) })
                    : t(q.data.noShowCancel.refund ? 'consultation.noShowCancel.refunded' : 'consultation.noShowCancel.notRefunded')}
                </p>
              )}
              {canAdminCancelMovedNoShow(q.data) && (
                <AdminCancel key={q.data.updatedAt ?? ''} b={q.data} perform={guard.perform} busy={guard.busy || q.isFetching}
                  cancel={(input) => consultationAdminApi(api).cancelMovedNoShow(bookingId, input)}
                  readNow={async () => { const fresh = await consultationAdminApi(api).get(bookingId); queryClient.setQueryData(key, fresh); return fresh; }}
                  reread={reread}
                  onNotice={(t) => { setFailure(null); setNotice(t); }}
                  onFailure={(t) => { setNotice(null); setFailure(t); }} />
              )}
              {showMove && (
                <NoShowMove slot={slot} who={t('consultation.move.who')} missed={when(q.data)} state={move === 'used' ? 'used' : 'offer'} status={q.data.status}
                  readAt={q.dataUpdatedAt} reading={q.isFetching} disabled={guard.busy || q.isFetching} version={q.data.updatedAt}
                  consequence={t('consultation.move.consequence')}
                  picker={(choose) => <AdminSlotPicker b={q.data} now={now} scopeKey={scopeKey} onChoose={choose} />}
                  send={(t: NoShowTarget, requestKey) => guard.perform(() =>
                    doctorAdminApi(api).rescheduleNoShow(bookingId, t.slotId, requestKey, typeof t.version === 'string' ? t.version : undefined))}
                  reread={reread}
                  onNotice={(t) => { setFailure(null); setNotice(t); }}
                  onFailure={(t) => { setNotice(null); setFailure(t); }}
                  onSlotRefused={() => void queryClient.invalidateQueries({ queryKey: [...scopeKey, 'slots'] })} />
              )}
            </section>
          </>
        )}
    </>
  );
}

/** When it was missed and where it went (the server's scrubbed view: never who marked or moved it). */
function NoShowHistory({ b }: { b: AdminConsultation }) {
  const events: { at: string; text: string }[] = [];
  const moved = b.noShows?.[0];
  if (moved?.at) {
    events.push({ at: moved.at, text: moved.fromDate
      ? t('consultation.history.markedMissed', { when: `${formatYmd(moved.fromDate)}${moved.fromTime ? `, ${moved.fromTime}` : ''}` })
      : t('consultation.history.marked') });
  }
  if (moved?.rescheduledAt) {
    events.push({ at: moved.rescheduledAt, text: b.noShows!.length === 1 ? t('consultation.history.movedNow', { when: when(b) }) : t('consultation.history.moved') });
  }
  if (b.status === 'no_show' && b.noShow?.at) {
    events.push({ at: b.noShow.at, text: t(moved ? 'consultation.history.markedFinal' : 'consultation.history.markedAt', { when: when(b) }) });
  }
  if (events.length === 0) return <p className="ws-muted">{t(b.status === 'no_show' ? 'consultation.history.markedOnly' : 'consultation.history.none')}</p>;
  events.sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
  return (
    <ol className="ws-timeline" aria-label={t('consultation.history.label')}>
      {events.map((e, i) => <li key={i}><time dateTime={e.at}>{formatDateTime(e.at)}</time><span>{e.text}</span></li>)}
    </ol>
  );
}

/** The line above the times offered: where they are, and for which consultation type when it is known. */
const TIMES = { clinic: 'consultation.slot.timesClinic', ownPlace: 'consultation.slot.timesOwnPlace', online: 'consultation.slot.timesOnline' } as const;
const TIMES_FOR = {
  clinic: 'consultation.slot.timesClinicFor', ownPlace: 'consultation.slot.timesOwnPlaceFor', online: 'consultation.slot.timesOnlineFor',
} as const;

/**
 * The booking's own doctor's open, not-yet-started slots on a chosen day, offered for its consultation type
 * (`GET /slots/available`), for the one move of a no-show. In-person bookings move to clinic slots, others to slots without
 * a clinic branch; the server decides finally (SLOT_NOT_AVAILABLE, SLOT_STARTED, SAME_SLOT, and Q15 SLOT_NOT_THIS_DOCTOR
 * when the time belongs to another doctor).
 */
function AdminSlotPicker({ b, now, scopeKey, onChoose }: { b: AdminConsultation; now: Date; scopeKey: readonly string[]; onChoose: (t: NoShowTarget | null) => void }) {
  const { api } = useSession();
  const [day, setDay] = useState(() => istDateOf(now));
  const [slotId, setSlotId] = useState('');
  const ok = isRealDate(day);
  const doctor = b.specialistId && OBJECT_ID_PATTERN.test(b.specialistId) ? b.specialistId : null;
  const slots = useQuery({
    queryKey: [...scopeKey, 'slots', doctor, day, b.consultationMode ?? ''],
    queryFn: () => consultationAdminApi(api).freeSlots(doctor!, day, b.consultationMode),
    enabled: ok && !!doctor,
  });
  if (!doctor) return <p className="ws-muted">{t('consultation.slot.noDoctor')}</p>;
  const inPerson = b.consultationMode === 'in-person';
  // WQ11d: as the doctor's own picker (`noShowSlotFits`): the booking's consultation type and place; each time names it.
  const choices = (slots.data ?? []).filter((s) => s._id !== b.slotId && movableSlot(s, now) && noShowSlotFits(s, b)
    && (!s.specialistId || s.specialistId === doctor));
  const where = (s: { branchId?: string }) => t(!s.branchId ? (inPerson ? 'consultation.slot.ownPlace' : 'consultation.slot.online') : 'consultation.slot.bookedClinic');
  const mode = b.consultationMode ? CONSULT_MODE_LABEL[b.consultationMode] ?? b.consultationMode : null;
  const place = inPerson ? (b.clinicVisit?.branchId ? 'clinic' : 'ownPlace') : 'online';
  return (
    <>
      <p className="ws-muted">
        {mode ? t(TIMES_FOR[place], { mode: mode.toLowerCase() }) : t(TIMES[place])}
      </p>
      <TextField label={t('consultation.slot.newDay')} type="date" value={day} min={istDateOf(now)} error={ok ? undefined : t('consultation.slot.realDate')}
        onChange={(e) => { setDay(e.target.value); setSlotId(''); onChoose(null); }} />
      {!ok ? null
        : slots.isPending ? <Loading label={t('consultation.slot.loading')} />
        : slots.isError ? <ErrorState message={messageOf(slots.error)} onRetry={() => void slots.refetch()} />
        : choices.length === 0 ? (
          <p className="ws-muted">
            {b.doctorName ? t(inPerson ? 'consultation.slot.noneNamedClinic' : 'consultation.slot.noneNamed', { doctor: b.doctorName })
              : t(inPerson ? 'consultation.slot.noneClinic' : 'consultation.slot.none')}
          </p>
        )
        : (
          <div className="j-field">
            <label htmlFor={`admin-noshow-slot-${b._id}`}>{t('consultation.slot.newTime')}</label>
            <select id={`admin-noshow-slot-${b._id}`} value={slotId} onChange={(e) => {
              setSlotId(e.target.value);
              const s = choices.find((x) => x._id === e.target.value);
              const iso = s ? fromYmd(s.date) : null;
              onChoose(s ? { slotId: s._id, label: `${iso ? formatDay(iso) : s.date}, ${s.startTime} (${where(s)})` } : null);
            }}>
              <option value="">{t('consultation.slot.choose')}</option>
              {choices.map((s) => <option key={s._id} value={s._id}>{s.startTime}–{s.endTime} · {where(s)}</option>)}
            </select>
          </div>
        )}
    </>
  );
}

/**
 * Q16a (owner, 22 Nov 2026): "Cancel (admin)" for a booking moved after a no-show that its doctor cannot attend. The
 * admin gives a reason and chooses, explicitly (no default), whether the patient is refunded; the confirmation says what
 * each choice does with the money, and that the patient and the doctor are told. One step at a time on this page; the
 * booking is read again after every answer. A lost answer is settled by reading it: cancelled = done. Q16a final: a
 * repeat of the command is refused 409 ALREADY_CANCELLED (never refunded twice); that is said as "already cancelled,
 * nothing more was done", with how it was cancelled as read now. Keyed by the booking's version, so a confirmation
 * never outlives a change to the booking.
 */
function AdminCancel({ b, perform, busy, cancel, readNow, reread, onNotice, onFailure }: {
  b: AdminConsultation; perform: <T>(run: () => Promise<T>) => Promise<T>; busy: boolean;
  cancel: (input: { reason: string; refund: boolean }) => Promise<AdminConsultation & { refunded?: number }>;
  readNow: () => Promise<AdminConsultation>; reread: () => void; onNotice: (text: string) => void;
  /** Shown by the page: this panel is keyed by the booking's version and may be gone once the booking is read again. */
  onFailure: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [refund, setRefund] = useState<'yes' | 'no' | ''>('');
  const [errors, setErrors] = useState<{ reason?: string; refund?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const host = usePanelFocus<HTMLSpanElement>(open ? 'open' : 'closed');
  const paid = typeof b.price === 'number' && b.paymentStatus === 'paid' ? formatRupees(b.price) : null;
  const done = (refunded: boolean, amount?: number) => (!refunded ? t('consultation.cancel.doneNotRefunded')
    : typeof amount === 'number' && amount > 0 ? t('consultation.cancel.doneRefundedAmount', { amount: formatRupees(amount) })
    : t('consultation.cancel.doneRefunded'));

  async function submit() {
    const r = reason.trim();
    const errs: { reason?: string; refund?: string } = {};
    if (r.length < MIN_ADMIN_CANCEL_REASON) errs.reason = t('consultation.cancel.reasonShort', { min: MIN_ADMIN_CANCEL_REASON });
    else if (r.length > MAX_ADMIN_CANCEL_REASON) errs.reason = tooLongWords(MAX_ADMIN_CANCEL_REASON);
    if (!refund) errs.refund = t('consultation.cancel.chooseRefund');
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const choice = refund === 'yes';
    setError(null);
    setSending(true);
    try {
      await perform(async () => {
        try {
          const after = await cancel({ reason: r, refund: choice });
          onNotice(done(after.noShowCancel ? after.noShowCancel.refund : choice, after.refunded));
          if (live.current) setOpen(false);
        } catch (err) {
          if (err instanceof ApiError && err.code === 'ALREADY_CANCELLED') {
            // An earlier try of this admin (its answer lost) or another admin cancelled it: nothing more was done.
            const now = await readNow().catch(() => null);
            onNotice(t(!now?.noShowCancel ? 'consultation.cancel.already'
              : now.noShowCancel.refund ? 'consultation.cancel.alreadyRefunded' : 'consultation.cancel.alreadyNotRefunded'));
            if (live.current) setOpen(false);
            return;
          }
          if (definitelyNotRecorded(err)) {
            onFailure(t('consultation.cancel.notCancelled', {
              reason: (err instanceof ApiError && err.code && ADMIN_CANCEL_REFUSAL[err.code]) || (err instanceof Error ? err.message : String(err)),
            }));
            if (live.current) setOpen(false);
            return;
          }
          // The answer was lost: the booking as read now tells whether it was cancelled.
          const now = await readNow().catch(() => null);
          if (now?.status === 'cancelled') { onNotice(done(now.noShowCancel ? now.noShowCancel.refund : choice)); if (live.current) setOpen(false); return; }
          onFailure(t('consultation.cancel.notConfirmed', { error: err instanceof Error ? err.message : String(err) }));
        } finally {
          reread();
        }
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (live.current) setSending(false);
    }
  }

  return (
    <span ref={host} style={FOCUS_HOST_STYLE}>
      {!open ? (
        <div className="ws-actions">
          <Button variant="secondary" disabled={busy} onClick={() => { setOpen(true); setError(null); setErrors({}); }}>{t('consultation.cancel.button')}</Button>
          <span className="ws-muted">{t('consultation.cancel.hint')}</span>
        </div>
      ) : (
        <div className="confirm" role="group" aria-label={t('consultation.cancel.button')}>
          <div className="confirm-text">
            {b.doctorName ? t('consultation.cancel.confirmWithDoctor', { when: when(b), doctor: b.doctorName }) : t('consultation.cancel.confirm', { when: when(b) })}
          </div>
          <TextArea label={t('consultation.cancel.reason')} value={reason} maxLength={MAX_ADMIN_CANCEL_REASON} error={errors.reason}
            onChange={(e) => setReason(e.target.value)} />
          <fieldset className="ws-checks" aria-describedby={errors.refund ? 'admin-cancel-refund-err' : undefined}>
            <legend>{t('consultation.cancel.refundQuestion')}</legend>
            <label className="ws-check">
              <input type="radio" name="admin-cancel-refund" checked={refund === 'yes'} onChange={() => setRefund('yes')} />
              {' '}{paid ? t('consultation.cancel.refundYesAmount', { amount: paid }) : t('consultation.cancel.refundYes')}
            </label>
            <label className="ws-check">
              <input type="radio" name="admin-cancel-refund" checked={refund === 'no'} onChange={() => setRefund('no')} />
              {' '}{t('consultation.cancel.refundNo')}
            </label>
            {errors.refund && <span id="admin-cancel-refund-err" className="j-field__error">{errors.refund}</span>}
          </fieldset>
          {error && <Alert>{error}</Alert>}
          <div className="confirm-actions">
            <Button variant="danger" busy={sending} disabled={busy && !sending} onClick={() => void submit()}>{t('consultation.cancel.submit')}</Button>
            <Button variant="ghost" data-focus-back disabled={sending} onClick={() => { setOpen(false); setError(null); }}>{shared('action.back')}</Button>
          </div>
        </div>
      )}
    </span>
  );
}
