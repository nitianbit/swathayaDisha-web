import type { ReactNode } from 'react';
import { Navigate } from 'react-router';
import type { LucideIcon } from 'lucide-react';
import {
  Ban, Boxes, Building2, CalendarCheck, CalendarClock, CalendarDays, ClipboardCheck, ClipboardList, FlaskConical, Handshake, History, Hospital,
  House, MapPin, Package, PackageX, Receipt, Settings, ShieldAlert, Stethoscope, TrendingDown, Undo2, Users, Video,
} from 'lucide-react';
import { Banknote, Landmark, Wallet } from 'lucide-react';
import { CalendarSearch, Store } from 'lucide-react';
import { CalendarPlus } from 'lucide-react';
import { TestTube, TestTubes } from 'lucide-react';
import { HandCoins, ShoppingCart } from 'lucide-react';
import { hasGlobalScope, holdsAny, type PartnerKind, type PartnerPermission } from '@jansetu/api';
import type { StaffRole, StaffUser } from './session.tsx';
import type { ShellKey as NavKey } from './i18n/shell/index.ts';
import { AdminLabBookingsScreen } from './screens/admin/AdminLabBookingsScreen.tsx';
import { ConsultationScreen } from './screens/admin/ConsultationScreen.tsx';
import { ConsultationsScreen } from './screens/admin/ConsultationsScreen.tsx';
import { DoctorScreen } from './screens/admin/DoctorScreen.tsx';
import { DoctorsScreen } from './screens/admin/DoctorsScreen.tsx';
import { NewPharmacyScreen } from './screens/admin/NewPharmacyScreen.tsx';
import { PharmaciesScreen } from './screens/admin/PharmaciesScreen.tsx';
import { PharmacyScreen } from './screens/admin/PharmacyScreen.tsx';
import { PharmacyWalletScreen, PharmacyWalletsScreen } from './screens/admin/PharmacyWalletsScreen.tsx';
import { NewPartnerScreen } from './screens/admin/NewPartnerScreen.tsx';
import { PartnerScreen } from './screens/admin/PartnerScreen.tsx';
import { PartnersScreen } from './screens/admin/PartnersScreen.tsx';
import { LabReferralCutsScreen, PharmacyReferralCutsScreen } from './screens/admin/ReferralCutsScreen.tsx';
import { AuditScreen } from './screens/partner/AuditScreen.tsx';
import { CatalogueScreen } from './screens/partner/CatalogueScreen.tsx';
import { InvoiceScreen } from './screens/partner/InvoiceScreen.tsx';
import { InvoicesScreen } from './screens/partner/InvoicesScreen.tsx';
import { LabBookingScreen } from './screens/partner/LabBookingScreen.tsx';
import { LabBookingsScreen } from './screens/partner/LabBookingsScreen.tsx';
import { LabDeskScreen } from './screens/partner/LabDeskScreen.tsx';
import { LabWalletScreen } from './screens/partner/LabWalletScreen.tsx';
import { LabBookConsultationScreen, LabBookedConsultationScreen, LabBookedConsultationsScreen } from './screens/partner/LabConsultScreens.tsx';
import { DoctorWalletAdminScreen, LabWalletAdminScreen } from './screens/admin/LabWalletAdminScreen.tsx';
import { DoctorWalletScreen } from './screens/doctor/DoctorWalletScreen.tsx';
import { DoctorBookLabTestScreen, DoctorLabTestScreen, DoctorLabTestsScreen } from './screens/doctor/DoctorLabScreens.tsx';
import { RecordsScreen } from './screens/doctor/RecordsScreen.tsx';
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
import { BookLabTestScreen } from './screens/pharmacy/BookLabTestScreen.tsx';
import { BookedLabTestScreen, BookedLabTestsScreen } from './screens/pharmacy/BookedLabTestsScreen.tsx';
import { BookConsultationScreen } from './screens/pharmacy/BookConsultationScreen.tsx';
import { PharmacyConsultNowScreen } from './screens/pharmacy/ConsultNowScreen.tsx';
import { BookedConsultationScreen } from './screens/pharmacy/BookedConsultationScreen.tsx';
import { BookedConsultationsScreen } from './screens/pharmacy/BookedConsultationsScreen.tsx';
import { WalletScreen } from './screens/pharmacy/WalletScreen.tsx';
import { LabReferralEarningsScreen } from './screens/finance/ReferralEarningsScreen.tsx';
import { PharmacyFinanceScreen } from './screens/pharmacy/FinanceScreen.tsx';
import { SaleBillScreen, SaleScreen } from './screens/pharmacy/SaleScreen.tsx';
import { NewVisitScreen } from './screens/front/NewVisitScreen.tsx';
import { TodayScreen } from './screens/front/home.tsx';
import { WalletDisputesScreen } from './screens/admin/WalletDisputesScreen.tsx';
import { Truck } from 'lucide-react';
import { PartnerFinanceScreen } from './screens/finance/PartnerFinanceScreen.tsx';
import { PayoutsQueueScreen } from './screens/finance/PayoutsQueueScreen.tsx';
import { WithdrawalsScreen } from './screens/admin/WithdrawalsScreen.tsx';
import { SettlementAccountScreen } from './screens/finance/SettlementAccountScreen.tsx';
import { SettlementsScreen } from './screens/finance/SettlementsScreen.tsx';
import { AppointmentsScreen } from './screens/doctor/AppointmentsScreen.tsx';
import { ClinicsScreen } from './screens/doctor/ClinicsScreen.tsx';
import { DoctorBillsScreen, DoctorPricesScreen } from './screens/doctor/ClinicBillingScreens.tsx';
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
  /** Present for pages shown in the side navigation: the page name and its group, as shell catalogue keys. */
  /** `labelKeyByKind`: a partner page named after the partner's kind (WQ51: a lab's tests, a clinic's services). */
  nav?: { labelKey: NavKey; labelKeyByKind?: Partial<Record<PartnerKind, NavKey>>; icon: LucideIcon; sectionKey: NavKey | '' };
  /**
   * Partners only (mirrors the backend route guard): the member needs at least one of these permissions; owners hold
   * all. Pages for other roles ignore it.
   */
  partnerPermissions?: readonly PartnerPermission[];
  /** WQ57c: a kind's own readers instead (a clinic's Today: its bookings or its bills). */
  partnerPermissionsByKind?: Partial<Record<PartnerKind, readonly PartnerPermission[]>>;
  /** Partners only: the page exists for these partner kinds (all kinds when absent). */
  partnerKinds?: readonly PartnerKind[];
  /** Partners only: needs partner-wide scope (an owner, or staff not limited to some branches). */
  partnerWide?: boolean;
}

