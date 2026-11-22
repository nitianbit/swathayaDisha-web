import { expect, test, type Page, type Route } from '@playwright/test';

// WQ13: a pharmacy changes the time of a consultation it booked (same doctor), corrects the name it typed for the
// patient, and the doctor card's next free time is one the list shows; an admin adds money to a pharmacy wallet with
// an Idempotency-Key. Against a mock of the backend's rules (assisted/pharmacyCommands `rescheduleByBooker`,
// pharmacyCustomers `setTypedName`, pharmacyWallet `topup` with an admin token).
const ME = 'b'.repeat(24);
const ADMIN = 'ad'.repeat(12);
const DOC = 'd1'.repeat(12);
const USER = 'c2'.repeat(12);
const DEP = 'f1'.repeat(12);
const BOOKED = 'e1'.repeat(12);
const FAMILY = 'e2'.repeat(12);
const SLOT1 = '51'.repeat(12);
const SLOT2 = '52'.repeat(12);
const SLOT3 = '53'.repeat(12);
const SLOT4 = '54'.repeat(12);
const SLOT5 = '55'.repeat(12);
const LINK = 'c3'.repeat(12);
const P1 = 'a1'.repeat(12);
const P2 = 'a2'.repeat(12);
const PHONE = '9876543210';

type Json = Record<string, unknown>;
const istYmd = (ms: number) => new Date(ms + 330 * 60_000).toISOString().slice(0, 10).replace(/-/g, '');
const TOMORROW = istYmd(Date.now() + 86_400_000);
const fmtDay = (ymd: string) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
  .format(new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)))));

const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const refuse = (route: Route, status: number, code: string, message = 'refused') => json(route, status, { error: status, code, message });

// ── Pharmacy ──

interface PharmacyBackend {
  bookings: Json[];
  moves: { id: string; body: Json }[];
  /** reschedule keys → the slot they moved to (the server's `assisted.reschedules`). */
  moveKeys: Record<string, string>;
  /** Apply the next move, then drop its answer. */
  loseNextMoveAnswer: boolean;
  refuseNextMove: { status: number; code: string } | null;
  names: Json[];
  /** The `:id` each typed-name edit was sent to. */
  nameIds: string[];
  typed: Record<string, string>;
  loseNextNameAnswer: boolean;
  /** r6 `shownName`: the patient linked this pharmacy by ordering (`customer_order`), so the account name shows. */
  accountNameShown: string | null;
  slotReads: URL[];
  /** The doctor list's next slot is chat-only. */
  chatOnlyNext: boolean;
  bump: () => void;
}

const row = (o: Json = {}): Json => ({
  _id: BOOKED, status: 'confirmed', paymentStatus: 'paid', source: 'pharmacy_assisted', bookingDate: TOMORROW, bookingTime: '10:30', slotId: SLOT1,
  doctorName: 'Dr Meera Rao', specialistId: DOC, userId: USER, dependentId: null, patientName: 'Rina K.', contactNo: PHONE, consultationMode: 'video', price: 500,
  updatedAt: '2026-11-22T05:00:00.000Z', createdAt: '2026-11-22T05:00:00.000Z',
  assisted: { shortRef: 'K7QXM2PA', join: { on: 'partner_device' }, preferredLanguage: 'hi', bookedBy: { name: 'Asha Medicals' } }, ...o,
});

const SLOTS: Json[] = [
  { slotId: SLOT1, date: TOMORROW, startTime: '10:30', endTime: '10:45', modes: ['video', 'call'] }, // the booking's own time
  { slotId: SLOT2, date: TOMORROW, startTime: '11:00', endTime: '11:15', modes: ['in-person'] }, // another mode
  { slotId: SLOT3, date: TOMORROW, startTime: '11:30', endTime: '11:45', modes: ['video', 'call'] },
  { slotId: SLOT4, date: TOMORROW, startTime: '12:00', endTime: '12:15', modes: ['chat'] }, // the booking cannot use chat
  { slotId: SLOT5, date: TOMORROW, startTime: '12:30', endTime: '12:45', modes: ['video'] },
].map((s) => ({ ...s, startsAt: '2026-11-23T05:00:00.000Z' }));

