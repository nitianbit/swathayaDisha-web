import { ApiError, createApiClient } from './client.ts';
import {
  bookingCloseApi, bookingCloseFinal, bookingCloseRefusal, bookingCloseRefusedBeforeWriting, canCloseAndRefund, closeByKey,
  closeRefundTarget, closeRefundWords, doctorAdminListApi, doctorEligibility, doctorStateRefusal, doctorStateRefusedBeforeWriting, fenceHolds, isAlreadyCancelled,
  isFenceMismatch, verifyFenceOf, type BookingClose,
} from './adminDoctors.ts';
import type { AdminConsultation } from './adminConsultations.ts';

const DOC = 'd1'.repeat(12);
const BK = 'e1'.repeat(12);
const KEY = 'k'.repeat(32);

function recorder(answer: (url: string, method: string) => unknown = () => ({ success: true, data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 1 } })) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const client = createApiClient({ baseUrl: 'https://api.example.test', getToken: () => 'tok',
    fetchImpl: async (u, init) => {
      const url = String(u).replace('https://api.example.test/api/v1', '');
      const method = String(init?.method);
      calls.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      return new Response(JSON.stringify(answer(url, method)), { status: 200 });
    } });
  return { client, calls };
}

const close = (o: Partial<BookingClose> = {}): BookingClose => ({
  auditId: 'a'.repeat(24), bookingId: BK, adminId: 'ad'.repeat(12), requestKey: KEY, reason: 'Doctor left', statusBefore: 'confirmed',
  paymentStatusBefore: 'paid', refunded: 800, closedAt: '2026-11-25T05:00:00.000Z', ...o,
});
const booking = (o: Partial<AdminConsultation> = {}): AdminConsultation => ({
  _id: BK, bookingType: 'consultation', bookingKind: 'scheduled', bookingDate: '20261126', bookingTime: '10:00', status: 'confirmed', paymentStatus: 'paid', ...o,
});

describe('WQ18 admin doctors (specialists routes as an admin)', () => {
  it('lists every doctor newest first with the schema’s filters; the name is trimmed; one doctor by id', async () => {
    const { client, calls } = recorder();
    const api = doctorAdminListApi(client);
    await api.list({ name: ' Mehta ', isVerified: 'false', isActive: 'true', page: 2 });
    await api.list();
    expect(() => api.list({ name: 'x'.repeat(101) })).toThrow('Invalid search');
    expect(() => api.get('not-an-id')).toThrow('Invalid doctor id');
    await api.get(DOC);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /specialists?name=Mehta&isVerified=false&isActive=true&sortBy=createdAt&sortOrder=desc&page=2&limit=20',
      'GET /specialists?sortBy=createdAt&sortOrder=desc&page=1&limit=20',
      `GET /specialists/${DOC}`,
    ]);
  });

  it('verify sends isVerified with the reviewed name and registration number (the S5 fence); unverify sends no fence', async () => {
    const { client, calls } = recorder(() => ({ success: true, data: { _id: DOC, name: 'Dr Asha', isVerified: true } }));
    const api = doctorAdminListApi(client);
    const fence = verifyFenceOf({ name: '  Dr Asha Mehta ', medicalRegistrationNumber: ' MCI-123 ' });
    expect(fence).toEqual({ expectedName: 'Dr Asha Mehta', expectedRegistrationNumber: 'MCI-123' });
    await api.verify(DOC, fence);
    await api.unverify(DOC);
    expect(calls).toEqual([
      { method: 'PUT', url: `/specialists/${DOC}`, body: { isVerified: true, expectedName: 'Dr Asha Mehta', expectedRegistrationNumber: 'MCI-123' } },
      { method: 'PUT', url: `/specialists/${DOC}`, body: { isVerified: false } },
    ]);
    // A missing registration number is fenced as the server compares it: the empty string.
    expect(verifyFenceOf({ name: 'Dr B' })).toEqual({ expectedName: 'Dr B', expectedRegistrationNumber: '' });
    expect(() => api.verify(DOC, { expectedName: ' ', expectedRegistrationNumber: '' })).toThrow('The reviewed name is missing');
  });

  it('the fence holds only while the name and number read now are the reviewed ones (trimmed, as the server compares)', () => {
    const f = { expectedName: 'Dr Asha Mehta', expectedRegistrationNumber: 'MCI-123' };
    expect(fenceHolds({ name: 'Dr Asha Mehta ', medicalRegistrationNumber: 'MCI-123' }, f)).toBe(true);
    expect(fenceHolds({ name: 'Dr Asha Mehta', medicalRegistrationNumber: 'MCI-999' }, f)).toBe(false);
    expect(fenceHolds({ name: 'Dr A. Mehta', medicalRegistrationNumber: 'MCI-123' }, f)).toBe(false);
  });

  it('eligible = verified AND active; a missing flag is not (S5 isEligibleDoctor)', () => {
    expect(doctorEligibility({ isVerified: true, isActive: true }).eligible).toBe(true);
    expect(doctorEligibility({ isVerified: true, isActive: false })).toEqual({ verified: true, active: false, eligible: false });
    expect(doctorEligibility({ isActive: true })).toEqual({ verified: false, active: true, eligible: false });
  });

  it('refusals: the fence mismatch is recognised and said in words; the index check settles a sole first attempt', () => {
    const mismatch = new ApiError(409, "The doctor's profile changed since you reviewed it", 'SPECIALIST_CHANGED_SINCE_REVIEW');
    expect(isFenceMismatch(mismatch)).toBe(true);
    expect(isFenceMismatch(new ApiError(409, 'x', 'BOOKING_CHANGED'))).toBe(false);
    expect(doctorStateRefusal(mismatch)).toContain('changed since you read them');
    expect(doctorStateRefusal(new ApiError(400, 'Phone must be exactly 10 digits', 'VALIDATION_ERROR'))).toBe('Phone must be exactly 10 digits');
    expect(doctorStateRefusedBeforeWriting(new ApiError(503, 'x', 'INDEXES_OUTDATED'))).toBe(true);
    expect(doctorStateRefusedBeforeWriting(new ApiError(503, 'x'))).toBe(false);
  });
});

