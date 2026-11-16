import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type Route } from '@playwright/test';

/** WQ5: partner finance (members and admins as owner) and admin settlements, payouts and adjustments, against a mocked backend. */
const LAB = 'a1'.repeat(12);
const LAB2 = 'a3'.repeat(12);
const OWNER = 'b1'.repeat(12);
const STAFF = 'b2'.repeat(12);
const ADMIN = 'ad'.repeat(12);
const DOC = 'd7'.repeat(12);
const ACC1 = 'c1'.repeat(12);
const ACC2 = 'c2'.repeat(12);
const ACC3 = 'c3'.repeat(12);
const PO1 = 'f1'.repeat(12);
const ALL = ['staff.manage', 'branches.manage', 'catalogue.manage', 'slots.manage', 'bookings.view', 'bookings.manage', 'reports.upload',
  'reports.release', 'invoices.create', 'invoices.cancel', 'payments.record', 'finance.view'];
/** Monday 16 Nov 2026, 12:00 in India. */
const NOW = new Date('2026-11-16T06:30:00.000Z');
const DAY = 86_400_000;

type Rec = Record<string, unknown>;
interface Me { _id: string; partnerId: string; name: string; role: 'owner' | 'staff'; permissions: string[]; branchIds: string[] }
interface Call { method: string; path: string; body: unknown; auth?: string }
interface Account {
  _id: string; ownerKind: 'partner' | 'doctor'; ownerId: string; beneficiaryName: string; isActive: boolean;
  details: Rec | null; state: 'none' | 'unverified' | 'verified'; version: number; changedAt?: string; verifiedAt?: string;
  /** Q13: bumped by payouts, voids, adjustments, destination changes and verifications. */
  financeVersion?: number;
}
interface Entry { _id: string; accountId: string; at: string; kind: string; source: string; sourceId: string; description: string; reference?: string; note?: string; amountMinor: number }
interface Payout extends Rec { _id: string; settlementAccountId: string; amountMinor: number; reference: string; paidOn: string; state: string; by: string; requestKey: string; requestHash: string; createdAt: string }
interface Backend {
  calls: Call[]; me: Me; accounts: Account[]; entries: Entry[]; payouts: Payout[]; events: Rec[]; live: boolean;
  loseNextPayoutAnswer?: boolean; loseNextAdjustmentAnswer?: boolean; changeDetailsBeforeNextPayout?: boolean;
  /** Q13: the next payout or adjustment request never reaches the server. */
  dropNext?: RegExp;
  /** Q13: keys given up on the server (`settlement_payout:` / `settlement_adjustment:` scopes): they can never record. */
  abandoned: Set<string>;
  /** Q13: someone else saves new details right after the next account read is answered (before this person's PUT). */
  changeDetailsAfterNextRead?: boolean;
  /** The next request whose path matches waits for `release()` before the server looks at it. */
  holdBefore?: { match: RegExp; gate: Promise<void> };
  /** The server has acted on the next matching request; its answer waits for `release()`. */
  holdAfter?: { match: RegExp; gate: Promise<void> };
  /** The server acts on the next matching request (a replay included) and its answer is lost. */
  loseNext?: RegExp;
}

let seq = 0;
const oid = (prefix: string) => `${prefix}${String(++seq).padStart(24 - prefix.length, '0')}`;
const istStart = (date: string) => Date.parse(`${date}T00:00:00+05:30`);

function seed(): Pick<Backend, 'accounts' | 'entries' | 'payouts' | 'events'> {
  const accounts: Account[] = [
    { _id: ACC1, ownerKind: 'partner', ownerId: LAB, beneficiaryName: 'City Lab', isActive: true, state: 'verified', version: 1,
      details: { method: 'bank', accountName: 'City Lab Pvt Ltd', accountNumber: '123456789012', accountNumberLast4: '9012', ifsc: 'HDFC0001234', bankName: 'HDFC' },
      changedAt: '2026-10-01T05:00:00.000Z', verifiedAt: '2026-10-02T05:00:00.000Z' },
    { _id: ACC2, ownerKind: 'doctor', ownerId: DOC, beneficiaryName: 'Dr Meera Rao', isActive: true, state: 'unverified', version: 1,
      details: { method: 'upi', upiId: 'meera@okaxis' }, changedAt: '2026-11-10T05:00:00.000Z' },
    { _id: ACC3, ownerKind: 'partner', ownerId: LAB2, beneficiaryName: 'Lake Lab', isActive: true, state: 'none', version: 0, details: null },
  ];
  // 50 more accounts with nothing due, so the admin list has a second page.
  for (let i = 1; i <= 50; i++) {
    accounts.push({ _id: `e0${String(i).padStart(22, '0')}`, ownerKind: 'doctor', ownerId: `e9${String(i).padStart(22, '0')}`,
      beneficiaryName: `Dr Filler ${String(i).padStart(2, '0')}`, isActive: true, state: 'none', version: 0, details: null });
  }
  const entries: Entry[] = [];
  const t0 = Date.parse('2026-09-15T05:00:00.000Z');
  for (let i = 0; i < 55; i++) {
    const at = new Date(t0 + i * DAY).toISOString();
    entries.push({ _id: `ee${String(i + 1).padStart(22, '0')}`, accountId: ACC1, at, kind: 'earning', source: 'partner_lab_booking', sourceId: oid('9b'),
      description: `Lab booking · ${at.slice(0, 10)} 09:00 · Asha`, amountMinor: 45000 });
  }
  entries.push({ _id: 'ef'.repeat(12), accountId: ACC1, at: '2026-11-01T06:00:00.000Z', kind: 'payout', source: 'payout', sourceId: PO1,
    description: 'Payout · 2026-11-01 · HDFC HDFC0001234 XXXX9012', reference: 'UTR0001', amountMinor: -1_000_000 });
  entries.push({ _id: oid('ed'), accountId: ACC2, at: '2026-11-05T05:00:00.000Z', kind: 'earning', source: 'consultation', sourceId: oid('9c'), description: 'Consultation · 2026-11-05 10:00', amountMinor: 150000 });
  entries.push({ _id: oid('ed'), accountId: ACC2, at: '2026-11-06T05:00:00.000Z', kind: 'earning', source: 'consultation', sourceId: oid('9c'), description: 'Consultation · 2026-11-06 10:00', amountMinor: 150000 });
  const payouts: Payout[] = [{
    _id: PO1, settlementAccountId: ACC1, amountMinor: 1_000_000, method: 'bank_transfer', reference: 'UTR0001', paidOn: '2026-11-01',
    destination: { method: 'bank', label: 'HDFC HDFC0001234 XXXX9012', detailsVersion: 1 }, state: 'recorded', by: ADMIN,
    requestKey: 'seededkey0001', requestHash: '-', createdAt: '2026-11-01T06:00:00.000Z',
  }];
  const events: Rec[] = [
    { _id: oid('ea'), settlementAccountId: ACC1, action: 'finance.payout_recorded', byKind: 'admin', by: ADMIN, at: '2026-11-01T06:00:00.000Z',
      detail: { payoutId: PO1, amountMinor: 1_000_000, reference: 'UTR0001', paidOn: '2026-11-01' } },
    { _id: oid('ea'), settlementAccountId: ACC1, action: 'finance.payout_details_verified', byKind: 'admin', by: ADMIN, at: '2026-10-02T05:00:00.000Z', detail: { version: 1 } },
    { _id: oid('ea'), settlementAccountId: ACC1, action: 'finance.payout_details_changed', byKind: 'member', by: OWNER, at: '2026-10-01T05:00:00.000Z',
      detail: { method: 'bank', last4: '9012', ifsc: 'HDFC0001234', version: 1 } },
  ];
  return { accounts, entries, payouts, events };
}

const owner = (): Me => ({ _id: OWNER, partnerId: LAB, name: 'Ravi Owner', role: 'owner', permissions: ALL, branchIds: [] });
const staff = (permissions: string[], branchIds: string[] = []): Me => ({ _id: STAFF, partnerId: LAB, name: 'Sita Staff', role: 'staff', permissions, branchIds });

