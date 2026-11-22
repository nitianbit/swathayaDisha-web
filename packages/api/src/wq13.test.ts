import { ApiError, createApiClient } from './client.ts';
import {
  canBookerReschedule, nextFreeSlot, pharmacyAssistedApi, pharmacyCustomersApi, rescheduleRefusal, rescheduleRuleText, rescheduleSlots, supportedModes,
  SWITCHED_OFF_MESSAGE, typedNameProblem, typedNameRefusal, typedNameTarget, type AssistedSlot, type BookedConsultation, type WalletMovement,
} from './assisted.ts';
import {
  ADMIN_TOPUP_WARNING, adminPharmacyWalletApi, adminTopupForm, adminTopupRefusal, adminWalletReadError, findAdminTopup, isAdminTopupRow,
  latestAdminCredit, topupNotFoundWords,
} from './adminPharmacyWallet.ts';
import type { Page } from './client.ts';

// WQ13: booker reschedule, the typed-name edit, the doctor card's next time, and the admin wallet credit.

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function setup(response: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = createApiClient({
    baseUrl: 'https://api.example.test', getToken: () => 'tok', timeoutMs: 100,
    fetchImpl: async (input, init) => { calls.push({ url: String(input), init: init ?? {} }); return response(); },
  });
  return { client, calls };
}
const err = (status: number, code?: string, message = 'refused') => new ApiError(status, message, code);
const ID = 'a'.repeat(24);
const SLOT = 'b'.repeat(24);
const KEY = 'k'.repeat(32);
const slot = (o: Partial<AssistedSlot>): AssistedSlot => ({ slotId: SLOT, date: '20261123', startTime: '10:30', endTime: '10:45', startsAt: '', modes: ['video'], ...o });

describe('supportedModes and the doctor card’s next free time', () => {
  it('keeps only the modes the create accepts, own keys only', () => {
    expect(supportedModes(['video', 'chat', 'call', 'in-person'])).toEqual(['video', 'call', 'in-person']);
    expect(supportedModes(['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf'])).toEqual([]);
    expect(supportedModes(['video', 'call'], 'call')).toEqual(['call']);
    expect(supportedModes(undefined)).toEqual([]);
  });
  it('shows the next slot only when the list would show it', () => {
    expect(nextFreeSlot({ nextSlot: null })).toBeNull();
    expect(nextFreeSlot({ nextSlot: slot({ modes: ['chat'] as never }) })).toBeNull();
    expect(nextFreeSlot({ nextSlot: slot({ modes: ['toString'] as never }) })).toBeNull();
    expect(nextFreeSlot({ nextSlot: slot({ modes: ['video'] }) }, 'call')).toBeNull();
    expect(nextFreeSlot({ nextSlot: slot({ modes: ['video', 'chat'] as never }) })?.slotId).toBe(SLOT);
  });
});

