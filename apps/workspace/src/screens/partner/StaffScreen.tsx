import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  ALL_PARTNER_PERMISSIONS, ApiError, canAddOwner, canEditProfessional, PROFESSIONAL_KIND_LABEL, PROFESSIONAL_KINDS, professionalInput, tooLongWords, type MemberProfessional, canChangeBranches, canEditEmail, canEditPermissions, canGiveEmail, canReopenBranches, EMAIL_IN_USE_MESSAGE, grantablePermissions,
  hasGlobalScope, INVALID_BRANCH_IDS_MESSAGE, isEmailInUse, isInvalidBranchIds, isOwnerEmailAdminOnly, isOwnerRequired, isUseDoctorUnlink, MAX_EMAIL, MAX_NAME, memberEmail, OWNER_EMAIL_ADMIN_ONLY_MESSAGE,
  PARTNER_PERMISSIONS, PARTNER_PHONE_PATTERN, PERMISSION_LABEL, removalBlock, scopeProblem,
  type Branch, type MemberRole, type PartnerMember, type PartnerPermission,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, Loading, Parts, shared, TextField } from '@jansetu/ui';
import { definitelyNotRecorded } from '../../requests.ts';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { changedFields, isRecordChanged, RECORD_CHANGED_MESSAGE, staleMessage, useDraft } from '../../draft.ts';
import { messageOf } from '../../errors.ts';
import { clinicLink } from './clinic.tsx';
import {
  branchLabel, NoSuchPartner, PartnerPageHeading, scopeIdentity, useBranches, usePartnerScope, useWorkspacePartner, type ScopeContext,
} from './scope.tsx';
import { t } from '../../i18n/partner/index.ts';

/**
 * Staff of a partner (`staff.manage`). Mirrors the backend's rules (`partners/services`): only owners add owners or
 * change permissions; staff grant only permissions they hold and only within their own branches; nobody removes
 * themselves or the last owner, or changes their own branch access. The server decides and its message is shown.
 */
export function StaffScreen() {
  const ctx = usePartnerScope();
  if (!ctx) return <NoSuchPartner />;
  // One subtree per partner: an admin moving from one partner's staff to another's starts with nothing open.
  return <Staff key={scopeIdentity(ctx)} ctx={ctx} />;
}

/** Permissions in the backend's order (so equal sets compare equal). */
const ordered = (perms: Iterable<string>) => { const s = new Set(perms); return ALL_PARTNER_PERMISSIONS.filter((p) => s.has(p)); };

type Editing = { kind: 'permissions' | 'branches' | 'email' | 'professional'; id: string } | null;

