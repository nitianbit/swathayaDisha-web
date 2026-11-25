import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError, clinicBranchesFor, doctorAdminApi, DOCTOR_INVITE_STATE_LABEL, DOCTOR_INVITE_STATES, holdsAny, LINK_REFUSAL, linkProblems,
  MAX_DIRECTORY_SEARCH, type DirectoryDoctor, type DoctorInvite, type DoctorInviteState, type Page,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, formatDateTime, formatRupees, Loading, Parts, shared, TextField } from '@jansetu/ui';
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
import { t } from '../../i18n/partner/index.ts';

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
      <PartnerPageHeading ctx={ctx} title={t('clinicDoctors.title')} partnerName={partner.data?.name}>
        <Parts of={t.rich('clinicDoctors.intro', { desk: <a href={`#${clinicLink(ctx, 'desk')}`}>{t('clinicDoctors.frontDesk')}</a> })} />
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
      const r = await clinic.unlinkDoctor(doctorId).catch((err: unknown) => {
        // Q16b N1: a doctor's own practice keeps its doctor; an owner never unlinks themselves.
        if (err instanceof ApiError && err.status === 409 && err.code === 'DOCTOR_IS_OWNER') {
          throw new ApiError(409, t(err.message.includes('own practice') ? 'clinicDoctors.notRemoved.ownPractice' : 'clinicDoctors.notRemoved.ownerLink', { name }), 'DOCTOR_IS_OWNER');
        }
        throw err;
      });
      if (mounted.current) {
        setNotice(r.membershipEnded ? t('clinicDoctors.removed', { name }) : t('clinicDoctors.removedKeepsStaff', { name }));
      }
    } finally {
      // Removed or refused (e.g. removed meanwhile): the list shows the server's state either way.
      void queryClient.invalidateQueries({ queryKey: [...ctx.key, 'clinic-doctors'] });
    }
  });
  return (
    <section className="ws-section" aria-labelledby="cd-list-h">
      <h2 id="cd-list-h">{t('clinicDoctors.list')}</h2>
      {notice && <Alert tone="ok">{notice}</Alert>}
      {doctors.isPending ? <Loading label={t('clinicDoctors.loading')} />
        : doctors.isError ? <ErrorState message={messageOf(doctors.error)} onRetry={() => void doctors.refetch()} />
        : rows.length === 0 ? (
          <Empty title={t('clinicDoctors.none.title')}>
            {ctx.scope.kind === 'admin' ? t('clinicDoctors.none.admin') : t('clinicDoctors.none.member')}
          </Empty>
        ) : (
          <div className="ws-table-wrap">
            <table className="j-table">
              <caption className="j-sr-only">{t('clinicDoctors.caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('clinicDoctors.col.doctor')}</th><th scope="col">{t('clinicDoctors.col.speciality')}</th>
                  <th scope="col">{t('clinicDoctors.col.consultsAt')}</th><th scope="col">{t('clinicDoctors.col.fee')}</th>
                  <th scope="col">{t('clinicDoctors.col.status')}</th>{canRemove && <th scope="col">{t('clinicDoctors.col.action')}</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.memberId}>
                    <td>{d.role === 'owner' ? t('clinicDoctors.owner', { name: d.name }) : d.name}</td>
                    <td>{d.specialization || '—'}</td>
                    <td>{branchLabel(names, d.branchIds)}</td>
                    <td>{d.consultationFee ? formatRupees(d.consultationFee) : '—'}</td>
                    <td>
                      {d.active ? <Badge tone="ok">{t('clinicDoctors.bookable')}</Badge> : (
                        <><Badge tone="warn">{t('clinicDoctors.notBookable')}</Badge> <span className="ws-muted">{t('clinicDoctors.inactive')}</span></>
                      )}
                    </td>
                    {canRemove && (
                      <td>
                        {d.role === 'owner' && ctx.actor.memberId === d.memberId ? (
                          <span className="ws-muted">{t('clinicDoctors.ownLink')}</span>
                        ) : d.role === 'owner' ? (
                          // Q16b N1: another owner (or an admin) ends an owner's doctor link; they stay an owner.
                          <ConfirmAction label={t('clinicDoctors.removeAsDoctor', { name: d.name })} danger confirmLabel={t('clinicDoctors.removeLink')}
                            consequence={t('clinicDoctors.removeLink.consequence', { name: d.name })}
                            onConfirm={() => remove(d.doctorId, d.name)} />
                        ) : (
                          <ConfirmAction label={t('clinicDoctors.remove', { name: d.name })} danger confirmLabel={t('clinicDoctors.removeFromClinic')}
                            consequence={t('clinicDoctors.remove.consequence', { name: d.name })}
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
      <p className="ws-muted">{t('clinicDoctors.leaveInApp')}</p>
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
    if (revoking.current.has(inv._id)) throw new ApiError(409, t('clinicDoctors.revoking'), 'STEP_IN_FLIGHT');
    revoking.current.add(inv._id);
    try {
      await clinic.revokeInvite(inv._id);
      if (mounted.current) {
        const name = doctorName(inv);
        setNotice(name === undefined ? t('clinicDoctors.revokedUnnamed') : t('clinicDoctors.revoked', { name }));
      }
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
        <h2 id="cd-inv-h">{t('clinicDoctors.invites')}</h2>
        <p className="ws-muted">{t('clinicDoctors.invitesIntro')}</p>
        {notice && <Alert tone="ok">{notice}</Alert>}
        <div className="ws-search">
          <div className="j-field ws-filter">
            <label htmlFor="cd-state">{t('clinicDoctors.show')}</label>
            <select id="cd-state" value={state} onChange={(e) => { setState(e.target.value as '' | DoctorInviteState); setNotice(null); }}>
              {DOCTOR_INVITE_STATES.map((s) => <option key={s} value={s}>{DOCTOR_INVITE_STATE_LABEL[s]}</option>)}
              <option value="">{t('clinicDoctors.allInvites')}</option>
            </select>
          </div>
        </div>
        {invites.isPending ? <Loading label={t('clinicDoctors.loadingInvites')} />
          : invites.isError ? <ErrorState message={messageOf(invites.error)} onRetry={() => void invites.refetch()} />
          : rows.length === 0 ? <Empty title={t('clinicDoctors.noInvites.title')}>{state === 'pending' ? t('clinicDoctors.noInvites.pending') : t('clinicDoctors.noInvites.other')}</Empty>
          : (
            <>
              {rows.length >= 200 && <p className="ws-count">{t('clinicDoctors.newest200')}</p>}
              <div className="ws-table-wrap">
                <table className="j-table">
                  <caption className="j-sr-only">{t('clinicDoctors.invitesCaption')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('clinicDoctors.col.doctor')}</th><th scope="col">{t('clinicDoctors.col.branches')}</th>
                      <th scope="col">{t('clinicDoctors.col.sent')}</th><th scope="col">{t('clinicDoctors.col.state')}</th><th scope="col">{t('clinicDoctors.col.action')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((inv) => {
                      const d = doctorOf(inv);
                      const who = d.name ?? t('clinicDoctors.doctorById', { tail: inv.doctorId.slice(-6) });
                      return (
                        <tr key={inv._id}>
                          <td>{who}{d.specialization ? <div className="ws-muted">{d.specialization}</div> : !d.name ? <div className="ws-muted">{t('clinicDoctors.noName')}</div> : null}</td>
                          <td>{branchLabel(branchNames, inv.branchIds)}</td>
                          <td>{formatDateTime(inv.createdAt)}</td>
                          <td>
                            <Badge tone={inv.state === 'accepted' ? 'ok' : inv.state === 'pending' ? 'warn' : 'danger'}>{DOCTOR_INVITE_STATE_LABEL[inv.state] ?? inv.state}</Badge>
                            {inv.respondedAt && <div className="ws-muted">{formatDateTime(inv.respondedAt)}</div>}
                          </td>
                          <td>
                            {inv.state === 'pending' ? (
                              <ConfirmAction label={t('clinicDoctors.revokeTo', { name: who })} danger confirmLabel={t('clinicDoctors.revoke')}
                                consequence={t('clinicDoctors.revoke.consequence', { name: who })}
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
      setNotice(r.replayed ? t('clinicDoctors.link.replayed', { name: who })
        : t('clinicDoctors.link.done', { name: who, branches: attempt.body.branchText }));
    } catch (err) {
      void queryClient.invalidateQueries({ queryKey: [...ctx.key, 'clinic-doctors'] });
      if (!owns(attempt)) return;
      const next = afterFailure(attempt, err, linkRefusal(err));
      if (live.current) store(next ?? undefined); else if (next) memory.set(slot, next); else memory.delete(slot);
      if (!next) { setFailure(t('clinicDoctors.link.notLinked', { reason: linkRefusal(err) })); setConfirming(false); }
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
    if (!all && picked.length === 0) errs.branchIds = t('clinicDoctors.link.chooseBranch');
    if (chosen && doctors.data?.some((d) => d.doctorId === chosen._id)) errs.doctorId = t('clinicDoctors.link.already', { name: chosen.name });
    setErrors(errs);
    if (!Object.keys(errs).length) setConfirming(true);
  }

  const names = new Map(offered.map((b) => [b._id, b.name]));
  const branchText = all ? t('clinicDoctors.link.everyBranch') : picked.map((b) => names.get(b) ?? b).join(', ');
  const results = found.data?.items ?? [];

  return (
    <section className="ws-section" aria-labelledby="cd-add-h">
      <h2 id="cd-add-h">{t('clinicDoctors.add')}</h2>
      <p className="ws-muted">{t('clinicDoctors.add.intro')}</p>
      {notice && <Alert tone="ok">{notice}</Alert>}
      {op && !(sending && op.attempts === 1 && !op.uncertain) ? (
        <PendingOpPanel key={op.attempts} label={t('clinicDoctors.link.unconfirmed')} op={op} busy={sending} onResend={() => void send(op)}
          fetchPage={lookIn(op)}
          onFound={() => { if (!owns(op)) return; end(op); reset(); setNotice(op.body?.name === undefined ? t('clinicDoctors.link.foundUnnamed') : t('clinicDoctors.link.found', { name: op.body.name })); }}
          forget={{ label: t('clinicDoctors.link.forget'), confirmLabel: t('clinicDoctors.link.forgetConfirm'),
            consequence: t('clinicDoctors.link.forgetConsequence'),
            onForget: () => { if (owns(op)) end(op); } }}
          summary={op.restored || !op.body ? null : <div>{t('clinicDoctors.link.summary', { name: op.body.name, branches: op.body.branchText })}</div>} />
      ) : branches.isPending ? <Loading label={t('common.loadingBranches')} />
        : branches.isError ? <ErrorState message={messageOf(branches.error)} onRetry={() => void branches.refetch()} />
        : offered.length === 0 ? <Empty title={t('clinicDoctors.noBranch.title')}>{t('clinicDoctors.noBranch.body')}</Empty>
        : !chosen ? (
          <>
            <form className="ws-search" role="search" aria-label={t('clinicDoctors.find')} onSubmit={(e) => { e.preventDefault(); const q = text.trim(); if (q) setSearch(q.slice(0, MAX_DIRECTORY_SEARCH)); }}>
              <TextField label={t('clinicDoctors.search')} type="search" maxLength={MAX_DIRECTORY_SEARCH} value={text} onChange={(e) => setText(e.target.value)}
                hint={t('clinicDoctors.searchHint')} />
              <Button type="submit" variant="secondary" disabled={!text.trim()}>{shared('action.search')}</Button>
            </form>
            {search === null ? <p className="ws-muted">{t('clinicDoctors.onlyVerified')}</p>
              : found.isPending ? <Loading label={t('clinicDoctors.searching')} />
              : found.isError ? <ErrorState message={messageOf(found.error)} onRetry={() => void found.refetch()} />
              : results.length === 0 ? <Empty title={t('clinicDoctors.notFound.title')}>{t('clinicDoctors.notFound.body', { q: search })}</Empty>
              : (
                <div className="ws-table-wrap">
                  <table className="j-table">
                    <caption className="j-sr-only">{t('clinicDoctors.resultsCaption', { q: search })}</caption>
                    <thead>
                      <tr>
                        <th scope="col">{t('clinicDoctors.col.doctor')}</th><th scope="col">{t('clinicDoctors.col.speciality')}</th>
                        <th scope="col">{t('clinicDoctors.col.mobile')}</th><th scope="col">{t('clinicDoctors.col.choose')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {results.map((d) => (
                        <tr key={d._id}>
                          <td>{d.name}{d.city ? <div className="ws-muted">{d.city}</div> : null}</td>
                          <td>{d.specialization || '—'}</td>
                          <td>{d.phone || '—'}</td>
                          <td><Button variant="secondary" aria-label={t('clinicDoctors.chooseName', { name: d.name })} onClick={() => { setChosen(d); setFailure(null); }}>{t('clinicDoctors.choose')}</Button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </>
        ) : (
          <form className="rx-form" noValidate onSubmit={review} aria-label={t('clinicDoctors.add')}>
            <p><strong>{chosen.name}</strong>{chosen.specialization ? ` · ${chosen.specialization}` : ''}{chosen.phone ? ` · ${chosen.phone}` : ''}</p>
            {!confirming ? (
              <fieldset className="ws-checks" aria-describedby={errors.branchIds ? 'cd-link-branches-error' : undefined}>
                <legend>{t('clinicDoctors.consultsAt')}</legend>
                <label className="ws-check"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> {t('clinicDoctors.everyBranch')}</label>
                {!all && offered.map((b) => (
                  <label key={b._id} className="ws-check">
                    <input type="checkbox" checked={picked.includes(b._id)} onChange={(e) => setPicked((c) => (e.target.checked ? [...c, b._id] : c.filter((x) => x !== b._id)))} /> {b.name}
                  </label>
                ))}
                {errors.branchIds && <span id="cd-link-branches-error" className="j-field__error">{errors.branchIds}</span>}
              </fieldset>
            ) : (
              <div className="confirm-text">
                {t('clinicDoctors.link.confirm', { name: chosen.name, branches: branchText })}
              </div>
            )}
            {errors.doctorId && <Alert>{errors.doctorId}</Alert>}
            {failure && <Alert>{failure}</Alert>}
            <div className="confirm-actions">
              {!confirming ? <Button type="submit">{t('common.continue')}</Button> : (
                <Button busy={sending} onClick={() => void send(startOp(newRequestKey(), { doctorId: chosen._id, name: chosen.name, branchIds: all ? [] : [...picked], branchText }))}>
                  {t('clinicDoctors.link.button', { name: chosen.name })}
                </Button>
              )}
              <Button variant="ghost" disabled={sending} onClick={() => (confirming ? setConfirming(false) : reset())}>{shared('action.back')}</Button>
            </div>
          </form>
        )}
    </section>
  );
}
