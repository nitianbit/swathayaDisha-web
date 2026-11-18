import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError, clinicBranchesFor, doctorAdminApi, DOCTOR_INVITE_STATE_LABEL, DOCTOR_INVITE_STATES, holdsAny, LINK_REFUSAL, linkProblems,
  MAX_DIRECTORY_SEARCH, type DirectoryDoctor, type DoctorInvite, type DoctorInviteState, type Page,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, formatDateTime, formatRupees, Loading, TextField } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { PendingOpPanel } from '../../components/PendingOpPanel.tsx';
import { messageOf } from '../../errors.ts';
import { afterFailure, beginAttempt, newRequestKey, resolveStored, startOp, stillCurrent, type PendingOp } from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { useOneAtATime } from '../finance/finance.tsx';
import { ClinicOnly, clinicLink, useClinicApi, useDoctorList, type ClinicApi } from './clinic.tsx';
import {
  branchLabel, NoSuchPartner, PartnerPageHeading, scopeIdentity, useBranches, usePartnerScope, useWorkspacePartner, type ScopeContext,
} from './scope.tsx';

/**
 * The clinic's consulting doctors. Q14 (owner, 18 Nov 2026): clinics no longer invite doctors — the Jansetu team links a
 * verified doctor at chosen branches after checking (admins, "Add doctor"); the owner (or an admin) removes one.
 * Invitations sent before stay listed (staff.manage) and can be revoked; doctors can no longer accept them.
 */
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
        Doctors are linked to this clinic by the Jansetu team after checking. A linked doctor can be booked at the{' '}
        <a href={`#${clinicLink(ctx, 'desk')}`}>front desk</a>.
      </PartnerPageHeading>
      <ClinicOnly ctx={ctx}>
        <DoctorList ctx={ctx} clinic={clinic} />
        {ctx.scope.kind === 'admin' && <AddDoctor ctx={ctx} clinic={clinic} />}
        {manage && <Invitations ctx={ctx} clinic={clinic} />}
      </ClinicOnly>
    </>
  );
}

