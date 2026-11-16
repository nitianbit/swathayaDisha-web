import { createApiClient } from './client.ts';
import {
  isAdjustmentFor, isPayoutFor, isStatementCsv, istToday, partnerFinanceApi, payoutDetailsProblems, payoutProblems, reasonProblem,
  settlementsApi, statementCsvName, type SettlementPayout,
} from './finance.ts';

const P = 'a1'.repeat(12);
const A = 'c3'.repeat(12);
const PO = 'd4'.repeat(12);
const KEY = 'k'.repeat(32);

function recorder(answer: () => Response = () => new Response(JSON.stringify({ success: true, data: [] }), { status: 200 })) {
  const calls: { method: string; url: string; body: unknown; headers: Record<string, string> }[] = [];
  const client = createApiClient({ baseUrl: 'https://api.example.test', getToken: () => 'tok',
    fetchImpl: async (u, init) => {
      calls.push({ method: String(init?.method), url: String(u).replace('https://api.example.test/api/v1', ''),
        body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: (init?.headers ?? {}) as Record<string, string> });
      return answer();
    } });
  return { client, calls };
}

describe('finance paths', () => {
  it('builds member and admin-as-owner workspace paths, with statement filters and cursor', async () => {
    const { client, calls } = recorder();
    const member = partnerFinanceApi(client, { kind: 'member' });
    const admin = partnerFinanceApi(client, { kind: 'admin', partnerId: P });
    await member.summary();
    await member.statement({ from: '2026-11-01', to: '2026-11-15', limit: 50, before: `1763000000000_${A}` });
    await admin.payouts();
    await admin.events();
    await admin.setPayoutDetails({ method: 'upi', upiId: 'lab@okbank' });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /partner-workspace/finance',
      `GET /partner-workspace/finance/statement?from=2026-11-01&to=2026-11-15&before=1763000000000_${A}&limit=50`,
      `GET /partner-workspace/admin/${P}/workspace/finance/payouts`,
      `GET /partner-workspace/admin/${P}/workspace/finance/events`,
      `PUT /partner-workspace/admin/${P}/workspace/finance/payout-details`,
    ]);
    expect(calls[4]!.body).toEqual({ method: 'upi', upiId: 'lab@okbank' });
  });

  it('builds the admin settlements paths and queries', async () => {
    const { client, calls } = recorder();
    const s = settlementsApi(client);
    await s.accounts({ ownerKind: 'doctor', due: true, search: '  Rao ', detailsState: 'unverified', limit: 50, skip: 50 });
    await s.accounts({ due: false, skip: 0 });
    await s.account(A);
    await s.statement(A, { limit: 50 });
    await s.payouts(A);
    await s.history(A);
    await s.events(A);
    await s.verifyPayoutDetails(A, 3);
    await s.payoutQueue({ accountId: A, state: 'recorded', from: '2026-11-01', limit: 100 });
    await s.voidPayout(PO, 'Transfer bounced');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /settlements/accounts?ownerKind=doctor&due=true&search=Rao&detailsState=unverified&limit=50&skip=50',
      'GET /settlements/accounts',
      `GET /settlements/accounts/${A}`,
      `GET /settlements/accounts/${A}/statement?limit=50`,
      `GET /settlements/accounts/${A}/payouts`,
      `GET /settlements/accounts/${A}/history`,
      `GET /settlements/accounts/${A}/events`,
      `POST /settlements/accounts/${A}/payout-details/verify`,
      `GET /settlements/payouts?accountId=${A}&from=2026-11-01&state=recorded&limit=100`,
      `POST /settlements/payouts/${PO}/void`,
    ]);
    expect(calls[7]!.body).toEqual({ version: 3 });
    expect(calls[9]!.body).toEqual({ reason: 'Transfer bounced' });
  });

  it('sends the request key in the body (no header) and the same body again on a resend', async () => {
    const { client, calls } = recorder(() => new Response(JSON.stringify({ success: true, data: { payout: {}, replayed: true } }), { status: 200 }));
    const s = settlementsApi(client);
    const body = { amountMinor: 150000, method: 'bank_transfer' as const, reference: 'UTR12345', paidOn: '2026-11-15', detailsVersion: 2, requestKey: KEY };
    await s.recordPayout(A, body);
    await s.recordPayout(A, body);
    await s.postAdjustment(A, { amountMinor: -5000, reason: 'Recovery of a duplicate earning', requestKey: KEY });
    expect(calls[0]!.url).toBe(`/settlements/accounts/${A}/payouts`);
    expect(calls[0]!.body).toEqual(body);
    expect(calls[1]!.body).toEqual(calls[0]!.body);
    expect(calls[0]!.headers['Idempotency-Key']).toBeUndefined();
    expect(calls[2]!.url).toBe(`/settlements/accounts/${A}/adjustments`);
    expect(calls[2]!.body).toEqual({ amountMinor: -5000, reason: 'Recovery of a duplicate earning', requestKey: KEY });
  });

  it('reads the CSV as a blob with the token in the header, never in the URL', async () => {
    const csv = '"Date (IST)","Type","Description","Reference","Note","Amount (INR)","Balance (INR)"\n';
    const { client, calls } = recorder(() => new Response(csv, { status: 200, headers: { 'Content-Type': 'text/csv; charset=utf-8' } }));
    const blob = await partnerFinanceApi(client, { kind: 'member' }).statementCsv({ from: '2026-11-01', to: '2026-11-30' });
    expect(await isStatementCsv(blob)).toBe(true);
    expect(calls[0]!.url).toBe('/partner-workspace/finance/statement.csv?from=2026-11-01&to=2026-11-30');
    expect(calls[0]!.headers.Authorization).toBe('Bearer tok');
    await settlementsApi(client).statementCsv(A);
    expect(calls[1]!.url).toBe(`/settlements/accounts/${A}/statement.csv`);
    expect(await isStatementCsv(new Blob(['<html>error</html>']))).toBe(false);
    expect(statementCsvName('partner', { from: '2026-11-01', to: '2026-11-30' })).toBe('partner-statement-2026-11-01-to-2026-11-30.csv');
    expect(statementCsvName(`account-${A}`)).toBe(`account-${A}-statement.csv`);
  });

  it('refuses bad ids, dates, cursors, limits and keys before any request', () => {
    const { client, calls } = recorder();
    const s = settlementsApi(client);
    const member = partnerFinanceApi(client, { kind: 'member' });
    expect(() => s.account('../accounts')).toThrow('Invalid account id');
    expect(() => s.voidPayout(`${PO}/x`, 'oops')).toThrow('Invalid payout id');
    expect(() => s.payoutQueue({ accountId: 'x' })).toThrow('Invalid account id');
    expect(() => member.statement({ from: '2026-02-30' })).toThrow('Invalid from date');
    expect(() => member.statement({ from: '2026-11-15', to: '2026-11-01' })).toThrow('The period ends before it starts');
    expect(() => member.statement({ before: '123' })).toThrow('Invalid statement cursor');
    expect(() => member.statement({ limit: 201 })).toThrow('Invalid limit');
    expect(() => member.statementCsv({ to: '15-11-2026' })).toThrow('Invalid to date');
    expect(() => s.accounts({ limit: 0 })).toThrow('Invalid limit');
    expect(() => s.accounts({ skip: -1 })).toThrow('Invalid skip');
    expect(() => s.accounts({ search: 'x'.repeat(101) })).toThrow('Search is too long');
    expect(() => s.payoutQueue({ limit: 501 })).toThrow('Invalid limit');
    expect(() => s.verifyPayoutDetails(A, 0)).toThrow('Invalid details version');
    expect(() => s.recordPayout(A, { amountMinor: 1, method: 'upi', reference: 'UTR1', paidOn: '2026-11-15', detailsVersion: 1, requestKey: 'short' }))
      .toThrow('Invalid request key');
    expect(() => s.postAdjustment(A, { amountMinor: 1, reason: 'abc', requestKey: 'bad key!' })).toThrow('Invalid request key');
    expect(() => partnerFinanceApi(client, { kind: 'admin', partnerId: 'x' }).summary()).toThrow('Invalid partner id');
    expect(calls).toHaveLength(0);
  });
});

