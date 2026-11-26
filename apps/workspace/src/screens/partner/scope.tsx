import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import {
  ADMIN_ACTOR, OBJECT_ID_PATTERN, partnerBillingApi, partnerLabsApi, partnerWorkspaceApi, type PartnerActorView, type PartnerScope,
} from '@jansetu/api';
import { Empty, shared } from '@jansetu/ui';
import { PageHeading } from '../../PageHeading.tsx';
import { t } from '../../i18n/partner/index.ts';
import { useSession, useStaff } from '../../session.tsx';

export type PartnerSection = 'profile' | 'staff' | 'branches' | 'audit' | 'catalogue' | 'invoices' | 'slots' | 'lab-bookings' | 'lab-desk';

export interface ScopeContext {
  scope: PartnerScope;
  /** Who acts, for the UI's mirror of the backend's delegation and scope rules. */
  actor: PartnerActorView;
  /** Query-key prefix: one cache per partner (an admin may manage several in one session). */
  key: readonly string[];
  /** Where a section of this workspace lives in the app. */
  link: (section: PartnerSection) => string;
  api: ReturnType<typeof partnerWorkspaceApi>;
  /** WQ2: catalogue and invoices of the same workspace. */
  billing: ReturnType<typeof partnerBillingApi>;
  /** WQ3: lab slots and online lab bookings of the same workspace. */
  labs: ReturnType<typeof partnerLabsApi>;
  /** The admin partner page this workspace belongs to (admins only). */
  adminHome?: string;
}

/**
 * One set of partner screens serves both a partner's own members (`/partner/...`) and platform admins acting with owner
 * authority (`/admin/partners/:partnerId/...`, backend `adminActor`). The route decides which. Null for a malformed id.
 */
export function usePartnerScope(): ScopeContext | null {
  const { partnerId } = useParams();
  const { api } = useSession();
  const user = useStaff();
  if (partnerId !== undefined) {
    if (!OBJECT_ID_PATTERN.test(partnerId) || user.role !== 'admin') return null;
    const scope: PartnerScope = { kind: 'admin', partnerId };
    const root = `/admin/partners/${partnerId}`;
    return {
      scope, actor: ADMIN_ACTOR, key: ['partner-ws', partnerId], api: partnerWorkspaceApi(api, scope),
      billing: partnerBillingApi(api, scope), labs: partnerLabsApi(api, scope), adminHome: root,
      link: (s) => `${root}/${s}`,
    };
  }
  if (user.role === 'specialist') {
    // WQ56 (r39): a doctor bills the clinic he owns from his dashboard (`/doctor/clinic/...`): its catalogue and bills
    // with his owner authority; its name and branches come from his clinic read. He is its only doctor on a bill.
    const scope: PartnerScope = { kind: 'doctor' };
    const billing = partnerBillingApi(api, scope);
    return {
      scope, actor: ADMIN_ACTOR, key: ['partner-ws', 'doctor', user.id], api: partnerWorkspaceApi(api, scope), labs: partnerLabsApi(api, scope),
      billing: { ...billing, clinicDoctors: async () => [{ memberId: '', doctorId: user.id, role: 'owner' as const, branchIds: [], name: user.name, active: true }] },
      link: (s) => (s === 'invoices' || s === 'catalogue' ? `/doctor/clinic/${s}` : '/doctor'),
    };
  }
  const m = user.partner?.member;
  if (user.role !== 'partner' || !m || !user.partner) return null;
  const scope: PartnerScope = { kind: 'member' };
  return {
    scope,
    actor: { role: m.role, permissions: m.permissions, branchIds: m.branchIds, memberId: m.id },
    key: ['partner-ws', 'member', user.partner.partner.id],
    api: partnerWorkspaceApi(api, scope),
    billing: partnerBillingApi(api, scope),
    labs: partnerLabsApi(api, scope),
    link: (s) => (s === 'profile' ? '/partner' : `/partner/${s}`),
  };
}

/** The partner record of this workspace (`GET .../me`); several screens need its name, kind or owner count. */
export function useWorkspacePartner(ctx: ScopeContext | null) {
  return useQuery({
    queryKey: [...(ctx?.key ?? ['partner-ws', 'none']), 'me'],
    queryFn: () => ctx!.api.me(),
    enabled: !!ctx,
  });
}

/** Q8: every member may read its branches (names for staff scoping, bookings, invoices). */
export function useBranches(ctx: ScopeContext) {
  return useQuery({ queryKey: [...ctx.key, 'branches'], queryFn: () => ctx.api.branches() });
}

/** `memberIds`/`branchIds` → names, for tables. */
export const branchLabel = (names: Map<string, string>, ids: readonly string[]) =>
  ids.length === 0 ? t('common.allBranches') : ids.map((id) => names.get(id) ?? t('common.branchById', { tail: id.slice(-6) })).join(', ');

/** A one-line identity for the scope: a subtree keyed by it never sends one partner's draft to another. */
export const scopeIdentity = (ctx: ScopeContext) => ctx.key.join(':');

export function NoSuchPartner() {
  return <Empty title={t('scope.notFound.title')}>{shared('page.notFound')}</Empty>;
}

/** Page heading; for admins it names the partner being managed and links back to its admin page. */
export function PartnerPageHeading({ ctx, title, partnerName, children }:
  { ctx: ScopeContext; title: string; partnerName?: string; children?: ReactNode }) {
  return (
    <>
      {ctx.adminHome && (
        <Link className="ws-back" to={ctx.adminHome}>
          <ArrowLeft size={16} aria-hidden="true" /> {partnerName == null ? t('scope.backToPartner') : t('scope.backTo', { name: partnerName })}
        </Link>
      )}
      <PageHeading title={title}>
        {ctx.adminHome
          ? <>{partnerName == null ? t('scope.managingThis') : t('scope.managing', { name: partnerName })} {children}</>
          : children}
      </PageHeading>
    </>
  );
}