async function mockBackend(page: Page, me: Me = owner()): Promise<Backend> {
  await page.clock.setFixedTime(NOW);
  const b: Backend = { calls: [], me, live: false, abandoned: new Set(), ...seed() };
  const partners: Rec[] = [
    { _id: LAB, kind: 'lab', name: 'City Lab', contact: { phone: '9000000000' }, verification: { state: 'verified' }, taxRegime: 'unregistered', invoiceSeries: { prefix: 'LB' }, activeOwnerCount: 1, isActive: true },
    { _id: LAB2, kind: 'lab', name: 'Lake Lab', contact: { phone: '9000000009' }, verification: { state: 'verified' }, taxRegime: 'unregistered', invoiceSeries: { prefix: 'LK' }, activeOwnerCount: 1, isActive: true },
  ];
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const ok = (route: Route, data: unknown, status = 200) => json(route, status, { success: true, data });
  const fail = (route: Route, status: number, code: string, message: string) => json(route, status, { error: status, code, message });

  const balance = (id: string) => b.entries.filter((e) => e.accountId === id).reduce((s, e) => s + e.amountMinor, 0);
  const view = (a: Account, full: boolean) => {
    const d = a.details as Rec | null;
    const details = !d ? null : d.method === 'upi' ? { method: 'upi', upiId: d.upiId, accountName: d.accountName }
      : { method: 'bank', accountName: d.accountName, ifsc: d.ifsc, bankName: d.bankName, accountNumberLast4: d.accountNumberLast4,
        ...(full ? { accountNumber: d.accountNumber } : { accountNumberMasked: `XXXX${String(d.accountNumber).slice(-4)}` }) };
    return { _id: a._id, ownerKind: a.ownerKind, ownerId: a.ownerId, beneficiaryName: a.beneficiaryName, isActive: a.isActive, payoutDetails: details,
      payoutDetailsState: a.state, payoutDetailsVersion: a.version, payoutDetailsChangedAt: a.changedAt, payoutDetailsVerifiedAt: a.verifiedAt,
      financeVersion: a.financeVersion ?? 0 };
  };
  const bump = (a: Account) => { a.financeVersion = (a.financeVersion ?? 0) + 1; };
  /** Q13 `cursorPage`: newest first by `field`, ties by id, an exact `<ms>_<id>` cursor and the total. */
  const paged = (route: Route, rows: Rec[], field: 'createdAt' | 'at', q: URLSearchParams, def: number) => {
    const sorted = [...rows].sort((x, y) => Date.parse(String(y[field])) - Date.parse(String(x[field])) || String(y._id).localeCompare(String(x._id)));
    const limit = Number(q.get('limit') ?? def);
    const cursor = q.get('cursor');
    let from = 0;
    if (cursor) {
      if (!/^\d{1,15}_[0-9a-f]{24}$/.test(cursor)) return fail(route, 400, 'INVALID_CURSOR', 'Invalid cursor');
      const [ms, id] = cursor.split('_');
      from = sorted.findIndex((r) => Date.parse(String(r[field])) < Number(ms) || (Date.parse(String(r[field])) === Number(ms) && String(r._id) < id!));
      if (from < 0) from = sorted.length;
    }
    const items = sorted.slice(from, from + limit);
    const last = items.at(-1);
    const nextCursor = from + limit < sorted.length && last ? `${Date.parse(String(last[field]))}_${last._id}` : null;
    return json(route, 200, { success: true, data: items, pagination: { total: sorted.length, nextCursor } });
  };
  const publicPayout = (p: Payout) => { const { requestKey: _k, requestHash: _h, ...rest } = p; return rest; };
  const summary = (a: Account | undefined, full: boolean) => {
    if (!a) return { account: null, balanceMinor: 0, totals: { earnedMinor: 0, reversedMinor: 0, paidOutMinor: 0, adjustedMinor: 0 }, lastPayout: null };
    const sum = (k: string) => b.entries.filter((e) => e.accountId === a._id && e.kind === k).reduce((s, e) => s + e.amountMinor, 0);
    const last = b.payouts.filter((p) => p.settlementAccountId === a._id && p.state === 'recorded').sort((x, y) => y.createdAt.localeCompare(x.createdAt))[0];
    return { account: view(a, full), balanceMinor: balance(a._id),
      totals: { earnedMinor: sum('earning'), reversedMinor: -sum('reversal'), paidOutMinor: -sum('payout'), adjustedMinor: sum('adjustment') },
      lastPayout: last ? publicPayout(last) : null };
  };
  const order = (x: Entry, y: Entry) => Date.parse(x.at) - Date.parse(y.at) || x._id.localeCompare(y._id);
  const inPeriod = (e: Entry, q: URLSearchParams) => {
    const from = q.get('from'); const to = q.get('to');
    return (!from || Date.parse(e.at) >= istStart(from)) && (!to || Date.parse(e.at) < istStart(to) + DAY);
  };
  const statement = (id: string, q: URLSearchParams) => {
    const all = b.entries.filter((e) => e.accountId === id).sort(order);
    const after = new Map<string, number>();
    let run = 0;
    for (const e of all) { run += e.amountMinor; after.set(e._id, run); }
    let rows = all.filter((e) => inPeriod(e, q)).reverse();
    const before = q.get('before');
    if (before) {
      const [ms, cid] = before.split('_');
      rows = rows.filter((e) => Date.parse(e.at) < Number(ms) || (Date.parse(e.at) === Number(ms) && e._id < cid!));
    }
    const limit = Number(q.get('limit') ?? 50);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { lines: page.map((e) => ({ _id: e._id, at: e.at, kind: e.kind, source: e.source, sourceId: e.sourceId, description: e.description,
      reference: e.reference, note: e.note, amountMinor: e.amountMinor, balanceAfterMinor: after.get(e._id) })),
    nextCursor: rows.length > limit && last ? `${Date.parse(last.at)}_${last._id}` : null };
  };
  const csv = (id: string, q: URLSearchParams) => {
    const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = b.entries.filter((e) => e.accountId === id && inPeriod(e, q)).sort(order);
    const from = q.get('from');
    let bal = from ? b.entries.filter((e) => e.accountId === id && Date.parse(e.at) < istStart(from)).reduce((s, e) => s + e.amountMinor, 0) : 0;
    const out = [['Date (IST)', 'Type', 'Description', 'Reference', 'Note', 'Amount (INR)', 'Balance (INR)'].map(cell).join(','),
      ['', 'Opening balance', '', '', '', '', (bal / 100).toFixed(2)].map(cell).join(',')];
    for (const e of rows) { bal += e.amountMinor; out.push([e.at, e.kind, e.description, e.reference, e.note, (e.amountMinor / 100).toFixed(2), (bal / 100).toFixed(2)].map(cell).join(',')); }
    out.push(['', 'Closing balance', '', '', '', '', (bal / 100).toFixed(2)].map(cell).join(','));
    return `${out.join('\n')}\n`;
  };
  const event = (a: Account, action: string, byKind: string, by: string, detail: Rec) =>
    b.events.unshift({ _id: oid('ea'), settlementAccountId: a._id, action, byKind, by, detail, at: NOW.toISOString() });
  const setDetails = (a: Account, body: Rec, byKind: string, by: string) => {
    const details = body.method === 'bank'
      ? { method: 'bank', accountName: body.accountName, accountNumber: body.accountNumber, accountNumberLast4: String(body.accountNumber).slice(-4), ifsc: body.ifsc, bankName: body.bankName }
      : { method: 'upi', upiId: body.upiId, accountName: body.accountName };
    Object.assign(a, { details, state: 'unverified', version: a.version + 1, changedAt: NOW.toISOString(), verifiedAt: undefined });
    bump(a);
    event(a, 'finance.payout_details_changed', byKind, by, { method: body.method, version: a.version });
  };
  const financeRoutes = async (route: Route, a: Account | undefined, sub: string, q: URLSearchParams, full: boolean, method: string) => {
    if (sub === '' && method === 'GET') {
      const answer = summary(a, full);
      if (b.changeDetailsAfterNextRead && a) { b.changeDetailsAfterNextRead = false; setDetails(a, { method: 'upi', upiId: 'other@okicici' }, 'member', OWNER); }
      return ok(route, answer);
    }
    if (sub === '/statement') return ok(route, a ? statement(a._id, q) : { lines: [], nextCursor: null });
    if (sub === '/statement.csv') {
      return route.fulfill({ status: 200, contentType: 'text/csv; charset=utf-8', headers: { 'Content-Disposition': 'attachment; filename="x.csv"', 'Cache-Control': 'no-store' },
        body: a ? csv(a._id, q) : '' });
    }
    if (sub === '/payouts' && method === 'GET') return paged(route, b.payouts.filter((p) => p.settlementAccountId === a?._id).map(publicPayout), 'createdAt', q, 100);
    if (sub === '/events') return paged(route, b.events.filter((e) => e.settlementAccountId === a?._id), 'at', q, 200);
    if (sub === '/history') return ok(route, a?._id === ACC2 ? [{ _id: oid('eh'), settlementAccountId: ACC2, source: 'legacy_import', legacyKind: 'disbursal', legacyId: 'L1', periodLabel: 'Oct 2026', amountMinor: 500000, at: '2026-10-31T05:00:00.000Z' }] : []);
    return null;
  };

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
    if (b.holdBefore && b.holdBefore.match.test(path)) { const g = b.holdBefore.gate; b.holdBefore = undefined; await g; }
    const finish = async (data: unknown, status = 200) => {
      if (b.holdAfter && b.holdAfter.match.test(path)) { const g = b.holdAfter.gate; b.holdAfter = undefined; await g; }
      if (b.loseNext && b.loseNext.test(path)) { b.loseNext = undefined; return route.abort('failed'); }
      return ok(route, data, status);
    };
    if (path === '/auth/partner/send' || path === '/auth/admin/send') return ok(route, undefined);
    if (path === '/auth/partner/verify') { b.live = true; return ok(route, { token: 't1', expiresIn: 900, user: {} }); }
    if (path === '/auth/admin/verify') return ok(route, { token: 'admin', expiresIn: 900, user: {} });
    const auth = req.headers().authorization;
    if (auth !== 'Bearer t1' && auth !== 'Bearer admin') return fail(route, 401, 'UNAUTHORIZED', 'Authentication is required');
    const admin = auth === 'Bearer admin';
    if (path === '/auth/profile') {
      if (admin) return ok(route, { user: { _id: ADMIN, name: 'Ops Admin' }, userRole: 'admin' });
      return ok(route, { user: { ...b.me, phone: '9000000001', isActive: true }, partner: partners.find((x) => x._id === b.me.partnerId), userRole: 'partner' });
    }

    // ── admin settlements ──
    if (path.startsWith('/settlements')) {
      if (!admin) return fail(route, 403, 'FORBIDDEN', 'Admin access is required');
      const q = url.searchParams;
      if (path === '/settlements/accounts') {
        const search = (q.get('search') ?? '').toLowerCase();
        const rows = b.accounts.map((a) => ({ ...view(a, false), balanceMinor: balance(a._id) }))
          .filter((a) => (!q.get('ownerKind') || a.ownerKind === q.get('ownerKind')) && (!q.get('detailsState') || a.payoutDetailsState === q.get('detailsState'))
            && (!search || a.beneficiaryName.toLowerCase().includes(search)) && (q.get('due') !== 'true' || a.balanceMinor > 0))
          .sort((x, y) => y.balanceMinor - x.balanceMinor || x.beneficiaryName.localeCompare(y.beneficiaryName));
        const skip = Number(q.get('skip') ?? 0);
        const limit = Number(q.get('limit') ?? 50);
        return ok(route, { total: rows.length, totalDueMinor: rows.reduce((s, a) => s + Math.max(0, a.balanceMinor), 0), rows: rows.slice(skip, skip + limit) });
      }
      if (path === '/settlements/payouts') {
        const rows = b.payouts.filter((p) => (!q.get('accountId') || p.settlementAccountId === q.get('accountId')) && (!q.get('state') || p.state === q.get('state'))
          && (!q.get('from') || p.paidOn >= q.get('from')!) && (!q.get('to') || p.paidOn <= q.get('to')!));
        // Q13: each row names its account (owner's current name and the beneficiary).
        return paged(route, rows.map((p) => {
          const acc = b.accounts.find((x) => x._id === p.settlementAccountId);
          return { ...publicPayout(p), account: acc ? { accountId: acc._id, ownerKind: acc.ownerKind, ownerId: acc.ownerId, beneficiaryName: acc.beneficiaryName, ownerName: acc.beneficiaryName } : null };
        }), 'createdAt', q, 100);
      }
      const vd = /^\/settlements\/payouts\/([0-9a-f]{24})\/void$/.exec(path);
      if (vd) {
        const p = b.payouts.find((x) => x._id === vd[1]);
        if (!p) return fail(route, 404, 'PAYOUT_NOT_FOUND', 'Payout not found');
        if (p.state === 'recorded') {
          bump(b.accounts.find((x) => x._id === p.settlementAccountId)!);
          Object.assign(p, { state: 'voided', voidReason: (body as Rec).reason, voidedAt: NOW.toISOString(), voidedBy: ADMIN });
          b.entries.push({ _id: oid('eb'), accountId: p.settlementAccountId, at: NOW.toISOString(), kind: 'adjustment', source: 'payout_void', sourceId: p._id,
            description: `Payout voided · ${p.paidOn} · ref ${p.reference}`, reference: p.reference, note: String((body as Rec).reason), amountMinor: p.amountMinor });
        }
        return ok(route, publicPayout(p));
      }
      const m = /^\/settlements\/accounts\/([0-9a-f]{24})(\/.*)?$/.exec(path);
      const a = m && b.accounts.find((x) => x._id === m[1]);
      if (!m || !a) return fail(route, 404, 'SETTLEMENT_ACCOUNT_NOT_FOUND', 'Settlement account not found');
      const sub = m[2] ?? '';
      const read = await financeRoutes(route, a, sub, q, true, method);
      if (read !== null) return read;
      if (sub === '/payout-details' && method === 'PUT') {
        const ev = (body as Rec).expectedDetailsVersion;
        if (ev !== undefined && ev !== a.version) return fail(route, 409, 'PAYOUT_DETAILS_CHANGED', 'The payout details changed since they were loaded; review them again');
        const { expectedDetailsVersion: _e, ...details } = body as Rec;
        setDetails(a, details, 'admin', ADMIN); return ok(route, view(a, true));
      }
      // Q13: a lost payout or adjustment, looked up or given up by the admin's own key on this account.
      const byKey = /^\/(payouts|adjustments)\/by-key\/([A-Za-z0-9_-]{8,100})(\/abandon)?$/.exec(sub);
      if (byKey) {
        const [, kind, key, give] = byKey;
        const scope = `${kind}:${a._id}:${key}`;
        const made = kind === 'payouts' ? b.payouts.find((p) => p.settlementAccountId === a._id && p.by === ADMIN && p.requestKey === key)
          : b.entries.find((e) => e.accountId === a._id && e.source === 'admin_adjustment' && e.sourceId === `${ADMIN}:${key}`);
        const record = made && kind === 'payouts' ? publicPayout(made as Payout) : made;
        if (give) {
          if (record) return ok(route, kind === 'payouts' ? { state: 'used', payout: record } : { state: 'used', entry: record });
          b.abandoned.add(scope);
          return ok(route, { state: 'abandoned' });
        }
        return record ? ok(route, record) : fail(route, 404, kind === 'payouts' ? 'PAYOUT_NOT_FOUND' : 'ADJUSTMENT_NOT_FOUND', 'Not found with this key');
      }
      if (sub === '/payout-details/verify') {
        const v = (body as { version: number }).version;
        if (a.state === 'verified' && a.version === v) return ok(route, view(a, true));
        if (a.state !== 'unverified' || a.version !== v) return fail(route, 409, 'PAYOUT_DETAILS_CHANGED', 'The payout details changed since they were loaded; review them again');
        Object.assign(a, { state: 'verified', verifiedAt: NOW.toISOString() });
        bump(a);
        event(a, 'finance.payout_details_verified', 'admin', ADMIN, { version: v });
        return ok(route, view(a, true));
      }
      if (sub === '/payouts' && method === 'POST') {
        const x = body as Rec & { requestKey: string; amountMinor: number; reference: string; paidOn: string; detailsVersion: number; expectedFinanceVersion?: number };
        // The fence is not part of the request's identity (a replay still answers).
        const { requestKey, expectedFinanceVersion, ...rest } = x;
        const hash = JSON.stringify(rest);
        if (b.dropNext?.test(path)) { b.dropNext = undefined; return route.abort('failed'); }
        const prior = b.payouts.find((p) => p.by === ADMIN && p.requestKey === requestKey);
        if (prior) {
          if (prior.requestHash !== hash) return fail(route, 409, 'REQUEST_KEY_REUSED', 'This request key was already used for a different payout');
          return finish({ payout: publicPayout(prior), replayed: true });
        }
        if (b.abandoned.has(`payouts:${a._id}:${requestKey}`)) return fail(route, 409, 'REQUEST_ABANDONED', 'This request was cancelled before it was recorded; make a new one');
        // The doctor changed the destination and another admin verified it, after this admin loaded the page.
        if (b.changeDetailsBeforeNextPayout) { b.changeDetailsBeforeNextPayout = false; setDetails(a, { method: 'upi', upiId: 'meera.new@okaxis' }, 'doctor', DOC); a.state = 'verified'; }
        if (expectedFinanceVersion !== undefined && expectedFinanceVersion !== (a.financeVersion ?? 0)) {
          return fail(route, 409, 'FINANCE_CHANGED', 'This account changed since it was loaded (a payout, adjustment or destination change); review it again');
        }
        if (a.state !== 'verified') return fail(route, 409, 'PAYOUT_DETAILS_NOT_VERIFIED', 'Verify the payout details before recording a payout');
        if (a.version !== x.detailsVersion) return fail(route, 409, 'PAYOUT_DETAILS_CHANGED', 'The payout details changed since they were loaded; review them again');
        const bal = balance(a._id);
        if (x.amountMinor > bal) return fail(route, 409, 'INSUFFICIENT_BALANCE', `The balance is ₹${(bal / 100).toFixed(2)}; a payout cannot exceed it`);
        if (b.payouts.some((p) => p.settlementAccountId === a._id && p.reference === x.reference && p.state === 'recorded')) {
          return fail(route, 409, 'PAYOUT_REFERENCE_EXISTS', 'A payout with this reference is already recorded for this account');
        }
        const d = a.details as Rec;
        const p: Payout = { _id: oid('f2'), settlementAccountId: a._id, amountMinor: x.amountMinor, method: x.method, reference: x.reference, paidOn: x.paidOn,
          ...(x.note ? { note: x.note } : {}), destination: { method: d.method, label: d.method === 'upi' ? `UPI ${d.upiId}` : `${d.ifsc}`, detailsVersion: a.version },
          state: 'recorded', by: ADMIN, requestKey, requestHash: hash, createdAt: NOW.toISOString() };
        b.payouts.push(p);
        bump(a);
        b.entries.push({ _id: oid('eb'), accountId: a._id, at: NOW.toISOString(), kind: 'payout', source: 'payout', sourceId: p._id, description: `Payout · ${p.paidOn}`,
          reference: p.reference, amountMinor: -p.amountMinor });
        event(a, 'finance.payout_recorded', 'admin', ADMIN, { payoutId: p._id, amountMinor: p.amountMinor, reference: p.reference, paidOn: p.paidOn });
        if (b.loseNextPayoutAnswer) { b.loseNextPayoutAnswer = false; return route.abort('failed'); }
        return finish({ payout: publicPayout(p), replayed: false }, 201);
      }
      if (sub === '/adjustments') {
        const x = body as { amountMinor: number; reason: string; requestKey: string; expectedFinanceVersion?: number };
        const sourceId = `${ADMIN}:${x.requestKey}`;
        if (b.dropNext?.test(path)) { b.dropNext = undefined; return route.abort('failed'); }
        const prior = b.entries.find((e) => e.accountId === a._id && e.source === 'admin_adjustment' && e.sourceId === sourceId);
        if (prior) {
          if (prior.amountMinor !== x.amountMinor || prior.note !== x.reason) return fail(route, 409, 'REQUEST_KEY_REUSED', 'This request key was already used for a different adjustment');
          return finish({ entry: prior, replayed: true });
        }
        if (b.abandoned.has(`adjustments:${a._id}:${x.requestKey}`)) return fail(route, 409, 'REQUEST_ABANDONED', 'This request was cancelled before it was recorded; make a new one');
        if (x.expectedFinanceVersion !== undefined && x.expectedFinanceVersion !== (a.financeVersion ?? 0)) {
          return fail(route, 409, 'FINANCE_CHANGED', 'This account changed since it was loaded (a payout, adjustment or destination change); review it again');
        }
        const entry: Entry = { _id: oid('eb'), accountId: a._id, at: NOW.toISOString(), kind: 'adjustment', source: 'admin_adjustment', sourceId, description: 'Adjustment',
          note: x.reason, amountMinor: x.amountMinor };
        b.entries.push(entry);
        bump(a);
        event(a, 'finance.adjustment_posted', 'admin', ADMIN, { entryId: entry._id, amountMinor: x.amountMinor, reason: x.reason });
        if (b.loseNextAdjustmentAnswer) { b.loseNextAdjustmentAnswer = false; return route.abort('failed'); }
        return finish({ entry, replayed: false }, 201);
      }
      return fail(route, 404, 'NOT_FOUND', 'Not found');
    }

    if (path === '/partner-workspace/admin' && admin) return json(route, 200, { success: true, data: partners, pagination: { page: 1, limit: 20, total: partners.length, totalPages: 1 } });
    if (/^\/partner-workspace\/admin\/[0-9a-f]{24}$/.test(path)) return admin ? ok(route, partners.find((p) => path.endsWith(p._id as string))) : fail(route, 403, 'FORBIDDEN', 'Admin access is required');
    const ws = /^\/partner-workspace(?:\/admin\/([0-9a-f]{24})\/workspace)?(\/.*)$/.exec(path);
    if (!ws) return fail(route, 404, 'NOT_FOUND', 'Not found');
    if (ws[1] && !admin) return fail(route, 403, 'FORBIDDEN', 'Admin access is required');
    const sub = ws[2]!;
    const pid = ws[1] ?? b.me.partnerId;
    if (sub === '/me') return ok(route, partners.find((x) => x._id === pid));
    if (sub === '/branches') return ok(route, []);
    const fin = /^\/finance(\/.*)?$/.exec(sub);
    if (fin) {
      const actor = ws[1] ? null : b.me;
      const fsub = fin[1] ?? '';
      if (actor && actor.role !== 'owner' && actor.branchIds.length > 0) return fail(route, 403, 'FINANCE_SCOPE_REQUIRED', 'Finance covers every branch; a branch-limited member cannot view it');
      const a = b.accounts.find((x) => x.ownerKind === 'partner' && x.ownerId === pid);
      if (fsub === '/payout-details' && method === 'PUT') {
        if (actor && actor.role !== 'owner') return fail(route, 403, 'OWNER_REQUIRED', 'Only an owner can change where payouts are sent');
        const { expectedDetailsVersion: ev, ...details } = body as Rec;
        if (ev !== undefined && ev !== a!.version) return fail(route, 409, 'PAYOUT_DETAILS_CHANGED', 'The payout details changed since they were loaded; review them again');
        setDetails(a!, details, actor ? 'member' : 'admin', actor ? actor._id : ADMIN);
        return ok(route, view(a!, !actor));
      }
      if (actor && actor.role !== 'owner' && !actor.permissions.includes('finance.view')) return fail(route, 403, 'PARTNER_PERMISSION_REQUIRED', 'You do not have permission to do this');
      const read = await financeRoutes(route, a, fsub, url.searchParams, !actor, method);
      if (read !== null) return read;
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

/** Holds the next matching request (before the server acts, or after it acted) until the returned function is called. */
function hold(b: Backend, when: 'holdBefore' | 'holdAfter', match: RegExp): () => void {
  let release!: () => void;
  b[when] = { match, gate: new Promise<void>((r) => { release = r; }) };
  return () => release();
}

const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' });
const writes = (b: Backend) => b.calls.filter((c) => c.method !== 'GET' && !c.path.startsWith('/auth/')).map((c) => `${c.method} ${c.path}`);
const statementRows = (page: Page) => page.getByRole('table', { name: 'Statement entries, newest first' }).locator('tbody tr');
async function storage(page: Page): Promise<string> {
  return page.evaluate(() => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }));
}

