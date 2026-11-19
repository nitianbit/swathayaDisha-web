import { cooldownLeft } from './index.tsx';

describe('WQ9 cooldownLeft', () => {
  it('counts whole seconds up, and nothing once passed or unset', () => {
    expect(cooldownLeft(undefined, 1000)).toBe(0);
    expect(cooldownLeft(31_000, 1_000)).toBe(30);
    expect(cooldownLeft(31_000, 1_001)).toBe(30);
    expect(cooldownLeft(31_000, 30_500)).toBe(1);
    expect(cooldownLeft(31_000, 31_000)).toBe(0);
    expect(cooldownLeft(31_000, 40_000)).toBe(0);
  });
});
