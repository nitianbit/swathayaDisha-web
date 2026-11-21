import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type Route } from '@playwright/test';

/** WQ4: doctor tools in the staff workspace (schedule, consult now, appointments, clinics, earnings), against a mocked backend. */
const DOC = 'd0'.repeat(12);
const SUNRISE = 'a2'.repeat(12);
const NEWCL = 'a4'.repeat(12);
const LAKE = 'a5'.repeat(12);
const HILL = 'a6'.repeat(12);
const PRACTICE = 'a7'.repeat(12);
const BR1 = 'c1'.repeat(12);
const BR2 = 'c2'.repeat(12);
const BR3 = 'c3'.repeat(12);
const INV1 = 'f1'.repeat(12);
const INV2 = 'f2'.repeat(12);
const PARTNER_MEMBER = 'b1'.repeat(12);
const ADMIN = 'ad'.repeat(12);
/** Tuesday 17 Nov 2026, 10:00 in India. */
const NOW = new Date('2026-11-17T04:30:00.000Z');
const plusMin = (m: number) => new Date(NOW.getTime() + m * 60_000).toISOString();
const rid = (n: number) => `e${String(n).padStart(3, '0')}`.padEnd(24, '0');
const bid = (n: number) => `b${String(n).padStart(3, '0')}`.padEnd(24, '9');

type Rec = Record<string, unknown>;
interface Call { method: string; path: string; body: unknown; auth?: string }
interface Backend {
  calls: Call[];
  live: boolean;
  who: 'specialist' | 'partner' | 'admin';
  profile: Rec;
  schedule: Rec | null;
  clinics: { clinics: Rec[]; invites: Rec[] };
  practice: Rec | null;
  /** Q14: the key the doctor's own clinic was created with; the next create is recorded, then its answer lost. */
  clinicKey?: string;
  loseNextClinic?: boolean;
  presence: Rec | null;
  offers: Rec[];
  /** requestId → refusal code, 'lost' (recorded, answer lost) or absent (accepted). */
  acceptScript: Record<string, string>;
  extendRefusal?: string;
  /** The next presence switch is applied, but its answer is lost. */
  presenceLost?: boolean;
  /** The next presence switch reaches the server only when `runLate()` is called (its answer is lost at once). */
  presenceLate?: boolean;
  runLate?: () => { status: number; code?: string };
  /** No check-in for two minutes (the read view says heartbeatExpired); a switch on or a heartbeat clears it. */
  lapsed?: boolean;
  /** The next heartbeat's answer (the presence as it was when it arrived) waits for this gate. */
  beatHold?: Promise<void>;
  /** The instant consultations' held intervals have ended (the booking read says so). */
  heldEnded?: boolean;
  /** In a consultation right now (online false, busy). */
  busyNow?: boolean;
  /** The next extension is applied but its answer lost ('applied'), or lost before reaching the server ('dropped'). */
  extendLost?: 'applied' | 'dropped';
  extensions: Record<string, { requestKey?: string; minutes: number; endTime: string; at: string }[]>;
  /** Changes made elsewhere just before the next write is decided (the server-side fences answer 409). */
  scheduleRaceOnce?: boolean;
  payoutRaceOnce?: boolean;
  /** Whether call links have been made yet for instant consultations (they are made after the accept). */
  meetReady?: boolean;
  appointments: Rec[];
  finance: Rec;
  statement: Rec[];
  payouts: Rec[];
  events: Rec[];
  hold?: { match: RegExp; gate: Promise<void> };
  /** WQ11c: the next status change to completed is refused with this code (e.g. Q16a NOT_STARTED_YET). */
  completeRefusal?: string;
  /** WQ11c: GETs whose path matches are refused 429 (a failed read again in the background). */
  failReads?: RegExp;
  /** WQ11c: the by-key route of the doctor's clinic answers a bare 404 (as if the route were missing). */
  clinicByKeyBroken?: boolean;
}

function offer(n: number, name: string, o: Rec = {}): Rec {
  return { requestId: rid(n), mode: 'video', specialization: 'Cardiology', patient: { name, age: 30 + n, gender: 'female' }, generation: 1,
    offerExpiresAt: plusMin(4), quotedAmountMinor: 80_000, ...o };
}
/** `GET /me/presence` / heartbeat view (Q13). */
function presenceView(b: Backend): Rec {
  const p = b.presence;
  const available = !!p?.available;
  const expired = !available || !!b.lapsed;
  return { doctorId: DOC, eligible: true, available, modes: p?.modes ?? [], instantFeeMinor: p?.instantFeeMinor ?? 60_000, presenceVersion: p?.presenceVersion ?? 0,
    feeConfigured: !!p, lastSeenAt: p ? NOW.toISOString() : null, heartbeatExpired: expired, busy: !!b.busyNow, busyUntil: b.busyNow ? plusMin(20) : null,
    online: available && !expired && !b.busyNow };
}
function appt(n: number, o: Rec): Rec {
  return { _id: bid(n), bookingType: 'consultation', bookingKind: 'scheduled', bookingDate: '20261117', bookingTime: '11:30', consultationMode: 'video',
    serviceMode: 'online', status: 'confirmed', paymentStatus: 'paid', price: 600, settlementSystem: 'ledger', createdAt: '2026-11-10T04:30:00.000Z', ...o };
}

function seed(): Omit<Backend, 'calls' | 'live' | 'who'> {
  const statement: Rec[] = [];
  let balance = 0;
  const rows = Array.from({ length: 60 }, (_, i) => ({ i, amount: i === 30 ? -500_000 : 60_000 }));
  for (const r of rows) balance += r.amount;
  let after = balance;
  for (let i = 59; i >= 0; i--) {
    const r = rows[i]!;
    statement.push({ _id: (i + 1).toString(16).padStart(24, '0'), at: new Date(Date.parse('2026-10-01T05:00:00.000Z') + i * 12 * 3_600_000).toISOString(),
      kind: r.amount < 0 ? 'payout' : 'earning', source: r.amount < 0 ? 'payout' : 'consultation', sourceId: bid(i),
      description: r.amount < 0 ? 'Payout · 2026-10-16 · HDFC Bank HDFC0001234 XXXX9012' : `Consultation · line ${i + 1}`,
      amountMinor: r.amount, balanceAfterMinor: after });
    after -= r.amount;
  }
  return {
    profile: { _id: DOC, name: 'Dr Meera Rao', specialization: 'Cardiology', consultationFee: 600, phone: '9000000020', isActive: true, isVerified: true },
    schedule: {
      _id: 'aa'.repeat(12), doctorId: DOC, slotMinutes: 30, isActive: true, updatedAt: '2026-11-10T04:30:00.000Z', leaveDates: ['20261120', '20261001'],
      days: { mon: [{ start: '09:00', end: '12:00', modes: ['video', 'call'] }], tue: [], wed: [{ start: '17:00', end: '19:00', modes: ['in-person'], branchId: BR1 }] },
    },
    clinics: {
      clinics: [
        { partnerId: SUNRISE, name: 'Sunrise Clinic', solo: false, verified: true, role: 'staff', branches: [{ branchId: BR1, name: 'MG Road', address: { city: 'Bengaluru' } }] },
        { partnerId: NEWCL, name: 'New Clinic', solo: false, verified: false, role: 'staff', branches: [{ branchId: BR2, name: 'Jayanagar', address: { city: 'Bengaluru' } }] },
      ],
      invites: [
        { inviteId: INV1, partnerId: LAKE, clinic: 'Lake Clinic', branches: [{ branchId: BR3, name: 'Lakeside', address: { city: 'Bengaluru' } }], createdAt: '2026-11-16T05:00:00.000Z' },
        { inviteId: INV2, partnerId: HILL, clinic: 'Hill Clinic', branches: [], createdAt: '2026-11-15T05:00:00.000Z' },
      ],
    },
    practice: null,
    presence: null,
    extensions: {},
    offers: [],
    acceptScript: {},
    appointments: [
      appt(1, { primaryConcern: 'Chest pain follow-up', virtualMeeting: { status: 'active', joinUrl: 'https://meet.google.com/sch-edul-edx' } }),
      appt(2, { bookingTime: '09:00', consultationMode: 'in-person', serviceMode: 'clinic', clinicVisit: { partnerId: SUNRISE, branchId: BR1 } }),
      appt(3, { bookingDate: '20261119', bookingTime: '10:00', status: 'pending', paymentStatus: 'pending' }),
      appt(4, { bookingDate: '20261118', bookingTime: '15:00', status: 'cancelled', paymentStatus: 'refunded', cancellationReason: 'Patient asked' }),
      appt(5, { bookingKind: 'instant', instantRequestId: rid(0), bookingTime: '09:50', virtualMeeting: { status: 'active', joinUrl: 'https://meet.google.com/abc-defg-hij' } }),
      appt(6, { bookingDate: '20261121', bookingTime: '12:00', virtualMeeting: { status: 'failed', error: 'Google Calendar / Meet is not configured' } }),
    ],
    finance: {
      account: { _id: '5e'.repeat(12), ownerKind: 'doctor', ownerId: DOC, beneficiaryName: 'Dr Meera Rao', isActive: true,
        payoutDetails: { method: 'bank', accountName: 'Dr Meera Rao', ifsc: 'HDFC0001234', bankName: 'HDFC Bank', accountNumberLast4: '9012', accountNumberMasked: 'XXXX9012' },
        payoutDetailsState: 'verified', payoutDetailsVersion: 2 },
      balanceMinor: balance,
      totals: { earnedMinor: 59 * 60_000, reversedMinor: 0, paidOutMinor: 500_000, adjustedMinor: 0 },
      lastPayout: { _id: '6e'.repeat(12), amountMinor: 500_000, method: 'bank_transfer', reference: 'UTR123456', paidOn: '2026-10-16',
        destination: { method: 'bank', label: 'HDFC Bank HDFC0001234 XXXX9012', detailsVersion: 2 }, state: 'recorded' },
    },
    statement,
    payouts: [
      { _id: '6e'.repeat(12), amountMinor: 500_000, method: 'bank_transfer', reference: 'UTR123456', paidOn: '2026-10-16',
        destination: { method: 'bank', label: 'HDFC Bank HDFC0001234 XXXX9012', detailsVersion: 2 }, state: 'recorded', createdAt: '2026-10-16T06:00:00.000Z' },
      { _id: '7e'.repeat(12), amountMinor: 100_000, method: 'upi', reference: 'UPI987654', paidOn: '2026-10-02',
        destination: { method: 'bank', label: 'HDFC Bank HDFC0001234 XXXX9012', detailsVersion: 2 }, state: 'voided', voidReason: 'Bounced back', createdAt: '2026-10-02T06:00:00.000Z' },
    ],
    // 61 events, newest first: two pages of 50 (`pagination.nextCursor`).
    events: [
      ...Array.from({ length: 60 }, (_, i) => ({ _id: (0x100 + i).toString(16).padStart(24, '8'), action: 'finance.adjustment_posted', byKind: 'admin', by: ADMIN,
        at: new Date(Date.parse('2026-11-10T05:00:00.000Z') - i * 3_600_000).toISOString() })),
      { _id: '8e'.repeat(12), action: 'finance.payout_details_verified', byKind: 'admin', by: ADMIN, at: '2026-10-01T05:00:00.000Z' },
    ],
  };
}