const INVOICE_READERS: readonly PartnerPermission[] = ['invoices.create', 'invoices.cancel', 'payments.record', 'finance.view'];
/** WQ3 (`registerWorkspaceRoutes`): `GET /slots` readers, and `LAB_READERS` of `GET /lab-bookings[/:id]`. */
const SLOT_READERS: readonly PartnerPermission[] = ['slots.manage', 'bookings.view', 'bookings.manage'];
const LAB_READERS: readonly PartnerPermission[] = ['bookings.view', 'bookings.manage', 'reports.upload', 'reports.release'];
/**
 * WQ55b: who reads a lab's day register (r38: each source by its own permission): lab bookings, bills or consultations.
 */
export const REGISTER_READERS: readonly PartnerPermission[] = [...LAB_READERS, ...INVOICE_READERS, 'assisted.book'];
/** WQ6 (Q6 routes): `GET /clinic/doctors` readers, and `GET /clinic/slots|appointments` readers. */
const DOCTOR_READERS: readonly PartnerPermission[] = ['staff.manage', 'bookings.view', 'bookings.manage', 'invoices.create'];
const DESK_READERS: readonly PartnerPermission[] = ['bookings.view', 'bookings.manage'];
/** WQ57b: who reads a clinic's day register (r40: its appointments or its bills). */
export const CLINIC_REGISTER_READERS: readonly PartnerPermission[] = [...DESK_READERS, ...INVOICE_READERS];

