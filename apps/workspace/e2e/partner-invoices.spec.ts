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
const OLD = 'd4'.repeat(12);
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
  /** The next catalogue item never reaches the server. */
  dropNextItem: boolean;
  /** Applied to the item right after the next edit re-read (someone else saves in between: the PUT is stale). */
  changeAfterRead?: Rec;
  /** The next payment is recorded but its answer never arrives. */
  loseNextPayAnswer: boolean;
  /** Q14 review: the next payment is refused (503 INVOICE_INDEXES_OUTDATED), nothing written. */
  indexesOutdatedOnce?: boolean;
  /** The next payment request (only that one) waits for this promise. */
  holdPay?: Promise<void>;
  /** The held payment then loses the compare-and-set: 409 "This bill is paid". */
  heldPayConflict?: boolean;
  /** Applied to a catalogue item just before the next bill is created (its price changed meanwhile). */
  priceChangeBeforeBill?: { id: string; priceMinor: number };
  /** Bill request keys given up (Q10 abandon): they can never issue a bill. */
  abandoned: Set<string>;
  /** Q12: catalogue item create keys given up: they can never make an item. */
  abandonedItems: Set<string>;
  /** Reads of a bill's detail that fail (503) before one succeeds again. */
  failDetailReads: number;
  /** The next give-up answer waits for this promise (and is decided only then). */
  holdAbandon?: Promise<void>;
  /** Set once a held give-up has been answered. */
  abandonAnswered: boolean;
  /** Set once a held, conflicting payment has been answered. */
  heldPayAnswered?: boolean;
  live: boolean;
}

