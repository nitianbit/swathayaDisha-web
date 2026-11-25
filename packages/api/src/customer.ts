import type { ApiClient, Page } from './client.ts';

/** Customer (userType 'user') APIs. Shapes mirror src1 (user, dependents, wallet, bookings, externalBookings). */

export type Gender = 'Male' | 'Female' | 'Other';

export interface CustomerProfile {
  _id: string;
  name?: string;
  phone?: string;
  email?: string;
  /** YYYYMMDD */
  dateOfBirth?: string;
  gender?: Gender;
  bloodGroup?: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
  isVerified?: boolean;
}

/**
 * PUT /users/:id (self): profile details only. Contacts are never sent here: an email is added by proving it
 * (`sendEmailCode`/`verifyEmailCode`), and the backend ignores an unproven phone or email from a customer's own update
 * (it saves the rest and names them in `ignoredContacts`).
 */
export interface ProfileUpdate {
  name?: string;
  dateOfBirth?: string;
  gender?: Gender;
  bloodGroup?: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
}

export const RELATIONSHIPS = ['Me', 'Father', 'Mother', 'Spouse', 'Son', 'Daughter', 'Brother', 'Sister', 'Grandfather',
  'Grandmother', 'Friend', 'Other'] as const;
export type Relationship = (typeof RELATIONSHIPS)[number];

export interface Dependent {
  _id: string;
  userId: string;
  name: string;
  relationship: string;
  age?: number;
  gender?: Gender;
  dateOfBirth?: string;
  phone?: string;
  isActive?: boolean;
}

export interface NewDependent {
  name: string;
  relationship: Relationship;
  gender?: Gender;
  dateOfBirth?: string;
  phone?: string;
}

export interface Wallet { _id: string; userId: string; balance: number; isActive: boolean }

export interface WalletTransaction {
  _id: string;
  transactionType: 'credit' | 'debit' | 'refund' | 'cashback' | 'promotion';
  amount: number;
  balanceAfter: number;
  status: 'pending' | 'completed' | 'failed' | 'cancelled';
  description?: string;
  referenceType?: string;
  /** YYYYMMDD */
  transactionDate?: string;
  createdAt?: string;
}

/** Q4: 'no_show' = the patient did not attend a paid consultation (not refunded). */
export type BookingStatus = 'pending' | 'confirmed' | 'completed' | 'cancelled' | 'no_show';

/** Ordinary bookings (doctor consultations, wellness packages; module `bookings`). */
export interface Booking {
  _id: string;
  bookingType: 'package' | 'consultation' | 'second-opinion' | 'surgery';
  specialistId?: string;
  paymentTransactionId?: string;
  dependentId?: string | null;
  packageName?: string;
  doctorName?: string;
  consultationMode?: string;
  /** YYYYMMDD */
  bookingDate: string;
  bookingTime: string;
  price?: number;
  status: BookingStatus;
  paymentStatus: 'pending' | 'paid' | 'failed' | 'refunded';
  cancellationReason?: string;
  /** Why the server cancelled it: 'payment_timeout' = not paid within the payment window (backend D2). */
  cancellationCause?: string;
  /** Q4b: 'instant' = made when a doctor accepted a "Consult now" request (no customer cancel; the doctor may cancel). */
  bookingKind?: 'scheduled' | 'instant';
  instantRequestId?: string;
  /** Google Meet for call/video consultations (best effort; may be missing or failed). */
  virtualMeeting?: { provider?: string; status?: 'active' | 'cancelled' | 'failed'; joinUrl?: string };
  /** Request key of the create that made it (keyed creates only): finds a booking whose answer was lost. */
  createRequestKey?: string;
  cancelledAt?: string;
  createdAt?: string;
  /**
   * Q14 (`publicNoShowView`): a missed appointment the doctor or clinic moved once to a new time (`bookingDate`/`bookingTime` are the new
   * time; `fromDate`/`fromTime` the missed one). Such a booking is never refunded (409 NO_SHOW_NOT_REFUNDABLE on cancel).
   */
  noShows?: { at?: string; rescheduledAt?: string; fromSlotId?: string; fromDate?: string; fromTime?: string; toSlotId?: string }[];
  noShowReschedules?: number;
}

/** An unpaid priced booking is held this long from its creation, then released (backend D2). */
export const BOOKING_PAYMENT_WINDOW_MIN = 30;

/** When the hold of an unpaid booking ends, or null if its creation time is unknown. The server decides; this is a hint. */
export function payByTime(createdAt?: string): Date | null {
  const t = createdAt ? Date.parse(createdAt) : NaN;
  return Number.isFinite(t) ? new Date(t + BOOKING_PAYMENT_WINDOW_MIN * 60_000) : null;
}

