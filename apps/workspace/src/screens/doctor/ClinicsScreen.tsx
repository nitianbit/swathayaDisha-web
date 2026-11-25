import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError, doctorClinicProblems, doctorStanding, VERIFICATION_LABEL, type ClinicBranchRef, type DoctorClinicFound, type DoctorClinicInput, type MyClinics, type SoloPractice,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, Loading, shared, TextField, formatDateTime } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { PendingOpPanel } from '../../components/PendingOpPanel.tsx';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { afterFailure, beginAttempt, keyedLookup, newRequestKey, resolveStored, startOp, stillCurrent, type PendingOp } from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { NotADoctor, useClinics, useDoctor, useDoctorProfile, type DoctorContext } from './doctor.tsx';
import { t } from '../../i18n/doctor/index.ts';

/** Clinics the doctor consults at, invitations, and the doctor's own solo practice (Q6). */
export function ClinicsScreen() {
  const d = useDoctor();
  if (!d) return <NotADoctor />;
  return <Clinics key={d.identity} d={d} />;
}

const branchesText = (list: readonly ClinicBranchRef[]) =>
  list.length === 0 ? t('clinics.noInClinicBranch') : list.map((b) => `${b.name}${b.address?.city ? `, ${b.address.city}` : ''}`).join('; ');

function Clinics({ d }: { d: DoctorContext }) {
  const clinics = useClinics(d);
  return (
    <>
      <PageHeading title={t('clinics.clinics')}>{t('clinics.clinicsYouConsultAtThe')}</PageHeading>
      {clinics.isPending ? <Loading label={t('clinics.loadingYourClinics')} />
        : clinics.isError ? <ErrorState message={messageOf(clinics.error)} onRetry={() => void clinics.refetch()} />
        : <ClinicLists d={d} data={clinics.data} />}
      <Practice d={d} />
    </>
  );
}

