import { useMemo, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  formatSlotDate, istToday, MAX_TYPED_NAME, pharmacyAssistedApi, pharmacyCustomersApi, rescheduleRefusal, rescheduleRuleText, rescheduleSlots,
  supportedModes, typedNameProblem, typedNameRefusal, type AssistedSlot, type BookedConsultation, type RescheduleAnswer, type TypedNameTarget,
} from '@jansetu/api';
import { Alert, Button, ErrorState, Loading, TextField } from '@jansetu/ui';
import { newRequestKey, startOp, type PendingOp } from '../../requests.ts';
import { useSession } from '../../session.tsx';
import type { Perform } from '../finance/finance.tsx';
import { CheckPanel, useOwnedOp } from './ownedOp.tsx';
import type { ConsultBooker } from './consultBooker.ts';

/** One action on this booking at a time, shared by cancel, change time and correct the name (one guard per page). */
export interface BookingGuard { perform: Perform; busy: boolean }

const SLOT_DAYS = 7;
const whenOf = (date: string | undefined, time: string | undefined) => `${formatSlotDate(date)}${time ? ` at ${time}` : ''}`;
const cleanName = (s: string) => s.trim().replace(/\s+/g, ' ');

// ── Change time (P9: `POST /pharmacy-assisted/bookings/:id/reschedule`) ──

interface PendingMove { bookingId: string; slotId: string; expectedUpdatedAt?: string; from: string; to: string }

/**
 * WQ13: move a booked consultation to another free time of the same doctor (`GET /pharmacy-assisted/doctors/:id/slots`
 * in the booking's own mode), then one keyed reschedule. The server replays the same key and slot (before its version
 * fence), so an unknown outcome is resent unchanged; there is no lookup by key, so a check reads the booking again.
 * WQ24: for a lab member too (`booker`); its doctor read names a branch in the member's scope (r21 requires one; the
 * doctor's times do not depend on it, and the booker view does not say which branch booked).
 */