function partner(id: string, name: string, kind: 'lab' | 'clinic', tax: 'regular' | 'unregistered' = 'regular'): Rec {
  return { _id: id, kind, name, contact: { phone: '9000000000' }, verification: { state: 'verified' }, taxRegime: tax,
    ...(tax === 'regular' ? { gstin: GSTIN } : {}), invoiceSeries: { prefix: kind === 'lab' ? 'LB' : 'CL' }, activeOwnerCount: 1, isActive: true,
    updatedAt: '2026-11-01T00:00:00.000Z' };
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

async function mockBackend(page: Page, me: Me = owner(), opts: { tax?: 'regular' | 'unregistered'; seed?: boolean; many?: number } = {}): Promise<Backend> {
  const b: Backend = {
    calls: [], me, live: false, loseNextCreateAnswer: false, dropNextCreate: false, linkingOffOnce: false, loseNextItemAnswer: false,
    dropNextItem: false, loseNextPayAnswer: false, abandoned: new Set(), abandonedItems: new Set(), failDetailReads: 0, abandonAnswered: false,
    partners: [partner(LAB, 'City Lab', 'lab', opts.tax ?? 'regular'), partner(CLINIC, 'Sunrise Clinic', 'clinic', 'regular')],
    catalogue: [
      { _id: CBC, partnerId: LAB, kind: 'test', name: 'CBC', code: 'CBC01', priceMinor: 45000, gstRate: 0, visitModes: ['lab', 'home'], reportTatHours: 12, isActive: true, adminDisabled: false, updatedAt: '2026-11-01T00:00:00.000Z' },
      { _id: THY, partnerId: LAB, kind: 'package', name: 'Thyroid profile', priceMinor: 120000, mrpMinor: 150000, gstRate: 18, visitModes: ['lab'], includes: ['T3', 'T4', 'TSH'], isActive: true, adminDisabled: false, updatedAt: '2026-11-01T00:00:00.000Z' },
      { _id: OLD, partnerId: LAB, kind: 'test', name: 'Old panel', priceMinor: 30000, gstRate: 0, visitModes: ['lab'], isActive: false, adminDisabled: false, updatedAt: '2026-11-01T00:00:00.000Z' },
      { _id: VITD, partnerId: LAB, kind: 'test', name: 'Vitamin D', priceMinor: 150000, gstRate: 0, visitModes: ['lab'], isActive: true, adminDisabled: true, updatedAt: '2026-11-01T00:00:00.000Z' },
    ],
    invoices: opts.many ? Array.from({ length: opts.many }, (_, i) => invoice(`ab${String(i).padStart(22, '0')}`, i + 1, {
      issuedAt: new Date(Date.UTC(2026, 10, 1, 5) + Math.floor((i + 1) / 2) * 60_000).toISOString(), // pairs share an instant: ties by id
      customer: { name: i === 7 ? 'Meena Iyer' : `Customer ${i + 1}` },
    }))
      : opts.seed ? [invoice(INV1, 1), invoice(INV2, 2, { customer: { name: 'Bala' }, totals: { ...(invoice(INV2, 2).totals as Rec), totalMinor: 50000 } })] : [],
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

    if (sub === '/me' && method === 'PUT') {
      // Q14: the counter payment policy (owners and admins as owner), fenced by updatedAt.
      const x = body as { allowPartPayments?: boolean; expectedUpdatedAt?: string };
      if (b.me.role !== 'owner' && !ws[1]) return fail(route, 403, 'OWNER_REQUIRED', 'Only an owner can change the partner profile');
      if (x.expectedUpdatedAt && x.expectedUpdatedAt !== p.updatedAt) return fail(route, 409, 'RECORD_CHANGED', 'This record was changed by someone else');
      Object.assign(p, { allowPartPayments: x.allowPartPayments, updatedAt: new Date(Date.parse(p.updatedAt as string) + 60_000).toISOString() });
      return ok(route, p);
    }
    if (sub === '/me') return ok(route, p);
    if (sub === '/branches') return ok(route, branches);
    if (sub === '/clinic/doctors') return p.kind === 'clinic' ? ok(route, doctors) : fail(route, 409, 'NOT_A_CLINIC', 'Only clinics have doctors');

    let bump = 0;
    const touch = (it: Rec) => { bump += 1; it.updatedAt = new Date(Date.parse('2026-11-02T00:00:00.000Z') + b.calls.length * 1000 + bump).toISOString(); };
    if (sub === '/catalogue' && method === 'GET') {
      if (!can('catalogue.manage', 'invoices.create')) return deny();
      const kind = url.searchParams.get('kind');
      const all = url.searchParams.get('includeInactive') === 'true' && can('catalogue.manage');
      // Q12: `q` searches name or code (case-insensitive, literal).
      const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
      const hit = (i: Rec) => !q || [i.name, i.code].some((v) => String(v ?? '').toLowerCase().includes(q));
      return ok(route, b.catalogue.filter((i) => i.partnerId === pid && (all || i.isActive) && (!kind || i.kind === kind) && hit(i)));
    }
    const itemKey = /^\/catalogue\/by-key\/([A-Za-z0-9_-]{8,100})(\/abandon)?$/.exec(sub);
    if (itemKey) {
      if (!can('catalogue.manage')) return deny();
      const made = b.catalogue.find((i) => i.partnerId === pid && i.createRequestKey === itemKey[1]);
      if (itemKey[2]) {
        if (made) return ok(route, { state: 'used', item: made });
        b.abandonedItems.add(itemKey[1]!);
        return ok(route, { state: 'abandoned' });
      }
      return made ? ok(route, made) : fail(route, 404, 'ITEM_NOT_FOUND', 'No item was made with this key');
    }
    if (sub === '/catalogue' && method === 'POST') {
      if (!can('catalogue.manage')) return deny();
      const { requestKey, ...data } = body as Rec;
      const prior = b.catalogue.find((i) => i.partnerId === pid && requestKey && i.createRequestKey === requestKey);
      if (prior) {
        return prior.createRequestHash === JSON.stringify(data) ? ok(route, prior, 200)
          : fail(route, 409, 'REQUEST_KEY_REUSED', 'This request key was already used for a different item');
      }
      if (b.dropNextItem) { b.dropNextItem = false; return route.abort('failed'); }
      if (b.abandonedItems.has(requestKey as string)) return fail(route, 409, 'REQUEST_ABANDONED', 'This request was cancelled before it was recorded; make a new one');
      const kinds = p.kind === 'clinic' ? ['consultation', 'procedure', 'package', 'other'] : ['test', 'package'];
      if (!kinds.includes(data.kind as string)) return fail(route, 400, 'ITEM_KIND_NOT_ALLOWED', `A ${p.kind} catalogue takes: ${kinds.join(', ')}`);
      if (p.kind === 'clinic' && (data.visitModes as unknown[] | undefined)?.length) return fail(route, 400, 'VISIT_MODES_NOT_ALLOWED', 'Clinic items have no visit modes');
      const it: Rec = { _id: `d${b.catalogue.length + 5}`.repeat(12).slice(0, 24), partnerId: pid, isActive: true, adminDisabled: false, visitModes: [], ...data,
        ...(requestKey ? { createRequestKey: requestKey, createRequestHash: JSON.stringify(data) } : {}) };
      touch(it);
      b.catalogue.push(it);
      if (b.loseNextItemAnswer) { b.loseNextItemAnswer = false; return route.abort('failed'); }
      return ok(route, it, 201);
    }
    const item = /^\/catalogue\/([0-9a-f]{24})(\/reactivate)?$/.exec(sub);
    if (item) {
      if (!can('catalogue.manage') && method !== 'GET') return deny();
      const it = b.catalogue.find((x) => x._id === item[1])!;
      if (item[2]) {
        if (it.isActive) return fail(route, 409, 'ITEM_ALREADY_ACTIVE', 'This item is already active');
        it.isActive = true; touch(it);
        return ok(route, it);
      }
      if (method === 'GET') {
        if (b.changeBeforeEdit) { Object.assign(it, b.changeBeforeEdit); touch(it); b.changeBeforeEdit = undefined; }
        const answer = { ...it };
        if (b.changeAfterRead) { Object.assign(it, b.changeAfterRead); touch(it); b.changeAfterRead = undefined; }
        return ok(route, answer);
      }
      if (method === 'PUT') {
        const { expectedUpdatedAt, ...changes } = body as Rec;
        if (expectedUpdatedAt && expectedUpdatedAt !== it.updatedAt) {
          return fail(route, 409, 'CATALOGUE_ITEM_CHANGED', 'The item changed since you opened it; reload and review');
        }
        Object.assign(it, changes); touch(it);
        return ok(route, it);
      }
      if (method === 'DELETE') { it.isActive = false; touch(it); return json(route, 200, { success: true, message: 'Catalogue item deactivated' }); }
    }

    const readers = ['invoices.create', 'invoices.cancel', 'payments.record', 'finance.view'];
    if (sub === '/invoices' && method === 'GET') {
      if (!can(...readers)) return deny();
      const qp = (k: string) => url.searchParams.get(k);
      const istDay = (iso: string) => new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(0, 10);
      const q = (qp('q') ?? '').toLowerCase();
      const rows = b.invoices.filter((i) => (!qp('state') || i.lifecycleState === qp('state'))
        && (!qp('from') || istDay(i.issuedAt as string) >= qp('from')!) && (!qp('to') || istDay(i.issuedAt as string) <= qp('to')!)
        && (!q || [i.serial, (i.customer as Rec).name, (i.customer as Rec).phone].some((v) => String(v ?? '').toLowerCase().includes(q))))
        .sort((x, y) => Date.parse(y.issuedAt as string) - Date.parse(x.issuedAt as string) || String(y._id).localeCompare(String(x._id)));
      const limit = Number(qp('limit') ?? 50);
      let from = 0;
      const cursor = qp('cursor');
      if (cursor) {
        const [ms, id] = cursor.split('_');
        from = rows.findIndex((i) => Date.parse(i.issuedAt as string) < Number(ms) || (Date.parse(i.issuedAt as string) === Number(ms) && String(i._id) < id!));
        if (from < 0) from = rows.length;
      }
      const items = rows.slice(from, from + limit);
      const last = items.at(-1);
      const nextCursor = from + limit < rows.length && last ? `${Date.parse(last.issuedAt as string)}_${last._id}` : null;
      return json(route, 200, { success: true, data: items, pagination: { total: rows.length, nextCursor } });
    }
    const byKey = /^\/invoices\/by-key\/([A-Za-z0-9_-]+)(\/abandon)?$/.exec(sub);
    if (byKey) {
      if (!can('invoices.create')) return deny();
      if (byKey[2] && b.holdAbandon) { await b.holdAbandon; b.holdAbandon = undefined; }
      const found = b.invoices.find((i) => i.idempotencyKey === byKey[1]);
      if (byKey[2]) {
        if (found) { await ok(route, { state: 'used', invoice: found }); b.abandonAnswered = true; return; }
        b.abandoned.add(byKey[1]!);
        await ok(route, { state: 'abandoned' }); b.abandonAnswered = true; return;
      }
      return found ? ok(route, found) : fail(route, 404, 'INVOICE_NOT_FOUND', 'No bill was issued with this key');
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
      if (b.abandoned.has(idempotencyKey as string)) return fail(route, 409, 'REQUEST_ABANDONED', 'This request was cancelled before it was recorded; make a new one');
      if (b.priceChangeBeforeBill) {
        const it = b.catalogue.find((i) => i._id === b.priceChangeBeforeBill!.id)!;
        it.priceMinor = b.priceChangeBeforeBill.priceMinor; touch(it);
        b.priceChangeBeforeBill = undefined;
      }
      for (const l of x.items as Rec[]) {
        const it = l.catalogItemId ? b.catalogue.find((i) => i._id === l.catalogItemId) : undefined;
        if (it && (it.priceMinor !== l.unitPriceMinor || it.gstRate !== l.gstRate)) {
          return fail(route, 409, 'CATALOGUE_PRICE_CHANGED', `${it.name} is now ₹${((it.priceMinor as number) / 100).toFixed(2)} at ${it.gstRate}% GST; review the bill`);
        }
      }
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
      if (!one[2]) {
        if (b.failDetailReads > 0) { b.failDetailReads -= 1; return fail(route, 503, 'UNAVAILABLE', 'The service is busy; try again'); }
        return can(...readers) ? ok(route, { invoice: inv, events: events() }) : deny();
      }
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
        const hold = b.holdPay;
        if (hold) {
          b.holdPay = undefined;
          await hold;
          if (b.heldPayConflict) { b.heldPayConflict = false; await fail(route, 409, 'INVOICE_STATE_CONFLICT', 'This bill is paid'); b.heldPayAnswered = true; return; }
        }
        // Q14: splits + requestKey + expectedLifecycleVersion; paidMinor/dueMinor; partly_paid where the partner allows it.
        const raw = body as { mode?: string; splits?: { mode: string; amountMinor: number; reference?: string }[]; note?: string; requestKey: string; expectedLifecycleVersion: number };
        if (b.indexesOutdatedOnce) { b.indexesOutdatedOnce = false; return fail(route, 503, 'INVOICE_INDEXES_OUTDATED', 'Bills need a database update before payments can be recorded. Ask an admin.'); }
        // A plain method pays all that is due (a ₹0 bill: nothing).
        const x = { ...raw, splits: raw.splits ?? [{ mode: raw.mode!, amountMinor: Math.max(0, ((inv.totals as Rec).totalMinor as number) - ((inv.paidMinor as number | undefined) ?? 0)) }] };
        const total = (inv.totals as Rec).totalMinor as number;
        if (b.paidElsewhere === inv._id && inv.lifecycleState === 'issued') {
          transition('paid', { kind: 'payment', mode: 'cash', reference: 'OTHER', amountMinor: total, splits: [{ mode: 'cash', amountMinor: total, reference: 'OTHER' }] });
          inv.paidMinor = total; inv.dueMinor = 0;
        }
        const prior = events().find((e) => e.kind === 'payment' && e.requestKey === x.requestKey);
        // Q14: the same key answers the payment already recorded (`replayed` inside data).
        if (prior) return json(route, 200, { success: true, data: { invoice: { ...inv }, event: prior, replayed: true } });
        if (inv.lifecycleState === 'cancelled') return fail(route, 409, 'ALREADY_CANCELLED', 'This bill is cancelled');
        if (inv.lifecycleState === 'paid') return fail(route, 409, 'INVOICE_STATE_CONFLICT', 'This bill is paid');
        if (x.expectedLifecycleVersion !== inv.lifecycleVersion) return fail(route, 409, 'LIFECYCLE_VERSION_CONFLICT', 'The bill changed meanwhile; reload and try again');
        const paid = (inv.paidMinor as number | undefined) ?? 0;
        const amount = x.splits.reduce((n, y) => n + y.amountMinor, 0);
        if (amount > total - paid) return fail(route, 409, 'AMOUNT_EXCEEDS_DUE', `Only ${((total - paid) / 100).toFixed(2)} is due on this bill`);
        const partner = b.partners.find((y) => y._id === inv.partnerId);
        if (amount < total - paid && !partner?.allowPartPayments) return fail(route, 409, 'PART_PAYMENTS_NOT_ALLOWED', 'This partner takes full payment only');
        const one = x.splits.length === 1 ? x.splits[0]! : undefined;
        const e = transition(paid + amount >= total ? 'paid' : 'partly_paid', { kind: 'payment', ...(one ? { mode: one.mode, reference: one.reference } : {}), note: x.note,
          amountMinor: amount, splits: x.splits, requestKey: x.requestKey });
        inv.paidMinor = paid + amount; inv.dueMinor = total - paid - amount;
        if (b.loseNextPayAnswer) { b.loseNextPayAnswer = false; return route.abort('failed'); }
        return ok(route, { invoice: { ...inv }, event: e });
      }
      if (!can('invoices.cancel')) return deny();
      const x = body as Rec;
      if (inv.lifecycleState === 'cancelled') return fail(route, 409, 'ALREADY_CANCELLED', 'This bill is cancelled');
      const paidSoFar = (inv.paidMinor as number | undefined) ?? (inv.lifecycleState === 'paid' ? (inv.totals as Rec).totalMinor as number : 0);
      if (paidSoFar > 0 && !x.refund) return fail(route, 400, 'REFUND_REQUIRED', 'This bill was paid: record how the money was returned');
      if (paidSoFar === 0 && x.refund) return fail(route, 400, 'NOTHING_TO_REFUND', 'This bill was not paid');
      const refund = x.refund as Rec | undefined;
      if (refund && refund.amountMinor !== undefined && refund.amountMinor !== paidSoFar) return fail(route, 400, 'REFUND_AMOUNT_MISMATCH', `The refund must be the amount paid (${(paidSoFar / 100).toFixed(2)})`);
      const e = transition('cancelled', { kind: 'cancellation', reason: x.reason, ...(refund ? { refund: { ...refund, amountMinor: paidSoFar } } : {}) });
      inv.dueMinor = 0;
      return ok(route, { invoice: { ...inv }, event: e });
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
  await page.getByLabel('Status').selectOption('active');
  await expect(page.getByRole('row').filter({ hasText: 'Old panel' })).toHaveCount(0); // deactivated: listed only under "Deactivated"
  // Q12: searched on the server once typing stops; the text stays in the page, never in the URL.
  await page.getByLabel('Search by name or code').pressSequentially('cbc01', { delay: 40 });
  await expect(page.getByRole('row')).toHaveCount(2);
  // One request once typing stopped, not one per key.
  expect(backend.calls.filter((c) => c.path.includes('q=')).map((c) => c.path)).toEqual(['/partner-workspace/catalogue?includeInactive=true&q=cbc01']);
  expect(page.url()).not.toContain('cbc01');
  await page.getByLabel('Search by name or code').fill('zz-none');
  await expect(page.getByText('Nothing is called or coded “zz-none”.', { exact: false })).toBeVisible();
  await page.getByLabel('Search by name or code').fill('');
  await expect(page.getByRole('row').filter({ hasText: 'Thyroid profile' })).toBeVisible();

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
    visitModes: ['home', 'lab'], reportTatHours: 24, requestKey: expect.stringMatching(/^[0-9a-f]{32}$/),
  });

  await page.getByRole('button', { name: 'Edit CBC' }).click();
  await expect(page.getByLabel('Price (₹)')).toHaveValue('450');
  await page.getByLabel('Price (₹)').fill('475.25');
  await page.getByRole('button', { name: 'Save item' }).click();
  await expect(page.getByText('CBC was saved.')).toBeVisible();
  expect(backend.calls.find((c) => c.method === 'PUT')).toMatchObject({ path: `/partner-workspace/catalogue/${CBC}`,
    body: { priceMinor: 47525, expectedUpdatedAt: '2026-11-01T00:00:00.000Z' } });
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

  // Q10: deactivated items are listed for managers and can come back.
  await page.getByLabel('Status').selectOption('inactive');
  await expect(page.getByRole('row').filter({ hasText: 'Thyroid profile' })).toContainText('Deactivated');
  await page.getByRole('button', { name: 'Reactivate Old panel' }).click();
  await expect(page.getByText('Old panel is active again.')).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Old panel' })).toHaveCount(0);
  expect(backend.calls.some((c) => c.method === 'POST' && c.path === `/partner-workspace/catalogue/${OLD}/reactivate`)).toBe(true);
  expect(backend.calls.some((c) => c.path === '/partner-workspace/catalogue?includeInactive=true')).toBe(true);
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

async function issueCbcBill(page: Page) {
  await page.goto('/#/partner/invoices/new');
  await page.getByLabel('Customer name').fill('Asha Rao');
  await page.getByLabel('From the catalogue').selectOption(CBC);
  await page.getByRole('button', { name: 'Add item' }).click();
  await page.getByRole('button', { name: 'Review the bill' }).click();
  await page.getByRole('button', { name: 'Issue bill' }).click();
}

test('a bill sent just before a reload and never issued: looked up by key, then given up on the server before a new one', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.dropNextCreate = true;
  await signInPartner(page);
  await issueCbcBill(page);
  await expect(page.getByRole('group', { name: 'Unconfirmed bill' })).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify({ ...sessionStorage }))).not.toMatch(/Asha|CBC/);
  const key = (creates(backend)[0]!.body as Rec).idempotencyKey as string;

  await page.reload();
  const panel = page.getByRole('group', { name: 'Unconfirmed bill' });
  await expect(panel).toContainText('A request made earlier on this device');
  await panel.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(panel).toContainText('Not found in the records');
  await panel.getByRole('button', { name: 'Give up this bill' }).click();
  await expect(page.getByText('The earlier bill was given up: it can never be issued.')).toBeVisible();
  await expect(page.getByLabel('Customer name')).toHaveValue('');
  const paths = backend.calls.map((c) => `${c.method} ${c.path}`);
  expect(paths).toContain(`GET /partner-workspace/invoices/by-key/${key}`);
  expect(paths).toContain(`POST /partner-workspace/invoices/by-key/${key}/abandon`);
  expect(backend.abandoned.has(key)).toBe(true);
});

