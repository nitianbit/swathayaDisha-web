import { keepPreviousData, useQuery } from '@tanstack/react-query';
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
 * Q12: `q` is searched on the server (name or code); while a new search runs the previous answer stays on screen. Every
 * variant shares the `[..., 'catalogue']` prefix, so one invalidation refreshes them all.
 */
export function useCatalogue(ctx: ScopeContext, opts: { includeInactive?: boolean; q?: string; enabled?: boolean } = {}) {
  const all = !!opts.includeInactive;
  const q = opts.q?.trim() || '';
  return useQuery({
    queryKey: [...ctx.key, 'catalogue', all ? 'all' : 'active', q],
    queryFn: () => ctx.billing.catalogue(undefined, all, q || undefined),
    enabled: canReadCatalogue(ctx) && opts.enabled !== false,
    placeholderData: opts.q === undefined ? undefined : keepPreviousData,
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

/**
 * Q14: "Create bill" from a clinic appointment hands the new-bill form the patient, doctor, branch and appointment. Kept
 * in session memory only (never a URL or browser storage), read once by the form.
 */
export interface BillPrefill {
  appointmentId: string;
  branchId: string;
  doctorId: string;
  name: string;
  phone: string;
  /** "Dr Mehta, Tue, 17 Nov 2026, 09:30" — what the form shows about the appointment. */
  label: string;
}
export const billPrefillSlot = (identity: string) => `invoice-prefill:${identity}`;

/** Q14 refusals of a bill for an appointment (`admitAppointment`), in words staff can act on. */
export const APPOINTMENT_BILL_REFUSAL: Record<string, string> = {
  APPOINTMENT_ALREADY_BILLED: 'This appointment already has a bill. Open it from the front desk; cancel it first to issue a new one.',
  APPOINTMENT_BRANCH_MISMATCH: 'A bill for an appointment is issued by the branch where the appointment takes place.',
  APPOINTMENT_DOCTOR_MISMATCH: 'The bill names a different doctor than the appointment.',
  APPOINTMENT_CANCELLED: 'This appointment was cancelled, so it cannot be billed.',
  APPOINTMENT_NOT_FOUND: 'This appointment was not found at this clinic (or not at one of your branches).',
};
