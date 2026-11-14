import { ApiError } from '@jansetu/api';
import { definitelyNotRecorded, newRequestKey, parseRupees } from './CustomerReturnForm.tsx';

describe('customer return helpers', () => {
  it('accepts rupees with at most two decimals, as the backend does', () => {
    expect(parseRupees('120')).toBe(120);
    expect(parseRupees(' 120.5 ')).toBe(120.5);
    expect(parseRupees('0.05')).toBe(0.05);
    for (const bad of ['', '-1', '1.234', '1e3', 'abc', '12,000']) expect(parseRupees(bad)).toBeNull();
  });
  it('makes request keys the backend accepts, different each time', () => {
    const a = newRequestKey();
    expect(a).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(newRequestKey()).not.toBe(a);
  });
});

describe('definitelyNotRecorded', () => {
  it('treats only a refusal of the request itself as "nothing recorded"', () => {
    for (const s of [400, 403, 404, 409, 422]) expect(definitelyNotRecorded(new ApiError(s, 'refused'))).toBe(true);
    // No answer, timeout, rate limit, server error: the return may have been recorded.
    for (const s of [0, 408, 429, 500, 502, 503]) expect(definitelyNotRecorded(new ApiError(s, 'unknown'))).toBe(false);
    expect(definitelyNotRecorded(new DOMException('aborted', 'AbortError'))).toBe(false);
    expect(definitelyNotRecorded(new Error('x'))).toBe(false);
  });
});
