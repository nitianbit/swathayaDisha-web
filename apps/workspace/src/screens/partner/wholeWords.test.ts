import { describe, expect, it } from 'vitest';
import { wholeWords } from './NewInvoiceScreen.tsx';

// WQ57c: a clinic's consultation item names its doctor as whole words ("Dr Rao" is not "Dr Raoul").
describe('wholeWords', () => {
  it('matches the name as whole words only, in any case and spacing', () => {
    expect(wholeWords('Dr Rao').test('Consultation · Dr Rao')).toBe(true);
    expect(wholeWords('Dr Rao').test('dr  rao follow-up')).toBe(true);
    expect(wholeWords('Dr Rao').test('Consultation · Dr Raoul')).toBe(false);
    expect(wholeWords('Dr Rao').test('Consultation')).toBe(false);
    expect(wholeWords('Dr K. (ENT)').test('Visit Dr K. (ENT)')).toBe(true);
  });
});
