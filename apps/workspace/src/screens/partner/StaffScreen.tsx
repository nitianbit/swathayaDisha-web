import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  canAddOwner, canEditPermissions, grantablePermissions, hasGlobalScope, MAX_NAME, PARTNER_PERMISSIONS, PARTNER_PHONE_PATTERN,
  PERMISSION_LABEL, removalBlock, scopeProblem, type Branch, type MemberRole, type PartnerMember, type PartnerPermission,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, Loading, TextField } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { messageOf } from '../../errors.ts';
import { NoSuchPartner, PartnerPageHeading, usePartnerScope, useWorkspacePartner, type ScopeContext } from './scope.tsx';

/**
 * Staff of a partner (`staff.manage`). Mirrors the backend's rules (`partners/services`): only owners add owners or
 * change permissions; staff grant only permissions they hold and only within their own branches; nobody removes
 * themselves or the last owner. The server decides and its message is shown.
 */
export function StaffScreen() {
  const ctx = usePartnerScope();
  if (!ctx) return <NoSuchPartner />;
  return <Staff ctx={ctx} />;
}

/**
 * Active branches this actor can see. Since Q8 every member may read them (`GET /branches` with no permission; the
 * server returns only the branches in the member's scope).
 */
export function useBranches(ctx: ScopeContext) {
  return useQuery({ queryKey: [...ctx.key, 'branches'], queryFn: () => ctx.api.branches() });
}

export const branchLabel = (names: Map<string, string>, ids: readonly string[]) =>
  ids.length === 0 ? 'All branches' : ids.map((id) => names.get(id) ?? `Branch …${id.slice(-6)}`).join(', ');

