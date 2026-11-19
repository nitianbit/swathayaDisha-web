import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ALL_PARTNER_PERMISSIONS, canAddOwner, canChangeBranches, canEditEmail, canEditPermissions, EMAIL_IN_USE_MESSAGE, grantablePermissions,
  hasGlobalScope, isEmailInUse, MAX_EMAIL, MAX_NAME, memberEmail, PARTNER_PERMISSIONS, PARTNER_PHONE_PATTERN, PERMISSION_LABEL, removalBlock, scopeProblem,
  type Branch, type MemberRole, type PartnerMember, type PartnerPermission,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, Loading, TextField } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { changedFields, isRecordChanged, RECORD_CHANGED_MESSAGE, staleMessage, useDraft } from '../../draft.ts';
import { messageOf } from '../../errors.ts';
import {
  branchLabel, NoSuchPartner, PartnerPageHeading, scopeIdentity, useBranches, usePartnerScope, useWorkspacePartner, type ScopeContext,
} from './scope.tsx';

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

type Editing = { kind: 'permissions' | 'branches' | 'email'; id: string } | null;

function Staff({ ctx }: { ctx: ScopeContext }) {
  const queryClient = useQueryClient();
  const partner = useWorkspacePartner(ctx);
  const members = useQuery({ queryKey: [...ctx.key, 'members'], queryFn: () => ctx.api.members() });
  const branches = useBranches(ctx);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const names = new Map((branches.data ?? []).map((b) => [b._id, b.name]));
  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: [...ctx.key, 'members'] }),
    queryClient.invalidateQueries({ queryKey: [...ctx.key, 'me'] }), // the owner count
  ]);
  const editTarget = editing ? members.data?.find((m) => m._id === editing.id) : undefined;
  const open = (e: Editing) => { setEditing(e); setNotice(null); };

  return (
    <>
      <PartnerPageHeading ctx={ctx} title="Staff" partnerName={partner.data?.name}>Who can use this workspace, and what each person may do.</PartnerPageHeading>
      {notice && <Alert tone="ok">{notice}</Alert>}
      {!adding && <div><Button onClick={() => { setAdding(true); setNotice(null); }}>Add a staff member</Button></div>}
      {adding && (
        <AddMember ctx={ctx} branches={branches.data} branchesError={branches.isError ? messageOf(branches.error) : null}
          onCancel={() => setAdding(false)}
          onAdded={async (m) => { setAdding(false); setNotice(`${m.name} was added.`); await refresh(); }} />
      )}
      {members.isPending ? <Loading label="Loading staff…" />
        : members.isError ? <ErrorState message={messageOf(members.error)} onRetry={() => void members.refetch()} />
        : members.data.length === 0 ? <Empty title="No staff you can manage">People you add appear here.</Empty>
        : (
          <div className="ws-table-wrap">
            <table className="j-table">
              <caption className="j-sr-only">Staff members</caption>
              <thead>
                <tr><th scope="col">Name</th><th scope="col">Phone</th><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Permissions</th><th scope="col">Branches</th><th scope="col">Actions</th></tr>
              </thead>
              <tbody>
                {members.data.map((m) => {
                  const block = removalBlock(ctx.actor, m, partner.data?.activeOwnerCount);
                  return (
                    <tr key={m._id}>
                      <td>{m.name}{ctx.actor.memberId === m._id && <> <Badge>You</Badge></>}</td>
                      <td>{m.phone}</td>
                      <td>{m.email || <span className="ws-muted">None</span>}</td>
                      <td>{m.role === 'owner' ? 'Owner' : 'Staff'}</td>
                      <td>{m.role === 'owner' ? 'Everything' : m.permissions.length ? m.permissions.map((p) => PERMISSION_LABEL[p] ?? p).join(', ') : 'None'}</td>
                      <td>{m.role === 'owner' ? 'All branches' : branchLabel(names, m.branchIds)}</td>
                      <td>
                        <div className="ws-actions">
                          {canEditPermissions(ctx.actor, m) && (
                            <Button variant="secondary" onClick={() => open({ kind: 'permissions', id: m._id })}>Edit permissions</Button>
                          )}
                          {canEditEmail(ctx.actor, m) && (
                            <Button variant="secondary" onClick={() => open({ kind: 'email', id: m._id })}>{m.email ? 'Change email' : 'Add email'}</Button>
                          )}
                          {canChangeBranches(ctx.actor, m) && (
                            <Button variant="secondary" onClick={() => open({ kind: 'branches', id: m._id })}>Change branch access</Button>
                          )}
                          {block ? <span className="ws-muted">{block}</span> : (
                            <ConfirmAction label="Remove" danger confirmLabel={`Remove ${m.name}`}
                              consequence={`${m.name} loses access to this workspace at once. To give access again, add them again.`}
                              onConfirm={async () => {
                                try { await ctx.api.removeMember(m._id); setNotice(`${m.name} was removed.`); } finally { await refresh(); }
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
          onSaved={async () => { setEditing(null); setNotice(`Permissions for ${editTarget.name} were saved.`); await refresh(); }} />
      )}
      {editTarget && editing?.kind === 'email' && (
        <EditEmail key={`e:${editTarget._id}`} ctx={ctx} member={editTarget} onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); setNotice(`The email for ${editTarget.name} was saved.`); await refresh(); }} />
      )}
      {editTarget && editing?.kind === 'branches' && (
        <EditBranches key={`b:${editTarget._id}`} ctx={ctx} member={editTarget} branches={branches.data}
          branchesError={branches.isError ? messageOf(branches.error) : null} onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); setNotice(`Branch access for ${editTarget.name} was saved.`); await refresh(); }} />
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
      {shown.length === 0 ? <p className="ws-muted">You hold no permissions you can give.</p> : shown.map((p) => (
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

/** Branch access picker: "all branches" (partner-wide actors only) or some of the branches this actor can see. */
function BranchPicker({ wide, all, ids, options, loadError, error, onChange }: {
  wide: boolean; all: boolean; ids: readonly string[]; options: readonly Branch[] | undefined; loadError: string | null; error?: string;
  onChange: (v: { all: boolean; ids: string[] }) => void;
}) {
  return (
    <fieldset className="ws-checks" aria-describedby={error ? 'branch-error' : undefined}>
      <legend>Branches</legend>
      {wide && (
        <label className="ws-check">
          <input type="checkbox" checked={all} onChange={(e) => onChange({ all: e.target.checked, ids: [...ids] })} /> All branches, including new ones
        </label>
      )}
      {!all && (options ?? []).map((b) => (
        <label key={b._id} className="ws-check">
          <input type="checkbox" checked={ids.includes(b._id)} onChange={(e) =>
            onChange({ all, ids: (e.target.checked ? [...ids, b._id] : ids.filter((x) => x !== b._id)).sort() })} /> {b.name}
        </label>
      ))}
      {!all && options?.length === 0 && <p className="ws-muted">There are no branches yet.</p>}
      {!all && loadError && <p className="ws-muted">Branches could not be loaded: {loadError}</p>}
      {error && <span id="branch-error" className="j-field__error">{error}</span>}
    </fieldset>
  );
}

const branchProblem = (ctx: ScopeContext, all: boolean, ids: string[]) =>
  !all && ids.length === 0 ? 'Choose at least one branch, or all branches.' : scopeProblem(ctx.actor, all ? [] : ids);

function AddMember({ ctx, branches, branchesError, onCancel, onAdded }: {
  ctx: ScopeContext; branches: Branch[] | undefined; branchesError: string | null;
  onCancel: () => void; onAdded: (m: PartnerMember) => Promise<void>;
}) {
  const wide = hasGlobalScope(ctx.actor);
  const grantable = grantablePermissions(ctx.actor);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<MemberRole>('staff');
  const [perms, setPerms] = useState<PartnerPermission[]>([]);
  const [scope, setScope] = useState<{ all: boolean; ids: string[] }>({ all: wide, ids: [] });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = 'Enter the person’s name.';
    else if (name.trim().length > MAX_NAME) errs.name = `Use at most ${MAX_NAME} characters.`;
    if (!PARTNER_PHONE_PATTERN.test(phone)) errs.phone = 'Enter the 10-digit mobile number.';
    const mail = memberEmail(email);
    if (mail === null) errs.email = 'Enter a valid email address, or leave it empty.';
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
      else setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ws-section" aria-labelledby="add-h">
      <h2 id="add-h">Add a staff member</h2>
      <p className="ws-muted">They sign in with this mobile number (a code by SMS), or with the email if you add one (a code by email).</p>
      <form className="rx-form" noValidate onSubmit={(e) => void submit(e)}>
        <div className="rx-form-row">
          <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} maxLength={MAX_NAME} autoComplete="off" />
          <TextField label="Mobile number" inputMode="numeric" maxLength={10} value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))} error={errors.phone} autoComplete="off" />
          <TextField label="Email (optional)" type="email" inputMode="email" autoCapitalize="none" spellCheck={false} maxLength={MAX_EMAIL}
            value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} autoComplete="off" />
        </div>
        <fieldset className="ws-checks">
          <legend>Role</legend>
          <label className="ws-check"><input type="radio" name="member-role" checked={role === 'staff'} onChange={() => setRole('staff')} /> Staff</label>
          {canAddOwner(ctx.actor) && (
            <label className="ws-check"><input type="radio" name="member-role" checked={role === 'owner'} onChange={() => setRole('owner')} /> Owner</label>
          )}
        </fieldset>
        {role === 'owner' ? (
          <p className="ws-muted">An owner can do everything, in every branch, including managing other owners.</p>
        ) : (
          <>
            <PermissionChecklist legend="Permissions" allowed={grantable} value={perms} onChange={setPerms} />
            {ctx.actor.role !== 'owner' && <p className="ws-muted">You can give only permissions you hold yourself.</p>}
            <BranchPicker wide={wide} all={scope.all} ids={scope.ids} options={branches} loadError={branchesError} error={errors.branches} onChange={setScope} />
          </>
        )}
        {error && <Alert>{error}</Alert>}
        <div className="ws-actions">
          <Button type="submit" busy={busy}>Add {role === 'owner' ? 'owner' : 'staff member'}</Button>
          <Button variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
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
    if (fresh.isActive === false) { setStale(`${member.name} is no longer a member.`); return null; }
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
function EditEmail({ ctx, member, onClose, onSaved }:
  { ctx: ScopeContext; member: PartnerMember; onClose: () => void; onSaved: () => Promise<void> }) {
  const { d, stale, recheck, fenced } = useMemberDraft(ctx, member, emailDraft, 'email');
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
    setFieldError(validated === null ? 'Enter a valid email address, or leave it empty to remove it.' : undefined);
    if (validated === null) return;
    if (validated === memberEmail(d.current().base.email)) { setNotice('Nothing has changed.'); return; }
    const mine = ++seq.current;
    const owns = () => live.current && seq.current === mine;
    setBusy(true);
    try {
      const fresh = await recheck();
      if (!owns() || !fresh) return;
      // Re-read the draft after the wait: anything but exactly the validated email is not sent.
      if (memberEmail(d.current().draft.email) !== validated) { setNotice('The email changed while saving. Check it and save again.'); return; }
      if (validated === memberEmail(d.current().base.email)) { setNotice('Nothing has changed.'); return; }
      const saved = await fenced(() => ctx.api.setEmail(member._id, validated || null, fresh.updatedAt));
      if (saved && owns()) await onSaved();
    } catch (err) {
      if (!owns()) return;
      if (isEmailInUse(err)) setFieldError(EMAIL_IN_USE_MESSAGE);
      else setError(messageOf(err));
    } finally {
      if (live.current) setBusy(false);
    }
  }

  return (
    <section className="ws-section" aria-labelledby="email-h">
      <h2 id="email-h">Email for {member.name}</h2>
      <p className="ws-muted">They can sign in with this email (a code by email) as well as with their mobile number. Leave it empty to remove it.</p>
      <form className="rx-form" noValidate onSubmit={(e) => void save(e)}>
        <fieldset className="ws-frozen" disabled={busy}>
          <TextField label="Email" type="email" inputMode="email" autoCapitalize="none" spellCheck={false} maxLength={MAX_EMAIL} autoComplete="off"
            value={d.draft.email} onChange={(e) => d.set('email', e.target.value)} error={fieldError} />
        </fieldset>
        {stale && <Alert tone="warn">{stale}</Alert>}
        {notice && <Alert tone="ok">{notice}</Alert>}
        {error && <Alert>{error}</Alert>}
        <div className="ws-actions">
          <Button type="submit" busy={busy}>Save email</Button>
          <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </section>
  );
}

function EditPermissions({ ctx, member, onClose, onSaved }:
  { ctx: ScopeContext; member: PartnerMember; onClose: () => void; onSaved: () => Promise<void> }) {
  const { d, stale, recheck, fenced } = useMemberDraft(ctx, member, permsDraft, 'permissions');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const grantable = grantablePermissions(ctx.actor);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null); setNotice(null);
    if (!changedFields(d.current()).permissions) { setNotice('Nothing has changed.'); return; }
    setBusy(true);
    try {
      const fresh = await recheck();
      if (!fresh) return;
      const next = changedFields(d.current()).permissions;
      if (!next) { setNotice('Nothing has changed.'); return; }
      if (await fenced(() => ctx.api.setPermissions(member._id, next.filter((p) => grantable.includes(p)), fresh.updatedAt))) await onSaved();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ws-section" aria-labelledby="perm-h">
      <h2 id="perm-h">Permissions for {member.name}</h2>
      <form className="rx-form" noValidate onSubmit={(e) => void save(e)}>
        <fieldset className="ws-frozen" disabled={busy}>
          <PermissionChecklist legend="Permissions" allowed={grantable} value={d.draft.permissions} onChange={(v) => d.set('permissions', v)} />
        </fieldset>
        {stale && <Alert tone="warn">{stale}</Alert>}
        {notice && <Alert tone="ok">{notice}</Alert>}
        {error && <Alert>{error}</Alert>}
        <div className="ws-actions">
          <Button type="submit" busy={busy}>Save permissions</Button>
          <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </section>
  );
}

/** One value: branch access is replaced whole. */
const scopeDraft = (m: PartnerMember) => ({ scope: { all: m.branchIds.length === 0, ids: [...m.branchIds].sort() } });
const scopeOf = (v: { all: boolean; ids: string[] }) => (v.all ? [] : v.ids);

function EditBranches({ ctx, member, branches, branchesError, onClose, onSaved }: {
  ctx: ScopeContext; member: PartnerMember; branches: Branch[] | undefined; branchesError: string | null;
  onClose: () => void; onSaved: () => Promise<void>;
}) {
  const { d, stale, recheck, fenced } = useMemberDraft(ctx, member, scopeDraft, 'branch access');
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const unchanged = () => { const s = d.current(); return JSON.stringify(scopeOf(s.draft.scope)) === JSON.stringify(scopeOf(s.base.scope)); };

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null); setNotice(null);
    // The validated scope is what is sent: an immutable copy, and the picker is frozen while saving.
    const now = d.current().draft.scope;
    const problem = branchProblem(ctx, now.all, now.ids);
    setFieldError(problem ?? undefined);
    if (problem) return;
    if (unchanged()) { setNotice('Nothing has changed.'); return; }
    const validated = [...scopeOf(now)];
    setBusy(true);
    try {
      const fresh = await recheck();
      if (!fresh) return;
      // Re-read the draft after the wait: anything but exactly the validated scope is not sent.
      const after = d.current().draft.scope;
      if (JSON.stringify(scopeOf(after)) !== JSON.stringify(validated)) { setNotice('The branch choice changed while saving. Check it and save again.'); return; }
      if (unchanged()) { setNotice('Nothing has changed.'); return; }
      if (await fenced(() => ctx.api.setBranches(member._id, validated, fresh.updatedAt))) await onSaved();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ws-section" aria-labelledby="scope-h">
      <h2 id="scope-h">Branch access for {member.name}</h2>
      <form className="rx-form" noValidate onSubmit={(e) => void save(e)}>
        <fieldset className="ws-frozen" disabled={busy}>
          <BranchPicker wide={hasGlobalScope(ctx.actor)} all={d.draft.scope.all} ids={d.draft.scope.ids} options={branches} loadError={branchesError}
            error={fieldError} onChange={(v) => d.set('scope', v)} />
        </fieldset>
        {stale && <Alert tone="warn">{stale}</Alert>}
        {notice && <Alert tone="ok">{notice}</Alert>}
        {error && <Alert>{error}</Alert>}
        <div className="ws-actions">
          <Button type="submit" busy={busy}>Save branch access</Button>
          <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </section>
  );
}