export function ChangeTime({ booker, booking, guard, onChanged, onDone }: {
  booker: ConsultBooker; booking: BookedConsultation; guard: BookingGuard; onChanged: () => void; onDone: (words: string) => void;
}) {
  const assisted = booker.api;
  const branchId = booker.branches?.[0]?.id;
  const { op, send, settle } = useOwnedOp<PendingMove>(`assisted-reschedule:${booker.id}:${booking._id}`);
  const { perform, busy } = guard;
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(() => istToday());
  const [chosen, setChosen] = useState<AssistedSlot | null>(null);
  const [review, setReview] = useState<({ requestKey: string } & PendingMove) | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);
  const mode = supportedModes([String(booking.consultationMode ?? '')])[0];
  const doctorId = String(booking.specialistId ?? '');

  const slots = useQuery({
    queryKey: [...booker.doctorsKey, 'slots', doctorId, mode ?? '', from],
    queryFn: () => assisted.doctorSlots(doctorId, { ...(branchId ? { branchId } : {}), from, days: SLOT_DAYS, ...(mode ? { mode } : {}) }),
    enabled: open && !!mode,
  });
  const days = useMemo(() => {
    const byDay = new Map<string, AssistedSlot[]>();
    for (const s of rescheduleSlots(slots.data?.slots ?? [], booking)) byDay.set(s.date, [...(byDay.get(s.date) ?? []), s]);
    return [...byDay];
  }, [slots.data, booking]);

  const current = whenOf(booking.bookingDate, booking.bookingTime);
  const doneWords = (a: RescheduleAnswer, chosen: PendingMove) => {
    const now = whenOf(a.booking.bookingDate, a.booking.bookingTime) || chosen.to;
    if (!a.replayed) return `Moved to ${now}. The patient and the doctor are told the new time.`;
    // Review L1: this key moved it earlier, but the booking holds another slot now (moved again since, e.g. on another device).
    const elsewhere = a.booking.slotId && String(a.booking.slotId).toLowerCase() !== chosen.slotId.toLowerCase();
    return elsewhere
      ? `It was moved to your time (${chosen.to}) earlier, and has since been moved again to ${now}.`
      : `It was already moved to ${now}. Nothing was changed twice.`;
  };

  function close() { setOpen(false); setChosen(null); setReview(null); }

  async function sendMove(p: PendingOp<PendingMove>) {
    const r = await perform(() => send(p, (b) => assisted.reschedule(b.bookingId, {
      slotId: b.slotId, requestKey: p.requestKey, ...(b.expectedUpdatedAt ? { expectedUpdatedAt: b.expectedUpdatedAt } : {}),
    })));
    if (r.kind === 'stale') return;
    if (r.kind === 'ok') { close(); onDone(doneWords(r.value, p.body)); onChanged(); return; }
    if (r.kind === 'refused') {
      const why = rescheduleRefusal(r.error);
      setRefused(why.message);
      setReview(null);
      setChosen(null);
      if (why.kind === 'slot') void slots.refetch();
      if (why.kind === 'changed') onChanged();
      if (why.kind === 'late' || why.kind === 'doctor') { setOpen(false); onChanged(); }
    }
  }

  // An unconfirmed move stays on screen while it is resent (its first attempt shows the review busy).
  if (op && !(busy && op.attempts === 1 && !op.uncertain)) {
    const restored = !!op.restored || !op.body;
    return (
      <section className="ws-section" aria-labelledby="move-h">
        <h2 id="move-h">Change time</h2>
        {resendError && <Alert>{resendError}</Alert>}
        <CheckPanel label="Unconfirmed change of time"
          onCheck={async () => {
            const now = await assisted.booking(booking._id);
            const at = whenOf(now.bookingDate, now.bookingTime);
            if (!restored && op.body && String(now.slotId ?? '').toLowerCase() === op.body.slotId.toLowerCase()) {
              settle(op.requestKey);
              close(); // Review L2: the review of the move that is now settled is not left open.
              onDone(`Moved to ${at}. The patient and the doctor are told the new time.`);
              onChanged();
              return null;
            }
            onChanged();
            return restored
              ? `The consultation is now on ${at}. If that is the time you chose, it was moved; if not, it was not moved so far.`
              : `Not moved so far: it is still on ${at}. It may still be on its way. Sending the same request again is safe: it is never moved twice.`;
          }}
          resend={restored ? undefined : {
            label: 'Send the same request again', busy,
            onClick: () => { setResendError(null); void sendMove(op).catch((err: unknown) => setResendError(rescheduleRefusal(err).message)); },
          }}
          forget={{ label: 'Forget it', confirmLabel: 'Yes, forget it', onForget: () => settle(op.requestKey),
            consequence: 'If the earlier request still arrives, the consultation moves to that time. Look at the time shown above before you change it again.' }}>
          <Alert tone="warn">
            {restored
              ? 'A change of time made earlier on this device was not confirmed. Its details are not kept here. Check the time the consultation has now.'
              : `The outcome of this request is not known yet${op.error ? ` (${op.error})` : ''}. The consultation may already be moved to ${op.body.to}. Sending the same request again is safe.`}
          </Alert>
        </CheckPanel>
      </section>
    );
  }

  function pick(e: FormEvent) {
    e.preventDefault();
    if (!chosen) { setRefused('Choose the new time first.'); return; }
    setRefused(null);
    setReview({ requestKey: newRequestKey(), bookingId: booking._id, slotId: chosen.slotId, ...(booking.updatedAt ? { expectedUpdatedAt: booking.updatedAt } : {}),
      from: current, to: whenOf(chosen.date, chosen.startTime) });
  }

  return (
    <section className="ws-section" aria-labelledby="move-h">
      <h2 id="move-h">Change time</h2>
      <p className="ws-muted">{rescheduleRuleText(String(booking.consultationMode ?? ''))}</p>
      {refused && !review && <Alert>{refused}</Alert>}
      {!open ? (
        <div><Button variant="secondary" disabled={busy} onClick={() => { setRefused(null); setOpen(true); }}>Change time</Button></div>
      ) : !mode ? (
        <Alert>This consultation’s way of meeting cannot be booked again here, so its time cannot be changed. You can cancel instead.</Alert>
      ) : (
        <form className="rx-form" noValidate onSubmit={pick} aria-label="Choose the new time">
          <fieldset className="ws-frozen" disabled={!!review || busy}>
            <TextField label="From day" type="date" value={from} min={istToday()} hint={`Free times of ${booking.doctorName ?? 'this doctor'} for ${SLOT_DAYS} days from this day.`}
              onChange={(e) => { if (e.target.value) { setFrom(e.target.value); setChosen(null); } }} />
            <div className="ws-day">
              {slots.isPending ? <Loading label="Finding free times…" />
                : slots.isError ? <ErrorState message={rescheduleRefusal(slots.error).message} onRetry={() => void slots.refetch()} />
                : days.length === 0 ? <span>No other free times from {formatSlotDate(slots.data.from)} to {formatSlotDate(slots.data.to)}. Choose a later day.</span>
                : days.map(([day, times]) => (
                  <fieldset key={day} className="ws-checks">
                    <legend>Free times on {formatSlotDate(day)}</legend>
                    <div className="ws-actions">
                      {times.map((s) => (
                        <Button key={s.slotId} variant={chosen?.slotId === s.slotId ? 'primary' : 'secondary'} aria-pressed={chosen?.slotId === s.slotId}
                          aria-label={`${formatSlotDate(day)} ${s.startTime}${s.endTime ? `–${s.endTime}` : ''}`} onClick={() => setChosen(s)}>
                          {s.startTime}{s.endTime ? `–${s.endTime}` : ''}
                        </Button>
                      ))}
                    </div>
                  </fieldset>
                ))}
            </div>
          </fieldset>
          {!review ? (
            <div className="ws-actions">
              <Button type="submit">Next: check the new time</Button>
              <Button variant="ghost" onClick={close}>Close</Button>
            </div>
          ) : (
            <div className="confirm" role="group" aria-label="Move this consultation">
              <div className="confirm-text">Move the consultation from <strong>{review.from}</strong> to <strong>{review.to}</strong>?</div>
              <span className="ws-muted">Same doctor, same price. Tell the patient the new time.</span>
              <div className="confirm-actions">
                <Button busy={busy} onClick={() => {
                  const { requestKey, ...pending } = review;
                  void sendMove(startOp(requestKey, pending)).catch((err: unknown) => { setReview(null); setRefused(rescheduleRefusal(err).message); });
                }}>Yes, move it</Button>
                <Button variant="ghost" disabled={busy} onClick={() => setReview(null)}>Back</Button>
              </div>
            </div>
          )}
        </form>
      )}
    </section>
  );
}