test('a bill issued just before a reload is found by its key and opened', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.loseNextCreateAnswer = true;
  await signInPartner(page);
  await issueCbcBill(page);
  await expect(page.getByRole('group', { name: 'Unconfirmed bill' })).toBeVisible();
  await page.reload();
  const panel = page.getByRole('group', { name: 'Unconfirmed bill' });
  await panel.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(page.getByText('Bill LB/2627/0001 had already been issued.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Bill LB/2627/0001' })).toBeVisible();
  expect(backend.invoices).toHaveLength(1);
  expect(backend.calls.some((c) => c.path.endsWith('/abandon'))).toBe(false);
});

test('an open item edit survives searching for something else (the editor is not tied to the search results)', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Price list' }).click();
  await page.getByRole('button', { name: 'Edit CBC' }).click();
  await page.getByLabel('Price (₹)').fill('499.75');
  // A search whose results do not include CBC: the edit stays open with what was typed.
  await page.getByLabel('Search by name or code').fill('thyroid');
  await expect(page.getByRole('row').filter({ hasText: 'Thyroid profile' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'CBC' })).toHaveCount(0);
  await expect(page.getByLabel('Price (₹)')).toHaveValue('499.75');
  await page.getByLabel('Search by name or code').fill('');
  await expect(page.getByRole('row').filter({ hasText: 'CBC' })).toBeVisible();
  await expect(page.getByLabel('Price (₹)')).toHaveValue('499.75');
  await page.getByRole('button', { name: 'Save item' }).click();
  await expect(page.getByText('CBC was saved.')).toBeVisible();
  expect(backend.calls.find((c) => c.method === 'PUT')).toMatchObject({ path: `/partner-workspace/catalogue/${CBC}`, body: { priceMinor: 49975 } });
});