export const PAGES: readonly WorkspacePage[] = [
  { path: '/', roles: ['admin', 'pharmacy', 'partner', 'specialist'], element: <HomeScreen />, nav: { labelKey: 'nav.home', icon: House, sectionKey: '' } },
  // WQ4: doctors (`specialist` sessions; every route is `requireSpecialist` under /specialists/me).
  {
    path: '/doctor/consult-now', roles: ['specialist'], element: <ConsultNowScreen />,
    nav: { labelKey: 'nav.consultNow', icon: Video, sectionKey: 'nav.section.doctor' },
  },
  {
    path: '/doctor/appointments', roles: ['specialist'], element: <AppointmentsScreen />,
    nav: { labelKey: 'nav.appointments', icon: Stethoscope, sectionKey: 'nav.section.doctor' },
  },
  // WQ28 (r30): one consultation's patient records (own consultations; others with the account holder's approval).
  { path: '/doctor/appointments/:bookingId/records', roles: ['specialist'], element: <RecordsScreen /> },
  {
    path: '/doctor/schedule', roles: ['specialist'], element: <ScheduleScreen />,
    nav: { labelKey: 'nav.schedule', icon: CalendarDays, sectionKey: 'nav.section.doctor' },
  },
  {
    path: '/doctor/clinics', roles: ['specialist'], element: <ClinicsScreen />,
    nav: { labelKey: 'nav.clinics', icon: Hospital, sectionKey: 'nav.section.doctor' },
  },
  // WQ51: the doctor's own clinic's bills and price list, from the doctor menu (they open its partner workspace).
  {
    path: '/doctor/bills', roles: ['specialist'], element: <DoctorBillsScreen />,
    nav: { labelKey: 'nav.bills', icon: Receipt, sectionKey: 'nav.section.doctor' },
  },
  {
    path: '/doctor/services', roles: ['specialist'], element: <DoctorPricesScreen />,
    nav: { labelKey: 'nav.servicesAndPrices', icon: ClipboardList, sectionKey: 'nav.section.doctor' },
  },
  {
    path: '/doctor/earnings', roles: ['specialist'], element: <EarningsScreen />,
    nav: { labelKey: 'nav.earnings', icon: Wallet, sectionKey: 'nav.section.doctor' },
  },
  // WQ23 (r20): the doctor's own wallet (`/specialists/me/assisted/wallet*`; a verified, active doctor).
  {
    path: '/doctor/wallet', roles: ['specialist'], element: <DoctorWalletScreen />,
    nav: { labelKey: 'nav.wallet', icon: Banknote, sectionKey: 'nav.section.doctor' },
  },
  // WQ25 (r26): a doctor books lab tests for its patients (`/specialists/me/assisted/labs*`, `…/lab-bookings*`), paid from
  // the wallet: from one of its consultations (`/from/:fromBookingId`, linked from Appointments) or for a walk-in by phone.
  {
    path: '/doctor/lab-book', roles: ['specialist'], element: <DoctorBookLabTestScreen />,
    nav: { labelKey: 'nav.bookLabTest', icon: TestTube, sectionKey: 'nav.section.doctor' },
  },
  { path: '/doctor/lab-book/from/:fromBookingId', roles: ['specialist'], element: <DoctorBookLabTestScreen /> },
  {
    path: '/doctor/lab-tests', roles: ['specialist'], element: <DoctorLabTestsScreen />,
    nav: { labelKey: 'nav.labTestsBooked', icon: TestTubes, sectionKey: 'nav.section.doctor' },
  },
  { path: '/doctor/lab-tests/:bookingId', roles: ['specialist'], element: <DoctorLabTestScreen /> },
  // WQ12: assisted booking for walk-in patients (`/pharmacy-assisted`, `/pharmacy-bookings`) and the wallet (`/pharmacy-wallet`).
  {
    path: '/pharmacy/book', roles: ['pharmacy'], element: <BookConsultationScreen />,
    nav: { labelKey: 'nav.bookConsultation', icon: CalendarPlus, sectionKey: 'nav.section.pharmacy' },
  },
  // WQ22 (r17): an instant consultation for a walk-in, paid from the wallet (`/pharmacy-assisted/instant/*`).
  {
    path: '/pharmacy/consult-now', roles: ['pharmacy'], element: <PharmacyConsultNowScreen />,
    nav: { labelKey: 'nav.consultNow', icon: Video, sectionKey: 'nav.section.pharmacy' },
  },
  {
    path: '/pharmacy/consultations', roles: ['pharmacy'], element: <BookedConsultationsScreen />,
    nav: { labelKey: 'nav.bookedConsultations', icon: CalendarCheck, sectionKey: 'nav.section.pharmacy' },
  },
  { path: '/pharmacy/consultations/:bookingId', roles: ['pharmacy'], element: <BookedConsultationScreen /> },
  // WQ17: lab tests for walk-in patients (assisted booking phase 2a, `/pharmacy-assisted/labs*`, `/pharmacy-assisted/lab-bookings*`).
  {
    path: '/pharmacy/lab-book', roles: ['pharmacy'], element: <BookLabTestScreen />,
    nav: { labelKey: 'nav.bookLabTest', icon: TestTube, sectionKey: 'nav.section.pharmacy' },
  },
  {
    path: '/pharmacy/lab-tests', roles: ['pharmacy'], element: <BookedLabTestsScreen />,
    nav: { labelKey: 'nav.bookedLabTests', icon: TestTubes, sectionKey: 'nav.section.pharmacy' },
  },
  { path: '/pharmacy/lab-tests/:bookingId', roles: ['pharmacy'], element: <BookedLabTestScreen /> },
  {
    path: '/pharmacy/wallet', roles: ['pharmacy'], element: <WalletScreen />,
    nav: { labelKey: 'nav.wallet', icon: Wallet, sectionKey: 'nav.section.pharmacy' },
  },
  // WQ48 (r35 §26.10): the pharmacy's Finance: wallet, card money and referral tiles, Withdraw, payout details, one statement.
  {
    path: '/pharmacy/finance', roles: ['pharmacy'], element: <PharmacyFinanceScreen />,
    nav: { labelKey: 'nav.finance', icon: HandCoins, sectionKey: 'nav.section.pharmacy' },
  },
  // WQ26's "Referral earnings" page is part of Finance now (WQ48); old links land there.
  { path: '/pharmacy/referral', roles: ['pharmacy'], element: <Navigate to="/pharmacy/finance" replace /> },
  // WQ54 (P1): + New (the patient, then what: the existing flows opened with that patient) and Today (the day's register).
  { path: '/pharmacy/new', roles: ['pharmacy'], element: <NewVisitScreen /> },
  {
    path: '/pharmacy/today', roles: ['pharmacy'], element: <TodayScreen />,
    nav: { labelKey: 'nav.today', icon: CalendarDays, sectionKey: 'nav.section.pharmacy' },
  },
  // WQ50: a counter sale (a linked or walk-in customer, stock, an optional prescription, paid at the counter, its bill).
  {
    path: '/pharmacy/sale', roles: ['pharmacy'], element: <SaleScreen />,
    nav: { labelKey: 'nav.newSale', icon: ShoppingCart, sectionKey: 'nav.section.pharmacy' },
  },
  // WQ50b: a created sale's own page (its bill and the counter payment), so a reload shows it.
  { path: '/pharmacy/sale/:orderId', roles: ['pharmacy'], element: <SaleBillScreen /> },
  {
    path: '/pharmacy/orders', roles: ['pharmacy'], element: <OrdersScreen />,
    nav: { labelKey: 'nav.orders', icon: Package, sectionKey: 'nav.section.pharmacy' },
  },
  { path: '/pharmacy/orders/:orderId', roles: ['pharmacy'], element: <OrderScreen /> },
  {
    path: '/pharmacy/prescriptions', roles: ['pharmacy'], element: <RxQueueScreen />,
    nav: { labelKey: 'nav.prescriptionReview', icon: ClipboardCheck, sectionKey: 'nav.section.pharmacy' },
  },
  { path: '/pharmacy/prescriptions/:orderId', roles: ['pharmacy'], element: <RxReviewScreen /> },
  { path: '/pharmacy/stock', roles: ['pharmacy'], element: <StockScreen />, nav: { labelKey: 'nav.stock', icon: Boxes, sectionKey: 'nav.section.pharmacy' } },
  // WQ10a: add stock, stock imports (`/pharmacy-inventory-imports`) and suppliers (`/pharmacy-suppliers`).
  { path: '/pharmacy/stock/add', roles: ['pharmacy'], element: <AddStockScreen /> },
  { path: '/pharmacy/stock/import', roles: ['pharmacy'], element: <ImportStockScreen /> },
  { path: '/pharmacy/stock/imports/:importId', roles: ['pharmacy'], element: <ImportScreen /> },
  {
    path: '/pharmacy/suppliers', roles: ['pharmacy'], element: <SuppliersScreen />,
    nav: { labelKey: 'nav.suppliers', icon: Truck, sectionKey: 'nav.section.pharmacy' },
  },
  {
    path: '/pharmacy/low-stock', roles: ['pharmacy'], element: <LowStockScreen />,
    nav: { labelKey: 'nav.lowStock', icon: TrendingDown, sectionKey: 'nav.section.pharmacy' },
  },
  {
    path: '/pharmacy/quality', roles: ['pharmacy'], element: <QualityScreen />,
    nav: { labelKey: 'nav.quality', icon: ShieldAlert, sectionKey: 'nav.section.pharmacy' },
  },
  {
    path: '/pharmacy/settings', roles: ['pharmacy'], element: <SettingsScreen />,
    nav: { labelKey: 'nav.settings', icon: Settings, sectionKey: 'nav.section.pharmacy' },
  },
  { path: '/partner', roles: ['partner'], element: <ProfileScreen />, nav: { labelKey: 'nav.profile', icon: Building2, sectionKey: 'nav.section.organisation' } },
  {
    path: '/partner/staff', roles: ['partner'], element: <StaffScreen />, partnerPermissions: ['staff.manage'],
    nav: { labelKey: 'nav.staff', icon: Users, sectionKey: 'nav.section.organisation' },
  },
  {
    path: '/partner/branches', roles: ['partner'], element: <BranchesScreen />, partnerPermissions: ['branches.manage'],
    nav: { labelKey: 'nav.branches', icon: MapPin, sectionKey: 'nav.section.organisation' },
  },
  {
    path: '/partner/audit', roles: ['partner'], element: <AuditScreen />, partnerPermissions: ['staff.manage'], partnerWide: true,
    nav: { labelKey: 'nav.activityLog', icon: History, sectionKey: 'nav.section.organisation' },
  },
  // WQ2: catalogue (readers: catalogue.manage or invoices.create) and in-house bills (`INVOICE_READERS` in partners/routes).
  {
    path: '/partner/catalogue', roles: ['partner'], element: <CatalogueScreen />, partnerPermissions: ['catalogue.manage', 'invoices.create'],
    nav: { labelKey: 'nav.testsAndPackages', labelKeyByKind: { clinic: 'nav.servicesAndPrices' }, icon: ClipboardList, sectionKey: 'nav.section.billing' },
  },
  {
    path: '/partner/invoices', roles: ['partner'], element: <InvoicesScreen />, partnerPermissions: INVOICE_READERS,
    nav: { labelKey: 'nav.bills', icon: Receipt, sectionKey: 'nav.section.billing' },
  },
  { path: '/partner/invoices/new', roles: ['partner'], element: <NewInvoiceScreen />, partnerPermissions: ['invoices.create'] },
  { path: '/partner/invoices/:invoiceId', roles: ['partner'], element: <InvoiceScreen />, partnerPermissions: INVOICE_READERS },
  // WQ55 (P4): a lab member's + New (the patient, then what: the desk, a home collection, a doctor, a bill, each by its
  // permission; none: the page says to ask the owner) and Today (the day's register; the server scopes it to the member).
  // WQ57 (P3): the same + New and Today for a clinic's reception.
  { path: '/partner/new', roles: ['partner'], element: <NewVisitScreen />, partnerKinds: ['lab', 'clinic'] },
  {
    path: '/partner/today', roles: ['partner'], element: <TodayScreen />, partnerKinds: ['lab', 'clinic'], partnerPermissions: REGISTER_READERS,
    partnerPermissionsByKind: { clinic: CLINIC_REGISTER_READERS },
    // Next to Home (a lab's and a clinic's alike).
    nav: { labelKey: 'nav.today', icon: CalendarDays, sectionKey: '' },
  },
  // WQ3: lab slots and online lab bookings (labs only).
  {
    path: '/partner/lab-bookings', roles: ['partner'], element: <LabBookingsScreen />, partnerPermissions: LAB_READERS, partnerKinds: ['lab'],
    nav: { labelKey: 'nav.labBookings', icon: FlaskConical, sectionKey: 'nav.section.lab' },
  },
  { path: '/partner/lab-bookings/:bookingId', roles: ['partner'], element: <LabBookingScreen />, partnerPermissions: LAB_READERS, partnerKinds: ['lab'] },
  // WQ19 (r12): the lab front desk books the lab's own tests for a patient at the counter (`bookings.manage`, labs only).
  {
    path: '/partner/lab-desk', roles: ['partner'], element: <LabDeskScreen />, partnerPermissions: ['bookings.manage'], partnerKinds: ['lab'],
    nav: { labelKey: 'nav.frontDesk', icon: CalendarPlus, sectionKey: 'nav.section.lab' },
  },
  // WQ24 (r21): a lab books a doctor consultation for a walk-in patient (`/partner-workspace/assisted/*`; `assisted.book`, labs only).
  {
    path: '/partner/book-consultation', roles: ['partner'], element: <LabBookConsultationScreen />, partnerPermissions: ['assisted.book'], partnerKinds: ['lab'],
    nav: { labelKey: 'nav.bookConsultation', icon: Stethoscope, sectionKey: 'nav.section.lab' },
  },
  {
    path: '/partner/consultations', roles: ['partner'], element: <LabBookedConsultationsScreen />, partnerPermissions: ['assisted.book'], partnerKinds: ['lab'],
    nav: { labelKey: 'nav.bookedConsultations', icon: CalendarCheck, sectionKey: 'nav.section.lab' },
  },
  { path: '/partner/consultations/:bookingId', roles: ['partner'], element: <LabBookedConsultationScreen />, partnerPermissions: ['assisted.book'], partnerKinds: ['lab'] },
  // WQ20 (r13): the lab's own wallet (`/partner-workspace/assisted/wallet*`; `wallet.view` reads, `wallet.manage` adds money).
  {
    path: '/partner/wallet', roles: ['partner'], element: <LabWalletScreen />, partnerPermissions: ['wallet.view', 'wallet.manage'], partnerKinds: ['lab'],
    nav: { labelKey: 'nav.wallet', icon: Wallet, sectionKey: 'nav.section.lab' },
  },
  // WQ26b (r33, M17): the lab's referral earnings (`/partner-workspace/assisted/referral*`; finance.view with partner-wide scope).
  {
    path: '/partner/referral', roles: ['partner'], element: <LabReferralEarningsScreen />, partnerPermissions: ['finance.view'], partnerKinds: ['lab'],
    partnerWide: true, nav: { labelKey: 'nav.referralEarnings', icon: HandCoins, sectionKey: 'nav.section.lab' },
  },
  {
    path: '/partner/slots', roles: ['partner'], element: <SlotsScreen />, partnerPermissions: SLOT_READERS, partnerKinds: ['lab'],
    nav: { labelKey: 'nav.slots', icon: CalendarClock, sectionKey: 'nav.section.lab' },
  },
  // WQ5: finance needs `finance.view` AND partner-wide scope (`assertPartnerFinanceReader`); owners change the destination.
  {
    path: '/partner/finance', roles: ['partner'], element: <PartnerFinanceScreen />, partnerPermissions: ['finance.view'], partnerWide: true,
    nav: { labelKey: 'nav.finance', icon: Wallet, sectionKey: 'nav.section.billing' },
  },
  // WQ6: clinic doctors (by invitation) and the front desk (clinics only).
  {
    path: '/partner/desk', roles: ['partner'], element: <DeskScreen />, partnerPermissions: DESK_READERS, partnerKinds: ['clinic'],
    nav: { labelKey: 'nav.frontDesk', icon: CalendarCheck, sectionKey: 'nav.section.clinic' },
  },
  {
    path: '/partner/clinic-doctors', roles: ['partner'], element: <ClinicDoctorsScreen />, partnerPermissions: DOCTOR_READERS, partnerKinds: ['clinic'],
    nav: { labelKey: 'nav.doctors', icon: Stethoscope, sectionKey: 'nav.section.clinic' },
  },
  {
    path: '/admin/partners', roles: ['admin'], element: <PartnersScreen />,
    nav: { labelKey: 'nav.labsAndClinics', icon: Handshake, sectionKey: 'nav.section.admin' },
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
  { path: '/admin/partners/:partnerId/lab-desk', roles: ['admin'], element: <LabDeskScreen /> },
  // WQ20 (r13): a lab's wallet for admins (`/admin/labs/:partnerId/wallet*`).
  { path: '/admin/partners/:partnerId/wallet', roles: ['admin'], element: <LabWalletAdminScreen /> },
  { path: '/admin/partners/:partnerId/finance', roles: ['admin'], element: <PartnerFinanceScreen /> },
  // WQ26 (phase 4a): a lab's referral cuts (`/admin/referral-rules`, admins only).
  { path: '/admin/partners/:partnerId/referral-cuts', roles: ['admin'], element: <LabReferralCutsScreen /> },
  { path: '/admin/partners/:partnerId/desk', roles: ['admin'], element: <DeskScreen /> },
  { path: '/admin/partners/:partnerId/clinic-doctors', roles: ['admin'], element: <ClinicDoctorsScreen /> },
  {
    path: '/admin/lab-bookings', roles: ['admin'], element: <AdminLabBookingsScreen />,
    nav: { labelKey: 'nav.labBookings', icon: FlaskConical, sectionKey: 'nav.section.admin' },
  },
  // WQ10b: pharmacy accounts (only admins create pharmacies) and doctor consultations (the one move of a no-show).
  {
    path: '/admin/pharmacies', roles: ['admin'], element: <PharmaciesScreen />,
    nav: { labelKey: 'nav.pharmacies', icon: Store, sectionKey: 'nav.section.admin' },
  },
  { path: '/admin/pharmacies/new', roles: ['admin'], element: <NewPharmacyScreen /> },
  { path: '/admin/pharmacies/:pharmacyId', roles: ['admin'], element: <PharmacyScreen /> },
  // WQ26 (phase 4a): a pharmacy's referral cuts (`/admin/referral-rules`, admins only).
  { path: '/admin/pharmacies/:pharmacyId/referral-cuts', roles: ['admin'], element: <PharmacyReferralCutsScreen /> },
  // WQ13: a pharmacy's wallet and the admin's manual credit (`/pharmacy-wallet?pharmacyId=`, `POST /pharmacy-wallet/topup` + Idempotency-Key).
  {
    path: '/admin/pharmacy-wallets', roles: ['admin'], element: <PharmacyWalletsScreen />,
    nav: { labelKey: 'nav.pharmacyWallets', icon: Wallet, sectionKey: 'nav.section.admin' },
  },
  { path: '/admin/pharmacy-wallets/:pharmacyId', roles: ['admin'], element: <PharmacyWalletScreen /> },
  // WQ18: doctor accounts and their verification (S5 fence: `expectedName`, `expectedRegistrationNumber`).
  {
    path: '/admin/doctors', roles: ['admin'], element: <DoctorsScreen />,
    nav: { labelKey: 'nav.doctors', icon: Stethoscope, sectionKey: 'nav.section.admin' },
  },
  { path: '/admin/doctors/:doctorId', roles: ['admin'], element: <DoctorScreen /> },
  // WQ23 (r20): a doctor's wallet for admins (`/admin/doctors/:specialistId/wallet*`).
  { path: '/admin/doctors/:doctorId/wallet', roles: ['admin'], element: <DoctorWalletAdminScreen /> },
  {
    path: '/admin/consultations', roles: ['admin'], element: <ConsultationsScreen />,
    nav: { labelKey: 'nav.consultations', icon: CalendarSearch, sectionKey: 'nav.section.admin' },
  },
  { path: '/admin/consultations/:bookingId', roles: ['admin'], element: <ConsultationScreen /> },
  {
    path: '/admin/order-cancellations', roles: ['admin'], element: <OrderCancellationsScreen />,
    nav: { labelKey: 'nav.orderCancellations', icon: PackageX, sectionKey: 'nav.section.admin' },
  },
  {
    path: '/admin/refunds', roles: ['admin'], element: <RefundsScreen />,
    nav: { labelKey: 'nav.refundsNeedingAttention', icon: Undo2, sectionKey: 'nav.section.admin' },
  },
  {
    path: '/admin/external-cancellations', roles: ['admin'], element: <ExternalCancellationsScreen />,
    nav: { labelKey: 'nav.externalCancellations', icon: Ban, sectionKey: 'nav.section.admin' },
  },
  // WQ5: settlement accounts, payouts and adjustments (`/api/v1/settlements`, admins only).
  {
    path: '/admin/settlements', roles: ['admin'], element: <SettlementsScreen />,
    nav: { labelKey: 'nav.settlements', icon: Landmark, sectionKey: 'nav.section.admin' },
  },
  { path: '/admin/settlements/:accountId', roles: ['admin'], element: <SettlementAccountScreen /> },
  {
    path: '/admin/payouts', roles: ['admin'], element: <PayoutsQueueScreen />,
    nav: { labelKey: 'nav.payouts', icon: Banknote, sectionKey: 'nav.section.admin' },
  },
  // WQ29 (r32): wallet withdrawals to the bank (`/admin/wallet-withdrawals`): mark paid with the bank's reference, reject, void.
  {
    path: '/admin/withdrawals', roles: ['admin'], element: <WithdrawalsScreen />,
    nav: { labelKey: 'nav.withdrawals', icon: Banknote, sectionKey: 'nav.section.admin' },
  },
  // WQ48 (r35 §26.10): card top-ups with a recorded dispute, every wallet (`/admin/wallet-disputes`), with Recover.
  {
    path: '/admin/wallet-disputes', roles: ['admin'], element: <WalletDisputesScreen />,
    nav: { labelKey: 'nav.cardDisputes', icon: ShieldAlert, sectionKey: 'nav.section.admin' },
  },
];

/** A page's menu words for this user (a partner page may be named after the partner's kind). */
export const navLabelKey = (p: WorkspacePage, user: Pick<StaffUser, 'partner'>): NavKey => {
  const kind = user.partner?.partner.kind;
  return (kind && p.nav?.labelKeyByKind?.[kind]) || p.nav!.labelKey;
};

/** The pages this person may open: by role, and for partners by the member's permissions, partner kind and scope. */
export function pagesFor(user: Pick<StaffUser, 'role' | 'partner'>): WorkspacePage[] {
  return PAGES.filter((p) => {
    if (!p.roles.includes(user.role)) return false;
    if (user.role !== 'partner') return true;
    const m = user.partner?.member;
    if (!m) return false;
    if (p.partnerKinds && !p.partnerKinds.includes(user.partner!.partner.kind)) return false;
    const needs = p.partnerPermissionsByKind?.[user.partner!.partner.kind] ?? p.partnerPermissions;
    if (needs && !holdsAny(m, needs)) return false;
    if (p.partnerWide && !hasGlobalScope(m)) return false;
    return true;
  });
}
