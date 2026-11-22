import { ApiError, createApiClient } from './client.ts';
import {
  CONSENT_STATEMENT, CONSENT_STATEMENT_VERSION, isAssistedBooking, PATIENT_LANGUAGES, refusedBeforeWriting, SLOW_WRITE_TIMEOUT_MS, supportedModes,
  assistedRefusal, canBookerCancel, canonicalPhone, EMPTY_PATIENT, familyBookedBefore, formatSlotDate, isAssistedLimit, isSwitchedOff, joinWords,
  movementLabel, patientBody, patientProblems, pharmacyAssistedApi, pharmacyWalletApi, rxOrderProblems, signedPaiseOf, SWITCHED_OFF_MESSAGE,
  walletBalancePaise, walletState, type BookedConsultation, type PatientDraft,
} from './assisted.ts';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function setup(response: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = createApiClient({
    baseUrl: 'https://api.example.test', getToken: () => 'tok', timeoutMs: 100,
    fetchImpl: async (input, init) => { calls.push({ url: String(input), init: init ?? {} }); return response(); },
  });
  return { client, calls };
}

describe('canonicalPhone (backend canonicalMobile)', () => {
  it('keeps ten digits and drops +91, 91 and 0 prefixes, spaces and dashes', () => {
    expect(canonicalPhone('98765 43210')).toBe('9876543210');
    expect(canonicalPhone('+91-98765-43210')).toBe('9876543210');
    expect(canonicalPhone('919876543210')).toBe('9876543210');
    expect(canonicalPhone('09876543210')).toBe('9876543210');
    expect(canonicalPhone('987654321')).toBeNull();
    expect(canonicalPhone('98765432101')).toBeNull();
    expect(canonicalPhone('abc')).toBeNull();
  });
});

describe('ApiError carries the limit name and the price details', () => {
  it('reads limit (429) and details (409 PRICE_CHANGED) from the error body', async () => {
    const limited = setup(() => json(429, { error: 429, code: 'ASSISTED_LIMIT_REACHED', message: 'Too many', limit: 'lookups', retryAfter: 1800 }));
    const e1 = await pharmacyAssistedApi(limited.client).lookup('9876543210').catch((e: unknown) => e) as ApiError;
    expect(e1).toBeInstanceOf(ApiError);
    expect(e1.limit).toBe('lookups');
    expect(e1.retryAfter).toBe(1800);
    const priced = setup(() => json(409, { error: 409, code: 'PRICE_CHANGED', message: 'Price changed', details: { priceMinor: 45000, listMinor: 50000, discountMinor: 5000 } }));
    const e2 = await pharmacyAssistedApi(priced.client).book({} as never).catch((e: unknown) => e) as ApiError;
    expect(e2.details).toEqual({ priceMinor: 45000, listMinor: 50000, discountMinor: 5000 });
  });
});

