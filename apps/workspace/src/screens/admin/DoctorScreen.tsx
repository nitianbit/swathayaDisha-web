import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import {
  doctorAdminListApi, doctorEligibility, doctorStateRefusal, doctorStateRefusedBeforeWriting, isFenceMismatch, OBJECT_ID_PATTERN, verifyFenceOf,
  type AdminDoctor, type VerifyFence,
} from '@jansetu/api';
import { Alert, ErrorState, Loading } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { newRequestKey, startOp, type PendingOp } from '../../requests.ts';
import { useSession, useStaff } from '../../session.tsx';
import { useOneAtATime, type Perform } from '../finance/finance.tsx';
import { CheckPanel, useOwnedOp } from '../pharmacy/ownedOp.tsx';
import { NoSuchRecord } from './accountList.tsx';
import { useAdminScope } from './adminScope.ts';
import { DoctorBadges } from './DoctorsScreen.tsx';

/**
 * WQ18 admin: one doctor. Verify (S5: with the reviewed name and registration number as the fence) or take the
 * verification away; links to the doctor's open consultations, each closed with a full refund from its own page (S5c).
 */
export function DoctorScreen() {
  const { doctorId = '' } = useParams();
  const scope = useAdminScope('doctors');
  if (!OBJECT_ID_PATTERN.test(doctorId)) return <NoSuchRecord back="/admin/doctors" backLabel="Back to doctors" title="Doctor">Open it from the doctor list.</NoSuchRecord>;
  // One subtree per admin and doctor: an open confirmation never follows the admin to another doctor.
  return <DoctorDetail key={`${scope.identity}:${doctorId}`} doctorId={doctorId} scopeKey={scope.key} />;
}

const none = (v?: string | null) => (v?.trim() ? v.trim() : '—');

function DoctorDetail({ doctorId, scopeKey }: { doctorId: string; scopeKey: readonly string[] }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const admin = doctorAdminListApi(api);
  const key = [...scopeKey, 'one', doctorId];
  const q = useQuery({ queryKey: key, queryFn: () => admin.get(doctorId) });
  // One change to this doctor at a time (the central guard): a confirmation already open is refused while another runs.
  const guard = useOneAtATime('doctor');
  /** The server's record decides: read again after every answer, also a refusal. */
  const reread = () => queryClient.invalidateQueries({ queryKey: scopeKey });
  /** Reads the doctor now (and shows it): after a fence refusal and to check an unconfirmed change. */
  const readNow = async () => {
    const fresh = await admin.get(doctorId);
    queryClient.setQueryData(key, fresh);
    return fresh;
  };
  const d = q.data;
  return (
    <>
      <Link className="ws-back" to="/admin/doctors"><ArrowLeft size={16} aria-hidden="true" /> Back to doctors</Link>
      <PageHeading title={d?.name || 'Doctor'}>{d ? [d.specialization, d.city].filter(Boolean).join(' · ') || null : null}</PageHeading>
      {q.isPending ? <Loading label="Loading doctor…" />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : (
          <>
            <VerificationSection d={q.data} doctorId={doctorId} perform={guard.perform} busy={guard.busy || q.isFetching} reread={reread} readNow={readNow} />
            {/* The doctor's open consultations are the Consultations list filtered by doctor and status (closed there, S5c). */}
            <p>
              Consultations with this doctor:{' '}
              <Link to={`/admin/consultations?doctor=${doctorId}&status=pending`}>Waiting</Link>{' · '}
              <Link to={`/admin/consultations?doctor=${doctorId}&status=confirmed`}>Confirmed</Link>
              {!doctorEligibility(q.data).eligible && <span className="ws-muted"> (this doctor cannot attend them: open one to close it with a full refund)</span>}
            </p>
          </>
        )}
    </>
  );
}

/** A verify or unverify kept until its answer is known; `fence` = the values reviewed (verify only). */
interface StateChange { to: 'verify' | 'unverify'; name: string; fence?: VerifyFence }

/**
 * Verify or unverify, confirmed first, sent with an owned PendingOp (stored before sending; an answer settles it only
 * while this page is on screen and the attempt still owns it). A verify names the name and registration number the
 * admin saw in its confirmation (the fence); if either changed meanwhile the server refuses 409
 * SPECIALIST_CHANGED_SINCE_REVIEW: the doctor is read again and what was reviewed is shown next to what is saved now.
 * A lost answer is checked by reading the doctor (both changes only set `isVerified`, so the doctor as saved tells whether
 * it went through), or sent again unchanged (setting the same state twice changes nothing more).
 */
