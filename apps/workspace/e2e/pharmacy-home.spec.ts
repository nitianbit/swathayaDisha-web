import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * WQ54 (P1, SIMPLE_DESIGN_PLAN_2026-11-26 example 1) / WQ54b: the simple pharmacy home against a mocked API (backend r37c's
 * shapes: `GET /pharmacy-assisted/today?order=desc`, `POST /pharmacy-assisted/today/search`, `/pharmacy-assisted/todos`):
 * four big buttons, the day's money, what is waiting, the register (newest first), the pharmacy's to-dos; + New (the patient
 * once, by phone or name, and WQ54c who they are: the number's owner or a family member; then what: the existing flows
 * opened with that patient, handed over once); Today. On a desktop, a tablet held sideways, and a 390 px phone (Home and
 * "More" as icon buttons in its header).
 */
const PH = 'aa'.repeat(12);
const ASHA = 'c2'.repeat(12);
const REQ = 'e1'.repeat(12);
const DOC = 'd1'.repeat(12);
const PARA = 'a1'.repeat(12);
const PHONE = '9876543210';
const NOW = new Date('2026-11-26T04:35:00.000Z'); // 10:05 in India
const LATER = new Date(NOW.getTime() + 4 * 60_000).toISOString();
const DAY = '2026-11-26';
const ASHA_ROW = { _id: 'd9'.repeat(12), userId: { _id: ASHA, name: 'Asha Verma', phone: PHONE }, typedName: 'Asha Verma' };
/** A register row as r37c sends it (made today, not an earlier day's payment). */
const row = (r: Json): Json => ({ shortRef: null, patientName: null, paid: false, method: null, status: 'placed', madeOn: DAY, paidToday: false, ...r });

type Json = Record<string, unknown>;
interface Backend {
  calls: { method: string; path: string; body: Json | null }[];
  register: Json[];
  todos: Json[];
  todoKeys: Record<string, string>;
  orders: Json[];
  request: Json | null;
  /** r37b: more pending queues (null = the server could not read it). */
  pendingExtra: Json;
  /** `POST /pharmacy-customers/search` rows. */
  customers: Json[];
  /** `POST /pharmacy-assisted/patients/lookup`. */
  lookup: Json;
  /** A server before r37c: oldest first whatever `order` asks. */
  oldestFirstOnly: boolean;
  /** Today reads fail as if offline (no answer) while this is set. */
  offline: boolean;
  /** The next to-do add fails as if offline (nothing recorded). */
  todoOfflineOnce: boolean;
}

