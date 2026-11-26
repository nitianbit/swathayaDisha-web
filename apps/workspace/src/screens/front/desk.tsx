import { useQuery } from '@tanstack/react-query';
import { formatClock } from '@jansetu/i18n';
import { CalendarDays, Pill, Plus, Receipt, Search, type LucideIcon } from 'lucide-react';
import {
  appointmentAt, canonicalPhone, CLINIC_PENDING_KEYS, doctorDashboardApi, doctorToolsApi, DOCTOR_PENDING_KEYS, hasGlobalScope, holdsAny, istToday, labAssistedApi, labDeskApi,
  LAB_PENDING_KEYS, OBJECT_ID_PATTERN, ownedClinic, partnerClinicApi, partnerWorkspaceApi, PENDING_KEYS, pharmacyAssistedApi, pharmacySaleApi, todayApi,
  type ClinicPendingKey, type DoctorPendingKey, type LabPendingKey, type PatientLookup, type PendingKey, type SaleCustomer, type TodayApi, type TodayDesk,
} from '@jansetu/api';
import { t } from '../../i18n/home/index.ts';
import { CLINIC_REGISTER_READERS, pagesFor, REGISTER_READERS } from '../../modules.tsx';
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
  pending: readonly (PendingKey | LabPendingKey | ClinicPendingKey | DoctorPendingKey)[];
  pendingTo: (key: PendingKey | LabPendingKey | ClinicPendingKey | DoctorPendingKey, ids: readonly string[] | undefined, count: number) => string | null;
  /** A pharmacy's bookings waiting for payment, by kind (r37c `bookingsAwaiting`); a lab has its own queues instead. */
  bookingTo?: { consultations: (ids: readonly string[] | undefined, count: number) => string | null; labBookings: (ids: readonly string[] | undefined, count: number) => string | null };
  /** A read this person is not allowed: said plainly (a lab member: ask the owner). */
  forbidden: string | null;
  /** WQ55b: this person reads the day register (a lab member: by permission). */
  register: boolean;
  /** WQ57: said when this person may start no visit (never a blank home). */
  noVisits: string;
  /**
   * WQ57b: a clinic's appointments of today found by phone or name (also those booked on an earlier day, which today's
   * register does not list), for Find patient.
   */
  findToday?: (text: string) => Promise<TodayAppointment[]>;
}
/** WQ57b: one of today's appointments as Find patient shows it (the holder's mobile to continue with). */
export interface TodayAppointment { id: string; name: string; phone: string; time: string; doctor: string }

/** The one record's page when the list names exactly one, else the list page. */
export const oneOr = (ids: readonly string[] | undefined, count: number, one: (id: string) => string, list: string) =>
  (count === 1 && ids?.length === 1 && OBJECT_ID_PATTERN.test(ids[0]!) ? one(ids[0]!) : list);