async function mockBackend(page: Page, o: { install?: boolean } = {}): Promise<Backend> {
  if (o.install) await page.clock.install({ time: NOW });
  else await page.clock.setFixedTime(NOW);
  const b: Backend = { calls: [], live: false, who: 'specialist', ...seed() };
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const ok = (route: Route, data: unknown, status = 200) => json(route, status, { success: true, data });
  const fail = (route: Route, status: number, code: string, message: string) => json(route, status, { error: status, code, message });

  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = req.method();
    const body = ['POST', 'PUT', 'PATCH'].includes(method) ? (req.postData() ? req.postDataJSON() : null) : null;
    if (path === '/auth/session/refresh') {
      if (!b.live) return fail(route, 401, 'SESSION_ENDED', 'Please sign in again');
      return ok(route, { token: 't1', expiresIn: 900, principal: { userId: b.who === 'specialist' ? DOC : b.who === 'partner' ? PARTNER_MEMBER : ADMIN, userType: b.who, sid: 's1' } });
    }
    if (path === '/auth/session/logout') { b.live = false; return ok(route, {}); }
    b.calls.push({ method, path: `${path}${url.search}`, body, auth: req.headers().authorization });
    const signIn = /^\/auth\/(specialist|partner|admin)\/(send|verify)$/.exec(path);
    if (signIn) {
      if (signIn[2] === 'send') return ok(route, undefined);
      b.who = signIn[1] as Backend['who'];
      b.live = true;
      return ok(route, { token: 't1', expiresIn: 900, user: {} });
    }
    if (req.headers().authorization !== 'Bearer t1') return fail(route, 401, 'UNAUTHORIZED', 'Authentication is required');
    if (path === '/auth/profile') {
      if (b.who === 'admin') return ok(route, { user: { _id: ADMIN, name: 'Ops Admin' }, userRole: 'admin' });
      if (b.who === 'partner') {
        return ok(route, { user: { _id: PARTNER_MEMBER, partnerId: SUNRISE, name: 'Ravi Owner', role: 'owner', permissions: ['staff.manage', 'branches.manage'], branchIds: [] },
          partner: { _id: SUNRISE, name: 'Sunrise Clinic', kind: 'clinic', verification: { state: 'verified' } }, userRole: 'partner' });
      }
      return ok(route, { user: b.profile, userRole: 'specialist' });
    }
    if (b.hold && b.hold.match.test(path)) { const g = b.hold.gate; b.hold = undefined; await g; }
    if (method === 'GET' && b.failReads?.test(path)) return fail(route, 429, 'RATE_LIMITED', 'Too many requests, slow down');
    const me = /^\/specialists\/me(\/.*)$/.exec(path);
    if (!me) return ok(route, []);
    if (b.who !== 'specialist') return fail(route, 403, 'FORBIDDEN', 'Specialist access is required');
    const p = me[1]!;

    if (p === '/profile') return ok(route, b.profile);
    // Schedule
    if (p === '/schedule' && method === 'GET') return ok(route, b.schedule);
    if (p === '/schedule' && method === 'PUT') {
      const t = body as { slotMinutes: number; days: Record<string, Rec[]> };
      const allowed = new Set(b.clinics.clinics.filter((c) => c.verified).flatMap((c) => (c.branches as Rec[]).map((x) => x.branchId)));
      if (Object.values(t.days).flat().some((w) => w.branchId && !allowed.has(w.branchId))) return fail(route, 403, 'CLINIC_BRANCH_NOT_ALLOWED', 'You do not consult at that clinic branch');
      if (b.scheduleRaceOnce && b.schedule) {
        b.scheduleRaceOnce = false; // changed elsewhere after the editor's re-read (Saturday hours added)
        b.schedule = { ...b.schedule, days: { ...(b.schedule.days as Rec), sat: [{ start: '10:00', end: '12:00', modes: ['chat'] }] }, updatedAt: '2026-11-17T04:29:30.000Z' };
      }
      const expectedAt = (body as { expectedUpdatedAt?: string | null }).expectedUpdatedAt;
      if (expectedAt !== undefined && (b.schedule?.updatedAt ?? null) !== expectedAt) return fail(route, 409, 'SCHEDULE_CHANGED', 'Your weekly schedule changed since you opened it; review it again');
      b.schedule = { ...(b.schedule ?? { _id: 'aa'.repeat(12), doctorId: DOC, leaveDates: [], isActive: true }), slotMinutes: t.slotMinutes, days: t.days, updatedAt: new Date().toISOString() };
      return ok(route, { template: b.schedule, expansion: { inserted: 12, updated: 3, closed: 2, reopened: 0 } });
    }
    if (p === '/leave' && method === 'POST') {
      const date = (body as { date: string }).date;
      const s = b.schedule!;
      if (!(s.leaveDates as string[]).includes(date)) s.leaveDates = [...(s.leaveDates as string[]), date];
      return ok(route, { template: s, expansion: { inserted: 0, updated: 0, closed: 4, reopened: 0 } });
    }
    const leave = /^\/leave\/(\d{8})$/.exec(p);
    if (leave && method === 'DELETE') {
      const s = b.schedule!;
      s.leaveDates = (s.leaveDates as string[]).filter((x) => x !== leave[1]);
      return ok(route, { template: s, expansion: { inserted: 0, updated: 0, closed: 0, reopened: 6 } });
    }
    // Instant
    if (p === '/presence' && method === 'GET') return ok(route, presenceView(b));
    if (p === '/presence' && method === 'PUT') {
      const x = body as { available: boolean; modes: string[]; instantFeeMinor?: number; expectedPresenceVersion?: number };
      if (b.profile.isVerified === false) return fail(route, 403, 'SPECIALIST_NOT_ACTIVE', 'Only active, verified doctors can take instant consultations');
      // `setPresence` (Q13): an ordered write when a version is named; every write bumps the version.
      const apply = () => {
        const version = (b.presence?.presenceVersion as number | undefined) ?? 0;
        if (x.expectedPresenceVersion !== undefined && x.expectedPresenceVersion !== version) return null;
        b.presence = { doctorId: DOC, available: x.available, modes: x.modes, instantFeeMinor: x.instantFeeMinor ?? 60_000, presenceVersion: version + 1 };
        if (x.available) b.lapsed = false;
        return b.presence;
      };
      if (b.presenceLate) {
        b.presenceLate = false;
        b.runLate = () => (apply() ? { status: 200 } : { status: 409, code: 'PRESENCE_CHANGED' });
        return route.abort('connectionreset');
      }
      const done = apply();
      if (!done) return fail(route, 409, 'PRESENCE_CHANGED', 'Your availability was changed meanwhile; check it and try again');
      if (b.presenceLost) { b.presenceLost = false; return route.abort('connectionreset'); }
      return ok(route, done);
    }
    if (p === '/presence/heartbeat') {
      if (b.presence?.available) b.lapsed = false;
      const view = presenceView(b);
      if (b.beatHold) { const g = b.beatHold; b.beatHold = undefined; await g; }
      return ok(route, view);
    }
    if (p === '/instant/offers') {
      const fee = (b.presence?.instantFeeMinor as number | undefined) ?? null;
      return ok(route, b.offers.map((o) => ({ ...o, yourFeeMinor: fee, feeWithinQuote: fee !== null && fee <= (o.quotedAmountMinor as number) })));
    }
    const acc = /^\/instant\/([0-9a-f]{24})\/accept$/.exec(p);
    if (acc) {
      const script = b.acceptScript[acc[1]!];
      const o = b.offers.find((x) => x.requestId === acc[1]);
      if (script === 'replay') {
        // Q13: this doctor accepted it before (the answer was lost): the same booking, `replayed`.
        const booking = appt(80, { bookingKind: 'instant', instantRequestId: acc[1], bookingTime: '09:58', consultationMode: 'chat', price: 450 });
        if (!b.appointments.some((a) => a._id === booking._id)) b.appointments.push(booking);
        b.offers = b.offers.filter((x) => x.requestId !== acc[1]);
        return ok(route, { request: { _id: acc[1], status: 'accepted' }, booking, replayed: true }, 200);
      }
      if (script && script !== 'lost') {
        const messages: Record<string, [number, string]> = {
          SPECIALIZATION_MISMATCH: [409, 'This request is for another speciality'], COUPON_NOT_FOR_DOCTOR: [409, "The patient's coupon is for other doctors"],
          DOCTOR_BUSY: [409, 'The doctor is not free at that time'], OFFER_EXPIRED: [409, 'This offer has expired'], FEE_ABOVE_QUOTE: [409, 'Your fee is above what this patient paid'],
          OFFER_NO_LONGER_AVAILABLE: [409, 'This request was taken, refunded or withdrawn'], DOCTOR_NOT_AVAILABLE: [409, 'Go online for this consultation type to accept'],
          SPECIALIST_NOT_ACTIVE: [403, 'Doctor account is not active'],
          OFFER_NO_LONGER_AFFORDABLE: [409, 'What the patient paid does not cover your fee for this request'],
        };
        const [status, message] = messages[script]!;
        return fail(route, status, script, message);
      }
      const booking = appt(90 + b.appointments.length, { bookingKind: 'instant', instantRequestId: acc[1], bookingTime: '10:00', consultationMode: o?.mode ?? 'video', price: 450 });
      b.appointments.push(booking);
      b.offers = b.offers.filter((x) => x.requestId !== acc[1]);
      if (script === 'lost') return route.abort('connectionreset');
      return ok(route, { request: { _id: acc[1], status: 'accepted' }, booking }, 201);
    }
    const ext = /^\/instant\/bookings\/([0-9a-f]{24})\/extend$/.exec(p);
    if (ext) {
      if (b.extendRefusal) return fail(route, 409, b.extendRefusal, 'The doctor is not free at that time');
      const x = body as { minutes: number; requestKey?: string };
      if (b.extendLost === 'dropped') { b.extendLost = undefined; return route.abort('connectionreset'); }
      const list = (b.extensions[ext[1]!] ??= []);
      const prior = list.find((e) => x.requestKey && e.requestKey === x.requestKey);
      const extension = prior ?? { requestKey: x.requestKey, minutes: x.minutes, endTime: plusMin(30 + list.reduce((n, e) => n + e.minutes, 0) + x.minutes), at: NOW.toISOString() };
      if (!prior) list.push(extension);
      if (b.extendLost === 'applied') { b.extendLost = undefined; return route.abort('connectionreset'); }
      return ok(route, { doctorId: DOC, kind: 'instant', refId: ext[1], startTime: NOW.toISOString(), endTime: extension.endTime, isActive: true, extension, replayed: !!prior });
    }
    const ib = /^\/instant\/bookings\/([0-9a-f]{24})$/.exec(p);
    if (ib) {
      const a = b.appointments.find((x) => x._id === ib[1]);
      if (!a) return fail(route, 404, 'BOOKING_NOT_FOUND', 'Booking not found');
      const list = b.extensions[ib[1]!] ?? [];
      return ok(route, { bookingId: ib[1], status: a.status, bookingDate: a.bookingDate, bookingTime: a.bookingTime, feeMinor: 45_000, patient: null,
        held: { startTime: NOW.toISOString(), endTime: list.at(-1)?.endTime ?? plusMin(30), isActive: !b.heldEnded, current: !b.heldEnded }, extensions: list });
    }
    // Q14: the doctor's own slots of a day, and the one move of a no-show.
    if (p === '/slots') {
      const date = url.searchParams.get('date');
      return ok(route, [
        { _id: '51'.repeat(12), date, startTime: '09:00', endTime: '09:15', maxBookings: 1, currentBookings: 0, isAvailable: true, isActive: true },
        { _id: '52'.repeat(12), date, startTime: '16:00', endTime: '16:15', maxBookings: 1, currentBookings: 0, isAvailable: true, isActive: true },
        { _id: '53'.repeat(12), date, startTime: '17:00', endTime: '17:15', maxBookings: 1, currentBookings: 1, isAvailable: false, isActive: true },
        { _id: '54'.repeat(12), date, startTime: '18:00', endTime: '18:15', maxBookings: 1, currentBookings: 0, isAvailable: true, isActive: true, branchId: BR1 },
      ]);
    }
    const nsm = /^\/bookings\/([0-9a-f]{24})\/reschedule-no-show$/.exec(p);
    if (nsm) {
      const a = b.appointments.find((x) => x._id === nsm[1]);
      if (!a) return fail(route, 404, 'BOOKING_NOT_FOUND', 'Booking not found');
      const x = body as { slotId: string; requestKey: string; expectedUpdatedAt?: string };
      const moves = (a.noShows as Rec[] | undefined) ?? [];
      if (moves.some((m) => m.requestKey === x.requestKey)) return ok(route, { ...a, replayed: true });
      if (moves.length) return fail(route, 409, 'NO_SHOW_RESCHEDULE_USED', 'This booking was already rescheduled once after a no-show; a second no-show is final');
      if (a.status !== 'no_show') return fail(route, 409, 'BOOKING_NOT_NO_SHOW', `A ${a.status} booking is not a no-show`);
      if (x.expectedUpdatedAt !== undefined && x.expectedUpdatedAt !== a.updatedAt) return fail(route, 409, 'BOOKING_CHANGED', 'Booking changed; please retry');
      Object.assign(a, { status: 'confirmed', bookingDate: '20261118', bookingTime: '16:00', noShowReschedules: 1, updatedAt: '2026-11-17T04:31:00.000Z',
        noShows: [{ at: NOW.toISOString(), rescheduledAt: NOW.toISOString(), fromDate: a.bookingDate, fromTime: a.bookingTime, toSlotId: x.slotId, requestKey: x.requestKey }] });
      return ok(route, { ...a, replayed: false });
    }
    // Appointments
    if (p === '/appointments') {
      if (b.meetReady) {
        for (const a of b.appointments) {
          if (a.bookingKind === 'instant' && !a.virtualMeeting && ['call', 'video'].includes(a.consultationMode as string)) {
            a.virtualMeeting = { status: 'active', joinUrl: `https://meet.google.com/new-${(a._id as string).slice(0, 4)}` };
          }
        }
      }
      const view = url.searchParams.get('view');
      const list = view === 'day' ? b.appointments.filter((a) => a.bookingDate === url.searchParams.get('date'))
        : b.appointments.filter((a) => (a.bookingDate as string).startsWith(url.searchParams.get('yearMonth') ?? 'x'));
      return json(route, 200, { success: true, data: list, meta: { total: list.length } });
    }
    const st = /^\/appointments\/([0-9a-f]{24})\/status$/.exec(p);
    if (st) {
      const a = b.appointments.find((x) => x._id === st[1]);
      const want = (body as { status: string }).status;
      if (!a) return fail(route, 404, 'BOOKING_NOT_FOUND', 'Booking not found');
      if (want === 'completed' && b.completeRefusal) return fail(route, 409, b.completeRefusal, 'Appointment has not started yet');
      a.status = want;
      if (want === 'cancelled') { a.paymentStatus = 'refunded'; a.cancellationReason = (body as { reason?: string }).reason; }
      return ok(route, a);
    }
    // Clinics
    if (p === '/clinics') return ok(route, b.clinics);
    const inv = /^\/clinic-invites\/([0-9a-f]{24})\/(accept|decline)$/.exec(p);
    if (inv) {
      const i = b.clinics.invites.find((x) => x.inviteId === inv[1]);
      if (!i) return fail(route, 404, 'INVITE_NOT_FOUND', 'Invitation not found');
      // Q14: invitations can no longer be accepted; declining still closes them.
      if (inv[2] === 'accept') return fail(route, 409, 'INVITE_NO_LONGER_VALID', 'Clinic invitations are no longer used; the platform team links doctors to clinics');
      b.clinics.invites = b.clinics.invites.filter((x) => x !== i);
      return ok(route, { accepted: false, partnerId: i.partnerId });
    }
    const lv = /^\/clinics\/([0-9a-f]{24})\/leave$/.exec(p);
    if (lv) {
      b.clinics.clinics = b.clinics.clinics.filter((c) => c.partnerId !== lv[1]);
      return ok(route, { left: true });
    }
    if ((p === '/practice' || p === '/clinic') && method === 'GET') return ok(route, b.practice);
    // Q14: the doctor's own clinic, keyed; a lost answer is found by its key.
    const byKey = /^\/clinic\/by-key\/([A-Za-z0-9_-]{8,100})$/.exec(p);
    if (byKey) {
      if (b.clinicByKeyBroken) return fail(route, 404, 'NOT_FOUND', 'Cannot GET this path');
      if (!b.practice || b.clinicKey !== byKey[1]) return fail(route, 404, 'CLINIC_NOT_FOUND', 'No clinic was created with this key');
      return ok(route, b.practice);
    }
    if (p === '/clinic' && method === 'POST') {
      const x = body as { name: string; requestKey: string; branch: { name: string; phone: string; address: Rec } };
      if (b.practice) {
        if (b.clinicKey === x.requestKey) return ok(route, { partner: (b.practice as Rec).partner, created: false, replayed: true });
        return fail(route, 409, 'DOCTOR_CLINIC_EXISTS', 'You already have a clinic; ask the platform team to add another');
      }
      b.clinicKey = x.requestKey;
      b.practice = { partner: { _id: PRACTICE, name: x.name, solo: true, verification: { state: 'pending' } },
        branches: [{ _id: 'c9'.repeat(12), name: x.branch.name, phone: x.branch.phone, address: x.branch.address, isActive: true }] };
      b.clinics.clinics.push({ partnerId: PRACTICE, name: x.name, solo: true, verified: false, role: 'owner', branches: [{ branchId: 'c9'.repeat(12), name: x.branch.name }] });
      if (b.loseNextClinic) { b.loseNextClinic = false; return route.abort('failed'); }
      return ok(route, { partner: (b.practice as Rec).partner, branch: ((b.practice as Rec).branches as Rec[])[0], created: true }, 201);
    }
    if (p === '/practice' && method === 'POST') {
      const x = body as { name: string; branch: { name: string; phone: string; address: Rec } };
      if (!b.practice) {
        b.practice = { partner: { _id: PRACTICE, name: x.name, solo: true, verification: { state: 'pending' } },
          branches: [{ _id: 'c9'.repeat(12), name: x.branch.name, phone: x.branch.phone, address: x.branch.address, isActive: true }] };
        b.clinics.clinics.push({ partnerId: PRACTICE, name: x.name, solo: true, verified: false, role: 'owner', branches: [{ branchId: 'c9'.repeat(12), name: x.branch.name }] });
        return ok(route, { partner: (b.practice as Rec).partner, branch: ((b.practice as Rec).branches as Rec[])[0], created: true }, 201);
      }
      return ok(route, { partner: (b.practice as Rec).partner, created: false });
    }
    // Earnings
    if (p === '/finance') return ok(route, b.finance);
    if (p === '/finance/statement') {
      const before = url.searchParams.get('before');
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      let rows = b.statement.filter((l) => (!from || (l.at as string) >= `${from}T00:00`) && (!to || (l.at as string) < `${to}T23:59`));
      if (before) { const i = rows.findIndex((l) => `${Date.parse(l.at as string)}_${l._id}` === before); rows = rows.slice(i + 1); }
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return ok(route, { lines: page, nextCursor: rows.length > limit && last ? `${Date.parse(last.at as string)}_${last._id}` : null });
    }
    if (p === '/finance/statement.csv') {
      return route.fulfill({ status: 200, contentType: 'text/csv; charset=utf-8', headers: { 'Content-Disposition': 'attachment; filename="doctor-statement.csv"' },
        body: '"Date (IST)","Type","Description","Reference","Note","Amount (INR)","Balance (INR)"\n"","Opening balance","","","","","0.00"\n' });
    }
    const paged = (rows: Rec[], field: string) => {
      const cursor = url.searchParams.get('cursor');
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const from = cursor ? rows.findIndex((r) => `${Date.parse(r[field] as string)}_${r._id}` === cursor) + 1 : 0;
      const items = rows.slice(from, from + limit);
      const last = items.at(-1);
      return json(route, 200, { success: true, data: items, pagination: { total: rows.length,
        nextCursor: from + limit < rows.length && last ? `${Date.parse(last[field] as string)}_${last._id}` : null } });
    };
    if (p === '/finance/payouts') return paged(b.payouts, 'createdAt');
    if (p === '/finance/history') return ok(route, [{ _id: '9e'.repeat(12), source: 'legacy_import', legacyKind: 'disbursal', legacyId: 'L1', periodLabel: 'Sep 2026', amountMinor: 250_000, at: '2026-09-30T05:00:00.000Z' }]);
    if (p === '/finance/events') return paged(b.events, 'at');
    if (p === '/finance/payout-details' && method === 'PUT') {
      const x = body as Rec;
      const acc2 = b.finance.account as Rec;
      if (b.payoutRaceOnce) { b.payoutRaceOnce = false; acc2.payoutDetailsVersion = (acc2.payoutDetailsVersion as number) + 1; } // changed elsewhere just now
      if (x.expectedDetailsVersion !== undefined && x.expectedDetailsVersion !== acc2.payoutDetailsVersion) {
        return fail(route, 409, 'PAYOUT_DETAILS_CHANGED', 'The payout details changed since they were loaded; review them again');
      }
      acc2.payoutDetails = x.method === 'upi' ? { method: 'upi', upiId: x.upiId, accountName: x.accountName }
        : { method: 'bank', accountName: x.accountName, ifsc: x.ifsc, bankName: x.bankName, accountNumberLast4: String(x.accountNumber).slice(-4), accountNumberMasked: `XXXX${String(x.accountNumber).slice(-4)}` };
      acc2.payoutDetailsState = 'unverified';
      acc2.payoutDetailsVersion = (acc2.payoutDetailsVersion as number) + 1;
      b.events.unshift({ _id: 'ee'.repeat(12), action: 'finance.payout_details_changed', byKind: 'doctor', by: DOC, at: NOW.toISOString() });
      return ok(route, acc2);
    }
    return fail(route, 404, 'NOT_FOUND', `No mock for ${method} ${p}`);
  });
  return b;
}