async function mockBackend(page: Page): Promise<Backend> {
  await page.clock.setFixedTime(NOW);
  const b: Backend = { calls: [], register: [], todos: [], todoKeys: {}, orders: [], offline: false, todoOfflineOnce: false, request: null, pendingExtra: {},
    customers: [], lookup: { exists: false, holderNameMasked: null }, oldestFirstOnly: false };
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const ok = (route: Route, data: unknown, status = 200, extra: Json = {}) => json(route, status, { success: true, data, ...extra });
  const refuse = (route: Route, status: number, code: string) => json(route, status, { error: status, code, message: code });
  let live = false;
  const base = '/pharmacy-assisted/instant';
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = req.method();
    const body = ['POST', 'PATCH', 'PUT'].includes(method) ? (req.postDataJSON() as Json | null) : null;
    if (path === '/auth/session/refresh') return live ? ok(route, { token: 'tp', expiresIn: 900, principal: { userId: PH, userType: 'pharmacy', sid: 's1' } }) : refuse(route, 401, 'SESSION_ENDED');
    if (path.startsWith('/auth/session')) return ok(route, {});
    b.calls.push({ method, path: `${path}${url.search}`, body });
    if (path === '/auth/pharmacy/send') return ok(route, undefined);
    if (path === '/auth/pharmacy/verify') { live = true; return ok(route, { token: 'tp', expiresIn: 900, user: {} }); }
    if (req.headers().authorization !== 'Bearer tp') return refuse(route, 401, 'UNAUTHORIZED');
    if (path === '/auth/profile') return ok(route, { user: { _id: PH, name: 'Demo Pharmacy' }, userRole: 'pharmacy' });

    // ── r37c: the day's register and the to-dos ──
    const byTime = () => [...b.register].sort((x, y) => Date.parse(String(x.at)) - Date.parse(String(y.at)));
    /** One cursor page (`<ms>_<id>`), newest first with `desc`. */
    const pageOf = (rows: Json[], q: { order?: unknown; limit?: unknown; cursor?: unknown }) => {
      const desc = q.order === 'desc' && !b.oldestFirstOnly;
      const list = desc ? [...rows].reverse() : rows;
      const from = q.cursor ? list.findIndex((r) => `${Date.parse(String(r.at))}_${r.id}` === q.cursor) + 1 : 0;
      const limit = Number(q.limit ?? 50);
      const items = list.slice(from, from + limit);
      const last = items[items.length - 1];
      return { items, nextCursor: from + limit < list.length && last ? `${Date.parse(String(last.at))}_${last.id}` : null };
    };
    if (path === '/pharmacy-assisted/today') {
      if (b.offline) return route.abort('internetdisconnected');
      const q = Object.fromEntries(url.searchParams);
      const money = b.register.filter((r) => r.kind !== 'wallet_topup');
      const byMethod: Record<string, number> = { cash: 0, upi: 0, card: 0, wallet: 0, online: 0, other: 0 };
      for (const r of money) if (r.paid) byMethod[String(r.method)] = (byMethod[String(r.method)] ?? 0) + Number(r.amountMinor);
      const collectedMinor = money.filter((r) => r.paid).reduce((a, r) => a + Number(r.amountMinor), 0);
      const unpaid = money.filter((r) => !r.paid);
      const sales = unpaid.filter((r) => r.kind === 'order');
      // r37c: the whole day's totals on every page; pending on the first page only.
      return ok(route, { date: q.date ?? DAY, ...pageOf(byTime(), q),
        totals: { collectedMinor, byMethod, unpaidMinor: unpaid.reduce((a, r) => a + Number(r.amountMinor), 0), count: b.register.length },
        ...(q.cursor ? {} : { pending: { prescriptionsToReview: { count: 0, ids: [] }, unpaidCounterSales: { count: sales.length, ids: sales.map((r) => r.id) },
          bookingsAwaiting: { count: 0, consultationCount: 0, labCount: 0, consultationIds: [], labBookingIds: [] }, labReportsReady: { count: 0, ids: [] },
          lowStock: { count: 0, ids: [] }, ...b.pendingExtra } }) });
    }
    if (path === '/pharmacy-assisted/today/search' && method === 'POST') {
      const needle = String(body!.q).toLowerCase();
      // r37c: 4+ digits also match the account holder's phone (`phone` here: the mock's own field, never sent).
      const hits = byTime().filter((r) => [r.patientName, r.shortRef, r.what].join(' ').toLowerCase().includes(needle)
        || (/^\d{4,}$/.test(needle) && String(r.phone ?? '').includes(needle)));
      return ok(route, { date: body!.date ?? DAY, ...pageOf(hits, body!) });
    }
    if (path === '/pharmacy-assisted/todos' && method === 'GET') return ok(route, [...b.todos].reverse(), 200, { pagination: { nextCursor: null } });
    if (path === '/pharmacy-assisted/todos' && method === 'POST') {
      if (b.todoOfflineOnce) { b.todoOfflineOnce = false; return route.abort('internetdisconnected'); }
      if (String(body!.text) === 'one too many') return refuse(route, 409, 'TODO_LIMIT');
      const key = String(body!.requestKey);
      const known = b.todos.find((x) => x._id === b.todoKeys[key]);
      if (known) return ok(route, { todo: known, replayed: true });
      const todo = { _id: `7${b.todos.length}`.padStart(24, '0'), text: body!.text, dueAt: null, done: false, doneAt: null, version: 1,
        createdBy: { kind: 'pharmacy', id: PH, name: 'Pooja' }, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() };
      b.todos.push(todo);
      b.todoKeys[key] = String(todo._id);
      return ok(route, { todo, replayed: false }, 201);
    }
    const todo = /^\/pharmacy-assisted\/todos\/(\w{24})$/.exec(path);
    if (todo && method === 'PATCH') {
      const x = b.todos.find((t) => t._id === todo[1])!;
      if (body!.expectedVersion !== x.version) return refuse(route, 409, 'TODO_CHANGED');
      Object.assign(x, { done: body!.done, version: Number(x.version) + 1 });
      return ok(route, x);
    }

    // ── + New: the patient ──
    if (path === '/pharmacy-customers/search') return ok(route, b.customers);
    if (path === '/pharmacy-assisted/patients/lookup') return ok(route, b.lookup);
    if (path === '/pharmacy-bookings' && method === 'GET') return ok(route, [], 200, { pagination: { nextCursor: null } });
    if (path === '/pharmacy-wallet') return ok(route, { balancePaise: 200_000, isActive: true, receivableMinor: 0, frozen: false });

    // ── Doctor now (video): the existing Consult now ──
    if (path === `${base}/specialities`) return ok(route, [{ specialization: 'General Physician', onlineNow: 1 }]);
    if (path === `${base}/doctors`) return ok(route, [{ doctorId: DOC, name: 'Dr Kavya Rao', specialization: 'General Physician', modes: ['video'], instantFeeMinor: 50000, nearby: null }]);
    if (path === `${base}/quote`) return ok(route, { quotedAmountMinor: 50000, doctors: 1 });
    if (path === `${base}/requests` && method === 'GET') return ok(route, [], 200, { pagination: { total: 0, nextCursor: null } });
    if (path === `${base}/requests` && method === 'POST') {
      const x = body!;
      const request = { _id: REQ, status: 'offered', statusVersion: 1, mode: x.mode, specialization: x.specialization, target: x.target, offerGeneration: 1,
        offerExpiresAt: LATER, inactivityRefundAt: LATER, offeredCount: 1, acceptedDoctorName: null, bookingId: null, patientName: (x.patient as Json).name,
        assisted: { shortRef: 'K7QXM2PA', join: x.join, preferredLanguage: x.preferredLanguage },
        money: { quotedAmountMinor: x.acceptedQuoteMinor, discountMinor: 0, paidMinor: x.acceptedPayableMinor, returnedMinor: 0, refundedMinor: 0 } };
      b.request = request;
      b.register.push(row({ kind: 'consultation', id: REQ, at: NOW.toISOString(), shortRef: 'K7QXM2PA', patientName: (x.patient as Json).name,
        what: 'Dr Kavya Rao · now · video', whatParts: { code: 'consult.instant', values: { doctor: 'Dr Kavya Rao', mode: 'video' } },
        amountMinor: x.acceptedPayableMinor, paid: true, method: 'wallet', status: 'offered', link: { kind: 'booking', id: REQ } }));
      return ok(route, { request, funding: { method: 'wallet', amountMinor: x.acceptedPayableMinor, state: 'held', walletEntryId: 'w1' }, newAccount: false, replayed: false }, 201);
    }
    if (new RegExp(`^${base}/requests/${REQ}(/activity)?$`).test(path) && b.request) return ok(route, b.request);

    // ── Medicines: the existing New sale ──
    if (path === '/pharmacy-customers' && method === 'POST') return ok(route, { customer: { _id: 'd9'.repeat(12) }, userId: ASHA, isNewUser: false }, 201);
    if (path === '/pharmacy-inventory') {
      return ok(route, [{ _id: 'e0'.padStart(24, '0'), medicineId: { _id: PARA, name: 'Dolo 650', rx: false }, availableQty: 40, reservedQty: 0, reorderThreshold: 5, isActive: true,
        retailPrice: 32, batches: [{ _id: 'f0'.padStart(24, '0'), batchNumber: 'B1', expiryDate: '20281231', availableQty: 40, reservedQty: 0, status: 'active' }] }],
      200, { pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } });
    }
    if (path === '/pharmacy-orders' && method === 'POST') {
      const lines = body!.items as { medicineId: string; orderedQty: number }[];
      const total = lines.reduce((a, l) => a + l.orderedQty * 32, 0);
      const order = { _id: '90'.padStart(24, '0'), orderNumber: 'PO-100', pharmacyId: PH, customerId: { _id: ASHA, name: 'Asha Verma', phone: PHONE }, orderType: 'in_store',
        status: 'placed', items: lines.map((l) => ({ medicineId: l.medicineId, medicineName: 'Dolo 650', orderedQty: l.orderedQty, unitPrice: 32, lineTotal: l.orderedQty * 32,
          prescriptionRequired: false, batchAllocations: [{ batchId: 'f0'.padStart(24, '0'), batchNumber: 'B1', expiryDate: '20281231', quantity: l.orderedQty }] })),
        subtotal: total, discountTotal: 0, taxTotal: 15.24, grandTotal: total, paymentMode: 'in_store_payment', paymentStatus: 'pending', deliveryMode: 'pickup', isWalkIn: body!.isWalkIn,
        prescriptionStatus: 'not_required', createdAt: NOW.toISOString(), bill: { pharmacy: { name: 'Demo Pharmacy', address: null, city: 'Pune', state: null, pincode: null,
          gstNumber: null, drugLicenseNumber: null }, paymentMethod: null, paidAt: null } };
      b.orders.push(order);
      b.register.push(row({ kind: 'order', id: order._id, at: new Date(NOW.getTime() + 35 * 60_000).toISOString(), shortRef: 'PO-100', patientName: 'Asha Verma',
        what: 'Dolo 650', whatParts: { code: 'order.items', values: { first: 'Dolo 650', more: 0 } }, amountMinor: total * 100, link: { kind: 'pharmacy_order', id: order._id } }));
      return ok(route, { order, paymentRequired: false }, 201);
    }
    const one = /^\/pharmacy-orders\/(\w{24})(\/mark-paid)?$/.exec(path);
    if (one) {
      const o = b.orders.find((x) => x._id === one[1])!;
      if (one[2]) {
        Object.assign(o, { paymentStatus: 'paid', paymentSource: body!.paymentSource, bill: { ...(o.bill as Json), paymentMethod: body!.paymentSource, paidAt: NOW.toISOString() } });
        Object.assign(b.register.find((r) => r.id === o._id)!, { paid: true, method: body!.paymentSource });
      }
      return ok(route, o);
    }
    return refuse(route, 404, 'NOT_MOCKED');
  });
  return b;
}


