export { ApiError, createApiClient } from './client.ts';
export type { ApiClient, ApiClientOptions, Page, QueryValue, RequestOptions } from './client.ts';
export { authApi, OTP_PATTERN, PHONE_PATTERN } from './auth.ts';
export type { OtpTarget, Profile, SignedIn, UserType } from './auth.ts';
export {
  fetchableFileUrl, pharmacyOrdersApi, PRESCRIPTION_REVIEWABLE_STATUSES, refId, REGISTRATION_NUMBER_PATTERN,
} from './pharmacyOrders.ts';
export type {
  OrderItem, OrderQuery, OrderStatus, PaymentStatus, PharmacyOrder, PrescriptionReview,
  PrescriptionReviewRequest, PrescriptionStatus, Ref,
} from './pharmacyOrders.ts';
