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
});