test('partner finance: balance, statement paging with the running balance, CSV through a blob, payouts and events', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Finance' }).click();
  await expect(page.getByRole('heading', { name: 'Finance', level: 1 })).toBeVisible();
  const cards = page.getByRole('definition').filter({ hasText: '₹' });
  await expect(page.getByText('Balance due')).toBeVisible();
  await expect(cards.first()).toHaveText('₹14,750.00');
  await expect(page.getByText(/Last payout: ₹10,000\.00 on 1 Nov 2026 \(reference UTR0001\)/)).toBeVisible();

  // Newest first, 50 a page; the balance after each line runs back to the first earning.
  await expect(statementRows(page)).toHaveCount(50);
  await expect(statementRows(page).first()).toContainText('₹450.00');
  await expect(statementRows(page).first().locator('td').last()).toHaveText('₹14,750.00');
  const payoutRow = statementRows(page).filter({ hasText: 'UTR0001' });
  await expect(payoutRow).toContainText('− ₹10,000.00');
  await page.getByRole('button', { name: 'Show older entries' }).click();
  await expect(statementRows(page)).toHaveCount(56);
  await expect(statementRows(page).last().locator('td').last()).toHaveText('₹450.00');
  await expect(page.getByRole('button', { name: 'Show older entries' })).toHaveCount(0);
  const pages = backend.calls.filter((c) => c.path.startsWith('/partner-workspace/finance/statement?'));
  expect(pages.map((c) => c.path)).toEqual(['/partner-workspace/finance/statement?limit=50', expect.stringMatching(/^\/partner-workspace\/finance\/statement\?before=\d+_[0-9a-f]{24}&limit=50$/)]);

  // A period: India dates; the CSV of the same period is read with the token into memory and saved under the server's name.
  await page.getByLabel('From (India date)').fill('2026-11-01');
  await page.getByLabel('To (India date)').fill('2026-11-08');
  await expect(statementRows(page)).toHaveCount(9);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /Download CSV \(from 1 Nov 2026 to 8 Nov 2026\)/ }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('partner-statement-2026-11-01-to-2026-11-08.csv');
  const text = await readFile((await file.path())!, 'utf8');
  expect(text.split('\n')[0]).toBe('"Date (IST)","Type","Description","Reference","Note","Amount (INR)","Balance (INR)"');
  expect(text).toContain('"Opening balance","","","","","21150.00"');
  const csvCall = backend.calls.find((c) => c.path.startsWith('/partner-workspace/finance/statement.csv'))!;
  expect(csvCall.path).toBe('/partner-workspace/finance/statement.csv?from=2026-11-01&to=2026-11-08');
  expect(csvCall.auth).toBe('Bearer t1');
  await expect(page.getByRole('link', { name: 'Save partner-statement-2026-11-01-to-2026-11-08.csv again' })).toHaveAttribute('href', /^blob:/);

  const payouts = page.getByRole('table', { name: 'Payouts, newest first' });
  await expect(payouts.getByRole('row').filter({ hasText: 'UTR0001' })).toContainText('Recorded');
  await expect(page.getByText('Payout recorded')).toBeVisible();
  await expect(page.getByText('Payout details changed')).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'Payout details changed' })).toContainText('You');

  expect(page.url()).toMatch(/#\/partner\/finance$/);
  expect(await storage(page)).not.toMatch(/14750|UTR|9012|Asha/);
  expect(writes(backend)).toEqual([]);
});

