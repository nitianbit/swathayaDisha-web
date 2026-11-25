import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * WQ26: referral cuts (assisted booking phase 4a/4b), against a mocked backend mirroring `src1/modules/referralCuts`:
 * the admin rules (`ruleBodySchema`: percent 1–5000 bp, fixed ≥ 1, cap ≥ 1, `expectedVersion`, reason; `putRule`: 0 =
 * create, else the version fence, 409 RECORD_CHANGED; one event per version; `effective` = active AND
 * REFERRAL_CUTS_ENABLED) and the pharmacy's reads (`/pharmacy-assisted/referral-rules`, `/referral`, `/referral/statement`
 * newest first by `before`, short refs only).
 */
const ADMIN = 'ad'.repeat(12);
const OTHER_ADMIN = 'ae'.repeat(12);
const P1 = 'f1'.repeat(12);
const LAB = 'c1'.repeat(12);
const NOW = new Date('2026-11-25T04:30:00.000Z');

type Rec = Record<string, unknown>;
interface Rule {
  _id: string; bookerKind: string; bookerId: string; category: string; basis: string; percentBasisPoints?: number; fixedMinor?: number; capMinor?: number;
  isActive: boolean; version: number; updatedBy: string; updatedAt: string;
}
interface Backend {
  calls: { method: string; path: string; body: unknown }[];
  rules: Rule[];
  events: Rec[];
  /** REFERRAL_CUTS_ENABLED. */
  cutsOn: boolean;
  /** REFERRAL_PAYOUTS_ENABLED. */
  payoutsOn: boolean;
  /** Another admin saves these terms on the rule just before the next PUT lands (a new version). */
  bumpBeforePut?: Partial<Rule>;
  /** The next PUT is saved, then its answer is lost. */
  losePutAfter?: boolean;
  statement: Rec[];
}

const terms = (r: Partial<Rule>) => ({ basis: r.basis, percentBasisPoints: r.percentBasisPoints ?? null, fixedMinor: r.fixedMinor ?? null, capMinor: r.capMinor ?? null, isActive: r.isActive });
let seq = 0;
const stamp = () => new Date(NOW.getTime() + 60_000 * ++seq).toISOString();
const newId = () => (++seq).toString(16).padStart(24, '0');

/** Newest first: two referral earnings named by short ref, then 50 more, so the statement has a second page. */
function statementLines(): Rec[] {
  const lines: Rec[] = [];
  const add = (source: string, description: string, grossMinor: number, amountMinor: number) => {
    const i = lines.length;
    lines.push({ _id: (i + 1).toString(16).padStart(24, '0'), at: new Date(NOW.getTime() - (i + 1) * 3_600_000).toISOString(), kind: 'earning', source,
      sourceId: `b${i}`.padEnd(24, '0'), description, amountMinor, grossMinor, commissionMinor: 0 });
  };
  add('referral_consultation', 'Referral · consultation · 2026-11-24 · Ref ABCD2345', 50000, 5000);
  add('referral_lab_booking', 'Referral · lab booking · 2026-11-23 · Ref LMNO2222', 104500, 5500);
  for (let i = 2; i < 52; i++) add('referral_consultation', `Referral · consultation · 2026-11-20 · Ref CONS${String(i).padStart(4, '0')}`, 30000, 3000);
  let after = lines.reduce((a, l) => a + Number(l.amountMinor), 0);
  for (const l of lines) { l.balanceAfterMinor = after; after -= Number(l.amountMinor); }
  return lines;
}

