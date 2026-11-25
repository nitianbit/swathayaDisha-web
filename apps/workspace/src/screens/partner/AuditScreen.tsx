import { useQuery } from '@tanstack/react-query';
import { PERMISSION_LABEL, type PartnerAuditEvent, type PartnerPermission } from '@jansetu/api';
import { Empty, ErrorState, formatDateTime, Loading } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import {
  NoSuchPartner, PartnerPageHeading, scopeIdentity, useBranches, usePartnerScope, useWorkspacePartner, type ScopeContext,
} from './scope.tsx';
import { t, type PartnerKey } from '../../i18n/partner/index.ts';

/**
 * WQ11b: every action the backend records in the partner audit log (`recordPartnerAudit` and the clinic/finance/lab
 * callers in `partners/services/*`, stage line a1735c5 and Q16b df87d96), in plain words. An action added later falls back to
 * `actionLabel`'s readable form, never the raw code.
 */
export const ACTION_LABEL: Readonly<Record<string, PartnerKey>> = {
  'partner.profile.update': 'audit.action.partner.profile.update',
  // Q16b: the admin's account steps are recorded too.
  'partner.create': 'audit.action.partner.create',
  'partner.update': 'audit.action.partner.update',
  'partner.verify': 'audit.action.partner.verify',
  'partner.suspend': 'audit.action.partner.suspend',
  'partner.reinstate': 'audit.action.partner.reinstate',
  'member.add': 'audit.action.member.add',
  'member.remove': 'audit.action.member.remove',
  'member.permissions': 'audit.action.member.permissions',
  'member.branches': 'audit.action.member.branches',
  'member.email': 'audit.action.member.email',
  'member.professional': 'audit.action.member.professional',
  'branch.create': 'audit.action.branch.create',
  'branch.update': 'audit.action.branch.update',
  'branch.deactivate': 'audit.action.branch.deactivate',
  'branch.reactivate': 'audit.action.branch.reactivate',
  'catalogue.create': 'audit.action.catalogue.create',
  'catalogue.update': 'audit.action.catalogue.update',
  'catalogue.deactivate': 'audit.action.catalogue.deactivate',
  'catalogue.reactivate': 'audit.action.catalogue.reactivate',
  'catalogue.admin_disable': 'audit.action.catalogue.admin_disable',
  'catalogue.admin_enable': 'audit.action.catalogue.admin_enable',
  'invoice.create': 'audit.action.invoice.create',
  'invoice.pay': 'audit.action.invoice.pay',
  'invoice.cancel': 'audit.action.invoice.cancel',
  'slots.add': 'audit.action.slots.add',
  'slots.capacity': 'audit.action.slots.capacity',
  'slots.close': 'audit.action.slots.close',
  'slots.reopen': 'audit.action.slots.reopen',
  'slots.template.save': 'audit.action.slots.template.save',
  'lab_booking.assign': 'audit.action.lab_booking.assign',
  'lab_booking.collect': 'audit.action.lab_booking.collect',
  'lab_booking.visit': 'audit.action.lab_booking.visit',
  'lab_booking.no_show': 'audit.action.lab_booking.no_show',
  'lab_booking.process': 'audit.action.lab_booking.process',
  'lab_booking.complete': 'audit.action.lab_booking.complete',
  'lab_booking.reject': 'audit.action.lab_booking.reject',
  'lab_booking.reschedule': 'audit.action.lab_booking.reschedule',
  'lab_booking.no_show_rescheduled': 'audit.action.lab_booking.no_show_rescheduled',
  'lab_booking.report_upload': 'audit.action.lab_booking.report_upload',
  'lab_booking.report_remove_draft': 'audit.action.lab_booking.report_remove_draft',
  'lab_booking.report_release': 'audit.action.lab_booking.report_release',
  'clinic.doctor_invited': 'audit.action.clinic.doctor_invited',
  'clinic.doctor_invite_revoked': 'audit.action.clinic.doctor_invite_revoked',
  'clinic.doctor_linked': 'audit.action.clinic.doctor_linked',
  'clinic.doctor_unlinked': 'audit.action.clinic.doctor_unlinked',
  'clinic.doctor_joined': 'audit.action.clinic.doctor_joined',
  'clinic.doctor_left': 'audit.action.clinic.doctor_left',
  'clinic.solo_practice_created': 'audit.action.clinic.solo_practice_created',
  'clinic.appointment_booked': 'audit.action.clinic.appointment_booked',
  'clinic.appointment_arrived': 'audit.action.clinic.appointment_arrived',
  'clinic.appointment_completed': 'audit.action.clinic.appointment_completed',
  'clinic.appointment_no_show': 'audit.action.clinic.appointment_no_show',
  'clinic.appointment_cancelled': 'audit.action.clinic.appointment_cancelled',
  'clinic.appointment_rescheduled': 'audit.action.clinic.appointment_rescheduled',
  'clinic.appointment_no_show_rescheduled': 'audit.action.clinic.appointment_no_show_rescheduled',
  'finance.payout_details_changed': 'audit.action.finance.payout_details_changed',
  'finance.payout_details_verified': 'audit.action.finance.payout_details_verified',
  'finance.payout_recorded': 'audit.action.finance.payout_recorded',
  'finance.payout_voided': 'audit.action.finance.payout_voided',
  'finance.adjustment_posted': 'audit.action.finance.adjustment_posted',
};

