import { formatExpiry, sellableQty } from './inventory.ts';

describe('inventory rules', () => {
  it('counts only active, unexpired batch units as sellable, like the backend', () => {
    const batches = [
      { _id: '1', batchNumber: 'A', expiryDate: '20271231', availableQty: 5, reservedQty: 2, status: 'active' as const },
      { _id: '2', batchNumber: 'B', expiryDate: '20261113', availableQty: 7, reservedQty: 0, status: 'active' as const }, // expired yesterday
      { _id: '3', batchNumber: 'C', expiryDate: '20271231', availableQty: 9, reservedQty: 0, status: 'quarantined' as const },
      { _id: '4', batchNumber: 'D', expiryDate: '20261114', availableQty: 1, reservedQty: 0, status: 'active' as const }, // expires today: still sellable
    ];
    expect(sellableQty({ availableQty: 99, batches }, '20261114')).toBe(6);
    expect(sellableQty({ availableQty: 4, batches: [] }, '20261114')).toBe(4); // legacy item without batches
  });
  it('formats YYYYMMDD expiry dates', () => {
    expect(formatExpiry('20270630')).toBe('30 Jun 2027');
    expect(formatExpiry('bad')).toBe('bad');
    expect(formatExpiry(undefined)).toBe('—');
  });
});