async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Mobile number').fill('9000000001');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'What do you want to do?' })).toBeVisible();
}
const stored = (page: Page) => page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + location.href);
const bigButtons = (page: Page) => page.getByRole('navigation', { name: 'What do you want to do?' });
const money = (page: Page) => page.getByRole('region', { name: 'Money of the day' });
const choices = (page: Page) => page.getByRole('navigation', { name: 'What does the patient need?' });
const whoIs = (page: Page) => page.getByRole('group', { name: 'Who is the patient?' });
const lookups = (b: Backend) => b.calls.filter((c) => c.path === '/pharmacy-assisted/patients/lookup');
/** Nothing on the page is wider than the screen (no sideways scroll). */
const noSidewaysScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

/** + New (or Find patient) → the phone or a name → Find. */
async function findPatient(page: Page, text = PHONE, button = '+ New') {
  await bigButtons(page).getByRole('link', { name: button }).click();
  await expect(page.getByRole('heading', { name: 'Step 1 of 2: who is the patient?' })).toBeVisible();
  await page.getByLabel('Phone number or name').fill(text);
  await page.getByRole('button', { name: 'Find', exact: true }).click();
}

/** Consult now, from its patient step to the request (the doctor, the device, the language, paid from the wallet). */
async function requestConsult(page: Page, b: Backend) {
  await page.getByLabel('Patient agreed to this booking').check();
  await page.getByRole('button', { name: 'Next: choose the doctor' }).click();
  const form = page.getByRole('form', { name: 'Doctor' });
  await form.getByLabel('What does the patient need?').selectOption('General Physician');
  await form.getByLabel('On this pharmacy’s device').check();
  await form.getByLabel('Language the patient speaks').selectOption('hi');
  await form.getByRole('button', { name: 'Next: check the price' }).click();
  await page.getByRole('group', { name: 'Check and pay' }).getByRole('button', { name: 'Pay ₹500.00 from wallet and request' }).click();
  await expect(page.getByRole('heading', { name: 'Waiting for a doctor' })).toBeVisible();
  return b.calls.find((c) => c.method === 'POST' && c.path === '/pharmacy-assisted/instant/requests')!.body!;
}