async function mockPharmacy(page: Page, bookings: Json[] = [row()]): Promise<PharmacyBackend> {
  let seq = 0;
  const b: PharmacyBackend = {
    bookings, moves: [], moveKeys: {}, loseNextMoveAnswer: false, refuseNextMove: null, names: [], nameIds: [], typed: {}, loseNextNameAnswer: false, accountNameShown: null, slotReads: [],
    chatOnlyNext: false,
    bump: () => { b.bookings[0]!.updatedAt = new Date(Date.UTC(2026, 10, 22, 6, 0, 0, ++seq)).toISOString(); },
  };
  let live = false;
  const holderName = (x: Json) => b.accountNameShown ?? b.typed[String(x.userId)];
  const view = (x: Json): Json => ({
    ...x, patientName: x.dependentId ? x.patientName : holderName(x) ?? x.patientName,
    ...(x.holder ? { holder: { ...(x.holder as Json), name: holderName(x) ?? (x.holder as Json).name } } : {}),
  });
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = req.method();
    const body = method === 'POST' || method === 'PUT' ? (req.postDataJSON() as Json | null) : null;
    if (path === '/auth/pharmacy/send') return json(route, 200, { success: true });
    if (path === '/auth/pharmacy/verify') { live = true; return json(route, 200, { success: true, data: { token: 't1', expiresIn: 900, user: {} } }); }
    if (path === '/auth/session/refresh') {
      return live ? json(route, 200, { success: true, data: { token: 't1', expiresIn: 900, principal: { userId: ME, userType: 'pharmacy', sid: 's1' } } })
        : refuse(route, 401, 'SESSION_ENDED', 'Please sign in again');
    }
    if (path.startsWith('/auth/session')) return json(route, 200, { success: true, data: {} });
    if (req.headers().authorization !== 'Bearer t1') return refuse(route, 401, 'UNAUTHORIZED', 'Authentication is required');
    if (path === '/auth/profile') return json(route, 200, { success: true, data: { user: { _id: ME, name: 'Asha Medicals' }, userRole: 'pharmacy' } });

    if (path === '/pharmacy-assisted/patients/lookup') return json(route, 200, { success: true, data: { exists: true, holderNameMasked: 'Rina K.' } });
    if (path === '/pharmacy-assisted/doctors') {
      const next = b.chatOnlyNext ? SLOTS[3] : SLOTS[0];
      return json(route, 200, { success: true, data: [{ doctorId: DOC, name: 'Dr Meera Rao', specialization: 'General Physician', languages: ['Hindi'], city: 'Pune',
        experienceYears: 8, feeMinor: 50_000, nearby: 'pincode', nextSlot: next }] });
    }
    const slots = /^\/pharmacy-assisted\/doctors\/(\w{24})\/slots$/.exec(path);
    if (slots) {
      b.slotReads.push(url);
      if (slots[1] !== DOC) return refuse(route, 404, 'DOCTOR_NOT_FOUND', 'Doctor not found');
      return json(route, 200, { success: true, data: { doctor: { doctorId: DOC, name: 'Dr Meera Rao', languages: [], city: 'Pune', experienceYears: 8, feeMinor: 50_000 },
        from: TOMORROW, to: TOMORROW, slots: SLOTS } });
    }
    const move = /^\/pharmacy-assisted\/bookings\/(\w{24})\/reschedule$/.exec(path);
    if (move && method === 'POST') {
      b.moves.push({ id: move[1]!, body: body! });
      const x = b.bookings.find((r) => r._id === move[1]);
      if (!x) return refuse(route, 404, 'BOOKING_NOT_FOUND', 'Booking not found');
      const key = String(body!.requestKey);
      // The replay is checked first (before the version fence), as `rescheduleByBooker` does.
      if (b.moveKeys[key]) {
        if (b.moveKeys[key] !== body!.slotId) return refuse(route, 409, 'IDEMPOTENCY_KEY_REUSED');
        return json(route, 200, { success: true, data: { booking: view(x), replayed: true } });
      }
      if (b.refuseNextMove) { const r = b.refuseNextMove; b.refuseNextMove = null; return refuse(route, r.status, r.code); }
      if (body!.expectedUpdatedAt !== x.updatedAt) return refuse(route, 409, 'BOOKING_CHANGED');
      const to = SLOTS.find((s) => s.slotId === body!.slotId);
      if (!to) return refuse(route, 409, 'SLOT_NOT_AVAILABLE');
      Object.assign(x, { slotId: to.slotId, bookingDate: to.date, bookingTime: to.startTime });
      b.moveKeys[key] = String(to.slotId);
      b.bump();
      if (b.loseNextMoveAnswer) { b.loseNextMoveAnswer = false; return route.abort('connectionreset'); }
      return json(route, 200, { success: true, data: { booking: view(x), replayed: false } });
    }
    const name = /^\/pharmacy-customers\/(\w{24})\/typed-name$/.exec(path);
    if (name && method === 'PUT') {
      b.names.push(body!);
      b.nameIds.push(name[1]!);
      // The link id (r6 `holder.pharmacyCustomerId`) or the holder's user id.
      if (name[1] !== USER && name[1] !== LINK) return refuse(route, 404, 'CUSTOMER_NOT_LINKED', 'This user is not linked to your pharmacy');
      b.typed[USER] = String(body!.typedName);
      if (b.loseNextNameAnswer) { b.loseNextNameAnswer = false; return route.abort('connectionreset'); }
      const r6 = name[1] === LINK;
      return json(route, 200, { success: true, data: { _id: LINK, userId: USER, typedName: body!.typedName,
        ...(r6 ? { shownName: b.accountNameShown ?? body!.typedName } : {}) } });
    }
    if (path === '/pharmacy-bookings') return json(route, 200, { success: true, data: b.bookings.map(view), pagination: { total: b.bookings.length, nextCursor: null } });
    const one = /^\/pharmacy-bookings\/(\w{24})$/.exec(path);
    if (one) {
      const x = b.bookings.find((r) => r._id === one[1]);
      return x ? json(route, 200, { success: true, data: view(x) }) : refuse(route, 404, 'BOOKING_NOT_FOUND', 'Booking not found');
    }
    if (path === '/pharmacy-wallet') return json(route, 200, { success: true, data: { balancePaise: 200_000, isActive: true, frozen: false, receivableMinor: 0 } });
    return refuse(route, 404, 'NOT_MOCKED', `Not mocked: ${method} ${path}`);
  });
  return b;
}