async function signIn(page: Page, as: 'Doctor' | 'Lab or clinic staff' | 'Admin' = 'Doctor') {
  await page.goto('/');
  await page.getByLabel(as, { exact: true }).check();
  await page.getByLabel('Mobile number').fill('9000000020');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

/** Switches "available now" on with the form as it is (video, the consultation fee) and waits for the server's answer. */
async function goAvailable(page: Page) {
  await page.getByRole('button', { name: 'Go available now' }).click();
  await expect(page.getByText(/You are available now for/)).toBeVisible();
}

const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' });
const writes = (b: Backend) => b.calls.filter((c) => c.method !== 'GET' && !c.path.startsWith('/auth/')).map((c) => `${c.method} ${c.path}`);
const presencePuts = (b: Backend) => b.calls.filter((c) => c.method === 'PUT' && c.path === '/specialists/me/presence').map((c) => c.body);
const heartbeats = (b: Backend) => b.calls.filter((c) => c.path === '/specialists/me/presence/heartbeat').length;
async function setVisibility(page: Page, state: 'visible' | 'hidden') {
  await page.evaluate((s) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => s === 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}
async function storage(page: Page) {
  return page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
}

test('a doctor signs in: doctor pages only, a status card on Home, and no partner, admin or pharmacy pages', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.offers = [offer(1, 'Asha Rao')];
  await signIn(page);
  expect(backend.calls.find((c) => c.path === '/auth/specialist/verify')?.body).toMatchObject({ phone: '9000000020', otp: '123456', session: 'cookie' });
  await expect(page.getByRole('heading', { name: 'Welcome, Dr Meera Rao', level: 1 })).toBeVisible();
  await expect(page.getByText('Doctor · Cardiology')).toBeVisible();
  for (const label of ['Home', 'Consult now', 'Appointments', 'Schedule', 'Clinics', 'Earnings']) await expect(nav(page).getByRole('link', { name: label, exact: true })).toBeVisible();
  await expect(nav(page).getByRole('link')).toHaveCount(6);
  const status = page.getByRole('region', { name: 'Your status' });
  await expect(status).toContainText('Verified');
  await expect(status).toContainText('Off'); // read from the server (Q13 GET /me/presence)
  await expect(status.getByRole('link', { name: '1 open offer' })).toBeVisible();
  const next = page.getByRole('list', { name: 'Next appointments' });
  await expect(next.getByRole('listitem')).toHaveCount(3); // 09:50 instant (within 30 min), 11:30 today, 19 Nov waiting
  await expect(next.getByRole('listitem').first()).toContainText('09:50');
  for (const path of ['/pharmacy/orders', '/partner', '/partner/staff', '/admin/partners', '/admin/lab-bookings']) {
    await page.goto(`/#${path}`);
    await expect(page.getByText('Page not found')).toBeVisible();
  }
});

test('lab or clinic staff and admins see no doctor pages', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page, 'Lab or clinic staff');
  expect(backend.calls.some((c) => c.path === '/auth/partner/verify')).toBe(true);
  await expect(nav(page).getByRole('link', { name: 'Consult now' })).toHaveCount(0);
  await page.goto('/#/doctor/schedule');
  await expect(page.getByText('Page not found')).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect.poll(() => backend.live).toBe(false); // the server session has ended before the next person signs in
  await signIn(page, 'Admin');
  await expect(nav(page).getByRole('link', { name: 'Earnings' })).toHaveCount(0);
  for (const path of ['/doctor/earnings', '/doctor/consult-now']) {
    await page.goto(`/#${path}`);
    await expect(page.getByText('Page not found')).toBeVisible();
  }
  expect(backend.calls.some((c) => c.path.startsWith('/specialists/'))).toBe(false);
});