async function mockBackend(page: Page): Promise<Backend> {
  await page.clock.setSystemTime(NOW);
  const b: Backend = { calls: [], rules: [], events: [], cutsOn: true, payoutsOn: false, statement: statementLines() };
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const ok = (route: Route, data: unknown, extra: Rec = {}) => json(route, 200, { success: true, data, ...extra });
  const fail = (route: Route, status: number, code: string, message: string) => json(route, status, { error: status, code, message });
  const view = (r: Rule, admin: boolean) => ({ _id: r._id, category: r.category, ...terms(r), version: r.version, updatedAt: r.updatedAt,
    effective: r.isActive && b.cutsOn && r.bookerKind !== 'doctor', ...(admin ? { updatedBy: r.updatedBy } : {}) });
  const save = (r: Rule, next: Partial<Rule>, by: string, reason: string) => {
    const before = r.version > 0 ? terms(r) : null;
    delete r.percentBasisPoints; delete r.fixedMinor; delete r.capMinor;
    Object.assign(r, next, { version: r.version + 1, updatedBy: by, updatedAt: stamp() });
    if (!b.rules.includes(r)) b.rules.push(r);
    b.events.push({ ruleId: r._id, version: r.version, before, after: terms(r), by, reason, at: r.updatedAt });
  };

  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = req.method();
    const body = ['POST', 'PUT'].includes(method) ? req.postDataJSON() : null;
    if (path.startsWith('/auth/session')) return fail(route, 401, 'SESSION_ENDED', 'Please sign in again');
    b.calls.push({ method, path: `${path}${url.search}`, body });
    if (path === '/auth/admin/send' || path === '/auth/pharmacy/send') return ok(route, undefined);
    if (path === '/auth/admin/verify') return ok(route, { token: 'admin', expiresIn: 900, user: {} });
    if (path === '/auth/pharmacy/verify') return ok(route, { token: 'pharmacy', expiresIn: 900, user: {} });
    const auth = req.headers().authorization;
    if (auth !== 'Bearer admin' && auth !== 'Bearer pharmacy') return fail(route, 401, 'UNAUTHORIZED', 'Authentication is required');
    const isAdmin = auth === 'Bearer admin';
    if (path === '/auth/profile') {
      return ok(route, isAdmin ? { user: { _id: ADMIN, name: 'Ops Admin' }, userRole: 'admin' } : { user: { _id: P1, name: 'Apollo Pharmacy' }, userRole: 'pharmacy' });
    }

    if (path === `/pharmacies/${P1}` && method === 'GET') {
      return ok(route, { _id: P1, name: 'Apollo Pharmacy', phone: '9000000001', city: 'Pune', ownerName: 'Ravi', isVerified: true, isActive: true,
        createdAt: '2026-11-01T05:00:00.000Z', updatedAt: '2026-11-01T05:00:00.000Z' });
    }
    if (path === `/partner-workspace/admin/${LAB}` && method === 'GET') {
      return ok(route, { _id: LAB, kind: 'lab', name: 'City Labs', solo: false, isActive: true, activeOwnerCount: 1, verification: { state: 'verified' },
        contact: { phone: '9000000050' }, createdAt: '2026-11-01T05:00:00.000Z', updatedAt: '2026-11-01T05:00:00.000Z' });
    }

    // Phase 4a admin rules (`adminAssistedRouter`: requireAdmin).
    if (path.startsWith('/admin/referral-rules')) {
      if (!isAdmin) return fail(route, 403, 'FORBIDDEN', 'Admin access is required');
      if (path === '/admin/referral-rules' && method === 'GET') {
        const kind = url.searchParams.get('bookerKind');
        const id = url.searchParams.get('bookerId');
        return ok(route, b.rules.filter((r) => r.bookerKind === kind && r.bookerId === id).sort((x, y) => x.category.localeCompare(y.category)).map((r) => view(r, true)));
      }
      const m = /^\/admin\/referral-rules\/(pharmacy|lab|doctor)\/([0-9a-f]{24})\/(consultation|lab_test|lab_package)(\/events)?$/.exec(path);
      if (!m) return fail(route, 404, 'NOT_FOUND', 'Not found');
      const [, kind, id, category, events] = m;
      const existing = b.rules.find((r) => r.bookerKind === kind && r.bookerId === id && r.category === category);
      if (events && method === 'GET') {
        return ok(route, existing ? b.events.filter((e) => e.ruleId === existing._id).sort((x, y) => Number(y.version) - Number(x.version)) : []);
      }
      if (events || method !== 'PUT') return fail(route, 404, 'NOT_FOUND', 'Not found');
      const x = body as Rec;
      const allowed = ['basis', 'percentBasisPoints', 'fixedMinor', 'capMinor', 'isActive', 'expectedVersion', 'reason'];
      const int = (v: unknown, min: number, max = Infinity) => Number.isInteger(v) && Number(v) >= min && Number(v) <= max;
      const reason = typeof x.reason === 'string' ? x.reason.trim() : '';
      if (Object.keys(x).some((k) => !allowed.includes(k)) || !['percent', 'fixed'].includes(String(x.basis)) || typeof x.isActive !== 'boolean'
        || !int(x.expectedVersion, 0) || reason.length < 1 || reason.length > 500
        || (x.percentBasisPoints !== undefined && !int(x.percentBasisPoints, 1, 5000)) || (x.fixedMinor !== undefined && !int(x.fixedMinor, 1))
        || (x.capMinor !== undefined && !int(x.capMinor, 1))) {
        return fail(route, 400, 'VALIDATION_ERROR', 'Invalid rule');
      }
      if (x.basis === 'percent' && x.percentBasisPoints === undefined) return fail(route, 400, 'VALIDATION_ERROR', 'A percent rule needs percentBasisPoints from 1 to 5000 (0.01% to 50%)');
      if (x.basis === 'fixed' && x.fixedMinor === undefined) return fail(route, 400, 'VALIDATION_ERROR', 'A fixed rule needs fixedMinor ≥ 1');
      if (!((kind === 'pharmacy' && id === P1) || (kind === 'lab' && id === LAB))) return fail(route, 404, 'BOOKER_NOT_FOUND', 'Partner not found');
      if (b.bumpBeforePut) {
        const r = existing ?? { _id: newId(), bookerKind: kind!, bookerId: id!, category: category!, basis: 'percent', isActive: true, version: 0, updatedBy: OTHER_ADMIN, updatedAt: stamp() };
        save(r, { basis: r.basis, ...(r.basis === 'percent' ? { percentBasisPoints: r.percentBasisPoints } : { fixedMinor: r.fixedMinor }), isActive: r.isActive, ...b.bumpBeforePut },
          OTHER_ADMIN, 'Changed by another admin');
        b.bumpBeforePut = undefined;
      }
      const rule = b.rules.find((r) => r.bookerKind === kind && r.bookerId === id && r.category === category);
      const changed = () => fail(route, 409, 'RECORD_CHANGED', 'This rule was changed meanwhile; reload it and try again');
      if (x.expectedVersion === 0 ? !!rule : rule?.version !== x.expectedVersion) return changed();
      const next: Partial<Rule> = { basis: String(x.basis), isActive: x.isActive as boolean,
        ...(x.basis === 'percent' ? { percentBasisPoints: x.percentBasisPoints as number } : { fixedMinor: x.fixedMinor as number }),
        ...(x.capMinor ? { capMinor: x.capMinor as number } : {}) };
      const target = rule ?? { _id: newId(), bookerKind: kind!, bookerId: id!, category: category!, basis: String(x.basis), isActive: true, version: 0, updatedBy: ADMIN, updatedAt: stamp() };
      save(target, next, ADMIN, reason);
      if (b.losePutAfter) { b.losePutAfter = false; return route.abort('failed'); }
      return ok(route, view(target, true));
    }

    // Phase 4b pharmacy reads (`pharmacyAssistedRouter`: an operational pharmacy).
    if (path.startsWith('/pharmacy-assisted/')) {
      if (isAdmin) return fail(route, 403, 'FORBIDDEN', 'Pharmacy access is required');
      if (path === '/pharmacy-assisted/referral-rules') return ok(route, b.rules.filter((r) => r.bookerKind === 'pharmacy' && r.bookerId === P1).map((r) => view(r, false)));
      if (path === '/pharmacy-assisted/referral') {
        const earned = b.statement.reduce((a, l) => a + Number(l.amountMinor), 0);
        return ok(route, { earnedMinor: earned, paidMinor: 0, dueMinor: earned, payoutsEnabled: b.payoutsOn });
      }
      if (path === '/pharmacy-assisted/referral/statement') {
        const limit = Number(url.searchParams.get('limit') ?? 50);
        const before = url.searchParams.get('before');
        const from = before ? b.statement.findIndex((l) => `${Date.parse(String(l.at))}_${l._id}` === before) + 1 : 0;
        const rows = b.statement.slice(from, from + limit);
        const last = rows[rows.length - 1];
        const more = from + limit < b.statement.length;
        return ok(route, rows, { pagination: { nextCursor: more && last ? `${Date.parse(String(last.at))}_${last._id}` : null } });
      }
    }
    return fail(route, 404, 'NOT_FOUND', 'Not found');
  });
  return b;
}

