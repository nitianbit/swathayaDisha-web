import { useQuery } from '@tanstack/react-query';
import { PERMISSION_LABEL, type PartnerAuditEvent, type PartnerPermission } from '@jansetu/api';
import { Empty, ErrorState, formatDateTime, Loading } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { NoSuchPartner, PartnerPageHeading, usePartnerScope, useWorkspacePartner, type ScopeContext } from './scope.tsx';
import { useBranches } from './StaffScreen.tsx';

const ACTION_LABEL: Record<string, string> = {
  'partner.profile.update': 'Changed the profile',
  'member.add': 'Added a member',
  'member.remove': 'Removed a member',
  'member.permissions': 'Changed permissions',
  'branch.create': 'Added a branch',
  'branch.update': 'Changed a branch',
  'branch.deactivate': 'Deactivated a branch',
};

const FIELD_LABEL: Record<string, string> = {
  name: 'name', legalName: 'legal name', contactPhone: 'contact phone', contactEmail: 'contact email', logo: 'logo',
  address: 'address', phone: 'phone', hours: 'hours', holidays: 'holidays', services: 'services', geo: 'location',
};

/** A short, human summary of what an event changed (permissions and field names only; never other data). */
export function auditDetail(e: Pick<PartnerAuditEvent, 'action' | 'detail'>): string {
  const d = e.detail ?? {};
  const perms = Array.isArray(d.permissions) ? (d.permissions as string[]).map((p) => PERMISSION_LABEL[p as PartnerPermission] ?? p) : null;
  const fields = Array.isArray(d.fields) ? (d.fields as string[]).map((f) => FIELD_LABEL[f] ?? f) : null;
  const parts: string[] = [];
  if (d.role === 'owner') parts.push('as owner');
  if (perms) parts.push(perms.length ? perms.join(', ') : 'no permissions');
  if (fields?.length) parts.push(fields.join(', '));
  return parts.join(' · ');
}

/** The partner's activity log (latest 100): who did what to which record. Owners and all-branch staff only. */
export function AuditScreen() {
  const ctx = usePartnerScope();
  if (!ctx) return <NoSuchPartner />;
  return <Audit ctx={ctx} />;
}

function Audit({ ctx }: { ctx: ScopeContext }) {
  const partner = useWorkspacePartner(ctx);
  const events = useQuery({ queryKey: [...ctx.key, 'audit'], queryFn: () => ctx.api.audit() });
  // Names for people and branches still active; removed ones are named as such.
  const members = useQuery({ queryKey: [...ctx.key, 'members'], queryFn: () => ctx.api.members() });
  const branches = useBranches(ctx);
  const memberName = new Map((members.data ?? []).map((m) => [m._id, m.name]));
  const branchName = new Map((branches.data ?? []).map((b) => [b._id, b.name]));

  const actor = (e: PartnerAuditEvent) => (e.actorKind === 'admin' ? 'Jansetu admin'
    : memberName.get(e.actorId) ?? (e.actorId === ctx.actor.memberId ? 'You' : 'A former member'));
  const target = (e: PartnerAuditEvent) => {
    if (!e.targetKind) return '—';
    if (e.targetKind === 'partner') return 'Profile';
    if (e.targetKind === 'member') return memberName.get(e.targetId ?? '') ?? 'A former member';
    if (e.targetKind === 'branch') return branchName.get(e.targetId ?? '') ?? `Branch …${(e.targetId ?? '').slice(-6)}`;
    return e.targetKind;
  };

  return (
    <>
      <PartnerPageHeading ctx={ctx} title="Activity log" partnerName={partner.data?.name}>The latest 100 changes, newest first.</PartnerPageHeading>
      {events.isPending ? <Loading label="Loading activity…" />
        : events.isError ? <ErrorState message={messageOf(events.error)} onRetry={() => void events.refetch()} />
        : events.data.length === 0 ? <Empty title="No activity yet" />
        : (
          <div className="ws-table-wrap">
            <table className="j-table">
              <caption className="j-sr-only">Activity log</caption>
              <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">What</th><th scope="col">Record</th><th scope="col">Details</th></tr></thead>
              <tbody>
                {events.data.map((e) => (
                  <tr key={e._id}>
                    <td>{formatDateTime(e.at)}</td>
                    <td>{actor(e)}</td>
                    <td>{ACTION_LABEL[e.action] ?? e.action}</td>
                    <td>{target(e)}</td>
                    <td>{auditDetail(e) || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </>
  );
}