async function signInPharmacy(page: Page, to: string) {
  await page.goto('/');
  await page.getByLabel('Mobile number').fill('9000000001');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await page.getByRole('link', { name: to, exact: true }).first().click();
}

async function openBooking(page: Page, who = 'Rina K.') {
  await signInPharmacy(page, 'Booked consultations');
  await page.getByRole('link', { name: new RegExp(`Open the consultation of ${who.replace('.', '\\.')}`) }).click();
  await expect(page.getByRole('heading', { name: 'Consultation', exact: true })).toBeVisible();
}

const nothingStored = async (page: Page, ...words: string[]) => {
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + location.href);
  for (const w of words) expect(stored).not.toContain(w);
};

test('the doctor card never shows a next free time the list hides (a chat-only next time)', async ({ page }) => {
  const b = await mockPharmacy(page);
  b.chatOnlyNext = true;
  await signInPharmacy(page, 'Book consultation');
  await page.getByLabel('Patient’s mobile number').fill(PHONE);
  await page.getByRole('button', { name: 'Find' }).click();
  await page.getByLabel('Patient’s full name').fill('Rina Kumari');
  await page.getByLabel('Patient agreed to this booking').check();
  await page.getByRole('button', { name: 'Next: choose the doctor' }).click();
  await expect(page.getByRole('heading', { name: 'Dr Meera Rao' })).toBeVisible();
  await expect(page.getByText('Choose to see the free times')).toBeVisible();
  await expect(page.getByText(/Next free time/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Choose Dr Meera Rao' }).click();
  await expect(page.getByRole('button', { name: /^12:00/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '11:30–11:45' })).toBeVisible();
});

test('change time: the rule, the doctor’s other times in the same mode, a review, then the move', async ({ page }) => {
  const b = await mockPharmacy(page);
  await openBooking(page);
  await expect(page.getByText('You can move this consultation to another free time of the same doctor, any time before it starts.')).toBeVisible();
  await expect(page.getByText('It stays a video call.')).toBeVisible();
  await page.getByRole('button', { name: 'Change time' }).click();
  // The booking's own time, another mode's time and a chat time are not offered.
  await expect(page.getByRole('button', { name: '11:30–11:45' })).toBeVisible();
  await expect(page.getByRole('button', { name: '12:30–12:45' })).toBeVisible();
  for (const t of [/^10:30/, /^11:00/, /^12:00/]) await expect(page.getByRole('group', { name: 'Choose the new time' }).getByRole('button', { name: t })).toHaveCount(0);
  expect(b.slotReads[0]!.searchParams.get('mode')).toBe('video');
  expect(b.slotReads[0]!.searchParams.get('days')).toBe('7');
  await page.getByRole('button', { name: 'Next: check the new time' }).click();
  await expect(page.getByText('Choose the new time first.')).toBeVisible();
  await page.getByRole('button', { name: '11:30–11:45' }).click();
  await page.getByRole('button', { name: 'Next: check the new time' }).click();
  const review = page.getByRole('group', { name: 'Move this consultation' });
  await expect(review.getByText(`${fmtDay(TOMORROW)} at 10:30`)).toBeVisible();
  await expect(review.getByText(`${fmtDay(TOMORROW)} at 11:30`)).toBeVisible();
  await review.getByRole('button', { name: 'Yes, move it' }).click();
  await expect(page.getByText(`Moved to ${fmtDay(TOMORROW)} at 11:30. The patient and the doctor are told the new time.`)).toBeVisible();
  await expect(page.getByText(`${fmtDay(TOMORROW)} at 11:30`).first()).toBeVisible();
  expect(b.moves).toHaveLength(1);
  expect(b.moves[0]!.body).toEqual({ slotId: SLOT3, requestKey: expect.stringMatching(/^[A-Za-z0-9_-]{8,100}$/), expectedUpdatedAt: '2026-11-22T05:00:00.000Z' });
});

test('change time: a lost answer is sent again with the same key and slot, and moves it once', async ({ page }) => {
  const b = await mockPharmacy(page);
  await openBooking(page);
  await page.getByRole('button', { name: 'Change time' }).click();
  await page.getByRole('button', { name: '12:30–12:45' }).click();
  await page.getByRole('button', { name: 'Next: check the new time' }).click();
  b.loseNextMoveAnswer = true;
  await page.getByRole('button', { name: 'Yes, move it' }).click();
  await expect(page.getByText(/The outcome of this request is not known yet/)).toBeVisible();
  await page.getByRole('button', { name: 'Send the same request again' }).click();
  await expect(page.getByText(`It was already moved to ${fmtDay(TOMORROW)} at 12:30. Nothing was changed twice.`)).toBeVisible();
  expect(b.moves).toHaveLength(2);
  expect(b.moves[1]!.body).toEqual(b.moves[0]!.body);
  expect(Object.keys(b.moveKeys)).toHaveLength(1);
});

test('change time: a lost answer can be checked by reading the booking again', async ({ page }) => {
  const b = await mockPharmacy(page);
  await openBooking(page);
  await page.getByRole('button', { name: 'Change time' }).click();
  await page.getByRole('button', { name: '11:30–11:45' }).click();
  await page.getByRole('button', { name: 'Next: check the new time' }).click();
  b.loseNextMoveAnswer = true;
  await page.getByRole('button', { name: 'Yes, move it' }).click();
  await page.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(page.getByText(`Moved to ${fmtDay(TOMORROW)} at 11:30.`)).toBeVisible();
  expect(b.moves).toHaveLength(1);
});

test('change time refusals in plain words: slot taken, booking changed, too late', async ({ page }) => {
  const b = await mockPharmacy(page);
  await openBooking(page);
  await page.getByRole('button', { name: 'Change time' }).click();
  await page.getByRole('button', { name: '11:30–11:45' }).click();
  await page.getByRole('button', { name: 'Next: check the new time' }).click();
  b.refuseNextMove = { status: 409, code: 'SLOT_NOT_AVAILABLE' };
  await page.getByRole('button', { name: 'Yes, move it' }).click();
  await expect(page.getByText('This time was just taken, or is no longer free. Choose another time.')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Move this consultation' })).toHaveCount(0);

  // Someone changed the booking on another device: the page reads it again and the next try sends the new version.
  b.bump();
  const fresh = String(b.bookings[0]!.updatedAt);
  await page.getByRole('button', { name: '12:30–12:45' }).click();
  await page.getByRole('button', { name: 'Next: check the new time' }).click();
  await page.getByRole('button', { name: 'Yes, move it' }).click();
  await expect(page.getByText('This booking changed since you opened it (perhaps on another device).')).toBeVisible();
  await expect.poll(() => b.moves.length).toBe(2);
  await page.getByRole('button', { name: '12:30–12:45' }).click();
  await page.getByRole('button', { name: 'Next: check the new time' }).click();
  b.refuseNextMove = { status: 400, code: 'BOOKING_ALREADY_STARTED' };
  await page.getByRole('button', { name: 'Yes, move it' }).click();
  await expect(page.getByText('Too late: the consultation has already started, so its time can no longer be changed.')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Choose the new time' })).toHaveCount(0);
  expect(b.moves[2]!.body.expectedUpdatedAt).toBe(fresh);
  expect(b.moves.map((m) => m.body.requestKey)).toHaveLength(new Set(b.moves.map((m) => m.body.requestKey)).size);
});

test('correct the name: only this pharmacy’s name for the patient changes; a family member’s name cannot', async ({ page }) => {
  const b = await mockPharmacy(page, [row(), row({ _id: FAMILY, userId: USER, dependentId: DEP, patientName: 'Asha Devi' })]);
  await openBooking(page);
  await page.getByRole('button', { name: 'Correct the name' }).click();
  await expect(page.getByText('This changes only the name your pharmacy sees for this patient. It never changes the patient’s own Jansetu account.')).toBeVisible();
  const field = page.getByLabel('Patient’s name as your pharmacy writes it');
  await expect(field).toHaveValue('Rina K.');
  await field.fill('   ');
  await page.getByRole('button', { name: 'Save the name' }).click();
  await expect(page.getByText('Type the patient’s name.')).toBeVisible();
  expect(b.names).toHaveLength(0);
  await field.fill('  Rina   Kumari ');
  await page.getByRole('button', { name: 'Save the name' }).click();
  await expect(page.getByText('Saved. Your pharmacy now sees this patient as “Rina Kumari”.')).toBeVisible();
  await expect(page.getByRole('definition').filter({ hasText: /^Rina Kumari$/ })).toBeVisible();
  expect(b.names).toEqual([{ typedName: 'Rina Kumari' }]);
  expect(b.nameIds).toEqual([USER]); // q16: no `holder` block, so the holder's user id
  await nothingStored(page, 'Rina Kumari', PHONE);

  await page.getByRole('link', { name: 'Booked consultations' }).first().click();
  await page.getByRole('link', { name: /Open the consultation of Asha Devi/ }).click();
  await expect(page.getByText('only the patient can change this name, in their Jansetu app')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Correct the name' })).toHaveCount(0);
});

test('correct the name: a lost answer is sent again with the same name', async ({ page }) => {
  const b = await mockPharmacy(page);
  await openBooking(page);
  await page.getByRole('button', { name: 'Correct the name' }).click();
  await page.getByLabel('Patient’s name as your pharmacy writes it').fill('Rina Kumari');
  b.loseNextNameAnswer = true;
  await page.getByRole('button', { name: 'Save the name' }).click();
  await expect(page.getByText(/The outcome of this request is not known yet/)).toBeVisible();
  await page.getByRole('button', { name: 'Send the same name again' }).click();
  await expect(page.getByText('Saved. Your pharmacy now sees this patient as “Rina Kumari”.')).toBeVisible();
  expect(b.names).toEqual([{ typedName: 'Rina Kumari' }, { typedName: 'Rina Kumari' }]);
});

test('r6: the holder’s link id from the booking is used; a customer-linked patient keeps the account name; a family booking corrects the phone owner', async ({ page }) => {
  const holder = { pharmacyCustomerId: LINK, name: 'Rina K.' };
  const b = await mockPharmacy(page, [
    row({ holder }),
    row({ _id: FAMILY, dependentId: DEP, patientName: 'Asha Devi', holder }),
    row({ _id: 'e3'.repeat(12), patientName: 'Mohan', userId: 'c4'.repeat(12), holder: { pharmacyCustomerId: null, name: 'Mohan' } }),
  ]);
  await openBooking(page);
  b.accountNameShown = 'Rina Kumari Sharma';
  await page.getByRole('button', { name: 'Correct the name' }).click();
  await page.getByLabel('Patient’s name as your pharmacy writes it').fill('Rina Kumari');
  await page.getByRole('button', { name: 'Save the name' }).click();
  await expect(page.getByText('Saved as “Rina Kumari”. This patient chose your pharmacy themselves, so your pharmacy is shown the name on their own account (“Rina Kumari Sharma”).')).toBeVisible();
  expect(b.names).toEqual([{ typedName: 'Rina Kumari' }]);
  b.accountNameShown = null;

  await page.getByRole('link', { name: 'Booked consultations' }).first().click();
  await page.getByRole('link', { name: /Open the consultation of Asha Devi/ }).click();
  await expect(page.getByRole('heading', { name: 'Name of the phone’s owner' })).toBeVisible();
  await page.getByRole('button', { name: 'Correct the name of the phone’s owner' }).click();
  await expect(page.getByText('The family member’s name stays as it is.')).toBeVisible();
  await page.getByLabel('Name of the phone’s owner, as your pharmacy writes it').fill('Rina Devi');
  await page.getByRole('button', { name: 'Save the name' }).click();
  await expect(page.getByText('Saved. Your pharmacy now sees the phone’s owner as “Rina Devi”.')).toBeVisible();
  await expect(page.getByRole('definition').filter({ hasText: /^Asha Devi/ })).toBeVisible();

  await page.getByRole('link', { name: 'Booked consultations' }).first().click();
  await page.getByRole('link', { name: /Open the consultation of Mohan/ }).click();
  await expect(page.getByRole('heading', { name: 'Change time' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Correct the/ })).toHaveCount(0);
  expect(b.names).toHaveLength(2);
  expect(b.nameIds).toEqual([LINK, LINK]);
});

// ── Admin ──

interface AdminBackend {
  calls: { method: string; path: string; body: Json | null; key?: string }[];
  walletPaise: number;
  receivableMinor: number;
  movements: Json[];
  /** Idempotency keys → the body they credited. */
  credits: Record<string, string>;
  loseNextTopupAnswer: boolean;
  /** The wallet of P2 does not exist yet. */
  noWalletFor: string | null;
}

async function mockAdmin(page: Page, init: Partial<Pick<AdminBackend, 'receivableMinor'>> = {}): Promise<AdminBackend> {
  const b: AdminBackend = {
    calls: [], walletPaise: 120_000, receivableMinor: init.receivableMinor ?? 0, credits: {}, loseNextTopupAnswer: false, noWalletFor: P2,
    movements: [
      { _id: 'm1', transactionType: 'debit', movementType: 'booking_debit', signedAmountPaise: -50_000, amountPaise: 50_000, balanceAfterPaise: 120_000, createdAt: '2026-11-21T10:00:00.000Z', status: 'completed' },
    ],
  };
  let live = false;
  const pharmacies = [
    { _id: P1, name: 'Asha Medicals', phone: '9000000001', city: 'Pune', isVerified: true, isActive: true },
    { _id: P2, name: 'Care Chemist', phone: '9000000002', city: 'Mumbai', isVerified: true, isActive: true },
  ];
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = req.method();
    const body = method === 'POST' || method === 'PUT' ? (req.postDataJSON() as Json | null) : null;
    if (path === '/auth/session/refresh') {
      return live ? json(route, 200, { success: true, data: { token: 'admin', expiresIn: 900, principal: { userId: ADMIN, userType: 'admin', sid: 's1' } } })
        : refuse(route, 401, 'SESSION_ENDED', 'Please sign in again');
    }
    if (path.startsWith('/auth/session')) return json(route, 200, { success: true, data: {} });
    b.calls.push({ method, path: `${path}${url.search}`, body, key: req.headers()['idempotency-key'] });
    if (path === '/auth/admin/send') return json(route, 200, { success: true });
    if (path === '/auth/admin/verify') { live = true; return json(route, 200, { success: true, data: { token: 'admin', expiresIn: 900, user: {} } }); }
    if (req.headers().authorization !== 'Bearer admin') return refuse(route, 401, 'UNAUTHORIZED', 'Authentication is required');
    if (path === '/auth/profile') return json(route, 200, { success: true, data: { user: { _id: ADMIN, name: 'Ops Admin' }, userRole: 'admin' } });
    if (path === '/pharmacies' && method === 'GET') {
      const name = (url.searchParams.get('name') ?? '').toLowerCase();
      const rows = pharmacies.filter((p) => !name || p.name.toLowerCase().includes(name));
      return json(route, 200, { success: true, data: rows, pagination: { page: 1, limit: 20, total: rows.length, totalPages: 1 } });
    }
    const one = /^\/pharmacies\/(\w{24})$/.exec(path);
    if (one) {
      const p = pharmacies.find((x) => x._id === one[1]);
      return p ? json(route, 200, { success: true, data: p }) : refuse(route, 404, 'PHARMACY_NOT_FOUND', 'Pharmacy not found');
    }
    const pid = url.searchParams.get('pharmacyId');
    const wallet = () => ({ _id: 'w1', pharmacyId: P1, balance: b.walletPaise / 100, balancePaise: b.walletPaise, isActive: true, frozen: false, receivableMinor: b.receivableMinor });
    if (path === '/pharmacy-wallet' && method === 'GET') {
      if (!pid) return refuse(route, 400, 'PHARMACY_ID_REQUIRED');
      return json(route, 200, { success: true, data: pid === b.noWalletFor ? null : wallet() });
    }
    if (path === '/pharmacy-wallet/transactions') {
      if (!pid) return refuse(route, 400, 'PHARMACY_ID_REQUIRED');
      const rows = pid === P1 ? b.movements : [];
      return json(route, 200, { success: true, data: rows, pagination: { page: 1, limit: 20, total: rows.length, totalPages: 1 } });
    }
    if (path === '/pharmacy-wallet/topup' && method === 'POST') {
      const key = req.headers()['idempotency-key'];
      if (!key) return refuse(route, 400, 'IDEMPOTENCY_KEY_REQUIRED');
      const hash = JSON.stringify({ amount: body!.amount, notes: body!.notes ?? null });
      if (b.credits[key]) {
        if (b.credits[key] !== hash) return refuse(route, 409, 'IDEMPOTENCY_KEY_REUSED');
        return json(route, 200, { success: true, message: 'Wallet topped up', data: wallet() });
      }
      const paise = Math.round(Number(body!.amount) * 100);
      const setoff = Math.min(paise, b.receivableMinor);
      b.receivableMinor -= setoff;
      b.walletPaise += paise - setoff;
      b.credits[key] = hash;
      b.movements.unshift({ _id: `m${b.movements.length + 1}`, transactionType: 'credit', movementType: 'credit', signedAmountPaise: paise, amountPaise: paise,
        balanceAfterPaise: b.walletPaise, referenceType: 'topup', referenceId: key, notes: body!.notes, description: 'Admin top-up', createdAt: new Date().toISOString(), status: 'completed' });
      if (b.loseNextTopupAnswer) { b.loseNextTopupAnswer = false; return route.abort('connectionreset'); }
      return json(route, 200, { success: true, message: 'Wallet topped up', data: wallet() });
    }
    return refuse(route, 404, 'NOT_MOCKED', `Not mocked: ${method} ${path}`);
  });
  return b;
}

async function openAdminWallet(page: Page, pharmacy = 'Asha Medicals') {
  await page.goto('/');
  await page.getByLabel('Admin').check();
  await page.getByLabel('Mobile number').fill('9876543210');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Pharmacy wallets' }).click();
  await expect(page.getByRole('heading', { name: 'Pharmacy wallets' })).toBeVisible();
  await page.getByLabel('Find a pharmacy by name').fill(pharmacy.split(' ')[0]!);
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('link', { name: `Open the wallet of ${pharmacy}` }).click();
  await expect(page.getByRole('heading', { name: `Wallet: ${pharmacy}` })).toBeVisible();
}

const topups = (b: AdminBackend) => b.calls.filter((c) => c.method === 'POST' && c.path === '/pharmacy-wallet/topup');
const S6 = 'Do not use this to make up for a card top-up that never arrived. Ask the tech team to run the top-up check instead, or the pharmacy could be paid twice.';

test('admin: find a pharmacy, read its wallet, add money with a note and a review (Idempotency-Key header)', async ({ page }) => {
  const b = await mockAdmin(page);
  await openAdminWallet(page);
  await expect(page.getByText('₹1,200.00').first()).toBeVisible();
  await expect(page.getByText('Can pay for bookings')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Wallet history, newest first' }).getByText('Paid for a consultation booking')).toBeVisible();
  await expect(page.getByText(S6).first()).toBeVisible();

  await page.getByRole('button', { name: 'Next: check before adding' }).click();
  await expect(page.getByText('Enter a whole number of rupees, 1 or more (for example 500).')).toBeVisible();
  await expect(page.getByText('Write why the money is added, for example “stage testing” or “support credit”.')).toBeVisible();
  await page.getByLabel('Amount to add (₹)').fill('12.50');
  await page.getByLabel('Why is the money added?').fill('stage testing');
  await page.getByRole('button', { name: 'Next: check before adding' }).click();
  await expect(page.getByText('Enter a whole number of rupees, 1 or more (for example 500).')).toBeVisible();
  await page.getByLabel('Amount to add (₹)').fill('500');
  await page.getByRole('button', { name: 'Next: check before adding' }).click();
  const review = page.getByRole('group', { name: 'Add this money' });
  await expect(review.getByText('Balance after: ₹1,700.00')).toBeVisible();
  await expect(review.getByText(S6)).toBeVisible();
  expect(topups(b)).toHaveLength(0);
  await review.getByRole('button', { name: 'Yes, add ₹500.00' }).click();
  await expect(page.getByText('₹500.00 was added to the wallet of Asha Medicals. Balance now: ₹1,700.00.')).toBeVisible();
  const history = page.getByRole('table', { name: 'Wallet history, newest first' });
  await expect(history.getByText('Money added by Jansetu')).toBeVisible();
  await expect(history.getByRole('cell', { name: 'stage testing' })).toBeVisible();

  const sent = topups(b);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.body).toEqual({ pharmacyId: P1, amount: 500, notes: 'stage testing' });
  expect(sent[0]!.key).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
  expect(b.walletPaise).toBe(170_000);
});

test('admin: a lost answer is sent again with the same key and body, and the money is added once', async ({ page }) => {
  const b = await mockAdmin(page);
  await openAdminWallet(page);
  await page.getByLabel('Amount to add (₹)').fill('300');
  await page.getByLabel('Why is the money added?').fill('support credit');
  await page.getByRole('button', { name: 'Next: check before adding' }).click();
  b.loseNextTopupAnswer = true;
  await page.getByRole('button', { name: 'Yes, add ₹300.00' }).click();
  await expect(page.getByText(/The outcome of this request is not known yet/)).toBeVisible();
  await expect(page.getByText(/₹300.00 may already be added to the wallet of Asha Medicals/)).toBeVisible();
  await page.getByRole('button', { name: 'Send the same request again' }).click();
  await expect(page.getByText(/₹300.00 was added to the wallet of Asha Medicals.*It was added once, even though it was sent more than once\./)).toBeVisible();
  const sent = topups(b);
  expect(sent).toHaveLength(2);
  expect(sent[1]!.key).toBe(sent[0]!.key);
  expect(sent[1]!.body).toEqual(sent[0]!.body);
  expect(b.walletPaise).toBe(150_000);
});

test('admin: a lost answer is found in the history by its key; a reload keeps it to check', async ({ page }) => {
  const b = await mockAdmin(page);
  await openAdminWallet(page);
  await page.getByLabel('Amount to add (₹)').fill('250');
  await page.getByLabel('Why is the money added?').fill('stage testing');
  await page.getByRole('button', { name: 'Next: check before adding' }).click();
  b.loseNextTopupAnswer = true;
  await page.getByRole('button', { name: 'Yes, add ₹250.00' }).click();
  await expect(page.getByText(/The outcome of this request is not known yet/)).toBeVisible();
  await page.reload();
  await expect(page.getByText(/Money added earlier on this device \(before the page was reloaded\) was not confirmed/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send the same request again' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(page.getByText(/It was added: ₹250.00 on .*Nothing was added twice\./)).toBeVisible();
  expect(topups(b)).toHaveLength(1);
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(stored).not.toContain('admin"');
  expect(stored).not.toContain('stage testing');
});

test('admin: a wallet that owes Jansetu says the credit clears it first; a pharmacy without a wallet says so', async ({ page }) => {
  const b = await mockAdmin(page, { receivableMinor: 20_000 });
  await openAdminWallet(page);
  await expect(page.getByText('The wallet owes ₹200.00 to Jansetu after a disputed card payment.')).toBeVisible();
  await page.getByLabel('Amount to add (₹)').fill('100');
  await page.getByLabel('Why is the money added?').fill('support credit');
  await page.getByRole('button', { name: 'Next: check before adding' }).click();
  await expect(page.getByText('₹100.00 of it first clears what the pharmacy owes Jansetu.')).toBeVisible();
  await page.getByRole('button', { name: 'Back' }).click();

  await page.getByRole('link', { name: 'Pharmacy wallets' }).first().click();
  await page.getByLabel('Find a pharmacy by name').fill('Care');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('link', { name: 'Open the wallet of Care Chemist' }).click();
  await expect(page.getByText('This pharmacy has no wallet yet.')).toBeVisible();
  await expect(page.getByText('No money in or out yet')).toBeVisible();
  expect(b.calls.some((c) => c.path === `/pharmacy-wallet?pharmacyId=${P2}`)).toBe(true);
});