describe('WQ18 S5c admin close and refund', () => {
  it('sends the trimmed reason, the request key and the reviewed version; reads the closes of a booking', async () => {
    const { client, calls } = recorder((url, method) => (method === 'POST'
      ? { success: true, data: { ...booking({ status: 'cancelled' }), replayed: false, refunded: 800, close: close() } }
      : { success: true, data: [close()] }));
    const api = bookingCloseApi(client);
    const a = await api.close(BK, { reason: '  Doctor left Jansetu ', requestKey: KEY, expectedUpdatedAt: '2026-11-24T06:00:00.000Z' });
    expect(a.refunded).toBe(800);
    await api.close(BK, { reason: 'Doctor left', requestKey: KEY });
    expect(await api.closes(BK)).toHaveLength(1);
    expect(calls).toEqual([
      { method: 'POST', url: `/specialists/admin/bookings/${BK}/close`, body: { reason: 'Doctor left Jansetu', requestKey: KEY, expectedUpdatedAt: '2026-11-24T06:00:00.000Z' } },
      { method: 'POST', url: `/specialists/admin/bookings/${BK}/close`, body: { reason: 'Doctor left', requestKey: KEY } },
      { method: 'GET', url: `/specialists/admin/bookings/${BK}/close`, body: undefined },
    ]);
  });

  it('checks the reason (3–500), key and version before any request', async () => {
    const { client, calls } = recorder();
    const api = bookingCloseApi(client);
    await expect(api.close(BK, { reason: ' ab ', requestKey: KEY })).rejects.toThrow('Invalid reason');
    await expect(api.close(BK, { reason: 'Doctor left', requestKey: 'short' })).rejects.toThrow('Invalid request key');
    await expect(api.close(BK, { reason: 'Doctor left', requestKey: KEY, expectedUpdatedAt: 'yesterday' })).rejects.toThrow('Invalid version');
    await expect(api.close('nope', { reason: 'Doctor left', requestKey: KEY })).rejects.toThrow('Invalid booking id');
    await expect(api.close(BK, { reason: 'x'.repeat(501), requestKey: KEY })).rejects.toThrow('Invalid reason');
    expect(calls).toHaveLength(0);
  });

  it('a 200 that is not this key’s recorded close is not proof of a close (502, stays unknown)', async () => {
    const { client } = recorder(() => ({ success: true, data: { ...booking(), refunded: 0, close: close({ requestKey: 'z'.repeat(32) }) } }));
    await expect(bookingCloseApi(client).close(BK, { reason: 'Doctor left', requestKey: KEY })).rejects.toMatchObject({ status: 502 });
    const { client: c2 } = recorder(() => ({ success: true, data: booking() }));
    await expect(bookingCloseApi(c2).close(BK, { reason: 'Doctor left', requestKey: KEY })).rejects.toMatchObject({ status: 502 });
  });

  it('offered only for an open scheduled consultation, not moved after a no-show, whose doctor is ineligible or gone', () => {
    expect(canCloseAndRefund(booking(), 'ineligible')).toBe(true);
    expect(canCloseAndRefund(booking({ status: 'pending' }), 'missing')).toBe(true);
    expect(canCloseAndRefund(booking(), 'eligible')).toBe(false);
    expect(canCloseAndRefund(booking(), 'unknown')).toBe(false);
    expect(canCloseAndRefund(booking({ status: 'completed' }), 'ineligible')).toBe(false);
    expect(canCloseAndRefund(booking({ status: 'cancelled' }), 'ineligible')).toBe(false);
    expect(canCloseAndRefund(booking({ bookingKind: 'instant' }), 'ineligible')).toBe(false);
    expect(canCloseAndRefund(booking({ noShowReschedules: 1 }), 'ineligible')).toBe(false);
    // A clinic-paid moved appointment is not refused NO_SHOW_NOT_REFUNDABLE by the settlement.
    expect(canCloseAndRefund(booking({ noShowReschedules: 1, settlementSystem: 'clinic' }), 'ineligible')).toBe(true);
  });

  it('final answers settle any attempt; the index check only a sole first one; refusals in words', () => {
    for (const code of ['BOOKING_NOT_CANCELLABLE', 'NO_SHOW_NOT_REFUNDABLE', 'USE_INSTANT_ADMIN_CANCEL', 'NOT_A_CONSULTATION', 'ALREADY_CANCELLED']) {
      expect(bookingCloseFinal(new ApiError(409, 'x', code))).toBe(true);
    }
    expect(bookingCloseFinal(new ApiError(404, 'x', 'BOOKING_NOT_FOUND'))).toBe(true);
    // A version change or a reused key may be an earlier attempt of this request racing: not final on a resend.
    expect(bookingCloseFinal(new ApiError(409, 'x', 'BOOKING_CHANGED'))).toBe(false);
    expect(bookingCloseFinal(new ApiError(409, 'x', 'REQUEST_KEY_REUSED'))).toBe(false);
    expect(bookingCloseFinal(new ApiError(500, 'x', 'ADMIN_CLOSE_NOT_RECORDED'))).toBe(false);
    expect(isAlreadyCancelled(new ApiError(409, 'x', 'ALREADY_CANCELLED'))).toBe(true);
    expect(bookingCloseRefusedBeforeWriting(new ApiError(503, 'x', 'INDEXES_OUTDATED'))).toBe(true);
    expect(bookingCloseRefusal(new ApiError(409, 'x', 'BOOKING_CHANGED'))).toContain('changed since you read it');
    expect(bookingCloseRefusal(new ApiError(409, 'Server words', 'SOMETHING_NEW'))).toBe('Server words');
  });

  it('the refund is said as the server answered it: patient wallet, the pharmacy’s wallet, queued to its card, or nothing', () => {
    const money = (n: number) => `Rs ${n}`;
    expect(closeRefundTarget({})).toBe('patient');
    expect(closeRefundTarget({ assisted: { funding: { method: 'wallet' } } })).toBe('pharmacy_wallet');
    expect(closeRefundTarget({ assisted: { funding: { method: 'razorpay' } } })).toBe('pharmacy_card');
    expect(closeRefundWords(800, 'patient', money)).toBe('Rs 800 was refunded to the patient’s Jansetu wallet.');
    expect(closeRefundWords(500, 'pharmacy_wallet', money)).toBe('Rs 500 was refunded to the pharmacy that booked it.');
    expect(closeRefundWords(500, 'pharmacy_card', money)).toBe('Rs 500 is being refunded to the card or UPI the pharmacy paid with.');
    expect(closeRefundWords(0, 'patient', money)).toBe('Nothing was refunded: no money was held for it through Jansetu.');
  });

  it('finds this key’s close among the booking’s closes, exactly', () => {
    expect(closeByKey([close({ requestKey: 'z'.repeat(32) }), close()], KEY)?.requestKey).toBe(KEY);
    expect(closeByKey([close({ requestKey: 'z'.repeat(32) })], KEY)).toBeNull();
    expect(closeByKey(null, KEY)).toBeNull();
  });
});
