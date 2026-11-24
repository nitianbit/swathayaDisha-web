import { topupProblem } from './topup.tsx';

describe('topupProblem', () => {
  it('takes rupees with up to two decimals, from ₹1 to ₹2,00,000', () => {
    expect(topupProblem('500')).toBeNull();
    expect(topupProblem(' 99.50 ')).toBeNull();
    expect(topupProblem('')).toContain('rupees');
    expect(topupProblem('12.345')).toContain('rupees');
    expect(topupProblem('-5')).toContain('rupees');
    expect(topupProblem('0')).toContain('smallest');
    expect(topupProblem('200001')).toContain('largest');
  });

  it('WQ20: a lab wallet tops up at most ₹50,000 at a time (the most it holds)', () => {
    expect(topupProblem('50000', 50_000)).toBeNull();
    expect(topupProblem('50001', 50_000)).toBe('The largest top-up at one time is ₹50,000.00.');
  });
});