async function signIn(page: Page, as: 'Admin' | 'Pharmacy' = 'Admin') {
  await page.goto('/');
  if (as === 'Admin') await page.getByLabel('Admin').check();
  await page.getByLabel('Mobile number').fill('9876543210');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

const puts = (b: Backend) => b.calls.filter((c) => c.method === 'PUT').map((c) => ({ path: c.path, body: c.body }));
const stored = (page: Page) => page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + location.href);
const rule = (o: Partial<Rule>): Rule => ({ _id: newId(), bookerKind: 'pharmacy', bookerId: P1, category: 'consultation', basis: 'percent', percentBasisPoints: 1000,
  isActive: true, version: 1, updatedBy: ADMIN, updatedAt: '2026-11-20T05:00:00.000Z', ...o });

/** Opens the editor of one category, sets it, and confirms with a reason. */
async function setCut(page: Page, category: string, fill: (editor: ReturnType<Page['getByRole']>) => Promise<void>, reason: string) {
  const cuts = page.getByRole('region', { name: 'Cuts by category' });
  await cuts.getByRole('button', { name: `Edit the ${category} cut` }).click();
  const editor = cuts.getByRole('group', { name: `Change the ${category} cut` });
  await fill(editor);
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  const confirm = editor.getByRole('group', { name: 'Save', exact: true });
  await confirm.getByLabel('Reason (kept in the history)').fill(reason);
  await confirm.getByRole('button', { name: `Save the ${category} cut` }).click();
  return { cuts, editor, confirm };
}

