import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError, clinicBranchesFor, DOCTOR_INVITE_STATE_LABEL, DOCTOR_INVITE_STATES, hasGlobalScope, holdsAny, inviteProblems,
  type DoctorInvite, type DoctorInviteState, type InviteResult,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, formatDateTime, formatRupees, Loading, TextField } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { messageOf } from '../../errors.ts';
import { ClinicOnly, clinicLink, useClinicApi, useDoctorList, type ClinicApi } from './clinic.tsx';
import {
  branchLabel, NoSuchPartner, PartnerPageHeading, scopeIdentity, useBranches, usePartnerScope, useWorkspacePartner, type ScopeContext,
} from './scope.tsx';

/** The clinic's consulting doctors, and (with `staff.manage`) the invitations that bring a doctor in. */
export function ClinicDoctorsScreen() {
  const ctx = usePartnerScope();
  if (!ctx) return <NoSuchPartner />;
  // One subtree per partner: an open invitation form or revoke confirmation never carries over to another partner.
  return <ClinicDoctors key={scopeIdentity(ctx)} ctx={ctx} />;
}

function ClinicDoctors({ ctx }: { ctx: ScopeContext }) {
  const partner = useWorkspacePartner(ctx);
  const clinic = useClinicApi(ctx);
  const manage = holdsAny(ctx.actor, ['staff.manage']);
  return (
    <>
      <PartnerPageHeading ctx={ctx} title="Doctors" partnerName={partner.data?.name}>
        A doctor consults here only after accepting your invitation in their own Jansetu doctor app. Until then they cannot be
        booked at the <a href={`#${clinicLink(ctx, 'desk')}`}>front desk</a>.
      </PartnerPageHeading>
      <ClinicOnly ctx={ctx}>
        <DoctorList ctx={ctx} clinic={clinic} />
        {manage ? <Invitations ctx={ctx} clinic={clinic} /> : (
          <p className="ws-muted">Invitations are sent and revoked by staff with the “Manage staff” permission.</p>
        )}
      </ClinicOnly>
    </>
  );
}

