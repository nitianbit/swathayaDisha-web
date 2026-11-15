import type { CatalogueItem, Invoice } from '@jansetu/api';
import { endOfIstDay, money } from './billing.tsx';
import { itemBody } from './CatalogueScreen.tsx';
import { mergePages, nextCursor } from './InvoicesScreen.tsx';
import { buildInvoice, type InvoiceDraft } from './NewInvoiceScreen.tsx';

const row = (id: string, issuedAt: string) => ({ _id: id, issuedAt }) as Invoice;

describe('bills list paging', () => {
  it('pages back from the start of the next whole second (the server drops milliseconds of `before`)', () => {
    const full = Array.from({ length: 50 }, (_, i) => row(`r${i}`, '2026-11-15T05:00:07.250Z'));
    expect(nextCursor(full)).toBe('2026-11-15T05:00:08.000Z');
    expect(nextCursor(full.slice(0, 49))).toBeUndefined(); // a short page is the last one
  });

  it('drops rows repeated from the shared second and notices when paging cannot move on', () => {
    const a = Array.from({ length: 50 }, (_, i) => row(`a${i}`, '2026-11-15T05:00:07.000Z'));
    const merged = mergePages([a, [...a.slice(48), row('b1', '2026-11-15T04:00:00.000Z')]]);
    expect(merged.rows.map((r) => r._id).slice(-3)).toEqual(['a48', 'a49', 'b1']);
    expect(merged.rows).toHaveLength(51);
    expect(merged.stuck).toBe(false);
    expect(mergePages([a, a]).stuck).toBe(true);
  });

  it('"on or before" a date means before the next midnight in India', () => {
    expect(endOfIstDay('2026-11-11')).toBe('2026-11-11T18:30:00.000Z');
    expect(endOfIstDay('11/11/2026')).toBeNull();
    expect(money(100800)).toBe('₹1,008.00');
    expect(money(5)).toBe('₹0.05');
  });
});

describe('catalogue form', () => {
  const item: CatalogueItem = {
    _id: 'd1'.repeat(12), partnerId: 'a1'.repeat(12), kind: 'test', name: 'CBC', code: 'CBC01', priceMinor: 45000, gstRate: 18,
    visitModes: ['lab'], isActive: true, adminDisabled: false,
  };
  const draft = (o: Record<string, unknown> = {}) => ({
    kind: 'test' as const, name: 'CBC', code: 'CBC01', description: '', preparation: '', sampleType: '', includes: '', price: '450',
    mrp: '', gstRate: '18', sac: '', visitModes: ['lab' as const], tat: '', ...o,
  });

  it('sends only what changed, in paise; a field that is set cannot be emptied', () => {
    expect(itemBody(draft({ price: '450.5' }), [0, 5, 12, 18, 28], 'lab', item)).toEqual({ body: { priceMinor: 45050 }, errors: {} });
    expect(itemBody(draft({ code: '' }), [0, 5, 12, 18, 28], 'lab', item).errors.code).toBe('This cannot be removed here. Enter a new value.');
    expect(itemBody(draft({ mrp: '400' }), [0, 5, 12, 18, 28], 'lab', item).errors.mrp).toBe('MRP cannot be below the price.');
  });

  it('a supplier without GST keeps an old rate as it is but cannot choose a new one', () => {
    expect(itemBody(draft({ name: 'CBC count' }), [0], 'lab', item)).toEqual({ body: { name: 'CBC count' }, errors: {} });
    expect(itemBody(draft({ gstRate: '5' }), [0], 'lab', item).errors.gstRate).toBe('Choose one of the GST rates offered.');
    expect(itemBody(draft({ gstRate: '5' }), [0], 'lab').errors.gstRate).toBe('Choose one of the GST rates offered.');
  });
});

describe('new bill', () => {
  const branch = { address: { line1: '1 Main Rd', city: 'Bengaluru', state: 'Karnataka', stateCode: '29', pincode: '560038' } };
  const base: InvoiceDraft = {
    branchId: 'c1'.repeat(12), name: ' Asha ', phone: '98765 00000', age: '', gender: '', gstin: '29abcde1234f1z5', placeOfSupply: '',
    doctorId: '', lines: [{ key: 'l1', description: 'Visit', sac: '', qty: '3', price: '99.99', discount: '0.97', gstRate: '18' }],
  };

  it('builds the request in paise with the customer as the server validates it', () => {
    const r = buildInvoice(base, { taxRegime: 'regular', gstin: '29ABCDE1234F1Z5' }, branch);
    expect(r.errors).toEqual({});
    expect(r.body).toEqual({
      branchId: 'c1'.repeat(12),
      customer: { name: 'Asha', phone: '9876500000', gstin: '29ABCDE1234F1Z5' },
      items: [{ description: 'Visit', qty: 3, unitPriceMinor: 9999, discountMinor: 97, gstRate: 18 }],
    });
    expect(r.preview.totals.totalMinor).toBe(29900 + 5382);
  });

  it('refuses what the server would refuse before anything is sent', () => {
    const r = buildInvoice({ ...base, phone: '12345', age: '200', placeOfSupply: '2', lines: [{ ...base.lines[0]!, qty: '0', discount: '500' }] },
      { taxRegime: 'unregistered' }, branch);
    expect(r.errors).toMatchObject({
      phone: 'Enter a 10-digit mobile number.', age: 'Enter the age in whole years (0 to 150).',
      placeOfSupply: 'Enter the two-digit GST state code, like 29.', 'l1.qty': 'Enter a whole number from 1 to 10000.',
      'l1.gstRate': 'Choose one of the GST rates offered.',
    });
    expect(buildInvoice({ ...base, lines: [] }, { taxRegime: 'regular', gstin: '29ABCDE1234F1Z5' }, branch).errors.lines).toBe('Add at least one item.');
    expect(buildInvoice(base, { taxRegime: 'regular', gstin: '29ABCDE1234F1Z5' }, { address: { ...branch.address, stateCode: '' } }).errors.branchId)
      .toBe('Set the branch GST state code before billing (Branches).');
  });
});