// ── Correct the name (§17.4: `PUT /pharmacy-customers/:id/typed-name`) ──

interface PendingName { customerId: string; name: string }

/** The name this pharmacy sees for the holder in a (re-read) booking: r6 `holder.name`, else the holder's own booking's `patientName`. */
const holderNameOf = (b: BookedConsultation) => (b.holder ? b.holder.name : b.patientName) ?? null;

/**
 * WQ13: the name this pharmacy typed for the account holder (the phone's owner). It is this pharmacy's own label (its
 * link row): the patient's account never changes. The PUT is idempotent (the same name again changes nothing), so an
 * unknown outcome is simply sent again with the same name. On a family member's booking (r6 `holder`) it is the phone
 * owner's name that is corrected; the family member's own name is not.
 */
export function CorrectName({ pharmacyId, booking, target, guard, onChanged }: {
  pharmacyId: string; booking: BookedConsultation; target: TypedNameTarget; guard: BookingGuard; onChanged: () => void;
}) {
  const { api } = useSession();
  // Review L5: remembered under the link id or the booking id, never the patient's account id.
  const { op, send, settle, live } = useOwnedOp<PendingName>(`typed-name:${pharmacyId}:${target.markerId}`);
  const { perform, busy } = guard;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** The name saved, and the name the pharmacy is shown after it (they differ when the patient chose this pharmacy themselves). */
  const [saved, setSaved] = useState<{ name: string; shown?: string | null } | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);
  const who = target.family ? 'the phone’s owner' : 'this patient';
  const title = target.family ? 'Name of the phone’s owner' : 'Patient’s name';

  async function sendName(p: PendingOp<PendingName>) {
    const r = await perform(() => send(p, (b) => pharmacyCustomersApi(api).setTypedName(b.customerId, b.name)));
    if (r.kind === 'stale') return;
    if (r.kind === 'ok') { setOpen(false); await afterSaved(r.value.typedName || p.body.name, r.value.shownName); return; }
    if (r.kind === 'refused') setError(typedNameRefusal(r.error));
  }

  /**
   * r6 answers `shownName`; before it, the booking is read again to learn what the pharmacy is shown now. Review L3: if
   * that read fails, nothing is claimed about which name is shown (`shown` stays unknown).
   */
  async function afterSaved(name: string, shownName: string | null | undefined) {
    const shown = shownName !== undefined ? shownName
      : await pharmacyAssistedApi(api).booking(booking._id).then(holderNameOf, () => undefined);
    if (!live.current) return;
    setSaved({ name, shown });
    onChanged();
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const why = typedNameProblem(text);
    setError(why);
    if (why) return;
    void sendName(startOp(newRequestKey(), { customerId: target.id, name: cleanName(text) })).catch((err: unknown) => setError(typedNameRefusal(err)));
  }

  if (op && !(busy && op.attempts === 1 && !op.uncertain)) {
    const restored = !!op.restored || !op.body;
    return (
      <section className="ws-section" aria-labelledby="name-h">
        <h2 id="name-h">{title}</h2>
        {resendError && <Alert>{resendError}</Alert>}
        <CheckPanel label="Unconfirmed name change"
          onCheck={async () => {
            // Review L3: compared with the name STORED on the link (`typedName`), not the name shown (a customer-linked
            // patient keeps showing the account name whatever is typed). WQ14 W2: read from the booking (r8 B6
            // `holder.typedName`), one read; an older backend does not say it, so it is not known yet.
            const typed = (await pharmacyAssistedApi(api).booking(booking._id)).holder?.typedName;
            onChanged();
            // WQ14b: a restored change cannot be sent again from here (no body), so that is not offered in words either.
            if (typed !== null && typeof typed !== 'string') return `The outcome of this request is not known yet.${restored ? '' : ' Sending the same name again is safe.'}`;
            if (!restored && op.body && typed === op.body.name) {
              settle(op.requestKey);
              setSaved({ name: op.body.name, shown: undefined });
              return null;
            }
            return restored
              ? `The name your pharmacy typed for ${who} is “${typed ?? '—'}” now. If that is the name you typed, it was saved.`
              : 'Not changed so far. Sending the same name again is safe.';
          }}
          resend={restored ? undefined : {
            label: 'Send the same name again', busy,
            onClick: () => { setResendError(null); void sendName(op).catch((err: unknown) => setResendError(typedNameRefusal(err))); },
          }}
          forget={{ label: 'Forget it', confirmLabel: 'Yes, forget it', onForget: () => settle(op.requestKey),
            consequence: 'If the earlier request still arrives, that name is saved. You can correct the name again from here.' }}>
          <Alert tone="warn">
            {restored
              ? 'A name change made earlier on this device was not confirmed. Check the name shown now.'
              : `The outcome of this request is not known yet${op.error ? ` (${op.error})` : ''}. The name “${op.body.name}” may already be saved.`}
          </Alert>
        </CheckPanel>
      </section>
    );
  }

  return (
    <section className="ws-section" aria-labelledby="name-h">
      <h2 id="name-h">{title}</h2>
      {target.family && <p>Your pharmacy sees the phone’s owner as <strong>{target.name ?? '—'}</strong>.</p>}
      {saved && (
        <Alert tone="ok">
          {saved.shown === undefined
            ? `Saved. The name your pharmacy typed for ${who} is now “${saved.name}”.`
            : saved.shown && saved.shown !== saved.name
              ? `Saved as “${saved.name}”. This patient chose your pharmacy themselves, so your pharmacy is shown the name on their own account (“${saved.shown}”).`
              : `Saved. Your pharmacy now sees ${who} as “${saved.name}”.`}
        </Alert>
      )}
      {!open ? (
        <div className="ws-actions">
          <Button variant="secondary" disabled={busy} onClick={() => { setText(target.name ?? ''); setError(null); setSaved(null); setOpen(true); }}>
            {target.family ? 'Correct the name of the phone’s owner' : 'Correct the name'}
          </Button>
        </div>
      ) : (
        <form className="rx-form" noValidate onSubmit={submit} aria-label="Correct the name">
          <p className="ws-muted">
            This changes only the name your pharmacy sees for {who}. It never changes the patient’s own Jansetu account.
            {target.family ? ' The family member’s name stays as it is.' : ''}
          </p>
          <TextField label={target.family ? 'Name of the phone’s owner, as your pharmacy writes it' : 'Patient’s name as your pharmacy writes it'} autoComplete="off"
            value={text} maxLength={MAX_TYPED_NAME} error={error} disabled={busy} onChange={(e) => setText(e.target.value)} />
          <div className="ws-actions">
            <Button type="submit" busy={busy}>Save the name</Button>
            <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>Close</Button>
          </div>
        </form>
      )}
    </section>
  );
}