test('schedule: a clinic window at a verified branch only, the server’s refusal, a change made elsewhere, and leave days', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await nav(page).getByRole('link', { name: 'Schedule' }).click();
  const hours = page.getByRole('list', { name: 'Weekly hours' });
  await expect(hours).toContainText('Monday: 09:00–12:00 (Video, Phone call)');
  await expect(hours).toContainText('Wednesday: 17:00–19:00 (In person at Sunrise Clinic · MG Road)');
  await page.getByRole('button', { name: 'Change weekly hours' }).click();
  await expect(page.getByText('Not offered until Jansetu verifies it: New Clinic.')).toBeVisible();
  // Tuesday: an in-person window at the clinic (types fixed to in person) and an online one that overlaps it.
  await page.getByRole('button', { name: 'Add a window on Tuesday' }).click();
  await page.getByLabel('Tuesday window 1 from').fill('14:00');
  await page.getByLabel('Tuesday window 1 to').fill('16:00');
  const place = page.getByLabel('Tuesday window 1 place');
  await expect(place.locator('option')).toHaveText(['Online, or your own place', 'Clinic: Sunrise Clinic · MG Road']);
  await place.selectOption(BR1);
  const types = page.getByRole('group', { name: 'Tuesday window 1 consultation types' });
  await expect(types.getByLabel('In person')).toBeChecked();
  await expect(types.getByLabel('Video')).toBeDisabled();
  await page.getByRole('button', { name: 'Add a window on Tuesday' }).click();
  await page.getByLabel('Tuesday window 2 from').fill('15:30');
  await page.getByLabel('Tuesday window 2 to').fill('17:00');
  await page.getByRole('button', { name: 'Review the weekly hours' }).click();
  await expect(page.getByText('14:00–16:00 and 15:30–17:00 overlap.')).toBeVisible();
  await page.getByLabel('Tuesday window 2 from').fill('16:00');
  await page.getByRole('group', { name: 'Tuesday window 2 consultation types' }).getByLabel('Chat').check();
  await page.getByRole('button', { name: 'Review the weekly hours' }).click();
  const confirm = page.getByRole('group', { name: 'Save the weekly hours' });
  await expect(confirm).toContainText('Tuesday: 14:00–16:00 (In person at Sunrise Clinic · MG Road); 16:00–17:00 (Video, Chat)');
  // Meanwhile the clinic stops counting this branch as the doctor's (e.g. it is no longer verified): the server refuses.
  backend.clinics.clinics[0]!.verified = false;
  await confirm.getByRole('button', { name: 'Save the weekly hours' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Not saved' })).toContainText('Not saved: You do not consult at that clinic branch');
  backend.clinics.clinics[0]!.verified = true;
  // Someone else changes Monday on the server while this edit (which also changes Monday) is open: it is not overwritten.
  await page.getByLabel('Monday window 1 to').fill('13:00');
  backend.schedule = { ...backend.schedule!, days: { ...(backend.schedule!.days as Rec), mon: [{ start: '09:00', end: '11:00', modes: ['video'] }] }, updatedAt: '2026-11-17T04:29:00.000Z' };
  await page.getByRole('button', { name: 'Review the weekly hours' }).click();
  await page.getByRole('group', { name: 'Save the weekly hours' }).getByRole('button', { name: 'Save the weekly hours' }).click();
  await expect(page.getByText(/Someone else changed the Monday hours while you were editing/)).toBeVisible();
  await expect(page.getByLabel('Monday window 1 to')).toHaveValue('11:00');
  expect(writes(backend).filter((w) => w.startsWith('PUT'))).toHaveLength(1); // only the refused one
  // Q13: a change landing after the editor's last read is refused by the server (expectedUpdatedAt) and read in.
  backend.scheduleRaceOnce = true;
  await page.getByRole('button', { name: 'Review the weekly hours' }).click();
  await page.getByRole('group', { name: 'Save the weekly hours' }).getByRole('button', { name: 'Save the weekly hours' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Not saved' })).toContainText('Not saved: Your weekly schedule changed since you opened it; review it again');
  await expect(page.getByRole('group', { name: 'Saturday: 4 slots' })).toBeVisible(); // the hours added elsewhere, read in
  await page.getByRole('button', { name: 'Review the weekly hours' }).click();
  await page.getByRole('group', { name: 'Save the weekly hours' }).getByRole('button', { name: 'Save the weekly hours' }).click();
  await expect(page.getByText('Weekly hours saved. Next 30 days: 12 slots added, 3 changed, 2 closed, 0 reopened.')).toBeVisible();
  const puts = backend.calls.filter((c) => c.method === 'PUT' && c.path === '/specialists/me/schedule');
  expect(puts).toHaveLength(3);
  expect(puts[1]!.body).toMatchObject({ expectedUpdatedAt: '2026-11-17T04:29:00.000Z' });
  expect(puts[2]!.body).toEqual({ slotMinutes: 30, days: {
    mon: [{ start: '09:00', end: '11:00', modes: ['video'] }],
    tue: [{ start: '14:00', end: '16:00', modes: ['in-person'], branchId: BR1 }, { start: '16:00', end: '17:00', modes: ['video', 'chat'] }],
    wed: [{ start: '17:00', end: '19:00', modes: ['in-person'], branchId: BR1 }], thu: [], fri: [], sat: [{ start: '10:00', end: '12:00', modes: ['chat'] }], sun: [],
  }, expectedUpdatedAt: '2026-11-17T04:29:30.000Z' });

  // Leave days: only upcoming ones are listed; adding and removing each confirm first.
  const leave = page.getByRole('list', { name: 'Upcoming leave days' });
  await expect(leave.getByRole('listitem')).toHaveCount(1);
  await expect(leave).toContainText('Fri, 20 Nov, 2026');
  await expect(page.getByText('1 earlier leave day not shown.')).toBeVisible();
  await page.getByLabel('Leave date').fill('2026-11-20');
  await page.getByRole('button', { name: 'Add a leave day' }).click();
  await expect(page.getByText('This is already a leave day.')).toBeVisible();
  await page.getByLabel('Leave date').fill('2026-11-25');
  await page.getByRole('button', { name: 'Add a leave day' }).click();
  await page.getByRole('button', { name: 'Take leave on Wed, 25 Nov, 2026' }).click();
  await expect(page.getByText('Wed, 25 Nov, 2026 is a leave day. 4 open slots closed.')).toBeVisible();
  await expect(leave.getByRole('listitem')).toHaveCount(2);
  await leave.getByRole('listitem').filter({ hasText: '20 Nov' }).getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('button', { name: 'Remove leave on Fri, 20 Nov, 2026' }).click();
  await expect(page.getByText('Leave on Fri, 20 Nov, 2026 removed. 6 slots reopened.')).toBeVisible();
  expect(writes(backend).slice(-2)).toEqual(['POST /specialists/me/leave', 'DELETE /specialists/me/leave/20261120']);
  expect(backend.calls.find((c) => c.path === '/specialists/me/leave')?.body).toEqual({ date: '20261125' });
});

test('available now: switched on with types and fee, heartbeats only while visible (on any page), and off again', async ({ page }) => {
  const backend = await mockBackend(page, { install: true });
  await signIn(page);
  await nav(page).getByRole('link', { name: 'Consult now' }).click();
  await expect(page.getByRole('region', { name: 'Available now' })).toContainText('Off You are not taking instant consultations.');
  await expect(page.getByLabel('Your fee for an instant consultation (₹)')).toHaveValue('600');
  await page.getByRole('group', { name: 'Consultation types you take now' }).getByLabel('Video').uncheck();
  await page.getByRole('button', { name: 'Go available now' }).click();
  await expect(page.getByText('Choose at least one consultation type.')).toBeVisible();
  await page.getByRole('group', { name: 'Consultation types you take now' }).getByLabel('Video').check();
  await page.getByRole('group', { name: 'Consultation types you take now' }).getByLabel('Chat').check();
  await page.getByLabel('Your fee for an instant consultation (₹)').fill('4.5.0');
  await page.getByRole('button', { name: 'Go available now' }).click();
  await expect(page.getByText('Enter the fee in rupees, e.g. 500 or 499.50.')).toBeVisible();
  await page.getByLabel('Your fee for an instant consultation (₹)').fill('450');
  await page.getByRole('button', { name: 'Go available now' }).click();
  await expect(page.getByText('You are available now for Video, Chat at ₹450.00.')).toBeVisible();
  expect(presencePuts(backend)[0]).toEqual({ available: true, modes: ['video', 'chat'], instantFeeMinor: 45_000, expectedPresenceVersion: 0 });
  expect(heartbeats(backend)).toBe(0);
  await page.clock.runFor(61_000);
  await expect.poll(() => heartbeats(backend)).toBe(1);
  // "Update" while on (against version 1); then a consultation starts: the next heartbeat's answer is shown (not ignored as stale).
  await page.getByRole('button', { name: 'Update' }).click();
  await expect(page.getByText('You are available now for Video, Chat at ₹450.00.')).toBeVisible();
  expect(presencePuts(backend)[1]).toMatchObject({ expectedPresenceVersion: 1 });
  backend.busyNow = true;
  await page.clock.runFor(60_000);
  await expect.poll(() => heartbeats(backend)).toBe(2);
  await expect(page.getByText(/You are not being offered consultations right now: you are in a consultation until/)).toBeVisible();
  backend.busyNow = false;
  // Hidden: no heartbeats at all (the server drops the doctor two minutes after the last one).
  await setVisibility(page, 'hidden');
  await page.clock.runFor(180_000);
  expect(heartbeats(backend)).toBe(2);
  // Visible again: one at once (more than a minute passed), then every minute — also on another page.
  await setVisibility(page, 'visible');
  await expect.poll(() => heartbeats(backend)).toBe(3);
  await expect(page.getByText(/You are not being offered consultations right now/)).toHaveCount(0);
  await nav(page).getByRole('link', { name: 'Schedule' }).click();
  await page.clock.runFor(60_000);
  await expect.poll(() => heartbeats(backend)).toBe(4);
  await nav(page).getByRole('link', { name: 'Home' }).click();
  await expect(page.getByRole('region', { name: 'Your status' })).toContainText('On Video, Chat · ₹450.00');
  // A reload reads the presence again: still checked in, so this page goes on keeping it alive. WQ11c: a read is not a
  // check-in, so the first heartbeat goes at once (the last one may be nearly two minutes old), then every minute.
  await page.reload();
  await expect(page.getByRole('region', { name: 'Your status' })).toContainText('On Video, Chat · ₹450.00');
  await expect.poll(() => heartbeats(backend)).toBe(5);
  await page.clock.runFor(30_000);
  expect(heartbeats(backend)).toBe(5);
  await page.clock.runFor(30_000);
  await expect.poll(() => heartbeats(backend)).toBe(6);
  // Found switched on but no longer checked in (e.g. the browser was closed): not revived on its own.
  backend.lapsed = true;
  await page.reload();
  await expect(page.getByRole('region', { name: 'Your status' })).toContainText('On, not checked in');
  await page.clock.runFor(120_000);
  expect(heartbeats(backend)).toBe(6);
  await nav(page).getByRole('link', { name: 'Consult now' }).click();
  await expect(page.getByText('Switched on, but no workspace page has checked in for two minutes')).toBeVisible();
  await expect(page.getByLabel('Your fee for an instant consultation (₹)')).toHaveValue('450');
  await page.getByRole('button', { name: 'Stop being available' }).click();
  await expect(page.getByText('You are not available now. No new offers come to you.')).toBeVisible();
  expect(presencePuts(backend).at(-1)).toEqual({ available: false, modes: ['video', 'chat'], instantFeeMinor: 45_000, expectedPresenceVersion: 2 });
  await page.clock.runFor(180_000);
  expect(heartbeats(backend)).toBe(6);
});

test('offers: countdown, accept after confirming, every refusal in words, a lost answer found among the appointments, and extending', async ({ page }) => {
  const backend = await mockBackend(page);
  const names: [string, string, string][] = [
    ['Bala', 'SPECIALIZATION_MISMATCH', 'This request is for another speciality than the one on your profile.'],
    ['Chitra', 'COUPON_NOT_FOR_DOCTOR', 'The patient used a coupon for other doctors, so you cannot take this request.'],
    ['Dev', 'DOCTOR_BUSY', 'You already have a consultation at this time.'],
    ['Esha', 'OFFER_EXPIRED', 'This offer has expired.'],
    ['Farah', 'FEE_ABOVE_QUOTE', 'Your instant fee is above what this patient paid. Lower your fee to take requests like this one.'],
    ['Gita', 'OFFER_NO_LONGER_AVAILABLE', 'Another doctor accepted it first, or the patient withdrew or was refunded.'],
    ['Indu', 'DOCTOR_NOT_AVAILABLE', 'You are not available now for this consultation type'],
    ['Jaya', 'SPECIALIST_NOT_ACTIVE', 'Your doctor account is not active or not verified'],
    // Q16a re-review (C): the patient's coupon, worked out again on this fee, no longer covers it.
    ['Mohan', 'OFFER_NO_LONGER_AFFORDABLE', 'What this patient paid no longer covers your fee once their coupon is worked out again'],
  ];
  backend.offers = [offer(1, 'Asha Rao', { offerExpiresAt: plusMin(4) }), offer(8, 'Hari', { mode: 'chat' }),
    ...names.map(([n], i) => offer(10 + i, n)), offer(30, 'Old', { offerExpiresAt: new Date(NOW.getTime() - 1000).toISOString() }),
    offer(40, 'Kiran', { quotedAmountMinor: 40_000 }), offer(41, 'Lata', { mode: 'chat' })];
  names.forEach(([, code], i) => { backend.acceptScript[rid(10 + i)] = code; });
  backend.acceptScript[rid(8)] = 'lost';
  backend.acceptScript[rid(41)] = 'replay';
  await signIn(page);
  await nav(page).getByRole('link', { name: 'Consult now' }).click();
  await goAvailable(page);
  const offers = page.getByRole('list', { name: 'Open offers' });
  const asha = offers.getByRole('listitem', { name: 'Offer for Asha Rao' });
  await expect(asha).toContainText('Video consultation · Cardiology');
  await expect(asha).toContainText('Patient: Asha Rao, 31 years, female · paid ₹800.00');
  await expect(asha).toContainText('Closes in 4:00');
  for (const [name, , words] of names) {
    await offers.getByRole('button', { name: `Accept the offer for ${name}` }).click();
    await page.getByRole('group', { name: `Accept the offer for ${name}` }).getByRole('button', { name: 'Accept and start' }).click();
    await expect(page.getByRole('alert').filter({ hasText: `Not accepted (${name})` })).toContainText(words);
  }
  // A lost answer: the accept was recorded, so it is found among today's appointments instead of being sent again.
  await offers.getByRole('button', { name: 'Accept the offer for Hari' }).click();
  await page.getByRole('group', { name: 'Accept the offer for Hari' }).getByRole('button', { name: 'Accept and start' }).click();
  await expect(page.getByText(/You accepted the chat consultation · cardiology for Hari/)).toBeVisible();
  expect(backend.calls.filter((c) => c.path === `/specialists/me/instant/${rid(8)}/accept`)).toHaveLength(1);
  // Q13: the patient's paid amount is shown; a fee above it cannot be accepted (nothing is sent).
  const kiran = offers.getByRole('listitem', { name: 'Offer for Kiran' });
  await expect(kiran).toContainText('paid ₹400.00');
  await expect(kiran).toContainText('Your fee (₹600.00) is above what this patient paid, so you cannot take it.');
  await expect(kiran.getByRole('button', { name: 'Accept the offer for Kiran' })).toBeDisabled();
  // Q13: accepting again after an earlier accept went through answers that consultation (200, replayed).
  await offers.getByRole('button', { name: 'Accept the offer for Lata' }).click();
  await page.getByRole('group', { name: 'Accept the offer for Lata' }).getByRole('button', { name: 'Accept and start' }).click();
  await expect(page.getByText(/You accepted the chat consultation · cardiology for Lata \(your earlier accept had gone through\)/)).toBeVisible();
  // Success, after a confirmation naming the patient and the fee.
  await offers.getByRole('button', { name: 'Accept the offer for Asha Rao' }).click();
  const confirm = page.getByRole('group', { name: 'Accept the offer for Asha Rao' });
  await expect(confirm).toContainText('Accept the video consultation · cardiology for Asha Rao, 31 years, female?');
  await expect(confirm).toContainText('Your fee: ₹600.00.');
  await confirm.getByRole('button', { name: 'Accept and start' }).click();
  await expect(page.getByText(/You accepted the video consultation · cardiology for Asha Rao/)).toBeVisible();
  await expect(offers.getByRole('listitem', { name: 'Offer for Asha Rao' })).toHaveCount(0);
  await expect(page.getByRole('listitem', { name: 'Offer for Old' }).getByText('Closed')).toBeVisible();
  // Running instant consultations: extend one; a refusal is shown, nothing resent.
  const running = page.getByRole('list', { name: 'Running instant consultations' });
  await expect(running.getByRole('listitem')).toHaveCount(4);
  const first = running.getByRole('listitem', { name: 'Video consultation accepted at 09:50' });
  await expect(first.getByRole('link', { name: 'Join the call' })).toHaveAttribute('href', 'https://meet.google.com/abc-defg-hij');
  await first.getByLabel('Extend by (minutes)').fill('61');
  await first.getByRole('button', { name: 'Extend' }).click();
  await expect(first.getByText('Enter 1 to 60 minutes.')).toBeVisible();
  await first.getByLabel('Extend by (minutes)').fill('15');
  await first.getByRole('button', { name: 'Extend' }).click();
  await expect(first).toContainText('Extended by 15 minutes: your time is held until');
  const extends_ = () => backend.calls.filter((c) => c.path === `/specialists/me/instant/bookings/${bid(5)}/extend`).map((c) => c.body as { minutes: number; requestKey: string });
  expect(extends_()[0]).toEqual({ minutes: 15, requestKey: expect.stringMatching(/^[0-9a-f]{32}$/) });
  // A lost answer of an extension the server made: found on the booking (Q13 read), not sent again.
  backend.extendLost = 'applied';
  await first.getByLabel('Extend by (minutes)').fill('10');
  await first.getByRole('button', { name: 'Extend' }).click();
  await expect(first).toContainText('Extended by 10 minutes: your time is held until');
  expect(extends_()).toHaveLength(2);
  expect(backend.calls.some((c) => c.method === 'GET' && c.path === `/specialists/me/instant/bookings/${bid(5)}`)).toBe(true);
  // A lost one that never arrived: only the same extension (same key, same minutes) can be sent again; it is added once.
  backend.extendLost = 'dropped';
  await first.getByLabel('Extend by (minutes)').fill('5');
  await first.getByRole('button', { name: 'Extend' }).click();
  await expect(first).toContainText('The extension is not recorded yet. Send the same extension again: it is added once, never twice.');
  await expect(first.getByLabel('Extend by (minutes)')).toBeDisabled();
  await first.getByRole('button', { name: 'Send the same extension again' }).click();
  await expect(first).toContainText('Extended by 5 minutes');
  expect(extends_()[3]).toEqual(extends_()[2]);
  expect(backend.extensions[bid(5)]!.map((e) => e.minutes)).toEqual([15, 10, 5]);
  backend.extendRefusal = 'DOCTOR_BUSY';
  await first.getByRole('button', { name: 'Extend' }).click();
  await expect(first).toContainText('Not extended: You already have a consultation at this time.');
  expect(await storage(page)).not.toMatch(/Asha|Hari|"t1"|Bearer/);
});

test('an accept answer arriving after leaving the page changes nothing on the page now shown', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.offers = [offer(1, 'Asha Rao')];
  let release!: () => void;
  backend.hold = { match: /\/accept$/, gate: new Promise<void>((r) => { release = r; }) };
  await signIn(page);
  await nav(page).getByRole('link', { name: 'Consult now' }).click();
  await goAvailable(page);
  await page.getByRole('button', { name: 'Accept the offer for Asha Rao' }).click();
  await page.getByRole('group', { name: 'Accept the offer for Asha Rao' }).getByRole('button', { name: 'Accept and start' }).click();
  await nav(page).getByRole('link', { name: 'Schedule' }).click();
  await expect(page.getByRole('heading', { name: 'Schedule', level: 1 })).toBeVisible();
  release();
  await expect.poll(() => backend.appointments.length).toBe(7);
  await page.waitForTimeout(300);
  await expect(page.getByText(/You accepted/)).toHaveCount(0);
  await expect(page).toHaveURL(/#\/doctor\/schedule$/);
  await nav(page).getByRole('link', { name: 'Consult now' }).click();
  await expect(page.getByText(/You accepted|did not arrive|Not accepted/)).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Running instant consultations' }).getByRole('listitem')).toHaveCount(2);
});

test('appointments: today, the next two weeks and one day, with the commands the server accepts after confirming', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await nav(page).getByRole('link', { name: 'Appointments' }).click();
  const table = page.getByRole('table', { name: 'Appointments' });
  await expect(table.getByRole('row')).toHaveCount(4); // header + 09:00, 09:50, 11:30 today
  const clinicRow = table.getByRole('row').filter({ hasText: '09:00' });
  await expect(clinicRow).toContainText('At a clinic');
  await expect(clinicRow.getByRole('button', { name: 'Patient did not come' })).toBeVisible(); // started
  const later = table.getByRole('row').filter({ hasText: '11:30' });
  await expect(later.getByRole('button', { name: 'Patient did not come' })).toHaveCount(0); // not started yet
  await later.getByRole('button', { name: 'Cancel' }).click();
  await expect(later).toContainText('The patient gets their full payment back in their Jansetu wallet.');
  await later.getByRole('button', { name: /^Cancel Tue, 17 Nov, 2026, 11:30$/ }).click();
  await expect(later.getByText('Give a reason (at least 3 characters).')).toBeVisible();
  await later.getByLabel('Reason (the patient sees it)').fill('Called away to an emergency');
  await later.getByRole('button', { name: /^Cancel Tue, 17 Nov, 2026, 11:30$/ }).click();
  await expect(page.getByText('Tue, 17 Nov, 2026, 11:30 is cancelled and the patient refunded in full.')).toBeVisible();
  expect(backend.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ status: 'cancelled', reason: 'Called away to an emergency' });
  await clinicRow.getByRole('button', { name: 'Mark completed' }).click();
  await clinicRow.getByRole('button', { name: 'Complete Tue, 17 Nov, 2026, 09:00' }).click();
  await expect(page.getByText('Tue, 17 Nov, 2026, 09:00 is completed.')).toBeVisible();
  await expect(table.getByRole('row').filter({ hasText: '09:00' })).toContainText('Completed');
  await page.getByLabel('Show').selectOption('upcoming');
  await expect(table.getByRole('row').filter({ hasText: '19 Nov' })).toContainText('Waiting');
  await expect(table.getByRole('row').filter({ hasText: '19 Nov' }).getByRole('button', { name: 'Confirm' })).toHaveCount(0); // not paid
  await expect(table.getByRole('row').filter({ hasText: '18 Nov' })).toContainText('Patient asked');
  await page.getByLabel('Show').selectOption('day');
  await page.getByLabel('Day', { exact: true }).fill('2026-11-19');
  await expect(table.getByRole('row')).toHaveCount(2);
  expect(backend.calls.some((c) => c.path === '/specialists/me/appointments?view=day&date=20261119')).toBe(true);
});

test('WQ11d (Q16d): in a session with several seats, "Patient did not come" waits for 15 minutes after the session ends', async ({ page }) => {
  const backend = await mockBackend(page);
  // 09:00 in a 09:00–10:30 session with 5 seats; it is 10:00, so the session is still running.
  Object.assign(backend.appointments.find((a) => a._id === bid(2))!, { slotId: '5f'.repeat(12) });
  await page.route('**/api/v1/specialists/me/slots**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: [
    { _id: '5f'.repeat(12), date: '20261117', startTime: '09:00', endTime: '10:30', maxBookings: 5, currentBookings: 3, isAvailable: true, isActive: true, branchId: BR1 },
  ] }) }));
  await signIn(page);
  await nav(page).getByRole('link', { name: 'Appointments' }).click();
  const table = page.getByRole('table', { name: 'Appointments' });
  const clinicRow = table.getByRole('row').filter({ hasText: '09:00' });
  await expect(clinicRow.getByRole('button', { name: 'Mark completed' })).toBeVisible();
  await expect(clinicRow.getByRole('button', { name: 'Patient did not come' })).toHaveCount(0);
  // 10:45: 15 minutes after the session ended.
  await page.clock.setFixedTime(new Date('2026-11-17T05:15:00.000Z'));
  await page.getByLabel('Show').selectOption('day');
  await page.getByLabel('Day', { exact: true }).fill('2026-11-17');
  await expect(table.getByRole('row').filter({ hasText: '09:00' }).getByRole('button', { name: 'Patient did not come' })).toBeVisible();
});