export type ExternalIntegration = 'labstack' | 'healthians';

/** Lab tests and doctor visits fulfilled by a provider (module `externalBookings`). */
export interface ExternalBooking {
  _id: string;
  integration: ExternalIntegration;
  providerType?: string;
  appointmentType?: string;
  bookingDate: string;
  bookingTime: string;
  patientName?: string;
  doctorName?: string;
  labName?: string;
  packageNames?: string[];
  testNames?: string[];
  price?: number;
  paymentStatus?: 'pending' | 'paid' | 'cancelled' | 'refunded';
  /** Includes 'cancellation_requested' while the provider has not confirmed a cancellation (A2b). */
  status?: string;
  createdAt?: string;
}

/** GET /specialists (verified, active; corporate-scoped by the server). Only public fields are read. */
export interface Specialist {
  _id: string;
  name: string;
  specialization?: string;
  degree?: string;
  experienceYears?: number;
  languages?: string[];
  bio?: string;
  rating?: number;
  city?: string;
  hospitalOrClinic?: string;
  profilePictureUrl?: string;
  consultationFee?: number;
  isConsultationFree?: boolean;
  availability?: { acceptVideoConsultations?: boolean; acceptChatConsultations?: boolean };
}

/** GET /slots/specialist/:id?date= — only bookable slots are returned. */
export interface Slot {
  _id: string;
  specialistId: string;
  /** YYYYMMDD */
  date: string;
  /** "9:30 AM" */
  startTime: string;
  endTime: string;
  maxBookings: number;
  currentBookings: number;
}

export type ConsultationMode = 'chat' | 'call' | 'video' | 'in-person';

export interface NewConsultation {
  specialistId: string;
  slotId: string;
  /** The slot's own date and start time (the server overwrites the time with the slot's). */
  bookingDate: string;
  bookingTime: string;
  consultationMode: ConsultationMode;
  primaryConcern: string;
  dependentId?: string;
  couponCode?: string;
  useWalletBalance?: boolean;
}

/** Razorpay order details for Checkout; `amount` in rupees (already net of wallet and coupon). */
export interface PaymentOrder {
  paymentTransactionId: string;
  razorpayOrderId: string;
  razorpayKeyId: string;
  amount: number;
  currency: string;
  baseAmount?: number;
  discountAmount?: number;
  walletDeductedAmount?: number;
}

export interface BookingPayment {
  booking: Booking & { paymentTransactionId?: string };
  paymentRequired: boolean;
  /** The create key was already used: this is that booking; resume payment from the booking page. */
  replayed?: boolean;
  walletDeductedAmount?: number;
  payment?: PaymentOrder;
}

export interface CouponCheck { isValid: boolean; discountAmount?: number; finalAmount?: number; coupon?: { code: string; title?: string } }

export const COUPON_PATTERN = /^[A-Z0-9]{3,50}$/;

const hex = /^[0-9a-fA-F]{24}$/;
const id = (v: string, what: string) => { if (!hex.test(v)) throw new Error(`Invalid ${what} id`); return v; }; // i18n-ignore: a programming error, not shown

