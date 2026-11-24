import { formatPaise } from '@jansetu/i18n';
import { ApiError, type ApiClient } from './client.ts';
import { recommendationLookup } from './assistedLab.ts';
import { keyOf, SLOW_WRITE_TIMEOUT_MS, type AssistedPatient, type PatientLookup, type Refusal } from './assisted.ts';
import { labRefusal, labTotalMinor, type LabAddress } from './assistedLab.ts';
import type { LabBooking } from './partnerLabs.ts';
import { checkId, partnerWorkspaceBase, type PartnerScope } from './partners.ts';
import type { CatalogueItem, VisitMode } from './partnerInvoices.ts';

/**
 * WQ19: the lab front desk (assisted booking round 2c, backend r12 `m0/r12-phase2c` e304dabe, design
 * ASSISTED_BOOKING_DESIGN.md §24.12). A lab member with `bookings.manage` books the lab's own tests for a walk-in patient:
 * a walk-in tested now (no slot), a lab visit on a slot, or a home collection (address, home slot, optional collector).
 * Paid at the lab (no Jansetu money); the lab bills it with its own bill (`POST /invoices {labBookingId}`). Members use
 * `/partner-workspace/lab-desk/*`, admins the `/partner-workspace/admin/:partnerId/workspace/lab-desk/*` mirror. Tests
 * come from `GET /catalogue`, seats from `GET /slots`. The phone travels only in POST bodies.
 */

/** The consent the desk attests; the version names this exact sentence (a change of words is a new version). */
export const LAB_DESK_CONSENT_VERSION = 'web-lab-desk-v1';
export const LAB_DESK_CONSENT_STATEMENT =
  'The patient (or a family member with them) agreed that this lab books these tests for them on Jansetu; that an account is made for this number if it has none; that their name and phone number are shared with Jansetu; and that the report is released to their Jansetu app.';

export interface DeskCollector { memberId?: string; name: string; phone?: string }
/** `deskBookingSchema`: no `notes` is sent (the desk offers no note). */
export interface DeskBookingRequest {
  requestKey: string;
  phone: string;
  patient: AssistedPatient;
  holderName?: string;
  consent: { agreed: true; statementVersion: string; statementLanguage: string };
  preferredLanguage: string;
  branchId: string;
  visitMode: VisitMode;
  /** Home: required. Lab: absent = a walk-in tested now. */
  slotId?: string;
  itemIds: string[];
  address?: LabAddress;
  collector?: DeskCollector;
  /** Σ the catalogue prices (paise) shown: 409 PRICE_CHANGED (details.priceMinor) when the lab's prices moved. */
  acceptedTotalMinor: number;
}
export interface DeskReceipt { booking: LabBooking; patient: { name: string }; newAccount: boolean; replayed: boolean }
/** `used` with `booking: null` once the booking is outside the member's branches. */
export type DeskByKey = { state: 'used'; booking: LabBooking | null } | { state: 'abandoned' } | { state: 'unknown' };
export interface DeskCancelAnswer { booking: LabBooking; alreadyCancelled: boolean }


export function labDeskApi(c: ApiClient, scope: PartnerScope) {
  const base = () => `${partnerWorkspaceBase(scope)}/lab-desk`;
  return {
    /** The masked account holder of a number (counted against the hourly lookup limit). */
    lookup: (phone: string) => c.post<PatientLookup>(`${base()}/patients/lookup`, { body: { phone } }),
    /** WQ21b (r16b): the recommended tests by the code and the patient's number, in the body (the admin mirror too). */
    recommendation: (code: string, phone: string) => recommendationLookup(c, `${base()}/recommendations/lookup`)(code, phone),
    /** Exactly once per (lab, member, request key); the same key and content answer the booking again (`replayed`). */
    book: (body: DeskBookingRequest) => {
      keyOf(body.requestKey);
      checkId(body.branchId, 'branch');
      if (body.slotId !== undefined) checkId(body.slotId, 'slot');
      if (body.visitMode === 'home' && !body.slotId) throw new Error('A home collection needs a time');
      if (body.visitMode !== 'home' && (body.address || body.collector)) throw new Error('An address and a collector are for home collections only');
      if (body.itemIds.length < 1 || body.itemIds.length > 20) throw new Error('Choose 1 to 20 tests');
      body.itemIds.forEach((id) => checkId(id, 'test'));
      return c.post<DeskReceipt>(`${base()}/bookings`, { body, timeoutMs: SLOW_WRITE_TIMEOUT_MS });
    },
    byKey: (key: string) => c.get<DeskByKey>(`${base()}/bookings/by-key/${keyOf(key)}`),
    abandon: (key: string) => c.post<DeskByKey>(`${base()}/bookings/by-key/${keyOf(key)}/abandon`),
    /** No money moves; `expectedVersion` = the `statusVersion` the cancel was confirmed on (409 LAB_BOOKING_CHANGED). */
    cancel: (id: string, body: { reason?: string; expectedVersion?: number }) =>
      c.post<DeskCancelAnswer>(`${base()}/bookings/${checkId(id, 'booking')}/cancel`, { body }),
  };
}