test('Q14 clinics: invitations are no longer valid (dismiss only), leave a clinic, and create my clinic once (a lost answer found by its key)', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.loseNextClinic = true;
  await signIn(page);
  await nav(page).getByRole('link', { name: 'Clinics' }).click();
  const invites = page.getByRole('list', { name: 'Invitations' });
  const lake = invites.getByRole('listitem', { name: 'Invitation from Lake Clinic' });
  await expect(lake).toContainText('Branches: Lakeside, Bengaluru');
  await expect(lake).toContainText('No longer valid');
  await expect(lake).toContainText('To consult at Lake Clinic, ask the Jansetu team to link you.');
  await expect(invites.getByRole('button', { name: 'Accept' })).toHaveCount(0);
  await expect(invites.getByRole('listitem', { name: 'Invitation from Hill Clinic' })).toContainText('all its in-clinic branches');
  const hill = invites.getByRole('listitem', { name: 'Invitation from Hill Clinic' });
  await hill.getByRole('button', { name: 'Dismiss' }).click();
  await hill.getByRole('button', { name: 'Dismiss the invitation from Hill Clinic' }).click();
  await expect(page.getByText('The invitation from Hill Clinic was dismissed.')).toBeVisible();
  await expect(invites.getByRole('listitem')).toHaveCount(1);
  const member = page.getByRole('list', { name: 'Clinics you consult at' });
  await expect(member.getByRole('listitem', { name: 'New Clinic' })).toContainText('Waiting for verification');
  const sunrise = member.getByRole('listitem', { name: 'Sunrise Clinic' });
  await sunrise.getByRole('button', { name: 'Leave' }).click();
  await expect(sunrise).toContainText('New bookings there stop at once');
  await sunrise.getByRole('button', { name: 'Leave Sunrise Clinic' }).click();
  await expect(page.getByText('You no longer consult at Sunrise Clinic.')).toBeVisible();
  await expect(member.getByRole('listitem', { name: 'Sunrise Clinic' })).toHaveCount(0);
  expect(writes(backend)).toEqual([`POST /specialists/me/clinic-invites/${INV2}/decline`, `POST /specialists/me/clinics/${SUNRISE}/leave`]);

  // Create my clinic.
  const form = page.getByRole('form', { name: 'Create my clinic' });
  await form.getByLabel('Clinic name').fill('Dr Meera Rao Heart Care');
  await form.getByLabel('Bill number prefix').fill('toolong');
  await form.getByRole('button', { name: 'Review' }).click();
  await expect(form.getByText('1 to 6 letters or digits, e.g. DRK.')).toBeVisible();
  await expect(form.getByText('Required.').first()).toBeVisible();
  await form.getByLabel('Bill number prefix').fill('mrh');
  await form.getByLabel('Contact email (optional)').fill('meera@');
  await form.getByLabel('Branch name').fill('Indiranagar');
  await form.getByLabel('Branch phone').fill('9000000021');
  await form.getByLabel('Address', { exact: true }).fill('5 CMH Road');
  await form.getByLabel('City').fill('Bengaluru');
  await form.getByLabel('State', { exact: true }).fill('Karnataka');
  await form.getByLabel('State code').fill('29');
  await form.getByLabel('PIN code').fill('560038');
  await form.getByRole('button', { name: 'Review' }).click();
  await expect(form.getByText('Enter a valid email address, or leave it empty.')).toBeVisible();
  await form.getByLabel('Contact email (optional)').fill('meera@heart.in');
  await form.getByRole('button', { name: 'Review' }).click();
  await expect(form).toContainText('You can create only one clinic. It starts pending: Jansetu verifies it');
  // Q14 review: the owner-doctor consults at every branch of their clinic.
  await expect(form).toContainText('You are its owner and consult at every branch of it.');
  await form.getByRole('button', { name: 'Create my clinic' }).click();
  // The answer is lost: the exact create is found by its key; nothing is sent twice.
  const unsure = page.getByRole('group', { name: 'Unconfirmed clinic' });
  await expect(unsure).toContainText('Clinic “Dr Meera Rao Heart Care” with its branch Indiranagar in Bengaluru.');
  await unsure.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(page.getByText('Jansetu has not verified your clinic yet.')).toBeVisible();
  const dl = page.locator('.ws-dl').last();
  await expect(dl).toContainText('Dr Meera Rao Heart Care');
  await expect(dl).toContainText('Waiting for verification');
  await expect(page.getByText('sign in as “Lab or clinic staff” with your mobile number 9000000020')).toBeVisible();
  await expect(member.getByRole('listitem', { name: 'Dr Meera Rao Heart Care' })).toContainText('As its owner you cannot leave it here.');
  const creates = backend.calls.filter((c) => c.method === 'POST' && c.path === '/specialists/me/clinic');
  expect(creates).toHaveLength(1);
  expect(creates[0]!.body).toEqual({
    name: 'Dr Meera Rao Heart Care', invoiceSeriesPrefix: 'MRH', contactEmail: 'meera@heart.in', requestKey: expect.stringMatching(/^[0-9a-f]{32}$/),
    branch: { name: 'Indiranagar', phone: '9000000021', address: { line1: '5 CMH Road', city: 'Bengaluru', state: 'Karnataka', stateCode: '29', pincode: '560038' } },
  });
  expect(backend.calls.some((c) => c.path === `/specialists/me/clinic/by-key/${(creates[0]!.body as Rec).requestKey}`)).toBe(true);
});

test('Q14 clinics: a clinic made elsewhere meanwhile refuses a second (DOCTOR_CLINIC_EXISTS); an unverified doctor cannot create one', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await nav(page).getByRole('link', { name: 'Clinics' }).click();
  const form = page.getByRole('form', { name: 'Create my clinic' });
  await form.getByLabel('Clinic name').fill('Second Clinic');
  await form.getByLabel('Bill number prefix').fill('SC');
  await form.getByLabel('Branch name').fill('Main');
  await form.getByLabel('Branch phone').fill('9000000022');
  await form.getByLabel('Address', { exact: true }).fill('1 Road');
  await form.getByLabel('City').fill('Mysuru');
  await form.getByLabel('State', { exact: true }).fill('Karnataka');
  await form.getByLabel('State code').fill('29');
  await form.getByLabel('PIN code').fill('570001');
  await form.getByRole('button', { name: 'Review' }).click();
  // Another tab created the doctor's clinic in the meantime.
  backend.practice = { partner: { _id: PRACTICE, name: 'First Clinic', solo: true, verification: { state: 'verified' } }, branches: [] };
  backend.clinicKey = 'other-tab-key-0001';
  await form.getByRole('button', { name: 'Create my clinic' }).click();
  await expect(page.getByText('You already have a clinic, so no new one was made.')).toBeVisible();
  await expect(page.locator('.ws-dl').last()).toContainText('First Clinic');

  backend.profile = { ...backend.profile, isVerified: false };
  backend.practice = null;
  await page.reload();
  await nav(page).getByRole('link', { name: 'Clinics' }).click();
  await expect(page.getByText('Only active, verified doctors can create a clinic.')).toBeVisible();
  await expect(page.getByRole('form', { name: 'Create my clinic' })).toHaveCount(0);
});

test('earnings: balance, statement with running balance and paging, CSV via blob, payouts, and payout details that need verification', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await nav(page).getByRole('link', { name: 'Earnings' }).click();
  const balance = page.getByRole('region', { name: 'Balance' });
  await expect(balance).toContainText('₹30,400.00'); // 59 × ₹600 − ₹5,000
  await expect(balance).toContainText('₹5,000.00 on Fri, 16 Oct, 2026');
  const lines = page.getByRole('table', { name: 'Statement lines' });
  await expect(lines.getByRole('row')).toHaveCount(51);
  await expect(lines.getByRole('row').nth(1)).toContainText('Consultation · line 60');
  await expect(lines.getByRole('row').nth(1)).toContainText('₹30,400.00');
  await page.getByRole('button', { name: 'Show older entries' }).click();
  await expect(lines.getByRole('row')).toHaveCount(61);
  await expect(page.getByRole('button', { name: 'Show older entries' })).toHaveCount(0);
  const older = backend.calls.filter((c) => c.path.startsWith('/specialists/me/finance/statement?')).map((c) => c.path);
  expect(older[1]).toMatch(/before=\d+_[0-9a-f]{24}&limit=50$/);
  await page.getByLabel('From').fill('2026-11-30');
  await page.getByLabel('To').fill('2026-11-01');
  await page.getByRole('button', { name: 'Show', exact: true }).click();
  await expect(page.getByText('The “from” date must not be after the “to” date.')).toBeVisible();
  await page.getByLabel('From').fill('2026-10-20');
  await page.getByLabel('To').fill('2026-10-25');
  await page.getByRole('button', { name: 'Show', exact: true }).click();
  await expect(lines.getByRole('row')).toHaveCount(13); // 20–25 Oct: two entries a day
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Download CSV \(Tue, 20 Oct, 2026 to Sun, 25 Oct, 2026\)/ }).click()]);
  expect(download.suggestedFilename()).toBe('doctor-statement-2026-10-20-to-2026-10-25.csv');
  expect(await readFile((await download.path())!, 'utf8')).toContain('Opening balance');
  const csv = backend.calls.find((c) => c.path.startsWith('/specialists/me/finance/statement.csv'))!;
  expect(csv.path).toBe('/specialists/me/finance/statement.csv?from=2026-10-20&to=2026-10-25');
  expect(csv.auth).toBe('Bearer t1');
  const payouts = page.getByRole('table', { name: 'Payouts' });
  await expect(payouts.getByRole('row').filter({ hasText: 'UPI987654' })).toContainText('Voided');
  await expect(payouts.getByRole('row').filter({ hasText: 'UPI987654' })).toContainText('Bounced back');
  await expect(page.getByRole('table', { name: 'Earlier payouts' })).toContainText('Sep 2026');

  // Payout destination: masked; any change needs Jansetu's verification; a change made elsewhere meanwhile is not overwritten.
  const dest = page.getByRole('region', { name: 'Where payouts go' });
  await expect(dest).toContainText('HDFC Bank · XXXX9012 · IFSC HDFC0001234 · Dr Meera Rao');
  await expect(dest).toContainText('Any change, even to the same details, has to be verified by Jansetu again before the next payout.');
  await dest.getByRole('button', { name: 'Change payout details' }).click();
  await dest.getByLabel('UPI').check();
  await dest.getByLabel('UPI ID').fill('meera rao');
  await dest.getByRole('button', { name: 'Review' }).click();
  await expect(dest.getByText('A UPI ID looks like name@bank.')).toBeVisible();
  await dest.getByLabel('UPI ID').fill('Meera.Rao@OKHDFC');
  await dest.getByRole('button', { name: 'Review' }).click();
  await expect(dest).toContainText('Send future payouts to UPI meera.rao@okhdfc? The details you have now stop being used, and no payout is made until Jansetu has verified the new ones.');
  const account = backend.finance.account as Rec;
  account.payoutDetailsVersion = 3; // changed elsewhere (another device) while this form was open
  await dest.getByRole('button', { name: 'Save payout details' }).click();
  await expect(dest.getByText(/Your payout details were changed since you opened this form/)).toBeVisible();
  expect(writes(backend)).toEqual([]);
  // Q13: a change landing after that read is refused by the server (expectedDetailsVersion) and shown the same way.
  backend.payoutRaceOnce = true;
  await dest.getByRole('button', { name: 'Review' }).click();
  await dest.getByRole('button', { name: 'Save payout details' }).click();
  await expect(dest.getByText(/Your payout details were changed since you opened this form/)).toBeVisible();
  await dest.getByRole('button', { name: 'Review' }).click();
  await dest.getByRole('button', { name: 'Save payout details' }).click();
  await expect(dest).toContainText('Saved: UPI meera.rao@okhdfc. Jansetu verifies it before the next payout.');
  await expect(dest).toContainText('Waiting for Jansetu to verify');
  await expect(dest).toContainText('No payout is made until Jansetu has checked these details.');
  expect(backend.calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([
    { method: 'upi', upiId: 'meera.rao@okhdfc', expectedDetailsVersion: 3 },
    { method: 'upi', upiId: 'meera.rao@okhdfc', expectedDetailsVersion: 4 },
  ]);
  // Activity, newest first, a page at a time by the server's cursor (Q13).
  const activity = page.getByRole('list', { name: 'Account activity' });
  await expect(activity.getByRole('listitem').first()).toContainText('Payout details changed · You');
  await expect(activity.getByRole('listitem')).toHaveCount(50);
  await page.getByRole('button', { name: 'Show older activity' }).click();
  await expect(activity.getByRole('listitem')).toHaveCount(62);
  await expect(page.getByRole('button', { name: 'Show older activity' })).toHaveCount(0);
  expect(backend.calls.filter((c) => c.path.startsWith('/specialists/me/finance/events')).at(-1)!.path).toMatch(/cursor=\d+_[0-9a-f]{24}&limit=50$/);
  // Bank details are never kept in browser storage.
  await dest.getByRole('button', { name: 'Change payout details' }).click();
  await dest.getByLabel('Account number').fill('123456789012');
  expect(await storage(page)).not.toMatch(/123456789012|meera\.rao/);
});

