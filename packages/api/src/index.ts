export { ApiError, createApiClient } from './client.ts';
export { messageOf, networkWords, tooLongWords } from './messages.ts';
export type { ApiClient, ApiClientOptions, Page, QueryValue, RequestOptions } from './client.ts';
export { authApi, CLINIC_DOCTOR_NOT_VERIFIED_MESSAGE, EMAIL_NOT_REGISTERED_MESSAGE, EMAIL_NOT_REGISTERED_STAFF_MESSAGE, isClinicDoctorNotVerified, isEmailNotRegistered, maskTarget, MAX_EMAIL, normalizeEmail, OTP_PATTERN, parseLoginIdentifier, partnerSelectionOf, PHONE_PATTERN, requestKeysApi, targetKey, targetKind } from './auth.ts';
export type { OnceOnlyKind, PartnerChoice, PartnerSelection, SignInMode, VerifyAnswer } from './auth.ts';
export type { NativeApp, NativeRefreshed, NativeSignedIn, NativeTokens, OtpTarget, Profile, SessionRefreshed, SessionSignedIn, SignedIn, UserType } from './auth.ts';
export {
  ADMIN_ACTOR, ALL_PARTNER_PERMISSIONS, canAddOwner, canChangeBranches, canEditEmail, canEditPermissions, canGiveEmail, EMAIL_IN_USE_MESSAGE, isEmailInUse, isOwnerRequired, memberEmail, canEditProfile, canReopenBranches, REQUEST_KEY_PATTERN, EMAIL_PATTERN, grantablePermissions, permissionsForKind, WALLET_PERMISSIONS, GSTIN_PATTERN,
  hasGlobalScope, HHMM_PATTERN, holdsAny, isFinanceReader, INVOICE_PREFIX_PATTERN, ISO_DATE_PATTERN, MAX_HOLIDAYS, MAX_NAME, OBJECT_ID_PATTERN,
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
  DeliveryExceptionType, OrderItem, OrderQuery, OrderStatus, PaymentMode, PaymentStatus, Pharmacist, PharmacyOrder, PharmacyOwnProfile, OrderBill,
  PrescriptionRefund, PrescriptionRefundStatus, PrescriptionReview, PrescriptionReviewRequest, PrescriptionStatus, Ref,
} from './pharmacyOrders.ts';
export {
  BATCH_ACTION_FROM, formatExpiry, inventoryApi, isRxMedicine, medicineName, REALLOCATABLE_ORDER_STATUSES, sellableQty, todayYyyymmdd,
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
  MAX_PAYOUT_REFERENCE, MAX_UPI_ID, MIN_FINANCE_REASON, MIN_REFERENCE, OWNER_KIND_LABEL, partnerFinanceApi, pharmacyPayoutApi, PAYOUT_METHOD_LABEL, PAYOUT_METHODS,
  PAYOUT_STATE_LABEL, payoutDetailsProblems, payoutProblems, PAYOUTS_LIMIT_MAX, reasonProblem, settlementsApi, STATEMENT_CURSOR_PATTERN,
  STATEMENT_PAGE_MAX, statementCsvName, UPI_ID_PATTERN, isReferralOwnerKind, REFERRAL_OWNER_KINDS,
} from './finance.ts';
export type {
  AccountRow, AccountsPage, AccountsQuery, AdjustmentInput, AdjustmentKeyAbandon, FinanceEvent, FinanceSummary, FinanceTotals, HistoryRef, LedgerEntry, LedgerKind,
  PageQuery, PayoutDetailsInput, PayoutDetailsState, PayoutDetailsView, PayoutKeyAbandon, PayoutMethod, PayoutsQuery, PayoutState, PeriodQuery, QueuePayout, RecordPayoutInput,
  SettlementAccount, SettlementOwnerKind, SettlementPayout, StatementLine, StatementPage, StatementQuery, ReferralBlock, ReferralDue, ReferralOwnerKind, WithdrawalsBlock,
} from './finance.ts';
export {
  appointmentAt, appointmentDay, appointmentRangeProblem, canonicalMobile, CLINIC_APPOINTMENT_STATUS_LABEL, CLINIC_APPOINTMENT_STATUSES, clinicBranchesFor,
  DESK_GENDERS, DESK_RELATIONS, deskActions, deskBookingProblems, doctorsAtBranch, DOCTOR_INVITE_STATE_LABEL, DOCTOR_INVITE_STATES, familyMemberProblems,
  LINK_REFUSAL, linkProblems, MAX_APPOINTMENT_DAYS, MAX_APPOINTMENTS, MAX_DESK_CANCEL_REASON, MAX_DESK_NAME, MAX_DESK_NOTES, MAX_FAMILY_NAME, MAX_LINK_BRANCHES,
  partnerClinicApi,
} from './clinic.ts';
export type { DoctorBusy,
  AppointmentBill, AppointmentQuery, BookingNoShowMove, ClinicAppointment, ClinicAppointmentStatus, ClinicDoctorRow, DeskAction, DeskActionOffer, DeskAppointment, DeskSlotKnown,
  DeskBookingInput, DeskGender, DeskKeyAbandon, DeskPatientInput, DeskRelation, DeskBookingResult, DeskSlot, DoctorInvite,
  DoctorInviteState, DoctorLinkResult, DoctorUnlinkResult, LinkDoctorInput,
} from './clinic.ts';
export { isNoShowMoveUsed, isSlotRefusal, NO_SHOW_MOVE_REFUSAL, noShowMovedOnce } from './noShows.ts';
export type { NoShowHistory } from './noShows.ts';
// WQ4 doctor tools: names shared with finance.ts are exported with a Doctor prefix.
export {
  APPOINTMENT_STATUS_LABEL, appointmentActions, appointmentStart, labBookableFrom, CONSULT_MINUTES, CONSULT_MODE_LABEL, CONSULT_MODES, doctorAdminApi, doctorClinicProblems,
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
  isAssistedBooking, isAssistedLimit, isSwitchedOff, refusedBeforeWriting, SLOW_WRITE_TIMEOUT_MS, supportedModes, joinWords, MAX_BOOKER_CANCEL_REASON, MAX_CONCERN, MAX_PERSON_NAME, movementLabel, PATIENT_LANGUAGES,
  patientBody, patientProblems, pharmacyAssistedApi, pharmacyWalletApi, rxOrderProblems, isReferralSetOff, signedPaiseOf, SWITCHED_OFF_MESSAGE, walletBalancePaise, walletState,
} from './assisted.ts';
// WQ13: booker reschedule, the typed-name edit, the doctor card's next free time; admin wallet credits.
export {
  canBookerReschedule, MAX_TYPED_NAME, nextFreeSlot, pharmacyCustomersApi, RESCHEDULE_RULE, rescheduleRefusal, rescheduleRuleText, rescheduleSlots,
  typedNameProblem, typedNameRefusal, typedNameTarget,
} from './assisted.ts';
export type { RescheduleAnswer, RescheduleRefusalKind, RescheduleRequest, TypedNameAnswer, TypedNameTarget } from './assisted.ts';
// WQ24: a lab member books a doctor consultation for a walk-in patient (r21, round 2e): the pharmacy's routes, by booker.
export { assistedBookerApi, LAB_CONSENT_STATEMENT, LAB_CONSENT_STATEMENT_VERSION, labAssistedApi, labBookerRefusal } from './assisted.ts';
export type { AssistedBookerApi, BookerKind } from './assisted.ts';
export {
  ADMIN_TOPUP_BY_KEY_PATH, ADMIN_TOPUP_KEY_PATTERN, ADMIN_TOPUP_PAGE_SIZE, ADMIN_TOPUP_SEARCH_PAGES, ADMIN_TOPUP_WARNING, adminTopupWarning, adminPharmacyWalletApi, adminTopupForm, adminTopupRefusal,
  adminWalletReadError, findAdminTopup, isAdminTopupRow, latestAdminCredit, topupNotFoundWords,
  MAX_ADMIN_TOPUP_NOTE, MAX_ADMIN_TOPUP_RUPEES, MIN_ADMIN_TOPUP_NOTE,
  closeCompensatedExplain, closeCompensatedFinal, closeCompensatedRefusal, closeReasonProblem, closeRefusedBeforeWriting, MAX_CLOSE_REASON, uncreditedOf,
} from './adminPharmacyWallet.ts';
export type { AdminTopupBody, AdminTopupSearch, CompensatedClose, UncreditedTopup } from './adminPharmacyWallet.ts';
// WQ16: assisted booking phase 1b: a booking paid by card or UPI, its refund, and the admin card refund queue.
export {
  adminCardRefundsApi, agreementProblem, awaitingCardPayment, bookingPaymentApi, CARD_BLOCKED_WORDS, DOCTOR_CARD_BLOCKED_WORDS, CARD_REFUND_CAUSE_LABEL, CARD_REFUND_STATE_LABEL, CARD_REFUND_STATES,
  cancelWords, cardCheckProblem, cardRefundRowsOf, cardRefundWords, checkCardPayment, findMovedRefund, LATE_CAPTURE_WORDS, MAX_REFUND_AGREEMENT, moveRefundFinal,
  moveRefundRefusal, moveRefusedBeforeWriting, outcomeOfAnswer, outcomeOfError, payByClock, payByWords, settleCardPayment,
  bookingPaidBy, bookingPayBy, findMarkedFailed, markFailedFinal, markFailedRefusal, markFailedRefusedBeforeWriting, recheckWords,
  beforeCheckout, bookingWasPaid, cardBookingState, HELD_NOT_STARTED, isCardAnswer, routeCardAnswer, checkoutSeconds, DUPLICATE_WORDS, LATE_PAYMENT_BACK, orderFromBooking, PAY_NOW_MARGIN_MS, payNowOpen, readCardRefund, recheckRefusal,
  CARD_PERMISSION_WORDS, cardBlockedWords, cardRefundCauseLabel, LAB_PAYER, PHARMACY_PAYER, payerLabel, payerNameOf, payerWord,
} from './assistedCard.ts';
export type { AdminCardRefund, CardBookingKind, CardOutcome, CardPayer, CardRefundPayerKind, CardPaymentAnswer, CardProof, CardRefundMove, CardRefundRecheck, CardRefundState, ReconcileAnswer } from './assistedCard.ts';
export type {
  AssistedCardPayment, AssistedPaymentMethod, BookingPayment as AssistedBookingPayment, CardRefund, OpenCardOrder, RefundTo,
  AssistedDoctor, AssistedGender, AssistedPatient, AssistedRelation, BookedConsultation, BookingStatus as AssistedBookingStatus, ByKeyAnswer, CancelAnswer,
  ConsultationReceipt, ConsultationRequest, AssistedMode, DispensingCopy, DoctorQuery, DoctorSlots, DoctorSlotsQuery, AssistedSlot, JoinOn, PatientDraft, PatientLookup, PharmacyWallet,
  Refusal, RefusalKind, RxMedicine, RxOrderAnswer, RxOrderItem, RxOrderRequest, TopupCheck, TopupOrder, WalletMovement,
} from './assisted.ts';
// WQ17: assisted booking phase 2a, a pharmacy books a lab test for a walk-in patient (wallet-paid).
export {
  cleanRecommendationCode, formatRecommendationCode, recommendationLookup, matchRecommended, pharmacyRecommendationsApi, recommendationRefusal, recommendationsOff,
  branchesFor, canCancelLab, LAB_BOOKER_CANCEL_CUTOFF_MS, LAB_SWITCHED_OFF_MESSAGE, labRefusal, labStatusLabel, labTotalMinor, pharmacyLabApi,
  // WQ25: a doctor books lab tests (r26 phase 3b) on the same routes, by booker.
  doctorLabApi, doctorLabBody, doctorLabRefusal, doctorRecommendationsApi, DOCTOR_LAB_CLOSED_MESSAGE, LAB_TEST_CONSENT_STATEMENT, LAB_TEST_CONSENT_VERSION,
} from './assistedLab.ts';
export type {
  TestRecommendation, AssistedLab, AssistedLabBranch, AssistedLabItem, AssistedLabSlot, LabAddress as AssistedLabAddress, LabBookingListStatus, LabBookingRequest, LabBookingView, LabByKeyAnswer,
  LabCancelAnswer, LabReceipt, ConsultationSource, LabBookerKind, LabCreateRequest, LabPatientSource, LabRoutes,
} from './assistedLab.ts';
// WQ18: admin doctors (verify with the S5 fence, unverify) and the S5c admin close and refund of a consultation.
export {
  BOOKING_CLOSE_REFUSAL, bookingCloseApi, bookingCloseFinal, bookingCloseRefusal, bookingCloseRefusedBeforeWriting,
  canCloseAndRefund, closeByKey, closeRefundTarget, closeRefundWords, doctorAdminListApi, doctorEligibility, doctorStateRefusal, doctorStateRefusedBeforeWriting, DOCTORS_PAGE_SIZE,
  fenceHolds, isAlreadyCancelled, isFenceMismatch, MAX_DOCTOR_NAME_SEARCH, verifyFenceOf,
} from './adminDoctors.ts';
export type { AdminDoctor, AdminDoctorQuery, BookingClose, CloseRefundTarget, BookingCloseAnswer, BookingCloseBody, DoctorStateBody, VerifyFence } from './adminDoctors.ts';
// WQ19: the lab front desk (r12): walk-in, lab visit and home collection booked by the lab, paid at the lab.
export {
  canBillDesk, canDeskCancel, deskItems, deskRefusal, deskTotalMinor, isDeskBooking, LAB_DESK_CONSENT_STATEMENT, LAB_DESK_CONSENT_VERSION,
  LAB_DESK_SWITCHED_OFF_MESSAGE, labDeskApi,
} from './labDesk.ts';
export type { DeskBookingRequest, DeskByKey, DeskCancelAnswer, DeskCollector, DeskReceipt } from './labDesk.ts';
// WQ20: the lab wallet (r13), shown with the pharmacy wallet's screens.
export {
  asMovement, asPharmacyWallet, LAB_ADMIN_TOPUP_MAX_MINOR, LAB_TOPUP_MAX_MINOR, LAB_TOPUP_MIN_MINOR, LAB_TOPUP_STATE_LABEL,
  LAB_WALLET_SWITCHED_OFF_MESSAGE, labTopupCheckable, labWalletApi,
  // WQ23: the doctor's wallet (r20) on the same routes and shapes.
  adminOwnerWalletApi, chargebackLot, chargebackTook, DOCTOR_WALLET_CLOSED_MESSAGE, DOCTOR_WALLET_SWITCHED_OFF_MESSAGE, doctorWalletApi, isDoctorWalletClosed, ownerWalletRefusal,
} from './labWallet.ts';
export type {
  LabTopupOrder, LabTopupRow, LabTopupState, LabWalletEntry, LabWalletLot, LabWalletView, OwnWalletApi, WalletOwner, WalletOwnerKind,
} from './labWallet.ts';
// WQ22: the pharmacy's "Consult now" (r17): an instant consultation for a walk-in, paid from the wallet.
export {
  bookerInstantBody, changedQuote, INSTANT_ACTIVITY_MS, INSTANT_DESK_MODES, INSTANT_POLL_MS, INSTANT_SWITCHED_OFF_MESSAGE, instantBookerRefusal, instantStage,
  offerCountdown, pharmacyInstantApi,
} from './assistedInstant.ts';
export type { InstantBookerByKey, InstantBookerReceipt, InstantBookerRequest, InstantBookerStatus, InstantBookerView, InstantDeskMode, InstantDoctor } from './assistedInstant.ts';
// WQ28: records access (r30 phase 3f): the doctor's treating view and request, the account holder's answers.
export { doctorRecordsApi, holderRecordsApi, pickTreating, recordsAccessState, recordsErrorCode } from './recordsAccess.ts';
export type {
  HolderRecordsGrant, HolderRecordsRequest, OtherConsultation, OtherLabReport, OwnConsultation, RecordsAccess, RecordsAccessState, RecordsGrantBrief,
  RecordsParty, RecordsRequestAnswer, RecordsRequestState, TreatingRecords,
} from './recordsAccess.ts';
// WQ26: referral cuts (phase 4a/4b): the admin's rules per partner and category, and the pharmacy's referral earnings.
export {
  basisPointsToInput, CAP_PROBLEM, FIXED_PROBLEM, MAX_REFERRAL_REASON, PERCENT_PROBLEM, percentToBasisPoints, referralReadsApi, REFERRAL_BOOKER_KINDS,
  REFERRAL_CATEGORIES, REFERRAL_CATEGORY_LABEL, REFERRAL_FIXED_MIN_MINOR, REFERRAL_PERCENT_MAX_BP, REFERRAL_PERCENT_MIN_BP, REFERRAL_RULE_REFUSAL,
  REFERRAL_STATEMENT_PAGE, referralDraftOf, referralRowOf, referralRuleBody, referralRuleRefusal, referralRuleRefusedBeforeWriting,
  referralRulesAdminApi, referralRuleText, referralTermsOf, referralTermsText, sameRuleTerms, ruleTerms,
} from './referralCuts.ts';
export type {
  ReferralBasis, ReferralBookerKind, ReferralCategory, ReferralDraft, ReferralDraftErrors, ReferralLine, ReferralMode, ReferralReader, ReferralRow, ReferralRule,
  ReferralRuleEvent, ReferralRuleInput, ReferralRules, ReferralStatementLine, ReferralSummary, ReferralSwitches, ReferralTerms,
} from './referralCuts.ts';
// WQ29: wallet withdrawals to the bank (r32 round 4d, switched off on the server) and the admin's Recover.
export {
  adminWithdrawalsApi, doctorWithdrawalsApi, isPaidReference, labWithdrawalsApi, pharmacyWithdrawalsApi, quoteChangedOf, walletRecoverApi, weeklyWait,
  withdrawalAmountProblem, withdrawalErrorCode, withdrawalErrorDetails,
} from './walletWithdrawals.ts';
export type {
  AdminWithdrawal, DestinationState, PaidBody, PaidMethod, QuoteReason, RecoverAnswer, WalletAfter, Withdrawable, Withdrawal, WithdrawalAnswer, WithdrawalByKey,
  WithdrawalsApi, WithdrawalState,
} from './walletWithdrawals.ts';
// WQ48 (r35 rounds 4e/4f): the pharmacy's Finance reads, and the admin's card disputes, top-ups without a lot and set-off.
export { adminWalletFinanceApi, DISPUTE_STATES, pharmacyFinanceApi, WALLET_KINDS } from './walletFinance.ts';
export type {
  DisputeState, FinanceStatementKind, PharmacyFinance, SetOff, SetOffAnswer, SetOffByKey, TopupWithoutLot, WalletDispute, WalletKind,
} from './walletFinance.ts';
// WQ50: the pharmacy's counter sale (a linked or walk-in customer, its stock, an optional prescription, paid at the counter).
export { COUNTER_PAYMENTS, MAX_CUSTOMER_NAME, MAX_SALE_SEARCH, pharmacySaleApi, SALE_KEY_PATTERN, saleRequestBody, usableCustomers, walkInProblems } from './pharmacySale.ts';
export type { CounterPayment, SaleAnswer, SaleBody, SaleByKey, SaleCustomer, SaleLine } from './pharmacySale.ts';
// WQ54 (P1): the simple pharmacy home: the day's register and the pharmacy's to-dos (backend r37).
export {
  bookingsWaiting, CLINIC_PENDING_KEYS, LAB_PENDING_KEYS, MAX_TODO_TEXT, moneyParts, PAYMENT_METHOD_KEYS, PENDING_KEYS, pendingCount, pharmacyTodayApi, TODAY_PAGE_MAX, TODAY_SEARCH_MAX,
  TODAY_SEARCH_MIN, todayApi, todayLink, todayOf, todoText,
} from './pharmacyToday.ts';
export type { ClinicPendingKey, LabPendingKey, PaymentMethodKey, PendingKey, TodayAnswer, TodayApi, TodayDesk, TodayItem, TodayKind, TodayLinkKind, TodayPending, TodayTotals, Todo, WhatParts } from './pharmacyToday.ts';
// WQ56 (P2): the doctor's single dashboard (backend r39): one appointment list, his clinic and online bookings, the breakdown.
export { DOCTOR_PENDING_KEYS } from './pharmacyToday.ts';
export type { DoctorPendingKey } from './pharmacyToday.ts';
export { APPOINTMENT_SOURCES, bookableClinics, byPartner, doctorDashboardApi, keyedBookingId, FOLLOW_UP_DAYS, followUpLastDay, followUpOpen, freeSlots, MAX_LIST_DAYS, ownedClinic } from './doctorDashboard.ts';
export type {
  AppointmentListQuery, AppointmentSource, BreakdownQuery, DoctorClinicAnswer, DoctorClinicBooking, DoctorConsultationAnswer, DoctorConsultationNew,
  DoctorDashboardApi, DoctorFollowUp, DoctorKeyedBooking, DoctorPatientRequest, DoctorVisitRequestKind, EarningChannel, EarningsBreakdown, EarningSum, ListedAppointment,
} from './doctorDashboard.ts';
