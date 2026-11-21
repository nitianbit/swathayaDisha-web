import { ApiError, type Page } from '@jansetu/api';
import { afterFailure, beginAttempt, findByKey, keyedLookup, resolveStored, startOp, stillCurrent } from './requests.ts';

const T0 = Date.UTC(2026, 10, 14, 10, 0);
const refused = new ApiError(403, 'Pharmacy is not verified');

describe('pending operations', () => {
  it('forgets a submission only when its sole first attempt is definitely refused', () => {
    const first = beginAttempt(startOp('k1', { a: 1 }, T0), T0);
    expect(first).toMatchObject({ attempts: 1, uncertain: false });
    expect(afterFailure(first, new ApiError(409, 'refused'), 'refused')).toBeNull();
    expect(afterFailure(first, new ApiError(0, 'no answer'), 'no answer')).toMatchObject({ uncertain: true, error: 'no answer', body: { a: 1 } });
    expect(afterFailure(first, new ApiError(503, 'down'), 'down')).toMatchObject({ uncertain: true });
  });

  it('never treats a resend as a first attempt, even if the first one is still running', () => {
    // Attempt 1 is stored before sending; the page is left and reopened while it runs, then the user resends.
    const first = beginAttempt(startOp('k1', {}, T0), T0);
    const resend = beginAttempt(first, T0 + 1000);
    expect(resend).toMatchObject({ attempts: 2, uncertain: true });
    expect(afterFailure(resend, refused, 'x')).toMatchObject({ uncertain: true, attempts: 2 });
  });

  it('a refused retry after an unknown outcome proves nothing', () => {
    const lost = afterFailure(beginAttempt(startOp('k1', {}, T0)), new ApiError(0, 'no answer'), 'no answer')!;
    expect(afterFailure(beginAttempt(lost), refused, 'x')).toMatchObject({ uncertain: true });
  });

  it('lets only the newest attempt change the stored state', () => {
    const first = beginAttempt(startOp('k1', {}, T0));
    const second = beginAttempt(first);
    expect(stillCurrent(second, first)).toBe(false); // the late answer of attempt 1 must not clear attempt 2
    expect(stillCurrent(second, second)).toBe(true);
    expect(stillCurrent(undefined, second)).toBe(false);
  });
});

describe('findByKey', () => {
  const rec = (requestKey: string, minutesAfter: number) => ({ requestKey, createdAt: new Date(T0 + minutesAfter * 60_000).toISOString() });
  const pages = (all: ReturnType<typeof rec>[], size = 2) => async (page: number): Promise<Page<ReturnType<typeof rec>>> => ({
    items: all.slice((page - 1) * size, page * size), page, limit: size, total: all.length, totalPages: Math.ceil(all.length / size) || 1,
  });
  const op = startOp('mine', {}, T0);

  it('finds the record on a later page', async () => {
    await expect(findByKey(pages([rec('x', 9), rec('y', 8), rec('mine', 1), rec('z', -1)]), op)).resolves.toEqual(rec('mine', 1));
  });
  it('answers only "not found" otherwise, and bounds the search', async () => {
    const fetch = vi.fn(pages([rec('a', 3), rec('b', -120), rec('c', -130), rec('d', -140)]));
    await expect(findByKey(fetch, op)).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    const many = Array.from({ length: 10 }, (_, i) => rec(`r${i}`, 20 - i));
    const capped = vi.fn(pages(many));
    await expect(findByKey(capped, op, 2)).resolves.toBeNull();
    expect(capped).toHaveBeenCalledTimes(2);
  });
});

describe('resolveStored', () => {
  it('ends only the operation that was recorded', () => {
    const store = new Map<string, unknown>();
    const memory = { get: <T,>(k: string) => store.get(k) as T | undefined, delete: (k: string) => { store.delete(k); } };
    store.set('slot', beginAttempt(startOp('K2', {})));
    resolveStored(memory, 'slot', 'K1'); // a late answer for an older return
    expect(store.has('slot')).toBe(true);
    resolveStored(memory, 'slot', 'K2');
    expect(store.has('slot')).toBe(false);
    resolveStored(memory, 'slot', 'K3'); // nothing stored: fine
  });
});

describe('WQ11c: keyedLookup with the route’s own not-found codes', () => {
  it('only the named codes mean "not recorded"; another 404 stays unknown; without codes any 404 does', async () => {
    const missing = (code?: string) => async () => { throw new ApiError(404, 'x', code); };
    await expect(keyedLookup('k'.repeat(32), missing('PAYOUT_NOT_FOUND'), ['PAYOUT_NOT_FOUND'])(1)).resolves.toMatchObject({ items: [] });
    await expect(keyedLookup('k'.repeat(32), missing('ACCOUNT_NOT_FOUND'), ['PAYOUT_NOT_FOUND'])(1)).rejects.toBeInstanceOf(ApiError);
    await expect(keyedLookup('k'.repeat(32), missing(), ['CLINIC_NOT_FOUND'])(1)).rejects.toBeInstanceOf(ApiError);
    await expect(keyedLookup('k'.repeat(32), missing('ANY'))(1)).resolves.toMatchObject({ items: [] });
    await expect(keyedLookup('k'.repeat(32), async () => ({ _id: 'a' }), ['X'])(1)).resolves.toMatchObject({ items: [{ _id: 'a', requestKey: 'k'.repeat(32) }] });
  });
});