function Staff({ ctx }: { ctx: ScopeContext }) {
  const queryClient = useQueryClient();
  const partner = useWorkspacePartner(ctx);
  const members = useQuery({ queryKey: [...ctx.key, 'members'], queryFn: () => ctx.api.members() });
  const branches = useBranches(ctx);
  // WQ11b: closed branches a member still holds are named and can be unticked (readable by partner-wide branch managers).
  const withClosed = useQuery({
    queryKey: [...ctx.key, 'branches', 'with-closed'], queryFn: () => ctx.api.branches({ includeInactive: true }), enabled: canReopenBranches(ctx.actor),
  });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const names = new Map([...(withClosed.data ?? []), ...(branches.data ?? [])].map((b) => [b._id, b.isActive === false ? t('staff.closedBranch', { name: b.name }) : b.name]));
  const admin = ctx.scope.kind === 'admin';
  const doctorsLink = clinicLink(ctx, 'clinic-doctors');
  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: [...ctx.key, 'members'] }),
    queryClient.invalidateQueries({ queryKey: [...ctx.key, 'me'] }), // the owner count
  ]);
  const editTarget = editing ? members.data?.find((m) => m._id === editing.id) : undefined;
  const open = (e: Editing) => { setEditing(e); setNotice(null); };
  /**
   * WQ11b: a save's answer closes only the editor that made it (still open, same kind and member). One that arrives after
   * another editor was opened leaves that editor and what was typed in it alone; the list is read again either way.
   */
  const closeIfOpen = (e: NonNullable<Editing>) => setEditing((cur) => (cur && cur.kind === e.kind && cur.id === e.id ? null : cur));

  return (
    <>
      <PartnerPageHeading ctx={ctx} title={t('staff.title')} partnerName={partner.data?.name}>{t('staff.intro')}</PartnerPageHeading>
      {ctx.actor.role !== 'owner' && (
        <p className="ws-muted">{t('staff.ownerOnlyRegistration')}</p>
      )}
      {notice && <Alert tone="ok">{notice}</Alert>}
      {!adding && <div><Button onClick={() => { setAdding(true); setNotice(null); }}>{t('staff.add')}</Button></div>}
      {adding && (
        <AddMember ctx={ctx} branches={branches.data} branchesError={branches.isError ? messageOf(branches.error) : null}
          onCancel={() => setAdding(false)}
          admin={admin} onAdded={async (m) => { setAdding(false); setNotice(t('staff.added', { name: m.name })); await refresh(); }} />
      )}
      {members.isPending ? <Loading label={t('staff.loading')} />
        : members.isError ? <ErrorState message={messageOf(members.error)} onRetry={() => void members.refetch()} />
        : members.data.length === 0 ? <Empty title={t('staff.none.title')}>{t('staff.none.body')}</Empty>
        : (
          <div className="ws-table-wrap">
            <table className="j-table">
              <caption className="j-sr-only">{t('staff.caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('staff.col.name')}</th><th scope="col">{t('staff.col.phone')}</th><th scope="col">{t('staff.col.email')}</th>
                  <th scope="col">{t('staff.col.role')}</th><th scope="col">{t('staff.col.registration')}</th><th scope="col">{t('staff.col.permissions')}</th>
                  <th scope="col">{t('staff.col.branches')}</th><th scope="col">{t('staff.col.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {members.data.map((m) => {
                  const block = removalBlock(ctx.actor, m, partner.data?.activeOwnerCount);
                  return (
                    <tr key={m._id}>
                      <td>{m.name}{ctx.actor.memberId === m._id && <> <Badge>{t('staff.you')}</Badge></>}</td>
                      <td>{m.phone}</td>
                      <td>{m.email || <span className="ws-muted">{t('staff.none')}</span>}</td>
                      <td>{m.role === 'owner' ? t('staff.role.owner') : m.doctorId ? t('staff.role.clinicDoctor') : t('staff.role.staff')}</td>
                      <td>{m.professional?.registrationNumber ? professionalLabel(m.professional) : <span className="ws-muted">{t('staff.notAdded')}</span>}</td>
                      <td>{m.role === 'owner' ? t('staff.everything') : m.permissions.length ? m.permissions.map((p) => PERMISSION_LABEL[p] ?? p).join(', ') : t('staff.none')}</td>
                      <td>{m.role === 'owner' ? t('common.allBranches') : branchLabel(names, m.branchIds)}</td>
                      <td>
                        <div className="ws-actions">
                          {canEditPermissions(ctx.actor, m) && (
                            <Button variant="secondary" onClick={() => open({ kind: 'permissions', id: m._id })}>{t('staff.editPermissions')}</Button>
                          )}
                          {canEditEmail(ctx.actor, m, admin) && (
                            <Button variant="secondary" onClick={() => open({ kind: 'email', id: m._id })}>{m.email ? t('staff.changeEmail') : t('staff.addEmail')}</Button>
                          )}
                          {canEditProfessional(ctx.actor, m) && (
                            <Button variant="secondary" onClick={() => open({ kind: 'professional', id: m._id })}>
                              {m.professional?.registrationNumber ? t('staff.changeRegistration') : t('staff.addRegistration')}
                            </Button>
                          )}
                          {canChangeBranches(ctx.actor, m) && (
                            <Button variant="secondary" onClick={() => open({ kind: 'branches', id: m._id })}>{t('staff.changeBranches')}</Button>
                          )}
                          {m.doctorId && ctx.actor.memberId !== m._id ? (
                            // Q16b: a clinic doctor's membership ends on Doctors (owner or admin), never as staff (409 USE_DOCTOR_UNLINK).
                            m.role === 'owner'
                              // Q16b N1: an owner who is also the doctor loses the doctor link on Doctors (another owner or an admin).
                              ? <span className="ws-muted"><Parts of={t.rich('staff.ownerDoctor', { doctors: <Link to={doctorsLink}>{t('staff.doctorsLink')}</Link> })} /></span>
                              : <span className="ws-muted"><Parts of={t.rich('staff.doctor', { doctors: <Link to={doctorsLink}>{t('staff.doctorsLink')}</Link> })} /></span>
                          ) : block ? <span className="ws-muted">{block}</span> : (
                            <ConfirmAction label={shared('action.remove')} danger confirmLabel={t('staff.removeName', { name: m.name })}
                              consequence={t('staff.remove.consequence', { name: m.name })}
                              onConfirm={async () => {
                                try { await ctx.api.removeMember(m._id); setNotice(t('staff.removed', { name: m.name })); } catch (err) {
                                  if (isUseDoctorUnlink(err)) {
                                    throw new ApiError(409, t('staff.removeDoctor', { name: m.name }), 'USE_DOCTOR_UNLINK');
                                  }
                                  throw err;
                                } finally { await refresh(); }
                              }} />
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      {editTarget && editing?.kind === 'permissions' && (
        <EditPermissions key={`p:${editTarget._id}`} ctx={ctx} member={editTarget} onClose={() => setEditing(null)}
          onSaved={async () => { closeIfOpen({ kind: 'permissions', id: editTarget._id }); setNotice(t('staff.permissionsSaved', { name: editTarget.name })); await refresh(); }} />
      )}
      {editTarget && editing?.kind === 'email' && (
        <EditEmail key={`e:${editTarget._id}`} ctx={ctx} member={editTarget} admin={admin} onClose={() => setEditing(null)}
          onSaved={async () => { closeIfOpen({ kind: 'email', id: editTarget._id }); setNotice(t('staff.emailSaved', { name: editTarget.name })); await refresh(); }} />
      )}
      {editTarget && editing?.kind === 'professional' && (
        <EditProfessional key={`r:${editTarget._id}`} ctx={ctx} member={editTarget} onClose={() => setEditing(null)}
          onSaved={async (removed) => {
            closeIfOpen({ kind: 'professional', id: editTarget._id });
            setNotice(removed ? t('staff.registrationRemoved', { name: editTarget.name }) : t('staff.registrationSaved', { name: editTarget.name }));
            await refresh();
          }} />
      )}
      {editTarget && editing?.kind === 'branches' && (
        <EditBranches key={`b:${editTarget._id}`} ctx={ctx} member={editTarget} branches={branches.data} closedBranches={withClosed.data}
          branchesError={branches.isError ? messageOf(branches.error) : null} onClose={() => setEditing(null)}
          onSaved={async () => { closeIfOpen({ kind: 'branches', id: editTarget._id }); setNotice(t('staff.branchesSaved', { name: editTarget.name })); await refresh(); }} />
      )}
    </>
  );
}

function PermissionChecklist({ legend, allowed, value, onChange, error }:
  { legend: string; allowed: readonly PartnerPermission[]; value: readonly PartnerPermission[]; onChange: (v: PartnerPermission[]) => void; error?: string }) {
  const shown = PARTNER_PERMISSIONS.filter((p) => allowed.includes(p.value));
  return (
    <fieldset className="ws-checks" aria-describedby={error ? 'perm-error' : undefined}>
      <legend>{legend}</legend>
      {shown.length === 0 ? <p className="ws-muted">{t('staff.noGrantable')}</p> : shown.map((p) => (
        <label key={p.value} className="ws-check">
          <input type="checkbox" checked={value.includes(p.value)} onChange={(e) =>
            onChange(ordered(e.target.checked ? [...value, p.value] : value.filter((x) => x !== p.value)))} />
          {p.label}
        </label>
      ))}
      {error && <span id="perm-error" className="j-field__error">{error}</span>}
    </fieldset>
  );
}

/**
 * Branch access picker: "all branches" (partner-wide actors only) or some of the branches this actor can see. WQ11b:
 * branches the member already holds that are not open (closed, or not readable here) are listed too, marked, so they
 * can be unticked: `held` are those ids, `closedNames` names the closed ones this actor can read.
 */
function BranchPicker({ wide, all, ids, options, held = [], closedNames, loadError, error, onChange }: {
  wide: boolean; all: boolean; ids: readonly string[]; options: readonly Branch[] | undefined; loadError: string | null; error?: string;
  held?: readonly string[]; closedNames?: ReadonlyMap<string, string>;
  onChange: (v: { all: boolean; ids: string[] }) => void;
}) {
  const open = new Set((options ?? []).map((b) => b._id));
  const extra = held.filter((id) => !open.has(id));
  const heldLabel = (id: string) => {
    const name = closedNames?.get(id) ?? (wide ? t('staff.closedOrRemoved', { tail: id.slice(-6) }) : t('staff.notYours', { tail: id.slice(-6) }));
    return wide || closedNames?.has(id) ? t('staff.closedBranch', { name }) : name;
  };
  return (
    <fieldset className="ws-checks" aria-describedby={error ? 'branch-error' : undefined}>
      <legend>{t('staff.branches')}</legend>
      {wide && (
        <label className="ws-check">
          <input type="checkbox" checked={all} onChange={(e) => onChange({ all: e.target.checked, ids: [...ids] })} /> {t('staff.allBranches')}
        </label>
      )}
      {!all && (options ?? []).map((b) => (
        <label key={b._id} className="ws-check">
          <input type="checkbox" checked={ids.includes(b._id)} onChange={(e) =>
            onChange({ all, ids: (e.target.checked ? [...ids, b._id] : ids.filter((x) => x !== b._id)).sort() })} /> {b.name}
        </label>
      ))}
      {!all && options && extra.map((id) => (
        <label key={id} className="ws-check">
          <input type="checkbox" checked={ids.includes(id)} onChange={(e) =>
            onChange({ all, ids: (e.target.checked ? [...ids, id] : ids.filter((x) => x !== id)).sort() })} />{' '}
          {heldLabel(id)}
        </label>
      ))}
      {!all && options?.length === 0 && extra.length === 0 && <p className="ws-muted">{t('staff.noBranches')}</p>}
      {!all && loadError && <p className="ws-muted">{t('staff.branchesFailed', { reason: loadError })}</p>}
      {error && <span id="branch-error" className="j-field__error">{error}</span>}
    </fieldset>
  );
}

const branchProblem = (ctx: ScopeContext, all: boolean, ids: string[], closed?: ReadonlySet<string>) =>
  !all && ids.length === 0 ? t('staff.error.branches') : scopeProblem(ctx.actor, all ? [] : ids, closed);

function AddMember({ ctx, branches, branchesError, admin, onCancel, onAdded }: {
  ctx: ScopeContext; branches: Branch[] | undefined; branchesError: string | null; admin: boolean;
  onCancel: () => void; onAdded: (m: PartnerMember) => Promise<void>;
}) {
  const wide = hasGlobalScope(ctx.actor);
  const grantable = grantablePermissions(ctx.actor, useWorkspacePartner(ctx).data?.kind);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<MemberRole>('staff');
  // Q16b: a new owner gets a sign-in email from the Jansetu team only (an admin here).
  const withEmailField = canGiveEmail(ctx.actor, role, admin);
  const anyEmailField = canGiveEmail(ctx.actor, 'staff', admin);
  const [perms, setPerms] = useState<PartnerPermission[]>([]);
  const [scope, setScope] = useState<{ all: boolean; ids: string[] }>({ all: wide, ids: [] });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = t('staff.error.name');
    else if (name.trim().length > MAX_NAME) errs.name = tooLongWords(MAX_NAME);
    if (!PARTNER_PHONE_PATTERN.test(phone)) errs.phone = t('staff.error.phone');
    // WQ9: only owners (and admins as owner) give a new member a sign-in email; nobody else's form has the field.
    const mail = withEmailField ? memberEmail(email) : '';
    if (mail === null) errs.email = t('staff.error.email');
    if (role === 'staff') { const problem = branchProblem(ctx, scope.all, scope.ids); if (problem) errs.branches = problem; }
    setErrors(errs); setError(null);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      // `ctx` is this partner's for the life of the form (the subtree is keyed by partner).
      const withEmail = mail ? { email: mail } : {};
      const added = await ctx.api.addMember(role === 'owner'
        ? { name: name.trim(), phone, ...withEmail, role: 'owner', permissions: [] }
        : { name: name.trim(), phone, ...withEmail, role: 'staff', permissions: perms.filter((p) => grantable.includes(p)), branchIds: scope.all ? [] : scope.ids });
      await onAdded(added);
    } catch (err) {
      // WQ9: the email belongs to another account: say so on the field (nothing was added).
      if (isEmailInUse(err)) setErrors({ email: EMAIL_IN_USE_MESSAGE });
      else if (mail && isOwnerRequired(err)) setErrors({ email: t('staff.error.emailOwnerOnly') });
      else if (mail && isOwnerEmailAdminOnly(err)) setErrors({ email: t('staff.error.emailLeaveEmpty', { reason: OWNER_EMAIL_ADMIN_ONLY_MESSAGE }) });
      else if (isInvalidBranchIds(err)) setErrors({ branches: INVALID_BRANCH_IDS_MESSAGE });
      else setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ws-section" aria-labelledby="add-h">
      <h2 id="add-h">{t('staff.add')}</h2>
      <p className="ws-muted">
        {withEmailField ? t('staff.signInEmail') : t('staff.signIn')}
        {anyEmailField && !withEmailField && <> {t('staff.ownerEmailByJansetu')}</>}
      </p>
      <form className="rx-form" noValidate onSubmit={(e) => void submit(e)}>
        <div className="rx-form-row">
          <TextField label={t('staff.name')} value={name} onChange={(e) => setName(e.target.value)} error={errors.name} maxLength={MAX_NAME} autoComplete="off" />
          <TextField label={t('staff.mobile')} inputMode="numeric" maxLength={10} value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))} error={errors.phone} autoComplete="off" />
          {withEmailField && (
            <TextField label={t('staff.emailOptional')} type="email" inputMode="email" autoCapitalize="none" spellCheck={false} maxLength={MAX_EMAIL}
              value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} autoComplete="off" />
          )}
        </div>
        <fieldset className="ws-checks">
          <legend>{t('staff.role')}</legend>
          <label className="ws-check"><input type="radio" name="member-role" checked={role === 'staff'} onChange={() => setRole('staff')} /> {t('staff.role.staff')}</label>
          {canAddOwner(ctx.actor) && (
            <label className="ws-check"><input type="radio" name="member-role" checked={role === 'owner'} onChange={() => setRole('owner')} /> {t('staff.role.owner')}</label>
          )}
        </fieldset>
        {role === 'owner' ? (
          <p className="ws-muted">{t('staff.ownerCan')}</p>
        ) : (
          <>
            <PermissionChecklist legend={t('staff.permissions')} allowed={grantable} value={perms} onChange={setPerms} />
            {ctx.actor.role !== 'owner' && <p className="ws-muted">{t('staff.onlyYours')}</p>}
            <BranchPicker wide={wide} all={scope.all} ids={scope.ids} options={branches} loadError={branchesError} error={errors.branches} onChange={setScope} />
          </>
        )}
        {error && <Alert>{error}</Alert>}
        <div className="ws-actions">
          <Button type="submit" busy={busy}>{role === 'owner' ? t('staff.addOwner') : t('staff.addStaff')}</Button>
          <Button variant="ghost" disabled={busy} onClick={onCancel}>{shared('action.cancel')}</Button>
        </div>
      </form>
    </section>
  );
}

/**
 * A full replacement (permissions or branch access) edited from a baseline: right before sending, the member is read
 * again; if the server's value moved away from the baseline while the person was changing it, nothing is sent and the
 * form shows the saved value to review (a stale form never restores an old grant).
 */
function useMemberDraft<T extends object>(ctx: ScopeContext, member: PartnerMember, toDraft: (m: PartnerMember) => T, label: string) {
  const queryClient = useQueryClient();
  const d = useDraft(() => toDraft(member));
  const [stale, setStale] = useState<string | null>(null);
  const { rebaseTo } = d;
  const serverValue = JSON.stringify(toDraft(member));
  useEffect(() => {
    if (rebaseTo(JSON.parse(serverValue) as T).length) setStale(staleMessage([label]));
  }, [serverValue, rebaseTo, label]);
  const read = async () => {
    const fresh = await ctx.api.member(member._id);
    queryClient.setQueryData<PartnerMember[]>([...ctx.key, 'members'], (list) => list?.map((m) => (m._id === fresh._id ? fresh : m)));
    return fresh;
  };
  /**
   * Rebases onto the member as saved now. Returns that record (its `updatedAt` fences the save, Q10), or null (with a
   * message) when the person must review again.
   */
  const recheck = async (): Promise<PartnerMember | null> => {
    setStale(null);
    const fresh = await read();
    if (fresh.isActive === false) { setStale(t('staff.noLongerMember', { name: member.name })); return null; }
    if (rebaseTo(toDraft(fresh)).length) { setStale(staleMessage([label])); return null; }
    return fresh;
  };
  /** Q10: the save was refused because the member moved after `recheck`: show what is saved now. */
  const changedUnderSave = async () => {
    const fresh = await read();
    setStale(rebaseTo(toDraft(fresh)).length ? staleMessage([label]) : RECORD_CHANGED_MESSAGE);
  };
  /** Runs a save; a 409 RECORD_CHANGED shows the saved value instead of an error. True when saved. */
  const fenced = async (save: () => Promise<unknown>): Promise<boolean> => {
    try { await save(); return true; } catch (err) {
      if (!isRecordChanged(err)) throw err;
      await changedUnderSave();
      return false;
    }
  };
  return { d, stale, recheck, fenced };
}

const permsDraft = (m: PartnerMember) => ({ permissions: ordered(m.permissions) });

const emailDraft = (m: PartnerMember) => ({ email: m.email ?? '' });

/**
 * WQ9: a member's optional sign-in email, versioned like the other member edits (re-read before sending; 409
 * RECORD_CHANGED shows the saved value). Empty removes it. A late answer settles only while this editor is still open
 * and the save is still the latest one started here.
 */
function EditEmail({ ctx, member, admin, onClose, onSaved }:
  { ctx: ScopeContext; member: PartnerMember; admin: boolean; onClose: () => void; onSaved: () => Promise<void> }) {
  const queryClient = useQueryClient();
  const { d, stale, recheck, fenced } = useMemberDraft(ctx, member, emailDraft, t('staff.field.email'));
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const seq = useRef(0);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null); setNotice(null);
    const validated = memberEmail(d.current().draft.email);
    setFieldError(validated === null ? t('staff.email.invalid') : undefined);
    if (validated === null) return;
    if (validated === memberEmail(d.current().base.email)) { setNotice(t('common.nothingChanged')); return; }
    const mine = ++seq.current;
    const owns = () => live.current && seq.current === mine;
    setBusy(true);
    try {
      const fresh = await recheck();
      if (!owns() || !fresh) return;
      // Re-read the draft after the wait: anything but exactly the validated email is not sent.
      if (memberEmail(d.current().draft.email) !== validated) { setNotice(t('staff.email.changedWhileSaving')); return; }
      if (validated === memberEmail(d.current().base.email)) { setNotice(t('common.nothingChanged')); return; }
      const saved = await fenced(() => ctx.api.setEmail(member._id, validated || null, fresh.updatedAt));
      // Saved: the list shows it whatever happened to this editor meanwhile (closed, or replaced by another one);
      // only the editor's own notice and closing need it to still be the one on screen.
      if (saved && !owns()) await queryClient.invalidateQueries({ queryKey: [...ctx.key, 'members'] });
      if (saved && owns()) await onSaved();
    } catch (err) {
      if (!owns()) return;
      if (isEmailInUse(err)) setFieldError(EMAIL_IN_USE_MESSAGE);
      else if (isOwnerEmailAdminOnly(err)) setError(OWNER_EMAIL_ADMIN_ONLY_MESSAGE);
      else setError(messageOf(err));
    } finally {
      if (live.current) setBusy(false);
    }
  }

  return (
    <section className="ws-section" aria-labelledby="email-h">
      <h2 id="email-h">{t('staff.email.title', { name: member.name })}</h2>
      <p className="ws-muted">
        {t('staff.email.intro')}
        {/* A first email ends nothing; changing or removing one ends the member's sessions (`updateMemberEmail`). */}
        {member.email && <> {t(ctx.actor.memberId === member._id ? 'staff.email.signsOutYou' : 'staff.email.signsOut')}</>}
        {' '}{t('staff.email.told')}
        {member.role === 'owner' && admin && <> {t('staff.email.ownerByJansetu')}</>}
      </p>
      <form className="rx-form" noValidate onSubmit={(e) => void save(e)}>
        <fieldset className="ws-frozen" disabled={busy}>
          <TextField label={t('staff.email.label')} type="email" inputMode="email" autoCapitalize="none" spellCheck={false} maxLength={MAX_EMAIL} autoComplete="off"
            value={d.draft.email} onChange={(e) => d.set('email', e.target.value)} error={fieldError} />
        </fieldset>
        {stale && <Alert tone="warn">{stale}</Alert>}
        {notice && <Alert tone="ok">{notice}</Alert>}
        {error && <Alert>{error}</Alert>}
        <div className="ws-actions">
          <Button type="submit" busy={busy}>{t('staff.email.save')}</Button>
          <Button variant="ghost" disabled={busy} onClick={onClose}>{shared('action.cancel')}</Button>
        </div>
      </form>
    </section>
  );
}

function EditPermissions({ ctx, member, onClose, onSaved }:
  { ctx: ScopeContext; member: PartnerMember; onClose: () => void; onSaved: () => Promise<void> }) {
  const { d, stale, recheck, fenced } = useMemberDraft(ctx, member, permsDraft, t('staff.field.permissions'));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // WQ20c: what may be granted depends on the partner's kind (the wallet permissions are a lab's). Until the kind is read,
  // nothing is saved: a save then would drop a lab member's wallet access that is simply not offered yet.
  const partner = useWorkspacePartner(ctx);
  const kind = partner.data?.kind;
  const grantable = grantablePermissions(ctx.actor, kind);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null); setNotice(null);
    if (!kind) return;
    if (!changedFields(d.current()).permissions) { setNotice(t('common.nothingChanged')); return; }
    setBusy(true);
    try {
      const fresh = await recheck();
      if (!fresh || !live.current) return;
      const next = changedFields(d.current()).permissions;
      if (!next) { setNotice(t('common.nothingChanged')); return; }
      // Saved: the page says so and reads the list again; it closes this editor only if it is still the one open.
      if (await fenced(() => ctx.api.setPermissions(member._id, next.filter((p) => grantable.includes(p)), fresh.updatedAt))) await onSaved();
    } catch (err) {
      if (live.current) setError(messageOf(err));
    } finally {
      if (live.current) setBusy(false);
    }
  }

  return (
    <section className="ws-section" aria-labelledby="perm-h">
      <h2 id="perm-h">{t('staff.permissions.title', { name: member.name })}</h2>
      <form className="rx-form" noValidate onSubmit={(e) => void save(e)}>
        {partner.isPending ? <Loading label={t('staff.permissions.loading')} />
          : partner.isError ? <ErrorState message={messageOf(partner.error)} onRetry={() => void partner.refetch()} />
          : (
            <fieldset className="ws-frozen" disabled={busy}>
              <PermissionChecklist legend={t('staff.permissions')} allowed={grantable} value={d.draft.permissions} onChange={(v) => d.set('permissions', v)} />
            </fieldset>
          )}
        {stale && <Alert tone="warn">{stale}</Alert>}
        {notice && <Alert tone="ok">{notice}</Alert>}
        {error && <Alert>{error}</Alert>}
        <div className="ws-actions">
          <Button type="submit" busy={busy} disabled={!kind}>{t('staff.permissions.save')}</Button>
          <Button variant="ghost" disabled={busy} onClick={onClose}>{shared('action.cancel')}</Button>
        </div>
      </form>
    </section>
  );
}

