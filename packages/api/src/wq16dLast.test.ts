import { describe, expect, it } from 'vitest';
import * as api from './index.ts';
import { createApiClient } from './client.ts';

// wq16d/card-last: the last card-payment fixes before production (items 1, 3 and 4).

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const REC = 'c1'.repeat(12);
const RF = 'f1'.repeat(12);
const fn = <T>(name: string) => (api as Record<string, unknown>)[name] as T;
function client(answer: () => Response) {
  const calls: string[] = [];
  const c = createApiClient({ baseUrl: '', getToken: () => 'tok', timeoutMs: 100, fetchImpl: async (u) => { calls.push(String(u)); return answer().clone(); } });
  return { c, calls };
}

describe('item 1: the server is asked before Checkout is opened again', () => {
  type Pre = { kind: 'open'; created: boolean } | { kind: 'settled'; outcome: api.CardOutcome };
  it('authorized: not opened (on its way); created: opened with the warning kept; nothing: opened; paid: settled', async () => {
    const pre = fn<(c: api.ApiClient, id: string) => Promise<Pre>>('beforeCheckout');
    let answer = json(200, { success: true, data: { state: 'unpaid', gatewayStatuses: ['failed', 'authorized'] } });
    const { c, calls } = client(() => answer);
    await expect(pre(c, REC)).resolves.toEqual({ kind: 'settled', outcome: { kind: 'unpaid', inFlight: true } });
    expect(calls).toEqual(['/api/v1/payments/reconcile']);
    answer = json(200, { success: true, data: { state: 'unpaid', gatewayStatuses: ['created'] } });
    await expect(pre(c, REC)).resolves.toEqual({ kind: 'open', created: true });
    answer = json(200, { success: true, data: { state: 'unpaid', gatewayStatuses: ['failed'] } });
    await expect(pre(c, REC)).resolves.toEqual({ kind: 'open', created: false });
    answer = json(200, { success: true, data: { state: 'paid', paymentRecord: { status: 'paid' }, entity: { _id: 'x' } } });
    await expect(pre(c, REC)).resolves.toMatchObject({ kind: 'settled', outcome: { kind: 'paid' } });
    answer = json(502, { error: 502, message: 'down' });
    await expect(pre(c, REC)).resolves.toMatchObject({ kind: 'settled', outcome: { kind: 'unknown' } });
  });
});

describe('item 3: Checkout stays open at least about a minute', () => {
  it('never a near-zero timeout', () => {
    expect(api.checkoutSeconds('2026-11-23T10:00:00.000Z', Date.parse('2026-11-23T09:59:00.000Z'))).toBe(60);
    expect(api.checkoutSeconds('2026-11-23T10:00:00.000Z', Date.parse('2026-11-23T09:50:00.000Z'))).toBe(480);
  });
});

describe('item 4: marked failed by an admin, whatever the row’s state now', () => {
  it('a row marked failed and since moved to the wallet still counts', async () => {
    const { c } = client(() => json(200, { success: true, data: { refundId: RF, method: 'wallet', state: 'processed', lastError: 'MARKED_FAILED_BY_ADMIN', amountMinor: 1 } }));
    await expect(api.findMarkedFailed(c, RF)).resolves.toMatchObject({ refundId: RF });
  });
});
