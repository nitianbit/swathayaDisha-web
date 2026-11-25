import {
  assistedRefusal, CONSENT_STATEMENT, CONSENT_STATEMENT_VERSION, pharmacyAssistedApi, PHARMACY_PAYER, type ApiClient, type AssistedBookerApi, type BookerKind,
  type CardPayer, type Refusal,
} from '@jansetu/api';
import { pharmacyPayWallet, type PayWallet } from './walletPay.tsx';

/**
 * WQ24: who books a doctor consultation for a walk-in patient, for the screens Book consultation and Booked
 * consultations: a pharmacy (WQ12) or a lab member at one of its branches (r21, round 2e). One flow and one look; only
 * the routes, the wallet that pays, where card payments are settled, the consent words and the pages differ.
 */
export interface ConsultBooker {
  kind: BookerKind;
  /** Who books, in memory slots and query keys: the pharmacy's id, or the lab workspace's identity. */
  id: string;
  api: AssistedBookerApi;
  refusal: (err: unknown) => Refusal;
  /** The booked list and one booking are read under this key; the doctor reads under `doctorsKey`. */
  bookingsKey: readonly unknown[];
  doctorsKey: readonly unknown[];
  /** The wallet that pays (its balance, its top-up, its page). */
  wallet: PayWallet;
  /** Where a card payment of a booking is verified and reconciled. */
  payer: CardPayer;
  consent: { statement: string; version: string };
  paths: { book: string; list: string };
  /** A lab's active branches in the member's scope (the doctor reads and the create name one); a pharmacy has none. */
  branches?: readonly { id: string; name: string }[];
}

/** The pharmacy's booking (WQ12–WQ16): its routes, keys, wallet and pages exactly as before. */
export function pharmacyConsultBooker(api: ApiClient, pharmacyId: string): ConsultBooker {
  return {
    kind: 'pharmacy', id: pharmacyId, api: pharmacyAssistedApi(api), refusal: assistedRefusal,
    bookingsKey: ['pharmacy-bookings', pharmacyId], doctorsKey: ['assisted-doctors', pharmacyId],
    wallet: pharmacyPayWallet(api, pharmacyId), payer: PHARMACY_PAYER,
    consent: { statement: CONSENT_STATEMENT, version: CONSENT_STATEMENT_VERSION },
    paths: { book: '/pharmacy/book', list: '/pharmacy/consultations' },
  };
}
