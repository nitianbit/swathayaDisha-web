import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Ban, Boxes, Building2, CalendarCheck, CalendarClock, CalendarDays, ClipboardCheck, ClipboardList, FlaskConical, Handshake, History, Hospital,
  House, MapPin, Package, PackageX, Receipt, Settings, ShieldAlert, Stethoscope, TrendingDown, Undo2, Users, Video,
} from 'lucide-react';
import { Banknote, Landmark, Wallet } from 'lucide-react';
import { CalendarSearch, Store } from 'lucide-react';
import { CalendarPlus } from 'lucide-react';
import { hasGlobalScope, holdsAny, type PartnerKind, type PartnerPermission } from '@jansetu/api';
import type { StaffRole, StaffUser } from './session.tsx';
import { AdminLabBookingsScreen } from './screens/admin/AdminLabBookingsScreen.tsx';
import { ConsultationScreen } from './screens/admin/ConsultationScreen.tsx';
import { ConsultationsScreen } from './screens/admin/ConsultationsScreen.tsx';
import { NewPharmacyScreen } from './screens/admin/NewPharmacyScreen.tsx';
import { PharmaciesScreen } from './screens/admin/PharmaciesScreen.tsx';
import { PharmacyScreen } from './screens/admin/PharmacyScreen.tsx';
import { PharmacyWalletScreen, PharmacyWalletsScreen } from './screens/admin/PharmacyWalletsScreen.tsx';
import { NewPartnerScreen } from './screens/admin/NewPartnerScreen.tsx';
import { PartnerScreen } from './screens/admin/PartnerScreen.tsx';
import { PartnersScreen } from './screens/admin/PartnersScreen.tsx';
import { AuditScreen } from './screens/partner/AuditScreen.tsx';
import { CatalogueScreen } from './screens/partner/CatalogueScreen.tsx';
import { InvoiceScreen } from './screens/partner/InvoiceScreen.tsx';
import { InvoicesScreen } from './screens/partner/InvoicesScreen.tsx';
import { LabBookingScreen } from './screens/partner/LabBookingScreen.tsx';
import { LabBookingsScreen } from './screens/partner/LabBookingsScreen.tsx';
import { SlotsScreen } from './screens/partner/SlotsScreen.tsx';
import { ClinicDoctorsScreen } from './screens/partner/ClinicDoctorsScreen.tsx';
import { DeskScreen } from './screens/partner/DeskScreen.tsx';
import { NewInvoiceScreen } from './screens/partner/NewInvoiceScreen.tsx';
import { BranchesScreen } from './screens/partner/BranchesScreen.tsx';
import { ProfileScreen } from './screens/partner/ProfileScreen.tsx';
import { StaffScreen } from './screens/partner/StaffScreen.tsx';
import { ExternalCancellationsScreen } from './screens/admin/ExternalCancellationsScreen.tsx';
import { OrderCancellationsScreen } from './screens/admin/OrderCancellationsScreen.tsx';
import { RefundsScreen } from './screens/admin/RefundsScreen.tsx';
import { HomeScreen } from './screens/HomeScreen.tsx';
import { LowStockScreen } from './screens/pharmacy/LowStockScreen.tsx';
import { OrderScreen } from './screens/pharmacy/OrderScreen.tsx';
import { OrdersScreen } from './screens/pharmacy/OrdersScreen.tsx';
import { RxQueueScreen } from './screens/pharmacy/RxQueueScreen.tsx';
import { QualityScreen } from './screens/pharmacy/QualityScreen.tsx';
import { RxReviewScreen } from './screens/pharmacy/RxReviewScreen.tsx';
import { StockScreen } from './screens/pharmacy/StockScreen.tsx';
import { SettingsScreen } from './screens/pharmacy/SettingsScreen.tsx';
import { AddStockScreen } from './screens/pharmacy/AddStockScreen.tsx';
import { ImportScreen } from './screens/pharmacy/ImportScreen.tsx';
import { ImportStockScreen } from './screens/pharmacy/ImportStockScreen.tsx';
import { SuppliersScreen } from './screens/pharmacy/SuppliersScreen.tsx';
import { BookConsultationScreen } from './screens/pharmacy/BookConsultationScreen.tsx';
import { BookedConsultationScreen } from './screens/pharmacy/BookedConsultationScreen.tsx';
import { BookedConsultationsScreen } from './screens/pharmacy/BookedConsultationsScreen.tsx';
import { WalletScreen } from './screens/pharmacy/WalletScreen.tsx';
import { Truck } from 'lucide-react';
import { PartnerFinanceScreen } from './screens/finance/PartnerFinanceScreen.tsx';
import { PayoutsQueueScreen } from './screens/finance/PayoutsQueueScreen.tsx';
import { SettlementAccountScreen } from './screens/finance/SettlementAccountScreen.tsx';
import { SettlementsScreen } from './screens/finance/SettlementsScreen.tsx';
import { AppointmentsScreen } from './screens/doctor/AppointmentsScreen.tsx';
import { ClinicsScreen } from './screens/doctor/ClinicsScreen.tsx';
import { ConsultNowScreen } from './screens/doctor/ConsultNowScreen.tsx';
import { EarningsScreen } from './screens/doctor/EarningsScreen.tsx';
import { ScheduleScreen } from './screens/doctor/ScheduleScreen.tsx';