test('a fee change whose answer is lost: terms unknown, no heartbeat, no accept until the server confirms them again', async ({ page }) => {
  const backend = await mockBackend(page, { install: true });
  backend.offers = [offer(1, 'Asha Rao', { offerExpiresAt: plusMin(30) })]; // still open after the minutes run below
  await signIn(page);
  await nav(page).getByRole('link', { name: 'Consult now' }).click();
  const fee = page.getByLabel('Your fee for an instant consultation (₹)');
  await fee.fill('500');
  await goAvailable(page);
  await page.clock.runFor(61_000);
  await expect.poll(() => heartbeats(backend)).toBe(1);
  // ₹500 → ₹100: the server applies it, the answer is lost.
  backend.presenceLost = true;
  await fee.fill('100');
  await page.getByRole('button', { name: 'Update' }).click();
  const avail = page.getByRole('region', { name: 'Available now' });
  await expect(avail.getByText('Not confirmed', { exact: true })).toBeVisible();
  await expect(avail).toContainText('Your last change (available for Video at ₹100.00) was sent, but no answer came');
  await expect(avail).toContainText('Your availability and fee are not known here.');
  await expect(avail).not.toContainText('₹500.00');
  await expect(page.getByRole('button', { name: 'Accept the offer for Asha Rao' })).toBeDisabled();
  await expect(page.getByText('To accept, switch “Available now” on above and wait until the server confirms your types and fee.')).toBeVisible();
  // The uncertain presence is not kept alive.
  await page.clock.runFor(180_000);
  expect(heartbeats(backend)).toBe(1);
  await nav(page).getByRole('link', { name: 'Home' }).click();
  await expect(page.getByRole('region', { name: 'Your status' })).toContainText('Not confirmed');
  await nav(page).getByRole('link', { name: 'Consult now' }).click();
  // The way on is a fresh read: it shows what the server has (₹100 applied, but no page checked in since), with its version.
  backend.lapsed = true;
  await page.getByRole('button', { name: 'Check what the server has' }).click();
  await expect(avail).toContainText('The server has: available for Video at ₹100.00 (version 2).');
  await expect(avail.getByText('Not confirmed', { exact: true })).toBeVisible(); // a read alone confirms nothing
  await expect(page.getByRole('button', { name: 'Accept the offer for Asha Rao' })).toBeDisabled();
  expect(heartbeats(backend)).toBe(1);
  // Confirmed by an ordered write against that version: the fee is definite, accepting opens again, heartbeats resume.
  await page.getByRole('button', { name: 'Confirm these terms' }).click();
  await expect(page.getByText('You are available now for Video at ₹100.00.')).toBeVisible();
  expect(presencePuts(backend)).toEqual([
    { available: true, modes: ['video'], instantFeeMinor: 50_000, expectedPresenceVersion: 0 },
    { available: true, modes: ['video'], instantFeeMinor: 10_000, expectedPresenceVersion: 1 },
    { available: true, modes: ['video'], instantFeeMinor: 10_000, expectedPresenceVersion: 2 },
  ]);
  await page.getByRole('button', { name: 'Accept the offer for Asha Rao' }).click();
  await expect(page.getByRole('group', { name: 'Accept the offer for Asha Rao' })).toContainText('Your fee: ₹100.00.');
  await page.clock.runFor(60_000);
  await expect.poll(() => heartbeats(backend)).toBe(2);
});

test('a call link made after the accept: “being prepared”, picked up by reading again on Consult now and Appointments, Refresh, and a failed one explained', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.offers = [offer(1, 'Asha Rao'), offer(8, 'Hari', { mode: 'call' })];
  backend.acceptScript[rid(8)] = 'lost';
  await signIn(page);
  await nav(page).getByRole('link', { name: 'Consult now' }).click();
  await goAvailable(page);
  const offersRegion = page.getByRole('region', { name: 'Offers for you' });
  await page.getByRole('button', { name: 'Accept the offer for Asha Rao' }).click();
  await page.getByRole('group', { name: 'Accept the offer for Asha Rao' }).getByRole('button', { name: 'Accept and start' }).click();
  await expect(offersRegion.getByText(/You accepted the video consultation/)).toBeVisible();
  const running = page.getByRole('list', { name: 'Running instant consultations' });
  const asha = running.getByRole('listitem', { name: 'Video consultation accepted at 10:00' });
  await expect(asha.getByText('The call link is being prepared…')).toBeVisible();
  await expect(offersRegion.getByText('The call link is being prepared…')).toBeVisible();
  // The link is made a moment later: the page reads today's list again on its own and shows it in both places.
  backend.meetReady = true;
  await expect(asha.getByRole('link', { name: 'Join the call' })).toBeVisible({ timeout: 12_000 });
  await expect(offersRegion.getByRole('link', { name: 'Join the call' })).toHaveAttribute('href', /meet\.google\.com\/new-/);

  // A lost accept answer, recovered from today's appointments before its link exists; Refresh picks it up.
  backend.meetReady = false;
  await page.getByRole('button', { name: 'Accept the offer for Hari' }).click();
  await page.getByRole('group', { name: 'Accept the offer for Hari' }).getByRole('button', { name: 'Accept and start' }).click();
  await expect(offersRegion.getByText(/You accepted the phone call consultation · cardiology for Hari/)).toBeVisible();
  await expect(offersRegion.getByText('The call link is being prepared…')).toBeVisible();
  await nav(page).getByRole('link', { name: 'Appointments' }).click();
  const table = page.getByRole('table', { name: 'Appointments' });
  const waiting = table.getByRole('row').filter({ hasText: 'The call link is being prepared…' });
  await expect(waiting).toHaveCount(1);
  await expect(waiting).toContainText('Phone call');
  backend.meetReady = true;
  await waiting.getByRole('button', { name: 'Refresh' }).click();
  await expect(table.getByRole('row').filter({ hasText: 'Phone call' }).filter({ hasText: '10:00' }).getByRole('link', { name: 'Join the call' })).toBeVisible();
  await expect(table.getByText('The call link is being prepared…')).toHaveCount(0);
  // A link the server could not make says so (no endless waiting).
  await page.getByLabel('Show').selectOption('upcoming');
  await expect(table.getByRole('row').filter({ hasText: '21 Nov' })).toContainText('The call link could not be made (Google Calendar / Meet is not configured).');
});

test('a lost presence change that reaches the server late never overwrites newer acknowledged terms (Codex WQ4 #3)', async ({ page }) => {
  const backend = await mockBackend(page, { install: true });
  backend.offers = [offer(1, 'Asha Rao', { offerExpiresAt: plusMin(30) })];
  await signIn(page);
  await nav(page).getByRole('link', { name: 'Consult now' }).click();
  const avail = page.getByRole('region', { name: 'Available now' });
  const fee = page.getByLabel('Your fee for an instant consultation (₹)');
  await fee.fill('500');
  await goAvailable(page); // version 1
  // A: ₹500 → ₹100. Its answer is lost and the request itself is still on its way to the server.
  backend.presenceLate = true;
  await fee.fill('100');
  await page.getByRole('button', { name: 'Update' }).click();
  await expect(avail.getByText('Not confirmed', { exact: true })).toBeVisible();
  // The doctor reads again (A has not arrived: still ₹500, version 1), then sends B: ₹200, acknowledged as version 2.
  await page.getByRole('button', { name: 'Check what the server has' }).click();
  await expect(avail).toContainText('The server has: available for Video at ₹500.00 (version 1).');
  await page.getByLabel('Your fee for an instant consultation (₹)').fill('200');
  await page.getByRole('button', { name: 'Confirm these terms' }).click();
  await expect(page.getByText('You are available now for Video at ₹200.00.')).toBeVisible();
  // A finally reaches the server: it names version 1, so the server refuses it. The server and the page both keep B.
  expect(backend.runLate!()).toEqual({ status: 409, code: 'PRESENCE_CHANGED' });
  expect(backend.presence).toMatchObject({ instantFeeMinor: 20_000, presenceVersion: 2 });
  expect(presencePuts(backend).map((x) => (x as { expectedPresenceVersion: number }).expectedPresenceVersion)).toEqual([0, 1, 1]);
  await page.clock.runFor(61_000); // the heartbeat reads what the server has: still B
  await expect.poll(() => heartbeats(backend)).toBe(1);
  await expect(avail).toContainText('Video at ₹200.00');
  await page.getByRole('button', { name: 'Accept the offer for Asha Rao' }).click();
  await expect(page.getByRole('group', { name: 'Accept the offer for Asha Rao' })).toContainText('Your fee: ₹200.00.');
  // A change made elsewhere meanwhile (another device: version 3) refuses this page's next change and shows the server's terms.
  backend.presence = { ...backend.presence!, instantFeeMinor: 30_000, presenceVersion: 3 };
  await page.getByLabel('Your fee for an instant consultation (₹)').fill('250');
  await page.getByRole('button', { name: 'Update' }).click();
  await expect(avail).toContainText('Not changed: your availability was changed meanwhile');
  await expect(avail).toContainText('Video at ₹300.00');
  await expect(page.getByLabel('Your fee for an instant consultation (₹)')).toHaveValue('300');
  expect(backend.presence).toMatchObject({ instantFeeMinor: 30_000, presenceVersion: 3 });
});

