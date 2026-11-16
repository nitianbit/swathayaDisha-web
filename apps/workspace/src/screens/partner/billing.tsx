import { useQuery } from '@tanstack/react-query';
import {
  holdsAny, paiseToRupees, type CatalogueItemKind, type PartnerKind, type VisitMode,
} from '@jansetu/api';
import { formatRupees } from '@jansetu/ui';
import type { ScopeContext } from './scope.tsx';

/** Backend amounts are integer paise; this is the only way the workspace shows them. */
export const money = (minor: number | undefined | null) =>
  (minor === undefined || minor === null ? formatRupees(minor) : formatRupees(paiseToRupees(minor)));

/** Q10 item kinds (labs: test/package; clinics: consultation/procedure/package/other). */
export const ITEM_KIND_LABEL: Record<CatalogueItemKind, string> = {
  test: 'Test', package: 'Package', consultation: 'Consultation', procedure: 'Procedure', other: 'Other',
};
/** Labs only (clinic items have no visit modes). */
export const VISIT_MODE_LABEL: Record<VisitMode, string> = { home: 'Home collection', lab: 'At the lab' };

/** Catalogue readers (`GET /catalogue`): `catalogue.manage` or `invoices.create`. */
export const canReadCatalogue = (ctx: ScopeContext) => holdsAny(ctx.actor, ['catalogue.manage', 'invoices.create']);

/**
 * Active catalogue items (admin-disabled ones included); `includeInactive` adds deactivated ones (catalogue managers).
 * Every variant shares the `[..., 'catalogue']` prefix, so one invalidation refreshes them all.
 */
export function useCatalogue(ctx: ScopeContext, opts: { includeInactive?: boolean } = {}) {
  const all = !!opts.includeInactive;
  return useQuery({
    queryKey: [...ctx.key, 'catalogue', all ? 'all' : 'active'],
    queryFn: () => ctx.billing.catalogue(undefined, all),
    enabled: canReadCatalogue(ctx),
  });
}

/** Q6 `GET /clinic/doctors` readers; only asked for clinics. */
export const canReadDoctors = (ctx: ScopeContext) => holdsAny(ctx.actor, ['staff.manage', 'bookings.view', 'bookings.manage', 'invoices.create']);

export function useClinicDoctors(ctx: ScopeContext, kind: PartnerKind | undefined) {
  return useQuery({
    queryKey: [...ctx.key, 'clinic-doctors'], queryFn: () => ctx.billing.clinicDoctors(),
    enabled: kind === 'clinic' && canReadDoctors(ctx),
  });
}