test('set a percent rule: checked as the server checks it, confirmed with a reason, sent as a create, shown with its history', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await page.goto(`/#/admin/pharmacies/${P1}`);
  await page.getByRole('link', { name: 'Referral cuts' }).click();
  await expect(page.getByRole('heading', { name: 'Referral cuts: Apollo Pharmacy', level: 1 })).toBeVisible();
  const cuts = page.getByRole('region', { name: 'Cuts by category' });
  for (const name of ['Consultation', 'Lab test', 'Lab package']) await expect(cuts.getByRole('row', { name: new RegExp(`^${name}`) })).toContainText('OffNever set');
  await expect(page.getByRole('region', { name: 'History' })).toContainText('No changes yet');

  await cuts.getByRole('button', { name: 'Edit the consultation cut' }).click();
  const editor = cuts.getByRole('group', { name: 'Change the consultation cut' });
  await expect(editor.getByText('No cut is set, so there is nothing to switch off.')).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await editor.getByLabel('Cut', { exact: true }).selectOption('percent');
  await editor.getByLabel('Percent', { exact: true }).fill('50.5');
  await expect(editor.getByText('Enter a percentage from 0.01 to 50, with at most two decimals.')).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await editor.getByLabel('Percent', { exact: true }).fill('10');
  await editor.getByLabel('Cap per line in ₹ (optional)').fill('100');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  const confirm = editor.getByRole('group', { name: 'Save', exact: true });
  await expect(confirm).toContainText('New consultation bookings that Apollo Pharmacy makes: 10% of each line, at most ₹100.00 a line goes to Apollo Pharmacy, taken from the doctor’s earning.');
  await confirm.getByRole('button', { name: 'Save the consultation cut' }).click();
  await expect(confirm.getByText('Give a reason (at least 3 characters).')).toBeVisible();
  await confirm.getByLabel('Reason (kept in the history)').fill('Agreed at onboarding');
  await confirm.getByRole('button', { name: 'Save the consultation cut' }).click();

  await expect(cuts.getByText('Saved: the consultation cut of Apollo Pharmacy is 10% of each line, at most ₹100.00 a line (version 1).')).toBeVisible();
  await expect(editor).toHaveCount(0);
  await expect(cuts.getByRole('row', { name: /^Consultation/ })).toContainText('10% of each line, at most ₹100.00 a line');
  await expect(cuts.getByRole('row', { name: /^Consultation/ })).toContainText('version 1');
  // The switch is on: no switch-off note.
  await expect(page.getByText('Referral cuts are switched off; rules are saved but not applied.')).toHaveCount(0);
  const history = page.getByRole('region', { name: 'History' });
  await expect(history.getByRole('row').nth(1)).toContainText('Consultation');
  await expect(history.getByRole('row').nth(1)).toContainText('Off → 10% of each line, at most ₹100.00 a line');
  await expect(history.getByRole('row').nth(1)).toContainText('Agreed at onboarding');
  await expect(history.getByRole('row').nth(1)).toContainText('You');
  expect(puts(backend)).toEqual([{
    path: `/admin/referral-rules/pharmacy/${P1}/consultation`,
    body: { basis: 'percent', percentBasisPoints: 1000, capMinor: 10000, isActive: true, expectedVersion: 0, reason: 'Agreed at onboarding' },
  }]);
  expect(await stored(page)).not.toContain('onboarding');
});