describe('the assisted and wallet API', () => {
  it('sends the phone only in the POST body, never in the address', async () => {
    const { client, calls } = setup(() => json(200, { success: true, data: { exists: true, holderNameMasked: 'Rina K.' } }));
    await expect(pharmacyAssistedApi(client).lookup('9876543210')).resolves.toEqual({ exists: true, holderNameMasked: 'Rina K.' });
    expect(calls[0]!.url).toBe('https://api.example.test/api/v1/pharmacy-assisted/patients/lookup');
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ phone: '9876543210' });
  });

  it('verifies a top-up without `module` (S6) and refuses bad ids before sending', async () => {
    const { client, calls } = setup(() => json(200, { success: true, data: { context: 'wallet_recharge', paymentRecord: { status: 'paid' } } }));
    await pharmacyWalletApi(client).verify({ paymentTransactionId: 'a'.repeat(24), razorpayOrderId: 'order_1', razorpayPaymentId: 'pay_1', razorpaySignature: 'sig' });
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(calls[0]!.url).toBe('https://api.example.test/api/v1/payments/verify');
    expect(body).not.toHaveProperty('module');
    expect(Object.keys(body).sort()).toEqual(['paymentTransactionId', 'razorpayOrderId', 'razorpayPaymentId', 'razorpaySignature']);
    expect(() => pharmacyWalletApi(client).checkTopup('../x')).toThrow('Invalid payment id');
    expect(() => pharmacyAssistedApi(client).byKey('bad key')).toThrow('Invalid request key');
  });

  it('reads one doctor’s free times by id, and refuses a bad id before sending', async () => {
    const { client, calls } = setup(() => json(200, { success: true, data: { doctor: { doctorId: 'a'.repeat(24), feeMinor: 50000 }, from: '20261123', to: '20261129', slots: [] } }));
    await pharmacyAssistedApi(client).doctorSlots('a'.repeat(24), { from: '2026-11-23', days: 7, mode: 'video' });
    expect(calls[0]!.url).toBe(`https://api.example.test/api/v1/pharmacy-assisted/doctors/${'a'.repeat(24)}/slots?from=2026-11-23&days=7&mode=video`);
    expect(() => pharmacyAssistedApi(client).doctorSlots('x')).toThrow('Invalid doctor id');
    expect(assistedRefusal(new ApiError(404, 'Doctor not found', 'DOCTOR_NOT_FOUND')).kind).toBe('doctor');
  });

  it('pages the booked list by cursor', async () => {
    const { client, calls } = setup(() => json(200, { success: true, data: [{ _id: '1' }], pagination: { total: 30, nextCursor: '1732_abc' } }));
    const page = await pharmacyAssistedApi(client).bookings({ status: 'confirmed', limit: 20 });
    expect(page.nextCursor).toBe('1732_abc');
    expect(calls[0]!.url).toBe('https://api.example.test/api/v1/pharmacy-bookings?status=confirmed&limit=20');
  });
});