test('partner finance: an owner changes the payout destination after a review that says it must be verified again', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Finance' }).click();
  const dest = page.getByRole('region', { name: 'Where payouts are sent' });
  await expect(dest).toContainText('Any change to these details, even to the same values, must be verified again by Jansetu');
  await expect(dest).toContainText('XXXX9012');
  await expect(dest).not.toContainText('123456789012');
  await expect(dest).toContainText('Verified');

  await dest.getByRole('button', { name: 'Change payout details' }).click();
  // The masked number is never put back in the form: an owner types the full number twice.
  await expect(dest.getByLabel('Account number', { exact: true })).toHaveValue('');
  await expect(dest.getByLabel('Account holder name')).toHaveValue('City Lab Pvt Ltd');
  await dest.getByLabel('Account number', { exact: true }).fill('9988 7766 5544');
  await dest.getByLabel('Account number again').fill('998877665545');
  await dest.getByLabel('IFSC').fill('icic0004321');
  await dest.getByRole('button', { name: 'Review the change' }).click();
  await expect(dest.getByText('The two account numbers are not the same.')).toBeVisible();
  await dest.getByLabel('Account number again').fill('998877665544');
  await dest.getByRole('button', { name: 'Review the change' }).click();
  const review = dest.getByRole('group', { name: 'Save the payout details' });
  await expect(review).toContainText('Send payouts to HDFC ICIC0004321 XXXX5544 from now on?');
  await expect(review).toContainText('Jansetu must verify any change (even to the same details) before the next payout');
  expect(writes(backend)).toEqual([]);
  await review.getByRole('button', { name: 'Save payout details' }).click();
  await expect(page.getByText('Payout details saved (version 2). They wait for Jansetu’s verification; no payout is made until then.')).toBeVisible();
  const put = backend.calls.find((c) => c.method === 'PUT')!;
  expect(put.path).toBe('/partner-workspace/finance/payout-details');
  // Q13: the PUT names the details version the edit started from.
  expect(put.body).toEqual({ method: 'bank', accountName: 'City Lab Pvt Ltd', accountNumber: '998877665544', ifsc: 'ICIC0004321', bankName: 'HDFC', expectedDetailsVersion: 1 });
  // The account was read again right before the change was sent.
  const i = backend.calls.indexOf(put);
  expect(backend.calls[i - 1]!.path).toBe('/partner-workspace/finance');
  await expect(dest).toContainText('Waiting for verification');
  await expect(dest).toContainText('XXXX5544');

  // Someone else changes the details while this owner edits: nothing is sent, the form shows what is saved now.
  await dest.getByRole('button', { name: 'Change payout details' }).click();
  await dest.getByRole('radio', { name: 'UPI' }).check();
  await dest.getByLabel('UPI ID').fill('citylab@okhdfc');
  await dest.getByRole('button', { name: 'Review the change' }).click();
  const acc = backend.accounts.find((a) => a._id === ACC1)!;
  Object.assign(acc, { details: { method: 'upi', upiId: 'other@okicici' }, version: 3, state: 'unverified' });
  await dest.getByRole('group', { name: 'Save the payout details' }).getByRole('button', { name: 'Save payout details' }).click();
  await expect(dest.getByText(/The payout details were changed elsewhere while you were editing \(now version 3\)/)).toBeVisible();
  await expect(dest.getByLabel('UPI ID')).toHaveValue('other@okicici');
  expect(backend.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  expect(await storage(page)).not.toMatch(/9988|998877665544|citylab|okicici/);
});

