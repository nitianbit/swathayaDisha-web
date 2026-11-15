import { expect, test, type Page, type Route } from '@playwright/test';

/** WQ2: partner catalogue and in-house bills (members and admins acting as owner), against a mocked backend. */
const LAB = 'a1'.repeat(12);
const CLINIC = 'a2'.repeat(12);
const OWNER = 'b1'.repeat(12);
const STAFF = 'b2'.repeat(12);
const BR1 = 'c1'.repeat(12);
const BR2 = 'c2'.repeat(12);
const CBC = 'd1'.repeat(12);
const THY = 'd2'.repeat(12);
const VITD = 'd3'.repeat(12);
const INV1 = 'e1'.repeat(12);
const INV2 = 'e2'.repeat(12);
const DOC1 = 'f1'.repeat(12);
const DOC2 = 'f2'.repeat(12);
const DOC3 = 'f3'.repeat(12);
const ADMIN = 'ad'.repeat(12);
const USER = '99'.repeat(12);
const ALL = ['staff.manage', 'branches.manage', 'catalogue.manage', 'slots.manage', 'bookings.view', 'bookings.manage', 'reports.upload',
  'reports.release', 'invoices.create', 'invoices.cancel', 'payments.record', 'finance.view'];
const GSTIN = '29ABCDE1234F1Z5';

type Rec = Record<string, unknown>;
interface Me { _id: string; partnerId: string; name: string; role: 'owner' | 'staff'; permissions: string[]; branchIds: string[] }
interface Call { method: string; path: string; body: unknown; auth?: string }
interface Backend {
  calls: Call[];
  me: Me;
  partners: Rec[];
  catalogue: Rec[];
  invoices: Rec[];
  events: Rec[];
  /** The next create is recorded but its answer never arrives. */
  loseNextCreateAnswer: boolean;
  /** The next create never reaches the server. */
  dropNextCreate: boolean;
  /** The next catalogue item is added but its answer never arrives. */
  loseNextItemAnswer: boolean;
  /** Applied to the item on the server just before the next edit re-reads it (someone else's change). */
  changeBeforeEdit?: Rec;
  /** The next create is refused because customer linking is off (503). */
  linkingOffOnce: boolean;
  /** Paying this invoice is refused: someone else recorded a payment first. */
  paidElsewhere?: string;
  live: boolean;
}

function partner(id: string, name: string, kind: 'lab' | 'clinic', tax: 'regular' | 'unregistered' = 'regular'): Rec {
  return { _id: id, kind, name, contact: { phone: '9000000000' }, verification: { state: 'verified' }, taxRegime: tax,
    ...(tax === 'regular' ? { gstin: GSTIN } : {}), invoiceSeries: { prefix: kind === 'lab' ? 'LB' : 'CL' }, activeOwnerCount: 1, isActive: true };
}

const owner = (partnerId = LAB): Me => ({ _id: OWNER, partnerId, name: 'Ravi Owner', role: 'owner', permissions: ALL, branchIds: [] });

/** What the server computes (services/invoice.ts), for the mock's answers. */
function compute(body: Rec, stateCode: string) {
  const items = (body.items as Rec[]).map((i): Rec & { discountMinor: number; amountMinor: number } => {
    const gross = (i.unitPriceMinor as number) * (i.qty as number);
    const discountMinor = (i.discountMinor as number | undefined) ?? 0;
    return { ...i, discountMinor, amountMinor: gross - discountMinor };
  });
  const pos = (body.customer as Rec).placeOfSupply as string | undefined;
  const same = !pos || pos === stateCode;
  const t = { subtotalMinor: 0, discountMinor: 0, taxableMinor: 0, cgstMinor: 0, sgstMinor: 0, igstMinor: 0 };
  for (const l of items) {
    t.subtotalMinor += (l.unitPriceMinor as number) * (l.qty as number);
    t.discountMinor += l.discountMinor;
    t.taxableMinor += l.amountMinor;
    const tax = Math.round((l.amountMinor * (l.gstRate as number)) / 100);
    if (same) { t.cgstMinor += Math.floor(tax / 2); t.sgstMinor += tax - Math.floor(tax / 2); } else t.igstMinor += tax;
  }
  return { items, totals: { ...t, totalMinor: t.taxableMinor + t.cgstMinor + t.sgstMinor + t.igstMinor, currency: 'INR' } };
}

function invoice(id: string, number: number, extra: Rec = {}): Rec {
  return {
    _id: id, partnerId: LAB, branchId: BR1, number, financialYear: '2627', serial: `LB/2627/${String(number).padStart(4, '0')}`,
    documentKind: 'tax_invoice', issuedAt: `2026-11-1${number}T05:00:00.000Z`,
    supplier: { name: 'City Lab', gstin: GSTIN, address: '1 Main Rd, Bengaluru, Karnataka, 560038', placeOfSupply: '29' },
    customer: { name: 'Asha Rao', phone: '9876500000', userId: USER },
    items: [
      { catalogItemId: CBC, description: 'CBC', qty: 2, unitPriceMinor: 45000, discountMinor: 1000, gstRate: 0, amountMinor: 89000 },
      { description: 'Home collection fee', qty: 1, unitPriceMinor: 10000, discountMinor: 0, gstRate: 18, amountMinor: 10000 },
    ],
    totals: { subtotalMinor: 100000, discountMinor: 1000, taxableMinor: 99000, cgstMinor: 900, sgstMinor: 900, igstMinor: 0, totalMinor: 100800, currency: 'INR' },
    lifecycleState: 'issued', lifecycleVersion: 0, createdBy: OWNER, idempotencyKey: `seed${number}`, ...extra,
  };
}