describe('reschedule (P9)', () => {
  it('posts the slot, key and version to the booking’s reschedule route; the same body on a resend', async () => {
    const { client, calls } = setup(() => json(200, { success: true, data: { booking: { _id: ID }, replayed: false } }));
    const body = { slotId: SLOT, requestKey: KEY, expectedUpdatedAt: '2026-11-22T05:00:00.000Z' };
    await pharmacyAssistedApi(client).reschedule(ID, body);
    await pharmacyAssistedApi(client).reschedule(ID, body);
    expect(calls[0]!.url).toBe(`https://api.example.test/api/v1/pharmacy-assisted/bookings/${ID}/reschedule`);
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(body);
    expect(calls[1]!.init.body).toBe(calls[0]!.init.body);
  });
  it('refuses a bad booking id, slot id or key before sending', () => {
    const { client, calls } = setup(() => json(200, {}));
    const api = pharmacyAssistedApi(client);
    expect(() => api.reschedule('x', { slotId: SLOT, requestKey: KEY })).toThrow();
    expect(() => api.reschedule(ID, { slotId: 'x', requestKey: KEY })).toThrow();
    expect(() => api.reschedule(ID, { slotId: SLOT, requestKey: 'short' })).toThrow();
    expect(calls).toHaveLength(0);
  });
  it('is offered for an assisted booking before its start, with a known doctor', () => {
    const now = new Date('2026-11-22T04:30:00.000Z'); // 10:00 in India
    const b = (o: Partial<BookedConsultation>): BookedConsultation => ({ _id: ID, status: 'confirmed', source: 'pharmacy_assisted', bookingDate: '20261122',
      bookingTime: '10:30', specialistId: 'd'.repeat(24), ...o });
    expect(canBookerReschedule(b({}), now)).toBe(true);
    expect(canBookerReschedule(b({ specialistId: undefined }), now)).toBe(false);
    expect(canBookerReschedule(b({ bookingTime: '10:00' }), now)).toBe(false);
    expect(canBookerReschedule(b({ status: 'no_show' }), now)).toBe(false);
    expect(canBookerReschedule(b({ status: 'cancelled' }), now)).toBe(false);
  });
  it('offers the doctor’s times in the booking’s own mode, without the time it holds', () => {
    const booking = { slotId: SLOT, consultationMode: 'call', bookingDate: '20261123', bookingTime: '10:30' };
    const slots = [
      slot({}), // the booking's own slot
      slot({ slotId: 'c'.repeat(24), startTime: '11:00', modes: ['video'] }), // another mode
      slot({ slotId: 'e'.repeat(24), startTime: '11:30', modes: ['call', 'video'] }),
      slot({ slotId: 'f'.repeat(24), startTime: '10:30', modes: ['call'] }), // same date and time
    ];
    expect(rescheduleSlots(slots, booking).map((s) => s.startTime)).toEqual(['11:30']);
    expect(rescheduleSlots(slots, { ...booking, consultationMode: 'chat' })).toEqual([]);
  });
  it('says the rule the server enforces', () => {
    expect(rescheduleRuleText('video')).toContain('same doctor, any time before it starts');
    expect(rescheduleRuleText('video')).toContain('The price stays the same');
    expect(rescheduleRuleText('in-person')).toContain('It stays a visit at the clinic.');
    expect(rescheduleRuleText('call')).toContain('It stays a phone call.');
  });
  it('maps each refusal to plain words and what to do next', () => {
    expect(rescheduleRefusal(err(409, 'SLOT_NOT_AVAILABLE'))).toEqual({ kind: 'slot', message: 'This time was just taken, or is no longer free. Choose another time.' });
    expect(rescheduleRefusal(err(409, 'SLOT_STARTED')).kind).toBe('slot');
    expect(rescheduleRefusal(err(409, 'SAME_SLOT'))).toEqual({ kind: 'slot', message: 'The consultation is already at this time. Choose another time.' });
    expect(rescheduleRefusal(err(409, 'DOCTOR_BUSY')).kind).toBe('slot');
    expect(rescheduleRefusal(err(409, 'SLOT_NOT_THIS_DOCTOR')).kind).toBe('slot');
    expect(rescheduleRefusal(err(409, 'DOCTOR_NOT_AVAILABLE'))).toMatchObject({ kind: 'doctor', message: expect.stringContaining('not taking bookings') });
    expect(rescheduleRefusal(err(404, 'DOCTOR_NOT_FOUND')).kind).toBe('doctor');
    expect(rescheduleRefusal(err(409, 'BOOKING_CHANGED'))).toMatchObject({ kind: 'changed', message: expect.stringContaining('changed since you opened it') });
    expect(rescheduleRefusal(err(400, 'BOOKING_ALREADY_STARTED'))).toMatchObject({ kind: 'late', message: expect.stringContaining('Too late') });
    expect(rescheduleRefusal(err(409, 'BOOKING_NOT_RESCHEDULABLE')).kind).toBe('late');
    expect(rescheduleRefusal(err(409, 'IDEMPOTENCY_KEY_REUSED')).kind).toBe('changed');
    expect(rescheduleRefusal(err(503, 'ASSISTED_BOOKING_DISABLED')).message).toBe(SWITCHED_OFF_MESSAGE);
    expect(rescheduleRefusal(err(409, 'WALLET_FROZEN')).kind).toBe('other');
    expect(rescheduleRefusal(new Error('x')).message).toBe('Something went wrong. Please try again.');
  });
});

