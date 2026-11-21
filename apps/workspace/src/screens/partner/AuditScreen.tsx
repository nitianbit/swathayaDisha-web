import { useQuery } from '@tanstack/react-query';
import { PERMISSION_LABEL, type PartnerAuditEvent, type PartnerPermission } from '@jansetu/api';
import { Empty, ErrorState, formatDateTime, Loading } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import {
  NoSuchPartner, PartnerPageHeading, scopeIdentity, useBranches, usePartnerScope, useWorkspacePartner, type ScopeContext,
} from './scope.tsx';

/**
 * WQ11b: every action the backend records in the partner audit log (`recordPartnerAudit` and the clinic/finance/lab
 * callers in `partners/services/*`, stage line a1735c5 and Q16b df87d96), in plain words. An action added later falls back to
 * `actionLabel`'s readable form, never the raw code.
 */
export const ACTION_LABEL: Record<string, string> = {
  'partner.profile.update': 'Changed the profile',
  // Q16b: the admin's account steps are recorded too.
  'partner.create': 'Jansetu created the account',
  'partner.update': 'Jansetu changed the account details',
  'partner.verify': 'Jansetu verified the account',
  'partner.suspend': 'Jansetu suspended the account',
  'partner.reinstate': 'Reinstated the account',
  'member.add': 'Added a member',
  'member.remove': 'Removed a member',
  'member.permissions': 'Changed permissions',
  'member.branches': 'Changed branch access',
  'member.email': 'Changed a sign-in email',
  'member.professional': 'Changed a professional registration',
  'branch.create': 'Added a branch',
  'branch.update': 'Changed a branch',
  'branch.deactivate': 'Deactivated a branch',
  'branch.reactivate': 'Reopened a branch',
  'catalogue.create': 'Added a test or service',
  'catalogue.update': 'Changed a test or service',
  'catalogue.deactivate': 'Deactivated a test or service',
  'catalogue.reactivate': 'Reactivated a test or service',
  'catalogue.admin_disable': 'Jansetu disabled a test or service',
  'catalogue.admin_enable': 'Jansetu enabled a test or service again',
  'invoice.create': 'Issued a bill',
  'invoice.pay': 'Recorded a payment',
  'invoice.cancel': 'Cancelled a bill',
  'slots.add': 'Added a slot',
  'slots.capacity': 'Changed a slot’s seats',
  'slots.close': 'Closed a slot',
  'slots.reopen': 'Reopened a slot',
  'slots.template.save': 'Saved the weekly slot template',
  'lab_booking.assign': 'Assigned a sample collector',
  'lab_booking.collect': 'Marked a sample collected',
  'lab_booking.visit': 'Marked a lab visit',
  'lab_booking.no_show': 'Marked a lab booking as no-show',
  'lab_booking.process': 'Started processing a sample',
  'lab_booking.complete': 'Completed a lab booking',
  'lab_booking.reject': 'Rejected a lab booking (refunded)',
  'lab_booking.reschedule': 'Proposed a new time for a lab booking',
  'lab_booking.no_show_rescheduled': 'Moved a lab no-show to a new time',
  'lab_booking.report_upload': 'Uploaded report drafts',
  'lab_booking.report_remove_draft': 'Removed a report draft',
  'lab_booking.report_release': 'Released a report',
  'clinic.doctor_invited': 'Invited a doctor',
  'clinic.doctor_invite_revoked': 'Revoked a doctor’s invitation',
  'clinic.doctor_linked': 'A doctor was linked to the clinic',
  'clinic.doctor_unlinked': 'A doctor was removed from the clinic',
  'clinic.doctor_joined': 'A doctor joined the clinic',
  'clinic.doctor_left': 'A doctor left the clinic',
  'clinic.solo_practice_created': 'The practice was set up',
  'clinic.appointment_booked': 'Booked an appointment at the desk',
  'clinic.appointment_arrived': 'Marked a patient arrived',
  'clinic.appointment_completed': 'Marked an appointment seen',
  'clinic.appointment_no_show': 'Marked an appointment as no-show',
  'clinic.appointment_cancelled': 'Cancelled an appointment',
  'clinic.appointment_rescheduled': 'Moved an appointment',
  'clinic.appointment_no_show_rescheduled': 'Moved a no-show appointment to a new time',
  'finance.payout_details_changed': 'Changed the payout bank details',
  'finance.payout_details_verified': 'Jansetu verified the payout bank details',
  'finance.payout_recorded': 'Jansetu recorded a payout',
  'finance.payout_voided': 'Jansetu voided a payout',
  'finance.adjustment_posted': 'Jansetu posted an earnings adjustment',
};

const AREA_LABEL: Record<string, string> = {
  partner: 'Profile', member: 'Staff', branch: 'Branch', catalogue: 'Price list', invoice: 'Bill', slots: 'Slots',
  lab_booking: 'Lab booking', clinic: 'Clinic', finance: 'Earnings',
};
const words = (code: string) => code.replace(/[_.]+/g, ' ').trim();

/** The words for an action code: its label, or a readable form of a code added later ("Bill: refund"). */
export function actionLabel(code: string): string {
  if (ACTION_LABEL[code]) return ACTION_LABEL[code];
  const [area = '', ...rest] = code.split('.');
  const what = words(rest.join(' '));
  const head = AREA_LABEL[area] ?? (words(area).charAt(0).toUpperCase() + words(area).slice(1));
  return what ? `${head}: ${what}` : head || 'Change';
}

/** The kind of record an event is about, in words (for kinds the log cannot name). */
export const TARGET_KIND_LABEL: Record<string, string> = {
  partner: 'Profile', member: 'A member', branch: 'A branch', catalogue_item: 'A test or service', invoice: 'A bill', slot: 'A slot',
  lab_booking: 'A lab booking', booking: 'An appointment', clinic_doctor_invite: 'A doctor’s invitation', settlement_account: 'Payout account',
};
export const targetKindLabel = (kind: string) => TARGET_KIND_LABEL[kind] ?? (words(kind).charAt(0).toUpperCase() + words(kind).slice(1));

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
  if (Array.isArray(d.branchIds)) parts.push(d.branchIds.length ? `${d.branchIds.length} ${d.branchIds.length === 1 ? 'branch' : 'branches'}` : 'all branches');
  return parts.join(' · ');
}

/** The partner's activity log (latest 100): who did what to which record. Owners and all-branch staff only. */
export function AuditScreen() {
  const ctx = usePartnerScope();
  if (!ctx) return <NoSuchPartner />;
  return <Audit key={scopeIdentity(ctx)} ctx={ctx} />;
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
    return targetKindLabel(e.targetKind);
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
                    <td>{actionLabel(e.action)}</td>
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