async function mockBackend(page: Page, me: Me = owner(), opts: { tax?: 'regular' | 'unregistered'; seed?: boolean } = {}): Promise<Backend> {
  const b: Backend = {
    calls: [], me, live: false, loseNextCreateAnswer: false, dropNextCreate: false, linkingOffOnce: false, loseNextItemAnswer: false,
    partners: [partner(LAB, 'City Lab', 'lab', opts.tax ?? 'regular'), partner(CLINIC, 'Sunrise Clinic', 'clinic', 'regular')],
    catalogue: [
      { _id: CBC, partnerId: LAB, kind: 'test', name: 'CBC', code: 'CBC01', priceMinor: 45000, gstRate: 0, visitModes: ['lab', 'home'], reportTatHours: 12, isActive: true, adminDisabled: false },
      { _id: THY, partnerId: LAB, kind: 'package', name: 'Thyroid profile', priceMinor: 120000, mrpMinor: 150000, gstRate: 18, visitModes: ['lab'], includes: ['T3', 'T4', 'TSH'], isActive: true, adminDisabled: false },
      { _id: VITD, partnerId: LAB, kind: 'test', name: 'Vitamin D', priceMinor: 150000, gstRate: 0, visitModes: ['lab'], isActive: true, adminDisabled: true },
    ],
    invoices: opts.seed ? [invoice(INV1, 1), invoice(INV2, 2, { customer: { name: 'Bala' }, totals: { ...(invoice(INV2, 2).totals as Rec), totalMinor: 50000 } })] : [],
    events: [],
  };
  const branches = [
    { _id: BR1, partnerId: LAB, name: 'Indiranagar', address: { line1: '1 Main Rd', city: 'Bengaluru', state: 'Karnataka', stateCode: '29', pincode: '560038' }, phone: '9000000010', isActive: true },
  ];
  const doctors = [
    { memberId: 'm1'.repeat(12), doctorId: DOC1, role: 'staff', branchIds: [], name: 'Dr Mehta', specialization: 'General physician', active: true },
    { memberId: 'm2'.repeat(12), doctorId: DOC2, role: 'staff', branchIds: [], name: 'Dr Old', active: false },
    { memberId: 'm3'.repeat(12), doctorId: DOC3, role: 'staff', branchIds: [BR2], name: 'Dr Elsewhere', active: true },
  ];
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const ok = (route: Route, data: unknown, status = 200) => json(route, status, { success: true, data });
  const fail = (route: Route, status: number, code: string, message: string) => json(route, status, { error: status, code, message });
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = req.method();
    const body = ['POST', 'PUT'].includes(method) ? req.postDataJSON() : null;
    if (path === '/auth/session/refresh') {
      if (!b.live) return fail(route, 401, 'SESSION_ENDED', 'Please sign in again');
      return ok(route, { token: 't1', expiresIn: 900, principal: { userId: b.me._id, userType: 'partner', sid: 's1' } });
    }
    if (path === '/auth/session/logout') { b.live = false; return ok(route, {}); }
    if (path.startsWith('/auth/session')) return ok(route, {});
    b.calls.push({ method, path: `${path}${url.search}`, body, auth: req.headers().authorization });
    if (path === '/auth/partner/send' || path === '/auth/admin/send') return ok(route, undefined);
    if (path === '/auth/partner/verify') { b.live = true; return ok(route, { token: 't1', expiresIn: 900, user: {} }); }
    if (path === '/auth/admin/verify') return ok(route, { token: 'admin', expiresIn: 900, user: {} });
    const auth = req.headers().authorization;
    if (auth !== 'Bearer t1' && auth !== 'Bearer admin') return fail(route, 401, 'UNAUTHORIZED', 'Authentication is required');
    if (path === '/auth/profile') {
      if (auth === 'Bearer admin') return ok(route, { user: { _id: ADMIN, name: 'Ops Admin' }, userRole: 'admin' });
      const p = b.partners.find((x) => x._id === b.me.partnerId)!;
      return ok(route, { user: { ...b.me, phone: '9000000001', isActive: true }, partner: p, userRole: 'partner' });
    }
    const adminItem = /^\/partner-workspace\/admin\/catalogue\/([0-9a-f]{24})\/(disable|enable)$/.exec(path);
    if (adminItem) {
      if (auth !== 'Bearer admin') return fail(route, 403, 'FORBIDDEN', 'Admin access is required');
      const it = b.catalogue.find((x) => x._id === adminItem[1])!;
      it.adminDisabled = adminItem[2] === 'disable';
      return ok(route, it);
    }
    if (/^\/partner-workspace\/admin\/[0-9a-f]{24}$/.test(path)) return ok(route, b.partners.find((p) => path.endsWith(p._id as string)));
    const ws = /^\/partner-workspace(?:\/admin\/([0-9a-f]{24})\/workspace)?(\/.*)$/.exec(path);
    if (!ws) return fail(route, 404, 'NOT_FOUND', 'Not found');
    if (ws[1] && auth !== 'Bearer admin') return fail(route, 403, 'FORBIDDEN', 'Admin access is required');
    const sub = ws[2]!;
    const pid = ws[1] ?? b.me.partnerId;
    const p = b.partners.find((x) => x._id === pid)!;
    const can = (...perms: string[]) => !!ws[1] || b.me.role === 'owner' || perms.some((x) => b.me.permissions.includes(x));
    const deny = () => fail(route, 403, 'PARTNER_PERMISSION_REQUIRED', 'You do not have permission to do this');

    if (sub === '/me') return ok(route, p);
    if (sub === '/branches') return ok(route, branches);
    if (sub === '/clinic/doctors') return p.kind === 'clinic' ? ok(route, doctors) : fail(route, 409, 'NOT_A_CLINIC', 'Only clinics have doctors');

    if (sub === '/catalogue' && method === 'GET') {
      if (!can('catalogue.manage', 'invoices.create')) return deny();
      const kind = url.searchParams.get('kind');
      return ok(route, b.catalogue.filter((i) => i.isActive && (!kind || i.kind === kind)));
    }
    if (sub === '/catalogue' && method === 'POST') {
      if (!can('catalogue.manage')) return deny();
      const it = { _id: 'd9'.repeat(12), partnerId: pid, isActive: true, adminDisabled: false, ...(body as Rec) };
      b.catalogue.push(it);
      if (b.loseNextItemAnswer) { b.loseNextItemAnswer = false; return route.abort('failed'); }
      return ok(route, it, 201);
    }
    const item = /^\/catalogue\/([0-9a-f]{24})$/.exec(sub);
    if (item) {
      if (!can('catalogue.manage')) return deny();
      const it = b.catalogue.find((x) => x._id === item[1])!;
      if (method === 'GET') {
        if (b.changeBeforeEdit) { Object.assign(it, b.changeBeforeEdit); b.changeBeforeEdit = undefined; }
        return ok(route, it);
      }
      if (method === 'PUT') { Object.assign(it, body); return ok(route, it); }
      if (method === 'DELETE') { it.isActive = false; return json(route, 200, { success: true, message: 'Catalogue item deactivated' }); }
    }

    const readers = ['invoices.create', 'invoices.cancel', 'payments.record', 'finance.view'];
    if (sub === '/invoices' && method === 'GET') {
      if (!can(...readers)) return deny();
      const state = url.searchParams.get('state');
      const before = url.searchParams.get('before');
      const rows = b.invoices.filter((i) => (!state || i.lifecycleState === state) && (!before || Date.parse(i.issuedAt as string) < Date.parse(before)))
        .sort((x, y) => Date.parse(y.issuedAt as string) - Date.parse(x.issuedAt as string));
      return ok(route, rows.slice(0, Number(url.searchParams.get('limit') ?? 50)));
    }
    if (sub === '/invoices' && method === 'POST') {
      if (!can('invoices.create')) return deny();
      const x = body as Rec;
      const { idempotencyKey, ...request } = x;
      const hash = JSON.stringify(request);
      const existing = b.invoices.find((i) => i.idempotencyKey === idempotencyKey);
      if (existing) {
        if (existing.requestHash !== hash) return fail(route, 409, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different bill');
        return ok(route, existing, 201);
      }
      if (b.dropNextCreate) { b.dropNextCreate = false; return route.abort('failed'); }
      const customer = x.customer as Rec;
      if (b.linkingOffOnce && customer.phone) {
        b.linkingOffOnce = false;
        return fail(route, 503, 'CUSTOMER_LINKING_UNAVAILABLE', 'Customer linking is not available yet; issue the bill without a phone number or try again later');
      }
      const lines = x.items as Rec[];
      if (p.taxRegime !== 'regular' && lines.some((l) => (l.gstRate as number) > 0)) {
        return fail(route, 400, 'INVALID_TAX_RATES', 'This partner is not GST-registered: every line must have GST rate 0');
      }
      const n = b.invoices.length + 1;
      const { items, totals } = compute(x, '29');
      const inv = {
        ...invoice(`e${n + 2}`.repeat(12).slice(0, 24), n), partnerId: pid, branchId: x.branchId, issuedAt: new Date().toISOString(),
        serial: `${(p.invoiceSeries as Rec).prefix}/2627/${String(n).padStart(4, '0')}`,
        documentKind: lines.some((l) => (l.gstRate as number) > 0) ? 'tax_invoice' : 'bill_of_supply',
        customer: { ...customer, ...(customer.phone ? { phone: String(customer.phone).slice(-10), userId: USER } : {}) },
        ...(x.doctorId ? { doctorId: x.doctorId } : {}),
        items, totals, idempotencyKey, requestHash: hash,
      };
      b.invoices.push(inv);
      if (b.loseNextCreateAnswer) { b.loseNextCreateAnswer = false; return route.abort('failed'); }
      return ok(route, inv, 201);
    }
    const one = /^\/invoices\/([0-9a-f]{24})(\/pdf|\/pay|\/cancel)?$/.exec(sub);
    if (one) {
      const inv = b.invoices.find((i) => i._id === one[1]);
      if (!inv) return fail(route, 404, 'INVOICE_NOT_FOUND', 'Invoice not found');
      const events = () => b.events.filter((e) => e.invoiceId === inv._id);
      if (!one[2]) return can(...readers) ? ok(route, { invoice: inv, events: events() }) : deny();
      if (one[2] === '/pdf') {
        if (!can(...readers)) return deny();
        return route.fulfill({ status: 200, contentType: 'application/pdf', body: '%PDF-1.4\n%mock bill\n' });
      }
      const transition = (to: string, event: Rec) => {
        inv.lifecycleVersion = (inv.lifecycleVersion as number) + 1;
        inv.lifecycleState = to;
        const e = { _id: `ev${inv.lifecycleVersion}`, invoiceId: inv._id, version: inv.lifecycleVersion, at: '2026-11-15T06:00:00.000Z', by: OWNER, byKind: 'member', ...event };
        b.events.push(e);
        return e;
      };
      if (one[2] === '/pay') {
        if (!can('payments.record')) return deny();
        if (b.paidElsewhere === inv._id && inv.lifecycleState === 'issued') transition('paid', { kind: 'payment', mode: 'cash' });
        if (inv.lifecycleState !== 'issued') return fail(route, 409, 'INVOICE_STATE_CONFLICT', `This bill is ${inv.lifecycleState}`);
        const e = transition('paid', { kind: 'payment', ...(body as Rec) });
        return ok(route, { invoice: inv, event: e });
      }
      if (!can('invoices.cancel')) return deny();
      if (inv.lifecycleState === 'cancelled') return fail(route, 409, 'ALREADY_CANCELLED', 'This bill is cancelled');
      const e = transition('cancelled', { kind: 'cancellation', reason: (body as Rec).reason });
      return ok(route, { invoice: inv, event: e });
    }
    return fail(route, 404, 'NOT_FOUND', 'Not found');
  });
  return b;
}