describe('the typed-name edit (§17.4)', () => {
  it('PUTs the cleaned name to the holder’s link', async () => {
    const { client, calls } = setup(() => json(200, { success: true, data: { _id: 'l'.repeat(24), userId: ID, typedName: 'Rina Kumari' } }));
    await expect(pharmacyCustomersApi(client).setTypedName(ID, '  Rina   Kumari ')).resolves.toMatchObject({ typedName: 'Rina Kumari' });
    expect(calls[0]!.url).toBe(`https://api.example.test/api/v1/pharmacy-customers/${ID}/typed-name`);
    expect(calls[0]!.init.method).toBe('PUT');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ typedName: 'Rina Kumari' });
    expect(() => pharmacyCustomersApi(client).setTypedName('x', 'A')).toThrow();
  });
  it('checks the name as typedNameSchema does (1–200 characters after trimming)', () => {
    expect(typedNameProblem('   ')).toBe('Type the patient’s name.');
    expect(typedNameProblem('a'.repeat(201))).toBe('Use at most 200 characters.');
    expect(typedNameProblem('a'.repeat(200))).toBeNull();
  });
  const BK = 'e'.repeat(24);
  it('targets the booking’s account holder (q16: by user id, on the holder’s own booking only; remembered by the booking id)', () => {
    expect(typedNameTarget({ _id: BK, userId: ID.toUpperCase(), dependentId: null, patientName: 'Rina K.' })).toEqual({ id: ID, name: 'Rina K.', family: false, markerId: BK });
    expect(typedNameTarget({ _id: BK, userId: ID, dependentId: 'd'.repeat(24), patientName: 'Asha' })).toBeNull();
    expect(typedNameTarget({ _id: BK, userId: undefined, dependentId: null })).toBeNull();
  });
  it('r6: uses this pharmacy’s own link id from `holder`, also on a family member’s booking; no link, no edit', () => {
    const link = 'c'.repeat(24);
    expect(typedNameTarget({ _id: BK, userId: ID, dependentId: null, patientName: 'Rina K.', holder: { pharmacyCustomerId: link, name: 'Rina K.' } }))
      .toEqual({ id: link, name: 'Rina K.', family: false, markerId: link });
    expect(typedNameTarget({ _id: BK, userId: ID, dependentId: 'd'.repeat(24), patientName: 'Asha', holder: { pharmacyCustomerId: link, name: 'Rina K.' } }))
      .toEqual({ id: link, name: 'Rina K.', family: true, markerId: link });
    expect(typedNameTarget({ _id: BK, userId: ID, dependentId: null, patientName: 'Rina K.', holder: { pharmacyCustomerId: null, name: 'Rina K.' } })).toBeNull();
  });
  it('says the refusals plainly', () => {
    expect(typedNameRefusal(err(404, 'CUSTOMER_NOT_LINKED'))).toBe('This patient is not linked to your pharmacy, so the name cannot be changed here.');
    expect(typedNameRefusal(err(400, 'VALIDATION_ERROR'))).toBe('Type a name of 1 to 200 characters.');
    expect(typedNameRefusal(err(503, 'ASSISTED_BOOKING_DISABLED'))).toBe(SWITCHED_OFF_MESSAGE);
  });
});