test('finance needs finance.view and every branch: staff read without changing; others do not get the page', async ({ page }) => {
  const backend = await mockBackend(page, staff(['finance.view']));
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Finance' }).click();
  await expect(page.getByText('Only an owner can change where payouts are sent.')).toBeVisible();
  await expect(page.getByRole('button', { name: /payout details/ })).toHaveCount(0);
  await expect(statementRows(page)).toHaveCount(50);

  // A member without finance.view (or limited to some branches) has no Finance page at all, and nothing is asked.
  backend.me = staff(['invoices.create']);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByLabel('Lab or clinic staff')).toBeVisible();
  await expect.poll(() => backend.live).toBe(false); // the server session has ended
  await signInPartner(page);
  await expect(nav(page).getByRole('link', { name: 'Bills' })).toBeVisible();
  await expect(nav(page).getByRole('link', { name: 'Finance' })).toHaveCount(0);
  const before = backend.calls.length;
  await page.evaluate(() => { window.location.hash = '#/partner/finance'; });
  await expect(page.getByText('Page not found')).toBeVisible();

  backend.me = staff(['finance.view'], ['c9'.repeat(12)]);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByLabel('Lab or clinic staff')).toBeVisible();
  await expect.poll(() => backend.live).toBe(false); // the server session has ended
  await signInPartner(page);
  await expect(nav(page).getByRole('link', { name: 'Finance' })).toHaveCount(0);
  await page.evaluate(() => { window.location.hash = '#/partner/finance'; });
  await expect(page.getByText('Page not found')).toBeVisible();
  expect(backend.calls.slice(before).some((c) => c.path.includes('/finance'))).toBe(false);
});

test('admin settlements: accounts with filters, totals and paging', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await nav(page).getByRole('link', { name: 'Settlements' }).click();
  await expect(page.getByRole('heading', { name: 'Settlements', level: 1 })).toBeVisible();
  const table = page.getByRole('table', { name: 'Settlement accounts, largest balance first' });
  await expect(page.getByText('2 accounts · due in total ₹17,750.00')).toBeVisible();
  await expect(table.locator('tbody tr').first()).toContainText('City Lab');
  await expect(table.locator('tbody tr').first()).toContainText('₹14,750.00');
  await expect(table.locator('tbody tr').nth(1)).toContainText('Waiting for verification');
  expect(backend.calls.at(-1)!.path).toBe('/settlements/accounts?due=true&limit=50');

  await page.getByLabel('Account of').selectOption('doctor');
  await expect(page.getByText('1 account · due in total ₹3,000.00')).toBeVisible();
  await page.getByLabel('Only with a balance due').uncheck();
  await expect(page.getByText('51 accounts · due in total ₹3,000.00')).toBeVisible();
  await expect(page.getByText('Page 1 of 2')).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('Page 2 of 2')).toBeVisible();
  await expect(table.locator('tbody tr')).toHaveCount(1);
  expect(backend.calls.at(-1)!.path).toBe('/settlements/accounts?ownerKind=doctor&limit=50&skip=50');

  await page.getByLabel('Account of').selectOption('');
  await page.getByLabel('Payout details').selectOption('none');
  await page.getByLabel('Search by account name').fill('lake');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByText('1 account · due in total ₹0.00')).toBeVisible();
  await expect(table).toContainText('Lake Lab');
  await expect(table).toContainText('Not given');
  expect(page.url()).not.toContain('lake');
  await table.getByRole('link', { name: 'Lake Lab' }).click();
  await expect(page.getByRole('heading', { name: 'Lake Lab', level: 1 })).toBeVisible();
  await expect(page.getByText('There are no payout details to pay to yet.')).toBeVisible();
});

