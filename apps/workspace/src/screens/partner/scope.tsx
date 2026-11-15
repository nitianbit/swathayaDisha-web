import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import {
  ADMIN_ACTOR, OBJECT_ID_PATTERN, partnerBillingApi, partnerWorkspaceApi, type PartnerActorView, type PartnerScope,
} from '@jansetu/api';
import { Empty } from '@jansetu/ui';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession, useStaff } from '../../session.tsx';

export type PartnerSection = 'profile' | 'staff' | 'branches' | 'audit' | 'catalogue' | 'invoices';

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
      billing: partnerBillingApi(api, scope), adminHome: root,
      link: (s) => `${root}/${s}`,
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
  ids.length === 0 ? 'All branches' : ids.map((id) => names.get(id) ?? `Branch …${id.slice(-6)}`).join(', ');

/** A one-line identity for the scope: a subtree keyed by it never sends one partner's draft to another. */
export const scopeIdentity = (ctx: ScopeContext) => ctx.key.join(':');

export function NoSuchPartner() {
  return <Empty title="Page not found">This page does not exist or is not available to your account.</Empty>;
}

/** Page heading; for admins it names the partner being managed and links back to its admin page. */
export function PartnerPageHeading({ ctx, title, partnerName, children }:
  { ctx: ScopeContext; title: string; partnerName?: string; children?: ReactNode }) {
  return (
    <>
      {ctx.adminHome && (
        <Link className="ws-back" to={ctx.adminHome}>
          <ArrowLeft size={16} aria-hidden="true" /> Back to {partnerName ?? 'the partner'}
        </Link>
      )}
      <PageHeading title={title}>
        {ctx.adminHome ? <>Managing {partnerName ?? 'this partner'} with owner authority. {children}</> : children}
      </PageHeading>
    </>
  );
}