/** One value: branch access is replaced whole. */
const scopeDraft = (m: PartnerMember) => ({ scope: { all: m.branchIds.length === 0, ids: [...m.branchIds].sort() } });
const scopeOf = (v: { all: boolean; ids: string[] }) => (v.all ? [] : v.ids);

function EditBranches({ ctx, member, branches, closedBranches, branchesError, onClose, onSaved }: {
  ctx: ScopeContext; member: PartnerMember; branches: Branch[] | undefined; closedBranches?: Branch[]; branchesError: string | null;
  onClose: () => void; onSaved: () => Promise<void>;
}) {
  const { d, stale, recheck, fenced } = useMemberDraft(ctx, member, scopeDraft, t('staff.field.branches'));
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const unchanged = () => { const s = d.current(); return JSON.stringify(scopeOf(s.draft.scope)) === JSON.stringify(scopeOf(s.base.scope)); };
  const wide = hasGlobalScope(ctx.actor);
  // WQ11b: branches the member holds that are not open. A partner-wide actor reads every open branch, so for them such an
  // id is closed (or removed); others name only the closed ones they can read. They are shown, and can be unticked.
  const openIds = new Set((branches ?? []).map((b) => b._id));
  const closedNames = new Map((closedBranches ?? []).filter((b) => b.isActive === false).map((b) => [b._id, b.name]));
  const held = branches ? member.branchIds.filter((id) => !openIds.has(id)) : [];
  const closed = new Set(held.filter((id) => wide || closedNames.has(id)));

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null); setNotice(null);
    // The validated scope is what is sent: an immutable copy, and the picker is frozen while saving.
    const now = d.current().draft.scope;
    const problem = branchProblem(ctx, now.all, now.ids, closed);
    setFieldError(problem ?? undefined);
    if (problem) return;
    if (unchanged()) { setNotice(t('common.nothingChanged')); return; }
    const validated = [...scopeOf(now)];
    setBusy(true);
    try {
      const fresh = await recheck();
      if (!fresh || !live.current) return;
      // Re-read the draft after the wait: anything but exactly the validated scope is not sent.
      const after = d.current().draft.scope;
      if (JSON.stringify(scopeOf(after)) !== JSON.stringify(validated)) { setNotice(t('staff.branches.changedWhileSaving')); return; }
      if (unchanged()) { setNotice(t('common.nothingChanged')); return; }
      // Saved: the page says so and reads the list again; it closes this editor only if it is still the one open.
      if (await fenced(() => ctx.api.setBranches(member._id, validated, fresh.updatedAt))) await onSaved();
    } catch (err) {
      if (!live.current) return;
      if (isInvalidBranchIds(err)) setFieldError(INVALID_BRANCH_IDS_MESSAGE);
      else setError(messageOf(err));
    } finally {
      if (live.current) setBusy(false);
    }
  }

  return (
    <section className="ws-section" aria-labelledby="scope-h">
      <h2 id="scope-h">{t('staff.branches.title', { name: member.name })}</h2>
      <form className="rx-form" noValidate onSubmit={(e) => void save(e)}>
        <fieldset className="ws-frozen" disabled={busy}>
          <BranchPicker wide={wide} all={d.draft.scope.all} ids={d.draft.scope.ids} options={branches} loadError={branchesError}
            held={held} closedNames={closedNames} error={fieldError} onChange={(v) => d.set('scope', v)} />
        </fieldset>
        {stale && <Alert tone="warn">{stale}</Alert>}
        {notice && <Alert tone="ok">{notice}</Alert>}
        {error && <Alert>{error}</Alert>}
        <div className="ws-actions">
          <Button type="submit" busy={busy}>{t('staff.branches.save')}</Button>
          <Button variant="ghost" disabled={busy} onClick={onClose}>{shared('action.cancel')}</Button>
        </div>
      </form>
    </section>
  );
}