// ── Rules and words for the screen ──

/** Catalogue items the desk can book for a visit mode (`admitLabItems`): tests and packages, active, offered for the visit. */
export const deskItems = (items: readonly CatalogueItem[], mode: VisitMode) =>
  items.filter((i) => (i.kind === 'test' || i.kind === 'package') && i.isActive && !i.adminDisabled && (i.visitModes ?? []).includes(mode));
/** The total the desk shows and fences (Σ the chosen items' catalogue prices). */
export const deskTotalMinor = (items: readonly CatalogueItem[], chosen: readonly string[]) =>
  labTotalMinor(items.map((i) => ({ itemId: i._id, priceMinor: i.priceMinor })), chosen);

export const LAB_DESK_SWITCHED_OFF_MESSAGE = 'The lab front desk is not switched on yet.';

const DESK_WORDS: Readonly<Record<string, Refusal>> = {
  SLOT_REQUIRED: { kind: 'slot', message: 'Choose a time for the home collection.' },
  COLLECTOR_NOT_MEMBER: { kind: 'other', message: 'This collector is not a member of this lab. Type the collector’s name instead.' },
  BRANCH_SCOPE_EXCEEDED: { kind: 'doctor', message: 'You do not work at this branch. Choose one of your branches.' },
  LAB_PARTNER_REQUIRED: { kind: 'other', message: 'The front desk is for labs only.' },
  PARTNER_NOT_VERIFIED: { kind: 'other', message: 'This lab is not verified or not active, so it cannot book now.' },
  DEPENDENT_NOT_FOUND: { kind: 'patient', message: 'This family member was not found on the number. Enter the patient again.' },
  PRICE_CHANGED: { kind: 'price', message: 'The lab’s prices changed.' },
};

/** One plain sentence for a desk refusal (the lab and shared assisted words first; the price as the server names it). */
export function deskRefusal(err: unknown): Refusal {
  const shared = labRefusal(err);
  if (shared.kind === 'off') return { kind: 'off', message: LAB_DESK_SWITCHED_OFF_MESSAGE };
  if (shared.kind === 'price') {
    const p = shared.priceMinor;
    return p === undefined
      ? { kind: 'price', message: 'The lab’s prices changed. Choose the tests again to see the new total.' }
      : { kind: 'price', priceMinor: p, message: `The lab’s prices changed: the total is now ${formatPaise(p)}. Tell the patient, then book at the new total.` };
  }
  const known = err instanceof ApiError && err.code ? DESK_WORDS[err.code] : undefined;
  return known ?? shared;
}

/** A desk row (paid at the lab: no Jansetu money, the lab bills it). */
export const isDeskBooking = (b: Pick<LabBooking, 'source' | 'payAtLab'> | null | undefined) => !!b && (b.payAtLab === true || b.source === 'lab_desk');
/** The desk may cancel a desk row while it is confirmed (r12 `cancelDeskBooking`); no money moves. */
export const canDeskCancel = (b: Pick<LabBooking, 'status' | 'source' | 'payAtLab'>) => isDeskBooking(b) && b.status === 'confirmed';
/** "Make bill": a desk row not cancelled and not billed yet (one open bill per booking: 409 LAB_BOOKING_ALREADY_BILLED). */
export const canBillDesk = (b: Pick<LabBooking, 'status' | 'source' | 'payAtLab' | 'bill'>) =>
  isDeskBooking(b) && b.status !== 'cancelled' && !(b.bill && b.bill.state !== 'cancelled');