export function customerApi(c: ApiClient) {
  return {
    profile: () => c.get<{ user: CustomerProfile }>('/auth/profile').then((d) => d.user),
    updateProfile: (userId: string, body: ProfileUpdate) => c.put<{ user: CustomerProfile }>(`/users/${id(userId, 'user')}`, { body })
      .then((d) => d.user),
    /**
     * WQ9: an email is added by proving it (`POST /auth/email-verification/send|verify`, signed in; `normalizeEmail` form).
     * Only a missing email can be added (422 `EMAIL_CHANGE_ADMIN_ONLY` otherwise). The verify answer also carries a
     * long-lived bearer token: it is dropped here, never kept (this session goes on as it is).
     */
    sendEmailCode: (email: string) => c.post<unknown>('/auth/email-verification/send', { body: { email } }).then(() => undefined),
    verifyEmailCode: (email: string, otp: string) =>
      c.post<unknown>('/auth/email-verification/verify', { body: { email, otp } }).then(() => undefined),

    /** Active family members only, filtered by the server before paging (archived ones must not use up pages). */
    dependents: (userId: string, page = 1, limit = 50) =>
      c.page<Dependent>('/dependents', { query: { userId, isActive: 'true', page, limit, sortBy: 'createdAt', sortOrder: 'asc' } }),
    addDependent: (userId: string, body: NewDependent) => c.post<Dependent>('/dependents', { body: { ...body, userId } }),

    wallet: (userId: string) => c.get<Wallet>(`/wallet/user/${id(userId, 'user')}`),
    /** Always paginated: without page+limit the backend ignores filters. */
    transactions: (userId: string, page = 1, limit = 20) =>
      c.page<WalletTransaction>(`/wallet/user/${id(userId, 'user')}/transactions`, { query: { page, limit, sortBy: 'createdAt', sortOrder: 'desc' } }),

    /** Always paginated: without page+limit the customer list ignores every filter and sort. */
    bookings: (page = 1, limit = 20) =>
      c.page<Booking>('/bookings', { query: { page, limit, sortBy: 'bookingDate', sortOrder: 'desc' } }),
    booking: (bookingId: string) => c.get<Booking>(`/bookings/${id(bookingId, 'booking')}`),
    /** Paid bookings refund to the wallet. Repeating a cancel is harmless. */
    cancelBooking: (bookingId: string, reason?: string) =>
      c.post<Booking>(`/bookings/${id(bookingId, 'booking')}/cancel`, { body: reason ? { cancellationReason: reason } : {} }),

    doctors: (page = 1, limit = 20, search?: string) =>
      c.page<Specialist>('/specialists', { query: { page, limit, sortBy: 'rating', sortOrder: 'desc', search: search || undefined } }),
    doctor: (specialistId: string) => c.get<Specialist>(`/specialists/${id(specialistId, 'doctor')}`),
    doctorSlots: (specialistId: string, date: string) => {
      if (!/^\d{8}$/.test(date)) throw new Error('Invalid date'); // i18n-ignore: a programming error, not shown
      return c.get<Slot[]>(`/slots/specialist/${id(specialistId, 'doctor')}`, { query: { date } });
    },
    /** With a request key: the same key and details again return the first booking (`replayed`), never a second. */
    bookConsultation: (body: NewConsultation, requestKey: string) =>
      c.post<BookingPayment>('/bookings', { body: { bookingType: 'consultation', ...body, requestKey } }),
    /** Checks every payment attempt of a booking with Razorpay (applies a lost capture); `unknown` = some not checkable now. */
    reconcileBookingPayments: (bookingId: string) =>
      c.post<{ booking: Booking; unknown: number }>(`/bookings/${id(bookingId, 'booking')}/reconcile-payments`),
    /** A new Razorpay order for an unpaid booking. */
    retryPayment: (bookingId: string, body: { useWalletBalance?: boolean; couponCode?: string } = {}) =>
      c.post<BookingPayment>(`/bookings/${id(bookingId, 'booking')}/retry-payment`, { body }),
    /** Browser-side proof from Razorpay Checkout's handler. Safe to repeat. */
    verifyPayment: (p: { paymentTransactionId: string; razorpayOrderId: string; razorpayPaymentId: string; razorpaySignature: string }) =>
      c.post<{ context: string; paymentRecord: { status: string; isProcessed?: boolean }; entity: unknown }>('/payments/verify', { body: p }),
    /** Server asks Razorpay for this payment's own order; settles a captured payment whose verify never arrived. */
    reconcilePayment: (paymentTransactionId: string) =>
      c.post<{ state: 'paid' | 'unpaid'; paymentRecord?: { status: string } }>('/payments/reconcile', { body: { paymentTransactionId: id(paymentTransactionId, 'payment') } }),
    checkCoupon: (b: { code: string; specialistId: string; purchaseAmount: number; dependentId?: string }) =>
      c.post<CouponCheck>('/coupons/validate', { body: { code: b.code, bookingType: 'consultation', bookingId: b.specialistId,
        purchaseAmount: b.purchaseAmount, ...(b.dependentId ? { dependentId: b.dependentId } : {}) } }),

    /** One provider per call: the backend defaults a missing integration to 'labstack'. */
    externalBookings: (integration: ExternalIntegration, page = 1, limit = 20) =>
      c.page<ExternalBooking>('/external-bookings/bookings', { query: { integration, page, limit } }),
    externalBooking: (bookingId: string) => c.get<ExternalBooking>(`/external-bookings/bookings/${id(bookingId, 'booking')}`),
    /** Answers status 'cancelled' (done) or 'cancellation_requested' (waits for the provider; no refund until then). */
    cancelExternal: (bookingId: string, reason?: string) =>
      c.post<ExternalBooking>(`/external-bookings/bookings/${id(bookingId, 'booking')}/cancel`, { body: reason ? { cancellationReason: reason } : {} }),
  };
}

export type { Page };