test('set a fixed rule (no upper limit, no cap) for a lab; a lost answer is checked by reading the rules', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await page.goto(`/#/admin/partners/${LAB}`);
  await page.getByRole('link', { name: 'Referral cuts' }).click();
  await expect(page.getByRole('heading', { name: 'Referral cuts: City Labs', level: 1 })).toBeVisible();

  const first = await setCut(page, 'lab test', async (editor) => {
    await editor.getByLabel('Cut', { exact: true }).selectOption('fixed');
    await expect(editor.getByLabel('Cap per line in ₹ (optional)')).toHaveCount(0);
    await editor.getByLabel('Amount per line in ₹').fill('0');
    await expect(editor.getByText('Enter the amount per line in rupees, at least ₹0.01, with at most two decimals.')).toBeVisible();
    await editor.getByLabel('Amount per line in ₹').fill('25000');
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editor.getByRole('group', { name: 'Save', exact: true })).toContainText('₹25,000.00 a line goes to City Labs, taken from the lab’s earning.');
    await editor.getByRole('button', { name: 'Back' }).click();
  }, 'Lab partner rate');
  await expect(first.cuts.getByText('Saved: the lab test cut of City Labs is ₹25,000.00 a line (version 1).')).toBeVisible();
  await expect(first.cuts.getByRole('row', { name: /^Lab test/ })).toContainText('₹25,000.00 a line');

  // The answer of the next save is lost: the change is kept as unconfirmed, and a check finds it saved.
  backend.losePutAfter = true;
  await setCut(page, 'lab package', async (editor) => {
    await editor.getByLabel('Cut', { exact: true }).selectOption('fixed');
    await editor.getByLabel('Amount per line in ₹').fill('40');
  }, 'Packages too');
  const panel = first.cuts.getByRole('group', { name: 'Unconfirmed change' });
  await expect(panel).toContainText('The outcome of this change is not known yet');
  await expect(first.cuts.getByRole('button', { name: 'Edit the lab test cut' })).toBeDisabled();
  await panel.getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(first.cuts.getByText('Saved: the lab package cut of City Labs is ₹40.00 a line (version 1).')).toBeVisible();
  await expect(panel).toHaveCount(0);
  await expect(first.cuts.getByRole('row', { name: /^Lab package/ })).toContainText('₹40.00 a line');
  expect(puts(backend)).toEqual([
    { path: `/admin/referral-rules/lab/${LAB}/lab_test`, body: { basis: 'fixed', fixedMinor: 2500000, isActive: true, expectedVersion: 0, reason: 'Lab partner rate' } },
    { path: `/admin/referral-rules/lab/${LAB}/lab_package`, body: { basis: 'fixed', fixedMinor: 4000, isActive: true, expectedVersion: 0, reason: 'Packages too' } },
  ]);
});