function ClinicLists({ d, data }: { d: DoctorContext; data: MyClinics }) {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: [...d.key, 'clinics'] });
    void queryClient.invalidateQueries({ queryKey: [...d.key, 'schedule'] });
  };
  // Every step reloads the lists, whatever the answer: a refusal usually means the invitation or membership changed.
  const step = async (run: () => Promise<unknown>, done: string) => {
    try { await run(); setNotice(done); } finally { refresh(); }
  };
  return (
    <>
      {notice && <Alert tone="ok">{notice}</Alert>}
      {/* Q14: invitations can no longer be accepted (409 INVITE_NO_LONGER_VALID); they can still be dismissed (declined). */}
      {data.invites.length > 0 && (
        <section className="ws-section" aria-labelledby="inv-h">
          <h2 id="inv-h">{t('clinics.invitations')}</h2>
          <p className="ws-muted">{t('clinics.clinicsNoLongerInviteDoctors')}</p>
          <ul className="stock-list" aria-label={t('clinics.invitations')}>
            {data.invites.map((i) => {
              const name = i.clinic ?? t('clinics.aClinic');
              return (
                <li key={i.inviteId} className="doc-offer" aria-label={t('clinics.invitationFrom', { name })}>
                  <div className="stock-head"><strong>{name}</strong><Badge tone="warn">{t('clinics.noLongerValid')}</Badge></div>
                  <span>{t('clinics.branchesFull', { branchesText: i.branches.length ? branchesText(i.branches) : t('clinics.allInClinicBranches') })}{i.createdAt ? ` · ${t('clinics.invitedOn', { date: formatDateTime(i.createdAt) })}` : ''}</span>
                  <span className="ws-muted">{t('clinics.toConsultAtFull', { name })}</span>
                  <div className="ws-actions">
                    <ConfirmAction label={t('clinics.dismiss')} confirmLabel={t('clinics.dismissTheInvitationFrom', { name })}
                      consequence={<>{t('clinics.dismissTheInvitationFromFull', { name })}</>}
                      onConfirm={() => step(() => d.api.declineInvite(i.inviteId), t('clinics.theInvitationFromWasDismissed', { name }))} />
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <section className="ws-section" aria-labelledby="mem-h">
        <h2 id="mem-h">{t('clinics.clinicsYouConsultAt')}</h2>
        {data.clinics.length === 0 ? <Empty title={t('clinics.noClinicsYet')}>{t('clinics.askTheJansetuTeamTo2')}</Empty> : (
          <ul className="stock-list" aria-label={t('clinics.clinicsYouConsultAt')}>
            {data.clinics.map((c) => {
              const name = c.name ?? 'Clinic';
              return (
                <li key={c.partnerId} className="doc-offer" aria-label={name}>
                  <div className="stock-head">
                    <strong>{name}</strong>
                    {c.solo && <Badge>{t('clinics.yourPractice')}</Badge>}
                    {c.verified ? <Badge tone="ok">{t('common.verified')}</Badge> : <Badge tone="warn">{t('common.waitingForVerification')}</Badge>}
                    <Badge>{c.role === 'owner' ? t('clinics.role.owner') : t('clinics.role.doctor')}</Badge>
                  </div>
                  <span>{t('clinics.branchesFull2', { branchesText: branchesText(c.branches) })}</span>
                  {!c.verified && <span className="ws-muted">{t('clinics.patientsCannotBookYouHere')}</span>}
                  {c.role === 'owner' ? <span className="ws-muted">{t('clinics.asItsOwnerYouCannot')}</span> : (
                    <div className="ws-actions">
                      <ConfirmAction label={t('clinics.leave')} confirmLabel={t('clinics.leave2', { name })} danger
                        consequence={<>{t('clinics.stopConsultingAtFull', { name })}</>}
                        onConfirm={() => step(() => d.api.leaveClinic(c.partnerId), t('clinics.youNoLongerConsultAt', { name }))} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}

// ── Q14: the doctor's own clinic ──

/** The doctor's own clinic (also read by Doctor › Bills and › Services and prices: one cache). */
export const practiceKey = (d: DoctorContext) => [...d.key, 'practice'];
type ClinicOp = PendingOp<DoctorClinicInput>;

function Practice({ d }: { d: DoctorContext }) {
  const q = useQuery({ queryKey: practiceKey(d), queryFn: () => d.api.practice() });
  const profile = useDoctorProfile(d);
  const { memory } = useSession();
  const pendingCreate = !!memory.get(clinicSlot(d));
  // What the create form settled with (it outlives the form, which gives way to the clinic once it is read).
  const [settled, setSettled] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  return (
    <section className="ws-section" aria-labelledby="practice-h">
      <h2 id="practice-h">{t('clinics.yourOwnClinic')}</h2>
      <p className="ws-muted">{t('clinics.createAClinicOfYour')}</p>
      {settled && <Alert tone={settled.tone === 'ok' ? 'ok' : undefined}>{settled.text}</Alert>}
      {q.isPending || profile.isPending ? <Loading label={t('clinics.loadingYourClinic')} />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : profile.isError ? <ErrorState message={messageOf(profile.error)} onRetry={() => void profile.refetch()} />
        : q.data && !pendingCreate ? <PracticeView practice={q.data} phone={profile.data.phone} />
        : !q.data && !pendingCreate && doctorStanding(profile.data) !== 'active'
          ? <Alert tone="warn">{t('clinics.onlyActiveVerifiedDoctorsCan')}</Alert>
        : <ClinicForm d={d} onSettled={setSettled} />}
    </section>
  );
}

function PracticeView({ practice, phone }: { practice: SoloPractice; phone?: string }) {
  const state = practice.partner.verification?.state ?? 'pending';
  return (
    <>
      <dl className="ws-dl">
        <dt>{t('clinics.name')}</dt><dd>{practice.partner.name}</dd>
        <dt>{t('common.verification')}</dt><dd><Badge tone={state === 'verified' ? 'ok' : 'warn'}>{VERIFICATION_LABEL[state] ?? state}</Badge></dd>
        <dt>{t('clinics.branch')}</dt><dd>{practice.branches.map((b) => `${b.name}${b.address?.city ? `, ${b.address.city}` : ''}`).join('; ') || '—'}</dd>
      </dl>
      {state === 'suspended' ? <Alert tone="warn">{t('clinics.suspended')}</Alert>
        : state !== 'verified' && <Alert tone="warn">{t('clinics.jansetuHasNotVerifiedYour')}</Alert>}
      <p>{t('clinics.andChooseFull', { value: phone ? ` ${phone}` : '', name: practice.partner.name })}</p>
    </>
  );
}

/** Session-memory slot of the doctor's unconfirmed clinic create (a body-less marker survives a reload). */
const clinicSlot = (d: DoctorContext) => `doctor-clinic:create:${d.identity}`;

type Form = { name: string; legalName: string; prefix: string; gstin: string; pan: string; email: string; branchName: string; branchPhone: string;
  line1: string; line2: string; city: string; state: string; stateCode: string; pincode: string };
const EMPTY: Form = { name: '', legalName: '', prefix: '', gstin: '', pan: '', email: '', branchName: '', branchPhone: '', line1: '', line2: '', city: '', state: '', stateCode: '', pincode: '' };
const inputOf = (f: Form): DoctorClinicInput => ({
  name: f.name, legalName: f.legalName, invoiceSeriesPrefix: f.prefix, gstin: f.gstin, pan: f.pan, contactEmail: f.email,
  branch: { name: f.branchName, phone: f.branchPhone, address: { line1: f.line1, line2: f.line2, city: f.city, state: f.state, stateCode: f.stateCode, pincode: f.pincode } },
});

/**
 * "Create my clinic", once only (Q14 `POST /specialists/me/clinic`): the create is stored with its request key in session
 * memory BEFORE it is sent; a lost answer is sent again unchanged (the same key answers the clinic it made) or looked up
 * by its key (`GET /me/clinic/by-key/:key`). A doctor has one clinic: a second create is refused (409
 * DOCTOR_CLINIC_EXISTS), so forgetting an unconfirmed one can never make two.
 */
function ClinicForm({ d, onSettled }: { d: DoctorContext; onSettled: (s: { tone: 'ok' | 'error'; text: string } | null) => void }) {
  const queryClient = useQueryClient();
  const { memory } = useSession();
  const slot = clinicSlot(d);
  const [op, setOpState] = useState<ClinicOp | undefined>(() => memory.get<ClinicOp>(slot));
  const [f, setF] = useState<Form>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const store = (p: ClinicOp | undefined) => { if (p) memory.set(slot, p); else memory.delete(slot); setOpState(p); };
  const owns = (p: ClinicOp) => live.current && stillCurrent(memory.get<ClinicOp>(slot), p);
  const reread = () => {
    void queryClient.invalidateQueries({ queryKey: practiceKey(d) });
    void queryClient.invalidateQueries({ queryKey: [...d.key, 'clinics'] });
  };
  /** `p` made the clinic (answer, replay or lookup): end it, and only it; the clinic is read again (never taken from the answer). */
  const made = (p: ClinicOp, text: string) => {
    reread();
    if (!owns(p)) return;
    resolveStored(memory, slot, p.requestKey);
    const k = p.requestKey;
    setOpState((c) => (c && c.requestKey !== k ? c : undefined));
    onSettled({ tone: 'ok', text });
  };
  const field = (k: keyof Form, label: string, extra: { hint?: string; inputMode?: 'numeric' | 'email' } = {}) => ({
    label, value: f[k], error: errors[k === 'prefix' ? 'invoiceSeriesPrefix' : k === 'email' ? 'contactEmail' : k], disabled: confirming || busy,
    onChange: (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value })), ...extra,
  });

  function review(e: FormEvent) {
    e.preventDefault();
    setFailure(null);
    const p = doctorClinicProblems(inputOf(f));
    setErrors(p as Record<string, string>);
    if (Object.keys(p).length === 0) setConfirming(true);
  }

  async function send(p: ClinicOp) {
    const attempt = beginAttempt(p);
    store(attempt);
    setBusy(true);
    setFailure(null);
    onSettled(null);
    try {
      const r = await d.api.createMyClinic(attempt.body, attempt.requestKey);
      made(attempt, r.replayed || !r.created ? t('clinics.yourClinicHadAlreadyBeen', { name: r.partner.name }) : t('clinics.yourClinicWasCreatedJansetu', { name: r.partner.name }));
    } catch (err) {
      reread();
      if (!owns(attempt)) return;
      if (err instanceof ApiError && err.code === 'DOCTOR_CLINIC_EXISTS') {
        store(undefined);
        onSettled({ tone: 'error', text: t('clinics.youAlreadyHaveAClinic') });
        return;
      }
      const next = afterFailure(attempt, err, messageOf(err));
      if (live.current) store(next ?? undefined); else if (next) memory.set(slot, next); else memory.delete(slot);
      if (!next) { setFailure(messageOf(err)); setConfirming(false); }
    } finally {
      if (live.current) setBusy(false);
    }
  }

  if (op && !(busy && op.attempts === 1 && !op.uncertain)) {
    return (
      <PendingOpPanel<DoctorClinicInput, DoctorClinicFound & { requestKey: string }> key={op.attempts} label={t('clinics.unconfirmedClinic')} op={op} busy={busy} onResend={() => void send(op)}
        fetchPage={keyedLookup(op.requestKey, () => d.api.myClinicByKey(op.requestKey), ['CLINIC_NOT_FOUND'])}
        onFound={(c) => made(op, t('clinics.yourClinicHadAlreadyBeen', { name: c.partner.name }))}
        forget={{ label: t('clinics.forgetItAndStartAgain'), confirmLabel: t('clinics.forgetTheEarlierRequest'),
          consequence: t('clinics.ifTheEarlierRequestStill'),
          onForget: () => { if (owns(op)) { store(undefined); reread(); onSettled(null); } } }}
        summary={op.restored ? null : <div>{t('clinics.withItsBranchFull', { name: op.body.name.trim(), name2: op.body.branch.name.trim(), city: op.body.branch.address.city.trim() })}</div>} />
    );
  }
  return (
    <form className="rx-form" noValidate onSubmit={review} aria-label={t('clinics.createMyClinic')}>
      <div className="rx-form-row">
        <TextField {...field('name', t('clinics.clinicName'))} />
        <TextField {...field('legalName', t('clinics.legalNameOptional'))} />
        <TextField {...field('prefix', t('clinics.billNumberPrefix'), { hint: t('clinics.n1To6LettersOr') })} />
        <TextField {...field('gstin', 'GSTIN (optional)')} />
        <TextField {...field('pan', 'PAN (optional)')} />
        <TextField {...field('email', t('clinics.contactEmailOptional'), { inputMode: 'email' })} />
      </div>
      <div className="rx-form-row">
        <TextField {...field('branchName', t('clinics.branchName'))} />
        <TextField {...field('branchPhone', t('clinics.branchPhone'), { inputMode: 'numeric' })} />
        <TextField {...field('line1', 'Address')} />
        <TextField {...field('line2', t('clinics.addressLine2Optional'))} />
        <TextField {...field('city', 'City')} />
        <TextField {...field('state', 'State')} />
        <TextField {...field('stateCode', t('clinics.stateCode'), { hint: t('clinics.gstStateCodeEG') })} />
        <TextField {...field('pincode', 'PIN code', { inputMode: 'numeric' })} />
      </div>
      {failure && <Alert>{failure}</Alert>}
      {!confirming ? (
        <div className="confirm-actions"><Button type="submit">{t('common.review')}</Button></div>
      ) : (
        <div className="confirm" role="group" aria-label={t('clinics.createMyClinic')}>
          <div className="confirm-text">{t('clinics.withItsFirstBranchFull', { name: f.name.trim(), branchName: f.branchName.trim(), city: f.city.trim() })}</div>
          <div className="confirm-actions">
            <Button busy={busy} onClick={() => void send(startOp(newRequestKey(), inputOf(f)))}>{t('clinics.createMyClinic')}</Button>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>{shared('action.back')}</Button>
          </div>
        </div>
      )}
    </form>
  );
}
