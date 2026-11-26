import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { holdsAny, type CatalogueItemKind, type PartnerKind, type VisitMode } from '@jansetu/api';
import { formatPaise, formatRupees } from '@jansetu/i18n';
import { t, type PartnerKey } from '../../i18n/partner/index.ts';
import { newRequestKey } from '../../requests.ts';
import type { SessionMemory } from '../../session.tsx';
import { scopeIdentity, type ScopeContext } from './scope.tsx';

/** Backend amounts are integer paise; this is the only way the workspace shows them. */
/** Paise as money; "—" when missing or not a number (never ₹NaN). */
export const money = (minor: number | undefined | null) =>
  (typeof minor === 'number' && Number.isFinite(minor) ? formatPaise(minor) : formatRupees(null));

/** Q10 item kinds (labs: test/package; clinics: consultation/procedure/package/other). */
const ITEM_KIND_KEY = {
  test: 'billing.kind.test', package: 'billing.kind.package', consultation: 'billing.kind.consultation',
  procedure: 'billing.kind.procedure', other: 'billing.kind.other',
} as const satisfies Record<CatalogueItemKind, PartnerKey>;
/** An item kind in words; a kind this app does not know shows as sent. */
/** A gender as given on a bill or at a booking (the new-bill form's words); an unknown value as sent. */
export const genderLabel = (g: string): string => {
  const key = `newInvoice.gender.${g}`;
  return g !== 'none' && t.has(key) ? t(key) : g;
};
export const itemKindLabel = (kind: string): string =>
  (Object.hasOwn(ITEM_KIND_KEY, kind) ? t(ITEM_KIND_KEY[kind as CatalogueItemKind]) : kind);
/** Labs only (clinic items have no visit modes). */
const VISIT_MODE_KEY = { home: 'billing.visit.home', lab: 'billing.visit.lab' } as const satisfies Record<VisitMode, PartnerKey>;
export const visitModeLabel = (mode: string): string =>
  (Object.hasOwn(VISIT_MODE_KEY, mode) ? t(VISIT_MODE_KEY[mode as VisitMode]) : mode);

/** Catalogue readers (`GET /catalogue`): `catalogue.manage` or `invoices.create`; r12: also `bookings.manage` (the lab desk). */
export const canReadCatalogue = (ctx: ScopeContext) => holdsAny(ctx.actor, ['catalogue.manage', 'invoices.create', 'bookings.manage']);

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
 * Q14: "Create bill" from a clinic appointment hands the new-bill form the patient, doctor, branch and appointment; r12:
 * "Make bill" from a lab front-desk booking does the same with the booking. Kept in session memory only (never a URL or
 * browser storage), read once by the form.
 */
export interface BillPrefill {
  /** What the bill is for: a clinic appointment (`appointmentId`) or a lab front-desk booking (`labBookingId`). */
  link: { kind: 'appointment' | 'lab_booking'; id: string };
  branchId: string;
  doctorId: string;
  name: string;
  /** The account holder's mobile (the bill's customer); empty when not known here (the form then asks for it). */
  phone: string;
  /** "Dr Mehta, Tue, 17 Nov 2026, 09:30" / "Asha, Wed, 25 Nov 2026, 10:00" — what the form shows about the record. */
  label: string;
  /** WQ55b: the booked tests (catalogue id and name): the bill starts with them, at today's catalogue price. */
  items?: { id: string; name: string }[];
  /** WQ55b: a visit opened from + New: the short bill (name, phone, items, total) and the short payment. */
  simple?: boolean;
  /** WQ57: lines not from the catalogue (a clinic appointment's doctor's fee), in paise. */
  handLines?: { description: string; priceMinor: number; doctor?: string }[];
}
export const billPrefillSlot = (identity: string) => `invoice-prefill:${identity}`;
/** What is stored: the prefill and the one-time token the navigation to the form carries in its route state. */
export interface BillHandover { token: string; prefill: BillPrefill }

/** The handover meant for this navigation (its route state names the token), else nothing. */
export function takeHandover(stored: BillHandover | undefined, routeState: unknown): BillPrefill | undefined {
  const token = (routeState as { prefillToken?: unknown } | null)?.prefillToken;
  return stored && typeof token === 'string' && stored.token === token ? stored.prefill : undefined;
}

/** Q14 / r12 refusals of a bill for an appointment or a lab booking (`BILL_LINKS`), in words staff can act on. */
export function billLinkRefusal(code: string | undefined): string | undefined {
  const key = `billing.refusal.${code}`;
  return code && t.has(key) ? t(key) : undefined;
}

/** Who may open bills (the bills list): any of these permissions. */
export const BILL_READERS = ['invoices.create', 'invoices.cancel', 'payments.record', 'finance.view'] as const;

/** Opens the new-bill form with this record handed over (WQ55b: also straight after a visit's desk booking). */
export function openBill(ctx: ScopeContext, memory: SessionMemory, prefill: BillPrefill, navigate: ReturnType<typeof useNavigate>) {
  // Bound to this navigation: the form takes it only when the route state names this token, once.
  const token = newRequestKey();
  memory.set(billPrefillSlot(scopeIdentity(ctx)), { token, prefill } satisfies BillHandover);
  navigate(`${ctx.link('invoices')}/new`, { state: { prefillToken: token } });
}

/**
 * Q14 / r12: the new-bill form for this record, prefilled with its patient, branch (and doctor) and the record (handed over
 * in session memory only, never in the URL), or the bills list for other bill readers.
 */
export function BillLink({ ctx, memory, prefill, label, className }: { ctx: ScopeContext; memory: SessionMemory; prefill: BillPrefill; label?: string; className?: string }) {
  const navigate = useNavigate();
  if (holdsAny(ctx.actor, ['invoices.create'])) {
    return (
      <Link to={`${ctx.link('invoices')}/new`} className={className} onClick={(e) => {
        // A modified click opens another tab (its own session memory): nothing is handed over, the form starts empty.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        openBill(ctx, memory, prefill, navigate);
      }}>{label ?? t('billing.makeBill')}</Link>
    );
  }
  if (holdsAny(ctx.actor, BILL_READERS)) return <Link to={ctx.link('invoices')}>{t('billing.bills')}</Link>;
  return null;
}