test('a catalogue price changed after the line was added: the bill is refused, the form shows the new price, then issues', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.priceChangeBeforeBill = { id: CBC, priceMinor: 47000 };
  await signInPartner(page);
  await issueCbcBill(page);
  await expect(page.getByText('Not issued: CBC is now ₹470.00 at 0% GST; review the bill')).toBeVisible();
  await expect(page.getByText('CBC is now ₹470.00 at 0% GST. Review the bill before issuing it.')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Line 1: CBC' })).toContainText('₹470.00 each');
  await page.getByRole('button', { name: 'Review the bill' }).click();
  await page.getByRole('button', { name: 'Issue bill' }).click();
  await expect(page.getByText('Bill LB/2627/0001 issued.')).toBeVisible();
  const sent = creates(backend);
  expect(sent.map((c) => ((c.body as Rec).items as Rec[])[0]!.unitPriceMinor)).toEqual([45000, 47000]);
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
  // Q14: always as splits, with the server's request key and the bill version the payment was decided on.
  expect(backend.calls.filter((c) => c.path.endsWith('/pay')).map((c) => c.body)).toEqual([
    { splits: [{ mode: 'cash', amountMinor: 50000 }], requestKey: expect.stringMatching(/^[0-9a-f]{32}$/), expectedLifecycleVersion: 0 },
    { splits: [{ mode: 'upi', amountMinor: 100800, reference: 'UTR123' }], requestKey: expect.stringMatching(/^[0-9a-f]{32}$/), expectedLifecycleVersion: 0 },
  ]);

  // Q10: a paid bill is cancelled only with how the money went back.
  await page.getByRole('button', { name: 'Cancel bill' }).click();
  await expect(page.getByText(/It was paid \(₹1,008.00\): give the money back to the customer/)).toBeVisible();
  await page.getByRole('button', { name: 'Back' }).click();
  expect(backend.calls.some((c) => c.path.endsWith('/cancel'))).toBe(false);
  await page.getByRole('button', { name: 'Cancel bill' }).click();
  await page.getByLabel('Why is this bill cancelled?').fill('Billed to the wrong patient');
  await page.getByLabel('Money returned by').selectOption('upi');
  await page.getByLabel('Refund reference (optional)').fill('RF9');
  await page.getByRole('button', { name: 'Cancel bill LB/2627/0001' }).click();
  await expect(page.getByText('Bill LB/2627/0001 was cancelled.')).toBeVisible();
  await expect(page.getByText('Cancelled: “Billed to the wrong patient” · money returned by UPI · reference RF9')).toBeVisible();
  await expect(page.getByText('Paid by UPI · reference UTR123')).toBeVisible(); // the payment event is kept
  await expect(page.getByRole('button', { name: 'Cancel bill' })).toHaveCount(0);
  expect(backend.calls.find((c) => c.path.endsWith('/cancel'))).toMatchObject({ path: `/partner-workspace/invoices/${INV1}/cancel`,
    body: { reason: 'Billed to the wrong patient', refund: { mode: 'upi', reference: 'RF9', amountMinor: 100800 } } });

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
  expect(paths).toContain(`GET /partner-workspace/admin/${LAB}/workspace/catalogue?includeInactive=true`);
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
  expect(puts().map((c) => c.body)).toEqual([{ name: 'Complete blood count', expectedUpdatedAt: expect.any(String) }]);
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

test('a new item whose answer is lost is locked to "send again" with the same key; the server answers the item already added', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.loseNextItemAnswer = true;
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Price list' }).click();
  await page.getByRole('button', { name: 'Add an item' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Lipid profile');
  await page.getByLabel('Price (₹)').fill('450');
  await page.getByRole('button', { name: 'Add item' }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed item' });
  await expect(panel).toContainText('The outcome of this request is not known yet');
  await expect(panel).toContainText('New item: Lipid profile at ₹450.00.');
  await expect(page.getByRole('button', { name: 'Add an item' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add item' })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Send the same request again' }).click();
  await expect(page.getByText('Lipid profile was added.')).toBeVisible();
  const posts = backend.calls.filter((c) => c.method === 'POST' && c.path === '/partner-workspace/catalogue');
  expect(posts).toHaveLength(2);
  expect(posts[1]!.body).toEqual(posts[0]!.body);
  expect(backend.catalogue.filter((i) => i.name === 'Lipid profile')).toHaveLength(1);
});

test('Q12: a new item lost before a reload is checked by its key and given up on the server; one that was added is found by its key', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.dropNextItem = true;
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Price list' }).click();
  await page.getByRole('button', { name: 'Add an item' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Lipid profile');
  await page.getByLabel('Price (₹)').fill('450');
  await page.getByRole('button', { name: 'Add item' }).click();
  await expect(page.getByRole('group', { name: 'Unconfirmed item' })).toBeVisible();
  const key1 = (backend.calls.find((c) => c.method === 'POST' && c.path === '/partner-workspace/catalogue')!.body as Rec).requestKey as string;
  await page.reload();
  const panel = page.getByRole('group', { name: 'Unconfirmed item' });
  await expect(panel).toContainText('A request made earlier on this device');
  await panel.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(panel).toContainText('Not found in the records. It may still be on its way.');
  expect(backend.calls.some((c) => c.path === `/partner-workspace/catalogue/by-key/${key1}`)).toBe(true);
  await panel.getByRole('button', { name: 'Give up this item' }).click();
  await expect(page.getByText('The earlier item was given up: it can never be added. You can add it again now.')).toBeVisible();
  expect(backend.abandonedItems.has(key1)).toBe(true);
  await expect(page.getByRole('button', { name: 'Add an item' })).toBeVisible();

  // Added on the server, answer lost, then a reload: the key finds the item (no duplicate warning, no list scan).
  backend.loseNextItemAnswer = true;
  await page.getByRole('button', { name: 'Add an item' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Lipid profile');
  await page.getByLabel('Price (₹)').fill('450');
  await page.getByRole('button', { name: 'Add item' }).click();
  await expect(panel).toContainText('The outcome of this request is not known yet');
  await page.reload();
  await panel.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(page.getByText('Lipid profile had already been added.')).toBeVisible();
  await expect(panel).toHaveCount(0);
  expect(backend.catalogue.filter((i) => i.name === 'Lipid profile')).toHaveLength(1);
  expect(await page.evaluate(() => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }))).not.toMatch(/Lipid|45000/);
});

test('Q12: a resend of an item whose key was given up elsewhere is refused for good, and the form opens again', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.dropNextItem = true;
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Price list' }).click();
  await page.getByRole('button', { name: 'Add an item' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Lipid profile');
  await page.getByLabel('Price (₹)').fill('450');
  await page.getByRole('button', { name: 'Add item' }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed item' });
  await expect(panel).toContainText('The outcome of this request is not known yet');
  const key = (backend.calls.find((c) => c.method === 'POST' && c.path === '/partner-workspace/catalogue')!.body as Rec).requestKey as string;
  backend.abandonedItems.add(key); // given up in another tab after a reload
  await panel.getByRole('button', { name: 'Send the same request again' }).click();
  await expect(page.getByText('This item was given up earlier, so it was never added and never will be.', { exact: false })).toBeVisible();
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add an item' })).toBeVisible();
  expect(backend.catalogue.filter((i) => i.name === 'Lipid profile')).toHaveLength(0);
});

test('an item edit that someone else saved in between is refused (expectedUpdatedAt) and shown again', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Price list' }).click();
  await page.getByRole('button', { name: 'Edit CBC' }).click();
  await page.getByLabel('Price (₹)').fill('480');
  backend.changeAfterRead = { priceMinor: 49000 };
  await page.getByRole('button', { name: 'Save item' }).click();
  // Refused by the server (409 CATALOGUE_ITEM_CHANGED); the form then follows the saved item and flags the price.
  await expect(page.getByText(/Someone else changed the price while you were editing/)).toBeVisible();
  await expect(page.getByLabel('Price (₹)')).toHaveValue('490');
  const put = backend.calls.find((c) => c.method === 'PUT');
  expect(put?.body).toEqual({ priceMinor: 48000, expectedUpdatedAt: '2026-11-01T00:00:00.000Z' });
  expect(backend.catalogue.find((i) => i._id === CBC)!.priceMinor).toBe(49000);
});

test('clinic price list: consultations, procedures, packages and other items, without visit modes', async ({ page }) => {
  const backend = await mockBackend(page, owner(CLINIC));
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Price list' }).click();
  await expect(page.getByRole('heading', { name: 'Services and prices' })).toBeVisible();
  await page.getByRole('button', { name: 'Add an item' }).click();
  await expect(page.getByRole('group', { name: 'Type' }).getByRole('radio')).toHaveCount(4);
  await expect(page.getByText('Where it is offered')).toHaveCount(0);
  await page.getByLabel('Procedure').check();
  await page.getByLabel('Name', { exact: true }).fill('Dressing');
  await page.getByLabel('Price (₹)').fill('250');
  await page.getByRole('button', { name: 'Add item' }).click();
  await expect(page.getByText('Dressing was added.')).toBeVisible();
  expect(backend.calls.find((c) => c.method === 'POST' && c.path === '/partner-workspace/catalogue')?.body)
    .toEqual({ kind: 'procedure', name: 'Dressing', priceMinor: 25000, gstRate: 0, requestKey: expect.any(String) });
  await expect(page.getByRole('row').filter({ hasText: 'Dressing' })).toContainText('Procedure');
});

test('bills list: exact cursor paging, total, search and date range from the server', async ({ page }) => {
  const backend = await mockBackend(page, owner(), { many: 52 });
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Bills' }).click();
  await expect(page.getByText('52 bills · showing 50')).toBeVisible();
  await page.getByRole('button', { name: 'Show older bills' }).click();
  await expect(page.getByText('52 bills · showing 52')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show older bills' })).toHaveCount(0);
  const lists = backend.calls.filter((c) => c.path.startsWith('/partner-workspace/invoices?'));
  // The 50th bill (#3) shares its instant with the 51st (#2): the cursor carries the id, so neither is skipped nor repeated.
  expect(lists[1]!.path).toMatch(/^\/partner-workspace\/invoices\?limit=50&cursor=\d+_ab0+2$/);
  const serials = await page.getByRole('row').locator('td:first-child').allTextContents();
  expect(new Set(serials).size).toBe(52);

  await page.getByLabel('Bill number, customer name or phone').fill('Meena');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByText('1 bill match · showing 1')).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Meena Iyer' })).toHaveCount(1);
  await page.getByLabel('Issued from').fill('2026-11-02');
  await expect(page.getByText('No bill matches these filters.')).toBeVisible();
  expect(backend.calls.some((c) => c.path === '/partner-workspace/invoices?from=2026-11-02&q=Meena&limit=50')).toBe(true);
  await page.getByLabel('Issued to').fill('2026-11-01');
  await expect(page.getByText('The “from” date is after the “to” date.')).toBeVisible();
});

test('pay and cancel are one at a time; a lost payment answer is resent unchanged and the server answers the same payment', async ({ page }) => {
  const backend = await mockBackend(page, owner(), { seed: true });
  await signInPartner(page);
  await page.goto(`/#/partner/invoices/${INV1}`);
  // While a payment is on its way, a cancellation cannot start.
  let release!: () => void;
  backend.holdPay = new Promise<void>((r) => { release = r; });
  await page.getByRole('button', { name: 'Record payment' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Record ₹1,008.00 paid' }).click();
  await expect(page.getByRole('button', { name: 'Cancel bill' })).toBeDisabled();
  // Its answer is lost, and reading the bill fails in the same outage: nothing can settle it but a resend.
  backend.loseNextPayAnswer = true;
  backend.failDetailReads = 50;
  release();
  backend.holdPay = undefined;
  const unsure = page.getByRole('group', { name: 'Unconfirmed payment' });
  await expect(unsure).toContainText('We could not confirm the payment of ₹1,008.00 by Cash');
  await expect(page.getByRole('button', { name: 'Cancel bill' })).toBeDisabled();
  await unsure.getByRole('button', { name: 'Send the same payment again' }).click();
  // Q12: the replay flag is read inside `data`.
  await expect(page.getByText('Payment recorded. It had already been recorded: nothing was recorded twice.')).toBeVisible();
  backend.failDetailReads = 0;
  await expect(unsure).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel bill' })).toBeEnabled();
  const pays = backend.calls.filter((c) => c.path.endsWith('/pay'));
  // The same payment twice: the same key, the same content.
  expect(pays.map((c) => c.body)).toEqual([pays[0]!.body, pays[0]!.body]);
  expect(pays[0]!.body).toEqual({ splits: [{ mode: 'cash', amountMinor: 100800 }], requestKey: expect.stringMatching(/^[0-9a-f]{32}$/), expectedLifecycleVersion: 0 });
  expect(backend.events.filter((e) => e.kind === 'payment')).toHaveLength(1);
  await expect(page.getByText(/^Paid by Cash/)).toHaveCount(1);
});

test('a lost UPI payment survives a failed refresh: the exact payment stays, no other can start, and the receipt settles it', async ({ page }) => {
  const backend = await mockBackend(page, owner(), { seed: true });
  await signInPartner(page);
  await page.goto(`/#/partner/invoices/${INV1}`);
  backend.loseNextPayAnswer = true;
  backend.failDetailReads = 50;
  await page.getByRole('button', { name: 'Record payment' }).click();
  await page.getByLabel('Paid by').selectOption('upi');
  await page.getByLabel('Reference (optional)').fill('UTR9');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Record ₹1,008.00 paid' }).click();
  const unsure = page.getByRole('group', { name: 'Unconfirmed payment' });
  await expect(unsure).toContainText('by UPI (reference UTR9)');
  await expect(page.getByText(/Could not refresh the bill: The service is busy/)).toBeVisible();
  // The bill (as last read) stays on screen; no fresh Cash form is offered and cancelling stays locked.
  await expect(page.getByRole('heading', { name: 'Bill LB/2627/0001' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Record payment' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel bill' })).toBeDisabled();
  // Leaving and coming back keeps it (session memory, not the form).
  await page.getByRole('link', { name: 'Back to bills' }).click();
  await page.goto(`/#/partner/invoices/${INV1}`);
  await expect(page.getByRole('group', { name: 'Unconfirmed payment' })).toContainText('by UPI (reference UTR9)');
  // The service is back: the bill shows that very payment, which settles it without sending anything again.
  backend.failDetailReads = 0;
  const retry = page.getByRole('button', { name: 'Try again' });
  if (await retry.count()) await retry.first().click();
  await expect(page.getByText('Payment recorded.')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Unconfirmed payment' })).toHaveCount(0);
  await expect(page.getByText('Paid by UPI · reference UTR9')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel bill' })).toBeEnabled();
  expect(backend.calls.filter((c) => c.path.endsWith('/pay'))).toHaveLength(1);
});

test('a payment from a page that was left: another page shows it instead of a new form, and its late 409 does not erase the newer attempt', async ({ page }) => {
  const backend = await mockBackend(page, owner(), { seed: true });
  await signInPartner(page);
  await page.goto(`/#/partner/invoices/${INV1}`);
  // Page A sends UPI/UTR-A; its request is held (it will lose the compare-and-set: 409).
  let release!: () => void;
  backend.holdPay = new Promise<void>((r) => { release = r; });
  backend.heldPayConflict = true;
  await page.getByRole('button', { name: 'Record payment' }).click();
  await page.getByLabel('Paid by').selectOption('upi');
  await page.getByLabel('Reference (optional)').fill('UTR-A');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Record ₹1,008.00 paid' }).click();
  await expect(page.getByRole('group', { name: 'Unconfirmed payment' })).toContainText('is being sent');
  // A is left; page B opens: it shows A's payment (stored before it was sent), not a new form; cancel is locked.
  await page.getByRole('link', { name: 'Back to bills' }).click();
  await page.goto(`/#/partner/invoices/${INV1}`);
  const b = page.getByRole('group', { name: 'Unconfirmed payment' });
  await expect(b).toContainText('by UPI (reference UTR-A)');
  await expect(page.getByRole('button', { name: 'Record payment' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel bill' })).toBeDisabled();
  // B resends it (attempt 2): recorded, but its answer is lost and reads fail.
  backend.loseNextPayAnswer = true;
  backend.failDetailReads = 50;
  await b.getByRole('button', { name: 'Send the same payment again' }).click();
  await expect(b).toContainText('We could not confirm the payment of ₹1,008.00 by UPI (reference UTR-A)');
  // A's delayed 409 arrives now. It must not touch B's record.
  release();
  await expect.poll(() => backend.heldPayAnswered).toBe(true);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 100)));
  await page.getByRole('link', { name: 'Back to bills' }).click();
  await page.goto(`/#/partner/invoices/${INV1}`);
  await expect(page.getByRole('group', { name: 'Unconfirmed payment' })).toContainText('We could not confirm the payment of ₹1,008.00 by UPI (reference UTR-A)');
  await expect(page.getByRole('button', { name: 'Record payment' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel bill' })).toBeDisabled();
  // Reads work again: the bill's receipt settles it.
  backend.failDetailReads = 0;
  await page.getByRole('group', { name: 'Unconfirmed payment' }).getByRole('button', { name: 'Check the bill' }).click();
  await expect(page.getByText('Payment recorded.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel bill' })).toBeEnabled();
  expect(backend.events.filter((e) => e.kind === 'payment')).toHaveLength(1);
});

test('a payment sent just before a reload: only the bill settles it; a new one is offered only once the bill is read unpaid', async ({ page }) => {
  const backend = await mockBackend(page, owner(), { seed: true });
  await signInPartner(page);
  await page.goto(`/#/partner/invoices/${INV1}`);
  let release!: () => void;
  backend.holdPay = new Promise<void>((r) => { release = r; });
  backend.heldPayConflict = true; // never recorded
  await page.getByRole('button', { name: 'Record payment' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Record ₹1,008.00 paid' }).click();
  await expect(page.getByRole('group', { name: 'Unconfirmed payment' })).toContainText('is being sent');
  await page.reload();
  const panel = page.getByRole('group', { name: 'Unconfirmed payment' });
  await expect(panel).toContainText('was sent from this device before the page was reloaded');
  await expect(page.getByRole('button', { name: 'Record payment' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel bill' })).toBeDisabled();
  release();
  await panel.getByRole('button', { name: 'Check the bill' }).click();
  await panel.getByRole('button', { name: 'Record the payment again' }).click();
  await panel.getByRole('button', { name: 'The bill is unpaid: record it again' }).click();
  await expect(page.getByRole('button', { name: 'Record payment' })).toBeEnabled();
});

test('a give-up answer from a page that was left does not settle the bill a returned page is resending', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.dropNextCreate = true;
  await signInPartner(page);
  await issueCbcBill(page);
  const panelA = page.getByRole('group', { name: 'Unconfirmed bill' });
  await panelA.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(panelA).toContainText('Not recorded so far');
  // Page A asks to give up K1; the answer is held.
  let release!: () => void;
  backend.holdAbandon = new Promise<void>((r) => { release = r; });
  await panelA.getByRole('button', { name: 'Give up this bill' }).click();
  // The person leaves and opens the new bill again (page B): it resends K1 (attempt 2), whose answer is lost.
  await page.goto('/#/partner/invoices');
  await page.goto('/#/partner/invoices/new');
  backend.loseNextCreateAnswer = true;
  const panelB = page.getByRole('group', { name: 'Unconfirmed bill' });
  await panelB.getByRole('button', { name: 'Send the same request again' }).click();
  await expect(panelB).toContainText('Could not reach the server');
  // Page A's late answer: "used" (B's resend issued the bill). It must not settle B's attempt.
  release();
  await expect.poll(() => backend.abandonAnswered).toBe(true);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 100)));
  const key = (creates(backend)[0]!.body as Rec).idempotencyKey as string;
  expect(await page.evaluate((k) => Object.values({ ...sessionStorage }).some((v) => v.includes(k)), key)).toBe(true);
  await page.goto('/#/partner/invoices');
  await page.goto('/#/partner/invoices/new');
  const panelC = page.getByRole('group', { name: 'Unconfirmed bill' });
  await expect(panelC).toBeVisible(); // not a fresh form: no second bill under a new key
  await panelC.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(page.getByText('Bill LB/2627/0001 had already been issued.')).toBeVisible();
  expect(backend.invoices).toHaveLength(1);
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

test('Q14 part payments: the owner allows them (version-fenced); a bill is paid in parts and split methods, never more than is due; cancelling refunds all that was paid', async ({ page }) => {
  const backend = await mockBackend(page, owner(), { seed: true });
  await signInPartner(page);
  await page.goto('/#/partner');
  const policy = page.getByRole('region', { name: 'Payments at the counter' });
  await expect(policy).toContainText('Full payment only: each payment settles everything still due');
  await policy.getByLabel('Allow part payments of bills').check();
  await expect(policy).toContainText('After saving: Part payments are allowed');
  await policy.getByRole('button', { name: 'Save payment setting' }).click();
  await expect(policy.getByText('After saving:', { exact: false })).toHaveCount(0);
  await expect(policy).toContainText('Part payments are allowed: a bill can be paid in several payments');
  expect(backend.calls.find((c) => c.method === 'PUT' && c.path === '/partner-workspace/me')?.body).toEqual({ allowPartPayments: true, expectedUpdatedAt: '2026-11-01T00:00:00.000Z' });

  await page.goto(`/#/partner/invoices/${INV1}`);
  await page.getByRole('button', { name: 'Record payment' }).click();
  await expect(page.getByText('₹1,008.00 is due. Any amount up to that can be recorded; the rest stays due on the bill.')).toBeVisible();
  await page.getByLabel('Amount (₹)', { exact: true }).fill('300');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Record ₹300.00 as paid by Cash for bill LB/2627/0001? ₹708.00 stays due: the bill will show Partly paid.')).toBeVisible();
  await page.getByRole('button', { name: 'Record ₹300.00 paid' }).click();
  await expect(page.getByText('Payment recorded.')).toBeVisible();
  await expect(page.getByText('Partly paid', { exact: true })).toBeVisible();
  const paidDue = page.locator('dl[aria-label="Paid and due"]');
  await expect(paidDue).toContainText('Paid₹300.00 of ₹1,008.00');
  await expect(paidDue).toContainText('Due₹708.00');

  // The rest, split across two methods; more than is due is caught before sending.
  await page.getByRole('button', { name: 'Record payment' }).click();
  await expect(page.getByLabel('Amount (₹)', { exact: true })).toHaveValue('708');
  await page.getByLabel('Amount (₹)', { exact: true }).fill('800');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('That is more than is due (₹708.00). A bill is never paid more than what is due.')).toBeVisible();
  await page.getByLabel('Amount (₹)', { exact: true }).fill('208');
  await page.getByRole('button', { name: 'Add another method' }).click();
  await expect(page.getByLabel('Amount (₹) (method 2)')).toHaveValue('500');
  await page.getByLabel('Reference (optional) (method 2)').fill('UPI77');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Record ₹708.00 as paid by Cash ₹208.00 + UPI ₹500.00 (reference UPI77) for bill LB/2627/0001? The bill will show Paid.')).toBeVisible();
  await page.getByRole('button', { name: 'Record ₹708.00 paid' }).click();
  await expect(page.getByText('Paid by Cash ₹208.00 + UPI ₹500.00 (reference UPI77) · ₹708.00 in all')).toBeVisible();
  await expect(page.getByText('Paid by Cash · ₹300.00')).toBeVisible();
  await expect(paidDue).toContainText('Due₹0.00');
  const pays = backend.calls.filter((c) => c.path.endsWith('/pay')).map((c) => c.body as Rec);
  expect(pays[0]).toEqual({ splits: [{ mode: 'cash', amountMinor: 30000 }], requestKey: expect.stringMatching(/^[0-9a-f]{32}$/), expectedLifecycleVersion: 0 });
  expect(pays[1]).toEqual({ splits: [{ mode: 'cash', amountMinor: 20800 }, { mode: 'upi', amountMinor: 50000, reference: 'UPI77' }],
    requestKey: expect.stringMatching(/^[0-9a-f]{32}$/), expectedLifecycleVersion: 1 });
  expect(pays[1]!.requestKey).not.toBe(pays[0]!.requestKey);

  // Cancelling a bill with payments records a refund of all that was paid.
  await page.getByRole('button', { name: 'Cancel bill' }).click();
  await expect(page.getByText('The refund recorded is ₹1,008.00, all that was paid.', { exact: false })).toBeVisible();
  await page.getByLabel('Why is this bill cancelled?').fill('Wrong patient');
  await page.getByRole('button', { name: 'Cancel bill LB/2627/0001' }).click();
  await expect(page.getByText('· ₹1,008.00 returned')).toBeVisible();
  expect(backend.calls.find((c) => c.path.endsWith('/cancel'))?.body).toEqual({ reason: 'Wrong patient', refund: { mode: 'cash', amountMinor: 100800 } });

  // The bills list filters partly paid bills.
  await page.goto('/#/partner/invoices');
  await page.getByLabel('Status').selectOption('partly_paid');
  await expect.poll(() => backend.calls.some((c) => c.path === '/partner-workspace/invoices?state=partly_paid&limit=50')).toBe(true);
});

test('Q14 full payment only (the default): a part is refused before sending; a payment the bill moved past is refused (version) and the bill read again', async ({ page }) => {
  const backend = await mockBackend(page, owner(), { seed: true });
  await signInPartner(page);
  await page.goto(`/#/partner/invoices/${INV1}`);
  await page.getByRole('button', { name: 'Record payment' }).click();
  await expect(page.getByText('Only full payment is taken: the amounts must add up to all that is due.', { exact: false })).toBeVisible();
  await page.getByLabel('Amount (₹)', { exact: true }).fill('500');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Only full payment is taken here: the amounts must add up to ₹1,008.00.')).toBeVisible();
  expect(backend.calls.filter((c) => c.path.endsWith('/pay'))).toHaveLength(0);
  await page.getByLabel('Amount (₹)', { exact: true }).fill('1008');
  await page.getByRole('button', { name: 'Continue' }).click();
  // The bill moves on meanwhile (another change in another tab): the payment names version 0 and is refused.
  backend.invoices.find((i) => i._id === INV1)!.lifecycleVersion = 1;
  await page.getByRole('button', { name: 'Record ₹1,008.00 paid' }).click();
  await expect(page.getByText('Payment not recorded: The bill changed while you were recording this (another payment or a cancellation), so nothing was recorded.', { exact: false })).toBeVisible();
  expect(backend.calls.filter((c) => c.path.endsWith('/pay')).map((c) => (c.body as Rec).expectedLifecycleVersion)).toEqual([0]);
});

test('Q14 review: a ₹0 bill is marked paid with a plain method; a payment refused because bill indexes are outdated says so and records nothing', async ({ page }) => {
  const backend = await mockBackend(page, owner(), { seed: true });
  const inv = backend.invoices.find((i) => i._id === INV2)!;
  inv.totals = { ...(inv.totals as Rec), totalMinor: 0, subtotalMinor: 0, taxableMinor: 0 };
  await signInPartner(page);
  await page.goto(`/#/partner/invoices/${INV2}`);
  await page.getByRole('button', { name: 'Record payment' }).click();
  await page.getByLabel('Paid by').selectOption('upi');
  await expect(page.getByText('Bill LB/2627/0002 is for ₹0.00. Mark it as paid?', { exact: false })).toBeVisible();
  backend.indexesOutdatedOnce = true;
  await page.getByRole('button', { name: 'Mark as paid' }).click();
  await expect(page.getByText('Payment not recorded: Bills need a database update before payments can be recorded. Ask an admin.')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Unconfirmed payment' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Record payment' }).click();
  await page.getByRole('button', { name: 'Mark as paid' }).click();
  await expect(page.getByText('Payment recorded.')).toBeVisible();
  const pays = backend.calls.filter((c) => c.path.endsWith('/pay')).map((c) => c.body as Rec);
  expect(pays[1]).toEqual({ mode: 'cash', requestKey: expect.stringMatching(/^[0-9a-f]{32}$/), expectedLifecycleVersion: 0 });
});
