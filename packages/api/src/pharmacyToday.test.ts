import { describe, expect, it } from 'vitest';
import { createApiClient } from './client.ts';
import { moneyParts, pharmacyTodayApi, todayOf, todoText } from './pharmacyToday.ts';

// WQ54 (P1): the day's register and the pharmacy's to-dos (backend r37, draft shapes).

const TODO = 'a7'.repeat(12);
const KEY = 'k'.repeat(32);
type Call = { url: string; method: string; body: unknown };
function client() {
  const calls: Call[] = [];
  const c = createApiClient({ baseUrl: '', getToken: () => 'tok', timeoutMs: 100, fetchImpl: async (u, init) => {
    calls.push({ url: String(u), method: String(init?.method), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ success: true, data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } });
  return { c, calls };
}

describe('WQ54 pharmacy today and to-dos', () => {
  it('the routes and bodies; bad dates, ids, keys and texts are refused before any request', async () => {
    const { c, calls } = client();
    const a = pharmacyTodayApi(c);
    await a.today();
    await a.today('2026-11-26');
    await a.todos();
    await a.addTodo('  Call   supplier ', KEY);
    await a.setDone(TODO, true, 3);
    await a.remove(TODO, 4);
    expect(calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      'GET /api/v1/pharmacy-assisted/today',
      'GET /api/v1/pharmacy-assisted/today?date=2026-11-26',
      'GET /api/v1/pharmacy-assisted/todos',
      'POST /api/v1/pharmacy-assisted/todos',
      `PATCH /api/v1/pharmacy-assisted/todos/${TODO}`,
      `DELETE /api/v1/pharmacy-assisted/todos/${TODO}?expectedVersion=4`,
    ]);
    expect(calls[3]!.body).toEqual({ text: 'Call supplier', requestKey: KEY });
    expect(calls[4]!.body).toEqual({ done: true, expectedVersion: 3 });
    expect(() => a.today('2026-02-31')).toThrow();
    expect(() => a.setDone('nope', true, 1)).toThrow();
    expect(() => a.addTodo('x', 'bad key')).toThrow();
    expect(() => a.addTodo('   ', KEY)).toThrow();
    expect(calls).toHaveLength(6);
    expect(todoText('x'.repeat(201))).toBeNull();
  });

  it('the money line: cash, UPI and wallet always; other methods only with money', () => {
    expect(moneyParts({ collectedMinor: 82000, byMethod: { cash: 32000, wallet: 50000, card: 0 }, unpaidMinor: 0, count: 2 }))
      .toEqual([{ key: 'cash', minor: 32000 }, { key: 'upi', minor: 0 }, { key: 'wallet', minor: 50000 }]);
    expect(moneyParts({ collectedMinor: 100, byMethod: { card: 100 }, unpaidMinor: 0, count: 1 }).map((p) => p.key)).toEqual(['cash', 'upi', 'card', 'wallet']);
  });

  it('an answer of another shape (an older server, a broken one) is empty, never a crash', () => {
    expect(todayOf([])).toEqual({ items: [], totals: { collectedMinor: 0, byMethod: {}, unpaidMinor: 0, count: 0 }, pending: {} });
    expect(todayOf({ items: [null, { id: 'x' }], totals: { collectedMinor: 'a' } }).items).toEqual([{ id: 'x' }]);
  });
});
