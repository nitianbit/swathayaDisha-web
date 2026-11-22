export { ApiError, createApiClient } from './client.ts';
export type { ApiClient, ApiClientOptions, Page, QueryValue, RequestOptions } from './client.ts';
export { authApi, EMAIL_NOT_REGISTERED_MESSAGE, EMAIL_NOT_REGISTERED_STAFF_MESSAGE, isEmailNotRegistered, maskTarget, MAX_EMAIL, normalizeEmail, OTP_PATTERN, parseLoginIdentifier, partnerSelectionOf, PHONE_PATTERN, requestKeysApi, targetKey, targetKind } from './auth.ts';
export type { OnceOnlyKind, PartnerChoice, PartnerSelection, SignInMode, VerifyAnswer } from './auth.ts';
export type { NativeApp, NativeRefreshed, NativeSignedIn, NativeTokens, OtpTarget, Profile, SessionRefreshed, SessionSignedIn, SignedIn, UserType } from './auth.ts';
export {
  ADMIN_ACTOR, ALL_PARTNER_PERMISSIONS, canAddOwner, canChangeBranches, canEditEmail, canEditPermissions, canGiveEmail, EMAIL_IN_USE_MESSAGE, isEmailInUse, isOwnerRequired, memberEmail, canEditProfile, canReopenBranches, REQUEST_KEY_PATTERN, EMAIL_PATTERN, grantablePermissions, GSTIN_PATTERN,
  hasGlobalScope, HHMM_PATTERN, holdsAny, INVOICE_PREFIX_PATTERN, ISO_DATE_PATTERN, MAX_HOLIDAYS, MAX_NAME, OBJECT_ID_PATTERN,
  PAN_PATTERN, PARTNER_KIND_LABEL, PARTNER_PERMISSIONS, PARTNER_PHONE_PATTERN, partnerAdminApi, partnerWorkspaceApi,
  partnerWorkspaceBase, PERMISSION_LABEL, removalBlock, scopeProblem, TAX_REGIME_LABEL, VERIFICATION_LABEL, WEEKDAYS,
} from './partners.ts';
// WQ11b: doctor memberships, owner emails (Q16b), closed branches and GST state codes.
export {
  DOCTOR_MEMBER_REMOVAL, GST_STATE_CODE_PATTERN, INVALID_BRANCH_IDS_MESSAGE, isInvalidBranchIds, isOwnerEmailAdminOnly, isUseDoctorUnlink,
  OWNER_EMAIL_ADMIN_ONLY_MESSAGE,
} from './partners.ts';
export type {
  Branch, BranchAddress, BranchInput, BranchServices, MemberRole, MyPartnerUpdate, NewMember, NewPartner, Partner,
  PartnerActorView, PartnerAuditEvent, PartnerKind, PartnerMember, PartnerPermission, PartnerQuery, PartnerScope,
  PartnerUpdate, TaxRegime, VerificationState, Version, Weekday, WeeklyHours,
} from './partners.ts';
// WQ10b: professional registrations (report signers), admin pharmacies and admin consultations.
export { canEditProfessional, MAX_REGISTRATION, MIN_REGISTRATION, PROFESSIONAL_KIND_LABEL, PROFESSIONAL_KINDS, professionalInput } from './partners.ts';
export type { MemberProfessional, ProfessionalKind } from './partners.ts';
export {
  EMPTY_PHARMACY_FORM, isPharmacyEmailTaken, isPharmacyPhoneTaken, pharmacyHolds, signsPharmacyOut, MAX_DRUG_LICENSE, MAX_GST_NUMBER, MAX_PHARMACY_NAME, MAX_PHARMACY_NICKNAME,
  MAX_PHARMACY_OWNER, PHARMACY_FIELDS, PHARMACY_PAGE_SIZE, PHARMACY_PHONE_PATTERN, PHARMACY_PINCODE_PATTERN, pharmacyAdminApi, pharmacyBody, pharmacyForm, pharmacyState,
} from './adminPharmacies.ts';
export type { NewPharmacy, PharmacyAccount, PharmacyDetails, PharmacyForm, PharmacyQuery, PharmacyUpdate } from './adminPharmacies.ts';
export {
  adminNoShowMove, consultationAdminApi, consultationQueryProblem, CONSULTATION_STATUS_FILTERS, CONSULTATION_STATUS_LABEL, CONSULTATIONS_PAGE_SIZE,
  ADMIN_CANCEL_REFUSAL, canAdminCancelMovedNoShow, MAX_ADMIN_CANCEL_REASON, MIN_ADMIN_CANCEL_REASON,
} from './adminConsultations.ts';
export type { AdminConsultation, ConsultationQuery, ConsultationStatus, DoctorRef } from './adminConsultations.ts';
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
// WQ10a pharmacy: shared order/payment words, cancel rule, suppliers, add stock and stock imports.
export { cancelRefusal, ORDER_STATUS_LABEL, orderStatusLabel, PAYMENT_STATUS_LABEL, paymentStatusLabel } from './pharmacyOrders.ts';
export {
  allSuppliers, draftOfSupplier, isSupplierConflict, pharmacySuppliersApi, SUPPLIER_FIELD_LABEL, SUPPLIER_FIELDS, SUPPLIER_LIMITS,
  SUPPLIER_PHONE_PATTERN, supplierCreateBody, supplierHas, supplierPatchBody, supplierProblems, SUPPLIERS_PAGE_MAX,
} from './pharmacySuppliers.ts';
export type { PharmacySupplier, SupplierDraft, SupplierField, SupplierFields, SupplierState } from './pharmacySuppliers.ts';
export {
  ADD_STOCK_REASONS, IMPORT_ACCEPT, IMPORT_COLUMNS, IMPORT_EXPIRY_FORMS, IMPORT_NUMBER_NOTE, IMPORT_STUCK_AFTER_MS, importStuck, IMPORT_MAX_BYTES, IMPORT_MODES, IMPORT_ROW_STATUS_LABEL, IMPORT_STATUS_LABEL, importCommittable,
  importFileProblem, importRetryable, importSettled, importTemplateCsv, isImportClaimed, isRealYyyymmdd, MAX_STOCK_NOTE, pharmacyStockApi,
  serverToday, STOCK_LIMITS, stockEntryBody, stockEntryProblems,
  IMPORT_DATE_FORMAT, IMPORT_PRICE_FIELDS, IMPORT_TIMEOUT_MS, IMPORT_UPLOAD_REFUSAL, importPlan, importPriceOf, importSetPrices, importUploadRefusal,
  importZeroPrices, importPriceView, importLeavesUnpriced, isTemplateExample, isSupplierRefusal, monthFirstRows, recentSameFile, SUPPLIER_REFUSAL, TEMPLATE_EXAMPLE_MARK,
} from './pharmacyStock.ts';
export type {
  AddStockReason, ImportCommitError, ImportMode, ImportRow, ImportRowStatus, ImportStatus, InventoryImport, Medicine, StockAdjustment, StockEntry,
  StockEntryDraft, DeliverySupplier, ImportCurrentPrices, ImportPrice, ImportPriceView,
} from './pharmacyStock.ts';
export { adminQueuesApi } from './adminQueues.ts';
export type { CancelState, OpenCancellation, ProviderOutcome, RefundAttentionRow } from './adminQueues.ts';
export { appointmentInstant, canCancelNow } from './cancellationWindow.ts';
export type { CancelCheck } from './cancellationWindow.ts';
export { BOOKING_PAYMENT_WINDOW_MIN, COUPON_PATTERN, customerApi, payByTime, RELATIONSHIPS } from './customer.ts';
export type {
  Booking, BookingPayment, BookingStatus, ConsultationMode, CouponCheck, CustomerProfile, NewConsultation, PaymentOrder, Slot, Specialist, Dependent, ExternalBooking, ExternalIntegration, Gender, NewDependent,
  ProfileUpdate, Relationship, Wallet, WalletTransaction,
} from './customer.ts';
export { clearWebSignOutPending, isSignedOutAnswer, isIdListSlot, isTransientSessionError, markerStore, markWebSignOutPending, samePrincipal, sessionChannel, webSignOutState, withSessionLock } from './webSession.ts';
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
  addDays, ADMIN_LAB_BOOKINGS_PAGE_MAX, canReadDrafts, capacityProblem, COLLECTOR_PHONE_PATTERN, eligibleSigners, isBookable, isLabBookingChanged,
  isRealDate, isReportTooLarge, isTemplateChanged, isUploadFailed, istDateOf,
  LAB_BOOKING_STATUS_LABEL, LAB_BOOKING_STATUSES, LAB_BOOKINGS_PAGE_MAX, LAB_PAYMENT_STATUS_LABEL, LAB_VISIT_MODE_LABEL, LAB_VISIT_MODES, labActions, labSlotEnd, REPORT_UPLOAD_TIMEOUT_MS,
  labBookingsAdminApi, labNoShowMove, manualSlotProblems, MAX_COLLECTOR_NAME, MAX_LAB_REASON,
  MAX_WINDOWS_PER_DAY, MIN_LAB_REASON, mondayOf, partnerLabsApi, releaseOf, reopenable, REPORT_ACCEPT, REPORT_MAX_BYTES,
  reportFileBooking, reportFileName, reportFileProblem, ROLLING_DAYS, SLOT_CAPACITY_MIN, SLOT_CLOSURE_LABEL, SLOT_MINUTES_MAX,
  SLOT_MINUTES_MIN, SLOT_SEATS_MAX, slotTimesFor, templateInput, TEMPLATE_WEEKDAYS, templateProblems, weekdayOf,
} from './partnerLabs.ts';
export type {
  AdminLabBookingQuery, AdminLabBookingRow, AdminNoShowCancel, CollectorInput, ExpansionResult, LabAction, LabActionOffer, LabBooking, LabBookingItem,
  LabBookingQuery, LabBookingSlot, LabBookingStatus, LabLifecycleKey, LabNoShowMove, LabPaymentStatus, LabReportRelease, LabSlot, NewManualSlot,
  SlotClosure, SlotQuery, SlotTemplate, SlotTemplateInput, SlotWindow, TemplateDays, TemplateVersion,
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
  AppointmentBill, AppointmentQuery, BookingNoShowMove, ClinicAppointment, ClinicAppointmentStatus, ClinicDoctorRow, DeskAction, DeskActionOffer, DeskAppointment, DeskSlotKnown,
  DeskBookingInput, DeskGender, DeskKeyAbandon, DeskPatientInput, DeskRelation, DeskBookingResult, DeskSlot, DoctorInvite,
  DoctorInviteState, DoctorLinkResult, DoctorUnlinkResult, LinkDoctorInput,
} from './clinic.ts';
export { isNoShowMoveUsed, isSlotRefusal, NO_SHOW_MOVE_REFUSAL, noShowMovedOnce } from './noShows.ts';
export type { NoShowHistory } from './noShows.ts';
// WQ4 doctor tools: names shared with finance.ts are exported with a Doctor prefix.
export {
  APPOINTMENT_STATUS_LABEL, appointmentActions, appointmentStart, CONSULT_MINUTES, CONSULT_MODE_LABEL, CONSULT_MODES, doctorAdminApi, doctorClinicProblems,
  doctorNoShowMove, doctorStanding, doctorToolsApi, MAX_DIRECTORY_SEARCH, movableSlot, sessionEndOf, noShowModeRefusal, noShowSlotFits, NO_SHOW_GRACE_MS, APPOINTMENT_REFUSAL, appointmentRefusal,
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
// WQ12: assisted booking for walk-in patients (pharmacy), the booked list with the dispensing copy, and the wallet.
export {
  ASSISTED_GENDERS, ASSISTED_KEY_PATTERN, ASSISTED_RELATIONS, assistedRefusal, BOOKING_STATUS_LABEL, bookingStatusLabel, canBookerCancel, canonicalPhone,
  CONSENT_STATEMENT, CONSENT_STATEMENT_LANGUAGE, CONSENT_STATEMENT_VERSION, ASSISTED_MODE_LABEL, EMPTY_PATIENT, familyBookedBefore, formatSlotDate,
  isAssistedLimit, isSwitchedOff, joinWords, MAX_BOOKER_CANCEL_REASON, MAX_CONCERN, MAX_PERSON_NAME, movementLabel, PATIENT_LANGUAGES,
  patientBody, patientProblems, pharmacyAssistedApi, pharmacyWalletApi, rxOrderProblems, signedPaiseOf, SWITCHED_OFF_MESSAGE, walletBalancePaise, walletState,
} from './assisted.ts';
export type {
  AssistedDoctor, AssistedGender, AssistedPatient, AssistedRelation, BookedConsultation, BookingStatus as AssistedBookingStatus, ByKeyAnswer, CancelAnswer,
  ConsultationReceipt, ConsultationRequest, AssistedMode, DispensingCopy, DoctorQuery, DoctorSlots, DoctorSlotsQuery, AssistedSlot, JoinOn, PatientDraft, PatientLookup, PharmacyWallet,
  Refusal, RefusalKind, RxMedicine, RxOrderAnswer, RxOrderItem, RxOrderRequest, TopupCheck, TopupOrder, WalletMovement,
} from './assisted.ts';