/** This person's front desk: a pharmacy, or a lab's member (owners and staff); null for anyone else. */
export function useFrontDesk(): FrontDesk | null {
  const { api } = useSession();
  const user = useStaff();
  const kind = user.role === 'partner' ? user.partner?.partner.kind : undefined;
  // A lab's branches (its home collections); a clinic's choices do not need them.
  const labPartner = kind === 'lab' ? user.partner! : null;
  // WQ55b: the lab's branches (the same read as the workspace's), so a choice no branch of this member offers is not shown.
  const branches = useQuery({
    queryKey: ['partner-ws', 'member', labPartner?.partner.id ?? 'none', 'branches'], queryFn: () => partnerWorkspaceApi(api, { kind: 'member' }).branches(),
    enabled: !!labPartner,
  });
  // WQ56: a doctor's clinics (the Clinics page's read), for Bills when he owns one.
  const clinics = useQuery({ queryKey: ['doctor', user.id, 'clinics'], queryFn: () => doctorToolsApi(api).clinics(), enabled: user.role === 'specialist' });
  if (user.role === 'specialist') {
    // WQ56 (P2): the doctor's own day: + New (his clinic appointment, an online consultation, a lab test, a follow-up),
    // Find patient, Today, and Bills only when he owns a clinic he can bill. His to-dos are private (r39).
    const owns = !!ownedClinic(clinics.data);
    const page = (path: string, one?: (id: string) => string) => (ids: readonly string[] | undefined, n: number) => (one ? oneOr(ids, n, one, path) : path);
    return {
      kind: 'doctor', id: user.id, today: todayApi(api, 'doctor'), newPath: '/doctor/new', todayPath: '/doctor/today',
      big: [
        { to: '/doctor/new', label: t('big.new'), Icon: Plus }, { to: '/doctor/new?find=1', label: t('big.find'), Icon: Search },
        { to: '/doctor/today', label: t('big.today'), Icon: CalendarDays }, ...(owns ? [{ to: '/doctor/bills', label: t('big.bills'), Icon: Receipt }] : []),
      ],
      choices: [
        { to: visitPath('/doctor/new/clinic'), label: t('new.clinicAppointment') }, { to: visitPath('/doctor/new/online'), label: t('new.online') },
        { to: visitPath('/doctor/lab-book'), label: t('new.lab') }, { to: visitPath('/doctor/new/follow-up'), label: t('new.followUp') },
      ],
      lookup: (phone) => doctorDashboardApi(api).lookup(phone), customers: null,
      pending: DOCTOR_PENDING_KEYS,
      pendingTo: (k, ids, n) => (k === 'reportsReady' ? page('/doctor/lab-tests', (id) => `/doctor/lab-tests/${id}`)(ids, n)
        : k === 'unpaidBills' ? page('/doctor/clinic/invoices', (id) => `/doctor/clinic/invoices/${id}`)(ids, n)
        : k === 'prescriptionsToWrite' || k === 'appointmentsToConfirm' ? '/doctor/appointments' : null),
      forbidden: null, register: true, noVisits: '',
    };
  }
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
      forbidden: null, register: true, noVisits: '',
    };
  }
  const m = user.partner?.member;
  if (user.role !== 'partner' || !m || (kind !== 'lab' && kind !== 'clinic')) return null;
  const open = new Set(pagesFor(user).map((p) => p.path));
  const page = (path: string, one?: (id: string) => string) => (ids: readonly string[] | undefined, n: number) =>
    (!open.has(path) ? null : one ? oneOr(ids, n, one, path) : path);
  const register = holdsAny(m, kind === 'clinic' ? CLINIC_REGISTER_READERS : REGISTER_READERS);
  const bill = holdsAny(m, ['invoices.create']);
  const bills = page('/partner/invoices', (id) => `/partner/invoices/${id}`);
  const partnerBig = (choices: readonly unknown[]) => [
    ...(choices.length ? [{ to: '/partner/new', label: t('big.new'), Icon: Plus }, { to: '/partner/new?find=1', label: t('big.find'), Icon: Search }] : []),
    ...(bill ? [{ to: '/partner/invoices/new', label: t('big.bill'), Icon: Receipt }] : []),
    ...(register ? [{ to: '/partner/today', label: t('big.today'), Icon: CalendarDays }] : []),
  ];
  if (kind === 'clinic') {
    // WQ57 (P3): a clinic's reception: an appointment now (a walk-in) or later (`bookings.manage`), a bill
    // (`invoices.create`); the clinic desk has no number lookup (the number is typed twice on + New).
    const book = holdsAny(m, ['bookings.manage']);
    const desk = page('/partner/desk');
    const choices = [
      ...(book ? [{ to: `${visitPath('/partner/desk')}&when=now`, label: t('new.clinicNow') }, { to: `${visitPath('/partner/desk')}&when=later`, label: t('new.clinicLater') }] : []),
      ...(bill ? [{ to: visitPath('/partner/invoices/new'), label: t('new.bill') }] : []),
    ];
    const clinic = partnerClinicApi(api, { kind: 'member' });
    const reads = holdsAny(m, ['bookings.view', 'bookings.manage']);
    return {
      kind: 'clinic', id: user.id, today: todayApi(api, 'clinic'), newPath: '/partner/new', todayPath: '/partner/today', big: partnerBig(choices), choices,
      // WQ57b (r40d): the clinic's own lookup (the lab's shape), for members who book.
      lookup: book ? (phone) => clinic.lookup(phone) : null, customers: null, pending: CLINIC_PENDING_KEYS,
      findToday: reads ? async (text) => {
        const day = istToday();
        const { appointments } = await clinic.dayView({ from: day, to: day });
        const digits = text.replace(/\D/g, '');
        const words = text.trim().toLowerCase();
        return appointments.flatMap((a) => {
          const phone = canonicalPhone(a.patient?.phone ?? '');
          const name = a.patient?.name ?? '';
          const hit = digits.length >= 4 ? !!phone?.includes(digits) : !!words && name.toLowerCase().includes(words);
          const at = appointmentAt(a);
          return hit && phone ? [{ id: a.bookingId, name, phone, time: at ? formatClock(at) : a.bookingTime, doctor: a.doctorName ?? '' }] : [];
        });
      } : undefined,
      pendingTo: (k, ids, n) => (k === 'unpaidBills' ? bills(ids, n) : k === 'appointmentsToday' || k === 'deskUnbilled' ? desk(ids, n) : null),
      forbidden: t('askOwnerClinic'), register, noVisits: t('askOwnerVisitsClinic'),
    };
  }
  // WQ55: only what this member may do: the desk's walk-ins and home collections (`bookings.manage`), booking a doctor
  // (`assisted.book`), a bill (`invoices.create`); the waiting work links only to pages they may open.
  const desk = holdsAny(m, ['bookings.manage']);
  const consult = holdsAny(m, ['assisted.book']);
  const bookings = page('/partner/lab-bookings', (id) => `/partner/lab-bookings/${id}`);
  const mine = (branches.data ?? []).filter((x) => x.isActive !== false && (hasGlobalScope(m) || m.branchIds.includes(x._id)));
  const home = mine.some((x) => x.services?.homeCollection);
  const choices = [
    ...(desk ? [{ to: visitPath('/partner/lab-desk'), label: t('new.labDesk') }] : []),
    // Only when one of this member's branches does home collection.
    ...(desk && home ? [{ to: `${visitPath('/partner/lab-desk')}&home=1`, label: t('new.homeCollection') }] : []),
    ...(consult ? [{ to: visitPath('/partner/book-consultation'), label: t('new.labDoctor') }] : []),
    ...(bill ? [{ to: visitPath('/partner/invoices/new'), label: t('new.bill') }] : []),
  ];
  return {
    kind: 'lab', id: user.id, today: todayApi(api, 'lab'), newPath: '/partner/new', todayPath: '/partner/today',
    big: partnerBig(choices),
    choices,
    lookup: desk ? (phone) => labDeskApi(api, { kind: 'member' }).lookup(phone) : consult ? (phone) => labAssistedApi(api).lookup(phone) : null,
    customers: null,
    pending: LAB_PENDING_KEYS,
    // r38: each queue where it is done (one record: its own page); bookings waiting for payment are consultations.
    pendingTo: (k, ids, n) => (k === 'unpaidBills' ? bills(ids, n)
      : k === 'consultationsWaiting' || k === 'bookingsAwaitingPayment' ? page('/partner/consultations', (id) => `/partner/consultations/${id}`)(ids, n)
      : k === 'samplesToCollect' || k === 'reportsDue' || k === 'deskUnbilled' ? bookings(ids, n) : null),
    forbidden: t('askOwner'), register, noVisits: t('askOwnerVisits'),
  };
}
