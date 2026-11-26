import { CalendarDays, Pill, Plus, Receipt, Search, type LucideIcon } from 'lucide-react';
import {
  holdsAny, labAssistedApi, labDeskApi, LAB_PENDING_KEYS, OBJECT_ID_PATTERN, PENDING_KEYS, pharmacyAssistedApi, pharmacySaleApi, todayApi,
  type LabPendingKey, type PatientLookup, type PendingKey, type SaleCustomer, type TodayApi, type TodayDesk,
} from '@jansetu/api';
import { t } from '../../i18n/home/index.ts';
import { pagesFor } from '../../modules.tsx';
import { useSession, useStaff } from '../../session.tsx';
import { visitPath } from './visitPatient.ts';

/**
 * WQ55 (P4): one front desk's simple home, + New and Today, for a pharmacy (WQ54) or a lab member (r38): its routes, its
 * big buttons and visit choices (a lab member's by their permissions), its number lookup, and where its waiting work is
 * done. The screens (`home.tsx`, `NewVisitScreen.tsx`) are the same for both.
 */
export interface FrontDesk {
  kind: TodayDesk;
  /** The signed-in person (query keys and the visit's memory). */
  id: string;
  today: TodayApi;
  newPath: string;
  todayPath: string;
  /** The home's big buttons (the first is the main one). */
  big: { to: string; label: string; Icon: LucideIcon }[];
  /** + New's "what", each an existing flow opened with the visit's patient. */
  choices: { to: string; label: string }[];
  /** The number's lookup (whether it is on Jansetu, the owner's masked name); null when this person may not look up. */
  lookup: ((phone: string) => Promise<PatientLookup>) | null;
  /** This desk's own patients searched by name or phone (a pharmacy's customers); null: + New takes a phone only. */
  customers: ((search: string) => Promise<SaleCustomer[]>) | null;
  /** The waiting work, in the strip's order, and where each is done (null: shown, but not a link for this person). */
  pending: readonly (PendingKey | LabPendingKey)[];
  pendingTo: (key: PendingKey | LabPendingKey, ids: readonly string[] | undefined, count: number) => string | null;
  bookingTo: { consultations: (ids: readonly string[] | undefined, count: number) => string | null; labBookings: (ids: readonly string[] | undefined, count: number) => string | null };
  /** A read this person is not allowed: said plainly (a lab member: ask the owner). */
  forbidden: string | null;
}

/** The one record's page when the list names exactly one, else the list page. */
export const oneOr = (ids: readonly string[] | undefined, count: number, one: (id: string) => string, list: string) =>
  (count === 1 && ids?.length === 1 && OBJECT_ID_PATTERN.test(ids[0]!) ? one(ids[0]!) : list);

/** This person's front desk: a pharmacy, or a lab's member (owners and staff); null for anyone else. */
export function useFrontDesk(): FrontDesk | null {
  const { api } = useSession();
  const user = useStaff();
  if (user.role === 'pharmacy') {
    const assisted = pharmacyAssistedApi(api);
    return {
      kind: 'pharmacy', id: user.id, today: todayApi(api, 'pharmacy'), newPath: '/pharmacy/new', todayPath: '/pharmacy/today',
      big: [
        { to: '/pharmacy/new', label: t('big.new'), Icon: Plus }, { to: '/pharmacy/new?find=1', label: t('big.find'), Icon: Search },
        { to: '/pharmacy/sale', label: t('big.sell'), Icon: Pill }, { to: '/pharmacy/today', label: t('big.today'), Icon: CalendarDays },
      ],
      choices: [
        { to: visitPath('/pharmacy/consult-now'), label: t('new.video') }, { to: visitPath('/pharmacy/book'), label: t('new.doctor') },
        { to: visitPath('/pharmacy/lab-book'), label: t('new.lab') }, { to: visitPath('/pharmacy/sale'), label: t('new.medicines') },
      ],
      lookup: (phone) => assisted.lookup(phone), customers: (s) => pharmacySaleApi(api).customers(s),
      pending: PENDING_KEYS,
      pendingTo: (k, ids, n) => ({
        prescriptionsToReview: '/pharmacy/prescriptions',
        unpaidCounterSales: oneOr(ids, n, (id) => `/pharmacy/sale/${id}`, '/pharmacy/orders'),
        labReportsReady: '/pharmacy/lab-tests', lowStock: '/pharmacy/low-stock',
      } as Partial<Record<string, string>>)[k] ?? null,
      bookingTo: {
        consultations: (ids, n) => oneOr(ids, n, (id) => `/pharmacy/consultations/${id}`, '/pharmacy/consultations'),
        labBookings: (ids, n) => oneOr(ids, n, (id) => `/pharmacy/lab-tests/${id}`, '/pharmacy/lab-tests'),
      },
      forbidden: null,
    };
  }
  const m = user.partner?.member;
  if (user.role !== 'partner' || !m || user.partner?.partner.kind !== 'lab') return null;
  // WQ55: only what this member may do: the desk's walk-ins and home collections (`bookings.manage`), booking a doctor
  // (`assisted.book`), a bill (`invoices.create`); the waiting work links only to pages they may open.
  const desk = holdsAny(m, ['bookings.manage']);
  const consult = holdsAny(m, ['assisted.book']);
  const bill = holdsAny(m, ['invoices.create']);
  const open = new Set(pagesFor(user).map((p) => p.path));
  const page = (path: string, one?: (id: string) => string) => (ids: readonly string[] | undefined, n: number) =>
    (!open.has(path) ? null : one ? oneOr(ids, n, one, path) : path);
  const bookings = page('/partner/lab-bookings', (id) => `/partner/lab-bookings/${id}`);
  const choices = [
    ...(desk ? [{ to: visitPath('/partner/lab-desk'), label: t('new.labDesk') }, { to: `${visitPath('/partner/lab-desk')}&home=1`, label: t('new.homeCollection') }] : []),
    ...(consult ? [{ to: visitPath('/partner/book-consultation'), label: t('new.labDoctor') }] : []),
    ...(bill ? [{ to: visitPath('/partner/invoices/new'), label: t('new.bill') }] : []),
  ];
  return {
    kind: 'lab', id: user.id, today: todayApi(api, 'lab'), newPath: '/partner/new', todayPath: '/partner/today',
    big: [
      ...(choices.length ? [{ to: '/partner/new', label: t('big.new'), Icon: Plus }, { to: '/partner/new?find=1', label: t('big.find'), Icon: Search }] : []),
      ...(bill ? [{ to: '/partner/invoices/new', label: t('big.bill'), Icon: Receipt }] : []),
      { to: '/partner/today', label: t('big.today'), Icon: CalendarDays },
    ],
    choices,
    lookup: desk ? (phone) => labDeskApi(api, { kind: 'member' }).lookup(phone) : consult ? (phone) => labAssistedApi(api).lookup(phone) : null,
    customers: null,
    pending: LAB_PENDING_KEYS,
    // r38: each queue where it is done (one record: its own page).
    pendingTo: (k, ids, n) => (k === 'unpaidBills' ? page('/partner/invoices', (id) => `/partner/invoices/${id}`)(ids, n)
      : k === 'consultationsWaiting' ? page('/partner/consultations', (id) => `/partner/consultations/${id}`)(ids, n)
      : k === 'samplesToCollect' || k === 'reportsDue' || k === 'deskUnbilled' || k === 'bookingsAwaitingPayment' ? bookings(ids, n) : null),
    bookingTo: { consultations: page('/partner/consultations', (id) => `/partner/consultations/${id}`), labBookings: bookings },
    forbidden: t('askOwner'),
  };
}
