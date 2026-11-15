import { useQuery } from '@tanstack/react-query';
import {
  holdsAny, paiseToRupees, type CatalogueItemKind, type PartnerKind, type VisitMode,
} from '@jansetu/api';
import { formatRupees } from '@jansetu/ui';
import type { ScopeContext } from './scope.tsx';

/** Backend amounts are integer paise; this is the only way the workspace shows them. */
export const money = (minor: number | undefined | null) =>
  (minor === undefined || minor === null ? formatRupees(minor) : formatRupees(paiseToRupees(minor)));

/** The catalogue is lab-shaped on the server (`test`/`package`, `home`/`lab`); clinics see the same values in their words. */
export const ITEM_KIND_LABEL: Record<PartnerKind, Record<CatalogueItemKind, string>> = {
  lab: { test: 'Test', package: 'Package' },
  clinic: { test: 'Service', package: 'Package' },
};
export const VISIT_MODE_LABEL: Record<PartnerKind, Record<VisitMode, string>> = {
  lab: { home: 'Home collection', lab: 'At the lab' },
  clinic: { home: 'Home visit', lab: 'At the clinic' },
};

/** Catalogue readers (`GET /catalogue`): `catalogue.manage` or `invoices.create`. */
export const canReadCatalogue = (ctx: ScopeContext) => holdsAny(ctx.actor, ['catalogue.manage', 'invoices.create']);

/** Active catalogue items (admin-disabled ones included). */
export function useCatalogue(ctx: ScopeContext, enabled = true) {
  return useQuery({ queryKey: [...ctx.key, 'catalogue'], queryFn: () => ctx.billing.catalogue(), enabled: enabled && canReadCatalogue(ctx) });
}

/** Q6 `GET /clinic/doctors` readers; only asked for clinics. */
export const canReadDoctors = (ctx: ScopeContext) => holdsAny(ctx.actor, ['staff.manage', 'bookings.view', 'bookings.manage', 'invoices.create']);

export function useClinicDoctors(ctx: ScopeContext, kind: PartnerKind | undefined) {
  return useQuery({
    queryKey: [...ctx.key, 'clinic-doctors'], queryFn: () => ctx.billing.clinicDoctors(),
    enabled: kind === 'clinic' && canReadDoctors(ctx),
  });
}

/** IST calendar date (YYYY-MM-DD) → the instant its next day starts in India, as the `before` bound of "on or before". */
export function endOfIstDay(date: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const start = Date.parse(`${date}T00:00:00+05:30`);
  if (Number.isNaN(start)) return null;
  return new Date(start + 24 * 60 * 60_000).toISOString();
}