test('a version conflict: nothing is saved, the rules are read again, and the change is sent again on the new version', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.rules.push(rule({}));
  await signIn(page);
  await page.goto(`/#/admin/pharmacies/${P1}/referral-cuts`);
  const cuts = page.getByRole('region', { name: 'Cuts by category' });
  await expect(cuts.getByRole('row', { name: /^Consultation/ })).toContainText('10% of each line');
  backend.bumpBeforePut = { percentBasisPoints: 1200 };
  const { editor } = await setCut(page, 'consultation', async (e) => {
    await expect(e.getByLabel('Percent', { exact: true })).toHaveValue('10');
    await e.getByLabel('Percent', { exact: true }).fill('15');
  }, 'Raised rate');
  await expect(cuts.getByText('The consultation cut was changed by someone else meanwhile, so your change was not saved. Saved now: 12% of each line (version 2). Check it, then save again if your change is still needed.')).toBeVisible();
  await expect(cuts.getByRole('row', { name: /^Consultation/ })).toContainText('12% of each line');
  // The editor stays with what was typed, now made from version 2.
  await expect(editor.getByLabel('Percent', { exact: true })).toHaveValue('15');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  const confirm = editor.getByRole('group', { name: 'Save', exact: true });
  await confirm.getByLabel('Reason (kept in the history)').fill('Raised rate');
  await confirm.getByRole('button', { name: 'Save the consultation cut' }).click();
  await expect(cuts.getByText('Saved: the consultation cut of Apollo Pharmacy is 15% of each line (version 3).')).toBeVisible();
  await expect(page.getByRole('region', { name: 'History' }).getByRole('row')).toHaveCount(3);
  await expect(page.getByRole('region', { name: 'History' }).getByRole('row').nth(1)).toContainText('12% of each line → 15% of each line');
  await expect(page.getByRole('region', { name: 'History' }).getByRole('row').nth(2)).toContainText('Jansetu admin');
  expect(puts(backend).map((p) => (p.body as Rec).expectedVersion)).toEqual([1, 2]);
  expect(puts(backend).map((p) => (p.body as Rec).percentBasisPoints)).toEqual([1500, 1500]);
});

test('switch-off note: shown once an active rule does not cut; turning the cut off sends the saved terms inactive', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.cutsOn = false;
  await signIn(page);
  await page.goto(`/#/admin/pharmacies/${P1}/referral-cuts`);
  const note = page.getByText('Referral cuts are switched off; rules are saved but not applied.');
  const cuts = page.getByRole('region', { name: 'Cuts by category' });
  await expect(cuts.getByRole('row', { name: /^Consultation/ })).toContainText('Off');
  await expect(note).toHaveCount(0);
  await setCut(page, 'consultation', async (e) => {
    await e.getByLabel('Cut', { exact: true }).selectOption('percent');
    await e.getByLabel('Percent', { exact: true }).fill('5');
  }, 'Pilot rate');
  await expect(cuts.getByText('Saved: the consultation cut of Apollo Pharmacy is 5% of each line (version 1).')).toBeVisible();
  await expect(note).toBeVisible();

  await setCut(page, 'consultation', async (e) => {
    await e.getByLabel('Cut', { exact: true }).selectOption('off');
    await e.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(e.getByRole('group', { name: 'Save', exact: true })).toContainText('New consultation bookings that Apollo Pharmacy makes earn it no cut.');
    await e.getByRole('button', { name: 'Back' }).click();
  }, 'Pilot over');
  await expect(cuts.getByText('Saved: the consultation cut of Apollo Pharmacy is off (version 2).')).toBeVisible();
  await expect(cuts.getByRole('row', { name: /^Consultation/ })).toContainText('Kept but not used: 5% of each line');
  await expect(note).toHaveCount(0);
  expect(puts(backend).map((p) => p.body)).toEqual([
    { basis: 'percent', percentBasisPoints: 500, isActive: true, expectedVersion: 0, reason: 'Pilot rate' },
    { basis: 'percent', percentBasisPoints: 500, isActive: false, expectedVersion: 1, reason: 'Pilot over' },
  ]);
});