/** "Pathologist · KMC-11". */
export const professionalLabel = (p: MemberProfessional) => `${PROFESSIONAL_KIND_LABEL[p.kind] ?? p.kind} · ${p.registrationNumber}`;

/** One value: the registration is replaced whole (or removed). */
const professionalDraft = (m: PartnerMember) => ({
  professional: { kind: m.professional?.kind ?? '', registrationNumber: m.professional?.registrationNumber ?? '' },
});
const sameProfessional = (a: MemberProfessional | null | undefined, b: MemberProfessional | null | undefined) =>
  (a?.kind ?? '') === (b?.kind ?? '') && (a?.registrationNumber ?? '') === (b?.registrationNumber ?? '');

/**
 * Q11: the professional registration a member signs reports under (`setMemberProfessional`). Owners only, admins acting as
 * owner included (403 OWNER_REQUIRED otherwise). Versioned like the other member edits: the member is read again right
 * before sending and the save names its `updatedAt` (409 RECORD_CHANGED shows the saved value). Removing it is confirmed
 * first. An answer settles only while this editor is open and the save is the latest started here; an answer that never
 * arrived is settled by reading the member again (saved = the member now holds exactly what was sent).
 */
function EditProfessional({ ctx, member, onClose, onSaved }:
  { ctx: ScopeContext; member: PartnerMember; onClose: () => void; onSaved: (removed: boolean) => Promise<void> }) {
  const queryClient = useQueryClient();
  const { d, stale, recheck, fenced } = useMemberDraft(ctx, member, professionalDraft, t('staff.field.registration'));
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ kind?: string; registrationNumber?: string }>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const seq = useRef(0);
  const base = () => { const b = d.current().base.professional; return b.registrationNumber ? (b as MemberProfessional) : null; };

  /** Sends `next` (null removes) on the member as read right before. True when this editor may close. */
  async function send(next: MemberProfessional | null, typed: () => MemberProfessional | null): Promise<void> {
    setError(null); setNotice(null);
    if (sameProfessional(next, base())) { setNotice(t('common.nothingChanged')); return; }
    const mine = ++seq.current;
    const owns = () => live.current && seq.current === mine;
    setBusy(true);
    try {
      const fresh = await recheck();
      if (!owns() || !fresh) return;
      // Re-read the draft after the wait: anything but exactly the checked value is not sent.
      if (!sameProfessional(typed(), next)) { setNotice(t('staff.registration.changedWhileSaving')); return; }
      if (sameProfessional(next, base())) { setNotice(t('common.nothingChanged')); return; }
      const saved = await fenced(() => ctx.api.setProfessional(member._id, next, fresh.updatedAt));
      if (saved && !owns()) await queryClient.invalidateQueries({ queryKey: [...ctx.key, 'members'] });
      if (saved && owns()) await onSaved(next === null);
    } catch (err) {
      if (!owns()) return;
      if (!definitelyNotRecorded(err)) {
        // The answer was lost: the member as saved now tells whether it went through.
        try {
          const now = await ctx.api.member(member._id);
          queryClient.setQueryData<PartnerMember[]>([...ctx.key, 'members'], (list) => list?.map((m) => (m._id === now._id ? now : m)));
          if (!owns()) return;
          if (sameProfessional(now.professional ?? null, next)) { await onSaved(next === null); return; }
        } catch { /* still unknown: say so below */ }
        if (owns()) setError(t('staff.registration.notConfirmed', { reason: messageOf(err) }));
        return;
      }
      setError(messageOf(err));
    } finally {
      if (live.current) setBusy(false);
    }
  }

  function save(e: FormEvent) {
    e.preventDefault();
    const p = d.current().draft.professional;
    const checked = professionalInput(p.kind, p.registrationNumber);
    if ('problem' in checked) { setFieldErrors(checked.problem); return; }
    setFieldErrors({});
    void send(checked.value, () => {
      const now = professionalInput(d.current().draft.professional.kind, d.current().draft.professional.registrationNumber);
      return 'value' in now ? now.value : null;
    });
  }

  const p = d.draft.professional;
  const held = member.professional?.registrationNumber ? member.professional : null;
  return (
    <section className="ws-section" aria-labelledby="prof-h">
      <h2 id="prof-h">{t('staff.registration.title', { name: member.name })}</h2>
      <p className="ws-muted">{t('staff.registration.intro')}</p>
      <form className="rx-form" noValidate onSubmit={save}>
        <fieldset className="ws-frozen" disabled={busy}>
          <div className="rx-form-row">
            <div className="j-field">
              <label htmlFor="prof-kind">{t('staff.registration.kind')}</label>
              <select id="prof-kind" value={p.kind} aria-describedby={fieldErrors.kind ? 'prof-kind-err' : undefined}
                onChange={(e) => d.set('professional', { ...d.current().draft.professional, kind: e.target.value as MemberProfessional['kind'] })}>
                <option value="">{t('staff.registration.choose')}</option>
                {PROFESSIONAL_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
              </select>
              {fieldErrors.kind && <span id="prof-kind-err" className="j-field__error">{fieldErrors.kind}</span>}
            </div>
            <TextField label={t('staff.registration.number')} value={p.registrationNumber} maxLength={MAX_REGISTRATION_INPUT} autoComplete="off" spellCheck={false}
              error={fieldErrors.registrationNumber}
              onChange={(e) => d.set('professional', { ...d.current().draft.professional, registrationNumber: e.target.value })} />
          </div>
        </fieldset>
        {stale && <Alert tone="warn">{stale}</Alert>}
        {notice && <Alert tone="ok">{notice}</Alert>}
        {error && <Alert>{error}</Alert>}
        <div className="ws-actions">
          <Button type="submit" busy={busy}>{t('staff.registration.save')}</Button>
          <Button variant="ghost" disabled={busy} onClick={onClose}>{shared('action.cancel')}</Button>
        </div>
      </form>
      {held && (
        <ConfirmAction label={t('staff.registration.remove')} danger disabled={busy} confirmLabel={t('staff.registration.removeName', { name: member.name })}
          consequence={t('staff.registration.remove.consequence', { name: member.name })}
          onConfirm={() => send(null, () => null)} />
      )}
    </section>
  );
}

/** A little room over the server's 60 so a pasted number with spaces around it is trimmed, not cut. */
const MAX_REGISTRATION_INPUT = 64;