/** Example 1: Asha (new) gets a video consult from the wallet, then medicines in cash; Today shows both with totals. */
async function exampleOne(page: Page, b: Backend, signedIn = false) {
  if (!signedIn) await signIn(page);
  const big = bigButtons(page);
  await expect(big.getByRole('link')).toHaveText(['+ New', 'Find patient', 'Sell medicines', 'Today']);
  await expect(page.getByText('Nothing yet today')).toBeVisible();
  // WQ54b: one big line, only the methods that took money (none yet), and what is still to collect.
  await expect(money(page).getByRole('paragraph')).toHaveText(['Collected today ₹0.00', 'To collect ₹0.00']);

  // A to-do: added once, then ticked.
  await page.getByLabel('New to-do').fill('Call supplier for Dolo 650');
  await page.getByRole('button', { name: 'Add' }).click();
  const todo = page.getByRole('checkbox', { name: 'Call supplier for Dolo 650' });
  await expect(todo).not.toBeChecked();
  await todo.check();
  await expect(todo).toBeChecked();
  expect(b.calls.find((c) => c.method === 'PATCH')!.body).toEqual({ done: true, expectedVersion: 1 });

  // + New → the phone → a new number: this person, the name and the number again → See a doctor now (video).
  await findPatient(page);
  await expect(page.getByText('This number is new to Jansetu.')).toBeVisible();
  await whoIs(page).getByRole('button', { name: 'This person' }).click();
  await page.getByLabel('Patient’s full name').fill('Asha Verma');
  await page.getByLabel('Type the number again').fill(PHONE);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  // The focus moves to the step's heading.
  await expect(page.getByRole('heading', { name: 'Step 2 of 2: what does Asha Verma need?' })).toBeFocused();
  await expect(choices(page).getByRole('link')).toHaveText(['See a doctor now (video)', 'Book a doctor for later', 'Book a lab test', 'Sell medicines']);
  await choices(page).getByRole('link', { name: 'See a doctor now (video)' }).click();

  // The existing Consult now, with Asha named once: no "Who is the patient?", no second number, no second lookup.
  await expect(page.getByRole('heading', { name: 'Consult now', level: 1 })).toBeVisible();
  await expect(page.getByText(`Patient: Asha Verma · ${PHONE}`)).toBeVisible();
  await expect(page).not.toHaveURL(/visit=1/);
  await expect(page.getByText('Who is the patient?')).toHaveCount(0);
  await expect(page.getByLabel('Type the number again')).toHaveCount(0);
  await expect(page.getByLabel('Patient’s full name')).toHaveCount(0);
  // WQ54c: the agreement in one plain sentence, the full statement behind Read more.
  await expect(page.getByText('The patient agrees: Jansetu keeps their details (an account for this number), the doctor sees them, and this pharmacy can see the prescription for 90 days.')).toBeVisible();
  await expect(page.getByText(/agreed that this pharmacy books this consultation/)).toBeHidden();
  // WQ54d: Read more is a 48 px target.
  expect((await page.getByText('Read more').boundingBox())!.height).toBeGreaterThanOrEqual(48);
  await page.getByText('Read more').click();
  await expect(page.getByText(/agreed that this pharmacy books this consultation/)).toBeVisible();
  const asked = await requestConsult(page, b);
  expect(asked).toMatchObject({ phone: PHONE, patient: { relation: 'self', name: 'Asha Verma' }, paymentMethod: 'wallet' });
  expect(lookups(b)).toHaveLength(1);

  // + New → "Same patient again" (a small second choice, within 30 minutes) → Sell medicines in cash, with the bill.
  await page.goto('/#/');
  await bigButtons(page).getByRole('link', { name: '+ New' }).click();
  await page.getByRole('button', { name: 'Same patient again: Asha Verma' }).click();
  await choices(page).getByRole('link', { name: 'Sell medicines' }).click();
  const customer = page.getByRole('region', { name: 'Customer' });
  await expect(customer).toContainText(`Patient: Asha Verma · ${PHONE}`);
  await expect(customer.getByLabel('Customer’s name')).toHaveCount(0);
  await customer.getByRole('checkbox').check();
  const lines = page.getByRole('region', { name: 'Medicines' });
  await lines.getByLabel('Find a medicine in your stock').fill('dolo');
  await lines.getByRole('button', { name: 'Search' }).click();
  await lines.getByRole('button', { name: 'Add Dolo 650' }).click();
  await lines.getByLabel('Quantity of Dolo 650').fill('10');
  await noSidewaysScroll(page);
  await page.getByRole('button', { name: 'Next: check the sale' }).click();
  await page.getByRole('group', { name: 'Check the sale' }).getByRole('button', { name: 'Create sale' }).click();
  const pay = page.getByRole('region', { name: 'Payment at the counter' });
  // WQ54b: no method is chosen at first; Mark paid waits for one. WQ54c: the payment and the bill in big type.
  await expect(pay.getByRole('radio', { checked: true })).toHaveCount(0);
  await expect(pay.getByRole('button', { name: 'Mark paid' })).toBeDisabled();
  // WQ54d: Done only once it is paid; until then the next step is Mark paid.
  await expect(page.getByRole('link', { name: 'Done', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.ws-main')!).fontSize)).toBe('17px');
  await pay.getByLabel('Cash').check();
  await pay.getByRole('button', { name: 'Mark paid' }).click();
  await pay.getByRole('button', { name: 'Yes, it is paid' }).click();
  await expect(page.getByRole('region', { name: 'Bill PO-100' })).toContainText('Paid by Cash');
  expect(b.calls.find((c) => c.path === '/pharmacy-customers' && c.method === 'POST')!.body).toMatchObject({ name: 'Asha Verma', phone: PHONE });
  // One obvious next step: Done (the home); the rest small.
  await expect(page.getByRole('link', { name: 'Start a new sale' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Done', exact: true }).click();
  await expect(bigButtons(page)).toBeVisible();

  // Today shows both, newest first, with the money split (only the methods that took money).
  await page.goto('/#/pharmacy/today');
  await expect(page.getByRole('heading', { name: 'Today', level: 1 })).toBeVisible();
  await expect(money(page).getByRole('paragraph')).toHaveText(['Collected today ₹820.00', 'Cash ₹320.00 · Wallet ₹500.00', 'To collect ₹0.00']);
  const rows = page.getByRole('list', { name: 'The day’s visits, sales and tests' }).getByRole('listitem');
  await expect(rows).toHaveCount(2);
  // The time only (the day is the page's); the line in the app's words (r37c `whatParts`).
  await expect(rows.nth(0)).toContainText('10:40');
  await expect(rows.nth(0)).toContainText('Asha Verma: Dolo 650');
  await expect(rows.nth(0)).toContainText('₹320.00');
  await expect(rows.nth(0)).toContainText('Paid (cash)');
  await expect(rows.nth(0)).not.toContainText('2026');
  await expect(rows.nth(1)).toContainText('Asha Verma: Dr Kavya Rao · now · Video');
  await expect(rows.nth(1)).toContainText('Paid (wallet)');
  // r37c: the whole day searched on the server, by a POST.
  await page.getByLabel('Search the day by name, phone or ref').fill('K7Q');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(rows).toHaveCount(1);
  expect(b.calls.find((c) => c.path === '/pharmacy-assisted/today/search')!.body).toMatchObject({ q: 'K7Q', date: DAY, order: 'desc' });
  await rows.nth(0).getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`/pharmacy/consultations/${REQ}$`));
  // No patient's name or phone is kept on this device or put in an address.
  expect(await stored(page)).not.toMatch(new RegExp(`${PHONE}|Asha`));
  expect(b.calls.some((c) => c.path.includes(PHONE) || c.path.includes('Asha'))).toBe(false);
}

/**
 * WQ54c: who the patient is, asked once on + New: someone else on a phone (a mother on her son's), a mother's child, and
 * the owner themselves; each booked for that person, never the phone's owner by mistake.
 */
async function whoJourneys(page: Page, b: Backend) {
  await signIn(page);
  // 1. Asha on her son's phone: the number is on Jansetu (his masked name); she is someone else.
  b.lookup = { exists: true, holderNameMasked: 'R*** K***' };
  await findPatient(page);
  await expect(page.getByText('This number is on Jansetu: R*** K***')).toBeVisible();
  await whoIs(page).getByRole('button', { name: 'Someone else (family member)' }).click();
  await page.getByLabel('Family member’s full name').fill('Asha Verma');
  await page.getByLabel('Relation to the phone’s owner').selectOption('Mother');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText('Asha Verma (mother of R*** K***)')).toBeVisible();
  await choices(page).getByRole('link', { name: 'See a doctor now (video)' }).click();
  await expect(page.getByText('Patient: Asha Verma (mother of R*** K***)')).toBeVisible();
  const forMother = await requestConsult(page, b);
  expect(forMother).toMatchObject({ phone: PHONE, patient: { relation: 'Mother', name: 'Asha Verma' } });
  expect(lookups(b)).toHaveLength(1);

  // 2. A mother's child: Ravi, her son, on her number; a lab test (worded for a test). [Change] keeps the number.
  b.lookup = { exists: true, holderNameMasked: 'S*** D***' };
  await page.goto('/#/');
  await findPatient(page);
  await whoIs(page).getByRole('button', { name: 'Someone else (family member)' }).click();
  await page.getByLabel('Family member’s full name').fill('Ravi');
  await page.getByLabel('Relation to the phone’s owner').selectOption('Son');
  await page.getByLabel('Gender (optional)').selectOption('Male');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await choices(page).getByRole('link', { name: 'Book a lab test' }).click();
  await expect(page.getByText('Patient: Ravi (son of S*** D***)')).toBeVisible();
  await expect(page.getByText('The patient agrees: Jansetu keeps their details (an account for this number) and the lab sees them for this test.')).toBeVisible();
  await page.getByRole('button', { name: 'Change', exact: true }).click();
  await expect(page.getByLabel('Phone number or name')).toHaveValue(PHONE);
  await expect(whoIs(page)).toBeVisible();

  // 3. The owner themselves: the masked name is never handed over; their own name is typed.
  b.lookup = { exists: true, holderNameMasked: 'A*** V***' };
  await page.getByRole('button', { name: 'Find', exact: true }).click();
  await expect(page.getByText('This number is on Jansetu: A*** V***')).toBeVisible();
  await whoIs(page).getByRole('button', { name: 'This person' }).click();
  await expect(page.getByLabel('Patient’s full name')).toHaveValue('');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText('Type the patient’s name.')).toBeVisible();
  await page.getByLabel('Patient’s full name').fill('Asha Verma');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await choices(page).getByRole('link', { name: 'Book a doctor for later' }).click();
  await expect(page.getByRole('heading', { name: 'Book consultation', level: 1 })).toBeVisible();
  await expect(page.getByText(`Patient: Asha Verma · ${PHONE}`)).toBeVisible();
  await expect(page.getByText('A*** V***')).toHaveCount(0);
  await expect(page.getByText('Who is the patient?')).toHaveCount(0);
  await page.getByLabel('Patient agreed to this booking').check();
  await page.getByRole('button', { name: 'Next: choose the doctor' }).click();
  // WQ55c: the finished patient step is one line.
  await expect(page.getByText('Patient: Asha Verma · ✓ agreed')).toBeVisible();
  // One lookup per Find on + New (four here: two numbers, the number kept by Change, Find again); none by a flow.
  expect(lookups(b)).toHaveLength(4);
  await noSidewaysScroll(page);
  expect(await stored(page)).not.toMatch(new RegExp(`${PHONE}|Asha|Ravi`));
}

test('example 1: a new patient, a video consult from the wallet, then medicines in cash; Today shows both with totals; a to-do', async ({ page }) => {
  const b = await mockBackend(page);
  await exampleOne(page, b);
});

test('who the patient is: someone else on a phone, a mother’s child, the owner themselves', async ({ page }) => {
  const b = await mockBackend(page);
  await whoJourneys(page, b);
});

test('Find patient: by name, then the number; every Find asks the server; today’s visits; sells to that customer (not a walk-in)', async ({ page }) => {
  const b = await mockBackend(page);
  b.customers = [ASHA_ROW];
  b.lookup = { exists: true, holderNameMasked: 'A*** V***' };
  b.register.push(row({ kind: 'order', id: '93'.padStart(24, '0'), at: NOW.toISOString(), shortRef: 'PO-9', patientName: 'Asha Verma', phone: PHONE, what: 'ORS',
    whatParts: { code: 'order.items', values: { first: 'ORS', more: 0 } }, amountMinor: 5000, link: { kind: 'pharmacy_order', id: '93'.padStart(24, '0') } }));
  await signIn(page);
  await findPatient(page, 'Asha', 'Find patient');
  await expect(page.getByRole('heading', { name: 'Find patient', level: 1 })).toBeVisible();
  await expect(page.getByText('Find a patient to see or start a visit.')).toBeVisible();
  expect(b.calls.find((c) => c.path === '/pharmacy-customers/search')!.body).toMatchObject({ search: 'Asha' });
  await page.getByRole('button', { name: `Asha Verma · ${PHONE}` }).click();
  await expect(page.getByText('This number is on Jansetu: A*** V***')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Visits today' })).toContainText('Asha Verma: ORS');
  // A Find always asks the server again.
  await page.getByRole('button', { name: 'Find', exact: true }).click();
  await expect.poll(() => lookups(b).length).toBe(2);
  await whoIs(page).getByRole('button', { name: 'This person' }).click();
  // The name this pharmacy typed is offered.
  await expect(page.getByLabel('Patient’s full name')).toHaveValue('Asha Verma');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(choices(page).getByRole('link', { name: 'Book a lab test' })).toHaveAttribute('href', '#/pharmacy/lab-book?visit=1');
  await choices(page).getByRole('link', { name: 'Sell medicines' }).click();
  const customer = page.getByRole('region', { name: 'Customer' });
  await expect(customer).toContainText(`Patient: Asha Verma · ${PHONE}`);
  await expect(customer.getByRole('checkbox')).toHaveCount(0);
  const lines = page.getByRole('region', { name: 'Medicines' });
  await lines.getByLabel('Find a medicine in your stock').fill('dolo');
  await lines.getByRole('button', { name: 'Search' }).click();
  await lines.getByRole('button', { name: 'Add Dolo 650' }).click();
  await page.getByRole('button', { name: 'Next: check the sale' }).click();
  await page.getByRole('group', { name: 'Check the sale' }).getByRole('button', { name: 'Create sale' }).click();
  await expect(page.getByRole('region', { name: 'Payment at the counter' })).toBeVisible();
  expect(b.calls.find((c) => c.path === '/pharmacy-orders' && c.method === 'POST')!.body).toMatchObject({ customerId: ASHA, isWalkIn: false });
  expect(b.calls.some((c) => c.path === '/pharmacy-customers' && c.method === 'POST')).toBe(false);
});

test('no internet: the register says so with Try again; a to-do that did not go keeps its text and is sent again', async ({ page }) => {
  const b = await mockBackend(page);
  b.offline = true;
  await signIn(page);
  await expect(page.getByText('No internet connection. Check it, then tap Try again. Nothing you typed is lost.').first()).toBeVisible({ timeout: 15_000 });
  b.offline = false;
  await page.getByRole('button', { name: 'Try again' }).first().click();
  await expect(page.getByText('Nothing yet today')).toBeVisible();
  b.todoOfflineOnce = true;
  await page.getByLabel('New to-do').fill('Order more ORS');
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByLabel('New to-do')).toHaveValue('Order more ORS');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('checkbox', { name: 'Order more ORS' })).toBeVisible();
  const adds = b.calls.filter((c) => c.method === 'POST' && c.path === '/pharmacy-assisted/todos');
  expect(adds).toHaveLength(2);
  expect(adds[1]!.body!.requestKey).toBe(adds[0]!.body!.requestKey);
  expect(b.todos).toHaveLength(1);
  // r37b: 500 open to-dos at most: said in words, the text kept.
  await page.getByLabel('New to-do').fill('one too many');
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByText('There are 500 open to-dos. Tick the done ones, then add this one.')).toBeVisible();
  await expect(page.getByLabel('New to-do')).toHaveValue('one too many');
});