async function signInPartner(page: Page) {
  await page.goto('/');
  await page.getByLabel('Lab or clinic staff').check();
  await page.getByLabel('Mobile number').fill('9000000001');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

async function signInAdmin(page: Page) {
  await page.goto('/');
  await page.getByLabel('Admin').check();
  await page.getByLabel('Mobile number').fill('9876543210');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' });
const creates = (b: Backend) => b.calls.filter((c) => c.method === 'POST' && /\/invoices$/.test(c.path));

test('catalogue: add with prices in rupees sent as paise, edit only what changed, deactivate after confirming', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Price list' }).click();
  await expect(page.getByRole('heading', { name: 'Tests and prices' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Vitamin D' })).toContainText('Disabled by Jansetu');
  await expect(page.getByRole('row').filter({ hasText: 'Thyroid profile' })).toContainText('MRP ₹1,500.00');
  await page.getByLabel('Status').selectOption('disabled');
  await expect(page.getByRole('row').filter({ hasText: 'CBC' })).toHaveCount(0);
  await page.getByLabel('Status').selectOption('all');
  await page.getByLabel('Search by name or code').fill('cbc01');
  await expect(page.getByRole('row')).toHaveCount(2);
  await page.getByLabel('Search by name or code').fill('');

  await page.getByRole('button', { name: 'Add an item' }).click();
  await page.getByRole('button', { name: 'Add item' }).click();
  await expect(page.getByText('Enter the name.')).toBeVisible();
  await expect(page.getByText('Enter the price.')).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Lipid profile');
  await page.getByLabel('Code (optional)').fill('LP1');
  await page.getByLabel('Price (₹)').fill('450.50');
  await page.getByLabel('MRP (₹, optional)').fill('400');
  await page.getByRole('button', { name: 'Add item' }).click();
  await expect(page.getByText('MRP cannot be below the price.')).toBeVisible();
  await page.getByLabel('MRP (₹, optional)').fill('500');
  await page.getByLabel('GST rate').selectOption('18');
  await page.getByLabel('SAC (optional)').fill('999316');
  await page.getByLabel('Home collection').check();
  await page.getByLabel('Report within (hours, optional)').fill('24');
  await page.getByRole('button', { name: 'Add item' }).click();
  await expect(page.getByText('Lipid profile was added.')).toBeVisible();
  expect(backend.calls.find((c) => c.method === 'POST' && c.path === '/partner-workspace/catalogue')?.body).toEqual({
    kind: 'test', name: 'Lipid profile', code: 'LP1', sac: '999316', priceMinor: 45050, mrpMinor: 50000, gstRate: 18,
    visitModes: ['home', 'lab'], reportTatHours: 24,
  });

  await page.getByRole('button', { name: 'Edit CBC' }).click();
  await expect(page.getByLabel('Price (₹)')).toHaveValue('450');
  await page.getByLabel('Price (₹)').fill('475.25');
  await page.getByRole('button', { name: 'Save item' }).click();
  await expect(page.getByText('CBC was saved.')).toBeVisible();
  expect(backend.calls.find((c) => c.method === 'PUT')).toMatchObject({ path: `/partner-workspace/catalogue/${CBC}`, body: { priceMinor: 47525 } });
  await expect(page.getByRole('row').filter({ hasText: 'CBC' })).toContainText('₹475.25');

  const row = page.getByRole('row').filter({ hasText: 'Thyroid profile' });
  await row.getByRole('button', { name: 'Deactivate' }).click();
  await expect(row.getByText(/cannot be put on new bills/)).toBeVisible();
  await row.getByRole('button', { name: 'Back' }).click();
  expect(backend.calls.some((c) => c.method === 'DELETE')).toBe(false);
  await row.getByRole('button', { name: 'Deactivate' }).click();
  await row.getByRole('button', { name: 'Deactivate Thyroid profile' }).click();
  await expect(page.getByText('Thyroid profile was deactivated.')).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Thyroid profile' })).toHaveCount(0);
  expect(backend.calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([`/partner-workspace/catalogue/${THY}`]);
});

test('a supplier without GST: only 0% offered; a GST item is refused on a bill; a server refusal leaves the bill to fix', async ({ page }) => {
  const backend = await mockBackend(page, owner(), { tax: 'unregistered' });
  backend.linkingOffOnce = true;
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Price list' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Thyroid profile' })).toContainText('Cannot be billed');
  await page.getByRole('button', { name: 'Add an item' }).click();
  await expect(page.getByLabel('GST rate').locator('option')).toHaveText(['0%']);
  await expect(page.getByText('City Lab is not registered for regular GST, so only 0% can be billed.')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();

  await nav(page).getByRole('link', { name: 'Bills' }).click();
  await page.getByRole('link', { name: 'New bill' }).click();
  await expect(page.getByLabel('Branch', { exact: true })).toHaveValue(BR1); // the only branch is chosen
  await page.getByLabel('From the catalogue').selectOption(THY);
  await page.getByRole('button', { name: 'Add item' }).click();
  const thy = page.getByRole('group', { name: 'Line 1: Thyroid profile' });
  await expect(thy.getByText('This partner is not GST-registered: every line must have GST rate 0')).toBeVisible();
  await page.getByLabel('Customer name').fill('Asha Rao');
  await page.getByRole('button', { name: 'Review the bill' }).click();
  await expect(page.getByRole('group', { name: 'Issue the bill' })).toHaveCount(0);
  await thy.getByRole('button', { name: 'Remove line 1' }).click();

  await page.getByLabel('From the catalogue').selectOption(CBC);
  await page.getByRole('button', { name: 'Add item' }).click();
  await expect(page.getByLabel('From the catalogue').locator('option', { hasText: 'Vitamin D' })).toHaveCount(0); // disabled by Jansetu
  await page.getByLabel('Mobile number (optional)').fill('98765 00000');
  await expect(page.getByText(/added to that number’s Jansetu customer account/)).toBeVisible();
  await page.getByRole('button', { name: 'Review the bill' }).click();
  await expect(page.getByRole('group', { name: 'Issue the bill' })).toContainText('Issue an invoice without GST for ₹450.00 to Asha Rao from Indiranagar?');
  await page.getByRole('button', { name: 'Issue bill' }).click();
  await expect(page.getByText('Not issued: Customer linking is not available yet; issue the bill without a phone number or try again later')).toBeVisible();
  await expect(page.getByLabel('Customer name')).toHaveValue('Asha Rao');
  await page.getByLabel('Mobile number (optional)').fill('');
  await page.getByRole('button', { name: 'Review the bill' }).click();
  await page.getByRole('button', { name: 'Issue bill' }).click();
  await expect(page.getByText('Bill LB/2627/0001 issued.')).toBeVisible();
  const sent = creates(backend);
  expect(sent).toHaveLength(2);
  expect((sent[0]!.body as Rec).customer).toEqual({ name: 'Asha Rao', phone: '9876500000' });
  expect((sent[1]!.body as Rec).customer).toEqual({ name: 'Asha Rao' });
  expect((sent[1]!.body as Rec).idempotencyKey).not.toBe((sent[0]!.body as Rec).idempotencyKey); // a changed bill is a new request
});

test('new bill: live totals as the server computes them; a lost answer is resent with the same key and content', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.loseNextCreateAnswer = true;
  await signInPartner(page);
  await page.goto('/#/partner/invoices/new');
  await page.getByLabel('Customer name').fill('Asha Rao');
  await page.getByLabel('Mobile number (optional)').fill('+919876500000');
  await expect(page.getByText(/one is created for it, and the customer may get an SMS/)).toBeVisible();
  await page.getByLabel('Age (optional)').fill('34');
  await page.getByLabel('Gender (optional)').selectOption('female');
  await page.getByLabel('From the catalogue').selectOption(CBC);
  await page.getByRole('button', { name: 'Add item' }).click();
  const cbc = page.getByRole('group', { name: 'Line 1: CBC' });
  await cbc.getByLabel('Quantity').fill('2');
  await cbc.getByLabel('Discount (₹, optional)').fill('10');
  await expect(cbc).toContainText('Line amount: ₹890.00');
  await page.getByRole('button', { name: 'Add a line by hand' }).click();
  const fee = page.getByRole('group', { name: /^Line 2/ });
  await fee.getByLabel('Description').fill('Home collection fee');
  await fee.getByLabel('Unit price (₹)').fill('100');
  await fee.getByLabel('GST rate').selectOption('18');
  await expect(fee).toContainText('+ GST ₹18.00');
  const totals = page.locator('dl[aria-label="Expected totals"]');
  await expect(totals).toContainText('₹1,000.00');
  await expect(totals).toContainText('− ₹10.00');
  await expect(totals).toContainText('₹990.00');
  await expect(totals).toContainText('CGST₹9.00');
  await expect(totals).toContainText('SGST₹9.00');
  await expect(totals).toContainText('Total₹1,008.00');
  await expect(page.getByText('This will be a tax invoice.', { exact: false })).toBeVisible();

  await page.getByRole('button', { name: 'Review the bill' }).click();
  await page.getByRole('button', { name: 'Issue bill' }).click();
  // The bill was recorded but the answer was lost: the outcome is unknown and the bill can only be resent as it was.
  const panel = page.getByRole('group', { name: 'Unconfirmed bill' });
  await expect(panel).toContainText('The outcome of this request is not known yet');
  await expect(panel).toContainText('Bill for Asha Rao: CBC × 2; Home collection fee × 1');
  await panel.getByRole('button', { name: 'Send the same request again' }).click();
  await expect(page.getByText('Bill LB/2627/0001 issued. It was added to the customer’s Jansetu account (Bills in their app).')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Bill LB/2627/0001' })).toBeVisible();
  const sent = creates(backend);
  expect(sent).toHaveLength(2);
  expect(sent[1]!.body).toEqual(sent[0]!.body);
  expect(sent[0]!.body).toEqual({
    branchId: BR1,
    customer: { name: 'Asha Rao', phone: '+919876500000', age: 34, gender: 'female' },
    items: [
      { catalogItemId: CBC, description: 'CBC', qty: 2, unitPriceMinor: 45000, discountMinor: 1000, gstRate: 0 },
      { description: 'Home collection fee', qty: 1, unitPriceMinor: 10000, gstRate: 18 },
    ],
    idempotencyKey: (sent[0]!.body as Rec).idempotencyKey,
  });
  expect(String((sent[0]!.body as Rec).idempotencyKey)).toMatch(/^[0-9a-f]{32}$/);
  expect(backend.invoices).toHaveLength(1);
  await expect(page.getByText('Linked: the bill is in the customer’s app under Bills')).toBeVisible();
  // Nothing about the customer was written to browser storage.
  expect(await page.evaluate(() => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }))).not.toMatch(/Asha|98765/);
});

test('a bill sent just before a reload: check by key, then start again only after a warning', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.dropNextCreate = true;
  await signInPartner(page);
  await page.goto('/#/partner/invoices/new');
  await page.getByLabel('Customer name').fill('Asha Rao');
  await page.getByLabel('From the catalogue').selectOption(CBC);
  await page.getByRole('button', { name: 'Add item' }).click();
  await page.getByRole('button', { name: 'Review the bill' }).click();
  await page.getByRole('button', { name: 'Issue bill' }).click();
  await expect(page.getByRole('group', { name: 'Unconfirmed bill' })).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify({ ...sessionStorage }))).not.toMatch(/Asha|CBC/);

  await page.reload();
  const panel = page.getByRole('group', { name: 'Unconfirmed bill' });
  await expect(panel).toContainText('A request made earlier on this device');
  await panel.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(panel).toContainText('Not found in the records. It may still be on its way, or it was never recorded');
  await panel.getByRole('button', { name: 'Start a new bill instead' }).click();
  await expect(panel).toContainText('there will be two bills for the same sale');
  await panel.getByRole('button', { name: 'Forget it and start a new bill' }).click();
  await expect(page.getByLabel('Customer name')).toHaveValue('');
  expect(backend.calls.some((c) => c.method === 'GET' && c.path.startsWith('/partner-workspace/invoices?limit=50'))).toBe(true);
});