test('a read after a lost change only shows the terms: the lost change committing later is retired by a confirming write (Codex WQ4 #4)', async ({ page }) => {
  const backend = await mockBackend(page, { install: true });
  backend.offers = [offer(1, 'Asha Rao', { offerExpiresAt: plusMin(30) })];
  await signIn(page);
  await nav(page).getByRole('link', { name: 'Consult now' }).click();
  const avail = page.getByRole('region', { name: 'Available now' });
  await page.getByLabel('Your fee for an instant consultation (₹)').fill('500');
  await goAvailable(page); // ₹500, version 1
  // A: ₹100, its answer lost before the server's compare-and-set ran.
  backend.presenceLate = true;
  await page.getByLabel('Your fee for an instant consultation (₹)').fill('100');
  await page.getByRole('button', { name: 'Update' }).click();
  await expect(avail.getByText('Not confirmed', { exact: true })).toBeVisible();
  // A reload keeps the doubt (a body-less marker), so the page does not start from a read as if nothing was pending.
  await page.reload();
  await nav(page).getByRole('link', { name: 'Consult now' }).click();
  await expect(avail).toContainText('a change sent before this page was reloaded was never confirmed');
  await expect(avail).toContainText('The server last showed: available for Video at ₹500.00 (version 1), not yet confirmed.');
  // The read shows ₹500 but does not retire A: accepting and heartbeats stay blocked.
  await expect(avail.getByText('Not confirmed', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Accept the offer for Asha Rao' })).toBeDisabled();
  await page.clock.runFor(61_000);
  expect(heartbeats(backend)).toBe(0);
  // A now commits on version 1 (₹100, version 2).
  expect(backend.runLate!()).toEqual({ status: 200 });
  // Confirming ₹500 against version 1 is refused (A got there first): A's terms are read and shown, still unconfirmed.
  await expect(page.getByLabel('Your fee for an instant consultation (₹)')).toHaveValue('500');
  await page.getByRole('button', { name: 'Confirm these terms' }).click();
  await expect(avail).toContainText('Not confirmed: the server’s terms changed meanwhile');
  await expect(avail).toContainText('The server last showed: available for Video at ₹100.00 (version 2), not yet confirmed.');
  await expect(page.getByRole('button', { name: 'Accept the offer for Asha Rao' })).toBeDisabled();
  // Confirming ₹100 against version 2 is acknowledged (version 3): only now is the fee definite.
  await page.getByRole('button', { name: 'Confirm these terms' }).click();
  await expect(page.getByText('You are available now for Video at ₹100.00.')).toBeVisible();
  expect(presencePuts(backend).map((x) => [(x as { instantFeeMinor: number }).instantFeeMinor, (x as { expectedPresenceVersion: number }).expectedPresenceVersion]))
    .toEqual([[50_000, 0], [10_000, 1], [50_000, 1], [10_000, 2]]);
  expect(backend.presence).toMatchObject({ instantFeeMinor: 10_000, presenceVersion: 3 });
  await page.getByRole('button', { name: 'Accept the offer for Asha Rao' }).click();
  await expect(page.getByRole('group', { name: 'Accept the offer for Asha Rao' })).toContainText('Your fee: ₹100.00.');
  await page.clock.runFor(60_000);
  await expect.poll(() => heartbeats(backend)).toBe(1);
});

test('an unresolved extension survives leaving the page and a reload: only the same extension or a check, added once', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await nav(page).getByRole('link', { name: 'Consult now' }).click();
  const row = () => page.getByRole('list', { name: 'Running instant consultations' }).getByRole('listitem', { name: 'Video consultation accepted at 09:50' });
  const posts = () => backend.calls.filter((c) => c.path === `/specialists/me/instant/bookings/${bid(5)}/extend`).map((c) => (c.body as { requestKey: string; minutes: number }));
  // Lost before it reached the server.
  backend.extendLost = 'dropped';
  await row().getByLabel('Extend by (minutes)').fill('5');
  await row().getByRole('button', { name: 'Extend' }).click();
  await expect(row()).toContainText('The extension is not recorded yet. Send the same extension again');
  // Leave and come back: the same extension is still there (same minutes, locked), looked for again on the booking.
  await nav(page).getByRole('link', { name: 'Schedule' }).click();
  await nav(page).getByRole('link', { name: 'Consult now' }).click();
  await expect(row().getByLabel('Extend by (minutes)')).toHaveValue('5');
  await expect(row().getByLabel('Extend by (minutes)')).toBeDisabled();
  await expect(row().getByRole('button', { name: 'Extend', exact: true })).toHaveCount(0);
  await expect(row()).toContainText('The extension is not recorded yet.');
  await row().getByRole('button', { name: 'Send the same extension again' }).click();
  await expect(row()).toContainText('Extended by 5 minutes');
  expect(posts()).toHaveLength(2);
  expect(posts()[1]).toEqual(posts()[0]); // the same key and minutes: never a new extension
  expect(backend.extensions[bid(5)]!.map((e) => e.minutes)).toEqual([5]);
  // After a reload its details are gone (marker only): it can only be checked, never sent again or replaced.
  backend.extendLost = 'dropped';
  await row().getByLabel('Extend by (minutes)').fill('7');
  await row().getByRole('button', { name: 'Extend' }).click();
  await expect(row()).toContainText('The extension is not recorded yet.');
  await page.reload();
  await nav(page).getByRole('link', { name: 'Consult now' }).click();
  await expect(row()).toContainText('Its details were not kept after the reload, so it can only be checked again.');
  await expect(row().getByRole('button', { name: /Extend|Send the same/ })).toHaveCount(0);
  await row().getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(row()).toContainText('it can only be checked again');
  expect(posts()).toHaveLength(3);
  // Once the consultation is no longer held, the check settles it for good and a new extension can be made.
  backend.heldEnded = true;
  await row().getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(page.getByText('Not extended: the consultation is no longer held')).toBeVisible();
  expect(await storage(page)).not.toMatch(/minutes|"7"/);
});

test('heartbeats never overlap: one in flight at a time, and the page ends on the newest presence (Codex WQ4 #5)', async ({ page }) => {
  const backend = await mockBackend(page, { install: true });
  await signIn(page);
  await nav(page).getByRole('link', { name: 'Consult now' }).click();
  const avail = page.getByRole('region', { name: 'Available now' });
  await page.getByLabel('Your fee for an instant consultation (₹)').fill('450');
  await goAvailable(page); // version 1
  let release!: () => void;
  backend.beatHold = new Promise<void>((r) => { release = r; });
  await page.clock.runFor(61_000);
  await expect.poll(() => heartbeats(backend)).toBe(1); // answered with version 1 (₹450), held on the way back
  backend.presence = { ...backend.presence!, instantFeeMinor: 30_000, presenceVersion: 2 }; // changed on another device
  // The page is shown again more than a minute after the last check-in, while that heartbeat still waits: none starts.
  await setVisibility(page, 'hidden');
  await setVisibility(page, 'visible');
  await page.waitForTimeout(200);
  expect(heartbeats(backend)).toBe(1);
  release();
  await page.clock.runFor(60_000);
  await expect.poll(() => heartbeats(backend)).toBe(2);
  await expect(avail).toContainText('Video at ₹300.00');
});

test('an older extension attempt answering late never settles a newer same-key retry (Codex WQ4 #6)', async ({ page }) => {
  const backend = await mockBackend(page);
  let release!: () => void;
  backend.hold = { match: /\/extend$/, gate: new Promise<void>((r) => { release = r; }) };
  await signIn(page);
  await nav(page).getByRole('link', { name: 'Consult now' }).click();
  const row = () => page.getByRole('list', { name: 'Running instant consultations' }).getByRole('listitem', { name: 'Video consultation accepted at 09:50' });
  const posts = () => backend.calls.filter((c) => c.path === `/specialists/me/instant/bookings/${bid(5)}/extend`).map((c) => c.body);
  const checks = () => backend.calls.filter((c) => c.method === 'GET' && c.path === `/specialists/me/instant/bookings/${bid(5)}`).length;
  // Attempt 1 is on its way (held before the server acts on it); the doctor leaves and comes back.
  await row().getByLabel('Extend by (minutes)').fill('5');
  await row().getByRole('button', { name: 'Extend' }).click();
  await expect.poll(() => posts().length).toBe(1);
  await nav(page).getByRole('link', { name: 'Schedule' }).click();
  await nav(page).getByRole('link', { name: 'Consult now' }).click();
  await expect(row().getByLabel('Extend by (minutes)')).toHaveValue('5');
  await expect(row()).toContainText('The extension is not recorded yet.');
  // Attempt 2: the same key, its answer lost.
  backend.extendLost = 'dropped';
  const before = checks();
  await row().getByRole('button', { name: 'Send the same extension again' }).click();
  await expect.poll(() => posts().length).toBe(2);
  await expect.poll(() => checks()).toBeGreaterThan(before);
  // Attempt 1 now succeeds on the server and answers the page that was left: it must not settle attempt 2's state.
  release();
  await expect.poll(() => backend.extensions[bid(5)]?.length ?? 0).toBe(1);
  await page.waitForTimeout(300);
  await expect(row().getByLabel('Extend by (minutes)')).toBeDisabled();
  // A remount still has the pending extension and its check settles it, once.
  await nav(page).getByRole('link', { name: 'Schedule' }).click();
  await nav(page).getByRole('link', { name: 'Consult now' }).click();
  await expect(row()).toContainText('Extended by 5 minutes');
  await expect(row().getByRole('button', { name: 'Extend', exact: true })).toBeVisible();
  expect(posts()).toHaveLength(2);
  expect(posts()[1]).toEqual(posts()[0]);
  expect(backend.extensions[bid(5)]!.map((e) => e.minutes)).toEqual([5]);
});

test('while unconfirmed and the server shows Off, Enter confirms Off like the button (never goes available)', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await nav(page).getByRole('link', { name: 'Consult now' }).click();
  const avail = page.getByRole('region', { name: 'Available now' });
  await goAvailable(page); // version 1
  backend.presenceLost = true; // switching off is applied (version 2), its answer lost
  await page.getByRole('button', { name: 'Stop being available' }).click();
  await expect(avail.getByText('Not confirmed', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Check what the server has' }).click();
  await expect(avail).toContainText('The server has: not available (version 2).');
  await page.getByLabel('Your fee for an instant consultation (₹)').press('Enter');
  await expect(page.getByText('You are not available now. No new offers come to you.')).toBeVisible();
  expect(presencePuts(backend).at(-1)).toEqual({ available: false, modes: ['video'], instantFeeMinor: 60_000, expectedPresenceVersion: 2 });
  expect(backend.presence).toMatchObject({ available: false, presenceVersion: 3 });
});

test('Q14 doctor no-show: no earning and no refund; moved once to one of the doctor’s later slots after a confirmation; instant ones never', async ({ page }) => {
  const backend = await mockBackend(page);
  Object.assign(backend.appointments.find((a) => a._id === bid(2))!, { status: 'no_show', consultationMode: 'video', clinicVisit: undefined, serviceMode: 'online', updatedAt: '2026-11-17T04:00:00.000Z' });
  Object.assign(backend.appointments.find((a) => a._id === bid(5))!, { status: 'no_show' });
  await signIn(page);
  await nav(page).getByRole('link', { name: 'Appointments' }).click();
  const table = page.getByRole('table', { name: 'Appointments' });
  const missed = table.getByRole('row').filter({ hasText: '09:00' });
  await expect(missed).toContainText('No earning: you are paid only for a consultation that takes place. The patient is not refunded.');
  // The instant consultation is never moved.
  await expect(table.getByRole('row').filter({ hasText: '09:50' }).getByRole('button', { name: 'Reschedule no-show' })).toHaveCount(0);
  await missed.getByRole('button', { name: 'Reschedule no-show' }).click();
  const form = missed.getByRole('form', { name: 'Reschedule no-show' });
  await form.getByLabel('New day').fill('2026-11-18');
  // Open, free, online slots only (a full one and a clinic slot are left out); WQ11c: each names its place.
  await expect(form.getByLabel('New time').locator('option')).toHaveText(['Choose a time', '09:00–09:15 · online', '16:00–16:15 · online']);
  await form.getByLabel('New time').selectOption('16:00–16:15 · online');
  await form.getByRole('button', { name: 'Continue' }).click();
  await expect(form).toContainText('Move The patient’s missed time (Tue, 17 Nov, 2026, 09:00) to Wed, 18 Nov, 2026, 16:00 (online)? It is booked again at the same price: nothing is paid or refunded.');
  await expect(form).toContainText('You earn for it only once it is completed.');
  await form.getByRole('button', { name: 'Move to Wed, 18 Nov, 2026, 16:00 (online)' }).click();
  await expect(page.getByText('The patient’s no-show is moved to Wed, 18 Nov, 2026, 16:00 (online). It is booked again at the same price.')).toBeVisible();
  const moves = backend.calls.filter((c) => c.path.endsWith('/reschedule-no-show'));
  expect(moves.map((c) => c.path)).toEqual([`/specialists/me/bookings/${bid(2)}/reschedule-no-show`]);
  expect(moves[0]!.body).toEqual({ slotId: '52'.repeat(12), requestKey: expect.stringMatching(/^[0-9a-f]{32}$/), expectedUpdatedAt: '2026-11-17T04:00:00.000Z' });
  // Moved after a no-show: the booking is never refunded, so it offers no cancel.
  await page.getByLabel('Show').selectOption('upcoming');
  const moved = table.getByRole('row').filter({ hasText: '18 Nov, 2026, 16:00' });
  await expect(moved).toContainText('Moved after a no-show (missed Tue, 17 Nov, 2026, 09:00). A second no-show is final.');
  await expect(moved.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
  // Earnings say that a no-show earns nothing.
  await nav(page).getByRole('link', { name: 'Earnings' }).click();
  await expect(page.getByText('A no-show earns nothing (and the patient is not refunded), so it never appears here.')).toBeVisible();
});

test('WQ8 review: a desk no-show is the clinic’s to move; a move that empties the day still says it was moved', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.appointments.push(
    appt(40, { bookingDate: '20261120', bookingTime: '09:00', status: 'no_show', updatedAt: '2026-11-17T04:00:00.000Z' }),
    appt(41, { bookingDate: '20261121', bookingTime: '09:00', status: 'no_show', consultationMode: 'in-person', settlementSystem: 'clinic', paymentStatus: 'pending',
      clinicDesk: { partnerId: SUNRISE, branchId: BR1 } }),
  );
  await signIn(page);
  await nav(page).getByRole('link', { name: 'Appointments' }).click();
  await page.getByLabel('Show').selectOption('day');
  await page.getByLabel('Day', { exact: true }).fill('2026-11-21');
  const table = page.getByRole('table', { name: 'Appointments' });
  await expect(table.getByRole('row').filter({ hasText: '09:00' })).toContainText('The clinic can move this appointment: it was booked at its front desk.');
  await expect(table.getByRole('button', { name: 'Reschedule no-show' })).toHaveCount(0);

  await page.getByLabel('Day', { exact: true }).fill('2026-11-20');
  await table.getByRole('button', { name: 'Reschedule no-show' }).click();
  const form = page.getByRole('form', { name: 'Reschedule no-show' });
  await form.getByLabel('New day').fill('2026-11-18');
  await form.getByLabel('New time').selectOption('16:00–16:15 · online');
  await form.getByRole('button', { name: 'Continue' }).click();
  await form.getByRole('button', { name: /^Move to/ }).click();
  // The only booking of the day moved away: the list is empty, and the notice is still shown.
  await expect(page.getByText('No appointments on')).toBeVisible();
  await expect(page.getByText('The patient’s no-show is moved to Wed, 18 Nov, 2026, 16:00 (online). It is booked again at the same price.')).toBeVisible();
  expect(backend.calls.filter((c) => c.path.endsWith('/reschedule-no-show')).map((c) => c.path)).toEqual([`/specialists/me/bookings/${bid(40)}/reschedule-no-show`]);
});

// ───────────── WQ11c (pre-production review): doctor screens ─────────────

test('WQ11c (review D1): a lost extension refused outright on its resend can be replaced by another one (a new key), or forgotten after a second step', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await nav(page).getByRole('link', { name: 'Consult now' }).click();
  const row = () => page.getByRole('list', { name: 'Running instant consultations' }).getByRole('listitem', { name: 'Video consultation accepted at 09:50' });
  backend.extendLost = 'dropped'; // never reached the server
  await row().getByLabel('Extend by (minutes)').fill('30');
  await row().getByRole('button', { name: 'Extend' }).click();
  await expect(row()).toContainText('The extension is not recorded yet.');
  await expect(row().getByRole('button', { name: 'Choose another extension' })).toHaveCount(0); // nothing refused yet
  backend.extendRefusal = 'DOCTOR_BUSY'; // 30 more minutes would run into the next booking
  await row().getByRole('button', { name: 'Send the same extension again' }).click();
  await expect(row()).toContainText('Not extended this time: You already have a consultation at this time.');
  await expect(row().getByLabel('Extend by (minutes)')).toBeDisabled();
  backend.extendRefusal = undefined;
  const reads = backend.calls.filter((c) => c.method === 'GET' && c.path.startsWith(`/specialists/me/instant/bookings/${bid(5)}`)).length;
  await row().getByRole('button', { name: 'Choose another extension' }).click();
  // WQ11d: the booking is read again first, and the words never say the first one was not added.
  await expect(row()).toContainText('The one sent before may still have been added: check the consultation\'s end time');
  await expect(row()).not.toContainText('was not added');
  expect(backend.calls.filter((c) => c.method === 'GET' && c.path.startsWith(`/specialists/me/instant/bookings/${bid(5)}`)).length).toBeGreaterThan(reads);
  await expect(row().getByLabel('Extend by (minutes)')).toBeEnabled();
  await expect(row().getByLabel('Extend by (minutes)')).toHaveValue('30');
  await row().getByLabel('Extend by (minutes)').fill('10');
  await row().getByRole('button', { name: 'Extend', exact: true }).click();
  await expect(row()).toContainText('Extended by 10 minutes');
  const sent = backend.calls.filter((c) => c.path.endsWith('/extend')).map((c) => c.body as { minutes: number; requestKey: string });
  expect(sent.map((x) => x.minutes)).toEqual([30, 30, 10]);
  expect(sent[2]!.requestKey).not.toBe(sent[0]!.requestKey); // a new extension, a new key
  expect(backend.extensions[bid(5)]!.map((e) => e.minutes)).toEqual([10]);

  // Lost again, then the page is reloaded: only a check is possible; after it finds nothing, "Forget it" (second step).
  backend.extendLost = 'dropped';
  await row().getByLabel('Extend by (minutes)').fill('15');
  await row().getByRole('button', { name: 'Extend', exact: true }).click();
  await expect(row()).toContainText('The extension is not recorded yet.');
  await page.reload();
  await nav(page).getByRole('link', { name: 'Consult now' }).click();
  await expect(row()).toContainText('Its details were not kept after the reload, so it can only be checked again.');
  await expect(row().getByLabel('Extend by (minutes)')).toBeDisabled();
  await row().getByRole('button', { name: 'Forget it' }).click();
  await expect(row()).toContainText('If it still reaches the server, it is added then');
  await row().getByRole('button', { name: 'Forget this extension' }).click();
  await expect(row().getByLabel('Extend by (minutes)')).toBeEnabled();
  await expect(row().getByRole('button', { name: 'Extend', exact: true })).toBeVisible();
  expect(backend.extensions[bid(5)]!.map((e) => e.minutes)).toEqual([10]);
});

test('WQ11c (review D2): "Mark completed" is offered only once the start time has passed; the server’s NOT_STARTED_YET is said in words', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await nav(page).getByRole('link', { name: 'Appointments' }).click();
  const table = page.getByRole('table', { name: 'Appointments' });
  // Today 11:30 ("now" is 10:00): not yet; today 09:00: started.
  await expect(table.getByRole('row').filter({ hasText: '11:30' })).toContainText('Confirmed');
  await expect(table.getByRole('row').filter({ hasText: '11:30' }).getByRole('button', { name: 'Mark completed' })).toHaveCount(0);
  await page.getByLabel('Show').selectOption('upcoming');
  const future = table.getByRole('row').filter({ hasText: '21 Nov' }); // Sat 21 Nov 12:00
  await expect(future).toContainText('Confirmed');
  await expect(future.getByRole('button', { name: 'Mark completed' })).toHaveCount(0);
  await expect(future.getByRole('button', { name: 'Patient did not come' })).toHaveCount(0);
  await expect(future.getByRole('button', { name: 'Cancel' })).toBeVisible();
  // A clock that runs behind the server's: the server refuses, and the page says why.
  backend.completeRefusal = 'NOT_STARTED_YET';
  const started = table.getByRole('row').filter({ hasText: '09:00' });
  await started.getByRole('button', { name: 'Mark completed' }).click();
  await started.getByRole('button', { name: /^Complete / }).click();
  await expect(started).toContainText('This appointment has not started yet. Mark it completed once its time has come.');
  expect(backend.calls.filter((c) => c.method === 'PATCH').map((c) => c.path)).toEqual([`/specialists/me/appointments/${bid(2)}/status`]);
});