describe('assistedRefusal: plain words for every documented code', () => {
  const e = (status: number, code?: string, extra?: { limit?: string; details?: Record<string, unknown> }, retryAfter?: number) =>
    new ApiError(status, 'server words', code, retryAfter, extra);

  it('treats 503 ASSISTED_BOOKING_DISABLED and a code-less 404/503 (route not there yet) as switched off', () => {
    expect(isSwitchedOff(e(503, 'ASSISTED_BOOKING_DISABLED'))).toBe(true);
    expect(isSwitchedOff(e(404))).toBe(true);
    expect(isSwitchedOff(e(503))).toBe(true);
    expect(isSwitchedOff(e(404, 'BOOKING_NOT_FOUND'))).toBe(false);
    expect(isSwitchedOff(e(503, 'INDEXES_OUTDATED'))).toBe(false);
    expect(assistedRefusal(e(404))).toEqual({ kind: 'off', message: SWITCHED_OFF_MESSAGE });
    expect(SWITCHED_OFF_MESSAGE).toBe('Booking for patients is not switched on yet.');
  });

  it('wallet refusals say what to do (top up; contact support when on hold or owing)', () => {
    expect(assistedRefusal(e(409, 'INSUFFICIENT_BALANCE')).kind).toBe('topup');
    expect(assistedRefusal(e(409, 'WALLET_FROZEN'))).toMatchObject({ kind: 'wallet', message: expect.stringContaining('on hold') });
    expect(assistedRefusal(e(409, 'WALLET_RECEIVABLE'))).toMatchObject({ kind: 'wallet', message: expect.stringContaining('owes money') });
    expect(assistedRefusal(e(409, 'WALLET_INACTIVE')).kind).toBe('wallet');
    expect(assistedRefusal(e(409, 'TOPUP_BLOCKED')).message).toContain('blocked');
  });

  it('PRICE_CHANGED names the new price from the details', () => {
    const r = assistedRefusal(e(409, 'PRICE_CHANGED', { details: { priceMinor: 45050 } }));
    expect(r.kind).toBe('price');
    expect(r.priceMinor).toBe(45050);
    expect(r.message).toContain('₹450.50');
    expect(assistedRefusal(e(409, 'PRICE_CHANGED')).priceMinor).toBeUndefined();
  });

  it('names each limit, with the wait', () => {
    expect(assistedRefusal(e(429, 'ASSISTED_LIMIT_REACHED', { limit: 'lookups' }, 1800)).message).toBe('You have looked up many patients this hour. Try again in about 30 minutes.');
    expect(assistedRefusal(e(429, 'ASSISTED_LIMIT_REACHED', { limit: 'new_accounts' })).message).toContain('new patients');
    expect(assistedRefusal(e(429, 'ASSISTED_LIMIT_REACHED', { limit: 'bookings_per_phone' })).message).toContain('This phone number');
    expect(assistedRefusal(e(429, 'ASSISTED_LIMIT_REACHED', { limit: 'booker_cancellations' })).message).toContain('paused until tomorrow');
    expect(assistedRefusal(e(429)).kind).toBe('limit');
    expect(isAssistedLimit(e(429, 'ASSISTED_LIMIT_REACHED'))).toBe(true);
    expect(isAssistedLimit(e(429))).toBe(false);
  });

  it('slot, doctor and patient refusals', () => {
    expect(assistedRefusal(e(409, 'SLOT_NOT_AVAILABLE'))).toMatchObject({ kind: 'slot', message: 'This time was just taken. Choose another time.' });
    expect(assistedRefusal(e(409, 'SLOT_STARTED')).kind).toBe('slot');
    expect(assistedRefusal(e(409, 'DOCTOR_NOT_AVAILABLE')).kind).toBe('doctor');
    expect(assistedRefusal(e(409, 'SPECIALIST_NOT_VERIFIED')).kind).toBe('doctor');
    expect(assistedRefusal(e(400, 'CONSENT_REQUIRED')).message).toContain('Patient agreed');
    expect(assistedRefusal(e(404, 'DEPENDENT_NOT_FOUND')).kind).toBe('patient');
    expect(assistedRefusal(e(400, 'COUPON_NOT_FOR_ASSISTED')).kind).toBe('coupon');
  });

  it('falls back to the server message, and words a non-API failure', () => {
    expect(assistedRefusal(e(400, 'VALIDATION_ERROR')).message).toBe('server words');
    expect(assistedRefusal(new Error('x')).message).toBe('Something went wrong. Please try again.');
  });
});

describe('wallet words', () => {
  it('balance in paise, falling back to rupees', () => {
    expect(walletBalancePaise({ balancePaise: 12345, balance: 1 })).toBe(12345);
    expect(walletBalancePaise({ balance: 123.45 })).toBe(12345);
    expect(walletBalancePaise(undefined)).toBe(0);
  });
  it('state: owing before frozen before off', () => {
    expect(walletState({ frozen: true, receivableMinor: 100 })).toBe('owing');
    expect(walletState({ frozen: true })).toBe('frozen');
    expect(walletState({ isActive: false })).toBe('off');
    expect(walletState({ balancePaise: 0 })).toBe('ok');
  });
  it('credit or debit by sign, and labels by movementType', () => {
    expect(signedPaiseOf({ _id: '1', transactionType: 'debit', signedAmountPaise: -50000 })).toBe(-50000);
    expect(signedPaiseOf({ _id: '1', transactionType: 'credit', amount: 500 })).toBe(50000);
    expect(signedPaiseOf({ _id: '1', transactionType: 'debit', amountPaise: 700 })).toBe(-700);
    expect(movementLabel({ _id: '1', transactionType: 'debit', movementType: 'booking_debit' })).toBe('Paid for a consultation booking');
    expect(movementLabel({ _id: '1', transactionType: 'credit', movementType: 'refund_credit' })).toBe('Refund of a cancelled booking');
    expect(movementLabel({ _id: '1', transactionType: 'credit', movementType: 'credit', referenceType: 'wallet_recharge' })).toBe('Top-up (card / UPI)');
    expect(movementLabel({ _id: '1', transactionType: 'debit', movementType: 'chargeback' })).toBe('Taken back after a card dispute');
    expect(movementLabel({ _id: '1', transactionType: 'credit', movementType: 'something_new', signedAmountPaise: 5 })).toBe('Money added');
  });
});