test('pharmacy: referral earnings (earned, paid, due), its rates and the statement by short ref, read only', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.rules.push(rule({}), rule({ category: 'lab_test', basis: 'fixed', percentBasisPoints: undefined, fixedMinor: 4000, isActive: false }));
  await signIn(page, 'Pharmacy');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Referral earnings' }).click();
  await expect(page.getByRole('heading', { name: 'Referral earnings', level: 1 })).toBeVisible();
  const cards = page.getByLabel('Referral earnings', { exact: true });
  // ₹50 + ₹55 + 50 × ₹30 = ₹1,605.00 earned, nothing paid (payouts paused), all of it due.
  await expect(cards).toContainText('Due to you₹1,605.00');
  await expect(cards).toContainText('Earned₹1,605.00');
  await expect(cards).toContainText('Paid to you₹0.00');
  await expect(page.getByText('Payouts start once Jansetu switches them on.')).toBeVisible();
  const rates = page.getByRole('region', { name: 'Your rates' });
  await expect(rates).toContainText('Consultation10% of each line');
  await expect(rates).toContainText('Lab testOff');
  await expect(rates).toContainText('Lab packageOff');

  const statement = page.getByRole('region', { name: 'Statement' });
  const rows = statement.getByRole('row');
  await expect(rows).toHaveCount(51);
  await expect(rows.nth(1)).toContainText('ABCD2345');
  await expect(rows.nth(1)).toContainText('Consultation₹500.00₹50.00');
  await expect(rows.nth(2)).toContainText('LMNO2222Lab booking₹1,045.00₹55.00');
  await statement.getByRole('button', { name: 'Older' }).click();
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(2)).toContainText('CONS0051');
  await expect(statement.getByRole('button', { name: 'Older' })).toBeDisabled();
  const reads = backend.calls.filter((c) => c.path.startsWith('/pharmacy-assisted/referral/statement')).map((c) => c.path);
  expect(reads).toEqual(['/pharmacy-assisted/referral/statement?limit=50', `/pharmacy-assisted/referral/statement?before=${Date.parse(String(backend.statement[49]!.at))}_${backend.statement[49]!._id}&limit=50`]);
  // Read only: nothing to change here, and nothing about the bookings is kept on this device or in the address.
  await expect(page.getByRole('button', { name: /Edit/ })).toHaveCount(0);
  expect(backend.calls.some((c) => c.method !== 'GET' && c.path.includes('referral'))).toBe(false);
  expect(await stored(page)).not.toMatch(/ABCD2345|CONS00/);
});

test('a non-admin cannot reach or change the referral cuts', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page, 'Pharmacy');
  await page.goto(`/#/admin/pharmacies/${P1}/referral-cuts`);
  await expect(page.getByText('This page does not exist or is not available to your account.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Edit the/ })).toHaveCount(0);
  await page.goto(`/#/admin/partners/${LAB}/referral-cuts`);
  await expect(page.getByText('This page does not exist or is not available to your account.')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Referral cuts' })).toHaveCount(0);
  expect(backend.calls.some((c) => c.path.startsWith('/admin/referral-rules'))).toBe(false);
});
