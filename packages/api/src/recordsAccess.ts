import type { ApiClient } from './client.ts';
import { idOf } from './assisted.ts';
import { doctorToolsApi } from './doctorTools.ts';

/**
 * WQ28: records access (assisted booking round 3f, backend r30 `m0/r30-phase3f`, design ASSISTED_BOOKING_DESIGN.md §25.17).
 * While a doctor treats a patient (the treating window of one of its consultations) it may see the patient's OTHER
 * consultations' prescriptions and released partner-lab reports, once the account holder allows it in the customer app.
 * Every read is logged by the server. This module holds routes, shapes and rules only: the words live in the apps'
 * catalogues (`records`), keyed by the server's codes. Only what the screens show is kept from an answer, so no patient
 * contact details or other health details sit in the query cache.
 */

export type RecordsRequestState = 'pending' | 'approved' | 'denied' | 'expired' | 'replaced';
export interface RecordsGrantBrief { at: string; expiresAt: string; via: string }
/** The treating view's `access`: the consultation's window, the grant in force and this consultation's latest request. */
export interface RecordsAccess {
  window: { opensAt: string | null; closesAt: string | null };
  grant: RecordsGrantBrief | null;
  request: { state: RecordsRequestState; createdAt: string; expiresAt: string } | null;
  /** Present for a partner-booked consultation (the server's constant: the identity was attested by the partner). */
  identityNote?: string;
}
/** One of the doctor's own consultations with this person (date `YYYYMMDD`). */
export interface OwnConsultation { bookingId: string; bookingDate: string; bookingTime: string; consultationMode?: string; status: string }
/** Another doctor's consultation with a prescription (DR24 allowlist, kept to what the list shows). */
export interface OtherConsultation { bookingId: string; date: string | null; doctorName: string | null; specialization: string | null; prescriptionFile: string | null }
/** A released partner-lab report (date `YYYY-MM-DD`). */
export interface OtherLabReport { labBookingId: string; labName: string | null; date: string | null; tests: string[]; releases: { file: string; releasedAt?: string }[] }
export interface TreatingRecords {
  consultations: OwnConsultation[];
  /** Only with the holder's grant in force (and the switch on). */
  others: { consultations: OtherConsultation[]; labReports: OtherLabReport[] } | null;
  access: RecordsAccess;
}
export type RecordsRequestAnswer =
  | { state: 'pending'; requestId: string; expiresAt: string; channels: { app: boolean; sms: boolean } }
  | { state: 'approved'; grant: RecordsGrantBrief };

type Row = Record<string, unknown>;
const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** The server's treating view, kept to what the records page shows. */
export function pickTreating(raw: { consultations?: Row[]; others?: { consultations?: Row[]; labReports?: Row[] } | null; access: RecordsAccess }): TreatingRecords {
  return {
    consultations: (raw.consultations ?? []).map((b) => ({ bookingId: String(b.bookingId), bookingDate: String(b.bookingDate ?? ''), bookingTime: String(b.bookingTime ?? ''),
      ...(text(b.consultationMode) ? { consultationMode: String(b.consultationMode) } : {}), status: String(b.status ?? '') })),
    others: raw.others ? {
      consultations: (raw.others.consultations ?? []).map((b) => ({ bookingId: String(b.bookingId), date: text(b.date), doctorName: text(b.doctorName),
        specialization: text(b.specialization), prescriptionFile: text(b.prescriptionFile) })),
      labReports: (raw.others.labReports ?? []).map((b) => ({ labBookingId: String(b.labBookingId), labName: text(b.labName), date: text(b.date),
        tests: Array.isArray(b.tests) ? b.tests.map(String) : [],
        releases: (Array.isArray(b.releases) ? b.releases as Row[] : []).filter((r) => text(r.file)).map((r) => ({ file: String(r.file), ...(text(r.releasedAt) ? { releasedAt: String(r.releasedAt) } : {}) })) })),
    } : null,
    access: raw.access,
  };
}

/** The doctor's side (specialist token; a verified, active doctor for the treating view and the request). */
export function doctorRecordsApi(c: ApiClient) {
  return {
    /**
     * The treating view of one of the doctor's consultations: the account is read from the booking, then
     * `GET /specialists/me/patients/:userId/history?bookingId=` (the own consultations of that person, `access`, and
     * `others` under a grant). Each call is a logged read on the server.
     */
    treating: async (bookingId: string): Promise<TreatingRecords> => {
      const booking = await doctorToolsApi(c).appointment(bookingId);
      const raw = await c.get<Parameters<typeof pickTreating>[0]>(`/specialists/me/patients/${idOf(String(booking.userId ?? ''), 'patient')}/history`,
        { query: { bookingId: idOf(bookingId, 'booking') } });
      return pickTreating(raw);
    },
    /** Asks the account holder (in the app). A grant already in force answers `approved` and creates nothing. */
    request: (bookingId: string) => c.post<RecordsRequestAnswer>(`/specialists/me/bookings/${idOf(bookingId, 'booking')}/records-access/request`),
  };
}

/**
 * Where the doctor's request stands now: a grant in force is `approved`; a pending one past its expiry counts as expired,
 * as a replaced one; an approved request whose grant ended or was stopped by the holder is `none` (ask again).
 */
export type RecordsAccessState = 'none' | 'pending' | 'approved' | 'denied' | 'expired';
export function recordsAccessState(a: RecordsAccess, now = new Date()): RecordsAccessState {
  if (a.grant && Date.parse(a.grant.expiresAt) > now.getTime()) return 'approved';
  const r = a.request;
  if (!r || r.state === 'approved') return 'none';
  if (r.state === 'pending') return Date.parse(r.expiresAt) > now.getTime() ? 'pending' : 'expired';
  return r.state === 'denied' ? 'denied' : 'expired';
}

// ── The account holder's side (customer app, user token; another account: 403 FORBIDDEN / 404) ──

export interface RecordsParty { doctor: { id: string; name: string | null; specialization: string | null }; patient: { personKey: string; name: string | null } }
export interface HolderRecordsRequest extends RecordsParty {
  _id: string; state: RecordsRequestState; treatingBookingId: string; createdAt: string; expiresAt: string; decidedAt: string | null;
}
export interface HolderRecordsGrant extends RecordsParty {
  _id: string; state: 'active' | 'revoked' | 'expired'; via: string; at: string; expiresAt: string; revokedAt: string | null;
}

export function holderRecordsApi(c: ApiClient) {
  return {
    /** Newest 50; `pending` lists only the unexpired ones. */
    requests: (state?: RecordsRequestState) => c.get<HolderRecordsRequest[]>('/records-access/requests', { query: state ? { state } : {} }),
    approve: (id: string) => c.post<{ request: HolderRecordsRequest; grant: HolderRecordsGrant }>(`/records-access/requests/${idOf(id, 'request')}/approve`),
    deny: (id: string) => c.post<{ request: HolderRecordsRequest; grant: null }>(`/records-access/requests/${idOf(id, 'request')}/deny`),
    /** Newest 100. */
    grants: () => c.get<HolderRecordsGrant[]>('/records-access/grants'),
    revoke: (id: string) => c.post<{ grant: HolderRecordsGrant; alreadyRevoked: boolean }>(`/records-access/grants/${idOf(id, 'grant')}/revoke`),
  };
}

/** The server's code of a refusal (`error.<code>` keys in the apps' records catalogues), or null. */
export const recordsErrorCode = (err: unknown): string | null =>
  err && typeof err === 'object' && 'code' in err && typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : null;