function DoctorList({ ctx, clinic }: { ctx: ScopeContext; clinic: ClinicApi }) {
  const queryClient = useQueryClient();
  const doctors = useDoctorList(ctx, clinic);
  const branches = useBranches(ctx);
  const names = useMemo(() => new Map((branches.data ?? []).map((b) => [b._id, b.name])), [branches.data]);
  const rows = doctors.data ?? [];
  // Q14 `unlinkDoctor`: the owner (admins act as owner); one change on this list at a time.
  const canRemove = ctx.actor.role === 'owner';
  const { perform } = useOneAtATime('doctor list');
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const remove = (doctorId: string, name: string) => perform(async () => {
    try {
      const r = await clinic.unlinkDoctor(doctorId);
      if (mounted.current) {
        setNotice(r.membershipEnded ? `${name} no longer consults here.` : `${name} no longer consults here; their staff access is kept.`);
      }
    } finally {
      // Removed or refused (e.g. removed meanwhile): the list shows the server's state either way.
      void queryClient.invalidateQueries({ queryKey: [...ctx.key, 'clinic-doctors'] });
    }
  });
  return (
    <section className="ws-section" aria-labelledby="cd-list-h">
      <h2 id="cd-list-h">Consulting doctors</h2>
      {notice && <Alert tone="ok">{notice}</Alert>}
      {doctors.isPending ? <Loading label="Loading doctors…" />
        : doctors.isError ? <ErrorState message={messageOf(doctors.error)} onRetry={() => void doctors.refetch()} />
        : rows.length === 0 ? (
          <Empty title="No doctors yet">
            {ctx.scope.kind === 'admin' ? 'Add a verified doctor below.' : 'No doctor consults here yet. Ask the Jansetu team to link your doctors after checking them.'}
          </Empty>
        ) : (
          <div className="ws-table-wrap">
            <table className="j-table">
              <caption className="j-sr-only">Doctors consulting at this clinic</caption>
              <thead><tr><th scope="col">Doctor</th><th scope="col">Speciality</th><th scope="col">Consults at</th><th scope="col">Fee</th><th scope="col">Status</th>{canRemove && <th scope="col">Action</th>}</tr></thead>
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
                    {canRemove && (
                      <td>
                        {d.role === 'owner' ? <span className="ws-muted">Owns the clinic</span> : (
                          <ConfirmAction label={`Remove ${d.name}`} danger confirmLabel="Remove from this clinic"
                            consequence={<>Remove {d.name} from this clinic? New bookings with them here stop at once and their in-clinic slots here close. Appointments already booked are kept. Only the Jansetu team can link them again.</>}
                            onConfirm={() => remove(d.doctorId, d.name)} />
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      <p className="ws-muted">A doctor also stops consulting here by leaving the clinic in their own app.</p>
    </section>
  );
}

function Invitations({ ctx, clinic }: { ctx: ScopeContext; clinic: ClinicApi }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<'' | DoctorInviteState>('pending');
  const invites = useQuery({ queryKey: [...ctx.key, 'clinic-invites', state || 'all'], queryFn: () => clinic.invites(state || undefined) });
  const doctors = useDoctorList(ctx, clinic);
  const branches = useBranches(ctx);
  const branchNames = useMemo(() => new Map((branches.data ?? []).map((b) => [b._id, b.name])), [branches.data]);
  // Q13: each invitation names its doctor (current name and speciality); the doctor list is only a fallback.
  const doctorOf = (inv: DoctorInvite) => {
    const member = doctors.data?.find((d) => d.doctorId === inv.doctorId);
    return { name: inv.doctor?.name ?? member?.name ?? undefined, specialization: inv.doctor?.specialization ?? member?.specialization ?? undefined };
  };
  const doctorName = (inv: DoctorInvite) => doctorOf(inv).name;
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
      if (mounted.current) setNotice(`The invitation to ${doctorName(inv) ?? 'the doctor'} was revoked. They can no longer accept it.`);
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
        <h2 id="cd-inv-h">Earlier invitations</h2>
        <p className="ws-muted">Clinics no longer invite doctors, and doctors can no longer accept these. Revoke a waiting one to tidy up.</p>
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
                      const d = doctorOf(inv);
                      const who = d.name ?? `Doctor …${inv.doctorId.slice(-6)}`;
                      return (
                        <tr key={inv._id}>
                          <td>{who}{d.specialization ? <div className="ws-muted">{d.specialization}</div> : !d.name ? <div className="ws-muted">No name on record</div> : null}</td>
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
    </>
  );
}

// ── Q14: an admin links a verified doctor ──

/** The link being sent or whose answer was lost: the doctor and branches (what the page shows), with the server's key. */
interface LinkBody { doctorId: string; name: string; branchIds: string[]; branchText: string }
type LinkOp = PendingOp<LinkBody>;
const linkRefusal = (err: unknown) => (err instanceof ApiError && err.code && LINK_REFUSAL[err.code]) || messageOf(err);

/**
 * Admins only (`linkDoctor`): find a verified doctor, choose the branches, confirm. Once-only: the link is stored in
 * session memory with its request key BEFORE it is sent (a body-less marker survives a reload); a resend with the same
 * key answers the same link (`replayed`). Not found yet = the doctor is not on the list; after a reload it can be
 * forgotten safely, because linking a doctor who already consults here is refused.
 */
function AddDoctor({ ctx, clinic }: { ctx: ScopeContext; clinic: ClinicApi }) {
  const queryClient = useQueryClient();
  const { api, memory } = useSession();
  const directory = useMemo(() => doctorAdminApi(api), [api]);
  const branches = useBranches(ctx);
  const doctors = useDoctorList(ctx, clinic);
  const offered = clinicBranchesFor(branches.data ?? [], ctx.actor);
  const slot = `clinic-doctor-link:${scopeIdentity(ctx)}`;
  const [op, setOpState] = useState<LinkOp | undefined>(() => memory.get<LinkOp>(slot));
  const [sending, setSending] = useState(false);
  const [text, setText] = useState('');
  const [search, setSearch] = useState<string | null>(null);
  const [chosen, setChosen] = useState<DirectoryDoctor | null>(null);
  const [all, setAll] = useState(true);
  const [picked, setPicked] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const found = useQuery({
    queryKey: [...ctx.key, 'doctor-directory', search], enabled: search !== null,
    queryFn: () => directory.search(search!),
  });
  const store = (p: LinkOp | undefined) => { if (p) memory.set(slot, p); else memory.delete(slot); setOpState(p); };
  const owns = (p: LinkOp) => live.current && stillCurrent(memory.get<LinkOp>(slot), p);
  const end = (p: LinkOp) => { resolveStored(memory, slot, p.requestKey); const k = p.requestKey; setOpState((c) => (c && c.requestKey !== k ? c : undefined)); };
  const reset = () => { setChosen(null); setConfirming(false); setPicked([]); setAll(true); setErrors({}); };

  async function send(p: LinkOp) {
    const attempt = beginAttempt(p);
    store(attempt);
    setSending(true);
    setFailure(null);
    setNotice(null);
    try {
      const r = await clinic.linkDoctor({ doctorId: attempt.body.doctorId, branchIds: attempt.body.branchIds, requestKey: attempt.requestKey });
      void queryClient.invalidateQueries({ queryKey: [...ctx.key, 'clinic-doctors'] });
      void queryClient.invalidateQueries({ queryKey: [...ctx.key, 'clinic-invites'] });
      if (!owns(attempt)) return;
      end(attempt);
      reset();
      const who = r.doctor?.name ?? attempt.body.name;
      setNotice(r.replayed ? `${who} had already been linked: nothing was done twice.`
        : `${who} now consults here (${attempt.body.branchText}). They have been told; their in-clinic hours here can be booked at the front desk.`);
    } catch (err) {
      void queryClient.invalidateQueries({ queryKey: [...ctx.key, 'clinic-doctors'] });
      if (!owns(attempt)) return;
      const next = afterFailure(attempt, err, linkRefusal(err));
      if (live.current) store(next ?? undefined); else if (next) memory.set(slot, next); else memory.delete(slot);
      if (!next) { setFailure(`Not linked: ${linkRefusal(err)}`); setConfirming(false); }
    } finally {
      if (live.current) setSending(false);
    }
  }

  /** The doctor list as the "records" a stored link is looked for in: the doctor now consults here (by this link or another). */
  const lookIn = (p: LinkOp) => async (page: number): Promise<Page<{ requestKey: string }>> => {
    const list = await queryClient.fetchQuery({ queryKey: [...ctx.key, 'clinic-doctors'], queryFn: () => clinic.doctors(), staleTime: 0 });
    const hit = !p.restored && p.body && list.some((d) => d.doctorId === p.body.doctorId);
    const items = hit ? [{ requestKey: p.requestKey }] : [];
    return { items, page, limit: 1, total: items.length, totalPages: 1 };
  };

  function review(e: FormEvent) {
    e.preventDefault();
    const branchIds = all ? [] : picked;
    const errs: Record<string, string> = { ...linkProblems({ doctorId: chosen?._id ?? '', branchIds }, offered) as Record<string, string> };
    if (!all && picked.length === 0) errs.branchIds = 'Choose at least one branch, or every branch.';
    if (chosen && doctors.data?.some((d) => d.doctorId === chosen._id)) errs.doctorId = `${chosen.name} already consults here.`;
    setErrors(errs);
    if (!Object.keys(errs).length) setConfirming(true);
  }

  const names = new Map(offered.map((b) => [b._id, b.name]));
  const branchText = all ? 'every branch that takes in-clinic consultations' : picked.map((b) => names.get(b) ?? b).join(', ');
  const results = found.data?.items ?? [];

  return (
    <section className="ws-section" aria-labelledby="cd-add-h">
      <h2 id="cd-add-h">Add doctor</h2>
      <p className="ws-muted">For the Jansetu team: link a verified doctor after checking them. There is no acceptance step; the doctor is told.</p>
      {notice && <Alert tone="ok">{notice}</Alert>}
      {op && !(sending && op.attempts === 1 && !op.uncertain) ? (
        <PendingOpPanel key={op.attempts} label="Unconfirmed doctor link" op={op} busy={sending} onResend={() => void send(op)}
          fetchPage={lookIn(op)}
          onFound={() => { if (!owns(op)) return; end(op); reset(); setNotice(`${op.body?.name ?? 'The doctor'} consults here now. Nothing more to do.`); }}
          forget={{ label: 'Forget it', confirmLabel: 'Forget the earlier link',
            consequence: 'If the earlier link still arrives, the doctor is linked. Linking the same doctor again is refused (they already consult here), so nothing is done twice.',
            onForget: () => { if (owns(op)) end(op); } }}
          summary={op.restored || !op.body ? null : <div>{op.body.name} at {op.body.branchText}.</div>} />
      ) : branches.isPending ? <Loading label="Loading branches…" />
        : branches.isError ? <ErrorState message={messageOf(branches.error)} onRetry={() => void branches.refetch()} />
        : offered.length === 0 ? <Empty title="No branch for consultations">A doctor consults at a branch that takes in-clinic consultations. Turn that on for a branch under Branches first.</Empty>
        : !chosen ? (
          <>
            <form className="ws-search" role="search" aria-label="Find a doctor" onSubmit={(e) => { e.preventDefault(); const t = text.trim(); if (t) setSearch(t.slice(0, MAX_DIRECTORY_SEARCH)); }}>
              <TextField label="Doctor’s full name or speciality" type="search" maxLength={MAX_DIRECTORY_SEARCH} value={text} onChange={(e) => setText(e.target.value)}
                hint="Search by the doctor’s full name or speciality (whole words). Check the mobile number shown before choosing." />
              <Button type="submit" variant="secondary" disabled={!text.trim()}>Search</Button>
            </form>
            {search === null ? <p className="ws-muted">Only active, verified doctors are found.</p>
              : found.isPending ? <Loading label="Searching doctors…" />
              : found.isError ? <ErrorState message={messageOf(found.error)} onRetry={() => void found.refetch()} />
              : results.length === 0 ? <Empty title="No doctor found">No active, verified doctor matches “{search}”.</Empty>
              : (
                <div className="ws-table-wrap">
                  <table className="j-table">
                    <caption className="j-sr-only">Verified doctors matching {search}</caption>
                    <thead><tr><th scope="col">Doctor</th><th scope="col">Speciality</th><th scope="col">Mobile</th><th scope="col">Choose</th></tr></thead>
                    <tbody>
                      {results.map((d) => (
                        <tr key={d._id}>
                          <td>{d.name}{d.city ? <div className="ws-muted">{d.city}</div> : null}</td>
                          <td>{d.specialization || '—'}</td>
                          <td>{d.phone || '—'}</td>
                          <td><Button variant="secondary" aria-label={`Choose ${d.name}`} onClick={() => { setChosen(d); setFailure(null); }}>Choose</Button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </>
        ) : (
          <form className="rx-form" noValidate onSubmit={review} aria-label="Add doctor">
            <p><strong>{chosen.name}</strong>{chosen.specialization ? ` · ${chosen.specialization}` : ''}{chosen.phone ? ` · ${chosen.phone}` : ''}</p>
            {!confirming ? (
              <fieldset className="ws-checks" aria-describedby={errors.branchIds ? 'cd-link-branches-error' : undefined}>
                <legend>Consults at</legend>
                <label className="ws-check"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Every branch, including ones added later</label>
                {!all && offered.map((b) => (
                  <label key={b._id} className="ws-check">
                    <input type="checkbox" checked={picked.includes(b._id)} onChange={(e) => setPicked((c) => (e.target.checked ? [...c, b._id] : c.filter((x) => x !== b._id)))} /> {b.name}
                  </label>
                ))}
                {errors.branchIds && <span id="cd-link-branches-error" className="j-field__error">{errors.branchIds}</span>}
              </fieldset>
            ) : (
              <div className="confirm-text">
                Link {chosen.name} to this clinic at {branchText}? They consult here at once (there is no acceptance step) and are told; the front desk
                can book their in-clinic hours here. Only the owner or the Jansetu team can remove them later.
              </div>
            )}
            {errors.doctorId && <Alert>{errors.doctorId}</Alert>}
            {failure && <Alert>{failure}</Alert>}
            <div className="confirm-actions">
              {!confirming ? <Button type="submit">Continue</Button> : (
                <Button busy={sending} onClick={() => void send(startOp(newRequestKey(), { doctorId: chosen._id, name: chosen.name, branchIds: all ? [] : [...picked], branchText }))}>
                  Link {chosen.name}
                </Button>
              )}
              <Button variant="ghost" disabled={sending} onClick={() => (confirming ? setConfirming(false) : reset())}>Back</Button>
            </div>
          </form>
        )}
    </section>
  );
}