test('WQ11c (review D3): the no-show slot picker offers only slots for the booking’s type and place, names the place, and explains a type refusal', async ({ page }) => {
  const backend = await mockBackend(page);
  // 09:00: in person at the doctor's own place (no clinic). 08:00: video. 08:30: in person at Sunrise Clinic, MG Road.
  Object.assign(backend.appointments.find((a) => a._id === bid(2))!, { status: 'no_show', consultationMode: 'in-person', clinicVisit: undefined, serviceMode: 'in-person', updatedAt: '2026-11-17T04:00:00.000Z' });
  Object.assign(backend.appointments.find((a) => a._id === bid(1))!, { status: 'no_show', bookingTime: '08:00', consultationMode: 'video', updatedAt: '2026-11-17T04:00:00.000Z' });
  backend.appointments.push(appt(42, { bookingTime: '08:30', status: 'no_show', consultationMode: 'in-person', serviceMode: 'clinic', clinicVisit: { partnerId: SUNRISE, branchId: BR1 }, updatedAt: '2026-11-17T04:00:00.000Z' }));
  // Slots as `GET /specialists/me/slots` returns them (template slots carry `serviceModes`, clinic ones `branchId`).
  let slotReads = 0;
  await page.route('**/api/v1/specialists/me/slots**', (route) => {
    slotReads += 1;
    const date = new URL(route.request().url()).searchParams.get('date');
    const s = (id: string, startTime: string, endTime: string, extra: Rec) => ({ _id: id.repeat(12), date, startTime, endTime, maxBookings: 1, currentBookings: 0, isAvailable: true, isActive: true, ...extra });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: [
      s('61', '15:00', '15:15', { serviceModes: ['in-person'] }),
      s('62', '16:00', '16:15', { serviceModes: ['chat'] }),
      s('63', '17:00', '17:15', { serviceModes: ['video', 'call'] }),
      s('64', '18:00', '18:15', { serviceModes: ['in-person'], branchId: BR1 }),
    ] }) });
  });
  // The server's refusal of a slot not open to the booking's type (bookings/holds.ts assertSlotMode).
  await page.route('**/api/v1/specialists/me/bookings/*/reschedule-no-show', (route) => route.fulfill({ status: 409, contentType: 'application/json',
    body: JSON.stringify({ error: 409, code: 'SLOT_NOT_AVAILABLE', message: 'This slot is not offered for that consultation type' }) }));
  await signIn(page);
  await nav(page).getByRole('link', { name: 'Appointments' }).click();
  const table = page.getByRole('table', { name: 'Appointments' });

  const ownPlace = table.getByRole('row').filter({ hasText: '09:00' });
  await ownPlace.getByRole('button', { name: 'Reschedule no-show' }).click();
  const f1 = ownPlace.getByRole('form', { name: 'Reschedule no-show' });
  await f1.getByLabel('New day').fill('2026-11-18');
  await expect(f1.getByLabel('New time').locator('option')).toHaveText(['Choose a time', '15:00–15:15 · your own place']);
  await f1.getByRole('button', { name: 'Back' }).click();

  const clinic = table.getByRole('row').filter({ hasText: '08:30' });
  await clinic.getByRole('button', { name: 'Reschedule no-show' }).click();
  const f3 = clinic.getByRole('form', { name: 'Reschedule no-show' });
  await f3.getByLabel('New day').fill('2026-11-18');
  await expect(f3.getByLabel('New time').locator('option')).toHaveText(['Choose a time', '18:00–18:15 · Sunrise Clinic · MG Road']);
  await f3.getByLabel('New time').selectOption('18:00–18:15 · Sunrise Clinic · MG Road');
  await f3.getByRole('button', { name: 'Continue' }).click();
  await expect(f3).toContainText('to Wed, 18 Nov, 2026, 18:00 (Sunrise Clinic · MG Road)?');
  await f3.getByRole('button', { name: 'Back' }).click();
  await f3.getByRole('button', { name: 'Back' }).click();

  const video = table.getByRole('row').filter({ hasText: '08:00' });
  await video.getByRole('button', { name: 'Reschedule no-show' }).click();
  const f2 = video.getByRole('form', { name: 'Reschedule no-show' });
  await f2.getByLabel('New day').fill('2026-11-18');
  await expect(f2.getByLabel('New time').locator('option')).toHaveText(['Choose a time', '17:00–17:15 · online']);
  await f2.getByLabel('New time').selectOption('17:00–17:15 · online');
  await f2.getByRole('button', { name: 'Continue' }).click();
  await expect(f2).toContainText('to Wed, 18 Nov, 2026, 17:00 (online)?');
  const before = slotReads;
  await f2.getByRole('button', { name: /^Move to / }).click();
  await expect(page.getByText('Not moved: That time is not offered for this consultation type. Pick another time.')).toBeVisible();
  // The picker opens again with the slots read again.
  await expect(video.getByRole('form', { name: 'Reschedule no-show' })).toBeVisible();
  await expect.poll(() => slotReads).toBeGreaterThan(before);
});

test('WQ11c: a failed read again keeps the appointments and offers on screen, with a quiet note; the first failed read is an error', async ({ page }) => {
  const backend = await mockBackend(page, { install: true });
  backend.offers = [offer(1, 'Asha')];
  await signIn(page);
  await nav(page).getByRole('link', { name: 'Appointments' }).click();
  const table = page.getByRole('table', { name: 'Appointments' });
  await expect(table.getByRole('row').filter({ hasText: '11:30' })).toBeVisible();
  backend.failReads = /\/specialists\/me\/(appointments|instant\/offers)$/;
  await page.clock.runFor(16_000); // the list is no longer fresh: coming back reads it again, and that read fails
  await nav(page).getByRole('link', { name: 'Schedule' }).click();
  await nav(page).getByRole('link', { name: 'Appointments' }).click();
  await expect(page.getByText(/Could not refresh just now \(Too many requests, slow down\)\. Showing what was read at \d\d:\d\d\./)).toBeVisible();
  await expect(table.getByRole('row').filter({ hasText: '11:30' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(1);
  // Consult now: offers read every 15 s; a failed one keeps the list.
  backend.failReads = undefined;
  await nav(page).getByRole('link', { name: 'Consult now' }).click();
  await expect(page.getByRole('listitem', { name: 'Offer for Asha' })).toBeVisible();
  backend.failReads = /\/specialists\/me\/instant\/offers$/;
  await page.clock.runFor(16_000);
  await expect(page.getByRole('region', { name: 'Offers for you' }).getByText(/Could not refresh just now/)).toBeVisible();
  await expect(page.getByRole('listitem', { name: 'Offer for Asha' })).toBeVisible();
  // Read again successfully: the note goes.
  backend.failReads = undefined;
  await page.getByRole('region', { name: 'Offers for you' }).getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('region', { name: 'Offers for you' }).getByText(/Could not refresh just now/)).toHaveCount(0);
  // A first read that fails is still an error page.
  backend.failReads = /\/specialists\/me\/appointments$/;
  await page.reload();
  await nav(page).getByRole('link', { name: 'Appointments' }).click();
  await expect(page.getByText('Too many requests, slow down')).toBeVisible();
  await expect(table).toHaveCount(0);
});

test('WQ11c: a lost clinic create is "not recorded" only on the by-key route’s own CLINIC_NOT_FOUND; a bare 404 is a failed check', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.loseNextClinic = true;
  backend.clinicByKeyBroken = true;
  await signIn(page);
  await nav(page).getByRole('link', { name: 'Clinics' }).click();
  const form = page.getByRole('form', { name: 'Create my clinic' });
  await form.getByLabel('Clinic name').fill('Dr Meera Rao Heart Care');
  await form.getByLabel('Bill number prefix').fill('mrh');
  await form.getByLabel('Branch name').fill('Indiranagar');
  await form.getByLabel('Branch phone').fill('9000000021');
  await form.getByLabel('Address', { exact: true }).fill('5 CMH Road');
  await form.getByLabel('City').fill('Bengaluru');
  await form.getByLabel('State', { exact: true }).fill('Karnataka');
  await form.getByLabel('State code').fill('29');
  await form.getByLabel('PIN code').fill('560038');
  await form.getByRole('button', { name: 'Review' }).click();
  await form.getByRole('button', { name: 'Create my clinic' }).click();
  const unsure = page.getByRole('group', { name: 'Unconfirmed clinic' });
  await unsure.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(unsure).toContainText('Could not check the records: Cannot GET this path');
  await expect(unsure).not.toContainText('not recorded');
  backend.clinicByKeyBroken = false;
  await unsure.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(page.getByText('Jansetu has not verified your clinic yet.')).toBeVisible();
  expect(backend.calls.filter((c) => c.method === 'POST' && c.path === '/specialists/me/clinic')).toHaveLength(1);
});

test('WQ11c (re-review N7): "Patient did not come" from 15 minutes after the start (Q16a); an unreadable time still offers Mark completed', async ({ page }) => {
  const backend = await mockBackend(page, { install: true });
  backend.appointments.push(
    appt(43, { bookingTime: '09:50', primaryConcern: 'Ten minutes ago' }),
    appt(44, { bookingTime: 'after lunch', primaryConcern: 'Unreadable time' }),
  );
  await signIn(page);
  await nav(page).getByRole('link', { name: 'Appointments' }).click();
  const table = page.getByRole('table', { name: 'Appointments' });
  const recent = table.getByRole('row').filter({ hasText: 'Ten minutes ago' });
  await expect(recent.getByRole('button', { name: 'Mark completed' })).toBeVisible();
  await expect(recent.getByRole('button', { name: 'Patient did not come' })).toHaveCount(0);
  const unreadable = table.getByRole('row').filter({ hasText: 'Unreadable time' });
  await expect(unreadable.getByRole('button', { name: 'Mark completed' })).toBeVisible();
  await expect(unreadable.getByRole('button', { name: 'Patient did not come' })).toHaveCount(0);
  await page.clock.runFor(5 * 60_000 + 30_000); // 15 minutes after 09:50
  await expect(recent.getByRole('button', { name: 'Patient did not come' })).toBeVisible();
});