test('a bill: pay after confirming, a refused payment shows the server and the current bill, cancel with a reason, PDF from memory', async ({ page }) => {
  const backend = await mockBackend(page, owner(), { seed: true });
  backend.paidElsewhere = INV2;
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Bills' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'LB/2627/0001' })).toContainText('₹1,008.00');
  await expect(page.getByRole('row').filter({ hasText: 'LB/2627/0001' })).toContainText('Unpaid');
  await page.getByLabel('Status').selectOption('paid');
  await expect(page.getByText('No bill matches these filters.')).toBeVisible();
  expect(backend.calls.some((c) => c.path === '/partner-workspace/invoices?state=paid&limit=50')).toBe(true);
  await page.getByLabel('Status').selectOption('');
  await page.getByLabel('Issued on or before').fill('2026-11-11');
  await expect(page.getByRole('row').filter({ hasText: 'LB/2627/0002' })).toHaveCount(0);
  expect(backend.calls.some((c) => c.path === '/partner-workspace/invoices?before=2026-11-11T18%3A30%3A00.000Z&limit=50')).toBe(true);
  await page.getByLabel('Issued on or before').fill('');

  // Someone else recorded the payment of bill 2 first: the server's message, and the bill as it is now.
  await page.getByRole('link', { name: 'LB/2627/0002' }).click();
  await page.getByRole('button', { name: 'Record payment' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Record ₹500.00 paid' }).click();
  await expect(page.getByText('Payment not recorded: This bill is paid')).toBeVisible();
  await expect(page.getByText('Paid by Cash')).toBeVisible();
  await page.getByRole('link', { name: 'Back to bills' }).click();

  await page.getByRole('link', { name: 'LB/2627/0001' }).click();
  await expect(page.getByRole('heading', { name: 'Bill LB/2627/0001' })).toBeVisible();
  await expect(page.getByText('Tax invoice · issued')).toBeVisible();
  const lines = page.getByRole('table', { name: 'Items on bill LB/2627/0001' });
  await expect(lines.getByRole('row').filter({ hasText: 'Home collection fee' })).toContainText('18%');
  await expect(page.getByRole('definition').filter({ hasText: 'Linked' })).toBeVisible();

  await page.getByRole('button', { name: 'Record payment' }).click();
  await page.getByLabel('Paid by').selectOption('upi');
  await page.getByLabel('Reference (optional)').fill('UTR123');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Record ₹1,008.00 as paid by UPI (reference UTR123) for bill LB/2627/0001?')).toBeVisible();
  await page.getByRole('button', { name: 'Record ₹1,008.00 paid' }).click();
  await expect(page.getByText('Payment recorded.')).toBeVisible();
  await expect(page.getByText('Paid by UPI · reference UTR123')).toBeVisible();
  expect(backend.calls.filter((c) => c.path.endsWith('/pay')).map((c) => c.body)).toEqual([{ mode: 'cash' }, { mode: 'upi', reference: 'UTR123' }]);

  await page.getByRole('button', { name: 'Cancel bill' }).click();
  await expect(page.getByText(/payment recorded on it stays on record/)).toBeVisible();
  await page.getByRole('button', { name: 'Back' }).click();
  expect(backend.calls.some((c) => c.path.endsWith('/cancel'))).toBe(false);
  await page.getByRole('button', { name: 'Cancel bill' }).click();
  await page.getByLabel('Why is this bill cancelled?').fill('Billed to the wrong patient');
  await page.getByRole('button', { name: 'Cancel bill LB/2627/0001' }).click();
  await expect(page.getByText('Bill LB/2627/0001 was cancelled.')).toBeVisible();
  await expect(page.getByText('Cancelled: “Billed to the wrong patient”')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel bill' })).toHaveCount(0);
  expect(backend.calls.find((c) => c.path.endsWith('/cancel'))).toMatchObject({ path: `/partner-workspace/invoices/${INV1}/cancel`, body: { reason: 'Billed to the wrong patient' } });

  await page.getByRole('button', { name: 'Open PDF (current)' }).click();
  await expect(page.locator('iframe[title="Bill LB/2627/0001 PDF"]')).toHaveAttribute('src', /^blob:/);
  await expect(page.getByRole('link', { name: 'Save the PDF' })).toHaveAttribute('download', 'LB-2627-0001-v2.pdf');
  await page.getByRole('button', { name: 'Open PDF as issued' }).click();
  await expect(page.getByRole('link', { name: 'Save the PDF' })).toHaveAttribute('download', 'LB-2627-0001-v0.pdf');
  const pdfs = backend.calls.filter((c) => c.path.includes('/pdf'));
  expect(pdfs.map((c) => c.path)).toEqual([`/partner-workspace/invoices/${INV1}/pdf?version=2`, `/partner-workspace/invoices/${INV1}/pdf?version=0`]);
  expect(pdfs.every((c) => c.auth === 'Bearer t1' && !c.path.includes('t1'))).toBe(true);
});

test('permissions: finance sees bills read-only; a biller reads the price list; pages without permission do not exist', async ({ page }) => {
  const backend = await mockBackend(page, { _id: STAFF, partnerId: LAB, name: 'Fin Staff', role: 'staff', permissions: ['finance.view'], branchIds: [] }, { seed: true });
  await signInPartner(page);
  await expect(nav(page).getByRole('link', { name: 'Bills' })).toBeVisible();
  await expect(nav(page).getByRole('link', { name: 'Price list' })).toHaveCount(0);
  await nav(page).getByRole('link', { name: 'Bills' }).click();
  await expect(page.getByText('You can view bills and their PDFs.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'New bill' })).toHaveCount(0);
  await page.getByRole('link', { name: 'LB/2627/0001' }).click();
  await expect(page.getByText('You can view this bill; recording payments and cancelling need other permissions.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Record payment' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel bill' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open PDF' })).toBeVisible();
  await page.goto('/#/partner/invoices/new');
  await expect(page.getByText('Page not found')).toBeVisible();
  await page.goto('/#/partner/catalogue');
  await expect(page.getByText('Page not found')).toBeVisible();
  expect(backend.calls.some((c) => c.path.startsWith('/partner-workspace/catalogue'))).toBe(false);

  // The same browser session, now with other permissions (the profile is read again on reload).
  backend.me = { _id: STAFF, partnerId: LAB, name: 'Bill Staff', role: 'staff', permissions: ['invoices.create'], branchIds: [] };
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await nav(page).getByRole('link', { name: 'Price list' }).click();
  await expect(page.getByText('You can see the catalogue to make bills')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add an item' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Edit/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Deactivate' })).toHaveCount(0);
  await nav(page).getByRole('link', { name: 'Bills' }).click();
  await page.getByRole('link', { name: 'LB/2627/0001' }).click();
  await expect(page.getByRole('button', { name: 'Record payment' })).toHaveCount(0);
});

test('clinic: only active doctors of the branch are offered; a customer in another state is billed with IGST', async ({ page }) => {
  const backend = await mockBackend(page, owner(CLINIC));
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Bills' }).click();
  await page.getByRole('link', { name: 'New bill' }).click();
  await expect(page.getByLabel('Doctor (optional)').locator('option')).toHaveText(['No doctor named', 'Dr Mehta (General physician)']);
  await page.getByLabel('Doctor (optional)').selectOption(DOC1);
  await page.getByLabel('Customer name').fill('Kiran');
  await page.getByLabel('Customer state code (optional)').fill('27');
  await page.getByRole('button', { name: 'Add a line by hand' }).click();
  const line = page.getByRole('group', { name: /^Line 1/ });
  await line.getByLabel('Description').fill('Consultation');
  await line.getByLabel('Unit price (₹)').fill('500');
  await line.getByLabel('GST rate').selectOption('18');
  await expect(page.getByText('with IGST (another state)', { exact: false })).toBeVisible();
  const totals = page.locator('dl[aria-label="Expected totals"]');
  await expect(totals).toContainText('IGST₹90.00');
  await expect(totals).toContainText('Total₹590.00');
  await page.getByRole('button', { name: 'Review the bill' }).click();
  await page.getByRole('button', { name: 'Issue bill' }).click();
  await expect(page.getByText('Bill CL/2627/0001 issued.')).toBeVisible();
  expect(creates(backend)[0]!.body).toMatchObject({ doctorId: DOC1, customer: { name: 'Kiran', placeOfSupply: '27' } });
  await expect(page.getByRole('definition').filter({ hasText: 'Dr Mehta' })).toBeVisible();
  expect(backend.calls.some((c) => c.path === '/partner-workspace/clinic/doctors')).toBe(true);
});

test('admin as owner: bills and catalogue through the admin workspace routes; disable and enable items', async ({ page }) => {
  const backend = await mockBackend(page, owner(), { seed: true });
  await signInAdmin(page);
  await page.goto(`/#/admin/partners/${LAB}`);
  await page.getByRole('link', { name: 'Bills' }).click();
  await expect(page.getByText('Managing City Lab with owner authority.')).toBeVisible();
  await page.getByRole('link', { name: 'LB/2627/0001' }).click();
  await expect(page.getByRole('button', { name: 'Record payment' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to bills' }).click();
  await expect(page.getByRole('link', { name: 'New bill' })).toHaveAttribute('href', `#/admin/partners/${LAB}/invoices/new`);

  await page.goto(`/#/admin/partners/${LAB}/catalogue`);
  const cbc = page.getByRole('row').filter({ hasText: 'CBC' });
  await cbc.getByRole('button', { name: 'Disable' }).click();
  await expect(cbc.getByText(/The partner cannot undo this/)).toBeVisible();
  await cbc.getByRole('button', { name: 'Disable CBC' }).click();
  await expect(page.getByText('CBC was disabled.')).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'CBC' })).toContainText('Disabled by Jansetu');
  await page.getByRole('row').filter({ hasText: 'Vitamin D' }).getByRole('button', { name: 'Enable' }).click();
  await expect(page.getByText('Vitamin D is offered again.')).toBeVisible();
  const paths = backend.calls.map((c) => `${c.method} ${c.path}`);
  expect(paths).toContain(`GET /partner-workspace/admin/${LAB}/workspace/invoices?limit=50`);
  expect(paths).toContain(`GET /partner-workspace/admin/${LAB}/workspace/invoices/${INV1}`);
  expect(paths).toContain(`GET /partner-workspace/admin/${LAB}/workspace/catalogue`);
  expect(paths).toContain(`POST /partner-workspace/admin/catalogue/${CBC}/disable`);
  expect(paths).toContain(`POST /partner-workspace/admin/catalogue/${VITD}/enable`);
  expect(backend.calls.some((c) => /^\/partner-workspace\/(invoices|catalogue)/.test(c.path))).toBe(false);
  await page.goto('/#/partner/invoices');
  await expect(page.getByText('Page not found')).toBeVisible();
});

test('catalogue edits send only what this person changed; a field also changed by someone else is shown again, not overwritten', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Price list' }).click();
  // Someone else changes the price while this person renames the item: only the name is sent.
  await page.getByRole('button', { name: 'Edit CBC' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Complete blood count');
  backend.changeBeforeEdit = { priceMinor: 47000 };
  await page.getByRole('button', { name: 'Save item' }).click();
  await expect(page.getByText('Complete blood count was saved.')).toBeVisible();
  const puts = () => backend.calls.filter((c) => c.method === 'PUT');
  expect(puts().map((c) => c.body)).toEqual([{ name: 'Complete blood count' }]);
  expect(backend.calls.some((c) => c.method === 'GET' && c.path === `/partner-workspace/catalogue/${CBC}`)).toBe(true);
  await expect(page.getByRole('row').filter({ hasText: 'Complete blood count' })).toContainText('₹470.00');

  // Both changed the price: nothing is sent; the form shows the saved price for review.
  await page.getByRole('button', { name: 'Edit Complete blood count' }).click();
  await page.getByLabel('Price (₹)').fill('480');
  backend.changeBeforeEdit = { priceMinor: 49000 };
  await page.getByRole('button', { name: 'Save item' }).click();
  await expect(page.getByText(/Someone else changed the price while you were editing/)).toBeVisible();
  await expect(page.getByLabel('Price (₹)')).toHaveValue('490');
  expect(puts()).toHaveLength(1);
});

test('a new item whose answer is lost is not offered again: the person is sent to the list to check', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.loseNextItemAnswer = true;
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Price list' }).click();
  await page.getByRole('button', { name: 'Add an item' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Lipid profile');
  await page.getByLabel('Price (₹)').fill('450');
  await page.getByRole('button', { name: 'Add item' }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed item' });
  await expect(panel).toContainText('We could not confirm whether Lipid profile was added');
  await expect(page.getByRole('button', { name: 'Add item' })).toHaveCount(0);
  await expect(page.getByLabel('Name', { exact: true })).toBeDisabled();
  await panel.getByRole('button', { name: 'Look in the list' }).click();
  await expect(page.getByText(/The answer to adding Lipid profile was lost/)).toBeVisible();
  await expect(page.getByLabel('Search by name or code')).toHaveValue('Lipid profile');
  await expect(page.getByRole('row').filter({ hasText: 'Lipid profile' })).toHaveCount(1);
  expect(backend.calls.filter((c) => c.method === 'POST' && c.path === '/partner-workspace/catalogue')).toHaveLength(1);
});

test('admin switching partners: drafts, open forms and an unconfirmed bill stay with their own partner', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.dropNextCreate = true;
  await signInAdmin(page);
  // An unconfirmed bill for City Lab.
  await page.goto(`/#/admin/partners/${LAB}/invoices/new`);
  await page.getByLabel('Customer name').fill('Asha Rao');
  await page.getByLabel('From the catalogue').selectOption(CBC);
  await page.getByRole('button', { name: 'Add item' }).click();
  await page.getByRole('button', { name: 'Review the bill' }).click();
  await page.getByRole('button', { name: 'Issue bill' }).click();
  await expect(page.getByRole('group', { name: 'Unconfirmed bill' })).toBeVisible();
  // Sunrise Clinic's new bill starts empty and knows nothing of it.
  await page.goto(`/#/admin/partners/${CLINIC}/invoices/new`);
  await expect(page.getByText('Managing Sunrise Clinic with owner authority.')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Unconfirmed bill' })).toHaveCount(0);
  await page.getByLabel('Customer name').fill('Kiran');
  await page.goto(`/#/admin/partners/${LAB}/invoices/new`);
  await expect(page.getByRole('group', { name: 'Unconfirmed bill' })).toContainText('Bill for Asha Rao');
  await page.goto(`/#/admin/partners/${CLINIC}/invoices/new`);
  await expect(page.getByLabel('Customer name')).toHaveValue('');

  // An item edit open for City Lab is gone on Sunrise Clinic's price list.
  await page.goto(`/#/admin/partners/${LAB}/catalogue`);
  await page.getByRole('button', { name: 'Edit CBC' }).click();
  await expect(page.getByRole('heading', { name: 'Edit CBC' })).toBeVisible();
  await page.goto(`/#/admin/partners/${CLINIC}/catalogue`);
  await expect(page.getByRole('heading', { name: 'Services and prices' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Edit CBC' })).toHaveCount(0);
  const creates = backend.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/invoices'));
  expect(creates.map((c) => c.path)).toEqual([`/partner-workspace/admin/${LAB}/workspace/invoices`]);
});