test('what waits: one tap to where it is done; each row opens its record; an earlier day paid today says so', async ({ page }) => {
  const b = await mockBackend(page);
  const SALE = '91'.padStart(24, '0');
  const LAB = 'b2'.repeat(12);
  b.register.push(row({ kind: 'wallet_topup', id: 'f1'.padStart(24, '0'), at: NOW.toISOString(), what: 'Wallet top-up', whatParts: { code: 'wallet.topup' },
    amountMinor: 100000, paid: true, method: 'upi', status: 'credited', link: { kind: 'wallet_transaction', id: 'f1'.padStart(24, '0') } }));
  b.register.push(row({ kind: 'order', id: SALE, at: NOW.toISOString(), shortRef: 'PO-7', patientName: 'Ravi K.', what: 'Dolo 650 +1 more',
    whatParts: { code: 'order.items', values: { first: 'Dolo 650', more: 1 } }, amountMinor: 12000, link: { kind: 'pharmacy_order', id: SALE } }));
  b.register.push(row({ kind: 'order', id: '92'.padStart(24, '0'), at: NOW.toISOString(), shortRef: 'PO-6', patientName: 'Meena S.', what: 'ORS',
    whatParts: { code: 'order.items', values: { first: 'ORS', more: 0 } }, amountMinor: 5000, paid: true, method: 'cash', status: 'completed', paidToday: true,
    madeOn: '2026-11-24', link: { kind: 'pharmacy_order', id: '92'.padStart(24, '0') } }));
  b.pendingExtra = { labReportsReady: null,
    bookingsAwaiting: { count: 3, consultationCount: 2, labCount: 1, consultationIds: ['b1'.repeat(12), 'b3'.repeat(12)], labBookingIds: [LAB] } };
  await signIn(page);
  await expect(money(page).getByRole('paragraph')).toHaveText(['Collected today ₹50.00', 'Cash ₹50.00', 'To collect ₹120.00']);
  await expect(money(page).getByText('To collect ₹120.00')).toHaveClass(/money-due--warn/);
  await expect(page.getByRole('link', { name: '1 unpaid sale' })).toHaveAttribute('href', `#/pharmacy/sale/${SALE}`);
  // r37c: bookings waiting for their payment, by kind.
  await expect(page.getByRole('link', { name: '2 doctor bookings waiting for payment' })).toHaveAttribute('href', '#/pharmacy/consultations');
  await expect(page.getByRole('link', { name: '1 lab test waiting for payment' })).toHaveAttribute('href', `#/pharmacy/lab-tests/${LAB}`);
  await expect(page.getByRole('link', { name: /Ravi K\.\s?: Dolo 650 \+1 more/ })).toHaveAttribute('href', `#/pharmacy/orders/${SALE}`);
  // A wallet top-up has no patient: no "Customer" for it.
  await expect(page.getByRole('link', { name: 'Wallet top-up', exact: true })).toHaveAttribute('href', '#/pharmacy/wallet');
  await expect(page.getByText('Customer')).toHaveCount(0);
  await expect(page.getByText('paid today · made 24 Nov 2026')).toBeVisible();
  await expect(page.getByText('paid today')).toHaveCount(1);
  await expect(page.getByText('Lab reports ready: couldn’t load')).toBeVisible();
});