describe('admin wallet credit', () => {
  it('sends the Idempotency-Key header and the same body on a resend', async () => {
    const { client, calls } = setup(() => json(200, { success: true, data: { balancePaise: 150_000 } }));
    const body = { pharmacyId: ID.toUpperCase(), amount: 500, notes: ' stage   testing ' };
    await adminPharmacyWalletApi(client).topup(body, KEY);
    await adminPharmacyWalletApi(client).topup(body, KEY);
    expect(calls[0]!.url).toBe('https://api.example.test/api/v1/pharmacy-wallet/topup');
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>)['Idempotency-Key']).toBe(KEY);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ pharmacyId: ID, amount: 500, notes: 'stage testing' });
    expect(calls[1]!.init.body).toBe(calls[0]!.init.body);
    expect((calls[1]!.init.headers as Record<string, string>)['Idempotency-Key']).toBe(KEY);
  });
  it('refuses a bad key, amount or pharmacy before sending', () => {
    const { client, calls } = setup(() => json(200, {}));
    const api = adminPharmacyWalletApi(client);
    expect(() => api.topup({ pharmacyId: ID, amount: 5, notes: 'x' }, 'bad key!')).toThrow();
    expect(() => api.topup({ pharmacyId: ID, amount: 5, notes: 'x' }, 'k'.repeat(101))).toThrow();
    expect(() => api.topup({ pharmacyId: ID, amount: 1.5, notes: 'x' }, KEY)).toThrow();
    expect(() => api.topup({ pharmacyId: ID, amount: 0, notes: 'x' }, KEY)).toThrow();
    expect(() => api.topup({ pharmacyId: 'x', amount: 5, notes: 'x' }, KEY)).toThrow();
    expect(calls).toHaveLength(0);
  });
  it('reads the wallet and history with ?pharmacyId (null when there is no wallet)', async () => {
    const { client, calls } = setup(() => json(200, { success: true, data: null }));
    await expect(adminPharmacyWalletApi(client).wallet(ID)).resolves.toBeNull();
    expect(calls[0]!.url).toBe(`https://api.example.test/api/v1/pharmacy-wallet?pharmacyId=${ID}`);
    await adminPharmacyWalletApi(client).movements(ID, 2);
    expect(calls[1]!.url).toBe(`https://api.example.test/api/v1/pharmacy-wallet/transactions?pharmacyId=${ID}&page=2&limit=20`);
  });
  it('checks the form: whole rupees from 1, a required note', () => {
    expect(adminTopupForm('500', 'stage testing')).toEqual({ value: { amount: 500, notes: 'stage testing' } });
    expect(adminTopupForm('1,000', ' support   credit ')).toEqual({ value: { amount: 1000, notes: 'support credit' } });
    expect(adminTopupForm('0', 'ok note').amount).toBeTruthy();
    expect(adminTopupForm('12.5', 'ok note').amount).toBeTruthy();
    expect(adminTopupForm('-5', 'ok note').amount).toBeTruthy();
    expect(adminTopupForm('200001', 'ok note').amount).toBe('At most ₹2,00,000 at one time.');
    expect(adminTopupForm('100', '').notes).toContain('stage testing');
    expect(adminTopupForm('100', 'ab').notes).toBeTruthy();
    expect(adminTopupForm('100', 'a'.repeat(501)).notes).toBe('Use at most 500 characters.');
  });
  const row = (o: Partial<WalletMovement>): WalletMovement => ({ _id: 'm', transactionType: 'credit', createdAt: '2026-11-22T10:00:00.000Z', ...o });
  it('finds a lost credit in the history by its key, with no time cut-off (an old row does not stop the search)', async () => {
    const pages: Page<WalletMovement>[] = [
      { items: [row({ _id: 'm1', referenceType: 'wallet_recharge', referenceId: KEY })], page: 1, limit: 1, total: 3, totalPages: 3 },
      { items: [row({ _id: 'm0', createdAt: '2020-01-01T00:00:00.000Z' })], page: 2, limit: 1, total: 3, totalPages: 3 },
      { items: [row({ _id: 'm2', referenceType: 'topup', referenceId: KEY, createdAt: '2020-01-01T00:00:00.000Z' })], page: 3, limit: 1, total: 3, totalPages: 3 },
    ];
    await expect(findAdminTopup(async (p) => pages[p - 1]!, KEY)).resolves.toMatchObject({ row: { _id: 'm2' } });
    expect(isAdminTopupRow(row({ referenceType: 'topup', referenceId: 'other' }), KEY)).toBe(false);
  });
  it('says whether the whole history was searched or only the latest movements (20 pages)', async () => {
    const full: Page<WalletMovement> = { items: Array.from({ length: 20 }, (_, i) => row({ _id: `x${i}` })), page: 1, limit: 20, total: 900, totalPages: 45 };
    const read: number[] = [];
    const r = await findAdminTopup(async (p) => { read.push(p); return full; }, KEY);
    expect(r).toEqual({ row: null, complete: false, searched: 400 });
    expect(read).toHaveLength(20);
    expect(topupNotFoundWords({ complete: false, searched: 400 }, false))
      .toBe('Only the latest 400 movements were searched; the credit may be older. Ask the tech team before adding money again.');
    const end = await findAdminTopup(async () => ({ items: [row({})], page: 1, limit: 20, total: 1, totalPages: 1 }), KEY);
    expect(end).toEqual({ row: null, complete: true, searched: 1 });
    expect(topupNotFoundWords({ complete: true, searched: 1 }, true)).toContain('Sending the same request again is safe');
  });
  it('the exact by-key read: used, none, or unavailable on an older server (then the history is searched)', async () => {
    const used = setup(() => json(200, { success: true, data: { state: 'credited', transaction: { _id: 'm9', referenceType: 'topup', referenceId: KEY }, wallet: null } }));
    await expect(adminPharmacyWalletApi(used.client).topupByKey(ID, KEY)).resolves.toMatchObject({ state: 'used', row: { _id: 'm9' } });
    expect(used.calls[0]!.url).toBe(`https://api.example.test/api/v1/pharmacy-wallet/topups/admin/by-key/${KEY}?pharmacyId=${ID}`);
    const none = setup(() => json(200, { success: true, data: { state: 'not_found' } }));
    await expect(adminPharmacyWalletApi(none.client).topupByKey(ID, KEY)).resolves.toEqual({ state: 'none' });
    const odd = setup(() => json(200, { success: true, data: { state: 'something else' } }));
    await expect(adminPharmacyWalletApi(odd.client).topupByKey(ID, KEY)).rejects.toBeInstanceOf(ApiError);
    const old = setup(() => json(404, { success: false, message: 'Route not found' }));
    await expect(adminPharmacyWalletApi(old.client).topupByKey(ID, KEY)).resolves.toEqual({ state: 'unavailable' });
    const denied = setup(() => json(403, { error: 403, code: 'FORBIDDEN', message: 'no' }));
    await expect(adminPharmacyWalletApi(denied.client).topupByKey(ID, KEY)).rejects.toBeInstanceOf(ApiError);
    await expect(adminPharmacyWalletApi(old.client).topupByKey(ID, 'bad key')).rejects.toThrow();
  });
  it('the newest admin credit for the review (two admins do not credit twice)', () => {
    expect(latestAdminCredit([row({ _id: 'a', referenceType: 'wallet_recharge' }), row({ _id: 'b', referenceType: 'topup', notes: 'support credit' }), row({ _id: 'c', referenceType: 'topup' })]))
      .toMatchObject({ _id: 'b' });
    expect(latestAdminCredit([row({ referenceType: 'booking' })])).toBeNull();
  });
  it('says the refusals plainly, and the S6 warning', () => {
    expect(adminTopupRefusal(err(409, 'IDEMPOTENCY_KEY_REUSED'))).toContain('already used with a different amount or note');
    expect(adminTopupRefusal(err(404, 'PHARMACY_NOT_FOUND'))).toBe('This pharmacy was not found. Nothing was added.');
    expect(adminTopupRefusal(err(403))).toBe('Only Jansetu admins can add money to a pharmacy wallet.');
    // Review L7: a failed read never says "nothing was added".
    expect(adminWalletReadError(err(404, 'PHARMACY_NOT_FOUND'))).toBe('This pharmacy was not found.');
    expect(adminWalletReadError(err(400, 'VALIDATION_ERROR'))).not.toContain('Nothing was added');
    expect(adminWalletReadError(err(500))).not.toContain('Nothing was added');
    expect(ADMIN_TOPUP_WARNING).toBe('Do not use this to make up for a card top-up that never arrived. Ask the tech team to run the top-up check instead, or the pharmacy could be paid twice.');
  });
});
