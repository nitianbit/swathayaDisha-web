import { deskBookingSlot } from './desk.ts';

describe('desk booking recovery helpers', () => {
  it('keeps the unconfirmed booking per workspace', () => {
    expect(deskBookingSlot('partner-ws:member:x')).toBe('clinic-desk:book:partner-ws:member:x');
  });
});
