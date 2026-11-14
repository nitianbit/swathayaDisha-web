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
 * PUT /users/:id (self). A customer may only ADD a missing phone or email; the backend silently ignores a change to
 * an existing one (A1), so the app never sends one.
 */
export interface ProfileUpdate {
  name?: string;
  email?: string;
  phone?: string;
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

export type BookingStatus = 'pending' | 'confirmed' | 'completed' | 'cancelled';

/** Ordinary bookings (doctor consultations, wellness packages; module `bookings`). */
export interface Booking {
  _id: string;
  bookingType: 'package' | 'consultation' | 'second-opinion' | 'surgery';
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
  cancelledAt?: string;
  createdAt?: string;
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

const hex = /^[0-9a-fA-F]{24}$/;
const id = (v: string, what: string) => { if (!hex.test(v)) throw new Error(`Invalid ${what} id`); return v; };

export function customerApi(c: ApiClient) {
  return {
    profile: () => c.get<{ user: CustomerProfile }>('/auth/profile').then((d) => d.user),
    updateProfile: (userId: string, body: ProfileUpdate) => c.put<{ user: CustomerProfile }>(`/users/${id(userId, 'user')}`, { body })
      .then((d) => d.user),

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
