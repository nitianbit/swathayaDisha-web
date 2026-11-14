import { newRequestKey, parseRupees } from './CustomerReturnForm.tsx';

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
