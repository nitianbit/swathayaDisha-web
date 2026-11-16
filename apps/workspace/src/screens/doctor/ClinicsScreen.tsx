import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  soloPracticeProblems, VERIFICATION_LABEL, type ClinicBranchRef, type MyClinics, type SoloPractice, type SoloPracticeInput,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, Loading, TextField, formatDateTime } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { definitelyNotRecorded } from '../../requests.ts';
import { NotADoctor, useClinics, useDoctor, type DoctorContext } from './doctor.tsx';

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
        Clinics you consult at. A clinic invites you; once you accept, you can put in-person hours at its branches on your schedule and its front
        desk can book patients into them.
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
      <section className="ws-section" aria-labelledby="inv-h">
        <h2 id="inv-h">Invitations</h2>
        {data.invites.length === 0 ? <p className="ws-muted">No invitations waiting.</p> : (
          <ul className="stock-list" aria-label="Invitations">
            {data.invites.map((i) => {
              const name = i.clinic ?? 'A clinic';
              return (
                <li key={i.inviteId} className="doc-offer" aria-label={`Invitation from ${name}`}>
                  <strong>{name}</strong>
                  <span>Branches: {i.branches.length ? branchesText(i.branches) : 'all its in-clinic branches'}{i.createdAt ? ` · invited ${formatDateTime(i.createdAt)}` : ''}</span>
                  <div className="ws-actions">
                    <ConfirmAction label="Accept" confirmLabel={`Join ${name}`}
                      consequence={<>Consult at {name}? Its front desk can then book patients into your in-person hours at these branches, and you sign in to its
                        workspace with your mobile number. You can leave later.</>}
                      onConfirm={() => step(() => d.api.acceptInvite(i.inviteId), `You now consult at ${name}. Add in-person hours there on your schedule.`)} />
                    <ConfirmAction label="Decline" confirmLabel={`Decline ${name}`} danger
                      consequence={<>Decline the invitation from {name}? It closes; the clinic would have to invite you again.</>}
                      onConfirm={() => step(() => d.api.declineInvite(i.inviteId), `You declined the invitation from ${name}.`)} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section className="ws-section" aria-labelledby="mem-h">
        <h2 id="mem-h">Clinics you consult at</h2>
        {data.clinics.length === 0 ? <Empty title="No clinics yet">Accept a clinic’s invitation, or open your own practice below.</Empty> : (
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

// ── Solo practice ──

const practiceKey = (d: DoctorContext) => [...d.key, 'practice'];

function Practice({ d }: { d: DoctorContext }) {
  const q = useQuery({ queryKey: practiceKey(d), queryFn: () => d.api.practice() });
  return (
    <section className="ws-section" aria-labelledby="practice-h">
      <h2 id="practice-h">Your own practice</h2>
      <p className="ws-muted">
        Without a clinic, open a practice of your own: a single-doctor clinic with one branch. Jansetu verifies it before patients can book you there.
        To bill patients and manage it, sign in as “Lab or clinic staff” with the same mobile number (you choose the practice if you belong to several).
      </p>
      {q.isPending ? <Loading label="Loading your practice…" />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : q.data ? <PracticeView practice={q.data} />
        : <PracticeForm d={d} />}
    </section>
  );
}

function PracticeView({ practice }: { practice: SoloPractice }) {
  const state = practice.partner.verification?.state ?? 'pending';
  return (
    <>
      <dl className="ws-dl">
        <dt>Name</dt><dd>{practice.partner.name}</dd>
        <dt>Verification</dt><dd><Badge tone={state === 'verified' ? 'ok' : 'warn'}>{VERIFICATION_LABEL[state] ?? state}</Badge></dd>
        <dt>Branch</dt><dd>{practice.branches.map((b) => `${b.name}${b.address?.city ? `, ${b.address.city}` : ''}`).join('; ') || '—'}</dd>
      </dl>
      {state !== 'verified' && <Alert tone="warn">Jansetu has not verified your practice yet. Until then, in-person hours there cannot be added or booked.</Alert>}
    </>
  );
}

type Form = { name: string; legalName: string; prefix: string; gstin: string; pan: string; branchName: string; branchPhone: string;
  line1: string; line2: string; city: string; state: string; stateCode: string; pincode: string };
const EMPTY: Form = { name: '', legalName: '', prefix: '', gstin: '', pan: '', branchName: '', branchPhone: '', line1: '', line2: '', city: '', state: '', stateCode: '', pincode: '' };
const inputOf = (f: Form): SoloPracticeInput => ({
  name: f.name, legalName: f.legalName, invoiceSeriesPrefix: f.prefix, gstin: f.gstin, pan: f.pan,
  branch: { name: f.branchName, phone: f.branchPhone, address: { line1: f.line1, line2: f.line2, city: f.city, state: f.state, stateCode: f.stateCode, pincode: f.pincode } },
});

function PracticeForm({ d }: { d: DoctorContext }) {
  const queryClient = useQueryClient();
  const [f, setF] = useState<Form>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const field = (k: keyof Form, label: string, extra: { hint?: string; inputMode?: 'numeric' } = {}) => ({
    label, value: f[k], error: errors[k === 'prefix' ? 'invoiceSeriesPrefix' : k], disabled: confirming || busy,
    onChange: (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value })), ...extra,
  });

  function review(e: FormEvent) {
    e.preventDefault();
    setFailure(null);
    const p = soloPracticeProblems(inputOf(f));
    setErrors(p as Record<string, string>);
    if (Object.keys(p).length === 0) setConfirming(true);
  }

  async function create() {
    setBusy(true);
    setFailure(null);
    try {
      const r = await d.api.createPractice(inputOf(f));
      queryClient.setQueryData(practiceKey(d), { partner: r.partner, branches: r.branch ? [r.branch] : [] });
    } catch (err) {
      // One practice per doctor: sending again never makes a second one (the server answers the first), so it is safe.
      setFailure(definitelyNotRecorded(err) ? messageOf(err) : `${messageOf(err)} It may have been opened. If it does not appear here in a moment, send it again: you have only one practice, so it is never made twice.`);
      setConfirming(false);
    } finally {
      setBusy(false);
      void queryClient.invalidateQueries({ queryKey: practiceKey(d) });
      void queryClient.invalidateQueries({ queryKey: [...d.key, 'clinics'] });
    }
  }

  return (
    <form className="rx-form" noValidate onSubmit={review} aria-label="Open your practice">
      <div className="rx-form-row">
        <TextField {...field('name', 'Practice name')} />
        <TextField {...field('legalName', 'Legal name (optional)')} />
        <TextField {...field('prefix', 'Bill number prefix', { hint: '1 to 6 letters or digits, e.g. DRK' })} />
        <TextField {...field('gstin', 'GSTIN (optional)')} />
        <TextField {...field('pan', 'PAN (optional)')} />
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
        <div className="confirm" role="group" aria-label="Open your practice">
          <div className="confirm-text">
            Open “{f.name.trim()}” with one branch, {f.branchName.trim()} in {f.city.trim()}? You can open only one practice; it starts unverified and
            Jansetu verifies it (and its tax details) before patients can book you there. You are its owner.
          </div>
          <div className="confirm-actions">
            <Button busy={busy} onClick={() => void create()}>Open the practice</Button>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>Back</Button>
          </div>
        </div>
      )}
    </form>
  );
}