describe('the patient step', () => {
  const draft = (d: Partial<PatientDraft>): PatientDraft => ({ ...EMPTY_PATIENT, phone: '9876543210', ...d });
  it('a new number is typed twice; the holder needs a name', () => {
    expect(patientProblems(draft({ name: 'Rina' }), false)).toHaveProperty('phoneAgain');
    expect(patientProblems(draft({ name: 'Rina', phoneAgain: '+91 98765 43210' }), false)).toEqual({});
    expect(patientProblems(draft({ name: '  ' }), true)).toHaveProperty('name');
  });
  it('a family member needs a relation; date of birth is real and not in the future', () => {
    expect(patientProblems(draft({ who: 'family', name: 'Asha' }), true)).toHaveProperty('relation');
    expect(patientProblems(draft({ who: 'family', name: 'Asha', relation: 'Mother', dateOfBirth: '2030-01-01' }), true, '2026-11-22')).toHaveProperty('dateOfBirth');
    expect(patientProblems(draft({ who: 'family', name: 'Asha', relation: 'Mother', dateOfBirth: '1960-02-30' }), true, '2026-11-22')).toHaveProperty('dateOfBirth');
    expect(patientProblems(draft({ who: 'family', name: 'Asha', relation: 'Mother', dateOfBirth: '1960-02-28' }), true, '2026-11-22')).toEqual({});
    expect(patientProblems(draft({ who: 'known' }), true)).toHaveProperty('dependentId');
  });
  it('builds the three patient forms of the create', () => {
    expect(patientBody(draft({ name: ' Rina   Kumari ' }))).toEqual({ patient: { relation: 'self', name: 'Rina Kumari' } });
    expect(patientBody(draft({ who: 'family', name: 'Asha', relation: 'Mother', gender: 'Female', holderName: 'Rina' })))
      .toEqual({ patient: { relation: 'Mother', name: 'Asha', gender: 'Female' }, holderName: 'Rina' });
    expect(patientBody(draft({ who: 'known', dependentId: 'A'.repeat(24) }))).toEqual({ patient: { dependentId: 'a'.repeat(24) } });
  });
  it('offers only family members booked before on this same number', () => {
    const rows: BookedConsultation[] = [
      { _id: '1', status: 'completed', dependentId: 'd'.repeat(24), patientName: 'Asha', contactNo: '9876543210' },
      { _id: '2', status: 'completed', dependentId: 'd'.repeat(24), patientName: 'Asha', contactNo: '9876543210' },
      { _id: '3', status: 'completed', dependentId: 'e'.repeat(24), patientName: 'Other', contactNo: '9123456789' },
      { _id: '4', status: 'completed', dependentId: null, patientName: 'Rina K.', contactNo: '9876543210' },
    ];
    expect(familyBookedBefore(rows, '9876543210')).toEqual([{ dependentId: 'd'.repeat(24), name: 'Asha' }]);
  });
});

describe('booked consultations', () => {
  const now = new Date('2026-11-22T04:30:00.000Z'); // 10:00 in India
  const b = (o: Partial<BookedConsultation>): BookedConsultation => ({ _id: '1', status: 'confirmed', source: 'pharmacy_assisted', bookingDate: '20261122', bookingTime: '10:30', ...o });
  it('can be cancelled by the booking pharmacy any time before it starts', () => {
    expect(canBookerCancel(b({}), now)).toBe(true);
    expect(canBookerCancel(b({ bookingTime: '10:00' }), now)).toBe(false);
    expect(canBookerCancel(b({ status: 'completed' }), now)).toBe(false);
    expect(canBookerCancel(b({ source: 'self' }), now)).toBe(false);
  });
  it('dates and join words', () => {
    expect(formatSlotDate('20261122')).toBe('22 Nov 2026');
    expect(joinWords('in-person', undefined)).toContain('clinic');
    expect(joinWords('video', 'partner_device')).toContain('Join call');
    expect(joinWords('call', 'patient_phone')).toContain('patient’s number');
  });
  it('an order from the prescription needs a chosen medicine with whole units', () => {
    expect(rxOrderProblems([{ medicineId: '', qty: '' }])).toContain('at least one');
    expect(rxOrderProblems([{ medicineId: 'm', qty: '0' }])).toContain('whole number');
    expect(rxOrderProblems([{ medicineId: 'm', qty: '2' }, { medicineId: '', qty: '' }])).toBeNull();
  });
});

