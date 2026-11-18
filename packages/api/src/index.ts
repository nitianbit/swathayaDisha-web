export { ApiError, createApiClient } from './client.ts';
export type { ApiClient, ApiClientOptions, Page, QueryValue, RequestOptions } from './client.ts';
export { authApi, OTP_PATTERN, partnerSelectionOf, PHONE_PATTERN, requestKeysApi } from './auth.ts';
export type { OnceOnlyKind, PartnerChoice, PartnerSelection, SignInMode, VerifyAnswer } from './auth.ts';
export type { NativeApp, NativeRefreshed, NativeSignedIn, NativeTokens, OtpTarget, Profile, SessionRefreshed, SessionSignedIn, SignedIn, UserType } from './auth.ts';
export {
  ADMIN_ACTOR, ALL_PARTNER_PERMISSIONS, canAddOwner, canChangeBranches, canEditPermissions, canEditProfile, canReopenBranches, REQUEST_KEY_PATTERN, EMAIL_PATTERN, grantablePermissions, GSTIN_PATTERN,
  hasGlobalScope, HHMM_PATTERN, holdsAny, INVOICE_PREFIX_PATTERN, ISO_DATE_PATTERN, MAX_HOLIDAYS, MAX_NAME, OBJECT_ID_PATTERN,
  PAN_PATTERN, PARTNER_KIND_LABEL, PARTNER_PERMISSIONS, PARTNER_PHONE_PATTERN, partnerAdminApi, partnerWorkspaceApi,
  partnerWorkspaceBase, PERMISSION_LABEL, removalBlock, scopeProblem, TAX_REGIME_LABEL, VERIFICATION_LABEL, WEEKDAYS,
} from './partners.ts';
export type {
  Branch, BranchAddress, BranchInput, BranchServices, MemberRole, MyPartnerUpdate, NewMember, NewPartner, Partner,
  PartnerActorView, PartnerAuditEvent, PartnerKind, PartnerMember, PartnerPermission, PartnerQuery, PartnerScope,
  PartnerUpdate, TaxRegime, VerificationState, Version, Weekday, WeeklyHours,
} from './partners.ts';
export { clearSignOutPending, markSignOutPending, nativeSecureStore, nativeSignOut, refreshTokenKey, rotateNative, signOutState } from './nativeSession.ts';
export type { SecureStore, SignOutState } from './nativeSession.ts';
export {
  CANCELLABLE_STATUSES, DELIVERY_EXCEPTION_FROM, fetchableFileUrl, ORDER_TRANSITIONS, pharmacyOrdersApi, pharmacyProfileApi, PRESCRIPTION_REVIEWABLE_STATUSES,
  refId, REGISTRATION_NUMBER_PATTERN,
} from './pharmacyOrders.ts';
export type {
  BatchAllocation, CancelRequest, CustomerReturn, CustomerReturnLine, CustomerReturnRequest, DeliveryException,
  DeliveryExceptionType, OrderItem, OrderQuery, OrderStatus, PaymentMode, PaymentStatus, Pharmacist, PharmacyOrder,
  PrescriptionRefund, PrescriptionRefundStatus, PrescriptionReview, PrescriptionReviewRequest, PrescriptionStatus, Ref,
} from './pharmacyOrders.ts';
export {
  BATCH_ACTION_FROM, formatExpiry, inventoryApi, medicineName, REALLOCATABLE_ORDER_STATUSES, sellableQty, todayYyyymmdd,
} from './inventory.ts';
export type {
  Batch, BatchStatus, Dispensed, HeldUnit, ImpactedOrder, InventoryItem, MedicineRef, QualityHoldRow, RecallTrace, Supplier,
  SupplierReturn, SupplierReturnReason, SupplierReturnRequest,
} from './inventory.ts';
export { adminQueuesApi } from './adminQueues.ts';
export type { CancelState, OpenCancellation, ProviderOutcome, RefundAttentionRow } from './adminQueues.ts';
export { appointmentInstant, canCancelNow } from './cancellationWindow.ts';
export type { CancelCheck } from './cancellationWindow.ts';
export { BOOKING_PAYMENT_WINDOW_MIN, COUPON_PATTERN, customerApi, payByTime, RELATIONSHIPS } from './customer.ts';
export type {
  Booking, BookingPayment, BookingStatus, ConsultationMode, CouponCheck, CustomerProfile, NewConsultation, PaymentOrder, Slot, Specialist, Dependent, ExternalBooking, ExternalIntegration, Gender, NewDependent,
  ProfileUpdate, Relationship, Wallet, WalletTransaction,
} from './customer.ts';
export { markerStore, samePrincipal, sessionChannel, withSessionLock } from './webSession.ts';
export type { PendingMarker, Principal, SessionAnnouncement } from './webSession.ts';
export { customerPharmacyApi, normalizeCart, PHARMACY_PAYMENT_WINDOW_MIN, shelfOf } from './customerPharmacy.ts';
export type { Cart, CartItem, Checkout, CheckoutResult, PharmacyStore, ShelfItem, StockRow } from './customerPharmacy.ts';
export {
  allowedGstRates, catalogueAdminApi, chargesGst, classifyDocument, customerGstinProblem, DOCUMENT_KIND_LABEL, GST_RATES,
  dueOf, INVOICE_PHONE_PATTERN, INVOICE_STATE_LABEL, INVOICE_STATES, invoicePdfName, MAX_PAYMENT_SPLITS, paidOf, paymentProblem, takesPayment, ITEM_KINDS_FOR, ITEM_REQUEST_KEY_PATTERN, usesVisitModes, MAX_BILL_MINOR, MAX_CANCEL_REASON, MAX_CATALOGUE_SEARCH, MAX_CODE, MAX_DESCRIPTION,
  MAX_ITEM_NAME, MAX_LINE_DESCRIPTION, MAX_LINES, MAX_NOTE, MAX_PREPARATION, MAX_PRICE_MINOR, MAX_QTY, MAX_REFERENCE, MAX_SAC,
  MAX_SAMPLE_TYPE, paiseToInput, paiseToRupees, partnerBillingApi, PAYMENT_MODES, previewInvoice, registrationProblem,
  rupeesToPaise, STATE_CODE_PATTERN, taxRateProblem,
} from './partnerInvoices.ts';
export type {
  CatalogueItem, CatalogueItemKind, CatalogueItemUpdate, CatalogueKeyAbandon, ClinicDoctor, DocumentKind, GstRate, Invoice, InvoiceCustomer, InvoiceEvent,
  InvoiceGender, InvoiceLine, InvoicePaymentMode, InvoicePreview, InvoiceQuery, InvoiceState, InvoiceSupplier, InvoiceTotals,
  LinePreview, NewCatalogueItem, NewInvoice, NewInvoiceLine, PaymentAnswer, PaymentInput, PaymentSplit, RefundInput, SupplierTax, VisitMode,
} from './partnerInvoices.ts';
export {
  addDays, canReadDrafts, capacityProblem, COLLECTOR_PHONE_PATTERN, deriveTemplate, eligibleSigners, isBookable, isRealDate, istDateOf,
  LAB_BOOKING_STATUS_LABEL, LAB_BOOKING_STATUSES, LAB_PAYMENT_STATUS_LABEL, LAB_VISIT_MODE_LABEL, LAB_VISIT_MODES, labActions,
  labBookingsAdminApi, labNoShowMove, manualSlotProblems, MAX_ADMIN_LAB_BOOKINGS, MAX_COLLECTOR_NAME, MAX_LAB_BOOKINGS, MAX_LAB_REASON,
  MAX_WINDOWS_PER_DAY, MIN_LAB_REASON, mondayOf, partnerLabsApi, releaseOf, reopenable, REPORT_ACCEPT, REPORT_MAX_BYTES,
  reportFileBooking, reportFileName, reportFileProblem, ROLLING_DAYS, SLOT_CAPACITY_MIN, SLOT_CLOSURE_LABEL, SLOT_MINUTES_MAX,
  SLOT_MINUTES_MIN, SLOT_SEATS_MAX, slotTimesFor, TEMPLATE_WEEKDAYS, templateProblems, weekdayOf,
} from './partnerLabs.ts';
export type {
  AdminLabBookingQuery, AdminLabBookingRow, CollectorInput, ExpansionResult, LabAction, LabActionOffer, LabBooking, LabBookingItem,
  LabBookingQuery, LabBookingSlot, LabBookingStatus, LabLifecycleKey, LabNoShowMove, LabPaymentStatus, LabReportRelease, LabSlot, NewManualSlot,
  SlotClosure, SlotQuery, SlotTemplate, SlotTemplateInput, SlotWindow, TemplateDays,
} from './partnerLabs.ts';
export {
  ACCOUNT_NUMBER_PATTERN, ACCOUNTS_PAGE_MAX, DETAILS_STATE_LABEL, IFSC_PATTERN, isStatementCsv, istToday, PAGE_CURSOR_PATTERN, PAGE_LIMIT_MAX,
  LEDGER_KIND_LABEL, MAX_ACCOUNT_NAME, MAX_ACCOUNT_SEARCH, MAX_BANK_NAME, MAX_FINANCE_MINOR, MAX_FINANCE_REASON, MAX_PAYOUT_NOTE,
  MAX_PAYOUT_REFERENCE, MAX_UPI_ID, MIN_FINANCE_REASON, MIN_REFERENCE, OWNER_KIND_LABEL, partnerFinanceApi, PAYOUT_METHOD_LABEL, PAYOUT_METHODS,
  PAYOUT_STATE_LABEL, payoutDetailsProblems, payoutProblems, PAYOUTS_LIMIT_MAX, reasonProblem, settlementsApi, STATEMENT_CURSOR_PATTERN,
  STATEMENT_PAGE_MAX, statementCsvName, UPI_ID_PATTERN,
} from './finance.ts';
export type {
  AccountRow, AccountsPage, AccountsQuery, AdjustmentInput, AdjustmentKeyAbandon, FinanceEvent, FinanceSummary, FinanceTotals, HistoryRef, LedgerEntry, LedgerKind,
  PageQuery, PayoutDetailsInput, PayoutDetailsState, PayoutDetailsView, PayoutKeyAbandon, PayoutMethod, PayoutsQuery, PayoutState, PeriodQuery, QueuePayout, RecordPayoutInput,
  SettlementAccount, SettlementOwnerKind, SettlementPayout, StatementLine, StatementPage, StatementQuery,
} from './finance.ts';
export {
  appointmentAt, appointmentDay, appointmentRangeProblem, canonicalMobile, CLINIC_APPOINTMENT_STATUS_LABEL, CLINIC_APPOINTMENT_STATUSES, clinicBranchesFor,
  DESK_GENDERS, DESK_RELATIONS, deskActions, deskBookingProblems, doctorsAtBranch, DOCTOR_INVITE_STATE_LABEL, DOCTOR_INVITE_STATES, familyMemberProblems,
  LINK_REFUSAL, linkProblems, MAX_APPOINTMENT_DAYS, MAX_APPOINTMENTS, MAX_DESK_CANCEL_REASON, MAX_DESK_NAME, MAX_DESK_NOTES, MAX_FAMILY_NAME, MAX_LINK_BRANCHES,
  partnerClinicApi,
} from './clinic.ts';
export type {
  AppointmentBill, AppointmentQuery, BookingNoShowMove, ClinicAppointment, ClinicAppointmentStatus, ClinicDoctorRow, DeskAction, DeskActionOffer, DeskAppointment,
  DeskBookingInput, DeskGender, DeskKeyAbandon, DeskPatientInput, DeskRelation, DeskBookingResult, DeskSlot, DoctorInvite,
  DoctorInviteState, DoctorLinkResult, DoctorUnlinkResult, LinkDoctorInput,
} from './clinic.ts';
export { isNoShowMoveUsed, isSlotRefusal, NO_SHOW_MOVE_REFUSAL, noShowMovedOnce } from './noShows.ts';
export type { NoShowHistory } from './noShows.ts';
// WQ4 doctor tools: names shared with finance.ts are exported with a Doctor prefix.
export {
  APPOINTMENT_STATUS_LABEL, appointmentActions, appointmentStart, CONSULT_MINUTES, CONSULT_MODE_LABEL, CONSULT_MODES, doctorAdminApi, doctorClinicProblems,
  doctorNoShowMove, doctorStanding, doctorToolsApi, MAX_DIRECTORY_SEARCH, movableSlot,
  DOCTOR_ROLLING_DAYS, EXTEND_MINUTES_MAX, fromYmd, HEARTBEAT_MS, INSTANT_FEE_MAX_MINOR, INSTANT_MODES, INSTANT_REFUSAL, instantRefusal,
  FINANCE_PAGE, LEDGER_KIND_LABEL as DOCTOR_LEDGER_KIND_LABEL, meetingLinkState, OFFER_MS, offerSecondsLeft, payoutDetailsProblems as doctorPayoutDetailsProblems, periodProblem, presenceProblems, PRESENCE_TTL_MS, SCHEDULE_MINUTES_MAX,
  SCHEDULE_MINUTES_MIN, SCHEDULE_WEEKDAYS, SCHEDULE_WINDOWS_MAX, scheduleProblems, schedulableBranches, scheduleSlotCount, soloPracticeProblems,
  STATEMENT_LIMIT_MAX, statementCsvName as doctorStatementCsvName, toYmd,
} from './doctorTools.ts';
export type {
  AppointmentAction, AppointmentStatus, ClinicBranchRef, ConsultMode, DirectoryDoctor, DoctorAppointment, DoctorClinicCreated, DoctorClinicFound, DoctorClinicInput,
  DoctorProfile, DoctorSchedule, DoctorSlot, DoctorToolsApi,
  FinanceEvent as DoctorFinanceEvent, FinanceSummary as DoctorFinanceSummary, HistoryRef as DoctorHistoryRef, InstantBookingView, InstantMode, InstantOffer, LedgerKind as DoctorLedgerKind, MyClinics, Payout, PayoutDetailsInput as DoctorPayoutDetailsInput, PayoutDetailsState as DoctorPayoutDetailsState,
  PayoutDetailsView as DoctorPayoutDetailsView, Presence, PresenceInput, PresenceWrite, Reservation, ScheduleDays, ScheduleExpansion, ScheduleInput, ScheduleSaved, ScheduleWindow,
  SettlementAccountView, SoloPractice, SoloPracticeCreated, SoloPracticeInput, StatementLine as DoctorStatementLine, StatementPage as DoctorStatementPage, StatementQuery as DoctorStatementQuery,
} from './doctorTools.ts';
// WC1 customer app: names shared with the workspace modules are exported with a Customer prefix.
export {
  addressErrors, customerLabsApi, fromPaise, istDay, labPayableMinor, normalizeLab, LAB_ADDRESS_LIMITS, LAB_CANCEL_CUTOFF_HOURS, LAB_MAX_ITEMS, LAB_PAYMENT_WINDOW_MIN,
  LAB_PINCODE_PATTERN, labCancelCheck, labTimeline,
} from './customerLabs.ts';
export type {
  LabAddress, LabBooking as CustomerLabBooking, LabBookingItem as CustomerLabBookingItem, LabBookingPayment, LabBookingSlot as CustomerLabBookingSlot, LabBookingStatus as CustomerLabBookingStatus, LabBranch, LabCancelCheck, LabCatalogueItem,
  LabSlot as CustomerLabSlot, NewLabBooking, PartnerLab, TimelineStep, VisitMode as CustomerVisitMode,
} from './customerLabs.ts';
export { BILL_KIND_LABEL, BILL_PAYMENT_MODE, billFileName, customerBillsApi, gstSplit } from './customerBills.ts';
export type { Bill, BillDocumentKind, BillEvent, BillLine, BillPaymentMode, BillState, BillTotals } from './customerBills.ts';
export {
  countdown, heldRefundMinor, INSTANT_INACTIVITY_MIN, INSTANT_MODE_LABEL, INSTANT_MODES as CUSTOMER_INSTANT_MODES, INSTANT_OFFER_MIN, INSTANT_PAYMENT_WINDOW_MIN,
  instantConsultApi, instantPayableMinor, SPECIALITY_LIMITS, waitingState,
} from './instantConsult.ts';
export type {
  InstantMode as CustomerInstantMode, InstantPayment, InstantQuote, InstantSpeciality, InstantRequest, InstantStatus, InstantTarget, MoneySplit, NewInstantRequest, OnlineDoctor,
} from './instantConsult.ts';