function VerificationSection({ d, doctorId, perform, busy, reread, readNow }: {
  d: AdminDoctor; doctorId: string; perform: Perform; busy: boolean; reread: () => Promise<void>; readNow: () => Promise<AdminDoctor>;
}) {
  const { api } = useSession();
  const admin = useStaff();
  const doctors = doctorAdminListApi(api);
  const { op, send, settle } = useOwnedOp<StateChange>(`admin-doctor-state:${admin.id}:${doctorId}`);
  const [outcome, setOutcome] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);
  const [mismatch, setMismatch] = useState<{ reviewed: VerifyFence; now: AdminDoctor | null } | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const say = (tone: 'ok' | 'warn' | 'error', text: string) => { if (live.current) setOutcome({ tone, text }); };
  const s = doctorEligibility(d);
  const fence = verifyFenceOf(d);
  const holds = (now: AdminDoctor, to: StateChange['to']) => (to === 'verify' ? now.isVerified === true : now.isVerified !== true);
  const doneWords = (c: StateChange, active: boolean) => (c.to === 'verify'
    ? `${c.name} is verified.${active ? ' Patients can now find and book them.' : ' They are inactive, so patients still cannot book them.'}`
    : `${c.name} is no longer verified: patients cannot find or book them, and they cannot take consultations or prescribe.`);

  async function change(p: PendingOp<StateChange>) {
    setOutcome(null);
    setMismatch(null);
    setResendError(null);
    const sole = p.attempts === 0 && !p.uncertain;
    const r = await perform(() => send(p, (b) => (b.to === 'verify' ? doctors.verify(doctorId, b.fence!) : doctors.unverify(doctorId))));
    if (r.kind === 'stale') return;
    if (r.kind === 'ok') { say('ok', doneWords(p.body, r.value?.isActive === true)); void reread(); return; }
    // Settled as refused: the sole first attempt refused; the verification audit's collection check (503 INDEXES_OUTDATED),
    // which runs before anything is written, on a sole first attempt; or a fence mismatch on any attempt (the server checks
    // the fence only while the doctor is not verified, so this request has not verified them, and the identity it carries
    // no longer matches: no attempt of it can).
    const refusedFirst = r.kind === 'refused' || (r.kind === 'unknown' && ((sole && doctorStateRefusedBeforeWriting(r.error)) || isFenceMismatch(r.error)));
    if (refusedFirst) {
      if (r.kind === 'unknown') settle(p.requestKey);
      if (isFenceMismatch(r.error) && p.body.fence) {
        const now = await readNow().catch(() => null);
        if (live.current) setMismatch({ reviewed: p.body.fence, now });
        say('warn', `${p.body.name} was not verified: ${doctorStateRefusal(r.error)} The doctor was read again: review what is saved now before verifying.`);
      } else {
        say('error', `Not changed: ${doctorStateRefusal(r.error)}`);
      }
    }
    void reread();
  }

  if (op && !(busy && op.attempts === 1 && !op.uncertain)) {
    const restored = !!op.restored || !op.body;
    return (
      <section className="ws-section" aria-labelledby="dr-state-h">
        <h2 id="dr-state-h">Verification</h2>
        <dl className="ws-dl"><dt>Status</dt><dd><DoctorBadges d={d} /></dd></dl>
        {resendError && <Alert>{resendError}</Alert>}
        <CheckPanel label="Unconfirmed change"
          onCheck={async () => {
            const now = await readNow();
            void reread();
            if (restored) {
              return `Read again: ${now.name} is ${now.isVerified === true ? 'verified' : 'not verified'} now. The earlier change is not kept on this device, so whether it went through cannot be told. If this is not what you wanted, forget it and make the change again.`;
            }
            if (holds(now, op.body.to)) {
              settle(op.requestKey);
              say('ok', doneWords(op.body, now.isActive === true));
              return null;
            }
            return `Not changed so far: ${now.name} is ${now.isVerified === true ? 'verified' : 'not verified'} now. It may still be on its way. Sending the same request again is safe.`;
          }}
          resend={restored ? undefined : {
            label: 'Send the same request again', busy,
            onClick: () => { void change(op).catch((err: unknown) => setResendError(messageOf(err))); },
          }}
          forget={{ label: 'Forget it', confirmLabel: 'Yes, forget it', onForget: () => settle(op.requestKey),
            consequence: 'The change may already have gone through, or may still go through. Forgetting it does not undo that. The status shown is what is saved now.' }}>
          <Alert tone="warn">
            {restored
              ? 'A verification change made earlier on this device (before the page was reloaded) was not confirmed. Its details are not kept here. Check the doctor’s status.'
              : `The outcome of this request is not known yet${op.error ? ` (${op.error})` : ''}: ${op.body.to === 'verify' ? `verify ${op.body.name}` : `take ${op.body.name}’s verification away`}. Sending the same request again is safe.`}
          </Alert>
        </CheckPanel>
      </section>
    );
  }

  const noNumber = !fence.expectedRegistrationNumber;
  return (
    <section className="ws-section" aria-labelledby="dr-state-h">
      <h2 id="dr-state-h">Verification</h2>
      {outcome && <Alert tone={outcome.tone}>{outcome.text}</Alert>}
      {mismatch && (
        <div role="group" aria-label="What changed">
          <ul className="ws-list">
            <li>You reviewed: name <strong>{mismatch.reviewed.expectedName || '(none)'}</strong>, registration number <strong>{mismatch.reviewed.expectedRegistrationNumber || '(none)'}</strong>.</li>
            {mismatch.now
              ? <li>Saved now: name <strong>{none(mismatch.now.name)}</strong>, registration number <strong>{none(mismatch.now.medicalRegistrationNumber)}</strong>{mismatch.now.isVerified === true ? ' (and the doctor is verified now)' : ''}.</li>
              : <li>The doctor could not be read again: use Try again below or reload the page before verifying.</li>}
          </ul>
        </div>
      )}
      <dl className="ws-dl">
        <dt>Status</dt><dd><DoctorBadges d={d} /></dd>
        <dt>Name</dt><dd>{none(d.name)}</dd>
        <dt>Registration number</dt><dd>{none(d.medicalRegistrationNumber)}</dd>
        <dt>Speciality</dt><dd>{none(d.specialization)}</dd>
        <dt>Degree</dt><dd>{none(d.degree)}</dd>
        <dt>Signs in with</dt><dd>{[d.phone, d.email].filter(Boolean).join(' · ') || '—'}</dd>
      </dl>
      {!s.active && <p className="ws-muted">This doctor is inactive: patients cannot book them even when verified. Making a doctor active again is not done here.</p>}
      <div className="ws-actions">
        {!s.verified && !fence.expectedName && <p className="ws-muted">No name is on record, so this doctor cannot be verified until they add one.</p>}
        {!s.verified && !!fence.expectedName && (
          <ConfirmAction key="verify" label="Verify" confirmLabel={`Verify ${d.name}`} disabled={busy} version={d.updatedAt}
            consequence={(
              <>
                <p>Verify <strong>{d.name}</strong> with exactly what you reviewed:</p>
                <ul className="ws-list">
                  <li>Name: <strong>{fence.expectedName}</strong></li>
                  <li>Registration number: <strong>{fence.expectedRegistrationNumber || 'none on record'}</strong></li>
                </ul>
                {noNumber && <Alert tone="warn">No medical registration number is on record for this doctor.</Alert>}
                <p>
                  {s.active ? 'Patients can then find and book them; they can open times, take consultations and prescribe.' : 'They are inactive, so patients still cannot book them until they are active.'}
                  {' '}After verification only the Jansetu team can change their name, registration number, speciality, degree, mobile number and email.
                  If the name or registration number changes before you confirm, nothing is verified.
                </p>
              </>
            )}
            onConfirm={() => change(startOp(newRequestKey(), { to: 'verify', name: d.name, fence }))} />
        )}
        {s.verified && (
          <ConfirmAction key="unverify" label="Unverify" danger confirmLabel={`Unverify ${d.name}`} disabled={busy} version={d.updatedAt}
            consequence={(
              <>
                <p><strong>{d.name}</strong> is no longer verified: patients cannot find or book them, and they cannot open times, take consultations or prescribe. They no longer see their patients’ contact details.</p>
                <p>Their bookings stay as they are. Close each open one with a full refund from its consultation page (linked below).</p>
              </>
            )}
            onConfirm={() => change(startOp(newRequestKey(), { to: 'unverify', name: d.name }))} />
        )}
      </div>
    </section>
  );
}
