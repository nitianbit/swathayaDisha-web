import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import {
  doctorAdminListApi, doctorEligibility, doctorStateRefusal, doctorStateRefusedBeforeWriting, isFenceMismatch, OBJECT_ID_PATTERN, verifyFenceOf,
  type AdminDoctor, type VerifyFence,
} from '@jansetu/api';
import { Alert, ErrorState, Loading, shared } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { messageOf } from '../../errors.ts';
import { t } from '../../i18n/admin/index.ts';
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
  if (!OBJECT_ID_PATTERN.test(doctorId)) return (
    <NoSuchRecord back="/admin/doctors" backLabel={t('common.backToDoctors')} title={t('doctor.title')} missing={t('doctor.noSuch')}>
      {t('doctor.openFromList')}
    </NoSuchRecord>
  );
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
      <Link className="ws-back" to="/admin/doctors"><ArrowLeft size={16} aria-hidden="true" /> {t('common.backToDoctors')}</Link>
      <PageHeading title={d?.name || t('doctor.title')}>{d ? [d.specialization, d.city].filter(Boolean).join(' · ') || null : null}</PageHeading>
      {q.isPending ? <Loading label={t('doctor.loading')} />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : (
          <>
            <VerificationSection d={q.data} doctorId={doctorId} perform={guard.perform} busy={guard.busy || q.isFetching} reread={reread} readNow={readNow} />
            {/* The doctor's open consultations are the Consultations list filtered by doctor and status (closed there, S5c). */}
            <p><Link to={`/admin/doctors/${doctorId}/wallet`}>{t('doctor.wallet')}</Link></p>
            <p>
              {t('doctor.consultationsLead')}{' '}
              <Link to={`/admin/consultations?doctor=${doctorId}&status=pending`}>{t('doctor.waiting')}</Link>{' · '}
              <Link to={`/admin/consultations?doctor=${doctorId}&status=confirmed`}>{t('doctor.confirmed')}</Link>
              {!doctorEligibility(q.data).eligible && <span className="ws-muted"> {t('doctor.cannotAttend')}</span>}
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
    ? t(active ? 'doctor.done.verifiedActive' : 'doctor.done.verifiedInactive', { name: c.name })
    : t('doctor.done.unverified', { name: c.name }));

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
        say('warn', t('doctor.fenceRefused', { name: p.body.name, reason: doctorStateRefusal(r.error) }));
      } else {
        say('error', t('common.notChanged', { reason: doctorStateRefusal(r.error) }));
      }
    }
    void reread();
  }

  if (op && !(busy && op.attempts === 1 && !op.uncertain)) {
    const restored = !!op.restored || !op.body;
    return (
      <section className="ws-section" aria-labelledby="dr-state-h">
        <h2 id="dr-state-h">{t('doctor.verification')}</h2>
        <dl className="ws-dl"><dt>{t('common.status')}</dt><dd><DoctorBadges d={d} /></dd></dl>
        {resendError && <Alert>{resendError}</Alert>}
        <CheckPanel label={t('doctor.unconfirmed')}
          onCheck={async () => {
            const now = await readNow();
            void reread();
            if (restored) {
              return t(now.isVerified === true ? 'doctor.check.restoredVerified' : 'doctor.check.restoredNotVerified', { name: now.name });
            }
            if (holds(now, op.body.to)) {
              settle(op.requestKey);
              say('ok', doneWords(op.body, now.isActive === true));
              return null;
            }
            return t(now.isVerified === true ? 'doctor.check.notYetVerified' : 'doctor.check.notYetNotVerified', { name: now.name });
          }}
          resend={restored ? undefined : {
            label: shared('action.sendAgain'), busy,
            onClick: () => { void change(op).catch((err: unknown) => setResendError(messageOf(err))); },
          }}
          forget={{ label: t('doctor.forget'), confirmLabel: t('doctor.forgetConfirm'), onForget: () => settle(op.requestKey),
            consequence: t('doctor.forgetConsequence') }}>
          <Alert tone="warn">
            {restored
              ? t('doctor.restored')
              : op.error
                ? t(op.body.to === 'verify' ? 'doctor.unknown.verifyError' : 'doctor.unknown.unverifyError', { name: op.body.name, error: op.error })
                : t(op.body.to === 'verify' ? 'doctor.unknown.verify' : 'doctor.unknown.unverify', { name: op.body.name })}
          </Alert>
        </CheckPanel>
      </section>
    );
  }

  const noNumber = !fence.expectedRegistrationNumber;
  return (
    <section className="ws-section" aria-labelledby="dr-state-h">
      <h2 id="dr-state-h">{t('doctor.verification')}</h2>
      {outcome && <Alert tone={outcome.tone}>{outcome.text}</Alert>}
      {mismatch && (
        <div role="group" aria-label={t('doctor.mismatch.label')}>
          <ul className="ws-list">
            <li>{t.rich('doctor.mismatch.reviewed', {
              name: <strong key="name">{mismatch.reviewed.expectedName || t('doctor.mismatch.none')}</strong>,
              number: <strong key="number">{mismatch.reviewed.expectedRegistrationNumber || t('doctor.mismatch.none')}</strong>,
            })}</li>
            {mismatch.now
              ? <li>{t.rich(mismatch.now.isVerified === true ? 'doctor.mismatch.savedVerified' : 'doctor.mismatch.saved', {
                name: <strong key="name">{none(mismatch.now.name)}</strong>,
                number: <strong key="number">{none(mismatch.now.medicalRegistrationNumber)}</strong>,
              })}</li>
              : <li>{t('doctor.mismatch.unread')}</li>}
          </ul>
        </div>
      )}
      <dl className="ws-dl">
        <dt>{t('common.status')}</dt><dd><DoctorBadges d={d} /></dd>
        <dt>{t('common.name')}</dt><dd>{none(d.name)}</dd>
        <dt>{t('doctor.registrationNumber')}</dt><dd>{none(d.medicalRegistrationNumber)}</dd>
        <dt>{t('doctor.speciality')}</dt><dd>{none(d.specialization)}</dd>
        <dt>{t('doctor.degree')}</dt><dd>{none(d.degree)}</dd>
        <dt>{t('doctor.signsInWith')}</dt><dd>{[d.phone, d.email].filter(Boolean).join(' · ') || '—'}</dd>
      </dl>
      {!s.active && <p className="ws-muted">{t('doctor.inactive')}</p>}
      <div className="ws-actions">
        {!s.verified && !fence.expectedName && <p className="ws-muted">{t('doctor.noNameToVerify')}</p>}
        {!s.verified && !!fence.expectedName && (
          <ConfirmAction key="verify" label={t('common.verify')} confirmLabel={t('common.verifyNamed', { name: d.name })} disabled={busy} version={d.updatedAt}
            consequence={(
              <>
                <p>{t.rich('doctor.verify.lead', { name: <strong key="name">{d.name}</strong> })}</p>
                <ul className="ws-list">
                  <li>{t.rich('doctor.verify.name', { name: <strong key="name">{fence.expectedName}</strong> })}</li>
                  <li>{t.rich('doctor.verify.number', { number: <strong key="number">{fence.expectedRegistrationNumber || t('doctor.verify.noneOnRecord')}</strong> })}</li>
                </ul>
                {noNumber && <Alert tone="warn">{t('doctor.verify.noNumber')}</Alert>}
                <p>
                  {s.active ? t('doctor.verify.thenActive') : t('doctor.verify.thenInactive')}
                  {' '}{t('doctor.verify.locked')}
                </p>
              </>
            )}
            onConfirm={() => change(startOp(newRequestKey(), { to: 'verify', name: d.name, fence }))} />
        )}
        {s.verified && (
          <ConfirmAction key="unverify" label={t('doctor.unverify.label')} danger confirmLabel={t('doctor.unverify.confirm', { name: d.name })} disabled={busy} version={d.updatedAt}
            consequence={(
              <>
                <p>{t.rich('doctor.unverify.consequence', { name: <strong key="name">{d.name}</strong> })}</p>
                <p>{t('doctor.unverify.bookings')}</p>
              </>
            )}
            onConfirm={() => change(startOp(newRequestKey(), { to: 'unverify', name: d.name }))} />
        )}
      </div>
    </section>
  );
}