describe('WQ12 fixes', () => {
  it('offers only the modes the create accepts (chat is left out), within the filter', () => {
    expect(supportedModes(['chat', 'video', 'call'])).toEqual(['video', 'call']);
    expect(supportedModes(['chat'])).toEqual([]);
    expect(supportedModes(['video', 'in-person'], 'in-person')).toEqual(['in-person']);
    expect(supportedModes(undefined)).toEqual([]);
  });
  it('a sole first attempt refused by a limit or a coded 503 recorded nothing; a code-less 503 stays unknown', () => {
    expect(refusedBeforeWriting(new ApiError(429, 'x', 'ASSISTED_LIMIT_REACHED'))).toBe(true);
    for (const code of ['ASSISTED_BOOKING_DISABLED', 'INDEXES_OUTDATED', 'CUSTOMER_LINKING_UNAVAILABLE']) {
      expect(refusedBeforeWriting(new ApiError(503, 'x', code))).toBe(true);
    }
    expect(refusedBeforeWriting(new ApiError(503, 'x'))).toBe(false);
    expect(refusedBeforeWriting(new ApiError(502, 'x', 'INDEXES_OUTDATED'))).toBe(false);
    expect(refusedBeforeWriting(new ApiError(0, 'x', 'NETWORK'))).toBe(false);
  });
  it('marks assisted rows by source or their assisted block', () => {
    expect(isAssistedBooking({ _id: '1', status: 'confirmed', source: 'pharmacy_assisted' })).toBe(true);
    expect(isAssistedBooking({ _id: '1', status: 'confirmed', source: 'self', assisted: { shortRef: 'K7QXM2PA' } })).toBe(true);
    expect(isAssistedBooking({ _id: '1', status: 'confirmed', source: 'self' })).toBe(false);
  });
  it('consent v2 names the account, the shared details and the 90-day prescription view', () => {
    expect(CONSENT_STATEMENT_VERSION).toBe('web-pharmacy-v2');
    expect(CONSENT_STATEMENT_VERSION.length).toBeLessThanOrEqual(40); // backend statementVersion max 40
    expect(CONSENT_STATEMENT).toContain('an account is made for this number if it has none');
    expect(CONSENT_STATEMENT).toContain('for 90 days');
  });
  it('every patient language code is one the backend accepts (2–3 lower-case letters), once each', () => {
    const codes = PATIENT_LANGUAGES.map((l) => l.code);
    expect(codes.every((c) => /^[a-z]{2,3}$/.test(c))).toBe(true);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of ['as', 'lus', 'mni', 'ne', 'bn', 'or', 'kha', 'grt', 'brx']) expect(codes).toContain(c);
  });
  it('the create and the order from a prescription get a 60 s time limit', async () => {
    let signal: AbortSignal | undefined;
    const client = createApiClient({ baseUrl: '', getToken: () => 't', timeoutMs: 5,
      fetchImpl: (_i, init) => { signal = init?.signal ?? undefined; return new Promise((r) => setTimeout(() => r(json(201, { success: true, data: {} })), 30)); } });
    await expect(pharmacyAssistedApi(client).book({} as never)).resolves.toEqual({});
    expect(signal?.aborted).toBe(false);
    await expect(pharmacyAssistedApi(client).orderFromPrescription({} as never)).resolves.toEqual({});
    expect(SLOW_WRITE_TIMEOUT_MS).toBe(60_000);
  });
});