const words = (code: string) => code.replace(/[_.]+/g, ' ').trim();
/** The catalogue's words for `<prefix><code>`, when it has them. */
const known = (prefix: string, code: string) => {
  const key = `${prefix}${code}`;
  return t.has(key) ? t(key) : undefined;
};
const capitalised = (code: string) => words(code).charAt(0).toUpperCase() + words(code).slice(1);

/** The words for an action code: its label, or a readable form of a code added later ("Bill: refund"). */
export function actionLabel(code: string): string {
  const label = ACTION_LABEL[code];
  if (label) return t(label);
  const [area = '', ...rest] = code.split('.');
  const what = words(rest.join(' '));
  const head = known('audit.area.', area) ?? capitalised(area);
  return what ? t('audit.action.unknown', { area: head, what }) : head || t('audit.action.change');
}

/** The kind of record an event is about, in words (for kinds the log cannot name). */
export const targetKindLabel = (kind: string) => known('audit.target.', kind) ?? capitalised(kind);

/** A short, human summary of what an event changed (permissions and field names only; never other data). */
export function auditDetail(e: Pick<PartnerAuditEvent, 'action' | 'detail'>): string {
  const d = e.detail ?? {};
  const perms = Array.isArray(d.permissions) ? (d.permissions as string[]).map((p) => PERMISSION_LABEL[p as PartnerPermission] ?? p) : null;
  const fields = Array.isArray(d.fields) ? (d.fields as string[]).map((f) => known('audit.field.', f) ?? f) : null;
  const parts: string[] = [];
  if (d.role === 'owner') parts.push(t('audit.detail.asOwner'));
  if (perms) parts.push(perms.length ? perms.join(', ') : t('audit.detail.noPermissions'));
  if (fields?.length) parts.push(fields.join(', '));
  if (Array.isArray(d.branchIds)) parts.push(d.branchIds.length ? t('audit.detail.branches', { count: d.branchIds.length }) : t('audit.detail.allBranches'));
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

  const actor = (e: PartnerAuditEvent) => (e.actorKind === 'admin' ? t('audit.jansetuAdmin')
    : memberName.get(e.actorId) ?? (e.actorId === ctx.actor.memberId ? t('audit.you') : t('audit.formerMember')));
  const target = (e: PartnerAuditEvent) => {
    if (!e.targetKind) return '—';
    if (e.targetKind === 'partner') return t('audit.profile');
    if (e.targetKind === 'member') return memberName.get(e.targetId ?? '') ?? t('audit.formerMember');
    if (e.targetKind === 'branch') return branchName.get(e.targetId ?? '') ?? t('common.branchById', { tail: (e.targetId ?? '').slice(-6) });
    return targetKindLabel(e.targetKind);
  };

  return (
    <>
      <PartnerPageHeading ctx={ctx} title={t('audit.title')} partnerName={partner.data?.name}>{t('audit.intro')}</PartnerPageHeading>
      {events.isPending ? <Loading label={t('audit.loading')} />
        : events.isError ? <ErrorState message={messageOf(events.error)} onRetry={() => void events.refetch()} />
        : events.data.length === 0 ? <Empty title={t('audit.none')} />
        : (
          <div className="ws-table-wrap">
            <table className="j-table">
              <caption className="j-sr-only">{t('audit.caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('audit.col.when')}</th><th scope="col">{t('audit.col.who')}</th><th scope="col">{t('audit.col.what')}</th>
                  <th scope="col">{t('audit.col.record')}</th><th scope="col">{t('audit.col.details')}</th>
                </tr>
              </thead>
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
