import { ApiError, createApiClient } from './client.ts';
import {
  basisPointsToInput, CAP_PROBLEM, FIXED_PROBLEM, PERCENT_PROBLEM, percentToBasisPoints, referralDraftOf, referralReadsApi, referralRowOf,
  referralRuleBody, referralRuleRefusal, referralRuleRefusedBeforeWriting, referralRulesAdminApi, referralRuleText, referralTermsOf, referralTermsText,
  ruleTerms, sameRuleTerms, type ReferralRule, type ReferralStatementLine,
} from './referralCuts.ts';

const PH = 'f1'.repeat(12);
const LAB = 'c1'.repeat(12);
const CURSOR = `1764050000000_${'a'.repeat(24)}`;

function recorder(answer: (url: string, method: string) => unknown = () => ({ success: true, data: [] })) {
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

const rule = (o: Partial<ReferralRule> = {}): ReferralRule => ({
  _id: 'r1'.repeat(12), category: 'consultation', basis: 'percent', percentBasisPoints: 1000, fixedMinor: null, capMinor: null, isActive: true, version: 1,
  updatedAt: '2026-11-25T05:00:00.000Z', effective: true, ...o,
});

describe('WQ26 referral cuts: the percent and the money typed', () => {
  it('a percent is 0.01 to 50 with at most two decimals, as basis points (1–5000), without floating point', () => {
    expect(percentToBasisPoints('10')).toBe(1000);
    expect(percentToBasisPoints(' 2.5 ')).toBe(250);
    expect(percentToBasisPoints('0.01')).toBe(1);
    expect(percentToBasisPoints('12.34%')).toBe(1234);
    expect(percentToBasisPoints('50')).toBe(5000);
    expect(percentToBasisPoints('49.99')).toBe(4999);
    for (const bad of ['50.01', '51', '100', '0', '0.00', '0.001', '-5', '1e1', '', '.5', '10.', 'ten', '5,5']) expect(percentToBasisPoints(bad)).toBeNull();
    expect(['1', '10', '250', '1234', '5000', '1050'].map((n) => basisPointsToInput(Number(n)))).toEqual(['0.01', '0.1', '2.5', '12.34', '50', '10.5']);
  });

  it('fixed: at least ₹0.01 a line and no upper limit (no cap); percent: an optional cap of at least ₹0.01', () => {
    const off = { mode: 'off' as const, percent: '', fixed: '', cap: '' };
    expect(referralTermsOf({ ...off, mode: 'fixed', fixed: '50' })).toEqual({
      terms: { basis: 'fixed', percentBasisPoints: null, fixedMinor: 5000, capMinor: null, isActive: true }, errors: {} });
    expect(referralTermsOf({ ...off, mode: 'fixed', fixed: '0.01' }).terms?.fixedMinor).toBe(1);
    // A fixed cut has no upper limit: far above any booking is accepted (the server cuts at most the line's base).
    expect(referralTermsOf({ ...off, mode: 'fixed', fixed: '1,50,000.50' }).terms?.fixedMinor).toBe(15_000_050);
    // A cap typed with a fixed amount is not sent (a cap below it would only lower it).
    expect(referralTermsOf({ ...off, mode: 'fixed', fixed: '50', cap: '10' }).terms?.capMinor).toBeNull();
    for (const bad of ['0', '0.00', '0.001', '-1', '', 'abc']) expect(referralTermsOf({ ...off, mode: 'fixed', fixed: bad })).toEqual({ terms: null, errors: { fixed: FIXED_PROBLEM } });

    expect(referralTermsOf({ ...off, mode: 'percent', percent: '10', cap: '100' }).terms).toEqual(
      { basis: 'percent', percentBasisPoints: 1000, fixedMinor: null, capMinor: 10000, isActive: true });
    expect(referralTermsOf({ ...off, mode: 'percent', percent: '10', cap: ' ' }).terms?.capMinor).toBeNull();
    expect(referralTermsOf({ ...off, mode: 'percent', percent: '50.5', cap: '0' })).toEqual({ terms: null, errors: { percent: PERCENT_PROBLEM, cap: CAP_PROBLEM } });
  });

  it('off keeps the saved amounts and sets isActive false; with no rule there is nothing to switch off', () => {
    const off = { mode: 'off' as const, percent: '', fixed: '', cap: '' };
    expect(referralTermsOf(off, rule({ capMinor: 5000 })).terms).toEqual({ basis: 'percent', percentBasisPoints: 1000, fixedMinor: null, capMinor: 5000, isActive: false });
    expect(referralTermsOf(off, null)).toEqual({ terms: null, errors: {} });
    // The editor starts from the rule as saved; an inactive rule keeps its amounts for when it is turned on again.
    expect(referralDraftOf(rule({ percentBasisPoints: 250, capMinor: 10050 }))).toEqual({ mode: 'percent', percent: '2.5', fixed: '', cap: '100.50' });
    expect(referralDraftOf(rule({ basis: 'fixed', percentBasisPoints: null, fixedMinor: 4000, isActive: false }))).toEqual({ mode: 'off', percent: '', fixed: '40', cap: '' });
    expect(referralDraftOf(null)).toEqual(off);
  });

  it('compares terms as the history records them (the other basis dropped) and words them with formatPaise', () => {
    expect(ruleTerms({ basis: 'fixed', fixedMinor: 4000, percentBasisPoints: 500, isActive: true })).toEqual(
      { basis: 'fixed', percentBasisPoints: null, fixedMinor: 4000, capMinor: null, isActive: true });
    expect(sameRuleTerms(rule(), { basis: 'percent', percentBasisPoints: 1000, fixedMinor: null, capMinor: null, isActive: true })).toBe(true);
    expect(sameRuleTerms(rule(), { ...rule(), isActive: false })).toBe(false);
    expect(sameRuleTerms(rule(), { ...rule(), capMinor: 100 })).toBe(false);
    expect(referralTermsText(rule({ capMinor: 10000 }))).toBe('10% of each line, at most ₹100.00 a line');
    expect(referralTermsText(rule({ basis: 'fixed', fixedMinor: 250000 }))).toBe('₹2,500.00 a line');
    expect(referralRuleText(rule({ isActive: false }))).toBe('Off');
    expect(referralRuleText(null)).toBe('Off');
    expect(referralRuleText({ basis: 'percent', percentBasisPoints: 5000, isActive: true })).toBe('50% of each line');
  });

  it('the PUT body is checked again: percent ≤ 50%, fixed ≥ ₹0.01 with no upper limit, a version and a reason', () => {
    const pct = { basis: 'percent' as const, percentBasisPoints: 1000, fixedMinor: null, capMinor: 10000, isActive: true };
    expect(referralRuleBody(pct, 0, ' New partner ')).toEqual({ basis: 'percent', percentBasisPoints: 1000, capMinor: 10000, isActive: true, expectedVersion: 0, reason: 'New partner' });
    expect(referralRuleBody({ ...pct, basis: 'fixed', fixedMinor: 99_999_999_999, capMinor: null }, 3, 'x')).toEqual(
      { basis: 'fixed', fixedMinor: 99_999_999_999, isActive: true, expectedVersion: 3, reason: 'x' });
    expect(() => referralRuleBody({ ...pct, percentBasisPoints: 5001 }, 0, 'x')).toThrow('Invalid percent');
    expect(() => referralRuleBody({ ...pct, percentBasisPoints: 0 }, 0, 'x')).toThrow('Invalid percent');
    expect(() => referralRuleBody({ ...pct, basis: 'fixed', fixedMinor: 0 }, 0, 'x')).toThrow('Invalid fixed amount');
    expect(() => referralRuleBody({ ...pct, capMinor: 0 }, 0, 'x')).toThrow('Invalid cap');
    expect(() => referralRuleBody(pct, -1, 'x')).toThrow('Invalid version');
    expect(() => referralRuleBody(pct, 0, '  ')).toThrow('Invalid reason');
    expect(() => referralRuleBody(pct, 0, 'x'.repeat(501))).toThrow('Invalid reason');
  });
});

describe('WQ26 referral cuts: refusals and statement rows', () => {
  it('refusals in words; the tools switch and the index check settle a sole first attempt', () => {
    expect(referralRuleRefusal(new ApiError(409, 'This rule was changed meanwhile; reload it and try again', 'RECORD_CHANGED'))).toBe('This cut was changed by someone else meanwhile, so nothing was saved.');
    expect(referralRuleRefusal(new ApiError(400, 'A percent rule needs percentBasisPoints from 1 to 5000 (0.01% to 50%)', 'VALIDATION_ERROR'))).toContain('0.01% to 50%');
    expect(referralRuleRefusedBeforeWriting(new ApiError(503, 'off', 'ASSISTED_BOOKING_DISABLED'))).toBe(true);
    expect(referralRuleRefusedBeforeWriting(new ApiError(503, 'idx', 'INDEXES_OUTDATED'))).toBe(true);
    expect(referralRuleRefusedBeforeWriting(new ApiError(503, 'down'))).toBe(false);
    expect(referralRuleRefusedBeforeWriting(new ApiError(500, 'x', 'INDEXES_OUTDATED'))).toBe(false);
  });

  it('WQ26b (r33): a statement row from shortRef, category and lines (never the description); the base only on earnings', () => {
    const line = (o: Partial<ReferralStatementLine>): ReferralStatementLine => ({
      _id: 'l1', at: '2026-11-25T06:00:00.000Z', kind: 'earning', source: 'referral_consultation', sourceId: 'b1'.repeat(12),
      description: 'Referral · consultation · 2026-11-24 · Ref WRONG999', amountMinor: 5000, balanceAfterMinor: 5000, grossMinor: 50000, commissionMinor: 0,
      shortRef: 'ABCD2345', category: 'consultation', ...o,
    });
    expect(referralRowOf(line({}))).toEqual({ _id: 'l1', at: '2026-11-25T06:00:00.000Z', kind: 'earning', ref: 'ABCD2345', category: 'consultation', lines: [],
      baseMinor: 50000, cutMinor: 5000 });
    const lines = [{ category: 'lab_test' as const, baseMinor: 30000, cutMinor: 1500 }, { category: 'lab_package' as const, baseMinor: 80000, cutMinor: 4000 }];
    expect(referralRowOf(line({ source: 'referral_lab_booking', shortRef: 'LMNO2222', category: 'mixed', lines, grossMinor: 120000, amountMinor: 5500 })))
      .toMatchObject({ ref: 'LMNO2222', category: 'mixed', lines, baseMinor: 120000, cutMinor: 5500 });
    // An older server (no fields): no ref, no category; a payout has no base.
    expect(referralRowOf(line({ shortRef: undefined, category: undefined }))).toMatchObject({ ref: null, category: null });
    expect(referralRowOf(line({ kind: 'payout', source: 'payout', shortRef: undefined, category: undefined, amountMinor: -5000, grossMinor: undefined })))
      .toMatchObject({ kind: 'payout', ref: null, category: null, baseMinor: null, cutMinor: -5000 });
  });
});

describe('WQ26 referral cuts: routes', () => {
  it('admin: the list, the version-fenced PUT and the history, ids and kinds checked before any request', async () => {
    const { client, calls } = recorder((url, method) => (method === 'PUT' ? { success: true, data: rule() } : url.endsWith('/events') ? { success: true, data: [{ version: 1 }] }
      : { success: true, data: [rule()], switches: { cutsEnabled: false, payoutsEnabled: false } }));
    const api = referralRulesAdminApi(client);
    // r33: the switches beside the list.
    expect(await api.list('pharmacy', PH)).toEqual({ rules: [rule()], switches: { cutsEnabled: false, payoutsEnabled: false } });
    await api.put('lab', LAB, 'lab_package', { basis: 'fixed', percentBasisPoints: null, fixedMinor: 4000, capMinor: null, isActive: true }, 2, 'Agreed rate');
    expect(await api.events('pharmacy', PH, 'consultation')).toEqual([{ version: 1 }]);
    expect(() => api.list('pharmacy', 'nope')).toThrow('Invalid pharmacy id');
    expect(() => api.list('doctor' as never, PH)).toThrow('Invalid booker');
    expect(() => api.events('lab', LAB, 'procedure' as never)).toThrow('Invalid category');
    expect(calls).toEqual([
      { method: 'GET', url: `/admin/referral-rules?bookerKind=pharmacy&bookerId=${PH}`, body: undefined },
      { method: 'PUT', url: `/admin/referral-rules/lab/${LAB}/lab_package`, body: { basis: 'fixed', fixedMinor: 4000, isActive: true, expectedVersion: 2, reason: 'Agreed rate' } },
      { method: 'GET', url: `/admin/referral-rules/pharmacy/${PH}/consultation/events`, body: undefined },
    ]);
  });

  it('pharmacy and lab: rates with the switches, totals, the statement in cursor pages and its CSV, on each booker’s base', async () => {
    const { client, calls } = recorder((url) => (url.includes('/referral/statement?') || url.endsWith('/referral/statement')
      ? { success: true, data: [{ _id: 'l1' }], pagination: { nextCursor: CURSOR } }
      : url.endsWith('referral-rules') ? { success: true, data: [], ...(url.startsWith('/pharmacy') ? { switches: { cutsEnabled: true, payoutsEnabled: false } } : {}) }
        : { success: true, data: { earnedMinor: 100, paidMinor: 0, dueMinor: 100, cutsEnabled: true, payoutsEnabled: false } }));
    const pharmacy = referralReadsApi(client, { kind: 'pharmacy' });
    expect(await pharmacy.rules()).toEqual({ rules: [], switches: { cutsEnabled: true, payoutsEnabled: false } });
    expect(await pharmacy.summary()).toEqual({ earnedMinor: 100, paidMinor: 0, dueMinor: 100, cutsEnabled: true, payoutsEnabled: false });
    expect((await pharmacy.statement()).nextCursor).toBe(CURSOR);
    await pharmacy.statement(CURSOR, 20, { from: '2026-11-01', to: '2026-11-30' });
    expect(() => pharmacy.statement(undefined, 50, { from: '2026-02-30' })).toThrow('Invalid from date');
    await pharmacy.statementCsv({ from: '2026-11-01', to: '2026-11-30' });
    expect(() => pharmacy.statement('not-a-cursor')).toThrow('Invalid statement cursor');
    expect(() => pharmacy.statement(undefined, 201)).toThrow('Invalid limit');
    expect(() => pharmacy.statementCsv({ from: '2026-12-01', to: '2026-11-01' })).toThrow('The period ends before it starts');
    const lab = referralReadsApi(client, { kind: 'lab', scope: { kind: 'member' } });
    // A server that does not report the switches: null (no note).
    expect(await lab.rules()).toEqual({ rules: [], switches: null });
    await lab.summary();
    await lab.statementCsv();
    await referralReadsApi(client, { kind: 'lab', scope: { kind: 'admin', partnerId: LAB } }).statement();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /pharmacy-assisted/referral-rules',
      'GET /pharmacy-assisted/referral',
      'GET /pharmacy-assisted/referral/statement?limit=50',
      `GET /pharmacy-assisted/referral/statement?from=2026-11-01&to=2026-11-30&before=${CURSOR}&limit=20`,
      'GET /pharmacy-assisted/referral/statement.csv?from=2026-11-01&to=2026-11-30',
      'GET /partner-workspace/assisted/referral-rules',
      'GET /partner-workspace/assisted/referral',
      'GET /partner-workspace/assisted/referral/statement.csv',
      `GET /partner-workspace/admin/${LAB}/workspace/assisted/referral/statement?limit=50`,
    ]);
  });
});