/**
 * Every workspace page is declared here with the roles that may open it. A path not listed here does not exist, and
 * a listed path is reachable only by its roles (deny by default). This only shapes the UI: the backend enforces access.
 */
export interface WorkspacePage {
  path: string;
  roles: readonly StaffRole[];
  element: ReactNode;
  /** Present for pages shown in the side navigation. */
  nav?: { label: string; icon: LucideIcon; section: string };
  /**
   * Partners only (mirrors the backend route guard): the member needs at least one of these permissions; owners hold
   * all. Pages for other roles ignore it.
   */
  partnerPermissions?: readonly PartnerPermission[];
  /** Partners only: the page exists for these partner kinds (all kinds when absent). */
  partnerKinds?: readonly PartnerKind[];
  /** Partners only: needs partner-wide scope (an owner, or staff not limited to some branches). */
  partnerWide?: boolean;
}

const INVOICE_READERS: readonly PartnerPermission[] = ['invoices.create', 'invoices.cancel', 'payments.record', 'finance.view'];
/** WQ3 (`registerWorkspaceRoutes`): `GET /slots` readers, and `LAB_READERS` of `GET /lab-bookings[/:id]`. */
const SLOT_READERS: readonly PartnerPermission[] = ['slots.manage', 'bookings.view', 'bookings.manage'];
const LAB_READERS: readonly PartnerPermission[] = ['bookings.view', 'bookings.manage', 'reports.upload', 'reports.release'];
/** WQ6 (Q6 routes): `GET /clinic/doctors` readers, and `GET /clinic/slots|appointments` readers. */
const DOCTOR_READERS: readonly PartnerPermission[] = ['staff.manage', 'bookings.view', 'bookings.manage', 'invoices.create'];
const DESK_READERS: readonly PartnerPermission[] = ['bookings.view', 'bookings.manage'];