function Staff({ ctx }: { ctx: ScopeContext }) {
  const queryClient = useQueryClient();
  const partner = useWorkspacePartner(ctx);
  const members = useQuery({ queryKey: [...ctx.key, 'members'], queryFn: () => ctx.api.members() });
  const branches = useBranches(ctx);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const names = new Map((branches.data ?? []).map((b) => [b._id, b.name]));
  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: [...ctx.key, 'members'] }),
    queryClient.invalidateQueries({ queryKey: [...ctx.key, 'me'] }), // the owner count
  ]);
  const editTarget = members.data?.find((m) => m._id === editing);

  return (
    <>
      <PartnerPageHeading ctx={ctx} title="Staff" partnerName={partner.data?.name}>Who can use this workspace, and what each person may do.</PartnerPageHeading>
      {notice && <Alert tone="ok">{notice}</Alert>}
      {!adding && <div><Button onClick={() => { setAdding(true); setNotice(null); }}>Add a staff member</Button></div>}
      {adding && (
        <AddMember ctx={ctx} branches={branches.data}
          branchesError={branches.isError ? messageOf(branches.error) : null}
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
                <tr><th scope="col">Name</th><th scope="col">Phone</th><th scope="col">Role</th><th scope="col">Permissions</th><th scope="col">Branches</th><th scope="col">Actions</th></tr>
              </thead>
              <tbody>
                {members.data.map((m) => {
                  const block = removalBlock(ctx.actor, m, partner.data?.activeOwnerCount);
                  return (
                    <tr key={m._id}>
                      <td>{m.name}{ctx.actor.memberId === m._id && <> <Badge>You</Badge></>}</td>
                      <td>{m.phone}</td>
                      <td>{m.role === 'owner' ? 'Owner' : 'Staff'}</td>
                      <td>{m.role === 'owner' ? 'Everything' : m.permissions.length ? m.permissions.map((p) => PERMISSION_LABEL[p] ?? p).join(', ') : 'None'}</td>
                      <td>{m.role === 'owner' ? 'All branches' : branchLabel(names, m.branchIds)}</td>
                      <td>
                        <div className="ws-actions">
                          {canEditPermissions(ctx.actor, m) && (
                            <Button variant="secondary" onClick={() => { setEditing(m._id); setNotice(null); }}>Edit permissions</Button>
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
      {editTarget && (
        <EditPermissions key={editTarget._id} ctx={ctx} member={editTarget} onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); setNotice(`Permissions for ${editTarget.name} were saved.`); await refresh(); }} />
      )}
    </>
  );
}

function PermissionChecklist({ legend, allowed, value, onChange, error }:
  { legend: string; allowed: readonly PartnerPermission[]; value: Set<PartnerPermission>; onChange: (v: Set<PartnerPermission>) => void; error?: string }) {
  const shown = PARTNER_PERMISSIONS.filter((p) => allowed.includes(p.value));
  return (
    <fieldset className="ws-checks" aria-describedby={error ? 'perm-error' : undefined}>
      <legend>{legend}</legend>
      {shown.length === 0 ? <p className="ws-muted">You hold no permissions you can give.</p> : shown.map((p) => (
        <label key={p.value} className="ws-check">
          <input type="checkbox" checked={value.has(p.value)} onChange={(e) => {
            const next = new Set(value);
            if (e.target.checked) next.add(p.value); else next.delete(p.value);
            onChange(next);
          }} />
          {p.label}
        </label>
      ))}
      {error && <span id="perm-error" className="j-field__error">{error}</span>}
    </fieldset>
  );
}

function AddMember({ ctx, branches, branchesError, onCancel, onAdded }: {
  ctx: ScopeContext; branches: Branch[] | undefined; branchesError: string | null;
  onCancel: () => void; onAdded: (m: PartnerMember) => Promise<void>;
}) {
  const wide = hasGlobalScope(ctx.actor);
  const grantable = grantablePermissions(ctx.actor);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<MemberRole>('staff');
  const [perms, setPerms] = useState<Set<PartnerPermission>>(new Set());
  const [allBranches, setAllBranches] = useState(wide);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The branches this actor may hand out: the ones it can see (already limited to its scope by the server), or, when
  // branch names cannot be read, its own branch ids.
  const options: { id: string; name: string }[] = branches
    ? branches.map((b) => ({ id: b._id, name: b.name }))
    : wide ? [] : ctx.actor.branchIds.map((id) => ({ id, name: `Branch …${id.slice(-6)}` }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = 'Enter the person’s name.';
    else if (name.trim().length > MAX_NAME) errs.name = `Use at most ${MAX_NAME} characters.`;
    if (!PARTNER_PHONE_PATTERN.test(phone)) errs.phone = 'Enter the 10-digit mobile number.';
    const branchIds = allBranches ? [] : [...chosen];
    if (role === 'staff') {
      const problem = !allBranches && branchIds.length === 0 ? 'Choose at least one branch, or all branches.' : scopeProblem(ctx.actor, branchIds);
      if (problem) errs.branches = problem;
    }
    setErrors(errs); setError(null);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const added = await ctx.api.addMember(role === 'owner'
        ? { name: name.trim(), phone, role: 'owner', permissions: [] }
        : { name: name.trim(), phone, role: 'staff', permissions: grantable.filter((p) => perms.has(p)), branchIds });
      await onAdded(added);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ws-section" aria-labelledby="add-h">
      <h2 id="add-h">Add a staff member</h2>
      <p className="ws-muted">They sign in with this mobile number and a code sent by SMS.</p>
      <form className="rx-form" noValidate onSubmit={(e) => void submit(e)}>
        <div className="rx-form-row">
          <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} maxLength={MAX_NAME} autoComplete="off" />
          <TextField label="Mobile number" inputMode="numeric" maxLength={10} value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))} error={errors.phone} autoComplete="off" />
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
            <fieldset className="ws-checks" aria-describedby={errors.branches ? 'branch-error' : undefined}>
              <legend>Branches</legend>
              {wide && (
                <label className="ws-check">
                  <input type="checkbox" checked={allBranches} onChange={(e) => setAllBranches(e.target.checked)} /> All branches, including new ones
                </label>
              )}
              {!allBranches && options.map((b) => (
                <label key={b.id} className="ws-check">
                  <input type="checkbox" checked={chosen.has(b.id)} onChange={(e) => {
                    const next = new Set(chosen);
                    if (e.target.checked) next.add(b.id); else next.delete(b.id);
                    setChosen(next);
                  }} /> {b.name}
                </label>
              ))}
              {!allBranches && options.length === 0 && (
                <p className="ws-muted">{branchesError ? `Branches could not be loaded: ${branchesError}` : 'There are no branches yet.'}</p>
              )}
              {errors.branches && <span id="branch-error" className="j-field__error">{errors.branches}</span>}
            </fieldset>
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

function EditPermissions({ ctx, member, onClose, onSaved }:
  { ctx: ScopeContext; member: PartnerMember; onClose: () => void; onSaved: () => Promise<void> }) {
  const [perms, setPerms] = useState<Set<PartnerPermission>>(new Set(member.permissions));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const grantable = grantablePermissions(ctx.actor);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await ctx.api.setPermissions(member._id, grantable.filter((p) => perms.has(p)));
      await onSaved();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ws-section" aria-labelledby="perm-h">
      <h2 id="perm-h">Permissions for {member.name}</h2>
      <p className="ws-muted">Branch access stays as it is: {member.branchIds.length ? 'only the branches given when they were added' : 'all branches'}.</p>
      <form className="rx-form" noValidate onSubmit={(e) => void save(e)}>
        <PermissionChecklist legend="Permissions" allowed={grantable} value={perms} onChange={setPerms} />
        {error && <Alert>{error}</Alert>}
        <div className="ws-actions">
          <Button type="submit" busy={busy}>Save permissions</Button>
          <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </section>
  );
}