describe('finance rules mirrored from services/finance.ts', () => {
  it('normalizes and checks a bank or UPI destination as normalizeDetails does', () => {
    expect(payoutDetailsProblems({ method: 'bank', accountName: ' City Lab ', accountNumber: '1234 5678 9012', ifsc: ' hdfc0001234 ', bankName: ' HDFC ' }))
      .toEqual({ errors: {}, body: { method: 'bank', accountName: 'City Lab', accountNumber: '123456789012', ifsc: 'HDFC0001234', bankName: 'HDFC' } });
    const bad = payoutDetailsProblems({ method: 'bank', accountName: '', accountNumber: '12345678', ifsc: 'HDFC1001234' });
    expect(bad.body).toBeNull();
    expect(Object.keys(bad.errors).sort()).toEqual(['accountName', 'accountNumber', 'ifsc']);
    expect(payoutDetailsProblems({ method: 'upi', upiId: ' City.Lab@OKBank ' })).toEqual({ errors: {}, body: { method: 'upi', upiId: 'city.lab@okbank' } });
    expect(payoutDetailsProblems({ method: 'upi', upiId: 'lab@1bank' }).errors.upiId).toBeTruthy();
    expect(payoutDetailsProblems({ method: 'upi', upiId: 'a@bank' }).errors.upiId).toBeTruthy(); // the name part needs 2 characters
  });

  it('checks a payout: positive paise, not above the balance, a 4–64 character reference, a real date not in the future', () => {
    const ok = { amountMinor: 150000, reference: 'UTR1234', paidOn: '2026-11-15', note: '' };
    expect(payoutProblems(ok, 150000, '2026-11-16')).toEqual({});
    expect(payoutProblems({ ...ok, amountMinor: 150001 }, 150000, '2026-11-16').amount).toMatch(/more than the balance/);
    expect(payoutProblems({ ...ok, amountMinor: 0 }, 150000, '2026-11-16').amount).toBeTruthy();
    expect(payoutProblems({ ...ok, amountMinor: null }, 150000, '2026-11-16').amount).toBeTruthy();
    expect(payoutProblems({ ...ok, reference: ' UT ' }, 150000, '2026-11-16').reference).toBeTruthy();
    expect(payoutProblems({ ...ok, paidOn: '2026-11-17' }, 150000, '2026-11-16').paidOn).toMatch(/future/);
    expect(payoutProblems({ ...ok, paidOn: '2026-02-29' }, 150000, '2026-11-16').paidOn).toBeTruthy();
    expect(reasonProblem(' ab ')).toBeTruthy();
    expect(reasonProblem('Duplicate')).toBeNull();
    expect(reasonProblem('x'.repeat(501))).toBeTruthy();
  });

  it('uses the India date for "today"', () => {
    expect(istToday(new Date('2026-11-15T18:29:00.000Z'))).toBe('2026-11-15');
    expect(istToday(new Date('2026-11-15T18:31:00.000Z'))).toBe('2026-11-16');
  });

  it('recognises a lost adjustment by its key and a lost payout by account, reference, amount and date', () => {
    expect(isAdjustmentFor({ source: 'admin_adjustment', sourceId: `ad:${KEY}` }, KEY)).toBe(true);
    expect(isAdjustmentFor({ source: 'payout_void', sourceId: `ad:${KEY}` }, KEY)).toBe(false);
    expect(isAdjustmentFor({ source: 'admin_adjustment', sourceId: `ad:x${KEY}` }, KEY)).toBe(false);
    const p: SettlementPayout = { _id: PO, settlementAccountId: A, amountMinor: 150000, method: 'bank_transfer', reference: 'UTR1234', paidOn: '2026-11-15',
      destination: { method: 'bank', label: 'HDFC0001234 XXXX9012', detailsVersion: 2 }, state: 'recorded', by: 'ad' };
    const body = { amountMinor: 150000, method: 'bank_transfer' as const, reference: ' UTR1234 ', paidOn: '2026-11-15', detailsVersion: 2 };
    expect(isPayoutFor(p, A.toUpperCase(), body)).toBe(true);
    expect(isPayoutFor({ ...p, state: 'voided' }, A, body)).toBe(false);
    expect(isPayoutFor(p, A, { ...body, amountMinor: 1 })).toBe(false);
  });
});
