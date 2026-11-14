import { ApiError, type Page } from '@jansetu/api';
import { afterFailure, findByKey, SETTLE_MS, startOp } from './requests.ts';

const T0 = Date.UTC(2026, 10, 14, 10, 0);

describe('pending operations', () => {
  it('forgets a submission only when its FIRST attempt is definitely refused', () => {
    const op = startOp('k1', { a: 1 }, T0);
    expect(afterFailure(op, new ApiError(409, 'refused'), 'refused', T0)).toBeNull();
    const lost = afterFailure(op, new ApiError(0, 'no answer'), 'no answer', T0 + 1);
    expect(lost).toMatchObject({ uncertain: true, lastAttemptAt: T0 + 1, error: 'no answer', body: { a: 1 }, requestKey: 'k1' });
    // After an unknown outcome, a refused retry proves nothing about the first attempt (e.g. a 403 access check).
    expect(afterFailure(lost!, new ApiError(403, 'Pharmacy is not verified'), 'x', T0 + 2)).toMatchObject({ uncertain: true, lastAttemptAt: T0 + 2 });
    expect(afterFailure(op, new ApiError(503, 'down'), 'down', T0)).toMatchObject({ uncertain: true });
  });
});

describe('findByKey', () => {
  const rec = (requestKey: string, minutesAfter: number) => ({ requestKey, createdAt: new Date(T0 + minutesAfter * 60_000).toISOString() });
  const pages = (all: ReturnType<typeof rec>[], size = 2) => async (page: number): Promise<Page<ReturnType<typeof rec>>> => ({
    items: all.slice((page - 1) * size, page * size), page, limit: size, total: all.length, totalPages: Math.ceil(all.length / size) || 1,
  });
  const op = { ...startOp('mine', {}, T0), uncertain: true, lastAttemptAt: T0 + 30_000 };

  it('finds the record on a later page', async () => {
    const all = [rec('x', 9), rec('y', 8), rec('mine', 1), rec('z', -1)];
    await expect(findByKey(pages(all), op, T0 + 60_000)).resolves.toEqual({ found: rec('mine', 1) });
  });
  it('says "settled" only when the last attempt is long enough ago', async () => {
    const all = [rec('x', 9), rec('y', 8)];
    await expect(findByKey(pages(all), op, T0 + 60_000)).resolves.toEqual({ found: null, settled: false });
    await expect(findByKey(pages(all), op, op.lastAttemptAt + SETTLE_MS)).resolves.toEqual({ found: null, settled: true });
  });
  it('stops at records older than the submission', async () => {
    const fetch = vi.fn(pages([rec('a', 3), rec('b', -10), rec('c', -20), rec('d', -30)]));
    await expect(findByKey(fetch, op, op.lastAttemptAt + SETTLE_MS)).resolves.toEqual({ found: null, settled: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('reports an incomplete search instead of a false "not recorded"', async () => {
    const many = Array.from({ length: 10 }, (_, i) => rec(`r${i}`, 20 - i));
    await expect(findByKey(pages(many), op, op.lastAttemptAt + SETTLE_MS, 2)).resolves.toEqual({ found: null, incomplete: true });
  });
});
