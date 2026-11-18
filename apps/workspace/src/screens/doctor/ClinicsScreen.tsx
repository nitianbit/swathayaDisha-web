import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError, doctorClinicProblems, doctorStanding, VERIFICATION_LABEL, type ClinicBranchRef, type DoctorClinicFound, type DoctorClinicInput, type MyClinics, type SoloPractice,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, Loading, TextField, formatDateTime } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { PendingOpPanel } from '../../components/PendingOpPanel.tsx';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { afterFailure, beginAttempt, keyedLookup, newRequestKey, resolveStored, startOp, stillCurrent, type PendingOp } from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { NotADoctor, useClinics, useDoctor, useDoctorProfile, type DoctorContext } from './doctor.tsx';

/** Clinics the doctor consults at, invitations, and the doctor's own solo practice (Q6). */
export function ClinicsScreen() {
  const d = useDoctor();
  if (!d) return <NotADoctor />;
  return <Clinics key={d.identity} d={d} />;
}

const branchesText = (list: readonly ClinicBranchRef[]) =>
  list.length === 0 ? 'no branch taking in-clinic consultations' : list.map((b) => `${b.name}${b.address?.city ? `, ${b.address.city}` : ''}`).join('; ');

function Clinics({ d }: { d: DoctorContext }) {
  const clinics = useClinics(d);
  return (
    <>
      <PageHeading title="Clinics">
        Clinics you consult at. The Jansetu team links you to a clinic after checking; you can then put in-person hours at its branches on your
        schedule and its front desk can book patients into them. You can also create a clinic of your own.
      </PageHeading>
      {clinics.isPending ? <Loading label="Loading your clinics…" />
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
          <h2 id="inv-h">Invitations</h2>
          <p className="ws-muted">Clinics no longer invite doctors: the Jansetu team links doctors to clinics after checking. These invitations can no longer be accepted.</p>
          <ul className="stock-list" aria-label="Invitations">
            {data.invites.map((i) => {
              const name = i.clinic ?? 'A clinic';
              return (
                <li key={i.inviteId} className="doc-offer" aria-label={`Invitation from ${name}`}>
                  <div className="stock-head"><strong>{name}</strong><Badge tone="warn">No longer valid</Badge></div>
                  <span>Branches: {i.branches.length ? branchesText(i.branches) : 'all its in-clinic branches'}{i.createdAt ? ` · invited ${formatDateTime(i.createdAt)}` : ''}</span>
                  <span className="ws-muted">To consult at {name}, ask the Jansetu team to link you.</span>
                  <div className="ws-actions">
                    <ConfirmAction label="Dismiss" confirmLabel={`Dismiss the invitation from ${name}`}
                      consequence={<>Dismiss the invitation from {name}? It is closed as declined.</>}
                      onConfirm={() => step(() => d.api.declineInvite(i.inviteId), `The invitation from ${name} was dismissed.`)} />
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <section className="ws-section" aria-labelledby="mem-h">
        <h2 id="mem-h">Clinics you consult at</h2>
        {data.clinics.length === 0 ? <Empty title="No clinics yet">Ask the Jansetu team to link you to a clinic, or create your own clinic below.</Empty> : (
          <ul className="stock-list" aria-label="Clinics you consult at">
            {data.clinics.map((c) => {
              const name = c.name ?? 'Clinic';
              return (
                <li key={c.partnerId} className="doc-offer" aria-label={name}>
                  <div className="stock-head">
                    <strong>{name}</strong>
                    {c.solo && <Badge>Your practice</Badge>}
                    {c.verified ? <Badge tone="ok">Verified</Badge> : <Badge tone="warn">Waiting for verification</Badge>}
                    <Badge>{c.role === 'owner' ? 'Owner' : 'Doctor'}</Badge>
                  </div>
                  <span>Branches: {branchesText(c.branches)}</span>
                  {!c.verified && <span className="ws-muted">Patients cannot book you here until Jansetu verifies it.</span>}
                  {c.role === 'owner' ? <span className="ws-muted">As its owner you cannot leave it here.</span> : (
                    <div className="ws-actions">
                      <ConfirmAction label="Leave" confirmLabel={`Leave ${name}`} danger
                        consequence={<>Stop consulting at {name}? New bookings there stop at once and your in-person hours there no longer make slots.
                          Appointments already booked are kept.</>}
                        onConfirm={() => step(() => d.api.leaveClinic(c.partnerId), `You no longer consult at ${name}.`)} />
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

const practiceKey = (d: DoctorContext) => [...d.key, 'practice'];
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
      <h2 id="practice-h">Your own clinic</h2>
      <p className="ws-muted">
        Create a clinic of your own with its first branch: you are its owner and consult at every branch of it (also ones added later). It starts
        pending: Jansetu verifies it before patients can book you there. Other doctors join it only when the Jansetu team links them.
      </p>
      {settled && <Alert tone={settled.tone === 'ok' ? 'ok' : undefined}>{settled.text}</Alert>}
      {q.isPending || profile.isPending ? <Loading label="Loading your clinic…" />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : profile.isError ? <ErrorState message={messageOf(profile.error)} onRetry={() => void profile.refetch()} />
        : q.data && !pendingCreate ? <PracticeView practice={q.data} phone={profile.data.phone} />
        : !q.data && !pendingCreate && doctorStanding(profile.data) !== 'active'
          ? <Alert tone="warn">Only active, verified doctors can create a clinic. Once Jansetu has verified your doctor account, you can create it here.</Alert>
        : <ClinicForm d={d} onSettled={setSettled} />}
    </section>
  );
}

function PracticeView({ practice, phone }: { practice: SoloPractice; phone?: string }) {
  const state = practice.partner.verification?.state ?? 'pending';
  return (
    <>
      <dl className="ws-dl">
        <dt>Name</dt><dd>{practice.partner.name}</dd>
        <dt>Verification</dt><dd><Badge tone={state === 'verified' ? 'ok' : 'warn'}>{VERIFICATION_LABEL[state] ?? state}</Badge></dd>
        <dt>Branch</dt><dd>{practice.branches.map((b) => `${b.name}${b.address?.city ? `, ${b.address.city}` : ''}`).join('; ') || '—'}</dd>
      </dl>
      {state !== 'verified' && <Alert tone="warn">Jansetu has not verified your clinic yet. Until then, in-person hours there cannot be added or booked.</Alert>}
      <p>
        Your clinic’s workspace (bills, front desk, staff): sign out, then sign in as “Lab or clinic staff” with your mobile number
        {phone ? ` ${phone}` : ''} and choose {practice.partner.name}.
      </p>
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
      made(attempt, r.replayed || !r.created ? `Your clinic “${r.partner.name}” had already been created: nothing was made twice.` : `Your clinic “${r.partner.name}” was created. Jansetu verifies it next.`);
    } catch (err) {
      reread();
      if (!owns(attempt)) return;
      if (err instanceof ApiError && err.code === 'DOCTOR_CLINIC_EXISTS') {
        store(undefined);
        onSettled({ tone: 'error', text: 'You already have a clinic, so no new one was made. Ask the Jansetu team if you need another.' });
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
      <PendingOpPanel<DoctorClinicInput, DoctorClinicFound & { requestKey: string }> key={op.attempts} label="Unconfirmed clinic" op={op} busy={busy} onResend={() => void send(op)}
        fetchPage={keyedLookup(op.requestKey, () => d.api.myClinicByKey(op.requestKey))}
        onFound={(c) => made(op, `Your clinic “${c.partner.name}” had already been created: nothing was made twice.`)}
        forget={{ label: 'Forget it and start again', confirmLabel: 'Forget the earlier request',
          consequence: 'If the earlier request still arrives, your clinic is created; a new request is then refused because you can have only one, so nothing is made twice.',
          onForget: () => { if (owns(op)) { store(undefined); reread(); onSettled(null); } } }}
        summary={op.restored ? null : <div>Clinic “{op.body.name.trim()}” with its branch {op.body.branch.name.trim()} in {op.body.branch.address.city.trim()}.</div>} />
    );
  }
  return (
    <form className="rx-form" noValidate onSubmit={review} aria-label="Create my clinic">
      <div className="rx-form-row">
        <TextField {...field('name', 'Clinic name')} />
        <TextField {...field('legalName', 'Legal name (optional)')} />
        <TextField {...field('prefix', 'Bill number prefix', { hint: '1 to 6 letters or digits, e.g. DRK' })} />
        <TextField {...field('gstin', 'GSTIN (optional)')} />
        <TextField {...field('pan', 'PAN (optional)')} />
        <TextField {...field('email', 'Contact email (optional)', { inputMode: 'email' })} />
      </div>
      <div className="rx-form-row">
        <TextField {...field('branchName', 'Branch name')} />
        <TextField {...field('branchPhone', 'Branch phone', { inputMode: 'numeric' })} />
        <TextField {...field('line1', 'Address')} />
        <TextField {...field('line2', 'Address line 2 (optional)')} />
        <TextField {...field('city', 'City')} />
        <TextField {...field('state', 'State')} />
        <TextField {...field('stateCode', 'State code', { hint: 'GST state code, e.g. 29' })} />
        <TextField {...field('pincode', 'PIN code', { inputMode: 'numeric' })} />
      </div>
      {failure && <Alert>{failure}</Alert>}
      {!confirming ? (
        <div className="confirm-actions"><Button type="submit">Review</Button></div>
      ) : (
        <div className="confirm" role="group" aria-label="Create my clinic">
          <div className="confirm-text">
            Create “{f.name.trim()}” with its first branch, {f.branchName.trim()} in {f.city.trim()}? You can create only one clinic. It starts pending:
            Jansetu verifies it (and its tax details) before patients can book you there. You are its owner and consult at every branch of it.
          </div>
          <div className="confirm-actions">
            <Button busy={busy} onClick={() => void send(startOp(newRequestKey(), inputOf(f)))}>Create my clinic</Button>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>Back</Button>
          </div>
        </div>
      )}
    </form>
  );
}