export const PAGES: readonly WorkspacePage[] = [
  { path: '/', roles: ['admin', 'pharmacy', 'partner', 'specialist'], element: <HomeScreen />, nav: { label: 'Home', icon: House, section: '' } },
  // WQ4: doctors (`specialist` sessions; every route is `requireSpecialist` under /specialists/me).
  {
    path: '/doctor/consult-now', roles: ['specialist'], element: <ConsultNowScreen />,
    nav: { label: 'Consult now', icon: Video, section: 'Doctor' },
  },
  {
    path: '/doctor/appointments', roles: ['specialist'], element: <AppointmentsScreen />,
    nav: { label: 'Appointments', icon: Stethoscope, section: 'Doctor' },
  },
  {
    path: '/doctor/schedule', roles: ['specialist'], element: <ScheduleScreen />,
    nav: { label: 'Schedule', icon: CalendarDays, section: 'Doctor' },
  },
  {
    path: '/doctor/clinics', roles: ['specialist'], element: <ClinicsScreen />,
    nav: { label: 'Clinics', icon: Hospital, section: 'Doctor' },
  },
  {
    path: '/doctor/earnings', roles: ['specialist'], element: <EarningsScreen />,
    nav: { label: 'Earnings', icon: Wallet, section: 'Doctor' },
  },
  // WQ12: assisted booking for walk-in patients (`/pharmacy-assisted`, `/pharmacy-bookings`) and the wallet (`/pharmacy-wallet`).
  {
    path: '/pharmacy/book', roles: ['pharmacy'], element: <BookConsultationScreen />,
    nav: { label: 'Book consultation', icon: CalendarPlus, section: 'Pharmacy' },
  },
  {
    path: '/pharmacy/consultations', roles: ['pharmacy'], element: <BookedConsultationsScreen />,
    nav: { label: 'Booked consultations', icon: CalendarCheck, section: 'Pharmacy' },
  },
  { path: '/pharmacy/consultations/:bookingId', roles: ['pharmacy'], element: <BookedConsultationScreen /> },
  {
    path: '/pharmacy/wallet', roles: ['pharmacy'], element: <WalletScreen />,
    nav: { label: 'Wallet', icon: Wallet, section: 'Pharmacy' },
  },
  {
    path: '/pharmacy/orders', roles: ['pharmacy'], element: <OrdersScreen />,
    nav: { label: 'Orders', icon: Package, section: 'Pharmacy' },
  },
  { path: '/pharmacy/orders/:orderId', roles: ['pharmacy'], element: <OrderScreen /> },
  {
    path: '/pharmacy/prescriptions', roles: ['pharmacy'], element: <RxQueueScreen />,
    nav: { label: 'Prescription review', icon: ClipboardCheck, section: 'Pharmacy' },
  },
  { path: '/pharmacy/prescriptions/:orderId', roles: ['pharmacy'], element: <RxReviewScreen /> },
  { path: '/pharmacy/stock', roles: ['pharmacy'], element: <StockScreen />, nav: { label: 'Stock', icon: Boxes, section: 'Pharmacy' } },
  // WQ10a: add stock, stock imports (`/pharmacy-inventory-imports`) and suppliers (`/pharmacy-suppliers`).
  { path: '/pharmacy/stock/add', roles: ['pharmacy'], element: <AddStockScreen /> },
  { path: '/pharmacy/stock/import', roles: ['pharmacy'], element: <ImportStockScreen /> },
  { path: '/pharmacy/stock/imports/:importId', roles: ['pharmacy'], element: <ImportScreen /> },
  {
    path: '/pharmacy/suppliers', roles: ['pharmacy'], element: <SuppliersScreen />,
    nav: { label: 'Suppliers', icon: Truck, section: 'Pharmacy' },
  },
  {
    path: '/pharmacy/low-stock', roles: ['pharmacy'], element: <LowStockScreen />,
    nav: { label: 'Low stock', icon: TrendingDown, section: 'Pharmacy' },
  },
  {
    path: '/pharmacy/quality', roles: ['pharmacy'], element: <QualityScreen />,
    nav: { label: 'Quality', icon: ShieldAlert, section: 'Pharmacy' },
  },
  {
    path: '/pharmacy/settings', roles: ['pharmacy'], element: <SettingsScreen />,
    nav: { label: 'Settings', icon: Settings, section: 'Pharmacy' },
  },
  { path: '/partner', roles: ['partner'], element: <ProfileScreen />, nav: { label: 'Profile', icon: Building2, section: 'Organisation' } },
  {
    path: '/partner/staff', roles: ['partner'], element: <StaffScreen />, partnerPermissions: ['staff.manage'],
    nav: { label: 'Staff', icon: Users, section: 'Organisation' },
  },
  {
    path: '/partner/branches', roles: ['partner'], element: <BranchesScreen />, partnerPermissions: ['branches.manage'],
    nav: { label: 'Branches', icon: MapPin, section: 'Organisation' },
  },
  {
    path: '/partner/audit', roles: ['partner'], element: <AuditScreen />, partnerPermissions: ['staff.manage'], partnerWide: true,
    nav: { label: 'Activity log', icon: History, section: 'Organisation' },
  },
  // WQ2: catalogue (readers: catalogue.manage or invoices.create) and in-house bills (`INVOICE_READERS` in partners/routes).
  {
    path: '/partner/catalogue', roles: ['partner'], element: <CatalogueScreen />, partnerPermissions: ['catalogue.manage', 'invoices.create'],
    nav: { label: 'Price list', icon: ClipboardList, section: 'Billing' },
  },
  {
    path: '/partner/invoices', roles: ['partner'], element: <InvoicesScreen />, partnerPermissions: INVOICE_READERS,
    nav: { label: 'Bills', icon: Receipt, section: 'Billing' },
  },
  { path: '/partner/invoices/new', roles: ['partner'], element: <NewInvoiceScreen />, partnerPermissions: ['invoices.create'] },
  { path: '/partner/invoices/:invoiceId', roles: ['partner'], element: <InvoiceScreen />, partnerPermissions: INVOICE_READERS },
  // WQ3: lab slots and online lab bookings (labs only).
  {
    path: '/partner/lab-bookings', roles: ['partner'], element: <LabBookingsScreen />, partnerPermissions: LAB_READERS, partnerKinds: ['lab'],
    nav: { label: 'Lab bookings', icon: FlaskConical, section: 'Lab' },
  },
  { path: '/partner/lab-bookings/:bookingId', roles: ['partner'], element: <LabBookingScreen />, partnerPermissions: LAB_READERS, partnerKinds: ['lab'] },
  {
    path: '/partner/slots', roles: ['partner'], element: <SlotsScreen />, partnerPermissions: SLOT_READERS, partnerKinds: ['lab'],
    nav: { label: 'Slots', icon: CalendarClock, section: 'Lab' },
  },
  // WQ5: finance needs `finance.view` AND partner-wide scope (`assertPartnerFinanceReader`); owners change the destination.
  {
    path: '/partner/finance', roles: ['partner'], element: <PartnerFinanceScreen />, partnerPermissions: ['finance.view'], partnerWide: true,
    nav: { label: 'Finance', icon: Wallet, section: 'Billing' },
  },
  // WQ6: clinic doctors (by invitation) and the front desk (clinics only).
  {
    path: '/partner/desk', roles: ['partner'], element: <DeskScreen />, partnerPermissions: DESK_READERS, partnerKinds: ['clinic'],
    nav: { label: 'Front desk', icon: CalendarCheck, section: 'Clinic' },
  },
  {
    path: '/partner/clinic-doctors', roles: ['partner'], element: <ClinicDoctorsScreen />, partnerPermissions: DOCTOR_READERS, partnerKinds: ['clinic'],
    nav: { label: 'Doctors', icon: Stethoscope, section: 'Clinic' },
  },
  {
    path: '/admin/partners', roles: ['admin'], element: <PartnersScreen />,
    nav: { label: 'Labs and clinics', icon: Handshake, section: 'Admin' },
  },
  { path: '/admin/partners/new', roles: ['admin'], element: <NewPartnerScreen /> },
  { path: '/admin/partners/:partnerId', roles: ['admin'], element: <PartnerScreen /> },
  // An admin manages any partner with owner authority through the same screens (scope taken from the route).
  { path: '/admin/partners/:partnerId/profile', roles: ['admin'], element: <ProfileScreen /> },
  { path: '/admin/partners/:partnerId/staff', roles: ['admin'], element: <StaffScreen /> },
  { path: '/admin/partners/:partnerId/branches', roles: ['admin'], element: <BranchesScreen /> },
  { path: '/admin/partners/:partnerId/audit', roles: ['admin'], element: <AuditScreen /> },
  { path: '/admin/partners/:partnerId/catalogue', roles: ['admin'], element: <CatalogueScreen /> },
  { path: '/admin/partners/:partnerId/invoices', roles: ['admin'], element: <InvoicesScreen /> },
  { path: '/admin/partners/:partnerId/invoices/new', roles: ['admin'], element: <NewInvoiceScreen /> },
  { path: '/admin/partners/:partnerId/invoices/:invoiceId', roles: ['admin'], element: <InvoiceScreen /> },
  { path: '/admin/partners/:partnerId/slots', roles: ['admin'], element: <SlotsScreen /> },
  { path: '/admin/partners/:partnerId/lab-bookings', roles: ['admin'], element: <LabBookingsScreen /> },
  { path: '/admin/partners/:partnerId/lab-bookings/:bookingId', roles: ['admin'], element: <LabBookingScreen /> },
  { path: '/admin/partners/:partnerId/finance', roles: ['admin'], element: <PartnerFinanceScreen /> },
  { path: '/admin/partners/:partnerId/desk', roles: ['admin'], element: <DeskScreen /> },
  { path: '/admin/partners/:partnerId/clinic-doctors', roles: ['admin'], element: <ClinicDoctorsScreen /> },
  {
    path: '/admin/lab-bookings', roles: ['admin'], element: <AdminLabBookingsScreen />,
    nav: { label: 'Lab bookings', icon: FlaskConical, section: 'Admin' },
  },
  // WQ10b: pharmacy accounts (only admins create pharmacies) and doctor consultations (the one move of a no-show).
  {
    path: '/admin/pharmacies', roles: ['admin'], element: <PharmaciesScreen />,
    nav: { label: 'Pharmacies', icon: Store, section: 'Admin' },
  },
  { path: '/admin/pharmacies/new', roles: ['admin'], element: <NewPharmacyScreen /> },
  { path: '/admin/pharmacies/:pharmacyId', roles: ['admin'], element: <PharmacyScreen /> },
  // WQ13: a pharmacy's wallet and the admin's manual credit (`/pharmacy-wallet?pharmacyId=`, `POST /pharmacy-wallet/topup` + Idempotency-Key).
  {
    path: '/admin/pharmacy-wallets', roles: ['admin'], element: <PharmacyWalletsScreen />,
    nav: { label: 'Pharmacy wallets', icon: Wallet, section: 'Admin' },
  },
  { path: '/admin/pharmacy-wallets/:pharmacyId', roles: ['admin'], element: <PharmacyWalletScreen /> },
  {
    path: '/admin/consultations', roles: ['admin'], element: <ConsultationsScreen />,
    nav: { label: 'Consultations', icon: CalendarSearch, section: 'Admin' },
  },
  { path: '/admin/consultations/:bookingId', roles: ['admin'], element: <ConsultationScreen /> },
  {
    path: '/admin/order-cancellations', roles: ['admin'], element: <OrderCancellationsScreen />,
    nav: { label: 'Order cancellations', icon: PackageX, section: 'Admin' },
  },
  {
    path: '/admin/refunds', roles: ['admin'], element: <RefundsScreen />,
    nav: { label: 'Refunds needing attention', icon: Undo2, section: 'Admin' },
  },
  {
    path: '/admin/external-cancellations', roles: ['admin'], element: <ExternalCancellationsScreen />,
    nav: { label: 'External cancellations', icon: Ban, section: 'Admin' },
  },
  // WQ5: settlement accounts, payouts and adjustments (`/api/v1/settlements`, admins only).
  {
    path: '/admin/settlements', roles: ['admin'], element: <SettlementsScreen />,
    nav: { label: 'Settlements', icon: Landmark, section: 'Admin' },
  },
  { path: '/admin/settlements/:accountId', roles: ['admin'], element: <SettlementAccountScreen /> },
  {
    path: '/admin/payouts', roles: ['admin'], element: <PayoutsQueueScreen />,
    nav: { label: 'Payouts', icon: Banknote, section: 'Admin' },
  },
];

/** The pages this person may open: by role, and for partners by the member's permissions, partner kind and scope. */
export function pagesFor(user: Pick<StaffUser, 'role' | 'partner'>): WorkspacePage[] {
  return PAGES.filter((p) => {
    if (!p.roles.includes(user.role)) return false;
    if (user.role !== 'partner') return true;
    const m = user.partner?.member;
    if (!m) return false;
    if (p.partnerKinds && !p.partnerKinds.includes(user.partner!.partner.kind)) return false;
    if (p.partnerPermissions && !holdsAny(m, p.partnerPermissions)) return false;
    if (p.partnerWide && !hasGlobalScope(m)) return false;
    return true;
  });
}