test('the latest 10, newest first, also from a server that lists oldest first; See all of today', async ({ page }) => {
  const b = await mockBackend(page);
  b.oldestFirstOnly = true;
  for (let n = 1; n <= 12; n += 1) {
    const id = String(n).padStart(24, '0');
    b.register.push(row({ kind: 'order', id, at: new Date(NOW.getTime() - (13 - n) * 60_000).toISOString(), shortRef: `PO-${n}`, patientName: `Patient ${n}`,
      what: 'ORS', amountMinor: 100, link: { kind: 'pharmacy_order', id } }));
  }
  await signIn(page);
  const rows = page.getByRole('list', { name: 'The day’s visits, sales and tests' }).getByRole('listitem');
  await expect(rows).toHaveCount(10);
  await expect(rows.first()).toContainText('Patient 12: ORS');
  await expect(rows.last()).toContainText('Patient 3: ORS');
  const all = page.getByRole('link', { name: 'See all of today' });
  expect((await all.boundingBox())!.height).toBeGreaterThanOrEqual(48);
  await all.click();
  await expect(page.getByRole('heading', { name: 'Today', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Home' }).first()).toBeVisible();
});

test.describe('on a 390 px phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop', 'the phone size runs once'));

  test('example 1 on a phone: the big buttons first, Home and More in the header on one row, the menu closes on a page change', async ({ page }) => {
    const b = await mockBackend(page);
    await signIn(page);
    const menu = page.getByRole('navigation', { name: 'Main' });
    await expect(menu).toBeHidden();
    // WQ54c/WQ54d: the short brand, Home and Menu on one row, a word under each icon.
    const home = page.getByRole('link', { name: 'Home', exact: true });
    const more = page.getByRole('button', { name: 'Menu' });
    const [brand, homeBox, moreBox] = await Promise.all([page.locator('.ws-brand').boundingBox(), home.boundingBox(), more.boundingBox()]);
    expect(Math.abs(homeBox!.y - moreBox!.y)).toBeLessThan(2);
    expect(brand!.y + brand!.height).toBeGreaterThan(homeBox!.y);
    expect(homeBox!.height).toBeGreaterThanOrEqual(48);
    await expect(home).toHaveText('Home');
    await expect(more).toHaveText('Menu');
    await more.click();
    await expect(menu.getByRole('link', { name: 'Stock', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(menu).toBeHidden();
    // Every big button is at least 48 px tall.
    for (const box of await Promise.all((await bigButtons(page).getByRole('link').all()).map((l) => l.boundingBox()))) expect(box!.height).toBeGreaterThanOrEqual(48);
    // The menu closes on any page change (here a link on the page), and Home in the header goes back.
    await more.click();
    await bigButtons(page).getByRole('link', { name: 'Today' }).click();
    await expect(menu).toBeHidden();
    await home.click();
    await expect(bigButtons(page)).toBeVisible();
    await noSidewaysScroll(page);
    b.calls.length = 0;
    await exampleOne(page, b, true);
  });

  test('who the patient is on a phone: someone else on a phone, a mother’s child, the owner themselves', async ({ page }) => {
    const b = await mockBackend(page);
    await whoJourneys(page, b);
  });

  test('Back after a visit: the flow opens empty (the patient is handed over once); a new sign-in has no last patient', async ({ page }) => {
    const b = await mockBackend(page);
    b.customers = [ASHA_ROW];
    await signIn(page);
    await findPatient(page);
    await whoIs(page).getByRole('button', { name: 'This person' }).click();
    await page.getByLabel('Type the number again').fill(PHONE);
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await choices(page).getByRole('link', { name: 'Book a lab test' }).click();
    await expect(page.getByText(`Patient: Asha Verma · ${PHONE}`)).toBeVisible();
    await expect(page).toHaveURL(/#\/pharmacy\/lab-book$/);
    // A 17 px page with 48 px targets in a flow opened from + New on a phone.
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.ws-main')!).fontSize)).toBe('17px');
    for (const box of await Promise.all((await page.locator('.visit-line .j-btn:visible').all()).map((l) => l.boundingBox()))) expect(box!.height).toBeGreaterThanOrEqual(48);
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Step 1 of 2: who is the patient?' })).toBeVisible();
    await page.goForward();
    await expect(page.getByRole('heading', { name: 'Book lab test', level: 1 })).toBeVisible();
    await expect(page.getByText(/^Patient: /)).toHaveCount(0);
    await expect(page.getByLabel('Patient’s mobile number')).toHaveValue('');
    await page.reload();
    await expect(page.getByText(/^Patient: /)).toHaveCount(0);
    // Signed out and in again: + New offers no "Same patient again".
    await page.goto('/#/');
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await signIn(page);
    await bigButtons(page).getByRole('link', { name: '+ New' }).click();
    await expect(page.getByRole('heading', { name: 'Step 1 of 2: who is the patient?' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Same patient again/ })).toHaveCount(0);
    expect(b.calls.some((c) => c.path.includes(PHONE))).toBe(false);
  });
});