function DoctorList({ ctx, clinic }: { ctx: ScopeContext; clinic: ClinicApi }) {
  const doctors = useDoctorList(ctx, clinic);
  const branches = useBranches(ctx);
  const names = useMemo(() => new Map((branches.data ?? []).map((b) => [b._id, b.name])), [branches.data]);
  const rows = doctors.data ?? [];
  return (
    <section className="ws-section" aria-labelledby="cd-list-h">
      <h2 id="cd-list-h">Consulting doctors</h2>
      {doctors.isPending ? <Loading label="Loading doctors…" />
        : doctors.isError ? <ErrorState message={messageOf(doctors.error)} onRetry={() => void doctors.refetch()} />
        : rows.length === 0 ? (
          <Empty title="No doctors yet">
            {holdsAny(ctx.actor, ['staff.manage']) ? 'Invite a doctor below. They appear here once they accept in their app.' : 'No doctor consults here yet.'}
          </Empty>
        ) : (
          <div className="ws-table-wrap">
            <table className="j-table">
              <caption className="j-sr-only">Doctors consulting at this clinic</caption>
              <thead><tr><th scope="col">Doctor</th><th scope="col">Speciality</th><th scope="col">Consults at</th><th scope="col">Fee</th><th scope="col">Status</th></tr></thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.memberId}>
                    <td>{d.name}{d.role === 'owner' ? ' (owner)' : ''}</td>
                    <td>{d.specialization || '—'}</td>
                    <td>{branchLabel(names, d.branchIds)}</td>
                    <td>{d.consultationFee ? formatRupees(d.consultationFee) : '—'}</td>
                    <td>
                      {d.active ? <Badge tone="ok">Can be booked</Badge> : (
                        <><Badge tone="warn">Not bookable</Badge> <span className="ws-muted">Their Jansetu doctor account is inactive or not verified.</span></>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      <p className="ws-muted">A doctor stops consulting here by leaving the clinic in their own app.</p>
    </section>
  );
}

/** Names learnt from invitation answers (the invitation list carries only the doctor's id). Kept in memory, per partner. */
function useInvitedNames(ctx: ScopeContext) {
  const queryClient = useQueryClient();
  const key = [...ctx.key, 'clinic-invite-names'];
  const names = useQuery({ queryKey: key, queryFn: () => new Map<string, string>(), staleTime: Infinity, gcTime: Infinity }).data;
  const remember = (doctorId: string, name?: string) => {
    if (!name) return;
    queryClient.setQueryData<Map<string, string>>(key, (old) => new Map(old ?? []).set(doctorId, name));
  };
  return { names: names ?? new Map<string, string>(), remember };
}

function Invitations({ ctx, clinic }: { ctx: ScopeContext; clinic: ClinicApi }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<'' | DoctorInviteState>('pending');
  const invites = useQuery({ queryKey: [...ctx.key, 'clinic-invites', state || 'all'], queryFn: () => clinic.invites(state || undefined) });
  const doctors = useDoctorList(ctx, clinic);
  const branches = useBranches(ctx);
  const branchNames = useMemo(() => new Map((branches.data ?? []).map((b) => [b._id, b.name])), [branches.data]);
  const invited = useInvitedNames(ctx);
  const doctorName = (id: string) => doctors.data?.find((d) => d.doctorId === id)?.name ?? invited.names.get(id);
  const [notice, setNotice] = useState<string | null>(null);
  const revoking = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const rows = invites.data ?? [];

  async function revoke(inv: DoctorInvite) {
    // One revoke per invitation at a time, even from a confirmation that was already open.
    if (revoking.current.has(inv._id)) throw new ApiError(409, 'This invitation is already being revoked.', 'STEP_IN_FLIGHT');
    revoking.current.add(inv._id);
    try {
      await clinic.revokeInvite(inv._id);
      if (mounted.current) setNotice(`The invitation to ${doctorName(inv.doctorId) ?? 'the doctor'} was revoked. They can no longer accept it.`);
    } finally {
      revoking.current.delete(inv._id);
      // Revoked or refused (e.g. already accepted meanwhile): the list shows the server's current state either way.
      void queryClient.invalidateQueries({ queryKey: [...ctx.key, 'clinic-invites'] });
      void queryClient.invalidateQueries({ queryKey: [...ctx.key, 'clinic-doctors'] });
    }
  }

  return (
    <>
      <section className="ws-section" aria-labelledby="cd-inv-h">
        <h2 id="cd-inv-h">Invitations</h2>
        {notice && <Alert tone="ok">{notice}</Alert>}
        <div className="ws-search">
          <div className="j-field ws-filter">
            <label htmlFor="cd-state">Show</label>
            <select id="cd-state" value={state} onChange={(e) => { setState(e.target.value as '' | DoctorInviteState); setNotice(null); }}>
              {DOCTOR_INVITE_STATES.map((s) => <option key={s} value={s}>{DOCTOR_INVITE_STATE_LABEL[s]}</option>)}
              <option value="">All invitations</option>
            </select>
          </div>
        </div>
        {invites.isPending ? <Loading label="Loading invitations…" />
          : invites.isError ? <ErrorState message={messageOf(invites.error)} onRetry={() => void invites.refetch()} />
          : rows.length === 0 ? <Empty title="No invitations">{state === 'pending' ? 'No invitation is waiting for a doctor’s answer.' : 'None to show.'}</Empty>
          : (
            <>
              {rows.length >= 200 && <p className="ws-count">The newest 200 invitations.</p>}
              <div className="ws-table-wrap">
                <table className="j-table">
                  <caption className="j-sr-only">Invitations to doctors</caption>
                  <thead><tr><th scope="col">Doctor</th><th scope="col">Branches</th><th scope="col">Sent</th><th scope="col">State</th><th scope="col">Action</th></tr></thead>
                  <tbody>
                    {rows.map((inv) => {
                      const name = doctorName(inv.doctorId);
                      const who = name ?? `Doctor …${inv.doctorId.slice(-6)}`;
                      return (
                        <tr key={inv._id}>
                          <td>{who}{!name && <div className="ws-muted">The name shows here once they accept.</div>}</td>
                          <td>{branchLabel(branchNames, inv.branchIds)}</td>
                          <td>{formatDateTime(inv.createdAt)}</td>
                          <td>
                            <Badge tone={inv.state === 'accepted' ? 'ok' : inv.state === 'pending' ? 'warn' : 'danger'}>{DOCTOR_INVITE_STATE_LABEL[inv.state] ?? inv.state}</Badge>
                            {inv.respondedAt && <div className="ws-muted">{formatDateTime(inv.respondedAt)}</div>}
                          </td>
                          <td>
                            {inv.state === 'pending' ? (
                              <ConfirmAction label={`Revoke invitation to ${who}`} danger confirmLabel="Revoke invitation"
                                consequence={<>Revoke the invitation to {who}? They can no longer accept it. You can invite them again later.</>}
                                onConfirm={() => revoke(inv)} />
                            ) : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
      </section>
      <InviteForm ctx={ctx} clinic={clinic} onInvited={(r) => invited.remember(r.doctor.doctorId, r.doctor.name)} />
    </>
  );
}

function InviteForm({ ctx, clinic, onInvited }: { ctx: ScopeContext; clinic: ClinicApi; onInvited: (r: InviteResult) => void }) {
  const queryClient = useQueryClient();
  const branches = useBranches(ctx);
  const offered = clinicBranchesFor(branches.data ?? [], ctx.actor);
  const names = useMemo(() => new Map((branches.data ?? []).map((b) => [b._id, b.name])), [branches.data]);
  const wide = hasGlobalScope(ctx.actor);
  const [by, setBy] = useState<'phone' | 'doctorId'>('phone');
  const [value, setValue] = useState('');
  const [all, setAll] = useState(wide);
  const [chosen, setChosen] = useState<string[]>([]);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const branchIds = all ? [] : chosen;
  const problems = inviteProblems({ by, value, branchIds }, ctx.actor);
  const shown = tried ? problems : {};
  const noneChosen = !all && chosen.length === 0 && wide;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    setResult(null);
    if (Object.keys(problems).length || noneChosen) return;
    setBusy(true);
    setError(null);
    try {
      const r = await clinic.invite(by === 'phone' ? { phone: value.trim(), branchIds } : { doctorId: value.trim().toLowerCase(), branchIds });
      onInvited(r);
      void queryClient.invalidateQueries({ queryKey: [...ctx.key, 'clinic-invites'] });
      if (!mounted.current) return;
      const who = r.doctor.name ?? 'The doctor';
      setResult(r.created
        ? `Invitation sent to ${who}${r.doctor.specialization ? ` (${r.doctor.specialization})` : ''}. They accept it in their Jansetu doctor app; until then they cannot be booked here.`
        : `${who} already had a pending invitation from this clinic (consults at: ${branchLabel(names, r.invite.branchIds)}). Nothing new was sent; revoke it first to invite them for other branches.`);
      setValue('');
      setChosen([]);
      setAll(wide);
      setTried(false);
    } catch (err) {
      if (mounted.current) setError(messageOf(err));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <section className="ws-section" aria-labelledby="cd-new-h">
      <h2 id="cd-new-h">Invite a doctor</h2>
      <p className="ws-muted">
        The doctor must already be registered and verified with Jansetu. They get the invitation in their doctor app and
        decide there. If the answer to sending it is lost, sending it again is safe: a doctor has at most one pending
        invitation from this clinic.
      </p>
      {result && <Alert tone="ok">{result}</Alert>}
      {branches.isPending ? <Loading label="Loading branches…" />
        : branches.isError ? <ErrorState message={messageOf(branches.error)} onRetry={() => void branches.refetch()} />
        : offered.length === 0 ? (
          <Empty title="No branch for consultations">
            A doctor consults at a branch that takes in-clinic consultations. {wide ? 'Turn that on for a branch under Branches first.' : 'None of your branches takes them.'}
          </Empty>
        ) : (
          <form className="rx-form" noValidate onSubmit={(e) => void submit(e)} aria-label="Invite a doctor">
            <fieldset className="ws-checks" disabled={busy}>
              <legend>Find the doctor by</legend>
              <label className="ws-check"><input type="radio" name="cd-by" checked={by === 'phone'} onChange={() => { setBy('phone'); setValue(''); }} /> Mobile number registered with Jansetu</label>
              <label className="ws-check"><input type="radio" name="cd-by" checked={by === 'doctorId'} onChange={() => { setBy('doctorId'); setValue(''); }} /> Jansetu doctor id</label>
            </fieldset>
            <fieldset className="ws-frozen" disabled={busy}>
              <div className="rx-form-row">
                {by === 'phone'
                  ? <TextField label="Doctor’s mobile number" inputMode="tel" value={value} error={shown.value} onChange={(e) => setValue(e.target.value)} />
                  : <TextField label="Doctor id" value={value} maxLength={24} error={shown.value} onChange={(e) => setValue(e.target.value)} />}
              </div>
            </fieldset>
            <fieldset className="ws-checks" disabled={busy} aria-describedby={shown.branchIds || (tried && noneChosen) ? 'cd-branches-error' : undefined}>
              <legend>Consults at</legend>
              {wide && (
                <label className="ws-check">
                  <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Every branch, including ones added later
                </label>
              )}
              {!all && offered.map((b) => (
                <label key={b._id} className="ws-check">
                  <input type="checkbox" checked={chosen.includes(b._id)}
                    onChange={(e) => setChosen((c) => (e.target.checked ? [...c, b._id] : c.filter((x) => x !== b._id)))} /> {b.name}
                </label>
              ))}
              {(shown.branchIds || (tried && noneChosen)) && (
                <span id="cd-branches-error" className="j-field__error">{shown.branchIds ?? 'Choose at least one branch, or every branch.'}</span>
              )}
            </fieldset>
            {error && <Alert>Not sent: {error}</Alert>}
            <div className="rx-actions"><Button type="submit" busy={busy}>Send invitation</Button></div>
          </form>
        )}
    </section>
  );
}