test('admin account: verify details, a stale details version is refused, a lost payout answer is resent and pays once', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await nav(page).getByRole('link', { name: 'Settlements' }).click();
  await page.getByRole('link', { name: 'Dr Meera Rao' }).click();
  await expect(page.getByRole('heading', { name: 'Dr Meera Rao', level: 1 })).toBeVisible();
  await expect(page.getByText('Doctor', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('The payout details have changed and are not verified')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Earlier history' })).toContainText('₹5,000.00');

  await page.getByRole('button', { name: 'Mark as verified' }).click();
  await expect(page.getByRole('group', { name: 'Mark as verified' })).toContainText('version 1: UPI meera@okaxis');
  await page.getByRole('button', { name: 'Yes, these details are verified' }).click();
  await expect(page.getByText('Payout details version 1 verified.')).toBeVisible();
  expect(backend.calls.find((c) => c.path.endsWith('/payout-details/verify'))!.body).toEqual({ version: 1 });

  const form = page.getByRole('form', { name: 'Record a payout' });
  await expect(form.getByLabel('Paid by')).toHaveValue('upi');
  await expect(form.getByLabel('Paid on (India date)')).toHaveValue('2026-11-16');
  await form.getByLabel('Amount paid (₹)').fill('5000');
  await form.getByLabel('Bank reference (UTR)').fill('UPI-A1');
  await form.getByRole('button', { name: 'Review the payout' }).click();
  await expect(form.getByText('A payout cannot be more than the balance.')).toBeVisible();
  await form.getByLabel('Amount paid (₹)').fill('1000');
  await form.getByRole('button', { name: 'Review the payout' }).click();
  const review = form.getByRole('group', { name: 'Record the payout' });
  await expect(review).toContainText('Record ₹1,000.00 paid to Dr Meera Rao at UPI meera@okaxis (details version 1)');
  await expect(review).toContainText('from ₹3,000.00 to ₹2,000.00');

  // The destination changed (and was verified again) after this page was loaded: the payout names the finance version
  // it was reviewed on (Q13), so it is refused, and the page shows the details as they are now; the form keeps what was typed.
  backend.changeDetailsBeforeNextPayout = true;
  await review.getByRole('button', { name: 'Record payout' }).click();
  await expect(page.getByText('Not recorded: This account changed since it was loaded (a payout, adjustment or destination change); review it again')).toBeVisible();
  await expect(form.getByRole('group', { name: 'Record the payout' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Payout details' })).toContainText('meera.new@okaxis');
  await expect(page.getByRole('region', { name: 'Payout details' })).toContainText('Verified · version 2');
  expect(backend.payouts.filter((p) => p.settlementAccountId === ACC2)).toHaveLength(0);
  await expect(form.getByLabel('Amount paid (₹)')).toHaveValue('1000');
  await form.getByLabel('Bank reference (UTR)').fill('UPI-A2');
  await form.getByRole('button', { name: 'Review the payout' }).click();
  backend.loseNextPayoutAnswer = true;
  await form.getByRole('group', { name: 'Record the payout' }).getByRole('button', { name: 'Record payout' }).click();

  // Recorded on the server, answer lost: the payout is locked to an identical resend.
  const panel = page.getByRole('group', { name: 'Unconfirmed payout' });
  await expect(panel).toContainText('The outcome of this request is not known yet');
  await expect(panel).toContainText('Payout of ₹1,000.00 by UPI, reference UPI-A2, paid on 16 Nov 2026 (details version 2).');
  await expect(page.getByRole('form', { name: 'Record a payout' })).toHaveCount(0);
  expect(await storage(page)).not.toMatch(/UPI-A2|meera/);
  await panel.getByRole('button', { name: 'Send the same request again' }).click();
  await expect(page.getByText('This payout had already been recorded: ₹1,000.00, reference UPI-A2, paid on 16 Nov 2026. Nothing was recorded twice.')).toBeVisible();
  const posts = backend.calls.filter((c) => c.method === 'POST' && c.path === `/settlements/accounts/${ACC2}/payouts`);
  expect(posts).toHaveLength(3);
  expect(posts[2]!.body).toEqual(posts[1]!.body);
  expect(posts[1]!.body).toMatchObject({ amountMinor: 100000, method: 'upi', reference: 'UPI-A2', paidOn: '2026-11-16', detailsVersion: 2, expectedFinanceVersion: 2 });
  expect(posts[0]!.body).toMatchObject({ detailsVersion: 1, expectedFinanceVersion: 1 });
  expect((posts[1]!.body as Rec).requestKey).not.toBe((posts[0]!.body as Rec).requestKey);
  expect(backend.payouts.filter((p) => p.settlementAccountId === ACC2)).toHaveLength(1);
  await expect(page.getByRole('definition').filter({ hasText: '₹' }).first()).toHaveText('₹2,000.00');
  await expect(page.getByRole('table', { name: 'Payouts of this account, newest first' })).toContainText('UPI-A2');
  expect(await storage(page)).not.toMatch(/sd:pend/);
  expect(page.url()).toMatch(new RegExp(`#/admin/settlements/${ACC2}$`));
});

test('admin adjustment: confirm with a reason; a lost answer is found by its key and posted once', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await page.evaluate((id) => { window.location.hash = `#/admin/settlements/${id}`; }, ACC1);
  await expect(page.getByRole('heading', { name: 'City Lab', level: 1 })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Payout details' })).toContainText('123456789012');
  const form = page.getByRole('form', { name: 'Post an adjustment' });
  await form.getByRole('radio', { name: 'Take from the balance (recovery)' }).check();
  await form.getByLabel('Adjustment amount (₹)').fill('250');
  await form.getByLabel('Reason (kept with the entry)').fill('no');
  await form.getByRole('button', { name: 'Review the adjustment' }).click();
  await expect(form.getByText('Give a reason (at least 3 characters).')).toBeVisible();
  await form.getByLabel('Reason (kept with the entry)').fill('Duplicate earning for one booking');
  await form.getByRole('button', { name: 'Review the adjustment' }).click();
  const review = form.getByRole('group', { name: 'Post the adjustment' });
  await expect(review).toContainText('Take ₹250.00 from the balance of City Lab? It goes from ₹14,750.00 to ₹14,500.00.');
  backend.loseNextAdjustmentAnswer = true;
  await review.getByRole('button', { name: 'Post adjustment' }).click();

  const panel = page.getByRole('group', { name: 'Unconfirmed adjustment' });
  await expect(panel).toContainText('Take ₹250.00 from the balance: “Duplicate earning for one booking”.');
  await panel.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(page.getByText('This adjustment had already been posted (₹250.00 taken from the balance). Nothing was posted twice.')).toBeVisible();
  const posts = backend.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/adjustments'));
  expect(posts).toHaveLength(1);
  expect(posts[0]!.body).toMatchObject({ amountMinor: -25000, reason: 'Duplicate earning for one booking', expectedFinanceVersion: 0 });
  // Q13: an exact lookup by the key, not a scan of the statement.
  expect(backend.calls.some((c) => c.path === `/settlements/accounts/${ACC1}/adjustments/by-key/${(posts[0]!.body as Rec).requestKey}`)).toBe(true);
  expect(backend.entries.filter((e) => e.source === 'admin_adjustment')).toHaveLength(1);
  await expect(page.getByRole('definition').filter({ hasText: '₹' }).first()).toHaveText('₹14,500.00');
  await expect(page.getByRole('listitem').filter({ hasText: 'Adjustment posted' })).toContainText('− ₹250.00 · “Duplicate earning for one booking”');
  expect(await storage(page)).not.toMatch(/Duplicate|sd:pend/);
});

test('an adjustment sent just before a reload: only a body-less marker survives, and the key finds it', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await page.evaluate((id) => { window.location.hash = `#/admin/settlements/${id}`; }, ACC1);
  const form = page.getByRole('form', { name: 'Post an adjustment' });
  await form.getByLabel('Adjustment amount (₹)').fill('125.50');
  await form.getByLabel('Reason (kept with the entry)').fill('Goodwill credit for a late report');
  await form.getByRole('button', { name: 'Review the adjustment' }).click();
  backend.loseNextAdjustmentAnswer = true;
  await form.getByRole('group', { name: 'Post the adjustment' }).getByRole('button', { name: 'Post adjustment' }).click();
  await expect(page.getByRole('group', { name: 'Unconfirmed adjustment' })).toBeVisible();
  const kept = await storage(page);
  expect(kept).toContain(`settlement-adjustment:${ACC1}`);
  expect(kept).not.toMatch(/Goodwill|12550/);

  await page.reload();
  await signInAdmin(page);
  await page.evaluate((id) => { window.location.hash = `#/admin/settlements/${id}`; }, ACC1);
  const panel = page.getByRole('group', { name: 'Unconfirmed adjustment' });
  await expect(panel).toContainText('A request made earlier on this device');
  await expect(page.getByRole('form', { name: 'Post an adjustment' })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(page.getByText('This adjustment had already been posted (₹125.50 added to the balance). Nothing was posted twice.')).toBeVisible();
  expect(backend.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/adjustments'))).toHaveLength(1);
  expect(await storage(page)).not.toMatch(/sd:pend/);
  await expect(page.getByRole('form', { name: 'Post an adjustment' })).toBeVisible();
});

test('admin payouts: filters and a void with a reason after confirming', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await nav(page).getByRole('link', { name: 'Payouts' }).click();
  await expect(page.getByRole('heading', { name: 'Payouts', level: 1 })).toBeVisible();
  const table = page.getByRole('table', { name: 'Payouts, newest recorded first' });
  const row = table.getByRole('row').filter({ hasText: 'UTR0001' });
  await expect(row).toContainText('City Lab');
  await expect(row).toContainText('₹10,000.00');
  await page.getByLabel('Status').selectOption('voided');
  await expect(page.getByText('No payout matches these filters.')).toBeVisible();
  await page.getByLabel('Status').selectOption('recorded');
  await page.getByLabel('Paid from').fill('2026-11-02');
  await expect(page.getByText('No payout matches these filters.')).toBeVisible();
  expect(backend.calls.some((c) => c.path === '/settlements/payouts?from=2026-11-02&state=recorded&limit=100')).toBe(true);
  await page.getByLabel('Paid from').fill('');

  await row.getByRole('button', { name: 'Void' }).click();
  const confirm = page.getByRole('group', { name: 'Void' });
  await expect(confirm).toContainText('Void the payout of ₹10,000.00 paid on 1 Nov 2026 (reference UTR0001)?');
  await expect(confirm).toContainText('₹10,000.00 is credited back to City Lab’s balance');
  await confirm.getByRole('button', { name: 'Void the payout' }).click();
  await expect(confirm.getByText('Give a reason (at least 3 characters).')).toBeVisible();
  expect(writes(backend)).toEqual([]);
  await confirm.getByLabel('Why is it voided?').fill('Transfer bounced back');
  await confirm.getByRole('button', { name: 'Void the payout' }).click();
  await expect(page.getByText('Payout UTR0001 (₹10,000.00) is voided; ₹10,000.00 is back in the account’s balance.')).toBeVisible();
  expect(writes(backend)).toEqual([`POST /settlements/payouts/${PO1}/void`]);
  expect(backend.calls.find((c) => c.path.endsWith('/void'))!.body).toEqual({ reason: 'Transfer bounced back' });
  await expect(page.getByText('No payouts')).toBeVisible();
  await page.getByLabel('Status').selectOption('');
  await expect(table.getByRole('row').filter({ hasText: 'UTR0001' })).toContainText('Voided');
  await expect(table.getByRole('row').filter({ hasText: 'UTR0001' })).toContainText('“Transfer bounced back”');
  await expect(table.getByRole('button', { name: 'Void' })).toHaveCount(0);

  // From an account page: only that account's payouts.
  await table.getByRole('link', { name: 'City Lab' }).click();
  await expect(page.getByRole('definition').filter({ hasText: '₹' }).first()).toHaveText('₹24,750.00');
  await page.getByRole('link', { name: 'Payouts', exact: true }).last().click();
  await expect(page.getByText('Only City Lab.')).toBeVisible();
  await expect.poll(() => backend.calls.some((c) => c.path === `/settlements/payouts?accountId=${ACC1}&state=recorded&limit=100`)).toBe(true);
});

test('admin as owner: the partner finance page through the admin workspace route, with the full account number', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await expect(nav(page).getByRole('link', { name: 'Finance' })).toHaveCount(0);
  await page.evaluate((id) => { window.location.hash = `#/admin/partners/${id}`; }, LAB);
  await page.getByRole('link', { name: 'Finance' }).click();
  await expect(page.getByRole('heading', { name: 'Finance', level: 1 })).toBeVisible();
  await expect(page.getByText('Managing City Lab with owner authority.')).toBeVisible();
  await expect(page.getByRole('definition').filter({ hasText: '₹' }).first()).toHaveText('₹14,750.00');
  const dest = page.getByRole('region', { name: 'Where payouts are sent' });
  await expect(dest).toContainText('123456789012');
  await dest.getByRole('button', { name: 'Change payout details' }).click();
  await expect(dest.getByLabel('Account number', { exact: true })).toHaveValue('123456789012');
  await dest.getByLabel('Bank name (optional)').fill('HDFC Bank');
  await dest.getByRole('button', { name: 'Review the change' }).click();
  await expect(dest.getByRole('group', { name: 'Save the payout details' })).toContainText('must be verified again before a payout can be recorded');
  await dest.getByRole('button', { name: 'Save payout details' }).click();
  await expect(page.getByText(/Payout details saved \(version 2\)/)).toBeVisible();
  expect(writes(backend)).toEqual([`PUT /partner-workspace/admin/${LAB}/workspace/finance/payout-details`]);
  expect(backend.calls.filter((c) => c.method === 'PUT')[0]!.body).toEqual({ method: 'bank', accountName: 'City Lab Pvt Ltd', accountNumber: '123456789012', ifsc: 'HDFC0001234', bankName: 'HDFC Bank', expectedDetailsVersion: 1 });
  expect(backend.calls.some((c) => c.path === `/partner-workspace/admin/${LAB}/workspace/finance/statement?limit=50`)).toBe(true);
  expect(backend.calls.filter((c) => c.path.includes('/finance')).every((c) => c.path.startsWith(`/partner-workspace/admin/${LAB}/workspace/finance`))).toBe(true);
  expect(await storage(page)).not.toMatch(/123456789012|HDFC/);
});

test('payout details: a refresh during the save’s re-read moves the baseline, and the reviewed old details are not sent', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Finance' }).click();
  const dest = page.getByRole('region', { name: 'Where payouts are sent' });
  await dest.getByRole('button', { name: 'Change payout details' }).click();
  await dest.getByRole('radio', { name: 'UPI' }).check();
  await dest.getByLabel('UPI ID').fill('citylab@okhdfc');
  await dest.getByRole('button', { name: 'Review the change' }).click();
  // The re-read made by Save waits; meanwhile someone else saves new details and the page refreshes in the background.
  const releaseRead = hold(backend, 'holdBefore', /^\/partner-workspace\/finance$/);
  await dest.getByRole('group', { name: 'Save the payout details' }).getByRole('button', { name: 'Save payout details' }).click();
  await expect.poll(() => backend.holdBefore).toBeUndefined();
  Object.assign(backend.accounts.find((a) => a._id === ACC1)!, { details: { method: 'upi', upiId: 'other@okicici' }, version: 2, state: 'unverified' });
  await page.clock.setFixedTime(new Date(NOW.getTime() + 60_000));
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  await expect(dest.getByRole('definition').filter({ hasText: 'other@okicici' })).toBeVisible();
  // The re-read now answers version 2 too, matching the moved baseline: still nothing may be sent.
  const read = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/partner-workspace/finance');
  releaseRead();
  await read;
  await expect(dest.getByText(/changed elsewhere while you were saving \(now version 2\)\. Nothing was saved/)).toBeVisible();
  await expect(dest.getByLabel('UPI ID')).toHaveValue('other@okicici');
  expect(backend.calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
  expect(backend.accounts.find((a) => a._id === ACC1)!.details).toEqual({ method: 'upi', upiId: 'other@okicici' });
});

for (const kind of ['payout', 'adjustment'] as const) {
  test(`a left page’s late ${kind} answer does not settle the ${kind} another page resent and lost`, async ({ page }) => {
    const backend = await mockBackend(page);
    await signInAdmin(page);
    const open = async () => {
      await nav(page).getByRole('link', { name: 'Settlements' }).click();
      await page.getByRole('link', { name: 'City Lab' }).click();
      await expect(page.getByRole('heading', { name: 'City Lab', level: 1 })).toBeVisible();
    };
    await open();
    const path = kind === 'payout' ? /\/payouts$/ : /\/adjustments$/;
    const label = kind === 'payout' ? 'Unconfirmed payout' : 'Unconfirmed adjustment';
    // Page A sends; the server records it, but the answer is held.
    let releaseA: () => void;
    if (kind === 'payout') {
      const form = page.getByRole('form', { name: 'Record a payout' });
      await form.getByLabel('Amount paid (₹)').fill('100');
      await form.getByLabel('Bank reference (UTR)').fill('UTR-HELD-1');
      await form.getByRole('button', { name: 'Review the payout' }).click();
      releaseA = hold(backend, 'holdAfter', path);
      await form.getByRole('button', { name: 'Record payout' }).click();
    } else {
      const form = page.getByRole('form', { name: 'Post an adjustment' });
      await form.getByLabel('Adjustment amount (₹)').fill('75');
      await form.getByLabel('Reason (kept with the entry)').fill('Correction held in transit');
      await form.getByRole('button', { name: 'Review the adjustment' }).click();
      releaseA = hold(backend, 'holdAfter', path);
      await form.getByRole('button', { name: 'Post adjustment' }).click();
    }
    await expect.poll(() => backend.holdAfter).toBeUndefined();
    // Page A leaves with its answer still on the way; page B shows the same request and resends it; B's answer is lost.
    await open();
    const panelB = page.getByRole('group', { name: label });
    await expect(panelB).toContainText('The outcome of this request is not known yet');
    backend.loseNext = path;
    await panelB.getByRole('button', { name: 'Send the same request again' }).click();
    await expect(panelB).toContainText('Could not reach the server');
    // A's late success arrives now: it must not settle B's attempt.
    const late = page.waitForResponse((r) => path.test(new URL(r.url()).pathname) && r.status() === 201);
    releaseA();
    await late;
    await open();
    const panelC = page.getByRole('group', { name: label });
    await expect(panelC).toBeVisible();
    await expect(page.getByRole('form', { name: kind === 'payout' ? 'Record a payout' : 'Post an adjustment' })).toHaveCount(0);
    await panelC.getByRole('button', { name: 'Check whether it was recorded' }).click();
    await expect(page.getByText(kind === 'payout' ? /This payout had already been recorded: ₹100\.00, reference UTR-HELD-1/ : /This adjustment had already been posted \(₹75\.00 added to the balance\)/)).toBeVisible();
    const posts = backend.calls.filter((c) => c.method === 'POST' && path.test(c.path));
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body).toEqual(posts[0]!.body);
    expect(kind === 'payout' ? backend.payouts.filter((p) => p.reference === 'UTR-HELD-1').length : backend.entries.filter((e) => e.source === 'admin_adjustment').length).toBe(1);
    expect(await storage(page)).not.toMatch(/sd:pend/);
  });
}

test('Q13: a payout lost before a reload is checked by key, given up on the server, then recorded anew; a resend of a given-up key is refused', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await page.evaluate((id) => { window.location.hash = `#/admin/settlements/${id}`; }, ACC1);
  const form = page.getByRole('form', { name: 'Record a payout' });
  await form.getByLabel('Amount paid (₹)').fill('500');
  await form.getByLabel('Bank reference (UTR)').fill('UTR-DROP-1');
  await form.getByRole('button', { name: 'Review the payout' }).click();
  backend.dropNext = /\/payouts$/;
  await form.getByRole('group', { name: 'Record the payout' }).getByRole('button', { name: 'Record payout' }).click();
  await expect(page.getByRole('group', { name: 'Unconfirmed payout' })).toBeVisible();
  const key = (backend.calls.find((c) => c.method === 'POST' && c.path.endsWith('/payouts'))!.body as Rec).requestKey as string;
  expect(await storage(page)).not.toMatch(/UTR-DROP|50000/);

  await page.reload();
  await signInAdmin(page);
  await page.evaluate((id) => { window.location.hash = `#/admin/settlements/${id}`; }, ACC1);
  const panel = page.getByRole('group', { name: 'Unconfirmed payout' });
  await expect(panel).toContainText('A request made earlier on this device');
  await panel.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(panel).toContainText('Not found in the records. It may still be on its way.');
  expect(backend.calls.some((c) => c.path === `/settlements/accounts/${ACC1}/payouts/by-key/${key}`)).toBe(true);
  await panel.getByRole('button', { name: 'Give up this payout' }).click();
  await expect(page.getByText('The unconfirmed payout was given up: it can never be recorded.', { exact: false })).toBeVisible();
  expect(backend.abandoned.has(`payouts:${ACC1}:${key}`)).toBe(true);
  expect(await storage(page)).not.toMatch(/sd:pend/);

  // A new payout (new key) can be recorded now.
  await form.getByLabel('Amount paid (₹)').fill('500');
  await form.getByLabel('Bank reference (UTR)').fill('UTR-NEW-1');
  await form.getByRole('button', { name: 'Review the payout' }).click();
  // Its answer is lost; meanwhile its key is given up elsewhere (another tab after a reload): the resend is refused for good.
  backend.dropNext = /\/payouts$/;
  await form.getByRole('group', { name: 'Record the payout' }).getByRole('button', { name: 'Record payout' }).click();
  const panel2 = page.getByRole('group', { name: 'Unconfirmed payout' });
  await expect(panel2).toContainText('The outcome of this request is not known yet');
  const key2 = (backend.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/payouts')).at(-1)!.body as Rec).requestKey as string;
  expect(key2).not.toBe(key);
  backend.abandoned.add(`payouts:${ACC1}:${key2}`);
  await panel2.getByRole('button', { name: 'Send the same request again' }).click();
  await expect(page.getByText('This payout was given up earlier, so it was not recorded and never will be.', { exact: false })).toBeVisible();
  await expect(panel2).toHaveCount(0);
  await expect(page.getByRole('form', { name: 'Record a payout' })).toBeVisible();
  expect(backend.payouts.filter((p) => p.settlementAccountId === ACC1)).toHaveLength(1);
  expect(await storage(page)).not.toMatch(/sd:pend/);
});

test('Q13: a lost adjustment given up after a check (nothing posted); one that lands after the check is answered "used" by the give-up and posted once', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await page.evaluate((id) => { window.location.hash = `#/admin/settlements/${id}`; }, ACC1);
  const form = page.getByRole('form', { name: 'Post an adjustment' });
  await form.getByLabel('Adjustment amount (₹)').fill('40');
  await form.getByLabel('Reason (kept with the entry)').fill('Lost before a reload');
  await form.getByRole('button', { name: 'Review the adjustment' }).click();
  backend.dropNext = /\/adjustments$/;
  await form.getByRole('group', { name: 'Post the adjustment' }).getByRole('button', { name: 'Post adjustment' }).click();
  const panel = page.getByRole('group', { name: 'Unconfirmed adjustment' });
  await expect(panel).toContainText('The outcome of this request is not known yet');
  // Before a reload: a check that finds nothing offers the give-up next to the resend.
  await panel.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(panel).toContainText('Not recorded so far, but it may still be finishing.');
  await panel.getByRole('button', { name: 'Give up this adjustment' }).click();
  await expect(page.getByText('The unconfirmed adjustment was given up: it can never be posted.', { exact: false })).toBeVisible();
  expect(backend.entries.filter((e) => e.source === 'admin_adjustment')).toHaveLength(0);
  const key = (backend.calls.find((c) => c.method === 'POST' && c.path.endsWith('/adjustments'))!.body as Rec).requestKey as string;
  expect(backend.calls.some((c) => c.method === 'POST' && c.path === `/settlements/accounts/${ACC1}/adjustments/by-key/${key}/abandon`)).toBe(true);

  // A second one: its answer is lost, its resend is held before the server acts, and the admin leaves and comes back.
  await form.getByLabel('Adjustment amount (₹)').fill('60');
  await form.getByLabel('Reason (kept with the entry)').fill('Lands after the check');
  await form.getByRole('button', { name: 'Review the adjustment' }).click();
  backend.dropNext = /\/adjustments$/;
  await form.getByRole('group', { name: 'Post the adjustment' }).getByRole('button', { name: 'Post adjustment' }).click();
  await expect(panel).toContainText('The outcome of this request is not known yet');
  const release = hold(backend, 'holdBefore', /\/adjustments$/);
  await panel.getByRole('button', { name: 'Send the same request again' }).click();
  await expect.poll(() => backend.holdBefore).toBeUndefined();
  await nav(page).getByRole('link', { name: 'Settlements' }).click();
  await page.getByRole('link', { name: 'City Lab' }).click();
  const back = page.getByRole('group', { name: 'Unconfirmed adjustment' });
  await back.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(back).toContainText('Not recorded so far, but it may still be finishing.');
  // The held resend reaches the server now and posts it; the give-up then finds the key used and shows what it posted.
  const landed = page.waitForResponse((r) => /\/adjustments$/.test(new URL(r.url()).pathname) && r.status() === 201);
  release();
  await landed;
  await back.getByRole('button', { name: 'Give up this adjustment' }).click();
  await expect(page.getByText('This adjustment had already been posted (₹60.00 added to the balance). Nothing was posted twice.')).toBeVisible();
  expect(backend.entries.filter((e) => e.source === 'admin_adjustment').map((e) => e.amountMinor)).toEqual([6000]);
  expect(await storage(page)).not.toMatch(/sd:pend|Lands after/);
});

test('Q13: a review closes when the account moves; FINANCE_CHANGED on a stale decision shows the account as it is now', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInAdmin(page);
  await page.evaluate((id) => { window.location.hash = `#/admin/settlements/${id}`; }, ACC1);
  const adj = page.getByRole('form', { name: 'Post an adjustment' });
  await adj.getByLabel('Adjustment amount (₹)').fill('100');
  await adj.getByLabel('Reason (kept with the entry)').fill('Correction after review');
  await adj.getByRole('button', { name: 'Review the adjustment' }).click();
  await expect(adj.getByRole('group', { name: 'Post the adjustment' })).toContainText('It goes from ₹14,750.00 to ₹14,850.00.');
  // Another admin posts an adjustment of ₹250 meanwhile (finance version 0 → 1); this page has not read it yet.
  const acc = backend.accounts.find((a) => a._id === ACC1)!;
  backend.entries.push({ _id: 'eb'.repeat(12), accountId: ACC1, at: NOW.toISOString(), kind: 'adjustment', source: 'admin_adjustment', sourceId: 'other:key', description: 'Adjustment', note: 'Elsewhere', amountMinor: 25000 });
  acc.financeVersion = 1;
  await adj.getByRole('button', { name: 'Post adjustment' }).click();
  await expect(page.getByText('Not posted: This account changed since it was loaded (a payout, adjustment or destination change); review it again')).toBeVisible();
  await expect(adj.getByRole('group', { name: 'Post the adjustment' })).toHaveCount(0);
  await expect(page.getByRole('definition').filter({ hasText: '₹' }).first()).toHaveText('₹15,000.00');
  expect(backend.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/adjustments')).map((c) => (c.body as Rec).expectedFinanceVersion)).toEqual([0]);
  await expect(adj.getByLabel('Adjustment amount (₹)')).toHaveValue('100');

  // Reviewing again names version 1; a payout review open on this page closes once the adjustment moves the account.
  const pay = page.getByRole('form', { name: 'Record a payout' });
  await pay.getByLabel('Amount paid (₹)').fill('100');
  await pay.getByLabel('Bank reference (UTR)').fill('UTR-REVIEW');
  await pay.getByRole('button', { name: 'Review the payout' }).click();
  await expect(pay.getByRole('group', { name: 'Record the payout' })).toBeVisible();
  await adj.getByRole('button', { name: 'Review the adjustment' }).click();
  await adj.getByRole('button', { name: 'Post adjustment' }).click();
  await expect(page.getByText('Adjustment posted: ₹100.00 added to the balance.')).toBeVisible();
  await expect(pay.getByRole('group', { name: 'Record the payout' })).toHaveCount(0);
  await expect(pay.getByText('The account changed while you were reviewing', { exact: false })).toBeVisible();
  expect(backend.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/adjustments')).map((c) => (c.body as Rec).expectedFinanceVersion)).toEqual([0, 1]);
  expect(backend.calls.some((c) => c.method === 'POST' && c.path.endsWith('/payouts'))).toBe(false);
});

test('Q13: details saved elsewhere after the re-read are refused by the server (PAYOUT_DETAILS_CHANGED); the form shows them and closes the review', async ({ page }) => {
  const backend = await mockBackend(page);
  await signInPartner(page);
  await nav(page).getByRole('link', { name: 'Finance' }).click();
  const dest = page.getByRole('region', { name: 'Where payouts are sent' });
  await dest.getByRole('button', { name: 'Change payout details' }).click();
  await dest.getByRole('radio', { name: 'UPI' }).check();
  await dest.getByLabel('UPI ID').fill('citylab@okhdfc');
  await dest.getByRole('button', { name: 'Review the change' }).click();
  backend.changeDetailsAfterNextRead = true;
  await dest.getByRole('group', { name: 'Save the payout details' }).getByRole('button', { name: 'Save payout details' }).click();
  await expect(dest.getByText('The payout details were changed elsewhere just as you saved, so nothing was saved.', { exact: false })).toBeVisible();
  await expect(dest.getByRole('group', { name: 'Save the payout details' })).toHaveCount(0);
  await expect(dest.getByLabel('UPI ID')).toHaveValue('other@okicici');
  await expect(dest.getByRole('definition').filter({ hasText: 'other@okicici' })).toBeVisible();
  const puts = backend.calls.filter((c) => c.method === 'PUT');
  expect(puts.map((c) => (c.body as Rec).expectedDetailsVersion)).toEqual([1]);
  expect(backend.accounts.find((a) => a._id === ACC1)!.details).toEqual({ method: 'upi', upiId: 'other@okicici' });
  expect(await storage(page)).not.toMatch(/citylab|okicici/);
});

test('Q13: payouts and events page by the server cursor (account, queue and partner), with totals and names from the rows', async ({ page }) => {
  const backend = await mockBackend(page);
  for (let i = 0; i < 120; i++) {
    const at = new Date(Date.parse('2026-10-01T06:00:00.000Z') + Math.floor(i / 2) * 60_000).toISOString(); // pairs share an instant
    backend.payouts.push({ _id: `fa${String(i).padStart(22, '0')}`, settlementAccountId: i % 2 ? ACC1 : ACC2, amountMinor: 1000 + i, method: 'bank_transfer',
      reference: `UTRP${String(i).padStart(3, '0')}`, paidOn: at.slice(0, 10), destination: { method: 'bank', label: 'x', detailsVersion: 1 }, state: 'recorded', by: ADMIN,
      requestKey: `seedkey${i}xx`, requestHash: '-', createdAt: at });
    backend.events.push({ _id: `ec${String(i).padStart(22, '0')}`, settlementAccountId: ACC1, action: 'finance.payout_details_verified', byKind: 'admin', by: ADMIN, at, detail: { version: 1 } });
  }
  await signInAdmin(page);
  await nav(page).getByRole('link', { name: 'Payouts' }).click();
  const table = page.getByRole('table', { name: 'Payouts, newest recorded first' });
  await expect(page.getByText('121 payouts · showing 100')).toBeVisible();
  await expect(table.getByRole('row').filter({ hasText: 'UTRP119' })).toContainText('City Lab');
  await expect(table.getByRole('row').filter({ hasText: 'UTRP118' })).toContainText('Dr Meera Rao');
  await page.getByRole('button', { name: 'Show older payouts' }).click();
  await expect(page.getByText('121 payouts · showing 121')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show older payouts' })).toHaveCount(0);
  const queue = backend.calls.filter((c) => c.path.startsWith('/settlements/payouts?')).map((c) => c.path);
  expect(queue[1]).toMatch(/^\/settlements\/payouts\?state=recorded&cursor=\d+_fa0+21&limit=100$/);
  expect(new Set(await table.locator('tbody tr td:nth-child(5)').allTextContents()).size).toBe(121);
  // No account list is read for names any more.
  expect(backend.calls.some((c) => c.path.startsWith('/settlements/accounts?'))).toBe(false);

  await table.getByRole('link', { name: 'City Lab' }).first().click();
  await expect(page.getByRole('heading', { name: 'City Lab', level: 1 })).toBeVisible();
  const payouts = page.getByRole('region', { name: 'Payouts', exact: true });
  await expect(payouts.getByText('61 in all · showing 50')).toBeVisible();
  await payouts.getByRole('button', { name: 'Show older payouts' }).click();
  await expect(payouts.getByText('61 in all · showing 61')).toBeVisible();
  const events = page.getByRole('region', { name: 'Finance events', exact: true });
  await expect(events.getByText('123 in all · showing 50')).toBeVisible();
  await events.getByRole('button', { name: 'Show older events' }).click();
  await expect(events.getByText('123 in all · showing 100')).toBeVisible();
  expect(backend.calls.some((c) => new RegExp(`^/settlements/accounts/${ACC1}/events\\?cursor=\\d+_ec\\d{22}&limit=50$`).test(c.path))).toBe(true);
  expect(backend.calls.some((c) => new RegExp(`^/settlements/accounts/${ACC1}/payouts\\?cursor=\\d+_fa0+\\d+&limit=50$`).test(c.path))).toBe(true);

  // The partner's own page pages the same way through its workspace routes.
  await page.evaluate((id) => { window.location.hash = `#/admin/partners/${id}/finance`; }, LAB);
  await expect(page.getByRole('region', { name: 'Payouts', exact: true }).getByText('61 in all · showing 50')).toBeVisible();
  await page.getByRole('region', { name: 'Payouts', exact: true }).getByRole('button', { name: 'Show older payouts' }).click();
  await expect(page.getByRole('region', { name: 'Payouts', exact: true }).getByText('61 in all · showing 61')).toBeVisible();
  expect(backend.calls.some((c) => c.path === `/partner-workspace/admin/${LAB}/workspace/finance/events?limit=50`)).toBe(true);
});
